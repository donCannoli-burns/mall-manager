/*
 * relay_store_reprice.js
 *
 * Mall Manager relay dashboard:
 *   - live repricer controls / Pricegun safety flags
 *   - KoL backoffice sales analytics from backoffice.php?which=3
 *   - local deduplicated sales history so KoL's rolling two-week window can
 *     become a longer-running dashboard over time
 *
 * Sales parsing intentionally follows the proven shape used by
 * jimmyking9999999/kol-relay-projects/relay/backoffice.ash:
 *
 *   MM/DD/YY HH:MM:SS PLAYER bought QTY (ITEM) for TOTAL Meat.
 */

var k = require("kolmafia");
var repricer = require("../scripts/store-reprice.js");

var SELF = "/relay_store_reprice.js";
var SALES_URL = "backoffice.php?which=3";
var SALES_HISTORY_FILE = "mall-manager-sales.tsv";
var SALES_HISTORY_MAX_ROWS = 100000;

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function number(value) {
  var n = Math.round(Number(value) || 0);
  var s = String(n);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function decimal(value, places) {
  var n = Number(value) || 0;
  return n.toFixed(places === undefined ? 1 : places);
}

function ratio(value) {
  var n = Number(value) || 0;
  return n > 0 ? n.toFixed(2) + "x" : "—";
}

function dateText(ms) {
  if (!ms) return "Never";
  try {
    return new Date(Number(ms)).toLocaleString();
  } catch (e) {
    return String(ms);
  }
}

function trim(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/^\s+|\s+$/g, "");
}

function decodeBasicHtml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#([0-9]+);/g, function (_, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
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

function parseIntLoose(value) {
  return Number(String(value || "").replace(/,/g, "")) || 0;
}

function normalizeDate(date) {
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(date));
  if (!m) return String(date);

  var year = Number(m[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;

  var month = ("0" + Number(m[1])).slice(-2);
  var day = ("0" + Number(m[2])).slice(-2);

  return month + "/" + day + "/" + year;
}

function dateSortKey(date) {
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normalizeDate(date));
  if (!m) return 0;
  return Number(m[3]) * 10000 + Number(m[1]) * 100 + Number(m[2]);
}

function monthKey(date) {
  var d = normalizeDate(date);
  var m = /^(\d{2})\/\d{2}\/(\d{4})$/.exec(d);
  return m ? m[2] + "-" + m[1] : "Unknown";
}

function transactionBaseKey(tx) {
  return [
    tx.date,
    tx.time,
    tx.player,
    tx.item,
    tx.quantity,
    tx.totalMeat
  ].join("|");
}

/*
 * Parse the actual Store Log tab: /backoffice.php?which=3.
 *
 * We strip markup first because player/item names are linked in the native page.
 * The resulting text matches the longstanding KoL format, e.g.
 *
 * 10/16/26 23:20:26 vkkhamul bought 3 (shadow glass) for 16,038 Meat.
 */
function parseBackofficeSales(html) {
  var text = decodeBasicHtml(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  text = text.replace(/\s+/g, " ");

  var re = /(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(\d{1,2}:\d{2}:\d{2})\s+(.+?)\s+bought\s+([\d,]+)\s+\((.*?)\)\s+for\s+([\d,]+)\s+Meat\./gi;
  var found = [];
  var seenOccurrence = {};
  var m;

  while ((m = re.exec(text)) !== null) {
    var quantity = parseIntLoose(m[4]);
    var totalMeat = parseIntLoose(m[6]);

    if (quantity <= 0 || totalMeat < 0) continue;

    var tx = {
      date: normalizeDate(trim(m[1])),
      time: trim(m[2]),
      player: trim(m[3]),
      item: trim(m[5]),
      quantity: quantity,
      itemPrice: quantity > 0 ? Math.round(totalMeat / quantity) : 0,
      totalMeat: totalMeat
    };

    var base = transactionBaseKey(tx);
    var occurrence = seenOccurrence[base] || 0;
    seenOccurrence[base] = occurrence + 1;
    tx.key = base + "|" + occurrence;

    found.push(tx);
  }

  return found;
}

function fetchCurrentSales() {
  var html = String(k.visitUrl(SALES_URL));
  var rows = parseBackofficeSales(html);

  return {
    html: html,
    rows: rows,
    recognized: html.indexOf("Recent Store Activity") >= 0 || rows.length > 0
  };
}

function historyRow(tx) {
  return [
    cleanField(tx.key),
    cleanField(tx.date),
    cleanField(tx.time),
    cleanField(tx.player),
    cleanField(tx.item),
    tx.quantity,
    tx.itemPrice,
    tx.totalMeat
  ].join("\t");
}

function readSalesHistory() {
  var lines = numericLines(k.fileToArray(SALES_HISTORY_FILE));
  var rows = [];
  var i;

  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf("key\tdate\ttime\t") === 0) continue;

    var p = line.split("\t");
    if (p.length < 8) continue;

    rows.push({
      key: p[0],
      date: p[1],
      time: p[2],
      player: p[3],
      item: p[4],
      quantity: Number(p[5]) || 0,
      itemPrice: Number(p[6]) || 0,
      totalMeat: Number(p[7]) || 0
    });
  }

  return rows;
}

function mergeSalesHistory(currentRows) {
  var history = readSalesHistory();
  var known = {};
  var i;

  for (i = 0; i < history.length; i++) known[history[i].key] = true;

  var added = 0;

  for (i = 0; i < currentRows.length; i++) {
    if (known[currentRows[i].key]) continue;
    history.push(currentRows[i]);
    known[currentRows[i].key] = true;
    added++;
  }

  if (added > 0) {
    history.sort(function (a, b) {
      var da = dateSortKey(a.date);
      var db = dateSortKey(b.date);
      if (da !== db) return da - db;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    if (history.length > SALES_HISTORY_MAX_ROWS) {
      history = history.slice(history.length - SALES_HISTORY_MAX_ROWS);
    }

    var lines = [
      "key\tdate\ttime\tplayer\titem\tquantity\titem_price\ttotal_meat"
    ];

    for (i = 0; i < history.length; i++) lines.push(historyRow(history[i]));

    k.bufferToFile(lines.join("\n") + "\n", SALES_HISTORY_FILE);
  }

  return {
    rows: history,
    added: added
  };
}

function objectValues(obj) {
  var keys = Object.keys(obj);
  var out = [];
  var i;
  for (i = 0; i < keys.length; i++) out.push(obj[keys[i]]);
  return out;
}

function aggregateSales(rows) {
  var byBuyer = {};
  var byItem = {};
  var byDay = {};
  var byMonth = {};
  var totals = {
    units: 0,
    transactions: rows.length,
    meat: 0,
    buyers: 0,
    items: 0
  };
  var i;

  for (i = 0; i < rows.length; i++) {
    var tx = rows[i];

    totals.units += tx.quantity;
    totals.meat += tx.totalMeat;

    if (!byBuyer[tx.player]) {
      byBuyer[tx.player] = {
        label: tx.player,
        units: 0,
        transactions: 0,
        meat: 0
      };
    }
    byBuyer[tx.player].units += tx.quantity;
    byBuyer[tx.player].transactions += 1;
    byBuyer[tx.player].meat += tx.totalMeat;

    if (!byItem[tx.item]) {
      byItem[tx.item] = {
        label: tx.item,
        units: 0,
        transactions: 0,
        meat: 0
      };
    }
    byItem[tx.item].units += tx.quantity;
    byItem[tx.item].transactions += 1;
    byItem[tx.item].meat += tx.totalMeat;

    if (!byDay[tx.date]) {
      byDay[tx.date] = {
        label: tx.date,
        units: 0,
        transactions: 0,
        meat: 0,
        sortKey: dateSortKey(tx.date)
      };
    }
    byDay[tx.date].units += tx.quantity;
    byDay[tx.date].transactions += 1;
    byDay[tx.date].meat += tx.totalMeat;

    var mk = monthKey(tx.date);
    if (!byMonth[mk]) {
      byMonth[mk] = {
        label: mk,
        units: 0,
        transactions: 0,
        meat: 0
      };
    }
    byMonth[mk].units += tx.quantity;
    byMonth[mk].transactions += 1;
    byMonth[mk].meat += tx.totalMeat;
  }

  totals.buyers = Object.keys(byBuyer).length;
  totals.items = Object.keys(byItem).length;

  var buyers = objectValues(byBuyer);
  var items = objectValues(byItem);
  var days = objectValues(byDay);
  var months = objectValues(byMonth);

  for (i = 0; i < items.length; i++) {
    items[i].averagePrice =
      items[i].units > 0 ? items[i].meat / items[i].units : 0;
    items[i].averagePerTransaction =
      items[i].transactions > 0
        ? items[i].units / items[i].transactions
        : 0;
  }

  buyers.sort(function (a, b) {
    return b.units - a.units || b.meat - a.meat;
  });

  items.sort(function (a, b) {
    return b.units - a.units || b.meat - a.meat;
  });

  days.sort(function (a, b) {
    return a.sortKey - b.sortKey;
  });

  months.sort(function (a, b) {
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  return {
    totals: totals,
    buyers: buyers,
    items: items,
    days: days,
    months: months
  };
}

function copySorted(rows, field) {
  var out = rows.slice(0);
  out.sort(function (a, b) {
    return (Number(b[field]) || 0) - (Number(a[field]) || 0);
  });
  return out;
}

function statusClass(status) {
  if (status === "flagged_discrepancy") return "flag";
  if (status === "verify_failed") return "bad";
  if (status === "applied") return "good";
  return "muted";
}

function barRows(rows, field, limit, meatMode) {
  var sorted = copySorted(rows, field);
  var max = sorted.length ? Number(sorted[0][field]) || 1 : 1;
  var html = [];
  var count = Math.min(limit || 10, sorted.length);
  var i;

  if (!count) {
    return "<div class='empty'>No sales data.</div>";
  }

  for (i = 0; i < count; i++) {
    var row = sorted[i];
    var value = Number(row[field]) || 0;
    var width = Math.max(2, Math.round((value / max) * 100));

    html.push("<div class='barrow'>");
    html.push("<div class='barlabel' title='" + esc(row.label) + "'>" + esc(row.label) + "</div>");
    html.push("<div class='bartrack'><div class='barfill' style='width:" + width + "%'></div></div>");
    html.push("<div class='barvalue'>" + (meatMode ? number(value) + " Meat" : number(value)) + "</div>");
    html.push("</div>");
  }

  return html.join("");
}

function buyerTable(rows, sortField) {
  var sorted = copySorted(rows, sortField);
  var html = [
    "<div class='tablewrap compact'><table><thead><tr>",
    "<th>Player</th><th>Items Purchased</th><th>Transactions</th><th>Total Meat</th>",
    "</tr></thead><tbody>"
  ];
  var i;

  for (i = 0; i < sorted.length; i++) {
    var row = sorted[i];
    html.push(
      "<tr><td class='name'>" +
        esc(row.label) +
        "</td><td>" +
        number(row.units) +
        "</td><td>" +
        number(row.transactions) +
        "</td><td>" +
        number(row.meat) +
        "</td></tr>"
    );
  }

  html.push("</tbody></table></div>");
  return html.join("");
}

function itemSummaryTable(rows, sortField) {
  var sorted = copySorted(rows, sortField);
  var html = [
    "<div class='tablewrap compact'><table><thead><tr>",
    "<th>Item</th><th>Total Sold</th><th>Transactions</th><th>Total Meat</th><th>Average Price</th>",
    "</tr></thead><tbody>"
  ];
  var i;

  for (i = 0; i < sorted.length; i++) {
    var row = sorted[i];
    html.push(
      "<tr><td class='name'>" +
        esc(row.label) +
        "</td><td>" +
        number(row.units) +
        "</td><td>" +
        number(row.transactions) +
        "</td><td>" +
        number(row.meat) +
        "</td><td>" +
        number(row.averagePrice) +
        "</td></tr>"
    );
  }

  html.push("</tbody></table></div>");
  return html.join("");
}

function trendRows(rows, field, meatMode) {
  if (!rows.length) return "<div class='empty'>No dated sales data.</div>";

  var max = 1;
  var i;
  for (i = 0; i < rows.length; i++) {
    max = Math.max(max, Number(rows[i][field]) || 0);
  }

  var html = [];
  for (i = 0; i < rows.length; i++) {
    var row = rows[i];
    var value = Number(row[field]) || 0;
    var width = Math.max(2, Math.round((value / max) * 100));

    html.push("<div class='trendrow'>");
    html.push("<div class='trenddate'>" + esc(row.label) + "</div>");
    html.push("<div class='trendtrack'><div class='trendfill' style='width:" + width + "%'></div></div>");
    html.push("<div class='trendvalue'>" + (meatMode ? number(value) + " Meat" : number(value)) + "</div>");
    html.push("</div>");
  }

  return html.join("");
}

function renderPage(notice, needsRecentConfirm) {
  var state = repricer.getRunState();
  var settings = repricer.getSafetySettings();
  var changes = repricer.readChangeLog(200);
  var lastResult = k.getProperty("storeRepriceLastResult");
  var flaggedCount = 0;
  var salesFetch;
  var currentSales = [];
  var historyRows = [];
  var historyAdded = 0;
  var salesError = "";
  var i;

  try {
    salesFetch = fetchCurrentSales();
    currentSales = salesFetch.rows;

    if (!salesFetch.recognized) {
      salesError =
        "KoL's which=3 backoffice page loaded, but the Recent Store Activity section was not recognized.";
    } else {
      var merged = mergeSalesHistory(currentSales);
      historyRows = merged.rows;
      historyAdded = merged.added;
    }
  } catch (e) {
    salesError = "Sales refresh failed: " + String(e);
  }

  if (!historyRows.length) historyRows = readSalesHistory();

  var currentStats = aggregateSales(currentSales);
  var historyStats = aggregateSales(historyRows);
  var historyBuyersByMeat = copySorted(historyStats.buyers, "meat");
  var historyItemsByMeat = copySorted(historyStats.items, "meat");

  for (i = 0; i < changes.length; i++) {
    if (changes[i].status === "flagged_discrepancy") flaggedCount++;
  }

  var html = [];
  var refreshNonce = String(k.nowToInt());

  html.push("<!doctype html><html><head><meta charset='utf-8'>");
  html.push("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html.push("<meta http-equiv='Cache-Control' content='no-store, no-cache, must-revalidate'>");
  html.push("<meta http-equiv='Pragma' content='no-cache'>");
  html.push("<title>Mall Manager</title><style>");

  html.push(":root{--bg:#111315;--panel:#181b1f;--panel2:#20242a;--line:#343a42;--text:#f4f4f4;--muted:#a8b0ba;--accent:#8ec7ff;--good:#65d38e;--warn:#ffd166;--bad:#ff7b72;--bar:#75baff}");
  html.push("*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#15181c,#0f1113 420px);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}");
  html.push(".wrap{max-width:1380px;margin:0 auto;padding:24px}.hero{padding:6px 0 18px}.hero h1{font-size:34px;letter-spacing:-.03em;margin:0}.sub{color:var(--muted);margin-top:5px}");
  html.push(".actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 18px}.inline{display:inline}.btn,button{appearance:none;border:1px solid #4a90d9;background:#1f6fb2;color:#fff;border-radius:7px;padding:9px 13px;font-weight:700;cursor:pointer;text-decoration:none;font:inherit}.secondary{background:#2a3037;border-color:#4a525d}.danger{background:#8e2f2a;border-color:#c34d45}");
  html.push(".notice{padding:12px 14px;border:1px solid #35587a;border-radius:9px;background:#172838;margin:12px 0}.warning{border-color:#705d22;background:#302a16}.error{border-color:#7a3535;background:#331d1d}");
  html.push(".summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:14px 0 24px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px}.label{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:var(--muted)}.metric{font-size:25px;font-weight:800;margin-top:4px}");
  html.push(".section{background:var(--panel);border:1px solid var(--line);border-radius:11px;margin:18px 0;overflow:hidden}.sectionhead{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center}.sectionhead h2{font-size:18px;margin:0}.sectionbody{padding:16px}");
  html.push(".twocol{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{background:var(--panel2);border:1px solid #30363d;border-radius:9px;padding:14px}.panel h3{margin:0 0 12px;font-size:15px}.charttitle{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px}");
  html.push(".barrow{display:grid;grid-template-columns:minmax(110px,1.2fr) minmax(120px,2fr) auto;gap:8px;align-items:center;margin:7px 0}.barlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bartrack,.trendtrack{height:10px;background:#101317;border-radius:99px;overflow:hidden;border:1px solid #2d333b}.barfill,.trendfill{height:100%;background:linear-gradient(90deg,#4a9fe6,#8cc9ff)}.barvalue,.trendvalue{text-align:right;font-variant-numeric:tabular-nums;color:#dbe9f8}");
  html.push(".trendrow{display:grid;grid-template-columns:95px minmax(140px,1fr) 120px;gap:9px;align-items:center;margin:8px 0}.trenddate{font-variant-numeric:tabular-nums;color:var(--muted)}");
  html.push(".tablewrap{overflow:auto;max-height:520px;border:1px solid #30363d;border-radius:7px}.tablewrap.compact{max-height:350px;margin-top:14px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #2b3138;white-space:nowrap;font-variant-numeric:tabular-nums}th{position:sticky;top:0;background:#252a31;color:#dfe6ee;z-index:2;font-size:12px}td.name{white-space:normal;min-width:180px}tbody tr:hover{background:#20262d}");
  html.push(".good{color:var(--good);font-weight:700}.bad{color:var(--bad);font-weight:700}.flag{color:var(--warn);font-weight:800}.flagrow{background:#302b18}.muted,.tiny{color:var(--muted)}.tiny{font-size:12px}.empty{color:var(--muted);padding:12px 2px}.divider{height:1px;background:var(--line);margin:18px 0}");
  html.push(".search{width:min(420px,100%);background:#101317;color:#fff;border:1px solid #414851;border-radius:7px;padding:9px 11px}.kicker{font-size:12px;color:var(--muted);margin-top:3px}");
  html.push("@media(max-width:950px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.twocol{grid-template-columns:1fr}.wrap{padding:14px}.barrow{grid-template-columns:minmax(90px,1fr) minmax(90px,1.5fr) auto}}");
  html.push("</style></head><body><div class='wrap'>");

  html.push("<div class='hero'><h1>Mall Manager</h1>");
  html.push("<div class='sub'>KoL mall repricing + Pricegun discrepancy safety + local sales analytics.</div></div>");

  if (notice) html.push("<div class='notice'>" + esc(notice) + "</div>");
  if (salesError) html.push("<div class='notice error'><b>Sales data:</b> " + esc(salesError) + "</div>");

  if (needsRecentConfirm) {
    html.push("<div class='notice warning'><b>24-hour guard:</b> this repricer completed " + esc(repricer.formatDuration(state.ageMs)) + " ago. Run again anyway?");
    html.push("<form method='post' action='" + SELF + "' style='margin-top:10px'>");
    html.push("<input type='hidden' name='action' value='run'><input type='hidden' name='confirm_recent' value='1'>");
    html.push("<button class='danger' type='submit'>Yes, run again</button></form></div>");
  }

  html.push("<div class='actions'>");
  html.push("<form class='inline' method='get' action='" + SELF + "'>");
  html.push("<input type='hidden' name='action' value='refresh'><input type='hidden' name='nonce' value='" + esc(refreshNonce) + "'>");
  html.push("<button type='submit'>Refresh sales dashboard</button></form>");
  html.push("<form class='inline' method='post' action='" + SELF + "'><input type='hidden' name='action' value='run'><button type='submit'>Run repricer now</button></form>");
  html.push("<a class='btn secondary' href='/backoffice.php?which=3'>Native store log</a>");
  html.push("<a class='btn secondary' href='/backoffice.php?which=1'>Store inventory</a>");
  html.push("</div>");

  html.push("<div class='section'><div class='sectionhead'><div><h2>Sales overview</h2>");
  html.push("<div class='kicker'>Saved locally from KoL's rolling Store Log (which=3). " + number(historyAdded) + " new transaction(s) captured on this refresh.</div></div></div><div class='sectionbody'>");

  html.push("<div class='summary'>");
  html.push("<div class='card'><div class='label'>Items sold</div><div class='metric'>" + number(historyStats.totals.units) + "</div></div>");
  html.push("<div class='card'><div class='label'>Unique buyers</div><div class='metric'>" + number(historyStats.totals.buyers) + "</div></div>");
  html.push("<div class='card'><div class='label'>Transactions</div><div class='metric'>" + number(historyStats.totals.transactions) + "</div></div>");
  html.push("<div class='card'><div class='label'>Total Meat</div><div class='metric'>" + number(historyStats.totals.meat) + "</div></div>");
  html.push("<div class='card'><div class='label'>Distinct items</div><div class='metric'>" + number(historyStats.totals.items) + "</div></div>");
  html.push("</div>");

  html.push("<div class='tiny'>Current KoL two-week window: " + number(currentStats.totals.units) + " items · " + number(currentStats.totals.buyers) + " buyers · " + number(currentStats.totals.transactions) + " transactions · " + number(currentStats.totals.meat) + " Meat.</div>");
  html.push("</div></div>");

  html.push("<div class='twocol'>");

  html.push("<div class='panel'><h3>Top Buyers By Items Purchased</h3>");
  html.push(barRows(historyStats.buyers, "units", 10, false));
  html.push("<div class='charttitle' style='margin-top:18px'>All Buyers By Items Purchased</div>");
  html.push(buyerTable(historyStats.buyers, "units"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Items Sold</h3>");
  html.push(barRows(historyStats.items, "units", 10, false));
  html.push("<div class='charttitle' style='margin-top:18px'>All Items Sold</div>");
  html.push(itemSummaryTable(historyStats.items, "units"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Buyers By Meat</h3>");
  html.push(barRows(historyBuyersByMeat, "meat", 10, true));
  html.push("<div class='charttitle' style='margin-top:18px'>All Buyers By Meat</div>");
  html.push(buyerTable(historyBuyersByMeat, "meat"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Items By Meat</h3>");
  html.push(barRows(historyItemsByMeat, "meat", 10, true));
  html.push("<div class='charttitle' style='margin-top:18px'>All Items By Meat</div>");
  html.push(itemSummaryTable(historyItemsByMeat, "meat"));
  html.push("</div>");

  html.push("</div>");

  html.push("<div class='section'><div class='sectionhead'><div><h2>Sales trends</h2><div class='kicker'>Current Store Log supplies the two-week daily view; saved history builds the monthly view over time.</div></div></div><div class='sectionbody'><div class='twocol'>");
  html.push("<div class='panel'><h3>Items Sold Per Day — Current KoL Window</h3>" + trendRows(currentStats.days, "units", false) + "</div>");
  html.push("<div class='panel'><h3>Meat Per Day — Current KoL Window</h3>" + trendRows(currentStats.days, "meat", true) + "</div>");
  html.push("<div class='panel'><h3>Items Sold Per Month — Recorded History</h3>" + trendRows(historyStats.months, "units", false) + "</div>");
  html.push("<div class='panel'><h3>Meat Per Month — Recorded History</h3>" + trendRows(historyStats.months, "meat", true) + "</div>");
  html.push("</div></div></div>");

  html.push("<div class='section'><div class='sectionhead'><div><h2>Complete Sales Details Per Item</h2><div class='kicker'>Same core columns as the Mall Sales Analyzer.</div></div>");
  html.push("<input id='itemSearch' class='search' type='search' placeholder='Search items…' oninput='filterItems()'></div><div class='sectionbody'>");
  html.push("<div class='tablewrap'><table id='itemDetailTable'><thead><tr>");
  html.push("<th>Item</th><th>Total Sold</th><th>Total Transactions</th><th>Avg. Sold Per Trans.</th><th>Total Meat</th><th>Average Price</th>");
  html.push("</tr></thead><tbody>");

  for (i = 0; i < historyStats.items.length; i++) {
    var item = historyStats.items[i];
    html.push("<tr><td class='name'>" + esc(item.label) + "</td>");
    html.push("<td>" + number(item.units) + "</td><td>" + number(item.transactions) + "</td>");
    html.push("<td>" + number(item.averagePerTransaction) + "</td>");
    html.push("<td>" + number(item.meat) + "</td><td>" + number(item.averagePrice) + "</td></tr>");
  }

  if (!historyStats.items.length) {
    html.push("<tr><td colspan='6' class='empty'>No sales history has been captured yet.</td></tr>");
  }

  html.push("</tbody></table></div></div></div>");

  html.push("<div class='section'><div class='sectionhead'><div><h2>Recent Store Transactions</h2><div class='kicker'>Directly parsed from backoffice.php?which=3 on this refresh.</div></div></div><div class='sectionbody'><div class='tablewrap'><table><thead><tr>");
  html.push("<th>Date</th><th>Time</th><th>Player</th><th>Item</th><th>Qty</th><th>Item Price</th><th>Total Meat</th>");
  html.push("</tr></thead><tbody>");

  for (i = 0; i < Math.min(250, currentSales.length); i++) {
    var tx = currentSales[i];
    html.push("<tr><td>" + esc(tx.date) + "</td><td>" + esc(tx.time) + "</td>");
    html.push("<td class='name'>" + esc(tx.player) + "</td><td class='name'>" + esc(tx.item) + "</td>");
    html.push("<td>" + number(tx.quantity) + "</td><td>" + number(tx.itemPrice) + "</td><td>" + number(tx.totalMeat) + "</td></tr>");
  }

  if (!currentSales.length) {
    html.push("<tr><td colspan='7' class='empty'>No transactions parsed from the current Store Log.</td></tr>");
  }

  html.push("</tbody></table></div></div></div>");

  html.push("<div class='section'><div class='sectionhead'><div><h2>Repricing & safety</h2><div class='kicker'>KoLmafia 5th-cheapest mall target with Pricegun discrepancy veto.</div></div></div><div class='sectionbody'>");

  html.push("<div class='summary'>");
  html.push("<div class='card'><div class='label'>Last repricer run</div><div class='metric' style='font-size:16px'>" + esc(dateText(state.lastRunMs)) + "</div></div>");
  html.push("<div class='card'><div class='label'>Recent flags shown</div><div class='metric'>" + number(flaggedCount) + "</div></div>");
  html.push("<div class='card' style='grid-column:span 3'><div class='label'>Last run result</div><div style='margin-top:7px'>" + esc(lastResult || "No completed run yet") + "</div></div>");
  html.push("</div>");

  html.push("<div class='notice warning'><b>Safety rule:</b> normal target = KoLmafia's current 5th-cheapest mall price. Pricegun blocks a change when its recent transaction value is at least <b>" + esc(settings.discrepancyRatio) + "×</b> the mall target and at least <b>" + number(settings.discrepancyMinGap) + " Meat</b> higher, with recent volume ≥ <b>" + number(settings.pricegunMinVolume) + "</b>.</div>");

  html.push("<div class='tablewrap'><table><thead><tr><th>When</th><th>Item</th><th>Qty</th><th>Old</th><th>Mall target</th><th>Pricegun</th><th>PG / Mall</th><th>Applied</th><th>Status</th><th>Source</th></tr></thead><tbody>");

  if (!changes.length) {
    html.push("<tr><td colspan='10' class='empty'>No repricing activity logged yet.</td></tr>");
  } else {
    for (i = 0; i < changes.length; i++) {
      var c = changes[i];
      var rowClass = c.status === "flagged_discrepancy" ? " class='flagrow'" : "";

      html.push("<tr" + rowClass + ">");
      html.push("<td>" + esc(dateText(c.runMs)) + "</td><td class='name'>" + esc(c.name) + "</td>");
      html.push("<td>" + number(c.qty) + "</td><td>" + number(c.oldPrice) + "</td>");
      html.push("<td>" + (c.marketPrice ? number(c.marketPrice) : number(c.targetPrice)) + "</td>");
      html.push("<td>" + (c.pricegunValue ? number(c.pricegunValue) : "—") + "</td>");
      html.push("<td>" + ratio(c.discrepancyRatio) + "</td><td>" + number(c.appliedPrice) + "</td>");
      html.push("<td class='" + statusClass(c.status) + "'>" + esc(c.status) + "</td>");
      html.push("<td class='tiny'>" + esc(c.source || "") + "</td></tr>");
    }
  }

  html.push("</tbody></table></div></div></div>");

  html.push("<div class='tiny'>Sales refreshes only KoL's Store Log and local history. It does not poll Pricegun or refresh mall prices. Pricegun/network price checks happen only when you explicitly run repricing or mall-clean.</div>");

  html.push("<script>");
  html.push("function filterItems(){var q=(document.getElementById('itemSearch').value||'').toLowerCase();var rows=document.querySelectorAll('#itemDetailTable tbody tr');for(var i=0;i<rows.length;i++){var t=(rows[i].textContent||'').toLowerCase();rows[i].style.display=t.indexOf(q)>=0?'':'none';}}");
  html.push("</script>");

  html.push("</div></body></html>");

  k.write(html.join(""));
}

module.exports.parseBackofficeSales = parseBackofficeSales;
module.exports.aggregateSales = aggregateSales;

module.exports.main = function main() {
  var fields = k.formFields();
  var action = fields && fields.action ? String(fields.action) : "";
  var notice = "";
  var needsRecentConfirm = false;

  if (action === "refresh") {
    notice = "Sales dashboard refreshed from KoL Store Log.";
  }

  if (action === "run") {
    var state = repricer.getRunState();
    var confirmed = fields && String(fields.confirm_recent || "") === "1";

    if (state.recent && !confirmed) {
      needsRecentConfirm = true;
    } else {
      var result = repricer.runReprice(confirmed);
      notice =
        result && result.message ? result.message : "Repricer finished.";
    }
  }

  renderPage(notice, needsRecentConfirm);
};
