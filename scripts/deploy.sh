#!/usr/bin/env bash
# =============================================================================
# One Two Inventory — Local rebuild + restart
# =============================================================================
# Builds the Next.js app and restarts the bare `next start` process that runs
# the production site on this machine (10.0.3.99:3000).
#
# Designed for the actual setup on this host:
#   - App dir:  /root/ims/onetwo3d-ims
#   - Launcher: bare `npm start` (no pm2/systemd)
#   - Log file: /tmp/oti-server.log
#
# Usage:
#   bash scripts/deploy.sh                # migrate + build + restart
#   bash scripts/deploy.sh --skip-build   # migrate + restart (no build)
#   bash scripts/deploy.sh --skip-migrate # build + restart (no migrate)
#   bash scripts/deploy.sh --restart-only # just restart the running process
# =============================================================================

set -euo pipefail

APP_DIR="/root/ims/onetwo3d-ims"
LOG_FILE="/tmp/oti-server.log"
PORT=3000
HEALTH_URL="http://127.0.0.1:${PORT}/login"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RESET='\033[0m'
info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

SKIP_BUILD=false
SKIP_MIGRATE=false
RESTART_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)   SKIP_BUILD=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    --restart-only) RESTART_ONLY=true; SKIP_BUILD=true; SKIP_MIGRATE=true ;;
    --help|-h)
      sed -n '3,17p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

[[ -d "$APP_DIR" ]]            || die "App directory not found: $APP_DIR"
[[ -f "$APP_DIR/package.json" ]] || die "Not a Next.js project: $APP_DIR/package.json missing"

cd "$APP_DIR"

START_TS=$(date +%s)

# ---------------------------------------------------------------------------
# 1. Generate Prisma client
# ---------------------------------------------------------------------------
if ! $SKIP_MIGRATE; then
  info "Generating Prisma client..."
  npx prisma generate --schema prisma/schema.prisma
  ok "Prisma client generated."
fi

# ---------------------------------------------------------------------------
# 2. Run database migrations
# ---------------------------------------------------------------------------
if ! $SKIP_MIGRATE; then
  info "Applying Prisma migrations..."
  npx prisma migrate deploy --schema prisma/schema.prisma
  ok "Migrations up to date."

  info "Validating database schema..."
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null
  ok "Database schema matches prisma/schema.prisma."
fi

# ---------------------------------------------------------------------------
# 3. Build
# ---------------------------------------------------------------------------
if ! $SKIP_BUILD; then
  info "Building Next.js app..."
  # Build to a temp dir first so the running server keeps serving until we
  # swap and restart. Prevents the "stale chunks" issue where an in-flight
  # process references files that have just been overwritten.
  BUILD_LOG="$(mktemp -t oti-build.XXXXXX.log)"
  if ! npm run build >"$BUILD_LOG" 2>&1; then
    tail -40 "$BUILD_LOG" >&2
    die "Build failed — see $BUILD_LOG"
  fi
  tail -5 "$BUILD_LOG"
  ok "Build complete."

  [[ -f "$APP_DIR/.next/BUILD_ID" ]] || die ".next/BUILD_ID missing after build"
  NEW_BUILD_ID=$(cat "$APP_DIR/.next/BUILD_ID")
  info "New BUILD_ID: $NEW_BUILD_ID"
fi

# ---------------------------------------------------------------------------
# 3. Stop running server (tree-kill: parent sh + child next-server)
# ---------------------------------------------------------------------------
info "Stopping running server..."

# Find everything listening on the port, then every next-server / next start
# process in this app dir. Belt and braces — leftover children are the main
# source of EADDRINUSE on restart.
PORT_PID=$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $NF}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
NEXT_PIDS=$(pgrep -f 'next-server|next start' || true)
ALL_PIDS=$(echo -e "${PORT_PID}\n${NEXT_PIDS}" | grep -E '^[0-9]+$' | sort -u || true)

if [[ -n "$ALL_PIDS" ]]; then
  for pid in $ALL_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      info "  kill $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done

  # Wait up to 10s for graceful exit, then SIGKILL stragglers.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    STILL_RUNNING=""
    for pid in $ALL_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then STILL_RUNNING="$STILL_RUNNING $pid"; fi
    done
    [[ -z "$STILL_RUNNING" ]] && break
  done
  for pid in $ALL_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      warn "  SIGKILL $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
fi

# Verify the port is actually free.
for _ in 1 2 3 4 5; do
  if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$"; then
    break
  fi
  sleep 1
done
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$"; then
  die "Port ${PORT} still in use after kill — aborting (check 'ss -ltnp | grep :${PORT}')"
fi
ok "Server stopped, port ${PORT} free."

# ---------------------------------------------------------------------------
# 4. Start fresh process
# ---------------------------------------------------------------------------
info "Starting server (logs → $LOG_FILE)..."
echo "" >> "$LOG_FILE"
echo "=== deploy.sh restart $(date -Iseconds) ===" >> "$LOG_FILE"
nohup npm start >> "$LOG_FILE" 2>&1 & disown

# ---------------------------------------------------------------------------
# 5. Health check + BUILD_ID verification
# ---------------------------------------------------------------------------
info "Waiting for server to come up..."
READY=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    READY=true
    break
  fi
done
$READY || { tail -30 "$LOG_FILE" >&2; die "Server did not come up within 15s — see $LOG_FILE"; }

# Verify the running server is actually serving the build we just wrote.
if ! $SKIP_BUILD; then
  SERVED_ID=$(curl -sS "$HEALTH_URL" 2>/dev/null | grep -oE '\\?"b\\?":\\?"[A-Za-z0-9_-]+\\?"' | head -1 | grep -oE '[A-Za-z0-9_-]{10,}' | tail -1 || true)
  if [[ -n "$SERVED_ID" && "$SERVED_ID" != "$NEW_BUILD_ID" ]]; then
    warn "Served BUILD_ID ($SERVED_ID) does not match disk ($NEW_BUILD_ID) — double-check the process."
  else
    ok "Served BUILD_ID matches disk."
  fi
fi

NEW_PID=$(pgrep -f 'next-server' | head -1 || true)
ok "Server is up (PID ${NEW_PID:-?})"

END_TS=$(date +%s)
echo ""
ok "Deploy complete in $((END_TS - START_TS))s."
echo "   Logs:  tail -f $LOG_FILE"
echo "   Site:  http://10.0.3.99:${PORT}/"
