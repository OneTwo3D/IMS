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

WooCommerce orders follow the full completion flow: when WC marks an order as completed, the system auto-allocates stock and creates shipments with tracking information. See the [Integrations Dashboard](#integrations-dashboard) documentation for details on WooCommerce sync configuration.

## Order Statuses

Sales orders progress through the following statuses:

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

## Stock Allocation

Stock allocation determines which warehouse(s) will fulfil each order line. The system uses an **OrderAllocation** model to track per-line, per-warehouse allocation.

### Auto-Allocation

The smart auto-allocation algorithm minimises the number of shipments by consolidating warehouses. It analyses stock availability across all warehouses and assigns lines to as few warehouses as possible.

### Allocation Panel

The order detail page includes an allocation panel that shows:

- **Allocations grouped by warehouse** -- see which warehouse fulfils which lines
- **Backorder items** -- lines where insufficient stock is available
- **Manual edit** -- override allocations manually if needed

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
- **Email documents** directly via SMTP with PDF attachments (sales order or invoice)
