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

# ---------------------------------------------------------------------------
# COMMAND SUBSTITUTION DELETES TRAILING NEWLINES, AND A PASSWORD IS BYTES
# (o3d-2sm1.5 r40, Codex HIGH).
#
# THE DEFECT. `$( )` strips EVERY trailing newline from what it captures. That is a feature for
# `$(date)` and a data-loss bug for a credential: an operator whose password ends in a newline —
# spelled `abc%0A` in the URL, which is exactly what r39's own encoder emits for it — has that
# byte parsed by node-postgres, held by the server, and DELETED by the shell capture the recovery
# reads it back through. The mechanism r39 built to preserve exact password bytes corrupted a
# class of them: a re-install recovers `abc`, sees it differ from the installed `abc\n`, and
# ROTATES a live credential nobody asked to rotate — or, on the journal path, publishes a `.env`
# naming a password the server does not have.
#
# THE FIX IS A SENTINEL, NOT A NAMEREF. A nameref (`local -n`) cannot be used for these: the
# producing functions are pure and several of them are also called from the regressions and from
# other captures, and a nameref would make them unusable in either position. Instead the value is
# followed INSIDE the substitution by a fixed terminator, so the newlines the shell eats are no
# longer trailing, and the terminator is removed afterwards with `${var%"..."}` — the SHORTEST
# matching suffix, so exactly the one byte-string this function appended comes off, whatever the
# value itself ends with.
#
#   capture VAR command args...
#
# VAR receives exactly the bytes `command` wrote to stdout, trailing newlines and all, and the
# return value is the command's own. A command that writes nothing leaves VAR empty. The command
# runs in a SUBSHELL, as it did under `$( )`, so it must be pure — every caller here is.
#
# THERE IS NO `set +e` IN HERE, AND THAT WAS MEASURED RATHER THAN ASSUMED. The obvious worry is
# that under this script's `set -e` a non-zero return from the command would leave the subshell
# before the terminator was written — silently back to stripping. It cannot: the assignment below
# is ALWAYS in a `|| __capture_status=$?` context, and errexit is suppressed for a command whose
# failure is tested, all the way into the substitution. That holds with `shopt -s inherit_errexit`
# set as well as unset (bash 5.2, both measured). A `set +e` here would be a line that cannot
# change what this function does, and a guard that cannot fail is not a guard.
CAPTURE_TERMINATOR='--ims-end-of-captured-value--'

capture() {
  local __capture_name="$1"
  shift
  local __capture_raw __capture_status=0
  __capture_raw="$(
    "$@"
    __capture_inner=$?
    printf '%s' "${CAPTURE_TERMINATOR}"
    exit "${__capture_inner}"
  )" || __capture_status=$?
  printf -v "${__capture_name}" '%s' "${__capture_raw%"${CAPTURE_TERMINATOR}"}"
  return "${__capture_status}"
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
# WHY this run is fenced, in the words every refusal on the fenced path prints. Set by the branch
# below and read by require_fenceable_database(), so an operator who is told the database must be
# held closed is told WHICH of the two reasons put them there (o3d-2sm1.5 r36, Codex CRITICAL).
FENCED_CUTOVER=false
CUTOVER_REASON=""
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
# THE ENVIRONMENT THE STARTED SERVICE IS BOUND TO (o3d-2sm1.5 r23, Codex HIGH).
#
# Rounds 13-22 asked, in eleven spellings, WHICH DATABASE THE SERVICE WILL USE, and every answer
# was correct and incomplete for one reason: it was a READ of a file the service reads later and
# somebody else can replace in between. Re-reading closer to the start shortens that window; it
# cannot close it, because `EnvironmentFile=` is read by systemd at the moment it EXECS.
#
# So this round stops checking and BINDS. The value this run validated, fenced and migrated is
# written to a file under the cutover state directory — root-owned, 0600, in a directory the
# application user cannot write — and every unit is given a drop-in that loads THAT file, LAST.
# systemd.exec: "If the same variable is set twice from these files, the files will be read in
# the order they are specified and the later setting will override the earlier setting", and
# "Settings from these files override settings made with Environment=". So whatever
# ${APP_DIR}/.env has come to say by exec time, DATABASE_URL is the snapshot's.
#
# AND IT IS MANDATORY, WITH NO LEADING `-`. A missing snapshot is then a START FAILURE rather
# than a silent fall-through to the application's own dotenv overlays — the exact difference
# that made a DELETED .env dangerous, since the shipped units load that one with a `-`.
#
# WHY THIS CLOSES THE RACE THE RE-READ COULD NOT. Two systemd reads are involved and they have
# different timing. The SET of environment files is unit CONFIGURATION, fixed at the last
# `daemon-reload` and NOT re-read by `systemctl start`; the CONTENTS are read at exec. This run
# issues the final daemon-reload itself, verifies the loaded list on the bus AFTER it, and
# nothing between that verification and the start runs a unit-file command at all — not an
# explicit daemon-reload and not one of the verbs that reloads IMPLICITLY (r24 moved the unmask
# and the enable above the final reload for exactly that reason) — so the list cannot change
# under it. The contents can be changed only by root, which is not a position this deploy can
# defend against and is not the threat model: the file the check-to-exec race was about was
# writable by the application user and by whatever configuration management writes .env.
# NOT under ${CUTOVER_STATE_DIR}, which is the application's own data directory and therefore
# WRITABLE BY THE APPLICATION USER (o3d-2sm1.5 r23). A binding the service can delete is not a
# binding: the drop-in would then name a file that is gone, and — because it is loaded without a
# leading `-` — the unit would refuse to start. Fail-closed, but an outage the app user could
# cause. This directory is created root-owned and 0700 by publish_db_identity_snapshot().
# AND ITS PATH IS A CONSTANT, NOT AN OVERRIDE (o3d-2sm1.5 r24, Codex HIGH). It used to be
# ${IMS_CUTOVER_ENV_DIR:-/etc/ims-cutover}, and update.sh sources ${APP_DIR}/.env into the
# environment AS ROOT before it resolves this line — so the variable that chose where the
# snapshot goes was one THE APPLICATION USER WRITES. That hands back the entire point of the
# location. publish_db_identity_snapshot() chowns and chmods only the FINAL directory, so a path
# under an app-writable parent is secured after the parent has already been chosen: rename the
# secured child away, put an attacker-owned directory at the same path, and PID 1 reads that
# instead while the bus check and the mandatory-file check both still pass. The same override
# aimed at an existing system directory chmods it to 0700 and takes it out.
#
# There is no configurable spelling of this that is safe. An override only a root-owned source
# may set is indistinguishable from no override, and a trust root read out of the very file the
# snapshot exists to distrust is not a trust root. So it is a literal: a deployment that must
# move it edits this line, which is a root-owned change to a root-owned file, reviewed like any
# other. The same reasoning is why nothing else in this script resolves a privileged path from a
# variable the application can set. This script never put ${APP_DIR}/.env into its environment at
# all — it reads one key at a time with env_file_value() — and since r25 update.sh does the same,
# so no IMS_* line in that file becomes a variable in any of the three entrypoints.
DB_ENV_SNAPSHOT_DIR="/etc/ims-cutover"
DB_ENV_SNAPSHOT_FILE="${DB_ENV_SNAPSHOT_DIR}/db-identity-snapshot.env"
DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"
DB_ENV_SNAPSHOT_DROPIN_FILE="${FENCE_DROPIN_DIR}/${DB_ENV_SNAPSHOT_DROPIN_NAME}"
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
# ---------------------------------------------------------------------------
# WHICH BYTES OF THAT HELPER MAY RUN WITH DEPLOY_ADMIN_DATABASE_URL (o3d-2sm1.5 r31, Codex
# CRITICAL). ${DB_FENCE_SCRIPT} is under the application-owned checkout this installer clones or
# copies into place, and until this round every mode here — preflight, fence,
# --print-migration-url, release, and the exit trap's re-fence — executed it from that path with
# an administrative database credential in its environment. On an UPGRADE the checkout is an
# existing installation's tree, owned by the application account, and that account can replace the
# file between any two of those moments.
#
# The rule is stated ONCE, in the library below, and shared with update.sh and deploy.sh: r30
# inverted the precedence in update.sh alone and left this script and deploy.sh reading the old
# one. Nothing here resolves a fence script of its own; db_fence_script_in_use() does, and it
# never returns ${DB_FENCE_SCRIPT}.
#
# SOURCED FROM THIS SCRIPT'S OWN DIRECTORY, WHICH ON AN UPGRADE IS NOT ${APP_DIR}: the installer
# is run from the release being installed, and that is the more trustworthy of the two trees. It
# is read at startup, in the same instant as the body of this file, so it adds no window this
# entrypoint does not already have — unlike the helper, which is executed much later.
IMS_SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=lib/db-fence-protected.sh
source "${IMS_SCRIPT_LIB_DIR}/db-fence-protected.sh" || {
  echo "FATAL: ${IMS_SCRIPT_LIB_DIR}/db-fence-protected.sh could not be sourced. It decides which bytes the connection fence may be executed with, and without it this run cannot fence a migration window. Nothing has been changed." >&2
  exit 1
}
DB_OBJECT_ACCESS_SCRIPT="${APP_DIR}/scripts/check-app-db-object-access.mjs"
# THE APPLICATION'S CONNECTION IDENTITY, WHICH THIS INSTALLER OWNS OUTRIGHT (o3d-2sm1.5 r19).
#
# scripts/fence-db-connections.mjs no longer works out where the application connects. Seven
# rounds of deriving it — from the URL, from node-postgres's own resolution, from the deploy
# shell's PG* variables, from the service's environment file, from `systemctl show` — each gave a
# locally correct answer and uncovered another layer beneath it (PassEnvironment=,
# UnsetEnvironment=, wildcard EnvironmentFile= globs, Next's per-mode dotenv overlays, a unit
# with no WorkingDirectory=, DATABASE_URL's own precedence chain). The question is unbounded,
# because the composition rules belong to systemd, Next and libpq at once. So the fence is TOLD,
# and refuses if it is not.
#
# HERE THERE IS NOTHING TO PARSE AND NOTHING TO GUESS. This script PROMPTS for DB_HOST, DB_PORT,
# DB_NAME and DB_USER, CREATEs the role and the database with them, and COMPOSES DATABASE_URL out
# of them further down. The four values below are those same variables, and they are filled in at
# that point — deliberately EMPTY until then, so a fence reached before the database exists (an
# exit trap on an early failure) refuses rather than fencing an unnamed connection.
DB_FENCE_IDENTITY_ARGS=()
# ---------------------------------------------------------------------------
# WHAT AN OPERATOR IS TOLD TO RUN (o3d-2sm1.5 r32, Codex HIGH x2)
#
# NOT A COMMAND LINE. r31 fixed which bytes this script executes and left every printed
# instruction describing the world before it, which produced two separate defects of the same
# kind:
#
#   * the printed `--release` line named the protected copy but had NO WAY TO OBTAIN
#     DEPLOY_ADMIN_DATABASE_URL. The helper's `.env` load resolved against its own mirrored
#     location, and the mirror holds no `.env`; this script's own copy of the variable lives in
#     THIS shell and not in the operator's. Pasted, it failed while the database stayed fenced.
#   * the re-fence banner — printed at the one moment when the schema has moved and the fence is
#     down — still said `node ${DB_FENCE_SCRIPT} --fence`, the application-owned path, handing the
#     admin credential to whatever is at it.
#
# So both are now ROOT-OWNED WRAPPERS, written by db_fence_publish_operator_wrappers() out of the
# artefact this run resolved, with the state file and the four identity values baked in. They take
# the credential from their own environment or from ${APP_DIR}/.env with the same reader
# env_file_value() uses, re-verify the artefact digest before exec, and run as ${APP_USER}. There
# is nothing to fill in and nothing to paste wrongly.
#
# AND THE INSTRUCTION IS NOT THE BARE PATH (o3d-2sm1.5 r33, Codex HIGH). Those wrappers are
# root-owned and 0700. The operator most likely to be reading this banner launched the cutover
# with `sudo bash scripts/...` and is back in a NON-ROOT shell, where pasting a bare path gives
# `Permission denied` while the database is still fenced. ${DB_FENCE_SUDO_PREFIX} carries the
# privilege transition, and it is empty only on a box with no sudo — which is a box this run
# cannot have been launched on as anything but root, so the reader is root there.
#
# ONE ASSIGNMENT EACH, and every banner in this file prints these two variables rather than
# composing a command of its own: that is the same "one rule, several readers" discipline the
# fence library exists for, applied to the text.
DB_FENCE_RELEASE_CMD="${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}"
DB_FENCE_REFENCE_CMD="${DB_FENCE_SUDO_PREFIX}${DB_FENCE_REFENCE_WRAPPER}"

# THE ONE PLACE THIS SCRIPT DECIDES WHICH BYTES THE FENCE RUNS, and the one place the recovery
# wrappers are refreshed — so the file that is executed and the file an operator is pointed at can
# never be about different artefacts. Prints the script path; the reason for a refusal is already
# on stderr from the library.
#
# A wrapper that could not be written is a WARNING and not a refusal: it is a convenience file in
# a root-owned directory, and failing a fence over it would trade a real protection for a
# cosmetic one. The path printed in the banners is still the right one to run — a previous run's
# wrapper is very likely standing there — and the warning says the refresh did not happen.
# ---------------------------------------------------------------------------
# WAS THE DATABASE CREATED BY THIS RUN? (o3d-2sm1.5 r36, Codex CRITICAL)
#
# THE DEFECT. r35's policy — a first install performs no credentialed fence execution — rested on
# a premise it never checked: "there is no writer to stop, because the database was created by
# this run". upgrade_in_place() asks four questions and every one of them is about THIS HOST: the
# service unit, the crontab, PM2, and processes whose working directory is ${APP_DIR}. None of
# them is about the database. A fresh application host pointed at an existing, live, REMOTE
# database answers no to all four, takes the exemption, and migrates a schema other writers are
# using — which is the corruption the cutover fence exists to prevent, on the one path that skips
# it. The reasoning was sound and the premise was assumed; so the premise is now PRODUCED by this
# invocation, or the exemption is not available at all.
#
# WHAT COUNTS AS PROOF, AND WHY AN ALREADY-EXISTING DATABASE CANNOT FORGE IT.
# `CREATE DATABASE <name>` succeeding, issued by this process against this host's local
# PostgreSQL server. PostgreSQL rejects that statement with 42P04 duplicate_database when the name
# is taken, so a zero exit is the SERVER stating that the object did not exist an instant earlier
# and that this statement is what brought it into being. There is nothing an established database
# can present that produces that exit status: it makes the statement FAIL, and it fails
# identically whether it is empty, full, quiescent, or carrying a hundred connections. The proof
# is about an EVENT this run caused, which is why it cannot be staged in advance.
#
# WHAT IS DELIBERATELY NOT PROOF, and this is the distinction the whole finding turns on: AN
# EMPTY SCHEMA IS NOT A DATABASE THIS RUN CREATED. "No tables in public" is a statement about
# content at one instant. It is true of a brand-new database and equally true of a database
# another operator created five minutes ago and is about to migrate, of one whose objects live
# under a different search_path, and of one whose writers are connected and idle right now. It is
# also a race: content can arrive between the question and the migration. `datconnlimit`, a
# `pg_stat_activity` headcount and "no other connections at this moment" are the same kind of
# instant and are not proof either. None of them is used here.
#
# WHAT THIS RUN CANNOT ESTABLISH AT ALL, every case of which therefore falls to the fenced path:
#   * INSTALL_POSTGRES=n — the supported external-database path creates no database, so there is
#     nothing for this run to have proven. EVERY remote database is in this case.
#   * INSTALL_POSTGRES=y over a database that already existed — CREATE DATABASE was refused as a
#     duplicate. That is precisely the outcome the old `SELECT ... WHERE NOT EXISTS ... \gexec`
#     swallowed while reporting success.
#   * any indeterminate result — psql could not be reached, or the statement failed for a reason
#     that is not duplication. That case now stops the run rather than continuing unproven.
#   * a proof about a DIFFERENT database than the one about to be migrated.
#
# There is no fifth answer: the flag below starts false, and exactly one statement in this file
# sets it true.
# ---------------------------------------------------------------------------
DB_CREATED_BY_THIS_RUN=false
# The host:port/name CREATE DATABASE actually succeeded against, so proof about one database can
# never be spent on another.
DB_CREATED_IDENTITY=""
# The identity the SERVER answered with on the connection that performed the CREATE: postmaster
# start time, port and the new database's oid. Verified against the endpoint DATABASE_URL names.
DB_CREATED_SERVER_IDENTITY=""
# What this run established, in the words the refusal prints. Replaced at the creation step.
DB_NEWNESS_FINDING="this run created no database, so nothing here established that the database it is about to migrate is new"
# Why the exemption was refused, when it was. Set by first_install_exemption_available().
FIRST_INSTALL_EXEMPTION_REFUSAL=""

# ---------------------------------------------------------------------------
# EVERY psql THIS SCRIPT RUNS IS TOLD WHERE TO GO, AND THE PROOF IS READ OFF THE
# CONNECTION THAT PRODUCED IT (o3d-2sm1.5 r37, Codex CRITICAL)
#
# THE DEFECT. `create_database_and_record_newness` ran `run_as_user postgres psql -c "CREATE
# DATABASE ..."` with no host, no port and no maintenance database, and then RECORDED
# "${DB_HOST}:${DB_PORT}/${DB_NAME}" as the thing it had proven. Neither half was observed.
# libpq fills every absent connection value from the environment — PGHOST, PGHOSTADDR, PGPORT,
# PGDATABASE, PGSERVICE, PGUSER, and a pg_service.conf found through PGSYSCONFDIR — and
# `run_as_user` preserves the environment on two of its three branches (`runuser -u ... --` and
# the `su -s` fallback; only the `sudo` branch resets it, so the behaviour was not even uniform
# across boxes). With PGPORT=5433 inherited from the invoking shell, the statement creates the
# database on a SECOND cluster, exits 0, and this script writes down `localhost:5432` as proven.
# Both halves are then true of DIFFERENT SERVERS, and the exemption skips the fence over a live
# database on 5432 that this run never touched. `PSQLRC` is the same hole with a different shape:
# a `\c` in a startup file moves the session before our statement runs.
#
# THIS BRANCH ESTABLISHED THAT FACT ITSELF, for the connection fence: DB_FENCE_IDENTITY_ARGS
# exists because "no PGHOST/PGPORT/PGUSER/PGDATABASE in any process can move the connection away
# from them". The same rule, a new reader, unapplied. So:
#
#   1. SANITISE. Every psql this script runs has every PG*/PSQL* variable removed from its
#      environment first, so nothing inherited can supply a value we did not state.
#   2. BIND. The superuser connection states its socket directory, its port and its maintenance
#      database; the endpoint connection states host, port, user and database. -X ignores any
#      psqlrc, -w refuses to block on a password prompt.
#   3. PROVE. Sanitising is necessary and it is not sufficient — it makes the connection
#      DETERMINISTIC, not CORRECT, and a wrong DB_LOCAL_SOCKET_DIR or a second cluster sharing a
#      port would still land the CREATE somewhere else. So the identity is READ OFF THE
#      CONNECTION THAT PERFORMED THE CREATE and compared with the identity read off a connection
#      opened exactly the way the migration opens its own: TCP to ${DB_HOST}:${DB_PORT}. The
#      exemption is licensed by that comparison, not by where this script believes it connected.
# ---------------------------------------------------------------------------

# The variables that can move a libpq connection, silence its refusal, or run SQL before ours.
# Computed from the ACTUAL environment rather than from a list somebody has to keep current: any
# exported PG*/PSQL* name is removed, which covers PGSERVICE, PGSYSCONFDIR, PGOPTIONS, PGSSL*,
# PGTARGETSESSIONATTRS, PGLOADBALANCEHOSTS and whatever libpq adds next. Names are read from
# `compgen -e`, so nothing here has to trust a caller-supplied string.
#
# Fills the caller's named array; `env -u X -u Y ... psql` then starts psql with them gone.
libpq_env_unset_args() {
  local -n _out="$1"
  local var
  _out=()
  while IFS= read -r var; do
    case "${var}" in
      PG*|PSQL*) _out+=(-u "${var}") ;;
    esac
  done < <(compgen -e)
}

# WHERE THE LOCAL SUPERUSER CONNECTION GOES, STATED RATHER THAN INHERITED.
#
# It is a SOCKET directory and not a host, and that is deliberate: the CREATE is issued as the
# `postgres` OS user, which Debian's default pg_hba admits by `peer` on the local socket and by
# `scram-sha-256` over TCP — where that role has no password. Forcing -h localhost would
# therefore break every ordinary install. The port still pins the CLUSTER (a socket is
# .s.PGSQL.<port>), and the identity comparison below is what pins the SERVER.
#
# IMS_PG_SOCKET_DIR exists because the regression that proves this cannot use the machine's real
# socket directory. It cannot weaken the proof: pointing it at another cluster does not produce
# an exemption, it produces the refusal in verify_created_database_endpoint().
db_local_socket_dir() {
  if [[ -n "${IMS_PG_SOCKET_DIR:-}" ]]; then
    printf '%s' "${IMS_PG_SOCKET_DIR}"
  elif [[ -d /var/run/postgresql ]]; then
    printf '%s' /var/run/postgresql
  else
    printf '%s' /tmp
  fi
}

# The local superuser connection: sanitised, bound to this host's socket directory, this run's
# port and the `postgres` maintenance database. Every psql in this file goes through here or
# through pg_endpoint_psql below.
pg_local_psql() {
  local -a unset_args=()
  libpq_env_unset_args unset_args
  run_as_user postgres env "${unset_args[@]}" psql \
    -X -w -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$(db_local_socket_dir)" -p "${DB_PORT}" -d postgres "$@"
}

# THE ROUTE A CREDENTIAL-BEARING CONNECTION IS PINNED TO (o3d-2sm1.5 r42, r43).
#
# Empty is libpq's own default, `sslmode=prefer` — which is what the server-identity read below
# wants, for the reasons argued at length there. Set to `require` or `disable` it removes libpq's
# run-time transport choice entirely, and with it the second pg_hba record an authentication
# FAILURE could otherwise select. Since r43 the value it is set to is the APPLICATION'S route and
# not a probe's, so a psql running under this pin is matched by the record that will match the
# application.
#
# IT IS NEVER EXPORTED and its name begins with neither PG nor PSQL, so libpq_env_unset_args()
# neither strips it nor mistakes it for a libpq setting. The functions that pin it set it inside a
# SUBSHELL, which is what keeps a `VAR=x function` prefix's well-known persistence out of this.
DB_ENDPOINT_ROUTE_SSLMODE=""

# A connection opened the way the APPLICATION opens its own: TCP, to the four values
# DATABASE_URL is composed from. Used only to read a server identity back — and, with the route
# above pinned, as the one credential-bearing probe on the rotation path.
pg_endpoint_psql() {
  local role="$1" password="$2" database="$3"
  shift 3
  local -a unset_args=() keep=() route=()
  local i=0
  libpq_env_unset_args unset_args
  # THE PIN, AS TWO libpq SETTINGS AND NOT ONE. `sslmode` decides TLS; `gssencmode` decides GSSAPI
  # encryption, defaults to `prefer` wherever libpq was built with GSSAPI, and a connection that
  # takes it is matched by `hostgssenc` records — a third transport, and one the reader never
  # negotiates. Pinning only the first would leave the divergence open on any host with a Kerberos
  # credential cache. They come AFTER the `-u` options: env unsets during option parsing and
  # assigns afterwards, so these win over anything the caller's environment carried.
  # `:-` AND NOT A BARE EXPANSION. The default is "libpq's own", so the absence of the variable and
  # its emptiness must mean the same thing — and this function is lifted whole by three separate
  # regression rigs, only one of which has any reason to know the knob exists. Under `set -u` a bare
  # expansion turns the other two into dead shells that report an unbound variable from inside a
  # refusal message, which is how this landed the first time.
  if [[ -n "${DB_ENDPOINT_ROUTE_SSLMODE:-}" ]]; then
    route=("PGSSLMODE=${DB_ENDPOINT_ROUTE_SSLMODE}" "PGGSSENCMODE=disable")
  fi
  # THE ONE VARIABLE THIS CONNECTION SUPPLIES ITSELF IS KEPT OUT OF THE UNSET LIST, and then
  # EXPORTED rather than passed to `env` as an argument. `env PGPASSWORD=... psql` would put the
  # credential in env's argv, where every process on the box can read it out of ps for as long as
  # the connection lasts. Exporting it inside a subshell puts it in the environment instead,
  # which is readable only by root — and leaves the caller's shell untouched, which a
  # `VAR=x function` prefix would not: bash keeps such an assignment after a FUNCTION call.
  while [[ "${i}" -lt "${#unset_args[@]}" ]]; do
    [[ "${unset_args[$((i + 1))]}" == "PGPASSWORD" ]] || keep+=("${unset_args[${i}]}" "${unset_args[$((i + 1))]}")
    i=$((i + 2))
  done
  (
    export PGPASSWORD="${password}"
    run_as_user postgres env "${keep[@]}" "${route[@]}" psql \
      -X -w -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
      -h "${DB_HOST}" -p "${DB_PORT}" -U "${role}" -d "${database}" "$@"
  )
}

# ---------------------------------------------------------------------------
# THE PASSWORD IS ONE STRING AND IT TRAVELS THROUGH TWO GRAMMARS (o3d-2sm1.5 r39, Codex HIGH).
#
# THE DEFECT. `ALTER USER "x" WITH PASSWORD '${DB_PASSWORD}'` set the role's password to the
# LITERAL bytes of DB_PASSWORD, and the very next statement interpolated those same bytes RAW
# into `postgresql://user:${DB_PASSWORD}@host:port/db`. Two different grammars, one substitution,
# and the application does not read the URL the way this script wrote it. It reads it with
# node-postgres, whose pg-connection-string does `decodeURIComponent(new URL(str).password)`.
# Measured against the copy in this repo's node_modules (pg 8.20.0, pg-connection-string 2.12.0):
#
#   installed password   what the raw URL gives the driver
#   ------------------   ----------------------------------------------------------------
#   abc%2Fdef            "abc/def"   — authenticates as a DIFFERENT string than ALTER set
#   AAA%25BBB            "AAA%BBB"   — likewise
#   abc/def              THROWS "Invalid URL" — the URL is not parseable at all
#   abc?def              THROWS "Invalid URL"
#   abc#def              THROWS "Invalid URL"
#   %FF                  THROWS "URI malformed"
#
# and that happens AFTER the predecessor has been stopped and its password taken away, so the
# outage is total and the ALTER succeeded. A password with an apostrophe did not even get that
# far: it broke out of the SQL literal.
#
# THE RULE, AND IT IS THE ONLY ONE THAT MAKES THE TWO HALVES INVERSES:
#
#   DB_PASSWORD is the LITERAL SERVER SECRET. It is SQL-quoted for the statement and
#   PERCENT-ENCODED for the URL, and a URL found on disk is DECODED before it is compared with
#   anything or used as a credential.
#
# `url_encode_userinfo` escapes everything outside RFC 3986 unreserved (ALPHA DIGIT - . _ ~), so
# every byte it emits is either unreserved or a `%XX` with two hex digits. That set is what makes
# the round trip exact rather than approximately exact: it leaves no character that WHATWG URL
# parsing would re-encode, no `%` that pg-connection-string's malformed-escape pre-pass would
# rewrite, and no `/`, `?`, `#`, `@` or `:` that could move a byte out of the userinfo altogether.
#
# VERIFIED AGAINST THE INSTALLED DRIVER, NOT AGAINST THE SPECIFICATION — the discipline this
# branch used for the pooler and the clone. tests/scripts/install-credential-representation.test.ts
# runs these two shell functions and hands their output to the `pg` in node_modules, on a real
# cluster: 28 reserved-character passwords encode, parse back to the literal, and open a
# connection the server accepts.
# ---------------------------------------------------------------------------

# A PostgreSQL string literal for an arbitrary byte string. Doubling `'` is the whole of the
# escaping ONLY while standard_conforming_strings is on, which is the default since 9.1 and which
# every caller SETs on the same connection immediately before the statement rather than assuming.
# With it off, a backslash escapes, and `\'` inside a doubled literal reopens the quote.
sql_quote_literal() {
  local raw="$1"
  printf "'%s'" "${raw//\'/\'\'}"
}

# Percent-encode for the userinfo of a URL, RFC 3986 unreserved set kept.
#
# LC_ALL=C is what makes this BYTE-wise: without it `${raw:i:1}` yields a CHARACTER in the
# ambient locale and `printf "'%c"` yields its code point, so `ü` would be encoded as `%FC`
# (Latin-1) rather than the `%C3%BC` the UTF-8 bytes require, and decodeURIComponent would throw
# on it. Multibyte input is encoded one byte at a time, which is exactly what encodeURIComponent
# does.
url_encode_userinfo() {
  local raw="$1" out="" i c
  local LC_ALL=C LANG=C
  for (( i = 0; i < ${#raw}; i++ )); do
    c="${raw:i:1}"
    case "${c}" in
      [A-Za-z0-9._~-]) out+="${c}" ;;
      *) out+="$(printf '%%%02X' "'${c}")" ;;
    esac
  done
  printf '%s' "${out}"
}

# The inverse, and — for a URL this installer did NOT write — the same answer node-postgres
# reaches. `%XX` with two hex digits becomes that byte; anything else, including a `%` that is
# not followed by two hex digits, stays literal. That is not a simplification of the driver, it
# is what the driver does: pg-connection-string pre-encodes a malformed escape to `%25` before
# `new URL()` sees it, and decodeURIComponent then turns it back into a literal `%`.
# tests/scripts/install-credential-representation.test.ts asserts the two agree on 25 legacy
# spellings including `a%b`, `a%`, `a%2`, `a%zz`, `%%%`, `100%25pure`, `\back\slash` and — since
# r40 — `a%0A`, whose decoded form ends in the byte a command substitution deletes.
#
# THE ONE DIVERGENCE, STATED. decodeURIComponent THROWS on a `%XX` sequence that is not valid
# UTF-8 (`%FF`), where this returns the byte. A URL in that state cannot start the application at
# all — the driver refuses to parse it — so the recovered value is used only to answer "is this a
# rotation?", and the answer it gives (yes, because the two differ) is the safe one.
#
# The literal backslashes are protected BEFORE the `%XX` rewrite, so `printf '%b'` cannot
# interpret a `\b` or a `\0` that was part of the password.
url_decode_userinfo() {
  local raw="$1" escaped
  escaped="${raw//\\/\\\\}"
  # THE SED STEP IS A CAPTURE TOO (o3d-2sm1.5 r40, Codex HIGH). It is inside this function rather
  # than around it, so `capture` cannot reach it: a caller that hands in a userinfo containing a
  # LITERAL trailing newline would have it eaten here, one layer below the fix. No URL read out of
  # a `.env` line can be in that state — a line ends at the newline — but this function is the
  # inverse of the encoder and it should be the inverse for every input, not for the reachable
  # ones. Same sentinel, and it survives the substitution untouched because it contains no `%`.
  escaped="$(printf '%s%s' "${escaped}" "${CAPTURE_TERMINATOR}" | sed -E 's/%([0-9A-Fa-f]{2})/\\x\1/g')"
  escaped="${escaped%"${CAPTURE_TERMINATOR}"}"
  printf '%b' "${escaped}"
}

# THE ONE PLACE A DATABASE_URL IS COMPOSED. Both writers — the pre-stop classification and the
# rotation inside the fenced window — go through here, so the encoding cannot be right in one and
# missing in the other, which is the shape the r38 defect took.
compose_database_url() {
  local user="$1" password="$2" host="$3" port="$4" database="$5"
  printf 'postgresql://%s:%s@%s:%s/%s' \
    "$(url_encode_userinfo "${user}")" \
    "$(url_encode_userinfo "${password}")" \
    "${host}" "${port}" "${database}"
}

# THE ROUTE THE APPLICATION TAKES, AS THE libpq SETTING THAT REPRODUCES IT (o3d-2sm1.5 r43,
# Codex HIGH).
#
# THE FINDING. Every alignment through r42 used a PROBE as the reference point: the reader observed
# on libpq's `sslmode=prefer` and published what it got, and the psql probes were pinned to that.
# The probes then agreed with each other and with nothing else — because the connection this whole
# gate exists to vouch for is the APPLICATION'S, and the application does not use libpq at all.
#
# WHAT node-postgres DOES WITH THE URL compose_database_url() PRODUCES, MEASURED. Against the
# installed `pg` (8.20.0) and `pg-connection-string` (2.12.0), a URL with no query string parses to
# `ssl: undefined` and the driver's first bytes on the wire are the StartupMessage itself: NO
# SSLRequest, no GSSENCRequest. That is libpq's `sslmode=disable`, and it is matched by
# `hostnossl`/`host` records and never by a `hostssl` one.
#
# SO THE REFERENCE IS THE APPLICATION'S CONNECTION, AND EVERY OBSERVATION AND EVERY PROBE IS PUT ON
# IT. The alternative — emitting `?sslmode=require` in DATABASE_URL — was measured too and refused:
# on the installed pg-connection-string `require` is an ALIAS FOR verify-full (the driver says so
# itself, on stderr), so it would demand a CA-verified certificate where the reader deliberately
# verifies nothing and where a Debian cluster ships a self-signed one; there is no spelling of
# libpq's `prefer` at all; the meaning is scheduled to change under the driver's feet at pg v9; and
# it would change what EVERY EXISTING INSTALLATION's application connection does at the next
# upgrade, from a branch already deep in review.
#
# IT ASKS THE COMPOSER RATHER THAN ASSERTING A CONSTANT, so the two cannot drift: if a later round
# ever gives the emitted URL a query string, this stops answering rather than answering the old
# answer. The password is a placeholder because url_encode_userinfo() percent-encodes everything
# outside the RFC 3986 unreserved set — a `?` in a password reaches the URL as `%3F` — so no
# credential can put a query string there, and none is needed to ask this question.
db_application_route_sslmode() {
  local url
  url="$(compose_database_url "${DB_USER}" "irrelevant" "${DB_HOST}" "${DB_PORT}" "${DB_NAME}")"
  case "${url}" in
    *\?*) return 1 ;;
    postgresql://*) printf 'disable' ;;
    *) return 1 ;;
  esac
}

# WHAT "THE SAME SERVER" MEANS HERE, IN ONE PLACE, READ BY BOTH CONNECTIONS.
#
#   pg_postmaster_start_time()  the same microsecond stamp on every backend of one postmaster and
#                               a different one on any other. THE FENCE LIBRARY ALREADY USES
#                               EXACTLY THIS as its "are these two connections the same cluster?"
#                               test (assessUnrecordedRelease); this is that rule applied at the
#                               statement that produces the newness proof.
#   current_setting('port')     the port the server itself believes it is on, which is not the
#                               port we dialled and can disagree with it.
#   the database's oid          assigned by this server when the CREATE ran. Two clusters that
#                               both hold a database of this name will almost never agree on it,
#                               and it ties the identity to the OBJECT rather than to the server
#                               alone.
#
# WHY NOT system_identifier, which is the obvious candidate: a pg_basebackup clone INHERITS its
# origin's system identifier, so a clone and its origin — the two servers most likely to be
# running side by side on a box being cut over — are indistinguishable by it. It is also
# superuser-only (pg_control_system), and the endpoint connection is deliberately NOT a
# superuser, so it could not be compared even if it discriminated. The postmaster start time
# separates a clone from its origin; every field here is readable by an ordinary login role.
#
# All three are emitted as ONE marked line, so a psql notice or a wrapper's banner cannot be
# mistaken for the identity.
pg_server_identity_select() {
  cat <<'IMS_IDENTITY_SQL'
SELECT 'IMS_SERVER_IDENTITY '
       || current_setting('port') || ' '
       || (EXTRACT(EPOCH FROM pg_postmaster_start_time()) * 1000000)::bigint::text || ' '
       || coalesce((SELECT oid FROM pg_database WHERE datname = :'dbname')::text, 'absent')
IMS_IDENTITY_SQL
}

# The IMS_SERVER_IDENTITY line out of a psql run, and nothing else.
pg_extract_server_identity() {
  printf '%s\n' "$1" | grep -m1 '^IMS_SERVER_IDENTITY ' || true
}

# THE PROOF IS ABOUT THE SERVER THE MIGRATION WILL USE, OR IT IS NOT PROOF (o3d-2sm1.5 r37,
# Codex CRITICAL). Called with the identity read on the connection that performed the CREATE.
#
# It opens a SECOND connection — TCP, to the four values DATABASE_URL is composed from, which is
# the endpoint the application will use — and asks it the same question. Equal answers mean one
# postmaster, on the port this run will dial, holding the database object this run created.
# Anything else stops the run: a CREATE that landed somewhere else means the endpoint the
# migration is about to use holds a database this run did NOT create, which is the live database
# the fence exists for.
#
# WHY A THROWAWAY ROLE. The endpoint has to be reached as SOMEBODY, and at this point in the run
# there is deliberately no usable application credential: the role work now happens after
# cutover classification (see provision_database_role_and_privileges), precisely so that a
# refusal cannot land after a live role's password has been changed. So this creates a role that
# by construction nothing else uses, with a random password, reads one row as it, and drops it.
# It cannot collide with an existing role and it cannot alter one.
#
# AND IT IS DELIBERATELY NOT PINNED — RE-ARGUED AGAINST THE NEW REFERENCE POINT (r42, and r43,
# Codex HIGH). r42 bound every credential-bearing probe on the ROTATION path to the transport the
# authentication-request reader observed; r43 moved the reference from that reader to the
# APPLICATION'S own connection, which is `sslmode=disable`. This connection carries a credential
# and runs at a point where that route is perfectly well known, so the question was put a second
# time. The first half of the r42 answer survives the change; the second half did not, and is
# replaced:
#
#   * ITS CONCLUSION CANNOT BE FALSIFIED BY A TRANSPORT DIVERGENCE — UNCHANGED, AND IT IS THE
#     WHOLE ARGUMENT. What it asserts is that the postmaster answering ${DB_HOST}:${DB_PORT} is
#     the one the CREATE landed on, and it asserts it by comparing a start time, a port and a
#     database oid. Which pg_hba record admitted the connection does not change which postmaster
#     answered it, so falling back from TLS to the clear — or being let in by `trust` — changes
#     nothing about the identity that comes back. The rotation probes are pinned because their
#     conclusion is ABOUT the authentication; this one's is about the server behind it, and a pin
#     could therefore only change whether it CONNECTS, never what it concludes.
#   * WHAT r42 SAID SECOND WAS THAT PINNING WOULD MAKE IT LESS LIKE THE APPLICATION. That reason
#     is now the wrong way round and is withdrawn: since r43 "like the application" has a definite
#     value, `disable`, and pinning would make this connection MORE like it. It is still not
#     pinned, for the reason the first bullet gives plus one this function's failure mode makes
#     decisive: EVERY REFUSAL HERE IS A die(). It authenticates as a THROWAWAY ROLE, not as
#     ${DB_USER}, and pg_hba records may name a role — `hostnossl <db> imsuser ... scram` beside
#     `hostssl <db> all ... scram` is a legal and ordinary file. Under a pin that role-specific
#     layout turns a run that would have completed into a stopped install, and it would buy
#     nothing, because the identity that comes back is the same on either transport.
#
# The route the ROTATION uses is therefore left alone by this function: it neither reads
# DB_PROBE_SSLMODE nor sets it, and DB_ENDPOINT_ROUTE_SSLMODE is empty on every path into here.
verify_created_database_endpoint() {
  local created_identity="$1"
  local probe_role probe_password probe_output="" probe_identity="" status=0

  probe_role="ims_newness_probe_$(openssl rand -hex 6)"
  probe_password="$(openssl rand -hex 24)"

  # Hex by construction, so nothing here interpolates an operator-supplied byte into SQL, and
  # neither value reaches argv.
  pg_local_psql -q >/dev/null 2>&1 <<EOSQL || die "This run created database '${DB_NAME}' but could not create the throwaway role it verifies the connection with, so it cannot show that the database it created is on the server the migration will use. NOTHING HAS BEEN MIGRATED."
    CREATE ROLE "${probe_role}" LOGIN PASSWORD '${probe_password}';
EOSQL

  # THE SQL ARRIVES ON STDIN AND NOT THROUGH -c. psql performs NO variable interpolation on a
  # -c string — it is handed to the server verbatim — so `:'dbname'` would reach PostgreSQL as a
  # syntax error. On stdin it is psql that quotes the identifier and the literal, which is what
  # keeps an operator-supplied database name out of the SQL grammar.
  probe_output="$(pg_endpoint_psql "${probe_role}" "${probe_password}" "${DB_NAME}" \
    -q -tA -v dbname="${DB_NAME}" <<EOSQL 2>&1
$(pg_server_identity_select);
EOSQL
  )" || status=$?
  probe_identity="$(pg_extract_server_identity "${probe_output}")"

  pg_local_psql -q >/dev/null 2>&1 <<EOSQL || warn "The throwaway verification role ${probe_role} could not be dropped. Remove it by hand: DROP ROLE \"${probe_role}\";"
    DROP ROLE IF EXISTS "${probe_role}";
EOSQL

  if [[ "${status}" -ne 0 || -z "${probe_identity}" ]]; then
    die "This run created database '${DB_NAME}', but could not then reach ${DB_HOST}:${DB_PORT}/${DB_NAME} the way the application will, so it cannot show that the database it created is the one about to be migrated. The migration uses that same endpoint and would fail here too. NOTHING HAS BEEN MIGRATED. psql said: ${probe_output}"
  fi

  if [[ "${probe_identity}" != "${created_identity}" ]]; then
    die "THE DATABASE THIS RUN CREATED IS NOT ON THE SERVER IT IS ABOUT TO MIGRATE. CREATE DATABASE succeeded on the server that answered '${created_identity}' (postmaster start time, port and database oid), and ${DB_HOST}:${DB_PORT}/${DB_NAME} — the endpoint DATABASE_URL names — answered '${probe_identity}'. Those are different servers, so the CREATE proves nothing about the database about to be migrated, and that database is one this run did not create: it may have writers on it right now. A stray PGHOST/PGPORT/PGSERVICE in the invoking environment is the usual cause, and IMS_PG_SOCKET_DIR is the other. NOTHING HAS BEEN MIGRATED. An empty database was created on the other server and can be dropped."
  fi
}

# THE ONE STATEMENT IN THIS FILE THAT CAN SET DB_CREATED_BY_THIS_RUN (o3d-2sm1.5 r36, Codex
# CRITICAL). Called only on the INSTALL_POSTGRES=y path, which is the only path that creates
# anything at all.
#
# This step used to be one line inside the setup heredoc:
#
#   SELECT 'CREATE DATABASE x' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='x') \gexec
#
# which does the right thing and RECORDS NOTHING. It succeeds identically whether it created the
# database or found one already there, so the exemption downstream had no way to tell the two
# apart and read "no launcher on this host" as if it meant "no database before this run".
#
# So the statement is issued UNCONDITIONALLY and the server is allowed to answer:
#   exit 0                     -> this statement brought the database into being. PROOF, once
#                                 verify_created_database_endpoint() has shown it is proof about
#                                 the server the migration will use.
#   42P04 duplicate_database   -> it was already there. A supported outcome, not an error: the
#                                 install continues, it simply does not get the exemption.
#   anything else              -> indeterminate. The run stops, exactly as ON_ERROR_STOP did
#                                 before, rather than continuing over a database it cannot
#                                 describe.
#
# THE DUPLICATE IS RECOGNISED BY SQLSTATE, NOT BY ENGLISH (o3d-2sm1.5 r37, Codex HIGH). This used
# to match /already exists/i, which is a message the server localises: on a cluster with
# lc_messages set to anything but English, the ONE outcome that means "there is a live database
# here" was classified as indeterminate. `VERBOSITY=verbose` puts the SQLSTATE in the ERROR line
# itself, and 42P04 is the same five bytes in every locale.
create_database_and_record_newness() {
  local output="" status=0 created_identity=""
  # ONE SESSION, ON STDIN: the identity is read on the connection that performed the CREATE, and
  # ON_ERROR_STOP means the SELECT never runs if the CREATE did not. -c is not usable here —
  # psql does no variable interpolation on a -c string, so `:"dbname"` would reach the server as
  # a syntax error rather than as a quoted identifier.
  output="$(pg_local_psql -q -tA -v dbname="${DB_NAME}" <<EOSQL 2>&1
CREATE DATABASE :"dbname";
$(pg_server_identity_select);
EOSQL
  )" || status=$?
  if [[ "${status}" -eq 0 ]]; then
    created_identity="$(pg_extract_server_identity "${output}")"
    [[ -n "${created_identity}" ]] || die "CREATE DATABASE '${DB_NAME}' succeeded but the server did not answer the identity question on the same connection, so this run cannot say WHICH server it created that database on. NOTHING HAS BEEN MIGRATED. psql said: ${output}"
    verify_created_database_endpoint "${created_identity}"
    DB_CREATED_BY_THIS_RUN=true
    DB_CREATED_IDENTITY="${DB_HOST}:${DB_PORT}/${DB_NAME}"
    DB_CREATED_SERVER_IDENTITY="${created_identity}"
    DB_NEWNESS_FINDING="CREATE DATABASE was issued by this run on the server that answered '${created_identity}' and succeeded, and a connection opened to ${DB_HOST}:${DB_PORT}/${DB_NAME} the way the application opens its own answered with the same identity — so '${DB_NAME}' did not exist an instant before this run created it, on the server about to be migrated"
    success "Database '${DB_NAME}' was CREATED by this run — the server refused no duplicate, so it did not exist before."
    success "And it is the server the migration will use: the connection that created it and a connection to ${DB_HOST}:${DB_PORT} report the same postmaster, port and database oid."
    return 0
  fi
  if printf '%s' "${output}" | grep -q '42P04'; then
    DB_CREATED_BY_THIS_RUN=false
    DB_NEWNESS_FINDING="database '${DB_NAME}' already existed on this server — CREATE DATABASE was refused as a duplicate (SQLSTATE 42P04) — so this run did not create it and cannot say who else is using it"
    warn "Database '${DB_NAME}' already existed. This run did NOT create it, so it is treated as a live database and this run is fenced."
    return 0
  fi
  die "Creating database '${DB_NAME}' failed for a reason that is not SQLSTATE 42P04 duplicate_database, so this run cannot say whether that database exists, is reachable, or is safe to migrate. NOTHING HAS BEEN MIGRATED. psql said: ${output}"
}


# ---------------------------------------------------------------------------
# THE APPLICATION ROLE: WHAT MAY HAPPEN BEFORE THE RUN KNOWS IT MAY PROCEED, AND WHAT MAY NOT
# (o3d-2sm1.5 r37, Codex HIGH)
#
# Split in two, along exactly one line: whether the statement can take something away from a
# client that is using this database right now.
#
#   ensure_database_role_exists()              creates the role IF IT IS ABSENT. Nothing can be
#                                              connected as a role that does not exist, so this
#                                              is safe at any point, and the fence preflight
#                                              needs it to have happened.
#   provision_database_role_and_privileges()   grants on the database and moves its OWNER. Both
#                                              are felt by somebody else's connection, so neither
#                                              may run until this run has classified the cutover
#                                              and, on the fenced path, until
#                                              require_fenceable_database() has proved the window
#                                              can be held closed.
#   rotate_database_password_in_fenced_window() ALTERs the password of a role that WAS already
#                                              there. That is the one statement here which takes
#                                              a working credential AWAY from every client using
#                                              it, so it does not run on this side of the stop at
#                                              all — see below.
#
# AND THE PASSWORD IS NOT HERE AT ALL ANY MORE (o3d-2sm1.5 r38, Codex HIGH). r37 left the ALTER
# on this side of the stop and argued the boundary was as late as it could be: the build runs
# BEFORE the stop, deliberately, so that a release that will not compile costs no outage, and the
# build is handed DATABASE_URL. Rotating after the raise therefore seemed to hand the build a
# credential the server does not have.
#
# Both halves of that were wrong, and the second one is what made the first matter:
#
#   * THE DEFAULT SHOULD NEVER HAVE BEEN A ROTATION. The local-database prompt defaulted
#     DB_PASSWORD to `openssl rand -hex 16` — a NEW secret every run — so an operator pressing
#     Enter through an ordinary re-install rotated the live role's password as a side effect of
#     running the script. REDIS_URL and REDIS_PASSWORD had recovered their installed values for
#     rounds; DATABASE_URL had not. It does now, in prompt_db_password(), and a re-install that
#     changes nothing changes nothing.
#   * "THE BUILD NEEDS THE NEW CREDENTIAL" IS FALSE. The build needs a WORKING one. So when a
#     rotation IS asked for, DB_PASSWORD_EFFECTIVE — and therefore DATABASE_URL, .env and the
#     MIGRATION_DATABASE_URL handed to `prisma generate` and `npm run build` — stays the OLD,
#     installed credential for the whole pre-stop window, and rotate_database_password_in_fenced_window()
#     performs the ALTER after the service is stopped, the reboot fence is up and the connection
#     fence is raised, then rewrites the one DATABASE_URL line in .env. The build has a working
#     credential throughout and the predecessor keeps its own until it is no longer running.
#
# So what is left on this side is the GRANT and the OWNER change, and the r37 boundary still
# holds for those: NO refusal that says "nothing has been stopped and nothing has been migrated"
# may follow them, and after this call every remaining refusal is about THIS host's artefact —
# the build, BUILD_ID, the port still being bound — not about whether the run was allowed to
# touch the database at all.
#
# WHAT A FENCE CANNOT DO, STATED SO NOBODY READS MORE INTO IT. `ALTER USER ... PASSWORD` is
# CLUSTER-WIDE and the connection fence is DATABASE-SPECIFIC. Moving the rotation inside the
# window protects the clients of THIS database; a client of ANOTHER database on the same server
# authenticating as the same role is refused from its next connection onwards no matter where in
# this script the statement sits. That is why the rotation now happens only when an operator
# asks for it explicitly, and why it says so out loud when it does.
# ---------------------------------------------------------------------------

# Was the application role already on this server when this run arrived? Decided by the CREATE,
# on the same "let the server answer" principle as the database: a SELECT beforehand would be a
# statement about an instant, and the role can appear between the question and the statement.
DB_ROLE_PREEXISTED=false
# Set when this run has changed the password of a role it did not create, so a later banner can
# say so instead of claiming the box is untouched.
DB_ROLE_CREDENTIALS_ROTATED=false

# THE CREDENTIAL THE SERVER ALREADY HAS, AND WHETHER THIS RUN WAS ASKED TO REPLACE IT
# (o3d-2sm1.5 r38, Codex HIGH).
#
#   DB_PASSWORD_INSTALLED       the password the PREVIOUS run of this installer wrote into
#                               ${APP_DIR}/.env, recovered out of the DATABASE_URL there and only
#                               when that URL names the SAME role, host, port and database this
#                               run is about to use. Empty whenever it cannot be established.
#   DB_PASSWORD                 what this run was told to make the credential BE. On a re-install
#                               where the operator pressed Enter it IS DB_PASSWORD_INSTALLED, and
#                               nothing is rotated at all.
#   DB_PASSWORD_EFFECTIVE       the one the server has RIGHT NOW, which is what every connection
#                               this run opens before the rotation — the fence preflight, prisma
#                               generate, the build — has to be given.
#   DB_PASSWORD_ROTATION_PENDING  set when those two differ over a role this run did not create:
#                               a rotation was ASKED FOR and has NOT happened yet.
DB_PASSWORD_INSTALLED=""
DB_PASSWORD_EFFECTIVE=""
DB_PASSWORD_ROTATION_PENDING=false

ensure_database_role_exists() {
  local output="" status=0 quoted_password
  # THE PASSWORD IS A LITERAL, NOT A FRAGMENT OF SQL (o3d-2sm1.5 r39, Codex HIGH). `'${DB_PASSWORD}'`
  # ended the string literal on the first apostrophe the operator's password contained and read the
  # rest as statement text. The SET is issued on the same connection rather than assumed, because
  # doubling `'` is complete escaping only while backslashes are ordinary characters.
  quoted_password="$(sql_quote_literal "${DB_PASSWORD}")"
  output="$(pg_local_psql -q <<EOSQL 2>&1
    SET standard_conforming_strings = on;
    CREATE USER "${DB_USER}" WITH PASSWORD ${quoted_password};
EOSQL
  )" || status=$?
  if [[ "${status}" -eq 0 ]]; then
    DB_ROLE_PREEXISTED=false
    success "Role '${DB_USER}' was CREATED by this run — it did not exist before, so nothing was connected as it."
    return 0
  fi
  # 42710 duplicate_object: the role was already there. Recognised by SQLSTATE and not by the
  # message, for the reason 42P04 is: the message is localised, the SQLSTATE is not.
  if printf '%s' "${output}" | grep -q '42710'; then
    DB_ROLE_PREEXISTED=true
    info "Role '${DB_USER}' already exists on this server. Its password is NOT changed here: that is"
    info "deferred until this run has classified the cutover, so a refusal cannot land after it."
    return 0
  fi
  die "Creating the application role '${DB_USER}' failed for a reason that is not SQLSTATE 42710 duplicate_object, so this run cannot say whether that role exists or what it can do. NOTHING HAS BEEN MIGRATED and no password has been changed. psql said: ${output}"
}

# @install-phase: database-provision
#
# The mutating half, run only once the run knows it may proceed. Idempotent: on an ordinary
# re-install the GRANT and the OWNER change are already true and the ALTER sets the password to
# the value that is about to be written into .env.
provision_database_role_and_privileges() {
  [[ "${INSTALL_POSTGRES}" == "y" ]] || return 0

  # NO PASSWORD IS SET HERE, ON EITHER PATH (o3d-2sm1.5 r38, Codex HIGH). A role this run CREATED
  # already has the password the CREATE gave it; a role that was ALREADY THERE keeps the one its
  # clients are using, and an explicit rotation is performed by
  # rotate_database_password_in_fenced_window() after the predecessor has been stopped and the
  # connection fence raised. Nothing between here and that point can take a working credential
  # away from anybody.
  if ${DB_ROLE_PREEXISTED}; then
    if ${DB_PASSWORD_ROTATION_PENDING}; then
      info "Role '${DB_USER}' already existed and a DIFFERENT password was supplied, so a rotation is"
      info "PENDING. It is NOT performed here: the predecessor is still serving and the build has not"
      info "run. It happens inside the stopped, fenced window, and until then this run — and the"
      info "environment file it writes — uses the credential the server already has."
    else
      info "Role '${DB_USER}' already existed and keeps the password it already had: this run was not"
      info "asked to change it, so it does not. Nothing about its clients' credentials moves."
    fi
  fi

  # AND NOT WHILE A FENCE IS STANDING (o3d-2sm1.5 r37). `GRANT ALL PRIVILEGES ON DATABASE`
  # grants CONNECT, which is the ONE privilege the connection fence exists to take away — so
  # issuing it inside an adopted fence would re-open the door this run is holding shut, while
  # DB_FENCE_UP goes on saying the window is closed. `ALTER DATABASE ... OWNER TO` is skipped for
  # the same reason and not because it is harmless: changing the owner rewrites the owner's ACL
  # entry, and a role that was revoked can come back through it.
  #
  # Skipping costs nothing real. A fence can only be standing over a database this run did NOT
  # create — a previous run of this installer left it there — so the grant and the ownership are
  # already what this statement would set them to, and the fence's own release is what restores
  # what the fence revoked. The one thing above that IS still done is the password, which no
  # fence has an opinion about.
  if ${DB_FENCE_UP:-false}; then
    warn "A connection fence is standing over '${DB_NAME}', so this run is NOT issuing GRANT ALL PRIVILEGES or ALTER DATABASE ... OWNER: the GRANT would give CONNECT back and lift the fence this run is holding. The fence's release restores what it revoked. If '${DB_USER}' turns out not to own this database, release the fence and re-run."
    return 0
  fi

  pg_local_psql -q >/dev/null <<EOSQL || die "Granting '${DB_USER}' on database '${DB_NAME}' failed. NOTHING HAS BEEN MIGRATED."
    GRANT ALL PRIVILEGES ON DATABASE "${DB_NAME}" TO "${DB_USER}";
    ALTER DATABASE "${DB_NAME}" OWNER TO "${DB_USER}";
EOSQL
  success "Database '${DB_NAME}' and user '${DB_USER}' ready."
}

# @install-phase: credential-rotation
#
# THE ONE STATEMENT THAT TAKES A WORKING CREDENTIAL AWAY, AND THE ONLY WINDOW IN WHICH NOBODY IS
# HOLDING IT (o3d-2sm1.5 r38, Codex HIGH).
#
# Reached only from the fenced path, and only after ALL of: the reboot fence is installed, the
# crontab is fenced, `systemctl stop` has returned, the legacy launchers are stopped, the port is
# no longer bound, the connection fence is RAISED and check-db-writers.mjs has said there is no
# other backend on the database. Every one of those is asserted here rather than assumed, because
# this function's whole value is WHERE it runs: called a few lines earlier it is the r37 defect
# again, and a guard that cannot fail is not a guard.
#
# It is a no-op unless a rotation was explicitly asked for — a password that differs from the one
# ${APP_DIR}/.env already carried for this exact role, host, port and database.
rotate_database_password_in_fenced_window() {
  ${DB_PASSWORD_ROTATION_PENDING} || return 0

  [[ "${INSTALL_POSTGRES}" == "y" ]] || die "A database credential rotation was requested for '${DB_USER}', but this run does not manage a LOCAL PostgreSQL server, so it has no privileged local connection to issue ALTER USER over. Rotate the password on the database server by hand and re-run with the new value. NOTHING HAS BEEN MIGRATED."
  ${FENCE_ARMED} || die "A database credential rotation was requested for '${DB_USER}' and this run has not stopped anything, so rotating now would take the password away from a predecessor that is still serving — the defect this ordering exists to prevent. NOTHING HAS BEEN MIGRATED and the role's password is UNCHANGED."
  ${DB_FENCE_UP} || die "A database credential rotation was requested for '${DB_USER}' and the connection fence is NOT up, so a client can attach between now and the end of the migration and be refused mid-window. NOTHING HAS BEEN MIGRATED and the role's password is UNCHANGED."

  header "Rotating the database credential (stopped, fenced)"
  warn "This is a CLUSTER-WIDE change and the fence is DATABASE-specific: any OTHER client on this"
  warn "server authenticating as '${DB_USER}' — against any database — is refused from its next"
  warn "connection onwards. Nothing this installer can do makes that untrue; it is why the rotation"
  warn "happens only because a password different from the installed one was supplied."

  # THE RECORD GOES DOWN BEFORE THE DURABLE ACT, NOT AFTER IT (o3d-2sm1.5 r39, Codex HIGH). The
  # ALTER below COMMITS; everything that makes the new credential usable comes after it. Until
  # this journal is on the medium there is no interruption point between the two that the next run
  # can reconcile, because the only other record of the old password is the file this function is
  # about to replace. It carries BOTH candidates and it says what each outcome means — see the
  # journal's own block above.
  #
  # AND THE RECORD IS ONLY WORTH WRITING IF SOMETHING CAN READ IT BACK (o3d-2sm1.5 r40, Codex
  # HIGH). The journal's entire value is that the NEXT run can ask the server which of the two
  # candidates is live. That question is answerable only on an endpoint whose pg_hba rule actually
  # checks the password, and only on one the reconciliation will still be able to reach — and the
  # reconciliation runs with THIS fence still standing over '${DB_NAME}', so the application
  # database is disqualified by construction — which is exactly what db_unfenced_probe_candidates()
  # excludes. `postgres` leads that list because PUBLIC holds CONNECT on it by default and no fence
  # here touches it; the rest of the list is READ FROM THE SERVER, so a site that has hardened the
  # maintenance database still has somewhere this question can be asked.
  #
  # So it is proven here, BEFORE the ALTER, in three parts (r41 added the first of them): the
  # SERVER names the pg_hba method it matched and it is one that compares pg_authid.rolpassword;
  # the endpoint then refuses a random password; and it accepts the one this run knows is live.
  # The FIRST endpoint that does all three is the one recorded — an endpoint that cannot cannot be
  # relied on afterwards, and a rotation that would leave an unreconcilable journal is a rotation
  # this run must not perform. Refusing costs nothing — no ALTER has been issued.
  DB_PROBE_REPORT=""
  DB_ROTATION_PROBE_DATABASE=""
  local -a rotation_probe_candidates=()
  local rotation_probe_candidate
  db_unfenced_probe_candidates rotation_probe_candidates
  for rotation_probe_candidate in "${rotation_probe_candidates[@]}"; do
    if db_endpoint_is_password_sensitive "${rotation_probe_candidate}" "${DB_PASSWORD_EFFECTIVE}"; then
      DB_ROTATION_PROBE_DATABASE="${rotation_probe_candidate}"
      break
    fi
  done
  if [[ -n "${DB_ROTATION_PROBE_DATABASE}" ]]; then
    info "Rotation endpoint proven: on '${DB_ROTATION_PROBE_DATABASE}' the server itself named a"
    info "matched pg_hba method that compares pg_authid.rolpassword — the secret ALTER ROLE writes —"
    info "and that endpoint then refused a random 32-byte password and accepted the credential"
    info "'${DB_USER}' is holding right now. It is recorded in the journal and is what a next run"
    info "reconciles against — the application database is never it, because the fence stands over"
    info "that one."
  else
    # ONE PHYSICAL LINE, AND THE REPORT LAST. deploy-order.test.ts classifies every source line that
    # names an application-owned path, and a literal newline inside this string makes its second half
    # a separate line with no declared shape. Keeping ${DB_PROBE_REPORT} — which carries its own
    # leading newlines — at the very end is what keeps the sentence readable and the line singular.
    die "A database credential rotation was requested for '${DB_USER}', and this run cannot show that ANY unfenced endpoint would be able to tell afterwards which password the role has. The rotation is the one step here that has no undo, and its only safety net is a journal the next run reconciles by ASKING THE SERVER — so a probe that cannot refuse a password nothing knows, or cannot reach the role at all, or is not checking POSTGRESQL'S OWN role credential in the first place, turns that net into a guess. The application database '${DB_NAME}' cannot be that endpoint: the connection fence this run is holding revokes CONNECT on it, and a reconciliation runs with that fence still standing. THE ALTER HAS NOT BEEN ISSUED: '${DB_USER}' still has the credential ${APP_DIR}/.env names, the two agree, and starting the old service by hand would work. NOTHING HAS BEEN MIGRATED. Give the role a password-checked route to 'postgres': GRANT CONNECT ON DATABASE postgres TO that role, and a pg_hba.conf rule for ${DB_HOST} that is scram-sha-256 or md5. Those two are the only methods accepted, because they are the only ones that compare the secret ALTER ROLE writes: 'trust' checks nothing, and 'password', 'ldap', 'pam', 'radius' and 'bsd' all ask for a cleartext password over the same protocol message, so the four that consult an outside directory cannot be told from the one that does not — an answer from any of them may be about a credential this installer has no way to change. Then re-run; or rotate the password by hand and re-run supplying it. What this run asked, and what each endpoint did:${DB_PROBE_REPORT}"
  fi

  # Refusing here costs nothing: nothing has been ALTERed yet, so the sentence below is true.
  write_role_rotation_journal "${DB_PASSWORD_EFFECTIVE}" "${DB_PASSWORD}" "${DB_ROTATION_PROBE_DATABASE}" || die "A database credential rotation for '${DB_USER}' could not be journalled durably at ${DB_ROLE_ROTATION_JOURNAL}, so a run interrupted between the ALTER and the environment file would leave nothing able to say which password the server has. The ALTER has NOT been issued: the role still has the credential ${APP_DIR}/.env names, the two agree, and starting the old service by hand would work. NOTHING HAS BEEN MIGRATED. Make ${DB_ENV_SNAPSHOT_DIR} writable and re-run, or re-run without a password change."

  local quoted_password
  # THE PASSWORD IS A LITERAL, SQL-QUOTED (o3d-2sm1.5 r39, Codex HIGH). `'${DB_PASSWORD}'` ended
  # the literal on the first apostrophe and read the rest of the operator's password as statement
  # text — inside the one window in which nobody holds a working credential.
  quoted_password="$(sql_quote_literal "${DB_PASSWORD}")"
  pg_local_psql -q >/dev/null <<EOSQL || die "Rotating the password of the existing role '${DB_USER}' failed. The service is STOPPED and the connection fence is UP; the application environment file this run wrote still names the credential the server already had, so the two agree and starting the old service by hand would work. The rotation journal at ${DB_ROLE_ROTATION_JOURNAL} records both candidates and the next run reconciles from it. NOTHING HAS BEEN MIGRATED. Fix the role or re-run without a password change."
    SET standard_conforming_strings = on;
    ALTER USER "${DB_USER}" WITH PASSWORD ${quoted_password};
EOSQL

  DB_ROLE_CREDENTIALS_ROTATED=true
  DB_PASSWORD_ROTATION_PENDING=false
  DB_PASSWORD_EFFECTIVE="${DB_PASSWORD}"
  # The application connection is recomposed BEFORE the environment file is rewritten, so that
  # write_app_env_file() emits the credential the server now has. The two are set together, in
  # that order, and nothing between them can fail into a state where only one of them moved.
  DATABASE_URL="$(compose_database_url "${DB_USER}" "${DB_PASSWORD_EFFECTIVE}" "${DB_HOST}" "${DB_PORT}" "${DB_NAME}")"
  # AND THE WRITE IS CHECKED, because this is the point past which the flags above are lies if it
  # failed. The file is published by rename, so a failure leaves the PREVIOUS environment file
  # complete and naming the old password — which the server no longer has. That is the outage the
  # journal exists for, and the refusal says so and leaves the journal standing.
  write_app_env_file || die "The password of '${DB_USER}' HAS BEEN ROTATED on the server, and ${APP_DIR}/.env could not be replaced. That file is complete and unchanged — it is published by rename, so it is not truncated — but it names the OLD password, which no longer works. The service is STOPPED and the connection fence is UP. DO NOT hand-edit that file: re-run this installer and it will reconcile from the journal at ${DB_ROLE_ROTATION_JOURNAL}, which records both candidates; it will ask the server which one is live, find the new one, and publish an environment file naming it. NOTHING HAS BEEN MIGRATED."
  # LAST, so that a run killed anywhere above leaves a journal rather than none. A journal that
  # outlives the transition costs the next run one probe; a missing one costs the outage.
  clear_role_rotation_journal || die "The password of '${DB_USER}' has been rotated and ${APP_DIR}/.env names it — the two agree and the transition is COMPLETE — but the journal at ${DB_ROLE_ROTATION_JOURNAL} could not be removed durably. Delete it by hand; leaving it costs the next run one probe and nothing else. NOTHING HAS BEEN MIGRATED."
  success "The password of '${DB_USER}' has been rotated and ${APP_DIR}/.env now names it. The build ran before this, on the previous credential."
}

# THE EXEMPTION IS EARNED, NEVER INFERRED FROM WHAT IS ABSENT ON THIS HOST. Returns 0 only when
# this invocation itself created the database it is about to migrate, and only when that is the
# same database. Everything else — including everything unknown — returns 1, and the caller fences.
first_install_exemption_available() {
  local identity="${DB_HOST}:${DB_PORT}/${DB_NAME}"
  FIRST_INSTALL_EXEMPTION_REFUSAL=""
  if ! ${DB_CREATED_BY_THIS_RUN}; then
    FIRST_INSTALL_EXEMPTION_REFUSAL="No launcher was found on this host — but that is a statement about this host, not about the database: ${DB_NEWNESS_FINDING}. Other writers may be connected to ${identity} right now, so this run is treated as a cutover and the migration window is fenced."
    return 1
  fi
  if [[ "${DB_CREATED_IDENTITY}" != "${identity}" ]]; then
    FIRST_INSTALL_EXEMPTION_REFUSAL="This run created ${DB_CREATED_IDENTITY}, but it is about to migrate ${identity}. Proof about one database is not proof about another, so this run is treated as a cutover and the migration window is fenced."
    return 1
  fi
  return 0
}

# WHETHER THIS RUN IS A FIRST INSTALL, AND WHAT THAT FORBIDS (o3d-2sm1.5 r35, Codex MEDIUM).
#
# A first install has no service, no crontab, no PM2 instance and no process in ${APP_DIR} — that
# is what upgrade_in_place() asks — and it has just created the database it is about to migrate.
# There is no writer to stop, so there is no window to hold closed, so the fence helper is never
# executed and DEPLOY_ADMIN_DATABASE_URL is never handed to bytes out of this checkout. That is
# the POLICY, stated in docs/installation.md in those words, and this flag is what makes it a
# property of the code rather than a description of it: set on the first-install branch, and
# refused by resolve_fence_script() below, which is the sole route to executing the helper.
#
# It is an ENFORCEMENT and not a comment because the alternative is what the previous round
# shipped: a runbook asserting a requirement nothing checked. A later change that adds a fence
# call to this path now stops the install with the sentence below instead of quietly executing an
# unauthenticated artefact.
FIRST_INSTALL_NO_CREDENTIALED_FENCE=false

# THE FIRST-INSTALL PIN CONTRACT, WRITTEN ONCE AND DERIVED FROM HERE (o3d-2sm1.5 r36, Codex
# MEDIUM). The refusal below prints these exact bytes, docs/installation.md quotes them verbatim,
# and tests/scripts/fence-digest-and-first-install.test.ts asserts the two strings are identical.
# This branch has now shipped three pin contracts whose code, runbook and tests said different
# things; the fix is not a fourth sentence, it is one string with two readers.
FIRST_INSTALL_PIN_CONTRACT="On a first install, IMS_FENCE_ARTEFACT_SHA256 is the ONLY input that publishes the protected fence artefact. IMS_FENCE_SCRIPT_SHA256 alone is REFUSED here: it authenticates the entry file, while the artefact also vendors that helper's dependency closure out of the application-owned checkout. Supply IMS_FENCE_ARTEFACT_SHA256 -- IMS_FENCE_SCRIPT_SHA256 may accompany it and is then also enforced -- or supply neither, in which case this install fences nothing, publishes nothing, and the first upgrade asks for the digest instead."

resolve_fence_script() {
  local script
  if ${FIRST_INSTALL_NO_CREDENTIALED_FENCE}; then
    echo "This run is a FIRST INSTALL — no service, no crontab and no other launcher was found, and the database was created by this run — so it performs NO credentialed fence execution: there is no writer to drain and nothing to hold closed. Something on this path asked for the fence helper anyway, and it will not be handed DEPLOY_ADMIN_DATABASE_URL: the tree it would run is assembled out of an application-owned checkout, and a first install is exactly the run with no standing artefact to authenticate it against. Nothing has been migrated." >&2
    return 1
  fi
  script="$(db_fence_script_in_use)" || return 1
  db_fence_publish_operator_wrappers "${APP_USER}" "${APP_DIR}/.env" "${DB_FENCE_STATE}" \
    "${DB_FENCE_IDENTITY_ARGS[@]:-}" \
    || echo "The recovery wrappers at ${DB_FENCE_RELEASE_WRAPPER} and ${DB_FENCE_REFENCE_WRAPPER} could not be refreshed for this run. Anything printed below that names them may be a previous run's copy; check it before running it." >&2
  printf '%s' "$script"
}
require_db_identity() {
  [[ "${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]] && return 0
  return 1
}

# ---------------------------------------------------------------------------
# WHAT A FIRST INSTALL DOES ABOUT THE FENCE — ONE POLICY, ENFORCED (o3d-2sm1.5 r35, Codex MEDIUM).
#
# THE DEFECT. r34 made IMS_FENCE_ARTEFACT_SHA256 a required input and said so on the first command
# in docs/installation.md: "required on an ordinary install and the run refuses without it". The
# code did no such thing. require_fenceable_database() and resolve_fence_script() are reached only
# inside the upgrade branch, so on a first install the variable was read by the library, compared
# against nothing, and ignored: omitting it produced no refusal, supplying it published no
# artefact, and the first later cutover discovered that the authenticated bootstrap was still
# outstanding. A runbook asserting a requirement the code ignores is the same defect as a comment
# describing behaviour the code does not have, and this branch has now shipped it three times.
#
# THE POLICY, CHOSEN ON THE MERITS AND STATED IN THE RUNBOOK IN THESE WORDS:
#
#   A FIRST INSTALL PERFORMS NO CREDENTIALED FENCE EXECUTION.
#
# It is what is actually true and it is what should be true. upgrade_in_place() returning false
# means no unit, no crontab entry, no PM2 instance and no process in ${APP_DIR}; the database was
# created by this run moments ago. There is no writer to stop, so there is no window to hold
# closed, so nothing is fenced and the helper — whose whole risk is that it is executed with
# DEPLOY_ADMIN_DATABASE_URL beside it — is never executed at all. REQUIRING a pin for an execution
# that does not happen is theatre, and it is the "refusal whose precondition nobody can satisfy"
# shape this round is explicitly under instructions to avoid: it would stop every first install on
# a fresh box until the operator had gone and found a release digest, and buy nothing.
#
# So the pin is NOT required here, and the runbook no longer says it is.
#
# BUT IT IS NOT IGNORED EITHER, because a supplied value that nothing reads is the defect in its
# other form. When the operator does pass one — they have it, it ships with the release, and they
# will need it on the first upgrade — this run PUBLISHES the artefact under it, before the
# migration. That is a read and a copy performed by root; nothing is executed, so it is safe on
# exactly the reasoning above, and it means the first cutover finds a standing, authenticated
# artefact instead of discovering the bootstrap is still outstanding at the worst moment. A pin
# that does NOT authenticate this checkout is a REFUSAL and never a warning: it is the operator
# saying which bytes they expect, over bytes the application account owns.
#
# AND THE NO-EXECUTION HALF IS A FLAG, NOT A COMMENT. resolve_fence_script() is the sole route to
# executing the helper in this file, and it refuses while this is set.
first_install_fence_policy() {
  # THE PREMISE, ASSERTED WHERE IT IS SPENT (o3d-2sm1.5 r36, Codex CRITICAL). The caller already
  # routes an unproven database to the fenced path; this is the same question asked again at the
  # one function that ARMS the exemption, so a later edit that reaches here on an unproven
  # database stops the install instead of quietly exempting a live database from the fence. It is
  # the same "enforcement, not comment" discipline the no-execution flag below is written in.
  first_install_exemption_available || die \
    "This run was about to take the first-install exemption from the cutover fence and it has not earned it. ${FIRST_INSTALL_EXEMPTION_REFUSAL} NOTHING HAS BEEN MIGRATED and nothing has been started."

  FIRST_INSTALL_NO_CREDENTIALED_FENCE=true

  # THE PIN CONTRACT, ENFORCED (o3d-2sm1.5 r36, Codex MEDIUM).
  #
  # THE DEFECT. The runbook offered EITHER pin as a first-install publication input and this
  # function treated either as a publication request — but the artefact is assembled out of
  # ${APP_DIR}, which this installer chowns to ${APP_USER} long before it gets here, so the source
  # is application-writable on every install this script performs. _fence_stage_and_publish()
  # refuses an entry-file pin from such a source, by design and correctly: it authenticates one
  # file out of a vendored closure. The advertised script-pin-only invocation could therefore not
  # publish on ANY ordinary first install — it deterministically aborted one.
  #
  # WHY THE RULE IS UNCONDITIONAL RATHER THAN "when the checkout is application-writable". On this
  # path it is always application-writable — the chown guarantees it — and a condition that is
  # always true is one that can go stale unnoticed while inviting the reader to believe there is a
  # supported case on the other side of it. There is not. Stating it unconditionally is also what
  # lets the runbook and the tests say the SAME SENTENCE as the code: see
  # ${FIRST_INSTALL_PIN_CONTRACT}, which is that sentence and is defined once.
  #
  # AND IT IS A REFUSAL, NOT A SILENT SKIP. A supplied pin nobody reads is this branch's signature
  # defect; the operator named the bytes they expected and is owed an answer.
  if [[ -n "${DB_FENCE_EXPECTED_SHA256}" && -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    die "${FIRST_INSTALL_PIN_CONTRACT} NOTHING has been published, NOTHING HAS BEEN MIGRATED and nothing has been started. The closure this run would have vendored comes from ${APP_DIR}, which this installer has already chowned to ${APP_USER}, so it comes from an account other than the one publishing it. ${DB_FENCE_ARTEFACT_SOURCE_TEXT}"
  fi

  # Reaching here with no whole-tree pin means no pin at all: the refusal above is the only other
  # way out of it.
  if [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    info "First install: nothing is serving, no crontab is live and this run created the database,"
    info "so there is no writer to stop and no migration window to fence. NO fence helper is"
    info "executed on this path and no protected artefact is published."
    info "IMS_FENCE_ARTEFACT_SHA256 is therefore NOT required here, and was not supplied. The FIRST"
    info "UPGRADE of this box does require it — that run fences a real window — so obtain it with"
    info "the release (bash scripts/update.sh --print-fence-digest on a clean checkout of the tag)"
    info "and pass it then, or pass it to this installer to have the artefact published now."
    return 0
  fi

  header "Publishing the protected fence artefact (pinned on this invocation)"
  info "A first install fences nothing, so this publishes rather than executes: the artefact is"
  info "assembled from this checkout by root, authenticated against the digest on the invocation,"
  info "and left standing so the first upgrade cutover has one already."
  publish_fence_script_copy || die \
    "The protected fence artefact could not be published under the digest this invocation supplied: ${DB_FENCE_ROTATION_NOTE:-no reason was recorded}. A pin names the bytes you expect, so this is a refusal and not a warning. NOTHING HAS BEEN MIGRATED and nothing has been started; re-run with a digest that matches this release, or with neither pin, in which case this install fences nothing, publishes nothing and the first upgrade asks for the digest instead."
  if [[ -n "${DB_FENCE_ROTATION_NOTE}" ]]; then info "${DB_FENCE_ROTATION_NOTE}"; fi
  success "The protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} is standing and authenticated."
  return 0
}
# Is the reboot fence ACTUALLY loaded by systemd right now? Distinct from FENCE_ARMED, which
# only says this run has stopped something: the failure banner used to describe a drop-in that
# may never have been installed (o3d-2sm1.5, Codex r4 HIGH).
REBOOT_FENCE_INSTALLED=false
# Rollback bookkeeping for install_reboot_fence(): what THIS call created, so a failure can
# remove exactly that and leave an already-standing fence alone.
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
# Whether THIS run published the environment snapshot. It gates the tolerance in
# env_file_is_sole_database_url_source(): a snapshot the unit loads that this run did not
# publish is an unexplained pin, and is refused rather than accepted.
DB_ENV_SNAPSHOT_PUBLISHED=false
DB_ENV_SNAPSHOT_DROPINS_CREATED=()
# Why the composed unit was refused, when it was.
DB_IDENTITY_SOURCE_REASON=""
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
# OWNERSHIP AND MODE ARE PART OF THE PUBLICATION, NOT A STEP AFTER IT (o3d-2sm1.5 r39, Codex
# HIGH). ${APP_DIR}/.env has to reach the application account readable, and a `chown` issued AFTER
# the rename is a second observable state: a crash between the two leaves a complete, correct file
# the application cannot open. Both are applied to the TEMPORARY file, before the barrier and
# before the rename, so the name is published once and everything about it is already true.
# `$2` and `$3` are optional and default to what every earlier caller already got: root's own
# ownership, since this script runs as root, and mode 0600.
publish_durable_file() {
  local target="$1" owner="${2:-}" mode="${3:-600}" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod "$mode" "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if [[ -n "$owner" ]] && ! chown "$owner" "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
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
# ---------------------------------------------------------------------------
# THE ROTATION JOURNAL: WHAT THE NEXT RUN IS TOLD, AND WHAT IT DOES ABOUT IT
# (o3d-2sm1.5 r39, Codex HIGH).
#
# THE DEFECT. `ALTER USER ... WITH PASSWORD` COMMITS. Everything that made the new credential
# usable came after it and none of it was durable: two in-memory flags, a recomposed
# DATABASE_URL, and a `cat > ${APP_DIR}/.env` that TRUNCATED the only environment file the
# application has before writing a byte of the replacement. A SIGKILL, a power loss, an ENOSPC or
# a refused chown anywhere in that sequence left PostgreSQL holding the new password while `.env`
# held the old one — or held nothing. The service is stopped and the database is fenced at that
# moment, so the operator's only move is to re-run, and the re-run read the stale `.env`, believed
# the old password was installed, and either did nothing or refused. The window is short and the
# outage it produces is not.
#
# IT IS THIS BRANCH'S OWN DOCTRINE, APPLIED WHERE IT WAS MISSING. The fence recovery record exists
# because "a record written after the durable act is absent on the run that is killed in between".
# The rotation did the durable act first.
#
# SO: A JOURNAL BEFORE THE ALTER, AND IT SAYS WHAT TO DO — not merely that something happened.
# A journal that records a fact without telling the next run how to reconcile it is half the fix.
# It carries BOTH candidate passwords, so the next run does not have to guess which of them the
# server has: it ASKS THE SERVER, which is the only party that knows, and every outcome below is
# decided by that answer rather than by inferring one from what is present on disk.
#
#   THE THREE INTERRUPTION POINTS, AND WHAT RECONCILES EACH
#
#   (1) THE JOURNAL IS WRITTEN AND THE `ALTER` HAS NOT RUN.
#       The server still has the OLD password and ${APP_DIR}/.env still names it; the two agree
#       and nothing is broken. The next run's probe finds the OLD password live, offers it as the
#       installed credential, rewrites `.env` with it — the same bytes — and clears the journal.
#       If the operator supplies the new password again, that is an ordinary pending rotation and
#       it happens in the fenced window as it should have the first time.
#
#   (2) THE `ALTER` HAS RUN AND `.env` HAS NOT BEEN PUBLISHED.
#       This is the outage. The server has the NEW password; `.env` names the OLD one, complete
#       and untruncated — publish_durable_file() renames, so no partial state is reachable. The
#       next run's probe finds the NEW password live and treats IT as the installed credential in
#       place of what `.env` says; the run's own pre-build `write_app_env_file` therefore
#       publishes an environment file naming the credential the server actually has, and the
#       journal is cleared only after that publication has returned success. FINISHING the
#       transition, which is the only direction that is safe: the old password is gone from the
#       server and this script will not put it back.
#
#   (3) BOTH ARE DONE AND THE RUN DIED BEFORE THE JOURNAL WAS CLEARED.
#       Indistinguishable from (2) to the probe, and it does not need to be distinguished: the
#       answer is the same. The probe finds the NEW password live, `.env` already names it, the
#       rewrite is byte-identical and the journal is cleared. The journal is removed LAST for
#       exactly this reason — a spurious journal costs one probe, a missing one costs the outage.
#
#   (4) NEITHER PASSWORD AUTHENTICATES.
#       Somebody rotated the role out of band, or the server is unreachable. The run REFUSES,
#       before it has prompted for anything else and before anything is stopped, and it leaves the
#       journal in place: this script cannot tell those two apart and guessing is how a credential
#       gets lost. The refusal prints the journal path and both psql answers.
#
# WHERE IT LIVES. /etc/ims-cutover, not ${CUTOVER_STATE_DIR}: the cutover state directory is the
# application's own data directory and therefore WRITABLE BY THE APPLICATION USER, and a record
# that says which password to install is not a record that account may edit. The directory is a
# literal for the reason DB_ENV_SNAPSHOT_DIR is one — a privileged path resolved from a variable
# the application can set is not a privileged path.
#
# The file is created by this script, which refuses to run as anything but root, and
# publish_durable_file() gives it mode 0600 before the rename — so it is root-owned and 0600 from
# the instant its name exists.
# ---------------------------------------------------------------------------
DB_ROLE_ROTATION_JOURNAL="${DB_ENV_SNAPSHOT_DIR}/db-role-rotation.journal"
# Set by reconcile_interrupted_role_rotation() when it found a journal and established, from the
# server, which of the two credentials is live.
DB_ROTATION_JOURNAL_FOUND=false
DB_ROTATION_RECONCILED_PASSWORD=""
# `new` or `old` — which of the journal's two candidates the discriminating endpoint accepted.
DB_ROTATION_RECONCILED_WHICH=""

# Base64 because a password may contain anything, including the `=` and the newlines that a
# key=value file cannot carry. `base64 -w0` is coreutils; `tr -d '\n'` keeps it honest anywhere.
rotation_journal_encode() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

rotation_journal_decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null
}

# One key, first occurrence, read WITHOUT sourcing: this file names two passwords and sourcing it
# would execute whatever a `$(` in one of them spelled.
role_rotation_journal_value() {
  local key="$1"
  [[ -f "${DB_ROLE_ROTATION_JOURNAL}" ]] || return 1
  sed -n "s/^${key}=//p" "${DB_ROLE_ROTATION_JOURNAL}" 2>/dev/null | head -1
}

# The four values that make a credential a credential, in the spelling the refusals print.
role_rotation_identity() {
  printf '%s@%s:%s/%s' "${DB_USER}" "${DB_HOST}" "${DB_PORT}" "${DB_NAME}"
}

write_role_rotation_journal() {
  local old_password="$1" new_password="$2" probe_database="${3:-}"
  mkdir -p "${DB_ENV_SNAPSHOT_DIR}" || return 1
  chmod 700 "${DB_ENV_SNAPSHOT_DIR}" 2>/dev/null || return 1
  # `marker_complete=1` is written LAST, so a reader that does not find it is looking at bytes no
  # publication produced — see read_role_rotation_journal(). publish_durable_file() renames, so
  # that can only be a hand-made file, and this script says so rather than guessing at it.
  {
    printf '# One Two Inventory — an application role password rotation is IN FLIGHT.\n'
    printf '# Written by scripts/install.sh BEFORE the ALTER, removed only after the matching\n'
    printf '# %s/.env has been durably published. If this file exists, a run was interrupted\n' "${APP_DIR}"
    printf '# between those two points; the next install run reconciles it by asking the server\n'
    printf '# which of the two passwords below is live. Do not edit it by hand.\n'
    printf 'journal_version=2\n'
    printf 'identity=%s\n' "$(role_rotation_identity)"
    printf 'env_file=%s\n' "${APP_DIR}/.env"
    # THE ENDPOINT THIS RUN PROVED COULD DISCRIMINATE (o3d-2sm1.5 r40, Codex HIGH). Written so the
    # reconciliation asks the SAME place rather than deriving one of its own, and so an operator
    # reading this file by hand knows which pg_hba rule the answer depends on. It is `postgres`
    # for every rotation this installer performs, and it is recorded rather than assumed because
    # a value that is derived twice is a value that can be derived differently twice.
    printf 'probe_database=%s\n' "${probe_database}"
    printf 'old_password_b64=%s\n' "$(rotation_journal_encode "${old_password}")"
    printf 'new_password_b64=%s\n' "$(rotation_journal_encode "${new_password}")"
    printf 'marker_complete=1\n'
  } | publish_durable_file "${DB_ROLE_ROTATION_JOURNAL}" || return 1
  return 0
}

clear_role_rotation_journal() {
  [[ -e "${DB_ROLE_ROTATION_JOURNAL}" ]] || return 0
  rm -f "${DB_ROLE_ROTATION_JOURNAL}" || return 1
  # The unlink needs the same directory barrier the rename got, or a power loss can restore the
  # name and the next run reconciles a rotation that is already finished. That is harmless — case
  # (3) — but a durability claim this script does not have is not one it should make.
  fsync_path "${DB_ENV_SNAPSHOT_DIR}" || return 1
  return 0
}

# ---------------------------------------------------------------------------
# AND A PROBE THAT CAN SAY NO IS NOT EVIDENCE EITHER, UNTIL IT SAYS WHOSE PASSWORD IT CHECKED
# (o3d-2sm1.5 r41, Codex HIGH)
# ---------------------------------------------------------------------------
#
# THE DEFECT r40 LEFT. The negative control below proves an endpoint discriminates BETWEEN
# PASSWORDS. It does not prove the password it discriminates on is POSTGRESQL'S ROLE CREDENTIAL,
# which is the only thing `ALTER ROLE ... PASSWORD` changes. `pg_hba.conf` has password-dependent
# methods that consult somebody else's store — `ldap`, `pam`, `radius`, `bsd` — and under every one
# of them both halves of the control behave exactly as a healthy scram endpoint would:
#
#   `postgres` authenticates through RADIUS while '${DB_NAME}' uses scram. Before the rotation the
#   RADIUS endpoint accepts the credential `.env` names and refuses the random control, so it is
#   admitted and recorded. The run dies after the ALTER. The next run re-proves that same endpoint,
#   RADIUS still accepts only the OLD password — it never heard of the ALTER — so the
#   reconciliation concludes the ALTER did not commit, publishes the OLD password and CLEARS THE
#   JOURNAL. The application database now wants the NEW one. The service cannot connect and the
#   evidence for recovering it has been deleted.
#
# THE FIX IS TO STOP INFERRING THE METHOD AND ASK FOR IT. An endpoint is admitted only when the
# SERVER ITSELF named a matched rule that checks `pg_authid.rolpassword`, and the server names it
# in the ordinary v3 startup exchange: it performs its own pg_hba match and announces the
# consequence as an Authentication request message, which is one value for `scram-sha-256`/`md5`
# and a different value for everything else. lib/pg-auth-request.mjs reads that one message and
# exits 0 only for the two, sending no password at all. Its header documents the mapping, the two
# routes that were measured and rejected (`pg_hba_file_rules` is a rule LISTING and not a match;
# libpq's `require_auth` does not exist before libpq 16), and what the answer does not cover.
#
# WHAT THIS ESTABLISHES: that the secret this endpoint is about to compare is the one ALTER ROLE
# writes, for this role, on this database, from this address, over this transport.
#
# WHAT IT DOES NOT: it cannot admit the `password` method — cleartext compared against the role's
# own secret — because on the wire that is the same message `ldap` sends, and it must be: an
# external verifier can only be consulted with the plaintext. Refusing it is a deliberate
# narrowing, and the refusal below says so and says what to change.
#
# ---------------------------------------------------------------------------
# TWO CORRECT INSTRUMENTS, ONE WRONG CONCLUSION, BECAUSE NOTHING PINNED THEM TO THE SAME ROUTE
# (o3d-2sm1.5 r42, Codex HIGH)
# ---------------------------------------------------------------------------
#
# THE DEFECT r41 LEFT. The method proof and the negative control were kept side by side on the
# grounds that each covers the other's gap. They were also asking about DIFFERENT TRANSPORTS, and
# there is a cluster on which both pass and the answer is still false:
#
#   `hostssl  all all <host> scram-sha-256`
#   `hostnossl all all <host> radius`        — over a directory holding the role's CURRENT password
#
#   The reader negotiates TLS, stops at the hostssl record and reports `scram-sha-256`. Honestly:
#   that IS the record it matched. The credential probe then runs under libpq's default
#   `sslmode=prefer`, which does not mean "use TLS" — it means try TLS, AND IF THAT CONNECTION
#   FAILS, RETRY WITHOUT IT. The random control fails SCRAM over TLS, drops to the clear, and is
#   REFUSED by RADIUS too — so the control's NO is satisfied, by the wrong record. The asserted
#   password succeeds over TLS, so its YES is satisfied by the right one. Both instruments pass.
#   After the ALTER and an interruption the two records disagree: the NEW password authenticates
#   over TLS, and the OLD one fails there, falls back, and is ACCEPTED by the directory. The
#   reconciliation sees both candidates accepted, refuses — correctly, given what it was shown —
#   and a recoverable installation is left needing a person.
#
# THE FIX IS TO REMOVE THE DIVERGENCE, NOT TO ADD A THIRD CHECK. Three mechanisms that can
# disagree are worse than two. lib/pg-auth-request.mjs now REPORTS THE ROUTE IT TOOK, as the libpq
# setting that reproduces it — `sslmode=require` when TLS was negotiated, `sslmode=disable` when it
# was not — and every credential-bearing connection this run then opens to that endpoint is pinned
# to that value, with `gssencmode=disable` beside it because GSSAPI encryption is a third transport
# libpq will otherwise negotiate on its own. `prefer` appears in no probe. An authentication
# failure now has no second record to select, so the method the reader read is the method the
# password is checked by.
#
# WHAT THE NEGATIVE CONTROL IS STILL FOR, having lost that job. It is kept, and not out of
# caution — it is the only thing that catches two live cases:
#
#   THE POSITIVE HALF is the only instrument here that authenticates at all. The reader never
#   does, so it cannot tell a healthy scram endpoint from one where '${DB_USER}' has no CONNECT —
#   and THIS INSTALLER'S OWN FENCE REVOKES CONNECT on '${DB_NAME}'. Without the YES, "refused
#   everything" would read as password-sensitivity and a fenced endpoint would be admitted.
#   THE NEGATIVE HALF still catches a route that announces `scram-sha-256` and then accepts
#   anything. Pinning closes the transport divergence; it cannot close a pg_hba RELOAD between the
#   two connections, and it says nothing about a pooler or proxy on ${DB_HOST}:${DB_PORT} that
#   speaks SASL itself without verifying. Both end with a password nothing can know being accepted
#   on the pinned route, which is exactly what the control watches for. There is a regression that
#   reloads pg_hba between the reader and the probe and requires the control to refuse.
#
# THE ORDER IS METHOD FIRST, AND THAT IS NOT AN OPTIMISATION. The positive half of the control
# sends the application role's real password to the endpoint. Running it before the method is
# known is handing that credential to a directory server this run has not yet established is not
# involved. It is also what pins the route: until the reader has spoken there is no transport to
# bind to, and a probe with no route REFUSES rather than falling back to libpq's default.
#
# ---------------------------------------------------------------------------
# A PROBE THAT CANNOT SAY NO IS NOT EVIDENCE (o3d-2sm1.5 r40, Codex HIGH)
# ---------------------------------------------------------------------------
#
# THE DEFECT. `db_password_authenticates` opened a connection with a candidate password and read
# a successful `SELECT 1` as PROOF that the role holds it. That inference is only valid where the
# server actually checks the password, and `pg_hba.conf` decides that per database, per host and
# per role:
#
#   * a `trust` rule on the endpoint accepts EVERY password, so the probe cannot fail. It then
#     "proves" whichever candidate was tried first — `new` — and the reconciliation publishes a
#     `.env` naming a password the ALTER may never have set. That is the r39 outage with the
#     recovery mechanism supplying it.
#   * the CONVERSE is just as bad: an endpoint that refuses the SESSION rather than the password —
#     a revoked CONNECT, and THE STANDING CONNECTION FENCE IS EXACTLY THAT over ${DB_NAME} — fails
#     for a role holding precisely the right credential, so both candidates read as dead and an
#     automatically recoverable installation is stranded.
#
# THE FIX IS A NEGATIVE CONTROL, and it is the whole of the fix. An endpoint is admitted as
# evidence only once it has been shown, in this run, on this endpoint, that it can say BOTH words:
#
#   NO   a freshly minted random 32-byte password is REFUSED. Nothing knows that password, so an
#        endpoint that accepts it accepts anything.
#   YES  a password we are asserting IS live is ACCEPTED. Without this half, "refused everything"
#        would pass as password-sensitivity — and a revoked CONNECT refuses everything.
#
# Only an endpoint that has done both is allowed to answer the question, and the endpoint that did
# is RECORDED — in the journal by the rotating run, and in DB_ROTATION_PROBE_DATABASE by the run
# that reconciles — so the answer and the proof are about the same place rather than two
# separately-derived ones.
#
# AND IT MUST BE UNFENCED. An interrupted rotation leaves the connection fence STANDING over
# ${DB_NAME}, so the application database is the one endpoint guaranteed to be useless when the
# reconciliation needs it. `postgres` is the maintenance database every PostgreSQL cluster has,
# PUBLIC holds CONNECT on it by default, and this installer's fence never touches it — so it is
# the endpoint a rotation must prove BEFORE it commits, and the first one a reconciliation tries.
#
# WHERE AN UNKNOWN LANDS. Every path below that cannot be shown password-sensitive REFUSES. That
# is this branch's standing rule and it costs nothing on either side: the rotation refuses before
# the ALTER, so the role still has the credential its clients hold, and the reconciliation refuses
# before anything is stopped, with the journal left in place carrying both candidates.

# THE ROUTE THE READER OBSERVED, AND THE ENDPOINT IT OBSERVED IT ON (o3d-2sm1.5 r42, r43).
#
# Set together by db_endpoint_checks_role_verifier() and cleared together by it, so that a route
# proven for one database can never be spent on another. Empty means no reader has spoken, and
# every credential-bearing probe below REFUSES on that rather than opening a connection libpq gets
# to route for itself.
#
# SINCE r43 THIS IS THE APPLICATION'S ROUTE. The reader is told to take it (see
# db_application_route_sslmode()) and its answer is checked back against it, so what is published
# here is not "what libpq happened to negotiate" but "what node-postgres does with the URL this run
# will write". Every probe below therefore runs on the transport the application runs on, which is
# the connection all of this exists to vouch for.
DB_PROBE_ROUTE_DATABASE=""
DB_PROBE_SSLMODE=""

# Does this endpoint let ${DB_USER} in with these bytes? The verdict is the EXIT STATUS of a
# `SELECT 1` and never a match on the server's message, which is localised by lc_messages.
#
# IT GOES OUT ON THE APPLICATION'S ROUTE OR IT DOES NOT GO OUT (r42, r43) — which is the route the
# reader was told to take and reported back. The pin is set in a SUBSHELL: a
# `VAR=x function` prefix would survive the call — bash keeps such an assignment after a FUNCTION
# invocation — and a route left set is a route the next endpoint would inherit.
db_endpoint_accepts_password() {
  local database="$1" password="$2"
  [[ -n "${DB_PROBE_SSLMODE}" && "${DB_PROBE_ROUTE_DATABASE}" == "${database}" ]] || return 1
  (
    DB_ENDPOINT_ROUTE_SSLMODE="${DB_PROBE_SSLMODE}"
    pg_endpoint_psql "${DB_USER}" "${password}" "${database}" -tAc 'SELECT 1'
  ) >/dev/null 2>&1
}

# The endpoint that was PROVEN able to discriminate, and the sentence explaining every endpoint
# that was not. Read by the refusals so an operator is told which rule to look at.
DB_ROTATION_PROBE_DATABASE=""
DB_PROBE_REPORT=""

# WHERE THE AUTHENTICATION-REQUEST READER LIVES (o3d-2sm1.5 r41, Codex HIGH).
#
# ${IMS_SCRIPT_LIB_DIR} is THIS SCRIPT'S OWN lib directory, resolved from BASH_SOURCE at startup —
# the release being installed, not ${APP_DIR}. That distinction is the whole of r31's finding and
# it is why db-fence-protected.sh is sourced from there; this helper is held to the same rule. It
# is also handed NO credential of any kind: it reads one message and drops the connection, so even
# the hazard that made the fence helper's provenance load-bearing does not arise here.
#
# IMS_AUTH_REQUEST_PROBE exists for the regressions, which run the shipped functions outside the
# shipped file and so have no BASH_SOURCE to resolve from. It cannot weaken anything: pointing it
# somewhere else does not produce an exemption, it produces the refusal below.
db_auth_request_probe_path() {
  printf '%s' "${IMS_AUTH_REQUEST_PROBE:-${IMS_SCRIPT_LIB_DIR:-}/pg-auth-request.mjs}"
}

# THE MATCHED METHOD, AS THE SERVER STATED IT — AND THE ROUTE IT WAS STATED ON.
#
# Returns 0 only when the rule PostgreSQL itself matched for ${DB_USER} on this database, from
# ${DB_HOST}, over the transport this reader negotiated, checks the secret `ALTER ROLE` writes.
# Appends to DB_PROBE_REPORT on every refusal. Sends no password.
#
# ON SUCCESS IT PUBLISHES THE ROUTE (r42, r43): DB_PROBE_SSLMODE is the libpq setting that
# reproduces the transport the reader used, read out of the reader's own `sslmode=` line rather
# than inferred here, and DB_PROBE_ROUTE_DATABASE is the endpoint it belongs to. ON EVERY OTHER
# PATH IT CLEARS THEM, which is what makes an unproven endpoint unprobeable rather than
# probeable-by-default.
#
# AND THE ROUTE IS THE APPLICATION'S, DECIDED HERE AND CHECKED BACK (r43). This function asks
# db_application_route_sslmode() what node-postgres does with the URL this run will publish, hands
# that to the reader as `--sslmode=`, and admits the answer only if the reader's own `sslmode=`
# line names the same route. So the method is read on the transport the application uses, and the
# probes below are pinned to it — instead of every instrument agreeing with each other about a
# connection nobody makes, which is what r42 left behind.
db_endpoint_checks_role_verifier() {
  local database="$1" probe verdict method detail sslmode route status=0
  DB_PROBE_ROUTE_DATABASE=""
  DB_PROBE_SSLMODE=""
  # THE ROUTE IS DECIDED BEFORE THE READER IS RUN, AND BY THE APPLICATION (r43). Not by libpq, not
  # by whatever the reader would have negotiated on its own: the question this gate answers is
  # about the connection ${APP_DIR}/.env will name, so the observation is made on that connection's
  # transport or it is not made at all.
  if ! route="$(db_application_route_sslmode)"; then
    DB_PROBE_REPORT+="
  - '${database}' was not asked which pg_hba rule matches it, because this run cannot say which TRANSPORT the application's own connection takes. The DATABASE_URL it would publish is not of the shape node-postgres was measured against — a query string on it changes the driver's transport — so the route to observe on is unknown, and a method read over an unknown route is not evidence about the connection the application makes. Re-run the installer from a complete release checkout."
    return 1
  fi
  probe="$(db_auth_request_probe_path)"
  if [[ ! -f "${probe}" ]]; then
    DB_PROBE_REPORT+="
  - '${database}' was not asked which pg_hba rule matches it, because the reader that asks — ${probe} — is not there. Without it this run cannot tell a 'scram-sha-256' endpoint from an 'ldap' one, and an ldap endpoint answers about a directory rather than about the password ALTER ROLE writes. Re-run the installer from a complete release checkout."
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    DB_PROBE_REPORT+="
  - '${database}' was not asked which pg_hba rule matches it, because there is no 'node' on this PATH to run ${probe} with. Install Node.js — this installer installs it further down its own run, so a host that reached a credential rotation has it — and re-run."
    return 1
  fi
  # The reader's own answer, whatever it is, on stdout. Its EXIT STATUS is the verdict; the
  # `method=` and `detail=` lines are what the refusal quotes back to the operator.
  capture verdict node "${probe}" \
    --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_USER}" --database="${database}" \
    --sslmode="${route}" || status=$?
  method="$(printf '%s\n' "${verdict}" | sed -n 's/^method=//p' | head -1)"
  detail="$(printf '%s\n' "${verdict}" | sed -n 's/^detail=//p' | head -1)"
  sslmode="$(printf '%s\n' "${verdict}" | sed -n 's/^sslmode=//p' | head -1)"
  [[ -n "${method}" ]] || method="unknown"
  [[ -n "${detail}" ]] || detail="the reader printed nothing this run could parse"
  if [[ "${status}" -eq 0 ]]; then
    # A METHOD WITHOUT A ROUTE IS NOT USABLE (r42). The two are published together or not at all:
    # a probe pinned to nothing is a probe libpq routes for itself, which is the divergence.
    # THE ROUTE IS CHECKED BACK, NOT ASSUMED (r43). The reader is TOLD which transport to take and
    # REPORTS which one it took; those are two different lines and this compares them, so an
    # argument passed and quietly ignored cannot look like a route observed. Anything but the
    # application's own route — including a reader too old to have been given one — refuses here.
    if [[ "${sslmode}" == "${route}" ]]; then
      DB_PROBE_ROUTE_DATABASE="${database}"
      DB_PROBE_SSLMODE="${sslmode}"
      return 0
    fi
    DB_PROBE_REPORT+="
  - '${database}' named an admissible matched method ('${method}') but not on the transport the APPLICATION uses: it was asked to read the rule on '${route}' — which is what node-postgres does with the DATABASE_URL this installer emits — and its sslmode line says '${sslmode:-nothing at all}'. A pg_hba rule is matched per transport, hostssl and hostnossl being different records, so a method read on any other route is not evidence about the connection the application will make. Re-run the installer from a complete release checkout."
    return 1
  fi
  DB_PROBE_REPORT+="
  - '${database}' does not authenticate '${DB_USER}' against PostgreSQL's own role credential: the matched pg_hba method reads as '${method}', and ${detail}. Only 'scram-sha-256' and 'md5' compare the secret ALTER ROLE writes, so nothing this endpoint says about a candidate password is evidence about the role."
  return 1
}

# THE PAIR. Returns 0 only when the endpoint refused a password nothing can know AND accepted one
# the caller is asserting is live. Appends a line to DB_PROBE_REPORT either way.
#
# IT IS NO LONGER THE WHOLE GATE (r41) — db_endpoint_checks_role_verifier() runs FIRST and decides
# whose password is being checked, and since r42 also pins the transport this runs on. What is
# left to this half is stated at length in the block above and in two sentences here: the POSITIVE
# is the only authentication anything in this gate performs, so it is the only thing that can tell
# a healthy endpoint from one where the role has no CONNECT; and the NEGATIVE is the only thing
# that catches a route which announces `scram-sha-256` and then accepts anything anyway — a pg_hba
# reload landing between the two connections, or a pooler that speaks SASL without verifying.
db_endpoint_discriminates_passwords() {
  local database="$1" positive="$2" control
  # NO ROUTE, NO PROBE. Reached only when this is called without the method gate in front of it;
  # the report says which of the two questions was skipped rather than blaming the endpoint for a
  # refusal this run manufactured.
  if [[ -z "${DB_PROBE_SSLMODE}" || "${DB_PROBE_ROUTE_DATABASE}" != "${database}" ]]; then
    DB_PROBE_REPORT+="
  - '${database}' was not probed with a credential at all, because no reader has established which TRANSPORT its pg_hba rule was matched on. A password sent over a route this run has not observed can be answered by a different record from the one the method was read from, so it is not sent."
    return 1
  fi
  control="$(openssl rand -hex 32)"
  if db_endpoint_accepts_password "${database}" "${control}"; then
    DB_PROBE_REPORT+="
  - '${database}' ACCEPTED a random 32-byte password, so it cannot tell one password from another. A \`trust\` (or otherwise password-independent) rule in pg_hba.conf covers ${DB_USER}@${DB_HOST} on it, and NOTHING it says about a candidate credential is evidence."
    return 1
  fi
  if ! db_endpoint_accepts_password "${database}" "${positive}"; then
    DB_PROBE_REPORT+="
  - '${database}' refused the random password AND the candidate, so it has not been shown able to say yes. A revoked CONNECT is indistinguishable from a wrong password here — and this installer's own connection fence revokes CONNECT on '${DB_NAME}', which is why the application database cannot be the endpoint a rotation relies on."
    return 1
  fi
  return 0
}

# THE WHOLE CHAIN, AGAINST ONE REFERENCE — THE APPLICATION'S CONNECTION (o3d-2sm1.5 r43).
#
# Written out because every previous round aligned these to each other and called it alignment.
# The reference is what node-postgres does with the DATABASE_URL this run will publish, which
# db_application_route_sslmode() derives from the composer itself.
#
#   the authentication-request reader   ON IT. Told the route as `--sslmode=`, and admitted only
#                                       when it reports having taken that route.
#   db_endpoint_accepts_password()      ON IT. psql pinned to DB_PROBE_SSLMODE, which is that same
#                                       route, plus `gssencmode=disable`.
#   db_endpoint_discriminates_passwords()
#                                       ON IT, both halves — the negative control and the positive
#                                       both go through the function above and nothing else.
#   resolve_live_role_password()        ON IT. Its four credential attempts are those two functions.
#   the ALTER, and every local statement DELIBERATELY NOT. pg_local_psql() goes over the Unix socket
#                                       as the `postgres` superuser: it is not evidence about the
#                                       application's credential, and it has to keep working when
#                                       the application's route is exactly what is broken —
#                                       otherwise a misconfigured pg_hba could not be repaired.
#   verify_created_database_endpoint()  DELIBERATELY NOT, argued in full at that function: its
#                                       conclusion is about which postmaster answered, which no
#                                       transport can change, and it authenticates as a throwaway
#                                       role rather than as ${DB_USER}, so a pin could only turn a
#                                       role-specific pg_hba layout into a stopped install.
#   the migration and the build         ON IT BY CONSTRUCTION. They are handed DATABASE_URL and run
#                                       the application's own driver, which is the reference itself.

# THE WHOLE GATE, IN THE ORDER THE ARGUMENT RUNS (r41, r42). Whose password AND OVER WHICH
# TRANSPORT first, then — on that transport and no other — whether this endpoint can tell one
# password from another, then whether the role can get in with the one asserted live. Nothing is
# sent to the server until the first question has been answered, and nothing is sent anywhere but
# the route that answer was given on.
db_endpoint_is_password_sensitive() {
  local database="$1" positive="$2"
  db_endpoint_checks_role_verifier "${database}" || return 1
  db_endpoint_discriminates_passwords "${database}" "${positive}" || return 1
  return 0
}

# THE DATABASES ON THIS SERVER THAT COULD SERVE AS AN UNFENCED PROBE, most-likely-first.
#
# `postgres` LEADS because PUBLIC holds CONNECT on it by default and no fence in this script
# touches it. THE REST ARE READ FROM THE SERVER RATHER THAN ASSUMED, and that is not decoration: a
# site that has revoked PUBLIC CONNECT on the maintenance database — which is ordinary hardening —
# has nowhere on the fixed list left to ask, and refusing every rotation on such a site would be
# this round trading a wrong answer for a wrong refusal. So the question is put to the server.
#
# ${DB_NAME} IS EXCLUDED BY CONSTRUCTION. The connection fence revokes CONNECT on it and a
# reconciliation runs with that fence still standing, so an endpoint chosen here must not be it.
# Templates are excluded because they are not ordinary connection targets, and `datallowconn`
# because a database that refuses every connection cannot discriminate anything. The list is
# capped: each candidate costs up to two connection attempts, and a cluster with two hundred
# databases must not turn one rotation into four hundred.
db_connectable_databases_except_app() {
  pg_local_psql -tA -v dbname="${DB_NAME}" <<'EOSQL' 2>/dev/null
SELECT datname
  FROM pg_database
 WHERE datallowconn
   AND NOT datistemplate
   AND datname <> :'dbname'
 ORDER BY (datname = 'postgres') DESC, datname
 LIMIT 8;
EOSQL
}

db_unfenced_probe_candidates() {
  local -n _unfenced="$1"
  local line
  _unfenced=(postgres)
  while IFS= read -r line; do
    [[ -n "${line}" && "${line}" != "postgres" ]] || continue
    _unfenced+=("${line}")
  done < <(db_connectable_databases_except_app || true)
}

# THE ENDPOINTS A RECONCILIATION MAY ASK, with the one the rotating run RECORDED ahead of every
# other — that is the "reuse that exact endpoint" half, and on a site whose only password-checked
# endpoint is a database this list would not otherwise reach, it is the only thing that answers.
# A journal written by an installer older than r40 carries no probe_database line; the list then
# starts at `postgres`, which is where that older run would have asked first anyway.
#
# ${DB_NAME} COMES LAST, and it is here at all only as a last resort: it is normally behind the
# fence, but a fence that has been released by hand, or a rotation interrupted before the fence
# went up, leaves it the one endpoint that can still answer.
db_probe_endpoint_candidates() {
  local -n _endpoints="$1"
  local recorded="${2:-}" database
  local -a unfenced=()
  db_unfenced_probe_candidates unfenced
  _endpoints=()
  for database in "${recorded}" "${unfenced[@]}" "${DB_NAME}"; do
    [[ -n "${database}" ]] || continue
    [[ " ${_endpoints[*]-} " == *" ${database} "* ]] || _endpoints+=("${database}")
  done
}

# WHICH OF THE TWO CANDIDATES IS LIVE — asked only of an endpoint that has proven it can answer.
#
# Sets DB_ROTATION_RECONCILED_PASSWORD, DB_ROTATION_RECONCILED_WHICH and
# DB_ROTATION_PROBE_DATABASE and returns 0 on an unambiguous answer. Returns 1 when no endpoint
# could be shown password-sensitive; returns 2 when one could and said YES TO BOTH, which is not
# an answer either — it is a server that is not behaving like a password check, and preferring
# `new` because it connected is the defect this function exists to remove.
resolve_live_role_password() {
  local old_password="$1" new_password="$2" recorded="${3:-}"
  local database new_ok old_ok
  local -a endpoints=()
  db_probe_endpoint_candidates endpoints "${recorded}"
  DB_PROBE_REPORT=""
  DB_ROTATION_PROBE_DATABASE=""
  DB_ROTATION_RECONCILED_PASSWORD=""
  DB_ROTATION_RECONCILED_WHICH=""

  for database in "${endpoints[@]}"; do
    # WHOSE PASSWORD, BEFORE ANY PASSWORD, AND OVER WHICH ROUTE (o3d-2sm1.5 r41 and r42, Codex
    # HIGH). The two attempts below send the journal's candidates to this endpoint. If its rule is
    # `ldap`, `pam`, `radius` or `bsd` that hands both of the role's credentials to somebody else's
    # directory — and the answer that came back would be about that directory, not about the role.
    # So the server is asked which rule it matched first, and an endpoint that is not checking
    # pg_authid.rolpassword is dropped here, before anything leaves this host.
    #
    # THIS CALL IS ALSO WHAT PINS THE TRANSPORT. It publishes DB_PROBE_SSLMODE for this database,
    # and the four probes below refuse outright without it — so the record the candidates are
    # checked against is the record the method was read from. That matters most in exactly the
    # configuration this loop meets after an interruption: with `hostssl scram-sha-256` over
    # `hostnossl radius`, an UNPINNED old-password attempt fails SCRAM, drops to the clear and is
    # accepted by the directory, both candidates read as live, and this function returns 2 on a
    # rotation that is perfectly reconcilable over TLS.
    db_endpoint_checks_role_verifier "${database}" || continue
    # THE CANDIDATES, so that the positive half of the control pair is a password this run actually
    # cares about rather than a second throwaway role. An endpoint that accepts neither has not
    # been shown able to say yes and is skipped by the pair test below.
    new_ok=false; old_ok=false
    db_endpoint_accepts_password "${database}" "${new_password}" && new_ok=true
    db_endpoint_accepts_password "${database}" "${old_password}" && old_ok=true
    if ! ${new_ok} && ! ${old_ok}; then
      DB_PROBE_REPORT+="
  - '${database}' refused BOTH recorded candidates. Either neither is live there, or the endpoint refuses the session rather than the password — a revoked CONNECT, which is what this installer's connection fence does to '${DB_NAME}'."
      continue
    fi
    # AND NOW THE CONTROL, against the candidate that connected. This is the half that makes a
    # success mean something: under `trust` both flags above are true and the endpoint is thrown
    # out here rather than believed. The method half of the gate already ran, at the top of this
    # iteration, which is why this calls the discrimination half rather than the pair.
    if ${new_ok}; then
      db_endpoint_discriminates_passwords "${database}" "${new_password}" || continue
    else
      db_endpoint_discriminates_passwords "${database}" "${old_password}" || continue
    fi
    if ${new_ok} && ${old_ok}; then
      DB_ROTATION_PROBE_DATABASE="${database}"
      return 2
    fi
    DB_ROTATION_PROBE_DATABASE="${database}"
    if ${new_ok}; then
      DB_ROTATION_RECONCILED_PASSWORD="${new_password}"
      DB_ROTATION_RECONCILED_WHICH=new
    else
      DB_ROTATION_RECONCILED_PASSWORD="${old_password}"
      DB_ROTATION_RECONCILED_WHICH=old
    fi
    return 0
  done
  return 1
}

# @install-phase: credential-rotation
#
# Called from prompt_db_password(), which is the first point at which all four identity values are
# known — and a point at which NOTHING HAS BEEN TOUCHED, so a refusal here leaves the system
# exactly as it found it. That is the same rule the r37 reordering was about.
reconcile_interrupted_role_rotation() {
  DB_ROTATION_JOURNAL_FOUND=false
  DB_ROTATION_RECONCILED_PASSWORD=""
  DB_ROTATION_RECONCILED_WHICH=""
  [[ -e "${DB_ROLE_ROTATION_JOURNAL}" ]] || return 0

  local complete identity env_file old_password new_password recorded_probe resolution=0
  complete="$(role_rotation_journal_value marker_complete || true)"
  [[ "${complete}" == "1" ]] || die "A database credential rotation journal at ${DB_ROLE_ROTATION_JOURNAL} is incomplete — it has no marker_complete line. Nothing this installer writes can leave it in that state: it is published by rename, so the name only ever appears over finished bytes. Inspect the file, establish which password '${DB_USER}' actually has, and remove it. NOTHING HAS BEEN INSTALLED and nothing has been stopped."

  identity="$(role_rotation_journal_value identity || true)"
  env_file="$(role_rotation_journal_value env_file || true)"
  [[ "${identity}" == "$(role_rotation_identity)" ]] || die "A database credential rotation was interrupted for ${identity} and this run is installing $(role_rotation_identity). A password is a property of one role on one server, so this run cannot finish that transition and must not clear its record: doing either would leave ${identity} with a credential nothing on this host names. Reconcile it — re-run the installer against ${identity}, or establish its password by hand and remove ${DB_ROLE_ROTATION_JOURNAL}. NOTHING HAS BEEN INSTALLED and nothing has been stopped."

  [[ "${INSTALL_POSTGRES}" == "y" ]] || die "A database credential rotation was interrupted for ${identity} and this run does not manage a LOCAL PostgreSQL server, so it has no privileged local connection with which to establish which password that role now has. Re-run with the local database, or settle it by hand and remove ${DB_ROLE_ROTATION_JOURNAL}. NOTHING HAS BEEN INSTALLED and nothing has been stopped."

  # THE JOURNAL DECODE, THROUGH THE SENTINEL (o3d-2sm1.5 r40, Codex HIGH). base64 is exactly what
  # makes a newline-terminated password survive the FILE; `$( )` around the decode is what threw it
  # away again, and this is the path where losing it publishes a `.env` the server will not accept.
  # The INNER captures need nothing: role_rotation_journal_value() returns base64, whose alphabet
  # contains no newline, so the only newline `$( )` removes there is sed's own line terminator.
  capture old_password rotation_journal_decode "$(role_rotation_journal_value old_password_b64 || true)"
  capture new_password rotation_journal_decode "$(role_rotation_journal_value new_password_b64 || true)"
  [[ -n "${old_password}" && -n "${new_password}" ]] || die "The database credential rotation journal at ${DB_ROLE_ROTATION_JOURNAL} does not carry both candidate passwords, so this run cannot tell which one '${DB_USER}' has. Establish it by hand and remove the file. NOTHING HAS BEEN INSTALLED and nothing has been stopped."

  # The endpoint the ROTATING run proved could discriminate, so this run asks that one first
  # rather than deriving an endpoint of its own (o3d-2sm1.5 r40, Codex HIGH).
  recorded_probe="$(role_rotation_journal_value probe_database || true)"

  warn "A database credential rotation for ${identity} was INTERRUPTED: ${DB_ROLE_ROTATION_JOURNAL} exists,"
  warn "which means a previous run committed — or was about to commit — an ALTER USER and did not"
  warn "get as far as publishing ${env_file}. Asking the server which password that role has —"
  warn "on an endpoint whose matched pg_hba rule the SERVER named as one that compares the secret"
  warn "ALTER ROLE writes, and which has then been shown able to REFUSE a password nothing knows."

  resolve_live_role_password "${old_password}" "${new_password}" "${recorded_probe}" || resolution=$?

  if [[ "${resolution}" -eq 2 ]]; then
    die "A database credential rotation for ${identity} was interrupted, and '${DB_ROTATION_PROBE_DATABASE}' — an endpoint that DID refuse a random password, so it is checking something — accepts BOTH recorded candidates as '${DB_USER}'. Two different passwords cannot both be the role's, so this server is not answering the way a password check answers and no probe here can say which credential is live. This run refuses rather than guess: ${DB_ROLE_ROTATION_JOURNAL} is LEFT IN PLACE so the two candidates are not lost. Establish the role's password by hand, remove that file, and re-run. NOTHING HAS BEEN INSTALLED and nothing has been stopped."
  fi

  if [[ "${resolution}" -ne 0 ]]; then
    die "A database credential rotation for ${identity} was interrupted and this run could not find a single endpoint that both checks POSTGRESQL'S OWN role credential for '${DB_USER}' and can tell one password from another, so nothing it asked the server is evidence about which credential is live. A trust rule makes every candidate succeed; a revoked CONNECT makes every candidate fail; and an ldap, pam, radius or bsd rule answers confidently about a password held somewhere ALTER ROLE cannot reach — this run refuses on any of them rather than adopting a credential the probe cannot speak for. It may also be that NEITHER of the two passwords it recorded was accepted anywhere it could ask, which is what you see when somebody has rotated the role OUT OF BAND or the server is not reachable from here — and nothing this script can ask tells those apart, which is why it stops. ${DB_ROLE_ROTATION_JOURNAL} is LEFT IN PLACE so the two candidates are not lost. Give '${DB_USER}' a password-checked route to an UNFENCED database — GRANT CONNECT ON DATABASE postgres TO that role, with a scram-sha-256 or md5 rule for ${DB_HOST} in pg_hba.conf, is the whole of it — or establish the role's password by hand and remove that file. NOTHING HAS BEEN INSTALLED and nothing has been stopped. What this run asked, and what each endpoint did:${DB_PROBE_REPORT}"
  fi

  DB_ROTATION_JOURNAL_FOUND=true

  if [[ "${DB_ROTATION_RECONCILED_WHICH}" == "new" ]]; then
    success "The server has the NEW password: the ALTER committed. Established on '${DB_ROTATION_PROBE_DATABASE}', whose matched pg_hba rule the server named as scram-sha-256 or md5 — so the secret it compared is the one ALTER ROLE writes — and which refused a random password in the same breath. This run FINISHES the transition — it treats that credential as the installed one, so the environment file it writes names what the server actually has, and the journal is cleared only once that file is on the medium. ${env_file} may currently name the old one; it is complete and it is about to be replaced."
    return 0
  fi

  success "The server still has the OLD password: the ALTER did not commit, so nothing was ever taken away and ${env_file} already agrees with the server. Established on '${DB_ROTATION_PROBE_DATABASE}', whose matched pg_hba rule the server named as scram-sha-256 or md5, and which refused a random password in the same breath. This run treats that credential as the installed one and clears the journal. Supply the new password again to ask for the rotation a second time; it will happen inside the stopped, fenced window."
  return 0
}

# @install-phase: credential-rotation
#
# Called immediately after the pre-build write_app_env_file(), which is the publication the
# journal was waiting for. NOT before it: the journal's whole job is to survive until an
# environment file naming the live credential is on the medium.
resolve_role_rotation_journal_after_env_publication() {
  [[ -e "${DB_ROLE_ROTATION_JOURNAL}" ]] || return 0
  if ${DB_PASSWORD_ROTATION_PENDING}; then
    info "An interrupted rotation is recorded at ${DB_ROLE_ROTATION_JOURNAL} and THIS run has a"
    info "rotation of its own pending, so the record stays: the fenced-window rotation supersedes"
    info "it in the same step that performs the ALTER."
    return 0
  fi
  clear_role_rotation_journal || die "The interrupted rotation recorded at ${DB_ROLE_ROTATION_JOURNAL} is reconciled — ${APP_DIR}/.env now names the credential the server has — but the record could not be removed durably. It is safe to delete by hand; leaving it costs the next run one probe. NOTHING HAS BEEN MIGRATED."
  success "The interrupted rotation recorded at ${DB_ROLE_ROTATION_JOURNAL} is reconciled and the record is cleared: ${APP_DIR}/.env names the credential the server has."
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


# Read ONE variable out of .env without `source` (which executes whatever is in the file)
# and without `grep | cut` (which is what this used to be: it kept the surrounding quotes
# and any trailing comment, so an ordinary `KEY="postgres://u:p@h/db"  # deploy admin`
# reached psql complete with a double quote at each end and the word "deploy" on the end).
# The quoting rules followed are dotenv's own, because dotenv is what reads this file
# everywhere else: a quoted value ends at its closing quote, an unquoted one ends at the
# first whitespace-preceded `#`, and later definitions win.
env_file_value() {
  local key="$1" file="$2" line value
  [[ -f "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *)
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# THE ONE PLACE A TCP PORT IS DECIDED TO BE A TCP PORT (o3d-2sm1.5 r26, Codex HIGH).
#
# A port that is not a port is not a cosmetic problem here: it is spliced straight into the URL
# the health check polls, and a URL that cannot be reached is indistinguishable from a service
# that did not come up. On the update path that costs a healthy deployment — the poll times out,
# the script stops the service it just started and re-establishes the post-migration fences.
#
# So the shape is checked ONCE, where the value is read, and the run refuses BEFORE anything is
# stopped rather than discovering it after the schema has moved. Decimal digits only, 1-65535,
# and `10#` so a leading zero is a decimal port and not a bash octal error under `set -e`.
valid_tcp_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#$value >= 1 && 10#$value <= 65535 )) || return 1
}

# ---------------------------------------------------------------------------
# IS THE FILE WE READ THE ONLY THING THAT CAN DEFINE DATABASE_URL FOR THIS SERVICE?
# (o3d-2sm1.5 r20, Codex CRITICAL; r21 asks systemd's BUS instead of its text output)
#
# r19 moved the identity from "worked out by the fence" to "supplied by the entrypoint", and the
# entrypoint supplies it out of ${APP_DIR}/.env. That is the PREVIOUS PROBLEM ONE LEVEL UP: an
# `Environment=DATABASE_URL=...` directive, a drop-in that adds one, a `PassEnvironment=` entry, a
# `PAMName=` whose PAM stack exports one, or a second `EnvironmentFile=` can put a different URL in
# the service's environment, and dotenv does NOT overwrite a variable that is already set. The
# fence, the migration and the release would then all be self-consistent about the .env database
# while the restarted application connects elsewhere — a migration run on a database nothing was
# fenced off, and a new build started against a database nothing migrated.
#
# THIS DOES NOT REBUILD THE INFERENCE r19 DELETED, and the difference is the whole design. It
# computes no value and reproduces no precedence. It asks ONE existence question about ONE
# variable:
#
#     can anything other than the file we read define DATABASE_URL for this unit?
#
# systemd answers that directly, because it reports the COMPOSED Environment=, EnvironmentFiles=,
# PassEnvironment=, UnsetEnvironment= and PAMName= with every drop-in already folded in by systemd
# itself. Asking whether a second definition EXISTS is bounded; working out which of several would
# WIN is the unbounded question, and it is never asked — any answer but "only that file" is a
# refusal that names what else defines it and tells the operator to state the identity explicitly.
# A second environment file is refused WITHOUT being read, for the same reason: that it may define
# the variable is enough, and reading it to find out would put the precedence question straight
# back. A non-empty PAMName= is refused without reading PAM configuration, for that same reason
# again.
#
# IT IS ASKED OF THE BUS, NOT OF `systemctl show` (r21, Codex CRITICAL). Two of r20's three
# findings were text-parsing bugs and only text-parsing bugs: `systemctl show` renders a property
# as one `Name=` line of space-joined values, so where one entry of an ARRAY ends and the next
# begins has to be guessed at — and `EnvironmentFiles` is an array of (path, ignore_errors) PAIRS
# whose rendering the previous reader truncated at the first ` (ignore_errors=`. `busctl` — the
# same package, on every host that has systemctl — prints the property's SIGNATURE and the array's
# own ELEMENT COUNT before the elements:
#
#     a(sb) 1 "/opt/app/.env" true          as 2 "NODE_ENV=production" "PORT=3000"          s ""
#
# so "is there more than one environment file?" is answered by systemd's own data structure. The
# count is read from the rendering and checked against the number of elements found in it; a
# disagreement is a refusal. Nothing is inferred from where a space falls, and a string systemd had
# to escape (busctl prints strings through `cescape()`) is REFUSED rather than decoded — decoding
# it here would be one more reimplementation of somebody else's rules.
#
# EVERY ENVIRONMENT PROPERTY IS THEN MATCHED THE SAME WAY: on the NAME of each element, which is
# everything before its first `=`. That is what makes `UnsetEnvironment=DATABASE_URL=<the value in
# the .env>` a refusal (r21, Codex HIGH): systemd.exec takes "a space-separated list of variable
# names or variable assignments", removes an exact assignment as the FINAL step of composing the
# environment, and a scan for the bare token `DATABASE_URL` sees no such token in it — after which
# the application's own dotenv loader supplies whatever `.env.local` says. The same rule applies to
# Environment=, PassEnvironment= and UnsetEnvironment= alike, so no spelling of any of them is
# matched by a substring.
#
# THE FILE MUST ALSO BE ONE SYSTEMD ITSELF LOADS. If the unit loads no environment file, the
# variable reaches the application through the application's OWN loader instead, by rules that
# belong to Next and not to systemd — `.env.local` and the per-mode overlays, which is precisely
# the layer r19 stopped reproducing. So that is a refusal too, and it says which line to add.
#
# WHAT IT CANNOT SEE, STATED RATHER THAN PAPERED OVER: an `ExecStart=` that runs a wrapper which
# exports DATABASE_URL itself is invisible to systemd's own properties, because that definition
# lives inside a program rather than in the unit. Closing that would mean reading programs, which
# is unbounded again. It is the standing argument for making the four values a DEPLOYMENT-OWNED
# CONFIGURATION INPUT that these scripts read outright, instead of deriving them from a URL that
# is only probably the one the service uses (o3d-1yvh, docs/installation.md).
DB_IDENTITY_SOURCE_REASON="the service's environment has not been asked about yet"
BUS_STRINGS=()

# THE STRINGS IN ONE `busctl` RENDERING, in order, STILL ESCAPED.
#
# busctl prints every string through `cescape()`, so a `"` inside a value arrives as `\"` and
# cannot end it early. This walks the rendering with that one rule and keeps the escapes: the
# callers compare against names and paths that contain none, and refuse anything that does.
# Returns 1 for a rendering whose quoting does not close, which is a rendering this cannot read.
bus_read_strings() {
  local text="${1:-}" index=0 length char current='' inside=0
  BUS_STRINGS=()
  length=${#text}
  while (( index < length )); do
    char="${text:index:1}"
    if (( inside )); then
      if [[ "$char" == '\' ]]; then
        (( index + 1 < length )) || return 1
        index=$(( index + 1 ))
        current+="\\${text:index:1}"
      elif [[ "$char" == '"' ]]; then
        BUS_STRINGS+=("$current")
        current=''
        inside=0
      else
        current+="$char"
      fi
    elif [[ "$char" == '"' ]]; then
      inside=1
      current=''
    fi
    index=$(( index + 1 ))
  done
  (( inside == 0 )) || return 1
  return 0
}

# THE ELEMENT COUNT systemd states in front of an array, for the signature we asked for.
#
# This is the number that makes the question bounded: it comes from the array, not from counting
# separators in a line. A rendering of another signature — or none — is not an answer, and the
# caller refuses.
bus_array_count() {
  local text="${1:-}" signature="${2:-}" rest
  [[ "$text" == "${signature} "* ]] || return 1
  rest="${text#"${signature}" }"
  rest="${rest%% *}"
  [[ "$rest" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$rest"
}

# One property of one unit, as systemd's own bus states it.
bus_unit_property() {
  busctl get-property org.freedesktop.systemd1 "${1:-}" "org.freedesktop.systemd1.${2:-}" "${3:-}" 2>/dev/null
}

# Does this element of an environment property NAME DATABASE_URL? Everything before the first `=`
# is the name, so `DATABASE_URL`, `DATABASE_URL=postgresql://...` and an assignment carrying any
# value at all are one answer, and `NEXT_PUBLIC_DATABASE_URL=...` is not.
bus_element_names_database_url() {
  [[ "${1%%=*}" == "DATABASE_URL" ]]
}

# THE `ignore_errors` HALF OF EnvironmentFiles=, which is an `a(sb)` and not an `as`
# (o3d-2sm1.5 r23, Codex HIGH). bus_read_strings() reads the paths and drops the booleans; the
# snapshot check needs them, because a snapshot loaded with a leading `-` is not a binding at
# all — systemd would SKIP it if it were missing and hand the service back to whatever else
# defines DATABASE_URL, which is the failure this round exists to remove.
#
# Every quoted element is removed first, which leaves the signature, systemd's own element count
# and the booleans in order. Nothing here reimplements systemd's escaping: the callers already
# refuse any element that had to be escaped.
BUS_ENV_IGNORE_FLAGS=()
bus_read_env_ignore_flags() {
  local text="${1:-}" stripped word index=0
  BUS_ENV_IGNORE_FLAGS=()
  stripped="$(printf '%s' "$text" | sed 's/"\(\\.\|[^"\\]\)*"/ /g')" || return 1
  local IFS=' '
  local -a words=()
  # shellcheck disable=SC2206  # deliberate word split on the space-separated rendering
  words=($stripped)
  for (( index = 2; index < ${#words[@]}; index++ )); do
    word="${words[index]}"
    case "$word" in
      true|false) BUS_ENV_IGNORE_FLAGS+=("$word") ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# Does the caller also REQUIRE the environment snapshot to be loaded? False everywhere the
# question is only "is anything else defining DATABASE_URL"; true at the one call site that is
# about to hand the units to systemd (o3d-2sm1.5 r23).
DB_IDENTITY_REQUIRE_SNAPSHOT=false

env_file_is_sole_database_url_source() {
  local env_file="${1:-}"; shift || true
  local -a units=("$@")
  local unit object rendering count element expected resolved load_state pam_name snapshot_expected

  DB_IDENTITY_SOURCE_REASON=""
  expected="$(readlink -f "$env_file" 2>/dev/null || printf '%s' "$env_file")"
  snapshot_expected="$(readlink -f "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || printf '%s' "$DB_ENV_SNAPSHOT_FILE")"

  if [[ "${#units[@]}" -eq 0 || -z "${units[0]}" ]]; then
    DB_IDENTITY_SOURCE_REASON="no systemd unit was identified for the application, so there is nothing that can say whether ${env_file} is what gives it DATABASE_URL"
    return 1
  fi
  if ! command -v busctl >/dev/null 2>&1; then
    DB_IDENTITY_SOURCE_REASON="busctl — systemd's own bus client, shipped beside systemctl — is not available, so whether anything other than ${env_file} defines DATABASE_URL for the service cannot be established"
    return 1
  fi

  for unit in "${units[@]}"; do
    [[ -n "$unit" ]] || continue

    # LoadUnit, not GetUnit: it answers for a unit the manager has not loaded yet as well, so the
    # LoadState below is what says whether there is a readable unit there at all. It is the same
    # load `systemctl show` performs — it starts nothing and queues no job.
    rendering="$(busctl call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s "$unit" 2>/dev/null)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 || -z "${BUS_STRINGS[0]}" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not say where ${unit} lives on its bus, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    object="${BUS_STRINGS[0]}"

    rendering="$(bus_unit_property "$object" Unit LoadState)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer for ${unit}'s LoadState, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    load_state="${BUS_STRINGS[0]}"
    if [[ "$load_state" != "loaded" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd reports ${unit} as '${load_state:-unknown}' rather than loaded, so what defines DATABASE_URL for it cannot be read"
      return 1
    fi

    # PAMName=, which the five-property question did not ask (r21, Codex CRITICAL). systemd.exec
    # lists "variables set by any PAM modules in case PAMName= is in effect" AFTER the
    # EnvironmentFile= layer and says the later source wins, so a unit naming a PAM profile whose
    # stack runs pam_env can be handed a DATABASE_URL that beats the file this deploy read — while
    # every other property here still says "only that file". What a PAM stack supplies is not
    # knowable without reading PAM configuration, so ANY non-empty value is refused.
    rendering="$(bus_unit_property "$object" Service PAMName)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer for ${unit}'s PAMName=, so whether a PAM stack also defines DATABASE_URL for it is unknown"
      return 1
    fi
    pam_name="${BUS_STRINGS[0]}"
    if [[ -n "$pam_name" ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} sets PAMName=${pam_name}, and systemd applies the variables its PAM modules set AFTER the environment file — the later source wins. Whether that stack exports DATABASE_URL is a question about PAM configuration this will not read, so it is refused rather than guessed at. Remove PAMName=, or state the connection identity explicitly"
      return 1
    fi

    # The three environment lists, all matched on the element NAME. UnsetEnvironment= takes a name
    # OR an exact assignment and is applied as the final composition step, so the assignment form
    # is the same refusal as the bare name (r21, Codex HIGH).
    local property description
    for property in Environment PassEnvironment UnsetEnvironment; do
      rendering="$(bus_unit_property "$object" Service "$property")" || rendering=''
      if ! count="$(bus_array_count "$rendering" 'as')" || ! bus_read_strings "$rendering" \
        || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
        DB_IDENTITY_SOURCE_REASON="systemd would not answer readably for ${unit}'s ${property}=, so what defines DATABASE_URL for that service is unknown"
        return 1
      fi
      for element in ${BUS_STRINGS[@]+"${BUS_STRINGS[@]}"}; do
        bus_element_names_database_url "$element" || continue
        case "$property" in
          Environment) description="sets DATABASE_URL in its own Environment= (${element%%=*}=…). systemd puts that in the service's environment and dotenv will not overwrite an already-set variable, so the application connects where THAT says and not where ${env_file} says" ;;
          PassEnvironment) description="lists DATABASE_URL in PassEnvironment=, so the service inherits whatever the service manager's own environment holds and ${env_file} does not decide where the application connects" ;;
          *) description="lists DATABASE_URL in UnsetEnvironment= (as '${element}'), so systemd removes the value ${env_file} supplies — as the final step of composing the environment, whether it is written as a name or as an exact assignment — and the application's own loader decides what replaces it" ;;
        esac
        DB_IDENTITY_SOURCE_REASON="${unit} ${description}. Remove it, or state the connection identity explicitly"
        return 1
      done
    done

    # EnvironmentFiles=, an array of (path, ignore_errors) pairs. EXACTLY ONE entry, and it must
    # be ours: the count is systemd's own, so a second file cannot hide behind the rendering.
    rendering="$(bus_unit_property "$object" Service EnvironmentFiles)" || rendering=''
    if ! count="$(bus_array_count "$rendering" 'a(sb)')" || ! bus_read_strings "$rendering" \
      || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not answer readably for ${unit}'s EnvironmentFiles=, so what defines DATABASE_URL for that service is unknown"
      return 1
    fi
    if [[ "$count" -eq 0 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} does not load ${env_file} with EnvironmentFile=, so DATABASE_URL reaches the application through its own dotenv loader instead — whose .env.local and per-mode overlays are exactly the composition this deploy stopped reproducing. Add EnvironmentFile=${env_file} to the unit, or state the connection identity explicitly"
      return 1
    fi
    # ONE ENVIRONMENT FILE, OR TWO OF WHICH THE SECOND IS THIS RUN'S OWN SNAPSHOT
    # (o3d-2sm1.5 r23, Codex HIGH). Until this round the answer was "exactly one, and it must be
    # ${env_file}" — which is the right refusal for somebody ELSE's second file and the wrong one
    # for the binding this round adds, since publish_db_identity_snapshot() gives every unit a
    # drop-in that loads ${DB_ENV_SNAPSHOT_FILE} after it. So the shape is stated exactly: the
    # application's file first, and at most one more, which may only be the snapshot THIS RUN
    # published. A snapshot left behind by some earlier run is NOT tolerated — DB_ENV_SNAPSHOT_PUBLISHED
    # is false until this run writes one — because an unexplained pin is a DATABASE_URL nobody
    # here chose, which is precisely the condition this function exists to refuse.
    if [[ "$count" -gt 2 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} loads ${count} environment files (${BUS_STRINGS[*]}). Whether any of them but ${env_file} defines DATABASE_URL, and which definition systemd would keep, is composition this will not reproduce — so it is refused rather than guessed at, and without reading them. Load only ${env_file}, or state the connection identity explicitly"
      return 1
    fi
    if ! bus_read_env_ignore_flags "$rendering" || [[ "${#BUS_ENV_IGNORE_FLAGS[@]}" -ne "$count" ]]; then
      DB_IDENTITY_SOURCE_REASON="systemd would not say readably whether ${unit} loads its environment files with a leading '-'. Whether a missing file is skipped or fatal decides what the service gets when one disappears, so it is refused rather than assumed"
      return 1
    fi
    local index
    for index in 0 1; do
      [[ "$index" -lt "$count" ]] || continue
      element="${BUS_STRINGS[index]}"
      case "$element" in
        *'\'*)
          DB_IDENTITY_SOURCE_REASON="systemd reports one of ${unit}'s environment files as ${element}, a path it had to escape to state. Decoding that here to compare it with ${env_file} is a reimplementation of somebody else's escaping, so it is refused: give the unit an EnvironmentFile= path with no character needing an escape, or state the connection identity explicitly"
          return 1 ;;
      esac
      resolved="$(readlink -f "$element" 2>/dev/null || printf '%s' "$element")"
      if [[ "$index" -eq 0 ]]; then
        if [[ "$resolved" != "$expected" ]]; then
          DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} as its first environment file and not ${env_file}, so the file this deploy read is not the one that gives the service DATABASE_URL. Load ${env_file}, or state the connection identity explicitly"
          return 1
        fi
        continue
      fi
      # THE SECOND ENTRY, WHICH MAY ONLY BE THE BINDING. Three things are required of it and each
      # is load-bearing: it is the snapshot's path (anything else is a source of DATABASE_URL this
      # deploy did not write), THIS run published it (an old one pins a value nobody re-validated),
      # and it is loaded WITHOUT a leading '-' (with one, deleting it between here and the exec
      # takes the binding away silently and hands the service back to ${env_file}).
      if ! $DB_ENV_SNAPSHOT_PUBLISHED; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads a second environment file, ${element}, that this run did not publish. A second file can define DATABASE_URL and systemd keeps the LAST definition, so what the service would connect to is not ${env_file}'s answer. Remove it (if it is a ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in, an earlier cutover left it behind and it is safe to delete), or state the connection identity explicitly"
        return 1
      fi
      if [[ "$resolved" != "$snapshot_expected" ]]; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} as a second environment file, and this run's environment snapshot is ${DB_ENV_SNAPSHOT_FILE}. A second file can define DATABASE_URL and systemd keeps the LAST definition, so the service would connect where that file says. Remove it, or state the connection identity explicitly"
        return 1
      fi
      if [[ "${BUS_ENV_IGNORE_FLAGS[index]}" != "false" ]]; then
        DB_IDENTITY_SOURCE_REASON="${unit} loads ${element} with a leading '-', so systemd SKIPS it if it is missing instead of failing the start. The whole point of the snapshot is that its absence stops the service rather than handing it back to ${env_file}; drop the '-' from the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in"
        return 1
      fi
    done
    # AND WHEN THE CALLER IS ABOUT TO START THE SERVICE, THE BINDING MUST BE THERE. Everywhere
    # else this function is a refusal of extra sources; at the start it is also the proof that the
    # one source that cannot be replaced under us is loaded.
    if $DB_IDENTITY_REQUIRE_SNAPSHOT && [[ "$count" -ne 2 ]]; then
      DB_IDENTITY_SOURCE_REASON="${unit} does not load this run's environment snapshot ${DB_ENV_SNAPSHOT_FILE}, so the DATABASE_URL it gets at exec is whatever ${env_file} says at that moment and not the one this run fenced and migrated"
      return 1
    fi
  done
  return 0
}

# The refusal the start goes through: a service whose DATABASE_URL nothing but that file (and
# this run's own snapshot) can define.
require_env_file_is_sole_definition() {
  env_file_is_sole_database_url_source "${APP_DIR}/.env" "${APP_NAME}.service"
}

# THE SAME TWO HALVES, PLUS THE BINDING (o3d-2sm1.5 r23, Codex HIGH).
#
# Used at the ONE call site that is about to hand the units to systemd. The difference from
# require_start_identity_unchanged() is not a stricter read of the same file — re-reading harder
# is what rounds 13-22 already exhausted — it is that this one requires the loaded unit
# configuration to name a file systemd will read at exec AND that this run wrote AND that the
# application user cannot replace. What the two checks above establish about ${APP_DIR}/.env
# is kept because a disagreement there is still worth refusing on: it means the operator's file
# and this run have parted company, and starting into a snapshot that contradicts the file on
# disk would be correct-but-astonishing.
require_start_identity_bound() {
  local rc=0
  DB_IDENTITY_REQUIRE_SNAPSHOT=true
  require_env_file_is_sole_definition || rc=$?
  DB_IDENTITY_REQUIRE_SNAPSHOT=false
  [[ "$rc" -eq 0 ]] || return "$rc"
  # AND THE FILE STILL SAYS WHAT THIS RUN WROTE. install.sh does not READ its identity out of
  # ${APP_DIR}/.env — it composed the value and wrote the file — so there is no four-value parse
  # to re-run here, and an exact string comparison is stronger than one. A disagreement means the
  # file was replaced during the build/migration window: the snapshot makes the START safe either
  # way, and this refusal is what stops a correct-but-astonishing start into a database the file
  # on disk no longer names.
  local current
  current="$(env_file_value DATABASE_URL "${APP_DIR}/.env")" || current=""
  if [[ "$current" != "${DATABASE_URL}" ]]; then
    DB_IDENTITY_SOURCE_REASON="${APP_DIR}/.env no longer states the DATABASE_URL this run fenced and migrated with. The service would still start on the right database — the environment snapshot is loaded last and wins — but the file on disk and this run have parted company, and starting into that disagreement silently is how the next operator is misled"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# THE ENVIRONMENT SNAPSHOT: publish, and take it away again (o3d-2sm1.5 r23, Codex HIGH).
# ---------------------------------------------------------------------------
# Publish the DATABASE_URL this run fenced and migrated where only root can change it, and make
# every unit load it LAST. Called with the connection fence still up and nothing started, so a
# failure here costs a re-run and no outage.
publish_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would publish ${DB_ENV_SNAPSHOT_FILE} and the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in, daemon-reload, and verify the loaded EnvironmentFiles on the bus"
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || {
    error "systemctl is unavailable, so the started service cannot be bound to the database this run migrated."
    return 1
  }
  if [[ -z "${APP_NAME}" ]]; then
    error "No systemd unit is named for the application, so there is nothing to bind the environment snapshot to."
    return 1
  fi

  # A PATH SYSTEMD WOULD HAVE TO ESCAPE IS REFUSED, not escaped. The bus check compares the
  # loaded path against this one and refuses any element that had to be escaped, so emitting one
  # here would guarantee a refusal three lines later — with a message about somebody else's unit.
  case "$DB_ENV_SNAPSHOT_FILE" in
    *[$' \t\n\\']*)
      error "${DB_ENV_SNAPSHOT_FILE} contains whitespace or a backslash, so systemd could not state it back unescaped and the binding could not be verified. That path is the literal DB_ENV_SNAPSHOT_DIR at the top of this script; edit it there to one with neither."
      return 1 ;;
  esac

  # THE VALUE IS THE ONE THIS RUN PINNED, re-read from the file and re-checked against the pin by
  # the caller a moment ago. It is written SINGLE-QUOTED because that is the one form systemd
  # documents as verbatim — "can span multiple lines and contain any character verbatim other
  # than single quote" — so the deploy's reader and systemd's reader cannot disagree about it the
  # way they can about an unquoted value with a backslash in it.
  # AND IT IS THE SHELL VALUE, NOT A RE-READ OF THE FILE. install.sh composed DATABASE_URL and
  # fenced and migrated with it; the file is something it WROTE. Binding to the file's current
  # contents would re-introduce the very indirection this removes.
  local value="${DATABASE_URL}"
  if [[ -z "$value" ]]; then
    error "This run has no DATABASE_URL to bind the service to."
    return 1
  fi
  case "$value" in
    *"'"*|*$'\n'*)
      error "DATABASE_URL contains a single quote or a newline, which cannot be written into a systemd environment file verbatim. Re-write it without one."
      return 1 ;;
  esac

  # The directory first, root-owned and 0700, so that nothing running as the application user can
  # replace or remove what the unit is about to be pointed at.
  if ! mkdir -p "$DB_ENV_SNAPSHOT_DIR" \
     || ! chown root:root "$DB_ENV_SNAPSHOT_DIR" \
     || ! chmod 700 "$DB_ENV_SNAPSHOT_DIR"; then
    error "${DB_ENV_SNAPSHOT_DIR} could not be created root-owned and 0700, so the environment snapshot would sit somewhere the application user can rewrite."
    return 1
  fi

  printf "DATABASE_URL='%s'\n" "$value" | publish_durable_file "$DB_ENV_SNAPSHOT_FILE" || {
    error "${DB_ENV_SNAPSHOT_FILE} could not be published durably; the service is NOT bound and nothing has been started."
    return 1
  }
  # publish_durable_file() leaves 0600; the owner is root because this script runs as root, and
  # systemd reads EnvironmentFile= as PID 1 BEFORE it drops to User=. So the application user
  # never needs to read it — which is the point: the file that decides the connection is not one
  # the service, or anything running as it, can rewrite.
  chown root:root "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || true
  DB_ENV_SNAPSHOT_PUBLISHED=true

  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
  [[ -f "${DB_ENV_SNAPSHOT_DROPIN_FILE}" ]] || DB_ENV_SNAPSHOT_DROPINS_CREATED+=("${DB_ENV_SNAPSHOT_DROPIN_FILE}")
  if ! publish_durable_dropin "${DB_ENV_SNAPSHOT_DROPIN_FILE}" <<EOF
[Service]
# Installed by scripts/install.sh (o3d-2sm1.5 r23) for the length of ONE cutover, and removed
# again before this run exits. It binds the service to the database this run fenced and
# migrated: systemd reads environment files in order and the LAST definition of a variable
# wins, so this beats whatever ${APP_DIR}/.env says at the moment of exec.
# No leading '-': if the file is gone, the start must FAIL rather than fall back.
EnvironmentFile=${DB_ENV_SNAPSHOT_FILE}
EOF
  then
    error "${DB_ENV_SNAPSHOT_DROPIN_FILE} could not be published durably, so ${APP_NAME}.service is NOT bound to the database this run migrated."
    return 1
  fi

  if ! systemctl daemon-reload; then
    error "systemctl daemon-reload failed, so the environment snapshot is not in the unit's loaded configuration."
    return 1
  fi
  return 0
}

# Take the binding away. Called on EVERY exit path, successful or not: a drop-in left standing
# would pin a DATABASE_URL that a later, legitimate edit of ${APP_DIR}/.env could not
# override, and it would do so silently.
remove_db_identity_snapshot() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY]${RESET}   would remove the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-ins, daemon-reload, and delete ${DB_ENV_SNAPSHOT_FILE}"
    return 0
  fi
  local removed=false
  if [[ -e "${DB_ENV_SNAPSHOT_DROPIN_FILE}" ]]; then
    rm -f "${DB_ENV_SNAPSHOT_DROPIN_FILE}"
    removed=true
  fi
  rmdir "${FENCE_DROPIN_DIR}" 2>/dev/null || true
  if $removed && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || warn "daemon-reload failed while removing the environment snapshot drop-ins."
  fi
  rm -f "$DB_ENV_SNAPSHOT_FILE"
  DB_ENV_SNAPSHOT_PUBLISHED=false
  DB_ENV_SNAPSHOT_DROPINS_CREATED=()
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
  # A RECOVERY PATH MAY NOT DEPEND ON THE THING WHOSE LOSS IT RECOVERS FROM: a box that already
  # has a root-owned copy needs nothing from the checkout to fence with.
  [[ -f "${DB_FENCE_SCRIPT}" || -f "${DB_FENCE_SCRIPT_COPY}" ]] || die \
    "Neither ${DB_FENCE_SCRIPT} nor the root-owned copy at ${DB_FENCE_SCRIPT_COPY} exists, so this run cannot hold the database closed for the migration window. A snapshot probe is not a fence. Restore the script (it ships with the app) and re-run; nothing has been migrated."
  # THE FENCE IS TOLD WHICH CONNECTION IT IS ABOUT, OR IT DOES NOT RUN (o3d-2sm1.5 r19). Reaching
  # here before the PostgreSQL section has filled these in means this run has no database of its
  # own yet, and a fence over an unnamed connection is exactly what this round removed.
  require_db_identity || die \
    "The application's database has not been set up yet in this run, so there is no host, port, role and database to tell the connection fence about. The fence is TOLD which connection it closes — it no longer works that out from the environment. Nothing has been migrated."
  mkdir -p "${DB_FENCE_DIR}"
  chown "${APP_USER}:${APP_USER}" "${DB_FENCE_DIR}"
  chmod 700 "${DB_FENCE_DIR}"

  # THE ONLY FILE THIS FUNCTION RUNS IS THE ROOT-OWNED ONE (o3d-2sm1.5 r31, Codex CRITICAL).
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || die \
    "This run has no fence script it is willing to execute (the reason is printed above), so it cannot hold the database closed for the migration window. A snapshot probe is not a fence. Nothing has been migrated."
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${fence_script}" --fence --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" ) || rc=$?

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
        node "${fence_script}" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}" )" || die \
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
    5)
      # EXIT 5 IS A FENCE THAT IS STANDING RIGHT NOW (o3d-2sm1.5, Codex r13 HIGH).
      #
      # It is raised for an INDETERMINATE commit too (o3d-2sm1.5, Codex r14 HIGH): if the
      # acknowledgement of COMMIT is lost, the transaction's fate is unknown, and unknown is not
      # the not-committed case. The script reports exit 5 there as well, so this arm covers it.
      #
      # THE STICKY FLAG USED TO BE RAISED ONLY ON EXIT 0, so "the fence did not succeed" was
      # read as "no fence was raised" — and an exit code is not evidence about what was
      # committed. fence-db-connections.mjs COMMITS its REVOKEs and then asks whether the door
      # is actually shut; when the application keeps CONNECT through role membership, or the
      # room will not go quiet, it DELIBERATELY LEAVES THEM STANDING so nothing is half-applied.
      # PUBLIC, monitoring, backup, BI and any second application are locked out at that
      # moment. With the flag left false, an exit-4 release during cleanup — no record, and only
      # the application role's own CONNECT provable — took the warning-success branch, lowered
      # DB_FENCE_UP and let this run record a release nobody performed, over grantees still
      # revoked and now unrecorded.
      #
      # So the flag is raised for EVERY post-commit result, and the unproven release verdict is
      # fatal after one. This arm aborts like exit 3 does, but it says the opposite thing about
      # the database: exit 3 revoked nothing, this revoked and is holding.
      DB_FENCE_UP=true
      DB_FENCE_RAISED=true
      die "THE FENCE MAY BE STANDING AND CANNOT BE CALLED GOOD (exit 5): the REVOKEs were COMMITTED, or were issued to a COMMIT whose acknowledgement was lost — the reason this run will not call the database fenced is printed above. CONNECT may currently be denied to every grantee it took it from, which may include PUBLIC, monitoring, backup, BI and a second application, so this is NOT a run that changed nothing. Nothing has been migrated. Release it before starting anything: ${DB_FENCE_RELEASE_CMD}"
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
    "This run is a cutover — ${CUTOVER_REASON:-an existing installation was detected} — so the database must be held closed while the schema moves, but DEPLOY_ADMIN_DATABASE_URL is not set, so this run has no privileged connection that would survive revoking CONNECT from the application role. Set it (a superuser or database-owner connection as a DIFFERENT role from DATABASE_URL; docs/installation.md) and re-run. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_FENCE_SCRIPT}" || -f "${DB_FENCE_SCRIPT_COPY}" ]] || die \
    "Neither ${DB_FENCE_SCRIPT} nor the root-owned copy at ${DB_FENCE_SCRIPT_COPY} exists, so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  [[ -f "${DB_OBJECT_ACCESS_SCRIPT}" ]] || die \
    "${DB_OBJECT_ACCESS_SCRIPT} is missing from this checkout, so nothing would check that the application role can use what the migration creates. Nothing has been stopped and nothing has been migrated."
  require_db_identity || die \
    "The application's database has not been set up yet in this run, so there is no host, port, role and database to tell the connection fence about. The fence is TOLD which connection it closes — it no longer works that out from the environment. Nothing has been stopped and nothing has been migrated."

  # AND IT IS RUN, NOT LOOKED AT (o3d-2sm1.5, Codex r4 HIGH). This used to be `[[ -f ... ]]`,
  # which proves a file exists and nothing about whether it works — and its own dependency was
  # a devDependency while the documented manual upgrade runs `npm ci --omit=dev`, so the fence
  # died with a missing module at drain-verify, AFTER the stop. --preflight runs the same
  # imports, opens the same admin connection and asks the same questions as --fence, and
  # revokes, terminates and writes nothing.
  #
  # AND IT IS RUN FROM THE PROTECTED COPY, LIKE EVERY OTHER MODE (o3d-2sm1.5 r31). This probe
  # opens the admin connection as the application user; on an ordinary upgrade it is what
  # PUBLISHES the protected copy, so the bytes preflighted here are the bytes the fence is raised
  # with later, and the application account gets no window between the two.
  local rc=0 preflight_script
  preflight_script="$(resolve_fence_script)" || die \
    "This run has no fence script it is willing to execute (the reason is printed above), so the migration window cannot be fenced. Nothing has been stopped and nothing has been migrated."
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${preflight_script}" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" ) || rc=$?
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
  # AND THE SCRIPT IT ASKS WITH IS THE PROTECTED ONE (o3d-2sm1.5 r31, Codex CRITICAL). A release
  # GRANTS CONNECT back from a record of what was revoked, as the application user and with
  # DEPLOY_ADMIN_DATABASE_URL in its environment; running the checkout's own file for that let the
  # account being released rewrite what "released" means, and report success without doing it.
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || { error "Cannot release the connection fence: this run has no fence script it is willing to execute (the reason is printed above), so nothing here can ask the database whether one is standing."; return 1; }
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${fence_script}" --release --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" ) || rc=$?

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
  # o3d-2sm1.5 r32: see the same lines in scripts/deploy.sh. The state file is application-owned
  # by necessity, so an instruction to run what it holds has to say what it is.
  error "READ them first: that file is written by the fence AS ${APP_USER} and lives in an"
  error "application-writable directory, so it is evidence to check, not SQL to paste unseen."
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
  [[ -f "${DB_FENCE_SCRIPT}" || -f "${DB_FENCE_SCRIPT_COPY}" ]] || return 1
  [[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || return 1
  # No identity, no fence (o3d-2sm1.5 r19). A soft refusal — this runs inside the exit trap, and
  # aborting there would lose the status and the banner.
  require_db_identity || return 1
  # THE EXIT TRAP RUNS THE PROTECTED COPY TOO (o3d-2sm1.5 r31, Codex CRITICAL). This is the path
  # that runs when everything else has already gone wrong and nothing else is watching, which is
  # exactly where substituted code would most like to be handed the admin credential.
  local rc=0 fence_script
  fence_script="$(resolve_fence_script)" || return 1
  ( cd "${APP_DIR}" && run_as_user "${APP_USER}" env \
      DATABASE_URL="${DATABASE_URL}" \
      DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \
      node "${fence_script}" --fence --state-file="${DB_FENCE_STATE}" "${DB_FENCE_IDENTITY_ARGS[@]:-}" ) || rc=$?
  # EVERY POST-COMMIT RESULT RAISES THE STICKY FLAG (o3d-2sm1.5, Codex r13 HIGH). Exit 5 says
  # the REVOKEs are COMMITTED and standing: this call could not call the database fenced, but it
  # certainly fenced something, and DB_FENCE_RAISED is the flag that decides whether a later
  # "no record, and only the application role's own CONNECT is provable" release may be walked
  # past. Raised here, that release becomes the refusal it should always have been.
  if [[ "${rc}" -eq 5 ]]; then
    DB_FENCE_UP=true
    DB_FENCE_RAISED=true
    warn "THE RE-FENCE COMMITTED ITS REVOKES AND COULD NOT CALL THE DATABASE FENCED (exit 5)."
    warn "CONNECT is denied to the grantees it was taken from and nothing here has given it back,"
    warn "so this is a fence and not a no-op - but it was NOT proven to shut the application out."
    warn "The reason is printed above (usually CONNECT reaching the application through role"
    warn "membership, or a backend that would not drain). Do not trust it as a fence; it still has"
    warn "to be released before anything starts:"
    warn "  ${DB_FENCE_RELEASE_CMD}"
    return 1
  fi
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
    node "${fence_script}" --print-migration-url "${DB_FENCE_IDENTITY_ARGS[@]:-}" )" || url_rc=$?
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
    # AND IF THIS RUN DID CHANGE A CREDENTIAL, THE BANNER SAYS SO (o3d-2sm1.5 r37, Codex HIGH).
    # NOTHING REACHES HERE AFTER A CREDENTIAL CHANGE ANY MORE (o3d-2sm1.5 r38, Codex HIGH). r37
    # left the rotation on this side of the stop and printed a paragraph here explaining what the
    # operator now had to reconcile. The rotation has moved past the stop and the fence, so this
    # banner — which is the REVERSIBLE path, the one that says "nothing has to be recovered
    # first" — can say the credential is untouched and be telling the truth.
    #
    # THE CHECK IS KEPT AND INVERTED, because "always false" is exactly the kind of claim this
    # branch keeps discovering was quietly no longer true. If a later edit ever moves an ALTER
    # back in front of the stop, this says so in the failure banner instead of the operator
    # finding out from their application's logs.
    #
    # DEFAULTED, BECAUSE THIS IS A TRAP. Every variable an exit handler reads has to survive being
    # read before the assignment that sets it: the whole point of the handler is that it runs on
    # paths the straight-line code never reached. Under `set -u` an unset name here would abort
    # the trap mid-banner and skip unwind_arming() below — the cleanup, not just the message.
    if ${DB_ROLE_CREDENTIALS_ROTATED:-false}; then
      warn "  credentials : ORDERING DEFECT — the password of the PRE-EXISTING role ${DB_USER:-<none>} was"
      warn "                changed BEFORE anything was stopped. It should not be possible to reach"
      warn "                this banner in that state: the rotation belongs inside the stopped,"
      warn "                fenced window. The application's environment file and the database"
      warn "                agree, so this host is consistent, but any OTHER client still using the"
      warn "                previous password for that role needs the new one, and the predecessor"
      warn "                this run left running may already have lost its reconnect."
    else
      warn "  credentials : UNCHANGED. No database password was rotated: a rotation, when one is"
      warn "                asked for at all, happens only after the stop and behind the connection"
      warn "                fence, so the predecessor still running here holds a credential that"
      warn "                works and its environment file still names it."
    fi
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
  # AND WHETHER THE CREDENTIAL MOVED (o3d-2sm1.5 r38, Codex HIGH). This is the path where a
  # rotation CAN have happened — it is performed after the stop, behind the fence — so the
  # operator is told, here, that the role's password is no longer the one anything else on this
  # server is using. Defaulted for the same `set -u` reason as the banner above.
  if ${DB_ROLE_CREDENTIALS_ROTATED:-false}; then
    error "  credentials : the password of the PRE-EXISTING role ${DB_USER:-<none>} WAS ROTATED inside"
    error "                this window, and ${APP_DIR:-<app dir>}/.env names the new one, so those"
    error "                two agree. ALTER USER is cluster-wide: any OTHER client on this server"
    error "                authenticating as that role, against ANY database, needs the new"
    error "                password. Re-running this installer with the same value changes nothing"
    error "                further."
  else
    error "  credentials : UNCHANGED — no database password was rotated by this run."
  fi
  error "  Do NOT start ${APP_NAME}.service by hand. Fix the cause and re-run this"
  error "  installer, scripts/update.sh or scripts/deploy.sh — all three read this fence"
  error "  from the same place (${FENCE_FILE}) and adopt it."

  systemctl stop "${APP_NAME}.service" >/dev/null 2>&1 || true
  # AND THE BINDING COMES OFF, ALWAYS (o3d-2sm1.5 r23). The environment snapshot pins
  # DATABASE_URL over ${APP_DIR}/.env for as long as its drop-in is loaded, and it is only ever
  # right for the run that published it. Left standing after a failure it would silently override
  # a later, legitimate edit of the file — and the operator's first move after reading this
  # banner is usually to edit that file.
  remove_db_identity_snapshot
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
      error "    ${DB_FENCE_REFENCE_CMD}"
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
# The same shape check update.sh applies to the value it reads back out of .env (o3d-2sm1.5 r26,
# Codex HIGH). Here it is not a parsing question — the value came from a prompt or, under
# --non-interactive, from the invocation's own environment — but it lands in exactly the same
# places: `next start -p ${APP_PORT}` in the unit, the nginx upstream, the crontab base URL and
# the health URL this script polls before declaring the install irreversible. Refusing at the
# prompt costs a re-run; refusing later costs a half-installed host.
valid_tcp_port "${APP_PORT}" || die "APP_PORT must be a decimal TCP port in 1-65535, not '${APP_PORT}'. It is written into the systemd unit's \`next start -p\`, the nginx upstream, the cron base URL and the health check this installer polls."
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

# THE INSTALLED DATABASE CREDENTIAL, RECOVERED THE WAY REDIS_URL ALREADY WAS (o3d-2sm1.5 r38,
# Codex HIGH).
#
# The asymmetry this closes: REDIS_URL and REDIS_PASSWORD have been recovered out of the previous
# ${APP_DIR}/.env for rounds, so an operator pressing Enter through an upgrade keeps both ends of
# the Redis credential. DATABASE_URL was not, and its prompt defaulted to `openssl rand -hex 16` —
# a NEW secret on every run. So an ORDINARY RE-INSTALL rotated the live database role's password
# as a side effect of running the script, over a predecessor that was still serving.
#
# AND IT IS RECOVERED ONLY WHEN IT IS THE SAME CONNECTION. A password is not a property of this
# host, it is a property of one role on one server; offering the previous run's secret back after
# the operator has changed DB_USER, DB_HOST, DB_PORT or DB_NAME would compose a DATABASE_URL that
# cannot authenticate and — worse — would make a genuine first credential look like a rotation.
# So all four are compared, and anything that does not match answers "nothing installed", which
# takes the same path as a first install.
#
# THE USERINFO IS PERCENT-DECODED, AND THAT IS A CORRECTION (o3d-2sm1.5 r39, Codex HIGH). r38
# deliberately did NOT decode, reasoning that this installer composed the URL by raw interpolation
# so decoding would invent a different secret. That was an accurate description of the shipped code
# and the shipped code was wrong: raw interpolation IS the defect, because node-postgres decodes
# what it reads. The credential the application actually authenticates with is the DECODED one, so
# that is the value this function must return — otherwise "has the operator asked for a rotation?"
# is answered by comparing a literal against URL bytes, and an ordinary re-install over a password
# containing `%2F` reports a rotation nobody asked for. Since r39 the composer percent-encodes, so
# for anything this installer wrote the decode is the exact inverse of the encode; for a URL an
# older run left behind it reproduces what pg-connection-string does with the same bytes.
#
# The userinfo ends at the LAST `@` for the reason redact_url_credentials() cuts there: an earlier
# one may be part of the password itself — and WHATWG URL parsing agrees, which is why a legacy
# raw `user:abc@def@host` still recovers `abc@def`.
installed_database_password() {
  local url="$1" want_user="$2" want_host="$3" want_port="$4" want_db="$5"
  local rest userinfo location user password host port database
  case "${url}" in
    postgres://*|postgresql://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  case "${rest}" in *@*) ;; *) return 1 ;; esac
  userinfo="${rest%@*}"
  location="${rest##*@}"
  case "${userinfo}" in *:*) ;; *) return 1 ;; esac
  # `capture`, NOT `$( )`, on BOTH halves (o3d-2sm1.5 r40, Codex HIGH). A password spelled
  # `abc%0A` decodes to `abc\n`, and command substitution would hand back `abc` — a DIFFERENT
  # credential, which classify_database_credential_rotation() then reads as a rotation request
  # over a live role. The user half goes through the same door for the same reason one level
  # down: `imsuser%0A` captured as `imsuser` compares EQUAL to a DB_USER of `imsuser`, so a URL
  # naming a different role would be accepted as "the same connection" and its password recovered.
  capture user url_decode_userinfo "${userinfo%%:*}"
  password="${userinfo#*:}"
  [[ -n "${password}" ]] || return 1
  capture password url_decode_userinfo "${password}"
  [[ -n "${password}" ]] || return 1
  case "${location}" in */*) ;; *) return 1 ;; esac
  database="${location#*/}"
  database="${database%%\?*}"
  location="${location%%/*}"
  case "${location}" in *:*) ;; *) return 1 ;; esac
  host="${location%:*}"
  port="${location##*:}"
  [[ "${user}" == "${want_user}" ]] || return 1
  [[ "${host}" == "${want_host}" ]] || return 1
  [[ "${port}" == "${want_port}" ]] || return 1
  [[ "${database}" == "${want_db}" ]] || return 1
  printf '%s' "${password}"
}

# The prompt, on both branches, so the recovery cannot be true of one and not the other. It runs
# AFTER DB_USER/DB_HOST/DB_PORT/DB_NAME are known, because whether there is anything to recover
# is a question about those four.
prompt_db_password() {
  # FIRST, BECAUSE A STALE .env IS EXACTLY WHAT AN INTERRUPTED ROTATION LEAVES (o3d-2sm1.5 r39,
  # Codex HIGH). Nothing has been touched at this point, so a refusal in here is safe; and where it
  # does not refuse, the SERVER's answer replaces the file's, which is the whole content of
  # "reconcile" — the file says what the last completed publication said, and the ALTER may have
  # outlived it.
  reconcile_interrupted_role_rotation
  # THE OUTER CAPTURE IS THE SAME BOUNDARY (o3d-2sm1.5 r40, Codex HIGH): fixing the decode and
  # then re-stripping the result here would have preserved nothing. `existing_env` needs no such
  # protection and is left as it is — it returns a value `mapfile -t` read out of a LINE of
  # ${APP_DIR}/.env, and a line cannot carry the newline that ends it.
  capture DB_PASSWORD_INSTALLED installed_database_password "$(existing_env DATABASE_URL)" "${DB_USER}" "${DB_HOST}" "${DB_PORT}" "${DB_NAME}" || DB_PASSWORD_INSTALLED=""
  if ${DB_ROTATION_JOURNAL_FOUND}; then
    DB_PASSWORD_INSTALLED="${DB_ROTATION_RECONCILED_PASSWORD}"
    info "The installed credential for this run is the one the SERVER answered to, not the one"
    info "${APP_DIR}/.env carries: an interrupted rotation was reconciled above. Pressing Enter"
    info "finishes that transition — the environment file this run writes will name it."
  fi
  if [[ -n "${DB_PASSWORD_INSTALLED}" ]]; then
    info "${APP_DIR}/.env already names ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}, so the credential it"
    info "carries is the default here. Pressing Enter changes NOTHING about the role: this installer"
    info "does not rotate a live database credential as a side effect of being re-run. Supplying a"
    info "DIFFERENT password asks for a rotation, which is performed after the existing installation"
    info "has been stopped and the database fenced — never while it is still serving."
    prompt DB_PASSWORD "Database password" "${DB_PASSWORD_INSTALLED}" "secret" "$(mask_secret "${DB_PASSWORD_INSTALLED}")"
  elif [[ "${INSTALL_POSTGRES}" == "y" ]]; then
    prompt DB_PASSWORD "Database password" "$(openssl rand -hex 16)" "secret"
  else
    prompt DB_PASSWORD "Database password" "" "secret"
  fi
}

echo ""
info "--- PostgreSQL ---"
prompt_yn INSTALL_POSTGRES "Install PostgreSQL on this server?" "y"
if [[ "$INSTALL_POSTGRES" == "y" ]]; then
  prompt DB_NAME      "Database name"           "one_two_inventory"
  prompt DB_USER      "Database user"           "imsuser"
  DB_HOST="localhost"
  DB_PORT="5432"
  prompt_db_password
else
  prompt DB_HOST      "PostgreSQL host"         "localhost"
  prompt DB_PORT      "PostgreSQL port"         "5432"
  prompt DB_NAME      "Database name"           "one_two_inventory"
  prompt DB_USER      "Database user"           "imsuser"
  prompt_db_password
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
    # THE REDIS CREDENTIAL CROSSES THE SAME BOUNDARY (o3d-2sm1.5 r40, Codex HIGH). This recovery
    # is the reason `%0A` can be in a URL at all — REDIS_URL has been recovered and re-encoded for
    # rounds — and a requirepass ending in a newline was truncated here, so the re-run wrote a
    # redis.conf and a URL that disagreed with the server by one byte.
    capture EXISTING_REDIS_USERNAME urldecode "${EXISTING_REDIS_USERINFO%%:*}"
    capture EXISTING_REDIS_PASSWORD urldecode "${EXISTING_REDIS_USERINFO#*:}"
  else
    capture EXISTING_REDIS_USERNAME urldecode "${EXISTING_REDIS_USERINFO}"
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

  # @install-phase: database-newness
  #
  # EVERYTHING HERE IS EITHER A QUESTION OR A CREATION (o3d-2sm1.5 r37, Codex HIGH). This block
  # used to CREATE OR ALTER the application role and its password, then decide newness, then
  # GRANT and change the database's OWNER — all of it before this run had asked whether it is a
  # cutover and long before it had established that it could fence one. On a fresh application
  # host pointed at a PRE-EXISTING, LIVE database, a missing DEPLOY_ADMIN_DATABASE_URL or a
  # missing fence artefact then aborted the run 400 lines later, saying "nothing has been stopped
  # and nothing has been migrated" — over a database whose application role had already had its
  # password changed and whose ownership had already moved. Existing writers lost their
  # reconnect, and the refusal claimed the box was untouched.
  #
  # It is the principle this file already applies everywhere else, arriving late at the one place
  # that needed it most: A REFUSAL IS ONLY SAFE AT A POINT WHERE REFUSING LEAVES THE SYSTEM
  # CONSISTENT. So what stays here is only what a run must do to ANSWER the question, and only
  # what cannot take anything away from anybody:
  #
  #   ensure_database_role_exists         CREATEs the role when it is absent; an absent role has
  #                                       no clients, so creating it changes nothing for anyone.
  #                                       On a role that is ALREADY there it does nothing at all
  #                                       and records that fact. It is here rather than later
  #                                       because fence-db-connections.mjs --preflight refuses
  #                                       outright when --app-user names a role that does not
  #                                       exist, so the preflight that gates the fenced path
  #                                       needs the role to be present to answer.
  #   create_database_and_record_newness  CREATE DATABASE, which either creates a database that
  #                                       by definition had no writers, or is refused as a
  #                                       duplicate. Neither outcome alters an existing object.
  #
  # THE ALTER, THE GRANT AND THE OWNER CHANGE MOVED to provision_database_role_and_privileges(),
  # which runs after this run knows which path it is on and — on a cutover — after
  # require_fenceable_database() has proved a fence is possible.
  info "Creating database '${DB_NAME}' and user '${DB_USER}'..."
  ensure_database_role_exists
  create_database_and_record_newness
fi

# WHICH CREDENTIAL EVERY CONNECTION BEFORE THE STOP USES (o3d-2sm1.5 r38, Codex HIGH).
#
# A rotation was asked for when all three are true: the role was ALREADY on this server when this
# run arrived (so somebody may be using it), ${APP_DIR}/.env named a password for this exact
# connection, and the operator supplied a different one. Anything indeterminate — no recoverable
# installed password, a role this run created itself, an external database this script does not
# administer — is NOT a rotation, and nothing is ALTERed at all.
#
# When one IS pending, DATABASE_URL keeps the OLD credential for the whole pre-stop window. That
# is what .env is written with, what `prisma generate` and `npm run build` are handed through
# MIGRATION_DATABASE_URL, and what the fence preflight opens the application connection with — so
# a build that fails leaves a predecessor whose environment file and whose database still agree.
# rotate_database_password_in_fenced_window() replaces both, together, after the stop.
#
# IT IS A FUNCTION AND NOT FOUR STRAIGHT-LINE STATEMENTS so the tests can run these bytes instead
# of a copy of them: a regression that re-implements the decision it is checking proves only that
# its author can write the decision twice.
classify_database_credential_rotation() {
  DB_PASSWORD_EFFECTIVE="${DB_PASSWORD}"
  DB_PASSWORD_ROTATION_PENDING=false
  if ${DB_ROLE_PREEXISTED} && [[ -n "${DB_PASSWORD_INSTALLED}" && "${DB_PASSWORD}" != "${DB_PASSWORD_INSTALLED}" ]]; then
    DB_PASSWORD_ROTATION_PENDING=true
    DB_PASSWORD_EFFECTIVE="${DB_PASSWORD_INSTALLED}"
    warn "A password DIFFERENT from the one ${APP_DIR}/.env carries was supplied for the PRE-EXISTING"
    warn "role '${DB_USER}', so this run will rotate it — but not yet. Everything up to and including"
    warn "the build uses the credential the server already has; the ALTER happens once the existing"
    warn "installation is stopped and the database is fenced."
  fi
  DATABASE_URL="$(compose_database_url "${DB_USER}" "${DB_PASSWORD_EFFECTIVE}" "${DB_HOST}" "${DB_PORT}" "${DB_NAME}")"
}

classify_database_credential_rotation

# THE SAME FOUR VALUES THE URL ABOVE WAS COMPOSED FROM, handed to the connection fence rather
# than parsed back out of it (o3d-2sm1.5 r19). Nothing is derived, so nothing can be derived
# wrongly; and because the URL states all four, no PGHOST/PGPORT/PGUSER/PGDATABASE in any
# process can move the connection away from them.
DB_FENCE_IDENTITY_ARGS=(
  "--app-host=${DB_HOST}"
  "--app-port=${DB_PORT}"
  "--app-user=${DB_USER}"
  "--app-database=${DB_NAME}"
)

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

# THE FILE THIS INSTALLER OWNS, WRITTEN FROM THE VARIABLES IT HOLDS — AND WRITABLE TWICE
# (o3d-2sm1.5 r38, Codex HIGH).
#
# It is a function because a credential rotation happens LATER, after the predecessor has been
# stopped and the database fenced, and the file then has to name the new credential. The obvious
# alternative — reach into ${APP_DIR}/.env and substitute the one line — makes install.sh a
# SECOND READER of an application-owned file, which is the thing tests/scripts/deploy-order.test.ts
# forbids outright and for good reason: the account that owns that file is the account this script
# is protecting the database from. Re-running the write is not a read at all. Every value in it is
# a variable this process is already holding, so the second write differs from the first in
# exactly the bytes the rotation changed.
#
# WHICH IS WHY THE STAMP IS HOISTED. `$(date ...)` inline made the two writes differ in a line
# that has nothing to do with the change, and "exactly one line moved" is an assertion the
# regressions make.
ENV_FILE_GENERATED_AT="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"

# RENDERED WHOLE FROM HELD VARIABLES, THEN PUBLISHED BY RENAME (o3d-2sm1.5 r39, Codex HIGH).
#
# `cat > "${APP_DIR}/.env"` TRUNCATED the application's only environment file and then filled it,
# so every instant of the write was a state in which the file existed and did not say what the
# database needed. That is the same defect publish_durable_file() was written for, in the one file
# that is read by a service the installer has just stopped and is about to start.
#
# The render happens FIRST and INTO A VARIABLE, so a failure while producing the content cannot
# reach the publication at all — a pipeline would have renamed whatever bytes it had received
# before the producer died. Command substitution strips trailing newlines and `printf '%s\n'`
# restores the single one the heredoc ends with, so the published bytes are the rendered bytes.
render_app_env_file() {
cat <<EOF
# One Two Inventory — generated by install.sh on ${ENV_FILE_GENERATED_AT}

NODE_ENV=production
# What this deployment IS, as opposed to what it was built as. NODE_ENV is set
# by the build and says "production" on stage and on a test rig too, so it
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
}

# Ownership and mode travel with the publication rather than following it: publish_durable_file()
# applies both to the temporary file, before the barrier and before the rename, so there is no
# instant at which ${APP_DIR}/.env exists as a file the application account cannot read.
#
# IT RETURNS A STATUS AND EVERY CALLER ACTS ON IT. The old writer could not fail visibly — `cat >`
# under `set -e` aborted the script from wherever it stood, and the `chown` and `chmod` after it
# were not checked at all, so a refused chown left the trap claiming the file agreed with the
# server.
write_app_env_file() {
  local rendered
  rendered="$(render_app_env_file)" || return 1
  [[ -n "${rendered}" ]] || return 1
  printf '%s\n' "${rendered}" | publish_durable_file "${APP_DIR}/.env" "${APP_USER}:${APP_USER}" 600 || return 1
  return 0
}

write_app_env_file || die "${APP_DIR}/.env could not be written. Nothing has been stopped and nothing has been migrated; the file at that path is whatever the previous run left there, complete and unchanged — it is published by rename, so there is no half-written state to clean up."
success ".env written to ${APP_DIR}/.env"
# The publication the interrupted-rotation journal was waiting for has now happened, and it named
# DB_PASSWORD_EFFECTIVE — which reconcile_interrupted_role_rotation() has already set to the
# credential the SERVER answered to. Cases (2) and (3) end here; case (1) ends here having changed
# nothing.
resolve_role_rotation_journal_after_env_publication

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

# WHICH PATH THIS RUN TAKES, AND WHAT HAS TO BE TRUE TO SKIP THE FENCE (o3d-2sm1.5 r36, Codex
# CRITICAL). TWO independent questions, and EITHER answer sends this run down the fenced path:
#
#   1. Is there something on THIS HOST to break?      upgrade_in_place()
#   2. Did THIS RUN create the database it will migrate?  first_install_exemption_available()
#
# The second used to be assumed from the first. It is not implied by it and never was: a fresh
# application host pointed at an existing remote database answers "nothing here to break" and
# "someone else's live data" at the same time, and the old branch let that run migrate unfenced.
# So the exemption is granted only when BOTH come back, and anything the installer cannot
# positively establish — every external database, every pre-existing local one, every
# indeterminate result — falls to the fenced path.
if upgrade_in_place; then
  FENCED_CUTOVER=true
  CUTOVER_REASON="an existing installation was found on this host: a service unit, a live crontab, a PM2 instance or a process running in ${APP_DIR}"
elif ! first_install_exemption_available; then
  FENCED_CUTOVER=true
  CUTOVER_REASON="${FIRST_INSTALL_EXEMPTION_REFUSAL}"
fi

if ${FENCED_CUTOVER}; then
  UPGRADE_EXISTING=true
  header "This run is a cutover — the migration window will be fenced"
  info "${CUTOVER_REASON}"

  # Installed before anything is armed, so that a kill or a power cut anywhere below
  # leaves the marker, the drop-in and a stopped service rather than a running one.
  trap on_cutover_exit EXIT

  # BEFORE ANYTHING IS STOPPED, AND BEFORE THE BUILD. A database this run did not create has
  # to be held closed while its schema moves — whether the writer is this host's own previous
  # installation or somebody else's, which is the case the second branch question added — and
  # discovering at the drain step that it cannot be would cost an outage for a missing
  # environment variable, or, once, for a missing node module.
  require_fenceable_database

  CUTOVER_STEP="adopt"
  # A fence a previous run left standing is adopted here, so a rebuild that has to run
  # inside a HELD fence gets MIGRATION_DATABASE_URL before the build needs it.
  acquire_cutover_lock
  import_legacy_cutover_state
  adopt_existing_fence

  # AND ONLY NOW IS THE DATABASE'S ROLE TOUCHED (o3d-2sm1.5 r37, Codex HIGH). Everything above
  # this line either asked a question or created something that did not exist; every refusal
  # above it — no DEPLOY_ADMIN_DATABASE_URL, no fence artefact, a preflight the database itself
  # rejected, a cutover lock somebody else holds — therefore lands on a database whose
  # application role still has the password its existing clients are using, and whose owner is
  # unchanged. The fence has been proved possible, and an adopted one is already standing.
  provision_database_role_and_privileges
else
  # A ROTATION HAS NOWHERE SAFE TO HAPPEN ON THIS PATH (o3d-2sm1.5 r38, Codex HIGH). The exemption
  # says THIS run created THIS database, so nothing is serving it — but the ROLE is cluster-wide
  # and DB_PASSWORD_ROTATION_PENDING is only ever set over a role this run did NOT create. It is
  # therefore somebody else's role, on some other database, with no window to fence and no service
  # to stop. Refused here, before the build and before anything is written to the database.
  if ${DB_PASSWORD_ROTATION_PENDING}; then
    die "A password different from the installed one was supplied for '${DB_USER}', but this run has taken the first-install exemption: it created database '${DB_NAME}' itself and there is no existing installation to stop and no migration window to fence. The role '${DB_USER}' was ALREADY on this server, so rotating it would take the credential away from whatever else uses it, with nothing held closed. Re-run with the password that role already has, or rotate it deliberately on the server first. NOTHING HAS BEEN MIGRATED and the role's password is UNCHANGED."
  fi

  first_install_fence_policy

  # Nothing is serving, no crontab is live, and create_database_and_record_newness() proved this
  # run created the database on the server it is about to migrate — so there is no client whose
  # credentials this can take away.
  provision_database_role_and_privileges
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

  # AND ONLY NOW MAY A WORKING CREDENTIAL BE TAKEN AWAY (o3d-2sm1.5 r38, Codex HIGH). Nothing is
  # serving, the reboot fence is standing, the crontab is fenced, the port is free, the connection
  # fence is up and the database has just said no other backend is attached. This is a no-op
  # unless the operator supplied a password different from the installed one.
  CUTOVER_STEP="rotate-credential"
  rotate_database_password_in_fenced_window
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

# BIND THE SERVICE TO THE DATABASE THIS RUN MIGRATED, BEFORE THE RELOAD THAT LOADS THE UNIT
# (o3d-2sm1.5 r23, Codex HIGH). The unit above loads ${APP_DIR}/.env with a leading `-`, and
# systemd does not read it until it EXECS — at the far end of a window that has held a git
# clone, an npm install, a Next build and a migration. Nothing in this script re-read it, and
# re-reading it would not have helped: a read cannot bind a file somebody else can replace.
#
# So the value THIS RUN fenced and migrated with — the shell variable, not a re-read — is
# published under the cutover state directory, root-owned and 0600, and the unit is given a
# drop-in that loads it LAST. systemd keeps the last definition of a variable across environment
# files, so it beats whatever ${APP_DIR}/.env has come to say; and it is loaded with NO leading
# `-`, so if it is gone the start fails instead of falling back.
publish_db_identity_snapshot || die \
  "The application service could not be bound to the database this run fenced and migrated (the reason is printed above). The connection fence is still up and nothing has been started. Without the binding, the DATABASE_URL systemd reads at exec is whatever ${APP_DIR}/.env says at that instant, which is not something this script can hold still. Fix the cause and re-run; the re-run adopts the standing fence."

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

# THE ENABLE HAPPENS HERE, AHEAD OF THE FINAL RELOAD, AND ONLY THE START COMES AFTER THE PROOF
# (o3d-2sm1.5 r24, Codex HIGH). This used to be one `systemctl enable --now` below
# require_start_identity_bound, and `systemctl enable` RELOADS SYSTEMD IMPLICITLY unless it is
# given --no-reload — so the command that started the service also re-read every unit file and
# every drop-in on disk AFTER the proof that the loaded configuration binds it to this run's
# snapshot, which is the one thing that proof claimed nothing between it and the start could do.
#
# Splitting it puts every unit-file operation upstream of remove_reboot_fence()'s daemon-reload
# and leaves `start` as the only systemctl verb after the verification; `start` acts on the
# loaded configuration and does not re-read unit files. It is done BY CONSTRUCTION rather than
# with --no-reload, which would leave the invariant depending on every future caller remembering
# a flag.
#
# Enabling this early starts nothing — it writes the multi-user.target wants symlink — and the
# reboot fence is still standing, so a machine that reboots in this window still refuses to bring
# the service up.
systemctl enable "${APP_NAME}.service"

release_db_connections \
  || die "Refusing to start the application while it has no CONNECT on its own database."
remove_reboot_fence

# THE COMPOSED UNIT, ASKED OF SYSTEMD AFTER THE LAST daemon-reload (o3d-2sm1.5 r23, Codex HIGH).
# remove_reboot_fence() has just issued it, so this is the first moment the LOADED configuration
# can be read and the last before the start. Three things are proved here and nothing is assumed:
# nothing but ${APP_DIR}/.env and this run's snapshot can define DATABASE_URL for the service
# (no Environment=, PassEnvironment=, UnsetEnvironment=, PAMName= or third environment file — a
# drop-in that survived from some other tool included); the snapshot is loaded LAST and
# MANDATORILY; and ${APP_DIR}/.env still states the value this run migrated with.
#
# It is atomic with respect to the start in the one way that matters: the SET of environment
# files is unit configuration, fixed at daemon-reload and not re-read by `systemctl start`, and
# nothing between this line and the start runs a unit-file command at all. That claim was FALSE
# until r24 — this was `systemctl enable --now`, and `enable` reloads systemd IMPLICITLY unless
# it is given --no-reload, so the command that started the service also re-read every unit file
# and drop-in on disk after the proof. The enable now happens above remove_reboot_fence()'s
# reload and only `start` is left here; the complete list of commands in the window is this
# `success` line and that start.
require_start_identity_bound || die \
  "THE APPLICATION IS NOT BEING STARTED: ${DB_IDENTITY_SOURCE_REASON}. This was checked after the final daemon-reload, so it is the unit's loaded configuration that systemd is about to act on. The migration applied and every verification passed; fix the unit (or ${APP_DIR}/.env) and re-run, which adopts the state this run left. Do NOT start the service by hand first."

systemctl start "${APP_NAME}.service"

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

# THE BINDING COMES OFF HERE, on the success path (o3d-2sm1.5 r23). The service is running and
# has answered its health check, so it already HAS the environment; the drop-in has nothing left
# to do and everything to break, because from now on it would override ${APP_DIR}/.env for every
# restart, reboot and Restart= until somebody noticed a file in /etc/systemd/system that no
# document mentions. Removing it does not touch the running process.
remove_db_identity_snapshot

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
