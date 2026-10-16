# First-load apply runner: the core

The first-load tool (`npm run first-load:prepare`, see [first-load-input-spec.md](first-load-input-spec.md)) turns the owner's exports into importer files and proves what it can without a database. The **apply runner** loads those files into an empty installation through the application's own importers. This page documents the part of the runner that exists today: **the core**, which reads and verifies a prepared run from bytes, works out which rows still have to be loaded, and drives the steps (plan, apply, resume) through ports.

**What is not built yet:** the database side (reading the target, the importer calls with the system-actor capability, the run table, the single-runner lock, the restore point), the post-run verification and census, the command-line shell with its rehearsal mode, and the go/no-go check. Nothing in the core opens a database connection, a socket or a child process; it reads files and writes only its evidence files. Mintsoft, Xero and WooCommerce are never touched.

The code is in `lib/first-load/apply/`: `constants.ts` (every constant and operator sentence), `manifest.ts` (the operator's manifest), `prepared.ts` (load and verify), `keys.ts` (natural keys and fingerprints), `residual.ts` (what is still to load), `orchestrate.ts` (plan, apply, resume), `report.ts` and `io.ts`.

## What a load is

A load is identified by its **digest**: the SHA-256 of the canonical apply manifest (without locations), the prepared report's SHA-256, every output file's SHA-256 and, when variant parents are used, the verified snapshot's hashes. Change any byte of any of them and the digest changes. A resume is accepted only for the same digest.

## Steps

The runner applies these steps, in this order only. The apply manifest lists the steps it wants and may not reorder them.

| Step | Importer file | Needs in the same run |
| --- | --- | --- |
| suppliers | suppliers | none |
| products | products | none |
| opening-stock | opening-stock | products |
| purchase-orders | purchase-orders | suppliers, products |

Transfers are refused: the prepared run may not contain a transfers file. Open purchase orders are normally loaded later, from a fresh export; the runner supports the step so it can be rehearsed, but a first-load manifest leaves it out.

## The apply manifest

A JSON file. Unknown keys are refused, nothing is defaulted, and an input nothing would use is refused (an assertion the runner would ignore is an assertion nobody checked).

| Key | Meaning |
| --- | --- |
| formatVersion | Must be 1. |
| runId | A label of 1 to 64 letters, digits, dots, dashes and underscores. |
| preparedDir | The directory `first-load:prepare` wrote. A location: not part of the digest. |
| baseCurrency | Must be GBP, the only base currency the first load supports. |
| steps | The steps to run, in load order. |
| expectWarehouses | For every warehouse the selected steps use: `{type, availableForSale, syncToStore}`. Required when opening-stock or purchase-orders is a step; the declared codes must equal the codes the files use. |
| acceptZeroCost | The `SKU@WAREHOUSE` pairs whose zero cost the operator accepts. It must EQUAL the set of zero-cost opening-stock rows in the file. |
| fxRates | Purchase orders only: currency to rate, as strings. Each must equal the order's rate in the file, and each must be used. |
| forbidSkus | SKUs that must appear in no prepared file (owner rulings that exclude a product). |
| restorePointDir | An absolute directory for the restore point. A location: not part of the digest. |
| wooSnapshot | Required when the prepared run used WooCommerce variant parents, refused otherwise: the paths of the snapshot, its provenance and `variant-parents.csv`, the store origin it must come from, and the per-status counts read off the shop's admin. The bundle is re-verified with the same function `first-load:prepare` uses, and the CSV must be the file the prepared run recorded reading. |

## What a prepared run must satisfy

Before anything is planned, the loader checks, from bytes, and reports every problem at once (exit USAGE):

- the prepared report is `first-load-prepare`, verdict PASS, with no self-check failure, no ERROR finding, balanced accounting and the manifest's base currency;
- the directory holds exactly the files the report names (plus the report): a stray file is refused, a missing one is refused;
- each file has the SHA-256, size and row count the report records, is valid UTF-8 without a byte-order mark, carries the importer's template header, has the chunk numbering `NN-target-00k-of-00n.csv`, stays within 9,999 rows and 9,999,999 bytes, and has no row the importers' parser would silently skip;
- keys are unique inside each step, also under upper-casing, and no id column is set (an id would make an importer match by id);
- every VARIANT's parent is a VARIABLE product in the same files, every recipe component is a product in the same files (a missing component would be counted created by the importer and load no recipe), no recipe cycles, stock only on SIMPLE, VARIANT or BOM products, purchase-order suppliers and products exist in the files;
- the opening-stock quantity and value equal the totals in the prepared report, exactly;
- the operator's assertions (zero-cost pairs, warehouses, FX rates, forbidden SKUs, the Woo snapshot) are backed by the files or refused.

## The residual

For each step, on the first run and on every resume, the runner reads the database and puts every prepared unit (a supplier, a product with its recipe, an opening-stock pair, a whole purchase order) in exactly one state:

- **absent**: it is loaded;
- **present-matching**: same key and same fingerprint (and the same recipe): skipped, not re-sent;
- **present-conflicting**: the run stops and nothing more is written.

The rows sent to the importer are the file of absent units only, in the original order. Correctness never depends on the run record: a crash between two row transactions leaves a database the next run reads correctly. The accounting is computed from the database, never from the importers' own counters (a product the importer counted as created whose recipe is missing is **failed**); the counters are kept as a cross-check finding.

### Conflict codes

| Code | Meaning |
| --- | --- |
| FIELDS_DIFFER | The key exists in the database with different field values than the file. |
| RECIPE_DIFFERS | The product exists and matches, but its recipe (components) is missing or different. |
| CASE_COLLISION | A different key exists that is equal under the importers' case-insensitive matching. |
| FOREIGN_HISTORY | Opening stock: the product and warehouse already have stock, a cost layer or a movement that is not this run's opening layer. |
| FOREIGN_ROW | The database holds a row of this step that this run did not emit. |
| DUPLICATE_IN_DATABASE | The database holds the key more than once, so no single row can be compared. |

## Plan, apply, resume

- **Plan** reads the database and the prepared run and writes nothing: no importer call, no run record. It lists, per step, how many units would be loaded and skipped, the residual files' hashes and every conflict. A conflict makes the plan refuse.
- **Apply** needs a rehearsal record for the same digest, with verdict OK, finished within 24 hours (and not in the future), against a target with the same system id; otherwise it refuses before reading the database. It then creates the run record (compare-and-swap on a version, so a second runner is refused rather than overwriting it) and runs each step under the step lock: the rails are re-checked, the database is read again, the residual is computed from that read, the rails are re-checked just before the first write, the importer is called with each residual file, and the database is read once more to account for every unit. A failed or conflicting step stops the run.
- **Resume** continues the same digest from a run record that is RUNNING, STEP_FAILED or VERIFY_FAILED. A different digest, a finished run, or no record is refused. An existing record without `--resume` is refused.

An unreadable database is never treated as an empty one: the read fails closed (refusal before the first write, or STEP_FAILED during the run).

## Exit codes

<!-- The table below is exactly APPLY_EXIT_CODE_TABLE in lib/first-load/apply/constants.ts; tests/first-load/apply-docs.test.ts fails when they differ. -->

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | The rehearsal or apply finished and every verification passed. |
| 1 | VERIFY_FAILED | Applied, but the post-run verification found a difference. The report names it. Rows ARE written; the restore procedure is printed. |
| 2 | USAGE | Bad arguments, an apply manifest that cannot be used, or a prepared run that cannot be used (a digest, SHA-256, header, limit, key or cross-file check failed, an input is unbound or unverified, or a transfers file is present). This command wrote nothing. |
| 3 | PRECONDITION_REFUSED | A rail or an apply-time check refused before the first write (including: no matching rehearsal, a run that already exists, or another runner holding the run). This command wrote nothing; an earlier run of the same load may have. |
| 4 | STEP_FAILED | A step failed after writes began. The database is partially loaded and the run is resumable with --resume (same digest) or restorable from the recorded restore point. Rows ARE written. |
| 5 | CONFLICT | The database holds a key with different data than the file (or a row nobody in this run created). Nothing further was written; rows from earlier steps ARE written. |
| 6 | INTERNAL | A self-check failed (the row accounting did not reconcile, or a report write failed). This is a defect in the runner. The database state is NOT assumed to be unchanged. |
| 7 | REHEARSAL_TEARDOWN_INCOMPLETE | Rehearsal only: the throwaway database could not be removed completely. The real target was not written. |

Only USAGE and PRECONDITION_REFUSED say that nothing was written, because no write happens before the precondition phase ends and a test proves it. Every other non-zero exit says that rows may be written and prints the restore procedure. The runner never restores by itself and never deletes rows.

## Operator texts

These sentences are printed by the runner and in the report. They are exactly the constants in `lib/first-load/apply/constants.ts`.

### Operator text: nothing-written

```text
This command wrote nothing to the database.
```

### Operator text: rows-written

```text
Rows may already be written to the database by this run.
```

### Operator text: restore-procedure

```text
To undo this run, stop the application, restore the recorded restore point (a PostgreSQL custom-format dump) into an empty database, run the migrations and start again. The runner never restores by itself, and it never deletes rows.
```

### Operator text: transfers-refusal

```text
the prepared run contains a transfers file; the runner cannot load transfers (they are Server Actions with their own permission checks and stock-sync effects). Remove the transfers from the run or load them by hand.
```

## Coverage of the apply-time checks

Every id of `APPLY_TIME_CHECKS` (see [first-load-input-spec.md](first-load-input-spec.md)) has exactly one row. `file-side` is proved from the files by the core; `partial` has a file part proved by the core and a part that needs IMS, which is the database slice's; `database` is the database slice's alone; `not-applicable` means the runner refuses the whole area.

| Id | Status | What the core does |
| --- | --- | --- |
| warehouse-exists | partial | The warehouse codes the files use must equal the codes declared in the apply manifest (expectWarehouses). That each exists in IMS with that profile is read from the database. |
| base-currency | partial | The apply manifest, the prepared report and the supported base currency (GBP) must agree. The organisation row is read from the database. |
| opening-stock-empty | partial | Stock history on a product and warehouse that is not this run's opening layer is a conflict (FOREIGN_HISTORY) and stops the run. Reading that history is the database slice's. |
| po-supplier-exists | partial | Every purchase-order supplier must be a supplier of the suppliers file, which the same run loads first. |
| po-fx-rate | partial | Every non-base order's fxRateToBase must equal the rate the apply manifest states for the currency, and every stated rate must be used. That IMS holds a rate within 2% is read from the database. |
| po-tax-rate | database | Needs the IMS tax rates. |
| lookup-keys-unique-in-ims | partial | Inside the files, no two suppliers, products, stock pairs or orders may differ only in letter case. A look-alike already in the database is a conflict (CASE_COLLISION). |
| po-reference-free | partial | An order whose reference already exists with the same content is skipped as existing; with different content it is a conflict. Reading the references is the database slice's. |
| po-product-lifecycle | database | Needs the lifecycle of products that are only in IMS. |
| transfer-reference-free | not-applicable | The runner refuses a prepared run that contains transfers. |
| transfer-source-stock | not-applicable | The runner refuses a prepared run that contains transfers. |
| barcode-free | database | Needs the barcodes already in IMS. |
| product-parent-exists | file-side | Every VARIANT's parent must be a VARIABLE product of the same products files (the first load is into an empty database), and a parent from WooCommerce must come from a verified snapshot. |

## Rails the database slice adds

The core takes these through ports and does not implement them: target identity, empty database, base-currency lock, outbound-write hold, connector and cron state, warehouse existence and profile, tax rates, FX rows, the restore point, the single-runner lock and the post-run verification and census. Each is re-checked inside the step lock; the core calls `recheckRails` at the start of every step and again just before its first write, and a rail that no longer holds ends the step as STEP_FAILED, resumable.

## Not proven here

The fingerprints are string comparisons of a normal form (numbers without trailing zeros, booleans lower-case, currencies upper-case). The database slice must build the same normal form from database rows; until it does, "present-matching" has only been exercised against an in-memory database that uses the same functions.
