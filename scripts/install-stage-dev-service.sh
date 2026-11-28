#!/usr/bin/env bash
# Installs the stage host's ims-stage-dev.service (hardened `next dev`, User=ims, /opt/ims/onetwo3d-ims) from the copy in
# THIS checkout's deploy/systemd/, which is the source of truth for the unit, then reloads systemd and enables and
# starts it. Run as root on the stage host: sudo bash scripts/install-stage-dev-service.sh
set -euo pipefail

SERVICE_NAME="ims-stage-dev.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_UNIT="${REPO_DIR}/deploy/systemd/${SERVICE_NAME}"
TARGET_UNIT="/etc/systemd/system/${SERVICE_NAME}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install-stage-dev-service.sh" >&2
  exit 1
fi

if [[ ! -f "${SOURCE_UNIT}" ]]; then
  echo "Missing unit file: ${SOURCE_UNIT}" >&2
  exit 1
fi

install -m 0644 "${SOURCE_UNIT}" "${TARGET_UNIT}"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
