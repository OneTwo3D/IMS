#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f ".env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.local"
  set +a
elif [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Define it in .env.local or .env." >&2
  exit 1
fi

command="${1:-}"
shift || true

case "${command}" in
  status)
    exec npx prisma migrate status "$@"
    ;;
  deploy)
    exec npx prisma migrate deploy "$@"
    ;;
  diff)
    exec npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code "$@"
    ;;
  db-pull)
    exec npx prisma db pull --print "$@"
    ;;
  generate)
    exec npx prisma generate "$@"
    ;;
  *)
    cat >&2 <<'EOF'
Usage: bash scripts/prisma-dev-db.sh <command>

Commands:
  status    Run prisma migrate status against the configured dev database
  deploy    Run prisma migrate deploy against the configured dev database
  diff      Compare the configured dev database against prisma/schema.prisma
  db-pull   Print the live schema from the configured dev database
  generate  Regenerate the Prisma client
EOF
    exit 1
    ;;
esac
