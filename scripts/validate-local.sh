#!/usr/bin/env bash
set -euo pipefail

schema_scope_base_ref="${SCHEMA_SCOPE_BASE_REF:-origin/development}"
schema_scope_head_ref="${SCHEMA_SCOPE_HEAD_REF:-HEAD}"

npm run lint
npm run type-check
npm run check:decimal-boundaries
# Use direct Prisma generate so the baseline does not require DATABASE_URL.
npx prisma generate --schema prisma/schema.prisma
npm run test:unit
npm run docs:workflows:check
npm run db:schema:scope -- "${schema_scope_base_ref}" "${schema_scope_head_ref}"
