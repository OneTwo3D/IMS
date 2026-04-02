# OneTwo3D IMS

Inventory Management System for OneTwo3D — built with Next.js 15, TypeScript, PostgreSQL, and Tailwind CSS.

## Features

| Module | Capabilities |
|---|---|
| **Dashboard** | Sales/purchase KPIs, COGS, margin, AOV; period comparison (day/week/month/year/financial year) |
| **Inventory** | Stock levels per warehouse, GBP sales price lists, purchase price lists, FIFO COGS |
| **Stock Control** | Transfers (with in-transit status), stock counts, adjustments, warehouse management |
| **Purchase Orders** | Multi-currency POs with live FX, landed cost distribution, linked freight POs, PDF/RFQ email, receive/invoice/return |
| **Sales** | WooCommerce order sync (webhook + polling), multi-currency, VAT-aware, refunds with warehouse selection |
| **Manufacturing** | BOMs, pre-assembled kits (production orders), virtual kits |
| **Sync** | WooCommerce stock/orders/products bidirectional; Xero journal entries for COGS and PO invoices |
| **Analytics** | Stock forecasts, reorder points, sales statistics |
| **Settings** | Xero CoA mapping, warehouses, organisation, tax, currencies, SMTP, branding |
| **Activity Log** | Full audit trail of all IMS actions |

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL via Prisma ORM
- **Auth**: Auth.js v5 (credentials + optional TOTP 2FA)
- **Background jobs**: BullMQ + Redis
- **UI**: shadcn/ui + Tailwind CSS (light + dark mode)
- **Charts**: Recharts
- **PDF**: @react-pdf/renderer
- **Email**: Nodemailer
- **Integrations**: WooCommerce REST API, Xero (UK), exchangerate-api.com

## Documentation

| Document | Description |
|---|---|
| [Installation Guide](docs/deployment.md) | Full production deployment instructions |
| [Development Setup](docs/development.md) | Local development environment setup |
| [Configuration Reference](docs/configuration.md) | All environment variables explained |
| [Architecture](docs/architecture.md) | System design and data flow |

## Quick Start (Development)

```bash
# 1. Clone the repository
git clone https://github.com/yourorg/onetwo3d-ims.git
cd onetwo3d-ims

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and AUTH_SECRET

# 4. Run database migrations
npx prisma migrate dev

# 5. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Quick Start (Production)

```bash
# On the production server (Debian/Ubuntu LXC), as root:
bash scripts/install.sh
```

See [docs/deployment.md](docs/deployment.md) for full instructions.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/install.sh` | Full interactive production installer |
| `scripts/update.sh` | Pull latest code, migrate, rebuild, restart |
| `scripts/backup.sh` | Timestamped database backup (suitable for cron) |

## License

Proprietary — OneTwo3D Ltd. All rights reserved.
