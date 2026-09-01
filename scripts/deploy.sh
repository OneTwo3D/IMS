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
# ---------------------------------------------------------------------------
# THE CUTOVER NAMESPACE, AND THERE IS EXACTLY ONE (o3d-2sm1.5, Codex r9 HIGH).
#
# deploy.sh used to keep its marker, cron backup, connection-fence state and lock under
# /var/lib/ims-deploy while install.sh and update.sh kept theirs under the application data
# directory. install.sh's own failure banner nevertheless told the operator that
# scripts/deploy.sh "adopts this fence", and following that instruction ran deploy.sh
# against a namespace holding none of it: no marker to adopt, no cron backup to reuse, no
# connection-fence state to hold — so it took a fresh backup of an ALREADY FENCED crontab,
# rewrote the shared drop-in, and could finish reporting success with the scheduled writers
# still commented out and the previous run's marker orphaned. A documented guarantee the
# code did not deliver.
#
# So all four paths are resolved by the SAME expression in all three scripts. The default is
# the application data directory: that is what the installed unit's AssertPathExists=
# already names, what docs/installation.md documents for a manual fence, and where two of
# the three entrypoints already wrote.
#
# ${IMS_CUTOVER_STATE_DIR} overrides it everywhere; ${IMS_DEPLOY_STATE_DIR} and
# ${IMS_DATA_DIR} are honoured so an operator who already sets either keeps their override.
CUTOVER_STATE_DIR="${IMS_CUTOVER_STATE_DIR:-${IMS_DEPLOY_STATE_DIR:-${IMS_DATA_DIR:-/var/lib/one-two-inventory}}}"
# The old name, kept because everything below already reads it. It is the shared directory
# now, not deploy.sh's private one — which is why nothing here chmods it: it is the
# application's own data directory, and 700 root-owned would take the uploads away from the
# service. The marker and the cron backup carry their own 0600; the connection-fence state
# lives in a 0700 subdirectory owned by ${APP_USER}, who is the identity that writes it.
STATE_DIR="${CUTOVER_STATE_DIR}"
# ONE lock for all three entrypoints. deploy.sh held ${STATE_DIR}/deploy.lock and update.sh
# held ${DATA_DIR}/update.lock, so "refusing to run two cutovers at once" was true of two
# deploys and false of a deploy racing an update; install.sh took no lock at all.
LOCK_FILE="${CUTOVER_STATE_DIR}/cutover.lock"
FENCE_FILE="${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
FENCE_DROPIN_NAME="zz-deploy-fence.conf"
DB_FENCE_DIR="${CUTOVER_STATE_DIR}/deploy"
DB_FENCE_STATE="${DB_FENCE_DIR}/db-connect-fence.json"
# THE ENVIRONMENT THE STARTED SERVICE IS BOUND TO (o3d-2sm1.5 r23, Codex HIGH).
#
# Rounds 13-22 asked, in eleven spellings, WHICH DATABASE THE SERVICE WILL USE, and every answer
# was correct and incomplete for one reason: it was a READ of a file the service reads later and
# somebody else can replace in between. Re-reading closer to the start shortens that window; it
# cannot close it, because `EnvironmentFile=` is read by systemd at the moment it EXECS.
#
# So this round stops checking and BINDS. The value this run validated, fenced and migrated is
# written to a file under the cutover state directory — root-owned, 0600, in a directory the
# application user cannot write — and every unit is given a drop-in that loads THAT file, LAST.
# systemd.exec: "If the same variable is set twice from these files, the files will be read in
# the order they are specified and the later setting will override the earlier setting", and
# "Settings from these files override settings made with Environment=". So whatever
# ${APP_DIR_REAL}/.env has come to say by exec time, DATABASE_URL is the snapshot's.
#
# AND IT IS MANDATORY, WITH NO LEADING `-`. A missing snapshot is then a START FAILURE rather
# than a silent fall-through to the application's own dotenv overlays — the exact difference
# that made a DELETED .env dangerous, since the shipped units load that one with a `-`.
#
# WHY THIS CLOSES THE RACE THE RE-READ COULD NOT. Two systemd reads are involved and they have
# different timing. The SET of environment files is unit CONFIGURATION, fixed at the last
# `daemon-reload` and NOT re-read by `systemctl start`; the CONTENTS are read at exec. This run
# issues the final daemon-reload itself, verifies the loaded list on the bus AFTER it, and
# nothing between that verification and the start runs a unit-file command at all — not an
# explicit daemon-reload and not one of the verbs that reloads IMPLICITLY (r24 moved the unmask
# and the enable above the final reload for exactly that reason) — so the list cannot change
# under it. The contents can be changed only by root, which is not a position this deploy can
# defend against and is not the threat model: the file the check-to-exec race was about was
# writable by the application user and by whatever configuration management writes .env.
# NOT under ${CUTOVER_STATE_DIR}, which is the application's own data directory and therefore
# WRITABLE BY THE APPLICATION USER (o3d-2sm1.5 r23). A binding the service can delete is not a
# binding: the drop-in would then name a file that is gone, and — because it is loaded without a
# leading `-` — the unit would refuse to start. Fail-closed, but an outage the app user could
# cause. This directory is created root-owned and 0700 by publish_db_identity_snapshot().
# AND ITS PATH IS A CONSTANT, NOT AN OVERRIDE (o3d-2sm1.5 r24, Codex HIGH). It used to be
# ${IMS_CUTOVER_ENV_DIR:-/etc/ims-cutover}, and update.sh sources ${APP_DIR}/.env into the
# environment AS ROOT before it resolves this line — so the variable that chose where the
# snapshot goes was one THE APPLICATION USER WRITES. That hands back the entire point of the
# location. publish_db_identity_snapshot() chowns and chmods only the FINAL directory, so a path
# under an app-writable parent is secured after the parent has already been chosen: rename the
# secured child away, put an attacker-owned directory at the same path, and PID 1 reads that
# instead while the bus check and the mandatory-file check both still pass. The same override
# aimed at an existing system directory chmods it to 0700 and takes it out.
#
# There is no configurable spelling of this that is safe. An override only a root-owned source
# may set is indistinguishable from no override, and a trust root read out of the very file the
# snapshot exists to distrust is not a trust root. So it is a literal: a deployment that must
# move it edits this line, which is a root-owned change to a root-owned file, reviewed like any
# other. The same reasoning is why nothing else in this script resolves a privileged path from a
# variable the application can set — see the deploy-control restore after the .env source.
DB_ENV_SNAPSHOT_DIR="/etc/ims-cutover"
DB_ENV_SNAPSHOT_FILE="${DB_ENV_SNAPSHOT_DIR}/db-identity-snapshot.env"
DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"
# The namespace deploy.sh wrote to before this round. Nothing writes here any more, and a
# run that finds state at these paths IMPORTS it into the canonical namespace before it
# changes a unit or a crontab — see import_legacy_cutover_state(). An in-flight fence left
# by the previous version is adopted rather than missed.
LEGACY_CUTOVER_STATE_DIR="${IMS_LEGACY_CUTOVER_STATE_DIR:-/var/lib/ims-deploy}"
LEGACY_FENCE_FILE="${LEGACY_CUTOVER_STATE_DIR}/FENCED"
LEGACY_DB_FENCE_STATE="${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"
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
# --restart-only is --skip-migrate PLUS --skip-build, and one arm below has to tell the two
# apart: a run that delivers new code against a schema nobody checked is the case o3d-1izw is
# open against, and a run that delivers no new code at all is not.
RESTART_ONLY=false
# The flag as the operator typed it, kept so the refusal below can name it rather than
# talking about a variable they never set.
SKIP_MIGRATE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=true ;;
    --skip-build)   SKIP_BUILD=true ;;
    --skip-migrate) SKIP_MIGRATE=true; SKIP_MIGRATE_FLAG="--skip-migrate" ;;
    --restart-only) SKIP_BUILD=true; SKIP_MIGRATE=true; SKIP_MIGRATE_FLAG="--restart-only"; RESTART_ONLY=true ;;
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
# THE PHASE IS ALSO WRITTEN DOWN. A run that is killed never reaches its trap, so the phase
# it had reached has to survive in the marker for the NEXT run to read: write_fence_marker()
# records `phase=arming|stopping`, and adoption resumes an interrupted `arming` — predecessor
# still active, schema untouched — instead of stopping a service nobody had touched
# (o3d-2sm1.5, Codex r8 HIGH). See marker_phase() and resume_from_interrupted_arming().
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
# DID THIS RUN EVER RAISE A CONNECTION FENCE (o3d-2sm1.5, Codex r12 HIGH). DB_FENCE_UP is
# lowered again by every release, so it cannot answer "was there a fence to release at all".
# This one is raised once and never lowered: if it is true and the release then reports that
# it has no record to release FROM, the record this run wrote has been lost underneath it,
# and that is a refusal rather than a warning.
DB_FENCE_RAISED=false
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
# Whether THIS run published the environment snapshot, and which drop-ins it created. The first
# gates the tolerance in env_file_is_sole_database_url_source(): a snapshot loaded by a unit that
# this run did not publish is an unexplained pin, and is refused rather than accepted.
DB_ENV_SNAPSHOT_PUBLISHED=false
DB_ENV_SNAPSHOT_DROPINS_CREATED=()
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

CRON_BACKUP="${CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
LEGACY_CRON_BACKUP="${LEGACY_CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
DB_FENCE_SCRIPT="${APP_DIR_REAL}/scripts/fence-db-connections.mjs"
# ---------------------------------------------------------------------------
# WHICH BYTES OF THAT HELPER MAY RUN WITH DEPLOY_ADMIN_DATABASE_URL (o3d-2sm1.5 r31, Codex
# CRITICAL). ${DB_FENCE_SCRIPT} is under the application-owned checkout, and until this round
# every mode here — preflight, fence, --print-migration-url, release, and the exit trap's
# re-fence — executed it from that path with an administrative database credential in its
# environment. The application account can replace the file between any two of those moments,
# report a fence it never raised, and let the migration run against live writers.
#
# The rule is stated ONCE, in the library below, and shared with update.sh and install.sh: r30
# inverted the precedence in update.sh alone and left this script and install.sh reading the old
# one, which is the same one-rule-several-readers shape a third time. Nothing here resolves a
# fence script of its own; db_fence_script_in_use() does, and it never returns ${DB_FENCE_SCRIPT}.
#
# SOURCED FROM THIS SCRIPT'S OWN DIRECTORY. It is read at startup, out of the same tree and in the
# same instant as the body of this file, so it adds no window this entrypoint does not already
# have — unlike the helper, which is executed several phases later.
IMS_SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=lib/db-fence-protected.sh
source "${IMS_SCRIPT_LIB_DIR}/db-fence-protected.sh" || {
  echo "FATAL: ${IMS_SCRIPT_LIB_DIR}/db-fence-protected.sh could not be sourced. It decides which bytes the connection fence may be executed with, and without it this run cannot fence a migration window. Nothing has been changed." >&2
  exit 1
}
# AND THE CRONTAB EXCLUSION (o3d-p9dq, Codex r26 HIGH). Round 22 gave install.sh an flock over the
# ${APP_USER} crontab and left this script outside it, so every fence, unfence and unwind below was
# an unserialized read-modify-write racing the six server actions that reconcile the same crontab
# from a browser. One protocol, stated once, joined by all three entrypoints.
# shellcheck source=lib/crontab-lock.sh
source "${IMS_SCRIPT_LIB_DIR}/crontab-lock.sh" || {
  echo "FATAL: ${IMS_SCRIPT_LIB_DIR}/crontab-lock.sh could not be sourced. It is the only exclusion between this script's crontab writes and the running application's, and without it a cutover can silently discard a schedule an operator has just saved. Nothing has been changed." >&2
  exit 1
}
# The lock lives inside the service's systemd StateDirectory, which is the same directory this
# script already resolves as its cutover state directory — and the same one the application is
# handed as $STATE_DIRECTORY. The two components come from the library, so no entrypoint has a path
# of its own to get wrong.
crontab_lock_paths "${CUTOVER_STATE_DIR}"
# --dry-run is documented to work unprivileged, and every crontab body it reaches returns after
# printing what it would do and before any write. See the library for why that is the one path
# through with_crontab_lock that does not hold the lock.
CRONTAB_LOCK_DRY_RUN="${DRY_RUN}"
# The identity the fence is TOLD — see resolve_db_identity() below, which is defined after
# env_file_value() because it reads DATABASE_URL out of the same .env. Starts empty so that a run
# which cannot read it refuses instead of fencing an unidentified connection.
#
# ---------------------------------------------------------------------------
# WHAT AN OPERATOR IS TOLD TO RUN (o3d-2sm1.5 r32, Codex HIGH x2)
#
# NOT A COMMAND LINE. r31 fixed which bytes this script executes and left every printed
# instruction describing the world before it, which produced two separate defects of the same
# kind:
#
#   * the printed `--release` line named the protected copy but had NO WAY TO OBTAIN
#     DEPLOY_ADMIN_DATABASE_URL. The helper's `.env` load resolved against its own mirrored
#     location, and the mirror holds no `.env`; the deploy's own copy of the variable lives in
#     THIS shell and not in the operator's. Pasted, it failed while the database stayed fenced.
#   * the re-fence banner — printed at the one moment when the schema has moved and the fence is
#     down — still said `node ${DB_FENCE_SCRIPT} --fence`, the application-owned path, handing the
#     admin credential to whatever is at it.
#
# So both are now ROOT-OWNED WRAPPERS, written by db_fence_publish_operator_wrappers() out of the
# artefact this run resolved, with the state file and the four identity values baked in. They take
# the credential from their own environment or from ${APP_DIR_REAL}/.env with the same reader
# env_file_value() uses, re-verify the artefact digest before exec, and run as ${APP_USER}. There
# is nothing to fill in and nothing to paste wrongly.
#
# AND THE INSTRUCTION IS NOT THE BARE PATH (o3d-2sm1.5 r33, Codex HIGH). Those wrappers are
# root-owned and 0700. The operator most likely to be reading this banner launched the cutover
# with `sudo bash scripts/...` and is back in a NON-ROOT shell, where pasting a bare path gives
# `Permission denied` while the database is still fenced. ${DB_FENCE_SUDO_PREFIX} carries the
# privilege transition, and it is empty only on a box with no sudo — which is a box this run
# cannot have been launched on as anything but root, so the reader is root there.
#
# ONE ASSIGNMENT EACH, and every banner in this file prints these two variables rather than
# composing a command of its own: that is the same "one rule, several readers" discipline the
# fence library exists for, applied to the text.
DB_FENCE_RELEASE_CMD="${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}"
DB_FENCE_REFENCE_CMD="${DB_FENCE_SUDO_PREFIX}${DB_FENCE_REFENCE_WRAPPER}"

# THE ONE PLACE THIS SCRIPT DECIDES WHICH BYTES THE FENCE RUNS, and the one place the recovery
# wrappers are refreshed — so the file that is executed and the file an operator is pointed at can
# never be about different artefacts. Prints the script path; the reason for a refusal is already
# on stderr from the library.
#
# A wrapper that could not be written is a WARNING and not a refusal: it is a convenience file in
# a root-owned directory, and failing a fence over it would trade a real protection for a
# cosmetic one. The path printed in the banners is still the right one to run — a previous run's
# wrapper is very likely standing there — and the warning says the refresh did not happen.
resolve_fence_script() {
  local script
  script="$(db_fence_script_in_use)" || return 1
  db_fence_publish_operator_wrappers "${APP_USER}" "${APP_DIR_REAL}/.env" "${DB_FENCE_STATE}" \
    "${DB_FENCE_IDENTITY_ARGS[@]:-}" \
    || echo "The recovery wrappers at ${DB_FENCE_RELEASE_WRAPPER} and ${DB_FENCE_REFENCE_WRAPPER} could not be refreshed for this run. Anything printed below that names them may be a previous run's copy; check it before running it." >&2
  printf '%s' "$script"
}
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

# THE ONE PLACE A TCP PORT IS DECIDED TO BE A TCP PORT (o3d-2sm1.5 r26, Codex HIGH).
#
# A port that is not a port is not a cosmetic problem here: it is spliced straight into the URL
# the health check polls, and a URL that cannot be reached is indistinguishable from a service
# that did not come up. On the update path that costs a healthy deployment — the poll times out,
# the script stops the service it just started and re-establishes the post-migration fences.
#
# So the shape is checked ONCE, where the value is read, and the run refuses BEFORE anything is
# stopped rather than discovering it after the schema has moved. Decimal digits only, 1-65535,
# and `10#` so a leading zero is a decimal port and not a bash octal error under `set -e`.
valid_tcp_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#$value >= 1 && 10#$value <= 65535 )) || return 1
}

# PORT here comes from the deploy invocation (IMS_PORT), not from an application-owned file, so
# it is not a reader question — but it ends up in HEALTH_URL and in the listener probe exactly as
# update.sh's APP_PORT does, and an unreachable health URL reads as "the new build did not come
# up" in both scripts. Checked here, which is before the build, the stop and the fence.
valid_tcp_port "${PORT}" || die "IMS_PORT must be a decimal TCP port in 1-65535, not '${PORT}'. It becomes ${HEALTH_URL}, which this deploy polls to decide whether the new build came up."

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
# THE APPLICATION'S CONNECTION IDENTITY: SUPPLIED TO THE FENCE, NEVER WORKED OUT BY IT
# (o3d-2sm1.5 r19).
#
# scripts/fence-db-connections.mjs used to derive the host, port, role and database THE
# APPLICATION connects to — first by reading the URL itself, then through node-postgres's own
# resolution, then from the deploy shell's PG* variables, then from the service's environment
# file, then from `systemctl show`. Seven rounds; each answer locally correct; each uncovering
# another layer beneath it — PassEnvironment=, UnsetEnvironment=, wildcard EnvironmentFile=
# globs, the .env.development*/.env.test* overlays Next loads in other modes, a unit with no
# WorkingDirectory=, and DATABASE_URL's own precedence chain. The question is UNBOUNDED, because
# the composition rules belong to systemd, Next and libpq at once and any of them may add a
# layer. So it is no longer asked: the four values are REQUIRED on the fence's command line, and
# a fence that is not given them refuses to fence anything.
#
# THIS is where they come from, and the operator types nothing new for it: DATABASE_URL, split by
# a reader that ACCEPTS ONLY A URL STATING ALL FOUR. That strictness is what CLOSES the question
# rather than narrowing it — PGHOST, PGPORT, PGUSER and PGDATABASE are consulted by libpq and by
# `pg` ONLY for values the connection string leaves out, so a URL that states all four cannot be
# moved by any environment, in any process, under any of those three systems. Everything else —
# no port, no path, more than one path segment, an identity-bearing query parameter, a
# percent-escape this refuses to decode — is a REFUSAL that stops the run before anything is
# stopped or migrated. Never a default, and never a guess at what was meant.
#
# On success it sets DB_IDENTITY_HOST/PORT/USER/DATABASE and DB_FENCE_IDENTITY_ARGS. On failure
# it leaves all of them empty and puts the reason in DB_IDENTITY_REASON; fence_db_connections()
# then dies with that reason rather than fencing a connection nobody has identified.
DB_IDENTITY_HOST=""
DB_IDENTITY_PORT=""
DB_IDENTITY_USER=""
DB_IDENTITY_DATABASE=""
DB_IDENTITY_REASON="DATABASE_URL has not been read yet"
DB_FENCE_IDENTITY_ARGS=()

resolve_db_identity() {
  local url="${1:-}" rest authority userinfo hostport path host port user database query
  local -a pairs
  DB_IDENTITY_HOST=""; DB_IDENTITY_PORT=""; DB_IDENTITY_USER=""; DB_IDENTITY_DATABASE=""
  DB_FENCE_IDENTITY_ARGS=()

  if [[ -z "$url" ]]; then
    DB_IDENTITY_REASON="DATABASE_URL is not set, so there is no application connection to name"
    return 1
  fi
  case "$url" in
    postgres://*)   rest="${url#postgres://}" ;;
    postgresql://*) rest="${url#postgresql://}" ;;
    *) DB_IDENTITY_REASON="DATABASE_URL does not begin with postgres:// or postgresql://"; return 1 ;;
  esac
  case "$rest" in
    */*) authority="${rest%%/*}"; path="${rest#*/}" ;;
    *)   DB_IDENTITY_REASON="DATABASE_URL states no database: there is no /<database> after the host"; return 1 ;;
  esac
  # The userinfo ends at the LAST '@' of the authority, which is the rule both WHATWG URL and
  # node-postgres follow, and it is the only reason a password containing '@' works at all.
  case "$authority" in
    *@*) userinfo="${authority%@*}"; hostport="${authority##*@}" ;;
    *)   DB_IDENTITY_REASON="DATABASE_URL states no role: there is no user@ in front of the host"; return 1 ;;
  esac
  user="${userinfo%%:*}"
  case "$hostport" in
    \[*\]:*) host="${hostport%%]:*}]"; port="${hostport##*]:}" ;;
    \[*)     DB_IDENTITY_REASON="DATABASE_URL states no port for the address ${hostport}"; return 1 ;;
    *:*)     host="${hostport%:*}";    port="${hostport##*:}" ;;
    *)       DB_IDENTITY_REASON="DATABASE_URL states no port: without one the connection takes PGPORT, or 5432, and which server it reaches is not stated by the URL"; return 1 ;;
  esac
  database="${path%%\?*}"
  query=""
  case "$path" in *\?*) query="${path#*\?}" ;; esac

  [[ -n "$user" ]]     || { DB_IDENTITY_REASON="DATABASE_URL states an empty role"; return 1; }
  [[ -n "$host" ]]     || { DB_IDENTITY_REASON="DATABASE_URL states an empty host"; return 1; }
  [[ -n "$database" ]] || { DB_IDENTITY_REASON="DATABASE_URL states an empty database name"; return 1; }
  case "$database" in */*) DB_IDENTITY_REASON="DATABASE_URL has more than one path segment (${path}), so which of them is the database is not stated"; return 1 ;; esac
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || { DB_IDENTITY_REASON="DATABASE_URL states the port '${port}', which is not a port number"; return 1; }
  # PERCENT-ESCAPES ARE REFUSED, NOT DECODED. Decoding is a reimplementation, and this reader
  # exists because reimplementations were the problem; a role or database written with one must
  # be written plainly, or the fence is not run.
  case "${user}${host}${database}" in *%*) DB_IDENTITY_REASON="DATABASE_URL percent-escapes part of its role, host or database, and this will not decode it — write them plainly or run with --skip-migrate"; return 1 ;; esac
  # WHITESPACE would also be a value this cannot hand on unambiguously.
  case "${user}${host}${database}${port}" in *[[:space:]]*) DB_IDENTITY_REASON="DATABASE_URL states a role, host or database containing whitespace"; return 1 ;; esac
  # AND NOT ONE PERCENT ESCAPE ANYWHERE IN THE QUERY STRING (o3d-2sm1.5 r20, Codex CRITICAL).
  # The scan below compares RAW key bytes, and the driver does not: pg-connection-string runs the
  # query through URLSearchParams, which decodes the KEY as well as the value. Measured against
  # the installed pg-connection-string, `?ho%73t=other-cluster` yields host=other-cluster,
  # `?po%72t=6543` yields port=6543 and `?u%73er=other` yields user=other — every one of them past
  # a scan looking for `host`, `port` and `user`. So the URL's authority would state four values,
  # this reader would hand those four to the fence, and the application would connect to a
  # different cluster: the fence, the migration and the release all correct about a database
  # nothing uses. Decoding it here to compare properly is the reimplementation this reader exists
  # to avoid, so ANY escape in the query is refused instead — the same answer the role, host and
  # database already get one check above, applied to the part that names them again.
  if [[ -n "$query" ]]; then
    case "$query" in *%*) DB_IDENTITY_REASON="DATABASE_URL percent-escapes something in its query string, and this will not decode it to find out whether the escape spells host, port, user or dbname — node-postgres decodes query KEYS, so ?ho%73t= reaches the driver as host= and moves the connection off the address the URL states. Write the query plainly, or run with --skip-migrate"; return 1 ;; esac
  fi
  if [[ -n "$query" ]]; then
    IFS='&' read -r -a pairs <<<"$query"
    local pair name
    for pair in "${pairs[@]}"; do
      name="${pair%%=*}"
      case "$name" in
        host|port|user|dbname|database)
          DB_IDENTITY_REASON="DATABASE_URL carries ?${name}= in its query string, which node-postgres uses in preference to the authority — so the URL does not connect where it appears to. Delete it"
          return 1 ;;
      esac
    done
  fi

  DB_IDENTITY_HOST="$host"
  DB_IDENTITY_PORT="$port"
  DB_IDENTITY_USER="$user"
  DB_IDENTITY_DATABASE="$database"
  DB_IDENTITY_REASON=""
  DB_FENCE_IDENTITY_ARGS=(
    "--app-host=${host}"
    "--app-port=${port}"
    "--app-user=${user}"
    "--app-database=${database}"
  )
  return 0
}

# The refusal every fence mode goes through: four values or nothing happens.
require_db_identity() {
  [[ "${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]] && return 0
  return 1
}

# ---------------------------------------------------------------------------
# IS THE FILE WE READ THE ONLY THING THAT CAN DEFINE DATABASE_URL FOR THIS SERVICE?
# (o3d-2sm1.5 r20, Codex CRITICAL; r21 asks systemd's BUS instead of its text output)
#
# r19 moved the identity from "worked out by the fence" to "supplied by the entrypoint", and the
# entrypoint supplies it out of ${APP_DIR_REAL}/.env. That is the PREVIOUS PROBLEM ONE LEVEL UP: an
# `Environment=DATABASE_URL=...` directive, a drop-in that adds one, a `PassEnvironment=` entry, a
# `PAMName=` whose PAM stack exports one, or a second `EnvironmentFile=` can put a different URL in
# the service's environment, and dotenv does NOT overwrite a variable that is already set. The
# fence, the migration and the release would then all be self-consistent about the .env database
# while the restarted application connects elsewhere — a migration run on a database nothing was
# fenced off, and a new build started against a database nothing migrated.
#
# THIS DOES NOT REBUILD THE INFERENCE r19 DELETED, and the difference is the whole design. It
# computes no value and reproduces no precedence. It asks ONE existence question about ONE
# variable:
#
#     can anything other than the file we read define DATABASE_URL for this unit?
#
# systemd answers that directly, because it reports the COMPOSED Environment=, EnvironmentFiles=,
# PassEnvironment=, UnsetEnvironment= and PAMName= with every drop-in already folded in by systemd
# itself. Asking whether a second definition EXISTS is bounded; working out which of several would
# WIN is the unbounded question, and it is never asked — any answer but "only that file" is a
# refusal that names what else defines it and tells the operator to state the identity explicitly.
# A second environment file is refused WITHOUT being read, for the same reason: that it may define
# the variable is enough, and reading it to find out would put the precedence question straight
# back. A non-empty PAMName= is refused without reading PAM configuration, for that same reason
# again.
#
# IT IS ASKED OF THE BUS, NOT OF `systemctl show` (r21, Codex CRITICAL). Two of r20's three
# findings were text-parsing bugs and only text-parsing bugs: `systemctl show` renders a property
# as one `Name=` line of space-joined values, so where one entry of an ARRAY ends and the next
# begins has to be guessed at — and `EnvironmentFiles` is an array of (path, ignore_errors) PAIRS
# whose rendering the previous reader truncated at the first ` (ignore_errors=`. `busctl` — the
# same package, on every host that has systemctl — prints the property's SIGNATURE and the array's
# own ELEMENT COUNT before the elements:
#
#     a(sb) 1 "/opt/app/.env" true          as 2 "NODE_ENV=production" "PORT=3000"          s ""
#
# so "is there more than one environment file?" is answered by systemd's own data structure. The
# count is read from the rendering and checked against the number of elements found in it; a
# disagreement is a refusal. Nothing is inferred from where a space falls, and a string systemd had
# to escape (busctl prints strings through `cescape()`) is REFUSED rather than decoded — decoding
# it here would be one more reimplementation of somebody else's rules.
#
# EVERY ENVIRONMENT PROPERTY IS THEN MATCHED THE SAME WAY: on the NAME of each element, which is
# everything before its first `=`. That is what makes `UnsetEnvironment=DATABASE_URL=<the value in
# the .env>` a refusal (r21, Codex HIGH): systemd.exec takes "a space-separated list of variable
# names or variable assignments", removes an exact assignment as the FINAL step of composing the
# environment, and a scan for the bare token `DATABASE_URL` sees no such token in it — after which
# the application's own dotenv loader supplies whatever `.env.local` says. The same rule applies to
# Environment=, PassEnvironment= and UnsetEnvironment= alike, so no spelling of any of them is
# matched by a substring.
#
# THE FILE MUST ALSO BE ONE SYSTEMD ITSELF LOADS. If the unit loads no environment file, the
# variable reaches the application through the application's OWN loader instead, by rules that
# belong to Next and not to systemd — `.env.local` and the per-mode overlays, which is precisely
# the layer r19 stopped reproducing. So that is a refusal too, and it says which line to add.
#
# WHAT IT CANNOT SEE, STATED RATHER THAN PAPERED OVER: an `ExecStart=` that runs a wrapper which
# exports DATABASE_URL itself is invisible to systemd's own properties, because that definition
# lives inside a program rather than in the unit. Closing that would mean reading programs, which
# is unbounded again. It is the standing argument for making the four values a DEPLOYMENT-OWNED
# CONFIGURATION INPUT that these scripts read outright, instead of deriving them from a URL that
# is only probably the one the service uses (o3d-1yvh, docs/installation.md).
DB_IDENTITY_SOURCE_REASON="the service's environment has not been asked about yet"
BUS_STRINGS=()

# THE STRINGS IN ONE `busctl` RENDERING, in order, STILL ESCAPED.
#
# busctl prints every string through `cescape()`, so a `"` inside a value arrives as `\"` and
# cannot end it early. This walks the rendering with that one rule and keeps the escapes: the
# callers compare against names and paths that contain none, and refuse anything that does.
# Returns 1 for a rendering whose quoting does not close, which is a rendering this cannot read.
bus_read_strings() {
  local text="${1:-}" index=0 length char current='' inside=0
  BUS_STRINGS=()
  length=${#text}
  while (( index < length )); do
    char="${text:index:1}"
    if (( inside )); then
      if [[ "$char" == '\' ]]; then
        (( index + 1 < length )) || return 1
        index=$(( index + 1 ))
        current+="\\${text:index:1}"
      elif [[ "$char" == '"' ]]; then
        BUS_STRINGS+=("$current")
        current=''
        inside=0
      else
        current+="$char"
      fi
    elif [[ "$char" == '"' ]]; then
      inside=1
      current=''
    fi
    index=$(( index + 1 ))
  done
  (( inside == 0 )) || return 1
  return 0
}

# THE ELEMENT COUNT systemd states in front of an array, for the signature we asked for.
#
# This is the number that makes the question bounded: it comes from the array, not from counting
# separators in a line. A rendering of another signature — or none — is not an answer, and the
# caller refuses.
bus_array_count() {
  local text="${1:-}" signature="${2:-}" rest
  [[ "$text" == "${signature} "* ]] || return 1
  rest="${text#"${signature}" }"
  rest="${rest%% *}"
  [[ "$rest" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$rest"
}

# One property of one unit, as systemd's own bus states it.
bus_unit_property() {
  busctl get-property org.freedesktop.systemd1 "${1:-}" "org.freedesktop.systemd1.${2:-}" "${3:-}" 2>/dev/null
}

# Does this element of an environment property NAME DATABASE_URL? Everything before the first `=`
# is the name, so `DATABASE_URL`, `DATABASE_URL=postgresql://...` and an assignment carrying any
# value at all are one answer, and `NEXT_PUBLIC_DATABASE_URL=...` is not.
bus_element_names_database_url() {
  [[ "${1%%=*}" == "DATABASE_URL" ]]
}

# THE `ignore_errors` HALF OF EnvironmentFiles=, which is an `a(sb)` and not an `as`
# (o3d-2sm1.5 r23, Codex HIGH). bus_read_strings() reads the paths and drops the booleans; the
# snapshot check needs them, because a snapshot loaded with a leading `-` is not a binding at
# all — systemd would SKIP it if it were missing and hand the service back to whatever else
# defines DATABASE_URL, which is the failure this round exists to remove.
#
# Every quoted element is removed first, which leaves the signature, systemd's own element count
# and the booleans in order. Nothing here reimplements systemd's escaping: the callers already
# refuse any element that had to be escaped.
BUS_ENV_IGNORE_FLAGS=()
bus_read_env_ignore_flags() {
  local text="${1:-}" stripped word index=0
  BUS_ENV_IGNORE_FLAGS=()
  stripped="$(printf '%s' "$text" | sed 's/"\(\\.\|[^"\\]\)*"/ /g')" || return 1
  local IFS=' '
  local -a words=()
  # shellcheck disable=SC2206  # deliberate word split on the space-separated rendering
  words=($stripped)
  for (( index = 2; index < ${#words[@]}; index++ )); do
    word="${words[index]}"
    case "$word" in
      true|false) BUS_ENV_IGNORE_FLAGS+=("$word") ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# Does the caller also REQUIRE the environment snapshot to be loaded? False everywhere the
# question is only "is anything else defining DATABASE_URL"; true at the one call site that is
# about to hand the units to systemd (o3d-2sm1.5 r23).
DB_IDENTITY_REQUIRE_SNAPSHOT=false

env_file_is_sole_database_url_source() {
  local env_file="${1:-}"; shift || true
  local -a units=("$@")
  local unit object rendering count element expected resolved load_state pam_name snapshot_expected

  DB_IDENTITY_SOURCE_REASON=""
  expected="$(readlink -f "$env_file" 2>/dev/null || printf '%s' "$env_file")"
  snapshot_expected="$(readlink -f "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || printf '%s' "$DB_ENV_SNAPSHOT_FILE")"

  if [[ "${#units[@]}" -eq 0 || -z "${units[0]}" ]]; then
    DB_IDENTITY_SOURCE_REASON="no systemd unit was identified for the application, so there is nothing that can say whether ${env_file} is what gives it DATABASE_URL"
    return 1
  fi
  if ! command -v busctl >/dev/null 2>&1; then
    DB_IDENTITY_SOURCE_REASON="busctl — systemd's own bus client, shipped beside systemctl — is not available, so whether anything other than ${env_file} defines DATABASE_URL for the service cannot be established"
    return 1
  fi

  for unit in "${units[@]}"; do
    [[ -n "$unit" ]] || continue

    # LoadUnit, not GetUnit: it answers for a unit the manager has not loaded yet as well, so the
    # LoadState below is what says whether there is a readable unit there at all. It is the same
    # load `systemctl show` performs — it starts nothing and queues no job.
    rendering="$(busctl call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s "$unit" 2>/dev/null)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 || -z "${BUS_STRINGS[0]}" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not say where ${unit} lives on its bus, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    object="${BUS_STRINGS[0]}"

    rendering="$(bus_unit_property "$object" Unit LoadState)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer for ${unit}'s LoadState, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    load_state="${BUS_STRINGS[0]}"
    if [[ "$load_state" != "loaded" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd reports ${unit} as '${load_state:-unknown}' rather than loaded, so what defines DATABASE_URL for it cannot be read"
      return 1
    fi

    # PAMName=, which the five-property question did not ask (r21, Codex CRITICAL). systemd.exec
    # lists "variables set by any PAM modules in case PAMName= is in effect" AFTER the
    # EnvironmentFile= layer and says the later source wins, so a unit naming a PAM profile whose
    # stack runs pam_env can be handed a DATABASE_URL that beats the file this deploy read — while
    # every other property here still says "only that file". What a PAM stack supplies is not
    # knowable without reading PAM configuration, so ANY non-empty value is refused.
    rendering="$(bus_unit_property "$object" Service PAMName)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer for ${unit}'s PAMName=, so whether a PAM stack also defines DATABASE_URL for it is unknown"
      return 1
    fi
    pam_name="${BUS_STRINGS[0]}"
    if [[ -n "$pam_name" ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} sets PAMName=${pam_name}, and systemd applies the variables its PAM modules set AFTER the environment file — the later source wins. Whether that stack exports DATABASE_URL is a question about PAM configuration this will not read, so it is refused rather than guessed at. Remove PAMName=, or state the connection identity explicitly"
      return 1
    fi

    # The three environment lists, all matched on the element NAME. UnsetEnvironment= takes a name
    # OR an exact assignment and is applied as the final composition step, so the assignment form
    # is the same refusal as the bare name (r21, Codex HIGH).
    local property description
    for property in Environment PassEnvironment UnsetEnvironment; do
      rendering="$(bus_unit_property "$object" Service "$property")" || rendering=''
      if ! count="$(bus_array_count "$rendering" 'as')" || ! bus_read_strings "$rendering" \
        || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
        DB_IDENTITY_SOURCE_REASON="systemd would not answer readably for ${unit}'s ${property}=, so what defines DATABASE_URL for that service is unknown"
        return 1
      fi
      for element in ${BUS_STRINGS[@]+"${BUS_STRINGS[@]}"}; do
        bus_element_names_database_url "$element" || continue
        case "$property" in
          Environment) description="sets DATABASE_URL in its own Environment= (${element%%=*}=…). systemd puts that in the service's environment and dotenv will not overwrite an already-set variable, so the application connects where THAT says and not where ${env_file} says" ;;
          PassEnvironment) description="lists DATABASE_URL in PassEnvironment=, so the service inherits whatever the service manager's own environment holds and ${env_file} does not decide where the application connects" ;;
          *) description="lists DATABASE_URL in UnsetEnvironment= (as '${element}'), so systemd removes the value ${env_file} supplies — as the final step of composing the environment, whether it is written as a name or as an exact assignment — and the application's own loader decides what replaces it" ;;
        esac
        DB_IDENTITY_SOURCE_REASON="${unit} ${description}. Remove it, or state the connection identity explicitly"
        return 1
      done
    done

    # EnvironmentFiles=, an array of (path, ignore_errors) pairs. EXACTLY ONE entry, and it must
    # be ours: the count is systemd's own, so a second file cannot hide behind the rendering.
    rendering="$(bus_unit_property "$object" Service EnvironmentFiles)" || rendering=''
    if ! count="$(bus_array_count "$rendering" 'a(sb)')" || ! bus_read_strings "$rendering" \
      || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer readably for ${unit}'s EnvironmentFiles=, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    if [[ "$count" -eq 0 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} does not load ${env_file} with EnvironmentFile=, so DATABASE_URL reaches the application through its own dotenv loader instead — whose .env.local and per-mode overlays are exactly the composition this deploy stopped reproducing. Add EnvironmentFile=${env_file} to the unit, or state the connection identity explicitly"
      return 1
    fi
    # ONE ENVIRONMENT FILE, OR TWO OF WHICH THE SECOND IS THIS RUN'S OWN SNAPSHOT
    # (o3d-2sm1.5 r23, Codex HIGH). Until this round the answer was "exactly one, and it must be
    # ${env_file}" — which is the right refusal for somebody ELSE's second file and the wrong one
    # for the binding this round adds, since publish_db_identity_snapshot() gives every unit a
    # drop-in that loads ${DB_ENV_SNAPSHOT_FILE} after it. So the shape is stated exactly: the
    # application's file first, and at most one more, which may only be the snapshot THIS RUN
    # published. A snapshot left behind by some earlier run is NOT tolerated — DB_ENV_SNAPSHOT_PUBLISHED
    # is false until this run writes one — because an unexplained pin is a DATABASE_URL nobody
    # here chose, which is precisely the condition this function exists to refuse.
    if [[ "$count" -gt 2 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} loads ${count} environment files (${BUS_STRINGS[*]}). Whether any of them but ${env_file} defines DATABASE_URL, and which definition systemd would keep, is composition this will not reproduce — so it is refused rather than guessed at, and without reading them. Load only ${env_file}, or state the connection identity explicitly"
      return 1
    fi
    if ! bus_read_env_ignore_flags "$rendering" || [[ "${#BUS_ENV_IGNORE_FLAGS[@]}" -ne "$count" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not say readably whether ${unit} loads its environment files with a leading '-'. Whether a missing file is skipped or fatal decides what the service gets when one disappears, so it is refused rather than assumed"
      return 1
    fi
    local index
    for index in 0 1; do
      [[ "$index" -lt "$count" ]] || continue
      element="${BUS_STRINGS[index]}"
      case "$element" in
        *'\'*)
          DB_IDENTITY_SOURCE_REASON="systemd reports one of ${unit}'s environment files as ${element}, a path it had to escape to state. Decoding that here to compare it with ${env_file} is a reimplementation of somebody else's escaping, so it is refused: give the unit an EnvironmentFile= path with no character needing an escape, or state the connection identity explicitly"
          return 1 ;;
      esac
      resolved="$(readlink -f "$element" 2>/dev/null || printf '%s' "$element")"
      if [[ "$index" -eq 0 ]]; then
        if [[ "$resolved" != "$expected" ]]; then
          DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} as its first environment file and not ${env_file}, so the file this deploy read is not the one that gives the service DATABASE_URL. Load ${env_file}, or state the connection identity explicitly"
          return 1
        fi
        continue
      fi
      # THE SECOND ENTRY, WHICH MAY ONLY BE THE BINDING. Three things are required of it and each
      # is load-bearing: it is the snapshot's path (anything else is a source of DATABASE_URL this
      # deploy did not write), THIS run published it (an old one pins a value nobody re-validated),
      # and it is loaded WITHOUT a leading '-' (with one, deleting it between here and the exec
      # takes the binding away silently and hands the service back to ${env_file}).
      if ! $DB_ENV_SNAPSHOT_PUBLISHED; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads a second environment file, ${element}, that this run did not publish. A second file can define DATABASE_URL and systemd keeps the LAST definition, so what the service would connect to is not ${env_file}'s answer. Remove it (if it is a ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in, an earlier cutover left it behind and it is safe to delete), or state the connection identity explicitly"
        return 1
      fi
      if [[ "$resolved" != "$snapshot_expected" ]]; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} as a second environment file, and this run's environment snapshot is ${DB_ENV_SNAPSHOT_FILE}. A second file can define DATABASE_URL and systemd keeps the LAST definition, so the service would connect where that file says. Remove it, or state the connection identity explicitly"
        return 1
      fi
      if [[ "${BUS_ENV_IGNORE_FLAGS[index]}" != "false" ]]; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} with a leading '-', so systemd SKIPS it if it is missing instead of failing the start. The whole point of the snapshot is that its absence stops the service rather than handing it back to ${env_file}; drop the '-' from the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in"
        return 1
      fi
    done
    # AND WHEN THE CALLER IS ABOUT TO START THE SERVICE, THE BINDING MUST BE THERE. Everywhere
    # else this function is a refusal of extra sources; at the start it is also the proof that the
    # one source that cannot be replaced under us is loaded.
    if $DB_IDENTITY_REQUIRE_SNAPSHOT && [[ "$count" -ne 2 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} does not load this run's environment snapshot ${DB_ENV_SNAPSHOT_FILE}, so the DATABASE_URL it gets at exec is whatever ${env_file} says at that moment and not the one this run fenced and migrated"
      return 1
    fi
  done
  return 0
}

# The refusal every fence mode goes through, beside require_db_identity: four values, AND a
# service whose DATABASE_URL nothing but that file can define.
require_env_file_is_sole_definition() {
  env_file_is_sole_database_url_source "${APP_DIR_REAL}/.env" "${SERVICE_UNITS[@]:-}"
}

# Read once, from the file the application itself is given. A failure is NOT fatal here: a
# --skip-migrate run fences nothing and needs none of this. It is fatal at the point it matters,
# in fence_db_connections() below, where the reason is printed and the deploy stops before
# anything is stopped or migrated.
resolve_db_identity "$(env_file_value DATABASE_URL "${APP_DIR_REAL}/.env")" || true

# ---------------------------------------------------------------------------
# AND RE-READ, BECAUSE SYSTEMD READS THAT FILE LATER THAN THIS DID
# (o3d-2sm1.5 r22, Codex HIGH).
#
# The line above is the ONLY read, and it happens while the predecessor is still serving —
# before the build, before the stop, before the migration. `EnvironmentFile=` is read by systemd
# at the moment it EXECS the service, at the far end of that window. r21's sole-source check
# closed "is this the file the service uses?" by asking the bus; it compares the configured PATH,
# and a path is not its contents. So an atomic replacement, a `rm`, or a symlink retarget in
# between still moves the connection: this run fences and migrates database A, and the service
# starts on database B. The shipped units load the file with a leading `-`, which makes a MISSING
# file skipped rather than fatal — so a deletion does not even fail loudly, it hands the
# application back to its own dotenv overlays, the exact composition r19 stopped reproducing.
#
# THIS IS NOT A RETURN TO INFERRING THE ENVIRONMENT. Nothing new is consulted and no precedence
# is reproduced: the file is still the single configured source, still proven sole by the bus
# read, and still parsed by the same strict reader with the same refusals. What changes is WHEN.
# A value read once and used much later is a time-of-check/time-of-use gap, which is the defect
# class the sibling branch closed on its dispatch fence — and the answer is the same one: re-run
# the check at the point of use rather than trusting the cached answer.
#
# THE PINNED IDENTITY IS THE BASELINE, AND IT NEVER MOVES. Every re-read is compared against
# these four values and never adopted over them, because everything this run has already done —
# the fence it raised, the database it migrated, the release command it printed — is about THIS
# database. A file that has come to say something else is a refusal, not a new instruction.
DB_IDENTITY_PINNED_HOST="$DB_IDENTITY_HOST"
DB_IDENTITY_PINNED_PORT="$DB_IDENTITY_PORT"
DB_IDENTITY_PINNED_USER="$DB_IDENTITY_USER"
DB_IDENTITY_PINNED_DATABASE="$DB_IDENTITY_DATABASE"
DB_IDENTITY_DRIFT_REASON="the environment file has not been re-read yet"

# Re-read ${APP_DIR_REAL}/.env and require it to still state the pinned identity.
#
# IT RESTORES THE GLOBALS IT BORROWS, unconditionally. resolve_db_identity() writes
# DB_IDENTITY_* and CLEARS DB_FENCE_IDENTITY_ARGS as its first act, and those arguments are what
# release_db_connections() and the exit trap's re-fence are built from. A re-read that failed and
# left them empty would disarm the release on the one path where the fence is standing — turning
# a detection into the outage it exists to prevent.
env_file_identity_unchanged() {
  local env_file="${APP_DIR_REAL}/.env"
  DB_IDENTITY_DRIFT_REASON=""

  if [[ -z "${DB_IDENTITY_PINNED_HOST}${DB_IDENTITY_PINNED_PORT}${DB_IDENTITY_PINNED_USER}${DB_IDENTITY_PINNED_DATABASE}" ]]; then
    DB_IDENTITY_DRIFT_REASON="no connection identity was pinned when this run started, so there is nothing to re-read ${env_file} against"
    return 1
  fi
  if [[ ! -e "$env_file" ]]; then
    DB_IDENTITY_DRIFT_REASON="${env_file} no longer exists. The service units load it with a leading '-', so systemd SKIPS a missing environment file instead of failing on it, and the application would start on whatever its own dotenv overlays supply — not on the database this run fenced and migrated"
    return 1
  fi
  if [[ ! -f "$env_file" || ! -r "$env_file" ]]; then
    DB_IDENTITY_DRIFT_REASON="${env_file} is no longer a readable regular file, so what it will give the service when systemd execs it cannot be read here"
    return 1
  fi

  local saved_host="$DB_IDENTITY_HOST" saved_port="$DB_IDENTITY_PORT"
  local saved_user="$DB_IDENTITY_USER" saved_database="$DB_IDENTITY_DATABASE"
  local saved_reason="$DB_IDENTITY_REASON"
  local -a saved_args=()
  if [[ "${#DB_FENCE_IDENTITY_ARGS[@]}" -gt 0 ]]; then saved_args=("${DB_FENCE_IDENTITY_ARGS[@]}"); fi

  local rc=0
  resolve_db_identity "$(env_file_value DATABASE_URL "$env_file")" || rc=$?
  local now_host="$DB_IDENTITY_HOST" now_port="$DB_IDENTITY_PORT"
  local now_user="$DB_IDENTITY_USER" now_database="$DB_IDENTITY_DATABASE"
  local now_reason="$DB_IDENTITY_REASON"

  DB_IDENTITY_HOST="$saved_host"; DB_IDENTITY_PORT="$saved_port"
  DB_IDENTITY_USER="$saved_user"; DB_IDENTITY_DATABASE="$saved_database"
  DB_IDENTITY_REASON="$saved_reason"
  DB_FENCE_IDENTITY_ARGS=()
  if [[ "${#saved_args[@]}" -gt 0 ]]; then DB_FENCE_IDENTITY_ARGS=("${saved_args[@]}"); fi

  if [[ "$rc" -ne 0 ]]; then
    DB_IDENTITY_DRIFT_REASON="${env_file} no longer states a connection identity this will accept: ${now_reason}"
    return 1
  fi
  if [[ "$now_host" != "$DB_IDENTITY_PINNED_HOST" || "$now_port" != "$DB_IDENTITY_PINNED_PORT" \
     || "$now_user" != "$DB_IDENTITY_PINNED_USER" || "$now_database" != "$DB_IDENTITY_PINNED_DATABASE" ]]; then
    DB_IDENTITY_DRIFT_REASON="${env_file} now names ${now_user}@${now_host}:${now_port}/${now_database}, and this run is fencing and migrating ${DB_IDENTITY_PINNED_USER}@${DB_IDENTITY_PINNED_HOST}:${DB_IDENTITY_PINNED_PORT}/${DB_IDENTITY_PINNED_DATABASE}"
    return 1
  fi
  return 0
}

# BOTH halves, re-run: the file still says the same thing, AND systemd still says that file is the
# only thing that can define DATABASE_URL for the service. The second half is not a formality at
# the later call sites — the unit's loaded configuration is re-read after this run's own final
# daemon-reload, so a drop-in that appeared during the window is folded in before it is asked.
require_start_identity_unchanged() {
  env_file_identity_unchanged || return 1
  if ! require_env_file_is_sole_definition; then
    DB_IDENTITY_DRIFT_REASON="$DB_IDENTITY_SOURCE_REASON"
    return 1
  fi
  return 0
}

# THE SAME TWO HALVES, PLUS THE BINDING (o3d-2sm1.5 r23, Codex HIGH).
#
# Used at the ONE call site that is about to hand the units to systemd. The difference from
# require_start_identity_unchanged() is not a stricter read of the same file — re-reading harder
# is what rounds 13-22 already exhausted — it is that this one requires the loaded unit
# configuration to name a file systemd will read at exec AND that this run wrote AND that the
# application user cannot replace. What the two checks above establish about ${APP_DIR_REAL}/.env
# is kept because a disagreement there is still worth refusing on: it means the operator's file
# and this run have parted company, and starting into a snapshot that contradicts the file on
# disk would be correct-but-astonishing.
require_start_identity_bound() {
  local rc=0
  DB_IDENTITY_REQUIRE_SNAPSHOT=true
  require_start_identity_unchanged || rc=$?
  DB_IDENTITY_REQUIRE_SNAPSHOT=false
  return "$rc"
}

# ---------------------------------------------------------------------------
# The reboot fence. The marker file is the condition; the drop-in is what makes
# systemd honour it. Both are written BEFORE anything is stopped.
# ---------------------------------------------------------------------------
fence_dropin_file() { echo "/etc/systemd/system/$1.d/${FENCE_DROPIN_NAME}"; }

# ---------------------------------------------------------------------------
# DURABILITY PRIMITIVES (o3d-2sm1.5, Codex r9 HIGH).
#
# The previous round made the marker and the cron backup ATOMIC — a reader never sees a
# half-written file. That is a different property from DURABLE, and only the second one
# survives a power cut: an atomic rename whose data was never flushed reboots as an empty
# or missing file, and a read-back through the page cache proves the bytes are VISIBLE,
# not that they are on the medium.
#
# So every published file gets two barriers: the file's own data before the rename, and
# the containing directory after it. Without the second, the rename itself is not durable
# and the reboot finds the OLD name — or no name at all.
# ---------------------------------------------------------------------------

# fsync one path. GNU coreutils `sync PATH` opens the path and calls fsync(2) on that
# descriptor, which for a directory is exactly the barrier that makes a rename durable.
# Where that is unavailable, fall back to a whole-filesystem sync, which is a superset.
# It NEVER silently does nothing: a failure is returned so the caller can refuse to
# publish rather than claim a durability it did not get.
fsync_path() {
  local target="$1"
  sync "$target" 2>/dev/null && return 0
  sync 2>/dev/null && return 0
  return 1
}

# THE NAME OF THE ROOT-OWNED STAGING DIRECTORY publish_durable_file() writes through (o3d-czpy).
#
# ONE NAME, STATED ONCE, because scripts/install.sh also has to PRUNE it out of the recursive
# `chown -h ${APP_USER}` it runs over ${DATA_DIR}: half this function's targets live under that
# directory, and a staging directory handed to the service account is not a staging directory.
PUBLISH_STAGE_DIRNAME=".ims-publish"

# THE TRUSTED ANCESTORS EVERY publish_durable_file() DESTINATION IS REACHED FROM (o3d-rn10).
#
# THE FINDING THIS CLOSES, WHICH THE PREVIOUS ROUND LEFT OPEN. Round 2 pinned the destination as a
# device and an inode and published `../${base}` from inside the staging directory, so nothing
# AFTER the pin could redirect the write. But the pin itself was `stat -c '%d:%i' "$dir"` — a
# pathname resolution, made with no relationship to any directory this run trusts. For
# ${DEPLOY_SSH_KNOWN_HOSTS} that pathname is ${DATA_DIR}/git-ssh, and ${DATA_DIR} belongs to
# ${APP_USER} on every upgrade: they replace `git-ssh` with a symlink to /root/.ssh BEFORE this
# function runs, the `stat` records /root/.ssh itself, `.ims-publish` is created and entered THERE,
# `..` is /root/.ssh — which is exactly what was pinned — and every check passes while the rename
# publishes a service-owned known_hosts over /root/.ssh/known_hosts. A pin proves that the
# directory did not MOVE; it says nothing about which directory was pinned.
#
# SO THE DESTINATION IS RESOLVED FROM A DIRECTORY THE SERVICE ACCOUNT CANNOT REPLACE, one component
# at a time, by the same chdir walk enter_service_subdir() uses — and never converted back into an
# absolute pathname afterwards, which is where the round-2 code reopened the hole it had just
# closed.
#
# WHY A CANDIDATE IS TRUSTWORTHY — AND WHY THAT IS NOW A CHECK AND NOT A PARAGRAPH (o3d-rn10 r2).
#
# The previous round argued the property here, in prose: each of the six is a directory whose OWN
# PARENT is root-owned and not writable by ${APP_USER} — /opt for ${APP_DIR}, /var/lib for
# ${DATA_DIR} and the default ${CUTOVER_STATE_DIR}, /etc for the three literals
# (${DB_ENV_SNAPSHOT_DIR}, ${DB_CA_PUBLISH_DIR} and the shared library's ${DB_FENCE_RECOVERY_DIR}).
# The service account can rewrite anything INSIDE such a directory and nothing ABOUT it: it cannot
# rename ${APP_DIR} aside, and it cannot leave a symlink at that name. The argument is right, and
# it was the only thing standing behind the table — a candidate was admitted by its SPELLING, and
# the deepest spelling won.
#
# WHICH IS NOT A PROPERTY OF A STRING, BECAUSE THREE OF THE SIX ARE OPERATOR-SETTABLE.
# ${IMS_APP_DIR}, ${IMS_DATA_DIR} and ${IMS_CUTOVER_STATE_DIR} can point a root anywhere, and the
# runbook itself suggests the case that breaks the paragraph: `IMS_CUTOVER_STATE_DIR=${DATA_DIR}/cutover`,
# where ${APP_USER} owns ${DATA_DIR} and can replace `cutover` with a symlink to a directory of
# their choosing. The destination still MATCHES the candidate text, the deepest match wins, and
# `cd -P "$root"` follows the link deliberately — publishing root-side into an attacker's pick.
#
# SO THE ANCHOR IS PROVEN AT RUNTIME, by publish_root_anchored(), and a candidate that cannot prove
# it is not a root. What that costs: nothing at all when the override is anchored, and a walk
# instead of a shortcut when it is not — see publish_trust_root() for what demotion means, and for
# what happens to an override with nothing left to demote to.
#
# THE LINE IS DRAWN AT THESE DIRECTORIES RATHER THAN AT `/`, AND UNTIL r5 THE ROOT ITSELF WAS
# FOLLOWED. A symlinked ${DATA_DIR} — /var/lib/${APP_NAME} pointing at a second disk — was a
# supported operator layout, so the root, and only the root, was entered with `cd -P`; every
# component below it was refused.
#
# THAT ONE HOP LEFT THE PROVED TREE, WHICH IS THE r5 FINDING (Codex HIGH). The link ENTRY is safe:
# it sits in a parent this walk proves only the privileged account can write, so nobody else can
# rebind the root's own name. Its TARGET is not. `/var/lib/${APP_NAME} -> /srv/disk2/ims` resolves
# through `/srv/disk2`, which nothing here walks and which the service account may own: they rename
# `ims` aside and leave a link to /root/.ssh at that name, the root entry never changes, every
# anchor check passes, and the publication creates its staging directory and writes `.env` — as
# root — in the directory they chose. The walk proved every component except the one that mattered.
#
# SO A SYMLINKED ROOT IS REFUSED, AND A SECOND DISK IS A BIND MOUNT. pin_dir_beneath_root() prints
# what an operator has to do, and does it at the write, naming the root. Every root is then an
# ORDINARY COMPONENT, proved exactly as the ones below it are, and the walk has no exception left.
#
# A FUNCTION AND NOT AN ARRAY, so the list is read at the moment of the publication rather than at
# the moment this file was parsed: a root reassigned by a prompt would otherwise leave the table
# naming a directory nothing publishes into. `${VAR:-}` because an empty entry is skipped and a
# destination that matches no root is REFUSED — a new publication site outside these six fails
# loudly at install time instead of silently resolving its own path.
publish_trust_root_candidates() {
  printf '%s\n' "${APP_DIR:-}" "${DATA_DIR:-}" "${CUTOVER_STATE_DIR:-}" "${DB_ENV_SNAPSHOT_DIR:-}" "${DB_CA_PUBLISH_DIR:-}" "${DB_FENCE_RECOVERY_DIR:-}"
}

# WHETHER "$1" MAY BE A STARTING POINT FOR THE WALK — PROVEN BY WALKING TO IT (o3d-rn10 r4).
#
# The root, and only the root, is entered with `cd -P`, which follows a symlink. Everything below
# it is created with a plain `mkdir`, lstat-ed and inode-checked; the root is taken on trust, so
# the trust has to be earned. What earns it is one property: NO ACCOUNT BUT THE PRIVILEGED ONE CAN
# CHANGE WHAT THE ROOT'S OWN NAME BINDS TO.
#
# ROUND 3 ASKED THAT OF THE PARENT ALONE, AND ASKED IT OF A PATHNAME. `stat "$parent"` answered
# that the parent was root-owned and 0755, and stopped — so `IMS_CUTOVER_STATE_DIR=/home/app/guard/state`
# passed with `guard` root-owned 0755 while ${APP_USER} owned /home/app and was free to rename
# `guard` aside and leave a tree of their own at that name, `state` a symlink inside it. A
# directory whose own name somebody else can replace anchors nothing, whatever its mode reads. The
# question recurses, and the only place it terminates is `/`.
#
# SO THE ANCHOR IS A WALK FROM `/`, AND IT IS THE SAME WALK pin_dir_beneath_root() PERFORMS BELOW.
# Each component is lstat-ed (`stat` without `-L`, so a symlinked ancestor reads as "symbolic
# link" and is REFUSED — an ancestor resolved by name is an ancestor taken on trust), entered with
# `cd -P`, and the directory we landed in is then required to BE the inode that entry named, with
# `..` still the directory we came from. An ancestor is never named again after it has been
# entered, and the walk ends holding the parent as a cwd rather than as a string.
#
# AND EVERY DIRECTORY ON THE WAY IS ASKED THE CONTAINER QUESTION — of the inode this process is
# standing in, never of a pathname: is it owned by root or by whoever is running this, and can
# anybody else write into it? `id -u` for the same reason publish_durable_file() asks it instead of
# hardcoding 0: the property is "the privileged account that owns this install", and asking lets
# the regression rigs measure the mechanism unprivileged. uid 0 is accepted unconditionally as
# well, because root IS that account by definition — which is also what lets an unprivileged
# harness resolve the SHIPPED roots under /opt, /var/lib and /etc.
#
# THE STICKY BIT IS CREDITED FOR AN ANCESTOR AND REFUSED FOR THE PARENT, which is a real
# distinction and not a convenience. Sticky lets anybody CREATE an entry in the directory and lets
# only that entry's owner — or the directory's, or root — rename or remove one. For an ANCESTOR
# that is the whole question: the component already exists and already belongs to the privileged
# account, so no third party can move it, and whatever they may create beside it is a name this
# walk will never utter. For the PARENT it is not the question at all, because on a first install
# THE ROOT DOES NOT EXIST YET: "cannot replace an existing entry" says nothing about who gets to
# create it. A root directly under /tmp is therefore still refused, and a root inside a 0700
# directory that /tmp happens to hold is not — which is precisely the difference between the two.
#
# WHAT THIS STILL DOES NOT CLAIM. POSIX ACLs are not read: a directory carrying a write ACL is
# outside anything a mode can express. And the ROOT ITSELF is not lstat-ed HERE — on a first
# install it does not exist yet, so the question belongs to the walk that CREATES it. Since r5
# pin_dir_beneath_root() asks it there and REFUSES a symlink rather than following it: this
# function proves the root's name cannot be rebound, which says nothing about what a link at that
# name would resolve through.
#
# IT LEAVES THE CALLING SHELL INSIDE THE PARENT, on success AND part-way down on failure, which is
# the half the anchor never had. Its only caller that wants an answer rather than a position is
# publish_root_anchored(), which runs it in a subshell.
pin_publish_root_parent() {
  local root="$1" parent rel comp self here entry meta owner mode
  [[ "$root" == /* ]] || return 1
  root="${root%/}"
  # `/` has no parent that could anchor it, and is not a directory anything here publishes under.
  [[ -n "$root" ]] || return 1
  parent="${root%/*}"
  [[ -n "$parent" ]] || parent="/"
  self="$(id -u)" || return 1
  # THE FIXED TRUSTED ANCESTOR, and the only one there is: `/` is the one directory on the machine
  # whose name nothing can rebind. Everything between it and the parent is proved, not assumed.
  cd -P / 2>/dev/null || return 1
  here="$(stat -c '%d:%i' . 2>/dev/null || true)"
  [[ -n "$here" ]] || return 1
  rel="${parent#/}"
  while :; do
    # THE CONTAINER QUESTION, asked of `.` and never of a name. ONE stat takes the owner and the
    # mode together, so the two answers cannot describe different directories.
    meta="$(stat -c '%u|%a' . 2>/dev/null || true)"
    [[ "$meta" == *"|"* ]] || return 1
    owner="${meta%%|*}"
    mode="${meta##*|}"
    [[ "$owner" == "0" || "$owner" == "$self" ]] || return 1
    # Validated BEFORE `8#` sees it: `8#` on anything that is not octal is a fatal arithmetic error
    # under `set -e`, which is a crash and not a refusal.
    [[ "$mode" =~ ^[0-7]+$ ]] || return 1
    if [[ -z "$rel" ]]; then
      # THE PARENT, whose next entry — the root — may not exist yet. No sticky credit here.
      (( (8#$mode & 8#22) == 0 )) || return 1
      return 0
    fi
    comp="${rel%%/*}"
    if [[ "$comp" == "$rel" ]]; then rel=""; else rel="${rel#*/}"; fi
    # A `//` in the candidate names the directory we are already standing in.
    [[ -n "$comp" ]] || continue
    # `.` and `..` would step outside the walk while it believed it was stepping down it.
    [[ "$comp" != "." && "$comp" != ".." ]] || return 1
    # ONE lstat, TAKING THE TYPE AND THE IDENTITY TOGETHER, so the two cannot describe different
    # directories. No `-L`, so a symlinked ancestor is refused rather than followed.
    entry="$(stat -c '%F|%d:%i' "$comp" 2>/dev/null || true)"
    [[ "${entry%%|*}" == "directory" ]] || return 1
    entry="${entry#*|}"
    if (( (8#$mode & 8#22) != 0 )); then
      # Writable by somebody else, so only the sticky bit can still make THIS entry unreplaceable.
      # It does so only for an entry the privileged account owns — and THAT is not re-asked here,
      # because the next turn of this loop asks it of `.` after the chdir, of an inode this walk
      # has already pinned to this entry. Asking twice would be the same question in a worse place.
      (( (8#$mode & 8#1000) != 0 )) || return 1
    fi
    cd -P "$comp" 2>/dev/null || return 1
    # AND THE DIRECTORY WE LANDED IN IS THE ONE THAT ENTRY NAMED — the same pair of questions the
    # walk below asks, for the same reason. An lstat gives the inode of the entry, `stat .` gives
    # the inode we are standing in, and a rename between them can only make the two differ. `..`
    # also refuses a directory moved WHOLESALE into another parent, which preserves its inode.
    [[ "$(stat -c '%d:%i' . 2>/dev/null || true)" == "$entry" ]] || return 1
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "$here" ]] || return 1
    here="$entry"
  done
}

# The same question as a PREDICATE: may "$1" be a root, asked without going anywhere.
#
# A SUBSHELL, so the walk's chdir dies with it. publish_trust_root() asks this of every candidate
# in the table while it is choosing one, and a selector left standing inside the last candidate it
# considered would be a worse bug than the one this closes. It creates nothing either: the `mkdir`
# a first install needs belongs to the acting path, and a predicate that made directories would
# make one for every candidate it rejected.
#
# THE ANSWER IS ADVISORY, AND DELIBERATELY SO. It decides WHICH of the six the publication is
# walked from — a question about the table — and NOTHING ACTS ON IT. pin_dir_beneath_root() walks
# from `/` again at the moment it enters the root, so no operation is ever aimed by an answer this
# function gave earlier; a parent replaced in between is re-proved from scratch or refused, and is
# never entered on the strength of the older answer.
publish_root_anchored() {
  ( pin_publish_root_parent "$1" )
}

# The SHALLOWEST ANCHORED candidate that "$1" lies at or under, printed; non-zero when there is
# none.
#
# ANCHORED FIRST, AND A CANDIDATE THAT FAILS IS DEMOTED RATHER THAN FATAL. Dropping it from the
# table is not the same as refusing the publication, and the difference is the whole behaviour of
# the two override shapes:
#
#   • `IMS_CUTOVER_STATE_DIR=${DATA_DIR}/cutover` is UNANCHORED — ${APP_USER} owns ${DATA_DIR} — but
#     ${DATA_DIR} is anchored and covers it. The walk therefore starts at ${DATA_DIR}, and `cutover`
#     is an ORDINARY COMPONENT: plain `mkdir`, lstat-ed, inode-checked, refused outright if it is a
#     symlink. The supported nested layout keeps working, and the attack on it stops working.
#   • `IMS_CUTOVER_STATE_DIR=/home/svc/state` is unanchored AND under no anchored candidate. There
#     is nothing to demote it to, so this returns non-zero and publish_durable_file() REFUSES every
#     publication into it. An unanchored override never becomes a trusted root by being spelled in
#     the table; at worst it stops the run, loudly, at the write.
#
# Demotion rather than blanket refusal because refusing every unanchored candidate outright would
# also refuse the nested layout, for no security gain: the walk from the outer anchor already
# resolves every component the candidate names, one at a time and under lstat, which is strictly
# more than trusting the candidate ever did.
#
# SHALLOWEST AND NOT DEEPEST — round 1's rule, inverted. Two candidates that both cover "$1" are
# necessarily nested, one a prefix of the other, so the shallowest is an ancestor of every other:
# the walk from it COVERS them, and they need no anchor of their own. Preferring the deepest was
# defended as "the fewest components resolved by name", which had it backwards. A component the
# walk resolves is not resolved by name — it is created, lstat-ed and inode-checked. Fewer starting
# assumptions beats fewer steps.
publish_trust_root() {
  local dir="$1" root best="" list
  # A CHECKED CAPTURE AND A HERE-STRING, NEVER `< <(...)`. A process substitution has no status
  # anybody can take, so a producer that died half-way through is indistinguishable from one that
  # listed every root — and here that difference is the difference between refusing a publication
  # and refusing all of them. This is the same rule the crontab/fence subsystem is held to.
  list="$(publish_trust_root_candidates)" || return 1
  while IFS= read -r root; do
    [[ -n "$root" ]] || continue
    root="${root%/}"
    [[ -n "$root" ]] || continue
    [[ "$dir" == "$root" || "$dir" == "${root}/"* ]] || continue
    publish_root_anchored "$root" || continue
    if [[ -z "$best" ]] || (( ${#root} < ${#best} )); then best="$root"; fi
  done <<< "$list"
  [[ -n "$best" ]] || return 1
  printf '%s\n' "$best"
}

# Walk from "$1" down to "$2" one component at a time, LEAVING THE CALLING SHELL INSIDE "$2".
#
# The non-fatal twin of enter_service_subdir(): same mechanism, same refusals, but it returns
# rather than calling `die`, because publish_durable_file()'s whole contract with its callers is a
# return code — every one of them decides for itself whether a failed publication ends the run.
# It is called from inside publish_durable_file()'s subshell, so the moved cwd dies with it.
#
# Each component is created with a PLAIN `mkdir` (EEXIST on a planted symlink, where `mkdir -p`
# would silently work inside its target) and lstat-ed with `stat -c '%F'` when that fails, so a
# link reads as "symbolic link" and is refused. Then `cd -P` pins the inode and `..` — the kernel's
# own answer for the directory this process is inside — is compared against the component we came
# from, which closes the window between the lstat and the chdir. An ancestor is never named again
# after it has been entered.
#
# THE MODE OF A COMPONENT THIS CREATES comes from the ambient umask, which is what the `mkdir -p`
# it replaces used. Every destination this function is asked for is created earlier and
# deliberately by mkdir_service_subdir() or ensure_cutover_state_dirs(); creating one here is the
# first-install fallback, not the path that decides the permissions.
# THE ANCHOR AND THE ENTRY ARE ONE WALK (o3d-rn10 r4), and that was r4's finding. Round 3 asked
# publish_root_anchored() whether the root's parent looked right, by PATHNAME, and then ran
# `mkdir -p "$root"` and `cd -P "$root"` — two further resolutions of the same pathname, after the
# check and independent of it. Re-asking a pathname question only ever adds another window.
# pin_publish_root_parent() instead walks from `/` to the parent, proving every component on the
# way and ending with this shell INSIDE the parent, so the operations below are aimed at a
# directory descriptor the kernel is holding rather than at a name anybody can rebind.
#
# AND THE ROOT ITSELF IS NO LONGER AN EXCEPTION (o3d-rn10 r5, Codex HIGH). It used to be entered
# with a bare `cd -P` that followed a symlink DELIBERATELY — a ${DATA_DIR} on a second disk was a
# supported layout, and the link's own NAME sits in a parent the anchor walk proves only the
# privileged account can write. That argument covers the ENTRY and nothing else: the path the
# link's TARGET resolves through is proved by nothing, so a target under a directory the service
# account owns can be renamed aside and rebound to a directory of their choosing, and the unchanged
# root entry passes every check while the publication lands there as root.
#
# WHY REFUSING THE SYMLINK AND NOT PINNING ITS TARGET. Pinning would keep the configuration
# working: read the link, walk its target from `/` through this same machinery, bound the chain,
# decide what a relative target means. That is a SECOND path proved per publication, in three
# byte-identical copies, to keep an indirection re-resolved every time it is used. A bind mount is
# the same layout with the resolution done ONCE, at mount time, out of a mount table only root can
# write — and it leaves this walk with no exception in it at all. The cost is operator-facing, so
# the refusal prints the two commands that replace the link.
#
# AND THIS PARAGRAPH IS OUT HERE RATHER THAN IN THE BODY. Every byte between `name() {` and the
# closing brace is lifted verbatim by tests/scripts/install-shell-rig.ts and handed to `bash` as a
# SINGLE argv element, which Linux caps at MAX_ARG_STRLEN. Prose above the definition is not
# lifted, so it costs nothing to a regression run.
pin_dir_beneath_root() {
  local root="$1" path="$2" rel comp here entry base
  [[ "$root" == /* && "$path" == /* ]] || return 1
  root="${root%/}"
  [[ -n "$root" ]] || return 1
  [[ "$path" == "$root" || "$path" == "${root}/"* ]] || return 1
  # ONE COMPONENT, which is what the pinned parent lets us enter the root as.
  base="${root##*/}"
  [[ -n "$base" && "$base" != "." && "$base" != ".." ]] || return 1
  # THE ANCHOR AND THE ENTRY ARE ONE WALK (o3d-rn10 r4). See above.
  pin_publish_root_parent "$root" || return 1
  # THE PARENT, AS AN INODE, so the `..` check below has a pinned directory to compare against.
  here="$(stat -c '%d:%i' . 2>/dev/null || true)"
  [[ -n "$here" ]] || return 1
  # AND THE ROOT IS AN ORDINARY COMPONENT (o3d-rn10 r5) — created, lstat-ed, entered and
  # inode/`..` checked like every component below it, with a SYMLINK AT IT REFUSED. See the
  # comment above for the finding and for why the second disk is a bind mount and not a link.
  mkdir "$base" 2>/dev/null || true
  entry="$(stat -c '%F|%d:%i' "$base" 2>/dev/null || true)"
  if [[ "${entry%%|*}" != "directory" ]]; then
    if [[ "${entry%%|*}" == "symbolic link" ]]; then
      printf 'ERROR: %s is a symbolic link, and a publication root may not be one: nothing here proves the path its target resolves through.\n' "$root" >&2
      printf 'ERROR: To keep %s on another disk, replace the link with a real directory and bind-mount the disk onto it — no data has to move:\n' "$root" >&2
      printf 'ERROR:   rm %s && mkdir -p %s && mount --bind TARGET %s\n' "$root" "$root" "$root" >&2
      printf 'ERROR: then add `TARGET %s none bind 0 0` to /etc/fstab so the bind survives a reboot.\n' "$root" >&2
    fi
    return 1
  fi
  cd -P "$base" 2>/dev/null || return 1
  [[ "$(stat -c '%d:%i' . 2>/dev/null || true)" == "${entry#*|}" ]] || return 1
  [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "$here" ]] || return 1
  here="${entry#*|}"
  rel="${path#"$root"}"
  rel="${rel#/}"
  while [[ -n "$rel" ]]; do
    comp="${rel%%/*}"
    if [[ "$comp" == "$rel" ]]; then rel=""; else rel="${rel#*/}"; fi
    [[ -n "$comp" ]] || continue
    # `.` and `..` would step outside the walk while it believed it was stepping down it.
    [[ "$comp" != "." && "$comp" != ".." ]] || return 1
    mkdir "$comp" 2>/dev/null || true
    # ONE lstat, TAKING THE TYPE AND THE IDENTITY TOGETHER — whether this run created the component
    # a moment ago or found it already there. `stat` without `-L` does not dereference, so a link
    # reads as "symbolic link" and is refused before anything steps into it.
    entry="$(stat -c '%F|%d:%i' "$comp" 2>/dev/null || true)"
    [[ "${entry%%|*}" == "directory" ]] || return 1
    cd -P "$comp" 2>/dev/null || return 1
    # AND THE DIRECTORY WE LANDED IN IS THE ONE THAT ENTRY NAMED. `..` alone accepts a component
    # swapped for a symlink to a SIBLING under the same parent — the residual o3d-rn10 was filed
    # with, and the one case that looked like it needed openat2. It does not: an lstat gives the
    # inode of the entry, `stat .` gives the inode we are standing in, and a rename between them
    # can only make the two differ. Both are kept: `..` also refuses a directory moved WHOLESALE
    # into another parent, which preserves its inode.
    [[ "$(stat -c '%d:%i' . 2>/dev/null || true)" == "${entry#*|}" ]] || return 1
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "$here" ]] || return 1
    here="${entry#*|}"
  done
  return 0
}

# Publish stdin at "$1" so that a SIGKILL or a power loss at any instant leaves either the
# PREVIOUS durable content or the complete new content, and never a truncated file.
#
# `> "$FENCE_FILE"` did the opposite: it truncated the authoritative marker first and filled
# it afterwards, so a kill in between left an empty or partial marker at the one path the
# next run reads. Adoption reads an unrecognised phase conservatively as `stopping`, but it
# read the MISSING schema flag as `false` and released the connection fence — over a schema
# that may have been half migrated.
#
# Same directory, so the rename is a rename and not a copy. Every failure path removes the
# temporary file and returns non-zero, leaving the last durable marker untouched.
# OWNERSHIP AND MODE ARE PART OF THE PUBLICATION, NOT A STEP AFTER IT (o3d-2sm1.5 r39, Codex
# HIGH). ${APP_DIR}/.env has to reach the application account readable, and a `chown` issued AFTER
# the rename is a second observable state: a crash between the two leaves a complete, correct file
# the application cannot open. Both are applied to the TEMPORARY file, before the barrier and
# before the rename, so the name is published once and everything about it is already true.
# `$2` and `$3` are optional and default to what every earlier caller already got: root's own
# ownership, since this script runs as root, and mode 0600.
#
# AND THE TEMPORARY FILE IS NOT MADE BESIDE ITS TARGET ANY MORE (o3d-czpy). Round 24's CRITICAL
# was about a root-side write into a directory ${APP_USER} owns, and every one of this function's
# targets is in such a directory: ${APP_DIR}/.env, ${APP_DIR}/.deploy-meta,
# ${CUTOVER_STATE_DIR}/DEPLOY-FENCED, the cron backup. `mktemp "${target}.XXXXXX"` is not itself
# plantable — the name is unpredictable and the create is O_CREAT|O_EXCL — but everything done to
# it AFTERWARDS is by PATH, and the service user can watch the directory, rename the new entry
# aside and leave a symlink at the same name. Then the `chmod` chmods their choice, the `chown`
# hands their choice to them, and the `cat >` writes the application's secrets into it. Three
# root-side operations aimed by a rename, and no amount of re-checking the path closes it, because
# the check and the operation are two syscalls.
#
# So the temporary lives in a ROOT-OWNED 0700 DIRECTORY the service user cannot write, cannot
# rename inside, and cannot list. It is created with the same primitives prepare_crontab_lock uses
# and for the same reasons — plain `mkdir` (which fails with EEXIST on a planted symlink where
# `mkdir -p` would silently work inside its target), `stat -c %F` (lstat, so a symlink reads as
# "symbolic link" and is refused), `chown -h` (which cannot dereference) — and it is a SIBLING of
# the target, so the publication is still a same-filesystem rename.
#
# AND THE ONE HOLE THAT LEAVES IS CLOSED BY `cd`, NOT BY ANOTHER CHECK. ${APP_USER} owns the
# CONTAINING directory, so they can rename ${dir}/.ims-publish aside AFTER it has been verified and
# put a symlink there; a fourth lstat would race exactly like the first three. `cd` does not: it
# resolves the path once and the shell then holds a descriptor on that INODE, which no rename can
# move. Everything below runs relative to that cwd. The verification is therefore made of `.`
# AFTER the chdir — it asks what this process is actually inside — and it asks for uid ${self} and
# mode 0700, which is a directory the service user cannot manufacture: they cannot chown anything
# to root. `%d` is in the same stat so the same answer also proves the rename below is a rename
# and not a dereferencing cross-device copy.
#
# MODE AND OWNER ARE APPLIED BEFORE THE CONTENT, not after it. `.env` is the reason: it carries
# AUTH_SECRET, SETTINGS_ENCRYPTION_KEY, CRON_SECRET and the database password, and a file that is
# filled first and restricted second exists, for an instant, with secrets in it at whatever mode
# the create left. Inside a 0700 root-owned directory nothing can open it either way — which is
# the belt — but the ordering is the braces, and it costs nothing.
publish_durable_file() {
  local target="$1" owner="${2:-}" mode="${3:-600}" dir base root self tmp meta parent
  # Absolute, so `dirname` and `basename` below split a whole path rather than a fragment of one.
  [[ "$target" == /* ]] || target="${PWD}/${target}"
  dir="$(dirname "$target")"
  base="$(basename "$target")" || return 1
  # ONE REAL COMPONENT. Everything below publishes `../${base}` from inside the staging directory,
  # so an empty `base`, or `.` or `..`, would aim the rename at the destination directory itself.
  [[ -n "$base" && "$base" != "." && "$base" != ".." && "$base" != */* ]] || return 1
  # THE DESTINATION IS NO LONGER PINNED FROM ITS OWN PATHNAME (o3d-rn10, Codex HIGH). It used to be
  # `stat -c '%d:%i' "$dir"`, which follows whatever ${dir} resolves to at that instant and relates
  # it to nothing: a `git-ssh` replaced by a symlink to /root/.ssh BEFORE this function ran was
  # pinned as /root/.ssh, and every check afterwards agreed with the attacker's choice. So the
  # destination is reached from a directory ${APP_USER} cannot replace — see
  # publish_trust_root_candidates() above for which ancestors those are and why. A destination
  # under none of them is REFUSED rather than resolved.
  root="$(publish_trust_root "$dir")" || return 1
  # Asked rather than hardcoded, exactly as prepare_crontab_lock asks it: the property is "owned by
  # the privileged user that owns this install", and it lets the harnesses run this unprivileged.
  self="$(id -u)" || return 1
  (
    # THE WALK, WHICH ENDS WITH THIS SUBSHELL INSIDE ${dir}. From here on the destination exists
    # only as this process's cwd — a descriptor no rename can move — AND IS NEVER SPELLED AGAIN.
    # That is the half round 2 got wrong: it rebuilt `${dir}/${PUBLISH_STAGE_DIRNAME}` and handed
    # the whole pathname to `mkdir`, `stat` and `chown`, so all three re-resolved every component
    # the pin had already accepted.
    pin_dir_beneath_root "$root" "$dir" || exit 1
    # The destination, recorded as a device and an inode. The first field is what proves the
    # publication below is a rename and not a dereferencing cross-device copy; the second is what
    # makes it the SAME directory rather than the same name.
    parent="$(stat -c '%d:%i' . 2>/dev/null || true)"
    [[ -n "$parent" ]] || exit 1
    # A SINGLE RELATIVE COMPONENT, resolved by the kernel from the directory this process holds.
    if ! (umask 077; mkdir "${PUBLISH_STAGE_DIRNAME}") 2>/dev/null; then
      [[ "$(stat -c '%F' "${PUBLISH_STAGE_DIRNAME}" 2>/dev/null || true)" == "directory" ]] || exit 1
    fi
    # `-h`, so a name that became a symlink between the mkdir and here has the LINK re-owned and
    # not its target. The verification that follows the chdir is what decides whether we proceed.
    chown -h "$self" "${PUBLISH_STAGE_DIRNAME}" 2>/dev/null || exit 1
    cd "${PUBLISH_STAGE_DIRNAME}" 2>/dev/null || exit 1
    meta="$(stat -c '%u|%a|%d' . 2>/dev/null || true)"
    [[ "$meta" == "${self}|700|${parent%%:*}" ]] || exit 1
    # AND `..` IS THE DESTINATION, ASKED OF THE KERNEL RATHER THAN OF A PATHNAME. The shell holds a
    # descriptor on the staging inode; `..` is that directory's own parent link, so it answers
    # "the directory this staging directory is IN", which no rename of any name above it can move.
    # A staging directory moved wholesale into some other directory changes it, and is refused.
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "$parent" ]] || exit 1
    if ! tmp="$(mktemp ./publish.XXXXXX 2>/dev/null)"; then exit 1; fi
    if ! chmod "$mode" "$tmp" 2>/dev/null; then rm -f "$tmp"; exit 1; fi
    if [[ -n "$owner" ]] && ! chown "$owner" "$tmp" 2>/dev/null; then rm -f "$tmp"; exit 1; fi
    if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; exit 1; fi
  # BARRIER 1: the data, before the name exists. After this the rename can only publish
  # bytes that are already on the medium.
    if ! fsync_path "$tmp"; then rm -f "$tmp"; exit 1; fi
    # `../${base}`, and never the absolute target: one component, resolved from the pinned parent.
    if ! mv -f -T "$tmp" "../${base}" 2>/dev/null; then rm -f "$tmp"; exit 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # old name, or neither name, however well the data was flushed. It flushes `..` — the same
  # pinned parent the rename landed in — because `fsync_path "$dir"` re-resolved the pathname
  # a third time and could report durability for a directory nothing was published into.
  #
  # A FAILURE HERE RETURNS NON-ZERO WITH THE NEW BYTES ALREADY AT $target (o3d-2sm1.5, Codex
  # r10 HIGH). That is not a leak, it is the honest answer: the content is VISIBLE and its
  # NAME is not proven, so a power loss can restore the previous directory entry and with it
  # the previous marker. Callers must act on THIS RETURN VALUE. Anything that greps $target
  # instead reads the new content and concludes a durability it was never given.
    fsync_path .. || exit 1
  ) || return 1
  return 0
}

# PUBLISH A SYSTEMD DROP-IN DURABLY (o3d-2sm1.5, Codex r11 CRITICAL).
#
# The reboot fence had only the visible half. `cat > "$dropin"` + `chmod 644` +
# `daemon-reload` + `systemctl show -p DropInPaths` proves that systemd can read the drop-in
# NOW. It flushes nothing: not the file's data, not the rename that publishes it, and not the
# `<unit>.d` directory the drop-in usually had to be created in. Execution then goes straight
# on to stop the services and migrate, and NOTHING in between is a write barrier — so the
# claim that "the writeback window ends before anything is stopped" is not established by the
# ordering. A power cut after `schema_touched` is durable but before the drop-in reaches the
# medium reboots WITHOUT the AssertPathExists=! fence: the durable marker then names a
# condition no unit asserts on, and the old enabled service starts against a partially
# migrated schema. The marker protects nothing on its own; the drop-in is what makes systemd
# honour it, so the two must be equally durable.
#
# Three barriers, and the first is the one publish_durable_file() cannot give, because it
# assumes its directory already exists:
#
#   BARRIER 0  the NEW drop-in directory's own entry in /etc/systemd/system. A file flushed
#              into a directory whose name was never flushed is published into nothing.
#   BARRIER 1  the drop-in's data, before any name points at it.
#   BARRIER 2  the directory entry the rename created.
#
# The temporary carries the `.conf.XXXXXX` suffix, which systemd does not load — only `.conf`
# files in a `.d` directory are drop-ins — so a daemon-reload racing this publication reads
# either the previous drop-in or the complete new one, never a partial one.
publish_durable_dropin() {
  local target="$1" dir parent tmp created=false
  dir="$(dirname "$target")"
  parent="$(dirname "$dir")"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir" || return 1
    created=true
  fi
  # BARRIER 0, and only where a directory was actually created: fsyncing the parent of a
  # directory that already survived a boot proves nothing and costs a flush of /etc.
  if $created; then fsync_path "$parent" || return 1; fi
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # 0644 and not publish_durable_file()'s 0600: this is a systemd unit fragment, and every
  # other drop-in on the host is world-readable. The marker it points at is the secret-ish
  # one; the fence itself is meant to be legible to an operator reading `systemctl cat`.
  if ! chmod 644 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 1: the data, before the name exists. After this the rename can only publish
  # bytes that are already on the medium.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. As in publish_durable_file(), a
  # failure HERE returns non-zero with the new drop-in ALREADY VISIBLE — daemon-reload will
  # load it and `systemctl show -p DropInPaths` will report it, and a power loss can still
  # restore the previous directory entry. So the caller must act on THIS RETURN VALUE;
  # verify_reboot_fence() asks systemd a different question and cannot answer this one.
  fsync_path "$dir" || return 1
  return 0
}

# THE SHARED NAMESPACE IS THE APPLICATION'S OWN DATA DIRECTORY, so this creates what is
# missing and changes the mode of nothing else. deploy.sh used to `chmod 700` its private
# state directory; doing that to ${CUTOVER_STATE_DIR} now would take /var/lib/one-two-inventory
# — uploads, backups, the Xero store — away from the service that owns it. The two files
# that need protecting carry their own 0600, and the connection-fence state lives in a 0700
# subdirectory owned by ${APP_USER}, which is the identity that writes it: the fence script
# runs as the app user, so a root-owned 0700 directory made that write impossible.
ensure_cutover_state_dirs() {
  mkdir -p "$CUTOVER_STATE_DIR" || return 1
  mkdir -p "$DB_FENCE_DIR" || return 1
  chown "${APP_USER}:${APP_USER}" "$DB_FENCE_DIR" 2>/dev/null || true
  chmod 700 "$DB_FENCE_DIR" 2>/dev/null || true
  return 0
}

# ONE LOCK FOR ALL THREE ENTRYPOINTS (o3d-2sm1.5, Codex r9 HIGH). deploy.sh held
# ${STATE_DIR}/deploy.lock and update.sh held ${DATA_DIR}/update.lock, so "refusing to run
# two cutovers at once" was true of two deploys and false of a deploy racing an update;
# install.sh took no lock at all. One path, taken by all three.
acquire_cutover_lock() {
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_STATE_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another cutover (deploy.sh, update.sh or install.sh) holds ${LOCK_FILE}. Refusing to run two cutovers at once."
  # AND the lock the previous version of deploy.sh took, so a cutover started from a checkout
  # that predates the shared namespace is still excluded. Only when that directory already
  # exists: creating it would be re-creating the namespace this round retired.
  if [[ -d "$LEGACY_CUTOVER_STATE_DIR" ]]; then
    exec 8>"${LEGACY_CUTOVER_STATE_DIR}/deploy.lock"
    flock -n 8 || die "A cutover from a checkout that predates the shared namespace holds ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock. Refusing to run two cutovers at once."
  fi
}

write_fence_marker() {
  local reason="$1" status="${2:-0}"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would write ${FENCE_FILE}"
    return 0
  fi
  mkdir -p "${CUTOVER_STATE_DIR}"
  {
    echo "fenced_at=$(date -Iseconds)"
    echo "reason=${reason}"
    echo "failed_step=${CURRENT_STEP}"
    echo "exit_status=${status}"
    echo "app_dir=${APP_DIR_REAL}"
    echo "port=${PORT}"
    # THE DURABLE PHASE, RECORDED SEPARATELY FROM EVERY INTENT (o3d-2sm1.5, Codex r8 HIGH).
    #
    # This marker is written during ARMING, before the first stop, so its EXISTENCE proves
    # only that some run got as far as creating reversible cutover state. Adoption used to
    # read that existence as proof the predecessor had been stopped, and neither of the two
    # lines below could correct it: `migration_attempted` is the INTENT to migrate and is
    # already true while the fence is only being armed, and `schema_touched` does not become
    # true until much later. So the phase states itself, on disk, in the words the state
    # machine uses — and a run killed between the fence install and the first stop is
    # adopted as what it was.
    echo "phase=$(if $FENCE_ARMED; then echo stopping; elif $CUTOVER_ARMING; then echo arming; else echo none; fi)"
    # THE INTENT to migrate. It is NOT evidence that a migration was attempted; `phase=`
    # above and `schema_touched=` below are the two lines that are.
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
    # THE LAST LINE, AND IT IS THE POINT OF IT (o3d-2sm1.5, Codex r9 HIGH). A marker that
    # does not end here was never published by publish_durable_file(), so every fact above
    # it is unproven — including `schema_touched=`, whose ABSENCE adoption used to read as
    # `false` and release the connection fence over a possibly half-migrated schema. See
    # marker_is_complete().
    echo "marker_complete=1"
  } | publish_durable_file "$FENCE_FILE" || {
    # NOT fatal here: this is also called from the exit trap, where dying loses the status
    # and the banner. It IS fatal in mark_schema_touched() and persist_stop_requested() —
    # the two callers whose whole purpose is the durable record — and fatal on THIS RETURN
    # VALUE, never on a read-back of the file afterwards (o3d-2sm1.5, Codex r10 HIGH): the
    # rename lands before the last barrier, so the marker can be readable and undurable at
    # the same instant. What matters here is that the LAST DURABLE MARKER IS STILL THERE:
    # a failed publish changed nothing.
    warn "Could not publish ${FENCE_FILE} durably; the previous marker is unchanged."
    return 1
  }
  return 0
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
  # THE PUBLISHER'S RESULT IS THE DURABILITY ANSWER, AND IT IS FATAL (o3d-2sm1.5, Codex r10
  # HIGH). This was `|| true`, with the grep below left to speak for it. It cannot speak for
  # it: publish_durable_file() RENAMES the new marker into place and only then flushes the
  # parent directory, so a failed BARRIER 2 leaves bytes that are perfectly VISIBLE and not
  # proven to be on the medium. The grep was satisfied, the migration went ahead, and a power
  # loss could restore the previous directory entry — the older complete marker, saying
  # `schema_touched=false` — over a half-migrated schema. A read-back answers "can this be
  # seen?"; it never answers "will this survive?", and it does not substitute for the
  # publisher's own result.
  write_fence_marker "migration about to be invoked at $(date -Iseconds)" || die \
    "Could not publish ${FENCE_FILE} durably before migrating. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  # AND the content, which is a DIFFERENT question from durability: that what landed is the
  # marker this function exists to write. An additional gate, never a replacement for the
  # publisher's result above.
  grep -qE '^schema_touched=true$' "$FENCE_FILE" || die \
    "Could not record schema_touched=true in ${FENCE_FILE}. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  ok "Recorded schema_touched=true in ${FENCE_FILE} (flushed) — an interrupted migration is now recoverable."
}

# THE STOP IS ABOUT TO BE ASKED FOR — SAY SO ON DISK BEFORE ASKING (o3d-2sm1.5, Codex r9
# MEDIUM).
#
# `FENCE_ARMED=true` was set in shell memory immediately before `systemctl stop`, and the
# durable marker went on saying `phase=arming` until some LATER write refreshed it — the
# exit trap, usually, which a SIGKILL, an OOM kill or a power cut never reaches. So a run
# interrupted across the stop left a marker describing a phase it was no longer in, and the
# next run's adoption fell through to the liveness heuristic, where ANY listener on the
# port — an operator's `next dev` in another worktree, a stray process, a sibling app —
# counts as "the predecessor is still serving" and the arming is UNWOUND: the crontab is
# restored, the reboot fence taken down and the connection fence released, over a service
# that had already been asked to stop.
#
# So the transition is persisted first, and conservatively: `stopping` means only "a stop
# has been REQUESTED", never "the stop succeeded". Recovery semantics, which are the ones
# already in place for this phase: marker_phase() returns `stopping`, adoption takes the
# ordinary branch, and that branch re-stops the units, re-installs and re-verifies the
# reboot fence, adopts the cron fence, and holds or releases the connection fence on
# `schema_touched`. Nothing in that path is harmed by a stop that had not actually landed —
# every step of it is idempotent — which is exactly why the conservative direction is the
# one to persist.
persist_stop_requested() {
  # THE PUBLISHER'S RESULT IS THE DURABILITY ANSWER, AND IT IS FATAL (o3d-2sm1.5, Codex r10
  # HIGH). This was `|| true`, with the grep below left to speak for it. The grep only proves
  # the bytes can be SEEN: publish_durable_file() renames before its last barrier, so a failed
  # parent-directory fsync publishes a marker the grep is happy with and the medium may not
  # keep. The reboot then finds the PREVIOUS directory entry — `phase=arming` — and adoption
  # falls through to the liveness heuristic and UNWINDS the fences over a service that had
  # already been asked to stop.
  write_fence_marker "stop requested at $(date -Iseconds)" || die \
    "Could not publish ${FENCE_FILE} durably before stopping. Refusing to stop: a stop whose interruption cannot be recorded would be adopted as an arming that never stopped anything, and unwound over a service that had already been asked to stop."
  # AND the content, a DIFFERENT question from durability. An additional gate, never a
  # replacement for the publisher's result above.
  grep -qE '^phase=stopping$' "${FENCE_FILE}" || die \
    "Could not record phase=stopping in ${FENCE_FILE}. Refusing to stop: a stop whose interruption cannot be recorded would be adopted as an arming that never stopped anything, and unwound over a service that had already been asked to stop."
  info "Recorded phase=stopping in ${FENCE_FILE} (flushed) — an interruption across the stop is now recoverable."
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

  # A FENCE WHOSE MARKER IS NOT DURABLE IS NOT A FENCE. The marker is the condition the
  # drop-in asserts on, so a publish that could not be flushed must fail the install rather
  # than install a drop-in pointing at a file a power cut can lose.
  write_fence_marker "$reason" || {
    echo -e "${RED}[ERROR]${RESET} ${FENCE_FILE} could not be published durably, so there is NO reboot fence." >&2
    rollback_reboot_fence_install
    return 1
  }

  # A DROP-IN SYSTEMD CAN READ IS NOT A DROP-IN THE MEDIUM WILL KEEP (o3d-2sm1.5, Codex r11
  # CRITICAL). Published through the same discipline as the marker it asserts on — file
  # fsync, rename, directory fsync, and the drop-in directory's own entry where this call
  # created it — and a failure is FATAL HERE, which is before CUTOVER_ARMING becomes
  # `stopping` and before the first `systemctl stop`. Everything undone by
  # rollback_reboot_fence_install() and by the pre-stop branch of the exit trap.
  local unit dropin
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(fence_dropin_file "$unit")"
    [[ -f "$dropin" ]] || FENCE_DROPINS_CREATED+=("$dropin")
    if ! publish_durable_dropin "$dropin" <<EOF
[Unit]
# Installed by scripts/deploy.sh (o3d-2sm1.2) for the length of a cutover.
# While the marker below exists this unit must not start — not by hand, and not on
# boot. deploy.sh removes both once the new build has answered its health check.
AssertPathExists=!${FENCE_FILE}
EOF
    then
      echo -e "${RED}[ERROR]${RESET} ${dropin} could not be published durably, so there is NO reboot fence:" >&2
      echo -e "${RED}[ERROR]${RESET} a reboot before it reached the medium would start ${unit} against a migrated schema." >&2
      rollback_reboot_fence_install
      return 1
    fi
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
  write_fence_marker "${reason}" \
    || warn "The fence is installed and verified, but ${FENCE_FILE} could not be refreshed; it still reads reboot_fence=absent."
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
# THE ENVIRONMENT SNAPSHOT: publish, and take it away again (o3d-2sm1.5 r23, Codex HIGH).
# ---------------------------------------------------------------------------
snapshot_dropin_file() { echo "/etc/systemd/system/$1.d/${DB_ENV_SNAPSHOT_DROPIN_NAME}"; }

# Publish the DATABASE_URL this run fenced and migrated where only root can change it, and make
# every unit load it LAST. Called with the connection fence still up and nothing started, so a
# failure here costs a re-run and no outage.
publish_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would publish ${DB_ENV_SNAPSHOT_FILE} and a ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in per unit, daemon-reload, and verify the loaded EnvironmentFiles on the bus"
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || {
    echo -e "${RED}[ERROR]${RESET} systemctl is unavailable, so the started service cannot be bound to the database this run migrated." >&2
    return 1
  }
  if [[ "${#SERVICE_UNITS[@]}" -eq 0 ]]; then
    echo -e "${RED}[ERROR]${RESET} No systemd unit serves ${APP_DIR_REAL}, so there is nothing to bind the environment snapshot to." >&2
    return 1
  fi

  # A PATH SYSTEMD WOULD HAVE TO ESCAPE IS REFUSED, not escaped. The bus check compares the
  # loaded path against this one and refuses any element that had to be escaped, so emitting one
  # here would guarantee a refusal three lines later — with a message about somebody else's unit.
  case "$DB_ENV_SNAPSHOT_FILE" in
    *[$' \t\n\\']*)
      echo -e "${RED}[ERROR]${RESET} ${DB_ENV_SNAPSHOT_FILE} contains whitespace or a backslash, so systemd could not state it back unescaped and the binding could not be verified. That path is the literal DB_ENV_SNAPSHOT_DIR at the top of this script; edit it there to one with neither." >&2
      return 1 ;;
  esac

  # THE VALUE IS THE ONE THIS RUN PINNED, re-read from the file and re-checked against the pin by
  # the caller a moment ago. It is written SINGLE-QUOTED because that is the one form systemd
  # documents as verbatim — "can span multiple lines and contain any character verbatim other
  # than single quote" — so the deploy's reader and systemd's reader cannot disagree about it the
  # way they can about an unquoted value with a backslash in it.
  local value
  value="$(env_file_value DATABASE_URL "${APP_DIR_REAL}/.env")" || value=""
  if [[ -z "$value" ]]; then
    echo -e "${RED}[ERROR]${RESET} ${APP_DIR_REAL}/.env no longer states a DATABASE_URL to bind the service to." >&2
    return 1
  fi
  case "$value" in
    *"'"*|*$'\n'*)
      echo -e "${RED}[ERROR]${RESET} DATABASE_URL contains a single quote or a newline, which cannot be written into a systemd environment file verbatim. Re-write it without one." >&2
      return 1 ;;
  esac

  # The directory first, root-owned and 0700, so that nothing running as the application user can
  # replace or remove what the unit is about to be pointed at.
  if ! mkdir -p "$DB_ENV_SNAPSHOT_DIR" \
     || ! chown root:root "$DB_ENV_SNAPSHOT_DIR" \
     || ! chmod 700 "$DB_ENV_SNAPSHOT_DIR"; then
    echo -e "${RED}[ERROR]${RESET} ${DB_ENV_SNAPSHOT_DIR} could not be created root-owned and 0700, so the environment snapshot would sit somewhere the application user can rewrite." >&2
    return 1
  fi

  printf "DATABASE_URL='%s'\n" "$value" | publish_durable_file "$DB_ENV_SNAPSHOT_FILE" || {
    echo -e "${RED}[ERROR]${RESET} ${DB_ENV_SNAPSHOT_FILE} could not be published durably; the service is NOT bound and nothing has been started." >&2
    return 1
  }
  # publish_durable_file() leaves 0600; the owner is root because this script runs as root, and
  # systemd reads EnvironmentFile= as PID 1 BEFORE it drops to User=. So the application user
  # never needs to read it — which is the point: the file that decides the connection is not one
  # the service, or anything running as it, can rewrite.
  chown root:root "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || true
  DB_ENV_SNAPSHOT_PUBLISHED=true

  local unit dropin
  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(snapshot_dropin_file "$unit")"
    [[ -f "$dropin" ]] || DB_ENV_SNAPSHOT_DROPINS_CREATED+=("$dropin")
    if ! publish_durable_dropin "$dropin" <<EOF
[Service]
# Installed by scripts/deploy.sh (o3d-2sm1.5 r23) for the length of ONE cutover, and removed
# again before this run exits. It binds the service to the database this run fenced and
# migrated: systemd reads environment files in order and the LAST definition of a variable
# wins, so this beats whatever ${APP_DIR_REAL}/.env says at the moment of exec.
# No leading '-': if the file is gone, the start must FAIL rather than fall back.
EnvironmentFile=${DB_ENV_SNAPSHOT_FILE}
EOF
    then
      echo -e "${RED}[ERROR]${RESET} ${dropin} could not be published durably, so ${unit} is NOT bound to the database this run migrated." >&2
      return 1
    fi
  done

  if ! systemctl daemon-reload; then
    echo -e "${RED}[ERROR]${RESET} systemctl daemon-reload failed, so the environment snapshot is not in the units' loaded configuration." >&2
    return 1
  fi
  return 0
}

# Take the binding away. Called on EVERY exit path, successful or not: a drop-in left standing
# would pin a DATABASE_URL that a later, legitimate edit of ${APP_DIR_REAL}/.env could not
# override, and it would do so silently.
remove_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would remove the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-ins, daemon-reload, and delete ${DB_ENV_SNAPSHOT_FILE}"
    return 0
  fi
  local unit dropin removed=false
  for unit in "${SERVICE_UNITS[@]:-}"; do
    [[ -n "$unit" ]] || continue
    dropin="$(snapshot_dropin_file "$unit")"
    if [[ -e "$dropin" ]]; then
      rm -f "$dropin"
      removed=true
    fi
    rmdir "$(dirname "$dropin")" 2>/dev/null || true
  done
  if $removed && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while removing the environment snapshot drop-ins."
  fi
  rm -f "$DB_ENV_SNAPSHOT_FILE"
  DB_ENV_SNAPSHOT_PUBLISHED=false
  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
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
    echo -e "${YELLOW}[DRY]${RESET}   would run: node ${DB_FENCE_SCRIPT_COPY} --fence  (as ${APP_USER})"
    return 0
  fi
  # A RECOVERY PATH MAY NOT DEPEND ON THE THING WHOSE LOSS IT RECOVERS FROM: a box that already
  # has a root-owned copy needs nothing from the checkout to fence with.
  [[ -f "$DB_FENCE_SCRIPT" || -f "$DB_FENCE_SCRIPT_COPY" ]] || die \
    "Neither ${DB_FENCE_SCRIPT} nor the root-owned copy at ${DB_FENCE_SCRIPT_COPY} exists, so this run cannot hold the database closed for the migration window. A snapshot probe is not a fence. Restore the script (it ships with the app) and re-run; nothing has been migrated."

  # THE FENCE IS TOLD WHICH CONNECTION IT IS ABOUT, OR IT DOES NOT RUN (o3d-2sm1.5 r19). The
  # helper refuses without the four values as well; this refuses first, so the reason names the
  # URL that could not be read rather than the argument that was missing.
  require_db_identity || die \
    "The application's connection identity could not be read from ${APP_DIR_REAL}/.env: ${DB_IDENTITY_REASON}. The connection fence is TOLD which host, port, role and database it is closing — it no longer works that out from the environment, because seven rounds of doing so each uncovered another layer of systemd, Next and libpq composition. Write DATABASE_URL as a URL that states all four (postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE, with no host/port/user/dbname query parameter), or re-run with --skip-migrate, which moves no schema and needs no fence. Nothing has been stopped and nothing has been migrated."

  # AND THE FILE IT WAS READ FROM MUST BE THE ONLY THING THAT CAN DEFINE IT (o3d-2sm1.5 r20,
  # Codex CRITICAL). Four values read out of a file the service may not use are four values about
  # the wrong database.
  require_env_file_is_sole_definition || die \
    "${DB_IDENTITY_SOURCE_REASON}. The fence, the migration and the release would all agree with each other about the database ${APP_DIR_REAL}/.env names, while the application that restarts afterwards connects somewhere else — a migration on a database nothing fenced, and a new build on a database nothing migrated. Re-run with --skip-migrate, which moves no schema and needs no fence. Nothing has been stopped and nothing has been migrated."

  # AND THE FILE MUST STILL SAY WHAT IT SAID WHEN THIS RUN READ IT (o3d-2sm1.5 r22, Codex HIGH).
  # The identity above was parsed once, before the build and before the stop; this is the last
  # moment before the fence is aimed. Nothing has been fenced yet, so a disagreement here is the
  # cheap one — it costs a restart of the predecessor and no schema at all.
  require_start_identity_unchanged || die \
    "The connection identity this run pinned is no longer the one ${APP_DIR_REAL}/.env gives the service: ${DB_IDENTITY_DRIFT_REASON}. DATABASE_URL was read once, before the build and the stop, and systemd does not read the environment file until it execs the service — so fencing on the pinned identity now would fence and migrate one database while the application starts on another. NO FENCE HAS BEEN RAISED and nothing has been migrated. Put the file back the way this run found it, or re-run so the identity is pinned from what the file says now."

  ensure_cutover_state_dirs

  # THE ONLY FILE THIS FUNCTION RUNS IS THE ROOT-OWNED ONE (o3d-2sm1.5 r31, Codex CRITICAL).
  # Resolved here rather than at the top of the script so that the resolution — which publishes a
  # protected copy on a box that has none, and refuses one that does not match the recovery
  # record — happens with the fence about to be raised and not a build ago.
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || die \
    "This run has no fence script it is willing to execute (the reason is printed above), so it cannot hold the database closed for the migration window. A snapshot probe is not a fence. Nothing has been migrated."
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$fence_script" --fence --state-file="$DB_FENCE_STATE" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?

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
        node "$fence_script" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}")" || die \
        "The connection fence is up but the migration URL could not be composed, so the migration would run as the deploy admin and create objects the application cannot use. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      [[ -n "$MIGRATION_DATABASE_URL" ]] || die \
        "The connection fence is up but --print-migration-url produced nothing. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      DB_FENCE_UP=true
      DB_FENCE_RAISED=true
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
    5)
      # EXIT 5 IS A FENCE THAT IS STANDING RIGHT NOW (o3d-2sm1.5, Codex r13 HIGH).
      #
      # It is raised for an INDETERMINATE commit too (o3d-2sm1.5, Codex r14 HIGH): if the
      # acknowledgement of COMMIT is lost, the transaction's fate is unknown, and unknown is not
      # the not-committed case. The script reports exit 5 there as well, so this arm covers it.
      #
      # THE STICKY FLAG USED TO BE RAISED ONLY ON EXIT 0, so "the fence did not succeed" was
      # read as "no fence was raised" — and an exit code is not evidence about what was
      # committed. fence-db-connections.mjs COMMITS its REVOKEs and then asks whether the door
      # is actually shut; when the application keeps CONNECT through role membership, or the
      # room will not go quiet, it DELIBERATELY LEAVES THEM STANDING so nothing is half-applied.
      # PUBLIC, monitoring, backup, BI and any second application are locked out at that
      # moment. With the flag left false, an exit-4 release during cleanup — no record, and only
      # the application role's own CONNECT provable — took the warning-success branch, lowered
      # DB_FENCE_UP and let this run record a release nobody performed, over grantees still
      # revoked and now unrecorded.
      #
      # So the flag is raised for EVERY post-commit result, and the unproven release verdict is
      # fatal after one. This arm aborts like exit 3 does, but it says the opposite thing about
      # the database: exit 3 revoked nothing, this revoked and is holding.
      DB_FENCE_UP=true
      DB_FENCE_RAISED=true
      die "THE FENCE MAY BE STANDING AND CANNOT BE CALLED GOOD (exit 5): the REVOKEs were COMMITTED, or were issued to a COMMIT whose acknowledgement was lost — the reason this run will not call the database fenced is printed above. CONNECT may currently be denied to every grantee it took it from, which may include PUBLIC, monitoring, backup, BI and a second application, so this is NOT a run that changed nothing. Nothing has been migrated. Release it before starting anything: ${DB_FENCE_RELEASE_CMD}"
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
    # THE CANDIDATE DIGEST FIRST, BEFORE ANY REFUSAL BELOW CAN RETURN (o3d-2sm1.5 r34, Codex
    # CRITICAL). IMS_FENCE_ARTEFACT_SHA256 is a REQUIRED input now, not a hardening, and the host
    # that has to produce it is the release build host — which has no DEPLOY_ADMIN_DATABASE_URL,
    # no database and no fence to raise. If the value only appeared after those checks passed,
    # the one machine that is supposed to publish it could never print it.
    #
    # AND IT IS COMPUTED BY READING, NOT BY RUNNING (the same finding). db_fence_probe_script()
    # assembles the checkout's helper and its closure into a root-owned throwaway and hashes it;
    # it hands back something to EXECUTE only when the standing artefact is the authenticated one
    # or when IMS_FENCE_ARTEFACT_SHA256 authenticates the candidate. Otherwise
    # ${DB_FENCE_PROBE_SCRIPT} is empty, and this run preflights nothing rather than handing an
    # administrative credential to bytes the application account chose.
    # THE REPORT IS CAPTURED, NOT PROCESS-SUBSTITUTED (o3d-p9dq, Codex r33). db_fence_probe_report
    # only ever prints, but a producer nobody can take a status from is a shape this subsystem no
    # longer carries anywhere: `$( … )` gives this shell the status, and the `warn` loop then reads
    # from text it already holds rather than from a writer that could stop mid-report.
    local probe_rc=0 probe_line probe_report=""
    db_fence_probe_script || probe_rc=1
    probe_report="$(db_fence_probe_report)" || probe_report=""
    while IFS= read -r probe_line; do
      [[ -n "$probe_line" ]] || continue
      warn "$probe_line"
    done <<<"$probe_report"

    if [[ -z "$DEPLOY_ADMIN_DATABASE_URL" ]] || { [[ ! -f "$DB_FENCE_SCRIPT" ]] && [[ ! -f "$DB_FENCE_SCRIPT_COPY" ]]; } || [[ ! -f "$DB_OBJECT_ACCESS_SCRIPT" ]]; then
      db_fence_probe_cleanup
      warn "A REAL RUN WOULD BE REFUSED HERE: the migration window cannot be fenced."
      warn "DEPLOY_ADMIN_DATABASE_URL is not set (or ${DB_FENCE_SCRIPT##*/} is missing), so CONNECT"
      warn "could not be revoked for the window and nothing would stop a client attaching across"
      warn "the migration. See docs/installation.md. Nothing has been changed by this dry run."
      return 0
    fi
    if ! require_db_identity; then
      db_fence_probe_cleanup
      warn "A REAL RUN WOULD BE REFUSED HERE: the application's connection identity could not be"
      warn "read from ${APP_DIR_REAL}/.env — ${DB_IDENTITY_REASON}."
      warn "The fence is TOLD which host, port, role and database it closes; it does not work that"
      warn "out. Write DATABASE_URL as postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE with no"
      warn "host/port/user/dbname query parameter. Nothing has been changed by this dry run."
      return 0
    fi
    if ! require_env_file_is_sole_definition; then
      db_fence_probe_cleanup
      warn "A REAL RUN WOULD BE REFUSED HERE: ${DB_IDENTITY_SOURCE_REASON}."
      warn "The identity the fence is given is read from ${APP_DIR_REAL}/.env, so anything else that"
      warn "can define DATABASE_URL for the service means the fence and the application could be"
      warn "talking about different databases. Nothing has been changed by this dry run."
      return 0
    fi
    # The preflight changes nothing, so a dry run may run it for real — and reporting what it
    # actually says is the whole point of --dry-run. It is NOT fatal here: a dry run that
    # cannot reach the database must still exit 0, having said so.
    #
    # WHAT IT MAY RUN IT WITH IS NOT THIS SCRIPT'S CHOICE. db_fence_probe_script() decided that
    # above, and an empty ${DB_FENCE_PROBE_SCRIPT} means "nothing here is authenticated enough to
    # be handed DEPLOY_ADMIN_DATABASE_URL". r33 answered that case by snapshotting the checkout
    # into a root-owned throwaway and running it, which froze the bytes without authenticating
    # them: a substituted `pg` in the checkout stole the credential from an operator following the
    # printed digest-discovery instructions. So the dry run now reports the refusal instead of
    # being the vulnerability (o3d-2sm1.5 r34, Codex CRITICAL).
    if [[ "$probe_rc" -ne 0 ]] || [[ -z "$DB_FENCE_PROBE_SCRIPT" ]]; then
      warn "A REAL RUN WOULD NOT PREFLIGHT THE DATABASE FROM HERE, AND NEITHER DID THIS ONE:"
      warn "${DB_FENCE_PROBE_REASON:-there is no fence script this run is willing to execute.}"
      warn "The preflight is the only part of a dry run that opens the admin connection, so nothing"
      warn "was executed with DEPLOY_ADMIN_DATABASE_URL. Nothing has been changed by this dry run."
      db_fence_probe_cleanup
      return 0
    fi
    local dry_rc=0
    if [[ "$DB_FENCE_PROBE_SCRIPT" == "$DB_FENCE_SCRIPT_COPY" ]]; then
      warn "This dry run probes with the root-owned artefact at ${DB_FENCE_PROBE_SCRIPT}, which is the"
      warn "tree this box already publishes and verifies — not with the checkout's copy."
    else
      warn "This dry run probes with a throwaway copy of the tree IMS_FENCE_ARTEFACT_SHA256 named,"
      warn "which is the only checkout-derived tree it will execute with the admin credential."
    fi
    as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "$DB_FENCE_PROBE_SCRIPT" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" || dry_rc=$?
    db_fence_probe_cleanup
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
  [[ -f "$DB_FENCE_SCRIPT" || -f "$DB_FENCE_SCRIPT_COPY" ]] || die \
    "Neither ${DB_FENCE_SCRIPT} nor the root-owned copy at ${DB_FENCE_SCRIPT_COPY} exists, so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  [[ -f "$DB_OBJECT_ACCESS_SCRIPT" ]] || die \
    "${DB_OBJECT_ACCESS_SCRIPT} is missing from this checkout, so nothing would check that the application role can use what the migration creates. Nothing has been stopped and nothing has been migrated."
  require_db_identity || die \
    "The application's connection identity could not be read from ${APP_DIR_REAL}/.env: ${DB_IDENTITY_REASON}. The connection fence is TOLD which host, port, role and database it is closing — it no longer works that out from the environment. Write DATABASE_URL as a URL that states all four (postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE, with no host/port/user/dbname query parameter), or re-run with --skip-migrate. Nothing has been stopped and nothing has been migrated."
  require_env_file_is_sole_definition || die \
    "${DB_IDENTITY_SOURCE_REASON}. The connection identity handed to the fence is read from ${APP_DIR_REAL}/.env, and a service whose DATABASE_URL something else can define is a service the fence may be aimed away from. Re-run with --skip-migrate, which moves no schema and needs no fence. Nothing has been stopped and nothing has been migrated."

  # AND IT IS RUN, NOT LOOKED AT (o3d-2sm1.5, Codex r4 HIGH). This used to be `[[ -f ... ]]`
  # and nothing more, which proves the file exists and nothing about whether it works. Its
  # own dependency was a devDependency while the documented manual upgrade runs
  # `npm ci --omit=dev`, so the fence died with a missing module at drain-verify — AFTER the
  # stop. An outage for an import. --preflight runs the same imports, opens the same admin
  # connection and asks the same questions as --fence, and revokes, terminates and writes
  # nothing; the only reasons it can fail are the reasons --fence would fail.
  #
  # AND IT IS RUN FROM THE PROTECTED COPY, LIKE EVERY OTHER MODE (o3d-2sm1.5 r31). This probe
  # opens the admin connection as the application user; on an ordinary run it is what PUBLISHES
  # the protected copy, so the bytes preflighted here are the bytes the fence is raised with a few
  # phases later, and the application account gets no window between the two.
  local rc=0 preflight_script
  preflight_script="$(resolve_fence_script)" || die \
    "This run has no fence script it is willing to execute (the reason is printed above), so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$preflight_script" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?
  [[ "$rc" -eq 0 ]] || die \
    "The migration window could NOT be fenced (fence preflight exit ${rc}); the reason is printed above. Refusing to migrate. Nothing has been stopped and nothing has been migrated."

  ok "A connection fence is possible, and ${DB_FENCE_SCRIPT##*/} proved it by asking the database."
}

release_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: ${DB_FENCE_RELEASE_CMD}  (as ${APP_USER})"
    return 0
  fi
  # THE STATE FILE IS NOT ASKED WHETHER A FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
  # This used to begin `[[ -f "$DB_FENCE_STATE" ]] || return 0`, which is the same defect the
  # database-backed release was added to fix, one layer up: an ABSENCE treated as an ANSWER.
  # A durable revoke outlives a lost record, so on the exact failure the record-loss work
  # exists for, this function reported success without asking anything, the start path took
  # that for a released fence, removed the reboot fence and started an application with no
  # CONNECT on its own database. So the script is ALWAYS run, and it is the DATABASE that says
  # what is standing. Its exit codes: 0 released from a record and verified; 4 no record, and
  # the application role's own CONNECT is all that could be proven; anything else, a refusal.
  # AND THE SCRIPT IT ASKS WITH IS THE PROTECTED ONE (o3d-2sm1.5 r31, Codex CRITICAL). A release
  # GRANTS CONNECT back from a record of what was revoked, as the application user and with
  # DEPLOY_ADMIN_DATABASE_URL in its environment; running the checkout's own file for that let the
  # account being released rewrite what "released" means, and report success without doing it.
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || { echo -e "${RED}[ERROR]${RESET} Cannot release the connection fence: this run has no fence script it is willing to execute (the reason is printed above), so nothing here can ask the database whether one is standing." >&2; return 1; }

  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$fence_script" --release --state-file="$DB_FENCE_STATE" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?

  if [[ "$rc" -eq 0 ]]; then
    MIGRATION_DATABASE_URL=""
    DB_FENCE_UP=false
    ok "Connection fence released."
    return 0
  fi

  if [[ "$rc" -eq 4 ]]; then
    # EXIT 4: there is no record, and the database says the application role holds CONNECT.
    # That is the ONE thing it proves. The same fence revokes CONNECT from PUBLIC, monitoring,
    # backup, BI and any second application, and the application can be back inside through
    # PUBLIC or role membership while all of those are still shut out — the shape --fence
    # itself leaves standing when it rejects an ineffective fence. So it is never "released".
    DB_FENCE_UP=false
    if ${DB_FENCE_RAISED:-false}; then
      echo -e "${RED}[ERROR]${RESET} A CONNECTION FENCE WAS RAISED BY THIS RUN AND ITS RECORD IS GONE (exit 4)." >&2
      echo -e "${RED}[ERROR]${RESET} ${DB_FENCE_STATE} no longer holds a usable record, so nothing can restore the" >&2
      echo -e "${RED}[ERROR]${RESET} grants this run revoked. ${APP_USER}'s role can connect; PUBLIC and every other" >&2
      echo -e "${RED}[ERROR]${RESET} grantee the fence took CONNECT from may still be locked out, with no record of" >&2
      echo -e "${RED}[ERROR]${RESET} who they were. Audit the ACL by hand before this database is treated as open:" >&2
      echo -e "${RED}[ERROR]${RESET}   SELECT datacl FROM pg_database WHERE datname = current_database();" >&2
      return 1
    fi
    MIGRATION_DATABASE_URL=""
    warn "NO CONNECTION-FENCE RECORD, AND NO PROOF THAT NO FENCE IS STANDING (exit 4)."
    warn "The database says the application role can connect, and that is all it says. A fence"
    warn "revokes CONNECT from every grantee that held it — PUBLIC, monitoring, backup, BI — and"
    warn "the application can hold CONNECT through PUBLIC or role membership while those stay"
    warn "revoked. This run raised no fence and moved no schema, so it continues; if this box has"
    warn "ever had a deploy interrupted, audit the ACL before trusting it:"
    warn "  SELECT datacl FROM pg_database WHERE datname = current_database();"
    return 0
  fi

  echo -e "${RED}[ERROR]${RESET} THE CONNECTION FENCE COULD NOT BE RELEASED (exit ${rc}). The application role" >&2
  echo -e "${RED}[ERROR]${RESET} still has no CONNECT on this database and cannot start until this is undone:" >&2
  echo -e "${RED}[ERROR]${RESET}   ${DB_FENCE_RELEASE_CMD}" >&2
  echo -e "${RED}[ERROR]${RESET} or, by hand as a superuser, the GRANTs recorded in ${DB_FENCE_STATE}." >&2
  # o3d-2sm1.5 r32: every printed instruction gets asked whether it names a path that is still
  # TRUSTED. This one does not, and says so rather than being quietly dropped: ${DB_FENCE_STATE}
  # is under the application-owned fence directory by necessity (the fence runs as that account
  # and has to be able to release it), so what it records is evidence and not a script.
  echo -e "${RED}[ERROR]${RESET} READ them first: that file is written by the fence AS ${APP_USER} and lives in an" >&2
  echo -e "${RED}[ERROR]${RESET} application-writable directory, so it is evidence to check, not SQL to paste unseen." >&2
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
  [[ -f "$DB_FENCE_SCRIPT" || -f "$DB_FENCE_SCRIPT_COPY" ]] || return 1
  [[ -n "$DEPLOY_ADMIN_DATABASE_URL" ]] || return 1
  # THE TWO QUESTIONS ARE NOT THE SAME QUESTION, AND ONE OF THEM DOES NOT BELONG HERE
  # (o3d-2sm1.5 r23, Codex MEDIUM).
  #
  # require_db_identity() asks "do I know which connection to aim at" — necessary, and answered
  # from the PINNED values, which never move. require_env_file_is_sole_definition() asks
  # something else entirely: "can anything but ${APP_DIR_REAL}/.env define DATABASE_URL for the
  # service". That is a START gate. It protects the decision to open a database and hand it to an
  # application, and on the forward path it is exactly right.
  #
  # ON THIS PATH IT WAS A CONTRADICTION. The single largest reason control reaches here with the
  # fence down is that the post-release check REFUSED because a unit had acquired another
  # environment source — and the banner then promises the fence is being re-established. Calling
  # the same refusal again necessarily returns 1 on the same still-present disagreement, so the
  # promised re-fence was never attempted: the reboot fence went back, the banner admitted a
  # failure it had not actually tried, and the migrated database's CONNECT grants stayed
  # RELEASED, with remote writers and any second application free to reconnect during recovery.
  #
  # So it is asked only where it is a gate. Once this run has already fenced and migrated, the
  # database to re-close is not in question at all — it is the one in the pinned identity, the
  # one the standing state file records — and what some unit now claims about its environment
  # cannot make that database the wrong one to shut. It can make it wrong to START the
  # application, which is precisely what the refusal upstream has already decided.
  require_db_identity || return 1
  if ! $SCHEMA_TOUCHED && ! ${DB_FENCE_RAISED:-false}; then
    require_env_file_is_sole_definition || return 1
  fi

  # THE EXIT TRAP RUNS THE PROTECTED COPY TOO (o3d-2sm1.5 r31, Codex CRITICAL). This is the path
  # that runs when everything else has already gone wrong and nothing else is watching, which is
  # exactly where substituted code would most like to be handed the admin credential. A soft
  # refusal, like every other refusal in this function: dying inside an exit trap loses the status
  # and the banner.
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || return 1
  as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$fence_script" --fence --state-file="$DB_FENCE_STATE" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?
  # EVERY POST-COMMIT RESULT RAISES THE STICKY FLAG (o3d-2sm1.5, Codex r13 HIGH). Exit 5 says
  # the REVOKEs are COMMITTED and standing: this call could not call the database fenced, but it
  # certainly fenced something, and DB_FENCE_RAISED is the flag that decides whether a later
  # "no record, and only the application role's own CONNECT is provable" release may be walked
  # past. Raised here, that release becomes the refusal it should always have been.
  if [[ "$rc" -eq 5 ]]; then
    DB_FENCE_UP=true
    DB_FENCE_RAISED=true
    warn "THE RE-FENCE COMMITTED ITS REVOKES AND COULD NOT CALL THE DATABASE FENCED (exit 5)."
    warn "CONNECT is denied to the grantees it was taken from and nothing here has given it back,"
    warn "so this is a fence and not a no-op - but it was NOT proven to shut the application out."
    warn "The reason is printed above (usually CONNECT reaching the application through role"
    warn "membership, or a backend that would not drain). Do not trust it as a fence; it still has"
    warn "to be released before anything starts:"
    warn "  ${DB_FENCE_RELEASE_CMD}"
    return 1
  fi
  [[ "$rc" -eq 0 ]] || return 1
  DB_FENCE_UP=true
  DB_FENCE_RAISED=true
  # DO NOT SUBSTITUTE THE ADMIN URL WHEN THE COMPOSER REFUSES (o3d-2sm1.5, r6).
  # `--print-migration-url` throws precisely so that a migration can never run AS THE ADMIN
  # while the log announces the application role; catching that throw and assigning
  # DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit. Fail loudly and
  # leave it empty instead: the fence is up, and nothing this trap does next needs the URL.
  local url_rc=0
  MIGRATION_DATABASE_URL="$(as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "$fence_script" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}")" || url_rc=$?
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
    # AN ABSENT FILE IS NOT PROOF THAT NO PREVIOUS FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
    # This used to say so out loud — "No connection fence was standing" — on the strength of a
    # missing file, and then carry on adopting nothing. A durable revoke outlives its record,
    # and this is the path taken when the previous run had ALREADY REACHED THE MIGRATION, so a
    # fence certainly existed. Ask the database. With no record --release grants nothing and
    # restores nothing; it only reads, and it refuses (exit 1) when the application role is
    # locked out — which is exactly the recovery this must not walk past.
    local absent_rc=0
    release_db_connections || absent_rc=$?
    [[ "$absent_rc" -eq 0 ]] || die \
      "The previous run had already started migrating, so it had fenced the database — and the record of that fence at ${DB_FENCE_STATE} is gone while the database says the fence has NOT been undone: the application role has no CONNECT. Nothing here can reconstruct which grantees it revoked. Restore CONNECT by hand as a superuser, check pg_database.datacl for every other grantee that lost it, and re-run. Nothing has been migrated by this run."
    warn "The previous run had reached the migration, so it had raised a connection fence — and no"
    warn "record of it survives at ${DB_FENCE_STATE}. The database confirms only that the application"
    warn "role can connect, so this recovery goes on through the application role. Audit"
    warn "pg_database.datacl for any OTHER grantee that fence may still be holding out."
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

# PUBLISH THE CRONTAB BACKUP ATOMICALLY, OR NOT AT ALL (o3d-2sm1.5, Codex r8 HIGH).
#
# It used to be `printf > "$CRON_BACKUP"` followed by `chmod`, and only then the flag saying
# THIS run had created it. A full disk, a short write or a failing chmod therefore left a
# truncated — or wrongly permissioned — file at the authoritative path with
# CRON_BACKUP_CREATED still false, so the arming unwind regarded it as somebody else's and
# left it behind. The next run then found a backup at the expected path, adopted it as the
# previous run's verbatim original, and a successful unfence REPLACED the real crontab with
# those truncated contents — or with contents that predate whatever the operator edited after
# the failed attempt.
#
# So: write a temporary file in the SAME directory (same filesystem, so the rename is
# atomic), verify the complete content AND the mode, rename it into place, and raise the
# created-flag immediately. Every failure path removes the temporary file, or the file it had
# just published, and returns non-zero. What a failed publish leaves at $CRON_BACKUP is
# nothing at all.
publish_cron_backup() {
  local content="$1" tmp readback mode
  mkdir -p "$(dirname "$CRON_BACKUP")" || return 1
  tmp="$(mktemp "${CRON_BACKUP}.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$content" > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod 600 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # The whole content, read back off the filesystem. `$(cat ...)` and the value that was
  # written both lose their trailing newlines, so this compares every byte that matters.
  # THE READ-BACK TAKES ITS OWN STATUS (o3d-p9dq, Codex r31 sweep). This was
  # `if [[ "$(cat …)" != "${content}" ]]`, and a `cat` that could not run yields the empty string
  # — which is INDISTINGUISHABLE from the read-back of a backup whose content is legitimately
  # empty, because a crontab may genuinely have nothing in it. In that one case the verification
  # passed without having verified anything, and the run went on to fence the crontab trusting a
  # backup it had not read. Same shape as the planner's, and the same answer: the status first,
  # the comparison second.
  readback="$(cat "$tmp" 2>/dev/null)" || { rm -f "$tmp"; return 1; }
  if [[ "${readback}" != "$content" ]]; then rm -f "$tmp"; return 1; fi
  mode="$(stat -c '%a' "$tmp" 2>/dev/null)" || { rm -f "$tmp"; return 1; }
  if [[ "${mode}" != "600" ]]; then rm -f "$tmp"; return 1; fi
  # DURABLE, NOT MERELY VISIBLE (o3d-2sm1.5, Codex r9 HIGH). The read-back above proves the
  # bytes can be SEEN, and the page cache will happily satisfy it from memory. A power loss
  # after the crontab has been fenced would then reboot with this backup missing or
  # zero-length while publication had returned success — and the resume either restores an
  # empty crontab or leaves cron commented out for ever. Both barriers land BEFORE the
  # crontab is touched, because the caller invokes `crontab` only once this returns 0.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$CRON_BACKUP" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # temporary name, or no name at all, however well the data was flushed.
  if ! fsync_path "$(dirname "$CRON_BACKUP")"; then rm -f "$CRON_BACKUP"; return 1; fi
  # IMMEDIATELY. From here the file is authoritative, and it must be owned by this run in the
  # same breath, or the unwind disowns a backup it is the only one able to restore.
  CRON_BACKUP_CREATED=true
  readback="$(cat "$CRON_BACKUP" 2>/dev/null)" || {
    rm -f "$CRON_BACKUP"
    CRON_BACKUP_CREATED=false
    return 1
  }
  if [[ "${readback}" != "$content" ]]; then
    rm -f "$CRON_BACKUP"
    CRON_BACKUP_CREATED=false
    return 1
  fi
  return 0
}

# FENCE THE CRON WRITERS. Called ONLY where nothing is serving — after every `systemctl stop`, the
# stray sweep and the proof that :${PORT} is free — and it still takes the lock. The two cover
# different sets (o3d-p9dq, Codex r26 HIGH): the DRAIN is the only thing that excludes a
# PREDECESSOR build, whose reconciliation was written before this flock existed and cannot join it;
# the LOCK is what excludes every writer that comes after, and it is what makes the `crontab -l`
# below and the `crontab -` at the end of it ONE critical section rather than two — a reconciliation
# committing between them is discarded by a backup taken before it, and restored over later.
fence_cron() {
  # A MISSING `crontab` IS NOT "NO CRON WRITERS TO FENCE" (o3d-p9dq, Codex r29 HIGH #2). This line
  # used to return success on `command -v crontab` failing, and the run then took the database
  # fence and ran the migration with whatever the spool holds still scheduled. The client binary is
  # an editor; the daemon reads the spool directly and keeps the loaded schedule in memory, so
  # removing `crontab(1)` unschedules nothing. require_crontab_command() either finds the binary,
  # PROVES there is no per-user schedule and no daemon that could be holding one, or refuses — and
  # what its proof rests on, and how it can be wrong, is stated where it is defined.
  local crc=0
  require_crontab_command "$APP_USER" || crc=$?
  if [[ "${crc}" -eq 1 ]]; then
    die "The cron writers could not be fenced: ${CRONTAB_COMMAND_REASON}. A schedule this run cannot rule out is a schedule that can fire into a moving schema, which is the writer class this fence exists to stop. NOTHING HAS BEEN MIGRATED."
  fi
  if [[ "${crc}" -eq 2 ]]; then
    info "\`crontab\` is not installed, and $APP_USER has no spooled schedule and no cron daemon that could run one; nothing to fence."
    return 0
  fi
  local rc=0
  with_crontab_lock fence_cron_locked || rc=$?
  [[ "$rc" -eq 0 ]] || die \
    "The ${APP_USER} crontab could not be fenced$(if [[ "$rc" -eq "$CRONTAB_LOCK_CONFLICT" ]]; then printf ' because another process held %s for %ss — the application is reconciling the crontab, or a process is wedged holding that lock' "$CRONTAB_LOCK_FILE" "$CRONTAB_LOCK_WAIT_SECONDS"; fi)${CRON_FENCE_REASON:+: ${CRON_FENCE_REASON}}. The crontab was NOT replaced and the original schedule is still whatever it was. Fencing it without that lock is the defect this protocol exists to prevent: a reconciliation committing between the snapshot and the replacement would be silently discarded. NOTHING HAS BEEN MIGRATED."
}

fence_cron_locked() {
  local current
  # FAIL CLOSED, BEFORE THE DATABASE FENCE AND THE MIGRATION (o3d-p9dq, Codex r28 HIGH #2).
  # This is the read the whole-crontab fence rests on. `2>/dev/null || true` used to turn a
  # permission, spool or I/O failure into an empty string, which the line below read as "no
  # crontab" — and the run then walked on into the connection fence and the migration believing
  # it had disarmed cron, with every existing entry still scheduled. read_crontab_for() resolves
  # an absence only from the diagnostic that states one; everything else stops the run here.
  read_crontab_for "$APP_USER" || die \
    "The ${APP_USER} crontab could not be READ, so the cron writers cannot be fenced: ${CRONTAB_READ_REASON}. A crontab this run cannot read is not a crontab with nothing in it — taking the database fence and running the migration on that reading would leave every existing cron entry scheduled over a moving schema, which is the writer class this fence exists to stop. NOTHING HAS BEEN MIGRATED."
  current="$CRONTAB_READ_TEXT"
  if ! $CRONTAB_READ_PRESENT || [[ -z "$current" ]]; then
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
    # THIS run's backup, so the arming unwind is allowed to restore from it and delete it —
    # and it is only ever at that path once it is complete, verified and owned.
    publish_cron_backup "$current" || die \
      "The ${APP_USER} crontab could not be backed up to ${CRON_BACKUP}, so this run will not fence the cron writers: a fence whose backup cannot be verified is a crontab nobody can put back. Nothing at ${CRON_BACKUP} was left behind. The service IS STOPPED at this point — the fence is taken after the drain, so that no predecessor can write the crontab between the snapshot and the replacement — and NOTHING HAS BEEN MIGRATED."
    info "Crontab backed up verbatim: ${CRON_BACKUP}"
  else
    info "Reusing the crontab backup from the previous run: ${CRON_BACKUP}"
  fi

  # THROUGH THE SHARED PROJECTION, not a fourth copy of the awk. plan_crontab_unfence() decides
  # whether the snapshot is still current by re-running THIS transform over the backup and
  # comparing; a re-typed copy here would let the two drift and make that comparison meaningless.
  local fenced
  fenced="$(crontab_fence_projection "$current")" || {
    CRON_FENCE_REASON="the fence projection of the ${APP_USER} crontab could not be computed, so there is nothing this run is willing to install in its place"
    return 1
  }
  # THE WRITE IS CHECKED, AND CRON_FENCED IS RAISED ONLY AFTER IT IS CONFIRMED
  # (o3d-p9dq, Codex r30 CRITICAL). This was a bare `printf | crontab -` followed by
  # `CRON_FENCED=true`, on the belief that `set -e` covered it. It did not: `with_crontab_lock`
  # calls this body as `"$@" || rc=$?`, and a command on the LEFT of `||` runs with errexit
  # suspended for its WHOLE DYNAMIC EXTENT — every line in here included. A rejected write
  # therefore recorded the crontab as fenced, printed success, returned 0, and the run took the
  # database fence and migrated with the original schedule still live. Both halves matter: the
  # status is taken, and it is taken BEFORE the flag and BEFORE the success line.
  write_crontab_for "$APP_USER" "$fenced" || {
    CRON_FENCE_REASON="$CRONTAB_WRITE_REASON"
    return 1
  }
  CRON_FENCED=true
  ok "Cron writers fenced."
}

# UNFENCE. Unlike the fence, this runs while the new build IS SERVING — the health check and the
# responder proof are above it — so DRAINING covers nothing here and the lock is the only exclusion
# there is. It is sufficient, and for a reason the fence cannot rely on: the process that can race
# this one was built by THIS run, so it participates in this protocol by construction.
unfence_cron() {
  $CRON_FENCED || return 0
  local rc=0
  with_crontab_lock unfence_cron_locked || rc=$?
  [[ "$rc" -ne "$CRONTAB_WRITE_FAILED" ]] || die \
    "The ${APP_USER} crontab is still FENCED (every line commented out) because the restoring write was REJECTED: ${CRON_UNFENCE_REASON}. Nothing was installed, the backup at ${CRON_BACKUP} was NOT deleted, and this run has changed nothing else. The application is up and the migration is complete; settle the cause and put the schedule back by hand:  crontab -u ${APP_USER} ${CRON_BACKUP}"
  [[ "$rc" -ne "$CRONTAB_COMPUTE_FAILED" ]] || die \
    "The ${APP_USER} crontab is still FENCED (every line commented out) because this run could not COMPUTE what to put back: $CRON_UNFENCE_REASON. Nothing was installed and the backup at ${CRON_BACKUP} was NOT deleted. This is NOT a divergence — there are no two candidates to compare, and no schedule has been rewritten; a tool this protocol depends on did not run. Settle that, then put the schedule back by hand:  crontab -u ${APP_USER} ${CRON_BACKUP}"
  [[ "$rc" -ne "$CRONTAB_UNFENCE_DIVERGED" ]] || die \
    "The ${APP_USER} crontab is still FENCED (every line commented out) and this run will not decide what belongs in it: ${CRON_UNFENCE_REASON}. Neither candidate is safe to install without a human — the backup at ${CRON_BACKUP} would discard whatever rewrote the crontab, and undoing the fence in place would discard the lines listed above. Compare the two (crontab -u ${APP_USER} -l, against ${CRON_BACKUP}) and install the union by hand."
  [[ "$rc" -eq 0 ]] || die \
    "The ${APP_USER} crontab is still FENCED (every line commented out) because this run could not take ${CRONTAB_LOCK_FILE}$(if [[ "$rc" -eq "$CRONTAB_LOCK_CONFLICT" ]]; then printf ' within %ss' "$CRONTAB_LOCK_WAIT_SECONDS"; fi). The application is up and the migration is complete; put the schedule back by hand once nothing is reconciling:  crontab -u ${APP_USER} ${CRON_BACKUP}"
}

# NOT A BLIND RESTORE, AND THIS IS THE SITE THE FINDING NAMED (o3d-p9dq, Codex r27 HIGH #1).
#
# The new build accepted traffic several sections ago. Between that moment and this one an operator
# can save a schedule: the application takes the SAME lock, writes its managed block into the fenced
# crontab, releases, and reports success — correctly, because the settings row is committed. This
# function then takes the lock in its turn and, until now, installed a snapshot taken before the
# cutover over the top of it. Perfectly ordered. Completely wrong. The database and the UI went on
# saying the job was enabled and nothing was scheduled to run it.
#
# The lock cannot fix that, because nothing here is out of order. What fixes it is not restoring a
# snapshot whose world has moved: plan_crontab_unfence() proves the live crontab is still the
# fence's own projection of the backup before it uses the backup at all, and otherwise undoes the
# fence WHERE IT WAS APPLIED — which keeps the block the reconciliation projected from the settings
# rows, the durable record the crontab is only a projection of.
unfence_cron_locked() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would restore the ${APP_USER} crontab from ${CRON_BACKUP}, merging any managed block written while it was fenced"
    return 0
  fi
  [[ -f "$CRON_BACKUP" ]] || { warn "No crontab backup at ${CRON_BACKUP}; leaving the crontab as it is."; return 0; }
  local current backup
  # AND THE READ ITSELF FAILS CLOSED (o3d-p9dq, Codex r28 HIGH #1). An unreadable crontab used to
  # arrive here as the empty string, which holds nothing the backup does not — so the plan restored
  # the pre-cutover snapshot over whatever was really there.
  read_crontab_for "$APP_USER" || {
    CRON_UNFENCE_REASON="the live crontab could not be read, so nothing can establish what is in it and a snapshot installed on that reading would discard whatever is: ${CRONTAB_READ_REASON}"
    return "$CRONTAB_UNFENCE_DIVERGED"
  }
  current="$CRONTAB_READ_TEXT"
  if ! backup="$(cat "$CRON_BACKUP" 2>/dev/null)"; then
    CRON_UNFENCE_REASON="the backup at ${CRON_BACKUP} could not be read"
    return "$CRONTAB_UNFENCE_DIVERGED"
  fi
  # A COMPUTATION THAT COULD NOT BE MADE IS NOT A DIVERGENCE (o3d-p9dq, Codex r31 CRITICAL).
  # Both refuse, both keep the backup and both leave the crontab fenced — but they send the
  # operator to different places, and one of them is the wrong place. A divergence says "compare
  # these two crontabs and install the union"; a failed computation says "a tool this protocol
  # depends on did not run", and there is no union to compare. The status is forwarded rather
  # than folded into the one the caller already knew about.
  local plan_rc=0
  plan_crontab_unfence "$backup" "$current" || plan_rc=$?
  [[ "${plan_rc}" -ne "$CRONTAB_COMPUTE_FAILED" ]] || return "$CRONTAB_COMPUTE_FAILED"
  [[ "${plan_rc}" -eq 0 ]] || return "$CRONTAB_UNFENCE_DIVERGED"
  # THE ORDER IS THE FIX, NOT THE CHECK ALONE (o3d-p9dq, Codex r30 CRITICAL). The mirror of the
  # fence, and the worse half: a rejected write here used to be followed by `rm -f "${CRON_BACKUP}"`
  # — deleting the ONLY copy of the operator's schedule — and by `CRON_FENCED=false`, which tells
  # the unwind there is nothing to put back. The crontab stayed fenced and the run reported it
  # restored. So the write is checked first and returns ${CRONTAB_WRITE_FAILED}; the backup is not
  # touched, the flag is not cleared, and the caller prints the by-hand command.
  write_crontab_for "$APP_USER" "$CRON_UNFENCE_TEXT" || {
    CRON_UNFENCE_REASON="$CRONTAB_WRITE_REASON"
    return "$CRONTAB_WRITE_FAILED"
  }
  rm -f "$CRON_BACKUP"
  CRON_FENCED=false
  if [[ "$CRON_UNFENCE_PLAN" == "merge" ]]; then
    warn "Cron writers restored, and ${CRON_UNFENCE_REASON}."
  else
    ok "Cron writers restored verbatim from the backup."
  fi
}

# --- adopting somebody else's marker ---------------------------------------
# WAS THIS MARKER PUBLISHED IN ONE PIECE? (o3d-2sm1.5, Codex r9 HIGH)
#
# publish_durable_file() writes `marker_complete=1` last, so its presence is proof that
# every line above it reached the medium together. Its ABSENCE means one of two things and
# both are read the same way: a marker truncated by the pre-r9 in-place writer, or one
# written by a version of this script older than the sentinel. Either way the facts in it
# are unproven, and the only safe reading of an unproven `schema_touched` is "it may have
# been touched" — the opposite of the `false` that adoption used to default to before it
# released the connection fence.
marker_is_complete() {
  grep -qE '^marker_complete=1$' "$FENCE_FILE" 2>/dev/null
}

# What phase the run that wrote this marker had actually reached. A marker with no `phase=`
# line was written by an older version of this script, which only ever left one behind after
# a stop; the conservative reading of anything unrecognised is therefore `stopping`, because
# that is the reading which stops a service rather than leaving one running over a schema
# that may have moved.
marker_phase() {
  local phase
  phase="$(sed -n 's/^phase=//p' "$FENCE_FILE" 2>/dev/null | tail -1)"
  case "$phase" in
    arming) printf 'arming' ;;
    *) printf 'stopping' ;;
  esac
}

# NOT THE SAME SHAPE AS THE DRAIN, THOUGH IT LOOKS LIKE IT (o3d-p9dq, Codex r27 HIGH #3). A
# missing `ss` here makes this answer "no", and "no" sends the run down the ORDINARY adoption
# path, which stops the service and re-fences. That is the conservative direction: the failure
# mode of not knowing is that something gets stopped, not that a migration proceeds over a live
# writer. The drain proof below is the opposite way round, which is why it is fatal there and
# fail-safe here.
# IS THE PREDECESSOR STILL UP? Asked only to decide whether an interrupted ARMING can be
# resumed, and answered conservatively: a unit systemd reports active, or anything listening
# on this app's port, counts as "still serving". A `false` here sends the run down the
# ordinary adoption path, which stops and re-fences — the pre-existing behaviour.
predecessor_is_active() {
  local unit
  if command -v systemctl >/dev/null 2>&1; then
    for unit in "${SERVICE_UNITS[@]:-}"; do
      [[ -n "$unit" ]] || continue
      if systemctl is-active --quiet "$unit" 2>/dev/null; then
        RESUME_EVIDENCE="systemd reports ${unit} active"
        return 0
      fi
    done
  fi
  if command -v ss >/dev/null 2>&1 \
    && ss -ltn 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p {found=1} END{exit !found}'; then
    RESUME_EVIDENCE="something is still listening on :${PORT}"
    return 0
  fi
  return 1
}
RESUME_EVIDENCE=""
# Why an interrupted arming's crontab could NOT be put back, when the reason is a diverged crontab
# rather than a lock. Empty means the lock, which is what the message defaults to saying.
RESUME_CRON_DIVERGED=""

# RESUME AN INTERRUPTED ARMING WITHOUT STOPPING ANYTHING (o3d-2sm1.5, Codex r8 HIGH).
#
# The predecessor is up, the schema is untouched and every piece of state on this box is one
# the arming phase created and the arming phase can remove. So do exactly what unwind_arming
# would have done had the previous run reached its own trap — put the crontab back, take the
# reversible reboot fence down, release any connection fence — and then carry on from here,
# before the build, with nothing stopped.
#
# Order matters: the crontab is restored FIRST and a failure there is fatal BEFORE the fence
# comes down, so a run that cannot finish the unwind leaves the marker exactly as it found it
# and the next run adopts the same phase again.
# A BACKUP IS ONLY SAFE TO INSTALL BLINDLY IF THE WORLD STILL MATCHES WHAT IT WAS TAKEN FROM
# (o3d-p9dq, Codex r27 HIGH #2).
#
# This is the ONE path where the predecessor was never stopped and never held this lock — it is
# reached only for a marker written by a script older than this protocol — so the divergence here
# is not bounded by a deploy window at all: the interrupted run's backup may be minutes or hours
# old, and every schedule saved since then went into the LIVE crontab and into no backup. The lock
# cannot protect history made by a process that never joined it.
#
# So the same comparison as unfence_cron_locked, through the same helper — but the policy on a
# mismatch is REFUSE rather than merge, and the difference is deliberate. At unfence the window is
# ours, everything that could have written it holds this lock and writes the projection of the
# settings rows, so the merge is provably what the database says. Here it is not: an unattributable
# write over an unbounded interval could be the application's reconciliation or an operator's
# `crontab -e`, and nothing on this box can tell them apart. Nothing has been stopped at this point
# and nothing has been migrated, so a refusal costs a re-run and loses nothing — which is the
# cheapest thing in the room.
resume_restore_cron_locked() {
  local current backup
  RESUME_CRON_DIVERGED=""
  read_crontab_for "$APP_USER" || {
    RESUME_CRON_DIVERGED="the live crontab could not be read, so nothing can establish that the interrupted run's snapshot is still current: ${CRONTAB_READ_REASON}"
    return 1
  }
  current="$CRONTAB_READ_TEXT"
  backup="$(cat "$CRON_BACKUP" 2>/dev/null)" || return 1
  # THE COMPARISON HAS THREE ANSWERS NOW (o3d-p9dq, Codex r31 CRITICAL), and reading the third
  # one as the second would blame an operator write that never happened. Both refuse and both keep
  # the backup; only the message differs, and the message is the entire product of this branch.
  local unmoved=0
  crontab_is_unmoved_since_backup "$backup" "$current" || unmoved=$?
  if [[ "${unmoved}" -eq "$CRONTAB_COMPUTE_FAILED" ]]; then
    RESUME_CRON_DIVERGED="the comparison that decides whether ${CRON_BACKUP} is still current could not be MADE, so nothing has established that installing it would discard nothing — this is not a write somebody made, it is a check that did not run: $CRON_UNMOVED_REASON"
    return 1
  fi
  if [[ "${unmoved}" -ne 0 ]]; then
    RESUME_CRON_DIVERGED="the live crontab is not the fence's own projection of ${CRON_BACKUP}, so something has written it since the interrupted run took that snapshot — installing the snapshot would discard that write, or put back an entry somebody deliberately deleted"
    return 1
  fi
  write_crontab_for "$APP_USER" "$backup" || {
    RESUME_CRON_DIVERGED="the interrupted run's snapshot could not be installed: ${CRONTAB_WRITE_REASON}"
    return 1
  }
  rm -f "$CRON_BACKUP"
  CRON_FENCED=false
  ok "The ${APP_USER} crontab is back exactly as the interrupted run found it."
  return 0
}

resume_from_interrupted_arming() {
  # THE ONE SITE WHERE THE LOCK IS THE ONLY THING AVAILABLE AND IS NOT SUFFICIENT ON ITS OWN, said
  # plainly (o3d-p9dq). This path exists precisely because the predecessor is STILL SERVING and must
  # not be stopped, so draining is not on the table; and a crontab backup can only be here if a
  # PREVIOUS run fenced it, which — on the rollout that introduces this protocol — was a run whose
  # fence happened before the stop and whose predecessor did not take this lock. From the next
  # rollout on, the serving process participates and the lock is complete. Since o3d-p9dq the
  # cutover fence happens AFTER the stop, so an interrupted ARMING no longer leaves a fenced crontab
  # at all and this branch only fires for a marker written by an older script.
  # AN UNRESTORABLE FENCE IS NOT AN ABSENT ONE (o3d-p9dq, Codex r29 HIGH #2). The `command -v
  # crontab &&` that used to open this test made a missing client silently skip the restore, and
  # the run then continued with the interrupted run's fence still standing over the cron writers.
  # The backup file is the evidence; the missing tool is the reason it cannot be acted on.
  if [[ -f "$CRON_BACKUP" ]] && ! command -v crontab >/dev/null 2>&1; then
    die "The interrupted run had fenced the ${APP_USER} crontab and its backup is at $CRON_BACKUP, but \`crontab\` is not installed on this host, so it cannot be put back. Refusing to continue with the cron writers commented out: restore it by hand once the client is available and re-run. Nothing has been stopped."
  fi
  if [[ -f "$CRON_BACKUP" ]]; then
    with_crontab_lock resume_restore_cron_locked || die \
      "The interrupted run had fenced the ${APP_USER} crontab and its backup at ${CRON_BACKUP} could not be restored under ${CRONTAB_LOCK_FILE}.${RESUME_CRON_DIVERGED:+ THE REASON IS NOT THE LOCK: }${RESUME_CRON_DIVERGED} Refusing to continue with the cron writers commented out: settle it by hand (compare ${CRON_BACKUP} against crontab -u ${APP_USER} -l) and re-run. Nothing has been stopped."
  fi
  release_db_connections || die \
    "A connection fence was standing over an UNTOUCHED schema and could not be released. Fix that before re-running; nothing has been stopped."
  remove_reboot_fence
  if [[ -f "$FENCE_FILE" ]]; then
    die "${FENCE_FILE} could not be removed, so this host would still refuse to start ${SERVICE_UNITS[0]:-the service} on its next boot. Remove it by hand (rm -f ${FENCE_FILE}) and re-run. Nothing has been stopped."
  fi
  REBOOT_FENCE_INSTALLED=false
  ok "The interrupted arming has been undone. The predecessor was never stopped and is still serving."
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
  $CRON_BACKUP_CREATED || return 0
  # THE BINARY CHECK MOVED BELOW THE BACKUP CHECK, AND STOPPED REPORTING SUCCESS (o3d-p9dq, Codex
  # r29 HIGH #2). `command -v crontab || return 0` was the FIRST line here, so a run that had
  # fenced the crontab and then lost the client mid-run reported the unwind as complete with the
  # cron writers still commented out. Nothing this function could return would make that true; the
  # only honest answer is the failure that makes the caller print the by-hand command.
  if ! command -v crontab >/dev/null 2>&1; then
    return 1
  fi
  [[ -f "$CRON_BACKUP" ]] || return 1
  # UNDER THE LOCK, because this one can run while something is serving: the pre-stop branch of the
  # exit trap calls it through unwind_arming() with the predecessor untouched. A conflict is a
  # FAILURE here rather than a skip — the caller prints the by-hand command — because a silent skip
  # leaves a fenced crontab behind while reporting that everything was undone.
  with_crontab_lock restore_cron_from_backup_locked || return 1
  return 0
}

# THE SAME BLIND RESTORE, ON THE UNWIND PATH (o3d-p9dq, Codex r27 HIGH #1, "deploy and update
# contain the same blind restore"). This one runs from the exit trap, where something may well be
# serving — so it is routed through the identical plan rather than being the one restore that still
# overwrites a committed save. A divergence it cannot merge is reported as a failure and the caller
# prints the by-hand command, which is what it already did for a lock it could not take.
restore_cron_from_backup_locked() {
  local current backup
  read_crontab_for "$APP_USER" || {
    warn "The ${APP_USER} crontab could not be read, so it will not be restored from ${CRON_BACKUP}: ${CRONTAB_READ_REASON}"
    return 1
  }
  current="$CRONTAB_READ_TEXT"
  backup="$(cat "$CRON_BACKUP" 2>/dev/null)" || return 1
  plan_crontab_unfence "$backup" "$current" || {
    warn "The ${APP_USER} crontab will not be restored from ${CRON_BACKUP}: $CRON_UNFENCE_REASON"
    return 1
  }
  write_crontab_for "$APP_USER" "$CRON_UNFENCE_TEXT" || {
    warn "The ${APP_USER} crontab could not be restored from ${CRON_BACKUP}: ${CRONTAB_WRITE_REASON}"
    return 1
  }
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
      # AND THE BINDING COMES OFF, ALWAYS (o3d-2sm1.5 r23). The environment snapshot pins
      # DATABASE_URL over ${APP_DIR_REAL}/.env for as long as its drop-in is loaded, and it is
      # only ever right for the run that published it. Left standing after a failure it would
      # silently override a later, legitimate edit of the file — and the operator's first move
      # after reading this banner is usually to edit that file.
      remove_db_identity_snapshot
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
          echo -e "${RED}    ${DB_FENCE_REFENCE_CMD}${RESET}" >&2
        fi
      else
        release_db_connections || true
      fi
      # LAST, so the marker records the fence state that is true when this process
      # exits rather than the one that was true before the re-fence was attempted.
      write_fence_marker "deploy failed at ${CURRENT_STEP}" "${status}" || true
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
  acquire_cutover_lock
  # THE CRONTAB LOCK EXISTS BEFORE ANYTHING TOUCHES THE CRONTAB (o3d-p9dq). The adoption below is
  # the first thing that does, and on a host installed by a release that predates this protocol
  # there is no lock file yet — so this script prepares it exactly as scripts/install.sh does,
  # from the same function, rather than discovering it is missing at the point it needs it.
  prepare_crontab_lock
fi

# Which process actually serves this app dir? Look, do not assume: this box runs the
# app under systemd with Restart=always, and a plain `kill` there is undone in
# seconds. Match on WorkingDirectory so a second instance serving a DIFFERENT tree
# and a DIFFERENT database (the full-chain e2e rig) is never caught by this.
# A PARTIAL CENSUS IS NOT A SHORT LIST, IT IS AN OLD WRITER LEFT RUNNING (o3d-p9dq, Codex r33 HIGH).
#
# Every version of this enumeration until now was a process substitution — `< <(systemctl
# list-units … | awk …)`, and the whole function behind another one — whose producers report their
# exit to nobody. The roster in the serialization suite excused them on the grounds that a
# truncated list "can only drop units, and an empty one refuses the migrating deploy".
#
# THAT COVERS THE EMPTY CASE AND ONLY THE EMPTY CASE. Where this host runs TWO units against
# ${APP_DIR_REAL} — a stage box running `next dev` alongside the packaged unit is exactly that
# shape — a producer that emits the first and dies before the second leaves SERVICE_UNITS
# NON-EMPTY. It passes the "no unit serves this tree" refusal, and the deploy proceeds having
# fenced, stopped, environment-bound and restarted ONE of the two. The other is still up, still
# holding connections, and still executing the PREVIOUS release against a schema this run is about
# to move: precisely the version-skew write window the enumeration exists to close, reached
# through a check that was satisfied.
#
# SO EVERY PRODUCER HERE HAS A STATUS AND EVERY STATUS IS TAKEN. The census is captured whole and
# checked before a single line of it is parsed; the parsing is a here-string over that captured
# text, so no second process can die between the reader and the data. `awk` is gone — `read`'s own
# field splitting is what took its first column anyway, and it was one more unwatched producer.
# A failure anywhere is `return 1`, which the caller turns into a refusal: a census this run
# cannot vouch for must not become a list of the units it believes it stopped.
detect_service_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit rest wd resolved census
  local -a listed=()
  # THE WHOLE CENSUS FIRST, WITH ITS STATUS. `systemctl list-units` that died part-way through its
  # output exits non-zero, and unlike a process substitution's producer that status is this
  # shell's to take.
  census="$(systemctl list-units --type=service --all --plain --no-legend --no-pager 2>/dev/null)" || return 1
  # THEN PARSED, from text this shell already holds. `read` splits on IFS, so ${unit} is the first
  # column — what the `awk '{print $1}'` did, minus the process that could fail unnoticed.
  while read -r unit rest; do
    [[ -n "${unit}" ]] || continue
    listed+=("${unit}")
  done <<<"${census}"
  for unit in "${listed[@]:-}"; do
    [[ -n "${unit}" ]] || continue
    # AND THIS ONE IS THE SAME HAZARD ONE UNIT AT A TIME: `|| true` here meant a unit whose
    # WorkingDirectory could not be read was silently dropped from the roster, which for the unit
    # serving this tree is the partial census again with a smaller blast radius.
    wd="$(systemctl show -p WorkingDirectory --value "${unit}" 2>/dev/null)" || return 1
    [[ -n "${wd}" && -d "${wd}" ]] || continue
    resolved="$(readlink -f "${wd}")" || return 1
    if [[ "${resolved}" == "${APP_DIR_REAL}" ]]; then
      printf '%s\n' "${unit}"
    fi
  done
}

if [[ -n "${IMS_SERVICE_UNIT:-}" ]]; then
  mapfile -t SERVICE_UNITS <<<"${IMS_SERVICE_UNIT}"
else
  # THE STATUS, AND THEN THE LIST. An enumeration that failed is not an empty roster: an empty
  # roster is a claim that nothing serves this tree, and this run has no basis for making it.
  # Refusing here costs a re-run; proceeding costs a writer of the previous release surviving the
  # cutover, which is the one failure the units are enumerated to prevent.
  DETECTED_SERVICE_UNITS="$(detect_service_units)" || die \
    "The systemd unit census for ${APP_DIR_REAL} did not complete, so this run cannot say which units serve this tree — and a census that stopped part-way looks exactly like a host with fewer units, which would let a writer of the previous release survive the cutover. Nothing has been stopped and nothing has been migrated. Re-run, or name the units explicitly with IMS_SERVICE_UNIT=<unit> (newline-separated for more than one)."
  mapfile -t SERVICE_UNITS <<<"${DETECTED_SERVICE_UNITS}"
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
  # A MISSING `crontab` HERE IS WORSE THAN AT THE FENCE (o3d-p9dq, Codex r29 HIGH #2). This is the
  # adoption path: a backup file means a PREVIOUS run fenced this crontab and did not put it back.
  # Skipping on `command -v crontab` failing left that fence standing, un-re-verified, while this
  # run carried on into the migration. There is nothing to prove here — the backup IS the evidence
  # that a schedule exists — so the absence of the tool is fatal whenever the backup is present.
  if [[ ! -f "$CRON_BACKUP" ]]; then
    info "No crontab backup from the previous run; its cron entries were never fenced."
    return 0
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    die "A crontab backup from an interrupted run is at $CRON_BACKUP, so $APP_USER's crontab was fenced and never restored — but \`crontab\` is not installed on this host, so it can be neither re-fenced nor put back. Restore it by hand once the client is available and re-run. NOTHING HAS BEEN MIGRATED."
  fi
  # The backup holds the ORIGINAL crontab and must survive until this run finishes.
  CRON_FENCED=true
  # UNDER THE LOCK, and the read and the re-fence under the SAME hold: the question "are lines
  # active again?" and the answer "then comment them out" are one read-modify-write, and
  # with_crontab_lock is reentrant by refusal, so the nested fence_cron below runs on this hold
  # rather than deadlocking against it. This runs after the re-stop above but before the port has
  # been proved free, so the lock is doing real work here.
  local rc=0
  with_crontab_lock adopt_cron_fence_locked || rc=$?
  [[ "$rc" -eq 0 ]] || die \
    "The ${APP_USER} crontab could not be re-fenced under ${CRONTAB_LOCK_FILE} while adopting the previous run's fence. Refusing to continue with cron writers that may be live over a schema the previous run may have moved."
}

adopt_cron_fence_locked() {
  local current active
  # An unreadable crontab counts NO active lines, which reads as "still fenced" — and the run then
  # migrates over cron entries the previous run may have left live (o3d-p9dq, Codex r28).
  read_crontab_for "$APP_USER" || {
    warn "The ${APP_USER} crontab could not be read while adopting the previous run's fence: ${CRONTAB_READ_REASON}"
    return 1
  }
  current="$CRONTAB_READ_TEXT"
  active="$(printf '%s\n' "$current" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "$active" -gt 0 ]]; then
    warn "${active} cron line(s) are active again; re-fencing them."
    fence_cron
  else
    ok "Cron is still fenced; ${CRON_BACKUP} holds the original."
  fi
}

# ---------------------------------------------------------------------------
# IMPORTING THE LEGACY NAMESPACE (o3d-2sm1.5, Codex r9 HIGH).
#
# Before this round deploy.sh kept its cutover state under /var/lib/ims-deploy while
# install.sh and update.sh kept theirs under the application data directory. A host part-way
# through a cutover started by the OLD deploy.sh therefore has a standing fence at paths the
# shared namespace does not name — and a run that simply ignored them would take a fresh
# crontab backup over an already-fenced crontab, rewrite the shared drop-in and leave the
# previous marker orphaned. Exactly the failure the shared namespace exists to end.
#
# So each legacy artefact is MOVED into the canonical namespace before anything is adopted
# and long before any unit or crontab is touched, and it is moved durably: the content is
# republished through publish_durable_file(), so a crash mid-import leaves either the legacy
# copy or a complete canonical one.
#
# It never GUESSES. Both namespaces holding the same artefact means two runs were
# interrupted, and choosing between them would silently discard a crontab backup or a set of
# recorded grants nothing else can reconstruct.
import_legacy_file() {
  local legacy="$1" canonical="$2" what="$3" owner="${4:-}"
  [[ -e "$legacy" ]] || return 1
  if [[ -e "$canonical" ]]; then
    die "Two cutover namespaces both hold a ${what}: ${legacy} (the namespace deploy.sh used before o3d-2sm1.5) and ${canonical} (the shared one). Refusing to guess which fence is standing. Nothing has been stopped: read both, keep the one that describes the interrupted run, delete the other, and re-run."
  fi
  publish_durable_file "$canonical" < "$legacy" || die \
    "The ${what} at ${legacy} could not be published durably at ${canonical}, so this run cannot adopt the fence a previous run left standing. Nothing has been stopped and nothing has been migrated."
  [[ -z "$owner" ]] || chown "${owner}:${owner}" "$canonical" 2>/dev/null || true
  rm -f "$legacy"
  warn "Imported the ${what} into the shared cutover namespace: ${legacy} -> ${canonical}"
  return 0
}

import_legacy_cutover_state() {
  [[ "$LEGACY_CUTOVER_STATE_DIR" != "$CUTOVER_STATE_DIR" ]] || return 0
  [[ -d "$LEGACY_CUTOVER_STATE_DIR" ]] || return 0
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_STATE_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  local imported=false
  # The connection-fence state goes back to ${APP_USER}: the fence script runs as the app
  # user, and a root-owned copy is one it cannot release.
  if import_legacy_file "$LEGACY_DB_FENCE_STATE" "$DB_FENCE_STATE" "connection-fence state" "$APP_USER"; then imported=true; fi
  if import_legacy_file "$LEGACY_CRON_BACKUP" "$CRON_BACKUP" "crontab backup"; then imported=true; fi
  # LAST, because the marker is what adoption keys on: until it is at the canonical path
  # nothing adopts anything, so a crash part-way through this import leaves a run that finds
  # no marker and stops nothing.
  if import_legacy_file "$LEGACY_FENCE_FILE" "$FENCE_FILE" "cutover marker"; then imported=true; fi
  if $imported; then
    warn "The state above was left by a checkout that predates the shared cutover namespace."
    warn "It is adopted below exactly as if this run had written it."
  fi
  rmdir "$LEGACY_CUTOVER_STATE_DIR" 2>/dev/null || true
  return 0
}

if $DRY_RUN; then
  if [[ -e "$LEGACY_FENCE_FILE" || -e "$LEGACY_CRON_BACKUP" || -e "$LEGACY_DB_FENCE_STATE" ]]; then
    echo -e "${YELLOW}[DRY]${RESET}   would import the cutover state under ${LEGACY_CUTOVER_STATE_DIR} into ${CUTOVER_STATE_DIR} before adopting it"
  fi
else
  import_legacy_cutover_state
fi

if [[ -f "$FENCE_FILE" ]]; then
  # WHAT PHASE DID THE RUN THAT LEFT THIS ACTUALLY REACH? (o3d-2sm1.5, Codex r8 HIGH)
  #
  # Adoption used to take the marker's mere EXISTENCE as proof that the predecessor had been
  # stopped: it raised FENCE_ARMED and immediately stopped every unit. But the marker is
  # written during ARMING, before the first stop — so a SIGKILL, an OOM kill or a power cut
  # between install_reboot_fence() and that stop left a healthy predecessor running against
  # an untouched schema, and THIS run then stopped it, for the whole length of a build, to
  # recover from a failure that had cost nothing.
  #
  # Three things have to be true before that is treated as a resumable arming, and all three
  # are cheap to check: the marker says the phase was `arming`, it says the schema was never
  # touched, and the predecessor is still active right now. Any of them false and the run
  # falls through to the ordinary adoption below, which stops and re-fences exactly as before.
  ADOPTED_PHASE="$(marker_phase)"
  ADOPTED_SCHEMA_TOUCHED=false
  ADOPTED_MIGRATION_ATTEMPTED=false
  if grep -qE '^schema_touched=true$' "$FENCE_FILE" 2>/dev/null; then
    ADOPTED_SCHEMA_TOUCHED=true
  fi
  if grep -qE '^migration_attempted=true$' "$FENCE_FILE" 2>/dev/null; then
    ADOPTED_MIGRATION_ATTEMPTED=true
  fi
  # AN INCOMPLETE MARKER IS NOT A MARKER SAYING `false` (o3d-2sm1.5, Codex r9 HIGH).
  #
  # An unrecognised `phase=` was already read conservatively as `stopping`, but the two
  # flags were read INDEPENDENTLY and both defaulted to `false` when the line was missing —
  # so a marker truncated by the old in-place writer was adopted as "stopped, migrated
  # nothing", and the connection fence was RELEASED over a schema that may be half applied.
  # Missing is not false. It is unknown, and unknown is read the expensive way.
  if ! marker_is_complete; then
    warn "${FENCE_FILE} does not end with marker_complete=1, so it was never published in one"
    warn "piece: it is truncated, or was written by a version of this script older than the"
    warn "sentinel. Reading it the SAFE way — the schema may have moved and a migration may"
    warn "have been intended. This run re-migrates, re-checks drift and re-verifies before"
    warn "anything gets CONNECT back."
    ADOPTED_SCHEMA_TOUCHED=true
    ADOPTED_MIGRATION_ATTEMPTED=true
  fi

  if [[ "$ADOPTED_PHASE" == "arming" ]] && ! $ADOPTED_SCHEMA_TOUCHED && predecessor_is_active; then
    warn "Adopting an INTERRUPTED ARMING — a previous run was killed before it stopped anything:"
    sed 's/^/         /' "$FENCE_FILE"
    warn "The marker says phase=arming and schema_touched=false, and ${RESUME_EVIDENCE}."
    warn "Nothing was stopped, so nothing is recovered by stopping it now. This run undoes the"
    warn "reversible state that run had created and RESUMES from here, before the build, with"
    warn "the predecessor still serving the schema it was built against."
    if $DRY_RUN; then
      echo -e "${YELLOW}[DRY]${RESET}   would restore the ${APP_USER} crontab from ${CRON_BACKUP}, remove the"
      echo -e "${YELLOW}[DRY]${RESET}   reboot-fence drop-in and marker, and continue WITHOUT stopping anything"
    else
      resume_from_interrupted_arming
    fi
  else
    warn "Adopting an existing fence — a previous run stopped here:"
    sed 's/^/         /' "$FENCE_FILE"

    FENCE_ARMED=true
    # Read ONCE, above, and read conservatively there: a second independent grep is how the
    # missing-line-means-false defect got in. (`if`, not `&&`: under errexit a bare
    # `$flag && VAR=true` exits the script the moment the flag is false.)
    if $ADOPTED_MIGRATION_ATTEMPTED; then
      FENCE_MASK=true
    fi
    # Distinct from the mask: this says the previous run had actually INVOKED
    # `prisma migrate deploy`, so the schema may be half-applied. It decides whether the
    # connection fence is held or released, and it is carried forward so that a failure of
    # THIS run does not release a fence its predecessor was right to leave standing.
    if $ADOPTED_SCHEMA_TOUCHED; then
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
  # A SNAPSHOT AN EARLIER RUN LEFT BEHIND IS CLEARED HERE, BEFORE ANYTHING ASKS THE BUS
  # (o3d-2sm1.5 r23). Every exit path removes the binding, but a SIGKILL has no exit path, and a
  # drop-in surviving from a run that died would be a second definition of DATABASE_URL that
  # env_file_is_sole_database_url_source() refuses on sight — correctly, since this run did not
  # write it and has no idea what is in it. Clearing it is safe at this point: nothing has been
  # stopped, and removing a drop-in changes no running process's environment.
  $DRY_RUN || remove_db_identity_snapshot
  require_fenceable_database
elif ! $RESTART_ONLY; then
  # o3d-1izw, carried over from the pre-cutover deploy.sh. --skip-migrate applies nothing and
  # validates nothing, which is how a build reaches an environment whose database does not have
  # the push states it writes. The narrow check below is cheap enough to run on every such deploy
  # and refuses rather than shipping code whose first lapsed create claim fails at the database
  # and keeps failing on every sweep after.
  #
  # --restart-only is deliberately exempt: it delivers no new code, so it cannot introduce this
  # mismatch, and an emergency bounce must not be blocked by a database read. The running build is
  # covered by the sweep own preflight gate, which refuses before it writes anything.
  #
  # IT MOVED INTO validate, AND THAT IS THE SAME INTENT HONOURED BETTER. The old script ran it
  # where its migrate step would have been; this one has a phase whose whole contract is that
  # everything able to reject a release rejects it while the predecessor is still up. A
  # --skip-migrate run stops the predecessor a few phases below, so refusing here costs nothing
  # where refusing later costs an outage. It is still read-only, still one SELECT over pg_catalog,
  # and it still runs on exactly the --skip-migrate-but-not---restart-only path.
  info "Skipping migrations - verifying the database can hold what this build writes..."
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-wms-push-state-enum.mjs  (as ${APP_USER})"
  else
    as_app_user_db node scripts/check-wms-push-state-enum.mjs \
      || die "This database does not have the WMS push-state vocabulary this build writes, and ${SKIP_MIGRATE_FLAG} applies no migration that would give it one. Re-run without ${SKIP_MIGRATE_FLAG} (add --skip-build if the build on disk is the one you want). Nothing has been stopped."
    ok "WMS push-state vocabulary present."
  fi
fi
ok "Artefact validated."

# ---------------------------------------------------------------------------
# @deploy-phase: fence-writers
#
# Two phases in one block. `arming` first: the reboot fence and the cron fence go in, and
# every failure there is REVERSED by the trap with nothing stopped. Then `stopping`, from
# FENCE_ARMED=true onwards: nothing below restarts what we stop.
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

# THE CRON FENCE USED TO BE HERE, AND THAT WAS THE RACE (o3d-p9dq, Codex r26 HIGH).
#
# `fence_cron` snapshots the crontab, backs the snapshot up verbatim and replaces the crontab with
# a commented-out copy. Run at this point the predecessor is still serving, and six server actions
# can start a reconciliation from a browser at any moment — so a schedule an operator saved between
# the snapshot and the replacement went into a crontab this run was about to overwrite, and the
# verbatim backup restored later did not contain it. The database and the UI went on reporting the
# job enabled and nothing was scheduled to run it.
#
# ADDING THE FLOCK HERE WOULD NOT HAVE CLOSED IT. On the rollout that introduces the lock the
# predecessor was built before the lock existed: it excludes itself with a PostgreSQL advisory lock,
# or with nothing, and an flock taken here would have serialized this script against no one. The
# exclusion that reaches a process built before this protocol is that it is not running.
#
# So the fence has moved below the stop, the stray sweep and the port-free proof — see
# "Fence the cron writers" in the drain-verify phase. What stays here is the REBOOT fence, which
# must be installed before anything is stopped because a fence installed on the way out does not
# exist for a run that is killed.

# PHASE `stopping`. THIS is where the fence is armed, and not one line earlier: from the
# next statement on, something has been asked to stop and nothing may start it again. Every
# failure before this point took the reversible branch above (o3d-2sm1.5, Codex r7 HIGH).
FENCE_ARMED=true
# ...and the transition is on disk before the first `systemctl stop` runs, not after it.
if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would record phase=stopping in ${FENCE_FILE} and flush it BEFORE anything is stopped"
else
  persist_stop_requested
fi

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
  echo -e "${YELLOW}[DRY]${RESET}   would run: node ${DB_FENCE_SCRIPT_COPY} --fence  (as ${APP_USER})"
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-db-writers.mjs  (as ${APP_USER})"
else
  # AND THE DRAIN IS PROVED, NOT ATTEMPTED (o3d-p9dq, Codex r27 HIGH #3). The pipeline this
  # replaces read an `ss` that exited non-zero exactly as it read an `ss` that found nothing: the
  # grep failed to match either way, and an unanswerable question was recorded as the answer
  # "nobody is there" — at the one proof the cron fence below now rests on. require_port_drained
  # captures and validates the census separately from the empty-listener test, and every way of
  # not having an answer is fatal here, BEFORE the crontab is fenced and long before any migration.
  require_port_drained "${PORT:-}" || die \
    "The drain could not be PROVED before fencing the cron writers and migrating: ${PORT_DRAIN_REASON}. Since the cron fence moved below the stop, \"nothing is serving\" is the premise it rests on — the exclusion that reaches a predecessor built before the shared lock is that it is not running, and no lock this script takes can substitute for it. Install iproute2, or stop whatever still holds the port, and re-run. NOTHING HAS BEEN MIGRATED."
  ok "Port ${PORT} is free, and the census that says so ran."
fi

# ---------------------------------------------------------------------------
# AND ONLY NOW ARE THE CRON WRITERS FENCED (o3d-p9dq, Codex r26 HIGH).
#
# Nothing is serving: every unit is stopped, the strays are swept and :${PORT} has just been proved
# free. That is what makes the snapshot inside fence_cron safe against a PREDECESSOR build, which no
# lock of ours can reach. fence_cron additionally holds the shared crontab flock across its own
# `crontab -l` and `crontab -`, which is what makes it safe against everything that comes after.
#
# STILL BEFORE THE DATABASE PROBE BELOW: a cron tick that opens a connection is exactly what
# check-db-writers.mjs is about to refuse, so the writers are commented out first and the probe then
# asks whether the room is empty.
# ---------------------------------------------------------------------------
CURRENT_STEP="fence-cron"
step "Fence the cron writers"
fence_cron

CURRENT_STEP="drain-verify"
if ! $DRY_RUN && ! $SKIP_MIGRATE; then
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

# BEFORE THE RELEASE, WITH THE FENCE STILL HELD (o3d-2sm1.5 r22, Codex HIGH). The migration
# window is closing and the whole point of the fence is that the database it is holding shut is
# the database that is about to be served. If ${APP_DIR_REAL}/.env has been replaced, deleted or
# retargeted since the pin — or the unit has acquired another definition of DATABASE_URL — then
# releasing here opens database A and starts the application on database B.
#
# SO IT REFUSES, AND THE FENCE STAYS UP. This die reaches on_exit() with FENCE_ARMED and
# SCHEMA_TOUCHED both true, which is the path that HOLDS the connection fence, re-stops the
# units, re-installs the reboot fence and prints the release command; the state is stated there
# rather than claimed here. That is deliberately the expensive answer: a migrated database left
# closed is recoverable by a re-run, and an application started on the wrong one is not.
require_start_identity_unchanged || die \
  "THE CONNECTION FENCE IS BEING HELD AND THE APPLICATION IS NOT BEING STARTED: ${DB_IDENTITY_DRIFT_REASON}. The migration applied and every verification passed, but the identity this run fenced and migrated is no longer the one ${APP_DIR_REAL}/.env will give the service when systemd execs it — so releasing the fence and starting now would open the database this run migrated and start the application on a different one. Restore ${APP_DIR_REAL}/.env to the identity above and re-run this script, which adopts the standing fence; or, once you are certain which database the service should use, release it by hand with the command printed below. Do NOT start the service until one of those is done."

# AND THE IDENTITY IS NOT ONLY CHECKED, IT IS BOUND (o3d-2sm1.5 r23, Codex HIGH). The check
# above is the last READ, and a read is what rounds 13-22 kept failing to make sufficient: it
# finishes, and then the timestamp, the unmask, the logging and every earlier unit in the start
# loop execute before systemd opens the file. So the value it just proved is PUBLISHED where
# nothing but root can change it and every unit is made to load it last. From here on the
# question "which database will the service use" has an answer that does not depend on when it
# is asked.
#
# WITH THE CONNECTION FENCE STILL UP, deliberately: a failure here costs a re-run of a deploy
# whose schema is already migrated and whose database is still closed, which is the recoverable
# direction. Publishing after the release would leave a window in which the database is open and
# the service is startable by hand against whatever the file says.
publish_db_identity_snapshot || die \
  "THE CONNECTION FENCE IS BEING HELD AND THE APPLICATION IS NOT BEING STARTED: this run could not bind the service to the database it fenced and migrated (the reason is printed above). Without that binding the DATABASE_URL systemd reads at exec is whatever ${APP_DIR_REAL}/.env says at that instant, which is not something this script can hold still. Fix the cause and re-run; the re-run adopts the standing fence."

# THE UNMASK HAPPENS HERE, AHEAD OF THE FINAL RELOAD, AND NOT IN THE START LOOP (o3d-2sm1.5
# r24, Codex HIGH). `systemctl unmask` RELOADS SYSTEMD IMPLICITLY unless it is given
# --no-reload, so an unmask sitting between require_start_identity_bound and `systemctl start`
# re-read every unit file and every drop-in on disk AFTER the proof that the loaded configuration
# binds this service to this run's snapshot — once per unit, with the remaining units' starts
# still to come. r22's atomicity argument was sound about EXPLICIT reloads and blind to that one,
# and a concurrent unit or drop-in change could therefore remove, reorder or weaken the mandatory
# snapshot in the window the proof claimed to have closed.
#
# Moving every unit-file operation upstream of remove_reboot_fence()'s daemon-reload makes
# "nothing after the verification changes the loaded configuration" true BY CONSTRUCTION rather
# than by every future caller remembering --no-reload. After the proof the only systemctl verb
# left is `start`, which acts on the loaded configuration and does not re-read unit files.
#
# The unmask itself lifts a mask left by an older revision of this script, which masked from its
# exit trap; harmless when there is none. It is safe this early because a mask is not what holds
# the service down during the window — the stop and the reboot fence are — and unmasking starts
# nothing.
if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  for unit in "${SERVICE_UNITS[@]}"; do
    run systemctl unmask "$unit" >/dev/null 2>&1 || true
  done
fi

release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence

# AND ONCE MORE AFTER THIS RUN'S FINAL daemon-reload, WHICH remove_reboot_fence() JUST ISSUED,
# AND WITH EVERY UNIT-FILE COMMAND ALREADY BEHIND IT (o3d-2sm1.5 r24, Codex HIGH)
# (o3d-2sm1.5 r22, Codex HIGH). That reload is what folds every drop-in written during the
# window into the unit's loaded configuration, so this is the first moment the LOADED unit can be
# asked, and the last moment before `systemctl start` hands the file to systemd to read.
#
# A refusal here also leaves both fences standing, by the same route and without doing it by
# hand: the die reaches on_exit() with SCHEMA_TOUCHED true and DB_FENCE_UP false, which is
# exactly the branch that re-establishes the connection fence through refence_db_connections()
# and re-installs the reboot fence, and then says which of the two it actually managed.
require_start_identity_bound || die \
  "THE APPLICATION IS NOT BEING STARTED, AND BOTH FENCES ARE BEING PUT BACK: ${DB_IDENTITY_DRIFT_REASON}. This was checked after the final daemon-reload, so it is the loaded unit configuration and the current file contents that disagree with the identity this run fenced and migrated. It is also the check that proves the environment snapshot this run published is in that loaded configuration, loaded last and loaded mandatorily — the binding that makes the answer independent of anything that happens between this line and the exec. NOTHING BETWEEN HERE AND THE START RUNS A UNIT-FILE COMMAND AT ALL: the unmask moved above the final reload in r24 because it reloads implicitly, and every command left in the window is a timestamp, a shell test, a loop, an echo and \`systemctl start\` itself, which acts on the loaded configuration and does not re-read unit files. So the list of environment files systemd will read is now fixed. The connection fence was released a moment ago for the start and is being re-established below; the banner that follows says whether that succeeded and what is standing. Restore ${APP_DIR_REAL}/.env and the unit to the identity above and re-run this script, which adopts the fence. Do NOT start the service by hand first."

# The instant the restart was issued. The responder proof below requires the process on the
# port to post-date it: anything older survived the stop and is not what this run started.
SERVICE_START_EPOCH=$(date +%s)

if [[ "${#SERVICE_UNITS[@]}" -gt 0 ]]; then
  for unit in "${SERVICE_UNITS[@]}"; do
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
# The ARMING phase is over on every path that reaches here: the reboot fence came down in the
# start phase and there is nothing reversible left to reverse. Leaving CUTOVER_ARMING raised
# would send a failure in the cleanup below into the PRE-STOP branch of the trap, which would
# report a predecessor that was never stopped and unwind a fence that is already gone.
CUTOVER_ARMING=false

# THE STOP FLAG IS THE ESCAPE PATH'S ONLY REMAINING COVER (o3d-2sm1.5, Codex r8 MEDIUM).
#
# Past the point of no return the trap is governed by PAST_POINT_OF_NO_RETURN and FENCE_ARMED
# is irrelevant. On the ESCAPE path — IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1, where nothing
# identified the process on the port — neither proof flag is true, and the warning and the
# runbook both promise in so many words that the release is NOT irreversible and a later
# failure can still be torn down. Clearing FENCE_ARMED here broke that promise silently: a
# failure in the cron restore or the marker removal below then matched NONE of the trap's
# four phase branches, so the trap did nothing at all and an unidentified process was left
# serving the migrated schema.
#
# So it comes down here only for a run that no longer needs it, and for the escape path only
# once the cleanup it covers has actually finished.
if $PAST_POINT_OF_NO_RETURN; then
  FENCE_ARMED=false
fi

# THE BINDING COMES OFF HERE, on the success path (o3d-2sm1.5 r23). The service is running and
# has answered its health check, so it already HAS the environment; the drop-in has nothing left
# to do and everything to break, because from now on it would override ${APP_DIR_REAL}/.env for
# every restart, reboot and Restart= until somebody noticed a file in /etc/systemd/system that no
# document mentions. Removing it does not touch the running process.
remove_db_identity_snapshot

CURRENT_STEP="unfence-cron"
step "Restore the cron writers"
unfence_cron
# Already removed with the reboot fence in the start phase; kept so that a run which
# took a different path cannot leave a marker behind that refuses the next boot.
run rm -f "$FENCE_FILE"

# Cleanup is complete, so the escape path stands down too — and only now. A proven responder
# has been past this since the point of no return was armed.
FENCE_ARMED=false

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
