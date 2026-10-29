#!/usr/bin/env bash
# Stop the idle (non-served) app slot once no nginx worker is still draining connections to it.
#
#   cleanup-old-slot.sh
#
# For the case deploy.sh / rollback.sh exited with status 5 ("deployed, cleanup pending"): the release is live and recorded, but the
# previous slot was kept running because nginx workers were still serving long responses from it. This re-checks and, only when no
# worker is shutting down AND the running nginx confirms it does not serve the slot, runs `docker stop -t 30` on it (kept, not removed).
# Exit codes: 0 nothing left to do; 1 error; 5 workers are still draining (nothing stopped).
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=lib.sh
. "${here}/lib.sh"

require_root
take_lock 0
served="$(serving_slot)" || die "cannot determine which slot nginx serves; nothing was changed"
[ "$served" != none ] || die "nginx serves no slot; nothing to clean up"
idle="$(other_slot "$served")"
if ! slot_running "$idle"; then log "$(slot_name "$idle") is not running; nothing to do"; exit 0; fi
still="$(draining_workers)"
if [ -n "$still" ]; then
  log "nginx workers are still draining; $(slot_name "$idle") is left running:"
  sed 's/^/  /' <<< "$still" >&2
  exit "$EXIT_CLEANUP_PENDING"
fi
assert_not_serving "$idle" || exit 1
docker stop -t 30 "$(slot_name "$idle")" >/dev/null 2>&1 || true
if slot_running "$idle"; then log "$(slot_name "$idle") is still running after docker stop; cleanup is still pending"; exit "$EXIT_CLEANUP_PENDING"; fi
log "stopped $(slot_name "$idle")"
