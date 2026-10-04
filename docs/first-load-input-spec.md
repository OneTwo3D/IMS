# First-load input spec and preparation tool

This is the technical reference for `scripts/first-load-prepare.ts` (`npm run first-load:prepare`), the file-in, file-out step that turns the
incumbent systems' exports into files the **existing** CSV importers can load, and says in a report what it did to every row.

It is pure: **no database, no network**. It reads the files named in a run manifest and writes into an output directory. It never loads anything
anywhere; uploading the files through the importers (dry-run preview first) is a separate, deliberate step.

Scope of this tool and what is still open:

- Built: the canonical input datasets, the validators and transforms, the report, and the CLI.
- **Not built here:** the apply runner that drives the importers (a later work package), and the **real column maps** for Qoblex, Mintsoft and WooCommerce.
  Those wait for the owner's 50-row sample exports. The maps shipped under `tests/first-load/fixtures/maps/` use **invented headers** and are only
  there to prove the mechanism. Do not copy a header from them into a real map.
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
- `inTransitConvention` is required when a `transfers` dataset is supplied (see "In-transit stock").
- `purchaseOrderKeyPrefix` and `transferKeyPrefix` are required when the matching dataset is supplied. They are prefixed to every order or transfer key so a loaded
  reference cannot collide with a reference IMS generates later.
- One file per dataset. Concatenate multi-part exports first. An input with `columnMap` is a native export read through that map; an input without it must already
  be a canonical file (below).

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
| `category` | no | Category name (at most 100 characters). |
| `description` | no | Passed through as given (trimmed). |
| `barcode` | no | Text; leading zeros are kept. A barcode shared by two products rejects both. |
| `mpn` | no | Passed through as given (trimmed). |
| `countryOfOrigin` | no | Passed through; the importer normalises it and only warns on an unrecognised value. |
| `weight` | no | Plain decimal. |
| `widthCm` | no | Plain decimal. |
| `heightCm` | no | Plain decimal. |
| `depthCm` | no | Plain decimal. |
| `salesPriceBase` | no | Plain decimal, base currency. |
| `salePriceBase` | no | Plain decimal, base currency. |
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
| `fxRateToBase` | no | Required when `currency` is not the base currency; blank or 1 for the base currency. |
| `receivedDate` | no | Informational. |
| `lotRef` | no | Lot reference. The same reference twice for one SKU and warehouse is a duplicated row and is refused. |

### Dataset: suppliers

Becomes the suppliers import file. `prepaid` and the accounting contact id are not importer columns and are never set: set `prepaid` by hand, only for
genuine deposit suppliers, and let IMS resolve the contact id.

| Column | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Matched case-insensitively. Two rows that differ only in case are one supplier: identical data loads once, differing data rejects both. |
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
| `supplierName` | yes | Must be in the suppliers dataset when that is supplied. |
| `status` | no | OPEN (default if blank), CLOSED or CANCELLED. Anything not OPEN is excluded. |
| `currency` | yes | 3-letter code. |
| `fxRateToBase` | no | Required when `currency` is not the base currency. |
| `destinationWarehouseCode` | no | Passed through as given (trimmed). |
| `sku` | yes | Passed through as given (trimmed). |
| `qtyOrdered` | yes | At most 4 decimal places. |
| `qtyReceived` | yes | At most 4 decimal places. |
| `unitCostForeign` | yes | At most 6 decimal places and 9 integer digits. |
| `taxRateName` | no | Passed through as given (trimmed). |
| `taxRateValue` | no | Passed through as given (trimmed). |
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

### Dataset: ims-skus

SKUs that already exist in the target IMS (from `/api/export/products`). The fourth side of the coverage check. Omit it for an empty database.

| Column | Required | Meaning |
| --- | --- | --- |
| `sku` | yes | Passed through as given (trimmed). |
| `type` | no | Needed when a lot, transfer or recipe refers to a product that exists only in IMS. |

## Column maps

A column map is JSON, one file per **source**, with one entry per dataset that source feeds. Qoblex feeds products, recipe-lines, stock-lots, suppliers,
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

It fails closed, and each of these is an error that stops the run (exit 3) rather than something guessed:

- a mapped header that is not in the file, or appears twice (the message lists the headers the file does have, and names a case-different look-alike as a hint it did **not** use);
- two canonical columns mapped to one source header, a column both mapped and given a constant, an unknown canonical column name, an unknown key anywhere;
- a required canonical column that is neither mapped nor a constant;
- a `decimalSeparator` other than `.`: decimal commas are rejected, never converted;
- a map entry for a dataset that source cannot feed.

A source value that is not in a column's `valueMaps` rejects **that row** with its line number; it is not passed through. A source column that no canonical
column reads is listed in the report under "Source columns not read", so a forgotten column is visible.

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
- **Duplicates.** Exact duplicates collapse to one and the extra is excluded. Conflicting duplicates reject **every** member, so the answer never depends on row order.
- **Decimals.** Quantities and costs use exact decimal arithmetic, never floating point. A decimal comma, a thousands separator, an exponent, a sign prefix, more decimal places than the target column holds, or more than
  15 significant digits for a cost (the importers read costs as doubles) is rejected.
- **Recipes.** Every component and parent must be a loaded product. The recipe graph must be acyclic: the check is `detectBomItemCycleInEdges`, the function the importer's component pass uses, applied repeatedly until every
  cyclic parent is found. A KIT or BOM with no loadable line, or recipe lines not supplied at all, blocks the run. Products are ordered variants after parents and recipes after their components, so a chunk never needs a later chunk.
- **Opening stock.** Lots are collapsed to one weighted-average `unitCostBase` per SKU and warehouse: the lot total (quantity times cost, exact) divided by the quantity, rounded **once** to 6 decimal places, half up. The report shows the lot total, the collapsed total
  and the rounding residual per group and in total. A non-base currency lot needs `fxRateToBase`. The converted base-currency cost of a lot, the collapsed quantity, and the opening quantity after any in-transit addition are each checked against the target columns (8 integer digits for quantity, 9 for cost); a group that does not fit is rejected, never emitted.
- **Types that hold no stock.** KIT, VARIABLE and NON_INVENTORY stock rows with quantity 0 are excluded and reported. A POSITIVE quantity on such a product is an **error** that blocks the run, because those units would be absent from every import file. The products themselves are still loaded.
- **Zero versus missing.** A SKU whose stock rows all say zero is **zero on hand** (excluded: no opening layer is created). A stock-bearing SKU (SIMPLE, VARIANT, BOM) with no stock row at all is **missing from the extract**, listed
  separately. If the 3PL stock dataset is supplied and the missing SKU holds stock there, that is an error; if it is not supplied the answer is reported as unknown.
- **Open purchase orders.** Outstanding quantity per line is ordered minus received, never negative. Fully received lines, closed orders and over-received lines are excluded; an over-received line is also a warning. Lines of one order must agree on
  supplier, currency, rate, warehouse, VAT flag, reference, date, notes and tax rate or the whole order is rejected (the importer refuses such an order). Lines of an order are never split across files. When a suppliers dataset is supplied, every supplier a line names must be in it (a line naming a supplier that is only in IMS is rejected); to reference suppliers that already exist in IMS, leave the suppliers dataset out and the names are passed through unchecked (with a warning).
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

## Known gaps

- Supplier product costs (`SupplierProduct`): there is no CSV importer, so nothing is produced. They are a backfill and may follow go-live.
- Customers: no source is defined for them in this work; they are not read.
- Warehouse codes, tax rate names and supplier names for suppliers that already exist in IMS cannot be checked without the database; the importers' own dry-run preview does that.
- The org base currency is asserted by the manifest, not read from IMS.
- Units: `stockUnit` is passed through (normalise its spelling with `valueMaps`). **Quantities are taken to be in stock units**; the tool does no purchase-unit to stock-unit conversion, and `PurchaseOrderLine.qty` is defined as stock units.
- Currency: codes are upper-cased and must be 3 letters; the rate is whatever the source gives. Whether a rate is the right one for the cost date is not checked.
- A PO's original reference is kept (prefixed) as the new order's reference, but reconciliation R8 still proves outstanding quantity, not PO identity.
