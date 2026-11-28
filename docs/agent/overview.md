# Project structure, modules and data model (reference)

> Moved verbatim from CLAUDE.md. This is a snapshot and parts are out of date (for example the model count: `prisma/schema.prisma` is authoritative). Verify against the code before relying on a detail.

## Project Structure

```
onetwo3d-ims/
├── app/
│   ├── (auth)/               # Login, 2FA, passkey pages (public routes)
│   ├── (dashboard)/          # All authenticated pages (30+ modules)
│   │   ├── dashboard/
│   │   ├── inventory/        # Product management, stock levels
│   │   ├── stock-control/    # Transfers, adjustments, counts
│   │   ├── sales/            # Orders, shipments, invoices
│   │   ├── purchase-orders/  # POs, RFQs, suppliers
│   │   ├── manufacturing/    # Production orders, BOMs
│   │   ├── sync/             # WooCommerce, Xero integration
│   │   ├── analytics/        # Reports and forecasting
│   │   ├── settings/         # Company, users, integrations
│   │   ├── activity/         # Activity log (audit trail)
│   │   ├── profile/          # User profile and preferences
│   │   ├── supplier/         # Supplier portal (separate RBAC)
│   │   └── help/             # Help documentation portal
│   ├── actions/              # Server actions (business logic, 31+ files)
│   │   ├── products.ts       # Product CRUD, variants, BOMs
│   │   ├── sales.ts          # Sales order lifecycle, allocation, invoicing
│   │   ├── purchase-orders.ts # Purchase order workflow
│   │   ├── stock.ts          # Stock movements, adjustments
│   │   ├── transfers.ts      # Warehouse transfers
│   │   ├── manufacturing.ts  # Production orders
│   │   ├── wc-sync.ts        # WooCommerce order/product sync
│   │   ├── xero-sync.ts      # Xero integration, journal posting
│   │   ├── settings.ts       # Company, user, integration settings
│   │   └── [other actions]   # Email, auth, backup, permissions, etc.
│   ├── api/                  # API routes and webhooks
│   │   ├── auth/             # NextAuth routes, TOTP, passkey setup
│   │   ├── cron/             # Scheduled jobs
│   │   │   ├── fx-rates      # Daily FX rate refresh (source per fx_rate_source: ecb/frankfurter or aelia)
│   │   │   ├── wc-reconcile  # WooCommerce backup reconciliation (orders/products) plus stock retry drain
│   │   │   ├── accounting-daily-batch # Daily accounting sub-ledger batch sync (Xero)
│   │   │   ├── accounting-sync # Accounting sync-row processing (Xero)
│   │   │   ├── accounting-payment-poll # Payment status polling from Xero
│   │   │   ├── delivery-status # Update delivery status on SalesOrders
│   │   │   ├── activity-cleanup # Archive old activity logs
│   │   │   ├── backup        # Automated database backups
│   │   │   └── ...           # 38 routes in total; the scheduled ones are registered in lib/cron-jobs/
│   │   ├── webhooks/         # shopping/[connector] (WooCommerce order, product, refund webhooks) and mintsoft/asn-booked-in
│   │   ├── export/           # CSV exports (products, sales, POs, stock, etc.)
│   │   ├── import/           # CSV imports and historical order import
│   │   ├── invoice/          # Invoice PDF generation and preview
│   │   ├── packing-slip/     # Packing slip PDF (picking/packing checklist)
│   │   ├── sales-order/      # Sales order confirmation PDF
│   │   ├── rfq/              # RFQ PDF generation
│   │   ├── manufacturing-order/ # Production order PDF
│   │   ├── upload/           # Avatar, logo, invoice PDF uploads
│   │   ├── uploads/          # Serve uploaded branding/invoice files
│   │   ├── backup/           # Manual backup creation and restore
│   │   ├── accounting/       # Accounting connector OAuth callback (Xero)
│   │   ├── shopping/         # Connector-scoped routes (manual-sync, [connector]/invoice-pdf and credit-note-pdf)
│   │   ├── notifications/    # Email notification delivery
│   │   └── preview/          # Document preview (email templates, documents)
│   └── generated/prisma/     # Auto-generated Prisma client types
├── components/
│   ├── ui/                   # Shadcn/Base-UI primitives (20+ components)
│   │   ├── button.tsx, card.tsx, dialog.tsx, dropdown-menu.tsx
│   │   ├── input.tsx, select.tsx, table.tsx, skeleton.tsx, etc.
│   ├── layout/               # Sidebar, topbar, navigation, breadcrumbs
│   ├── inventory/            # Product-specific components (forms, lists)
│   ├── settings/             # Settings-specific components (forms)
│   ├── auth/                 # Login/auth/2FA/passkey components
│   ├── profile/              # User profile components
│   └── providers/            # Context providers (auth, theme, etc.)
├── lib/
│   ├── auth/                 # NextAuth.js configuration, session helpers
│   │   ├── config.ts         # NextAuth providers and callbacks
│   │   ├── server.ts         # requireAuth() helper
│   ├── db/                   # Prisma client singleton
│   ├── permissions.ts        # Role-based access control (RBAC) helpers
│   ├── activity-log.ts       # Audit trail logging
│   ├── mailer.ts             # Nodemailer SMTP configuration
│   ├── pdf.ts                # PDF generation with branding system
│   ├── csv.ts                # CSV parse and export utilities
│   ├── utils.ts              # Shared utility functions
│   ├── connectors/           # Integration modules
│   │   ├── woocommerce/      # WC sync logic, webhooks, tax mapping
│   │   │   ├── sync/         # Order/product sync engine (order-import.ts, product-sync.ts, reconcile.ts, ...)
│   │   │   ├── webhooks.ts   # Webhook parsing and validation
│   │   │   ├── tax-rate-plan.ts, tax-rate-writer.ts # WC tax rate handling
│   │   │   └── api.ts        # WC REST API client
│   │   ├── xero/             # Xero API, journal posting, reconciliation
│   │   │   ├── api.ts, auth.ts # Xero API client and OAuth
│   │   │   ├── sync-processor.ts, queue.ts # Accounting sync queue
│   │   │   ├── daily-sync.ts # Daily batch sync logic
│   │   │   └── payment-poller.ts, payment-reconcile.ts # Payment/invoice reconciliation
│   │   ├── mintsoft/, wms/   # Mintsoft connector and the connector-agnostic WMS boundary
│   └── [service files]       # Notifications, FX rates, tracking
├── prisma/
│   ├── schema.prisma         # Database schema (167 models)
│   ├── migrations/           # Migration history
│   ├── seed.ts               # Database seeding
│   └── unsupported-schema-drift-allowlist.json # Intentional DB-native drift
├── scripts/
│   ├── cli.ts                # CLI tool (create-user, etc.)
│   └── [deployment scripts]
├── public/                   # Static assets (favicon, branding)
├── docs/                     # Additional documentation
├── .env.example              # Template for environment variables
├── eslint.config.mjs         # ESLint configuration
├── tsconfig.json             # TypeScript strict mode
├── next.config.ts            # Next.js config (Tailwind 4 is configured in app/globals.css)
└── package.json              # Dependencies and scripts
```

## Architecture Overview

**One Two Inventory** is a modular, role-based inventory management platform with real-time financial integration:

### Core Modules

1. **Inventory Module** — Product master data with:
   - FIFO costing with multi-layer cost tracking per warehouse
   - Multi-warehouse stock with available/reserved/on-hand tracking
   - Product types: SIMPLE, VARIABLE (parent), VARIANT (child), KIT (virtual bundle), BOM (manufactured), NON_INVENTORY (service)
   - Real-time COGS calculation on stock movements
   - CSV import/export with BOM and variant support

2. **Order-to-Cash** — Sales order full lifecycle:
   - Workflow: DRAFT → PENDING_PAYMENT → ON_HOLD → PROCESSING → ALLOCATED → PICKING → PACKING → SHIPPED → COMPLETED/DELIVERED
   - Multi-warehouse auto-allocation with intelligent allocation rules
   - Shipment management with tracking
   - Auto/manual invoice generation (configurable trigger)
   - Payment tracking against invoices and credit notes
   - Multi-currency with VAT handling and order/line discounts
   - PDF generation and email delivery

3. **Procure-to-Pay** — Purchase order full lifecycle:
   - Workflow: DRAFT → RFQ_SENT → QUOTE_RECEIVED → PO_SENT → SHIPPED → PARTIALLY_RECEIVED → RECEIVED → INVOICED, plus CLOSED (including closed short), PARTIALLY_RETURNED, RETURNED and CANCELLED (`PurchaseOrderStatus` in `prisma/schema.prisma`)
   - Multi-currency at the order's stored rate (taken from the `fx_rates` table, fed per `fx_rate_source`: Aelia, or ECB via frankfurter.dev); per-event FX for receipts and bills is behind `purchase_event_fx_rates_enabled` (off, interlocked)
   - RFQ PDF generation and supplier management
   - Goods receipt with FIFO costing integration
   - Landed cost distribution (by value/weight/quantity/equal split)
   - Freight/cost POs linked to primary POs
   - Retrospective landed cost recalculation (updates FIFO layers and COGS); zero floor for supplier credits (floored part to COGS behind `landed_cost_floor_cogs_enabled`)
   - Receipts by hand, by WMS book-in and by Mintsoft align-up; GR/IR sub-ledger
   - Supplier bills (three-way match, net payable for reverse charge), supplier credit notes, returns to supplier

4. **Manufacturing** — Production order management:
   - Production order types: ASSEMBLY, DISASSEMBLY
   - BOM management with component allocation
   - Stock movements on completion (production receipts)
   - Links to sales orders for made-to-order workflows

5. **Integrations** — Connector modules for data sync:
   - **WooCommerce** — Order sync via webhooks (or polling), refund sync, product sync, IMS-to-store stock push, tax rate mapping to Xero
   - **Xero** — Daily batch journal entry posting, sales invoices, credit notes and bills, sub-ledger sync, COGS calculation, payment reconciliation; rate-limited at 950 calls per rolling 24 hours
   - **Mintsoft** (warehouse / 3PL, behind the connector-agnostic `lib/connectors/wms/` boundary) — order push, despatch poll, ASNs, returns inbox, stock sync and align
   - Every write toward these systems passes the outbound-write hold and the producer-side hold (`PRODUCER_HOLD_ENFORCED_DESTINATIONS`); the QuickBooks, Shopify and ShipHero connectors have been removed

6. **Financial Module** — Multi-currency and reporting:
   - Daily FX rates into `fx_rates`, from the source `fx_rate_source` selects (ECB via frankfurter.dev, or Aelia)
   - VAT handling (inclusive/exclusive) with named tax rates
   - Xero account mapping for stock, COGS, and revenue recognition
   - COGS/margin analytics and reporting
   - Cash bridge forecasting
   - Payment account mapping (payment method → bank account)

7. **Administration** — Multi-tenant roles and controls:
   - 6 RBAC roles: ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER (each with specific permissions)
   - Activity logging with searchable audit trail
   - Scheduled backups (local file or SFTP)
   - System settings (company info, integrations, preferences)
   - Email notifications for orders, shipments, sync events

### Data Flow

```
WooCommerce → IMS (allocate stock, reserve) → Shipments (track)
  ↓
Xero sub-ledger (batch sync daily) → Accounts (GL posting)
  ↓
FX rates (daily into `fx_rates`, per `fx_rate_source`: ECB via frankfurter.dev, or Aelia) → Multi-currency conversions
```

## Database

**170 Prisma models** (managed with migrations). The grouped lists below are a historical sketch: several names no longer exist (for example ProductVariant, Stock, Invoice/CreditNote, ManufacturingOrder, AccountingSync, the WooCommerce* and Xero* config/log models), so use `prisma/schema.prisma` for real names (StockLevel, ProductionOrder, AccountingSyncLog, ShoppingSyncLog, WmsSyncLog, PurchaseInvoice, ...):

**Product & Inventory:**
- Product, ProductVariant, ProductPrice, ProductBundle
- Stock, StockMovement, StockCount, StockTransfer, CostLayer

**Sales:**
- SalesOrder, SalesOrderLine, OrderAllocation, Shipment, ShipmentLine
- Invoice, InvoiceLine, CreditNote, CreditNoteLine, Payment, PaymentAllocation

**Purchases:**
- PurchaseOrder, PurchaseOrderLine, PurchaseReceipt, PurchaseReceiptLine
- SupplierRfq, PurchaseReturn, PurchaseReturnLine, Supplier

**Manufacturing:**
- ManufacturingOrder, ManufacturingOrderLine, Bom, BomItem

**Financials:**
- TaxRate, Currency, FxRate, LandedCost, CostLine
- AccountingSync (journal entries, COGS tracking)

**Integrations:**
- Shopping (WooCommerce): ShoppingSyncLog, ShoppingWebhookEvent, ShoppingOrderLink, ShoppingProductLink, ShoppingCustomerLink, ShoppingTaxRateMapping, ShoppingStatusMapping
- Accounting (Xero): AccountingSyncLog, AccountingEvent, AccountingToken, AccountingAccount, XeroTaxRate, XeroPaymentMatch
- Warehouse (Mintsoft): WmsConnection, ExternalWmsBinding, WmsOrderPushLink, WmsAsnMap, WmsProductLink, WmsReturnsInbox, WmsStockDiscrepancy, WmsSyncJob

**Administration:**
- User, Role, Session (NextAuth)
- Setting, ActivityLog, AuditTrail, Notification
- DocumentTemplate, AdjustmentReason, PurchaseUnit, Warehouse

See `@prisma/schema.prisma` for complete schema with relationships and constraints.

## Key Modules & Responsibilities

| Module | Location | Purpose | Owner |
|--------|----------|---------|-------|
| **Product Management** | `app/actions/products.ts`, `components/inventory/` | CRUD for products, variants, BOMs, pricing, stock units | Inventory team |
| **Stock Control** | `app/actions/stock.ts`, `app/(dashboard)/stock-control/` | Adjustments, transfers, counts, movements, audit | Warehouse team |
| **Sales Orders** | `app/actions/sales.ts`, `app/(dashboard)/sales/` | Order workflow, allocation, shipment, invoicing, credit notes | Sales team |
| **Purchase Orders** | `app/actions/purchase-orders.ts`, `app/(dashboard)/purchase-orders/` | PO creation, RFQ, receipt, landed costs, returns | Procurement team |
| **Manufacturing** | `app/actions/manufacturing.ts`, `app/(dashboard)/manufacturing/` | Production orders, BOM, component allocation, output | Production team |
| **WooCommerce Sync** | `lib/connectors/woocommerce/`, `app/actions/wc-sync.ts` | Order/product sync, tax mapping, webhooks, cron polling | Dev team |
| **Xero Integration** | `lib/connectors/xero/`, `app/actions/xero-sync.ts` | Sub-ledger batch sync, journal posting, COGS, reconciliation | Finance/Dev team |
| **Authentication** | `lib/auth/`, `app/(auth)/`, `app/actions/passkey.ts`, `app/actions/password-reset.ts`, `app/actions/users.ts` | Login, 2FA, passkeys, roles, sessions, RBAC | Dev team |
| **PDF Generation** | `lib/pdf.ts`, `app/api/*/[id]/route.ts` | Branded PDFs (order, invoice, RFQ, PO, shipment) | Dev team |
| **Notifications** | `lib/mailer.ts`, `app/api/notifications/` | Email delivery, notification history, preferences | Dev team |
| **Activity Log** | `lib/activity-log.ts`, `app/(dashboard)/activity/` | Audit trail, searchable logs, compliance | Compliance team |
| **Settings** | `app/(dashboard)/settings/`, `app/actions/settings.ts` | Company config, users, integrations, backup, tax rates | Admin |

