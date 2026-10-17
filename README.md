# KoLmafia Mall Manager

Mall Manager reprices the items currently stocked in your KoL mall store using a hybrid safety model:

1. **KoLmafia's current mall price is the target.**
   - Mall Manager refreshes KoL's mall-price snapshot with `mallPrices("allitems")`.
   - KoLmafia's mall price is deliberately the **5th-cheapest purchasable copy**, not the absolute cheapest listing.
   - That already avoids chasing a single accidental bargain listing.

2. **Pricegun is a sanity veto, not the target.**
   - Mall Manager fetches Pricegun's transaction-derived value for the items in your store.
   - If Pricegun says an item is dramatically more valuable than the live mall target, Mall Manager **flags it and leaves your store price unchanged**.
   - Default veto: Pricegun must be at least **3x** the mall target **and** at least **500 Meat higher**, with Pricegun recent volume >= **1**.

3. **Nothing is repriced until both market checks finish.**
   - A complete Pricegun transport/API failure aborts before any store mutation.
   - Missing/stale KoL market data is skipped.
   - Missing Pricegun data for an individual item does not invent a price; the item can still use KoLmafia's 5th-cheapest protection and is marked as having no Pricegun reference in the run summary.

## Install

From KoLmafia's gCLI:

```text
git checkout https://github.com/donCannoli-burns/mall-manager.git
```

Update later with:

```text
git update mall-manager
```

Run from gCLI through the Mall Manager command:

```text
mall-manager help
mall-manager reprice
mall-manager sim reprice
mall-manager clean
mall-manager sim clean
```

KoLmafia falls back to script lookup for unknown gCLI commands, so `scripts/mall-manager.js` can be invoked directly as `mall-manager ...` without typing `call`.

The underlying scripts remain available for compatibility:

```text
call store-reprice.js
call store-reprice.js sim
call mall-clean.js
call mall-clean.js preview
```

Or choose the Mall Manager relay entry from the relay-browser script dropdown.

## gCLI command surface

`mall-manager help` prints the supported command surface:

```text
mall-manager reprice
mall-manager sim reprice
mall-manager clean
mall-manager sim clean
mall-manager force reprice
mall-manager force clean
mall-manager help
```

Simulation word order is flexible, so `mall-manager reprice sim` and `mall-manager clean sim` are also accepted.

- **sim reprice** performs the same mall-price refresh and Pricegun safety analysis as a live repricing run, prints every proposed price change, and stops before any store mutation, repricing audit write, or 24-hour completion state is recorded.
- **sim clean** uses Mall Clean's existing preview mode and never removes/autosells items.
- **force reprice** bypasses only the repricer's 24-hour rerun guard; mall/Pricegun safeguards remain active.
- **force clean** bypasses only Mall Clean's 24-hour rerun guard; the final destructive confirmation remains required.

## Request throttling

Mall Manager uses two shared throttle files in KoLmafia's `data/` directory:

- `store-reprice-mall-throttle.txt`
- `store-reprice-pricegun-throttle.txt`

Both are written **before** their corresponding network request, so a timeout or crash cannot cause an immediate retry storm.

- KoL mall snapshot: no more than one refresh inside 60 seconds.
- Pricegun: at least 60 seconds between Pricegun requests. Pricegun item IDs are batched into comma-separated API requests, so most stores need one Pricegun request.

Refreshing the relay dashboard does **not** contact Pricegun or refresh mall prices.

## 24-hour rerun guard

A completed run sets `storeRepriceLastRunMs`.

If another run is attempted within 24 hours:

- gCLI prompts for confirmation.
- relay browser shows a confirmation page.

## Discrepancy example

If the current market snapshot says:

```text
mall target: 100 Meat
Pricegun:   1,000 Meat
```

the ratio is 10x and the gap is 900 Meat, so with the default settings the item is:

```text
FLAGGED — NOT REPRICED
```

Likewise, a mall target near 40,000 with a Pricegun value near 210,000 is flagged for review instead of being automatically repriced either way.

## Configurable safety prefs

The defaults can be changed from gCLI:

```text
set storeRepriceDiscrepancyRatio=3
set storeRepriceDiscrepancyMinGap=500
set storeRepricePricegunMinVolume=1
```

Meaning:

- `storeRepriceDiscrepancyRatio`: Pricegun / mall ratio required for a veto.
- `storeRepriceDiscrepancyMinGap`: minimum absolute Meat gap required for a veto.
- `storeRepricePricegunMinVolume`: minimum recent Pricegun volume before its value is allowed to veto a mall price.

## Relay dashboard

`relay/relay_store_reprice.js` is the Mall Manager workbench.

### Sales source and refresh

Sales originate from KoL's actual Store Log page:

```text
backoffice.php?which=3
```

Mall Manager does **not** request the Store Log from inside the dashboard relay. Instead, `relay/backoffice.ash` is a small pass-through capture hook. KoLmafia's no-argument `visit_url()` retrieves the real native backoffice response, sanitizes it, saves it to `data/mall-manager-backoffice-debug.html`, and returns the native page unchanged. The JavaScript relay then parses that saved HTML into the CSV snapshot/history. This keeps ASH out of the transaction-parsing path.

The **Refresh sales dashboard** button loads the Store Log through a hidden iframe, so the operator stays on Mall Manager while `relay/backoffice.ash` captures the page. When the hidden request finishes, the dashboard reloads itself.

After the hidden capture finishes, Mall Manager reloads the current relay page. The JavaScript relay parses the saved Store Log HTML and writes:

```text
data/mall-manager-sales-current.csv
```

The dashboard then merges/deduplicates that snapshot into the durable ledger:

```text
data/mall-manager-sales.csv
```

Both CSVs use the analyzer-friendly schema:

```csv
"Date","Time","Player","Item","Quantity","Item Price","Total Meat"
"10/16/26","23:20:26","vkkhamul","shadow glass",3,5346,16038
```

This also makes existing exports easy to import: place a compatible CSV at `data/mall-manager-sales.csv` and the dashboard will use it as historical seed data.

For troubleshooting, every capture also saves a sanitized local copy of the exact backoffice response to:

```text
data/mall-manager-backoffice-debug.html
```

KoL `pwd` / `pwdhash` values are redacted before that file is written. The dashboard exposes live capture counts/CSV line counts plus two operator exports:

- **Export HTML** downloads the current rendered Mall Manager dashboard as a standalone HTML snapshot, including the capture diagnostics section.
- **Export CSV** downloads the full accumulated `data/mall-manager-sales.csv` ledger in the same 7-column analyzer-compatible format.
- The dashboard includes four interactive exploded SVG pie charts for top buyers/items by units and Meat. Slices pop outward on hover/focus, show value + percentage tooltips, and can be clicked to pin/unpin.

Transactions are deduplicated by normalized date/time/player/item/quantity/total plus occurrence count, so legitimate duplicate-looking transactions in the same second are preserved while repeated Store Log captures are not re-added.

### Sales analytics

The relay presents an analyzer-style dashboard with:

- total items sold
- unique buyers
- transaction count
- total Meat
- distinct items sold
- top/all buyers by items purchased
- top/all items by quantity sold
- top/all buyers by Meat
- top/all items by Meat
- items sold and Meat per day for the current Store Log window
- monthly items/Meat trends from locally recorded history
- complete per-item details:
  - total sold
  - total transactions
  - average sold per transaction
  - total Meat
  - average price
- searchable item details
- recent raw Store Log transactions

### Repricing panel

The same relay also shows:

- recent applied repricing changes
- Pricegun discrepancy flags
- live mall target
- Pricegun value
- Pricegun / mall ratio
- actual applied price
- source/status

Flagged rows are visually highlighted and explicitly show that the existing store price was left unchanged.

## Mall Clean

`scripts/mall-clean.js` is derived from rlbond86's `mall_autosell.ash` behavior and keeps its basic cleanup defaults:

- cleanup threshold: current mall price is within **5% above the legal mall minimum**
- legal mall minimum: `max(100, 2 * autosell price)`
- maximum mall price eligible for cleanup: **5,000 Meat**

Mall Clean uses KoLmafia's current 5th-cheapest mall price and then applies the **same Pricegun discrepancy veto** as the repricer. A suspicious low mall price is flagged and left untouched rather than autosold.

Preview safely before doing anything:

```text
call mall-clean.js preview
```

Live run:

```text
call mall-clean.js
```

The live run prints every candidate and every Pricegun flag, then requires one final confirmation before it removes anything from the store and autosells it. A completed live run also has its own 24-hour rerun guard.

To bypass only the 24-hour guard while retaining the final destructive confirmation:

```text
call mall-clean.js force
```

Cleanup settings:

```text
set mallCleanThresholdFraction=0.05
set mallCleanMaxMallPrice=5000
```

Mall Clean writes its audit trail to:

```text
data/mall-clean-log.tsv
```

The audit records mall minimum, cleanup threshold, current market price, Pricegun value/volume/ratio, disposition, and Meat actually gained.

## Files

```text
scripts/store-reprice.js
scripts/mall-clean.js
relay/relay_store_reprice.js
relay/backoffice.ash
```

## Existing log migration

The original build used Pricegun's computed value as the target price. Mall Manager no longer does that.

Existing rows in `data/store-reprice-changes.tsv` are preserved and labeled as legacy Pricegun-target evidence when the new code reads/migrates the log.

## First live test

For the first run after an update, it is still sensible to test with inexpensive inventory and inspect the relay's proposed/applied/flagged rows before relying on it for a high-value store.


### Visual system

The relay dashboard uses a dark material system inspired by the hierarchy/material separation in `es-3581100/math-by-design` without copying that project's reference palette or signature.

- Reading text uses a sans-serif role; compact metadata and numeric evidence use monospace.
- Lime is a low-frequency operator/accent signal, not a general text/background color.
- Warm brass is reserved for high-value totals and chart center labels.
- Major sections use whitespace and border rhythm before adding nested card chrome.
- The top-level hero and KPI strip use asymmetric hierarchy; analytics collapse to a single column on narrow screens.
- The page declares its own dark color scheme and includes `<meta name="darkreader-lock">` so Dark Reader does not recolor the intentionally dark relay UI and reduce chart/text contrast.
