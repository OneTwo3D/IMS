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

# Load env for DATABASE_URL
set -a; source "${APP_DIR}/.env"; set +a
if [[ -f "${DEPLOY_META_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090  # path is composed at runtime from APP_DIR
  source "${DEPLOY_META_FILE}"
  set +a
fi

# May be absent from .env, and `set -u` is on. Empty means "no privileged connection",
# which the connection fence reports as NOT FENCED rather than silently skipping.
DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL:-}"

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
DB_FENCE_RELEASE_CMD="node ${DB_FENCE_SCRIPT} --release --state-file=${DB_FENCE_STATE}"
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
    # and the banner. It is fatal in mark_schema_touched() and persist_stop_requested(),
    # which check the file afterwards — the two callers whose whole purpose is the durable
    # record. What matters is that the LAST DURABLE MARKER IS STILL THERE: a failed publish
    # changed nothing.
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
  # `|| true` so the assertion below is what speaks. A failed publish leaves the LAST
  # DURABLE marker in place, and if that one already says schema_touched=true the record
  # this function exists to create is already on disk; if it does not, the grep fails and
  # nothing is migrated.
  write_fence_marker "migration about to be invoked at $(date -Iseconds)" || true
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
  # `|| true` so the assertion below is what speaks; a failed publish leaves the last
  # durable marker untouched, and the grep then reports on THAT file.
  write_fence_marker "stop requested at $(date -Iseconds)" || true
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

  mkdir -p "${FENCE_DROPIN_DIR}"
  [[ -f "${FENCE_DROPIN_FILE}" ]] || FENCE_DROPIN_CREATED=true
  cat > "${FENCE_DROPIN_FILE}" <<EOF
[Unit]
# Installed by scripts/update.sh (o3d-2sm1.2) for the length of a cutover.
# While the marker below exists this unit must not start — not by hand, and not on
# boot. update.sh removes both once the new build has answered its health check.
AssertPathExists=!${FENCE_FILE}
EOF
  chmod 644 "${FENCE_DROPIN_FILE}"

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

  mkdir -p "${DB_FENCE_DIR}"
  chown "${APP_USER}:${APP_USER}" "${DB_FENCE_DIR}"
  chmod 700 "${DB_FENCE_DIR}"

  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" || rc=$?

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
        node "${DB_FENCE_SCRIPT}" --print-migration-url)" || die \
        "The connection fence is up but the migration URL could not be composed, so the migration would run as the deploy admin and create objects the application cannot use. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      [[ -n "${MIGRATION_DATABASE_URL}" ]] || die \
        "The connection fence is up but --print-migration-url produced nothing. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      DB_FENCE_UP=true
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
    # The preflight changes nothing, so a dry run may run it for real — and saying what it
    # actually answered is the whole point of --dry-run. Not fatal here: a dry run that cannot
    # reach the database still exits 0, having said so.
    local dry_rc=0
    run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --preflight || dry_rc=$?
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
    node "${DB_FENCE_SCRIPT}" --preflight || rc=$?
  [[ "${rc}" -eq 0 ]] || die \
    "The migration window could NOT be fenced (fence preflight exit ${rc}); the reason is printed above. Refusing to migrate. Nothing has been stopped and nothing has been migrated."

  success "A connection fence is possible, and fence-db-connections.mjs proved it by asking the database."
}

release_db_connections() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would run: ${DB_FENCE_RELEASE_CMD}"
    return 0
  fi
  [[ -f "${DB_FENCE_STATE}" ]] || return 0
  [[ -f "${DB_FENCE_SCRIPT}" ]] || { error "Cannot release the connection fence: ${DB_FENCE_SCRIPT} is missing."; return 1; }

  if run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --release --state-file="${DB_FENCE_STATE}"; then
    MIGRATION_DATABASE_URL="${DATABASE_URL}"
    DB_FENCE_UP=false
    success "Connection fence released."
    return 0
  fi

  error "THE CONNECTION FENCE COULD NOT BE RELEASED. The application role still has no"
  error "CONNECT on this database, so the application cannot start until this is undone:"
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

  local rc=0
  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  DB_FENCE_UP=true
  # DO NOT SUBSTITUTE THE ADMIN URL WHEN THE COMPOSER REFUSES (o3d-2sm1.5, r6).
  # `--print-migration-url` throws precisely so that a migration can never run AS THE ADMIN
  # while the log announces the application role; catching that throw and assigning
  # DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit. Fail loudly and
  # leave it empty instead: the fence is up, and nothing this trap does next needs the URL.
  local url_rc=0
  MIGRATION_DATABASE_URL="$(run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --print-migration-url)" || url_rc=$?
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
    info "No connection fence was standing from the previous run (${DB_FENCE_STATE} is absent)."
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
          error "  node ${DB_FENCE_SCRIPT} --fence --state-file=${DB_FENCE_STATE}"
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
release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence
# Lifts a mask left by an older revision of this script, which used `systemctl mask`
# from its exit trap. Harmless when there is none.
run systemctl unmask "${SERVICE_UNIT}" >/dev/null 2>&1 || true
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
