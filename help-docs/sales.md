# Sales Orders

Sales orders track customer purchases from creation through to allocation, multi-shipment dispatch, and completion. Orders can be created manually or imported automatically from WooCommerce.

## Sales Order List

The sales order list provides a searchable, sortable overview of all orders.

- **Search** by order reference, customer name, or other fields
- **Filter by status** to focus on orders at a specific stage
- **Export to CSV** for reporting or use in external tools

## Creating a Sales Order

To create a new order manually:

1. Click **New Sales Order**
2. Search for and select a customer
3. Add products by searching your inventory
4. Set quantities, prices, and any discounts
5. Add notes if needed
6. Save the order

### WooCommerce Integration

When WooCommerce sync is configured, orders are imported automatically into the system. These orders display a **WooCommerce link** that takes you directly to the order in your WC admin panel. This link only appears for orders that were synced from WooCommerce (i.e. those with a WC Order ID).

WooCommerce orders always enter the IMS as **Processing**. When WooCommerce marks an order as **completed**, the IMS treats that as the external dispatch signal: it auto-allocates stock, creates shipment rows if needed, advances those shipments through the internal `PICKING -> PACKED -> SHIPPED` workflow, and stores any tracking information received from WooCommerce. See the **WooCommerce Integration** guide for details on sync configuration.

## Order Statuses

Sales orders use the canonical sales order workflow documented in `docs/workflows.md`. User-facing order stages include:

| Status | Description |
|---|---|
| **Draft** | Order created but not yet confirmed |
| **Pending Payment** | Order awaiting payment |
| **On Hold** | Order paused, awaiting further action |
| **Processing** | Order confirmed and being prepared |
| **Allocated** | Stock has been allocated from warehouses |
| **Picking** | Items are being picked from the warehouse |
| **Packing** | Items picked, being packed for dispatch |
| **Shipped** | Order has been dispatched to the customer |
| **Completed** | Order fulfilled and closed |
| **Delivered** | Order confirmed as delivered (requires delivery tracking module) |
| **Cancelled** | Order cancelled, stock reservations released |
| **Partially Refunded** | Order has one or more refunds but is not fully refunded |
| **Refunded** | Order has been fully refunded |

The exact allowed transitions are kept in the canonical workflow reference so UI help does not drift from the enforced state-machine rules.

## Stock Allocation

Stock allocation determines which warehouse(s) will fulfil each order line. The system uses an **OrderAllocation** model to track per-line, per-warehouse allocation.

### Auto-Allocation

The smart auto-allocation algorithm minimises the number of shipments by consolidating warehouses. It analyses stock availability across all warehouses and assigns lines to as few warehouses as possible.

When re-allocating after a partial shipment, the algorithm only allocates the **remaining unfulfilled quantity** — items already committed to active (non-PENDING) shipments are excluded automatically.

For Kit / Bundle products, allocation works from the underlying components rather than the virtual parent SKU. Bundle quantities are expanded into their component requirements, and shipment lines are created for those component rows.

### Allocation Panel

The order detail page includes an allocation panel that shows:

- **Allocations grouped by warehouse** -- see which warehouse fulfils which lines
- **Backorder items** -- lines where insufficient stock is available (shows remaining qty, not full order qty, when partial shipments exist)
- **Manual edit** -- override allocations manually if needed

The allocation panel reappears whenever there are unfulfilled order lines, even after some shipments have already been created or shipped. This enables the partial fulfillment workflow described below.

### Shipment-Only Fulfillment

The IMS no longer supports direct order-level dispatch. Orders must be fulfilled through shipment rows:

- allocate stock
- confirm allocations to create shipments
- progress each shipment through `PENDING -> PICKING -> PACKED -> SHIPPED`

This same shipment workflow is used for both manual fulfillment and external fulfillment signals coming from storefront or WMS integrations.

## Partial Fulfillment

When not all products are in stock, you can ship what's available now and fulfil the rest later:

1. **Allocate** available stock — the system allocates what it can, with backorder lines shown for items that are out of stock
2. **Confirm allocations** to create shipments for the allocated items
3. **Ship** those shipments — the order stays at **Allocated** status (not Shipped) because unfulfilled lines remain
4. **Deallocate** remaining allocations if needed — the order stays at Allocated (not reverted to Processing) because active shipments exist
5. When new stock arrives, the **allocation panel reappears** for the remaining lines
6. **Re-allocate** the remaining items and confirm to create new shipments
7. **Ship** the final shipments — the order auto-transitions to **Shipped** once all shipments are shipped

This flow works seamlessly with the multi-shipment system. Each round of allocation and confirmation creates new shipments without affecting previously shipped items.

## Multi-Shipment System

Orders can be shipped in multiple shipments, each from a different warehouse. The system uses **Shipment** and **ShipmentLine** models to track each shipment independently.

### Shipment Workflow

Each shipment progresses through its own lifecycle:

```
PENDING --> PICKING --> PACKED --> SHIPPED
```

### Shipment Features

- Each shipment gets an **independent tracking number**
- Select a **shipping carrier** from the configurable carrier dropdown
- **Tracking links** open the carrier's website when delivery tracking is enabled
- Multiple shipments can be in different stages simultaneously

## Delivery Tracking

When the delivery tracking module is enabled (in **Settings > Sales**), the system supports:

- **Carrier selection** from a configurable list of shipping carriers (Royal Mail, DPD, DHL, FedEx, UPS, and others)
- **Tracking URLs** for 13 pre-configured carriers with a 17track fallback
- **Delivery status updates** via WooCommerce (AST plugin) or TrackShip API
- **DELIVERED status** becomes available as the final order status

See [Settings > Sales](#delivery-tracking-settings) for configuration details.

## Refunds

To process a refund:

1. Open the sales order and select **Refund**
2. Choose the items and quantities being returned
3. Select the **return warehouse** where the stock will be received back
4. Confirm the refund

Returned stock is added back into the selected warehouse's inventory automatically.

For Kit / Bundle sales, refunds reverse the component-level stock movements. Returned stock, FIFO cost restoration, and shipment reversal all happen against the underlying component products.

### Refund-time cost revaluation

When a refund processes returned stock, the system uses the **current** cost-layer unit cost — not the snapshot recorded at shipment time. This means if a landed-cost revaluation has changed the unit cost since the original shipment, the refund's COGS reversal uses the up-to-date value. The returned stock is also valued at the current cost.

This keeps the returned-stock balance sheet entry aligned with the live cost layers. Note that the COGS reversal amount may differ from the originally-posted COGS amount by the revaluation delta — this is the expected behaviour for single-snapshot accounting.

### Refunds without a shipment source

If a sales order line was allocated but never shipped, the refund rejects with a clear message: *"Cannot return refunded stock for product X: no shipped stock source exists"*. The system refuses to silently restock from an allocation-only source — there's no actual stock movement to reverse.

You can still process the refund as cash-only by leaving the return warehouse unset.

### Warehouse-scoped idempotency

The refund return-stock movement is bound by `(refundId, refundLineId, warehouseId)`. This means split returns to different warehouses don't collide — you can return part of an order to Warehouse A and part to Warehouse B in the same refund without idempotency conflicts.

### WooCommerce refund deduplication

Refunds synced from WooCommerce are deduplicated by `externalRefundId`. If a duplicate webhook fires (network retry, race condition), the second delivery is silently absorbed without creating a duplicate refund.

## Payments

You can record payments against a sales order:

- **Add a payment** with the amount, date, method, and reference
- **Delete a payment** if it was recorded in error

Payment records help you track outstanding balances on each order.

## Invoice Generation

Invoices can be generated either manually or automatically. The trigger for automatic invoice generation is configurable in **Settings > Sales Settings**. Options include:

- **Manual** — you generate the invoice yourself when ready
- **On ship** — invoice is created automatically when the order is shipped
- **On paid** — invoice is created automatically when payment is received in full

### Editing an order after it has been pushed to the accounting system

Editing a sales order that already has an external accounting invoice (Xero) queues a
`SALES_INVOICE_UPDATE` to push the changes through, instead of silently dropping them. The update
payload is constructed by the same builder used for the original push, so what Xero sees matches a
fresh post would have sent. A payload-derived idempotency key prevents duplicates if you re-save
without any content change.

If the active accounting connector is QuickBooks (not Xero), IMS records a
`sales_invoice_update_skipped_unsupported_connector` WARNING and does not queue the update. The
behaviour is symmetric with the purchase bill edit path.

If the accounting connector rejects the update (e.g. the external invoice is locked, paid, or
voided), an amber **rejected sync** alert appears at the top of the sales order detail page with
the connector, timestamp, retry count, and a safely truncated error message. Operators correct the
underlying issue and retry the failed sync from the Sync Dashboard; once the row transitions out of
`FAILED`, the alert disappears.


## Multi-Currency and FX

Sales orders can be in any configured currency. The system handles the conversion to your base currency for reporting and accounting.

### How the FX rate is locked

When you create an order:

- The current stored exchange rate for the order date is fetched from the FX rate table.
- The rate is stamped on the order as `fxRateToBase`.
- All base-currency totals on the order use this stamped rate.

Even if the daily rate changes tomorrow, the order's base-currency totals don't drift. This stamping is forwarded to Xero as `CurrencyRate` so Xero uses the same rate the IMS recorded.

### Realised FX gain/loss on settlement

When a multi-currency invoice is paid weeks or months later, the actual settlement exchange rate may differ from the rate booked at invoice creation. The system computes the **realised FX gain/loss** at payment time and books it to a configured FX P&L account in Xero.

Example: a €100 invoice booked at €1 = £0.85 (so £85 in base) but paid two months later at €1 = £0.88 (so £88 received) realises an £3 FX gain.

The realised FX entry is queued as a `REALISED_FX_JOURNAL` accounting sync row and posted to Xero via the standard daily batch.

### Tax inclusive vs exclusive

The system supports both pricing modes per tax rate:

- **Exclusive** — the price entered is the net amount; tax is added on top. Common for B2B orders.
- **Inclusive** — the price entered includes tax. The system back-calculates the net amount. Common for B2C orders.

When creating a sales order via API or CSV import, you can optionally include a `taxForeign` value as an assertion. If the asserted value doesn't match what the system would compute from the unit price, quantity, and rate (within a small rounding tolerance), the order is rejected. This prevents the silent class of bug where the upstream sends the wrong tax amount.

### VAT reporting

The VAT report (Analytics > VAT) correctly handles both modes:

- **Tax-exclusive orders** — `taxableBase = totalBase`.
- **Tax-inclusive orders** — `taxableBase = totalBase - taxBase`.

This means the taxable base column in the report shows the net amount in both cases, comparable across tenants regardless of pricing mode.

## Documents

Three PDF documents are available for each sales order:

- **Sales Order PDF** — a summary of the order for internal use or to send to the customer
- **Invoice PDF** — the formal tax invoice, generated manually or automatically
- **Packing Slip** — a picking/packing checklist showing SKU, product name, location, quantity, and a tick box for each item. Available from the order's ⋮ menu. When an order has multiple shipments from different warehouses, items are grouped by shipment with a section heading per warehouse. If shipments have not yet been created, the packing slip falls back to the sales order lines.

PDFs use your company branding (logo, colours, and footer) as configured in Settings.

## Other Actions

- **Clone an order** to quickly create a new order based on an existing one
- **Update notes** to add internal comments or special instructions to any order
- **Email documents** directly via SMTP with PDF attachments (sales order or invoice)
