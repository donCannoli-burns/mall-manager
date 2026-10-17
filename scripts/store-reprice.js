/*
 * store-reprice.js
 * Reprice every item currently in your KoL mall store using Pricegun's current
 * valuation, while respecting a 60-second Pricegun request interval and a
 * 24-hour rerun confirmation guard.
 *
 * KoLmafia JavaScript / Rhino-compatible (ES5-ish syntax on purpose).
 */

var k = require("kolmafia");

var PRICEGUN_BASE = "https://pricegun.loathers.net/api/";
var PRICEGUN_MIN_INTERVAL_MS = 60 * 1000;
var RERUN_GUARD_MS = 24 * 60 * 60 * 1000;
var MAX_PRICEGUN_URL_LENGTH = 3500;
var MALL_PRICE_CEILING = 999999999;

var PREF_LAST_RUN = "storeRepriceLastRunMs";
var PREF_LAST_PRICEGUN = "storeRepriceLastPricegunRequestMs";
var PREF_LAST_RESULT = "storeRepriceLastResult";
var PREF_LAST_CHANGED = "storeRepriceLastChangedCount";
var CHANGE_LOG = "store-reprice-changes.tsv";
var PRICEGUN_THROTTLE_FILE = "store-reprice-pricegun-throttle.txt";
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
  var parts = [];
  if (days) parts.push(days + "d");
  if (hours || days) parts.push(hours + "h");
  parts.push(minutes + "m");
  return parts.join(" ");
}

function getRunState() {
  var now = k.nowToInt();
  var lastRun = prefNumber(PREF_LAST_RUN);
  var lastPricegun = prefNumber(PREF_LAST_PRICEGUN);
  var age = lastRun > 0 ? now - lastRun : -1;
  return {
    nowMs: now,
    lastRunMs: lastRun,
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

function decimalNumber(value) {
  if (value && typeof value === "object" && value.__decimal__ !== undefined) {
    return toNumber(value.__decimal__, NaN);
  }
  return toNumber(value, NaN);
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

function globalPricegunTimestamp() {
  var raw = String(k.fileToBuffer(PRICEGUN_THROTTLE_FILE) || "").trim();
  return toNumber(raw, 0);
}

function throttlePricegun() {
  var now = k.nowToInt();
  var last = globalPricegunTimestamp();
  var elapsed = last > 0 ? now - last : PRICEGUN_MIN_INTERVAL_MS;
  if (elapsed < PRICEGUN_MIN_INTERVAL_MS) {
    var waitSeconds = Math.ceil((PRICEGUN_MIN_INTERVAL_MS - elapsed) / 1000);
    k.print("Pricegun throttle: waiting " + waitSeconds + "s before the next request.");
    k.wait(waitSeconds);
  }

  // Record the timestamp BEFORE the request. If the request/script crashes, the
  // next invocation will still respect the 60-second request boundary.
  var requestMs = k.nowToInt();
  k.bufferToFile(String(requestMs) + "\n", PRICEGUN_THROTTLE_FILE);
  // Also mirror it to the current character preference for easy inspection/UI.
  k.setProperty(PREF_LAST_PRICEGUN, String(requestMs));
}

function fetchPricegunBatch(ids) {
  throttlePricegun();
  var url = PRICEGUN_BASE + ids.join(",");
  var raw = String(k.visitUrl(url, false, true));
  var parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Pricegun returned non-JSON data for " + ids.length + " item(s): " + e);
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
    k.print("Pricegun request " + (b + 1) + "/" + batches.length + " (" + batches[b].length + " items)");
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

function cleanField(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\t/g, " ")
    .replace(/[\r\n]+/g, " ");
}

function numericLines(linesLike) {
  if (!linesLike) return [];
  if (linesLike instanceof Array) return linesLike;
  var keys = Object.keys(linesLike);
  keys.sort(function (a, b) { return Number(a) - Number(b); });
  var out = [];
  var i;
  for (i = 0; i < keys.length; i++) out.push(String(linesLike[keys[i]]));
  return out;
}

function appendChangeLog(changes) {
  if (!changes.length) return;
  var oldLines = numericLines(k.fileToArray(CHANGE_LOG));
  var header = "run_ms\titem_id\titem_name\tquantity\told_price\ttarget_price\tapplied_price\tstatus\tpricegun_value\tpricegun_volume";
  var lines = [];
  var i;

  if (!oldLines.length || oldLines[0] !== header) lines.push(header);
  for (i = 0; i < oldLines.length; i++) {
    if (oldLines[i] && oldLines[i] !== header) lines.push(oldLines[i]);
  }

  for (i = 0; i < changes.length; i++) {
    var c = changes[i];
    lines.push([
      c.runMs,
      c.id,
      cleanField(c.name),
      c.qty,
      c.oldPrice,
      c.targetPrice,
      c.appliedPrice,
      cleanField(c.status),
      c.pricegunValue,
      c.pricegunVolume
    ].join("\t"));
  }

  if (lines.length > MAX_LOG_LINES + 1) {
    lines = [header].concat(lines.slice(lines.length - MAX_LOG_LINES));
  }
  k.bufferToFile(lines.join("\n") + "\n", CHANGE_LOG);
}

function readChangeLog(limit) {
  var lines = numericLines(k.fileToArray(CHANGE_LOG));
  var out = [];
  var start = Math.max(1, lines.length - (limit || 100));
  var i;
  for (i = start; i < lines.length; i++) {
    if (!lines[i]) continue;
    var p = lines[i].split("\t");
    if (p.length < 10) continue;
    out.push({
      runMs: toNumber(p[0], 0),
      id: toNumber(p[1], 0),
      name: p[2],
      qty: toNumber(p[3], 0),
      oldPrice: toNumber(p[4], 0),
      targetPrice: toNumber(p[5], 0),
      appliedPrice: toNumber(p[6], 0),
      status: p[7],
      pricegunValue: toNumber(p[8], 0),
      pricegunVolume: toNumber(p[9], 0)
    });
  }
  return out.reverse();
}

function runReprice(forceRecent) {
  var state = getRunState();
  if (state.recent && !forceRecent) {
    var ok = k.userConfirm(
      "Store repricer last completed " + formatDuration(state.ageMs) +
      " ago (less than 24 hours). Run it again anyway?"
    );
    if (!ok) {
      k.print("Store repricer cancelled; no Pricegun request or price change was made.");
      return { ok: false, cancelled: true, message: "Cancelled by user." };
    }
  }

  var storeRows = listStoreItems();
  if (!storeRows.length) {
    k.print("Your mall store is empty; nothing to reprice.");
    return { ok: true, changed: 0, message: "Store is empty." };
  }

  k.print("Found " + storeRows.length + " distinct item(s) in your mall store.");

  var pricegun;
  try {
    // All Pricegun reads happen before any store mutation. If a batch fails,
    // nothing has been repriced yet.
    pricegun = fetchPricegunValues(storeRows);
  } catch (e) {
    k.setProperty(PREF_LAST_RESULT, "ERROR: " + String(e));
    k.print("Repricing aborted before any store changes: " + e);
    return { ok: false, changed: 0, message: String(e) };
  }

  if (!Object.keys(pricegun).length) {
    var noData = "Pricegun returned no usable valuations; no store prices were changed.";
    k.setProperty(PREF_LAST_RESULT, noData);
    k.print(noData);
    return { ok: false, changed: 0, message: noData };
  }

  var pending = [];
  var skippedNoData = 0;
  var i;
  for (i = 0; i < storeRows.length; i++) {
    var row = storeRows[i];
    var pg = pricegun[String(row.id)];
    if (!pg) {
      skippedNoData++;
      continue;
    }
    var target = clampTargetPrice(row.item, pg.value);
    if (target <= 0 || target === row.oldPrice) continue;
    pending.push({
      item: row.item,
      id: row.id,
      name: row.name,
      qty: row.qty,
      oldPrice: row.oldPrice,
      targetPrice: target,
      pricegunValue: pg.value,
      pricegunVolume: pg.volume
    });
  }

  var batchOk = true;
  if (pending.length) {
    k.print("Applying " + pending.length + " price change(s) using KoLmafia's batched reprice_shop().");
    k.batchOpen();
    for (i = 0; i < pending.length; i++) {
      // Two-argument repriceShop preserves the current per-customer limit.
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
      pricegunValue: p.pricegunValue,
      pricegunVolume: p.pricegunVolume
    });
  }

  appendChangeLog(changes);

  // Record a completed run even on partial mutation failure: at that point some
  // store prices may already have changed, so the next run should require the
  // explicit <24h confirmation rather than silently trying again.
  k.setProperty(PREF_LAST_RUN, String(runMs));
  k.setProperty(PREF_LAST_CHANGED, String(applied));

  var summary =
    "Completed: " + applied + " applied, " + failed + " failed verification, " +
    skippedNoData + " skipped for missing Pricegun data" +
    (batchOk ? "." : "; KoLmafia reported a batch failure.");
  k.setProperty(PREF_LAST_RESULT, summary);
  k.print(summary);

  return {
    ok: batchOk && failed === 0,
    changed: applied,
    failed: failed,
    skippedNoData: skippedNoData,
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
