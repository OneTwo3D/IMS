# onetwoInventory

Inventory Management System — built with Next.js 16, TypeScript, Prisma 7, PostgreSQL, and Shadcn/UI.

## Features

### Inventory
- Product management (SIMPLE, VARIABLE, VARIANT, KIT, BOM, NON_INVENTORY)
- Stock levels per warehouse with available/reserved/on-hand tracking
- FIFO cost layers with weighted average COGS
- Product stock units (pcs, m, kg, etc.) with purchase unit conversion
- CSV import/export with BOM, variant, and bundle support

### Stock Control
- Bulk stock adjustments with configurable reasons (linked to Xero accounts)
- Warehouse transfers (DRAFT > IN_TRANSIT > RECEIVED) with stock booking
- Stock level export per warehouse with multi-select filter

### Purchases
- Multi-currency purchase orders with live FX rates (ECB via frankfurter.dev)
- VAT handling (inclusive/exclusive) with named tax rates
- Landed cost distribution (by value/weight/quantity/equal split) per cost line
- Purchase units with stock unit conversion (e.g. 1 roll = 1000m)
- Freight/landed cost POs linked to multiple primary POs
- Retrospective landed cost recalculation (updates FIFO cost layers and COGS)
- RFQ PDF generation, goods receipt, supplier returns, billing with PDF upload
- Supplier management with default currency, tax rate, and payment terms

### Sales
- Sales orders with full workflow (Pending > Processing > Picking > Packed > Shipped > Completed)
- Multi-currency with VAT, line/order discounts (% or absolute), shipping fees
- Customer contacts with billing/shipping addresses and tax numbers
- Stock reservation on order creation, release on ship/cancel
- Invoice generation (manual, auto on ship, or auto on paid — configurable)
- Payment tracking against invoices and credit notes
- Automatic credit note numbers on refund
- Order and invoice PDF generation, email (mailto)
- Clone, delete (pending only), column picker (COGS, margin, qty on hand, etc.)
- Sales representative assignment, delivery dates

### Settings
- VAT rates (sales/purchase/both) with Xero tax type codes
- Currencies and FX rates with daily auto-fetch cron
- Landed cost distribution method default
- Invoice generation trigger (manual/on shipped/on paid)
- Purchase units with stock unit conversion
- Stock adjustment reasons with Xero account mapping

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
- **Database**: PostgreSQL with Prisma 7 ORM (~40 models)
- **UI**: Shadcn/UI with base-ui primitives, Tailwind CSS, Lucide icons
- **PDF**: PDFKit (server-external package)
- **FX Rates**: frankfurter.dev API (free, ECB data, no API key)
- **Auth**: NextAuth.js with TOTP 2FA support

## Quick Start

```bash
npm install
cp .env.example .env    # edit with your database URL
npx prisma migrate deploy && npx prisma generate
npm run cli -- create-user
npm run dev              # development
npm run build && npm start  # production
```

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
  schema.prisma     — Database schema (~40 models)
  migrations/       — Migration history
scripts/
  install.sh        — Production installer
```

## Documentation

- [Architecture](docs/architecture.md)
- [Installation & Deployment](docs/installation.md)
- [WooCommerce Integration](docs/woocommerce.md)
- [Xero Accounting Sync](docs/xero-sync.md)
- [In-App Help Docs](help-docs/README.md)

## License

Proprietary — One Two Enterprises Ltd (onetwoInventory).
