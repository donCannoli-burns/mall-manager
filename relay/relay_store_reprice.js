/*
 * relay_store_reprice.js
 * Relay-browser dashboard for store-reprice.js.
 */

var k = require("kolmafia");
var repricer = require("../scripts/store-reprice.js");

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function number(value) {
  var s = String(Math.round(Number(value) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

function decodeBasicHtml(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function salesFromBackoffice() {
  var html = String(k.visitUrl("backoffice.php?which=1"));
  var pieces = html.split("Meat.");
  var byItem = {};
  var i;

  for (i = 0; i < pieces.length; i++) {
    var m = /:\d+ (.+) bought ([\d,]+) \((.*?)\) for ([\d,]+)/.exec(pieces[i]);
    if (!m) continue;

    var itemName = decodeBasicHtml(m[3].replace(/<[^>]+>/g, "")).trim();
    var qty = Number(String(m[2]).replace(/,/g, "")) || 0;
    var meat = Number(String(m[4]).replace(/,/g, "")) || 0;

    if (!itemName || qty <= 0) continue;

    if (!byItem[itemName]) {
      byItem[itemName] = {
        item: itemName,
        sold: 0,
        transactions: 0,
        meat: 0
      };
    }

    byItem[itemName].sold += qty;
    byItem[itemName].transactions += 1;
    byItem[itemName].meat += meat;
  }

  if (!Object.keys(byItem).length) {
    var text = decodeBasicHtml(
      html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    );
    var re = /bought\s+([\d,]+)\s+\(([^)]+)\)\s+for\s+([\d,]+)\s+Meat/gi;
    var fm;

    while ((fm = re.exec(text)) !== null) {
      var name = fm[2].trim();
      var fq = Number(fm[1].replace(/,/g, "")) || 0;
      var fp = Number(fm[3].replace(/,/g, "")) || 0;

      if (!byItem[name]) {
        byItem[name] = {
          item: name,
          sold: 0,
          transactions: 0,
          meat: 0
        };
      }

      byItem[name].sold += fq;
      byItem[name].transactions += 1;
      byItem[name].meat += fp;
    }
  }

  var rows = [];
  var names = Object.keys(byItem);

  for (i = 0; i < names.length; i++) {
    rows.push(byItem[names[i]]);
  }

  rows.sort(function (a, b) {
    return b.meat - a.meat;
  });

  return rows;
}

function totalSales(rows) {
  var out = {
    sold: 0,
    transactions: 0,
    meat: 0
  };

  var i;

  for (i = 0; i < rows.length; i++) {
    out.sold += rows[i].sold;
    out.transactions += rows[i].transactions;
    out.meat += rows[i].meat;
  }

  return out;
}

function statusClass(status) {
  if (status === "flagged_discrepancy") return "flag";
  if (status === "verify_failed") return "bad";
  if (status === "applied") return "good";
  return "muted";
}

function renderPage(notice, needsRecentConfirm) {
  var state = repricer.getRunState();
  var settings = repricer.getSafetySettings();
  var changes = repricer.readChangeLog(200);
  var sales = salesFromBackoffice();
  var totals = totalSales(sales);
  var lastResult = k.getProperty("storeRepriceLastResult");
  var flaggedCount = 0;
  var i;

  for (i = 0; i < changes.length; i++) {
    if (changes[i].status === "flagged_discrepancy") flaggedCount++;
  }

  var html = [];

  html.push("<!doctype html><html><head><meta charset='utf-8'>");
  html.push("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html.push("<title>Mall Manager</title><style>");
  html.push("body{margin:0;background:#f5f6f8;color:#20242a;font:14px Arial,sans-serif}");
  html.push(".wrap{max-width:1280px;margin:0 auto;padding:24px}");
  html.push("h1{margin:0 0 6px;font-size:30px}.sub{color:#68707c;margin-bottom:18px}");
  html.push(".grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:16px 0}");
  html.push(".card{background:#fff;border:1px solid #e1e4e8;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}");
  html.push(".metric{font-size:24px;font-weight:700;margin-top:5px}.label{font-size:12px;color:#68707c;text-transform:uppercase;letter-spacing:.06em}");
  html.push(".bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0 20px}");
  html.push("button,.btn{border:0;border-radius:8px;padding:10px 14px;background:#1f6feb;color:#fff;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}");
  html.push(".secondary{background:#59636e}.danger{background:#b42318}");
  html.push(".notice{padding:12px 14px;border-radius:9px;background:#eef6ff;border:1px solid #b6d7ff;margin:12px 0}");
  html.push(".warning{background:#fff3cd;border-color:#ffe08a}");
  html.push(".section{background:#fff;border:1px solid #e1e4e8;border-radius:12px;margin:18px 0;overflow:hidden}");
  html.push(".section h2{font-size:18px;margin:0;padding:16px;border-bottom:1px solid #e8ebef}");
  html.push(".scroll{overflow:auto;max-height:560px}");
  html.push("table{width:100%;border-collapse:collapse}");
  html.push("th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef0f2;white-space:nowrap}");
  html.push("th{position:sticky;top:0;background:#fafbfc;z-index:1;font-size:12px;text-transform:uppercase;color:#5f6874}");
  html.push("td.name{white-space:normal;min-width:220px}");
  html.push(".good{color:#067647;font-weight:700}.bad{color:#b42318;font-weight:700}.flag{color:#9a6700;font-weight:800}.muted{color:#68707c}");
  html.push(".flagrow{background:#fff8db}");
  html.push(".tiny{font-size:12px;color:#68707c;line-height:1.4}");
  html.push("@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wrap{padding:14px}}");
  html.push("</style></head><body><div class='wrap'>");

  html.push("<h1>Mall Manager</h1>");
  html.push("<div class='sub'>Live KoL mall pricing with Pricegun discrepancy vetoes and recent store sales.</div>");

  if (notice) {
    html.push("<div class='notice'>" + esc(notice) + "</div>");
  }

  if (needsRecentConfirm) {
    html.push("<div class='notice warning'><b>24-hour guard:</b> this repricer completed " + esc(repricer.formatDuration(state.ageMs)) + " ago. Run again anyway?");
    html.push("<form method='post' action='relay_store_reprice.js' style='margin-top:10px'>");
    html.push("<input type='hidden' name='action' value='run'>");
    html.push("<input type='hidden' name='confirm_recent' value='1'>");
    html.push("<button class='danger' type='submit'>Yes, run again</button></form></div>");
  }

  html.push("<div class='grid'>");
  html.push("<div class='card'><div class='label'>Last repricer run</div><div class='metric' style='font-size:18px'>" + esc(dateText(state.lastRunMs)) + "</div></div>");
  html.push("<div class='card'><div class='label'>Last run result</div><div style='margin-top:8px'>" + esc(lastResult || "No completed run yet") + "</div></div>");
  html.push("<div class='card'><div class='label'>Recent flags shown</div><div class='metric'>" + number(flaggedCount) + "</div></div>");
  html.push("<div class='card'><div class='label'>2-week sales meat</div><div class='metric'>" + number(totals.meat) + "</div></div>");
  html.push("<div class='card'><div class='label'>2-week transactions</div><div class='metric'>" + number(totals.transactions) + "</div></div>");
  html.push("</div>");

  html.push("<div class='notice warning'>");
  html.push("<b>Safety rule:</b> normal target = KoLmafia's current 5th-cheapest mall price. ");
  html.push("Pricegun blocks the change when its recent transaction value is at least <b>" + esc(settings.discrepancyRatio) + "×</b> the mall target and at least <b>" + number(settings.discrepancyMinGap) + " Meat</b> higher, with recent volume ≥ <b>" + number(settings.pricegunMinVolume) + "</b>. ");
  html.push("Flagged items are left at their existing store price.");
  html.push("</div>");

  html.push("<div class='bar'>");
  html.push("<form method='post' action='relay_store_reprice.js'><input type='hidden' name='action' value='run'><button type='submit'>Run repricer now</button></form>");
  html.push("<a class='btn secondary' href='relay_store_reprice.js'>Refresh dashboard</a>");
  html.push("<a class='btn secondary' href='backoffice.php?which=1'>Native backoffice</a>");
  html.push("</div>");

  html.push("<div class='section'><h2>Repricing changes & safety flags</h2><div class='scroll'><table>");
  html.push("<thead><tr><th>When</th><th>Item</th><th>Qty</th><th>Old</th><th>Mall target</th><th>Pricegun</th><th>PG / Mall</th><th>Applied</th><th>Status</th><th>Source</th></tr></thead><tbody>");

  if (!changes.length) {
    html.push("<tr><td colspan='10' class='muted'>No repricing activity logged yet.</td></tr>");
  } else {
    for (i = 0; i < changes.length; i++) {
      var c = changes[i];
      var rowClass = c.status === "flagged_discrepancy" ? " class='flagrow'" : "";

      html.push("<tr" + rowClass + ">");
      html.push("<td>" + esc(dateText(c.runMs)) + "</td>");
      html.push("<td class='name'>" + esc(c.name) + "</td>");
      html.push("<td>" + number(c.qty) + "</td>");
      html.push("<td>" + number(c.oldPrice) + "</td>");
      html.push("<td>" + (c.marketPrice ? number(c.marketPrice) : number(c.targetPrice)) + "</td>");
      html.push("<td>" + (c.pricegunValue ? number(c.pricegunValue) : "—") + "</td>");
      html.push("<td>" + ratio(c.discrepancyRatio) + "</td>");
      html.push("<td>" + number(c.appliedPrice) + "</td>");
      html.push("<td class='" + statusClass(c.status) + "'>" + esc(c.status) + "</td>");
      html.push("<td class='tiny'>" + esc(c.source || "") + "</td>");
      html.push("</tr>");
    }
  }

  html.push("</tbody></table></div></div>");

  html.push("<div class='section'><h2>Recent store sales (KoL backoffice, past 2 weeks)</h2><div class='scroll'><table>");
  html.push("<thead><tr><th>Item</th><th>Total sold</th><th>Transactions</th><th>Avg qty / transaction</th><th>Total meat</th><th>Avg meat / item</th></tr></thead><tbody>");

  if (!sales.length) {
    html.push("<tr><td colspan='6' class='muted'>No recent sales were parsed from the backoffice page.</td></tr>");
  } else {
    for (i = 0; i < sales.length; i++) {
      var s = sales[i];
      html.push("<tr>");
      html.push("<td class='name'>" + esc(s.item) + "</td>");
      html.push("<td>" + number(s.sold) + "</td>");
      html.push("<td>" + number(s.transactions) + "</td>");
      html.push("<td>" + number(s.transactions ? s.sold / s.transactions : 0) + "</td>");
      html.push("<td>" + number(s.meat) + "</td>");
      html.push("<td>" + number(s.sold ? s.meat / s.sold : 0) + "</td>");
      html.push("</tr>");
    }
  }

  html.push("</tbody></table></div></div>");

  html.push("<div class='tiny'>The dashboard itself does not poll Pricegun or refresh mall prices. Network price checks happen only when you explicitly run the repricer.</div>");
  html.push("</div></body></html>");

  k.write(html.join(""));
}

module.exports.main = function main() {
  var fields = k.formFields();
  var action = fields && fields.action ? String(fields.action) : "";
  var notice = "";
  var needsRecentConfirm = false;

  if (action === "run") {
    var state = repricer.getRunState();
    var confirmed = fields && String(fields.confirm_recent || "") === "1";

    if (state.recent && !confirmed) {
      needsRecentConfirm = true;
    } else {
      var result = repricer.runReprice(confirmed);
      notice = result && result.message ? result.message : "Repricer finished.";
    }
  }

  renderPage(notice, needsRecentConfirm);
};
