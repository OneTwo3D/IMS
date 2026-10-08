# First-load input spec and preparation tool

This is the technical reference for `scripts/first-load-prepare.ts` (`npm run first-load:prepare`), the file-in, file-out step that turns the
incumbent systems' exports into files the **existing** CSV importers can load, and says in a report what it did to every row.

It is pure: **no database, no network**. It reads the files named in a run manifest and writes into an output directory. It never loads anything
anywhere; uploading the files through the importers (dry-run preview first) is a separate, deliberate step.

Scope of this tool and what is still open:

- Built: the canonical input datasets, the validators and transforms, the report, the CLI, and the **real column maps for the four Qoblex exports**
  (`tests/first-load/fixtures/qoblex-native/maps/`, see "Qoblex native exports").
- **Where each system's data comes from.** Qoblex has no API, so **Qoblex is the one file-based load, and it goes through this tool.** Xero (chart of accounts,
  tax rates, trial balance), Mintsoft (products, stock) and WooCommerce (products, orders, tax rates, order statuses) are read **through the existing read-only
  connectors, as separate steps**; this tool has no column maps for them and none are planned. The `wms-*` and `woo-products` datasets stay in the tool only so the R14
  coverage check can be rehearsed offline from files (the maps under `tests/first-load/fixtures/maps/` use **invented headers** to prove the mechanism; do not copy a
  header from them into a real map). In a real run the coverage inputs come from the connectors.
- **Not built here:** the apply runner that drives the importers (a later work package).
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

- `baseCurrency` is required and never assumed. It must be the organisation's base currency in IMS; the tool cannot read IMS, so the apply step must check it.
- `asOf` is optional (YYYY-MM-DD). It is only used to date-check transfers. The tool never reads a clock.
- `maxPurchaseTaxRate` is required when a purchase-order-lines dataset is supplied: the highest purchase tax rate, as a fraction (`"0.25"`), that any IMS tax rate or supplier default could apply. The importer resolves tax rates by name inside IMS, which this tool cannot read, so every order's total is bounded with this rate and a line whose `taxRateValue` is above it is rejected. It is an assertion the apply step must check against IMS.
- `inTransitConvention` is required when a `transfers` dataset is supplied (see "In-transit stock").
- `purchaseOrderKeyPrefix` and `transferKeyPrefix` are required when the matching dataset is supplied. They are prefixed to every order or transfer key so a loaded
  reference cannot collide with a reference IMS generates later.
- An input with `columnMap` is a native export read through that map; an input without it must already be a canonical file (below).
- A dataset may be listed more than once, once per file (the same file twice is refused). The files are read in the order listed and their records are concatenated.
  Line numbers of the second and later files are reported as `N * 1,000,000 + the physical line` (the first file is 0). An input may carry `"supersedesEarlier": true`
  (products only, and only after an earlier file for the same dataset): a product row in an EARLIER file with the same SKU (upper-case) is then replaced by the row in this file, and
  each replaced row is booked as excluded with the code `SUPERSEDED_BY_LATER_FILE`, so the accounting still reconciles. **The rows are merged field by field, not swapped:** a field the later file leaves blank or does not read (barcode, active, ...) keeps the earlier value (the excluded row's reason lists what was kept); a later non-blank value fills an earlier blank; a non-blank field that DIFFERS between the files (name, barcode, ...) rejects the later row as `SUPERSEDE_CONFLICT` with the field names; and the type may only change SIMPLE to KIT or BOM. Without the flag, two files naming one SKU are two conflicting
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
| `fxRateToBase` | no | Required when `currency` is not the base currency; blank or 1 for the base currency. Foreign units per ONE base unit (as in the purchase-order importer, which divides by it): base cost = cost / rate. At most 8 decimal places (the stored scale, Decimal(18,8)): a finer rate is rejected, never rounded. |
| `receivedDate` | no | Informational. |
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
| `currency` | no | 3-letter code. |
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

### Dataset: purchase-order-lines

Reduced to the outstanding quantity per line.

| Column | Required | Meaning |
| --- | --- | --- |
| `orderKey` | yes | The incumbent's PO number. Written as `<purchaseOrderKeyPrefix><orderKey>`. |
| `supplierName` | yes | Must be in the suppliers dataset, or (when supplied) in the ims-suppliers list. |
| `status` | no | OPEN (default if blank), CLOSED or CANCELLED. Anything not OPEN is excluded. |
| `currency` | yes | 3-letter code. |
| `fxRateToBase` | no | Required when `currency` is not the base currency. Foreign units per ONE base unit; the importer divides by it. At most 8 decimal places (the stored scale, Decimal(18,8)): a finer rate is rejected, never rounded. |
| `destinationWarehouseCode` | no | Passed through as given (trimmed). |
| `sku` | yes | Passed through as given (trimmed). |
| `lineNo` | no | The incumbent's line number. When an order repeats a SKU, EVERY such row must carry a non-blank line number and no two may share one; otherwise all of them are rejected as duplicates. A blank, space or zero-width value never makes a row distinct. |
| `qtyOrdered` | yes | At most 4 decimal places. |
| `qtyReceived` | yes | At most 4 decimal places. |
| `unitCostForeign` | yes | At most 6 decimal places and 9 integer digits. |
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
| `qty` | yes | Plain decimal, zero or more. Rows for one SKU are summed. |

### Dataset: woo-products

Used only for the four-way SKU coverage check. WooCommerce is never a source for recipes.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | A row without a SKU is excluded (and reported). |
| `wooProductId` | no | Passed through as given (trimmed). |
| `type` | no | Passed through as given (trimmed). |

### Dataset: sku-exclusions

The explicit, owner-accepted exclusion list. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | A SKU listed here is deliberately not loaded and is exempt from the coverage check. |
| `reason` | yes | Written reason. An exclusion without one is refused. |

### Dataset: ims-suppliers

Supplier names that already exist in the target IMS. Omit it for an empty database. Always a canonical file.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | An existing supplier's name. A new supplier whose name collides with one of these under the importers' matching (upper-case or lower-case, a different spelling) is rejected; purchase-order supplier names are checked against it when no suppliers dataset names them. **Without this list the collision check against IMS is not performed** (the report says so). |

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
| `delimiter` | `,` (default), `;`, tab or `\|` |
| `decimalSeparator` | optional; only `.` is accepted |
| `rowsAboveHeader` | `0` (default) or `1`: one row of labels above the header row (needed by `wide`; also set on a map that reads the same file without `wide`, so the label row is skipped) |
| `wide` | the wide warehouse blocks layout (below) |
| `rowSelect` | `{ "column", "keep": [...], "skip": [...] }`: a closed list of the values of one source column; see "Row kinds and grouped parents" |
| `parentFrom` | `{ "column", "parentValues", "skuColumn", "into" }`: rows after a parent row inherit its SKU; see "Row kinds and grouped parents" |
| `derived` | canonical column to the canonical column it is derived from, e.g. `{ "currency": "supplierName", "fxRateToBase": "currency" }`; each needs its own closed `valueMaps` entry |
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
- `totals` (required, and it must have an entry for **every** `blockColumns` column: a map that omits one is refused) names, for each block column, the report's own all-warehouses total header, which must appear **exactly once before the first block**. **Every source row is reconciled**: the total must equal the exact sum of that row's warehouse blocks (a negative block counts as negative), or the row is rejected as `WIDE_TOTAL_MISMATCH` with both figures; a blank or non-numeric total or block cell rejects it too. A missing, edited or misaligned warehouse cell therefore cannot pass.
  The Qoblex report has one known exception shape: a SKU at -5 in one warehouse and 0 in the total is a mismatch (and is also a negative balance).
- `uniqueBy` (required) **must be `sku`**: the key is the column mapped to the canonical SKU, and a map naming any other column is refused. The key is the SKU **after** the map's `valueMaps` and normalised like the loader's identifiers (compatibility-normalised, upper-cased, with spaces, control and zero-width characters removed), so two source spellings of one SKU are one key. It is **unique across the source rows**. A wide file is one row per key; a key (compared upper-case) on more than one row rejects **every** row that carries it as `DUPLICATE_SOURCE_ROW`, whatever their quantities or costs say, so warehouse quantities of two rows are never added together (one synthetic lot per SKU and warehouse). Blank keys are not a duplicate group. The rule holds **across files** too: when a dataset is read from several files, a key present in more than one of them refuses every source row carrying it in every file (the reason names the other file and line), before any lot is collapsed. As a second layer the loader refuses two rows of a wide report that state the same SKU and warehouse (`REPEATED_WIDE_STOCK_ROW`) whatever the reader decided; the multi-lot weighted average of long (non-wide) sources is unchanged. One SKU in several warehouse blocks of one row is the normal case, not a duplicate. Every offending source row gets exactly one disposition that names the other file and physical line, including rows already refused inside their own file (a repeat or a total mismatch). A row the map deliberately skips (`rowSelect.skip`) does not count as a key of the dataset. **A dataset is read either entirely in wide layout or entirely not**: a manifest that lists one dataset with a mix is a usage error (exit 2), decided from the column maps BEFORE any data file is read (so a missing file cannot turn it into exit 3), because rows of the same SKU and warehouse in two layouts could not be told apart.
- `warehouses` is a **closed** list from the label (trimmed) to the IMS warehouse code. Nothing is guessed, and the file is refused as a whole (exit 3, nothing written) when: a label appears twice; a label is not in `warehouses` (a new or renamed warehouse); a declared warehouse has no label (a block disappeared);
  a block lacks a `blockColumns` header or has it twice (an incomplete block); the label row and the header row differ in width; a per-row column lies inside a block; two labels map to the same code; or `expectedHeaders` differs.
- The records are numbered `L.0B`: source line L, warehouse block B (1-based, file order), so line 12 block 3 is `12.03`. `read` in the accounting counts these records (a 1,570-row, five-warehouse file is 7,850 records). A row refused before it is split (a ragged row, an unlisted row kind) is one record and keeps the plain line.
- A zero quantity is a record that says "zero on hand" (excluded as `ZERO_ON_HAND`), exactly as in a long file. The wide layout is only allowed for a dataset that has a `warehouseCode` column.

### Row kinds and grouped parents

`rowSelect` makes the value of one source column decide whether a row belongs to the dataset. It is a **closed list**: a row whose value is in `keep` is read, one in `skip` is left out and **counted** (the report's "Rows skipped by the map"), and any other value is
rejected as `UNLISTED_ROW_KIND`. That is how the Qoblex stock report's `Product Type` `Unknown` rows are refused rather than silently loaded or dropped.

`parentFrom` is for files where a header row is followed by its component rows (the Qoblex bundles file: a `Bundle` or `BillOfMaterial` row, then its `Part` rows). A row whose `column` value is in `parentValues` sets the current parent to its `skuColumn`; every row that is read gets the current parent in the canonical column
`into`. A row with no parent yet, or after an unreadable (ragged) row, is rejected as `ORPHAN_CHILD_ROW`, because a damaged row could have been the parent. The same file is read twice, by two map entries: the header rows as `products` (`keep` the parent kinds), the component rows as `recipe-lines` (`keep` `Part`).

### Derived columns and dates

`derived` fills a column from another canonical column of the same record through the derived column's own closed `valueMaps` (a value not in it rejects the row): Qoblex's open purchase order file has no currency, so the currency comes from the supplier and the exchange rate from the currency.
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
Only the outstanding quantity (shipped minus received) of an IN_TRANSIT or PARTIALLY_RECEIVED transfer is emitted, as an IN_TRANSIT transfer. The importer stamps the dispatch at import time, not at the source's dispatch date.

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

- **Products** come from the stock report: `Sku`, `Product`, `Product Type`, `Barcode`, `State`. `Product Type` is a closed list: `simple` is SIMPLE; `variable` is mapped to VARIANT; any other value (the real export has `Unknown`) is rejected for an owner decision.
  **The stock report lists variants only, with no parent product**, so a VARIANT row is rejected as `VARIANT_WITHOUT_PARENT` until the VARIABLE parent products are supplied (in practice from WooCommerce, which holds the parents; the parent SKU is not a column of any Qoblex export we have). The map is shipped honestly blocked, rather than
  loading variants as SIMPLE products and losing the parent link. To rehearse the rest of the load, a private copy of the map can read `variable` as SIMPLE; do not load that.
- **Bundles and manufactured products** come from the bundles file. `Line Type` is a closed list: `Bundle` is a KIT, `BillOfMaterial` is a BOM, `Part` is a component line whose `Bundled Quantity` is the component quantity. The header rows become products (second file, which supersedes the stock report's SIMPLE row for the same SKU); the `Part` rows become recipe lines
  under the header row above them. A product listed in more than one group (the real file does this) produces repeated or conflicting component lines, which are rejected (`DUPLICATE_RECIPE_LINE`) because the tool cannot know whether to add them. The bundles file's own stock columns are not read: opening stock comes only from the stock report.
- **Opening stock** is the stock report read in wide warehouse blocks. Qoblex cannot export per-lot costs, only a `Moving Average Cost` per product, so each SKU and warehouse becomes **one synthetic lot** at that cost (currency is the base currency, a constant in the map); nothing is collapsed because there is nothing to collapse, and the multi-lot weighted average used for other sources is unchanged.
  The cost is per product, not per warehouse, so a SKU held in two warehouses has the same cost in both. FIFO in IMS is date-based only. A positive quantity with a cost of **zero** is a `ZERO_COST_OPENING_STOCK` warning (loadable, but it would sell at zero cost of goods); a positive quantity with a **blank** cost is an ERROR (`MISSING_UNIT_COST`, the row is rejected and the run is blocked); a blank cost with zero stock is just zero on hand; a negative quantity is rejected; the all-warehouses totals group is never read.
  The five warehouse labels are mapped to the codes `MIL1`, `CAMBRIDGE`, `RESTOCK`, `QUARANTINE-CAMBRIDGE` and `RXT2`; these codes must exist in IMS (apply-time check `warehouse-exists`). **Owner decision:** the quarantine warehouse is imported as its own warehouse by default, so quarantined units are on hand but not mixed into a sellable warehouse; say so if it should not be loaded.
- **Transfers are not needed for Qoblex.** Qoblex has no in-transit status for transfers: a booked transfer is already at the destination and a draft transfer is still in the origin warehouse, so on-hand per warehouse is already the truth. The `transfers` dataset is simply not supplied (the report lists it under "Not supplied"), `inTransitConvention` is not set, and the in-transit section below does not apply to Qoblex.
- **Open purchase orders** come from the incoming-stock file, one row per line. `Status` is a closed list: `Approved` and `PartiallyReceived` are open (OPEN); any other status is rejected until the owner says whether it is open. Outstanding quantity is `Ordered Quantity` minus `Received Quantity`, so a fully received line is excluded. The destination warehouse is a constant (`MIL1`; the report's `Incoming Quantity` appears only for that warehouse in the sample); confirm it.
  The file has **no currency and no exchange rate**: the currency is derived from the supplier (`derived`, from the supplier's currency in the contact export) and the rate from the currency, both closed lists in the map. A supplier whose contact has no currency is rejected until the owner gives one; the rates in the shipped map are placeholders for the synthetic suppliers only. The `Discount (%)` column is not read (every value in the sample is 0): it shows under "Source columns not read", and a non-zero value would be lost, so check it.
  `Due On` (`Thu, Oct 8 2026`) becomes `expectedDelivery`. The `Incoming Quantity` per warehouse in the stock report and these lines describe the same open orders: their per-SKU totals should agree, and a PO line for a SKU the catalogue lacks is rejected (`SKU_NOT_IN_CATALOGUE`).
- **Suppliers** come from the contact export. **The export has no supplier/customer flag.** `Wholesale or Retail` is a closed list (`Wholesale` only): a `Retail` contact is rejected as `UNLISTED_ROW_KIND` for an owner decision. Every other contact is loaded as a supplier. Whether a contact is a supplier is read from its use: the suppliers named in the stock report's `Supplier` column and in the incoming-stock file's `Supplier` column should all be present (a purchase order line naming an absent supplier is rejected).
  Payment terms are a closed list (`NONE` and blank are no terms, `30 days net` is 30). The shipping address columns feed the supplier address; the billing columns are not read.

## Output files and load order

The numeric prefix is the load order: suppliers, products, opening stock, transfers, purchase orders. Each file has the importer's exact template header (below), CRLF line endings, no BOM. Load each file's dry-run preview first and the real import only when it is clean.

Idempotence of re-importing: suppliers and products update by name or SKU; transfers and purchase orders skip a key that exists; opening stock is **not repeatable**: once any movement exists for a SKU and warehouse the importer refuses it. A database restore point is the only rollback
for opening stock (see the first-load work items). This tool's own output is idempotent: the same input gives the same bytes.

### Output header: suppliers

Importer: `importSuppliersCsv` (app/actions/suppliers.ts). Template: `app/api/export/suppliers/route.ts`.

```text
supplierId,name,contactName,email,phone,currency,vatNumber,accountNumber,paymentTermsDays,addressLine1,addressLine2,city,county,postcode,country,notes
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
orderKey,supplierName,currency,fxRateToBase,destinationWarehouseCode,sku,qty,unitCostForeign,lineDiscountForeign,lineDiscountStr,taxRateName,taxRateValue,orderTaxRateName,orderTaxRateValue,pricesIncludeVat,supplierRef,expectedDelivery,orderDiscountForeign,notes
```

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
| po-supplier-exists | purchase-orders | Each supplier name exists in IMS (matched case-insensitively); the suppliers file creates them only when it is loaded first. |
| po-fx-rate | purchase-orders | For every non-base currency IMS holds a base-to-currency FX rate on or before the import date, and the supplied fxRateToBase is within 2% of it (createPurchaseOrder, PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE). The CSV dry-run does not run this. |
| po-tax-rate | purchase-orders | Each line's taxRateName (names are matched case-insensitively, trimmed) or, when only a taxRateValue is given, its value (matched within 0.00005) resolves to an active IMS purchase tax rate, and no rate IMS applies (named, or the supplier default) is above the manifest maxPurchaseTaxRate. A line never carries both: the tool cannot show a name and a value agree. |
| lookup-keys-unique-in-ims | all | In IMS no two suppliers (name), warehouses (code), products (SKU) or tax rates (name) collide under the importers' case-insensitive matching: they build a Map and the last duplicate wins silently. The tool performs the supplier and SKU parts only against an ims-suppliers / ims-skus list you supply; WITHOUT that list the collision check against IMS is NOT performed and the report says so. Warehouse codes and tax names are never checked by the tool. |
| po-reference-free | purchase-orders | No existing purchase order already has a prefixed orderKey as its reference (an existing one is skipped, not updated). |
| po-product-lifecycle | purchase-orders | Products that exist in IMS but not in the products file are ACTIVE or DRAFT (the file's own products are checked here). |
| transfer-reference-free | transfers | No existing transfer already has a prefixed transferKey as its reference. |
| transfer-source-stock | transfers | The opening-stock file for the source warehouse has been loaded first, nothing is reserved against it, and its cost layers cover the dispatched quantity. |
| barcode-free | products | No barcode in the products file is already used by a product that exists in IMS. |
| product-parent-exists | products | A VARIANT's parent is in an earlier or the same file (proved here) or already in IMS. |

The rules the tool does prove: required fields, quantity and cost signs and scales (every emitted number is checked against the scale of the column it is stored in: weight 4 dp, dimensions 2 dp, prices 4 dp, quantities 4 or 6 dp, costs 6 dp, exchange rate 8 dp, tax rate 4 dp as a fraction, and rejected rather than rounded), date shapes, the lifecycle of products in the catalogue file (a purchase order line needs ACTIVE or DRAFT, a transfer anything but ARCHIVED; `active` FALSE means EOL), order-group consistency and the value ranges of every column written.

## Known gaps

- WooCommerce, Mintsoft and Xero have no file maps: they are read through the connectors in separate steps (see the scope above).
- The Qoblex stock report has no parent products for its variants (see "Qoblex native exports"); the VARIABLE parents have to come from another source before variants can load.
- Supplier product costs (`SupplierProduct`): there is no CSV importer, so nothing is produced. They are a backfill and may follow go-live.
- Customers: no source is defined for them in this work; they are not read.
- Warehouse codes, tax rate names and supplier names for suppliers that already exist in IMS cannot be checked without the database; the importers' own dry-run preview does that.
- The org base currency is asserted by the manifest, not read from IMS.
- Units: `stockUnit` is passed through (normalise its spelling with `valueMaps`). **Quantities are taken to be in stock units**; the tool does no purchase-unit to stock-unit conversion, and `PurchaseOrderLine.qty` is defined as stock units.
- Currency: codes are upper-cased and must be 3 letters; the rate is whatever the source gives, read as foreign units per one base unit (confirm the direction from the sample: the importer divides by it). Converting a lot cost by division rounds at 80 significant digits, far below the 6 dp the average is rounded to. Whether a rate is the right one for the cost date is not checked.
- A PO's original reference is kept (prefixed) as the new order's reference, but reconciliation R8 still proves outstanding quantity, not PO identity.
