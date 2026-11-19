# Sales Orders

Sales orders track customer purchases from creation through to allocation, multi-shipment dispatch, and completion. Orders can be created manually or imported automatically from WooCommerce.

## Sales Order List

The sales order list is a paged overview of all orders (50 per page). Search, the status filter and the page number are in the address, so a filtered view can be bookmarked or shared, and the line above the table says "Showing 1-50 of N sales orders".

- **Search** looks across **every** order in the database, not just the newest ones: order number, the storefront's order number, customer name, customer email, tracking number (on the order or any shipment) and the SKU of any line. Press nothing; the list updates a moment after you stop typing.
- **A search always includes Completed, Delivered and archived orders.** An archived order carries an **Archived** badge.
- **Hide completed** (ticked by default) keeps finished work out of the everyday list, and the line above the table says how many Completed and Delivered orders that hides. Untick it to see them. Choosing **Completed** or **Delivered** in the status filter shows them too.
- **Include archived** shows orders that data retention has archived (old Completed and Delivered orders). Archiving only hides an order from the default list; it is still searchable, and it changes nothing a report counts.
- **Filter by status** to focus on orders at a specific stage
- **Filter by invoicing** — the **Invoicing** filter shows orders that are **Not invoiced**, **Partially invoiced** or **Fully invoiced** (pick one or several). It is separate from the status filter and combines with it. Picking an invoicing state includes Completed and Delivered orders, because a shipped order that was never invoiced is exactly what it is for; archived orders stay hidden unless you tick **Include archived**. See [Invoicing state](#invoicing-state).
- **Quotes tab** — the **Quotes** button above the search shows only quotations (see [Quotations](#quotations)); **All orders** goes back. A quote carries a **Quote** badge, and an **Expired** badge once its validity date has passed.
- **Filter by a custom field** — when [custom fields](#custom-fields-on-orders) exist for orders, a drop-down lists every text field that has fixed choices, and every yes / no field, with each choice. Pick one to see only the orders holding that value (for example *Process stage: Pack*). Orders that have no value for the field are not matched by any choice. The filter is in the address, so it combines with search, status and the other filters and can be bookmarked.
- **Export to CSV** for reporting or use in external tools
- **Columns** — the **Status** column shows the order's stage. Use the column picker to add more, for example **Invoice** (Pending, Invoiced, Paid, or the refund state), **Stock Status**, **WMS Status** and **WMS Dispatch**. Your choice is remembered in your browser.
- **Refund state** — an order's refund state is separate from its stage (see [Order Statuses](#order-statuses)). On the list it shows in the **Invoice** column as **Part. Refunded** or **Refunded**.
- **WMS status** — when an order ships from a warehouse bound to a WMS (e.g. Mintsoft), a chip shows the WMS's fulfilment state (e.g. new, picking, dispatched, cancelled). The order detail page refreshes it live and deep-links to the order in the WMS admin; the list shows the most recent cached value. An order only pushes to the WMS once it is paid and ready to fulfil and dispatch push is enabled (see Settings → System → Scheduler). On an installation that is not yet allowed to write to the warehouse (the producer-side hold is switched on for it), nothing is pushed: the order stays as it is, the **Replay** and **Re-push** buttons say "Not sent by IMS: writes to Mintsoft are held on this installation" and change nothing, and IMS keeps only a record of what it would have sent. That record does not say whether the warehouse already holds the order (another system may have created it), so check the warehouse before acting. If you hold or cancel an order that Mintsoft has already started picking (or that Mintsoft has merged into another order), IMS cannot cancel it there: the order shows under **Sync → Exceptions** as "Hold not honoured" / "Cancel not honoured" and a **Raise a warehouse query** task is added under Exceptions for you to pass on to the warehouse (IMS writes no note on the Mintsoft order: the warehouse does not read them). IMS keeps watching the order, so if it ships after a hold the shipment is recorded as normal; if it ships after a cancel IMS does not record it for you and the order appears in the stuck-despatch list for you to decide what to do with the goods. An order whose creation timed out is linked to the order Mintsoft already holds for it once Mintsoft's own reference proves it is the same order; otherwise Replay on the "Create outcome unknown" row does the same check. The **WMS Dispatch** column shows whether IMS has sent the order to the warehouse (Queued, Pushed, Held, Cancelling, Cancelled, Failed or Payload invalid). See [Warehouse (Mintsoft)](warehouse.md) for how the warehouse connection works.

### Bulk actions on the list

Tick the box at the start of a row to select an order, or the box in the header to select every order on the page. A bar above the table shows how many orders are selected and offers three actions. Selection is per page: changing page or filter clears it.

- **Allocate** runs the same auto-allocation as the **Allocate** button on the order page, for each selected order that is in **Processing**. An order that is already allocated (or picking or packing) is skipped as "Already allocated"; a draft, on-hold or waiting-for-payment order is skipped as not ready; a finished or cancelled order has nothing to allocate. If stock is short the row says how many units wait on backorder.
- **Advance status** moves each selected order one step forward along the same flow as the order page's workflow button: Draft or Pending Payment to Processing, Processing to Allocated (the allocation above), Shipped to Completed, and Completed to Delivered (only when delivery tracking is on). It never ships, cancels or holds an order, and it queues nothing the single-order button would not queue. Orders in Allocated, Picking or Packing move on through their shipments, so they are skipped as "Not in a state that can advance"; so are archived orders and orders with no next step.
- **Print packing slips** opens one combined PDF with a slip per selected order (each starting on a new page), drawn exactly as the order page's packing slip. Draft and cancelled orders get no slip; a closing "Not printed" page lists them.

Each order runs on its own, one after another, using the same checks and permissions as its single-order button, so one order failing never stops the others and nothing is rolled back. When Allocate or Advance finishes, a result panel lists every selected order as **Done**, **Skipped** (with the reason) or **Failed** (with what to do), with totals at the top. You need the **sales.process** permission (Admin, Manager and Warehouse roles) to run Allocate and Advance; printing needs only sales access. At most 100 orders can be selected for one action; a page holds 50.

## Custom fields on orders

If your company has set up order fields in **Settings > Custom fields**, a **Custom fields** card appears at the bottom of the order page, grouped by the field's group name. Use it to record things IMS has no column for, such as a process stage or an internal reference, without a software change. Values are validated on the server by the field's type (text, dropdown choice, whole or decimal number, yes / no, date, date and time in UTC, JSON, link) and nothing is saved if any value is refused.

- **Who can change them.** The permission that lets you edit an order's notes (create sales orders). Anyone with sales access can read them. Changes are written to the **Activity Log**, which names the fields that changed but never their values.
- **Orders from WooCommerce start with no values.** Nothing is filled in automatically when an order is imported; operators enter them in IMS. They are not read back from the store.
- **Internal only.** Custom field values are never sent to WooCommerce, Mintsoft or Xero, and do not appear on invoices or other documents.
- **Personal data.** A free-text field can hold something about the customer. Custom field values on an order are **erased** with the order when the customer or order is erased (see [Personal-data erasure](erasure.md)), and an erased order can no longer be given values.
- **Hidden fields.** When an administrator hides a field it disappears from the card and the list filter, but its values are kept and return if the field is shown again.

## Creating a Sales Order

To create a new order manually:

1. Click **New Sales Order**
2. Search for and select a customer
3. Add products by searching your inventory
4. Set quantities, prices, and any discounts
5. Add notes if needed
6. Save the order

A Draft can be changed afterwards with **Edit order** (see *Editing an order* below).

The order form shows an estimated **COGS** per line, **Est. COGS** and **Est. Margin** to Admin, Manager and Finance users only; other roles do not see unit costs.

The **Ship From** warehouse is pre-selected with your default warehouse (the first warehouse if none is marked default); change it if the order ships from elsewhere. The stock figures beside each product are for the selected warehouse.

**VAT and "Incl. VAT".** The order has one default VAT rate and one setting for whether the prices you type include VAT. If prices include VAT, choose the order's default VAT rate: the VAT is taken out of the prices you typed, the order totals are what you typed, and the invoice goes to the accounting system as VAT-inclusive at those same prices. Ticking **Incl. VAT** while the default rate is **No VAT** and a line carries VAT (from its product's tax category or a rate you chose on the line) is refused, because the prices could be read two ways: choose the default rate, or untick **Incl. VAT** and enter net prices. The **Incl. VAT** box is always shown, even when the rate is **No VAT**. A draft saved earlier in that state cannot be moved out of Draft; cancel it and create a new order. Clones made and shipped before this was fixed have no invoice and need one raising by hand.

**Shipping and discount accounts must be set.** An order with shipping, or with an order discount, can only be saved or finalised once the matching account is set under **Settings > Accounting**. Otherwise the invoice would leave that amount out and not match the order total, so IMS refuses with a message such as "This order has shipping of ... but the shipping account is not set in the accounting settings" (or "... order discount ... the discount account is not set ..."). Nothing is saved, allocated or queued. Set the account and try again.

**An invoice that would not match the order is refused.** When a live order is created, IMS builds the invoice it would send and checks that it totals the same as the order (within a few pence of rounding). If it does not, the order is not saved and the message shows both totals.

**Design note: the invoice and the allocation are separate.** Creating a live order saves the order and queues its sales invoice in one step: either both exist or neither does. Allocating stock is a separate step after that and may legitimately leave the order unallocated or short (a backorder), exactly as a WooCommerce order is invoiced when it is imported, before any stock is allocated. When that happens IMS tells you: the create screen shows "The order was created, but: stock was NOT allocated ..." (or how many units are on backorder), the order's activity log carries an `allocation_failed` or `backorder_recorded` entry, and the order's allocation panel shows what is unallocated. The order is picked up again when stock arrives or when it is paid and moves to Processing (the backorder allocation and the reallocation sweep).

**Cloning.** **Clone** makes a new **Draft** with the same lines, prices and VAT basis. A draft holds no stock and has no invoice; move it out of Draft (for example to Pending Payment or Processing) when it is ready and stock is allocated and the sales invoice is queued then, exactly as for any new order. Allocating a Draft directly is refused. Finalising a draft is **one step**: the status change, the stock allocation and the queued sales invoice all succeed together or none of them does, so a failure (no stock, an invoice that does not match the order, a missing shipping or discount account) leaves the order as the draft it was. It also checks that the invoice that would be sent totals the same as the order (within a few pence of rounding); if it does not, for example because shipping is taxed at a different rate from the order's default rate, the draft is not finalised and the message shows both totals. A clone of a WooCommerce order whose shipping has its own rate hits this, because the order does not store the shipping rate. A clone of a WooCommerce order is always treated as an exclusive (net) document, because WooCommerce orders are stored net whatever the store displays; a clone of a manual order keeps its **Incl. VAT** setting.

### WooCommerce Integration

When WooCommerce sync is configured, orders are imported automatically into the system. These orders display a **WooCommerce link** that takes you directly to the order in your WC admin panel. This link only appears for orders that were synced from WooCommerce (i.e. those with a WC Order ID).

WooCommerce orders always enter the IMS as **Processing**. When WooCommerce marks an order as **completed**, the IMS treats that as the external dispatch signal: it auto-allocates stock, creates shipment rows if needed, advances those shipments through the internal `PICKING -> PACKED -> SHIPPED` workflow, and stores any tracking information received from WooCommerce. See the **WooCommerce Integration** guide for details on sync configuration.

**EU withdrawal requests.** If your store uses the EU order-withdrawal button plugin, a customer's request puts the order **On Hold** in IMS and shows a **Withdrawal hold** badge on the order. While it is held, IMS does not send the order to the warehouse. If the request is approved the order is cancelled. If it is rejected, the hold is deliberately **kept**, because a rejection only moves the storefront order back to its earlier status, and releasing it automatically would put goods back on the pick line. When you are satisfied, use **Release withdrawal hold** on the order (it asks you to confirm); the order stays On Hold, and moving it back to Processing then sends it to the warehouse again. Once an order has shipped, a withdrawal is a return, not a hold. See [WooCommerce](woocommerce.md#eu-withdrawal-requests).

### Duty and tax from WooCommerce

WooCommerce works out duty, import VAT and the delivery terms; IMS **never recalculates them**. For a WooCommerce order the order page shows a read-only **Duty and tax** panel, labelled "from WooCommerce", with what the store reported: the **IOSS number** and **delivery term** (IOSS_DDP or DDP) IMS recorded from the order's EU VAT treatment, the **duty**, **import VAT** and (when there is one) **handling fee** the store recorded, and any **customs value per unit** set on an order line in WooCommerce. A value the store did not report is simply not shown, and the panel does not appear when there is nothing to show. These values cannot be edited in IMS. When the order is edited in WooCommerce they follow on the next order update; if the store removes one, it disappears here too. Orders imported before this feature show nothing until WooCommerce next updates them.

## Quotations

A **quote** is an offer you send a customer before they order. In IMS a quote is a **Draft** order with a quote flag, a validity date and (once sent) the time it was queued for sending. It is not a new status, so every rule that applies to a Draft applies to it unchanged:

- **It reserves no stock.** A quote is never allocated, exactly like a Draft. Stock you quote is still available to everyone else.
- **It is not sent to the warehouse**, not invoiced, and not mirrored to WooCommerce.
- **Prices are held on the quote only for show.** Nothing is recalculated when the quote is converted.
- WooCommerce orders are never quotes.

**Creating a quote.** On **New Sales Order**, fill in the order as usual, set **Quote valid until** (it starts 30 days ahead) and click **Save as quote** instead of Save as Draft. The date must be a real date that is not in the past. A quote can be changed with **Edit quote** (its date too); an order that is not a quote cannot be turned into one, and a quote cannot be saved as a live order.

**The quote document.** The order's **Quote PDF** (the ⋮ menu) is the sales order document with a **QUOTE** heading and the line "Valid until ...". It prints no payment terms. Its wording comes from **Settings > Company > Documents > Quote**: until you save one it uses a built-in default that states this is a quotation, not an order or an invoice.

**Sending a quote.** Download the PDF and send it yourself, or switch on **Settings > Company > Documents > Email quotes to customers** (off by default). With it on a quote shows **Send quote**, which puts a branded email with the quote PDF on the same email queue as order confirmations. It is **queued, not sent at that moment**: the queue delivers it under your SMTP settings and the suppression list, so an installation with no SMTP configured mails nobody. An expired quote cannot be sent (edit its date first). The detail page shows when the quote was queued. Switching the setting off also stops a quote already waiting in the queue: it ends Failed with the reason and nothing is sent.

**Converting a quote to an order.** **Convert to order** clears the quote flag in one click. The order is then an ordinary **Draft** with the same lines and prices; you confirm it through the usual flow (**Process**), which allocates stock and queues the invoice. A quote cannot be processed, put on hold or invoiced before it is converted (it can be cancelled). If the validity date has passed, IMS asks for a note saying why the prices still stand; the note is added to the order's internal notes, and converting without one is refused.

**Cloning** a quote makes an ordinary Draft, not a quote.

## Customer Turnover

For how customer records are joined into one person, company grouping and the customer timeline, see [Customers](customers.md).

A customer's lifetime value, this-year sales and the Invoiced turnover card on the customer page use the same invoiced basis as the dashboard and reports: only orders that have an invoice count (an IMS-posted Xero invoice or, during the parallel phase, the Xeroom invoice number), paid or not, excluding cancelled and draft orders, with refunds netted in VAT-inclusive terms (a refund recorded ex-VAT is converted from its lines' stored tax). Where a refund cannot be converted exactly the figure is marked **≤** (at most), or **≈** (approximate, could be higher or lower) when the credit that could not be placed is zero, negative or mixed-sign.

## Order Statuses

Sales orders use the canonical sales order workflow documented in `docs/workflows.md`. User-facing order stages include:

| Status | Description |
|---|---|
| **Draft** | Order created but not yet confirmed |
| **Pending Payment** | Order awaiting payment |
| **On Hold** | Order paused, awaiting further action |
| **Processing** | Order confirmed and being prepared |
| **Allocated** | Stock has been allocated from warehouses |

While an order is Allocated, Picking or Packing and has shipments, a second chip beside the status shows fulfilment progress derived from those shipments: **Ready to pick**, **Picking (1 of 2 parcels)**, **Packed 1 of 2 parcels**, **Packed — ready to ship**, **Partially shipped 1/3** or **Dispatched 2/2 parcels**. It appears on the order page and in the sales list; it is not a separate status and nothing is stored for it.
| **Picking** | Items are being picked from the warehouse |
| **Packing** | Items picked, being packed for dispatch |
| **Shipped** | Order has been dispatched to the customer |
| **Completed** | Order fulfilled and closed |
| **Delivered** | Order confirmed as delivered (requires delivery tracking module) |
| **Cancelled** | Order cancelled, stock reservations released |

**Draft is a starting point only.** An order can leave Draft (to Pending Payment, Processing, Allocated, On Hold or Cancelled) but nothing moves back to Draft: once finalised, an order has been priced, allocated and invoiced. To change a finalised order use **Edit order**. A draft cannot be refunded (delete it instead). An order still waiting for payment can be refunded once a payment or receipt has been recorded against it; with nothing recorded there is nothing to refund, so delete the order if it was created in error. Do not cancel an order that has received money: a cancelled order cannot be refunded. **An order whose invoice has already been posted to the accounting system cannot be cancelled by hand** until it has been refunded in full: cancelling does not void the invoice or raise a credit note, so the receivable would stay in the ledger. Refund it in full (that raises the credit note), then cancel. This covers an invoice an operator marked as posted by typing its document id, and an invoice raised by the incumbent invoicing plugin (the order carries its invoice number). If the store cancels such an order, or an approved EU withdrawal cancels it, IMS follows the store, records a warning on the order's activity log and raises an operator task on the order (Sync > Exceptions, "Cancelled order with a posted invoice"): a cancelled order cannot be refunded in IMS, so raise the credit note against the invoice in the accounting system by hand, then mark the task done. The order's revenue deferral and inventory allocation journals also stay until they are reversed by hand. A refund line must name a line of the same order.

**Server checks on order money.** Shipping, fees, the order discount and line discounts cannot be negative, and the order's default VAT rate is always the value of the rate you named (a stale value in the form is replaced by the rate's current value).

**Refund state is shown separately.** Refunds no longer change an order's stage. An order that has been refunded keeps its stage (for example **Delivered**) and carries a second badge beside it: **Partially refunded** (orange) or **Fully refunded** (red). So the order detail page can show two badges, the order status and the refund status. Orders that used to read "Partially Refunded" or "Refunded" now show their real stage plus the refund badge, and the stage filter on the list has no refund entries. A fully refunded order takes no further payments.


### Invoicing state

**Invoicing is shown separately from the stage**, like the refund state. The order detail page carries a badge beside the status: **Not invoiced**, **Partially invoiced** or **Fully invoiced**. An order can be Shipped and Not invoiced, or Cancelled and Fully invoiced: a cancelled order keeps the invoicing state it had, so its invoicing history stays visible. The sales order CSV export has the state as its last column (`invoicingState`).

IMS works the state out itself from the order's invoices; you never set it. An order counts as **invoiced** when any of these holds:

- IMS has **queued or posted** a sales invoice for it (the moment the invoice is queued, the order reads invoiced; a posted invoice stays counted);
- the accounting invoice is **linked** to the order (it carries the accounting system's invoice id);
- during the parallel phase, the invoicing incumbent (Xeroom) has **raised the invoice** and its number is on a WooCommerce order: IMS reads that number, so the order reads invoiced.

What does **not** count: an invoice that failed without reaching the accounting system, one that was cancelled before it posted (for example, the order was cancelled first), and an invoice IMS only *recorded as a shadow* while writes to the accounting system are held. When the last invoice an order had is retired like that, the order goes back to **Not invoiced**.

**Credit notes and refunds do not un-invoice an order.** A fully refunded order that was invoiced stays **Fully invoiced**; the refund state shows the credit.

**Partially invoiced** means the invoice IMS holds covers fewer units than the order now holds. IMS invoices a whole order (there is no per-shipment invoice), so this is rare, for example units added to the order after its invoice was raised. An invoice IMS cannot read (one raised by Xeroom, or whose stored detail has been trimmed) reads **Fully invoiced**: IMS does not guess a shortfall it cannot measure.

When IMS is upgraded to this version, existing orders that already have invoice evidence are set to **Fully invoiced** by the upgrade itself. An order IMS could now find to be only partly covered is corrected by running `npm run sales:invoicing-state:recompute` once (add `-- --dry-run` to see how many orders it would change). It is safe to run again at any time: it only rewrites a state that is wrong.

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

The panel is **refund-aware**: units that have been refunded are no longer outstanding demand, so a refunded line is not offered for allocation and does not show as a backorder.

The allocation panel reappears whenever there are unfulfilled order lines, even after some shipments have already been created or shipped. This enables the partial fulfillment workflow described below.

### Pegging an order to a purchase order

When stock is being bought for one particular customer order, **peg** the order line to the purchase order. Stock received on that purchase order is then allocated to the pegged order **first**, up to the pegged quantity; whatever is left over follows the normal rule, oldest order first. This replaces holding other orders back or deallocating them by hand and undoing that after the receipt.

- **Peg to PO.** On the order page, the **Pegged to purchase orders** panel lists each line with a **Peg to PO** button (open orders only: Pending payment, On hold, Processing or Allocated). It opens a picker of the open purchase-order lines for that product that still have quantity that has not been received and is not already pegged to another order. Choose a line and a quantity. A line that has a peg shows a **Pegged** badge.
- **What is refused.** A peg larger than the unreceived quantity of the purchase-order line (less what other orders have pegged to it), or larger than what the order line still lacks (ordered, less allocated, less other pegs), is refused with the figure. A kit line cannot be pegged. Only a purchase order that has been sent and is still expecting goods can be pegged to.
- **How it behaves.** The stock that has landed for a peg is held for the pegged order: the reallocation sweep, the backorder allocation after any receipt and every other automatic allocation leave it alone, so an older order cannot be handed pegged stock (the hold sits in the warehouse the units were actually received into, which can differ from the purchase order's destination, and the pegged order's first allocation after a receipt draws only on stock received there), and automatic allocation never takes stock away from a pegged allocation to give it to another order. Receipts count however they arrive: receiving by hand, a warehouse ASN alignment, or a warehouse book-in. When stock is lost and reservations have to be released, a pegged order is released last. Stock is still shared between orders by quantity: pegging controls who is allocated first, it does not label individual units. Allocating by hand is unaffected.
- **When a peg ends.** A peg ends by itself when the order line is fully allocated, when the order is cancelled or fully refunded, when the order moves on to picking or beyond, when the purchase order is cancelled or closed, or when the purchase-order line is received without covering the peg (for example it was edited down). The end and its reason are written to the activity log of both the order and the purchase order. Deleting either line removes its pegs and records that in the same way. You can also remove a peg yourself (**Remove**); the stock it held then goes to the oldest waiting order.
- **Permission.** Creating or removing a peg needs **sales.process**, the same permission as allocating by hand (Admin, Manager and Warehouse). Everyone who can see the order sees the pegs.

Pegging is entirely inside IMS: nothing is sent to WooCommerce, the warehouse or the accounting system.

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

Services and fees on an order (a delivery charge, for example) never need a shipment, so they never hold an order back: the order moves to **Shipped** once every physical item has shipped.

**Dispatching from the app.** A shipment of an order that is still a **Draft**, **On Hold** (for any reason) or **Pending payment** cannot be dispatched: nothing is recorded and no stock is taken, and the message tells you what to do next (finalise the draft, release the hold, or record the payment). If the order is **Processing**, dispatching the last shipment moves the order to **Shipped** in the same step, and an "Order shipped from a non-fulfilment status" warning is added to its activity log. The dispatch and the order change are saved together: if the order cannot be moved, the dispatch is not recorded at all.

**A held order does not move.** While an order is **On Hold**, **Confirm allocations** (Create Shipments) is refused, so it can no longer lift the hold by moving the order to Allocated, and its shipments cannot be moved on through Picking or Packed in the app (the message says to release the hold first). A progress report from the warehouse is still recorded, because it describes what has physically happened.

**A return of goods that already shipped does not cancel the rest.** If part of a line has shipped and some of those shipped units come back (a refund that restocks them, or a chargeback), the units still to send stay owed: the remainder can still be packed, dispatched and counted, and the order is not closed as complete. A refund that returned nothing (for example the cancellation of units that never shipped) still reduces what is owed.

**Closing an order gives back its unshipped reservation.** When an order is set to **Shipped**, **Completed** or **Delivered** while its allocation is larger than what shipped (for example after you close it short), the unshipped part of the allocation is released and the stock becomes available again. What a picked or packed shipment still holds is kept. If the release cannot be made the status change still goes through and the allocation is left as it was.

**Despatches reported by the warehouse (Mintsoft).** The goods have already left, so IMS records what it can. If the order is **On Hold** or **Pending payment** and already has shipments, the shipments are marked shipped and stock and cost are booked as normal, but the order itself is left exactly as it is (it is not marked Shipped, the hold is not released, nothing is sent to the storefront), and an administrator gets a "Despatch on an order that is not ready to ship" notice and an activity-log warning. Review the order, release or finalise it, then set it to Shipped if it should be closed. If the order is a **Draft**, or has no shipment yet, IMS does not record the despatch (doing so would finalise the draft or lift the hold): it appears as a stuck despatch under **Sync > Exceptions** for you to decide what to do.

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

#### Reopening a picked or packed shipment

A shipment can only move forward, but a **picking or packed** one can be sent back to a pending draft
with **Reopen for repack**, next to it in the Shipments panel. Use it when a shipment can no longer go
out as packed — most often when a **partial refund lands after packing**, which IMS refuses to
dispatch because it would ship goods the customer has been refunded for.

Reopening:

- turns the shipment back into a **pending draft** and keeps its tracking number and carrier, so a
  label you already bought is not thrown away;
- **re-allocates the order**, which nets the refund into the reservations, releases the refunded
  units' reserved stock, and retires the draft when it no longer matches what the order owes;
- records a **warning in the activity log** — the goods are physically in a box in the warehouse, and
  reopening the record does not unpack them.

Those steps are **all or nothing**: they share one database transaction, so an interrupted recovery
leaves the shipment exactly as it was rather than a draft whose stock has not been re-netted. If the
re-allocation cannot run at all — no warehouse is available for sale, say — the reopen is rolled back
and IMS tells you nothing changed.

There is **one deliberate exception**. If the order carries *another* picking or packed shipment, the
re-allocation is refused (IMS will not re-net an order that still has committed stock elsewhere) and
the reopen is kept. It has to be: with two packed shipments, rolling back would refuse each one
because of the other and neither could ever be reopened. **Reopen the second shipment too** — every
shipment on the order has to be back to a draft before the refunded units' reservation can be
released.

That exception applies **only to a picking or packed sibling**, because only those can be reopened
afterwards. If the order carries a **dispatched** shipment, **Reopen for repack** is not offered at
all, on any shipment on that order — and if you invoke it another way IMS refuses and changes
nothing. Reopening there would turn a shipment that can still go out into a draft that stock could
never be re-allocated to: the re-allocation is refused while any shipment on the order is not a
draft, and a dispatched shipment can never go back to being one. See the warning below.

Once nothing committed is left, the draft shows a **Finish repack recovery** button, which runs the
missing re-netting and releases the refunded units' reservation. It is a different button from
*Reopen for repack* on purpose — nothing is unpacked and no shipment is changed by it.

That button appears **only where there is something to finish and finishing it can work**: the order
still has an unresolved refund-reservation release recorded against it (the durable trace the
recovery leaves behind) **and** no shipment on the order is still committed. It disappears once the
recovery has run. It is also the way to repair an order left part-way through a recovery by an older
version of IMS — **including one whose release has been retrying for so long that IMS gave up on it**
and marked it permanently failed on the Sync Exceptions page. Nothing else will ever retry such a
row, so this button is the only thing that can release that stock; pressing it clears the failed row
along with the reservation. **"Create Shipments" is not a substitute** — it rebuilds the draft from the
already-netted quantity without releasing the stale reservation.

**Do not dispatch the second shipment instead of reopening it.** A dispatched shipment still counts
as committed for this check *and* can never be reopened afterwards, so dispatching it closes the only
door: the order can then no longer complete the recovery by any click, and the outstanding refund
reservation has to be reconciled by hand (it stays visible as a failed `refund.reservation-release`
row in the integration outbox on the Sync Exceptions page). Neither button is shown in that state,
rather than one being shown and doing nothing — and IMS will not let you reopen anything else on that
order either, so an order that is already in that position cannot be made worse by a click.

If a release row has a status this version of IMS does not recognise (typically written by a newer
version before a rollback), IMS cannot finish it and shows no button for it. Dispatch is refused and the
refusal names the unrecognised status. The row is listed under **Integration outbox** on the Sync
Exceptions page, marked as needing an administrator, and counted in its total. It cannot be cleared from
the app: deploy the version that recognises the status, or escalate it to whoever runs IMS deployments.

**Unpack the parcel first, then press "Create Shipments"** in the Stock Allocation panel to rebuild
the shipment to what actually remains. If every unit was refunded there is nothing left to build and
IMS says so rather than creating an empty shipment.

A **dispatched** shipment cannot be reopened — the goods have gone, and the way back is a refund or a
return. A **cancelled** order uses **Discard shipments** above instead.

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
4. Optionally pick a **Return reason** (the dialog shows the field only when return reasons are configured in Settings > Inventory), and type the free-text **Reason**, which stays required
5. Confirm the refund

The return reason is one structured value **per refund** (not per line): it is what the Returns report counts and totals. The free-text reason is kept exactly as before and is a separate field. A refund imported from WooCommerce takes a return reason only if the store's refund reason text matches an active return reason name (ignoring case); otherwise the return reason stays empty and the text is kept as the free-text reason. The refund's return reason shows on the order page under Refunds.

Returned stock is added back into the selected warehouse's inventory automatically.

The refund dialog shows, for each line, the **net**, the **VAT** and the **credit note amount including VAT**, and below them the credit note total. If the order had an **order-level discount**, the dialog adds a separate **Order discount reversed** row: IMS gives back the refunded share of the discount itself (you never enter it), so a full refund of a discounted order credits exactly what was paid. The share is worked out on the server when you confirm; if an earlier refund landed first and the recorded figure differs from the preview, the dialog shows the recorded figure. A refund entered by hand can only contain order lines (and the order's shipping charge), never a discount line of its own.

For Kit / Bundle sales, refunds reverse the component-level stock movements. Returned stock, FIFO cost restoration, and shipment reversal all happen against the underlying component products.

### Returned goods in transit (switched off by default)

Normally the returned units are restocked the moment the refund is recorded. When the setting
`refund_returns_in_transit_enabled` is `true`, a refund that returns stock instead creates a **return expectation**:
the units are not stock yet, so they cannot be allocated, sold or pushed to the storefront, and the refund's COGS
reversal debits **Stock in Transit** instead of Inventory (DR Stock in Transit / CR COGS). The decision is stored on the
refund when it is created, so a retry later does the same thing. When the parcel arrives, restocking its Mintsoft returns
inbox item clears the expectation: the units come back into stock at the refund's own cost, oldest refund first, and Stock
in Transit is released to Inventory (DR Inventory / CR Stock in Transit). Anything the expectations do not cover is
restocked as a plain return, as before. Writing off units that never come back is not built yet, so the setting is
switched on only as a cut-over step. See `docs/refund-in-transit.md`.

### Refunds on a partly shipped order

A refund of units that have not shipped gives their reserved stock back even when other units of the order have already
shipped. Refunded units come out of the **unshipped** part first: the reservation falls by the refunded quantity, never
below what has shipped or what a picked or packed shipment still covers, and shipments, shipped quantity and their cost
records are left alone. Running it again changes nothing. Previously such a release was refused and left the reserved
stock held until someone reconciled it by hand.

A refund of units that never shipped only releases the demand: the stock was never taken out of the warehouse, so there is nothing to put back and no stock is returned for those units. The refund button is available once an order has shipped, or to top up an order that is already partly refunded.

### Refund-time cost revaluation

When a refund processes returned stock, the system uses the **current** cost-layer unit cost — not the snapshot recorded at shipment time. This means if a landed-cost revaluation has changed the unit cost since the original shipment, the refund's COGS reversal uses the up-to-date value. The returned stock is also valued at the current cost.

This keeps the returned-stock balance sheet entry aligned with the live cost layers. Note that the COGS reversal amount may differ from the originally-posted COGS amount by the revaluation delta — this is the expected behaviour for single-snapshot accounting.

### Refunds that return no stock, and returns whose cost is unknown

A refund with **No stock return** (no return warehouse) refunds the customer's money only. The goods are not back, so IMS posts **no COGS reversal** for it: the cost of the shipped units stays in COGS, exactly as for a chargeback, and Inventory is not debited for stock that no cost layer backs. The shipped cost is also left unconsumed, so a later refund that does return those units still has it.

Every unit that is restocked carries a cost layer at the **issued cost** of the shipment it came from, in dispatch order, whether or not that shipment was ever journaled to the accounting system, and whether or not the order is paid or accounting is on. If the issued cost of the shipped units is not on record, a refund you record by hand with a return warehouse is **refused** with *"the cost of the shipped units is not on record"*; refund it as cash-only (no return warehouse) or fix the shipment's cost first. A WooCommerce refund is already issued in the shop, so it cannot be refused: it is recorded without a return warehouse, nothing is restocked, and a warning on the order (*refund_return_parked_unknown_cost*) names the units to restock by hand once the cost is known.

### Refunds without a shipment source

If a sales order line was allocated but never shipped, the refund rejects with a clear message: *"Cannot return refunded stock for product X: no shipped stock source exists"*. The system refuses to silently restock from an allocation-only source — there's no actual stock movement to reverse.

You can still process the refund as cash-only by leaving the return warehouse unset.

### Warehouse-scoped idempotency

The refund return-stock movement is bound by `(refundId, refundLineId, warehouseId)`. This means split returns to different warehouses don't collide — you can return part of an order to Warehouse A and part to Warehouse B in the same refund without idempotency conflicts.

### WooCommerce refund deduplication

Refunds synced from WooCommerce are deduplicated by `externalRefundId`. If a duplicate webhook fires (network retry, race condition), the second delivery is silently absorbed without creating a duplicate refund. A WooCommerce refund that a person made to pay an IMS refund (see below) has a new id, so it is matched by order, currency and amount instead of being imported as a second refund.

### A refund you record in IMS on a WooCommerce order: Refund in WooCommerce

When you record a refund in IMS on an order that came from WooCommerce, IMS books its own credit note and **writes nothing to WooCommerce**: no refund record, no order status change, no order note and no money movement. The customer is paid back by a person, in WooCommerce.

- IMS raises **one operator task per refund**, **Refund in WooCommerce**, on **Sync > Exceptions**. It gives the tax-inclusive amount to refund (or the net, and says so, if IMS could not work out the tax), the currency and the IMS credit note number. It holds no personal data, and the free-text reason you typed stays on the IMS refund and is not copied into the task. The task is also counted in the Exceptions banner.
- The sales order shows a **Refund to make in WooCommerce** badge while the task is open.
- Make the refund in WooCommerce for **that amount**. IMS writes no marker to WooCommerce, so when it imports that refund it **cannot tell it from a separate refund** that began in WooCommerce with the same amount. It therefore never links it on its own: the WooCommerce refund is **parked** under parked refunds on Sync > Exceptions, with the figures, and no credit note is raised yet. On that row you choose: **Confirm this WooCommerce refund settles IMS refund (credit note)**, which links the two, marks the task and the row done and raises **no second credit note**; or **Record manually** if it is a separate refund, which raises a credit note for it as for any WooCommerce refund and leaves the IMS refund owed. Confirming needs the same permission and fresh sign-in as recording a refund by hand, and is recorded in the activity log.
- **Press Done only if no refund is to be made in WooCommerce.** Done needs the sync permission and a fresh sign-in, and records who and when. Once a task is done, IMS can no longer link a later WooCommerce refund to that credit note.
- **If the amount differs from every open IMS refund,** no Confirm button is offered: look at the refund in WooCommerce and, if it is a separate refund, use Record manually on that row. If it was meant to pay an IMS refund for a different amount, check the credit note and the refund first; recording it would credit the same money twice. If several IMS refunds have the same amount, each has its own Confirm button, so you name the one it settles.
- A refund that **began in WooCommerce** is imported as it always was. A full or partial refund in IMS never changes the WooCommerce order status.

### Exchanges inside a return (switched off by default)

A customer swapping an item no longer needs a refund plus a brand new order. With **Exchanges inside a return** switched on (**Settings > Sales**; the `return_exchange_enabled` setting, off by default), the refund dialog has a **Replace the returned items (exchange)** section. You choose the replacement products, the quantity and the price (it starts at the product's list price in the order's currency and price basis; overwrite it). The dialog prices the replacement as the order would (VAT per line) and shows the **credit note** total, the **replacement** total and the difference.

**What it records.** The return side is exactly the refund of today: refund lines, stock back, cost reversal and the credit note. The replacement items are added as **new lines on the same order**, each marked on the order page as *Replaces <credit note number>*, and from there they are ordinary lines: stock is reserved for them (the returned units' reservation is given back in the same step), they are picked and shipped by the normal flow, and the order's posted accounting invoice is updated through the usual queued update (while the outbound write hold is on, the update is recorded as held and nothing is sent). The order's total goes up by the replacement, and the credit note comes off, so the customer's balance nets off. The Refunds section shows a recap of what was returned and what replaced it.

**Money: nothing moves by itself.** An even exchange moves no customer money in IMS. If the replacement is worth more or less than the credit note, the dialog (and the result) says **Customer owes X** or **Refund X**. IMS does not charge or refund that difference: record the payment with **Add payment** when it arrives, or pay the difference out with the existing refund actions. A replacement worth nothing against a return of the whole order is refused: the order would end up fully refunded and hold no demand, so the replacement could not ship. An order whose payment is only recorded as a paid flag (no payment rows) is still held as paid for the larger total, so the difference is yours to settle by hand.

**Where it is allowed.** Only where IMS can still add lines: the same rules as editing a confirmed order. The exchange section is not offered (and the dialog says why) when the order is a draft, cancelled, closed or erased, **has been dispatched** (the warehouse can no longer amend a dispatched order: record the return as a refund and raise a new order for the replacement), is fully refunded already, has a shipment that is picked or packed, has an invoice that is queued but not posted yet, a fee line from the shop, or an order the warehouse is already picking; or when the daily accounting batch has already booked the order's revenue or allocated inventory ahead of dispatch. For an order already sent to the warehouse, IMS first asks the warehouse whether its order is still open for changes; if it is not, or cannot be read, nothing is recorded (*AMENDMENT_NOT_APPLIED*). Recording an exchange needs the permissions to refund, to edit orders and to process (allocate) them. Earlier refunds on the order do not block it.

**An order that came from WooCommerce.** IMS does not add lines in WooCommerce: the replacement exists only in IMS. The dialog shows the same warning as editing the order (WooCommerce keeps the original, so the two no longer match) and you must tick it; without the confirmation nothing is recorded. The order is marked *edited in IMS*, and the WooCommerce lines as they were are kept so a later WooCommerce change is still reported. As for any refund you record in IMS on a shop order, a **Refund in WooCommerce** task is raised for the credit note.

**Deleting.** A refund that came with an exchange cannot be deleted here (its replacement lines are reserved, shipped or invoiced on the strength of it); correct it with a new entry instead. The returns analytics show exchanges apart (see *Analytics & Reports*).

### Deleting a refund recorded in error

A refund an operator recorded in IMS by mistake can be deleted, and the delete undoes exactly what that refund did. **It is off by default**: an administrator switches it on with the `refund_delete_enabled` setting (the value `true`). While it is off the order page shows no delete control.

**Where.** On the order page, open **Refunds**. Each refund shows **Delete refund** when it can be deleted, or a line beginning *Cannot be deleted* with the reason when it cannot. The action needs the same permission as recording a refund (`sales.refund`). A confirmation asks for an optional reason, which is kept in the audit record.

**What it undoes, from the record of what the refund did (it never recalculates a cost):**

- **Returned stock** goes back out: the refund's return movement and the cost layers that return created are removed and the stock level goes down by exactly the recorded quantity.
- **The cost-of-sales (COGS) reversal** is reversed at the amount it carried. A reversal not yet sent to the accounting system is cancelled; one already posted is countered with a journal that swaps its debit and credit lines. The COGS sub-ledger gets the exact opposite movement, so it nets back to what it was before the refund. Because the delete reverses the amounts the refund actually posted, the result does not depend on how refund COGS reversal is valued (the open finance decision on refund cost basis).
- **The credit note**: one never sent is cancelled and everything is undone at once. One already in the accounting system makes the delete **two steps**: confirming it only queues the *Credit note void* (see Xero sync) and changes nothing else, so the refund and its stock stay exactly as they were. Only when the accounting system confirms the void does IMS unwind the refund. If the accounting system refuses (for example the credit note was allocated or paid there), the refund stays as it is and the entry fails on the sync page with the reason. Nothing is sent when the delete is confirmed, and nothing leaves at all while outbound writes are held.
- **The owed-posting record of an adopting refund** (see *A refund adopts a return the warehouse already restocked*) is closed, so nobody posts a reclass for a refund that no longer exists. The adoption is released, so those units become available to adopt again.
- **A "Refund in WooCommerce" task** raised for the refund (on an order that came from WooCommerce) is marked done, so nobody is told to pay the customer back for a refund that no longer exists.
- **Stock reservation**: the order is re-reserved for its remaining demand after the delete (best effort; if a shipment exists or stock is short, a warning says to allocate it from the order page).
- **The order's refund status** is recalculated from the refunds that remain. Refund analytics and the Returns report no longer include the refund.

A warehouse query the refund raised for an order already pushed to the warehouse is **not** withdrawn (IMS writes nothing to the warehouse): raise a follow-up query there if the warehouse acted on it.

The delete is a **soft delete**: the refund is marked deleted and hidden everywhere (the order's refund list, refund totals and status, analytics, accounting checks), but its record is kept for audit. Its lines are removed from the refund and copied into the record of the deletion (with their descriptions), so they no longer count against the order's refundable quantities. A record of the deletion (who, when, why, the credit note number and what was reversed) is kept as well, and the order's activity log shows *refund_deleted*. A deleted refund cannot be deleted, retried or paid again, and the credit-note cascade to the accounting system is unchanged.

**When it is refused** (always with the reason in plain words, and nothing is changed):

- The refund **came from WooCommerce** (it would be imported again) or was raised automatically, for example from a payment reversal. Delete or correct those in WooCommerce.
- The credit note has **payments or allocations** recorded against it.
- The credit note's date is **on or before the accounting lock date** IMS last read from Xero.
- The stock the refund returned has **since been used, reserved or moved**, or the return predates IMS recording which cost layers it created.
- The order carries **store credit**, or has been **erased**.
- The refund's accounting is **being sent right now**, **still needs a retry**, or IMS **cannot prove** whether a queued entry reached the accounting system.
- The refund routed goods **in transit**, or also moved unearned revenue, allocated inventory or a daily-batch adjustment, which a delete cannot unwind exactly. Correct those with a new entry.
- The delete setting is off.

The delete is idempotent: pressing it twice, or retrying after an interruption, reports success and does nothing a second time. If the accounting system cannot void the credit note (for example it was allocated there since), the queued entry fails with the reason and can be retried from the sync page after the allocation is removed in Xero.

## Payments

You can record payments against a sales order:

- **Add a payment** with the amount, date, method, and reference
- **Delete a payment** if it was recorded in error

Payment records help you track outstanding balances on each order.

- **Several payments on one invoice.** You can record a deposit and then a balance, or any number of part payments. Each receipt is registered in the accounting system on its own, so a payment you record by hand on an order that is already paid by a WooCommerce receipt is registered normally. Only a repeat of the same receipt is refused.
- **A payment above what is outstanding is refused**, as the accounting system would refuse it too.
- **Paid WooCommerce orders** arrive with their payment already recorded.
- **Receipts on a cancelled order.** You can record a payment against a cancelled order. If it is dated **after** the cancellation it is **held**: it stays recorded here, nothing is sent to the accounting system, and a warning says so, because the accounting system would treat that money as an overpayment, which IMS does not create. Record it there by hand. A payment dated at or before the cancellation registers as normal.

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

#### When the registration was tried and failed

A registration that was **attempted and recorded as failed, with no payment reference**, also
refuses the deletion — and it refuses differently, because there is no document id for One Two
Inventory to look up on its own.

A failure does not mean nothing was posted. The accounting system is called *before* the result is
written down, so a timeout, a dropped response or a worker that died mid-call is recorded as a
failure even when the payment went through. One Two Inventory cannot tell the two apart on its own:
the entry names no payment to look up, and an invoice showing no payment looks identical whether the
payment was removed or never arrived.

You resolve it, in this order:

1. Open the invoice in the accounting system and look at its payments.
2. **If a payment is there**, the attempt landed. Reverse (delete) it there, then copy its **payment
   reference** into the box on the refusal and use **"Check that payment and delete"**. You are only
   telling One Two Inventory *which payment to ask about* — it then asks the accounting system and
   requires all five of these before anything is removed here: the payment is on **this order's
   invoice**; that invoice is in **the same currency as this receipt** — otherwise the figures on
   either side are not the same money and cannot be compared at all; it is for **exactly this
   receipt's amount** (to the penny — a near-miss is refused, not rounded); it really is **gone**; and
   **no other payment for that same amount is still standing on that invoice**. A mistyped reference,
   a payment belonging to another invoice, an invoice raised in another currency, or a payment that is
   still standing is refused by name, and you can correct it and try again.

   The currency one only ever fires when something is already wrong: a receipt recorded in one
   currency against an invoice raised in another. One Two Inventory will not convert between them
   here — a converted figure is an estimate, and this check exists to avoid deleting a receipt on an
   approximation. Correct whichever of the two records is wrong, then reverse it.

   The last of the five is the one that surprises people, so it is worth saying plainly: if the
   invoice still shows a payment for this receipt's amount, the check is refused even when the
   payment you named really is deleted. An amount cannot tell two payments apart, and the case being
   guarded against is the expensive one — the receipt's *own* payment still sitting on the invoice
   while a different, identically valued deleted payment is named in its place. Either the payment
   still on the invoice is this receipt's, in which case reverse **that** one and name it here, or it
   belongs to another receipt on the order, in which case resolve this receipt's failed entry under
   **Sync → Xero** instead. When it passes, the failed entry is retired with that reference
   written onto it, so the order's history stops saying "outcome unknown" and starts saying which
   payment existed and was undone — noted as identified by you and confirmed with the ledger.
3. **If there is no payment**, retry the entry under **Sync → Xero**. When it posts, One Two
   Inventory records the payment reference itself, and from then on the receipt falls under the
   ordinary refusal above, which *can* check the reversal for you.

If the order has no accounting invoice recorded, or more than one attempt failed without a
reference, the check is refused instead: there is nothing to attribute the payment to in the first
case, and no way to tell which attempt a single reference belongs to in the second.

### "LEDGER OUTCOME UNKNOWN"

An order (or a supplier bill) that is **not** marked paid here but carries one of these failed,
reference-less attempts shows a red **LEDGER OUTCOME UNKNOWN** badge rather than reading as an
ordinary unpaid document. It is not the same as "the ledger rejected it" and not the same as
"nothing was sent": a payment may be sitting on the invoice in your accounting system with nothing
here to match it. Check the invoice there before recording or registering another payment against
it.

## Invoices the accounting system will not take

Two cases are refused instead of posting wrongly. Both show as a failed entry under **Sync > Xero**, with a message that names the cause, and nothing is sent to the accounting system:

- **A line with no tax type.** A sales invoice or credit note line that has no tax type is refused rather than posted as "No VAT". Fix the product's or line's tax rate and retry. (The one allowed exception is a WooCommerce fee the shop charged no tax on.)
- **A WooCommerce order that used a tax rate IMS does not map, or maps to an inactive rate.** The invoice is refused and no payment is registered. Map the WooCommerce tax rate (see [WooCommerce](woocommerce.md)), then re-import the order.

## Invoice Generation

Invoices can be generated either manually or automatically. The trigger for automatic invoice generation is configurable in **Settings > Sales Settings**. Options include:

- **Manual** — you generate the invoice yourself when ready
- **On ship** — invoice is created automatically when the order is shipped
- **On paid** — invoice is created automatically when payment is received in full

### Deleting an invoice that has synced to Xero

When the setting **Allow deleting synced invoices and bills** is on (**Integrations → Xero**; it is off by default), an invoice that IMS itself created in Xero shows a **Delete invoice** button on the order page for people who can process sales. It renames the Xero invoice with a random `-DEL-` suffix so the original number is free, then deletes (draft or submitted) or voids (authorised, unpaid) it, and clears the invoice number and link from the order when Xero confirms. If the invoice has payments, refunds or credit notes, is dated in a locked period, was created by another system or is already being deleted, the page shows the reason instead. See [Xero sync](xero-sync.md) for the full rules.

### Editing an order

**A Draft order can be edited.** Open the order and press **Edit order**: the same form you used to create it opens pre-filled, and you can change the customer, addresses, lines, quantities, prices, discounts, shipping, VAT basis, warehouse, delivery date and notes. **Save changes** re-prices the whole order exactly as creating it would (the same rounding, VAT and exchange-rate rules; a foreign-currency order is re-priced at today's table rate and refused if that rate is missing), replaces the lines, and keeps the order number, the status (still Draft) and the activity history, which records the edit with the old and new totals. An order that was saved with separate fee rows shows their sum as part of **Shipping** when you edit it. The order's external order number is not editable.

**A confirmed order can be edited too, after a warning.** From **Pending Payment** up to (but not including) dispatch, **Edit order** opens the same form. **Save changes** does, in one step: it gives the order's reserved stock back, replaces the lines, re-prices the order exactly as creating it would (the same rounding, VAT and exchange-rate rules; the order keeps its currency and the exchange rate it was booked at, it is not re-priced at today's rate), reserves the stock again for the new lines (an order that had stock reserved is ALLOCATED again; a short line is backordered and the form tells you), queues an update of the order's accounting invoice if one has been posted, and records the edit in the activity log (the entry named "Edited confirmed sales order" is the audit record: who, the old and new total and line count). If the order was already sent to the warehouse, IMS first asks the warehouse whether its order is still open for changes (still new there): if it is, the next warehouse sync amends the warehouse order with the new lines; if the warehouse has already started on it, or IMS cannot read the warehouse just now, the edit is refused ("AMENDMENT_NOT_APPLIED ... nothing was changed") rather than saved and left unmatched with what the warehouse will pick. The same check applies to **Edit addresses & notes** on an order that has not been dispatched. IMS never writes a comment on the warehouse order. If the posted accounting invoice cannot be updated (it belongs to another accounting connector than the active one, or the connector cannot update invoices) the edit is refused as well. A line you keep keeps its WooCommerce line link, so a later refund of it in WooCommerce is still matched; a later WooCommerce refund of a line you removed is not recorded automatically but held for you on Sync > Exceptions (the money has already gone back in the shop, so record it by hand). Nothing is sent to the accounting system or the warehouse while the outbound write hold is on: the update is recorded as held, exactly like every other posting.

**An order that came from WooCommerce asks you to confirm first.** Press **Save changes** on such an order and IMS shows a warning: the edit will not change the order in WooCommerce, WooCommerce keeps the original, and the two will no longer match. Choose **Edit anyway** to continue or **Go back** to cancel. IMS refuses the edit on the server if the confirmation was not given. A manual order has no WooCommerce copy and is saved without the question.

**What WooCommerce does to an order you edited here.** Normally an order update from WooCommerce writes its addresses, notes and shipping label back onto the IMS order. Once you have edited an order here (after the warning above), IMS marks it **edited in IMS** and WooCommerce's copy of those fields no longer overwrites your edit, so a corrected delivery address is not put back to the original by the next WooCommerce update. The order number, the VAT number and the paid state still follow WooCommerce, and IMS no longer reports the difference your edit made as "edited in WooCommerce after import" (see *WooCommerce*). The mark is permanent for that order; if you want the order to follow WooCommerce again, change it in WooCommerce and create a fresh order here.

**After dispatch only addresses and notes can be edited.** Once any shipment has left (the order is Shipped, Completed, or partly shipped), **Edit order** becomes **Edit addresses & notes**: change the billing and shipping addresses and the customer and private notes. Lines, prices and totals cannot change; to change what was sent use **Refund** (or add a line to a new order). To swap an item before dispatch, an exchange can be recorded with the return (see *Exchanges inside a return*). The same WooCommerce warning applies to an order that came from the shop. A **Delivered** (closed), **Cancelled** or personal-data-erased order cannot be edited at all.

**Edit order is disabled, with the reason shown when you hover it, when** the order is cancelled, delivered or erased, or when something an edit would orphan exists: refunds or return expectations against its lines, a shipment that is already picked or packed (use **Reopen for repack**, or cancel the order), an invoice that is queued for the accounting system but not yet posted (try again shortly: the edit would have to change a document that has not been sent), an order the warehouse is already picking, or a fee line from the shop (duty, handling) that the order form cannot represent. A confirmed order that has a payment or store credit recorded (or is marked paid) can still be edited, but only if the new total and currency are exactly the old ones (swap an item for one of the same price, correct an address); a change that moves the total is refused and nothing is written. A **Draft** is still disabled once it has stock allocated, a shipment, a posted accounting invoice, a warehouse push, a payment, store credit, an invoice number or document, an accounting entry, a refund or return expectation. The server applies the same rule and refuses the edit if anything changed since the page was drawn; if someone else saved the order after you opened the form, your save is refused with a "changed by someone else, reload" message instead of overwriting their change. If the stock for the new lines cannot be reserved, or the new total would no longer match the posted invoice, the whole edit is refused and the order is exactly as it was.

### Orders that already have an accounting invoice

A sales order that already has an external accounting invoice (Xero) and is changed by a path that re-queues its invoice (for example an edit of the confirmed order, a status change or a WooCommerce update) queues a
`SALES_INVOICE_UPDATE` to push the changes through, instead of silently dropping them. The update
payload is constructed by the same builder used for the original push, so what Xero sees matches a
fresh post would have sent. A payload-derived idempotency key prevents duplicates if you re-save
without any content change. (This is not an operator Edit: see **Editing an order** above.)

If the accounting connector rejects the update (e.g. the external invoice is locked, paid, or
voided), an amber **rejected sync** alert appears at the top of the sales order detail page with
the connector, timestamp, retry count, and a safely truncated error message. Operators correct the
underlying issue and retry the failed sync from the Sync Dashboard; once the row transitions out of
`FAILED`, the alert disappears.


## Multi-Currency and FX

Sales orders can be in any configured currency. The system handles the conversion to your base currency for reporting and accounting.

### How the FX rate is locked

When you create an order:

- The current stored exchange rate is fetched from the FX rate table (Settings > Accounting > FX Rates). **There is no rate to type**: the form shows it read-only, and a rate sent any other way is ignored. The rate is read when you choose the currency and shown with its source and date, and the lines already on the order are re-priced to the new currency at that rate (through the base currency). A currency with no stored rate cannot be used: the form shows "No exchange rate for <currency> yet: rates come from the store (Aelia)", the base-currency figures show a dash, the lines are left as they were, and **Save as Draft** and **Create Order** stay disabled until the rate exists. The server also refuses it, and an order is never booked 1:1. An admin who needs a different rate pins a manual override on the FX Rates page.
- The rate is stamped on the order as `fxRateToBase`.
- **CSV import:** `fxRateToBase` is optional. Leave it blank. A value that is not exactly the table rate is refused for that order (`FX_RATE_NOT_TABLE_RATE`), a zero, negative or unreadable value is `FX_RATE_INVALID` (never read as 1), and a currency with no rate is `FX_RATE_MISSING`.
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

## Customers

**Sales > Customers** lists every customer. Search by name, company or email, add a customer with **New Customer**, or use the CSV buttons to export, download a template and import.

- **Columns.** The list opens with Name, Company, Email, Tax Number, Billing Address, Orders, Lifetime Value and the current year's sales. The column picker (the settings icon beside the search box) also offers Phone, Shipping Address, Last Order, Status, Created and Notes. Your choice is remembered in your browser. If you saved a choice earlier, any column it does not mention keeps its default, so an older or partial saved choice never hides the rest.
- **Row actions.** Edit a customer, make one inactive or active again, or use **GDPR Anonymise** (see [Erasure](erasure.md)). Inactive customers are shown faded.
- **Customer page.** Open a customer to see their contact details, their turnover in your base currency and a list of their orders. An order that has been refunded shows a **Part. Refunded** or **Refunded** badge beside its stage.

## Documents

Three PDF documents are available for each sales order (a quote has its own, the **Quote PDF**, see [Quotations](#quotations)):

- **Sales Order PDF** — a summary of the order for internal use or to send to the customer
- **Invoice PDF** — the formal tax invoice, generated manually or automatically
- **Packing Slip** — a picking/packing checklist showing SKU, product name, location, quantity, and a tick box for each item. Available from the order's ⋮ menu for every order that is not a Draft or Cancelled, and from a **Packing slip** button on each shipment card (from Pending onwards, so it can be printed to pick from). The shipment button prints only that parcel. When an order has multiple shipments from different warehouses, items are grouped by shipment with a section heading per warehouse. If shipments have not yet been created, the packing slip falls back to the sales order lines.

PDFs use your company branding (logo, colours, and footer) as configured in Settings.

## Attachments

Every sales order page has an **Attachments** card under the order, for documents that belong to it: a customer's purchase order, an email thread, a proof of delivery or a photo of damage.

- **Upload** -- Anyone who can create or process sales orders (administrators, managers and warehouse users) sees an **Upload** button. Accepted: PDF, images (PNG, JPEG, GIF, WebP), CSV, Excel (.xlsx), Word (.docx) and email (.eml, .msg), up to **20 MB** each. IMS checks the content of the file, not just its name, and refuses a file that is not what its name says.
- **Download** -- Anyone who can view sales orders sees the list and a **Download** button. A file always downloads; it is never opened in the browser.
- **Delete** -- The **Delete** button asks you to confirm. A deleted attachment disappears from the list and cannot be downloaded; the file is kept on the server and the row is only marked deleted.
- **They can hold personal data.** A customer's purchase order or an email can carry a name, address or phone number. When a customer is erased (**GDPR Anonymise**, or WooCommerce anonymising an order that IMS mirrors) every attachment of their orders is **deleted for good**, deleted ones included, together with its file. An anonymised order takes no new attachment. Attachments do not go to WooCommerce, Mintsoft or Xero. See [Personal-data erasure](erasure.md).
- Deleting a draft order deletes its attachments too.
- **Backups:** the files are in the server's upload folder (`UPLOAD_STORAGE_DIR`, under `order-attachments`), not in the database; a database backup does not contain them. After a restore, an attachment whose file was not restored shows in the list but fails to download. See [Backup & Restore](backup-restore.md).

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
- an **accounting document for it is queued, in flight, failed, already posted — or may have been** — a `PENDING`/`PROCESSING`/`SYNCED`/`FAILED` sync log for the order or one of its shipments, or a cancelled one that is not proven to have been retired before anything was sent (a cancellation, or an operator's "did not post", does not prove that);
- it is included in a **daily accounting batch** that is queued or posted — the A1 revenue deferral or the A2 inventory allocation. Those journals are keyed by batch date, not by order, so they cannot be un-posted from the order screen; finance has to reverse the batch entry.

**The right remedy depends on the blocker — cancelling is NOT always correct.** The refusal message says which case you are in:

| Blocker | What to do |
| --- | --- |
| Queued document (`PENDING`, no external id) | **Cancel** the order. Cancelling retires the still-queued invoice before it posts and propagates a cancellation to the WMS. |
| In-flight document (`PROCESSING`) | **Wait** for it to settle, then delete or reverse depending on the outcome. A freshly claimed row is deliberately not retired by cancelling, because the remote call may already be on its way. |
| Posted document (`SYNCED`, or any row carrying an external id) | **Finance-led reversal or credit note** in the accounting system. Cancelling the order does *not* reverse a posted invoice — it would leave a live receivable and recognised revenue against a cancelled order. |
| Failed document (`FAILED`) | **Check the connector first.** A failed sync does not prove nothing was posted: the remote call happens before the result is written back, so the document may exist. Resolve the sync log once you know which it was. |
| Retired document that is **not proven never-sent** (cancelled with no recorded proof, or settled by an operator as "did not post") | **Check the accounting system, and cancel the order instead of deleting it.** A cancellation, and an operator's "did not post", are not proof that nothing was posted — the message says the document is *unproven*. Only a row retired before any request was made (recorded when it was retired) or a payment IMS verified gone lets the order be deleted. |
| Daily batch | It is keyed by batch date, not by order, so it cannot be un-posted from the order screen. **If the ledger confirmed the batch journal, finance reverses the batch entry.** If the batch row is queued, or its standing is unproven or only an operator's claim, **check the accounting system for that journal and reverse it only if it exists there** (if it does not exist there is nothing to reverse). |
| WMS push link | **Cancel** the order, which withdraws the WMS order. |

Deleting in any of these cases would strand the external document with nothing in IMS referencing it. Drafts, which never queue an accounting invoice, stay freely deletable.

**On the order screen, Delete is greyed out once the refusal is predictable.** The order page knows about the accounting leg, so it disables the button and puts the reason (and the remedy) in its tooltip rather than letting you press it and read a refusal: "an accounting invoice is queued — cancel the order instead" while the invoice is only queued, and "finance has to raise a credit note or reversal" once one has actually been posted. The button stays visible, greyed, so the action is still discoverable. The other blockers in the list — the WMS push link, a daily batch, refunds and payments — are only known to the server, so those still come back as a refusal message when you press Delete.

The check, the allocation release and the delete all run under a single lock on the order row, and the posting workers claim their work under that same lock before making a remote call — so no worker can start posting an order in the window between the check and the delete.

### A refund adopts a return the warehouse already restocked

With **returns in transit** switched on, a refund normally books its returned goods as *Stock in Transit* until they arrive. If the warehouse has **already restocked** that return (a Returns inbox arrival marked Restocked for the same order and product), the refund **adopts** it instead: it links to the arrival and creates no return expectation, no second stock-in and no transit entry for those units, so the goods are counted once. The order's activity log shows *refund_adopted_returns_inbox*. Adoption happens only when every returned product on the refund is fully covered by restocked arrivals that nothing else has claimed: units a return expectation already received, units an earlier refund restocked itself and units an earlier refund adopted (counted per arrival and quantity, so a partly used arrival offers only what is left) are not available. The quantity a refund needs is the quantity it would actually return: units that never shipped, and shipped units whose issued cost is unknown, are not counted. A partly covered refund behaves as before. Two refunds recorded at the same moment cannot both adopt one arrival.

**Accounting.** IMS posts **no journal** for an adopting refund. The warehouse's restock may already have booked *Dr Inventory / Cr the stock-gain reason account*, and the refund books no COGS reversal of its own, so the margin needs a manual reclass. The refund raises **one owed-posting record** (exception inbox, *refund_adoption_reclass_journal*) naming the refund, the inbox rows and the quantities adopted, and the original shipped cost IMS can compute. Where the restock journalled a row that the refund adopted whole, post *Dr the restock's reason account / Cr COGS* at the original shipped cost. A row adopted only in part, or a mix of journalled and unjournalled rows, is marked **ADVISORY**: IMS cannot tell which units were journalled, so check the ledger first. Where IMS found no restock journal, the restock's own owed record carries the Inventory debit. **Never post Dr Inventory for this record.** Deleting the refund closes the record.

### Asserting a retired payment registration never existed (administrators)

A receipt whose payment registration was retired without a record that it was never sent cannot be deleted: IMS cannot tell whether a payment reached the accounting system. If you have checked the invoice there and no payment was ever registered, an **administrator** can use **Record that it never existed** under the refusal on the receipt, giving a reason (at least 10 characters). IMS records an audit entry with who, when and why, and the receipt can then be deleted. IMS does not check the accounting system: this is an administrator's word, and applies only to that retired entry (never to one carrying a payment reference).
