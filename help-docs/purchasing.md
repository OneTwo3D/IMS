# Purchasing

The Purchasing section manages your purchase orders, supplier relationships, and stock receipts.


## Purchase Order List

The main purchasing page shows all purchase orders in a searchable table.

- **Search** -- Find POs by number, supplier name, or reference.
- **Filter by Status** -- Narrow the list to a specific status.
- **Export** -- Download the list as a CSV file (the CSV bar on the page also imports purchase orders from CSV).


## Creating a Purchase Order

1. Click **New Purchase Order**.
2. Select a **supplier** from your supplier list.
3. Confirm the **currency** (defaults to the supplier's currency).
4. The **FX rate to base currency** is shown read-only: it is the rate in Settings > Accounting > FX Rates for the order's currency, read when the order is saved. It cannot be typed here (see [FX rate](#fx-rate) below).
5. Select the **destination warehouse** where the goods will be received.
6. Add lines by searching for products. The system pre-fills the last purchase price for that supplier if one exists.
7. Enter quantities and adjust prices as needed.
8. (Optional) Tick **"Skip preferred-supplier update"** on the PO header if you don't want this PO to overwrite the products' preferred suppliers — useful for emergency or one-off orders. See [Preferred supplier auto-update](#preferred-supplier-auto-update) below.
9. Save the PO.

### FX rate

**One rate means the table rate.** A foreign-currency PO is always raised at the exchange rate held in Settings > Accounting > FX Rates (the `fx_rates` table) for its currency: the latest rate on or before the moment the PO is saved. There is no rate field to type, no override band and no warning: the number the PO form shows is the rate the PO is stored at. A currency with no stored rate cannot be used; the PO is refused with "Missing ... FX rate".

- **A different rate for a deliberate reason** (a forward contract, a supplier-specific rate): an admin pins a **manual override** on Settings > Accounting > FX Rates (the pencil icon). The override is a new row in the table and is the latest rate, so every PO saved after it uses it, and the daily fetch skips that currency until the override is cleared. It applies to all POs in that currency, not to one.
- **Existing POs keep the rate they were stored with.** A stored rate is never rewritten when the table changes.
- **CSV import:** the `fxRateToBase` column is optional. Leave it blank; a rate that is not exactly the table rate is refused for that order (`FX_RATE_NOT_TABLE_RATE`; zero, negative or unreadable is `FX_RATE_INVALID`, no rate for the currency is `FX_RATE_MISSING`), so a typo cannot misprice the cost layers.
- **Freight POs** take the table rate too: the rate shown on the freight form is read-only.

### Editing currency or FX rate on a DRAFT PO

A DRAFT PO keeps its stored rate when it is edited. The rate is read again from the table, at the moment of the edit, only when the **currency changes** (or a refresh is requested). Changing **only** the currency (without touching lines or additional costs) triggers
a **stored base-amount rebase**: the persisted base values on the PO header, every line, and every
freight cost line are recomputed against the new FX rate and written in a single database
transaction. If anything in that transaction fails (e.g. a tax-resolution error), the entire
rebase rolls back so the PO stays internally consistent — line bases never drift away from the
parent header bases. Foreign-currency values are preserved exactly.

When the same edit also includes line or additional-cost changes, the standard recalculation path
runs instead (the rebase helper is skipped). This is the only path where the FX rate change
recalculates everything end-to-end including VAT.

## Purchase Order Statuses

Purchase orders use the canonical purchase workflow documented in `docs/workflows.md`. User-facing statuses include:

| Status | Meaning |
|---|---|
| **Draft** | The PO has been created but not yet sent. Everything can still be edited. |
| **RFQ Sent** | A request for quotation has been sent to the supplier. |
| **Quote Received** | A supplier quote has been received and can be converted to a purchase order. |
| **PO Sent** | The purchase order has been confirmed and sent to the supplier. |
| **Shipped** | The supplier has shipped the goods. |
| **Partially Received** | Some lines have been received but the PO is not yet complete. |
| **Received** | Every line has landed in stock. A line counts as **landed** when its goods have arrived by any route: a manual receipt, a warehouse (WMS) book-in, or a warehouse stock-sync alignment that raised stock without a receipt on the line. An order the warehouse accounted for entirely therefore becomes Received without a manual receipt. |
| **Invoiced** | A supplier invoice has been recorded for the PO. |
| **Partially Returned** | Some received goods have been returned to the supplier. |
| **Returned** | Received goods have been fully returned to the supplier. |
| **Closed** | The PO is finished. If it is marked **Closed short**, part of it was never delivered: the unreceived balance was dropped and the goods that did arrive stay in stock. |
| **Cancelled** | The PO was cancelled before anything was received. |


## Editing a Purchase Order

An order can be edited from **Draft** through **Partially Received**: click **Edit** on the PO page. What you can change depends on whether anything has touched the order yet.

**Nothing has touched it yet** (no goods received, no supplier bill, no return and no warehouse ASN, at any status from Draft to Shipped). The whole order is open: supplier, currency, lines, prices, quantities, VAT, freight and other cost lines, the destination warehouse and the notes. This is how you enter the quoted prices at **Quote Received**, or correct a quantity, price or warehouse after the PO has been sent.

**Goods, a bill or a warehouse ASN have touched it.** The order is amended in place:

| What | Rule |
|---|---|
| Notes, supplier reference, expected delivery | Always editable. |
| Destination warehouse | Editable unless a warehouse ASN is open (book it in or retire it first). |
| Supplier, currency, exchange rate, VAT rate | Fixed. Receipts, bills and ASNs were costed and posted in them. To change them, return or close the order and raise a new one. |
| A line that has been received, billed or returned | Keeps its price, discount and VAT, and cannot be removed. Its quantity cannot go below what was received, billed or returned. |
| Quantity on any other line | Editable (an increase is always allowed). To drop the quantity still due on a part-received line, set it to the quantity received. |
| A line with an open warehouse ASN | Its quantity cannot be reduced and it cannot be removed until the ASN is booked in or retired. |
| Adding or removing an untouched line | Allowed. |
| Freight and other cost lines | Fixed once goods are in stock or a bill exists. |
| Quantities, prices or lines on a part-received order that has freight or cost lines | Refused. Freight is spread over all lines, so changing them would change the cost of goods already in stock. Close the unreceived balance and raise a new order for any extra goods. |
| An edit that leaves nothing outstanding | Refused: use **Close** to drop the whole unreceived balance. |

A price correction on goods already received is a supplier bill or credit note matter, not a PO edit. An order that is **Received**, **Closed**, **Cancelled** or **Returned** cannot be edited.


## PDF Documents

### RFQ PDF

Generate a request for quotation PDF to send to the supplier. The RFQ includes product details and barcodes/EANs but **does not include prices**, so the supplier can quote against it.

### PO PDF

Generate a purchase order PDF to send to the supplier. The PO PDF includes product details, barcodes/EANs, **and prices**.


## Receiving a Purchase Order

When goods arrive, open the PO and click **Receive Goods**. You can receive all lines at once or partially receive individual lines. You cannot receive more than the line's ordered quantity less what has already landed (including anything the warehouse has booked in or aligned).

**Lines with an open warehouse ASN are booked in through the ASN, not by hand.** If a line's Mintsoft (warehouse) ASN is still open, partly booked in, or being created, **Receive Goods** refuses that line and names the SKU and the ASN. Use **Recheck booked-in** on the order once the warehouse has booked the goods, so the stock is added once. Other lines of the same order, and lines whose ASN is fully booked in or closed, can still be received here.

When stock is received:

- A **FIFO cost layer** is created for each line, recording the quantity and unit cost.
- **Stock levels** at the destination warehouse are updated immediately.
- The PO status moves to **Partially Received** or **Received** accordingly.

The unit cost is validated as finite and non-negative before stock movements are written. A landed-cost recalculation that produces a NaN or infinite cost is rejected at the receipt boundary, before any stock or cost layer is created.


## Closing and Cancelling a Purchase Order

**Close PO** and **Cancel PO** are available at every stage from RFQ Sent to Partially Received (a Draft can only be cancelled; a fully **Received** or **Invoiced** order can only be closed; an order in **Partially Returned** can be closed or cancelled). On a part-received order the buttons read **Close short** and **Cancel balance**. A confirmation dialog states exactly what will happen, with the quantities. Which one you use depends on what you want the order to say, not on what happens to stock:

| Situation | Close | Cancel PO |
|---|---|---|
| **Nothing received** (RFQ Sent, Quote Received, PO Sent, Shipped) | Order ends **Closed**. Use it when the supplier will not deliver and you want it off the "incoming" figures. | Order ends **Cancelled**. Use it when the order was a mistake or was withdrawn. Refused if a supplier bill exists: credit the bill first. |
| **Part-received** | **Close short**: the unreceived balance is dropped. | **Cancel balance**: exactly the same as Close short. |

### Close short (a part-received order)

Closing or cancelling a part-received order **drops the quantity still due and keeps what you received**:

- The goods already received stay in stock, with their quantities and FIFO cost layers unchanged.
- No stock is reversed. An unreceived balance has no ledger entry to undo; the only entries are the freight re-spread described below.
- The order ends **Closed** (both buttons), shown as **Closed short: received 60 of 100**. The ordered quantities are kept as the record of what was ordered.
- The dropped quantity stops counting as incoming and in open-PO and replenishment figures.
- Received goods that have not been billed yet can still be billed afterwards.
- **Freight and other cost lines are re-spread over what arrived.** Freight on the order (its own cost lines and linked freight orders) was spread over the whole ordered quantity when the goods were received. When the balance is dropped, the full freight is spread over the units that did arrive: a BY_VALUE cost line follows the value of what landed, BY_QUANTITY the units that landed, and a line that landed nothing carries none. The remaining cost layers are revalued (5.50 a unit becomes 5.83 in a 100-unit order with 50.00 of freight and 60 received), the share for units already sold is posted to cost of sales, and units still in transit between warehouses carry their share. The journals are DR Inventory / CR Transit for stock on hand and DR Cost of sales / CR Transit for stock already sold, so Goods in Transit for the order clears once the goods and the freight are billed. If the freight is not billed yet, the credit stays in Transit until its bill arrives. A freight credit larger than the goods cost is held at 0.00 per unit and you are warned. Other orders linked to the same freight order keep their own share and are not touched. An order with no freight posts nothing.

**To take received goods back out of stock, use Return Items first** (a supplier return), then close the order. Returning goods does not close or cancel the order and does not stop you receiving the rest: while quantity is still due, the order stays open after a return. A closed order cannot have goods returned against it.

If the supplier was billed for more than was received (a prepaid supplier), closing still works, but a warning names the lines and the amount billed ahead of receipt. Goods-in-transit keeps a debit for those goods until the supplier issues a credit note.

### Warehouse ASNs

An order whose lines have an **open warehouse ASN** (being created, open, partly booked in, or booked in but not yet reconciled) cannot be closed or cancelled. The message names the SKUs and ASN numbers. Book the goods in through the ASN (**Recheck booked-in**) or retire the ASN first, then close the order. This keeps the warehouse from receiving goods against an order that no longer expects them. Warehouse (Mintsoft) ASN handling is described in [Warehouse (Mintsoft)](warehouse-mintsoft.md).

### Idempotent cancellation

Cancelling a PO that is already CANCELLED is a no-op: the system returns success without writing duplicate activity log entries. It is safe to retry a cancellation after a transient error.

### Concurrent receipts

Receiving, closing, cancelling, editing and returning all take the same lock on the order. If a receipt and a close happen at the same moment, one waits for the other: a receipt that lands first is kept (the order then closes short); a close that lands first makes the receipt fail with "cannot be received in its current status", and nothing is written.


## Refused Cancellations

The system refuses to cancel a PO that has had nothing received but already has a supplier bill recorded against it. Credit or reverse the bill first. A part-received order is not subject to this rule, because closing it short reverses nothing.


## Purchase Returns

If goods need to be sent back to the supplier, create a purchase return against the original PO. The return reduces stock at the relevant warehouse and records the adjustment.

A return does not strand the rest of the order. While quantity is still due on any line, the order stays **Partially Received** after a return: you can still receive the balance, edit, close or cancel it, and the balance stays in the incoming figures. The order moves to **Partially Returned** or **Returned** only when nothing is left to receive.


## Purchase Invoicing

Record supplier invoices (bills) against purchase orders to track what has been billed. This helps reconcile POs with accounts payable.

### Three-way match (bill ≤ net received)

By default a PO line can only be billed up to its **net received quantity** (received − returned to
supplier). This is the classic three-way match control: the bill must reconcile with the PO *and*
the goods receipt, so a supplier can never be paid for goods that haven't arrived — or for
defective goods already sent back.

For **prepaid / deposit suppliers**, tick **Prepaid / deposit supplier** on the supplier record
(Purchases > Suppliers > Edit). Bills for that supplier's POs may then be raised up to the
full **ordered** quantity before anything is received — the deposit / pro-forma flow. The ordered
quantity remains a hard cap either way.

Note: if a prepaid PO is later received short (paid 100, received 90), the over-paid delta is not
yet flagged automatically — reconcile manually until the prepaid reconciliation alert ships.

### Editing an unpaid bill

Unpaid bills can be edited from the PO detail page. Headers (number, dates, notes, supplier
invoice URL) and per-line quantities or amounts can be updated. The edit recomputes totals on the
original PO FX rate and is wrapped in a single transaction that:

- Locks the bill, its lines, the parent PO, PO lines, and freight cost lines via row-level locks.
- Re-validates editability **inside** the transaction (a concurrent "mark paid" between page load
  and save will abort the edit).
- Checks overbilling against the **other** bills on the same PO so the combined billed quantity
  never exceeds the PO quantity, and the combined freight amount never exceeds the cost line.
- Refuses the save if the bill changed (another edit committed) after the form was loaded, asking for a reload, so two edits never overwrite each other.
- Persists the new header and line values.
- Queues a `PURCHASE_INVOICE_UPDATE` accounting sync (if the bill has already been synced) using a
  payload-derived idempotency key. Saving without any content change short-circuits with a
  "No bill changes to save" notice — no queue row is created.
- If the bill's **first posting has not been sent yet** (it is queued, or failed before any request was
  made), the edit is written into that queued posting in the same transaction, so the one posting that
  goes out carries the corrected bill. No update is queued and nothing is posted twice. If the first
  posting is being sent, was sent and has not been linked back to the bill yet, or failed after a request
  left, the edit is **refused** ("Nothing was saved"): wait until the posting has finished on the sync
  page, then edit the bill. A bill from before postings were keyed to the bill (its posting is keyed to the
  purchase order) is refreshed only when it is provably that bill's and unsent, otherwise it is refused the same way.

If the bill was previously synced and the accounting connector rejects the update (e.g. the
external bill is paid, locked, or voided), an amber **rejected sync** alert appears at the top of
the PO detail page with the connector, timestamp, retry count, and a safely truncated error
message. See the Xero sync docs for retry semantics.

Paid bills cannot be edited. Reverse the payment first if a correction is required.


### Supplier credit notes

The **Supplier credit notes** card at the bottom of a PO that has a bill lists every credit note recorded against the order, each marked **DRAFT** or **POSTED**.

- **Automatic draft on a return.** Returning goods that were already billed (**Return Items**) raises a **DRAFT** supplier credit note for the over-billed value. Repeated returns top the credit up to the over-billed total; they never credit the same goods twice. A banner at the top of the PO says how many units are billed but were returned and reminds you to review the draft.
- **Record one by hand.** Click **Record credit note** (shown once the order has a bill), enter the amount in the order's currency, optionally the supplier's credit note number and a reason, and click **Record (draft)**. The amount cannot exceed what is left to credit on the bill.
- **Post it.** Click **Post** on a draft. When the accounting connector is Xero and syncing is on, the credit note is queued to Xero as a supplier credit note and allocated against the bill it offsets; it is converted to your base currency at the bill's exchange rate (see the credit-note conversion note under [Landed Cost Distribution](#landed-cost-distribution)). If the accounting connector has changed since the credit note was prepared, it stays a draft with an explanation and you post it again once the connector selection has settled. Posting needs the invoicing permission.
- A posted credit note that fully offsets the bill is what lets you cancel an invoiced freight PO.

A supplier return on a part-received order does not change the order's status while quantity is still due (see [Purchase Returns](#purchase-returns)).

## Freight Purchase Orders

Create a **Freight PO** to capture shipping, customs, and other landed costs associated with bringing goods into your warehouse. Freight POs are linked to one or more product POs so that costs can be distributed across the received stock.


## Landed Cost Distribution

When a Freight PO is applied, its costs are distributed across the related PO lines. You can choose from four distribution methods:

| Method | How Costs Are Split |
|---|---|
| **By Value** | Proportionally based on each line's total value. Higher-value lines absorb more cost. |
| **By Weight** | Proportionally based on each line's total weight. Heavier lines absorb more cost. |
| **By Quantity** | Proportionally based on the number of units on each line. |
| **Equal Split** | The freight cost is divided equally across all lines regardless of value, weight, or quantity. |

Landed costs are added to the FIFO cost layers, so your COGS reflects the true all-in cost of each unit.

### Recalculation after receipt

If a freight PO is added or updated after goods have already been received, the system recalculates the landed cost retroactively:

- Existing FIFO cost layers from the affected receipts are revalued with the new unit costs.
- If any of those layers have already been consumed by sales shipments, a COGS revaluation journal is queued for Xero — it reverses the old COGS amount and posts the new one.
- All cost-layer snapshot changes are recorded in the activity log so finance can trace what changed and why.
- **A credit or zero cost line is applied the same way at receipt and at recalculation.** A cost line with a
  negative amount (a discount or credit from the supplier) reduces the cost spread over the goods it is allocated to,
  and a zero line adds nothing. The unit cost laid at receipt, the one shown on the purchase order and the one a later
  recalculation writes are computed by the same code from the same cost lines, so receiving goods and then saving the
  same freight costs again changes nothing and queues no journal.
- **A unit is never valued below zero.** If a credit is larger than the goods cost it is spread over, IMS values those
  units at **0.00** and does **not** push the cost negative. The part of the credit that could not be absorbed into
  stock is reported, not redistributed onto other lines and not posted by IMS: the purchase order detail shows a
  warning beside the line, the receipt result lists it, the recalculation's audit run records it (the
  `landed_cost_credit_floored` warning, with the unfloored unit cost and the amount per layer), and a **WARNING** entry
  (`landed_cost_credit_floored`) is written to the activity log whenever the unit cost or the unabsorbed amount changes. IMS queues no journal for that amount, so it is for
  you to establish what it corresponds to in the ledger. Because a purchase order's own layers can no longer go below zero from landed cost,
  a freight change no longer revalues an already-journaled shipment of those layers below zero. (Manufactured goods
  built from a floored layer are not covered by the floor; see the safeguard below.)
- **Freight orders accept an individual credit line, but not a net credit.** A freight order whose cost lines total
  less than zero, or whose total including VAT is less than zero (VAT is charged on a negative vatable line too), is
  refused with a message that a net credit from the supplier belongs on a supplier credit note. A zero line, a zero
  total, and a negative line inside a non-negative total are accepted. The cost-line forms themselves still accept
  positive amounts only. Saving a freight order's costs matches each line to the stored one by its id and edits it in
  place, so a saved line keeps its id; a line left out is removed and a new line is added. A line that has already been
  **billed** (a purchase invoice line points at it) can be neither changed nor removed, and the save is refused with a
  message naming the line. The edit dialog lists credit and zero lines read-only and submits them back unchanged, so
  saving does not delete them. Receiving goods and then saving the same freight costs again changes nothing, because
  receipt and recalculation compute the same cost.
- **A freight order records the VAT rate it was created with, and the edit dialog shows and sends it.** Saving the costs
  keeps that rate (it is never reset to 0%), and choosing a different rate in the dialog is an edit in its own right,
  even when no line changed. An order created before the rate was recorded that was charged VAT is not guessed at: the
  dialog asks you to choose the rate, and a save without one is refused with that explanation.
- **A supplier credit note converts to your base currency by dividing by the exchange rate.** The rate is stored as
  foreign units per one base unit, so a credit note of EUR 100.00 at 1.17 is recorded as 85.47 in base currency, the
  same conversion a purchase order uses. The bill's rate is used when the credit note is against a bill, otherwise the
  order's rate.
  Credit notes drafted automatically from a goods return convert the same way. Credit notes recorded before this
  was corrected keep their stored base amount (nothing is rewritten), but the freight-order cancellation check no
  longer trusts it: it recomputes each credit note's base amount from its foreign amount and rate.
- **A bill against a freight order charges VAT at the order's recorded rate on the vatable cost lines billed.** An
  order with 100 vatable and 100 exempt lines at 20% therefore bills 20 VAT for the vatable 100 (it used to bill 10,
  the blend over the whole order). Goods orders, and freight orders created before the rate was recorded, are
  unchanged.
- **A bill is not saved if its order was edited while the bill was being prepared.** The order and its cost lines are
  re-read under the bill's locks; if the rate, VAT, or any cost line's amount, description or VAT flag differs from what
  the bill was calculated from, you are told to reload and create the bill again, and nothing is saved.
  Editing an existing bill does the same check.
- **Once any cost line of a freight order has been billed, its VAT rate and the VAT flag of its lines cannot be changed.**
  The bill would keep the old VAT while the order showed the new, so the save is refused and tells you to correct or
  credit the bill first. Orders with no billed line can still change their rate.
- **A draft purchase order that already has a bill cannot have its lines, costs, VAT or exchange rate edited**, for the
  same reason; header-only edits (notes, references, delivery date) are still allowed.
- **A safeguard remains underneath.** Revaluing an already-journaled shipment below zero is still refused (nothing is
  changed and an **ERROR** entry, `landed_cost_revaluation_refused_journaled_shipment`, is written to the activity
  log) because IMS cannot post a negative COGS. Landed cost can no longer cause it on a purchase order's own layers; it remains the safeguard for manufactured outputs and any other source.

- **If stock moves while the recalculation is starting, it asks you to retry.** Creating a freight PO, saving a freight
  PO's costs and cancelling a freight PO each lock every transfer, purchase order and cost layer the revaluation will
  touch before they change anything. If a transfer is dispatched from one of those layers (or a new layer appears) in
  the instant between working out that set and locking it, the action stops with the message *"The landed-cost
  revaluation was NOT applied because stock moved while it was starting ... Retry the action."* Nothing was changed
  (a freight PO being created is not created, a cancellation leaves the PO active, a cost edit is not kept): just
  repeat the action.

Each landed-cost adjustment carries the `freightPoId` of the triggering freight PO. This means adjustments from different freight POs against the same primary PO are kept as separate journals — finance can attribute deltas to the right invoice source.


## Supplier Management

Navigate to **Purchases > Suppliers** in the sidebar to manage your supplier list. Each supplier record includes:

- **Contact details** -- Name, email, phone, and address.
- **Currency** -- The supplier's default trading currency.
- **Default VAT Rate** -- The default tax rate applied to POs for this supplier. When a PO file or import names the rate by name instead of choosing it, only active rates usable for purchases (Purchases or Both) can match; names are compared ignoring case and extra spaces. If two rates still match, the one spelled exactly is used, otherwise the order is refused with "choose the rate by id". A name that matches nothing leaves the order with no rate. Choosing the rate from the list always wins.
- **VAT Number**, **Account Number** and **Delivery Time (days)** -- delivery time shows the average from your PO history beside the figure you enter.
- **Payment Terms** -- The agreed payment terms (e.g. Net 30, Net 60).

### Importing suppliers from CSV

The supplier CSV (export it from the Suppliers page for the exact columns) carries the supplier's currency and, in the `purchaseTaxType` column, its **default tax rate** as a Xero tax type (for example `INPUT2` for 20% VAT on expenses, `ZERORATEDINPUT` for zero-rated purchases, `NONE` for no VAT). The import sets the supplier's tax rate to the one **active tax rate that can be used for purchases** (used for Purchases or Both) and carries that Xero tax type. If no such rate exists, or more than one does, the row is refused and reported (create the missing Purchases rates from Xero's stored list with **Settings > Accounting > Tax > Import purchase tax rates from Xero**; the first load does this itself); the tax rate is never chosen by name. A blank `purchaseTaxType` leaves an existing supplier's tax rate unchanged. The first-load import (a new installation) is stricter: it refuses a supplier with a blank currency or a blank tax class instead of defaulting them, so a base-currency supplier must say `GBP` explicitly (see `docs/first-load-input-spec.md`).


## Auto-Save Last PO Prices

Every time a purchase order is sent or received, the system saves the **last PO price** for each supplier-product combination, along with the FX rate at the time. When you next create a PO for the same supplier and product, the price is pre-filled automatically. This saves time and reduces data entry errors.


## Preferred Supplier Auto-Update

When a PO transitions to **PO_SENT** (the supplier has been notified), the system automatically updates the `preferredSupplier` field on every product included in the PO. The rule is "latest PO wins" — the most recent PO_SENT determines which supplier is the preferred for that product.

### Why this matters

Supplier-scoped reorder draft generation uses the preferred supplier to decide which supplier's draft PO a product belongs in. Auto-updating from your actual buying history keeps the reorder workflow aligned with reality.

### Opting out

You can prevent the auto-update in two ways:

1. **Per-product** — set **Preferred Supplier Locked** on the product page. The system skips the update for that product regardless of which supplier the PO uses. Useful for products consistently sourced from one supplier where you occasionally place backup-supplier POs.
2. **Per-PO** — tick **"Skip preferred-supplier update"** on the PO header before saving. This particular PO won't change any product's preferred supplier.

### When the update runs

- **Only on PO_SENT** — DRAFT and RFQ POs don't update the field.
- **Only on goods POs** (type=GOODS) — freight POs don't change product supplier mappings.
- **In the same transaction** as the status transition — atomic, so a failed PO_SENT doesn't leave a half-updated state.

### No rollback on later cancellation/return

If a PO is later cancelled or fully returned, the preferred-supplier update is NOT rolled back. The product still points at the supplier from that PO. To restore the previous supplier, place a new PO with the correct supplier, or set the field manually.


## Supplier-Scoped Reorder Drafts

From **Analytics > Reorder Planning** (the standalone Reorder Forecast page has been retired and folded into it, see [Analytics](analytics.md#inventory-health-and-demand-planning)), you can generate **draft purchase orders** from the suggestions.

1. Open Reorder Planning and filter as needed (supplier uses the preferred supplier field).
2. Tick the rows you want, or leave all unticked to act on every visible row (a confirmation names the row count).
3. Click **Generate from selection** (or **Generate POs + draft MOs for all visible rows**). One draft PO is created per supplier with one line per product; manufactured (BOM) rows get a draft production order instead.
4. Each line carries **reorder evidence** — forecast metadata (stock at forecast time, demand rate, lead time, days of cover) stored on the line for later audit.
5. A supplier that already received a reorder draft within the last few minutes is skipped (the result names how many), so a double click does not create duplicates.
6. Review and adjust quantities, then send the PO normally.

Lifecycle exclusions apply: only Draft and Active products are planned. EOL and Archived products are skipped.


## Supplier Portal

Suppliers with user accounts (SUPPLIER role) can access a dedicated portal to:

- **View RFQs** addressed to their company and **submit quotes** with prices, quantities, PO number, delivery date, and shipping details. An RFQ appears only once you have marked it **RFQ Sent**; a purchase order still in Draft is never visible to the supplier (not in the list, by direct link, or as an RFQ PDF). After a quote is submitted the supplier sees a read-only **Quote Submitted** confirmation (the RFQ stays open on screen but cannot be edited), and the order moves to **Quote Received** for your review.
- **View Purchase Orders** for their company (sent orders only; drafts, and cancelled orders that were never sent, are hidden)
- **View their products** linked to the supplier (without financial data such as sell prices, margins, or COGS)

Supplier users land on the RFQ list (**RFQs**, `/supplier/rfqs`) after login (they have no dashboard) and see a separate navigation with only the sections relevant to them. All supplier actions are verified server-side to ensure suppliers can only access their own data.
