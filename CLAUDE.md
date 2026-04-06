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
- **Order status flow**: DRAFT → PENDING_PAYMENT → ON_HOLD → PROCESSING → ALLOCATED → PICKING → PACKING → SHIPPED → COMPLETED → DELIVERED (optional)
- **Stock allocation**: OrderAllocation model tracks per-line, per-warehouse allocation
- **Smart auto-allocation**: minimises shipments by consolidating warehouses
- **Allocation panel**: grouped by warehouse, backorder items, manual edit
- **Multi-shipment system**: Shipment/ShipmentLine models for multi-warehouse shipping
- **Per-shipment progression**: PENDING → PICKING → PACKED → SHIPPED with independent tracking numbers
- **Configurable shipping carriers**: pre-populated (Royal Mail, DPD, DHL, FedEx, UPS, etc.) with tracking URLs for 13 carriers + 17track fallback
- **Delivery tracking module** (Settings → Sales): toggle enable/disable, source WooCommerce (AST plugin) or TrackShip API, cron: /api/cron/delivery-status
- **Email sending**: sendSalesOrderEmail and sendInvoiceEmail via SMTP with PDF attachments

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
- **Integrations dashboard** (/sync): connector tiles with logos for WooCommerce, Shopify (coming soon), Xero (coming soon), QuickBooks (coming soon), REST API
- **WooCommerce connector module** (lib/connectors/woocommerce/): modularised with ShoppingConnector and AccountingConnector interfaces
- **WC Stock levels**: select warehouses to sync stock to WooCommerce
- **WC Orders**: full sync module — import, bidirectional status sync, refund sync, product sync, stock sync
- **WC Webhooks**: /api/webhooks/woocommerce/orders|refunds|products (timing-safe HMAC verification)
- **WC Cron polling**: /api/cron/wc-sync
- **WC Status mapping**: configurable with seeded defaults matching WC flowchart
- **WC Tax class mapping**: WC tax class → IMS TaxRate
- **WC Completion flow**: WC completed → auto-allocate → ship with tracking
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
- **Company**: name, address, logos (icon + document), branding colours, document numbering, email/SMTP (nodemailer), department emails (sales/purchases/support), document templates (7 types with PDF/email preview)
- **Inventory**: stock adjustment reasons (with Xero account mapping)
- **Sales**: invoice generation trigger, delivery tracking module (toggle, source selection, shipping carriers)
- **Purchasing**: purchase units, landed cost distribution
- **Accounting**: financial year, VAT rates, currencies & FX rates, FX rate schedule
- **Users**: user CRUD with role assignment (ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER)
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

### 11. User Management & RBAC
- Profile: name, email, avatar upload (with session refresh), role display
- Password change
- TOTP 2FA
- Passkey/WebAuthn support (registration, login, management)
- Session provider for client-side session updates
- **6 roles**: ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER
- **User CRUD** (Settings → Users) with role assignment
- **Permission system** (lib/permissions.ts) with sidebar filtering per role
- **Supplier users** linked to supplier company

### 11a. Supplier Portal
- Separate navigation: RFQs, Purchase Orders, My Products
- No access to prices, margins, COGS, analytics
- Submit quotes from RFQs (add prices, quantities, PO number, delivery date, shipping)
- View own products (without financial data)
- Supplier line ownership verification server-side

### 12. PDF Documents & Email
- Branded PDFs with document logo, accent colours, company address
- Auto-contrast text colour for title and table headers
- SVG logo support (converted via sharp) with path traversal guard
- All routes `await drawHeader()` (async logo/address rendering)
- All template fields loaded: headerNote, footerNote, termsText, paymentTermsText, customFooter
- TO address renders on separate lines (not comma-separated)
- Custom footer per document type
- Department-specific contact email
- Totals aligned with table columns
- Templates: sales order, purchase order, invoice, packing slip, credit note, RFQ, manufacturing order
- **Email via SMTP**: nodemailer integration (lib/mailer.ts), sendSalesOrderEmail and sendInvoiceEmail with PDF attachments

### 13. Cron Endpoints
- `/api/cron/fx-rates` — daily FX rate update
- `/api/cron/activity-cleanup` — daily activity log purge
- `/api/cron/backup` — daily scheduled backup with retention + remote upload
- `/api/cron/wc-sync` — WooCommerce sync polling (every 5 min)
- `/api/cron/delivery-status` — delivery tracking status polling (every 15 min)
- All cron endpoints require CRON_SECRET or localhost

### 14. Security
- Cron endpoints require CRON_SECRET header or localhost origin
- Command injection fixed (exec → execFile in backup routes)
- Auth added to allocation, email, wc-sync server actions
- WC consumer secret masked on client
- Supplier line ownership verification
- Role input validation
- Timing-safe webhook HMAC verification (timingSafeEqual)
- Path traversal guard in PDF logo loading
