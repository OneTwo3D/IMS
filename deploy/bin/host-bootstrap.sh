#!/usr/bin/env bash
# One-time (and safely re-runnable) setup of the production IMS host (Proxmox CT 115, Debian 13).
#
#   host-bootstrap.sh            run as root, from a checkout of this repository
#
# Does, in order, skipping whatever is already in place:
#   1. installs Docker from Debian's own packages (docker.io), nginx, cron, curl, util-linux; enables docker, cron and nginx
#   2. creates /srv/ims/state (1001:1001, 0750: the bind mount shared by both app slots), /srv/ims/deploy, /etc/ims (root, 0700),
#      /srv/ims/holding with a holding page, and /etc/ims/ims.env.template (a template; ims.env and cron.env are NEVER created or
#      changed here: they hold secrets and are rendered from the password manager by a separate task)
#   3. nginx: writes /etc/nginx/ims-upstream.conf ONLY if absent (never overwrites the active slot), installs the site
#      /etc/nginx/sites-available/ims on :3000, replaces the `ims-holding` site by it, runs `nginx -t`, and undoes the swap if the
#      test fails, then reloads gracefully
#   4. installs the deploy scripts to /usr/local/lib/ims-deploy and the ims-cron-render service + timer, and enables the timer
#
# It does NOT touch PostgreSQL (no config, no roles, no restart), OpenLiteSpeed, the firewall or the container's settings.
# GHCR: the images (ghcr.io/onetwo3d/ims, ims-migrate) are public; no `docker login` and no token are needed.
#
# Docker inside a Proxmox LXC container needs, on the Proxmox host, `features: nesting=1,keyctl=1` for CT 115 (already set). If
# `docker run` fails with an AppArmor, sysctl or cgroup permission error, see deploy/README.md "Docker in the LXC container".
#
# IMS_BOOTSTRAP_ROOT=<dir> prefixes every path below (the tests use it); leave it unset on the host.
set -euo pipefail

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
repo_deploy="$(dirname "$here")"
# Only the shared path definitions (IMS_CRON_LOG_DIR); this script keeps its own log/die.
# shellcheck source=lib.sh
. "$here/lib.sh"
R="${IMS_BOOTSTRAP_ROOT:-}"
log() { printf '%s\n' "bootstrap: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }


[ "$(id -u)" = 0 ] || [ -n "$R" ] || die "must run as root"
[ -z "${1:-}" ] || { sed -n '2,5p' "${BASH_SOURCE[0]}"; exit 2; }
if [ -z "$R" ] && [ -r /etc/os-release ] && ! grep -q '^VERSION_ID="13"' /etc/os-release; then
  log "warning: this is not Debian 13; continuing"
fi

# chown only when we are root (always, on the host); the tests run unprivileged.
own() { [ "$(id -u)" != 0 ] || chown "$@"; }
# install a file only if the content differs (so a re-run changes nothing and reports nothing).
put() { # <src> <dest> <mode>
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 0; fi
  install -D -m "$3" "$1" "$2"; own root:root "$2"; log "wrote $2"
}

# --- 1. packages ----------------------------------------------------------------------------------------------------------------
if [ -z "$R" ]; then
  missing=()
  for pkg in docker.io nginx cron curl ca-certificates util-linux; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  fi
  systemctl enable --now docker cron nginx
  docker info >/dev/null 2>&1 || die "docker is installed but 'docker info' fails; see deploy/README.md \"Docker in the LXC container\""
fi

T_LOGROTATE_TMP="$(mktemp)"; trap 'rm -f "$T_LOGROTATE_TMP"' EXIT
# --- 2. directories and templates -----------------------------------------------------------------------------------------------
install -d -m 0755 "$R/srv/ims" "$R/srv/ims/deploy" "$R/srv/ims/holding"
install -d -m 0750 "$R/srv/ims/state"; own 1001:1001 "$R/srv/ims/state"
chmod 0750 "$R/srv/ims/state"
install -d -m 0700 "$R/etc/ims"; own root:root "$R/etc/ims"
# The cron log directory: cron runs the jobs as root and each job appends to ${IMS_CRON_LOG_DIR}/cron.log. Created before anything that
# installs or enables host cron, and checked writable, or bootstrap stops.
install -d -m 0750 "$R$IMS_CRON_LOG_DIR"; own root:root "$R$IMS_CRON_LOG_DIR"
probe="$R$IMS_CRON_LOG_DIR/.bootstrap-probe.$$"
{ : > "$probe"; } 2>/dev/null && rm -f "$probe" || die "$R$IMS_CRON_LOG_DIR is not writable; the cron jobs would fail before they ran"
logrotate_file="$R/etc/logrotate.d/one-two-inventory-cron"
printf '%s\n' "$IMS_CRON_LOG_DIR/cron.log {" "    weekly" "    rotate 8" "    compress" "    delaycompress" "    missingok" "    notifempty" "    copytruncate" "}" > "$T_LOGROTATE_TMP"
put "$T_LOGROTATE_TMP" "$logrotate_file" 0644
put "$repo_deploy/host/ims.env.template" "$R/etc/ims/ims.env.template" 0600
[ -f "$R/etc/ims/ims.env" ] || log "note: $R/etc/ims/ims.env and cron.env do not exist yet; they are rendered from the password manager by a separate task"
if [ ! -f "$R/srv/ims/holding/__ims_holding.html" ]; then
  printf '%s\n' '<!doctype html><title>IMS</title><p>The inventory system is not available right now. Please retry shortly.</p>' > "$R/srv/ims/holding/__ims_holding.html"
  chmod 0644 "$R/srv/ims/holding/__ims_holding.html"; log "wrote the holding page"
fi

# --- 3. nginx -------------------------------------------------------------------------------------------------------------------
nginx_dir="$R/etc/nginx"
install -d -m 0755 "$nginx_dir/sites-available" "$nginx_dir/sites-enabled"
if [ ! -e "$nginx_dir/ims-upstream.conf" ]; then
  # Placeholder: names no slot port, so nothing is "active" and the holding page answers until the first deploy.
  printf '# Managed by deploy.sh / rollback.sh. Do not edit by hand.\n# Placeholder until the first deploy.\nupstream ims_active {\n    server 127.0.0.1:3100;\n    keepalive 16;\n}\nmap $server_name $ims_slot {\n    default none;\n}\n' > "$nginx_dir/ims-upstream.conf"
  chmod 0644 "$nginx_dir/ims-upstream.conf"; log "wrote the placeholder upstream"
fi
# The site swap is staged and reversible: the new site is written as sites-available/ims.new, the CURRENT site file and the
# enabled-link state are saved, the new file is moved into place (rename), `nginx -t` runs, and on failure the saved site file and
# links are put back exactly and `nginx -t` runs again to prove it. The live file is never edited in place; nginx is only reloaded
# after a passing test.
site="$nginx_dir/sites-available/ims"
holding_link="$nginx_dir/sites-enabled/ims-holding"
ims_link="$nginx_dir/sites-enabled/ims"
want_link="../sites-available/ims"
need_swap=0
{ [ -f "$site" ] && cmp -s "$repo_deploy/host/nginx-ims.conf" "$site"; } || need_swap=1
[ "$(readlink "$ims_link" 2>/dev/null || true)" = "$want_link" ] || need_swap=1
{ [ -e "$holding_link" ] || [ -L "$holding_link" ]; } && need_swap=1
if [ "$need_swap" = 1 ]; then
  bk="$(mktemp -d "$nginx_dir/.ims-bootstrap.XXXXXX")"
  had_site=0; [ -f "$site" ] && { had_site=1; cp -p "$site" "$bk/site"; }
  ims_link_was=""; [ -L "$ims_link" ] && ims_link_was="$(readlink "$ims_link")"
  ims_link_kind="none"; if [ -L "$ims_link" ]; then ims_link_kind="link"; elif [ -e "$ims_link" ]; then ims_link_kind="file"; cp -p "$ims_link" "$bk/ims-enabled-file"; fi
  holding_kind="none"; holding_was=""
  if [ -L "$holding_link" ]; then holding_kind="link"; holding_was="$(readlink "$holding_link")"
  elif [ -e "$holding_link" ]; then holding_kind="file"; cp -p "$holding_link" "$bk/holding-file"; fi
  restore_site() {
    if [ "$had_site" = 1 ]; then cp -p "$bk/site" "$site.restore" && mv -f "$site.restore" "$site"; else rm -f "$site"; fi
    rm -f "$ims_link"
    case "$ims_link_kind" in link) ln -s "$ims_link_was" "$ims_link" ;; file) cp -p "$bk/ims-enabled-file" "$ims_link" ;; esac
    rm -f "$holding_link"
    case "$holding_kind" in link) ln -s "$holding_was" "$holding_link" ;; file) cp -p "$bk/holding-file" "$holding_link" ;; esac
  }
  cp "$repo_deploy/host/nginx-ims.conf" "$site.new" && chmod 0644 "$site.new"
  mv -f "$site.new" "$site"; own root:root "$site"
  rm -f "$holding_link"
  ln -sfn "$want_link" "$ims_link"
  if ! nginx -t; then
    log "nginx -t rejected the new site; restoring the previous site file and links"
    restore_site
    nginx -t || die "nginx -t FAILS AFTER THE RESTORE as well; fix $nginx_dir by hand (copies are in $bk)"
    rm -rf "$bk"
    die "nginx -t failed; the previous nginx configuration is back in place and nginx was not reloaded"
  fi
  nginx -s reload
  rm -rf "$bk"
  log "installed the ims site and reloaded nginx"
fi

# --- 4. deploy scripts and the cron-render timer --------------------------------------------------------------------------------
for f in lib.sh deploy.sh rollback.sh cron-render.sh; do put "$here/$f" "$R/usr/local/lib/ims-deploy/$f" 0755; done
unit_changed=0
for f in ims-cron-render.service ims-cron-render.timer; do
  if [ ! -f "$R/etc/systemd/system/$f" ] || ! cmp -s "$repo_deploy/host/$f" "$R/etc/systemd/system/$f"; then unit_changed=1; fi
  put "$repo_deploy/host/$f" "$R/etc/systemd/system/$f" 0644
done
if [ -z "$R" ]; then
  [ "$unit_changed" = 0 ] || systemctl daemon-reload
  systemctl enable --now ims-cron-render.timer
fi

log "done. Next (not done here): render /etc/ims/ims.env and /etc/ims/cron.env (root, 0600), then /usr/local/lib/ims-deploy/deploy.sh <full-sha>"
