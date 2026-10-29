#!/usr/bin/env bash
# Blue/green deploy of a CI-built IMS release on the production host.
#
#   deploy.sh [--allow-contract-migration --maintenance] [--force-schema-mismatch] <full-commit-sha>
#
# Two app slots (ims-blue on 127.0.0.1:3101, ims-green on 127.0.0.1:3102) run the same image family; nginx on :3000 proxies to the
# ACTIVE one through an included upstream file. A deploy starts the new release in the idle slot, health-checks it, switches the
# upstream atomically, and leaves the previous slot STOPPED but not removed (fast rollback). Steps, in order:
#
#   1. pull both images (runtime, migrate)             6. switch the nginx upstream (atomic file + nginx -t + graceful reload)
#   2. pre-migration check (below)                     7. verify http://127.0.0.1:3000/login = 200 through nginx
#   3. run the migrate image                           8. stop (do not remove) the previous slot
#   4. start the new image in the idle slot            9. record deploy/{current,previous} (only now)
#   5. wait for http://127.0.0.1:<port>/login = 200   10. re-render and install the host crontab
#
# Pre-migration check. The old release keeps serving while the new one migrates, so every PENDING migration must be backward
# compatible with it: the first line of its migration.sql must be the comment `-- expand-only`. Anything else is refused BEFORE
# migrating, unless --allow-contract-migration is given; that flag requires --maintenance, which stops the active slot first and
# accepts the downtime. A database with no applied migrations yet (the very first install) has no running release to protect and is
# exempt.
#
# Deploying an OLDER image is checked like a rollback: every migration already applied to the database that the target image does not ship
# must be marked expand-only (looked up in the release currently serving), or the deploy is refused (status 3) before anything is
# migrated or started. --force-schema-mismatch overrides, exactly as for rollback.sh.
#
# Writers are held off by default: the release is not started unless the env file sets PRODUCER_HOLD_ENFORCED_DESTINATIONS.
#
# Exit codes: 0 deployed; 1 failed with the old release still serving (or, in maintenance mode, stopped); 2 usage;
# 3 refused by the pre-migration check; 4 deployed, but the host crontab could not be re-rendered;
# 5 deployed and recorded, but the previous slot is still running for draining nginx workers: run cleanup-old-slot.sh later.
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=lib.sh
. "${here}/lib.sh"

hc_reexec ims-deploy "${BASH_SOURCE[0]}" "$@"

allow_contract=0 maintenance=0 force_schema=0 sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-contract-migration) allow_contract=1 ;;
    --maintenance) maintenance=1 ;;
    --force-schema-mismatch) force_schema=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$sha" ] || { echo "only one commit sha may be given" >&2; exit 2; }; sha="$1" ;;
  esac
  shift
done
[ -n "$sha" ] || { echo "usage: deploy.sh [--allow-contract-migration --maintenance] <full-commit-sha>" >&2; exit 2; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "expected a full 40-character lowercase commit sha, got: $sha" >&2; exit 2; }
if [ "$allow_contract" = 1 ] && [ "$maintenance" = 0 ]; then
  echo "--allow-contract-migration requires --maintenance (the active release is stopped before a contract migration runs)" >&2
  exit 2
fi

require_root
check_env_file
take_lock 0

old_slot="$(serving_slot)" || die "cannot determine which slot nginx serves; nothing was changed"
if [ "$old_slot" = none ]; then new_slot=blue; else new_slot="$(other_slot "$old_slot")"; fi
new_name="$(slot_name "$new_slot")"
new_port="$(slot_port "$new_slot")"
old_sha=""
if [ "$old_slot" != none ]; then
  recorded="$(read_state current)"
  if [ "${recorded#* }" = "$old_slot" ]; then old_sha="${recorded%% *}"; else old_sha="$(container_image_sha "$(slot_name "$old_slot")")"; fi
  [ -n "$old_sha" ] || die "nginx serves the ${old_slot} slot but its release cannot be determined (no matching deploy/current, no container); fix deploy/current and retry"
fi
assert_no_draining_workers || die "an earlier switch is still draining; nothing was changed"
log "deploying ${sha}: active slot ${old_slot}${old_sha:+ (${old_sha})}, new release goes to ${new_slot}"

# --- 1. images ------------------------------------------------------------------------------------------------------------------
docker pull "$(runtime_image "$sha")" >/dev/null || die "cannot pull $(runtime_image "$sha")"
docker pull "$(migrate_image "$sha")" >/dev/null || die "cannot pull $(migrate_image "$sha")"

# --- 2. pre-migration check -----------------------------------------------------------------------------------------------------
applied="$(applied_migrations "$sha")" || die "cannot read _prisma_migrations from the database"
shipped="$(list_image_migrations "$sha")" || die "cannot list the migrations in $(migrate_image "$sha")"
[ -n "$shipped" ] || die "$(migrate_image "$sha") lists no migrations; refusing to continue"
# Schema compatibility of the TARGET with what the database already holds (the rollback.sh rule): an older image must not be started
# against migrations it does not know unless they are expand-only. Markers come from the release currently serving.
target_known="$(cut -f1 <<< "$shipped")"
marker_listing=""
if [ -n "$old_sha" ]; then
  { docker image inspect "$(migrate_image "$old_sha")" >/dev/null 2>&1 || docker pull "$(migrate_image "$old_sha")" >/dev/null 2>&1; } \
    && marker_listing="$(list_image_migrations "$old_sha")" || marker_listing=""
fi
unsafe_absent="$(absent_unsafe_migrations "$applied" "$target_known" "$marker_listing")"
if [ -n "$unsafe_absent" ]; then
  log "target image ${sha} lacks applied migration(s) that are not verified expand-only:"
  sed 's/^/  /' <<< "$unsafe_absent" >&2
  if [ "$force_schema" = 1 ]; then log "--force-schema-mismatch given: continuing"; else
    DIE_RC=3 die "target image ${sha} lacks the applied migration(s) above (contract or unverified): refusing, before anything is migrated or started. Override with --force-schema-mismatch only if the older code is known to be compatible."
  fi
fi
pending="" bad=""
while IFS=$'\t' read -r name marker; do
  [ -n "$name" ] || continue
  grep -Fxq -- "$name" <<< "$applied" && continue
  pending+="${name}"$'\n'
  [ "$marker" = expand ] || bad+="${name}"$'\n'
done <<< "$shipped"
if [ -z "$applied" ]; then
  if [ "$old_slot" = none ] && ! slot_running blue && ! slot_running green; then
    log "the database has no applied migrations and nothing is serving (first install): the expand-only rule has no running release to protect"
    bad=""
  elif [ "$allow_contract" = 1 ]; then
    log "the database has NO applied migrations, but a release is serving or running (is DATABASE_URL pointing at the right database?); continuing because --allow-contract-migration --maintenance was given"
    bad="${bad:-<empty migration history>}"
  else
    DIE_RC=3 die "the database has no applied migrations, but a release is serving or running (nginx: ${old_slot}). That means DATABASE_URL points at the wrong database or the history was lost. Refusing to migrate (override: --allow-contract-migration --maintenance)."
  fi
fi
log "pending migrations: $(printf '%s' "$pending" | grep -c . || true)"
[ -z "$pending" ] || sed 's/^/  /' <<< "$pending" >&2
contract=0
if [ -n "$bad" ]; then
  log "pending migrations WITHOUT the '-- expand-only' first-line marker:"
  sed 's/^/  /' <<< "$bad" >&2
  if [ "$allow_contract" = 1 ]; then
    contract=1
  else
    DIE_RC=3 die "refusing to migrate while the active release is serving. A contract (destructive) migration ships in its own maintenance deploy: --allow-contract-migration --maintenance."
  fi
fi

# --- 3. migrate -----------------------------------------------------------------------------------------------------------------
MAINTENANCE_HINT="nginx is left in MAINTENANCE (503 + Retry-After). To resume: fix the cause and rerun 'deploy.sh --allow-contract-migration --maintenance ${sha}'. To abort: run 'deploy.sh <previous full sha>' (an ordinary deploy that leaves maintenance through its verified switch). rollback.sh cannot be used while nginx serves no slot."
if [ "$contract" = 1 ]; then
  # MAINTENANCE: the one place stopping the serving slot is intended, and it is done in this order: (1) nginx answers 503 for everyone,
  # (2) the maintenance response is verified through nginx, (3) nginx workers still proxying to the old slot are drained, with the same
  # wait and bound as a slot switch, (4) EVERY app slot (a failed switch-back can leave both running) is stopped and verified stopped,
  # (5) only then does the destructive migration run. If workers outlive the bound nothing is stopped or migrated.
  log "MAINTENANCE: switching nginx to the maintenance response"
  switch_upstream maintenance || die "could not switch nginx to maintenance (the previous upstream is restored); nothing was stopped or migrated"
  m=0
  until [ "$(http_code "${IMS_FRONT_URL}/login")" = 503 ] && [ "$(header_slot || true)" = none ]; do
    m=$((m + IMS_HEALTH_INTERVAL_S))
    [ "$m" -le "$IMS_FRONT_TIMEOUT_S" ] || { DIE_RC=1 die "nginx does not answer 503 after the maintenance switch; nothing was stopped or migrated. ${MAINTENANCE_HINT}"; }
    sleep "$IMS_HEALTH_INTERVAL_S"
  done
  log "MAINTENANCE: verified (503) through nginx; waiting for in-flight requests to drain"
  if ! wait_workers_drained; then
    log "nginx workers are still draining after ${DRAIN_BOUND}s; they may still be proxying to the running slot(s):"
    sed 's/^/  /' <<< "$DRAIN_STILL" >&2
    DIE_RC="$EXIT_CLEANUP_PENDING" die "REFUSING to stop the app slots or migrate while old workers may still be proxying. Nothing was stopped or migrated. ${MAINTENANCE_HINT}"
  fi
  for slot in blue green; do
    if container_exists "$(slot_name "$slot")"; then
      log "MAINTENANCE: stopping $(slot_name "$slot") before the contract migration"
      docker stop "$(slot_name "$slot")" >/dev/null || die "cannot stop $(slot_name "$slot"); not migrating. ${MAINTENANCE_HINT}"
    fi
  done
  for slot in blue green; do
    if slot_running "$slot"; then die "$(slot_name "$slot") is still running after docker stop; not migrating. ${MAINTENANCE_HINT}"; fi
  done
fi
log "running $(migrate_image "$sha")"
run_migrate "$sha" || { if [ "$contract" = 1 ]; then die "prisma migrate deploy failed during a maintenance deploy; no app slot is running. ${MAINTENANCE_HINT}"; fi; die "prisma migrate deploy failed (the ${old_slot} release was not touched)"; }

# --- 4./5. start and health-check the new slot ----------------------------------------------------------------------------------
fail_new_slot() {
  log "$1"
  stop_unless_serving "$new_slot" || true
  if [ "$contract" = 1 ]; then log "the active slot was stopped for the maintenance deploy and is NOT restarted: the schema may no longer fit it. ${MAINTENANCE_HINT}"; fi
  exit 1
}
run_slot "$new_slot" "$sha" || fail_new_slot "could not start ${new_name}"
wait_http_200 "http://127.0.0.1:${new_port}/login" "$IMS_HEALTH_TIMEOUT_S" \
  || { docker logs --tail 50 "$new_name" >&2 2>&1 || true; fail_new_slot "${new_name} did not become healthy; it is stopped, the ${old_slot} release keeps serving"; }

# --- 6./7. switch and verify through nginx --------------------------------------------------------------------------------------
switch_upstream "$new_port" || fail_new_slot "could not switch the nginx upstream; the previous upstream is restored"
if ! wait_http_200 "${IMS_FRONT_URL}/login" "$IMS_FRONT_TIMEOUT_S" || [ "$(header_slot || true)" != "$new_slot" ]; then
  if [ "$old_slot" != none ] && [ "$contract" = 0 ]; then
    log "nginx does not serve the new release; switching back to ${old_slot}"
    switch_upstream "$(slot_port "$old_slot")" || log "ALSO could not switch back; fix ${IMS_UPSTREAM_FILE} by hand"
  fi
  fail_new_slot "${IMS_FRONT_URL}/login did not answer 200 after the switch"
fi

# --- 8. record: previous first, so an interruption never leaves current ahead of previous. Done as soon as nginx is verified serving the
#        new slot and BEFORE the drain wait (up to ~10 minutes) so that a crash while draining cannot leave the records naming the old one.
mkdir -p "$IMS_DEPLOY_DIR"
if [ "$old_slot" != none ]; then write_atomic "${IMS_DEPLOY_DIR}/previous" "${old_sha} ${old_slot}"; fi
write_atomic "${IMS_DEPLOY_DIR}/current" "${sha} ${new_slot}"
log "deployed ${sha} to ${new_slot}"

# --- 9. previous slot: drain, stop, keep --------------------------------------------------------------------------------------
cleanup_rc=0
if [ "$old_slot" != none ]; then
  drain_and_stop_slot "$old_slot" || cleanup_rc=$?
  if [ "$cleanup_rc" != 0 ] && [ "$cleanup_rc" != "$EXIT_CLEANUP_PENDING" ]; then
    die "nginx still serves $(slot_name "$old_slot") after the switch; it is left running (deploy/current already names ${sha})"
  fi
fi

# --- 10. host cron --------------------------------------------------------------------------------------------------------------
install_host_cron "$sha" || { DIE_RC=4 die "deployed, but the host crontab could not be re-rendered (the ims-cron-render timer retries every 5 minutes)"; }
[ "$cleanup_rc" = 0 ] || exit "$cleanup_rc"
log "done"
