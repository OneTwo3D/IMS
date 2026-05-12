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

Inventory and accounting behavior changes must include focused tests. Keep server actions thin: use them for auth, input parsing, adapter work, revalidation, and redirects; put reusable business rules in `lib/domain/**` or `lib/jobs/**`. Do not commit secrets, credentials, OAuth tokens, webhook secrets, or private keys.

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

## Schema Workflow

When changing the schema:

1. Update `prisma/schema.prisma`.
2. Generate the migration from Prisma where possible.
3. If you must hand-edit migration SQL, keep `prisma/schema.prisma` aligned in the same PR.
4. If you add a database feature Prisma cannot model directly, isolate it in a dedicated manual migration and add an allowlist entry to `prisma/unsupported-schema-drift-allowlist.json`.
5. Run the drift check against a migrated database before merging.

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
  no current invariant finding; inspect `cost_layers` rows where `"receivedQty" < 0`
- `negative_cost_layer_remaining`:
  inventory invariant finding `cost_layer_negative_remaining_quantity`
- `cost_layer_remaining_over_received`:
  inventory invariant finding `cost_layer_remaining_exceeds_received`
- `negative_stock_movement_qty`:
  no current invariant finding; inspect `stock_movements` rows where `qty < 0`

Recommended response order:

1. Run the inventory invariant report to identify stock-level and cost-layer drift.
2. Query the raw tables for `negative_cost_layer_received` and `negative_stock_movement_qty`, because those are not yet surfaced by the invariant report.
3. Repair the underlying rows before rerunning `prisma migrate deploy`.

## Sandbox Note

Prisma 7 schema-engine commands such as `migrate status`, `migrate diff`, `db pull`, and `db execute` open a real TCP connection to PostgreSQL. When they run inside a restricted sandbox, they can fail with `P1001: Can't reach database server` even if Postgres is healthy.

If `psql` and `prisma migrate deploy` work but `migrate status` or `db pull` report `P1001`, treat that as an execution-environment problem first, not a database outage. Run the helper script from a normal shell, or run the Prisma command outside the sandbox.

## Guardrails

The repo now enforces six rules:

1. A PR that changes `prisma/migrations/` must also change `prisma/schema.prisma`.
2. CI deploys migrations into a fresh PostgreSQL instance and fails if the resulting database differs from `prisma/schema.prisma`.
3. Deployment scripts print the actual drift instead of failing silently.
4. Hand-written migration SQL is allowed only when reviewed explicitly and mirrored back into `prisma/schema.prisma`.
5. The PR template includes a schema checklist.
6. Unsupported database features must be isolated and recorded in `prisma/unsupported-schema-drift-allowlist.json`.

## Scripts

- `node scripts/check-prisma-schema-scope.mjs <base> <head>`
  Fails when migration files change without a matching `prisma/schema.prisma` update.

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
