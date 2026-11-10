# Setup Wizard Walkthrough

The first time you log into One Two Inventory as an administrator, the system shows the **Setup Wizard** (the page title in the top bar; the address is `/onboarding`). This page walks you through it step by step.

You can revisit the wizard at any time before it's completed. A progress list on the left shows the nine steps; you can go back to any step you have already visited. When you reach **All Done** and click **Go to Dashboard**, the wizard is complete and sends you to the dashboard.

> **Beginner tip:** every step saves on its own, so you can leave and come back. **Company Details** and **Currency & FY** cannot be skipped (base currency and the Public App URL must be set before sync or invoicing can work). Every other step has a **Skip** button, and **Next** stays greyed out on a step until it is done, so skip what you don't need yet and come back later.


## What the wizard does (and doesn't)

| Step | What it sets | Can it be done later? |
|---|---|---|
| Welcome | Introduction only | n/a |
| Company Details | Organisation name, address, timezone, Public App URL, contact details, logo, SMTP email | Yes — **Settings > Company**; the Public App URL is under **Settings > System > Scheduler** |
| Currency & FY | Base currency and financial year start | Financial year: yes, in **Settings > Accounting**. Base currency is one-time only |
| Integrations | WooCommerce, Xero and warehouse (WMS) connection credentials | Yes — on **Integrations** in the sidebar and **Settings > System > Plugins** |
| Tax Rates | Review the tax rates and map them to WooCommerce and Xero rates | Yes — **Settings > Accounting > Tax** |
| Warehouses | Review the default warehouse, add more | Yes — **Settings > Inventory** |
| Import Products | CSV import of your product catalogue, or import from WooCommerce | Yes — products can be added one-at-a-time or imported in bulk at any time |
| Opening Stock | CSV import of current stock levels and unit costs | Yes, but do it before trading so cost layers are right from day one |
| All Done | Summary and next-step reminders | n/a |

The wizard does **not** cover:

- **User creation** — the first admin user is created on the server before the wizard runs; add the rest from **Settings > Users**
- **Backups** — see [Backup & Restore](#after-the-wizard-recommended-next-steps) below
- **Cron jobs** — covered by **Save & Apply** on **Settings > System > Scheduler** (see below)
- **Custom roles** — fixed set of 6 roles; not configurable


## Step 1 — Company Details

This step collects your business identity and the system's foundational settings. Your changes are saved when you click **Next**.

### Required fields

- **Company Name** — displayed on PDF documents and the topbar.
- **Address** — used on invoices, sales orders, and packing slips.
- **Timezone** — pick your organisation's timezone from the list (for example `Europe/London`). Dates and times everywhere in the app and on documents are shown in it. If you leave it blank, `Europe/London` is used.
- **Public App URL** — the address customers and integrations use to reach the system, for example `https://ims.yourdomain.com`. The wizard suggests the address you are browsing from (**Use Suggested URL**). It must be a plain `https://` address (`http://` only for `localhost` or `127.0.0.1`) with no spaces, user name or password, `?query` or `#fragment`; anything else is refused with a message saying so. You need it before you can connect Xero.

### Optional but recommended

- **Legal name**, **VAT number** and **company number** — appear on invoices.
- **Phone, email, website** and your **logo**.
- Branding colours and **document numbering** (prefixes such as `INV-`, `SO-` and padding) are set later in **Settings > Company** (Branding and Numbering tabs).

### SMTP (email)

Configure outbound email so the system can send invoices, sales order confirmations, and notifications. It is optional here.

- Enter **SMTP Host**, **Port**, **Security** (TLS / SSL / None), **Username** and **Password**.
- Set **From Name**, **From Email**, **Reply-To**, and the **Sales / Purchases / Support** department emails.
- Use **Test SMTP** to send a test message to the **Test Email Recipient** (pre-filled with the address you signed in with) using the values you have typed.
- Until SMTP is configured and verified, email-dependent flows fail silently. The Mailer logs the error to the activity log.

> **What if I don't have SMTP yet?** Skip the test — you can come back to **Settings > Company > Email** later. Many tenants use Gmail App Passwords, Mailgun, Postmark, or AWS SES.


## Step 2 — Currency & FY

- **Base Currency** — **set once, can't be changed later without resetting the database.** Choose the currency you report and value stock in, typically your home currency, and click **Save Currency**. Once any transaction exists the step says the base currency is locked. If you sell in multiple currencies, others can be added later in **Settings > Accounting > Currencies**; they are converted to base currency for valuation using daily exchange rates (the European Central Bank rates by default).
- **Financial Year Start** — pick the date (e.g. 1 April for the UK fiscal year). Used in analytics period filters.

> **Beginner tip:** if you only sell in your base currency, you don't need any additional currencies.


## Step 3 — Integrations

Connect external systems. Each connector is independent — switch on and set up only what you need. **Next** unlocks only when at least one integration is chosen and every one you chose is connected; otherwise use **Skip** and come back from **Integrations** in the sidebar.

### WooCommerce

If you have a WooCommerce store:

1. Switch on **WooCommerce**. Click **How to get your WooCommerce API keys** for the step-by-step instructions (it opens the [WooCommerce Integration](woocommerce.md) article in a new tab).
2. Enter the **Store URL**, **Consumer Key** and **Consumer Secret**.
3. Click **Save & Test Connection**. The system validates the credentials and verifies the store currency matches your base currency, then shows "Connected to ...".
4. **Webhook Secret:** generate it later on **Integrations > WooCommerce**, then paste the same value into the OneTwoInventory Helper plugin in WordPress (Settings > OneTwoInventory Helper). Rotating it means updating both sides.
5. Sync still needs the **connection test gate** to be satisfied: if you change the credentials later, open **Integrations** and click **Test Connection** again.

### Xero

If you use Xero for accounting:

1. Switch on **Xero**. You must have set the **Public App URL** in the Company Details step first; the buttons are disabled until you have.
2. Click **How to get your Xero Client ID & Secret** for instructions (it opens the [Xero Accounting Sync](xero-sync.md) article). Create the Xero app as described there; its redirect address is `{your Public App URL}/api/accounting/callback`.
3. Enter the **Client ID** and **Client Secret** and click **Save OAuth Settings** (this stores the credentials only), then **Connect & Verify Xero**. You are sent to Xero to authorise and brought back; the step does not let you continue until Xero is connected.
4. After the wizard, open **Integrations > Xero** to click **Sync Chart of Accounts** and map IMS accounts (Sales Revenue, COGS, Inventory Asset, Allocated Inventory, etc.). See [Xero Accounting Sync](xero-sync.md) for the full mapping table. Syncing stays off until a successful **Test Connection** there.

### Warehouse (WMS)

If you use a warehouse management connector (Mintsoft), switch it on and enter its connection details (**Base URL**, **Username**, **Password**, **Webhook Secret**, and an **Order Lookup Connector** if you also run WooCommerce), then **Save & Test Connection**; the save runs a live test so the gate is satisfied at once. Only one WMS connector can be on at a time. Warehouse bindings, courier mapping and the order push are set up after the wizard: see [Warehouse (Mintsoft)](warehouse-mintsoft.md).

The step ends with a **Production readiness** reminder: set the server's `CRON_SECRET`, apply the scheduler settings, and set up backups with a remote target (see below).


## Step 4 — Tax Rates

Review the pre-configured tax rates, add, edit or remove rates as needed, and map them to your connected WooCommerce and Xero rates. Each rate has a country code and a Xero tax type code for accounting sync. Once your connectors are linked, the **Tax rate mapping** card maps your IMS rates to the existing connector tax codes (**Auto-apply**); for rates Xero is missing, use **Generate missing rates** on **Settings > Accounting > Tax** to create and map them. Next is available once at least one tax rate is active. See [Settings](settings.md).


## Step 5 — Warehouses

Review your default warehouse and add more locations if you store inventory in more than one place. Each warehouse tracks its own stock levels. Skip it if one warehouse is enough.


## Step 6 — Import Products

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

Click **New Product** on the Products page later to add one at a time. The form has more options than the CSV template (image upload, full description, etc.).

### Shopping-connector import (optional)

If you've connected WooCommerce, the step shows **Import Products from WooCommerce** (with a progress bar). Products are matched to existing IMS products by SKU. Once the connector is on, products also keep syncing from the store automatically, so use the CSV only for products that are not in your store.


## Step 7 — Opening Stock

Import your current stock levels and unit costs so FIFO cost layers, and therefore cost-of-goods figures, are right from day one.

1. Click **Download template** (`opening-stock-template.csv`). It has one example row to replace.
2. Fill in one row per SKU and warehouse: **sku**, **warehouseCode**, **qty**, **unitCostBase** (cost per unit in your base currency) and an optional **note**. Products and warehouses must exist first.
3. Click **Import Opening Stock CSV**. The step confirms "Opening stock imported successfully."


## Step 8 — All Done

A summary of the steps you completed, and reminders for any integration that still needs work (for example "Complete the Xero OAuth connection", tax-rate and status mapping for WooCommerce, binding a warehouse to your WMS). If you use a WMS, it also reminds you that **WMS Order Dispatch Push** is **off by default** and is switched on in **Settings > System > Scheduler**. Click **Go to Dashboard** to finish.


## After the wizard — recommended next steps

The wizard takes care of the core configuration but doesn't cover everything you'll need for a production deployment. Once the wizard redirects you to the dashboard, work through this checklist:

### Scheduler (do this once)

Scheduled jobs (exchange rates, WooCommerce reconcile, accounting sync, payment checks, daily accounting batch, invariant check and so on) run from the server's crontab. Open **Settings > System > Scheduler**, check the **Public URL** is right, review the jobs (each has a switch and a frequency) and press **Save & Apply**. Do the same after every upgrade, because a job that is new or changed only reaches an existing crontab when you save. The full list with defaults is in [Settings](settings.md#cron-jobs). Your system administrator must also have set a strong `CRON_SECRET` on the server.

### Backup & restore

The system supports scheduled backups, plus optional remote upload to S3 or SFTP.

1. Open **Settings > Backup & Restore > Scheduler**, switch on **Enable scheduled backups**, set retention and save. The time of day is the **Database Backup** job in **Settings > System > Scheduler** (daily at 01:00 by default).
2. Configure a remote target on the **Storage** tab (S3 or SFTP) and set **Auto-upload** so backups are kept off the application server.
3. Click **Create Backup** once and check it appears in the list.
4. Test restore once on a staging environment to confirm backups are readable. See `docs/backup-restore.md`.

### Security hardening

- **Enable 2FA on your admin account** — Profile > Security > **Enable 2FA**.
- **Set strong passwords** — the system enforces minimum 12 characters with at least one uppercase, number, and symbol, plus a deny-list of common passwords.
- **Review activity-log retention** — **Settings > System > Data Retention** (Activity Log Retention). The defaults keep INFO entries 30 days, WARNING 60 days and ERROR 90 days; 0 keeps a level for ever.
- **Rotate CRON_SECRET periodically** — keep the value out of git; rotate every 6 months or after any incident.

### User accounts and roles

- Create additional users from **Settings > Users** (**Add User**). The wizard runs as a single admin user; add team accounts now.
- Six built-in roles (the full table is in [User Management & Security](user-management.md#roles-and-what-each-can-do)):
  - **ADMIN** — full access
  - **MANAGER** — full operational access, including Integrations and Activity; no Settings or user management
  - **WAREHOUSE** — stock, transfers, receiving goods, picking and packing, manufacturing
  - **FINANCE** — purchasing, supplier invoices, refunds, analytics; no stock changes
  - **READONLY** — read everything, change nothing
  - **SUPPLIER** — separate portal; sees only their RFQs and POs

### Get familiar with the dashboard

The dashboard shows real-time KPIs: revenue, COGS, margin, top products, outstanding invoices, low-stock alerts. Pin it to your browser — it's where most operators start their day.


## Troubleshooting the wizard

| Problem | Fix |
|---|---|
| "No stored FX rate available for currency X" | Go to **Settings > Accounting > Currencies** and click **Update Now**, or wait for the daily fetch |
| WC credentials accepted but sync won't activate | Open **Integrations > WooCommerce** and click **Test Connection** (the connection test gate) |
| Xero buttons are greyed out | Set the **Public App URL** in the Company Details step first |
| "Public App URL" is refused | It must be an `https://` address (`http://` only for `localhost` or `127.0.0.1`) with no spaces, user name or password, query or fragment |
| Next is greyed out | The step is not done yet (e.g. no integration connected, no active tax rate, nothing imported). Finish it, or click **Skip** if the step is optional |
| SMTP test email never arrives | Check spam, verify the From email is allowed by your SMTP provider, check the activity log for delivery errors |
| Imported products show no stock | Product import does not set stock. Use the **Opening Stock** step, or receive against a PO |
| Opening stock import refuses rows | The product or the warehouse code does not exist yet; create them first and use the template's column names |
| Can't change base currency | This is intentional — base currency is one-time setup. Use **Settings > System > Database Reset** to start over if needed |

See the full [Troubleshooting](troubleshooting.md) guide for issues that appear later, after the wizard.
