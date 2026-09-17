#!/usr/bin/env bash
set -euo pipefail

npm run db:migrate:status
npm run db:schema:diff
npm run db:schema:drift
node scripts/check-stock-quantity-constraints.mjs
npm run db:generate

# THE CONCURRENCY TIER NEEDS A DATABASE IT MAY DESTROY, and says so rather than failing at
# the end of every ordinary local run (o3d-zzgp r6). Two of its files seed rows and install
# DDL, so tests/concurrency/scratch-database-guard.ts refuses any database that is not
# stamped disposable AND named in IMS_CONCURRENCY_SCRATCH_DB -- which the ordinary local
# DATABASE_URL (onetwo3d_ims_dev) is not, and must not be.
#
# CI dependency: .github/workflows/schema-guardrails.yml (job `fresh-db-drift`) runs this
# same suite on every PR that touches tests/concurrency, DB validation, schema, or
# migration files, against a per-run postgres service database that the job stamps and
# declares. So the suite IS gated on every such PR; what this script decides is only
# whether it also runs here.
if [ -n "${IMS_CONCURRENCY_SCRATCH_DB:-}" ]; then
  npm run test:concurrency
else
  echo
  echo "SKIPPED: npm run test:concurrency"
  echo "  It seeds rows and installs DDL, so it runs only against a scratch database."
  echo "  To run it here: create one, migrate it, then"
  echo "      DATABASE_URL=<scratch url> npm run db:stamp-scratch"
  echo "      export IMS_CONCURRENCY_SCRATCH_DB=<scratch database name>"
  echo "  See docs/development.md, 'Database-backed tiers'. CI runs it on every PR regardless."
fi
