#!/usr/bin/env bash
set -euo pipefail

schema_scope_base_ref="${SCHEMA_SCOPE_BASE_REF:-origin/development}"
schema_scope_head_ref="${SCHEMA_SCOPE_HEAD_REF:-HEAD}"

npm run lint
npm run type-check
npm run check:decimal-boundaries
npm run check:connector-fetch-boundaries
npm run check:migration-conventions
# Use direct Prisma generate so the baseline does not require DATABASE_URL.
npx prisma generate --schema prisma/schema.prisma
# o3d-hic9: the Server Action authorization guards were in check:all but in no CI
# workflow, so they only ran when someone remembered to type check:all locally.
# validate-local.sh exists so local and CI run the same policy, so they belong here
# too. They are ALSO run by .github/workflows/server-action-auth-guard.yml, which is
# ungated — the validate job that runs this script is conditional on
# classify_changes.run_expensive, and a security gate should not be skippable.
npm run check:server-action-guards
npm run test:unit
npm run docs:workflows:check
npm run db:schema:scope -- "${schema_scope_base_ref}" "${schema_scope_head_ref}"
