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

run_as_user() {
  local user="$1"
  shift
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$user" -- "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$user" "$@"
  else
    su -s /bin/bash -c "$(printf '%q ' "$@")" "$user"
  fi
}

run_git_as_user() {
  local user="$1"
  shift

  if [[ "${GIT_DEPLOY_KEY_ENABLED:-n}" == "y" ]]; then
    [[ -f "${DEPLOY_SSH_KEY_PATH}" ]] || die "Missing deploy key: ${DEPLOY_SSH_KEY_PATH}"
    [[ -f "${DEPLOY_SSH_KNOWN_HOSTS}" ]] || die "Missing deploy known_hosts: ${DEPLOY_SSH_KNOWN_HOSTS}"

    run_as_user "${user}" env \
      "GIT_SSH_COMMAND=ssh -i ${DEPLOY_SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${DEPLOY_SSH_KNOWN_HOSTS}" \
      "$@"
  else
    run_as_user "${user}" "$@"
  fi
}

APP_NAME="one-two-inventory"
APP_USER="imsapp"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
BACKUP_DIR="/var/backups/${APP_NAME}"
DEPLOY_META_FILE="${APP_DIR}/.deploy-meta"
DEPLOY_SSH_DIR="${DATA_DIR}/git-ssh"
DEPLOY_SSH_KEY_PATH="${DEPLOY_SSH_DIR}/id_ed25519"
DEPLOY_SSH_KNOWN_HOSTS="${DEPLOY_SSH_DIR}/known_hosts"

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
if [[ -f "${DEPLOY_META_FILE}" ]]; then
  set -a; source "${DEPLOY_META_FILE}"; set +a
fi

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

  if [[ -d "${APP_DIR}/.git" ]]; then
    CURRENT_COMMIT="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)"
    CURRENT_BRANCH="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD)"
    info "Current commit: ${CURRENT_COMMIT:0:8}"

    run_git_as_user "${APP_USER}" git -C "${APP_DIR}" fetch origin
    run_git_as_user "${APP_USER}" git -C "${APP_DIR}" reset --hard "origin/${CURRENT_BRANCH}"

    NEW_COMMIT="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)"
    info "Updated to:     ${NEW_COMMIT:0:8}"

    if [[ "$CURRENT_COMMIT" == "$NEW_COMMIT" ]]; then
      warn "Already up to date. Continuing anyway (migrations/restart may still be needed)."
    else
      echo ""
      info "Changes in this update:"
      run_git_as_user "${APP_USER}" git -C "${APP_DIR}" log \
        --oneline "${CURRENT_COMMIT}..${NEW_COMMIT}" | head -20
    fi
  else
    [[ -n "${GIT_REPO_URL:-}" ]] || die "No git checkout and no GIT_REPO_URL in ${DEPLOY_META_FILE}. Use --no-git to skip."
    GIT_BRANCH="${GIT_BRANCH:-main}"

    TMP_CLONE_DIR="$(mktemp -d -t ims-update.XXXXXX)"
    TMP_CLONE_WORKTREE="${TMP_CLONE_DIR}/repo"
    chown "${APP_USER}:${APP_USER}" "${TMP_CLONE_DIR}"
    CURRENT_COMMIT="none"

    info "Cloning ${GIT_REPO_URL} (${GIT_BRANCH}) into a temporary worktree..."
    run_git_as_user "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
      "${GIT_REPO_URL}" "${TMP_CLONE_WORKTREE}"
    NEW_COMMIT="$(run_git_as_user "${APP_USER}" git -C "${TMP_CLONE_WORKTREE}" rev-parse HEAD)"
    info "Fetched commit: ${NEW_COMMIT:0:8}"

    rsync -a --delete \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='.next' \
      --exclude='.env' \
      --exclude='.env.local' \
      --exclude='backups' \
      --exclude='uploads' \
      --exclude='public/uploads' \
      "${TMP_CLONE_WORKTREE%/}/" "${APP_DIR}/"
    rm -rf "${APP_DIR}/.git"
    cp -a "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"
    chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
    rm -rf "${TMP_CLONE_DIR}"
    success "Repository synced into existing app directory."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Install / update dependencies
# ---------------------------------------------------------------------------
if ! $SKIP_BUILD; then
  header "Installing dependencies"

  run_as_user "${APP_USER}" npm ci --include=dev --prefix "${APP_DIR}" 2>&1 | \
    grep -v "^npm warn" || true
  success "Dependencies updated."
fi

# ---------------------------------------------------------------------------
# 4. Run database migrations
# ---------------------------------------------------------------------------
header "Running database migrations"

cd "${APP_DIR}"
run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Migrations applied."

header "Validating database schema"

run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null
success "Database schema matches prisma/schema.prisma."

# ---------------------------------------------------------------------------
# 5. Build
# ---------------------------------------------------------------------------
if ! $SKIP_BUILD; then
  header "Building Next.js application"

  run_as_user "${APP_USER}" npm run build --prefix "${APP_DIR}"
  success "Build complete."
fi

# ---------------------------------------------------------------------------
# 6. Restart processes
# ---------------------------------------------------------------------------
header "Restarting application"

systemctl restart "${APP_NAME}.service"
success "Application service restarted."

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
  warn "Check logs: journalctl -u ${APP_NAME}.service -n 100"
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

header "Update complete (${ELAPSED}s)"
echo -e "  ${BOLD}systemctl status ${APP_NAME}.service${RESET}  — check service health"
echo -e "  ${BOLD}journalctl -u ${APP_NAME}.service -f${RESET}  — view live logs"
echo ""
echo -e "${GREEN}Done.${RESET}"
