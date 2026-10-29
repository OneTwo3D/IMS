#!/usr/bin/env bash
# Re-render the host crontab from the saved scheduler settings and install /etc/cron.d/onetwo3d-ims.
#
#   cron-render.sh [--only-if-changed]
#
# Run by ims-cron-render.timer every 5 minutes with --only-if-changed: that is what applies a scheduler change saved in the app
# (container mode cannot write host cron itself). Uses the renderer shipped in the CURRENT release's image. Wrapped in the
# o3d-hc heartbeat (slug ims-cron-render) when it is installed.
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=lib.sh
. "${here}/lib.sh"

hc_reexec ims-cron-render "${BASH_SOURCE[0]}" "$@"

mode=""
case "${1:-}" in
  "") ;;
  --only-if-changed) mode=only-if-changed ;;
  *) echo "usage: cron-render.sh [--only-if-changed]" >&2; exit 2 ;;
esac

require_root
take_lock 120
cur="$(read_state current)"
if [ -z "$cur" ]; then log "no release deployed yet; nothing to render"; exit 0; fi
[ -f "$IMS_ENV_FILE" ] || die "$IMS_ENV_FILE does not exist"
install_host_cron "${cur%% *}" "$mode"
