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

# Percent-encode a value for the userinfo section of a URL (o3d-tsc0).
#
# REDIS_URL is the canonical place a Redis credential lives, because it is what
# the client connects with, it is the only form that can express a Redis 6 ACL
# username, and an inline credential already wins over any environment fallback.
# This installer is the second artefact that disagreed with that: it wrote
# `requirepass` into redis.conf and then built a CREDENTIAL-FREE REDIS_URL, so
# the only password an operator can supply through the installer never reached
# AUTH. That is not visible as a Redis fault — the auth rate-limit buckets fail
# CLOSED, so the symptom is that nobody can sign in to the server that was just
# installed.
#
# LC_ALL=C makes bash walk the string BYTE by byte, so a multi-byte password is
# encoded as the bytes the server will receive rather than as codepoints. Kept
# character-for-character identical to the one in scripts/provision-ims-tenant.sh:
# the two scripts share no shell library, and a percent-encoder that only agrees
# with itself is exactly the defect that made this a two-sided problem.
urlencode() {
  local LC_ALL=C string="$1" out="" i c
  for (( i = 0; i < ${#string}; i++ )); do
    c="${string:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Byte-wise inverse of urlencode (o3d-tsc0).
#
# It exists so that RE-RUNNING this installer keeps the Redis that is already
# working. REDIS_URL is canonical, so the credential a previous run committed to is
# the one encoded in that URL, and recovering it is what lets an operator press
# Enter through an upgrade without silently swapping a working password for a
# default. LC_ALL=C for the same reason as the encoder: %C3%A4 has to come back as
# the two bytes the server was configured with, not as one codepoint.
urldecode() {
  local LC_ALL=C string="$1" out="" i c hex byte
  for (( i = 0; i < ${#string}; i++ )); do
    c="${string:i:1}"
    hex="${string:i+1:2}"
    if [[ "$c" == "%" && "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
      printf -v byte '%b' "\\x${hex}"
      out+="$byte"
      i=$(( i + 2 ))
    else
      out+="$c"
    fi
  done
  printf '%s' "$out"
}

# Render a value as a redis.conf string literal.
#
# THE OTHER HALF OF THE SAME DEFECT. urlencode settles what the CLIENT sends;
# this settles what the SERVER is configured to expect, and unless both are the same
# byte sequence the install is dead on arrival — and dead in the way that is hardest
# to diagnose, because the auth rate-limit buckets fail CLOSED, so a Redis answering
# NOAUTH surfaces as nobody being able to sign in to the server just installed.
#
# redis.conf is NOT read by a shell. Redis parses each line with sdssplitargs(),
# which splits on whitespace and opens a quoted section on a `"` or a `'` ANYWHERE in
# a token. So `requirepass my pass` is a wrong-number-of-arguments error at startup,
# `requirepass a"b` swallows the rest of the line, and `requirepass a\` escapes the
# newline. Emitting EVERY byte as \xHH inside double quotes removes all of those at
# once — there is no byte whose meaning depends on its neighbours — and it walks the
# string with the same LC_ALL=C byte loop as urlencode, so the two ends are encoding
# one identical byte sequence rather than two encodings that merely agree on ASCII.
redis_conf_quote() {
  local LC_ALL=C string="$1" out='"' i
  for (( i = 0; i < ${#string}; i++ )); do
    out+="$(printf '\\x%02X' "'${string:i:1}")"
  done
  printf '%s"' "$out"
}

# Replace the requirepass directive in a redis.conf WITHOUT handing the password to
# sed. In a sed replacement `&` means the whole match, `\1` is a backreference and the
# delimiter ends the expression, so an interpolated password is stored as a different
# byte sequence than the one that was typed — the same class of bug as the config
# quoting above, one layer out. The old directives are therefore matched by PATTERN
# and dropped, and the new line is appended verbatim. The file is rewritten with
# `cat >` rather than `mv` so redis.conf keeps its own owner and mode.
redis_conf_set_requirepass() {
  local conf="$1" line="$2" tmp status=0
  tmp="$(mktemp)"
  grep -vE '^[[:space:]]*#*[[:space:]]*requirepass([[:space:]]|$)' "${conf}" > "${tmp}" || status=$?
  if (( status > 1 )); then
    rm -f "${tmp}"
    die "Could not rewrite ${conf} to set requirepass."
  fi
  printf '%s\n' "${line}" >> "${tmp}"
  cat "${tmp}" > "${conf}"
  rm -f "${tmp}"
}

# Print the shape of a URL, never the secret in it. Character-for-character the same
# function as the one in scripts/provision-ims-tenant.sh, for the same reason the
# encoder is duplicated: the two scripts share no shell library, and this installer
# now both reads and displays a URL that carries a credential.
#
# THE CUT IS AT THE LAST `@`, NOT THE FIRST. A URL this script BUILT has a
# percent-encoded password and holds exactly one `@`, so either cut lands in the same
# place — but an operator-supplied REDIS_URL is taken verbatim, and
# `redis://:se@cret@host:6379` cut at the first `@` prints `redis://***@cret@host:6379`,
# which puts the tail of the secret into the very log this function exists to keep it
# out of. Cutting at the last `@` cannot do that for any input. The obvious
# alternative — find the authority by taking everything up to the first `/` — is a
# TRAP: a password containing a slash ends that scan early, so the `@` is never seen
# and the WHOLE url is printed. The cost of the last-`@` rule is over-redaction of a
# credential-free URL that happens to contain an `@`, which is the direction to be
# wrong in: an over-redacted line is cosmetic, an under-redacted one is a secret in a
# file somebody keeps.
redact_url_credentials() {
  local url="$1" rest
  case "$url" in
    *"://"*"@"*)
      rest="${url#*://}"
      printf '%s://***@%s' "${url%%://*}" "${rest##*@}"
      ;;
    *) printf '%s' "$url" ;;
  esac
}

# o3d-l89a r4 (Codex r3 finding 1) — DOES THIS URL ALREADY CARRY A CREDENTIAL?
#
# Round 3 answered this with an `@`-ANYWHERE test, deliberately, to keep a real trap closed: the
# precise-looking alternative — "the authority is everything up to the first `/`" — is defeated by a
# password containing an unencoded slash, which ends that scan BEFORE the `@`, so a URL that HAS a
# credential reads as having none and gets a SECOND one spliced in front of it.
#
# The cost of the over-broad test is the other direction, and it is just as total: a URL whose `@` is
# in the PATH or the QUERY (`redis://host:6379/0?tag=a@b`) reads as already-credentialled, the typed
# password is dropped, and REDIS_PASSWORD_ENV is blanked because the URL is believed to carry it — so
# nothing reaches AUTH and the login buckets fail closed. Nobody can sign in to the server just
# installed, which is the exact failure this whole issue is about.
#
# THE RULE THAT IS RIGHT IN BOTH DIRECTIONS is to answer only when the answer is forced, and to
# REFUSE otherwise:
#
#   has        The authority — the text between `://` and the first `/`, `?` or `#` — contains an
#              `@`. Inside an authority an `@` can only be the userinfo separator, so this is sound.
#   none       The authority is a syntactically valid host[:port] (or a bracketed IPv6 literal). Then
#              by RFC 3986 there is no userinfo, and — the part that matters — that is also how the
#              Redis client parses it at runtime, so splicing a credential in front produces exactly
#              the URL the client will authenticate with. An `@` anywhere after the authority is in
#              the path or query and is none of our business.
#   ambiguous  The authority is neither. That is what an unencoded slash inside userinfo looks like
#              (`redis://:pa/ss@host` → authority `:pa`), and it is indistinguishable from a
#              malformed host. REFUSING costs the operator one message telling them to percent-encode
#              the password; guessing costs the install, in one direction or the other.
#   no-scheme  No `://` at all — there is nowhere to put a credential.
redis_url_credential_state() {
  local url="$1" after authority
  if [[ "${url}" != *"://"* ]]; then
    printf 'no-scheme'
    return 0
  fi
  after="${url#*://}"
  authority="${after%%[/?#]*}"
  if [[ "${authority}" == *"@"* ]]; then
    printf 'has'
    return 0
  fi
  # A bracketed IPv6 literal, or a registered name / IPv4 address, each with an optional numeric
  # port. Anything else — an empty host, a `:` followed by non-digits, a stray bracket — is a shape
  # this cannot reason about.
  if [[ "${authority}" =~ ^\[[0-9A-Fa-f:.]+\](:[0-9]+)?$ ]] || [[ "${authority}" =~ ^[^][@/?#:]+(:[0-9]+)?$ ]]; then
    printf 'none'
    return 0
  fi
  printf 'ambiguous'
}

# A prompt default is echoed to the terminal and captured by any typescript of the
# install, so a credential recovered from an existing .env is NEVER the thing shown.
# Pressing Enter still keeps the real value.
mask_secret() {
  if [[ -n "${1:-}" ]]; then
    printf 'unchanged'
  fi
  return 0
}

# ---------------------------------------------------------------------------
# What an earlier run of this installer already committed to (o3d-tsc0)
# ---------------------------------------------------------------------------
# An upgrade run that breaks a working install is worse than a bad first install: the
# operator has no reason to suspect the installer, and the failure is total. The .env
# is written by an UNQUOTED heredoc, so `KEY=VALUE` to end of line is exactly what a
# previous run wrote and reading it back the same way round-trips byte for byte.
declare -A EXISTING_ENV=()

# o3d-l89a r4 (Codex r3 finding 2) — A FILE WE CANNOT READ IS NOT A FILE WITH NO SECRETS.
#
# Round 3 preserved the three secrets that cannot be re-minted, and the preservation is only as
# strong as what happens when the read does not succeed. `[[ -f ]] || return 0` answered "no
# previous install" for a path this script could not read at all — an unreadable file, a directory,
# a dangling symlink — and every one of those routed straight back to minting. Minting a fresh
# SETTINGS_ENCRYPTION_KEY over a live database is the same catastrophe the preservation exists to
# prevent, reached by a different door, and it is silent: the install "succeeds" and every encrypted
# Setting in the database is permanently undecryptable.
#
# So the three outcomes are now distinct and this variable carries which one happened:
#   absent — nothing at that path. A first install; minting is CORRECT here and only here.
#   read   — the file was opened and read to the end, and EXISTING_ENV is what it held.
#   (the third is not a value: an unreadable path REFUSES, because there is nothing safe to assume.)
ENV_FILE_STATE=absent

load_existing_env() {
  local file="$1" line key value
  local -a lines=()
  ENV_FILE_STATE=absent

  # `-e` misses a DANGLING SYMLINK, which is a path that exists and cannot be read — the exact shape
  # this is about — so the symlink test is separate.
  if [[ ! -e "${file}" && ! -L "${file}" ]]; then
    return 0
  fi
  if [[ ! -f "${file}" ]]; then
    die "${file} exists but is not a regular file, so the secrets a previous install committed to cannot be read. Refusing to continue: minting new ones over a live database makes every encrypted setting permanently undecryptable. Fix or move that path and run the installer again."
  fi
  if [[ ! -r "${file}" ]]; then
    die "${file} exists but is not readable by this process (run the installer as root), so the secrets a previous install committed to cannot be read. Refusing to continue rather than minting new ones over a live database."
  fi
  # Read it in ONE operation that can fail visibly. The `while read` loop it replaces cannot tell an
  # I/O error from end-of-file — both end the loop — so a read that stopped half way through the
  # file looked exactly like a complete one, and the keys past that point read as absent.
  if ! mapfile -t lines < "${file}"; then
    die "${file} could not be read to the end, so the secrets a previous install committed to are unknown. Refusing to continue rather than minting new ones over a live database."
  fi

  for line in "${lines[@]}"; do
    [[ "${line}" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "${line}" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    EXISTING_ENV["${key}"]="${value}"
  done
  ENV_FILE_STATE=read
}

# o3d-l89a r4 (Codex r3 finding 2), second half — A PARTIAL FILE IS NOT A FIRST INSTALL EITHER.
#
# A `.env` that was read successfully but does not contain all three is not an installation with no
# secrets: this script writes all three, every time, so a file missing one was truncated, partially
# written by an interrupted run, or hand-edited. `existing_env`'s fallback then mints — quietly, and
# irreversibly for SETTINGS_ENCRYPTION_KEY.
#
# THE REFUSAL IS NOT A DEAD END. It names the missing keys and the two ways forward: put the real
# values back (they are in the backup, or in the running service's environment), or — if this really
# is a fresh start and the database is expendable — set IMS_INSTALL_REMINT_SECRETS=yes, which is a
# deliberate statement rather than a default.
require_preserved_secrets() {
  [[ "${ENV_FILE_STATE:-absent}" == "read" ]] || return 0
  # The three values this installer generates that CANNOT be re-minted without breaking the install
  # they belong to.
  local -a IRREVERSIBLE_SECRET_KEYS=(AUTH_SECRET SETTINGS_ENCRYPTION_KEY CRON_SECRET)
  local key missing=()
  for key in "${IRREVERSIBLE_SECRET_KEYS[@]}"; do
    [[ -n "${EXISTING_ENV[${key}]-}" ]] || missing+=("${key}")
  done
  (( ${#missing[@]} )) || return 0
  if [[ "${IMS_INSTALL_REMINT_SECRETS:-}" == "yes" ]]; then
    warn "IMS_INSTALL_REMINT_SECRETS=yes: minting a fresh ${missing[*]} even though ${APP_DIR}/.env already exists. Every encrypted setting written under the previous SETTINGS_ENCRYPTION_KEY becomes permanently undecryptable, and every existing session is invalidated."
    return 0
  fi
  die "${APP_DIR}/.env exists but does not carry ${missing[*]}. This installer writes all of ${IRREVERSIBLE_SECRET_KEYS[*]} on every run, so a file missing one was truncated or hand-edited — it is NOT a fresh installation. Refusing to mint new ones: a new SETTINGS_ENCRYPTION_KEY makes every encrypted setting already in the database permanently undecryptable, a new AUTH_SECRET invalidates every session, and a new CRON_SECRET makes the crontab this script wrote unauthorised. Restore the missing line(s) from your backup or from the running service's environment, or set IMS_INSTALL_REMINT_SECRETS=yes if this really is a fresh start and the existing data is expendable."
}

# The value the previous run wrote, or the supplied fallback on a first install.
existing_env() {
  local key="$1" fallback="${2:-}"
  if [[ -n "${EXISTING_ENV[${key}]-}" ]]; then
    printf '%s' "${EXISTING_ENV[${key}]}"
  else
    printf '%s' "${fallback}"
  fi
}

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
# A fifth argument overrides what is DISPLAYED as the default, without changing what
# Enter selects. Defaults are now recovered from an existing .env (see below), and a
# recovered credential must not be echoed to the terminal or into a typescript of the
# install just because it is the default.
#
# The assignment is `printf -v`, not `eval`. `eval` re-parsed the default and the
# operator's own keystrokes as shell source, so a preserved value containing a quote,
# a `$` or a backtick was either mangled or executed — which is the same "stored as
# one byte sequence, used as another" failure this issue is about, in the one place
# that would run it.
prompt() {
  local varname="$1" question="$2" default="$3" secret="${4:-}" shown current
  shown="${default}"
  [[ $# -lt 5 ]] || shown="$5"
  if $NON_INTERACTIVE; then
    current="${!varname-}"
    printf -v "$varname" '%s' "${current:-${default}}"
    return
  fi
  if [[ "$secret" == "secret" ]]; then
    read -r -s -p "$(echo -e "${BOLD}${question}${RESET} [${shown}]: ")" input
    echo ""
  else
    read -r -p "$(echo -e "${BOLD}${question}${RESET} [${shown}]: ")" input
  fi
  printf -v "$varname" '%s' "${input:-${default}}"
}

prompt_yn() {
  local varname="$1" question="$2" default="${3:-y}" current
  if $NON_INTERACTIVE; then
    current="${!varname-}"
    printf -v "$varname" '%s' "${current:-${default}}"
    return
  fi
  local options="[Y/n]"; [[ "$default" == "n" ]] && options="[y/N]"
  read -r -p "$(echo -e "${BOLD}${question}${RESET} ${options}: ")" input
  input="${input:-$default}"
  printf -v "$varname" '%s' "${input,,}"
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

# Running the installer a SECOND time must not undo the first run (o3d-tsc0). Every
# preserved prompt below defaults to what the previous run committed to
# ${APP_DIR}/.env, so accepting the defaults on an upgrade re-writes the same values
# rather than the factory ones. Before this, a re-run replaced a working REDIS_URL
# with `redis://localhost:6379`, dropped the password, and minted a fresh
# AUTH_SECRET, CRON_SECRET and SETTINGS_ENCRYPTION_KEY. That is a worse failure than
# a bad first install: the operator has no reason to suspect the installer, the
# Redis half fails CLOSED so it reads as "nobody can sign in", and a re-minted
# SETTINGS_ENCRYPTION_KEY makes every encrypted Setting already in the database
# permanently undecryptable.
load_existing_env "${APP_DIR}/.env"

echo -e "${YELLOW}Please provide the following configuration values."
echo -e "Press Enter to accept the default shown in brackets.${RESET}"
if (( ${#EXISTING_ENV[@]} > 0 )); then
  echo -e "${YELLOW}An existing ${APP_DIR}/.env was found — its values are the defaults.${RESET}"
fi
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

# What an EARLIER run already made work, recovered before anything is prompted.
# REDIS_URL is canonical, so the credential to keep is the one encoded in the URL —
# not the compatibility line, which this installer deliberately leaves empty whenever
# the URL carries the secret. Decoding it back means an operator who presses Enter
# through an upgrade keeps BOTH ends: the same bytes go back into redis.conf and back
# into the URL. The userinfo ends at the LAST `@` for the same reason the redaction
# cuts there (see redact_url_credentials): any earlier `@` may be part of the
# credential itself.
EXISTING_REDIS_URL="$(existing_env REDIS_URL)"
EXISTING_REDIS_USERINFO=""
case "${EXISTING_REDIS_URL}" in
  *"://"*"@"*)
    EXISTING_REDIS_USERINFO="${EXISTING_REDIS_URL#*://}"
    EXISTING_REDIS_USERINFO="${EXISTING_REDIS_USERINFO%@*}"
    ;;
esac
EXISTING_REDIS_USERNAME=""
EXISTING_REDIS_PASSWORD=""
if [[ -n "${EXISTING_REDIS_USERINFO}" ]]; then
  # Percent-encoding guarantees the password's own `:` is escaped, so the FIRST colon
  # is the user/password delimiter and nothing here has to guess.
  if [[ "${EXISTING_REDIS_USERINFO}" == *":"* ]]; then
    EXISTING_REDIS_USERNAME="$(urldecode "${EXISTING_REDIS_USERINFO%%:*}")"
    EXISTING_REDIS_PASSWORD="$(urldecode "${EXISTING_REDIS_USERINFO#*:}")"
  else
    EXISTING_REDIS_USERNAME="$(urldecode "${EXISTING_REDIS_USERINFO}")"
  fi
fi
# The compatibility line is consulted only when the URL carried no credential at all.
if [[ -z "${EXISTING_REDIS_PASSWORD}" ]]; then
  EXISTING_REDIS_PASSWORD="$(existing_env REDIS_PASSWORD)"
fi

REDIS_USERINFO=""
REDIS_URL_HAS_CREDENTIAL=n
if [[ "$INSTALL_REDIS" == "y" ]]; then
  REDIS_HOST="localhost"
  prompt REDIS_PORT     "Redis port" "6379"
  prompt REDIS_PASSWORD "Redis password (leave blank if none)" "${EXISTING_REDIS_PASSWORD}" "secret" \
    "$(mask_secret "${EXISTING_REDIS_PASSWORD}")"
  # The password has to go INTO the URL, because REDIS_URL is what the
  # application connects with (o3d-tsc0). This line used to build the URL
  # credential-free while the block further down wrote `requirepass` into
  # redis.conf, so choosing a Redis password here produced a server that
  # answered NOAUTH to its own installer's application — and the auth rate-limit
  # buckets fail CLOSED, so that surfaces as nobody being able to sign in.
  # The URL becomes the ONE place the credential lives: see REDIS_PASSWORD_ENV
  # below for why the .env compatibility line is then deliberately left empty
  # rather than carrying a second copy of the same secret.
  if [[ -n "${REDIS_PASSWORD}" ]]; then
    REDIS_USERINFO=":$(urlencode "${REDIS_PASSWORD}")@"
    if [[ -n "${EXISTING_REDIS_USERNAME}" ]]; then
      # A Redis 6 ACL username this installer never prompts for, but which a previous
      # run or a hand edit may have put in the URL. Dropping it on a re-run turns
      # `AUTH <user> <pass>` into `AUTH <pass>`, which the server refuses — the same
      # lockout by a different route, so carry it through.
      REDIS_USERINFO="$(urlencode "${EXISTING_REDIS_USERNAME}"):$(urlencode "${REDIS_PASSWORD}")@"
    fi
    REDIS_URL_HAS_CREDENTIAL=y
  fi
  REDIS_URL="redis://${REDIS_USERINFO}${REDIS_HOST}:${REDIS_PORT}"
else
  prompt REDIS_URL      "Redis URL (redis://host:port[/db])" \
    "$(existing_env REDIS_URL 'redis://localhost:6379')" "" \
    "$(redact_url_credentials "$(existing_env REDIS_URL 'redis://localhost:6379')")"
  prompt REDIS_PASSWORD "Redis password (leave blank if none)" "${EXISTING_REDIS_PASSWORD}" "secret" \
    "$(mask_secret "${EXISTING_REDIS_PASSWORD}")"
  # THE EXTERNAL-REDIS OPERATOR WAS STILL IN THE PRE-FIX STATE. Round one put the
  # credential in the URL only on the local-install path; an operator pointing this
  # installer at a Redis they already run typed a password at the prompt above that
  # NOTHING READS — the client connects with REDIS_URL — so they were handed a server
  # nobody can sign in to, exactly as before. The password goes where it is read.
  if [[ -n "${REDIS_PASSWORD}" ]]; then
    case "$(redis_url_credential_state "${REDIS_URL}")" in
      has)
        # The URL already carries a credential, so it WINS and is left verbatim: an
        # inline credential already beats any environment fallback at runtime, and
        # rewriting an operator's own connection string is how you end up
        # authenticating with something nobody typed.
        REDIS_URL_HAS_CREDENTIAL=y
        if [[ "${REDIS_URL}" != "${EXISTING_REDIS_URL}" || "${REDIS_PASSWORD}" != "${EXISTING_REDIS_PASSWORD}" ]]; then
          # Silent when a re-run changed NOTHING: there the "ignored" password IS the
          # one recovered from that very URL, and a warning printed on every ordinary
          # upgrade is a warning operators learn to skip past.
          warn "REDIS_URL already carries a credential, so the password entered at the Redis prompt is ignored — the application authenticates with REDIS_URL. Clear one of the two if that is not what you meant."
        fi
        ;;
      none)
        REDIS_URL="${REDIS_URL%%://*}://:$(urlencode "${REDIS_PASSWORD}")@${REDIS_URL#*://}"
        REDIS_URL_HAS_CREDENTIAL=y
        ;;
      ambiguous)
        die "REDIS_URL is not a shape this installer can place a password into: the text between '://' and the first '/', '?' or '#' is neither a host[:port] nor something carrying a credential. That is what an unencoded '/' inside a password looks like, and it cannot be told apart from a malformed host — so nothing was changed rather than guessing, which in one direction splices a SECOND credential in front of yours and in the other drops the password entirely. Percent-encode the password inside REDIS_URL (a '/' is %2F) and leave the Redis password prompt blank, or give a plain redis://host:port[/db] and let the installer place the password."
        ;;
      *)
        die "REDIS_URL must be of the form redis://host:port[/db] so the Redis password can be placed inside it. The application authenticates with REDIS_URL, and a password that never reaches AUTH takes sign-in down with it, because the login rate-limit buckets fail closed."
        ;;
    esac
  fi
fi
prompt REDIS_KEY_PREFIX "Redis key prefix (leave blank for none)" "$(existing_env REDIS_KEY_PREFIX)"
# What the compatibility line in .env gets. When the credential is IN REDIS_URL —
# whether this installer put it there or the operator did — this stays EMPTY on
# purpose: writing the same secret to two places is what this issue removed, and it is
# not a tidiness argument. The raw value would go into .env unquoted, so a password
# containing `#`, a quote or whitespace arrives at the runtime as something OTHER than
# what is encoded in the URL — and a REDIS_URL/REDIS_PASSWORD disagreement is refused
# outright rather than resolved by precedence (o3d-uqz0), which would take the rate
# limiter down on a host whose URL was actually correct. REDIS_PASSWORD itself is
# untouched and still configures `requirepass` further down.
REDIS_PASSWORD_ENV="${REDIS_PASSWORD}"
if [[ "${REDIS_URL_HAS_CREDENTIAL}" == "y" ]]; then
  REDIS_PASSWORD_ENV=""
fi

echo ""
info "--- WooCommerce (optional — can be configured later in Settings) ---"
prompt WC_STORE_URL       "WooCommerce store URL"      ""
prompt WC_CONSUMER_KEY    "WooCommerce consumer key"   ""
prompt WC_CONSUMER_SECRET "WooCommerce consumer secret" "" "secret"
prompt WC_WEBHOOK_SECRET  "WooCommerce webhook secret"  "$(openssl rand -hex 16)" "secret"

# Xero is configured entirely in the app: the client id/secret are stored in the
# settings table and connecting requires the interactive OAuth consent round
# trip regardless. Prompting here wrote two secrets into .env that nothing read
# (o3d-esha).

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
    # THE SERVER SIDE OF THE CREDENTIAL. What goes in here must be the same bytes the
    # client sends in REDIS_URL, or the install is dead on arrival in the way that is
    # hardest to diagnose: the auth rate-limit buckets fail CLOSED, so a Redis that
    # answers NOAUTH looks like nobody being able to sign in rather than like Redis.
    #
    # It used to be written through shell interpolation into a sed replacement (`&` is
    # the whole match there, `\1` a backreference, `|` the delimiter) or appended raw
    # into a file redis parses with sdssplitargs (whitespace splits the token, and a
    # `"` or `'` anywhere in it opens a quoted section). Either way a password
    # containing a quote, a hash, a backslash or a space was STORED as one byte
    # sequence and SENT as another. redis_conf_quote emits every byte as \xHH from the
    # same LC_ALL=C byte walk as urlencode, and redis_conf_set_requirepass never lets
    # sed see the password at all.
    if [[ -n "${REDIS_PASSWORD}" ]]; then
      redis_conf_set_requirepass "${REDIS_CONF}" "requirepass $(redis_conf_quote "${REDIS_PASSWORD}")"
    else
      redis_conf_set_requirepass "${REDIS_CONF}" "# requirepass foobared"
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

# Migrate uploads from any previous in-tree location to the new storage roots.
# Existing DB rows reference filenames only, so files left behind under
# ${APP_DIR}/uploads or ${APP_DIR}/public/uploads will 404 after restart once
# the .env points the app at the new roots. Move (not copy) so re-runs are
# idempotent — `mv -n` skips files that already exist in the destination.
migrate_uploads() {
  local src="$1"
  local dest="$2"
  if [[ -d "${src}" ]] && [[ -n "$(find "${src}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    info "Migrating legacy uploads: ${src} -> ${dest}"
    mkdir -p "${dest}"
    find "${src}" -mindepth 1 -maxdepth 1 -exec mv -n -t "${dest}" {} +
    rmdir "${src}" 2>/dev/null || true
  fi
}

migrate_uploads "${APP_DIR}/uploads/invoices" "${UPLOAD_STORAGE_DIR}/invoices"
migrate_uploads "${APP_DIR}/uploads/quarantine/invoices" "${UPLOAD_STORAGE_DIR}/quarantine/invoices"
migrate_uploads "${APP_DIR}/public/uploads/branding" "${PUBLIC_UPLOAD_STORAGE_DIR}/branding"
migrate_uploads "${APP_DIR}/public/uploads/avatars" "${PUBLIC_UPLOAD_STORAGE_DIR}/avatars"

chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${LOG_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${UPLOAD_STORAGE_DIR}" "${PUBLIC_UPLOAD_STORAGE_DIR}"

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

# Minted on a FIRST install and KEPT on every run after it (o3d-tsc0). Re-minting
# these on an upgrade is not a fresh start, it is a break, and a silent one:
# AUTH_SECRET invalidates every existing session, CRON_SECRET makes the crontab this
# same script wrote unauthorised against the app it points at, and a new
# SETTINGS_ENCRYPTION_KEY makes every encrypted Setting already in the database —
# Xero tokens, connector secrets — permanently undecryptable. openssl is still run on
# a first install; existing_env only answers when the previous .env had the line.
AUTH_SECRET="$(existing_env AUTH_SECRET "$(openssl rand -base64 32)")"
SETTINGS_ENCRYPTION_KEY="$(existing_env SETTINGS_ENCRYPTION_KEY "$(openssl rand -base64 32)")"
CRON_SECRET="$(existing_env CRON_SECRET "$(openssl rand -hex 32)")"
# The last moment before the mint becomes a FACT. Nothing above has been written anywhere — the
# three values are still only shell variables — and the heredoc below is what commits them. A `.env`
# that was read but is missing any of them was truncated or hand-edited rather than absent, and
# `existing_env` cannot tell those apart: it answers "not present" identically for both.
require_preserved_secrets

cat > "${APP_DIR}/.env" <<EOF
# One Two Inventory — generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

NODE_ENV=production
# What this deployment IS, as opposed to what it was built as. NODE_ENV is set
# by the build and says `production` on stage and on a test rig too, so it
# cannot be the thing that exempts production from a guard (o3d-l89a).
IMS_INSTANCE_ROLE=production
APP_PORT=${APP_PORT}
AUTH_SECRET=${AUTH_SECRET}
SETTINGS_ENCRYPTION_KEY=${SETTINGS_ENCRYPTION_KEY}

DATABASE_URL=${DATABASE_URL}
NEXT_PUBLIC_APP_URL=https://${APP_DOMAIN}
AUTH_URL=https://${APP_DOMAIN}

REDIS_URL=${REDIS_URL}
REDIS_PASSWORD=${REDIS_PASSWORD_ENV}
REDIS_KEY_PREFIX=${REDIS_KEY_PREFIX}

WC_STORE_URL=${WC_STORE_URL}
WC_CONSUMER_KEY=${WC_CONSUMER_KEY}
WC_CONSUMER_SECRET=${WC_CONSUMER_SECRET}
WC_WEBHOOK_SECRET=${WC_WEBHOOK_SECRET}
# Order status filter, webhook-vs-polling and the poll interval are application
# settings (Settings -> Sync -> WooCommerce), not env vars. Writing them here
# produced lines nothing read (o3d-tj6v).

# Xero client id/secret live in the settings table (Settings -> Integrations ->
# Xero). Tokens are encrypted in Postgres, so there is no XERO_TOKEN_PATH.
# XERO_TENANT_ID is DEPRECATED and no longer written by the installer (o3d-9tbz). It is
# still read, as a single-organisation form of XERO_ALLOWED_TENANT_IDS, so that existing
# installs that set it are protected — new installs should use the allow-list below.
# Which Xero organisations this instance may use (o3d-9tbz). Comma-separated, blank =
# unrestricted. Set an ID-based control on every non-production install: it is the only
# tenant control that survives a database reset. A tenantId is an identity; an
# organisation NAME is not (Xero names are neither unique nor fixed), so
# XERO_ALLOWED_TENANT_NAMES only NARROWS the ids and must not be the only control.
# On a test rig connected to Xero's Demo company, XERO_REQUIRE_DEMO_ORG=true is the
# control to set: it is proven from Xero's own IsDemoCompany flag, so it needs no
# maintenance when the Demo organisation is re-created with a new tenantId AND it does
# not have to enumerate organisations in advance the way a deny-list does.
# XERO_ALLOWED_TENANT_IDS=
# XERO_BLOCKED_TENANT_IDS=
# XERO_ALLOWED_TENANT_NAMES=
# XERO_REQUIRE_DEMO_ORG=false

CRON_SECRET=${CRON_SECRET}
NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}
TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}

BACKUP_DIR=${BACKUP_DIR}
UPLOAD_STORAGE_DIR=${UPLOAD_STORAGE_DIR}
PUBLIC_UPLOAD_STORAGE_DIR=${PUBLIC_UPLOAD_STORAGE_DIR}
FILE_SCAN_MODE=disabled
FILE_SCAN_COMMAND_ARGV=
FILE_SCAN_COMMAND=
FILE_SCAN_NAME=
FILE_SCAN_ENV_ALLOWLIST=PATH,HOME,TMPDIR,TEMP,TMP,LANG,LC_ALL
FILE_SCAN_TIMEOUT_MS=30000
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

if [[ -n "${DEFAULT_ADMIN_EMAIL}" || -n "${SMTP_HOST}" || -n "${SMTP_FROM_EMAIL}" || -n "${APP_DOMAIN}" || -n "${WC_STORE_URL}" ]]; then
  header "Bootstrapping default admin and seeded settings"
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
    WC_STORE_URL="${WC_STORE_URL}" \
    WC_CONSUMER_KEY="${WC_CONSUMER_KEY}" \
    WC_CONSUMER_SECRET="${WC_CONSUMER_SECRET}" \
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

# The bootstrap jobs are written INSIDE the OTI markers, in the SAME managed
# format the in-app scheduler sync (Settings -> System -> Scheduler) emits, so
# the first in-app save splices/replaces this block in place instead of leaving
# duplicate unmanaged lines that drift on secret rotation (onetwo3d-ims-ryxy).
# Runtime-read secret + [ -n ] guard + managed LOG_DIR log path.
CRON_ENV_FILE="${APP_DIR}/.env"
CRON_LOG_FILE="${LOG_DIR}/cron.log"
CRON_CURL_PREFIX="CRON_SECRET=\$(grep -m1 '^CRON_SECRET=' '${CRON_ENV_FILE}' | cut -d= -f2- | tr -d '\"') && [ -n \"\$CRON_SECRET\" ] && curl -sf -o /dev/null -H \"Authorization: Bearer \$CRON_SECRET\""
CRON_BASE="http://localhost:${APP_PORT}/api/cron"

# schedule|slug|label pairs for the bootstrap set
CRON_JOBS=(
  "0 1 * * *|account-balance-snapshot|Account Balance Snapshot"
  "0 6 * * *|fx-rates|FX Rate Update"
  "0 3 * * *|activity-cleanup|Activity Log Cleanup"
  "0 2 * * *|backup|Database Backup"
  "0 4 * * *|wc-reconcile|WooCommerce Reconciliation"
  "*/15 * * * *|delivery-status|Delivery Status Check"
  "*/15 * * * *|refund-reservation-release|Refund Reservation Release"
  "*/15 * * * *|wc-withdrawal-sweep|WooCommerce Withdrawal Sweep"
)

# Build the fresh managed block into a temp file (cleaned up on ANY exit —
# Codex r9: the temp file must not leak if the pipeline below fails).
CRON_BLOCK_FILE="$(mktemp -t oti-cron.XXXXXX)"
trap 'rm -f "${CRON_BLOCK_FILE}"' EXIT
{
  echo "# --- OTI CRON START ---"
  echo "# Managed by One Two Inventory — do not edit manually"
  echo "# CRON_SECRET is read from ${CRON_ENV_FILE} at runtime — rotating it needs no crontab re-sync."
  echo "BASE_URL=\"${CRON_BASE}\""
  echo ""
  for job in "${CRON_JOBS[@]}"; do
    IFS='|' read -r sched slug label <<< "$job"
    echo "# ${label}"
    echo "${sched}  ${CRON_CURL_PREFIX} \"\$BASE_URL/${slug}\" >> '${CRON_LOG_FILE}' 2>&1"
    echo ""
  done
  echo "# --- OTI CRON END ---"
} > "${CRON_BLOCK_FILE}"

# Replace the managed block IN PLACE, preserving the operator's own lines AND
# the block's original position among them (onetwo3d-ims-ryxy / Codex r4-r8).
# Mirrors the app-side computeOtiDrops/spliceOtiBlock (lib/crontab-sync.ts):
#   - drops EVERY complete START..END block (markers tolerant of trailing
#     whitespace/CR); a START..next-START without an END is a malformed tail,
#   - never deletes past an UNCLOSED start marker; within a malformed tail it
#     drops ONLY our own remnants (job/header/BASE_URL), keeping operator lines,
#   - a managed job line is our EXACT generated signature (byte-identical to the
#     TS constant), so an operator line using a different Authorization form is
#     preserved; legacy pre-marker localhost:APP_PORT/api/cron/ lines are cleared,
#   - the fresh block is re-inserted where the first managed marker was (NOT at
#     EOF), so it never jumps past an operator PATH/SHELL/CRON_TZ assignment.
# `|| true` so a fresh box with NO existing crontab (crontab -l exits nonzero)
# doesn't trip `set -euo pipefail` and abort the install (Codex r9).
{ crontab -u "${APP_USER}" -l 2>/dev/null || true; } | awk -v port="${APP_PORT}" -v blockfile="${CRON_BLOCK_FILE}" '
  function isStart(x) { return x ~ /^# --- OTI CRON START ---[ \t\r]*$/ }
  function isEnd(x)   { return x ~ /^# --- OTI CRON END ---[ \t\r]*$/ }
  function isRemnant(x) {
    managed = "-H \"Authorization: Bearer $CRON_SECRET\" \"$BASE_URL/"   # exact generated job signature (== TS)
    return (index(x, managed) > 0 \
      || x ~ /^# CRON_SECRET is read from .* at runtime/ \
      || x ~ /^# Managed by One Two Inventory/ \
      || x ~ /^BASE_URL="/)
  }
  function emitBlock(  bl) { while ((getline bl < blockfile) > 0) print bl; close(blockfile) }
  { line[NR] = $0 }
  END {
    i = 1; firstMarker = 0
    while (i <= NR) {
      if (isStart(line[i])) {
        if (firstMarker == 0) firstMarker = i
        j = i + 1
        while (j <= NR && !isEnd(line[j]) && !isStart(line[j])) j++
        if (j <= NR && isEnd(line[j])) { for (k = i; k <= j; k++) drop[k] = 1; i = j + 1; continue }
        drop[i] = 1   # unclosed START: marker + our tail remnants, keep operator lines
        for (k = i + 1; k < j; k++) if (isEnd(line[k]) || isRemnant(line[k])) drop[k] = 1
        i = j
        continue
      }
      if (isEnd(line[i])) { if (firstMarker == 0) firstMarker = i; drop[i] = 1 }   # stray END
      i++
    }
    legacy = "localhost:" port "/api/cron/"   # pre-r4 bootstrap lines predate the markers
    emitted = 0
    for (i = 1; i <= NR; i++) {
      if (i == firstMarker) { emitBlock(); emitted = 1 }
      if (drop[i]) continue
      if (index(line[i], legacy) > 0) continue
      print line[i]
    }
    if (!emitted) emitBlock()   # no prior block → append at end
  }
' | crontab -u "${APP_USER}" -
rm -f "${CRON_BLOCK_FILE}"
trap - EXIT   # risky window over; drop the cleanup trap

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
