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
#     resolves ${CUTOVER_ROOT_DIR}/locks/.crontab-reconcile.lock — the same path the entrypoints
#     resolve, from a root-owned parent neither of them can be talked out of. Against that process
#     the lock is sufficient on its own, and o3d-txoe is why it is that path and not the state
#     directory's; see THE TWO PARTIES SHARE AN IDENTITY below.
#
#   • A LIVE APPLICATION RUNNING THE PREDECESSOR BUILD DOES NOT — except where the bridge below
#     reaches it. On the FIRST rollout of this protocol the process serving the box was built
#     before it existed: its reconciliation takes a PostgreSQL session advisory lock, or nothing at
#     all, and no flock this script takes can reach it. Against that process the ONLY exclusion is
#     that it is not running — which is why the cutover's own `fence_cron` was moved to AFTER
#     `systemctl stop` and the port drain, and is not merely wrapped in a lock it would have shared
#     with nobody. A predecessor built AFTER the shared path existed but BEFORE it moved is a
#     different case and is bridged; see prepare_legacy_crontab_lock().
#
# So the two mechanisms cover different sets, and the entrypoints say which one covers each of
# their call sites in the comment above it. Every site takes the lock; the sites that run while
# something may still be serving say so.
#
# ---------------------------------------------------------------------------
# THE TWO PARTIES SHARE AN IDENTITY, AND THE KERNEL IS WHAT MAKES THEM (o3d-txoe, Codex HIGH)
# ---------------------------------------------------------------------------
# A MUTUAL-EXCLUSION PRIMITIVE HAS TWO PARTIES, AND THE ONLY PROPERTY THAT MATTERS IS THAT THEY
# NAME THE SAME INODE. Until this round the lock lived at ${DATA_DIR}/locks/.crontab-reconcile.lock,
# and ${DATA_DIR} is the service's systemd StateDirectory — which systemd creates OWNED BY
# ${APP_USER} and which must stay writable by that account. `rename(2)` asks for write permission on
# the PARENT and asks nothing whatever about the directory being moved, so that account could:
#
#     mv  ${DATA_DIR}/locks  ${DATA_DIR}/locks-aside
#     mkdir ${DATA_DIR}/locks && : > ${DATA_DIR}/locks/.crontab-reconcile.lock
#
# and the two parties then locked whatever inode stood at the name at the instant each of them
# opened it. Measured, in a real bash against the shipped library and the shipped module: the shell
# entered on one inode while the application entered on another, BOTH reported exclusion, and the
# application's committed schedule was discarded by the shell's write of a snapshot taken before it.
#
# AND IT COULD NOT BE CLOSED ON ONE SIDE. Pinning the shell's descriptor alone (o3d-q766 r1) made
# the split PERSIST for a whole run instead of converging on the next acquisition, which is why that
# attempt was reverted in full. The remedy is a RELOCATION, taken by both parties in one change.
#
# THE LOCK NOW LIVES BENEATH A PARENT ${APP_USER} CANNOT RENAME WITHIN:
#
#     /                                          root-owned
#     /etc                                       root-owned, 0755
#     ${CUTOVER_ROOT_DIR}                        root-owned, 0711  (ensure_cutover_root_dir asserts it)
#       └── ${CRONTAB_LOCK_DIRNAME}/             root-owned, mode & 0022 == 0, o+x
#             └── ${CRONTAB_LOCK_FILENAME}       root-owned, world-readable, never written
#
# No account but root can create, rename or unlink any component of that pathname, so the pathname
# resolves to ONE inode for every party that utters it. That is a KERNEL guarantee and not an
# agreement: it does not depend on the two parties doing the resolution at the same moment, and an
# ${APP_USER}-initiated rename of any component fails with EACCES rather than splitting them.
#
# WHAT REMAINS AN AGREEMENT, stated so it is not mistaken for the above: the two parties must
# COMPOSE the same pathname out of the same three pieces. ${CUTOVER_ROOT_DIR} is a literal in each
# entrypoint and CRONTAB_RECONCILE_LOCK_ROOT is the same literal in lib/crontab-reconcile-lock.ts,
# and tests/settings/crontab-reconcile-serialization.test.ts RESOLVES both — bash evaluating the
# entrypoint's own declaration, the shipped function asked for its own answer — rather than
# comparing basenames.
#
# ---------------------------------------------------------------------------
# THE DESCRIPTOR, AND WHY IT IS NOT fd 9, AND WHY IT IS NO LONGER fd 7 EITHER
# ---------------------------------------------------------------------------
# All three entrypoints hold the shared CUTOVER lock on fd 9 for the whole run
# (`acquire_cutover_lock`), and the legacy namespace lock on fd 8. `exec 9<somefile` REPLACES
# fd 9, which closes the open file description underneath it — and closing the last descriptor
# on an flock RELEASES it. Round 22's crontab section did exactly that: from the moment it ran,
# the run that was supposedly excluding every other cutover was excluding nothing, and its final
# `exec 9>&-` left the process with no cutover lock at all. The crontab lock therefore lives on
# its own descriptor.
#
# THAT DESCRIPTOR IS NOW OPENED ONCE, BY prepare_crontab_lock(), WHERE ITS PROOF IS STILL FRESH,
# AND IS HELD FOR THE REST OF THE RUN (o3d-q766). It used to be a literal 7 attached to a
# `{ ...; }` group, on the argument that bash before 5.2 does not close an automatically allocated
# descriptor when its compound command completes — true, and it was the right argument while the
# descriptor was MEANT to die with the group. It is not any more: the whole point is that the
# identity established by the preparation is the identity the exclusion is taken on, so bash
# allocates the number (`exec {CRONTAB_LOCK_FD}<`) and ${CRONTAB_LOCK_FD} is EMPTY until
# preparation has run. A literal would only have bought a collision with whatever the caller left
# at 7.
#
# THE LOCK IS STILL EXACTLY ONE READ-MODIFY-WRITE LONG, because the release is `flock --unlock` on
# that descriptor and not the closing of it. flock(2) attaches the lock to the OPEN FILE
# DESCRIPTION, so LOCK_UN releases it for every duplicate — including one a `crontab -` child
# inherited — and a descriptor that outlives the critical section therefore does not outlive the
# exclusion. What DOES change is the reentrancy guard's meaning, and with_crontab_lock() says so:
# with one descriptor a nested acquisition would SUCCEED (flock on a description that already holds
# the lock returns at once) and its release would drop the outer call's lock, so ${CRONTAB_LOCK_HELD}
# is load-bearing rather than an optimisation.
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

# The two components, stated ONCE. Every entrypoint composes its lock path out of these and the
# root-owned cutover namespace, and lib/crontab-reconcile-lock.ts exports the identical pair as
# CRONTAB_RECONCILE_LOCK_DIRNAME / CRONTAB_RECONCILE_LOCK_FILENAME. That agreement is resolved
# and asserted in tests/settings/crontab-reconcile-serialization.test.ts.
CRONTAB_LOCK_DIRNAME="locks"
CRONTAB_LOCK_FILENAME=".crontab-reconcile.lock"

# The descriptor the exclusion is held on, and the one the pre-relocation bridge is held on.
#
# BOTH ARE EMPTY UNTIL prepare_crontab_lock() HAS RUN, and that is the point: a name bound to a
# number before anything has been proved is a number with_crontab_lock() could take a lock on
# without a preparation ever having happened. Under `set -u` an acquisition that reached the
# `flock` without a preparation aborts the run instead. bash allocates the numbers — `exec
# {CRONTAB_LOCK_FD}<` — so 8 and 9 (the cutover locks) and 6 (the rotated cutover lock) cannot be
# collided with, and neither can whatever the caller left at 7. See THE DESCRIPTOR above for why
# this is no longer the literal it used to be.
CRONTAB_LOCK_FD=""
CRONTAB_LEGACY_LOCK_FD=""
# The pre-relocation location, composed beside the canonical one so the bridge can reach a
# predecessor build. EMPTY means "no bridge is being attempted"; prepare_legacy_crontab_lock()
# decides, and says out loud when it declines.
CRONTAB_LEGACY_LOCK_DIR=""
CRONTAB_LEGACY_LOCK_FILE=""

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

# Compose this entrypoint's lock paths.
#
#   crontab_lock_paths <cutover-root-dir> <pre-relocation-state-dir>
#
# THE FIRST ARGUMENT IS THE ROOT-OWNED NAMESPACE, ${CUTOVER_ROOT_DIR}, and it is the whole of
# o3d-txoe: the lock must sit beneath a parent ${APP_USER} cannot rename within, and the
# application must DERIVE the same one. Each entrypoint declares that root as a `readonly` literal
# and lib/crontab-reconcile-lock.ts declares the identical literal as CRONTAB_RECONCILE_LOCK_ROOT;
# nothing here reads an environment variable for it, because a lock location an operator can move
# on one side and not the other is two locks pretending to be one.
#
# THE SECOND IS WHERE THE LOCK USED TO BE — the service's systemd StateDirectory — kept only so
# that a PREDECESSOR build, which resolves its lock there, is still excluded during the one rollout
# window in which the two builds disagree. See prepare_legacy_crontab_lock(); the bridge is
# conditional on a precondition it checks, and it says so when it declines.
#
# ABSOLUTE, OR NOTHING, for both. A relative path names a different directory for every process
# that reads it, so an entrypoint composing one would lock a file no other writer will ever open —
# the "looks locked, excludes nothing" state this whole protocol exists to remove. It is refused
# rather than resolved.
crontab_lock_paths() {
  local root_dir="$1" legacy_state_dir="$2"
  [[ "${root_dir}" == /* ]] || die \
    "the crontab reconciliation lock cannot be composed from '${root_dir}': the cutover namespace root must be an ABSOLUTE path, because lib/crontab-reconcile-lock.ts derives the same lock from the identical absolute literal. A relative path here would lock a file no other writer will ever open."
  [[ "${legacy_state_dir}" == /* ]] || die \
    "the pre-relocation crontab lock cannot be composed from '${legacy_state_dir}': the state directory must be an ABSOLUTE path. A relative path here would bridge to a file no predecessor will ever open, which reads as covered and is not."
  CRONTAB_LOCK_DIR="${root_dir}/${CRONTAB_LOCK_DIRNAME}"
  CRONTAB_LOCK_FILE="${CRONTAB_LOCK_DIR}/${CRONTAB_LOCK_FILENAME}"
  CRONTAB_LEGACY_LOCK_DIR="${legacy_state_dir}/${CRONTAB_LOCK_DIRNAME}"
  CRONTAB_LEGACY_LOCK_FILE="${CRONTAB_LEGACY_LOCK_DIR}/${CRONTAB_LOCK_FILENAME}"
}

# ---------------------------------------------------------------------------
# THE CRONTAB RECONCILIATION LOCK IS ROOT-OWNED, INSIDE A ROOT-OWNED PARENT NOBODY ELSE CAN
# RENAME WITHIN, AND NO ROOT-SIDE STEP FOLLOWS A SYMLINK
# (Codex r24 CRITICAL, and o3d-txoe for where it lives).
#
# WHERE IT USED TO BE, AND WHY THAT COULD NOT BE MADE SAFE. ${DATA_DIR} is the service's systemd
# StateDirectory. systemd creates it OWNED BY ${APP_USER}, and it MUST be writable by that user —
# that is what made the lock reachable under the hardened unit at all (r23). Round 23 put the lock
# file directly in it and, as root, ran `touch`, `chown` and `chmod` on that path on every install
# and every upgrade. All three follow symlinks, so the unprivileged service account could replace
# the lock with a symlink to /etc/shadow and wait. r24 answered that by putting the lock inside a
# root-owned SUBDIRECTORY of ${DATA_DIR} — which closed the symlink-to-target route and left the
# one that could not be closed from inside that directory: ${APP_USER} owns the PARENT, and
# `rename(2)` asks for write permission on the parent and nothing about the directory being moved.
# So that account could move the root-owned lock directory aside and leave its own at the name, and
# the two parties then locked whatever inode each of them found. Both reported exclusion; neither
# had it. Every step below re-derived what it was looking at with lstat and DIED, which made the
# root-side WRITES safe and did nothing at all for the EXCLUSION — because a refusal and a
# substitution are not the same outcome, and the application never refused.
#
# SO THE LOCK MOVED (o3d-txoe). ${CRONTAB_LOCK_DIR} is now ${CUTOVER_ROOT_DIR}/${CRONTAB_LOCK_DIRNAME}:
#
#   ${CUTOVER_ROOT_DIR}
#       root:root, 0711, under root-owned /etc. ensure_cutover_root_dir() in
#       scripts/lib/cutover-namespace.sh creates it, refuses a symlink at it both before and after
#       its `mkdir -p`, and reads its owner and mode back off the descriptor it stepped into. This
#       function calls that one rather than restating it: a rule about where a privileged process
#       may write cannot be stated twice and stay one rule.
#   ${CRONTAB_LOCK_DIR}
#       root:root, created by enter_service_subdir()'s walk under `umask 022`, so 0755. Group- and
#       other-WRITABLE is refused; other-EXECUTABLE is REQUIRED, because ${APP_USER} has to be able
#       to traverse into it to open the lock — a directory the application cannot reach is an
#       exclusion the application cannot join.
#   ${CRONTAB_LOCK_FILE}
#       root:root, 0644 from `umask 022` at creation. World-readable so the service can open it
#       READ-ONLY and flock it; never given away to ${APP_USER}, and never written by anyone — its
#       CONTENTS are meaningless, only its inode is the lock.
#
# NOTHING BELOW FOLLOWS A SYMLINK, and each primitive is chosen for that:
#
#   • enter_service_subdir() FOR THE DIRECTORY, rather than a `mkdir -p` here. It creates the one
#     component beneath ${CUTOVER_ROOT_DIR} with a PLAIN `mkdir` (EEXIST on a planted symlink, where
#     `mkdir -p` succeeds silently inside the link's target), lstats what is there, steps in with
#     `cd -P`, and proves after the step that the directory it landed in IS the inode the entry
#     named and that its `..` is still the directory it came from. It leaves this process INSIDE the
#     proved directory, which is the whole reason the steps after it can name single components.
#   • `set -C` (noclobber) redirection — open(O_CREAT|O_EXCL), which by POSIX fails with EEXIST
#     when the final component is a symlink, and so cannot create or truncate the target.
#     `touch`, and a plain `: >` redirection, both follow.
#   • `stat` and `[[ -L ]]` — both lstat. `stat -c %F` reports "symbolic link" rather than the
#     target's type. `stat -L` appears below on /proc/self/fd/N and nowhere else, because there
#     dereferencing the magic link is what makes it an fstat of the OPEN FILE.
#   • `chown -h` — never dereferences: on a symlink it changes the LINK, so even a path swapped
#     between the check and the call cannot hand a target away.
#   • NO `chmod`, anywhere on these paths. chmod has no --no-dereference on Linux, so a
#     raced chmod is the same escalation with a different verb. Modes come from `umask` at
#     creation, and a mode that is already wrong is REFUSED rather than corrected.
#
# AND THE DESCRIPTOR IS OPENED HERE, WHERE THE PROOF IS STILL FRESH (o3d-q766). The file is opened
# as a SINGLE COMPONENT from the pinned directory, and the descriptor is then checked against the
# inode the post-conditions above it passed on — through /proc/self/fd/N, which the kernel resolves
# to the open file and not to any pathname. with_crontab_lock() flocks THAT descriptor. Nothing
# after this function resolves ${CRONTAB_LOCK_FILE}'s ancestry a second time, so there is no second
# lookup for a rename to land between, and there is no window in which root's read-only redirection
# could reach a named pipe: the only account that can create an entry in the pinned directory is
# root.
#
# WHAT IS STILL POSSIBLE, stated rather than glossed over: ROOT can do anything, including rename
# ${CRONTAB_LOCK_DIR} aside — the descriptor makes that harmless rather than impossible, which is
# open_root_owned_ancestry()'s distinction and the same one. ${APP_USER} can do nothing to this
# pathname at all: every component of it is root-owned and writable by nobody else, so the rename
# that used to split the two parties now fails with EACCES. Whoever holds the service account can
# still deny an install a hundred ways — holding this lock is one of them, and it is deliberate,
# because being able to hold it is what makes the application a party to the exclusion.
# ---------------------------------------------------------------------------
prepare_crontab_lock() {
  local self saved dir_meta file_meta dir_kind dir_owner dir_mode file_kind file_owner file_ident held_ident
  # 0 — the EUID guard at the top of every entrypoint has already refused to run as anything
  # else. It is asked rather than hardcoded so the check below reads as "owned by the privileged
  # user that owns this install", which is the property that matters, and so this function can be
  # exercised in a test harness that is not root.
  self="$(id -u)" || die \
    "\`id -u\` failed, so this run cannot establish which uid it is and cannot check that the crontab lock at ${CRONTAB_LOCK_DIR} belongs to it. An unanswerable ownership question is not an ownership proof."
  [[ -n "${CRONTAB_LOCK_DIR:-}" && -n "${CRONTAB_LOCK_FILE:-}" ]] || die \
    "prepare_crontab_lock was called before crontab_lock_paths composed the lock's location. This is an ordering bug in the entrypoint, not an operator error."

  # 0b — THE HELPERS THIS PREPARATION IS BUILT OUT OF, NAMED AND REQUIRED RATHER THAN ASSUMED.
  # scripts/lib/cutover-namespace.sh is sourced by all three entrypoints a few lines after this
  # library, and bash resolves a function at CALL time, so the order is fine. A harness — or a
  # future entrypoint — that sourced only this file would otherwise meet "command not found" and an
  # abort with no explanation. An unavailable proof is not a proof: this refuses rather than
  # composing the lock somewhere nothing has established.
  if ! declare -F ensure_cutover_root_dir >/dev/null \
     || ! declare -F enter_service_subdir >/dev/null \
     || ! declare -F verify_held_lock >/dev/null \
     || ! declare -F dir_is_private_to_this_run >/dev/null; then
    die "the crontab reconciliation lock is prepared beneath the root-owned cutover namespace, and the helpers that create and prove that namespace (ensure_cutover_root_dir, enter_service_subdir, verify_held_lock and dir_is_private_to_this_run, all in scripts/lib/cutover-namespace.sh) are not defined in this shell. This is a sourcing-order bug in the entrypoint, not an operator error: refusing to create a lock inside a directory whose ancestry nothing has proved."
  fi

  # 1 — THE ROOT-OWNED PARENT. Not created here. ensure_cutover_root_dir() owns that question for
  # the whole repository: it refuses a symlink at ${CUTOVER_ROOT_DIR} before and after its
  # `mkdir -p`, applies the owner and the 0711 mode to the descriptor it stepped into, and reads
  # both back off that same descriptor. It is idempotent and every non-dry cutover calls it again
  # through acquire_cutover_lock(); this call is here because scripts/install.sh prepares the
  # crontab lock in section 8, BEFORE it takes the cutover lock.
  ensure_cutover_root_dir || die \
    "${CUTOVER_ROOT_DIR} could not be established as a directory owned by this run and writable by nobody else, so the crontab reconciliation lock cannot be put beneath it. That parent is the whole of the exclusion: without it the service account can rename the lock directory aside, and the application and this run would then lock different inodes while both reported exclusion. Nothing has been written."

  # 2 — THE LOCK DIRECTORY, one component beneath it, through the walk this repository already has.
  # enter_service_subdir() DIES on anything it cannot prove and leaves this process INSIDE the
  # directory, so every step below names a single component and no ancestor is resolved again.
  saved="$(pwd -P)" || die \
    "this run cannot establish its own working directory, so it will not walk into ${CRONTAB_LOCK_DIR} and back. Nothing has been written."
  enter_service_subdir "${CUTOVER_ROOT_DIR}" 022 "${CRONTAB_LOCK_DIR}"
  # Take/keep root ownership OF THE DIRECTORY THIS PROCESS IS STANDING IN. `.` is answered by the
  # kernel from the descriptor the walk left this shell holding, so no component is resolved a
  # second time; `-h` costs nothing, and `.` can never be a symlink.
  chown -h root:root .

  # 3 — THE DIRECTORY'S POST-CONDITIONS, re-read with an lstat OF `.` rather than assumed from 2.
  #
  # THE `|| true` ON EVERY `stat` HERE IS DELIBERATE, AND IT IS SAFE FOR A STATED REASON
  # (o3d-p9dq, Codex r31 sweep). Each capture is compared against a POSITIVE LITERAL — "directory",
  # "regular file", the uid this process is running as — so a `stat` that could not run yields the
  # empty string, matches none of them, and DIES. The failure direction is the refusing one, which
  # is why these are not rewritten to take a status: there is nothing a status could add that the
  # comparison does not already do. What matters is that this is written down; every OTHER capture
  # in this file whose failure is not already a refusal takes its status explicitly, and the
  # repository walk in tests/settings/crontab-reconcile-serialization.test.ts holds that line.
  dir_meta="$(LC_ALL=C stat -c '%F|%u|%a' . 2>/dev/null || true)"
  IFS='|' read -r dir_kind dir_owner dir_mode <<< "${dir_meta}"
  [[ "${dir_kind}" == "directory" && "${dir_owner}" == "${self}" ]] || die \
    "${CRONTAB_LOCK_DIR} must be a directory owned by uid ${self} after preparation, and is '${dir_meta}'."
  # Validated BEFORE `8#` sees it: `8#` on anything that is not octal is a fatal arithmetic error
  # under `set -e`, which is a crash and not a refusal.
  [[ "${dir_mode}" =~ ^[0-7]+$ ]] || die \
    "${CRONTAB_LOCK_DIR} reports the permission bits '${dir_mode}', which this run cannot read as octal, so it cannot establish whether another account may replace the lock inside it. Nothing has been written."
  # The whole protection is that the service user cannot write this DIRECTORY. A group- or
  # other-writable mode would give the lock file back to them, so it is refused, not chmod'ed away.
  (( (8#${dir_mode} & 0022) == 0 )) || die \
    "${CRONTAB_LOCK_DIR} is mode ${dir_mode}: group- or other-writable, so '${APP_USER}' could still replace the lock file inside it. Set it to 0755 and run the installer again."
  # AND TRAVERSABLE BY OTHER ACCOUNTS, WHICH IS THE OTHER HALF AND IS NEW (o3d-txoe). The
  # application runs as ${APP_USER} and has to reach ${CRONTAB_LOCK_FILENAME} inside here to join
  # the exclusion at all. A directory at 0700 satisfies every rule above it and leaves the
  # application unable to open the lock — which lib/crontab-reconcile-lock.ts turns into a refused
  # reconciliation rather than an unserialised one, so it is not a silent split; it is still a
  # scheduler that has stopped working, and it is this run's to refuse rather than to ship.
  (( (8#${dir_mode} & 0001) != 0 )) || die \
    "${CRONTAB_LOCK_DIR} is mode ${dir_mode}: not traversable by other accounts, so '${APP_USER}' cannot open the crontab reconciliation lock inside it and the application cannot join this exclusion. Every reconciliation from the running service would refuse. Set it to 0755 and run the installer again."

  # 4 — THE FILE, as a SINGLE COMPONENT from the directory this process is standing in. Created, if
  # missing, with O_CREAT|O_EXCL so a planted symlink is refused rather than written through; never
  # `touch`ed, and never given away to the service user.
  #
  # The `-e` test is a CONVENIENCE, not the safety: it dereferences, so a symlink to an existing
  # file reads as "already there", and a DANGLING one reads as "missing" and falls into the
  # redirection below. `set -C` is what makes both of those safe — O_CREAT|O_EXCL fails with
  # EEXIST on a symlink and creates nothing, dangling or not — and the lstat that follows is what
  # refuses.
  if [[ ! -e "${CRONTAB_LOCK_FILENAME}" ]]; then
    ( umask 022; set -C; : > "${CRONTAB_LOCK_FILENAME}" ) 2>/dev/null || true
  fi
  # `stat -c %F` says "regular empty file" for a zero-length one, and this file is ALWAYS empty —
  # nothing ever writes to it. Both spellings are the same st_mode, and neither is a symlink. The
  # IDENTITY is taken in the SAME stat as the type and the owner, so the three cannot describe
  # different files, and it is what the descriptor is checked against below.
  file_meta="$(LC_ALL=C stat -c '%F|%u|%d:%i' "${CRONTAB_LOCK_FILENAME}" 2>/dev/null || true)"
  IFS='|' read -r file_kind file_owner file_ident <<< "${file_meta}"
  [[ "${file_kind}" == "regular file" || "${file_kind}" == "regular empty file" ]] || die \
    "${CRONTAB_LOCK_FILE} is not a regular file (it is a ${file_kind:-missing path}). The crontab reconciliation lock must be a plain file that only root can replace; refusing to write to that path."
  chown -h root:root "${CRONTAB_LOCK_FILENAME}"
  # Re-read AFTER the chown, off the same single component, because the ownership is a
  # post-condition and not a hope. No mode assertion on the FILE, deliberately: nothing ever reads
  # or writes its contents, and it cannot be replaced from inside a directory the service user
  # cannot write. Only "root owns it and it is a plain file" is load-bearing.
  file_meta="$(LC_ALL=C stat -c '%F|%u|%d:%i' "${CRONTAB_LOCK_FILENAME}" 2>/dev/null || true)"
  IFS='|' read -r file_kind file_owner file_ident <<< "${file_meta}"
  [[ ( "${file_kind}" == "regular file" || "${file_kind}" == "regular empty file" ) \
     && "${file_owner}" == "${self}" && -n "${file_ident}" ]] || die \
    "${CRONTAB_LOCK_FILE} must be a regular file owned by uid ${self} after preparation, and is '${file_meta}'."

  # 5 — AND THE DESCRIPTOR, OPENED HERE AND HELD FOR THE RUN (o3d-q766). A single component, from
  # the pinned directory; READ-ONLY, so there is no O_CREAT and no O_TRUNC in it to aim. A FAILED
  # `exec` REDIRECTION ENDS A NON-INTERACTIVE SHELL, so there is no state in which this function
  # returns with ${CRONTAB_LOCK_FD} empty and the caller believing a lock was prepared.
  exec {CRONTAB_LOCK_FD}<"${CRONTAB_LOCK_FILENAME}"
  # THE DESCRIPTOR IS THE ONE THE POST-CONDITIONS PASSED ON. verify_held_lock() fstats it through
  # /proc/self/fd/N — `-L` there is what makes it an fstat of the OPEN FILE rather than a walk of
  # anything — requires a regular file owned by this run, and requires the NAME's own lstat to be
  # the same inode. It is asked about the single component, from inside the pinned directory, so not
  # one ancestor is resolved again.
  verify_held_lock "${CRONTAB_LOCK_FD}" "${CRONTAB_LOCK_FILENAME}" || die \
    "the descriptor this run opened on ${CRONTAB_LOCK_FILE} is not that name's own inode, or is not a regular file owned by uid ${self}. Either the open followed a link or the name was replaced between the check and the open. Refusing to take the crontab exclusion on a file this run cannot identify. Nothing has been written."
  # AND IT IS THE INODE STEP 4 PROVED, asked of the descriptor rather than of the name a third time.
  held_ident="$(LC_ALL=C stat -L -c '%d:%i' "/proc/self/fd/${CRONTAB_LOCK_FD}" 2>/dev/null || true)"
  [[ "${held_ident}" == "${file_ident}" ]] || die \
    "the descriptor this run holds on ${CRONTAB_LOCK_FILE} answers as ${held_ident:-nothing}, which is not the inode its post-conditions were checked against (${file_ident}). Refusing to take the crontab exclusion on a file this run cannot identify. Nothing has been written."

  cd "${saved}" || die \
    "this run could not return to ${saved} after preparing ${CRONTAB_LOCK_DIR}. Nothing further has been changed."

  prepare_legacy_crontab_lock
}

# ---------------------------------------------------------------------------
# THE ONE ROLLOUT WINDOW THE RELOCATION OPENS, AND THE BRIDGE ACROSS IT (o3d-txoe)
#
#   prepare_legacy_crontab_lock       sets ${CRONTAB_LEGACY_LOCK_FD}, or says why it did not
#
# THE CONSEQUENCE, STATED BEFORE IT IS MITIGATED. Moving a lock is also a way to LOSE one. On the
# first run after this build reaches an EXISTING host, the process serving that host was built
# before the relocation and goes on resolving ${CRONTAB_LEGACY_LOCK_FILE} — the old location, inside
# the service's own StateDirectory. A successor entrypoint that locked only the new location would be
# excluded from nothing during that window, which is the same silent loss of exclusion this whole
# round exists to remove. It is the shape state_pre_r22_cutovers_are_not_excluded() answers by saying
# so; this function answers it by taking BOTH locks wherever that means something.
#
# WHICH IS NOT EVERYWHERE, AND THE PRECONDITION IS THE POINT — the same one
# acquire_legacy_namespace_lock() checks, for the same reason. A lock taken on a name inside a
# directory another account may write proves nothing: `unlink(2)` and `rename(2)` ask for write
# permission on the PARENT, so the entry a predecessor locked can be moved out from under it and
# this run handed a fresh inode at the same name. ${CRONTAB_LEGACY_LOCK_DIR} is root-owned — that was
# r24's placement, and scripts/install.sh's ownership walk still PRUNES it so it stays that way — but
# it sits inside ${DATA_DIR}, which ${APP_USER} owns, so THAT account can still rename it aside.
# Against a predecessor that is merely a predecessor the bridge is real. Against an account that is
# ATTACKING it is not, and the new location is what defends against that account: the bridge is a
# continuity measure, never a security boundary, and it is not written down as one.
#
# SO IT IS CONDITIONAL, IN BOTH DIRECTIONS:
#
#   • NO OLD LOCK FILE AT ALL — a fresh install, or a host whose predecessor predates the shared
#     path entirely. There is nothing to bridge to and NOTHING IS CREATED: creating the old location
#     on a fresh host would put a root-owned directory back inside ${DATA_DIR} for no reader, and
#     would make "the old lock exists" stop meaning "a predecessor may still be using it".
#   • THE OLD DIRECTORY IS NOT ONE ONLY THIS RUN MAY WRITE — it was handed to ${APP_USER} by an
#     older release, or replaced. Nothing is opened, nothing is locked, nothing is created, and the
#     warning says exactly what is not excluded rather than leaving a reader to infer it.
#
# AND IT ENDS. The bridge is reached only while ${CRONTAB_LEGACY_LOCK_FILE} exists; removing it is an
# operator action, documented in docs/installation.md under the first run after this deploy, and
# until they take it the only cost is one extra `flock` per crontab read-modify-write.
prepare_legacy_crontab_lock() {
  local saved meta kind ident held_ident
  CRONTAB_LEGACY_LOCK_FD=""
  [[ -n "${CRONTAB_LEGACY_LOCK_DIR:-}" && -n "${CRONTAB_LEGACY_LOCK_FILE:-}" ]] || return 0
  # A fresh host, or one whose predecessor predates the shared path. Nothing is created; see above.
  [[ -e "${CRONTAB_LEGACY_LOCK_FILE}" || -L "${CRONTAB_LEGACY_LOCK_FILE}" ]] || return 0
  if ! dir_is_private_to_this_run "${CRONTAB_LEGACY_LOCK_DIR}"; then
    warn "${CRONTAB_LEGACY_LOCK_DIR} is not a directory only this run may write, so a lock taken on ${CRONTAB_LEGACY_LOCK_FILE} would prove nothing: the entry can be renamed between a predecessor's open and this one, and both runs would then report an exclusion neither holds. NOTHING WAS OPENED, LOCKED OR CREATED THERE. An application process running a build from BEFORE the crontab lock moved to ${CRONTAB_LOCK_DIR} is NOT excluded by this run; two writers of THIS build still cannot overlap. Restart the service onto this build before anything changes the crontab — see docs/installation.md, 'The first run after the crontab lock moved'."
    return 0
  fi
  saved="$(pwd -P)" || die \
    "this run cannot establish its own working directory, so it will not walk into ${CRONTAB_LEGACY_LOCK_DIR} and back. Nothing has been written."
  cd -P "${CRONTAB_LEGACY_LOCK_DIR}" 2>/dev/null || die \
    "${CRONTAB_LEGACY_LOCK_DIR} could not be entered, although this run had just established that only it may write there. Nothing has been written."
  # The same pinning as the canonical lock: ONE lstat taking the type and the identity together, a
  # single-component read-only open, and the descriptor proved against that identity.
  meta="$(LC_ALL=C stat -c '%F|%d:%i' "${CRONTAB_LOCK_FILENAME}" 2>/dev/null || true)"
  kind="${meta%%|*}"
  ident="${meta##*|}"
  if [[ "${kind}" != "regular file" && "${kind}" != "regular empty file" ]]; then
    cd "${saved}" || die "this run could not return to ${saved}. Nothing further has been changed."
    warn "${CRONTAB_LEGACY_LOCK_FILE} is a ${kind:-missing path} rather than a regular file, so this run will not open it to bridge to a predecessor build. NOTHING WAS OPENED OR LOCKED THERE. An application process running a build from BEFORE the crontab lock moved to ${CRONTAB_LOCK_DIR} is NOT excluded by this run."
    return 0
  fi
  exec {CRONTAB_LEGACY_LOCK_FD}<"${CRONTAB_LOCK_FILENAME}"
  held_ident="$(LC_ALL=C stat -L -c '%d:%i' "/proc/self/fd/${CRONTAB_LEGACY_LOCK_FD}" 2>/dev/null || true)"
  if ! verify_held_lock "${CRONTAB_LEGACY_LOCK_FD}" "${CRONTAB_LOCK_FILENAME}" \
     || [[ "${held_ident}" != "${ident}" ]]; then
    # THE CLOSE IS GROUPED, AND THAT IS NOT COSMETIC (o3d-secops r31, o3d-noka r2). A BARE `exec`
    # CARRYING A REDIRECTION APPLIES THAT REDIRECTION TO THE SHELL, PERMANENTLY — so
    # `exec {FD}<&- 2>/dev/null` would send every later warning, refusal and `die` of the whole
    # entrypoint to /dev/null, including the `die` on the very next line. Inside `{ ...; }` the
    # suppression belongs to the group and is given back at the closing brace.
    { exec {CRONTAB_LEGACY_LOCK_FD}<&-; } 2>/dev/null || true
    CRONTAB_LEGACY_LOCK_FD=""
    cd "${saved}" >/dev/null 2>&1 || true
    die "the descriptor this run opened on ${CRONTAB_LEGACY_LOCK_FILE} answers as ${held_ident:-nothing} rather than as that name's own inode (${ident}), or is not a regular file owned by this run. That is a substitution inside a directory this run had just established only it may write, so it is REFUSED rather than bridged: this run will not go on to rewrite the crontab behind an exclusion it cannot identify. Nothing has been written."
  fi
  cd "${saved}" || die \
    "this run could not return to ${saved} after pinning ${CRONTAB_LEGACY_LOCK_FILE}. Nothing further has been changed."
  return 0
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
# REENTRANT BY REFUSAL, NOT BY RECURSION — AND SINCE o3d-q766 THAT GUARD IS LOAD-BEARING RATHER
# THAN AN OPTIMISATION. It used to be an optimisation with a safety argument attached: each
# acquisition opened its OWN descriptor, so a nested call would have blocked against the outer one
# until the timeout and then reported a conflict that was this very process. There is now ONE
# descriptor, pinned by prepare_crontab_lock() and held for the run, and flock(2) on a description
# that ALREADY holds the lock returns immediately — so a nested acquisition would SUCCEED, and its
# `flock --unlock` would release the OUTER call's lock while the outer body was still inside its
# read-modify-write. ${CRONTAB_LOCK_HELD} is what stops that. A nested call runs the body directly,
# on the lock the outer call is already holding, and releases nothing.
#
# THE RELEASE IS `flock --unlock`, NOT A CLOSE. The descriptor outlives the critical section; the
# LOCK does not. flock(2) attaches the lock to the OPEN FILE DESCRIPTION, so LOCK_UN releases it for
# every duplicate of that description — including one a `crontab -` child inherited — and the
# exclusion is therefore still exactly one read-modify-write long. It is released on EVERY path out
# of the acquisition, including the one where the body failed, as its own statement rather than on
# the right of a `&&`: `errexit` is suspended for the whole dynamic extent of the left operand of
# `&&`/`||`, so a release written there would be a release nothing could observe failing.
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
  # NO PATHNAME IS RESOLVED HERE, AND THAT IS THE WHOLE OF o3d-q766 AND o3d-txoe. This used to run a
  # dereferencing `[[ -f "${CRONTAB_LOCK_FILE}" ]]` and then a SECOND, independent dereferencing
  # `7<"${CRONTAB_LOCK_FILE}"` — two lookups per acquisition, neither re-deriving owner or inode, and
  # a rename landing between them put root's read-only redirection on whatever the service account
  # chose. What is checked instead is that a PREPARATION HAPPENED: ${CRONTAB_LOCK_FD} is empty until
  # prepare_crontab_lock() has proved the directory, proved the file and opened the descriptor, and
  # the exclusion is taken on that descriptor and on nothing else.
  [[ -n "${CRONTAB_LOCK_FD:-}" ]] || die \
    "with_crontab_lock was called before prepare_crontab_lock pinned the crontab reconciliation lock. This is an ordering bug in the entrypoint, not an operator error: a crontab write that cannot be serialized against the application's can silently discard it. Nothing has been written."
  # AND THE PATHNAME STILL NAMES THE INODE THIS RUN IS HOLDING, OR THIS RUN REFUSES (o3d-txoe).
  #
  # THIS IS NOT THE BY-NAME OPEN COMING BACK. Nothing here opens, creates or writes anything: the
  # exclusion is taken on ${CRONTAB_LOCK_FD} either way, and the only thing the lookup can do is turn
  # a run into a refusal. That is the safe direction, and it is why re-resolving the ancestry is
  # acceptable HERE and is not acceptable for the open — a subverted lookup costs a refused cutover,
  # where a subverted open cost root a blocking read on a named pipe.
  #
  # WHY IT IS HERE AT ALL, GIVEN THE RELOCATION. The relocation is what makes the pathname's meaning
  # fixed: no account but root can rename a component of ${CRONTAB_LOCK_DIR} or replace the entry
  # inside it, so this check cannot fire because of ${APP_USER}. What it answers is the objection the
  # first attempt at the pin earned — that a descriptor held for a whole run makes a divergence
  # PERSIST where a by-name acquisition would have converged on the next one. Root can still rename
  # the directory aside; if it does, this run stops rather than going on holding a lock the
  # application will never contend for. It is the SAME question lib/crontab-reconcile-lock.ts asks on
  # its side (`fdStillMatchesPath`), asked at the same moment, so the two parties fail the same way.
  #
  # WHAT IT DOES NOT CLAIM: a swap performed WHILE this run is inside its critical section is not
  # caught, by this or by anything else, because the exclusion has already been granted on both
  # sides. The only thing that closes that case is a parent nobody else can rename within, which is
  # where the lock now lives. Stated rather than implied, because the difference is the whole of
  # o3d-txoe.
  verify_held_lock "${CRONTAB_LOCK_FD}" "${CRONTAB_LOCK_FILE}" || die \
    "${CRONTAB_LOCK_FILE} no longer names the inode this run pinned when it prepared the crontab reconciliation lock, or that inode is no longer a regular file this run owns. The exclusion this run holds is therefore on a file no other writer will open, and the application's own reconciliation would take a different one — both would report exclusion and neither would have it. Every component of that path is root-owned and writable by nobody else, so this is a privileged change made during this run and not something '${APP_USER}' can cause. Refusing to rewrite the crontab. Nothing has been written."
  if [[ -n "${CRONTAB_LEGACY_LOCK_FD:-}" ]]; then
    verify_held_lock "${CRONTAB_LEGACY_LOCK_FD}" "${CRONTAB_LEGACY_LOCK_FILE}" || die \
      "${CRONTAB_LEGACY_LOCK_FILE} no longer names the inode this run pinned for the pre-relocation bridge. Unlike the canonical lock that path IS inside a directory '${APP_USER}' owns, so this is reachable by that account — and it means a predecessor build's reconciliation would take a different inode from this run's. Refusing to rewrite the crontab rather than bridging to nothing. Nothing has been written."
  fi
  # THE PRE-RELOCATION LOCK FIRST, WHERE THERE IS ONE, AND IT IS THE OUTER OF THE TWO.
  # prepare_legacy_crontab_lock() explains what it bridges and what it does not. The order is fixed
  # — legacy outside, canonical inside — and it cannot deadlock against anything: a predecessor build
  # takes only the legacy lock, an application on THIS build takes only the canonical one, and every
  # writer of this build takes the two in this order.
  if [[ -n "${CRONTAB_LEGACY_LOCK_FD:-}" ]]; then
    if ! flock --exclusive --timeout "${CRONTAB_LOCK_WAIT_SECONDS}" "${CRONTAB_LEGACY_LOCK_FD}"; then
      return "${CRONTAB_LOCK_CONFLICT}"
    fi
  fi
  if flock --exclusive --timeout "${CRONTAB_LOCK_WAIT_SECONDS}" "${CRONTAB_LOCK_FD}"; then
    CRONTAB_LOCK_HELD=true
    "$@" || rc=$?
    CRONTAB_LOCK_HELD=false
    # Its own statement, and its status is read: a release that silently failed would leave the
    # exclusion held for the rest of the run, and every later acquisition would then be this very
    # process reporting a conflict against itself.
    flock --unlock "${CRONTAB_LOCK_FD}" || die \
      "the crontab reconciliation lock on ${CRONTAB_LOCK_FILE} could not be released after this read-modify-write, so every later crontab write in this run — and every reconciliation the application attempts — would queue behind a lock this process is still holding. The crontab itself is in whatever state the body left it."
  else
    rc=${CRONTAB_LOCK_CONFLICT}
  fi
  if [[ -n "${CRONTAB_LEGACY_LOCK_FD:-}" ]]; then
    flock --unlock "${CRONTAB_LEGACY_LOCK_FD}" || die \
      "the pre-relocation crontab lock on ${CRONTAB_LEGACY_LOCK_FILE} could not be released after this read-modify-write, so a predecessor build's reconciliation would queue behind a lock this process is still holding. The crontab itself is in whatever state the body left it."
  fi
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
  local user="$1" err="$2" stripped normalised
  # TWO CAPTURES, EACH WITH ITS STATUS TAKEN, rather than one three-stage pipeline whose middle
  # command could fail unseen (o3d-p9dq, Codex r31 sweep). This one was already fail-closed BY
  # ACCIDENT — the comparison below is against a non-empty literal, so a failed `tr` or `sed` gave
  # an empty string, failed to match, and left the read unresolved, which is the safe direction.
  # "Safe because the answer happens to come out no" is the shape this file keeps having to remove,
  # and it stops being safe the moment somebody inverts the comparison. So it is stated.
  #
  # `printf` is a builtin and each capture ends in the external command, so no pipefail is needed
  # for either status to be the one that matters. The normalisation itself is unchanged: a second
  # line, or any trailing text, still leaves the read unresolved rather than being skimmed.
  stripped="$(printf '%s' "${err}" | tr -d '\r')" || return 1
  normalised="$(printf '%s' "${stripped}" \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^crontab:[[:space:]]*//')" || return 1
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
  # EXACTLY the same shape as a missing `ss`, and round 28 said the opposite (o3d-p9dq, Codex r29
  # HIGH #2). The claim was that "a host with no `crontab` binary has no per-user crontabs for
  # anything to have written". That is false, and the mistake is worth naming rather than deleting:
  # `crontab(1)` is an EDITOR. It is setgid so an unprivileged user can install a file into the
  # spool; it is not what runs anything. The DAEMON reads the spool directly, and on every
  # implementation these scripts meet it also holds the loaded schedule in memory. So removing,
  # renaming or un-executable-ing /usr/bin/crontab unschedules NOTHING — the spool file survives it,
  # a running `cron` keeps firing what it already parsed, and a `cron` restarted afterwards re-reads
  # the spool without ever consulting the binary that is missing. Absence of the client is absence
  # of evidence, precisely like an `ss` that is not installed.
  #
  # So this stays an unresolved read, and the callers that used to skip on it now either die or
  # prove the absence — see require_crontab_command() below.
  if ! command -v crontab >/dev/null 2>&1; then
    CRONTAB_READ_REASON="\`crontab\` is not installed on this host, so it cannot be asked what ${user} has scheduled — and its absence does not mean ${user} has nothing scheduled, because the spool file and the running daemon both outlive the client binary"
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

# =============================================================================
# A CRONTAB WRITE IS AN ASSERTION, AND AN ASSERTION THAT WAS REJECTED IS NOT THE
# FACT "THE CRONTAB NOW SAYS THIS"          (o3d-p9dq, Codex r30 CRITICAL)
# =============================================================================
# Round 28 made every crontab READ fail closed. The WRITES were left as bare pipelines —
#
#     printf '%s\n' "${fenced}" | crontab -u "${APP_USER}" -
#     CRON_FENCED=true
#
# — on the belief that `set -e` would stop the function if the write were rejected. It does not,
# and the reason is the wrapper these bodies are called through. `with_crontab_lock` invokes its
# body as `"$@" || rc=$?`, because it needs the body's status to tell a lock conflict from a write
# failure. A command on the LEFT of `||` runs with errexit SUSPENDED, and bash suspends it for the
# ENTIRE DYNAMIC EXTENT of that command — every command inside the called function, and inside
# anything it calls, not merely the call itself. So the lock wrapper added in round 26 silently
# disarmed error propagation inside all fifteen `*_locked` bodies at once, and the two writes that
# had no explicit check went from "protected by errexit" to "unprotected", with nothing at either
# site to say so.
#
# What that cost: a rejected fence write left the crontab UNFENCED, then set `CRON_FENCED=true`,
# printed "Cron writers fenced." and returned 0 — and the run took the database fence and ran the
# migration against a live schedule. The unfence write is the mirror image: a rejected write left
# the crontab FENCED, then DELETED the backup that was the only copy of the operator's schedule and
# reported it restored.
#
# THE FIX IS THE ORDER, NOT ONLY THE CHECK. A check that runs after the flag is raised or after the
# backup is deleted still leaves the run believing a thing that did not happen. So: every write goes
# through THIS function, which returns non-zero and says why; and at every call site the status is
# taken BEFORE any flag is set, any backup is removed, and any success is printed.
#
# TAKES ITS CONTENT AS AN ARGUMENT, NOT ON STDIN, and that is load-bearing rather than a style
# choice: bash runs every element of a pipeline in a SUBSHELL, so `... | write_crontab_for user`
# would set ${CRONTAB_WRITE_REASON} in a child and the caller would read an empty string — the
# diagnostic would be lost at exactly the moment it is needed. Callers that produce their text with
# a pipeline capture it first, and check THAT too.
CRONTAB_WRITE_FAILED=77          # 75 = lock conflict, 76 = unfence diverged, 77 = the write itself
CRONTAB_WRITE_REASON=""

write_crontab_for() {
  local user="${1:-}" text="${2-}" err_file err rc=0
  CRONTAB_WRITE_REASON=""

  if [[ -z "${user}" ]]; then
    CRONTAB_WRITE_REASON="the crontab owner could not be resolved, so there is no user whose crontab this could be installed for"
    return 1
  fi
  # NOT THE SAME AS AN EMPTY CRONTAB. `write_crontab_for user ""` is a deliberate request to install
  # an empty schedule and is honoured; a caller that forgot the argument is a bug, and installing
  # "nothing" on its behalf would delete every line the crontab is the only record of.
  if [[ "$#" -lt 2 ]]; then
    CRONTAB_WRITE_REASON="write_crontab_for was called with no content for ${user}'s crontab. This is a programming error, not an operator one, and it is refused rather than installing an empty schedule nobody asked for"
    return 1
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    CRONTAB_WRITE_REASON="\`crontab\` is not installed on this host, so nothing can install a schedule for ${user} — and its absence does not mean there is no schedule to displace, because the spool file and the running daemon both outlive the client binary"
    return 1
  fi
  # THE DIAGNOSTIC IS CAPTURED, for the same reason read_crontab_for captures its own: a crontab
  # client rejects a schedule on stderr and the exit status alone does not say whether it was a
  # syntax error in the content, a permission problem, or a full filesystem.
  err_file="$(mktemp "${TMPDIR:-/tmp}/ims-crontab-write.XXXXXX" 2>/dev/null)" || {
    CRONTAB_WRITE_REASON="a temporary file for \`crontab -u ${user} -\`'s diagnostics could not be created, so a REJECTED write could not be told from an accepted one"
    return 1
  }
  printf '%s\n' "${text}" | crontab -u "${user}" - 2>"${err_file}" || rc=$?
  err="$(cat "${err_file}" 2>/dev/null)" || err=""
  rm -f "${err_file}"

  if [[ "${rc}" -ne 0 ]]; then
    CRONTAB_WRITE_REASON="\`crontab -u ${user} -\` exited ${rc} and did NOT install the schedule it was given — it said: ${err:-nothing at all}. A rejected write leaves the crontab exactly as it was, which is not what the caller asked for and is not what the caller's next line assumes"
    return 1
  fi
  return 0
}

# Set by whichever `*_locked` body could not complete a FENCE, so the caller's `die` can say what
# stopped it rather than blaming the lock it did in fact hold.
CRON_FENCE_REASON=""

# =============================================================================
# A MISSING `crontab` IS NOT A PROOF THAT NOTHING IS SCHEDULED
# (o3d-p9dq, Codex r29 HIGH #2)
# =============================================================================
# Every cutover fence in the three entrypoints opened with
#
#     command -v crontab >/dev/null 2>&1 || return 0     # "no cron writers to fence"
#
# which reads a missing TOOL as an absent SCHEDULE, and then walks on into the database fence and
# the migration. It is the same fail-open shape as the `ss` census, arrived at through a specific
# wrong belief: that the client binary is what makes a crontab exist. It is not. `crontab(1)` puts
# a file into the spool and takes it out again; `cron(8)` reads that spool, and keeps what it read
# in memory. A host can therefore have no `crontab` command and a fully live schedule — a package
# removed after install, a hardened image that ships only the daemon, a PATH that no longer reaches
# it, a binary whose execute bit was cleared.
#
#   require_crontab_command <user>
#
#   0  `crontab` is available. Nothing was proved and nothing needed to be.
#   1  `crontab` is NOT available, and the absence of a schedule could not be proved either.
#      CRONTAB_COMMAND_REASON says what could not be established; the caller must die.
#   2  `crontab` is NOT available, and the absence of a schedule WAS proved: there is no spool
#      entry for <user> in any spool root this function knows, and no scheduler daemon is running
#      that could be holding one it already read. The caller may continue without fencing.
#
# THE PRICE OF KEEPING A NO-BINARY PATH AT ALL, stated plainly: this proof is a positive search of
# a KNOWN list, so it is exactly as good as that list. It can be wrong in these ways —
#
#   * a cron implementation whose per-user spool is not one of ${CRON_SPOOL_ROOTS[@]};
#   * a daemon whose process name is not one of ${CRON_DAEMON_NAMES[@]};
#   * a daemon started between this check and the migration (nothing here can hold that shut —
#     it is the same residual the port drain carries);
#   * a systemd timer or another scheduler entirely, which is outside cron and outside every other
#     site in this protocol too, all of which are per-user-crontab shaped.
#
# It is NOT allowed to be wrong in the ways that matter most, and that is what the unresolved
# return is for. Not being root, a spool root that exists but cannot be listed, or a missing
# `ps`/`pgrep` all return 1 rather than 2: a search that could not run is not a search that found
# nothing. `anacron` is deliberately not in the daemon list — it runs /etc/anacrontab, never a
# per-user spool, so it cannot execute what this fence is about.
CRON_SPOOL_ROOTS=(/var/spool/cron/crontabs /var/spool/cron /var/spool/fcron)
CRON_DAEMON_NAMES=(cron crond fcron)
CRONTAB_COMMAND_REASON=""

require_crontab_command() {
  local user="${1:-}" root name listing prc
  CRONTAB_COMMAND_REASON=""

  if command -v crontab >/dev/null 2>&1; then
    return 0
  fi

  if [[ -z "${user}" ]]; then
    CRONTAB_COMMAND_REASON="\`crontab\` is not installed and no crontab owner was resolved, so there is not even a user whose spool could be searched"
    return 1
  fi

  # THE SPOOL IS ROOT-ONLY ON EVERY IMPLEMENTATION HERE (mode 1730, group crontab/cron). A
  # non-root run cannot list it, and an unlistable directory reads as empty to every test below.
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    CRONTAB_COMMAND_REASON="\`crontab\` is not installed, and this is not running as root, so the cron spool cannot be listed to establish whether ${user} has a schedule the missing client would have written"
    return 1
  fi

  if ! command -v pgrep >/dev/null 2>&1; then
    CRONTAB_COMMAND_REASON="\`crontab\` is not installed and \`pgrep\` is not available either, so this host cannot be asked whether a cron daemon is running with ${user}'s schedule already loaded"
    return 1
  fi

  # (1) IS ANYTHING RUNNING THAT COULD FIRE IT? Asked FIRST, because a daemon that has already
  # parsed the spool keeps firing after the spool file itself is gone — so a running daemon leaves
  # the question open no matter what the directory search finds.
  #
  # AND THE CENSUS ITSELF CAN FAIL (o3d-p9dq, Codex r30 HIGH). This loop used to read
  # `if pgrep -x "${name}"; then` — ONE BIT, "matched or did not" — which is the same fail-open
  # shape as the `ss` census of r27 and the pre-r28 `crontab -l`, arrived at INSIDE the very proof
  # that was written to end it. `pgrep`'s answer is not a bit. Only ONE of its non-zero statuses
  # means "no such process"; the rest mean the question was never asked. MEASURED on this host
  # (procps-ng 4.0.4) rather than taken from the manual, one probe per status:
  #
  #     0    a process matched                     (`pgrep -x sleep` with one running)
  #     1    NO process matched — and this is the ONLY status that is evidence of absence
  #          (also: an unknown namespace, an over-long pattern, an empty pattern)
  #     2    syntax error in the command line      (unknown flag; missing operand; two patterns;
  #                                                 an invalid regex such as `[`)
  #     3    fatal error: out of memory etc.       (documented in pgrep(1); not inducible here)
  #
  # …and the SHELL adds statuses `pgrep` never chose and the manual never lists: 126 if the binary
  # is found but not executable, 127 if it disappears between the `command -v` above and here, and
  # 128+n if it is killed — an OOM kill arrives as 137, which is precisely the condition status 3
  # is for. Every one of those used to fall through this loop as "no cron daemon is running", the
  # spool search below then found nothing, `require_crontab_command` returned 2, and all three
  # fence paths continued into the database fence and the migration with a daemon possibly still
  # firing ${user}'s loaded schedule.
  #
  # So the test is on the STATUS, and the classification is exhaustive: 0 is running, 1 is absent,
  # and ANYTHING ELSE is a census that did not happen. A search that could not run is not a search
  # that found nothing — the same rule this whole function is built on, now applied to its own
  # first step.
  for name in "${CRON_DAEMON_NAMES[@]}"; do
    prc=0
    pgrep -x "${name}" >/dev/null 2>&1 || prc=$?
    if [[ "${prc}" -eq 0 ]]; then
      CRONTAB_COMMAND_REASON="\`crontab\` is not installed, but a \`${name}\` daemon IS running — it holds whatever it last read from the spool in memory and keeps firing it, so nothing here can establish that ${user} has no cron writers"
      return 1
    fi
    if [[ "${prc}" -ne 1 ]]; then
      CRONTAB_COMMAND_REASON="\`crontab\` is not installed, and \`pgrep -x ${name}\` exited ${prc} — neither 0 (a ${name} daemon is running) nor 1 (none is), so it is a syntax error, a fatal error, or a binary that could not be run. No process census was obtained, and a census that did not run is not a census that found nothing: a ${name} daemon may be holding ${user}'s schedule in memory right now"
      return 1
    fi
  done

  # (2) IS THERE A SPOOL ENTRY? Every root that EXISTS must be listable, and none of them may hold
  # a file named for this user. A root that is absent contributes nothing and is not a failure.
  for root in "${CRON_SPOOL_ROOTS[@]}"; do
    [[ -e "${root}" ]] || continue
    if [[ ! -d "${root}" ]]; then
      CRONTAB_COMMAND_REASON="\`crontab\` is not installed and ${root} exists but is not a directory, so the cron spool cannot be read as one and ${user}'s schedule cannot be ruled out"
      return 1
    fi
    if ! listing="$(ls -A "${root}" 2>/dev/null)"; then
      CRONTAB_COMMAND_REASON="\`crontab\` is not installed and the cron spool ${root} could not be listed, so an entry for ${user} cannot be ruled out — an unreadable directory is not an empty one"
      return 1
    fi
    unset listing
    if [[ -e "${root}/${user}" ]]; then
      CRONTAB_COMMAND_REASON="\`crontab\` is not installed, but ${root}/${user} EXISTS — ${user} has a spooled schedule that a cron daemon will read whether or not the client binary is there. It cannot be read, fenced or put back without \`crontab\`"
      return 1
    fi
  done

  return 2
}

# The mark the fence puts in front of every active line, stated ONCE so that the projection, its
# inverse and every message quote the same string. Three copies of a sentinel is three sentinels.
CRON_FENCE_PREFIX='#DEPLOY-FENCE# '

# =============================================================================
# A COMPUTATION THAT COULD NOT BE RUN IS NOT AN ANSWER OF "NOTHING"
# (o3d-p9dq, Codex r31 CRITICAL)
# =============================================================================
# This file already refuses to read an absence as a proof twice. `read_crontab_for` will not let a
# failed `crontab -l` become an empty crontab, and `port_listener_census` will not let a failed
# `ss` become an absent listener. The PLANNER then did exactly that a third time, in the one place
# where the consequence cannot be undone:
#
#     merged="$(crontab_unfence_projection "${live}")"                          <- status discarded
#     missing="$(crontab_unmanaged_lines_missing_from "${backup}" "${merged}")" <- status discarded
#     if [[ -z "${missing}" ]]; then … CRON_UNFENCE_PLAN="merge" …
#
# Every caller reaches this function as `plan_crontab_unfence … || return`, and a command on the
# LEFT of `||` runs with errexit suspended for its whole dynamic extent — so neither assignment
# aborted anything. An `awk` that is missing, killed by the OOM reaper, or denied by seccomp makes
# BOTH substitutions empty; the empty `missing` is then read as "the merge loses nothing",
# `CRON_UNFENCE_TEXT` is set to the empty `merged`, and the caller installs an EMPTY CRONTAB and
# then deletes ${CRON_BACKUP} — the only copy of the schedule it has just erased. Reproduced
# against the shipped function with a failing `awk`: rc=0, plan=merge, empty text.
#
# WHY AN EXIT STATUS IS NOT ENOUGH HERE, and this is the whole difficulty: "produced no output" is
# a LEGITIMATE ANSWER at both sites. A crontab may genuinely be empty, and a subsequence check may
# genuinely find nothing missing. Failure therefore cannot be represented as emptiness, because
# emptiness is already taken. Each computation below establishes its success POSITIVELY instead:
#
#   the projections   are line-for-line transforms — the fence prefixes each active line, the
#                     unfence removes that prefix, and neither adds or drops one — so the answer is
#                     accepted only when the output holds exactly as many lines as the input did.
#                     An awk that exits 0 having printed nothing fails that; the projection of a
#                     genuinely empty crontab (nought lines in, nought lines out) passes it.
#   the subsequence   check prints a COMPLETION SENTINEL as the last thing its END block does, so
#                     "nothing is missing" arrives as the sentinel alone and a check that died
#                     part-way through arrives without it. Same shape as the `ss -ltn` header row
#                     one section below, built deliberately rather than relied upon.
#
# A status of its own, so a caller can tell "the computation could not be made" from "the world
# moved" (76) and from "the write was rejected" (77). An operator sent to compare two crontabs by
# hand, when what actually happened is that `awk` is missing, is sent to the wrong place.
CRONTAB_COMPUTE_FAILED=78
CRON_COMPUTE_TEXT=""
CRON_COMPUTE_REASON=""

# HOW MANY LINES IS THIS TEXT? In the shell's own arithmetic, with no subprocess — a checker that
# calls out to `wc` can be taken down by the very failure it exists to detect. Command substitution
# has already stripped the trailing newline from both the input and the output, so both are counted
# by the same rule: the empty string is nought lines, and anything else has one more line than it
# has newlines.
CRON_LINE_COUNT=0
crontab_count_lines() {
  local text="$1" newlines
  CRON_LINE_COUNT=0
  if [[ -z "${text}" ]]; then return 0; fi
  newlines="${text//[!$'\n']/}"
  CRON_LINE_COUNT=$(( ${#newlines} + 1 ))
  return 0
}

# RUN A LINE-FOR-LINE PROJECTION, AND ESTABLISH THAT IT RAN.
#
#   run_crontab_projection <what-it-is> <projection-fn> <input-text>
#
#   0  the projection RAN. CRON_COMPUTE_TEXT holds it — legitimately empty when the input was.
#   1  the projection did NOT run. CRON_COMPUTE_REASON says why, and CRON_COMPUTE_TEXT is not an
#      answer: the caller must refuse, install nothing, and delete no backup.
run_crontab_projection() {
  local what="$1" fn="$2" input="$3" out rc=0 want got
  CRON_COMPUTE_TEXT=""
  CRON_COMPUTE_REASON=""

  out="$("${fn}" "${input}")" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    CRON_COMPUTE_REASON="${what} exited ${rc}, so it did not run to completion. Its empty output is a FAILED COMPUTATION and not an empty crontab, and nothing may be installed — and no backup deleted — on the strength of it"
    return 1
  fi

  # THE POSITIVE PROOF, and the thing an exit status cannot give. An `awk` replaced by a shim, cut
  # off by a truncated pipe, or denied its input by seccomp can exit 0 having emitted nothing at
  # all; a line count that no longer matches says so whatever it exited with.
  crontab_count_lines "${input}"; want="${CRON_LINE_COUNT}"
  crontab_count_lines "${out}";   got="${CRON_LINE_COUNT}"
  if [[ "${got}" -ne "${want}" ]]; then
    CRON_COMPUTE_REASON="${what} exited 0 but returned ${got} line(s) for an input of ${want}. A line-for-line projection that changes the line count did not run to completion, whatever it exited with, and its output is not a crontab this run is willing to install"
    return 1
  fi

  CRON_COMPUTE_TEXT="${out}"
  return 0
}

# RUN THE UNMANAGED-LINE COMPARISON, AND ESTABLISH THAT IT RAN.
#
#   0  the comparison RAN. CRON_COMPUTE_TEXT holds the lines the merge would drop, and an empty
#      value here MEANS "it would drop none" — because the sentinel proved the check finished.
#   1  the comparison did NOT run. An empty answer from a check that never ran is not a clean
#      bill of health, and it is the difference between merging and erasing a crontab.
run_crontab_missing_comparison() {
  local backup="$1" candidate="$2" out rc=0
  CRON_COMPUTE_TEXT=""
  CRON_COMPUTE_REASON=""
  out="$(crontab_unmanaged_lines_missing_from "${backup}" "${candidate}")" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    CRON_COMPUTE_REASON="the comparison that asks which of the backup's unmanaged lines a merge would drop did not run to completion (exit ${rc}), so nothing has established that the merge loses nothing. An empty answer from a check that never ran is not a clean bill of health"
    return 1
  fi
  CRON_COMPUTE_TEXT="${out}"
  return 0
}

# THE FENCE, AS A PURE FUNCTION. `fence_cron_locked` in all three entrypoints runs its crontab
# through THIS, so the comparison in plan_crontab_unfence() below is asking about the transform
# that was actually applied rather than about a re-typed copy of it that can drift.
#
# Comment lines and blank lines pass through untouched: they are already inert, and prefixing
# them would make the inverse ambiguous.
crontab_fence_projection() {
  # A HERE-STRING, NOT A PIPE (o3d-p9dq, Codex r31 CRITICAL). A pipeline reports only its LAST
  # command's status unless whoever sourced this file happens to have pipefail set, so a `printf`
  # that failed — a full /tmp, a closed descriptor — could hand `awk` a truncated crontab and the
  # projection would still exit 0. `<<<` appends exactly the one trailing newline `printf '%s\n'`
  # did, so the output is byte-identical, and the status is one command's and unambiguous.
  awk '{ if ($0 ~ /^[[:space:]]*[^#[:space:]]/) print "#DEPLOY-FENCE# " $0; else print $0 }' <<< "$1"
}

# ITS EXACT INVERSE: remove the mark this protocol added, and nothing else. Anchored, and it
# strips ONE occurrence from the front of the line, so a line an operator wrote that happens to
# contain the sentinel further along is untouched.
crontab_unfence_projection() {
  # A here-string for the same reason its inverse uses one: one command, one status.
  awk '{ sub(/^#DEPLOY-FENCE# /, ""); print }' <<< "$1"
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
# THE MANAGED-BLOCK RULE, AS ONE AWK SOURCE THE WHOLE REPOSITORY SHARES (o3d-p9dq, Codex r29
# HIGH #3). What counts as "generated by us" is decided in exactly three places — this shell
# library, the installer's bootstrap awk, and computeOtiDrops() in lib/crontab-sync.ts — and until
# now the shell loss check had its OWN, cruder answer. Now the two awk copies are literally the
# same string, and the TypeScript one is held to it by tests/settings/crontab-managed-block-parity.
#
# WHAT AN UNCLOSED START MEANS, DECIDED AND WRITTEN DOWN. The old parser said "everything after a
# START is managed until an END", which for a marker with no END makes the rest of the file managed
# — so an operator's `17 3 * * * /usr/local/bin/operator-only` sitting below a half-written marker
# was excluded from the loss check, the merge that dropped it was declared lossless, and the backup
# holding the only copy was deleted. That failure mode aligns exactly with the state these recovery
# paths exist for: a half-written fence is how an unclosed marker gets there in the first place.
#
# It is not "everything after this is managed". An unclosed START means THE EXTENT OF THE BLOCK IS
# UNKNOWN, and unknown extent is not a licence to claim territory. So within the malformed region
# [START .. next START or EOF) only the marker itself, a stray END, and lines POSITIVELY identified
# as our own generated output are managed:
#
#   * a job line — it contains the exact curl signature this repository's builder emits, which
#     references our own shell variable names and cannot be typed by accident;
#   * the header comment, the `# Managed by One Two Inventory` line, or a `BASE_URL="` assignment.
#
# Everything else in that region stays an OPERATOR line: preserved by the application's stripper,
# and counted by the loss check below. The two directions now agree — a line the app would keep is
# a line whose disappearance this refuses to call lossless.
#
# It sees UNFENCED text on both sides by construction: plan_crontab_unfence compares the raw backup
# against `crontab_unfence_projection` of the live crontab, so no `#DEPLOY-FENCE# ` prefix reaches
# these patterns. That matters for the anchored ones (`^BASE_URL="`), which the fence's prefix would
# otherwise hide; the job signature is matched with index() and would survive it either way.
CRONTAB_MANAGED_BLOCK_AWK='
  function isStart(x) { return x ~ /^# --- OTI CRON START ---[ \t\r]*$/ }
  function isEnd(x)   { return x ~ /^# --- OTI CRON END ---[ \t\r]*$/ }
  function isBlank(x) { return x ~ /^[[:space:]]*$/ }
  function isRemnant(x,   managed) {
    # The exact generated job signature (== MANAGED_JOB_LINE_SIGNATURE in lib/crontab-sync.ts),
    # assembled from pieces so that the dollars never form a `$NAME` token. They are awk string
    # constants inside a single-quoted shell assignment and bash never expands them — but the
    # entrypoint scan in tests/scripts/deploy-order.test.ts reads this library line by line, and a
    # bare `$CRON_SECRET` here is indistinguishable to it from a variable the caller must supply.
    # awk concatenates adjacent constants, so the value is byte-identical to the TypeScript one.
    managed = "-H \"Authorization: Bearer " "$" "CRON_SECRET\" \"" "$" "BASE_URL/"
    return (index(x, managed) > 0 \
      || x ~ /^# CRON_SECRET is read from .* at runtime/ \
      || x ~ /^# Managed by One Two Inventory/ \
      || x ~ /^BASE_URL="/)
  }
  # Fill drop[1..n] for the lines in line[1..n]: 1 = generated by us, 0 = the operator every
  # caller must preserve. Complete blocks go whole; an unclosed START claims only itself and the
  # remnants it can positively identify.
  function markManagedDrops(line, n, drop,   i, j, k) {
    i = 1
    while (i <= n) {
      if (isStart(line[i])) {
        j = i + 1
        while (j <= n && !isEnd(line[j]) && !isStart(line[j])) j++
        if (j <= n && isEnd(line[j])) {
          for (k = i; k <= j; k++) drop[k] = 1
          i = j + 1
          continue
        }
        drop[i] = 1
        for (k = i + 1; k < j; k++) if (isEnd(line[k]) || isRemnant(line[k])) drop[k] = 1
        i = j
        continue
      }
      if (isEnd(line[i])) drop[i] = 1   # stray END outside a block
      i++
    }
  }
'

# THE COMPLETION SENTINEL (o3d-p9dq, Codex r31 CRITICAL). Printed as the LAST thing the END block
# below does, and stripped again by the shell, so the function's stdout is exactly what it always
# was. What it buys is the one distinction this check could not otherwise make: "nothing is
# missing" now arrives as the sentinel ALONE, and an awk that was never run, or was killed part-way
# through the comparison loop, arrives without it — where before both arrived as an empty string
# and the empty one was read as a clean bill of health for the merge.
#
# The leading SOH is deliberate. A crontab line that were somehow exactly this string would be
# reported as MISSING rather than swallowed as the sentinel, which errs towards refusing.
CRONTAB_SUBSEQUENCE_SENTINEL=$'\001CRONTAB-SUBSEQUENCE-COMPLETE\001'

# EACH INPUT ARRIVES ON DISK, IN FULL, BEFORE `awk` IS ASKED ANYTHING
# (o3d-p9dq, Codex r32 CRITICAL)
#
# This comparison needs TWO inputs at once — `NR == FNR` is how one awk tells them apart — and a
# here-string supplies only one, so the fix the two projections got could not be copied here.
# Round 31 handed both in through process substitutions instead:
#
#     ' <(printf '%s\n' "${candidate}") <(printf '%s\n' "${backup}")
#
# A PROCESS SUBSTITUTION'S PRODUCER REPORTS TO NOBODY. Its status is not awk's — awk sees a file
# that ended, not a writer that failed — and it is not this shell's either, because the shell never
# waits for it and `$?` never carries it. So a backup-side `printf` that was killed, or that died
# after part of its output, handed awk a TRUNCATED backup; awk compared what it was given, found
# nothing of it missing, printed the sentinel and exited 0.
#
# THE COMPLETION SENTINEL IS NOT THE ANSWER TO THIS, and that is worth saying plainly because the
# previous round believed it was. The sentinel proves the computation reached its END block, which
# in this failure it genuinely did — over an input that was never whole. It establishes that the
# computation FINISHED; it cannot establish that the computation SAW EVERYTHING. Both ends need
# covering, and the sentinel below still covers its own.
#
# What the uncovered end cost: the merge is approved as lossless, installed, and ${CRON_BACKUP} —
# the only copy of the lines it has just dropped — is then deleted. Reproduced against the shipped
# function by failing only the backup-side producer: rc=0, plan=merge, the operator's line gone.
#
# So both inputs are written to temporary files FIRST, each write's status taken and each file read
# back and counted, and only then is awk invoked. A write that failed aborts the comparison BEFORE
# it runs rather than being discovered after its answer has been acted on.

# WRITE ONE COMPARISON INPUT TO A FILE, AND ESTABLISH THAT ALL OF IT ARRIVED.
#
#   crontab_publish_comparison_input <text> <path>
#
#   0  <path> holds exactly the bytes `<(printf '%s\n' "<text>")` used to supply, so the awk below
#      reads what it has always read.
#   1  it does not, and no comparison may be attempted on it.
#
# TWO CHECKS, CATCHING DIFFERENT FAILURES:
#
#   the STATUS      a `printf` that could not write — a full filesystem, a closed descriptor, a
#                   read-only ${TMPDIR} — returns non-zero, and unlike a process substitution's
#                   producer that status is THIS shell's to take.
#   the BYTES       the file is read back and compared with `${text}` plus its newline IN FULL.
#                   Not counted: COUNTING WAS NOT ENOUGH, and that is round 33's finding. `mapfile
#                   -t` discards the delimiters and still counts an unterminated final record, so
#                   for intended bytes `a<NL>abcdef<NL>` a short write of `a<NL>abc` yields the
#                   same two elements the whole text does, and passed. The awk below would then
#                   find nothing of that truncated backup missing from a candidate containing
#                   `a<NL>abc`, approve the merge as lossless, and the caller would delete the only
#                   copy of `abcdef`. A count proves the number of records; only the bytes prove
#                   the bytes.
#
# AND THE COMPARISON IS BUILTIN-ONLY, which is the property the count check had and must not lose:
# `read` is a shell builtin, so it opens no pipe, forks nothing, and cannot be taken down by the
# very failure it exists to detect. A `cmp`, a `wc -c` or a `$(cat ...)` would each be one more
# producer, and a producer that died would read here as agreement.
#
# THE FINAL NEWLINE IS PART OF THE COMPARISON, because that is precisely where a truncation of the
# LAST line hides: `a<NL>abc` and `a<NL>abc<NL>` differ in nothing else, and only one of them is
# what `printf '%s\n'` was asked to write.
crontab_publish_comparison_input() {
  local text="$1" path="$2" want readback=""
  # `printf '%s\n' "${text}"` writes the text plus ONE newline, so the file always holds at least
  # one line: the empty string becomes a single BLANK line, which is exactly what the process
  # substitution produced and what the awk's isBlank() has always discarded. Byte-identical input
  # in, byte-identical answer out.
  want="${text}"$'\n'
  printf '%s\n' "${text}" > "${path}" || return 1
  # THE WHOLE FILE, IN ONE BUILTIN READ. `-d ''` makes the delimiter NUL; `IFS=` and `-r` stop the
  # shell trimming or unescaping anything, so what lands in ${readback} is the file's bytes as
  # they are. No subshell, no pipe, no second process.
  #
  # AND THE STATUS IS INVERTED ON PURPOSE. `read -d ''` returns 0 only when it FOUND its delimiter
  # -- a NUL byte -- and non-zero when it stopped at end of file. ${want} can hold no NUL (no bash
  # variable can), so the only acceptable outcome here is the non-zero one: the read consumed the
  # file to EOF. A 0 means the file holds a NUL these bytes never had, and there may be more after
  # it that this comparison never saw, so it is a refusal and not a pass.
  if IFS= read -r -d '' readback < "${path}"; then return 1; fi
  # EVERY BYTE, INCLUDING THE LAST NEWLINE. A short write that stopped mid-line -- the classic
  # error surfaced only at close(2), or a writer killed part-way -- differs from ${want} here even
  # when it kept the record count, which is the check this replaced.
  if [[ "${readback}" != "${want}" ]]; then return 1; fi
  return 0
}

crontab_unmanaged_lines_missing_from() {
  local backup="$1" candidate="$2" cand_file back_file out rc=0

  # SEPARATELY CREATED, and each creation checked: `mktemp` picks a name nothing else holds, so two
  # runs racing each other cannot read one another's inputs. The second failing cleans up the first
  # — there is no path out of this function that leaves either file behind.
  cand_file="$(mktemp "${TMPDIR:-/tmp}/ims-crontab-cand.XXXXXX" 2>/dev/null)" || return 1
  back_file="$(mktemp "${TMPDIR:-/tmp}/ims-crontab-back.XXXXXX" 2>/dev/null)" || {
    rm -f "${cand_file}"
    return 1
  }

  # BEFORE `awk` RUNS AT ALL. A failed write is a refusal here and not a discovery afterwards:
  # there is no answer from an incomplete input that this function is willing to hand back, and an
  # answer it does hand back gets a crontab installed and a backup deleted.
  if ! crontab_publish_comparison_input "${candidate}" "${cand_file}" \
     || ! crontab_publish_comparison_input "${backup}" "${back_file}"; then
    rm -f "${cand_file}" "${back_file}"
    return 1
  fi

  out="$(awk -v sentinel="${CRONTAB_SUBSEQUENCE_SENTINEL}" "${CRONTAB_MANAGED_BLOCK_AWK}"'
    NR == FNR { craw[++cn] = $0; next }
    { braw[++bn] = $0 }
    END {
      markManagedDrops(craw, cn, cdrop)
      markManagedDrops(braw, bn, bdrop)
      m = 0
      for (i = 1; i <= cn; i++) if (!cdrop[i] && !isBlank(craw[i])) cand[++m] = craw[i]
      n = 0
      for (i = 1; i <= bn; i++) if (!bdrop[i] && !isBlank(braw[i])) back[++n] = braw[i]
      cursor = 1
      for (i = 1; i <= n; i++) {
        j = cursor
        while (j <= m && cand[j] != back[i]) j++
        if (j <= m) { cursor = j + 1 } else { print back[i] }
      }
      print sentinel   # LAST: it proves the loop above ran to the end, not merely that awk started
    }
  ' "${cand_file}" "${back_file}")" || rc=$?
  # REMOVED ON EVERY PATH FROM HERE ON, including both refusals below, and before any of them can
  # return. A `trap` would be the other way to say this, but this file is SOURCED by three
  # entrypoints and an EXIT trap set here would displace theirs.
  rm -f "${cand_file}" "${back_file}"
  if [[ "${rc}" -ne 0 ]]; then return 1; fi
  # NO SENTINEL, NO ANSWER. An awk that exited 0 without reaching the end of its END block — a
  # shim, a truncated pipe, a seccomp denial — produces output that does not end here, and this
  # function refuses rather than reporting the empty set of missing lines it appears to have found.
  if [[ "${out}" != "${CRONTAB_SUBSEQUENCE_SENTINEL}" \
     && "${out}" != *$'\n'"${CRONTAB_SUBSEQUENCE_SENTINEL}" ]]; then return 1; fi
  out="${out%"${CRONTAB_SUBSEQUENCE_SENTINEL}"}"
  out="${out%$'\n'}"
  # Byte-for-byte the stdout this function has always produced: the missing lines each followed by
  # a newline, and nothing at all when there are none. The awk never emits a blank line, so
  # stripping and restoring the trailing newline here is lossless.
  if [[ -n "${out}" ]]; then printf '%s\n' "${out}"; fi
  return 0
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
#   0                          the comparison RAN, and the live crontab IS that projection
#   1                          the comparison RAN, and they differ — something wrote
#   ${CRONTAB_COMPUTE_FAILED}  the comparison could NOT be made; CRON_UNMOVED_REASON says why
#
# THE THIRD ANSWER IS NEW (o3d-p9dq, Codex r31 CRITICAL). This was one line — `[[ "${live}" ==
# "$(crontab_fence_projection "${backup}")" ]]` — and a command substitution inside `[[ ]]` throws
# its status away. A failed projection therefore compared the live crontab against the EMPTY
# STRING, which is not a comparison anybody asked for: against a non-empty crontab it silently
# became "something wrote" and fell through to the merge, and against a genuinely empty one it
# became "nothing wrote" and returned the snapshot — restoring entries an operator had deleted,
# which is the exact resurrection round 27 removed the lost-lines branch to prevent.
CRON_UNMOVED_REASON=""
crontab_is_unmoved_since_backup() {
  local backup="$1" live="$2"
  CRON_UNMOVED_REASON=""
  if ! run_crontab_projection "the fence projection of the backup" crontab_fence_projection "${backup}"; then
    CRON_UNMOVED_REASON="${CRON_COMPUTE_REASON}"
    return "${CRONTAB_COMPUTE_FAILED}"
  fi
  [[ "${live}" == "${CRON_COMPUTE_TEXT}" ]]
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
  local backup="$1" live="$2" merged missing unmoved=0
  CRON_UNFENCE_PLAN=""
  CRON_UNFENCE_TEXT=""
  CRON_UNFENCE_REASON=""

  # (0) EVERY COMPUTATION BELOW IS CHECKED, AND A FAILED ONE REFUSES BEFORE ANY PLAN IS SET
  # (o3d-p9dq, Codex r31 CRITICAL). See the section above `crontab_fence_projection` for the route
  # this used to take: three unchecked substitutions, an empty `missing` read as "the merge loses
  # nothing", and a caller that installed an empty crontab and deleted the only copy of what had
  # been there. The refusal is set BEFORE anything else so that no path out of this function can
  # leave a merge plan behind a computation that did not run.

  # (1) DID ANYTHING WRITE? Asked by comparing the live crontab with the fence's OWN projection of
  # the backup, byte for byte. Equal means the only write since the snapshot was the fence itself,
  # so the snapshot is provably current and goes back verbatim — the pre-existing behaviour, now
  # with a proof under it instead of an assumption.
  crontab_is_unmoved_since_backup "${backup}" "${live}" || unmoved=$?
  if [[ "${unmoved}" -eq "${CRONTAB_COMPUTE_FAILED}" ]]; then
    CRON_UNFENCE_PLAN="refuse"
    CRON_UNFENCE_REASON="${CRON_UNMOVED_REASON}"
    return "${CRONTAB_COMPUTE_FAILED}"
  fi
  if [[ "${unmoved}" -eq 0 ]]; then
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
  run_crontab_projection "the unfence projection of the live crontab" crontab_unfence_projection "${live}" || {
    CRON_UNFENCE_PLAN="refuse"
    CRON_UNFENCE_REASON="${CRON_COMPUTE_REASON}"
    return "${CRONTAB_COMPUTE_FAILED}"
  }
  merged="${CRON_COMPUTE_TEXT}"

  run_crontab_missing_comparison "${backup}" "${merged}" || {
    CRON_UNFENCE_PLAN="refuse"
    CRON_UNFENCE_REASON="${CRON_COMPUTE_REASON}"
    return "${CRONTAB_COMPUTE_FAILED}"
  }
  missing="${CRON_COMPUTE_TEXT}"

  # AND ONLY NOW MAY AN EMPTY ANSWER MEAN "NOTHING IS MISSING". Both computations have positively
  # established that they ran; before this round, reaching this line proved nothing at all.
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
  # THE COUNT IS A COMPUTATION TOO, AND IT WAS THE ONE THING HERE NOBODY CHECKED
  # (o3d-p9dq, Codex r31, the same shape as the CRITICAL). Everything above exists so that a failed
  # `ss` cannot be read as an absent listener — and then the count was taken with an unchecked
  # `printf | awk` whose empty result went straight into `[[ "${PORT_DRAIN_LISTENERS}" -eq 0 ]]`.
  # Bash evaluates the EMPTY STRING as 0 in an arithmetic comparison, so a broken `awk` reported
  # the port as drained over a census it never read, and the cron fence was then taken with the
  # predecessor still serving. Measured, not reasoned about: `[[ "" -eq 0 ]]` is TRUE here.
  #
  # A here-string rather than a pipe, so the status is awk's alone; then the status; then the
  # POSITIVE establishment that what came back is a number, because that is the only thing that
  # separates "nought listeners" from "no answer".
  local count rc_count=0
  count="$(awk -v p=":${port}\$" '$4 ~ p { n += 1 } END { print n + 0 }' <<< "${out}")" || rc_count=$?
  if [[ "${rc_count}" -ne 0 ]]; then
    PORT_DRAIN_REASON="the listener count could not be computed from a census that DID run (\`awk\` exited ${rc_count}), so nothing has established how many sockets are listening on :${port}"
    return 1
  fi
  if [[ ! "${count}" =~ ^[0-9]+$ ]]; then
    PORT_DRAIN_REASON="the listener count for :${port} came back as '${count}', which is not a number. An unparseable count must not be read as nought — the shell would do exactly that, because it evaluates an empty string as 0 in an arithmetic comparison"
    return 1
  fi
  PORT_DRAIN_LISTENERS="${count}"
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
