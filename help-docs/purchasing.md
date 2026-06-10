# Purchasing

The Purchasing section manages your purchase orders, supplier relationships, and stock receipts.


## Purchase Order List

The main purchasing page shows all purchase orders in a searchable table.

- **Search** -- Find POs by number, supplier name, or reference.
- **Filter by Status** -- Narrow the list to a specific status.
- **Export** -- Download the current filtered list as a CSV file.


## Creating a Purchase Order

1. Click **New Purchase Order**.
2. Select a **supplier** from your supplier list.
3. Confirm the **currency** (defaults to the supplier's currency).
4. The **FX rate to base currency** is pre-filled from the stored exchange rate for the PO date. You can override this, but the system validates the rate against a 10% sanity band — see [FX rate validation](#fx-rate-validation) below.
5. Select the **destination warehouse** where the goods will be received.
6. Add lines by searching for products. The system pre-fills the last purchase price for that supplier if one exists.
7. Enter quantities and adjust prices as needed.
8. (Optional) Tick **"Skip preferred-supplier update"** on the PO header if you don't want this PO to overwrite the products' preferred suppliers — useful for emergency or one-off orders. See [Preferred supplier auto-update](#preferred-supplier-auto-update) below.
9. Save the PO.

### FX rate validation

For non-base-currency POs, the system protects against typos and stale rates:

- **Default** — the FX rate is auto-filled from the most recent stored rate for the PO date.
- **Within 2% of stored rate** — accepted silently.
- **2% to 10% deviation** — accepted but the system logs a WARNING activity entry and shows a yellow warning in the UI. Use this when there's a deliberate reason for the difference (forward contract, supplier-specific rate, etc.).
- **More than 10% deviation** — rejected. Either correct the rate or refresh the stored rate via Settings > Accounting > FX Rates.

This catches the "decimal in the wrong place" class of errors that previously could silently misprice every cost layer.


## Purchase Order Statuses

Purchase orders use the canonical purchase workflow documented in `docs/workflows.md`. User-facing statuses include:

| Status | Meaning |
|---|---|
| **Draft** | The PO has been created but not yet sent. Lines can still be edited. |
| **RFQ Sent** | A request for quotation has been sent to the supplier. |
| **Quote Received** | A supplier quote has been received and can be converted to a purchase order. |
| **PO Sent** | The purchase order has been confirmed and sent to the supplier. |
| **Shipped** | The supplier has shipped the goods. |
| **Partially Received** | Some lines have been received but the PO is not yet complete. |
| **Received** | All expected lines have been received. |
| **Invoiced** | A supplier invoice has been recorded for the PO. |
| **Partially Returned** | Some received goods have been returned to the supplier. |
| **Returned** | Received goods have been fully returned to the supplier. |
| **Closed** | The PO has been closed. |
| **Cancelled** | The PO has been cancelled. |


## PDF Documents

### RFQ PDF

Generate a request for quotation PDF to send to the supplier. The RFQ includes product details and barcodes/EANs but **does not include prices**, so the supplier can quote against it.

### PO PDF

Generate a purchase order PDF to send to the supplier. The PO PDF includes product details, barcodes/EANs, **and prices**.


## Receiving a Purchase Order

When goods arrive, open the PO and click **Receive**. You can receive all lines at once or partially receive individual lines.

When stock is received:

- A **FIFO cost layer** is created for each line, recording the quantity and unit cost.
- **Stock levels** at the destination warehouse are updated immediately.
- The PO status moves to **Partially Received** or **Fully Received** accordingly.

The unit cost is validated as finite and non-negative before stock movements are written. A landed-cost recalculation that produces a NaN or infinite cost is rejected at the receipt boundary, before any stock or cost layer is created.


## Cancelling a Purchase Order

POs in DRAFT, RFQ_SENT, QUOTE_RECEIVED, PO_SENT, SHIPPED, or PARTIALLY_RECEIVED status can be cancelled.

### Cost-layer reversal on cancellation

If the PO has been partially received before cancellation, the system reverses every remaining cost layer created from that PO:

- Each cost layer's `remainingQty` is set to zero
- Reversing stock movements are created
- COGS reversal entries are written
- Stock-on-hand at the destination warehouse is decremented
- An inventory-adjustment journal is queued for Xero (if accounting sync is enabled)
- The PO is marked Cancelled
- The activity log records the reversed layers and total reversal value

This means cancelling a PARTIALLY_RECEIVED PO undoes the inventory impact cleanly. If you don't want to undo the inventory — for example, if you've already sold some of the received stock — return the received goods first, then cancel.

### Idempotent cancellation

Cancelling a PO that is already CANCELLED is a no-op — the system returns success without writing duplicate activity log entries or accounting journals. This means it's safe to retry a cancellation if a transient error occurred.


## Refused Cancellations

The system refuses to cancel a PO when supplier invoices have already been recorded against it (INVOICED state). Process a purchase return first, then handle the cancellation manually.


## Purchase Returns

If goods need to be sent back to the supplier, create a purchase return against the original PO. The return reduces stock at the relevant warehouse and records the adjustment.


## Purchase Invoicing

Record supplier invoices against purchase orders to track what has been billed. This helps reconcile POs with accounts payable.


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

Each landed-cost adjustment carries the `freightPoId` of the triggering freight PO. This means adjustments from different freight POs against the same primary PO are kept as separate journals — finance can attribute deltas to the right invoice source.


## Supplier Management

Navigate to **Purchasing > Suppliers** to manage your supplier list. Each supplier record includes:

- **Contact details** -- Name, email, phone, and address.
- **Currency** -- The supplier's default trading currency.
- **Tax Rate** -- The default tax rate applied to POs for this supplier.
- **Payment Terms** -- The agreed payment terms (e.g. Net 30, Net 60).


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

From Analytics > Reorder Forecast, you can generate a **draft purchase order** for a specific supplier.

1. Open the reorder forecast and filter by supplier (uses the preferred supplier field).
2. The forecast shows reorder-eligible products for that supplier with suggested quantities.
3. Click **Generate Draft PO** to create a PO scoped to that supplier with one line per product.
4. Each line carries **reorder evidence** — forecast metadata (stock at forecast time, demand rate, lead time, days of cover) stored on the line for later audit.
5. Review and adjust quantities, then send the PO normally.

Lifecycle exclusions apply: EOL and Archived products are skipped, even if the forecast would suggest a reorder.


## Supplier Portal

Suppliers with user accounts (SUPPLIER role) can access a dedicated portal to:

- **View RFQs** addressed to their company and **submit quotes** with prices, quantities, PO number, delivery date, and shipping details
- **View Purchase Orders** for their company
- **View their products** linked to the supplier (without financial data such as sell prices, margins, or COGS)

Supplier users see a separate navigation with only the sections relevant to them. All supplier actions are verified server-side to ensure suppliers can only access their own data.
