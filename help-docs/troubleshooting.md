# Troubleshooting

First-stop reference for common errors and unexpected behavior. Organised by where the problem shows up.

For setup-specific issues, see the [Setup Wizard Walkthrough](onboarding-walkthrough.md). For terminology, see the [Glossary](glossary.md).


## Where to look first

When something goes wrong, three places hold the information you need:

1. **Activity Log** (`/activity`) — every state change is recorded. Filter by tag (e.g. `sync`, `inventory`) to narrow down. Errors are shown with red badges.
2. **Sync Log** — under each integration (Sync > WooCommerce, Sync > Xero, Sync > Mintsoft). Shows the last 100 sync events with status (SYNCED / FAILED / PENDING / SKIPPED) and the error if any.
3. **Notifications** (bell icon, top bar) — admin-facing alerts for critical issues (failed cron, integration outage, restore confirmation, etc.).


## Login and authentication

### "Invalid credentials" but the password is correct
- Caps lock?
- Did you set the email or username field? Some installations use email-only.
- Account may be locked after repeated failures. Wait 15 minutes or have an admin unlock.
- Have you been migrated to passkey-only? The login screen will show a passkey prompt instead of a password field.

### TOTP code rejected
- Confirm the device clock is synced to network time (NTP). TOTP fails if device time drifts > ~30 seconds.
- The 6-digit code rotates every 30 seconds; type quickly and submit before the next rotation.
- If you've reset your authenticator app or lost your device, an admin can disable 2FA on your account from Settings > Users.

### Forgotten password
- Use the **Forgot password?** link on the login page. The reset email goes to your registered address — make sure SMTP is working.
- Admin users can reset other users' passwords from Settings > Users.

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

### "FX rate is more than 10% different from the latest stored rate"
- The system rejects manual FX rates that differ from the stored rate by more than 10%, and warns above 2%. The threshold is per the order's creation date, not today.
- Editing an old DRAFT PO with today's rate vs the PO's original-date rate can trigger this. Either refresh the rate via Settings > Accounting > Update Now, or accept the validation error and use a rate within band.

### "Missing GBP FX rate for EUR" (or similar)
- The FX rate cron hasn't fetched today's rate. Click **Update Now** in Settings > Accounting > FX Rates.
- If the fetch keeps failing, check **Settings > System > Health** for FX sync status. The frankfurter.dev API outage will surface here.

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
1. Check that order sync is enabled in Sync > WooCommerce > Orders.
2. Verify the initial import has completed (one-time, must finish before ongoing sync starts).
3. Confirm the relevant WC order statuses are selected in the status filter.
4. Check Sync Log for FAILED entries — the error message is usually specific (auth failure, network timeout, tax rate mismatch).
5. **If webhooks are configured:** verify the webhook secret matches in both systems. The WC plugin's settings page must have the same secret pasted as Sync > WooCommerce > Orders > Webhook Secret.

### WooCommerce order import blocked: "no FX rate"
- The order's currency has no FX rate stored for the order's date. The system queues the order in the FX retry queue rather than failing.
- Run **Update Now** in Settings > Accounting > FX Rates. The retry queue drains automatically after a successful fetch.
- If the queue grows beyond 5 entries, an admin notification is sent.

### "Blocked WooCommerce order ... tax rate fallback"
- A line item's tax rate couldn't be mapped to an IMS tax rate, and the fallback would have used a non-zero default rate.
- Fix: import tax rates from WC (Sync > WooCommerce > Tax Rates > Import from WooCommerce), then re-process the blocked order.
- The blocking is intentional — preserving incorrect VAT silently is worse than blocking and asking.

### Xero "Test the connection successfully before enabling it"
- The connection test gate (added in PR #152) requires a successful test before sync can be activated.
- Visit Sync > Xero, click Test Connection. If the test passes, the gate clears.
- If you've rotated the Xero client secret recently, the saved fingerprint is stale — re-test.

### "Connection settings changed" error after rotating a secret
- The connection test gate detects when saved credentials differ from what was tested. Re-test after any credential change.
- The fingerprint comparison includes URL, key, secret (where relevant). The connection test gate's gate is per-integration.

### Xero invoice CurrencyRate looks wrong
- IMS stores `1 base = X foreign`; Xero expects `1 foreign = X base`. The connector inverts and rounds to 6dp. If you see a substantially wrong rate, check `SalesOrder.fxRateToBase` on the source order.
- Zero or null rates fall back to Xero's daily rate (logged as a fallback case). If you want explicit rate control, ensure the order had a valid rate at creation time.

### Mintsoft webhook signature mismatch
- The shared secret must match between IMS and Mintsoft. Re-paste from Settings > Integrations > Mintsoft.
- Mintsoft webhook signatures bind the freshness timestamp into the HMAC; body-only signatures are rejected.


## Reports and analytics

### Forecast shows no products
- All products in the catalogue may be `EOL` or `ARCHIVED`, both of which are excluded from reorder forecasts.
- Forecasts also require sufficient sales history. New products with no sales movement aren't suggested for reorder.
- Check that velocity is being computed — Settings > System > Health > Velocity status.

### VAT report numbers don't tie to Xero
- VAT report uses inclusive vs exclusive pricing per order (added in PR #136). Tax-inclusive orders subtract tax from `totalBase` to get taxable base.
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

### Restore email code never arrives
- Restore tokens have a 2-minute TTL. By the time you check email and type, the code may have expired.
- Each restore attempt invalidates previous tokens. If a code is rejected, request a new one.
- The token is bound to your session and IP — opening the restore page from a different network or after re-auth invalidates the previous token.


## Cron jobs

### "Cron job rate limited" (429)
- Each cron route has a per-hour quota. Most are 1/hour (daily jobs); high-frequency jobs are 4/hour, 12/hour, or 60/hour. Defaults match expected cadence.
- If your cron daemon retries on transient errors AND the underlying issue resolves itself, the legitimate next-tick run can be denied. Check the cron daemon retry policy.
- For one-off testing, set `RATE_LIMIT_BACKEND=memory` and restart the app — counters reset.

### Multi-instance rate limits don't work
- The default `RATE_LIMIT_BACKEND=memory` keeps counters per-process. For multi-replica deployments, switch to `RATE_LIMIT_BACKEND=redis` and set `REDIS_URL`.

### `/api/cron/*` returns 401 in production
- `CRON_SECRET` env var is missing or doesn't match the `Authorization: Bearer ...` header your cron daemon sends.
- The system fails fast on startup if `CRON_SECRET` is unset in production — check the application logs.


## When all else fails

1. Check the **System Health** page — Settings > System > Health. It surfaces FX sync status, WooCommerce sync status, Xero sync status, integration outbox depth, cron last-run timestamps, and recent error rates.
2. Run the **invariant preflight** locally: `npm run invariant-check:preflight`. It scans inventory, accounting, and sales invariants and reports any drift.
3. Check the **activity log** with `level=ERROR` filter for the last 24 hours.
4. If the issue is sync-related, retry the failed entry from the Sync Log.
5. Capture the error message, the activity-log entry ID, and the affected entity (order ID, product SKU, etc.) before opening a support ticket.
