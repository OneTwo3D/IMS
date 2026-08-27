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
#   9. Installs npm dependencies, then BUILDS the app while any existing installation is
#      still serving (nothing is stopped until the artefact has been validated)
#  10. Stops and drains every writer, then runs database migrations
#  11. Writes the systemd service and health-checks the new build
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
  ENV_FILE_STATE="read"
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

# dotenv's own quoting rule, applied to a value read back out of .env.
#
# read_existing_env() stores the raw right-hand side, which is right for everything THIS SCRIPT
# writes (it writes bare values with no trailing comments, so a round trip through its own file is
# exact). It is not right for a value an OPERATOR hand-edits, and DEPLOY_ADMIN_DATABASE_URL is now
# exactly that: mandatory, set by hand, and a URL that invites quoting. Carried forward raw, a
# perfectly ordinary `DEPLOY_ADMIN_DATABASE_URL="postgres://..."  # deploy admin` is written back
# out unquoted, complete with a double quote at each end and the words "deploy admin" on the end.
#
# The rule followed is dotenv's, because dotenv is what reads this file everywhere else: a quoted
# value ends at its closing quote, an unquoted one ends at the first whitespace-preceded `#`.
# (o3d-2sm1.5, Codex r4 MEDIUM — the same defect the deploy.sh `grep | cut` had.)
unquote_env_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  case "${value}" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *)
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "${value}"
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

# ---------------------------------------------------------------------------
# THE UPGRADE CUTOVER FENCE (o3d-2sm1.3)
# ---------------------------------------------------------------------------
# THIS INSTALLER IS A SUPPORTED UPGRADE ENTRYPOINT. It reads back the .env a previous
# run wrote, preserves the secrets it cannot re-mint, keeps a working REDIS_URL, and
# says so throughout — it is explicitly designed to be run again over an existing
# installation. And until now it applied `prisma migrate deploy` with the existing
# service RUNNING and the existing crontab LIVE, which is the exact defect o3d-2sm1.1
# removed from deploy.sh and update.sh: the predecessor binary keeps writing while the
# schema moves under it. A refund-reversal witness column lands NULL on every row the
# old binary inserts and its own retry then clears the accounting invariant's only
# bound; a shopping-sync discriminator can be OVERWRITTEN by the old binary in a way
# neither repairable nor detectable. An upgrade path with that defect is not less
# dangerous for being called "install".
#
# So a re-run over an existing installation now performs the same sequence deploy.sh and
# update.sh do — AND IN THE SAME ORDER (o3d-2sm1.5, Codex r4 CRITICAL):
#
#   build -> validate -> stop and drain every writer -> migrate -> drift -> object access
#         -> verify -> seed -> bootstrap -> start -> health
#
# The order this comment used to describe put the BUILD inside the stopped window — after
# the migration and the verification — which inverts this branch's founding premise
# (everything that can reject a release must reject it while the predecessor is still up)
# on the entrypoint the docs say follows the same sequence. A TypeScript error costs
# nothing on deploy.sh; here it left the service stopped, cron fenced, the schema migrated
# and the connection fence held.
#
# The SEED and the BOOTSTRAP deliberately stay inside the window. They are not validations
# that can reject a release; they are writes, and they need the schema the migration has
# just applied. Running them before the stop would have new code writing to the old schema
# — the overlap this whole order exists to prevent.
#
# and the same three fences, established in the same order and with the same rules:
#
#   * THE REBOOT FENCE is a drop-in carrying `AssertPathExists=!<marker>`, installed
#     and VERIFIED against `systemctl show -p DropInPaths` BEFORE the stop. Not
#     `systemctl mask`: this unit's own file lives in /etc/systemd/system, which is
#     where the mask symlink would have to go, and `mask --runtime` lives in /run,
#     which the reboot it exists to survive erases.
#   * THE CRON FENCE comments the whole crontab out, from a verbatim backup taken once,
#     and restores it only once the new service has been started.
#   * THE CONNECTION FENCE revokes CONNECT from EVERY grantee that holds it directly —
#     the application role, PUBLIC, and any other role with a direct grant (o3d-2sm1.5,
#     Codex r4 HIGH: revoking from two of them left a monitoring or BI role terminated by
#     the drain and reconnected a moment later, for the whole migration, while every
#     header said the database was held closed) — for the window. It is RELEASED on a failure before the migration was invoked and
#     HELD on one at or after it — releasing there would let the application reconnect
#     to a schema in an unknown state. Every step inside the window that touches the
#     database runs through MIGRATION_DATABASE_URL, which is the privileged connection
#     while the fence is up. IT IS MANDATORY for an existing installation (o3d-2sm1.4,
#     Codex r3 HIGH): exit 3 from the fence script means CONNECT was NOT revoked, and a
#     fence you know is absent is not a degraded fence but no fence, so it aborts rather
#     than falling back to a point-in-time probe anything may connect after. Whether the
#     privileged connection exists at all is checked BEFORE the stop, by RUNNING the fence
#     script in `--preflight` mode rather than by checking that the file exists (o3d-2sm1.5,
#     Codex r4 HIGH: the file-exists check passed while the script itself could not start,
#     its dependency being a devDependency and the documented manual upgrade running
#     `npm ci --omit=dev` — an outage after the stop, for a missing import).
#
#     AND THE MIGRATION RUNS AS THE APPLICATION ROLE (o3d-2sm1.5, Codex r4 CRITICAL). This
#     installer makes the APPLICATION role the database owner, and the fence refuses when
#     the admin role IS the application role — so the only fenceable configuration is a
#     separate SUPERUSER admin, and every table, index and sequence a migration created
#     through it was owned by that superuser with no grant to the application. Nothing in
#     the pipeline could see it: prisma, the drift check and the verification hook all
#     share the admin connection and read everything perfectly. So MIGRATION_DATABASE_URL
#     carries `options=-c role=<app role>` — it CONNECTS as the admin, which is what keeps
#     the fence effective, and RUNS AS the application role, which is what makes the fenced
#     path leave the database exactly as an unfenced one would. And it is not taken on
#     trust: scripts/check-app-db-object-access.mjs asks the database, after the migration,
#     whether the APPLICATION role can use each table, view and sequence, and fails the
#     install if not.
#
#     A FAILED REBOOT-FENCE INSTALL LEAVES NOTHING BEHIND (o3d-2sm1.5, Codex r4 CRITICAL).
#     The marker went down first, then the drop-in, then the reload, then the verify, and
#     any failure after that first line returned into a `die` with FENCE_ARMED still false
#     — so the trap did nothing and the marker stayed, invisible until the next reboot
#     refused to start the unit. The install now removes exactly what that call created.
#
#     AND THERE IS A POINT OF NO RETURN. Once the new build has answered its health check
#     — which this cutover previously did not have at all — nothing tears it down: a
#     failure in nginx, hardening, log rotation or the cron restore is reported, with the
#     commands to finish by hand, and the service is left running.
#
# WHAT COUNTS AS AN EXISTING INSTALLATION (o3d-2sm1.4, Codex r3 HIGH). Not only the new
# systemd unit and an active crontab: this script also supports, and below removes,
# installations run under PM2. Detecting only the new unit meant a PM2-run installation
# was never recognised, so nothing was fenced, nothing was stopped, and the migration ran
# with the old binary live — the defect this cutover exists to close, on the launcher the
# cutover was written to remove. `upgrade_in_place` now also answers yes to a PM2 daemon,
# a `pm2-<user>` unit, an ${APP_DIR}/.pm2 home, or any node process whose working directory
# IS the app directory; and `stop_legacy_launchers` stops, disables and deletes all of them
# BEFORE the migration.
#
# AND `schema_touched` IS WRITTEN AND FLUSHED BEFORE PRISMA IS INVOKED (Codex r3 CRITICAL),
# because a SIGKILL or a power cut mid-migration never reaches the exit trap that used to
# write it — and a marker saying the schema was never touched is read by the next run's
# adoption as licence to release the fence over a half-migrated schema.
#
# A FIRST INSTALL FENCES NOTHING, and that is not an oversight: there is no service,
# no crontab and no data, so there is no writer to stop and no cutover to survive.
# ---------------------------------------------------------------------------
UPGRADE_EXISTING=false
# THE FENCE STATE MACHINE (phases added o3d-2sm1.5, Codex r7 HIGH). Four phases, one
# direction only, and on_cutover_exit does something different in each:
#
# THE PHASE IS ALSO WRITTEN DOWN. A run that is killed never reaches its trap, so the phase it
# had reached has to survive in the marker for the NEXT run to read: write_cutover_marker()
# records `phase=arming|stopping`, and adoption resumes an interrupted `arming` — installation
# still active, schema untouched — instead of stopping a service nobody had touched
# (o3d-2sm1.5, Codex r8 HIGH). See marker_phase() and resume_from_interrupted_arming().
#
#   none      Nothing this run created needs undoing; the trap just exits.
#   arming    CUTOVER_ARMING=true. Reversible cutover state exists — the reboot-fence
#             drop-in and marker, the cron fence — and NOTHING has been asked to stop. The
#             existing installation is up and healthy. A failure here is UNDONE: the
#             crontab goes back verbatim, the drop-in and marker THIS run wrote are
#             removed, and nothing is stopped. See unwind_arming().
#   stopping  FENCE_ARMED=true. A stop has been ATTEMPTED, or a previous run's fence was
#             adopted and its stop already happened.
#   serving   PAST_POINT_OF_NO_RETURN=true. The new build proved it is the process on the
#             port; nothing below may take that away.
#
# The arming phase exists because it was missing: FENCE_ARMED used to be raised before
# `fence_cron`, so an unwritable crontab backup, a failed chmod, a broken pipeline or a
# `crontab` returning non-zero reached the trap looking exactly like a failed migration —
# and the trap STOPPED a service nobody had touched and kept the reboot fence, over a schema
# that had not moved. A failure in the cheap, reversible step ran the expensive,
# outage-causing machinery.
CUTOVER_ARMING=false
FENCE_ARMED=false
# `prisma migrate deploy` HAS BEEN INVOKED. Persisted and flushed BEFORE Prisma is invoked
# (o3d-2sm1.4, Codex r3 CRITICAL): a SIGKILL or a power cut during the migration never
# reaches the exit trap, so a flag that only lives in shell memory leaves a marker saying
# `schema_touched=false` — and the next run's adoption reads exactly that byte and RELEASES
# the connection fence over a half-migrated schema. See mark_schema_touched().
SCHEMA_TOUCHED=false
# Is the connection fence standing RIGHT NOW? Not the same question as SCHEMA_TOUCHED: the
# start step releases the fence while SCHEMA_TOUCHED stays true, so a failure to start must
# not report a fence that is no longer there (Codex r3 HIGH).
DB_FENCE_UP=false
# DID THIS RUN EVER RAISE A CONNECTION FENCE (o3d-2sm1.5, Codex r12 HIGH). DB_FENCE_UP is
# lowered again by every release, so it cannot answer "was there a fence to release at all".
# This one is raised once and never lowered: if it is true and the release then reports it has
# no record to release FROM, the record this run wrote has been lost underneath it — a refusal,
# not a warning.
DB_FENCE_RAISED=false
CRON_FENCED=false
# Did THIS run write the crontab backup? The arming unwind restores from it; an ADOPTED
# backup belongs to a previous run's still-standing fence and must not be touched.
CRON_BACKUP_CREATED=false
CUTOVER_STEP="startup"
# ---------------------------------------------------------------------------
# THE CUTOVER NAMESPACE, AND THERE IS EXACTLY ONE (o3d-2sm1.5, Codex r9 HIGH).
#
# deploy.sh used to keep its marker, cron backup, connection-fence state and lock under
# /var/lib/ims-deploy while this script and update.sh kept theirs under the application data
# directory. The failure banner below nevertheless tells the operator that scripts/deploy.sh
# "adopts this fence", and following that instruction ran deploy.sh against a namespace
# holding none of it: no marker to adopt, no cron backup to reuse, no connection-fence state
# to hold — so it took a fresh backup of an ALREADY FENCED crontab, rewrote the shared
# drop-in, and could finish reporting success with the scheduled writers still commented out
# and this run's marker orphaned. A documented guarantee the code did not deliver.
#
# So all four paths are resolved by the SAME expression in all three scripts, defaulting to
# the application data directory — what the installed unit's AssertPathExists= already names
# and what docs/installation.md documents for a manual fence.
CUTOVER_STATE_DIR="${IMS_CUTOVER_STATE_DIR:-${IMS_DEPLOY_STATE_DIR:-${IMS_DATA_DIR:-/var/lib/one-two-inventory}}}"
FENCE_FILE="${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CRON_BACKUP="${CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
FENCE_DROPIN_DIR="/etc/systemd/system/${APP_NAME}.service.d"
FENCE_DROPIN_FILE="${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
DB_FENCE_DIR="${CUTOVER_STATE_DIR}/deploy"
DB_FENCE_STATE="${DB_FENCE_DIR}/db-connect-fence.json"
# ONE lock for all three entrypoints. deploy.sh and update.sh each held their own and this
# script took none at all, so an install could run straight through another cutover.
LOCK_FILE="${CUTOVER_STATE_DIR}/cutover.lock"
# The namespace deploy.sh wrote to before this round. Nothing writes here any more, and a run
# that finds state at these paths IMPORTS it into the canonical namespace before it changes a
# unit or a crontab — see import_legacy_cutover_state().
LEGACY_CUTOVER_STATE_DIR="${IMS_LEGACY_CUTOVER_STATE_DIR:-/var/lib/ims-deploy}"
LEGACY_FENCE_FILE="${LEGACY_CUTOVER_STATE_DIR}/FENCED"
LEGACY_CRON_BACKUP="${LEGACY_CUTOVER_STATE_DIR}/crontab-${APP_USER}.bak"
LEGACY_DB_FENCE_STATE="${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"
DB_FENCE_SCRIPT="${APP_DIR}/scripts/fence-db-connections.mjs"
DB_OBJECT_ACCESS_SCRIPT="${APP_DIR}/scripts/check-app-db-object-access.mjs"
DB_FENCE_RELEASE_CMD="node ${DB_FENCE_SCRIPT} --release --state-file=${DB_FENCE_STATE}"
# Is the reboot fence ACTUALLY loaded by systemd right now? Distinct from FENCE_ARMED, which
# only says this run has stopped something: the failure banner used to describe a drop-in that
# may never have been installed (o3d-2sm1.5, Codex r4 HIGH).
REBOOT_FENCE_INSTALLED=false
# Rollback bookkeeping for install_reboot_fence(): what THIS call created, so a failure can
# remove exactly that and leave an already-standing fence alone.
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
# The point of no return: the new build has answered its health check AND been shown to be
# the process that answered. Nothing after this may stop it, re-fence it or revoke CONNECT
# again (o3d-2sm1.5, Codex r4 HIGH).
PAST_POINT_OF_NO_RETURN=false
# Did anything PROVE that the build on disk is the process answering the port? An open port
# is not that proof (o3d-2sm1.5, Codex r5 HIGH).
NEW_BUILD_SERVING=false
NEW_BUILD_ID=""
# The connection every database step inside the window runs through. Set to the
# application URL when the window opens and swapped for the privileged one if and when
# the connection fence engages, because the fence shuts the application role out and
# the migration must not be shut out with it.
MIGRATION_DATABASE_URL=""
DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL:-}"

# Every node/npm/next process whose working directory IS this app directory. Scoped by
# /proc/<pid>/cwd rather than by a bare pgrep pattern, so a second instance serving a
# DIFFERENT tree against a DIFFERENT database (the full-chain e2e rig) is never touched.
# This installer's own children are excluded by pid.
app_dir_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local app_real pid cwd
  app_real="$(readlink -f "${APP_DIR}" 2>/dev/null || echo "${APP_DIR}")"
  for pid in $(pgrep -f 'next-server|next dev|next start|npm run dev|npm start|npm run start|PM2|pm2' 2>/dev/null || true); do
    [[ "${pid}" == "$$" || "${pid}" == "${PPID}" ]] && continue
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    [[ "${cwd}" == "${app_real}" ]] && echo "${pid}"
  done
  return 0
}

# A PM2-managed instance of this app, which this installer explicitly supports and later
# removes. Every probe here is READ-ONLY on purpose: `pm2 jlist` would be the direct question,
# but asking it SPAWNS a PM2 daemon under whatever PM2_HOME it is given, so a detector that
# used it would create the very thing it is looking for on a box that had none. The PM2 home
# and the boot unit are what a real PM2 installation leaves behind; a PM2 process actually
# running is caught by app_dir_pids() instead.
legacy_pm2_present() {
  [[ -d "${APP_DIR}/.pm2" ]] && return 0
  [[ -f "/etc/systemd/system/pm2-${APP_USER}.service" ]] && return 0
  systemctl list-unit-files "pm2-${APP_USER}.service" --no-legend --no-pager 2>/dev/null | grep -q . && return 0
  return 1
}

# Is there something here to break? The unit FILE, not `is-active`: a previous install
# whose service is merely stopped still has a crontab, a database and a schema.
#
# AND NOT ONLY THE NEW UNIT (o3d-2sm1.4, Codex r3 HIGH). This script supports — and below,
# removes — installations run under PM2, and it detects an app-directory node process by
# its working directory. Checking only the systemd unit file and the crontab meant a
# PM2-run installation was NOT recognised as existing, so no fence was installed, nothing
# was stopped, and the migration ran with the old binary live: the exact defect the cutover
# was added to close, on the launcher the cutover was written to remove.
upgrade_in_place() {
  if [[ -f "/etc/systemd/system/${APP_NAME}.service" ]]; then
    return 0
  fi
  if command -v crontab >/dev/null 2>&1; then
    if crontab -u "${APP_USER}" -l 2>/dev/null | grep -qE '^[[:space:]]*[^#[:space:]]'; then
      return 0
    fi
  fi
  if legacy_pm2_present; then
    return 0
  fi
  if [[ -n "$(app_dir_pids)" ]]; then
    return 0
  fi
  return 1
}

# STOP AND DRAIN THE LAUNCHERS THE UNIT FILE DOES NOT COVER, before the migration rather
# than after it. This block used to live next to the systemd unit install — AFTER the
# schema had moved — so on a PM2 installation the old binary was still serving for the
# whole migration and only killed once it was over.
stop_legacy_launchers() {
  if command -v systemctl >/dev/null 2>&1; then
    # Disabled as well as stopped: a reboot must not bring the predecessor back either,
    # and the AssertPathExists drop-in only fences ${APP_NAME}.service.
    systemctl disable --now "pm2-${APP_USER}" >/dev/null 2>&1 || true
  fi
  if command -v pm2 >/dev/null 2>&1; then
    env PM2_HOME="${APP_DIR}/.pm2" pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true
    env PM2_HOME="${APP_DIR}/.pm2" pm2 kill >/dev/null 2>&1 || true
  fi

  local pids pid still
  pids="$(app_dir_pids)"
  [[ -n "${pids}" ]] || { success "No legacy launcher and no stray app-directory process."; return 0; }

  info "Stopping process(es) still running in ${APP_DIR}:"
  for pid in ${pids}; do
    echo "         ${pid}  $(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | cut -c1-100)"
  done
  for pid in ${pids}; do kill "${pid}" 2>/dev/null || true; done
  for _ in $(seq 1 10); do
    sleep 1
    still=""
    for pid in ${pids}; do kill -0 "${pid}" 2>/dev/null && still="${still} ${pid}"; done
    [[ -z "${still}" ]] && break
  done
  for pid in ${pids}; do
    if kill -0 "${pid}" 2>/dev/null; then
      warn "  SIGKILL ${pid}"
      kill -9 "${pid}" 2>/dev/null || true
    fi
  done
  success "Legacy launchers and stray app-directory processes stopped."
}

# ---------------------------------------------------------------------------
# DURABILITY PRIMITIVES (o3d-2sm1.5, Codex r9 HIGH).
#
# The previous round made the marker and the cron backup ATOMIC — a reader never sees a
# half-written file. That is a different property from DURABLE, and only the second one
# survives a power cut: an atomic rename whose data was never flushed reboots as an empty
# or missing file, and a read-back through the page cache proves the bytes are VISIBLE,
# not that they are on the medium.
#
# So every published file gets two barriers: the file's own data before the rename, and
# the containing directory after it. Without the second, the rename itself is not durable
# and the reboot finds the OLD name — or no name at all.
# ---------------------------------------------------------------------------

# fsync one path. GNU coreutils `sync PATH` opens the path and calls fsync(2) on that
# descriptor, which for a directory is exactly the barrier that makes a rename durable.
# Where that is unavailable, fall back to a whole-filesystem sync, which is a superset.
# It NEVER silently does nothing: a failure is returned so the caller can refuse to
# publish rather than claim a durability it did not get.
fsync_path() {
  local target="$1"
  sync "$target" 2>/dev/null && return 0
  sync 2>/dev/null && return 0
  return 1
}

# Publish stdin at "$1" so that a SIGKILL or a power loss at any instant leaves either the
# PREVIOUS durable content or the complete new content, and never a truncated file.
#
# `> "$FENCE_FILE"` did the opposite: it truncated the authoritative marker first and filled
# it afterwards, so a kill in between left an empty or partial marker at the one path the
# next run reads. Adoption reads an unrecognised phase conservatively as `stopping`, but it
# read the MISSING schema flag as `false` and released the connection fence — over a schema
# that may have been half migrated.
#
# Same directory, so the rename is a rename and not a copy. Every failure path removes the
# temporary file and returns non-zero, leaving the last durable marker untouched.
publish_durable_file() {
  local target="$1" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod 600 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 1: the data, before the name exists. After this the rename can only publish
  # bytes that are already on the medium.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # old name, or neither name, however well the data was flushed.
  #
  # A FAILURE HERE RETURNS NON-ZERO WITH THE NEW BYTES ALREADY AT $target (o3d-2sm1.5, Codex
  # r10 HIGH). That is not a leak, it is the honest answer: the content is VISIBLE and its
  # NAME is not proven, so a power loss can restore the previous directory entry and with it
  # the previous marker. Callers must act on THIS RETURN VALUE. Anything that greps $target
  # instead reads the new content and concludes a durability it was never given.
  fsync_path "$dir" || return 1
  return 0
}

# PUBLISH A SYSTEMD DROP-IN DURABLY (o3d-2sm1.5, Codex r11 CRITICAL).
#
# The reboot fence had only the visible half. `cat > "$dropin"` + `chmod 644` +
# `daemon-reload` + `systemctl show -p DropInPaths` proves that systemd can read the drop-in
# NOW. It flushes nothing: not the file's data, not the rename that publishes it, and not the
# `<unit>.d` directory the drop-in usually had to be created in. Execution then goes straight
# on to stop the services and migrate, and NOTHING in between is a write barrier — so the
# claim that "the writeback window ends before anything is stopped" is not established by the
# ordering. A power cut after `schema_touched` is durable but before the drop-in reaches the
# medium reboots WITHOUT the AssertPathExists=! fence: the durable marker then names a
# condition no unit asserts on, and the old enabled service starts against a partially
# migrated schema. The marker protects nothing on its own; the drop-in is what makes systemd
# honour it, so the two must be equally durable.
#
# Three barriers, and the first is the one publish_durable_file() cannot give, because it
# assumes its directory already exists:
#
#   BARRIER 0  the NEW drop-in directory's own entry in /etc/systemd/system. A file flushed
#              into a directory whose name was never flushed is published into nothing.
#   BARRIER 1  the drop-in's data, before any name points at it.
#   BARRIER 2  the directory entry the rename created.
#
# The temporary carries the `.conf.XXXXXX` suffix, which systemd does not load — only `.conf`
# files in a `.d` directory are drop-ins — so a daemon-reload racing this publication reads
# either the previous drop-in or the complete new one, never a partial one.
publish_durable_dropin() {
  local target="$1" dir parent tmp created=false
  dir="$(dirname "$target")"
  parent="$(dirname "$dir")"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir" || return 1
    created=true
  fi
  # BARRIER 0, and only where a directory was actually created: fsyncing the parent of a
  # directory that already survived a boot proves nothing and costs a flush of /etc.
  if $created; then fsync_path "$parent" || return 1; fi
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # 0644 and not publish_durable_file()'s 0600: this is a systemd unit fragment, and every
  # other drop-in on the host is world-readable. The marker it points at is the secret-ish
  # one; the fence itself is meant to be legible to an operator reading `systemctl cat`.
  if ! chmod 644 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 1: the data, before the name exists. After this the rename can only publish
  # bytes that are already on the medium.
  if ! fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  # BARRIER 2: the directory entry the rename created. As in publish_durable_file(), a
  # failure HERE returns non-zero with the new drop-in ALREADY VISIBLE — daemon-reload will
  # load it and `systemctl show -p DropInPaths` will report it, and a power loss can still
  # restore the previous directory entry. So the caller must act on THIS RETURN VALUE;
  # verify_reboot_fence() asks systemd a different question and cannot answer this one.
  fsync_path "$dir" || return 1
  return 0
}

# THE SHARED NAMESPACE IS THE APPLICATION'S OWN DATA DIRECTORY, so this creates what is
# missing and changes the mode of nothing else. deploy.sh used to `chmod 700` its private
# state directory; doing that to ${CUTOVER_STATE_DIR} now would take /var/lib/one-two-inventory
# — uploads, backups, the Xero store — away from the service that owns it. The two files
# that need protecting carry their own 0600, and the connection-fence state lives in a 0700
# subdirectory owned by ${APP_USER}, which is the identity that writes it: the fence script
# runs as the app user, so a root-owned 0700 directory made that write impossible.
ensure_cutover_state_dirs() {
  mkdir -p "$CUTOVER_STATE_DIR" || return 1
  mkdir -p "$DB_FENCE_DIR" || return 1
  chown "${APP_USER}:${APP_USER}" "$DB_FENCE_DIR" 2>/dev/null || true
  chmod 700 "$DB_FENCE_DIR" 2>/dev/null || true
  return 0
}

# ONE LOCK FOR ALL THREE ENTRYPOINTS (o3d-2sm1.5, Codex r9 HIGH). deploy.sh held
# ${STATE_DIR}/deploy.lock and update.sh held ${DATA_DIR}/update.lock, so "refusing to run
# two cutovers at once" was true of two deploys and false of a deploy racing an update;
# install.sh took no lock at all. One path, taken by all three.
acquire_cutover_lock() {
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_STATE_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another cutover (deploy.sh, update.sh or install.sh) holds ${LOCK_FILE}. Refusing to run two cutovers at once."
  # AND the lock the previous version of deploy.sh took, so a cutover started from a checkout
  # that predates the shared namespace is still excluded. Only when that directory already
  # exists: creating it would be re-creating the namespace this round retired.
  if [[ -d "$LEGACY_CUTOVER_STATE_DIR" ]]; then
    exec 8>"${LEGACY_CUTOVER_STATE_DIR}/deploy.lock"
    flock -n 8 || die "A cutover from a checkout that predates the shared namespace holds ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock. Refusing to run two cutovers at once."
  fi
}

write_cutover_marker() {
  local reason="$1" status="${2:-0}"
  mkdir -p "${CUTOVER_STATE_DIR}"
  {
    echo "fenced_at=$(date -Iseconds)"
    echo "reason=${reason}"
    echo "failed_step=${CUTOVER_STEP}"
    echo "exit_status=${status}"
    echo "app_dir=${APP_DIR}"
    # THE DURABLE PHASE, RECORDED SEPARATELY FROM EVERY INTENT (o3d-2sm1.5, Codex r8 HIGH).
    #
    # This marker is written during ARMING, before the first stop, so its EXISTENCE proves
    # only that some run got as far as creating reversible cutover state. Adoption used to
    # read that existence as proof the existing installation had been stopped.
    echo "phase=$(if ${FENCE_ARMED}; then echo stopping; elif ${CUTOVER_ARMING}; then echo arming; else echo none; fi)"
    # THE INTENT to migrate, which for this script is unconditional: a marker is only ever
    # written from inside an upgrade cutover, and every upgrade cutover migrates. It used to
    # be written from FENCE_ARMED — the STOP flag — so it said `false` for the whole arming
    # phase and `true` afterwards, which is the phase under another name, and adoption here
    # never read it back. deploy.sh and update.sh DO read this line off a marker this script
    # may have written, and they must not be told a cutover had no intention of migrating.
    echo "migration_attempted=true"
    echo "schema_touched=${SCHEMA_TOUCHED}"
    # Whether a drop-in is ACTUALLY loaded, not whether one was intended (o3d-2sm1.5).
    echo "reboot_fence=$(${REBOOT_FENCE_INSTALLED} && echo installed || echo absent)"
    echo "cron_backup=${CRON_BACKUP}"
    echo "units=${APP_NAME}.service"
    echo "db_connect_fence_state=${DB_FENCE_STATE}"
    # What the operator reading this file is actually looking at. A SCHEMA_TOUCHED branch
    # printing "held" about a fence the start step had already released is how a fence that
    # does not exist gets read as one (Codex r3 HIGH).
    echo "db_connect_fence=$(${DB_FENCE_UP} && echo held || echo released)"
    echo "release_db_connect_fence=${DB_FENCE_RELEASE_CMD}"
    # THE LAST LINE, AND IT IS THE POINT OF IT (o3d-2sm1.5, Codex r9 HIGH). A marker that
    # does not end here was never published by publish_durable_file(), so every fact above
    # it is unproven — including `schema_touched=`, whose ABSENCE adoption used to read as
    # `false` and release the connection fence over a possibly half-migrated schema. See
    # marker_is_complete().
    echo "marker_complete=1"
  } | publish_durable_file "${FENCE_FILE}" || {
    # NOT fatal here: this is also called from the exit trap, where dying loses the status
    # and the banner. It IS fatal in mark_schema_touched() and persist_stop_requested() —
    # the two callers whose whole purpose is the durable record — and fatal on THIS RETURN
    # VALUE, never on a read-back of the file afterwards (o3d-2sm1.5, Codex r10 HIGH): the
    # rename lands before the last barrier, so the marker can be readable and undurable at
    # the same instant. What matters here is that the LAST DURABLE MARKER IS STILL THERE:
    # a failed publish changed nothing.
    warn "Could not publish ${FENCE_FILE} durably; the previous marker is unchanged."
    return 1
  }
  return 0
}

# THE SCHEMA IS ABOUT TO MOVE — SAY SO ON DISK BEFORE IT DOES (o3d-2sm1.4, Codex r3 CRITICAL).
#
# The flag used to be set in shell memory immediately before Prisma ran, with the durable
# marker written only by the exit trap. A kill -9, an OOM kill or a power cut during
# `prisma migrate deploy` never reaches that trap, so the marker still said
# `schema_touched=false` — and the next run's adoption, which reads that file and nothing
# else, RELEASED the connection fence and let the application back onto a half-migrated
# schema. Set the flag, write the marker, flush it, then invoke Prisma.
mark_schema_touched() {
  SCHEMA_TOUCHED=true
  # A FIRST install has no predecessor, no fence and no marker to adopt: nothing was
  # stopped, so there is nothing for a later run to recover. Only a cutover writes one.
  ${FENCE_ARMED} || return 0
  # THE PUBLISHER'S RESULT IS THE DURABILITY ANSWER, AND IT IS FATAL (o3d-2sm1.5, Codex r10
  # HIGH). This was `|| true`, with the grep below left to speak for it. It cannot speak for
  # it: publish_durable_file() RENAMES the new marker into place and only then flushes the
  # parent directory, so a failed BARRIER 2 leaves bytes that are perfectly VISIBLE and not
  # proven to be on the medium. The grep was satisfied, the migration went ahead, and a power
  # loss could restore the previous directory entry — the older complete marker, saying
  # `schema_touched=false` — over a half-migrated schema. A read-back answers "can this be
  # seen?"; it never answers "will this survive?", and it does not substitute for the
  # publisher's own result.
  write_cutover_marker "migration about to be invoked at $(date -Iseconds)" || die \
    "Could not publish ${FENCE_FILE} durably before migrating. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  # AND the content, which is a DIFFERENT question from durability: that what landed is the
  # marker this function exists to write. An additional gate, never a replacement for the
  # publisher's result above.
  grep -qE '^schema_touched=true$' "${FENCE_FILE}" || die \
    "Could not record schema_touched=true in ${FENCE_FILE}. Refusing to migrate: a migration whose interruption cannot be recorded would be adopted as one that never started."
  success "Recorded schema_touched=true in ${FENCE_FILE} (flushed) — an interrupted migration is now recoverable."
}

# THE STOP IS ABOUT TO BE ASKED FOR — SAY SO ON DISK BEFORE ASKING (o3d-2sm1.5, Codex r9
# MEDIUM).
#
# `FENCE_ARMED=true` was set in shell memory immediately before `systemctl stop`, and the
# durable marker went on saying `phase=arming` until some LATER write refreshed it — the
# exit trap, usually, which a SIGKILL, an OOM kill or a power cut never reaches. So a run
# interrupted across the stop left a marker describing a phase it was no longer in, and the
# next run's adoption fell through to the liveness heuristic, where ANY listener on the
# port — an operator's `next dev` in another worktree, a stray process, a sibling app —
# counts as "the predecessor is still serving" and the arming is UNWOUND: the crontab is
# restored, the reboot fence taken down and the connection fence released, over a service
# that had already been asked to stop.
#
# So the transition is persisted first, and conservatively: `stopping` means only "a stop
# has been REQUESTED", never "the stop succeeded". Recovery semantics, which are the ones
# already in place for this phase: marker_phase() returns `stopping`, adoption takes the
# ordinary branch, and that branch re-stops the units, re-installs and re-verifies the
# reboot fence, adopts the cron fence, and holds or releases the connection fence on
# `schema_touched`. Nothing in that path is harmed by a stop that had not actually landed —
# every step of it is idempotent — which is exactly why the conservative direction is the
# one to persist.
persist_stop_requested() {
  # THE PUBLISHER'S RESULT IS THE DURABILITY ANSWER, AND IT IS FATAL (o3d-2sm1.5, Codex r10
  # HIGH). This was `|| true`, with the grep below left to speak for it. The grep only proves
  # the bytes can be SEEN: publish_durable_file() renames before its last barrier, so a failed
  # parent-directory fsync publishes a marker the grep is happy with and the medium may not
  # keep. The reboot then finds the PREVIOUS directory entry — `phase=arming` — and adoption
  # falls through to the liveness heuristic and UNWINDS the fences over a service that had
  # already been asked to stop.
  write_cutover_marker "stop requested at $(date -Iseconds)" || die \
    "Could not publish ${FENCE_FILE} durably before stopping. Refusing to stop: a stop whose interruption cannot be recorded would be adopted as an arming that never stopped anything, and unwound over a service that had already been asked to stop."
  # AND the content, a DIFFERENT question from durability. An additional gate, never a
  # replacement for the publisher's result above.
  grep -qE '^phase=stopping$' "${FENCE_FILE}" || die \
    "Could not record phase=stopping in ${FENCE_FILE}. Refusing to stop: a stop whose interruption cannot be recorded would be adopted as an arming that never stopped anything, and unwound over a service that had already been asked to stop."
  info "Recorded phase=stopping in ${FENCE_FILE} (flushed) — an interruption across the stop is now recoverable."
}

verify_reboot_fence() {
  [[ -f "${FENCE_FILE}" ]] || { error "Reboot fence NOT verified: the marker ${FENCE_FILE} does not exist."; return 1; }
  local dropins
  dropins="$(systemctl show -p DropInPaths --value "${APP_NAME}.service" 2>/dev/null || true)"
  if [[ "${dropins}" == *"${FENCE_DROPIN_FILE}"* ]]; then
    success "Reboot fence verified: systemd reports ${FENCE_DROPIN_FILE} loaded for ${APP_NAME}.service."
    return 0
  fi
  if systemctl cat "${APP_NAME}.service" 2>/dev/null | grep -qF "${FENCE_DROPIN_FILE}"; then
    success "Reboot fence verified: ${FENCE_DROPIN_FILE} appears in 'systemctl cat ${APP_NAME}.service'."
    return 0
  fi
  error "Reboot fence NOT verified: systemd does not report ${FENCE_DROPIN_FILE} for ${APP_NAME}.service."
  return 1
}

# A FAILED INSTALL LEAVES NOTHING BEHIND (o3d-2sm1.5, Codex r4 CRITICAL).
#
# The marker went down first, then the drop-in, then the reload, then the verify — and any
# failure after that first line returned 1 into a `|| die` while FENCE_ARMED was still false.
# The trap therefore did nothing, neither the marker nor the drop-in was removed, and the
# operator read a clean abort: nothing changed. Nothing had, except an AssertPathExists=! on a
# marker that now existed — invisible until the next reboot, when the unit failed its
# assertion with nothing connecting that to an install that had "changed nothing".
#
# The rollback removes only what THIS call created: install_reboot_fence is also how an
# adopted fence is re-established and how the exit trap puts one back.
rollback_reboot_fence_install() {
  if ${FENCE_DROPIN_CREATED}; then
    rm -f "${FENCE_DROPIN_FILE}"
    rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
    command -v systemctl >/dev/null 2>&1 && { systemctl daemon-reload >/dev/null 2>&1 || true; }
    FENCE_DROPIN_CREATED=false
  fi
  # The marker is the condition, so removing it is what actually lifts the fence: it goes
  # only if this call created it AND nothing is relying on it.
  if ! ${FENCE_MARKER_PREEXISTED} && ! ${FENCE_ARMED}; then
    rm -f "${FENCE_FILE}"
  fi
  return 0
}

install_reboot_fence() {
  local reason="$1"
  FENCE_MARKER_PREEXISTED=false
  [[ -f "${FENCE_FILE}" ]] && FENCE_MARKER_PREEXISTED=true
  FENCE_DROPIN_CREATED=false
  REBOOT_FENCE_INSTALLED=false

  if ! command -v systemctl >/dev/null 2>&1; then
    error "systemctl is not available: there is NO reboot fence."
    rollback_reboot_fence_install
    return 1
  fi

  # A FENCE WHOSE MARKER IS NOT DURABLE IS NOT A FENCE. The marker is the condition the
  # drop-in asserts on, so a publish that could not be flushed must fail the install rather
  # than install a drop-in pointing at a file a power cut can lose.
  write_cutover_marker "${reason}" || {
    error "${FENCE_FILE} could not be published durably, so there is NO reboot fence."
    rollback_reboot_fence_install
    return 1
  }
  # A DROP-IN SYSTEMD CAN READ IS NOT A DROP-IN THE MEDIUM WILL KEEP (o3d-2sm1.5, Codex r11
  # CRITICAL). Published through the same discipline as the marker it asserts on — file
  # fsync, rename, directory fsync, and the drop-in directory's own entry where this call
  # created it — and a failure is FATAL HERE, which is before CUTOVER_ARMING becomes
  # `stopping` and before the first `systemctl stop`. Everything undone by
  # rollback_reboot_fence_install() and by the pre-stop branch of the exit trap.
  [[ -f "${FENCE_DROPIN_FILE}" ]] || FENCE_DROPIN_CREATED=true
  if ! publish_durable_dropin "${FENCE_DROPIN_FILE}" <<FENCEEOF
[Unit]
# Installed by scripts/install.sh for the length of an upgrade cutover.
# While the marker below exists this unit must not start — not by hand, and not on
# boot. install.sh removes both once the migration has been verified.
AssertPathExists=!${FENCE_FILE}
FENCEEOF
  then
    error "${FENCE_DROPIN_FILE} could not be published durably, so there is NO reboot fence:"
    error "a reboot before it reached the medium would start ${APP_NAME}.service against a migrated schema."
    rollback_reboot_fence_install
    return 1
  fi
  if ! systemctl daemon-reload; then
    error "systemctl daemon-reload failed; the reboot fence is NOT active."
    rollback_reboot_fence_install
    return 1
  fi
  if ! verify_reboot_fence; then
    rollback_reboot_fence_install
    return 1
  fi
  REBOOT_FENCE_INSTALLED=true
  # Re-written now that the answer is known. The marker is the file the NEXT run (and the
  # operator after a hard kill) reads, and it was written before the drop-in was verified —
  # so it said `reboot_fence=absent` about a fence that had just been installed.
  write_cutover_marker "${reason}" \
    || warn "The fence is installed and verified, but ${FENCE_FILE} could not be refreshed; it still reads reboot_fence=absent."
  return 0
}

remove_reboot_fence() {
  rm -f "${FENCE_DROPIN_FILE}"
  rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while lifting the reboot fence."
  fi
  # The marker is the condition, so deleting it is what lifts the fence.
  rm -f "${FENCE_FILE}"
  return 0
}

# The forgettable writers: nothing runs between ticks, so the box looks quiet right up
# until a sweeper wakes up mid-migration. The backup is verbatim and taken once.
# PUBLISH THE CRONTAB BACKUP ATOMICALLY, OR NOT AT ALL (o3d-2sm1.5, Codex r8 HIGH).
#
# It used to be `printf > "${CRON_BACKUP}"` followed by `chmod`, and only then the flag
# saying THIS run had created it. A full disk, a short write or a failing chmod therefore
# left a truncated — or wrongly permissioned — file at the authoritative path with
# CRON_BACKUP_CREATED still false, so the arming unwind regarded it as somebody else's and
# left it behind. The next run found a backup at the expected path, adopted it as the
# previous run's verbatim original, and a successful unfence REPLACED the real crontab with
# those truncated contents — or with contents predating whatever the operator edited after
# the failed attempt.
#
# So: a temporary file in the SAME directory (same filesystem, so the rename is atomic), the
# complete content and the mode both verified, an atomic rename, and the created-flag raised
# immediately. Every failure path removes the temporary file, or the file it had just
# published, and returns non-zero: a failed publish leaves nothing at ${CRON_BACKUP}.
publish_cron_backup() {
  local content="$1" tmp
  mkdir -p "$(dirname "${CRON_BACKUP}")" || return 1
  tmp="$(mktemp "${CRON_BACKUP}.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "${content}" > "${tmp}" 2>/dev/null; then rm -f "${tmp}"; return 1; fi
  if ! chmod 600 "${tmp}" 2>/dev/null; then rm -f "${tmp}"; return 1; fi
  # The whole content, read back off the filesystem. `$(cat ...)` and the value written both
  # lose their trailing newlines, so this compares every byte that matters.
  if [[ "$(cat "${tmp}" 2>/dev/null)" != "${content}" ]]; then rm -f "${tmp}"; return 1; fi
  if [[ "$(stat -c '%a' "${tmp}" 2>/dev/null)" != "600" ]]; then rm -f "${tmp}"; return 1; fi
  # DURABLE, NOT MERELY VISIBLE (o3d-2sm1.5, Codex r9 HIGH). The read-back above proves the
  # bytes can be SEEN, and the page cache will happily satisfy it from memory. A power loss
  # after the crontab has been fenced would then reboot with this backup missing or
  # zero-length while publication had returned success — and the resume either restores an
  # empty crontab or leaves cron commented out for ever. Both barriers land BEFORE the
  # crontab is touched, because the caller invokes `crontab` only once this returns 0.
  if ! fsync_path "${tmp}"; then rm -f "${tmp}"; return 1; fi
  if ! mv -f "${tmp}" "${CRON_BACKUP}" 2>/dev/null; then rm -f "${tmp}"; return 1; fi
  # BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  # temporary name, or no name at all, however well the data was flushed.
  if ! fsync_path "$(dirname "${CRON_BACKUP}")"; then rm -f "${CRON_BACKUP}"; return 1; fi
  # IMMEDIATELY: from here the file is authoritative and must be owned by this run in the
  # same breath, or the unwind disowns a backup it is the only one able to restore.
  CRON_BACKUP_CREATED=true
  if [[ "$(cat "${CRON_BACKUP}" 2>/dev/null)" != "${content}" ]]; then
    rm -f "${CRON_BACKUP}"
    CRON_BACKUP_CREATED=false
    return 1
  fi
  return 0
}

fence_cron() {
  command -v crontab >/dev/null 2>&1 || return 0
  local current active
  current="$(crontab -u "${APP_USER}" -l 2>/dev/null || true)"
  [[ -n "${current}" ]] || { info "No crontab for ${APP_USER}; nothing to fence."; return 0; }
  active="$(printf '%s\n' "${current}" | grep -cE '^[[:space:]]*[^#[:space:]]' || true)"
  if [[ "${active}" -eq 0 ]]; then
    CRON_FENCED=true
    return 0
  fi
  info "Fencing ${active} active line(s) in the ${APP_USER} crontab."
  mkdir -p "${DATA_DIR}"
  if [[ ! -f "${CRON_BACKUP}" ]]; then
    # THIS run's backup, so the arming unwind may restore from it and delete it — and it is
    # only ever at that path once it is complete, verified and owned.
    publish_cron_backup "${current}" || die \
      "The ${APP_USER} crontab could not be backed up to ${CRON_BACKUP}, so this run will not fence the cron writers: a fence whose backup cannot be verified is a crontab nobody can put back. Nothing was left behind at ${CRON_BACKUP}. Nothing has been stopped and nothing has been migrated."
  fi
  printf '%s\n' "${current}" \
    | awk '{ if ($0 ~ /^[[:space:]]*[^#[:space:]]/) print "#DEPLOY-FENCE# " $0; else print $0 }' \
    | crontab -u "${APP_USER}" -
  CRON_FENCED=true
  success "Cron writers fenced."
}

unfence_cron() {
  ${CRON_FENCED} || return 0
  [[ -f "${CRON_BACKUP}" ]] || return 0
  crontab -u "${APP_USER}" "${CRON_BACKUP}"
  rm -f "${CRON_BACKUP}"
  CRON_FENCED=false
  success "Cron writers restored verbatim."
}

# --- adopting somebody else's marker ---------------------------------------
# What phase the run that wrote this marker had actually reached. A marker with no `phase=`
# line was written by an older version of one of these three scripts, all of which only ever
# left one behind after a stop; anything unrecognised therefore reads as `stopping`, which is
# the direction that stops a service rather than leaving one running over a schema that may
# have moved.
# WAS THIS MARKER PUBLISHED IN ONE PIECE? (o3d-2sm1.5, Codex r9 HIGH)
#
# publish_durable_file() writes `marker_complete=1` last, so its presence is proof that
# every line above it reached the medium together. Its ABSENCE means one of two things and
# both are read the same way: a marker truncated by the pre-r9 in-place writer, or one
# written by a version of this script older than the sentinel. Either way the facts in it
# are unproven, and the only safe reading of an unproven `schema_touched` is "it may have
# been touched" — the opposite of the `false` that adoption used to default to before it
# released the connection fence.
marker_is_complete() {
  grep -qE '^marker_complete=1$' "$FENCE_FILE" 2>/dev/null
}

marker_phase() {
  local phase
  phase="$(sed -n 's/^phase=//p' "${FENCE_FILE}" 2>/dev/null | tail -1)"
  case "${phase}" in
    arming) printf 'arming' ;;
    *) printf 'stopping' ;;
  esac
}

RESUME_EVIDENCE=""
# IS THE EXISTING INSTALLATION STILL UP? Asked only to decide whether an interrupted ARMING
# can be resumed, and answered conservatively: a unit systemd reports active, or anything
# listening on the app's port, counts as "still serving". A `false` sends the run down the
# ordinary adoption path, which stops and re-fences — the pre-existing behaviour.
predecessor_is_active() {
  if command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active --quiet "${APP_NAME}.service" 2>/dev/null; then
    RESUME_EVIDENCE="systemd reports ${APP_NAME}.service active"
    return 0
  fi
  if [[ -n "${APP_PORT:-}" ]] && command -v ss >/dev/null 2>&1 \
    && ss -ltn 2>/dev/null | awk -v p=":${APP_PORT}\$" '$4 ~ p {found=1} END{exit !found}'; then
    RESUME_EVIDENCE="something is still listening on :${APP_PORT}"
    return 0
  fi
  return 1
}

# RESUME AN INTERRUPTED ARMING WITHOUT STOPPING ANYTHING (o3d-2sm1.5, Codex r8 HIGH).
#
# The existing installation is up, the schema is untouched and every piece of state on this
# box is one the arming phase created and the arming phase can remove. So do what
# unwind_arming would have done had the previous run reached its own trap — crontab back,
# reversible reboot fence down, any connection fence released — and carry on from here,
# before the build, with nothing stopped.
#
# Order matters: the crontab is restored FIRST and a failure there is fatal BEFORE the fence
# comes down, so a run that cannot finish the unwind leaves the marker exactly as it found it
# and the next run adopts the same phase again.
resume_from_interrupted_arming() {
  if command -v crontab >/dev/null 2>&1 && [[ -f "${CRON_BACKUP}" ]]; then
    crontab -u "${APP_USER}" "${CRON_BACKUP}" || die \
      "The interrupted run had fenced the ${APP_USER} crontab and its backup at ${CRON_BACKUP} could not be restored. Refusing to continue with the cron writers commented out: restore it by hand (crontab -u ${APP_USER} ${CRON_BACKUP}) and re-run. Nothing has been stopped."
    rm -f "${CRON_BACKUP}"
    CRON_FENCED=false
    success "The ${APP_USER} crontab is back exactly as the interrupted run found it."
  fi
  release_db_connections || die \
    "A connection fence was standing over an UNTOUCHED schema and could not be released. Fix that before re-running; nothing has been stopped."
  remove_reboot_fence
  if [[ -f "${FENCE_FILE}" ]]; then
    die "${FENCE_FILE} could not be removed, so this host would still refuse to start ${APP_NAME}.service on its next boot. Remove it by hand (rm -f ${FENCE_FILE}) and re-run. Nothing has been stopped."
  fi
  REBOOT_FENCE_INSTALLED=false
  success "The interrupted arming has been undone. The existing installation was never stopped and is still serving."
}

# The continuous half of the drain. check-db-writers.mjs snapshots pg_stat_activity and
# closes; the migration opens its own connection afterwards with nothing holding the gap.
fence_db_connections() {
  [[ -f "${DB_FENCE_SCRIPT}" ]] || die \
    "${DB_FENCE_SCRIPT} is not in this checkout, so this run cannot hold the database closed for the migration window. A snapshot probe is not a fence. Restore the script (it ships with the app) and re-run; nothing has been migrated."
  mkdir -p "${DB_FENCE_DIR}"
  chown "${APP_USER}:${APP_USER}" "${DB_FENCE_DIR}"
  chmod 700 "${DB_FENCE_DIR}"

  local rc=0
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" ) || rc=$?

  case "${rc}" in
    0)
      # THE MIGRATION CONNECTS AS THE ADMIN AND RUNS AS THE APPLICATION ROLE (o3d-2sm1.5,
      # Codex r4 CRITICAL). This installer makes the APPLICATION role the database owner, and
      # the fence refuses when admin == app — so the only fenceable configuration here is a
      # separate SUPERUSER admin, and with the bare admin URL every table, index and sequence
      # a migration created was owned by that superuser with no grant to the application at
      # all. Invisible to the whole pipeline: prisma, the drift check and the verification
      # hook share this same admin connection and read everything perfectly.
      MIGRATION_DATABASE_URL="$( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
        DATABASE_URL="${DATABASE_URL}" \
        DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
        node "${DB_FENCE_SCRIPT}" --print-migration-url )" || die \
        "The connection fence is up but the migration URL could not be composed, so the migration would run as the deploy admin and create objects the application cannot use. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      [[ -n "${MIGRATION_DATABASE_URL}" ]] || die \
        "The connection fence is up but --print-migration-url produced nothing. Nothing has been migrated; release the fence with: ${DB_FENCE_RELEASE_CMD}"
      DB_FENCE_UP=true
      DB_FENCE_RAISED=true
      success "Connection fence up: new application connections are refused for the window."
      success "The migration will connect as the deploy admin and RUN AS the application role, so what it creates is owned by the application."
      ;;
    3)
      # EXIT 3 IS "CONNECT WAS NOT REVOKED", AND IT ABORTS (o3d-2sm1.4, Codex r3 HIGH).
      # Warning and falling back to the probe repeats the mistake the probe itself was:
      # anything may attach after the snapshot and write across the migration. A fence we
      # know is absent is not a degraded fence, it is no fence.
      die "THE DATABASE COULD NOT BE FENCED (exit 3): CONNECT was NOT revoked, so nothing stops a client attaching between now and the end of the migration. Refusing to migrate an EXISTING installation — the reason is printed above. Fix it (usually: set DEPLOY_ADMIN_DATABASE_URL to a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL, see docs/installation.md) and re-run. Nothing has been migrated."
      ;;
    *)
      die "The connection fence failed (exit ${rc}). Nothing has been migrated."
      ;;
  esac
}

# Asked BEFORE the stop, while the existing installation is still serving and a refusal
# costs nothing. The database can only answer some of the reasons a fence is impossible (a
# superuser application role, a CONNECT arriving through role membership) and the drain step
# asks it those; the commonest reason of all — no privileged connection at all — is knowable
# from here, and paying an outage to discover an unset variable is not a trade. A FIRST
# install never reaches this: there is no existing database to hold closed.
require_fenceable_database() {
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || die \
    "An existing installation was detected, so its database must be held closed while the schema moves — but DEPLOY_ADMIN_DATABASE_URL is not set, so this run has no privileged connection that would survive revoking CONNECT from the application role. Set it (a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL; docs/installation.md) and re-run. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_FENCE_SCRIPT}" ]] || die \
    "${DB_FENCE_SCRIPT} is missing from this checkout, so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_OBJECT_ACCESS_SCRIPT}" ]] || die \
    "${DB_OBJECT_ACCESS_SCRIPT} is missing from this checkout, so nothing would check that the application role can use what the migration creates. Nothing has been stopped and nothing has been migrated."

  # AND IT IS RUN, NOT LOOKED AT (o3d-2sm1.5, Codex r4 HIGH). This used to be `[[ -f ... ]]`,
  # which proves a file exists and nothing about whether it works — and its own dependency was
  # a devDependency while the documented manual upgrade runs `npm ci --omit=dev`, so the fence
  # died with a missing module at drain-verify, AFTER the stop. --preflight runs the same
  # imports, opens the same admin connection and asks the same questions as --fence, and
  # revokes, terminates and writes nothing.
  local rc=0
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --preflight ) || rc=$?
  [[ "${rc}" -eq 0 ]] || die \
    "The migration window could NOT be fenced (fence preflight exit ${rc}); the reason is printed above. Refusing to migrate an EXISTING installation. Nothing has been stopped and nothing has been migrated."

  success "A connection fence is possible, and fence-db-connections.mjs proved it by asking the database."
}

release_db_connections() {
  # THE STATE FILE IS NOT ASKED WHETHER A FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
  # This used to begin `[[ -f "${DB_FENCE_STATE}" ]] || return 0`, which is the same defect the
  # database-backed release was added to fix, one layer up: an ABSENCE treated as an ANSWER. A
  # durable revoke outlives a lost record, so on the exact failure the record-loss work exists
  # for, this reported success without asking anything, and the start step took that for a
  # released fence, removed the reboot fence and started an application with no CONNECT on its
  # own database. So the script is ALWAYS run, and the DATABASE says what is standing. Its exit
  # codes: 0 released from a record and verified; 4 no record, and the application role's own
  # CONNECT is all that could be proven; anything else, a refusal.
  [[ -f "${DB_FENCE_SCRIPT}" ]] || { error "Cannot release the connection fence: ${DB_FENCE_SCRIPT} is missing, so nothing here can ask the database whether one is standing."; return 1; }
  local rc=0
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --release --state-file="${DB_FENCE_STATE}" ) || rc=$?

  if [[ "${rc}" -eq 0 ]]; then
    MIGRATION_DATABASE_URL="${DATABASE_URL}"
    DB_FENCE_UP=false
    success "Connection fence released."
    return 0
  fi

  if [[ "${rc}" -eq 4 ]]; then
    # EXIT 4: there is no record, and the database says the application role holds CONNECT.
    # That is the ONE thing it proves. The same fence revokes CONNECT from PUBLIC, monitoring,
    # backup, BI and any second application, and the application can be back inside through
    # PUBLIC or role membership while all of those are still shut out — the shape --fence
    # itself leaves standing when it rejects an ineffective fence. So it is never "released".
    DB_FENCE_UP=false
    if ${DB_FENCE_RAISED:-false}; then
      error "A CONNECTION FENCE WAS RAISED BY THIS RUN AND ITS RECORD IS GONE (exit 4)."
      error "${DB_FENCE_STATE} no longer holds a usable record, so nothing can restore the grants"
      error "this run revoked. The application role can connect; PUBLIC and every other grantee"
      error "the fence took CONNECT from may still be locked out, with no record of who they were."
      error "Audit the ACL by hand before this database is treated as open:"
      error "  SELECT datacl FROM pg_database WHERE datname = current_database();"
      return 1
    fi
    MIGRATION_DATABASE_URL="${DATABASE_URL}"
    warn "NO CONNECTION-FENCE RECORD, AND NO PROOF THAT NO FENCE IS STANDING (exit 4)."
    warn "The database says the application role can connect, and that is all it says. A fence"
    warn "revokes CONNECT from every grantee that held it — PUBLIC, monitoring, backup, BI — and"
    warn "the application can hold CONNECT through PUBLIC or role membership while those stay"
    warn "revoked. This run raised no fence of its own, so it continues; if this box has ever had"
    warn "an install or upgrade interrupted, audit the ACL before trusting it:"
    warn "  SELECT datacl FROM pg_database WHERE datname = current_database();"
    return 0
  fi

  error "THE CONNECTION FENCE COULD NOT BE RELEASED (exit ${rc}). The application role still has"
  error "no CONNECT on this database and cannot start until this is undone:"
  error "  ${DB_FENCE_RELEASE_CMD}"
  error "or, by hand as a superuser, the GRANT statements recorded in ${DB_FENCE_STATE}."
  return 1
}

# RE-ESTABLISH A FENCE THE START STEP ALREADY RELEASED (o3d-2sm1.4, Codex r3 HIGH). The
# fences come down before `systemctl enable --now`, because the new build cannot serve a
# database it may not connect to; a failure there arrives at the trap with SCHEMA_TOUCHED
# still true and the fence already DOWN, and announcing a HELD fence then tells the operator
# about something that does not exist. Deliberately NOT fence_db_connections: that one dies,
# and dying inside an exit trap loses the status and the banner.
refence_db_connections() {
  ${DB_FENCE_UP} && return 0
  [[ -f "${DB_FENCE_SCRIPT}" ]] || return 1
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || return 1
  local rc=0
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${DB_FENCE_SCRIPT}" --fence --state-file="${DB_FENCE_STATE}" ) || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  DB_FENCE_UP=true
  DB_FENCE_RAISED=true
  # DO NOT SUBSTITUTE THE ADMIN URL WHEN THE COMPOSER REFUSES (o3d-2sm1.5, r6).
  # `--print-migration-url` throws precisely so that a migration can never run AS THE ADMIN
  # while the log announces the application role; catching that throw and assigning
  # DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit. Fail loudly and
  # leave it empty instead: the fence is up, and nothing this trap does next needs the URL.
  local url_rc=0
  MIGRATION_DATABASE_URL="$( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
    DATABASE_URL="${DATABASE_URL}" \
    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
    node "${DB_FENCE_SCRIPT}" --print-migration-url )" || url_rc=$?
  if [[ "${url_rc}" -ne 0 || -z "${MIGRATION_DATABASE_URL}" ]]; then
    MIGRATION_DATABASE_URL=""
    warn "--print-migration-url refused to compose a migration URL (exit ${url_rc}); NOT falling back to DEPLOY_ADMIN_DATABASE_URL. The fence is up."
  fi
  return 0
}

# A previous cutover — this installer's, deploy.sh's or update.sh's — that failed after
# the stop leaves the marker behind, and it is the reason this unit refuses to start.
# Adopt it BEFORE anything else in the window: re-stop, re-establish and verify the
# reboot fence, confirm cron, and adopt or release the connection fence by the same rule
# the trap uses. And refuse to go on if it says a migration was attempted and this run
# would not re-run one — there is no such mode here, so this is an assertion, not a flag.
# ---------------------------------------------------------------------------
# IMPORTING THE LEGACY NAMESPACE (o3d-2sm1.5, Codex r9 HIGH).
#
# Before this round deploy.sh kept its cutover state under /var/lib/ims-deploy while
# install.sh and update.sh kept theirs under the application data directory. A host part-way
# through a cutover started by the OLD deploy.sh therefore has a standing fence at paths the
# shared namespace does not name — and a run that simply ignored them would take a fresh
# crontab backup over an already-fenced crontab, rewrite the shared drop-in and leave the
# previous marker orphaned. Exactly the failure the shared namespace exists to end.
#
# So each legacy artefact is MOVED into the canonical namespace before anything is adopted
# and long before any unit or crontab is touched, and it is moved durably: the content is
# republished through publish_durable_file(), so a crash mid-import leaves either the legacy
# copy or a complete canonical one.
#
# It never GUESSES. Both namespaces holding the same artefact means two runs were
# interrupted, and choosing between them would silently discard a crontab backup or a set of
# recorded grants nothing else can reconstruct.
import_legacy_file() {
  local legacy="$1" canonical="$2" what="$3" owner="${4:-}"
  [[ -e "$legacy" ]] || return 1
  if [[ -e "$canonical" ]]; then
    die "Two cutover namespaces both hold a ${what}: ${legacy} (the namespace deploy.sh used before o3d-2sm1.5) and ${canonical} (the shared one). Refusing to guess which fence is standing. Nothing has been stopped: read both, keep the one that describes the interrupted run, delete the other, and re-run."
  fi
  publish_durable_file "$canonical" < "$legacy" || die \
    "The ${what} at ${legacy} could not be published durably at ${canonical}, so this run cannot adopt the fence a previous run left standing. Nothing has been stopped and nothing has been migrated."
  [[ -z "$owner" ]] || chown "${owner}:${owner}" "$canonical" 2>/dev/null || true
  rm -f "$legacy"
  warn "Imported the ${what} into the shared cutover namespace: ${legacy} -> ${canonical}"
  return 0
}

import_legacy_cutover_state() {
  [[ "$LEGACY_CUTOVER_STATE_DIR" != "$CUTOVER_STATE_DIR" ]] || return 0
  [[ -d "$LEGACY_CUTOVER_STATE_DIR" ]] || return 0
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_STATE_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  local imported=false
  # The connection-fence state goes back to ${APP_USER}: the fence script runs as the app
  # user, and a root-owned copy is one it cannot release.
  if import_legacy_file "$LEGACY_DB_FENCE_STATE" "$DB_FENCE_STATE" "connection-fence state" "$APP_USER"; then imported=true; fi
  if import_legacy_file "$LEGACY_CRON_BACKUP" "$CRON_BACKUP" "crontab backup"; then imported=true; fi
  # LAST, because the marker is what adoption keys on: until it is at the canonical path
  # nothing adopts anything, so a crash part-way through this import leaves a run that finds
  # no marker and stops nothing.
  if import_legacy_file "$LEGACY_FENCE_FILE" "$FENCE_FILE" "cutover marker"; then imported=true; fi
  if $imported; then
    warn "The state above was left by a checkout that predates the shared cutover namespace."
    warn "It is adopted below exactly as if this run had written it."
  fi
  rmdir "$LEGACY_CUTOVER_STATE_DIR" 2>/dev/null || true
  return 0
}

adopt_existing_fence() {
  [[ -f "${FENCE_FILE}" ]] || return 0

  # WHAT PHASE DID THE RUN THAT LEFT THIS ACTUALLY REACH? (o3d-2sm1.5, Codex r8 HIGH)
  #
  # Adoption used to take the marker's mere EXISTENCE as proof that the existing installation
  # had been stopped: it raised FENCE_ARMED and immediately stopped the unit. But the marker
  # is written during ARMING, before the first stop — so a SIGKILL, an OOM kill or a power cut
  # between install_reboot_fence() and that stop left a healthy installation running against
  # an untouched schema, and THIS run then stopped it, for the whole length of a build, to
  # recover from a failure that had cost nothing.
  #
  # Three things must hold before that is treated as a resumable arming, and all three are
  # cheap: the marker says the phase was `arming`, it says the schema was never touched, and
  # the installation is still active right now. Any of them false and the run falls through
  # to the ordinary adoption below, which stops and re-fences exactly as before.
  local adopted_phase=stopping adopted_schema_touched=false
  adopted_phase="$(marker_phase)"
  if grep -qE '^schema_touched=true$' "${FENCE_FILE}" 2>/dev/null; then
    adopted_schema_touched=true
  fi
  # AN INCOMPLETE MARKER IS NOT A MARKER SAYING `false` (o3d-2sm1.5, Codex r9 HIGH).
  #
  # An unrecognised `phase=` was already read conservatively as `stopping`, but the schema
  # flag was read INDEPENDENTLY and defaulted to `false` when the line was missing — so a
  # marker truncated by the old in-place writer was adopted as "stopped, migrated nothing",
  # and the connection fence was RELEASED over a schema that may be half applied. Missing is
  # not false. It is unknown, and unknown is read the expensive way.
  if ! marker_is_complete; then
    warn "${FENCE_FILE} does not end with marker_complete=1, so it was never published in one"
    warn "piece: it is truncated, or was written by a version of this script older than the"
    warn "sentinel. Reading it the SAFE way — the schema may have moved. This run re-migrates,"
    warn "re-checks drift and re-verifies before anything gets CONNECT back."
    adopted_schema_touched=true
  fi
  if [[ "${adopted_phase}" == "arming" ]] && ! ${adopted_schema_touched} && predecessor_is_active; then
    warn "Adopting an INTERRUPTED ARMING — a previous run was killed before it stopped anything:"
    sed 's/^/         /' "${FENCE_FILE}"
    warn "The marker says phase=arming and schema_touched=false, and ${RESUME_EVIDENCE}."
    warn "Nothing was stopped, so nothing is recovered by stopping it now. This run undoes the"
    warn "reversible state that run had created and RESUMES from here, before the build, with"
    warn "the existing installation still serving the schema it was built against."
    resume_from_interrupted_arming
    return 0
  fi

  warn "Adopting an existing cutover fence — a previous run stopped here:"
  sed 's/^/         /' "${FENCE_FILE}"
  FENCE_ARMED=true
  # Read ONCE, above, and read conservatively there: a second independent grep is how the
  # missing-line-means-false defect got in. (`if`, not `&&`: under errexit a bare
  # `$flag && VAR=true` exits the script the moment the flag is false.)
  if ${adopted_schema_touched}; then
    SCHEMA_TOUCHED=true
  fi
  systemctl stop "${APP_NAME}.service" >/dev/null 2>&1 || true
  install_reboot_fence "adopted by install.sh at $(date -Iseconds)" \
    || die "Could not re-establish the reboot fence. Refusing to continue: a reboot could start the old version against a migrated schema."
  if [[ -f "${CRON_BACKUP}" ]]; then
    CRON_FENCED=true
    fence_cron
  fi
  if ${SCHEMA_TOUCHED}; then
    # HELD, not released: the previous run had started migrating, so the schema is in an
    # unknown state and the application must not reach it. This run re-migrates,
    # re-checks drift and re-verifies before anything gets CONNECT back.
    if [[ -f "${DB_FENCE_STATE}" ]]; then
      [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || die \
        "A connection fence is standing (${DB_FENCE_STATE}) but DEPLOY_ADMIN_DATABASE_URL is not set, so this run has no connection that survives it. Set it, or release the fence by hand: ${DB_FENCE_RELEASE_CMD}"
      warn "The previous run had already started migrating: HOLDING the connection fence."
      fence_db_connections
      # Non-empty, not "equal to the admin URL": the migration URL is the admin URL with
      # `options=-c role=<app role>` merged in, so an equality test would fail on every
      # successful re-fence (o3d-2sm1.5).
      { ${DB_FENCE_UP} && [[ -n "${MIGRATION_DATABASE_URL}" ]]; } || die \
        "The standing connection fence could not be re-established, so this run has no privileged connection to recover through."
    else
      # AN ABSENT FILE IS NOT PROOF THAT NO PREVIOUS FENCE STANDS (o3d-2sm1.5, Codex r12 HIGH).
      # This branch did not exist: a missing record meant the adoption silently assumed there
      # had never been a fence. A durable revoke outlives its record, and we only reach here
      # because the marker says the previous run HAD REACHED THE MIGRATION — so a fence
      # certainly existed. Ask the database: with no record --release grants nothing and
      # restores nothing, it only reads, and it refuses when the application role is locked out.
      local absent_rc=0
      release_db_connections || absent_rc=$?
      [[ "${absent_rc}" -eq 0 ]] || die \
        "The previous run had already started migrating, so it had fenced the database — and the record of that fence at ${DB_FENCE_STATE} is gone while the database says the fence has NOT been undone: the application role has no CONNECT. Nothing here can reconstruct which grantees it revoked. Restore CONNECT by hand as a superuser, check pg_database.datacl for every other grantee that lost it, and re-run. Nothing has been migrated by this run."
      warn "The previous run had reached the migration, so it had raised a connection fence — and"
      warn "no record of it survives at ${DB_FENCE_STATE}. The database confirms only that the"
      warn "application role can connect, so this recovery goes on through the application role."
      warn "Audit pg_database.datacl for any OTHER grantee that fence may still be holding out."
    fi
  else
    release_db_connections \
      || die "A connection fence from the previous run could not be released; fix that before re-running."
  fi
  warn "Fence adopted. Continuing: every step below is idempotent."
}

# Put the crontab back from the backup THIS run took, whatever fence_cron managed to do with
# it. The authority is the backup file rather than CRON_FENCED: that flag is raised only once
# `crontab` has returned 0, so a run that rewrote the crontab and then failed — or failed
# halfway through rewriting it — would otherwise restore nothing. An ADOPTED backup is left
# alone: it belongs to a previous run's fence, which is still standing.
restore_cron_from_backup() {
  command -v crontab >/dev/null 2>&1 || return 0
  ${CRON_BACKUP_CREATED} || return 0
  [[ -f "${CRON_BACKUP}" ]] || return 1
  crontab -u "${APP_USER}" "${CRON_BACKUP}" || return 1
  rm -f "${CRON_BACKUP}"
  CRON_FENCED=false
  CRON_BACKUP_CREATED=false
  success "The ${APP_USER} crontab is back exactly as it was."
  return 0
}

# UNDO THE ARMING PHASE. Called only from the pre-stop branch of the exit trap, where the
# existing installation is still up and the schema has not moved: the correct outcome is that
# the box looks exactly as it did before this run started. It stops nothing and touches only
# state THIS run created — rollback_reboot_fence_install() removes the drop-in this process
# wrote and, because FENCE_ARMED is false here, the marker too, unless it was already there.
unwind_arming() {
  local unwound=true
  if ! restore_cron_from_backup; then
    unwound=false
    error "The ${APP_USER} crontab could NOT be restored from ${CRON_BACKUP}."
    error "Put it back by hand:  crontab -u ${APP_USER} ${CRON_BACKUP}"
  fi
  rollback_reboot_fence_install
  if [[ -f "${FENCE_FILE}" ]] && ! ${FENCE_MARKER_PREEXISTED}; then
    unwound=false
    error "${FENCE_FILE} is still there and would refuse the next boot. Remove it: rm -f ${FENCE_FILE}"
  fi
  if ${unwound}; then
    success "Every change this run had made has been undone; nothing was stopped."
  fi
}

# The failure path, and it NEVER restarts what it stopped. A "rollback" that brings the
# old version back up against a migrated schema is the window this order exists to close,
# so the correct state after a post-stop failure is DOWN — and fenced against a reboot.
on_cutover_exit() {
  local status=$?

  # THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). Past the health check the new build is
  # serving and every gate has passed; the rest of this installer is nginx, hardening, log
  # rotation and cron. A failure there must not stop the service, re-fence it and re-revoke
  # CONNECT — that turns a cleanup fault into an outage plus a database lockout on an install
  # that had already succeeded.
  if ${PAST_POINT_OF_NO_RETURN}; then
    echo ""
    warn "=========================================================================="
    warn " THE APPLICATION IS UP — a step AFTER the health check failed"
    warn "=========================================================================="
    warn "  failed step : ${CUTOVER_STEP}"
    warn "  exit status : ${status}"
    warn "  service     : RUNNING and answering its health check. It is NOT being stopped."
    if ${CRON_FENCED}; then
      warn "  cron        : may still be FENCED. Restore it by hand:"
      warn "                  crontab -u ${APP_USER} ${CRON_BACKUP}"
    fi
    if [[ -f "${FENCE_FILE}" ]]; then
      warn "  marker      : ${FENCE_FILE} still exists and would refuse the next boot."
      warn "                Remove it once you are happy: rm -f ${FENCE_FILE}"
    fi
    exit "${status}"
  fi

  # A FAILURE BEFORE THE STOP IS NOT AN OUTAGE, AND MUST NOT BE TURNED INTO ONE
  # (o3d-2sm1.5, Codex r7 HIGH). FENCE_ARMED used to be raised before `fence_cron`, so every
  # way cron management can fail reached the banner below — which leaves the service stopped,
  # keeps the reboot fence and demands a recovery, on a host whose schema had not moved and
  # whose installation was still serving. Nothing has been asked to stop yet, so the only
  # correct action is to put back what this run changed and leave the service alone.
  if ! ${FENCE_ARMED} && ${CUTOVER_ARMING}; then
    echo ""
    warn "=========================================================================="
    warn " INSTALL FAILED BEFORE THE STOP — THE EXISTING INSTALLATION IS STILL UP"
    warn "=========================================================================="
    warn "  failed step : ${CUTOVER_STEP}"
    warn "  exit status : ${status}"
    warn "  service     : UNTOUCHED. Nothing was stopped, so nothing needs starting."
    warn "  schema      : untouched — the migration was never invoked."
    warn "  database    : never fenced; the application still has CONNECT."
    unwind_arming
    warn "  Fix the cause and re-run. Nothing has to be recovered first."
    exit "${status}"
  fi

  ${FENCE_ARMED} || exit "${status}"

  echo ""
  error "=========================================================================="
  error " INSTALL FAILED AFTER THE STOP — THE OLD VERSION IS NOT BEING RESTARTED"
  error "=========================================================================="
  error "  failed step : ${CUTOVER_STEP}"
  error "  exit status : ${status}"
  if ${SCHEMA_TOUCHED}; then
    error "  schema      : a migration was RUNNING; the database may be MIGRATED or"
    error "                half-migrated while nothing is serving. That is the intended"
    error "                safe state; what the connection fence is doing about it is"
    error "                stated below, once this run has finished making it true."
  else
    error "  schema      : untouched — this run stopped before the migration was invoked."
  fi
  if ${REBOOT_FENCE_INSTALLED}; then
    error "  service     : STOPPED, and fenced by ${FENCE_DROPIN_FILE} so a reboot"
    error "                cannot start it either while ${FENCE_FILE} exists."
  else
    # Printed unconditionally once, describing a drop-in that may never have been installed
    # (o3d-2sm1.5, Codex r4 HIGH). The re-install below corrects this line.
    error "  service     : STOPPED, and there is NO verified reboot fence: this host may"
    error "                start it again on its next boot. The re-install below says"
    error "                whether that could be put right."
  fi
  error "  cron        : ${APP_USER} entries left FENCED (commented out)."
  error "  Do NOT start ${APP_NAME}.service by hand. Fix the cause and re-run this"
  error "  installer, scripts/update.sh or scripts/deploy.sh — all three read this fence"
  error "  from the same place (${FENCE_FILE}) and adopt it."

  systemctl stop "${APP_NAME}.service" >/dev/null 2>&1 || true
  install_reboot_fence "install failed at ${CUTOVER_STEP}" >/dev/null 2>&1 \
    || error "THE REBOOT FENCE IS NOT IN PLACE. This host may start the old version against a migrated schema on its next boot. Stop it by hand."
  # "HELD" IS A CLAIM, SO IT IS MADE TRUE BEFORE IT IS PRINTED (Codex r3 HIGH). The start
  # step releases the fence before `systemctl enable --now`, so a failure there arrives with
  # SCHEMA_TOUCHED true and the fence already DOWN. Re-establish it — the service has just
  # been re-stopped above — and then say which of the two actually happened.
  if ${SCHEMA_TOUCHED}; then
    if ! ${DB_FENCE_UP}; then
      warn "The connection fence had already been released for the start; re-establishing it."
      refence_db_connections || true
    fi
    if ${DB_FENCE_UP}; then
      error "  THE CONNECTION FENCE IS DELIBERATELY LEFT UP. Release it only once you know"
      error "  the schema is sound:  ${DB_FENCE_RELEASE_CMD}"
    else
      error "  THE CONNECTION FENCE IS NOT IN PLACE, AND THE SCHEMA MAY HAVE MOVED. This run"
      error "  released it in order to start the application and could not put it back, so the"
      error "  application role CAN connect to a database whose schema is in an unknown state."
      error "  The only thing keeping it off is that ${APP_NAME}.service is stopped and fenced"
      error "  against a reboot. Do NOT start it. Close the database by hand, or re-run this"
      error "  installer, which re-establishes the fence before it migrates:"
      error "    node ${DB_FENCE_SCRIPT} --fence --state-file=${DB_FENCE_STATE}"
    fi
  else
    release_db_connections || true
  fi
  # LAST, so the marker records the fence state that is true when this process exits rather
  # than the one that was true before the re-fence was attempted.
  write_cutover_marker "install failed at ${CUTOVER_STEP}" "${status}" || true
  exit "${status}"
}

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
  # Recorded for the install transcript; the version is not branched on, only the id is.
  # shellcheck disable=SC2034
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
# NOT minted, and preserved for the same reason. The privileged connection the cutover
# fence needs is something an operator sets deliberately — a role separate from the
# application's — so all this installer has to do is not LOSE it. The heredoc below
# rewrites .env whole, and a variable this script does not carry forward is one a re-run
# silently deletes; losing this one now makes the NEXT upgrade refuse to migrate at all
# (there is no snapshot-only fallback any more). An explicit value in the environment
# still wins.
DEPLOY_ADMIN_DATABASE_URL="$(unquote_env_value "${DEPLOY_ADMIN_DATABASE_URL:-$(existing_env DEPLOY_ADMIN_DATABASE_URL)}")"
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

# The privileged connection the deploy scripts use to hold the database closed for a
# migration window (docs/installation.md, "A snapshot is not a fence"). A superuser or
# database-owner connection as a DIFFERENT role from DATABASE_URL. It is REQUIRED for any
# cutover that migrates: empty means the migration is REFUSED before anything is stopped,
# not that it falls back to a snapshot probe (o3d-2sm1.4). The migration connects as this
# role and SET ROLEs to the application role, so what it creates is owned by the
# application (o3d-2sm1.5).
DEPLOY_ADMIN_DATABASE_URL=${DEPLOY_ADMIN_DATABASE_URL}

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

# ---------------------------------------------------------------------------
# 10a. Detect an upgrade, and adopt any fence a previous run left standing (o3d-2sm1.3)
#
# See "THE UPGRADE CUTOVER FENCE" at the top of this file for why. In short: this
# installer is a supported way to upgrade an existing installation, and it used to
# migrate with the old service and the old crontab still writing. Nothing below starts
# anything again on a failure.
#
# ADOPTION AND THE FENCE PREFLIGHT COME BEFORE THE BUILD, THE STOP COMES AFTER IT
# (o3d-2sm1.5, Codex r4 CRITICAL). This block used to run the stop, the drain, the
# migration and the verification and only THEN seed, bootstrap and build — which inverts
# this branch's founding premise on the one entrypoint the docs say follows the same
# sequence. A TypeScript error costs nothing on deploy.sh; here it left the service
# stopped, cron fenced, the schema migrated and the connection fence held. So: adopt here,
# build here, and stop below.
# ---------------------------------------------------------------------------
MIGRATION_DATABASE_URL="${DATABASE_URL}"

if upgrade_in_place; then
  UPGRADE_EXISTING=true
  header "Existing installation detected — this run is an upgrade cutover"

  # Installed before anything is armed, so that a kill or a power cut anywhere below
  # leaves the marker, the drop-in and a stopped service rather than a running one.
  trap on_cutover_exit EXIT

  # BEFORE ANYTHING IS STOPPED, AND BEFORE THE BUILD. An existing installation's database
  # has to be held closed while its schema moves, and discovering at the drain step that it
  # cannot be would cost an outage for a missing environment variable — or, once, for a
  # missing node module.
  require_fenceable_database

  CUTOVER_STEP="adopt"
  # A fence a previous run left standing is adopted here, so a rebuild that has to run
  # inside a HELD fence gets MIGRATION_DATABASE_URL before the build needs it.
  acquire_cutover_lock
  import_legacy_cutover_state
  adopt_existing_fence
fi

# ---------------------------------------------------------------------------
# 11b. Build — while the existing installation is still serving the OLD schema
#
# The long step, and the one most likely to reject a release. Everything that can say no
# must say it here, where the predecessor is still up and the schema has not moved.
# ---------------------------------------------------------------------------
CUTOVER_STEP="build"
header "Generating Prisma client"

cd "${APP_DIR}"
run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  npx prisma generate --schema prisma/schema.prisma
success "Prisma client generated."

header "Building Next.js application (existing installation still serving)"

# DATABASE_URL is passed explicitly (Next.js does not override an inherited value with
# the one in .env) so that a build inside an ADOPTED, still-held fence goes through the
# privileged connection. Outside one, MIGRATION_DATABASE_URL IS DATABASE_URL and nothing
# changes; inside one, without it, anything the build touches in the database fails with
# "permission denied for database" — the fence working as intended, presenting as a build
# error.
run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  npm run build --prefix "${APP_DIR}"
success "Build complete."

CUTOVER_STEP="validate"
[[ -f "${APP_DIR}/.next/BUILD_ID" ]] || die \
  ".next/BUILD_ID is missing after the build — refusing to stop a working installation for an artefact that is not there."
success "Artefact validated: BUILD_ID $(cat "${APP_DIR}/.next/BUILD_ID")."

# ---------------------------------------------------------------------------
# 10c. Stop and drain every writer — ONLY when there is one
# ---------------------------------------------------------------------------
if ${UPGRADE_EXISTING}; then
  header "Stopping and draining every writer"

  CUTOVER_STEP="fence-writers"
  # BEFORE the stop and long before the migration: a fence installed on the way out
  # does not exist for a run that is killed. Failing to install it HERE costs nothing —
  # the old version is still up, the schema has not moved, and FENCE_ARMED is still
  # false, so no failure banner claims an outage that has not happened.
  #
  # PHASE `arming`: everything between here and the stop is reversible, and the exit trap
  # reverses it — the crontab goes back and the drop-in and marker this run wrote are
  # removed, WITHOUT stopping anything.
  CUTOVER_ARMING=true

  install_reboot_fence "install.sh cutover started $(date -Iseconds)" \
    || die "Refusing to stop the existing service without a verified reboot fence: a reboot mid-migration would start it again against a migrated schema."

  fence_cron

  # PHASE `stopping`: from the next statement on, something has been asked to stop and
  # nothing may start it again. Every failure before this point takes the reversible branch
  # in the trap (o3d-2sm1.5, Codex r7 HIGH).
  FENCE_ARMED=true
  # ...and the transition is on disk before `systemctl stop` runs, not after it.
  persist_stop_requested

  info "systemctl stop ${APP_NAME}.service"
  systemctl stop "${APP_NAME}.service" >/dev/null 2>&1 || true

  # AND THE LAUNCHERS THE UNIT DOES NOT COVER. A PM2-managed instance and a stray
  # app-directory node process are writers exactly like the unit is, and this block used to
  # run AFTER the migration — so on a PM2 installation the old binary served the whole
  # window (o3d-2sm1.4, Codex r3 HIGH).
  stop_legacy_launchers

  if command -v ss >/dev/null 2>&1; then
    for _ in $(seq 1 15); do
      ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${APP_PORT}\$" || break
      sleep 1
    done
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${APP_PORT}\$"; then
      die "Port ${APP_PORT} is still bound. Something is still serving — refusing to migrate."
    fi
  fi
  success "Nothing is serving ${APP_NAME} any more."

  CUTOVER_STEP="drain-verify"
  # The FENCE shuts the door for the rest of the window; only then does the PROBE
  # assert the room is empty. The probe alone is a snapshot — it closes its connection
  # and the migration opens its own afterwards with nothing holding the gap.
  fence_db_connections
  info "Asking Postgres whether anything else is still connected..."
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${MIGRATION_DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${APP_DIR}/scripts/check-db-writers.mjs" ) \
    || die "Another client is still connected to the target database. Stop it and re-run; the migration has NOT been applied."
  success "No other client backends on the target database."
else
  info "No existing installation: nothing is serving and no crontab is live, so there is"
  info "no writer to stop and no cutover to fence."
fi

header "Running database migrations"

# The Prisma client was generated in the build step above, while the predecessor was still
# serving; regenerating it here would only add work to the stopped window.
cd "${APP_DIR}"
CUTOVER_STEP="migrate"
# FROM HERE THE SCHEMA MAY HAVE MOVED. Recorded ON DISK and flushed BEFORE the command, not
# after it and not from the exit trap: an interrupted, half-applied or SIGKILLed migration
# is exactly what this flag exists for, and one that only ever reached shell memory is false
# for every one of those cases.
mark_schema_touched
run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  npx prisma migrate deploy --schema prisma/schema.prisma
success "Database migrations applied."

header "Validating database schema"

run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  node "${APP_DIR}/scripts/check-prisma-drift.mjs"
success "Database schema matches prisma/schema.prisma."

# AND THAT THE APPLICATION CAN ACTUALLY USE WHAT JUST LANDED (o3d-2sm1.5, Codex r4 CRITICAL).
# Everything above — prisma, the drift check — runs on the ADMIN connection, which owns
# whatever the migration created and reads all of it. So an ownership mistake in a fenced
# window was invisible to the entire pipeline: success reported, and every request touching
# the new table failing with "permission denied". This asks the database about the
# APPLICATION role, the one question none of the other steps ask.
header "Checking the application role can use what the migration created"

run_as_user "${APP_USER}" env \
  DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
  node "${DB_OBJECT_ACCESS_SCRIPT}" --state-file="${DB_FENCE_STATE}" \
  || die "The migration left objects the application role cannot use — see above. Nothing has been started."
success "The application role can use everything in the database."

# ---------------------------------------------------------------------------
# 10b. The migrations' own verification checks
#
# A migration declares them in prisma/migrations/<name>/verify.sql, and they run after
# the schema has moved and BEFORE anything is started. This installer used not to run
# them at all, which meant the one upgrade path most likely to be used by someone who
# does not know the deploy order was also the one with no second line of defence.
# ---------------------------------------------------------------------------
CUTOVER_STEP="verify-migrations"
header "Running the migrations' own verification checks"

run_as_user "${APP_USER}" env \
  DATABASE_URL="${MIGRATION_DATABASE_URL}" \
  DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
  node "${APP_DIR}/scripts/run-migration-verifications.mjs" \
  || die "A migration's verification check did not return zero. Nothing has been started."
success "Every declared verification check returned zero (the coverage report above says what was NOT declared)."

header "Seeding database"

run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" SEED_TEST_ADMIN="false" \
  npm run db:seed --prefix "${APP_DIR}"
success "Database seed applied."

if [[ -n "${DEFAULT_ADMIN_EMAIL}" || -n "${SMTP_HOST}" || -n "${SMTP_FROM_EMAIL}" || -n "${APP_DOMAIN}" || -n "${WC_STORE_URL}" ]]; then
  header "Bootstrapping default admin and seeded settings"
  BOOTSTRAP_SCRIPT="${APP_DIR}/scripts/provision-instance.mjs"
  [[ -f "${BOOTSTRAP_SCRIPT}" ]] || BOOTSTRAP_SCRIPT="/root/provision-instance.mjs"

  run_as_user "${APP_USER}" env \
    DATABASE_URL="${MIGRATION_DATABASE_URL}" \
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

# The build does NOT live here any more (o3d-2sm1.5, Codex r4 CRITICAL). It ran above,
# before the stop, with the existing installation still serving the old schema — which is
# the order deploy.sh and update.sh have and the order the docs describe for all three. A
# build in this position spends minutes of a stopped window on the step most likely to fail,
# and a TypeScript error here left the service stopped, cron fenced, the schema migrated and
# the connection fence held.
#
# The SEED and the BOOTSTRAP above deliberately did NOT move with it. They are not
# validations that can reject a release; they are writes, and they need the schema the
# migration has just applied. Running them before the stop would write to the OLD schema from
# the NEW code — the very overlap this order exists to prevent — so their place is here, with
# nothing serving and the new schema in force.

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
# Legacy PM2 instances are stopped, disabled and deleted by stop_legacy_launchers() in the
# cutover above — BEFORE the migration, not here. Removing them at this point meant a
# PM2-run installation kept writing for the whole length of the schema change (o3d-2sm1.4).
# stop_legacy_launchers is idempotent, so run it again on the way past: between the drain
# and here the installer has rewritten the unit file, and a PM2 daemon resurrected by
# anything in between must not be serving when the new unit starts.
stop_legacy_launchers

# ---------------------------------------------------------------------------
# THE FENCES COME DOWN HERE, and in the order that keeps the new build startable:
# the database first (it cannot serve a database it may not connect to), then the
# reboot fence (whose AssertPathExists would otherwise refuse this very start).
#
# THIS IS THE ONLY PLACE A RELEASE FOLLOWS A MIGRATION. Reaching this line means the
# migration applied, the deployed schema matched prisma/schema.prisma and every declared
# verification returned zero. Every other path out of this script either never touched
# the schema or leaves the fence standing.
# ---------------------------------------------------------------------------
CUTOVER_STEP="start"
release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence

systemctl enable --now "${APP_NAME}.service"

success "Application service started and registered with systemd."

# ---------------------------------------------------------------------------
# 12b. HEALTH CHECK (o3d-2sm1.5, Codex r4 MEDIUM)
#
# The cutover had none: it started the unit and declared the upgrade complete, so a new
# build that failed on its first request restored cron and reported success. deploy.sh and
# update.sh both poll before they call it done; this is the entrypoint most likely to be used
# by someone who does not know the deploy order, so it is the last place to leave it out.
#
# A failure here is a post-stop failure like any other: the trap re-stops, re-fences and says
# so. It does NOT restore the old version.
# ---------------------------------------------------------------------------
CUTOVER_STEP="health"
header "Health check"

INSTALL_HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/health"
INSTALL_HEALTHY=false
for _ in $(seq 1 90); do
  if curl -fsS --max-time 3 "${INSTALL_HEALTH_URL}" >/dev/null 2>&1; then
    INSTALL_HEALTHY=true
    break
  fi
  sleep 1
done
if ! ${INSTALL_HEALTHY}; then
  journalctl -u "${APP_NAME}.service" -n 60 --no-pager >&2 || true
  die "The application did not answer ${INSTALL_HEALTH_URL} within 90s. Leaving it stopped rather than declaring the upgrade complete."
fi
success "Health check passed — the application is answering ${INSTALL_HEALTH_URL}."

# ---------------------------------------------------------------------------
# AND WHICH BUILD IS ANSWERING? (o3d-2sm1.5, Codex r5 HIGH)
#
# /api/health is process liveness and touches no database. On an UPGRADE re-run a predecessor
# still holding port ${APP_PORT} answers it exactly as well as the new build does — and the
# point of no return below was armed by that answer alone, after which the trap explicitly
# REFUSES to stop the service. The old build would have been left serving a MIGRATED schema,
# with the installer reporting success.
#
# /_next/static/<BUILD_ID>/ is served only by the process whose own build id is that one, so a
# 200 there is the new code identifying itself. Nothing else available here distinguishes the
# two processes, and "nothing proved it" must not be read as "proven".
# ---------------------------------------------------------------------------
[[ -f "${APP_DIR}/.next/BUILD_ID" ]] \
  || die "No .next/BUILD_ID after the build, so nothing can prove which build answered ${INSTALL_HEALTH_URL}."
NEW_BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID")"
BUILD_ASSET="$(ls "${APP_DIR}/.next/static/${NEW_BUILD_ID}" 2>/dev/null | head -1 || true)"
if [[ -n "${BUILD_ASSET}" ]] \
  && curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/_next/static/${NEW_BUILD_ID}/${BUILD_ASSET}" >/dev/null 2>&1; then
  NEW_BUILD_SERVING=true
  success "The process on port ${APP_PORT} serves /_next/static/${NEW_BUILD_ID}/ — it is this build."
else
  die "Something answered ${INSTALL_HEALTH_URL}, but nothing proved it was BUILD_ID ${NEW_BUILD_ID}. A predecessor still holding port ${APP_PORT} answers that route too, and the schema has already moved. Refusing to declare the installation irreversible on the strength of an open port."
fi

# THE POINT OF NO RETURN (o3d-2sm1.5, Codex r4 HIGH). The new build is serving and everything
# that could reject this release has passed. Nothing below may stop it, re-fence it or revoke
# CONNECT again: a failure in the cron restore, the nginx config or the log rotation is
# something to fix by hand, not a reason to tear down a working installation.
#
# ARMED ONLY BY THE PROOF ABOVE: `$NEW_BUILD_SERVING` is false until the build on disk was
# shown to be the process on the port (o3d-2sm1.5, Codex r5 HIGH).
if $NEW_BUILD_SERVING; then
  PAST_POINT_OF_NO_RETURN=true
fi

# The ARMING phase is over on every path that reaches here: the reboot fence came down before
# the start and there is nothing reversible left to reverse. Leaving CUTOVER_ARMING raised
# would send a failure in the rest of the installer into the PRE-STOP branch of the trap,
# which would report a service that was never stopped and unwind a fence that is already
# gone.
CUTOVER_ARMING=false

# THE STOP FLAG COMES DOWN ONLY FOR A RUN THAT NO LONGER NEEDS IT (o3d-2sm1.5, Codex r8).
#
# Past the point of no return the trap is governed by PAST_POINT_OF_NO_RETURN and FENCE_ARMED
# is irrelevant. Any path that reaches here WITHOUT that proof is one where a later failure is
# still supposed to be torn down — and clearing FENCE_ARMED here would leave such a failure
# matching none of the trap's four phase branches, so the trap would do nothing at all and an
# unidentified process would be left serving the migrated schema. deploy.sh has such a path
# today (its dev-responder escape hatch); this script must not grow one silently.
if ${PAST_POINT_OF_NO_RETURN}; then
  FENCE_ARMED=false
fi

# Cron goes back only once the new build is running, and BEFORE the crontab block below
# is spliced in — splicing into a fenced crontab would preserve the commented-out lines
# and leave the queue workers silently off.
unfence_cron

# The cleanup this flag covered is complete, so it stands down — and only now.
FENCE_ARMED=false
if ${UPGRADE_EXISTING}; then
  success "Upgrade cutover complete: every fence is down."
fi

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
# This REPLACES the cutover trap installed for the migration window, deliberately: by
# here the fences are down and the new build is running, so a failure below is an
# ordinary configuration failure with nothing half-migrated behind it.
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
