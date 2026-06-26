# onetwoInventory

Inventory Management System — built with Next.js 16, TypeScript, Prisma 7, PostgreSQL, and Shadcn/UI.

**Current release: v2.0.0** (2026-06-12) — major release covering VAT/tax profiles, bidirectional Xero invoice & TaxRate sync, manufacturing-aware reorder planning, end-to-end Decimal precision across landed cost / allocation / refund / COGS, and hardened cron + webhook authentication. See [CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/OneTwo3D/IMS/releases) for the full delta; the in-app **Settings > System** page shows the same notes.

## Features

### Inventory
- Product management (SIMPLE, VARIABLE, VARIANT, KIT, BOM, NON_INVENTORY)
- Stock levels per warehouse with available/reserved/on-hand tracking
- FIFO cost layers with weighted average COGS
- Product stock units (pcs, m, kg, etc.) with purchase unit conversion
- CSV import/export with BOM, variant, and bundle support

### Stock Control
- Bulk stock adjustments with configurable reasons (linked to Xero accounts)
- Warehouse transfers with stock booking
- Stock level export per warehouse with multi-select filter

### Purchases
- Multi-currency purchase orders with live FX rates (ECB via frankfurter.dev)
- VAT handling (inclusive/exclusive) with named tax rates and per-component breakdowns
- Landed cost distribution (by value/weight/quantity/equal split) per cost line
- Purchase units with stock unit conversion (e.g. 1 roll = 1000m)
- Freight/landed cost POs linked to multiple primary POs
- Retrospective landed cost recalculation (updates FIFO cost layers and COGS)
- RFQ PDF generation, goods receipt, supplier returns
- Unpaid bill edit from the PO detail page, with overbilling guards and the latest FX rate; if the bill has already pushed to Xero the edit syncs back as a `PURCHASE_INVOICE_UPDATE`
- DRAFT PO currency/rate edits rebase header + lines + freight cost lines inside a single transaction
- Supplier management with default currency, tax rate, and payment terms

### Sales
- Sales orders with shipment-first fulfillment and shipment status progression
- Multi-currency with VAT, line/order discounts (% or absolute), shipping fees
- Customer contacts with billing/shipping addresses and tax numbers
- Component-aware stock allocation for kits / bundles, including bundle refunds and COGS reversal support
- Allocation now distinguishes physical reservations from backorder demand; activity logs include the backorder breakdown
- Stock reservation on allocation, release on ship/cancel/refund
- Invoice generation (manual, auto on ship, or auto on paid — configurable)
- Edits to invoices that have already pushed to Xero sync back as `SALES_INVOICE_UPDATE` (QuickBooks logs an explicit "not supported" warning)
- Payment tracking against invoices and credit notes
- Automatic credit note numbers on refund
- Order and invoice PDF generation, SMTP email, and packing slips
- Clone, delete (pending only), column picker (COGS, margin, qty on hand, etc.)
- Sales representative assignment, delivery dates

### Manufacturing
- BOM (multi-component) and KIT (bundled) product types with optional manufacturer (Supplier acting as co-packer)
- Production orders: DRAFT → IN_PROGRESS → COMPLETED, with planned vs produced quantities
- WIP and cost-layer timing align with finance expectations (FIFO consumption of components, output cost layer on completion)
- ManufacturingCostLine for labour / machine time / overhead spread across produced units, with foreign-currency cost lines (own FX rate per production order)
- Component shortage report drives raw-material demand into Reorder Planning

### Analytics
- VAT report groups by side / reporting category / jurisdiction / tax rate, with a category filter (DOMESTIC / REVERSE_CHARGE / EC_SALES / OSS) that round-trips via the URL
- AR / AP aging with configurable buckets, FX gain/loss (realised + unrealised), currency summary
- Reorder Planning: demand-driven replenishment that now covers manufactured goods. BOM rows show the most recent manufacturer (or "Manufactured in-house") and raw materials inherit demand from their parent BOMs with a "Needed for" column. One-click "Generate POs + draft MOs for visible rows" creates draft orders by product type
- Sales analytics, customer mix, margin, returns, fulfillment, throughput
- Procurement analytics: open POs, supplier on-time, PPV, spend, lead times
- Inventory valuation, COGS, landed cost, inventory turnover with GL variance against Xero Trial Balance snapshots
- Production variance and WIP for manufacturing
- All report descriptions and methodology notices live behind a single (i) tooltip next to the title

### Settings
- VAT rate profiles in **Accounting**: ordered components, compound math, reverse-charge flag, reporting category. Connector-specific reverse-charge tax-type codes for the Xero swap
- Multi-component VAT rates auto-sync to Xero TaxRates via the `TaxComponents` API on save (idempotent by `Name`); QBO logs a clear "not supported" warning
- Currencies and FX rates with daily auto-fetch cron
- Landed cost distribution method default
- Invoice generation trigger (manual/on shipped/on paid)
- Purchase units with stock unit conversion
- Stock adjustment reasons with Xero account mapping
- Integration connection-test gate: Xero / WooCommerce / Mintsoft / SMTP must pass a connection test before sync can be enabled; the test result, timestamp, and configuration fingerprint are persisted and re-checked on save

### Integrations
- **Xero** — bidirectional accounting sync: AUTHORISED or DRAFT invoices at order time, `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` on edits, daily batch sub-ledger journals (Group A1 / A2 / B), credit notes on refund with sub-ledger-aware reversal journals, payment polling, deep links from SO/PO detail pages, optional invoice PDF attachment. Failed updates surface as an amber alert on the related order/PO
- **Xero TaxRate sync** — multi-component IMS `TaxRate` rows auto-push to Xero with the matching `TaxComponents` so the VAT return picks up the breakdown
- **WooCommerce** — webhook or polling order import with multi-currency support, tax-class mapping, refund reversal, product sync, and stock push-back. Pending-FX queue retries store the full WC order snapshot for deterministic replay
- **WMS / 3PL (Mintsoft)** — a connector-agnostic WMS boundary (a generic connector contract behind dispatch facades, CI-guarded so no core flow hard-codes a vendor) with Mintsoft as the first connector. Outbound order-dispatch push (Phase 8): paid, ready-to-fulfil orders for WMS-bound warehouses are pushed to the WMS on a sweep, with courier mapping, idempotent create/update, hold/cancel propagation, and dead-letter retry; a live order-status chip on sales orders (cached sweep + on-demand refresh, deep-linked to the WMS admin). Plus outbound stock-sync + ASN booked-in webhooks with HMAC-bound freshness timestamp, durable-persistence ack before responding, configurable sweeper, and queryable retry state; bundle/product verification crons keep IMS in sync with 3PL inventory. See `docs/mintsoft.md` and `docs/wms-connector-boundary.md`
- **QuickBooks** — invoice push, credit notes, daily batch sync; invoice update + TaxRate sync log "not supported" instead of silently failing
- **SMTP** — outbound document delivery (orders, invoices, packing slips, notifications) with configurable from-name / from-email and per-department reply-to addresses

### CSV Import/Export
- Products (with BOMs, variants, bundles, components)
- Contacts/Customers, Suppliers
- Sales Orders, Purchase Orders
- Stock Adjustments, Warehouse Transfers
- Stock Levels (per warehouse, multi-select filter)

### PDF Generation
- PDFKit-based (pure Node.js, no browser dependency)
- Shared branding system (company details, primary/accent colours)
- RFQ, sales order confirmation, invoice PDFs

## Tech Stack

- **Framework**: Next.js 16 (App Router, Server Components, Server Actions, Turbopack)
- **Database**: PostgreSQL with Prisma 7 ORM
- **UI**: Shadcn/UI with base-ui primitives, Tailwind CSS, Lucide icons
- **PDF**: PDFKit (server-external package)
- **FX Rates**: frankfurter.dev API (free, ECB data, no API key)
- **Auth**: NextAuth.js with TOTP 2FA support

## Quick Start

```bash
npm install
cp .env.example .env    # edit with your database URL and CRON_SECRET
npx prisma migrate deploy && npx prisma generate
npm run cli -- create-user
npm run dev              # development
npm run build && npm start  # production
```

After the dev server starts, log in as the user you just created. The first visit redirects to `/onboarding` — the setup wizard walks you through company details, currency, integrations, and product import. See the [Setup Wizard Walkthrough](help-docs/onboarding-walkthrough.md) for what each step does.

For production deployments, also configure:

- **CRON_SECRET** — required for the scheduled-job endpoints to authenticate (the system fails fast on startup if unset in production).
- **Backup cron** — schedule `/api/cron/backup` daily; see [Backup & Restore](docs/backup-restore.md).
- **Multi-instance rate limits** — set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL` if running multiple replicas.

The [Installation & Deployment](docs/installation.md) guide covers the full deployment surface.

## Project Structure

```
app/
  (auth)/           — Login, 2FA pages
  (dashboard)/      — All authenticated pages
  actions/          — Server actions (business logic)
  api/              — API routes (PDFs, exports, cron, uploads)
components/
  ui/               — Shadcn components
  layout/           — Sidebar, topbar, nav
  inventory/        — Product-specific components
  settings/         — Settings-specific components
lib/
  auth/             — NextAuth configuration
  db/               — Prisma client
  csv.ts            — CSV parse/export utilities
  pdf.ts            — PDF generation helpers with branding
prisma/
  schema.prisma     — Database schema
  migrations/       — Migration history
scripts/
  install.sh        — Production installer
```

## Documentation

### For users
- [Getting Started](help-docs/getting-started.md) — first-time users
- [Setup Wizard Walkthrough](help-docs/onboarding-walkthrough.md) — step-by-step first-run guide
- [Glossary](help-docs/glossary.md) — plain-English definitions (FIFO, COGS, RFQ, EOL, etc.)
- [Troubleshooting](help-docs/troubleshooting.md) — common errors and fixes
- [Full in-app help docs index](help-docs/README.md)

### For developers and administrators
- [Architecture](docs/architecture.md)
- [Workflow State Machines](docs/workflows.md)
- [Installation & Deployment](docs/installation.md)
- [Development Workflow](docs/development.md)
- [Backup & Restore](docs/backup-restore.md)
- [Migration Conventions](docs/migration-conventions.md)
- [WooCommerce Integration](docs/woocommerce.md) (symlink → user-facing doc)
- [Xero Accounting Sync](docs/xero-sync.md) (symlink → user-facing doc)
- [Production Readiness Plan](docs/plan.md) — current roadmap

## License

Proprietary — One Two Enterprises Ltd (onetwoInventory).
