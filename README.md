# KoLmafia Pricegun Store Repricer

Files:

- `scripts/store-reprice.js` — reprices every currently stocked mall-store item from Pricegun's current `value` field.
- `relay/relay_store_reprice.js` — relay-browser dashboard showing repricing changes and recent backoffice sales.

## Safety / request behavior

- Pricegun API requests are batched using comma-separated item IDs.
- A shared data-file timestamp (`data/store-reprice-pricegun-throttle.txt`) enforces **at least 60 seconds between Pricegun requests**, including across separate script invocations and character switches in the same KoLmafia data directory. The current character also mirrors that time in `storeRepriceLastPricegunRequestMs` for inspection.
- Pricegun reads complete before any mall-store mutation begins. If a Pricegun batch fails, the repricer exits without changing prices.
- A completed repricing run sets `storeRepriceLastRunMs`. If another run is attempted within 24 hours, the CLI version prompts; the relay version shows a confirmation step.
- Targets use Pricegun's current valuation, rounded to integer Meat and clamped to KoL's legal mall range: `max(100, 2 * autosell)` through `999,999,999`.
- Missing or invalid Pricegun values are skipped.
- Existing per-customer store limits are preserved by using KoLmafia's two-argument `repriceShop(price, item)`.
- Repricing calls are wrapped in KoLmafia batching, then `refreshShop()` verifies the resulting prices.

## Install with KoLmafia

From the gCLI:

```text
git checkout https://github.com/donCannoli-burns/mall-manager.git
```

That installs the repository's `scripts/` and `relay/` files into the matching KoLmafia directories.

To update later:

```text
git update mall-manager
```

Then either run:

```text
call store-reprice.js
```

or choose **store_reprice** / **store-reprice** (label depends on Mafia's menu rendering) from the relay-browser script dropdown.

The relay dashboard does not need or replace `backoffice.ash`; it reads the native backoffice page itself, so it can coexist with JimmyKing's relay project.

## Data written

KoLmafia preferences:

- `storeRepriceLastRunMs`
- `storeRepriceLastPricegunRequestMs`
- `storeRepriceLastResult`
- `storeRepriceLastChangedCount`

KoLmafia data file:

- `data/store-reprice-changes.tsv` (bounded to the most recent 2,000 change rows)
- `data/store-reprice-pricegun-throttle.txt` (shared last-Pricegun-request timestamp)

## Testing first

Before using it live, validate the scripts in KoLmafia and verify your current build exposes the expected functions:

```text
jsref repriceShop
jsref batchOpen
jsref batchClose
jsref formFields
```

You can also run the script against a store containing only a couple of inexpensive test items first.
