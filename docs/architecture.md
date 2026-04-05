# Architecture

## System Overview

```
+-----------------------------------------------------------------+
|  IMS Application Server (LXC Container)                         |
|                                                                 |
|  +----------+    +------------------------------------------+   |
|  |   OLS    |--->|  Next.js 16 (App Router)                 |   |
|  | :80/:443 |    |  - Server Components (UI)                |   |
|  +----------+    |  - Server Actions (mutations)            |   |
|                  |  - Route Handlers (API + PDF)            |   |
|                  |  - Auth.js (session management)          |   |
|                  +-------------------+----------------------+   |
|                                      |                          |
+--------------------------------------|---(cron: 06:00)----------+
                                       |       |
                      +----------------+-------+--------+
                      |                                 |
                      v                                 v
               +------------+                  +------------------+
               | PostgreSQL |                  | External APIs    |
               | (database) |                  | - WooCommerce    |
               +------------+                  | - Xero (UK)      |
                                               | - frankfurter.dev|
                                               | - SMTP           |
                                               +------------------+
```

### Infrastructure

- **OLS (OpenLiteSpeed)** at `10.0.3.12` acts as the reverse proxy, terminating SSL and forwarding requests to the Next.js process.
- **PostgreSQL** stores all application data (~40 models).
- The Next.js process runs on port 3000 (default) via PM2.
- A system cron job calls `/api/cron/fx-rates` daily at 06:00 to refresh exchange rates.

---

## Request Flow

### Web Request (Server Action)

```
Browser --> OLS --> Next.js Server Component
                   +-- Auth.js: validate session cookie
                   +-- Server Action: validate + mutate via Prisma
                   +-- revalidatePath / redirect
```

### API Route (PDF / Export / Cron)

```
Client --> OLS --> Next.js Route Handler (/api/...)
                  +-- Auth check (where applicable)
                  +-- Prisma query
                  +-- Response (JSON / PDF stream / CSV)
```

### FX Rate Cron

```
Daily cron (06:00) --> GET /api/cron/fx-rates
                       +-- Fetch rates from frankfurter.dev
                       +-- Upsert FxRate rows for all active currencies
```

---

## Database Design

### Core Principles

**FIFO COGS** -- Each goods receipt (purchase receive or opening stock) creates a `CostLayer` with a unit cost and remaining quantity. When stock is consumed (sale dispatch, adjustment, etc.), cost layers are consumed oldest-first per product per warehouse, creating `CogsEntry` records. This provides accurate historical cost tracking.

**Multi-currency** -- Every monetary record stores both foreign-currency and GBP amounts:
- `*Foreign` fields: amount in the transaction currency
- `*Gbp` fields: GBP equivalent at the time of transaction
- `fxRateToGbp`: the exchange rate used

Historical reports always show the correct figures regardless of current FX rates.

**Landed costs** -- A freight PO (`type = FREIGHT`) is linked to a goods PO via `LandedCostLink`. When the goods PO is received, landed costs are distributed across `CostLayer.unitCostGbp` values on each line. Distribution methods: by value, by weight, by quantity, or equal split. Retrospective recalculation is supported when freight costs arrive after goods receipt.

**Stock reservation** -- `StockLevel.reservedQty` tracks stock that is allocated but not yet dispatched. Transfers in `IN_TRANSIT` status reserve stock on the source warehouse.

**Discount storage** -- Discounts on sales orders and lines are stored separately as `discountStr` (the original input, e.g. "10%" or "5.00") and `discountAmount` (the computed value). Prices are never baked with discounts applied.

**Tax rate snapshotting** -- Sales orders store `taxRateName` and `taxRatePercent` at the time of creation, ensuring historical accuracy even if tax rates change later.

### Product Types

| Type | Description | Stockable | Has Components |
|---|---|---|---|
| `SIMPLE` | Standalone product | Yes | No |
| `VARIABLE` | Parent grouping for variants | No | No |
| `VARIANT` | Child of a VARIABLE parent, own SKU | Yes | No |
| `KIT` | Virtual bundle -- components deducted on sale | Calculated | Yes |
| `BOM` | Manufactured product -- stock exists after production | Yes | Yes |
| `NON_INVENTORY` | Service or fee -- not stock-tracked | No | No |

### Key Models (~40 total)

**Core Inventory:**
- `Product` -- all product types, with SKU, pricing, dimensions, weight, stock unit, images
- `ProductOption` -- variant options (e.g. Color, Size) with comma-separated values
- `ProductComponent` -- component list for KIT and BOM products
- `Warehouse` -- locations (STANDARD, QUARANTINE, RESTOCK types)
- `StockLevel` -- quantity and reserved quantity per product per warehouse
- `CostLayer` -- FIFO cost layers with received/remaining quantities and unit cost
- `CogsEntry` -- consumption records linking cost layers to stock movements
- `StockMovement` -- audit trail of all stock changes (receipts, dispatches, adjustments, transfers, production)

**Purchasing:**
- `Supplier`, `SupplierProduct` -- supplier catalog with per-supplier pricing
- `PurchaseOrder` -- GOODS or FREIGHT type, multi-status workflow
- `PurchaseOrderLine` -- line items with purchase unit conversion, tax, landed cost
- `PurchaseUnit` -- packaging-to-stock unit conversion (e.g. "Box of 100" = 100 pcs)
- `PurchaseReceipt`, `PurchaseReceiptLine` -- goods received records
- `PurchaseInvoice`, `PurchaseInvoiceLine` -- supplier invoice records with PDF upload
- `PurchaseReturn`, `PurchaseReturnLine` -- goods returned to supplier
- `LandedCostLink` -- links freight POs to goods POs
- `FreightCostLine` -- individual cost items on freight POs

**Sales:**
- `Customer` -- with billing/shipping addresses (JSON), tax number, WC customer ID
- `SalesOrder` -- full order with multi-currency totals, shipping, tax, discounts, notes
- `SalesOrderLine` -- line items with per-line discounts and tax
- `SalesOrderRefund`, `SalesOrderRefundLine` -- refunds with credit note numbers
- `Payment` -- payment records against orders or credit notes

**Stock Control:**
- `StockTransfer`, `StockTransferLine` -- inter-warehouse transfers
- `StockCount`, `StockCountLine` -- stock count/cycle count workflow

**Manufacturing:**
- `Bom`, `BomItem` -- bill of materials definitions
- `Kit`, `KitItem` -- virtual kit definitions
- `ProductionOrder` -- manufacturing order workflow

**Configuration:**
- `Organisation` -- company details, base currency, financial year
- `Setting` -- generic key/value store (JSON-encoded values)
- `Currency`, `FxRate` -- active currencies and historical exchange rates
- `TaxRate` -- VAT/GST rates with Xero tax type codes
- `AdjustmentReason` -- configurable stock adjustment reasons

**Auth and Audit:**
- `User` -- with roles (ADMIN, WAREHOUSE, FINANCE, READONLY) and optional TOTP 2FA
- `Session` -- session tokens
- `ActivityLog` -- full audit trail with entity type, action, metadata

**Integration:**
- `XeroAccount`, `XeroSyncLog` -- Xero chart of accounts and sync status
- `WcSyncLog` -- WooCommerce sync log (bidirectional)

---

## Module Boundaries

| Module | Server Actions | Data Owned | API Routes |
|---|---|---|---|
| Inventory | `products.ts` | Product, StockLevel, CostLayer, CogsEntry, StockMovement | `/api/export/products`, `/api/export/stock-levels` |
| Purchases | `purchase-orders.ts`, `suppliers.ts` | PurchaseOrder, PurchaseOrderLine, PurchaseReceipt, PurchaseInvoice, PurchaseReturn, Supplier, SupplierProduct, FreightCostLine, LandedCostLink, PurchaseUnit | `/api/rfq/[id]`, `/api/upload/invoice`, `/api/export/purchase-orders`, `/api/export/suppliers` |
| Sales | `sales.ts`, `customers.ts` | SalesOrder, SalesOrderLine, SalesOrderRefund, Payment, Customer | `/api/sales-order/[id]`, `/api/invoice/[id]`, `/api/export/sales`, `/api/export/contacts` |
| Stock Control | `stock.ts`, `transfers.ts` | StockTransfer, StockCount | `/api/export/adjustments`, `/api/export/transfers` |
| Settings | `settings.ts`, `currencies.ts` | Organisation, Setting, Currency, FxRate, TaxRate, Warehouse, AdjustmentReason | `/api/cron/fx-rates` |
| Import | `import.ts` | (writes to various tables) | -- |
| Auth | (Auth.js config) | User, Session | `/api/auth/[...nextauth]`, `/api/auth/totp`, `/api/auth/totp-setup` |

---

## Authentication

Auth.js v5 with the **Credentials** provider:

1. User submits email + password on the login page
2. Server verifies the `bcrypt` hash stored in `User.passwordHash`
3. If `User.totpEnabled = true`, a TOTP challenge screen is shown
4. On success, Auth.js creates a signed session cookie

TOTP uses the standard TOTP algorithm (RFC 6238, 30-second window). Compatible with any authenticator app (Google Authenticator, Authy, 1Password, etc.). Setup is available in the user profile page with QR code generation.

User roles: `ADMIN`, `WAREHOUSE`, `FINANCE`, `READONLY`.

---

## Background Tasks

There is no separate worker process. Background tasks are handled via HTTP endpoints triggered by system cron jobs.

| Task | Endpoint | Schedule | Description |
|---|---|---|---|
| FX rate refresh | `GET /api/cron/fx-rates` | Daily at 06:00 | Fetch latest rates from frankfurter.dev (free, no API key) and upsert FxRate rows for all active currencies |

The cron job is configured in the system crontab:

```cron
0 6 * * * curl -fsS http://localhost:3000/api/cron/fx-rates > /dev/null 2>&1
```

---

## PDF Generation

PDFs are generated server-side using **PDFKit** (configured as `serverExternalPackages: ['pdfkit']` in `next.config.ts`). The PDF system lives in `lib/pdf.ts` and provides:

- `getBranding()` -- reads company info and brand colors from the Organisation and Settings tables
- `createPdfDocument()` -- creates an A4 PDFDocument with standard margins and helpers
- Table drawing utilities for consistent formatting across document types

PDF types generated:
- **RFQ (Request for Quotation)** -- purchase order without prices, sent to suppliers
- **Purchase Order PDF** -- full PO with prices and terms
- **Sales Order PDF** -- order confirmation
- **Invoice PDF** -- customer invoice with auto-generated invoice numbers

PDFs are streamed directly as download responses from route handlers (`/api/rfq/[id]`, `/api/sales-order/[id]`, `/api/invoice/[id]`).

---

## CSV Import/Export

The system supports CSV import and export across multiple modules:

**Export routes** (all under `/api/export/`): products, stock-levels, adjustments, contacts, suppliers, sales, transfers, purchase-orders.

**Import features:**
- Product CSV import with two-pass processing (parents first, then variants/components)
- Stock adjustment CSV import (bulk adjustments)
- Customer CSV import/export
- Supplier CSV import

CSV utilities are in `lib/csv.ts`.

---

## Xero Integration

### Journal Entry Format

**COGS sync** -- Daily accumulated journal per product:
```
DR  Cost of Goods Sold    (total COGS for the day)
CR  Inventory Asset        (same amount)
```

**PO Invoice sync** -- One journal per purchase invoice:
```
DR  Inventory Asset        (goods value per line)
CR  Accounts Payable       (total invoice)
```

Account codes are mapped in Settings. The Xero Chart of Accounts is imported and stored in `XeroAccount`.

### Token Management

Xero OAuth 2.0 tokens are stored at `XERO_TOKEN_PATH` (JSON file). The access token is refreshed before each API call. Refresh tokens expire after 60 days of non-use.

---

## WooCommerce Integration

### Stock Sync (IMS to WooCommerce)

Pushed per SKU. The quantity is the sum of `StockLevel.quantity - StockLevel.reservedQty` across all warehouses where `syncToWoocommerce = true`.

### Order Sync (WooCommerce to IMS)

Orders arrive via webhook or polling. The system maps WooCommerce product/variation IDs to IMS products, creates or updates SalesOrder records, and converts amounts to GBP at the current FX rate.

### Refund Handling

Refunds create `SalesOrderRefund` records with credit note numbers. Stock is returned to the selected (or default) return warehouse, and COGS are reversed through the FIFO engine.
