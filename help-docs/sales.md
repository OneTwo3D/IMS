# Sales Orders

Sales orders track customer purchases from creation through to allocation, multi-shipment dispatch, and completion. Orders can be created manually or imported automatically from WooCommerce.

## Sales Order List

The sales order list provides a searchable, sortable overview of all orders.

- **Search** by order reference, customer name, or other fields
- **Filter by status** to focus on orders at a specific stage
- **Export to CSV** for reporting or use in external tools
- **WMS status** — when an order ships from a warehouse bound to a WMS (e.g. Mintsoft), a chip shows the WMS's fulfilment state (e.g. new, picking, dispatched, cancelled). The order detail page refreshes it live and deep-links to the order in the WMS admin; the list shows the most recent cached value. An order only pushes to the WMS once it is paid and ready to fulfil and dispatch push is enabled (see Settings → System → Scheduler).

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

Allocation rows also record the **recipe version** of the line's product. If a kit's component list
(or its Kit/BOM type) changes afterwards, those rows describe a recipe that no longer exists, and
Confirm for Picking, Start Picking and dispatch all refuse them and ask you to **Re-Allocate** the
order. See *Kit / Bundle* in the Inventory guide for what moves the version.

The allocation rows themselves still **cover those commitments**: an allocation row records the order's whole claim on a warehouse — what is still to be picked plus what has already been picked, packed or dispatched from it. So a row does not shrink when a shipment goes out, and the allocation panel keeps showing the full allocated quantity. Two things are read off it: the stock still *reserved* for the order (allocated minus dispatched — dispatch is the point at which stock and reservation are actually released), and the quantity still *to ship* (allocated minus every non-PENDING shipment). Because the row keeps covering its shipments, a warehouse can only be changed, and a row only reduced, while nothing has shipped from it — dispatched quantity stays with the warehouse it shipped from.

For Kit / Bundle products, allocation works from the underlying components rather than the virtual parent SKU. Bundle quantities are expanded into their component requirements, and shipment lines are created for those component rows.

### Draft Shipments and Allocation Changes

A shipment stays in **Pending** until someone starts picking it, and while it is Pending it is only a
draft built from the allocation rows behind it. So whenever those rows change — a manual allocation
edit, a re-allocation, a deallocation, or an automatic release after a stock decrease — any Pending
draft the new allocation no longer covers is **retired** in the same step. Drafts the change still
covers are left exactly as they are, including any tracking number and shipping service already on
them.

Retirement is recorded in the activity log with the shipment's id, warehouse, line count, quantity
and tracking number. The record is written in the *same database transaction* as the deletion, so
there is no window in which a draft can disappear without leaving its identity behind. If a retired
draft already carried a tracking number, the label was bought outside IMS and IMS no longer
references it — **cancel it with the carrier if it was not used**. Once the allocations are right
again, run **Confirm for Picking** to rebuild the drafts.

Because a retained draft is genuinely harmless, an order carrying nothing but Pending drafts is still
eligible for automatic backorder allocation — that is what repairs a kit whose sibling component was
trimmed by a stock decrease. An order holding a Picking, Packed or Shipped shipment is not.

Shipments that are already Picking, Packed or Shipped are commitments, not drafts: they are never
retired this way, and allocation edits that would leave them uncovered are refused instead.

A re-allocation that computes exactly the same set writes nothing at all — no allocation churn, no
reservation movement, no accounting change — but it still checks the drafts. If it finds one that an
*earlier* change had already left unbacked, it retires it there and then, rather than leaving it for
Start Picking to fail on.

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

A shipment can only move forward, and only while its order is live. **A cancelled order's shipments
cannot be picked, packed or dispatched** — dispatching one would ship goods for a sale that no longer
exists, and recognise costs that nothing reverses. Cancelling an order normally deletes its pending,
picking and packed shipments in the same step, so this rarely arises; if one is still attached, open
the order and use **Discard shipments**. That deletes the remaining non-dispatched shipments, keeps
any already-dispatched one (reverse those with a refund), records what it removed — including
tracking numbers — in the activity log, and is safe to repeat.

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

## Dispatch Email (direct orders)

Direct (non-storefront) orders can optionally email the customer a branded dispatch notification when the order transitions to SHIPPED. It includes the dispatched items, carrier and tracking number(s), and a tracking link, and is queued at most once per order. Storefront orders are excluded — the storefront sends its own dispatch email once IMS pushes tracking back.

Off by default; enable in **Settings > Sales > Dispatch Email**. See [Documents & Email](documents-email.md) for details.

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

### Deleting a payment the accounting system already holds

A payment recorded here is registered against the invoice in your accounting system. Once that
registration has been sent, **deleting the receipt here is refused** — deleting it would leave the
ledger showing the invoice settled while One Two Inventory shows it unpaid, which is the
"PAID IN LEDGER ONLY" state that then has to be chased by hand.

The refusal names the document id and gives you the way out:

1. Reverse (delete) the payment in the accounting system, where you can choose the date and deal
   with any bank reconciliation it touches.
2. Come back to the order and use **"I have reversed it — check and delete"** on that receipt.

One Two Inventory then **asks the accounting system whether that payment is really gone** before it
removes anything. If the accounting system still reports the payment, the deletion is refused again
and tells you the status it saw — your word alone is never enough to remove a local receipt while a
real ledger still holds the money. The retired sync row keeps the document id, so the order's
history still shows which payment existed and was undone.

A receipt whose registration is still queued (nothing has been sent yet) deletes normally, and the
queued registration is cancelled with it. A receipt against a **credit note** settles the credit
note rather than the invoice, so this check does not apply to it.

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

### Deleting an order (and when you can't)

Delete is a **hard** delete: the order row and its lines are removed outright, so nothing would be left in IMS pointing at anything an external system may already hold. It is therefore only available for orders that have never reached one, and IMS refuses it when any of the following are true:

- the order is not `DRAFT`, `PENDING_PAYMENT` or `ALLOCATED`;
- it has refunds or payments;
- it has been **claimed for or sent to the WMS** (a push link exists in any state);
- it carries an **accounting invoice id**, which means an invoice was posted for it — this survives even after the sync logs age out of retention;
- an **accounting document for it is queued, in flight, failed or already posted** — a `PENDING`/`PROCESSING`/`SYNCED`/`FAILED` sync log for the order or one of its shipments;
- it is included in a **daily accounting batch** that is queued or posted — the A1 revenue deferral or the A2 inventory allocation. Those journals are keyed by batch date, not by order, so they cannot be un-posted from the order screen; finance has to reverse the batch entry.

**The right remedy depends on the blocker — cancelling is NOT always correct.** The refusal message says which case you are in:

| Blocker | What to do |
| --- | --- |
| Queued document (`PENDING`, no external id) | **Cancel** the order. Cancelling retires the still-queued invoice before it posts and propagates a cancellation to the WMS. |
| In-flight document (`PROCESSING`) | **Wait** for it to settle, then delete or reverse depending on the outcome. A freshly claimed row is deliberately not retired by cancelling, because the remote call may already be on its way. |
| Posted document (`SYNCED`, or any row carrying an external id) | **Finance-led reversal or credit note** in the accounting system. Cancelling the order does *not* reverse a posted invoice — it would leave a live receivable and recognised revenue against a cancelled order. |
| Failed document (`FAILED`) | **Check the connector first.** A failed sync does not prove nothing was posted: the remote call happens before the result is written back, so the document may exist. Resolve the sync log once you know which it was. |
| Daily batch | **Finance reverses the batch entry.** It is keyed by batch date, not by order. |
| WMS push link | **Cancel** the order, which withdraws the WMS order. |

Deleting in any of these cases would strand the external document with nothing in IMS referencing it. Drafts, which never queue an accounting invoice, stay freely deletable.

**On the order screen, Delete is greyed out once the refusal is predictable.** The order page knows about the accounting leg, so it disables the button and puts the reason (and the remedy) in its tooltip rather than letting you press it and read a refusal: "an accounting invoice is queued — cancel the order instead" while the invoice is only queued, and "finance has to raise a credit note or reversal" once one has actually been posted. The button stays visible, greyed, so the action is still discoverable. The other blockers in the list — the WMS push link, a daily batch, refunds and payments — are only known to the server, so those still come back as a refusal message when you press Delete.

The check, the allocation release and the delete all run under a single lock on the order row, and the posting workers claim their work under that same lock before making a remote call — so no worker can start posting an order in the window between the check and the delete.
