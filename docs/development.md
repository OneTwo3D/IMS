# Development Workflow

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
npx prisma generate --schema prisma/schema.prisma
npx prisma migrate deploy --schema prisma/schema.prisma
node scripts/check-prisma-drift.mjs
```

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

## Allowlisted Unsupported Features

`prisma/unsupported-schema-drift-allowlist.json` must stay small and intentional.

Use it only when:

- the database feature cannot be represented in Prisma today
- the change is isolated in a dedicated manual migration
- the PR explains why the allowlist entry exists

Do not use the allowlist to hide ordinary schema drift.
