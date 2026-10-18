# First-load apply runner: the core

The first-load tool (`npm run first-load:prepare`, see [first-load-input-spec.md](first-load-input-spec.md)) turns the owner's exports into importer files and proves what it can without a database. The **apply runner** loads those files into an empty installation through the application's own importers. This page documents the part of the runner that exists today: **the core**, which reads and verifies a prepared run from bytes, works out which rows still have to be loaded, and drives the steps (plan, apply, resume) through ports.

> **PRECONDITION: THE APPLICATION IS STOPPED.** The first load must run against a database that **no other writer is connected to**. The runner's step lock excludes only other first-load runners; an ordinary request, worker or cron job could create or change a row between the runner's read and the importer's write, and the importer would overwrite it from the file while the read-back reported it as created.
>
> **Operator checklist, before `--apply` (and before every `--resume`):**
> 1. Stop the application (web, workers, queue consumers) for the target database.
> 2. Disable every cron job and scheduled task that connects to it (the sync sweeps, the backup job, report jobs).
> 3. Close every interactive session (psql, a database GUI, an admin shell) on it.
> 4. Recommended, and the only thing that actually prevents a late writer: during the load, block the application's database role from connecting (disable its login, or revoke its connect right on this database) and re-enable it afterwards. The runner's checks below detect a session that connects; this step stops one from connecting at all.
> 5. Start the runner with `PGAPPNAME=ims-first-load-apply` in its environment (so its sessions are recognisable to you in `pg_stat_activity`), over a TCP connection from a Linux host. The runner's role must be a superuser or a member of `pg_read_all_stats`, or it cannot see other sessions and refuses.
>
> The runner **proves that no other client session is connected now** (before anything is written, at the start of each step, just before its first write, and before EVERY bounded importer call of at most 500 rows). A session that connects between two calls is detected at the next call only, so the most it can overlap is one bounded call; it cannot prove that none will connect later. See "The quiesce rail" and the not-proven list.

**What exists today:** the **core**, which reads and verifies a prepared run from bytes, works out which rows still have to be loaded, and drives the steps (plan, apply, resume) through ports; and the **database side** (`lib/first-load/apply/db/`), the real implementations of those ports: reading the target, calling the application's own importers as a system actor, the durable run record, the per-step lock and the database rails. The core opens no database connection, socket or child process; the database side opens only the connections to the target it is pointed at (`DATABASE_URL`) and never touches the network. Mintsoft, Xero and WooCommerce are never touched.

**What is not built yet:** the restore point, the rails that read the outbound-write hold, the connectors and the crons, the post-run verification and census, the command-line shell with its rehearsal mode (which is what picks the target and confirms its name and system id), and the go/no-go check.

The code is in `lib/first-load/apply/`: `constants.ts` (every constant and operator sentence), `manifest.ts` (the operator's manifest), `prepared.ts` (load and verify), `keys.ts` (natural keys and fingerprints), `normal-form.ts` (what "the same value" means, in one place), `residual.ts` (what is still to load), `import-calls.ts` (how a file is cut into importer calls), `orchestrate.ts` (plan, apply, resume), `report.ts` and `io.ts`; and in `lib/first-load/apply/db/`: `observe.ts`, `execute.ts`, `journal.ts`, `lock.ts`, `rails.ts` and `ports.ts`.

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

The rows sent to the importer are the file of absent units only, in the original order. Correctness never depends on the run record: a crash between two row transactions leaves a database the next run reads correctly. The accounting is computed from the database, never from the importers' own counters (a product the importer counted as created whose recipe is missing is **failed**); the counters are kept as a cross-check finding. The importers' own error text (and any exception message) is **never stored or rendered**, because it can carry file values or exception text: the report keeps a bounded code (`ALREADY_EXISTS`, `NOT_FOUND`, `INVALID`, `EXCEPTION`, `OTHER`), a row number when the message names one, and the step. The rehearsal ceiling is fixed at 24 hours in the core; a caller cannot widen it, and an unusable limit or clock is a refusal. A purchase order whose lines span more than one prepared file is refused (the importer would create it from the first file and skip the rest).

### What is compared

Every column of every importer template is accounted for in one table (`FINGERPRINT_SPECS` in `keys.ts`): the key, a fingerprinted column, compared separately (the recipe), or **not persisted** with the reason (an id column that must be blank; descriptive or derived export columns the opening-stock importer does not read). A test checks the table against the template headers and against the columns each importer's source reads, and that a difference in each fingerprinted column (including every purchase-order header and line column: tax, VAT mode, discounts, supplier reference, expected delivery, notes) is a conflict.

### Problem text

A refusal (a problem string) names the step, the chunk and the line, or a column name, a count, or a closed reason. It never carries a cell value: problems reach logs, and a cell can hold anything. A test fills the fixtures with a sentinel and asserts it appears in no problem string. (The unit keys that the report rows carry are a separate, declared exception: see "What a report contains".)

## What a report contains

The apply report (JSON and Markdown) is a **private operator artefact**: write it to a directory only the operator can read (the files are created 0600) and do not paste it into tickets or chat. It contains identifiers and counts, and nothing else from the prepared files:

- the run id, the load digest, the prepared run's file names and SHA-256 hashes, counts, and the exit name with its operator sentence;
- per step: counts, the residual files' names, row counts and hashes, and one row per unit with exactly these fields: `key` (the unit key: a supplier name in lower case, a product SKU, an `SKU|WAREHOUSE` pair or a purchase-order reference), `outcome` (a closed word) and `reason` (a closed word or null);
- per conflict: `key`, `code` (a closed word) and `detail` (a fixed sentence);
- per importer message: a bounded `code` and a row number. The importer's own text is **never** stored or rendered, because it can carry file values or exception text;
- the problems of the run (the problem text rules above) and the verification items the verification slice supplies.

The unit key is a catalogue identifier the operator needs in order to act on a failure, so it is in the report. **No other cell of a prepared file is, no exception message is, and no credential is.** The keys are catalogue data, not secrets, but a supplier name or a reference can still be commercially sensitive: keep the report directory private.

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
- **Resume** continues the same digest from a run record that is RUNNING, STEP_FAILED or VERIFY_FAILED. A run record that is **APPLIED** is resumable for **verification only**: no step is run and no importer is called; with a verification port the verdict is recorded (VERIFIED or VERIFY_FAILED), and without one nothing is written and the result is APPLIED_UNVERIFIED again. A different digest, a VERIFIED run, or no record is refused. An existing record without `--resume` is refused.

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
| 8 | APPLIED_UNVERIFIED | Every step loaded and the row accounting reconciles, but NO post-run verification was run (this runner has no verification port yet). This is NOT a success: do not treat it as OK. Rows ARE written. A later --resume of the same load runs the verification when it exists. |

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

Every id of `APPLY_TIME_CHECKS` (see [first-load-input-spec.md](first-load-input-spec.md)) has exactly one row. `file-side` is proved from the files by the core; `partial` has a file part proved by the core and a part that needs IMS, which the database side proves; `database` is the database side's alone; `not-applicable` means the runner refuses the whole area.

| Id | Status | What the core does | What the database side does |
| --- | --- | --- | --- |
| warehouse-exists | partial | The warehouse codes the files use must equal the codes declared in the apply manifest (expectWarehouses). That each exists in IMS with that profile is read from the database. | Rail warehouses: each declared warehouse exists, is active, is unique under upper-casing and has exactly the declared type, availableForSale and syncToStore. Checked before the run, at the start of every step and before its first write. |
| base-currency | partial | The apply manifest, the prepared report and the supported base currency (GBP) must agree. The organisation row is read from the database. | Rail base currency: the organisation's base currency (GBP when there is no row, as the importers read it) equals the manifest's. |
| opening-stock-empty | partial | Stock history on a product and warehouse that is not this run's opening layer is a conflict (FOREIGN_HISTORY) and stops the run. Reading that history is the database slice's. | observe reads every stock level, cost layer and movement per product and warehouse. A pair that is not exactly one opening layer, its one opening movement and a matching stock level is FOREIGN_HISTORY. |
| po-supplier-exists | partial | Every purchase-order supplier must be a supplier of the suppliers file, which the same run loads first. | Nothing more is needed: the supplier is loaded by the same run, and an order whose stored supplier differs from the file is FIELDS_DIFFER. |
| po-fx-rate | partial | Every non-base order's fxRateToBase must equal the rate the apply manifest states for the currency, and every stated rate must be used. That IMS holds a rate within 2% is read from the database. | Rail FX rates: each stated rate has a stored base-to-currency rate on or before today and is within the importer's 2% tolerance of it. The runner never writes a rate. |
| po-tax-rate | database | Needs the IMS tax rates. | Rail tax rates: every line tax resolves to an active purchase rate (by name, trimmed and case-insensitive, else by value within 0.00005), and every order-level tax name exists with exactly that spelling, because createPurchaseOrder looks it up case-exactly. |
| lookup-keys-unique-in-ims | partial | Inside the files, no two suppliers, products, stock pairs or orders may differ only in letter case. A look-alike already in the database is a conflict (CASE_COLLISION). | observe keys every row by the importer's own key and its upper-case form. A different key with the same upper-case form is CASE_COLLISION, and a repeated key is DUPLICATE_IN_DATABASE. |
| po-reference-free | partial | An order whose reference already exists with the same content is skipped as existing; with different content it is a conflict. Reading the references is the database slice's. | observe reads every order by reference. The same reference with the same content is skipped, and with different content (including any status other than DRAFT) is FIELDS_DIFFER. |
| po-product-lifecycle | database | Needs the lifecycle of products that are only in IMS. | Covered by construction: the runner loads into an empty database, the products an order uses are the files' own, and a product nobody in this run emitted is FOREIGN_ROW. The importer itself refuses a product that is not active or draft, and the order then shows as not loaded. |
| transfer-reference-free | not-applicable | The runner refuses a prepared run that contains transfers. | Not applicable. |
| transfer-source-stock | not-applicable | The runner refuses a prepared run that contains transfers. | Not applicable. |
| barcode-free | database | Needs the barcodes already in IMS. | The empty-target rail refuses a database that already holds products, and a product nobody in this run emitted is FOREIGN_ROW. The importer also refuses a barcode already in use. |
| product-parent-exists | file-side | Every VARIANT's parent must be a VARIABLE product of the same products files (the first load is into an empty database), and a parent from WooCommerce must come from a verified snapshot. | The stored parent SKU of a variant is part of the product fingerprint. |

## The database side

`createDbPorts(prepared, { operator })` returns the ports the core is handed. The target is whatever `DATABASE_URL` names, because that is where the importers write; the command-line shell (not built yet) is what picks and confirms it, and refuses anything but an empty or rehearsal database. These ports add the data-level refusal: a first run needs an empty target (below).

### Observe

`observe(step)` reads what the database holds and reduces each row to the core's key and fingerprint strings. A database row is turned back into **the cells the importer would have read to write it** and run through the same functions as the file's cells (`normal-form.ts`), so no formatting rule lives in the reader. The rules, all in `normal-form.ts`:

- a blank cell takes the importer's default (stock unit `pcs`, oversell allowed, lifecycle ACTIVE, base currency, product type SIMPLE, a purchase order's rate 1);
- numbers are plain decimals without trailing zeros; booleans are the importers' own reading (1, true, yes, y);
- a country is the ISO code the importer resolves (an origin it cannot resolve stays as written, so the stored row, which has none, is reported as different); a category is its normalised path; a supplier's preferred supplier is compared by lower-cased name;
- the product's legacy `active` flag is derived from the lifecycle on the file side, and read as stored on the database side, so a stored row whose two disagree is reported;
- a percentage tax value (20) and a fraction (0.2) are the same value, and a delivery date without a time is midnight UTC;
- **a purchase order line carries the amount entered after its discount**, because the stored unit cost is the net of VAT and discount and cannot be turned back into the entered cost exactly. The amount is `quantity x unit cost - discount` to 4 decimal places on the file side, and the stored line total (plus the stored tax when prices include VAT) on the database side. A line names its tax by name, by value or not at all, and when it states both the token carries the stated value, so the database side shows the stored rate's value and a rate of another value (now, or changed later) is a difference. Every other place where the importer resolves a name or derives a value was checked for the same pattern: a stated order currency and FX rate are stored as stated and compared as stated, and the supplier, warehouse, category and country cells are single-valued, so there is no second value to disagree with. A line that names nothing gets the order's named tax (or none, when the order names none), and an order whose file currency is blank takes the supplier's: the database side shows these as blank ONLY when the stored value really is that default, so a changed value still differs.

What each step reads:

| Step | Key | Notes |
| --- | --- | --- |
| suppliers | lower-cased, trimmed name | |
| products | exact SKU | The recipe is the component list. For a BOM it is also the manufacturing BOM: a BOM is matching only when both representations say the same thing, so a recipe that exists in one only is RECIPE_DIFFERS. |
| opening-stock | UPPER SKU and UPPER warehouse code | A pair is clean only when it holds exactly one opening layer, its one opening movement, and a stock level equal to the layer with nothing reserved. Anything else on a pair (another layer, another movement, a different quantity, a reservation) is FOREIGN_HISTORY. A stock level row of zero with nothing else is not history. |
| purchase-orders | reference | Status is part of the fingerprint: an order that is not DRAFT is different. |

A read that fails is an `ObservationError` with a fixed sentence (the driver's text can carry a connection string or a value and is dropped). It is never an empty observation. The unreadable cases are tested by making a table unreadable and by making the run record unreadable.

### Execute

`execute` calls the application's own importers (`importSuppliersCsv`, `importProductsCsv`, `importOpeningStockCsv`, `importPurchaseOrdersCsv`) with the system-import context (see `system-import-capability.ts`): no session check, no `revalidatePath`, no queued WooCommerce push or stock sync, and the activity-log row names the actor (kind `system`, the run id, the operator label). An importer must answer with the system outcome; an answer without it (the web path) is refused, and so is a preview. An importer that refuses the file itself (an error and no outcome) is recorded as an error to account for.

Calls are cut by `planImportCalls`: independent rows (suppliers, opening stock) in calls of at most 500 rows; a purchase order is never split (calls are cut between orders); a products file is one call, because a variant needs its parent and a recipe needs its components in the same call. The row numbers in an importer's messages are mapped to the residual file's rows through the call's own row list (a purchase order's lines are grouped into a call, in another order than the file, so a shift would be wrong). The accounting is still from the database, not from the importers' counters.

### The run record

`first_load_apply_runs` has **one row per database**: a unique `singleton` column makes a second row impossible, so a second load into the same database loses the insert. The record moves by compare-and-swap: `save(record, n)` is one `UPDATE ... WHERE version = n AND manifest_digest = ... AND run_id = ...` and the affected-row count is the answer, so two runners that read the same version cannot both advance it (the loser gets `StaleJournalError`). A save must advance the version by exactly one. A status or step the table does not know is refused by a CHECK constraint, and a record this runner cannot read is an unreadable state (`ObservationError`), never an absent one. It is audit and identity only: correctness never depends on it.

### Column audit: every column the importers write or default

For each table the runner writes, every column is either **fingerprinted** (F, compared with the file), **validated** (V, checked against the importer's own arithmetic or its fixed default), or **deliberately unread** (U, with the reason).

| Table | Columns |
| --- | --- |
| suppliers | F: name, contact, email, phone, currency, VAT number, account number, payment terms, address, country, notes. V: active, prepaid, default tax rate, delivery-days override, accounting contact link (`importerDefaults`). U: id, created and updated times |
| products | F: sku, name, description, type, parent, barcode, mpn, origin, preferred supplier (by name) and its lock, weight, dimensions, prices, tax-inclusive flag, stock unit, oversell, image, active, lifecycle, category. V: tax category, customs codes, shop and accounting links, replenishment settings (`importerDefaults`); recipe (components, and for a BOM the manufacturing BOM and that it is active). U: id, times, `fulfillmentGraphVersion` (bumped by recipe writes), `preferredSupplierUpdatedAt` |
| product_categories | F: the normalised path (`nameNormalized`). U: display name, parent link (implied by the path) |
| product_components, boms, bom_items | F: component, quantity (component list; manufacturing BOM items). V: BOM active. U: order within the recipe, BOM name and description, item notes |
| stock_levels | V: quantity equals the layer, nothing reserved. U: update time |
| cost_layers | F: quantity, unit cost (6 dp). V: remaining equals received, opening flag, no PO line or production order, received-at equals the movement's time, linked to the movement. U: id |
| stock_movements | F/V: type, product, warehouse, quantity, unit cost and total value (equal to what the apply writes from the layer), no note, reference, idempotency key or shipment line. U: id, time |
| purchase_orders | F: supplier, currency, FX rate, destination, order tax name and percent, VAT convention, supplier reference, expected delivery, order discount, notes, status. V: subtotal, tax, total in both currencies (recomputed from the stored lines with `applyHeaderOrderDiscount`), type, landed-cost method, freight, discount text, internal notes, the shipping and lifecycle columns, archived flag, additional-cost rows. U: id, reference (the key), times |
| purchase_order_lines | F: product, quantity, entered amount after discount, discount and its text, tax (name, value, profile, amount against the rate). V: base unit cost, base total, base tax (`calcLineTotals` and the order's FX), description, purchase unit, received and returned quantities, landed cost, reorder evidence. U: id, position |
| supplier_products | U: written by every order (`lastUnitCost`, currency) as a price cache where the latest order wins; it is not an accounting record and the winner depends on order sequence |
| activity_logs | U: the audit trail of the run |
| first_load_apply_runs | V: digest, run id, status and step by the run-record rules; `facts` recorded once |

### The accounting profile of the tax rates

Just before the first purchase-order write the runner records, once, on the run record (`facts`, never rewritten), a digest of the accounting profile of the rate each tax lookup of the file resolves to. The read-back then requires each stored line's rate to have that profile, so a later change of a rate's tax type, reverse-charge flag, reporting category, compound flag or components shows as a difference in `lines`. It also checks that each stored line's tax AMOUNT is what its rate's current effective rate gives for the stored total (exclusive and VAT-inclusive), so a rate edited afterwards, or an amount edited by hand, shows too.

### The step lock

`withStepLock(step, body)` takes the session advisory lock `(411220875, n)`, `n` being the step's position in the load order (1 to 4), on a pinned connection, with the try form: a second runner for the same step is refused (`StepLockError`, busy) rather than queued. The lock is held for the whole step. **Before every importer call** the executor proves the lock is still ours, through the handle that step's acquisition gave its body (the pinned client has not failed, and `pg_locks` shows the lock granted to the backend THAT handle took it on). There is no module-level state, so a second runner in the same process on the same step cannot vouch for the first one's dead lock and that the run record is still this load's and RUNNING; otherwise no further call is made and the step ends STEP_FAILED (`lost`). The lock is verified again at the end of the step, so a step whose connection died never reports success. A runner holds at most one step lock at a time and releases it before the next step starts, so two runners cannot deadlock. A runner that does not hold the lock does not touch the run record. The tests observe the lock in `pg_locks`: during each importer call exactly that step's lock is held, in load order, and nothing is held between or after steps.

### The quiesce rail

Part of the rails below, and the one that makes the others mean something: they read, then the importers write, and only a database with no other writer keeps the two consistent. It reads `pg_stat_activity` for client backends of the current database and counts every one that is not **provably this process's own**.

Ownership is proved by the socket, not by the label: every connection this process holds is a TCP socket listed in `/proc/self/fd` and `/proc/net/tcp{,6}`, whose remote end must be the server's own endpoint (`inet_server_addr()`, `inet_server_port()`), and the server shows the same connection with `client_addr` AND `client_port` equal to our local address and port, compared in one canonical text form (an IPv4-mapped IPv6 address is its IPv4 address). The port alone is not an identity: a client on another host can use the same source port, so a session with our port from another address is counted. A session from another process, even on the same machine and even one that copied the runner's `application_name`, differs in address or port and is counted. A Unix-socket session has no client address and is counted, as is any session whose address is unusable; where `/proc` cannot be read, or the role cannot see other sessions (it needs superuser or `pg_read_all_stats`), or the view is unreadable, the rail refuses. System and background backends (autovacuum, WAL, statistics) are not client backends and are ignored; a session that is closing gets about a second to leave.

It runs in the preflight, at the start of every step, before the first write of every step, and before **every bounded importer call** (in the same per-call guard as the lock and run-record checks). It refuses, with a value-free sentence, or, between calls, stops the file with `QuiesceError`. This also covers the empty-target and foreign-row rechecks: a first run's emptiness is proved once in the preflight, and nothing else can connect to change it before the writes without the next check seeing it.

### Rails

Evaluated once before anything is written (`preflight`, plan and apply alike) and again at the start of every step and just before its first write (`recheckRails`). An unreadable value is an `ObservationError`, never a pass. The problem text names a rail, a count, or the position of an entry in the operator's manifest; it never carries a value from a prepared file (a warehouse is named "warehouse 2 of 3 in expectWarehouses").

| Rail | Refuses when |
| --- | --- |
| quiesce (always, and before every importer call) | another client backend (any session that is not provably this process's own, by socket) is connected to the database, this process's sockets cannot be listed, or the role cannot see other sessions. System and background backends (autovacuum, WAL, statistics) are not client backends and are ignored. A session that is closing is given about a second to leave |
| base currency | the organisation's base currency (GBP when there is no row, as the importers read it) is not the manifest's |
| forbidden SKUs | a product the manifest forbids (any case) already exists in the database |
| empty target (a first run only) | the product, supplier, customer, purchase order, sales order or stock movement table holds a row, or the base currency is already locked, and no run record says this runner loaded them. A resume is not asked for emptiness |
| warehouses | a warehouse the manifest declares is missing, inactive, duplicated under upper-casing, or has another type, availableForSale or syncToStore (a quarantine warehouse is declared `QUARANTINE`, not for sale, not synced, and is checked like the rest) |
| FX rates (purchase orders) | a stated rate has no stored base-to-currency rate on or before today, or differs from it by more than the importer's 2%. The runner never writes a rate |
| tax rates (purchase orders) | the name or value a line or order states does not resolve exactly as the importer would resolve it. A line that states a NAME must match an active purchase rate of that name (case-insensitive); a rate of another name with the stated value does not count, because the importer would fall back to it and create the order under a different tax. A line with no name must match an active purchase rate by value (within 0.00005). An order-level name must match an active rate of exactly that spelling, and EVERY active rate of that name (the importer takes any, whatever it is used for) must be a purchase rate. Where several rates match they must be **interchangeable**: the same percentage AND the same accounting profile (the effective rate its active components give, accounting tax type, compound flag, reverse-charge flag, reporting category, and the components themselves). Which of two same-named rates the importer takes is not relied on. A rate whose components do not add up to its percentage is refused (the importer matches the percentage and taxes at the components). A value that is blank, zero or negative on a line with no name states nothing: the importer reads it as no value and the line takes the order's tax, so it is not an unresolved tax. A stated value must be the value of the named rate. No rate the importer could apply (a named rate, an inherited order rate, a value match) may exceed the maximum purchase tax rate the prepared report declares (decimal-exact; a report that declares none refuses). |

Every bound the prepared report declares is enforced somewhere: the base currency (the base-currency rail), the maximum purchase tax rate (the tax rail, above), the row and byte limits per file (checked from the files when the run is loaded), and the order-reference prefix (the files). The report's as-of date has no database counterpart: an opening layer is dated at the apply instant.

Owner rulings, and where each is enforced: the accepted zero-cost pairs (the core compares the manifest with the file; the database side then compares each stored layer to the file, a zero cost included); products that are not stock tracked (the core refuses stock rows for them; the tests check a loaded NON_INVENTORY product has no stock level, layer or movement); forbidden SKUs (the core refuses a file that carries one; the database rail refuses a database that holds one); the quarantine warehouse profile (the warehouses rail).

### What the database side leaves to later slices

The restore point; the rails that read the outbound-write hold, the connector and cron state and the producer cut-offs; the post-run verification and the write census (so `ports.verify` is not supplied: a finished load ends with the record APPLIED and the result APPLIED_UNVERIFIED, exit 8, which is not a success and must not be read as OK); the command-line shell, target confirmation and rehearsal mode; the go/no-go check.

## Not proven here

- **The header-amount tolerance is one unit in the last stored place.** Header amounts are recomputed from the stored lines with the importer's own functions and accepted within 0.0001 (4 dp amounts) and, for a base unit cost, 0.000002 scaled by 1/fx below 1. A difference smaller than that is not seen. Header amounts are tied to the FILE only through the stored lines (quantity, entered amount, tax, rate), which the fingerprint pins; they are not recomputed from the file's raw numbers.
- **The recorded profile is the state at the first purchase-order write.** A rate's settings edited before that point are the rails' business (they run again just before it); edited after it they show as a difference. If the profile was never recorded (no purchase-order write has happened) there is nothing to compare, and only the amount check applies.

- **A call already in flight when the step lock is lost runs to its end.** The check is before each bounded call, not a fence inside the importers' own write transactions (they are the application's actions and are not changed). The window is therefore one bounded call: at most 500 rows for suppliers and opening stock, at most one order batch of 500 lines for purchase orders, and a whole products file (a variant needs its parent and a recipe its components in the same call). A runner that resumes in that window could write the same key at the same time; the database's own uniqueness (SKU, one opening layer per pair, purchase-order reference) then refuses the second write rather than duplicating it. Suppliers have no such constraint, so a supplier written by both could exist twice; the next read-back reports that as DUPLICATE_IN_DATABASE and the run stops. The lost runner stops at its next call and ends STEP_FAILED.

- **The purchase-order line amount is compared at 4 decimal places.** The importer computes the line in floating point and rounds to 4 places; the file side computes with exact decimals. They agree on the tested inputs (a discount, VAT-inclusive prices, a six-place unit cost), but a quantity times a unit cost that lands exactly on a half at the fifth place could round differently in the two engines and show as a difference. If it ever does, the effect is a CONFLICT that stops the run, never a silent pass.
- **A purchase-order line that names no tax is compared against exactly what the importer stores for it.** Under an order that names a tax, the line is given the active rate of exactly that name; under an order that names none, the line has no rate (the supplier's default rate is not used). The stored lines are paired with the file's lines as a multiset (a complete matching), so two lines identical except for their tax can be paired either way round. A stored line tax that is missing where the order names one, present where there should be none, or another rate, is a difference in `lines`. The same for a blank order currency: it matches only when the stored currency is the supplier's. A line that names a tax under an order that names none cannot be loaded (the importer refuses a group whose rows disagree on the order tax), so that case is not reachable.
- **The importers' own behaviour on a refused row is exercised, not modelled, for the cases the tests reach** (an existing key, a conflicting key, a crash between calls). The importer paths that need a second writer (a row taken by another writer during the call, a parent renamed mid-call) are not exercised here.
- **System-actor calls into the real actions are exercised against a real database** (the four importers and `createPurchaseOrder` through the purchase-order importer), with WooCommerce configured and enabled and a control showing the suppressed effect would have queued a row. The permission check and `revalidatePath` are skipped by the context; nothing here proves what a future change to an importer does with the context.
- **The session advisory lock** is proved against a direct PostgreSQL connection. Behind a transaction pooler a session lock excludes nobody; the lock-pool factory measures that, but a pooled production deployment has not been exercised.
- **The quiesce proof is a snapshot, taken at each check.** The checks are before anything is written, at each step's start, before each step's first write and before every bounded importer call. A session that connects between two calls is seen at the next one; the most it can overlap is the call in flight (at most 500 rows for suppliers and opening stock, one 500-line order batch, or a whole products file). Within that window an importer can update a supplier or product row that session wrote, and the read-back reports it as created; the importers' own uniqueness refuses some collisions (SKU, opening layer, PO reference). Blocking the application's database role during the load is the recommended operator step because it removes the window; the runner does not do it (a database-level gate is out of scope). The empty-target rail is covered by this proof. After the step, the read-back does not look for evidence that a row classified absent had existed earlier. A resume trusts the run record's digest and then the row-by-row residual. A runner on a non-Linux host, or over a Unix socket, cannot prove its own sessions and refuses.
- **The run record, the stock layers and the logs are written with the application's own clock**, so an opening layer is dated at the apply instant (the plan's ruling), not at the export time.
