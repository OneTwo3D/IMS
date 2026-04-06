# Architecture

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) with Server Components and Server Actions |
| Database | PostgreSQL via Prisma 7 ORM |
| Authentication | NextAuth v5 (Auth.js) with JWT sessions, credentials + passkey (WebAuthn) providers |
| PDF Generation | PDFKit with sharp for SVG-to-PNG conversion |
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
- `Product` — all product types, with SKU, pricing, dimensions, weight, stock unit, images
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
- `User` — with roles (ADMIN, WAREHOUSE, FINANCE, READONLY), optional TOTP 2FA, passkey support
- `ActivityLog` — full audit trail with entity type, action, level, tag, and metadata

**Integration:**
- `XeroAccount`, `XeroSyncLog` — Xero chart of accounts and sync status
- `WcSyncLog` — WooCommerce sync log


## Module Boundaries

| Module | Server Actions | API Routes |
|---|---|---|
| Inventory | `products.ts` | `/api/export/products`, `/api/export/stock-levels` |
| Purchases | `purchase-orders.ts`, `suppliers.ts` | `/api/rfq/[id]`, `/api/upload/invoice`, `/api/export/purchase-orders`, `/api/export/suppliers` |
| Sales | `sales.ts`, `customers.ts` | `/api/sales-order/[id]`, `/api/invoice/[id]`, `/api/export/sales`, `/api/export/contacts` |
| Stock Control | `stock.ts`, `transfers.ts` | `/api/export/adjustments`, `/api/export/transfers` |
| Manufacturing | `manufacturing.ts` | `/api/manufacturing-order/[id]` |
| Settings | `settings.ts`, `company.ts`, `currencies.ts` | `/api/cron/fx-rates` |
| Import | `import.ts`, `wc-import.ts` | `/api/import/` |
| Auth | `profile.ts`, `passkey.ts` | `/api/auth/[...nextauth]`, `/api/auth/totp`, `/api/auth/totp-setup` |
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

User roles: `ADMIN`, `WAREHOUSE`, `FINANCE`, `READONLY`.


## Background Tasks

There is no separate worker process. Background tasks are handled via HTTP endpoints triggered by system cron jobs.

| Task | Endpoint | Schedule | Description |
|---|---|---|---|
| FX rate refresh | `GET /api/cron/fx-rates` | Daily 06:00 | Fetch rates from frankfurter.dev and upsert FxRate rows |
| Activity cleanup | `GET /api/cron/activity-cleanup` | Daily 03:00 | Purge activity log entries past retention |
| Scheduled backup | `GET /api/cron/backup` | Daily 02:00 | Create backup, apply retention, upload to remote storage |


## PDF Generation

PDFs are generated server-side using PDFKit (configured as `serverExternalPackages` in `next.config.ts`). The PDF system lives in `lib/pdf.ts` and provides:

- `getBranding()` — reads company info, logos, and brand colours from the Organisation and Settings tables
- `createPdfDocument()` — creates an A4 PDFDocument with standard margins and helpers
- Table drawing utilities for consistent formatting across document types
- SVG logo conversion via sharp
- Auto-contrast text colour calculation

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
- Purchase invoice sync — one journal per invoice (DR Inventory Asset, CR Accounts Payable)
- COGS sync — daily accumulated journal per product (DR COGS, CR Inventory Asset)
- OAuth 2.0 tokens stored at `XERO_TOKEN_PATH`, refreshed before each API call

### WooCommerce
- Stock sync (IMS to WC) — pushed per SKU across sync-enabled warehouses
- Order sync (WC to IMS) — via webhook or polling, with FX conversion
- Refund handling — creates refund records with credit notes and COGS reversal
