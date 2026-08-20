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
- **Cart coupons ride on the line items.** WooCommerce allocates coupon money *into* the lines — each line's total is already its subtotal minus that line's share — so IMS imports the coupon as a per-line discount and leaves the order-level discount field at zero. The coupon codes are still recorded on the order for display. Only money WooCommerce left unallocated (a coupon shape IMS does not model) is stored as an order-level discount, and that is logged as a warning when it happens. Storing it in both places made every downstream document — the Xero/QuickBooks invoice, the credit note, the order totals — deduct the same coupon twice. Orders imported before this fix still carry the duplicate and are corrected separately
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

**There is a supported size for a variable product: 1,000 variations.** A product's variations are
read in full *before* anything is written, and then applied in a single transaction, so that a
failure anywhere leaves the catalogue exactly as it was. That transaction has a budget, and 1,000
variations is what fits inside it. A larger product is **refused before the first write**, with an
exception-inbox row naming the count — importing part of a product and reporting success would leave
the catalogue silently incomplete. The remedy is to split the product in WooCommerce; raising the
limit means raising the write transaction's budget with it.

Two related refusals come from the same place. If WooCommerce does not report a readable page count
for a product's variations, the import stops rather than treating the first page as the whole set —
that used to end the read silently and apply a truncated product as if it were complete. And if
reading the variations takes longer than five minutes, the import gives up and retries later, so that
a slow store cannot leave a webhook in flight long enough for a second worker to pick the same one up.

### What the connector will NOT change

WooCommerce models two product shapes (`simple`, `variable`); IMS models six. A WooCommerce type is therefore an *absence* of information about everything else IMS knows, never an assertion that the product has none — so the import may set a product's type only when the existing IMS row is **SIMPLE**. On any other type the type write is dropped and everything else in the payload (name, price, images, dimensions, trade fields, category, WooCommerce mapping) still applies:

| Existing IMS type | Why the connector may not change it |
|---|---|
| KIT / BOM | Composition is IMS-owned and WooCommerce cannot express it. Flattening to SIMPLE left the component rows in place and stopped in-flight orders expanding into components |
| VARIABLE | Other rows carry its id as their `parentId`, and a parent must be VARIABLE. Flattening it orphans its children and leaves its option rows behind |
| VARIANT | A variant must stay attached to a variable parent. The import writes `type` but never `parentId`, so a detach would leave a SIMPLE row still carrying a parent |
| NON_INVENTORY | Means "not stock-tracked" (a service or fee). Converting it silently gives it stock levels, allocation and COGS |

A brand-new product still takes its type from WooCommerce: a row that does not exist yet has no structure to protect.

Two further refusals apply to rows the table above allows the connector to change:

- **A product that is in use is not restructured.** Before turning a SIMPLE row into a variable parent, or into a variation of one, the import runs the same checks the product editor runs: a product carrying stock, reserved stock, or open sales / purchase / manufacturing / stock-transfer documents is left exactly as it is. The exception row names what is blocking it — "stock on hand (5.00)", "1 open sales order line" — so the fix is the same one the editor would ask for. The structural write itself re-asserts that condition, so an order placed or stock received *while the import was running* still refuses the change rather than sneaking past a check that had already been answered.
- **A product that is already somebody's variation never becomes a parent.** If the IMS row carries a parent of its own, no variations are attached to it, whatever its type currently says.
- **A product that already has child rows is neither flattened nor promoted.** Only a variable product may have children, but nothing in the database enforces that, and older versions of this connector could leave a flattened product with its variants still attached. The import asks whether other IMS rows point at this one — it does not take the type's word for it — and if they do while the type says otherwise, it changes nothing: it will not price the row as a standalone product (which would bury the problem), and it will not turn it into a variable parent (which would silently adopt rows WooCommerce never mentioned). Repair it in the product editor — detach or remove the child rows, or make it a variable parent — and the next sync goes through.

When a refusal applies, the row is left **structurally and commercially** untouched: its type, its own regular/sale price and its variation options all stay as they are. Only the fields WooCommerce genuinely owns — name, description, images, dimensions, trade fields, category, status, WooCommerce mapping — are still written.

A variation is also only matched to an existing IMS row when that row is genuinely the one the WooCommerce variation owns: not mapped to a different WooCommerce object, not already a child of a *different* IMS parent, not itself a parent, of a type that can sit under a variable parent, and not carrying stock or open documents. A bare SKU match is not enough.

When a refusal means WooCommerce data goes **unimported**, the import is reported as failed, the product is not marked synced, the reconcile cursor does not advance past it, and a row appears in the [Sync Exception Inbox](sync-exceptions.md). Resolve it in IMS or in WooCommerce; the next successful sync clears the row by itself. There are four ways to reach that state, and they are one rule — *the two systems disagree about whether the row is a variable parent*, asked of the row's **type and its actual child rows**, not of its type alone:

- a **variable** WooCommerce product paired with an IMS row that cannot be a parent (a kit, a row that is already somebody's variation, a row that already has child rows its type does not allow, or a row carrying stock or open documents) — none of its variations are imported;
- a **simple** WooCommerce product paired with an IMS **VARIABLE** row — its type and its price are not applied, and the IMS variants stay where they are. The connector will not delete IMS children that WooCommerce never asked it to remove;
- a **simple** WooCommerce product paired with an IMS row that has child rows while its type says it cannot — the same disagreement, reached through a row that is already invalid. Its type and price are not applied either;
- a single variation whose SKU resolves to an incompatible IMS row.

A kit or BOM paired with a **simple** WooCommerce product is **not** one of these. That is the ordinary bundle pairing: neither side claims the row is a parent, WooCommerce simply has nothing to say about composition, and nothing goes unimported — so the sync is clean and the product keeps receiving its price and status updates.

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
