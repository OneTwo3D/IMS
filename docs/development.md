# Development Workflow

## Branch and PR Workflow

Use `development` as the integration branch for implementation work. Feature branches should be based on `development`, and pull requests should target `development` unless a human explicitly says otherwise. Do not use `main` as the implementation branch.

Before opening a PR, run:

```bash
npm run validate
```

`npm run validate` runs linting, TypeScript type-checking, Prisma client generation, unit/security tests, workflow documentation checks, and the Prisma schema scope check against `origin/development`.

For schema, migration, Prisma, or database behavior changes, also run:

```bash
npm run validate:db
```

For workflow or UI behavior changes, run the relevant Playwright coverage. Use the selector helper first when choosing focused e2e coverage:

```bash
npm run e2e:select
```

For GitHub Actions trigger or gating changes, validate both the static workflow checks and the event-specific behavior being changed. `npm run docs:workflows:check` does not simulate GitHub event payloads; push-trigger changes need either a real CI push run or focused tests that assert push and pull request event paths use the intended refs.

Inventory and accounting behavior changes must include focused tests. Keep server actions thin: use them for auth, input parsing, adapter work, revalidation, and redirects; put reusable business rules in `lib/domain/**` or `lib/jobs/**`. Do not commit secrets, credentials, OAuth tokens, webhook secrets, or private keys.

## Documentation Updates

Keep documentation in the same PR as the behavior it describes. When changing a feature, check the affected documentation surfaces and update every one that would become stale:

- `README.md` for high-level setup, feature, or support-entry changes
- `docs/development.md` for validation, branch workflow, guardrails, and agent workflow rules
- `docs/architecture.md` for model, invariant, accounting, inventory, WMS, connector, or transaction-boundary changes
- `docs/installation.md` and `.env.example` for configuration, deployment, secrets, storage, and connector setup changes
- connector/runbook docs such as `docs/woocommerce.md`, `docs/xero-sync.md`, `docs/woocommerce-live-runbook.md`, and WMS/Mintsoft docs for integration behavior changes
- `docs/workflows.md` and `npm run docs:workflows` when workflow state transitions change
- `help-docs/` when user-facing screens, labels, available actions, or support workflows change

If a code change intentionally has no documentation impact, state that in the PR summary or review response so reviewers do not have to infer it.

## Test Commands

Unit and security tests run through Node's test runner with `tsx`:

```bash
npm run test:unit
```

Focused tests can also be run directly:

```bash
npx tsx --test tests/<relevant-file>.test.ts
```

This repository treats `prisma/schema.prisma` as the canonical application schema. Migrations, deployment scripts, and CI all assume the Prisma schema and the live database describe the same shape unless a difference is intentionally documented as unsupported by Prisma.

## Decimal Boundary Guard

Guarded domain and accounting integration paths must not import `decimalToNumber` from `@/lib/decimal` unless the file carries an explicit boundary rationale comment:

```ts
// decimal-boundary-ok: display-only (UI serialization)
```

The guard is a first-line check for direct `decimalToNumber` imports. It runs in `npm run validate` and in the `Decimal Boundary Guard` GitHub Actions workflow through:

```bash
npm run check:decimal-boundaries
```

Guarded targets live in `scripts/decimal-boundary-targets.json`. The check fails if any configured target path or glob stops matching source files, so moved connector/domain code must update that config in the same PR.

The leading rationale token must be one of:

- `display-only`: conversion only serializes values for UI or API display payloads.
- `report-only`: conversion only builds diagnostics, invariant findings, or other read-only reports.
- `server-action-boundary`: conversion validates or normalizes user input at a server-action boundary before Decimal-safe domain logic.
- `legacy-pre-stage-4`: temporary Stage 4 tech debt. Keep the parenthetical specific and remove or narrow this token when the Decimal refactor for that path lands.

The comment is file-scoped rather than line-scoped so import formatting changes do not break validation. One file should use one leading rationale token; if a file appears to need mixed rationales, split the boundary or choose the stricter temporary rationale and explain the narrower cases in the parenthetical. This guard does not catch every Decimal-to-number bypass, such as direct `.toNumber()` calls or `Number(decimalValue)` on Decimal-typed values; those require a future typed-AST lint rule.

## Rounding Policy

IMS uses Decimal `ROUND_HALF_UP` for explicit money, quantity, and journal-total rounding. Money amounts round to the relevant ISO 4217 minor units, defaulting to 2 decimal places when no special minor-unit rule exists. Inventory quantities and FIFO/COGS unit values round only at explicit storage, payload, or report boundaries; internal domain calculations should keep `Prisma.Decimal` values until one of those boundaries is reached.

`Decimal.ROUND_HALF_UP` rounds negative midpoints away from zero, so it differs from JavaScript `Math.round` for values such as `-0.5` (`Math.round(-0.5) === -0`, while Decimal `ROUND_HALF_UP` returns `-1`). Use `roundMoney`, `roundQuantity`, or `Decimal.toDecimalPlaces(..., ROUND_HALF_UP)` for domain rounding rather than hand-written `Math.round(value * scale) / scale`.

Do not introduce half-even/banker's rounding unless a connector contract explicitly requires it, and document that connector-specific exception next to the adapter boundary.

Known exception: landed-cost retrospective journal totals intentionally preserve
the legacy JavaScript `Math.round` midpoint behavior so existing negative
half-cent adjustment idempotency keys remain stable. The landed-cost event-key
context still uses `ROUND_HALF_UP`; do not normalize the journal-total helper
without a migration plan for historical landed-cost adjustment keys.

## Schema Workflow

See `docs/migration-conventions.md` for the required rollout patterns for
`NOT NULL` add-columns, `NOT VALID` constraints, column renames, large-table
indexes, and column drops.

When changing the schema:

1. Update `prisma/schema.prisma`.
2. Generate the migration from Prisma where possible.
3. If you must hand-edit migration SQL, keep `prisma/schema.prisma` aligned in the same PR.
4. If you add a database feature Prisma cannot model directly, isolate it in a dedicated manual migration and add an allowlist entry to `prisma/unsupported-schema-drift-allowlist.json`.
5. Run the drift check against a migrated database before merging.

Migrations are append-only once merged. Do not edit an applied historical migration for a live or data-bearing environment; ship a follow-up migration instead. If a not-live remediation intentionally edits a historical migration, document the checksum impact in the PR and migration comment. Ephemeral development databases should be reset or recreated and migrated from scratch. Data-bearing development or staging databases need an explicit recovery plan after DBA review, because manually changing `_prisma_migrations.checksum` or marking migrations resolved can mask real drift if done incorrectly.

For large or live tables, avoid unbounded backfills followed by immediate `ALTER COLUMN ... SET NOT NULL` unless the deployment has an explicit maintenance window and row-count estimate. Prefer:

1. Add the new nullable column or nullable state.
2. Backfill in bounded batches where practical.
3. Add a `CHECK (<column> IS NOT NULL) NOT VALID` constraint.
4. Run `VALIDATE CONSTRAINT` after the backfill has completed.
5. Set the column `NOT NULL` using the validated constraint as evidence.
6. Drop the temporary check constraint when the real `NOT NULL` is in place.

Historical migrations in not-live installs may use the simpler blocking form when the PR explains why the table size and environment make that acceptable.

Recommended local commands:

```bash
bash scripts/prisma-dev-db.sh generate
bash scripts/prisma-dev-db.sh deploy
bash scripts/prisma-dev-db.sh status
bash scripts/prisma-dev-db.sh diff
node scripts/check-prisma-drift.mjs
```

The helper script loads `DATABASE_URL` from `.env.local` or `.env` and uses the repo's `prisma.config.ts` setup consistently.

## Stock Quantity Constraint Preflight

Migration `20260512100000_stock_quantity_check_constraints` fails fast when historical rows already violate the stock and FIFO quantity checks.

Interpret the preflight counters as follows:

- `negative_stock_quantity`:
  inventory invariant finding `stock_negative_quantity`
- `negative_stock_reserved`:
  inventory invariant finding `stock_negative_reserved_quantity`
- `negative_cost_layer_received`:
  inventory invariant finding `cost_layer_negative_received_quantity`
- `negative_cost_layer_remaining`:
  inventory invariant finding `cost_layer_negative_remaining_quantity`
- `cost_layer_remaining_over_received`:
  inventory invariant finding `cost_layer_remaining_exceeds_received`
- `negative_stock_movement_qty`:
  inventory invariant finding `stock_movement_negative_quantity`

Recommended response order:

1. Run the inventory invariant report to identify stock-level and cost-layer drift.
2. Query the raw tables behind any reported counts if you need row-level repair detail beyond the invariant report.
3. Repair the underlying rows before rerunning `prisma migrate deploy`.

## Sandbox Note

Prisma 7 schema-engine commands such as `migrate status`, `migrate diff`, `db pull`, and `db execute` open a real TCP connection to PostgreSQL. When they run inside a restricted sandbox, they can fail with `P1001: Can't reach database server` even if Postgres is healthy.

If `psql` and `prisma migrate deploy` work but `migrate status` or `db pull` report `P1001`, treat that as an execution-environment problem first, not a database outage. Run the helper script from a normal shell, or run the Prisma command outside the sandbox.

## Guardrails

The repo now enforces six rules:

1. A PR that changes `prisma/migrations/` must also change `prisma/schema.prisma`, unless every changed `migration.sql` is schema-invisible DB-native SQL with an explicit lowercase SQL line-comment marker: `-- prisma-schema-scope-ok: db-native ...`.
2. CI deploys migrations into a fresh PostgreSQL instance and fails if the resulting database differs from `prisma/schema.prisma`.
3. Deployment scripts print the actual drift instead of failing silently.
4. Hand-written migration SQL is allowed only when reviewed explicitly and mirrored back into `prisma/schema.prisma`; unsupported DB-native features such as triggers and CHECK predicates that Prisma cannot represent must carry the schema-scope marker and drift allowlist rationale.
5. The PR template includes a schema checklist.
6. Unsupported database features must be isolated and recorded in `prisma/unsupported-schema-drift-allowlist.json`.

## Scripts

- `node scripts/check-prisma-schema-scope.mjs <base> <head>`
  Fails when migration files change without a matching `prisma/schema.prisma` update, except for migration SQL that explicitly documents a schema-invisible DB-native change with a lowercase `-- prisma-schema-scope-ok: db-native ...` line-comment marker. Non-SQL notes in migration directories are ignored by this guard.

- `node scripts/check-prisma-drift.mjs`
  Runs `prisma migrate diff` against the configured datasource, suppresses only explicitly allowlisted unsupported differences, and prints the full drift when validation fails.

## Auth Rate Limiting

Login, TOTP verification, and supplier quote throttling use the shared rate-limit backend in `lib/security/rate-limit.ts`.

Local and single-process installs default to the in-memory backend:

```env
RATE_LIMIT_BACKEND=memory
```

Clustered deployments can use Redis without adding application code changes:

```env
RATE_LIMIT_BACKEND=redis
REDIS_URL=redis://localhost:6379/0
```

When Redis is selected, `REDIS_URL` must be configured. The Redis backend uses a single atomic sorted-set script for check-and-record decisions and clears buckets on successful authentication just like the memory backend.

If the configured backend fails, auth throttling fails open and writes a warning activity log. This keeps login and TOTP available during Redis outages while making the degraded protection visible to operators.

## Allowlisted Unsupported Features

`prisma/unsupported-schema-drift-allowlist.json` must stay small and intentional.

Use it only when:

- the database feature cannot be represented in Prisma today
- the change is isolated in a dedicated manual migration
- the PR explains why the allowlist entry exists

Do not use the allowlist to hide ordinary schema drift.
