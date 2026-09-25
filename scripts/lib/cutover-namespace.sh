# shellcheck shell=bash
# =============================================================================
# THE CUTOVER NAMESPACE — one root-owned parent, one walk, one lock
# =============================================================================
# o3d-secops r22, Codex CRITICAL x2. Sourced by scripts/install.sh, scripts/deploy.sh and
# scripts/update.sh, and it is the ONLY thing in this repository that creates a directory
# beneath a root-owned parent, takes ownership of one, or opens the shared cutover lock.
#
# WHY IT IS A LIBRARY AND NOT A THIRD COPY. The same argument db-fence-protected.sh and
# crontab-lock.sh make, and this round is the third time it has been the finding: r20 moved the
# fence MARKER under a root-owned parent and left the LOCK and the DB fence DIRECTORY in
# ${CUTOVER_STATE_DIR}, which is the application's own data directory; the walk that would have
# created them safely already existed, in install.sh, and only in install.sh. A rule about where
# a privileged process may write cannot be stated in one of three entrypoints and be one rule.
#
# ---------------------------------------------------------------------------
# THE TWO FINDINGS, STATED EXACTLY
# ---------------------------------------------------------------------------
# BOTH ARE THE SAME SENTENCE ABOUT TWO PATHS: ${CUTOVER_STATE_DIR} IS OWNED BY ${APP_USER}, SO
# EVERY NAME DIRECTLY BENEATH IT IS THAT ACCOUNT'S TO CREATE, REPLACE AND UNLINK. `unlink(2)` and
# `rename(2)` ask for write permission ON THE PARENT and ask nothing whatever about the file, so
# nothing about a file's own owner or mode answers the question "is this the entry I created?"
#
#   THE LOCK (`${CUTOVER_STATE_DIR}/cutover.lock`). Every non-dry run opened it as
#
#       exec 9>"$LOCK_FILE"
#
#   which is `open(O_WRONLY|O_CREAT|O_TRUNC)` — AS ROOT, ON A NAME ${APP_USER} CHOOSES. Replace it
#   with a symlink to any file root may write and that file is TRUNCATED TO ZERO before `flock`
#   is reached: /etc/shadow, a unit file, the fence marker itself. The truncation is the whole of
#   the damage and it happens before anything this script could check.
#
#   And the check that followed proved the wrong thing. `flock -n 9` answers "did this run get
#   the lock", never "is this the file the lock is supposed to be on" — so a run holding a lock
#   on the attacker's chosen inode reported mutual exclusion it did not have.
#
#   THE DB FENCE DIRECTORY (`${CUTOVER_STATE_DIR}/deploy`). It was created with
#
#       mkdir -p "$DB_FENCE_DIR"
#       chown "${APP_USER}:${APP_USER}" "$DB_FENCE_DIR"
#       chmod 700 "$DB_FENCE_DIR"
#
#   and `mkdir -p` ACCEPTS A SYMLINK-TO-DIRECTORY at the final component: it sees a directory
#   there and returns 0. `chown` and `chmod` then both DEREFERENCE, as root, so `deploy` pointed
#   at /etc, at /root, or at any directory on the box hands that directory to ${APP_USER} at mode
#   0700. Three root-side operations aimed by one symlink the service account is entitled to
#   create.
#
# ---------------------------------------------------------------------------
# THE FIX: A ROOT-OWNED PARENT, AND A DESCRIPTOR FOR EVERY OPERATION
# ---------------------------------------------------------------------------
# ${CUTOVER_ROOT_DIR} — /etc/ims-cutover-state, a literal, for the reasons written out above
# ${DB_ENV_SNAPSHOT_DIR} in each entrypoint — is root-owned and NOT writable by anyone else, so
# no unprivileged account can create, replace or unlink ANY name inside it. That, and not the
# mode of the lock file, is what closes both findings: there is no symlink to plant.
#
# WHY NOT /etc/ims-cutover, WHICH r20 ALREADY CREATED AND ALREADY OWNS. Because it is 0700 and
# must stay 0700: it holds ${DB_ENV_SNAPSHOT_FILE}, which carries the database password, and
# ${FENCE_FILE}, which is the boot authority. ${DB_FENCE_STATE} has to be READABLE by ${APP_USER}
# — the connection fence script runs as that account (`as_app_user … --state-file=`) and executes
# the revocation and the restoration the record describes — and a directory nobody but root may
# TRAVERSE is not readable by anybody. Relaxing /etc/ims-cutover to 0711 so a child could be
# reached would relax the one directory on the box that exists to be private, to give a lock file
# a home. So the fence namespace gets its own root-owned parent, and /etc/ims-cutover is not
# touched by this round at all.
#
# READABLE, AND NOT WRITABLE (o3d-secops r23, Codex CRITICAL). r22 made ${DB_FENCE_DIR} app-OWNED,
# because the helper published its own record into it — and the record is what `--release` builds
# `GRANT CONNECT` out of, so the account being defended against chose what a privileged release
# would restore, at any time, from a file it could pre-create. THE AUTHORITY THEREFORE STOPPED
# BEING WRITTEN BY THE HELPER. It is now published by ROOT, through publish_durable_file(), out of
# a plan the unprivileged helper PRINTS and a privileged validator re-emits field by field; see
# db_fence_publish_authority() in lib/db-fence-protected.sh. What that leaves down here is a
# directory nobody but root may write and anybody may read, which is exactly what an ACL record
# an unprivileged executor must obey needs to be.
#
# WHAT LIVES WHERE, AFTER THIS ROUND:
#
#   /etc/ims-cutover              root:root 0700   the fence MARKER, the DB identity snapshot
#   /etc/ims-cutover-recovery     root:root 0755   the protected fence artefact and its wrappers
#   /etc/ims-cutover-state        root:root 0711   the shared cutover lock, and the directory
#     ├── cutover.lock            root:root 0600     the connection-fence AUTHORITY lives in
#     └── db-fence/               root:root 0755
#         └── db-connect-fence.json  root:root 0644
#   ${CUTOVER_STATE_DIR}          app-owned        the crontab backup, the crontab lock directory
#
# The crontab backup is NOT moved by this round. It is its own finding, filed separately, and it
# is a different shape: `publish_cron_backup()` never truncates and never dereferences, so what
# is wrong there is that ABSENCE and PRESENCE at that name are both read as answers. Moving the
# file does not fix that and this round does not pretend it does.
#
# ---------------------------------------------------------------------------
# AND EVERY OPERATION IS AIMED AT A DESCRIPTOR, NOT AT A NAME
# ---------------------------------------------------------------------------
# A root-owned parent makes the symlink unplantable. It does not make the code correct, and the
# code is what the next round reads, so the mechanism does not rest on the mode of a directory:
#
#   • THE DIRECTORY is created by enter_service_subdir(), the walk this file now owns: one
#     component at a time, each with a PLAIN `mkdir` (EEXIST on a planted symlink, where
#     `mkdir -p` silently works inside its target), each lstat-ed, each entered with `cd -P`, and
#     each proved after the step to BE the inode the entry named with `..` still the directory we
#     came from. An ancestor is never named again once it has been entered.
#
#   • ITS OWNER AND MODE are then applied by own_service_subdir() to `.` — the directory this
#     process is standing IN, answered by the kernel from the descriptor the shell holds. That is
#     `fchown(2)`/`fchmod(2)` in the only spelling a shell has: no component of the path is
#     resolved a second time, so no rename between the walk and the two calls can aim them
#     anywhere. It is the same move publish_durable_file() makes when it verifies `.` after its
#     chdir rather than re-asking for the pathname.
#
#     THIS IS THE ONE PLACE A `chmod` IS ALLOWED, and the prose above enter_service_subdir()
#     says why it is not allowed anywhere else: chmod has no --no-dereference on Linux, so a
#     chmod OF A PATHNAME is the same escalation as the chown with another verb. A chmod of `.`
#     names no path at all.
#
#   • THE LOCK is opened READ-ONLY. `flock(2)` locks the open file DESCRIPTION whatever its
#     access mode — crontab-lock.sh relies on exactly this, and so does the application's own
#     `openLockFile` — so the exclusion needs no write access, and an `open(O_RDONLY)` has no
#     O_CREAT and no O_TRUNC in it to aim. There is nothing left for a symlink at that name to
#     redirect: the worst it could do is make this run read a file it never reads.
#
#   • AND THE DESCRIPTOR IS VALIDATED BEFORE IT IS LOCKED, AND IT IS THE ONE THAT GETS LOCKED.
#     verify_held_lock() fstats the fd through /proc/self/fd/N — a magic link the kernel resolves
#     to the OPEN FILE, never to a pathname — and requires a regular file owned by this run. Then
#     it lstats the NAME and requires the same inode: that is
#     `O_NOFOLLOW` proven rather than assumed, the way chown-tree.mjs proves `O_PATH`, and it
#     is complete for this one open. If the open followed a link the two differ; if the name was
#     replaced since, they differ too, and BOTH are refusals. `flock` is then taken on that same
#     fd, and the fd is never reopened, so the lock that is held is the file that was judged.
#     The old code could not say that: `flock -n 9` succeeding says a lock was taken and says
#     nothing about what it was taken on.
#
# /proc IS ALREADY A DECLARED, GATED DEPENDENCY of these three scripts — publish_durable_file()
# pins its destination through /proc/self/fd/N and enter_service_root() enters every state root
# through it — so this costs nothing that was not already spent.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# CREATING A DIRECTORY INSIDE ONE THE SERVICE ACCOUNT OWNS (o3d-czpy)
#
# THE FINDING, RESTATED FOR DIRECTORIES. `mkdir -p a/b` SUCCEEDS SILENTLY when `a` is a symlink to
# a directory, and every step after it then operates inside the link's target. Every directory this
# installer creates under ${DATA_DIR} or ${APP_DIR} is created on an UPGRADE too, by which time
# `chown -R ${APP_USER}` has already handed the containing directory to the service account — so
# whoever holds that account chooses where the next run's `mkdir -p`, and anything written into
# what it "created", actually lands.
#
# WHERE THE LINE IS DRAWN, AND WHY IT IS NOT AT `/`. The boundary is the TOP-LEVEL directory this
# installer hands to the service account. At and above it the path belongs to the operator; below
# it a symlink is the finding, because below it is exactly the region the service account can
# write. So this walk starts at ${DATA_DIR} or ${LOG_DIR} and refuses a link at every component
# under it, and the root itself it simply `mkdir -p`s — its parent is root-owned, so the name
# cannot be forged.
#
# AND THE ROOT MAY NO LONGER BE A SYMLINK EITHER (o3d-rn10 r5). It used to be: putting
# /var/lib/${APP_NAME} on a second disk by symlinking it was a supported layout, on the argument
# that /var/lib is root-owned so the LINK cannot be forged. True, and beside the point — the path
# the link's TARGET resolves through is proved by nothing, and pin_dir_beneath_root() now refuses a
# symlinked publication root outright, naming the bind mount that replaces it. That refusal is the
# enforcement point, so a `mkdir -p` here has no link left to follow: under a bind mount the root
# is an ordinary directory, and an operator who still has a symlink meets the refusal at the first
# publication rather than silently getting two different answers from two walks.
#
# SO: `mkdir -p` the trusted root (its parent is root-owned), then create each component beneath it
# with a PLAIN `mkdir`, which fails with EEXIST on a planted symlink rather than working inside it,
# and lstat what is there when it does — `stat -c %F` reports "symbolic link" for a link, where
# `-L`, deliberately not used, would report the target's type. The outcome of a planted link is a
# REFUSED RUN naming the path, never a followed one.
#
# NO `chmod`, HERE EITHER. The mode comes from the umask the caller states, at creation. A
# directory that is already there with the wrong mode is the caller's problem to assert on; chmod
# has no --no-dereference on Linux, so correcting it would be the same escalation with another verb.
#
# AND THE WALK NO LONGER RE-RESOLVES WHAT IT HAS ALREADY CHECKED (o3d-czpy r2, Codex HIGH). The
# version above rebuilt an absolute `${built}` and handed the WHOLE pathname to the next `mkdir`,
# so every ancestor it had just accepted was resolved again, once per component. On an upgrade
# `${DATA_DIR}/uploads` is service-owned: the account renames it aside the instant after its `stat`
# says "directory" and leaves a symlink at the name, and the next root-side `mkdir` — which
# re-resolves `${DATA_DIR}/uploads/invoices` from the top — creates directories inside whatever
# they chose. A plain `mkdir` refuses a link AT the component it is creating and says nothing at
# all about the ancestry that got it there.
#
# THE WALK IS THEREFORE A CHDIR AND NOT A PATH. Each step creates or accepts a SINGLE COMPONENT
# relative to the directory this process is already inside, then steps into it. An ancestor is
# never named again after it has been entered, so renaming it cannot redirect anything: the shell
# holds a descriptor on the inode, and the descriptor is the pin.
#
# WHAT CLOSES THE LAST WINDOW — the one between "stat says directory" and "cd into it" — IS `..`,
# WHICH IS NOT A PATHNAME. A directory's `..` is its own parent link, answered by the kernel from
# the inode this process is in. Step into a component that was swapped for a symlink pointing
# somewhere else and `..` is that somewhere else's parent, not the directory we came from, and the
# run is refused. What this does NOT catch is a link aimed at another directory under the SAME
# parent — and it does not need to: that is a directory the service account already owns, so
# nothing crosses a privilege boundary.
#
# WHY NOT SIMPLY DROP TO ${APP_USER} FOR THE MKDIRs, which is the other remedy for the whole class:
# see copy_tree_into_new_dir() below, where the same choice is made and the reasoning is written
# out. In short, the pin holds for every principal, and the drop's guarantee cannot be exhibited by
# a harness that has only one uid.

# The walk. It ENDS WITH THE PROCESS INSIDE ${path} — that is not a side effect, it is the point:
# migrate_uploads() then moves files into `.` rather than re-resolving the destination it just had
# proved. Callers that do not want the cwd moved use mkdir_service_subdir(), which restores it.
#
# Every `die` below ENDS THE RUN, so the cwd it leaves behind never outlives the process; the one
# EXIT trap this script installs (${CRON_BLOCK_FILE}) names an absolute path.
enter_service_subdir() {
  local root="$1" mask="$2" path="$3"
  local rel comp built kind here entry
  # The root itself, whose parent is root-owned. `-p` is correct here and only here.
  mkdir -p "${root}" || die "${root} could not be created, so this installation has nowhere to put its state. Nothing has been changed."
  [[ "${path}" == "${root}/"* ]] || die \
    "enter_service_subdir was asked to create ${path}, which is not underneath ${root}. This is a bug in this script, not an operator error: the symlink-proof walk only means anything for components below the directory the service account owns."
  cd -P "${root}" 2>/dev/null || die \
    "${root} could not be entered, so this run cannot create anything beneath it. Nothing has been changed."
  here="$(stat -c '%d:%i' . 2>/dev/null || true)"
  [[ -n "${here}" ]] || die "${root} could not be identified, so this run cannot prove where it is creating ${path}. Nothing has been changed."
  rel="${path#"${root}/"}"
  built="${root}"
  while [[ -n "${rel}" ]]; do
    comp="${rel%%/*}"
    if [[ "${comp}" == "${rel}" ]]; then rel=""; else rel="${rel#*/}"; fi
    [[ -n "${comp}" ]] || continue
    built="${built}/${comp}"
    if ! (umask "${mask}"; mkdir "${comp}") 2>/dev/null; then
      kind="$(LC_ALL=C stat -c '%F' "${comp}" 2>/dev/null || true)"
      [[ "${kind}" == "directory" ]] || die \
        "${built} exists and is a ${kind:-missing path}, not a directory. A symlink there is how a compromised '${APP_USER}' would aim this installer's root-side writes at a path of their choosing, so this run refuses rather than following it. Remove or fix that path and run the installer again; nothing has been changed."
    fi
    # THE TYPE AND THE IDENTITY, TAKEN TOGETHER, whether this run created the component or accepted
    # one that was already there. `stat` without `-L` does not dereference.
    entry="$(LC_ALL=C stat -c '%F|%d:%i' "${comp}" 2>/dev/null || true)"
    [[ "${entry%%|*}" == "directory" ]] || die \
      "${built} is not the directory this run had just checked: it was replaced between the check and the step into it, which is how a compromised '${APP_USER}' would aim this installer's root-side writes at a path of their choosing. This run refuses rather than following it; nothing has been changed."
    cd -P "${comp}" 2>/dev/null || die \
      "${built} could not be entered after this run created or accepted it. Nothing has been changed."
    # AND THE DIRECTORY WE LANDED IN IS THE ONE THAT ENTRY NAMED (o3d-rn10). `..` alone accepts a
    # component swapped for a symlink to a SIBLING under the same parent; the inode does not.
    [[ "$(stat -c '%d:%i' . 2>/dev/null || true)" == "${entry#*|}" ]] || die \
      "${built} is not the directory this run had just checked: it was replaced between the check and the step into it, which is how a compromised '${APP_USER}' would aim this installer's root-side writes at a path of their choosing. This run refuses rather than following it; nothing has been changed."
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "${here}" ]] || die \
      "${built} is not in the directory this run had just checked: it was replaced between the check and the step into it, which is how a compromised '${APP_USER}' would aim this installer's root-side writes at a path of their choosing. This run refuses rather than following it; nothing has been changed."
    here="${entry#*|}"
  done
}

mkdir_service_subdir() {
  local root="$1" mask="$2"
  shift 2
  local path saved
  saved="$(pwd -P)" || die "this run cannot establish its own working directory, so it will not walk into ${root} and back. Nothing has been changed."
  for path in "$@"; do
    enter_service_subdir "${root}" "${mask}" "${path}"
    cd "${saved}" || die "this run could not return to ${saved} after creating ${path}. Nothing further has been changed."
  done
}

# ---------------------------------------------------------------------------
# THE SAME WALK, PLUS THE OWNER AND THE MODE, APPLIED TO THE DESCRIPTOR IT ENDED ON
# (o3d-secops r22, Codex CRITICAL)
#
#   own_service_subdir <root> <umask> <path> <owner> <mode>
#
# enter_service_subdir() ends with this process INSIDE ${path} — that is its contract and it is
# the whole reason this function can exist. `chmod` and `chown` are then issued against `.`,
# which the kernel answers from the directory descriptor the shell is holding. No component of
# ${path} is looked up a second time, so there is no window between "the walk proved this
# directory" and "this directory was chowned": they are the same inode by construction.
#
# THE ORDER IS MODE, THEN OWNER, and it is not cosmetic. The walk creates the component under the
# caller's umask, so it is already root-owned and already private; re-asserting the mode FIRST
# means the directory is never, for any instant, owned by ${APP_USER} at a mode this run had not
# yet narrowed. publish_durable_file() applies its mode before its content for the same reason.
#
# THE `chown` IS BEST-EFFORT AND THE `chmod` IS NOT, which is deliberate and is the pre-existing
# contract this replaces. The mode is a property this run can always assert and a wrong one is a
# real exposure, so a failure is a failure. The owner is ${APP_USER}, and a harness — or an
# operator running a dry probe — has one account and cannot chown to another; a hard failure
# there would make the mechanism unmeasurable by anything but a real root. What a failed chown
# leaves is a root-owned 0700 directory, which the connection fence then cannot write and says
# so, loudly, at the point of use. It is not silent and it is not a privilege.
own_service_subdir() {
  local root="$1" mask="$2" path="$3" owner="$4" mode="$5" saved
  saved="$(pwd -P)" || die "this run cannot establish its own working directory, so it will not walk into ${root} and back. Nothing has been changed."
  # Dies on anything it cannot prove; see the prose above enter_service_subdir().
  enter_service_subdir "${root}" "${mask}" "${path}"
  # `.`, NOT "${path}". This is the fchmod/fchown, and re-typing the pathname here would undo the
  # entire walk above it: every component would be resolved again, by name, as root.
  chmod "${mode}" . || { cd "${saved}" >/dev/null 2>&1 || true; die "${path} could not be set to mode ${mode}. Nothing has been changed."; }
  chown "${owner}:${owner}" . 2>/dev/null || true
  cd "${saved}" || die "this run could not return to ${saved} after preparing ${path}. Nothing further has been changed."
}

# ---------------------------------------------------------------------------
# A DIRECTORY A PRIVILEGED RUN MAY DUMP THE DATABASE INTO — THE WHOLE ANCESTRY, OR A REFUSAL
# (o3d-noka, and it closes o3d-ov60 site 5)
#
#   open_root_owned_ancestry <dir> <what>     leaves ${IMS_ROOT_ANCESTRY_FD} open on <dir>
#   close_root_owned_ancestry                 closes it again
#
# THE FINDING, IN ONE SENTENCE. update.sh writes a `pg_dump` of the whole database, publishes it
# with `mv` and prunes beside it with `rm --`, all as root, into a directory an operator names with
# ${IMS_BACKUP_DIR} and which nothing validated. The shipped default /var/backups/${APP_NAME} sits
# under a root-owned parent and is safe; the override moves all three anywhere, including underneath
# a path ${APP_USER} owns, where that account replaces one component with a symbolic link and root's
# dump, root's publication and root's delete all land where it chose. Measured, with the release's
# own statements: a whole-database dump written and published inside a root-owned 0700 directory the
# account could not even list, two pre-existing root-owned files in it deleted by the prune, and a
# named pipe at the predictable `.part` name wedging root's redirection for ever.
#
# THREE ROUNDS TRIED TO DEFEND THE WRITES INSTEAD OF CONSTRAINING THE PATH, and each closed its
# finding by opening a worse one — the third turned a denial of service into ARBITRARY CODE
# EXECUTION AS ROOT. The record is kept at the call site in scripts/update.sh, where the next reader
# meets it. What that record concluded is this function: ask the question of the PATH, once, and
# refuse what cannot answer it — after which nothing but root can plant a symlink, a FIFO or a stale
# `.part` at any name involved, the predictable name has no TOCTOU left to lose, no helper has to be
# executed, and the dump stops being readable by the service account into the bargain.
#
# THE RULE. Every component from `/` down to AND INCLUDING <dir> must be a real directory — never a
# symbolic link — owned by root or by the account this run executes as, and writable by nobody else:
# `mode & 0022 == 0`. A component that fails is NAMED, with the remedy, and the run STOPS: there is
# no branch below this that writes anyway.
#
# AND WHAT `mode & 0022 == 0` DOES AND DOES NOT SETTLE ABOUT A POSIX ACL — r1 GOT THIS WRONG AND THE
# CORRECTION IS THE REST OF THIS FUNCTION'S REASON TO EXIST (o3d-noka r2, Codex HIGH). r1's prose
# claimed this mode bounded any POSIX ACL as well, on the grounds that the group bits of an inode
# carrying one are its ACL mask. HALF OF THAT IS A THEOREM AND HALF WAS AN OVERREACH, and the
# difference is the difference between a private database dump and a world-readable one, so it is
# written out rather than summarised. (The exact sentences r1 shipped are forbidden by name in
# tests/scripts/install-root-safe-writes.test.ts, so a revert of this prose cannot pass quietly; no
# text check can stop somebody re-asserting the same idea in new words, which is why the reasoning
# below is spelled out instead of asserted.)
#
#   TRUE, AND STILL RELIED ON HERE — the MASK THEOREM, about an inode that ALREADY EXISTS. When an
#   ACL carries a mask entry, the group bits reported for the inode ARE that mask, and the effective
#   permission of every ACL_USER, ACL_GROUP and ACL_GROUP_OBJ entry is its own permission INTERSECTED
#   with the mask; ACL_OTHER is the other bits; ACL_USER_OBJ is the owner, asked separately. So for a
#   component that exists, `mode & 0022 == 0` really does mean no account but the owner and root can
#   WRITE it, ACL or no ACL, and `mode & 0077 == 0` really does mean no account but the owner and
#   root has ANY access to it. Nothing below reads an ACL, and it does not have to.
#
#   FALSE — A DEFAULT ACL IS NOT IN THE MODE BITS AT ALL, and it decides the mode of a child at the
#   moment the child is CREATED. A directory carries two ACLs: the access ACL, which the mask theorem
#   covers, and a DEFAULT ACL, which no permission bit of the directory reports and which is
#   inherited by every file and subdirectory created inside it. Inheritance also DISCARDS THE UMASK:
#   POSIX.1e computes the new inode's bits from the mode the creating syscall requested intersected
#   with the inherited default entries, and the process umask is not consulted at all. MEASURED, on
#   the filesystem this repository is developed on: a root-owned 0755 directory carrying
#   `default:user:<app>:r-x` passes the rule above, and inside it `(umask 077; … > file)` produces a
#   file at mode 0644 that the application account reads — the whole-database dump, in the r1 shape
#   of scripts/update.sh. A `default:group::r-x` with `default:mask::rwx` and no named entry at all
#   produces 0664. Two directories the walk CREATED in such an ancestor came out 0755 rather than the
#   0700 r1's prose claimed, and the application account could list both.
#
# SO PRIVACY IS NOT INFERRED FROM A MODE HERE; IT IS SET AND THEN VERIFIED, ON EVERY ARTEFACT THIS
# CODE CREATES. A directory the walk creates is `chmod 0700` on `.` — the inode it is standing in,
# never a name — and the achieved mode is READ BACK and refused if it is not private
# (_root_ancestry_here_is_now_private). The dump file is created by open_private_new_file() at an
# EXPLICIT mode, and its achieved mode is read back off the very descriptor the bytes will travel
# through, BEFORE the first byte. `umask 077` is kept on the `mkdir` because it is right whenever
# there is no default ACL, but nothing now DEPENDS on it, which is the whole correction.
#
# AND AN UNREADABLE OR UNSTATTABLE COMPONENT IS NOT PERMISSION TO PROCEED. A `stat` that cannot run
# is the one answer a check like this is most tempted to treat as absence of evidence; it is treated
# as a refusal, and there is a regression for each of the two shapes it takes (a component that
# cannot be stat'ed at all, and one whose parent denies this run the search permission to look).
#
# WHAT THE GUARANTEE IS, STATED PLAINLY, BECAUSE "check then use" IS THE DEFECT CLASS THIS
# REPOSITORY KEEPS PRODUCING:
#
#   * THE WALK IS A CHDIR, NOT A PATH. Each component is lstat-ed (`stat` with no `-L`, so a link
#     reads as "symbolic link" and is refused rather than followed), entered with `cd -P`, and then
#     the directory we LANDED IN is required to be the inode that entry named, with `..` still the
#     directory we came from. An ancestor is never named again after it has been entered, so a
#     rename above us cannot redirect anything: the shell holds a descriptor on the inode. This is
#     enter_service_subdir()'s mechanism and pin_publish_root_parent()'s, unchanged, and the two
#     checks together also refuse a directory moved WHOLESALE into another parent, which preserves
#     its inode.
#   * THE OWNER AND MODE QUESTION IS ASKED OF `.`, never of a name — of the inode this process is
#     standing in, after the chdir that pinned it.
#   * AND THE ANSWER IS HANDED BACK AS A DESCRIPTOR, NOT AS A STRING. ${IMS_ROOT_ANCESTRY_FD} is
#     opened on `.` while this process is inside the proved directory, and the caller aims the dump,
#     the publication and the prune at `/proc/self/fd/N`, which the KERNEL resolves to the open
#     directory rather than to a pathname. So the three operations are performed on the very inode
#     that was proved, and not one of them re-resolves a component. That is the half r1 got wrong:
#     a directory proved once and operated through its name three times afterwards is proved for
#     none of the three.
#
# WHAT IT DOES NOT CLAIM. ROOT is not constrained by any of this, and is not meant to be: the rule
# says that nobody ELSE can influence the path. No ACL is READ, by this function or by any other in
# this file: WRITE access to an existing component is bounded by its mode (the mask theorem above),
# and the confidentiality of what this code CREATES is established at creation and verified, which
# is a property of the artefact rather than a question about the directory's attributes. A DEFAULT
# ACL on an accepted directory is therefore TOLERATED and not refused — see the decision recorded
# below open_private_new_file() for why that is the choice, and what it costs. And a concurrent
# rename by root itself between the walk and the open is not excluded — the descriptor makes it
# harmless rather than impossible, because the operations follow the descriptor.
#
# THE STICKY BIT IS CREDITED FOR A STRICT ANCESTOR AND REFUSED FOR THE PARENT AND FOR <dir> ITSELF,
# which is pin_publish_root_parent()'s distinction and not a convenience. Sticky means an entry can
# be renamed or unlinked only by its own owner, so for an ANCESTOR that already exists and already
# belongs to root it settles the question: nobody else can move it, and whatever they may create
# beside it is a name this walk never utters. At the PARENT it settles nothing, because <dir> may
# not exist yet and "cannot replace an existing entry" says nothing about who gets to create it.
# And at <dir> ITSELF it is the wrong question twice over: the prune's glob deletes whatever matches
# it there, and the dump's `.part` name is predictable, so a directory anybody may create entries in
# is a directory anybody may plant a FIFO in. A backup directory directly under /tmp is therefore
# refused, and one inside a 0700 directory that /tmp happens to hold is not.
#
# IT IS ALSO WHAT MAKES THE ACCEPT PATH MEASURABLE (o3d-noka, stated as design input on the issue).
# A walk-from-`/` rule cannot be exhibited by a harness that owns no root-owned directory and can
# create none: every temporary root available to an unprivileged run — /tmp 1777, /var/tmp 1777 —
# fails it, correctly. Two properties together make the accept case real rather than asserted: the
# owner may be ROOT OR THE ACCOUNT RUNNING THIS (`id -u`, asked for the same reason
# publish_durable_file() asks it rather than hardcoding 0 — in production they are one account), and
# a sticky ancestor is credited. A harness's own 0700 directory under /tmp therefore PASSES and
# genuinely proceeds to write, which is what stops "refuse everything" from satisfying every test.
#
# A MISSING COMPONENT IS CREATED, one level at a time, with a PLAIN `mkdir` under umask 077 — never
# `mkdir -p`, which succeeds silently INSIDE a symbolic link's target, and which is the statement
# this function replaces. The container question is asked of the parent BEFORE the creation, so a
# component is only ever created inside a directory this walk has already proved; 0077 rather than
# the ambient umask because a dump of the whole database should not be readable by the account whose
# data it is, and because a directory this run creates at 0777 would be refused by this run's own
# next question, which is a confusing way to fail.
#
# AND THE COMPONENT THIS RUN CREATED IS THEN MADE PRIVATE AND CHECKED (o3d-noka r2). `umask 077` is
# DISCARDED by POSIX default-ACL inheritance, so inside a directory carrying one the `mkdir` above
# produces 0755 (measured) and the mode rule accepts it, because 0755 is not group- or
# other-WRITABLE. Whether `mkdir` succeeded is therefore read — for one purpose only, which is
# whether this run is entitled to change the mode: `mkdir` cannot succeed on a name that already
# exists, so a success means this run created that directory and nobody else's is being altered. An
# operator's own pre-existing directory is never chmod-ed. Acceptance is still decided by the lstat
# and the landing checks and not by mkdir's status.
#
# WHAT IT COSTS, AND IT IS OPERATOR-VISIBLE. An ${IMS_BACKUP_DIR} pointed underneath
# /var/lib/${APP_NAME} — a natural choice, since ${APP_DIR}/.env carries a DIFFERENT variable also
# spelled BACKUP_DIR which IS that path and IS the application's own — now gets a refusal instead of
# a dump. That is the point of the change rather than a side effect of it, and it is written up in
# docs/installation.md with the remedy: bind-mount the backup volume under a root-owned path, do not
# symlink it, and do not point it under ${DATA_DIR} or ${APP_DIR}.

# THE REFUSAL CHANNEL, THE DESCRIPTOR AND THE PROVED INODE, DECLARED AT SCRIPT SCOPE — the first
# script-scope statements in this file, and they earn it. All three entrypoints run under `set -u`,
# and ${IMS_ROOT_ANCESTRY_REASON} is read by the CALLER's `die`: a name created only by the function
# that refuses would abort the run with "unbound variable" instead of reporting the component that
# failed, which is the difference between a refusal and a crash. lib/privileged-helpers.sh declares
# ${IMS_DRIVER_REASON} at script scope for the same reason, and tests/scripts/deploy-order.test.ts
# requires it — it found these two.
IMS_ROOT_ANCESTRY_REASON=""
IMS_ROOT_ANCESTRY_FD=""
IMS_ROOT_ANCESTRY_INODE=""
# And open_private_new_file()'s two, at script scope for the same reason (o3d-noka r2): update.sh
# expands ${IMS_PRIVATE_FILE_REASON} in the refusal its `die` prints and ${IMS_PRIVATE_FILE_FD} in
# the redirection the dump travels through, both with no default and both under `set -u`.
IMS_PRIVATE_FILE_REASON=""
IMS_PRIVATE_FILE_FD=""

root_ancestry_refuse() {
  IMS_ROOT_ANCESTRY_REASON="$1"
  echo "REFUSING: $1" >&2
  return 1
}

# THE CONTAINER QUESTION, asked of the directory this process is standing in and never of a name.
# ONE `stat` takes the owner and the mode together, so the two answers cannot describe different
# directories. "$1" is that directory's pathname, carried for the refusal only — nothing resolves it.
_root_ancestry_here_is_private() {
  local path="$1" sticky_credit="$2" self="$3" meta owner mode
  meta="$(LC_ALL=C stat -c '%u|%a' . 2>/dev/null || true)"
  [[ "${meta}" == *"|"* ]] || {
    root_ancestry_refuse "${path} could not be inspected after this run stepped into it, so nothing here can establish whether another account may replace what lies beneath it. An unreadable component is not permission to continue. Nothing has been written." || return 1
  }
  owner="${meta%%|*}"
  mode="${meta##*|}"
  # Validated BEFORE `8#` sees it: `8#` on anything that is not octal is a fatal arithmetic error
  # under `set -e`, which is a crash and not a refusal.
  [[ "${mode}" =~ ^[0-7]+$ ]] || {
    root_ancestry_refuse "${path} reported the permission bits '${mode}', which this run cannot read as octal, so it cannot establish whether another account may write that directory. Nothing has been written." || return 1
  }
  [[ "${owner}" == "0" || "${owner}" == "${self}" ]] || {
    root_ancestry_refuse "${path} is owned by uid ${owner}, which is neither root nor the account this run executes as (uid ${self}). That account may replace, rename or re-create every name beneath it, so it — and not this run — would decide where the database dump is written, where it is published and what the prune deletes. Point IMS_BACKUP_DIR at a directory whose whole ancestry is root-owned and writable by nobody else; see docs/installation.md, 'Where the pre-update dump may go'. Nothing has been written." || return 1
  }
  if (( (8#${mode} & 8#22) != 0 )); then
    if (( sticky_credit == 1 )) && (( (8#${mode} & 8#1000) != 0 )); then
      # Sticky, and above the parent: an existing entry in it can be renamed or unlinked only by its
      # own owner, so no other account can move this run's way to the backup directory.
      return 0
    fi
    if (( sticky_credit == 1 )); then
      root_ancestry_refuse "${path} has permission bits ${mode} — writable by group or other, and not sticky — so an account other than this one can rename it and with it every name beneath it, including where the database dump is written and what the prune deletes. Take the group and other WRITE bit off that directory (its permission is checked on every operation, so the change takes effect at once) or move IMS_BACKUP_DIR; see docs/installation.md, 'Where the pre-update dump may go'. Nothing has been written." || return 1
    fi
    root_ancestry_refuse "${path} has permission bits ${mode} — writable by group or other — so an account other than this one can create entries in it: a named pipe at the dump's predictable partial name, which wedges a root-side redirection for ever, or a file matching the prune's glob. The sticky bit does not answer this one, because the question here is who may CREATE a name and not who may replace one. Take the group and other WRITE bit off that directory or move IMS_BACKUP_DIR; see docs/installation.md, 'Where the pre-update dump may go'. Nothing has been written." || return 1
  fi
  return 0
}

# A COMPONENT THIS RUN JUST CREATED, MADE PRIVATE AND THEN CHECKED (o3d-noka r2, Codex HIGH).
#
# WHY IT IS A `chmod` AT ALL, in a file whose publisher section says "no chmod, anywhere on these
# paths". That rule is about a path ANOTHER ACCOUNT CAN REACH: `chmod` has no `--no-dereference` on
# Linux, so a raced one follows a link somebody else planted. Neither half applies here. The subject
# is `.` — the inode this process is standing in after the chdir that pinned it, so there is no name
# to re-resolve and nothing to follow — and the only accounts that can create or replace a name in
# the parent are root and the account this run executes as, because the parent was required to
# satisfy `mode & 0022 == 0` BEFORE the `mkdir`. And it runs only on a directory THIS RUN CREATED
# (`mkdir` cannot succeed otherwise), so no operator's directory is ever altered.
#
# THE ACHIEVED MODE IS READ BACK. A `chmod` whose result is assumed is the same class of mistake as
# a `umask` whose result is assumed, which is the mistake this whole round is correcting; and on a
# filesystem that silently narrows or ignores a mode change, the refusal is the right answer. The
# test is `mode & 0077 == 0` — not `== 0700` — because that is the condition the mask theorem makes
# sufficient: with no group and no other bit, every ACL_USER, ACL_GROUP and ACL_GROUP_OBJ entry is
# masked to nothing and ACL_OTHER is nothing, so the directory is private to its owner whatever its
# ACL says, and no `getfacl` is needed to know it.
_root_ancestry_here_is_now_private() {
  local path="$1" mode
  chmod 0700 . 2>/dev/null || {
    root_ancestry_refuse "${path} was created by this run and could not then be made private, so a database dump beneath it would be left readable by whatever the containing directory's default ACL grants. Nothing has been written." || return 1
  }
  mode="$(LC_ALL=C stat -c '%a' . 2>/dev/null || true)"
  [[ "${mode}" =~ ^[0-7]+$ ]] || {
    root_ancestry_refuse "${path} was created by this run, and the permission bits it reports afterwards ('${mode}') cannot be read as octal, so this run cannot establish that it is private. Nothing has been written." || return 1
  }
  (( (8#${mode} & 8#77) == 0 )) || {
    root_ancestry_refuse "${path} was created by this run and is still mode ${mode} after being set to 0700, so another account may read the directory the database dump goes into. Nothing has been written." || return 1
  }
  return 0
}

# THE WALK. It ENDS WITH THE CALLING SHELL INSIDE <dir> on success, and part-way down it on failure
# — the contract enter_service_subdir() has, for the same reason: the result of a walk is a position
# and not a string. Callers go through open_root_owned_ancestry(), which restores the working
# directory either way and hands back a descriptor.
enter_root_owned_ancestry() {
  local dir="$1" what="$2" self rel comp path here entry kind landed above i last created
  local -a comps=()
  IMS_ROOT_ANCESTRY_REASON=""
  IMS_ROOT_ANCESTRY_INODE=""
  [[ "${dir}" == /* ]] || {
    root_ancestry_refuse "${what} (${dir}) is not an absolute path, and a relative one names a different directory for every process that reads it. Nothing has been written." || return 1
  }
  dir="${dir%/}"
  [[ -n "${dir}" ]] || {
    root_ancestry_refuse "${what} is the filesystem root itself, which is not a directory this run puts a database dump in. Nothing has been written." || return 1
  }
  self="$(id -u)" || return 1
  rel="${dir#/}"
  while [[ -n "${rel}" ]]; do
    comp="${rel%%/*}"
    if [[ "${comp}" == "${rel}" ]]; then rel=""; else rel="${rel#*/}"; fi
    # A `//` names the directory we are already standing in.
    [[ -n "${comp}" ]] || continue
    # `.` and `..` would step outside the walk while it believed it was stepping down it.
    [[ "${comp}" != "." && "${comp}" != ".." ]] || {
      root_ancestry_refuse "${what} (${dir}) has a '.' or '..' component, which would step outside the walk while it believed it was stepping down it. Name the directory without them. Nothing has been written." || return 1
    }
    comps+=("${comp}")
  done
  (( ${#comps[@]} > 0 )) || {
    root_ancestry_refuse "${what} (${dir}) has no component below the filesystem root. Nothing has been written." || return 1
  }
  # THE FIXED TRUSTED ANCESTOR, and the only one there is: `/` is the one directory on the machine
  # whose name nothing can rebind. Everything between it and <dir> is proved, not assumed.
  cd -P / 2>/dev/null || {
    root_ancestry_refuse "the filesystem root could not be entered, so this run has nowhere trustworthy to start the walk to ${dir} from. Nothing has been written." || return 1
  }
  here="$(stat -c '%d:%i' . 2>/dev/null || true)"
  [[ -n "${here}" ]] || {
    root_ancestry_refuse "the filesystem root could not be identified, so this run cannot establish which directory it walked to ${dir} from. Nothing has been written." || return 1
  }
  path="/"
  last=$(( ${#comps[@]} - 1 ))
  i=0
  while (( i <= last )); do
    # THE PARENT GETS NO STICKY CREDIT, and neither does <dir> itself below the loop. See above.
    if (( i < last )); then
      _root_ancestry_here_is_private "${path}" 1 "${self}" || return 1
    else
      _root_ancestry_here_is_private "${path}" 0 "${self}" || return 1
    fi
    comp="${comps[i]}"
    above="${path}"
    if [[ "${path}" == "/" ]]; then path="/${comp}"; else path="${path}/${comp}"; fi
    # A symbolic link already at this name makes the `mkdir` fail with EEXIST instead of being
    # worked inside, and 0077 keeps a dump of the whole database off a world-readable directory
    # where no default ACL overrides it. ACCEPTANCE is decided by the lstat and the landing checks
    # below and not by this status, whether this run created the component or found it there.
    # A PLAIN `mkdir`, and its STATUS is read for one purpose only: whether this run created the
    # component, and so whether it is entitled to set that directory's mode below. `mkdir` cannot
    # succeed on a name that already exists, so a success is proof of authorship.
    created=0
    if (umask 077; mkdir -- "${comp}") 2>/dev/null; then created=1; fi
    # ONE lstat, TAKING THE TYPE AND THE IDENTITY TOGETHER, so the two cannot describe different
    # directories. No `-L`, so a symlinked component reads as "symbolic link" and is refused.
    entry="$(LC_ALL=C stat -c '%F|%d:%i' "${comp}" 2>/dev/null || true)"
    [[ -n "${entry}" ]] || {
      root_ancestry_refuse "${path} could not be inspected: it does not exist and could not be created, or ${above} denies this run the search permission to look at it. An unstattable component is not permission to continue. Nothing has been written." || return 1
    }
    kind="${entry%%|*}"
    [[ "${kind}" == "directory" ]] || {
      root_ancestry_refuse "${path} is a ${kind}, not a real directory. A symbolic link at any component of this path is how another account aims a root-side database dump, its publication and its prune at a directory of their choosing, so this run refuses rather than following it. Replace it with a real directory — bind-mount a backup volume there rather than linking to it; see docs/installation.md, 'Where the pre-update dump may go'. Nothing has been written." || return 1
    }
    cd -P "${comp}" 2>/dev/null || {
      root_ancestry_refuse "${path} could not be entered after this run created or accepted it. Nothing has been written." || return 1
    }
    landed="$(stat -c '%d:%i' . 2>/dev/null || true)"
    [[ "${landed}" == "${entry#*|}" ]] || {
      root_ancestry_refuse "${path} is not the directory this run had just checked: it was replaced between the check and the step into it. Nothing has been written." || return 1
    }
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "${here}" ]] || {
      root_ancestry_refuse "${path} is not in the directory this run had just checked: it was moved into another parent between the check and the step into it. Nothing has been written." || return 1
    }
    # AND IF THIS RUN CREATED IT, IT IS MADE PRIVATE HERE — after the landing is proved, so the mode
    # change lands on the inode the walk is standing in, and before the question above the next
    # iteration asks of it. Inherited from a default ACL, `mkdir` under `umask 077` produces 0755.
    if (( created == 1 )); then
      _root_ancestry_here_is_now_private "${path}" || return 1
    fi
    here="${entry#*|}"
    i=$(( i + 1 ))
  done
  # AND <dir> ITSELF, with no sticky credit: this is the directory the predictable partial name and
  # the prune's glob both live in.
  _root_ancestry_here_is_private "${path}" 0 "${self}" || return 1
  IMS_ROOT_ANCESTRY_INODE="${here}"
  return 0
}

# THE WALK'S RESULT, AS A DESCRIPTOR, with the working directory restored either way.
#
# ${IMS_ROOT_ANCESTRY_FD} is a NAME rather than one of this file's literal lock descriptors because
# nothing locks it: `exec {var}<` allocates above 10, which is what publish_durable_file() does with
# its destination and for the same reason. A FAILED `exec` REDIRECTION ENDS A NON-INTERACTIVE SHELL,
# so the branch below it is not a fallback that writes anyway — there is no state in which this
# returns 0 without a descriptor on a proved directory.
open_root_owned_ancestry() {
  local dir="$1" what="$2" saved seen
  IMS_ROOT_ANCESTRY_FD=""
  saved="$(pwd -P)" || {
    root_ancestry_refuse "this run cannot establish its own working directory, so it will not walk into ${dir} and back. Nothing has been written." || return 1
  }
  if ! enter_root_owned_ancestry "${dir}" "${what}"; then
    cd "${saved}" >/dev/null 2>&1 || true
    return 1
  fi
  exec {IMS_ROOT_ANCESTRY_FD}< .
  # AND IT IS THE DIRECTORY THAT WAS WALKED TO, asked through an EXTERNAL command on purpose: that
  # is the route the caller's `mv` and `rm` take, so a descriptor those could not reach is refused
  # here rather than at the publication. `-L` because /proc/self/fd/N is a magic symbolic link.
  seen="$(stat -L -c '%d:%i' "/proc/self/fd/${IMS_ROOT_ANCESTRY_FD}" 2>/dev/null || true)"
  if [[ "${seen}" != "${IMS_ROOT_ANCESTRY_INODE}" ]]; then
    close_root_owned_ancestry
    cd "${saved}" >/dev/null 2>&1 || true
    root_ancestry_refuse "the descriptor this run opened on ${dir} does not answer as the directory it walked to (${seen:-nothing}, expected ${IMS_ROOT_ANCESTRY_INODE}), so the operations aimed at it could not be shown to land there. Nothing has been written." || return 1
  fi
  cd "${saved}" || {
    close_root_owned_ancestry
    root_ancestry_refuse "this run could not return to ${saved} after walking to ${dir}. Nothing has been written." || return 1
  }
  return 0
}

# THE CLOSE IS GROUPED, AND THAT IS NOT COSMETIC (o3d-noka r2, and it is o3d-secops r31's finding
# reintroduced). r1 wrote this as `exec {FD}<&- 2>/dev/null || true`. A BARE `exec` CARRYING A
# REDIRECTION APPLIES THAT REDIRECTION TO THE SHELL, PERMANENTLY -- so that statement sent every
# later warning, refusal and `die` of the WHOLE ENTRYPOINT to /dev/null. In scripts/update.sh this
# close is the last statement of the backup block, which means the migrations, the build, the service
# start and every failure banner after it printed to nothing. It was measured here the way r31
# measured its own: a refusal this round added printed its reason after a close and the reason
# vanished. db-fence-protected.sh carries the same idiom and the same comment in three places.
# Inside `{ ...; }` the suppression belongs to the group and is given back at the closing brace,
# while the descriptor the `exec` closes is still the shell's.
close_root_owned_ancestry() {
  [[ -n "${IMS_ROOT_ANCESTRY_FD:-}" ]] || return 0
  { exec {IMS_ROOT_ANCESTRY_FD}<&-; } 2>/dev/null || true
  IMS_ROOT_ANCESTRY_FD=""
  return 0
}

# ---------------------------------------------------------------------------
# A NEW FILE THAT IS PRIVATE BEFORE IT HOLDS A BYTE (o3d-noka r2, Codex round-1 HIGH)
#
#   open_private_new_file <at> <name> <what>   leaves ${IMS_PRIVATE_FILE_FD} open on it, for writing
#   close_private_new_file                     closes it again
#
# THE FINDING THIS CLOSES. r1 took the pre-update `pg_dump` under `umask 077` and said that closed
# the confidentiality half: "a whole-database dump is not created readable by the account whose data
# it is". A POSIX DEFAULT ACL ON THE DIRECTORY DEFEATS THAT ENTIRELY, and not marginally --
# inheritance computes the new file's permission bits from the mode the creating syscall REQUESTED
# intersected with the inherited default entries, AND DOES NOT CONSULT THE UMASK AT ALL. A shell
# redirection requests 0666. So in a root-owned 0755 directory carrying `default:user:<app>:r-x` --
# which satisfies every question the ancestry walk asks, because 0755 is not group- or
# other-writable -- the dump came out mode 0644 and the application account read it. Measured, as
# root, with scripts/update.sh's own statements lifted out by their text.
#
# AND CHMOD-ING IT AFTERWARDS IS NOT THE FIX. By the time a dump has been written there are bytes on
# disk to read, and the window is as long as the dump takes. The file has to be private at the
# moment it comes into existence.
#
# HOW. `install -m 0600 /dev/null <name>` creates the file with the mode as an ARGUMENT rather than
# as a default. That is not umask-governed -- a umask only ever clears bits from a requested mode, and
# the request here has none to clear -- and it is not defeated by inheritance either, because an
# inherited named or group entry is bounded by the mask, and the mask of a file created with no group
# bits is empty. Measured on a directory carrying `default:user:<app>:r-x`: mode 0600 and, in fact, a
# minimal ACL, because `install` also copies its source's (empty) ACL over the inherited one. It has
# two further properties this block wants and a shell redirection does not have: a FIFO at the name is
# REPLACED by a regular file rather than blocked on (which is r2's hang), and a symbolic link at the
# name is REPLACED rather than followed (which is r1's finding, in miniature) -- both measured.
#
# AND THE ACHIEVED MODE IS READ BACK OFF THE DESCRIPTOR THE BYTES WILL TRAVEL THROUGH, NOT OFF THE
# NAME. `exec {FD}> <name>` opens the file for writing; `stat -L` on `/proc/self/fd/N` is an fstat of
# the inode that descriptor holds. The type, the owner and the mode are taken from THAT, in one
# `stat`, before the caller writes anything. So the guarantee is not "install was asked for 0600", it
# is: NO BYTE OF THE DUMP IS EVER WRITTEN INTO AN INODE THIS RUN HAS NOT JUST SEEN TO BE PRIVATE.
# `mode & 0077 == 0` is the test, and it is sufficient by the mask theorem recorded above
# open_root_owned_ancestry(): with no group and no other bit there is no mask for an ACL_USER or
# ACL_GROUP entry to act through and ACL_OTHER is empty, so the file is private whatever its ACL
# says. No `getfacl` is read, and none is needed.
#
# THE DECISION ABOUT ACLs, STATED, BECAUSE THERE WERE TWO WAYS TO GO (o3d-noka r2). The other was to
# READ ACLs in the walk and refuse any component whose access or default ACL grants another account
# anything. That was rejected, and what it would have cost is:
#
#   * A NEW RUN-TIME DEPENDENCY AT THE WORST MOMENT OF THE CUTOVER. `getfacl` is a separate package
#     (`acl`) and is not present on every host. A check that cannot read an ACL must, by this
#     repository's own rule, refuse rather than shrug -- so the change would have turned "the acl
#     package is not installed" into "this release cannot be deployed", at the migration step, with
#     the service already stopped.
#   * A REFUSAL FOR SETUPS THAT ARE NOT DEFECTIVE. A default ACL on a backup volume is how an
#     operator gives an off-host backup agent access to the directory. Refusing it buys nothing once
#     the dump itself is private, and it is exactly the kind of narrowing an operator cannot see
#     coming from the variable's documentation.
#   * AND IT WOULD STILL BE THE WRONG PROPERTY. "The directory's ACL, when the walk looked" is an
#     attribute root can change afterwards, and it is one step removed from the thing that matters,
#     which is the mode of the file the dump goes into. Enforcing that mode at creation and reading
#     it back off the write descriptor answers the question directly and needs no ACL at all.
#
# WHAT THAT CHOICE DOES NOT BUY, SAID PLAINLY. A pre-existing root-owned 0755 backup directory stays
# readable and listable by every account, ACL or no ACL -- so the NAMES and TIMESTAMPS of the dumps in
# it are visible, and this change does not alter that; the dumps' CONTENTS are not. A directory this
# walk CREATES is narrowed to 0700 and verified (_root_ancestry_here_is_now_private), so on the
# shipped default path nothing is visible either. An inherited DEFAULT ACL on a directory the walk
# created is left in place: it can no longer affect this code, because every file this code creates
# gets an explicit mode, but a future statement that creates a file there with a plain redirection
# would inherit it again. That is what the grammar test in
# tests/scripts/install-root-safe-writes.test.ts is for -- a new writing statement in the block fails
# it until somebody decides what it is.
#
# NO PROGRAM IS RESOLVED OUT OF THE CHECKOUT. `install` is coreutils, on ${PATH}, exactly as
# `pg_dump`, `gzip`, `mv`, `ls` and `rm` in the same block are. That is not what r3's finding was
# about: r3 ran a node helper read out of ${APP_DIR}, which the service account owns and can replace
# after the operator started the run. Its absence is a REFUSAL here rather than a fallback to a
# mode-dependent creation, because a fallback would silently reinstate the defect.

# THE REFUSAL, WHICH ALSO TAKES THE FILE BACK OFF DISK. A destination this run created and then
# refused must not be left behind: a zero-byte `.part` at a mode this function has just declared
# unacceptable is exactly the artefact the next reader would mistake for a truncated dump. Both
# operands are required to be non-empty first, so the deletion cannot degenerate into a pathname
# nobody wrote; and it is ONE COMPONENT under the caller's descriptor, never a re-resolved pathname.
_private_new_file_refuse() {
  local at="$1" name="$2" reason="$3"
  # SAID FIRST, AND THEN ACTED ON. The reason is printed before the descriptor is closed, because a
  # close written as a bare `exec` with a redirection silences the shell's stderr for good and the
  # first casualty is the line that explains the refusal -- see close_root_owned_ancestry().
  IMS_PRIVATE_FILE_REASON="${reason}"
  echo "REFUSING: ${reason}" >&2
  close_private_new_file
  if [[ -n "${at}" && -n "${name}" && "${name}" != */* ]]; then
    rm -f -- "${at}/${name}" 2>/dev/null || true
  fi
  return 1
}

open_private_new_file() {
  local at="$1" name="$2" what="$3" self meta kind mode owner
  IMS_PRIVATE_FILE_FD=""
  IMS_PRIVATE_FILE_REASON=""
  self="$(id -u)" || return 1
  [[ -n "${at}" && -n "${name}" && "${name}" != */* ]] || {
    IMS_PRIVATE_FILE_REASON="${what} was asked for at a destination this run cannot address as one name under one descriptor (${at}/${name}). Nothing has been written."
    echo "REFUSING: ${IMS_PRIVATE_FILE_REASON}" >&2
    return 1
  }
  command -v install >/dev/null 2>&1 || {
    IMS_PRIVATE_FILE_REASON="${what} cannot be created with an explicit permission mode, because coreutils' \`install\` is not on this host's PATH. This run will not fall back to a redirection whose mode comes from the umask: a directory carrying a POSIX default ACL would then decide who may read a dump of the whole database. Install coreutils, or point the destination at a directory with no default ACL. Nothing has been written."
    echo "REFUSING: ${IMS_PRIVATE_FILE_REASON}" >&2
    return 1
  }
  # THE CREATION, WITH THE MODE AS AN ARGUMENT AND NOT AS A DEFAULT. One component, resolved from the
  # descriptor the caller passes.
  install -m 0600 /dev/null "${at}/${name}" 2>/dev/null || {
    IMS_PRIVATE_FILE_REASON="${what} could not be created at ${name} with a private permission mode. Nothing has been written."
    echo "REFUSING: ${IMS_PRIVATE_FILE_REASON}" >&2
    return 1
  }
  # A FAILED `exec` REDIRECTION ENDS A NON-INTERACTIVE SHELL, so there is no state below this in
  # which the caller holds no descriptor and writes anyway.
  exec {IMS_PRIVATE_FILE_FD}> "${at}/${name}"
  # ONE `stat`, on the DESCRIPTOR, taking the type, the mode and the owner together so the three
  # cannot describe different inodes. `-L` because /proc/self/fd/N is a magic symbolic link.
  meta="$(LC_ALL=C stat -L -c '%F|%a|%u' "/proc/self/fd/${IMS_PRIVATE_FILE_FD}" 2>/dev/null || true)"
  kind="${meta%%|*}"
  owner="${meta##*|}"
  mode="${meta#*|}"; mode="${mode%%|*}"
  [[ "${meta}" == *"|"*"|"* ]] || {
    _private_new_file_refuse "${at}" "${name}" "${what} was created at ${name}, but the descriptor opened on it could not be inspected, so this run cannot establish that what it is about to write is private. An uninspectable destination is not permission to write to it. Nothing has been written." || return 1
  }
  [[ "${kind}" == regular* ]] || {
    _private_new_file_refuse "${at}" "${name}" "${what} was created at ${name}, but the descriptor opened on it answers as a ${kind} rather than a regular file, so the bytes would not go where this run believes. Nothing has been written." || return 1
  }
  [[ "${mode}" =~ ^[0-7]+$ ]] || {
    _private_new_file_refuse "${at}" "${name}" "${what} was created at ${name}, and the permission bits its descriptor reports ('${mode}') cannot be read as octal, so this run cannot establish that it is private. Nothing has been written." || return 1
  }
  if (( (8#${mode} & 8#77) != 0 )); then
    _private_new_file_refuse "${at}" "${name}" "${what} was created at ${name} and came out mode ${mode}, which another account can read or write. A POSIX DEFAULT ACL on the destination directory overrides the mode a creation asks for, and the umask is not consulted at all -- so this is not a mode this run can correct and then trust. Take the default ACL off that directory (\`setfacl -k\`), or point the destination somewhere without one. Nothing has been written." || return 1
  fi
  [[ "${owner}" == "0" || "${owner}" == "${self}" ]] || {
    _private_new_file_refuse "${at}" "${name}" "${what} was created at ${name} but belongs to uid ${owner}, which is neither root nor the account this run executes as (uid ${self}), so this run is not writing into a file of its own. Nothing has been written." || return 1
  }
  return 0
}

# GROUPED, for the reason recorded above close_root_owned_ancestry().
close_private_new_file() {
  [[ -n "${IMS_PRIVATE_FILE_FD:-}" ]] || return 0
  { exec {IMS_PRIVATE_FILE_FD}>&-; } 2>/dev/null || true
  IMS_PRIVATE_FILE_FD=""
  return 0
}

# ---------------------------------------------------------------------------
# COPYING A TREE INTO A DIRECTORY THE SERVICE ACCOUNT OWNS (o3d-czpy)
#
# IT LIVES HERE, AND NOT IN install.sh, BECAUSE THERE ARE TWO CLONE PATHS (o3d-ov60). o3d-czpy
# wrote this function and gave it install.sh's two call sites; update.sh's clone path — the same
# `rm -rf "${APP_DIR}/.git"` followed by the same `cp -a` into the same name — kept the raw pair,
# so the rule held in one of the two entrypoints that perform it. That is the shape every finding
# in this file has: one rule, several readers, and the fix applied to the reader whose defect was
# being read at the time. A helper that can be reached from only one of its call sites is not a
# helper, so it moved to the library all three entrypoints source and update.sh now calls it.
# Nothing about the mechanism changed in the move; the o3d-czpy regressions lift it from this file
# instead of that one and are otherwise untouched.
#
# `rm -rf "${APP_DIR}/.git"` followed by `cp -a "${clone}/.git" "${APP_DIR}/.git"` is the same
# finding one more time, and the `rm` is what opens it: it removes a symlink without following it
# (correct), and leaves the NAME free for the service account to re-create as a symlink to
# somewhere else before the `cp` runs. `cp -a src dest` with `dest` a symlink-to-directory copies
# INTO the target, as root, with the copy's ownership.
#
# Two steps, and the second is the one that matters. A plain `mkdir` refuses a name that is already
# taken, so a link planted between the `rm` and here ends the run instead of being followed. Then
# `cd` PINS the result: the shell holds a descriptor on the inode it just created, and a rename of
# the name cannot move it. The copy is then made relative to that cwd and can land nowhere else.
#
# BUT OWNERSHIP IS NOT IDENTITY, AND THAT IS WHAT THE uid CHECK WAS MISTAKEN FOR (o3d-czpy r2,
# Codex HIGH). There is a window between the `mkdir` and the `cd`. The service account owns
# ${APP_DIR}, so in that window they can rename the directory this run just created aside and leave
# at its name a SYMLINK TO ANOTHER ROOT-OWNED DIRECTORY — /root, /etc/systemd/system, the git
# metadata of some other install. `cd` follows it, and `stat -c '%F|%u' .` then answers
# "directory|0" and the check PASSES, precisely because the target they chose is root-owned. The
# root-side `cp -a` writes the whole of the clone's .git into that directory, overwriting any
# entry with a matching name — `config` among them. Being owned by root is a property a great many
# directories have; being THE directory this run created is a property exactly one has.
#
# SO THE CHECK IS `..` AND NOT THE OWNER. ${APP_DIR}'s own parent is root-owned, so ${APP_DIR}
# cannot be renamed by the service account and its device and inode, taken before the `rm`, are a
# fact this function can rely on. After the chdir, `..` — the kernel's answer for the parent of the
# inode this process is inside, not a re-resolution of a pathname — must be that same directory.
# A link to anywhere outside ${APP_DIR} fails it. A link to another directory INSIDE ${APP_DIR}
# passes it and is harmless: that directory already belongs to the service account. The uid check
# is kept for what it does prove — that the `mkdir` and not somebody else created what we are in.
#
# WHY THIS AND NOT `run_as_user "${APP_USER}"`, which is the other remedy and would delete the
# class rather than guard it: the result IS service-owned (the callers chown -R it immediately
# afterwards), so the drop is available here and would be sound. It is not taken because the
# guarantee it gives cannot be EXHIBITED. A drop is worth exactly one sentence — "the account that
# could plant the symlink is the account doing the write" — and to observe it a harness needs two
# uids, which an unprivileged test run does not have; under a drop the planted symlink is FOLLOWED
# rather than refused, so the operator also loses the refusal that names the path. The pin is
# uid-independent, which matters because the same argument cannot be made for publish_durable_file()
# at all: its markers are deliberately root-owned INSIDE service-owned directories, so that the
# service account cannot forge a fence, and there is no version of them that root does not write.
# One mechanism, stated once, holding for every principal. The descriptor-relative alternative
# (openat2 with RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS, mkdirat, renameat) is stronger still — it
# closes the link-inside-the-same-parent case too — but it is not shell: it would mean a compiled
# or Python helper shipped and verified alongside this script, on a host where the installer is the
# thing that establishes what is installed.
copy_tree_into_new_dir() {
  local src="$1" dest="$2" self meta parent
  # THE DESTINATION IS CHECKED HERE AT RUN TIME, not only at the call sites (o3d-z5be r11, review H3):
  # this deletes and replaces a PARAMETER, and a caller that is not guarded — or a library that grows
  # one — must not be able to aim it at the tree this run is executing from.
  # The refusal ends the run from any context (privileged_end_run); `|| die` is the fallback if that
  # function is not loaded, so a missing library fails closed rather than open.
  privileged_spare_running_tree "${dest}" "the directory copy_tree_into_new_dir would replace" \
    || privileged_end_run "${IMS_DRIVER_OVERLAP_REASON:-the running-tree check is not loaded, so ${dest} cannot be shown to be separate from it}" \
    || die "${IMS_DRIVER_OVERLAP_REASON:-the running-tree check is not loaded, so ${dest} cannot be shown to be separate from it}"
  self="$(id -u)" || die "\`id -u\` failed, so this run cannot establish which uid it is and cannot prove that ${dest} is the directory it just created."
  parent="$(stat -c '%d:%i' "$(dirname "${dest}")" 2>/dev/null || true)"
  [[ -n "${parent}" ]] || die "$(dirname "${dest}") could not be identified, so this run cannot prove where ${dest} is. Nothing has been copied."
  rm -rf "${dest}"
  (umask 022; mkdir "${dest}") 2>/dev/null || die \
    "${dest} could not be created: something is already at that path after it was removed, which is how a compromised '${APP_USER}' would aim this copy at a directory of their choosing. Nothing has been copied."
  (
    cd -P "${dest}" 2>/dev/null || exit 1
    meta="$(LC_ALL=C stat -c '%F|%u' . 2>/dev/null || true)"
    [[ "${meta}" == "directory|${self}" ]] || exit 1
    [[ "$(stat -c '%d:%i' .. 2>/dev/null || true)" == "${parent}" ]] || exit 1
    cp -a "${src}/." . 2>/dev/null || exit 1
  ) || die "${src} could not be copied into ${dest}: either the copy failed, or the name this run created was replaced — after it was created — by a link to a directory somewhere else, which this run refuses to follow however that directory is owned. Nothing that a later step depends on has been written."
}

# ---------------------------------------------------------------------------
# WHETHER THE DESCRIPTOR THIS PROCESS IS HOLDING IS THE FILE THE NAME MEANT
#
#   verify_held_lock <fd> <path>
#
# Two questions, both asked of the fd and never of the name a second time:
#
#   1. WHAT IS THE OPEN FILE? `stat -L /proc/self/fd/N` — `-L` because /proc/self/fd/N is a magic
#      link, and dereferencing it is what makes this an `fstat(2)` of the open file description
#      rather than a walk of anything. A regular file, owned by the uid this run has. NO MODE IS
#      ASSERTED ON THE FILE, and crontab-lock.sh writes out why: nothing ever reads or writes its
#      contents, only its inode is the lock, and it cannot be replaced from inside a directory
#      nobody else may write — so the mode that IS load-bearing is the PARENT's, asserted where
#      the parent is made (ensure_cutover_root_dir). Asserting one here as well would only mean
#      that a host whose umask left the file 0664 refused every cutover for a property nothing
#      depends on. `id -u` rather than a hardcoded 0 for the same reason
#      publish_durable_file() and prepare_crontab_lock() ask it: the property is "the privileged
#      account that owns this install", and asking lets the regressions exhibit the mechanism
#      without being root.
#
#   2. IS IT THE NAME'S OWN INODE? `stat` WITHOUT `-L` on ${path} is an lstat, so a symlink there
#      reports the LINK's inode and never its target's. Requiring the two to agree is `O_NOFOLLOW`
#      proven rather than asked for — the same proof chown-tree.mjs makes of `O_PATH` — and it is
#      complete for this one open: if the open followed a link the two differ, and if the name was
#      swapped after the open they differ as well. A DISAGREEMENT IS NEVER READ AS AN ACCEPTANCE,
#      and the bytes locked are the descriptor's either way.
#
# EVERY `stat` HERE TAKES `|| true` AND IS COMPARED AGAINST A POSITIVE LITERAL, which is the same
# rule crontab-lock.sh writes out: a stat that could not run yields the empty string, matches
# nothing, and the function returns 1. The failure direction is the refusing one.
verify_held_lock() {
  local fd="$1" path="$2" self held kind owner ident named
  self="$(id -u)" || return 1
  held="$(LC_ALL=C stat -L -c '%F|%u|%d:%i' "/proc/self/fd/${fd}" 2>/dev/null || true)"
  IFS='|' read -r kind owner ident <<< "${held}"
  [[ "${kind}" == "regular file" || "${kind}" == "regular empty file" ]] || return 1
  [[ -n "${owner}" && "${owner}" == "${self}" ]] || return 1
  named="$(LC_ALL=C stat -c '%d:%i' "${path}" 2>/dev/null || true)"
  [[ -n "${ident}" && "${named}" == "${ident}" ]] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# THE LOCK FILE ITSELF, INSIDE A DIRECTORY NOBODY BUT THIS RUN MAY WRITE
#
# The primitives are crontab-lock.sh's, chosen for the same property and for no other: none of
# them follows a symlink.
#
#   • the parent is walked to, not `mkdir -p`ed, by own_service_subdir() above;
#   • `set -C` (noclobber) is `open(O_CREAT|O_EXCL)`, which fails with EEXIST when the final
#     component is a symlink — dangling or not — and so can neither create nor truncate a target.
#     `touch`, and a plain `: >` redirection, both follow;
#   • `stat -c %F` is an lstat, so a link reads as "symbolic link" and is refused rather than
#     described by its target;
#   • `chown -h` never dereferences, so even a path swapped between the check and the call
#     changes the LINK and cannot hand a target away.
#
# NOTHING EVER WRITES THIS FILE. Its contents are meaningless; only its inode is the lock.
#
# AND IT IS 0600, WHICH r23 PUT BACK AS A FACT (o3d-secops r23, Codex HIGH). r22 dropped the mode
# assertion this file used to make, on the argument that "a lock nobody writes needs no write
# permission, and a mode nothing depends on is one nothing has to defend". SOMETHING DEPENDED ON
# IT: `flock(2)` applies to the OPEN FILE DESCRIPTION whatever its access mode, which is the whole
# reason the lock is opened O_RDONLY — so READ permission is exactly what lets an account take
# this lock. ${CUTOVER_ROOT_DIR} must be TRAVERSABLE by ${APP_USER}, because ${DB_FENCE_DIR} lives
# beneath it; at 0644 that account could then open this file and hold `flock -n` on it forever,
# and every deploy, update and install on the box would die at the exclusion with no way to see
# why. A denial of service with no expiry, from a file nothing reads.
#
# THE MODE IS SET, NOT ASSERTED, AND THAT IS THE POINT OF THE r22 OBJECTION ANSWERED RATHER THAN
# OVERRULED. r22 was right that a bare assertion turns an ambient umask into a refused cutover for
# a property nothing repairs. So the create runs under a STATED umask rather than an inherited one
# — `umask 077` makes the O_CREAT mode 0600 on any host — and narrow_held_lock() below then
# NARROWS a file an older run left at 0644 and proves the result off the descriptor. An
# environment can no longer produce a wide lock, so the refusal that remains is the one that
# matters: a mode this run could not fix.
prepare_cutover_lock_file() {
  local path="$1" kind
  if [[ ! -e "${path}" ]]; then
    ( umask 077; set -C; : > "${path}" ) 2>/dev/null || true
  fi
  kind="$(LC_ALL=C stat -c '%F' "${path}" 2>/dev/null || true)"
  [[ "${kind}" == "regular file" || "${kind}" == "regular empty file" ]] || return 1
  chown -h "$(id -u):$(id -g)" "${path}" 2>/dev/null || true
  return 0
}

# THE MODE, APPLIED TO THE DESCRIPTOR AND THEN READ BACK OFF IT
#
#   narrow_held_lock <fd>
#
# `chmod` OF /proc/self/fd/N IS AN fchmod IN THE ONLY SPELLING A SHELL HAS, and it is the same
# device own_service_subdir() uses when it chmods `.`: the magic link is resolved by the kernel to
# the OPEN FILE, so no component of any pathname is walked a second time and there is no name for
# a rename to aim. It is called only after verify_held_lock() has proved the descriptor is a
# regular file owned by this run AND is that name's own inode, so the inode being narrowed is the
# one this run is about to lock.
#
# THE READ-BACK IS THE ASSERTION, taken through the same descriptor. A `chmod` that silently did
# nothing — a read-only mount, an immutable attribute — would otherwise leave a 0644 lock and a
# run that believed it had a 0600 one, which is the shape of every finding in this file.
narrow_held_lock() {
  local fd="$1" mode
  chmod 600 "/proc/self/fd/${fd}" 2>/dev/null || true
  mode="$(LC_ALL=C stat -L -c '%a' "/proc/self/fd/${fd}" 2>/dev/null || true)"
  [[ "${mode}" == "600" ]] || return 1
  return 0
}

# THE MODE THE DESCRIPTOR WAS OPENED ON, ASKED BEFORE ANYTHING NARROWS IT
#
#   held_lock_mode <fd>
#
# Printed rather than returned, because the answer is three octal digits and the caller compares
# them. `stat -L` of /proc/self/fd/N for the same reason narrow_held_lock() chmods it: the magic
# link is resolved by the kernel to the OPEN FILE, so this is an fstat of the inode this run is
# holding and not a second walk of a pathname somebody could have re-aimed in between.
#
# `|| true`, so a stat that could not run yields the empty string — which lock_mode_is_private()
# reads as "not private", and the failure direction is therefore the one that repairs.
held_lock_mode() {
  local fd="$1"
  LC_ALL=C stat -L -c '%a' "/proc/self/fd/${fd}" 2>/dev/null || true
}

# WHETHER A MODE IS ONE NO OTHER ACCOUNT COULD HAVE OPENED
#
#   lock_mode_is_private <mode>
#
# `flock(2)` needs nothing but an open descriptor, so any bit that lets another account OPEN this
# file is a bit that lets it hold this lock. The question is therefore about group and other, and
# about read as much as write. An empty or unreadable mode answers "no".
lock_mode_is_private() {
  local mode="$1"
  [[ -n "${mode}" ]] || return 1
  (( (8#${mode} & 0077) == 0 )) || return 1
  return 0
}

# ---------------------------------------------------------------------------
# A LOCK THAT WAS EVER WIDE IS REPLACED, NOT REPAIRED (o3d-secops r24, Codex MEDIUM)
#
#   rotate_cutover_lock_inode <path>
#
# THE FINDING, AND IT IS PLAIN UNIX SEMANTICS. r23 narrowed an inherited 0644 lock to 0600 on the
# descriptor and proved the new mode off that same descriptor, and concluded that only a privileged
# account could now take this lock. PERMISSION IS CHECKED AT `open(2)` AND NEVER AGAIN. An
# application-account process on a host upgraded from a checkout that left this file at 0644 can
# have opened it BEFORE this run started, without locking it — nothing about an open is visible to
# `fuser` in the way a lock is, and nothing about it is affected by a later `chmod`. It keeps a
# usable descriptor. The moment this cutover exits and releases fd 9, that process can `flock` its
# descriptor and hold the canonical lock indefinitely, and every deploy, update and install on the
# box afterwards dies at the exclusion with nothing to point at. Narrowing in place revokes nothing
# that is already held.
#
# SO THE INODE IS REPLACED. A fresh 0600 file is created in the same root-owned directory, opened,
# verified, narrowed and LOCKED, and only then renamed over the canonical name. A descriptor
# somebody opened while the old file was wide still refers to the old inode — which now has no name
# — so the lock they can take on it is a lock on nothing, and the next cutover opens the
# replacement and is not blocked by it.
#
# WHAT THAT BUYS AND WHAT IT COSTS, WORKED OUT RATHER THAN ASSERTED. Replacing an inode means
# giving up exclusion against whoever still holds the old one. That is the whole trade, and it is
# acceptable here for a reason that has to be stated to be checked:
#
#   * THIS IS ONLY EVER REACHED WHILE THIS RUN HOLDS `flock` ON THE OLD INODE. The caller flocks
#     fd 9 first and dies if it cannot, so at the instant of the rename nothing else holds that
#     lock — proved, not assumed. There is no predecessor to orphan.
#   * AND fd 9 IS DELIBERATELY KEPT OPEN AFTERWARDS, for the whole run. Anything that opened the
#     old inode before the rename and reaches its own `flock` later is still refused by us, so the
#     window between the rename and the end of this cutover is covered too.
#   * A GENUINE CONCURRENT CUTOVER THEREFORE NEVER LOSES. If it got here first it holds the old
#     inode's lock, our `flock -n 9` fails, we die with "Another cutover ... holds" and NOTHING IS
#     ROTATED -- its inode is never swapped out from under it. If it arrives while we hold fd 9 it
#     is refused on the old inode; if it arrives after the rename it is refused on the new one. The
#     only process that can ever take the orphaned inode's lock is one that opened it and then did
#     not immediately try to lock it, and no cutover in this repository is ever in that state:
#     `flock -n` is non-blocking, follows the open in this same function, and every failure is a
#     `die`. That state belongs to the holdout this exists to defeat, and to nothing else.
#   * AND IT HAPPENS ONCE. The gate is the mode the lock was INHERITED at, so the run after this
#     one finds 0600 and rotates nothing; the canonical inode is stable from then on.
#
# THE DESCRIPTOR NUMBER IS A LITERAL, and it is 6 — the number the canonical lock used before r22,
# free since r23 gave it back. `exec` cannot take an fd from a variable without `eval`, which the
# lexical scanner these scripts are held to refuses. So the replacement is held on 6 and the
# inherited inode stays on 9, and the cutover exclusion for the rest of the run is 6.
#
# THE PRIMITIVES ARE prepare_cutover_lock_file()'s, for its reasons: `set -C` is
# `open(O_CREAT|O_EXCL)` and cannot create or truncate through a symlink, `stat -c %F` is an lstat,
# `chown -h` never dereferences. The staging name is this process's own inside a directory only
# root may write, so nothing else can be at it; a leftover from a crashed run with the same pid is
# removed first.
rotate_cutover_lock_inode() {
  local path="$1" temporary kind
  temporary="${path}.rotate.$$"
  rm -f "${temporary}" 2>/dev/null || true
  ( umask 077; set -C; : > "${temporary}" ) 2>/dev/null || return 1
  kind="$(LC_ALL=C stat -c '%F' "${temporary}" 2>/dev/null || true)"
  if [[ "${kind}" != "regular file" && "${kind}" != "regular empty file" ]]; then
    rm -f "${temporary}" 2>/dev/null || true
    return 1
  fi
  chown -h "$(id -u):$(id -g)" "${temporary}" 2>/dev/null || true
  exec 6<"${temporary}"
  if ! verify_held_lock 6 "${temporary}" || ! narrow_held_lock 6 || ! flock -n 6; then
    exec 6<&-
    rm -f "${temporary}" 2>/dev/null || true
    return 1
  fi
  # THE RENAME IS THE PUBLICATION, and it is made while both locks are held: fd 9 on the inode
  # being retired and fd 6 on the one taking its place. Nothing can be handed a lock on the
  # canonical name in between, because there is no instant in which the name is unlocked.
  if ! mv -f "${temporary}" "${path}" 2>/dev/null; then
    exec 6<&-
    rm -f "${temporary}" 2>/dev/null || true
    return 1
  fi
  # AND THE NAME NOW MEANS THE DESCRIPTOR THIS RUN IS LOCKING, asked the same way the first
  # acquisition asked it. A rename that landed somewhere else, or a name replaced in the instant
  # after it, is a run that cannot say what it is excluding.
  verify_held_lock 6 "${path}" || return 1
  return 0
}

# ---------------------------------------------------------------------------
# THE NAMESPACE, CREATED BEFORE ANYTHING IS LOCKED OR WRITTEN
#
# ${CUTOVER_STATE_DIR} is still `mkdir -p`ed here and that is still correct: it is the
# APPLICATION'S OWN data directory, it is meant to be writable by ${APP_USER}, and nothing this
# round writes into it. What moved out of it is the pair that were root-side targets — the lock
# and the connection-fence directory — and they are created below by the walk, beneath a parent
# no unprivileged account can write.
ensure_cutover_state_dirs() {
  mkdir -p "$CUTOVER_STATE_DIR" || return 1
  ensure_cutover_root_dir || return 1
  # AND THE FENCE AUTHORITY'S DIRECTORY, BENEATH IT. own_service_subdir() walks
  # ${CUTOVER_ROOT_DIR} -> ${DB_FENCE_DIR} one component at a time and applies the owner and the
  # mode to the descriptor it lands on, so neither `chown` nor `chmod` ever names a path a second
  # time.
  #
  # OWNED BY THIS RUN, AT 0755 (o3d-secops r23). It was `"$APP_USER" 700` until r23; the owner is
  # now the privileged account that owns this install, asked with `id -un` for the same reason
  # publish_durable_file() asks `id -u` — the property is "the account root runs the cutover as",
  # and asking lets an unprivileged harness exhibit the mechanism. AN UPGRADE REPAIRS THE OLD
  # LAYOUT: a directory an earlier run handed to ${APP_USER} is walked to and re-owned here, and
  # anything that account left INSIDE it is refused rather than read, because the fence helper
  # requires the record to be owned by the account that published it.
  own_service_subdir "$CUTOVER_ROOT_DIR" 022 "$DB_FENCE_DIR" "$(id -un)" 755
  return 0
}

# THE ROOT-OWNED PARENT ITSELF. It is the walk's ROOT rather than one of its components, so it is
# `mkdir -p`ed — correct here and only here, for the reason install.sh has always given: its own
# parent is /etc, which is root-owned, so no unprivileged account can bind or rebind this name.
#
# A LINK AT IT IS STILL REFUSED RATHER THAN FOLLOWED, both before and after the `mkdir -p`, which
# is the pair ensure_fence_marker_dir() makes and for the same reason: `mkdir -p` succeeds
# SILENTLY inside a symlink's target, so the check has to be an lstat of the name and it has to be
# made again afterwards. Then the process steps in, and the mode and the owner are applied to `.`.
ensure_cutover_root_dir() {
  local saved meta kind owner mode
  [[ -L "${CUTOVER_ROOT_DIR}" ]] && return 1
  mkdir -p "${CUTOVER_ROOT_DIR}" || return 1
  [[ -L "${CUTOVER_ROOT_DIR}" ]] && return 1
  saved="$(pwd -P)" || return 1
  cd -P "${CUTOVER_ROOT_DIR}" 2>/dev/null || return 1
  # 0711: root-owned and TRAVERSABLE, so ${APP_USER} can reach ${DB_FENCE_DIR} beneath it and can
  # create, replace and unlink NOTHING in it. That is the whole protection.
  #
  # TRAVERSABLE AND NOT LISTABLE (o3d-secops r23, Codex HIGH). r22 wrote 0755 and justified only
  # the `x` bit; the `r` bit went with it unexamined, and r23 asked the question the mode of the
  # lock file made unavoidable — what in here needs to be READABLE by that account? Nothing does.
  # ${DB_FENCE_DIR} is reached by NAME, which needs `x` on this directory and not `r`, and the two
  # names in here are compiled into the scripts rather than discovered. So the directory listing
  # goes, and with it the enumeration that would tell that account when a fence record exists.
  if ! chmod 711 . || ! chown "$(id -u):$(id -g)" .; then
    cd "${saved}" >/dev/null 2>&1 || true
    return 1
  fi
  # AND THE POST-CONDITION IS READ BACK OFF THE SAME DESCRIPTOR, because this is the property both
  # findings rest on and neither of the two calls above is asked whether it worked in the way that
  # matters. A group- or other-writable parent hands every name inside it back to whoever can write
  # it, which is precisely the state ${CUTOVER_STATE_DIR} is in and the reason this directory
  # exists. It is REFUSED rather than corrected: a second chmod would be the same unasked question.
  meta="$(LC_ALL=C stat -c '%F|%u|%a' . 2>/dev/null || true)"
  IFS='|' read -r kind owner mode <<< "${meta}"
  if [[ "${kind}" != "directory" ]] || [[ "${owner}" != "$(id -u)" ]] || (( (8#${mode:-777} & 0022) != 0 )); then
    cd "${saved}" >/dev/null 2>&1 || true
    return 1
  fi
  cd "${saved}" || return 1
  return 0
}

# ONE LOCK FOR ALL THREE ENTRYPOINTS (o3d-2sm1.5, Codex r9 HIGH). deploy.sh held
# ${STATE_DIR}/deploy.lock and update.sh held ${DATA_DIR}/update.lock, so "refusing to run
# two cutovers at once" was true of two deploys and false of a deploy racing an update;
# install.sh took no lock at all. One path, taken by all three — and since o3d-secops r22 one
# path under a ROOT-OWNED PARENT, opened read-only, judged as a descriptor, and locked on that
# same descriptor. See the head of this file for what the old `exec 9>"$LOCK_FILE"` did.
#
# THE DESCRIPTOR NUMBERS ARE LITERALS, AND THEY HAVE TO BE. `exec` cannot take an fd from a
# variable without `eval`, and `eval` is refused by the lexical scanner these scripts are held to
# (tests/scripts/shell-symbol.ts): a definition or an assignment inside an `eval` string is
# invisible to every reading of the file, including bash's own deparse, so the count of what a
# name is bound to could only be guessed. Two literals, allocated once:
#
#   9  the canonical lock, ${CUTOVER_ROOT_DIR}/cutover.lock
#   8  the /var/lib/ims-deploy namespace deploy.sh used before the shared one — taken ONLY
#      where that directory is proved to be one no other account may write
#
#   6  the REPLACEMENT canonical lock, taken only where this run inherited a lock that had been
#      openable by another account and had therefore to be replaced rather than narrowed
#      (o3d-secops r24). 9 stays open on the retired inode for the rest of the run, deliberately:
#      see rotate_cutover_lock_inode().
#
# (6 held ${CUTOVER_STATE_DIR}/cutover.lock before r22, where the canonical lock used to live; r23
# gave it back — see THE BRIDGE r22 SHIPPED below — and r24 re-allocates it for the replacement.
# Nothing in this file opens a name inside a directory the service account can write.)
#
# (7 is the crontab reconciliation lock; see lib/crontab-lock.sh, which explains why it is not
# one of these and why none of these may be re-`exec`ed while a run is in flight.)
acquire_cutover_lock() {
  # INITIALISED, not merely declared: `local name` leaves the name UNSET, and every one of these
  # scripts runs under `set -u`, so a path that reached the gate below without passing through the
  # read would abort on an unbound variable instead of being told the mode is not private.
  local inherited_lock_mode=""
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_ROOT_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  prepare_cutover_lock_file "$LOCK_FILE" || die \
    "${LOCK_FILE} is not a regular file this run may lock. It lives in ${CUTOVER_ROOT_DIR}, which is root-owned and which no other account may write, so anything else at that name was put there by a privileged process. Refusing to run a cutover without the exclusion. Nothing has been stopped."
  # READ-ONLY. There is no O_CREAT and no O_TRUNC in this open, which is the finding: the file is
  # created above, once, with O_EXCL, and never written by anybody.
  exec 9<"$LOCK_FILE"
  verify_held_lock 9 "$LOCK_FILE" || die \
    "The descriptor this run opened on ${LOCK_FILE} is not that name's own inode, or is not a regular file owned by this run and unwritable by anyone else. Either something followed a link at that name or the name was replaced between the open and the check. Refusing to take a cutover lock on a file this run cannot identify. NOTHING HAS BEEN STOPPED and nothing has been migrated."
  # AND IT IS UNREADABLE BY ANYONE ELSE BEFORE IT IS LOCKED (o3d-secops r23, Codex HIGH). `flock`
  # needs no more than an open descriptor, so READ permission on this file is permission to take
  # this lock and hold it: at 0644 the service account could freeze every cutover on the box for
  # as long as it liked. Narrowed on the descriptor verify_held_lock() has just identified, and
  # proven off that same descriptor, BEFORE the exclusion is claimed.
  # AND WHAT IT WAS BEFORE THIS RUN TOUCHED IT (o3d-secops r24, Codex MEDIUM). Read off the same
  # descriptor, BEFORE the narrowing, because it is the only moment the answer still exists: a
  # mode of 0644 here means every account on the box could have opened this inode at any time up
  # to now, and `chmod` cannot reach a descriptor somebody is already holding. It decides whether
  # the inode is repaired or REPLACED — see rotate_cutover_lock_inode().
  inherited_lock_mode="$(held_lock_mode 9)"
  narrow_held_lock 9 || die \
    "${LOCK_FILE} could not be narrowed to 0600, so this run cannot show that the exclusion it is about to take is one only a privileged account can take. \`flock\` needs nothing but an open descriptor, and a lock file any account may open is a lock any account may hold — indefinitely, against every future deploy, update and install. Refusing to run a cutover on it. Nothing has been stopped."
  flock -n 9 || die "Another cutover (deploy.sh, update.sh or install.sh) holds ${LOCK_FILE}. Refusing to run two cutovers at once. If no cutover is running, something else is holding that descriptor — \`fuser -v ${LOCK_FILE}\` names it; a host upgraded from a checkout that left this file at 0644 could have had it opened by ${APP_USER} before this run narrowed it. NOTHING HAS BEEN ROTATED: the replacement below is reached only once this run holds that lock, so a predecessor's inode is never swapped out from under it."
  # A LOCK THAT WAS EVER OPENABLE BY ANOTHER ACCOUNT IS REPLACED RATHER THAN REPAIRED (o3d-secops
  # r24, Codex MEDIUM). The narrowing above closes the door to new opens and does nothing at all to
  # a descriptor the service account already holds from when this file was 0644 — permission is
  # checked at `open(2)`. Held here, after the exclusion is proved and while it is held, so that
  # the retiring inode is one nothing else can be locking. See rotate_cutover_lock_inode() for what
  # replacing an inode buys, what it gives up, and why a genuine concurrent cutover never loses.
  if ! lock_mode_is_private "${inherited_lock_mode}"; then
    rotate_cutover_lock_inode "$LOCK_FILE" || die \
      "${LOCK_FILE} was inherited at mode ${inherited_lock_mode:-unreadable} — openable, and therefore lockable, by accounts other than this one — and this run could not replace it with a fresh 0600 inode it holds. Narrowing it in place would not help: \`chmod\` cannot reach a descriptor ${APP_USER} opened while the file was wide, and that descriptor can block every future deploy, update and install on this box. Refusing to run a cutover behind an exclusion this run cannot show it owns. Nothing has been stopped."
  fi
  acquire_legacy_namespace_lock
  state_pre_r22_cutovers_are_not_excluded
  warn_pre_r22_db_fence_state
}

# WHETHER A DIRECTORY IS ONE ONLY THIS RUN MAY WRITE
#
#   dir_is_private_to_this_run <path>
#
# The precondition every continuity claim in this file now rests on, asked as a QUESTION instead
# of assumed. A lock taken on a name inside a directory somebody else may write proves nothing
# about who holds what: `unlink(2)` and `rename(2)` ask for write permission on the PARENT and ask
# nothing at all about the file, so the entry a predecessor locked can be moved out from under it
# and this run can be handed a fresh inode at the same name. Both processes then report an
# exclusion neither has.
#
# `stat` WITHOUT `-L`, so a symlink AT the directory reads as "symbolic link" and is refused
# rather than described by its target; `|| true` and a comparison against a positive literal, so a
# stat that could not run yields the empty string and the answer is "no".
dir_is_private_to_this_run() {
  local path="$1" meta kind owner mode
  meta="$(LC_ALL=C stat -c '%F|%u|%a' "${path}" 2>/dev/null || true)"
  IFS='|' read -r kind owner mode <<< "${meta}"
  [[ "${kind}" == "directory" ]] || return 1
  [[ -n "${owner}" && "${owner}" == "$(id -u)" ]] || return 1
  [[ -n "${mode}" ]] && (( (8#${mode} & 0022) == 0 )) || return 1
  return 0
}

# THE LOCK THE PREVIOUS deploy.sh NAMESPACE TOOK — CLAIMED ONLY WHERE THE CLAIM CAN BE MADE
#
# A cutover already running from the checkout that used /var/lib/ims-deploy holds
# ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock, and this run holds a different inode, so without this
# the two would migrate the same database while each reported exclusion.
#
# AND THE CLAIM IS CONDITIONAL ON ITS OWN PRECONDITION (o3d-secops r23, Codex CRITICAL). Taking
# that lock excludes a predecessor only if the entry cannot be moved between the predecessor's
# open and this one, which is a property of the DIRECTORY and of nothing else. Where the directory
# is one only this run may write, the exclusion is real and a conflict is fatal. Where it is not —
# including where it does not exist at all — no lock is taken, nothing is created at a name
# another account controls, and what is NOT excluded is said out loud. A bridge that reports a
# continuity it cannot establish is worse than no bridge, because it reads as covered.
acquire_legacy_namespace_lock() {
  [[ "${LEGACY_CUTOVER_STATE_DIR:-}" != "${CUTOVER_STATE_DIR}" ]] || return 0
  [[ -e "${LEGACY_CUTOVER_STATE_DIR:-}" || -L "${LEGACY_CUTOVER_STATE_DIR:-}" ]] || return 0
  if ! dir_is_private_to_this_run "${LEGACY_CUTOVER_STATE_DIR}"; then
    warn "${LEGACY_CUTOVER_STATE_DIR} is not a directory only this run may write, so a lock taken on a name inside it would prove nothing: the entry can be renamed between a predecessor's open and this one, and both runs would then report an exclusion neither holds. NOTHING WAS OPENED, LOCKED OR CREATED THERE. A cutover started from the checkout that used that namespace is NOT excluded by this run; two runs of THIS checkout still cannot overlap. Quiescing the other checkout is the operator's job — see docs/installation.md, 'Before a cutover: no other cutover'."
    return 0
  fi
  prepare_cutover_lock_file "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" || die \
    "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock is not a regular file this run may lock, so it cannot exclude a cutover started from a checkout that predates the shared namespace. Nothing has been stopped."
  exec 8<"${LEGACY_CUTOVER_STATE_DIR}/deploy.lock"
  verify_held_lock 8 "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" || die \
    "The descriptor this run opened on ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock is not that name's own inode, or is not a regular file owned by this run. Refusing to take a lock on a file this run cannot identify. Nothing has been stopped."
  narrow_held_lock 8 || die \
    "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock could not be narrowed to 0600, so an account other than this one could open it and hold the exclusion. Refusing to run a cutover on it. Nothing has been stopped."
  flock -n 8 || die "A cutover from a checkout that predates the shared namespace holds ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock. Refusing to run two cutovers at once."
  return 0
}

# ---------------------------------------------------------------------------
# THE BRIDGE r22 SHIPPED, AND WHY r23 DELETED IT INSTEAD OF REPAIRING IT
# (o3d-secops r23, Codex CRITICAL)
#
# r22 moved ${LOCK_FILE} out of ${CUTOVER_STATE_DIR}, and — because moving a lock is also a way to
# lose one — added acquire_pre_r22_cutover_lock(), which ALSO locked
# `${CUTOVER_STATE_DIR}/cutover.lock` so that a cutover already running from the previous checkout
# stayed excluded. The instinct was right and the bridge could not do what it claimed.
#
# THE ENTRY IS IN ${APP_USER}'S OWN DIRECTORY. A predecessor holds a lock on an INODE; the bridge
# opened a NAME. That account may rename or unlink the name while the inode stays locked and put a
# fresh regular file there, and every check the bridge made — lstat says regular file, the
# descriptor is that name's own inode — passes on the replacement. The run then reported an
# exclusion that had never been taken. The checks were not weak; the QUESTION was unanswerable,
# because a pathname somebody else controls is not evidence about who is running.
#
# THE TWO WAYS OUT, AND THE ONE TAKEN. Either ship a TRANSITIONAL PREDECESSOR that also takes the
# protected lock — which is honest and is not available from here, because a transitional release
# has to reach a host BEFORE the checkout that moves the lock, and every host that has a pre-r22
# checkout has it already — or REQUIRE OPERATOR-CONTROLLED QUIESCENCE and put the requirement
# where a human can satisfy it. This file takes the second, and does the one part of it that is
# code: acquire_legacy_namespace_lock() above still claims an exclusion where it can PROVE the
# precondition, and this says, unconditionally and on every run, exactly what is not excluded.
#
# UNCONDITIONALLY IS THE POINT. Keying this on whether `${CUTOVER_STATE_DIR}/cutover.lock` exists
# would be reading an absence as an answer at a name the service account controls — the same
# mistake one layer up. The limitation is a property of the RELOCATION and not of anything on the
# disk, so it is stated whenever a lock is taken, and it stops being true when no host on the
# fleet has a checkout that predates ${LOCK_FILE}.
state_pre_r22_cutovers_are_not_excluded() {
  warn "This run's exclusion is ${LOCK_FILE}, and it excludes every cutover that takes THAT lock. A cutover launched from a checkout that predates it locks a name under ${CUTOVER_STATE_DIR}, which ${APP_USER} may rename between that run's open and this one's, so NOTHING HERE CAN EXCLUDE IT and this run does not pretend to: no lock is taken at that name. Two concurrent cutovers migrate one schema twice. Before starting one, make sure no other checkout is running one — see docs/installation.md, 'Before a cutover: no other cutover'."
  return 0
}

# ---------------------------------------------------------------------------
# THE CONNECTION-FENCE RECORD THIS ROUND MOVED, AND WHY IT IS NAMED RATHER THAN IMPORTED
#
# ${DB_FENCE_STATE} moved from ${CUTOVER_STATE_DIR}/deploy/ to ${CUTOVER_ROOT_DIR}/db-fence/ with
# the directory it lives in. A record left at the OLD path by an interrupted pre-r22 run therefore
# will not be found by the code that releases a fence — and that is the safe half of the change,
# not a gap in it, because the run does not conclude "no fence" from its absence: `release_db_fence`
# asks the DATABASE whether the application role still has CONNECT, and a standing fence with no
# record is already a refusal that names exactly what a superuser must restore by hand.
#
# SO IT IS NOT IMPORTED. That file is in ${APP_USER}'s own directory and it lists the grantees a
# privileged run revoked CONNECT from; copying it into the new namespace would make root act on
# GRANT and REVOKE statements chosen by the account being defended against, which is the r22 HIGH
# with a different file in it. The presence of the name is reported — that is a fact about the
# name, which cannot be forged away — and its contents are left unread, exactly as
# import_relocated_fence_marker() leaves the old marker's.
#
# ONCE PER RUN, from acquire_cutover_lock(), which is the one thing every non-dry cutover does
# before it stops anything.
warn_pre_r22_db_fence_state() {
  [[ -n "${LEGACY_STATE_DIR_DB_FENCE_STATE:-}" ]] || return 0
  [[ "${LEGACY_STATE_DIR_DB_FENCE_STATE}" != "${DB_FENCE_STATE:-}" ]] || return 0
  [[ -e "${LEGACY_STATE_DIR_DB_FENCE_STATE}" || -L "${LEGACY_STATE_DIR_DB_FENCE_STATE}" ]] || return 0
  warn "There is an entry at ${LEGACY_STATE_DIR_DB_FENCE_STATE} — where the connection-fence record lived before the cutover namespace moved under ${CUTOVER_ROOT_DIR}."
  warn "IT HAS NOT BEEN READ AND IT WILL NOT BE: it names the grantees a fence revoked CONNECT from, it sits in ${APP_USER}'s own directory, and root does not take GRANT statements from there."
  warn "If a connection fence really is standing from an interrupted run of the previous checkout, this run finds out from the DATABASE and refuses with the grantees named; nothing is decided from that file either way."
  return 0
}

# THE SAME RULE, FOR THE /var/lib/ims-deploy NAMESPACE (o3d-secops r23, Codex CRITICAL)
#
# import_legacy_cutover_state() used to REPUBLISH ${LEGACY_DB_FENCE_STATE} at ${DB_FENCE_STATE}
# and chown the result to ${APP_USER}, so that "the fence script can release it". That is the
# finding written as a feature: the legacy record was written BY the fence helper, running as
# ${APP_USER}, so its contents are that account own -- and the import made root copy them into
# the file a later `--release` builds `GRANT CONNECT` out of. An adoption is not a laundering
# step; content does not become authoritative by being moved by a privileged process.
#
# So it is reported and left exactly where it is, which is what warn_pre_r22_db_fence_state()
# already does for the other legacy path and for the same reason. NOTHING IS LOST BY REFUSING:
# `release_db_connections` never concludes "no fence" from a missing record. It asks the DATABASE,
# and a standing fence with no record it may believe is already a refusal that names what a
# superuser has to restore by hand.
warn_legacy_namespace_db_fence_state() {
  [[ -n "${LEGACY_DB_FENCE_STATE:-}" ]] || return 0
  [[ "${LEGACY_DB_FENCE_STATE}" != "${DB_FENCE_STATE:-}" ]] || return 0
  [[ -e "${LEGACY_DB_FENCE_STATE}" || -L "${LEGACY_DB_FENCE_STATE}" ]] || return 0
  warn "There is an entry at ${LEGACY_DB_FENCE_STATE} — the connection-fence record of the namespace deploy.sh used before the shared one."
  warn "IT HAS NOT BEEN READ, COPIED OR IMPORTED, and it will not be: it was written by the fence helper running as ${APP_USER}, it lists the grantees a fence revoked CONNECT from, and root does not take GRANT statements out of a file that account authored. Earlier checkouts republished it into the shared namespace; that made root act on the application own choice of who gets database access."
  warn "If a fence really is standing from an interrupted run of that checkout, this run finds out from the DATABASE and refuses with the grantees named. Nothing is decided from that file either way; read it by hand if you need to know what the interrupted run took."
  return 0
}
