# Stock Control

Stock Control covers three key operations: **stock adjustments** (correcting quantities), **warehouse transfers** (moving stock between locations) and **stock counts** (a structured physical count that books its differences as adjustments). They are the three items under **Stock Control** in the sidebar.


## Stock Adjustments

Use stock adjustments to correct stock levels when physical counts differ from the system, or when stock is written off, donated, or otherwise changed outside of normal purchasing and sales.

### Single Adjustment

On a product's page, use the stock adjustment form: choose the warehouse, enter the quantity change (positive to add, negative to remove), choose the **Reason** (required when reasons are configured), and optionally add a note. Click **Apply Adjustment**.

- **Unit cost** (base currency). Leave blank to use the product's average cost. It is **required for an addition when the product has no existing cost** at all, because stock booked at zero would be sold later at zero cost; the form then refuses with a message asking for a unit cost. Enter **0** only for genuinely free stock such as samples.
- Removals always take the cost of the oldest layers (FIFO), so no cost is asked for.

### Bulk Adjustment

At **Stock Control > Stock Adjustments**, click **New Adjustment** to adjust several products in one batch.

1. Search for a product by SKU or name (use the arrow keys and Enter to pick) and it is added as a line. Repeat for each product.
2. For each line choose the **Warehouse** and **Reason** (the reason may be left as "No reason"), optionally type a **Note** (up to 500 characters; it is stored after the reason name), enter the **Qty (+ / -)** and, if needed, the **Unit cost**. Quantity boxes keep what you type, including a half-typed value such as `-`, until you save.
3. Click **Save Adjustments**. Lines with a blank or zero quantity are ignored; if every line is blank you are told to enter a non-zero quantity for at least one product.

Saving the same batch twice by accident (a double click or a retry) does not book it twice.

The page also offers **Import Opening Stock** (a CSV of `sku`, `warehouseCode`, `qty` and `unitCostBase`; each product and warehouse can have opening stock applied only once), a stock-levels export with warehouse and "Include bundles" options, and a CSV **Template**, **Export** and **Import** for adjustments. Below the buttons the history lists every adjustment; use the pencil on a row to change its quantity or note.

### Adjustment Reasons

When adjustment reasons are configured, a single adjustment requires one (a bulk line can be saved without). With none configured the form shows a free-text **Reason / Note** box instead. Common reasons include:

- Stocktake correction
- Damaged goods
- Theft / shrinkage
- Sample / promotional use
- Opening stock

Adjustment reasons are **configurable in Settings**. You can add, rename, or remove reasons to match your business processes.

### Xero Account Mapping

Each adjustment reason can be mapped to a Xero account. When adjustments are synced to Xero, the mapped account is used for the journal entry, ensuring your accounting records stay accurate.


## Stock Counts (Stocktakes)

**Stock Control > Stock Counts** is a guided stocktake. A stock count snapshots the book quantity of each product in a warehouse, you enter what you physically counted, and posting books the differences as stock adjustments. Anyone who can make stock adjustments can run counts.

### Running a count

1. Click **New count**, pick the **Warehouse**, optionally add notes, and click **Create & snapshot**. This records the current book quantity of every stocked, operational product in that warehouse (archived products are left out). It is refused if the warehouse holds nothing countable.
2. The count appears in the list with a reference, its warehouse, a status (**Draft**, **In progress**, **Completed** or **Cancelled**) and a **Counted / lines** tally. Click the row to open it.
3. For each line you see the **Book qty**, and type the **Counted** quantity; the **Variance** (counted minus book) updates as you type, red for a shortage and green for a surplus. Lines you leave empty are not posted. Click **Save counts** whenever you want to keep your entries and come back later.
4. Click **Reconcile** (once reconciled, the button reads **Refresh reconciliation**). Nothing is booked yet; see below.
5. Optionally pick a **Variance reason** (from your adjustment reasons) and click **Authorise and post variances**. You are asked to confirm, because posting books stock adjustments that consume or create FIFO layers and cannot be undone. At least one line must be counted.
6. **Cancel count** abandons the count without posting anything.

### How posting is protected

Posting is a two-step check so a count is never booked against stock that has since moved:

1. **Reconcile** stamps, for every counted line, the on-hand figure the count is being reconciled against and refreshes the line's book quantity and variance to it. Nothing is booked.
2. **Authorise and post variances** re-reads on-hand under the stock lock. If any counted product's on-hand is no longer the figure it was reconciled against (a receipt landed, an order shipped, the warehouse stock sync ran), or the line was never reconciled, or its counted figure changed after the reconcile, nothing is posted. A table lists each affected product with its earlier on-hand (or "not reconciled"), current on-hand, counted quantity and revised variance, and your counts are kept. Reconcile again to accept the current figures, then authorise again, or investigate first.

Counts under a warehouse that mirrors the warehouse system in **Align To WMS** mode are blocked, because the stock sync would overwrite them. A warehouse in notification-only mode asks you to confirm ("Post anyway?") before posting. See [Warehouse (Mintsoft)](warehouse.md).

## Warehouse Transfers

Warehouse transfers move stock from one warehouse to another. They need at least two active warehouses; with fewer, **New Transfer** is disabled and a notice links to Inventory Settings to add one. A transfer goes through a defined lifecycle:

### Transfer Statuses

| Status | Meaning |
|---|---|
| **Draft** | The transfer has been created but not yet actioned. Lines can still be edited. |
| **In Transit** | Stock has been sent from the source warehouse. On-hand stock at the source is reduced. |
| **Received** | Every line has arrived at the destination warehouse. On-hand stock at the destination is increased. |
| **Cancelled** | The transfer has been cancelled. If it was already in transit and nothing has arrived, stock is returned to the source warehouse. |

### Creating a Transfer

1. Click **New Transfer**.
2. Select the **source warehouse** and the **destination warehouse**, and optionally add notes.
3. Search for products and add them as lines, entering the quantity to transfer. The list shows stock at the source (on hand, with available in brackets when they differ); a quantity above what is available at the source is shown in red.
4. Save the transfer as a draft.

### Dispatching

Click **Dispatch** on a draft to confirm that stock has left the source warehouse. You are asked to confirm, because the system books the stock out of the source warehouse immediately and consumes its FIFO cost layers. It can only be undone with **Cancel dispatch** (below).

### In-Transit Stock

Between dispatch and receipt, the stock is **in transit**. It is no longer available at the source warehouse and not yet available at the destination. In-transit stock does not count towards available stock at either location.

### Receiving

An in-transit transfer has two ways to receive:

- **Mark Received** books everything still outstanding into the destination warehouse and completes the transfer.
- **Receive Partial** opens a dialog listing each line's **Remaining** quantity, with a **Receive now** box for each (it starts at the full remaining amount). Enter what has physically arrived and click **Receive selected**. You cannot receive more than remains on a line, and at least one line needs a quantity. The transfer **stays in transit** until every line is fully received, and the **Received** column on each line shows progress. Use this when a shipment arrives in parts.

Stock the warehouse system has already brought in (through its stock sync) counts as arrived, so a transfer it has fully accounted for shows nothing outstanding. An in-transit transfer also has a button to create the warehouse's goods-in notice (ASN) where a warehouse integration is connected; see [Warehouse (Mintsoft)](warehouse.md).

### Cancelling

- A **draft** can be cancelled at any time (after a confirmation); no stock has moved.
- An **in-transit** transfer is cancelled with **Cancel dispatch** (the no-entry icon beside the receive buttons), which returns the stranded stock to the source warehouse. Use it only if the transfer will never be received. It is refused, and the icon is hidden, once any part of the transfer has been received or the warehouse system has brought stock in; finish receiving it instead.

### Importing transfers from CSV

**Template**, **Export** and **Import** sit above the list. The columns are `transferKey`, `fromWarehouseCode`, `toWarehouseCode`, `status`, `sku`, `qty` and `notes`. `status` can be Draft, In Transit or Received. Rows that share a `transferKey` become the lines of one transfer, and a transfer is created whole or not at all.

- **Optional `dispatchedAt` column** (not in the template; add it yourself). For In Transit and Received rows, it records when the transfer was really dispatched, so a transfer sent before you started using IMS carries its real dispatch date. Use `YYYY-MM-DD` (read as 12:00 UK time) or a full date-time with a zone offset such as `2026-10-20T14:30:00Z`. It cannot be on a Draft row, cannot be in the future, and cannot be more than 366 days old; other formats (for example `20/10/2026`) are refused by name. It only moves the date shown: the stock movement itself is booked at import time. All rows of one transfer must carry the same value.
- **One bad row spoils the whole transfer.** If any row of a `transferKey` is invalid (unknown warehouse or SKU, bad quantity, bad `dispatchedAt`, or rows that disagree on warehouses, status, dispatch date or notes), nothing is created for that transfer, and the result names the transfer and the first bad row. Fix the file and re-import it; the valid transfers around it are unaffected.

A transfer that stays in transit for a long time is reported to administrators as stranded, counted from its dispatch date.


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
