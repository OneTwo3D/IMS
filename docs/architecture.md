# Architecture

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) with Server Components and Server Actions |
| Database | PostgreSQL via Prisma 7 ORM |
| Authentication | NextAuth v5 (Auth.js) with JWT sessions, credentials + passkey (WebAuthn) providers |
| PDF Generation | PDFKit with sharp for SVG-to-PNG conversion |
| Email | nodemailer (SMTP) |
| Charts | Recharts |
| Styling | TailwindCSS 4 |
| Process Manager | PM2 |
| Reverse Proxy | nginx |


## System Overview

```
+-----------------------------------------------------------------+
|  Application Server                                             |
|                                                                 |
|  +----------+    +------------------------------------------+   |
|  |  nginx   |--->|  Next.js 16 (App Router)                 |   |
|  | :80/:443 |    |  - Server Components (UI)                |   |
|  +----------+    |  - Server Actions (mutations)            |   |
|                  |  - Route Handlers (API + PDF)            |   |
|                  |  - Auth.js v5 (session management)       |   |
|                  +-------------------+----------------------+   |
|                                      |                          |
+--------------------------------------|---(cron: 02:00/03:00/06:00)--+
                                       |       |
                      +----------------+-------+--------+
                      |                                 |
                      v                                 v
               +------------+                  +------------------+
               | PostgreSQL |                  | External APIs    |
               | (database) |                  | - WooCommerce    |
               +------+-----+                  | - Xero (UK)     |
                      |                        | - frankfurter.dev|
               +------+-----+                  | - SMTP           |
               |   Redis    |                  +------------------+
               |  (cache)   |
               +------------+
```


## Key Directories

| Directory | Purpose |
|---|---|
| `app/actions/` | Server Actions — all data mutations (products, sales, purchases, stock, settings, etc.) |
| `app/api/` | API Route Handlers — PDF generation, CSV export, cron endpoints, file uploads, webhooks |
| `components/` | React components organised by module (auth, inventory, layout, profile, settings, ui) |
| `lib/` | Shared utilities — database client, PDF generation, email templates, CSV handling, activity logging |
| `lib/connectors/` | External system connectors (WooCommerce, with interfaces for Shopify, Xero, QuickBooks) |
| `lib/connectors/woocommerce/` | WooCommerce connector module — order import, status sync, refund sync, product sync, stock sync |
| `prisma/` | Database schema, migrations, and seed data |
| `docs/` | User-facing documentation (rendered in the app) |
| `scripts/` | Installation and maintenance scripts |
| `public/uploads/` | User-uploaded files (branding, avatars) |


## Request Flow

### Web Request (Server Action)

```
Browser --> nginx --> Next.js Server Component
                    +-- Auth.js: validate JWT session
                    +-- Server Action: validate + mutate via Prisma
                    +-- revalidatePath / redirect
```

### API Route (PDF / Export / Cron)

```
Client --> nginx --> Next.js Route Handler (/api/...)
                   +-- Auth check (where applicable)
                   +-- Prisma query
                   +-- Response (JSON / PDF stream / CSV)
```


## Database Design

### Core Principles

**FIFO COGS** — Each goods receipt (purchase receive or opening stock) creates a `CostLayer` with a unit cost and remaining quantity. When stock is consumed (sale dispatch, adjustment, etc.), cost layers are consumed oldest-first per product per warehouse, creating `CogsEntry` records.

**Multi-currency** — Every monetary record stores both foreign-currency and GBP amounts:
- `*Foreign` fields: amount in the transaction currency
- `*Gbp` fields: GBP equivalent at the time of transaction
- `fxRateToGbp`: the exchange rate used

**Landed costs** — A freight PO (`type = FREIGHT`) is linked to a goods PO via `LandedCostLink`. When the goods PO is received, landed costs are distributed across cost layers. Distribution methods: by value, by weight, by quantity, or equal split.

**Stock reservation** — `StockLevel.reservedQty` tracks stock that is allocated but not yet dispatched. Transfers in `IN_TRANSIT` status reserve stock on the source warehouse.

**Discount storage** — Discounts are stored separately as `discountStr` (the original input) and `discountAmount` (the computed value). Prices are never baked with discounts applied.

**Tax rate snapshotting** — Sales orders store `taxRateName` and `taxRatePercent` at creation time, ensuring historical accuracy if tax rates change later.

**Key-value settings store** — The `Setting` model provides a generic key-value store with JSON-encoded values for all application configuration that does not warrant its own table.

### Product Types

| Type | Description | Stockable | Has Components |
|---|---|---|---|
| `SIMPLE` | Standalone product | Yes | No |
| `VARIABLE` | Parent grouping for variants | No | No |
| `VARIANT` | Child of a VARIABLE parent, own SKU | Yes | No |
| `KIT` | Virtual bundle — components deducted on sale | Calculated | Yes |
| `BOM` | Manufactured product — stock exists after production | Yes | Yes |
| `NON_INVENTORY` | Service or fee — not stock-tracked | No | No |

### Key Models (30+)

**Core Inventory:**
- `Product` — all product types, with SKU, pricing, dimensions, weight, stock unit, images, HS code, country of origin
- `ProductOption` — variant options (e.g. Colour, Size) with comma-separated values
- `ProductComponent` — component list for KIT and BOM products
- `Warehouse` — locations (STANDARD, QUARANTINE, RESTOCK types)
- `StockLevel` — quantity and reserved quantity per product per warehouse
- `CostLayer` — FIFO cost layers with received/remaining quantities and unit cost
- `CogsEntry` — consumption records linking cost layers to stock movements
- `StockMovement` — audit trail of all stock changes

**Purchasing:**
- `Supplier`, `SupplierProduct` — supplier catalogue with per-supplier pricing
- `PurchaseOrder` — GOODS or FREIGHT type, multi-status workflow
- `PurchaseOrderLine` — line items with purchase unit conversion, tax, landed cost
- `PurchaseUnit` — packaging-to-stock unit conversion
- `PurchaseReceipt`, `PurchaseReceiptLine` — goods received records
- `PurchaseInvoice`, `PurchaseInvoiceLine` — supplier invoice records with PDF upload
- `PurchaseReturn`, `PurchaseReturnLine` — goods returned to supplier
- `LandedCostLink`, `FreightCostLine` — landed cost tracking

**Sales:**
- `Customer` — with billing/shipping addresses, tax number
- `SalesOrder`, `SalesOrderLine` — orders with multi-currency totals, shipping, tax, discounts
- `OrderAllocation` — per-line, per-warehouse stock allocation records
- `Shipment`, `ShipmentLine` — multi-warehouse shipments with independent tracking and carrier
- `SalesOrderRefund`, `SalesOrderRefundLine` — refunds with credit note numbers
- `Payment` — payment records against orders or credit notes

**Stock Control:**
- `StockTransfer`, `StockTransferLine` — inter-warehouse transfers
- `StockCount`, `StockCountLine` — stock count/cycle count workflow

**Manufacturing:**
- `Bom`, `BomItem` — bill of materials definitions
- `Kit`, `KitItem` — virtual kit definitions
- `ProductionOrder` — manufacturing order workflow

**Configuration:**
- `Organisation` — company details, base currency, financial year
- `Setting` — generic key/value store (JSON-encoded values)
- `Currency`, `FxRate` — active currencies and historical exchange rates
- `TaxRate` — VAT/GST rates with Xero tax type codes
- `AdjustmentReason` — configurable stock adjustment reasons

**Auth and Audit:**
- `User` — with roles (ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER), optional TOTP 2FA, passkey support
- `Notification` — per-user or broadcast notifications with type (info/success/warning/error), read tracking, and optional action URLs
- `ActivityLog` — full audit trail with entity type, action, level, tag, and metadata

**Integration:**
- `XeroAccount`, `XeroSyncLog` — Xero chart of accounts and sync status
- `WcSyncLog` — WooCommerce sync log
- `WcStatusMapping` — bidirectional WC-to-IMS status mapping (with seeded defaults)
- `WcTaxClassMapping` — WC tax class to IMS TaxRate mapping
- `ShippingCarrier` — configurable shipping carriers with tracking URLs


## Module Boundaries

| Module | Server Actions | API Routes |
|---|---|---|
| Inventory | `products.ts` | `/api/export/products`, `/api/export/stock-levels` |
| Purchases | `purchase-orders.ts`, `suppliers.ts` | `/api/rfq/[id]`, `/api/upload/invoice`, `/api/export/purchase-orders`, `/api/export/suppliers` |
| Sales | `sales.ts`, `customers.ts`, `allocation.ts` | `/api/sales-order/[id]`, `/api/invoice/[id]`, `/api/export/sales`, `/api/export/contacts` |
| Stock Control | `stock.ts`, `transfers.ts` | `/api/export/adjustments`, `/api/export/transfers` |
| Manufacturing | `manufacturing.ts` | `/api/manufacturing-order/[id]` |
| Settings | `settings.ts`, `company.ts`, `currencies.ts` | `/api/cron/fx-rates` |
| Import | `import.ts`, `wc-import.ts` | `/api/import/` |
| Integrations | `wc-sync.ts` | `/api/webhooks/shopping/orders`, `/api/webhooks/shopping/refunds`, `/api/webhooks/shopping/products`, `/api/cron/wc-reconcile`, `/api/cron/delivery-status` |
| Auth | `profile.ts`, `passkey.ts`, `users.ts` | `/api/auth/[...nextauth]`, `/api/auth/totp`, `/api/auth/totp-setup` |
| Dashboard | `dashboard.ts` | — |
| Analytics | `sales-stats.ts`, `purchase-stats.ts`, `inventory-stats.ts`, `forecasting.ts` | — |
| Backup | `backup.ts` | `/api/backup/`, `/api/cron/backup` |
| Activity Log | `activity-log.ts` | `/api/cron/activity-cleanup` |


## Authentication

Auth.js v5 with two providers:

### Credentials Provider
1. User submits email + password on the login page
2. Server verifies the bcrypt hash stored in `User.passwordHash`
3. If `User.totpEnabled = true`, a TOTP challenge screen is shown
4. On success, Auth.js creates a signed JWT session cookie (30-day expiry)

### Passkey Provider (WebAuthn)
1. User clicks "Sign in with Passkey" on the login page
2. Browser performs WebAuthn authentication with a registered credential
3. Server verifies the assertion against stored public keys
4. Session is created without requiring TOTP (passkey is already strong authentication)

User roles: `ADMIN`, `MANAGER`, `WAREHOUSE`, `FINANCE`, `READONLY`, `SUPPLIER`.

A permission system (`lib/permissions.ts`) controls sidebar visibility and server action authorisation per role. Supplier users are linked to a supplier company and access a dedicated portal.


## Background Tasks

There is no separate worker process. Background tasks are handled via HTTP endpoints triggered by system cron jobs.

| Task | Endpoint | Schedule | Description |
|---|---|---|---|
| FX rate refresh | `GET /api/cron/fx-rates` | Daily 06:00 | Fetch rates from frankfurter.dev and upsert FxRate rows |
| Activity cleanup | `GET /api/cron/activity-cleanup` | Daily 03:00 | Purge activity log entries past retention |
| Scheduled backup | `GET /api/cron/backup` | Daily 02:00 | Create backup, apply retention, upload to remote storage |
| WooCommerce reconcile | `GET /api/cron/wc-reconcile` | Daily | Backup reconciliation for WooCommerce orders/products plus stock catch-up and queued retry draining |
| Delivery status | `GET /api/cron/delivery-status` | Every 15 min | Poll delivery tracking providers for shipment status updates |

All cron endpoints require the `CRON_SECRET` header or a request from localhost for security.


## PDF Generation

PDFs are generated server-side using PDFKit (configured as `serverExternalPackages` in `next.config.ts`). The PDF system lives in `lib/pdf.ts` and provides:

- `getBranding()` — reads company info, logos, and brand colours from the Organisation and Settings tables
- `createPdfDocument()` — creates an A4 PDFDocument with standard margins and helpers
- `drawHeader()` — async function for rendering the document header with logo and addresses (all routes now correctly `await` this call)
- Table drawing utilities for consistent formatting across document types
- SVG logo conversion via sharp, with path traversal guard on logo file loading
- Auto-contrast text colour calculation
- All template fields loaded: headerNote, footerNote, termsText, paymentTermsText, customFooter
- TO address renders on separate lines (not comma-separated)

### Email Sending

Outbound email is handled by `lib/mailer.ts` using nodemailer:

- SMTP configuration from Settings (host, port, security, credentials)
- `sendSalesOrderEmail()` — sends sales order PDF as attachment
- `sendInvoiceEmail()` — sends invoice PDF as attachment
- Email buttons in the UI send via SMTP server-side (not mailto links)

PDF types: Sales Order, Purchase Order, Invoice, Packing Slip, Credit Note, RFQ, Manufacturing Order.

PDFs are streamed directly as responses from route handlers.


## CSV Import/Export

**Export routes** (under `/api/export/`): products, stock-levels, adjustments, contacts, suppliers, sales, transfers, purchase-orders.

**Import features:**
- Product CSV import with two-pass processing (parents first, then variants/components)
- Stock adjustment CSV import
- Customer and supplier CSV import

CSV utilities are in `lib/csv.ts`.


## External Integrations

### Xero

Xero integration is implemented as a modular connector in `lib/connectors/xero/`, fully independent of any shopping channel module.

- **Sub-ledger model** — IMS acts as accounting guard; Xero handles invoicing, payments, and bank reconciliation; IMS creates daily correction journals
- **Sales invoices** — AUTHORISED (WC pre-paid) or DRAFT (manual) invoice created at order time, with automatic Xero payment registration
- **Purchase bills** — pushed when a PO is invoiced, with optional supplier invoice PDF attachment
- **Credit notes** — pushed on refund with sub-ledger state-aware reversal journals
- **Daily batch sync** — nightly cron runs Group A1 (revenue deferral), A2 (inventory reclassification), B (shipment COGS + revenue recognition via FIFO cost layer consumption)
- **Payment polling** — 15-min cron detects paid invoices (manual orders) and paid bills (POs) via Xero API
- **Invoice PDF** — downloaded from Xero, saved locally, emailed to customer, download link pushed to WC order
- **Payment method mapping** — composite `{method}:{currency}` key maps to Xero bank account codes
- **OAuth 2.0** — tokens stored at `XERO_TOKEN_PATH`, refreshed before each API call
- **Deep links** — "View in Xero" links on sales order and PO detail pages

### WooCommerce

WooCommerce integration is implemented as a modular connector in `lib/connectors/woocommerce/`, following the shared `ShoppingConnector` and `AccountingConnector` interfaces.

- **Order import** — webhook-first via `/api/webhooks/shopping/orders`, with `/api/cron/wc-reconcile` as backup reconciliation
- **Status sync** — bidirectional mapping between WC and IMS statuses (configurable via `WcStatusMapping` with seeded defaults matching WC flowchart)
- **Refund sync** — creates refund records with credit notes and COGS reversal, via webhook (`/api/webhooks/shopping/refunds`)
- **Product sync** — bidirectional product data sync via webhook (`/api/webhooks/shopping/products`), including prices, dimensions, weight, GTIN/EAN (`global_unique_id`), HS code, and country of origin from WC product attributes
- **Stock sync** — IMS to WC, pushed immediately from IMS changes with daily forced stock catch-up and queued retry draining in the reconcile cron; optional COGS sync toggle
- **Tax class mapping** — maps WC tax classes to IMS TaxRate records
- **Completion flow** — WC completed status triggers auto-allocation, shipment creation with tracking
- **Webhook security** — HMAC verification using timing-safe comparison (`timingSafeEqual`)

### Integrations Dashboard

The `/sync` page provides a unified view of all connectors:

- **WooCommerce** — connection settings, order/product/stock sync config, tax mapping, status mapping, sync log
- **Xero** — OAuth connection, account mapping, transaction type toggles, sub-ledger settings, payment method mapping, sync log
- **Shopify** — tile shown (coming soon)
- **QuickBooks** — tile shown (coming soon)
- **REST API** — tile with endpoint documentation
