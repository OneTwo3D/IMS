# Troubleshooting

First-stop reference for common errors and unexpected behavior. Organised by where the problem shows up.

For setup-specific issues, see the [Setup Wizard Walkthrough](onboarding-walkthrough.md). For terminology, see the [Glossary](glossary.md).

**Finding the integration screens.** Connectors live under **Integrations** in the sidebar (the page at `/sync`; the item only appears once at least one integration is switched on in **Settings > System > Plugins**). Where this guide says "Integrations > Xero", open **Integrations** and then the **Xero** card; the same goes for **WooCommerce** and **Mintsoft**. Integrations are not under Settings.


## Where to look first

When something goes wrong, three places hold the information you need:

1. **Activity Log** (`/activity`) — every state change is recorded. Filter by tag (e.g. `sync`, `inventory`) to narrow down. Errors are shown with red badges.
2. **Integrations** (sidebar) — red and amber banners at the top say at once when something needs attention (failed accounting rows, sync exceptions, tax-rate drift). Below them, the **Sync Log** of each integration (WooCommerce and Xero cards; Mintsoft has its own panel) shows recent sync events with status (SYNCED / FAILED / PENDING / SKIPPED) and the error if any. See [Sync failures and the exception inbox](#sync-failures-and-the-exception-inbox) below.
3. **Notifications** (bell icon, top bar) — admin-facing alerts for problems: failed accounting postings, stranded goods, a read feed that stopped updating, an overdue warehouse receipt, a failed cron, and so on.


## Login and authentication

### "Invalid credentials" but the password is correct
- Caps lock?
- Did you set the email or username field? Some installations use email-only.
- Repeated failed attempts for the same email from the same address are blocked for 15 minutes, and the screen does not say so; wait and try again. (An administrator cannot lift this early.)
- The account may have been deactivated (Settings > Users shows it as Inactive).
- A line above the form saying your session ended means you were signed out by a change to your account or because the session expired; just sign in again.
- Have you been migrated to passkey-only? The login screen will show a passkey prompt instead of a password field.

### TOTP code rejected
- Confirm the device clock is synced to network time (NTP). TOTP fails if device time drifts > ~30 seconds.
- The 6-digit code rotates every 30 seconds; type quickly and submit before the next rotation.
- If you've reset your authenticator app or lost your device, you cannot disable 2FA yourself without a code, and **Settings > Users** has no button to disable it for you (its 2FA column only shows whether it is on). Ask your system administrator to reset your two-factor setting. If you can still produce a code, use **Disable 2FA** on your profile.

### Forgotten password
- Use the **Forgot password?** link on the login page and click **Send reset link**. The page says "If an account exists for that email, a password reset link is on its way" whether or not the address is registered. The email goes to your registered address — if nothing arrives, check spam and make sure SMTP works (**Settings > Company > Email > Test SMTP**).
- The link works once and **expires after 60 minutes**. "This reset link is invalid or has expired" means request a new one with **Request a new link**.
- Administrators can set a new password for another user from **Settings > Users** (Edit > New Password).
- See [User Management & Security](user-management.md#forgotten-password) for the full flow.

### A "Confirm it's you" box appears
- It is the re-authentication prompt for a sensitive action (users, backups, connector credentials, database reset). Enter your password (and authenticator code if you use 2FA) and click **Confirm**. A wrong password says "Re-authentication failed." and the action is not carried out. See [User Management & Security](user-management.md#confirming-its-you-re-authentication).

### A confirmation dialog will not let me click the button
- The action button stays disabled until you type the name the dialog asks for exactly (for example the backup file name) or tick its acknowledgement box. Cancel closes it without doing anything.

### "Password is too common" / "must include a symbol"
- The password policy requires at least 12 characters, one uppercase, one number, one symbol, and the password must not be in the deny-list of common passwords (`password123`, etc.).
- Passwords are hashed; the policy is checked on creation/change.


## Inventory and stock

### Available stock is negative
- "Available" is `On hand - Allocated`. Negative means an order was allocated against stock that's no longer there.
- Usually caused by a stock adjustment that was applied without first deallocating affected sales orders. Check the activity log around the time the figure went negative.
- Fix: deallocate the order(s) that hold the allocation, then reallocate. The system also runs a daily invariant check that flags negative-stock conditions.

### Incoming stock doesn't match an expected PO
- "Incoming" sums open PO lines (statuses PO_SENT, SHIPPED, PARTIALLY_RECEIVED), open inbound transfers, manufacturing outputs from in-progress production orders, and WMS ASN evidence.
- If a number is missing: check the PO status (DRAFT and RFQ POs don't count as Incoming), check that the line is for the right product, check that the destination warehouse is the one you're viewing.

### A product can't be type-changed
- The product still has attached operational data: stock on hand, reserved stock, open SO/PO lines, open manufacturing orders, or open transfer lines.
- Clear all of these first. The error message tells you which condition is blocking.

### EOL product won't auto-archive
- The auto-archive job runs daily and archives EOL products only when total stock across all warehouses is zero AND no incoming supply remains.
- "Incoming supply" includes WMS ASN states `CREATE_PENDING` and `CREATE_IN_FLIGHT` — stuck or dead-lettered ASNs can defer archive indefinitely. Check the WMS ASN list for the product.
- A **retired** transfer reservation does not defer it. When a retry finds that the WMS stock-sync alignment has already brought units in, the old reservation is closed and its expected quantity is reduced to exactly what it was credited, so it counts as nothing still to come. Such a row stays visible in the transfer's ASN list as a closed `CREATE_PENDING` entry.
- Manually archive from the product page if needed.


## Sales orders

### Auto-allocation skipped a warehouse
- The warehouse needs **Sync to Store** enabled in Settings > Inventory if it's intended to fulfil store-imported orders.
- Available stock at that warehouse may already be reserved by an earlier order.
- The auto-allocator minimises shipments — if it can fulfil from one warehouse instead of two, it will.

### "Cannot start picking — no products have been allocated"
- Allocate stock first (from the order detail page).
- If you allocated but still see this error, refresh the page. The PICKING guard re-reads allocations under a transaction lock; a stale page state can show wrong data momentarily.

### Refund failed with "no shipped stock source exists"
- The refund line refers to a product that was allocated but never shipped. The system refuses to restock from an allocation-only source.
- Either: refund as cash-only (set return warehouse to none), or wait until shipment lands, or correct the refund to reference a shipped line.

### Invoice number out of sequence
- The system uses a per-prefix counter. Manual invoice creation may have skipped a number if a previous attempt errored mid-create. The activity log shows the gap.
- The credit note prefix is separate from the invoice prefix.

### Shipment is stuck in PACKED, won't advance to SHIPPED
- The shipment status guard requires all preceding allocations to be locked. If another shipment for the same order is still PICKING, the guard rejects.
- Check that the order's other shipments aren't blocking.


## Purchase orders

### "The rate on a PO is not the one I expected"
- A PO's rate is always the Settings > Accounting > FX Rates table rate for its currency at the moment it was saved; it cannot be typed (there is no 10% or 2% band any more).
- To use a different rate, an admin pins a **manual override** on Settings > Accounting > FX Rates (pencil icon); POs saved afterwards use it. A saved PO keeps its stored rate; to re-read the table on a DRAFT PO, change its currency and back, or ask for a rate refresh.
- A CSV import row whose `fxRateToBase` is not exactly the table rate is refused; leave the column blank.

### "Missing GBP FX rate for EUR" (or similar)
- The FX rate cron hasn't fetched today's rate. Click **Update Now** in **Settings > Accounting > Currencies** (FX Rate Schedule). Check the **FX Rate Update** job is switched on in **Settings > System > Scheduler**.
- If the fetch keeps failing, look at the **Integration health** card on **Settings > Accounting > FX Rates** (last fetch, last fetch attempt and any error). A frankfurter.dev outage shows here.
- The **Aelia** FX source is **not yet switched on**; leave the source on ECB (frankfurter). If it has been switched on for you, a failure names its cause: HTTP 404 from the store means the helper plugin 1.3.0+ is not deployed or the shared secret is not set; `base_mismatch`, `no_update_time`, `missing_rate`, `non_positive_rate`, `rate_precision`, `unknown_currency` or `not_listed_by_aelia` name the rate Aelia gave that IMS refuses. Nothing is substituted; fix Aelia or the currency list, or switch the source back to ECB (**Settings > Accounting > FX Rates > Exchange-rate source**).

### PO cancellation refused
- POs in PARTIALLY_RECEIVED state can be cancelled, but the system will reverse all received cost layers and stock. Confirm the cancellation if you're sure.
- POs in RECEIVED or INVOICED state cannot be cancelled — process a return instead.

### Preferred supplier changed unexpectedly
- The preferred supplier is auto-updated when a PO transitions to PO_SENT.
- If you placed a one-off emergency PO with a backup supplier and don't want it to overwrite the primary, set "Skip preferred-supplier update" on the PO header before sending.
- To prevent any auto-update for a specific product, set `preferredSupplierLocked = true` on the product page.

### Landed cost recalc didn't update COGS
- Landed cost recalc only touches cost layers for the linked primary POs. Check that the freight PO is correctly linked.
- If goods have already shipped, the recalc queues a COGS revaluation journal — check the activity log for `cost_layer_snapshot_revalued` entries.


## Integrations

### WooCommerce orders not importing
1. Check that order sync is enabled in Integrations > WooCommerce > Orders.
2. Verify the initial import has completed (one-time, must finish before ongoing sync starts).
3. Confirm the relevant WC order statuses are selected in the status filter.
4. Check Sync Log for FAILED entries — the error message is usually specific (auth failure, network timeout, tax rate mismatch).
5. **If webhooks are configured:** verify the webhook secret matches in both systems. The WC plugin's settings page must have the same secret pasted as Integrations > WooCommerce > Orders > Webhook Secret.

### WooCommerce order import blocked: "no FX rate"
- The order's currency has no FX rate stored for the order's date. The system queues the order in the FX retry queue rather than failing.
- Run **Update Now** in **Settings > Accounting > Currencies**. The retry queue drains automatically after a successful fetch.
- If the queue grows beyond 5 entries, an admin notification is sent.

### "Blocked WooCommerce order ... tax rate fallback"
- A line item's tax rate couldn't be mapped to an IMS tax rate, and the fallback would have used a non-zero default rate.
- Fix: import tax rates from WC (Integrations > WooCommerce > Tax Rates > Import from WooCommerce), then re-process the blocked order. **Settings > Sales > Recent Tax Rate Fallbacks** lists the recent events and the rates involved.
- The blocking is intentional — preserving incorrect VAT silently is worse than blocking and asking.

### "Test the Xero connection successfully before enabling it"
- The connection test gate requires a successful test before an integration's sync can be activated. The same gate covers WooCommerce, Xero, Mintsoft and outbound email.
- Open Integrations > Xero (Connection tab) and click **Test Connection**. If the test passes, the gate clears. In the setup wizard, **Connect & Verify Xero** and **Save & Test Connection** do the test for you.
- If you've rotated the Xero client secret recently, the saved fingerprint is stale — re-test.

### "Retest the ... connection because the saved connection settings changed"
- The connection test gate detects when saved credentials differ from what was tested. Re-test after any credential change.
- The fingerprint comparison includes URL, key, secret (where relevant). The gate is per integration.

### Xero: "REQUIRES RECONNECT" or a "Reconnect required" warning
- Xero grants permissions when you connect and a later release can need one an old connection never granted (for example the trial-balance permission used by the account balance snapshot). IMS checks the recorded permissions and refuses with a message that names the missing permission and says nothing was sent, instead of a vague 401.
- Fix: Integrations > Xero > Connection tab > **Reconnect**, approve the consent screen, then retry the failed rows. See [Xero Accounting Sync](xero-sync.md).

### Xero: a document is refused with "NOTHING WAS SENT" and a missing tax type
- A sales invoice or credit note line with **no tax type** is refused and nothing is sent to Xero; IMS never falls back to "No VAT". The error names each part with no type (a product line, shipping, the discount).
- Fix: open **Settings > Accounting > Tax** and give the rate a real Xero tax type (or use **Generate missing rates** / **Import purchase tax rates from Xero**), then retry the row. An explicit "No VAT" type is also refused unless the line says why it carries no tax. For a WooCommerce order whose tax rate is unmapped or mapped to an inactive IMS rate, map the rate (Integrations > WooCommerce > Tax Rates) and re-import the order. See [Xero Accounting Sync](xero-sync.md).

### "N tax rates differ from the live Xero definition" (amber banner)
- Someone edited a rate in Xero (or IMS) so the two no longer match. The next invoice would post with the IMS-side numbers, so fix it before then: click **Review VAT rates**, see the **Xero drift** chip on the rate, and correct whichever side is wrong. **Compare VAT rates** (Settings > Accounting > Tax) also compares IMS, Xero and WooCommerce and explains each difference.

### Xero invoice CurrencyRate looks wrong
- IMS stores `1 base = X foreign`; Xero expects `1 foreign = X base`. The connector inverts and rounds to 6dp. If you see a substantially wrong rate, check `SalesOrder.fxRateToBase` on the source order.
- For an invoice or bill, a zero or null rate leaves `CurrencyRate` off and Xero applies its daily rate (logged as a fallback case); ensure the order had a valid rate at creation time. A refund or credit note does not do this: a foreign order with no usable stored rate is refused by name (nothing is created at 1). Correct the order's exchange rate and retry. A payment, or a month-end revaluation, with no `fx_rates` row for its date is refused or skipped by name: get the rate with **Update Now** (Settings > Accounting > Currencies) or pin one on **Settings > Accounting > FX Rates**.

### Mintsoft webhook signature mismatch
- The shared secret must match between IMS and Mintsoft. Re-paste it from Integrations > Mintsoft (see [Warehouse (Mintsoft)](warehouse-mintsoft.md)).
- Mintsoft webhook signatures bind the freshness timestamp into the HMAC; body-only signatures are rejected.


## Sync failures and the exception inbox

The **Integrations** page puts problems where you will see them. Banners appear at the top only when there is something to act on:

- **"N sync exception(s) need attention"** (amber) with **Open the exception inbox** — dead-lettered or parked sync work across connectors.
- **A connector-orphan banner** — accounting rows left behind by switching the accounting connector (administrators can cancel them there).
- **"N accounting sync row(s) failed after exhausting retries"** (red) with **Retry all failed...** — see below.
- **"N tax rates differ from the live Xero definition"** (amber) with **Review VAT rates**.

### Retry all failed (accounting)

**Retry all failed...** opens a confirmation dialog that counts the failed rows, repeats a warning that a retry can create a duplicate document, and asks you to tick "I have checked Xero and none of these documents already exist there" before **Retry N failed rows** is enabled. Failed rows were already retried automatically, and Xero's own duplicate protection lasts only minutes, so **check Xero first** (search by the document reference); a retry of a document that is already there makes a second one. If the count changed while the box was open the retry is refused; reopen it. After the retry the banner says how many rows were re-queued; rows IMS recognises as unsafe to repeat (a repeat could send a second payment, or another entry for the same document is already queued) are **not** re-queued and each has a recorded reason in the sync warnings. The same per-row controls are in the Sync Log: **Retry**, **Settle sync row** (record that a row did or did not post, when IMS cannot tell: you give the Xero document id you read) and **Checked the ledger** (for a receipt held back because Xero holds a payment IMS cannot read). Settle and Checked the ledger record **your assertion**, logged against your account, so only use them after looking in Xero. The full rules are in [Xero Accounting Sync](xero-sync.md).

### Sync Exceptions (the exception inbox)

Open it from the banner, or go to `/sync/exceptions` (**Integrations > Open the exception inbox**). It lists dead-lettered and parked work in sections, each with a count: blocked warehouse order pushes, permanently failed integration outbox rows, dead warehouse inbound events, parked WooCommerce refunds, dispatch reconciliations that gave up, order-total mismatches, accounting postings IMS refused to queue (with **Mark as handled** once you have posted it by hand), and WooCommerce product structure conflicts. When every queue is empty it says "No open sync exceptions".

- **Replay** re-attempts the original work with its original payload and idempotency keys preserved. A replay of an order that has a withdrawal standing against it runs the same check and holds it back again.
- **Dismiss** clears an exception IMS cannot or should not retry (for example a cancelled order that was never dispatched). Read the row's hint first; anything already despatched is handled as a return.
- Replay and similar actions may ask you to **Confirm it's you**.
- Items that stay in the inbox are real unfinished work. Do not clear them just to empty the list.

### Event Timeline

The **Event Timeline** button at the top of Integrations opens `/sync/events` (**WMS Event Timeline**): a record of every change made to the warehouse connector (settings, bindings and similar), with filters for connector, direction (outbound IMS to the warehouse, inbound the other way), action and outcome. Expand a row for its **Before** and **After** values and any error. Secrets are masked. Use it to answer "who changed the connector settings and when".

### Daily batch preview warnings

On the Xero connector's **Daily Batch** tab, an amber box above the preview figures says "N orders netted against a reversal the IMS cannot vouch for" and lists one line per order. It means the revenue deferral for those orders rests on records nobody has checked in the ledger. The figures are unchanged and the batch still runs; check the listed orders in Xero if the totals look wrong.


## Reports and analytics

### Forecast shows no products
- All products in the catalogue may be `EOL` or `ARCHIVED`, both of which are excluded from reorder forecasts.
- Forecasts also require sufficient sales history. New products with no sales movement aren't suggested for reorder.

### VAT report numbers don't tie to Xero
- VAT report uses inclusive vs exclusive pricing per order. Tax-inclusive orders subtract tax from `totalBase` to get taxable base.
- The Xero comparison should be against Xero's VAT report, not Xero's totals. Slight rounding (under £1 typically) is normal.

### "Source rows exceed 50,000; narrow the filters and retry"
- Reports cap source scans at 50,000 rows to keep response times bounded. Filter by date range, warehouse, or category to fit under the cap.
- CSV export of large reports returns HTTP 413 with the same message. Same fix: narrow filters.


## Backups and restore

### "Restore upload size is too large"
- The default is 50MB. Set `DATABASE_RESTORE_MAX_FILE_BYTES` environment variable to raise it.
- For very large tenants, restore from the local backup directory (no upload size limit) or from a remote (S3/SFTP) configured target.

### "Backup manifest does not match the selected backup"
- The system checks that the manifest's recorded filename matches the file you're restoring. Manual file renames break this check.
- Fix: rename the backup file to match the manifest, OR regenerate the manifest by running a fresh backup.

### Scheduled backups are not appearing
- Open **Settings > Backup & Restore > Scheduler** and check **Enable scheduled backups** is on and saved. The time of day is the **Database Backup** job on **Settings > System > Scheduler** (daily at 01:00 by default); both switches are the same setting.
- If **Auto-upload** is S3 or SFTP, check the **Storage** tab details. For SFTP the **Host Fingerprint** is required.
- Backups older than the retention days, or beyond the maximum count, are deleted automatically.

### Restore email code never arrives
- Restore tokens have a 2-minute TTL. By the time you check email and type, the code may have expired.
- Each restore attempt invalidates previous tokens. If a code is rejected, click **Resend code**.
- The token is bound to your session and IP — opening the restore page from a different network or after re-auth invalidates the previous token.


## Cron jobs

### A scheduled job does not run, or a new job is missing
- Jobs are scheduled from **Settings > System > Scheduler**. After an upgrade, open it and press **Save & Apply** once: a job that is new (for example the Mintsoft despatch poll every 15 minutes or the daily Xero chart refresh at 00:30) or whose frequency changed (the WooCommerce reconcile is now hourly) only reaches an existing crontab when you save.
- A red **"Scheduler crontab needs attention"** box at the top of the Scheduler tab says the crontab is missing, was hand-edited, or has a stale secret (every job then fails with a silent 401). **Save & Apply** rewrites it. On a containerised install the host owns the crontab and the tab says so.
- Check the job's switch is on. Several are off by default: scheduled backups, the WMS order push, status and reconcile jobs, and most Mintsoft stock and verification jobs.
- A message after saving such as "saved, but the scheduler is behind" means the setting is stored but the crontab was not updated; save again or ask your system administrator.

### "Public App URL" is refused
- It must be an `https://` address (`http://` only for `localhost`, `127.0.0.1` or `[::1]`) with no spaces, credentials (`user:password@`), query (`?...`), fragment (`#...`) or special characters (quotes, `$`, backticks). Use just the site address, for example `https://ims.example.com`. A bad value that is already stored stops the crontab being written until it is corrected.

### "Cron job rate limited" (429)
- Each cron route has a rate limit derived from its schedule: daily and hourly jobs allow three runs per period; more frequent jobs allow their scheduled runs per hour plus a few spare.
- If your cron daemon retries on transient errors AND the underlying issue resolves itself, the legitimate next-tick run can be denied. Check the cron daemon retry policy.
- For one-off testing, set `RATE_LIMIT_BACKEND=memory` and restart the app — counters reset.

### Multi-instance rate limits don't work
- The default `RATE_LIMIT_BACKEND=memory` keeps counters per-process. For multi-replica deployments, switch to `RATE_LIMIT_BACKEND=redis` and set `REDIS_URL`.

### `/api/cron/*` returns 401 in production
- `CRON_SECRET` env var is missing or doesn't match the `Authorization: Bearer ...` header your cron daemon sends.
- The system fails fast on startup if `CRON_SECRET` is unset in production — check the application logs.


## When all else fails

1. Check the **Integrations** page: the banners and the **Sync Exceptions** inbox show failed and stuck sync work, and the notification bell shows administrator alerts (failed postings, stranded goods, a feed that stopped updating, an overdue warehouse receipt).
2. Check **Settings > Accounting > FX Rates** (Integration health card) for exchange-rate problems.
3. Check the **activity log** with the `Error` level filter for the last 24 hours.
4. The daily invariant check also scans inventory, accounting and sales for drift; ask your system administrator to run it by hand if you suspect a data problem.
5. If the issue is sync-related, retry the failed entry from the Sync Log, after checking the other system (see above).
6. Capture the error message, the activity-log entry ID, and the affected entity (order ID, product SKU, etc.) before opening a support ticket.
