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
IMS_DRAIN_S="${IMS_DRAIN_S:-10}"

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

# The slot nginx is sending traffic to RIGHT NOW (the upstream file is the truth; the state files are only a record). Prints
# blue, green or none (no upstream file, or one that names neither slot port, e.g. the bootstrap placeholder).
active_slot() {
  local line=""
  [ -f "$IMS_UPSTREAM_FILE" ] && line="$(grep -E '^[[:space:]]*server[[:space:]]+127\.0\.0\.1:[0-9]+' "$IMS_UPSTREAM_FILE" | head -n1 || true)"
  case "$line" in
    *"127.0.0.1:${IMS_BLUE_PORT};"*) echo blue ;;
    *"127.0.0.1:${IMS_GREEN_PORT};"*) echo green ;;
    *) echo none ;;
  esac
}

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
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --network host \
    --env-file "$IMS_ENV_FILE" \
    -e "PORT=$(slot_port "$slot")" -e HOSTNAME=127.0.0.1 \
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

check_env_file() {
  [ -f "$IMS_ENV_FILE" ] || die "$IMS_ENV_FILE does not exist"
  local mode
  mode="$(stat -c %a "$IMS_ENV_FILE")"
  case "$mode" in 600|400) ;; *) die "$IMS_ENV_FILE has mode $mode; it holds secrets and must be 0600 (root)" ;; esac
  [ -n "$(env_value PRODUCER_HOLD_ENFORCED_DESTINATIONS)" ] \
    || die "$IMS_ENV_FILE does not set PRODUCER_HOLD_ENFORCED_DESTINATIONS (to a non-empty value, e.g. all). Refusing to start a release whose connector writers are not explicitly held or released."
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
# client) on the host network, with the env file supplying DATABASE_URL.
# shellcheck disable=SC2016  # runs in the container's shell, not here
APPLIED_SCRIPT='[ "$(psql "$DATABASE_URL" -X -Atq -c "select to_regclass(\$\$public._prisma_migrations\$\$) is not null")" = t ] || exit 0; psql "$DATABASE_URL" -X -Atq -c "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name"'
applied_migrations() { # <sha of an image that carries psql>
  docker run --rm --network host --env-file "$IMS_ENV_FILE" -e PGOPTIONS='-c default_transaction_read_only=on' \
    --entrypoint sh "$(runtime_image "$1")" -c "$APPLIED_SCRIPT"
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
upstream_content() { # <port>
  printf '# Managed by deploy.sh / rollback.sh. Do not edit by hand.\nupstream ims_active {\n    server 127.0.0.1:%s;\n    keepalive 16;\n}\n' "$1"
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
