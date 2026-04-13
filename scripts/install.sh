#!/usr/bin/env bash
# =============================================================================
# One Two Inventory — Production Installer
# =============================================================================
# Supported OS : Debian 11/12, Ubuntu 22.04/24.04 (LXC containers)
# Run as       : root  (or with sudo)
# Usage        : bash install.sh [--non-interactive]
#
# What this script does:
#   1. Checks prerequisites and OS compatibility
#   2. Installs Node.js 22 (via NodeSource)
#   3. Installs and configures PostgreSQL
#   4. Installs nginx
#   5. Installs PM2 process manager
#   6. Prompts for all configuration values
#   7. Creates the app system user
#   8. Clones the repository (or copies local files)
#   9. Installs npm dependencies and builds the app
#  10. Runs database migrations
#  11. Writes the systemd service (via PM2)
#  12. Configures nginx reverse proxy
#  13. Sets up cron jobs (FX rates, activity cleanup, backups, WC sync, delivery status)
#  14. Prints post-install summary
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

header() {
  echo ""
  echo -e "${BOLD}${BLUE}============================================================================${RESET}"
  echo -e "${BOLD}${BLUE}  $*${RESET}"
  echo -e "${BOLD}${BLUE}============================================================================${RESET}"
  echo ""
}

# ---------------------------------------------------------------------------
# Defaults (overridden by prompts or --non-interactive env vars)
# ---------------------------------------------------------------------------
APP_NAME="one-two-inventory"
APP_USER="imsapp"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
LOG_DIR="/var/log/${APP_NAME}"
BACKUP_DIR="${DATA_DIR}/backups"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
NODE_VERSION="22"

NON_INTERACTIVE=false
[[ "${1:-}" == "--non-interactive" ]] && NON_INTERACTIVE=true

# ---------------------------------------------------------------------------
# Helper: prompt with default
# ---------------------------------------------------------------------------
prompt() {
  local varname="$1" question="$2" default="$3" secret="${4:-}"
  if $NON_INTERACTIVE; then
    eval "$varname=\"\${$varname:-$default}\""
    return
  fi
  if [[ "$secret" == "secret" ]]; then
    read -r -s -p "$(echo -e "${BOLD}${question}${RESET} [${default}]: ")" input
    echo ""
  else
    read -r -p "$(echo -e "${BOLD}${question}${RESET} [${default}]: ")" input
  fi
  eval "$varname=\"\${input:-$default}\""
}

prompt_yn() {
  local varname="$1" question="$2" default="${3:-y}"
  if $NON_INTERACTIVE; then
    eval "$varname=\"\${$varname:-$default}\""
    return
  fi
  local options="[Y/n]"; [[ "$default" == "n" ]] && options="[y/N]"
  read -r -p "$(echo -e "${BOLD}${question}${RESET} ${options}: ")" input
  input="${input:-$default}"
  eval "$varname=\"${input,,}\""
}

# ---------------------------------------------------------------------------
# 1. Pre-flight checks
# ---------------------------------------------------------------------------
header "Pre-flight checks"

[[ $EUID -ne 0 ]] && die "This script must be run as root. Try: sudo bash install.sh"

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="${ID}"
  OS_VERSION="${VERSION_ID}"
  info "Detected OS: ${PRETTY_NAME}"
  case "${OS_ID}" in
    debian|ubuntu) ;;
    *) warn "Untested OS '${OS_ID}'. Proceeding anyway — results may vary." ;;
  esac
else
  die "Cannot detect OS. /etc/os-release not found."
fi

if ! curl -fsS --max-time 5 https://deb.nodesource.com > /dev/null 2>&1; then
  die "No internet connectivity. This installer requires internet access."
fi

success "Pre-flight checks passed."

# ---------------------------------------------------------------------------
# 2. Collect configuration
# ---------------------------------------------------------------------------
header "Configuration"

echo -e "${YELLOW}Please provide the following configuration values."
echo -e "Press Enter to accept the default shown in brackets.${RESET}"
echo ""

# App source
prompt_yn INSTALL_FROM_GIT "Clone app from a git repository?" "y"
if [[ "$INSTALL_FROM_GIT" == "y" ]]; then
  prompt GIT_REPO_URL  "Git repository URL" "https://github.com/yourorg/one-two-inventory.git"
  prompt GIT_BRANCH    "Branch to deploy"   "main"
else
  prompt LOCAL_SOURCE_DIR "Path to local app directory (will be copied)" "/root/ims/onetwoinventory"
fi

echo ""
info "--- Application ---"
prompt APP_DOMAIN      "Domain name (e.g. ims.yourdomain.com)" "ims.localhost"
prompt APP_PORT        "Internal port the app listens on"       "3000"

echo ""
info "--- PostgreSQL ---"
prompt_yn INSTALL_POSTGRES "Install PostgreSQL on this server?" "y"
if [[ "$INSTALL_POSTGRES" == "y" ]]; then
  prompt DB_NAME      "Database name"           "one_two_inventory"
  prompt DB_USER      "Database user"           "imsuser"
  prompt DB_PASSWORD  "Database password"       "$(openssl rand -hex 16)" "secret"
  DB_HOST="localhost"
  DB_PORT="5432"
else
  prompt DB_HOST      "PostgreSQL host"         "localhost"
  prompt DB_PORT      "PostgreSQL port"         "5432"
  prompt DB_NAME      "Database name"           "one_two_inventory"
  prompt DB_USER      "Database user"           "imsuser"
  prompt DB_PASSWORD  "Database password"       "" "secret"
fi

echo ""
info "--- Redis ---"
prompt REDIS_URL      "Redis URL (redis://host:port)" "redis://localhost:6379"
prompt REDIS_PASSWORD "Redis password (leave blank if none)" ""

echo ""
info "--- WooCommerce (optional — can be configured later in Settings) ---"
prompt WC_STORE_URL       "WooCommerce store URL"      ""
prompt WC_CONSUMER_KEY    "WooCommerce consumer key"   ""
prompt WC_CONSUMER_SECRET "WooCommerce consumer secret" "" "secret"
prompt WC_WEBHOOK_SECRET  "WooCommerce webhook secret"  "$(openssl rand -hex 16)" "secret"

echo ""
info "--- Xero (optional — can be configured later in Settings) ---"
prompt XERO_CLIENT_ID     "Xero client ID"     ""
prompt XERO_CLIENT_SECRET "Xero client secret" "" "secret"

echo ""
info "--- nginx ---"
prompt_yn CONFIGURE_NGINX "Configure nginx reverse proxy?" "y"
if [[ "$CONFIGURE_NGINX" == "y" ]]; then
  prompt_yn ENABLE_SSL "Enable SSL with Let's Encrypt (certbot)?" "n"
  if [[ "$ENABLE_SSL" == "y" ]]; then
    prompt SSL_EMAIL "Email address for Let's Encrypt notifications" "admin@${APP_DOMAIN}"
  fi
fi

echo ""
echo -e "${YELLOW}Configuration collected. Starting installation...${RESET}"
sleep 1

# ---------------------------------------------------------------------------
# 3. System packages
# ---------------------------------------------------------------------------
header "Installing system packages"

apt-get update -qq
apt-get install -y -qq \
  curl wget gnupg2 ca-certificates lsb-release \
  git build-essential \
  nginx \
  openssl \
  logrotate

success "Base packages installed."

# ---------------------------------------------------------------------------
# 4. Node.js
# ---------------------------------------------------------------------------
header "Installing Node.js ${NODE_VERSION}"

if command -v node &>/dev/null && [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -ge "$NODE_VERSION" ]]; then
  success "Node.js $(node --version) already installed."
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
  success "Node.js $(node --version) installed."
fi

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --quiet
  success "PM2 installed."
else
  success "PM2 already installed."
fi

# ---------------------------------------------------------------------------
# 5. PostgreSQL
# ---------------------------------------------------------------------------
header "PostgreSQL setup"

if [[ "$INSTALL_POSTGRES" == "y" ]]; then
  if ! command -v psql &>/dev/null; then
    apt-get install -y -qq postgresql postgresql-contrib
    systemctl enable postgresql
    systemctl start postgresql
    success "PostgreSQL installed and started."
  else
    success "PostgreSQL already installed."
  fi

  info "Creating database '${DB_NAME}' and user '${DB_USER}'..."
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = '${DB_USER}') THEN
        CREATE USER "${DB_USER}" WITH PASSWORD '${DB_PASSWORD}';
      ELSE
        ALTER USER "${DB_USER}" WITH PASSWORD '${DB_PASSWORD}';
      END IF;
    END
    \$\$;
    SELECT 'CREATE DATABASE ${DB_NAME}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${DB_NAME}') \gexec
    GRANT ALL PRIVILEGES ON DATABASE "${DB_NAME}" TO "${DB_USER}";
    ALTER DATABASE "${DB_NAME}" OWNER TO "${DB_USER}";
EOSQL
  success "Database '${DB_NAME}' and user '${DB_USER}' ready."
fi

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# ---------------------------------------------------------------------------
# 6. App user and directories
# ---------------------------------------------------------------------------
header "Creating app user and directories"

if ! id "${APP_USER}" &>/dev/null; then
  useradd --system --shell /bin/bash --home-dir "${APP_DIR}" --create-home "${APP_USER}"
  success "System user '${APP_USER}' created."
else
  success "System user '${APP_USER}' already exists."
fi

mkdir -p "${DATA_DIR}" "${LOG_DIR}" "${BACKUP_DIR}" \
  "${DATA_DIR}/xero" \
  "${APP_DIR}/uploads/invoices" \
  "${APP_DIR}/public/uploads/branding" \
  "${APP_DIR}/public/uploads/avatars" \
  "${APP_DIR}/backups" \
  /tmp/${APP_NAME}/pdf \
  /tmp/${APP_NAME}/uploads

chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${LOG_DIR}"

success "Directories created."

# ---------------------------------------------------------------------------
# 7. Deploy application code
# ---------------------------------------------------------------------------
header "Deploying application"

if [[ "$INSTALL_FROM_GIT" == "y" ]]; then
  if [[ -d "${APP_DIR}/.git" ]]; then
    info "Repository already exists — pulling latest..."
    sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch origin
    sudo -u "${APP_USER}" git -C "${APP_DIR}" reset --hard "origin/${GIT_BRANCH}"
    success "Repository updated."
  else
    info "Cloning ${GIT_REPO_URL} (branch: ${GIT_BRANCH})..."
    sudo -u "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
      "${GIT_REPO_URL}" "${APP_DIR}"
    success "Repository cloned."
  fi
else
  info "Copying from ${LOCAL_SOURCE_DIR}..."
  rsync -a --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='.env' \
    --exclude='backups' \
    "${LOCAL_SOURCE_DIR%/}/" "${APP_DIR}/"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  success "Files copied."
fi

# ---------------------------------------------------------------------------
# 8. Write .env file
# ---------------------------------------------------------------------------
header "Writing .env configuration"

AUTH_SECRET="$(openssl rand -base64 32)"
CRON_SECRET="$(openssl rand -hex 32)"

cat > "${APP_DIR}/.env" <<EOF
# One Two Inventory — generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

NEXT_PUBLIC_APP_URL=https://${APP_DOMAIN}
NODE_ENV=production
AUTH_SECRET=${AUTH_SECRET}
AUTH_URL=https://${APP_DOMAIN}

DATABASE_URL=${DATABASE_URL}

REDIS_URL=${REDIS_URL}
REDIS_PASSWORD=${REDIS_PASSWORD}

WC_STORE_URL=${WC_STORE_URL}
WC_CONSUMER_KEY=${WC_CONSUMER_KEY}
WC_CONSUMER_SECRET=${WC_CONSUMER_SECRET}
WC_WEBHOOK_SECRET=${WC_WEBHOOK_SECRET}
WC_SYNC_STATUSES=processing
WC_USE_WEBHOOKS=true
WC_POLL_INTERVAL_MINUTES=5

XERO_CLIENT_ID=${XERO_CLIENT_ID}
XERO_CLIENT_SECRET=${XERO_CLIENT_SECRET}
XERO_TENANT_ID=
XERO_TOKEN_PATH=${DATA_DIR}/xero/token.json

CRON_SECRET=${CRON_SECRET}

FX_BASE_CURRENCY=GBP

PDF_TEMP_DIR=/tmp/${APP_NAME}/pdf
UPLOAD_MAX_SIZE_MB=10
UPLOAD_TEMP_DIR=/tmp/${APP_NAME}/uploads

LOG_LEVEL=info
LOG_FORMAT=json
EOF

chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
success ".env written to ${APP_DIR}/.env"

# ---------------------------------------------------------------------------
# 9. Install dependencies and build
# ---------------------------------------------------------------------------
header "Installing npm dependencies"

sudo -u "${APP_USER}" npm ci --prefix "${APP_DIR}" --omit=dev 2>&1 | \
  grep -v "^npm warn" || true
success "Dependencies installed."

header "Running database migrations"

cd "${APP_DIR}"
sudo -u "${APP_USER}" DATABASE_URL="${DATABASE_URL}" \
  npx prisma generate --schema prisma/schema.prisma
sudo -u "${APP_USER}" DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Database migrations applied."

header "Seeding database"

sudo -u "${APP_USER}" DATABASE_URL="${DATABASE_URL}" \
  npx prisma db seed 2>/dev/null || warn "Seeding skipped (may already be seeded)."

header "Building Next.js application"

sudo -u "${APP_USER}" npm run build --prefix "${APP_DIR}"
success "Build complete."

# ---------------------------------------------------------------------------
# 10. PM2 ecosystem file + systemd
# ---------------------------------------------------------------------------
header "Setting up PM2 process manager"

cat > "${APP_DIR}/ecosystem.config.js" <<EOF
// PM2 ecosystem configuration — auto-generated by install.sh
module.exports = {
  apps: [
    {
      name: '${APP_NAME}',
      cwd: '${APP_DIR}',
      script: 'node_modules/.bin/next',
      args: 'start -p ${APP_PORT}',
      user: '${APP_USER}',
      env_file: '${APP_DIR}/.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      log_file: '${LOG_DIR}/app.log',
      error_file: '${LOG_DIR}/error.log',
      out_file: '${LOG_DIR}/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
EOF

chown "${APP_USER}:${APP_USER}" "${APP_DIR}/ecosystem.config.js"

pm2 delete "${APP_NAME}" 2>/dev/null || true
pm2 start "${APP_DIR}/ecosystem.config.js"
pm2 save

pm2 startup systemd -u "${APP_USER}" --hp "${APP_DIR}" | tail -1 | bash || true
systemctl enable "pm2-${APP_USER}" 2>/dev/null || true

success "PM2 processes started and registered with systemd."

# ---------------------------------------------------------------------------
# 11. nginx configuration
# ---------------------------------------------------------------------------
if [[ "$CONFIGURE_NGINX" == "y" ]]; then
  header "Configuring nginx"

  cat > "${NGINX_CONF}" <<EOF
# One Two Inventory — nginx reverse proxy
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

upstream ${APP_NAME}_upstream {
    server 127.0.0.1:${APP_PORT};
    keepalive 64;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${APP_DOMAIN};

    add_header X-Frame-Options        "SAMEORIGIN"   always;
    add_header X-Content-Type-Options "nosniff"      always;
    add_header X-XSS-Protection       "1; mode=block" always;
    add_header Referrer-Policy        "strict-origin-when-cross-origin" always;

    access_log /var/log/nginx/${APP_NAME}-access.log;
    error_log  /var/log/nginx/${APP_NAME}-error.log;

    client_max_body_size 20M;

    location / {
        proxy_pass         http://${APP_NAME}_upstream;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    location /api/webhooks/ {
        proxy_pass         http://${APP_NAME}_upstream;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF

  ln -sf "${NGINX_CONF}" "/etc/nginx/sites-enabled/${APP_NAME}"
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

  nginx -t && systemctl reload nginx
  success "nginx configured and reloaded."

  if [[ "$ENABLE_SSL" == "y" ]]; then
    header "Setting up SSL (Let's Encrypt)"
    if ! command -v certbot &>/dev/null; then
      apt-get install -y -qq certbot python3-certbot-nginx
    fi
    certbot --nginx \
      --non-interactive \
      --agree-tos \
      --email "${SSL_EMAIL}" \
      --domains "${APP_DOMAIN}" \
      --redirect
    success "SSL certificate issued and nginx updated."
  fi
fi

# ---------------------------------------------------------------------------
# 12. Log rotation
# ---------------------------------------------------------------------------
header "Configuring log rotation"

cat > "/etc/logrotate.d/${APP_NAME}" <<EOF
${LOG_DIR}/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        pm2 reloadLogs 2>/dev/null || true
    endscript
}
/var/log/nginx/${APP_NAME}-*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        nginx -s reopen 2>/dev/null || true
    endscript
}
EOF

success "Log rotation configured."

# ---------------------------------------------------------------------------
# 13. Cron jobs
# ---------------------------------------------------------------------------
header "Setting up cron jobs"

CRON_LINES=(
  "0 6 * * * curl -fsS http://localhost:${APP_PORT}/api/cron/fx-rates > /dev/null 2>&1"
  "0 3 * * * curl -fsS http://localhost:${APP_PORT}/api/cron/activity-cleanup > /dev/null 2>&1"
  "0 2 * * * curl -fsS http://localhost:${APP_PORT}/api/cron/backup > /dev/null 2>&1"
  "*/5 * * * * curl -fsS http://localhost:${APP_PORT}/api/cron/wc-sync > /dev/null 2>&1"
  "*/15 * * * * curl -fsS http://localhost:${APP_PORT}/api/cron/delivery-status > /dev/null 2>&1"
)

{
  crontab -u "${APP_USER}" -l 2>/dev/null || true
  for line in "${CRON_LINES[@]}"; do
    echo "$line"
  done
} | sort -u | crontab -u "${APP_USER}" -

success "Cron jobs configured:"
echo "  - 02:00 Daily scheduled backup (if enabled in settings)"
echo "  - 03:00 Activity log cleanup"
echo "  - Every 5 min WooCommerce sync polling"
echo "  - Every 15 min Delivery status polling"
echo "  - 06:00 FX rate update"

# ---------------------------------------------------------------------------
# 14. Firewall hints (ufw)
# ---------------------------------------------------------------------------
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  header "Firewall"
  ufw allow 80/tcp  comment "${APP_NAME} HTTP"  2>/dev/null || true
  ufw allow 443/tcp comment "${APP_NAME} HTTPS" 2>/dev/null || true
  success "ufw rules added for ports 80 and 443."
fi

# ---------------------------------------------------------------------------
# 15. Post-install summary
# ---------------------------------------------------------------------------
header "Installation complete!"

echo -e "${GREEN}${BOLD}One Two Inventory has been installed successfully.${RESET}"
echo ""
echo -e "  App directory  : ${BOLD}${APP_DIR}${RESET}"
echo -e "  Config file    : ${BOLD}${APP_DIR}/.env${RESET}"
echo -e "  Logs           : ${BOLD}${LOG_DIR}${RESET}"
echo -e "  Data           : ${BOLD}${DATA_DIR}${RESET}"
echo -e "  Backups        : ${BOLD}${APP_DIR}/backups${RESET}"
echo -e "  Database       : ${BOLD}${DB_NAME}${RESET} @ ${DB_HOST}:${DB_PORT}"
echo ""
echo -e "  App URL        : ${BOLD}http${ENABLE_SSL:+s}://${APP_DOMAIN}${RESET}"
echo ""
echo -e "${YELLOW}${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Create the first admin user:"
echo -e "     ${BOLD}cd ${APP_DIR} && npm run cli -- create-user${RESET}"
echo ""
echo -e "  2. Configure company settings:"
echo -e "     Visit ${BOLD}http${ENABLE_SSL:+s}://${APP_DOMAIN}/settings/company${RESET}"
echo -e "     Set up company name, logos, branding, document templates, email"
echo ""
echo -e "  3. Configure backup strategy:"
echo -e "     Visit ${BOLD}http${ENABLE_SSL:+s}://${APP_DOMAIN}/settings/backup${RESET}"
echo -e "     Set up S3 or SFTP remote storage and enable scheduled backups"
echo ""
echo -e "  4. Configure WooCommerce (optional):"
echo -e "     Set up WC sync in ${BOLD}http${ENABLE_SSL:+s}://${APP_DOMAIN}/sync${RESET}"
echo -e "     Configure webhooks to: ${BOLD}https://${APP_DOMAIN}/api/webhooks/woocommerce${RESET}"
echo ""
echo -e "  5. Import existing data:"
echo -e "     Products, suppliers, BOMs, stock — all via CSV import in the respective modules"
echo ""
echo -e "  6. View PM2 process status:"
echo -e "     ${BOLD}pm2 status${RESET}"
echo ""
echo -e "  7. View live logs:"
echo -e "     ${BOLD}pm2 logs ${APP_NAME}${RESET}"
echo ""

if [[ "$ENABLE_SSL" != "y" ]]; then
  warn "SSL is not enabled. For production use, re-run with SSL or configure manually."
  echo -e "     ${BOLD}certbot --nginx -d ${APP_DOMAIN}${RESET}"
  echo ""
fi

echo -e "${GREEN}Done.${RESET}"
