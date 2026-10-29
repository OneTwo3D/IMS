# shellcheck shell=bash
# Shared helpers for deploy.sh, rollback.sh, cron-render.sh and host-bootstrap.sh. Sourced, never executed.
#
# Every path and port below can be overridden through the environment. Production uses the defaults; the tests (deploy/tests) point them
# at a scratch directory and put stub docker/nginx/curl on PATH. Nothing here has a default that reaches outside the paths named below.

IMS_ENV_FILE="${IMS_ENV_FILE:-/etc/ims/ims.env}"
IMS_CRON_ENV_FILE="${IMS_CRON_ENV_FILE:-/etc/ims/cron.env}"
IMS_STATE_DIR="${IMS_STATE_DIR:-/srv/ims/state}"
IMS_DEPLOY_DIR="${IMS_DEPLOY_DIR:-/srv/ims/deploy}"
IMS_UPSTREAM_FILE="${IMS_UPSTREAM_FILE:-/etc/nginx/ims-upstream.conf}"
IMS_CROND_DIR="${IMS_CROND_DIR:-/etc/cron.d}"
IMS_CROND_NAME="${IMS_CROND_NAME:-onetwo3d-ims}"
IMS_REGISTRY="${IMS_REGISTRY:-ghcr.io/onetwo3d}"
IMS_BLUE_PORT="${IMS_BLUE_PORT:-3101}"
IMS_GREEN_PORT="${IMS_GREEN_PORT:-3102}"
IMS_FRONT_URL="${IMS_FRONT_URL:-http://127.0.0.1:3000}"
IMS_HC_BIN="${IMS_HC_BIN:-/usr/local/bin/o3d-hc}"
IMS_HEALTH_TIMEOUT_S="${IMS_HEALTH_TIMEOUT_S:-120}"
IMS_HEALTH_INTERVAL_S="${IMS_HEALTH_INTERVAL_S:-2}"
IMS_FRONT_TIMEOUT_S="${IMS_FRONT_TIMEOUT_S:-30}"
IMS_DRAIN_POLL_S="${IMS_DRAIN_POLL_S:-2}"       # how often to look for nginx workers still draining
IMS_DRAIN_BOUND_S="${IMS_DRAIN_BOUND_S:-}"      # total wait; default = the site's proxy_read_timeout (600 if not found) + 15

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit "${DIE_RC:-1}"; }

require_root() {
  [ "$(id -u)" = 0 ] || [ "${IMS_DEPLOY_NO_ROOT_CHECK:-}" = 1 ] || die "must run as root"
}

# Run "$@" under the heartbeat wrapper when it is installed; otherwise just run it. Re-executes the calling script once.
# usage (top of a script):  hc_reexec <slug> "$0" "$@"
hc_reexec() {
  local slug="$1"; shift
  if [ -z "${IMS_HC_WRAPPED:-}" ] && [ -x "$IMS_HC_BIN" ]; then
    IMS_HC_WRAPPED=1 exec "$IMS_HC_BIN" "$slug" -- "$@"
  fi
  return 0
}

# --- slots ----------------------------------------------------------------------------------------------------------------------
slot_port() { case "$1" in blue) echo "$IMS_BLUE_PORT" ;; green) echo "$IMS_GREEN_PORT" ;; *) die "unknown slot $1" ;; esac; }
other_slot() { case "$1" in blue) echo green ;; green) echo blue ;; *) die "unknown slot $1" ;; esac; }
slot_name() { echo "ims-$1"; }

# The slot named by the upstream FILE (what the next nginx reload will serve). Prints blue, green or none (no file, or one that names
# neither slot port, e.g. the bootstrap placeholder). This is NOT proof of what is serving: a switch interrupted between the file write
# and the reload leaves the file ahead of the running nginx. Use serving_slot for that.
active_slot() {
  local line=""
  [ -f "$IMS_UPSTREAM_FILE" ] && line="$(grep -E '^[[:space:]]*server[[:space:]]+127\.0\.0\.1:[0-9]+' "$IMS_UPSTREAM_FILE" | head -n1 || true)"
  case "$line" in
    *"127.0.0.1:${IMS_BLUE_PORT};"*) echo blue ;;
    *"127.0.0.1:${IMS_GREEN_PORT};"*) echo green ;;
    *) echo none ;;
  esac
}

# The slot the RUNNING nginx serves from, read from the X-IMS-Slot response header that the loaded configuration adds (the upstream
# include defines the value in the same file as the upstream, so the header always matches the loaded upstream). blue, green or none;
# rc 1 when nginx does not answer or the header is missing or unrecognised.
header_slot() {
  local out value
  out="$(curl -sI --max-time 5 "${IMS_FRONT_URL}/login" 2>/dev/null)" || return 1
  value="$(printf '%s\n' "$out" | tr -d '\r' | awk -F': *' 'tolower($1) == "x-ims-slot" { print $2; exit }')"
  case "$value" in blue|green|none) printf '%s\n' "$value" ;; *) return 1 ;; esac
}

# Which slot is serving, from the running nginx. If the upstream file disagrees, a switch was interrupted after the file write but
# before the reload: the file is rolled back to what is actually serving (nginx -t, graceful reload) and the header re-read. Never
# guesses: if nginx cannot be asked, or the state cannot be reconciled, it stops.
serving_slot() {
  local hdr file i
  hdr="$(header_slot)" || { log "cannot read the X-IMS-Slot header from ${IMS_FRONT_URL}/login (is nginx up with the ims site?)"; return 1; }
  file="$(active_slot)"
  if [ "$hdr" != "$file" ]; then
    log "nginx serves '${hdr}' but ${IMS_UPSTREAM_FILE} names '${file}': an earlier switch was interrupted"
    if [ "$hdr" = none ]; then log "nothing is serving; fix ${IMS_UPSTREAM_FILE} and nginx by hand"; return 1; fi
    log "restoring the upstream file to the serving slot (${hdr})"
    switch_upstream "$(slot_port "$hdr")" || return 1
    for i in 1 2 3 4 5; do
      [ "$(header_slot || true)" = "$hdr" ] && break
      [ "$i" = 5 ] && { log "nginx does not report '${hdr}' after the restore"; return 1; }
      sleep 1
    done
  fi
  printf '%s\n' "$hdr"
}

# Refuse to remove or stop a slot nginx is serving from.
assert_not_serving() { # <slot>
  local hdr
  hdr="$(header_slot)" || { log "cannot tell whether $(slot_name "$1") is serving; not touching it"; return 1; }
  if [ "$hdr" = "$1" ]; then log "REFUSING to remove or stop $(slot_name "$1"): nginx is serving from it"; return 1; fi
}
# Stop a slot only after the RUNNING nginx confirms it is not serving from it. If it is (or nginx cannot be asked), leave it running
# and say so loudly; rc 1. Used by every failure path, so a failed switch-back can never take production down.
stop_unless_serving() { # <slot>
  if assert_not_serving "$1"; then
    docker stop "$(slot_name "$1")" >/dev/null 2>&1 || true
    return 0
  fi
  log "MANUAL ATTENTION: nginx serves (or may serve) $(slot_name "$1"); it is left running. Check ${IMS_FRONT_URL}/login and ${IMS_UPSTREAM_FILE} by hand; both slots may be running."
  return 1
}
# --- draining the old slot ------------------------------------------------------------------------------------------------------
# After a reload, old nginx workers keep proxying their in-flight requests to the OLD slot for up to proxy_read_timeout. Those workers
# show as "nginx: worker process is shutting down". They are matched by a case prefix on each ps line (no grep/pgrep pattern whose own
# command line could match itself).
draining_workers() {
  local line
  ps -eo args= 2>/dev/null | while IFS= read -r line; do
    case "$line" in "nginx: worker process is shutting down"*) printf '%s\n' "$line" ;; esac
  done
}
drain_bound_s() { # the rendered config's proxy_read_timeout (largest value, seconds; 600 if absent) + 15
  local best=0 n unit secs
  if [ -n "$IMS_DRAIN_BOUND_S" ]; then printf '%s\n' "$IMS_DRAIN_BOUND_S"; return 0; fi
  while read -r n unit; do
    [ -n "$n" ] || continue
    secs="$n"; [ "$unit" != m ] || secs=$((n * 60))
    [ "$secs" -le "$best" ] || best="$secs"
  done < <(nginx -T 2>/dev/null | sed -nE 's/^[[:space:]]*proxy_read_timeout[[:space:]]+([0-9]+)(s|m)?[[:space:]]*;.*/\1 \2/p')
  [ "$best" -gt 0 ] || best=600
  printf '%s\n' $((best + 15))
}
# Wait for the old workers to finish, then stop the old slot (kept, not removed). The new slot is already live, so running out of time
# is a warning, not a failure.
drain_and_stop_slot() { # <slot>
  local slot="$1" bound waited=0 still
  bound="$(drain_bound_s)"
  while :; do
    still="$(draining_workers)"
    [ -n "$still" ] || break
    if [ "$waited" -ge "$bound" ]; then
      log "WARNING: nginx workers are still draining after ${bound}s; stopping $(slot_name "$slot") anyway:"
      sed 's/^/  /' <<< "$still" >&2
      break
    fi
    sleep "$IMS_DRAIN_POLL_S"
    waited=$((waited + IMS_DRAIN_POLL_S))
  done
  # Only stop the slot once the RUNNING nginx reports it is not serving from it.
  assert_not_serving "$slot" || return 1
  docker stop -t 30 "$(slot_name "$slot")" >/dev/null 2>&1 || log "warning: could not stop $(slot_name "$slot")"
}
slot_running() { [ "$(docker inspect --format '{{.State.Running}}' "$(slot_name "$1")" 2>/dev/null)" = true ]; }

# --- images / containers --------------------------------------------------------------------------------------------------------
runtime_image() { echo "${IMS_REGISTRY}/ims:$1"; }
migrate_image() { echo "${IMS_REGISTRY}/ims-migrate:$1"; }

require_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "expected a full 40-character lowercase commit sha, got: $1"; }

container_exists() { docker inspect "$1" >/dev/null 2>&1; }
container_image_sha() { # <container> -> the sha tag of its image, empty if it does not exist
  local image
  image="$(docker inspect --format '{{.Config.Image}}' "$1" 2>/dev/null)" || return 0
  printf '%s\n' "${image##*:}"
}

# Start the runtime image in a slot. The state directory is a host bind mount shared by both slots (never an anonymous volume). Both
# slots use the host network so they reach Postgres on 127.0.0.1; PORT/HOSTNAME make each listen on its own loopback port. The env
# file is passed with --env-file, never on the command line.
run_slot() { # <slot> <sha>
  local slot="$1" sha="$2" name
  name="$(slot_name "$slot")"
  assert_not_serving "$slot" || return 1
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --network host \
    --env-file "$IMS_ENV_FILE" \
    -e "PORT=$(slot_port "$slot")" -e HOSTNAME=127.0.0.1 -e PRODUCER_HOLD_ENFORCED_DESTINATIONS=all \
    -e IMS_SCHEDULER_CRONTAB_FILE="/host-cron.d/${IMS_CROND_NAME}" -e IMS_SCHEDULER_CRONTAB_FORMAT=cron.d \
    -v "${IMS_STATE_DIR}:/var/lib/onetwoinventory" \
    -v "${IMS_CROND_DIR}:/host-cron.d:ro" \
    "$(runtime_image "$sha")" >/dev/null
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true; }

wait_http_200() { # <url> <timeout-s>
  local url="$1" timeout="$2" waited=0 code
  while :; do
    code="$(http_code "$url")"
    [ "$code" = 200 ] && return 0
    [ "$waited" -ge "$timeout" ] && { log "no HTTP 200 from $url within ${timeout}s (last: ${code:-none})"; return 1; }
    sleep "$IMS_HEALTH_INTERVAL_S"
    waited=$((waited + IMS_HEALTH_INTERVAL_S))
  done
}

# --- the env file ---------------------------------------------------------------------------------------------------------------
env_value() { # <NAME> -> the value of the LAST NAME=value line (docker --env-file semantics: literal text after the first '=')
  local line
  line="$(grep -E "^$1=" "$IMS_ENV_FILE" | tail -n1 || true)"
  printf '%s\n' "${line#*=}"
}

producer_hold_value() { # the value, whitespace-trimmed
  local v
  v="$(env_value PRODUCER_HOLD_ENFORCED_DESTINATIONS)"
  v="${v#"${v%%[![:space:]]*}"}"
  printf '%s\n' "${v%"${v##*[![:space:]]}"}"
}
# Every environment variable that can RELEASE a connector, read from the producer seam (lib/security/outbound-write-hold-constants.ts:
# OUTBOUND_GRANT_ENV; lib/security/producer-disposition-constants.ts: PRODUCER_CUTOFF_ENV). All are environment-only: neither the grant nor
# the live-from instant is ever read from a settings row or the database (the code says so), so this list is complete for the decision.
# Enforcement = all is not enough on its own: a grant plus a live-from instant in the past makes that destination's work LIVE.
RELEASE_VARS=(WC_WRITEBACK_ALLOWED_ORIGIN MINTSOFT_WRITE_ALLOWED XERO_WRITE_ALLOWED_TENANT WC_WRITES_LIVE_FROM MINTSOFT_WRITES_LIVE_FROM XERO_WRITES_LIVE_FROM)
check_env_file() {
  [ -f "$IMS_ENV_FILE" ] || die "$IMS_ENV_FILE does not exist"
  local mode
  mode="$(stat -c %a "$IMS_ENV_FILE")"
  case "$mode" in 600|400) ;; *) die "$IMS_ENV_FILE has mode $mode; it holds secrets and must be 0600 (root)" ;; esac
  # THE PRODUCER HOLD MUST COVER EVERY CONNECTOR. The producer seam takes a destination LIST, so a value such as `xero` would pass a
  # "non-empty" test while Mintsoft and WooCommerce keep writing. Only exactly `all` (surrounding whitespace trimmed, case-sensitive)
  # is accepted. There is deliberately NO override flag: releasing connectors belongs to the first-load plan's single enforced writer
  # switch, which will change this gate when it lands. run_slot also passes the trimmed value explicitly, so the app reads `all`.
  [ "$(producer_hold_value)" = all ] \
    || die "$IMS_ENV_FILE must set PRODUCER_HOLD_ENFORCED_DESTINATIONS=all (found: '$(producer_hold_value)'). Every connector writer stays held until the first-load plan's writer switch replaces this gate; there is no override."
  local name
  for name in "${RELEASE_VARS[@]}"; do
    if grep -Eq "^${name}=" "$IMS_ENV_FILE"; then
      die "$IMS_ENV_FILE sets ${name}, which can release a connector to write. Remove it: connectors are released only by the first-load plan's writer switch, not by this deploy."
    fi
  done
  [ -n "$(env_value DATABASE_URL)" ] || die "$IMS_ENV_FILE does not set DATABASE_URL"
}

# --- migrations -----------------------------------------------------------------------------------------------------------------
# "<name><TAB>expand|other" for every migration directory shipped in a migrate image. A migration is expand-only only if the FIRST line
# of its migration.sql is the comment `-- expand-only` (optionally followed by an explanation).
# shellcheck disable=SC2016  # runs in the container's shell, not here
LIST_MIGRATIONS_SCRIPT='cd /opt/prisma/prisma/migrations && for d in */; do n=${d%/}; [ -f "$n/migration.sql" ] || continue; if head -n 1 "$n/migration.sql" | grep -Eq "^-- expand-only([[:space:]].*)?$"; then m=expand; else m=other; fi; printf "%s\t%s\n" "$n" "$m"; done'
list_image_migrations() { # <sha>
  docker run --rm --entrypoint sh "$(migrate_image "$1")" -c "$LIST_MIGRATIONS_SCRIPT"
}

# Names of the migrations the database has applied (empty, rc 0, when it has no _prisma_migrations table yet: a fresh database).
# Read-only: the session is forced into a read-only transaction mode. psql runs from the RUNTIME image (it carries the PostgreSQL 17
# client) on the host network. DATABASE_URL reaches the container only through --env-file; a small node script splits it into the
# libpq environment variables (PGHOST, PGPASSWORD, ...) for the psql child, so no argument anywhere (docker run, node, psql) holds the
# URL or the password, and the host process table never shows them. (libpq does not read a URI from PGDATABASE.)
# shellcheck disable=SC2016  # JavaScript, not shell
APPLIED_JS='
const { execFileSync } = require("node:child_process");
const u = new URL(process.env.DATABASE_URL);
const env = { ...process.env, PGHOST: u.hostname.replace(/^\[|\]$/g, ""), PGPORT: u.port || "5432",
  PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
const ssl = u.searchParams.get("sslmode"); if (ssl) env.PGSSLMODE = ssl;
delete env.DATABASE_URL;
const q = (sql) => execFileSync("psql", ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql], { env, encoding: "utf8" }).trim();
if (q("select to_regclass($$public._prisma_migrations$$) is not null") === "t") {
  const rows = q("select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name");
  if (rows) console.log(rows);
}'
applied_migrations() { # <sha of an image that carries psql and node>
  docker run --rm --network host --env-file "$IMS_ENV_FILE" -e PGOPTIONS='-c default_transaction_read_only=on' \
    --entrypoint node "$(runtime_image "$1")" -e "$APPLIED_JS"
}

# --- atomic file writes ---------------------------------------------------------------------------------------------------------
write_atomic() { # <path> <content>   (temp file in the same directory, then mv)
  local path="$1" tmp
  tmp="$(mktemp "$(dirname "$path")/.$(basename "$path").XXXXXX")" || return 1
  printf '%s\n' "$2" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$path" || { rm -f "$tmp"; return 1; }
}

read_state() { # <current|previous> -> "<sha> <slot>" or empty
  [ -f "${IMS_DEPLOY_DIR}/$1" ] && head -n1 "${IMS_DEPLOY_DIR}/$1" || true
}

# --- nginx upstream -------------------------------------------------------------------------------------------------------------
# Atomically point nginx at the slot's port: new content goes to a temp file in the same directory and is mv'd over the include;
# `nginx -t` then validates the whole configuration, and a failure restores the previous file (also by mv) before returning 1.
# `nginx -s reload` is graceful: old workers finish their connections.
upstream_content() { # <port>   (the map gives the site its X-IMS-Slot header, so the header always matches the loaded upstream)
  local slot=none
  [ "$1" != "$IMS_BLUE_PORT" ] || slot=blue
  [ "$1" != "$IMS_GREEN_PORT" ] || slot=green
  printf '# Managed by deploy.sh / rollback.sh. Do not edit by hand.\nupstream ims_active {\n    server 127.0.0.1:%s;\n    keepalive 16;\n}\nmap $server_name $ims_slot {\n    default %s;\n}\n' "$1" "$slot"
}
restore_upstream() { # <backup-file or empty>
  if [ -n "$1" ]; then mv -f "$1" "$IMS_UPSTREAM_FILE"; else rm -f "$IMS_UPSTREAM_FILE"; fi
}
switch_upstream() { # <port>
  local port="$1" dir backup="" tmp
  dir="$(dirname "$IMS_UPSTREAM_FILE")"
  if [ -f "$IMS_UPSTREAM_FILE" ]; then
    backup="$(mktemp "${dir}/.ims-upstream.prev.XXXXXX")" || return 1
    cp -p "$IMS_UPSTREAM_FILE" "$backup" || { rm -f "$backup"; return 1; }
  fi
  tmp="$(mktemp "${dir}/.ims-upstream.new.XXXXXX")" || { [ -z "$backup" ] || rm -f "$backup"; return 1; }
  if ! { upstream_content "$port" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$IMS_UPSTREAM_FILE"; }; then
    rm -f "$tmp"; [ -z "$backup" ] || rm -f "$backup"; return 1
  fi
  if ! nginx -t >/dev/null 2>&1; then
    log "nginx -t rejected the new upstream; restoring the previous file"
    restore_upstream "$backup"
    return 1
  fi
  if ! nginx -s reload; then
    log "nginx reload failed; restoring the previous upstream"
    restore_upstream "$backup"
    nginx -s reload >/dev/null 2>&1 || true
    return 1
  fi
  [ -z "$backup" ] || rm -f "$backup"
  return 0
}

# --- host cron ------------------------------------------------------------------------------------------------------------------
# Render the managed crontab with the given release's own renderer and install it as /etc/cron.d/<name>:
#   render -> validate the START/END markers -> write the DOTTED temp file next to it (cron ignores names with a dot, so a half-written
#   file is never read) -> root:root 0644 -> `mv -f` onto the live name (atomic; a directory bind mount sees it at once).
# Only DATABASE_URL reaches the renderer (a private temp env file), not the whole secret env file.
# usage: install_host_cron <sha> [only-if-changed]      rc 0 installed or unchanged, 1 failure
install_host_cron() {
  local sha="$1" only_if_changed="${2:-}" work rendered live tmp
  work="$(mktemp -d)" || return 1
  rendered="${work}/rendered"
  live="${IMS_CROND_DIR}/${IMS_CROND_NAME}"
  ( umask 077; printf 'DATABASE_URL=%s\n' "$(env_value DATABASE_URL)" > "${work}/db.env" ) || { rm -rf "$work"; return 1; }
  if ! docker run --rm --network host --env-file "${work}/db.env" --entrypoint node "$(runtime_image "$sha")" \
        /app/dist-scripts/render-managed-crontab.mjs --format cron.d --cron-user root \
        --base-url "$IMS_FRONT_URL" --secret-file "$IMS_CRON_ENV_FILE" > "$rendered"; then
    log "the crontab renderer failed; the installed cron file is unchanged"
    rm -rf "$work"; return 1
  fi
  if [ "$(grep -c '^# --- OTI CRON \(START\|END\) ---$' "$rendered")" != 2 ] \
     || [ "$(grep -c '^# --- OTI CRON START ---$' "$rendered")" != 1 ]; then
    log "the rendered crontab does not carry exactly one START and one END marker; not installing it"
    rm -rf "$work"; return 1
  fi
  if [ "$only_if_changed" = only-if-changed ] && [ -f "$live" ] && cmp -s "$rendered" "$live"; then
    log "host cron already matches the saved settings; nothing to do"
    rm -rf "$work"; return 0
  fi
  tmp="${IMS_CROND_DIR}/.${IMS_CROND_NAME}.new"
  if ! { cp "$rendered" "$tmp" && { [ "$(id -u)" != 0 ] || chown root:root "$tmp"; } && chmod 0644 "$tmp" && mv -f "$tmp" "$live"; }; then
    log "could not install ${live}"
    rm -f "$tmp"; rm -rf "$work"; return 1
  fi
  rm -rf "$work"
  log "installed ${live}"
}

# Serialise deploy, rollback and the cron timer on one lock (fd 9). usage: take_lock [wait-seconds]
take_lock() {
  mkdir -p "$IMS_DEPLOY_DIR"
  exec 9>"${IMS_DEPLOY_DIR}/lock"
  flock -w "${1:-0}" 9 || die "another deploy, rollback or cron render is running"
}
