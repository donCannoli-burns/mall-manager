/*
 * store-reprice.js
 *
 * Reprice every item currently in your KoL mall store using KoLmafia's current
 * mall-price snapshot. KoLmafia deliberately defines mall_price as the price of
 * the 5th cheapest purchasable copy, which avoids chasing a single accidental
 * bargain listing.
 *
 * Pricing flow:
 *   1. Refresh the player's store inventory.
 *   2. Bulk-refresh KoL mall prices once with mallPrices("allitems").
 *   3. Read historicalPrice()/historicalAge() for ONLY stocked store items.
 *   4. Reprice to the fresh 5th-cheapest market price.
 *
 * The bulk market refresh is hard-throttled to no more than once per 60 seconds
 * across characters using the shared KoLmafia data directory.
 */

var k = require("kolmafia");

var MALL_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
var RERUN_GUARD_MS = 24 * 60 * 60 * 1000;
var MAX_MARKET_AGE_DAYS = 5 / 1440; // accept only <= 5-minute-old persisted market data
var MALL_PRICE_CEILING = 999999999;

var PREF_LAST_RUN = "storeRepriceLastRunMs";
var PREF_LAST_MALL_REFRESH = "storeRepriceLastMallRefreshMs";
var PREF_LAST_RESULT = "storeRepriceLastResult";
var PREF_LAST_CHANGED = "storeRepriceLastChangedCount";

var CHANGE_LOG = "store-reprice-changes.tsv";
var MALL_THROTTLE_FILE = "store-reprice-mall-throttle.txt";
var MAX_LOG_LINES = 2000;

function toNumber(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function prefNumber(name) {
  return toNumber(k.getProperty(name), 0);
}

function formatDuration(ms) {
  if (ms < 0) return "unknown";
  var seconds = Math.floor(ms / 1000);
  var days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  var hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  var minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  var parts = [];
  if (days) parts.push(days + "d");
  if (hours || days) parts.push(hours + "h");
  if (minutes || hours || days) parts.push(minutes + "m");
  if (!parts.length) parts.push(seconds + "s");
  return parts.join(" ");
}

function getRunState() {
  var now = k.nowToInt();
  var lastRun = prefNumber(PREF_LAST_RUN);
  var lastMallRefresh = Math.max(
    prefNumber(PREF_LAST_MALL_REFRESH),
    globalMallTimestamp()
  );
  var age = lastRun > 0 ? now - lastRun : -1;

  return {
    nowMs: now,
    lastRunMs: lastRun,
    lastMallRefreshMs: lastMallRefresh,
    ageMs: age,
    recent: lastRun > 0 && age >= 0 && age < RERUN_GUARD_MS
  };
}

function legalMallFloor(it) {
  return Math.max(100, 2 * k.autosellPrice(it));
}

function clampTargetPrice(it, value) {
  var rounded = Math.round(value);
  if (!isFinite(rounded) || rounded <= 0) return 0;
  return Math.min(MALL_PRICE_CEILING, Math.max(legalMallFloor(it), rounded));
}

function listStoreItems() {
  k.refreshShop();

  var all = Item.all();
  var result = [];
  var i;

  for (i = 0; i < all.length; i++) {
    var it = all[i];
    var qty = k.shopAmount(it);

    if (qty > 0) {
      result.push({
        item: it,
        id: k.toInt(it),
        name: String(it),
        qty: qty,
        oldPrice: k.shopPrice(it)
      });
    }
  }

  return result;
}

function globalMallTimestamp() {
  var raw = String(k.fileToBuffer(MALL_THROTTLE_FILE) || "").trim();
  return toNumber(raw, 0);
}

/*
 * Refresh KoL's mall-price snapshot once. This follows the same basic strategy
 * used by CONSUME.ash via loathers/mall-check: ask KoL's mallprices API for a
 * bulk current snapshot, then consume KoLmafia's cached/persisted prices.
 *
 * If another invocation refreshed less than 60 seconds ago, do not ping KoL
 * again. The just-written mallprices.txt values are reused instead.
 */
function refreshMallSnapshot() {
  var now = k.nowToInt();
  var last = globalMallTimestamp();
  var elapsed = last > 0 ? now - last : MALL_REFRESH_MIN_INTERVAL_MS;

  if (elapsed >= 0 && elapsed < MALL_REFRESH_MIN_INTERVAL_MS) {
    k.print(
      "Mall-price throttle: reusing the snapshot refreshed " +
      Math.floor(elapsed / 1000) +
      "s ago; no new mall-price request sent."
    );
    k.setProperty(PREF_LAST_MALL_REFRESH, String(last));
    return {
      refreshed: false,
      timestampMs: last,
      updatedCount: -1
    };
  }

  // Write the throttle marker before the request. If KoLmafia or the request
  // fails, another invocation still cannot hammer the endpoint immediately.
  var requestMs = k.nowToInt();
  k.bufferToFile(String(requestMs) + "\n", MALL_THROTTLE_FILE);
  k.setProperty(PREF_LAST_MALL_REFRESH, String(requestMs));

  k.print("Refreshing KoL mall-price snapshot (one bulk allitems request)...");
  var updated = k.mallPrices("allitems");
  k.print("KoLmafia recorded/refreshed mall prices for " + updated + " item(s).");

  return {
    refreshed: true,
    timestampMs: requestMs,
    updatedCount: updated
  };
}

function currentMarketPrice(it) {
  /*
   * historicalPrice() is intentionally used after mallPrices("allitems").
   * Unlike mallPrice(), it is a pure read of mallprices.txt and cannot trigger
   * an individual mall search. That keeps this repricer at one bulk market
   * request instead of potentially one request per store item.
   */
  var price = toNumber(k.historicalPrice(it), 0);
  var ageDays = toNumber(k.historicalAge(it), Infinity);

  if (price <= 0 || ageDays < 0 || ageDays > MAX_MARKET_AGE_DAYS) {
    return null;
  }

  return {
    price: price,
    ageDays: ageDays
  };
}

function cleanField(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\t/g, " ")
    .replace(/[\r\n]+/g, " ");
}

function numericLines(linesLike) {
  if (!linesLike) return [];
  if (linesLike instanceof Array) return linesLike;

  var keys = Object.keys(linesLike);
  keys.sort(function (a, b) {
    return Number(a) - Number(b);
  });

  var out = [];
  var i;
  for (i = 0; i < keys.length; i++) out.push(String(linesLike[keys[i]]));
  return out;
}

function parseLogRow(line) {
  if (!line || !/^\d+\t/.test(line)) return null;

  var p = line.split("\t");
  if (p.length < 10) return null;

  /*
   * v2 rows:
   * run_ms id name qty old target applied status market_price age_days source
   *
   * v1 rows from the original Pricegun build had:
   * run_ms id name qty old target applied status pricegun_value pricegun_volume
   *
   * Preserve them as legacy evidence instead of silently relabeling them.
   */
  if (p.length >= 11) {
    return {
      runMs: toNumber(p[0], 0),
      id: toNumber(p[1], 0),
      name: p[2],
      qty: toNumber(p[3], 0),
      oldPrice: toNumber(p[4], 0),
      targetPrice: toNumber(p[5], 0),
      appliedPrice: toNumber(p[6], 0),
      status: p[7],
      marketPrice: toNumber(p[8], 0),
      marketAgeDays: toNumber(p[9], -1),
      source: p[10]
    };
  }

  return {
    runMs: toNumber(p[0], 0),
    id: toNumber(p[1], 0),
    name: p[2],
    qty: toNumber(p[3], 0),
    oldPrice: toNumber(p[4], 0),
    targetPrice: toNumber(p[5], 0),
    appliedPrice: toNumber(p[6], 0),
    status: p[7],
    marketPrice: toNumber(p[8], 0),
    marketAgeDays: -1,
    source: "legacy_pricegun(volume=" + cleanField(p[9]) + ")"
  };
}

function readChangeLog(limit) {
  var lines = numericLines(k.fileToArray(CHANGE_LOG));
  var out = [];
  var i;

  for (i = 0; i < lines.length; i++) {
    var row = parseLogRow(lines[i]);
    if (row) out.push(row);
  }

  out.reverse();
  if (limit && out.length > limit) out = out.slice(0, limit);
  return out;
}

function serializeLogRow(c) {
  return [
    c.runMs,
    c.id,
    cleanField(c.name),
    c.qty,
    c.oldPrice,
    c.targetPrice,
    c.appliedPrice,
    cleanField(c.status),
    c.marketPrice,
    c.marketAgeDays,
    cleanField(c.source)
  ].join("\t");
}

function appendChangeLog(changes) {
  if (!changes.length) return;

  var existingNewestFirst = readChangeLog(MAX_LOG_LINES);
  var rows = existingNewestFirst.reverse().concat(changes);

  if (rows.length > MAX_LOG_LINES) {
    rows = rows.slice(rows.length - MAX_LOG_LINES);
  }

  var header =
    "run_ms\titem_id\titem_name\tquantity\told_price\ttarget_price\tapplied_price\tstatus\tmarket_price\tmarket_age_days\tsource";
  var lines = [header];
  var i;

  for (i = 0; i < rows.length; i++) {
    lines.push(serializeLogRow(rows[i]));
  }

  k.bufferToFile(lines.join("\n") + "\n", CHANGE_LOG);
}

function runReprice(forceRecent) {
  var state = getRunState();

  if (state.recent && !forceRecent) {
    var ok = k.userConfirm(
      "Store repricer last completed " +
        formatDuration(state.ageMs) +
        " ago (less than 24 hours). Run it again anyway?"
    );

    if (!ok) {
      k.print("Store repricer cancelled; no mall-price refresh or store change was made.");
      return {
        ok: false,
        cancelled: true,
        message: "Cancelled by user."
      };
    }
  }

  var storeRows = listStoreItems();

  if (!storeRows.length) {
    k.print("Your mall store is empty; nothing to reprice.");
    return {
      ok: true,
      changed: 0,
      message: "Store is empty."
    };
  }

  k.print("Found " + storeRows.length + " distinct item(s) in your mall store.");

  try {
    refreshMallSnapshot();
  } catch (e) {
    var refreshError = "Mall-price refresh failed before repricing: " + String(e);
    k.setProperty(PREF_LAST_RESULT, refreshError);
    k.print(refreshError);
    return {
      ok: false,
      changed: 0,
      message: refreshError
    };
  }

  var pending = [];
  var skippedNoMarket = 0;
  var unchanged = 0;
  var i;

  for (i = 0; i < storeRows.length; i++) {
    var row = storeRows[i];
    var market = currentMarketPrice(row.item);

    // Fail closed: never fall back to stale data or trigger an individual search.
    if (!market) {
      skippedNoMarket++;
      continue;
    }

    var target = clampTargetPrice(row.item, market.price);

    if (target <= 0) {
      skippedNoMarket++;
      continue;
    }

    if (target === row.oldPrice) {
      unchanged++;
      continue;
    }

    pending.push({
      item: row.item,
      id: row.id,
      name: row.name,
      qty: row.qty,
      oldPrice: row.oldPrice,
      targetPrice: target,
      marketPrice: market.price,
      marketAgeDays: market.ageDays
    });
  }

  var batchOk = true;

  if (pending.length) {
    k.print(
      "Applying " +
        pending.length +
        " price change(s) using KoLmafia's 5th-cheapest mall price."
    );

    k.batchOpen();

    for (i = 0; i < pending.length; i++) {
      // The two-argument form preserves the store's existing per-customer limit.
      k.repriceShop(pending[i].targetPrice, pending[i].item);
    }

    batchOk = k.batchClose();
    k.refreshShop();
  }

  var runMs = k.nowToInt();
  var changes = [];
  var applied = 0;
  var failed = 0;

  for (i = 0; i < pending.length; i++) {
    var p = pending[i];
    var actual = k.shopPrice(p.item);
    var status = actual === p.targetPrice ? "applied" : "verify_failed";

    if (status === "applied") applied++;
    else failed++;

    changes.push({
      runMs: runMs,
      id: p.id,
      name: p.name,
      qty: p.qty,
      oldPrice: p.oldPrice,
      targetPrice: p.targetPrice,
      appliedPrice: actual,
      status: status,
      marketPrice: p.marketPrice,
      marketAgeDays: p.marketAgeDays,
      source: "kolmafia_5th_cheapest"
    });
  }

  appendChangeLog(changes);

  /*
   * Record a completed run even on a partial mutation failure. Some prices may
   * already have changed, so a retry inside 24h should require explicit consent.
   */
  k.setProperty(PREF_LAST_RUN, String(runMs));
  k.setProperty(PREF_LAST_CHANGED, String(applied));

  var summary =
    "Completed: " +
    applied +
    " applied, " +
    failed +
    " failed verification, " +
    unchanged +
    " already at market, " +
    skippedNoMarket +
    " skipped for missing/stale market data" +
    (batchOk ? "." : "; KoLmafia reported a batch failure.");

  k.setProperty(PREF_LAST_RESULT, summary);
  k.print(summary);

  return {
    ok: batchOk && failed === 0,
    changed: applied,
    failed: failed,
    unchanged: unchanged,
    skippedNoMarket: skippedNoMarket,
    message: summary
  };
}

module.exports.getRunState = getRunState;
module.exports.formatDuration = formatDuration;
module.exports.readChangeLog = readChangeLog;
module.exports.runReprice = runReprice;

module.exports.main = function main(command) {
  var force = String(command || "").toLowerCase() === "force";
  runReprice(force);
};
