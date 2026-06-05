#!/usr/bin/env bash
set -euo pipefail

npm run db:migrate:status
npm run db:schema:diff
npm run db:schema:drift
node scripts/check-stock-quantity-constraints.mjs
# CI dependency: .github/workflows/schema-guardrails.yml runs this same
# concurrency suite against the fresh migrated Postgres database on every PR
# that touches tests/concurrency, DB validation, schema, or migration files.
npm run db:generate
npm run test:concurrency
