# WooCommerce Integration

One Two Inventory connects to your WooCommerce store to automatically import orders, sync products, push stock levels, and keep order statuses aligned between both systems. Configuration is managed from the **Integrations** page when the WooCommerce plugin is enabled.

## Getting Connected

1. Enable the WooCommerce plugin under **Settings > System > Plugins** if it is not already enabled
2. Navigate to **Integrations** in the sidebar and click the **WooCommerce** connector card
3. On the **Connection** tab, enter:
   - **Store URL** — your WooCommerce site address (e.g. `https://yourstore.com`)
   - **Consumer Key** — generated in WooCommerce under Settings > Advanced > REST API
   - **Consumer Secret** — shown once when you create the key in WooCommerce
4. Click **Save Settings**
5. **Click "Test Connection"** — sync remains disabled until you successfully run the connection test. The system stores a fingerprint of the saved credentials at test time; if you later change any of them, you must re-test before sync re-activates. See [Connection Test Gate](#connection-test-gate) below.

Once connected AND tested, a green "Connected" badge appears and the remaining tabs become available.

### How to get your WooCommerce API keys

The Consumer Key and Consumer Secret are generated inside your WooCommerce store, not the IMS:

1. Sign in to your WooCommerce site's **WordPress admin**.
2. Go to **WooCommerce → Settings → Advanced → REST API**.
3. Click **Add key** (or **Create an API key**).
4. Set a **Description** (e.g. "One Two Inventory"), choose the **User** the key acts as, and set **Permissions** to **Read/Write**.
5. Click **Generate API key**.
6. Copy the **Consumer key** (`ck_…`) and **Consumer secret** (`cs_…`) — the secret is shown **only once**, so copy it before leaving the page.
7. Paste both into the IMS connection form along with your store URL.

Official guide: <https://woocommerce.com/document/woocommerce-rest-api/>

> **Note:** The consumer secret is masked after saving. To change it, enter the full new value — the system detects and ignores the masked placeholder.
>
> **Base currency check:** the WooCommerce store currency must match the IMS base currency before credentials or sync settings can be enabled. Order currencies may still vary per transaction; the IMS converts them into its own base currency for reporting and valuation.

### Connection Test Gate

The connection test gate prevents sync from running with stale or wrong credentials. The flow is:

1. You save credentials → status `not tested`. Sync is disabled.
2. You click Test Connection → IMS calls the WooCommerce API with the saved credentials.
3. If the test succeeds, the system stores:
   - Test status: `success`
   - Tested-at timestamp
   - A fingerprint (hash of URL + key) of the credentials at test time.
4. Sync can now be enabled.
5. If you later change the URL, key, or secret, the fingerprint comparison detects the change and reverts the status to `stale`. You must re-test.

This means a credential rotation can't silently leave sync running with old (or broken) credentials.

## Order Sync

### Initial Import

Before ongoing sync begins, you must import your existing active orders:

1. Go to the **Orders** tab on the WooCommerce connector page
2. Click **Import Active Orders** — this fetches all orders with `processing`, `pending`, or `on-hold` status from WooCommerce
3. A progress bar shows pages processed, orders imported, and orders skipped (already in the system)
4. Once complete, a green checkmark appears and the "Sync Orders Now" button becomes available

This is a one-time operation. Ongoing sync is blocked until the initial import finishes.

### Ongoing Order Sync

With the initial import complete, new and updated WooCommerce orders are imported automatically.

**Configuration options:**

- **Enable/disable** order sync with the toggle
- **Status filter** — choose which WooCommerce statuses trigger an import (e.g. `processing`, `on-hold`, `completed`)
- **Sync interval** — how often the system polls WooCommerce for changes (default: 5 minutes). This field is disabled when webhooks are active.

**What happens when an order is imported:**

- A new sales order is created with all line items, prices, discounts, shipping, and tax
- **Cart coupons ride on the line items.** WooCommerce allocates coupon money *into* the lines — each line's total is already its subtotal minus that line's share — so IMS imports the coupon as a per-line discount and leaves the order-level discount field at zero. The coupon codes are still recorded on the order for display. Only money WooCommerce left unallocated (a coupon shape IMS does not model) is stored as an order-level discount, and that is logged as a warning when it happens. Storing it in both places made every downstream document — the Xero/QuickBooks invoice, the credit note, the order totals — deduct the same coupon twice. Every order imported since the fix records `LINE_ALLOCATED` in its discount model field, which is what says the order-level amount is only the unallocated residual
- **Orders imported before that fix still carry the duplicate** and are corrected by a separate one-off backfill. It is a **two-phase, opt-in** workflow, because it rewrites amounts on invoices that are already in the ledger, and nothing on a row distinguishes "written by the old importer" from "corrected by hand afterwards". A machine may propose; only a person may approve:

  ```bash
  # 1. PROPOSE — writes nothing
  npm run wc:coupon-discount:backfill -- --imported-before <ISO> --allowlist-out y14.json --csv out.csv

  # 2. REVIEW y14.json by hand, then sign it:
  #      "reviewed": true, "reviewedBy": "<your name>", "reviewedAt": "<ISO>"

  # 3. APPLY — consumes ONLY the reviewed file, never a fresh scan
  npm run wc:coupon-discount:backfill -- --allowlist y14.json --apply
  ```

  `--imported-before` is the moment the fix went live on this instance. It must be an unambiguous ISO instant (`2026-07-25T14:00:00Z`) — a bare date is refused, because it silently means UTC midnight and orders import at all hours. It is dated against when **IMS imported** the order, never against the order date: the initial import backdates a sales order's `createdAt` to the historical WooCommerce date, so an old order imported yesterday would otherwise look legacy and have a correct discount erased. It is **not accepted with `--apply`** — the cutoff decided what was proposed; what gets written is decided by the reviewed file alone.

  Reviewing means checking each entry against the deployment record and against any manual corrections you know about. An entry whose amount is **already** correct belongs in the file's `stampOnly` list, which records that fact permanently without changing any number; anything you are unsure of should be deleted from the file, since skipping is re-runnable and a wrong correction is not. Apply re-verifies every field against the live row and re-derives the amount it writes, so a row that moved since you reviewed it is skipped and a hand-edited figure is refused rather than obeyed. `stampOnly` entries are re-verified just as hard — the amount, the line discounts and the import timestamp — because the stamp is the one write no later run can reconsider.

  Reviewing an entry also means reading its **`refunds`** block — the order's refund status, its refund rows, and any credit notes of theirs that reached the ledger. It changes nothing about the amount (a duplicated coupon is duplicated whether or not the order was refunded) but it decides what you may safely do about the documents; see the refunded-orders note below.

  **Every refusal is fixed by re-running the proposal.** Nothing is written when a row is refused, and the report reads every field apply checks, so the regenerated file shows you the state that caused the refusal; approve it again and apply proceeds. That includes an invoice that posted without its reference being written back onto the order — the report lists it as a *posted-but-unlinked* invoice, and approving the entry with that evidence on it is what lets the correction through. A proposal generated by an older build is refused on its version, which means the same thing: re-run the proposal.

  **A row that was corrected is the one thing the proposal will not show you again.** The correction stamps the order and writes its audit marker, which is exactly what makes the operation safely re-runnable — and which makes every later scan skip that order, so no proposal will ever print its ledger handoff a second time. To re-read the accounting position for an order that has already been corrected, use the read-only reprint mode:

  ```bash
  npm run wc:coupon-discount:backfill -- --reprint y14.json
  ```

  The command line is parsed strictly: a misspelled flag, a `--flag=value`, a bare path, a repeated flag, or a flag with nothing after it **refuses the run** instead of being ignored. That matters most for `--reprint`, which used to fall through to `--apply` when given no value — the read-only mode silently becoming the writing one.

  It writes nothing, takes no lock and re-verifies nothing — it re-derives each order's handoff against **live** state and prints it. The file does not need to be signed, because nothing is decided; `--apply` still refuses an unsigned file and always will, and the two flags cannot be combined. Anywhere the tool tells you a position can be re-derived, this is the command it means.

  Verdicts in the report and the CSV:

  - **UNPROVEN** — nothing establishes what the stored amount means, so it is left exactly as it is
  - **BLOCKED** — the order has live accounting work: an unposted invoice job, or a daily revenue-deferral journal that has not posted yet. Both hold their own copy of the figures, which the backfill deliberately never edits. Let the queue and the daily batch drain, then re-run
  - **SKIP** / **CORRECT** — nothing duplicated, or a proposal to clear the duplicated part

  Orders that already have accounting documents — a linked invoice, a posted-but-unlinked invoice, a revenue-deferral journal, or a credit note from a refund — are listed separately, at both phases, and **each one is classified rather than assumed to be wrong**. Clearing the IMS field does not reach a document that has already posted, but that does not mean every posted document understates: the report replays the connector's own posting rule over the payload IMS actually sent, so a Xero invoice enqueued without a discount account code — which never had an "Order discount" line appended, and therefore never carried the duplicate — is reported as needing **nothing**, and crediting it would put a wrong entry in your ledger. Where a document *does* disagree, the instruction names the direction: an invoice that discounted too much charged the customer too little, so its balance has to go **up** (edit it, or raise a further invoice) and a credit note is the wrong instrument; the reverse case is the one a credit note settles. Where the figure cannot be established at all, no remedy is prescribed and you are told how to read it off the document instead — except where the reason it could not be established is that **several posted documents disagree**, in which case there is no single document to read it off and nothing is prescribed at all.

  **Where the ledger holds more than one posted sales invoice for the order, every one of them is named and nothing is prescribed.** Two posted documents that agree on the discount are two distinct documents that each carry it, so the difference reported is per document, not what the ledger is out by — and multiplying it is no better founded, because nothing IMS records says whether those documents each bill the whole order or divide it between them. Correcting the one the report happened to name would have left the other standing. You are told to open all of them and establish the total by hand.

  **Refunded orders are judged on the whole position, not on the invoice.** If any refund or credit note stands against the order — including a WooCommerce refund that arrived and could not be recorded — the invoice is only half of it: the credit note that reversed it was computed from the same pre-correction figure, so the two errors can cancel and the amount "outstanding" on the invoice may not be outstanding at all. Raising a further invoice on the invoice finding alone would bill a customer who has already been refunded, and raising a credit note would refund the same money twice.

  Where the credit notes **mirror** the invoice, IMS nets the two for you and prescribes the remainder in whichever direction it actually points. That needs the whole position to line up: a full refund, every refund raised as a chargeback that mirrored the invoice, each named by one credit note that is in the ledger and by no other, net (not legacy gross) totals, no unrecorded refund left parked — and, additionally, an invoice whose order-level discount can be **compared** with the credit note's:

  - the invoice must have been sent **tax-exclusive**. A tax-inclusive invoice states its order-level discount gross while every refund line IMS stores is net, and nothing recorded lets one be converted into the other (a refund line records a tax *type*, never a rate), so the subtraction is not defined;
  - there must be exactly **one** posted sales invoice. Two invoices that agree on the discount charged it twice, and netting one credit-note total against one of them describes a set of documents the ledger does not hold;
  - each credit note must still **stand as IMS recorded it** — mirrored as posted, once, under the id the refund names, with no retry pending. A credit note IMS retired or re-posted no longer carries the lines its refund rows describe;
  - the invoice and the credit notes must have been posted to the **same accounting system**. The active accounting connector can be switched (Xero → QuickBooks), and IMS keeps every historical document under the connector that posted it — so an order invoiced before a switch and credited after it has an invoice standing at its full value in one ledger and an unrelated credit memo in the other, and the difference between their discount lines describes no balance that exists.

  In every other shape IMS reports the invoice finding, prints every credit-note leg it *could* derive, names the exact condition that stopped it, and prescribes **nothing** — including any conclusion about whether the two sides cancel. Where the subtraction was withdrawn, no line says the errors cancel, that the invoice was already credited away, or that the order is square: those are results of a netting, and on these orders no netting was performed. What you get instead is both sides' facts, the condition that stopped the comparison, and the same reasoning stated as the *conditional* it is ("**if** the credit note reversed the same figure, then …"). An order whose netting was suppressed is never filed as settled.

  A netted answer is also **withdrawn** if the refund position moves after the correction commits — the "nothing to do" as well as the remedy. The conclusion is removed from the printed handoff, the order goes back on the must-look list, and `--reprint` re-derives it against the new position.

  **Every netted answer names the credit notes it was derived against — including the one that nets to nothing.** IMS cannot see a credit note voided or edited by hand in Xero or QuickBooks (nothing writes that back), and it records which *connector* posted each document but never which *organisation* inside it. So both netted outcomes tell you to open those documents and confirm they still stand, in the same organisation as the invoice, before you act on the figure. A net of **zero** carries that warning most heavily: it is the one answer that says there is nothing to look at, and if one of the credit notes was voided by hand then the reversal never happened, the invoice stands at its full posted value and the customer still owes it.

  The revenue-deferral journal is deliberately left alone in all cases: IMS recognises back out the same stamped figure, so adjusting one half of that pair by hand would strand the difference in unearned revenue permanently.

  At apply time that whole list is rebuilt from **live** state rather than from the reviewed file, and any order whose posting **or refund** state changed since you reviewed it is refused instead of corrected — so you are never told a posted order needs nothing, and never handed a remedy that was derived before the refund existed

  **Chargebacks on corrected orders go to a person.** A credit note must reverse the document the ledger actually holds, and on a corrected order the invoice charged the old discount while the order now carries the new one. Rather than guess which of the two the accounting system holds today — that depends on whether the manual credit/adjustment above has been made, which happens outside IMS — the automatic payment-reversal chargeback stops and logs a manual-handling warning naming both figures and the invoice. Raise that credit note by hand against the document as it stands.

  It stops **just as firmly when the posted figure cannot be established at all** — no readable record of the invoice IMS sent, an invoice update that never confirmed, or two posted documents that disagree — rather than falling back to the order's current figure. The warning says which. Every one of those is raised by hand too, against the invoice in the accounting system.

  Only orders this backfill actually **rewrote** are affected. The correction records that fact on the order itself, in the same write as the amount, so orders it never touched — every native, manual and pre-fix order, everything the fixed importer has imported since, and rows the reviewer merely marked as already-correct via `stampOnly` — keep raising their chargebacks automatically, exactly as before.
- The customer is matched by WooCommerce customer ID or email, or created if new
- Multi-currency orders are converted to the IMS base currency using the FX rate from `frankfurter.dev` (ECB) at import time. The same rate is stamped on the order's `fxRateToBase` field and forwarded to Xero as `CurrencyRate` on the resulting invoice — so the WooCommerce store, IMS, and Xero all see the same base-currency total for the order. See `docs/xero-sync.md` § Multi-Currency FX Rates.
- Tax rates are resolved using the tax rate mappings you configure (see Tax Rates below)
- The order number uses your configured WooCommerce prefix (e.g. `WC-1234`, set in Settings > Company > Document Numbering)
- Stock is auto-allocated from warehouses marked **Sync to Store**

**WooCommerce "completed" orders** receive special handling: the system auto-allocates stock, creates shipments, applies any tracking information from the WC order meta (AST plugin), and transitions the shipments through to Shipped status.

This uses the same shared external-fulfillment path that future WMS plugins will use. WooCommerce does not bypass the IMS shipment model or dispatch stock directly at order level.

### Webhooks (Recommended)

Webhooks deliver order changes to One Two Inventory in real-time, rather than waiting for the next poll. To set up:

1. In the **Orders** tab, find the **Webhook Secret** section
2. Click **Generate Secret** — a random secret is created and saved immediately
3. **Copy the secret now** — it is only displayed once and cannot be retrieved later
4. Click **Setup Webhooks in WooCommerce** to auto-register the three required webhooks via the WC API:
   - `order.created` — imports new orders
   - `order.updated` — syncs status changes and refunds
   - `product.updated` — syncs product changes

Once the first webhook is verified, the polling interval field is replaced with a "Last received" timestamp. Webhooks and polling can coexist safely — order import is idempotent (duplicate imports are silently skipped).

### Status Mapping

The **Status Mapping** tab controls how WooCommerce statuses translate to One Two Inventory statuses. Each WooCommerce status (e.g. `processing`, `on-hold`, `completed`) maps to an IMS status via a dropdown. Changes are saved automatically.

**IMS to WooCommerce** status pushes are automatic for:

| IMS Status | WooCommerce Status |
|---|---|
| Shipped | `completed` |
| Cancelled | `cancelled` |
| On Hold | `on-hold` |

Other IMS status changes are not pushed back to WooCommerce.

### Tracking Sync (IMS to WC)

Shipment tracking is pushed back to WooCommerce when:

- a shipment is first shipped in IMS, or
- tracking on an already-shipped shipment is edited later in IMS

The WooCommerce connector writes AST-compatible order meta to `_wc_shipment_tracking_items`, matching the same tracking source that IMS already reads inbound for completion and delivery-status flows.

Behavior notes:

- Tracking is pushed per shipped shipment where shipment records exist
- Current fulfillment is shipment-based. Historical order-level tracking fallback exists only for older records that pre-date shipment rows.
- Re-saving the same tracking is idempotent and does not intentionally create duplicate upstream entries
- Reflected WooCommerce `order.updated` webhooks from IMS-originated status/tracking pushes are explicitly suppressed

## Product Sync

The **Products** tab controls bidirectional product synchronisation.

### Direction

- **WC to IMS** — product changes in WooCommerce are imported into inventory (name, description, images, weight, dimensions, GTIN, HS code, country of origin)
- **IMS to WC** — product changes in One Two Inventory are pushed to WooCommerce (name, description, prices)
- **Both** — sync runs in both directions

### What Syncs

**WooCommerce to IMS:**
- Product name, description (HTML stripped), image URL
- Weight and dimensions (length, width, height)
- GTIN/barcode from WooCommerce's `global_unique_id` field (only written if the IMS barcode field is empty)
- HS code and country of origin from WC product attributes (only written if the IMS fields are empty)
- **Categories** — the WC product-category tree is mirrored into IMS. Each WC category becomes an IMS reporting category with its WC parent chain preserved (so `Apparel > T-Shirts > V-Neck` arrives as a 3-level path). The product is linked to its **deepest** WC category. The mirror is cached for 5 minutes so per-product webhooks do not re-fetch the whole tree. If the WC categories endpoint is unreachable, the product's existing category link is left alone rather than wiped.
- Variable products: all variations are synced as child VARIANT products linked to the parent
- Variation attributes are synced for the options panel

**IMS to WooCommerce:**
- Product name, description, regular price, sale price
- GTIN (only if purely numeric)

### Stock Sync (IMS to WC)

Stock levels are pushed from One Two Inventory to WooCommerce. Enable this in the **Products** tab under "Stock Sync".

- Only warehouses with **Sync to Store** enabled contribute to the stock count (configured per-warehouse in Settings > Inventory)
- Available stock = on-hand quantity minus reserved quantity, summed across all synced warehouses
- **Include COGS** — optionally pushes the oldest FIFO cost layer unit cost to WooCommerce's native COGS field (requires WooCommerce 9.2+ or the WC COGS plugin)
- Stock is pushed in batches of 100 products via the WC batch API

Use **Push Stock Now** for an immediate sync. Stock is still primarily event-driven from IMS changes, but the daily WooCommerce reconcile job also performs a forced stock catch-up and drains queued retry jobs as a safety net.

The manual push runs against the **saved** setting: ticking "Push stock levels to WooCommerce" takes effect only after **Save Settings**. Until then the Push Stock Now button is blocked with a hint. If a push is refused server-side anyway (sync disabled, missing credentials, or no Sync-to-Store warehouses), it reports a red error — e.g. "Stock sync is disabled in settings — nothing was pushed" — rather than completing quietly.

## Tax Rates

The **Tax Rates** tab maps WooCommerce tax rates to One Two Inventory tax rates. This ensures imported orders have the correct tax treatment.

1. Click **Import from WooCommerce** to fetch all tax rates from your WC store
2. The system automatically creates matching IMS tax rates or links to existing ones by name
3. Review the mapping table — each row shows the WC rate name, ID, country, percentage, and the linked IMS tax rate
4. Use the dropdown to change the target IMS tax rate if needed
5. Delete mappings that are no longer relevant

### Tax fallback policy

When a WC order line arrives with a tax rate ID that has no IMS mapping, the system falls through to the IMS tax-rate resolver. If the resolver finds a matching rate based on country and product category, that rate is used.

If the resolver also can't find a match, the system would fall back to the order-default tax rate. This is the point where things get dangerous: a misconfigured default could silently apply the wrong VAT to imports.

The system handles this two ways:

- **Non-zero fallback → import BLOCKED.** If the order-default rate is non-zero (most common case) and a line would use it, the import is rejected with a clear error message. A `tax_rate_fallback_blocked` activity log entry is written with the order details and the lines that hit fallback.
- **Zero-rated fallback → import allowed, but logged.** If the fallback is to a zero-rate, the import proceeds but a `tax_rate_fallback` warning activity entry is written so operators can review.

**To unblock a blocked order:** import the missing tax rates from WC, ensure the relevant country + category combination resolves, then retry the import from Sync > WooCommerce > Sync Log.

The Sales Settings page surfaces recent fallback events as a widget so you can spot misconfigurations early.

### Pending FX retry queue

WooCommerce orders in a currency for which IMS has no stored FX rate are queued rather than failed. The system writes a `PENDING` shoppingSyncLog row with the full order payload and a `wc_order_fx_pending` activity log entry.

When the next FX rate fetch succeeds, the queue is drained automatically and the queued orders are imported. If the queue grows beyond 5 entries (configurable via `WC_PENDING_FX_ORDER_NOTIFY_THRESHOLD`), an admin notification is sent.

## Refund Sync

Refunds created in WooCommerce are automatically synced to One Two Inventory:

- **Line-item refunds** (with quantities) create itemised refund lines and restock items to the default return warehouse
- **Monetary-only refunds** (no quantities) create a single refund line with the full amount and the WC refund reason

Refunds are deduplicated by WooCommerce refund ID, so they are safe to re-process.

## Invoice Notes and Customer PDF Downloads

When an invoice is generated for a WooCommerce order, the system pushes invoice metadata to the WC order. The customer-facing invoice PDF download is then handled by the **OneTwoInventory Helper** WordPress plugin via a server-to-server handoff.

### How customer PDF downloads work

1. WC customer logs into their account and visits the My Account → Orders page (or the order detail page).
2. The helper plugin renders an **Invoice** button. The button URL is a WordPress nonce-protected REST endpoint on the WC site, NOT a direct IMS URL.
3. The customer clicks the button. The helper plugin:
   - Verifies the WC customer is logged in and owns the order (WordPress nonce + capability check).
   - Calls the IMS endpoint `POST /api/shopping/woocommerce/invoice-pdf` with an HMAC-signed payload containing the order ID, customer ID, timestamp, and nonce.
4. IMS verifies the HMAC signature, checks the order ownership, and streams the invoice PDF back to the helper plugin.
5. The helper plugin proxies the PDF to the customer's browser.

This means the customer never sees a direct IMS URL, no reusable token leaves the IMS, and order ownership is verified at both the WC and IMS layers.

### Shared secret

The HMAC signing key is the same value as the **WC webhook secret** (`wc_webhook_secret`). When you generate or rotate this secret in **Sync > WooCommerce > Orders**, paste the same value into the helper plugin's settings page (WP admin → Settings → OneTwoInventory Helper). The secret has two purposes:

1. Verifying incoming WC webhooks at IMS
2. Signing outgoing PDF requests from the helper plugin to IMS

Rotating this secret requires updating it in BOTH places — IMS and the WP helper plugin — or webhooks AND invoice PDF downloads will both break.

### Admin-only links

When the invoice is also synced to Xero, the system pushes an admin-only WC order note with a "View in Xero" link. This link is stored as WC order meta (`_accounting_invoice_url`) and is only visible to WC admin users.

## onetwoInventory Helper WordPress plugin

A single companion WordPress plugin provides every WC-side hook IMS uses. The plugin is **installable directly from the IMS sync page** — go to **Sync → WooCommerce → Connection** and click **Download plugin (.zip)**.

### What it does

- **Invoice buttons** (Customer My Account orders list, customer order detail, wp-admin order screen meta box). Reads `_invoice_pdf_url` and `_accounting_invoice_url` order meta. HPOS-compatible.
- **FX rate receiver** — exposes `POST /wp-json/oti/v1/fx-rates`. IMS pushes daily ECB rates here, signed with HMAC-SHA256 using the same shared secret as WC webhooks. Stored rates are surfaced to Aelia Currency Switcher via the `wc_aelia_currencyswitcher_exchange_rate` filter, so the storefront, IMS, and Xero see the same exchange rate.

### Installation

1. In the IMS, go to **Sync → WooCommerce → Connection** and click **Download plugin (.zip)**.
2. In WordPress admin, go to **Plugins → Add New → Upload Plugin**, choose the zip, and click **Install Now**.
3. Activate the plugin.
4. In WordPress admin go to **Settings → onetwoInventory** and paste the same shared secret used for WC webhooks (visible in the IMS Sync → WooCommerce → Orders tab).
5. Back in IMS, on the same Connection page, tick **Push FX rates daily** and click **Push Now** to verify connectivity.

### Aelia Currency Switcher

If you use Aelia, you do not need to register a custom rate provider — the helper plugin's filter takes effect automatically as soon as IMS has pushed at least one set of rates. Aelia's transient cache is invalidated on each push so new rates take effect immediately. Aelia per-currency markups still apply on top of the IMS rate; only the *base* rate is overridden.

### Other multi-currency plugins

The helper plugin only ships with the Aelia filter today. If you use a different multi-currency plugin (CURCY, WPML, Shopify Markets, etc.) the rates are still stored in WP options and exposed via `get_option('oti_fx_rates')` — write a small adapter in your theme's `functions.php` to feed them into your plugin's rate model.

## Sync Log

The **Sync Log** tab shows the last 100 synchronisation events. Each entry includes:

- **Direction** — From store (import) or To store (push)
- **Type** — ORDER, Product, or StockLevel
- **External ID** — the storefront entity ID
- **Status** — SYNCED, FAILED, or SKIPPED
- **Error** — details if the sync failed

Use this log to troubleshoot sync issues and verify that orders and products are flowing correctly.

## Cron Jobs

WooCommerce is now webhook-first. Scheduled jobs exist for backup reconciliation and retry draining, not as the primary intake path.

### Primary scheduled endpoint

Use `/api/cron/wc-reconcile` as the scheduled WooCommerce endpoint. By default it should run roughly daily.

What it does:

1. Reconciles orders if order webhooks are not active or the daily backup reconcile is due
2. Reconciles products if product webhooks are not active or the daily backup reconcile is due
3. Runs the daily stock catch-up by draining queued retry jobs and force-pushing current stock

Order reconcile also backfills orders that were intentionally skipped while `wc_initial_import_completed` was not yet `true`. The reconcile path uses its own `last_wc_order_reconcile_at` cursor, so the first reconcile after initial import completion can import those missed live orders.

The cron endpoints require a `CRON_SECRET` header for security. Cron setup is usually handled by your administrator during deployment.

## Historical Order Import (Forecasting)

Separately from the order sync, you can import past completed WooCommerce orders for **demand forecasting** from the Analytics page. This creates stock movement records (not sales orders) used by the forecast algorithm. See the [Analytics documentation](analytics.md) for details.

## Warehouse Configuration

Stock sync and order allocation use warehouses marked with **Sync to Store**:

- Stock push aggregates available quantities across all synced warehouses
- Imported orders are assigned to the first synced warehouse that is also marked as default
- Configure this per-warehouse in **Settings > Inventory**

## Troubleshooting

| Issue | Solution |
|---|---|
| Orders not importing | Check that order sync is enabled, the initial import is complete, and the relevant WC statuses are selected |
| Webhooks not received | Verify the webhook secret matches in both systems. Check the Sync Log for entries. Try "Setup Webhooks" again. |
| Wrong tax on imported orders | Import tax rates from WooCommerce and verify the mappings on the Tax Rates tab |
| Stock not updating in WC | Ensure stock sync is enabled and at least one warehouse has **Sync to Store** checked |
| Duplicate orders | Order import is idempotent — duplicates are skipped. Check the Sync Log for SKIPPED entries. |
| Consumer secret rejected | Re-enter the full consumer secret (not the masked version). Generate a new key in WooCommerce if needed. |
