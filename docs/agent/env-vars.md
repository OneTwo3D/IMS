# Environment variables (reference)

> Moved verbatim from CLAUDE.md (bd ids dropped). The `check:documented-env-vars` guard reads the first-column names in this file, so keep the table shape. `.env.example` is the complete list.

## Environment Variables

Copy `.env.example` to `.env` and configure. Uses **NextAuth.js v5** variable naming:

### Application & Authentication

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NEXT_PUBLIC_APP_URL` | Yes | Full public app URL (no trailing slash) | `https://ims.yourdomain.com` |
| `NODE_ENV` | Yes | Environment mode | `production` or `development` |
| `AUTH_SECRET` | Yes | Encryption key for Auth.js sessions (min 32 chars) | Generate with `openssl rand -base64 32` |
| `AUTH_URL` | Yes | Auth.js base URL (same as NEXT_PUBLIC_APP_URL) | `https://ims.yourdomain.com` |

### Database

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/oti` |

### WooCommerce Integration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `WC_STORE_URL` | No | WooCommerce store base URL (no trailing slash). **Install-time seed only** — `scripts/provision-instance.mjs` writes it into the `wc_url` setting on a fresh install (insert-only); it never overrides what Settings → Sync → WooCommerce holds | `https://yourstore.com` |
| `WC_CONSUMER_KEY` | No | WC REST API consumer key. **Install-time seed only** — seeded into the `wc_consumer_key` setting once, then owned by Settings → Sync → WooCommerce | From WC admin → Settings → Advanced → REST API |
| `WC_CONSUMER_SECRET` | No | WC REST API consumer secret. **Install-time seed only** — seeded into the `wc_consumer_secret` setting once, then owned by Settings → Sync → WooCommerce. Editing it in `.env` after install changes nothing | From WC admin → Settings → Advanced → REST API |
| `WC_WEBHOOK_SECRET` | No | WC webhook signing key | Any random string (set same in WC webhooks config) |

> `WC_STORE_URL` is an **install-time seed only**. `scripts/provision-instance.mjs` writes it into
> the `wc_url` setting on a fresh install, insert-only, and it is deliberately **not** in
> `SETTING_ENV_FALLBACKS`: the installer writes the line into every `.env`, so an override would
> repoint an installation that had since been moved to a different store back to the old one on its
> next upgrade — and only half of the code reads `wc_url` through the settings store, so the two
> halves would target different stores. `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET` /
> `WC_WEBHOOK_SECRET` / `WC_INVOICE_PDF_SECRET` **are** runtime overrides; the Connection tab shows
> an "overridden by" banner while one is set.

> Which order statuses import is **not** an environment variable. It is an application setting
> edited in Settings -> Sync -> WooCommerce and stored in the `settings` table
> (`wc_sync_order_statuses`); the importer reads it from the database. The POLL CADENCE is neither
> an env var nor a sync setting: it is the `wc-reconcile` cron schedule
> (`cron_wc_reconcile_schedule`, default `0 4 * * *`), edited in Settings -> System -> Scheduler.
> `wc_sync_interval_minutes` was a settings field offering a minutes box that no code read, and was
> removed for that reason. `WC_SYNC_STATUSES`, `WC_USE_WEBHOOKS` and `WC_POLL_INTERVAL_MINUTES` were
> documented here and read by nothing - setting them silently changed nothing.

> `wc_sync_order_statuses` decides which orders IMS **takes on**. It governs every route that
> **fetches** orders from WooCommerce - the initial "Import Active Orders" backfill, the polling
> sweep and the reconcile sweeps - because each turns the selection into a `?status=` query. The
> rules live in one place, `lib/connectors/woocommerce/order-status-filter.ts`, shared by the
> importer and the Sync page.
> It governs the order **webhook** too, as an **admission** rule rather than a fetch filter
> (`isWcOrderAdmittedByStatus`): a pushed order IMS has never seen is created only if its current
> status is selected, and one that later moves into a selected status is created by THAT update from
> its own full payload. An order IMS already holds is never gated - it keeps following the store
> whatever status it moves to afterwards, which is what stops IMS disagreeing with the store about an
> order it owns. Withdrawal statuses are always admitted; an empty selection admits nothing. Refused
> deliveries are ACKed (never retried) and logged as `wc_order_webhook_status_not_admitted`, at most
> hourly. The status still governs what an imported order does, via `shopping_status_mappings`. Keep
> the Sync page copy, `docs/installation.md` and `lib/connectors/woocommerce/webhooks.ts` in step.

### Xero Integration (OAuth 2.0)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `XERO_TENANT_ID` | No | **Deprecated** — a single-organisation spelling of `XERO_ALLOWED_TENANT_IDS`, enforced identically. It is *not* auto-populated (it never was, and for years nothing read it at all). Setting it alongside `XERO_ALLOWED_TENANT_IDS` with a different value refuses every Xero connection rather than preferring one; setting it alongside `XERO_ALLOWED_TENANT_NAMES` is fine, because a name only narrows what the id already chose. | `5c949ed5-…` |
| `XERO_ALLOWED_TENANT_IDS` | No | Comma-separated allow-list of Xero tenant ids this instance may connect to or keep a stored token for. Blank = unrestricted. The only key that can **allow** an organisation. | `5c949ed5-…` |
| `XERO_BLOCKED_TENANT_IDS` | No | Comma-separated tenant ids refused everywhere, applied before every other check. On a test rig, block the **live** organisation: its id never changes, so unlike an allow-list this needs no edit when the connected test organisation is re-created with a new tenantId. Listing an id on both this and the allow-list is a refused contradiction, not a silent deny-wins. | `e7fb4378-…` |
| `XERO_REQUIRE_DEMO_ORG` | No | `true`/`false`. Restricts this instance to a Xero **demo** organisation, proven from Xero's own `IsDemoCompany` on `GET /Organisation` — identity-strength without an id, so it survives the Demo company's ~28-day re-creation with no edit and, unlike a deny-list, does not have to enumerate the organisations it forbids. Enforced at the callback and on the stored token; a stored token whose demo status was never recorded is refused as unverified. A value that is neither yes nor no refuses every Xero connection instead of silently meaning off. | `true` |
| `XERO_ALLOWED_TENANT_NAMES` | No | Organisation names that **narrow** the ids — case-insensitive, never a union. A Xero name is not an identity (not unique, and renameable by whoever administers the org), so it can never admit an organisation the ids exclude, a name matching two organisations on one consent is refused rather than used to choose, and a name-only configuration is logged as weaker than it looks. Set an **id-based** control on every non-production instance. | `Demo Company (UK)` |

> The OAuth client id and secret are **not** environment variables. They are entered in
> Settings -> Integrations -> Xero and stored in the `settings` table (`xero_client_id`,
> `xero_client_secret`, encrypted at rest); `lib/connectors/xero/auth.ts` reads them from there.
> `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` were documented here and read by nothing.

> Xero OAuth tokens are **not** stored in a file. There is no `XERO_TOKEN_PATH`: the access/refresh
> tokens are persisted **encrypted in Postgres** (settings/connector rows, decrypted with
> `SETTINGS_ENCRYPTION_KEY`).

### Foreign Exchange Rates

> The base currency is `Organisation.baseCurrency`, set once in Settings -> Company and read by
> `lib/base-currency.ts` (default `GBP`). `FX_BASE_CURRENCY` was documented here and read by
> nothing, including the installer.

Note: FX rates are fetched daily via cron job (`/api/cron/fx-rates`) using free [frankfurter.dev](https://frankfurter.dev) API (ECB data, no API key required).

### Email (SMTP)

These are an **install-time seed only**. `scripts/provision-instance.mjs` reads them once and
writes them into the `settings` table (`email_smtp_*`); at runtime `lib/mailer.ts` reads those
settings and never the environment. Editing them on a running install changes nothing - change
mail settings in Settings -> Email.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SMTP_HOST` | No | Email server hostname | `smtp.gmail.com` |
| `SMTP_PORT` | No | Email server port | `587` |
| `SMTP_SECURE` | No | Encryption type | `tls`, `ssl`, or `none` |
| `SMTP_USER` | No | SMTP username | `noreply@company.com` |
| `SMTP_PASS` | No | SMTP password (spelled `SMTP_PASS`, not `SMTP_PASSWORD`) | App-specific password (not your account password) |
| `SMTP_FROM_EMAIL` | No | From address on emails | `ims@yourdomain.com` |
| `SMTP_FROM_NAME` | No | From name on emails | `onetwoInventory` |
| `SMTP_REPLY_TO` | No | Reply-to address on emails | `support@yourdomain.com` |

### File Storage & Uploads

See `.env.example` for the storage roots that are actually read (`UPLOAD_STORAGE_DIR`,
`PUBLIC_UPLOAD_STORAGE_DIR`, `INVOICE_PDF_STORAGE_DIR`, `BACKUP_DIR`).

> `PDF_TEMP_DIR`, `UPLOAD_TEMP_DIR` and `UPLOAD_MAX_SIZE_MB` were documented here and read by
> nothing. Generated PDFs are never written to disk (`lib/pdf.ts` buffers them),
> temporary scan/upload paths come from `os.tmpdir()`, and the size caps are per-kind constants:
> 10 MB CSV import (`app/actions/import.ts`), 2 MB avatar / 5 MB logo / 20 MB supplier invoice
> (`lib/security/upload-validation.ts`).

### Logging

There is no logger module and no log configuration: output is plain `console.*` at fixed severity.
`LOG_LEVEL` and `LOG_FORMAT` were documented here and read by nothing.

See `.env.example` for complete list and additional settings.

