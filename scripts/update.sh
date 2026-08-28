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
#   3. anything else still attached (CONNECT is revoked from the application role for
#                                    the window, and scripts/check-db-writers.mjs then
#                                    asks Postgres, so a writer nobody enumerated
#                                    still blocks the migration)
#
# ON A POST-STOP FAILURE THE OLD VERSION STAYS DOWN. Restarting it against a migrated
# schema is the window this order exists to close. Fix and re-run — every step is
# idempotent and a re-run adopts the fence.
#
# THE THREE FENCES, AND WHEN EACH IS ESTABLISHED (o3d-2sm1.2).
#
#   1. THE REBOOT FENCE — a systemd drop-in carrying `AssertPathExists=!<marker>`,
#      installed and VERIFIED BEFORE the migration starts, not from the exit trap. A
#      fence that only exists if the script lives long enough to install it is not a
#      fence: power loss or a SIGKILL during the migration skips the trap entirely and
#      the predecessor comes back on the next boot against a migrated schema. It is a
#      drop-in rather than `systemctl mask` because masking symlinks the unit NAME to
#      /dev/null under /etc/systemd/system, which fails outright for a unit whose own
#      file lives there — and `mask --runtime` is erased by the very reboot it is meant
#      to survive. Installation is checked against `systemctl show -p DropInPaths`;
#      an unverifiable fence fails the deploy before anything is stopped.
#
#   2. THE CRON FENCE — the whole crontab commented out, backed up verbatim once, and
#      restored only after the new version answers its health check.
#
#   3. THE CONNECTION FENCE — CONNECT revoked from the application role and from PUBLIC
#      for the length of the window (scripts/fence-db-connections.mjs), so the drain is continuous
#      rather than a snapshot that anything can connect after. It needs a privileged
#      connection of its own (DEPLOY_ADMIN_DATABASE_URL), AND IT IS MANDATORY
#      (o3d-2sm1.4, Codex r3 HIGH). Round 2 warned on exit 3 — "CONNECT was not revoked" —
#      and carried on with the point-in-time probe, which repeats the mistake the probe
#      itself was: anything may attach after the snapshot. A fence you know is absent is
#      not a degraded fence, it is no fence, so exit 3 now ABORTS. Whether the variable is
#      set at all is checked in the VALIDATE phase, while the old version is still up and
#      a refusal costs nothing.
#
#      WHEN IT IS RELEASED, AND WHEN IT IS DELIBERATELY HELD (o3d-2sm1.3, Codex r2
#      CRITICAL). Releasing it from the exit trap unconditionally — which is what the
#      previous round did — let the application reconnect to a database whose schema was
#      in an unknown state after a failed or interrupted migration or a failed
#      verification. The distinction is whether the schema was TOUCHED:
#
#        * a failure before `prisma migrate deploy` was invoked RELEASES the fence,
#          because a revoke nobody undoes is an application that cannot reach its
#          database and nothing has moved;
#        * a failure at or after that invocation HOLDS it, and prints the command to
#          release it by hand.
#
#      AND THE FLAG IS WRITTEN TO DISK BEFORE PRISMA RUNS (o3d-2sm1.4, Codex r3 CRITICAL).
#      Set in shell memory with the durable marker left to the exit trap, it was false on
#      disk for exactly the failures it exists for — a SIGKILL, an OOM kill or a power cut
#      mid-migration never reaches a trap — so adoption read `schema_touched=false` and
#      released the fence over a half-migrated schema.
#
#      AND A FAILED START DOES NOT GET TO CLAIM THE FENCE IS UP (Codex r3 HIGH). The start
#      phase releases it before `systemctl start` and the health check; a failure in either
#      then reported a HELD fence over a database the application could already reach. The
#      trap re-stops, RE-ESTABLISHES the fence, and prints — and records — which is true.
#
#      A re-run ADOPTS a held fence, re-draining anything that attached in between, and
#      runs the recovery — the build included — through DEPLOY_ADMIN_DATABASE_URL. It
#      comes down in the start phase, once the migration, the drift check and every
#      declared verification have passed. The exit trap releases it ONLY for a failure that
#      never reached the migration; the sentence that used to stand here said it was released
#      in the trap unconditionally, which is the behaviour o3d-2sm1.3 removed.
#
#      IT REVOKES FROM EVERY GRANTEE (o3d-2sm1.5, Codex r4 HIGH). PUBLIC and the application
#      role were the only two; a third role with a direct CONNECT grant — monitoring, BI, a
#      backup job — was terminated by the drain and reconnected immediately, for the whole
#      migration, while this header said the database was held closed.
#
#      AND THE MIGRATION RUNS AS THE APPLICATION ROLE (o3d-2sm1.5, Codex r4 CRITICAL). The
#      fence forces the migration through the ADMIN connection, and whatever runs a CREATE
#      owns what it creates — so everything a migration made was owned by the deploy superuser
#      with no grant to the application, invisibly, because prisma, the drift check, the
#      verification hook and pg_dump all share that same admin connection and the health check
#      touches no database. The migration URL now carries `options=-c role=<app role>`, and
#      scripts/check-app-db-object-access.mjs asks the database afterwards whether the
#      APPLICATION role can use each table, view and sequence.
#
#      AND DEPLOY_ADMIN_DATABASE_URL IS NOT OPTIONAL. Older text here and in .env.example
#      called it optional and described a fall back to the snapshot probe. Both are gone: a
#      migration without it is refused in the validate phase, before anything is stopped.
#
# AND THERE IS A POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). DEPLOY_OK was set only after
# the cron restore and the marker removal, so under `set -e` a failing `crontab` reached the
# exit trap with the fence still armed — and the trap stopped the service that had just
# passed its health check, re-fenced it and re-revoked CONNECT. Past the health check nothing
# tears the deploy down; the failure is printed with the commands to finish by hand.
#
# A RE-RUN ADOPTS ALL THREE BEFORE IT REBUILDS. Finding the marker used to print a
# warning and carry on pulling and building for minutes while a rebooted or
# operator-started service served the half-migrated schema again. Adoption is now the
# first thing after the lock: re-stop, re-establish and verify the reboot fence,
# confirm cron is still fenced, and release any connection fence left standing.
#
# Usage:
#   bash update.sh              # pull latest from git and redeploy
#   bash update.sh --dry-run    # print the plan; change nothing (works unprivileged)
#   bash update.sh --no-git     # skip git pull (use current files)
#   bash update.sh --skip-build # skip npm build (migrations + restart only)
#
# IMS_APP_DIR / IMS_DATA_DIR / IMS_BACKUP_DIR / IMS_SERVICE_UNIT override the paths
# below. They exist so that --dry-run can be exercised against a fixture instead of
# the live installation; a real update leaves them unset.
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

# Read ONE variable out of a dotenv-style file WITHOUT `source`, which EXECUTES the file, and
# without `grep | cut`, which keeps the surrounding quotes and any trailing comment. This is the
# only way this script ever looks inside ${APP_DIR}/.env or ${APP_DIR}/.deploy-meta: both are
# owned by the application user, this script is root, and an application-owned byte must never
# be evaluated in a privileged shell (o3d-2sm1.5 r25, Codex CRITICAL). Byte-for-byte the reader
# scripts/install.sh and scripts/deploy.sh use.
#
# The quoting rules followed are dotenv's own, because dotenv is what reads .env everywhere else:
# a quoted value ends at its closing quote, an unquoted one ends at the first whitespace-preceded
# `#`, and later definitions win. A key that is absent, or a file that is not there, prints
# nothing and returns 0 — every caller decides for itself what an empty answer means.
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

APP_NAME="one-two-inventory"
APP_USER="imsapp"
APP_DIR="${IMS_APP_DIR:-/opt/${APP_NAME}}"
DATA_DIR="${IMS_DATA_DIR:-/var/lib/${APP_NAME}}"
BACKUP_DIR="${IMS_BACKUP_DIR:-/var/backups/${APP_NAME}}"
SERVICE_UNIT="${IMS_SERVICE_UNIT:-${APP_NAME}.service}"
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

# --dry-run changes nothing, so it does not need root. A real update stops a systemd
# unit and rewrites another user's crontab, so that one does.
if [[ $EUID -ne 0 ]] && ! $DRY_RUN; then
  die "Run as root: sudo bash update.sh  (--dry-run works unprivileged)"
fi

[[ -d "$APP_DIR" ]] || die "App directory ${APP_DIR} not found. Run install.sh first."
[[ -f "${APP_DIR}/.env" ]] || die ".env not found. Run install.sh first."

# ---------------------------------------------------------------------------
# THE APPLICATION'S OWN FILES ARE READ, NEVER EXECUTED (o3d-2sm1.5 r25, Codex CRITICAL).
#
# This script is root by the check above. ${APP_DIR}/.env and ${APP_DIR}/.deploy-meta are both
# owned by the APPLICATION user, and until this round both were `source`d here with `set -a`.
# `source` EXECUTES a file. Not "reads its assignments": a `$(...)` anywhere in it, a bare
# command on a line of its own, a redefinition of one of the functions above, an assignment to
# SERVICE_UNIT or APP_DIR or DEPLOY_META_FILE, an assignment INTO the array a later restore loop
# was going to read back — all of it ran AS ROOT, and all of it ran BEFORE any restore could put
# anything back. r24 restored the IMS_* deploy-control inputs afterwards, which repairs the
# values and not the execution, so it was not a boundary at all: an application-account
# compromise still reached root on the next update.
#
# NOTHING IN EITHER FILE IS EVALUATED NOW. Each variable this script actually needs is read out
# by name with env_file_value() — the non-evaluating dotenv reader defined at the top, the one
# install.sh and deploy.sh already use, and the one every later re-read of .env goes through. A
# line the reader is not asked for is never looked at. A line it is asked for becomes a string
# and nothing else: `IMS_CUTOVER_STATE_DIR=/tmp/x`, `SERVICE_UNIT=other.service` and
# `EVIL=$(id > /tmp/pwned)` are all just text on a line nobody asked about.
#
# THAT IS ALSO WHY r24'S DEPLOY-CONTROL CAPTURE/RESTORE IS GONE. It snapshotted every IMS_* path
# variable from the root invocation's environment and put it back after the source. With no
# source, no application-owned byte reaches this shell's variables at all — IMS_* can only come
# from the root invocation, which is the one source that legitimately steers this run — so the
# restore restored nothing and protected nothing that this does not. Two mechanisms where one
# suffices are two things to keep true; the property is asserted directly instead, in
# tests/scripts/deploy-order.test.ts.
#
# WHAT IS READ, AND FROM WHERE. Five names, and no others:
#
#   .env          DATABASE_URL               the application's connection. The file decides it
#                                            and an invocation value cannot override it — the
#                                            bus question below refuses unless this file is the
#                                            SOLE thing that defines it for the service, and a
#                                            value from somewhere else would make that a lie.
#                 DEPLOY_ADMIN_DATABASE_URL  the privileged connection the fence runs through.
#                                            Absent from the file, an invocation value stands.
#   .deploy-meta  GIT_REPO_URL               re-clone source, used ONLY as argv of a `git clone`
#                 GIT_BRANCH                 run AS THE APPLICATION USER (run_git_as_user) —
#                 GIT_DEPLOY_KEY_ENABLED     data that account already controls, and passed after
#                                            `--` so it cannot become an option. Never evaluated
#                                            here, and no privilege is crossed by it.
#
# INSTALL_FROM_GIT is written into .deploy-meta by install.sh and read by nothing here, so it is
# not read here either.
#
# AND NOTHING ELSE IN .env IS NEEDED. `set -a` exported the whole file into this shell and into
# every child process; that export is gone with the source. It was never what carried the
# values: every child that touches the database is handed DATABASE_URL and
# DEPLOY_ADMIN_DATABASE_URL explicitly through `env`, and the build reads ${APP_DIR}/.env itself
# through Next's own dotenv loader from ${APP_DIR}.
# ---------------------------------------------------------------------------
DATABASE_URL="$(env_file_value DATABASE_URL "${APP_DIR}/.env")"

# May be absent from .env, and `set -u` is on. Empty means "no privileged connection", which the
# connection fence reports as NOT FENCED rather than silently skipping. A value in the root
# invocation's environment is the FALLBACK, not an override — the `source` this replaced
# overwrote the invocation whenever the file named the key, and that precedence is kept.
_env_file_admin_url="$(env_file_value DEPLOY_ADMIN_DATABASE_URL "${APP_DIR}/.env")"
DEPLOY_ADMIN_DATABASE_URL="${_env_file_admin_url:-${DEPLOY_ADMIN_DATABASE_URL:-}}"
unset _env_file_admin_url

if [[ -f "${DEPLOY_META_FILE}" ]]; then
  GIT_REPO_URL="$(env_file_value GIT_REPO_URL "${DEPLOY_META_FILE}")"
  GIT_BRANCH="$(env_file_value GIT_BRANCH "${DEPLOY_META_FILE}")"
  GIT_DEPLOY_KEY_ENABLED="$(env_file_value GIT_DEPLOY_KEY_ENABLED "${DEPLOY_META_FILE}")"
fi

START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# THE FENCE STATE MACHINE (o3d-2sm1.1, phases added o3d-2sm1.5 Codex r7 HIGH).
#
# Four phases, one direction only, and the exit trap does something different in each:
#
# THE PHASE IS ALSO WRITTEN DOWN. A run that is killed never reaches its trap, so the phase
# it had reached has to survive in the marker for the NEXT run to read: write_fence_marker()
# records `phase=arming|stopping`, and adoption resumes an interrupted `arming` — old version
# still active, schema untouched — instead of stopping a service nobody had touched
# (o3d-2sm1.5, Codex r8 HIGH). See marker_phase() and resume_from_interrupted_arming().
#
#   none      Nothing this run created needs undoing; the trap just exits.
#   arming    CUTOVER_ARMING=true. Reversible cutover state exists — the reboot-fence
#             drop-in and marker, the cron fence — and NOTHING has been asked to stop. The
#             old version is up and healthy. A failure here is UNDONE: the crontab goes
#             back verbatim, the drop-in and marker THIS run wrote are removed, and nothing
#             is stopped. See unwind_arming().
#   stopping  FENCE_ARMED=true. A stop has been ATTEMPTED, or a previous run's fence was
#             adopted and its stop already happened.
#   serving   PAST_POINT_OF_NO_RETURN=true. The new version proved it is the process on the
#             port; nothing below may take that away.
#
# THE ARMING PHASE EXISTS BECAUSE IT WAS MISSING. FENCE_ARMED used to be raised before
# `fence_cron`, so a crontab backup that could not be written, a failed chmod, a broken
# pipeline or a `crontab` returning non-zero reached the trap looking exactly like a failed
# migration — and the trap STOPPED a service nobody had touched, kept the reboot fence and
# demanded a recovery, over a schema that had not moved. A failure in the cheap, reversible
# step ran the expensive, outage-causing machinery.
#
# FENCE_ARMED means: from here on, nothing in this script restarts what it stopped.
# A "rollback" that brings the old version back up against a MIGRATED schema is the
# exact window this order exists to close, so on a post-stop failure the correct
# state is DOWN — and fenced against a reboot by the drop-in installed before the
# migration started, so a power cut does not quietly undo it. Fix the cause and re-run:
# every step below is idempotent, and a re-run adopts all three fences before it builds.
# ---------------------------------------------------------------------------
# Phase `arming`: reversible cutover state exists and nothing has been stopped yet.
CUTOVER_ARMING=false
FENCE_ARMED=false
FENCE_MASK=false
# `prisma migrate deploy` HAS BEEN INVOKED: the schema may have moved, or half-moved.
# Distinct from FENCE_MASK, which only says this run INTENDS to migrate. The connection
# fence is held by this one, so a failure that never reached the migration still releases.
#
# IT IS PERSISTED AND FLUSHED BEFORE PRISMA IS INVOKED (o3d-2sm1.4, Codex r3 CRITICAL).
# A SIGKILL or a power cut during the migration never reaches the exit trap, so a flag that
# only lives in shell memory leaves a durable marker saying `schema_touched=false` — and the
# next run's adoption reads exactly that byte and RELEASES the connection fence over a
# half-migrated schema. See mark_schema_touched().
SCHEMA_TOUCHED=false
# Is the connection fence standing RIGHT NOW? Not the same question as SCHEMA_TOUCHED: the
# start phase releases the fence while SCHEMA_TOUCHED stays true, so a failure to start or a
# failed health check must not report a fence that is no longer there (Codex r3 HIGH).
DB_FENCE_UP=false
# DID THIS RUN EVER RAISE A CONNECTION FENCE (o3d-2sm1.5, Codex r12 HIGH). DB_FENCE_UP is
# lowered again by every release, so it cannot answer "was there a fence to release at all".
# This one is raised once and never lowered: if it is true and the release then reports it has
# no record to release FROM, the record this run wrote has been lost underneath it — a refusal,
# not a warning.
DB_FENCE_RAISED=false
DEPLOY_OK=false
CRON_FENCED=false
# Did THIS run write the crontab backup? The arming unwind restores from it; an ADOPTED
# backup belongs to a previous run's still-standing fence and must not be touched.
CRON_BACKUP_CREATED=false
CURRENT_STEP="startup"
BACKUP_FILE=""
# ---------------------------------------------------------------------------
# THE CUTOVER NAMESPACE, AND THERE IS EXACTLY ONE (o3d-2sm1.5, Codex r9 HIGH).
#
# deploy.sh used to keep its marker, cron backup, connection-fence state and lock under
# /var/lib/ims-deploy while this script and install.sh kept theirs under the application data
# directory. install.sh's own failure banner nevertheless told the operator that
# scripts/deploy.sh "adopts this fence", and following that instruction ran deploy.sh
# against a namespace holding none of it. So all four paths are resolved by the SAME
# expression in all three scripts, defaulting to the application data directory — what the
# installed unit's AssertPathExists= already names and what docs/installation.md documents.
CUTOVER_STATE_DIR="${IMS_CUTOVER_STATE_DIR:-${IMS_DEPLOY_STATE_DIR:-${IMS_DATA_DIR:-/var/lib/one-two-inventory}}}"
FENCE_FILE="${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CRON_BACKUP="${CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
FENCE_DROPIN_DIR="/etc/systemd/system/${SERVICE_UNIT}.d"
FENCE_DROPIN_FILE="${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
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
# ${IMS_CUTOVER_ENV_DIR:-/etc/ims-cutover}, and update.sh loaded ${APP_DIR}/.env into the
# environment AS ROOT — with `source`, until r25 — before it resolved this line, so the variable
# that chose where the snapshot goes was one THE APPLICATION USER WRITES. That hands back the entire point of the
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
# variable the application can set — and since r25 the file is READ rather than executed, so an
# IMS_* line in it never becomes a variable in this shell in the first place. See the load above.
DB_ENV_SNAPSHOT_DIR="/etc/ims-cutover"
DB_ENV_SNAPSHOT_FILE="${DB_ENV_SNAPSHOT_DIR}/db-identity-snapshot.env"
DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"
# install.sh has had this line since r23; update.sh did not, and used the variable in FIVE places
# inside publish_db_identity_snapshot() and remove_db_identity_binding(). Under `set -u` the
# first of them aborts the run with "unbound variable", so the binding this branch added to
# update.sh could never actually be published (o3d-2sm1.5 r25). Found by the reference scan in
# tests/scripts/deploy-order.test.ts, which is there so the next one is found the same way.
DB_ENV_SNAPSHOT_DROPIN_FILE="${FENCE_DROPIN_DIR}/${DB_ENV_SNAPSHOT_DROPIN_NAME}"
# ONE lock for all three entrypoints. This script held ${DATA_DIR}/update.lock and deploy.sh
# held its own, so "refusing to run two cutovers at once" was true of two updates and false
# of an update racing a deploy; install.sh took no lock at all.
LOCK_FILE="${CUTOVER_STATE_DIR}/cutover.lock"
# The namespace deploy.sh wrote to before this round. Nothing writes here any more, and a run
# that finds state at these paths IMPORTS it into the canonical namespace before it changes a
# unit or a crontab — see import_legacy_cutover_state().
LEGACY_CUTOVER_STATE_DIR="${IMS_LEGACY_CUTOVER_STATE_DIR:-/var/lib/ims-deploy}"
LEGACY_FENCE_FILE="${LEGACY_CUTOVER_STATE_DIR}/FENCED"
LEGACY_CRON_BACKUP="${LEGACY_CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
LEGACY_DB_FENCE_STATE="${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"
DB_FENCE_SCRIPT="${APP_DIR}/scripts/fence-db-connections.mjs"
DB_OBJECT_ACCESS_SCRIPT="${APP_DIR}/scripts/check-app-db-object-access.mjs"
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
  env_file_is_sole_database_url_source "${APP_DIR}/.env" "${SERVICE_UNIT:-}"
}

# `.env` was read above, so DATABASE_URL is in hand. A failure here is not fatal at this
# point — it is fatal in fence_db_connections() below, with the reason printed, before anything
# is stopped or migrated.
resolve_db_identity "${DATABASE_URL:-}" || true
DB_FENCE_RELEASE_CMD="node ${DB_FENCE_SCRIPT} --release --state-file=${DB_FENCE_STATE} ${DB_FENCE_IDENTITY_ARGS[*]:-}"

# ---------------------------------------------------------------------------
# AND RE-READ, BECAUSE SYSTEMD READS THAT FILE LATER THAN THIS DID
# (o3d-2sm1.5 r22, Codex HIGH). The same gap as scripts/deploy.sh, in the same words.
#
# The `source` above happens in the preflight, while the old version is still serving —
# before the build, before the stop, before the migration. `EnvironmentFile=` is read by systemd
# when it EXECS the service, at the far end of that window. r21's sole-source check closed "is
# this the file the service uses?" by asking the bus; it compares the configured PATH, and a path
# is not its contents. So an atomic replacement, a `rm` or a symlink retarget in between still
# moves the connection: this run fences and migrates database A and the service starts on
# database B. The unit loads the file with a leading `-`, which makes a MISSING file skipped
# rather than fatal, so a deletion does not even fail loudly — it hands the application back to
# its own dotenv overlays, the exact composition r19 stopped reproducing.
#
# NOTHING NEW IS CONSULTED. The file is still the single configured source, still proven sole by
# the bus read, still parsed by the same strict reader with the same refusals. Only WHEN changes.
DB_IDENTITY_PINNED_HOST="$DB_IDENTITY_HOST"
DB_IDENTITY_PINNED_PORT="$DB_IDENTITY_PORT"
DB_IDENTITY_PINNED_USER="$DB_IDENTITY_USER"
DB_IDENTITY_PINNED_DATABASE="$DB_IDENTITY_DATABASE"
DB_IDENTITY_DRIFT_REASON="the environment file has not been re-read yet"

# The re-read goes through env_file_value(), defined at the top beside run_as_user() — THE SAME
# READER THAT TOOK THE PIN. Since r25 there is only one reader in this script: the preflight load
# is a key-by-key read too, not a `source`, so the pinned value and every re-read below come
# through identical parsing rules and "the two readers disagree" is a class of failure that no
# longer exists. Nothing here re-executes the file, which is the other half of why: a `source`
# repeated mid-update would run whatever the file had become and overwrite every variable this
# run is holding.

# Re-read ${APP_DIR}/.env and require it to still state the pinned identity.
#
# IT RESTORES THE GLOBALS IT BORROWS, unconditionally. resolve_db_identity() writes DB_IDENTITY_*
# and CLEARS DB_FENCE_IDENTITY_ARGS as its first act, and those arguments are what
# release_db_connections() and the exit trap's re-fence are built from. A re-read that failed and
# left them empty would disarm the release on the one path where the fence is standing.
env_file_identity_unchanged() {
  local env_file="${APP_DIR}/.env"
  DB_IDENTITY_DRIFT_REASON=""

  if [[ -z "${DB_IDENTITY_PINNED_HOST}${DB_IDENTITY_PINNED_PORT}${DB_IDENTITY_PINNED_USER}${DB_IDENTITY_PINNED_DATABASE}" ]]; then
    DB_IDENTITY_DRIFT_REASON="no connection identity was pinned when this run started, so there is nothing to re-read ${env_file} against"
    return 1
  fi
  if [[ ! -e "$env_file" ]]; then
    DB_IDENTITY_DRIFT_REASON="${env_file} no longer exists. ${SERVICE_UNIT:-The service unit} loads it with a leading '-', so systemd SKIPS a missing environment file instead of failing on it, and the application would start on whatever its own dotenv overlays supply — not on the database this run fenced and migrated"
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
# Is the reboot fence ACTUALLY loaded by systemd right now? Distinct from FENCE_MASK, which
# only says this run intends to migrate: the failure banner used to describe a drop-in that
# may never have been installed (o3d-2sm1.5, Codex r4 HIGH).
REBOOT_FENCE_INSTALLED=false
# Did anything PROVE that the build on disk is the process answering the port? Nothing may be
# declared irreversible until it has (o3d-2sm1.5, Codex r5 HIGH).
NEW_BUILD_SERVING=false
NEW_BUILD_ID=""
# Rollback bookkeeping for install_reboot_fence(): what THIS call created, so a failure can
# remove exactly that and leave an already-standing fence alone.
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
# Whether THIS run published the environment snapshot, and which drop-ins it created. The first
# gates the tolerance in env_file_is_sole_database_url_source(): a snapshot loaded by a unit that
# this run did not publish is an unexplained pin, and is refused rather than accepted.
DB_ENV_SNAPSHOT_PUBLISHED=false
DB_ENV_SNAPSHOT_DROPINS_CREATED=()
# The point of no return: the new version has answered its health check. Nothing after this
# may stop it, re-fence it or revoke CONNECT again (o3d-2sm1.5, Codex r4 HIGH).
PAST_POINT_OF_NO_RETURN=false
# The connection the migration itself runs through. It becomes the privileged URL when
# the connection fence engages, because the fence closes the app role out and the
# migration must not be closed out with it.
MIGRATION_DATABASE_URL="${DATABASE_URL}"

run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: $*"
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------
# The reboot fence.
#
# The marker file is the condition; the drop-in is what makes systemd honour it. They
# are written together and BEFORE anything is stopped, so that a machine which loses
# power mid-migration comes back with the unit refusing to start rather than serving a
# half-migrated schema. `systemctl mask` is not usable for this unit: a mask is a
# symlink at /etc/systemd/system/<unit>, which is where a locally-installed unit file
# already lives, and `mask --runtime` writes to /run, which a reboot erases.
# ---------------------------------------------------------------------------
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
publish_durable_file() {
  local target="$1" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod 600 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 1: the data, before the name exists. After this the rename can only publish
  # bytes that are already on the medium.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # old name, or neither name, however well the data was flushed.
  #
  # A FAILURE HERE RETURNS NON-ZERO WITH THE NEW BYTES ALREADY AT $target (o3d-2sm1.5, Codex
  # r10 HIGH). That is not a leak, it is the honest answer: the content is VISIBLE and its
  # NAME is not proven, so a power loss can restore the previous directory entry and with it
  # the previous marker. Callers must act on THIS RETURN VALUE. Anything that greps $target
  # instead reads the new content and concludes a durability it was never given.
  fsync_path "$dir" || return 1
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
    # THE DURABLE PHASE, RECORDED SEPARATELY FROM EVERY INTENT (o3d-2sm1.5, Codex r8 HIGH).
    #
    # This marker is written during ARMING, before the first stop, so its EXISTENCE proves
    # only that some run got as far as creating reversible cutover state. Adoption used to
    # read that existence as proof the old version had been stopped, and neither of the two
    # lines below could correct it: `migration_attempted` is the INTENT to migrate and is
    # already true while the fence is only being armed, and `schema_touched` does not become
    # true until much later.
    echo "phase=$(if $FENCE_ARMED; then echo stopping; elif $CUTOVER_ARMING; then echo arming; else echo none; fi)"
    # THE INTENT to migrate. It is NOT evidence that a migration was attempted; `phase=`
    # above and `schema_touched=` below are the two lines that are.
    echo "migration_attempted=${FENCE_MASK}"
    echo "schema_touched=${SCHEMA_TOUCHED}"
    # Whether a drop-in is ACTUALLY loaded, not whether one was intended (o3d-2sm1.5).
    echo "reboot_fence=$($REBOOT_FENCE_INSTALLED && echo installed || echo absent)"
    echo "pre_migration_backup=${BACKUP_FILE:-none}"
    echo "cron_backup=${CRON_BACKUP}"
    echo "db_connect_fence_state=${DB_FENCE_STATE}"
    # What the operator reading this file is actually looking at. A SCHEMA_TOUCHED branch
    # printing "held" about a fence the start phase had already released is how a fence
    # that does not exist gets read as one (Codex r3 HIGH).
    echo "db_connect_fence=$($DB_FENCE_UP && echo held || echo released)"
    echo "release_db_connect_fence=${DB_FENCE_RELEASE_CMD}"
    # THE LAST LINE, AND IT IS THE POINT OF IT (o3d-2sm1.5, Codex r9 HIGH). A marker that
    # does not end here was never published by publish_durable_file(), so every fact above
    # it is unproven — including `schema_touched=`, whose ABSENCE adoption used to read as
    # `false` and release the connection fence over a possibly half-migrated schema. See
    # marker_is_complete().
    echo "marker_complete=1"
  } | publish_durable_file "${FENCE_FILE}" || {
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

# THE SCHEMA IS ABOUT TO MOVE — SAY SO ON DISK BEFORE IT DOES (o3d-2sm1.4, Codex r3 CRITICAL).
#
# The flag used to be set in shell memory immediately before Prisma ran, with the durable
# marker refreshed only by the exit trap. A kill -9, an OOM kill or a power cut during
# `prisma migrate deploy` never reaches that trap, so the marker on disk still said
# `schema_touched=false` — and the next run's adoption, which reads that file and nothing
# else, RELEASED the connection fence and let the application straight back onto a
# half-migrated schema. Set the flag, write the marker, flush it, then invoke Prisma.
mark_schema_touched() {
  # A dry run neither stops nor migrates anything, so the flag stays false and the failure
  # banner keeps telling the truth about a run that touched nothing.
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
  grep -qE '^schema_touched=true$' "${FENCE_FILE}" || die \
    "Could not record schema_touched=true in ${FENCE_FILE}. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  success "Recorded schema_touched=true in ${FENCE_FILE} (flushed) — an interrupted migration is now recoverable."
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
  [[ -f "${FENCE_FILE}" ]] || { error "Reboot fence NOT verified: the marker ${FENCE_FILE} does not exist."; return 1; }

  local dropins
  dropins="$(systemctl show -p DropInPaths --value "${SERVICE_UNIT}" 2>/dev/null || true)"
  if [[ "${dropins}" == *"${FENCE_DROPIN_FILE}"* ]]; then
    success "Reboot fence verified: systemd reports ${FENCE_DROPIN_FILE} loaded for ${SERVICE_UNIT}."
    return 0
  fi
  if systemctl cat "${SERVICE_UNIT}" 2>/dev/null | grep -qF "${FENCE_DROPIN_FILE}"; then
    success "Reboot fence verified: ${FENCE_DROPIN_FILE} appears in 'systemctl cat ${SERVICE_UNIT}'."
    return 0
  fi
  error "Reboot fence NOT verified: systemd does not report ${FENCE_DROPIN_FILE} for ${SERVICE_UNIT}."
  return 1
}

# A FAILED INSTALL LEAVES NOTHING BEHIND (o3d-2sm1.5, Codex r4 CRITICAL).
#
# The marker went down first, then the drop-in, then the reload, then the verify — and any
# failure after that first line returned 1 into a `|| die` while FENCE_ARMED was still false.
# The trap therefore did nothing, neither the marker nor the drop-in was removed, and the
# operator read a clean abort: nothing changed. Nothing had, except an AssertPathExists=! on
# a marker that now existed — invisible until the next reboot, when the unit failed its
# assertion with nothing connecting that to a deploy that had "changed nothing".
#
# The rollback removes only what THIS call created. install_reboot_fence is also how an
# adopted fence is re-established and how the exit trap puts one back, and rolling those back
# would lift a fence the host needs.
rollback_reboot_fence_install() {
  if ${FENCE_DROPIN_CREATED}; then
    rm -f "${FENCE_DROPIN_FILE}"
    rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
    command -v systemctl >/dev/null 2>&1 && { systemctl daemon-reload >/dev/null 2>&1 || true; }
    FENCE_DROPIN_CREATED=false
  fi
  # The marker is the condition, so removing it is what actually lifts the fence: it goes
  # only if this call created it AND nothing is relying on it.
  if ! ${FENCE_MARKER_PREEXISTED} && ! $FENCE_ARMED; then
    rm -f "${FENCE_FILE}"
  fi
  return 0
}

install_reboot_fence() {
  local reason="$1"
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would write ${FENCE_FILE} and ${FENCE_DROPIN_FILE}, daemon-reload, and verify with systemctl show -p DropInPaths"
    return 0
  fi

  FENCE_MARKER_PREEXISTED=false
  [[ -f "${FENCE_FILE}" ]] && FENCE_MARKER_PREEXISTED=true
  FENCE_DROPIN_CREATED=false
  REBOOT_FENCE_INSTALLED=false

  if ! command -v systemctl >/dev/null 2>&1; then
    error "systemctl is not available: there is NO reboot fence. Nothing stops this host"
    error "from starting the old version against a migrated schema after a reboot."
    rollback_reboot_fence_install
    return 1
  fi

  # A FENCE WHOSE MARKER IS NOT DURABLE IS NOT A FENCE. The marker is the condition the
  # drop-in asserts on, so a publish that could not be flushed must fail the install rather
  # than install a drop-in pointing at a file a power cut can lose.
  write_fence_marker "${reason}" || {
    error "${FENCE_FILE} could not be published durably, so there is NO reboot fence."
    rollback_reboot_fence_install
    return 1
  }

  # A DROP-IN SYSTEMD CAN READ IS NOT A DROP-IN THE MEDIUM WILL KEEP (o3d-2sm1.5, Codex r11
  # CRITICAL). Published through the same discipline as the marker it asserts on — file
  # fsync, rename, directory fsync, and the drop-in directory's own entry where this call
  # created it — and a failure is FATAL HERE, which is before CUTOVER_ARMING becomes
  # `stopping` and before the first `systemctl stop`. Everything undone by
  # rollback_reboot_fence_install() and by the pre-stop branch of the exit trap.
  [[ -f "${FENCE_DROPIN_FILE}" ]] || FENCE_DROPIN_CREATED=true
  if ! publish_durable_dropin "${FENCE_DROPIN_FILE}" <<EOF
[Unit]
# Installed by scripts/update.sh (o3d-2sm1.2) for the length of a cutover.
# While the marker below exists this unit must not start — not by hand, and not on
# boot. update.sh removes both once the new build has answered its health check.
AssertPathExists=!${FENCE_FILE}
EOF
  then
    error "${FENCE_DROPIN_FILE} could not be published durably, so there is NO reboot fence:"
    error "a reboot before it reached the medium would start ${SERVICE_UNIT} against a migrated schema."
    rollback_reboot_fence_install
    return 1
  fi

  if ! systemctl daemon-reload; then
    error "systemctl daemon-reload failed; the reboot fence is NOT active."
    rollback_reboot_fence_install
    return 1
  fi
  if ! verify_reboot_fence; then
    rollback_reboot_fence_install
    return 1
  fi
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
    echo -e "${YELLOW}[DRY]${RESET}   would remove ${FENCE_DROPIN_FILE}, daemon-reload, and delete ${FENCE_FILE}"
    return 0
  fi
  rm -f "${FENCE_DROPIN_FILE}"
  rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while lifting the reboot fence."
  fi
  # The marker is the condition, so deleting it is what actually lifts the fence. A
  # drop-in left behind is untidy rather than dangerous, but say so.
  rm -f "${FENCE_FILE}"
  [[ -e "${FENCE_DROPIN_FILE}" ]] && warn "Could not remove ${FENCE_DROPIN_FILE}; it is inert without ${FENCE_FILE}, but remove it by hand."
  return 0
}

# ---------------------------------------------------------------------------
# THE ENVIRONMENT SNAPSHOT: publish, and take it away again (o3d-2sm1.5 r23, Codex HIGH).
# ---------------------------------------------------------------------------
# Publish the DATABASE_URL this run fenced and migrated where only root can change it, and make
# every unit load it LAST. Called with the connection fence still up and nothing started, so a
# failure here costs a re-run and no outage.
publish_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would publish ${DB_ENV_SNAPSHOT_FILE} and the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in, daemon-reload, and verify the loaded EnvironmentFiles on the bus"
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || {
    error "systemctl is unavailable, so the started service cannot be bound to the database this run migrated."
    return 1
  }
  if [[ -z "${SERVICE_UNIT}" ]]; then
    error "No systemd unit is named for the application, so there is nothing to bind the environment snapshot to."
    return 1
  fi

  # A PATH SYSTEMD WOULD HAVE TO ESCAPE IS REFUSED, not escaped. The bus check compares the
  # loaded path against this one and refuses any element that had to be escaped, so emitting one
  # here would guarantee a refusal three lines later — with a message about somebody else's unit.
  case "$DB_ENV_SNAPSHOT_FILE" in
    *[$' \t\n\\']*)
      error "${DB_ENV_SNAPSHOT_FILE} contains whitespace or a backslash, so systemd could not state it back unescaped and the binding could not be verified. That path is the literal DB_ENV_SNAPSHOT_DIR at the top of this script; edit it there to one with neither."
      return 1 ;;
  esac

  # THE VALUE IS THE ONE THIS RUN PINNED, re-read from the file and re-checked against the pin by
  # the caller a moment ago. It is written SINGLE-QUOTED because that is the one form systemd
  # documents as verbatim — "can span multiple lines and contain any character verbatim other
  # than single quote" — so the deploy's reader and systemd's reader cannot disagree about it the
  # way they can about an unquoted value with a backslash in it.
  local value
  value="$(env_file_value DATABASE_URL "${APP_DIR}/.env")" || value=""
  if [[ -z "$value" ]]; then
    error "${APP_DIR}/.env no longer states a DATABASE_URL to bind the service to."
    return 1
  fi
  case "$value" in
    *"'"*|*$'\n'*)
      error "DATABASE_URL contains a single quote or a newline, which cannot be written into a systemd environment file verbatim. Re-write it without one."
      return 1 ;;
  esac

  # The directory first, root-owned and 0700, so that nothing running as the application user can
  # replace or remove what the unit is about to be pointed at.
  if ! mkdir -p "$DB_ENV_SNAPSHOT_DIR" \
     || ! chown root:root "$DB_ENV_SNAPSHOT_DIR" \
     || ! chmod 700 "$DB_ENV_SNAPSHOT_DIR"; then
    error "${DB_ENV_SNAPSHOT_DIR} could not be created root-owned and 0700, so the environment snapshot would sit somewhere the application user can rewrite."
    return 1
  fi

  printf "DATABASE_URL='%s'\n" "$value" | publish_durable_file "$DB_ENV_SNAPSHOT_FILE" || {
    error "${DB_ENV_SNAPSHOT_FILE} could not be published durably; the service is NOT bound and nothing has been started."
    return 1
  }
  # publish_durable_file() leaves 0600; the owner is root because this script runs as root, and
  # systemd reads EnvironmentFile= as PID 1 BEFORE it drops to User=. So the application user
  # never needs to read it — which is the point: the file that decides the connection is not one
  # the service, or anything running as it, can rewrite.
  chown root:root "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || true
  DB_ENV_SNAPSHOT_PUBLISHED=true

  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
  [[ -f "${DB_ENV_SNAPSHOT_DROPIN_FILE}" ]] || DB_ENV_SNAPSHOT_DROPINS_CREATED+=("${DB_ENV_SNAPSHOT_DROPIN_FILE}")
  if ! publish_durable_dropin "${DB_ENV_SNAPSHOT_DROPIN_FILE}" <<EOF
[Service]
# Installed by scripts/update.sh (o3d-2sm1.5 r23) for the length of ONE cutover, and removed
# again before this run exits. It binds the service to the database this run fenced and
# migrated: systemd reads environment files in order and the LAST definition of a variable
# wins, so this beats whatever ${APP_DIR}/.env says at the moment of exec.
# No leading '-': if the file is gone, the start must FAIL rather than fall back.
EnvironmentFile=${DB_ENV_SNAPSHOT_FILE}
EOF
  then
    error "${DB_ENV_SNAPSHOT_DROPIN_FILE} could not be published durably, so ${SERVICE_UNIT} is NOT bound to the database this run migrated."
    return 1
  fi

  if ! systemctl daemon-reload; then
    error "systemctl daemon-reload failed, so the environment snapshot is not in the unit's loaded configuration."
    return 1
  fi
  return 0
}

# Take the binding away. Called on EVERY exit path, successful or not: a drop-in left standing
# would pin a DATABASE_URL that a later, legitimate edit of ${APP_DIR}/.env could not
# override, and it would do so silently.
remove_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would remove the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-ins, daemon-reload, and delete ${DB_ENV_SNAPSHOT_FILE}"
    return 0
  fi
  local removed=false
  if [[ -e "${DB_ENV_SNAPSHOT_DROPIN_FILE}" ]]; then
    rm -f "${DB_ENV_SNAPSHOT_DROPIN_FILE}"
    removed=true
  fi
  rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
  if $removed && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while removing the environment snapshot drop-ins."
  fi
  rm -f "$DB_ENV_SNAPSHOT_FILE"
  DB_ENV_SNAPSHOT_PUBLISHED=false
  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
  return 0
}

# ---------------------------------------------------------------------------
# The connection fence. See scripts/fence-db-connections.mjs for what it can and
# cannot promise; the important part here is that a failure to RELEASE it is an
# application that cannot reach its database at all, so every path releases it and
# every path that cannot says exactly what to run by hand.
# ---------------------------------------------------------------------------
fence_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/fence-db-connections.mjs --fence"
    return 0
  fi
  [[ -f "${DB_FENCE_SCRIPT}" ]] || die \
    "${DB_FENCE_SCRIPT} is not in this checkout, so this run cannot hold the database closed for the migration window. A snapshot probe is not a fence. Restore the script (it ships with the app) and re-run; nothing has been migrated."

  # THE FENCE IS TOLD WHICH CONNECTION IT IS ABOUT, OR IT DOES NOT RUN (o3d-2sm1.5 r19).
  require_db_identity || die \
    "The application's connection identity could not be read from DATABASE_URL in ${APP_DIR}/.env: ${DB_IDENTITY_REASON}. The connection fence is TOLD which host, port, role and database it is closing — it no longer works that out from the environment, because seven rounds of doing so each uncovered another layer of systemd, Next and libpq composition. Write DATABASE_URL as a URL that states all four (postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE, with no host/port/user/dbname query parameter) and re-run. Nothing has been stopped and nothing has been migrated."
  # AND THE FILE IT WAS READ FROM MUST BE THE ONLY THING THAT CAN DEFINE IT (o3d-2sm1.5 r20,
  # Codex CRITICAL). Four values read out of a file the service may not use are four values about
  # the wrong database.
  require_env_file_is_sole_definition || die \
    "${DB_IDENTITY_SOURCE_REASON}. The fence, the migration and the release would all agree with each other about the database ${APP_DIR}/.env names, while the application that restarts afterwards connects somewhere else — a migration on a database nothing fenced, and a new build on a database nothing migrated. Nothing has been stopped and nothing has been migrated."

  # AND THE FILE MUST STILL SAY WHAT IT SAID WHEN THIS RUN READ IT (o3d-2sm1.5 r22, Codex HIGH).
  # The identity above was read once, in the preflight, before the build and before the stop;
  # this is the last moment before the fence is aimed. Nothing has been fenced yet, so a
  # disagreement here is the cheap one — it costs a restart of the old version and no schema.
  require_start_identity_unchanged || die \
    "The connection identity this run pinned is no longer the one ${APP_DIR}/.env gives the service: ${DB_IDENTITY_DRIFT_REASON}. DATABASE_URL was read once, in the preflight, and systemd does not read the environment file until it execs the service — so fencing on the pinned identity now would fence and migrate one database while the application starts on another. NO FENCE HAS BEEN RAISED and nothing has been migrated. Put the file back the way this run found it, or re-run so the identity is pinned from what the file says now."

  mkdir -p "${DB_FENCE_DIR}"
  chown "${APP_USER}:${APP_USER}" "${DB_FENCE_DIR}"
  chmod 700 "${DB_FENCE_DIR}"

  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?

  case "${rc}" in
    0)
      # THE MIGRATION CONNECTS AS THE ADMIN AND RUNS AS THE APPLICATION ROLE (o3d-2sm1.5).
      # The bare admin URL is what made every object a migration created owned by the deploy
      # superuser with no grant to the application: the drift check, the verification hook and
      # pg_dump all share this same admin connection and read it perfectly, so the deploy
      # passed and every request touching the new table failed with "permission denied".
      MIGRATION_DATABASE_URL="$(run_as_user "${APP_USER}" env \
        DATABASE_URL="${DATABASE_URL}" \
        DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
        node "${DB_FENCE_SCRIPT}" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}")" || die \
        "The connection fence is up but the migration URL could not be composed, so the migration would run as the deploy admin and create objects the application cannot use. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      [[ -n "${MIGRATION_DATABASE_URL}" ]] || die \
        "The connection fence is up but --print-migration-url produced nothing. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      DB_FENCE_UP=true
      DB_FENCE_RAISED=true
      success "Connection fence up: new application connections are refused for the window."
      success "The migration will connect as the deploy admin and RUN AS the application role, so what it creates is owned by the application."
      ;;
    3)
      # EXIT 3 IS "CONNECT WAS NOT REVOKED", AND IT ABORTS (o3d-2sm1.4, Codex r3 HIGH).
      # A warning plus the point-in-time probe repeats the mistake the probe itself was:
      # anything may attach after the snapshot and write across the migration. A fence we
      # know is absent is not a degraded fence, it is no fence.
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

# Asked in the VALIDATE phase, while the old version is still up and a refusal costs
# nothing. The database can only answer some of the reasons a fence is impossible (a
# superuser application role, a CONNECT arriving through role membership) and drain-verify
# asks it those; but the commonest reason of all — no privileged connection at all — is
# knowable from here, and paying an outage to discover an unset variable is not a trade.
require_fenceable_database() {
  # A dry run stops nothing and migrates nothing, so it REPORTS the refusal instead of being
  # it: the point of --dry-run is to find out what a real run would do.
  if $DRY_RUN; then
    if [[ -z "${DEPLOY_ADMIN_DATABASE_URL}" ]] || [[ ! -f "${DB_FENCE_SCRIPT}" ]] || [[ ! -f "${DB_OBJECT_ACCESS_SCRIPT}" ]]; then
      warn "A REAL RUN WOULD BE REFUSED HERE: the migration window cannot be fenced."
      warn "DEPLOY_ADMIN_DATABASE_URL is not set (or fence-db-connections.mjs is missing), so CONNECT"
      warn "could not be revoked for the window and nothing would stop a client attaching across the"
      warn "migration. See docs/installation.md. Nothing has been changed by this dry run."
      return 0
    fi
    if ! require_db_identity; then
      warn "A REAL RUN WOULD BE REFUSED HERE: the application's connection identity could not be"
      warn "read from DATABASE_URL in ${APP_DIR}/.env — ${DB_IDENTITY_REASON}."
      warn "The fence is TOLD which host, port, role and database it closes; it does not work that"
      warn "out. Write DATABASE_URL as postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE with no"
      warn "host/port/user/dbname query parameter. Nothing has been changed by this dry run."
      return 0
    fi
    if ! require_env_file_is_sole_definition; then
      warn "A REAL RUN WOULD BE REFUSED HERE: ${DB_IDENTITY_SOURCE_REASON}."
      warn "The identity the fence is given is read from ${APP_DIR}/.env, so anything else that can"
      warn "define DATABASE_URL for the service means the fence and the application could be talking"
      warn "about different databases. Nothing has been changed by this dry run."
      return 0
    fi
    # The preflight changes nothing, so a dry run may run it for real — and saying what it
    # actually answered is the whole point of --dry-run. Not fatal here: a dry run that cannot
    # reach the database still exits 0, having said so.
    local dry_rc=0
    run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" || dry_rc=$?
    if [[ "${dry_rc}" -eq 0 ]]; then
      success "A REAL RUN WOULD BE FENCEABLE: the preflight above asked the database and it answered yes."
    else
      warn "A REAL RUN WOULD BE REFUSED HERE (fence preflight exit ${dry_rc}); the reason is above."
      warn "Nothing has been changed by this dry run."
    fi
    return 0
  fi
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || die \
    "DEPLOY_ADMIN_DATABASE_URL is not set, so this update has no privileged connection that would survive revoking CONNECT from the application role — the database cannot be held closed for the migration window. Set it in ${APP_DIR}/.env (a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL; docs/installation.md) and re-run. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_FENCE_SCRIPT}" ]] || die \
    "${DB_FENCE_SCRIPT} is missing from this checkout, so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_OBJECT_ACCESS_SCRIPT}" ]] || die \
    "${DB_OBJECT_ACCESS_SCRIPT} is missing from this checkout, so nothing would check that the application role can use what the migration creates. Nothing has been stopped and nothing has been migrated."
  require_db_identity || die \
    "The application's connection identity could not be read from DATABASE_URL in ${APP_DIR}/.env: ${DB_IDENTITY_REASON}. The connection fence is TOLD which host, port, role and database it is closing — it no longer works that out from the environment. Write DATABASE_URL as a URL that states all four (postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE, with no host/port/user/dbname query parameter) and re-run. Nothing has been stopped and nothing has been migrated."
  require_env_file_is_sole_definition || die \
    "${DB_IDENTITY_SOURCE_REASON}. The connection identity handed to the fence is read from ${APP_DIR}/.env, and a service whose DATABASE_URL something else can define is a service the fence may be aimed away from. Nothing has been stopped and nothing has been migrated."

  # AND IT IS RUN, NOT LOOKED AT (o3d-2sm1.5, Codex r4 HIGH). This used to be `[[ -f ... ]]`,
  # which proves a file exists and nothing about whether it works — and its own dependency was
  # a devDependency while the documented manual upgrade runs `npm ci --omit=dev`, so the fence
  # died with a missing module at drain-verify, AFTER the stop. --preflight runs the same
  # imports, opens the same admin connection and asks the same questions as --fence, and
  # revokes, terminates and writes nothing.
  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?
  [[ "${rc}" -eq 0 ]] || die \
    "The migration window could NOT be fenced (fence preflight exit ${rc}); the reason is printed above. Refusing to migrate. Nothing has been stopped and nothing has been migrated."

  success "A connection fence is possible, and fence-db-connections.mjs proved it by asking the database."
}

release_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: ${DB_FENCE_RELEASE_CMD}"
    return 0
  fi
  # THE STATE FILE IS NOT ASKED WHETHER A FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
  # This used to begin `[[ -f "${DB_FENCE_STATE}" ]] || return 0`, which is the same defect the
  # database-backed release was added to fix, one layer up: an ABSENCE treated as an ANSWER. A
  # durable revoke outlives a lost record, so on the exact failure the record-loss work exists
  # for, this reported success without asking anything, and the start path took that for a
  # released fence, removed the reboot fence and started an application with no CONNECT on its
  # own database. So the script is ALWAYS run, and the DATABASE says what is standing. Its exit
  # codes: 0 released from a record and verified; 4 no record, and the application role's own
  # CONNECT is all that could be proven; anything else, a refusal.
  [[ -f "${DB_FENCE_SCRIPT}" ]] || { error "Cannot release the connection fence: ${DB_FENCE_SCRIPT} is missing, so nothing here can ask the database whether one is standing."; return 1; }

  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --release --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?

  if [[ "${rc}" -eq 0 ]]; then
    MIGRATION_DATABASE_URL="${DATABASE_URL}"
    DB_FENCE_UP=false
    success "Connection fence released."
    return 0
  fi

  if [[ "${rc}" -eq 4 ]]; then
    # EXIT 4: there is no record, and the database says the application role holds CONNECT.
    # That is the ONE thing it proves. The same fence revokes CONNECT from PUBLIC, monitoring,
    # backup, BI and any second application, and the application can be back inside through
    # PUBLIC or role membership while all of those are still shut out — the shape --fence
    # itself leaves standing when it rejects an ineffective fence. So it is never "released".
    DB_FENCE_UP=false
    if ${DB_FENCE_RAISED:-false}; then
      error "A CONNECTION FENCE WAS RAISED BY THIS RUN AND ITS RECORD IS GONE (exit 4)."
      error "${DB_FENCE_STATE} no longer holds a usable record, so nothing can restore the grants"
      error "this run revoked. The application role can connect; PUBLIC and every other grantee"
      error "the fence took CONNECT from may still be locked out, with no record of who they were."
      error "Audit the ACL by hand before this database is treated as open:"
      error "  SELECT datacl FROM pg_database WHERE datname = current_database();"
      return 1
    fi
    MIGRATION_DATABASE_URL="${DATABASE_URL}"
    warn "NO CONNECTION-FENCE RECORD, AND NO PROOF THAT NO FENCE IS STANDING (exit 4)."
    warn "The database says the application role can connect, and that is all it says. A fence"
    warn "revokes CONNECT from every grantee that held it — PUBLIC, monitoring, backup, BI — and"
    warn "the application can hold CONNECT through PUBLIC or role membership while those stay"
    warn "revoked. This run raised no fence of its own, so it continues; if this box has ever had"
    warn "a deploy interrupted, audit the ACL before trusting it:"
    warn "  SELECT datacl FROM pg_database WHERE datname = current_database();"
    return 0
  fi

  error "THE CONNECTION FENCE COULD NOT BE RELEASED (exit ${rc}). The application role still has"
  error "no CONNECT on this database, so the application cannot start until this is undone:"
  error "  ${DB_FENCE_RELEASE_CMD}"
  error "or, by hand as a superuser, the GRANT statements recorded in ${DB_FENCE_STATE}."
  return 1
}

# RE-ESTABLISH A FENCE THE START PHASE ALREADY RELEASED (o3d-2sm1.4, Codex r3 HIGH).
#
# The start phase releases the connection fence and removes the reboot marker BEFORE
# `systemctl start` and the health check, because the new version cannot serve a database it
# may not connect to. If either then fails, SCHEMA_TOUCHED is still true and the failure
# banner used to announce a HELD fence — while the application role had CONNECT back. An
# operator reading "the fence is up" about a fence that is down is worse than being told
# there is none. Deliberately NOT fence_db_connections: that one dies, and dying inside an
# exit trap loses the status and the banner.
refence_db_connections() {
  $DB_FENCE_UP && return 0
  $DRY_RUN && return 1
  [[ -f "${DB_FENCE_SCRIPT}" ]] || return 1
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || return 1
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

  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?
  # EVERY POST-COMMIT RESULT RAISES THE STICKY FLAG (o3d-2sm1.5, Codex r13 HIGH). Exit 5 says
  # the REVOKEs are COMMITTED and standing: this call could not call the database fenced, but it
  # certainly fenced something, and DB_FENCE_RAISED is the flag that decides whether a later
  # "no record, and only the application role's own CONNECT is provable" release may be walked
  # past. Raised here, that release becomes the refusal it should always have been.
  if [[ "${rc}" -eq 5 ]]; then
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
  [[ "${rc}" -eq 0 ]] || return 1
  DB_FENCE_UP=true
  DB_FENCE_RAISED=true
  # DO NOT SUBSTITUTE THE ADMIN URL WHEN THE COMPOSER REFUSES (o3d-2sm1.5, r6).
  # `--print-migration-url` throws precisely so that a migration can never run AS THE ADMIN
  # while the log announces the application role; catching that throw and assigning
  # DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit. Fail loudly and
  # leave it empty instead: the fence is up, and nothing this trap does next needs the URL.
  local url_rc=0
  MIGRATION_DATABASE_URL="$(run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}")" || url_rc=$?
  if [[ "${url_rc}" -ne 0 || -z "${MIGRATION_DATABASE_URL}" ]]; then
    MIGRATION_DATABASE_URL=""
    warn "--print-migration-url refused to compose a migration URL (exit ${url_rc}); NOT falling back to DEPLOY_ADMIN_DATABASE_URL. The fence is up."
  fi
  return 0
}

# Adopt — do not release — a fence a previous run left standing after it had started
# migrating. `--fence` on an existing state file re-applies the revoke and re-drains
# whatever attached in between while keeping the ORIGINAL recorded grants, so the
# eventual release still restores the truth. Every step of the recovery that needs the
# database then runs through DEPLOY_ADMIN_DATABASE_URL, so a held fence without one is
# fatal: the app role has no CONNECT and this run has no other connection.
adopt_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would re-apply and re-drain the standing connection fence and run the"
    echo -e "${YELLOW}[DRY]${RESET}   recovery through DEPLOY_ADMIN_DATABASE_URL"
    return 0
  fi
  if [[ ! -f "${DB_FENCE_STATE}" ]]; then
    # AN ABSENT FILE IS NOT PROOF THAT NO PREVIOUS FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
    # This used to declare it out loud — "No connection fence was standing" — on the strength of
    # a missing file, and adopt nothing. A durable revoke outlives its record, and this path is
    # taken only when the previous run had ALREADY REACHED THE MIGRATION, so a fence certainly
    # existed. Ask the database: with no record --release grants nothing and restores nothing,
    # it only reads, and it refuses when the application role is locked out.
    local absent_rc=0
    release_db_connections || absent_rc=$?
    [[ "${absent_rc}" -eq 0 ]] || die \
      "The previous run had already started migrating, so it had fenced the database — and the record of that fence at ${DB_FENCE_STATE} is gone while the database says the fence has NOT been undone: the application role has no CONNECT. Nothing here can reconstruct which grantees it revoked. Restore CONNECT by hand as a superuser, check pg_database.datacl for every other grantee that lost it, and re-run. Nothing has been migrated by this run."
    warn "The previous run had reached the migration, so it had raised a connection fence — and no"
    warn "record of it survives at ${DB_FENCE_STATE}. The database confirms only that the application"
    warn "role can connect, so this recovery goes on through the application role. Audit"
    warn "pg_database.datacl for any OTHER grantee that fence may still be holding out."
    return 0
  fi
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || die \
    "A connection fence is standing (${DB_FENCE_STATE}) but DEPLOY_ADMIN_DATABASE_URL is not set, so this run has no connection that survives it. Set it, or release the fence by hand: ${DB_FENCE_RELEASE_CMD}"

  warn "The previous run had already started migrating: HOLDING the connection fence."
  warn "The application stays shut out of its own database until this run has migrated,"
  warn "checked for drift and passed every declared verification."
  fence_db_connections
  # Non-empty, not "equal to the admin URL": the migration URL is the admin URL with
  # `options=-c role=<app role>` merged in, so an equality test here would fail on every
  # successful re-fence (o3d-2sm1.5).
  { ${DB_FENCE_UP} && [[ -n "${MIGRATION_DATABASE_URL}" ]]; } || die \
    "The standing connection fence could not be re-established, so this run has no privileged connection to recover through. Fix DEPLOY_ADMIN_DATABASE_URL, or release the fence by hand: ${DB_FENCE_RELEASE_CMD}"
  success "Connection fence adopted; the recovery runs through DEPLOY_ADMIN_DATABASE_URL."
}

# Put the crontab back from the backup THIS run took, whatever fence_cron managed to do with
# it. The authority is the backup file rather than CRON_FENCED: that flag is raised only once
# `crontab` has returned 0, so a run that rewrote the crontab and then failed — or failed
# halfway through rewriting it — would otherwise restore nothing. An ADOPTED backup is left
# alone: it belongs to a previous run's fence, which is still standing.
restore_cron_from_backup() {
  command -v crontab >/dev/null 2>&1 || return 0
  $CRON_BACKUP_CREATED || return 0
  [[ -f "${CRON_BACKUP}" ]] || return 1
  crontab -u "${APP_USER}" "${CRON_BACKUP}" || return 1
  rm -f "${CRON_BACKUP}"
  CRON_FENCED=false
  CRON_BACKUP_CREATED=false
  success "The ${APP_USER} crontab is back exactly as it was."
  return 0
}

# UNDO THE ARMING PHASE. Called only from the pre-stop branch of the exit trap, where the old
# version is still up and the schema has not moved: the correct outcome is that the box looks
# exactly as it did before this run started. It stops nothing and touches only state THIS run
# created — rollback_reboot_fence_install() removes the drop-in this process wrote and,
# because FENCE_ARMED is false here, the marker too, unless it was already there.
unwind_arming() {
  local unwound=true
  if ! restore_cron_from_backup; then
    unwound=false
    error "The ${APP_USER} crontab could NOT be restored from ${CRON_BACKUP}."
    error "Put it back by hand:  crontab -u ${APP_USER} ${CRON_BACKUP}"
  fi
  rollback_reboot_fence_install
  if [[ -f "${FENCE_FILE}" ]] && ! ${FENCE_MARKER_PREEXISTED}; then
    unwound=false
    error "${FENCE_FILE} is still there and would refuse the next boot. Remove it: rm -f ${FENCE_FILE}"
  fi
  if $unwound; then
    success "Every change this run had made has been undone; nothing was stopped."
  fi
}

on_exit() {
  local status=$?
  $DEPLOY_OK && exit 0

  # THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH).
  #
  # DEPLOY_OK was set only after the cron restore and the marker removal, so under `set -e` a
  # failing `crontab` reached this trap with the fence still armed — and the trap then STOPPED
  # the service that had just passed its health check, re-fenced it and RE-REVOKED CONNECT. A
  # cron-restore failure became a full outage plus a database lockout on an update that had
  # already succeeded: a rollback strictly worse than the fault. Past the health check the new
  # version is serving and everything that could reject the release has passed; what remains
  # is cleanup, and a failed cleanup is fixed by hand rather than by tearing the deploy down.
  if $PAST_POINT_OF_NO_RETURN; then
    echo ""
    echo -e "${YELLOW}${BOLD}=======================================================================${RESET}"
    echo -e "${YELLOW}${BOLD} THE UPDATE IS UP — a step AFTER the health check failed${RESET}"
    echo -e "${YELLOW}${BOLD}=======================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    echo -e "  service     : RUNNING and answering its health check. It is NOT being stopped."
    echo -e "  database    : reachable; the connection fence came down before the start."
    if $CRON_FENCED; then
      echo -e "  cron        : may still be FENCED (commented out). Restore it by hand:"
      echo -e "                  crontab -u ${APP_USER} ${CRON_BACKUP}"
    fi
    if [[ -f "${FENCE_FILE}" ]]; then
      echo -e "  marker      : ${FENCE_FILE} still exists and would refuse the next boot."
      echo -e "                Remove it once you are happy: rm -f ${FENCE_FILE}"
    fi
    exit "${status}"
  fi

  # A FAILURE BEFORE THE STOP IS NOT AN OUTAGE, AND MUST NOT BE TURNED INTO ONE
  # (o3d-2sm1.5, Codex r7 HIGH). FENCE_ARMED used to be raised before `fence_cron`, so every
  # way cron management can fail reached the branch below — which stops the service, keeps
  # the reboot fence and demands a recovery, on a host whose schema had not moved and whose
  # old version was still serving. Nothing has been asked to stop yet, so the only correct
  # action is to put back what this run changed and leave the service alone.
  if ! $FENCE_ARMED && $CUTOVER_ARMING; then
    echo ""
    echo -e "${YELLOW}${BOLD}=======================================================================${RESET}"
    echo -e "${YELLOW}${BOLD} UPDATE FAILED BEFORE THE STOP — THE OLD VERSION IS STILL SERVING${RESET}"
    echo -e "${YELLOW}${BOLD}=======================================================================${RESET}"
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
    exit "${status}"
  fi

  if $FENCE_ARMED; then
    echo ""
    echo -e "${RED}${BOLD}=======================================================================${RESET}"
    echo -e "${RED}${BOLD} UPDATE FAILED AFTER THE STOP — THE OLD VERSION IS NOT BEING RESTARTED${RESET}"
    echo -e "${RED}${BOLD}=======================================================================${RESET}"
    echo -e "  failed step : ${CURRENT_STEP}"
    echo -e "  exit status : ${status}"
    if $SCHEMA_TOUCHED; then
      echo -e "  schema      : a migration was RUNNING; the database may be MIGRATED or"
      echo -e "                half-migrated while nothing is serving. That is the intended"
      echo -e "                safe state; what the connection fence is doing about it is"
      echo -e "                stated below, once this run has finished making it true."
      if [[ -n "${BACKUP_FILE}" ]]; then
        echo -e "  restore     : ${BACKUP_FILE}"
      else
        echo -e "  restore     : NO usable pre-migration dump exists for this run. Either it"
        echo -e "                was not reached or the dump did not finish, and a partial dump"
        echo -e "                is not a restore point. Use the most recent completed backup"
        echo -e "                in ${BACKUP_DIR} and expect to lose the writes made since it."
      fi
    fi
    echo -e "  service     : STOPPED, and left that way on purpose."
    if $REBOOT_FENCE_INSTALLED; then
      echo -e "  reboot      : ${SERVICE_UNIT} is fenced by ${FENCE_DROPIN_FILE};"
      echo -e "                it will not start on boot while ${FENCE_FILE} exists."
    else
      # Printed unconditionally once, describing a drop-in that may never have been
      # installed (o3d-2sm1.5, Codex r4 HIGH). The re-install below corrects this line.
      echo -e "  reboot      : NO verified reboot fence is in place; this host may start"
      echo -e "                ${SERVICE_UNIT} on its next boot. This run re-attempts the"
      echo -e "                install below and says whether it worked."
    fi
    echo -e "  cron        : ${APP_USER} entries left FENCED (commented out)."
    echo ""
    echo -e "  Do NOT start ${SERVICE_UNIT} by hand. Fix the cause and re-run this"
    echo -e "  script; it adopts this fence and every step is idempotent."
    echo -e "  State: ${FENCE_FILE}"
    echo ""

    if ! $DRY_RUN; then
      # Belt and braces: re-stop first, in case a Restart= policy, an operator or a
      # race brought it back between the failure and here.
      systemctl stop "${SERVICE_UNIT}" >/dev/null 2>&1 || true
      # AND THE BINDING COMES OFF, ALWAYS (o3d-2sm1.5 r23). The environment snapshot pins
      # DATABASE_URL over ${APP_DIR}/.env for as long as its drop-in is loaded, and it is only
      # ever right for the run that published it. Left standing after a failure it would silently
      # override a later, legitimate edit of the file — and the operator's first move after
      # reading this banner is usually to edit that file.
      remove_db_identity_snapshot
      if ! install_reboot_fence "update failed at ${CURRENT_STEP}"; then
        echo -e "${RED}${BOLD} THE REBOOT FENCE IS NOT IN PLACE. This host may start the old version${RESET}" >&2
        echo -e "${RED}${BOLD} against a migrated schema on its next boot. Stop it by hand.${RESET}" >&2
      fi
      # HELD IF THE SCHEMA WAS TOUCHED, AND ONLY THEN. Before the migration was invoked
      # nothing has moved and an unreleased revoke is just an application that cannot
      # reach its database; at or after it, releasing CONNECT would let the application
      # reconnect to a schema in an unknown state — the exact window this order closes.
      #
      # "HELD" IS A CLAIM, SO IT IS MADE TRUE BEFORE IT IS PRINTED (Codex r3 HIGH). The
      # start phase releases the fence before `systemctl start` and the health check, so a
      # failure in either arrives here with SCHEMA_TOUCHED true and the fence already DOWN.
      # Re-establish it — the service has just been re-stopped above — and then say which
      # of the two actually happened.
      if $SCHEMA_TOUCHED; then
        if ! $DB_FENCE_UP; then
          warn "The connection fence had already been released for the start; re-establishing it."
          refence_db_connections || true
        fi
        if $DB_FENCE_UP; then
          error "THE CONNECTION FENCE IS DELIBERATELY LEFT UP. A migration was already running"
          error "when this failed, so the schema may be half-applied and the application role"
          error "must not get CONNECT back until a re-run has migrated, checked drift and passed"
          error "every declared verification. A re-run adopts this fence and recovers through"
          error "DEPLOY_ADMIN_DATABASE_URL. To release it by hand instead, once you know the"
          error "schema is sound:  ${DB_FENCE_RELEASE_CMD}"
        else
          error "THE CONNECTION FENCE IS NOT IN PLACE, AND THE SCHEMA MAY HAVE MOVED. This run"
          error "released it in order to start the new version and could not put it back, so the"
          error "application role CAN connect to a database whose schema is in an unknown state."
          error "The only thing keeping it off is that ${SERVICE_UNIT} is stopped and fenced"
          error "against a reboot. Do NOT start it. Close the database by hand, or re-run this"
          error "script, which re-establishes the fence before it rebuilds:"
          error "  node ${DB_FENCE_SCRIPT} --fence --state-file=${DB_FENCE_STATE} ${DB_FENCE_IDENTITY_ARGS[*]:-}"
        fi
      else
        release_db_connections || true
      fi
      # LAST, so the marker records the fence state that is true when this process exits
      # rather than the one that was true before the re-fence was attempted.
      write_fence_marker "update failed at ${CURRENT_STEP}" "${status}" || true
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
# PUBLISH THE CRONTAB BACKUP ATOMICALLY, OR NOT AT ALL (o3d-2sm1.5, Codex r8 HIGH).
#
# It used to be `printf > "${CRON_BACKUP}"` followed by `chmod`, and only then the flag
# saying THIS run had created it. A full disk, a short write or a failing chmod therefore
# left a truncated — or wrongly permissioned — file at the authoritative path with
# CRON_BACKUP_CREATED still false, so the arming unwind regarded it as somebody else's and
# left it behind. The next run found a backup at the expected path, adopted it as the
# previous run's verbatim original, and a successful unfence REPLACED the real crontab with
# those truncated contents — or with contents predating whatever the operator edited after
# the failed attempt.
#
# So: a temporary file in the SAME directory (same filesystem, so the rename is atomic), the
# complete content and the mode both verified, an atomic rename, and the created-flag raised
# immediately. Every failure path removes the temporary file, or the file it had just
# published, and returns non-zero: a failed publish leaves nothing at ${CRON_BACKUP}.
publish_cron_backup() {
  local content="$1" tmp
  mkdir -p "$(dirname "${CRON_BACKUP}")" || return 1
  tmp="$(mktemp "${CRON_BACKUP}.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$content" > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod 600 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # The whole content, read back off the filesystem. `$(cat ...)` and the value written both
  # lose their trailing newlines, so this compares every byte that matters.
  if [[ "$(cat "$tmp" 2>/dev/null)" != "$content" ]]; then rm -f "$tmp"; return 1; fi
  if [[ "$(stat -c '%a' "$tmp" 2>/dev/null)" != "600" ]]; then rm -f "$tmp"; return 1; fi
  # DURABLE, NOT MERELY VISIBLE (o3d-2sm1.5, Codex r9 HIGH). The read-back above proves the
  # bytes can be SEEN, and the page cache will happily satisfy it from memory. A power loss
  # after the crontab has been fenced would then reboot with this backup missing or
  # zero-length while publication had returned success — and the resume either restores an
  # empty crontab or leaves cron commented out for ever. Both barriers land BEFORE the
  # crontab is touched, because the caller invokes `crontab` only once this returns 0.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "${CRON_BACKUP}" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # temporary name, or no name at all, however well the data was flushed.
  if ! fsync_path "$(dirname "${CRON_BACKUP}")"; then rm -f "${CRON_BACKUP}"; return 1; fi
  # IMMEDIATELY: from here the file is authoritative and must be owned by this run in the
  # same breath, or the unwind disowns a backup it is the only one able to restore.
  CRON_BACKUP_CREATED=true
  if [[ "$(cat "${CRON_BACKUP}" 2>/dev/null)" != "$content" ]]; then
    rm -f "${CRON_BACKUP}"
    CRON_BACKUP_CREATED=false
    return 1
  fi
  return 0
}

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
    # THIS run's backup, so the arming unwind may restore from it and delete it — and it is
    # only ever at that path once it is complete, verified and owned.
    publish_cron_backup "$current" || die \
      "The ${APP_USER} crontab could not be backed up to ${CRON_BACKUP}, so this run will not fence the cron writers: a fence whose backup cannot be verified is a crontab nobody can put back. Nothing was left behind at ${CRON_BACKUP}. Nothing has been stopped and nothing has been migrated."
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

# --- adopting somebody else's marker ---------------------------------------
# What phase the run that wrote this marker had actually reached. A marker with no `phase=`
# line was written by an older version of this script, which only ever left one behind after
# a stop; anything unrecognised therefore reads as `stopping`, which is the direction that
# stops a service rather than leaving one running over a schema that may have moved.
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

marker_phase() {
  local phase
  phase="$(sed -n 's/^phase=//p' "${FENCE_FILE}" 2>/dev/null | tail -1)"
  case "${phase}" in
    arming) printf 'arming' ;;
    *) printf 'stopping' ;;
  esac
}

RESUME_EVIDENCE=""
# IS THE OLD VERSION STILL UP? Asked only to decide whether an interrupted ARMING can be
# resumed, and answered conservatively: a unit systemd reports active, or anything listening
# on the app's port, counts as "still serving". A `false` sends the run down the ordinary
# adoption path, which stops and re-fences — the pre-existing behaviour. APP_PORT is read out
# of .env much further down, so it is only consulted when it happens to be known.
predecessor_is_active() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${SERVICE_UNIT}" 2>/dev/null; then
    RESUME_EVIDENCE="systemd reports ${SERVICE_UNIT} active"
    return 0
  fi
  if [[ -n "${APP_PORT:-}" ]] && command -v ss >/dev/null 2>&1 \
    && ss -ltn 2>/dev/null | awk -v p=":${APP_PORT}\$" '$4 ~ p {found=1} END{exit !found}'; then
    RESUME_EVIDENCE="something is still listening on :${APP_PORT}"
    return 0
  fi
  return 1
}

# RESUME AN INTERRUPTED ARMING WITHOUT STOPPING ANYTHING (o3d-2sm1.5, Codex r8 HIGH).
#
# The old version is up, the schema is untouched and every piece of state on this box is one
# the arming phase created and the arming phase can remove. So do what unwind_arming would
# have done had the previous run reached its own trap — crontab back, reversible reboot fence
# down, any connection fence released — and carry on from here, before the build, with
# nothing stopped.
#
# Order matters: the crontab is restored FIRST and a failure there is fatal BEFORE the fence
# comes down, so a run that cannot finish the unwind leaves the marker exactly as it found it
# and the next run adopts the same phase again.
resume_from_interrupted_arming() {
  if command -v crontab >/dev/null 2>&1 && [[ -f "${CRON_BACKUP}" ]]; then
    crontab -u "${APP_USER}" "${CRON_BACKUP}" || die \
      "The interrupted run had fenced the ${APP_USER} crontab and its backup at ${CRON_BACKUP} could not be restored. Refusing to continue with the cron writers commented out: restore it by hand (crontab -u ${APP_USER} ${CRON_BACKUP}) and re-run. Nothing has been stopped."
    rm -f "${CRON_BACKUP}"
    CRON_FENCED=false
    success "The ${APP_USER} crontab is back exactly as the interrupted run found it."
  fi
  release_db_connections || die \
    "A connection fence was standing over an UNTOUCHED schema and could not be released. Fix that before re-running; nothing has been stopped."
  remove_reboot_fence
  if [[ -f "${FENCE_FILE}" ]]; then
    die "${FENCE_FILE} could not be removed, so this host would still refuse to start ${SERVICE_UNIT} on its next boot. Remove it by hand (rm -f ${FENCE_FILE}) and re-run. Nothing has been stopped."
  fi
  REBOOT_FENCE_INSTALLED=false
  success "The interrupted arming has been undone. The old version was never stopped and is still serving."
}

# ---------------------------------------------------------------------------
# @deploy-phase: preflight
# ---------------------------------------------------------------------------
CURRENT_STEP="preflight"
header "Preflight"

if ! $DRY_RUN; then
  acquire_cutover_lock
fi

# Adoption is the FIRST thing after the lock, before the pull and long before the
# build. A previous run that failed after the stop left this host in a state where a
# reboot, a Restart= policy or an operator can have the predecessor serving a
# half-migrated schema again; spending minutes building while that is true is exactly
# the window the deploy order exists to close. Re-stop, re-fence, verify, then carry on.
adopt_cron_fence() {
  command -v crontab >/dev/null 2>&1 || return 0
  if [[ ! -f "${CRON_BACKUP}" ]]; then
    info "No crontab backup from the previous run; its cron entries were never fenced."
    return 0
  fi
  # The backup is the ORIGINAL crontab and must survive until this run finishes.
  CRON_FENCED=true
  local current active
  current="$(crontab -u "${APP_USER}" -l 2>/dev/null || true)"
  active="$(printf '%s\n' "${current}" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "${active}" -gt 0 ]]; then
    warn "${active} cron line(s) are active again; re-fencing them."
    fence_cron
  else
    success "Cron is still fenced; ${CRON_BACKUP} holds the original."
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

if [[ -f "${FENCE_FILE}" ]]; then
  # WHAT PHASE DID THE RUN THAT LEFT THIS ACTUALLY REACH? (o3d-2sm1.5, Codex r8 HIGH)
  #
  # Adoption used to take the marker's mere EXISTENCE as proof that the old version had been
  # stopped: it raised FENCE_ARMED and immediately stopped the unit. But the marker is
  # written during ARMING, before the first stop — so a SIGKILL, an OOM kill or a power cut
  # between install_reboot_fence() and that stop left a healthy old version running against
  # an untouched schema, and THIS run then stopped it, for the whole length of a build, to
  # recover from a failure that had cost nothing.
  #
  # Three things must hold before that is treated as a resumable arming, and all three are
  # cheap: the marker says the phase was `arming`, it says the schema was never touched, and
  # the old version is still active right now. Any of them false and the run falls through to
  # the ordinary adoption below, which stops and re-fences exactly as before.
  ADOPTED_PHASE="$(marker_phase)"
  ADOPTED_SCHEMA_TOUCHED=false
  ADOPTED_MIGRATION_ATTEMPTED=false
  if grep -qE '^schema_touched=true$' "${FENCE_FILE}" 2>/dev/null; then
    ADOPTED_SCHEMA_TOUCHED=true
  fi
  if grep -qE '^migration_attempted=true$' "${FENCE_FILE}" 2>/dev/null; then
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

  if [[ "${ADOPTED_PHASE}" == "arming" ]] && ! $ADOPTED_SCHEMA_TOUCHED && predecessor_is_active; then
    warn "Adopting an INTERRUPTED ARMING — a previous run was killed before it stopped anything:"
    sed 's/^/         /' "${FENCE_FILE}"
    warn "The marker says phase=arming and schema_touched=false, and ${RESUME_EVIDENCE}."
    warn "Nothing was stopped, so nothing is recovered by stopping it now. This run undoes the"
    warn "reversible state that run had created and RESUMES from here, before the build, with"
    warn "the old version still serving the schema it was built against."
    if $DRY_RUN; then
      echo -e "${YELLOW}[DRY]${RESET}   would restore the ${APP_USER} crontab from ${CRON_BACKUP}, remove the"
      echo -e "${YELLOW}[DRY]${RESET}   reboot-fence drop-in and marker, and continue WITHOUT stopping anything"
    else
      resume_from_interrupted_arming
    fi
  else
    warn "Adopting an existing fence — a previous run stopped here:"
    sed 's/^/         /' "${FENCE_FILE}"

    FENCE_ARMED=true
    # Read ONCE, above, and read conservatively there: a second independent grep is how the
    # missing-line-means-false defect got in. (`if`, not `&&`: under errexit a bare
    # `$flag && VAR=true` exits the script the moment the flag is false.)
    if $ADOPTED_MIGRATION_ATTEMPTED; then
      FENCE_MASK=true
    fi
    # Carried forward so a failure of THIS run does not release a fence its predecessor
    # was right to leave standing.
    if $ADOPTED_SCHEMA_TOUCHED; then
      SCHEMA_TOUCHED=true
    fi

    if $DRY_RUN; then
      echo -e "${YELLOW}[DRY]${RESET}   would re-stop ${SERVICE_UNIT}, re-establish and verify the reboot fence,"
      echo -e "${YELLOW}[DRY]${RESET}   confirm the cron fence, and adopt or release the standing connection fence"
    else
      info "Re-stopping ${SERVICE_UNIT} before anything else — it may have been started since."
      systemctl stop "${SERVICE_UNIT}" >/dev/null 2>&1 || true
      install_reboot_fence "adopted at $(date -Iseconds)" \
        || die "Could not re-establish the reboot fence. Refusing to continue: a reboot could start the old version against a migrated schema."
      adopt_cron_fence
      if $SCHEMA_TOUCHED; then
        # HELD, not released: the previous run had started migrating, so the schema is in
        # an unknown state and the application must not reach it — not during this rebuild
        # and not if this run fails too. Everything below that needs the database goes
        # through DEPLOY_ADMIN_DATABASE_URL, the build included.
        adopt_db_connections
      else
        # Nothing had moved, so release: the window is re-fenced at drain-verify anyway,
        # and releasing here proves the release path works before the migration needs it.
        release_db_connections \
          || die "A connection fence from the previous run could not be released; fix that before re-running."
      fi
    fi
    warn "Fence adopted. Continuing; every step is idempotent."
  fi
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
    # `--` before the URL: GIT_REPO_URL comes out of the application-owned .deploy-meta, and a
    # value beginning with `-` would otherwise be parsed by git as an OPTION rather than a
    # repository (`--upload-pack=…` runs a command). The clone already runs AS THE APPLICATION
    # USER, so that was never a privilege crossing — this keeps it from being a surprise either.
    run_git_as_user "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
      -- "${GIT_REPO_URL}" "${TMP_CLONE_WORKTREE}"
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
run run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  npx prisma generate --schema "${APP_DIR}/prisma/schema.prisma"
success "Prisma client generated."

if ! $SKIP_BUILD; then
  header "Building the application"
  # DATABASE_URL is passed explicitly (Next.js does not override an inherited value with
  # the one in .env) so that a rebuild during a recovery which is HOLDING the connection
  # fence goes through the admin connection. On a normal run MIGRATION_DATABASE_URL IS
  # DATABASE_URL and this changes nothing; under a held fence, without it, anything the
  # build touches in the database fails with "permission denied for database" — the fence
  # working as intended, presenting as a build error.
  run run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
    npm run build --prefix "${APP_DIR}"
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

# Said HERE, while nothing has been stopped, because the post-migration hook can only
# report a coverage gap once the schema has already moved.
VERIFY_COUNT=$(find "${APP_DIR}/prisma/migrations" -mindepth 2 -maxdepth 2 -name 'verify.sql' -type f 2>/dev/null | wc -l)
REQUIRED_COUNT=$(grep -cE '^[[:space:]]*[^#[:space:]]' "${APP_DIR}/prisma/migrations/verification-required.txt" 2>/dev/null || true)
info "Migrations declaring a post-migration verification: ${VERIFY_COUNT}"
info "Migrations required to declare one: ${REQUIRED_COUNT:-0}"
if [[ "${VERIFY_COUNT}" -eq 0 ]]; then
  warn "No migration in this tree declares a verification check: the post-migration hook"
  warn "will execute nothing. A pass from it will mean nothing was checked."
fi

# AN EFFECTIVE FENCE IS MANDATORY FOR A MIGRATION, and the cheapest half of that answer is
# knowable here — before the stop, while a refusal costs nothing rather than an outage.
#
# A SNAPSHOT AN EARLIER RUN LEFT BEHIND IS CLEARED HERE, BEFORE ANYTHING ASKS THE BUS
# (o3d-2sm1.5 r23). Every exit path removes the binding, but a SIGKILL has no exit path, and a
# drop-in surviving from a run that died would be a second definition of DATABASE_URL that
# env_file_is_sole_database_url_source() refuses on sight — correctly, since this run did not
# write it and has no idea what is in it. Clearing it is safe at this point: nothing has been
# stopped, and removing a drop-in changes no running process's environment.
$DRY_RUN || remove_db_identity_snapshot
require_fenceable_database
success "Artefact validated."

# ---------------------------------------------------------------------------
# @deploy-phase: fence-writers
# ---------------------------------------------------------------------------
CURRENT_STEP="fence-writers"
header "Stopping and draining every writer"

# BEFORE the stop, and before the migration: a fence that is only installed on the way
# out does not exist for a run that is killed rather than exiting. Installing it here
# also means a failure to install it costs nothing — the old version is still up, the
# schema has not moved, and FENCE_ARMED is still false, so the failure banner does not
# claim an outage that has not happened.
FENCE_MASK=true

# PHASE `arming`. Everything between here and the stop is reversible, and the exit trap
# reverses it: it restores the crontab and removes the drop-in and marker this run wrote,
# WITHOUT stopping anything.
CUTOVER_ARMING=true

install_reboot_fence "cutover started $(date -Iseconds)" \
  || die "Refusing to stop the old version without a verified reboot fence: a reboot mid-migration would start it again against a migrated schema."

fence_cron

# PHASE `stopping`. THIS is where the fence is armed, and not one line earlier: from the next
# statement on, something has been asked to stop and nothing may start it again. Every failure
# before this point takes the reversible branch in the trap (o3d-2sm1.5, Codex r7 HIGH).
FENCE_ARMED=true
# ...and the transition is on disk before `systemctl stop` runs, not after it.
if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would record phase=stopping in ${FENCE_FILE} and flush it BEFORE anything is stopped"
else
  persist_stop_requested
fi

info "Stopping ${SERVICE_UNIT}"
run systemctl stop "${SERVICE_UNIT}"
success "Service stopped."

# ---------------------------------------------------------------------------
# @deploy-phase: drain-verify
#
# "Drained" means STOPPED, not idle, and the database is the only authority on that.
# An enumeration of writers is a guess about the box; pg_stat_activity is the answer.
#
# Two steps, in this order. The FENCE shuts the door — new application connections are
# refused for the rest of the window — and only then does the PROBE assert the room is
# empty. Probing alone is a snapshot: check-db-writers closes its connection, and the
# dump and the migration open theirs afterwards, with nothing holding the gap.
# ---------------------------------------------------------------------------
CURRENT_STEP="drain-verify"
header "Proving the writers are gone"

fence_db_connections

if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would run: node scripts/check-db-writers.mjs"
else
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${MIGRATION_DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
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

# BACKUP_FILE is the name the failure banner offers as the restore point, so it is set
# ONLY once pg_dump has actually finished. The dump runs to a `.part` file first: a
# truncated dump is not a restore point, and naming one as though it were is worse than
# admitting there is none.
BACKUP_TARGET="${BACKUP_DIR}/pre-update-$(date +%Y%m%d-%H%M%S).sql.gz"
if $DRY_RUN; then
  echo -e "${YELLOW}[DRY]${RESET}   would pg_dump to ${BACKUP_TARGET}"
else
  mkdir -p "${BACKUP_DIR}"
  info "Backing up database to ${BACKUP_TARGET}..."
  BACKUP_PARTIAL="${BACKUP_TARGET}.part"
  if ! pg_dump "${MIGRATION_DATABASE_URL}" | gzip > "${BACKUP_PARTIAL}"; then
    rm -f "${BACKUP_PARTIAL}"
    die "pg_dump did not complete; the partial file has been deleted. Nothing has been migrated and there is no restore point for this run."
  fi
  mv "${BACKUP_PARTIAL}" "${BACKUP_TARGET}"
  BACKUP_FILE="${BACKUP_TARGET}"
  success "Backup saved: ${BACKUP_FILE}"
  ls -t "${BACKUP_DIR}"/pre-update-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --
fi

header "Running database migrations"
# FROM HERE THE SCHEMA MAY HAVE MOVED, so the connection fence is no longer released on
# failure. Recorded ON DISK and flushed BEFORE the command, not after it and not from the
# exit trap: an interrupted, half-applied or SIGKILLed migration is exactly what the flag is
# for, and a flag that only ever reached shell memory is false for every one of them.
mark_schema_touched
run run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Migrations applied."

header "Validating database schema"
run run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  node "${APP_DIR}/scripts/check-prisma-drift.mjs"
success "Database schema matches prisma/schema.prisma."

# AND THAT THE APPLICATION CAN ACTUALLY USE WHAT JUST LANDED (o3d-2sm1.5, Codex r4 CRITICAL).
# Everything above — prisma, the drift check, pg_dump — runs on the ADMIN connection, which
# owns whatever the migration created and reads all of it; the health check touches no
# database. So an ownership mistake in the fenced window was invisible to the whole pipeline:
# success reported, and every request touching the new table failing with "permission denied".
# This asks the database about the APPLICATION role, the one question none of the others ask.
header "Checking the application role can use what the migration created"
run run_as_user "${APP_USER}" env \
  DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
  node "${DB_OBJECT_ACCESS_SCRIPT}" --state-file="${DB_FENCE_STATE}" \
  || die "The migration left objects the application role cannot use — see above. The new version has NOT been started."
success "The application role can use everything in the database."

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
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${MIGRATION_DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${APP_DIR}/scripts/run-migration-verifications.mjs" \
    || die "A migration's verification check did not return zero. The new version has NOT been started."
  success "Every declared verification check returned zero (see the coverage report above for what was NOT declared)."
fi

# ---------------------------------------------------------------------------
# @deploy-phase: start
#
# The fences come down in the order that keeps the new version startable: the database
# first (it cannot serve a database it may not connect to), then the reboot fence.
# ---------------------------------------------------------------------------
CURRENT_STEP="start"
header "Starting the new version"

# THE ONLY PLACE A RELEASE FOLLOWS A MIGRATION. Reaching this line means the migration
# applied, the deployed schema matched prisma/schema.prisma and every declared
# verification returned zero: the schema is known good and the new version is about to
# start. Every other path either never touched the schema or leaves the fence standing.

# BEFORE THE RELEASE, WITH THE FENCE STILL HELD (o3d-2sm1.5 r22, Codex HIGH). The migration
# window is closing and the whole point of the fence is that the database it is holding shut is
# the database that is about to be served. If ${APP_DIR}/.env has been replaced, deleted or
# retargeted since the pin — or the unit has acquired another definition of DATABASE_URL — then
# releasing here opens database A and starts the application on database B.
#
# SO IT REFUSES, AND THE FENCE STAYS UP. This die reaches the exit trap with FENCE_ARMED and
# SCHEMA_TOUCHED both true, which is the path that HOLDS the connection fence, re-stops the
# service, re-installs the reboot fence and prints the release command; the state is stated there
# rather than claimed here. That is deliberately the expensive answer: a migrated database left
# closed is recoverable by a re-run, and an application started on the wrong one is not.
require_start_identity_unchanged || die \
  "THE CONNECTION FENCE IS BEING HELD AND THE APPLICATION IS NOT BEING STARTED: ${DB_IDENTITY_DRIFT_REASON}. The migration applied and every verification passed, but the identity this run fenced and migrated is no longer the one ${APP_DIR}/.env will give the service when systemd execs it — so releasing the fence and starting now would open the database this run migrated and start the application on a different one. Restore ${APP_DIR}/.env to the identity above and re-run this script, which adopts the standing fence; or, once you are certain which database the service should use, release it by hand with the command printed below. Do NOT start the service until one of those is done."

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
  "THE CONNECTION FENCE IS BEING HELD AND THE APPLICATION IS NOT BEING STARTED: this run could not bind the service to the database it fenced and migrated (the reason is printed above). Without that binding the DATABASE_URL systemd reads at exec is whatever ${APP_DIR}/.env says at that instant, which is not something this script can hold still. Fix the cause and re-run; the re-run adopts the standing fence."

# THE UNMASK HAPPENS HERE, AHEAD OF THE FINAL RELOAD, AND NOT BETWEEN THE PROOF AND THE START
# (o3d-2sm1.5 r24, Codex HIGH). `systemctl unmask` RELOADS SYSTEMD IMPLICITLY unless it is given
# --no-reload, so the unmask that used to sit on the line above `systemctl start` re-read every
# unit file and every drop-in on disk AFTER require_start_identity_bound had proved the loaded
# configuration binds this service to this run's snapshot. r22's atomicity argument was sound
# about EXPLICIT reloads and blind to that one.
#
# Moving it upstream of remove_reboot_fence()'s daemon-reload makes "nothing after the
# verification changes the loaded configuration" true BY CONSTRUCTION rather than by every future
# caller remembering --no-reload: after the proof the only systemctl verb left is `start`, which
# acts on the loaded configuration and does not re-read unit files.
#
# It lifts a mask left by an older revision of this script, which used `systemctl mask` from its
# exit trap; harmless when there is none, and safe this early because a mask is not what holds
# the service down during the window — the stop and the reboot fence are — and unmasking starts
# nothing.
run systemctl unmask "${SERVICE_UNIT}" >/dev/null 2>&1 || true

release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence

# AND ONCE MORE AFTER THIS RUN'S FINAL daemon-reload, WHICH remove_reboot_fence() JUST ISSUED,
# AND WITH EVERY UNIT-FILE COMMAND ALREADY BEHIND IT (o3d-2sm1.5 r24, Codex HIGH)
# (o3d-2sm1.5 r22, Codex HIGH). That reload is what folds every drop-in written during the window
# into the unit's loaded configuration, so this is the first moment the LOADED unit can be asked,
# and the last moment before `systemctl start` hands the file to systemd to read.
#
# A refusal here also leaves both fences standing, by the same route and without doing it by
# hand: the die reaches the exit trap with SCHEMA_TOUCHED true and DB_FENCE_UP false, which is
# exactly the branch that re-establishes the connection fence through refence_db_connections()
# and re-installs the reboot fence, and then says which of the two it actually managed.
require_start_identity_bound || die \
  "THE APPLICATION IS NOT BEING STARTED, AND BOTH FENCES ARE BEING PUT BACK: ${DB_IDENTITY_DRIFT_REASON}. This was checked after the final daemon-reload, so it is the loaded unit configuration and the current file contents that disagree with the identity this run fenced and migrated. It is also the check that proves the environment snapshot this run published is in that loaded configuration, loaded last and loaded mandatorily — the binding that makes the answer independent of anything that happens between this line and the exec. NOTHING BETWEEN HERE AND THE START RUNS A UNIT-FILE COMMAND AT ALL: the unmask moved above the final reload in r24 because it reloads implicitly, and every command left in the window is a timestamp, a shell test, a loop, an echo and `systemctl start` itself, which acts on the loaded configuration and does not re-read unit files. So the list of environment files systemd will read is now fixed. The connection fence was released a moment ago for the start and is being re-established below; the banner that follows says whether that succeeded and what is standing. Restore ${APP_DIR}/.env and the unit to the identity above and re-run this script, which adopts the fence. Do NOT start the service by hand first."

run systemctl start "${SERVICE_UNIT}"
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
    journalctl -u "${SERVICE_UNIT}" -n 60 --no-pager >&2 || true
    die "The new version did not answer /api/health within 60s. Leaving it stopped rather than restoring the old one."
  fi
  success "Health check passed — app is responding."

  # ---------------------------------------------------------------------------
  # AND WHICH BUILD IS IT? (o3d-2sm1.5, Codex r5 HIGH)
  #
  # /api/health is process liveness. A PREDECESSOR still holding port ${APP_PORT} answers it
  # exactly as well as the new version does — and the point of no return below was armed by
  # that answer alone, after which the trap explicitly REFUSES to stop the service. The old
  # build would have been left serving a migrated schema, with the update reporting success.
  #
  # /_next/static/<BUILD_ID>/ is served only by the process whose OWN build id is that one,
  # so a 200 there is the new code identifying itself. Nothing else here can distinguish the
  # two processes, and "nothing proved it" must not read as "proven".
  # ---------------------------------------------------------------------------
  if [[ -f "${APP_DIR}/.next/BUILD_ID" ]]; then
    NEW_BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID")"
  else
    die "No .next/BUILD_ID after the build, so nothing can prove which version answered /api/health."
  fi
  BUILD_ASSET="$(ls "${APP_DIR}/.next/static/${NEW_BUILD_ID}" 2>/dev/null | head -1 || true)"
  if [[ -n "${BUILD_ASSET}" ]] \
    && curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/_next/static/${NEW_BUILD_ID}/${BUILD_ASSET}" >/dev/null 2>&1; then
    NEW_BUILD_SERVING=true
    success "The process on port ${APP_PORT} serves /_next/static/${NEW_BUILD_ID}/ — it is this build."
  else
    die "Something answered /api/health on port ${APP_PORT}, but nothing proved it was BUILD_ID ${NEW_BUILD_ID}. A predecessor still holding the port answers that route too, and the schema has already moved. Refusing to declare the update irreversible on the strength of an open port."
  fi
fi

# PAST THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). The new version is serving; what
# is left is cleanup, and a cleanup failure must not stop, re-fence and lock out a deployment
# that has already succeeded.
#
# ARMED ONLY BY THE PROOF ABOVE: `$NEW_BUILD_SERVING` is false until the build on disk was
# shown to be the process on the port. The trap's refusal to stop the service is defensible
# only once that is established (o3d-2sm1.5, Codex r5 HIGH).
if $NEW_BUILD_SERVING || $DRY_RUN; then
  PAST_POINT_OF_NO_RETURN=true
fi
# The ARMING phase is over on every path that reaches here: the reboot fence came down in the
# start phase and there is nothing reversible left to reverse. Leaving CUTOVER_ARMING raised
# would send a failure in the cleanup below into the PRE-STOP branch of the trap, which would
# report an old version that was never stopped and unwind a fence that is already gone.
CUTOVER_ARMING=false

# THE STOP FLAG COMES DOWN ONLY FOR A RUN THAT NO LONGER NEEDS IT (o3d-2sm1.5, Codex r8).
#
# Past the point of no return the trap is governed by PAST_POINT_OF_NO_RETURN and FENCE_ARMED
# is irrelevant. Any path that reaches here WITHOUT that proof is one where a later failure
# is still supposed to be torn down — and clearing FENCE_ARMED here would leave such a
# failure matching none of the trap's four phase branches, so the trap would do nothing at
# all and an unidentified process would be left serving the migrated schema. deploy.sh has
# such a path today (its dev-responder escape hatch); this script must not grow one silently.
if $PAST_POINT_OF_NO_RETURN; then
  FENCE_ARMED=false
fi

# THE BINDING COMES OFF HERE, on the success path (o3d-2sm1.5 r23). The service is running and
# has answered its health check, so it already HAS the environment; the drop-in has nothing left
# to do and everything to break, because from now on it would override ${APP_DIR}/.env for every
# restart, reboot and Restart= until somebody noticed a file in /etc/systemd/system that no
# document mentions. Removing it does not touch the running process.
remove_db_identity_snapshot

CURRENT_STEP="unfence-cron"
# Cron goes back last, and only once the new version has answered: restoring the
# queue workers before that would hand them to a server that may still fail.
unfence_cron
# Already removed with the reboot fence in the start phase; kept so a re-run that took
# a different path cannot leave a marker that would refuse the next boot.
run rm -f "${FENCE_FILE}"

# The cleanup this flag covered is complete, so it stands down — and only now.
FENCE_ARMED=false

DEPLOY_OK=true

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

if $DRY_RUN; then
  header "Dry run complete (${ELAPSED}s) — nothing was changed"
else
  header "Update complete (${ELAPSED}s)"
fi
echo -e "  ${BOLD}systemctl status ${SERVICE_UNIT}${RESET}  — check service health"
echo -e "  ${BOLD}journalctl -u ${SERVICE_UNIT} -f${RESET}  — view live logs"
echo ""
echo -e "${GREEN}Done.${RESET}"
