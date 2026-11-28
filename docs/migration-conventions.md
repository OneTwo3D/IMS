# Migration conventions

IMS migrations are append-only once merged. If a migration has reached a data-bearing environment, do not edit it in place; ship a follow-up migration. Not-live development databases can be reset or recreated, but data-bearing development and staging databases still need an explicit recovery plan before checksum or resolved-state changes.

These conventions apply to new migration SQL and are enforced for changed migration files by:

```bash
npm run check:migration-conventions
```

The guard compares the PR branch against `origin/development`, so historical migrations are not failed retroactively. Local clones should run `git fetch origin` before validation; the guard warns when the local `origin/*` ref appears stale.

If a changed migration intentionally uses one of the risky patterns below, add a SQL line comment naming the specific pattern with a specific rollout or not-live rationale:

```sql
-- migration-convention-ok: RENAME COLUMN because <specific rollout or not-live rationale>
```

Allowed marker patterns are `RENAME COLUMN`, `DROP COLUMN`, `ADD COLUMN NOT NULL`, and `NOT VALID`. Markers are per-pattern; a `RENAME COLUMN` marker does not suppress an unsafe `ADD COLUMN NOT NULL` in the same file. Avoid broad markers. The marker is a reviewer sign-off escape hatch, not a way to skip the rollout plan.

## NOT NULL add-column

Do not add a required column to an existing table with no default:

```sql
ALTER TABLE "activity_logs" ADD COLUMN "tag" TEXT NOT NULL;
```

Use one of these patterns instead:

1. Add the column with a safe `DEFAULT` when every historical row can use that default.
2. Add the column as nullable.
3. Backfill existing rows in bounded batches where practical.
4. Add a `CHECK (<column> IS NOT NULL) NOT VALID` constraint.
5. `VALIDATE CONSTRAINT` after the backfill completes.
6. Set the column `NOT NULL` once validation proves no null rows remain.
7. Drop the temporary check constraint if it is no longer needed.

## NOT VALID constraints

`NOT VALID` constraints still protect future writes, but they do not prove existing rows are clean until validation runs. Every `NOT VALID` constraint must be validated in the same migration. If validation must intentionally land in a follow-up migration, add a per-pattern marker that names the follow-up migration and explains the bounded rollout:

```sql
-- migration-convention-ok: NOT VALID because follow-up migration 20260606120000 validates after bounded production cleanup
```

Preferred shape:

```sql
ALTER TABLE "stock_levels"
  ADD CONSTRAINT "stock_levels_quantity_nonnegative"
  CHECK ("quantity" >= 0) NOT VALID;

ALTER TABLE "stock_levels"
  VALIDATE CONSTRAINT "stock_levels_quantity_nonnegative";
```

For large tables, include a preflight `DO $$` block or documented query that turns violation counts into an actionable deployment failure before validation scans the table.

## Column renames

Avoid one-shot `RENAME COLUMN` migrations on data-bearing deploys. They break canary or partial deployments because one app version reads the old column while another reads the new one.

Use the 3-phase pattern:

1. Expand: add the new column while keeping the old column.
2. Backfill and dual-write: app code writes both columns and reads from the new column with old-column fallback while backfill completes.
3. Cutover and drop: deploy code that only uses the new column, then drop the old column in a later migration.

If the system is not live and a one-shot rename is intentionally acceptable, keep that decision in the PR body and add the `migration-convention-ok: RENAME COLUMN because ...` marker to the migration.

## Indexes on large tables

Use `CREATE INDEX CONCURRENTLY` for large or write-heavy tables so writes are not blocked for the duration of the index build. Prisma wraps migrations in a transaction by default; `CREATE INDEX CONCURRENTLY` cannot run inside that transaction, so isolate each concurrent index into its own migration file and document the reason in SQL.

Examples of tables that should usually use concurrent indexes are `stock_movements`, `sales_orders`, `activity_logs`, `accounting_sync_logs`, and any table expected to grow with daily operations.

Small lookup tables can use regular `CREATE INDEX` when the PR explains the table size and rollout context.

## Column drops

Never drop a column in the same deploy that removes the last app-code reference unless the instance is known not to be live. For data-bearing deploys:

1. Deploy app code that no longer reads or writes the column.
2. Verify no code path or external script still references it.
3. Drop the column in a later migration.

For historical connector fields, keep generic selectors/view models in app code so future connector work does not reintroduce direct dependency on deprecated column names.

## `LIKE ... ESCAPE '\'` and `standard_conforming_strings`

A migration that matches a literal underscore with `LIKE 'prefix\_%' ESCAPE '\'` (the two connector-purge migrations `20261122140000_purge_retired_accounting_settings` and `20261126120000_purge_retired_storefront_wms_settings`, and `20261107150000_erasure_raw_payload_projection`) reads `'\'` as a single backslash **only while `standard_conforming_strings` is `on`**. That is PostgreSQL's default since 9.1 and what every supported server (16 and 17) ships with. With it `off`, a backslash inside a plain string literal is an escape character, so `'\'` would swallow the closing quote and the statement would fail to parse (a loud failure, not a silent mis-match); `prisma migrate deploy` and the installer's own SQL (`scripts/install.sh` sets it `on`) run with it on. Applied migrations are not edited. A new migration that needs the pattern should either rely on the default as these do, or use `ESCAPE E'\\'`, which means the same under both settings.
