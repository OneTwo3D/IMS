#!/usr/bin/env bash
# =============================================================================
# OneTwo3D IMS — Database Backup Script
# =============================================================================
# Creates a compressed, timestamped PostgreSQL dump.
# Intended to be run via cron for scheduled backups.
#
# Usage:
#   bash backup.sh                    # backup to default directory
#   bash backup.sh /path/to/backups   # backup to custom directory
#
# Cron example (daily at 02:00):
#   0 2 * * * /bin/bash /opt/onetwo3d-ims/scripts/backup.sh >> /var/log/onetwo3d-ims/backup.log 2>&1
# =============================================================================

set -euo pipefail

APP_NAME="onetwo3d-ims"
APP_DIR="/opt/${APP_NAME}"
BACKUP_DIR="${1:-/var/backups/${APP_NAME}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"  # Delete backups older than this many days

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/backup-${TIMESTAMP}.sql.gz"
LATEST_LINK="${BACKUP_DIR}/latest.sql.gz"

echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] Starting backup..."

# Load .env
[[ -f "${APP_DIR}/.env" ]] || { echo "ERROR: ${APP_DIR}/.env not found"; exit 1; }
set -a; source "${APP_DIR}/.env"; set +a

[[ -n "${DATABASE_URL:-}" ]] || { echo "ERROR: DATABASE_URL not set in .env"; exit 1; }

mkdir -p "${BACKUP_DIR}"

# Run backup
pg_dump "${DATABASE_URL}" \
  --format=plain \
  --no-owner \
  --no-acl \
  | gzip -9 > "${BACKUP_FILE}"

# Update "latest" symlink
ln -sf "${BACKUP_FILE}" "${LATEST_LINK}"

FILE_SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] Backup saved: ${BACKUP_FILE} (${FILE_SIZE})"

# Prune old backups
DELETED=$(find "${BACKUP_DIR}" -name "backup-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete | wc -l)
[[ "$DELETED" -gt 0 ]] && echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] Pruned ${DELETED} backup(s) older than ${KEEP_DAYS} days."

echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] Backup complete."
