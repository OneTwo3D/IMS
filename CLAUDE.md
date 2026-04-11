# One Two Inventory (OTI)

Complete inventory management system with sales, purchasing, stock control, manufacturing, and financial integration. Built for product companies managing inventory across multiple warehouses with multi-currency support, FIFO costing, and real-time synchronization with WooCommerce and accounting systems (Xero, QuickBooks).

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| Runtime | Node.js | 18+ | JavaScript execution |
| Framework | Next.js | 16.2 | Full-stack React with App Router, Server Components, Server Actions |
| Language | TypeScript | 5.x | Strict type checking throughout |
| Database | PostgreSQL | 14+ | Relational database for complex inventory models |
| ORM | Prisma | 7.6 | Type-safe database access with 57 models |
| UI Framework | React | 19.2 | Component rendering |
| UI Components | Shadcn/UI + Base-UI | Latest | Pre-built accessible component library |
| Styling | Tailwind CSS | 4.x | Utility-first CSS |
| Authentication | NextAuth.js | 5.0-beta | Session management with TOTP 2FA, Passkey/WebAuthn |
| PDF Generation | PDFKit | 0.18 | Server-side PDF rendering with branding |
| Package Manager | npm | Latest | Dependency management |
| Linting | ESLint | 9.x | Code quality with Next.js/TypeScript rules |

## Quick Start

```bash
# Prerequisites
- Node.js 18+ installed
- PostgreSQL 14+ database running
- Environment variables configured (.env)

# Installation & Development
git clone git@github.com:OneTwo3D/IMS.git
cd onetwo3d-ims
npm install
cp .env.example .env          # Edit with your database URL and secrets

# Database setup
npx prisma migrate deploy     # Apply migrations
npx prisma generate           # Generate Prisma client

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
│   ├── actions/              # Server actions (business logic)
│   ├── api/
│   │   ├── auth/             # Authentication endpoints
│   │   ├── cron/             # Scheduled jobs (FX, sync, cleanup)
│   │   ├── webhooks/         # WooCommerce webhooks
│   │   ├── export/           # CSV exports
│   │   ├── import/           # CSV imports
│   │   ├── invoice/          # Invoice generation & preview
│   │   ├── sales-order/      # Sales order PDFs
│   │   ├── rfq/              # RFQ PDF generation
│   │   ├── manufacturing-order/ # Production order PDFs
│   │   ├── upload/           # File uploads
│   │   ├── backup/           # Backup & restore endpoints
│   │   ├── notifications/    # Notification delivery (email, SMS)
│   │   └── preview/          # Document preview endpoints
│   └── generated/prisma/     # Auto-generated Prisma client types
├── components/
│   ├── ui/                   # Shadcn/Base-UI primitives (button, card, etc.)
│   ├── layout/               # Sidebar, topbar, nav
│   ├── inventory/            # Product-specific components
│   ├── settings/             # Settings-specific components
│   ├── auth/                 # Login/auth components
│   ├── profile/              # User profile components
│   └── providers/            # Context providers
├── lib/
│   ├── auth/                 # NextAuth.js configuration, session helpers
│   ├── db.ts                 # Prisma client singleton
│   ├── permissions.ts        # Role-based access control (RBAC)
│   ├── activity-log.ts       # Audit trail logging
│   ├── mailer.ts             # Nodemailer SMTP configuration
│   ├── pdf.ts                # PDF generation with branding
│   ├── csv.ts                # CSV parse and export utilities
│   ├── utils.ts              # Shared utility functions
│   ├── connectors/           # Integration modules
│   │   ├── woocommerce/      # WC sync, webhooks, cron, tax mapping
│   │   └── xero/             # Xero API, sub-ledger sync, reconciliation
│   └── [service files]       # Email, notifications, tracking
├── prisma/
│   ├── schema.prisma         # Database schema (57 models, full OTI spec)
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

**One Two Inventory** is a modular, role-based inventory management platform:

1. **Core Inventory Module** — Product master data with FIFO costing, multi-warehouse stock tracking, VARIABLE/VARIANT/KIT/BOM product types, and real-time COGS calculation

2. **Order-to-Cash** — Sales order workflow (DRAFT → PENDING → PROCESSING → SHIPPED → COMPLETED), multi-warehouse auto-allocation, shipment management, invoice generation with payment tracking

3. **Procure-to-Pay** — Purchase order lifecycle with multi-currency FX support, landed cost distribution, RFQ generation, goods receipt with FIFO costing, invoice reconciliation

4. **Manufacturing** — Production orders with component allocation, BOM management, stock movements on completion

5. **Integrations** — Connector modules for:
   - **WooCommerce** — Order/stock sync via webhooks, product sync, tax rate mapping (new)
   - **Xero** — Journal entry posting, sub-ledger batch sync (new), COGS calculation, reconciliation
   - **QuickBooks** — Coming soon

6. **Financial** — Multi-currency support with daily FX rates, VAT handling, Xero account mapping, COGS/margin analytics, cash bridge forecasting, payment account mapping (new)

7. **Administration** — Role-based access (ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER), activity logging, scheduled backups, system settings, notifications (new)

**Data Flow:** WooCommerce orders → IMS (allocate stock) → Shipments (track) → Xero sub-ledger (batch sync) → Accounts

## Database

**57 Prisma models** covering:
- Products (Product, ProductVariant, ProductPrice)
- Inventory (Stock, StockMovement, StockCount, StockTransfer)
- Sales (SalesOrder, SalesOrderLine, OrderAllocation, Shipment, Invoice, CreditNote)
- Purchases (PurchaseOrder, PurchaseOrderLine, PurchaseReceipt, SupplierRfq, PurchaseReturn)
- Financials (TaxRate, Currency, LandedCost, CostLayer, FxRate)
- Manufacturing (ManufacturingOrder, Bom, BomItem)
- Integrations (WooCommerceConfig, WooCommerceProduct, WooCommerceSyncJob, XeroMapping, XeroSyncLog)
- Administration (User, Role, Setting, ActivityLog, AuditTrail, Notification)
- Support (DocumentTemplate, AdjustmentReason, PurchaseUnit)

See `@prisma/schema.prisma` for complete schema.

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
- Use Zod for input validation
- Call `logActivity()` for all state mutations
- Use `revalidatePath()` to update UI cache

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

### Error Handling

**API Routes:**
- Return JSON with status code and error message
- Log errors to activity log for audit
- Never expose internal stack traces to client

**Server Actions:**
- Throw errors; Next.js serializes them to client
- User-facing errors: throw `new Error('User message')`
- Always catch database errors and log

**Client Side:**
- Wrap server action calls in try-catch
- Display user-friendly error messages
- Log technical errors for debugging

### Testing

- **No test files in the codebase yet.** TypeScript strict mode + ESLint provide static quality.
- Test manually in development via `npm run dev`
- Type checking: `npm run type-check`

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (hot reload, localhost:3000) |
| `npm run build` | Build for production (optimized next.js bundle) |
| `npm start` | Start production server (requires `npm run build` first) |
| `npm run lint` | Run ESLint to check code style |
| `npm run type-check` | Run TypeScript compiler (no emit) to verify types |
| `npm run db:seed` | Seed database with initial data (see prisma/seed.ts) |
| `npm run db:studio` | Open Prisma Studio (visual database explorer) |
| `npm run cli -- create-user` | Interactive CLI to create admin/staff users |

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
| **Product Management** | `app/actions/products.ts`, `components/inventory/` | CRUD for products, variants, BOMs, pricing | Inventory team |
| **Stock Control** | `app/actions/stock.ts`, `app/(dashboard)/stock-control/` | Adjustments, transfers, counts, movements | Warehouse team |
| **Sales Orders** | `app/actions/sales.ts`, `app/(dashboard)/sales/` | Order workflow, allocation, shipment, invoicing | Sales team |
| **Purchase Orders** | `app/actions/purchase-orders.ts`, `app/(dashboard)/purchase-orders/` | PO creation, RFQ, receipt, landed costs | Procurement team |
| **Manufacturing** | `app/actions/manufacturing.ts`, `app/(dashboard)/manufacturing/` | Production orders, BOM, component allocation | Production team |
| **WooCommerce Sync** | `lib/connectors/woocommerce/` | Order/product sync, tax mapping, webhooks, cron | Dev team |
| **Xero Integration** | `lib/connectors/xero/` | Sub-ledger batch sync, journal posting, COGS, reconciliation | Finance team |
| **Authentication** | `lib/auth/`, `app/(auth)/`, `app/actions/auth.ts` | Login, 2FA, roles, sessions, passkeys | Dev team |
| **PDF Generation** | `lib/pdf.ts`, `app/api/*/[id]/pdf` | Branded PDFs (order, invoice, RFQ, PO) | Dev team |
| **Notifications** | `lib/connectors/notifications/`, `app/api/notifications/` | Email delivery, notification history, preferences | Dev team |
| **Activity Log** | `lib/activity-log.ts`, `app/(dashboard)/activity/` | Audit trail, searchable logs | Compliance team |
| **Settings** | `app/(dashboard)/settings/`, `app/actions/settings.ts` | Company config, users, integrations, backup | Admin |

## Production Deployment

**Current Setup:** Runs as `next start` on machine at `10.0.3.99` from `/root/ims/onetwo3d-ims`

**After Code Changes:**
1. Commit and push to main branch
2. SSH to production machine
3. Pull latest code
4. Run `npm run build`
5. Restart the application (systemd service or manual restart)
6. Verify on `http://10.0.3.99:3000`

See `@docs/deployment.md` for full deployment guide.

## Security Checklist

Every change must verify:
- [ ] **Authentication:** Endpoints require valid session (use `requireAuth()`)
- [ ] **Authorization:** Role checks in place (use `checkPermission()`)
- [ ] **Input Validation:** Zod schema validates all server action inputs
- [ ] **SQL Injection:** Prisma parameterized queries prevent injection
- [ ] **XSS:** React auto-escapes, but check dangerouslySetInnerHTML usage
- [ ] **CSRF:** NextAuth provides automatic CSRF tokens
- [ ] **Data Exposure:** No sensitive data (passwords, secrets) in responses
- [ ] **Cron Security:** Cron endpoints protected by CRON_SECRET header

## Documentation References

- `@README.md` — Project overview and quick links
- `@docs/architecture.md` — Detailed architectural decisions
- `@docs/configuration.md` — Configuration guide for integrations
- `@docs/development.md` — Development workflow (branching, PR process)
- `@docs/deployment.md` — Production deployment procedures
- `@CLAUDE.md` — This file (primary project documentation)
- `@docs/getting-started.md` — User onboarding and feature overview

## Git Workflow

- **Main branch:** Always production-ready
- **Feature branches:** `feature/description` from main
- **Bug fix branches:** `fix/description` from main
- **Commit messages:** Clear, descriptive (e.g., "Add COGS recalculation on landed cost edit")
- **Push:** Commit + push after completing features
- **PR:** Not currently used; direct commits to main after testing

See `@docs/development.md` for full workflow.

## Debugging Tips

**Check Prisma Schema:**
```bash
npx prisma studio    # Visual DB explorer on localhost:5555
```

**Debug Server Actions:**
- Add console.log statements
- Check NextAuth session: `const session = await getServerSession()`
- Verify role permissions: `checkPermission(session, action)`

**Debug Database Queries:**
- Enable Prisma debug logs: `DEBUG="prisma:*" npm run dev`
- Use Prisma Studio to inspect data

**Check Environment Variables:**
- Verify `.env` file exists and is not in `.gitignore`
- Never commit secrets; use `.env.example` as template

**TypeScript Errors:**
```bash
npm run type-check    # Full TypeScript check
```

## Recent Features (Latest Commits)

- **Xero Sub-Ledger Sync:** Batch daily sync of journal entries to Xero with daily GL posting
- **WooCommerce Tax Rate Mapping:** Automatic tax type mapping from WC to Xero
- **Payment Account Mapping:** UI for configuring payment method → bank account mapping
- **Notifications System:** Email notifications for orders, shipments, and sync events
- **Invoice Delegation:** Support for delegated invoice generation workflows

## Contact & Support

- **Product Owner:** One Two Enterprises Ltd
- **Repository:** git@github.com:OneTwo3D/IMS.git
- **Issues:** Document in activity log + GitHub issues
- **Questions:** Reference docs first, then contact dev team


## Skill Usage Guide

When working on tasks involving these technologies, invoke the corresponding skill:

| Skill | Invoke When |
|-------|-------------|
| typescript | Enforces TypeScript strict mode with type safety across all code |
| node | Executes JavaScript on server with Node.js runtime |
| react | Manages React components, hooks, and client-side state patterns |
| postgresql | Manages PostgreSQL schemas and database migrations |
| prisma | Accesses databases with type-safe Prisma ORM queries |
| tailwind | Applies utility-first CSS styling with Tailwind CSS |
| zod | Validates input data with Zod schema definitions |
| nextauth | Implements authentication with NextAuth.js sessions |
| shadcn-ui | Implements accessible UI components from Shadcn/UI library |
| frontend-design | Designs UI with Tailwind CSS, components, and accessibility |
| nodemailer | Sends SMTP emails through Nodemailer integration |
| nextjs | Builds full-stack apps with App Router and Server Components |
| designing-onboarding-paths | Designs onboarding paths, checklists, and first-run UI |
| writing-release-notes | Drafts release notes tied to shipped features |
| designing-inapp-guidance | Builds tooltips, tours, and contextual guidance |
| eslint | Enforces code quality with ESLint configuration |
| orchestrating-feature-adoption | Plans feature discovery, nudges, and adoption flows |
| structuring-offer-ladders | Frames plan tiers, value ladders, and upgrade logic |
| framing-release-stories | Builds launch narratives, assets, and rollout checklists |
| mapping-user-journeys | Maps in-app journeys and identifies friction points in code |
| streamlining-signup-steps | Reduces friction in signup and trial activation |
| accelerating-first-run | Improves onboarding sequence and time-to-value |
| tuning-landing-journeys | Improves landing page flow, hierarchy, and conversion paths |
| inspecting-search-coverage | Audits technical and on-page search coverage |
| adding-structured-signals | Adds structured data for rich results |
