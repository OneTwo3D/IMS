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
bash scripts/prisma-dev-db.sh generate
bash scripts/prisma-dev-db.sh deploy
bash scripts/prisma-dev-db.sh status
bash scripts/prisma-dev-db.sh diff
node scripts/check-prisma-drift.mjs
```

The helper script loads `DATABASE_URL` from `.env.local` or `.env` and uses the repo's `prisma.config.ts` setup consistently.

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

## Allowlisted Unsupported Features

`prisma/unsupported-schema-drift-allowlist.json` must stay small and intentional.

Use it only when:

- the database feature cannot be represented in Prisma today
- the change is isolated in a dedicated manual migration
- the PR explains why the allowlist entry exists

Do not use the allowlist to hide ordinary schema drift.
