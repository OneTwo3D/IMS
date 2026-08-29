# Backup & Restore

The backup system creates full snapshots of your database that can be stored locally, uploaded to remote storage, or used to restore the system to a previous state.

## Creating a Backup

Click **Create Backup** to generate a full PostgreSQL dump of your database. The backup file is:

- **Downloaded automatically** to your browser
- **Saved on the server** for future use

Each backup is written as a pair of files:

- **`<name>.sql`** — the PostgreSQL dump itself.
- **`<name>.sql.manifest.json`** — a sidecar manifest recording the schema version (Prisma migration id), source database name, app version, byte length, and SHA256 checksum of the `.sql` file.

The restore flow verifies the manifest matches the `.sql` before applying it. A backup whose manifest is missing or whose checksum doesn't match the file is rejected with `backup_manifest_invalid` and cannot be restored from the UI — re-upload a clean pair or delete and recreate. This protects against partial uploads, truncated files, and accidental edits.

### Backup file-size cap

Server-side restore and upload endpoints enforce a per-file cap controlled by the `DATABASE_RESTORE_MAX_FILE_BYTES` environment variable (default 50 MB). Files above the cap are rejected with HTTP 413. Increase the limit only when your dump genuinely exceeds it; the cap protects the server from accidental OOM during restore.

### Disk-space preflight

Before creating a backup, the system checks free disk space on the backup directory's filesystem. If estimated free space drops below 2× the expected dump size, the backup is aborted with a `backup_disk_space_low` activity-log entry rather than risking a partial dump. Free space is also checked before restore — a restore needs roughly 1.5× the dump's size in temp space.

## Backup List

The backup list shows all backups stored on the server, with:

- **File name**
- **File size**
- **Date created**
- **Actions** available for each backup

## Restoring from a Backup

You can restore from:

- **An existing backup** in the list — click the restore action next to it
- **An uploaded file** — upload a previously downloaded `.sql` backup file and its matching `.manifest.json` sidecar

Restoring overwrites all current data. To confirm, you must type **RESTORE** into the confirmation field. This safeguard prevents accidental restores.

The restore API also enforces this confirmation server-side, requires a short-lived one-time confirmation code emailed to the authenticated admin address, requires a fresh admin login, and only accepts plain `.sql` files from the configured backup directory or an uploaded `.sql` file for that request. The confirmation code expires after two minutes and is bound to the issuing session and verifiable client IP; by default the fresh-login window is 15 minutes (`FRESH_AUTH_MAX_AGE_SECONDS`), so admins may need to sign in again and request a new code if either window expires.

The confirmation token is **bound to the requesting admin's session ID and IP address**: a token issued to admin A from network X cannot be replayed by admin B, by admin A from network Y, or by any unauthenticated caller. Replay attempts are logged with `restore_token_binding_mismatch`.

When `NODE_ENV=production`, restore is disabled unless `ALLOW_DATABASE_RESTORE=true` is set for a supervised restore window. Restoring from a server-side backup only requires that base flag; restoring from an uploaded SQL file also requires `ALLOW_DATABASE_RESTORE_UPLOAD=true`. Leave both flags unset or `false` during normal operation. Non-production environments bypass these kill switches, so staging restore drills should run with `NODE_ENV=production` if they need to exercise production restore gating.

Restore uploads default to a 50 MiB SQL-file cap. Override with `DATABASE_RESTORE_MAX_FILE_BYTES` when a supervised restore drill needs a larger dump. The restore preflight also checks available disk space against a conservative estimate: approximately 10x the SQL file size or 1.25x the database size recorded in the manifest, whichever is larger.

Every generated backup has a `.manifest.json` sidecar containing the manifest schema version, backup filename, database size, critical IMS table names, and advisory post-dump row counts. Stored and uploaded restores reject manifests missing FIFO, COGS, stock movement, accounting sync, payment, shipment, or audit-log critical tables. Row counts are an operator diagnostic and are not a snapshot-consistent equality check against the dump.

### What the restore refuses in the SQL file

Before anything is locked or spawned, the uploaded (or stored) `.sql` file is lexed. The replay runs
under `psql --single-transaction --set ON_ERROR_STOP=1`, so a failure anywhere in a well-formed dump
rolls the whole restore back — but only if the file cannot end that transaction itself. A restore is
therefore refused when the file contains:

- **top-level transaction control** — `BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`,
  `START TRANSACTION`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`. Accepting one of these would
  split the replay into several transactions, so a later failure would leave the database
  **partially restored** while the endpoint reported the restore as failed;
- **psql metacommands**, other than the `\restrict` / `\unrestrict` pair that `pg_dump` 17.6+ emits
  around every plain dump. A `\connect`, for example, would move the replay to another database
  entirely;
- **anything the lexer cannot fully account for** — a file ending inside a string, a dollar-quoted
  block, a comment or a `COPY … FROM stdin` data block, a file that turns
  `standard_conforming_strings` off, one containing `U&'…'` literals, or a plain literal containing
  a backslash-escaped quote (`'a\''`), where the two escaping modes disagree about where the
  literal ends. Ambiguity is refused rather than replayed.

`BEGIN`/`COMMIT` **inside** a PL/pgSQL function body, a string literal, a comment or COPY data are
normal in a `pg_dump` file and are accepted — the check understands SQL structure rather than
matching lines. A backup produced by this application always passes.

Two classes of transaction control cannot be detected by reading the file: one executed indirectly
(a procedure whose body commits) and a statement that cannot run inside a transaction block at all.
Neither can produce a partial restore — PostgreSQL raises an error for both under
`--single-transaction`, and `ON_ERROR_STOP=1` turns that into a clean rollback.

### Concurrency during a restore

For its whole duration a restore holds the accounting connector-selection advisory lock on a
dedicated PostgreSQL session, so a connector switch or an orphaned-sync-row cancellation cannot
interleave with the replay. If the lock cannot be taken within 60 seconds the restore fails
immediately, having changed nothing, and says another restore or connector change is in progress.

The lock has no expiry: it is released when the restore finishes, not on a timer. If `psql` overruns
its five-minute ceiling it is killed, its database backend is terminated from the lock-holding
session, and only then is the lock released — so "the restore has stopped writing" is observed
rather than assumed. The lock is bound to the holder's session, so a dropped connection or a
database restart still releases it while `psql` runs on. Nothing else covers that window: see
"What maintenance mode does and does not stop" below.

The backend is identified by `(pid, backend_start)`, captured from `pg_stat_activity` immediately
after `psql` is spawned and **before any of the dump is streamed to it**. Neither value can be
changed by SQL, so a dump that sets its own `application_name` cannot make itself invisible to the
termination check. If the backend cannot be identified in that window — it never appears, or two
sessions answer to the same name — the restore is refused before a single byte is replayed, so
nothing has been changed.

### What maintenance mode does and does not stop

A restore enables maintenance mode for its duration. Maintenance mode is **not an application-wide
write fence**. It is consulted by:

- the scheduled-job endpoints under `/api/cron/*`,
- the WooCommerce webhook entry point, and
- the Mintsoft ASN booked-in webhook.

It is **not** consulted by interactive server actions, by the ShipHero webhook route, by the
accounting OAuth callback, by any other API route, or by anything holding a direct database
connection. Ordinary dashboard writes continue during a restore.

#### Warehouse callbacks refused during the window

A booked-in callback that arrives while maintenance mode is on gets a `503` with `Retry-After: 300`
and **no row is written** — the fence runs before the signature is verified, and anything written
into the window is being replayed over. Recovery is by re-checking the ASNs afterwards, which
reconstructs the trigger and applies only what is still outstanding (an ASN with nothing owed books
nothing in):

- **Automatically.** Ending a maintenance window stamps `wms_booked_in_recheck_due_since`, and the
  Mintsoft webhook sweeper (every five minutes, enabled by default) drains that stamp by re-checking
  every open ASN — purchase-order and stock-transfer alike.
- **On demand.** *Sync → Exceptions → Maintenance window → Run the re-check now*, for an
  installation whose sweeper cron is disabled or whose scheduler is down. It refuses while
  maintenance mode is still on, because a re-check issued into the window is stopped at the same
  gate the callbacks were.
- **Per ASN.** The **Re-check** button on the ASN table of the purchase order or the stock transfer.

A re-check pass **stops if a restore starts while it is running.** The gate is re-read before the
pass, before each ASN, and again — under a row lock, together with "is this still the marker we
drained" — before the stamp is cleared. A pass stopped that way keeps the stamp and reports
`window_reopened`, so the next tick after the window closes repeats it; a stamp that a *newer*
window restamped mid-pass is left alone (`recheck_marker_moved`) because that window is owed a
re-check this pass established nothing about. Being told "0 attempted" is never ambiguous: a refusal
is always named.

#### When a restore times out and the backend cannot be confirmed gone

The endpoint keeps the connector-selection lock rather than releasing it, leaves maintenance mode on,
and records a **maintenance hold** naming the backend's pid and `backend_start`. The hold appears in
*Sync → Exceptions → Maintenance window* and in the exception count on the Integrations page.
Recovery, in this order:

1. **Take the application out of service.** Interactive writes are not fenced by anything, and this
   is the only way to stop them.
2. Check `pg_stat_activity` for the pid and `backend_start` named in the hold, and
   `pg_terminate_backend` it if it is still there.
3. **Only then restart.** Restarting earlier drops the lock-holding session, which releases the
   advisory lock while the restore backend may still be replaying.
4. **End the hold from the exception inbox.** It re-reads the flag and the hold record under a row
   lock, re-checks that the named backend is gone from `pg_stat_activity` at that moment, and
   refuses — naming which precondition failed — if any of them has moved. Ending it there also
   stamps the booked-in re-check described above.

The action ends **the hold the page showed you**, not whichever hold happens to be recorded when the
click lands. The button carries the record's pid, `backend_start` and `heldAt`, and the transition
refuses with *hold_superseded* if the row under the lock is a different restore's — reload the inbox
and read the new hold before ending it. A **starting restore deletes any hold recorded by the
previous window**, in the same transaction that turns the flag on, so a second restore beginning
between the render and the click turns the click into *no_hold_recorded* (the refusal that means "a
restore is still running") rather than into an unfenced database.

Do **not** clear the `system_maintenance_mode` row by hand. It ends the window without scheduling the
re-check, so any callbacks refused during it are left to the WMS watchdog's days-scale alert. The
inbox action is the supported clear; the raw row exists only as a fallback if the hold record was
lost with the restore's rollback, in which case use the per-ASN **Re-check** button.

The backend check proves the restore backend has **detached**, not that the application is quiet —
step 1 is still yours.

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

Remote upload and delete actions apply to both the SQL backup and the `.manifest.json` sidecar. If a remote manifest upload fails after the SQL file uploaded, IMS attempts to delete the orphan SQL artifact and logs the cleanup result.

## Scheduled Backups

Automate your backup routine by enabling scheduled backups:

- **Enable/disable** the schedule
- **Retention days** — automatically delete backups older than this many days (whole number, minimum 1)
- **Max backup count** — limit the total number of backups kept on the server (whole number, minimum 1)
- **Auto-upload** — optionally upload each scheduled backup to S3 or SFTP automatically

Saving this panel rewrites the managed crontab. The enable switch is the same enablement the
**Database Backup** job uses in Settings → System → Scheduled Jobs, so the two screens cannot
disagree: whichever one you save writes both the scheduler's row (`cron_backup_enabled`) and the row
the backup route checks before it does any work (`backup_schedule_enabled`). Choose the *time* the
backup runs on the Scheduled Jobs page — this panel does not set it.

If the crontab cannot be written, the panel reports the values as saved and warns that the scheduler
is behind, rather than reporting a failed save over values that are stored. Recover with **Save &
Apply** on the Scheduled Jobs page.

## Cron Endpoint

Scheduled backups are triggered via a cron endpoint:

```
/api/cron/backup
```

Configure your server's cron scheduler to call this endpoint at your preferred time. Cron endpoints require the `CRON_SECRET` bearer header in production, and production startup fails fast if `CRON_SECRET` is unset, blank, or shorter than 32 characters. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. Rotating `CRON_SECRET` requires updating both `.env` and any external cron scheduler invocations in the same maintenance window because the application reads the environment value on restart. For example, to run backups daily at 02:00:

```
0 2 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/backup
```

## Activity Log

All backup operations — creation, restore, upload, deletion, and scheduled runs — are recorded in the system activity log for full auditability.
