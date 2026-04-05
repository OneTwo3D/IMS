# Deployment Guide

This guide covers deploying OneTwo3D IMS to a production LXC container on a Proxmox host (or any Debian/Ubuntu server). The current production environment uses OLS (OpenLiteSpeed) as the reverse proxy.

## Prerequisites

### Production Server Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| OS | Debian 11 / Ubuntu 22.04 | Debian 12 / Ubuntu 24.04 |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB | 40 GB |
| Network | Internet access | Static IP or hostname |

### Infrastructure

| Component | Location | Purpose |
|---|---|---|
| OLS (OpenLiteSpeed) | `10.0.3.12` | Reverse proxy, SSL termination |
| Redis | `10.0.3.11` | BullMQ background job queues |
| PostgreSQL | Local or separate LXC | Primary database |

### External Services

| Service | Purpose | Notes |
|---|---|---|
| WooCommerce store | Order/product sync | REST API + webhooks must be enabled |
| Xero (UK) | Accounting sync | OAuth 2.0 app required |
| frankfurter.dev | Live FX rates | Free, no API key required |
| SMTP server | PO/RFQ emails | Any transactional SMTP provider |

### Domain / DNS

A DNS A record pointing your domain (e.g. `ims.yourdomain.com`) to the OLS server IP is required for SSL. For internal-only use, an internal hostname works without SSL.

---

## Automated Installation

The installer script handles everything interactively. It installs Node.js, PostgreSQL, nginx (or you can use OLS separately), PM2, configures the database, builds the app, and sets up process management.

### Step 1 -- Prepare the LXC Container

On your Proxmox host:

```bash
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname ims \
  --memory 4096 \
  --cores 4 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --start 1

pct enter 200
```

### Step 2 -- Run the Installer

```bash
# Option A: Clone the repo first
apt-get install -y git
git clone https://github.com/yourorg/onetwo3d-ims.git /tmp/onetwo3d-ims
bash /tmp/onetwo3d-ims/scripts/install.sh

# Option B: Copy from development server
rsync -avz /root/ims/onetwo3d-ims/ root@production-ip:/tmp/onetwo3d-ims/
bash /tmp/onetwo3d-ims/scripts/install.sh
```

The installer prompts for all configuration values. See [Configuration Reference](configuration.md) for details on each setting.

### Step 3 -- Create the First Admin User

```bash
cd /opt/onetwo3d-ims
npm run cli -- create-user
```

Follow the prompts for email, name, and password.

### Step 4 -- Connect Xero

1. Visit `https://ims.yourdomain.com/settings/integrations/xero`
2. Click **Connect to Xero** and complete the OAuth flow
3. Import your Chart of Accounts

### Step 5 -- Configure WooCommerce Webhooks

In WooCommerce (Settings > Advanced > Webhooks), create:

| Name | Topic | Delivery URL |
|---|---|---|
| IMS Order Created | Order created | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Order Updated | Order updated | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Order Deleted | Order deleted | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Product Updated | Product updated | `https://ims.yourdomain.com/api/webhooks/woocommerce` |

Set the **Secret** on each webhook to match `WC_WEBHOOK_SECRET` in `.env`.

### Step 6 -- Import Existing Data

Via the IMS Settings or CSV import:

1. **Products** -- sync from WooCommerce or CSV import (supports BOM, variant, and bundle structures via two-pass import)
2. **Customers** -- CSV import with billing/shipping addresses
3. **Suppliers** -- CSV import
4. **Opening stock** -- stock adjustment CSV import

### Step 7 -- Set Up Automated Backups

Add to root's crontab (`crontab -e`):

```cron
# Daily database backup at 02:00
0 2 * * * /bin/bash /opt/onetwo3d-ims/scripts/backup.sh >> /var/log/onetwo3d-ims/backup.log 2>&1
```

The backup script creates compressed, timestamped PostgreSQL dumps in `/var/backups/onetwo3d-ims/` and automatically prunes backups older than 30 days (configurable via `BACKUP_KEEP_DAYS`).

---

## Manual Installation

If you prefer to install components individually rather than using the automated installer.

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2
```

### 2. Install PostgreSQL

```bash
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

sudo -u postgres psql <<EOF
CREATE USER imsuser WITH PASSWORD 'yourpassword';
CREATE DATABASE onetwo3d_ims OWNER imsuser;
GRANT ALL PRIVILEGES ON DATABASE onetwo3d_ims TO imsuser;
EOF
```

### 3. Deploy Application

```bash
# Create app user
useradd --system --shell /bin/bash --home-dir /opt/onetwo3d-ims --create-home imsapp

# Clone or copy the app
git clone https://github.com/yourorg/onetwo3d-ims.git /opt/onetwo3d-ims
chown -R imsapp:imsapp /opt/onetwo3d-ims

# Configure environment
cp /opt/onetwo3d-ims/.env.example /opt/onetwo3d-ims/.env
chmod 600 /opt/onetwo3d-ims/.env
# Edit .env with production values

# Create required directories
mkdir -p /var/lib/onetwo3d-ims /var/log/onetwo3d-ims /opt/onetwo3d-ims/uploads/invoices
chown -R imsapp:imsapp /var/lib/onetwo3d-ims /var/log/onetwo3d-ims

# Install dependencies and build
cd /opt/onetwo3d-ims
sudo -u imsapp npm ci --omit=dev
sudo -u imsapp npx prisma migrate deploy --schema prisma/schema.prisma
sudo -u imsapp npm run build
```

### 4. Start with PM2

```bash
sudo -u imsapp pm2 start /opt/onetwo3d-ims/ecosystem.config.js
pm2 startup systemd -u imsapp --hp /opt/onetwo3d-ims | tail -1 | bash
pm2 save
```

### 5. Configure Reverse Proxy

The production setup uses OLS (OpenLiteSpeed) at `10.0.3.12`. Configure a virtual host that proxies to the Next.js process on port 3000.

Alternatively, the install script can configure nginx. For nginx:

```bash
# Copy the generated config to sites-available
ln -s /etc/nginx/sites-available/onetwo3d-ims /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 6. Enable SSL (Optional)

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d ims.yourdomain.com
```

### 7. Set Up FX Rate Cron

```bash
# Add to the app user's crontab
(crontab -u imsapp -l 2>/dev/null; echo "0 6 * * * curl -fsS http://localhost:3000/api/cron/fx-rates > /dev/null 2>&1") | crontab -u imsapp -
```

---

## Updating

To deploy a new version:

```bash
# On the production server, as root:
bash /opt/onetwo3d-ims/scripts/update.sh
```

The update script performs:
1. Pre-update database backup (stored in `/var/backups/onetwo3d-ims/`)
2. Git pull of latest code
3. Dependency installation (`npm ci --omit=dev`)
4. Database migration (`prisma migrate deploy`)
5. Next.js production build
6. PM2 process restart
7. Health check

### Update Flags

```bash
bash scripts/update.sh --no-git      # Skip git pull (deploy current files)
bash scripts/update.sh --skip-build  # Migrations + restart only (no rebuild)
```

---

## Process Management

The app runs under PM2:

| Process | Description |
|---|---|
| `onetwo3d-ims` | Next.js web server (port 3000) |
| `onetwo3d-ims-worker` | BullMQ background worker |

### Common PM2 Commands

```bash
pm2 status                        # Show all processes
pm2 logs onetwo3d-ims             # Live web server logs
pm2 logs onetwo3d-ims-worker      # Live worker logs
pm2 restart onetwo3d-ims          # Restart web server
pm2 restart onetwo3d-ims-worker   # Restart worker
pm2 reload onetwo3d-ims           # Zero-downtime reload
pm2 stop onetwo3d-ims             # Stop web server
```

---

## File Locations

| Path | Contents |
|---|---|
| `/opt/onetwo3d-ims/` | Application code |
| `/opt/onetwo3d-ims/.env` | Environment configuration (chmod 600) |
| `/opt/onetwo3d-ims/.next/` | Next.js build output |
| `/opt/onetwo3d-ims/uploads/invoices/` | Uploaded supplier invoice PDFs |
| `/opt/onetwo3d-ims/ecosystem.config.js` | PM2 process configuration |
| `/var/lib/onetwo3d-ims/` | Persistent data (Xero tokens) |
| `/var/log/onetwo3d-ims/` | Application and worker logs |
| `/var/backups/onetwo3d-ims/` | Database backups |
| `/etc/logrotate.d/onetwo3d-ims` | Log rotation configuration |

---

## Backup and Restore

### Automated Backups

The `scripts/backup.sh` script creates compressed PostgreSQL dumps:

```bash
# Manual backup
bash /opt/onetwo3d-ims/scripts/backup.sh

# Custom backup directory
bash /opt/onetwo3d-ims/scripts/backup.sh /path/to/backups
```

Backups are named `backup-YYYYMMDD-HHMMSS.sql.gz` with a `latest.sql.gz` symlink. Old backups are pruned after 30 days (configurable via `BACKUP_KEEP_DAYS` environment variable).

### Restore from Backup

```bash
# Stop the application
pm2 stop onetwo3d-ims

# Restore
gunzip -c /var/backups/onetwo3d-ims/latest.sql.gz | psql $DATABASE_URL

# Restart
pm2 restart onetwo3d-ims
```

---

## Troubleshooting

### App Not Starting

```bash
pm2 logs onetwo3d-ims --lines 50
```

Common causes:
- `DATABASE_URL` incorrect -- test with `psql $DATABASE_URL`
- `AUTH_SECRET` too short -- must be at least 32 characters
- Port conflict -- change the port in the ecosystem config
- Missing build -- run `npm run build` first

### Database Connection Refused

```bash
systemctl status postgresql
psql postgresql://imsuser:password@localhost:5432/onetwo3d_ims
```

### OLS / nginx 502 Bad Gateway

The Next.js process is not running or not listening on the expected port:

```bash
pm2 status
curl -s http://127.0.0.1:3000
```

### Migration Failures

```bash
cd /opt/onetwo3d-ims
npx prisma migrate status --schema prisma/schema.prisma
```

### Xero Token Expired

Xero refresh tokens expire after 60 days of non-use:
1. Visit Settings > Integrations > Xero
2. Disconnect and reconnect

### PDF Generation Errors

PDFKit is configured as a server external package. If PDFs fail to generate:
- Verify `serverExternalPackages: ['pdfkit']` is in `next.config.ts`
- Check that the `pdfkit` package is installed (`node_modules/pdfkit`)
- Check write permissions on `PDF_TEMP_DIR`

---

## Security Recommendations

- Run the app as the non-root `imsapp` system user
- Set `chmod 600` on `.env` -- it contains database passwords and API secrets
- Enable firewall (ufw) and restrict inbound to ports 80, 443, and SSH only
- Always use SSL in production -- never serve over plain HTTP
- Rotate `AUTH_SECRET` periodically (invalidates all sessions)
- Set up automated backups and periodically test restores
- Keep Node.js and system packages updated
- Store the Xero token file (`XERO_TOKEN_PATH`) outside the app directory with `chmod 600`
