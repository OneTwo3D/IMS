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
#   4. Installs nginx, fail2ban, and automatic security updates
#   5. Installs runtime tooling
#   6. Prompts for all configuration values
#   7. Creates the app system user
#   8. Clones the repository (or copies local files)
#   9. Installs npm dependencies and builds the app
#  10. Runs database migrations
#  11. Writes the systemd service
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

run_as_user() {
  local user="$1"
  shift
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$user" -- "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$user" "$@"
  else
    su -s /bin/bash -c "$(printf '%q ' "$@")" "$user"
  fi
}

github_api() {
  local method="$1" path="$2" payload="${3:-}"
  local response_file status
  response_file="$(mktemp -t ims-github.XXXXXX)"
  if [[ -n "${payload}" ]]; then
    status="$(curl -sS -o "${response_file}" -w '%{http_code}' \
      -X "${method}" \
      -H "Authorization: Bearer ${GITHUB_DEPLOY_KEY_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      --data "${payload}" \
      "https://api.github.com${path}")"
  else
    status="$(curl -sS -o "${response_file}" -w '%{http_code}' \
      -X "${method}" \
      -H "Authorization: Bearer ${GITHUB_DEPLOY_KEY_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com${path}")"
  fi
  if [[ ! "${status}" =~ ^2 ]]; then
    cat "${response_file}" >&2
    rm -f "${response_file}"
    die "GitHub API request failed (${method} ${path}) with status ${status}."
  fi
  cat "${response_file}"
  rm -f "${response_file}"
}

derive_github_repo_ref() {
  local url="$1" repo_ref=""
  if [[ "${url}" =~ ^git@github\.com:([^/]+/[^/]+?)(\.git)?$ ]]; then
    repo_ref="${BASH_REMATCH[1]}"
  elif [[ "${url}" =~ ^https://github\.com/([^/]+/[^/]+?)(\.git)?$ ]]; then
    repo_ref="${BASH_REMATCH[1]}"
  fi
  repo_ref="${repo_ref%.git}"
  if [[ -n "${repo_ref}" ]]; then
    printf '%s\n' "${repo_ref}"
  fi
}

git_repo_uses_ssh() {
  local url="$1"
  [[ "${url}" =~ ^git@github\.com: ]] || [[ "${url}" =~ ^ssh://git@github\.com/ ]]
}

run_git_as_user() {
  local user="$1"
  shift

  if [[ "${GIT_DEPLOY_KEY_ENABLED:-n}" == "y" ]]; then
    [[ -f "${DEPLOY_SSH_KEY_PATH}" ]] || die "Missing deploy key: ${DEPLOY_SSH_KEY_PATH}"
    [[ -f "${DEPLOY_SSH_KNOWN_HOSTS}" ]] || die "Missing deploy known_hosts: ${DEPLOY_SSH_KNOWN_HOSTS}"

    run_as_user "${user}" env \
      "GIT_SSH_COMMAND=ssh -i ${DEPLOY_SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${DEPLOY_SSH_KNOWN_HOSTS}" \
      "$@"
  else
    run_as_user "${user}" "$@"
  fi
}

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
UPLOAD_STORAGE_DIR="${DATA_DIR}/uploads"
PUBLIC_UPLOAD_STORAGE_DIR="${DATA_DIR}/public-uploads"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
NODE_VERSION="22"
DEPLOY_SSH_DIR="${DATA_DIR}/git-ssh"
DEPLOY_SSH_KEY_PATH="${DEPLOY_SSH_DIR}/id_ed25519"
DEPLOY_SSH_KNOWN_HOSTS="${DEPLOY_SSH_DIR}/known_hosts"

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

if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 5 https://deb.nodesource.com > /dev/null 2>&1; then
    die "No internet connectivity. This installer requires internet access."
  fi
elif command -v wget >/dev/null 2>&1; then
  if ! wget -q --spider --timeout=5 https://deb.nodesource.com; then
    die "No internet connectivity. This installer requires internet access."
  fi
else
  warn "Neither curl nor wget is installed yet; skipping network pre-flight probe."
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
prompt_yn GIT_DEPLOY_KEY_ENABLED "Configure a per-instance GitHub deploy key for private repo updates?" "n"
if [[ "${GIT_DEPLOY_KEY_ENABLED}" == "y" ]]; then
  if [[ "${INSTALL_FROM_GIT}" != "y" ]]; then
    prompt GIT_REPO_URL "Git repository URL for future updates" "git@github.com:yourorg/one-two-inventory.git"
    prompt GIT_BRANCH "Branch for future updates" "main"
  fi
  git_repo_uses_ssh "${GIT_REPO_URL}" || die "GIT_REPO_URL must use the GitHub SSH form when GIT_DEPLOY_KEY_ENABLED=y."
  prompt GITHUB_DEPLOY_KEY_TOKEN "GitHub token with deploy-key admin access" "" "secret"
  DEFAULT_REPO_REF="$(derive_github_repo_ref "${GIT_REPO_URL:-}")"
  prompt GITHUB_REPO_OWNER "GitHub repo owner/org" "${DEFAULT_REPO_REF%%/*}"
  prompt GITHUB_REPO_NAME "GitHub repo name" "${DEFAULT_REPO_REF##*/}"
  prompt GITHUB_DEPLOY_KEY_TITLE "Deploy key title" "$(hostname -s)-${APP_NAME}"
fi

echo ""
info "--- Application ---"
prompt APP_DOMAIN      "Domain name (e.g. ims.yourdomain.com)" "ims.localhost"
prompt APP_PORT        "Internal port the app listens on"       "3000"
prompt_yn INSTALL_SSHD "Install OpenSSH server on this system?" "n"
if [[ "$INSTALL_SSHD" == "y" ]]; then
  prompt SSH_AUTHORIZED_KEY "Authorized SSH public key for root login (leave blank to skip key install)" ""
fi
prompt DEFAULT_ADMIN_NAME "Default admin name (leave blank to skip auto-create)" ""
prompt DEFAULT_ADMIN_EMAIL "Default admin email (leave blank to skip auto-create)" ""
if [[ -n "${DEFAULT_ADMIN_EMAIL}" ]]; then
  prompt DEFAULT_ADMIN_PASSWORD "Default admin password" "$(openssl rand -base64 18 | tr -d '\n' | cut -c1-20)" "secret"
  prompt NOTIFICATION_EMAIL "Email address to receive the login details" "${DEFAULT_ADMIN_EMAIL}"
fi

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
prompt_yn INSTALL_REDIS "Install Redis on this server?" "n"
if [[ "$INSTALL_REDIS" == "y" ]]; then
  REDIS_HOST="localhost"
  prompt REDIS_PORT     "Redis port" "6379"
  prompt REDIS_PASSWORD "Redis password (leave blank if none)" ""
  REDIS_URL="redis://${REDIS_HOST}:${REDIS_PORT}"
else
  prompt REDIS_URL      "Redis URL (redis://host:port[/db])" "redis://localhost:6379"
  prompt REDIS_PASSWORD "Redis password (leave blank if none)" ""
fi
prompt REDIS_KEY_PREFIX "Redis key prefix (leave blank for none)" ""

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
info "--- Outbound email (optional, required for automatic credential email) ---"
prompt SMTP_HOST      "SMTP host" ""
prompt SMTP_PORT      "SMTP port" "587"
prompt SMTP_USER      "SMTP username" ""
prompt SMTP_PASS      "SMTP password" "" "secret"
prompt SMTP_SECURE    "SMTP security (tls/ssl/none)" "tls"
prompt SMTP_FROM_NAME "SMTP from name" "IMS"
prompt SMTP_FROM_EMAIL "SMTP from email" ""
prompt SMTP_REPLY_TO  "SMTP reply-to email" ""

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
  jq openssh-client \
  rsync \
  nginx \
  fail2ban \
  unattended-upgrades apt-listchanges \
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
  run_as_user postgres psql -v ON_ERROR_STOP=1 <<-EOSQL
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
# 6. SSH
# ---------------------------------------------------------------------------
header "SSH setup"

if [[ "$INSTALL_SSHD" == "y" ]]; then
  if ! command -v sshd &>/dev/null; then
    apt-get install -y -qq openssh-server
    success "OpenSSH server installed."
  else
    success "OpenSSH server already installed."
  fi

  mkdir -p /root/.ssh
  chmod 700 /root/.ssh

  if [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
    printf '%s\n' "${SSH_AUTHORIZED_KEY}" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
  fi

  SSHD_CONFIG="/etc/ssh/sshd_config"
  if [[ -f "${SSHD_CONFIG}" ]]; then
    sed -i -E 's/^#?PermitRootLogin .*/PermitRootLogin prohibit-password/' "${SSHD_CONFIG}" || true
    sed -i -E 's/^#?PubkeyAuthentication .*/PubkeyAuthentication yes/' "${SSHD_CONFIG}" || true
    sed -i -E 's/^#?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' "${SSHD_CONFIG}" || true
    sed -i -E 's/^#?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' "${SSHD_CONFIG}" || true
    if [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
      sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/' "${SSHD_CONFIG}" || true
    fi
  fi

  systemctl enable ssh || systemctl enable sshd || true
  systemctl restart ssh || systemctl restart sshd
  success "SSH server configured and started."
fi

# ---------------------------------------------------------------------------
# 7. Redis
# ---------------------------------------------------------------------------
header "Redis setup"

if [[ "$INSTALL_REDIS" == "y" ]]; then
  if ! command -v redis-server &>/dev/null; then
    apt-get install -y -qq redis-server
    success "Redis installed."
  else
    success "Redis already installed."
  fi

  REDIS_CONF="/etc/redis/redis.conf"
  if [[ -f "${REDIS_CONF}" ]]; then
    sed -i -E "s/^port .*/port ${REDIS_PORT}/" "${REDIS_CONF}"
    sed -i -E "s/^bind .*/bind 127.0.0.1 ::1/" "${REDIS_CONF}" || true
    sed -i -E "s/^protected-mode .*/protected-mode yes/" "${REDIS_CONF}" || true
    if [[ -n "${REDIS_PASSWORD}" ]]; then
      if grep -qE '^[#[:space:]]*requirepass ' "${REDIS_CONF}"; then
        sed -i -E "s|^[#[:space:]]*requirepass .*|requirepass ${REDIS_PASSWORD}|" "${REDIS_CONF}"
      else
        printf '\nrequirepass %s\n' "${REDIS_PASSWORD}" >> "${REDIS_CONF}"
      fi
    else
      sed -i -E "s|^[#[:space:]]*requirepass .*|# requirepass foobared|" "${REDIS_CONF}" || true
    fi
  fi

  systemctl enable redis-server
  systemctl restart redis-server
  success "Redis configured and started."
fi

# ---------------------------------------------------------------------------
# 8. App user and directories
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
  "${UPLOAD_STORAGE_DIR}/invoices" \
  "${UPLOAD_STORAGE_DIR}/quarantine/invoices" \
  "${PUBLIC_UPLOAD_STORAGE_DIR}/branding" \
  "${PUBLIC_UPLOAD_STORAGE_DIR}/avatars" \
  "${APP_DIR}/backups" \
  /tmp/${APP_NAME}/pdf \
  /tmp/${APP_NAME}/uploads

chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${LOG_DIR}"

success "Directories created."

if [[ "${GIT_DEPLOY_KEY_ENABLED:-n}" == "y" ]]; then
  header "Configuring GitHub deploy key"

  [[ -n "${GIT_REPO_URL:-}" ]] || die "GIT_REPO_URL is required when GIT_DEPLOY_KEY_ENABLED=y."
  [[ -n "${GITHUB_DEPLOY_KEY_TOKEN:-}" ]] || die "GITHUB_DEPLOY_KEY_TOKEN is required when GIT_DEPLOY_KEY_ENABLED=y."
  [[ -n "${GITHUB_REPO_OWNER:-}" ]] || die "GITHUB_REPO_OWNER is required when GIT_DEPLOY_KEY_ENABLED=y."
  [[ -n "${GITHUB_REPO_NAME:-}" ]] || die "GITHUB_REPO_NAME is required when GIT_DEPLOY_KEY_ENABLED=y."
  git_repo_uses_ssh "${GIT_REPO_URL}" || die "GIT_REPO_URL must use the GitHub SSH form when GIT_DEPLOY_KEY_ENABLED=y."

  mkdir -p "${DEPLOY_SSH_DIR}"
  chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_SSH_DIR}"
  chmod 700 "${DEPLOY_SSH_DIR}"

  if [[ ! -f "${DEPLOY_SSH_KEY_PATH}" ]]; then
    run_as_user "${APP_USER}" ssh-keygen -q -t ed25519 -N "" -C "${GITHUB_DEPLOY_KEY_TITLE}" -f "${DEPLOY_SSH_KEY_PATH}"
    success "Generated deploy key at ${DEPLOY_SSH_KEY_PATH}."
  else
    info "Reusing existing deploy key at ${DEPLOY_SSH_KEY_PATH}."
  fi

  ssh-keyscan -H github.com > "${DEPLOY_SSH_KNOWN_HOSTS}.tmp" 2>/dev/null
  mv "${DEPLOY_SSH_KNOWN_HOSTS}.tmp" "${DEPLOY_SSH_KNOWN_HOSTS}"
  chmod 600 "${DEPLOY_SSH_KNOWN_HOSTS}"
  chown "${APP_USER}:${APP_USER}" "${DEPLOY_SSH_KNOWN_HOSTS}"

  DEPLOY_PUBLIC_KEY="$(<"${DEPLOY_SSH_KEY_PATH}.pub")"
  EXISTING_KEYS_JSON="$(github_api GET "/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/keys")"
  EXISTING_KEY_ID="$(jq -r --arg key "${DEPLOY_PUBLIC_KEY}" '.[] | select(.key == $key) | .id' <<<"${EXISTING_KEYS_JSON}" | head -n 1)"
  TITLE_KEY_ID="$(jq -r --arg title "${GITHUB_DEPLOY_KEY_TITLE}" '.[] | select(.title == $title) | .id' <<<"${EXISTING_KEYS_JSON}" | head -n 1)"

  if [[ -n "${EXISTING_KEY_ID}" ]]; then
    info "GitHub deploy key already registered on ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}."
  else
    if [[ -n "${TITLE_KEY_ID}" ]]; then
      info "Replacing existing GitHub deploy key titled ${GITHUB_DEPLOY_KEY_TITLE}."
      github_api DELETE "/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/keys/${TITLE_KEY_ID}" >/dev/null
    fi
    GITHUB_PAYLOAD="$(jq -nc \
      --arg title "${GITHUB_DEPLOY_KEY_TITLE}" \
      --arg key "${DEPLOY_PUBLIC_KEY}" \
      '{title:$title,key:$key,read_only:true}')"
    github_api POST "/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/keys" "${GITHUB_PAYLOAD}" >/dev/null
    success "Registered deploy key on GitHub."
  fi

  run_git_as_user "${APP_USER}" git ls-remote --heads "${GIT_REPO_URL}" "${GIT_BRANCH:-main}" >/dev/null
  success "Verified Git access to ${GIT_REPO_URL}."
fi

# ---------------------------------------------------------------------------
# 9. Deploy application code
# ---------------------------------------------------------------------------
header "Deploying application"

if [[ "$INSTALL_FROM_GIT" == "y" ]]; then
  if [[ -d "${APP_DIR}/.git" ]]; then
    info "Repository already exists — pulling latest..."
    run_git_as_user "${APP_USER}" git -C "${APP_DIR}" fetch origin
    run_git_as_user "${APP_USER}" git -C "${APP_DIR}" reset --hard "origin/${GIT_BRANCH}"
    success "Repository updated."
  elif [[ -d "${APP_DIR}" ]] && [[ -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    info "App directory exists but is not a git checkout — syncing fresh code into place..."
    TMP_CLONE_DIR="$(mktemp -d -t oti-sync.XXXXXX)"
    TMP_CLONE_WORKTREE="${TMP_CLONE_DIR}/repo"
    chown "${APP_USER}:${APP_USER}" "${TMP_CLONE_DIR}"
    run_git_as_user "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
      "${GIT_REPO_URL}" "${TMP_CLONE_WORKTREE}"
    rsync -a --delete \
      --exclude='.git' \
      --exclude='.deploy-meta' \
      --exclude='.env' \
      --exclude='.env.local' \
      --exclude='backups' \
      --exclude='uploads' \
      --exclude='public/uploads' \
      "${TMP_CLONE_WORKTREE%/}/" "${APP_DIR}/"
    rm -rf "${APP_DIR}/.git"
    cp -a "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"
    chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
    rm -rf "${TMP_CLONE_DIR}"
    success "Repository synced into existing directory."
  else
    info "Cloning ${GIT_REPO_URL} (branch: ${GIT_BRANCH})..."
    run_git_as_user "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
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
    --exclude='.env.local' \
    --exclude='backups' \
    --exclude='uploads' \
    --exclude='public/uploads' \
    "${LOCAL_SOURCE_DIR%/}/" "${APP_DIR}/"
  rm -f "${APP_DIR}/.env.local"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  success "Files copied."

  if [[ "${GIT_DEPLOY_KEY_ENABLED:-n}" == "y" && -n "${GIT_REPO_URL:-}" ]]; then
    info "Attaching git metadata for future updates..."
    TMP_CLONE_DIR="$(mktemp -d -t oti-gitmeta.XXXXXX)"
    TMP_CLONE_WORKTREE="${TMP_CLONE_DIR}/repo"
    chown "${APP_USER}:${APP_USER}" "${TMP_CLONE_DIR}"
    run_git_as_user "${APP_USER}" git clone --branch "${GIT_BRANCH}" --depth 1 \
      "${GIT_REPO_URL}" "${TMP_CLONE_WORKTREE}"
    rm -rf "${APP_DIR}/.git"
    cp -a "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"
    chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/.git"
    rm -rf "${TMP_CLONE_DIR}"
    success "Git metadata attached."
  fi
fi

DEPLOY_META_FILE="${APP_DIR}/.deploy-meta"
cat > "${DEPLOY_META_FILE}" <<EOF
INSTALL_FROM_GIT=${INSTALL_FROM_GIT}
GIT_REPO_URL=${GIT_REPO_URL:-}
GIT_BRANCH=${GIT_BRANCH:-}
GIT_DEPLOY_KEY_ENABLED=${GIT_DEPLOY_KEY_ENABLED:-n}
EOF
chown "${APP_USER}:${APP_USER}" "${DEPLOY_META_FILE}"
chmod 600 "${DEPLOY_META_FILE}"

# ---------------------------------------------------------------------------
# 10. Write .env file
# ---------------------------------------------------------------------------
header "Writing .env configuration"

AUTH_SECRET="$(openssl rand -base64 32)"
SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
CRON_SECRET="$(openssl rand -hex 32)"

cat > "${APP_DIR}/.env" <<EOF
# One Two Inventory — generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

NODE_ENV=production
APP_PORT=${APP_PORT}
AUTH_SECRET=${AUTH_SECRET}
SETTINGS_ENCRYPTION_KEY=${SETTINGS_ENCRYPTION_KEY}

DATABASE_URL=${DATABASE_URL}
NEXT_PUBLIC_APP_URL=https://${APP_DOMAIN}
AUTH_URL=https://${APP_DOMAIN}

REDIS_URL=${REDIS_URL}
REDIS_PASSWORD=${REDIS_PASSWORD}
REDIS_KEY_PREFIX=${REDIS_KEY_PREFIX}

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
NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}
TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}

FX_BASE_CURRENCY=GBP

PDF_TEMP_DIR=/tmp/${APP_NAME}/pdf
BACKUP_DIR=${BACKUP_DIR}
UPLOAD_MAX_SIZE_MB=10
UPLOAD_STORAGE_DIR=${UPLOAD_STORAGE_DIR}
PUBLIC_UPLOAD_STORAGE_DIR=${PUBLIC_UPLOAD_STORAGE_DIR}
UPLOAD_TEMP_DIR=/tmp/${APP_NAME}/uploads
FILE_SCAN_MODE=disabled
FILE_SCAN_COMMAND_ARGV=
FILE_SCAN_COMMAND=
FILE_SCAN_NAME=
FILE_SCAN_ENV_ALLOWLIST=PATH,HOME,TMPDIR,TEMP,TMP,LANG,LC_ALL
FILE_SCAN_TIMEOUT_MS=30000

LOG_LEVEL=info
LOG_FORMAT=json
EOF

chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
success ".env written to ${APP_DIR}/.env"

# ---------------------------------------------------------------------------
# 11. Install dependencies and build
# ---------------------------------------------------------------------------
header "Installing npm dependencies"

run_as_user "${APP_USER}" npm ci --include=dev --prefix "${APP_DIR}" 2>&1 | \
  grep -v "^npm warn" || true
success "Dependencies installed."

header "Running database migrations"

cd "${APP_DIR}"
run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma generate --schema prisma/schema.prisma
run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Database migrations applied."

header "Validating database schema"

run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" \
  node "${APP_DIR}/scripts/check-prisma-drift.mjs"
success "Database schema matches prisma/schema.prisma."

header "Seeding database"

run_as_user "${APP_USER}" env DATABASE_URL="${DATABASE_URL}" SEED_TEST_ADMIN="false" \
  npm run db:seed --prefix "${APP_DIR}"
success "Database seed applied."

if [[ -n "${DEFAULT_ADMIN_EMAIL}" || -n "${SMTP_HOST}" || -n "${SMTP_FROM_EMAIL}" || -n "${APP_DOMAIN}" ]]; then
  header "Bootstrapping default admin"
  BOOTSTRAP_SCRIPT="${APP_DIR}/scripts/provision-instance.mjs"
  [[ -f "${BOOTSTRAP_SCRIPT}" ]] || BOOTSTRAP_SCRIPT="/root/provision-instance.mjs"

  run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEFAULT_ADMIN_NAME="${DEFAULT_ADMIN_NAME}" \
    DEFAULT_ADMIN_EMAIL="${DEFAULT_ADMIN_EMAIL}" \
    DEFAULT_ADMIN_PASSWORD="${DEFAULT_ADMIN_PASSWORD}" \
    NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-}" \
    APP_DOMAIN="${APP_DOMAIN}" \
    PUBLIC_APP_URL="https://${APP_DOMAIN}" \
    SMTP_HOST="${SMTP_HOST}" \
    SMTP_PORT="${SMTP_PORT}" \
    SMTP_USER="${SMTP_USER}" \
    SMTP_PASS="${SMTP_PASS}" \
    SMTP_SECURE="${SMTP_SECURE}" \
    SMTP_FROM_NAME="${SMTP_FROM_NAME}" \
    SMTP_FROM_EMAIL="${SMTP_FROM_EMAIL}" \
    SMTP_REPLY_TO="${SMTP_REPLY_TO}" \
    node "${BOOTSTRAP_SCRIPT}"
  success "Bootstrap configuration complete."
fi

header "Building Next.js application"

run_as_user "${APP_USER}" npm run build --prefix "${APP_DIR}"
success "Build complete."

# ---------------------------------------------------------------------------
# 12. Application systemd service
# ---------------------------------------------------------------------------
header "Setting up application service"

cat > "/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=${APP_NAME} app
After=network.target postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
Environment=NODE_ENV=production
ExecStart=${APP_DIR}/node_modules/.bin/next start -p ${APP_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# Remove legacy PM2-managed instances when upgrading an older install.
systemctl disable "pm2-${APP_USER}" 2>/dev/null || true
if command -v pm2 >/dev/null 2>&1; then
  env PM2_HOME="${APP_DIR}/.pm2" pm2 delete "${APP_NAME}" 2>/dev/null || true
  env PM2_HOME="${APP_DIR}/.pm2" pm2 kill 2>/dev/null || true
fi
systemctl enable --now "${APP_NAME}.service"

success "Application service started and registered with systemd."

# ---------------------------------------------------------------------------
# 13. nginx configuration
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
    add_header Permissions-Policy     "camera=(), microphone=(), geolocation=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    server_tokens off;

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
# 14. Security hardening
# ---------------------------------------------------------------------------
header "Configuring security hardening"

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Origins-Pattern {
        "origin=${distro_id},archive=${distro_codename}-security";
        "origin=${distro_id},archive=${distro_codename}-updates";
};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

systemctl enable unattended-upgrades
systemctl restart unattended-upgrades || true
success "Automatic security updates enabled."

mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/${APP_NAME}.local <<EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true

[sshd-ddos]
enabled = true
EOF

if [[ "$CONFIGURE_NGINX" == "y" ]]; then
  cat >> /etc/fail2ban/jail.d/${APP_NAME}.local <<'EOF'

[nginx-http-auth]
enabled = true

[nginx-badbots]
enabled = true
EOF
fi

systemctl enable fail2ban
systemctl restart fail2ban
success "fail2ban enabled."

# ---------------------------------------------------------------------------
# 15. Log rotation
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
# 16. Cron jobs
# ---------------------------------------------------------------------------
header "Setting up cron jobs"

CRON_ENV_FILE="${APP_DIR}/.env"
CRON_CURL_PREFIX="CRON_SECRET=\$(grep -m 1 '^CRON_SECRET=' '${CRON_ENV_FILE}' | cut -d= -f2-) && curl -fsS -H \"Authorization: Bearer \${CRON_SECRET}\""
CRON_LINES=(
  "0 6 * * * ${CRON_CURL_PREFIX} http://localhost:${APP_PORT}/api/cron/fx-rates > /dev/null 2>&1"
  "0 3 * * * ${CRON_CURL_PREFIX} http://localhost:${APP_PORT}/api/cron/activity-cleanup > /dev/null 2>&1"
  "0 2 * * * ${CRON_CURL_PREFIX} http://localhost:${APP_PORT}/api/cron/backup > /dev/null 2>&1"
  "0 4 * * * ${CRON_CURL_PREFIX} http://localhost:${APP_PORT}/api/cron/wc-reconcile > /dev/null 2>&1"
  "*/15 * * * * ${CRON_CURL_PREFIX} http://localhost:${APP_PORT}/api/cron/delivery-status > /dev/null 2>&1"
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
echo "  - 04:00 WooCommerce backup reconciliation and stock retry drain"
echo "  - Every 15 min Delivery status polling"
echo "  - 06:00 FX rate update"

# ---------------------------------------------------------------------------
# 17. Firewall hints (ufw)
# ---------------------------------------------------------------------------
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  header "Firewall"
  if [[ "${INSTALL_SSHD}" == "y" ]]; then
    ufw allow 22/tcp  comment "${APP_NAME} SSH"   2>/dev/null || true
  fi
  ufw allow 80/tcp  comment "${APP_NAME} HTTP"  2>/dev/null || true
  ufw allow 443/tcp comment "${APP_NAME} HTTPS" 2>/dev/null || true
  success "ufw rules added for required public ports."
fi

# ---------------------------------------------------------------------------
# 18. Post-install summary
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
echo -e "  Security       : ${BOLD}fail2ban + unattended-upgrades enabled${RESET}"
if [[ "${INSTALL_SSHD}" == "y" ]]; then
  echo -e "  SSH            : ${BOLD}enabled${RESET}"
fi
echo ""
echo -e "  App URL        : ${BOLD}http${ENABLE_SSL:+s}://${APP_DOMAIN}${RESET}"
echo ""
echo -e "${YELLOW}${BOLD}Next steps:${RESET}"
echo ""
if [[ -n "${DEFAULT_ADMIN_EMAIL}" ]]; then
  echo -e "  1. Default admin:"
  echo -e "     ${BOLD}${DEFAULT_ADMIN_EMAIL}${RESET}"
  echo -e "     Credential email target: ${BOLD}${NOTIFICATION_EMAIL:-not sent}${RESET}"
else
  echo -e "  1. Create the first admin user:"
  echo -e "     ${BOLD}cd ${APP_DIR} && npm run cli -- create-user${RESET}"
fi
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
echo -e "  6. View application service status:"
echo -e "     ${BOLD}systemctl status ${APP_NAME}.service${RESET}"
echo ""
echo -e "  7. View live logs:"
echo -e "     ${BOLD}journalctl -u ${APP_NAME}.service -f${RESET}"
echo ""

if [[ "$ENABLE_SSL" != "y" ]]; then
  warn "SSL is not enabled. For production use, re-run with SSL or configure manually."
  echo -e "     ${BOLD}certbot --nginx -d ${APP_DOMAIN}${RESET}"
  echo ""
fi

echo -e "${GREEN}Done.${RESET}"
