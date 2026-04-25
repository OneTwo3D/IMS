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

Once connected, a green "Connected" badge appears and the remaining tabs become available.

> **Note:** The consumer secret is masked after saving. To change it, enter the full new value — the system detects and ignores the masked placeholder.
>
> **Base currency check:** the WooCommerce store currency must match the IMS base currency before credentials or sync settings can be enabled. Order currencies may still vary per transaction; the IMS converts them into its own base currency for reporting and valuation.

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

## Tax Rates

The **Tax Rates** tab maps WooCommerce tax rates to One Two Inventory tax rates. This ensures imported orders have the correct tax treatment.

1. Click **Import from WooCommerce** to fetch all tax rates from your WC store
2. The system automatically creates matching IMS tax rates or links to existing ones by name
3. Review the mapping table — each row shows the WC rate name, ID, country, percentage, and the linked IMS tax rate
4. Use the dropdown to change the target IMS tax rate if needed
5. Delete mappings that are no longer relevant

Without tax rate mappings, imported orders fall back to the default IMS tax rate.

## Refund Sync

Refunds created in WooCommerce are automatically synced to One Two Inventory:

- **Line-item refunds** (with quantities) create itemised refund lines and restock items to the default return warehouse
- **Monetary-only refunds** (no quantities) create a single refund line with the full amount and the WC refund reason

Refunds are deduplicated by WooCommerce refund ID, so they are safe to re-process.

## Invoice Notes

When an invoice is generated for a WooCommerce order, the system pushes:

- A **customer-visible** order note with a link to download the invoice PDF
- An **admin-only** order note with a link to the accounting invoice (e.g. in Xero)

These are stored as WooCommerce order meta (`_invoice_pdf_url` and `_accounting_invoice_url`).

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
