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
# UNPARSEABLE FALLS BACK TO THE CONSTANT, rather than to `flock --timeout <garbage>` — which exits
# non-zero and is indistinguishable here from "the application is reconciling right now", so an
# operator typo would report a lock conflict that never happened and abort a cutover with a message
# blaming a process that does not exist. Same rule the application applies to
# OTI_CRONTAB_LOCK_WAIT_MS (lib/crontab-reconcile-lock.ts).
if [[ ! "${CRONTAB_LOCK_WAIT_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${CRONTAB_LOCK_WAIT_SECONDS}" -le 0 ]]; then
  CRONTAB_LOCK_WAIT_SECONDS=60
fi

# Compose this entrypoint's lock paths from its state directory. The state directory is what
# systemd hands the service as $STATE_DIRECTORY, which is what the application reads.
#
# ABSOLUTE, OR NOTHING. `systemdStateDirectory()` ignores a STATE_DIRECTORY that is not an absolute
# path — a value that is not absolute is not systemd's, it is something in the environment wearing
# the name — and falls through to the working directory. An entrypoint composing a relative path
# here would therefore lock a file the application will never open, which is the "looks locked,
# excludes nothing" state this whole protocol exists to remove. It is refused rather than resolved.
crontab_lock_paths() {
  local state_dir="$1"
  [[ "${state_dir}" == /* ]] || die \
    "the crontab reconciliation lock cannot be composed from '${state_dir}': the state directory must be an ABSOLUTE path, because the application resolves the same lock from the STATE_DIRECTORY systemd exports and ignores a value that is not absolute. A relative path here would lock a file no other writer will ever open."
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

# THE ONE EXEMPTION, STATED HERE RATHER THAN SPELLED OUT AT EACH CALL SITE. deploy.sh and update.sh
# have a --dry-run that is documented to work unprivileged: it takes no root action, and no crontab
# WRITE is reachable under it. There is nothing for an exclusion to protect, and taking one would
# mean requiring root and a prepared lock file for a mode whose whole point is that it needs
# neither.
#
# "NO WRITE IS REACHABLE" HOLDS BY THREE DIFFERENT MECHANISMS, so it is worth saying which rather
# than asserting the conclusion:
#
#   • fence_cron_locked and unfence_cron_locked return after PRINTING what they would do, before any
#     `crontab -`. Exercised in tests/settings/crontab-reconcile-serialization.test.ts, run with NO
#     lock file present at all — which is also the proof that a dry run needs neither root nor a
#     prepared lock.
#   • resume_restore_cron_locked and adopt_cron_fence_locked are never reached: their callers sit in
#     the `else` of an `if $DRY_RUN` that prints instead.
#   • restore_cron_from_backup_locked is guarded by ${CRON_BACKUP_CREATED}, which only
#     publish_cron_backup raises — and fence_cron_locked's dry-run branch returns before it.
#
# The entrypoints set this from their own DRY_RUN and it is false everywhere else; the census in
# that same test asserts this is the ONLY path through with_crontab_lock that does not hold the
# lock.
CRONTAB_LOCK_DRY_RUN=false

with_crontab_lock() {
  local rc=0
  if ${CRONTAB_LOCK_DRY_RUN}; then
    "$@" || rc=$?
    return "${rc}"
  fi
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

# =============================================================================
# EXCLUSION ESTABLISHED ORDER. IT DID NOT ESTABLISH CORRECTNESS.
# (o3d-p9dq, Codex r27 HIGH x3 — all three are this one defect reached by three routes.)
# =============================================================================
# Round 26 put every writer of this crontab behind one flock, and that is what it does: two
# writers now take turns. What it cannot do is decide which of the two turns SHOULD win. A
# cutover that restores a snapshot it took before the new build began serving is a PERFECTLY
# ORDERED write of STALE CONTENT — it acquires the lock properly, writes properly, and discards
# a schedule change the application had already committed and already reported as saved. The
# operator was told the save succeeded. It did succeed. Then it was thrown away.
#
# So there are two facts about the crontab and they are not the same fact:
#
#   ORDER      no two writers interleave inside one read-modify-write   (the flock; round 26)
#   CORRECTNESS  the content that lands last is the content that is true (this section)
#
# WHERE THE TRUTH LIVES. The `cron_*` settings rows are the DURABLE RECORD of the managed
# schedule; the OTI block in the crontab is a PROJECTION of them, rebuilt from scratch by
# lib/crontab-reconcile.ts on every save. The unmanaged lines around it — operator entries,
# PATH/SHELL assignments, comments — are the opposite: the crontab is their only record and the
# database has never heard of them. Neither source is complete on its own, which is why a
# restore is a MERGE of two authorities and not a copy of one file:
#
#   the managed block          from whatever last projected the database  (the live crontab)
#   everything around it       from the pre-fence backup                  (the snapshot)
#
# THE FENCE IS UNDONE WHERE IT WAS APPLIED, NOT REPLAYED FROM A SNAPSHOT. The fence's whole
# effect is a prefix on the lines that were active; removing that prefix from the crontab AS IT
# STANDS is its exact inverse, and it carries forward every write that happened in between —
# including the block a reconciliation projected from a commit the snapshot predates. When
# nothing wrote, the two routes produce identical bytes, and `plan_crontab_unfence` proves that
# rather than assuming it: it compares the live crontab against the fence's own projection of the
# backup and only calls the snapshot route when they match exactly.
#
# AND WHEN THE MERGE WOULD LOSE SOMETHING, IT REFUSES. The subset check below is the half that
# makes this safe: an unmanaged line present in the backup and absent from the merge candidate is
# a line no other record holds, so the merge is abandoned and the caller says so. A backup is
# only safe to install blindly if the world still matches what it was taken from; when it does
# not, "refuse loudly" beats both "restore the old one" and "guess".

# =============================================================================
# A CRONTAB READ IS A QUESTION, AND A QUESTION THAT COULD NOT BE ANSWERED IS NOT THE
# ANSWER "NOTHING IS SCHEDULED"
# (o3d-p9dq, Codex r28 HIGH x2 — the `ss` finding of r27, reached again through `crontab -l`)
# =============================================================================
# Round 27 closed exactly this shape at the socket census: `ss` missing, `ss` non-zero and `ss`
# silent were all being read as "nobody is listening". Every `crontab -l` in these three
# entrypoints was written the other way and kept it open:
#
#     current="$(crontab -u "$APP_USER" -l 2>/dev/null || true)"
#
# `2>/dev/null` throws away the only thing that says WHY, and `|| true` turns every failure into
# the empty string. Two callers then read that empty string as a fact about the world:
#
#   fence_cron_locked        "No crontab for ${APP_USER}; nothing to fence."  — and the cutover
#                            walks on into the database fence and the migration with every
#                            existing cron entry still scheduled, which is the writer class the
#                            whole-crontab fence exists to stop.
#   unfence_cron_locked      an empty live crontab holds nothing the backup does not, so the
#                            pre-cutover snapshot goes back — over a schedule the application
#                            committed and reported as saved while the fence was up.
#
# THE SEPARATION, ESTABLISHED ON THE PLATFORMS THIS SHIPS TO RATHER THAN ASSUMED. Debian 11/12 and
# Ubuntu 22.04/24.04 all carry Vixie cron (Debian `cron`, /usr/bin/crontab, setgid crontab).
# `crontab -u <user> -l` was run on one of them in each state:
#
#   the user has a crontab            rc=0  stdout=the crontab      stderr=(empty)
#   the user has an EMPTY crontab     rc=0  stdout=(empty)          stderr=(empty)
#   the user has NO crontab           rc=1  stdout=(empty)          stderr=`no crontab for <user>`
#   no such user                      rc=1  stdout=(empty)          stderr=``crontab:  user `x' unknown``
#   not privileged to use -u          rc=1  stdout=(empty)          stderr=`must be privileged to use -u`
#
# So the exit status alone CANNOT separate the benign answer from the failures — every one of them
# is 1 with empty output, which is precisely why `|| true` looked harmless. What separates them is
# the diagnostic: the absent-crontab case, and only it, says `no crontab for <that user>` and says
# nothing else. This reader therefore resolves an absence ONLY from that message, matched whole
# against the user it asked about, with empty output alongside it. Anything else — a different
# message, an extra line, no message at all — is an UNRESOLVED READ, and every caller refuses.
#
# Deliberately strict: a message this reader does not recognise is treated as a failure rather than
# guessed at, because the cost of the two mistakes is not symmetric. An unresolved read costs a
# re-run; an unresolved read mistaken for an empty crontab costs a migration under live cron
# writers, or a committed schedule silently discarded.
#
#   read_crontab_for <user>
#
#   0  the read RESOLVED. CRONTAB_READ_TEXT holds the crontab (empty when there is none), and
#      CRONTAB_READ_PRESENT says which of "empty crontab" and "no crontab" it was.
#   1  the read did NOT resolve. CRONTAB_READ_REASON says what happened; the caller must refuse.
CRONTAB_READ_TEXT=""
CRONTAB_READ_PRESENT=false
CRONTAB_READ_REASON=""

# Is <stderr> the one benign diagnostic, and nothing else? Normalised for a leading `crontab: `
# prefix and surrounding whitespace, then compared WHOLE: a second line, or any trailing text,
# leaves the read unresolved rather than being skimmed for a substring.
crontab_read_says_no_crontab() {
  local user="$1" err="$2" normalised
  normalised="$(printf '%s' "${err}" | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^crontab:[[:space:]]*//')"
  [[ "${normalised}" == "no crontab for ${user}" ]]
}

read_crontab_for() {
  local user="${1:-}" err_file out err rc=0
  CRONTAB_READ_TEXT=""
  CRONTAB_READ_PRESENT=false
  CRONTAB_READ_REASON=""

  if [[ -z "${user}" ]]; then
    CRONTAB_READ_REASON="the crontab owner could not be resolved, so there is no user to ask about and nothing can establish what is scheduled"
    return 1
  fi
  # NOT the same shape as a missing `ss`, and the difference is the reason this one is an answer.
  # `ss` absent leaves the port question unanswered — something can still be bound. A host with no
  # `crontab` binary has no per-user crontabs for anything to have written, so "there is nothing to
  # fence" is established rather than assumed. The callers that reach this treat it as an
  # unresolved read anyway; the ones that can act on it check `command -v crontab` themselves and
  # say so.
  if ! command -v crontab >/dev/null 2>&1; then
    CRONTAB_READ_REASON="\`crontab\` is not installed on this host, so it cannot be asked what ${user} has scheduled"
    return 1
  fi

  # THE DIAGNOSTIC IS CAPTURED, NOT DISCARDED — it is the whole basis of the separation above — and
  # the exit status is taken on its own line rather than inside a pipeline that would hide it.
  err_file="$(mktemp "${TMPDIR:-/tmp}/ims-crontab-read.XXXXXX" 2>/dev/null)" || {
    CRONTAB_READ_REASON="a temporary file for \`crontab -u ${user} -l\`'s diagnostics could not be created, so a failed read could not be told from an absent crontab"
    return 1
  }
  out="$(crontab -u "${user}" -l 2>"${err_file}")" || rc=$?
  err="$(cat "${err_file}" 2>/dev/null)" || err=""
  rm -f "${err_file}"

  if [[ "${rc}" -eq 0 ]]; then
    CRONTAB_READ_TEXT="${out}"
    CRONTAB_READ_PRESENT=true
    return 0
  fi
  if [[ -z "${out}" ]] && crontab_read_says_no_crontab "${user}" "${err}"; then
    CRONTAB_READ_PRESENT=false
    return 0
  fi
  CRONTAB_READ_REASON="\`crontab -u ${user} -l\` exited ${rc} and did not answer that ${user} has no crontab — it said: ${err:-nothing at all}. An unreadable crontab is not an empty one"
  return 1
}

# The mark the fence puts in front of every active line, stated ONCE so that the projection, its
# inverse and every message quote the same string. Three copies of a sentinel is three sentinels.
CRON_FENCE_PREFIX='#DEPLOY-FENCE# '

# THE FENCE, AS A PURE FUNCTION. `fence_cron_locked` in all three entrypoints runs its crontab
# through THIS, so the comparison in plan_crontab_unfence() below is asking about the transform
# that was actually applied rather than about a re-typed copy of it that can drift.
#
# Comment lines and blank lines pass through untouched: they are already inert, and prefixing
# them would make the inverse ambiguous.
crontab_fence_projection() {
  printf '%s\n' "$1" \
    | awk '{ if ($0 ~ /^[[:space:]]*[^#[:space:]]/) print "#DEPLOY-FENCE# " $0; else print $0 }'
}

# ITS EXACT INVERSE: remove the mark this protocol added, and nothing else. Anchored, and it
# strips ONE occurrence from the front of the line, so a line an operator wrote that happens to
# contain the sentinel further along is untouched.
crontab_unfence_projection() {
  printf '%s\n' "$1" | awk '{ sub(/^#DEPLOY-FENCE# /, ""); print }'
}

# WHICH LINES ONLY THE CRONTAB REMEMBERS — and are they all still there, as many times as there
# were, in the order they were in?
#
#   crontab_unmanaged_lines_missing_from <backup-text> <candidate-text>
#
# Prints every line of <backup> that lives OUTSIDE an OTI managed block and cannot be matched, in
# order, against a distinct line of <candidate> outside ITS managed block. Prints nothing — and
# returns 0 — when the backup's unmanaged content is an ordered subsequence of the candidate's.
#
# A SUBSEQUENCE WITH MULTIPLICITY, NOT A SET (o3d-p9dq, Codex r28 MEDIUM). This used to build one
# `have[$0]` table out of the candidate and ask whether each backup line appeared in it at all,
# which throws away two things a crontab actually means:
#
#   HOW MANY TIMES. Two identical entries run the job TWICE. A backup holding an operator's job on
#   two lines was satisfied by a candidate holding it on one, the merge was declared lossless, the
#   backup was deleted, and the schedule quietly halved.
#   IN WHAT ORDER. `PATH=`, `SHELL=`, `MAILTO=` and `CRON_TZ=` apply to the entries BELOW them and
#   not to the ones above. Every line still existing after a reordering is not the same crontab: a
#   job that moved above the `CRON_TZ=` that dated it now runs in a different timezone. A set test
#   cannot see that at all.
#
# So each backup line consumes a DISTINCT candidate line and the cursor only moves forwards.
# Gaining lines is still allowed — a managed block the application projected while the fence was
# up, an operator entry added since — because inserting into a sequence leaves it a subsequence.
#
# The managed block is excluded on BOTH sides: replacing it is the entire point of a merge, its
# truth is the settings rows rather than these bytes, and an unmanaged backup line must not be
# counted as preserved because it happens to appear inside the block a reconciliation generated.
# Blank lines are ignored because neither writer preserves how many there were. Everything else is
# compared as a whole line, exactly, because an operator's cron entry is not a thing to approximate.
crontab_unmanaged_lines_missing_from() {
  local backup="$1" candidate="$2"
  awk '
    function is_start(x) { return x ~ /^# --- OTI CRON START ---[ \t\r]*$/ }
    function is_end(x)   { return x ~ /^# --- OTI CRON END ---[ \t\r]*$/ }
    function is_blank(x) { return x ~ /^[[:space:]]*$/ }
    NR == FNR {
      if (is_start($0)) { c_block = 1; next }
      if (is_end($0))   { c_block = 0; next }
      if (c_block || is_blank($0)) next
      cand[++m] = $0
      next
    }
    {
      if (is_start($0)) { b_block = 1; next }
      if (is_end($0))   { b_block = 0; next }
      if (b_block || is_blank($0)) next
      back[++n] = $0
    }
    END {
      cursor = 1
      for (i = 1; i <= n; i++) {
        j = cursor
        while (j <= m && cand[j] != back[i]) j++
        if (j <= m) { cursor = j + 1 } else { print back[i] }
      }
    }
  ' <(printf '%s\n' "${candidate}") <(printf '%s\n' "${backup}")
}

# IS THE WORLD STILL THE ONE THE SNAPSHOT WAS TAKEN FROM?
#
#   crontab_is_unmoved_since_backup <backup-text> <live-crontab-text>
#
# True only when the live crontab is EXACTLY the fence's own projection of <backup>, byte for byte
# — which is what "the only write since the snapshot was the fence itself" looks like, and the one
# condition under which installing the snapshot cannot discard anything. `crontab -` on the Vixie
# cron these scripts ship to writes its input verbatim and `crontab -l` reads it back verbatim, so
# this equality is a real test and not a formatting lottery.
crontab_is_unmoved_since_backup() {
  local backup="$1" live="$2"
  [[ "${live}" == "$(crontab_fence_projection "${backup}")" ]]
}

# HOW A FENCED CRONTAB IS PUT BACK.
#
#   plan_crontab_unfence <backup-text> <live-crontab-text>
#
# Sets, and the caller reads:
#   CRON_UNFENCE_PLAN    snapshot | merge | refuse
#   CRON_UNFENCE_TEXT    what to install (snapshot and merge only)
#   CRON_UNFENCE_REASON  why it refused, or what the merge carried forward
#
# Returns 0 for snapshot and merge, non-zero for refuse. It NEVER writes the crontab: the write
# stays in the entrypoints' `*_locked` bodies, which is where the one-writer census can see it.
#
# A status of its own for "the world moved", so a caller can tell it from a failed write and from
# a lock it could not take — the same reason ${CRONTAB_LOCK_CONFLICT} exists. It is deliberately
# not 1: an entrypoint that mistook a divergence for an ordinary error would print the wrong
# recovery.
CRONTAB_UNFENCE_DIVERGED=76
CRON_UNFENCE_PLAN=""
CRON_UNFENCE_TEXT=""
CRON_UNFENCE_REASON=""
plan_crontab_unfence() {
  local backup="$1" live="$2" merged missing
  CRON_UNFENCE_PLAN=""
  CRON_UNFENCE_TEXT=""
  CRON_UNFENCE_REASON=""

  # (1) DID ANYTHING WRITE? Asked by comparing the live crontab with the fence's OWN projection of
  # the backup, byte for byte. Equal means the only write since the snapshot was the fence itself,
  # so the snapshot is provably current and goes back verbatim — the pre-existing behaviour, now
  # with a proof under it instead of an assumption.
  if crontab_is_unmoved_since_backup "${backup}" "${live}"; then
    CRON_UNFENCE_PLAN="snapshot"
    CRON_UNFENCE_TEXT="${backup}"
    return 0
  fi

  # A DELETION IS A WRITE (o3d-p9dq, Codex r28 HIGH #1, second half). Round 27 had a branch here
  # for a live crontab that had only LOST lines: it restored the snapshot, on the reasoning that
  # there was no write to discard. Two of the three things that produce that reading were an
  # unreadable `crontab -l` — now impossible, because read_crontab_for() refuses instead of
  # returning an empty string — and the third is somebody having deleted a cron entry on purpose.
  # Restoring the snapshot over that RESURRECTS the entry: an operator who ran `crontab -e` to stop
  # a job, and was given no error, finds it scheduled again. So there is no lost-lines branch any
  # more. A deletion falls through to the merge below exactly like every other write, and the
  # subsequence check is what decides: the deleted line is a backup line the candidate does not
  # hold, so the merge refuses and NAMES it, leaving the backup on disk to settle by hand.

  # (2) SOMETHING WROTE. Undo the fence where it was applied: the live crontab minus the marks.
  # That keeps the managed block whoever wrote it last projected from the settings rows, and it
  # keeps any unmanaged line added while the fence was up.
  merged="$(crontab_unfence_projection "${live}")"
  missing="$(crontab_unmanaged_lines_missing_from "${backup}" "${merged}")"
  if [[ -z "${missing}" ]]; then
    CRON_UNFENCE_PLAN="merge"
    CRON_UNFENCE_TEXT="${merged}"
    CRON_UNFENCE_REASON="the crontab changed while it was fenced; the managed block that was written over it has been kept and the fence marks removed from the lines around it"
    return 0
  fi

  # (3) THE MERGE WOULD DROP A LINE NOTHING ELSE HOLDS. Neither candidate is safe to install —
  # the backup would discard whatever wrote, the merge would discard these — so nothing is
  # installed and the divergence is named.
  CRON_UNFENCE_PLAN="refuse"
  CRON_UNFENCE_REASON="the crontab was rewritten while it was fenced, by something that dropped $(printf '%s\n' "${missing}" | grep -c . || true) line(s) present in the backup and held in no other record:
$(printf '%s\n' "${missing}" | sed 's/^/    /')"
  return 1
}

# =============================================================================
# THE DRAIN IS A PROOF, AND A PROOF THAT COULD NOT BE TAKEN IS NOT A NEGATIVE ANSWER
# (o3d-p9dq, Codex r27 HIGH #3)
# =============================================================================
# The cutover fence moved BELOW the stop in round 26 for the reason this file's header gives: on
# the first rollout the process serving the box was built before the flock existed, so the only
# exclusion that reaches it is that it is not running. "Nothing is serving" therefore stopped
# being a remark and became the PREMISE the fence rests on.
#
# The first implementation of that premise established it like this:
#
#     if command -v ss >/dev/null 2>&1; then …refuse if :PORT is bound…; fi
#     warn "cannot check :PORT"          # …and then fence anyway
#
# which reads a MISSING TOOL as a proof of absence. So does `ss -ltn 2>/dev/null | grep -q` when
# `ss` exits non-zero: the pipeline yields nothing, the grep fails to match, and an unanswerable
# question is recorded as the answer "nobody is there". This branch has closed that same shape —
# absence of evidence read as evidence of absence — at the responder attribution, at the listener
# census and at the marker sentinel. It does not get to stay open at the one proof the crontab
# fence now depends on.
#
#   require_port_drained <port>
#
# Returns 0 ONLY when a socket census actually RAN and reported no listener on <port>. A port that
# could not be resolved, an `ss` that is not installed, an `ss` that exits non-zero, and an `ss`
# that produces no output at all — not even the header row it always prints — are all failures
# with PORT_DRAIN_REASON set. The caller dies; it does not warn and proceed.
PORT_DRAIN_REASON=""
PORT_DRAIN_LISTENERS=""
PORT_DRAIN_WAIT_SECONDS="${IMS_PORT_DRAIN_WAIT_SECONDS:-15}"
# Same rule the lock wait applies to its own knob: an unparseable value falls back to the constant
# rather than being handed to arithmetic, where it would abort the run blaming a listener nobody saw.
if [[ ! "${PORT_DRAIN_WAIT_SECONDS}" =~ ^[0-9]+$ ]]; then
  PORT_DRAIN_WAIT_SECONDS=15
fi

# THE CENSUS, CAPTURED AND VALIDATED SEPARATELY FROM THE EMPTY-LISTENER TEST. `ss` output goes
# into a variable whose exit status is checked on its own line; only then is it counted. A single
# `ss … | awk` pipeline cannot tell the two apart, which is the whole finding.
#   0  census taken; PORT_DRAIN_LISTENERS holds the count for <port>
#   1  census could NOT be taken; PORT_DRAIN_REASON says why
port_listener_census() {
  local port="$1" out rc=0
  PORT_DRAIN_LISTENERS=""
  out="$(ss -ltn 2>/dev/null)" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    PORT_DRAIN_REASON="\`ss -ltn\` exited ${rc}, so the socket census FAILED. An empty reading from a failed query is not an absent listener"
    return 1
  fi
  # `ss -ltn` always prints its header row. Nothing at all means the command did not do what it
  # was asked, whatever it exited with — a shim, a seccomp denial, a truncated pipe.
  if [[ -z "${out//[[:space:]]/}" ]]; then
    PORT_DRAIN_REASON="\`ss -ltn\` exited 0 but produced no output at all, not even its header row, so its silence cannot be read as an absent listener"
    return 1
  fi
  PORT_DRAIN_LISTENERS="$(printf '%s\n' "${out}" \
    | awk -v p=":${port}\$" '$4 ~ p { n += 1 } END { print n + 0 }')"
  return 0
}

require_port_drained() {
  local port="$1" waited=0
  PORT_DRAIN_REASON=""
  if [[ -z "${port}" ]]; then
    PORT_DRAIN_REASON="the application port could not be resolved, so no socket census can be taken and nothing can establish that the port is free"
    return 1
  fi
  if ! command -v ss >/dev/null 2>&1; then
    PORT_DRAIN_REASON="\`ss\` is not installed (iproute2), so this host cannot be asked whether anything is still listening on :${port}"
    return 1
  fi
  while :; do
    port_listener_census "${port}" || return 1
    [[ "${PORT_DRAIN_LISTENERS}" -eq 0 ]] && return 0
    [[ "${waited}" -ge "${PORT_DRAIN_WAIT_SECONDS}" ]] && break
    sleep 1
    waited=$(( waited + 1 ))
  done
  PORT_DRAIN_REASON="${PORT_DRAIN_LISTENERS} socket(s) are still listening on :${port} ${PORT_DRAIN_WAIT_SECONDS}s after the stop, so something is still serving (ss -ltnp | grep :${port})"
  return 1
}
