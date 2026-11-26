#!/usr/bin/env bash
# beads-attach-worktree.sh — make a new IMS clone/worktree use the SHARED bd
# Dolt server instead of developing its own parallel beads database.
#
# Architecture (set up 2026-06-24): the IMS bd database runs on ONE Dolt
# sql-server in "shared server" mode, ENABLED PER-PROJECT via config.yaml
#   dolt.shared-server: true
# (set in every IMS clone — NOT a machine-wide env var, so non-IMS bd projects
# like /root and woocommerce-shiphero-sync stay on their own embedded stores).
# The server lives at  ~/.beads/shared-server/dolt  (fixed port 3308) and is
# auto-started by bd on demand; the IMS database on it is "onetwo3d_ims". With
# dolt.shared-server set, bd auto-repairs the clone's metadata.json to
# dolt_mode=server and connects to the shared server.
#
# Usage:  scripts/beads-attach-worktree.sh /path/to/ims/clone
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: $0 /path/to/ims/clone"
TARGET="${1%/}"
[ -d "$TARGET/.beads" ] || die "no .beads dir in target: $TARGET/.beads"

# 1) Refuse if the clone already has its OWN private server data (a parallel store).
DOLT="$TARGET/.beads/dolt"
if [ -d "$DOLT" ] && [ ! -L "$DOLT" ] && { [ -d "$DOLT/.dolt" ] || [ -d "$DOLT/onetwo3d_ims/.dolt" ]; }; then
  die "target has its OWN private .beads/dolt ($DOLT) — a parallel store exists.
   Reconcile it into the shared server first, e.g.:
     (cd '$TARGET' && bd export > /tmp/parallel.jsonl)         # capture it
     (cd '$TARGET' && bd config set dolt.shared-server true)   # point at shared server
     (cd '$TARGET' && bd import /tmp/parallel.jsonl)           # merge in
   then  rm -rf '$DOLT'  and re-run this script."
fi

# 2) Enable shared-server for this clone (idempotent).
if ! grep -q 'dolt.shared-server: *true' "$TARGET/.beads/config.yaml" 2>/dev/null; then
  ( cd "$TARGET" && bd config set dolt.shared-server true >/dev/null 2>&1 ) \
    && echo "enabled dolt.shared-server in $TARGET/.beads/config.yaml" \
    || die "failed to set dolt.shared-server in $TARGET (is bd installed?)"
else
  echo "already enabled: dolt.shared-server in $TARGET/.beads/config.yaml"
fi

# 3) Verify the clone reaches the shared server (db onetwo3d_ims).
echo "verifying shared server from $TARGET ..."
out="$( cd "$TARGET" && bd dolt status 2>&1 )" || true
if echo "$out" | grep -q 'Mode: *shared server'; then
  n="$( cd "$TARGET" && bd list --status=all 2>/dev/null | grep -cE 'onetwo3d-ims-' || true )"
  echo "  ok: reaches the shared server (port $(echo "$out" | grep -oE 'Port: *[0-9]+' | grep -oE '[0-9]+')), sees $n issues"
else
  echo "  note: could not confirm shared-server mode. Output:"; echo "$out" | sed 's/^/    /'
  echo "  Start it once:  (cd /root/ims/onetwo3d-ims && bd dolt start)"
fi
