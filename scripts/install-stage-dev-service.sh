#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="ims-stage-dev.service"
REPO_DIR="/root/ims/onetwo3d-ims-isolated"
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
