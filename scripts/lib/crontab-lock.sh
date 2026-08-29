# shellcheck shell=bash
# =============================================================================
# ONE EXCLUSION PROTOCOL FOR THE SERVICE USER'S CRONTAB — one mechanism, four writers
# =============================================================================
# o3d-p9dq (Codex r26 HIGH). Sourced by scripts/install.sh, scripts/deploy.sh and
# scripts/update.sh, and it is the ONLY thing in this repository that decides how a shell
# entrypoint takes the crontab exclusion. The fourth writer is the application itself
# (lib/crontab-reconcile.ts, via lib/crontab-reconcile-lock.ts), which locks the SAME inode
# from TypeScript.
#
# WHY IT IS A LIBRARY AND NOT A THIRD COPY. The same argument db-fence-protected.sh makes: a
# rule with several readers cannot be restated in three places and stay one rule. Round 22
# gave install.sh an flock and left deploy.sh and update.sh outside it, and round 25's census
# could only record that as a list of fourteen exceptions. A protocol with fourteen declared
# exceptions is not a protocol.
#
# ---------------------------------------------------------------------------
# WHAT THE LOCK EXCLUDES, AND WHAT ONLY DRAINING CAN EXCLUDE
# ---------------------------------------------------------------------------
# The flock excludes exactly one thing: another process that opens the SAME file and locks it.
# Two consequences, and both are load-bearing for where these helpers are called from:
#
#   • A LIVE APPLICATION RUNNING THIS BUILD participates, because lib/crontab-reconcile-lock.ts
#     resolves $STATE_DIRECTORY/locks/.crontab-reconcile.lock — the same path the entrypoints
#     resolve from the state directory. Against that process the lock is sufficient on its own.
#
#   • A LIVE APPLICATION RUNNING THE PREDECESSOR BUILD DOES NOT. On the FIRST rollout of this
#     protocol the process serving the box was built before it existed: its reconciliation takes
#     a PostgreSQL session advisory lock, or nothing at all, and no flock this script takes can
#     reach it. Against that process the ONLY exclusion is that it is not running — which is why
#     the cutover's own `fence_cron` was moved to AFTER `systemctl stop` and the port drain, and
#     is not merely wrapped in a lock it would have shared with nobody.
#
# So the two mechanisms cover different sets, and the entrypoints say which one covers each of
# their call sites in the comment above it. Every site takes the lock; the sites that run while
# something may still be serving say so.
#
# ---------------------------------------------------------------------------
# THE DESCRIPTOR, AND WHY IT IS NOT fd 9
# ---------------------------------------------------------------------------
# All three entrypoints hold the shared CUTOVER lock on fd 9 for the whole run
# (`acquire_cutover_lock`), and the legacy namespace lock on fd 8. `exec 9<somefile` REPLACES
# fd 9, which closes the open file description underneath it — and closing the last descriptor
# on an flock RELEASES it. Round 22's crontab section did exactly that: from the moment it ran,
# the run that was supposedly excluding every other cutover was excluding nothing, and its final
# `exec 9>&-` left the process with no cutover lock at all. The crontab lock therefore lives on
# its own descriptor, and it is scoped to a command group rather than `exec`ed, so it cannot
# leak past the critical section however the body returns.
#
# READ-ONLY, ALWAYS. flock(2) locks the open file DESCRIPTION whatever its access mode, so a
# read-only descriptor takes the same exclusive lock — and the lock file is root-owned inside a
# root-owned directory precisely so that no root-side write ever lands on a path the service
# user could turn into a symlink (r24 CRITICAL). An fd that cannot write cannot be steered into
# writing something else either. This is the same fallback the application relies on
# (lib/crontab-reconcile-lock.ts, `openLockFile`).
#
# NEVER rm-and-recreate the lock file: the lock lives on the INODE, so replacing it would hand
# two writers two different locks and look like it worked.
# ---------------------------------------------------------------------------

# The two components, stated ONCE. Every entrypoint composes its lock path out of these and its
# own state directory, and lib/crontab-reconcile-lock.ts exports the identical pair as
# CRONTAB_RECONCILE_LOCK_DIRNAME / CRONTAB_RECONCILE_LOCK_FILENAME. That agreement is resolved
# and asserted in tests/settings/crontab-reconcile-serialization.test.ts.
CRONTAB_LOCK_DIRNAME="locks"
CRONTAB_LOCK_FILENAME=".crontab-reconcile.lock"

# The descriptor the exclusion is held on. 8 and 9 belong to the cutover locks; see above.
#
# A LITERAL, NOT A `{varname}<` ALLOCATION. Bash only began closing automatically-allocated
# descriptors when the compound command they were attached to completes in 5.2; on anything
# older the fd — and the lock on it — would leak out of the critical section and be held for the
# rest of the run. A literal fd attached to a `{ ...; }` group is scoped by the group on every
# bash this ships to. It is stated here as well so the tests can assert the two agree.
CRONTAB_LOCK_FD=7

# How long a shell writer waits for the application to finish reconciling before it gives up.
#
# Sized from the critical section it queues behind, not picked round: the application's holder
# runs two child processes with a 5s timeout each (`crontab -l`, `crontab -`) plus a handful of
# local queries, so a legitimate queue clears in well under this. Longer than the app's own
# 20s wait, deliberately — the entrypoint is the one that cannot simply come back later.
CRONTAB_LOCK_WAIT_SECONDS="${IMS_CRONTAB_LOCK_WAIT_SECONDS:-60}"

# Compose this entrypoint's lock paths from its state directory. The state directory is what
# systemd hands the service as $STATE_DIRECTORY, which is what the application reads.
crontab_lock_paths() {
  local state_dir="$1"
  CRONTAB_LOCK_DIR="${state_dir}/${CRONTAB_LOCK_DIRNAME}"
  CRONTAB_LOCK_FILE="${CRONTAB_LOCK_DIR}/${CRONTAB_LOCK_FILENAME}"
}

# ---------------------------------------------------------------------------
# THE CRONTAB RECONCILIATION LOCK IS ROOT-OWNED, AND NO ROOT-SIDE STEP FOLLOWS A SYMLINK
# (Codex r24 CRITICAL).
#
# ${DATA_DIR} is the service's systemd StateDirectory. systemd creates it OWNED BY ${APP_USER},
# and it MUST be writable by that user — that is what makes the lock reachable under the
# hardened unit at all (r23). Round 23 then put the lock file directly in it and, as root, ran
# `touch`, `chown` and `chmod` on that path on every install and every upgrade. All three follow
# symlinks. So the unprivileged service account — the one account an attacker who reaches this
# application gets — could replace the lock with a symlink to /etc/shadow and wait: the next
# installer run would give the target away as ${APP_USER}:${APP_USER}, mode 0664. A root-side
# write into a directory the service user controls is not a convenience, it is a
# privilege-escalation primitive.
#
# THE SERVICE USER NEVER NEEDS TO WRITE THIS FILE. `flock(2)` locks the open file DESCRIPTION
# whatever its access mode, and the application already falls back to a READ-ONLY descriptor
# when the lock file cannot be opened for writing (lib/crontab-reconcile-lock.ts,
# `openLockFile`). So the lock can be root's alone and the exclusion still works in both
# directions:
#
#   ${CRONTAB_LOCK_DIR}
#       root:root, 0755. The service user cannot create, replace or remove ANY entry in it, so
#       the lock file underneath it cannot be swapped — this directory, not the file's mode, is
#       what closes the finding.
#   ${CRONTAB_LOCK_FILE}
#       root:root, 0644. World-readable so the service can open it read-only and flock it; never
#       `chown`ed to ${APP_USER}, and never written by anyone — its CONTENTS are meaningless,
#       only its inode is the lock.
#
# NOTHING HERE FOLLOWS A SYMLINK, and each primitive is chosen for that:
#
#   • `mkdir` WITHOUT -p — plain mkdir fails with EEXIST on an existing symlink, where
#     `mkdir -p` succeeds silently and leaves every later step operating inside the link's
#     target.
#   • `set -C` (noclobber) redirection — open(O_CREAT|O_EXCL), which by POSIX fails with EEXIST
#     when the final component is a symlink, and so cannot create or truncate the target.
#     `touch`, and a plain `: >` redirection, both follow.
#   • `stat` and `[[ -L ]]` — both lstat. `stat -c %F` reports "symbolic link" rather than the
#     target's type (`stat -L`, which would dereference, is deliberately not used).
#   • `chown -h` — never dereferences: on a symlink it changes the LINK, so even a path swapped
#     between the check and the call cannot hand a target away.
#   • NO `chmod`, anywhere on these two paths. chmod has no --no-dereference on Linux, so a
#     raced chmod is the same escalation with a different verb. Modes come from `umask` at
#     creation, and a mode that is already wrong is REFUSED rather than corrected.
#
# AND IT IS RE-ASSERTED ON EVERY RUN, not established once. systemd re-owns a StateDirectory
# RECURSIVELY when the TOP-LEVEL directory's owner does not match `User=` — so a box where
# ${DATA_DIR} ends up root-owned for any reason will hand this subdirectory to ${APP_USER} at
# the next service start. Nothing below trusts what a previous run left: it re-takes ownership
# and re-derives every fact with lstat, so that case ends in a corrected directory or a refused
# run rather than in a root-side write into a directory the service user can rewrite.
#
# WHAT IS STILL POSSIBLE, stated rather than glossed over: ${DATA_DIR} itself belongs to
# ${APP_USER}, so that user can rename(2) the lock DIRECTORY aside within it — a same-directory
# rename of a directory does not need write permission on the directory being renamed — and drop
# a symlink in its place. Which is why every step below re-derives what it is looking at with
# lstat and DIES: the outcome is a refused run naming the path, never a followed link. Whoever
# holds the service account can already deny an install a hundred ways; what they must not be
# able to do is aim a root-side write, and they cannot.
# ---------------------------------------------------------------------------
prepare_crontab_lock() {
  local self dir_meta file_meta dir_kind dir_owner dir_mode file_kind file_owner
  # 0 — the EUID guard at the top of every entrypoint has already refused to run as anything
  # else. It is asked rather than hardcoded so the check below reads as "owned by the privileged
  # user that owns this install", which is the property that matters, and so this function can be
  # exercised in a test harness that is not root.
  self="$(id -u)"

  # (1) THE DIRECTORY. Plain `mkdir`: a symlink already at this path makes it fail with EEXIST
  # instead of being followed, and we then refuse below rather than working inside it.
  if ! (umask 022; mkdir "${CRONTAB_LOCK_DIR}") 2>/dev/null; then
    [[ "$(stat -c '%F' "${CRONTAB_LOCK_DIR}" 2>/dev/null || true)" == "directory" ]] || die \
      "${CRONTAB_LOCK_DIR} exists and is not a directory (a symlink there is how a compromised '${APP_USER}' would aim a root-side write). Remove or fix that path, then run the installer again."
  fi
  # Take/keep root ownership. `-h` so this is safe even if the path became a symlink just now.
  chown -h root:root "${CRONTAB_LOCK_DIR}"

  # (2) THE FILE. Created, if missing, with O_CREAT|O_EXCL so a planted symlink is refused rather
  # than written through; never `touch`ed, and never chowned to the service user.
  #
  # The `-e` test is a CONVENIENCE, not the safety: it dereferences, so a symlink to an existing
  # file reads as "already there", and a DANGLING one reads as "missing" and falls into the
  # redirection below. `set -C` is what makes both of those safe — O_CREAT|O_EXCL fails with
  # EEXIST on a symlink and creates nothing, dangling or not — and the lstat that follows is what
  # refuses.
  if [[ ! -e "${CRONTAB_LOCK_FILE}" ]]; then
    ( umask 022; set -C; : > "${CRONTAB_LOCK_FILE}" ) 2>/dev/null || true
  fi
  # `stat -c %F` says "regular empty file" for a zero-length one, and this file is ALWAYS empty —
  # nothing ever writes to it. Both spellings are the same st_mode, and neither is a symlink.
  file_kind="$(stat -c '%F' "${CRONTAB_LOCK_FILE}" 2>/dev/null || true)"
  [[ "${file_kind}" == "regular file" || "${file_kind}" == "regular empty file" ]] || die \
    "${CRONTAB_LOCK_FILE} is not a regular file (it is a ${file_kind:-missing path}). The crontab reconciliation lock must be a plain file that only root can replace; refusing to write to that path."
  chown -h root:root "${CRONTAB_LOCK_FILE}"

  # (3) THE POST-CONDITIONS, re-read with lstat rather than assumed from the steps above.
  dir_meta="$(stat -c '%F|%u|%a' "${CRONTAB_LOCK_DIR}" 2>/dev/null || true)"
  IFS='|' read -r dir_kind dir_owner dir_mode <<< "${dir_meta}"
  [[ "${dir_kind}" == "directory" && "${dir_owner}" == "${self}" ]] || die \
    "${CRONTAB_LOCK_DIR} must be a directory owned by uid ${self} after preparation, and is '${dir_meta}'."
  # The whole protection is that the service user cannot write this DIRECTORY. A group- or
  # other-writable mode would give the lock file back to them, so it is refused, not chmod'ed away.
  (( (8#${dir_mode:-777} & 0022) == 0 )) || die \
    "${CRONTAB_LOCK_DIR} is mode ${dir_mode}: group- or other-writable, so '${APP_USER}' could still replace the lock file inside it. Set it to 0755 and run the installer again."
  file_meta="$(stat -c '%F|%u' "${CRONTAB_LOCK_FILE}" 2>/dev/null || true)"
  IFS='|' read -r file_kind file_owner <<< "${file_meta}"
  # No mode assertion on the FILE, deliberately: nothing ever reads or writes its contents, and it
  # cannot be replaced from inside a directory the service user cannot write. Only "root owns it and
  # it is a plain file" is load-bearing.
  [[ ( "${file_kind}" == "regular file" || "${file_kind}" == "regular empty file" ) \
     && "${file_owner}" == "${self}" ]] || die \
    "${CRONTAB_LOCK_FILE} must be a regular file owned by uid ${self} after preparation, and is '${file_meta}'."
}

# ---------------------------------------------------------------------------
# RUN A CRONTAB READ-MODIFY-WRITE UNDER THE EXCLUSION.
#
#   with_crontab_lock <function> [args...]
#
# ONE ACQUISITION PER READ-MODIFY-WRITE, not one per half. `crontab -l` and the `crontab -` that
# follows it are one critical section: releasing between them is what lets a reconciliation
# commit against the snapshot this run is about to overwrite, which is the finding.
#
# NOT A SUBSHELL. The redirection is on a `{ ...; }` group, so the body runs in THIS shell and
# the variables the callers set — CRON_FENCED, CRON_BACKUP_CREATED — survive it. A `( ... )`
# here would silently lose every one of them and the unwind would restore nothing.
#
# THE BODY'S EXIT STATUS IS THE RETURN VALUE, except that a lock we could not take returns
# ${CRONTAB_LOCK_CONFLICT} — a status no crontab body produces — so a caller can tell "the app is
# reconciling right now" from "the write failed". Callers DIE on it: writing without the lock is
# the defect itself, and skipping the write silently leaves a fenced crontab in place.
#
# REENTRANT BY REFUSAL, NOT BY RECURSION. flock on a second, independently opened descriptor for
# the same file blocks against the first — a nested call would deadlock until the timeout and
# then report a conflict that is this very process. So a nested call runs the body directly, on
# the lock the outer call is already holding.
# ---------------------------------------------------------------------------
CRONTAB_LOCK_CONFLICT=75
CRONTAB_LOCK_HELD=false

with_crontab_lock() {
  local rc=0
  if ${CRONTAB_LOCK_HELD}; then
    "$@" || rc=$?
    return "${rc}"
  fi
  [[ -n "${CRONTAB_LOCK_FILE:-}" ]] || die \
    "with_crontab_lock was called before CRONTAB_LOCK_FILE was composed (crontab_lock_paths). This is an ordering bug in the entrypoint, not an operator error: a crontab write that cannot be serialized against the application's can silently discard it."
  [[ -f "${CRONTAB_LOCK_FILE}" ]] || die \
    "${CRONTAB_LOCK_FILE} is missing or is not a regular file, so this crontab write cannot be serialized against the application's. prepare_crontab_lock creates it; that call must run before anything touches the crontab. Nothing has been written."
  {
    if flock --exclusive --timeout "${CRONTAB_LOCK_WAIT_SECONDS}" 7; then
      CRONTAB_LOCK_HELD=true
      "$@" || rc=$?
      CRONTAB_LOCK_HELD=false
    else
      rc=${CRONTAB_LOCK_CONFLICT}
    fi
  } 7<"${CRONTAB_LOCK_FILE}"
  return "${rc}"
}
