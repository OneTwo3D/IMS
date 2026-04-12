# WooCommerce Integration

One Two Inventory connects to your WooCommerce store to automatically import orders, sync products, push stock levels, and keep order statuses aligned between both systems. Configuration is managed from the **Sync** page.

## Getting Connected

1. Navigate to **Sync** in the sidebar and click the **WooCommerce** connector card
2. On the **Connection** tab, enter:
   - **Store URL** — your WooCommerce site address (e.g. `https://yourstore.com`)
   - **Consumer Key** — generated in WooCommerce under Settings > Advanced > REST API
   - **Consumer Secret** — shown once when you create the key in WooCommerce
3. Click **Save Settings**

Once connected, a green "Connected" badge appears and the remaining tabs become available.

> **Note:** The consumer secret is masked after saving. To change it, enter the full new value — the system detects and ignores the masked placeholder.

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
- Multi-currency orders are converted to GBP using the current exchange rate
- Tax rates are resolved using the tax rate mappings you configure (see Tax Rates below)
- The order number uses your configured WooCommerce prefix (e.g. `WC-1234`, set in Settings > Company > Document Numbering)
- Stock is auto-allocated from warehouses marked "Sync to WooCommerce"

**WooCommerce "completed" orders** receive special handling: the system auto-allocates stock, creates shipments, applies any tracking information from the WC order meta (AST plugin), and transitions the shipments through to Shipped status.

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

- Only warehouses with **Sync to WooCommerce** enabled contribute to the stock count (configured per-warehouse in Settings > Inventory)
- Available stock = on-hand quantity minus reserved quantity, summed across all synced warehouses
- **Include COGS** — optionally pushes the oldest FIFO cost layer unit cost to WooCommerce's native COGS field (requires WooCommerce 9.2+ or the WC COGS plugin)
- Stock is pushed in batches of 100 products via the WC batch API

Use **Push Stock Now** for an immediate sync, or let the cron job handle it automatically.

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

### Optional WordPress Plugin

A WordPress must-use plugin is available at `lib/connectors/woocommerce/wc-invoice-buttons.php`. When installed in `wp-content/mu-plugins/`, it adds:

- **Customer My Account**: "Invoice" action button on the orders list
- **Customer order detail**: "Download Invoice PDF" button
- **Admin order screen**: an "Invoice" meta box with PDF download and accounting system links

The plugin is compatible with WooCommerce High-Performance Order Storage (HPOS).

## Sync Log

The **Sync Log** tab shows the last 100 synchronisation events. Each entry includes:

- **Direction** — From WC (import) or To WC (push)
- **Type** — ORDER, Product, or StockLevel
- **WC ID** — the WooCommerce entity ID
- **Status** — SYNCED, FAILED, or SKIPPED
- **Error** — details if the sync failed

Use this log to troubleshoot sync issues and verify that orders and products are flowing correctly.

## Cron Job

If webhooks are not used (or as a fallback alongside webhooks), the system polls WooCommerce on a schedule via the `/api/cron/wc-sync` endpoint. This endpoint:

1. Imports new and updated orders (incremental, using a last-synced watermark)
2. Syncs products if product sync is enabled
3. Pushes stock levels if stock sync is enabled

The endpoint requires a `CRON_SECRET` header for security. See the [Installation guide](installation.md) for cron setup instructions.

## Historical Order Import (Forecasting)

Separately from the order sync, you can import past completed WooCommerce orders for **demand forecasting** from the Analytics page. This creates stock movement records (not sales orders) used by the forecast algorithm. See the [Analytics documentation](analytics.md) for details.

## Warehouse Configuration

Stock sync and order allocation use warehouses marked with **Sync to WooCommerce**:

- Stock push aggregates available quantities across all synced warehouses
- Imported orders are assigned to the first synced warehouse that is also marked as default
- Configure this per-warehouse in **Settings > Inventory > Warehouses**

## Troubleshooting

| Issue | Solution |
|---|---|
| Orders not importing | Check that order sync is enabled, the initial import is complete, and the relevant WC statuses are selected |
| Webhooks not received | Verify the webhook secret matches in both systems. Check the Sync Log for entries. Try "Setup Webhooks" again. |
| Wrong tax on imported orders | Import tax rates from WooCommerce and verify the mappings on the Tax Rates tab |
| Stock not updating in WC | Ensure stock sync is enabled and at least one warehouse has "Sync to WooCommerce" checked |
| Duplicate orders | Order import is idempotent — duplicates are skipped. Check the Sync Log for SKIPPED entries. |
| Consumer secret rejected | Re-enter the full consumer secret (not the masked version). Generate a new key in WooCommerce if needed. |
