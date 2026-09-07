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
# ${FENCE_FILE}, which is the boot authority. The DB fence directory has to be WRITABLE by
# ${APP_USER} — the connection fence script runs as that account (`as_app_user … --state-file=`)
# — and a subdirectory nobody but root may TRAVERSE is not writable by anybody. Relaxing that
# directory to 0711 so a child could be reached would relax the one directory on the box that
# exists to be private, to give a lock file a home. So the app-facing half of the namespace gets
# its own root-owned parent at 0755 — the same shape ${DB_FENCE_RECOVERY_DIR} already has, and
# for the same reason — and /etc/ims-cutover is not touched by this round at all.
#
# WHAT LIVES WHERE, AFTER THIS ROUND:
#
#   /etc/ims-cutover              root:root 0700   the fence MARKER, the DB identity snapshot
#   /etc/ims-cutover-recovery     root:root 0755   the protected fence artefact and its wrappers
#   /etc/ims-cutover-state        root:root 0755   THIS ROUND: the shared cutover lock, and
#     ├── cutover.lock            root:root 0644     the app-writable connection-fence directory
#     └── db-fence/               app:app   0700
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
# NOTHING EVER WRITES THIS FILE. Its contents are meaningless; only its inode is the lock. 0644
# so that it is exactly what crontab-lock.sh's is and for the same stated reason — a lock nobody
# writes needs no write permission, and a mode nothing depends on is one nothing has to defend.
prepare_cutover_lock_file() {
  local path="$1" kind
  if [[ ! -e "${path}" ]]; then
    ( umask 022; set -C; : > "${path}" ) 2>/dev/null || true
  fi
  kind="$(LC_ALL=C stat -c '%F' "${path}" 2>/dev/null || true)"
  [[ "${kind}" == "regular file" || "${kind}" == "regular empty file" ]] || return 1
  chown -h "$(id -u):$(id -g)" "${path}" 2>/dev/null || true
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
  # AND THE APP-WRITABLE HALF, BENEATH IT. own_service_subdir() walks ${CUTOVER_ROOT_DIR} ->
  # ${DB_FENCE_DIR} one component at a time and applies the owner and the mode to the descriptor
  # it lands on, so neither `chown` nor `chmod` ever names a path a second time.
  own_service_subdir "$CUTOVER_ROOT_DIR" 077 "$DB_FENCE_DIR" "$APP_USER" 700
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
  # 0755: root-owned and traversable, so ${APP_USER} can reach ${DB_FENCE_DIR} beneath it and can
  # create, replace and unlink NOTHING in it. That is the whole protection — not the mode of the
  # lock file, which nothing reads, and not the mode of the fence directory, which is its own.
  if ! chmod 755 . || ! chown "$(id -u):$(id -g)" .; then
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
# name is bound to could only be guessed. Three literals, allocated once:
#
#   9  the canonical lock, ${CUTOVER_ROOT_DIR}/cutover.lock
#   8  the /var/lib/ims-deploy namespace deploy.sh used before the shared one
#   6  ${CUTOVER_STATE_DIR}/cutover.lock — where the canonical lock lived BEFORE r22
#
# (7 is the crontab reconciliation lock; see lib/crontab-lock.sh, which explains why it is not
# one of these and why none of these may be re-`exec`ed while a run is in flight.)
acquire_cutover_lock() {
  ensure_cutover_state_dirs || die "Could not create ${CUTOVER_ROOT_DIR}; the cutover namespace is unusable. Nothing has been stopped."
  prepare_cutover_lock_file "$LOCK_FILE" || die \
    "${LOCK_FILE} is not a regular file this run may lock. It lives in ${CUTOVER_ROOT_DIR}, which is root-owned and which no other account may write, so anything else at that name was put there by a privileged process. Refusing to run a cutover without the exclusion. Nothing has been stopped."
  # READ-ONLY. There is no O_CREAT and no O_TRUNC in this open, which is the finding: the file is
  # created above, once, with O_EXCL, and never written by anybody.
  exec 9<"$LOCK_FILE"
  verify_held_lock 9 "$LOCK_FILE" || die \
    "The descriptor this run opened on ${LOCK_FILE} is not that name's own inode, or is not a regular file owned by this run and unwritable by anyone else. Either something followed a link at that name or the name was replaced between the open and the check. Refusing to take a cutover lock on a file this run cannot identify. NOTHING HAS BEEN STOPPED and nothing has been migrated."
  flock -n 9 || die "Another cutover (deploy.sh, update.sh or install.sh) holds ${LOCK_FILE}. Refusing to run two cutovers at once."
  # AND the lock the previous version of deploy.sh took, so a cutover started from a checkout
  # that predates the shared namespace is still excluded. Only when that directory already
  # exists: creating it would be re-creating the namespace this round retired.
  if [[ -d "$LEGACY_CUTOVER_STATE_DIR" ]]; then
    prepare_cutover_lock_file "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" || die \
      "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock is not a regular file this run may lock, so it cannot exclude a cutover started from a checkout that predates the shared namespace. Nothing has been stopped."
    exec 8<"${LEGACY_CUTOVER_STATE_DIR}/deploy.lock"
    verify_held_lock 8 "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" || die \
      "The descriptor this run opened on ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock is not that name's own inode, or is not a regular file owned by this run. Refusing to take a lock on a file this run cannot identify. Nothing has been stopped."
    flock -n 8 || die "A cutover from a checkout that predates the shared namespace holds ${LEGACY_CUTOVER_STATE_DIR}/deploy.lock. Refusing to run two cutovers at once."
  fi
  acquire_pre_r22_cutover_lock
  warn_pre_r22_db_fence_state
}

# THE LOCK THIS ROUND MOVED, STILL TAKEN — AND WHY IT IS THE ONE CASE THAT DOES NOT DIE.
#
# Moving ${LOCK_FILE} out of ${CUTOVER_STATE_DIR} is the fix, and on its own it would also be a
# REGRESSION of the thing the lock is for: a cutover already running from the PREVIOUS checkout
# holds `${CUTOVER_STATE_DIR}/cutover.lock`, this run would hold a different inode, and both would
# report exclusion while migrating the same database. So the old name is locked as well, for
# exactly as long as a host can still have a pre-r22 checkout on it.
#
# AND THIS ONE IS IN ${APP_USER}'S OWN DIRECTORY, WHICH IS WHY IT IS OPENED THE WAY IT IS AND WHY
# A REFUSAL HERE IS A WARNING RATHER THAN A DEATH:
#
#   • IT IS NEVER CREATED. A missing name means no predecessor holds anything, and creating a
#     file as root at a name that account controls is the entire finding — reintroducing it to
#     take a compatibility lock would be trading the fix for the thing it fixed.
#   • IT IS OPENED READ-ONLY and the descriptor is required to be the NAME'S OWN INODE, so a
#     symlink there is refused by the same proof as above and nothing is ever followed.
#   • OWNERSHIP IS NOT REQUIRED, deliberately. A read-only descriptor on somebody else's regular
#     file is inert — there is nothing to truncate, nothing to write and nothing to hand over —
#     and requiring root ownership would mean a pre-planted file made this run SKIP an exclusion
#     that a genuine predecessor might be holding on that same inode.
#   • AND A FAILURE IS NOT FATAL, because the alternative is worse. Dying here would let
#     ${APP_USER} stop every future cutover by leaving a symlink at a name it owns — a permanent,
#     unattended outage, caused by the compatibility path for a checkout that will not exist in a
#     month. What is lost when it is skipped is stated out loud rather than swallowed: the
#     canonical lock above is held, so two runs of THIS checkout still cannot overlap.
acquire_pre_r22_cutover_lock() {
  local legacy="${CUTOVER_STATE_DIR}/cutover.lock" kind
  [[ "${legacy}" != "${LOCK_FILE}" ]] || return 0
  [[ -e "${legacy}" || -L "${legacy}" ]] || return 0
  # THE TYPE IS ASKED FIRST, WITH AN lstat, AND IT IS ASKED FOR TWO REASONS. It refuses a link
  # before anything opens the name — `stat -c %F` reports "symbolic link" where `-L`, deliberately
  # not used, would report the target's type — and it keeps the `exec` below from being the thing
  # that discovers a bad name. `exec` REDIRECTIONS ARE PERMANENT: `exec 6<x 2>/dev/null` would
  # send this script's stderr to /dev/null for the rest of the run, so the open cannot be quieted
  # and must simply not be aimed at something that fails.
  kind="$(LC_ALL=C stat -c '%F' "${legacy}" 2>/dev/null || true)"
  if [[ "${kind}" != "regular file" && "${kind}" != "regular empty file" ]]; then
    warn "${legacy} is a ${kind:-missing path} and not a regular file, so it is NOT what a predecessor cutover would have locked. Nothing was followed and nothing was written. A cutover from a checkout that predates ${LOCK_FILE} is not excluded by this run; two runs of THIS checkout still cannot overlap."
    return 0
  fi
  if ! exec 6<"${legacy}"; then
    warn "${legacy} could not be opened, so a cutover started from a checkout that predates ${LOCK_FILE} is not excluded by this run. Two runs of THIS checkout still cannot overlap."
    return 0
  fi
  # AND THE DESCRIPTOR IS THAT NAME'S OWN INODE, which is the check the lstat above cannot make:
  # the lstat is a question about a name and the open is another one, and the account that owns
  # this directory is free to swap the name between them. verify_held_lock() would ALSO require
  # the file to be owned by this run, which is the one property that must not be required here, so
  # the inode identity is asked directly.
  if [[ "$(LC_ALL=C stat -c '%d:%i' "${legacy}" 2>/dev/null || true)" \
     != "$(LC_ALL=C stat -L -c '%d:%i' /proc/self/fd/6 2>/dev/null || true)" ]]; then
    exec 6<&-
    warn "${legacy} was replaced while this run was opening it, so the descriptor it holds is not that name's own inode. Nothing was followed and nothing was written. A cutover from a checkout that predates ${LOCK_FILE} is not excluded by this run; two runs of THIS checkout still cannot overlap."
    return 0
  fi
  flock -n 6 || die "A cutover from a checkout that predates ${LOCK_FILE} holds ${legacy}. Refusing to run two cutovers at once."
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
