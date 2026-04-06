# Sales Orders

Sales orders track customer purchases from creation through to dispatch and completion. Orders can be created manually or imported automatically from WooCommerce.

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

## Order Statuses

Sales orders progress through the following statuses:

| Status | Description |
|---|---|
| **Pending** | Order created, awaiting confirmation |
| **Processing** | Order confirmed and being prepared |
| **Picking** | Items are being picked from the warehouse |
| **Packed** | Items picked and packed, ready for dispatch |
| **Shipped** | Order has been dispatched to the customer |
| **Completed** | Order fulfilled and closed |
| **Cancelled** | Order cancelled, stock reservations released |
| **On Hold** | Order paused, awaiting further action |

## Stock Allocation

When a sales order is created, the requested stock is **reserved** against your inventory. This reserved quantity prevents the same stock from being promised to multiple orders. You will see the reserved quantity reflected in your inventory figures until the order is dispatched or cancelled.

## Dispatching

When you dispatch an order, the reserved stock is **deducted** from the selected warehouse. A stock movement record is created automatically to maintain a full audit trail.

## Refunds

To process a refund:

1. Open the sales order and select **Refund**
2. Choose the items and quantities being returned
3. Select the **return warehouse** where the stock will be received back
4. Confirm the refund

Returned stock is added back into the selected warehouse's inventory automatically.

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

## Documents

Two PDF documents are available for each sales order:

- **Sales Order PDF** — a summary of the order for internal use or to send to the customer
- **Invoice PDF** — the formal tax invoice, generated manually or automatically

PDFs use your company branding (logo, colours, and footer) as configured in Settings.

## Other Actions

- **Clone an order** to quickly create a new order based on an existing one
- **Update notes** to add internal comments or special instructions to any order
