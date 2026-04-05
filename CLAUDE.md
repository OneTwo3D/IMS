@AGENTS.md

# Infrastructure

- **OLS (OpenLiteSpeed)**: `10.0.3.12` — accessible via `ssh 10.0.3.12`
- **Redis**: `10.0.3.11` — accessible via `ssh 10.0.3.11`

# OneTwo3D IMS — Product Specification

## Modules

### 1. Dashboard
- Key metrics: daily/monthly/yearly sales & purchase figures
- Charts: best-selling products, margin, COGS, net/gross sales, average order value
- Selectable period with comparison to previous period or same period prior year

### 2. Inventory
- Stock levels per product per warehouse
- Price lists
- COGS tracking using FIFO principle
- Product types: SIMPLE, VARIABLE, VARIANT, KIT

### 3. Stock Control
- **Stock transfers**: between warehouses, with "in transit" status that makes stock unavailable
- **Stock count**: cycle/full count workflow
- **Adjustments**: add/remove stock per product per warehouse, logged as StockMovement
- **Warehouses**: setup and manage warehouse locations

### 4. Purchase Orders
- Multi-currency PO generation with live FX rate updates
- Landed cost distribution across PO lines
- PDF and email generation for RFQ (without prices) and PO
- Link to third-party POs for external landed costs (shipping, customs)
- Enter shipping/other supplier fees directly in PO for landed cost calculation
- Receive PO (creates FIFO cost layers)
- Invoice PO (sync to Xero)
- Return PO
- Supplier management: contact, address, email, phone, currency, tax rate
- Auto-save last PO prices per supplier/product for pre-population
- Auto-filter products by supplier

### 5. Sales
- Orders imported from WooCommerce
- WC order changes → IMS order update (via webhook)
- WC order cancellation → IMS cancellation
- WC refund/part-refund → IMS refund with selectable return warehouse (default configurable)
- Shipping/picking/packing: automatic warehouse selection via configurable rules

### 6. Manufacturing
- Production orders
- Bill of Materials (BOMs)
- Kit assembly/disassembly

### 7. Sync (External Integrations)
- **WC Stock levels**: select warehouses to sync stock to WooCommerce
- **WC Orders**: configurable order status to sync, interval or webhook trigger
- **WC Products/Prices**: bidirectional via webhook on change
- **Xero — Purchase invoices**: stock-in-transit → inventory, Xero API, daily accumulated journal entries, one line per PO line item
- **Xero — COGS**: Xero API, daily accumulated journal entries

### 8. Analytics
- Stock level forecasts
- Re-order forecasts
- Good/bad selling product identification
- Sales statistics: gross/net turnover, shipping income, COGS, etc.

### 9. Settings
- Xero account mapping (COGS, inventory adjustment, etc.)
- Warehouse setup
- Organisation settings
- Tax settings
- Currency settings
- Branding/customisation

### 10. Activity Log
- Log all IMS activities (stock movements, order imports, syncs, user actions)
