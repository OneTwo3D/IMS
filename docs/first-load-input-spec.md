# First-load input spec and preparation tool

This is the technical reference for `scripts/first-load-prepare.ts` (`npm run first-load:prepare`), the file-in, file-out step that turns the
incumbent systems' exports into files the **existing** CSV importers can load, and says in a report what it did to every row.

`first-load:prepare` is pure: **no database, no network**. It reads the files named in a run manifest and writes into an output directory. It never loads anything
anywhere; uploading the files through the importers (dry-run preview first) is a separate, deliberate step. The one command that makes requests is the separate, read-only
`first-load:woo-snapshot` (see "WooCommerce snapshot command"), which only produces an input file for it.

Scope of this tool and what is still open:

- Built: the canonical input datasets, the validators and transforms, the report, the CLI, and the **real column maps for the four Qoblex exports**
  (`tests/first-load/fixtures/qoblex-native/maps/`, see "Qoblex native exports").
- **Where each system's data comes from.** Qoblex has no API, so **Qoblex is the one file-based load, and it goes through this tool.** Xero (chart of accounts,
  tax rates, trial balance), Mintsoft (products, stock) and WooCommerce (products, orders, tax rates, order statuses) are read **through the existing read-only
  connectors, as separate steps**; this tool has no column maps for them and none are planned. The `wms-*` and `woo-products` datasets stay in the tool only so the R14
  coverage check can be rehearsed offline from files (the maps under `tests/first-load/fixtures/maps/` use **invented headers** to prove the mechanism; do not copy a
  header from them into a real map). In a real run the coverage inputs come from the connectors.
- **Variant parents come from WooCommerce, through a read-only command.** Qoblex exports variants with no parent. `npm run first-load:woo-snapshot` reads WooCommerce's products (every type and
  status) and the variations of its variable products (GET requests only) and writes `variant-parents.csv` and `woo-product-status.csv`; this tool joins each Qoblex variant to the
  variation with the **same SKU** and emits the parent once as a VARIABLE product, and takes the lifecycle of a simple, KIT or BOM product from its own WooCommerce status. See
  "WooCommerce snapshot command", "Dataset: variant-parents" and "Dataset: woo-product-status".
- **The apply runner is separate.** What loads these files into an empty installation (reading and verifying a prepared run, the residual, plan, apply and resume) is described in [first-load-apply.md](first-load-apply.md). Its core, the database side, the verification, the command and the readiness-gate check exist.
- Not covered by an importer, so not produced: supplier product costs (`SupplierProduct` has no CSV importer) and customers (no source is defined for them
  in this work). Both are reported as gaps in the summary at the end of this page.

## Quick start

```bash
npm run first-load:prepare -- --manifest path/to/run.json --dry-run
npm run first-load:prepare -- --manifest path/to/run.json --out path/to/new-empty-dir --run-id load-2026-10-01
npm run first-load:prepare -- --help
```

`--dry-run` validates and prints the Markdown report and the accounting table, and writes nothing. `--out` writes the import files and the report
(`validation-report.json`, `validation-report.md`); the directory must not exist or must be empty. `--run-id` is an explicit label recorded in the report.
It is the only run-specific text in any output: no timestamp, host name or process id is ever written.

## Exit codes

One table, defined once in `lib/first-load/spec.ts` (`EXIT_CODE_TABLE`) and printed by `--help`.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | The run finished with no blocking finding in the datasets that were supplied. Import files were written (unless --dry-run). This is NOT a statement about datasets that were not supplied: the report lists them under "Not supplied". |
| 1 | BLOCKING_FINDINGS | The run finished and found at least one rejected row or blocking finding. The report was written (or printed with --dry-run); NO import file was written, so a partial load cannot be uploaded by mistake. |
| 2 | USAGE | Bad command line or an invalid run manifest. Nothing was read or written. |
| 3 | INPUT_UNUSABLE | An input file or column map cannot be used as-is: missing, not valid UTF-8, malformed CSV, a mapped header absent or ambiguous, or an invalid column map. Nothing was written. |
| 4 | OUTPUT_FAILED | The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again. |
| 5 | INTERNAL | A self-check of this tool failed (row accounting did not reconcile, or an emitted file broke an importer limit). This is a defect in the tool, not in the data. No import file was written; the report is, so the failure can be read. |

## The run manifest

A JSON file. Relative paths are relative to the manifest. Unknown keys are refused.

```json
{
  "formatVersion": 1,
  "baseCurrency": "GBP",
  "asOf": "2026-10-01",
  "inTransitConvention": "counted-in-source",
  "purchaseOrderKeyPrefix": "QBX-",
  "transferKeyPrefix": "QBX-",
  "inputs": [
    { "dataset": "products", "file": "qoblex/products.csv", "columnMap": "maps/qoblex.map.json" },
    { "dataset": "sku-exclusions", "file": "canonical/sku-exclusions.csv" }
  ]
}
```

With a `variant-parents` input the manifest also names the snapshot the file was written from (see "Variant parents are bound to the verified snapshot" below):

```json
  "wooSnapshot": { "snapshot": "woo/woo-snapshot.json", "provenance": "woo/woo-snapshot.provenance.json", "origin": "https://shop.example", "visibilityChecked": { "allProducts": { "publish": 1500, "draft": 40, "private": 12, "pending": 1 }, "products": { "publish": 120, "draft": 4, "private": 2, "pending": 0 }, "variations": { "publish": 940, "draft": 6, "private": 3, "pending": 0 } } },
```

- `baseCurrency` is required and never assumed. It must be the organisation's base currency in IMS; the tool cannot read IMS, so the apply step must check it.
- `asOf` is optional (YYYY-MM-DD). It is only used to date-check transfers. The tool never reads a clock.
- `maxPurchaseTaxRate` is required when a purchase-order-lines or a suppliers dataset is supplied (the apply step holds every supplier's default tax rate to it as well): the highest purchase tax rate, as a fraction (`"0.25"`), that any IMS tax rate or supplier default could apply. The importer resolves tax rates by name inside IMS, which this tool cannot read, so every order's total is bounded with this rate and a line whose `taxRateValue` is above it is rejected. It is an assertion the apply step must check against IMS.
- `requireVariantParents` (optional, `true` or `false`, default `false`) makes the WooCommerce join mandatory: **every emitted VARIANT, including one whose `parentSku` the products file already names, needs an accepted exact-SKU WooCommerce variation**, or it is rejected as `VARIANT_PARENT_UNCONFIRMED` (with no `variant-parents` dataset supplied that is every variant). Supplying the `variant-parents` dataset implies `true`. A prefilled `parentSku` that disagrees with WooCommerce is rejected on both sides.
- `wooSnapshot` (an object with `snapshot` and `provenance`, both paths, and `origin`, the WooCommerce store the snapshot must have come from) is **required whenever a `variant-parents` or `woo-product-status` input is listed**: it is how the manifest points at the verified snapshot and the provenance that `first-load:woo-snapshot` wrote beside `variant-parents.csv`. `origin` is **an expectation the operator declares** (normalised: scheme, lower-case host, default port dropped, any path ignored); the binding checks it against the origin the provenance recorded, so a valid bundle taken from staging or another shop is refused even though its checksums and CSV are internally consistent. It is not proof of where the bytes were acquired (provenance is a file the operator holds), so write it from the shop you intend to load from, never by copying it out of the provenance. A `wooSnapshot` with no `origin` is refused (ERROR `VARIANT_PARENTS_NOT_BOUND`, or `PRODUCT_STATUS_NOT_BOUND` for `woo-product-status`). `visibilityChecked` is the operator's **attestation of what the real key must see**: the per-status counts (`publish`, `draft`, `private`, `pending`, each a whole number) of ALL products of every type (`allProducts`), of the variable products alone (`products`) and of their variations (`variations`) that WooCommerce's own admin shows (see "Operator check of the real key's visibility"). The per-status counts the walk recorded in the provenance must equal it exactly, or the dataset is refused; a missing `visibilityChecked` is refused too. This is what catches a key that is silently shown fewer draft or private rows, which no check inside the walk can see. It is read only for that binding (of either snapshot-derived dataset); with neither input it is ignored. See "Variant parents are bound to the verified snapshot".
- `lifecycleReview` (optional, an object `{"generation": <path>}`) names the generation record `first-load:lifecycle-review` wrote beside the owner lifecycle review sheet (`lifecycle-review.generation.json`). It is what the `lifecycle-decisions` input is bound to (see "Dataset: lifecycle-decisions" and "Owner lifecycle review sheet"); with it, **every product of the sheet's review set must carry a decision or a real prepare is blocked**. A `lifecycle-decisions` input without it is refused (`LIFECYCLE_DECISIONS_NOT_BOUND`). Any other key in the object is refused.
- `inTransitConvention` is required when a `transfers` dataset is supplied (see "In-transit stock").
- `purchaseOrderKeyPrefix` and `transferKeyPrefix` are required when the matching dataset is supplied. They are prefixed to every order or transfer key so a loaded
  reference cannot collide with a reference IMS generates later.
- An input with `columnMap` is a native export read through that map; an input without it must already be a canonical file (below).
- A dataset may be listed more than once, once per file (the same file twice is refused). The files are read in the order listed and their records are concatenated.
  Line numbers of the second and later files are reported as `N * 1,000,000 + the physical line` (the first file is 0). An input may carry `"supersedesEarlier": true`
  (products only, and only after an earlier file for the same dataset): a product row in an EARLIER file with the same SKU (upper-case) is then replaced by the row in this file, and
  each replaced row is booked as excluded with the code `SUPERSEDED_BY_LATER_FILE`, so the accounting still reconciles. **The rows are merged field by field, not swapped:** a field the later file leaves blank or does not read (barcode, active, ...) keeps the earlier value (the excluded row's reason lists what was kept); a later non-blank value fills an earlier blank; a non-blank field that DIFFERS between the files (name, barcode, ...) rejects the later row as `SUPERSEDE_CONFLICT` with the field names; and the type may only change SIMPLE to KIT or BOM, or VARIANT to KIT or BOM (a WooCommerce variation with a recipe: it keeps its parent and loads as a KIT or BOM product under it, see "Dataset: recipe-overrides"; reported as INFO `VARIANT_CARRIES_RECIPE`). Without the flag, two files naming one SKU are two conflicting
  rows, which the products check refuses. This is how Qoblex's bundles file (which knows a product is a KIT or BOM) corrects the type the stock report gives the same SKU (SIMPLE).

## Canonical datasets

A canonical CSV is UTF-8, comma-separated, with a header row of exactly these column names. Optional columns may be left out of the header. An unknown
or repeated column is refused. Values are trimmed. A native export is converted into this shape by a column map; everything after that is the same.

### Dataset: products

Qoblex is authoritative. Becomes the products import file.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Product SKU. |
| `name` | yes | Product name. |
| `type` | yes | One of SIMPLE, VARIABLE, VARIANT, KIT, BOM, NON_INVENTORY. The type is never defaulted. |
| `parentSku` | no | Required for a VARIANT (a loaded VARIABLE product); refused on any other type. |
| `category` | no | Category name, at most 100 characters once cleaned. The importer cleans it (HTML entities, NFKC, whitespace) and merges spellings that differ only by case, accents or whitespace into one category; the report warns about both. |
| `description` | no | Passed through as given (trimmed). |
| `barcode` | no | Text; leading zeros are kept. A barcode shared by two products rejects both. |
| `mpn` | no | Passed through as given (trimmed). |
| `countryOfOrigin` | no | Passed through; the importer normalises it and only warns on an unrecognised value. |
| `weight` | no | Plain decimal, at most 4 decimal places (Decimal(10,4)). |
| `widthCm` | no | Plain decimal, at most 2 decimal places (Decimal(10,2)). |
| `heightCm` | no | Plain decimal, at most 2 decimal places (Decimal(10,2)). |
| `depthCm` | no | Plain decimal, at most 2 decimal places (Decimal(10,2)). |
| `salesPriceBase` | no | Plain decimal, base currency, at most 4 decimal places (Decimal(12,4)). |
| `salePriceBase` | no | Plain decimal, base currency, at most 4 decimal places (Decimal(12,4)). |
| `salesPriceTaxInclusive` | no | TRUE or FALSE. |
| `stockUnit` | no | Passed through as given (trimmed). |
| `imageUrl` | no | Passed through as given (trimmed). |
| `active` | no | TRUE or FALSE (also accepts yes/no/1/0/y/n). Anything else is refused: the importer would silently read it as FALSE. |
| `lifecycleStatus` | no | DRAFT, ACTIVE, EOL or ARCHIVED. |

### Dataset: recipe-lines

One row per KIT or BOM component line. Becomes the `components` cell of the parent in the products file (`SKU:qty;SKU:qty`), which the importer writes to
both recipe representations.

| Column | Required | Meaning |
| --- | --- | --- |
| `parentSku` | yes | A KIT or BOM product that is loaded. |
| `componentSku` | yes | A product that is loaded (or already in IMS). May not contain `:` or `;`. |
| `qty` | yes | Greater than zero, at most 4 decimal places. |
| `sortOrder` | no | Whole number; lines are ordered by it, then by component SKU. |

### Dataset: stock-lots

FIFO lots on hand per SKU and warehouse. A row with `qty` 0 states "zero on hand". Collapsed to one weighted-average row per SKU and warehouse.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Passed through as given (trimmed). |
| `warehouseCode` | yes | The IMS warehouse code (map the source's warehouse names with `valueMaps`). Upper-cased. The tool cannot check that the code exists in IMS. |
| `qty` | yes | Plain decimal, zero or more, at most 6 decimal places. Negative is refused. |
| `unitCost` | no | Required for a lot with stock. In `currency`; at most 10 decimal places. |
| `currency` | yes | 3-letter code. |
| `fxRateToBase` | no | Blank (or 1 for the base currency). A foreign lot's rate is the `fx_rates` rate at the end of its `receivedDate`, read from the `ims-fx-rates` list by the central rule; a rate stated here is a claim that must equal it exactly (`FX_RATE_NOT_TABLE_RATE`, also within 1%), and a non-positive or unreadable one is `BAD_FX`. Foreign units per ONE base unit: base cost = cost / rate. |
| `receivedDate` | no | `YYYY-MM-DD`. Required for a lot in a foreign currency (`MISSING_RECEIVED_DATE`, `BAD_DATE`): its rate is looked up as of the END of that day, UTC (`FX_RATES_NOT_SUPPLIED` with no `ims-fx-rates` list, `FX_RATE_MISSING` with no row on or before that day). Informational for a base-currency lot. |
| `lotRef` | no | Lot reference. Rows of one SKU and warehouse with the same quantity and cost are told apart ONLY by distinct, non-blank references: the same reference twice (spelling, case, spaces and zero-width characters ignored) is refused, and so are such rows when any of them has no reference. |

### Dataset: suppliers

Becomes the suppliers import file. `prepaid` and the accounting contact id are not importer columns and are never set: set `prepaid` by hand, only for
genuine deposit suppliers, and let IMS resolve the contact id.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Looked up by name, case-insensitively (upper-case in the purchase-order importer, lower-case in the supplier importer). An exact duplicate row with identical data loads once; the same name with different data, or two spellings that collide under either rule (`Acme` / `ACME`, `Straße` / `STRASSE`), reject every row involved, and so does any purchase order line naming them. |
| `contactName` | no | Passed through as given (trimmed). |
| `email` | no | Passed through as given (trimmed). |
| `phone` | no | Passed through as given (trimmed). |
| `currency` | no | 3-letter code. **A supplier row must state it (the column is optional in a file but a blank cell is refused):** a blank is rejected as `MISSING_CURRENCY`, never defaulted, because the supplier importer would otherwise default it silently (the base currency on create). A base-currency supplier says `GBP`. A malformed code is `BAD_CURRENCY`. |
| `vatNumber` | no | Passed through as given (trimmed). |
| `accountNumber` | no | Passed through as given (trimmed). |
| `paymentTermsDays` | no | Whole number of days. |
| `addressLine1` | no | Passed through as given (trimmed). |
| `addressLine2` | no | Passed through as given (trimmed). |
| `city` | no | Passed through as given (trimmed). |
| `county` | no | Passed through as given (trimmed). |
| `postcode` | no | Passed through as given (trimmed). |
| `country` | no | Passed through as given (trimmed). |
| `notes` | no | Passed through as given (trimmed). |
| `purchaseTaxType` | no | The supplier's default purchase tax rate, as a **Xero tax type** from the closed list `INPUT2`, `ZERORATEDINPUT`, `NONE` (Xero is the tax-rate master; custom `TAX001..` ids are per-organisation and refused). **A supplier row must state it:** blank is `MISSING_PURCHASE_TAX_TYPE`, any other value `UNSUPPORTED_PURCHASE_TAX_TYPE`. The importer resolves it to **exactly one** active IMS tax rate with `usedFor` `PURCHASE` or `BOTH` and that `accountingTaxType`, and sets the supplier's tax rate to it; with an `ims-tax-rates` list the tool resolves it at prepare time too: no such rate is `NO_IMS_PURCHASE_TAX_RATE`, several are `AMBIGUOUS_IMS_PURCHASE_TAX_RATE`. Never guessed by rate name. |

### Dataset: purchase-order-lines

Reduced to the outstanding quantity per line.

**The file carries no currency and no rate.** An order's currency is the currency of its supplier in the same run's suppliers dataset (so an order whose currency differs from its supplier's cannot arise; it is not refused, because it cannot exist). A supplier with no currency is impossible (`MISSING_CURRENCY` rejects the supplier row first); `SUPPLIER_CURRENCY_MISSING` guards it anyway. The rate of a foreign order is read ONLY from IMS's `fx_rates`, through the `ims-fx-rates` list and the central rule (the latest row at or before the end of the `createdOn` day, UTC; a tie of different rates, or a zero, negative or unreadable row, refuses): `FX_RATES_NOT_SUPPLIED` (no list), `FX_RATE_MISSING` (no row on or before that day), `FX_RATE_UNUSABLE` (a bad or ambiguous row, or more than 8 decimal places). A rate is never taken from a file or defaulted. The written rate is foreign units per ONE base unit; the importer divides by it.

| Column | Required | Meaning |
| --- | --- | --- |
| `orderKey` | yes | The incumbent's PO number. Written as `<purchaseOrderKeyPrefix><orderKey>`. |
| `supplierName` | yes | Must be in the suppliers dataset OF THE SAME RUN (`SUPPLIER_NOT_IN_FILE` otherwise, also when the supplier exists only in the ims-suppliers list: its currency is not known here). Matched the way the purchase-order importer matches (trimmed, upper-cased), after the suppliers dataset's own collision rules (a rejected or colliding supplier is `SUPPLIER_ROW_REJECTED`). |
| `status` | no | OPEN (default if blank), CLOSED or CANCELLED. Anything not OPEN is excluded. |
| `createdOn` | no | The order's created date, `YYYY-MM-DD` (a native `Created on` converts through `dateFormats`). Required for an order in a foreign currency (`MISSING_CREATED_DATE`, `BAD_DATE`): the rate is looked up as of the END of that day, UTC. Not read for a base-currency order. |
| `destinationWarehouseCode` | no | Passed through as given (trimmed). |
| `sku` | yes | Passed through as given (trimmed). |
| `lineNo` | no | The incumbent's line number. When an order repeats a SKU, EVERY such row must carry a non-blank line number and no two may share one; otherwise all of them are rejected as duplicates. A blank, space or zero-width value never makes a row distinct. |
| `qtyOrdered` | yes | At most 4 decimal places. |
| `qtyReceived` | yes | At most 4 decimal places. |
| `unitCostForeign` | yes | At most 6 decimal places and 9 integer digits. |
| `lineDiscountPercent` | yes | The line's discount percent (0 to 100, at most 6 decimal places). REQUIRED: a column map that omits it is refused, it must be mapped DIRECTLY to a source column (a constant, a `derived` entry or a `valueMaps` entry is refused, `VALUATION_COLUMN_NOT_DIRECT`; the same holds for `unitCostForeign`, `qtyOrdered`, `qtyReceived`, the stock-lot `qty`, `unitCost` and `fxRateToBase`, and the transfer quantities), a map for a file with the `Discount (%)` header must map it to exactly that header, and a discount-looking header (`disc`, `rabatt`, `remise`, `sconto`, `descuento`) that the map leaves unread blocks the run (`DISCOUNT_COLUMN_NOT_READ`). Never applied: an OPEN line with a non-zero value is refused as `PO_LINE_DISCOUNT_NOT_SUPPORTED`, a value that is not a number in 0 to 100 is `BAD_DISCOUNT`, a blank is 0, and a line with nothing outstanding or not open is not judged. |
| `taxRateName` | no | Matched to an IMS tax rate case-insensitively. A line gives a name OR a `taxRateValue`, never both (the importer resolves the name first and falls back to the value; the tool cannot read IMS to show they agree). |
| `taxRateValue` | no | Percent or fraction as the importer reads it (above 1 means percent); as a fraction at most 4 decimal places (Decimal(5,4)) and not above `maxPurchaseTaxRate`. |
| `pricesIncludeVat` | no | TRUE or FALSE. |
| `supplierRef` | no | Passed through as given (trimmed). |
| `expectedDelivery` | no | YYYY-MM-DD. |
| `notes` | no | Passed through as given (trimmed). |

### Dataset: transfers

Only the in-transit remainder is emitted.

| Column | Required | Meaning |
| --- | --- | --- |
| `transferKey` | yes | Written as `<transferKeyPrefix><transferKey>`. |
| `status` | yes | DRAFT, IN_TRANSIT, PARTIALLY_RECEIVED, RECEIVED, COMPLETED or CANCELLED. |
| `fromWarehouseCode` | yes | Passed through as given (trimmed). |
| `toWarehouseCode` | yes | Passed through as given (trimmed). |
| `sku` | yes | Passed through as given (trimmed). |
| `qtyShipped` | yes | At most 4 decimal places. |
| `qtyReceived` | yes | Passed through as given (trimmed). |
| `dispatchDate` | no | YYYY-MM-DD. Only used for a warning against `asOf`. |
| `notes` | no | Passed through as given (trimmed). |

### Dataset: wms-products

Used only for the four-way SKU coverage check. This is the 3PL's product export (today Mintsoft).

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Passed through as given (trimmed). |
| `wmsProductId` | no | Passed through as given (trimmed). |

### Dataset: wms-stock

Used for coverage and to find a SKU that holds stock in the 3PL but is missing from the Qoblex stock extract. This is the 3PL's stock-level export (today Mintsoft).

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Passed through as given (trimmed). |
| `warehouseCode` | no | Passed through as given (trimmed). |
| `qty` | yes | Plain decimal, zero or more. Rows for one SKU are summed. This is the 3PL's **on-hand** quantity (Mintsoft `TotalStockLevel`), not its available quantity (`Level`, on hand minus units allocated to open orders): a SKU whose units are all allocated still holds stock and must not read as zero. |

### Dataset: woo-products

Used only for the four-way SKU coverage check. WooCommerce is never a source for recipes.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | A row without a SKU is excluded (and reported). |
| `wooProductId` | no | Passed through as given (trimmed). |
| `type` | no | Passed through as given (trimmed). |
| `status` | no | The product's own WooCommerce post status (`publish`, `draft`, `pending`, `private`). **When present it decides the IMS lifecycle** of a simple, KIT, BOM or NON_INVENTORY product (owner ruling 2026-11-21, "Use Woo's status as gospel"): `draft`, `pending` and `private` load as DRAFT; `publish` loads as ACTIVE, except that a Qoblex Inactive (EOL) product stays EOL (EOL still pushes `publish`, so nothing flips). This overrides the Qoblex State, Archived included. Every product whose lifecycle differs from the Qoblex one is reported as an INFO `LIFECYCLE_TAKEN_FROM_WOO` (SKU, Qoblex state, Woo status, result) and counted in `LIFECYCLE_TAKEN_FROM_WOO_COUNT`; a mismatch is never a warning or an error. A product listed here with a blank or unmapped status keeps the Qoblex lifecycle and is listed in the warning `LIFECYCLE_WOO_STATUS_UNUSABLE` (nothing is reported when no row carries a status at all: the column is simply absent). A product not listed here keeps the Qoblex lifecycle. **The real load takes the status from `woo-product-status` instead** (the bound snapshot dataset, below); where both name a SKU the snapshot wins. A SKU repeated here with two different statuses is decided after the sources are merged: ignored when the bound snapshot states the SKU (its status stands), a WARNING (`LIFECYCLE_WOO_STATUS_CONFLICT_UNUSED`) when the SKU is not a catalogue simple, KIT, BOM or NON_INVENTORY product, and an ERROR (`LIFECYCLE_WOO_STATUS_CONFLICT`, none taken) only for a catalogue product left with no status; a blank status beside a stated one is no statement. |

### Dataset: variant-parents

One row per WooCommerce variation: the variation's SKU and the VARIABLE parent it belongs to. Written by `first-load:woo-snapshot` (see "WooCommerce snapshot command"); read as a canonical file. Qoblex variants are joined to it by **exact variation SKU** (letter case ignored); each parent reached becomes one VARIABLE row in the products file.

| Column | Required | Meaning |
| --- | --- | --- |
| `variantSku` | yes | The variation's SKU. A repeat (letter case ignored) with different data rejects every row that carries it. |
| `wooVariationId` | no | WooCommerce's id for the variation (digits). Informational; carried so the connector link step can use it later. |
| `parentSku` | yes | The parent's SKU. It must not be the SKU of any Qoblex product (other than a VARIABLE product the products file itself carries), of any variation, or of any product already in IMS (`PARENT_SKU_COLLIDES`). |
| `parentName` | yes | The parent's WooCommerce title: it becomes the VARIABLE product's name. Variants keep the Qoblex name. |
| `parentStatus` | yes | WooCommerce post status, mapped to the parent's lifecycle status by a closed list (status = lifecycle): `publish` = ACTIVE, `draft` = DRAFT, `pending` = DRAFT, `private` = DRAFT. Any other status rejects its rows (`UNMAPPED_PARENT_STATUS`). The owner confirms this mapping before the real load. |
| `wooParentId` | no | WooCommerce's id for the parent (digits). All variations of one parent must agree on the parent's SKU spelling, title, status and id, or the parent is rejected with all of them (`PARENT_ATTRIBUTE_CONFLICT`). |
| `variationStatus` | no | **Effectively required** (a blank cell, or a file without the column, refuses every row it touches). The variation's OWN WooCommerce post status, mapped by the same closed list as `parentStatus` (any other value rejects the row as `UNMAPPED_VARIATION_STATUS`; a blank one rejects it as `MISSING_VARIATION_STATUS`). **This decides the IMS lifecycle** of the joined variation (VARIANT, or a KIT/BOM variation): `draft`, `pending`, `private` load as DRAFT, `publish` as ACTIVE (a Qoblex EOL stays EOL), whatever the Qoblex State and whatever the parent's status (the parent is context only). Written by the snapshot command: a `variant-parents.csv` from a snapshot taken before this column existed (6 columns) is refused when the snapshot is verified, with a message saying so; take the snapshot again. |

**Variant parents are bound to the verified snapshot.** `variant-parents.csv` decides which parent a Qoblex variant is loaded under, so it is never accepted on its own. Before any parent is taken from it, `first-load:prepare` reads the snapshot and provenance the manifest names as `wooSnapshot`, verifies the snapshot (its checksum and consistency rules), **regenerates the rows from it with the same builder that wrote the CSV**, and requires all of: the provenance records the SHA-256 of the snapshot file and of `variant-parents.csv` and both match the bytes on disk; **the provenance's recorded store origin equals the origin the manifest declares as `wooSnapshot.origin`** (no declared origin is a refusal); the CSV is **byte-identical** to the regenerated rows. Exactly one `variant-parents` file, with no column map, must be listed. If any of that fails (a stale CSV, a hand-edited parent SKU, a CSV from another snapshot, a missing or incomplete provenance, a tampered snapshot, a manifest with no `wooSnapshot`, a bundle recorded from a different store than the declared origin, a `wooSnapshot` with no `origin`) the whole dataset is **refused**: ERROR `VARIANT_PARENTS_NOT_BOUND` (the problems are listed, bounded, and never echo file content), every row is excluded as `NOT_BOUND_TO_SNAPSHOT`, **no parent assignment is accepted and no VARIABLE parent is emitted from it**, and each Qoblex variant is rejected (`VARIANT_WITHOUT_PARENT` or `VARIANT_PARENT_UNCONFIRMED`). The same check runs offline as `first-load:woo-snapshot --verify`. Re-run the snapshot command (or restore the files) rather than editing the CSV.

How a row ends: `VARIATION_JOINED` (emitted) when a Qoblex VARIANT, KIT or BOM has that SKU. **A KIT or BOM that WooCommerce lists as a variation by exact SKU joins its parent exactly like a VARIANT** (owner ruling: IMS holds a variation with a recipe as a KIT or BOM product with a VARIABLE parent; it is reported as INFO `VARIANT_CARRIES_RECIPE`, one key per SKU, and refused as `VARIANT_PARENT_UNCONFIRMED` when the join is required and WooCommerce does not confirm it). A KIT on a variation ignores its stock-report on-hand as for any KIT (INFO `KIT_STOCK_IGNORED`, `KIT_STOCK_IGNORED` disposition on the stock row). Excluded, with a reason: `NO_QOBLEX_PRODUCT` (WooCommerce has a variation Qoblex does not; the R14 coverage check lists it unless it is on `sku-exclusions`),
`QOBLEX_TYPE_NOT_VARIANT` (Qoblex types the SKU as a type that cannot sit under a variable parent, such as a simple or non-inventory product: it loads with that type and no parent, and the connector link step relates it to the variation later; this is an INFO finding, not an error),
`QOBLEX_ROW_REJECTED`, `EXCLUDED_BY_LIST` and `PARENT_EXCLUDED_BY_LIST`. When the dataset is refused (above), every row is excluded as `NOT_BOUND_TO_SNAPSHOT`.

A VARIABLE product the products file itself carries keeps its row, but **WooCommerce's title and mapped lifecycle are written** (INFO `PARENT_ATTRIBUTES_FROM_WOO` lists any that differed).

Findings: `VARIANT_PARENTS_NOT_BOUND` (ERROR: the dataset is not the rows regenerated from a verified snapshot; nothing was taken from it), `VARIANT_PARENT_UNCONFIRMED` (ERROR: the join is required and a variant has no accepted WooCommerce variation), `FORMULA_LEADING_CELL` (WARNING, on the products and suppliers import files: a cell starts with a character a spreadsheet reads as a formula; the import files are never altered for that, so do not open and re-save them in a spreadsheet), `VARIANT_WITHOUT_PARENT` (ERROR: a Qoblex variant no WooCommerce variation matches; it is never loaded as a simple product, so fix the SKU in Qoblex or WooCommerce or exclude it with a reason),
`WOO_PARENT_WITHOUT_QOBLEX_VARIANT` (WARNING: a WooCommerce variable product none of whose variations is a Qoblex variant; it is **not** loaded, so exclude it with a reason or load it later through the connector link step; a parent that is on the exclusion list, or all of whose variations are, is not reported),
and `PARENT_STEM_MISMATCH` (WARNING: a variant whose "-NN" SKU stem is not its real parent's SKU; **the stem is only compared, never used to assign a parent**).

### Dataset: woo-product-status

One row per WooCommerce **product with a SKU, of any type** (simple, variable, grouped, external, plugin types), with its OWN status. Written by `first-load:woo-snapshot` and **bound to the verified snapshot exactly like `variant-parents`** (below); read as a canonical file (listed once, no column map). A variation is not a product here: its status is `variationStatus` in `variant-parents`.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | The product's SKU as WooCommerce holds it (trimmed). A product without a SKU is not listed; the provenance counts them (`proof.allProducts.withoutSku`). |
| `wooProductId` | no | The WooCommerce product id. |
| `type` | no | The WooCommerce product type (`simple`, `variable`, `grouped`, `external`, ...). |
| `status` | yes | The product's own WooCommerce post status: `publish`, `draft`, `pending` or `private` (the snapshot refuses any other). |
| `stockQuantity` | no | WooCommerce's `stock_quantity` when the product manages stock, otherwise blank (a managed zero is `0`). **A point-in-time read (the first walk's), for information only**, carried for the owner lifecycle review; **not loaded**. |
| `name` | no | The product title. Untrusted text: the file is data and is never altered for a spreadsheet (the provenance counts the cells a spreadsheet would read as a formula in `productStatusFormulaLeadingCells`). |

**What it does.** The lifecycle of a Qoblex simple, KIT, BOM or NON_INVENTORY product (not a variation, not a VARIABLE parent: those come from `variant-parents`) is its own WooCommerce status (owner ruling 2026-11-21, "Use Woo's status as gospel"): `private`, `draft` and `pending` load as DRAFT; `publish` loads as ACTIVE, except that a Qoblex Inactive (EOL) product stays EOL. A joined variation always takes its own `variationStatus`, never a row here (a test pins it). `LIFECYCLE_NOT_FROM_WOO` (WARNING, with the SKUs) now lists only the simple, KIT, BOM or NON_INVENTORY products WooCommerce does not hold (no row here and none in `woo-products`); with no status source at all it lists every one of them, and when this dataset was supplied but refused (`PRODUCT_STATUS_NOT_BOUND`) the warning says so instead of "not supplied". **One predicate decides both which products take their own WooCommerce status and which a status conflict blocks**: every catalogue product that is not a VARIABLE parent and not a variation (SIMPLE, KIT, BOM and NON_INVENTORY), so a conflict on a NON_INVENTORY product is the blocking `LIFECYCLE_WOO_STATUS_CONFLICT`, not the non-blocking `LIFECYCLE_WOO_STATUS_CONFLICT_UNUSED`. `LIFECYCLE_WOO_STATUS_UNUSABLE` names the dataset the unusable status was read from (`woo-product-status` or `woo-products`; one finding per dataset). The conflict message says which source is missing: no `woo-product-status` supplied, supplied but refused, or bound but not stating the SKU. **The owner's lifecycle decisions (`lifecycle-decisions`, below) take precedence over all of this.**

**Why a dataset of its own and not a status column on `woo-products`.** `woo-products` is a hand-made, column-mapped export that nothing verifies; letting it carry a bound, snapshot-derived status would blur which rows are trusted. `woo-product-status` is canonical and byte-identical to what the verified snapshot regenerates, so a lifecycle is never taken from a file that is not proved to be the snapshot. (`woo-products` remains the rehearsal input for R14 coverage.)

**Bound to the verified snapshot.** Same rules as "Variant parents are bound to the verified snapshot": the provenance records the SHA-256 of `woo-product-status.csv` (`productStatusFile`) and it must match the bytes on disk, and the file must be **byte-identical** to the rows regenerated from the verified snapshot. A stale, edited or foreign file, a manifest with no `wooSnapshot`, or a snapshot of format 1 (taken before every product's status was read: the message says so and to re-run the snapshot) refuses the whole dataset: ERROR `PRODUCT_STATUS_NOT_BOUND`, every row excluded as `NOT_BOUND_TO_SNAPSHOT`, no lifecycle taken. `PRODUCT_STATUS_NEEDS_CATALOGUE` (ERROR) when the Qoblex products dataset is missing. Each row is reported: `WOO_STATUS_ROW` (emitted: read from the verified snapshot) or `BAD_SKU`. The report's "WooCommerce product status" section gives the rows read, whether the dataset was bound and how many Qoblex products matched. The apply runner re-verifies it (`wooSnapshot.productStatus` in the apply manifest, see first-load-apply.md).

### Dataset: sku-exclusions

The explicit, owner-accepted exclusion list. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | A SKU listed here is deliberately not loaded and is exempt from the coverage check. |
| `reason` | yes | Written reason. An exclusion without one is refused. |

### Dataset: non-stock-skus

Owner decision list: SKUs that are intangible or otherwise non-stock (inventory is disabled for them in the source, so the source gives them a type such as `Unknown`, which a closed type list refuses). A SKU listed here loads as **NON_INVENTORY** when the source does not state a stock-bearing type: the map's `nonStock` entry fills the source's kind cell (for the Qoblex stock report, `Product Type` becomes `non-inventory`) **only when that cell is blank, `Unknown` or already non-inventory**, so the product type is not required for it, and its stock-lot rows are skipped and counted like any other non-inventory row (a stock cell on it is ignored, never rejected; a nonzero quantity is reported as INFO `NON_STOCK_QTY_IGNORED`). **A source that states any other type (simple, variable, kit, bom, ...) contradicts the decision: that row is refused as `NON_STOCK_DECISION_CONFLICT`** (a SKU wrongly listed would otherwise lose its stock silently); fix the source or remove the SKU from the list. Matched on the trimmed, upper-cased SKU. Always a canonical file. A SKU that appears in no input is the warning `STALE_NON_STOCK_DECISION`.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | The non-stock SKU (for example the EMU License Fee, the gift card and the fee product). |
| `reason` | yes | Written reason. A decision without one is refused. |

### Dataset: sku-name-overrides

Owner decision list: the SKU of a source row whose SKU cell is blank, found by the **exact product name** (trimmed; the map names the header in `nameColumn`). Only a blank SKU cell is ever filled; a row that already has a SKU is not touched. Without an override, a row with a blank SKU is refused as `BLANK_SKU` and the reason **names the product**, so the operator can add the SKU here (or fix it in the source). Always a canonical file. The override supplies the SKU only: the row still has to pass the map's type and state lists.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The product name exactly as the source states it. |
| `sku` | yes | The SKU to use. |
| `type` | no | `KIT` or `BOM`: the product type the row has (the source types such a row `Unknown`). For a **KIT** the on-hand quantity on a stock-report row is Qoblex's computed availability of the bundle, not stock: it is **not loaded**, and the report says so (INFO `KIT_STOCK_IGNORED`, naming the SKU, the line and the quantity). |
| `reason` | yes | Written reason. |

### Dataset: supplier-overrides

Owner decision list: the currency and/or the purchase tax type of a supplier whose contact row leaves them blank (for example a supplier that has no currency and no tax class in the contact export). Matched on the trimmed supplier name, case-insensitively. **Only a blank cell is filled**: if the contact row states a different currency or tax type, the supplier is refused as `SUPPLIER_OVERRIDE_CONFLICT`; the override is never silently preferred. The filled values go through the same checks as a contact value (3-letter currency, the closed purchase tax type list, resolution against the IMS tax rates). An override that matches no supplier is `SUPPLIER_OVERRIDE_UNUSED` (excluded, no finding). Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The supplier name. |
| `currency` | no | 3-letter currency code to use when the contact row has none. |
| `purchaseTaxType` | no | `INPUT2`, `ZERORATEDINPUT` or `NONE` (no tax) to use when the contact row has none. At least one of `currency` and `purchaseTaxType` is required. |
| `reason` | yes | Written reason. |

### Dataset: recipe-overrides

Owner decision list: the **complete recipe** of a KIT or BOM, one row per component line. It **replaces** every line the recipe export gives for that parent SKU (those export lines are set aside as `REPLACED_BY_RECIPE_OVERRIDE`, never merged), which is the way out when the flat bundles export loses a recipe (a header followed directly by another header, a recipe scattered or repeated in the file). **An override is all or nothing:** when any one line of an override is rejected (bad SKU, a component not in the catalogue, a zero quantity, a repeated component, a missing reason, a type mismatch), the **whole override of that parent is rejected** (`RECIPE_OVERRIDE_INCOMPLETE` on its other lines, ERROR `RECIPE_OVERRIDE_REJECTED` naming the parent) and the parent gets no recipe from this run: a partial recipe is never loaded, and the export lines the override set aside are not brought back. The override rows are checked exactly like export lines: the parent must be a KIT or BOM in the catalogue, every component SKU must exist in the catalogue (or in IMS), every quantity must be above 0, a component repeated for one parent is refused, and cycles are still found. Always a canonical file. The real override data belongs in the run's decisions directory, not in the repository.

| Column | Required | Meaning |
| --- | --- | --- |
| `parentSku` | yes | The KIT or BOM whose recipe this is. |
| `componentSku` | yes | A component SKU. |
| `qty` | yes | Quantity per parent, above 0. |
| `sortOrder` | no | Position in the recipe. |
| `type` | no | `KIT` or `BOM`: checked against the type the products file gives the parent; a difference is refused (`RECIPE_OVERRIDE_TYPE_MISMATCH`). The one allowed difference: `KIT` or `BOM` on a SKU the products file loads as a VARIANT gives that WooCommerce variation a recipe; it keeps its parent and loads as a KIT or BOM product under it (IMS holds a variation with a recipe as type KIT or BOM with a VARIABLE parent; INFO `VARIANT_CARRIES_RECIPE`). |
| `reason` | yes | Written reason. |

### Dataset: sku-renames

Owner decision list: a source SKU that is loaded under another SKU (for example the Qoblex `AV261-1-01` is `958523271-01` in WooCommerce, which is correct). Each rename is applied **first**, to every source dataset of the run (the SKU columns of products incl. `parentSku`, recipe lines and overrides incl. component SKUs, stock lots, purchase order lines, transfers, and the `non-stock-skus` and `sku-name-overrides` lists, which name source SKUs), so every join, check and output file sees the new SKU. The input files are not altered. The WMS, WooCommerce, variant-parents, IMS lists and `sku-exclusions` are the target side and are **not** renamed: state an exclusion by the SKU as it is loaded. Matched like every SKU (trimmed, upper-case). **A rename whose `fromSku` or `toSku` is on `sku-exclusions` is refused** (`RENAME_FROM_EXCLUDED` / `RENAME_TO_EXCLUDED`): an exclusion is the owner's record that the SKU is not loaded, and a rename must not silently override it. To keep a renamed product out, drop the rename and exclude the `fromSku`; to load it, remove the exclusion. Always a canonical file; it acts when the run is prepared, after every file is read, so its place in the manifest does not matter.

A rename is **refused, never guessed**: `BAD_SKU`, `MISSING_REASON`, `RENAME_TO_SELF`, `DUPLICATE_RENAME` (one `fromSku` listed twice, whatever the targets), `RENAME_TARGET_COLLISION` (two renames to one `toSku`), `RENAME_CHAIN` (a `toSku` that is itself renamed, a loop included: state the final SKU directly), `RENAME_TARGET_EXISTS` (the `toSku` already exists in a source dataset, so it would merge two products) and `RENAME_FROM_NOT_IN_SOURCE` (the `fromSku` is in no source dataset). An applied rename is `SKU_RENAMED` (the row, and an INFO finding with the cells changed per dataset); an accepted rename that changed no products row is the WARNING `SKU_RENAME_UNUSED`.

| Column | Required | Meaning |
| --- | --- | --- |
| `fromSku` | yes | The source SKU. |
| `toSku` | yes | The SKU it is loaded as. |
| `reason` | yes | Written reason. |

### Dataset: lifecycle-confirmations

**Obsolete since the owner ruling of 2026-11-21, "Use Woo's status as gospel".** The IMS lifecycle is now DERIVED FROM WOOCOMMERCE wherever the first load can see a WooCommerce status (a joined variation's own `variationStatus`; a simple, KIT or BOM product's `woo-product-status` or `woo-products` `status`), so there is no longer a lifecycle mismatch to confirm: the old blocking `LIFECYCLE_PUSH_WOULD_CHANGE_WOO_STATUS` error and the `LIFECYCLE_DISAGREES_WITH_WOO` and `STALE_LIFECYCLE_CONFIRMATION` warnings were removed, because a push writes the lifecycle back as the status it was taken from (DRAFT writes `draft`; ACTIVE and EOL write `publish`; WooCommerce `private` and `pending` are both unpublished and a push writes them back as `draft`), so it cannot change it. The mapping (it overrides the Qoblex State):

- WooCommerce `private`, `draft` or `pending`, whatever the Qoblex state: DRAFT.
- WooCommerce `publish` with Qoblex Inactive (EOL): EOL (EOL still pushes `publish`, nothing flips).
- WooCommerce `publish` with Qoblex Active, Archived or anything else: ACTIVE.
- No WooCommerce status visible (a product no variant-parents row names, or in neither `woo-product-status` nor `woo-products`, or no usable status there): the Qoblex-derived lifecycle, unchanged.

Each product whose lifecycle differs from the Qoblex one is an INFO `LIFECYCLE_TAKEN_FROM_WOO` (SKU, Qoblex state, Woo status, resulting lifecycle), plus one INFO `LIFECYCLE_TAKEN_FROM_WOO_COUNT` with the run's count. The result feeds every later check: a purchase-order line needs ACTIVE or DRAFT (`isPurchasableProductStatus`), a transfer refuses ARCHIVED, and `shouldForceWooZeroStock` stays ARCHIVED-only (a Woo-derived lifecycle is never ARCHIVED).

The dataset is still parsed so an existing manifest loads: every row is dispositioned EXCLUDED `LIFECYCLE_CONFIRMATION_NOT_NEEDED` ("no-op: lifecycle now taken from WooCommerce"), plus one INFO `LIFECYCLE_CONFIRMATIONS_NOT_NEEDED` with the row count; never an error. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | no | Ignored (a leftover row with a blank SKU is still only a no-op). |
| `reason` | no | Ignored. |

### Dataset: lifecycle-decisions

Owner decision list: the IMS lifecycle of each product on the **owner lifecycle review sheet** (`npm run first-load:lifecycle-review`, see "Owner lifecycle review sheet"). Listed once, with no column map, and read back from **the filled sheet itself (`.xlsx`)**, from **a CSV export of its Review tab** (UTF-8; every other column is ignored), or from a canonical file with the columns below; the shape is recognised from the content, not the file name. In the sheet the columns are "IMS SKU", "New IMS status", "Override reason" and "Sheet id". A cell holding a formula is refused (the file is unusable, exit 3): a decision is typed or picked from the list, never computed. So is a decision cell (IMS SKU, New IMS status, Override reason, Sheet id) holding U+FFFD, a character lost in a conversion (save the sheet again from the original); U+FFFD anywhere else (a product name from WooCommerce or Qoblex) is read and ignored.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | The SKU exactly as the sheet's "IMS SKU" shows it (IMS's SKU after the sku-renames). Matched exactly. |
| `status` | no | One of `Discontinued` (loads as EOL: sold, not ordered), `Archived` (ARCHIVED: neither), `Do not sell yet` (DRAFT: ordered, not sold) or `Active` (ACTIVE); letter case is ignored. Blank means "not decided yet". |
| `reason` | no | The override reason. Required to archive a product that holds stock (below); reported with the decision either way. |
| `sheetId` | no | The id of the sheet the decision was made on (`LR-` and 16 hex digits). Every decided row must carry the id of the sheet the manifest's `lifecycleReview.generation` describes. |

**Precedence: HIGHEST.** A decision is applied after the Qoblex-derived lifecycle and after every WooCommerce-derived one (`variant-parents`, `woo-product-status`, `woo-products`), so the decided lifecycle is what the products file carries and what every later check sees (a purchase order line needs ACTIVE or DRAFT, a transfer refuses ARCHIVED). Each applied row is EMITTED `LIFECYCLE_DECIDED` and reported as an INFO `LIFECYCLE_FROM_DECISION` (SKU, decision, lifecycle loaded, the lifecycle it replaces, the reason), with a count (`LIFECYCLE_FROM_DECISION_COUNT`).

**Refused (REJECTED, blocking; the lifecycle is left as it was):** a bad SKU; `UNKNOWN_SKU`, a SKU that is neither a row of the review sheet nor in this run's recomputed review set (below; a row added for any other product is never applied); `DUPLICATE_DECISION`, every row of a SKU listed more than once; `BAD_STATUS`, a status that is not one of the four; `PRODUCT_NOT_LOADED`, a SKU this run does not load (its product row was refused); **`ARCHIVED_WITH_STOCK`**: Archived for a SKU that holds stock, unless the row's reason is filled; with a reason it is applied and reported as the WARNING `ARCHIVED_WITH_STOCK_OVERRIDE` with every figure. A SKU holds stock when **any single figure** is above zero or was not read: **one Qoblex warehouse** (never the sum: +5 in one warehouse and -5 in another is stock), at generation or in this run's stock-lots (which may be a fresher export); the WooCommerce stock at generation (marked *stale* when this run reads another snapshot) and in this run's snapshot (taken for **every** product IMS loads, by IMS SKU: a product that was draft with stock 0 when the sheet was generated and has been published with stock since has left the review set, and its stale 0 cannot clear it; a Mintsoft-discontinued row carried from the sheet takes this run's figure too); the WMS physical stock at generation (the WMS is not read again; a figure not read, because the listing was not taken or the SKU is not on the sheet, cannot clear it). Each figure is named with where it comes from. And **`VARIATION_NOT_ARCHIVED`**: Archived for a VARIABLE parent while any of its variations would load with another lifecycle (after every other decision; no override reason lifts it: decide every variation Archived first); a parent's variations' stock counts as its own (`variation <SKU>: ...`). A SKU on `sku-exclusions` is EXCLUDED `SKU_EXCLUDED` (it is not loaded). A blank status is EXCLUDED `UNDECIDED`.

**Blank rows block the real prepare.** Every product of the sheet's review set that IMS loads must be decided: one left blank (or deleted from the export, or with no decisions file at all) is the **ERROR `LIFECYCLE_DECISION_MISSING`** with the SKUs in a real prepare, so nothing is written until it is decided; `--dry-run` reports it as a WARNING instead.

**The review set is recomputed from THIS run's inputs.** A fresher Qoblex export or WooCommerce snapshot may hold products that became Archived or draft after the sheet was generated. `first-load:prepare` recomputes the review set from its own inputs with the same rules the sheet is built with (Qoblex State Archived, a WooCommerce own or parent status that is not `publish`), plus the sheet's Mintsoft-discontinued rows (Mintsoft is not read again). Every member that is **not on the sheet** and has no decision row is the **ERROR `LIFECYCLE_REVIEW_SET_CHANGED`** naming each SKU and why (a WARNING in `--dry-run`). The fix is to generate the sheet again and have it filled, or to decide them: add a row for each to the decisions file (a canonical lifecycle-decisions row, or a row in the CSV export, carrying the sheet id). A run that cannot recompute the set (the WooCommerce snapshot did not verify) is the ERROR `LIFECYCLE_REVIEW_SET_UNCHECKED` (a WARNING in a dry run).

**Bound to one sheet generation.** The decisions are only taken from the sheet the manifest names: the generation record's digest is recomputed (an edited record is refused), every decided row's sheet id must be that record's, and an `.xlsx` must also carry the hidden binding tab with the record's sheet id and digest (a copied, rebuilt or other-generation workbook is refused). A decided row without a sheet id refuses the file too, even beside rows that carry the right one. Anything else refuses the whole dataset: ERROR `LIFECYCLE_DECISIONS_NOT_BOUND`, every row EXCLUDED `NOT_BOUND_TO_REVIEW`, no decision applied. A run whose products, stock-lots or WooCommerce snapshot differ from the ones the sheet was generated from is not refused (a fresher export is normal) but is never silent: WARNING `LIFECYCLE_REVIEW_INPUTS_CHANGED` names what changed and which figures an Archived decision is checked against are therefore stale (the sheet's Qoblex and WooCommerce figures, and always the Mintsoft one); this run's Qoblex stock and WooCommerce snapshot are checked as well, and its review set is recomputed (above). The generation record is **format 2** (each entry carries why it is in review, the Qoblex stock per warehouse and, for a VARIABLE parent, each variation's figures); a format 1 record is refused: generate the sheet again.

### Dataset: ims-suppliers

Supplier names that already exist in the target IMS. Omit it for an empty database. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | An existing supplier's name. A new supplier whose name collides with one of these under the importers' matching (upper-case or lower-case, a different spelling) is rejected; purchase-order supplier names are checked against it when no suppliers dataset names them. **Without this list the collision check against IMS is not performed** (the report says so). |

### Dataset: ims-tax-rates

The tax rates that already exist in the target IMS (an export you assemble from Settings, Tax rates). Omit it and the supplier purchase tax types are **not** resolved at prepare time (the report says `NOT RUN` and warns `SUPPLIER_TAX_RATES_UNCHECKED`); the apply-time rail `tax-rates` and the supplier importer still refuse a type that does not resolve. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The rate's name (for the report only: a rate is never chosen by name). |
| `accountingTaxType` | no | The rate's Xero tax type (`TaxRate.accountingTaxType`); blank when it is not mapped, which makes the rate ineligible. |
| `usedFor` | no | `SALES`, `PURCHASE` or `BOTH`; anything else rejects the row (`BAD_USED_FOR`). Only `PURCHASE` and `BOTH` rates are eligible. |
| `active` | no | `TRUE` or `FALSE`; anything else rejects the row (`BAD_ACTIVE`). Only active rates are eligible. |

### Dataset: ims-fx-rates

The rows of IMS's `fx_rates` table (an export you assemble from Settings, Currencies, or the table itself). It is the ONLY source of a foreign purchase order's rate: the transform applies the central lookup rule over it (it imports the pure rule, `lib/currencies/fx-select.ts`, not the database). Omit it and every foreign purchase order is rejected `FX_RATES_NOT_SUPPLIED`. Always a canonical file. A row for the base currency, or an unreadable row, is rejected.

| Column | Required | Meaning |
| --- | --- | --- |
| `currency` | yes | The foreign currency, 3 letters (base to this currency). |
| `rate` | yes | `fx_rates.rate`: 1 base = `rate` foreign, a plain decimal. A zero or negative row is kept so the lookup refuses it (`FX_RATE_UNUSABLE`) rather than skipping to an older one. |
| `fetchedAt` | yes | `fx_rates.fetchedAt` as an ISO instant WITH a zone, e.g. `2026-10-20T06:00:00Z`. |
| `baseCurrency` | no | The base currency the list was exported against. `npm run first-load:export-fx-rates` writes it on every row; a row whose `baseCurrency` differs from the run's base currency (`BASE_CURRENCY_MISMATCH`) is rejected, so another installation's list cannot be used by mistake. Blank (a hand-assembled list) is not checked. |

**The export command.** `npm run first-load:export-fx-rates -- --env-file <file> --expect-db <name> --expect-system-id <id> --out <dir> [--since YYYY-MM-DD]` writes this list from the installation's own `fx_rates`. It follows `first-load:apply`: the target is named by an env file (a regular file you own, mode 600; the process environment is replaced by a short whitelist), confirmed twice by what the server says (`--expect-db`, `--expect-system-id`), and read in ONE `BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ` transaction on a connection opened `default_transaction_read_only=on`. `--out` is a new or empty directory (mode 700, yours) and receives `ims-fx-rates.csv` and `ims-fx-rates.export.json` (database, base currency, window, row count, currencies, earliest and latest `fetchedAt`, and the sha256 of the CSV), each created exclusively, mode 600, never overwritten. It exports only rows whose `fromCurrency` is the organisation's base currency (others are counted in the record, not exported). **By default it exports ALL rows**, manual-override rows included: the file must cover the created date of every open purchase order, and the oldest one is not known to the command, so a default window could be younger than an order. `--since` keeps rows fetched on or after that day (UTC) for an operator who wants a shorter file; a window can only make an order refuse (`FX_RATE_MISSING`: no row on or before its day), never take a wrong rate. Exit codes: 0 written, 2 usage, 3 target not confirmed or unreadable, 4 no base-currency row to export, 6 internal error.

**Filling history before the export.** `fx_rates` only holds rates from the day IMS first fetched them, so an order created, or a lot received, before that day refuses `FX_RATE_MISSING`. Load the missing history first with `npm run fx:backfill-ecb -- --env-file <file> --expect-db <name> --expect-system-id <id> --ecb-csv <eurofxref-hist.csv> --from YYYY-MM-DD --to YYYY-MM-DD [--currencies EUR,USD] [--dry-run]` (never fetches: download <https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip> by hand and unzip it; the window must lie inside the file). It inserts rows with `source = 'ecb-history'`, one per ECB business day and enabled foreign currency, `fetchedAt` 16:00 Europe/Berlin in UTC, `rate = X_per_EUR / BASE_per_EUR` (EUR: `1 / BASE_per_EUR`, base read from IMS) to 8 decimal places, in one transaction behind the same double target confirmation as `first-load:apply`. It writes only BEFORE the live period: a planned day on or after the first non-`ecb-history` row of that currency (live, manual pin, Aelia), or on or after the start of the earliest Aelia period, REFUSES the run (the days are listed; nothing is written), A currency with no live row yet is refused too (run the FX refresh first, or exclude it with `--currencies`), so `--to` must be before the first live row. A backfilled row is therefore always older than every live row: it can never un-pin a manual rate, fill a live gap or tie a live row (a tie of different rates refuses under the central rule), and re-running skips the `ecb-history` rows already there. A blank or N/A ECB cell for a requested currency, a window outside the file, or a base currency missing from the file also refuses. Run `first-load:export-fx-rates` afterwards: the backfilled rows are in the exported list. See [installation.md](installation.md).

### Dataset: ims-skus

SKUs that already exist in the target IMS (from `/api/export/products`). The fourth side of the coverage check. Omit it for an empty database.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Passed through as given (trimmed). |
| `type` | no | Needed when a lot, transfer or recipe refers to a product that exists only in IMS. |

## Column maps

A column map is JSON, one per source file (or one per source when its files share a layout), with one entry per dataset that file feeds. Qoblex feeds products, recipe-lines, stock-lots, suppliers,
purchase-order-lines and transfers; the 3PL (today Mintsoft) feeds wms-products and wms-stock and is named `"source": "wms"` in a column map; WooCommerce feeds woo-products.

```json
{
  "formatVersion": 1,
  "source": "qoblex",
  "datasets": {
    "products": {
      "delimiter": ",",
      "expectedHeaders": ["Item Code", "Item Description", "Item Class"],
      "columns": { "sku": "Item Code", "name": "Item Description", "type": "Item Class" },
      "constants": { "stockUnit": "pcs" },
      "valueMaps": { "type": { "Stocked item": "SIMPLE", "Bundle": "KIT" } }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `columns` | canonical column to the source file's header, matched exactly (after trimming) |
| `constants` | a fixed value for a canonical column (for example the currency when the file has none) |
| `valueMaps` | per canonical column, a **closed list** from the source's value to the canonical value |
| `expectedHeaders` | optional; when present the file's header row must equal it exactly |
| `discountHeader` | optional, purchase-order-lines only: the source header the map deliberately reads as `lineDiscountPercent` when its name does not look like a discount (`disc`, `rabatt`, `remise`, `sconto`, `descuento`). It must equal the header `lineDiscountPercent` is mapped to. Checked against the file's actual headers on every load, with or without `expectedHeaders`: a discount-looking header is read only as `lineDiscountPercent` (`DISCOUNT_COLUMN_MISROUTED`), at most one exists (`DISCOUNT_COLUMN_AMBIGUOUS`), and if the file has a discount-looking header at all, `lineDiscountPercent` must map to exactly that header whatever else (`rowSelect`, `wide`, any other field) reads it (`DISCOUNT_COLUMN_NOT_THE_DISCOUNT_HEADER`; `discountHeader` does not override it). `discountHeader` is accepted only for a file with no discount-looking header (`DISCOUNT_COLUMN_NOT_DECLARED` otherwise). Stated limit: the other direct columns (price, quantities, stock-lot figures) have no header-name check, since the names that mean cost or quantity are too varied to pattern safely. |
| `delimiter` | `,` (default), `;`, tab or `\|` |
| `decimalSeparator` | optional; only `.` is accepted |
| `rowsAboveHeader` | `0` (default) or `1`: one row of labels above the header row (needed by `wide`; also set on a map that reads the same file without `wide`, so the label row is skipped) |
| `wide` | the wide warehouse blocks layout (below) |
| `rowSelect` | `{ "column", "keep": [...], "skip": [...] }`: a closed list of the values of one source column, or a **list** of such objects (one per column, every one of which must pass); see "Row kinds and grouped parents" |
| `nameColumn` | optional, products and stock-lots: the source header that holds the product name. It names a row with a blank SKU in its refusal and is the key of the `sku-name-overrides` decisions |
| `ghostRows` | optional, products and stock-lots: `{ "column": <source header>, "ghost": <value>, "quantityColumn"?: <source header> }`. Of several rows for one SKU, when **exactly one** is not typed `ghost` in `column` (the Qoblex stock report: `Product Type` `Unknown`), that row is kept and the ghost rows are dropped, each reported as INFO `GHOST_ROW_DROPPED` ("ghost row dropped", with its quantity from the first header named `quantityColumn`) and counted under "Rows skipped by the map". Two typed rows, or only ghosts, are still refused as duplicates |
| `blankStockIsZero` | optional, stock-lots with a `wide` layout only: `true` makes a stock row whose all-warehouses total is blank and whose every warehouse cell of the quantity column is blank or numerically exactly zero (`0`, `0.0`, `0.0000`; parsed, not string-compared) load as **0 on hand** (owner ruling: Qoblex leaves the total blank for a product that has never held stock). Each such row is reported as INFO `BLANK_STOCK_AS_ZERO` (SKU and line, saying whether the cells were blank, zero or blank or zero) and the dataset gets one count line, INFO `BLANK_STOCK_AS_ZERO_COUNT`. A blank total next to **any** non-zero warehouse cell, an unparseable cell, or a stated total next to blank warehouse cells, is still refused as `WIDE_TOTAL_MISMATCH`. Off unless the map says so; a blank cell is never read as zero otherwise. Set in the shipped Qoblex stock-on-hand map |
| `nonStock` | optional, products and stock-lots: `{ "column": <source header>, "value": <source value> }`: for a SKU on the `non-stock-skus` decisions list that source cell is filled with `value` as the row is read, only when it is blank, `Unknown` or already that kind |
| `parentFrom` | `{ "column", "parentValues", "skuColumn", "into" }`: rows after a parent row inherit its SKU; see "Row kinds and grouped parents" |
| `derived` | canonical column to the canonical column it is derived from, e.g. `{ "taxClass": "supplierName" }` (no shipped map uses it); each needs its own closed `valueMaps` entry |
| `dateFormats` | canonical column to a source date format; the value is converted to `YYYY-MM-DD` |

It fails closed, and each of these is an error that stops the run (exit 3) rather than something guessed:

- a mapped header that is not in the file, or appears twice (the message lists the headers the file does have, and names a case-different look-alike as a hint it did **not** use);
- two canonical columns mapped to one source header, a column both mapped and given a constant, an unknown canonical column name, an unknown key anywhere;
- a required canonical column that is neither mapped nor a constant;
- a `decimalSeparator` other than `.`: decimal commas are rejected, never converted;
- a map entry for a dataset that source cannot feed;
- a `derived` column without its own `valueMaps`, derived from itself, from a column derived later, or also mapped; a `dateFormats` entry on a column that is not mapped, without exactly one year, month and day token, or on a column that also has `valueMaps`;
- anything in the wide layout that does not hold (below).

A source value that is not in a column's `valueMaps` rejects **that row** with its line number; it is not passed through. A source column that no canonical
column reads is listed in the report under "Source columns not read", so a forgotten column is visible.

### Wide warehouse blocks

Some stock reports put every warehouse side by side: a first row names the warehouses, a second row is the header, and the per-warehouse column group (Quantity, Allocated, ...)
repeats once per warehouse. `wide` reads such a file into ONE canonical record per source row and warehouse block.

```json
"stock-lots": {
  "rowsAboveHeader": 1,
  "columns": { "sku": "Sku", "unitCost": "Moving Average Cost" },
  "constants": { "currency": "GBP" },
  "wide": {
    "blockStart": "after-label",
    "warehouses": { "1 MIL1": "MIL1", "2 Cambridge Warehouse": "CAMBRIDGE" },
    "blockColumns": { "qty": "Quantity" },
    "totals": { "qty": "Quantity" },
    "uniqueBy": "sku"
  }
}
```

- `columns` are per-row columns that come BEFORE the first block (the SKU, the moving average cost). `blockColumns` name the header that must appear **exactly once in every block**.
- `blockStart` says where a block begins relative to its label: `"after-label"` (the block starts in the column after the label; the label sits above the last column of the previous group, as in the Qoblex stock report) or
  `"at-label"` (the block starts under its label). A block runs to the column before the next block starts; the last one to the end of the row. Columns before the first block, such as the all-warehouses totals group the Qoblex report puts first, belong to no warehouse and are never read as one.
- `totals` (required, and it must have an entry for **every** `blockColumns` column: a map that omits one is refused) names, for each block column, the report's own all-warehouses total header, which must appear **exactly once before the first block**. **Every source row is reconciled**: the total must equal the exact sum of that row's warehouse blocks (a negative block counts as negative), or the row is rejected as `WIDE_TOTAL_MISMATCH` with both figures; a blank or non-numeric total or block cell rejects it too (the one exception is the map's opt-in `blankStockIsZero`, for a row whose total is blank and whose warehouse cells are all blank or zero). **A row the map skips (`rowSelect.skip`, which includes a SKU the `non-stock-skus` decisions set to non-inventory and a KIT) is not stock and is never total-checked: its stock cells are ignored, not refused.** A missing, edited or misaligned warehouse cell therefore cannot pass.
  The Qoblex report has one known exception shape: a SKU at -5 in one warehouse and 0 in the total is a mismatch (and is also a negative balance).
- `uniqueBy` (required) **must be `sku`**: the key is the column mapped to the canonical SKU, and a map naming any other column is refused. The key is the SKU **after** the map's `valueMaps` and normalised like the loader's identifiers (compatibility-normalised, upper-cased, with spaces, control and zero-width characters removed), so two source spellings of one SKU are one key. It is **unique across the source rows**. A wide file is one row per key; a key (compared upper-case) on more than one row rejects **every** row that carries it as `DUPLICATE_SOURCE_ROW`, whatever their quantities or costs say, so warehouse quantities of two rows are never added together (one synthetic lot per SKU and warehouse). Blank keys are not a duplicate group. The rule holds **across files** too: when a dataset is read from several files, a key present in more than one of them refuses every source row carrying it in every file (the reason names the other file and line), before any lot is collapsed. As a second layer the loader refuses two rows of a wide report that state the same SKU and warehouse (`REPEATED_WIDE_STOCK_ROW`) whatever the reader decided; the multi-lot weighted average of long (non-wide) sources is unchanged. One SKU in several warehouse blocks of one row is the normal case, not a duplicate. Every offending source row gets exactly one disposition that names the other file and physical line, including rows already refused inside their own file (a repeat or a total mismatch). A row the map deliberately skips (`rowSelect.skip`) does not count as a key of the dataset. **A dataset is read either entirely in wide layout or entirely not**: a manifest that lists one dataset with a mix is a usage error (exit 2), decided from the column maps BEFORE any data file is read (so a missing file cannot turn it into exit 3), because rows of the same SKU and warehouse in two layouts could not be told apart.
- `warehouses` is a **closed** list from the label (trimmed) to the IMS warehouse code. Nothing is guessed, and the file is refused as a whole (exit 3, nothing written) when: a label appears twice; a label is not in `warehouses` (a new or renamed warehouse); a declared warehouse has no label (a block disappeared);
  a block lacks a `blockColumns` header or has it twice (an incomplete block); the label row and the header row differ in width; a per-row column lies inside a block; two labels map to the same code; or `expectedHeaders` differs.
- The records are numbered `L.0B`: source line L, warehouse block B (1-based, file order), so line 12 block 3 is `12.03`. `read` in the accounting counts these records (a 1,570-row, five-warehouse file is 7,850 records). A row refused before it is split (a ragged row, an unlisted row kind) is one record and keeps the plain line.
- A zero quantity is a record that says "zero on hand" (excluded as `ZERO_ON_HAND`), exactly as in a long file. The wide layout is only allowed for a dataset that has a `warehouseCode` column.

### Row kinds and grouped parents

`rowSelect` makes the value of a source column decide whether a row belongs to the dataset. It is either one object, or a **list** of objects over different columns, and a row is read only when **every** selector passes (the stock lots of the Qoblex report skip kit and non-inventory rows by `Product Type` AND skip `Deleted` rows by `State`). A column may appear in one selector only. A deliberate `skip` on any selector leaves the row out before another selector's `keep` list is judged (a `Deleted` row of an unlisted type is skipped, not refused). Each selector is a **closed list**: a row whose value is in `keep` is read, one in `skip` is left out and **counted** (the report's "Rows skipped by the map"), and any other value is
rejected as `UNLISTED_ROW_KIND`. That is how the Qoblex stock report's `Product Type` `Unknown` rows are refused rather than silently loaded or dropped.

`parentFrom` is for files where a header row is followed by its component rows (the Qoblex bundles file: a `Bundle` or `BillOfMaterial` row, then its `Part` rows). A row whose `column` value is in `parentValues` sets the current parent to its `skuColumn`; every row that is read gets the current parent in the canonical column
`into`. A row with no parent yet, or after an unreadable (ragged) row, is rejected as `ORPHAN_CHILD_ROW`, because a damaged row could have been the parent. The same file is read twice, by two map entries: the header rows as `products` (`keep` the parent kinds), the component rows as `recipe-lines` (`keep` `Part`).

### Derived columns and dates

`derived` fills a column from another canonical column of the same record through the derived column's own closed `valueMaps` (a value not in it rejects the row). No shipped map uses it: Qoblex's open purchase order file has no currency, and its currency and rate are NOT derived by a map (see "Qoblex native exports").
`dateFormats` converts a source date with the tokens `YYYY`, `MMM` (Jan-Dec), `ddd` (Mon-Sun), `MM`, `M`, `DD`, `D`; the whole value must match, the day must exist, and a `ddd` must be the real weekday (`Thu, Sep 24 2026` reads as 2026-09-24; `Fri, Sep 24 2026` is rejected as `BAD_DATE`).

### How to write the column map from a sample

Do this once per source file, from the owner's 50-row sample. Do not write a header from memory.

1. Open the sample and copy its header row **exactly**, including capitals, spaces and punctuation. Put it in `expectedHeaders`; a later export with a different header will then stop the run.
2. Take the dataset's table above. For each canonical column, find the sample column that holds that meaning and write `"canonical": "Source Header"` in `columns`. Required columns first.
3. If the sample has no column for a required value that is the same for every row (the cost currency, say), use `constants`.
4. List the distinct values of every enumerated column: product type, order or transfer status, warehouse name, boolean flags. Write each into `valueMaps`, mapping to the canonical vocabulary in the tables.
   Include blank (`""`) only if blank is meaningful.
5. If the file is not comma-separated, set `delimiter`. If it uses decimal commas, stop: ask for a re-export with ".", the tool will not convert them.
6. Run with `--dry-run`. Read "Source columns not read" for anything you meant to map, and read the rejected rows: an `UNMAPPED_VALUE` means a value in the sample is missing from a `valueMaps` list.
7. Run the full file the same way before the real load. A value that appears only in the full file is rejected on the row, not guessed.

## What is checked, and what happens to a row

Every input record ends in exactly one of three outcomes, and the report prints the identity `read = emitted + excluded + rejected` for every dataset:

- **emitted**: it is in an import file, or (for the datasets that only feed checks) it was used;
- **excluded**: deliberately not loaded, with a reason (for example `ZERO_ON_HAND`, `EXCLUDED_TYPE`, `FULLY_RECEIVED`);
- **rejected**: an error, with a reason and its line.

Any rejected row or error finding makes the whole run BLOCKED (exit 1) and **no import file is written**.

- **SKUs.** A SKU is trimmed and Unicode-normalised; nothing inside it is changed. Other datasets find a product by comparing upper-case (exactly how the opening-stock,
  transfer and purchase-order importers look a SKU up) and the file uses the catalogue's spelling. Two catalogue SKUs that differ only by case reject both. A SKU with a control, non-breaking-space
  or zero-width character, or starting with `#` (the importers' reader skips such a row as a comment), is rejected.
- **Duplicates.** The same rule everywhere: a duplicate is either provably identical and deduplicated (products, suppliers, exclusions, IMS lists: the extra is *excluded* with `DUPLICATE_ROW`), or rejected with every member, so the answer never depends on row order. A line that would **add** a quantity when repeated is never deduplicated, because that cannot tell an export that repeated a row from a real second line: the same purchase order line twice (same order, SKU and `lineNo`) is rejected as `DUPLICATE_PO_LINE` (identical) or `DUPLICATE_PO_LINE_CONFLICT`; stock lot rows with the same SKU, warehouse, quantity and cost where any lacks a distinct, non-blank `lotRef` are rejected as `DUPLICATE_LOT_ROW`; order and transfer keys containing control, zero-width or non-ASCII space characters are refused (`KEY_HAS_INVISIBLE_CHARS`); stock rows of one SKU and warehouse that come from more than one input file are rejected as `STOCK_FROM_SEVERAL_FILES` unless every one of them has its own non-blank `lotRef` (they could be the same stock exported twice); the same lot reference twice, the same recipe component twice, and the same SKU twice in one transfer are rejected. Every duplicate has a disposition, so the accounting table shows it.
- **Decimals.** Quantities and costs use exact decimal arithmetic, never floating point. A decimal comma, a thousands separator, an exponent, a sign prefix, more decimal places than the target column holds, or more than
  15 significant digits for a cost (the importers read costs as doubles) is rejected.
- **Recipes.** Every component and parent must be a loaded product. The recipe graph must be acyclic: the check is `detectBomItemCycleInEdges`, the function the importer's component pass uses, applied repeatedly until every
  cyclic parent is found. A KIT or BOM with no loadable line, or recipe lines not supplied at all, blocks the run. Products are ordered variants after parents and recipes after their components, so a chunk never needs a later chunk.
- **Opening stock.** Lots are collapsed to one weighted-average `unitCostBase` per SKU and warehouse: the lot total (quantity times cost, exact) divided by the quantity, rounded **once** to 6 decimal places, half up. The report shows the lot total, the collapsed total
  and the rounding residual per group and in total. A non-base currency lot needs `fxRateToBase`. The converted base-currency cost of a lot, the collapsed quantity, and the opening quantity after any in-transit addition are each checked against the target columns (8 integer digits for quantity, 9 for cost), and so is the movement value the importer writes (quantity times the rounded average, 12 integer digits); a group that does not fit is rejected, never emitted.
- **Types that hold no stock.** KIT, VARIABLE and NON_INVENTORY stock rows with quantity 0 are excluded and reported. A POSITIVE quantity on such a product is an **error** that blocks the run, because those units would be absent from every import file. The products themselves are still loaded.
- **Zero versus missing.** A SKU whose stock rows all say zero is **zero on hand** (excluded: no opening layer is created). A stock-bearing SKU (SIMPLE, VARIANT, BOM) with no stock row at all is **missing from the extract**, listed
  separately. If the 3PL stock dataset is supplied and the missing SKU holds stock there, that is an error; if it is not supplied the answer is reported as unknown.
- **Open purchase orders.** Outstanding quantity per line is ordered minus received, never negative. Fully received lines, closed orders and over-received lines are excluded; an over-received line is also a warning. Lines of one order must agree on
  supplier, currency, rate, warehouse, VAT flag, reference, date, notes and tax rate or the whole order is rejected (the importer refuses such an order). Lines of an order are never split across files. An order whose value (net total at the declared `maxPurchaseTaxRate`, foreign and in base currency (foreign divided by the rate): 14 integer digits) or whose base unit cost (12 integer digits) the purchase order columns cannot hold is rejected whole. When a suppliers dataset is supplied, every supplier a line names must be in it (a line naming a supplier that is only in IMS is rejected unless the ims-suppliers list names it); to reference suppliers that already exist in IMS, leave the suppliers dataset out and the names are passed through unchecked (with a warning).
- **R14 four-way SKU coverage.** Every SKU in Qoblex, the 3PL or WooCommerce must exist in IMS after the load (loaded now, or already in IMS) or be on the exclusion list; otherwise it is an error. The report prints a presence matrix (Q = Qoblex, L = the 3PL, W = WooCommerce, I = already in IMS).
  A SKU only in IMS, or an exclusion that matches nothing, is a warning.
  The 3PL's SKUs are compared case-insensitively like every other SKU; the column map, not the code, says which file is which, so nothing in the tool is Mintsoft-specific.
- **Chunking.** At most 9,999 data rows and 9,999,999 bytes per file, which is stricter than the importers (they accept 10,000 rows and 10 MiB and **silently drop** every row beyond the row cap). The 10,001st row lands in the second file.
- **Encoding.** Input must be valid UTF-8. A leading byte-order mark is stripped (and reported). Output never has one.

### In-transit stock

The transfers importer creates a transfer and then **dispatches** it, which deducts the quantity from the source warehouse (and refuses if the source does not hold it). So an in-transit quantity must be present in the source warehouse's opening balance, and
is then moved by the dispatch. Whether the source system's on-hand figure already contains those units decides the opening balance, so the manifest must say which:

- `counted-in-source`: the source on-hand includes the in-transit units. Opening quantity = reported quantity. It must be at least the in-transit quantity, or the transfer is rejected.
- `excluded-from-source`: the source on-hand already excludes them. Opening quantity = reported quantity plus the in-transit quantity, at the group's weighted-average cost; a source with no cost basis rejects the transfer.

Either way the units are counted once: after the dispatch the warehouse holds the physical quantity and the transfer holds the in-transit quantity. The destination's reported on-hand is assumed to exclude in-transit units until received; the tool cannot verify that, so confirm it from the sample.
Only the outstanding quantity (shipped minus received) of an IN_TRANSIT or PARTIALLY_RECEIVED transfer is emitted, as an IN_TRANSIT transfer. By default the importer stamps the dispatch at import time.

`importTransfersCsv` also reads an optional **`dispatchedAt`** column, so a transfer can carry the source's real dispatch moment (the stranded-in-transit warning counts its 7 days from that stamp). It is allowed on IN_TRANSIT and RECEIVED rows only, and every row of one `transferKey` must carry the same value. Accepted: `YYYY-MM-DD` (read as 12:00 UK time that day; today's date before noon is stamped now) or an ISO-8601 date-time with an offset such as `2026-10-20T14:30:00Z`. Refused: a future moment, anything more than 366 days before the import, a bare local date-time and ambiguous forms such as `20/10/2026`. **It moves only the stamp**: the quantity still leaves the source at import time, FIFO consumption and the stock movement are dated at import time, and a transfer dispatched 20 days ago is flagged stranded immediately, which is the intent. The column is deliberately NOT in the downloadable template or in the first-load tool's output headers (the importer-headers census requires the template, the importer target and the tool's files to carry one identical list); add it to the file by hand. The first-load preparation tool does not emit it; its `dispatchDate` input is still used only for the warning against `asOf`.

## Qoblex native exports

Qoblex is read from four files. Their maps and a manifest are in `tests/first-load/fixtures/qoblex-native/` over **synthetic** data with the real headers (every file starts with a byte-order mark, as the real exports do, and `expectedHeaders` pins each header row).
Copy the maps, keep `expectedHeaders` as they are, and point the manifest at the real files. Real exports, supplier names and customer data are never committed.

| Qoblex export | Map | Datasets |
| --- | --- | --- |
| Stock on hand (wide report) | `qoblex-stock-on-hand.map.json` | `products` (first file), `stock-lots` |
| Bundles | `qoblex-bundles.map.json` | `products` (second file, `supersedesEarlier`), `recipe-lines` |
| Incoming stock | `qoblex-incoming-stock.map.json` | `purchase-order-lines` |
| Contacts | `qoblex-contacts.map.json` | `suppliers` |

How each fact the export states is read, and what is a decision for the owner:

- **Products** come from the stock report: `Sku`, `Product`, `Product Type`, `Barcode`, `State`. `Product Type` is a closed list: `simple` is SIMPLE; `variable` is mapped to VARIANT; `kit` is KIT, `bom` is BOM and `non-inventory` is NON_INVENTORY (spellings the reconciliation pack's R14 needs and that no real export has carried yet); any other value (the real export has `Unknown`) is rejected for an owner decision. `State` is a closed list too, read through the map's `lifecycleStatus` column (not `active`): `Active` is ACTIVE, `Inactive` is EOL and `Archived` is DRAFT. **That is only the Qoblex-derived lifecycle: WooCommerce's status is gospel (owner ruling 2026-11-21) and overrides it wherever the run can see one** (see "Dataset: lifecycle-confirmations" for the mapping): a joined variation takes its own `variationStatus`, and a simple, KIT or BOM product takes its own status from `woo-product-status` (the bound snapshot dataset; or `woo-products` when that supplies one). A simple, KIT or BOM product WooCommerce does not hold keeps the Qoblex-derived lifecycle and the run warns `LIFECYCLE_NOT_FROM_WOO` (with the SKUs): a later IMS to WooCommerce push may create or change their WooCommerce status. DRAFT and ACTIVE are purchasable and reorder-eligible (`isPurchasableProductStatus`: ACTIVE and DRAFT), so open purchase order lines on those products load, whichever side the lifecycle came from; an EOL product refuses them (`PRODUCT_NOT_PURCHASABLE`). **`Deleted` is skipped** (the rows are not loaded, in products and in stock lots, and are counted under "Rows skipped by the map"); any other state is rejected. A map that still uses the older `active` column keeps its behaviour (FALSE is EOL). A VARIABLE product the products file carries takes WooCommerce's status like every other product; a difference is the INFO `LIFECYCLE_TAKEN_FROM_WOO`, never a warning. In the stock lots, `bom` rows are read like `simple` ones, while `kit` and `non-inventory` rows (which hold no stock of their own in IMS) are skipped and counted.
  **The stock report lists variants only, with no parent product**, so a VARIANT row is rejected as `VARIANT_WITHOUT_PARENT` unless the `variant-parents` dataset (read from WooCommerce, which holds the parents) supplies its parent: see "Dataset: variant-parents". The map is shipped honestly blocked, rather than
  loading variants as SIMPLE products and losing the parent link. To rehearse the rest of the load without WooCommerce, a private copy of the map can read `variable` as SIMPLE; do not load that.
- **Bundles and manufactured products** come from the bundles file. `Line Type` is a closed list: `Bundle` is a KIT, `BillOfMaterial` is a BOM, `Part` is a component line whose `Bundled Quantity` is the component quantity. The header rows become products (second file, which supersedes the stock report's SIMPLE row for the same SKU); the `Part` rows become recipe lines
  under the header row above them. A product listed in more than one group (the real file does this) produces repeated or conflicting component lines, which are rejected (`DUPLICATE_RECIPE_LINE`) because the tool cannot know whether to add them. The bundles file's own stock columns are not read: opening stock comes only from the stock report.
- **Opening stock** is the stock report read in wide warehouse blocks. Qoblex cannot export per-lot costs, only a `Moving Average Cost` per product, so each SKU and warehouse becomes **one synthetic lot** at that cost (currency is the base currency, a constant in the map); nothing is collapsed because there is nothing to collapse, and the multi-lot weighted average used for other sources is unchanged.
  The cost is per product, not per warehouse, so a SKU held in two warehouses has the same cost in both. FIFO in IMS is date-based only. A positive quantity with a cost of **zero** is a `ZERO_COST_OPENING_STOCK` warning (loadable, but it would sell at zero cost of goods); a positive quantity with a **blank** cost is an ERROR (`MISSING_UNIT_COST`, the row is rejected and the run is blocked); a blank cost with zero stock is just zero on hand; a negative quantity is rejected; the all-warehouses totals group is never read.
  The five warehouse labels are mapped to the codes `MIL1`, `CAMBRIDGE`, `RESTOCK`, `QUARANTINE-CAMBRIDGE` and `RXT2`; these codes must exist in IMS (apply-time check `warehouse-exists`). **Owner decision:** the quarantine warehouse is imported as its own warehouse by default, so quarantined units are on hand but not mixed into a sellable warehouse; say so if it should not be loaded.
- **Transfers are not needed for Qoblex.** Qoblex has no in-transit status for transfers: a booked transfer is already at the destination and a draft transfer is still in the origin warehouse, so on-hand per warehouse is already the truth. The `transfers` dataset is simply not supplied (the report lists it under "Not supplied"), `inTransitConvention` is not set, and the in-transit section below does not apply to Qoblex.
- **Open purchase orders** come from the incoming-stock file, one row per line. `Status` is a closed list: `Approved` and `PartiallyReceived` are open (OPEN); `Closed` maps to CLOSED and is excluded as `NOT_OPEN` (not imported; R7/R8 read open orders only, so the reconciliation pack drops Closed lines too); any other status is rejected (`UNMAPPED_VALUE`) until the owner says whether it is open. **The order of the line filters** (`loadPurchaseOrders`, lib/first-load/transform.ts): (1) a line that is not open (CLOSED or CANCELLED after the status map, or fully or over received) is set aside BEFORE the duplicate check, so a finished line repeated in the export cannot block the run; (2) the duplicate check (`DUPLICATE_PO_LINE`, `DUPLICATE_PO_LINE_CONFLICT`) runs over open lines only, and a repeated open line still refuses every copy; (3) the per-line checks, then `NOT_OPEN` / `OVER_RECEIVED` / `FULLY_RECEIVED`, the product, supplier and rate. Outstanding quantity is `Ordered Quantity` minus `Received Quantity`, so a fully received line is excluded. The destination warehouse is a constant (`MIL1`; the report's `Incoming Quantity` appears only for that warehouse in the sample); confirm it.
  The file has **no currency and no exchange rate**, and the pinned map carries no supplier-to-currency or currency-to-rate table (the reconciliation pack's copy is byte-identical). The order's currency is that of the supplier with the same name in the same run's contact export; an unknown supplier is `SUPPLIER_NOT_IN_FILE`. The rate of a foreign order is read from the `ims-fx-rates` list (IMS's `fx_rates`) as of the end of the `Created on` day (`createdOn`, converted from `Thu, Sep 24 2026`); no rate for that day is `FX_RATE_MISSING`. **Line discount.** The report's `Price` is the gross price and its per-line `Discount (%)` is read (canonical column `lineDiscountPercent`) but never applied. An **open** line (a quantity outstanding) with a non-zero discount is refused as `PO_LINE_DISCOUNT_NOT_SUPPORTED` (the reject report names the order and SKU), because it would otherwise import the gross price as the unit cost and overstate the order value, landed cost and stock valuation; resolve it in Qoblex (receive it, close it, or re-price it to the net price) and re-export. A blank discount is 0; a value that is not a plain number, is negative or is above 100 is `BAD_DISCOUNT`. A fully received, over-received or closed line is not imported, so its discount is not judged and does not refuse it. The reconciliation pack's R7 treats an open line with a non-zero discount as inconclusive (`VALUE_SHAPE_MISMATCH`), so it never compares a gross price with a gross price.
  `Due On` (`Thu, Oct 8 2026`) becomes `expectedDelivery`. The `Incoming Quantity` per warehouse in the stock report and these lines describe the same open orders: their per-SKU totals should agree, and a PO line for a SKU the catalogue lacks is rejected (`SKU_NOT_IN_CATALOGUE`).
- **Supplier currency and tax rate.** `Currency` is required: a blank is `MISSING_CURRENCY` (the supplier importer's silent GBP default is refused; a GBP supplier must say GBP). `Purchase Tax Class Name` becomes the supplier's default tax rate through the **pinned** value map in `qoblex-contacts.map.json` (also pinned in code as `QOBLEX_PURCHASE_TAX_CLASS_TYPES` and by a test): `Purchase Tax` is `INPUT2` (20% VAT on expenses), `Zero Rated Purchase` is `ZERORATEDINPUT`, `No VAT` is `NONE` (Xero built-in tax types). Any other class is `UNMAPPED_VALUE`, a blank class is `MISSING_PURCHASE_TAX_TYPE`. Each type must then resolve to exactly one active purchase-capable IMS tax rate carrying it (`NO_IMS_PURCHASE_TAX_RATE` / `AMBIGUOUS_IMS_PURCHASE_TAX_RATE`; the rate is never chosen by name), so IMS tax rates must be mapped to Xero types (`INPUT2`, `ZERORATEDINPUT`, `NONE`) before the load.
- **Suppliers** come from the contact export. **The contact export holds suppliers only** (owner ruling 2026-11-20), so every contact row is a supplier; there is no supplier/customer flag. `Wholesale or Retail` is a closed list (`Wholesale` only): a `Retail` contact is rejected as `UNLISTED_ROW_KIND` for an owner decision. Every other contact is loaded as a supplier. Whether a contact is a supplier is read from its use: the suppliers named in the stock report's `Supplier` column and in the incoming-stock file's `Supplier` column should all be present (a purchase order line naming an absent supplier is rejected).
  Payment terms are a closed list (`NONE` and blank are no terms, `30 days net` is 30). The shipping address columns feed the supplier address; the billing columns are not read.

## WooCommerce snapshot command

`npm run first-load:woo-snapshot` (`scripts/first-load-woo-snapshot.ts`) is the only part of the first-load tooling that talks to a store, and it is **read-only**: it reads ALL the store's products (every type and every status, with each one's own status, SKU, id, title, type and stock quantity, 100 to a page) and the variations of the variable ones, through the connector's own read function (`GET` only, through the connector transport and its outbound-write hold, which classifies a GET as a read), and writes four files into a new directory (plus the inspection copy). It writes nothing to the store, to the IMS database or to any setting.

```bash
npm run first-load:woo-snapshot -- --env-file path/to/woo-readonly.env --out path/to/new-dir --allow-origin https://shop.example
npm run first-load:woo-snapshot -- --verify path/to/new-dir/woo-snapshot.json --expect-origin https://shop.example --expect-visibility path/to/admin-counts.json
npm run first-load:woo-snapshot -- --help
```

**Credentials** are read from the file named by `--env-file` and from nowhere else: never from the command line (a credential flag is a usage error), never from the IMS database (putting a store key into the target IMS would make its stock-sync paths live). The file must be a regular file readable by its owner only (`chmod 600`), with `KEY=VALUE` lines:

| Variable | Meaning |
| --- | --- |
| `FIRST_LOAD_WOO_URL` | The store's base URL (the same checks as the connector's own store URL apply: https, no credentials, no private address). |
| `FIRST_LOAD_WOO_KEY` | A **read-only** WooCommerce REST consumer key. |
| `FIRST_LOAD_WOO_SECRET` | Its consumer secret. |
| `FIRST_LOAD_WOO_ALLOWED_ORIGINS` | Optional: comma-separated origins the command may contact (the same as repeating `--allow-origin`). |

An unknown variable in the file is refused, so a typo cannot silently leave one out. No credential is ever printed or written to an output file.

**Origin allowlist.** The store's origin must be named by `--allow-origin` (repeatable) or `FIRST_LOAD_WOO_ALLOWED_ORIGINS`, or the run is refused (exit 3) **before any request leaves the machine and before anything is written**. `--allow-any-origin` overrides that, out loud.

**Files written** (mode 600, into `--out`, which must not exist or be empty):

| File | Content |
| --- | --- |
| `woo-snapshot.json` | Every product of any type (`products`: id, SKU, title, type, status, `manageStock`, `stockQuantity`), the variable ones again as `parents` (with their variation ids) and every variation (id, parent id, SKU, status, attributes, and its own `manageStock` (true, false or `parent`: it draws on its parent's stock) and `stockQuantity`), sorted by id, with the SHA-256 of its canonical payload. **Format 3** (variation stock added for the owner lifecycle review): a format 2 snapshot or provenance (written before the variation stock was read) is refused with a message that says so; re-run `first-load:woo-snapshot` and regenerate the files derived from it. Deterministic: the same store gives the same bytes whatever page size it grants or order it answers in. |
| `woo-snapshot.provenance.json` | The store origin, the time, the number of requests, the completeness proof, and the SHA-256 of the snapshot file, of `variant-parents.csv`, of `woo-product-status.csv` and of the inspection copy. This is the only file that carries a time or a host. |
| `variant-parents.csv` | The canonical `variant-parents` dataset (one row per variation that has a SKU), ready to list in a run manifest. Never altered. |
| `woo-product-status.csv` | The canonical `woo-product-status` dataset (one row per product with a SKU, any type), ready to list in a run manifest. Never altered. |
| `variant-parents.inspect.csv` | The same rows for a person to open in a spreadsheet: every cell a spreadsheet would read as a formula (`=`, `@`, tab, carriage return, `+`, or `-`, including a sign followed by a digit) gets a leading apostrophe. NOT an input. |

**Completeness is proved, not assumed, and confirmed by a second walk.** The products read (any type) must equal the store's own `X-WP-Total`, and the variable ones must equal the count the store gives for its own `type=variable` filter; for every product the variations read must equal that call's `X-WP-Total` **and** the list of variation ids the product itself carries. A page the store did not serve, a store that sends no readable total, or a store whose totals change during the walk is an error (exit 1) and nothing is written. The snapshot is also refused when a variable product has no SKU, when a product or variation SKU repeats (letter case ignored), when a SKU is both a product and a variation, or when no product is returned at all. A product with a status the snapshot cannot enumerate (for example a scheduled `future` product) refuses the walk, as it always has for variable products; the message says to unschedule it or wait until it publishes. Offset paging over a store that is being edited can skip a surviving product while every total and row count still agree (one product deleted on page 1 and one added at the end before page 2), so after a complete walk the command **walks the whole catalogue a second time (from scratch) and the two canonical payloads must be byte-identical**; if they differ it starts again, up to three rounds, and then reports the store as too unstable to snapshot (exit 1). Pagination is explicitly ordered by id ascending.

**Visibility is proved per status, not assumed.** A read-only key that cannot see some rows still gets a well-formed answer to `status=any`: WooCommerce simply leaves them out, and the product total, the variation ids a product lists and the page counts then all describe the same smaller catalogue. So besides the paged walk (which asks for `status=any`), the command asks for each of `publish`, `draft`, `private` and `pending` **by name** (one row per request, only the `X-WP-Total` is read) for the variable products and for the variations of every product (including products with no variations). The walk fails (exit 1, nothing written) when: a status request is refused (HTTP 400/401/403: the key cannot enumerate that status); a count has no `X-WP-Total` header at all, even when the list is empty (the connector reads an absent header as 0, so the walk checks that the header was present: a key that is answered 200 and an empty list for rows it may not read sends none); the four per-status counts do not add up to the `status=any` total; or any row carries another status (for example `future`). The per-status counts are recorded in the provenance (`proof.parents.statusTotals`, `proof.variations.statusTotals`) and printed. Cost: about 4 extra requests per variable product per walk, throttled like the rest.

**Operator check of the real key's visibility (do this before relying on a snapshot).** The fake store in the tests cannot establish how a given WooCommerce install treats a given key, so the first real run needs one human comparison: read each count one of two ways (both read-only). **wp-admin:** open Products; for ALL products read the status links (Published, Draft, Private, Pending; "All" excludes Trash). For the variable products, apply the Product type = Variable product filter, **then click each status link in turn and read its "N items" count**: the status links' own numbers ignore the type filter, so they are not the variable counts. wp-admin has no variation list, so the variation counts come from SQL. **SQL (`SELECT` only, run with `wp db query` or a read-only database user; the table prefix is assumed `wp_`):**

```sql
-- all products, every type (compare with proof.allProducts.statusTotals and visibilityChecked.allProducts)
SELECT p.post_status, COUNT(*) FROM wp_posts p
WHERE p.post_type = 'product' AND p.post_status IN ('publish','draft','private','pending')
GROUP BY p.post_status;

-- variable products only (visibilityChecked.products)
SELECT p.post_status, COUNT(*) FROM wp_posts p
JOIN wp_term_relationships tr ON tr.object_id = p.ID
JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_type'
JOIN wp_terms t ON t.term_id = tt.term_id AND t.slug = 'variable'
WHERE p.post_type = 'product' AND p.post_status IN ('publish','draft','private','pending')
GROUP BY p.post_status;

-- variations of those variable products, whose parent is in one of the four statuses the walk enumerates (visibilityChecked.variations)
SELECT v.post_status, COUNT(*) FROM wp_posts v
JOIN wp_posts p ON p.ID = v.post_parent AND p.post_type = 'product' AND p.post_status IN ('publish','draft','private','pending')
JOIN wp_term_relationships tr ON tr.object_id = p.ID
JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_type'
JOIN wp_terms t ON t.term_id = tt.term_id AND t.slug = 'variable'
WHERE v.post_type = 'product_variation' AND v.post_status IN ('publish','draft','private','pending')
GROUP BY v.post_status;
```

**On a Polylang store every one of these must be limited to the DEFAULT language**, because Polylang keeps one copy of each product (and of its variations) per language while the REST walk returns the default language only. Add to each query, on the product `p` (for variations, on the PARENT `p`, which carries the language):

```sql
JOIN wp_term_relationships lr ON lr.object_id = p.ID
JOIN wp_term_taxonomy lt ON lt.term_taxonomy_id = lr.term_taxonomy_id AND lt.taxonomy = 'language'
JOIN wp_terms ll ON ll.term_id = lt.term_id AND ll.slug = '<default language slug, for example en>'
```

Without that join the counts are higher than the snapshot's and the attestation would (correctly) refuse the snapshot. **The wp-admin route on a Polylang store needs the same filter:** before reading the status links, pick the DEFAULT language in the admin bar's language filter (not "Show all languages"), for the product list and for the Variable product filter alike; the counts read with all languages shown are per-language copies and will not match. **That the REST walk returns the default language only is an assumption this tool has not verified** against a live Polylang store; it is fail-closed either way: if the walk returned every language, its recorded counts would exceed the default-language admin counts and the attestation would refuse the snapshot, and if it returned another language the SKUs would not join. Do not "fix" a mismatch by attesting all-language counts. These are the counts of the posts the REST list can see; an administrator-level read-only key sees all four statuses. Nothing here writes. **Write those admin counts into the manifest as `wooSnapshot.visibilityChecked` (`allProducts`, `products` = variable products, `variations`)** (and into the `--expect-visibility` file): the binding then compares them with the recorded counts, so this comparison is enforced, not just advised. Open one product known to have a draft or private variation and confirm that variation's SKU is in `variant-parents.csv` (or listed in `woo-snapshot.json`). Any difference means the key sees less than the shop holds: fix the key's role (an administrator-level read-only key) and run again; do not load from the snapshot. `--verify <woo-snapshot.json> --expect-origin <origin> --expect-visibility <counts.json>` (both are required: the origin is the store you declare, checked against the recorded one; the JSON file holds the admin's per-status counts in the `visibilityChecked` shape, and the recorded counts must equal it) recomputes the checksum and re-runs these rules offline, **and checks the files derived from the snapshot**: it reads `woo-snapshot.provenance.json`, `variant-parents.csv`, `woo-product-status.csv` and `variant-parents.inspect.csv` from the same directory, requires the provenance to record a SHA-256 for each and every one to match, and regenerates the CSVs and the inspection copy from the verified snapshot, which must be byte-identical to the files on disk. A mismatch, a missing file or a missing provenance entry exits 1 with a short list of problems (no file content is echoed). `first-load:prepare` runs the same check on `variant-parents.csv` before it accepts a parent from it (see "Dataset: variant-parents") and on `woo-product-status.csv` before it takes a lifecycle from it (see "Dataset: woo-product-status"). **A snapshot of format 1 (variable products only, taken before this change) is refused** with a message saying it predates the all-products status; take a new one.

**Only the `variable` type is walked for variations.** A plugin product type that also has variations (for example WooCommerce Subscriptions' `variable-subscription`) is listed in `products` and `woo-product-status` with its own status, but its variations are NOT read and it is not a parent in `variant-parents`: a Qoblex variant of such a product is refused as having no parent, never guessed. None is known on the store; the snapshot's `proof.allProducts.byType` shows every type it saw.

**Redirects are refused.** A redirect response is an error and its target is never requested, so the credentials cannot be sent to another origin. **Error text is bounded:** a failed request is reported as its HTTP status and, when the body carries one, a lower-case error code, never the body, a URL or a stack (a plugin or proxy can echo the Authorization header into an error body); as a backstop, the key, the secret and the base64 Basic token are removed from every line the command prints and from the provenance file.

**Rate limiting and retries.** Each request waits `--min-interval-ms` (default 500) after the previous one. A throttled or failed request (HTTP 429, 5xx, a network error) is retried up to three times with a growing wait; a client error (400, 401, 403, 404) is not retried.

**Stock figures are a point-in-time read.** The two walks are minutes apart on a store that is trading, so the second walk is compared with the first on everything EXCEPT the stock figures (`manageStock`, `stockQuantity`, of the products AND of the variations): a sale or a stock push between the walks must not make a good snapshot unverifiable. A status, SKU, type, title, id or variation change still fails the comparison. The file keeps the first walk's stock figures (its own checksum covers them); read them as "as of the first walk", never as an authoritative stock level. The walk asks the store only for the fields it uses (`_fields`) to keep the load low.

**Resumable.** After every page the walk is saved to `woo-snapshot.partial.json` in `--out`. If the walk stops (exit 4), run the same command with `--resume` to continue from the last whole page; a walk of one store is never resumed against another, and an unfinished walk older than `--max-resume-age-minutes` (default 60) is refused, because the store may have changed since. The partial file is removed when the snapshot is complete, and also when the store's answer turns out to be inconsistent (resuming cannot fix that).

### Snapshot exit codes

One table, defined once in `lib/first-load/spec.ts` (`SNAPSHOT_EXIT_CODE_TABLE`) and printed by `--help`.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | The snapshot is complete: every count matches the store's own totals. The snapshot, provenance, variant-parents and woo-product-status files were written. |
| 1 | INCONSISTENT | The store answered, but what it returned cannot be trusted as a complete, consistent catalogue (a count does not match its total header, a variable parent has no SKU, a product or variation SKU repeats, the store changed during the walk, a status the key cannot enumerate) or --verify found a damaged snapshot or derived files (provenance, variant-parents.csv, woo-product-status.csv, inspection copy) that do not match it, or recorded from a store other than the declared --expect-origin. No final file was written. |
| 2 | USAGE | Bad command line. Nothing was read, requested or written. |
| 3 | REFUSED | A precondition refused the run before any request left the machine: the store origin is not on the allowlist (and --allow-any-origin was not given), the credentials file is missing, unreadable, or readable by group or others, or it does not hold the three required values. |
| 4 | FETCH_FAILED | A request failed after its retries (network, HTTP error, unreadable response). What was read so far is kept in the output directory; run again with --resume to continue from it. |
| 5 | OUTPUT_FAILED | The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again. |
| 6 | INTERNAL | A self-check of this command failed. This is a defect in the tool, not in the store's data. |

## Owner lifecycle review sheet

`npm run first-load:lifecycle-review` (`scripts/first-load-lifecycle-review.ts`) writes the Excel sheet the owner uses to give every product that is **draft (or private or pending) in WooCommerce, Archived in Qoblex, or discontinued in Mintsoft** its IMS status before the real load (owner request 2026-11-21: Archived in Qoblex does not necessarily mean end of life). It is **read-only**: it writes nothing to WooCommerce, Mintsoft, Qoblex or IMS.

```bash
npm run first-load:lifecycle-review -- --manifest path/to/run.json --out path/to/shared/lifecycle-review-2026-12-01 --mintsoft-env-file path/to/mintsoft-readonly.env
npm run first-load:lifecycle-review -- --help
```

**Inputs.** The same run manifest `first-load:prepare` reads, verified the same way: the Qoblex products and stock-lots datasets (the stock-on-hand export through its column map: the State, the stock total and the stock per warehouse), the `woo-product-status` dataset bound to its `wooSnapshot` (each product's own status, Woo stock and title; a variation's status, its parent's status and title from the snapshot), `variant-parents` and any `sku-renames`. The run is refused (exit 3, nothing written) without the products or stock-lots dataset, without `woo-product-status`, or when the snapshot bundle does not verify. The manifest's `lifecycle-decisions` input and `lifecycleReview` are ignored here: the sheet shows the lifecycle the first load would set **before** any decision. Ask the owner for a **fresh** Qoblex stock-on-hand export (and bundles, and contacts if they changed) right before generating, and take a fresh WooCommerce snapshot.

**Mintsoft is optional and read with GET only.** `--mintsoft-env-file` names a credentials file (a regular file, mode 600, KEY=VALUE lines; an unknown key is refused; never on the command line, never from the IMS database):

| Variable | Meaning |
| --- | --- |
| `FIRST_LOAD_MINTSOFT_URL` | The Mintsoft API base URL (the connector's own address checks apply). |
| `FIRST_LOAD_MINTSOFT_API_KEY` | The **fixed** Mintsoft API key (`ms-apikey`). It is never exchanged: nothing can reach `/api/Auth`, which would mint a new tenant key and break every other integration. |
| `FIRST_LOAD_MINTSOFT_CLIENT_ID` | The Mintsoft client id; every row of another client refuses the listing (Mintsoft is a shared 3PL tenant). |
| `FIRST_LOAD_MINTSOFT_WAREHOUSE_IDS` | Comma-separated Mintsoft warehouse ids whose physical stock (`TotalStockLevel`) is read and summed. It must cover every warehouse that holds the client's stock (checked against the warehouse list). |

These are keys of the credentials file, not environment variables of the application. The reader uses the reconciliation pack's guarded GET (only `GET /api/Product/List?PageNo&Limit`, `GET /api/Product/StockLevels?WarehouseId` and, for this reader only, `GET /api/Warehouse`, the connection's own origin, no redirect, nothing else can be sent). It pages the product list at the clamped limit of 100 until a short page, requires the page after it to be empty, and reads the whole list a **second time**, which must hold the same products (id, SKU, bundle flag, discontinued flag). It reads the warehouse list: every configured warehouse must be listed, and every listed warehouse that is NOT configured is read too and must hold none of the client's stock (else the sheet would show that stock as absent: name the warehouse in `FIRST_LOAD_MINTSOFT_WAREHOUSE_IDS`). It refuses the listing (exit 3, nothing written) on a repeated id or SKU, a product row that names another client or none, or does not say whether it is a bundle, a discontinued flag (`DisCont`) that is not true or false, a list that changed between the two reads, a stock row of another warehouse or client, or whose product the list does not hold, under another SKU than the list's, or with another bundle flag, more than 200 pages, or more than 500 requests. The credentials file is opened without following a link (`O_NOFOLLOW`) and without blocking (`O_NONBLOCK`: a FIFO named as the file is refused at once instead of hanging the open), and its type and mode are checked on the open file. The Mintsoft status is `discontinued` (`DisCont` true), `active` (false) or `not stated` (no flag). No credential, URL or response body is ever printed. **Without the file the Mintsoft columns read "not read"**, the Notes tab and the command's output say so, nothing is reviewed for a Mintsoft status, and **every Archived decision then needs an override reason** (an unread stock figure cannot clear it).

**Files written** (into `--out`, which must not exist or be empty; the directory mode 700, each file mode 600). Write it to the owner-facing shared folder. Product data only: SKUs, titles, statuses, stock figures, lifecycles; no customer, supplier contact or credential.

| File | Content |
| --- | --- |
| `lifecycle-review.xlsx` | The sheet (tabs below). |
| `lifecycle-review.generation.json` | The generation record: the SHA-256 of each Qoblex products and stock-lots file, the snapshot payload and `woo-product-status.csv`, whether Mintsoft was read (and the digest of its listing), and the review set with each product's proposed lifecycle and stock figures; checksummed, and the sheet id is derived from its digest. Name it in the manifest as `lifecycleReview.generation`. |

**Tabs.**

- **Review**: one row per product or variation in the review set (draft, private or pending in WooCommerce, or under such a parent; Archived in Qoblex; discontinued in Mintsoft), with "Why in review". The owner fills **"New IMS status"** (a drop-down restricted to Discontinued, Archived, Do not sell yet, Active) and, where needed, **"Override reason"**. A row IMS will not load (WooCommerce or Mintsoft only) is shown but cannot be decided: its status stays blank and it carries no sheet id. **The tab is protected, without a password** (a guard against accidents, not a lock: the spreadsheet's own menu lifts it): every cell is locked except "New IMS status" and "Override reason" of the decidable rows, so Excel and LibreOffice refuse a sort, a row insert, or a cut and paste into the locked columns, any of which could move a decision onto another SKU unnoticed. Filtering and widening columns stay allowed. The read-back accepts the sheet whether or not the saving program kept the protection (Excel's hashed form, LibreOffice's legacy form).
- **All products**: every product and variation any of the four systems holds, for the SKU mapping check.
- **SKU mismatches**: one line per flag (below).
- **Notes**: how to fill it in, the status mapping, what was and was not read.
- **_binding** (hidden): the sheet id and the generation digest. The read-back refuses a workbook without it.

**Columns** (Review and All products): IMS SKU (after sku-renames); Name (the WooCommerce title; a variation's is its parent's title and attribute values, the attributes in name order; a product WooCommerce does not hold shows its Qoblex name and "Name source" says so); IMS lifecycle the first load would set; (Review only: New IMS status, Override reason, Why in review); Stock > 0; SKU check; Type; Parent SKU; Qoblex SKU; Woo SKU and Woo id; Mintsoft SKU and Mintsoft product id; Qoblex state (the export's State, before the map turns it into a lifecycle); Woo status; Woo parent status; Mintsoft status; Qoblex stock total and one column per Qoblex warehouse; Woo stock (the snapshot's figure, a variation's included; `not managed` when WooCommerce does not manage it, `not read` when it manages it without a readable quantity; a variation whose stock its parent manages shows the quantity the store reports for it); Mintsoft physical stock; (Review only: Sheet id). A VARIABLE parent shows the SUM of its variations' Qoblex, Woo and Mintsoft figures.

**Highlighting.** A row with stock above zero in ANY one Qoblex warehouse (never the total), in WooCommerce or in Mintsoft is filled yellow ("Stock > 0"); a VARIABLE parent when any of its variations is; the SKU cells and the SKU check of a row with a mismatch are orange.

**SKU mapping.** SKUs must be identical across Qoblex, WooCommerce, Mintsoft and IMS (as it will load, after the renames). Rows are joined by EXACT SKU only, never by name: WooCommerce and Mintsoft are matched to the IMS SKU, or, for a renamed SKU, to the Qoblex spelling (flagged). The flags: `MISSING` (a system lacks the SKU; a VARIABLE parent is expected only in WooCommerce and IMS, a NON_INVENTORY product is not expected in Mintsoft, and nothing is flagged for Mintsoft when it was not read); `RENAMED` (Qoblex, or WooCommerce or Mintsoft, still holds the pre-rename SKU, for example `AV261-1-0x` loaded as `958523271-0x`: fix it in that system if it is kept); `CASE_OR_WHITESPACE` (another system holds a SKU that differs only in letter case or whitespace: NEVER joined, flagged on both rows). WooCommerce SKUs are trimmed by the snapshot, so a whitespace difference there is not visible; Qoblex and Mintsoft SKUs are compared exactly as exported.

**Formula-safe.** Every text cell is an inline string and no cell is a formula, so nothing in the sheet is evaluated on opening; a text that a spreadsheet would read as a formula when typed or re-imported (leading `=`, `+`, `-`, `@`, tab or carriage return; WooCommerce titles are untrusted) is also given the "quote prefix" style, so it stays text if the owner edits the cell. The value itself is unaltered.

**No spreadsheet library.** The `.xlsx` writer and reader are the small, dependency-free `lib/first-load/lifecycle-review/xlsx.ts` (Node's own deflate, inflate and CRC-32): no spreadsheet library is in `package.json`, and the candidates pull a large dependency tree for a subset this narrow. The reader reads what Excel, LibreOffice, Numbers and Google Sheets save (shared strings, rich text, escapes, a protected sheet) and refuses an encrypted, ZIP64 or oversized archive, a part that inflates beyond its declared size, a local header that disagrees with the archive directory, a DOCTYPE, malformed XML, an unknown entity or bare `&`, a character XML cannot carry (a lone surrogate; in a CDATA section too), a row or cell given twice or out of order, and a row or column beyond the sheet limits (1,048,576 rows, column XFD). U+FFFD (a character already lost in a conversion) is refused only in the four decision columns the read-back trusts (see "Dataset: lifecycle-decisions"); a product name that carries it from WooCommerce or Qoblex is written and shown as it is. A review row whose IMS **SKU** holds U+FFFD could never be decided, so the command refuses it (exit 3) and names the SKU: fix it at the source or rename it with `sku-renames`.

**Operator steps.**

0. **Once, before the real generation: a read-only probe of the live Mintsoft API** (with the owner's OK; GET only, the fixed key, never `/api/Auth`). Run `first-load:lifecycle-review` once with `--mintsoft-env-file` into a scratch folder (not the shared one) and confirm it is not refused on the warehouse coverage or the stock rows: `GET /api/Warehouse` must list every warehouse in `FIRST_LOAD_MINTSOFT_WAREHOUSE_IDS` with one usable id per row, and `GET /api/Product/StockLevels?WarehouseId=<id>` for every listed warehouse must answer rows that name that warehouse, the client and a product of the list. A refusal names what Mintsoft answered differently: report it before the real generation, do not work around it. Check the request budget too: the listing takes 2 x (pages + 1) product-list requests (100 products a page), one warehouse-list request and one stock request per listed warehouse, at most 500 in all, about 0.35 s apart; for a catalogue of N products that is about 2 x (N / 100 + 2) + 1 + warehouses requests. Delete the scratch folder afterwards.
1. Take a fresh WooCommerce snapshot (`first-load:woo-snapshot`) and ask the owner for a fresh Qoblex stock-on-hand export (plus bundles, and contacts if they changed); update the run manifest.
2. Run `first-load:lifecycle-review` with `--mintsoft-env-file` (a read-only use of the fixed key) into a new folder in the owner-facing shared folder. Check the output line: the number of rows to review, how many hold stock, the SKU mismatches, and that Mintsoft was read.
3. Send `lifecycle-review.xlsx` to the owner. The owner picks a New IMS status for every decidable Review row, writes an override reason for any Archived product that holds stock, does not edit the SKU or Sheet id columns or delete the hidden tab, and saves it as `.xlsx` (or exports the Review tab as CSV UTF-8). The SKU mismatches tab lists what to fix in Qoblex or Mintsoft.
4. Add to the run manifest `"lifecycleReview": {"generation": "<folder>/lifecycle-review.generation.json"}` and the input `{"dataset": "lifecycle-decisions", "file": "<the filled file>"}`.
5. Run `first-load:prepare --dry-run` and read every `LIFECYCLE_FROM_DECISION`, `ARCHIVED_WITH_STOCK_OVERRIDE`, refusal, `LIFECYCLE_DECISION_MISSING` and `LIFECYCLE_REVIEW_SET_CHANGED`; send any refusal or undecided row back to the owner. If the real run's exports are fresher than the sheet's, `LIFECYCLE_REVIEW_SET_CHANGED` lists the products that joined the review set since: generate the sheet again, or get the owner's decision for each and add it as a row. A real prepare is blocked until every review-set product is decided.
6. Archiving the owner's Archived products in Mintsoft is a separate step (not part of this command): plan it with `first-load:mintsoft-archive` (below), and write it with the same command's `--execute` after the import, at the cut-over.

### Lifecycle review exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | The sheet and its generation record were written. |
| 2 | USAGE | Bad command line or an invalid run manifest. Nothing was read, requested or written. |
| 3 | INPUT_UNUSABLE | An input cannot be used: a manifest file or column map, the products or stock-lots dataset missing, the WooCommerce snapshot bundle not verified, a review row whose SKU holds U+FFFD, or the Mintsoft credentials file refused or its listing unreadable. Nothing was written. |
| 4 | OUTPUT_FAILED | The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again. |
| 5 | INTERNAL | A self-check of this command failed (the sheet just written does not read back). A defect in the tool. |

## Mintsoft archive for Archived decisions

Owner requirement (2026-11-21): after the sheet is imported, every product the owner set to **Archived** must also be archived (discontinued, `DisCont`) in Mintsoft. Mintsoft is LIVE and shared, so this is a separate operator command: a dry run (the default) that plans, and an explicit `--execute` that writes the reviewed plan.

```bash
# 1. the dry run: read only, prints the plan and its token
npm run first-load:mintsoft-archive -- --manifest path/to/run.json --mintsoft-env-file path/to/mintsoft.env
# 2. the write (LIVE), with the token the dry run printed; only once step M is live in the target (below)
npm run first-load:mintsoft-archive -- --manifest path/to/run.json --mintsoft-env-file path/to/mintsoft.env \
  --execute --plan-token MSA-0123456789abcdef --env-file path/to/ims.env --expect-db <database> --expect-system-id <system identifier> --operator "<your name>"
npm run first-load:mintsoft-archive -- --help
```

**What it reads.** The same run manifest as `first-load:prepare`, with `lifecycleReview.generation` and the `lifecycle-decisions` input (the owner's filled sheet). It runs the transform exactly as a real prepare does (pure: nothing is written) and plans every product whose lifecycle comes from an owner decision and is ARCHIVED. It **refuses to plan** (exit 3, Mintsoft not read) when the decisions would not import: not bound to a verified sheet (`LIFECYCLE_DECISIONS_NOT_BOUND`), a refused decision row (for example Archived with stock and no override reason), an undecided review row (`LIFECYCLE_DECISION_MISSING`), or a review set that changed or cannot be checked. When a real prepare of the manifest is blocked by any other finding, the plan is printed with a `BLOCKED` line and the dry run exits 1 (the import cannot have been made from that manifest), and `--execute` is refused. Then it reads Mintsoft with GET only through the lifecycle review's guarded reader (the same credentials file and the same completeness checks: two equal scans of `Product/List`, the warehouse list, the physical stock of every configured warehouse; see "Owner lifecycle review sheet"), with each product's bundle flag.

**The plan.** One line per Archived SKU, matched to Mintsoft by EXACT SKU only: the Mintsoft product id, its current `DisCont`, its physical stock (summed over the configured warehouses; `none` when no configured warehouse has a stock row for it), and the outcome:

| Outcome | Meaning |
| --- | --- |
| `WOULD_ARCHIVE` | Not discontinued, a stock row with physical stock 0, not a bundle: the product a write would change. |
| `SKIP_ALREADY_DISCONTINUED` | Already discontinued in Mintsoft: nothing to change (reported with its stock). |
| `SKIP_NOT_A_WMS_PRODUCT` | A VARIABLE parent or a NON_INVENTORY product that Mintsoft does not hold under exactly its SKU. A VARIABLE parent is looked up first: when Mintsoft holds the parent SKU, it is planned like any product. |
| `REFUSED_NOT_FOUND` | Mintsoft holds no product under exactly this SKU (the line names a pre-rename spelling, exact or differing only in letter case or whitespace, or a letter-case/whitespace near match Mintsoft holds instead; fix the SKU there). |
| `REFUSED_BUNDLE` | The Mintsoft product is a bundle (built from other products): whether to discontinue it is a separate decision, made in Mintsoft, never written here. |
| `REFUSED_FLAG_NOT_STATED` | The Mintsoft row carries no `DisCont` flag, so its state cannot be shown or verified. |
| `REFUSED_NO_STOCK_ROW` | No configured warehouse has a stock row for the product: its stock is unknown, never read as 0. |
| `REFUSED_STOCK` | Mintsoft physical stock other than zero: never archived while it holds stock. |

It ends with a **plan token** (`MSA-` and 16 hex digits) and the plan digest, derived from every line (SKU, outcome, product id, flag, stock, whether a stock row exists), the sheet id, the warehouses read, the Mintsoft client id, the origin of the connection and whether a real prepare is blocked: any change between two runs gives another token. Nothing is signalled through Mintsoft notes (the warehouse does not read them). No credential, URL or response body is printed.

**The write (`--execute`).** Verified shape (owner-approved live test on one zero-stock product, 2026-11-21, restored afterwards): `POST /api/Product` with ONLY `{ID, SKU, DisCont: true}`; Mintsoft answers HTTP 200 with `{Success, Message, ...}` and success is `Success: true` ("Product Successfully Updated!"); a read-back with `GET /api/Product/{id}` shows only `DisCont` changed (and `LastUpdated`, `LastUpdatedByUser`). A FULL product body is refused with HTTP 200 and `Success: false` ("One or more pallet sizes are not valid!"), so HTTP 200 alone proves nothing and the full body is never sent. Mintsoft's edge answers 403 to a request without a User-Agent; the writer sends one.

`--execute` writes only when ALL of these hold; otherwise it exits 3 (or 1 for a plan that refuses a SKU) and nothing is sent to Mintsoft:

1. the run manifest's decisions would import and a real prepare is not blocked;
2. the IMS target is confirmed as `first-load:apply`'s is: named by `--env-file` (its `DATABASE_URL`; the environment is replaced by a short whitelist), and the server's own `current_database()` and cluster system identifier equal `--expect-db` and `--expect-system-id`;
3. no other run holds the target's advisory lock (`pg_try_advisory_lock`, key `FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY` in lib/db/advisory-locks.ts; taken before anything is read, released when the run ends): one run at a time. The command's one session is built by the session-lock factory, so its `DATABASE_URL` must reach the database directly (not through a transaction pooler); an env file that sets `DATABASE_SESSION_LOCK_URL` is refused (use a copy with a direct `DATABASE_URL`), and so is an operator shell that exports it (it would move the session and the lock off the file's `DATABASE_URL`);
4. the system switch **`first_load_mintsoft_archive_enabled`** reads exactly `true` in that target (default off; an ADMIN switch, set with `npm run settings:set ... --confirm-admin`, see docs/installation.md). It is read again before every POST: turning it off stops the run before the next write;
5. **step M is live in the target installation**, judged on the variables of the target's env file, never the operator's shell: the producer disposition of the ownership row `mintsoft / product.discontinue` is LIVE (its grant `MINTSOFT_WRITE_ALLOWED` is set and the Mintsoft step's `MINTSOFT_WRITES_LIVE_FROM` instant is reached), the producer hold of that environment (`PRODUCER_HOLD_ENFORCED_DESTINATIONS`) does not hold Mintsoft, and its grant admits `POST /api/Product` to exactly the credentials file's base URL and client id. This alone does NOT prove that the woo-mintsoft plugin and the bridge product sync are retired: stage carries `MINTSOFT_WRITES_LIVE_FROM` and the grant during its stage proof while it is wired to the LIVE Mintsoft client and production's plugin and bridge still sync, and an M rollback hands back to the bridge. So it also requires **retirement evidence that lives in the target installation**: the target's newest `bridge-units-masked` writer attestation (read in the same READ ONLY transaction as the import proof below), judged exactly as `npm run writers:check` judges it from step M (the three bridge units masked and inactive, the report generated and recorded at or after the step-M instant, the last trigger before it, `never` only with a journal that reaches back before it), and generated **no more than 24 hours** before the run (an older report says nothing about the bridge now; a rollback resumes it). Stage has no bridge and so no such attestation, and refuses. The step-M instant and the attestation (when it was recorded and generated, the last trigger) are recorded with every write (`stepEvidence`, `retirementEvidence`). This is checked once before Mintsoft is read; the same environment's grant and hold judge every request. The attestation covers the bridge host; the plugin's own product webhook and sync switches are retired in the same step-M actions and are checked by `writers:check`'s companion-plugin probe, which this command does not call (it never calls WooCommerce): run `npm run writers:check` against the target and see it pass before `--execute`;
6. the plan recomputed now, from a fresh Mintsoft read (the credentials file is parsed once, for the census and the writer alike), has exactly the token given in `--plan-token`, and refuses no SKU;
7. **the import is proven**: every SKU to be written is an IMS product, under exactly that SKU, whose lifecycle is `ARCHIVED` in the target (read in one READ ONLY REPEATABLE READ transaction with the switch). This proof was chosen over a digest of the applied run: a digest proves that some run was applied, the lifecycle proves that THIS decision reached IMS and is still in force (a product an operator has since set back is not archived in Mintsoft).

Then, one WOULD_ARCHIVE SKU at a time and paced (at least one second between any two requests), it:

1. re-reads the product (`GET /api/Product/{id}`): it must be the plan's id, EXACTLY the plan's SKU, our client, not a bundle and not discontinued;
2. re-reads its physical stock live: the warehouse list (`GET /api/Warehouse`, every configured warehouse must be in it), then EVERY listed warehouse (`GET /api/Product/StockLevels`); a configured warehouse must have a stock row for the product, the total over all listed warehouses must be exactly 0, and a stock row under the product's SKU but another product id refuses;
3. reads the switch again, and records the attempt in the target's activity log (`activity_logs`, entity PRODUCT, action `first_load_wms_archive_attempt`); a switch turned off or a failed record stops the run before anything is sent;
4. sends `POST /api/Product` `{ID, SKU, DisCont: true}` and requires `Success === true`. A failure says whether the request may have reached Mintsoft: refused before it left IMS (the hold, the grant, the request gate: nothing was sent), or dispatched with no usable answer (a dropped connection, a timeout, another status: it may have reached Mintsoft). It is never retried;
5. reads the product back: `DisCont` must be `true` and no other field may differ from the read of step 1 (`LastUpdated` and `LastUpdatedByUser` excepted);
6. records the verified write (`first_load_wms_archive_verified`), or the failure of any attempt it recorded (`first_load_wms_archive_failed`, level ERROR, with the flag as read back when the request may have left, and whether it was sent). Each entry's metadata holds the SKU, the Mintsoft product id, `DisCont` before and after, the operator, the plan token, the sheet id, the step-M evidence and the retirement evidence.

It **stops at the first answer that is not exactly the expected one** (exit 4, `WRITE_STOPPED`) and prints a summary: the SKUs written and verified, the SKU it stopped at and whether its request was sent (if so, check that product in Mintsoft by hand), and the SKUs not attempted.

The transport guards apply as to every Mintsoft write, judged on the target's environment: the writer can send only `GET /api/Product/{id}`, `GET /api/Warehouse`, `GET /api/Product/StockLevels?WarehouseId=<n>` and `POST /api/Product` (no parameters, the connection's own origin, no redirect), every hop also passes the producer hold's gate, and the POST is refused before it leaves (nothing sent) unless the target's `MINTSOFT_WRITE_ALLOWED=<base URL>|<client id>` names exactly this tenant. The key is the fixed key of the credentials file; `POST /api/Auth` is unreachable. In the writer-ownership map this is the row `mintsoft / product.discontinue`: P1 the owner by hand in Mintsoft, P2 (step M) this IMS operator command; `npm run writers:check` reports it as an operator-triggered writer that is possible while the switch is on.

**The woo-mintsoft plugin: the rule.** The plugin owns `product.upsert` until step M, and whether its product sync sends `DisCont` (and so resets a product to not discontinued on its next sync) is not known. So **`--execute` runs only after the plugin's product sync is retired at the cut-over**, and the command enforces it with two facts of the target installation (condition 5): step M is live in its env file (the grant and the live-from instant, the same values every IMS producer of the Mintsoft step obeys), and its own records hold a fresh `bridge-units-masked` attestation that `writers:check` would pass. The env file alone was not enough (#1128 R2): stage carries the step-M variables during its proof while production's plugin and bridge still sync, and a rollback resumes the bridge. A command-line attestation flag was not chosen: the attestation is the same recorded evidence the switchover check already requires, so there is one record of "the bridge is retired", not two. As a check after the run, open one written product in Mintsoft a day later and confirm `DisCont` is still true.

**Operator checklist.**

1. The import is applied (`first-load:apply`) to the target, and step M is live there: the woo-mintsoft plugin's product sync is retired, and the target's env file carries `MINTSOFT_WRITE_ALLOWED` for the tenant and a reached `MINTSOFT_WRITES_LIVE_FROM` (the command refuses otherwise). Within the 24 hours before the run, run `scripts/bridge/bridge_writers_status.py` on the bridge host and record it in the target (`npm run writers:attest -- --kind bridge-units-masked --by <name> --output-file <file> --yes`, see the step-M runbook), then run `npm run writers:check` against the target and see it pass. Run the command with no `DATABASE_SESSION_LOCK_URL` exported in the shell (it is refused).
2. Run the dry run; read every line; resolve every `REFUSED_*` line in Mintsoft or with the owner; run it again until it exits 0. Note the plan token.
3. Get the owner's go for the write at that time.
4. `npm run settings:set -- --key first_load_mintsoft_archive_enabled --value true --by <name> --reason "<owner's go>" --yes --confirm-admin` against the target.
5. Run `--execute` with the token and the target confirmation. A token mismatch means Mintsoft or the decisions changed: go back to 2.
6. Read the summary. On a stop, BEFORE running again: read the `first_load_wms_archive_failed` record of the SKU it stopped at in the target's activity log (`problem`, whether the request was sent, `discontinuedAfter`), open that product in Mintsoft by hand and compare it with the record, fix the cause, then run the dry run again (verified products then read `SKIP_ALREADY_DISCONTINUED`) and review the new plan.
7. Set the switch back to `false` with `npm run settings:set`.
8. A day later, open one written product in Mintsoft and confirm `DisCont` is still true.

### Mintsoft archive exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | Dry run: the plan was printed, no SKU is refused and a real prepare of the manifest is not blocked (the plan may be empty). `--execute`: every WOULD_ARCHIVE SKU was written and verified. |
| 1 | BLOCKING_FINDINGS | The plan was printed and at least one Archived SKU is refused (not found, a bundle, no discontinued flag, no stock row, or physical stock other than zero), or a real prepare of the manifest is blocked by other findings: resolve each before any write. With `--execute` nothing was written. |
| 2 | USAGE | Bad command line or an invalid run manifest. Nothing was read or requested. |
| 3 | INPUT_UNUSABLE | An input cannot be used: a manifest file, the decisions not bound to a verified review sheet, a refused or missing decision, a review set that changed or cannot be checked, or the Mintsoft credentials file refused or its census unreadable. With `--execute` also: the IMS target not confirmed or unreadable, another run holding its lock, the switch not on, step M not live in the target (or its hold or grant refusing the write), no fresh `bridge-units-masked` attestation in the target that `writers:check` would pass, a plan token that does not match the plan made now, or an import that is not proven. Nothing was written. |
| 4 | WRITE_STOPPED | `--execute` stopped at the first answer that was not exactly the expected one (a re-read that differs, stock that appeared, the switch turned off, a write Mintsoft refused or that got no usable answer, a read-back that does not verify, or a record that could not be written). The SKUs written and verified before it are listed and recorded; nothing after it was attempted. |

## Output files and load order

The numeric prefix is the load order: suppliers, products, opening stock, transfers, purchase orders. Each file has the importer's exact template header (below), CRLF line endings, no BOM. Load each file's dry-run preview first and the real import only when it is clean.

Idempotence of re-importing: suppliers and products update by name or SKU; transfers and purchase orders skip a key that exists; opening stock is **not repeatable**: once any movement exists for a SKU and warehouse the importer refuses it. A database restore point is the only rollback
for opening stock (see the first-load work items). This tool's own output is idempotent: the same input gives the same bytes.

### Output header: suppliers

Importer: `importSuppliersCsv` (app/actions/suppliers.ts). Template: `app/api/export/suppliers/route.ts`.

```text
supplierId,name,contactName,email,phone,currency,vatNumber,accountNumber,paymentTermsDays,addressLine1,addressLine2,city,county,postcode,country,notes,purchaseTaxType
```

### Output header: products

Importer: `importProductsCsv` (app/actions/import.ts). Template: `app/api/export/products/route.ts`.

```text
productId,parentProductId,sku,name,description,type,parentSku,barcode,mpn,countryOfOrigin,preferredSupplierId,preferredSupplierName,preferredSupplierLocked,weight,widthCm,heightCm,depthCm,salesPriceBase,salePriceBase,salesPriceTaxInclusive,stockUnit,oversellAllowed,imageUrl,active,lifecycleStatus,components,category
```

### Output header: opening-stock

Importer: `importOpeningStockCsv` (app/actions/import.ts). Template: `app/api/export/stock-levels/route.ts`. The last four columns are informational; the importer reads `sku`, `warehouseCode`, `qty` and `unitCostBase`.

```text
sku,warehouseCode,qty,unitCostBase,productName,type,stockUnit,warehouseName,reserved,available,inventoryValueBase
```

### Output header: transfers

Importer: `importTransfersCsv` (app/actions/import.ts). Template: `app/api/export/transfers/route.ts`.

```text
transferKey,fromWarehouseCode,toWarehouseCode,status,sku,qty,notes
```

### Output header: purchase-orders

Importer: `importPurchaseOrdersCsv` (app/actions/import.ts). Template: `app/api/export/purchase-orders/route.ts`. Orders are created as DRAFT by the importer and stay DRAFT.

```text
orderKey,supplierName,currency,fxRateToBase,destinationWarehouseCode,sku,qty,unitCostForeign,lineDiscountForeign,lineDiscountStr,taxRateName,taxRateValue,orderTaxRateName,orderTaxRateValue,pricesIncludeVat,supplierRef,expectedDelivery,lineExpectedDelivery,orderDiscountForeign,notes,createdOn
```

`lineExpectedDelivery` is an optional per-line YYYY-MM-DD date (blank = the line follows `expectedDelivery`); the first-load transform leaves it blank. `createdOn` (the last column) is the order's created day, written only for a foreign-currency order: a SYSTEM import (the apply runner) prices the order at the END of that day, so the stored rate is the `fx_rates` rate at that instant. The importer takes NO rate from the file: a stated `fxRateToBase` that is not exactly that table rate refuses the order (a web import ignores `createdOn` and is held to the rate now). The apply rail `po-fx-rate` checks the same equality, decimal-exact, with no tolerance and no comparison with today's rate.

`tests/first-load/importer-headers.test.ts` reads each route's source with the TypeScript parser and compares the list passed to `buildTemplateCsv(...)` with these, so a renamed header on either side fails the test.

## The report

`validation-report.json` (machine) and `validation-report.md` (people) hold: the inputs with their SHA-256, the checks that ran and the ones that did not, the accounting identity per dataset and per reason code, every finding, every rejected and excluded record
with its line, the opening-stock collapse (lot total, collapsed total, residual), the zero and missing lists, the R14 presence matrix, the recipe cycles, the warehouse codes the files use (to compare with IMS), SKU-normalisation counts, and the output files with their SHA-256. Findings are ERROR (blocks), WARNING or INFO.
The report is deterministic: row-level entries are sorted by dataset, outcome, code and key, so the only content that differs between two input orderings is the line numbers (and the input file hashes).

## Apply-time checks this tool cannot prove

Every importer rejection rule that depends on what is in IMS. The importers' CSV dry-run preview skips parts of `createPurchaseOrder` and `createTransfer`, so a clean preview does not prove the purchase-order and transfer rules either: the apply step must verify each one before any real import. The same list is printed in every report.

| Id | Area | Check |
| --- | --- | --- |
| warehouse-exists | opening-stock, transfers, purchase-orders | Every warehouse code in the files exists in IMS (the importers refuse an unknown code; the report lists the codes used). |
| base-currency | all | The manifest baseCurrency equals the organisation base currency in IMS (the importers compare against IMS, not the manifest). |
| opening-stock-empty | opening-stock | The product and warehouse have no stock, cost layer or movement yet (importOpeningStockCsv refuses otherwise; it is not repeatable). |
| opening-stock-fx-rate | opening-stock | Every foreign-currency lot behind an opening-stock row was priced at EXACTLY the rate IMS's fx_rates gives for its currency at the end of the lot's received day, and its base cost is its foreign cost over that rate (the prepare step read the rate from the supplied ims-fx-rates rows and carries every lot's currency, received day, foreign cost, rate and base cost in the report's stock.lots, which must reproduce the hashed opening-stock rows; the file itself holds only the collapsed weighted average). Any difference, or a missing or unusable live rate, refuses the run before opening stock is written. The CSV dry-run does not run this. |
| po-supplier-exists | purchase-orders | Each supplier name exists in IMS (matched case-insensitively); the suppliers file creates them only when it is loaded first. |
| supplier-tax-rate | suppliers | Each supplier's purchaseTaxType (a Xero tax type) resolves to exactly one active IMS tax rate that is usable for purchases (usedFor PURCHASE or BOTH) and carries that accountingTaxType. Several matching rates refuse the run; with none, the apply step first imports the rate from the stored Xero tax-rate list and refuses only if that import is refused (see docs/first-load-apply.md); the supplier importer sets the supplier's default tax rate to it and refuses the row otherwise. The tool performs this only against an ims-tax-rates list you supply; WITHOUT it the report says the resolution was NOT checked. |
| po-fx-rate | purchase-orders | Every non-base order's fxRateToBase is EXACTLY the rate IMS's fx_rates gives for its currency at the end of the order's created day (the createdOn column; it was looked up there at prepare time). An order's rate is always the table rate: the purchase-order importer takes none from the file and refuses a stated rate that differs. It is not compared with today's rate, so an order created long ago may have a rate far from today's. The CSV dry-run does not run this. |
| po-tax-rate | purchase-orders | Each line's taxRateName (names are matched case-insensitively, trimmed) or, when only a taxRateValue is given, its value (matched within 0.00005) resolves to an active IMS purchase tax rate, and no rate IMS applies (named, or the supplier default) is above the manifest maxPurchaseTaxRate. A line never carries both: the tool cannot show a name and a value agree. |
| lookup-keys-unique-in-ims | all | In IMS no two suppliers (name), warehouses (code), products (SKU) or tax rates (name) collide under the importers' case-insensitive matching: they build a Map and the last duplicate wins silently. The tool performs the supplier and SKU parts only against an ims-suppliers / ims-skus list you supply; WITHOUT that list the collision check against IMS is NOT performed and the report says so. Warehouse codes and tax names are never checked by the tool. |
| po-reference-free | purchase-orders | No existing purchase order already has a prefixed orderKey as its reference (an existing one is skipped, not updated). |
| po-product-lifecycle | purchase-orders | Products that exist in IMS but not in the products file are ACTIVE or DRAFT (the file's own products are checked here). |
| transfer-reference-free | transfers | No existing transfer already has a prefixed transferKey as its reference. |
| transfer-source-stock | transfers | The opening-stock file for the source warehouse has been loaded first, nothing is reserved against it, and its cost layers cover the dispatched quantity. |
| barcode-free | products | No barcode in the products file is already used by a product that exists in IMS. |
| product-parent-exists | products | A VARIANT's, KIT's or BOM's parent is in an earlier or the same file (proved here) or already in IMS. |

The rules the tool does prove: required fields, quantity and cost signs and scales (every emitted number is checked against the scale of the column it is stored in: weight 4 dp, dimensions 2 dp, prices 4 dp, quantities 4 or 6 dp, costs 6 dp, exchange rate 8 dp, tax rate 4 dp as a fraction, and rejected rather than rounded), date shapes, the lifecycle of products in the catalogue file (a purchase order line needs ACTIVE or DRAFT, a transfer anything but ARCHIVED; `active` FALSE means EOL), order-group consistency and the value ranges of every column written.

## Known gaps

- WooCommerce, Mintsoft and Xero have no file maps: they are read through the connectors in separate steps (see the scope above).
- The Qoblex stock report has no parent products for its variants (see "Qoblex native exports"); the VARIABLE parents come from WooCommerce through `first-load:woo-snapshot`. Until the owner has run it against the real store, no variant can load. Variants that match no WooCommerce variation, and WooCommerce variable products with no Qoblex variant, are reported and never guessed. Whether a read-only key can list the variations of private and draft products is not yet established: the completeness proof would refuse the snapshot if it could not.
- A run that supplies `woo-product-status` without `variant-parents` can be prepared but not applied (the apply manifest requires the variant-parents binding); the real load always supplies both.
- `externalProductId` (the WooCommerce link) is not set by the products import file; the connector link step does that after the first load.
- Supplier product costs (`SupplierProduct`): there is no CSV importer, so nothing is produced. They are a backfill and may follow go-live.
- Customers: no source is defined for them in this work; they are not read.
- Warehouse codes, tax rate names and supplier names for suppliers that already exist in IMS cannot be checked without the database; the importers' own dry-run preview does that.
- The org base currency is asserted by the manifest, not read from IMS.
- Units: `stockUnit` is passed through (normalise its spelling with `valueMaps`). **Quantities are taken to be in stock units**; the tool does no purchase-unit to stock-unit conversion, and `PurchaseOrderLine.qty` is defined as stock units.
- Currency: codes are upper-cased and must be 3 letters; the rate is whatever the source gives, read as foreign units per one base unit (confirm the direction from the sample: the importer divides by it). Converting a lot cost by division rounds at 80 significant digits, far below the 6 dp the average is rounded to. Whether a rate is the right one for the cost date is not checked.
- A PO's original reference is kept (prefixed) as the new order's reference, but reconciliation R8 still proves outstanding quantity, not PO identity.
