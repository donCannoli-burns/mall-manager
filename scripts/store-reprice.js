/*
 * store-reprice.js
 *
 * Hybrid mall repricer:
 *
 *   - KoLmafia's CURRENT mall price is the pricing authority.
 *   - Pricegun is a sanity/veto signal, not the target price.
 *
 * KoLmafia deliberately defines mall_price as the price of the 5th cheapest
 * purchasable copy. That protects against a single accidental 100-Meat listing.
 *
 * Pricegun then catches the nastier case where enough suspiciously cheap copies
 * exist to drag even the 5th-cheapest mall price down. If Pricegun's recent
 * transaction value is dramatically higher than the live mall target, the item
 * is FLAGGED and skipped rather than repriced.
 */

var k = require("kolmafia");

var PRICEGUN_BASE = "https://pricegun.loathers.net/api/";
var PRICEGUN_MIN_INTERVAL_MS = 60 * 1000;
var MAX_PRICEGUN_URL_LENGTH = 3500;

var MALL_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
var RERUN_GUARD_MS = 24 * 60 * 60 * 1000;
var MAX_MARKET_AGE_DAYS = 5 / 1440; // accept persisted mall data <= 5 minutes old
var MALL_PRICE_CEILING = 999999999;

var PREF_LAST_RUN = "storeRepriceLastRunMs";
var PREF_LAST_MALL_REFRESH = "storeRepriceLastMallRefreshMs";
var PREF_LAST_PRICEGUN = "storeRepriceLastPricegunRequestMs";
var PREF_LAST_RESULT = "storeRepriceLastResult";
var PREF_LAST_CHANGED = "storeRepriceLastChangedCount";

var PREF_DISCREPANCY_RATIO = "storeRepriceDiscrepancyRatio";
var PREF_DISCREPANCY_MIN_GAP = "storeRepriceDiscrepancyMinGap";
var PREF_PRICEGUN_MIN_VOLUME = "storeRepricePricegunMinVolume";

var DEFAULT_DISCREPANCY_RATIO = 3.0;
var DEFAULT_DISCREPANCY_MIN_GAP = 500;
var DEFAULT_PRICEGUN_MIN_VOLUME = 1;

var CHANGE_LOG = "store-reprice-changes.tsv";
var MALL_THROTTLE_FILE = "store-reprice-mall-throttle.txt";
var PRICEGUN_THROTTLE_FILE = "store-reprice-pricegun-throttle.txt";
var MAX_LOG_LINES = 2000;

function toNumber(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function prefNumber(name, fallback) {
  var raw = String(k.getProperty(name) || "").trim();
  if (!raw) return fallback === undefined ? 0 : fallback;
  return toNumber(raw, fallback === undefined ? 0 : fallback);
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

function globalTimestamp(filename) {
  var raw = String(k.fileToBuffer(filename) || "").trim();
  return toNumber(raw, 0);
}

function getSafetySettings() {
  return {
    discrepancyRatio: Math.max(
      1,
      prefNumber(PREF_DISCREPANCY_RATIO, DEFAULT_DISCREPANCY_RATIO)
    ),
    discrepancyMinGap: Math.max(
      0,
      Math.round(prefNumber(PREF_DISCREPANCY_MIN_GAP, DEFAULT_DISCREPANCY_MIN_GAP))
    ),
    pricegunMinVolume: Math.max(
      0,
      Math.round(prefNumber(PREF_PRICEGUN_MIN_VOLUME, DEFAULT_PRICEGUN_MIN_VOLUME))
    )
  };
}

function getRunState() {
  var now = k.nowToInt();
  var lastRun = prefNumber(PREF_LAST_RUN, 0);
  var lastMallRefresh = Math.max(
    prefNumber(PREF_LAST_MALL_REFRESH, 0),
    globalTimestamp(MALL_THROTTLE_FILE)
  );
  var lastPricegun = Math.max(
    prefNumber(PREF_LAST_PRICEGUN, 0),
    globalTimestamp(PRICEGUN_THROTTLE_FILE)
  );
  var age = lastRun > 0 ? now - lastRun : -1;

  return {
    nowMs: now,
    lastRunMs: lastRun,
    lastMallRefreshMs: lastMallRefresh,
    lastPricegunMs: lastPricegun,
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

/*
 * CONSUME.ash delegates its refresh to loathers/mall-check, which calls
 * mallPrices("allitems") once per day. We use the same KoL API surface but with
 * a shorter, explicit 60-second throttle suitable for an operator-triggered
 * repricer.
 *
 * After this call, historicalPrice()/historicalAge() are pure reads from
 * mallprices.txt; they cannot trigger per-item network searches.
 */
function refreshMallSnapshot() {
  var now = k.nowToInt();
  var last = globalTimestamp(MALL_THROTTLE_FILE);
  var elapsed = last > 0 ? now - last : MALL_REFRESH_MIN_INTERVAL_MS;

  if (elapsed >= 0 && elapsed < MALL_REFRESH_MIN_INTERVAL_MS) {
    k.print(
      "Mall-price throttle: reusing snapshot refreshed " +
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

  // Mark BEFORE the request: a timeout/crash cannot cause an immediate retry storm.
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

function splitIntoPricegunBatches(ids) {
  var batches = [];
  var current = [];
  var currentLength = PRICEGUN_BASE.length;
  var i;

  for (i = 0; i < ids.length; i++) {
    var part = String(ids[i]);
    var extra = part.length + (current.length ? 1 : 0);

    if (current.length && currentLength + extra > MAX_PRICEGUN_URL_LENGTH) {
      batches.push(current);
      current = [];
      currentLength = PRICEGUN_BASE.length;
      extra = part.length;
    }

    current.push(ids[i]);
    currentLength += extra;
  }

  if (current.length) batches.push(current);
  return batches;
}

function throttlePricegun() {
  var now = k.nowToInt();
  var last = globalTimestamp(PRICEGUN_THROTTLE_FILE);
  var elapsed = last > 0 ? now - last : PRICEGUN_MIN_INTERVAL_MS;

  if (elapsed < PRICEGUN_MIN_INTERVAL_MS) {
    var waitSeconds = Math.ceil((PRICEGUN_MIN_INTERVAL_MS - elapsed) / 1000);
    k.print("Pricegun throttle: waiting " + waitSeconds + "s before the next request.");
    k.wait(waitSeconds);
  }

  // Mark BEFORE the request for crash-safe throttling across characters/runs.
  var requestMs = k.nowToInt();
  k.bufferToFile(String(requestMs) + "\n", PRICEGUN_THROTTLE_FILE);
  k.setProperty(PREF_LAST_PRICEGUN, String(requestMs));
}

function decimalNumber(value) {
  if (value && typeof value === "object" && value.__decimal__ !== undefined) {
    return toNumber(value.__decimal__, NaN);
  }
  return toNumber(value, NaN);
}

function fetchPricegunBatch(ids) {
  throttlePricegun();

  var url = PRICEGUN_BASE + ids.join(",");
  var raw = String(k.visitUrl(url, false, true));
  var parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "Pricegun returned non-JSON data for " + ids.length + " item(s): " + e
    );
  }

  if (parsed && parsed.error) {
    throw new Error("Pricegun error: " + parsed.error);
  }

  return parsed instanceof Array ? parsed : [parsed];
}

function fetchPricegunValues(storeRows) {
  var ids = [];
  var i;

  for (i = 0; i < storeRows.length; i++) ids.push(storeRows[i].id);

  var batches = splitIntoPricegunBatches(ids);
  var byId = {};
  var b;

  for (b = 0; b < batches.length; b++) {
    k.print(
      "Pricegun sanity request " +
        (b + 1) +
        "/" +
        batches.length +
        " (" +
        batches[b].length +
        " store item(s))"
    );

    var rows = fetchPricegunBatch(batches[b]);

    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.itemId === undefined) continue;

      var value = decimalNumber(row.value);
      if (!isFinite(value) || value <= 0) continue;

      byId[String(Number(row.itemId))] = {
        value: value,
        volume: toNumber(row.volume, 0),
        date: row.date ? String(row.date) : ""
      };
    }
  }

  return byId;
}

function pricegunDiscrepancy(marketPrice, pg, settings) {
  if (!pg || pg.value <= 0 || pg.volume < settings.pricegunMinVolume) {
    return {
      flagged: false,
      ratio: 0,
      gap: 0,
      usable: false
    };
  }

  var ratio = pg.value / marketPrice;
  var gap = pg.value - marketPrice;

  return {
    flagged:
      ratio >= settings.discrepancyRatio &&
      gap >= settings.discrepancyMinGap,
    ratio: ratio,
    gap: gap,
    usable: true
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

  /*
   * v3:
   * run id name qty old target applied status market marketAge pgValue pgVolume ratio source
   */
  if (p.length >= 14) {
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
      pricegunValue: toNumber(p[10], 0),
      pricegunVolume: toNumber(p[11], 0),
      discrepancyRatio: toNumber(p[12], 0),
      source: p[13]
    };
  }

  /*
   * v2 from the first mall-price patch:
   * run id name qty old target applied status market marketAge source
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
      pricegunValue: 0,
      pricegunVolume: 0,
      discrepancyRatio: 0,
      source: p[10]
    };
  }

  /*
   * v1 original Pricegun-target build:
   * run id name qty old target applied status pricegunValue pricegunVolume
   */
  if (p.length >= 10) {
    return {
      runMs: toNumber(p[0], 0),
      id: toNumber(p[1], 0),
      name: p[2],
      qty: toNumber(p[3], 0),
      oldPrice: toNumber(p[4], 0),
      targetPrice: toNumber(p[5], 0),
      appliedPrice: toNumber(p[6], 0),
      status: p[7],
      marketPrice: 0,
      marketAgeDays: -1,
      pricegunValue: toNumber(p[8], 0),
      pricegunVolume: toNumber(p[9], 0),
      discrepancyRatio: 0,
      source: "legacy_pricegun_target"
    };
  }

  return null;
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
    c.pricegunValue,
    c.pricegunVolume,
    c.discrepancyRatio,
    cleanField(c.source)
  ].join("\t");
}

function appendChangeLog(rowsToAdd) {
  if (!rowsToAdd.length) return;

  var existingNewestFirst = readChangeLog(MAX_LOG_LINES);
  var rows = existingNewestFirst.reverse().concat(rowsToAdd);

  if (rows.length > MAX_LOG_LINES) {
    rows = rows.slice(rows.length - MAX_LOG_LINES);
  }

  var header =
    "run_ms\titem_id\titem_name\tquantity\told_price\ttarget_price\tapplied_price\tstatus\tmarket_price\tmarket_age_days\tpricegun_value\tpricegun_volume\tdiscrepancy_ratio\tsource";

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
      k.print(
        "Store repricer cancelled; no market refresh, Pricegun request, or store change was made."
      );
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
    var refreshError =
      "Mall-price refresh failed before repricing: " + String(e);
    k.setProperty(PREF_LAST_RESULT, refreshError);
    k.print(refreshError);

    return {
      ok: false,
      changed: 0,
      message: refreshError
    };
  }

  var pricegun;
  try {
    /*
     * Pricegun is not used as a target. We fetch it before mutations so a total
     * Pricegun transport/API failure aborts safely rather than silently disabling
     * the requested sanity layer.
     */
    pricegun = fetchPricegunValues(storeRows);
  } catch (e2) {
    var pgError =
      "Pricegun sanity check failed before repricing; no prices changed: " +
      String(e2);
    k.setProperty(PREF_LAST_RESULT, pgError);
    k.print(pgError);

    return {
      ok: false,
      changed: 0,
      message: pgError
    };
  }

  var settings = getSafetySettings();
  k.print(
    "Pricegun veto: flag when Pricegun >= " +
      settings.discrepancyRatio +
      "x live mall AND >= " +
      settings.discrepancyMinGap +
      " Meat higher, with volume >= " +
      settings.pricegunMinVolume +
      "."
  );

  var pending = [];
  var auditRows = [];
  var skippedNoMarket = 0;
  var unchanged = 0;
  var flagged = 0;
  var noPricegunReference = 0;
  var i;
  var runMs = k.nowToInt();

  for (i = 0; i < storeRows.length; i++) {
    var row = storeRows[i];
    var market = currentMarketPrice(row.item);

    // Fail closed for missing/stale KoL market data. Never fall back to Pricegun.
    if (!market) {
      skippedNoMarket++;
      continue;
    }

    var target = clampTargetPrice(row.item, market.price);

    if (target <= 0) {
      skippedNoMarket++;
      continue;
    }

    var pg = pricegun[String(row.id)] || null;
    var discrepancy = pricegunDiscrepancy(target, pg, settings);

    if (!discrepancy.usable) {
      noPricegunReference++;
    }

    if (discrepancy.flagged) {
      flagged++;

      k.print(
        "FLAGGED " +
          row.name +
          ": mall " +
          target +
          " vs Pricegun " +
          Math.round(pg.value) +
          " (" +
          discrepancy.ratio.toFixed(2) +
          "x). Leaving store price at " +
          row.oldPrice +
          "."
      );

      auditRows.push({
        runMs: runMs,
        id: row.id,
        name: row.name,
        qty: row.qty,
        oldPrice: row.oldPrice,
        targetPrice: target,
        appliedPrice: row.oldPrice,
        status: "flagged_discrepancy",
        marketPrice: market.price,
        marketAgeDays: market.ageDays,
        pricegunValue: pg.value,
        pricegunVolume: pg.volume,
        discrepancyRatio: discrepancy.ratio,
        source: "mall_vetoed_by_pricegun"
      });

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
      marketAgeDays: market.ageDays,
      pricegunValue: pg ? pg.value : 0,
      pricegunVolume: pg ? pg.volume : 0,
      discrepancyRatio: discrepancy.ratio,
      source: discrepancy.usable
        ? "kolmafia_5th_cheapest_pricegun_checked"
        : "kolmafia_5th_cheapest_no_pg_reference"
    });
  }

  var batchOk = true;

  if (pending.length) {
    k.print(
      "Applying " +
        pending.length +
        " safe price change(s) using KoLmafia's 5th-cheapest mall price."
    );

    k.batchOpen();

    for (i = 0; i < pending.length; i++) {
      // Two-argument repriceShop preserves the existing per-customer limit.
      k.repriceShop(pending[i].targetPrice, pending[i].item);
    }

    batchOk = k.batchClose();
    k.refreshShop();
  }

  var applied = 0;
  var failed = 0;

  for (i = 0; i < pending.length; i++) {
    var p = pending[i];
    var actual = k.shopPrice(p.item);
    var status =
      actual === p.targetPrice ? "applied" : "verify_failed";

    if (status === "applied") applied++;
    else failed++;

    auditRows.push({
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
      pricegunValue: p.pricegunValue,
      pricegunVolume: p.pricegunVolume,
      discrepancyRatio: p.discrepancyRatio,
      source: p.source
    });
  }

  appendChangeLog(auditRows);

  /*
   * Record completion even on partial mutation failure. Some prices may already
   * have changed, so an immediate retry should require explicit <24h consent.
   */
  k.setProperty(PREF_LAST_RUN, String(runMs));
  k.setProperty(PREF_LAST_CHANGED, String(applied));

  var summary =
    "Completed: " +
    applied +
    " applied, " +
    flagged +
    " Pricegun discrepancy flag(s), " +
    failed +
    " failed verification, " +
    unchanged +
    " already at market, " +
    skippedNoMarket +
    " skipped for missing/stale mall data, " +
    noPricegunReference +
    " without a usable Pricegun reference" +
    (batchOk ? "." : "; KoLmafia reported a batch failure.");

  k.setProperty(PREF_LAST_RESULT, summary);
  k.print(summary);

  return {
    ok: batchOk && failed === 0,
    changed: applied,
    flagged: flagged,
    failed: failed,
    unchanged: unchanged,
    skippedNoMarket: skippedNoMarket,
    noPricegunReference: noPricegunReference,
    message: summary
  };
}

module.exports.getRunState = getRunState;
module.exports.getSafetySettings = getSafetySettings;
module.exports.formatDuration = formatDuration;
module.exports.readChangeLog = readChangeLog;
module.exports.runReprice = runReprice;

// Shared, read-oriented market helpers used by mall-clean.js so the repricer
// and cleaner cannot drift into different mall/Pricegun safety rules.
module.exports.listStoreItems = listStoreItems;
module.exports.refreshMallSnapshot = refreshMallSnapshot;
module.exports.currentMarketPrice = currentMarketPrice;
module.exports.fetchPricegunValues = fetchPricegunValues;
module.exports.pricegunDiscrepancy = pricegunDiscrepancy;

module.exports.main = function main(command) {
  var force = String(command || "").toLowerCase() === "force";
  runReprice(force);
};
