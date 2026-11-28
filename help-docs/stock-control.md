# Stock Control

Stock Control covers three key operations: **stock adjustments** (correcting quantities), **warehouse transfers** (moving stock between locations) and **stock counts** (a structured physical count that books its differences as adjustments). They are the three items under **Stock Control** in the sidebar.


## Stock Adjustments

Use stock adjustments to correct stock levels when physical counts differ from the system, or when stock is written off, donated, or otherwise changed outside of normal purchasing and sales.

### Single Adjustment

On a product's page, use the stock adjustment form: choose the warehouse, enter the quantity change (positive to add, negative to remove), choose the **Reason** (required when reasons are configured), and optionally add a note. Click **Apply Adjustment**.

- **Unit cost** (base currency). Leave blank to use the product's average cost. It is **required for an addition when the product has no existing cost** at all, because stock booked at zero would be sold later at zero cost; the form then refuses with a message asking for a unit cost. Enter **0** only for genuinely free stock such as samples.
- Removals always take the cost of the oldest layers (FIFO), so no cost is asked for.

**Removing stock that is reserved for orders.** A removal that is larger than the available stock (on hand minus reserved) is refused, with a message to release the reservations first. An administrator can switch on the setting `stock_adjustment_release_reserved` (off by default): a single removal, or a bulk batch of one line, then releases the allocations of the newest orders first, as far as the removal needs, in the same step, and records each release on the order. Allocations that a picked, packed or shipped shipment already covers, or that have already been posted to the accounts, are not released, and the removal is refused as before if that leaves too little. Transfers and purchase-order returns are not affected.

### Bulk Adjustment

At **Stock Control > Stock Adjustments**, click **New Adjustment** to adjust several products in one batch.

1. Search for a product by SKU or name (use the arrow keys and Enter to pick) and it is added as a line. Repeat for each product.
2. For each line choose the **Warehouse** and **Reason** (the reason may be left as "No reason"), optionally type a **Note** (up to 500 characters; it is stored after the reason name), enter the **Qty (+ / -)** and, if needed, the **Unit cost**. Quantity boxes keep what you type, including a half-typed value such as `-`, until you save.
3. Click **Save Adjustments**. Lines with a blank or zero quantity are ignored; if every line is blank you are told to enter a non-zero quantity for at least one product.

Saving the same batch twice by accident (a double click or a retry) does not book it twice.

The page also offers **Import Opening Stock** (a CSV of `sku`, `warehouseCode`, `qty` and `unitCostBase`; each product and warehouse can have opening stock applied only once), a stock-levels export with warehouse and "Include bundles" options, and a CSV **Template**, **Export** and **Import** for adjustments. Below the buttons the history lists every adjustment; use the pencil on a row to change its quantity or note. A valued adjustment that has no reason (every row of an adjustments CSV import, which has no reason column), a reason with no account, or no mapped inventory account cannot post a journal: with Xero sync and the inventory-adjustment sync type on, it appears in the exception inbox as a stock adjustment journal to post by hand. Nothing is raised while Xero sync or that sync type is off.

### Reason and unit cost required (not yet switched on)

A system setting, `stock_adjustment_reason_cost_required`, is **off by default**, and everything described above is how IMS behaves while it is off. The owner turns it on at go-live. Once it is on, so that stock value in IMS and the inventory account in Xero cannot drift because of an adjustment:

- **Every adjustment needs a reason**: a single adjustment, every bulk line (the "No reason" choice is gone), every row of an adjustments CSV import (a new `reason` column, holding the name of an active adjustment reason; the template then includes it), and every stock count variance.
- **The reason needs an account.** An adjustment that moves value while Xero sync and the inventory-adjustment sync type are on is refused, with a message naming the reason to map, when that reason has no account (or no inventory account is mapped). Nothing is saved and nothing goes to the exception inbox; map the account in Settings and save again. Adjustments that move no value (an entered unit cost of 0) and adjustments made while Xero sync is off are not refused for this.
- **A blank unit cost on an addition uses the latest receipt cost**, never an average: the unit cost of the most recently received **purchase-receipt or production-output** layer of that product in that warehouse (then, if it has none there, in any warehouse). A receipt booked by a Mintsoft Align To WMS increase counts as a purchase receipt; the components released by a disassembly do not count as production output. Stock received at a cost of 0 is skipped. Layers that are not a fresh price are never used: stock recreated by a transfer, units restocked by a refund and earlier plain adjustments. **Only when the product has no receipt or production layer at all** (for example straight after a first load, where its stock exists only as opening stock) the cost of the latest **opening-stock** batch is used instead (this warehouse first, then any), still skipping a cost of 0 and still never an average. Layers received at the same moment are ordered by when they were created. The form shows that figure in the unit cost box (roles that may not see cost figures see only that a default exists). If the product has none of these, enter a unit cost; the adjustment is refused until you do. Enter **0** only for genuinely free stock.
- **Removals** still take the cost of the oldest layers (FIFO), as before.
- **Stock counts** post their variances under the **Variance reason** you pick or, if you pick none, under an active adjustment reason called **Stock count** (IMS does not create it: **create, activate and map the Stock count reason** in Settings > Adjustment reasons before turning the setting on). With neither, posting is refused and nothing is booked. A surplus on a count is valued at the latest receipt cost in the same way, falling back to the latest opening-stock cost for a product that has only opening stock.
- **Editing** an adjustment is stricter with the setting on, because an edit in place cannot post or revise an accounting journal. Only a plain stock adjustment (made from the adjustment form, the bulk dialog or the CSV import) can be edited: a supplier return, a stock-count variance and a Mintsoft align-down are refused, with a message saying where to correct them. While accounting posting applies, an edit that changes the value of the adjustment (for example +5 entered at 0, edited to -5) is refused: reverse the adjustment with a new one of the opposite sign, then enter the correct adjustment with a reason and unit cost. An edit that leaves the value unchanged (a note, or a zero-value quantity change) still works. A removal edited into an addition is valued at the latest receipt cost (never an average), and refused if there is none.
- **Opening stock** is not affected: it already needs an explicit unit cost and is its own movement type.

Before turning it on: map an account to every adjustment reason in use (including the one used by the Mintsoft align-down), create, activate and map the **Stock count** reason, and make sure the inventory account is mapped (the Mintsoft align-down also needs the inventory account mapped while the setting is on: without it the align-down is held as a manual discrepancy instead of being applied).

The adjustments CSV export gains a `reason` column while the setting is on, so a downloaded file imports again. If the accounting connector the accounts were set up for is no longer the active one, the refusal says so (re-map for the active connector) instead of asking you to map an account.

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

**Stock Control > Stock Counts** is a guided stocktake. A stock count snapshots the book quantity of each product in a location (a warehouse), you enter what you physically counted, and posting books the differences as stock adjustments. Anyone who can make stock adjustments can run counts. You can count the whole location, or **prepare** a count by choosing exactly which products go on it (see [Prepared counts](#prepared-counts-choose-the-products-first)).

### The count list

The list shows every count with its **Date** (when it was created), **Reference**, **Location**, **Type** (Whole location or Prepared), **Status**, number of **Lines** and a **Counted / lines** tally. Use the status filter at the top right to show only Draft, In progress, Completed or Cancelled counts.

### Running a count

1. Click **New count**, pick the **Warehouse**, optionally add notes, and click **Create & snapshot**. This records the current book quantity of every stocked, operational product in that warehouse (archived products are left out). It is refused if the warehouse holds nothing countable.
2. The count appears in the list with a reference, its warehouse, a status (**Draft**, **In progress**, **Completed** or **Cancelled**) and a **Counted / lines** tally. Click the row to open it.
3. For each line you see the **Book qty**, and type the **Counted** quantity; the **Variance** (counted minus book) updates as you type, red for a shortage and green for a surplus. Lines you leave empty are not posted. Click **Save counts** whenever you want to keep your entries and come back later.
4. Click **Reconcile** (once reconciled, the button reads **Refresh reconciliation**). Nothing is booked yet; see below.
5. Optionally pick a **Variance reason** (from your adjustment reasons) and click **Authorise and post variances**. You are asked to confirm, because posting books stock adjustments that consume or create FIFO layers and cannot be undone. At least one line must be counted.
6. **Cancel count** abandons the count without posting anything.

### Prepared counts: choose the products first

Use a prepared count when you only want to count some products, for example one shelf or one supplier's range.

1. Click **New count**, pick the **Location**, choose **Prepared (choose products)** and click **Choose products...**.
2. In the selection window, search by product name or SKU, and narrow the list by **Product type** (simple, variant, manufactured), by state (active, archived, or both) and by category. Tick the products you want. Your ticks are kept while you change the search or the filters, and the footer shows how many you have selected. **Select all shown** ticks every product on screen that can be added. Parent products of variants, kits and non-inventory items are not offered because they have no stock of their own. Archived products only appear when you ask for them.
3. Click **Create count**. The count is created as a Draft holding exactly the products you picked, each at its current book quantity (0 for a product with no stock in that location).

The list stays editable until the count is posted or cancelled. Open the count and click **Add products** to open the same selection window; a product already on the count is marked **Already on this count** and cannot be ticked, and the server refuses a duplicate even if one is submitted. To take lines off, tick the box at the start of each line and click **Remove selected**. A line can only be removed while it is not yet counted and not reconciled; a line with a counted quantity has no tick box. If you need to remove one, clear its counted quantity and click **Save counts** (that also drops its reconciliation), then remove it. If a request includes a line that can no longer be removed, nothing is removed and the message names each such product. A count always keeps at least one line: to drop them all, cancel the count instead.

You can also add products to a whole-location count that is still open, but lines can only be removed from a prepared count (a whole-location count covers every stocked product, so leave one uncounted instead). Products you add are uncounted and are not posted until you enter a quantity for them.

### Triage the variances: tabs, sorting and bulk accept

When you open a count, the lines have a row of tabs above them: **All lines**, **No variance**, **Small variance** and **Needs review**, each with the number of lines in it. A line is judged on its counted quantity against the book quantity shown. Lines you have not counted yet are only under **All lines**.

- **No variance**: the count equals the book quantity exactly.
- **Small variance**: the count differs, but by no more than the small-variance threshold.
- **Needs review**: any other difference, which is where your attention goes.

**Small-variance threshold.** Set it with the fields above the table: a number of **units** and/or a **percentage** of the stock on hand, then **Save threshold**. Leave a field blank to not use it; when both are filled in a line must be within both. It starts empty, so until you set it **no line counts as small** and every difference is under **Needs review**. The threshold applies to all counts and is recorded in the activity log when it changes.

**Sorting.** The sort box above the table offers **Default order** (by SKU, as before), **Variance (quantity)** and **Variance (value)**, largest difference first in either direction (short or over). The value is the difference multiplied by the average cost of the stock on hand in that location, shown in **Est. value**; a product with no stock cost shows a dash, sorts after the costed lines, and the value is not shown on a closed count. The value is a guide for ordering, nothing is booked from it. Your tab and sort are kept in the page address, so a refresh or a shared link shows the same view.

**Accepting in bulk.** On the **No variance** tab, **Accept N line(s) with no variance** reconciles all of those lines in one go. It is the same reconcile as above, and nothing is booked for them because there is nothing to book. Save your counts first: only saved counts are accepted. IMS checks every line again at the moment you accept, against the counted quantity as saved and the stock on hand as it is then, and accepts only lines whose difference is still exactly zero, and whose counted quantity and book quantity are still exactly the figures on your screen. If someone recounted a line, or stock moved since you loaded the page, that line is left out and the message tells you how many were; they stay in the list for review.

On the **Small variance** tab, **Accept N small-variance line(s)...** does the same for lines within the threshold, after you confirm. The same exact-figures check applies: a line whose count or stock changed since you loaded the page is left out even if it is still small, and if the threshold itself was changed meanwhile nothing is accepted and you are told. Accepting only reconciles the lines. The differences are still booked, as stock adjustments, when you **Authorise and post variances**, in exactly the way they are for any other line, so the stock movements and costs are the same as if you had accepted them one at a time.

The activity log records who bulk-accepted, which kind of lines, how many were accepted and how many were left out.

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
- An **in-transit** transfer is cancelled with **Cancel dispatch** (the no-entry icon beside the receive buttons), which returns the stranded stock to the source warehouse. Use it only if the transfer will never be received. It is refused, and the icon is hidden, once any part of the transfer has been received or the warehouse system has brought stock in; finish receiving it instead. Cancelling the dispatch also closes the transfer's warehouse ASN in IMS (so it no longer holds align-down for its SKUs); IMS cannot cancel it in Mintsoft, so the screen tells you to ask the warehouse to cancel it. It is refused while the ASN's creation is unconfirmed or the warehouse has booked it in and IMS has not yet reconciled that; use **Recheck booked-in** first.

### Importing transfers from CSV

**Template**, **Export** and **Import** sit above the list. The columns are `transferKey`, `fromWarehouseCode`, `toWarehouseCode`, `status`, `sku`, `qty` and `notes`. `status` can be Draft, In Transit or Received. Rows that share a `transferKey` become the lines of one transfer, and a transfer is created whole or not at all.

- **Optional `dispatchedAt` column** (not in the template; add it yourself). For In Transit and Received rows, it records when the transfer was really dispatched, so a transfer sent before you started using IMS carries its real dispatch date. Use `YYYY-MM-DD` (read as 12:00 UK time) or a full date-time with a zone offset such as `2026-10-20T14:30:00Z`. It cannot be on a Draft row, cannot be in the future, and cannot be more than 366 days old; other formats (for example `20/10/2026`) are refused by name. It only moves the date shown: the stock movement itself is booked at import time. All rows of one transfer must carry the same value.
- **One bad row spoils the whole transfer.** If any row of a `transferKey` is invalid (unknown warehouse or SKU, bad quantity, bad `dispatchedAt`, or rows that disagree on warehouses, status, dispatch date or notes), nothing is created for that transfer, and the result names the transfer and the first bad row. Fix the file and re-import it; the valid transfers around it are unaffected.

A transfer that stays in transit for a long time is reported to administrators as stranded, counted from its dispatch date.


## Quarantine: unsellable returns (switched off by default)

Returned goods that cannot be sold again should not go back into sellable stock at their full cost (FRS 102 s13.4: stock is carried at the lower of cost and estimated selling price). With the **condition check on returns** switched on (the `return_condition_check_enabled` setting, **off by default**), every restock of a return that you record asks for the condition of the items, and unsellable items are kept apart in a **quarantine warehouse** until you decide what to do with them. With the switch off, nothing on this page applies: returns go to the warehouse chosen for them, as before, and no condition is asked for.

**Who switches it on.** It is an administrator switch with no on/off control on screen, because it changes which stock is sellable. An administrator sets it on the server with `npm run settings:set -- --key return_condition_check_enabled --value true --by <name> --reason "<text>" --yes --confirm-admin`. **Settings > Sales > Condition check on returns** shows whether it is on, and lists every quarantine warehouse that still looks sellable: one marked available for sale, sync to store, default warehouse, default return warehouse or available in purchase orders, or with sellable work pointing at it (a warehouse-system binding, allocations still reserved for orders, unshipped shipments, open production orders, purchase orders still to be received there; transfers into a quarantine warehouse are fine, that is how damaged stock is moved there). **Turning the switch on is refused while that list is not empty**: the command checks it in its dry run and again when it writes, and names each warehouse and what to fix.

### Setting up the quarantine warehouse

A quarantine warehouse is a warehouse whose **Type** is **Quarantine** (**Settings > Inventory > Warehouses**). It holds goods **in your own premises**: quarantine is kept in IMS only. Create one (for example code `QAR`) before the switch goes on. While the switch is on:

- A quarantine warehouse cannot be marked **Available for sale**, **Sync to store**, **Default warehouse**, **Default return warehouse** or **Available in purchase orders**: saving it with any of those is refused with a message naming the option to clear. Default return warehouse is refused because storefront refunds restock there without a condition, so sellable returns would land in quarantine unseen; purchase orders are refused because a quarantine warehouse takes only unsellable returns and transfers, and new purchases received into it would be fresh stock booked as unsellable.
- **Changing a warehouse to type Quarantine** is refused, **whether or not the switch is on**, while it has a warehouse-system (Mintsoft) binding, allocations still reserved for orders (orders already shipped do not count), shipments not yet shipped, open (draft or in-progress) production orders, transfers in transit into it or purchase orders still to be received there. The refusal names what is left; finish, move or release it first.
- **Changing a quarantine warehouse to another type** is refused while the switch is on and it still holds stock, because the units would become sellable without anyone deciding so. Empty it first: write units off with a stock adjustment, or transfer the sellable ones to a sellable warehouse (below).
- It cannot be bound to a warehouse system (**Warehouse** page, Mintsoft binding): nothing in it is ever reported to the warehouse system as sellable.

### What quarantine stock is (and is not)

Units in a quarantine warehouse are **on hand at their cost**, but they are not sellable. While the switch is on they are:

- **never allocated** to an order: automatic allocation leaves the warehouse out, and a manual allocation to it, moving an allocation into it, or increasing an allocation already there, is refused (reducing or releasing one is allowed). The order page's allocation list does not offer it.
- **never counted as available**: the product list and product page count them in **On hand** but not in **Available** (the product page marks the warehouse **Quarantine** and shows 0 available there), the stock reports (**Analytics** stock on hand and stock allocations, and the Stock on Hand report) show them on hand with 0 available, and the dashboard stock tiles, the sales statistics, **Reorder Planning** and the forecast and reorder lists (**Analytics**, the reorder inventory list, and the draft purchase and production orders they create) leave them out, so quarantined units never cover demand or hold back a reorder.
- **never a reorder or production destination**: creating reorder purchase orders for a quarantine warehouse is refused, reorder production orders never go to one (they use the product's last production warehouse unless that is quarantine, then the first sellable warehouse), a new production order in a quarantine warehouse is refused, and an existing one there cannot be started or completed (it can still be cancelled).
- **never pushed to the store**: the WooCommerce stock push leaves the warehouse out even if it was flagged to sync.

Their value stays in Inventory: putting units into quarantine moves no value and posts no journal of its own.

### Recording the condition when you restock

- **Refund dialog** (sales order, **Refund**): when the refund returns stock to a warehouse, choose **Condition of returned items**. **Sellable** offers the ordinary warehouses; **Unsellable** offers the quarantine warehouses. The refund is refused if no condition is chosen, if an unsellable return is sent to an ordinary warehouse, or if a sellable one is sent to quarantine. **No stock return** needs no condition. An **unsellable** return of units that shipped from a warehouse bound to Mintsoft (or of an order Mintsoft holds) is refused before anything is recorded: those units go back to the 3PL, where Mintsoft counts them again, and quarantine is kept in IMS only, so the unit would be held twice once stock alignment books Mintsoft's count. Record it as **Sellable** into that warehouse (or with no stock return), then write the unit off by the route of that warehouse's binding (see *Writing off an unsellable unit at the 3PL* below); the refusal names the route. The stock comes back exactly as it would without the check: at the cost of the units that were shipped (the return cost layer), with the same cost-reversal journal as before. Only the warehouse is different. The condition is recorded on the refund's activity entry.
- **Mintsoft returns inbox** (**Warehouse** page, **Restock**): the restock dialog asks for the condition too, but only **Sellable** can be restocked. A Mintsoft return is at the 3PL, where Mintsoft still counts it; because quarantine is kept in IMS only, booking it into quarantine would hold the unit twice once stock alignment books Mintsoft's count into the bound warehouse. An unsellable unit at the 3PL is refused with that explanation. Instead, **restock it as Sellable into the bound warehouse**: that books the unit where it physically is and, for a parcel that belongs to a refund held in transit, clears the return expectation and its Stock in Transit (Dr Inventory / Cr Stock in Transit). Then write the unit off by the route of the warehouse's binding (below); the refusal names the route for the warehouse the return arrived at. Do not mark such an item Refunded only or Dismissed: a refund held in transit would keep its Stock in Transit open.

**Writing off an unsellable unit at the 3PL.** Do it promptly: until it is written off, the unit still counts as sellable stock. Who books the write-off depends on the Mintsoft binding (**Warehouse** page, bindings); the refusal, and the restock dialog's hint, name the route for the warehouse concerned:
- **Align To WMS, and align-down can run** (the binding and its connection are active, alignment is confirmed, the binding has an active **align-down reason** with an account, discrepancy thresholds are set, and the inventory account is mapped where the reason-and-cost rule needs it): have the 3PL **write the unit off in Mintsoft** (or confirm Mintsoft does not count it). A later stock sync, once it has seen the same difference twice, aligns IMS down and books the write-off under the align-down reason, so map that reason to your write-off account. **Do not also make a stock adjustment in IMS**: the next sync would book the unit back as a stock gain, leaving an extra write-off and gain in the ledger. Align-down can still hold a particular difference (larger than the thresholds, stock reserved for orders, open goods-in or a despatch not yet recorded); if the stock does not come down, check the open discrepancies.
- **Align To WMS, but align-down cannot run** (any of the conditions above missing; the refusal names which): have the 3PL write the unit off in Mintsoft (or confirm Mintsoft does not count it), then write it off in IMS with a **stock adjustment** in that warehouse with a reason mapped to your write-off account. That also clears the discrepancy.
- **Notification only** (or stock sync disabled, or the binding or connection inactive; nothing aligns IMS): have the 3PL make a **real write-off in Mintsoft** (or confirm Mintsoft does not count the unit), and write it off in IMS with a **stock adjustment** in that warehouse with a reason mapped to your write-off account (Dr the reason's account / Cr Inventory).
- When the warehouse's binding is not known, or the refunded units came from bound warehouses that disagree, both routes are given.
- Either way the write-off is valued at **FIFO**: the warehouse's oldest open layers, not necessarily at the returned unit's own layer (the restock added that layer at the shipped cost, and FIFO consumes the oldest first).

**With returns in transit on** (`refund_returns_in_transit_enabled`, an administrator switch), a refund restocks nothing when it is recorded: its units come back when the parcel is restocked from the returns inbox, and that restock is where the condition is asked (and, for a Mintsoft parcel, only Sellable is accepted, as above). So with both switches on the refund dialog asks **no** condition and records none, it does not offer quarantine warehouses, and a refund whose expected return warehouse is a quarantine warehouse is refused. In plain terms: **with both switches on, an unsellable return is never quarantined**. The parcel comes back to the 3PL, is restocked as Sellable from the returns inbox (which clears its Stock in Transit), and is then written off by the route above. With returns in transit off, the refund dialog asks for the condition as described above.

**Storefront refunds are not asked.** A refund imported from WooCommerce has no one to ask, so it is restocked to the **default return warehouse** exactly as before; storefront returns are handled with the returns-in-transit setting instead (see *Returned goods in transit* in [Sales Orders](sales.md)). Recording a **parked** storefront refund by hand (Sync exceptions) is the same storefront refund, so it too restocks to the default return warehouse without asking for a condition. If an unsellable unit arrives that way into an ordinary warehouse in your own premises, move it to quarantine with a transfer (below).

### Reviewing the quarantine

Filter any stock report by the quarantine warehouse to see what is waiting (**Analytics > Slow Stock** also marks quarantine units **Quarantine** on each row and adds a `quarantineQty` column to its CSV export when there are any). For each item, decide:

- **Write it off**: make a **stock adjustment** in the quarantine warehouse with a negative quantity and a reason mapped to your write-off account (see *Adjustment Reasons* and *Xero Account Mapping* above; the reason to use has not been named yet, so create and map one before the first write-off). The units leave at FIFO, the cost of the warehouse's oldest open quarantine layers, which is not necessarily the cost of the returned unit's own layer when several returns are waiting; the journal is Dr the reason's account / Cr Inventory, as for any removal. A reason without an account cannot post its journal.
- **Return it to stock**: make a **warehouse transfer** from the quarantine warehouse to a sellable warehouse in your own premises (dispatch and receive it as usual). The cost layers move with the units at their own cost, so nothing is revalued, and the units become available and are pushed to the store once received. Sending them on to the 3PL is a physical shipment: a transfer into a warehouse bound to Mintsoft raises its goods-in notice (ASN) as usual, and the units count there once Mintsoft books them in.

A return with some sellable and some unsellable items: record it with the condition of most of them, then move the others with a transfer (sellable warehouse to quarantine, or back). A transfer takes the oldest layers of the source warehouse, which may not be the returned units' own layer.

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
