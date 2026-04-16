#!/usr/bin/env bash
# =============================================================================
# IMS tenant provisioner
# =============================================================================
# Creates a new Proxmox LXC, installs a fresh IMS instance in it, creates
# Cloudflare DNS for <slug>.onetwoinventory.com, configures an OpenLiteSpeed
# reverse-proxy vhost with Let's Encrypt, and seeds a default admin user whose
# credentials are emailed to the requested address.
#
# Assumptions:
# - Proxmox host exposes `pct`
# - OpenLiteSpeed host uses /usr/local/lsws/conf/httpd_config.conf
# - OpenLiteSpeed already has HTTP and HTTPS listeners (defaults: Default, SSL)
# - The deployment branch is reachable from the new container via git
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "Missing required environment variable: ${name}"
}

append_env_line() {
  local file="$1" key="$2" value="$3"
  printf '%s=%q\n' "$key" "$value" >> "$file"
}

ssh_proxmox() {
  ssh -o BatchMode=yes "${PROXMOX_SSH_USER}@${PROXMOX_HOST}" "$@"
}

scp_proxmox() {
  scp -q -o BatchMode=yes "$1" "${PROXMOX_SSH_USER}@${PROXMOX_HOST}:$2"
}

next_proxmox_vmid() {
  ssh_proxmox "pvesh get /cluster/nextid"
}

ssh_ols() {
  ssh -o BatchMode=yes "${OLS_SSH_USER}@${OLS_HOST}" "$@"
}

ssh_proxy() {
  ssh -o BatchMode=yes "${PROXY_SSH_USER}@${PROXY_HOST}" "$@"
}

random_secret() {
  openssl rand -base64 24 | tr -d '\n' | tr '/+' 'AB' | cut -c1-24
}

cf_request() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -fsS -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$data"
  else
    curl -fsS -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
  fi
}

wait_for_dns() {
  local domain="$1" expected_ip="$2" proxied="${3:-false}" tries=30 current=""
  for _ in $(seq 1 "$tries"); do
    current="$(dig +short A "$domain" @1.1.1.1 | tr '\n' ' ' | sed 's/[[:space:]]*$//' || true)"
    if [[ "${proxied}" == "true" ]]; then
      if [[ -n "${current}" ]]; then
        return 0
      fi
    else
      if [[ " ${current} " == *" ${expected_ip} "* ]]; then
        return 0
      fi
    fi
    sleep 10
  done
  if [[ "${proxied}" == "true" ]]; then
    die "DNS for ${domain} did not return a public A record within $((tries * 10))s."
  fi
  die "DNS for ${domain} did not resolve to ${expected_ip} within $((tries * 10))s (last seen: ${current:-none})"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/provision-ims-tenant.env"
PROVISION_ENV_FILE="${PROVISION_ENV_FILE:-}"

if [[ -n "${PROVISION_ENV_FILE}" ]]; then
  info "Loading environment from ${PROVISION_ENV_FILE}."
  set -a
  # shellcheck disable=SC1090
  source "${PROVISION_ENV_FILE}"
  set +a
elif [[ -f "${DEFAULT_ENV_FILE}" && -z "${PROXMOX_HOST:-}" && -z "${PROXY_HOST:-}" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  info "Loading environment from ${DEFAULT_ENV_FILE}."
  set -a
  # shellcheck disable=SC1090
  source "${DEFAULT_ENV_FILE}"
  set +a
fi

require_command ssh
require_command scp
require_command curl
require_command jq
require_command openssl
require_command dig
require_command git
require_command tar

PROXMOX_SSH_USER="${PROXMOX_SSH_USER:-root}"
OLS_SSH_USER="${OLS_SSH_USER:-root}"
NGINX_SSH_USER="${NGINX_SSH_USER:-root}"

PROXY_TYPE="${PROXY_TYPE:-ols}"
PROXY_PUBLIC_IP="${PROXY_PUBLIC_IP:-${OLS_PUBLIC_IP:-${NGINX_PUBLIC_IP:-}}}"
case "${PROXY_TYPE}" in
  ols)
    PROXY_HOST="${PROXY_HOST:-${OLS_HOST:-}}"
    PROXY_SSH_USER="${PROXY_SSH_USER:-${OLS_SSH_USER}}"
    ;;
  nginx)
    PROXY_HOST="${PROXY_HOST:-${NGINX_HOST:-}}"
    PROXY_SSH_USER="${PROXY_SSH_USER:-${NGINX_SSH_USER}}"
    ;;
  *)
    die "PROXY_TYPE must be 'ols' or 'nginx'."
    ;;
esac

POSTGRES_MODE="${POSTGRES_MODE:-local}"
REDIS_MODE="${REDIS_MODE:-disabled}"

if [[ "${POSTGRES_MODE}" == "external" ]]; then
  require_command psql
fi

require_env PROXMOX_HOST
require_env PROXY_HOST
require_env PROXY_PUBLIC_IP
require_env CLOUDFLARE_API_TOKEN
require_env CLOUDFLARE_ZONE_ID
require_env LXC_TEMPLATE
require_env LXC_STORAGE
require_env ADMIN_EMAIL
require_env NOTIFICATION_EMAIL
require_env LETSENCRYPT_EMAIL
require_env SMTP_HOST
require_env SMTP_FROM_EMAIL

generate_funny_slug() {
  local names animals slug attempt lookup
  names=(
    agile amber astro banjo basil bingo brisk cocoa comet cosmo dapper
    dusty echo ember felix gizmo happy hazel jolly kiwi lucky mango milo
    nimble otto peppy pixel polo rosy rusty sunny tango tofu waffle zippy
  )
  animals=(
    alpaca badger beaver bison bunny capybara cheetah cougar dolphin falcon
    ferret fox gecko heron jaguar koala lemur leopard lion lynx marmot
    otter panda panther penguin puma rabbit raccoon raven tiger walrus wolf
  )

  for attempt in $(seq 1 50); do
    slug="${names[RANDOM % ${#names[@]}]}-${animals[RANDOM % ${#animals[@]}]}"
    lookup="$(cf_request GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=A&name=${slug}.${DOMAIN_SUFFIX}")"
    if [[ "$(jq -r '.result | length' <<<"${lookup}")" == "0" ]]; then
      echo "${slug}"
      return 0
    fi
  done

  die "Failed to generate a unique tenant slug after 50 attempts."
}

DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-onetwoinventory.com}"
TENANT_DOMAIN="${TENANT_DOMAIN:-}"
if [[ -z "${TENANT_DOMAIN}" ]]; then
  TENANT_SLUG="${TENANT_SLUG:-$(generate_funny_slug)}"
fi
[[ "${TENANT_SLUG}" =~ ^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] \
  || [[ -n "${TENANT_DOMAIN}" ]] \
  || die "TENANT_SLUG must match ^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$"

DOMAIN="${TENANT_DOMAIN:-${TENANT_SLUG}.${DOMAIN_SUFFIX}}"
if [[ -z "${TENANT_SLUG}" ]]; then
  TENANT_SLUG="${DOMAIN%%.*}"
fi
APP_PORT="${APP_PORT:-3000}"
INSTALL_SSHD="${INSTALL_SSHD:-n}"
SSH_AUTHORIZED_KEY="${SSH_AUTHORIZED_KEY:-}"
REUSE_EXISTING_APP="${REUSE_EXISTING_APP:-y}"
RESUME_ONLY="${RESUME_ONLY:-n}"
ADMIN_NAME="${ADMIN_NAME:-IMS Admin}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-tls}"
SMTP_FROM_NAME="${SMTP_FROM_NAME:-IMS}"
SMTP_REPLY_TO="${SMTP_REPLY_TO:-}"
GIT_REPO_URL="${GIT_REPO_URL:-$(git -C "${REPO_DIR}" config --get remote.origin.url || true)}"
GIT_BRANCH="${GIT_BRANCH:-$(git -C "${REPO_DIR}" rev-parse --abbrev-ref HEAD)}"
DEPLOY_SOURCE_MODE="${DEPLOY_SOURCE_MODE:-git}"
LOCAL_SOURCE_DIR="${LOCAL_SOURCE_DIR:-${REPO_DIR}}"
GIT_DEPLOY_KEY_ENABLED="${GIT_DEPLOY_KEY_ENABLED:-n}"
GITHUB_DEPLOY_KEY_TOKEN="${GITHUB_DEPLOY_KEY_TOKEN:-}"
GITHUB_REPO_OWNER="${GITHUB_REPO_OWNER:-}"
GITHUB_REPO_NAME="${GITHUB_REPO_NAME:-}"
case "${DEPLOY_SOURCE_MODE}" in
  git)
    [[ -n "${GIT_REPO_URL}" ]] || die "GIT_REPO_URL is required when DEPLOY_SOURCE_MODE=git and the repo has no origin remote."
    ;;
  local)
    [[ -d "${LOCAL_SOURCE_DIR}" ]] || die "LOCAL_SOURCE_DIR does not exist: ${LOCAL_SOURCE_DIR}"
    ;;
  *)
    die "DEPLOY_SOURCE_MODE must be 'git' or 'local'."
    ;;
esac
if [[ "${GIT_DEPLOY_KEY_ENABLED}" == "y" ]]; then
  require_env GITHUB_DEPLOY_KEY_TOKEN
  require_env GITHUB_REPO_OWNER
  require_env GITHUB_REPO_NAME
fi

LXC_HOSTNAME="${LXC_HOSTNAME:-${TENANT_SLUG}}"
LXC_ID="${LXC_ID:-$(next_proxmox_vmid)}"
LXC_CORES="${LXC_CORES:-4}"
LXC_MEMORY_MB="${LXC_MEMORY_MB:-4096}"
LXC_SWAP_MB="${LXC_SWAP_MB:-1024}"
LXC_DISK_GB="${LXC_DISK_GB:-32}"
LXC_BRIDGE="${LXC_BRIDGE:-vmbr0}"
LXC_IP_CIDR="${LXC_IP_CIDR:-}"
LXC_NET_GW="${LXC_NET_GW:-}"
LXC_NAMESERVER="${LXC_NAMESERVER:-1.1.1.1}"
LXC_PASSWORD="${LXC_PASSWORD:-$(random_secret)}"
DEFAULT_ADMIN_PASSWORD="${DEFAULT_ADMIN_PASSWORD:-$(random_secret)}"
DB_SAFE_SLUG="${TENANT_SLUG//-/_}"
DB_NAME="${DB_NAME:-ims_${DB_SAFE_SLUG}}"
DB_USER="${DB_USER:-ims_${DB_SAFE_SLUG}}"
DB_PASSWORD="${DB_PASSWORD:-$(random_secret)}"
DB_PORT="${DB_PORT:-5432}"
DB_ADMIN_DATABASE="${DB_ADMIN_DATABASE:-postgres}"
if [[ "${POSTGRES_MODE}" == "external" ]]; then
  DB_HOST="${DB_HOST:-}"
  DB_ADMIN_USER="${DB_ADMIN_USER:-}"
  DB_ADMIN_PASSWORD="${DB_ADMIN_PASSWORD:-}"
  require_env DB_HOST
  require_env DB_ADMIN_USER
  require_env DB_ADMIN_PASSWORD
  INSTALL_POSTGRES="n"
else
  DB_HOST="localhost"
  INSTALL_POSTGRES="y"
fi

REDIS_HOST="${REDIS_HOST:-}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_DB="${REDIS_DB:-0}"
REDIS_KEY_PREFIX="${REDIS_KEY_PREFIX:-${TENANT_SLUG}}"
if [[ -z "${REDIS_URL:-}" ]]; then
  if [[ "${REDIS_MODE}" == "external" ]]; then
    require_env REDIS_HOST
    REDIS_URL="redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}"
  elif [[ "${REDIS_MODE}" == "local" ]]; then
    REDIS_URL="redis://localhost:${REDIS_PORT}/${REDIS_DB}"
  else
    REDIS_URL=""
  fi
fi
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
CLOUDFLARE_PROXIED="${CLOUDFLARE_PROXIED:-false}"
OLS_HTTP_LISTENER="${OLS_HTTP_LISTENER:-Default}"
OLS_HTTPS_LISTENER="${OLS_HTTPS_LISTENER:-SSL}"
BACKEND_HEALTH_PATH="${BACKEND_HEALTH_PATH:-/login}"
NGINX_SITES_AVAILABLE_DIR="${NGINX_SITES_AVAILABLE_DIR:-/etc/nginx/sites-available}"
NGINX_SITES_ENABLED_DIR="${NGINX_SITES_ENABLED_DIR:-/etc/nginx/sites-enabled}"

TMP_DIR="$(mktemp -d -t ims-provision.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

INSTALL_ENV_FILE="${TMP_DIR}/ims-install.env"
REMOTE_INSTALL_SCRIPT="/tmp/ims-install-${TENANT_SLUG}.sh"
REMOTE_HELPER_SCRIPT="/tmp/ims-provision-instance-${TENANT_SLUG}.mjs"
REMOTE_ENV_FILE="/tmp/ims-install-${TENANT_SLUG}.env"
REMOTE_SOURCE_TARBALL="/tmp/ims-source-${TENANT_SLUG}.tar.gz"
REMOTE_SOURCE_DIR="/root/ims-source-${TENANT_SLUG}"
GITHUB_DEPLOY_KEY_TITLE="${GITHUB_DEPLOY_KEY_TITLE:-ims-${TENANT_SLUG}-${LXC_ID}}"

touch "${INSTALL_ENV_FILE}"
if [[ "${DEPLOY_SOURCE_MODE}" == "git" ]]; then
  append_env_line "${INSTALL_ENV_FILE}" INSTALL_FROM_GIT "y"
  append_env_line "${INSTALL_ENV_FILE}" GIT_REPO_URL "${GIT_REPO_URL}"
  append_env_line "${INSTALL_ENV_FILE}" GIT_BRANCH "${GIT_BRANCH}"
else
  append_env_line "${INSTALL_ENV_FILE}" INSTALL_FROM_GIT "n"
  append_env_line "${INSTALL_ENV_FILE}" LOCAL_SOURCE_DIR "${REMOTE_SOURCE_DIR}"
fi
append_env_line "${INSTALL_ENV_FILE}" APP_DOMAIN "${DOMAIN}"
append_env_line "${INSTALL_ENV_FILE}" APP_PORT "${APP_PORT}"
append_env_line "${INSTALL_ENV_FILE}" GIT_DEPLOY_KEY_ENABLED "${GIT_DEPLOY_KEY_ENABLED}"
append_env_line "${INSTALL_ENV_FILE}" GITHUB_DEPLOY_KEY_TOKEN "${GITHUB_DEPLOY_KEY_TOKEN}"
append_env_line "${INSTALL_ENV_FILE}" GITHUB_REPO_OWNER "${GITHUB_REPO_OWNER}"
append_env_line "${INSTALL_ENV_FILE}" GITHUB_REPO_NAME "${GITHUB_REPO_NAME}"
append_env_line "${INSTALL_ENV_FILE}" GITHUB_DEPLOY_KEY_TITLE "${GITHUB_DEPLOY_KEY_TITLE}"
append_env_line "${INSTALL_ENV_FILE}" INSTALL_SSHD "${INSTALL_SSHD}"
append_env_line "${INSTALL_ENV_FILE}" SSH_AUTHORIZED_KEY "${SSH_AUTHORIZED_KEY}"
append_env_line "${INSTALL_ENV_FILE}" INSTALL_POSTGRES "${INSTALL_POSTGRES}"
append_env_line "${INSTALL_ENV_FILE}" DB_HOST "${DB_HOST}"
append_env_line "${INSTALL_ENV_FILE}" DB_PORT "${DB_PORT}"
append_env_line "${INSTALL_ENV_FILE}" DB_NAME "${DB_NAME}"
append_env_line "${INSTALL_ENV_FILE}" DB_USER "${DB_USER}"
append_env_line "${INSTALL_ENV_FILE}" DB_PASSWORD "${DB_PASSWORD}"
if [[ "${REDIS_MODE}" == "local" ]]; then
  append_env_line "${INSTALL_ENV_FILE}" INSTALL_REDIS "y"
else
  append_env_line "${INSTALL_ENV_FILE}" INSTALL_REDIS "n"
fi
append_env_line "${INSTALL_ENV_FILE}" REDIS_PORT "${REDIS_PORT}"
append_env_line "${INSTALL_ENV_FILE}" REDIS_URL "${REDIS_URL}"
append_env_line "${INSTALL_ENV_FILE}" REDIS_PASSWORD "${REDIS_PASSWORD}"
append_env_line "${INSTALL_ENV_FILE}" REDIS_KEY_PREFIX "${REDIS_KEY_PREFIX}"
append_env_line "${INSTALL_ENV_FILE}" CONFIGURE_NGINX "n"
append_env_line "${INSTALL_ENV_FILE}" ENABLE_SSL "n"
append_env_line "${INSTALL_ENV_FILE}" DEFAULT_ADMIN_NAME "${ADMIN_NAME}"
append_env_line "${INSTALL_ENV_FILE}" DEFAULT_ADMIN_EMAIL "${ADMIN_EMAIL}"
append_env_line "${INSTALL_ENV_FILE}" DEFAULT_ADMIN_PASSWORD "${DEFAULT_ADMIN_PASSWORD}"
append_env_line "${INSTALL_ENV_FILE}" NOTIFICATION_EMAIL "${NOTIFICATION_EMAIL}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_HOST "${SMTP_HOST}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_PORT "${SMTP_PORT}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_USER "${SMTP_USER:-}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_PASS "${SMTP_PASS:-}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_SECURE "${SMTP_SECURE}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_FROM_NAME "${SMTP_FROM_NAME}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_FROM_EMAIL "${SMTP_FROM_EMAIL}"
append_env_line "${INSTALL_ENV_FILE}" SMTP_REPLY_TO "${SMTP_REPLY_TO}"
append_env_line "${INSTALL_ENV_FILE}" NEXT_PUBLIC_TURNSTILE_SITE_KEY "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}"
append_env_line "${INSTALL_ENV_FILE}" TURNSTILE_SECRET_KEY "${TURNSTILE_SECRET_KEY:-}"
append_env_line "${INSTALL_ENV_FILE}" WC_STORE_URL "${WC_STORE_URL:-}"
append_env_line "${INSTALL_ENV_FILE}" WC_CONSUMER_KEY "${WC_CONSUMER_KEY:-}"
append_env_line "${INSTALL_ENV_FILE}" WC_CONSUMER_SECRET "${WC_CONSUMER_SECRET:-}"
append_env_line "${INSTALL_ENV_FILE}" WC_WEBHOOK_SECRET "${WC_WEBHOOK_SECRET:-$(random_secret)}"
append_env_line "${INSTALL_ENV_FILE}" XERO_CLIENT_ID "${XERO_CLIENT_ID:-}"
append_env_line "${INSTALL_ENV_FILE}" XERO_CLIENT_SECRET "${XERO_CLIENT_SECRET:-}"

if [[ "${POSTGRES_MODE}" == "external" ]]; then
  info "Provisioning database ${DB_NAME} on external PostgreSQL server ${DB_HOST}:${DB_PORT}."
  PGPASSWORD="${DB_ADMIN_PASSWORD}" psql \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_ADMIN_USER}" \
    -d "${DB_ADMIN_DATABASE}" \
    -v ON_ERROR_STOP=1 <<EOSQL
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
  success "External PostgreSQL database is ready."
fi

info "Creating LXC ${LXC_ID} on ${PROXMOX_HOST}."
if [[ "${RESUME_ONLY}" == "y" ]]; then
  if ! ssh_proxmox "pct status ${LXC_ID}" >/dev/null 2>&1; then
    die "RESUME_ONLY=y but LXC ${LXC_ID} does not exist on ${PROXMOX_HOST}."
  fi
  warn "RESUME_ONLY=y; skipping LXC creation and reusing ${LXC_ID}."
  ssh_proxmox "pct start ${LXC_ID}" >/dev/null 2>&1 || true
elif ssh_proxmox "pct status ${LXC_ID}" >/dev/null 2>&1; then
  warn "LXC ${LXC_ID} already exists; reusing it."
  ssh_proxmox "pct start ${LXC_ID}" >/dev/null 2>&1 || true
else
  ssh_proxmox bash -s -- \
    "${LXC_ID}" "${LXC_TEMPLATE}" "${LXC_HOSTNAME}" "${LXC_STORAGE}" "${LXC_DISK_GB}" \
    "${LXC_CORES}" "${LXC_MEMORY_MB}" "${LXC_SWAP_MB}" "${LXC_BRIDGE}" "${LXC_PASSWORD}" \
    "${LXC_NAMESERVER}" "${LXC_NET_GW}" "${LXC_IP_CIDR}" <<'REMOTE'
set -euo pipefail
CTID="$1"
TEMPLATE="$2"
HOSTNAME="$3"
STORAGE="$4"
DISK_GB="$5"
CORES="$6"
MEMORY_MB="$7"
SWAP_MB="$8"
BRIDGE="$9"
PASSWORD="${10}"
NAMESERVER="${11}"
GATEWAY="${12}"
IP_CIDR="${13}"

if [[ -n "${IP_CIDR}" ]]; then
  NET0="name=eth0,bridge=${BRIDGE},ip=${IP_CIDR}"
  if [[ -n "${GATEWAY}" ]]; then
    NET0="${NET0},gw=${GATEWAY}"
  fi
else
  NET0="name=eth0,bridge=${BRIDGE},ip=dhcp"
  if [[ -n "${GATEWAY}" ]]; then
    NET0="${NET0},gw=${GATEWAY}"
  fi
fi

pct create "${CTID}" "${TEMPLATE}" \
  --hostname "${HOSTNAME}" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores "${CORES}" \
  --memory "${MEMORY_MB}" \
  --swap "${SWAP_MB}" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --password "${PASSWORD}" \
  --net0 "${NET0}" \
  --nameserver "${NAMESERVER}"

pct start "${CTID}"
REMOTE
  success "LXC ${LXC_ID} created and started."
fi

info "Waiting for container IP."
LXC_IP=""
for _ in $(seq 1 30); do
  LXC_IP="$(ssh_proxmox "pct exec ${LXC_ID} -- bash -lc \"hostname -I | awk '{print \\\$1}'\"" || true)"
  LXC_IP="${LXC_IP//$'\r'/}"
  LXC_IP="${LXC_IP//$'\n'/}"
  if [[ -n "${LXC_IP}" ]]; then
    break
  fi
  sleep 5
done
[[ -n "${LXC_IP}" ]] || die "Failed to detect IP for LXC ${LXC_ID}."
success "LXC IP: ${LXC_IP}"

info "Uploading installer assets to ${PROXMOX_HOST}."
scp_proxmox "${REPO_DIR}/scripts/install.sh" "${REMOTE_INSTALL_SCRIPT}"
scp_proxmox "${REPO_DIR}/scripts/provision-instance.mjs" "${REMOTE_HELPER_SCRIPT}"
scp_proxmox "${INSTALL_ENV_FILE}" "${REMOTE_ENV_FILE}"
if [[ "${DEPLOY_SOURCE_MODE}" == "local" ]]; then
  SOURCE_TARBALL="${TMP_DIR}/ims-source-${TENANT_SLUG}.tar.gz"
  info "Bundling application source from ${LOCAL_SOURCE_DIR}."
  tar -C "${LOCAL_SOURCE_DIR}" -czf "${SOURCE_TARBALL}" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='.codex' \
    --exclude='.env' \
    .
  scp_proxmox "${SOURCE_TARBALL}" "${REMOTE_SOURCE_TARBALL}"
fi

info "Pushing installer assets into LXC ${LXC_ID}."
ssh_proxmox bash -s -- \
  "${LXC_ID}" "${REMOTE_INSTALL_SCRIPT}" "${REMOTE_HELPER_SCRIPT}" "${REMOTE_ENV_FILE}" \
  "${DEPLOY_SOURCE_MODE}" "${REMOTE_SOURCE_TARBALL}" "${REMOTE_SOURCE_DIR}" <<'REMOTE'
set -euo pipefail
CTID="$1"
INSTALL_SCRIPT="$2"
HELPER_SCRIPT="$3"
ENV_FILE="$4"
DEPLOY_MODE="$5"
SOURCE_TARBALL="$6"
SOURCE_DIR="$7"
pct push "${CTID}" "${INSTALL_SCRIPT}" /root/install.sh
pct push "${CTID}" "${HELPER_SCRIPT}" /root/provision-instance.mjs
pct push "${CTID}" "${ENV_FILE}" /root/ims-install.env
if [[ "${DEPLOY_MODE}" == "local" ]]; then
  pct exec "${CTID}" -- rm -rf "${SOURCE_DIR}"
  pct exec "${CTID}" -- mkdir -p "${SOURCE_DIR}"
  pct push "${CTID}" "${SOURCE_TARBALL}" /root/ims-source.tar.gz
  pct exec "${CTID}" -- tar -xzf /root/ims-source.tar.gz -C "${SOURCE_DIR}"
  pct exec "${CTID}" -- rm -f /root/ims-source.tar.gz
fi
pct exec "${CTID}" -- chmod +x /root/install.sh
REMOTE

APP_ALREADY_HEALTHY=false
if [[ "${REUSE_EXISTING_APP}" == "y" ]]; then
  if ssh_proxmox "pct exec ${LXC_ID} -- bash -lc 'test -f /opt/one-two-inventory/.env && curl -fsS --max-time 5 http://127.0.0.1:${APP_PORT}/login >/dev/null'" >/dev/null 2>&1; then
    APP_ALREADY_HEALTHY=true
  fi
fi

if $APP_ALREADY_HEALTHY; then
  warn "IMS already appears healthy in LXC ${LXC_ID}; skipping reinstall."
else
  info "Running IMS installer inside the container."
  ssh_proxmox "pct exec ${LXC_ID} -- bash -lc 'set -a && source /root/ims-install.env && set +a && /root/install.sh --non-interactive'"
  success "IMS installed in LXC ${LXC_ID}."
fi
ssh_proxmox "pct exec ${LXC_ID} -- rm -f /root/ims-install.env /root/provision-instance.mjs /root/install.sh" >/dev/null 2>&1 || true

info "Upserting Cloudflare DNS for ${DOMAIN} -> ${PROXY_PUBLIC_IP}."
CF_LOOKUP="$(cf_request GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=A&name=${DOMAIN}")"
CF_RECORD_ID="$(jq -r '.result[0].id // empty' <<<"${CF_LOOKUP}")"
CF_PAYLOAD="$(jq -nc \
  --arg type "A" \
  --arg name "${DOMAIN}" \
  --arg content "${PROXY_PUBLIC_IP}" \
  --argjson proxied "${CLOUDFLARE_PROXIED}" \
  '{type:$type,name:$name,content:$content,ttl:1,proxied:$proxied}')"
if [[ -n "${CF_RECORD_ID}" ]]; then
  cf_request PUT "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${CF_RECORD_ID}" "${CF_PAYLOAD}" >/dev/null
  info "Updated existing Cloudflare DNS record for ${DOMAIN}."
else
  cf_request POST "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" "${CF_PAYLOAD}" >/dev/null
  info "Created new Cloudflare DNS record for ${DOMAIN}."
fi
success "Cloudflare DNS record ready."

info "Waiting for public DNS propagation."
wait_for_dns "${DOMAIN}" "${PROXY_PUBLIC_IP}" "${CLOUDFLARE_PROXIED}"
success "DNS propagation confirmed."

if [[ "${PROXY_TYPE}" == "ols" ]]; then
info "Configuring OpenLiteSpeed vhost on ${PROXY_HOST}."
ssh_proxy bash -s -- \
  "${DOMAIN}" "${LXC_IP}" "${APP_PORT}" "${LETSENCRYPT_EMAIL}" \
  "${OLS_HTTP_LISTENER}" "${OLS_HTTPS_LISTENER}" "${BACKEND_HEALTH_PATH}" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"
BACKEND_IP="$2"
BACKEND_PORT="$3"
LE_EMAIL="$4"
HTTP_LISTENER="$5"
HTTPS_LISTENER="$6"
HEALTH_PATH="$7"

HTTPD_CONF="/usr/local/lsws/conf/httpd_config.conf"
VHOST_DIR="/usr/local/lsws/conf/vhosts/${DOMAIN}"
DOCROOT="/var/www/${DOMAIN}"
VHCONF="${VHOST_DIR}/vhconf.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

mkdir -p "${VHOST_DIR}" "${DOCROOT}/.well-known/acme-challenge"
cat > "${DOCROOT}/index.html" <<EOF
${DOMAIN}
EOF

cat > "${VHCONF}" <<EOF
docRoot                   ${DOCROOT}/
vhDomain                  ${DOMAIN}
vhAliases                 www.${DOMAIN}
adminEmails               ${LE_EMAIL}
enableGzip                1
index  {
  useServer               0
  indexFiles              index.html
}
errorlog /var/log/ols-${DOMAIN}.error.log {
  useServer               0
  logLevel                INFO
  rollingSize             10M
}
accesslog /var/log/ols-${DOMAIN}.access.log {
  useServer               0
  logFormat               "%h %l %u %t \"%r\" %>s %b"
  rollingSize             10M
  keepDays                30
}
extprocessor ims-backend {
  type                    proxy
  address                 ${BACKEND_IP}:${BACKEND_PORT}
  maxConns                200
  initTimeout             60
  retryTimeout            0
  respBuffer              0
  keepAlive               1
  compressResponse        0
}
context /.well-known/acme-challenge/ {
  location                ${DOCROOT}/.well-known/acme-challenge/
  allowBrowse             1
}
context / {
  type                    proxy
  handler                 ims-backend
  addDefaultCharset       off
  noCache                 1
  extraHeaders            <<<END_OF_HEADERS
X-Forwarded-Proto https
X-Forwarded-Host ${DOMAIN}
END_OF_HEADERS
}
rewrite  {
  enable                  1
  autoLoadHtaccess        0
}
vhssl  {
  keyFile                 ${CERT_DIR}/privkey.pem
  certFile                ${CERT_DIR}/fullchain.pem
  certChain               1
  sslProtocol             24
}
EOF

VHOST_BLOCK=$(cat <<EOF
virtualhost ${DOMAIN} {
  vhRoot                  ${DOCROOT}
  configFile              ${VHCONF}
  allowSymbolLink         1
  enableScript            1
  restrained              0
}
EOF
)

if grep -Fq "virtualhost ${DOMAIN} {" "${HTTPD_CONF}"; then
  perl -0pi -e "s#virtualhost \Q${DOMAIN}\E \\{.*?\\n\\}#${VHOST_BLOCK//$'\n'/\\n}#s" "${HTTPD_CONF}"
else
  printf '\n%s\n' "${VHOST_BLOCK}" >> "${HTTPD_CONF}"
fi

add_listener_map() {
  local listener="$1"
  local map_line="  map                     ${DOMAIN} ${DOMAIN}"
  if perl -0ne "exit((/listener\\s+${listener}\\s*\\{.*?map\\s+${DOMAIN}\\s+${DOMAIN}.*?\\n\\}/s) ? 0 : 1)" "${HTTPD_CONF}"; then
    return 0
  fi
  perl -0pi -e "s/(listener\\s+${listener}\\s*\\{.*?)(\\n\\})/\$1\\n${map_line}\$2/s" "${HTTPD_CONF}"
}

add_listener_map "${HTTP_LISTENER}"
add_listener_map "${HTTPS_LISTENER}"

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq certbot
fi

systemctl reload lsws || systemctl restart lsws

if [[ ! -f "${CERT_DIR}/fullchain.pem" ]]; then
  certbot certonly \
    --webroot \
    --non-interactive \
    --agree-tos \
    --email "${LE_EMAIL}" \
    --webroot-path "${DOCROOT}" \
    -d "${DOMAIN}"
fi

systemctl reload lsws || systemctl restart lsws
curl -kfsS --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}${HEALTH_PATH}" >/dev/null
REMOTE
success "OpenLiteSpeed vhost configured."
else
info "Configuring nginx vhost on ${PROXY_HOST}."
ssh_proxy bash -s -- \
  "${DOMAIN}" "${LXC_IP}" "${APP_PORT}" "${LETSENCRYPT_EMAIL}" \
  "${NGINX_SITES_AVAILABLE_DIR}" "${NGINX_SITES_ENABLED_DIR}" "${BACKEND_HEALTH_PATH}" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"
BACKEND_IP="$2"
BACKEND_PORT="$3"
LE_EMAIL="$4"
SITES_AVAILABLE_DIR="$5"
SITES_ENABLED_DIR="$6"
HEALTH_PATH="$7"

CONF_FILE="${SITES_AVAILABLE_DIR}/${DOMAIN}.conf"

mkdir -p "${SITES_AVAILABLE_DIR}" "${SITES_ENABLED_DIR}"
cat > "${CONF_FILE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://${BACKEND_IP}:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF

ln -sfn "${CONF_FILE}" "${SITES_ENABLED_DIR}/${DOMAIN}.conf"

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi

nginx -t
systemctl reload nginx

certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "${LE_EMAIL}" \
  --domains "${DOMAIN}" \
  --redirect

nginx -t
systemctl reload nginx
curl -kfsS --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}${HEALTH_PATH}" >/dev/null
REMOTE
success "nginx vhost configured."
fi

cat <<EOF

${GREEN}${BOLD}Provisioning complete.${RESET}

Domain:            ${DOMAIN}
Proxy type:        ${PROXY_TYPE}
Proxy host:        ${PROXY_HOST}
Public IP:         ${PROXY_PUBLIC_IP}
LXC ID:            ${LXC_ID}
LXC IP:            ${LXC_IP}
Admin email:       ${ADMIN_EMAIL}
Notification sent: ${NOTIFICATION_EMAIL}
Repo branch:       ${GIT_BRANCH}
Postgres mode:     ${POSTGRES_MODE} (${DB_HOST}:${DB_PORT}/${DB_NAME})
Redis mode:        ${REDIS_MODE}
Redis URL:         ${REDIS_URL:-disabled}
Redis prefix:      ${REDIS_KEY_PREFIX}
SSH enabled:       ${INSTALL_SSHD}

The default admin password was generated for this run. If you did not explicitly set
DEFAULT_ADMIN_PASSWORD, retrieve it from your shell history or rerun with a known value.
EOF
