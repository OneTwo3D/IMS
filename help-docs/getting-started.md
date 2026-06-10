# Getting Started

Welcome to One Two Inventory -- a complete inventory management system for tracking stock, purchasing, sales, manufacturing, and business analytics.

Whether you manage a single warehouse or multiple locations, One Two Inventory gives you real-time visibility over your products, costs, and order flow.


## What You Can Do

- **Inventory** -- Track products across warehouses with FIFO costing and real-time stock levels.
- **Purchasing** -- Create purchase orders, receive stock, manage suppliers, and handle landed costs.
- **Sales** -- Process sales orders with smart stock allocation, multi-warehouse shipments, and delivery tracking.
- **Manufacturing** -- Define bills of materials and build finished goods from components.
- **Integrations** -- Optionally connect shopping and accounting platforms such as WooCommerce and Xero.
- **Analytics** -- Monitor gross sales, net sales, COGS, and margin from a live dashboard.


## First Steps

> **New here?** For a step-by-step walkthrough of the setup wizard, see the [Setup Wizard Walkthrough](onboarding-walkthrough.md). For unfamiliar terms (FIFO, COGS, EOL, etc.), see the [Glossary](glossary.md). For common errors, see [Troubleshooting](troubleshooting.md).

### 1. Log In

Use the credentials provided by your administrator. If you are the first user, follow the setup wizard at `/onboarding` to configure the system.

### 2. Set Up Company Details

Navigate to **Settings > Company** and enter your business name, address, base currency, and financial year start date.

Set the base currency carefully. It becomes the system's reporting and valuation currency and is intended to be chosen once for a fresh installation. Changing it later requires a database reset.

### 3. Configure Warehouses

Go to **Settings > Inventory** and create at least one warehouse. Each warehouse tracks its own stock levels independently.

### 4. Connect Integrations (optional)

If you use WooCommerce, Shopify, Xero, QuickBooks, or Mintsoft, connect them now from **Integrations**. After entering credentials, you must **click "Test Connection"** before sync activates — this is the system's safety net against silently running with bad credentials. See the [Setup Wizard Walkthrough](onboarding-walkthrough.md) for connector-specific instructions.

### 5. Add Products

Head to **Inventory** and click **New Product**. Fill in the SKU, name, product type, lifecycle status, and pricing. You can add products one at a time or import them in bulk via CSV.

For new products that aren't ready for sale yet, set **lifecycle status to Draft** — they can still be purchased but won't be sellable until you flip them to Active. See the [Glossary](glossary.md#lifecycle-status) for the full lifecycle.


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
| **Integrations** | External shopping and accounting connectors. This section only appears when at least one integration plugin is enabled. |
| **Analytics** | Sales, purchasing, and inventory reports |
| **Settings** | Company, inventory, users, backup, system, and configuration |


## Key Concepts

### Product Types

| Type | Description |
|---|---|
| **Simple** | A standalone product with its own SKU and stock level. |
| **Variable** | A parent product that holds shared details. It is not stocked directly -- its variants are. |
| **Variant** | A child of a Variable product representing a specific option combination (e.g. size/colour). Tracked and sold individually. |
| **Kit** | A bundle of existing products sold as one unit. Kit stock is calculated from its components -- no separate stock is held. Kits can be standalone SKUs or child variants under a Variable parent. |
| **BOM** (Bill of Materials) | A product that is manufactured from components. Components are consumed and finished goods are produced via build orders. BOMs can be standalone SKUs or child variants under a Variable parent. |
| **Non-Inventory** | A product tracked for sales and purchasing but not counted in stock (e.g. services, digital goods). |

### Warehouses

A warehouse is any location where you hold stock -- a physical warehouse, a shop floor, or a third-party logistics provider. Each product's stock is tracked per warehouse.

### Stock Levels

Every product has four stock-level figures per warehouse:

- **On Hand** -- The total physical quantity in the warehouse.
- **Allocated** -- Quantity reserved for confirmed sales orders. Click the figure to see which orders hold the allocation.
- **Available** -- On Hand minus Allocated. This is what you can sell or transfer right now.
- **Incoming** -- Quantity expected from open purchase orders, in-transit transfers, in-progress manufacturing, or WMS ASN evidence. Click the figure to see the source documents.

### Product Lifecycle

Every product has a lifecycle status that controls what you can do with it:

| Status | Sellable? | Purchasable? | In reorder forecasts? |
|---|---|---|---|
| **Draft** | No | Yes | Yes |
| **Active** | Yes | Yes | Yes |
| **EOL** (End of Life) | Yes (from existing stock) | No | No |
| **Archived** | No | No | No |

The system auto-archives EOL products once stock and incoming supply hit zero. See the [Glossary](glossary.md#lifecycle-status) and [Inventory documentation](inventory.md#lifecycle-status) for more detail.


## Where to find help

| Topic | See |
|---|---|
| Step-by-step setup | [Setup Wizard Walkthrough](onboarding-walkthrough.md) |
| Unfamiliar terms | [Glossary](glossary.md) |
| Errors and unexpected behaviour | [Troubleshooting](troubleshooting.md) |
| Detailed inventory features | [Inventory](inventory.md) |
| Sales workflows | [Sales Orders](sales.md) |
| Purchasing workflows | [Purchasing](purchasing.md) |
| Settings | [Settings](settings.md) |
| WooCommerce integration | [WooCommerce Integration](woocommerce.md) |
| Xero accounting sync | [Xero Accounting Sync](xero-sync.md) |
| User roles & security | [User Management & Security](user-management.md) |
| Manufacturing | [Manufacturing](manufacturing.md) |
| Analytics & reports | [Analytics](analytics.md) |
