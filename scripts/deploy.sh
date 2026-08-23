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
# state is DOWN, and this script leaves it down. Fix and re-run — every step here is
# idempotent and a re-run adopts an existing fence.
#
# THE THREE FENCES, AND WHEN EACH IS ESTABLISHED (o3d-2sm1.2).
#
#   1. THE REBOOT FENCE — a systemd drop-in carrying `AssertPathExists=!<marker>`,
#      installed and VERIFIED BEFORE the migration starts rather than from the exit
#      trap. A fence installed only on the way out does not exist for a run that is
#      SIGKILLed or loses power mid-migration: the trap never runs, and the next boot
#      brings the predecessor up against a migrated schema. It is a drop-in and not
#      `systemctl mask` because a mask is a symlink at /etc/systemd/system/<unit>,
#      which is exactly where a locally-defined unit file already lives (the mask then
#      fails), and `mask --runtime` lives in /run, which the reboot erases. The install
#      is checked against `systemctl show -p DropInPaths`; an unverifiable fence fails
#      the deploy while the predecessor is still up and the schema untouched.
#
#      There is no reboot fence when no systemd unit serves this tree (the `nohup npm
#      start` fallback). That is stated at the time rather than implied away.
#
#   2. THE CRON FENCE — the whole crontab commented out, backed up verbatim once, and
#      restored only once the new build has answered.
#
#   3. THE CONNECTION FENCE — CONNECT revoked from the application role AND from PUBLIC
#      for the length of the window (scripts/fence-db-connections.mjs), so the drain is
#      CONTINUOUS instead of a snapshot that anything may connect after. It needs a
#      privileged connection of its own (DEPLOY_ADMIN_DATABASE_URL); without one this
#      script says so LOUDLY and falls back to the snapshot probe rather than implying a
#      fence it does not have.
#
#      WHEN IT IS RELEASED, AND WHEN IT IS DELIBERATELY HELD (o3d-2sm1.3, Codex r2
#      CRITICAL). Round 2 released it from the exit trap unconditionally, and adoption
#      released it too — so after a failed or interrupted MIGRATION, or a failed
#      VERIFICATION, the application could reconnect to a database whose schema is in an
#      unknown state. That is the exact window this whole order exists to close, and it
#      was being opened by the recovery path.
#
#      The distinction is whether the SCHEMA WAS TOUCHED, tracked by SCHEMA_TOUCHED and
#      recorded in the marker as `schema_touched=`:
#
#        * A failure BEFORE `prisma migrate deploy` was invoked — a failed build, a
#          refused artefact, a stray writer that would not go, a fence that could not be
#          armed — releases the fence. Nothing has moved, and an earlier round was right
#          that a revoke nobody undoes is an application that cannot reach its database.
#        * A failure AT OR AFTER that invocation HOLDS it, and says so, and prints the
#          command to release it by hand. The schema may be half-migrated; nothing may
#          connect until a re-run has migrated, checked drift and verified.
#
#      A re-run then ADOPTS a held fence rather than releasing it: it re-applies the
#      revoke (which re-drains anything that attached in between, keeping the ORIGINAL
#      recorded grants) and runs every database-touching step of the recovery — the
#      build included — through DEPLOY_ADMIN_DATABASE_URL. It comes down in the start
#      phase, once the migration, the drift check and every declared verification have
#      passed and the new build is about to start.
#
# A RE-RUN ADOPTS ALL THREE BEFORE IT REBUILDS. Finding the marker used to print a
# warning and then pull, install, generate and BUILD — minutes during which a rebooted
# or operator-started service may be serving the half-migrated schema again. Adoption
# is now the first thing after the lock and the unit detection: re-stop, re-establish
# and verify the reboot fence, confirm cron is still fenced, adopt or release the
# standing connection fence per the rule above, and only then continue.
#
# AND A RE-RUN OVER A MIGRATION ATTEMPT MAY NOT SKIP THE MIGRATION. `--skip-migrate`
# and `--restart-only` are REFUSED while adopting a marker that says a migration was
# attempted: the schema may be half-applied, and starting the service without re-running
# migrate -> drift -> verify would start it against exactly that. The refusal names the
# flag and what to do instead.
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
#   bash scripts/deploy.sh --skip-migrate # build, stop, start (no migrate, no reboot fence)
#   bash scripts/deploy.sh --restart-only # stop and start; no build, no migrate
#
# --skip-migrate and --restart-only are REFUSED while adopting a fence whose marker says
# a migration was attempted: the schema may be half-applied and the full
# migrate -> drift -> verify sequence has to run before anything starts. --skip-build is
# still allowed there, and is usually what you want — the build ran before the stop, so
# the artefact on disk is already the new one.
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
FENCE_DROPIN_NAME="zz-deploy-fence.conf"
DB_FENCE_STATE="${STATE_DIR}/db-connect-fence.json"
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
# The flag as the operator typed it, kept so the refusal below can name it rather than
# talking about a variable they never set.
SKIP_MIGRATE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=true ;;
    --skip-build)   SKIP_BUILD=true ;;
    --skip-migrate) SKIP_MIGRATE=true; SKIP_MIGRATE_FLAG="--skip-migrate" ;;
    --restart-only) SKIP_BUILD=true; SKIP_MIGRATE=true; SKIP_MIGRATE_FLAG="--restart-only" ;;
    --help|-h)      sed -n '3,150p' "$0"; exit 0 ;;
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
# Fence bookkeeping. Three flags, and they mean three different things:
#
#   FENCE_ARMED     from here on, never restart the thing we stopped.
#   FENCE_MASK      this run INTENDS to migrate, so the fence must survive a reboot.
#                   Armed before the stop, because a fence installed later does not
#                   exist for a run that is killed rather than exiting.
#   SCHEMA_TOUCHED  `prisma migrate deploy` HAS BEEN INVOKED. The schema may have moved,
#                   or may be half-moved. This is the flag the connection fence is held
#                   by: intending to migrate is not the same as having started, and the
#                   database must stay unreachable only for the second (o3d-2sm1.3).
# ---------------------------------------------------------------------------
FENCE_ARMED=false
FENCE_MASK=false
SCHEMA_TOUCHED=false
DEPLOY_OK=false
CRON_FENCED=false
CURRENT_STEP="startup"
SERVICE_UNITS=()

CRON_BACKUP="${STATE_DIR}/crontab-${APP_USER}.bak"
DB_FENCE_SCRIPT="${APP_DIR_REAL}/scripts/fence-db-connections.mjs"
DB_FENCE_RELEASE_CMD="node ${DB_FENCE_SCRIPT} --release --state-file=${DB_FENCE_STATE}"
# The connection the migration itself runs through: the privileged URL while the
# connection fence is up, because the fence shuts the application role out and the
# migration must not be shut out with it.
DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL:-$(grep -E '^DEPLOY_ADMIN_DATABASE_URL=' "${APP_DIR_REAL}/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)}"
MIGRATION_DATABASE_URL=""

# ---------------------------------------------------------------------------
# The reboot fence. The marker file is the condition; the drop-in is what makes
# systemd honour it. Both are written BEFORE anything is stopped.
# ---------------------------------------------------------------------------
fence_dropin_file() { echo "/etc/systemd/system/$1.d/${FENCE_DROPIN_NAME}"; }

write_fence_marker() {
  local reason="$1" status="${2:-0}"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would write ${FENCE_FILE}"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  {
    echo "fenced_at=$(date -Iseconds)"
    echo "reason=${reason}"
    echo "failed_step=${CURRENT_STEP}"
    echo "exit_status=${status}"
    echo "app_dir=${APP_DIR_REAL}"
    echo "port=${PORT}"
    echo "migration_attempted=${FENCE_MASK}"
    echo "schema_touched=${SCHEMA_TOUCHED}"
    echo "cron_backup=${CRON_BACKUP}"
    echo "units=${SERVICE_UNITS[*]:-none}"
    echo "db_connect_fence_state=${DB_FENCE_STATE}"
    echo "release_db_connect_fence=${DB_FENCE_RELEASE_CMD}"
  } > "$FENCE_FILE"
  chmod 600 "$FENCE_FILE"
}

verify_reboot_fence() {
  local unit="$1" dropin
  dropin="$(fence_dropin_file "$unit")"
  [[ -f "$FENCE_FILE" ]] || { echo -e "${RED}[ERROR]${RESET} Reboot fence NOT verified: the marker ${FENCE_FILE} does not exist." >&2; return 1; }

  local paths
  paths="$(systemctl show -p DropInPaths --value "$unit" 2>/dev/null || true)"
  if [[ "$paths" == *"$dropin"* ]]; then
    ok "Reboot fence verified: systemd reports ${dropin} loaded for ${unit}."
    return 0
  fi
  if systemctl cat "$unit" 2>/dev/null | grep -qF "$dropin"; then
    ok "Reboot fence verified: ${dropin} appears in 'systemctl cat ${unit}'."
    return 0
  fi
  echo -e "${RED}[ERROR]${RESET} Reboot fence NOT verified: systemd does not report ${dropin} for ${unit}." >&2
  return 1
}

install_reboot_fence() {
  local reason="$1"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would write ${FENCE_FILE} and a ${FENCE_DROPIN_NAME} drop-in per unit, daemon-reload, and verify with systemctl show -p DropInPaths"
    return 0
  fi

  write_fence_marker "$reason"

  if [[ "${#SERVICE_UNITS[@]}" -eq 0 ]]; then
    warn "No systemd unit serves ${APP_DIR_REAL}: there is NO reboot fence. Nothing on this"
    warn "host stops the predecessor being started again by hand or by a boot script."
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || { warn "systemctl is unavailable: there is NO reboot fence."; return 1; }

  local unit dropin
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(fence_dropin_file "$unit")"
    mkdir -p "$(dirname "$dropin")"
    cat > "$dropin" <<EOF
[Unit]
# Installed by scripts/deploy.sh (o3d-2sm1.2) for the length of a cutover.
# While the marker below exists this unit must not start — not by hand, and not on
# boot. deploy.sh removes both once the new build has answered its health check.
AssertPathExists=!${FENCE_FILE}
EOF
    chmod 644 "$dropin"
  done

  systemctl daemon-reload || { echo -e "${RED}[ERROR]${RESET} systemctl daemon-reload failed; the reboot fence is NOT active." >&2; return 1; }

  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    verify_reboot_fence "$unit" || return 1
  done
  return 0
}

remove_reboot_fence() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would remove the ${FENCE_DROPIN_NAME} drop-ins, daemon-reload, and delete ${FENCE_FILE}"
    return 0
  fi
  local unit dropin
  for unit in "${SERVICE_UNITS[@]:-}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(fence_dropin_file "$unit")"
    rm -f "$dropin"
    rmdir "$(dirname "$dropin")" 2>/dev/null || true
  done
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while lifting the reboot fence."
  fi
  # The marker is the condition, so deleting it is what actually lifts the fence; a
  # drop-in left behind is untidy rather than dangerous.
  rm -f "$FENCE_FILE"
  return 0
}

# ---------------------------------------------------------------------------
# The connection fence. scripts/fence-db-connections.mjs states what it can and
# cannot promise; what matters here is that failing to RELEASE it leaves an
# application that cannot reach its database, so every path releases it and any path
# that cannot prints the exact statements to run by hand.
# ---------------------------------------------------------------------------
fence_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/fence-db-connections.mjs --fence  (as ${APP_USER})"
    return 0
  fi
  if [[ ! -f "$DB_FENCE_SCRIPT" ]]; then
    warn "${DB_FENCE_SCRIPT} is not in this checkout: NOT FENCED, the probe below is a snapshot only."
    return 0
  fi

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local rc=0
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$DB_FENCE_SCRIPT" --fence --state-file="$DB_FENCE_STATE" || rc=$?

  case "$rc" in
    0)
      MIGRATION_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}"
      ok "Connection fence up: new application connections are refused for the window."
      ;;
    3)
      warn "THE DATABASE IS NOT FENCED. What follows is a SNAPSHOT, not a fence: nothing"
      warn "stops a client connecting between the probe and the end of the migration."
      warn "Set DEPLOY_ADMIN_DATABASE_URL (docs/installation.md) to make this a real fence."
      ;;
    *)
      die "The connection fence failed (exit ${rc}). Nothing has been migrated."
      ;;
  esac
}

release_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: ${DB_FENCE_RELEASE_CMD}  (as ${APP_USER})"
    return 0
  fi
  [[ -f "$DB_FENCE_STATE" ]] || return 0
  [[ -f "$DB_FENCE_SCRIPT" ]] || { echo -e "${RED}[ERROR]${RESET} Cannot release the connection fence: ${DB_FENCE_SCRIPT} is missing." >&2; return 1; }

  if as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "$DB_FENCE_SCRIPT" --release --state-file="$DB_FENCE_STATE"; then
    MIGRATION_DATABASE_URL=""
    ok "Connection fence released."
    return 0
  fi

  echo -e "${RED}[ERROR]${RESET} THE CONNECTION FENCE COULD NOT BE RELEASED. The application role still" >&2
  echo -e "${RED}[ERROR]${RESET} has no CONNECT on this database and cannot start until this is undone:" >&2
  echo -e "${RED}[ERROR]${RESET}   ${DB_FENCE_RELEASE_CMD}" >&2
  echo -e "${RED}[ERROR]${RESET} or, by hand as a superuser, the GRANTs recorded in ${DB_FENCE_STATE}." >&2
  return 1
}

# Adopt a fence a previous run left standing after it had started migrating, instead of
# releasing it. Re-running --fence re-applies the revoke and re-drains anything that
# attached in the meantime, and keeps the ORIGINAL recorded grants, so the release still
# restores the truth rather than the fenced snapshot.
#
# Everything in the recovery that needs the database must then go through the admin
# connection, so a fence adopted without DEPLOY_ADMIN_DATABASE_URL is fatal: the app
# role has no CONNECT, this run has no other connection, and there is nothing useful it
# could do next.
adopt_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would re-apply and re-drain the standing connection fence and run the"
    echo -e "${YELLOW}[DRY]${RESET}   recovery through DEPLOY_ADMIN_DATABASE_URL"
    return 0
  fi
  if [[ ! -f "$DB_FENCE_STATE" ]]; then
    info "No connection fence was standing from the previous run (${DB_FENCE_STATE} is absent)."
    return 0
  fi
  [[ -n "$DEPLOY_ADMIN_DATABASE_URL" ]] || die \
    "A connection fence is standing (${DB_FENCE_STATE}) but DEPLOY_ADMIN_DATABASE_URL is not set, so this run has no connection that survives it. Set it, or release the fence by hand: ${DB_FENCE_RELEASE_CMD}"

  warn "The previous run had already started migrating: HOLDING the connection fence."
  warn "The application stays shut out of its own database until this run has migrated,"
  warn "checked for drift and passed every declared verification."
  fence_db_connections
  [[ -n "$MIGRATION_DATABASE_URL" ]] || die \
    "The standing connection fence could not be re-established, and this run therefore has no privileged connection to recover through. Fix DEPLOY_ADMIN_DATABASE_URL, or release the fence by hand: ${DB_FENCE_RELEASE_CMD}"
  ok "Connection fence adopted; the recovery runs through DEPLOY_ADMIN_DATABASE_URL."
}

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


# Run a node/npx step through the connection that survives the fence.
as_app_user_db() {
  if [[ -n "$MIGRATION_DATABASE_URL" ]]; then
    as_app_user env DATABASE_URL="$MIGRATION_DATABASE_URL" "$@"
  else
    as_app_user "$@"
  fi
}

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
    if $SCHEMA_TOUCHED; then
      echo -e "  schema      : a migration was RUNNING; the database may be MIGRATED or"
      echo -e "                half-migrated while nothing is serving. That is the intended"
      echo -e "                safe state, and the connection fence below is held for it."
    elif $FENCE_MASK; then
      echo -e "  schema      : untouched — this run stopped before the migration was invoked."
    fi
    if $FENCE_MASK; then
      echo -e "  service     : STOPPED, and fenced by a ${FENCE_DROPIN_NAME} drop-in so a"
      echo -e "                reboot cannot start it either while ${FENCE_FILE} exists"
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
      # Belt and braces: re-stop in case something (systemd Restart=, an operator,
      # a race) brought it back between the failure and here.
      for unit in "${SERVICE_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        systemctl stop "$unit" >/dev/null 2>&1 || true
      done
      if $FENCE_MASK; then
        if ! install_reboot_fence "deploy failed at ${CURRENT_STEP}"; then
          echo -e "${RED}${BOLD} THE REBOOT FENCE IS NOT IN PLACE. This host may start the predecessor${RESET}" >&2
          echo -e "${RED}${BOLD} against a migrated schema on its next boot. Stop it by hand.${RESET}" >&2
        fi
      fi
      write_fence_marker "deploy failed at ${CURRENT_STEP}" "${status}"
      # THE CONNECTION FENCE IS HELD IF THE SCHEMA WAS TOUCHED, AND ONLY THEN.
      #
      # An earlier round released it here unconditionally, so that a failure could not
      # leave the database unreachable — and that reasoning still holds for every
      # failure BEFORE a migration was attempted, which is why those still release. But
      # once `prisma migrate deploy` has been invoked the schema is in an unknown state,
      # and releasing CONNECT there lets the application reconnect to exactly that. The
      # correct state is unreachable, and stated.
      if $SCHEMA_TOUCHED; then
        echo -e "${RED}${BOLD} THE CONNECTION FENCE IS DELIBERATELY LEFT UP.${RESET}" >&2
        echo -e "${RED}  A migration was already running when this failed, so the schema may be${RESET}" >&2
        echo -e "${RED}  half-applied. The application role has no CONNECT on this database and${RESET}" >&2
        echo -e "${RED}  must not get it back until a re-run has migrated, checked drift and passed${RESET}" >&2
        echo -e "${RED}  every declared verification. A re-run adopts this fence and recovers${RESET}" >&2
        echo -e "${RED}  through DEPLOY_ADMIN_DATABASE_URL.${RESET}" >&2
        echo -e "${RED}  To release it by hand instead (only once you know the schema is sound):${RESET}" >&2
        echo -e "${RED}    ${DB_FENCE_RELEASE_CMD}${RESET}" >&2
      else
        release_db_connections || true
      fi
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

# Adoption, and it is the FIRST thing that touches this box after the lock and the unit
# detection — before the pull, before `npm ci`, before the build. Warning about a fence
# and then spending minutes building leaves a rebooted or operator-started service
# writing into a half-migrated schema for exactly the window this order exists to close.
adopt_cron_fence() {
  command -v crontab >/dev/null 2>&1 || return 0
  if [[ ! -f "$CRON_BACKUP" ]]; then
    info "No crontab backup from the previous run; its cron entries were never fenced."
    return 0
  fi
  # The backup holds the ORIGINAL crontab and must survive until this run finishes.
  CRON_FENCED=true
  local current active
  current="$(crontab -u "$APP_USER" -l 2>/dev/null || true)"
  active="$(printf '%s\n' "$current" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "$active" -gt 0 ]]; then
    warn "${active} cron line(s) are active again; re-fencing them."
    fence_cron
  else
    ok "Cron is still fenced; ${CRON_BACKUP} holds the original."
  fi
}

if [[ -f "$FENCE_FILE" ]]; then
  warn "Adopting an existing fence — a previous run stopped here:"
  sed 's/^/         /' "$FENCE_FILE"

  FENCE_ARMED=true
  if grep -qE '^migration_attempted=true$' "$FENCE_FILE" 2>/dev/null; then
    FENCE_MASK=true
  fi
  # Distinct from the mask: this says the previous run had actually INVOKED
  # `prisma migrate deploy`, so the schema may be half-applied. It decides whether the
  # connection fence is held or released, and it is carried forward so that a failure of
  # THIS run does not release a fence its predecessor was right to leave standing.
  if grep -qE '^schema_touched=true$' "$FENCE_FILE" 2>/dev/null; then
    SCHEMA_TOUCHED=true
  fi

  # A RE-RUN OVER A MIGRATION ATTEMPT MAY NOT SKIP THE MIGRATION.
  #
  # The previous run stopped somewhere at or after the migration: it may have applied
  # nothing, everything, or part of it, and a failed VERIFICATION means the schema moved
  # and something about the result was wrong. --skip-migrate and --restart-only would
  # start the service without re-running any of migrate -> drift -> verify, which is
  # starting it against precisely the unknown schema this fence exists to keep it away
  # from. The full sequence is idempotent; skipping it is not a shortcut, it is the
  # failure mode.
  if $FENCE_MASK && $SKIP_MIGRATE; then
    die "Refusing ${SKIP_MIGRATE_FLAG} while adopting a fence whose marker says a migration was attempted (${FENCE_FILE}). The schema may be half-applied, so this re-run must migrate, check for drift and pass every declared verification before anything starts. Re-run without ${SKIP_MIGRATE_FLAG} (add --skip-build if the build on disk is the one you want)."
  fi

  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would re-stop the unit(s), re-establish and verify the reboot fence,"
    echo -e "${YELLOW}[DRY]${RESET}   confirm the cron fence, and adopt or release the standing connection fence"
  else
    for unit in "${SERVICE_UNITS[@]:-}"; do
      [[ -n "$unit" ]] || continue
      info "Re-stopping ${unit} before anything else — it may have been started since."
      systemctl stop "$unit" >/dev/null 2>&1 || true
    done
    install_reboot_fence "adopted at $(date -Iseconds)" \
      || die "Could not re-establish the reboot fence. Refusing to continue: a reboot could start the predecessor against a migrated schema."
    adopt_cron_fence
    if $SCHEMA_TOUCHED; then
      # HELD, not released. The previous run had started migrating, so the schema is in
      # an unknown state and the application must not be able to reach it — not during
      # this rebuild, and not if this run fails too. Everything below that needs the
      # database goes through DEPLOY_ADMIN_DATABASE_URL, the build included.
      adopt_db_connections
    else
      # Nothing had moved, so release: a revoke nobody undoes is an application that
      # cannot reach its database at all. The window is re-fenced at drain-verify, and
      # releasing now also proves the release path works before the migration needs it.
      release_db_connections \
        || die "A connection fence from the previous run could not be released; fix that before re-running."
    fi
  fi
  warn "Fence adopted. Continuing: this run re-does every step (all of them are idempotent)."
fi

info "App dir : ${APP_DIR_REAL} (owner ${APP_USER})"
info "Port    : ${PORT}"
$SKIP_BUILD   && warn "--skip-build: not rebuilding."
$SKIP_MIGRATE && warn "--skip-migrate: no migration will be applied, so no reboot fence is installed."

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
    # Through `as_app_user_db`, so that a rebuild during a recovery that is HOLDING the
    # connection fence goes via DEPLOY_ADMIN_DATABASE_URL. Anything the build touches in
    # the database would otherwise fail with "permission denied for database", which is
    # the fence working as intended and not a build error. On a normal run
    # MIGRATION_DATABASE_URL is empty and this is exactly `as_app_user`.
    if ! as_app_user_db npm run build >"$BUILD_LOG" 2>&1; then
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
  warn "No migration declares a post-migration verification (prisma/migrations/*/verify.sql):"
  warn "the post-migration hook will execute nothing, and a pass from it will mean nothing"
  warn "was checked. prisma/migrations/verification-required.txt says which must declare one."
fi
ok "Artefact validated."

# ---------------------------------------------------------------------------
# @deploy-phase: fence-writers
#
# From here on the fence is armed: nothing below restarts what we stop.
# ---------------------------------------------------------------------------
CURRENT_STEP="fence-writers"
step "Stop and drain every writer"

# BEFORE the stop, and long before the migration. A fence installed on the way out does
# not exist for a run that is killed rather than exiting, and failing to install it HERE
# costs nothing: the predecessor is still up, the schema has not moved, and FENCE_ARMED
# is still false, so the failure banner does not claim an outage that has not happened.
$SKIP_MIGRATE || FENCE_MASK=true
if $FENCE_MASK; then
  install_reboot_fence "cutover started $(date -Iseconds)" \
    || die "Refusing to stop the predecessor without a verified reboot fence: a reboot mid-migration would start it again against a migrated schema."
else
  info "--skip-migrate: no migration will be applied, so no reboot fence is installed."
fi

FENCE_ARMED=true

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
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/fence-db-connections.mjs --fence  (as ${APP_USER})"
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
    # Order matters: the FENCE shuts the door for the rest of the window, and only then
    # does the PROBE assert the room is empty. The probe alone is a snapshot — it closes
    # its connection, and the migration opens its own afterwards with nothing holding
    # the gap.
    fence_db_connections

    info "Asking Postgres whether anything else is still connected..."
    as_app_user_db node scripts/check-db-writers.mjs \
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
    echo -e "${YELLOW}[DRY]${RESET}   from that point a failure would HOLD the connection fence rather than release it"
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-prisma-drift.mjs  (as ${APP_USER})"
  else
    # FROM HERE THE SCHEMA MAY HAVE MOVED. Set BEFORE the command, not after it: a
    # migration that is interrupted, times out or half-applies is exactly the case the
    # flag exists for, and one set afterwards would be false for all of them.
    SCHEMA_TOUCHED=true
    as_app_user_db npx prisma migrate deploy --schema prisma/schema.prisma
    ok "Migrations applied."

    info "Validating the deployed schema against prisma/schema.prisma..."
    as_app_user_db node scripts/check-prisma-drift.mjs
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
    as_app_user_db node scripts/run-migration-verifications.mjs \
      || die "A migration's verification check did not return zero. The new build has NOT been started."
    ok "Every declared verification check returned zero (the coverage report above says what was NOT declared)."
  fi
else
  step "Verification checks — SKIPPED (--skip-migrate)"
fi

# ---------------------------------------------------------------------------
# @deploy-phase: start
# ---------------------------------------------------------------------------
CURRENT_STEP="start"
step "Start the new build"

# The fences come down in the order that keeps the new build startable: the database
# first (it cannot serve a database it may not connect to), then the reboot fence.
#
# THIS IS THE ONLY PLACE A RELEASE FOLLOWS A MIGRATION. Reaching this line means the
# migration applied, the deployed schema matched prisma/schema.prisma, and every declared
# verification returned zero — the schema is known good and the new build is about to
# start. Every other path either never touched the schema or leaves the fence standing.
release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence

if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  for unit in "${SERVICE_UNITS[@]}"; do
    # Lifts a mask left by an older revision of this script, which masked from its exit
    # trap. Harmless when there is none.
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
# Already removed with the reboot fence in the start phase; kept so that a run which
# took a different path cannot leave a marker behind that refuses the next boot.
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
