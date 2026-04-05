# Development Setup

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) or `nvm` |
| npm | 10+ | Bundled with Node.js |
| PostgreSQL | 14+ | [postgresql.org](https://www.postgresql.org) |
| Redis | 6+ | [redis.io](https://redis.io) |
| Git | any | `apt install git` |

## Initial Setup

### 1. Clone the repository

```bash
git clone https://github.com/yourorg/onetwo3d-ims.git
cd onetwo3d-ims
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/onetwo3d_ims_dev
AUTH_SECRET=any-random-32-char-string-for-dev
NEXT_PUBLIC_APP_URL=http://localhost:3000
AUTH_URL=http://localhost:3000
```

For development, you can leave WooCommerce, Xero, SMTP, and FX API fields blank. Those integrations will be disabled until configured.

### 4. Create the development database

```bash
# If PostgreSQL is running locally
createdb onetwo3d_ims_dev

# Or via psql
psql -U postgres -c "CREATE DATABASE onetwo3d_ims_dev;"
```

### 5. Run migrations

```bash
npx prisma migrate dev
```

This applies all migrations and generates the Prisma client to `app/generated/prisma`.

### 6. Seed the database (optional)

```bash
npm run db:seed
```

This creates default warehouses, currencies, tax rates, an organisation record, and a test admin user.

### 7. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The dev server uses Turbopack for fast compilation.

---

## Background Workers

In development, start the BullMQ worker in a separate terminal:

```bash
npm run worker
```

This requires a running Redis instance. The worker handles FX rate refresh, WooCommerce order polling, and Xero sync queue processing.

---

## Project Structure

```
onetwo3d-ims/
├── app/                              # Next.js 16 App Router
│   ├── (auth)/                       # Public auth pages (login, TOTP)
│   ├── (dashboard)/                  # Protected pages (all modules)
│   │   ├── activity/                 # Activity log
│   │   ├── analytics/                # Analytics (placeholder)
│   │   ├── dashboard/                # Dashboard (placeholder)
│   │   ├── inventory/                # Product list, detail, create
│   │   │   ├── [id]/                 # Product detail page
│   │   │   └── new/                  # Create product page
│   │   ├── manufacturing/            # Manufacturing (placeholder)
│   │   ├── profile/                  # User profile + TOTP setup
│   │   ├── purchase-orders/          # PO list, detail, create, suppliers
│   │   │   ├── [id]/                 # PO detail page
│   │   │   ├── new/                  # Create PO page
│   │   │   └── suppliers/            # Supplier management
│   │   ├── sales/                    # Sales order list, detail, customers
│   │   │   ├── [id]/                 # SO detail page
│   │   │   └── contacts/             # Customer management
│   │   ├── settings/                 # All settings on one page
│   │   ├── stock-control/            # Adjustments and transfers
│   │   │   ├── stock-adjustments/    # Adjustment history
│   │   │   └── transfers/            # Transfer list and management
│   │   ├── sync/                     # WooCommerce/Xero sync
│   │   └── layout.tsx                # Dashboard layout (sidebar + topbar)
│   ├── actions/                      # Server Actions
│   │   ├── currencies.ts             # Currency and FX rate actions
│   │   ├── customers.ts              # Customer CRUD
│   │   ├── import.ts                 # CSV import actions
│   │   ├── products.ts               # Product CRUD, stock, CSV
│   │   ├── purchase-orders.ts        # PO workflow actions
│   │   ├── sales.ts                  # SO workflow actions
│   │   ├── settings.ts               # Settings management
│   │   ├── stock.ts                  # Stock adjustment actions
│   │   ├── suppliers.ts              # Supplier CRUD
│   │   └── transfers.ts              # Stock transfer actions
│   ├── api/                          # Route Handlers
│   │   ├── auth/                     # Auth.js + TOTP endpoints
│   │   ├── cron/fx-rates/            # FX rate refresh endpoint
│   │   ├── export/                   # CSV export endpoints
│   │   │   ├── adjustments/
│   │   │   ├── contacts/
│   │   │   ├── products/
│   │   │   ├── purchase-orders/
│   │   │   ├── sales/
│   │   │   ├── stock-levels/
│   │   │   ├── suppliers/
│   │   │   └── transfers/
│   │   ├── invoice/[id]/             # Invoice PDF generation
│   │   ├── rfq/[id]/                 # RFQ PDF generation
│   │   ├── sales-order/[id]/         # Sales order PDF generation
│   │   ├── upload/invoice/           # Supplier invoice PDF upload
│   │   └── uploads/invoices/[filename]/ # Serve uploaded invoice files
│   ├── generated/prisma/             # Generated Prisma client (do not edit)
│   ├── globals.css                   # Tailwind CSS global styles
│   ├── layout.tsx                    # Root layout
│   └── page.tsx                      # Root page (redirects to login/dashboard)
├── components/
│   ├── auth/                         # Login form, TOTP form/setup
│   ├── inventory/                    # Product form, table, CSV, kit configurator
│   ├── layout/                       # Sidebar, topbar, nav items
│   ├── settings/                     # Tax rates, currencies, purchase units tables
│   └── ui/                           # Shadcn/UI primitives (button, dialog, table, etc.)
├── lib/
│   ├── auth/                         # Auth.js configuration
│   ├── csv.ts                        # CSV parsing and generation utilities
│   ├── db/                           # Prisma client singleton
│   ├── pdf.ts                        # PDFKit helpers, branding, table drawing
│   └── utils.ts                      # General utility functions (cn, formatters)
├── prisma/
│   ├── schema.prisma                 # Database schema (1210 lines, ~40 models)
│   ├── migrations/                   # Applied database migrations
│   ├── seed.ts                       # Development seed data
│   └── config.ts                     # Prisma configuration
├── prisma.config.ts                  # Prisma 7 config (datasource URL)
├── scripts/
│   ├── cli.ts                        # CLI utility (create-user, etc.)
│   ├── install.sh                    # Production installer
│   ├── update.sh                     # Production update script
│   └── backup.sh                     # Database backup script
├── types/
│   └── next-auth.d.ts                # Auth.js type extensions
├── uploads/                          # Uploaded files (supplier invoices)
├── docs/                             # Documentation
├── public/                           # Static assets
├── next.config.ts                    # Next.js configuration
├── components.json                   # Shadcn/UI configuration
├── tsconfig.json                     # TypeScript configuration
├── eslint.config.mjs                 # ESLint configuration
├── postcss.config.mjs                # PostCSS configuration
└── .env.example                      # Environment variable template
```

---

## Available npm Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Next.js dev server with Turbopack hot reload |
| `npm run build` | Build for production |
| `npm run start` | Start production server (requires prior build) |
| `npm run lint` | Run ESLint |
| `npm run type-check` | Run TypeScript compiler (type check only, no emit) |
| `npm run worker` | Start BullMQ background worker |
| `npm run db:seed` | Seed the database with development data |
| `npm run db:studio` | Open Prisma Studio for visual database inspection |
| `npm run cli` | Run CLI commands (e.g. `npm run cli -- create-user`) |

---

## Database Workflow

### Prisma Commands

```bash
# After editing prisma/schema.prisma, create a new migration:
npx prisma migrate dev --name describe_your_change

# Apply existing migrations (e.g. after pulling changes):
npx prisma migrate dev

# Inspect the database visually:
npx prisma studio

# Reset database (WARNING: deletes all data):
npx prisma migrate reset

# Generate Prisma client without migrating:
npx prisma generate
```

### Prisma 7 Notes

- The Prisma client is generated to `app/generated/prisma` (configured in `schema.prisma` generator block)
- Uses the `pg` driver adapter (`@prisma/adapter-pg`)
- The `driverAdapters` preview feature is enabled
- Database URL is configured in `prisma.config.ts`

---

## Coding Patterns

### Server Actions (Primary Mutation Pattern)

All data mutations use Next.js Server Actions in `app/actions/`. This is the primary pattern -- there are no REST API routes for CRUD operations.

```typescript
// app/actions/products.ts
'use server'

import { db } from '@/lib/db'

export async function createProduct(formData: FormData) {
  // Validate, create via Prisma, revalidate
}
```

### Route Handlers (API Routes)

Route handlers in `app/api/` are used for:
- PDF generation and streaming (RFQ, PO, invoice, sales order)
- CSV export downloads
- File uploads (supplier invoice PDFs)
- Cron endpoints (FX rate refresh)
- Auth endpoints (Auth.js, TOTP)
- Serving uploaded files

### Dialog/Modal Forms

All create and edit forms use the Dialog/Modal pattern (Shadcn dialog component). Forms are never rendered as separate pages or inline cards. The dialog opens over the current page, submits via server action, and closes on success.

### Product References as Links

All product SKU and name displays throughout the application must link to `/inventory/[id]` and open in a new tab. Use the `ProductLink` component from `components/inventory/product-link.tsx`.

### No Side Effects During Render

Never perform side effects (data fetching, mutations, subscriptions) during React component render. This causes hydration mismatches and infinite loops with Server Components.

### Avoid Mirroring Server Props in useState

Do not copy server-provided props into `useState`. Use the props directly. If local state is needed for form editing, initialize it once and use a key prop to reset when the source data changes.

### Currency Display Conventions

- Currency symbols displayed **after** amounts: `2.99 GBP`, `150.00 EUR`
- All currency values displayed with 2 decimal places
- Internal storage uses higher precision (4-6 decimal places) for calculations

### Database Access

Always use the Prisma client singleton:

```typescript
import { db } from '@/lib/db'
```

Never instantiate `new PrismaClient()` directly.

### Monetary Values

- All monetary values stored as `Decimal` (Prisma) / `DECIMAL` (PostgreSQL)
- Never use JavaScript `number` for money -- floating point precision is unacceptable
- All amounts stored in both the original currency and GBP equivalent
- Use the `fxRateToGbp` field for the conversion rate at the time of transaction

### CSV Import Two-Pass Pattern

Product CSV imports use a two-pass approach:
1. **First pass**: Import parent products (SIMPLE, VARIABLE, BOM, KIT)
2. **Second pass**: Import child products (VARIANT) and components (BOM/KIT items)

This ensures parent records exist before children reference them.

### OLS Cache Compatibility

The dashboard layout uses `force-dynamic` to prevent OLS (OpenLiteSpeed) from caching dynamic pages. This is configured in the layout file for the dashboard route group.

### Next.js Configuration

Key settings in `next.config.ts`:
- `compress: false` -- OLS handles compression
- `serverExternalPackages: ['pdfkit']` -- PDFKit must be loaded as an external package for server-side PDF generation

---

## Testing WooCommerce Webhooks Locally

Use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose your local server:

```bash
npx ngrok http 3000
```

Configure the resulting URL as your webhook delivery URL in WooCommerce (e.g. `https://abc123.ngrok.io/api/webhooks/woocommerce`).

---

## Environment Variables

See [configuration.md](configuration.md) for the full reference.

For development, only these are required:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/onetwo3d_ims_dev
AUTH_SECRET=dev-secret-at-least-32-characters-long
NEXT_PUBLIC_APP_URL=http://localhost:3000
AUTH_URL=http://localhost:3000
```

Optionally, set `REDIS_URL` if you want to run the background worker locally.
