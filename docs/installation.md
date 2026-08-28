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

### Re-running the installer over an existing installation

This is supported and expected — the installer reads back the `.env` a previous run wrote, preserves
the secrets it cannot re-mint (`SETTINGS_ENCRYPTION_KEY`, `AUTH_SECRET`, `CRON_SECRET`) and keeps a
working `REDIS_URL`. Because it is an upgrade entrypoint, it applies **the same cutover sequence as
`scripts/deploy.sh` and `scripts/update.sh`** (o3d-2sm1.3).

**What counts as an existing installation** (o3d-2sm1.4): the `one-two-inventory.service` unit
*file* (not `is-active` — a stopped service still has a crontab, a database and a schema), an active
crontab line, **a legacy PM2 installation** (a `pm2-<user>` unit, an `${APP_DIR}/.pm2` home, or the
app registered with a PM2 daemon), or **any node process whose working directory is the app
directory**. Detecting only the new unit meant a PM2-run installation — which this script explicitly
supports and removes — was never recognised, so nothing was fenced, nothing was stopped, and the
migration ran with the old binary live. PM2 is now stopped, disabled and deleted, and stray
app-directory processes are terminated (`SIGTERM`, then `SIGKILL`), **before** the migration rather
than after it.

When it finds one it:

1. refuses immediately unless the migration window can be fenced (see
   [the connection fence](#deploy-order-and-what-happens-on-a-rollback)), and adopts any cutover
   fence a previous run left standing;
2. installs and **verifies** the reboot-fence drop-in, before anything is stopped;
3. stops the service **and every legacy launcher**, fences the crontab, waits for the port, revokes
   `CONNECT` for the window and proves nothing else is connected;
4. migrates, checks for drift, and runs the migrations' own `verify.sql` checks;
5. seeds, bootstraps and builds — all through the connection that survives the fence;
6. releases the connection fence, lifts the reboot fence, starts the service, and only then restores
   the crontab, before the managed cron block is spliced back in.

On a failure after the stop it leaves the service **stopped and fenced** and never restarts it, on
exactly the same terms as the deploy scripts — see [Deploy order](#deploy-order-and-what-happens-on-a-rollback).
It previously migrated with the old service and the old cron writers live, which is the defect that
order exists to remove. A **first** install fences nothing, deliberately: there is no service, no
crontab and no data, so there is no writer to stop.


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
- the **Import order statuses** selection (Settings > Sync > WooCommerce) decides which orders IMS takes on. It governs every route that *fetches* orders — the one-off active-order import and the poll/reconcile sweeps, each of which turns the selection into a WooCommerce `?status=` query — and **every route that receives an order without asking for a status**: the order webhook, the withdrawal-recovery sweep and the pending-FX retry queue. Those are gated inside the importer itself, at the read that decides create-versus-update, so a new ingress path is gated by default rather than when someone remembers to add the check. It is an **admission** rule: an order IMS has never seen is created only if it arrives in a selected status, and one that later moves into a selected status is imported by that update. An order IMS already holds is never gated, so it keeps following the store whatever status it moves to afterwards. Reconciliation additionally fetches `completed` so a finished order is never stranded, and the customer-withdrawal statuses are always included. An empty selection imports nothing, on every route. IMS also declines to create an order whose WooCommerce status it has no reading of — no status-mapping row and not one of WooCommerce's own statuses — rather than inventing `PROCESSING` for it, which used to allocate stock and queue an invoice off a status nothing had defined. **A refused order is never lost.** Each refusal writes a durable row naming the order id, and `/api/cron/wc-withdrawal-sweep` re-reads those orders by id every 15 minutes and puts them back through the same gate, so an order is imported as soon as you tick its status or add its mapping — with no dependence on WooCommerce ever pushing it again (the delivery was acknowledged, so it will not) or on a sweep cursor still reaching back to it. Widening the selection additionally rewinds the poll/reconcile cursor to the earliest order the selection had turned away, which imports a whole excluded status in one sweep instead of one by-id read at a time (logged as `wc_order_sync_cursor_rewound`; the by-id drain logs `wc_order_admission_refusal_drained`). The Sync page states all of this next to the checkboxes

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

**There is no manual equivalent, and this document deliberately no longer offers one.**

Until o3d-2sm1.5 it did: a copy-pasteable block that fetched, built, wrote a `DEPLOY-FENCED`
marker, stopped the service and invoked Prisma. It read like the scripts and it was not the
scripts, and the three things it could not carry are each exactly the failure the cutover
exists to prevent.

* **It published `schema_touched=false` and then migrated.** The marker was written once,
  complete, *before* `prisma migrate deploy` — so a Prisma failure, an OOM kill or a power cut
  mid-migration left a **complete** marker on disk asserting the schema had not moved. The
  next entrypoint adopts that marker, believes it, and **releases the connection fence over a
  half-migrated schema**. `mark_schema_touched()` exists to publish `schema_touched=true`
  *before* Prisma is invoked, and to refuse the migration if that cannot be made durable.
  No hand-typed sequence did either.
* **Its cron fence was a comment.** `# then comment the jobs out` is not a command. An
  operator following the block literally left every cron writer running across the migration,
  which is the second half of "stop and drain every writer".
* **Nothing it wrote was durable.** `printf > file` is neither atomic nor flushed. The scripts
  publish through `publish_durable_file()`: a temporary in the same directory, an `fsync` of
  the data, the `rename`, an `fsync` of the parent directory, and a `marker_complete=1`
  sentinel written last so a reader can tell a whole marker from a torn one. A shell
  redirection has none of that, and a reboot can find an empty marker, the previous one, or no
  marker at all.

The three entrypoints — `scripts/install.sh`, `scripts/update.sh`, `scripts/deploy.sh` — share
one cutover namespace, one lock and one state machine, so a fence left standing by any of them
is adopted by any other. **If an update fails, re-run one of those scripts; do not hand-roll
the sequence.** The failure banner names the marker, the fences that are standing and the
command that releases each, and the next run adopts what the failed one left behind.

To see what a run would do without doing it, `bash scripts/update.sh --dry-run` prints the
whole plan and changes nothing (and works unprivileged); `bash scripts/deploy.sh --dry-run`
does the same for a deploy.

### Deploy order, and what happens on a rollback

The order is:

```
build -> validate -> STOP AND DRAIN EVERY WRITER -> migrate -> verify -> start -> health
```

`scripts/update.sh`, `scripts/deploy.sh` **and `scripts/install.sh`'s upgrade cutover** implement
exactly that, and `tests/scripts/deploy-order.test.ts` fails if the steps are reordered.

### One cutover namespace

All three entrypoints read and write the same four paths, so a fence left standing by any one
of them is adopted by any other — which is what the failure banners have always told operators
to do:

| what | path |
| --- | --- |
| cutover marker | `/var/lib/one-two-inventory/DEPLOY-FENCED` |
| crontab backup | `/var/lib/one-two-inventory/crontab-<service user>.bak` |
| connection-fence state | `/var/lib/one-two-inventory/deploy/db-connect-fence.json` |
| cutover lock | `/var/lib/one-two-inventory/cutover.lock` |

Set `IMS_CUTOVER_STATE_DIR` to move all four together; `IMS_DEPLOY_STATE_DIR` and
`IMS_DATA_DIR` are still honoured. Until o3d-2sm1.5 `deploy.sh` kept its own set under
`/var/lib/ims-deploy` while the other two used the paths above, so following the banner after a
failed install ran `deploy.sh` against a namespace holding none of it: no marker to adopt, no
cron backup to reuse, and a fresh backup taken of an already-fenced crontab. Anything still at
the old paths is **imported** into the table above by the next run of any of the three, before
it adopts anything and before it touches a unit or a crontab. If both namespaces hold the same
artefact the run refuses rather than guesses — read both, keep the one that describes the
interrupted run, delete the other, and re-run.

**The marker is published, never rewritten in place.** It is written to a temporary file in the
same directory, `fsync`ed, renamed, and the directory `fsync`ed after the rename — so a power
cut leaves either the previous complete marker or the new one, never a truncated file. The last
line of a complete marker is `marker_complete=1`. A marker without it (a bare `touch`, or one
left by a version of these scripts that predates the sentinel) is read the conservative way:
the schema **may** have moved, so the connection fence is held and the run re-migrates, checks
drift and re-verifies before anything gets `CONNECT` back.

**The reboot-fence drop-in is published the same way** (o3d-2sm1.5). The marker is only the
condition; the `zz-deploy-fence.conf` drop-in carrying `AssertPathExists=!<marker>` is what makes
systemd honour it, so both have to be equally durable. It used to be written with a plain
redirection into a `mkdir -p`'d `<unit>.d`, then `daemon-reload`ed and verified — which proves
systemd can read it *now* and flushes nothing. Nothing between that write and the first
`systemctl stop` is a write barrier, so a power cut after `schema_touched` became durable and
before the drop-in reached the medium rebooted **without** the fence, and the old enabled unit
started against a partially migrated schema. It now goes through the same discipline as the
marker, plus one barrier the marker does not need: where the run creates the `<unit>.d`
directory, that directory's own entry is flushed before anything is written into it. A
publication that cannot be proven **fails the install**, which is before the phase becomes
`stopping` and before anything is stopped.

**The stop is recorded before it is asked for.** The marker says `phase=stopping` on disk
before the first `systemctl stop`, so a run killed across the stop is adopted as a run that
stopped something. Without that, adoption falls back to asking whether anything is still
serving — where an unrelated listener on the port counts as the predecessor, and the fences get
unwound over a service that had already been asked to stop.

`install.sh` did not, until o3d-2sm1.5: its order was stop → drain → migrate → verify → seed →
bootstrap → **build** → start, which inverts the founding premise of this whole order — everything
that can reject a release must reject it while the predecessor is still up — on the entrypoint this
page says follows the same sequence. A TypeScript error costs nothing on `deploy.sh`; there it left
the service stopped, cron fenced, the schema migrated and the connection fence held. The build now
runs before the stop. The **seed and the bootstrap deliberately did not move with it**: they are
not validations that can reject a release, they are writes, and they need the schema the migration
has just applied — running them before the stop would be new code writing to the old schema, the
exact overlap this order exists to prevent.

**Why the migration comes after the stop and not before it.** These scripts used to migrate
first and build second, which left the OLD version serving the MIGRATED schema for the whole
length of a build — minutes. Every safety argument of the form "the new code is what writes to
the new column" is false for that window. Two migrations measured what it costs:

- a refund-reversal witness column: the old binary keeps inserting rows without it, and its own
  retry then clears `accounting_retry_required`, which is the accounting invariant's only bound.
  Once that is cleared the row leaves every query that could find it again — unrecoverable.
- a shopping-sync discriminator column: the old binary still selects held sales invoices by an
  operator-typed payload field, so it can overwrite an already-stamped row. That case is neither
  repairable nor detectable — the migration's own verification queries return zero while the
  damage stands.

The second case is why quiescence cannot be a post-hoc check. Verification catches an old binary
that *created* rows; nothing catches one that *overwrote* them. Stopping the writer first is the
only defence. (o3d-2sm1.1)

**"Drained" means stopped, not idle.** The scripts stop, in order:

1. the application service (`systemctl stop`, so a `Restart=` policy cannot undo it);
2. any remaining process whose working directory is the app directory — matched by
   `/proc/<pid>/cwd`, so a second instance serving a different tree and a different database is
   never touched;
3. the cron entries in the service user's crontab. These are the easy ones to forget: nothing
   runs between ticks, so the box looks quiet, but each tick drives a queue worker (accounting
   sync, the WooCommerce webhook inbox, the WMS sweeper, refund reservation release). They are
   commented out for the window and restored **verbatim** from a backup once the new version has
   answered its health check;
4. anything else still connected — `scripts/check-db-writers.mjs` asks `pg_stat_activity`
   directly and refuses to migrate while any other client backend holds a connection. That is the
   check that catches the writer nobody enumerated.

**A snapshot is not a fence** (o3d-2sm1.2). Step 4 on its own closes its connection, and the dump
and the migration then open theirs; nothing stops a client connecting in the gap. So the scripts
first revoke `CONNECT` on the database from **every grantee that holds it directly** — the
application role, PUBLIC (the default database ACL grants it to PUBLIC, so revoking from the role
alone changes nothing) and any other role with a direct grant — for the length of the window
(`scripts/fence-db-connections.mjs --fence`), drain what is already attached, and only then take
the snapshot.

**The fence record is published before the `REVOKE`, and durably** (o3d-2sm1.5). The revoke is a
committed PostgreSQL transaction: it survives a power cut. `db-connect-fence.json` — the only
account of what was revoked and from whom — used to be a plain write whose return permitted that
transaction, so a power cut in between preserved the lock-out and lost the key. It is now written
to a temporary in the same directory, `fsync`ed, renamed and the directory `fsync`ed, all before
`BEGIN`; if any of that cannot be proven, **nothing is revoked** and the run aborts with exit 3.
The last field of a complete record is `"state_complete": 1`.

**The fence is TOLD which connection it is closing; it does not work it out** (o3d-2sm1.5 r19).

Seven rounds went into deciding *where the application connects* by reconstructing what its
runtime resolves. Each answer was locally correct and uncovered another layer beneath it:

| round | what it resolved through | what was wrong with it |
| --- | --- | --- |
| r13-r15 | this repo's own reading of `DATABASE_URL` | authority-versus-query precedence, `?user=` overriding the authority, repeated parameters |
| r16 | `pg`'s own **string parser** | a string parser is not a connection: `pg` fills `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` in for everything the URL omits |
| r17 | the driver's real client, in the **deploy shell's** environment | the application does not inherit the deploy shell — so the service's environment file was read instead |
| r18 | `systemctl show <unit>` | systemd answers for `Environment=` and **not** for the `EnvironmentFile=` layer, which then had to be refused on a mention of a name |
| r19 | — | and five more layers appeared: `PassEnvironment=`, `UnsetEnvironment=`, wildcard `EnvironmentFile=` globs, the `.env.development*` / `.env.test*` overlays Next loads in other modes, a unit with no `WorkingDirectory=`, and `DATABASE_URL`'s own precedence chain |

The count of blockers went 1 → 4 → 5. That is not an implementation problem: **the question has no
bounded answer**, because the composition rules belong to systemd, Next and libpq at once and any
of the three is free to add a layer.

So it is no longer asked. `scripts/fence-db-connections.mjs` **requires** four options —
`--app-host=`, `--app-port=`, `--app-user=` and `--app-database=` — on every mode, and **refuses**
without them (exit 3 for `--preflight`/`--fence`, which every entrypoint reads as "nothing was
revoked"; exit 1 otherwise). It is not run by hand: the entrypoints below pass them.

There is no environment reconstruction, no systemd interrogation, no dotenv scanning and no
precedence emulation left in the helper. **The operator types nothing new** — the calling scripts
supply the values:

* **`scripts/install.sh` owns them.** It prompts for `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER`,
  creates the role and the database with them, and composes `DATABASE_URL` out of them. It passes
  those same variables; nothing is parsed anywhere. Reached before the database exists (an exit
  trap on an early failure), the values are still empty and the fence is **refused**;
* **`scripts/update.sh` and `scripts/deploy.sh` split them out of `DATABASE_URL`** — the file they
  already read `DEPLOY_ADMIN_DATABASE_URL` from — with a strict reader (`resolve_db_identity`,
  the same twenty lines in both) that **accepts only a URL stating all four**. No port, no path,
  more than one path segment, a `?host=`/`?port=`/`?user=`/`?dbname=`/`?database=` query
  parameter, a percent-escape **anywhere in the query string**, whitespace: each one is a
  **refusal** that stops the run before anything is stopped or migrated. Never a default.
  The query-string rule is deliberately blunt because the driver decodes query **keys**:
  measured against the installed `pg-connection-string`, `?ho%73t=other-cluster` arrives as
  `host=other-cluster`, `?po%72t=6543` as `port=6543` and `?u%73er=other` as `user=other`, none of
  which a scan for the literal names catches. Decoding it here to compare properly is the
  reimplementation this reader exists to avoid, so an escape in a *harmless* parameter is refused
  too — telling the two apart is the thing that cannot be done without decoding. Write the query
  plainly. In particular the libpq unix-socket spelling
  `postgres://role@/db?host=/var/run/postgresql` is **refused** here — it states neither host nor
  port in its authority and puts the host in the query string, which is the one shape this reader
  will not accept. Nothing this repo ships composes that form (`install.sh` and `.env.example`
  both write `host:port`); an installation that uses it must give `DATABASE_URL` an explicit
  `host:port`, or run `deploy.sh --skip-migrate`.

**And the strictness is what closes the question rather than narrowing it.** `PGHOST`, `PGPORT`,
`PGUSER` and `PGDATABASE` are consulted by libpq and by `pg` *only* for values the connection
string leaves out. A URL that states all four cannot be moved by any of them, in any process,
under any of the three composition systems above — so for exactly the URLs the callers accept, the
whole environment question has no bearing on the answer, and for every other URL there is a
refusal in place of a guess.

If your `DATABASE_URL` does not state all four, write it as
`postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE`. A `deploy.sh` run that only needs no schema
change can also use `--skip-migrate`, which moves nothing and needs no fence.

**And the file it is read from must be the file the service uses.** Supplying the identity out of
`APP_DIR/.env` is only worth anything if that file is what gives the *service* its `DATABASE_URL`,
and systemd can put a different one there: `Environment=DATABASE_URL=`, a drop-in that adds one,
`PassEnvironment=`, `UnsetEnvironment=`, or a second `EnvironmentFile=`. dotenv does not overwrite
a variable that is already set, so the fence, the migration and the release would all agree with
each other about the `.env` database while the restarted application connects somewhere else — a
migration on a database nothing fenced, and a new build on a database nothing migrated.

So `deploy.sh` and `update.sh` ask systemd **one existence question about one variable** before
they fence, preflight or re-fence — *can anything other than the file we read define
`DATABASE_URL` for this unit?* — through
`systemctl show -p LoadState -p Environment -p EnvironmentFiles -p PassEnvironment
-p UnsetEnvironment`, which reports those properties **composed**, with every drop-in already
folded in. This is not the environment reconstruction the helper lost: no value is computed and no
precedence is resolved. Which of several definitions would *win* is the unbounded question and is
never asked. Any answer but "only that file" is a **refusal** naming what else defines it:

* `DATABASE_URL` in the unit's `Environment=`, `PassEnvironment=` or `UnsetEnvironment=`;
* **any second `EnvironmentFile=`** — refused *without being read*, because that it may define the
  variable is enough, and reading it to find out puts the precedence question straight back;
* a unit that loads **no** environment file, because the variable would then reach the application
  through its own dotenv loader, by Next's rules (`.env.local`, the per-mode overlays) rather than
  systemd's. Add `EnvironmentFile=` for the app's `.env`, which is what `install.sh` writes;
* a unit systemd reports as anything but `loaded`, a host with no `systemctl`, or no unit at all.

`install.sh` is **exempt**: it owns the four values, creates the role and the database with them
and composes `DATABASE_URL` out of them, so it parses nothing and has no file to be wrong about.

One thing this question cannot see, stated rather than papered over: an `ExecStart=` running a
**wrapper that exports `DATABASE_URL` itself** is invisible to `systemctl show`, because that
definition lives inside a program. Closing that would mean reading programs, which is unbounded
again. It is the standing argument for eventually making the four values a **deployment-owned
configuration input** these scripts read outright, rather than deriving them from a URL that is
only probably the one the service uses.

**Being told an identity is not the same as being on it**, so what can be proven still is:

* the admin URL this run opens must reach the **same database and the same server** as the four
  supplied values, or every mode refuses. A loopback address, `localhost` and a unix-socket
  directory are treated as the same machine; anything else that differs is a refusal, not a guess;
* the connection actually opened must report that database as `current_database()`, and must be
  running as the role it **logged in** as (`session_user` = `current_user`), or it refuses. A
  connection string with no database in its path connects to `PGDATABASE`, or failing that to the
  login role's own name, which is how the two come apart without the admin URL looking wrong;
* in `--release`, the application probe must reach **the same postmaster** as this run —
  `pg_postmaster_start_time()`, asked of both — before "the application can connect" is allowed to
  mean anything. A database name is not an identity: `imsdb` exists on the staging server too.

**`DATABASE_URL` is a credential to this helper and nothing else.** It is no longer read for the
role, the host, the port or the database name. The only thing the helper does with it is *open*
it, in `--release`, to see whether the application gets in — and where that lands is then
cross-checked as above. `.env.local` is no longer loaded either: systemd hands the service `.env`,
and reading a file the service never sees was divergence bought for nothing.

**The admin URL is still resolved through the driver, and that is still worth stating**
(o3d-2sm1.5). It is the connection *this process* opens, so `pg`'s own resolution of it is the
right one, and the identity gate reads the effective host, port, user and database off the
`pg.Client({ connectionString })` that `pg` would open rather than off the URL's obvious parts.
For that URL:

* a **repeated** `?host=`, `?port=`, `?user=`, `?dbname=` or `?database=` is **refused** outright.
  The driver copies every query entry into one config object, so the **last** one is the one it
  connects with, while anything reading the URL a parameter at a time — `URLSearchParams.get()`,
  an operator's eye, a log line — sees the **first**;
* a URL whose authority and query string **disagree** about the host, port or user is **refused**
  rather than resolved;
* a `?dbname=` / `?database=` parameter is **refused** when it names anything but the URL path,
  because the driver overwrites the database from the path unconditionally;
* a port `pg` cannot read as a number reaches `ConnectionParameters` as `NaN`, and is **refused**
  rather than quietly defaulted to 5432;
* the **OS account** is subtracted: `pg`'s last fallback for the login role is `process.env.USER`,
  the account running this script and not the application's, so an admin URL that rests on it is
  **unidentified** — and `session_user`, read from the open connection, is what binds the role;
* `postgres://role@/db?host=/var/run/postgresql` — a login role with no host in the authority — is
  read the way the driver reads it, not rejected as unparseable.

**And the role is asked of the connection, not derived from the URL** (o3d-2sm1.5). `PGUSER`, a
`.pgpass` entry, an ident or peer map and `options=-c role=` are all outside any URL. Every mode
now reads `session_user` and `current_user` from the connection it opened, alongside
`current_database()`, and refuses when the connection will not say what it logged in as, when it
is **running as** a different role than it **logged in as** (`CONNECT` belongs to the login role,
while every ACL answer would be given as the assumed one), or when `DEPLOY_ADMIN_DATABASE_URL`
names a role other than the one that actually logged in — that role is the one grantee the fence
deliberately does not revoke, and the one `--release` restores against.

**And `--release` never reads a missing record as "no fence".** A record that was never written
and one a power cut ate are indistinguishable from the file system, so absence is not an answer:
`--release` asks the database instead. **Neither answer it can get is a success**, because
`has_database_privilege(<app role>, …, 'CONNECT')` speaks for exactly one role while the fence
revokes `CONNECT` from every grantee that held it:

| what the database says | exit | what it means |
| --- | --- | --- |
| the application role has **no** `CONNECT` | `1` | a fence is standing and its record is gone. It prints the `GRANT` to run by hand and tells you to check `pg_database.datacl` for the other grantees it cannot name. |
| the privilege read and `DATABASE_URL` **disagree** | `1` | the connection this run opened says the role holds `CONNECT`, and `DATABASE_URL` itself cannot connect. A privilege read answers about the database the *reading* connection is attached to; the application uses `DATABASE_URL`. Fatal (o3d-2sm1.5). |
| the application role **has** `CONNECT`, **proven by connecting as it** | `4` | that, and only that. The application can be back inside through `PUBLIC`, through role membership or through a manual grant while monitoring, backup, BI or a second application is still revoked by the same fence — the shape `--fence` itself leaves standing when it rejects an ineffective fence. Audit `SELECT datacl FROM pg_database WHERE datname = current_database();` before treating the database as open. |

Only a usable record licenses "released" (exit 0), because only a record says who held `CONNECT`
beforehand. A record that exists but cannot be parsed is left in place for inspection, and
`--fence` refuses to overwrite one rather than starting a fresh record over the only account of an
earlier fence.

**The entrypoints always ask.** `deploy.sh`, `update.sh` and `install.sh` used to open their
release with `[[ -f <state file> ]] || return 0`, which is the same defect one layer up — an
absence treated as an answer — and it meant the check above was never reached on the exact failure
it exists for. They now run `--release` unconditionally, on the start path and on both adoption
paths, and act on the exit code: exit 1 is fatal everywhere (the application has no `CONNECT`, so
nothing may start or adopt past it); exit 4 is fatal when *that* run had raised a fence of its own
and the record has since vanished, and otherwise a loud warning carrying the ACL audit, so a
`--skip-migrate` run or a resume over an untouched schema is not blocked by a state nothing can
distinguish from health.

**An exit code is not evidence about what was committed** (o3d-2sm1.5). `--fence` commits its
`REVOKE`s and *deliberately leaves them standing* when it then finds the fence ineffective (the
application keeps `CONNECT` through role membership) or the room will not go quiet — the same
shape the exit-4 text above describes. It used to report that with the same exit 1 a failure that
revoked **nothing** returns, and the entrypoints raise their sticky "this run raised a fence" flag
only on exit 0, so a run that had locked PUBLIC, monitoring and BI out was recorded as one with no
fence to its name; a record lost during cleanup then took the exit-4 *warning* branch and let the
run claim a release nobody performed. So:

* **exit 3** — nothing was revoked. **exit 5** (`EXIT_FENCE_STANDING`) — the `REVOKE`s may be in
  force, and this run still cannot call the database fenced. Every outcome from the moment `COMMIT`
  is **issued** returns 5, a thrown error included.
* **A lost `COMMIT` acknowledgement is one of those outcomes** (o3d-2sm1.5). PostgreSQL can commit
  the `REVOKE`s and then lose the connection before the acknowledgement arrives — a dropped
  connection, a timeout, a server restart an instant after the WAL flush. The client's promise
  rejects, and that used to be read as "the transaction did not commit": it rolled back into thin
  air, exited 1, and all three entrypoints recorded a run with no fence to its name over a database
  whose `CONNECT` may have been revoked from PUBLIC, monitoring, backup, BI and a second
  application. **An absent answer is not a negative one.** The post-commit boundary is now the
  moment `COMMIT` is issued, not the moment it is acknowledged; an unacknowledged commit reports
  exit 5, raises the same sticky flag, prints the `GRANT`s and a `SELECT datacl …` to check with,
  issues **no** `ROLLBACK` (a transaction told to commit is not one the run can take back) and
  leaves `db-connect-fence.json` exactly where it was published.
* `deploy.sh`, `update.sh` and `install.sh` **raise the sticky flag on every post-commit result**,
  exit 5 as well as exit 0, in `fence_db_connections()` and in the exit trap's re-fence, and abort
  saying the fence is standing rather than "the fence failed".
* After such a result the unproven verdict (exit 4) is **fatal in all three**.

**Every grantee, not two of them** (o3d-2sm1.5). It used to revoke from PUBLIC and the application
role and call the database held closed. A third role with a direct `CONNECT` grant — monitoring,
BI, a backup job, a second application — was terminated by the drain and **reconnected
immediately**, for the whole length of the migration, while every header and this page said the
database was fenced. The set of grantees is derived from the ACL itself now; the only exclusion is
the admin role the deploy is connected as, because revoking from that would lock the deploy out of
its own recovery. The drain's terminate and its confirming read are both unconditional: an empty
first sample, taken microseconds after the revoke committed, is not proof that a backend which was
mid-authentication has gone.

`--release` restores exactly the grantees that were revoked. It cannot restore the **grantor**: a
grant originally made by `postgres` comes back recorded as made by the deploy admin. The privilege
is identical and every `has_database_privilege()` answer is the same; what changes is who may
revoke it later.

**The fence proves it took, rather than assuming the revoke worked** (o3d-2sm1.3). A grant can reach
the application role through **role membership**, which no examination of the ACL entries the script
itself removed can see. So after the revokes it asks the database directly —
`has_database_privilege(<app role>, current_database(), 'CONNECT')` must be false — and fails with
the granting roles named if it is not. A deploy must not revoke from a shared role, so this is
reported rather than worked around: make the application role's `CONNECT` a direct grant, or run the
cutover with the writers stopped and no connection fence.

**When the fence is released, and when it is deliberately held** (o3d-2sm1.3). Releasing it from the
failure path unconditionally — which is what the previous revision did — lets the application
reconnect to a database whose schema is in an unknown state, which is the exact window this order
exists to close. The distinction is whether the schema was **touched**, meaning
`prisma migrate deploy` had been invoked:

| Where the run failed | The connection fence |
| --- | --- |
| Before the migration was invoked (build, validation, a writer that would not stop, an unarmable fence) | **Released.** Nothing has moved, and a revoke nobody undoes is an application that cannot reach its database at all. |
| At or after the migration was invoked, including a failed drift check or a failed verification | **Held**, with the command to release it by hand printed. The schema may be half-applied; nothing may connect until a re-run has migrated, checked drift and verified. |
| At the start or the health check, *after* the fence had been released for the start | **Re-established**, then held. See below. |
| Everything passed | Released in the start phase, immediately before the new build starts — the only place a release follows a migration. |

**`schema_touched` is written to disk and flushed *before* Prisma is invoked** (o3d-2sm1.4). It used
to be set in shell memory next to the migration command, with the durable marker written by the exit
trap. A `SIGKILL`, an OOM kill or a power cut during `prisma migrate deploy` never reaches a trap, so
the marker on disk still said `schema_touched=false` — and the next run's adoption, which reads that
file and nothing else, **released** the connection fence over a half-migrated schema. Each script now
records and flushes the flag first and refuses to migrate if it cannot: a hard kill at any point from
that moment on leaves a marker that adoption reads as *hold*.

**A failed start does not get to claim the fence is up** (o3d-2sm1.4). The start phase releases the
connection fence and removes the reboot marker *before* `systemctl start` and the health check,
because the new build cannot serve a database it may not connect to. If either then fails, the
failure path re-stops the service, **re-establishes the connection fence**, and prints — and records
in the marker as `db_connect_fence=held|released` — which of the two is actually true. If it cannot
put the fence back it says `THE CONNECTION FENCE IS NOT IN PLACE` rather than describing one that
does not exist.

A re-run **adopts** a held fence rather than releasing it: it re-applies the revoke (which re-drains
anything that attached in between, while keeping the *original* recorded grants so the eventual
release restores the truth) and runs every database-touching recovery step — the rebuild included —
through `DEPLOY_ADMIN_DATABASE_URL`. Adopting a held fence without that variable set is fatal: the
application role has no `CONNECT` and the run would have no connection to recover through.

That fence needs a privileged connection of its own, `DEPLOY_ADMIN_DATABASE_URL`:

| Variable | Purpose |
| --- | --- |
| `DEPLOY_ADMIN_DATABASE_URL` | A superuser or database-owner connection, as a **different role** from `DATABASE_URL`. Used only by the deploy scripts, and only for the migration window. No ACL can tell "the migration" apart from "the application" when both log in as one role, so without a separate role there is no fence to install. |

**Who the migration runs as, which is not who it connects as** (o3d-2sm1.5). This table used to
end with *"objects a migration creates are owned by this role — point it at the role that owns the
schema today"*, and that is advice nobody can follow: `install.sh` makes the **application** role
the database owner, and the fence **refuses outright** when the admin role *is* the application
role. The only fenceable configuration is therefore a separate **superuser** admin — and every
`CREATE TABLE`, `INDEX` and `SEQUENCE` a migration made through it was owned by that superuser
with no grant to the application role.

Nothing in the pipeline could see it. `prisma migrate deploy`, the drift check, the verification
hook and `pg_dump` all use **the same admin connection**, which owns the new objects and reads
them perfectly; the health check hits a route that touches no database. The deploy reported
success and every request touching the new table failed with `permission denied`.

So the migration **connects as the admin and runs as the application role**: the deploy composes
the migration URL with `options=-c role=<app role>`, which Postgres applies at connection start.
Authentication — and therefore the `CONNECT` check the fence revokes — is still the admin's, so
the fence still holds; ownership is the application's, so the fenced path leaves the database in
exactly the state an unfenced migration would.

It is not taken on trust:

* `scripts/fence-db-connections.mjs --preflight` **refuses before anything is stopped** if the
  admin cannot `SET ROLE` to the application role, naming the `GRANT` that fixes it;
* `scripts/check-app-db-object-access.mjs` runs after **every** migration, before the new build
  starts, and asks the database — about the **application** role, which is the one question none
  of the other steps ask — whether it can `SELECT`, `INSERT`, `UPDATE` and `DELETE` every table,
  `SELECT` every view, `USAGE`/`SELECT`/`UPDATE` every sequence, `EXECUTE` every function (this
  repo's migrations create trigger functions that **gate writes**), and `USAGE` every enum, domain
  and range type. Schemas are asked about directly, so a schema that is **empty** and unusable
  fails rather than contributing no rows and therefore no failure. Anything it cannot use fails
  the deploy and is reported with its owner and the exact privileges missing.

  **Every privilege is asked for separately, and that matters.**
  `has_table_privilege(role, oid, 'SELECT, INSERT, UPDATE, DELETE')` is **ANY, not ALL** — a role
  holding `SELECT` and nothing else answers `true` — and `has_sequence_privilege(role, oid,
  'USAGE, SELECT, UPDATE')` answers `true` for a role holding `SELECT` and no `USAGE`, which is
  exactly the "serial column fails `INSERT`" case this check exists to catch. A comma-separated
  list would therefore turn a read-only grant into a green check over a database the application
  cannot write. `tests/scripts/app-db-object-access.test.ts` proves it against a real Postgres in
  CI's `fresh-db-drift` job.

  It also **refuses to answer about the wrong role**. During the fenced window `DATABASE_URL` is
  the *admin* URL, and asking whether the admin can use the objects the admin just created answers
  yes for every one of them. So the role comes from `--app-role`, then from the fence state file;
  a state file that exists but cannot be read or names no role is **fatal** rather than a silent
  fall-through, the `-c role=` option on `DATABASE_URL` outranks its username, and a fall-through
  that lands on the deploy admin is refused outright.

**The point of no return needs proof, not an open port** (o3d-2sm1.5). Past the health check the
exit trap deliberately stops tearing the deploy down: the new build is serving, and a failed cron
restore must not become an outage plus a database lockout. That is only defensible if the new build
really *is* the one serving. A health poll proves a socket accepted a request — `deploy.sh`'s
`HEALTH_PATH` defaults to `/login` and `update.sh`/`install.sh` poll `/api/health`, all of which a
**stale predecessor still holding the port** answers just as happily. So the flag is armed only on
positive proof that the process on the port is the one this run started — and the three scripts do
not all have the same evidence available, so this is what each of them actually does:

* **The production channel, all three scripts.** An asset under `/_next/static/<BUILD_ID>/` answers
  `200`. Next matches that prefix against a directory snapshot taken at start-up, so only a process
  whose own build id is that one can serve it — a `200` is the new code identifying itself. If it
  does not answer, `update.sh` and `install.sh` fail outright, and so does `deploy.sh` on every
  launcher except the one below.
* **The build id scraped from the health page is evidence, not a verdict** — `deploy.sh` only, and
  it is **not** fatal. It is a regex over whatever HTML that path returns, so a page that embeds no
  build id, a different one, or one behind a CDN is not proof of a stale predecessor. A mismatch
  **warns**, arms nothing and fails nothing. Making it fatal was a deterministic post-migration
  outage on this host: a `next dev` unit answers with the literal build id `development` — eleven
  characters, so it cleared the scrape's length filter — and the mismatch branch fired on every
  single run, leaving a migrated schema with nothing serving and the app role locked out
  (o3d-2sm1.5 r6). If you are reading this expecting "mismatch is fatal", that sentence was wrong
  about the code for two rounds; this is what the code does.
* **The development-server channel, `deploy.sh` only.** `detect_service_units` selects any unit
  whose `WorkingDirectory` resolves to the app directory, and on a stage box that is a `next dev`
  unit. It is still stopped and drained — it is a live writer into the same database — but it
  compiles from source and has no production build id to serve, so the asset channel can never arm
  for it. That is not an exemption: `DEV_SERVER_UNIT` describes the launcher the run *intended*,
  not the process that answered, and a bare warning there used to complete the deploy with nothing
  having identified the responder at all. So `deploy.sh` proves the responder's identity directly,
  and needs **all three** of: the pid listening on the port belongs to a unit this run restarted
  (its cgroup matches `systemctl show -p ControlGroup`, or it descends from the unit's `MainPID`);
  its `/proc/<pid>/cwd` is the app directory, which is the tree a dev server compiles from; and it
  started **after** this run issued `systemctl start`, so it did not survive the stop.

If nothing identifies the responder the deploy **fails while the trap can still stop the
predecessor**, rather than reporting success over an old build serving a migrated schema. The one
deliberate way past that is `IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1`, for the case where the
identity check itself is what is broken on a host: it finishes the run, but it does **not** arm the
point of no return — so a later failure can still be torn down — and it says so on every line it
prints.

**The fence is mandatory for an existing database** (o3d-2sm1.4). Earlier revisions treated exit 3
from `scripts/fence-db-connections.mjs` — "CONNECT was **not** revoked" — as a warning and carried on
with the point-in-time probe. That repeats the mistake the probe itself was: a sibling server, a cron
tick the crontab fence missed, an operator's `psql` or a `next dev` in another worktree can attach at
any moment *after* the snapshot and write across the migration. A fence you know is absent is not a
degraded fence, it is no fence. So:

* `scripts/deploy.sh`, `scripts/update.sh` and `scripts/install.sh` **abort on exit 3**, with the
  fence script's own reason printed above the refusal, and nothing is migrated;
* the fence is checked **before anything is stopped** by *running* it — `--preflight` opens the same
  admin connection and asks the same questions as `--fence`, and revokes, terminates and writes
  nothing. It used to be a `[[ -f scripts/fence-db-connections.mjs ]]`, which proves a file exists
  and nothing about whether it works: `dotenv` was a **devDependency** while the documented manual
  upgrade runs `npm ci --omit=dev`, so the fence died with a missing module at `drain-verify`,
  **after the stop** — an outage for an import (o3d-2sm1.5). `dotenv` is a runtime dependency now,
  and the preflight is what would catch the next one;
* the reasons only the database can give — a superuser application role, a `CONNECT` arriving
  through role membership, an admin that cannot `SET ROLE` to the application role — are answered by
  that same preflight, so they too cost a refusal rather than the stop;
* a **first install** has no existing database to hold closed, so it never asks;
* `--dry-run` **reports** the refusal (`A REAL RUN WOULD BE REFUSED HERE`) and exits 0, because a dry
  run stops nothing and migrates nothing, and its whole job is to tell you what a real run would do.

**The reboot fence is installed before the migration, verified, and rolled back if it cannot be.**
Each unit gets a drop-in at `/etc/systemd/system/<unit>.d/zz-deploy-fence.conf` carrying
`AssertPathExists=!<state-dir>/FENCED`, written *before* anything is stopped — a fence installed
only from the exit trap does not exist for a run that is SIGKILLed or loses power mid-migration,
which is exactly when it is needed. It is a drop-in and not `systemctl mask` because a mask is a
symlink at `/etc/systemd/system/<unit>`, which is where a locally-installed unit file already
lives (the mask fails outright), and `mask --runtime` lives in `/run`, which the reboot erases.
The scripts check the install against `systemctl show -p DropInPaths` and refuse to stop the
predecessor if they cannot confirm it.

**A failed install leaves nothing behind** (o3d-2sm1.5). The marker went down first, then the
drop-in, then the reload, then the verify — and any failure after that first line returned into a
`die` while the fence was not yet armed, so the exit trap did nothing and neither the marker nor
the drop-in was removed. The operator read a clean abort: *refusing to stop the predecessor,
nothing changed*. Nothing had, except an `AssertPathExists=!` now pointing at a marker that
existed — invisible until the next reboot, when the unit failed its assertion with nothing on the
box connecting that to a deploy that had "changed nothing". The install now removes exactly what
**that call** created, and never a fence that was already standing (an adoption, or the exit
trap's own re-install).

**A failure before the stop is not an outage, and is no longer treated as one** (o3d-2sm1.5). The
cutover is a four-phase state machine in all three scripts, and the exit trap does something
different in each:

| Phase | Flag | What the exit trap does |
| --- | --- | --- |
| `none` | — | Nothing this run created needs undoing; it just exits. |
| `arming` | `CUTOVER_ARMING` | Reversible state exists — the reboot-fence drop-in and marker, the fenced crontab — and **nothing has been asked to stop**. The trap **undoes it**: the crontab goes back verbatim from the backup this run took, the drop-in and marker this run wrote are removed, and the service is **not touched**. |
| `stopping` | `FENCE_ARMED` | A stop has been **attempted** (or a previous run's fence was adopted, which means its stop already happened). The trap re-stops, re-fences, holds the connection fence if the schema moved, and refuses to restart anything. |
| `serving` | `PAST_POINT_OF_NO_RETURN` | The new build was proven to be the process on the port. Nothing may stop it; a failed cleanup is a note for a human. |

`FENCE_ARMED` used to be raised *before* `fence_cron` and before any stop, so every way cron
management can fail — an unwritable backup, a failed `chmod`, a broken pipeline, a `crontab` that
returns non-zero — arrived at the trap looking exactly like a failed migration. The trap then
**stopped a service nobody had touched**, kept the reboot fence and demanded a recovery, over a
schema that had not moved and a predecessor that was still healthy: a failure in the cheapest,
most reversible step running the expensive, outage-causing machinery. The flag is now raised on the
line before the first `systemctl stop`, and the arming phase is what covers everything earlier.

**A migration needs a unit to fence** (o3d-2sm1.5). With no systemd unit serving the tree the
install used to warn and return success, so the `|| die` at every call site never fired: the
predecessor was stopped and the schema migrated with no reboot fence at all, and the failure
banner then described one. That is the exit-3 reasoning again, so `deploy.sh` refuses a migration
on a unit-less host in the `validate` phase, before anything is stopped, and names
`IMS_SERVICE_UNIT`. The `nohup npm start` fallback is unaffected for `--skip-migrate` and
`--restart-only`, which move no schema. The state file records
`reboot_fence=installed|absent` and the failure banner prints whichever is true.

**There is a point of no return** (o3d-2sm1.5). Once the new build has answered its health check
the deploy has succeeded, and what is left is cleanup. The success flag used to be set only after
the cron restore and the marker removal, so under `set -e` a failing `crontab` reached the exit
trap with the fence still armed — and the trap **stopped the service that had just passed its
health check**, re-fenced it and re-revoked `CONNECT`. A cron-restore failure became a full outage
plus a database lockout on a deploy that had already succeeded. Past the health check nothing
tears the deploy down: the failure is printed with the commands to finish the cleanup by hand.
`install.sh`'s upgrade cutover, which previously had **no health check at all**, now polls
`/api/health` before it restores cron and calls the upgrade complete.

**On a failure after the stop, the old version stays down.** A "rollback" that restarts the
predecessor against a migrated schema puts you back in the window the order exists to close. The
scripts leave the service stopped and fenced against a reboot, write a state file recording the
failed step and the command that releases the connection fence, and print what to do. Fix the
cause and re-run — every step is idempotent, and **a re-run adopts all three fences before it
rebuilds**: it re-stops the service, re-establishes and verifies the reboot fence, confirms cron is
still fenced and adopts or releases any standing connection fence (per the table above), all before
it pulls or builds. Do not start the service by hand to "restore service" while a migration has been
applied and the new build has not started.

**A re-run over a migration attempt may not skip the migration** (o3d-2sm1.3). While adopting a
marker whose `migration_attempted=true`, `scripts/deploy.sh` **refuses** `--skip-migrate` and
`--restart-only`: the schema may be half-applied, and starting the service without re-running
`migrate -> drift -> verify` would start it against exactly that. `--skip-build` is still allowed,
and is usually what you want — the build ran before the stop, so the artefact on disk is already the
new one.

**The pre-migration dump is recorded as a restore point only once `pg_dump` succeeds.** It is
written to a `.part` file and renamed on completion; if it fails, the partial file is deleted and
the failure banner says there is no restore point for this run rather than naming a truncated
file as one.

Never run two versions of IMS against the same database at once — no rolling restart, no
blue/green overlap, no second instance left running on another port.

### Post-migration verification: `verify.sql`

A migration can declare checks that must pass **after the schema has moved and before the new
build is allowed to serve**. Put them in

```
prisma/migrations/<migration_name>/verify.sql
```

Prisma reads only `migration.sql` from a migration directory, so this file is invisible to
`prisma migrate deploy` and carries no checksum risk. `scripts/run-migration-verifications.mjs`
runs every such file whose migration is recorded as applied — from the deploy scripts during a
cutover, and from the `Schema Guardrails` CI job against a freshly migrated database on every PR.

The contract:

- every statement returns **exactly one row** with **exactly** the columns `check_name` (text)
  and `violations` (an integer count);
- every `violations` must be `0` — anything else fails the deploy and the new build is not
  started. "Anything else" includes a count that is **NULL** or is not an integer, which is an
  **error**, not a pass: `Number(null)` and `Number('')` are both `0`, and the counts most likely to
  come back null are exactly those from a check that found nothing to aggregate over (`SUM` or `MAX`
  over an empty input, a scalar subquery that matched no row). A check that cannot fail is not a
  check (o3d-2sm1.3);
- the checks are read-only, and they must stay true afterwards, because they run on every later
  deploy too.

```sql
-- rows the predecessor created without the new discriminator
SELECT 'shopping_sync_logs missing recordKind' AS check_name,
       count(*)                                AS violations
  FROM shopping_sync_logs
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce';
```

A check that is only meaningful for one cutover is exactly the right shape: it returns zero for
ever after, and the day it does not, something restarted a predecessor.

**Coverage is declared, and an absent declaration is visible** (o3d-2sm1.2). The hook used to exit
0 the moment no `verify.sql` existed anywhere — which is the state this repository was in — so CI
and the deploy both reported success having executed nothing. Now:

- every run prints what ran and what did not: migrations on disk, how many declare checks, which
  declarations were skipped because their migration is not applied, and how many checks executed;
- a run that executed **no** checks prints `NOTHING WAS VERIFIED` and says that a zero exit means
  nothing was checked, not that nothing is wrong;
- `prisma/migrations/verification-required.txt` names the migrations that **must** declare a
  `verify.sql` — the ones whose safety argument depends on which binary was serving while they ran.

This repository's required migration, `20260822090000_refund_reversal_staging_state`, now declares
its checks (o3d-2sm1.3 — the coverage gate was previously red by design, which is the fastest way to
teach everyone to ignore a mandatory gate). They are derived from what that migration's own prose
says is dangerous:

1. **no refund written after the cutover began without a staging witness.** Legacy rows are
   legitimately `NULL` — the column is deliberately not backfilled — so the check needs a bound.
   That bound is **a discriminator the migration itself draws, not a clock** (o3d-2sm1.4): the
   first revision compared `createdAt` against `_prisma_migrations.started_at`, and
   `CURRENT_TIMESTAMP` is fixed at *transaction start*, so a predecessor transaction that began
   before the migration and committed after it stamps a pre-migration timestamp and looks legacy
   while being exactly the row the check exists to find. `migration.sql` instead adds
   `reversal_staging_state_predates_column NOT NULL DEFAULT true` under its own `ALTER TABLE`'s
   `ACCESS EXCLUSIVE` lock — marking precisely the rows that exist at that instant, with none
   insertable in the middle of it — and then flips the default to `false`. A `NULL` state on a row
   marked `false` was minted by a predecessor still serving, and no clock is consulted.
2. **none of those already outside the accounting invariant's only bound**, i.e. with
   `accounting_retry_required` cleared and no recorded sync list. That is the subset the migration
   calls unrecoverable — no sweep will look at such a row again. It is deliberately a subset of the
   first check; separating them is about what the failure report tells the person reading it.
3. **no value in the column that neither application writer mints.** The migration ships no trigger,
   no default and no backfill, and a third value would make `reversalRecordVerdict` fall through to
   `undecidable` — silencing itself rather than failing.

**And there is a way out when check 1 is red** (o3d-2sm1.5). These checks run on every subsequent
deploy, so a non-zero count does not clear itself: once a predecessor has minted such a row — or a
**partial restore** has put pre-migration rows back into a migrated database, where they arrive
with the post-migration default `predates = false` — every deploy from then on is refused by a
count nobody can act on, and a gate that can only be red is a gate everyone learns to ignore. The
route out is a **repair**, documented in the migration's own `verify.sql`: decide a
predecessor-minted row's state from the accounting ledger and write it, or, for rows a restore
brought back, set `reversal_staging_state_predates_column = true` **scoped to the ids the restore
actually returned** — never to "everything currently red", which would relabel a predecessor's
rows as legacy and destroy the evidence. Neither is something a deploy script runs.

A named migration that declares nothing is a coverage gap. It **fails** under `--strict`, which is
how the `Schema Guardrails` CI job runs the hook, because a missing file is a defect for the pull
request to fix. The deploy scripts run it **without** `--strict` and report the gap instead:
refusing to start a built and migrated application over a file absent from the repository would
turn a documentation gap into an outage. What stops a cutover is a check that ran and failed.

**You do not have to get this right for accounting money posts to stay safe**, and it is worth
knowing why, because a rollback is a deploy nobody plans. Money posts (customer receipts, supplier
payments, credit-note allocations) record `accounting_sync_logs.remoteAttemptedAt` immediately
**before** the remote call, and the retry and revival logic treats an unstamped row as proof that no
call was ever made from it. A version that does not write that stamp would break the proof — so
whether the proof holds is recorded on each row, in `attemptStampingCustodyAt`:

- a version that does not know the column leaves it NULL when it **creates** a row;
- a database trigger nulls it when such a version **claims** one;
- rows outside custody are never recycled, and the next sync run marks them as attempted, so the
  ledger is read before anything is posted for them again.

The cost of that repair is one extra ledger read per affected row. There is nothing to run and no
setting to clear — an overlap, a deploy window or a rollback is discovered from the rows themselves.
See `lib/domain/accounting/money-attempt-provenance.ts`.

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
| `REDIS_KEY_PREFIX` | Optional Redis namespace prefix for tenant- or instance-scoped keys. Rate-limit keys become `<prefix>:rate-limit:<key>` |
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
