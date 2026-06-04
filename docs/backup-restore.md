# Backup & Restore

The backup system creates full snapshots of your database that can be stored locally, uploaded to remote storage, or used to restore the system to a previous state.

## Creating a Backup

Click **Create Backup** to generate a full PostgreSQL dump of your database. The backup file is:

- **Downloaded automatically** to your browser
- **Saved on the server** for future use

## Backup List

The backup list shows all backups stored on the server, with:

- **File name**
- **File size**
- **Date created**
- **Actions** available for each backup

## Restoring from a Backup

You can restore from:

- **An existing backup** in the list — click the restore action next to it
- **An uploaded file** — upload a previously downloaded backup file

Restoring overwrites all current data. To confirm, you must type **RESTORE** into the confirmation field. This safeguard prevents accidental restores.

The restore API also enforces this confirmation server-side, requires a short-lived one-time confirmation code emailed to the authenticated admin address, requires a fresh admin login, and only accepts plain `.sql` files from the configured backup directory or an uploaded `.sql` file for that request. The confirmation code expires after five minutes; by default the fresh-login window is 15 minutes (`FRESH_AUTH_MAX_AGE_SECONDS`), so admins may need to sign in again and request a new code if either window expires.

When `NODE_ENV=production`, restore is disabled unless `ALLOW_DATABASE_RESTORE=true` is set for a supervised restore window. Restoring from a server-side backup only requires that base flag; restoring from an uploaded SQL file also requires `ALLOW_DATABASE_RESTORE_UPLOAD=true`. Leave both flags unset or `false` during normal operation. Non-production environments bypass these kill switches, so staging restore drills should run with `NODE_ENV=production` if they need to exercise production restore gating.

Denied restore attempts are written to the activity log as `WARNING` entries with action `backup_restore_denied` and a machine-readable `metadata.reason`, such as `production_restore_disabled`, `production_upload_restore_disabled`, or `cross_origin_restore_request`.

## Remote Storage

Backups can be uploaded to remote storage for off-site protection. Two storage types are supported.

### S3-Compatible Storage

Works with any S3-compatible service:

- AWS S3
- MinIO
- Backblaze B2
- Cloudflare R2
- DigitalOcean Spaces

Configure the following:

| Field | Description |
|---|---|
| **Endpoint** | The service endpoint URL |
| **Region** | The storage region (e.g. `eu-west-2`) |
| **Bucket** | The target bucket name |
| **Access key** | Your access key ID |
| **Secret key** | Your secret access key |
| **Path prefix** | Optional folder path within the bucket |

### SFTP

Upload backups to a remote server via SFTP:

| Field | Description |
|---|---|
| **Host** | The server hostname or IP address |
| **Port** | The SSH port (default 22) |
| **Username** | The login username |
| **Password** | Password authentication (if used) |
| **Private key** | PEM-format private key for certificate-based authentication |
| **Host fingerprint** | Required SSH host fingerprint used to pin the SFTP server identity |
| **Remote path** | The directory on the remote server where backups are stored |

Both password and private key (PEM format) authentication are supported for SFTP connections. Host fingerprint pinning is required; uploads fail if the server presents a different SSH host key.

## Per-Backup Actions

Each backup in the list offers the following actions:

- **Upload to S3** — push the backup to your configured S3 storage
- **Upload via SFTP** — push the backup to your configured SFTP server
- **Restore** — restore the system from this backup
- **Delete** — remove the backup from the server

## Scheduled Backups

Automate your backup routine by enabling scheduled backups:

- **Enable/disable** the schedule
- **Retention days** — automatically delete backups older than this many days
- **Max backup count** — limit the total number of backups kept on the server
- **Auto-upload** — optionally upload each scheduled backup to S3 or SFTP automatically

## Cron Endpoint

Scheduled backups are triggered via a cron endpoint:

```
/api/cron/backup
```

Configure your server's cron scheduler to call this endpoint at your preferred time. Cron endpoints require the `CRON_SECRET` bearer header in production. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. For example, to run backups daily at 02:00:

```
0 2 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/backup
```

## Activity Log

All backup operations — creation, restore, upload, deletion, and scheduled runs — are recorded in the system activity log for full auditability.
