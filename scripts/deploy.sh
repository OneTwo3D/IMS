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
#      AND A HOST WITH NO UNIT CANNOT MIGRATE (o3d-2sm1.5, Codex r4 HIGH). The install used
#      to warn and return 0 when no systemd unit served this tree, so the `|| die` at every
#      call site never fired: the predecessor was stopped and the schema migrated with NO
#      reboot fence, and the failure banner then described one. That is the exit-3 reasoning
#      again — a fence you know is absent is no fence — so the VALIDATE phase refuses a
#      migration on a unit-less host, before anything is stopped, and names IMS_SERVICE_UNIT.
#      The `nohup npm start` fallback is unaffected for --skip-migrate and --restart-only,
#      which move no schema. The marker records `reboot_fence=installed|absent` and the
#      banner prints whichever is true, rather than assuming intent was achievement.
#
#      AND A FAILED INSTALL LEAVES NOTHING BEHIND (o3d-2sm1.5, Codex r4 CRITICAL). The marker
#      went down first, then the drop-ins, then the reload, then the verify — and any failure
#      after that first line returned 1 into a `|| die` while FENCE_ARMED was still false, so
#      the trap did nothing and neither the marker nor the drop-in was removed. The operator
#      read a clean abort while an AssertPathExists=! now pointed at a marker that existed:
#      invisible until the next boot, when the unit failed its assertion with nothing
#      connecting that to a deploy that had "changed nothing". The install now removes exactly
#      what THIS call created — never a fence that was already standing.
#
#   2. THE CRON FENCE — the whole crontab commented out, backed up verbatim once, and
#      restored only once the new build has answered.
#
#   3. THE CONNECTION FENCE — CONNECT revoked from the application role AND from PUBLIC
#      for the length of the window (scripts/fence-db-connections.mjs), so the drain is
#      CONTINUOUS instead of a snapshot that anything may connect after. It needs a
#      privileged connection of its own (DEPLOY_ADMIN_DATABASE_URL).
#
#      IT REVOKES FROM EVERY GRANTEE, NOT TWO OF THEM (o3d-2sm1.5, Codex r4 HIGH). It used to
#      revoke from PUBLIC and the application role only, so a third role with a direct CONNECT
#      grant — monitoring, BI, a backup job, a second application — was terminated by the
#      drain and reconnected immediately, for the whole migration, while every header said the
#      database was held closed. The revoke is derived from the ACL itself now.
#
#      AND THE MIGRATION RUNS AS THE APPLICATION ROLE (o3d-2sm1.5, Codex r4 CRITICAL). The
#      fence forces the migration through the ADMIN connection, and whatever runs a CREATE
#      owns what it creates. scripts/install.sh makes the APPLICATION role the database owner
#      and the fence refuses when admin == app, so the only fenceable configuration is a
#      separate SUPERUSER admin — and every table, index and sequence a migration made was
#      owned by that superuser with no grant to the application. Nothing in the pipeline could
#      see it: prisma, the drift check, the verification hook and pg_dump all share the admin
#      connection, and the health check touches no database. The deploy passed; every request
#      touching the new table failed with `permission denied`. So the migration URL now
#      carries `options=-c role=<app role>`: it CONNECTS as the admin (which is what keeps the
#      fence effective) and RUNS AS the application role (which is what makes the fenced path
#      leave the database exactly as an unfenced one would). It is not taken on trust —
#      `--preflight` refuses before the stop if the admin cannot SET ROLE, and
#      scripts/check-app-db-object-access.mjs asks the database, after every migration, whether
#      the APPLICATION role can use each table, view and sequence, and fails the deploy if not.
#
#      AND IT IS MANDATORY (o3d-2sm1.4, Codex r3 HIGH). Round 2 warned on exit 3 — "CONNECT
#      was not revoked" — and carried on with the point-in-time probe. That is the same
#      mistake the probe itself was: a sibling server, a missed cron tick or an operator's
#      psql can attach at any moment after the snapshot. The earlier reasoning was that a
#      missing admin connection should not block a deploy; it was wrong, because a fence you
#      know is absent is not a degraded fence, it is no fence. Exit 3 now ABORTS, and the
#      cheapest half of the question — is DEPLOY_ADMIN_DATABASE_URL set at all — is asked in
#      the VALIDATE phase, while the predecessor is still up and a refusal costs nothing.
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
#      AND "SCHEMA_TOUCHED" IS WRITTEN TO DISK BEFORE PRISMA RUNS, NOT BY THE EXIT TRAP
#      (o3d-2sm1.4, Codex r3 CRITICAL). Round 2 set the flag in shell memory immediately
#      before the migration and left the durable marker to the trap. A SIGKILL, an OOM kill
#      or a power cut mid-migration never reaches a trap: the marker on disk still said
#      `schema_touched=false`, adoption read that byte, and RELEASED the fence over a
#      half-migrated schema — the exact CRITICAL the previous round fixed, arriving through
#      the one path the trap cannot cover. mark_schema_touched() writes and flushes it
#      first, and refuses to migrate if it cannot.
#
#      AND A FAILED START DOES NOT GET TO CLAIM THE FENCE IS UP (o3d-2sm1.4, Codex r3 HIGH).
#      The start phase releases the fence before `systemctl start` and the health check,
#      because the new build cannot serve a database it may not connect to. A failure in
#      either then arrived at a banner announcing a HELD fence over a database the
#      application role could already reach. The trap now re-stops, RE-ESTABLISHES the
#      fence, and prints — and records in the marker — which of the two is actually true.
#
# AND THERE IS A POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). Once the new build has
# answered its health check the deploy has succeeded; what is left is cleanup. DEPLOY_OK used
# to be set only after the cron restore and the marker removal, so under `set -e` a failing
# `crontab` reached the exit trap with the fence still armed — and the trap stopped the
# service that had just passed its health check, re-fenced it and re-revoked CONNECT. A
# cron-restore failure became a full outage plus a database lockout on a deploy that had
# already succeeded. Past the health check nothing tears the deploy down: the failure is
# printed, with the commands to finish the cleanup by hand.
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
    --help|-h)      sed -n '3,226p' "$0"; exit 0 ;;
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
# THE FENCE STATE MACHINE (o3d-2sm1.5, Codex r7 HIGH).
#
# Four phases, one direction only, and the exit trap does something different in each:
#
#   none      This run has created nothing that needs undoing, so the trap just exits.
#   arming    CUTOVER_ARMING=true. This run has installed REVERSIBLE cutover state — the
#             reboot-fence drop-in and marker, the cron fence — and has NOT yet asked
#             anything to stop. The predecessor is up, healthy, and serving the schema it
#             was built against. A failure here is UNDONE: the crontab goes back verbatim,
#             the drop-in and the marker THIS run created are removed, and NOTHING is
#             stopped. See unwind_arming().
#   stopping  FENCE_ARMED=true. A stop has been ATTEMPTED — or a previous run's fence was
#             adopted, which means its stop already happened. From here nothing restarts
#             what was stopped: the trap re-stops, re-fences and reports.
#   serving   PAST_POINT_OF_NO_RETURN=true. The new build PROVED it is the process
#             answering the port. Nothing below may take that away.
#
# THE ARMING PHASE EXISTS BECAUSE IT WAS MISSING. FENCE_ARMED used to be raised BEFORE
# `fence_cron` and before any stop, so a crontab backup that could not be written, a chmod
# that failed, a broken pipeline or a `crontab` that returned non-zero arrived at the trap
# looking exactly like a failed migration. The trap then STOPPED a service nobody had
# touched, installed the reboot fence, kept it, and told the operator not to start the
# predecessor — over a schema that had not moved and a service that was still healthy. A
# failure in the cheap, reversible step ran the expensive, outage-causing machinery.
#
# The remaining flags say what is TRUE, not where we are:
#
#   FENCE_ARMED     a stop has been attempted; never restart the thing we stopped.
#   FENCE_MASK      this run INTENDS to migrate, so the fence must survive a reboot.
#                   Armed before the stop, because a fence installed later does not
#                   exist for a run that is killed rather than exiting.
#   SCHEMA_TOUCHED  `prisma migrate deploy` HAS BEEN INVOKED. The schema may have moved,
#                   or may be half-moved. This is the flag the connection fence is held
#                   by: intending to migrate is not the same as having started, and the
#                   database must stay unreachable only for the second (o3d-2sm1.3).
#                   IT IS PERSISTED AND FLUSHED TO DISK BEFORE PRISMA IS INVOKED, not
#                   left in shell memory for the exit trap to write out (o3d-2sm1.4,
#                   Codex r3 CRITICAL). A SIGKILL or a power cut during the migration
#                   never reaches the trap, so a flag that only lives in memory leaves
#                   a marker saying `schema_touched=false` — and the next run's
#                   adoption reads exactly that byte and RELEASES the connection fence
#                   over a half-migrated schema. See mark_schema_touched().
#   DB_FENCE_UP     the connection fence is standing RIGHT NOW, as far as this process
#                   knows. Not the same as SCHEMA_TOUCHED: the start phase releases the
#                   fence while SCHEMA_TOUCHED stays true, and a failure to start or a
#                   failed health check must then not report a fence that is no longer
#                   there (o3d-2sm1.4, Codex r3 HIGH). The trap re-establishes it.
# ---------------------------------------------------------------------------
# Phase `arming`: reversible cutover state exists and NOTHING has been stopped yet.
CUTOVER_ARMING=false
# Phase `stopping`: a stop has been ATTEMPTED. Raised immediately before the first
# `systemctl stop`, and by the adoption path, whose predecessor already stopped.
FENCE_ARMED=false
FENCE_MASK=false
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
DEPLOY_OK=false
CRON_FENCED=false
# Did THIS run write the crontab backup? The unwind restores from it, and an ADOPTED
# backup belongs to the previous run's still-standing fence and must not be touched.
CRON_BACKUP_CREATED=false
CURRENT_STEP="startup"
SERVICE_UNITS=()
# Is the reboot fence ACTUALLY loaded by systemd right now? Distinct from FENCE_MASK, which
# only says this run intends to migrate. The failure banner used to print the fence line
# whenever a migration was intended, describing a drop-in that may never have been installed
# (o3d-2sm1.5, Codex r4 HIGH).
REBOOT_FENCE_INSTALLED=false
# Rollback bookkeeping for install_reboot_fence(): what THIS call created, so a failure can
# remove exactly that and leave an already-standing fence alone.
FENCE_MARKER_PREEXISTED=false
FENCE_DROPINS_CREATED=()
# The point of no return: the new build has answered its health check. Nothing after this may
# stop it, re-fence it or revoke CONNECT again (o3d-2sm1.5, Codex r4 HIGH).
PAST_POINT_OF_NO_RETURN=false
# Does a unit this run manages serve the app with `next dev`? A development server compiles
# from source and reports the literal build id `development`, so it CANNOT serve a production
# build id and the build-id proof below can never be established from it. That is "cannot
# prove", not "proven wrong" (o3d-2sm1.5, r6 CRITICAL).
DEV_SERVER_UNIT=false
# The dev-server equivalent of NEW_BUILD_SERVING: the process that answered was shown to
# be the unit this run restarted, running from this working tree (o3d-2sm1.5, Codex r7
# HIGH). A dev server has no production build id to serve, so the asset channel can never
# arm; this is the evidence that replaces it, and without it the deploy fails.
DEV_RESPONDER_PROVEN=false
# Which unit the process on the port turned out to belong to, filled in by the proof.
RESPONDER_UNIT=""
# When this run issued `systemctl start`. The responder must post-date it, or it survived
# the stop and is not ours.
SERVICE_START_EPOCH=0
# Clock slack for that comparison, in seconds.
DEV_RESPONDER_CLOCK_SLACK=5
# THE ESCAPE HATCH, AND WHY IT IS NARROW. Making the dev path fatal is correct only while
# the identity check itself works; a bug in it would fail every deploy on this host AFTER
# the migration with the fence up, which is exactly the outage r6 fixed. This env var
# completes such a run WITHOUT arming the point of no return — it buys back the old
# behaviour deliberately, per run, and never silently.
ALLOW_UNIDENTIFIED_DEV_RESPONDER=false
if [[ "${IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER:-0}" == "1" ]]; then
  ALLOW_UNIDENTIFIED_DEV_RESPONDER=true
fi

CRON_BACKUP="${STATE_DIR}/crontab-${APP_USER}.bak"
DB_FENCE_SCRIPT="${APP_DIR_REAL}/scripts/fence-db-connections.mjs"
DB_FENCE_RELEASE_CMD="node ${DB_FENCE_SCRIPT} --release --state-file=${DB_FENCE_STATE}"
DB_OBJECT_ACCESS_SCRIPT="${APP_DIR_REAL}/scripts/check-app-db-object-access.mjs"

# Read ONE variable out of .env without `source` (which executes whatever is in the file)
# and without `grep | cut` (which is what this used to be: it kept the surrounding quotes
# and any trailing comment, so an ordinary `KEY="postgres://u:p@h/db"  # deploy admin`
# reached psql complete with a double quote at each end and the word "deploy" on the end).
# The quoting rules followed are dotenv's own, because dotenv is what reads this file
# everywhere else: a quoted value ends at its closing quote, an unquoted one ends at the
# first whitespace-preceded `#`, and later definitions win.
env_file_value() {
  local key="$1" file="$2" line value
  [[ -f "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *)
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# The connection the migration itself runs through: the privileged URL while the
# connection fence is up, because the fence shuts the application role out and the
# migration must not be shut out with it.
#
# It CONNECTS as the admin and RUNS AS the application role — see fence_db_connections(),
# which composes the URL through fence-db-connections.mjs --print-migration-url. Connecting
# as the admin is what keeps the fence effective; running as the application role is what
# stops every object the migration creates being owned by a superuser the application has no
# grant from (o3d-2sm1.5).
DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL:-$(env_file_value DEPLOY_ADMIN_DATABASE_URL "${APP_DIR_REAL}/.env")}"
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
    # Whether a drop-in is ACTUALLY loaded, not whether one was intended. The banner used to
    # describe a reboot fence whenever a migration was intended, including on hosts where
    # none had ever been installed (o3d-2sm1.5, Codex r4 HIGH).
    echo "reboot_fence=$($REBOOT_FENCE_INSTALLED && echo installed || echo absent)"
    echo "cron_backup=${CRON_BACKUP}"
    echo "units=${SERVICE_UNITS[*]:-none}"
    echo "db_connect_fence_state=${DB_FENCE_STATE}"
    # What the operator reading this file is actually looking at. Printing "held" from a
    # SCHEMA_TOUCHED branch that had already released it is how a fence that does not
    # exist gets read as one (Codex r3 HIGH).
    echo "db_connect_fence=$($DB_FENCE_UP && echo held || echo released)"
    echo "release_db_connect_fence=${DB_FENCE_RELEASE_CMD}"
  } > "$FENCE_FILE"
  chmod 600 "$FENCE_FILE"
  # DURABILITY. Everything above is a page-cache write until something flushes it, and
  # the one caller that cannot afford that is mark_schema_touched(): the marker exists
  # precisely for the run that is killed or loses power a moment later.
  sync "$FENCE_FILE" 2>/dev/null || sync || true
}

# THE SCHEMA IS ABOUT TO MOVE — SAY SO ON DISK BEFORE IT DOES (o3d-2sm1.4, Codex r3
# CRITICAL).
#
# The flag used to be set in shell memory immediately before Prisma ran, and the marker
# on disk was only refreshed by the exit trap. A kill -9, an OOM kill or a power cut
# during `prisma migrate deploy` never reaches that trap, so the durable marker still
# said `schema_touched=false` — and the next run's adoption, which reads that file and
# nothing else, would RELEASE the connection fence and let the application straight back
# onto a half-migrated schema. That is the CRITICAL the previous round fixed, surviving
# through the one path the trap cannot cover.
#
# So the order here is: set the flag, write the marker, flush it, and only then invoke
# Prisma. Writing it costs one fsync; not writing it costs the exact failure this whole
# script exists to prevent.
mark_schema_touched() {
  # A dry run neither stops nor migrates anything, so the flag stays false and the
  # failure banner keeps telling the truth about a run that touched nothing.
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would record schema_touched=true in ${FENCE_FILE} and flush it BEFORE invoking prisma"
    return 0
  fi
  SCHEMA_TOUCHED=true
  write_fence_marker "migration about to be invoked at $(date -Iseconds)"
  grep -qE '^schema_touched=true$' "$FENCE_FILE" || die \
    "Could not record schema_touched=true in ${FENCE_FILE}. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  ok "Recorded schema_touched=true in ${FENCE_FILE} (flushed) — an interrupted migration is now recoverable."
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

# A FAILED INSTALL LEAVES NOTHING BEHIND (o3d-2sm1.5, Codex r4 CRITICAL).
#
# The marker was written FIRST, then the drop-ins, then the reload, then the verify — and
# every failure after that first line returned 1 into a `|| die` while FENCE_ARMED was still
# false. So the trap did nothing, the marker and the drop-in stayed, and the operator read a
# clean abort: "refusing to stop the predecessor", nothing changed. Nothing had changed
# except an AssertPathExists=! on a marker that now exists — invisible until the next reboot,
# when the unit failed its assertion with nothing on the box connecting that to a deploy that
# had "changed nothing".
#
# So a failed install removes what THIS CALL created, and only that. What was already there
# is left alone: install_reboot_fence is also how an adopted fence is RE-established and how
# the exit trap puts one back, and rolling those back would lift a fence the host needs.
rollback_reboot_fence_install() {
  local dropin
  for dropin in "${FENCE_DROPINS_CREATED[@]}"; do
    [[ -n "$dropin" ]] || continue
    rm -f "$dropin"
    rmdir "$(dirname "$dropin")" 2>/dev/null || true
  done
  if [[ "${#FENCE_DROPINS_CREATED[@]}" -gt 0 ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  # The marker is the condition, so removing it is what actually lifts the fence — which is
  # why it goes only if this call created it AND nothing is relying on it.
  if ! $FENCE_MARKER_PREEXISTED && ! $FENCE_ARMED; then
    rm -f "$FENCE_FILE"
  fi
  FENCE_DROPINS_CREATED=()
  return 0
}

install_reboot_fence() {
  local reason="$1"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would write ${FENCE_FILE} and a ${FENCE_DROPIN_NAME} drop-in per unit, daemon-reload, and verify with systemctl show -p DropInPaths"
    return 0
  fi

  FENCE_MARKER_PREEXISTED=false
  [[ -f "$FENCE_FILE" ]] && FENCE_MARKER_PREEXISTED=true
  FENCE_DROPINS_CREATED=()
  REBOOT_FENCE_INSTALLED=false

  # A HOST WITH NO UNIT TO FENCE CANNOT BE FENCED, AND SAYS SO WITH A NON-ZERO STATUS
  # (o3d-2sm1.5, Codex r4 HIGH). This used to warn and return 0, so the `|| die` at every
  # call site never fired: the predecessor was stopped and the schema migrated with no reboot
  # fence at all, and the failure banner then described one. The validate phase refuses a
  # migration on a unit-less host before anything is stopped; this is the backstop for every
  # other caller, and it never claims a fence it does not have.
  if [[ "${#SERVICE_UNITS[@]}" -eq 0 ]]; then
    echo -e "${RED}[ERROR]${RESET} No systemd unit serves ${APP_DIR_REAL}, so there is NO reboot fence to install:" >&2
    echo -e "${RED}[ERROR]${RESET} nothing would stop the predecessor being started again by hand or by a boot script." >&2
    echo -e "${RED}[ERROR]${RESET} Name the unit with IMS_SERVICE_UNIT=<unit>, or run with --skip-migrate." >&2
    rollback_reboot_fence_install
    return 1
  fi
  command -v systemctl >/dev/null 2>&1 || {
    warn "systemctl is unavailable: there is NO reboot fence."
    rollback_reboot_fence_install
    return 1
  }

  write_fence_marker "$reason"

  local unit dropin
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(fence_dropin_file "$unit")"
    [[ -f "$dropin" ]] || FENCE_DROPINS_CREATED+=("$dropin")
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

  if ! systemctl daemon-reload; then
    echo -e "${RED}[ERROR]${RESET} systemctl daemon-reload failed; the reboot fence is NOT active." >&2
    rollback_reboot_fence_install
    return 1
  fi

  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    verify_reboot_fence "$unit" || { rollback_reboot_fence_install; return 1; }
  done
  REBOOT_FENCE_INSTALLED=true
  # Re-written now that the answer is known. The marker is the file the NEXT run (and the
  # operator after a hard kill) reads, and it was written before the drop-in was verified —
  # so it said `reboot_fence=absent` about a fence that had just been installed.
  write_fence_marker "${reason}"
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
  [[ -f "$DB_FENCE_SCRIPT" ]] || die \
    "${DB_FENCE_SCRIPT} is not in this checkout, so this run cannot hold the database closed for the migration window. A snapshot probe is not a fence. Restore the script (it ships with the app) and re-run; nothing has been migrated."

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local rc=0
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$DB_FENCE_SCRIPT" --fence --state-file="$DB_FENCE_STATE" || rc=$?

  case "$rc" in
    0)
      # THE MIGRATION CONNECTS AS THE ADMIN AND RUNS AS THE APPLICATION ROLE (o3d-2sm1.5).
      # Using the bare admin URL here is what made every object a migration created owned by
      # the deploy superuser, with no grant to the application: the deploy passed — the drift
      # check, the verification hook and pg_dump all share this same admin connection and can
      # read everything — and every request touching the new table then failed with
      # "permission denied". `--print-migration-url` merges `options=-c role=<app role>` into
      # the admin URL, so authentication (and therefore the CONNECT the fence revoked) is
      # still the admin's while ownership is the application's.
      MIGRATION_DATABASE_URL="$(as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
        node "$DB_FENCE_SCRIPT" --print-migration-url)" || die \
        "The connection fence is up but the migration URL could not be composed, so the migration would run as the deploy admin and create objects the application cannot use. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      [[ -n "$MIGRATION_DATABASE_URL" ]] || die \
        "The connection fence is up but --print-migration-url produced nothing. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      DB_FENCE_UP=true
      ok "Connection fence up: new application connections are refused for the window."
      ok "The migration will connect as the deploy admin and RUN AS the application role, so what it creates is owned by the application."
      ;;
    3)
      # EXIT 3 IS "CONNECT WAS NOT REVOKED", AND IT ABORTS (o3d-2sm1.4, Codex r3 HIGH).
      #
      # Round 2 warned and fell back to the point-in-time probe. That was wrong in exactly
      # the way the probe itself was wrong: a sibling server, a cron tick the crontab fence
      # missed, an operator's psql or a `next dev` in another worktree can attach at any
      # moment AFTER the snapshot and write across the migration. A fence we know is absent
      # is not a degraded fence, it is no fence — and the earlier reasoning that a missing
      # admin connection should not block a deploy traded a configuration problem for the
      # data-loss window this whole script exists to close.
      die "THE DATABASE COULD NOT BE FENCED (exit 3): CONNECT was NOT revoked, so nothing stops a client attaching between now and the end of the migration. Refusing to migrate — the reason is printed above. Fix it (usually: set DEPLOY_ADMIN_DATABASE_URL to a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL, see docs/installation.md) and re-run. Nothing has been migrated."
      ;;
    *)
      die "The connection fence failed (exit ${rc}). Nothing has been migrated."
      ;;
  esac
}

# Preflight for the fence, asked while the predecessor is still up and the schema has
# not moved. The database can only answer some of the reasons a fence is impossible (a
# superuser application role, a CONNECT that arrives through role membership), but the
# commonest one by far — no privileged connection at all — is knowable from here, and
# discovering it at drain-verify would cost an outage for a missing environment variable.
require_fenceable_database() {
  # A dry run stops nothing and migrates nothing, so it REPORTS the refusal instead of
  # being it: the point of --dry-run is to find out what a real run would do, and "it would
  # refuse, here is why" is the most useful thing it can print.
  if $DRY_RUN; then
    if [[ -z "$DEPLOY_ADMIN_DATABASE_URL" ]] || [[ ! -f "$DB_FENCE_SCRIPT" ]] || [[ ! -f "$DB_OBJECT_ACCESS_SCRIPT" ]]; then
      warn "A REAL RUN WOULD BE REFUSED HERE: the migration window cannot be fenced."
      warn "DEPLOY_ADMIN_DATABASE_URL is not set (or ${DB_FENCE_SCRIPT##*/} is missing), so CONNECT"
      warn "could not be revoked for the window and nothing would stop a client attaching across"
      warn "the migration. See docs/installation.md. Nothing has been changed by this dry run."
      return 0
    fi
    # The preflight changes nothing, so a dry run may run it for real — and reporting what it
    # actually says is the whole point of --dry-run. It is NOT fatal here: a dry run that
    # cannot reach the database must still exit 0, having said so.
    local dry_rc=0
    as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "$DB_FENCE_SCRIPT" --preflight || dry_rc=$?
    if [[ "$dry_rc" -eq 0 ]]; then
      ok "A REAL RUN WOULD BE FENCEABLE: the preflight above asked the database and it answered yes."
    else
      warn "A REAL RUN WOULD BE REFUSED HERE (fence preflight exit ${dry_rc}); the reason is above."
      warn "Nothing has been changed by this dry run."
    fi
    return 0
  fi
  [[ -n "$DEPLOY_ADMIN_DATABASE_URL" ]] || die \
    "DEPLOY_ADMIN_DATABASE_URL is not set, so this deploy has no privileged connection that would survive revoking CONNECT from the application role — the database cannot be held closed for the migration window. Set it (a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL; docs/installation.md) and re-run. Nothing has been stopped and nothing has been migrated."
  [[ -f "$DB_FENCE_SCRIPT" ]] || die \
    "${DB_FENCE_SCRIPT} is missing from this checkout, so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  [[ -f "$DB_OBJECT_ACCESS_SCRIPT" ]] || die \
    "${DB_OBJECT_ACCESS_SCRIPT} is missing from this checkout, so nothing would check that the application role can use what the migration creates. Nothing has been stopped and nothing has been migrated."

  # AND IT IS RUN, NOT LOOKED AT (o3d-2sm1.5, Codex r4 HIGH). This used to be `[[ -f ... ]]`
  # and nothing more, which proves the file exists and nothing about whether it works. Its
  # own dependency was a devDependency while the documented manual upgrade runs
  # `npm ci --omit=dev`, so the fence died with a missing module at drain-verify — AFTER the
  # stop. An outage for an import. --preflight runs the same imports, opens the same admin
  # connection and asks the same questions as --fence, and revokes, terminates and writes
  # nothing; the only reasons it can fail are the reasons --fence would fail.
  local rc=0
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$DB_FENCE_SCRIPT" --preflight || rc=$?
  [[ "$rc" -eq 0 ]] || die \
    "The migration window could NOT be fenced (fence preflight exit ${rc}); the reason is printed above. Refusing to migrate. Nothing has been stopped and nothing has been migrated."

  ok "A connection fence is possible, and ${DB_FENCE_SCRIPT##*/} proved it by asking the database."
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
    DB_FENCE_UP=false
    ok "Connection fence released."
    return 0
  fi

  echo -e "${RED}[ERROR]${RESET} THE CONNECTION FENCE COULD NOT BE RELEASED. The application role still" >&2
  echo -e "${RED}[ERROR]${RESET} has no CONNECT on this database and cannot start until this is undone:" >&2
  echo -e "${RED}[ERROR]${RESET}   ${DB_FENCE_RELEASE_CMD}" >&2
  echo -e "${RED}[ERROR]${RESET} or, by hand as a superuser, the GRANTs recorded in ${DB_FENCE_STATE}." >&2
  return 1
}

# RE-ESTABLISH A FENCE THE START PHASE ALREADY RELEASED (o3d-2sm1.4, Codex r3 HIGH).
#
# The start phase releases the connection fence and deletes the reboot marker BEFORE
# `systemctl start` and the health check, because the new build cannot serve a database
# it may not connect to. If the start or the health check then fails, SCHEMA_TOUCHED is
# still true and the failure banner used to announce that the fence was HELD — while the
# application role had CONNECT back and the service's own Restart= policy was free to
# reattach. An operator reading "the fence is up" about a fence that is down is worse
# than being told there is none.
#
# So the trap re-fences after it has re-stopped the units, and reports what it actually
# achieved. This is deliberately NOT `fence_db_connections`: that one dies on a failure,
# and dying inside an exit trap loses the status and the banner.
refence_db_connections() {
  $DB_FENCE_UP && return 0
  $DRY_RUN && return 1
  [[ -f "$DB_FENCE_SCRIPT" ]] || return 1
  [[ -n "$DEPLOY_ADMIN_DATABASE_URL" ]] || return 1

  local rc=0
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$DB_FENCE_SCRIPT" --fence --state-file="$DB_FENCE_STATE" || rc=$?
  [[ "$rc" -eq 0 ]] || return 1
  DB_FENCE_UP=true
  # DO NOT SUBSTITUTE THE ADMIN URL WHEN THE COMPOSER REFUSES (o3d-2sm1.5, r6).
  # `--print-migration-url` throws precisely so that a migration can never run AS THE ADMIN
  # while the log announces the application role; catching that throw and assigning
  # DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit. Fail loudly and
  # leave it empty instead: the fence is up, and nothing this trap does next needs the URL.
  local url_rc=0
  MIGRATION_DATABASE_URL="$(as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$DB_FENCE_SCRIPT" --print-migration-url)" || url_rc=$?
  if [[ "$url_rc" -ne 0 || -z "$MIGRATION_DATABASE_URL" ]]; then
    MIGRATION_DATABASE_URL=""
    warn "--print-migration-url refused to compose a migration URL (exit ${url_rc}); NOT falling back to DEPLOY_ADMIN_DATABASE_URL. The fence is up."
  fi
  return 0
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
    # THIS run's backup, so the arming unwind is allowed to restore from it and delete it.
    CRON_BACKUP_CREATED=true
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
#
# DEPLOY_ADMIN_DATABASE_URL is passed alongside DATABASE_URL because the helper scripts
# (check-db-writers.mjs, run-migration-verifications.mjs, check-app-db-object-access.mjs) take
# it as "the connection that survives the fence"; without it in the environment they fall back
# to DIRECT_URL, which on the day anyone sets it is the very role the fence just shut out
# (o3d-2sm1.5, Codex r4 HIGH).
as_app_user_db() {
  if [[ -n "$MIGRATION_DATABASE_URL" ]]; then
    as_app_user env DATABASE_URL="$MIGRATION_DATABASE_URL" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" "$@"
  else
    as_app_user "$@"
  fi
}

# Put the crontab back from the backup THIS run took, whatever fence_cron managed to do
# with it. The authority is the backup file rather than CRON_FENCED: fence_cron raises that
# flag only once `crontab` has returned 0, so a run that rewrote the crontab and then failed
# — or failed halfway through rewriting it — would otherwise never restore anything.
#
# An ADOPTED backup is left alone: it belongs to a previous run's fence, which is still
# standing, and that run's crontab fence must stay up.
restore_cron_from_backup() {
  command -v crontab >/dev/null 2>&1 || return 0
  $CRON_BACKUP_CREATED || return 0
  [[ -f "$CRON_BACKUP" ]] || return 1
  crontab -u "$APP_USER" "$CRON_BACKUP" || return 1
  rm -f "$CRON_BACKUP"
  CRON_FENCED=false
  CRON_BACKUP_CREATED=false
  ok "The ${APP_USER} crontab is back exactly as it was."
  return 0
}

# UNDO THE ARMING PHASE. Called only from the pre-stop branch of the exit trap, where the
# predecessor is still up and the schema has not moved: the correct outcome is that the box
# looks exactly as it did before this run started. It stops nothing, starts nothing, and
# touches only state THIS run created — rollback_reboot_fence_install() removes the
# drop-ins this process wrote and, because FENCE_ARMED is false here, the marker too,
# unless the marker was already there when it was called.
unwind_arming() {
  local unwound=true
  if ! restore_cron_from_backup; then
    unwound=false
    echo -e "${RED}[ERROR]${RESET} The ${APP_USER} crontab could NOT be restored from ${CRON_BACKUP}." >&2
    echo -e "${RED}[ERROR]${RESET} Put it back by hand:  crontab -u ${APP_USER} ${CRON_BACKUP}" >&2
  fi
  rollback_reboot_fence_install
  if [[ -f "$FENCE_FILE" ]] && ! $FENCE_MARKER_PREEXISTED; then
    unwound=false
    echo -e "${RED}[ERROR]${RESET} ${FENCE_FILE} is still there and would refuse the next boot." >&2
    echo -e "${RED}[ERROR]${RESET} Remove it by hand:  rm -f ${FENCE_FILE}" >&2
  fi
  if $unwound; then
    ok "Every change this run had made has been undone; nothing was stopped."
  fi
}

on_exit() {
  local status=$?
  $DEPLOY_OK && exit 0

  # THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH).
  #
  # DEPLOY_OK was only set after the cron restore and the marker removal, so under `set -e` a
  # failing `crontab` reached this trap with the fence still armed — and the trap then STOPPED
  # the service that had just passed its health check, re-fenced it and RE-REVOKED CONNECT. A
  # cron-restore failure became a full outage plus a database lockout on a deploy that had
  # already succeeded, and the rollback was strictly worse than the fault.
  #
  # Past the health check the new build is serving. Nothing below may take that away: the
  # remaining work is cleanup, and a failed cleanup is a thing to fix by hand, not a reason to
  # tear down a working deploy.
  if $PAST_POINT_OF_NO_RETURN; then
    echo ""
    echo -e "${YELLOW}${BOLD}=========================================================================${RESET}"
    echo -e "${YELLOW}${BOLD} THE DEPLOY IS UP — a step AFTER the health check failed${RESET}"
    echo -e "${YELLOW}${BOLD}=========================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    echo -e "  service     : RUNNING and answering ${HEALTH_URL}. It is NOT being stopped:"
    echo -e "                everything that could reject this release has already passed."
    echo -e "  database    : reachable; the connection fence came down before the start."
    if $CRON_FENCED; then
      echo -e "  cron        : may still be FENCED (commented out). Restore it by hand:"
      echo -e "                  crontab -u ${APP_USER} ${CRON_BACKUP}"
    fi
    if [[ -f "$FENCE_FILE" ]]; then
      echo -e "  marker      : ${FENCE_FILE} still exists and would refuse the next boot."
      echo -e "                Remove it once you are happy: rm -f ${FENCE_FILE}"
    fi
    exit "$status"
  fi

  # A FAILURE BEFORE THE STOP IS NOT AN OUTAGE, AND MUST NOT BE TURNED INTO ONE
  # (o3d-2sm1.5, Codex r7 HIGH).
  #
  # FENCE_ARMED used to be raised before `fence_cron`, so every way that cron management can
  # fail — an unwritable backup, a failed chmod, a broken pipeline, a `crontab` that returns
  # non-zero — reached the branch below. That branch STOPS the service, keeps the reboot
  # fence and demands a recovery, and it was doing all of it to a host whose schema had not
  # moved and whose predecessor was still serving. The expensive machinery ran for the
  # cheapest, most reversible step there is.
  #
  # Nothing has been asked to stop yet, so the only correct action is to put back what this
  # run changed and leave the service alone.
  if ! $FENCE_ARMED && $CUTOVER_ARMING; then
    echo ""
    echo -e "${YELLOW}${BOLD}=========================================================================${RESET}"
    echo -e "${YELLOW}${BOLD} DEPLOY FAILED BEFORE THE STOP — THE PREDECESSOR IS STILL SERVING${RESET}"
    echo -e "${YELLOW}${BOLD}=========================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    echo -e "  service     : UNTOUCHED. Nothing was stopped, so nothing needs starting."
    echo -e "  schema      : untouched — the migration was never invoked."
    echo -e "  database    : never fenced; the application still has CONNECT."
    echo ""
    if ! $DRY_RUN; then
      unwind_arming
    fi
    echo ""
    echo -e "  Fix the cause and re-run. Nothing has to be recovered first."
    exit "$status"
  fi

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
      echo -e "                safe state; what the connection fence is doing about it is"
      echo -e "                stated below, once this run has finished making it true."
    elif $FENCE_MASK; then
      echo -e "  schema      : untouched — this run stopped before the migration was invoked."
    fi
    if $FENCE_MASK && $REBOOT_FENCE_INSTALLED; then
      echo -e "  service     : STOPPED, and fenced by a ${FENCE_DROPIN_NAME} drop-in so a"
      echo -e "                reboot cannot start it either while ${FENCE_FILE} exists"
    elif $FENCE_MASK; then
      echo -e "  service     : STOPPED, and there is NO verified reboot fence — a reboot may"
      echo -e "                start the predecessor again. This run re-attempts the install"
      echo -e "                below and says whether it worked."
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
      # THE CONNECTION FENCE IS HELD IF THE SCHEMA WAS TOUCHED, AND ONLY THEN.
      #
      # An earlier round released it here unconditionally, so that a failure could not
      # leave the database unreachable — and that reasoning still holds for every
      # failure BEFORE a migration was attempted, which is why those still release. But
      # once `prisma migrate deploy` has been invoked the schema is in an unknown state,
      # and releasing CONNECT there lets the application reconnect to exactly that. The
      # correct state is unreachable, and stated.
      #
      # "HELD" IS A CLAIM, SO IT IS MADE TRUE BEFORE IT IS PRINTED (Codex r3 HIGH). The
      # start phase releases the fence before `systemctl start` and the health check, so a
      # failure in either arrives here with SCHEMA_TOUCHED true and the fence already
      # DOWN. Re-establish it — the units have just been re-stopped above — and say which
      # of the two actually happened.
      if $SCHEMA_TOUCHED; then
        if ! $DB_FENCE_UP; then
          warn "The connection fence had already been released for the start; re-establishing it."
          refence_db_connections || true
        fi
        if $DB_FENCE_UP; then
          echo -e "${RED}${BOLD} THE CONNECTION FENCE IS DELIBERATELY LEFT UP.${RESET}" >&2
          echo -e "${RED}  A migration was already running when this failed, so the schema may be${RESET}" >&2
          echo -e "${RED}  half-applied. The application role has no CONNECT on this database and${RESET}" >&2
          echo -e "${RED}  must not get it back until a re-run has migrated, checked drift and passed${RESET}" >&2
          echo -e "${RED}  every declared verification. A re-run adopts this fence and recovers${RESET}" >&2
          echo -e "${RED}  through DEPLOY_ADMIN_DATABASE_URL.${RESET}" >&2
          echo -e "${RED}  To release it by hand instead (only once you know the schema is sound):${RESET}" >&2
          echo -e "${RED}    ${DB_FENCE_RELEASE_CMD}${RESET}" >&2
        else
          echo -e "${RED}${BOLD} THE CONNECTION FENCE IS NOT IN PLACE, AND THE SCHEMA MAY HAVE MOVED.${RESET}" >&2
          echo -e "${RED}  This run released it in order to start the new build, and could not put it${RESET}" >&2
          echo -e "${RED}  back. The application role CAN connect to a database whose schema is in an${RESET}" >&2
          echo -e "${RED}  unknown state, so the only thing keeping it off is that the service is${RESET}" >&2
          echo -e "${RED}  stopped and fenced against a reboot. Do NOT start it. Close the database by${RESET}" >&2
          echo -e "${RED}  hand, or re-run this script, which re-establishes the fence before it${RESET}" >&2
          echo -e "${RED}  rebuilds:${RESET}" >&2
          echo -e "${RED}    node ${DB_FENCE_SCRIPT} --fence --state-file=${DB_FENCE_STATE}${RESET}" >&2
        fi
      else
        release_db_connections || true
      fi
      # LAST, so the marker records the fence state that is true when this process
      # exits rather than the one that was true before the re-fence was attempted.
      write_fence_marker "deploy failed at ${CURRENT_STEP}" "${status}"
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

# IS ONE OF THEM A DEVELOPMENT SERVER? (o3d-2sm1.5, r6 CRITICAL)
#
# The selector above matches on WorkingDirectory, and on a stage box the unit that resolves to
# this app dir is `next dev` (ims-stage-dev.service), not `next start`. Such a unit is STILL
# selected on purpose: it is a live writer into this database, so it must be stopped and
# drained for the migration exactly like a production unit. What it cannot do is take part in
# the build-id proof — `next dev` compiles from source and answers with the literal build id
# `development`, which is eleven characters and therefore clears the scrape's length filter.
# Treating that as "the build on disk is NOT serving" made the mismatch branch fire on every
# single run: build, stop, migrate, start, health pass, then a die with the point of no return
# still false, so the trap re-stopped the units it had just correctly started, installed the
# reboot fence and held the CONNECT revoke. A migrated schema, nothing serving and the app role
# locked out of its own database, deterministically. Recorded here so the proof phase can say
# "cannot prove" rather than "proven wrong".
unit_is_dev_server() {
  local unit="$1" exec_start
  exec_start="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null || true)"
  [[ "$exec_start" == *"next dev"* || "$exec_start" == *"run dev"* || "$exec_start" == *"run-dev"* ]]
}

for unit in "${SERVICE_UNITS[@]:-}"; do
  [[ -n "$unit" ]] || continue
  if unit_is_dev_server "$unit"; then
    DEV_SERVER_UNIT=true
    warn "${unit} runs a DEVELOPMENT server (\`next dev\`). It is still stopped and drained for the"
    warn "migration, but it cannot serve a production build id, so the build-id proof after the"
    warn "restart will report 'cannot prove' rather than identifying a stale predecessor."
  fi
done

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
# Did anything PROVE that the build on disk is the process answering the port? Nothing may
# be declared irreversible until it has (o3d-2sm1.5, Codex r5 HIGH).
NEW_BUILD_SERVING=false
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

# AN EFFECTIVE FENCE IS MANDATORY FOR A MIGRATION, and the cheapest half of that answer
# is knowable here — before the stop, while a refusal costs nothing. The rest of it can
# only be had by asking the database, which drain-verify does; that one costs an outage,
# so do not spend it on an unset environment variable.
if ! $SKIP_MIGRATE; then
  # AND SO IS A REBOOT FENCE, WHICH NEEDS A UNIT TO FENCE (o3d-2sm1.5, Codex r4 HIGH).
  #
  # install_reboot_fence() used to warn and return 0 when no unit served this tree, so the
  # `|| die` in the stop phase never fired and the predecessor was stopped and the schema
  # migrated with no reboot fence at all. This is the same reasoning as exit 3 from the
  # connection fence: a fence you know is absent is not a degraded fence, it is no fence.
  # Asked HERE, where a refusal costs nothing.
  #
  # The `nohup npm start` fallback still works for everything that does not move the schema —
  # --skip-migrate and --restart-only are unaffected.
  if [[ "${#SERVICE_UNITS[@]}" -eq 0 ]]; then
    # A dry run stops nothing and migrates nothing, so it REPORTS the refusal instead of being
    # it — the same rule require_fenceable_database follows, and the whole point of --dry-run.
    if $DRY_RUN; then
      warn "A REAL RUN WOULD BE REFUSED HERE: no systemd unit serves ${APP_DIR_REAL}, so the"
      warn "predecessor cannot be fenced against a reboot and a reboot mid-migration would start"
      warn "it again against a migrated schema. Name the unit with IMS_SERVICE_UNIT=<unit>, or"
      warn "use --skip-migrate. Nothing has been changed by this dry run."
    else
      die "No systemd unit serves ${APP_DIR_REAL}, so the predecessor cannot be fenced against a reboot — and a reboot mid-migration would start it again against a migrated schema. Refusing to migrate. Name the unit with IMS_SERVICE_UNIT=<unit>, or run with --skip-migrate (which moves no schema and needs no reboot fence). Nothing has been stopped and nothing has been migrated."
    fi
  fi
  require_fenceable_database
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

# PHASE `arming`. Everything between here and the stop is reversible, and the exit trap
# reverses it: it restores the crontab and removes the drop-in and marker this run wrote,
# WITHOUT stopping anything. Raised before install_reboot_fence, so that even a partial
# install is unwound by the trap as well as by its own rollback.
CUTOVER_ARMING=true

if $FENCE_MASK; then
  install_reboot_fence "cutover started $(date -Iseconds)" \
    || die "Refusing to stop the predecessor without a verified reboot fence: a reboot mid-migration would start it again against a migrated schema."
else
  info "--skip-migrate: no migration will be applied, so no reboot fence is installed."
fi

fence_cron

# PHASE `stopping`. THIS is where the fence is armed, and not one line earlier: from the
# next statement on, something has been asked to stop and nothing may start it again. Every
# failure before this point took the reversible branch above (o3d-2sm1.5, Codex r7 HIGH).
FENCE_ARMED=true

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
# TWO DIFFERENT SCOPES, AND THE UNION OF THEM IS DELIBERATE.
#
#   app_pids  matches by /proc/<pid>/cwd == APP_DIR_REAL, NOT by a bare
#             `pgrep -f next-server`: the old script's pattern also caught the full-chain
#             e2e server, which runs a different tree against a different database.
#   port_pid  matches whatever is LISTENING ON OUR PORT, wherever it lives. That is not
#             directory-scoped and is not meant to be — the drain refuses to migrate while
#             :$PORT is bound, so a listener from another directory has to go too or the
#             deploy stops there instead. It cannot catch the e2e rig, which binds a
#             different port.
#
# Said plainly because a comment here used to claim directory scoping for both.
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

# ---------------------------------------------------------------------------
# WHO ACTUALLY ANSWERED, WHEN A BUILD ID CANNOT SAY (o3d-2sm1.5, Codex r7 HIGH).
#
# DEV_SERVER_UNIT describes the launcher this run INTENDED to start. It says nothing about
# the process that answered the port, and the two are not the same thing: a stale listener,
# an operator's `next dev` in another worktree, or anything else that wins the race for
# :$PORT passes the health poll just as well — and was then left serving the migrated schema
# with the deploy reporting success. "A dev server cannot prove a build id" is a reason to
# look for different evidence, not a reason to stop looking.
#
# So the dev path asks the same question the asset channel asks — is the thing on the port
# the thing this run started? — of the listener itself, and it needs all three answers:
#
#   1. the pid LISTENING on :$PORT belongs to a unit this run just restarted. systemd tears
#      the cgroup down on stop, so a process that survived cannot be inside the new one, and
#      it cannot be a descendant of the new MainPID either;
#   2. its working directory is $APP_DIR_REAL — the tree `next dev` compiles from, which is
#      what "the new code" means for a dev server; and
#   3. it started AFTER this run issued `systemctl start`.
#
# VERIFIED AGAINST THIS HOST'S REAL DEV UNIT before it was made fatal, because the last
# attempt at a fatal dev path (r6) was a deterministic post-migration outage. On
# ims-stage-dev.service the listener is the `next-server` grandchild of the npm MainPID, its
# cgroup is `/system.slice/ims-stage-dev.service` — exactly what `systemctl show -p
# ControlGroup` reports for the unit — its cwd is the app directory, and the start epoch
# computed below equals the unit's ActiveEnterTimestamp to the second. All three answer yes
# for the real dev server and no for anything else holding the port.
# ---------------------------------------------------------------------------

# Wall-clock second at which a process started, from /proc alone. The comm field is
# parenthesised and this box's own listener is literally `(next-server (v16.2.10))`, so
# everything up to the LAST ')' is dropped rather than the first.
proc_start_epoch() {
  local pid="$1" stat rest ticks btime clk
  stat="$(cat "/proc/${pid}/stat" 2>/dev/null)" || return 1
  rest="${stat##*)}"
  ticks="$(awk '{print $20}' <<<"$rest")"
  [[ "$ticks" =~ ^[0-9]+$ ]] || return 1
  btime="$(awk '/^btime /{print $2}' /proc/stat 2>/dev/null)"
  [[ "$btime" =~ ^[0-9]+$ ]] || return 1
  clk="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  [[ "$clk" =~ ^[0-9]+$ && "$clk" -gt 0 ]] || clk=100
  echo "$(( btime + ticks / clk ))"
}

# Is this pid inside the cgroup of one of the units this run restarted?
pid_in_unit_cgroup() {
  local pid="$1" unit unit_cg pid_cg
  pid_cg="$(sed -n 's#^0::##p' "/proc/${pid}/cgroup" 2>/dev/null | head -1)"
  [[ -n "$pid_cg" ]] || pid_cg="$(head -1 "/proc/${pid}/cgroup" 2>/dev/null | cut -d: -f3- || true)"
  [[ -n "$pid_cg" ]] || return 1
  for unit in "${SERVICE_UNITS[@]:-}"; do
    [[ -n "$unit" ]] || continue
    unit_cg="$(systemctl show -p ControlGroup --value "$unit" 2>/dev/null || true)"
    [[ -n "$unit_cg" ]] || continue
    if [[ "$pid_cg" == "$unit_cg" || "$pid_cg" == "${unit_cg}/"* ]]; then
      RESPONDER_UNIT="$unit"
      return 0
    fi
  done
  return 1
}

# The same question by a second route, for a host whose /proc/<pid>/cgroup this cannot read
# (cgroup v1, a container): is the pid a descendant of a restarted unit's MainPID? A process
# that survived the stop is not, because the MainPID is the one this run started.
pid_in_unit_process_tree() {
  local pid="$1" unit main cur hops
  for unit in "${SERVICE_UNITS[@]:-}"; do
    [[ -n "$unit" ]] || continue
    main="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
    [[ "$main" =~ ^[0-9]+$ && "$main" -gt 1 ]] || continue
    cur="$pid"
    hops=0
    while [[ "$cur" =~ ^[0-9]+$ && "$cur" -gt 1 && "$hops" -lt 32 ]]; do
      if [[ "$cur" == "$main" ]]; then
        RESPONDER_UNIT="$unit"
        return 0
      fi
      cur="$(awk '/^PPid:/{print $2}' "/proc/${cur}/status" 2>/dev/null || true)"
      hops=$(( hops + 1 ))
    done
  done
  return 1
}

# All three answers, for every pid holding the port. Any listener that cannot be attributed
# fails the whole proof: "one of them is ours" is not an answer when the question is which
# process the health check reached.
prove_dev_responder() {
  local pids pid cwd started proven=false
  RESPONDER_UNIT=""
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl is unavailable, so nothing here can attribute :${PORT} to a unit this run restarted."
    return 1
  fi
  pids="$(port_pid | grep -E '^[0-9]+$' || true)"
  if [[ -z "$pids" ]]; then
    warn "Nothing listening on :${PORT} can be attributed to a pid (ss -ltnp returned none), so the responder cannot be identified."
    return 1
  fi
  for pid in $pids; do
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    if [[ "$cwd" != "$APP_DIR_REAL" ]]; then
      warn "pid ${pid} holds :${PORT} but runs from ${cwd:-an unreadable working directory}, not ${APP_DIR_REAL}."
      return 1
    fi
    if ! pid_in_unit_cgroup "$pid" && ! pid_in_unit_process_tree "$pid"; then
      warn "pid ${pid} holds :${PORT} but belongs to no unit this run restarted (${SERVICE_UNITS[*]:-none})."
      return 1
    fi
    started="$(proc_start_epoch "$pid" || true)"
    if [[ ! "$started" =~ ^[0-9]+$ ]]; then
      warn "The start time of pid ${pid} could not be read, so nothing shows it post-dates the restart."
      return 1
    fi
    if (( started + DEV_RESPONDER_CLOCK_SLACK < SERVICE_START_EPOCH )); then
      warn "pid ${pid} started $(( SERVICE_START_EPOCH - started ))s BEFORE this run issued systemctl start: it survived the stop and is not what this run started."
      return 1
    fi
    ok "pid ${pid} holds :${PORT}, runs from ${APP_DIR_REAL}, belongs to ${RESPONDER_UNIT} and started after the restart."
    proven=true
  done
  $proven
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
    mark_schema_touched
    echo -e "${YELLOW}[DRY]${RESET}   would run: npx prisma migrate deploy  (as ${APP_USER})"
    echo -e "${YELLOW}[DRY]${RESET}   from that point a failure would HOLD the connection fence rather than release it"
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-prisma-drift.mjs  (as ${APP_USER})"
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-app-db-object-access.mjs  (as ${APP_USER})"
  else
    # FROM HERE THE SCHEMA MAY HAVE MOVED. Recorded ON DISK and flushed BEFORE the
    # command, not after it and not from the exit trap: a migration that is interrupted,
    # times out, half-applies or is SIGKILLed is exactly the case the flag exists for,
    # and a flag that only ever reached shell memory is false for every one of them.
    mark_schema_touched
    as_app_user_db npx prisma migrate deploy --schema prisma/schema.prisma
    ok "Migrations applied."

    info "Validating the deployed schema against prisma/schema.prisma..."
    as_app_user_db node scripts/check-prisma-drift.mjs
    ok "Database schema matches prisma/schema.prisma."

    # AND THAT THE APPLICATION CAN ACTUALLY USE WHAT JUST LANDED (o3d-2sm1.5, Codex r4
    # CRITICAL). Everything above this line — prisma, the drift check, pg_dump — runs on the
    # ADMIN connection, which owns whatever the migration created and can read all of it. The
    # health check hits a route that touches no database. So an ownership mistake in the
    # fenced window was invisible to the entire pipeline: the deploy reported success and
    # every request touching the new table failed with "permission denied". This asks the
    # database about the APPLICATION role, which is the one question none of the others ask.
    info "Checking that the application role can use every table, view and sequence..."
    as_app_user_db node scripts/check-app-db-object-access.mjs --state-file="$DB_FENCE_STATE" \
      || die "The migration left objects the application role cannot use — see above. The new build has NOT been started."
    ok "The application role can use everything in the database."
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

# The instant the restart was issued. The responder proof below requires the process on the
# port to post-date it: anything older survived the stop and is not what this run started.
SERVICE_START_EPOCH=$(date +%s)

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

  # ---------------------------------------------------------------------------
  # WHICH BUILD IS ANSWERING? (o3d-2sm1.5, Codex r5 HIGH)
  #
  # "Something answered the port" is not proof that THIS release is serving, and the point
  # of no return below is armed by it. HEALTH_PATH defaults to /login, which touches no
  # database and which the PREDECESSOR serves just as happily; the BUILD_ID comparison was
  # a `warn`; and when the scrape regex missed, SERVED_ID was empty and the mismatch branch
  # was skipped entirely. So a stale predecessor still holding the port armed the flag — and
  # the trap then explicitly REFUSED to stop it, printing "everything that could reject this
  # release has already passed", leaving the old build serving a migrated schema with the
  # deploy reporting success. Before the point of no return existed, the trap tore that down.
  #
  # So the flag is armed only on POSITIVE proof, and by ONE channel: an asset under
  # /_next/static/<BUILD_ID>/ answering 200. Next matches that prefix against a directory
  # snapshot taken at startup, so only a process whose own build id is that one serves it —
  # a 200 is the new code identifying itself, and it works when HEALTH_PATH is a JSON route
  # with no build id in it.
  #
  # THE SCRAPED BUILD ID IS EVIDENCE, NOT A VERDICT (o3d-2sm1.5, r6 CRITICAL). An earlier
  # round made a scraped id that differs from the one on disk FATAL. That was wrong, and it
  # was an outage on every run of this script on a box whose unit is a dev server: `next dev`
  # answers with the literal build id `development`, eleven characters, so the scrape is
  # non-empty, the mismatch branch fires, and the trap tears down the service it had just
  # correctly started — migrated schema, nothing serving, app role locked out. The scrape is
  # also a regex over whatever HTML the health path happens to return; a page that embeds no
  # build id, embeds a different one, or embeds one behind a CDN is not evidence of a stale
  # predecessor. So a mismatch WARNS and means "not proven". Not proven is still not a pass:
  # without the asset channel nothing below is declared irreversible either way.
  # ---------------------------------------------------------------------------
  if [[ -z "$NEW_BUILD_ID" && -f "${APP_DIR_REAL}/.next/BUILD_ID" ]]; then
    NEW_BUILD_ID="$(cat "${APP_DIR_REAL}/.next/BUILD_ID")"
  fi
  [[ -n "$NEW_BUILD_ID" ]] || die "No BUILD_ID on disk, so nothing can prove which build answered ${HEALTH_URL}."

  # --max-time, like every other curl on this path: without it a server that accepts the
  # connection and then stalls hangs the deploy for ever, post-migration, with the fence
  # already down and no timeout to end it (o3d-2sm1.5, r6).
  SERVED_ID="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null | grep -oE '\\?"b\\?":\\?"[A-Za-z0-9_-]+\\?"' | head -1 | grep -oE '[A-Za-z0-9_-]{10,}' | tail -1 || true)"
  if [[ -n "$SERVED_ID" ]]; then
    if [[ "$SERVED_ID" == "$NEW_BUILD_ID" ]]; then
      info "The build id in what ${HEALTH_URL} served matches disk (${NEW_BUILD_ID})."
    elif [[ "$SERVED_ID" == "development" ]]; then
      warn "${HEALTH_URL} was served by a DEVELOPMENT server (build id 'development'). A dev server compiles from source and can never report the production build id ${NEW_BUILD_ID}, so this is 'cannot prove', not a stale predecessor."
      DEV_SERVER_UNIT=true
    else
      warn "The build id scraped from ${HEALTH_URL} (${SERVED_ID}) is not the build on disk (${NEW_BUILD_ID}). That is NOT proof either way — the scrape is a regex over whatever that path returns. The asset channel below decides."
    fi
  fi

  BUILD_ASSET="$(ls "${APP_DIR_REAL}/.next/static/${NEW_BUILD_ID}" 2>/dev/null | head -1 || true)"
  if [[ -n "$BUILD_ASSET" ]] \
    && curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/_next/static/${NEW_BUILD_ID}/${BUILD_ASSET}" >/dev/null 2>&1; then
    NEW_BUILD_SERVING=true
    ok "The process on port ${PORT} serves /_next/static/${NEW_BUILD_ID}/ — it is this build."
  fi

  if ! $NEW_BUILD_SERVING; then
    if $DEV_SERVER_UNIT; then
      # A DEV UNIT IS A DIFFERENT PROOF, NOT AN EXEMPTION (o3d-2sm1.5, Codex r7 HIGH).
      #
      # This used to be a bare `warn`, after which the script cleared the fence, restored
      # cron and reported a complete deploy with NOTHING having identified the process on
      # the port. DEV_SERVER_UNIT is a property of the unit this run selected; the thing
      # that answered may be anything that won the race for :${PORT}, and it would have been
      # left serving the migrated schema over a green deploy. So the dev path proves the
      # responder's identity directly — see prove_dev_responder() — and fails while the
      # fences are still up if it cannot.
      if prove_dev_responder; then
        DEV_RESPONDER_PROVEN=true
        ok "${HEALTH_URL} is answered by the development server this run restarted, running from ${APP_DIR_REAL}. A dev server compiles from that tree, so the code answering IS the code this run deployed."
      elif $ALLOW_UNIDENTIFIED_DEV_RESPONDER; then
        warn "IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1: finishing WITHOUT having identified the process on :${PORT}."
        warn "Nothing here has shown that what answers ${HEALTH_URL} is this working tree, so the release"
        warn "is NOT declared irreversible and a later failure can still be torn down. Check it by hand."
      else
        die "A development server was expected on :${PORT}, but nothing identified the process that answered ${HEALTH_URL} as a unit this run restarted, running from ${APP_DIR_REAL} and started after the restart — the reason is printed above. The schema has already moved, so this fails with the fences still up rather than reporting success over whatever holds the port. If the identity check itself is what is broken on this host, re-run with IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1, which finishes without declaring the release irreversible."
      fi
    else
      die "Something answered ${HEALTH_URL}, but nothing proved it was BUILD_ID ${NEW_BUILD_ID}. A predecessor still holding port ${PORT} answers that path too, and the schema has already moved. Refusing to declare the release irreversible on the strength of an open port."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# @deploy-phase: unfence-cron
#
# Last, and only once the new build has answered. Restoring cron before the health
# check would hand the queue workers to a server that might still be about to fail.
#
# AND THIS IS PAST THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). The new build is
# serving. Under `set -e` a failing `crontab` used to reach the exit trap with the fence
# still armed, and the trap STOPPED the service that had just passed its health check,
# re-fenced it and re-revoked CONNECT — a full outage and a database lockout because a
# cleanup step failed on a deploy that had already succeeded. From here a failure is
# reported and left for a human; nothing tears the deploy down.
# ---------------------------------------------------------------------------
# ARMED ONLY BY THE PROOF ABOVE. `$NEW_BUILD_SERVING` stays false unless the health phase
# established that the BUILD_ID on disk is the one answering — an open port is not that, and
# the trap's refusal to stop the service is only defensible once it is.
# `$DEV_RESPONDER_PROVEN` is the same standard for a launcher that has no production build id
# to serve: the pid on the port was shown to belong to a unit this run restarted, to run from
# this working tree, and to post-date the restart. Neither is set by an open port.
if $NEW_BUILD_SERVING || $DEV_RESPONDER_PROVEN || $DRY_RUN; then
  PAST_POINT_OF_NO_RETURN=true
fi
# BOTH phase flags come down together. Leaving CUTOVER_ARMING raised here would send a
# failure in the cleanup below — on the one path that reaches it without arming the point of
# no return — into the PRE-STOP branch of the trap, which would report a predecessor that was
# never stopped and unwind a fence that is already gone.
FENCE_ARMED=false
CUTOVER_ARMING=false

CURRENT_STEP="unfence-cron"
step "Restore the cron writers"
unfence_cron
# Already removed with the reboot fence in the start phase; kept so that a run which
# took a different path cannot leave a marker behind that refuses the next boot.
run rm -f "$FENCE_FILE"

DEPLOY_OK=true

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
