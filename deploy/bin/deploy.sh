#!/usr/bin/env bash
# Blue/green deploy of a CI-built IMS release on the production host.
#
#   deploy.sh [--allow-contract-migration --maintenance] <full-commit-sha>
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
# Writers are held off by default: the release is not started unless the env file sets PRODUCER_HOLD_ENFORCED_DESTINATIONS.
#
# Exit codes: 0 deployed; 1 failed with the old release still serving (or, in maintenance mode, stopped); 2 usage;
# 3 refused by the pre-migration check; 4 deployed, but the host crontab could not be re-rendered.
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=lib.sh
. "${here}/lib.sh"

hc_reexec ims-deploy "${BASH_SOURCE[0]}" "$@"

allow_contract=0 maintenance=0 sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-contract-migration) allow_contract=1 ;;
    --maintenance) maintenance=1 ;;
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

old_slot="$(active_slot)"
if [ "$old_slot" = none ]; then new_slot=blue; else new_slot="$(other_slot "$old_slot")"; fi
new_name="$(slot_name "$new_slot")"
new_port="$(slot_port "$new_slot")"
old_sha=""
if [ "$old_slot" != none ]; then
  recorded="$(read_state current)"
  if [ "${recorded#* }" = "$old_slot" ]; then old_sha="${recorded%% *}"; else old_sha="$(container_image_sha "$(slot_name "$old_slot")")"; fi
  [ -n "$old_sha" ] || die "nginx serves the ${old_slot} slot but its release cannot be determined (no matching deploy/current, no container); fix deploy/current and retry"
fi
log "deploying ${sha}: active slot ${old_slot}${old_sha:+ (${old_sha})}, new release goes to ${new_slot}"

# --- 1. images ------------------------------------------------------------------------------------------------------------------
docker pull "$(runtime_image "$sha")" >/dev/null || die "cannot pull $(runtime_image "$sha")"
docker pull "$(migrate_image "$sha")" >/dev/null || die "cannot pull $(migrate_image "$sha")"

# --- 2. pre-migration check -----------------------------------------------------------------------------------------------------
applied="$(applied_migrations "$sha")" || die "cannot read _prisma_migrations from the database"
shipped="$(list_image_migrations "$sha")" || die "cannot list the migrations in $(migrate_image "$sha")"
[ -n "$shipped" ] || die "$(migrate_image "$sha") lists no migrations; refusing to continue"
pending="" bad=""
while IFS=$'\t' read -r name marker; do
  [ -n "$name" ] || continue
  grep -Fxq -- "$name" <<< "$applied" && continue
  pending+="${name}"$'\n'
  [ "$marker" = expand ] || bad+="${name}"$'\n'
done <<< "$shipped"
if [ -z "$applied" ]; then
  log "the database has no applied migrations (first install): the expand-only rule has no running release to protect"
  bad=""
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
if [ "$contract" = 1 ] && [ "$old_slot" != none ]; then
  log "MAINTENANCE: stopping the active slot $(slot_name "$old_slot") before the contract migration"
  docker stop "$(slot_name "$old_slot")" >/dev/null || die "cannot stop $(slot_name "$old_slot")"
fi
log "running $(migrate_image "$sha")"
docker run --rm --network host --env-file "$IMS_ENV_FILE" "$(migrate_image "$sha")" || die "prisma migrate deploy failed (the ${old_slot} release was not touched unless this is a maintenance deploy)"

# --- 4./5. start and health-check the new slot ----------------------------------------------------------------------------------
fail_new_slot() {
  log "$1"
  docker stop "$new_name" >/dev/null 2>&1 || true
  if [ "$contract" = 1 ]; then log "the active slot was stopped for the maintenance deploy and is NOT restarted: the schema may no longer fit it"; fi
  exit 1
}
run_slot "$new_slot" "$sha" || fail_new_slot "could not start ${new_name}"
wait_http_200 "http://127.0.0.1:${new_port}/login" "$IMS_HEALTH_TIMEOUT_S" \
  || { docker logs --tail 50 "$new_name" >&2 2>&1 || true; fail_new_slot "${new_name} did not become healthy; it is stopped, the ${old_slot} release keeps serving"; }

# --- 6./7. switch and verify through nginx --------------------------------------------------------------------------------------
switch_upstream "$new_port" || fail_new_slot "could not switch the nginx upstream; the previous upstream is restored"
if ! wait_http_200 "${IMS_FRONT_URL}/login" "$IMS_FRONT_TIMEOUT_S"; then
  if [ "$old_slot" != none ] && [ "$contract" = 0 ]; then
    log "nginx does not serve the new release; switching back to ${old_slot}"
    switch_upstream "$(slot_port "$old_slot")" || log "ALSO could not switch back; fix ${IMS_UPSTREAM_FILE} by hand"
  fi
  fail_new_slot "${IMS_FRONT_URL}/login did not answer 200 after the switch"
fi

# --- 8. previous slot: stop, keep ---------------------------------------------------------------------------------------------
if [ "$old_slot" != none ]; then
  sleep "$IMS_DRAIN_S"
  docker stop "$(slot_name "$old_slot")" >/dev/null 2>&1 || log "warning: could not stop $(slot_name "$old_slot")"
fi

# --- 9. record: previous first, so an interruption never leaves current ahead of previous ---------------------------------------
mkdir -p "$IMS_DEPLOY_DIR"
if [ "$old_slot" != none ]; then write_atomic "${IMS_DEPLOY_DIR}/previous" "${old_sha} ${old_slot}"; fi
write_atomic "${IMS_DEPLOY_DIR}/current" "${sha} ${new_slot}"
log "deployed ${sha} to ${new_slot}"

# --- 10. host cron --------------------------------------------------------------------------------------------------------------
install_host_cron "$sha" || { DIE_RC=4 die "deployed, but the host crontab could not be re-rendered (the ims-cron-render timer retries every 5 minutes)"; }
log "done"
