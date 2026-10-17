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

Run from gCLI:

```text
call store-reprice.js
```

Or choose the Mall Manager relay entry from the relay-browser script dropdown.

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

`relay/relay_store_reprice.js` shows:

- recent applied repricing changes
- Pricegun discrepancy flags
- live mall target
- Pricegun value
- Pricegun / mall ratio
- actual applied price
- source/status
- recent KoL backoffice sales summary

Flagged rows are visually highlighted and explicitly show that the existing store price was left unchanged.

## Files

```text
scripts/store-reprice.js
relay/relay_store_reprice.js
```

## Existing log migration

The original build used Pricegun's computed value as the target price. Mall Manager no longer does that.

Existing rows in `data/store-reprice-changes.tsv` are preserved and labeled as legacy Pricegun-target evidence when the new code reads/migrates the log.

## First live test

For the first run after an update, it is still sensible to test with inexpensive inventory and inspect the relay's proposed/applied/flagged rows before relying on it for a high-value store.
