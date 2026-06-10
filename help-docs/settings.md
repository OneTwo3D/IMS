# Settings

Settings are organised in the sidebar by function. Some sections, such as **Accounting**, only appear when the related integration plugin is enabled.

## Company Settings

Found at **Settings > Company**, this is where you configure your organisation's core details and branding.

### Company Details

- **Company name** and **legal name**
- **VAT number** and **company number**
- **Address** (used on documents and invoices)
- **Contact information**
- **Base currency** — set this once during initial setup. After live data exists, changing it requires a database reset.

Base-currency amounts throughout the app use the configured currency's display style, including whether the symbol appears before or after the amount.

### Logos

Upload two logos for use across the system:

- **Icon logo** — a square image used in the sidebar and on the login page
- **Document logo** — a rectangular image used in PDF headers (invoices, sales orders, etc.)

### Branding

Customise the look of the application and your documents:

- **Primary colour** — sets the title bar colour
- **Accent colour** — sets the table header colour

A live preview updates as you adjust colours, so you can see the result before saving.

### Document Numbering

Configure the prefix and padding for auto-generated document numbers:

| Document Type | Example |
|---|---|
| Sales Order | SO-00001 |
| Purchase Order | PO-00001 |
| Invoice | INV-00001 |
| Credit Note | CN-00001 |

Set your preferred prefix (e.g. `SO`, `INV`) and padding length (e.g. 5 digits) for each type.

### Email / SMTP

Configure outbound email for sending documents and notifications:

- **SMTP host**, **port**, and **security** (TLS/SSL)
- **Credentials** (username and password)
- **From name** and **from email address**
- **Reply-to address**

### Department Emails

Set dedicated email addresses for each department. These appear on the relevant documents:

- **Sales email** — shown on invoices and sales orders
- **Purchases email** — shown on purchase orders and RFQs
- **Support email** — for general enquiries

### Document Templates

Configure templates for seven document types:

- Sales Order
- Purchase Order
- Invoice
- Packing Slip
- Credit Note
- RFQ (Request for Quotation)
- Manufacturing Order

Each template supports:

- **Header note** — text displayed at the top of the document
- **Footer note** — text displayed at the bottom of the document body
- **Terms & conditions** — printed on the document
- **Custom page footer** — appears at the very bottom of each page
- **Show logo** toggle
- **Show VAT** toggle
- **Show payment terms** toggle

Use the **PDF preview** and **Email preview** buttons to see how your template looks with sample data. Previews open in a new tab.

## Inventory Settings

Found at **Settings > Inventory**, this section includes:

- **Warehouses** — create and edit warehouses, default sales/returns warehouses, and store-sync eligibility when a shopping connector is enabled
- **Stock adjustment reasons** — define selectable reasons for manual stock adjustments
- **Accounting mapping** — when an accounting connector is enabled, each adjustment reason can be linked to an account code

## Sales Settings

Set the **invoice generation trigger** to control when invoices are created automatically:

- **Manual** — generate invoices yourself
- **On ship** — invoice created when the order is shipped
- **On paid** — invoice created when the order is fully paid

### Delivery Tracking

Toggle the delivery tracking module on or off. When enabled:

- **Source** — choose between WooCommerce (AST plugin) or TrackShip API direct
- **Shipping carriers** — configure which carriers are available in the carrier dropdown when shipping orders. Pre-populated with common carriers: Royal Mail, DPD, DHL, FedEx, UPS, Hermes/Evri, Yodel, Parcelforce, TNT, Amazon Logistics, GLS, USPS, and more.
- **Tracking links** — when delivery tracking is enabled, tracking numbers become clickable links that open the carrier's tracking website. A 17track fallback is used for carriers without a dedicated tracking URL.
- **Delivery status cron** — the endpoint `/api/cron/delivery-status` polls for delivery status updates on a schedule.
- The **DELIVERED** order status becomes available in the order workflow.

## Purchasing Settings

- **Purchase units** — define units of measure with conversion factors (e.g. 1 case = 12 units)
- **Landed cost distribution method** — choose how landed costs are allocated across purchase order lines

## Accounting Settings

This section only appears when an accounting plugin is enabled.

- **Financial year start** — set your financial year start date (UK format)
- **VAT rates** — manage VAT rates with Xero tax type mapping
- **Currencies & FX rates** — add currencies and manage exchange rates
- **FX rate schedule** — enable automatic exchange rate updates, set the update interval, or trigger an immediate update with the **Update Now** button

The organisation base currency is not changed here. It is defined in **Settings > Company** and is treated as a one-time setup choice for a live system.

## Backup & Restore

Full system backup and restore functionality is available for administrator-led backups and restores. See `docs/backup-restore.md` for the deployment-level details.

### Creating a backup

- **Manual** — click **Create Backup** in Settings > Backup. The system runs `pg_dump` in plain SQL format and saves a timestamped `.sql` file plus a `.manifest.json` sidecar that records schema version, the SQL filename, table names, and row counts.
- **Scheduled** — the `/api/cron/backup` cron endpoint runs `pg_dump` automatically. Configure your cron daemon to call this endpoint daily; we recommend an off-peak window (e.g. 02:00).

### Remote upload (S3 or SFTP)

Backups can be auto-uploaded to remote storage to keep them off the application server:

1. In Settings > Backup, choose **S3** or **SFTP** as the target.
2. Enter credentials and the target path.
3. Save settings. Every scheduled backup uploads both the `.sql` and `.manifest.json` files to the remote target.

If you have manual backups that should also go to remote storage, click **Upload to remote** on the backup row.

### Restore

Restoring is a destructive operation — it overwrites the current database with the contents of the backup file. The system protects this with several gates:

1. **Email confirmation code** — clicking Restore sends a 6-character code to your admin email. You must type it back into the form within 2 minutes. The code is bound to your current session and client IP, so a stolen code from a different network can't be used.
2. **Typed confirmation** — you must type the literal phrase shown on screen to proceed.
3. **Disk space check** — the system verifies enough free disk space before accepting the upload.
4. **Manifest validation** — for stored backups, the manifest sidecar is checked to ensure the file is a valid IMS backup with the four critical tables present (users, products, sales_orders, purchase_orders).
5. **File size cap** — uploads default to a 50MB max. Set the `DATABASE_RESTORE_MAX_FILE_BYTES` environment variable to raise the cap.

After restore, the system enters maintenance mode briefly while connections drain, then resumes normal operation.

### What to do before going live

- Test the backup/restore round-trip once on a staging environment.
- Schedule the backup cron and verify it runs successfully (check the Settings > System > Health page).
- Configure remote upload — local-only backups are vulnerable to the same incident that takes down the application server.

## User Management

Manage user accounts and roles from **Settings > Users**. See the [User Management & Security](user-management.md) guide for full details on roles and permissions.

### Password policy

When creating or updating a user password, the system enforces:

- Minimum **12 characters**
- At least one **uppercase letter**, one **lowercase letter**, one **number**, and one **symbol** (anything not alphanumeric)
- The password must not match a built-in deny-list of common weak passwords (e.g. `password123`, `Welcome2024!`)

If a password fails any check, the form returns a specific error message indicating which rule was violated. This policy applies in the UI, the CLI user-creation tool, and any API endpoints that create users.

### Activity-log redaction

The activity log automatically redacts sensitive data from log entries before they are stored:

- API tokens, OAuth secrets, and webhook secrets are replaced with `[REDACTED]`
- Database passwords and SMTP credentials are replaced
- Email content (for outbound notifications) is summarised, not stored verbatim

This means an admin viewing the activity log can see who did what but not see secret values, even if those values appeared in the error message of a failed operation.

## System Settings

- **Plugins** — enable or disable shopping/accounting connector plugins. Disabled plugins are hidden from menus and shared UI.
- **Scheduler** — configure the public app URL used for external callbacks and manage scheduled jobs
- **Activity log retention** — set how many days to keep log entries, configurable per log level
- **Data retention** — configure archival/deletion windows for operational records
- **System health** — at-a-glance status of FX sync, accounting sync, integration outbox depth, recent cron runs, and invariant check results
- **Database reset** — reset system data with three levels of severity:
  - **Transactions only** — clears orders, invoices, and movements but keeps products and settings
  - **Products** — clears products and all related data
  - **Full reset** — returns the system to a blank state

All reset options require a typed confirmation to prevent accidental data loss.

If you need to change the organisation base currency after setup, use a database reset and reconfigure the system from scratch.

### Cron jobs

The system relies on scheduled jobs to keep external systems in sync and to maintain data hygiene. Each cron endpoint requires the `CRON_SECRET` bearer header in the request:

| Cron endpoint | Purpose | Typical cadence |
|---|---|---|
| `/api/cron/fx-rates` | Fetch exchange rates from frankfurter.dev | Daily |
| `/api/cron/wc-reconcile` | WooCommerce reconciliation + stock catch-up | Daily |
| `/api/cron/accounting-daily-batch` | Xero sub-ledger A1/A2/B journals | Daily |
| `/api/cron/accounting-sync` | Drain pending accounting sync queue | Every 5 min |
| `/api/cron/accounting-payment-poll` | Detect paid invoices via Xero bank feed | Every 15 min |
| `/api/cron/accounting-fx-revaluation` | Unrealised FX on open AR/AP | Daily |
| `/api/cron/delivery-status` | Tracking provider polling | Every 15 min |
| `/api/cron/account-balance-snapshot` | Xero account balance snapshots | Daily |
| `/api/cron/invariant-check` | Scheduled data-integrity check | Daily |
| `/api/cron/backup` | Database backup | Daily |
| `/api/cron/product-lifecycle-archive` | Auto-archive exhausted EOL products | Daily |
| `/api/cron/mintsoft-webhook-sweeper` | Drain Mintsoft webhook events | Every 5 min |
| `/api/cron/email-outbox` | Send queued emails | Hourly |
| `/api/cron/activity-cleanup` | Trim old activity log entries | Daily |

### Cron rate limits

Each cron endpoint has a per-hour quota to prevent accidental over-invocation. The defaults match the expected cadence with headroom for jitter:

- Daily and hourly jobs: 1/hour
- 5-minute crons: 12-15/hour (depending on the job)
- 15-minute crons: 4-6/hour

If your cron daemon retries on transient errors and the underlying issue resolves itself, the legitimate next-tick run may be denied with HTTP 429. Adjust your cron daemon's retry policy or contact your system administrator.

For multi-instance deployments (multiple application replicas behind a load balancer), set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` so the rate limit is shared across replicas. The default in-memory backend doesn't share state.

### Invariant check

The system runs a periodic invariant check that scans inventory, accounting, and sales data for known drift conditions (negative stock, orphan cost layers, refund-status mismatches, etc.). Critical findings trigger an admin notification.

You can also run the check manually:

```bash
npm run invariant-check:preflight
```

This is the same check that runs in CI on every PR — it validates that the data shape matches the system's invariants.
