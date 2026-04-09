# Getting Started

Welcome to One Two Inventory -- a complete inventory management system for tracking stock, purchasing, sales, manufacturing, and business analytics.

Whether you manage a single warehouse or multiple locations, One Two Inventory gives you real-time visibility over your products, costs, and order flow.


## What You Can Do

- **Inventory** -- Track products across warehouses with FIFO costing and real-time stock levels.
- **Purchasing** -- Create purchase orders, receive stock, manage suppliers, and handle landed costs.
- **Sales** -- Process sales orders with smart stock allocation, multi-warehouse shipments, and delivery tracking.
- **Manufacturing** -- Define bills of materials and build finished goods from components.
- **Integrations** -- Connect WooCommerce for automatic order import, status sync, and stock push.
- **Analytics** -- Monitor gross sales, net sales, COGS, and margin from a live dashboard.


## First Steps

### 1. Log In

Use the credentials provided by your administrator. If you are the first user, follow the setup prompts to create your account.

### 2. Set Up Company Details

Navigate to **Settings > Company** and enter your business name, address, currency, and financial year start date.

### 3. Configure Warehouses

Go to **Settings > Warehouses** and create at least one warehouse. Each warehouse tracks its own stock levels independently.

### 4. Add Products

Head to **Inventory** and click **New Product**. Fill in the SKU, name, product type, and pricing. You can add products one at a time or import them in bulk via CSV.


## Notifications

The notification bell in the top bar shows system alerts and updates. Notifications are colour-coded by type:

- **Info** (blue) — routine system events
- **Success** (green) — completed operations
- **Warning** (orange) — items that may need attention
- **Error** (red) — failures requiring action

Unread notifications are indicated by a badge on the bell icon. Click a notification to view its details or navigate to the relevant page.


## Navigation

The sidebar organises the system into sections:

| Section | Purpose |
|---|---|
| **Dashboard** | KPIs, charts, and operational summaries |
| **Inventory** | Product catalogue, stock levels, and product details |
| **Stock Control** | Adjustments and warehouse transfers |
| **Purchasing** | Purchase orders, suppliers, and receiving |
| **Sales** | Sales orders, allocation, shipments, and fulfilment |
| **Manufacturing** | Build orders for BOM products |
| **Sync** | External integrations (WooCommerce, Shopify, Xero, REST API) |
| **Analytics** | Sales, purchasing, and inventory reports |
| **Settings** | Company, warehouses, users, roles, and configuration |


## Key Concepts

### Product Types

| Type | Description |
|---|---|
| **Simple** | A standalone product with its own SKU and stock level. |
| **Variable** | A parent product that holds shared details. It is not stocked directly -- its variants are. |
| **Variant** | A child of a Variable product representing a specific option combination (e.g. size/colour). Tracked and sold individually. |
| **Kit** | A bundle of existing products sold as one unit. Kit stock is calculated from its components -- no separate stock is held. |
| **BOM** (Bill of Materials) | A product that is manufactured from components. Components are consumed and finished goods are produced via build orders. |
| **Non-Inventory** | A product tracked for sales and purchasing but not counted in stock (e.g. services, digital goods). |

### Warehouses

A warehouse is any location where you hold stock -- a physical warehouse, a shop floor, or a third-party logistics provider. Each product's stock is tracked per warehouse.

### Stock Levels

Every product has four stock-level figures per warehouse:

- **On Hand** -- The total physical quantity in the warehouse.
- **Allocated** -- Quantity reserved for confirmed sales orders. Click the figure to see which orders hold the allocation.
- **Available** -- On Hand minus Allocated. This is what you can sell or transfer right now.
- **Incoming** -- Quantity expected from open purchase orders or inbound transfers. Click the figure to see the source documents.
