# Configuration Reference

All configuration is via environment variables in the `.env` file.  
Copy `.env.example` to `.env` and edit before starting the app.

---

## Application

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | `development` or `production`. Controls build optimisations and error verbosity. |
| `NEXT_PUBLIC_APP_URL` | Yes | — | Full public URL of the app, no trailing slash. Example: `https://ims.yourdomain.com`. Used for absolute link generation. |
| `AUTH_SECRET` | Yes | — | Secret used to sign Auth.js session tokens and cookies. Generate with `openssl rand -base64 32`. Must be at least 32 characters. **Rotate periodically.** |
| `AUTH_URL` | Yes | — | Same as `NEXT_PUBLIC_APP_URL`. Required by Auth.js for OAuth callback URLs. |

---

## Database

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. Format: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`. Example: `postgresql://imsuser:secret@localhost:5432/onetwo3d_ims`. |

---

## Redis

Used by BullMQ for background job queues (FX rate updates, Xero sync, WooCommerce polling).

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection URL. Format: `redis://[:password@]host[:port][/db]`. Example: `redis://192.168.1.10:6379`. |
| `REDIS_PASSWORD` | No | — | Redis password, if required. Leave blank if Redis has no auth. |

---

## WooCommerce

| Variable | Required | Default | Description |
|---|---|---|---|
| `WC_STORE_URL` | Yes | — | WooCommerce store base URL, no trailing slash. Example: `https://yourstore.com`. |
| `WC_CONSUMER_KEY` | Yes | — | WooCommerce REST API consumer key. Generate at: WooCommerce → Settings → Advanced → REST API. |
| `WC_CONSUMER_SECRET` | Yes | — | WooCommerce REST API consumer secret. |
| `WC_WEBHOOK_SECRET` | Yes | — | Shared secret for verifying incoming WooCommerce webhooks. Set the same value in each webhook's "Secret" field in WooCommerce. |
| `WC_SYNC_STATUSES` | No | `processing` | Comma-separated WooCommerce order statuses that trigger sync into IMS. Example: `processing,on-hold`. |
| `WC_USE_WEBHOOKS` | No | `true` | `true` = use WooCommerce webhooks (recommended). `false` = poll on an interval. |
| `WC_POLL_INTERVAL_MINUTES` | No | `5` | Only used when `WC_USE_WEBHOOKS=false`. How often to poll WooCommerce for new/updated orders. |

---

## Xero

Xero uses OAuth 2.0. Create an app at [developer.xero.com](https://developer.xero.com).

| Variable | Required | Default | Description |
|---|---|---|---|
| `XERO_CLIENT_ID` | Yes | — | OAuth 2.0 client ID from Xero Developer Portal. |
| `XERO_CLIENT_SECRET` | Yes | — | OAuth 2.0 client secret from Xero Developer Portal. |
| `XERO_TENANT_ID` | No | — | Xero organisation (tenant) ID. Retrieved automatically after the OAuth flow and stored in the database. Leave blank on first run. |
| `XERO_TOKEN_PATH` | No | `/var/lib/onetwo3d-ims/xero/token.json` | File path where the Xero OAuth refresh token is persisted. Must be writable by the app process and outside the app directory (not in git). |

### Setting up the Xero OAuth app

1. Go to [developer.xero.com](https://developer.xero.com) → **My Apps** → **New App**
2. App type: **Web app**
3. Company name: OneTwo3D Ltd
4. OAuth 2.0 redirect URI: `https://ims.yourdomain.com/api/sync/xero/callback`
5. Copy the **Client ID** and **Client Secret** into `.env`
6. Scopes required: `accounting.transactions`, `accounting.journals.read`, `accounting.settings.read`, `accounting.contacts`, `offline_access`

---

## FX Rates

| Variable | Required | Default | Description |
|---|---|---|---|
| `FX_API_KEY` | Yes | — | API key from [exchangerate-api.com](https://www.exchangerate-api.com). The free tier allows 1,500 requests/month — more than sufficient with hourly refresh. |
| `FX_BASE_CURRENCY` | No | `GBP` | Base currency for all internal calculations. All stored GBP amounts are converted from this currency. |
| `FX_REFRESH_CRON` | No | `0 * * * *` | Cron expression for how often to fetch fresh FX rates. Default: every hour on the hour. |

---

## SMTP

Used for sending Purchase Order PDFs and RFQ emails to suppliers.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | Yes | — | SMTP server hostname. Example: `smtp.postmarkapp.com`. |
| `SMTP_PORT` | No | `587` | SMTP port. Common values: `587` (STARTTLS), `465` (SSL), `25` (plain). |
| `SMTP_SECURE` | No | `tls` | Encryption method: `tls` (STARTTLS on port 587), `ssl` (TLS on port 465), `none` (unencrypted). |
| `SMTP_USER` | Yes | — | SMTP authentication username. |
| `SMTP_PASSWORD` | Yes | — | SMTP authentication password. |
| `SMTP_FROM_EMAIL` | Yes | — | From address shown on outgoing emails. Example: `ims@yourdomain.com`. |
| `SMTP_FROM_NAME` | No | `OneTwo3D IMS` | From name shown on outgoing emails. |

---

## File Paths

| Variable | Required | Default | Description |
|---|---|---|---|
| `PDF_TEMP_DIR` | No | `/tmp/onetwo3d-ims/pdf` | Directory for temporarily storing generated PDFs before download/email. Must be writable. |
| `UPLOAD_MAX_SIZE_MB` | No | `10` | Maximum file size for CSV uploads (MB). |
| `UPLOAD_TEMP_DIR` | No | `/tmp/onetwo3d-ims/uploads` | Directory for temporarily storing uploaded CSV files during import. Must be writable. |

---

## Logging

| Variable | Required | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | No | `info` | Minimum log level to output: `error`, `warn`, `info`, `debug`. Use `debug` only in development — it is very verbose. |
| `LOG_FORMAT` | No | `json` | Log output format: `json` (structured, for log aggregators) or `pretty` (human-readable, for development). |

---

## Settings stored in the database

The following are configured via the **Settings** UI in the app, not via `.env`. They are stored in the `settings` table and can be changed without restarting the app.

| Setting | Description |
|---|---|
| Organisation name, address, VAT number | Appears on PO/RFQ PDFs |
| Warehouses | Code, name, type, sale eligibility, WC sync flag |
| Default warehouse | Used when no warehouse is specified |
| Default return warehouse | Used for refund returns (default: QUA) |
| Warehouses synced to WooCommerce | Which warehouse stock totals are pushed to WC |
| WooCommerce sync order statuses | Overrides `WC_SYNC_STATUSES` env var if set |
| Xero account mappings | Maps IMS transaction types to Xero account codes |
| Tax rates | Rate, name, country, default flag |
| Currencies | Active currencies, display symbol |
| Financial year start | Month and day (default: 01 May) |
| Branding | Logo upload, primary colour |

---

## Security Notes

- `.env` is listed in `.gitignore` — **never commit it**
- Set file permissions: `chmod 600 /opt/onetwo3d-ims/.env`
- `AUTH_SECRET` controls session security — treat it like a private key
- `WC_WEBHOOK_SECRET` and `XERO_CLIENT_SECRET` are sensitive — do not log them
- The Xero token file (`XERO_TOKEN_PATH`) contains an OAuth refresh token — set it to `chmod 600` and keep it outside the app directory
