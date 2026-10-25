# First-load apply runner

The first-load tool (`npm run first-load:prepare`, see [first-load-input-spec.md](first-load-input-spec.md)) turns the owner's exports into importer files and proves what it can without a database. The **apply runner** loads those files into an empty installation through the application's own importers. This page documents the runner as it exists today: **the core**, which reads and verifies a prepared run from bytes, works out which rows still have to be loaded, and drives the steps (plan, apply, resume) through ports; **the database side**, the real implementations of those ports; **the verification and census** that decide whether a finished load is a success; and **the command** (`npm run first-load:apply`) with its rehearsal, restore point and report publication.

> **PRECONDITION: THE APPLICATION IS STOPPED.** The first load must run against a database that **no other writer is connected to**. The runner's step lock excludes only other first-load runners; an ordinary request, worker or cron job could create or change a row between the runner's read and the importer's write, and the importer would overwrite it from the file while the read-back reported it as created.
>
> **Operator checklist, before `--apply` (and before every `--resume`):**
> 1. Stop the application (web, workers, queue consumers) for the target database.
> 2. Disable every cron job and scheduled task that connects to it (the sync sweeps, the backup job, report jobs). **The runner refuses while this account's crontab holds an active line that calls the application** (other than the three read-only jobs named under "The pre-load rails"): comment out or remove the managed block (`# --- OTI CRON START ---` to `END`) and any legacy line first. Note that `install.sh`, `update.sh` and `deploy.sh` re-create those lines (the owner decided they rewrite legacy lines too): do not run any of them between the rehearsal and the end of the load.
> 3. Close every interactive session (psql, a database GUI, an admin shell) on it.
> 4. Recommended, and the only thing that actually prevents a late writer: during the load, block the application's database role from connecting (disable its login, or revoke its connect right on this database) and re-enable it afterwards. The runner's checks below detect a session that connects; this step stops one from connecting at all.
> 5. Start the runner with `PGAPPNAME=ims-first-load-apply` in its environment (so its sessions are recognisable to you in `pg_stat_activity`), over a TCP connection from a Linux host. The runner's role must be a superuser or a member of `pg_read_all_stats`, or it cannot see other sessions and refuses.
>
> The runner **proves that no other client session is connected now** (before anything is written, at the start of each step, just before its first write, and before EVERY bounded importer call of at most 500 rows). A session that connects between two calls is detected at the next call only, so the most it can overlap is one bounded call; it cannot prove that none will connect later. See "The quiesce rail" and the not-proven list.

**What exists today:** the **core**; the **database side** (`lib/first-load/apply/db/`): reading the target, calling the application's own importers as a system actor, the durable run record, the per-step lock and the database rails; the **post-run verification and census** (`verify-core.ts`, `db/verify.ts`); and the **command** (`scripts/first-load-apply.ts`, `lib/first-load/apply/cli.ts`, `scripts/lib/first-load-apply-files.ts`, `scripts/lib/first-load-rehearse.ts`) with its three modes, the restore point and the published reports. The core opens no database connection, socket or child process; the database side opens only the connections to the target it is pointed at (`DATABASE_URL`) and never touches the network; the command's rehearsal starts a PostgreSQL cluster of its own on a loopback port. Mintsoft, Xero and WooCommerce are never touched.

**Also built:** the **pre-load rails** (`db/preload-rails.ts`): no outbound grant, a consistent producer-hold state, no connector enabled with a credential that could write and no writing cron line, all read-only and refused before the restore point is taken; the report's `preconditions[]` (every rail and every apply-time check); the rehearsal record's binding to the code commit; and the **readiness-gate check** `first-load-apply` (required at P0) that reads the published apply report.

**What is not built yet:** running `npm run validate:db` against the loaded database (the verification instead checks the migration table, the invariant report and the stock identities directly), the real-data rehearsal on the owner's files, and anything that fences the database (out of scope: the application is stopped).

The code is in `lib/first-load/apply/`: `constants.ts` (every constant and operator sentence), `manifest.ts` (the operator's manifest), `prepared.ts` (load and verify), `keys.ts` (natural keys and fingerprints), `normal-form.ts` (what "the same value" means, in one place), `residual.ts` (what is still to load), `import-calls.ts` (how a file is cut into importer calls), `orchestrate.ts` (plan, apply, resume), `report.ts` and `io.ts`; and in `lib/first-load/apply/db/`: `observe.ts`, `execute.ts`, `journal.ts`, `lock.ts`, `rails.ts`, `verify.ts` and `ports.ts`. The pure verification rules are in `verify-core.ts`, and the command's pure part in `cli.ts`.

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

The rows sent to the importer are the file of absent units only, in the original order. Correctness never depends on the run record: a crash between two row transactions leaves a database the next run reads correctly. The accounting is computed from the database, never from the importers' own counters (a product the importer counted as created whose recipe is missing is **failed**); the counters are kept as a cross-check finding. The importers' own error text (and any exception message) is **never stored or rendered**, because it can carry file values or exception text: the report keeps a bounded code (`ALREADY_EXISTS`, `NOT_FOUND`, `INVALID`, `EXCEPTION`, `OTHER`), a row number when the message names one, and the step. The rehearsal ceiling is fixed at 24 hours in the core; a caller cannot widen it, and an unusable limit or clock is a refusal. A purchase order whose lines span more than one prepared file is refused (the importer would create it from the first file and skip the rest). So is an order with more than 500 lines: an order is sent in one importer call and never split, and a call is bounded at 500 rows, so the prepared run is refused at load (a count, no key), before any call; the call planner refuses it as well.

### What is compared

Every column of every importer template is accounted for in one table (`FINGERPRINT_SPECS` in `keys.ts`): the key, a fingerprinted column, compared separately (the recipe), or **not persisted** with the reason (an id column that must be blank; descriptive or derived export columns the opening-stock importer does not read). A test checks the table against the template headers and against the columns each importer's source reads, and that a difference in each fingerprinted column (including every purchase-order header and line column: tax, VAT mode, discounts, supplier reference, expected delivery, notes) is a conflict.

### Problem text

A refusal (a problem string) names the step, the chunk and the line, or a column name, a count, or a closed reason. It never carries a cell value: problems reach logs, and a cell can hold anything. A test fills the fixtures with a sentinel and asserts it appears in no problem string. (The unit keys that the report rows carry are a separate, declared exception: see "What a report contains".)


A conflict found under the step lock is reported in the problems as a **closed code and a count per code** (`FIELDS_DIFFER x2`), never as the first key; the keys are in the report's conflict list. The counter cross-check names a count of units not loaded, not their keys. Entries of the operator's manifest that are data keys (a warehouse code, a zero-cost pair, a forbidden SKU) are named in manifest problems by their position (`expectWarehouses entry 2`, `acceptZeroCost entry 3`), not by value. A test seeds a conflict in each step and scans every problem, error and finding string for the seeded key.
## What a report contains

The apply report (JSON and Markdown) is a **private operator artefact**: write it to a directory only the operator can read (the files are created 0600) and do not paste it into tickets or chat. It contains identifiers and counts, and nothing else from the prepared files:

- the run id, the load digest, the prepared run's file names and SHA-256 hashes, counts, and the exit name with its operator sentence;
- the target as the server reported it (database name, cluster system identifier, number of migrations recorded), the restore point (path, SHA-256, size, and that `pg_restore --list` read it), and for a rehearsal whether the target was proved unchanged;
- per step: counts, the residual files' names, row counts and hashes, and one row per unit with exactly these fields: `key` (the unit key: a supplier name in lower case, a product SKU, an `SKU|WAREHOUSE` pair or a purchase-order reference), `outcome` (a closed word) and `reason` (a closed word or null);
- per conflict: `key`, `code` (a closed word) and `detail` (a fixed sentence);
- per importer message: a bounded `code` and a row number. The importer's own text is **never** stored or rendered, because it can carry file values or exception text;
- the problems of the run (the problem text rules above) and the verification items (below), each a closed id with a pass or fail and a count or closed word for what was expected and found;
- `preconditions[]` (report format version 2): one entry for every rail (`rail:<id>`, the ids of `RAIL_IDS`) and then one for every apply-time check (`check:<id>`, the ids of `APPLY_TIME_CHECKS`), always the same ids in the same order, each `pass`, `refused` or `not-applicable` with a closed detail (a count, or for the producer hold the state read). A rail that refused in ANY evaluation of the run is `refused`, whatever a later evaluation said. A check is proved by the rails that prove it (`APPLY_CHECK_RAILS`: for example `check:po-fx-rate` by `rail:fx-rates`); a check the prepared files alone prove passes (the run could not have been loaded otherwise), and the transfer checks are `not-applicable` because the runner refuses transfers. A run that ended before the database was read has none.

A report is published as `first-load-apply-<mode>-<run id>-<UTC stamp>.json` with a `.md` companion, in the report directory: each file is created exclusively (never overwriting, never through a symlink, mode 600), the Markdown first and the JSON last as the commit record, and the JSON names its Markdown by SHA-256 (`companionMarkdownSha256`), the format `lib/ops/published-report.ts` verifies. A rehearsal also publishes `first-load-rehearsal-record-<run id>-<UTC stamp>.json`.

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

## The command

`npm run first-load:apply -- <flags>` (`scripts/first-load-apply.ts`). The target is named by an **env file**, never by an argument: no secret is ever on a command line, and a value that looks like a connection string with a credential is refused outright. The process environment is **replaced** by a short whitelist (`PATH`, `LANG`, `LC_ALL`, `TZ`, `HOME`) plus the env file's variables, before the application's database client is imported, so an inherited `DATABASE_URL`, `PG*` variable or outbound grant cannot change where the run writes or what it believes. An env file that sets a variable that would redirect a client library (`PG*`, `NODE_OPTIONS`, `LD_PRELOAD` and similar) is refused, not silently cleaned. The env file must be a regular file owned by the caller with mode 600. The target is confirmed twice, by what the server says about itself: `--expect-db` against `current_database()` and `--expect-system-id` against `pg_control_system()`; a mismatch is PRECONDITION_REFUSED before anything else is read or written.

| Flag | Value | Applies to | Meaning |
| --- | --- | --- | --- |
| `--manifest` | `<file>` | all | The apply manifest (JSON). A relative preparedDir or wooSnapshot path in it is relative to the manifest file. |
| `--env-file` | `<file>` | all | The installation env file naming the target (DATABASE_URL inside). A regular file owned by the caller, mode 600. The process environment is replaced by a short whitelist plus this file. |
| `--expect-db` | `<name>` | all | Must equal current_database() as the server reports it, or the command refuses (exit 3). |
| `--expect-system-id` | `<id>` | all | Must equal the cluster system identifier as the server reports it, or the command refuses (exit 3). |
| `--report-dir` | `<dir>` | all | Where the reports and the rehearsal record are published. Created mode 700 if absent; a real directory owned by the caller, closed to group and others. |
| `--rehearse` | none | mode | The default. Copy the target into a throwaway cluster, run the whole load there and write a rehearsal record. The target is only read, and proved unchanged. |
| `--plan` | none | mode | Read the target and report what a load would do. Writes nothing to the database. |
| `--apply` | none | mode | Load the target: restore point, steps, verification, census. Needs --rehearsal-record. |
| `--rehearsal-record` | `<file>` | --apply | The record a rehearsal of this exact load wrote: same digest, same target system id, same ordered migration list as this checkout, verdict OK, within 24 hours. |
| `--resume` | none | --apply | Continue an interrupted load of the same digest (also verifies an APPLIED run). Needs the restore point recorded on the run record, unchanged. |
| `--operator` | `<label>` | --apply, --rehearse | Who the activity log names for the rows written (letters, digits, spaces, dots, dashes, underscores; default first-load-apply). |
| `--root` | `<dir>` | --rehearse | Where the throwaway cluster is made (default /var/tmp; not on a RAM-backed file system; every ancestor must be trustworthy). |
| `--help` | none | all | Print this text. |

Modes: `--rehearse` is the default (the safe one). `--plan` reads and reports. `--apply` writes, and only with a rehearsal record. The command refuses to run as root in `--rehearse` (the throwaway cluster's `initdb` will not); `--plan` and `--apply` run as the account that owns the env file.

### The rehearsal

The whole load, steps, verification and census, on a **copy** of the target in a throwaway cluster of its own. A preview would not do: it writes nothing, so on an empty database every downstream file fails to find what the earlier file would have created, and a purchase-order preview never reaches the code that needs an exchange rate. The rehearsal:

1. refuses to start (PRECONDITION_REFUSED, nothing created) as root, without PostgreSQL server binaries, on a `--root` that is not a directory, is on a RAM-backed file system or has an ancestor other accounts could modify;
2. counts every table of the target exactly, over a connection that cannot write (`default_transaction_read_only`);
3. dumps the target (`pg_dump --format=custom`, read only; the credentials reach the client tool as environment variables of that child only);
4. initialises a cluster under `<root>/ims-rehearsal-*` on a loopback port nothing else holds, with a superuser role of its own and a random password, restores the dump into a database named `ims_firstload_rehearsal`, and writes the child's env file (the installation's variables with `DATABASE_URL` replaced; mode 600, shredded in the teardown);
5. runs the rehearsal's **own entrypoint** (`scripts/first-load-apply-rehearsal-child.ts`) as a child, pointed at the copy. A child, because the application's database client reads its URL once, when first imported. The public command cannot become that child: the child's two flags (`--rehearsal-child-dir`, `--report-stem`) are unknown arguments there (exit 2);
6. tears the cluster down in a `finally`: the postmaster is stopped by the PID captured at start and confirmed to still be ours, the env file is shredded and the directory removed (`scripts/rehearse-first-install.ts` `teardownRun`, reused unchanged). An incomplete teardown is exit 7 (REHEARSAL_TEARDOWN_INCOMPLETE);
7. counts every table of the target again. **Any difference makes the rehearsal not valid**: the copy is then not a copy of the target as it now is, so the verdict is `TARGET_CHANGED` and the exit INTERNAL. (This also catches an unrelated writer on the target during the rehearsal, which is the right answer for a record that says "this target loads".)
8. publishes the **rehearsal record**: `formatVersion`, `manifestDigest`, `verdict`, `systemId` (the TARGET's cluster identifier, not the copy's), `finishedAt`, `schemaHash` (the hash of the ordered migration names of the checkout the rehearsal ran from), `build` (the commit and source tree of the clean checkout it ran from, `lib/ops/build-identity.ts`), `loadExit`, `targetUnchanged`, `teardownComplete` and `report`: the child's published report **bound** by file name, SHA-256, number of verification items and number failed. The record is the evidence of the rehearsal, not its summary.

**One function derives the verdict from every signal** (`deriveRehearsalVerdict` in `cli.ts`), and its default is non-OK: the string `OK` is returned only at the very end, after each of these has been checked, and the first failing one names the verdict: the child never started (`NOT_RUN`), timed out (`CHILD_TIMED_OUT`), was killed by a signal (`CHILD_KILLED`), exited with a code outside the table (`CHILD_EXIT_UNKNOWN`), published no report or one that is unreadable or not this load's (`REPORT_MISSING_OR_INVALID`), a report that names another exit than the process (`REPORT_DISAGREES_WITH_EXIT`), a non-zero exit (the exit's own name), a report that is not the exact shape of a clean finished load (`REPORT_INCOMPLETE`: the load's own steps and only them, in order, all DONE, balanced, no conflict, no problem, the throwaway target), a failing verification item behind an OK exit (`VERIFICATION_NOT_ALL_PASS`), the target changed (`TARGET_CHANGED`), the teardown failed even after the report was published (`TEARDOWN_INCOMPLETE`), or any problem recorded on the way (`PROBLEMS_RECORDED`). The record's `loadExit` reads `OK` only beside the verdict `OK`, and an OK record is never built without a bound report.

**`--apply` does not take the verdict on its word.** Besides the core's gate (digest, system id, age), the schema head and **the code** (the record's `build` must be the commit and source tree of this clean checkout; a record with none, one made on a checkout with uncommitted changes, or an apply from a dirty checkout is refused with exit 3 before a restore point is taken; the same commit in another checkout path is accepted, because the identity is the code), it requires the record to say the load ended OK, the target was unchanged and the teardown complete, and to bind a report; it then re-reads that report from beside the record, requires its SHA-256 to be the recorded one, and re-validates it. **Every "which set" is pinned to its exact required set**: the verification items must be EXACTLY the closed list of 17 ids (`VERIFICATION_IDS` in `verify-core.ts`, the same constant the verifier uses; each once, none unknown, none missing, so a dropped item or duplicate padding is refused) and all must pass; the steps must be exactly the steps this load selects; the tool, mode, digest and target database must be the expected ones. A missing, changed or failing bound report refuses the apply (exit 3) before any restore point is taken.

**The one thing the child waives is the need for a rehearsal record**, because it IS the rehearsal, and it is **authenticated, not recognised by its name or place**. Before it waives anything the child must present all of: (1) a single-use token (32 bytes from the CSPRNG) that the parent passes in the child's *environment* (`IMS_FIRST_LOAD_REHEARSAL_TOKEN`; never an argument) and whose SHA-256 the parent wrote, with the throwaway cluster's system identifier and the real target's, to `rehearsal-child.json` (mode 600) in the throwaway directory; the file is **consumed (deleted) on first use, accepted or not**, so a replay or a second claimant finds nothing; (2) the connected cluster is the recorded throwaway; (3) it is not the real target's cluster; and then, in addition, (4) the database is named `ims_firstload_rehearsal` and (5) its data directory is inside the run directory the parent named. Each of the five is tested on its own. A claim that fails any of them is refused with `REHEARSAL_CHILD_UNAUTHENTICATED` and a closed code (`NO_PROOF`, `NO_TOKEN`, `TOKEN_MISMATCH`, `WRONG_CLUSTER`, `IS_THE_TARGET`) and exit 3; that branch only ever refuses, so nothing else the command checks is relaxed by it. Matching the database name and a directory prefix is not proof (the rehearsal's first authentication was exactly that, and a forged claim with both matching waived the record and the restore point).

What a green rehearsal does **not** say: that the target will behave like the copy under a concurrent writer (the target is quiesced for a load, not fenced), that the real data's size or timing will, that anything outside the database is quiet, or that the target's content (rather than its row counts) is unchanged: the zero-write proof compares an exact `count(*)` of every table, so an update in place that changes no count is not seen by it (the rehearsal's own connections to the target are read-only, which is what prevents one).

### The restore point

Taken by `--apply` on a fresh load, after the rehearsal gate has passed and before the first write: `pg_dump --format=custom --no-owner` into `<restorePointDir>/first-load-<run id>.dump`, created exclusively with mode 600 (never overwritten), then its SHA-256 and size are recorded, and `pg_restore --list` must read it (otherwise it is removed and the command refuses, with nothing written to the database). `restorePointDir` must already exist, be a real directory owned by the caller and closed to group and others; it is not created, because a typo would make a new one. The restore point is recorded once on the run record (`facts.restorePoint`). **Restore parity is tested**, not only listing: `apply-cli-e2e` restores the dump of a real apply into a database of its own with `pg_restore --exit-on-error` and requires every table's row count to equal the target's counts immediately before the load (and to differ from the loaded database, as a control). A dump that is only readable would pass `pg_restore --list` and still be a way back to nothing. A `--resume` checks the recorded file is still there with the same SHA-256 and size and refuses (exit 3) otherwise: **there is no resuming without a way back**. A load begun without a recorded restore point cannot be resumed. The command never restores by itself.

## Verification and the census

Run by the ports after the last step (and on a `--resume` of an APPLIED run, which loads nothing). Every item is in the report; any failing item gives exit 1 (VERIFY_FAILED) and the run record VERIFY_FAILED, which a later `--resume` re-verifies. Items carry counts and closed words, **never** a SKU, supplier, reference, warehouse code, quantity or amount from the files: a failing stock total says how many totals differ, and the operator reads the numbers from the database. **A reading that cannot be taken is a failed item** ("could not be read"), never a missing one and never a pass.

| Item | What it checks |
| --- | --- |
| accounting-identity | In every step the result rows are exactly the prepared units (each key once, none missing or extra), each created or already there; emitted = created + skipped (existing); nothing updated, failed or in conflict. |
| row-chain-to-prepared-report | In every step the units' rows are a permutation of the prepared file's rows (each row in exactly one unit), the units are what the step emitted, and the file's row count is the one the prepared report planned. |
| final-readback | The database is read again from scratch at the end and every unit of every selected step is present and matching by its own key and fingerprint, with no row nobody in this run emitted. The step results are not trusted. |
| rails-after-load | The rails (nobody else connected, no data class holding a row it must not, warehouses and base currency as declared, every row of a table the runner writes attributable to the files) hold over the finished load. |
| stock-totals | Every opening layer equals its own file record (SKU and warehouse): received quantity and unit cost exactly, nothing consumed; the stored keys are exactly the file's; the sums equal the prepared report; no other layer exists. |
| opening-movements | Each file record has exactly one opening movement, linked to exactly one layer of the same SKU and warehouse, and the movement's quantity, unit cost and value equal the file's and the layer's exactly; the movement leaves no warehouse and no movement of another type exists. |
| stock-levels-equal-layers | For every SKU and warehouse pair the stock level equals the sum of the remaining quantity of that pair's layers, and nothing is reserved. A level without a layer, or a layer without a level, is a difference. |
| invariants | The application's own scheduled invariant check, run in process and writing nothing, completes with no critical finding. |
| bom-recipe-drift | ProductComponent and the manufacturing BOM agree for every BOM product (the application's own per-product drift report is empty). |
| purchase-orders-draft | The stored purchase orders are exactly the file's, by reference (each once, none missing or extra), and each is a draft. |
| base-currency | The base currency is locked, is GBP and is the manifest's. |
| migrations-applied | The migration table holds exactly the checkout's migrations, by name and in applied order, each finished and none rolled back, with no duplicate. Differences are reported as closed codes and counts (MIGRATIONS_MISSING, EXTRA, DUPLICATE, UNFINISHED, ROLLED_BACK, OUT_OF_ORDER). |
| outbound-held | The outbound-write status, evaluated against the installation's environment (this process's, which is the env file's variables on a whitelist), exits 0 under --expect-held: no grant, none unreadable, nothing queued or live. |
| no-held-writes | The refused outbound writes in the activity log are the same rows, by id, as at the start of the load (a set, not a count and not a time window); too many to list at the start or now is a failure. |
| no-queue-growth | The outbound queue, the accounting sync log, the warehouse job queue and the email queue hold the same content as at the start (a digest of every row, so a row replaced by another is seen with the count unchanged). |
| census-baseline | The starting state (a count of every table, a content digest of every table the runner does not write, and the refused-write ids) was recorded on the run record before the first importer call. |
| write-census | Against that starting state, only tables the runner writes changed: any other table whose count OR content digest changed (or that appeared or vanished) is named. |

**The census baseline.** The census compares the database with itself, so the starting state is taken before the first importer call and kept where a resume can find it: the run record's `facts.baseline` (written once, never rewritten), recorded at the start of the first step after the rails have passed. It holds an exact `count(*)` of every base table of the `public` schema (from `information_schema`, not a fixed list, not `pg_stat`, whose counters flush asynchronously); **a content digest (md5 over the sorted rows) of every table the runner does not write**, so a row replaced by another, or changed in place, is seen with the count unchanged; and the ids of the refused-outbound-write rows. The tables the runner may change are exactly the registry's RUNNER_WRITES class (those are compared record by record by the other items); any other table whose count or digest changed, and any table that appeared or vanished, is named. A load whose record has no baseline (begun by an earlier build) cannot be census-verified: all four census items fail.

**Why ids and not a window, and not a count,** for refused outbound writes: a time window would infer "new" from two clocks and from the order of timestamps, and a count cannot tell a row replaced by another. The ids at the start are compared with the ids now as sets. More than 5,000 at the start or now is a failure (nothing can be proved), not a pass.

### What each item compares

A count, a sum or an aggregate never stands in for the identity of a record. Every item below was audited for that one question; the test column names the arm in which the counts and totals stay equal while the records differ.

| Item | Compared | Aggregate allowed, and why | Test arm (counts equal, records differ) |
| --- | --- | --- | --- |
| accounting-identity | the result rows' KEYS against the prepared units' keys (a set), each outcome, then the identity | the identity is arithmetic over those rows | a row renamed; a row duplicated for another |
| row-chain-to-prepared-report | the row indexes of all units against the file's row indexes (a permutation) | the planned-row count is the tool's own figure | an index claimed twice and another by nobody |
| final-readback | every unit by key and fingerprint, and every foreign row | none | two suppliers exchange names |
| rails-after-load | the rail checks; the attribution rule per table counts rows no file record accounts for | a count of unattributed rows must be zero | (rails tests) |
| stock-totals | each layer against its file record by SKU and warehouse: received quantity, remaining quantity, unit cost | the sums equal the prepared report's total (the tool's own figure), in addition | two layers exchange quantities; costs exchanged; 0.000001 moved |
| opening-movements | each movement joined to its layer by the link the apply writes, and to the file record, by SKU and warehouse: quantity, unit cost and value | none | movement quantities exchanged; layer links crossed |
| stock-levels-equal-layers | per SKU and warehouse pair, the level against the sum of that pair's layers, and reserved quantity | none (the sum is per pair) | two levels exchange quantities |
| invariants | the application's own check | zero critical findings is an assertion, not a set | not set-valued |
| bom-recipe-drift | the application's per-product drift report | empty is the required value | covered by final-readback's recipe comparison |
| purchase-orders-draft | the stored references against the file's references (a set), each status | none | an order renamed |
| base-currency | the locked flag and the code | single values | not set-valued |
| migrations-applied | the migration table's NAMES in applied order against the checkout's exact list | none | the same count with one name different |
| outbound-held | the application's status report exit | single value | not set-valued |
| no-held-writes | the refused-write ids as a set | none | one row replaced by another |
| no-queue-growth | a content digest of each of the four queue tables | the count is also compared | a queue row replaced by another |
| census-baseline | the recorded baseline parses strictly | none | not set-valued |
| write-census | every non-runner table's content digest, and every table's count | the count for the runner's own tables only (compared by record elsewhere) | a configuration row changed in place |

The migration check is one function (`compareMigrations`) used by the precondition **before any write** (a mismatch is PRECONDITION_REFUSED with closed codes and counts) and by `migrations-applied`. A rehearsal record binds the **hash of the ordered migration-name list** (`schemaHash`), not the newest name or a count, and `--apply` refuses a record whose hash is not this checkout's.

### Fields read from an unverified file

Whatever the runner prints (problems, standard error, the published reports) must carry no value from a file it has not yet verified. This is every such source and how each field is handled; `tests/first-load/apply-untrusted.test.ts` puts a marker in each and asserts it is never printed.

| Source | Fields that reach text | Handling |
| --- | --- | --- |
| Prepared report | the codes of ERROR findings | only their NUMBER is printed |
| Prepared report | output file names; stray file names in the directory | printed only if they match the tool's own pattern (`NN-target-00k-of-00n.csv`, the report's own names); otherwise "withheld" |
| Prepared report | the planned row count; the stock quantity and value totals | a whole number or "not a whole number"; a total mismatch is `TOTAL_QUANTITY_MISMATCH` or `TOTAL_VALUE_MISMATCH` with no figure; a total that is not a decimal is a mismatch, never an exception |
| Prepared report | verdict, tool, base currency, output target, checksums | never interpolated; fixed sentences |
| Prepared files | cells | never interpolated; problems name a step, a chunk and a line, or a column |
| WooCommerce snapshot | everything the verifier reports (ids, SKUs) | only the NUMBER of problems; the detail is read with `first-load:woo-snapshot --verify` |
| Apply manifest | keys, steps, currency codes, rates, warehouse codes, SKUs, attestation | entries are named by position ("entry 3"); the JSON parser's message (which quotes the file) and the decimal parser's reason (which quotes the text) are dropped |
| Rehearsal record | every field | fixed sentences only; the record's report file name must match a plain `*.json` name before it is opened |
| Child report | every field | validated into numbers and booleans; anything else makes it invalid, and nothing from it is printed |
| Baseline and restore point in the run record | table names; held-write ids; the restore point path | a baseline with a table name that is not a plain schema name is no baseline; ids are compared and counted, never printed; the recorded restore point path is accepted only if it equals the path this load composes (it is not opened, hashed or printed otherwise) |
| Run record | the digest and the status | the status is one of the closed list or the record is unreadable; a digest mismatch says "not this load's" without the value |
| Importers | their messages | reduced to a closed code and a row number |

**A command whose evidence cannot be written does not succeed.** If a rehearsal's record cannot be published, the command exits INTERNAL and prints `RECORD_NOT_PUBLISHED` (a closed code, no path or error text), whatever the load on the copy did; likewise a report that cannot be published turns an OK into INTERNAL. Every other `catch` of the command either refuses (a refusal exit) or records a problem that makes the verdict non-OK.

### Switches that relax a safeguard

Every flag, variable and option that could skip a check, audited. None is on the public surface unauthenticated.

| Switch | Where it exists | Why it cannot be forged |
| --- | --- | --- |
| skip the rehearsal record (`thisIsTheRehearsal`) | an option of `runLoad`, set in exactly one place in the code (a test scans the tree for any other) | set only after the child proof above has passed |
| `--rehearsal-child-dir`, `--report-stem` | the rehearsal's own entrypoint only | unknown arguments on the public command; on the entrypoint they are inert without the proof |
| skip the restore point | none: it is taken whenever `--apply` runs outside the proven child | no flag; the child alone is exempt, because its target is the throwaway |
| skip the rails, the quiesce check, the rehearsal age limit | none | not configurable; the age limit is fixed in the core at 24 hours |
| `IMS_FIRST_LOAD_REHEARSAL_TOKEN` | read only by the child entrypoint | the public command ignores it; the environment is replaced by a whitelist before anything else |
| `--resume` | `--apply` | still needs the record, the rehearsal gate and the unchanged recorded restore point |
| `--operator` | the label in the audit rows | a label only (a closed pattern); it changes no check |
| `--root` | the rehearsal's scratch directory | refused on a RAM-backed or untrustworthy path; a rehearsal's verdict is not changed by where it ran |
| `--expect-db`, `--expect-system-id` | the target confirmation | they can only make the command refuse |

### Audit of the failure classes the review keeps finding

| Class | Where it could occur here | What closes it | Test (mutation that turns it red) |
| --- | --- | --- | --- |
| Time-of-check to time-of-use between a decision and a write | the rehearsal gate checked by the command, then the restore point, then the load; the baseline and the restore-point fact | the command checks the gate before the dump and the core checks it again before it reads the database; the run record is created by compare-and-swap, so a second runner that raced past the check loses; the restore point is created exclusively, so a second dump of the same run is refused; the baseline and the restore point are `setFactOnce` (the first writer wins), taken after the rails pass at step start | `apply-cli-e2e`: five stale or foreign records exit 3 with no dump and no run record (skip the gate); `apply-verify`: the baseline is the first attempt's after a crash and a resume (record it again on every start) |
| Starvation or a false finding | the zero-write proof; the held-writes check; a rehearsal on a target someone else writes to | the proof is an exact count of every table, so it does not depend on a flush; held writes are a count against the baseline, not a window; an unrelated writer on the target makes the rehearsal NOT valid (stated, and the right answer) rather than green | `apply-cli`: one row, an added table, a dropped table and swapped rows are each a change (compare the baseline's keys only); `apply-verify`: a refused write is caught by count |
| Fail-open on unreadable state | every verification read; the baseline; the env file; the restore point on resume; the target identity | a failed read is a failed item; an unreadable or missing baseline fails all four census items; an unreadable env file, run record or restore point is a refusal; an unreadable target is PRECONDITION_REFUSED | `apply-verify`: a table renamed away yields failed items for it and every id is still present (let the error escape or drop the item); a record without a baseline (return nothing) |
| A secret or a data key in problem text, logs or arguments | the command's output, the process list, the child's environment | counts and closed words in every item and problem; the credential-in-URL argument check; the target by env file; whitelist environment; the child's env file is 600 and shredded; the report contains unit keys only (as already documented) | `apply-cli`: seven credential-shaped arguments are refused and not echoed; `apply-cli-e2e`: no output of any run contains a secret of the scratch installation or a value of the prepared files |
| A verification through a coarser value than what is stored | stock totals; unit cost; levels against layers | exact decimals, tolerance zero, at the stored precision (6 dp); the database is summed in SQL as `numeric` (no float); levels are compared with the sum of layers per pair, including a level without a layer and a layer without a level | `apply-verify-core`: a difference of 0.000001 in quantity, in value, in the report total; `apply-verify`: the same in the database (compare through 2 dp or with a tolerance) |
| "Looks empty, so skipped" | a baseline with no tables; no step selected; no opening-stock step; no report total; an empty list of steps | an empty baseline is unusable; an empty step list fails the identity and the chain; with no opening-stock step the database must hold NO opening layer and the report total expected is zero; a missing report total is a failure, not a pass | `apply-verify-core`: no steps, no baseline, no report total each fail |
| Ordering inferred from timestamps | the census; the held-writes check; the report files | counts, not windows or timestamps; the report stem's timestamp is only a name, and a name that exists is refused rather than replaced | `apply-cli`: a second publication under the same stem is refused |

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
| 8 | APPLIED_UNVERIFIED | Every step loaded and the row accounting reconciles, but NO post-run verification was run (the runner was built without a verification port; the command always supplies one). This is NOT a success: do not treat it as OK. Rows ARE written. A later --resume of the same load runs the verification. |

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
| supplier-tax-rate | database | Needs the IMS tax rates. The prepared suppliers file must state a purchaseTaxType from the closed Xero list and a currency on every row. | Rail tax rates: every distinct purchaseTaxType of the suppliers file resolves to exactly one active IMS tax rate usable for purchases (usedFor PURCHASE or BOTH) with that accountingTaxType; several refuse. A type with NONE is first IMPORTED from Xero (below); it refuses only when that import is refused. Every supplier default rate is within the manifest's maxPurchaseTaxRate (SUPPLIER_TAX_RATE_ABOVE_MAX; no declared maximum: SUPPLIER_TAX_MAX_UNDECLARED). Every EXISTING supplier default rate must equal the trusted stored Xero row of its type (rate column and effective rate; SUPPLIER_TAX_RATE_DISAGREES_WITH_XERO names the type and both percentages, fixed by the Settings import with replace-differing), and an unusable stored list refuses (SUPPLIER_TAX_XERO_UNTRUSTED). The supplier importer repeats the lookup per row and sets the supplier default tax rate, and the read-back compares the stored rate's accounting tax type with the file. |
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

`createDbPorts(prepared, { operator })` returns the ports the core is handed. The target is whatever `DATABASE_URL` names, because that is where the importers write; the command (`scripts/first-load-apply.ts`) is what picks and confirms it (database name and cluster system identifier), and these ports refuse anything but an empty database for a first run. These ports add the data-level refusal: a first run needs an empty target (below).

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
| purchase_order_lines | F: product, quantity, entered amount after discount (which pins the stored total), discount and its text, tax (name, value, profile). V: net unit cost, base unit cost, total, base total, tax and base tax (each exactly equal to the importer's arithmetic on the file's numbers, at its stored precision), description, purchase unit, received and returned quantities, landed cost, reorder evidence. U: id, position |
| supplier_products | V: the row for each (supplier, product) of a stored line exists, and its currency and last unit cost (6 dp) is the net unit cost of the LAST line written for that pair (the last line of the most recently created order; orders stored with the same creation time are ordered by their position in the prepared file, because inside an importer call the orders are created one after the other in the order the file lists them (first appearance of the order key, kept by the call planner) and the calls of an attempt run in file order: a tie never accepts either value, only the later-listed order's; earlier orders, in whatever currency, are not compared with the cache at all). U: other rows (not written by this run), the supplier's own SKU and lead time |
| activity_logs | U: the audit trail of the run |
| first_load_apply_runs | V: digest, run id, status and step by the run-record rules; `facts` recorded once |

**Every persisted money or quantity column, and how it is covered. None is checked through a coarser derived value: each stored amount is compared with the file's numbers at its own stored precision.** Products: prices, weight and dimensions are fingerprinted. Opening stock: layer quantity and unit cost are fingerprinted; remaining quantity, the stock level (quantity, reserved), the movement's quantity, unit cost and total value are validated against the layer. Purchase-order lines: quantity, discount and the entered amount are fingerprinted; the net unit cost (6 dp), base unit cost (6 dp), totals and taxes in both currencies (4 dp) are each compared EXACTLY with the importer's arithmetic on the file's quantity, entered unit cost and discount, the line's tax rate and the order's FX rate. Purchase-order headers: every amount is recomputed from the stored lines. Supplier products: the cached price is the last line written for the pair. No money or quantity column that the importers write is unread; the columns in the table above marked U hold no amount.

**Observation coverage: which rows each step can see, so a resume misses no class of row.** Every table the empty-target rail counts has an observation path that sees every row of it, or its own check:

| Table | How a row that this run did not write is seen |
| --- | --- |
| suppliers, products, purchase orders (and their lines) | the whole table is read; any row not emitted by the run is a foreign row |
| stock movements | read for the whole table: a movement is attributed to its (product, warehouse) pair, and a movement that names **no warehouse** (historical sales imports write these) is foreign history under the key `SKU|(NO WAREHOUSE)`; a pair with anything but one opening layer and its movement is foreign history |
| stock levels, cost layers | read for the whole table, by pair |
| every other table of the schema | classified in one registry (`lib/first-load/apply/table-classes.ts`): a table that is MUST_BE_EMPTY (stock counts, stock transfers, sales, customers, invoices, payments, manufacturing, returns, shipments, kits, connector records and the rest) refuses every evaluation of a first run and a resume if it holds a row |

Foreign keys that can be null on these tables (a movement's warehouses, a supplier's default tax rate, a product's parent, preferred supplier and category) are read as such: a null is a value the comparison sees, not a row it skips.

### Table classes: the class of foreign data is closed, not listed

Every table of the schema (and the migration history) is classified once, in `lib/first-load/apply/table-classes.ts`:

| Class | Meaning | Rule |
| --- | --- | --- |
| RUNNER_WRITES | tables the runner writes (suppliers, products, categories, recipes and BOMs, stock levels, movements and cost layers, purchase orders and lines, the supplier price cache, the audit trail, the run record) | rows accounted for one by one by the observation; a first run needs them empty (but the audit trail and the run record) |
| CONFIG_ALLOWED | installation configuration, accounts, the application's own operation logs, the schema's migration history; each entry carries its reason | may hold rows |
| MUST_BE_EMPTY | every other table: business data this runner never writes | any row refuses a first run and every evaluation of a resume |

**Attribution on a resume.** The step observation reads only what the file names (a category attached to a file product, a price-cache pair a stored line uses), so a foreign row in a table the runner writes could be invisible to it. On every resume evaluation each RUNNER_WRITES table is therefore also counted against the file: `lib/first-load/apply/db/attribution.ts` holds exactly one rule per table (a test fails if a table of that class has none) and counts the rows the selected steps' files do not account for, and any such row refuses the resume (`foreign data: the <table> table holds N row(s) the prepared file does not account for`, a count only). The rules: suppliers by name, products by SKU, categories by the normalised path of a file product's category or one of its parents, recipe components and BOM items by (parent SKU, component SKU) of a file recipe, boms by a file BOM product, stock levels, cost layers and opening movements (a destination and no source) by the file's (SKU, warehouse) pairs, purchase orders by reference, their lines by (reference, SKU), price-cache rows by (supplier, SKU) of a file line AND a stored order of the file that used the pair (a pair present before any order wrote its line is somebody else's); a category must also hang under the parent its path implies and carry the path's last segment as its display name; the audit trail and the run record are the runner's own. A step that is not selected contributes nothing to the file's side.

The registry is checked three ways: a unit test fails if a table of `prisma/schema.prisma` is unclassified or the registry lists a table the schema lacks (so a new table forces a decision); a database test checks the registry names exactly the tables the migrated database has; and at run time a table in the database that the registry does not list refuses the load (a count, no name). Messages carry the table name (a schema name) and a count only.

### Upserts that merge into a row that already exists

Every importer path that upserts merges into a pre-existing row of the same key, keeping the columns it does not write. The audit, and where each is refused:

| Path | Columns the upsert keeps | Refused by |
| --- | --- | --- |
| suppliers (by lower-cased name) | active, prepaid, tax rate, delivery-days override, accounting contact | read-back defaults of the supplier (`defaultsEntry`) |
| products (by SKU) | tax category, shop/accounting links, customs, replenishment | read-back defaults of the product |
| categories (`update: {}`) | display name, parent | attribution: parent implied by the path, display name = last segment |
| price cache (`update` of cost and currency) | the supplier's own SKU, the lead time | read-back requires both null; attribution requires a stored order of the file to have used the pair |
| stock levels, cost layers, opening movements | every column | a pair is clean only if one layer, one movement and one level agree on every column; otherwise foreign history |

What stays unproven: a foreign row that already has exactly the values the importer would have written is indistinguishable from the run's own; and a category's display spelling beyond its normalised form is not compared (the importer keeps the first spelling it saw).

### What a failing importer leaves behind

The importers write their own audit entry, and on a failure that entry used to quote the first raw error (`Failed to import …: Row 2: supplier name "…" matches multiple suppliers`), which can name a supplier, a SKU or an order reference from the file. The activity log is readable by every user with the activity-log permission. On the system path `withSystemActor` now keeps only the static lead-in of an ERROR or WARNING entry (the text before the first ": ") plus "(details withheld on the system path)", for all four importers and the purchase-order creation they call. The runner reduces the raw text to codes and counts itself and never stores it. Audited, on the system path: the importers' other side effects on error (the shopping push, the stock-sync queue, page revalidation) are switched off by the system context, and no importer writes a notification or an outbox row for an error; the importers' `console.error` calls are on the web path only. Success entries (`Created PO <reference> for <supplier>`) name rows that were loaded and are visible in the application anyway; they are not redacted. Per-importer tests seed a failing row carrying a marker and scan the whole activity log.

Every importer result without the system outcome, with or without an error text (the web path was taken, or the importer's catch-all ran after work that may be partly written), makes the executor THROW. The core's step handler records the failure (the step ends FAILED and the journal says so), sends no later file of the step, and cannot mark the step DONE even if the database read-back matches the file; what was written is accounted for from the database on the resume. Nothing the result carried is kept. Audited: the only `break` in the step loop is that handler, and it sets the step's error; every other failure signal returns a halt.

### Which write was last

The price cache is compared with the last write per (supplier, product). "Last" is never inferred from a tie of stored timestamps: the stored creation time (millisecond resolution) decides, and a tie is broken by the order's position in the prepared file, which is the importer's own creation order inside a call. Audited: this is the only place the observation infers a last write from a timestamp (the opening layer/movement comparison tests equality of the two stored times, not their order). Not proven: two orders sharing a pair created by DIFFERENT attempts in the same millisecond (attempts are seconds apart: each takes the step lock, re-observes and re-plans) where the later attempt created the earlier-listed order.

### A lone stock level

Opening stock is observed per (SKU, warehouse) pair. A pair with no level, no layer and no movement is absent. A level row on its own, even at zero quantity and zero reserved, is NOT absent: the importer treats an empty level as a row to increment, so a level inserted between attempts would be merged silently, and a crash between the importer's own level and layer writes leaves the same picture. Both are reported as foreign history of the pair (the step is refused, nothing is written). Recovery, by the operator: look at the pair, and if the lone zero level is the leftover of this runner's own crash, delete that one row and resume; otherwise decide what the row is before loading. Other "looks empty" shortcuts were audited: a layer with a zero remaining quantity, a movement without its value fields, a movement with a note, reference or idempotency key, and a level with reserved stock each make the pair unclean (the clean test compares every column); defaults that are zero or blank (the products' and suppliers' unwritten columns) are compared exactly, not skipped.

### Importing the purchase tax rates from Xero (suppliers step)

Xero is the tax-rate master, so a supplier's purchase tax type that no IMS rate carries is **obtained from Xero before the load refuses**. The source is the stored copy of Xero's tax-rate list (`xero_tax_rates`, written only by the hourly `xero-tax-rate-drift` job); the load never calls Xero and never writes to it.

- **A plan (and the rehearsal's plan, and `--apply`'s preflight) writes nothing.** The `tax-rates` rail asks what the import WOULD create (`planPurchaseTaxImport`, a read) and reports it in its detail ("N purchase tax type(s) would be imported from Xero before the suppliers load (INPUT2, ...)"). It refuses, with the import's own named code, when the import would be refused.
- **Apply imports inside the suppliers step lock**, in `recheckRails(suppliers, 'before-first-write')`: after the run record exists and every rail (quiesce included) held, and only when the step still has rows to load. It creates, in one connection-fenced transaction, one active PURCHASE rate (with its components) for each stated type that has no eligible rate, with Xero's name, rate and tax type, **all or nothing** (if any needed type is refused, nothing is written). It then evaluates the supplier tax rail again **without** the import allowance: the rates must now exist and be unique, so an import that wrote nothing fails the step (`STEP_FAILED`, "a rail no longer holds"). The created rates are recorded once on the run record as the fact `purchaseTaxImport`.
- **Write rules.** `tax_rates` and `tax_rate_components` are classed RUNNER_WRITES (`table-classes.ts`) and may hold rows on a first run (they are the target's configuration, judged by the tax rails); the write census therefore expects them to change, and the resume's attribution accepts them (`attribution.ts`). The first load writes no activity-log row for the import. It never narrows a sales-side rate and never deactivates anything: those are the operator's explicit action (Settings > Accounting > Tax).
- **Refusal codes** (named in the rail's problem text): `XERO_NOT_CONNECTED` (no organisation connected, or the stored list's organisation is not the connected one: `XERO_LIST_WRONG_ORGANISATION`), `XERO_LIST_MISSING`, `XERO_LIST_NOT_STAMPED` (no last-success stamp for the list), `XERO_LIST_STALE` (read more than 26 hours ago: the freshness limit of the tax-rate drift reader), `XERO_LIST_UNREADABLE` (rows, count or digest do not match the header), `TYPE_NOT_IN_XERO`, `TYPE_NOT_ACTIVE_IN_XERO`, `TYPE_NOT_USABLE_ON_EXPENSES`, `RATE_NOT_STATED`, `RATE_NOT_REPRESENTABLE`, `RATE_INCONSISTENT`, `NON_RECOVERABLE_COMPONENT`, `NAME_COLLISION`, `AMBIGUOUS_EXISTING_RATES`; and for the ceiling `SUPPLIER_TAX_RATE_ABOVE_MAX` and `SUPPLIER_TAX_MAX_UNDECLARED`.
- **Operator notes.** The Xero connector is disabled during the load (the `connectors` pre-load rail), so the tax-rate job does not run: the list must have been read within 26 hours of the apply. The organisation's Xero token row must still be present (it ties the list to the organisation). An `ims-tax-rates` list supplied at prepare time that shows no rate for a type still rejects that supplier at prepare; omit the list when the import is meant to create the rate.
- **Existing rates are held to Xero too.** A supplier type that already has one eligible rate is not imported, but the rail compares that rate (the rate column AND the effective rate of its active components) with the trusted stored Xero row, using the same list proof as the import. A difference refuses the load in the plan and the apply: `SUPPLIER_TAX_RATE_DISAGREES_WITH_XERO` (names the type and both percentages); a missing, stale, unstamped or foreign list refuses: `SUPPLIER_TAX_XERO_UNTRUSTED`. Fix a difference with Settings > Accounting > Tax > Import purchase tax rates from Xero, with *replace differing* ticked (a new rate is created and the old one deactivated).
- **maxPurchaseTaxRate** (manifest) is now required whenever a suppliers file is supplied (before: only with purchase orders); the rail holds the rate column and the effective rate of every supplier default, existing or about to be imported, to it.

### The accounting profile of the tax rates

Just before the first purchase-order write the runner records, once, on the run record (`facts`, never rewritten), a digest of the accounting profile of the rate each tax lookup of the file resolves to. The read-back then requires each stored line's rate to have that profile, so a later change of a rate's tax type, reverse-charge flag, reporting category, compound flag or components shows as a difference in `lines`. The stored line and header amounts are also compared exactly with the importer's arithmetic on the file's numbers and the line's current effective rate, so a rate edited afterwards, or an amount edited by hand, shows too.

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
| data classes (every evaluation; a first run is stricter) | any table classified MUST_BE_EMPTY (see below) holds a row; or the database has a table the registry does not list. A FIRST run also needs the tables the runner writes to be empty (except the audit trail and the run record), and the base currency not yet locked |
| outbound grants (pre-load, always) | any of `WC_WRITEBACK_ALLOWED_ORIGIN`, `MINTSOFT_WRITE_ALLOWED`, `XERO_WRITE_ALLOWED_TENANT` is present in the installation environment, or is set but cannot be read. Names the destination only |
| producer hold (pre-load, always) | the enforcement variable `PRODUCER_HOLD_ENFORCED_DESTINATIONS` is set but cannot be read, a live-from instant (`*_WRITES_LIVE_FROM`) is set for any destination or cannot be read, or a grant and a live-from instant disagree. The state is reported in the precondition either way (enforcement OFF is the default and is turned ON at the switchover) |
| connectors (pre-load, always) | the storefront connector is enabled with its URL, key and secret; the warehouse connector is enabled with a credential (any one of a stored key, static key, username or password, or the same from its environment fallback: a lone username counts, because the rail does not decide what authenticates) or any active connection or binding; the accounting connector is enabled with a stored token or a client secret. A credential with the connector switched off passes |
| crons (pre-load, always) | the crontab of the account running the load holds ANY active line that is not proven harmless. A line is harmless only if it is blank or starts with `#` (after blanks), is an environment assignment (`NAME=value`, which runs nothing), or is a schedule (five numeric fields or `@reboot`/`@daily`/... in lower case) followed by a command that is, character for character, the command the application generates for one of the read-only jobs (`backup`, `writers-check`, `read-sync-liveness`, with or without the runtime-secret prefix; the env-file and log paths may be any ordinary path with no quote). It is an ALLOWLIST: an arbitrary command, two commands on a line, extra arguments, a pipe, a redirect, a substitution, a continued line, a legacy bearer-on-the-command-line line, a hand-written call, a case variant all refuse, counted and never described. A crontab that cannot be read refuses (only the single answer "no crontab for <user>" is an empty crontab) |
| warehouses | a warehouse the manifest declares is missing, inactive, duplicated under upper-casing, or has another type, availableForSale or syncToStore (a quarantine warehouse is declared `QUARANTINE`, not for sale, not synced, and is checked like the rest) |
| FX rates (purchase orders) | a stated rate has no stored base-to-currency rate on or before today, or differs from it by more than the importer's 2%. The runner never writes a rate |
| tax rates (suppliers) | a purchase tax type the suppliers file states (a Xero tax type: INPUT2, ZERORATEDINPUT or NONE) is blank, or matches more than one active IMS tax rate usable for purchases (usedFor PURCHASE or BOTH) with that accounting tax type, or matches none AND the import from Xero is refused (below), or the rate it resolves to (or would be imported as) is above the manifest's maxPurchaseTaxRate. The supplier importer sets the supplier's default tax rate to the one match; it is never chosen by name, and the read-back compares the stored rate's accounting tax type with the file. A blank currency in the suppliers file is refused in the prepared run (the importer's silent default is not taken). |
| tax rates (purchase orders) | the name or value a line or order states does not resolve exactly as the importer would resolve it. A line that states a NAME must match an active purchase rate of that name (case-insensitive); a rate of another name with the stated value does not count, because the importer would fall back to it and create the order under a different tax. A line with no name must match an active purchase rate by value (within 0.00005). An order-level name must match an active rate of exactly that spelling, and EVERY active rate of that name (the importer takes any, whatever it is used for) must be a purchase rate. Where several rates match they must be **interchangeable**: the same percentage AND the same accounting profile (the effective rate its active components give, accounting tax type, compound flag, reverse-charge flag, reporting category, and the components themselves). Which of two same-named rates the importer takes is not relied on. A rate whose components do not add up to its percentage is refused (the importer matches the percentage and taxes at the components). A value that is blank, zero or negative on a line with no name states nothing: the importer reads it as no value and the line takes the order's tax, so it is not an unresolved tax. A stated value must be the value of the named rate. No rate the importer could apply (a named rate, an inherited order rate, a value match) may exceed the maximum purchase tax rate the prepared report declares (decimal-exact; a report that declares none refuses). |

Every bound the prepared report declares is enforced somewhere: the base currency (the base-currency rail), the maximum purchase tax rate (the tax rail, above), the row and byte limits per file (checked from the files when the run is loaded), and the order-reference prefix (the files). The report's as-of date has no database counterpart: an opening layer is dated at the apply instant.

Owner rulings, and where each is enforced: the accepted zero-cost pairs (the core compares the manifest with the file; the database side then compares each stored layer to the file, a zero cost included); products that are not stock tracked (the core refuses stock rows for them; the tests check a loaded NON_INVENTORY product has no stock level, layer or movement); forbidden SKUs (the core refuses a file that carries one; the database rail refuses a database that holds one); the quarantine warehouse profile (the warehouses rail).

### The pre-load rails

The first load runs with the application **stopped** (the precondition at the top), and a database-wide write fence is out of scope: the quiesce rail is the enforced part for the database. These four rails cover what the quiesce rail cannot see, and they are the ones that make "nothing outside IMS may be written" more than the operator's word. Each is **read only and fails closed**: a value that cannot be read is a refusal, never "fine". They are in `lib/first-load/apply/db/preload-rails.ts`.

- **When.** The command evaluates **every** rail (these four included) after the rehearsal gate and before the restore point is taken, so a refusal has not even written a dump. The core evaluates them again in the preflight, at the start of every step and before each step's first write, and the verification evaluates them once more over the finished load (`rails-after-load`): a grant or an armed cron that appears during the load stops the next step (STEP_FAILED, resumable), and one that is still there at the end fails the verification.
- **Which environment.** The environment the command builds: the installation env file (`--env-file`) and the short whitelist. A grant in the caller's own shell is not inherited (the environment is replaced), so it cannot change what the importers do; the grants that matter are the ones the application would start with, which is the file.
- **Producer hold.** `PRODUCER_HOLD_ENFORCED_DESTINATIONS` defaults OFF and is turned ON at the switchover. Either value is accepted for the load, because the load produces no work for any destination: the importers run with the system context, which defers every connector effect, and the verification proves the outboxes did not grow. What is refused is any destination that could *receive writes from the load*: a grant, a live-from instant, or the two disagreeing. After the hold is turned OFF again, run `npm run outbound:status` and do not delete orders until a full sweep completes (the owner's operator rule).
- **Connectors.** Read from the database's settings and tokens, by presence only: a stored credential is never decrypted and never printed. "Enabled" is the integration plugin switch, but stricter than the application: the application enables a plugin only for the exact text `true`, and this rail reads any value other than absent, blank or exactly `false` as enabled (an unknown value is refused, not skipped). The warehouse side covers every registered warehouse connector id.
- **Grant lookalikes.** An environment variable whose name contains `WRITEBACK`, `WRITE_ALLOWED`, `WRITES_LIVE_FROM` or `PRODUCER_HOLD` but is not spelled exactly as a variable the application reads (another case, a prefix, a suffix) refuses, counted and never named. A grant variable that is set but blank is read as absent, as the transport reads it.
- **Crons.** An allowlist over the whole crontab, not a search for the application's URL (a line that never names it, such as `/usr/local/bin/write-to-xero`, is refused like any other). The pattern for each of the three read-only jobs is built from the application's own renderer (`renderCronJobCommand`), so it cannot drift from what the application installs; legacy line shapes are not in it and refuse.
- **Text.** A problem names the rail, a closed connector label and a count. It never carries a variable's value, a setting, a credential, a crontab line or a slug.

**What they do not prove.** They read this account's crontab and this database's settings, in this environment file. They cannot see another account's crontab or `/etc/cron.d`, a process that is already running, a service started with a different environment, or a connector configured in a place IMS does not store (the vendor's side). The legacy cron lines that `install.sh`, `update.sh` and `deploy.sh` rewrite are an owner decision already made (they rewrite them): the operator must not run those during the load, and the rail will refuse the load if they have re-armed the crontab.

**Audit of the failure classes this change could have, and what closes each:**

| Class | Where it could occur here | What closes it | Test (mutation that turns it red) |
| --- | --- | --- | --- |
| Time-of-check to time-of-use | a grant, connector or cron appearing between the check and the write; the preflight in the command and the one in the core | evaluated in the command before the restore point, in the core's preflight, at each step start, before each first write and after the load; each reads fresh | `apply-db` "evaluated again inside the run" (drop the step-start recheck: the grant that appears after the preflight is not seen); `apply-cli-e2e` (move the rails after the dump: a dump exists) |
| Unknown shape treated as skipped | a crontab line that does not mention the application; a line with a second command; a plugin switch with an odd value; a grant variable spelled differently | the crons rail is an allowlist (only a comment, an environment assignment or the exact generated read-only command passes); an odd plugin value reads as enabled; grant lookalikes refuse | `apply-preload-rails` (arbitrary command, two commands, pipe, substitution, continuation, case variants, lookalike names); `apply-db` (odd plugin values) |
| Unreadable treated as ok | the crontab, the settings, the grant variables, the enforcement variable, the live-from instants | an unreadable grant, instant or enforcement value refuses; an unreadable crontab refuses (only "no crontab for <user>" is empty); an unreadable settings table or token count throws and the run is PRECONDITION_REFUSED | `apply-preload-rails` (every unreadable arm); `apply-db` "an unreadable settings table" (return an empty snapshot: the load goes ahead) |
| A count or aggregate standing in for identity | the connector rail; the cron rail | the connector rail reads each connector's own switch and own credential rows (a count of connections cannot clear a connector with a key); a cron line is classified by its own job slug against a closed allowlist, not by "a line count" | `apply-preload-rails` (credentials with the connector off pass; the same connector on refuses; a read-only line next to a writing one still refuses) |
| A field of an unverified source in text | environment values, settings, crontab lines | messages carry rail names, closed labels and counts; the report's precondition detail is a count or a state word; a test searches every message for the planted values | `apply-preload-rails` (no value in the text), `apply-db` (no credential or URL in the refusal), `apply-cli-e2e` (no value on the command's output) |
| Authenticated versus named | the "read-only" cron jobs; "disabled" connectors | a job is read-only only if its slug is on a closed list that a test checks is registered; "disabled" is the plugin switch the application itself reads, not a name or a label | `apply-preload-rails` (allow every slug: a writer passes) |
| Ordering inferred from timestamps | which report speaks for the database (the gate); the rail tally | the tally counts refusals over the whole run (a later pass does not erase an earlier refusal); the gate selects by the run record's identity, never by a time | `apply-preload-rails` (take the last evaluation: a refused rail reads pass); `readiness-gate-first-load` (pick the newest by file time) |
| "Looks empty, so skipped" | no crontab, no settings row, no connector rows, no steps needing a rail | no crontab is a *resolved* empty answer, not a failed one; the rails always run, and a precondition that did not apply is `not-applicable`, not `pass`; the four pre-load rails apply to every run | `apply-preload-rails` ("no crontab" vs "could not read"); `apply-preload-rails` (preconditions: a check whose only rail did not apply is not-applicable) |
| Exit staying OK after a recorded failure | a pre-load rail refusing at the end of a run; a precondition refused in the middle | a refusal at the start is PRECONDITION_REFUSED (nothing written); during the run it is STEP_FAILED; at the end it fails `rails-after-load` (VERIFY_FAILED); the gate rejects any report with a refused precondition | `apply-db`, `apply-verify` (rails-after-load), `readiness-gate-first-load` ("a precondition refused") |

### What the database side leaves to later slices

Running `npm run validate:db` against the loaded database. The rest (verification and census, the command, the rehearsal, the restore point, the pre-load rails, the report's preconditions and the readiness-gate check) exists and is documented here.

## The readiness gate

`npm run readiness:gate -- --phase P0` has a check `first-load-apply`: **required at P0, listed only at P1 and P2** (the check list is generated from `lib/ops/readiness-gate-constants.ts` into `docs/installation.md`; every P0 GO now needs this check to pass, so a P0 verdict can no longer be GO on an installation with no applied first load). The gate reads, never writes, and makes no call to a vendor.

It passes only when **all** of these hold:

1. The database holds exactly one first-load run record and its status is `VERIFIED` (the record is moved only by compare-and-swap, so it orders loads and re-verifications: a later failed verification makes it `VERIFY_FAILED` and this check fails, whatever older OK report is on disk).
2. A published apply report in `--apply-report-dir` (default `/var/tmp/ims-first-load-apply-reports`; the same directory the command's `--report-dir` named) **names that run**: the same run id and the same load digest. **Which report speaks for the database is decided by that identity, never by the newest file**: reports are not ranked by time; one intact report that ended OK is enough, and earlier reports of the same run that ended otherwise (a resumed load) are history.
3. That report is about **this cluster** (`target.systemId` equals the system identifier the gate reads from the server itself), has `tool` `first-load-apply`, `formatVersion` 2, `mode` `apply`, `exit` OK with code 0, no problems, every step `DONE` (or, in the report of a verification-only `--apply --resume` of an APPLIED run, `PENDING` with every unit already present and matching) with no failed unit and `emitted = created + updated + skipped + failed`, `accountingBalanced`, exactly the closed list of verification items each passing once, a restore point with a digest, a size and `listed`, `preconditions[]` equal to exactly `PRECONDITION_IDS` in order with none refused and the seven always-evaluated rails (`quiesce`, `data-classes`, `base-currency` and the four pre-load rails) `pass`, and a window that ended within 30 days and not in the future.

**Trust of the files** (the policy of the rehearsal reports, tightened): the directory and every ancestor, and every candidate file and its Markdown companion, must be ones only root or the running account could have written (no symlink, owned by root or the account, not writable by group or others); any violation refuses the whole location. Each JSON is read **once** through `readTrustedRegularFileBytes`, and the parse and the Markdown digest use those same bytes (`companionMarkdownSha256` against the Markdown read the same way), so a file that changes after the read changes nothing. A file's name selects a candidate and is believed for nothing. A failure prints a closed code and a count (`markdown-digest`, `exit-not-ok`, `steps`, `verification`, `restore-point`, `preconditions`, `system-id`, `age`, ...): no field of the file reaches the text.

**What the gate does not prove.** That the report was not forged by the same account or by root (ownership and mode are checked, not authenticity); that the data in the database is still what the report says (the run record is checked, not the rows; the reconciliation pack items R1 to R15 are the checks that compare data, and they are separate); that the rehearsal ran from the code the apply ran from (the apply command checks that; the gate does not repeat it); that a report older than 30 days is wrong (it is refused as old: run the gate soon after the load or rerun the verification with `--apply --resume`, which writes a fresh report).

## Not proven here

- **Float agreement is assumed at half-way cases.** The stored purchase-order amounts are compared with no tolerance, at the places they are stored, against what the importer's arithmetic gives for the file's numbers (`expectedLine`, the same expressions and rounding primitives). The importer computes in floating point and the database rounds the stored value half up; a value that lands exactly on a half at the last stored place is rounded the same way by both on every case tested, but the comparison relies on that rather than on a tolerance.
- **The recorded profile is the state at the first purchase-order write.** A rate's settings edited before that point are the rails' business (they run again just before it); edited after it they show as a difference. If the profile was never recorded (no purchase-order write has happened) there is nothing to compare, and only the amount check applies.

- **A call already in flight when the step lock is lost runs to its end.** The check is before each bounded call, not a fence inside the importers' own write transactions (they are the application's actions and are not changed). The window is therefore one bounded call: at most 500 rows for suppliers and opening stock, at most one order batch of 500 lines for purchase orders, and a whole products file (a variant needs its parent and a recipe its components in the same call). A runner that resumes in that window could write the same key at the same time; the database's own uniqueness (SKU, one opening layer per pair, purchase-order reference) then refuses the second write rather than duplicating it. Suppliers have no such constraint, so a supplier written by both could exist twice; the next read-back reports that as DUPLICATE_IN_DATABASE and the run stops. The lost runner stops at its next call and ends STEP_FAILED.

- **The purchase-order line amount is compared at 4 decimal places.** The importer computes the line in floating point and rounds to 4 places; the file side computes with exact decimals. They agree on the tested inputs (a discount, VAT-inclusive prices, a six-place unit cost), but a quantity times a unit cost that lands exactly on a half at the fifth place could round differently in the two engines and show as a difference. If it ever does, the effect is a CONFLICT that stops the run, never a silent pass.
- **A purchase-order line that names no tax is compared against exactly what the importer stores for it.** Under an order that names a tax, the line is given the active rate of exactly that name; under an order that names none, the line has no rate (the supplier's default rate is not used). The stored lines are paired with the file's lines as a multiset (a complete matching), so two lines identical except for their tax can be paired either way round. A stored line tax that is missing where the order names one, present where there should be none, or another rate, is a difference in `lines`. The same for a blank order currency: it matches only when the stored currency is the supplier's. A line that names a tax under an order that names none cannot be loaded (the importer refuses a group whose rows disagree on the order tax), so that case is not reachable.
- **The importers' own behaviour on a refused row is exercised, not modelled, for the cases the tests reach** (an existing key, a conflicting key, a crash between calls). The importer paths that need a second writer (a row taken by another writer during the call, a parent renamed mid-call) are not exercised here.
- **System-actor calls into the real actions are exercised against a real database** (the four importers and `createPurchaseOrder` through the purchase-order importer), with WooCommerce configured and enabled and a control showing the suppressed effect would have queued a row. The permission check and `revalidatePath` are skipped by the context; nothing here proves what a future change to an importer does with the context.
- **The session advisory lock** is proved against a direct PostgreSQL connection. Behind a transaction pooler a session lock excludes nobody; the lock-pool factory measures that, but a pooled production deployment has not been exercised.
- **The quiesce proof is a snapshot, taken at each check.** The checks are before anything is written, at each step's start, before each step's first write and before every bounded importer call. A session that connects between two calls is seen at the next one; the most it can overlap is the call in flight (at most 500 rows for suppliers and opening stock, one 500-line order batch, or a whole products file). Within that window an importer can update a supplier or product row that session wrote, and the read-back reports it as created; the importers' own uniqueness refuses some collisions (SKU, opening layer, PO reference). Blocking the application's database role during the load is the recommended operator step because it removes the window; the runner does not do it (a database-level gate is out of scope). The empty-target rail is covered by this proof. After the step, the read-back does not look for evidence that a row classified absent had existed earlier. A resume trusts the run record's digest and then the row-by-row residual. A runner on a non-Linux host, or over a Unix socket, cannot prove its own sessions and refuses.
- **The run record, the stock layers and the logs are written with the application's own clock**, so an opening layer is dated at the apply instant (the plan's ruling), not at the export time.
- **The verification proves the database against the files and against itself; it does not prove the files against the world.** The owner's reconciliation against Qoblex, Mintsoft and WooCommerce is a separate pack. Nothing here says the prepared files are right, only that the database holds exactly them.
- **The zero-write proof of the rehearsal is a row count of every table**, taken twice over a connection that cannot write. An update in place that changes no count would not be seen by it. It is not a content hash.
- **The restore point is a dump `pg_restore --list` can read, and a test restores it with row-count parity.** The test is of a small synthetic load on a scratch cluster. This command does not restore on its own (it never restores), and a restore of a production-size dump has not been timed or exercised: the first real restore is the operator's.
- **The rehearsal's copy is a logical restore** (dump, then restore with `--no-owner --no-privileges`), so it has another cluster system identifier, other roles and no grants. The load does not depend on them; a difference the load does depend on would show as a rail or verification failure on the copy, not as a silent pass.
- **Nothing here fences the database.** The application is stopped for a load by the operator; the runner proves nobody else is connected at each check (see the quiesce rail) and the census proves no other table changed. A writer that connects, writes and leaves between two checks is not seen.
- **The pre-load rails read this account's crontab, this database's settings and this env file, nothing else.** Another account's crontab, `/etc/cron.d`, a running process, a service started with a different environment, and a credential or webhook configured on the vendor's side are not seen. A connector whose credential is held outside IMS's settings and tokens is not seen either. The rails are a check that the things IMS controls are quiet, not a proof that nothing can write.
- **The cron allowlist is a judgement.** `backup`, `writers-check` and `read-sync-liveness` are treated as never writing to the database or a destination; every other job is a writer. A job added later is a writer until someone adds it to the list. A cron line that calls the application by a route this check does not recognise is `unclassified` and refuses, but a line that never mentions the application's URL (a script that calls it indirectly) is not seen.
- **The producer-hold state is reported, not required to be ON or OFF.** The rail refuses a destination that could receive writes from the load; it does not check that the hold is ON at the switchover (that is the switchover procedure and `writers:check`).
- **The gate's `first-load-apply` check trusts the run record and the files' ownership.** It does not compare the rows with the report and it cannot tell a forged report from a genuine one if both were written by the same account.
- **The migration order is Prisma's order on a fresh deploy** (an underscore sorts before a digit; a test re-measures it on every run). A database upgraded release by release can have applied a same-day migration in another order; it is refused with MIGRATIONS_OUT_OF_ORDER (fail closed), and the remedy is a reinstall or a restore.
- **`npm run validate:db` is not run by the command.** It regenerates the Prisma client in the checkout and is a scratch-database step; the verification checks the migration table, the stock identities and the invariant report directly instead.
- **A rehearsal is bound to the schema (the hash of its ordered migration list) and to the code commit and source tree, not to the build artefact or the `.env`.** The record names a clean checkout's commit and tree, and the apply refuses any other (or a dirty one). Ignored files (`.env`, `.next`, `node_modules`) are outside that identity: a different dependency set under the same commit is not detected.
