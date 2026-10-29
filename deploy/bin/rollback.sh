#!/usr/bin/env bash
# Roll the production host back to the release recorded in deploy/previous.
#
#   rollback.sh [--force-schema-mismatch]
#
# Re-creates the previous slot's container from the recorded image with the CURRENT ims.env (never `docker start`), health-checks it, switches nginx
# back, stops the current slot (kept, not removed) and swaps deploy/current and deploy/previous.
#
# Refused if any migration applied to the database since `previous` shipped lacks the `-- expand-only` first-line marker: the older
# code would run against a schema it does not fit. --force-schema-mismatch overrides that.
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=lib.sh
. "${here}/lib.sh"

force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-schema-mismatch) force=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "usage: rollback.sh [--force-schema-mismatch]" >&2; exit 2 ;;
  esac
  shift
done

require_root
check_env_file
take_lock 0

active="$(serving_slot)" || die "cannot determine which slot nginx serves; nothing was changed"
assert_no_draining_workers || die "an earlier switch is still draining; nothing was changed"
reconcile_state "$active" || die "deploy/current does not match what nginx serves and cannot be reconciled; nothing was changed"
cur="$(read_state current)" prev="$(read_state previous)"
[ -n "$cur" ] && [ -n "$prev" ] || die "deploy/current and deploy/previous must both exist; there is nothing to roll back to"
cur_sha="${cur%% *}" cur_slot="${cur#* }" prev_sha="${prev%% *}" prev_slot="${prev#* }"
require_sha "$cur_sha"; require_sha "$prev_sha"
[ "$cur_slot" != "$prev_slot" ] || die "current and previous name the same slot ($cur_slot)"
[ "$active" = "$cur_slot" ] || die "nginx serves '${active}' but deploy/current says ${cur_slot}; resolve that by hand first"
prev_name="$(slot_name "$prev_slot")" prev_port="$(slot_port "$prev_slot")" cur_name="$(slot_name "$cur_slot")"
log "rolling back ${cur_sha} (${cur_slot}) -> ${prev_sha} (${prev_slot})"

# --- schema check ---------------------------------------------------------------------------------------------------------------
docker image inspect "$(migrate_image "$prev_sha")" >/dev/null 2>&1 || docker pull "$(migrate_image "$prev_sha")" >/dev/null 2>&1 \
  || die "$(migrate_image "$prev_sha") is not available locally and cannot be pulled; refusing to roll back"
applied="$(applied_migrations "$cur_sha")" || die "cannot read _prisma_migrations from the database"
prev_known="$(list_image_migrations "$prev_sha" | cut -f1)" || die "cannot list the migrations in $(migrate_image "$prev_sha")"
cur_listing="$(list_image_migrations "$cur_sha")" || die "cannot list the migrations in $(migrate_image "$cur_sha")"
unsafe=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  grep -Fxq -- "$name" <<< "$prev_known" && continue
  if ! grep -Fxq -- "${name}"$'\t'expand <<< "$cur_listing"; then unsafe+="${name}"$'\n'; fi
done <<< "$applied"
if [ -n "$unsafe" ]; then
  log "migrations applied since ${prev_sha} that are NOT marked '-- expand-only':"
  sed 's/^/  /' <<< "$unsafe" >&2
  if [ "$force" = 1 ]; then log "--force-schema-mismatch given: continuing"; else die "refusing to roll back across them (override: --force-schema-mismatch)"; fi
fi

# --- start the previous slot ----------------------------------------------------------------------------------------------------
# ALWAYS re-created with the shared run_slot, from the recorded release image and the CURRENT validated ims.env (check_env_file above):
# a stopped container keeps the environment it was created with, which is stale after a credential rotation. Never `docker start`.
for img in "$(runtime_image "$prev_sha")" "$(migrate_image "$prev_sha")"; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img" >/dev/null 2>&1 \
    || die "the image $img is not available locally and cannot be pulled; refusing to roll back"
done
log "re-creating ${prev_name} from ${prev_sha} with the current ${IMS_ENV_FILE}"
run_slot "$prev_slot" "$prev_sha" || die "cannot start ${prev_name}"
if ! wait_http_200 "http://127.0.0.1:${prev_port}/login" "$IMS_HEALTH_TIMEOUT_S"; then
  stop_unless_serving "$prev_slot" || true
  die "${prev_name} did not become healthy; the current release keeps serving"
fi
if ! switch_upstream "$prev_port"; then
  stop_unless_serving "$prev_slot" || true
  die "could not switch the nginx upstream; the current release keeps serving"
fi
if ! wait_http_200 "${IMS_FRONT_URL}/login" "$IMS_FRONT_TIMEOUT_S" || [ "$(header_slot || true)" != "$prev_slot" ]; then
  log "nginx does not serve the rolled-back release; switching back to ${cur_slot}"
  switch_upstream "$(slot_port "$cur_slot")" || log "ALSO could not switch back; fix ${IMS_UPSTREAM_FILE} by hand"
  stop_unless_serving "$prev_slot" || true
  die "${IMS_FRONT_URL}/login did not answer 200 after the switch"
fi
# --- swap the records (previous first) as soon as nginx is verified on the target, BEFORE the drain wait ------------------------
write_atomic "${IMS_DEPLOY_DIR}/previous" "${cur_sha} ${cur_slot}"
write_atomic "${IMS_DEPLOY_DIR}/current" "${prev_sha} ${prev_slot}"
log "rolled back to ${prev_sha} (${prev_slot})"
cleanup_rc=0
drain_and_stop_slot "$cur_slot" || cleanup_rc=$?
if [ "$cleanup_rc" != 0 ] && [ "$cleanup_rc" != "$EXIT_CLEANUP_PENDING" ]; then
  die "nginx still serves ${cur_name} after the switch; it is left running (deploy/current already names ${prev_sha})"
fi
install_host_cron "$prev_sha" || { DIE_RC=4 die "rolled back, but the host crontab could not be re-rendered (the ims-cron-render timer retries every 5 minutes)"; }
[ "$cleanup_rc" = 0 ] || exit "$cleanup_rc"   # 5: rolled back and recorded, old slot kept for draining workers (cleanup-old-slot.sh)
