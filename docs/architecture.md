# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  LXC Container (Production)                                     │
│                                                                 │
│  ┌──────────┐    ┌─────────────────────────────────────────┐   │
│  │  nginx   │───▶│  Next.js 15 (App Router)                │   │
│  │ :80/:443 │    │  • Server Components (UI)               │   │
│  └──────────┘    │  • Route Handlers (REST API)            │   │
│                  │  • Auth.js (session management)         │   │
│                  └──────────────────┬────────────────────-─┘   │
│                                     │                           │
│                  ┌──────────────────▼──────────────────────┐   │
│                  │  BullMQ Worker Process                   │   │
│                  │  • FX rate refresh (hourly)             │   │
│                  │  • Xero journal sync (daily)            │   │
│                  │  • WooCommerce order poll (optional)    │   │
│                  └──────────────────┬───────────────────-──┘   │
│                                     │                           │
└─────────────────────────────────────┼───────────────────────────┘
                                      │
         ┌────────────────────────────┼──────────────────────┐
         │                            │                      │
         ▼                            ▼                      ▼
┌────────────────┐  ┌─────────────────────┐  ┌──────────────────┐
│  PostgreSQL    │  │  Redis LXC          │  │  External APIs   │
│  (database)   │  │  (BullMQ queues)    │  │  • WooCommerce   │
│               │  │                     │  │  • Xero (UK)     │
└────────────────┘  └─────────────────────┘  │  • FX Rates      │
                                              │  • SMTP          │
                                              └──────────────────┘
```

---

## Request Flow

### Web Request

```
Browser → nginx → Next.js Route Handler
                  ├── Auth.js: validate session cookie
                  ├── Zod: validate request body/params
                  ├── Prisma: query PostgreSQL
                  └── Response.json(...)
```

### WooCommerce Webhook

```
WooCommerce → nginx → /api/webhooks/woocommerce
                      ├── Verify HMAC signature (WC_WEBHOOK_SECRET)
                      ├── Parse payload (order.created / order.updated / etc.)
                      ├── Upsert SalesOrder + SalesOrderLines in DB
                      ├── Trigger stock movements if order completed/cancelled
                      └── Queue Xero COGS sync if applicable
```

### Background Job: FX Rate Refresh

```
BullMQ cron (hourly) → FX worker
  → exchangerate-api.com GET /latest/GBP
  → Upsert FxRate rows for all active currencies
  → Update cached rate in Redis (TTL: 1 hour)
```

### Background Job: Xero COGS Sync

```
BullMQ daily job → Xero worker
  → Fetch all CogsEntry rows with xeroSyncStatus = PENDING for yesterday
  → Group by date, aggregate by product/account
  → Build journal entry payload
  → POST to Xero Journals API
  → Mark CogsEntry rows as SYNCED
```

---

## Database Design

### Key design principles

**FIFO COGS** — Each goods receipt creates a `CostLayer`. Sales consume layers oldest-first (per product per warehouse) via `CogsEntry`. The FIFO engine in `lib/fifo/` is the single point of write for these tables.

**Multi-currency** — Every monetary record stores:
- `*Foreign` fields: amount in the original transaction currency
- `*Gbp` fields: GBP equivalent at the time of transaction
- `fxRateToGbp`: the rate used for conversion

This means historical reports always show correct figures, even if the FX rate has since changed.

**Landed costs** — A freight PO (type `FREIGHT`) is linked to a goods PO via `LandedCostLink`. When the goods PO is received, the FIFO engine adds the allocated landed cost to each `CostLayer.unitCostGbp`. The distribution method (by value / weight / quantity / equal split) is configurable per link.

**Stock transfers** — A `StockTransfer` with status `IN_TRANSIT` causes stock to be reserved (increments `StockLevel.reservedQty`) on the source warehouse, making it unavailable for new orders. On `COMPLETED`, stock is moved to the destination warehouse.

**Variable products** — `Product.type` differentiates:
- `SIMPLE`: standalone stockable product
- `VARIABLE`: parent grouping only — no stock, not orderable
- `VARIANT`: child of a `VARIABLE` parent — stockable, has its own SKU, maps to a WooCommerce variation ID
- `KIT`: virtual bundle whose components are deducted on sale (handled by the FIFO engine)

---

## Module Boundaries

| Module | Data owned | External dependencies |
|---|---|---|
| Inventory | `Product`, `StockLevel`, `CostLayer`, `CogsEntry` | WooCommerce (product import) |
| Purchase Orders | `PurchaseOrder`, `PurchaseOrderLine`, `LandedCostLink`, receipts, invoices, returns, `SupplierProduct` | SMTP (email), PDF renderer |
| Sales | `SalesOrder`, `SalesOrderLine`, `SalesOrderRefund` | WooCommerce (webhooks + API) |
| Stock Control | `StockTransfer`, `StockCount` | — |
| Manufacturing | `Bom`, `BomItem`, `Kit`, `KitItem`, `ProductionOrder` | — |
| Sync | `WcSyncLog`, `XeroSyncLog`, `XeroAccount` | WooCommerce API, Xero API, Redis |
| Auth | `User`, `Session` | — |
| Settings | `Organisation`, `Setting`, `Currency`, `FxRate`, `TaxRate`, `Warehouse` | FX API |
| Activity | `ActivityLog` | — |

---

## Authentication

Auth.js v5 with the **Credentials** provider:

1. User submits email + password
2. Server verifies `bcrypt` hash stored in `User.passwordHash`
3. If user has `totpEnabled = true`, a TOTP challenge is issued
4. On success, Auth.js creates a signed session cookie (JWT or database session)

TOTP uses the standard TOTP algorithm (RFC 6238, 30-second window). The `User.totpSecret` is stored encrypted. Compatible with any TOTP app (Google Authenticator, Authy, 1Password, etc.).

---

## Background Jobs

BullMQ queues run in a separate worker process (`workers/index.ts`), connected to the same PostgreSQL and Redis instances.

| Queue | Job | Trigger | Description |
|---|---|---|---|
| `fx` | `refresh-rates` | Hourly cron | Fetch latest rates from exchangerate-api.com |
| `wc` | `poll-orders` | Configurable cron | Poll WooCommerce for new orders (fallback if webhooks not used) |
| `wc` | `sync-stock` | On demand / scheduled | Push stock levels to WooCommerce |
| `xero` | `sync-cogs` | Daily cron | Push COGS journal entries to Xero |
| `xero` | `sync-po-invoice` | On PO invoice | Push PO invoice to Xero |

Jobs are retried with exponential backoff on failure. Failed jobs are visible in the Settings → Background Jobs UI.

---

## PDF Generation

PO and RFQ PDFs are generated server-side using `@react-pdf/renderer`. Templates live in `lib/pdf/`. PDFs are:

- Rendered to a `Buffer` in the route handler
- Either streamed directly as a download response, or
- Written to `PDF_TEMP_DIR` and attached to an email via Nodemailer

---

## Xero Integration

### Journal entry format

**COGS sync** — Daily accumulated journal per product category:
```
DR  Cost of Goods Sold account    (total COGS for the day)
CR  Inventory asset account       (same amount)
```

**PO Invoice sync** — One journal per PO invoice:
```
DR  Inventory asset account       (goods value, per line item)
CR  Accounts Payable account      (total invoice)
```

Account codes are mapped in Settings → Integrations → Xero. The Chart of Accounts is imported from Xero and stored in `XeroAccount`.

### Token management

Xero OAuth 2.0 tokens are stored in `XERO_TOKEN_PATH` (a JSON file). The worker automatically refreshes the access token using the refresh token before each API call. Refresh tokens expire after 60 days of non-use — reconnect via Settings if this occurs.

---

## WooCommerce Integration

### Stock sync (IMS → WooCommerce)

Stock levels are pushed per SKU. The quantity pushed is the **sum** of `StockLevel.quantity - StockLevel.reservedQty` across all warehouses flagged with `syncToWoocommerce = true`.

For `VARIANT` products: stock is pushed to the WooCommerce variation (`wcVariantId`).  
For `SIMPLE` products: stock is pushed to the WooCommerce product (`wcProductId`).

### Order sync (WooCommerce → IMS)

Orders are received via webhook. The IMS:
1. Verifies the HMAC signature using `WC_WEBHOOK_SECRET`
2. Maps WooCommerce product/variation IDs to IMS `Product` records by `wcProductId`/`wcVariantId`
3. Creates or updates a `SalesOrder` with all line items
4. Records the WooCommerce currency and converts amounts to GBP at the current FX rate

### Refund handling

When a WooCommerce refund webhook is received:
1. A `SalesOrderRefund` is created
2. The user is prompted (or the default return warehouse is used) to select the return warehouse
3. Stock is added back to the selected warehouse
4. COGS are reversed via the FIFO engine (re-adding the consumed cost layers)
