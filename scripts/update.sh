#!/usr/bin/env bash
# =============================================================================
# onetwoInventory — Update / Redeploy Script
# =============================================================================
# Run as root on the production server to update to the latest version.
#
# Usage:
#   bash update.sh              # pull latest from git and redeploy
#   bash update.sh --no-git     # skip git pull (use current files)
#   bash update.sh --skip-build # skip npm build (migrations + restart only)
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

header() {
  echo ""
  echo -e "${BOLD}${BLUE}============================================================${RESET}"
  echo -e "${BOLD}${BLUE}  $*${RESET}"
  echo -e "${BOLD}${BLUE}============================================================${RESET}"
  echo ""
}

[[ $EUID -ne 0 ]] && die "Run as root: sudo bash update.sh"

APP_NAME="onetwoinventory"
APP_USER="imsapp"
APP_DIR="/opt/${APP_NAME}"
LOG_DIR="/var/log/${APP_NAME}"
BACKUP_DIR="/var/backups/${APP_NAME}"

NO_GIT=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --no-git)     NO_GIT=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --help)
      echo "Usage: bash update.sh [--no-git] [--skip-build]"
      echo "  --no-git      Skip git pull (use current source files)"
      echo "  --skip-build  Skip npm build (run migrations + restart only)"
      exit 0
      ;;
  esac
done

[[ -d "$APP_DIR" ]] || die "App directory ${APP_DIR} not found. Run install.sh first."
[[ -f "${APP_DIR}/.env" ]] || die ".env not found. Run install.sh first."

# Load env for DATABASE_URL
set -a; source "${APP_DIR}/.env"; set +a

START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# 1. Pre-update backup
# ---------------------------------------------------------------------------
header "Pre-update database backup"

mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/pre-update-$(date +%Y%m%d-%H%M%S).sql.gz"

info "Backing up database to ${BACKUP_FILE}..."
pg_dump "${DATABASE_URL}" | gzip > "${BACKUP_FILE}"
success "Backup saved: ${BACKUP_FILE}"

# Keep only the last 10 pre-update backups
ls -t "${BACKUP_DIR}"/pre-update-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --
info "Old pre-update backups pruned (keeping last 10)."

# ---------------------------------------------------------------------------
# 2. Pull latest code
# ---------------------------------------------------------------------------
if ! $NO_GIT; then
  header "Pulling latest code from git"

  [[ -d "${APP_DIR}/.git" ]] || die "Not a git repository. Use --no-git to skip."

  CURRENT_COMMIT=$(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)
  info "Current commit: ${CURRENT_COMMIT:0:8}"

  sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch origin
  sudo -u "${APP_USER}" git -C "${APP_DIR}" reset --hard "origin/$(git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD)"

  NEW_COMMIT=$(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)
  info "Updated to:     ${NEW_COMMIT:0:8}"

  if [[ "$CURRENT_COMMIT" == "$NEW_COMMIT" ]]; then
    warn "Already up to date. Continuing anyway (migrations/restart may still be needed)."
  else
    echo ""
    info "Changes in this update:"
    sudo -u "${APP_USER}" git -C "${APP_DIR}" log \
      --oneline "${CURRENT_COMMIT}..${NEW_COMMIT}" | head -20
  fi
fi

# ---------------------------------------------------------------------------
# 3. Install / update dependencies
# ---------------------------------------------------------------------------
if ! $SKIP_BUILD; then
  header "Installing dependencies"

  sudo -u "${APP_USER}" npm ci --prefix "${APP_DIR}" 2>&1 | \
    grep -v "^npm warn" || true
  success "Dependencies updated."
fi

# ---------------------------------------------------------------------------
# 4. Run database migrations
# ---------------------------------------------------------------------------
header "Running database migrations"

cd "${APP_DIR}"
sudo -u "${APP_USER}" DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Migrations applied."

# ---------------------------------------------------------------------------
# 5. Build
# ---------------------------------------------------------------------------
if ! $SKIP_BUILD; then
  header "Building Next.js application"

  sudo -u "${APP_USER}" npm run build --prefix "${APP_DIR}"
  success "Build complete."
fi

# ---------------------------------------------------------------------------
# 6. Restart processes
# ---------------------------------------------------------------------------
header "Restarting application"

pm2 restart "${APP_NAME}"        2>/dev/null || pm2 start "${APP_DIR}/ecosystem.config.js" --only "${APP_NAME}"
pm2 restart "${APP_NAME}-worker" 2>/dev/null || pm2 start "${APP_DIR}/ecosystem.config.js" --only "${APP_NAME}-worker"
pm2 save
success "Processes restarted."

# ---------------------------------------------------------------------------
# 7. Health check
# ---------------------------------------------------------------------------
header "Health check"

APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo "3000")
sleep 3

if curl -fsS --max-time 10 "http://127.0.0.1:${APP_PORT}/api/health" > /dev/null 2>&1; then
  success "Health check passed — app is responding."
else
  warn "Health check failed or /api/health not yet implemented."
  warn "Check logs: pm2 logs ${APP_NAME}"
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

header "Update complete (${ELAPSED}s)"
echo -e "  ${BOLD}pm2 status${RESET}           — check process health"
echo -e "  ${BOLD}pm2 logs ${APP_NAME}${RESET}  — view live logs"
echo -e "  ${BOLD}pm2 logs ${APP_NAME}-worker${RESET}  — view worker logs"
echo ""
echo -e "${GREEN}Done.${RESET}"
