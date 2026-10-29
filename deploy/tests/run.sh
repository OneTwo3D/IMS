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
  mkdir -p "$STUB/containers" "$STUB/migs" "$STUB/unhealthy" "$T/etc" "$T/state" "$T/deploy" "$T/nginx" "$T/crond"
  : > "$STUB/calls.log"
  printf 'DATABASE_URL=postgresql://u:p@127.0.0.1:5432/ims\nCRON_SECRET=x\nPRODUCER_HOLD_ENFORCED_DESTINATIONS=all\n' > "$T/etc/ims.env"
  chmod 600 "$T/etc/ims.env"; echo 'CRON_SECRET=x' > "$T/etc/cron.env"; chmod 600 "$T/etc/cron.env"
  export IMS_ENV_FILE="$T/etc/ims.env" IMS_CRON_ENV_FILE="$T/etc/cron.env" IMS_STATE_DIR="$T/state" IMS_DEPLOY_DIR="$T/deploy" \
         IMS_UPSTREAM_FILE="$T/nginx/ims-upstream.conf" IMS_CROND_DIR="$T/crond" IMS_DEPLOY_NO_ROOT_CHECK=1 IMS_HC_BIN="$T/none" \
         IMS_DRAIN_S=0 IMS_HEALTH_TIMEOUT_S=6 IMS_FRONT_TIMEOUT_S=4 IMS_HEALTH_INTERVAL_S=2
  export PATH="$HERE/stubs:$PATH"
  printf '# header\n# --- OTI CRON START ---\n* * * * *  root  echo job\n# --- OTI CRON END ---\n' > "$STUB/cronout"
  : > "$STUB/applied"
}
teardown() { rm -rf "$T"; }

port_of() { case "$1" in blue) echo 3101 ;; green) echo 3102 ;; esac; }
set_upstream() { printf 'upstream ims_active {\n    server 127.0.0.1:%s;\n}\n' "$(port_of "$1")" > "$IMS_UPSTREAM_FILE"; }
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
  log_lacks 'render-managed-crontab|--entrypoint node'
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
  before '^nginx reload' '^docker stop ims-blue'   # no maintenance stop: the old slot serves until the switch
}

t_first_install_on_an_empty_database_is_exempt_and_uses_blue() {
  migs "$B" m1:other m2:other; : > "$STUB/applied"; touch "$STUB/no_table"
  printf 'upstream ims_active {\n    server 127.0.0.1:3100;\n}\n' > "$IMS_UPSTREAM_FILE"
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
  log_has '^nginx -t \[# Managed by deploy.sh / rollback.sh. Do not edit by hand. upstream ims_active \{ +server 127.0.0.1:3102; +keepalive 16; \} \]'
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

t_deploy_refuses_without_the_producer_hold_setting() {
  seed_active blue "$A"; migs "$B" m1:expand
  grep -v '^PRODUCER_HOLD' "$IMS_ENV_FILE" > "$T/e" && cat "$T/e" > "$IMS_ENV_FILE"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy ran without PRODUCER_HOLD_ENFORCED_DESTINATIONS"
  grep -q PRODUCER_HOLD_ENFORCED_DESTINATIONS "$T/out" || fail "the message does not name the missing setting"
  log_lacks '^docker (pull|run)'
  echo 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=' >> "$IMS_ENV_FILE"
  deploy "$B"
  [ "$rc" != 0 ] || fail "deploy ran with an EMPTY PRODUCER_HOLD_ENFORCED_DESTINATIONS"
  log_lacks '^docker (pull|run)'
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

t_rollback_refuses_across_a_non_expand_migration() {
  seed_active green "$B"; seed_stopped blue "$A"
  migs "$A" m1:expand; migs "$B" m1:expand m2:other; applied m1 m2
  cp "$IMS_UPSTREAM_FILE" "$T/upstream.before"
  rollback
  [ "$rc" != 0 ] || fail "rollback crossed a non-expand migration"
  grep -q 'm2' "$T/out" || fail "output does not name m2"
  log_lacks '^docker start'
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
  before '^docker start ims-blue' '^nginx reload'
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
  R="$T/root"; export IMS_BOOTSTRAP_ROOT="$R"
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
