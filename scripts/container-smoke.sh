#!/usr/bin/env bash
# Smoke test for the IMS container images.
#
#   scripts/container-smoke.sh <runtime-image> <migrate-image>
#
# 1. starts postgres:17 (production runs 17) on a private docker network
# 2. runs the migrate image against it (`prisma migrate deploy`)
# 3. starts the runtime image with a minimal environment
# 4. polls http://127.0.0.1:${SMOKE_PORT:-3000}/login for up to 90 s
#
# Exits 0 ONLY when /login answers HTTP 200. Always removes the containers and the network it
# created, and prints the runtime container's logs on failure.
#
# NO OUTBOUND CONNECTOR TRAFFIC: no connector credentials are supplied, the outbound-write hold is
# left at its default (refuse every write), and the producer-side egress hold is enforced for every
# destination (PRODUCER_HOLD_ENFORCED_DESTINATIONS=all; lib/security/producer-seam.ts). Mintsoft,
# Xero and WooCommerce are live systems; this script must never reach them.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <runtime-image> <migrate-image>" >&2
  exit 2
fi
RUNTIME_IMAGE="$1"
MIGRATE_IMAGE="$2"

PG_IMAGE="${SMOKE_PG_IMAGE:-postgres:17}"
PORT="${SMOKE_PORT:-3000}"
TIMEOUT_S="${SMOKE_TIMEOUT_S:-90}"
SUFFIX="$$-$(date +%s)"
NET="ims-smoke-net-${SUFFIX}"
PG_NAME="ims-smoke-pg-${SUFFIX}"
APP_NAME="ims-smoke-app-${SUFFIX}"
CRON_NAME="ims-smoke-cron-${SUFFIX}"
CROND_DIR=""
SMOKE_DIR=""
BAD_DIR=""
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# Throwaway per-run values (generated, never committed, never reused).
rand() { openssl rand -hex "$(( $1 / 2 ))"; }   # $1 hex characters (even)
PG_PASSWORD="$(rand 24)"
AUTH_SECRET="$(rand 44)"
CRON_SECRET="$(rand 48)"
SETTINGS_ENCRYPTION_KEY="$(rand 32)"   # exactly 32 bytes (raw key form accepted by lib/security/encryption-key.ts)
DATABASE_URL="postgresql://ims:${PG_PASSWORD}@${PG_NAME}:5432/ims"
# Secrets reach docker by name only (`-e NAME` inherits the value from this environment), so none
# ever appears on a command line where `ps` would show it.
export PG_PASSWORD AUTH_SECRET CRON_SECRET SETTINGS_ENCRYPTION_KEY DATABASE_URL
export POSTGRES_PASSWORD="$PG_PASSWORD" PGPASSWORD="$PG_PASSWORD"
export AUTH_URL="http://127.0.0.1:${PORT}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"

status=1
# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [ "$status" -ne 0 ]; then
    echo "::group::runtime container logs (${APP_NAME})" >&2
    docker logs "$APP_NAME" 2>&1 | tail -n 200 >&2 || true
    echo "::endgroup::" >&2
  fi
  docker rm -f "$CRON_NAME" "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ -n "${CROND_DIR:-}" ]; then as_root rm -rf "$CROND_DIR" || true; fi
  if [ -n "${BAD_DIR:-}" ]; then as_root rm -rf "$BAD_DIR" || true; fi
  if [ -n "${SMOKE_DIR:-}" ]; then rm -rf "$SMOKE_DIR" || true; fi
}
trap cleanup EXIT

docker network create "$NET" >/dev/null

echo "==> starting ${PG_IMAGE}"
docker run -d --name "$PG_NAME" --network "$NET" \
  -e POSTGRES_USER=ims -e POSTGRES_PASSWORD -e POSTGRES_DB=ims \
  "$PG_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U ims -d ims >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready:-0}" != 1 ]; then
  echo "postgres did not become ready" >&2
  docker logs "$PG_NAME" >&2 || true
  exit 1
fi
# pg_isready answers during the entrypoint's temporary init server; wait for the final server.
sleep 3
for _ in $(seq 1 30); do
  docker exec "$PG_NAME" psql -U ims -d ims -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

echo "==> running migrations from ${MIGRATE_IMAGE}"
docker run --rm --network "$NET" -e DATABASE_URL "$MIGRATE_IMAGE"

fail() { echo "FAIL: $*" >&2; exit 1; }
BASE="http://127.0.0.1:${PORT}"
BACKUP_DIR_IN_IMAGE=/var/lib/onetwoinventory/backups
sql() { docker exec "$PG_NAME" psql -U ims -d ims -v ON_ERROR_STOP=1 -tA -c "$1"; }

echo "==> saving scheduler settings in the throwaway database"
# Backup and the pack on; the alarm job at a NON-default schedule (every minute: the real cron daemon below runs it); one job saved
# as disabled. The rendered crontab must carry
# exactly these values (the app's own settings reader is used to render it).
SAVED_ALARM_SCHEDULE='* * * * *'
sql "INSERT INTO settings (key, value, \"updatedAt\") VALUES
       ('cron_backup_enabled', 'true', now()),
       ('backup_schedule_enabled', 'true', now()),
       ('cron_reconciliation_pack_enabled', 'true', now()),
       ('reconciliation_pack_schedule_phase', 'P0', now()),
       ('cron_read_sync_liveness_schedule', '${SAVED_ALARM_SCHEDULE}', now()),
       ('cron_writers_check_enabled', 'false', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null

# Cron runs on the HOST in production (two containers overlap during a blue/green deploy, so the container never runs its own
# scheduler and has no crontab binary). The renderer writes the host's /etc/cron.d file (cron.d layout, user field) from the SAVED
# settings; the IMS container mounts the directory holding that SAME file read-only, so what it reads is the installed cron config.
# The file holds no secret (the lines read CRON_SECRET from a mode-600 file at run time). Below, a real cron daemon runs it.
# Own directory for the files the cron container shares: a file in sticky /tmp owned by another uid cannot be opened for append,
# even by root, when fs.protected_regular is on (as on the CI runners).
SMOKE_DIR="$(mktemp -d)"
SECRET_FILE="${SMOKE_DIR}/cron.env"
: > "$SECRET_FILE"
chmod 0600 "$SECRET_FILE"
echo "CRON_SECRET=${CRON_SECRET}" > "$SECRET_FILE"
CRON_LOG="${SMOKE_DIR}/cron.log"
: > "$CRON_LOG"
chmod 0666 "$CRON_LOG"
CRONTAB_FILE="$(mktemp)"
docker run --rm --network "$NET" -e DATABASE_URL --entrypoint node "$RUNTIME_IMAGE" /app/dist-scripts/render-managed-crontab.mjs \
  --base-url "http://${APP_NAME}:3000" --secret-file "$SECRET_FILE" --log-path "$CRON_LOG" \
  --format cron.d --cron-user root > "$CRONTAB_FILE"
grep -q 'OTI CRON START' "$CRONTAB_FILE" || { echo "the rendered crontab has no managed block" >&2; exit 1; }
# Install it where cron reads it: root:root, mode 0644, a name without dots (cron ignores cron.d files with dots).
CROND_DIR="$(mktemp -d)"
as_root chown root:root "$CROND_DIR"
as_root chmod 0755 "$CROND_DIR"
as_root install -m 0644 -o root -g root "$CRONTAB_FILE" "${CROND_DIR}/onetwo3d-ims"
CRONTAB_PATH_IN_IMAGE=/host-cron.d/onetwo3d-ims
export IMS_SCHEDULER_CRONTAB_FILE="$CRONTAB_PATH_IN_IMAGE"
export IMS_SCHEDULER_CRONTAB_FORMAT=cron.d

echo "==> the rendered block reflects the saved settings"
grep -m1 '^# Source:' "$CRONTAB_FILE"
grep -q '^# Source: saved scheduler settings read from the database' "$CRONTAB_FILE" || fail "the render did not read the saved settings"
alarm_line="$(grep -A1 -x '# Read-Sync Liveness Alarm' "$CRONTAB_FILE" | tail -n 1)"
case "$alarm_line" in "${SAVED_ALARM_SCHEDULE}  "*) echo "    alarm job schedule: ${SAVED_ALARM_SCHEDULE} (saved; default is 25 * * * *; every minute so the cron daemon below fires it quickly)" ;; *) fail "the alarm job is not at the saved schedule: ${alarm_line%% CRON_SECRET*}" ;; esac
if grep -qx '# Writers Coexistence Check' "$CRONTAB_FILE"; then fail "a job saved as disabled is in the rendered block"; fi
echo "    OK: saved schedule rendered; the saved-disabled job (Writers Coexistence Check) is absent"

echo "==> starting ${RUNTIME_IMAGE}"
docker run -d --name "$APP_NAME" --network "$NET" -p "127.0.0.1:${PORT}:3000" \
  -e DATABASE_URL \
  -e AUTH_SECRET \
  -e AUTH_URL \
  -e NEXT_PUBLIC_APP_URL \
  -e CRON_SECRET \
  -e SETTINGS_ENCRYPTION_KEY \
  -e PRODUCER_HOLD_ENFORCED_DESTINATIONS=all \
  -e IMS_SCHEDULER_CRONTAB_FILE \
  -e IMS_SCHEDULER_CRONTAB_FORMAT \
  -v "${CROND_DIR}:/host-cron.d:ro" \
  "$RUNTIME_IMAGE" >/dev/null

echo "==> polling http://127.0.0.1:${PORT}/login for ${TIMEOUT_S}s"
deadline=$((SECONDS + TIMEOUT_S))
code=000
up=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_NAME" 2>/dev/null || echo false)" != true ]; then
    echo "runtime container exited before /login answered" >&2
    exit 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/login" || true)"
  if [ "$code" = 200 ]; then
    up=1
    break
  fi
  sleep 2
done
if [ "$up" != 1 ]; then
  echo "timed out after ${TIMEOUT_S}s; last HTTP status: ${code}" >&2
  exit 1
fi
echo "OK: GET /login -> 200"

# ---------------------------------------------------------------------------------------------
# Server code that starts an external program or a child script must work INSIDE the image.
# ---------------------------------------------------------------------------------------------
# The curl config goes in on stdin so the cron secret is never on a command line.
cron_get() { # <path> <body-file>  -> prints the HTTP status
  local auth_config
  auth_config="header = \"Authorization: Bearer ${CRON_SECRET}\""
  curl -sS -o "$2" -w '%{http_code}' --max-time 170 -K - "${BASE}$1" <<< "$auth_config"
}

echo "==> external programs the server starts (pg_dump, psql, flock)"
for tool in pg_dump psql; do
  version="$(docker exec "$APP_NAME" "$tool" --version)" || fail "${tool} is missing from the runtime image"
  echo "    ${version}"
  case "$version" in *" 17."*) ;; *) fail "${tool} is not PostgreSQL 17: ${version}" ;; esac
done
docker exec "$APP_NAME" flock --version >/dev/null 2>&1 || fail "flock is missing from the runtime image"

# Run ONE rendered job line exactly as cron would: the command part of the line (after the five schedule fields and the user) under sh, with the
# block's BASE_URL in the environment. Prints the exit status; stderr goes to the file named by $2.
rendered_job_command() { # <slug>
  local line
  line="$(grep -F "\$BASE_URL/$1\"" "$CRONTAB_FILE" | head -n 1)"
  [ -n "$line" ] || fail "no rendered line for job $1"
  printf '%s' "$line" | sed -E 's/^([^ ]+ +){6}//'
}
run_cron_command() { # <command> <stderr-file>  -> exit status on stdout
  local rc=0
  env BASE_URL="http://127.0.0.1:${PORT}/api/cron" sh -c "$1" 2>"$2" || rc=$?
  echo "$rc"
}

echo "==> a rendered cron job runs for real: the backup line, executed with sh against this container"
: > "$CRON_LOG"
backup_cmd="$(rendered_job_command backup)"
err_file="$(mktemp)"
rc="$(run_cron_command "$backup_cmd" "$err_file")"
echo "    exit status ${rc}; stderr: $(head -c 300 "$err_file"); job log: $(head -c 300 "$CRON_LOG")"
[ "$rc" = 0 ] || fail "the rendered backup job exited ${rc}"
[ ! -s "$err_file" ] || fail "the rendered backup job wrote to stderr"
if grep -q 'was not run' "$CRON_LOG"; then fail "the rendered backup job refused to run"; fi
echo "    OK: the rendered backup line reached /api/cron/backup and succeeded"

echo "==> negative control: the same line with the secret file absent must not pass silently"
mv "$SECRET_FILE" "${SECRET_FILE}.moved"
: > "$CRON_LOG"
rc="$(run_cron_command "$backup_cmd" "$err_file")"
mv "${SECRET_FILE}.moved" "$SECRET_FILE"
echo "    exit status ${rc}; stderr: $(head -c 200 "$err_file"); job log: $(head -c 300 "$CRON_LOG")"
grep -q 'was not run' "$CRON_LOG" || fail "a missing secret file left no refusal in the job log"
if [ "$rc" = 0 ] && [ ! -s "$err_file" ]; then fail "a missing secret file was silent: exit 0 and nothing on stderr"; fi
echo "    OK: a missing secret file is refused loudly (refusal in the job log, error on stderr, nothing sent)"

echo "==> scheduled backup result"
dump="$(docker exec "$APP_NAME" sh -c "ls -1 ${BACKUP_DIR_IN_IMAGE}/scheduled-*.sql 2>/dev/null | head -n 1")"
[ -n "$dump" ] || fail "no scheduled-*.sql file in ${BACKUP_DIR_IN_IMAGE}"
docker exec "$APP_NAME" test -s "$dump" || fail "the dump ${dump} is empty"
docker exec "$APP_NAME" grep -q 'PostgreSQL database dump' "$dump" || fail "${dump} is not a pg_dump file"
echo "    OK: ${dump} is a non-empty pg_dump file"

echo "==> restore of that dump with the image's psql into a scratch database"
sql "CREATE DATABASE restore_check" >/dev/null
docker exec -e PGPASSWORD "$APP_NAME" sh -c \
  'psql -h "$1" -U ims -d restore_check -v ON_ERROR_STOP=1 -q -f "$2" >/dev/null' sh "$PG_NAME" "$dump" \
  || fail "psql could not restore the dump"
tables="$(docker exec "$PG_NAME" psql -U ims -d restore_check -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'settings'")"
[ "$tables" = 1 ] || fail "the restored database has no settings table"
restored="$(docker exec "$PG_NAME" psql -U ims -d restore_check -tA -c "SELECT count(*) FROM settings WHERE key = 'cron_backup_enabled'")"
[ "$restored" = 1 ] || fail "the restored database lacks the row the dump was taken with"
echo "    OK: restored; settings table and data present"

echo "==> reconciliation pack: bundled script present and loadable"
docker exec "$APP_NAME" test -s /app/dist-scripts/reconciliation-pack.mjs || fail "dist-scripts/reconciliation-pack.mjs is missing"
docker exec "$APP_NAME" test -s /app/dist-scripts/read-sync-status.mjs || fail "dist-scripts/read-sync-status.mjs is missing"
docker exec "$APP_NAME" node /app/dist-scripts/reconciliation-pack.mjs --help >/dev/null || fail "the bundled pack does not run"

echo "==> reconciliation pack through /api/cron/reconciliation-pack"
body="$(mktemp)"
http="$(cron_get /api/cron/reconciliation-pack "$body")" || true
echo "    HTTP ${http}: $(head -c 600 "$body")"
outcome="$(jq -r '.outcome // empty' "$body" 2>/dev/null || true)"
pack_code="$(jq -r '.code // empty' "$body" 2>/dev/null || true)"
exit_code="$(jq -r '.exitCode // empty' "$body" 2>/dev/null || true)"
[ -n "$outcome" ] || fail "the pack route returned no outcome (HTTP ${http})"
[ -n "$exit_code" ] || fail "the pack child produced no exit code (outcome=${outcome} code=${pack_code})"
case "$pack_code" in
  CHILD_NOT_STARTED|CHILD_TIMED_OUT|EXIT_CODE_UNKNOWN|NO_CODE_PRINTED|EXIT_WITHOUT_REPORT|REPORT_UNVERIFIED|ACCOUNT_NOT_ALLOWED|DATABASE_URL_MISSING|SCHEDULE_DISABLED|PHASE_NOT_SET|PHASE_INVALID|SETTINGS_UNREADABLE)
    fail "the pack did not run cleanly: outcome=${outcome} code=${pack_code}" ;;
esac
echo "    OK: the pack child ran (outcome=${outcome} code=${pack_code} exit=${exit_code})"

# A REAL cron daemon runs the installed file. A separate throwaway container runs Debian cron with the SAME host file bind-mounted as
# /etc/cron.d/onetwo3d-ims (the directory is mounted writable only because installing the cron package writes a placeholder file into it), the secret file, and network access to the IMS container. The alarm job is saved as every-minute; the job
# must be executed by the daemon and reach its endpoint, which shows as a cron run record the daemon's request created.
echo "==> a real cron daemon fires the installed job"
runs_before="$(sql "SELECT count(*) FROM cron_runs WHERE \"jobName\" = 'read-sync-liveness'")"
[ "$runs_before" = 0 ] || fail "the alarm job already has ${runs_before} run record(s) before the cron daemon started"
: > "$CRON_LOG"   # drop the negative control's expected refusal; anything written from here on is the daemon's
docker run -d --name "$CRON_NAME" --network "$NET" \
  -v "${CROND_DIR}:/etc/cron.d" -v "${SECRET_FILE}:${SECRET_FILE}:ro" -v "${CRON_LOG}:${CRON_LOG}" \
  debian:bookworm-slim sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends cron curl ca-certificates rsyslog >/dev/null && rsyslogd && exec cron -f -L 15' >/dev/null
cron_diagnostics() {
  echo "::group::cron daemon diagnostics" >&2
  docker logs "$CRON_NAME" 2>&1 | grep -v '^debconf\|^Selecting\|^Preparing\|^Unpacking\|^Setting up\|^(Reading' | tail -n 60 >&2 || true
  docker exec "$CRON_NAME" ls -ln /etc/cron.d >&2 || true
  docker exec "$CRON_NAME" sh -c 'tail -n 40 /var/log/syslog 2>/dev/null' >&2 || true
  echo "job log: $(cat "$CRON_LOG")" >&2
  docker exec "$CRON_NAME" curl --version 2>&1 | head -n 1 >&2 || true
  docker exec "$CRON_NAME" sh -c "echo 'header = \"X-Test: 1\"' | curl -sS -K - -o /dev/null -w 'login probe HTTP %{http_code}\n' http://${APP_NAME}:3000/login" >&2 || true
  local cmd
  cmd="$(rendered_job_command read-sync-liveness)" || true
  local mrc=0
  docker exec "$CRON_NAME" sh -c "BASE_URL='http://${APP_NAME}:3000/api/cron'; export BASE_URL; ${cmd}" >&2 || mrc=$?
  echo "manual run of the job line inside the cron container: exit ${mrc}" >&2
  echo "::endgroup::" >&2
}
cron_deadline=$((SECONDS + 240))
fired=""
while [ "$SECONDS" -lt "$cron_deadline" ]; do
  fired="$(sql "SELECT \"runId\" || ' ' || status || ' ' || \"startedAt\" FROM cron_runs WHERE \"jobName\" = 'read-sync-liveness' ORDER BY \"startedAt\" LIMIT 1")"
  [ -n "$fired" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$CRON_NAME" 2>/dev/null || echo false)" = true ] || { cron_diagnostics; fail "the cron container stopped"; }
  sleep 5
done
if [ -z "$fired" ]; then
  cron_diagnostics
  fail "the cron daemon did not run the every-minute job within the time allowed"
fi
echo "    cron daemon fired the job and the endpoint answered: cron_runs ${fired}"
case "$fired" in *" completed "*) ;; *) fail "the job reached its endpoint but the run did not complete: ${fired}" ;; esac
if grep -q 'was not run' "$CRON_LOG"; then fail "the cron daemon's job refused to run: $(cat "$CRON_LOG")"; fi
echo "    OK: Debian cron executed /etc/cron.d/onetwo3d-ims (user field, every-minute schedule) and read-sync-liveness completed"

# The scheduler must be READ and TRUSTED in the container: with no crontab binary it comes from the mounted file. If it were
# unreadable every item would come out inconclusive, and the run above would still have published a report.
echo "==> scheduler visibility inside the container (read-sync status, same reader the pack uses)"
status_json="$(docker exec "$APP_NAME" node /app/dist-scripts/read-sync-status.mjs --json 2>/dev/null || true)"
echo "    scheduler: $(printf '%s' "$status_json" | jq -c '.scheduler' 2>/dev/null || echo unparseable)"
printf '%s' "$status_json" | jq -e '.scheduler.examined == true and .scheduler.unreadable == null and .scheduler.blockProblem == null and (.scheduler.unscheduled | length) == 0' >/dev/null \
  || fail "the scheduler is not readable and trusted from the mounted crontab"
# Control: the same reader pointed at a file that does not exist must report the scheduler unreadable (fails closed).
control_json="$(docker exec -e IMS_SCHEDULER_CRONTAB_FILE=/nonexistent/crontab "$APP_NAME" node /app/dist-scripts/read-sync-status.mjs --json 2>/dev/null || true)"
printf '%s' "$control_json" | jq -e '.scheduler.unreadable != null' >/dev/null || fail "a missing crontab file was not reported as an unreadable scheduler"
echo "    OK: scheduler examined, trusted, nothing unscheduled; a missing file fails closed"

# Control: cron silently ignores a cron.d file that is not root-owned or is group/world-writable, so the reader must not trust one
# either. The same installed file is copied with each property, mounted read-only into a one-off reader, and read.
echo "==> a cron.d file that cron would ignore is not trusted"
BAD_DIR="$(mktemp -d)"
as_root chown root:root "$BAD_DIR"
as_root chmod 0755 "$BAD_DIR"
read_copy_scheduler() { # <mode> <owner>  -> the status JSON read from a copy installed with that mode and owner
  as_root install -m "$1" -o "$2" -g "$2" "$CRONTAB_FILE" "${BAD_DIR}/onetwo3d-ims"
  docker run --rm --network "$NET" -e DATABASE_URL -e IMS_SCHEDULER_CRONTAB_FORMAT -e IMS_SCHEDULER_CRONTAB_FILE=/bad/onetwo3d-ims \
    -v "${BAD_DIR}:/bad:ro" --entrypoint node "$RUNTIME_IMAGE" /app/dist-scripts/read-sync-status.mjs --json 2>/dev/null || true
}
good_copy="$(read_copy_scheduler 0644 root)"
printf '%s' "$good_copy" | jq -e '.scheduler.unreadable == null and (.scheduler.unscheduled | length) == 0' >/dev/null || fail "the harness does not read a root-owned 0644 copy"
for variant in "0664 root" "0646 root" "0644 1001"; do
  # shellcheck disable=SC2086  # deliberate split into mode and owner
  bad_copy="$(read_copy_scheduler $variant)"
  reason="$(printf '%s' "$bad_copy" | jq -r '.scheduler.unreadable // empty')"
  echo "    mode/owner ${variant}: ${reason:-<trusted>}"
  case "$reason" in *"cron would ignore"*) ;; *) fail "a cron.d file with mode/owner ${variant} was trusted" ;; esac
done
echo "    OK: a cron.d file cron would ignore (group/world-writable, or not owned by root) reads as an unreadable scheduler"

pack_run_id="$(jq -r '.packRunId // empty' "$body")"
report_json="$(docker exec "$APP_NAME" cat "/var/tmp/ims-reconciliation-pack-reports/${pack_run_id}/reconciliation-pack.json")" || fail "cannot read the published pack report"
echo "    pack items: $(printf '%s' "$report_json" | jq -c '[.items[] | {id, outcome, reasons}]')"
if printf '%s' "$report_json" | jq -e '[.items[].reasons[]?] | any(. == "SOURCE_UNREADABLE")' >/dev/null; then
  fail "a pack item is inconclusive because a source (the scheduler or a feed read) was unreadable"
fi
# A fresh migrated database is fully conclusive for phase P0: the items that apply pass and nothing is inconclusive.
printf '%s' "$report_json" | jq -e '.summary.inconclusive == 0 and .summary.fail == 0 and .summary.pass > 0' >/dev/null \
  || fail "the pack is not conclusive on a fresh database: $(printf '%s' "$report_json" | jq -c '.summary')"
[ "$pack_code" = all-pass ] || fail "the pack code is ${pack_code}, expected all-pass"
echo "    OK: conclusive reconciliation result: code=${pack_code}, summary $(printf '%s' "$report_json" | jq -c '.summary')"

# In container mode a Save in Settings only records the settings; host cron changes when the host re-renders and installs the file.
# The in-container drift check (the same one the Scheduler page shows) must say so: in sync, then out of date after a saved change,
# then in sync again once the host file is re-rendered and installed.
echo "==> host cron drift after a saved scheduler change"
drift_check() { docker exec "$APP_NAME" node /app/dist-scripts/render-managed-crontab.mjs --check 2>&1 || true; }
rerender_and_install() {
  docker run --rm --network "$NET" -e DATABASE_URL --entrypoint node "$RUNTIME_IMAGE" /app/dist-scripts/render-managed-crontab.mjs \
    --base-url "http://${APP_NAME}:3000" --secret-file "$SECRET_FILE" --log-path "$CRON_LOG" \
    --format cron.d --cron-user root > "${CRONTAB_FILE}.new"
  as_root install -m 0644 -o root -g root "${CRONTAB_FILE}.new" "${CROND_DIR}/onetwo3d-ims"
}
expect_drift() { # <label> <expected prefix glob> <what to say on failure>
  drift="$(drift_check)"
  echo "    $1: ${drift%%. Host cron update pending*}"
  # shellcheck disable=SC2254  # the pattern is a deliberate glob
  case "$drift" in $2) ;; *) fail "$3: ${drift}" ;; esac
}
drift="$(drift_check)"
echo "    before any change: ${drift}"
case "$drift" in "Host cron is in sync"*) ;; *) fail "host cron should start in sync with the saved settings: ${drift}" ;; esac

# 1. A whole job switched off in the saved settings, WITHOUT re-rendering: its lines are still installed, so host cron would keep
#    firing it. The check compares the whole block, so it must report the job as extra.
sql "INSERT INTO settings (key, value, \"updatedAt\") VALUES ('cron_activity_cleanup_enabled', 'false', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
expect_drift "after switching a job off without re-rendering" "Host cron is out of date (1 job differ: activity-cleanup) \[extra: activity-cleanup\]*" "a job switched off but still installed was not reported as extra"
rerender_and_install
expect_drift "after re-rendering and installing" "Host cron is in sync*" "host cron did not return to in sync after the extra job was removed"

# 2. A changed saved schedule.
sql "INSERT INTO settings (key, value, \"updatedAt\") VALUES ('cron_backup_schedule', '5 2 * * *', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
expect_drift "after saving a new backup schedule" "Host cron is out of date (1 job differ: backup) \[changed: backup\]*" "a saved schedule change was not reported as host cron out of date"
rerender_and_install
expect_drift "after re-rendering and installing" "Host cron is in sync*" "host cron did not return to in sync after the re-render and install"

# 3. An active line OUTSIDE the managed block: a copy of a managed job appended after the END marker still runs under cron (it would
#    fire twice), so the file is no longer what the settings render. Installed root:root 0644, so only this property differs.
# shellcheck disable=SC2016  # the pattern is the literal text $BASE_URL, not an expansion
backup_line="$(grep -F '$BASE_URL/backup"' "${CRONTAB_FILE}.new" | head -n 1)"
[ -n "$backup_line" ] || fail "no backup job line to copy"
{ cat "${CRONTAB_FILE}.new"; printf '%s\n' "$backup_line"; } > "${CRONTAB_FILE}.stray"
as_root install -m 0644 -o root -g root "${CRONTAB_FILE}.stray" "${CROND_DIR}/onetwo3d-ims"
expect_drift "after appending a copy of a job line outside the block" "Host cron is out of date: 1 line\(s\) outside the managed block that cron would run or apply \(line [0-9]*: active job line outside the managed block\)*" "an active line outside the managed block was not reported as drift"
case "$drift" in *CRON_SECRET*|*curl*|*grep*) fail "the outside-line diagnostic quotes installed command text: ${drift}" ;; esac
as_root install -m 0644 -o root -g root "${CRONTAB_FILE}.new" "${CROND_DIR}/onetwo3d-ims"
expect_drift "after restoring the rendered file" "Host cron is in sync*" "host cron did not return to in sync after the stray line was removed"

# 4. An environment assignment OUTSIDE the managed block: cron applies it to every job after it, so SHELL=/bin/false ahead of the block
#    stops every managed job from running while the block itself still looks perfect.
{ printf 'SHELL=/bin/false\n'; cat "${CRONTAB_FILE}.new"; } > "${CRONTAB_FILE}.shell"
as_root install -m 0644 -o root -g root "${CRONTAB_FILE}.shell" "${CROND_DIR}/onetwo3d-ims"
expect_drift "after prepending SHELL=/bin/false outside the block" "Host cron is out of date: 1 line\(s\) outside the managed block that cron would run or apply \(line 1: environment assignment outside the managed block \(SHELL\)\)*" "an environment assignment outside the managed block was not reported as drift"
case "$drift" in *"/bin/false"*) fail "the assignment's value is shown: ${drift}" ;; esac
as_root install -m 0644 -o root -g root "${CRONTAB_FILE}.new" "${CROND_DIR}/onetwo3d-ims"
expect_drift "after restoring the rendered file" "Host cron is in sync*" "host cron did not return to in sync after the assignment was removed"

# 5. An out-of-range saved schedule written straight into the settings row (bypassing Save). `99 * * * *` has the right shape, but cron
#    would never run it, and nothing on the host syntax-checks a cron.d file, so the renderer must refuse to render it.
sql "UPDATE settings SET value = '99 * * * *' WHERE key = 'cron_backup_schedule'" >/dev/null
render_err="$(mktemp)"
render_rc=0
docker run --rm --network "$NET" -e DATABASE_URL --entrypoint node "$RUNTIME_IMAGE" /app/dist-scripts/render-managed-crontab.mjs \
  --base-url "http://${APP_NAME}:3000" --secret-file "$SECRET_FILE" --log-path "$CRON_LOG" --format cron.d --cron-user root \
  > /dev/null 2> "$render_err" || render_rc=$?
echo "    renderer with a saved out-of-range schedule: exit ${render_rc}: $(head -c 300 "$render_err")"
[ "$render_rc" != 0 ] || fail "the renderer rendered an out-of-range saved schedule"
grep -q 'Invalid cron schedule for Database Backup' "$render_err" || fail "the renderer's refusal does not name the job"
grep -q 'minute "99" is out of range' "$render_err" || fail "the renderer's refusal does not name the bad field"
sql "UPDATE settings SET value = '5 2 * * *' WHERE key = 'cron_backup_schedule'" >/dev/null
expect_drift "after restoring the saved schedule" "Host cron is in sync*" "host cron did not return to in sync after the bad schedule was restored"
echo "    OK: host cron drift reads in sync, out of date with an EXTRA job and with a changed schedule, and in sync again after each host re-render"

status=0
exit 0
