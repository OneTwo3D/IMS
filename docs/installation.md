# Installation & Deployment

## Prerequisites

- **Operating system**: Debian 11/12 or Ubuntu 22.04/24.04 (tested in LXC containers)
- **Node.js**: Version 22 (installed automatically by the install script)
- **PostgreSQL**: Version 14 or later (installed automatically, or provide an external connection)
- **nginx**: Used as the reverse proxy (installed automatically)
- **Internet access**: Required during installation for downloading packages


## The Install Script

Run the installer as root:

```bash
bash scripts/install.sh
```

The script performs the following steps:

1. **Pre-flight checks** — verifies root access, detects the OS, and checks internet connectivity
2. **Installs Node.js 22** via NodeSource
3. **Installs and configures PostgreSQL** — creates the database and user
4. **Installs nginx**, `fail2ban`, and automatic security updates
5. **Installs runtime tooling** used by deployment and maintenance scripts
6. **Prompts for configuration** values (see below)
7. **Creates the app system user** (`imsapp`)
8. **Deploys the application** — clones from git or copies from a local directory
9. **Installs npm dependencies** and builds the Next.js application
10. **Runs database migrations** via Prisma
11. **Optionally seeds public URL, SMTP settings, and a default admin user**
12. **Configures a native systemd service** for the application
13. **Configures nginx** as a reverse proxy
14. **Enables fail2ban and unattended security updates**
15. **Sets up cron jobs** for scheduled tasks
16. **Prints a post-install summary** with next steps

For unattended installation, use `--non-interactive` and set configuration values as environment variables.
For full Proxmox + Cloudflare + OpenLiteSpeed tenant rollout, see [Automated Tenant Provisioning](tenant-provisioning.md).


## Configuration Prompts

The installer asks for the following values during setup. Press Enter to accept the default shown in brackets.

**Re-running the installer keeps what the previous run configured.** Every prompt whose value is
written to `.env` defaults to the value already there, so an upgrade run accepting the defaults
re-writes the same configuration rather than the factory one. That applies to `REDIS_URL` and its
credential, `REDIS_KEY_PREFIX`, and to `AUTH_SECRET`, `CRON_SECRET` and `SETTINGS_ENCRYPTION_KEY`,
which are generated on a first install and never re-minted afterwards — re-minting
`SETTINGS_ENCRYPTION_KEY` would make every encrypted Setting already in the database (Xero tokens,
connector secrets) permanently undecryptable. Supplying a value explicitly — at the prompt, or as an
environment variable under `--non-interactive` — still overrides the preserved one, so rotation works
as before. A preserved credential is never echoed as the prompt default: the URL is shown redacted and
a preserved password is shown as `[unchanged]`.

**A `.env` the installer cannot read is not a `.env` with no secrets.** Only a path with *nothing* at
all on it is a first install. If `${APP_DIR}/.env` exists but is a directory, a dangling symlink, or
a file this process cannot open or read to the end, the installer **stops** rather than minting fresh
secrets over a live database. The same applies to a `.env` that was read but is missing any of
`AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY` or `CRON_SECRET`: this installer writes all three on every
run, so a file missing one was truncated or hand-edited, and minting a replacement for
`SETTINGS_ENCRYPTION_KEY` is irreversible. Restore the missing line from your backup or from the
running service's environment — or, if this really is a fresh start and the existing data is
expendable, re-run with `IMS_INSTALL_REMINT_SECRETS=yes`, which mints them and says out loud what it
just destroyed.

Prompts NOT preserved across a re-run: the WooCommerce, Xero, Turnstile and SMTP values, and the
database prompts. Supply them again (or as environment variables) on an upgrade run, or the re-written
`.env` will blank them.

### Application
- **Domain name** — the hostname for your installation (e.g. `ims.yourdomain.com`)
- **Internal port** — the port the app listens on (default: `3000`)
- **Default admin name/email/password** — optional bootstrap admin user for unattended installs
- **Notification email** — optional recipient for the bootstrap credentials email

After installation, sign in and set the organisation base currency in **Settings > Company** before entering live transactional data. The base currency is intended to be set once for a new system. Changing it later requires a database reset.

### Database
- **Install PostgreSQL** — install on this server, or connect to an external database
- **Database name** (default: `one_two_inventory`)
- **Database user** (default: `imsuser`)
- **Database password** — auto-generated if not provided

### Redis
- **Install Redis on this server** — install and configure a local Redis, or point at one you already run
- **Redis URL** (default: `redis://localhost:6379`) — only asked when Redis is not installed here
- **Redis password** — leave blank if not required
- **Redis key prefix** — optional namespace for Redis-backed features

The password you enter is placed **inside `REDIS_URL`**, percent-encoded, and the `REDIS_PASSWORD`
line in `.env` is left empty. `REDIS_URL` is what the application authenticates with; a password that
reaches only `REDIS_PASSWORD` never reaches `AUTH`, and because the login rate-limit buckets fail
closed, a Redis answering `NOAUTH` does not look like a Redis fault — it looks like nobody can sign in.
This applies to both branches: a locally installed Redis, and a Redis you already run.

If the `REDIS_URL` you supply already carries a credential of its own, it is left exactly as you typed
it and a password entered at the prompt is ignored with a warning — the URL wins, and an operator's
connection string is never rewritten. "Already carries one" means an `@` in the **authority** — the
text between `://` and the first `/`, `?` or `#` — where an `@` can only be the userinfo separator. An
`@` further along, in a path or a query string, is none of the installer's business and does **not**
stop your password being placed in the URL.

If the authority is neither of those things — neither a `host[:port]` nor something carrying a
credential — the installer **stops**. That shape is what an unencoded `/` inside a password looks
like (`redis://:pa/ss@host:6379`, whose authority reads as `:pa`), and it cannot be told apart from a
malformed host: guessing one way splices a *second* credential in front of yours, and guessing the
other drops your password entirely. Percent-encode the password inside `REDIS_URL` (a `/` is `%2F`)
and leave the Redis password prompt blank, or give a plain `redis://host:port[/db]` and let the
installer place the password. The port, if present, must be numeric — that is what makes the two
readings distinguishable at all.

If you supply a password alongside a `REDIS_URL` with no `://` at all, the installer stops rather
than proceeding with a password it cannot place.

For a locally installed Redis, the same password is written to `/etc/redis/redis.conf` as a quoted
`\xHH` string literal, built from the same byte-by-byte walk as the URL encoding. `redis.conf` is
parsed by redis's own `sdssplitargs()`, which splits on whitespace and opens a quoted section on a
quote character anywhere in a token, so a password containing whitespace, a quote or a backslash cannot
be written into it literally — the server would either refuse to start or require different bytes than
the client sends.

### WooCommerce (Optional)
- Store URL, consumer key, consumer secret, webhook secret
- Can be configured later in Settings
- The store URL is a **seed**: the installer writes it into the `wc_url` setting once, and
  **Settings > Sync > Connection** owns it from then on. The three secrets are **overrides** —
  while they are set in `.env` they win over anything saved in the UI

### Xero (Optional)
- Client ID and client secret
- Can be configured later in Settings

### Outbound Email (Optional)
- SMTP host, port, username, password, transport security
- From name, from email, reply-to
- Required if you want the installer to email the generated login details automatically

### nginx & SSL
- **Configure nginx** — set up the reverse proxy (default: yes)
- **Enable SSL** — obtain a Let's Encrypt certificate via certbot


## Directory Structure

| Path | Purpose |
|---|---|
| `/opt/one-two-inventory` | Application root directory |
| `/opt/one-two-inventory/.env` | Environment configuration (chmod 600) |
| `/var/lib/one-two-inventory/backups` | Runtime backup storage directory used by backup create/restore/upload flows |
| `/var/lib/one-two-inventory/invoice-pdfs` | Accounting connector invoice PDFs served through signed invoice links |
| `/var/lib/one-two-inventory/uploads` | Private uploaded files served through authenticated routes, such as supplier invoice PDFs |
| `/var/lib/one-two-inventory/public-uploads/branding` | Logo and branding images served through `/api/uploads/branding/*` |
| `/var/lib/one-two-inventory/public-uploads/avatars` | User avatar images served through `/uploads/avatars/*` |
| `/var/lib/one-two-inventory` | Persistent data directory |
| `/var/log/one-two-inventory` | Application logs |

Container deployments must set `UPLOAD_STORAGE_DIR`,
`PUBLIC_UPLOAD_STORAGE_DIR`, and `INVOICE_PDF_STORAGE_DIR` to mounted
persistent volumes. If an upload storage variable is unset in production, IMS
logs a warning and falls back to local development paths under the application
working tree, which may be ephemeral in containers. Production preflight fails
when `INVOICE_PDF_STORAGE_DIR` is unset because signed invoice links depend on
persisted connector-downloaded PDFs.
Create `/var/lib/one-two-inventory/invoice-pdfs` during deployment with the same
owner as the IMS application process and restrictive permissions, for example
`chown app:app /var/lib/one-two-inventory/invoice-pdfs` and
`chmod 750 /var/lib/one-two-inventory/invoice-pdfs`. Connector PDFs are usually
re-fetchable from Xero or QuickBooks, so they do not need the same backup policy
as the database, but include the directory in operational snapshots if customer
invoice links must remain available during connector outages. Plan disk capacity
for roughly 50-500 KB per invoice PDF; 100,000 invoices can consume about
5-50 GB. Pre-release files under the old local `data/invoices` path are not
migrated by IMS because production installs are not live yet.
Customer-facing invoice buttons in shopping platforms do not receive reusable
IMS public PDF URLs. The shopping platform must first verify the logged-in
customer owns the order, then call IMS server-to-server with a short-lived
HMAC-signed request to `/api/shopping/{connector}/invoice-pdf`. For WooCommerce,
the bundled helper plugin adds the My Account button and signs that request with
a dedicated `WC_INVOICE_PDF_SECRET` value. Do not reuse `WC_WEBHOOK_SECRET`
for invoice PDF requests. The helper plugin also requires an admin-configured
HTTPS IMS base URL and constructs the fixed IMS invoice endpoint itself; IMS
only writes `_ims_invoice_pdf_available=yes` to the order, never a per-order URL
for the plugin to follow.
Branding upload URLs include a unique filename per upload so browser and CDN
caches do not depend on query-string cache keys. Avatar URLs preserve the
historical `/uploads/avatars/*` path and rotate a `?t=` cache-busting query
string on upload; configure any CDN in front of avatar assets to include query
strings in its cache key.

Invoice PDF scanning is disabled by default. Set `FILE_SCAN_MODE=command` and
`FILE_SCAN_COMMAND_ARGV='["clamdscan","--no-summary","--fdpass","{file}"]'` to
enable fail-closed scanning. IMS writes uploaded PDFs to
`$UPLOAD_STORAGE_DIR/quarantine/invoices`, runs the command against the
quarantined path, and moves the file to `$UPLOAD_STORAGE_DIR/invoices` only when
the scanner exits `0`. Exit `1` (signature match) rejects the upload as infected
(`400`); any other outcome — exit `2+`, spawn error, or timeout — fails closed
and rejects the upload as a scan failure (`503`). Rejected quarantine files are
deleted by default for disk hygiene; the activity log records scanner mode,
status, reason, exit code, signal, and scanner identifier without scanner output
or filesystem paths.

Use the ClamAV **daemon** client `clamdscan`, not the standalone `clamscan`.
`clamscan` reloads the full (~110 MB+) signature database on every invocation
(typically several seconds per scan), which can exceed the 5-second scanner
health-check budget and fail the preflight; `clamdscan` reuses the resident
`clamd` over its socket, so scans are effectively immediate. Pass `--fdpass` so
the IMS-spawned `clamdscan` opens the quarantine file (owned `0600` by the IMS
service user) and hands the descriptor to `clamd`, which otherwise runs as the
`clamav` user and could not read it by path. A full deployment and
operational-response runbook — install, signature updates, verification, and the
handling of infected / timeout / scanner-unavailable outcomes — is in
[docs/ops/invoice-pdf-malware-scanning.md](ops/invoice-pdf-malware-scanning.md).

Scanner commands run without a shell. Prefer `FILE_SCAN_COMMAND_ARGV` when an
argument contains spaces or empty values. The scanner process receives only the
environment variables listed in `FILE_SCAN_ENV_ALLOWLIST`, which defaults to
basic process/runtime variables such as `PATH` and `TMPDIR`; application secrets
such as `DATABASE_URL` and `AUTH_SECRET` are not inherited. The admin health
endpoint runs a short scanner smoke check in command mode so misconfigured
scanner commands are visible before the first invoice upload.

Before starting or rolling a production instance, run:

```bash
NODE_ENV=production npm run preflight:production
```

The preflight checks required secrets, production URLs, PostgreSQL URL shape,
explicit persistent storage paths, writable upload/backup directories, scanner
policy and command health, trusted proxy configuration when
`REQUIRE_TRUSTED_PROXY_CONFIG=true`, and database-restore kill switches. Set
`PREFLIGHT_DB_CONNECT=true` during production rollout when the preflight process
can reach Postgres; this adds a short `SELECT 1` connectivity probe. It prints
variable names and status messages only; it does not print secret values.


## Application Service Management

Current installs run the application as a native systemd service named
`one-two-inventory.service`. Older deployments may still have PM2 installed, but
PM2 is not the current process manager for new installs.

### Common Commands

```bash
# View process status
systemctl status one-two-inventory.service

# View live logs
journalctl -u one-two-inventory.service -f

# Restart the application
systemctl restart one-two-inventory.service

# Stop the application
systemctl stop one-two-inventory.service

# Start the application
systemctl start one-two-inventory.service
```

The service is configured with:
- Automatic restart on crash
- Logs available through journald
- Boot persistence through systemd


## Cron Jobs

Scheduled tasks are configured automatically:

| Time | Endpoint | Purpose |
|---|---|---|
| 00:30 | `/api/cron/product-lifecycle-archive` | Archive EOL products once all warehouse stock and incoming supply are depleted |
| 01:00 | `/api/cron/account-balance-snapshot` | Fetch previous-day Xero Trial Balance account balances for GL variance reporting |
| 02:00 | `/api/cron/backup` | Scheduled backup (if enabled in settings) with retention and remote upload |
| 03:00 | `/api/cron/activity-cleanup` | Purge activity log entries past their retention period |
| 04:00 | `/api/cron/wc-reconcile` | WooCommerce backup reconciliation for orders/products plus stock retry draining |
| Every 15 min | `/api/cron/delivery-status` | Poll delivery tracking providers for shipment status updates |
| Every 15 min | `/api/cron/wc-withdrawal-sweep` | Durable backstop: re-check WooCommerce orders refused as EU withdrawals, so one whose request was rejected back to a status the poll does not query is still imported. Also screens a rotating slice of already-pushed, dispatch-eligible orders against the storefront, so a withdrawal whose webhook was missed is known locally before the warehouse's despatch is reconciled |
| Every 15 min | `/api/cron/refund-reservation-release` | Durable backstop: re-run allocation to release stock reservations for refunded units when the immediate post-refund release was bypassed or lost |
| Every 5 min | `/api/cron/mintsoft-webhook-sweeper` | Drain persisted Mintsoft ASN booked-in webhook events; also drains the post-maintenance re-check marker (`wms_booked_in_recheck_due_since`) by re-checking every open ASN after a maintenance window closes |
| Every 15 min | `/api/cron/mintsoft-dispatch-sync` | Poll pushed Mintsoft orders for despatch and progress the IMS shipment + tracking |
| 06:00 | `/api/cron/fx-rates` | Fetch latest exchange rates from frankfurter.dev |

All cron jobs run under the `imsapp` user and call the application's API endpoints via `curl`. Cron endpoints require the `CRON_SECRET` bearer header in production, and production startup fails fast if `CRON_SECRET` is unset, blank, or shorter than 32 characters. Installer-generated crontab entries read only the `CRON_SECRET=` line from the protected `${APP_DIR}/.env` file at runtime so the cron secret is not embedded directly in the crontab and unrelated environment values are not shell-sourced. The in-app scheduler sync (Settings → System → Scheduler) prefers the runtime-read pattern too, but only selects it when a byte-for-byte emulation of the exact `grep | cut | tr` pipeline proves the app's `.env` yields the *active* process secret; every other case (no readable `.env`, a value that shell-parses differently, binary/`NUL` content, or an env supplied by the service manager and not the file) falls back to embedding the current literal, which is always correct at sync time. In runtime mode a secret rotation needs only the `.env` edit and a service restart — no crontab re-sync — and each job line carries a `[ -n "$CRON_SECRET" ]` guard so a missing file or empty extraction skips the request rather than sending an empty bearer. The generated cron log defaults to `/var/log/one-two-inventory/cron.log` (the installer-owned `LOG_DIR`, already covered by logrotate); override with `OTI_CRON_LOG_PATH`. The installer writes its bootstrap jobs inside the same OTI-marked managed block in this exact format, and on upgrade it removes every previous managed block (including whitespace- or CRLF-suffixed markers) and any legacy bootstrap lines that call `localhost:<app-port>/api/cron/`, while preserving the operator's own crontab entries — including unrelated `/api/cron/` calls to other hosts, a line that coincidentally matches the managed-job format but sits outside any managed block, and any operator lines after a malformed unclosed marker (never deleted to end-of-file; only the block's own remnants within that region are removed). So no duplicate or drifting One Two Inventory cron entries survive an upgrade. The first in-app scheduler save then replaces that block IN PLACE — at its original position among the operator's lines, so it never moves past an operator `PATH`, `SHELL`, or `CRON_TZ` assignment (which apply only to the jobs below them). `OTI_CRON_LOG_PATH` and the `.env` path are rejected if they contain a quote, `%`, or control character, and the embedded-literal fallback is rejected for a secret containing a quote, backslash, backtick, `$`, or newline (rotate to a hex/base64 secret) — so the crontab can never be corrupted by a crafted value. The scheduler page shows a warning banner when the managed block is missing, malformed, carries a stale embedded secret, has a runtime `.env` that no longer matches the running service, or when unmanaged `/api/cron/` lines exist outside the managed block. Rejected cron auth is also recorded (best-effort) as a WARNING activity (`cron_auth_rejected`), deferred off the 401 path and throttled to at most one per route per process per hour, so a stale secret surfaces instead of failing silently. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. After a valid cron secret, each cron endpoint is rate-limited per job and source IP when a client IP is available: daily/hourly jobs default to one accepted run per hour, 5-minute jobs allow 15 accepted runs per hour, and 15-minute jobs allow 6 accepted runs per hour. The sub-hourly quotas intentionally include scheduling-jitter headroom and should not be tightened to the exact cadence. Rate-limited calls return `429` with `Retry-After`. Single-process installs can use the default in-memory rate-limit backend. Multi-replica or load-balanced installs must set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so cron throttles are cluster-wide. Rotating `CRON_SECRET` requires updating both `.env` and any external cron scheduler invocations in the same maintenance window because the application reads the environment value on restart; if an old or leaked secret consumed cron quota, restart the memory backend or clear the Redis rate-limit keys rather than waiting for the one-hour window to expire.

For WooCommerce specifically:

- real-time order/product intake should come from webhooks
- `/api/cron/wc-reconcile` is the daily backup reconcile path for orders/products and also runs the stock catch-up plus queued retry drain
- the **Import order statuses** selection (Settings > Sync > WooCommerce) decides which orders IMS takes on. It governs every route that *fetches* orders — the one-off active-order import and the poll/reconcile sweeps, each of which turns the selection into a WooCommerce `?status=` query — and the order webhook, where it is applied as an **admission** rule: a pushed order IMS has never seen is imported only if it arrives in a selected status, and one that later moves into a selected status is imported by that update. An order IMS already holds is never gated, so it keeps following the store whatever status it moves to afterwards. Reconciliation additionally fetches `completed` so a finished order is never stranded, and the customer-withdrawal statuses are always included. An empty selection imports nothing, on every route. The Sync page states all of this next to the checkboxes

For Mintsoft specifically:

- accepted ASN booked-in webhooks return after persistence
- `/api/cron/mintsoft-webhook-sweeper` applies the pending stock and purchase-order effects asynchronously
- booked-in processing uses direct ASN lookup by default; `MINTSOFT_USE_BULK_ASN_LOOKUP=true` temporarily restores the legacy list-and-match path if Mintsoft endpoint discovery proves the direct path incompatible
- the sweeper drains up to `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` persisted events per run; the default is `250`
- the same sweeper also carries the **post-maintenance re-check**: when a maintenance window closes, `disableMaintenanceMode` stamps `wms_booked_in_recheck_due_since`, and the next sweeper run re-checks every open ASN (both purchase-order and stock-transfer, up to 100 per tick, oldest first) so callbacks the maintenance fence refused recover without an operator. The stamp is kept until a full pass completes. See [`mintsoft.md`](./mintsoft.md#maintenance-mode-fence-o3d-hl8l)
- `wms-watchdog` (hourly) is **enabled by default**: it is the days-scale backstop that alerts admins on an open ASN with no booked-in callback, and on a binding whose stock sync went quiet
- `/api/cron/mintsoft-dispatch-sync` polls already-pushed orders (`WmsOrderPushLink.state` in `SYNCED`/`MERGED`, not yet shipped) for a despatched status and feeds the despatch into the IMS shipment via `applyExternalFulfillmentUpdate`, carrying the Mintsoft tracking number/courier through to the shipment + customer notifications; it is idempotent (a dispatched order leaves the poll set once reconciled to SHIPPED). It also handles:
  - **Split orders** — when Mintsoft splits an order into parts, each despatched part is pushed to the storefront as a partial shipment (via the onetwoInventory Helper plugin) and the IMS order is marked SHIPPED only once every part has despatched.
  - **Merged orders** — when Mintsoft merges an order into a survivor (combined `a+b` OrderNumber), the push link is repointed to the survivor and parked `MERGED` (so the order-push sweep no longer amends it), then reconciled. A merged-and-split survivor is completed atomically without per-part partial shipments (its parts mix several original orders).
- for a **storefront** order this also closes the customer-tracking loop end to end: the SHIPPED transition runs `pushOrderDeliveryMetadata` → `pushImsTrackingToWc`, writing the tracking into WooCommerce's `_wc_shipment_tracking_items` meta, so WooCommerce emails the customer their tracking (no separate IMS dispatch email is sent, to avoid double-emailing). Direct/non-storefront orders have no dispatch email yet — see issue `q66in.1.6`

Connector network requirements:

- WooCommerce and Mintsoft base URLs must use public HTTPS endpoints in normal operation.
- IMS rejects connector URLs that directly target localhost, loopback, RFC1918/private, link-local, multicast, or cloud metadata addresses. Local HTTP loopback URLs are accepted only for E2E tests with `E2E_TEST_MODE=1`, and this allowance is ignored when `NODE_ENV=production`.
- Connector HTTP requests validate DNS lookup results at connection time so a public-looking hostname cannot resolve or rebind to a blocked address.
- Connector redirects are followed only through the validated connector HTTP client. Every redirect hop is URL-validated and DNS-validated before connection, with sensitive headers stripped when the redirect crosses origins.
- Internal connector deployments behind a VPN should preferably be exposed to IMS through a public DNS name and public-routable gateway. If a private-IP connector target is unavoidable, set `CONNECTOR_PRIVATE_IP_ALLOWLIST` to a comma-separated list of exact IPs or CIDR ranges, for example `10.0.0.5,192.168.10.0/24`.
- The private-IP allow-list is intentionally narrow: it applies only to RFC1918 IPv4 or ULA IPv6 literal/DNS-resolved addresses, not `localhost`, loopback, link-local, metadata, multicast, credentials in URLs, fragments, query-string base URLs, or non-HTTPS production connector URLs.

Authentication note:

- login and TOTP throttling are currently in-process only
- this deployment assumes a single application instance/LXC
- if you add a second web instance or separate worker handling auth routes, move rate limiting to shared storage such as Redis before doing so
- if you deploy behind OpenLiteSpeed or another upstream proxy, strip/replace incoming `X-Forwarded-For` before proxying to the app tier
- set `TRUSTED_PROXY_IPS` / `TRUSTED_PROXY_CIDRS` so the app can walk the forwarded chain from right to left and ignore internal proxy hops
- set `REQUIRE_TRUSTED_PROXY_CONFIG=true` so `npm run preflight:production`
  fails if trusted proxy entries are missing on a proxied production deploy


## Production Readiness Checklist

Before declaring a deployment production-ready, work through this checklist. Each item maps to a real failure mode the system has hit before.

### Environment

- [ ] `NEXT_PUBLIC_APP_URL` set to the production URL (no trailing slash).
- [ ] `AUTH_SECRET`, `AUTH_URL` set; `AUTH_URL` matches the public URL.
- [ ] `CRON_SECRET` is set and is a strong random value (32+ chars). The system fails fast on startup if this is unset in production.
- [ ] `DATABASE_URL` points at the production database; verified by `npx prisma migrate status`.
- [ ] `SETTINGS_ENCRYPTION_KEY` set and backed up off-server (rotation procedure documented).
- [ ] If multi-replica: `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` set.

### Cron jobs

Verify each scheduled job is registered with your cron daemon and has run successfully at least once:

- [ ] `/api/cron/fx-rates` — daily
- [ ] `/api/cron/wc-reconcile` — daily (if WooCommerce connected)
- [ ] `/api/cron/accounting-daily-batch` — daily at midnight (if Xero connected)
- [ ] `/api/cron/accounting-sync` — every 5 min (if accounting connected)
- [ ] `/api/cron/accounting-payment-poll` — every 15 min (if accounting connected)
- [ ] `/api/cron/accounting-fx-revaluation` — daily (if accounting connected)
- [ ] `/api/cron/account-balance-snapshot` — daily (if accounting connected)
- [ ] `/api/cron/delivery-status` — every 15 min (if delivery tracking enabled)
- [ ] `/api/cron/backup` — daily, off-peak window
- [ ] `/api/cron/invariant-check` — daily
- [ ] `/api/cron/product-lifecycle-archive` — daily

Each cron endpoint requires `Authorization: Bearer ${CRON_SECRET}` in the request. The system's per-route rate-limit quotas have headroom for jitter but not double-frequency abuse — verify your cron daemon doesn't retry aggressively.

### Backup & restore

- [ ] Backup cron schedule confirmed (`/api/cron/backup` daily).
- [ ] Remote upload (S3 or SFTP) configured under Settings > Backup. Local-only backups are vulnerable to the same incident that takes down the application server.
- [ ] Restore round-trip tested on a staging environment — confirm the manifest validation passes and the database is functional after restore.
- [ ] `DATABASE_RESTORE_MAX_FILE_BYTES` raised if your typical backup exceeds 50MB.

### Integrations

For each connected integration (WooCommerce, Xero, Shopify, QuickBooks, Mintsoft):

- [ ] Credentials configured.
- [ ] **Connection test passes** — the connection test gate blocks sync until you click "Test Connection" successfully. Verify by visiting Sync > {Integration} and looking for the green "Connected" badge.
- [ ] Sync enabled.
- [ ] Sync Log shows recent successful runs.

For WooCommerce specifically:

- [ ] OneTwoInventory Helper plugin installed in WordPress with matching shared secret.
- [ ] Webhook endpoints registered (use Setup Webhooks button).
- [ ] Initial order import completed (one-time, gates ongoing sync).
- [ ] Tax rate mappings imported and reviewed (Sync > WooCommerce > Tax Rates).

### Security

- [ ] Admin user has 2FA enabled (TOTP or passkey).
- [ ] Default passwords changed; password policy is enforced (12 chars + uppercase + number + symbol + not in common-password list).
- [ ] HTTPS only — no HTTP fallback.
- [ ] `INVOICE_PDF_TOKEN_TTL_SECONDS` set to a sensible value for your operator workflow (code default 10 minutes; the example 3-day value is reasonable for internal operator workflows; lower for high-security tenants).
- [ ] `INVOICE_PDF_TOKEN_MAX_TTL_SECONDS` left at or below the 30-day hard cap, or lowered for stricter tenants.
- [ ] Activity log redaction confirmed (Settings > System > Activity Log shows `[REDACTED]` placeholders, not raw secrets).

### Monitoring

- [ ] System Health page (Settings > System > Health) shows green for FX sync, accounting sync, integration outbox, and recent cron runs.
- [ ] Email notifications working — admin recipients receive critical-finding notifications from the invariant check cron.
- [ ] Application logs are being collected (stdout/journald → your log aggregator).


## Updating

To update to a newer version:

```bash
cd /opt/one-two-inventory

# Preferred: run the bundled update script
bash scripts/update.sh
```

Manual equivalent:

```bash
cd /opt/one-two-inventory

# Replace <deployed-branch> with the branch this instance tracks
git fetch origin
git reset --hard origin/<deployed-branch>

# Install dependencies
npm ci --omit=dev

# Run database migrations
npx prisma generate --schema prisma/schema.prisma
npx prisma migrate deploy --schema prisma/schema.prisma

# Rebuild
npm run build

# Restart
systemctl restart one-two-inventory.service
```


## Environment Variables Reference

Key variables in the `.env` file:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Public URL of the application (e.g. `https://ims.yourdomain.com`) |
| `NODE_ENV` | Set to `production` for deployment |
| `AUTH_SECRET` | Secret key for signing session tokens (auto-generated) |
| `INVOICE_PDF_TOKEN_TTL_SECONDS` | Lifetime for IMS-session signed invoice PDF download links. Default `600` (10 minutes). Links are bound to the current IMS session and client IP, so customer-facing shopping downloads use `/api/shopping/{connector}/invoice-pdf` via the shopping platform instead. |
| `INVOICE_PDF_TOKEN_MAX_TTL_SECONDS` | Maximum accepted IMS-session invoice PDF token lifetime. Default and hard cap `2592000` (30 days). Lower this for stricter tenants; raise `INVOICE_PDF_TOKEN_TTL_SECONDS` only up to this cap. |
| `RATE_LIMIT_BACKEND` | Backend for rate-limit counters (cron quotas, login throttle, etc.). `memory` (default) keeps counters per-process. For multi-replica deployments, set `redis` and configure `REDIS_URL` so the limits are shared across replicas. |
| `DATABASE_RESTORE_MAX_FILE_BYTES` | Maximum size of database restore upload in bytes. Default `52428800` (50MB). Raise for tenants with larger backups; the server also performs a disk-space preflight before accepting the upload. |
| `XERO_DAILY_BATCH_LIMIT` | Maximum entities per group per daily batch run. Default `1000`, hard cap `5000`. Larger tenants whose daily volume exceeds the cap get multiple deterministic-reference journals per date. |
| `WC_PENDING_FX_ORDER_NOTIFY_THRESHOLD` | When the WooCommerce pending-FX retry queue reaches this depth, notify active admins. Default `5`. The queue accumulates when WC orders arrive in a currency without a stored FX rate; it drains automatically after the next FX-rate refresh. |
| `BD_GIT_HOOK` / `BEADS_HOOK_TIMEOUT` | Beads (bd) integration hook settings, used only when bd issue tracking is enabled in the working tree. Not required for runtime. |
| `IMS_INSTANCE_ROLE` | What this deployment **is**: `production`, `stage`, `development` or `e2e`. `NODE_ENV` cannot answer this — it is set by the build, so `next start` reports `production` on a stage server, a second production-shaped copy and the end-to-end rig alike, and controls that exempt production therefore exempt all of them (o3d-l89a). Set it on **every** instance. Production preflight warns while it is absent and fails when it is present and says anything other than `production` (or when `E2E_TEST_MODE=1` contradicts it). Absence currently falls back to the old `NODE_ENV`/`E2E_TEST_MODE` reading; once production carries the line, absence becomes non-production everywhere. |
| `INVOICE_PDF_STORAGE_DIR` | Persistent storage directory for connector-downloaded invoice PDFs served through signed links. Defaults locally to `./data/invoices`; required by production preflight. Relative paths resolve against the process working directory, so production values should be absolute |
| `SETTINGS_ENCRYPTION_KEY` | 32-byte raw key, or base64 value that decodes to 32 bytes, used to encrypt sensitive Setting values stored in the database (auto-generated) |
| `ENCRYPTION_KEY` | Legacy fallback for older installs; if needed during migration, it must also be a 32-byte raw key or base64 value that decodes to 32 bytes |
| `AUTH_URL` | Authentication callback URL (same as app URL) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PREFLIGHT_DB_CONNECT` | Optional production preflight database connectivity probe. Set `true` during rollout when the preflight process can reach Postgres; default `false` for build-only CI jobs |
| `REDIS_URL` | Redis connection URL, and the canonical place a Redis credential lives: `redis://:PASSWORD@host:port/db` (percent-encode the password). It is what the client connects with, and it is the only form that can express a Redis 6 ACL username. `scripts/install.sh` writes it this way for BOTH a locally provisioned Redis and one you already run, and leaves `REDIS_PASSWORD` empty when it does |
| `REDIS_PASSWORD` | Compatibility fallback, used only when `REDIS_URL` carries no credential of its own — for hosts whose URL predates the rule above. Set one or the other, not both: two different values are a configuration error and are refused rather than resolved by precedence. A Redis that answers `NOAUTH` does not look like a Redis fault, because the login rate-limit buckets fail closed — it looks like nobody can sign in |
| `REDIS_KEY_PREFIX` | Optional Redis namespace prefix for tenant- or instance-scoped keys |
| `WC_STORE_URL` | WooCommerce store URL. Install-time seed only: `scripts/provision-instance.mjs` writes it into the `wc_url` setting on a fresh install (insert-only) and it never overrides the value saved in **Settings > Sync > Connection** |
| `WC_CONSUMER_KEY` | WooCommerce API consumer key. Install-time seed only — the live value is the `wc_consumer_key` setting |
| `WC_CONSUMER_SECRET` | WooCommerce API consumer secret. Install-time seed only — the live value is the `wc_consumer_secret` setting |
| `WC_WEBHOOK_SECRET` | Secret for verifying WooCommerce webhooks and WooCommerce helper-plugin FX pushes |
| `WC_INVOICE_PDF_SECRET` | Separate secret used only by the WooCommerce helper plugin to sign customer-visible invoice PDF proxy requests to IMS |
| `SHOPIFY_INVOICE_PDF_SECRET` | Separate secret used only for Shopify customer-visible invoice PDF proxy requests to IMS |
| `MINTSOFT_USE_BULK_ASN_LOOKUP` | Temporary rollback flag for Mintsoft ASN booked-in processing. Default `false` uses direct ASN lookup; set `true` only if the Mintsoft direct ASN endpoint fails in staging/production. |
| `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` | Maximum pending Mintsoft ASN booked-in webhook events processed by one sweeper run. Default `250`. |
| `CONNECTOR_FETCH_TIMEOUT_MS` | Default whole-request timeout for validated connector HTTP requests, including redirects and composed with any caller-supplied `AbortSignal`. Invalid values fall back to `30000`. |
| `CONNECTOR_FETCH_MAX_RESPONSE_BYTES` | Maximum response body bytes buffered by the validated connector HTTP client. This does not limit request bodies. Invalid values fall back to `10485760` (10 MiB). |
| `OUTBOX_RETRY_BASE_MS` | Base delay for retryable IntegrationOutbox failures. Default `300000` (5 minutes). |
| `OUTBOX_RETRY_MAX_MS` | Maximum delay cap for retryable IntegrationOutbox failures. Default `3600000` (1 hour). |
| `OUTBOX_RETRY_JITTER_MS` | Maximum tail jitter added to retryable IntegrationOutbox failures. Default `30000` (30 seconds); a 5% base-delay floor applies even when set to `0`. |
| `XERO_TENANT_ID` | **Deprecated** single-organisation form of `XERO_ALLOWED_TENANT_IDS`, kept because it was documented for years while nothing read it — an operator who set it believed the tenant was pinned and was not protected. It is now enforced identically. Prefer `XERO_ALLOWED_TENANT_IDS`; setting both to different values refuses every Xero connection rather than preferring one. It is **not** auto-populated after OAuth. |
| `XERO_ALLOWED_TENANT_IDS` | Comma-separated allow-list of Xero tenant ids (organisation ids) this instance may connect to — the only key that can **allow** an organisation. Blank/absent means unrestricted. When set, a consent offering no allowed organisation is refused at the callback with nothing stored, and a stored token for a disallowed organisation halts every Xero sync. Requires a restart. |
| `XERO_BLOCKED_TENANT_IDS` | Comma-separated tenant ids this instance may **never** use, applied before every other check, at the callback and on every use of the stored token. The maintenance-free control for a test rig: block the live organisation's id (which never changes) instead of allow-listing a test organisation whose id is re-issued when it is re-created. Listing the same id here and on the allow-list is refused as a contradiction rather than resolved silently. |
| `XERO_REQUIRE_DEMO_ORG` | `true`/`false` (default false). When true, this instance may only connect to — and only keep a stored token for — a Xero **demo** organisation, proven from Xero's own `IsDemoCompany` flag on `GET /Organisation`. It costs no extra API call (the callback already reads that endpoint) and is the right control for a test rig: a deny-list refuses only the organisations someone remembered to list, so a third organisation still passes, while an id allow-list has to be re-edited every time the Demo company is re-created with a new tenantId. Enforced at the callback and on every use of the stored token, so a production database restored onto a rig is halted; a stored token whose demo status was never recorded counts as **unverified** and is refused until the connection is re-consented. A value that is neither yes nor no refuses every Xero connection rather than silently meaning off. Requires a restart. |
| `XERO_ALLOWED_TENANT_IDS` / `XERO_BLOCKED_TENANT_IDS` / `XERO_REQUIRE_DEMO_ORG` (any one) | **Required on a non-production instance.** An instance where `NODE_ENV` is not `production` (including absent) or `E2E_TEST_MODE=1` refuses to connect to Xero, and refuses to use a stored Xero token, until one of these three is set — "nothing is configured" is the state that let the e2e rig invoice into the live organisation, so it may not read as "any ledger is allowed". `XERO_ALLOWED_TENANT_NAMES` does **not** satisfy it (a rename defeats a name check). Production is exempt; a production server that hits this refusal should set `NODE_ENV=production` rather than a weaker guard. There is deliberately no key that disables it. |
| `XERO_ALLOWED_TENANT_NAMES` | Organisation names that **narrow** `XERO_ALLOWED_TENANT_IDS`, matched case-insensitively. It is *not* a union and *not* an identity: a Xero organisation name is neither unique nor fixed, so a name can never admit an organisation the id list excludes, a name matching two organisations on one consent is refused rather than used to pick one, and a configuration whose only tenant control is a name is recorded in the activity log as weaker than it looks. An organisation whose name contains a comma cannot be expressed here at all. Set an **id-based** control on every non-production instance — env is the only tenant control that survives a database reset. |
| `BACKUP_DIR` | Local backup storage directory |
| `ALLOW_DATABASE_RESTORE` | Production restore kill switch; leave `false` except during a supervised restore window |
| `ALLOW_DATABASE_RESTORE_UPLOAD` | Additional kill switch for uploaded SQL restore files; leave `false` except during a supervised restore window |
| `DATABASE_RESTORE_MAX_FILE_BYTES` | Maximum uploaded SQL restore file size in bytes. Defaults to `52428800` (50 MiB); uploaded restores also require the matching `.manifest.json` sidecar. |
| `UPLOAD_STORAGE_DIR` | Persistent private upload root. Defaults locally to `./uploads` when unset |
| `PUBLIC_UPLOAD_STORAGE_DIR` | Persistent branding/avatar upload root. Defaults locally to `./public/uploads` when unset |
| `FILE_SCAN_MODE` | Invoice PDF scan mode: `disabled` or `command` |
| `FILE_SCAN_COMMAND_ARGV` | Preferred JSON argv scanner command when `FILE_SCAN_MODE=command`; include `{file}` or IMS appends the quarantined PDF path |
| `FILE_SCAN_COMMAND` | Shell-like scanner command fallback when `FILE_SCAN_MODE=command`; run without a shell |
| `FILE_SCAN_NAME` | Optional stable scanner identifier stored in audit metadata; defaults to a short hash of the configured command |
| `FILE_SCAN_ENV_ALLOWLIST` | Comma-separated environment variables inherited by the scanner process |
| `FILE_SCAN_TIMEOUT_MS` | Scan command timeout in milliseconds (default: `30000`; raise for large PDFs or busy scanners) |
| `CRON_SECRET` | Shared secret for authenticating cron endpoint requests; production requires at least 32 characters |
| `XERO_DAILY_BATCH_LIMIT` | Maximum candidate rows processed by each Xero daily-batch group per run; defaults to 1000 and clamps above 5000 |
| `RATE_LIMIT_BACKEND` | Rate-limit backend for login/TOTP and cron throttles; use `memory` only for single-process installs and `redis` for cluster-wide limits |
| `REDIS_URL` | Redis connection string required when `RATE_LIMIT_BACKEND=redis` |
| `REQUIRE_TRUSTED_PROXY_CONFIG` | Set to `true` on proxied production deployments so preflight fails when `TRUSTED_PROXY_IPS` / `TRUSTED_PROXY_CIDRS` are empty |
| `INVARIANT_CHECK_PAGE_SIZE` | Optional page size for the scheduled invariant check inventory SQL collector. Default `500`; raise temporarily only for production triage. |
| `INVARIANT_CHECK_MAX_FINDINGS` | Optional maximum inventory invariant findings collected by the scheduled invariant check. Default `5000`; when the cap is hit, the report adds a critical truncation finding. |
| `SMTP_HOST` | SMTP server hostname. Install-time seed only - see below |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP authentication username |
| `SMTP_PASS` | SMTP authentication password |
| `SMTP_FROM_EMAIL` | From address on outgoing mail |
| `SMTP_FROM_NAME` | From name on outgoing mail |
| `SMTP_SECURE` | Encryption: `tls`, `ssl` or `none` |
| `SMTP_REPLY_TO` | Reply-to address on outgoing mail |

The `SMTP_*` variables are an **install-time seed only**. `scripts/provision-instance.mjs` reads
them once and writes them into the `settings` table (`email_smtp_*`); at runtime `lib/mailer.ts`
reads those settings and never the environment. Mail cannot be managed by env - change it in
**Settings > Email**. Xero OAuth client credentials, the base currency, PDF/upload temp
directories and the upload size cap are likewise not environment variables; see `CLAUDE.md` for
where each of those actually lives (o3d-esha).

IMS-session invoice PDF links intentionally bind to the current session and client IP. This limits copied-link replay, but users who switch networks, reconnect a VPN, or resume a tab after their IP changes may need to return to the invoice page and request a fresh link. Customer-facing shopping invoice downloads avoid this IMS session/IP binding by using the shopping platform ownership check plus the short-lived `/api/shopping/{connector}/invoice-pdf` server-to-server handoff.

### Settings Encryption Key Rotation

Sensitive connector settings are stored as AES-256-GCM ciphertext when `SETTINGS_ENCRYPTION_KEY` is configured. The key must be exactly 32 raw bytes, or a base64 value that decodes to 32 bytes; ad-hoc strings are rejected rather than hashed into fallback keys. Current Setting-table ciphertexts use the `enc:setting:v1:` prefix and are authenticated against the setting key, so a ciphertext copied from one setting cannot be replayed into another setting. Existing plaintext settings remain readable and are lazily rewritten in encrypted form when read or saved. Older `enc:v1` values encrypted with `ENCRYPTION_KEY` also remain readable while that legacy fallback is set, but `ENCRYPTION_KEY` must follow the same 32-byte key-shape rule. If an existing install ever used an ad-hoc legacy key, follow `docs/encryption-key-migration.md` before deploying a strict key-shape build.

Run a one-shot migration after deploying the key to avoid waiting for low-traffic settings to be read:

```bash
npm run cli -- migrate-encrypted-settings
```

Environment variables for connector secrets take precedence over database settings — for the connectors that still have an environment fallback (`WC_WEBHOOK_SECRET`, `WC_INVOICE_PDF_SECRET`, the Mintsoft credentials). When such a variable is non-empty, the connector uses that value even if an operator saves a different value in the UI. Clear the environment variable and restart the app to use the database value. The connector settings UI shows a warning banner when an environment override is active.

`WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` are **not** in that group. They are install-time **seeds**: `scripts/provision-instance.mjs` writes them into the settings table only if no value is there yet, and Settings → Sync → WooCommerce → Connection owns them from then on. Editing them in `.env` after installation changes nothing — rotate the credential in the UI. (Environment precedence was removed because it was only half applied: the order import followed the environment while the stock and product syncs followed the database, so a stale `.env` secret made one installation talk to WooCommerce under two different credentials.)

`WC_STORE_URL` is never read at runtime either. The live store URL is always the `wc_url` setting, entered in Settings → Sync → WooCommerce → Connection; `WC_STORE_URL` seeds that row once on a fresh install and nothing reads it afterwards. If the credentials are stored but no store URL is, the installer says so and the connector cannot reach the store until the URL is entered.
`WC_STORE_URL` is not one of them either, and for the same reason with more force: the installer writes it into every `.env`, so making it an override would repoint an installation that had since been moved to a different store back to the old one on its next upgrade — and only part of the code resolves `wc_url` through the settings store, so order import and stock push would end up targeting different shops. It seeds the setting once at install time instead (`scripts/provision-instance.mjs`, insert-only).

To rotate from the legacy global key to the settings key, first deploy with both the old key as `ENCRYPTION_KEY` and the new key as `SETTINGS_ENCRYPTION_KEY`, then run `npm run cli -- migrate-encrypted-settings` or save each connector settings page so sensitive values are rewritten as `enc:setting:v1:` with the new key. After confirming no `enc:v1` values remain in the `settings` table, remove the legacy `ENCRYPTION_KEY`.

This release supports one active `SETTINGS_ENCRYPTION_KEY` plus the legacy `ENCRYPTION_KEY` fallback. It does not yet support a multi-key map for zero-downtime rotations between two settings keys; that is tracked in the follow-up plan.

Rollback note: application versions before this feature cannot read `enc:setting:v1:` values. Rolling back past this change requires either keeping this code deployed until the old version is no longer needed, or manually decrypting and rewriting affected rows to plaintext or legacy `enc:v1` before rollback.

## Base Currency

One Two Inventory stores foreign-currency transaction values alongside converted values in the organisation's base currency.

- Set the base currency once in **Settings > Company** during initial setup
- After transactional data exists, changing the base currency is blocked in the UI
- To use a different base currency later, reset the database and configure the system again from a clean state
- Base-currency amounts throughout the UI use the configured currency's symbol and symbol position, so currencies that render as prefixes or suffixes display correctly

If you use external connectors:

- **WooCommerce** may accept orders in many transaction currencies, but the store's configured currency must match the IMS base currency before the shopping connector can be enabled
- **Xero** must use the same organisation base currency as the IMS before the accounting connector can be authorised or enabled


## Reverse Proxy

The installer generates an nginx configuration at `/etc/nginx/sites-available/one-two-inventory` with:

- Upstream connection to the Next.js process on the configured port
- WebSocket support for hot-reload (development) and real-time features
- Security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy)
- Additional hardening headers (Permissions-Policy, COOP, CORP) and `server_tokens off`
- Client upload limit of 20 MB
- Extended timeouts for long-running requests (PDF generation, imports)
- Dedicated location block for webhook endpoints

## Host Security

The installer also applies low-risk host hardening:

- **fail2ban** enabled for `sshd` and, when nginx is configured, nginx auth/bad-bot jails
- **unattended-upgrades** enabled for security and updates repositories
- Existing active **ufw** setups are updated to allow ports `80` and `443`


## SSL

When SSL is enabled during installation, the script:

1. Installs **certbot** with the nginx plugin
2. Obtains a Let's Encrypt certificate for your domain
3. Configures automatic HTTPS redirect
4. Certbot handles automatic certificate renewal

To enable SSL after installation:

```bash
certbot --nginx -d ims.yourdomain.com
```
