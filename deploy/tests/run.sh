#!/usr/bin/env bash
# Tests for deploy/bin/{deploy,rollback,cron-render,host-bootstrap}.sh with docker, curl, nginx and sleep stubbed on PATH
# (deploy/tests/stubs). Nothing here talks to a real docker daemon, nginx, database or network.
#
#   deploy/tests/run.sh [test-name ...]       exit 0 only if every selected test passes
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$HERE/../bin" && pwd)"
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc
PW=s3cretpw

fail() { echo "    FAIL: $*" >&2; exit 1; }
eq() { [ "$1" = "$2" ] || fail "${3:-values differ}: expected [$2], got [$1]"; }
log_has() { grep -Eq -- "$1" "$STUB/calls.log" || fail "calls.log lacks /$1/"; }
log_lacks() { ! grep -Eq -- "$1" "$STUB/calls.log" || fail "calls.log has /$1/ but must not"; }
line_of() { grep -nE -- "$1" "$STUB/calls.log" | head -n1 | cut -d: -f1; }
before() { # <regex-a> <regex-b>: a occurs, and before b
  local la lb; la="$(line_of "$1")"; lb="$(line_of "$2")"
  [ -n "$la" ] && [ -n "$lb" ] && [ "$la" -lt "$lb" ] || fail "expected /$1/ (line ${la:-none}) before /$2/ (line ${lb:-none})"
}
container_running() { sed -n 's/^running=//p' "$STUB/containers/$1" 2>/dev/null; }

setup() {
  T="$(mktemp -d)"; export T STUB="$T/stub"
  mkdir -p "$T/log"; export IMS_CRON_LOG_DIR="$T/log"
  mkdir -p "$T/log"; export IMS_CRON_LOG_DIR="$T/log"
  mkdir -p "$STUB/containers" "$STUB/migs" "$STUB/unhealthy" "$T/etc" "$T/state" "$T/deploy" "$T/nginx" "$T/crond"
  : > "$STUB/calls.log"
  printf 'DATABASE_URL=postgresql://u:%s@127.0.0.1:5432/ims\nCRON_SECRET=x\nPRODUCER_HOLD_ENFORCED_DESTINATIONS=all\n' "$PW" > "$T/etc/ims.env"
  chmod 600 "$T/etc/ims.env"; echo 'CRON_SECRET=x' > "$T/etc/cron.env"; chmod 600 "$T/etc/cron.env"
  export IMS_ENV_FILE="$T/etc/ims.env" IMS_CRON_ENV_FILE="$T/etc/cron.env" IMS_STATE_DIR="$T/state" IMS_DEPLOY_DIR="$T/deploy" \
         IMS_UPSTREAM_FILE="$T/nginx/ims-upstream.conf" IMS_CROND_DIR="$T/crond" IMS_DEPLOY_NO_ROOT_CHECK=1 IMS_HC_BIN="$T/none" \
         IMS_DRAIN_POLL_S=2 IMS_HEALTH_TIMEOUT_S=6 IMS_FRONT_TIMEOUT_S=4 IMS_HEALTH_INTERVAL_S=2
  export PATH="$HERE/stubs:$PATH"
  printf '# header\n# --- OTI CRON START ---\n* * * * *  root  echo job\n# --- OTI CRON END ---\n' > "$STUB/cronout"
  : > "$STUB/applied"
}
teardown() { rm -rf "$T"; }

port_of() { case "$1" in blue) echo 3101 ;; green) echo 3102 ;; esac; }
# Writes the upstream file AND marks it loaded (as if nginx had been reloaded). set_upstream_file_only is a crashed switch.
set_upstream_file_only() { printf 'upstream ims_active {\n    server 127.0.0.1:%s;\n}\n' "$(port_of "$1")" > "$IMS_UPSTREAM_FILE"; }
set_upstream() { set_upstream_file_only "$1"; cp "$IMS_UPSTREAM_FILE" "$STUB/loaded"; }
# A running release in a slot, serving, and recorded as current.
seed_active() { # <slot> <sha>
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=%s\n' "$2" "$(port_of "$1")" > "$STUB/containers/ims-$1"
  set_upstream "$1"; echo "$2 $1" > "$IMS_DEPLOY_DIR/current"
}
# A stopped release left behind in a slot, recorded as previous.
seed_stopped() { # <slot> <sha>
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=0\nport=%s\n' "$2" "$(port_of "$1")" > "$STUB/containers/ims-$1"
  echo "$2 $1" > "$IMS_DEPLOY_DIR/previous"
}
migs() { local sha="$1" kv; shift; : > "$STUB/migs/$sha"; for kv in "$@"; do printf '%s\t%s\n' "${kv%%:*}" "${kv##*:}" >> "$STUB/migs/$sha"; done; }
applied() { printf '%s\n' "$@" > "$STUB/applied"; }
deploy() { rc=0; "$BIN/deploy.sh" "$@" > "$T/out" 2>&1 || rc=$?; }
rollback() { rc=0; "$BIN/rollback.sh" "$@" > "$T/out" 2>&1 || rc=$?; }
no_temp_files() { [ -z "$(find "$T/nginx" "$T/deploy" "$T/crond" -name '.*' -type f 2>/dev/null)" ] || fail "leftover temp files: $(find "$T/nginx" "$T/deploy" "$T/crond" -name '.*' -type f)"; }

# ---------------------------------------------------------------------------------------------------------------------------------

t_health_failure_keeps_old_slot_serving() {
  seed_active blue "$A"; migs "$B" m1:expand; migs "$A" m1:expand; applied m1
  cp "$IMS_UPSTREAM_FILE" "$T/upstream.before"; echo "$A blue" > "$T/current.before"
  touch "$STUB/unhealthy/$B"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy succeeded although the new slot never became healthy"
  cmp -s "$IMS_UPSTREAM_FILE" "$T/upstream.before" || fail "the upstream file changed"
  log_lacks '^nginx reload'
  eq "$(container_running ims-blue)" 1 "old slot must still be running"
  eq "$(container_running ims-green)" 0 "the unhealthy new slot must be stopped"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue" "current must be untouched"
  [ ! -e "$IMS_DEPLOY_DIR/previous" ] || fail "previous was written"
  log_lacks 'render-managed-crontab'
  no_temp_files
}

t_pending_non_expand_migration_refused_before_migrating() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  deploy "$B"
  eq "$rc" 3 "exit code of a refusal"
  log_lacks '^MIGRATE'
  log_lacks '^RUN-SLOT'
  log_lacks '^docker stop'
  eq "$(container_running ims-blue)" 1 "the active slot must be untouched"
  grep -q 'm2' "$T/out" || fail "the output does not name the offending migration"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
}

t_contract_migration_needs_maintenance_flag() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  deploy --allow-contract-migration "$B"
  eq "$rc" 2 "--allow-contract-migration alone"
  log_lacks '^docker pull'
  log_lacks '^MIGRATE'
}

t_contract_migration_in_maintenance_stops_active_slot_first() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  deploy --allow-contract-migration --maintenance "$B"
  eq "$rc" 0 "maintenance deploy"
  before '^docker stop ims-blue' '^MIGRATE'
  before '^MIGRATE' '^RUN-SLOT ims-green'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$A blue"
  eq "$(container_running ims-blue)" 0
}

t_expand_only_pending_migrations_proceed_without_flags() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy of expand-only migrations"
  before '^MIGRATE' '^RUN-SLOT ims-green'
  before '^nginx reload' '^docker stop -t 30 ims-blue'   # no maintenance stop: the old slot serves until the switch
}

t_first_install_on_an_empty_database_is_exempt_and_uses_blue() {
  migs "$B" m1:other m2:other; : > "$STUB/applied"; touch "$STUB/no_table"
  printf 'upstream ims_active {\n    server 127.0.0.1:3100;\n}\n' > "$IMS_UPSTREAM_FILE"; cp "$IMS_UPSTREAM_FILE" "$STUB/loaded"
  deploy "$B"
  eq "$rc" 0 "first install"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B blue"
  [ ! -e "$IMS_DEPLOY_DIR/previous" ] || fail "a first install has no previous"
  grep -q 'ims-blue' <<< "$(grep RUN-SLOT "$STUB/calls.log")" || fail "first install must use the blue slot"
}

t_successful_deploy_switches_then_records_state() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  inode_before="$(stat -c %i "$IMS_UPSTREAM_FILE")"
  deploy "$B"
  eq "$rc" 0 "deploy"
  grep -q 'server 127.0.0.1:3102;' "$IMS_UPSTREAM_FILE" || fail "upstream does not name the green port"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$A blue"
  eq "$(container_running ims-blue)" 0 "previous slot must be stopped"
  [ -f "$STUB/containers/ims-blue" ] || fail "previous slot must be kept (not removed)"
  before '^nginx reload' 'curl http://127.0.0.1:3000/login -> 200'
  log_has 'curl http://127.0.0.1:3102/login -> 200'
  [ "$(stat -c %i "$IMS_UPSTREAM_FILE")" != "$inode_before" ] || fail "the upstream file was edited in place, not replaced by rename"
  log_has '^nginx -t \[# Managed by deploy.sh / rollback.sh. Do not edit by hand. upstream ims_active \{ +server 127.0.0.1:3102; +keepalive 16; \} map \$server_name \$ims_slot \{ +default green; +\} \]'
  no_temp_files
}

t_state_files_untouched_when_nginx_does_not_serve_the_new_release() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  cp "$IMS_UPSTREAM_FILE" "$T/upstream.before"
  # :3000 stops answering as soon as the upstream is switched.
  touch "$STUB/front_fail"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy succeeded although :3000 did not answer after the switch"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue" "current"
  [ ! -e "$IMS_DEPLOY_DIR/previous" ] || fail "previous written before a verified switch"
  grep -q 'server 127.0.0.1:3101;' "$IMS_UPSTREAM_FILE" || fail "the upstream was not switched back to blue"
  eq "$(container_running ims-blue)" 1 "the old slot must keep running"
  eq "$(container_running ims-green)" 0
}

t_nginx_test_failure_restores_the_old_upstream() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  cp -p "$IMS_UPSTREAM_FILE" "$T/upstream.before"
  touch "$STUB/nginx_t_fail"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy succeeded although nginx -t failed"
  cmp -s "$IMS_UPSTREAM_FILE" "$T/upstream.before" || fail "the old upstream file was not restored"
  log_lacks '^nginx reload'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
  [ ! -e "$IMS_DEPLOY_DIR/previous" ] || fail "previous written"
  eq "$(container_running ims-blue)" 1
  no_temp_files
}

set_hold() { grep -v '^PRODUCER_HOLD' "$IMS_ENV_FILE" > "$T/e"; cat "$T/e" > "$IMS_ENV_FILE"; [ "$#" = 0 ] || printf 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=%s\n' "$1" >> "$IMS_ENV_FILE"; }

t_deploy_refuses_a_producer_hold_that_is_not_exactly_all() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  for v in xero 'mintsoft,woocommerce' 'all,xero' ALL 'none' ''; do
    : > "$STUB/calls.log"; set_hold "$v"
    deploy "$B"
    [ "$rc" != 0 ] || fail "deploy accepted PRODUCER_HOLD_ENFORCED_DESTINATIONS='$v'"
    log_lacks '^docker (pull|run)'
    eq "$(container_running ims-blue)" 1 "nothing may change for '$v'"
  done
  : > "$STUB/calls.log"; set_hold   # missing entirely
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy ran without PRODUCER_HOLD_ENFORCED_DESTINATIONS"
  grep -q PRODUCER_HOLD_ENFORCED_DESTINATIONS "$T/out" || fail "the message does not name the setting"
  log_lacks '^docker (pull|run)'
}

t_deploy_accepts_all_and_trims_whitespace() {
  for v in all '  all  '; do
    seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1; : > "$STUB/calls.log"
    echo "$A blue" > "$IMS_DEPLOY_DIR/current"; rm -f "$IMS_DEPLOY_DIR/previous"
    set_hold "$v"; deploy "$B"
    eq "$rc" 0 "deploy with hold '$v': $(tail -n 3 "$T/out")"
    grep -E '^docker run -d' "$STUB/calls.log" | grep -qF -- '-e PRODUCER_HOLD_ENFORCED_DESTINATIONS=all' || fail "the slot is not started with the trimmed value 'all' for '$v'"
    seed_active blue "$A"; rm -f "$STUB/containers/ims-green"
  done
}

t_rollback_refuses_a_producer_hold_that_is_not_exactly_all() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  set_hold xero
  rollback
  [ "$rc" != 0 ] || fail "rollback accepted a partial hold"
  log_lacks '^docker (start|run)'
  set_hold ' all '
  rollback
  eq "$rc" 0 "rollback with a trimmed 'all'"
}

t_deploy_refuses_any_variable_that_can_release_a_connector() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  for v in WC_WRITEBACK_ALLOWED_ORIGIN MINTSOFT_WRITE_ALLOWED XERO_WRITE_ALLOWED_TENANT WC_WRITES_LIVE_FROM MINTSOFT_WRITES_LIVE_FROM XERO_WRITES_LIVE_FROM; do
    : > "$STUB/calls.log"; grep -vE '^(WC|MINTSOFT|XERO)_WRIT' "$IMS_ENV_FILE" > "$T/e"; cat "$T/e" > "$IMS_ENV_FILE"; printf '%s=x\n' "$v" >> "$IMS_ENV_FILE"
    deploy "$B"
    [ "$rc" != 0 ] || fail "deploy accepted $v with the hold at all"
    grep -q "$v" "$T/out" || fail "the message does not name $v"
    log_lacks '^docker (pull|run)'
    eq "$(container_running ims-blue)" 1 "nothing may change for $v"
  done
  # a Mintsoft grant together with its live-from instant: the real shape of a release
  : > "$STUB/calls.log"; set_hold all
  printf 'MINTSOFT_WRITE_ALLOWED=https://api.mintsoft.co.uk|89\nMINTSOFT_WRITES_LIVE_FROM=2026-01-01T00:00:00Z\n' >> "$IMS_ENV_FILE"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy accepted a Mintsoft grant and live-from instant"
  log_lacks '^docker (pull|run)'
}

t_deploy_allows_the_hold_at_all_with_no_release_variables() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy with all and no grants: $(tail -n 3 "$T/out")"
}

t_rollback_refuses_a_variable_that_can_release_a_connector() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  echo 'XERO_WRITE_ALLOWED_TENANT=00000000-0000-0000-0000-000000000000' >> "$IMS_ENV_FILE"
  rollback
  [ "$rc" != 0 ] || fail "rollback accepted a Xero grant"
  log_lacks '^docker (start|run)'
}

t_contract_migration_stops_every_slot_and_verifies_before_migrating() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3102\n' "$C" > "$STUB/containers/ims-green"   # the idle slot is running too
  deploy --allow-contract-migration --maintenance "$B"
  eq "$rc" 0 "maintenance deploy: $(tail -n 3 "$T/out")"
  before '^docker stop ims-blue' '^MIGRATE'
  before '^docker stop ims-green' '^MIGRATE'
  before 'inspect --format \{\{.State.Running\}\} ims-green' '^MIGRATE'
}

t_contract_migration_refused_when_a_slot_will_not_stop() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3102\n' "$C" > "$STUB/containers/ims-green"
  touch "$STUB/stop_fail_ims-green"
  deploy --allow-contract-migration --maintenance "$B"
  [ "$rc" != 0 ] || fail "deploy migrated although a slot would not stop"
  log_lacks '^MIGRATE'
}

t_contract_migration_refused_when_a_slot_is_still_running_after_stop() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3102\n' "$C" > "$STUB/containers/ims-green"
  touch "$STUB/stop_ignored_ims-green"
  deploy --allow-contract-migration --maintenance "$B"
  [ "$rc" != 0 ] || fail "deploy migrated although a slot still ran"
  log_lacks '^MIGRATE'
  grep -q 'still running' "$T/out" || fail "no explanation"
}

t_deploy_waits_for_draining_workers_before_stopping_the_old_slot() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  echo 3 > "$STUB/ps_drain_polls"; export IMS_DRAIN_BOUND_S=100
  deploy "$B"
  eq "$rc" 0 "deploy: $(tail -n 3 "$T/out")"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 3 "polls that saw a draining worker"
  last_draining="$(grep -n '^ps draining' "$STUB/calls.log" | tail -n 1 | cut -d: -f1)"
  stop_line="$(line_of '^docker stop -t 30 ims-blue')"
  [ -n "$stop_line" ] && [ "$last_draining" -lt "$stop_line" ] || fail "the old slot was stopped (line ${stop_line:-none}) before the last draining poll (line $last_draining)"
  log_has '^ps clear'
  before '^nginx reload' '^ps draining'
}

t_deploy_stops_immediately_when_no_worker_is_draining() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy"
  log_lacks '^ps draining'
  ! grep -q 'still draining' "$T/out" || fail "ordinary workers or a process merely naming the phrase were treated as draining"
  eq "$(grep -c '^ps clear' "$STUB/calls.log")" 1 "exactly one poll when nothing drains"
  before '^ps clear' '^docker stop -t 30 ims-blue'
}

t_deploy_keeps_the_old_slot_when_workers_never_exit() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=10
  deploy "$B"
  eq "$rc" 5 "deployed, cleanup pending: $(tail -n 4 "$T/out")"
  grep -q 'deploy complete, cleanup pending: old slot ims-blue kept running' "$T/out" || fail "no cleanup-pending message: $(tail -n 5 "$T/out")"
  grep -q 'cleanup-old-slot.sh' "$T/out" || fail "the message does not point at the cleanup command"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 6 "polls until the bound (0,2,...,10)"
  log_lacks '^docker stop -t 30'
  eq "$(container_running ims-blue)" 1 "the old slot must NOT be stopped while workers drain"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green" "the release is live and recorded"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$A blue"
  [ -f "$IMS_CROND_DIR/onetwo3d-ims" ] || fail "the host crontab was not installed for the live release"
}

t_cleanup_stops_the_idle_slot_once_no_worker_drains() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=4
  deploy "$B"; eq "$rc" 5 "setup deploy"
  rc=0; "$BIN/cleanup-old-slot.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 5 "cleanup while a worker still drains"
  eq "$(container_running ims-blue)" 1 "must not be stopped while workers drain"
  log_lacks '^docker stop -t 30'
  rm -f "$STUB/ps_drain_forever"
  rc=0; "$BIN/cleanup-old-slot.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "cleanup after the workers are gone: $(tail -n 3 "$T/out")"
  log_has '^docker stop -t 30 ims-blue'
  eq "$(container_running ims-blue)" 0
  eq "$(container_running ims-green)" 1 "the served slot must keep running"
  rc=0; "$BIN/cleanup-old-slot.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "a second cleanup has nothing to do"
}

t_next_deploy_is_refused_while_workers_still_drain() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; migs "$C" m1:expand; applied m1
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=4
  deploy "$B"; eq "$rc" 5 "setup deploy"
  : > "$STUB/calls.log"
  deploy "$C"
  [ "$rc" != 0 ] || fail "a second deploy ran while workers still use the idle slot"
  grep -q 'cleanup-old-slot.sh' "$T/out" || fail "the refusal does not point at the cleanup command"
  log_lacks '^(docker (rm|pull|run)|MIGRATE|RUN-SLOT)'
  eq "$(container_running ims-blue)" 1
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
}

t_run_slot_itself_refuses_to_replace_a_slot_while_workers_drain() {
  seed_active green "$B"; printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3101\n' "$A" > "$STUB/containers/ims-blue"
  touch "$STUB/reloaded" "$STUB/ps_drain_forever"
  rc=0; ( . "$BIN/lib.sh"; run_slot blue "$C" ) > "$T/out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail "run_slot replaced a slot that workers may still use"
  log_lacks '^docker rm'
}

t_rollback_keeps_the_slot_when_workers_never_exit() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=10
  rollback
  eq "$rc" 5 "rolled back, cleanup pending: $(tail -n 4 "$T/out")"
  eq "$(container_running ims-green)" 1 "the slot being left must not be stopped while workers drain"
  log_lacks '^docker stop -t 30'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
}

t_rollback_is_refused_while_workers_still_drain() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/reloaded" "$STUB/ps_drain_forever"
  rollback
  [ "$rc" != 0 ] || fail "rollback ran while workers drain"
  grep -q 'cleanup-old-slot.sh' "$T/out" || fail "no pointer to the cleanup command"
  log_lacks '^(docker (rm|run)|RUN-SLOT)'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
}

t_drain_bound_is_the_sites_proxy_read_timeout_plus_a_margin() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  printf 'server {\n  location / {\n    proxy_read_timeout 90s;\n  }\n}\n' > "$STUB/nginx_T"
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_POLL_S=15
  deploy "$B"
  eq "$rc" 5 "deploy (cleanup pending)"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 8 "bound 90+15 at a 15 s poll (0,15,...,105)"
}

t_drain_bound_falls_back_to_600_plus_a_margin() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever"; export IMS_DRAIN_POLL_S=205      # no nginx -T output: 600 + 15 = 615
  deploy "$B"
  eq "$rc" 5 "deploy (cleanup pending)"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 4 "bound 615 at a 205 s poll (0,205,410,615)"
}

t_rollback_waits_for_draining_workers_before_stopping_the_current_slot() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  echo 2 > "$STUB/ps_drain_polls"; export IMS_DRAIN_BOUND_S=100
  rollback
  eq "$rc" 0 "rollback: $(tail -n 3 "$T/out")"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 2
  last_draining="$(grep -n '^ps draining' "$STUB/calls.log" | tail -n 1 | cut -d: -f1)"
  stop_line="$(line_of '^docker stop -t 30 ims-green')"
  [ -n "$stop_line" ] && [ "$last_draining" -lt "$stop_line" ] || fail "the current slot was stopped before the workers finished"
}

t_deploy_refuses_a_world_readable_env_file() {
  seed_active blue "$A"; migs "$B" m1:expand; chmod 644 "$IMS_ENV_FILE"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy accepted a 0644 env file"
  log_lacks '^docker (pull|run)'
}

t_deploy_rejects_a_short_or_missing_sha() {
  deploy abc123; eq "$rc" 2 "short sha"
  deploy; eq "$rc" 2 "no sha"
}

t_interrupted_switch_never_removes_the_serving_slot() {
  # A previous deploy of B wrote the upstream file (green) and died before the reload: nginx still serves blue.
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; migs "$C" m1:expand; applied m1
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3102\n' "$B" > "$STUB/containers/ims-green"
  set_upstream_file_only green
  deploy "$C"
  eq "$rc" 0 "the next deploy must reconcile and succeed: $(tail -n 5 "$T/out")"
  grep -q 'interrupted' "$T/out" || fail "the interrupted switch was not reported"
  log_lacks '^docker rm -f ims-blue'
  before '^nginx reload' '^RUN-SLOT ims-green'     # the file was put back to the serving slot BEFORE anything was replaced
  before '^RUN-SLOT ims-green' '^docker stop -t 30 ims-blue'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$C green"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$A blue"
}

t_header_and_file_disagreement_with_nothing_serving_is_refused() {
  migs "$B" m1:expand; applied m1
  set_upstream_file_only blue; rm -f "$STUB/loaded"          # file says blue, the running nginx serves nothing
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3101\n' "$A" > "$STUB/containers/ims-blue"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy guessed a slot"
  grep -q 'interrupted' "$T/out" || fail "the disagreement was not detected"
  log_lacks '^docker (rm|stop|run)'
}

t_deploy_stops_when_nginx_reports_no_slot_header() {
  seed_active blue "$A"; migs "$B" m1:expand; applied m1
  touch "$STUB/no_header"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy ran without being able to ask nginx"
  log_lacks '^docker (rm|stop|run|pull)'
}

t_removing_the_slot_nginx_serves_is_refused() {
  seed_active blue "$A"
  rc=0; ( . "$BIN/lib.sh"; run_slot blue "$B" ) > "$T/out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail "run_slot replaced the serving slot"
  log_lacks '^docker rm'
  log_lacks '^RUN-SLOT'
  grep -q 'REFUSING' "$T/out" || fail "no refusal message"
  rc=0; ( . "$BIN/lib.sh"; run_slot green "$B" ) > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "the idle slot may be replaced"
  log_has "^RUN-SLOT ims-green $B"
}

t_old_slot_is_not_stopped_while_nginx_still_serves_it() {
  # The switch "succeeds" on disk but the reload does not take effect: the running nginx keeps serving blue.
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  mkdir -p "$T/stubbin"; printf '#!/usr/bin/env bash\ncase "$*" in "-s reload") echo "nginx reload" >> "$STUB/calls.log" ;; "-t") ;; esac\n' > "$T/stubbin/nginx"; chmod +x "$T/stubbin/nginx"
  PATH="$T/stubbin:$PATH" deploy "$B"
  [ "$rc" != 0 ] || fail "deploy went on although nginx still serves the old slot"
  eq "$(container_running ims-blue)" 1 "the serving slot must not be stopped"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
}

t_empty_migration_history_with_a_serving_release_is_refused() {
  seed_active blue "$A"; migs "$B" m1:other; : > "$STUB/applied"      # the table exists but holds no rows
  deploy "$B"
  eq "$rc" 3 "empty history while serving"
  log_lacks '^MIGRATE'
  grep -q 'wrong database' "$T/out" || fail "the message does not point at the database"
  eq "$(container_running ims-blue)" 1
}

t_empty_migration_history_with_a_running_slot_but_no_serving_is_refused() {
  migs "$B" m1:other; : > "$STUB/applied"
  printf 'image=ghcr.io/onetwo3d/ims:%s\nrunning=1\nport=3102\n' "$A" > "$STUB/containers/ims-green"
  deploy "$B"
  eq "$rc" 3 "empty history with a running slot"
  log_lacks '^MIGRATE'
}

t_empty_migration_history_with_a_serving_release_needs_maintenance_flags() {
  seed_active blue "$A"; migs "$B" m1:other; : > "$STUB/applied"
  deploy --allow-contract-migration --maintenance "$B"
  eq "$rc" 0 "maintenance override: $(tail -n 3 "$T/out")"
  before '^docker stop ims-blue' '^MIGRATE'
}

t_empty_migration_history_with_nothing_serving_is_a_first_install() {
  migs "$B" m1:other m2:other; : > "$STUB/applied"
  deploy "$B"
  eq "$rc" 0 "first install, table present but empty"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B blue"
}

t_database_credentials_never_appear_in_any_argv() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy"
  ! grep -Eq "$PW|postgresql://|DATABASE_URL=" "$STUB/calls.log" || fail "a credential or the URL is in a recorded argv: $(grep -E "$PW|postgresql://|DATABASE_URL=" "$STUB/calls.log" | head -n 2)"
  grep -Eq -- "--env-file $IMS_ENV_FILE .*--entrypoint node .* -e " "$STUB/calls.log" || fail "the applied-migrations query did not take its URL from the env file"
}

t_applied_query_hands_credentials_to_psql_through_the_environment() {
  command -v node >/dev/null || { echo "    (node missing; skipped)"; return 0; }
  mkdir -p "$T/fakebin"
  cat > "$T/fakebin/psql" <<'PSQL'
#!/usr/bin/env bash
echo "$*" >> "$T/psql.argv"
env | grep '^PG' >> "$T/psql.env"
env | grep -q '^DATABASE_URL=' && echo leaked >> "$T/psql.env"
case "$*" in *to_regclass*) echo t ;; *) echo 20260101000000_one ;; esac
PSQL
  chmod +x "$T/fakebin/psql"
  js="$(. "$BIN/lib.sh"; printf '%s' "$APPLIED_JS")"
  out="$(PATH="$T/fakebin:$PATH" DATABASE_URL='postgresql://us%40er:p%40ss@127.0.0.1:5433/db?sslmode=require' node -e "$js")" || fail "the query script failed"
  eq "$out" 20260101000000_one "applied migration names"
  ! grep -Eq 'p@ss|p%40ss|postgresql://' "$T/psql.argv" || fail "psql's argv holds a credential: $(cat "$T/psql.argv")"
  for want in PGPASSWORD=p@ss PGUSER=us@er PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=db PGSSLMODE=require 'PGOPTIONS=' ; do
    [ "$want" = 'PGOPTIONS=' ] && continue
    grep -qxF -- "$want" "$T/psql.env" || fail "psql's environment lacks $want"
  done
  ! grep -q leaked "$T/psql.env" || fail "DATABASE_URL was passed on to psql"
  grep -q 'default_transaction_read_only' "$BIN/lib.sh" || fail "the read-only session option is gone"
  # every reference to the migrations table is schema-qualified: none may appear without public. in front of it
  ! sed 's/public\."_prisma_migrations"//g' "$T/psql.argv" | grep -q '_prisma_migrations' || fail "an unqualified _prisma_migrations reference: $(cat "$T/psql.argv")"
  grep -q 'public."_prisma_migrations"' "$T/psql.argv" || fail "no qualified reference was recorded (the check proves nothing)"
}

t_deploy_does_not_stop_the_new_slot_when_the_switch_back_fails() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/front_fail"; echo 1 > "$STUB/reload_fail_after"      # the switch reloads once; the switch-back's reload fails
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy reported success"
  grep -q 'MANUAL ATTENTION' "$T/out" || fail "no MANUAL ATTENTION message: $(tail -n 5 "$T/out")"
  eq "$(container_running ims-green)" 1 "nginx still serves green, so it must keep running"
  eq "$(container_running ims-blue)" 1 "the old slot must keep running too"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue" "state must only record what is true"
  [ ! -e "$IMS_DEPLOY_DIR/previous" ] || fail "previous written"
}

t_rollback_does_not_stop_the_target_slot_when_the_switch_back_fails() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/front_fail"; echo 1 > "$STUB/reload_fail_after"
  rollback
  [ "$rc" != 0 ] || fail "rollback reported success"
  grep -q 'MANUAL ATTENTION' "$T/out" || fail "no MANUAL ATTENTION message: $(tail -n 5 "$T/out")"
  eq "$(container_running ims-blue)" 1 "nginx serves blue, so it must keep running"
  eq "$(container_running ims-green)" 1
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green" "state must only record what is true"
}

t_rollback_refuses_across_a_non_expand_migration() {
  seed_active green "$B"; seed_stopped blue "$A"
  migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1 m2
  cp "$IMS_UPSTREAM_FILE" "$T/upstream.before"
  rollback
  [ "$rc" != 0 ] || fail "rollback crossed a non-expand migration"
  grep -q 'm2' "$T/out" || fail "output does not name m2"
  log_lacks '^RUN-SLOT'
  cmp -s "$IMS_UPSTREAM_FILE" "$T/upstream.before" || fail "upstream changed"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
}

t_rollback_force_schema_mismatch_overrides() {
  seed_active green "$B"; seed_stopped blue "$A"
  migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1 m2
  rollback --force-schema-mismatch
  eq "$rc" 0 "forced rollback"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
}

t_rollback_across_expand_only_migrations_is_allowed() {
  seed_active green "$B"; seed_stopped blue "$A"
  migs "$A" m1:expand; migs "$B" m1:expand m2:expand; applied m1 m2
  rollback
  eq "$rc" 0 "rollback over expand-only"
  grep -q 'server 127.0.0.1:3101;' "$IMS_UPSTREAM_FILE" || fail "upstream not switched back to blue"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$B green" "the state files must swap"
  eq "$(container_running ims-blue)" 1
  eq "$(container_running ims-green)" 0
  [ -f "$STUB/containers/ims-green" ] || fail "the rolled-back slot must be kept"
  before '^RUN-SLOT ims-blue' '^nginx reload'
  no_temp_files
}

t_rollback_recreates_a_removed_previous_container() {
  seed_active green "$B"; seed_stopped blue "$A"; rm "$STUB/containers/ims-blue"
  migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  rollback
  eq "$rc" 0 "rollback with a removed container"
  log_has "^RUN-SLOT ims-blue $A port=3101"
}

t_rollback_failed_health_keeps_the_current_release() {
  seed_active green "$B"; seed_stopped blue "$A"
  migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/unhealthy/$A"
  cp "$IMS_UPSTREAM_FILE" "$T/upstream.before"
  rollback
  [ "$rc" != 0 ] || fail "rollback succeeded with an unhealthy previous release"
  cmp -s "$IMS_UPSTREAM_FILE" "$T/upstream.before" || fail "upstream changed"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
  eq "$(container_running ims-green)" 1
}

t_cron_is_written_through_the_dotted_temp_and_mv() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  mkdir -p "$T/realbin"; real_mv="$(command -v mv)"
  printf '#!/usr/bin/env bash\necho "mv $*" >> "$STUB/calls.log"\nexec %s "$@"\n' "$real_mv" > "$T/realbin/mv"; chmod +x "$T/realbin/mv"
  PATH="$T/realbin:$PATH" deploy "$B"
  eq "$rc" 0 "deploy"
  [ -f "$IMS_CROND_DIR/onetwo3d-ims" ] || fail "the cron file was not installed"
  eq "$(stat -c %a "$IMS_CROND_DIR/onetwo3d-ims")" 644
  log_has "^mv -f $IMS_CROND_DIR/\\.onetwo3d-ims\\.new $IMS_CROND_DIR/onetwo3d-ims\$"
  diff -q "$STUB/cronout" "$IMS_CROND_DIR/onetwo3d-ims" >/dev/null || fail "installed content differs from the rendered content"
  no_temp_files
}

t_cron_with_missing_markers_is_not_installed() {
  seed_active blue "$A"
  echo 'old' > "$IMS_CROND_DIR/onetwo3d-ims"
  printf '# --- OTI CRON START ---\n* * * * *  root  echo job\n' > "$STUB/cronout"
  rc=0; "$BIN/cron-render.sh" > "$T/out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail "cron-render installed a block without an END marker"
  eq "$(cat "$IMS_CROND_DIR/onetwo3d-ims")" old "the live cron file"
  no_temp_files
}

t_cron_timer_path_replaces_only_on_change() {
  seed_active blue "$A"
  cp "$STUB/cronout" "$IMS_CROND_DIR/onetwo3d-ims"
  inode="$(stat -c %i "$IMS_CROND_DIR/onetwo3d-ims")"
  rc=0; "$BIN/cron-render.sh" --only-if-changed > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "unchanged run"
  eq "$(stat -c %i "$IMS_CROND_DIR/onetwo3d-ims")" "$inode" "an unchanged render must not replace the file"
  printf '# header\n# --- OTI CRON START ---\n*/5 * * * *  root  echo changed\n# --- OTI CRON END ---\n' > "$STUB/cronout"
  rc=0; "$BIN/cron-render.sh" --only-if-changed > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "changed run"
  [ "$(stat -c %i "$IMS_CROND_DIR/onetwo3d-ims")" != "$inode" ] || fail "a changed render did not replace the file"
  diff -q "$STUB/cronout" "$IMS_CROND_DIR/onetwo3d-ims" >/dev/null || fail "installed content is not the new render"
  no_temp_files
}

t_cron_render_passes_only_database_url_to_the_renderer() {
  seed_active blue "$A"
  rc=0; "$BIN/cron-render.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "render"
  log_has "--entrypoint node ghcr.io/onetwo3d/ims:$A /app/dist-scripts/render-managed-crontab.mjs --format cron.d --cron-user root --base-url http://127.0.0.1:3000 --secret-file $IMS_CRON_ENV_FILE"
  log_lacks "env-file $IMS_ENV_FILE .*--entrypoint node"
}

t_cron_render_with_nothing_deployed_is_a_noop() {
  rc=0; "$BIN/cron-render.sh" --only-if-changed > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "nothing deployed"
  log_lacks '^docker'
}

t_slots_mount_shared_state_and_read_only_cron_dir() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy"
  run_line="$(grep -E '^docker run -d --name ims-green' "$STUB/calls.log")"
  for want in '--network host' "--env-file $IMS_ENV_FILE" '-e PORT=3102' '-e HOSTNAME=127.0.0.1' "-v $IMS_STATE_DIR:/var/lib/onetwoinventory" \
              "-v $IMS_CROND_DIR:/host-cron.d:ro" '-e IMS_SCHEDULER_CRONTAB_FILE=/host-cron.d/onetwo3d-ims' '-e IMS_SCHEDULER_CRONTAB_FORMAT=cron.d'; do
    grep -qF -- "$want" <<< "$run_line" || fail "the slot's docker run lacks: $want"
  done
  ! grep -Eq 'CRON_SECRET|postgresql://' <<< "$run_line" || fail "a secret appears on the docker command line"
}

t_heartbeat_wraps_deploy_and_cron_render_when_installed() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  printf '#!/usr/bin/env bash\necho "o3d-hc $1 $2" >> "$STUB/calls.log"\nshift 2\nexec "$@"\n' > "$T/o3d-hc"; chmod +x "$T/o3d-hc"
  export IMS_HC_BIN="$T/o3d-hc"
  deploy "$B"
  eq "$rc" 0 "deploy under the heartbeat"
  log_has '^o3d-hc ims-deploy --$'
  rc=0; "$BIN/cron-render.sh" --only-if-changed > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "cron-render under the heartbeat"
  log_has '^o3d-hc ims-cron-render --$'
}

t_bootstrap_is_idempotent_and_leaves_secrets_and_postgres_alone() {
  R="$T/root"; export IMS_BOOTSTRAP_ROOT="$R" IMS_UPSTREAM_FILE="$T/root/etc/nginx/ims-upstream.conf" IMS_UPSTREAM_FILE="$T/root/etc/nginx/ims-upstream.conf"
  mkdir -p "$R/etc/nginx/sites-available" "$R/etc/nginx/sites-enabled"
  echo 'server { listen 3000; }' > "$R/etc/nginx/sites-available/ims-holding"
  ln -s ../sites-available/ims-holding "$R/etc/nginx/sites-enabled/ims-holding"
  rc=0; "$BIN/host-bootstrap.sh" > "$T/out1" 2>&1 || rc=$?
  eq "$rc" 0 "first bootstrap run: $(tail -n 3 "$T/out1")"
  [ ! -e "$R/etc/nginx/sites-enabled/ims-holding" ] || fail "the holding site is still enabled"
  eq "$(readlink "$R/etc/nginx/sites-enabled/ims")" ../sites-available/ims
  [ -f "$R/etc/nginx/ims-upstream.conf" ] || fail "no upstream placeholder"
  eq "$(stat -c %a "$R/srv/ims/state")" 750
  eq "$(stat -c %a "$R/etc/ims")" 700
  log_has '^nginx reload'
  [ ! -e "$R/etc/ims/ims.env" ] && [ ! -e "$R/etc/ims/cron.env" ] || fail "bootstrap created a secrets file"
  for f in deploy.sh rollback.sh cron-render.sh lib.sh; do [ -x "$R/usr/local/lib/ims-deploy/$f" ] || fail "$f not installed"; done
  [ -f "$R/etc/systemd/system/ims-cron-render.timer" ] && [ -f "$R/etc/systemd/system/ims-cron-render.service" ] || fail "units not installed"
  # a live upstream must survive a re-run
  printf 'upstream ims_active {\n    server 127.0.0.1:3102;\n}\n' > "$R/etc/nginx/ims-upstream.conf"
  find "$R" -type f -exec stat -c '%n %i %y %s' {} + | sort > "$T/tree1"
  rc=0; "$BIN/host-bootstrap.sh" > "$T/out2" 2>&1 || rc=$?
  eq "$rc" 0 "second bootstrap run"
  find "$R" -type f -exec stat -c '%n %i %y %s' {} + | sort > "$T/tree2"
  diff "$T/tree1" "$T/tree2" > /dev/null || fail "a re-run changed files: $(diff "$T/tree1" "$T/tree2")"
  ! grep -q 'wrote' "$T/out2" || fail "a re-run reported writes: $(grep wrote "$T/out2")"
  grep -q 'server 127.0.0.1:3102;' "$R/etc/nginx/ims-upstream.conf" || fail "the live upstream was overwritten"
  ! grep -Eiq 'postgres(ql)?\.conf|pg_hba|createrole|createuser|CREATE (ROLE|USER)|ALTER (ROLE|USER)|systemctl[^#]*postgres' "$BIN/host-bootstrap.sh" || fail "bootstrap mentions Postgres configuration"
}

bootstrap_prepare() {
  R="$T/root"; export IMS_BOOTSTRAP_ROOT="$R" IMS_UPSTREAM_FILE="$T/root/etc/nginx/ims-upstream.conf"
  mkdir -p "$R/etc/nginx/sites-available" "$R/etc/nginx/sites-enabled"
  echo 'server { listen 3000; }' > "$R/etc/nginx/sites-available/ims-holding"
  ln -s ../sites-available/ims-holding "$R/etc/nginx/sites-enabled/ims-holding"
  site_dir="$R/etc/nginx"
}
bootstrap() { rc=0; "$BIN/host-bootstrap.sh" > "$T/out" 2>&1 || rc=$?; }

t_bootstrap_rerun_with_a_rejected_site_restores_the_previous_one() {
  bootstrap_prepare; bootstrap; eq "$rc" 0 "first run: $(tail -n 3 "$T/out")"
  echo '# an older, working site' > "$site_dir/sites-available/ims"           # differs from the repo copy: the rerun wants to replace it
  cp -p "$site_dir/sites-available/ims" "$T/site.before"
  link_before="$(readlink "$site_dir/sites-enabled/ims")"
  ln -s ../sites-available/ims-holding "$site_dir/sites-enabled/ims-holding"; holding_before="$(readlink "$site_dir/sites-enabled/ims-holding")"
  : > "$STUB/calls.log"; touch "$STUB/nginx_t_fail_once"
  bootstrap
  [ "$rc" != 0 ] || fail "bootstrap succeeded although nginx rejected the site"
  cmp -s "$site_dir/sites-available/ims" "$T/site.before" || fail "the previous site file was not restored byte for byte"
  eq "$(readlink "$site_dir/sites-enabled/ims")" "$link_before" "the ims link"
  eq "$(readlink "$site_dir/sites-enabled/ims-holding")" "$holding_before" "the holding link"
  log_lacks '^nginx reload'
  eq "$(grep -c '^nginx -t' "$STUB/calls.log")" 2 "nginx -t must run again after the restore"
  [ -z "$(find "$site_dir" \( -name '*.new' -o -name '*.restore' -o -name '.ims-bootstrap.*' \))" ] || fail "leftovers: $(find "$site_dir" \( -name '*.new' -o -name '*.restore' -o -name '.ims-bootstrap.*' \))"
}

t_bootstrap_first_run_with_a_rejected_site_leaves_the_holding_site_enabled() {
  bootstrap_prepare; touch "$STUB/nginx_t_fail_once"
  bootstrap
  [ "$rc" != 0 ] || fail "bootstrap succeeded although nginx rejected the site"
  eq "$(readlink "$site_dir/sites-enabled/ims-holding")" ../sites-available/ims-holding
  [ ! -e "$site_dir/sites-enabled/ims" ] && [ ! -L "$site_dir/sites-enabled/ims" ] || fail "the ims link is still there"
  [ ! -e "$site_dir/sites-available/ims" ] || fail "the new site file is still there"
  log_lacks '^nginx reload'
}

t_rollback_recreates_the_previous_slot_with_the_current_env_file() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  echo 'AUTH_SECRET=rotated-after-the-old-container-was-made' >> "$IMS_ENV_FILE"       # a credential rotation since ims-blue was created
  rollback
  eq "$rc" 0 "rollback: $(tail -n 3 "$T/out")"
  log_lacks '^docker start'
  before '^docker rm -f ims-blue' "^RUN-SLOT ims-blue $A"
  grep -qx 'AUTH_SECRET=rotated-after-the-old-container-was-made' "$STUB/env_at_run_ims-blue" || fail "the recreated container did not get the current env file"
  run_line="$(grep -E '^docker run -d --name ims-blue' "$STUB/calls.log")"
  for want in '--network host' "--env-file $IMS_ENV_FILE" '-e PORT=3101' "-v $IMS_STATE_DIR:/var/lib/onetwoinventory" "-v $IMS_CROND_DIR:/host-cron.d:ro" '-e PRODUCER_HOLD_ENFORCED_DESTINATIONS=all'; do
    grep -qF -- "$want" <<< "$run_line" || fail "rollback's docker run lacks: $want"
  done
}

t_rollback_refuses_when_the_previous_image_is_gone_and_cannot_be_pulled() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/missing_image_ims_$A" "$STUB/pull_fail"      # the RUNTIME image only: the migrate image is present
  rollback
  [ "$rc" != 0 ] || fail "rollback went ahead without the image"
  log_lacks '^RUN-SLOT'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
}

t_rollback_pulls_a_missing_previous_image() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/missing_image_ims_$A"
  rollback
  eq "$rc" 0 "rollback with a pullable image: $(tail -n 3 "$T/out")"
  log_has "^docker pull ghcr.io/onetwo3d/ims:$A"
  before "^docker pull ghcr.io/onetwo3d/ims:$A" "^RUN-SLOT ims-blue $A"
}

t_cron_log_directory_is_ensured_by_bootstrap_and_matches_the_renderer_default() {
  # the renderer's own default, read from the application source (not typed a second time here)
  app_default="$(sed -n "s/^export const DEFAULT_CRON_LOG_PATH = '\\(.*\\)'.*/\\1/p" "$HERE/../../lib/crontab-sync.ts")"
  [ -n "$app_default" ] || fail "could not read DEFAULT_CRON_LOG_PATH from lib/crontab-sync.ts"
  lib_default="$(env -u IMS_CRON_LOG_DIR bash -c '. "$1"; printf "%s" "$IMS_CRON_LOG_DIR/cron.log"' _ "$BIN/lib.sh")"
  eq "$lib_default" "$app_default" "the scripts' log path vs the renderer default"
  # a fresh host: bootstrap creates the directory (and the rotation) for exactly the path the crontab is rendered with
  unset IMS_CRON_LOG_DIR
  bootstrap_prepare; bootstrap
  eq "$rc" 0 "bootstrap: $(tail -n 3 "$T/out")"
  [ -d "$R$(dirname "$app_default")" ] || fail "bootstrap did not create $(dirname "$app_default")"
  eq "$(stat -c %a "$R$(dirname "$app_default")")" 750
  grep -qF "$app_default {" "$R/etc/logrotate.d/one-two-inventory-cron" || fail "no logrotate entry for $app_default"
  # and the crontab render is told that same path
  export IMS_CRON_LOG_DIR; IMS_CRON_LOG_DIR="$(dirname "$app_default")"
  mkdir -p "$T/log2"; IMS_CRON_LOG_DIR="$T/log2"
  seed_active blue "$A"
  rc=0; "$BIN/cron-render.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "render"
  log_has "--log-path $T/log2/cron.log"
}

t_cron_install_refuses_when_the_log_directory_is_missing() {
  seed_active blue "$A"; echo old > "$IMS_CROND_DIR/onetwo3d-ims"; rm -rf "$IMS_CRON_LOG_DIR"
  rc=0; "$BIN/cron-render.sh" > "$T/out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail "the crontab was installed without a log directory"
  eq "$(cat "$IMS_CROND_DIR/onetwo3d-ims")" old "the live cron file"
  log_lacks 'entrypoint node'
}

t_state_is_recorded_before_the_drain_wait() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever" "$STUB/sleep_kills_parent"      # the deploy dies on its first sleep while draining
  deploy "$B"
  [ "$rc" != 0 ] || fail "the crash did not happen"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green" "current must already name the new release"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$A blue"
  log_lacks '^docker stop -t 30'
}

t_rollback_records_state_before_the_drain_wait() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/ps_drain_forever" "$STUB/sleep_kills_parent"
  rollback
  [ "$rc" != 0 ] || fail "the crash did not happen"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue" "current must already name the rolled-back release"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$B green"
}

t_rollback_reconciles_a_stale_current_with_the_served_slot() {
  # the old order's crash window: nginx serves B (green, running) but deploy/current still says A (blue)
  seed_active green "$B"; seed_stopped blue "$A"; echo "$A blue" > "$IMS_DEPLOY_DIR/current"
  migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  rollback
  eq "$rc" 0 "rollback: $(tail -n 4 "$T/out")"
  grep -q 'MISMATCH' "$T/out" || fail "the mismatch was not reported loudly"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue" "rolled back to A, the release that was stale-current"
  eq "$(cat "$IMS_DEPLOY_DIR/previous")" "$B green"
  grep -q 'server 127.0.0.1:3101;' "$IMS_UPSTREAM_FILE" || fail "nginx not switched to blue"
}

t_rollback_refuses_a_stale_current_when_the_served_slot_is_not_running() {
  seed_active green "$B"; seed_stopped blue "$A"; echo "$A blue" > "$IMS_DEPLOY_DIR/current"
  sed -i 's/^running=.*/running=0/' "$STUB/containers/ims-green"
  migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  rollback
  [ "$rc" != 0 ] || fail "rollback guessed"
  grep -q 'Repair' "$T/out" || fail "no repair hint"
  log_lacks '^RUN-SLOT'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
}

t_cron_render_uses_the_served_release() {
  seed_active green "$B"; echo "$A blue" > "$IMS_DEPLOY_DIR/current"      # current is stale
  rc=0; "$BIN/cron-render.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 0 "render"
  log_has "--entrypoint node ghcr.io/onetwo3d/ims:$B "
  log_lacks "ims:$A /app/dist-scripts"
}

t_database_url_must_use_the_public_schema() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  for q in '?schema=tenant' '?connection_limit=5&schema=tenant' '?schema=public%20' '?options=-c%20search_path%3Dtenant' '?SCHEMA=tenant'; do
    : > "$STUB/calls.log"; grep -v '^DATABASE_URL' "$IMS_ENV_FILE" > "$T/e"; cat "$T/e" > "$IMS_ENV_FILE"
    echo "DATABASE_URL=postgresql://u:${PW}@127.0.0.1:5432/ims$q" >> "$IMS_ENV_FILE"
    deploy "$B"
    [ "$rc" != 0 ] || fail "deploy accepted DATABASE_URL query '$q'"
    grep -q 'public schema' "$T/out" || fail "no clear message for '$q'"
    log_lacks '^docker (pull|run)'
  done
  for q in '?schema=public' '?connection_limit=5&schema=public&sslmode=require' ''; do
    seed_active blue "$A"; rm -f "$STUB/containers/ims-green"; : > "$STUB/calls.log"
    grep -v '^DATABASE_URL' "$IMS_ENV_FILE" > "$T/e"; cat "$T/e" > "$IMS_ENV_FILE"
    echo "DATABASE_URL=postgresql://u:${PW}@127.0.0.1:5432/ims$q" >> "$IMS_ENV_FILE"
    deploy "$B"
    eq "$rc" 0 "deploy with DATABASE_URL query '$q': $(tail -n 3 "$T/out")"
  done
}

t_precheck_session_pins_search_path_and_migrate_targets_public() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  deploy "$B"
  eq "$rc" 0 "deploy"
  grep -E '^docker run .*--entrypoint node' "$STUB/calls.log" | grep -q 'search_path=public' || fail "the precheck session does not pin search_path=public"
  grep -qF 'PGOPTIONS=-c default_transaction_read_only=on -c search_path=public' "$STUB/calls.log" || fail "PGOPTIONS lacks the read-only and search_path settings"
  eq "$(cat "$STUB/migrate_database_url")" "postgresql://u:${PW}@127.0.0.1:5432/ims?schema=public" "the migrate container's DATABASE_URL"
  ! grep -E '^docker run .*(MIGRATE|ims-migrate)' "$STUB/calls.log" | grep -q "$PW" || fail "the URL is on the migrate command line"
}

t_migrate_database_url_keeps_other_parameters_and_adds_schema_public_once() {
  rc=0; out="$( . "$BIN/lib.sh"
    for u in 'postgresql://h/d' 'postgresql://h/d?sslmode=require' 'postgresql://h/d?schema=public' 'postgresql://h/d?schema=public&sslmode=require'; do
      printf 'DATABASE_URL=%s\n' "$u" > "$IMS_ENV_FILE"; migrate_database_url
    done )" || rc=$?
  eq "$rc" 0 "function"
  eq "$out" "postgresql://h/d?schema=public
postgresql://h/d?sslmode=require&schema=public
postgresql://h/d?schema=public
postgresql://h/d?schema=public&sslmode=require"
}

t_failed_verification_keeps_the_attempted_slot_while_workers_drain() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/front_fail" "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=10
  deploy "$B"
  eq "$rc" 1 "a failed deploy stays a failure (exit 1)"
  grep -q 'deploy FAILED; cleanup pending: attempted slot ims-green kept running' "$T/out" || fail "no failed/cleanup-pending message: $(tail -n 6 "$T/out")"
  eq "$(container_running ims-green)" 1 "the attempted slot must not be stopped while workers drain"
  log_lacks '^docker stop -t 30'
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A blue"
  grep -q 'server 127.0.0.1:3101;' "$IMS_UPSTREAM_FILE" || fail "nginx was not switched back"
}

t_failed_verification_stops_the_attempted_slot_only_after_workers_exit() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/front_fail"; echo 2 > "$STUB/ps_drain_polls"; export IMS_DRAIN_BOUND_S=100
  deploy "$B"
  eq "$rc" 1 "failed deploy"
  eq "$(grep -c '^ps draining' "$STUB/calls.log")" 2
  last="$(grep -n '^ps draining' "$STUB/calls.log" | tail -n 1 | cut -d: -f1)"; stop="$(line_of '^docker stop -t 30 ims-green')"
  [ -n "$stop" ] && [ "$last" -lt "$stop" ] || fail "the attempted slot was stopped (line ${stop:-none}) before the workers finished (line $last)"
  eq "$(container_running ims-green)" 0
}

t_failed_rollback_verification_keeps_the_attempted_slot_while_workers_drain() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/front_fail" "$STUB/ps_drain_forever"; export IMS_DRAIN_BOUND_S=10
  rollback
  eq "$rc" 1 "failed rollback"
  grep -q 'cleanup pending: attempted slot ims-blue kept running' "$T/out" || fail "no cleanup-pending message: $(tail -n 6 "$T/out")"
  eq "$(container_running ims-blue)" 1
  log_lacks '^docker stop -t 30'
}

t_a_failed_docker_stop_of_the_old_slot_is_cleanup_pending() {
  seed_active blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/stop_fail_ims-blue"
  deploy "$B"
  eq "$rc" 5 "deployed, but the old slot could not be stopped: $(tail -n 4 "$T/out")"
  grep -q 'still running after docker stop' "$T/out" || fail "no message"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B green"
}

t_a_stop_that_does_not_take_effect_is_cleanup_pending_for_rollback_and_cleanup() {
  seed_active green "$B"; seed_stopped blue "$A"; migs "$A" m1:expand; migs "$B" m1:expand; applied m1
  touch "$STUB/stop_ignored_ims-green"
  rollback
  eq "$rc" 5 "rolled back, old slot would not stop: $(tail -n 3 "$T/out")"
  rc=0; "$BIN/cleanup-old-slot.sh" > "$T/out" 2>&1 || rc=$?
  eq "$rc" 5 "cleanup-old-slot.sh must report the failed stop too"
  grep -q 'still running after docker stop' "$T/out" || fail "no message from cleanup"
}

t_deploying_an_older_image_is_refused_when_it_lacks_an_applied_contract_migration() {
  seed_active blue "$B"; migs "$B" m1:expand m2:other; migs "$A" m1:expand; applied m1 m2        # m2 is applied but A does not ship it
  deploy "$A"
  eq "$rc" 3 "older image across a non-expand migration"
  grep -q 'm2' "$T/out" || fail "the offending migration is not named"
  grep -q 'lacks' "$T/out" || fail "no clear message"
  log_lacks '^MIGRATE'
  log_lacks '^RUN-SLOT'
  eq "$(container_running ims-blue)" 1
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$B blue"
}

t_deploying_an_older_image_is_allowed_across_expand_only_migrations() {
  seed_active blue "$B"; migs "$B" m1:expand m2:expand; migs "$A" m1:expand; applied m1 m2
  deploy "$A"
  eq "$rc" 0 "older image across an expand-only migration: $(tail -n 3 "$T/out")"
  eq "$(cat "$IMS_DEPLOY_DIR/current")" "$A green"
}

t_deploying_an_older_image_can_be_forced() {
  seed_active blue "$B"; migs "$B" m1:expand m2:other; migs "$A" m1:expand; applied m1 m2
  deploy --force-schema-mismatch "$A"
  eq "$rc" 0 "forced: $(tail -n 3 "$T/out")"
  grep -q 'force-schema-mismatch given' "$T/out" || fail "the override was not logged"
}

t_deploying_an_older_image_with_unknown_markers_is_refused() {
  seed_active blue "$B"; migs "$A" m1:expand; applied m1 m2      # no listing for B at all: the markers cannot be verified
  : > "$STUB/migs/$B"
  deploy "$A"
  eq "$rc" 3 "unverifiable markers"
  log_lacks '^MIGRATE'
}

# ---------------------------------------------------------------------------------------------------------------------------------
tests=("$@")
if [ "${#tests[@]}" = 0 ]; then mapfile -t tests < <(declare -F | awk '{print $3}' | grep '^t_'); fi
failed=0
for t in "${tests[@]}"; do
  case "$t" in t_*) ;; *) t="t_$t" ;; esac
  setup
  if ( cd "$T" && "$t" ); then echo "ok    ${t#t_}"; else echo "FAIL  ${t#t_}"; failed=$((failed + 1)); fi
  teardown
done
echo "${#tests[@]} tests, $failed failed"
[ "$failed" = 0 ]
