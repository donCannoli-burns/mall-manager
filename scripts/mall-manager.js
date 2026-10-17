/*
 * mall-manager.js
 *
 * Human-facing gCLI dispatcher for Mall Manager.
 *
 * KoLmafia falls back to script lookup when a gCLI command is not a built-in,
 * so this script can be invoked directly as:
 *
 *   mall-manager help
 *   mall-manager reprice
 *   mall-manager sim reprice
 *   mall-manager clean
 *   mall-manager sim clean
 */

var k = require("kolmafia");
var repricer = require("./store-reprice.js");
var cleaner = require("./mall-clean.js");

function normalize(command) {
  return String(command || "")
    .toLowerCase()
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+/g, " ");
}

function tokens(command) {
  var cmd = normalize(command);
  return cmd ? cmd.split(" ") : [];
}

function has(words, value) {
  var i;
  for (i = 0; i < words.length; i++) {
    if (words[i] === value) return true;
  }
  return false;
}

function printLine(command, description) {
  k.print("  " + command, "blue");
  k.print("      " + description);
}

function printHelp() {
  k.print("Mall Manager commands", "green");
  k.print("");
  printLine(
    "mall-manager reprice",
    "Live repricing using KoLmafia's 5th-cheapest mall price with the Pricegun discrepancy veto."
  );
  printLine(
    "mall-manager sim reprice",
    "Simulate repricing: refresh/check market data and print proposed changes, but do not change store prices."
  );
  printLine(
    "mall-manager clean",
    "Live Mall Clean. Finds safe cleanup candidates, then requires final confirmation before removing/autoselling."
  );
  printLine(
    "mall-manager sim clean",
    "Simulate Mall Clean: scan and report candidates/flags only; no items are removed or autosold."
  );
  printLine(
    "mall-manager force reprice",
    "Live reprice while bypassing only the 24-hour rerun guard. Market/Pricegun safety checks still apply."
  );
  printLine(
    "mall-manager force clean",
    "Live clean while bypassing only the 24-hour rerun guard. Final destructive confirmation is still required."
  );
  printLine(
    "mall-manager help",
    "Show this command list."
  );

  k.print("");
  k.print("Simulation word order is flexible:", "green");
  k.print("  mall-manager sim reprice   = mall-manager reprice sim");
  k.print("  mall-manager sim clean     = mall-manager clean sim");

  k.print("");
  k.print("Underlying scripts remain available:", "green");
  k.print("  call store-reprice.js");
  k.print("  call store-reprice.js sim");
  k.print("  call mall-clean.js");
  k.print("  call mall-clean.js preview");
}

function usageError(command) {
  k.print(
    "Unknown Mall Manager command: " +
      (command ? command : "(none)") +
      ".",
    "red"
  );
  k.print("Run: mall-manager help");
}

module.exports.main = function main(command) {
  var cmd = normalize(command);
  var words = tokens(cmd);

  if (
    !cmd ||
    cmd === "help" ||
    cmd === "commands" ||
    cmd === "?" ||
    cmd === "-h" ||
    cmd === "--help"
  ) {
    printHelp();
    return;
  }

  var wantsReprice = has(words, "reprice") || has(words, "repricing");
  var wantsClean = has(words, "clean") || has(words, "cleanup");
  var preview =
    has(words, "sim") ||
    has(words, "simulate") ||
    has(words, "preview") ||
    has(words, "test") ||
    has(words, "dry") ||
    has(words, "dry-run");
  var force = has(words, "force");

  if (wantsReprice && wantsClean) {
    usageError(cmd);
    return;
  }

  if (wantsReprice) {
    if (preview) {
      k.print("Mall Manager: simulating repricing; no store prices will change.", "blue");
      repricer.runReprice(force, true);
    } else {
      repricer.runReprice(force, false);
    }
    return;
  }

  if (wantsClean) {
    if (preview) {
      k.print("Mall Manager: simulating Mall Clean; nothing will be removed or autosold.", "blue");
    }

    cleaner.runClean({
      preview: preview,
      force: force
    });
    return;
  }

  usageError(cmd);
};
