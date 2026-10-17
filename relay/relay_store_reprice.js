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

var SALES_CURRENT_FILE = "mall-manager-sales-current.csv";
var SALES_HISTORY_FILE = "mall-manager-sales.csv";
var BACKOFFICE_DEBUG_FILE = "mall-manager-backoffice-debug.html";
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

function safeFileLines(filename) {
  try {
    return numericLines(k.fileToArray(filename));
  } catch (e) {
    return [];
  }
}

function sampleLines(lines, headCount, tailCount) {
  if (!lines || !lines.length) return "";

  headCount = Math.max(0, Number(headCount) || 0);
  tailCount = Math.max(0, Number(tailCount) || 0);

  if (lines.length <= headCount + tailCount) {
    return lines.join("\n");
  }

  var out = lines.slice(0, headCount);
  out.push(
    "... " +
      number(lines.length - headCount - tailCount) +
      " line(s) omitted ..."
  );

  if (tailCount > 0) {
    out = out.concat(lines.slice(lines.length - tailCount));
  }

  return out.join("\n");
}

function debugHtmlExcerpt(lines) {
  var text = (lines || []).join("\n");
  if (!text) return "";

  var lower = text.toLowerCase();
  var at = lower.indexOf("bought");

  if (at >= 0) {
    var start = Math.max(0, at - 12000);
    var end = Math.min(text.length, at + 60000);
    return text.substring(start, end);
  }

  return text.substring(0, Math.min(text.length, 70000));
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
    normalizeDate(tx.date),
    tx.time,
    tx.player,
    tx.item,
    tx.quantity,
    tx.totalMeat
  ].join("|");
}

function parseCsvLine(line) {
  var fields = [];
  var field = "";
  var quoted = false;
  var i;

  for (i = 0; i < line.length; i++) {
    var ch = line.charAt(i);

    if (quoted) {
      if (ch === '"') {
        if (i + 1 < line.length && line.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }

  fields.push(field);
  return fields;
}

function csvEscape(value) {
  return '"' + String(value === undefined || value === null ? "" : value)
    .replace(/"/g, '""') + '"';
}

function salesCsvRow(tx) {
  return [
    csvEscape(tx.date),
    csvEscape(tx.time),
    csvEscape(tx.player),
    csvEscape(tx.item),
    Math.round(Number(tx.quantity) || 0),
    Math.round(Number(tx.itemPrice) || 0),
    Math.round(Number(tx.totalMeat) || 0)
  ].join(",");
}

function readSalesCsv(filename) {
  var lines = numericLines(k.fileToArray(filename));
  var rows = [];
  var i;

  for (i = 0; i < lines.length; i++) {
    var line = String(lines[i] || "");
    if (!line) continue;

    var p = parseCsvLine(line);

    if (
      i === 0 &&
      p.length >= 7 &&
      trim(p[0]).toLowerCase() === "date" &&
      trim(p[3]).toLowerCase() === "item"
    ) {
      continue;
    }

    if (p.length < 7) continue;

    var quantity = parseIntLoose(p[4]);
    var itemPrice = parseIntLoose(p[5]);
    var totalMeat = parseIntLoose(p[6]);

    if (!p[0] || !p[2] || !p[3] || quantity <= 0 || totalMeat < 0) {
      continue;
    }

    rows.push({
      date: trim(p[0]),
      time: trim(p[1]),
      player: decodeBasicHtml(trim(p[2])),
      item: decodeBasicHtml(trim(p[3])),
      quantity: quantity,
      itemPrice: itemPrice,
      totalMeat: totalMeat
    });
  }

  return rows;
}

function writeSalesCsv(filename, rows) {
  var lines = [
    '"Date","Time","Player","Item","Quantity","Item Price","Total Meat"'
  ];
  var i;

  for (i = 0; i < rows.length; i++) {
    lines.push(salesCsvRow(rows[i]));
  }

  return k.bufferToFile(lines.join("\n") + "\n", filename);
}

function parseCapturedBackofficeHtml(html) {
  var text = decodeBasicHtml(
    String(html || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  );

  var lines = text.split(/\r?\n/);
  var rows = [];
  var saleRe =
    /(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(\d{1,2}:\d{2}:\d{2})\s+(.+?)\s+bought\s+([\d,]+)\s+\((.*)\)\s+for\s+([\d,]+)\s+Meat\.?\s*$/i;
  var i;

  for (i = 0; i < lines.length; i++) {
    var line = trim(String(lines[i] || "").replace(/\s+/g, " "));
    if (!line) continue;

    var m = saleRe.exec(line);
    if (!m) continue;

    var quantity = parseIntLoose(m[4]);
    var totalMeat = parseIntLoose(m[6]);

    if (!quantity || totalMeat < 0) continue;

    rows.push({
      date: trim(m[1]),
      time: trim(m[2]),
      player: trim(m[3]),
      item: trim(m[5]),
      quantity: quantity,
      itemPrice: Math.round(totalMeat / quantity),
      totalMeat: totalMeat
    });
  }

  return rows;
}

function readCapturedBackofficeSales(lines) {
  return parseCapturedBackofficeHtml((lines || []).join("\n"));
}

function writeCurrentSalesFromCapture(rows) {
  if (!rows || !rows.length) return false;

  var ok = writeSalesCsv(SALES_CURRENT_FILE, rows);

  if (ok && k.setProperty) {
    k.setProperty("mallManagerSalesLastCaptureMs", String(k.nowToInt()));
    k.setProperty("mallManagerSalesLastCaptureCount", String(rows.length));
    k.setProperty("mallManagerSalesLastRelayParsedCount", String(rows.length));
  }

  return ok;
}

function readCurrentSales() {
  return readSalesCsv(SALES_CURRENT_FILE);
}

function readSalesHistory() {
  return readSalesCsv(SALES_HISTORY_FILE);
}

function mergeSalesHistory(currentRows) {
  var history = readSalesHistory();
  var historyCounts = {};
  var currentSeen = {};
  var i;

  for (i = 0; i < history.length; i++) {
    var hb = transactionBaseKey(history[i]);
    historyCounts[hb] = (historyCounts[hb] || 0) + 1;
  }

  var added = 0;

  for (i = 0; i < currentRows.length; i++) {
    var base = transactionBaseKey(currentRows[i]);
    var occurrence = currentSeen[base] || 0;
    currentSeen[base] = occurrence + 1;

    if (occurrence < (historyCounts[base] || 0)) {
      continue;
    }

    history.push(currentRows[i]);
    historyCounts[base] = (historyCounts[base] || 0) + 1;
    added++;
  }

  if (added > 0) {
    history.sort(function (a, b) {
      var da = dateSortKey(a.date);
      var db = dateSortKey(b.date);
      if (da !== db) return db - da;
      if (a.time !== b.time) return a.time < b.time ? 1 : -1;

      var ak = transactionBaseKey(a);
      var bk = transactionBaseKey(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });

    if (history.length > SALES_HISTORY_MAX_ROWS) {
      history = history.slice(0, SALES_HISTORY_MAX_ROWS);
    }

    writeSalesCsv(SALES_HISTORY_FILE, history);
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

var PIE_COLORS = [
  "#6d5a5d",
  "#786166",
  "#5d5057",
  "#84686c",
  "#66565d",
  "#725b62",
  "#5a4c53",
  "#8b6c70",
  "#625159",
  "#765f65"
];

function pieSeries(rows, valueKey, maxSlices) {
  var sorted = copySorted(rows || [], valueKey);
  var keep = Math.max(1, Number(maxSlices) || 10);
  var out = sorted.slice(0, keep);
  var i;

  if (sorted.length > keep) {
    var other = {
      label: "Other",
      units: 0,
      transactions: 0,
      meat: 0
    };

    for (i = keep; i < sorted.length; i++) {
      other.units += Number(sorted[i].units || 0);
      other.transactions += Number(sorted[i].transactions || 0);
      other.meat += Number(sorted[i].meat || 0);
    }

    out.push(other);
  }

  return out;
}

function polarPoint(cx, cy, radius, degrees) {
  var radians = (degrees - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians)
  };
}

function annularSectorPath(cx, cy, innerRadius, outerRadius, startDeg, endDeg) {
  var outerStart = polarPoint(cx, cy, outerRadius, startDeg);
  var outerEnd = polarPoint(cx, cy, outerRadius, endDeg);
  var innerEnd = polarPoint(cx, cy, innerRadius, endDeg);
  var innerStart = polarPoint(cx, cy, innerRadius, startDeg);
  var largeArc = endDeg - startDeg > 180 ? 1 : 0;

  return [
    "M", outerStart.x.toFixed(2), outerStart.y.toFixed(2),
    "A", outerRadius, outerRadius, 0, largeArc, 1,
      outerEnd.x.toFixed(2), outerEnd.y.toFixed(2),
    "L", innerEnd.x.toFixed(2), innerEnd.y.toFixed(2),
    "A", innerRadius, innerRadius, 0, largeArc, 0,
      innerStart.x.toFixed(2), innerStart.y.toFixed(2),
    "Z"
  ].join(" ");
}

function renderExplodedPie(title, rows, valueKey, centerLabel) {
  var series = pieSeries(rows, valueKey, 9);
  var total = 0;
  var i;

  for (i = 0; i < series.length; i++) {
    total += Number(series[i][valueKey] || 0);
  }

  var html = [];
  html.push("<div class='piecard'>");
  if (title) html.push("<div class='pieheading'>" + esc(title) + "</div>");

  if (!series.length || total <= 0) {
    html.push("<div class='empty'>No chart data.</div></div>");
    return html.join("");
  }

  var cx = 130;
  var cy = 130;
  var innerRadius = 71;
  var outerRadius = 108;
  var current = 0;

  html.push("<div class='piebody'>");
  html.push("<div class='piewrap'>");
  html.push("<svg class='explodedpie' viewBox='0 0 260 260' role='img' aria-label='" + esc(title) + "'>");
  html.push("<defs><filter id='pieShadow' x='-30%' y='-30%' width='160%' height='160%'><feDropShadow dx='0' dy='4' stdDeviation='4' flood-opacity='.28'/></filter></defs>");
  html.push("<circle class='piebasehalo' cx='130' cy='130' r='82'></circle>");
  html.push("<circle class='piebase' cx='130' cy='130' r='76'></circle>");

  for (i = 0; i < series.length; i++) {
    var row = series[i];
    var value = Number(row[valueKey] || 0);
    var fraction = value / total;
    var sweep = fraction * 360;
    var gap = Math.min(5.5, Math.max(1.4, sweep * 0.16));
    var start = current + gap / 2;
    var end = current + sweep - gap / 2;

    if (end <= start) {
      start = current;
      end = current + sweep;
    }

    var mid = current + sweep / 2;
    var unit = polarPoint(0, 0, 1, mid);
    var baseOffset = 6;
    var dx = unit.x * baseOffset;
    var dy = unit.y * baseOffset;
    var color = PIE_COLORS[i % PIE_COLORS.length];
    var label = row.label || "Unknown";
    var pct = (fraction * 100).toFixed(1);

    html.push(
      "<g class='pieslice' " +
      "transform='translate(" + dx.toFixed(2) + " " + dy.toFixed(2) + ")' " +
      "data-base-x='" + dx.toFixed(2) + "' " +
      "data-base-y='" + dy.toFixed(2) + "' " +
      "data-label='" + esc(label) + "' " +
      "data-value='" + esc(value) + "' " +
      "data-total='" + esc(total) + "' " +
      "data-pct='" + esc(pct) + "' " +
      "tabindex='0' " +
      "onmouseenter='pieEnter(this,event)' " +
      "onmousemove='pieMove(this,event)' " +
      "onmouseleave='pieLeave(this)' " +
      "onclick='piePin(this,event)' " +
      "onfocus='pieFocus(this)' " +
      "onblur='pieBlur(this)'>" +
      "<title>" + esc(label) + ": " + number(value) + " (" + pct + "%)</title>" +
      "<path d='" + annularSectorPath(cx, cy, innerRadius, outerRadius, start, end) + "' fill='" + color + "'></path>" +
      "</g>"
    );

    current += sweep;
  }

  html.push("<circle class='piecenter' cx='130' cy='130' r='52'></circle>");
  html.push("<text class='piecentervalue' x='130' y='126' text-anchor='middle' fill='#f1f3ec' style='fill:#f1f3ec!important;color:#f1f3ec!important;-webkit-text-fill-color:#f1f3ec!important'>" + number(total) + "</text>");
  html.push("<text class='piecenterlabel' x='130' y='145' text-anchor='middle' fill='#ddb76d' style='fill:#ddb76d!important;color:#ddb76d!important;-webkit-text-fill-color:#ddb76d!important'>" + esc(centerLabel) + "</text>");
  html.push("</svg>");
  html.push("</div>");

  html.push("<div class='pielegend'>");
  for (i = 0; i < series.length; i++) {
    var legendRow = series[i];
    var legendValue = Number(legendRow[valueKey] || 0);
    var legendPct = total ? (legendValue / total * 100).toFixed(1) : "0.0";
    html.push(
      "<div class='pielegendrow'>" +
      "<span class='pielegenddot' style='background:" + PIE_COLORS[i % PIE_COLORS.length] + "'></span>" +
      "<span class='pielegendlabel' title='" + esc(legendRow.label || "Unknown") + "'>" + esc(legendRow.label || "Unknown") + "</span>" +
      "<span class='pielegendvalue'>" + number(legendValue) + "</span>" +
      "<span class='pielegendpct'>" + legendPct + "%</span>" +
      "</div>"
    );
  }
  html.push("</div>");
  html.push("</div></div>");

  return html.join("");
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
  var currentSales = [];
  var historyRows = [];
  var historyAdded = 0;
  var salesError = "";
  var i;
  var lastCaptureMs = Number(k.getProperty("mallManagerSalesLastCaptureMs")) || 0;
  var lastCaptureCount =
    Number(k.getProperty("mallManagerSalesLastCaptureCount")) || 0;
  var lastHookMs = Number(k.getProperty("mallManagerSalesLastHookMs")) || 0;
  var lastHookPageChars =
    Number(k.getProperty("mallManagerSalesLastHookPageChars")) || 0;
  var lastHookParsedCount =
    Number(k.getProperty("mallManagerSalesLastHookParsedCount")) || 0;
  var lastRelayParsedCount =
    Number(k.getProperty("mallManagerSalesLastRelayParsedCount")) || 0;
  var lastHookLookedLikeStoreLog =
    String(k.getProperty("mallManagerSalesLastHookLookedLikeStoreLog") || "");
  var lastHookWriteOk =
    String(k.getProperty("mallManagerSalesLastHookWriteOk") || "");
  var currentRawLines = safeFileLines(SALES_CURRENT_FILE);
  var historyRawLines = safeFileLines(SALES_HISTORY_FILE);
  var backofficeDebugLines = safeFileLines(BACKOFFICE_DEBUG_FILE);

  try {
    var relayParsedSales = readCapturedBackofficeSales(backofficeDebugLines);

    if (relayParsedSales.length) {
      writeCurrentSalesFromCapture(relayParsedSales);
      currentSales = relayParsedSales;
      lastRelayParsedCount = relayParsedSales.length;
      lastCaptureMs = Number(k.getProperty("mallManagerSalesLastCaptureMs")) || lastCaptureMs;
      lastCaptureCount = relayParsedSales.length;
      currentRawLines = safeFileLines(SALES_CURRENT_FILE);
    } else {
      currentSales = readCurrentSales();
    }

    if (currentSales.length) {
      var merged = mergeSalesHistory(currentSales);
      historyRows = merged.rows;
      historyAdded = merged.added;
      historyRawLines = safeFileLines(SALES_HISTORY_FILE);
    } else {
      historyRows = readSalesHistory();

      if (!backofficeDebugLines.length) {
        salesError =
          "No Store Log capture exists yet. Use Refresh sales dashboard.";
      } else {
        salesError =
          "The Store Log capture exists, but the relay parser found 0 transactions. Export HTML and send me that file.";
      }
    }
  } catch (e) {
    salesError =
      "Sales CSV read/merge failed: " +
      String(e) +
      ". Existing data/" +
      SALES_HISTORY_FILE +
      " is left untouched.";
    historyRows = readSalesHistory();
  }

  var currentStats = aggregateSales(currentSales);
  var historyStats = aggregateSales(historyRows);
  var historyBuyersByMeat = copySorted(historyStats.buyers, "meat");
  var historyItemsByMeat = copySorted(historyStats.items, "meat");

  for (i = 0; i < changes.length; i++) {
    if (changes[i].status === "flagged_discrepancy") flaggedCount++;
  }

  var html = [];

  html.push("<!doctype html><html><head><meta charset='utf-8'>");
  html.push("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html.push("<meta name='color-scheme' content='dark'>");
  html.push("<meta name='theme-color' content='#0b100d'>");
  html.push("<meta name='darkreader-lock'>");
  html.push("<meta http-equiv='Cache-Control' content='no-store, no-cache, must-revalidate'>");
  html.push("<meta http-equiv='Pragma' content='no-cache'>");
  html.push("<title>Mall Manager</title><style>");

  html.push(":root{color-scheme:dark;--bg:#0b100d;--panel:#111813;--panel2:#151f18;--well:#080c09;--line:#2b392f;--line2:#202a24;--text:#f1f3ec;--soft:#cfd7cf;--muted:#929e95;--accent:#a6d84b;--accent-strong:#b8e75f;--accent-ink:#122006;--gold:#ddb76d;--blue:#80b9c9;--good:#77d39a;--warn:#e4bd70;--bad:#eb7b72;--radius:16px;--shadow:0 24px 70px rgba(0,0,0,.22);--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;--serif:Georgia,'Times New Roman',serif}");
  html.push("*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(780px 520px at 8% -8%,rgba(166,216,75,.08),transparent 62%),radial-gradient(720px 520px at 96% 0%,rgba(221,183,109,.06),transparent 64%),var(--bg);color:var(--text);font:14px/1.52 var(--sans)}button,input,select,textarea{font:inherit}::selection{background:var(--accent);color:var(--accent-ink)}");
  html.push(".wrap{width:min(94vw,1540px);margin-inline:auto}.topbar{position:sticky;top:0;z-index:80;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(11,16,13,.9);backdrop-filter:blur(18px)}.topbar-inner{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:flex;align-items:center;gap:11px;min-width:0}.brandmark{width:30px;aspect-ratio:1;border:1px solid #ffffff5a;border-radius:50%;position:relative;flex:none}.brandmark:after{content:'';position:absolute;width:8px;height:8px;border-radius:50%;right:-1px;bottom:2px;background:var(--accent);box-shadow:0 0 14px rgba(166,216,75,.55)}.brandcopy b{display:block;font-size:14px;letter-spacing:-.02em}.brandcopy span{display:block;color:var(--muted);font:10px/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;margin-top:2px}");
  html.push(".actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0}.inline{display:inline}.btn,button{appearance:none;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:999px;padding:8px 12px;font-weight:760;cursor:pointer;text-decoration:none;transition:transform .16s ease,border-color .16s ease,background .16s ease,color .16s ease}.btn:hover,button:hover{transform:translateY(-1px);border-color:#ffffff55}.actions>button:first-child{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.secondary{background:transparent!important;color:var(--soft)!important}.danger{background:#7d312e;border-color:#a84742}.actions .tiny{font:10px var(--mono);color:var(--muted)}");
  html.push(".main{padding:0 0 70px}.hero{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(300px,1fr);gap:34px 54px;align-items:end;padding:58px 0 34px;border-bottom:1px solid rgba(255,255,255,.08)}.eyebrow{font:800 10px/1.4 var(--mono);letter-spacing:.17em;text-transform:uppercase;color:var(--accent);margin-bottom:13px}.hero h1{font:500 clamp(44px,6vw,86px)/.92 var(--serif);letter-spacing:-.055em;margin:0}.hero h1 span{color:var(--accent);font-style:normal;font-weight:500}.hero p{max-width:44rem;margin:16px 0 0;color:var(--soft);font-size:clamp(15px,1.25vw,19px);line-height:1.6}.hero-side{border-left:1px solid var(--line);padding-left:24px;display:grid;gap:14px}.hero-side .hero-label{font:800 10px var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}.hero-side .hero-value{font:850 clamp(30px,4vw,54px)/1 var(--mono);letter-spacing:-.05em;color:var(--gold)}.hero-side .hero-meta{color:var(--muted);font:11px/1.6 var(--mono)}");
  html.push(".notice{padding:12px 14px;border:1px solid #355841;border-radius:12px;background:#111b14;margin:16px 0}.warning{border-color:#66572e;background:#1e1a10}.error{border-color:#6f3835;background:#251614}");
  html.push(".section{margin:22px 0;border-top:1px solid rgba(255,255,255,.085);padding-top:26px}.sectionhead{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:20px;align-items:end;margin-bottom:16px}.sectionhead h2{font:500 clamp(24px,2.8vw,40px)/1 var(--serif);letter-spacing:-.04em;margin:0}.sectionhead .kicker{justify-self:end;max-width:37rem;text-align:right}.sectionbody{padding:0}.kicker{font-size:12px;color:var(--muted)}");
  html.push(".summary{display:grid;grid-template-columns:minmax(250px,1.618fr) repeat(4,minmax(0,1fr));gap:10px;margin:14px 0 18px}.card{background:linear-gradient(145deg,rgba(21,31,24,.97),rgba(14,22,17,.97));border:1px solid var(--line);border-radius:var(--radius);padding:15px;box-shadow:0 14px 40px rgba(0,0,0,.10)}.summary .card:first-child{background:linear-gradient(145deg,#182417,#111a13);border-color:#3d5037}.label{text-transform:uppercase;letter-spacing:.11em;font:800 9px/1.4 var(--mono);color:var(--muted)}.metric{font:850 clamp(22px,2.3vw,34px)/1.05 var(--mono);letter-spacing:-.045em;margin-top:7px}.summary .card:first-child .metric{color:var(--accent-strong)}");
  html.push(".debuggrid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin:12px 0}.debugbox{background:var(--well);border:1px solid var(--line2);border-radius:10px;padding:9px}.debugbox b{display:block;font:800 8px var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}.tiny{font-size:11px;color:var(--muted)}");
  html.push(".analytics-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:linear-gradient(145deg,rgba(17,24,19,.98),rgba(13,19,15,.98));border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:0 16px 48px rgba(0,0,0,.12)}.panel h3{margin:0 0 12px;font:760 14px/1.25 var(--sans);letter-spacing:-.01em}.charttitle{font:800 9px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:18px 0 10px}");
  html.push(".barrow{display:grid;grid-template-columns:minmax(105px,1.15fr) minmax(120px,2fr) auto;gap:8px;align-items:center;margin:7px 0}.barlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.bartrack,.trendtrack{height:8px;background:#090d0a;border-radius:99px;overflow:hidden;border:1px solid #354037}.barfill,.trendfill{height:100%;background:linear-gradient(90deg,var(--accent),#6ea98d)}.barvalue,.trendvalue{text-align:right;font:750 11px var(--mono);color:var(--soft)}.trendrow{display:grid;grid-template-columns:95px minmax(140px,1fr) 118px;gap:9px;align-items:center;margin:8px 0}.trenddate{font:11px var(--mono);color:var(--muted)}");
  html.push(".tablewrap{overflow:auto;max-height:520px;border:1px solid var(--line2);border-radius:11px;background:var(--well)}.tablewrap.compact{max-height:350px;margin-top:12px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line2);white-space:nowrap;font-variant-numeric:tabular-nums}th{position:sticky;top:0;background:#111813;color:var(--muted);z-index:2;font:800 9px var(--mono);letter-spacing:.08em;text-transform:uppercase}td{font-size:12px}td.name{white-space:normal;min-width:180px}tbody tr:hover{background:#151f18}");
  html.push(".good{color:var(--good);font-weight:760}.bad{color:var(--bad);font-weight:760}.flag{color:var(--warn);font-weight:800}.flagrow{background:#211e12}.muted{color:var(--muted)}.empty{color:var(--muted);padding:12px 2px}.divider{height:1px;background:var(--line);margin:18px 0}.search{width:min(420px,100%);background:var(--well);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:9px 13px}");
  html.push(".piecard{background:var(--well);border:1px solid var(--line2);border-radius:13px;padding:14px;margin:0 0 15px}.pieheading{font-size:14px;font-weight:800;margin-bottom:10px}.piebody{display:grid;grid-template-columns:minmax(245px,290px) minmax(0,1fr);gap:12px;align-items:center}.piewrap{min-width:0}.explodedpie{display:block;width:100%;max-width:282px;margin:0 auto;overflow:visible}.piebasehalo{fill:#a6d84b;opacity:.10;filter:drop-shadow(0 0 18px rgba(166,216,75,.25))}.piebase{fill:#334321;stroke:#6f8e3d;stroke-width:1.5}.piecenter{fill:#080c09!important;stroke:#a6d84b!important;stroke-width:3}.piecentervalue{fill:#f1f3ec!important;color:#f1f3ec!important;-webkit-text-fill-color:#f1f3ec!important;font:900 19px var(--mono)}.piecenterlabel{fill:#ddb76d!important;color:#ddb76d!important;-webkit-text-fill-color:#ddb76d!important;font:900 8px var(--mono);text-transform:uppercase;letter-spacing:.10em}.pieslice{cursor:pointer;filter:drop-shadow(0 5px 6px rgba(0,0,0,.24));transition:filter .15s ease}.pieslice path{stroke:#d9ddd6;stroke-width:1.15;stroke-linejoin:round}.pieslice:hover path,.pieslice:focus path,.pieslice.pinned path{stroke:#fff;stroke-width:2}.pielegend{display:flex;flex-direction:column;gap:5px;min-width:0}.pielegendrow{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;gap:7px;align-items:center;padding:5px 7px;border:1px solid var(--line2);border-radius:8px;background:#0c110d}.pielegenddot{width:9px;height:9px;border-radius:50%}.pielegendlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.pielegendvalue{font:800 10px var(--mono)}.pielegendpct{color:var(--muted);font:10px var(--mono);min-width:43px;text-align:right}.pietooltip{position:fixed;z-index:9999;pointer-events:none;display:none;min-width:170px;max-width:280px;padding:10px 12px;border-radius:10px;background:#070a08;border:1px solid #4c5c50;box-shadow:0 18px 46px rgba(0,0,0,.46);color:var(--text)}.pietooltip b{display:block;margin-bottom:4px}");
  html.push("details.debug{margin:22px 0;border-top:1px solid rgba(255,255,255,.08);padding-top:18px}details.debug summary{cursor:pointer;font:800 10px var(--mono);letter-spacing:.10em;text-transform:uppercase;color:var(--muted)}details.debug .sectionbody{padding-top:12px}details.debug pre{white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;background:var(--well);border:1px solid var(--line2);border-radius:10px;padding:10px;color:#d8e0d9;font:11px/1.5 var(--mono)}");
  html.push("@media(max-width:1180px){.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.summary .card:first-child{grid-column:span 2}.piebody{grid-template-columns:1fr}.pielegend{display:grid;grid-template-columns:1fr 1fr}.debuggrid{grid-template-columns:repeat(3,minmax(0,1fr))}}");
  html.push("@media(max-width:900px){.topbar-inner{align-items:flex-start;flex-direction:column;padding:11px 0}.hero{grid-template-columns:1fr;padding-top:42px}.hero-side{border-left:0;border-top:1px solid var(--line);padding:18px 0 0}.sectionhead{grid-template-columns:1fr}.sectionhead .kicker{justify-self:start;text-align:left}.analytics-grid,.twocol{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary .card:first-child{grid-column:span 2}.debuggrid{grid-template-columns:repeat(2,minmax(0,1fr))}.wrap{width:min(94vw,760px)}}");
  html.push("@media(max-width:580px){.summary{grid-template-columns:1fr}.summary .card:first-child{grid-column:auto}.pielegend{grid-template-columns:1fr}.barrow{grid-template-columns:minmax(90px,1fr) minmax(80px,1.4fr) auto}.actions{gap:6px}.btn,button{padding:7px 10px;font-size:12px}}");
  html.push("</style></head><body>");

  html.push("<header class='topbar'><div class='wrap topbar-inner'>");
  html.push("<div class='brand'><span class='brandmark' aria-hidden='true'></span><div class='brandcopy'><b>Mall Manager</b><span>KoL store operations</span></div></div>");
  html.push("<div class='actions'>");
  html.push("<button type='button' id='syncSalesButton' onclick='syncSales()'>Refresh sales</button>");
  html.push("<button type='button' class='secondary' onclick='exportHtml()'>Export HTML</button>");
  html.push("<button type='button' class='secondary' onclick='exportCsv()'>Export CSV</button>");
  html.push("<form class='inline' method='post'><input type='hidden' name='action' value='run'><button type='submit'>Run repricer</button></form>");
  html.push("<a class='btn secondary' href='/backoffice.php?which=3'>Store log</a>");
  html.push("<a class='btn secondary' href='/backoffice.php?which=1'>Inventory</a>");
  html.push("<span id='syncSalesStatus' class='tiny'></span>");
  html.push("<iframe id='salesSyncFrame' title='Mall Manager sales capture' style='display:none' data-active='0' onload='salesSyncLoaded()'></iframe>");
  html.push("</div></div></header>");
  html.push("<main class='wrap main'>");
  html.push("<section class='hero'><div><div class='eyebrow'>Store intelligence · local ledger · guarded pricing</div><h1>Mall <span>Manager</span></h1><p>One place to read sales, inspect market movement, export your ledger, and run guarded repricing without turning the relay into a polling dashboard.</p></div>");
  html.push("<aside class='hero-side'><div class='hero-label'>Recorded sales</div><div class='hero-value'>" + number(historyStats.totals.meat) + " Meat</div><div class='hero-meta'>" + number(historyStats.totals.transactions) + " transactions · " + number(historyStats.totals.buyers) + " buyers · " + number(historyStats.totals.items) + " distinct items</div></aside></section>");

  if (notice) html.push("<div class='notice'>" + esc(notice) + "</div>");
  if (salesError) html.push("<div class='notice error'><b>Sales data:</b> " + esc(salesError) + "</div>");

  if (needsRecentConfirm) {
    html.push("<div class='notice warning'><b>24-hour guard:</b> this repricer completed " + esc(repricer.formatDuration(state.ageMs)) + " ago. Run again anyway?");
    html.push("<form method='post' style='margin-top:10px'>");
    html.push("<input type='hidden' name='action' value='run'><input type='hidden' name='confirm_recent' value='1'>");
    html.push("<button class='danger' type='submit'>Yes, run again</button></form></div>");
  }

  html.push("<div class='section'><div class='sectionhead'><div><h2>Sales overview</h2>");
  html.push("<div class='kicker'>CSV-backed history in data/" + SALES_HISTORY_FILE + ". " + number(historyAdded) + " new transaction(s) merged from data/" + SALES_CURRENT_FILE + ".</div></div></div><div class='sectionbody'>");

  html.push("<div class='summary'>");
  html.push("<div class='card'><div class='label'>Total Meat</div><div class='metric'>" + number(historyStats.totals.meat) + "</div></div>");
  html.push("<div class='card'><div class='label'>Items sold</div><div class='metric'>" + number(historyStats.totals.units) + "</div></div>");
  html.push("<div class='card'><div class='label'>Transactions</div><div class='metric'>" + number(historyStats.totals.transactions) + "</div></div>");
  html.push("<div class='card'><div class='label'>Unique buyers</div><div class='metric'>" + number(historyStats.totals.buyers) + "</div></div>");
  html.push("<div class='card'><div class='label'>Distinct items</div><div class='metric'>" + number(historyStats.totals.items) + "</div></div>");
  html.push("</div>");

  html.push("<div class='tiny'>Current KoL two-week window: " + number(currentStats.totals.units) + " items · " + number(currentStats.totals.buyers) + " buyers · " + number(currentStats.totals.transactions) + " transactions · " + number(currentStats.totals.meat) + " Meat.</div>");
  html.push("<div class='debuggrid'>");
  html.push("<div class='debugbox'><b>Last hook</b>" + esc(dateText(lastHookMs)) + "</div>");
  html.push("<div class='debugbox'><b>Hook page chars</b>" + number(lastHookPageChars) + "</div>");
  html.push("<div class='debugbox'><b>ASH hook parsed rows</b>" + number(lastHookParsedCount) + "</div>");
  html.push("<div class='debugbox'><b>Relay HTML parsed rows</b>" + number(lastRelayParsedCount) + "</div>");
  html.push("<div class='debugbox'><b>Current CSV parsed rows</b>" + number(currentSales.length) + "</div>");
  html.push("<div class='debugbox'><b>Current CSV lines</b>" + number(currentRawLines.length) + "</div>");
  html.push("<div class='debugbox'><b>History parsed rows</b>" + number(historyRows.length) + "</div>");
  html.push("<div class='debugbox'><b>Looked like Store Log</b>" + esc(lastHookLookedLikeStoreLog || "unknown") + "</div>");
  html.push("<div class='debugbox'><b>CSV write OK</b>" + esc(lastHookWriteOk || "unknown") + "</div>");
  html.push("</div>");
  html.push("</div></div>");

  html.push("<div id='pieTooltip' class='pietooltip'></div>");

  html.push("<div class='analytics-grid'>");

  html.push("<div class='panel'><h3>Top Buyers By Items Purchased</h3>");
  html.push(renderExplodedPie("", historyStats.buyers, "units", "items purchased"));
  html.push(barRows(historyStats.buyers, "units", 10, false));
  html.push("<div class='charttitle' style='margin-top:18px'>All Buyers By Items Purchased</div>");
  html.push(buyerTable(historyStats.buyers, "units"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Items Sold</h3>");
  html.push(renderExplodedPie("", historyStats.items, "units", "items sold"));
  html.push(barRows(historyStats.items, "units", 10, false));
  html.push("<div class='charttitle' style='margin-top:18px'>All Items Sold</div>");
  html.push(itemSummaryTable(historyStats.items, "units"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Buyers By Meat</h3>");
  html.push(renderExplodedPie("", historyBuyersByMeat, "meat", "Meat"));
  html.push(barRows(historyBuyersByMeat, "meat", 10, true));
  html.push("<div class='charttitle' style='margin-top:18px'>All Buyers By Meat</div>");
  html.push(buyerTable(historyBuyersByMeat, "meat"));
  html.push("</div>");

  html.push("<div class='panel'><h3>Top Items By Meat</h3>");
  html.push(renderExplodedPie("", historyItemsByMeat, "meat", "Meat"));
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

  html.push("<div class='section'><div class='sectionhead'><div><h2>Recent Store Transactions</h2><div class='kicker'>Current captured Store Log snapshot from data/" + SALES_CURRENT_FILE + ".</div></div></div><div class='sectionbody'><div class='tablewrap'><table><thead><tr>");
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

  html.push("<div class='tiny'>Sales are captured by relay/backoffice.ash as sanitized HTML; this relay parses that capture into CSV, then reads/merges the local files. No sales scraping is attempted from inside this relay page. Pricegun/network price checks happen only when you explicitly run repricing or mall-clean.</div>");

  html.push("<details class='section debug' id='debugBundle'><summary>Capture diagnostics</summary><div class='sectionbody'>");
  html.push("<p class='tiny'>This bundle is local diagnostic evidence. The backoffice hook redacts pwd/pwdhash values before saving its HTML capture.</p>");
  html.push("<h3>Runtime properties</h3><pre>" +
    esc(
      "lastHook=" + dateText(lastHookMs) + "\n" +
      "lastHookPageChars=" + lastHookPageChars + "\n" +
      "lastHookParsedCount=" + lastHookParsedCount + "\n" +
      "lastRelayParsedCount=" + lastRelayParsedCount + "\n" +
      "lastHookLookedLikeStoreLog=" + lastHookLookedLikeStoreLog + "\n" +
      "lastHookWriteOk=" + lastHookWriteOk + "\n" +
      "lastCapture=" + dateText(lastCaptureMs) + "\n" +
      "lastCaptureCount=" + lastCaptureCount + "\n" +
      "currentCsvLineCount=" + currentRawLines.length + "\n" +
      "currentCsvParsedRows=" + currentSales.length + "\n" +
      "historyCsvLineCount=" + historyRawLines.length + "\n" +
      "historyParsedRows=" + historyRows.length
    ) +
    "</pre>");
  html.push("<h3>data/" + esc(SALES_CURRENT_FILE) + "</h3><pre>" + esc(currentRawLines.join("\n")) + "</pre>");
  html.push("<h3>data/" + esc(SALES_HISTORY_FILE) + " (sample)</h3><pre>" + esc(sampleLines(historyRawLines, 250, 50)) + "</pre>");
  html.push("<h3>data/" + esc(BACKOFFICE_DEBUG_FILE) + " (sanitized excerpt around first sale)</h3><pre>" + esc(debugHtmlExcerpt(backofficeDebugLines)) + "</pre>");
  html.push("</div></details>");

  html.push("<textarea id='salesCsvExportData' style='display:none' aria-hidden='true'>" + esc(historyRawLines.join("\n")) + "</textarea>");

  html.push("<script>");
  html.push("var pinnedPieSlice=null;");
  html.push("function pieExpand(el,mult){var x=parseFloat(el.getAttribute('data-base-x')||'0');var y=parseFloat(el.getAttribute('data-base-y')||'0');el.setAttribute('transform','translate('+(x*mult).toFixed(2)+' '+(y*mult).toFixed(2)+')');}");
  html.push("function pieTip(el,event){var tip=document.getElementById('pieTooltip');if(!tip)return;var label=el.getAttribute('data-label')||'';var value=Number(el.getAttribute('data-value')||0);var pct=el.getAttribute('data-pct')||'0.0';tip.innerHTML='<b>'+label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</b><span>'+value.toLocaleString()+' · '+pct+'%</span><span class=\\\"tiny\\\">Click to pin / unpin</span>';tip.style.display='block';if(event&&event.clientX!==undefined){tip.style.left=Math.min(window.innerWidth-300,event.clientX+16)+'px';tip.style.top=Math.min(window.innerHeight-110,event.clientY+16)+'px';}}");
  html.push("function pieEnter(el,event){if(el!==pinnedPieSlice)pieExpand(el,2.15);pieTip(el,event);}");
  html.push("function pieMove(el,event){pieTip(el,event);}");
  html.push("function pieLeave(el){if(el!==pinnedPieSlice)pieExpand(el,1);var tip=document.getElementById('pieTooltip');if(tip&&el!==pinnedPieSlice)tip.style.display='none';}");
  html.push("function piePin(el,event){if(pinnedPieSlice&&pinnedPieSlice!==el){pinnedPieSlice.classList.remove('pinned');pinnedPieSlice.setAttribute('data-pinned','0');pieExpand(pinnedPieSlice,1);}if(pinnedPieSlice===el){el.classList.remove('pinned');el.setAttribute('data-pinned','0');pieExpand(el,1);pinnedPieSlice=null;var tip=document.getElementById('pieTooltip');if(tip)tip.style.display='none';return;}pinnedPieSlice=el;el.classList.add('pinned');el.setAttribute('data-pinned','1');pieExpand(el,2.15);pieTip(el,event);}");
  html.push("function pieFocus(el){if(el!==pinnedPieSlice)pieExpand(el,2.15);pieTip(el,null);}");
  html.push("function pieBlur(el){if(el!==pinnedPieSlice)pieExpand(el,1);var tip=document.getElementById('pieTooltip');if(tip&&el!==pinnedPieSlice)tip.style.display='none';}");
  html.push("document.addEventListener('click',function(event){if(!pinnedPieSlice)return;if(event.target.closest&&event.target.closest('.pieslice'))return;pinnedPieSlice.classList.remove('pinned');pieExpand(pinnedPieSlice,1);pinnedPieSlice=null;var tip=document.getElementById('pieTooltip');if(tip)tip.style.display='none';});");
  html.push("function filterItems(){var q=(document.getElementById('itemSearch').value||'').toLowerCase();var rows=document.querySelectorAll('#itemDetailTable tbody tr');for(var i=0;i<rows.length;i++){var t=(rows[i].textContent||'').toLowerCase();rows[i].style.display=t.indexOf(q)>=0?'':'none';}}");
  html.push("function syncSales(){var f=document.getElementById('salesSyncFrame');var b=document.getElementById('syncSalesButton');var s=document.getElementById('syncSalesStatus');if(!f)return;f.dataset.active='1';if(b)b.disabled=true;if(s)s.textContent='Capturing Store Log to CSV…';f.src='/backoffice.php?which=3&mallmanager_sync=1&_mm='+Date.now();}");
  html.push("function salesSyncLoaded(){var f=document.getElementById('salesSyncFrame');if(!f||f.dataset.active!=='1')return;f.dataset.active='0';var s=document.getElementById('syncSalesStatus');if(s)s.textContent='Capture finished; reloading dashboard…';window.setTimeout(function(){window.location.reload();},100);}");
  html.push("function downloadBlob(text,type,name){var blob=new Blob([text],{type:type});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);window.setTimeout(function(){URL.revokeObjectURL(url);},1000);}");
  html.push("function exportHtml(){var source='<!doctype html>\\n'+document.documentElement.outerHTML;downloadBlob(source,'text/html;charset=utf-8','mall-manager-'+new Date().toISOString().replace(/[:.]/g,'-')+'.html');}");
  html.push("function exportCsv(){var el=document.getElementById('salesCsvExportData');var csv=el?el.value:'';if(!csv){alert('No sales history is available to export yet.');return;}if(csv.charAt(csv.length-1)!=='\\n')csv+='\\n';downloadBlob(csv,'text/csv;charset=utf-8','mall-manager-sales-'+new Date().toISOString().replace(/[:.]/g,'-')+'.csv');}");
  html.push("</script>");

  html.push("</main></body></html>");

  k.write(html.join(""));
}

module.exports.parseCapturedBackofficeHtml = parseCapturedBackofficeHtml;
module.exports.parseCsvLine = parseCsvLine;
module.exports.readSalesCsv = readSalesCsv;
module.exports.aggregateSales = aggregateSales;

module.exports.main = function main() {
  var fields = k.formFields();
  var action = fields && fields.action ? String(fields.action) : "";
  var notice = "";
  var needsRecentConfirm = false;

  var sync = fields && fields.sync ? String(fields.sync) : "";

  if (sync === "ok") {
    notice =
      "Store Log captured to data/" +
      SALES_CURRENT_FILE +
      " (" +
      (Number(k.getProperty("mallManagerSalesLastCaptureCount")) || 0) +
      " transaction(s)); local history updated below.";
  } else if (sync === "write_failed") {
    notice = "Store Log loaded, but writing data/" + SALES_CURRENT_FILE + " failed.";
  } else if (sync === "not_store_log") {
    notice = "Backoffice capture hook ran, but the page did not look like the Store Log.";
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
