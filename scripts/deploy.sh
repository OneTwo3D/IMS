#!/usr/bin/env bash
# =============================================================================
# One Two Inventory — rebuild + cutover (stop-before-migrate)
# =============================================================================
# Builds the app, STOPS AND DRAINS EVERY WRITER, applies migrations, verifies
# them, and only then starts the new build.
#
#   build -> validate -> STOP AND DRAIN EVERY WRITER -> migrate -> verify -> start
#
# WHY THAT ORDER, AND NOT THE ONE THIS SCRIPT USED TO HAVE (o3d-2sm1.1).
#
# The previous order was: migrate, build, stop, start. It honoured "never run two
# SERVERS at once", and that part was never the problem. What it did not honour was
# the SCHEMA: the migration landed first and the build ran second, so the
# PREDECESSOR served the migrated schema for the entire length of a build — minutes
# on this box. Every safety argument of the form "the new code is what writes to the
# new column" is false for that window, and two migrations measured the cost:
#
#   * a refund-reversal witness column (o3d-2sm1): the old binary keeps inserting
#     rows without the column, and its own retry then CLEARS
#     `accounting_retry_required` — the accounting invariant's only bound. Once that
#     is cleared the row leaves every query that could find it again. Unrecoverable.
#
#   * a shopping-sync discriminator column (o3d-xnwu r8): the old binary still
#     selects held sales invoices by an operator-typed payload field, so it can
#     OVERWRITE an already-stamped row. Neither repairable nor detectable — the
#     migration's own verification queries return zero while the damage stands.
#
# The second case is why quiescence cannot be a post-hoc check. Verification catches
# an old binary that CREATED rows; nothing catches one that OVERWROTE them. Stopping
# the writer first is the only defence.
#
# AND STILL: NEVER RUN TWO VERSIONS AGAINST ONE DATABASE AT ONCE — no rolling restart,
# no blue/green overlap, no second instance left running on another port. That rule was
# always here and is unchanged; what this script adds is that the SCHEMA is not moved
# while either of them is up.
#
# THE PREDECESSOR STAYS FENCED OFF ON ANY POST-STOP FAILURE. A "rollback" that
# restarts the old process against a migrated schema puts us straight back into the
# window this order exists to close. If the new build will not start, the correct
# state is DOWN, and this script leaves it down (and, when a migration was applied,
# masks the unit so a reboot does not undo that). Fix and re-run — every step here is
# idempotent and a re-run adopts an existing fence.
#
# WHAT COUNTS AS A WRITER ON THIS BOX — stopped, not idle:
#   1. the web server                (systemd unit serving APP_DIR, auto-detected)
#   2. any stray next/npm process    (matched by /proc/<pid>/cwd == APP_DIR, so the
#                                     separate e2e instance on another port and
#                                     another database is never touched)
#   3. the app-managed cron entries  (crontab -u $APP_USER). These are the easy ones
#                                     to forget: nothing is running between ticks, but
#                                     each tick drives a queue worker — accounting
#                                     sync, the WooCommerce webhook inbox, the Mintsoft
#                                     sweeper, refund reservation release. They are
#                                     commented out for the window and restored
#                                     verbatim from a backup afterwards.
#   4. ANYTHING ELSE STILL CONNECTED — after 1-3 the script asks Postgres directly
#      (scripts/check-db-writers.mjs) and refuses to migrate while another client
#      backend holds a connection to the target database. That is the check that
#      catches the writer nobody enumerated: an ad-hoc `next dev` in a worktree, a
#      psql session, a script someone left running.
#
# A NOTE ON THIS PARTICULAR HOST. The stage unit runs `next dev` against the working
# tree, so the code being served changes when the tree changes, not when this script
# runs. That does not weaken the requirement — it changes which binary is dangerous.
# The migration must still be applied with NOTHING serving, because a server up
# across the migration is a server writing across it.
#
# MONEY POSTS ALREADY SURVIVED THE OLD ORDER, and it is worth knowing why they are
# not the reason for this change. Money posts stamp
# `accounting_sync_logs.remoteAttemptedAt` before the remote call, and whether that
# proof holds is recorded on the row in `attemptStampingCustodyAt`, so an overlap —
# or a ROLLBACK, which no deploy order can prevent — is discovered from the rows
# themselves and healed. See lib/domain/accounting/money-attempt-provenance.ts. That
# reasoning does NOT extend to the two migrations above: there the predecessor clears
# the bound rather than leaving an unstamped row behind, so there is nothing left for
# a later sweep to heal from. Hence the order.
#
# Usage:
#   bash scripts/deploy.sh                # build, stop, migrate, verify, start
#   bash scripts/deploy.sh --dry-run      # print the plan and the writers; change nothing
#   bash scripts/deploy.sh --skip-build   # stop, migrate, verify, start (no build)
#   bash scripts/deploy.sh --skip-migrate # build, stop, start (no migrate, no fence mask)
#   bash scripts/deploy.sh --restart-only # stop and start; no build, no migrate
#
# Run as root (it stops a systemd unit and edits another user's crontab). All npm /
# npx / node work is dropped to $APP_USER; nothing in this script runs npm as root.
# =============================================================================

set -euo pipefail

APP_DIR="${IMS_APP_DIR:-/root/ims/onetwo3d-ims}"
PORT="${IMS_PORT:-3000}"
STATE_DIR="${IMS_DEPLOY_STATE_DIR:-/var/lib/ims-deploy}"
LOCK_FILE="${STATE_DIR}/deploy.lock"
FENCE_FILE="${STATE_DIR}/FENCED"
LOG_FILE="${IMS_DEPLOY_LOG:-/tmp/oti-server.log}"
HEALTH_PATH="${IMS_HEALTH_PATH:-/login}"
HEALTH_TIMEOUT_SECONDS="${IMS_HEALTH_TIMEOUT_SECONDS:-120}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
info()  { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
step()  { echo -e "\n${BOLD}${BLUE}== $* ==${RESET}"; }
die()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

DRY_RUN=false
SKIP_BUILD=false
SKIP_MIGRATE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=true ;;
    --skip-build)   SKIP_BUILD=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    --restart-only) SKIP_BUILD=true; SKIP_MIGRATE=true ;;
    --help|-h)      sed -n '3,88p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

# `run` is the only way this script is allowed to change anything. --dry-run makes
# every mutation a print, which is what makes the flag safe to exercise on a live box.
run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: $*"
    return 0
  fi
  "$@"
}

[[ -d "$APP_DIR" ]]              || die "App directory not found: $APP_DIR"
[[ -f "$APP_DIR/package.json" ]] || die "Not a Next.js project: $APP_DIR/package.json missing"
APP_DIR_REAL="$(readlink -f "$APP_DIR")"
APP_USER="${IMS_APP_USER:-$(stat -c '%U' "$APP_DIR_REAL")}"
HEALTH_URL="http://127.0.0.1:${PORT}${HEALTH_PATH}"

# Every npm/npx/node call below is relative to the app directory (and dotenv reads
# ./.env), so make that the working directory once, here.
cd "$APP_DIR_REAL"

if [[ $EUID -ne 0 ]] && ! $DRY_RUN; then
  die "Run as root: it stops a systemd unit and rewrites the ${APP_USER} crontab. (--dry-run works unprivileged.)"
fi

as_app_user() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then
    "$@"
  else
    # HOME and the npm cache mirror the service unit's environment on purpose: a
    # build run with a different HOME writes a second next/npm cache and the box
    # is memory-tight enough for that to matter.
    runuser -u "$APP_USER" -- env \
      HOME="$APP_DIR_REAL" \
      NPM_CONFIG_CACHE="${APP_DIR_REAL}/.npm-cache" \
      "$@"
  fi
}

# ---------------------------------------------------------------------------
# Fence bookkeeping. FENCE_ARMED means "from here on, never restart the thing we
# stopped". FENCE_MASK additionally survives a reboot, and is only armed when a
# migration is actually going to be applied.
# ---------------------------------------------------------------------------
FENCE_ARMED=false
FENCE_MASK=false
DEPLOY_OK=false
CRON_FENCED=false
CURRENT_STEP="startup"
SERVICE_UNITS=()

CRON_BACKUP="${STATE_DIR}/crontab-${APP_USER}.bak"

on_exit() {
  local status=$?
  $DEPLOY_OK && exit 0

  if $FENCE_ARMED; then
    echo ""
    echo -e "${RED}${BOLD}=========================================================================${RESET}"
    echo -e "${RED}${BOLD} DEPLOY FAILED AFTER THE STOP — THE PREDECESSOR IS NOT BEING RESTARTED${RESET}"
    echo -e "${RED}${BOLD}=========================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    echo -e "  app         : ${APP_DIR_REAL} (port ${PORT})"
    if $FENCE_MASK; then
      echo -e "  schema      : a migration was attempted; the database may be MIGRATED"
      echo -e "                while nothing is serving. That is the intended safe state."
    fi
    if $FENCE_MASK; then
      echo -e "  service     : STOPPED and MASKED (so a reboot cannot start it either)"
    else
      echo -e "  service     : STOPPED"
    fi
    echo -e "  cron        : ${APP_USER} entries left FENCED (commented out)"
    echo ""
    echo -e "  Do NOT start the old process. Fix the cause and re-run this script —"
    echo -e "  every step is idempotent and the re-run adopts this fence."
    echo -e "  State: ${FENCE_FILE}"
    echo ""

    if ! $DRY_RUN; then
      mkdir -p "$STATE_DIR"
      {
        echo "fenced_at=$(date -Iseconds)"
        echo "failed_step=${CURRENT_STEP}"
        echo "exit_status=${status}"
        echo "app_dir=${APP_DIR_REAL}"
        echo "port=${PORT}"
        echo "migration_attempted=${FENCE_MASK}"
        echo "cron_backup=${CRON_BACKUP}"
        echo "units=${SERVICE_UNITS[*]:-none}"
      } > "$FENCE_FILE"
      chmod 600 "$FENCE_FILE"

      # Belt and braces: re-stop in case something (systemd Restart=, an operator,
      # a race) brought it back between the failure and here.
      for unit in "${SERVICE_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        systemctl stop "$unit" >/dev/null 2>&1 || true
        if $FENCE_MASK; then
          systemctl mask "$unit" >/dev/null 2>&1 || true
        fi
      done
    fi
  fi

  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# @deploy-phase: preflight
# ---------------------------------------------------------------------------
CURRENT_STEP="preflight"
step "Preflight"

START_TS=$(date +%s)

if ! $DRY_RUN; then
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another deploy holds ${LOCK_FILE}. Refusing to run two cutovers at once."
fi

if [[ -f "$FENCE_FILE" ]]; then
  warn "Adopting an existing fence — a previous run stopped here:"
  sed 's/^/         /' "$FENCE_FILE"
  warn "Continuing: this run will re-do every step (all of them are idempotent)."
fi

# Which process actually serves this app dir? Look, do not assume: this box runs the
# app under systemd with Restart=always, and a plain `kill` there is undone in
# seconds. Match on WorkingDirectory so a second instance serving a DIFFERENT tree
# and a DIFFERENT database (the full-chain e2e rig) is never caught by this.
detect_service_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit wd
  while read -r unit; do
    [[ -n "$unit" ]] || continue
    wd="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
    [[ -n "$wd" && -d "$wd" ]] || continue
    if [[ "$(readlink -f "$wd")" == "$APP_DIR_REAL" ]]; then
      echo "$unit"
    fi
  done < <(systemctl list-units --type=service --all --plain --no-legend --no-pager 2>/dev/null | awk '{print $1}')
}

if [[ -n "${IMS_SERVICE_UNIT:-}" ]]; then
  mapfile -t SERVICE_UNITS <<<"${IMS_SERVICE_UNIT}"
else
  mapfile -t SERVICE_UNITS < <(detect_service_units)
fi
# mapfile leaves a single empty element when the input is empty.
if [[ "${#SERVICE_UNITS[@]}" -eq 1 && -z "${SERVICE_UNITS[0]}" ]]; then
  SERVICE_UNITS=()
fi

if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  info "Launcher: systemd — ${SERVICE_UNITS[*]}"
else
  warn "Launcher: no systemd unit serves ${APP_DIR_REAL}; falling back to pid stop + 'nohup npm start'."
fi

info "App dir : ${APP_DIR_REAL} (owner ${APP_USER})"
info "Port    : ${PORT}"
$SKIP_BUILD   && warn "--skip-build: not rebuilding."
$SKIP_MIGRATE && warn "--skip-migrate: no migration will be applied, so the unit will not be masked on failure."

# ---------------------------------------------------------------------------
# @deploy-phase: build
#
# FIRST, while the predecessor is still up and still serving the schema it was
# written against. This is the long step (minutes), and it is the whole reason the
# old order was unsafe: it used to run with the migration already applied.
# ---------------------------------------------------------------------------
CURRENT_STEP="build"
NEW_BUILD_ID=""
if ! $SKIP_BUILD; then
  step "Build (predecessor still serving the OLD schema)"

  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: prisma generate + npm run build as ${APP_USER}"
  else
    info "Generating Prisma client..."
    as_app_user npx prisma generate --schema prisma/schema.prisma >/dev/null
    ok "Prisma client generated."

    info "Building..."
    BUILD_LOG="$(mktemp -t oti-build.XXXXXX.log)"
    if ! as_app_user npm run build >"$BUILD_LOG" 2>&1; then
      tail -40 "$BUILD_LOG" >&2
      die "Build failed — see $BUILD_LOG. Nothing has been stopped and nothing has been migrated."
    fi
    tail -5 "$BUILD_LOG"
    ok "Build complete."
  fi
fi

# ---------------------------------------------------------------------------
# @deploy-phase: validate
#
# Everything that can reject this release must reject it HERE, while the old process
# is still up and the schema is still untouched. A failure below this line costs an
# outage; a failure above it costs nothing.
# ---------------------------------------------------------------------------
CURRENT_STEP="validate"
step "Validate the artefact"

if ! $SKIP_BUILD; then
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would check ${APP_DIR_REAL}/.next/BUILD_ID"
  else
    [[ -f "${APP_DIR_REAL}/.next/BUILD_ID" ]] || die ".next/BUILD_ID missing after build"
    NEW_BUILD_ID="$(cat "${APP_DIR_REAL}/.next/BUILD_ID")"
    info "New BUILD_ID: ${NEW_BUILD_ID}"
  fi
fi

# Which verification checks will have to pass after the migration? Discovering them
# now means a malformed or missing hook is found before anything is stopped.
VERIFY_FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && VERIFY_FILES+=("$f")
done < <(find "${APP_DIR_REAL}/prisma/migrations" -mindepth 2 -maxdepth 2 -name 'verify.sql' -type f 2>/dev/null | sort)
if [[ "${#VERIFY_FILES[@]}" -gt 0 ]]; then
  info "Post-migration verification files declared (${#VERIFY_FILES[@]}):"
  for f in "${VERIFY_FILES[@]}"; do
    echo "         ${f#"${APP_DIR_REAL}/"}"
  done
else
  info "No migration declares a post-migration verification (prisma/migrations/*/verify.sql)."
fi
ok "Artefact validated."

# ---------------------------------------------------------------------------
# @deploy-phase: fence-writers
#
# From here on the fence is armed: nothing below restarts what we stop.
# ---------------------------------------------------------------------------
CURRENT_STEP="fence-writers"
step "Stop and drain every writer"

FENCE_ARMED=true
$SKIP_MIGRATE || FENCE_MASK=true

# --- cron ------------------------------------------------------------------
# The forgettable writers. Nothing is running between ticks, so an operator looking
# at `ps` sees a quiet box; five minutes later a sweeper wakes up and writes. The
# backup is taken ONCE and kept until a successful finish, so a re-run after a failed
# deploy restores the ORIGINAL crontab rather than a fenced one.
fence_cron() {
  command -v crontab >/dev/null 2>&1 || { warn "crontab not available; no cron writers to fence."; return 0; }

  local current
  current="$(crontab -u "$APP_USER" -l 2>/dev/null || true)"
  if [[ -z "$current" ]]; then
    info "No crontab for ${APP_USER}; nothing to fence."
    return 0
  fi

  local active
  active="$(printf '%s\n' "$current" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "$active" -eq 0 ]]; then
    info "The ${APP_USER} crontab is already fully commented out; nothing to fence."
    CRON_FENCED=true
    return 0
  fi

  info "Fencing ${active} active line(s) in the ${APP_USER} crontab."
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would back up to ${CRON_BACKUP} and comment out:"
    printf '%s\n' "$current" | grep -E '^[[:space:]]*[^#[:space:]]' | sed 's/^/         /'
    CRON_FENCED=true
    return 0
  fi

  if [[ ! -f "$CRON_BACKUP" ]]; then
    printf '%s\n' "$current" > "$CRON_BACKUP"
    chmod 600 "$CRON_BACKUP"
    info "Crontab backed up verbatim: ${CRON_BACKUP}"
  else
    info "Reusing the crontab backup from the previous run: ${CRON_BACKUP}"
  fi

  local fenced
  fenced="$(printf '%s\n' "$current" | awk '{ if ($0 ~ /^[[:space:]]*[^#[:space:]]/) print "#DEPLOY-FENCE# " $0; else print $0 }')"
  printf '%s\n' "$fenced" | crontab -u "$APP_USER" -
  CRON_FENCED=true
  ok "Cron writers fenced."
}

unfence_cron() {
  $CRON_FENCED || return 0
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would restore the ${APP_USER} crontab verbatim from ${CRON_BACKUP}"
    return 0
  fi
  [[ -f "$CRON_BACKUP" ]] || { warn "No crontab backup at ${CRON_BACKUP}; leaving the crontab as it is."; return 0; }
  crontab -u "$APP_USER" "$CRON_BACKUP"
  rm -f "$CRON_BACKUP"
  ok "Cron writers restored verbatim from the backup."
}

fence_cron

# --- the web server --------------------------------------------------------
if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  for unit in "${SERVICE_UNITS[@]}"; do
    info "systemctl stop ${unit}"
    run systemctl stop "$unit"
  done
else
  info "No systemd unit; stopping by pid."
fi

# --- strays ----------------------------------------------------------------
# Scoped by /proc/<pid>/cwd, NOT by a bare `pgrep -f next-server`: the old script's
# pattern also matched the full-chain e2e server, which runs a different tree against
# a different database and must not be touched.
app_pids() {
  local pid cwd
  for pid in $(pgrep -f 'next-server|next dev|next start|npm run dev|npm start|npm run start' 2>/dev/null || true); do
    [[ "$pid" == "$$" ]] && continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$APP_DIR_REAL" ]] && echo "$pid"
  done
}

port_pid() {
  ss -ltnp 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p {print $NF}' \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

STRAY_PIDS="$( { app_pids; port_pid; } | grep -E '^[0-9]+$' | sort -u || true)"
if [[ -n "$STRAY_PIDS" ]]; then
  info "Remaining processes in ${APP_DIR_REAL} or on :${PORT}:"
  for pid in $STRAY_PIDS; do
    echo "         ${pid}  $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-100)"
  done
  for pid in $STRAY_PIDS; do
    run kill "$pid" 2>/dev/null || true
  done
  if ! $DRY_RUN; then
    for _ in $(seq 1 10); do
      sleep 1
      STILL=""
      for pid in $STRAY_PIDS; do kill -0 "$pid" 2>/dev/null && STILL="$STILL $pid"; done
      [[ -z "$STILL" ]] && break
    done
    for pid in $STRAY_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        warn "  SIGKILL $pid"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
else
  info "No stray processes."
fi

# ---------------------------------------------------------------------------
# @deploy-phase: drain-verify
#
# "Drained" means STOPPED, not idle, and the only authority on that is the database.
# Enumerating writers is guesswork; asking Postgres who is connected is not.
# ---------------------------------------------------------------------------
CURRENT_STEP="drain-verify"
step "Prove the writers are gone"

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would wait for :${PORT} to be free"
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-db-writers.mjs  (as ${APP_USER})"
else
  for _ in $(seq 1 15); do
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$" || break
    sleep 1
  done
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$"; then
    die "Port ${PORT} is still bound. Something is still serving — refusing to migrate. (ss -ltnp | grep :${PORT})"
  fi
  ok "Port ${PORT} is free."

  if ! $SKIP_MIGRATE; then
    info "Asking Postgres whether anything else is still connected..."
    as_app_user node scripts/check-db-writers.mjs \
      || die "Another client is still connected to the target database. Stop it and re-run; the migration has NOT been applied."
    ok "No other client backends on the target database."
  fi
fi

# ---------------------------------------------------------------------------
# @deploy-phase: migrate
#
# Nothing is serving. This is the only moment at which the schema may move.
# ---------------------------------------------------------------------------
CURRENT_STEP="migrate"
if ! $SKIP_MIGRATE; then
  step "Migrate (nothing is serving)"

  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: npx prisma migrate deploy  (as ${APP_USER})"
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-prisma-drift.mjs  (as ${APP_USER})"
  else
    as_app_user npx prisma migrate deploy --schema prisma/schema.prisma
    ok "Migrations applied."

    info "Validating the deployed schema against prisma/schema.prisma..."
    as_app_user node scripts/check-prisma-drift.mjs
    ok "Database schema matches prisma/schema.prisma."
  fi
else
  step "Migrate — SKIPPED (--skip-migrate)"
fi

# ---------------------------------------------------------------------------
# @deploy-phase: verify-migrations
#
# The hook the two branches asked for. A migration declares its checks in
# prisma/migrations/<name>/verify.sql; they are executed HERE, after the schema has
# moved and BEFORE the new build is allowed to serve. Until now those queries lived
# in migration comments, where they could only be read.
#
# Contract (also in scripts/run-migration-verifications.mjs and docs/installation.md):
#   every statement returns exactly one row of (check_name text, violations bigint),
#   and every `violations` must be 0.
# ---------------------------------------------------------------------------
CURRENT_STEP="verify-migrations"
if ! $SKIP_MIGRATE; then
  step "Run the migrations' own verification checks"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/run-migration-verifications.mjs  (as ${APP_USER})"
  else
    as_app_user node scripts/run-migration-verifications.mjs \
      || die "A migration's verification check did not return zero. The new build has NOT been started."
    ok "All declared verification checks returned zero."
  fi
else
  step "Verification checks — SKIPPED (--skip-migrate)"
fi

# ---------------------------------------------------------------------------
# @deploy-phase: start
# ---------------------------------------------------------------------------
CURRENT_STEP="start"
step "Start the new build"

if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  for unit in "${SERVICE_UNITS[@]}"; do
    run systemctl unmask "$unit" >/dev/null 2>&1 || true
    info "systemctl start ${unit}"
    run systemctl start "$unit"
  done
else
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: nohup npm start  (as ${APP_USER}, logs -> ${LOG_FILE})"
  else
    echo "" >> "$LOG_FILE"
    echo "=== deploy.sh start $(date -Iseconds) ===" >> "$LOG_FILE"
    as_app_user bash -c "cd '$APP_DIR_REAL' && nohup npm start >> '$LOG_FILE' 2>&1 & disown"
  fi
fi

# ---------------------------------------------------------------------------
# @deploy-phase: health
# ---------------------------------------------------------------------------
CURRENT_STEP="health"
step "Health check"

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would poll ${HEALTH_URL} for up to ${HEALTH_TIMEOUT_SECONDS}s"
else
  READY=false
  for _ in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then READY=true; break; fi
    sleep 1
  done
  if ! $READY; then
    if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
      journalctl -u "${SERVICE_UNITS[0]}" -n 40 --no-pager >&2 || true
    else
      tail -30 "$LOG_FILE" >&2 || true
    fi
    die "Server did not answer ${HEALTH_URL} within ${HEALTH_TIMEOUT_SECONDS}s."
  fi
  ok "Server is answering ${HEALTH_URL}."

  if [[ -n "$NEW_BUILD_ID" ]]; then
    SERVED_ID="$(curl -sS "$HEALTH_URL" 2>/dev/null | grep -oE '\\?"b\\?":\\?"[A-Za-z0-9_-]+\\?"' | head -1 | grep -oE '[A-Za-z0-9_-]{10,}' | tail -1 || true)"
    if [[ -n "$SERVED_ID" && "$SERVED_ID" != "$NEW_BUILD_ID" ]]; then
      warn "Served BUILD_ID (${SERVED_ID}) does not match disk (${NEW_BUILD_ID}) — check which process answered."
    elif [[ -n "$SERVED_ID" ]]; then
      ok "Served BUILD_ID matches disk."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# @deploy-phase: unfence-cron
#
# Last, and only once the new build has answered. Restoring cron before the health
# check would hand the queue workers to a server that might still be about to fail.
# ---------------------------------------------------------------------------
CURRENT_STEP="unfence-cron"
step "Restore the cron writers"
unfence_cron
run rm -f "$FENCE_FILE"

DEPLOY_OK=true
FENCE_ARMED=false

END_TS=$(date +%s)
echo ""
if $DRY_RUN; then
  ok "Dry run complete in $((END_TS - START_TS))s. Nothing was changed."
else
  ok "Deploy complete in $((END_TS - START_TS))s."
fi
echo "   Site:  http://127.0.0.1:${PORT}/"
if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  echo "   Logs:  journalctl -u ${SERVICE_UNITS[0]} -f"
else
  echo "   Logs:  tail -f ${LOG_FILE}"
fi
