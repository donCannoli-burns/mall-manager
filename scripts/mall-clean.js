/*
 * mall-clean.js
 *
 * Autosell low-value clutter out of your mall store when the CURRENT mall
 * price is at/near the legal mall minimum, with the same Pricegun discrepancy
 * veto used by store-reprice.js.
 *
 * This code is derived from rlbond86's mall_autosell script:
 * http://kolmafia.us/showthread.php?9804
 * This disclaimer must be included in derivative works.
 *
 * Defaults preserved from mall_autosell.ash:
 *   - threshold fraction: 0.05 (5% above legal mall minimum)
 *   - maximum mall price eligible for cleanup: 5,000 Meat
 *
 * Usage:
 *   call mall-clean.js preview   // read-only candidate/flag report
 *   call mall-clean.js           // scan, show candidates, then confirm live cleanup
 *   call mall-clean.js force     // bypass <24h rerun guard, still asks final confirmation
 */

var k = require("kolmafia");
var market = require("./store-reprice.js");

var DEFAULT_THRESHOLD_FRACTION = 0.05;
var DEFAULT_MAX_MALL_PRICE = 5000;
var RERUN_GUARD_MS = 24 * 60 * 60 * 1000;
var MAX_LOG_LINES = 2000;

var PREF_THRESHOLD_FRACTION = "mallCleanThresholdFraction";
var PREF_MAX_MALL_PRICE = "mallCleanMaxMallPrice";
var PREF_LAST_RUN = "mallCleanLastRunMs";
var PREF_LAST_RESULT = "mallCleanLastResult";

var CLEAN_LOG = "mall-clean-log.tsv";

function toNumber(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function prefNumber(name, fallback) {
  var raw = String(k.getProperty(name) || "").trim();
  if (!raw) return fallback;
  return toNumber(raw, fallback);
}

function getCleanSettings() {
  return {
    thresholdFraction: Math.max(
      0,
      prefNumber(PREF_THRESHOLD_FRACTION, DEFAULT_THRESHOLD_FRACTION)
    ),
    maxMallPrice: Math.max(
      1,
      Math.round(prefNumber(PREF_MAX_MALL_PRICE, DEFAULT_MAX_MALL_PRICE))
    )
  };
}

function legalMallMinimum(it) {
  return Math.max(100, 2 * k.autosellPrice(it));
}

function cleanupThreshold(it, settings) {
  return Math.floor(
    legalMallMinimum(it) * (1 + settings.thresholdFraction)
  );
}

function formatMeat(value) {
  return String(Math.round(Number(value) || 0))
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

function appendLog(rows) {
  if (!rows.length) return;

  var old = numericLines(k.fileToArray(CLEAN_LOG));
  var data = [];
  var i;

  for (i = 0; i < old.length; i++) {
    if (old[i] && /^\d+\t/.test(old[i])) data.push(old[i]);
  }

  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    data.push([
      r.runMs,
      r.id,
      cleanField(r.name),
      r.qty,
      r.autosellPrice,
      r.mallMinimum,
      r.cleanupThreshold,
      r.marketPrice,
      r.pricegunValue,
      r.pricegunVolume,
      r.discrepancyRatio,
      cleanField(r.status),
      r.meatGained
    ].join("\t"));
  }

  if (data.length > MAX_LOG_LINES) {
    data = data.slice(data.length - MAX_LOG_LINES);
  }

  var header =
    "run_ms\titem_id\titem_name\tquantity\tautosell_price\tmall_minimum\tcleanup_threshold\tmarket_price\tpricegun_value\tpricegun_volume\tdiscrepancy_ratio\tstatus\tmeat_gained";

  k.bufferToFile([header].concat(data).join("\n") + "\n", CLEAN_LOG);
}

function scanStore() {
  var storeRows = market.listStoreItems();
  var settings = getCleanSettings();
  var safety = market.getSafetySettings();

  if (!storeRows.length) {
    return {
      settings: settings,
      safety: safety,
      storeRows: [],
      candidates: [],
      flags: [],
      skipped: [],
      projectedMeat: 0,
      noPricegunReference: 0
    };
  }

  // One bulk KoL mall snapshot, using the same 60-second shared throttle.
  market.refreshMallSnapshot();

  // Same Pricegun batching/throttle/veto logic as the repricer.
  var pricegun = market.fetchPricegunValues(storeRows);

  var candidates = [];
  var flags = [];
  var skipped = [];
  var projectedMeat = 0;
  var noPricegunReference = 0;
  var i;

  for (i = 0; i < storeRows.length; i++) {
    var row = storeRows[i];
    var marketInfo = market.currentMarketPrice(row.item);
    var autoPrice = k.autosellPrice(row.item);
    var minimum = legalMallMinimum(row.item);
    var threshold = cleanupThreshold(row.item, settings);

    if (!marketInfo) {
      skipped.push({
        row: row,
        reason: "missing_or_stale_market"
      });
      continue;
    }

    // Do not attempt to autosell things which have no positive autosell value.
    if (autoPrice <= 0) {
      skipped.push({
        row: row,
        reason: "no_positive_autosell_value"
      });
      continue;
    }

    // Mirror mall_autosell.ash: only clean items near mall minimum and below
    // the configured maximum mall price.
    if (
      marketInfo.price > threshold ||
      marketInfo.price >= settings.maxMallPrice
    ) {
      continue;
    }

    var pg = pricegun[String(row.id)] || null;
    var discrepancy = market.pricegunDiscrepancy(
      marketInfo.price,
      pg,
      safety
    );

    if (!discrepancy.usable) noPricegunReference++;

    var common = {
      row: row,
      autosellPrice: autoPrice,
      mallMinimum: minimum,
      cleanupThreshold: threshold,
      marketPrice: marketInfo.price,
      marketAgeDays: marketInfo.ageDays,
      pricegunValue: pg ? pg.value : 0,
      pricegunVolume: pg ? pg.volume : 0,
      discrepancyRatio: discrepancy.ratio
    };

    if (discrepancy.flagged) {
      flags.push(common);
      continue;
    }

    candidates.push(common);
    projectedMeat += row.qty * autoPrice;
  }

  return {
    settings: settings,
    safety: safety,
    storeRows: storeRows,
    candidates: candidates,
    flags: flags,
    skipped: skipped,
    projectedMeat: projectedMeat,
    noPricegunReference: noPricegunReference
  };
}

function printScan(scan) {
  var i;

  k.print(
    "Mall Clean: threshold = legal mall minimum + " +
      Math.round(scan.settings.thresholdFraction * 10000) / 100 +
      "%; max eligible mall price = " +
      formatMeat(scan.settings.maxMallPrice) +
      " Meat.",
    "blue"
  );

  if (scan.flags.length) {
    k.print(
      "PRICEGUN FLAGS — these items will NOT be autosold:",
      "red"
    );

    for (i = 0; i < scan.flags.length; i++) {
      var f = scan.flags[i];
      k.print(
        "  " +
          f.row.qty +
          "x " +
          f.row.name +
          " | mall " +
          formatMeat(f.marketPrice) +
          " | Pricegun " +
          formatMeat(f.pricegunValue) +
          " | " +
          f.discrepancyRatio.toFixed(2) +
          "x | existing shop price " +
          formatMeat(f.row.oldPrice),
        "red"
      );
    }
  }

  if (!scan.candidates.length) {
    k.print("No safe mall-clean candidates found.", "green");
    return;
  }

  k.print("SAFE CLEANUP CANDIDATES:", "green");

  for (i = 0; i < scan.candidates.length; i++) {
    var c = scan.candidates[i];
    var pgText = c.pricegunValue > 0
      ? " | Pricegun " +
        formatMeat(c.pricegunValue) +
        " (" +
        c.discrepancyRatio.toFixed(2) +
        "x)"
      : " | Pricegun: no usable reference";

    k.print(
      "  " +
        c.row.qty +
        "x " +
        c.row.name +
        " | mall " +
        formatMeat(c.marketPrice) +
        " <= cleanup threshold " +
        formatMeat(c.cleanupThreshold) +
        " | autosell " +
        formatMeat(c.autosellPrice) +
        " ea." +
        pgText,
      "green"
    );
  }

  k.print(
    "Projected autosell proceeds: " +
      formatMeat(scan.projectedMeat) +
      " Meat across " +
      scan.candidates.length +
      " distinct item(s).",
    "blue"
  );

  if (scan.noPricegunReference > 0) {
    k.print(
      scan.noPricegunReference +
        " cleanup candidate(s) had no usable per-item Pricegun reference; they still retain KoLmafia's 5th-cheapest mall protection.",
      "orange"
    );
  }
}

function recentRunNeedsConfirmation(force) {
  if (force) return false;

  var last = prefNumber(PREF_LAST_RUN, 0);
  if (last <= 0) return false;

  var age = k.nowToInt() - last;
  if (age < 0 || age >= RERUN_GUARD_MS) return false;

  return !k.userConfirm(
    "Mall Clean last completed " +
      market.formatDuration(age) +
      " ago (less than 24 hours). Scan and possibly clean again?"
  );
}

function executeCandidates(scan) {
  var runMs = k.nowToInt();
  var rows = [];
  var soldItems = 0;
  var soldUnits = 0;
  var totalMeat = 0;
  var failures = 0;
  var i;

  // Record discrepancy flags in the audit even though they are deliberately
  // untouched.
  for (i = 0; i < scan.flags.length; i++) {
    var f = scan.flags[i];
    rows.push({
      runMs: runMs,
      id: f.row.id,
      name: f.row.name,
      qty: f.row.qty,
      autosellPrice: f.autosellPrice,
      mallMinimum: f.mallMinimum,
      cleanupThreshold: f.cleanupThreshold,
      marketPrice: f.marketPrice,
      pricegunValue: f.pricegunValue,
      pricegunVolume: f.pricegunVolume,
      discrepancyRatio: f.discrepancyRatio,
      status: "flagged_discrepancy_not_sold",
      meatGained: 0
    });
  }

  for (i = 0; i < scan.candidates.length; i++) {
    var c = scan.candidates[i];
    var qty = c.row.qty;
    var beforeInv = k.itemAmount(c.row.item);
    var beforeMeat = k.myMeat();

    k.print(
      "Cleaning " +
        qty +
        "x " +
        c.row.name +
        " from mall store...",
      "blue"
    );

    k.takeShop(qty, c.row.item);

    var afterTake = k.itemAmount(c.row.item);
    if (afterTake < beforeInv + qty) {
      failures++;
      rows.push({
        runMs: runMs,
        id: c.row.id,
        name: c.row.name,
        qty: qty,
        autosellPrice: c.autosellPrice,
        mallMinimum: c.mallMinimum,
        cleanupThreshold: c.cleanupThreshold,
        marketPrice: c.marketPrice,
        pricegunValue: c.pricegunValue,
        pricegunVolume: c.pricegunVolume,
        discrepancyRatio: c.discrepancyRatio,
        status: "take_failed",
        meatGained: 0
      });
      k.print(
        "Could not verify removal of " + c.row.name + " from store; NOT autoselling it.",
        "red"
      );
      continue;
    }

    k.autosell(qty, c.row.item);

    var afterSell = k.itemAmount(c.row.item);
    var afterMeat = k.myMeat();
    var gained = Math.max(0, afterMeat - beforeMeat);

    if (afterSell > afterTake - qty) {
      failures++;
      rows.push({
        runMs: runMs,
        id: c.row.id,
        name: c.row.name,
        qty: qty,
        autosellPrice: c.autosellPrice,
        mallMinimum: c.mallMinimum,
        cleanupThreshold: c.cleanupThreshold,
        marketPrice: c.marketPrice,
        pricegunValue: c.pricegunValue,
        pricegunVolume: c.pricegunVolume,
        discrepancyRatio: c.discrepancyRatio,
        status: "autosell_verify_failed",
        meatGained: gained
      });
      k.print(
        "Autosell verification failed for " + c.row.name + ".",
        "red"
      );
      continue;
    }

    soldItems++;
    soldUnits += qty;
    totalMeat += gained;

    rows.push({
      runMs: runMs,
      id: c.row.id,
      name: c.row.name,
      qty: qty,
      autosellPrice: c.autosellPrice,
      mallMinimum: c.mallMinimum,
      cleanupThreshold: c.cleanupThreshold,
      marketPrice: c.marketPrice,
      pricegunValue: c.pricegunValue,
      pricegunVolume: c.pricegunVolume,
      discrepancyRatio: c.discrepancyRatio,
      status: "autosold",
      meatGained: gained
    });

    k.print(
      "Autosold " +
        qty +
        "x " +
        c.row.name +
        " for " +
        formatMeat(gained) +
        " Meat total.",
      "green"
    );
  }

  k.refreshShop();
  appendLog(rows);
  k.setProperty(PREF_LAST_RUN, String(runMs));

  var summary =
    "Mall Clean completed: " +
    soldItems +
    " item type(s), " +
    soldUnits +
    " unit(s), " +
    formatMeat(totalMeat) +
    " Meat gained, " +
    scan.flags.length +
    " Pricegun flag(s) left untouched, " +
    failures +
    " failure(s).";

  k.setProperty(PREF_LAST_RESULT, summary);
  k.print(summary, failures ? "red" : "green");

  return {
    ok: failures === 0,
    soldItems: soldItems,
    soldUnits: soldUnits,
    totalMeat: totalMeat,
    flags: scan.flags.length,
    failures: failures,
    message: summary
  };
}

function runClean(options) {
  options = options || {};
  var preview = !!options.preview;
  var force = !!options.force;

  if (!preview && recentRunNeedsConfirmation(force)) {
    k.print("Mall Clean cancelled before market/Pricegun checks.", "blue");
    return {
      ok: false,
      cancelled: true,
      message: "Cancelled by user."
    };
  }

  var scan;

  try {
    scan = scanStore();
  } catch (e) {
    var message =
      "Mall Clean aborted before any store mutation: " + String(e);
    k.setProperty(PREF_LAST_RESULT, message);
    k.print(message, "red");
    return {
      ok: false,
      message: message
    };
  }

  printScan(scan);

  if (preview) {
    return {
      ok: true,
      preview: true,
      candidates: scan.candidates.length,
      flags: scan.flags.length,
      projectedMeat: scan.projectedMeat,
      message: "Preview only; no items were removed or autosold."
    };
  }

  if (!scan.candidates.length) {
    k.setProperty(
      PREF_LAST_RESULT,
      "Mall Clean found no safe cleanup candidates; nothing changed."
    );
    return {
      ok: true,
      candidates: 0,
      flags: scan.flags.length,
      message: "No safe cleanup candidates."
    };
  }

  var confirmed = k.userConfirm(
    "Mall Clean will REMOVE and AUTOSELL " +
      scan.candidates.length +
      " distinct store item(s), projected " +
      formatMeat(scan.projectedMeat) +
      " Meat. This is irreversible. Proceed?"
  );

  if (!confirmed) {
    k.print("Mall Clean cancelled; nothing was removed or autosold.", "blue");
    return {
      ok: false,
      cancelled: true,
      message: "Cancelled by user."
    };
  }

  return executeCandidates(scan);
}

module.exports.getCleanSettings = getCleanSettings;
module.exports.scanStore = scanStore;
module.exports.runClean = runClean;

module.exports.main = function main(command) {
  var cmd = String(command || "").toLowerCase();
  var preview =
    cmd.indexOf("preview") >= 0 ||
    cmd.indexOf("test") >= 0 ||
    cmd.indexOf("dry") >= 0;
  var force = cmd.indexOf("force") >= 0;

  runClean({
    preview: preview,
    force: force
  });
};
