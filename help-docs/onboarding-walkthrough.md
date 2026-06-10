# Setup Wizard Walkthrough

The first time you log into One Two Inventory as an administrator, the system shows a setup wizard at `/onboarding`. This page walks you through it step by step.

You can revisit the wizard at any time before it's completed. Once all required steps are done, it redirects you to the dashboard automatically.

> **Beginner tip:** the wizard is designed so you can complete steps in any order. Skip what you don't need yet, come back later. The only rule is that you can't skip "Company" — base currency and public app URL must be set before sync or invoicing can work.


## What the wizard does (and doesn't)

| Step | What it sets | Can it be done later? |
|---|---|---|
| Company | Organisation name, address, base currency, public app URL, SMTP, branding | Some details can be edited later in **Settings > Company**; base currency is one-time only |
| Currency | Default tax rate, additional currencies, financial year start | Yes — fully editable in **Settings > Accounting** |
| Integrations | WooCommerce, Shopify, Xero, QuickBooks, Mintsoft connection credentials | Yes — fully editable in **Settings > Integrations** |
| Products | CSV import of your product catalogue | Yes — products can be added one-at-a-time or imported in bulk at any time |

The wizard does **not** cover:

- **User creation** — admin user is created via the CLI before the wizard runs (`npm run cli -- create-user`)
- **Backups** — see [Backup & Restore](#after-the-wizard-recommended-next-steps) below
- **Cron jobs** — your system administrator configures these (see installation guide)
- **Custom roles** — fixed set of 6 roles; not configurable


## Step 1 — Company

This step collects your business identity and the system's foundational settings.

### Required fields

- **Organisation name** — displayed on PDF documents and the topbar.
- **Address** — used on invoices, sales orders, and packing slips.
- **Base currency** — **set once, can't be changed later without resetting the database.** Choose the currency you report and value stock in. This is typically your home currency. If you sell in multiple currencies, the others can be added later as "additional currencies" — they get converted to base currency for valuation.
- **Public app URL** — the URL customers and integrations will use to reach the system. For self-hosted setups, this is usually `https://ims.yourdomain.com`. The wizard auto-detects this from your browser session and pre-fills it.

### Optional but recommended

- **VAT number** and **company number** — appear on invoices.
- **Branding** (logos and colours) — uploaded here, applied across PDF documents and the UI.
- **Document numbering** — set prefixes (e.g. `INV-`, `SO-`) and padding (e.g. 5 digits → `00001`) for each document type.

### SMTP (email)

Configure outbound email so the system can send invoices, sales order confirmations, and notifications.

- Enter SMTP host, port, security mode (TLS / SSL / none), username, and password.
- Set **From name** and **From email**.
- Use the **Send test email** button to verify it works. The test goes to the email address you signed in with.
- Until SMTP is configured and verified, email-dependent flows fail silently. The Mailer logs the error to the activity log.

> **What if I don't have SMTP yet?** Skip the test email — you can come back to **Settings > Company > Email** later. Many tenants use Gmail App Passwords, Mailgun, Postmark, or AWS SES.


## Step 2 — Currency

Configure currencies, tax rates, and your financial year.

- **Financial year start** — pick the date (e.g. `01-04` for the UK fiscal year). Used in analytics period filters.
- **Tax rates** — define at least one VAT rate (e.g. "UK Standard 20%"). Each rate has a country code and a Xero tax type code for accounting sync.
- **Additional currencies** — if you sell to multiple currencies, add them here. The system fetches daily exchange rates from the European Central Bank automatically; you can also pin manual rates per currency.

> **Beginner tip:** if you only sell in your base currency, you can leave the additional-currencies list empty.


## Step 3 — Integrations

Connect external systems. Each connector is independent — set up only what you need.

### WooCommerce

If you have a WooCommerce store:

1. Get your WC REST API keys from `WooCommerce → Settings → Advanced → REST API` in WordPress.
2. In the wizard, enter the store URL, consumer key, and consumer secret.
3. Save settings — the system validates the credentials and verifies the store currency matches your base currency.
4. **Important (added in PR #152):** sync remains DISABLED until you visit **Sync → WooCommerce** and click **Test Connection**. The connection test gate prevents the system from quietly running with stale or wrong credentials.
5. Install the **OneTwoInventory Helper** WordPress plugin (downloadable from the WC sync page) and paste the same webhook secret. This enables FX rate pushes and customer-facing invoice PDF buttons.

### Xero

If you use Xero for accounting:

1. Create a Xero OAuth 2.0 app at app.xero.com → My Apps. Use redirect URL `{publicAppUrl}/api/xero/callback`.
2. In the wizard, enter the Xero client ID and client secret.
3. Click **Connect to Xero** — you'll be redirected to Xero to authorise.
4. After OAuth completes, click **Sync Chart of Accounts** to pull your accounts list.
5. Map IMS account types to Xero accounts (Sales Revenue, COGS, Inventory Asset, Allocated Inventory, etc.). See `xero-sync.md` for the full mapping table.
6. **Connection test gate:** like WooCommerce, sync remains disabled until you successfully test from **Sync → Xero**.

### Shopify, QuickBooks, Mintsoft

Each follows a similar pattern — paste credentials, the system tests them, then sync becomes available. Mintsoft is unusual in that the save step also runs a live API test, so the gate is satisfied immediately.


## Step 4 — Products

Upload your product catalogue.

### Bulk CSV import

1. Download the CSV template from the products step. The template includes example rows for each product type.
2. Fill in your products. Key fields:
   - **sku** — must be unique.
   - **name** — display name.
   - **type** — `SIMPLE`, `VARIABLE`, `VARIANT`, `KIT`, `BOM`, or `NON_INVENTORY`.
   - **parentSku** — for VARIANT rows, the SKU of the parent Variable product.
   - **lifecycleStatus** — `DRAFT` for products under review, `ACTIVE` for live-and-sellable.
   - **preferredSupplierId** / **preferredSupplierName** — leave blank if not yet known; the system will populate it on first PO.
   - **active** — `TRUE` or `FALSE` for legacy compatibility (newer installs use `lifecycleStatus` instead).
3. Upload the CSV. The import returns a report of created, updated, skipped, and failed rows.

> **Beginner tip — lifecycle policy on first import:**
> - For products that are ready for the storefront, set `lifecycleStatus = ACTIVE`.
> - For products you want to review before publishing, set `lifecycleStatus = DRAFT`. Draft products can be purchased (POs work) but aren't sellable until you switch them to ACTIVE.
> - Don't use EOL or ARCHIVED for fresh imports — those are sell-off states.

### Manual entry

Click **New Product** to add one at a time. The form has more options than the CSV template (image upload, full description, etc.).

### Shopping-connector import (optional)

If you've connected WooCommerce or Shopify, the products step lets you import the catalogue directly from the storefront. Products are created with `lifecycleStatus = ACTIVE` and matched to existing IMS products by SKU.


## After the wizard — recommended next steps

The wizard takes care of the core configuration but doesn't cover everything you'll need for a production deployment. Once the wizard redirects you to the dashboard, work through this checklist:

### Backup & restore

The system supports scheduled local backups via cron, plus optional remote upload to S3 or SFTP.

1. Verify `CRON_SECRET` is set in your environment.
2. Schedule the backup cron (`/api/cron/backup`) to run daily — typically at 02:00 system time.
3. (Optional) Configure remote upload in **Settings > Backup** to keep backups off the application server.
4. Test restore once on a staging environment to confirm backups are readable. See `docs/backup-restore.md`.

### Cron jobs (production deployment)

Several scheduled jobs must run for the system to function correctly:

| Cron | Purpose | Cadence |
|---|---|---|
| `/api/cron/fx-rates` | Fetch daily exchange rates | Daily |
| `/api/cron/wc-reconcile` | WooCommerce reconciliation + stock catch-up | Daily |
| `/api/cron/accounting-daily-batch` | Xero sub-ledger A1/A2/B journals | Daily |
| `/api/cron/accounting-sync` | Process pending journal queue | Every 5 minutes |
| `/api/cron/accounting-payment-poll` | Detect paid invoices via Xero bank feed | Every 15 minutes |
| `/api/cron/delivery-status` | Poll tracking provider for delivery updates | Every 15 minutes |
| `/api/cron/account-balance-snapshot` | Snapshot Xero account balances | Daily |
| `/api/cron/invariant-check` | Scheduled data-integrity check | Daily |
| `/api/cron/backup` | Database backup | Daily |
| `/api/cron/product-lifecycle-archive` | Auto-archive exhausted EOL products | Daily |

Your system administrator configures these. The installation guide has copy-paste cron entries.

### Security hardening

- **Enable 2FA on your admin account** — Settings > Profile > 2FA.
- **Set strong passwords** — the system enforces minimum 12 characters with at least one uppercase, number, and symbol, plus a deny-list of common passwords. CLI user creation honours this policy.
- **Review activity-log retention** — Settings > System > Activity Log. The default keeps WARNING and ERROR forever but truncates INFO entries older than 90 days.
- **Rotate CRON_SECRET periodically** — keep the value out of git; rotate every 6 months or after any incident.

### User accounts and roles

- Create additional users from **Settings > Users**. The wizard runs as a single admin user; add team accounts now.
- Six built-in roles:
  - **ADMIN** — full access
  - **MANAGER** — full operational access; no settings or user management
  - **WAREHOUSE** — stock, transfers, picking/packing
  - **FINANCE** — invoices, payments, accounting reports, no inventory mutations
  - **READONLY** — read everything, change nothing
  - **SUPPLIER** — separate portal; sees only their RFQs and POs

### Get familiar with the dashboard

The dashboard shows real-time KPIs: revenue, COGS, margin, top products, outstanding invoices, low-stock alerts. Pin it to your browser — it's where most operators start their day.


## Troubleshooting the wizard

| Problem | Fix |
|---|---|
| "No stored FX rate available for currency X" | Visit **Settings > Accounting > FX Rates** and run **Update Now**, or wait for the daily fetch |
| WC credentials accepted but sync won't activate | Visit **Sync > WooCommerce** and click **Test Connection** (PR #152's connection test gate) |
| SMTP test email never arrives | Check spam, verify the From email is allowed by your SMTP provider, check the activity log for delivery errors |
| Imported products show wrong stock | Stock is set by goods receipt, not import — receive against a PO to populate stock |
| Wizard keeps redirecting back to a previous step | The step's gating condition isn't met (e.g. company has no name, base currency unset). Scroll to find the highlighted field |
| Can't change base currency | This is intentional — base currency is one-time setup. Use **Settings > System > Database Reset** to start over if needed |

See the full [Troubleshooting](troubleshooting.md) guide for issues that appear later, after the wizard.
