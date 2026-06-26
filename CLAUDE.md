# One Two Inventory (OTI)

Complete inventory management system with sales, purchasing, stock control, manufacturing, and financial integration. Built for product companies managing inventory across multiple warehouses with multi-currency support, FIFO costing, and real-time synchronization with WooCommerce and accounting systems (Xero, QuickBooks).

For the current production-readiness backlog and execution grouping, see `docs/plan.md`.

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| Runtime | Node.js | 22+ | JavaScript execution |
| Framework | Next.js | 16.2 | Full-stack React with App Router, Server Components, Server Actions, Turbopack |
| Language | TypeScript | 5.x | Strict type checking throughout (strict mode enabled) |
| Database | PostgreSQL | 14+ | Relational database for complex inventory models |
| ORM | Prisma | 7.6 | Type-safe database access with 59 models |
| UI Framework | React | 19.2 | Component rendering and state management |
| UI Components | Shadcn/UI + Base-UI | Latest | Pre-built accessible component library |
| Styling | Tailwind CSS | 4.x | Utility-first CSS |
| Authentication | NextAuth.js | 5.0-beta | Session management with TOTP 2FA, Passkey/WebAuthn |
| PDF Generation | PDFKit | 0.18 | Server-side PDF rendering with branding |
| Package Manager | npm | Latest | Dependency management |
| Linting | ESLint | 9.x | Code quality with Next.js/TypeScript rules |

## Quick Start

```bash
# Prerequisites
- Node.js 22+ installed
- PostgreSQL 14+ database running
- Environment variables configured (.env)

# Installation & Development
git clone git@github.com:OneTwo3D/IMS.git
cd onetwo3d-ims
npm install
cp .env.example .env          # Edit with your database URL and secrets

# Database setup
npx prisma migrate deploy     # Apply all pending migrations
npx prisma generate           # Generate Prisma client types

# Create initial admin user
npm run cli -- create-user    # Interactive user creation

# Development server (hot reload on localhost:3000)
npm run dev

# Production build & start
npm run build
npm start                     # Runs on port 3000
```

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
│   │   │   ├── fx-rates      # Daily FX rate fetch (frankfurter.dev)
│   │   │   ├── wc-sync       # WooCommerce polling sync (if webhooks disabled)
│   │   │   ├── xero-daily-batch # Daily Xero sub-ledger batch sync
│   │   │   ├── xero-sync     # Real-time Xero sync (deprecated, use daily-batch)
│   │   │   ├── xero-payment-poll # Payment status polling from Xero
│   │   │   ├── delivery-status # Update delivery status on SalesOrders
│   │   │   ├── activity-cleanup # Archive old activity logs
│   │   │   └── backup        # Automated database backups
│   │   ├── webhooks/woocommerce/ # WC order, product, refund webhooks
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
│   │   ├── xero/             # Xero OAuth callback
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
│   ├── db.ts                 # Prisma client singleton
│   ├── permissions.ts        # Role-based access control (RBAC) helpers
│   ├── activity-log.ts       # Audit trail logging
│   ├── mailer.ts             # Nodemailer SMTP configuration
│   ├── pdf.ts                # PDF generation with branding system
│   ├── csv.ts                # CSV parse and export utilities
│   ├── utils.ts              # Shared utility functions
│   ├── connectors/           # Integration modules
│   │   ├── woocommerce/      # WC sync logic, webhooks, tax mapping
│   │   │   ├── sync.ts       # Order/product sync engine
│   │   │   ├── webhooks.ts   # Webhook parsing and validation
│   │   │   ├── tax-mapping.ts # WC tax rate → Xero tax type mapping
│   │   │   └── api.ts        # WC REST API client
│   │   └── xero/             # Xero API, journal posting, reconciliation
│   │       ├── api.ts        # Xero OAuth and API client
│   │       ├── sync.ts       # Journal entry posting
│   │       ├── batch.ts      # Daily batch sync logic
│   │       └── reconciliation.ts # Payment/invoice reconciliation
│   └── [service files]       # Notifications, FX rates, tracking
├── prisma/
│   ├── schema.prisma         # Database schema (59 models, full OTI spec)
│   ├── migrations/           # Migration history
│   ├── seed.ts               # Database seeding
│   └── prod-seed/            # Production data fixtures
├── scripts/
│   ├── cli.ts                # CLI tool (create-user, etc.)
│   └── [deployment scripts]
├── public/                   # Static assets (favicon, branding)
├── docs/                     # Additional documentation
├── .env.example              # Template for environment variables
├── .eslintrc.mjs             # ESLint configuration
├── tsconfig.json             # TypeScript strict mode
├── next.config.ts            # Next.js config
├── tailwind.config.ts        # Tailwind CSS config
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
   - Workflow: DRAFT → RFQ_SENT → PO_SENT → PARTIALLY_RECEIVED → RECEIVED → INVOICED
   - Multi-currency with live FX rates (frankfurter.dev ECB data)
   - RFQ PDF generation and supplier management
   - Goods receipt with FIFO costing integration
   - Landed cost distribution (by value/weight/quantity/equal split)
   - Freight/cost POs linked to primary POs
   - Retrospective landed cost recalculation (updates FIFO layers and COGS)
   - Supplier returns and billing workflow

4. **Manufacturing** — Production order management:
   - Production order types: ASSEMBLY, DISASSEMBLY
   - BOM management with component allocation
   - Stock movements on completion (production receipts)
   - Links to sales orders for made-to-order workflows

5. **Integrations** — Connector modules for data sync:
   - **WooCommerce** — Order sync via webhooks (or polling), product sync, tax rate mapping to Xero
   - **Xero** — Daily batch journal entry posting, sub-ledger sync, COGS calculation, payment reconciliation
   - **QuickBooks** — Coming soon

6. **Financial Module** — Multi-currency and reporting:
   - Daily FX rates auto-fetch from frankfurter.dev (ECB data)
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
FX rates (daily via frankfurter.dev) → Multi-currency conversions
```

## Database

**59 Prisma models** (managed with migrations):

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
- WooCommerceConfig, WooCommerceProduct, WooCommerceSyncJob, WooCommerceTaxMap
- XeroMapping, XeroSyncLog, XeroPaymentPoll

**Administration:**
- User, Role, Session (NextAuth)
- Setting, ActivityLog, AuditTrail, Notification
- DocumentTemplate, AdjustmentReason, PurchaseUnit, Warehouse

See `@prisma/schema.prisma` for complete schema with relationships and constraints.

## Development Guidelines

### File & Code Naming Conventions

**File Names** (on disk):
- Components: `kebab-case` → `user-profile.tsx`, `product-list.tsx`, `add-to-stock-dialog.tsx`
- Server actions: `kebab-case` → `products.ts`, `sales-orders.ts`
- API routes: `kebab-case` → `create-order.ts`, `webhook-woocommerce.ts`
- Utilities: `kebab-case` → `pdf-helpers.ts`, `format-currency.ts`
- Hooks: `use` + camelCase (in file name) → `useAuth.ts`, `usePermissions.ts`
- UI components: `lowercase` → `button.tsx`, `dialog.tsx`, `dropdown-menu.tsx`
- Config files: `kebab-case` → `next.config.ts`, `.env.example`

**Code Naming** (identifiers inside files):
- **Components/Classes:** PascalCase → `export function UserProfile()`, `export class ApiClient`
- **Functions:** camelCase with verb prefix → `function handleSubmit()`, `const fetchUsers = async ()`
- **Variables:** camelCase → `const userData`, `let totalStock`
- **State hooks:** camelCase, semantic prefix → `const [loading, setLoading] = useState(false)`, `const [error, setError] = useState('')`
- **Custom hooks:** `use` + PascalCase → `useAuth()`, `usePermissions()`, `useInventory()`
- **Constants:** SCREAMING_SNAKE_CASE → `const MAX_RETRIES = 3`, `const XERO_BASE_URL = '...'`
- **Type/Interface exports:** PascalCase → `export type ProductRow = {...}`, `export interface UserSession {...}`
- **Boolean variables:** `is`/`has`/`should` prefix → `const isLoading`, `const hasPermission`, `const shouldRefetch`

### Import Order

Follow this order in all files:

```typescript
// 1. React and Next.js
import type { Metadata } from 'next'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 2. External packages
import { z } from 'zod'
import { signIn } from 'next-auth/react'

// 3. Internal absolute imports (@/)
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

// 4. Component imports
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

// 5. Type imports (if separate)
import type { ProductRow } from '@/app/actions/products'
```

### Code Style & Patterns

**TypeScript Strict Mode:**
- All files are TypeScript. No ambiguous `any` types.
- Use `type` for type-only imports to enable tree-shaking
- Define explicit return types on public functions

```typescript
// ✓ Good
export async function getProduct(id: string): Promise<ProductRow | null> {
  return db.product.findUnique({ where: { id } })
}

// ✗ Bad - no return type
export async function getProduct(id: string) {
  return db.product.findUnique({ where: { id } })
}
```

**Server Actions:**
- Always start with `'use server'` directive
- Include `await requireAuth()` at the top
- Use Zod for input validation with explicit schema
- Call `logActivity()` for all state mutations
- Use `revalidatePath()` or `revalidateTag()` to update UI cache

```typescript
// app/actions/products.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

const CreateProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
})

export async function createProduct(input: unknown) {
  const session = await requireAuth()

  const data = CreateProductSchema.parse(input)

  const product = await db.product.create({
    data: { ...data, createdBy: session.user.id }
  })

  await logActivity({
    tag: 'inventory',
    action: 'create',
    description: `Created product: ${product.name}`,
    entityId: product.id,
  })

  revalidatePath('/inventory')
  return product
}
```

**Client Components:**
- Use `'use client'` only where interactivity is needed
- Separate server (async) and client (interactive) components
- Page components stay on server, extract interactive parts to clients

```typescript
// app/(dashboard)/products/[id]/page.tsx (Server Component)
export default async function Page({ params }: { params: { id: string } }) {
  const product = await getProduct(params.id)
  return <ProductClient product={product} />
}

// components/product-client.tsx (Client Component)
'use client'
export function ProductClient({ product }: { product: Product }) {
  const [editing, setEditing] = useState(false)
  return (...)
}
```

**Permissions & RBAC:**
- Check permissions server-side in actions via `checkPermission(session, 'action', resource)`
- Import from `@/lib/permissions.ts`
- Prevent privilege escalation by validating user role on server

```typescript
import { checkPermission } from '@/lib/permissions'

export async function updateProduct(id: string, input: unknown) {
  const session = await requireAuth()

  if (!checkPermission(session, 'edit_products')) {
    throw new Error('Unauthorized')
  }

  // proceed...
}
```

**Activity Logging:**
- Every mutation (create, update, delete) must call `logActivity()`
- Include descriptive messages, tags (inventory/sales/sync/etc.), and entity IDs
- Located in `@/lib/activity-log.ts`

**Form Patterns:**
- All forms use modal/dialog style (floating, not separate pages)
- Use Zod validation in server actions
- Leverage React's form submission with server actions
- Include loading states and error handling

### Error Handling

**API Routes:**
- Return JSON with HTTP status code and error message
- Log errors to activity log for audit
- Never expose internal stack traces to client
- Return 401 for auth, 403 for permission, 400 for validation, 500 for server errors

**Server Actions:**
- Throw errors; Next.js serializes them to client
- User-facing errors: throw `new Error('User message')`
- Always catch database errors and log to activity log
- Include context in error messages

**Client Side:**
- Wrap server action calls in try-catch
- Display user-friendly error messages
- Log technical errors for debugging
- Show loading skeletons during async operations

### Testing

- **Unit/business-logic suite:** `npm run test:unit` (node:test + tsx over `tests/**/*.test.ts`) — 1800+ assertions covering FIFO/COGS cost layers, tax/FX, Xero sync/batch/outbox, Woo/Shopify webhooks + stock sync, Mintsoft connector phases, manufacturing, transfers, security, and the WMS order push/status logic. New business logic should ship with a test here; export pure builders/helpers so they can be unit-tested directly (see `tests/wms-order-push-payload.test.ts`).
- **DB concurrency:** `npm run test:concurrency` (needs a DB; `RUN_DB_CONCURRENCY_TESTS=1`).
- **E2E:** `npm run e2e` (Playwright; tagged `@wc` / `@xero` / `@external`).
- **Static gates:** `npm run type-check`, `npm run lint`, and `npm run check:all` (decimal / connector-fetch / WMS-connector / migration-convention boundary guards).
- Manual smoke in dev via `npm run dev`.

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (hot reload, localhost:3000) |
| `npm run build` | Build for production (optimized Next.js bundle) |
| `npm start` | Start production server (requires `npm run build` first) |
| `npm run lint` | Run ESLint to check code style and quality |
| `npm run type-check` | Run TypeScript compiler (no emit) to verify all types |
| `npm run db:seed` | Seed database with initial data (see prisma/seed.ts) |
| `npm run db:studio` | Open Prisma Studio (visual database explorer on localhost:5555) |
| `npm run cli -- create-user` | Interactive CLI to create admin/staff/supplier users |

## Environment Variables

Copy `.env.example` to `.env` and configure. Uses **NextAuth.js v5** variable naming:

### Application & Authentication

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NEXT_PUBLIC_APP_URL` | Yes | Full public app URL (no trailing slash) | `https://ims.yourdomain.com` |
| `NODE_ENV` | Yes | Environment mode | `production` or `development` |
| `AUTH_SECRET` | Yes | Encryption key for Auth.js sessions (min 32 chars) | Generate with `openssl rand -base64 32` |
| `AUTH_URL` | Yes | Auth.js base URL (same as NEXT_PUBLIC_APP_URL) | `https://ims.yourdomain.com` |

### Database

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/oti` |

### WooCommerce Integration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `WC_STORE_URL` | No | WooCommerce store base URL (no trailing slash) | `https://yourstore.com` |
| `WC_CONSUMER_KEY` | No | WC REST API consumer key | From WC admin → Settings → Advanced → REST API |
| `WC_CONSUMER_SECRET` | No | WC REST API consumer secret | From WC admin → Settings → Advanced → REST API |
| `WC_WEBHOOK_SECRET` | No | WC webhook signing key | Any random string (set same in WC webhooks config) |
| `WC_SYNC_STATUSES` | No | Order statuses to sync (comma-separated) | `processing` (default: on-hold, completed) |
| `WC_USE_WEBHOOKS` | No | Use webhooks or polling? | `true` (false = polling via cron) |
| `WC_POLL_INTERVAL_MINUTES` | No | Polling interval when WC_USE_WEBHOOKS=false | `5` |

### Xero Integration (OAuth 2.0)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `XERO_CLIENT_ID` | No | Xero OAuth app client ID | From Xero Developer Portal (app.xero.com) |
| `XERO_CLIENT_SECRET` | No | Xero OAuth app client secret | From Xero Developer Portal |
| `XERO_TENANT_ID` | No | Xero tenant/organisation ID (auto-populated after first OAuth) | Retrieved after OAuth flow |
| `XERO_TOKEN_PATH` | No | Path to store Xero OAuth refresh token (keep outside repo) | `/var/lib/onetwoinventory/xero-token.json` |

### Foreign Exchange Rates

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `FX_BASE_CURRENCY` | No | Base currency for all calculations | `GBP` (default) |

Note: FX rates are fetched daily via cron job (`/api/cron/fx-rates`) using free [frankfurter.dev](https://frankfurter.dev) API (ECB data, no API key required).

### Email (SMTP)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SMTP_HOST` | No | Email server hostname | `smtp.gmail.com` |
| `SMTP_PORT` | No | Email server port | `587` |
| `SMTP_SECURE` | No | Encryption type | `tls`, `ssl`, or `none` |
| `SMTP_USER` | No | SMTP username | `noreply@company.com` |
| `SMTP_PASSWORD` | No | SMTP password | App-specific password (not your account password) |
| `SMTP_FROM_EMAIL` | No | From address on emails | `ims@yourdomain.com` |
| `SMTP_FROM_NAME` | No | From name on emails | `onetwoInventory` |

### File Storage & Uploads

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `PDF_TEMP_DIR` | No | Temporary PDF storage directory (must be writable) | `/tmp/onetwoinventory/pdf` |
| `UPLOAD_MAX_SIZE_MB` | No | Max CSV upload size in MB | `10` |
| `UPLOAD_TEMP_DIR` | No | Temporary upload directory (must be writable) | `/tmp/onetwoinventory/uploads` |

### Logging

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `LOG_LEVEL` | No | Log level | `error`, `warn`, `info`, or `debug` |
| `LOG_FORMAT` | No | Log format | `json` (production) or `pretty` (development) |

See `.env.example` for complete list and additional settings.

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
| **Authentication** | `lib/auth/`, `app/(auth)/`, `app/actions/auth.ts` | Login, 2FA, passkeys, roles, sessions, RBAC | Dev team |
| **PDF Generation** | `lib/pdf.ts`, `app/api/*/[id]/route.ts` | Branded PDFs (order, invoice, RFQ, PO, shipment) | Dev team |
| **Notifications** | `lib/mailer.ts`, `app/api/notifications/` | Email delivery, notification history, preferences | Dev team |
| **Activity Log** | `lib/activity-log.ts`, `app/(dashboard)/activity/` | Audit trail, searchable logs, compliance | Compliance team |
| **Settings** | `app/(dashboard)/settings/`, `app/actions/settings.ts` | Company config, users, integrations, backup, tax rates | Admin |

## Production Deployment

**Current Setup:** Runs as `next start` on machine at `10.0.3.99` from `/root/ims/onetwo3d-ims`

**After Code Changes:**
1. Commit and push to main branch
2. SSH to production machine
3. Pull latest code: `git pull origin main`
4. Install dependencies (if needed): `npm install`
5. Build the application: `npm run build`
6. Restart the service (systemd or manual): `sudo systemctl restart onetwoinventory` or manual restart
7. Verify on `http://10.0.3.99:3000`

**Database migrations:**
- Migrations are applied during `npm run build` via `prisma migrate deploy` in postinstall hook
- Always review schema.prisma changes before deployment
- Follow `docs/migration-conventions.md` for NOT NULL add-columns, NOT VALID constraints, column renames, large-table indexes, and column drops
- Test migrations on staging first

See `@docs/deployment.md` for full deployment guide including backups, monitoring, and rollback procedures.

## Security Checklist

Every change must verify:
- [ ] **Authentication:** Endpoints require valid session (use `requireAuth()`)
- [ ] **Authorization:** Role checks in place (use `checkPermission()`)
- [ ] **Input Validation:** Zod schema validates all server action inputs
- [ ] **SQL Injection:** Prisma parameterized queries prevent injection
- [ ] **XSS:** React auto-escapes, but avoid `dangerouslySetInnerHTML`
- [ ] **CSRF:** NextAuth provides automatic CSRF tokens
- [ ] **Data Exposure:** No sensitive data (passwords, secrets) in responses
- [ ] **Cron Security:** Cron endpoints protected by CRON_SECRET header
- [ ] **File Upload Security:** Validate MIME types, enforce size limits, sanitize filenames
- [ ] **API Rate Limiting:** Consider rate limiting on public endpoints (webhooks)

## Recent Features (Latest Commits)

- **Partial Fulfillment:** Ship available items now, allocate and ship the rest later. Allocation panel reappears for unfulfilled lines after partial shipment.
- **PICKING Guard:** Blocks transition to Picking status when no allocations exist, preventing empty picks.
- **Packing Slip Legacy Support:** Packing slip PDF works for orders without shipments (legacy flow) using order lines directly.
- **Xero Sub-Ledger Batch Sync:** Daily batch sync of journal entries to Xero GL (replaces real-time sync for performance)
- **WooCommerce Tax Rate Mapping:** Automatic tax type mapping from WC to Xero during order sync
- **Payment Account Mapping:** UI for configuring payment method → bank account mapping for reconciliation
- **Notifications System:** Email notifications for orders, shipments, and sync events with preference management
- **Invoice Delegation:** Support for delegated invoice generation workflows (finance team can approve before sending)
- **Passkey/WebAuthn Support:** FIDO2 passwordless authentication alongside TOTP 2FA
- **Supplier Portal:** Separate RBAC role for suppliers to view orders and delivery status

## Documentation References

- `@README.md` — Project overview and quick links
- `@docs/architecture.md` — Detailed architectural decisions and data flow
- `@docs/configuration.md` — Integration setup guides (WooCommerce, Xero, SMTP)
- `@docs/development.md` — Development workflow, branching strategy, PR process
- `@docs/deployment.md` — Production deployment procedures and monitoring
- `@CLAUDE.md` — This file (primary project documentation)
- `@docs/getting-started.md` — User onboarding and feature overview

## Git Workflow

- **Main branch:** Always production-ready, reflects live environment
- **Feature branches:** `feature/description` from main
- **Bug fix branches:** `fix/description` from main
- **Commit messages:** Clear and descriptive (e.g., "Add COGS recalculation on landed cost edit")
- **Push:** Commit + push after completing features
- **PR:** Direct commits to main after local testing (no PR process currently)

See `@docs/development.md` for full workflow details.

## Debugging Tips

**Check Prisma Schema:**
```bash
npx prisma studio    # Visual DB explorer on localhost:5555
npx prisma db pull   # Sync schema from database
```

**Debug Server Actions:**
- Add console.log statements (visible in server logs)
- Check NextAuth session: `const session = await requireAuth()`
- Verify role permissions: `checkPermission(session, 'action')`
- Check activity log for errors: `app/(dashboard)/activity/`

**Debug Database Queries:**
- Enable Prisma debug logs: `DEBUG="prisma:*" npm run dev`
- Use Prisma Studio to inspect data
- Check query performance: `PRISMA_SLOW_QUERY_THRESHOLD_MS=500 npm run dev`

**Debug Integrations:**
- WooCommerce: Check sync job logs in `app/(dashboard)/sync/`
- Xero: Check sync status and journal entries in `app/(dashboard)/sync/`
- Check email delivery in SMTP logs or notification history

**Check Environment Variables:**
- Verify `.env` file exists and is not in `.gitignore`
- Never commit secrets; use `.env.example` as template
- Check `NEXT_PUBLIC_*` variables don't contain secrets

**TypeScript Errors:**
```bash
npm run type-check    # Full TypeScript check across entire project
npm run lint          # ESLint style and quality checks
```

## Recent Features (Latest Commits)

- **Partial Fulfillment:** Ship available items now, allocate and ship the rest later. Allocation panel reappears for unfulfilled lines after partial shipment.
- **PICKING Guard:** Blocks transition to Picking status when no allocations exist, preventing empty picks.
- **Packing Slip Legacy Support:** Packing slip PDF works for orders without shipments (legacy flow) using order lines directly.
- **Xero Sub-Ledger Batch Sync:** Daily batch sync of journal entries to Xero GL (replaces real-time sync for performance)
- **WooCommerce Tax Rate Mapping:** Automatic tax type mapping from WC to Xero during order sync
- **Payment Account Mapping:** UI for configuring payment method → bank account mapping for reconciliation
- **Notifications System:** Email notifications for orders, shipments, and sync events with preference management
- **Invoice Delegation:** Support for delegated invoice generation workflows (finance team can approve before sending)
- **Passkey/WebAuthn Support:** FIDO2 passwordless authentication alongside TOTP 2FA
- **Supplier Portal:** Separate RBAC role for suppliers to view orders and delivery status

## Contact & Support

- **Product Owner:** One Two Enterprises Ltd
- **Repository:** git@github.com:OneTwo3D/IMS.git
- **Issues:** Document in activity log + GitHub issues
- **Questions:** Reference docs first, then contact dev team
- **Reporting Bugs:** Include relevant activity log entries and environment details

## Skill Usage Guide

When working on tasks involving these technologies, invoke the corresponding skill:

| Skill | Use When |
|-------|----------|
| typescript | Enforcing TypeScript strict mode with type safety across all code |
| node | Executing JavaScript on server with Node.js runtime |
| react | Managing React components, hooks, and client-side state patterns |
| postgresql | Managing PostgreSQL schemas and database migrations |
| prisma | Accessing databases with type-safe Prisma ORM queries |
| tailwind | Applying utility-first CSS styling with Tailwind CSS 4.x |
| zod | Validating input data with Zod schema definitions |
| nextauth | Implementing authentication with NextAuth.js sessions and RBAC |
| shadcn-ui | Implementing accessible UI components from Shadcn/UI library |
| frontend-design | Designing UI with Tailwind CSS, components, and accessibility patterns |
| nodemailer | Sending SMTP emails through Nodemailer integration |
| nextjs | Building full-stack apps with App Router and Server Components |
| designing-onboarding-paths | Designing onboarding paths, checklists, and first-run UI |
| writing-release-notes | Drafting release notes tied to shipped features |
| designing-inapp-guidance | Building tooltips, tours, and contextual guidance |
| eslint | Enforcing code quality with ESLint configuration |
| orchestrating-feature-adoption | Planning feature discovery, nudges, and adoption flows |
| structuring-offer-ladders | Framing plan tiers, value ladders, and upgrade logic |
| framing-release-stories | Building launch narratives, assets, and rollout checklists |
| mapping-user-journeys | Mapping in-app journeys and identifying friction points in code |
| streamlining-signup-steps | Reducing friction in signup and trial activation flows |
| accelerating-first-run | Improving onboarding sequence and time-to-value |
| tuning-landing-journeys | Improving landing page flow, hierarchy, and conversion paths |
| inspecting-search-coverage | Auditing technical and on-page search coverage |
| adding-structured-signals | Adding structured data for rich results |


## Skill Usage Guide

When working on tasks involving these technologies, invoke the corresponding skill:

| Skill | Invoke When |
|-------|-------------|
| pdfkit | Generates branded PDF documents with PDFKit for invoices and reports |
| crafting-page-messaging | Writes conversion-focused messaging for pages and key CTAs |
| instrumenting-product-metrics | Defines product events, funnels, and activation metrics |


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
