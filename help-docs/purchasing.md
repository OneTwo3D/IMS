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
4. Select the **destination warehouse** where the goods will be received.
5. Add lines by searching for products. The system pre-fills the last purchase price for that supplier if one exists.
6. Enter quantities and adjust prices as needed.
7. Save the PO.


## Purchase Order Statuses

| Status | Meaning |
|---|---|
| **Draft** | The PO has been created but not yet sent. Lines can still be edited. |
| **RFQ Sent** | A request for quotation has been sent to the supplier. |
| **PO Sent** | The purchase order has been confirmed and sent to the supplier. |
| **Partially Received** | Some lines have been received but the PO is not yet complete. |
| **Fully Received** | All lines have been received. |
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


## Supplier Management

Navigate to **Purchasing > Suppliers** to manage your supplier list. Each supplier record includes:

- **Contact details** -- Name, email, phone, and address.
- **Currency** -- The supplier's default trading currency.
- **Tax Rate** -- The default tax rate applied to POs for this supplier.
- **Payment Terms** -- The agreed payment terms (e.g. Net 30, Net 60).


## Auto-Save Last PO Prices

Every time a purchase order is sent or received, the system saves the **last PO price** for each supplier-product combination, along with the FX rate at the time. When you next create a PO for the same supplier and product, the price is pre-filled automatically. This saves time and reduces data entry errors.


## Supplier Portal

Suppliers with user accounts (SUPPLIER role) can access a dedicated portal to:

- **View RFQs** addressed to their company and **submit quotes** with prices, quantities, PO number, delivery date, and shipping details
- **View Purchase Orders** for their company
- **View their products** linked to the supplier (without financial data such as sell prices, margins, or COGS)

Supplier users see a separate navigation with only the sections relevant to them. All supplier actions are verified server-side to ensure suppliers can only access their own data.
