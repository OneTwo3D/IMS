#!/usr/bin/env bash
#
# Install a proxied `next dev` IMS instance (systemd unit + OLS vhost + TLS cert)
# and verify it end to end.
#
# Replaces scripts/install-stage-dev-service.sh, which was hardcoded to
# /root/ims/onetwo3d-ims-isolated (an abandoned tree) and installed a unit that no
# longer matched the running, hardened one.
#
#   sudo bash scripts/install-dev-instance.sh \
#     --name ims-e2e --host ims-e2e.onetwo3d.co.uk --port 3002 \
#     --workdir /opt/ims/onetwo3d-ims-e2e --app-ip 10.0.3.99
#
# Every step is idempotent: re-running only fills in what is missing.
#
# WHY THIS EXISTS — standing up ims-e2e by hand hit four traps in a row, each of
# which presented as something unrelated. They are all automated or asserted below:
#
#   1. allowedDevOrigins (next.config.ts). A hostname missing from that list still
#      serves SSR HTML, so the site looks fine — but `next dev` refuses its HMR
#      socket and the dev client runtime never starts, so nothing hydrates and every
#      button silently does nothing. It presents as "login is broken".
#   2. Per-vhost TLS. Each IMS vhost carries its OWN Let's Encrypt cert in a `vhssl`
#      block. The listener's shared cert does NOT cover these hostnames, so omitting
#      vhssl leaves the origin serving a mismatched cert.
#   3. /root is mode 700, so the `ims` user cannot traverse it. A dev instance's
#      workdir must live under /opt.
#   4. Redis is shared across instances; a second instance needs
#      RATE_LIMIT_BACKEND=memory or its rate-limit counters collide with stage's.
#      (Set in the instance .env, asserted here.)
#
set -euo pipefail

NAME=""; HOST=""; PORT=""; WORKDIR=""; APP_IP="10.0.3.99"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --app-ip) APP_IP="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$NAME" && -n "$HOST" && -n "$PORT" && -n "$WORKDIR" ]] || {
  echo "Usage: $0 --name <vhost> --host <fqdn> --port <port> --workdir <path> [--app-ip <ip>]" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

LSWS=/usr/local/lsws
UNIT="/etc/systemd/system/${NAME}-dev.service"

say() { echo -e "\n== $* =="; }

say "Preflight"
[[ "$WORKDIR" == /opt/* ]] || {
  echo "REFUSING: workdir must be under /opt — /root is mode 700 and the 'ims' user cannot traverse it." >&2
  exit 1; }
[[ -d "$WORKDIR" ]] || { echo "Missing workdir: $WORKDIR" >&2; exit 1; }
[[ -f "$WORKDIR/.env" ]] || { echo "Missing $WORKDIR/.env" >&2; exit 1; }

# Trap 1 — the one that costs hours, because the symptom is a silently dead UI.
if ! grep -q "'${HOST}'" "$WORKDIR/next.config.ts"; then
  cat >&2 <<EOF
REFUSING: '${HOST}' is not in allowedDevOrigins in ${WORKDIR}/next.config.ts.

Without it the site renders but NEVER HYDRATES: next dev refuses the HMR socket for
an unlisted origin, the dev client runtime never starts, and every button does
nothing (forms fall back to a native GET). It looks like a broken login page.

Add it, then re-run:
  allowedDevOrigins: [ ..., '${HOST}' ],
EOF
  exit 1
fi
echo "allowedDevOrigins contains ${HOST}: ok"

# Trap 4 — shared Redis.
grep -qE '^RATE_LIMIT_BACKEND=memory' "$WORKDIR/.env" \
  && echo "RATE_LIMIT_BACKEND=memory: ok" \
  || echo "WARNING: RATE_LIMIT_BACKEND=memory not set in .env — Redis is shared across instances; rate-limit counters may collide with another instance."

say "systemd unit"
SRC_UNIT="$WORKDIR/deploy/systemd/${NAME}-dev.service"
if [[ -f "$SRC_UNIT" ]]; then
  install -m 0644 "$SRC_UNIT" "$UNIT"
  echo "installed $UNIT from $SRC_UNIT"
else
  echo "No versioned unit at $SRC_UNIT — leaving any existing $UNIT untouched."
  [[ -f "$UNIT" ]] || { echo "and none exists. Create it first (copy deploy/systemd/ims-e2e-dev.service)." >&2; exit 1; }
fi
systemctl daemon-reload
systemctl enable --now "${NAME}-dev.service"
sleep 8
systemctl is-active --quiet "${NAME}-dev.service" && echo "${NAME}-dev.service: active" || {
  echo "Service failed to start:"; journalctl -u "${NAME}-dev.service" -n 20 --no-pager; exit 1; }

say "TLS certificate (trap 2 — each vhost needs its OWN cert)"
mkdir -p "/var/www/${HOST}/.well-known"
if [[ -d "/etc/letsencrypt/live/${HOST}" ]]; then
  echo "cert already present for ${HOST}"
else
  certbot certonly --webroot -w "/var/www/${HOST}" -d "${HOST}" \
    --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
fi

say "OpenLiteSpeed vhost"
mkdir -p "${LSWS}/conf/vhosts/${NAME}"
cat > "${LSWS}/conf/vhosts/${NAME}/vhconf.conf" <<EOF
docRoot                 /var/www/${HOST}

extprocessor ${NAME} {
  type                    proxy
  address                 ${APP_IP}:${PORT}
  maxConns                20
  initTimeout             60
  retryTimeout            0
  respBuffer              0
  keepAlive               0
  compressResponse        0
}

context /.well-known/ {
  location                /var/www/${HOST}/.well-known/
  allowBrowse             1
}

context / {
  type                    proxy
  handler                 ${NAME}
  addDefaultCharset       off
  extraHeaders            <<<END_OF_HEADERS
X-Forwarded-Proto https
X-Forwarded-Host ${HOST}
X-LiteSpeed-Cache-Control: no-cache
END_OF_HEADERS
}

websocket /_next/webpack-hmr {
  address                 ${APP_IP}:${PORT}
  maxConns                10
}

rewrite  {
  enable                  1
  rules                   <<<END_rules
RewriteRule .* - [E=Cache-Control:no-store]
END_rules
}

vhssl  {
  keyFile    /etc/letsencrypt/live/${HOST}/privkey.pem
  certFile   /etc/letsencrypt/live/${HOST}/fullchain.pem
  certChain  1
}
EOF
echo "wrote ${LSWS}/conf/vhosts/${NAME}/vhconf.conf"

say "httpd_config.conf (backed up first)"
cp -a "${LSWS}/conf/httpd_config.conf" "/root/httpd_config.conf.bak-$(date -u +%Y%m%dT%H%M%SZ)"
NAME="$NAME" HOST="$HOST" LSWS="$LSWS" python3 - <<'PY'
import os, re
name, host, lsws = os.environ['NAME'], os.environ['HOST'], os.environ['LSWS']
p = f"{lsws}/conf/httpd_config.conf"
s = open(p).read()
if f"virtualhost {name} {{" not in s:
    m = re.search(r"virtualhost [\w.-]+ \{.*?\n\}\n", s, re.S)
    if not m: raise SystemExit("ABORT: no virtualhost block to anchor after")
    s = s[:m.end()] + f"""
virtualhost {name} {{
  vhRoot                  /var/www/{host}
  configFile              $SERVER_ROOT/conf/vhosts/{name}/vhconf.conf
  allowSymbolLink         1
  enableScript            1
  restrained              0
}}
""" + s[m.end():]
    print(f"inserted virtualhost {name}")
else:
    print(f"virtualhost {name} already present")

def add_map(m):
    blk = m.group(0)
    if f"map                     {name} {host}" in blk: return blk
    return blk.rstrip()[:-1].rstrip("\n") + f"\n  map                     {name} {host}\n}}"

new = re.sub(r"^listener (?:http|https) \{.*?^\}", add_map, s, flags=re.S | re.M)
open(p, "w").write(new)
print("listener maps ensured on http + https")
PY

say "Graceful reload (zero downtime — never fullrestart, it drops production)"
"${LSWS}/bin/lswsctrl" restart
sleep 5

say "Verify"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 45 "https://${HOST}/login" || echo 000)
echo "https://${HOST}/login -> HTTP ${code}"
subj=$(echo | openssl s_client -servername "${HOST}" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)
echo "origin cert: ${subj:-<none>}"
[[ "$code" == "200" || "$code" == "307" ]] || { echo "FAILED: unexpected status" >&2; exit 1; }
echo
echo "Done. Confirm the UI HYDRATES (not just that it renders): load https://${HOST}/login,"
echo "check the console for HMR websocket errors, and click a button. If the URL gains a bare"
echo "'?' the page did not hydrate — re-check allowedDevOrigins."
