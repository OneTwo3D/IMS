@AGENTS.md

# Infrastructure

- **OLS (OpenLiteSpeed)**: `10.0.3.12` — accessible via `ssh 10.0.3.12`
- **Redis**: `10.0.3.11` — accessible via `ssh 10.0.3.11`

# One Two Inventory — Product Specification

## Modules

### 1. Dashboard
- Key metrics: daily/monthly/yearly sales & purchase figures
- Charts: best-selling products, margin, COGS, net/gross sales, average order value
- Selectable period with comparison to previous period or same period prior year
- Cash bridge waterfall chart
- Operational KPIs: open orders, open POs, inventory value, low stock, shipping

### 2. Inventory
- Stock levels per product per warehouse (on hand, allocated, available, incoming)
- Clickable allocation/incoming popups showing source orders
- Price lists
- COGS tracking using FIFO principle
- Product types: SIMPLE, VARIABLE, VARIANT, KIT, BOM, NON_INVENTORY
- Product image URL field (auto-populated via future WC sync)
- BOM/Kit component search (type-ahead, not dropdown)

### 3. Stock Control
- **Stock transfers**: between warehouses, with "in transit" status that makes stock unavailable
- **Stock count**: cycle/full count workflow
- **Adjustments**: add/remove stock per product per warehouse, logged as StockMovement
- **Warehouses**: setup and manage warehouse locations

### 4. Purchase Orders
- Multi-currency PO generation with live FX rate updates
- Landed cost distribution across PO lines
- PDF and email generation for RFQ (without prices) and PO (with barcode/EAN)
- Link to third-party POs for external landed costs (shipping, customs)
- Enter shipping/other supplier fees directly in PO for landed cost calculation
- Receive PO (creates FIFO cost layers)
- Invoice PO (sync to Xero)
- Return PO
- Supplier management: contact, address, email, phone, currency, tax rate
- Auto-save last PO prices per supplier/product for pre-population
- Auto-filter products by supplier

### 5. Sales
- Orders imported from WooCommerce (WC link only shown when synced)
- WC order changes → order update (via webhook)
- WC order cancellation → cancellation
- WC refund/part-refund → refund with selectable return warehouse (default configurable)
- Shipping/picking/packing: automatic warehouse selection via configurable rules
- Stock allocation via reservedQty on StockLevel

### 6. Manufacturing
- Production orders: assembly and disassembly
- Bill of Materials (BOMs) with type-ahead component search
- Kit assembly/disassembly
- Stock check before starting production (DRAFT → IN_PROGRESS)
- Component allocation (reservedQty) during production
- Stock movements on completion (PRODUCTION_IN/PRODUCTION_OUT)
- Manufacturer selection from suppliers list (preselects last used)
- PDF generation and email to 3rd party manufacturers
- Manufacturing order template in document settings

### 7. Sync (External Integrations)
- **WC Stock levels**: select warehouses to sync stock to WooCommerce
- **WC Orders**: configurable order status to sync, interval or webhook trigger
- **WC Products/Prices**: bidirectional via webhook on change
- **Xero — Purchase invoices**: stock-in-transit → inventory, Xero API, daily accumulated journal entries
- **Xero — COGS**: Xero API, daily accumulated journal entries

### 8. Analytics
- Stock level forecasts and reorder forecasts
- Good/bad selling product identification
- Sales statistics: gross/net turnover, shipping income, COGS, etc. (6 tabs)
- Purchase statistics (5 tabs)
- Inventory report
- All reports with filter, columns, save view, export

### 9. Settings (organised in sidebar sub-sections)
- **Company**: name, address, logos (icon + document), branding colours, document numbering, email/SMTP, department emails (sales/purchases/support), document templates (7 types with PDF/email preview)
- **Inventory**: stock adjustment reasons (with Xero account mapping)
- **Sales**: invoice generation trigger
- **Purchasing**: purchase units, landed cost distribution
- **Accounting**: financial year, VAT rates, currencies & FX rates, FX rate schedule
- **Backup & Restore**: create/download/restore backups, scheduled backups with retention, remote storage (S3 + SFTP with key auth)
- **System**: activity log retention, database reset

### 10. Activity Log
- Logs all activities with tag (sales, purchase, inventory, stock, sync, settings, auth, import, manufacturing, system)
- Level-based filtering (Info, Warning, Error)
- Searchable by description, action, entity ID, user
- Tag filter buttons
- Expandable rows with metadata
- Configurable retention per level
- All stock movements logged (dispatch, receipt, transfer, adjustment, production)

### 11. User Management
- Profile: name, email, avatar upload (with session refresh), role display
- Password change
- TOTP 2FA
- Passkey/WebAuthn support (registration, login, management)
- Session provider for client-side session updates

### 12. PDF Documents
- Branded PDFs with document logo, accent colours, company address
- Auto-contrast text colour for title and table headers
- SVG logo support (converted via sharp)
- Custom footer per document type
- Department-specific contact email
- Totals aligned with table columns
- Templates: sales order, purchase order, invoice, packing slip, credit note, RFQ, manufacturing order

### 13. Cron Endpoints
- `/api/cron/fx-rates` — daily FX rate update
- `/api/cron/activity-cleanup` — daily activity log purge
- `/api/cron/backup` — daily scheduled backup with retention + remote upload
