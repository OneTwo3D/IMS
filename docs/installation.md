# Installation & Deployment

## Prerequisites

- **Operating system**: Debian 11/12 or Ubuntu 22.04/24.04 (tested in LXC containers)
- **Node.js**: Version 22 (installed automatically by the install script)
- **PostgreSQL**: Version 14 or later (installed automatically, or provide an external connection)
- **nginx**: Used as the reverse proxy (installed automatically)
- **Internet access**: Required during installation for downloading packages


## The Install Script

Run the installer as root:

```bash
bash scripts/install.sh
```

The script performs the following steps:

1. **Pre-flight checks** — verifies root access, detects the OS, and checks internet connectivity
2. **Installs Node.js 22** via NodeSource
3. **Installs and configures PostgreSQL** — creates the database and user
4. **Installs nginx**
5. **Installs PM2** globally for process management
6. **Prompts for configuration** values (see below)
7. **Creates the app system user** (`imsapp`)
8. **Deploys the application** — clones from git or copies from a local directory
9. **Installs npm dependencies** and builds the Next.js application
10. **Runs database migrations** via Prisma
11. **Configures PM2** with an ecosystem file and registers it with systemd
12. **Configures nginx** as a reverse proxy
13. **Sets up cron jobs** for scheduled tasks
14. **Prints a post-install summary** with next steps

For unattended installation, use `--non-interactive` and set configuration values as environment variables.


## Configuration Prompts

The installer asks for the following values during setup. Press Enter to accept the default shown in brackets.

### Application
- **Domain name** — the hostname for your installation (e.g. `ims.yourdomain.com`)
- **Internal port** — the port the app listens on (default: `3000`)

### Database
- **Install PostgreSQL** — install on this server, or connect to an external database
- **Database name** (default: `one_two_inventory`)
- **Database user** (default: `imsuser`)
- **Database password** — auto-generated if not provided

### Redis
- **Redis URL** (default: `redis://localhost:6379`)
- **Redis password** — leave blank if not required

### WooCommerce (Optional)
- Store URL, consumer key, consumer secret, webhook secret
- Can be configured later in Settings

### Xero (Optional)
- Client ID and client secret
- Can be configured later in Settings

### nginx & SSL
- **Configure nginx** — set up the reverse proxy (default: yes)
- **Enable SSL** — obtain a Let's Encrypt certificate via certbot


## Directory Structure

| Path | Purpose |
|---|---|
| `/opt/one-two-inventory` | Application root directory |
| `/opt/one-two-inventory/.env` | Environment configuration (chmod 600) |
| `/var/lib/one-two-inventory/backups` | Runtime backup storage directory used by backup create/restore/upload flows |
| `/opt/one-two-inventory/uploads` | Uploaded files (invoices, etc.) |
| `/opt/one-two-inventory/public/uploads/branding` | Logo and branding images |
| `/opt/one-two-inventory/public/uploads/avatars` | User avatar images |
| `/var/lib/one-two-inventory` | Persistent data directory |
| `/var/log/one-two-inventory` | Application logs |


## PM2 Process Management

The application runs under PM2 with automatic restarts and systemd integration.

### Common Commands

```bash
# View process status
pm2 status

# View live logs
pm2 logs one-two-inventory

# Restart the application
pm2 restart one-two-inventory

# Stop the application
pm2 stop one-two-inventory

# Start the application
pm2 start one-two-inventory
```

PM2 is configured with:
- Automatic restart on crash
- Maximum memory restart at 1 GB
- Log files in `/var/log/one-two-inventory/`
- Systemd service for boot persistence


## Cron Jobs

Five scheduled tasks are configured automatically:

| Time | Endpoint | Purpose |
|---|---|---|
| 02:00 | `/api/cron/backup` | Scheduled backup (if enabled in settings) with retention and remote upload |
| 03:00 | `/api/cron/activity-cleanup` | Purge activity log entries past their retention period |
| 04:00 | `/api/cron/wc-reconcile` | WooCommerce backup reconciliation for orders/products plus stock retry draining |
| Every 15 min | `/api/cron/delivery-status` | Poll delivery tracking providers for shipment status updates |
| 06:00 | `/api/cron/fx-rates` | Fetch latest exchange rates from frankfurter.dev |

All cron jobs run under the `imsapp` user and call the application's API endpoints via `curl`. Cron endpoints require the `CRON_SECRET` header or a request from localhost for security.

For WooCommerce specifically:

- real-time order/product intake should come from webhooks
- `/api/cron/wc-reconcile` is the daily backup reconcile path for orders/products and also runs the stock catch-up plus queued retry drain

Authentication note:

- login and TOTP throttling are currently in-process only
- this deployment assumes a single application instance/LXC
- if you add a second web instance or separate worker handling auth routes, move rate limiting to shared storage such as Redis before doing so


## Updating

To update to a newer version:

```bash
cd /opt/one-two-inventory

# Pull latest code
git pull origin main

# Install dependencies
npm ci --omit=dev

# Run database migrations
npx prisma generate --schema prisma/schema.prisma
npx prisma migrate deploy --schema prisma/schema.prisma

# Rebuild
npm run build

# Restart
pm2 restart one-two-inventory
```


## Environment Variables Reference

Key variables in the `.env` file:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Public URL of the application (e.g. `https://ims.yourdomain.com`) |
| `NODE_ENV` | Set to `production` for deployment |
| `AUTH_SECRET` | Secret key for signing session tokens (auto-generated) |
| `ENCRYPTION_KEY` | Key used to encrypt sensitive values stored in the database (auto-generated) |
| `AUTH_URL` | Authentication callback URL (same as app URL) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection URL |
| `REDIS_PASSWORD` | Redis password (if required) |
| `WC_STORE_URL` | WooCommerce store URL |
| `WC_CONSUMER_KEY` | WooCommerce API consumer key |
| `WC_CONSUMER_SECRET` | WooCommerce API consumer secret |
| `WC_WEBHOOK_SECRET` | Secret for verifying WooCommerce webhooks |
| `XERO_CLIENT_ID` | Xero OAuth client ID |
| `XERO_CLIENT_SECRET` | Xero OAuth client secret |
| `FX_BASE_CURRENCY` | Base currency for exchange rates (default: `GBP`) |
| `PDF_TEMP_DIR` | Temporary directory for PDF generation |
| `BACKUP_DIR` | Local backup storage directory |
| `UPLOAD_MAX_SIZE_MB` | Maximum upload file size in MB (default: `10`) |
| `CRON_SECRET` | Shared secret for authenticating cron endpoint requests |
| `SMTP_HOST` | SMTP server hostname if you choose to manage mail via env rather than app settings |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP authentication username |
| `SMTP_PASS` | SMTP authentication password |


## Reverse Proxy

The installer generates an nginx configuration at `/etc/nginx/sites-available/one-two-inventory` with:

- Upstream connection to the Next.js process on the configured port
- WebSocket support for hot-reload (development) and real-time features
- Security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy)
- Client upload limit of 20 MB
- Extended timeouts for long-running requests (PDF generation, imports)
- Dedicated location block for webhook endpoints


## SSL

When SSL is enabled during installation, the script:

1. Installs **certbot** with the nginx plugin
2. Obtains a Let's Encrypt certificate for your domain
3. Configures automatic HTTPS redirect
4. Certbot handles automatic certificate renewal

To enable SSL after installation:

```bash
certbot --nginx -d ims.yourdomain.com
```
