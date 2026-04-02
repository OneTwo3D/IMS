# Deployment Guide

This guide covers deploying OneTwo3D IMS to a production LXC container on a Proxmox host (or any Debian/Ubuntu server).

## Prerequisites

### Production Server Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| OS | Debian 11 / Ubuntu 22.04 | Debian 12 / Ubuntu 24.04 |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB | 40 GB |
| Network | Internet access | Static IP or hostname |

### External Services Required

| Service | Purpose | Notes |
|---|---|---|
| PostgreSQL | Primary database | Can be on a separate LXC |
| Redis | Background job queues | Existing Redis LXC is supported |
| WooCommerce store | Order/product sync | REST API + webhooks must be enabled |
| Xero (UK) | Accounting sync | OAuth 2.0 app required |
| exchangerate-api.com | Live FX rates | Free tier is sufficient |
| SMTP server | PO/RFQ emails | Any transactional SMTP provider |

### Domain / DNS

- A DNS A record pointing your chosen domain (e.g. `ims.yourdomain.com`) to the server's IP address is required before enabling SSL.
- If using the app internally (no public domain), use an internal hostname and skip SSL.

---

## Automated Installation

The installer script handles everything interactively.

### Step 1 — Prepare the LXC container

On your Proxmox host, create a new LXC container:

```bash
# Example using Debian 12 template
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname ims \
  --memory 4096 \
  --cores 4 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --start 1
```

Then enter the container:

```bash
pct enter 200
```

### Step 2 — Run the installer

```bash
# Option A: Clone the repo first, then run the installer
apt-get install -y git
git clone https://github.com/yourorg/onetwo3d-ims.git /tmp/onetwo3d-ims
bash /tmp/onetwo3d-ims/scripts/install.sh

# Option B: Copy from development server via rsync
rsync -avz /root/ims/onetwo3d-ims/ root@production-ip:/tmp/onetwo3d-ims/
bash /tmp/onetwo3d-ims/scripts/install.sh
```

The installer will prompt for all required values. See [Configuration Reference](configuration.md) for details on each setting.

### Step 3 — Create the first admin user

After installation completes:

```bash
cd /opt/onetwo3d-ims
npm run cli -- create-user
```

Follow the prompts to set email, name, and password for the first admin account.

### Step 4 — Connect Xero

1. Visit `https://ims.yourdomain.com/settings/integrations/xero`
2. Click **Connect to Xero** — you will be redirected to Xero's OAuth login
3. Authorise the IMS application
4. Return to Settings and import your Chart of Accounts

### Step 5 — Configure WooCommerce Webhooks

In your WooCommerce store (`WooCommerce → Settings → Advanced → Webhooks`), create the following webhooks pointing to your IMS:

| Name | Topic | Delivery URL |
|---|---|---|
| IMS Order Created | Order created | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Order Updated | Order updated | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Order Deleted | Order deleted | `https://ims.yourdomain.com/api/webhooks/woocommerce` |
| IMS Product Updated | Product updated | `https://ims.yourdomain.com/api/webhooks/woocommerce` |

Set the **Secret** on each webhook to the same value as `WC_WEBHOOK_SECRET` in your `.env`.

### Step 6 — Import existing data

In the IMS Settings → Import:

1. **Products** — sync from WooCommerce (pulls all products and variants via API)
2. **COGS** — upload CSV with columns: `sku, unit_cost_gbp` (sets opening FIFO layer)
3. **Suppliers** — upload CSV (see `docs/import-templates/suppliers.csv`)
4. **BOMs** — upload CSV (see `docs/import-templates/boms.csv`)

### Step 7 — Set up automated backups

Add to root's crontab (`crontab -e`):

```cron
# Daily backup at 02:00
0 2 * * * /bin/bash /opt/onetwo3d-ims/scripts/backup.sh >> /var/log/onetwo3d-ims/backup.log 2>&1
```

---

## Manual Installation

If you prefer to install components individually:

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

### 3. Install nginx

```bash
apt-get install -y nginx
```

### 4. Deploy application

```bash
# Create app user
useradd --system --shell /bin/bash --home-dir /opt/onetwo3d-ims --create-home imsapp

# Clone or copy app
git clone https://github.com/yourorg/onetwo3d-ims.git /opt/onetwo3d-ims
chown -R imsapp:imsapp /opt/onetwo3d-ims

# Configure environment
cp /opt/onetwo3d-ims/.env.example /opt/onetwo3d-ims/.env
chmod 600 /opt/onetwo3d-ims/.env
# Edit .env with your values

# Install dependencies and build
cd /opt/onetwo3d-ims
sudo -u imsapp npm ci --omit=dev
sudo -u imsapp npx prisma migrate deploy
sudo -u imsapp npm run build
```

### 5. Start with PM2

```bash
sudo -u imsapp pm2 start /opt/onetwo3d-ims/ecosystem.config.js
pm2 startup systemd -u imsapp --hp /opt/onetwo3d-ims | tail -1 | bash
pm2 save
```

### 6. Configure nginx

Copy the nginx config from `deploy/nginx.conf.example` (or from the output of `install.sh`) to `/etc/nginx/sites-available/onetwo3d-ims` and enable it:

```bash
ln -s /etc/nginx/sites-available/onetwo3d-ims /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 7. Enable SSL (optional)

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d ims.yourdomain.com
```

---

## Updating

To deploy a new version:

```bash
# On the production server, as root:
bash /opt/onetwo3d-ims/scripts/update.sh
```

This will:
1. Create a pre-update database backup
2. Pull the latest code from git
3. Install any new dependencies
4. Run new migrations
5. Rebuild the Next.js app
6. Restart the PM2 processes
7. Perform a health check

### Update flags

```bash
bash scripts/update.sh --no-git      # Skip git pull (deploy from current files)
bash scripts/update.sh --skip-build  # Run migrations + restart only (no rebuild)
```

---

## Process Management

The app runs under PM2 with two processes:

| Process | Description |
|---|---|
| `onetwo3d-ims` | Next.js web server |
| `onetwo3d-ims-worker` | BullMQ background worker (FX sync, Xero sync, WC polling) |

### Common PM2 commands

```bash
pm2 status                        # Show all processes
pm2 logs onetwo3d-ims             # Live web server logs
pm2 logs onetwo3d-ims-worker      # Live worker logs
pm2 restart onetwo3d-ims          # Restart web server
pm2 restart onetwo3d-ims-worker   # Restart worker
pm2 reload onetwo3d-ims           # Zero-downtime reload
pm2 stop onetwo3d-ims             # Stop web server
pm2 delete all                    # Remove all PM2 processes
```

---

## File Locations

| Path | Contents |
|---|---|
| `/opt/onetwo3d-ims/` | Application code |
| `/opt/onetwo3d-ims/.env` | Environment configuration |
| `/opt/onetwo3d-ims/ecosystem.config.js` | PM2 process configuration |
| `/var/lib/onetwo3d-ims/` | Persistent data (Xero tokens, etc.) |
| `/var/log/onetwo3d-ims/` | Application logs |
| `/var/backups/onetwo3d-ims/` | Database backups |
| `/etc/nginx/sites-available/onetwo3d-ims` | nginx configuration |
| `/etc/logrotate.d/onetwo3d-ims` | Log rotation configuration |

---

## Troubleshooting

### App not starting

```bash
pm2 logs onetwo3d-ims --lines 50
```

Common causes:
- `DATABASE_URL` incorrect — test with `psql $DATABASE_URL`
- `AUTH_SECRET` too short — must be at least 32 characters
- Port already in use — change `APP_PORT` in `.env`

### Database connection refused

```bash
systemctl status postgresql
psql postgresql://imsuser:password@localhost:5432/onetwo3d_ims
```

### nginx 502 Bad Gateway

The app is not running or not listening on the expected port. Check:

```bash
pm2 status
curl http://127.0.0.1:3000/api/health
```

### Migrations failed

```bash
cd /opt/onetwo3d-ims
DATABASE_URL=$(grep DATABASE_URL .env | cut -d= -f2-) npx prisma migrate status
```

### Xero token expired

Xero refresh tokens are valid for 60 days. If the token expires:
1. Visit `https://ims.yourdomain.com/settings/integrations/xero`
2. Click **Disconnect**, then **Connect to Xero** again

---

## Security Recommendations

- Run the app as the non-root `imsapp` system user (the installer does this automatically)
- Set `chmod 600` on `.env` — it contains database passwords and API secrets
- Enable ufw and restrict inbound to ports 80, 443, and SSH only
- Enable SSL — never run in production over plain HTTP
- Rotate `AUTH_SECRET` periodically (requires all users to log in again)
- Set up automated backups and test restores regularly
- Keep Node.js and system packages updated
