# Stock Control

Stock Control covers two key operations: **stock adjustments** (correcting quantities) and **warehouse transfers** (moving stock between locations).


## Stock Adjustments

Use stock adjustments to correct stock levels when physical counts differ from the system, or when stock is written off, donated, or otherwise changed outside of normal purchasing and sales.

### Single Adjustment

Select a product and warehouse, enter the quantity change (positive to add, negative to remove), and choose an adjustment reason.

### Bulk Adjustment

Adjust multiple products at once. Add lines for each product and warehouse, enter quantities, and submit them as a single batch.

### Adjustment Reasons

Every adjustment requires a reason. Common reasons include:

- Stocktake correction
- Damaged goods
- Theft / shrinkage
- Sample / promotional use
- Opening stock

Adjustment reasons are **configurable in Settings**. You can add, rename, or remove reasons to match your business processes.

### Xero Account Mapping

Each adjustment reason can be mapped to a Xero account. When adjustments are synced to Xero, the mapped account is used for the journal entry, ensuring your accounting records stay accurate.


## Stock Counts (Stocktakes)

A stock count snapshots the book quantity of each product in a warehouse, you enter what you physically counted, and posting books the differences as stock adjustments.

Posting is a two-step check so a count is never booked against stock that has since moved:

1. **Reconcile** stamps, for every counted line, the on-hand figure the count is being reconciled against and refreshes the line's book quantity and variance to it. Nothing is booked.
2. **Authorise and post variances** re-reads on-hand under the stock lock. If any counted product's on-hand is no longer the figure it was reconciled against (a receipt landed, an order shipped, the warehouse stock sync ran), or the line was never reconciled, or its counted figure changed after the reconcile, nothing is posted. The message lists each affected product with its earlier on-hand, current on-hand, counted quantity and revised variance, and your counts are kept. Reconcile again to accept the current figures, then authorise again, or investigate first.

Counts under a warehouse that mirrors the WMS in Align To WMS mode are still blocked, and notification-only warehouses still ask for confirmation.

## Warehouse Transfers

Warehouse transfers move stock from one warehouse to another. A transfer goes through a defined lifecycle:

### Transfer Statuses

Warehouse transfers use the canonical transfer workflow documented in `docs/workflows.md`.

| Status | Meaning |
|---|---|
| **Draft** | The transfer has been created but not yet actioned. Lines can still be edited. |
| **In Transit** | Stock has been sent from the source warehouse. On-hand stock at the source is reduced. |
| **Received** | Stock has arrived at the destination warehouse. On-hand stock at the destination is increased. |
| **Cancelled** | The transfer has been cancelled. If it was already in transit, stock is returned to the source warehouse. |

### Creating a Transfer

1. Click **New Transfer**.
2. Select the **source warehouse** and the **destination warehouse**.
3. Add lines by searching for products and entering the quantity to transfer.
4. Save the transfer as a draft.

### Dispatching

Click **Dispatch** to confirm that stock has left the source warehouse. The system books the stock out of the source warehouse immediately.

### In-Transit Stock

Between dispatch and receipt, the stock is **in transit**. It is no longer available at the source warehouse and not yet available at the destination. In-transit stock does not count towards available stock at either location.

### Receiving

Click **Receive** to confirm that stock has arrived at the destination warehouse. The system books the stock into the destination warehouse.

### Cancelling

A transfer can be cancelled at any stage. If stock has already been dispatched, cancelling the transfer returns it to the source warehouse.


## FIFO and Cost Layers

Every stock-in (purchase receipt, manufacturing output, transfer-in) creates a **cost layer** — a record of how much stock arrived at what unit cost, per warehouse. Every stock-out (sale, transfer-out, negative adjustment) consumes from the **oldest layer first** — strict FIFO. The system never picks layers out of order, and never lets a layer's remaining quantity go negative.

This means:

- **COGS is deterministic**: the same set of movements always produces the same COGS values, regardless of when reports are run.
- **Negative adjustments consume cost layers**: a write-off removes stock from the oldest layers and posts COGS at those layers' unit costs, not at today's price.
- **Landed-cost edits update historical layers**: when you edit a freight PO weeks after receipt, the affected layers' unit costs are recalculated and the COGS already booked on prior shipments is reversed/re-posted via balanced journal entries.
- **Transfers preserve cost layers**: when stock moves between warehouses, the cost layers move with it — the destination warehouse inherits the source's per-layer unit costs, not an averaged figure.

If you ever see a cost-layer invariant failure in the activity log or the inventory invariant report (e.g. `cost_layer_negative_remaining_quantity`), that's a data-integrity issue requiring repair — never normal operation. See [Troubleshooting](troubleshooting.md).


## Activity Log

All stock movements -- adjustments, transfers, purchase receipts, sales allocations, shipment dispatches, and build orders -- are recorded in the activity log. This gives you a complete audit trail of every change to every product's stock level.

Stock allocation for sales orders is managed by the dedicated allocation system, which tracks per-line, per-warehouse assignments using the `OrderAllocation` model. See the [Sales Orders](sales.md) documentation for details on the allocation and multi-shipment workflow.
