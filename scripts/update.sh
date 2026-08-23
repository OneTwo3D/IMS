#!/usr/bin/env bash
# =============================================================================
# onetwoInventory — Update / Redeploy Script
# =============================================================================
# Run as root on the production server to update to the latest version.
#
# DEPLOY ORDER (o3d-2sm1.1):
#
#   build -> validate -> STOP AND DRAIN EVERY WRITER -> migrate -> verify -> start
#
# This script used to migrate first and build second, which left the OLD version
# serving the MIGRATED schema for the whole length of a build. Every safety argument
# of the form "the new code is what writes to the new column" is false for that
# window, and two migrations measured what it costs: one where the old binary's retry
# CLEARS the accounting invariant's only bound (unrecoverable), and one where the old
# binary OVERWRITES an already-stamped row (neither repairable nor detectable — the
# migration's own verification queries return zero while the damage stands).
#
# That second case is why quiescence cannot be a post-hoc check. Verification catches
# an old binary that CREATED rows; nothing catches one that OVERWROTE them. Stopping
# the writer first is the only defence.
#
# WRITERS, and "drained" means STOPPED, not idle:
#   1. the service                  (systemctl stop, before anything migrates)
#   2. the cron entries             (crontab -u $APP_USER — the easy ones to forget:
#                                    nothing runs between ticks, but each tick drives
#                                    a queue worker. Fenced, then restored verbatim.)
#   3. anything else still attached (scripts/check-db-writers.mjs asks Postgres, so a
#                                    writer nobody enumerated still blocks the migration)
#
# ON A POST-STOP FAILURE THE OLD VERSION STAYS DOWN. Restarting it against a migrated
# schema is the window this order exists to close. Fix and re-run — every step is
# idempotent and a re-run adopts the fence.
#
# Usage:
#   bash update.sh              # pull latest from git and redeploy
#   bash update.sh --dry-run    # print the plan; change nothing
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
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --no-git)     NO_GIT=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --dry-run)    DRY_RUN=true ;;
    --help)
      echo "Usage: bash update.sh [--no-git] [--skip-build] [--dry-run]"
      echo "  --no-git      Skip git pull (use current source files)"
      echo "  --skip-build  Skip npm build (run migrations + restart only)"
      echo "  --dry-run     Print the plan and change nothing"
      exit 0
      ;;
  esac
done

[[ -d "$APP_DIR" ]] || die "App directory ${APP_DIR} not found. Run install.sh first."
[[ -f "${APP_DIR}/.env" ]] || die ".env not found. Run install.sh first."

# Load env for DATABASE_URL
set -a; source "${APP_DIR}/.env"; set +a
if [[ -f "${DEPLOY_META_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090  # path is composed at runtime from APP_DIR
  source "${DEPLOY_META_FILE}"
  set +a
fi

START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# Fence bookkeeping (o3d-2sm1.1).
#
# FENCE_ARMED means: from here on, nothing in this script restarts what it stopped.
# A "rollback" that brings the old version back up against a MIGRATED schema is the
# exact window this order exists to close, so on a post-stop failure the correct
# state is DOWN — and, when a migration was attempted, masked, so a reboot does not
# quietly undo it. Fix the cause and re-run: every step below is idempotent.
# ---------------------------------------------------------------------------
FENCE_ARMED=false
FENCE_MASK=false
DEPLOY_OK=false
CRON_FENCED=false
CURRENT_STEP="startup"
FENCE_FILE="${DATA_DIR}/DEPLOY-FENCED"
CRON_BACKUP="${DATA_DIR}/crontab-${APP_USER}.bak"

run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: $*"
    return 0
  fi
  "$@"
}

on_exit() {
  local status=$?
  $DEPLOY_OK && exit 0

  if $FENCE_ARMED; then
    echo ""
    echo -e "${RED}${BOLD}=======================================================================${RESET}"
    echo -e "${RED}${BOLD} UPDATE FAILED AFTER THE STOP — THE OLD VERSION IS NOT BEING RESTARTED${RESET}"
    echo -e "${RED}${BOLD}=======================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    if $FENCE_MASK; then
      echo -e "  schema      : a migration was attempted; the database may be MIGRATED"
      echo -e "                while nothing is serving. That is the intended safe state."
      echo -e "  restore     : ${BACKUP_FILE:-<no pre-migration backup was taken>}"
    fi
    echo -e "  service     : STOPPED, and left that way on purpose."
    echo -e "  cron        : ${APP_USER} entries left FENCED (commented out)."
    echo ""
    echo -e "  Do NOT start ${APP_NAME}.service by hand. Fix the cause and re-run this"
    echo -e "  script; it adopts this fence and every step is idempotent."
    echo -e "  State: ${FENCE_FILE}"
    echo ""

    if ! $DRY_RUN; then
      mkdir -p "${DATA_DIR}"
      {
        echo "fenced_at=$(date -Iseconds)"
        echo "failed_step=${CURRENT_STEP}"
        echo "exit_status=${status}"
        echo "migration_attempted=${FENCE_MASK}"
        echo "pre_migration_backup=${BACKUP_FILE:-none}"
        echo "cron_backup=${CRON_BACKUP}"
      } > "${FENCE_FILE}"
      chmod 600 "${FENCE_FILE}"

      systemctl stop "${APP_NAME}.service" >/dev/null 2>&1 || true
      if $FENCE_MASK; then
        systemctl mask "${APP_NAME}.service" >/dev/null 2>&1 || true
      fi
    fi
  fi

  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The cron entries are writers too, and they are the ones that get forgotten: nothing
# is running between ticks, so the box looks quiet right up until a sweeper wakes up
# mid-migration. The whole crontab is fenced, not just the managed block — an
# operator line can drive the app just as well as ours can — and it is restored
# VERBATIM from a backup that is taken once and kept until a run finishes, so a
# re-run after a failure restores the original rather than a fenced copy.
fence_cron() {
  command -v crontab >/dev/null 2>&1 || return 0

  local current active
  current="$(crontab -u "${APP_USER}" -l 2>/dev/null || true)"
  [[ -n "$current" ]] || { info "No crontab for ${APP_USER}."; return 0; }

  active="$(printf '%s\n' "$current" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "$active" -eq 0 ]]; then
    CRON_FENCED=true
    return 0
  fi

  info "Fencing ${active} active line(s) in the ${APP_USER} crontab."
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would back up to ${CRON_BACKUP} and comment those lines out"
    CRON_FENCED=true
    return 0
  fi

  mkdir -p "${DATA_DIR}"
  if [[ ! -f "${CRON_BACKUP}" ]]; then
    printf '%s\n' "$current" > "${CRON_BACKUP}"
    chmod 600 "${CRON_BACKUP}"
  fi
  printf '%s\n' "$current" \
    | awk '{ if ($0 ~ /^[[:space:]]*[^#[:space:]]/) print "#DEPLOY-FENCE# " $0; else print $0 }' \
    | crontab -u "${APP_USER}" -
  CRON_FENCED=true
  success "Cron writers fenced."
}

unfence_cron() {
  $CRON_FENCED || return 0
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would restore the ${APP_USER} crontab verbatim from ${CRON_BACKUP}"
    return 0
  fi
  [[ -f "${CRON_BACKUP}" ]] || return 0
  crontab -u "${APP_USER}" "${CRON_BACKUP}"
  rm -f "${CRON_BACKUP}"
  success "Cron writers restored verbatim."
}

# ---------------------------------------------------------------------------
# @deploy-phase: preflight
# ---------------------------------------------------------------------------
CURRENT_STEP="preflight"
header "Preflight"

if [[ -f "${FENCE_FILE}" ]]; then
  warn "Adopting an existing fence — a previous run stopped here:"
  sed 's/^/         /' "${FENCE_FILE}"
  warn "Continuing; every step is idempotent."
fi

if ! $DRY_RUN; then
  mkdir -p "${DATA_DIR}"
  exec 9>"${DATA_DIR}/update.lock"
  flock -n 9 || die "Another update holds ${DATA_DIR}/update.lock. Refusing to run two cutovers at once."
fi

if ! $NO_GIT; then
  header "Pulling latest code from git"

  if [[ -d "${APP_DIR}/.git" ]]; then
    CURRENT_COMMIT="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)"
    CURRENT_BRANCH="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD)"
    info "Current commit: ${CURRENT_COMMIT:0:8}"

    run run_git_as_user "${APP_USER}" git -C "${APP_DIR}" fetch origin
    run run_git_as_user "${APP_USER}" git -C "${APP_DIR}" reset --hard "origin/${CURRENT_BRANCH}"

    NEW_COMMIT="$(run_git_as_user "${APP_USER}" git -C "${APP_DIR}" rev-parse HEAD)"
    info "Updated to:     ${NEW_COMMIT:0:8}"

    if [[ "$CURRENT_COMMIT" == "$NEW_COMMIT" ]]; then
      warn "Already up to date. Continuing anyway (migrations/restart may still be needed)."
    else
      echo ""
      info "Changes in this update:"
      run_git_as_user "${APP_USER}" git -C "${APP_DIR}" log \
        --oneline --max-count 20 "${CURRENT_COMMIT}..${NEW_COMMIT}"
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
      --exclude='.deploy-meta' \
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
# @deploy-phase: build
#
# FIRST, while the old version is still up and still serving the schema it was
# written against. This is the long step, and running it after the migration — which
# is what this script used to do — is precisely what left the predecessor writing
# into a schema it had never heard of for minutes at a time.
# ---------------------------------------------------------------------------
CURRENT_STEP="build"
if ! $SKIP_BUILD; then
  header "Installing dependencies and building (old version still serving)"

  run run_as_user "${APP_USER}" npm ci --include=dev --prefix "${APP_DIR}"
  success "Dependencies updated."
fi

cd "${APP_DIR}"

header "Generating Prisma client"
run run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma generate --schema "${APP_DIR}/prisma/schema.prisma"
success "Prisma client generated."

if ! $SKIP_BUILD; then
  header "Building the application"
  run run_as_user "${APP_USER}" npm run build --prefix "${APP_DIR}"
  success "Build complete."
fi

# ---------------------------------------------------------------------------
# @deploy-phase: validate
#
# Everything that can reject this release must reject it HERE, while the old version
# is still up and the schema is untouched. A failure below this line costs an outage;
# a failure above it costs nothing.
# ---------------------------------------------------------------------------
CURRENT_STEP="validate"
header "Validating the artefact"

if ! $SKIP_BUILD && ! $DRY_RUN; then
  [[ -f "${APP_DIR}/.next/BUILD_ID" ]] || die ".next/BUILD_ID missing after build — refusing to stop a working server for an artefact that is not there."
  info "New BUILD_ID: $(cat "${APP_DIR}/.next/BUILD_ID")"
fi

VERIFY_COUNT=$(find "${APP_DIR}/prisma/migrations" -mindepth 2 -maxdepth 2 -name 'verify.sql' -type f 2>/dev/null | wc -l)
info "Migrations declaring a post-migration verification: ${VERIFY_COUNT}"
success "Artefact validated."

# ---------------------------------------------------------------------------
# @deploy-phase: fence-writers
# ---------------------------------------------------------------------------
CURRENT_STEP="fence-writers"
header "Stopping and draining every writer"

FENCE_ARMED=true
FENCE_MASK=true

fence_cron

info "Stopping ${APP_NAME}.service"
run systemctl stop "${APP_NAME}.service"
success "Service stopped."

# ---------------------------------------------------------------------------
# @deploy-phase: drain-verify
#
# "Drained" means STOPPED, not idle, and the database is the only authority on that.
# An enumeration of writers is a guess about the box; pg_stat_activity is the answer.
# ---------------------------------------------------------------------------
CURRENT_STEP="drain-verify"
header "Proving the writers are gone"

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-db-writers.mjs"
else
  run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
    node "${APP_DIR}/scripts/check-db-writers.mjs" \
    || die "Another client is still connected to the database. Stop it and re-run; nothing has been migrated."
  success "No other client backends on the database."
fi

# ---------------------------------------------------------------------------
# @deploy-phase: migrate
#
# Nothing is serving. This is the only moment at which the schema may move — and it
# is also the only moment at which a backup is an exact restore point, which is why
# the pre-update dump is taken HERE rather than before the build. It costs downtime;
# a dump taken minutes earlier costs the writes made in between.
# ---------------------------------------------------------------------------
CURRENT_STEP="migrate"
header "Pre-migration database backup (nothing is serving)"

BACKUP_FILE="${BACKUP_DIR}/pre-update-$(date +%Y%m%d-%H%M%S).sql.gz"
if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would pg_dump to ${BACKUP_FILE}"
else
  mkdir -p "${BACKUP_DIR}"
  info "Backing up database to ${BACKUP_FILE}..."
  pg_dump "${DATABASE_URL}" | gzip > "${BACKUP_FILE}"
  success "Backup saved: ${BACKUP_FILE}"
  ls -t "${BACKUP_DIR}"/pre-update-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --
fi

header "Running database migrations"
run run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Migrations applied."

header "Validating database schema"
run run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  node "${APP_DIR}/scripts/check-prisma-drift.mjs"
success "Database schema matches prisma/schema.prisma."

# ---------------------------------------------------------------------------
# @deploy-phase: verify-migrations
#
# A migration declares its checks in prisma/migrations/<name>/verify.sql; every one
# must return zero before the new version is allowed to serve. See
# scripts/run-migration-verifications.mjs for the contract.
# ---------------------------------------------------------------------------
CURRENT_STEP="verify-migrations"
header "Running the migrations' own verification checks"

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/run-migration-verifications.mjs"
else
  run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
    node "${APP_DIR}/scripts/run-migration-verifications.mjs" \
    || die "A migration's verification check did not return zero. The new version has NOT been started."
  success "All declared verification checks returned zero."
fi

# ---------------------------------------------------------------------------
# @deploy-phase: start
# ---------------------------------------------------------------------------
CURRENT_STEP="start"
header "Starting the new version"

run systemctl unmask "${APP_NAME}.service" >/dev/null 2>&1 || true
run systemctl start "${APP_NAME}.service"
success "Application service started."

# ---------------------------------------------------------------------------
# @deploy-phase: health
# ---------------------------------------------------------------------------
CURRENT_STEP="health"
header "Health check"

APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo "3000")

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would poll http://127.0.0.1:${APP_PORT}/api/health"
else
  READY=false
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
      READY=true
      break
    fi
    sleep 1
  done
  if ! $READY; then
    journalctl -u "${APP_NAME}.service" -n 60 --no-pager >&2 || true
    die "The new version did not answer /api/health within 60s. Leaving it stopped rather than restoring the old one."
  fi
  success "Health check passed — app is responding."
fi

# Cron goes back last, and only once the new version has answered: restoring the
# queue workers before that would hand them to a server that may still fail.
unfence_cron
run rm -f "${FENCE_FILE}"

DEPLOY_OK=true
FENCE_ARMED=false

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

if $DRY_RUN; then
  header "Dry run complete (${ELAPSED}s) — nothing was changed"
else
  header "Update complete (${ELAPSED}s)"
fi
echo -e "  ${BOLD}systemctl status ${APP_NAME}.service${RESET}  — check service health"
echo -e "  ${BOLD}journalctl -u ${APP_NAME}.service -f${RESET}  — view live logs"
echo ""
echo -e "${GREEN}Done.${RESET}"
