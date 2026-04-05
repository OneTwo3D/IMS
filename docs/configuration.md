# Configuration Reference

All configuration is via environment variables in the `.env` file and via the in-app Settings page.
Copy `.env.example` to `.env` and fill in all values before starting the application.

---

## Application

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | `development` or `production`. Controls build optimisations and error verbosity. |
| `NEXT_PUBLIC_APP_URL` | Yes | -- | Full public URL of the app, no trailing slash. Example: `https://ims.yourdomain.com`. Used for absolute link generation. |
| `AUTH_SECRET` | Yes | -- | Secret used to sign Auth.js session tokens and cookies. Generate with `openssl rand -base64 32`. Must be at least 32 characters. |
| `AUTH_URL` | Yes | -- | Same as `NEXT_PUBLIC_APP_URL`. Required by Auth.js for callback URLs. |

---

## Database

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string. Format: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`. |

Prisma 7 with the `pg` driver adapter is used. The Prisma client is generated to `app/generated/prisma`.

---

## WooCommerce

| Variable | Required | Default | Description |
|---|---|---|---|
| `WC_STORE_URL` | Yes | -- | WooCommerce store base URL, no trailing slash. |
| `WC_CONSUMER_KEY` | Yes | -- | REST API consumer key. Generate at: WooCommerce > Settings > Advanced > REST API. |
| `WC_CONSUMER_SECRET` | Yes | -- | REST API consumer secret. |
| `WC_WEBHOOK_SECRET` | Yes | -- | Shared secret for verifying incoming WooCommerce webhooks. Set the same value in each webhook's "Secret" field. |
| `WC_SYNC_STATUSES` | No | `processing` | Comma-separated WooCommerce order statuses that trigger sync into IMS. Example: `processing,on-hold`. |
| `WC_USE_WEBHOOKS` | No | `true` | `true` = use webhooks (recommended). `false` = poll on an interval. |
| `WC_POLL_INTERVAL_MINUTES` | No | `5` | Only used when `WC_USE_WEBHOOKS=false`. Polling frequency in minutes. |

---

## Xero

Xero uses OAuth 2.0. Create an app at [developer.xero.com](https://developer.xero.com).

| Variable | Required | Default | Description |
|---|---|---|---|
| `XERO_CLIENT_ID` | Yes | -- | OAuth 2.0 client ID from Xero Developer Portal. |
| `XERO_CLIENT_SECRET` | Yes | -- | OAuth 2.0 client secret. |
| `XERO_TENANT_ID` | No | -- | Xero organisation (tenant) ID. Retrieved automatically after OAuth flow. Leave blank on first run. |
| `XERO_TOKEN_PATH` | No | `/var/lib/onetwo3d-ims/xero-token.json` | File path for persisting the Xero OAuth refresh token. Must be writable and outside the app directory. |

### Setting Up the Xero OAuth App

1. Go to [developer.xero.com](https://developer.xero.com) > My Apps > New App
2. App type: Web app
3. OAuth 2.0 redirect URI: `https://ims.yourdomain.com/api/sync/xero/callback`
4. Copy the Client ID and Client Secret into `.env`
5. Required scopes: `accounting.transactions`, `accounting.journals.read`, `accounting.settings.read`, `accounting.contacts`, `offline_access`

---

## FX Rates

FX rates are fetched from the frankfurter.dev API (free, no API key required) via a daily cron job that hits `/api/cron/fx-rates` at 06:00.

| Variable | Required | Default | Description |
|---|---|---|---|
| `FX_BASE_CURRENCY` | No | `GBP` | Base currency for all internal calculations. |

The cron is set up as a system crontab entry that runs `curl` against `/api/cron/fx-rates` daily at 06:00:

```cron
0 6 * * * curl -fsS http://localhost:3000/api/cron/fx-rates > /dev/null 2>&1
```

---

## SMTP

Used for sending RFQ and PO PDFs to suppliers via email.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | Yes | -- | SMTP server hostname. |
| `SMTP_PORT` | No | `587` | SMTP port. Common: `587` (STARTTLS), `465` (SSL), `25` (plain). |
| `SMTP_SECURE` | No | `tls` | Encryption: `tls`, `ssl`, or `none`. |
| `SMTP_USER` | Yes | -- | SMTP authentication username. |
| `SMTP_PASSWORD` | Yes | -- | SMTP authentication password. |
| `SMTP_FROM_EMAIL` | Yes | -- | From address on outgoing emails. |
| `SMTP_FROM_NAME` | No | `OneTwo3D IMS` | From name on outgoing emails. |

---

## File Paths

| Variable | Required | Default | Description |
|---|---|---|---|
| `PDF_TEMP_DIR` | No | `/tmp/onetwo3d-ims/pdf` | Temporary directory for generated PDFs. Must be writable. |
| `UPLOAD_MAX_SIZE_MB` | No | `10` | Maximum file size for CSV uploads (MB). |
| `UPLOAD_TEMP_DIR` | No | `/tmp/onetwo3d-ims/uploads` | Temporary directory for uploaded files during import. Must be writable. |

---

## Logging

| Variable | Required | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | No | `info` | Minimum log level: `error`, `warn`, `info`, `debug`. |
| `LOG_FORMAT` | No | `json` | Output format: `json` (structured) or `pretty` (human-readable). |

---

## Settings Page (In-App Configuration)

The following settings are managed through the Settings page in the app UI (`/settings`). They are stored in the `settings` and related database tables and take effect immediately without restarting the application.

### VAT Rates

Manage tax rates used across purchases and sales. Each rate has:
- **Name** -- descriptive label (e.g. "UK Standard Rate")
- **Rate** -- percentage as a decimal (e.g. 0.2000 for 20%)
- **Used for** -- SALES, PURCHASE, or BOTH
- **Xero tax type code** -- maps to the corresponding Xero tax type (e.g. "OUTPUT2", "INPUT2")
- **Default** flag -- which rate to pre-select on new orders

### Currencies and FX Rates

- Add/remove active currencies (ISO 4217 codes)
- Set currency type: SALES, PURCHASE, or BOTH
- View current FX rates (fetched automatically from frankfurter.dev)
- Manual rate override if needed

Currency symbols are displayed **after** amounts throughout the application (e.g. "2.99 GBP"). All currency values are displayed with 2 decimal places.

### Landed Cost Distribution Method

Global default method for distributing freight/landed costs across purchase order lines:
- **BY_VALUE** -- proportional to line value
- **BY_WEIGHT** -- proportional to product weight
- **BY_QUANTITY** -- proportional to line quantity
- **EQUAL_SPLIT** -- equal amount per line

Can be overridden per `LandedCostLink`.

### Invoice Generation Trigger

Controls when sales invoices are automatically generated:
- **On ship** -- invoice generated when order status changes to SHIPPED
- **On paid** -- invoice generated when payment is recorded
- **Manual** -- invoices must be generated manually

### Purchase Units

Define packaging units with stock unit conversion factors:
- **Name** -- e.g. "Box of 100", "Roll (1km)", "Pallet of 48"
- **Abbreviation** -- e.g. "box", "roll", "plt"
- **Conversion factor** -- 1 purchase unit = X stock units
- **Stock unit name** -- what each stock unit is called (e.g. "pcs", "m", "sheets")

### Stock Adjustment Reasons

Configurable list of reasons for stock adjustments:
- **Name** -- e.g. "Damaged", "Miscounted", "Returned to stock"
- **Xero account code** -- optional link to a Xero expense account
- **Sort order** and **active** flag

### Organisation Details

Company information used on PDF documents:
- Company name, legal name, VAT number, company number
- Address fields
- Phone, email, website
- Logo URL
- Base currency and financial year start (month/day)

### Warehouse Configuration

Managed via the Warehouses section:
- **Code** and **name**
- **Type**: STANDARD, QUARANTINE, or RESTOCK
- **Available for sale** -- whether stock counts toward saleable inventory
- **Sync to WooCommerce** -- include in WC stock push
- **Default warehouse** and **default return warehouse** flags

---

## Security Notes

- `.env` is in `.gitignore` -- never commit it to version control
- Set file permissions: `chmod 600 /opt/onetwo3d-ims/.env`
- `AUTH_SECRET` controls session security -- treat it like a private key
- Rotate `AUTH_SECRET` periodically (existing sessions will be invalidated)
- `WC_WEBHOOK_SECRET` and `XERO_CLIENT_SECRET` are sensitive -- do not log them
- The Xero token file (`XERO_TOKEN_PATH`) contains an OAuth refresh token -- set `chmod 600` and keep outside the app directory
