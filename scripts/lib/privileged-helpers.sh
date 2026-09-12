# shellcheck shell=bash
# =============================================================================
# THE BYTES A PRIVILEGED RUN MAY EXECUTE AFTER IT HAS STARTED — ONE ROOT-OWNED
# SNAPSHOT, ONE DIGEST, THREE READERS
# =============================================================================
# o3d-kyqa / o3d-z5be. Sourced by scripts/install.sh, scripts/deploy.sh and scripts/update.sh,
# AFTER lib/db-fence-protected.sh, whose publication primitives this file reuses rather than
# restates.
#
# THE PROPERTY, STATED ONCE SO EVERY READER BELOW IS ABOUT THE SAME THING:
#
#   NO PRIVILEGED RUN MAY EXECUTE BYTES THAT AN UNPRIVILEGED ACCOUNT COULD HAVE CHANGED AFTER
#   THE RUN BEGAN.
#
# THE FINDING IT CLOSES. install.sh resolved two node helpers out of ${IMS_SCRIPT_LIB_DIR} — its
# own checkout — and ran them AS ROOT at points minutes into the run: the ownership walk in
# section 9, and the authentication-request reader inside the database gates. In the documented
# deployment that checkout belongs to ${APP_USER}: install.sh and update.sh both `chown -R` the
# application directory to the service account, and docs/installation.md's update command was
# typed from inside it. So root read those bytes AFTER a build, a stop, a drain and a re-handing
# of the tree to that very account.
#
# WHY THE `source`s AT THE TOP OF THE ENTRYPOINTS ARE NOT THE SAME THING, since a reader will
# reach for them as the counter-example. They are read AT STARTUP, in the same instant as the
# entrypoint's own body and out of the same tree, so they add NO WINDOW THE OPERATOR DID NOT
# ALREADY ACCEPT when they typed the command. A helper read LATER is a different statement, and
# the distinction is this repository's own — it is the entire reason the connection fence keeps a
# protected root-owned copy with a digest supplied on the privileged invocation.
#
# WHY "PIN THE HELPER AT STARTUP" IS NOT THE ANSWER EITHER. An already-verified descriptor
# alongside the entrypoint moves the boundary instead of establishing one: the pin would be
# computed by a script that was itself read from the same checkout. scripts/lib/pin-source-file.mjs
# existed to authenticate exactly such bytes and was deleted in o3d-secops r22 because it
# "authenticated bytes that cannot be authenticated", with a guard in
# tests/scripts/deploy-order.test.ts that fails if it comes back. Nothing here brings it back.
#
# WHAT THIS FILE DOES INSTEAD, AND WHY IT IS THE SAME MECHANISM THE FENCE USES. At startup — in
# that same accepted instant — a privileged run COPIES the whole of its own scripts/lib into a
# ROOT-OWNED directory nothing but root may write, seals it (root-owned, no group or other write,
# regular files and directories only), takes the whole-tree digest with the recipe
# ${DB_FENCE_ARTEFACT_RECIPE} the fence already publishes, and records that digest BOTH on disk
# beside the tree AND in this shell, where it is made `readonly`. Every late execution then
# resolves its helper through privileged_helper_path(), which re-seals and re-digests the tree and
# compares it against the value THIS RUN published before it hands back a path.
#
# THAT IN-MEMORY DIGEST IS THE PART A SECOND ON-DISK RECORD COULD NOT DO. Two privileged runs can
# overlap (the shared cutover lock is taken later than this), and the swap below is atomic — so
# without it a run could verify a tree ANOTHER run had just published and execute its bytes. With
# it, a republication by anybody is a REFUSAL in every run that did not perform it. `readonly`
# is what makes that unspoofable from inside the run: nothing later in the script can restate it.
#
# AND THAT SENTENCE WAS ONLY TRUE ONCE THE STAGING NAMES BECAME PER-RUN (o3d-z5be r2, Codex HIGH).
# Every publication of a given kind used to assemble at ONE fixed name beside its target —
# `${target}.staged` — and remove whatever was there first. So a second run could empty and refill
# the FIRST run's staging tree in the interval between the first run assembling it and the first run
# HASHING it, after which the first run hashed, renamed and recorded the second run's bytes AS ITS
# OWN: its readonly digest matched, privileged_helper_path() accepted them, and the substitution the
# paragraph above calls a refusal was an UNDETECTED SWAP. Each publication now assembles inside its
# own `mktemp -d` directory under the root, so two overlapping runs share no object but the FINAL
# name — where the rename is atomic and the loser is refused by the digest it holds.
#
# WHY THE PUBLICATION IS STILL NOT UNDER THE SHARED CUTOVER LOCK, since that is the other way to
# serialise it and the reviewer is right that its absence is what made the race reachable. Three
# reasons, and the first is decisive: this publication exists so that NOTHING root executes after
# startup comes out of the checkout, and acquiring the cutover lock is itself work a run does before
# it holds any lock — moving the snapshot after it would put root-side code before the snapshot that
# is supposed to cover root-side code. Second, the lock does not span the population: `--dry-run` and
# `--print-fence-digest` publish nothing and take no lock, install.sh takes it at a different point
# on a fresh box, and a publication that is only safe while a lock is held would be unsafe in exactly
# the runs that do not hold one. Third, and the reason this is not a trade: with per-run staging the
# isolation is STRUCTURAL — there is no shared object left to race over — while a lock would make it
# a property of scheduling, and the in-memory digest would still be needed for the unlocked runs. A
# lock is how you serialise writers to one object; the fix here was to stop sharing the object.
#
# WHAT THIS DOES NOT CLAIM, STATED HERE RATHER THAN DISCOVERED LATER. It does not authenticate the
# CHECKOUT. An account that can write ${APP_DIR}/scripts before a run starts can still choose what
# the operator launches — it can replace the entrypoint itself, which is a window this repository
# has always accepted and docs/installation.md names. What is gone is the LATE window: the bytes
# root executes at minute twenty are the bytes that were on disk at minute zero, and nothing but
# root can have touched them in between. Provenance, where an operator wants it, is
# ${IMS_HELPER_SET_SHA256} on the privileged invocation — the same shape, the same refusal and the
# same source of trust (outside the checkout, from the operator) as IMS_FENCE_ARTEFACT_SHA256.
#
# AND THE SNAPSHOT'S "IMMUTABILITY AFTER START" IS NOT PROVENANCE — WHICH IS WHY THE DRIVER BELOW IS
# HELD TO A STRICTER RULE THAN THIS SNAPSHOT IS (o3d-z5be r2, Codex HIGH). The snapshot is executed
# by THIS run, whose bytes the operator accepted when they typed the command; an optional pin is
# therefore enough to add provenance for an operator who wants it. The driver is executed by runs
# whose operator has accepted NOTHING yet, so publishing unvouched bytes into it does not merely fail
# to authenticate a checkout — it converts one operator's one-time decision into a standing
# arrangement in which root executes bytes ${APP_USER} chose. That is the asymmetry, and it is the
# whole reason the two publications no longer take the same permission.
#
# AND WHY THERE IS NO DEPENDENCY CLOSURE HERE, since the fence artefact has one and a reader will
# ask. The fence helper imports `pg`, so publishing it means vendoring a ~140-file closure out of the
# checkout's node_modules and hashing that too. The helpers this file publishes import NOTHING but
# node: builtins — chown-tree.mjs takes `node:fs`, pg-auth-request.mjs takes `node:buffer`,
# `node:net`, `node:process`, `node:fs` and `node:tls` — so a flat copy of scripts/lib IS the whole
# executable surface, and `node /etc/ims-cutover-driver/helpers/x.mjs` needs no node_modules above it
# to resolve against. That is a property of the shipped helpers and not an assumption about them:
# tests/scripts/privileged-helper-set.test.ts asserts it, so a helper that grows a third-party import
# fails the suite rather than the cutover. (scripts/lib also holds ts-import-aliases.mjs, a developer
# tool that imports `typescript`. It is copied, because the publication takes the directory WHOLE —
# which is what keeps a helper added tomorrow inside the digest without anybody extending a list — and
# it is never executed from here, so its import is not this file's problem.)
#
# AND WHERE THE DRIVER ITSELF LIVES (o3d-z5be). The same publication, applied to the three
# entrypoints and their library, gives a root-owned copy of the deployment driver:
# ${IMS_DRIVER_PROGRAM_DIR}. docs/installation.md's update command is that copy, so on the
# documented path even the startup `source`s are read out of a tree ${APP_USER} cannot write, and
# the residual above narrows to "whatever install.sh was run from".
#
# BUT ONLY BYTES SOMETHING OUTSIDE ${APP_USER}'s CONTROL VOUCHED FOR MAY ENTER IT (o3d-z5be r2,
# Codex HIGH). This is the finding that made this round: the driver was refreshed at the END of a
# successful update from ${APP_DIR}/scripts — an account-owned tree, read after the fetch, the build,
# the migration and the health check. ${APP_USER} could replace update.sh there AFTER every check
# this run makes and BEFORE the copy, root then copied those bytes into ${IMS_DRIVER_PROGRAM_DIR}
# with no external digest, and the NEXT documented `sudo bash ${IMS_DRIVER_PROGRAM_DIR}/update.sh`
# executed them as root. Root ownership and the one-release lag did not remove the escalation; they
# postponed it by one release. The publication was itself a late read of application-owned bytes —
# exactly what this file exists to forbid.
#
# SO THE DRIVER PUBLICATION ASKS WHAT VOUCHES, AND REFUSES WHEN THE ANSWER IS "NOTHING". The rule is
# the one this repository already arrived at for the fence artefact (o3d-2sm1.5 r33/r34, Codex
# CRITICAL twice), applied to the tree it had never been applied to:
#
#   * a source only the publishing account can write VOUCHES FOR ITSELF — the tree, its lib, the
#     three entrypoints, every file in lib and every directory from the source's parent up to `/`
#     are owned by root (or by the publishing account) and not writable by group or other, and the
#     objects are the SAME objects after the copy as before it. Nothing unprivileged could have
#     chosen those bytes, so nothing has to vouch for them from outside;
#   * otherwise the operator vouches, out of band, with ${IMS_DRIVER_SHA256} on the privileged
#     invocation: the assembled tree must hash to that value or NOTHING is published;
#   * otherwise NOTHING IS PUBLISHED and the previous root-owned driver stands. The run says so,
#     names both ways out, and carries on — a driver that is one release old is a supported state,
#     and refusing the whole deployment over it would be a refusal for something a refusal cannot fix.
#
# WHAT THAT MEANS ON THE DOCUMENTED DEPLOYMENT, SAID PLAINLY RATHER THAN IMPLIED. ${APP_DIR} is
# chowned to ${APP_USER} by both install.sh and update.sh, so the end-of-update refresh publishes
# ONLY when the operator supplies ${IMS_DRIVER_SHA256}. There is no in-band mechanism that could
# close this: every byte in that tree arrived through an account that owns it, and no digest this box
# computes from it is evidence about anything — it is what the tree under question says about itself.
# The out-of-band digest IS the path, and docs/installation.md documents it as the path. The other
# way out needs no digest: install the release tree as root, take group and other write off it, and
# run install.sh from there — then the source vouches for itself and the question does not arise.
# install.sh publishes it from the release it is installing; update.sh refreshes it at the END of a
# successful run from the release it has just deployed, so the copy tracks what is deployed rather
# than freezing at install time — when something vouched for that release.
#
# WHY /etc AND NOT /usr/local/lib. z5be proposed /usr/local/lib/one-two-inventory. On Debian and
# Ubuntu /usr/local/lib ships `root:staff 2775` — group-writable — so a tree beneath it is
# writable by every member of `staff` and the seal check below would REFUSE it on a stock host,
# turning a security fix into an installer that does not run. /etc is root:root 0755 on every host
# these scripts support, and this repository already keeps its root-owned executable artefacts
# there: /etc/ims-cutover-recovery holds the protected fence artefact and the operator wrappers.
# So this is the established location as well as the established mechanism. The ancestry is still
# CHECKED rather than assumed, and a host whose /etc is group-writable is told which component is
# wrong instead of being published into.
# -----------------------------------------------------------------------------

# THE ONE LITERAL. Every path below is composed from it BY THIS FILE, so the harnesses can
# substitute this single line in the shipped text before sourcing it and exercise the real
# functions against a scratch root — the technique tests/scripts/fence-artefact-harness.ts already
# uses for ${DB_FENCE_RECOVERY_DIR}. It is deliberately NOT settable from the environment: a root
# an unprivileged caller could choose is not a root.
readonly IMS_DRIVER_ROOT="/etc/ims-cutover-driver"

# THE RUN SNAPSHOT: this run's scripts/lib, and the record that says what it hashes to. The record
# lives BESIDE the tree and not inside it, because a record inside the tree would be part of its
# own digest.
readonly IMS_DRIVER_HELPER_DIR="${IMS_DRIVER_ROOT}/helpers"
readonly IMS_DRIVER_HELPER_RECORD="${IMS_DRIVER_ROOT}/helper-set.sha256"
readonly IMS_DRIVER_HELPER_MANIFEST="${IMS_DRIVER_ROOT}/helper-set.manifest"

# THE INSTALLED DRIVER: the three entrypoints and their library, root-owned, and the record for it.
readonly IMS_DRIVER_PROGRAM_DIR="${IMS_DRIVER_ROOT}/driver"
readonly IMS_DRIVER_PROGRAM_RECORD="${IMS_DRIVER_ROOT}/driver.sha256"
readonly IMS_DRIVER_PROGRAM_MANIFEST="${IMS_DRIVER_ROOT}/driver.manifest"

# THE DEPLOYMENT METADATA (o3d-z5be). Root-owned and 0600: update.sh reads GIT_REPO_URL,
# GIT_BRANCH and GIT_DEPLOY_KEY_ENABLED out of it AS ROOT, at startup, as DATA through
# env_file_value() and never by sourcing it — and the re-clone source of a production update
# stops being a value the application account chooses.
readonly IMS_DRIVER_DEPLOY_META="${IMS_DRIVER_ROOT}/deploy-meta"

# WHERE A PUBLICATION IS ASSEMBLED: A DIRECTORY THIS CALL CREATED, WHOSE NAME NO OTHER RUN KNOWS
# (o3d-z5be r2, Codex HIGH). It was two FIXED names beside the target, `${target}.staged` and
# `${target}.retired`, and the header records what that cost. Both now live inside one `mktemp -d`
# directory per publication: the kernel creates it atomically under a root the ancestry check has
# already cleared, the name carries the kind and this shell's pid so an operator reading `/etc` can
# tell what it was, and everything in it is removed on every exit path. The previous tree is still
# moved aside rather than deleted, so a failed swap leaves the OLD tree standing rather than none.
readonly IMS_DRIVER_PUBLISH_PREFIX=".publish-"

# The three files that ARE the driver. Enumerated, because "every .sh beside install.sh" would
# publish the development helpers as well and the digest is a statement about what root may run.
readonly IMS_DRIVER_ENTRYPOINTS=(install.sh update.sh deploy.sh)

# THE EXPECTED DIGEST, FROM THE ROOT INVOCATION AND FROM NOWHERE ELSE. Never read out of the
# checkout and never out of ${APP_DIR}/.env — both are writable by the account this protects
# against, and a digest that source can set authenticates nothing. Optional, for the reason the
# header gives: the snapshot's job is immutability-after-start, which needs no operator input;
# this is how an operator who wants provenance as well gets it.
readonly IMS_DRIVER_EXPECTED_SHA256="${IMS_HELPER_SET_SHA256:-}"

# THE SAME, FOR THE DRIVER — and here it is what makes a publication POSSIBLE rather than merely
# authenticated (o3d-z5be r2). ${IMS_DRIVER_SHA256} on the privileged invocation is how an operator
# vouches for a release whose tree this box cannot vouch for: without it, a source ${APP_USER} can
# write publishes nothing at all. Read from the root invocation and from nowhere else, for the same
# reason as above — a digest the protected-against account can set authenticates nothing.
readonly IMS_DRIVER_PROGRAM_EXPECTED_SHA256="${IMS_DRIVER_SHA256:-}"

# WHAT THIS RUN PUBLISHED, IN THIS SHELL. Empty until publish_privileged_helper_set() succeeds, and
# `readonly` from that instant. It cannot carry `readonly` here: it is computed per run.
IMS_DRIVER_HELPER_SHA256=""

# Why nothing was published, or why a path was refused. Printed by the caller; empty when there is
# nothing to say. A report, and it reaches no sink: emptying it changes no decision anywhere.
IMS_DRIVER_REASON=""

# THE SAME, KEPT FOR THE REST OF THE RUN. ${IMS_DRIVER_REASON} is cleared by every function that
# uses it, so the sentence explaining why NOTHING WAS PUBLISHED would be gone by the time a refusal
# minutes later needs to quote it. This one is written once, by the startup publication, and read by
# privileged_helper_path().
IMS_DRIVER_PUBLISH_NOTE=""

# WHICH scripts/ DIRECTORY THE DRIVER IS PUBLISHED FROM. Set by publish_privileged_driver() from its
# own argument, and read by driver_fill_program() — which driver_publish_tree() calls with only the
# staging path, because the staging path is the only thing the two fillers have in common. install.sh
# publishes from the release it is installing; update.sh publishes from the release it has just
# deployed, which is a different directory and the reason this is a parameter at all.
IMS_DRIVER_FILL_SOURCE=""

# THE DIGEST THE LAST PUBLICATION TOOK, HANDED BACK IN A VARIABLE AND NOT ON STDOUT (the lesson
# _fence_vendor_closure() records above itself in lib/db-fence-protected.sh). A caller reading it
# through `$(...)` would run the publication in a SUBSHELL, and ${IMS_DRIVER_REASON} set inside one
# dies with it — which is how the first version of this reported "could not be published" and
# swallowed the reason.
IMS_DRIVER_PUBLISHED_DIGEST=""

# ---------------------------------------------------------------------------
# REFUSING WHERE THE CALLER CANNOT HEAR A VARIABLE
# ---------------------------------------------------------------------------

# EVERY REFUSAL GOES TO STDERR AS WELL AS INTO ${IMS_DRIVER_REASON}, because the callers that matter
# read this file's answers through a COMMAND SUBSTITUTION — `helper="$(privileged_helper_path …)"` —
# and a variable assigned inside one dies with the subshell. The first version of this library set
# the variable only, and every refusal reached the operator as "the reason is: " with nothing after
# the colon. lib/db-fence-protected.sh's db_fence_script_in_use() reached the same conclusion and
# `echo … >&2`s; this is that, named once so no refusal below can forget it.
#
# `|| return 1` at every call site: this returns 1, and a bare non-zero statement inside a function
# body under `set -e` would abort the SOURCING script rather than return from the function.
driver_refuse() {
  IMS_DRIVER_REASON="$1"
  echo "$1" >&2
  return 1
}

# ---------------------------------------------------------------------------
# THE ROOT
# ---------------------------------------------------------------------------

# IS EVERY COMPONENT ABOVE THE ROOT ONE ONLY ROOT COULD HAVE WRITTEN?
#
# A root-owned directory under a group-writable parent is a root-owned directory somebody else can
# RENAME OUT OF THE WAY and replace, and the seal check cannot see that: it inspects the tree it is
# given, after the name has already been resolved. So the ancestry is asked first, from the root's
# parent up to `/`, and a component that fails is NAMED — "the ancestry is wrong" is not something an
# operator can act on.
#
# THE POLICY IS THE ONE publish_root_anchored() ALREADY ESTABLISHED IN THE ENTRYPOINTS, restated here
# because that function is defined in the three entrypoints and this file is a library they source:
#
#   * a component must be owned by ROOT or by THE ACCOUNT DOING THE PUBLISHING, and must not be
#     writable by group or other. In production the publishing account IS root and the two halves are
#     one statement; the disjunction is what lets the test suite exercise this function for real under
#     a scratch root instead of measuring a re-implementation.
#   * the STICKY BIT is credited on an ANCESTOR and never on the parent, which is the distinction
#     o3d-rn10 arrived at: `/tmp` is `1777`, and sticky means an entry can be renamed only by its own
#     owner — so a sticky ancestor cannot be used to move a directory this account owns, while a
#     sticky PARENT still lets anybody CREATE the name in the first place.
driver_root_ancestry_is_private() {
  local dir="$1" uid meta kind owner mode parent=1
  IMS_DRIVER_REASON=""
  uid="$(id -u)" || return 1
  dir="$(dirname "${dir}")"
  while :; do
    meta="$(LC_ALL=C stat -c '%F|%u|%a' "${dir}" 2>/dev/null)" || {
      driver_refuse "${dir} could not be inspected, so this run cannot say whether the directory it is about to publish a root-owned tree into can be renamed by somebody else" || return 1
    }
    IFS='|' read -r kind owner mode <<< "${meta}"
    if [[ "${kind}" != "directory" ]]; then
      driver_refuse "${dir} is a ${kind} and not a directory, so ${IMS_DRIVER_ROOT} does not lie under a chain of real directories and the tree published there could be redirected" || return 1
    fi
    if [[ "${owner}" != "0" && "${owner}" != "${uid}" ]]; then
      driver_refuse "${dir} is owned by uid ${owner}, which is neither root nor the account running this publication (uid ${uid}), so that account can replace ${IMS_DRIVER_ROOT} wholesale and everything root runs out of it. Nothing has been published" || return 1
    fi
    if (( (8#${mode:-777} & 0022) != 0 )); then
      # THE STICKY CREDIT, AND ONLY ABOVE THE PARENT. A sticky directory lets anybody create names in
      # it and lets nobody but an entry's owner rename or unlink it, so it cannot be used to move an
      # ancestor of ours — but at the PARENT it would still let another account win the race to
      # create ${IMS_DRIVER_ROOT} before this run does.
      if (( parent == 1 )) || (( (8#${mode:-777} & 01000) == 0 )); then
        driver_refuse "${dir} has mode ${mode} — writable by group or other, and $( (( parent == 1 )) && printf 'it is the immediate parent, where the sticky bit would still let another account create that name first' || printf 'it is not sticky, so another account can rename it' ) — so an account other than this one can replace ${IMS_DRIVER_ROOT} and everything root runs out of it. Take group and other write off it (chmod g-w,o-w ${dir}) and re-run; nothing has been published" || return 1
      fi
    fi
    parent=0
    [[ "${dir}" != "/" ]] || break
    dir="$(dirname "${dir}")"
  done
  return 0
}

# The root itself: created, taken, and the result read back OFF THE DESCRIPTOR rather than by
# re-asking for the pathname. Same shape as ensure_cutover_root_dir() in lib/cutover-namespace.sh,
# with the one difference this root needs — mode 0755, because the driver is code every account may
# READ and none but root may write, where the cutover root is 0711 precisely so it cannot be
# enumerated.
driver_root_ready() {
  local saved meta kind owner mode
  IMS_DRIVER_REASON=""
  driver_root_ancestry_is_private "${IMS_DRIVER_ROOT}" || return 1
  if [[ -L "${IMS_DRIVER_ROOT}" ]]; then
    driver_refuse "${IMS_DRIVER_ROOT} is a symbolic link. Only root can have created it there, so this is not a state the application account can have produced; it is not followed and nothing has been published" || return 1
  fi
  mkdir -p "${IMS_DRIVER_ROOT}" || {
    driver_refuse "${IMS_DRIVER_ROOT} could not be created" || return 1
  }
  saved="$(pwd -P)" || return 1
  cd -P "${IMS_DRIVER_ROOT}" 2>/dev/null || {
    driver_refuse "${IMS_DRIVER_ROOT} could not be entered" || return 1
  }
  if ! chmod 755 . || ! chown "$(id -u):$(id -g)" .; then
    cd "${saved}" >/dev/null 2>&1 || true
    driver_refuse "the owner and mode of ${IMS_DRIVER_ROOT} could not be set" || return 1
  fi
  meta="$(LC_ALL=C stat -c '%F|%u|%a' . 2>/dev/null || true)"
  IFS='|' read -r kind owner mode <<< "${meta}"
  cd "${saved}" || return 1
  if [[ "${kind}" != "directory" ]] || [[ "${owner}" != "$(id -u)" ]] || (( (8#${mode:-777} & 0022) != 0 )); then
    driver_refuse "${IMS_DRIVER_ROOT} is ${kind:-unreadable}, owned by uid ${owner:-unknown}, mode ${mode:-unknown}: it is not a directory this run owns outright, and it is REFUSED rather than corrected — a second chmod would be the same unasked question" || return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# THE COPY
# ---------------------------------------------------------------------------

# ONE DIRECTORY LEVEL OF REGULAR FILES, COPIED BY CONTENT AND NOTHING ELSE.
#
# `cp -a` would preserve the SOURCE's ownership and mode, which is the ownership this whole
# mechanism exists to leave behind; `cp -R` follows symbolic links. So each file is read through a
# plain redirection into a file this call created.
#
# AND ANYTHING IN THE SOURCE THAT IS NOT A REGULAR FILE IS A REFUSAL RATHER THAN A SKIP. Two reasons,
# and they are different findings:
#
#   * a symbolic link, device, fifo or socket is not hashed by the tree manifest (which covers regular
#     files) and IS followed by node, so copying one would publish executable surface the digest does
#     not describe — the substitution this mechanism exists to close, re-entering by the back door;
#   * a SUBDIRECTORY would be skipped silently by the one-level walk below while the DOCUMENTED digest
#     recipe — `find . -type f`, which has no maxdepth — would hash its contents. The two would then
#     disagree, so an operator's pin could never match and the refusal would name no cause.
#     scripts/lib is flat, and a directory appearing in it is a decision somebody has to make about
#     both halves rather than a shape this call quietly drops.
driver_copy_regular_files() {
  local src="$1" dst="$2" offender name copied
  IMS_DRIVER_REASON=""
  [[ -d "${src}" ]] || {
    driver_refuse "${src} is not a directory, so there is nothing to publish from it" || return 1
  }
  offender="$(find "${src}" -mindepth 1 -maxdepth 1 ! -type f -print -quit 2>/dev/null)" || return 1
  if [[ -n "${offender}" ]]; then
    driver_refuse "${offender} is not a regular file. Only regular files are published from ${src}: a symbolic link, device or socket would be executable surface the published digest does not cover, and a subdirectory would be skipped by the copy while the documented digest recipe hashed it. Nothing has been published" || return 1
  fi
  mkdir -p "${dst}" || return 1
  copied=0
  while IFS= read -r -d '' name; do
    cat < "${src}/${name}" > "${dst}/${name}" || return 1
    copied=$(( copied + 1 ))
  done < <(cd "${src}" 2>/dev/null && find . -mindepth 1 -maxdepth 1 -type f -printf '%P\0' 2>/dev/null | LC_ALL=C sort -z)
  # A WALK THAT REACHED NOTHING IS NOT A PUBLICATION OF NOTHING. `cd` inside a process substitution
  # cannot fail this run, and a `find` that printed no names would leave an EMPTY tree that seals
  # cleanly, digests cleanly and has no helper in it — a refusal at the point of use, minutes later,
  # instead of here.
  if (( copied == 0 )); then
    driver_refuse "${src} holds no regular files, so there is nothing to publish from it and nothing was published" || return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# WHAT VOUCHES FOR THE BYTES THAT ENTER THE ROOT-OWNED DRIVER (o3d-z5be r2)
# ---------------------------------------------------------------------------

# THE PATH LISTS, DERIVED ONCE AND ASKED TWO DIFFERENT QUESTIONS — the shape lib/db-fence-protected.sh
# arrived at for the same question about the fence artefact, and for the same reasons:
#
#   _DRIVER_SRC_DIRS     the source scripts directory itself, at depth 0. What matters about it is
#                        whether somebody else can swap what is IN it.
#   _DRIVER_SRC_FILES    the three entrypoints, at depth 0. A file mode 0664 owned by the service
#                        account inside a root-owned directory is writable BY THAT ACCOUNT: write
#                        permission on an existing file belongs to the file, not to its directory,
#                        which is why the directory answer alone is not the answer.
#   _DRIVER_SRC_TREES    the lib directory, RECURSIVELY, because every regular file in it is copied.
#   _DRIVER_SRC_PARENTS  every directory from the source's parent up to `/`. Rename permission in
#                        Unix belongs to the CONTAINING directory, so an account that can write the
#                        parent can move a root-owned, mode-clean tree aside and put its own there,
#                        and every check below it then passes over bytes it chose.
#
# AND THEY ARE NOT SCRIPT-SCOPE NAMES. They read like scratch, but they are the argv of the `find`
# whose answer decides whether a tree ${APP_USER} can write may become the program the next
# privileged run is launched from. An empty list makes that `find` examine `.` instead — which can
# report no offender and read exactly like a clean answer. `readonly` cannot apply (they are rebuilt
# per call), so the frame that CONSUMES the answer declares all four `local`, there is no script-scope
# name for another path to pre-set, and the lengths are asserted before the `find` runs.
driver_source_paths() {
  local scripts_dir="$1" name resolved
  _DRIVER_SRC_DIRS=("${scripts_dir}")
  _DRIVER_SRC_FILES=()
  _DRIVER_SRC_TREES=("${scripts_dir}/lib")
  _DRIVER_SRC_PARENTS=()
  for name in "${IMS_DRIVER_ENTRYPOINTS[@]}"; do
    _DRIVER_SRC_FILES+=("${scripts_dir}/${name}")
  done
  # THE PARENT CHAIN IS WALKED OVER THE RESOLVED PATH. A symlink component would otherwise be stat'ed
  # as a symlink — mode 0777 on Linux, which every mode test calls world-writable — while the
  # directory it actually names went unexamined. Each symlink on the way is itself an entry in one of
  # the resolved directories, so nothing drops out of the question by being resolved.
  resolved="$(realpath -e -- "${scripts_dir}" 2>/dev/null)" || resolved="${scripts_dir}"
  while :; do
    resolved="$(dirname -- "${resolved}")"
    _DRIVER_SRC_PARENTS+=("${resolved}")
    [[ "${resolved}" == "/" ]] && break
  done
  return 0
}

# WHO CAN WRITE THE SOURCE? The first offending path, or the empty string for "nobody but this
# account". It NAMES the offender rather than counting, because an operator acts on a path — and a
# `find` that cannot stat what it was asked about is a FAILURE, not a pass: this is the one question
# whose "no answer" must never read as "no problem".
#
# TWO RELAXATIONS ON THE PARENT CHAIN, and they are the difference between a rule and a rule nobody
# can satisfy — the same two the fence's ancestor walk states:
#   * uid 0 is accepted as well as this account's. root can replace anything on the filesystem
#     whatever the modes say, so calling /usr root-owned-and-therefore-untrusted refuses every host.
#   * a group- or world-writable directory carrying the STICKY BIT is accepted: sticky is the kernel
#     saying "only the owner of an entry may rename or remove it", which is the rename this asks about.
driver_source_trust() {
  local scripts_dir="$1" uid offender
  IMS_DRIVER_SOURCE_UNTRUSTED_PATH=""
  uid="$(id -u)" || return 1
  driver_source_paths "${scripts_dir}" || return 1
  (( ${#_DRIVER_SRC_DIRS[@]} > 0 )) || return 1
  (( ${#_DRIVER_SRC_FILES[@]} > 0 )) || return 1
  (( ${#_DRIVER_SRC_TREES[@]} > 0 )) || return 1
  (( ${#_DRIVER_SRC_PARENTS[@]} > 0 )) || return 1

  offender="$(find "${_DRIVER_SRC_DIRS[@]}" "${_DRIVER_SRC_FILES[@]}" -maxdepth 0 \
    \( ! -uid "${uid}" -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  if [[ -z "${offender}" ]]; then
    offender="$(find "${_DRIVER_SRC_TREES[@]}" \( ! -uid "${uid}" -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  fi
  if [[ -z "${offender}" ]]; then
    offender="$(find "${_DRIVER_SRC_PARENTS[@]}" -maxdepth 0 \
      \( \( ! -uid "${uid}" -a ! -uid 0 \) -o \( -perm /022 -a ! -perm -1000 \) \) -print -quit 2>/dev/null)" || return 1
  fi
  [[ -z "${offender}" ]] || IMS_DRIVER_SOURCE_UNTRUSTED_PATH="${offender}"
  return 0
}

# THE SOURCE AS THE KERNEL SEES IT: device, inode, owner and mode for every path the answer above is
# about. Taken before the copy and again after it, and compared.
#
# A rename changes neither a path, nor an owner, nor a mode — it changes which OBJECT the path names,
# which is invisible to driver_source_trust() run twice and visible here. The trust walk decides
# whether the swap is POSSIBLE; this decides whether it HAPPENED under the copy, and the two
# relaxations above are exactly the cases where "possible" cannot be answered with a flat no.
driver_source_ident() {
  {
    find "${_DRIVER_SRC_DIRS[@]}" "${_DRIVER_SRC_FILES[@]}" "${_DRIVER_SRC_PARENTS[@]}" \
      -maxdepth 0 -printf '%p %D %i %U %m\n' 2>/dev/null
    find "${_DRIVER_SRC_TREES[@]}" -printf '%p %D %i %U %m\n' 2>/dev/null
  } | LC_ALL=C sort
}

# A STAGING DIRECTORY WHOSE RUN IS GONE, AND NOTHING ELSE. Every exit path below removes its own, so
# what this collects is the residue of a run that was killed between the `mktemp` and the rename —
# root-owned copies of an old release that nothing will ever finish publishing, accumulating under
# /etc where an operator has to wonder what they are.
#
# IT CANNOT TAKE A LIVE RUN'S TREE, and the argument is not "the name is unguessable": the pid in the
# name is the publishing shell's, and a tree whose publisher is gone will never be renamed into place
# by anybody. A pid that is alive — including one a live unrelated process has reused — is SKIPPED,
# so every ambiguity resolves towards leaving the directory alone. And the worst case if it were ever
# wrong is a refused publication in the other run (its `mv` fails, the standing tree is untouched),
# never a substitution: this deletes, and deleting cannot put bytes anywhere.
driver_sweep_orphan_publish_dirs() {
  local keep="$1" entry base rest pid
  for entry in "${IMS_DRIVER_ROOT}/${IMS_DRIVER_PUBLISH_PREFIX}"*; do
    [[ -d "${entry}" ]] || continue
    [[ "${entry}" != "${keep}" ]] || continue
    base="${entry##*/}"
    rest="${base%.*}"
    pid="${rest##*.}"
    [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || continue
    if kill -0 "${pid}" 2>/dev/null; then
      continue
    fi
    rm -rf "${entry}" || true
  done
  return 0
}

# ---------------------------------------------------------------------------
# THE PUBLICATION
# ---------------------------------------------------------------------------

# Stage, seal, digest, authenticate, swap, record — in that order, and the record LAST so a digest
# is never on disk ahead of the tree it describes.
#
# WHICH TREE is a `kind` and not a function name passed in. An indirect call would be one more
# construct a reader of this file cannot resolve statically, in a file whose whole subject is which
# bytes get executed; a `case` names both possibilities in the open.
#
# THE DIGEST GOES INTO ${IMS_DRIVER_PUBLISHED_DIGEST}, not onto stdout, so no caller has to read it
# through a command substitution and lose ${IMS_DRIVER_REASON} with the subshell.
driver_publish_tree() {
  local kind="$1" target="$2" record="$3" manifest="$4" expected="$5" what="$6"
  # WHICH ENVIRONMENT VARIABLE SUPPLIES THE PIN, so a refusal names the one the operator would set.
  # Two publications now take a digest from two different names, and a message that named the wrong
  # one would send an operator to set a variable that decides nothing.
  local pin_name="${7:-IMS_HELPER_SET_SHA256}"
  local run_dir staged retired tree_manifest="" digest="" filled=0
  IMS_DRIVER_REASON=""
  IMS_DRIVER_PUBLISHED_DIGEST=""
  driver_root_ready || return 1

  # THE PER-RUN STAGING DIRECTORY (o3d-z5be r2, Codex HIGH). `mktemp -d` creates it atomically, so no
  # second run can be assembling in the same place — and the `rm -rf` of a fixed name that used to
  # stand here could not tell its own staging tree from another run's.
  run_dir="$(mktemp -d "${IMS_DRIVER_ROOT}/${IMS_DRIVER_PUBLISH_PREFIX}${kind}.$$.XXXXXX" 2>/dev/null)" || {
    driver_refuse "a private staging directory for ${what} could not be created under ${IMS_DRIVER_ROOT}, so nothing has been published" || return 1
  }
  driver_sweep_orphan_publish_dirs "${run_dir}"
  staged="${run_dir}/staged"
  retired="${run_dir}/retired"
  mkdir -p "${staged}" || { rm -rf "${run_dir}"; return 1; }

  # THE FILLER'S STATUS IS CARRIED, NOT COLLAPSED. `|| filled=$?` rather than a bare call: under
  # `set -e` a non-zero statement would end the SOURCING script, and a `&& filled=0` — which is what
  # stood here — throws away the distinction between "this could not be assembled" and "nothing
  # vouched for the source", which is the difference between a run that must stop and a run that
  # carries on with the previous driver standing.
  case "${kind}" in
    helpers) driver_fill_helper_set "${staged}" || filled=$? ;;
    driver)  driver_fill_program "${staged}" || filled=$? ;;
    *)
      rm -rf "${run_dir}"
      driver_refuse "'${kind}' is not a tree this file knows how to publish. This is a bug in these scripts, not an operator error" || return 1
      ;;
  esac
  if (( filled != 0 )); then
    rm -rf "${run_dir}"
    # The filler has already said why, on stderr as well as in the variable. A filler that somehow
    # did not is given a sentence here rather than letting the caller print an empty reason.
    [[ -n "${IMS_DRIVER_REASON}" ]] || driver_refuse "${what} could not be assembled in ${staged}" || true
    return "${filled}"
  fi

  chown -R "$(id -u):$(id -g)" "${staged}" 2>/dev/null || true
  chmod -R u=rwX,go=rX "${staged}" || { rm -rf "${run_dir}"; return 1; }

  if ! _fence_tree_is_sealed "${staged}"; then
    rm -rf "${run_dir}"
    driver_refuse "${DB_FENCE_SEAL_REASON}" || return 1
  fi

  tree_manifest="$(_fence_tree_manifest "${staged}")" || { rm -rf "${run_dir}"; return 1; }
  digest="$(_fence_tree_digest "${staged}")" || { rm -rf "${run_dir}"; return 1; }

  if [[ -n "${expected}" ]] && [[ "${digest}" != "${expected}" ]]; then
    rm -rf "${run_dir}"
    driver_refuse "${pin_name} expects ${expected} but ${what} assembled from this checkout hashes to ${digest}, so NOTHING was published to ${target} and nothing will be executed out of it. The digest is taken with: ${DB_FENCE_ARTEFACT_RECIPE}" || return 1
  fi

  if [[ -e "${target}" ]]; then
    mv -f "${target}" "${retired}" || { rm -rf "${run_dir}"; return 1; }
  fi
  if ! mv -f "${staged}" "${target}"; then
    [[ -e "${retired}" ]] && mv -f "${retired}" "${target}" 2>/dev/null
    rm -rf "${run_dir}"
    driver_refuse "${what} could not be renamed into ${target}; the tree that was there is still there" || return 1
  fi
  rm -rf "${run_dir}"

  printf 'tree_sha256=%s\ntree_recipe=%s\ntree_complete=1\n' "${digest}" "${DB_FENCE_ARTEFACT_RECIPE}" \
    | _fence_publish_file "${record}" || return 1
  printf '%s\n' "${tree_manifest}" | _fence_publish_file "${manifest}" || return 1
  chown "$(id -u):$(id -g)" "${record}" "${manifest}" 2>/dev/null || true
  _fence_fsync_path "${IMS_DRIVER_ROOT}" || return 1
  IMS_DRIVER_PUBLISHED_DIGEST="${digest}"
  return 0
}

# ---------------------------------------------------------------------------
# THE TWO PUBLICATIONS
# ---------------------------------------------------------------------------

# The run snapshot's filler: the whole of this run's scripts/lib. The WHOLE directory rather than a
# list of helpers, so a helper added to it is covered by the digest on the day it is added instead
# of on the day somebody remembers to extend a list.
driver_fill_helper_set() {
  driver_copy_regular_files "${IMS_SCRIPT_LIB_DIR}" "$1"
}

# The driver's filler: the three entrypoints and the library beside them, one level down — and the
# gate that decides whether anything may be copied at all.
#
# RETURN 2 MEANS "NOTHING VOUCHED FOR THIS SOURCE", and it is a different answer from 1. 1 is a run
# that could not do what it was asked; 2 is a run that was asked to promote bytes an unprivileged
# account could have chosen into the program the NEXT privileged run is launched from, and declined.
# install.sh and update.sh both treat 1 as a failure and 2 as a warning with the previous driver
# standing, which is why the two are not the same number.
driver_fill_program() {
  local staged="$1" scripts_dir name before after copied=0
  # THE PATH LISTS AND THE PROVENANCE ANSWER ARE THIS CALL'S, NOT THE SCRIPT'S — see the block above
  # driver_source_paths(). Nothing at script scope carries these names, so no other code path can
  # pre-set the answer this frame is about to read.
  local -a _DRIVER_SRC_DIRS=() _DRIVER_SRC_FILES=() _DRIVER_SRC_TREES=() _DRIVER_SRC_PARENTS=()
  local IMS_DRIVER_SOURCE_UNTRUSTED_PATH=""
  scripts_dir="${IMS_DRIVER_FILL_SOURCE}"
  if [[ -z "${scripts_dir}" ]]; then
    driver_refuse "no source directory was named for the root-owned driver. This is a bug in these scripts, not an operator error" || return 1
  fi
  for name in "${IMS_DRIVER_ENTRYPOINTS[@]}"; do
    if [[ ! -f "${scripts_dir}/${name}" ]]; then
      driver_refuse "${scripts_dir}/${name} is not in this checkout, so the root-owned driver would be missing an entrypoint an operator is told to run" || return 1
    fi
  done

  # WHO COULD HAVE CHOSEN THESE BYTES — asked BEFORE anything is copied, and a failure to answer is a
  # refusal. An unanswerable provenance question is the one case where silence must not read as a pass.
  driver_source_trust "${scripts_dir}" || {
    driver_refuse "the ownership and modes of ${scripts_dir} could not be read, so this run cannot say whether an account other than this one could have chosen the bytes it was about to publish as the next root-owned driver. Nothing has been published" || return 1
  }
  if [[ -z "${IMS_DRIVER_PROGRAM_EXPECTED_SHA256}" && -n "${IMS_DRIVER_SOURCE_UNTRUSTED_PATH}" ]]; then
    driver_refuse "NOTHING VOUCHES FOR THE BYTES IN ${scripts_dir}, so NOTHING was published to ${IMS_DRIVER_PROGRAM_DIR} and the copy standing there is unchanged. ${IMS_DRIVER_SOURCE_UNTRUSTED_PATH} is owned or writable by an account other than this one, which means that account could have replaced what is in that tree AFTER every check this run has made — and what is published there is what the NEXT privileged run executes AS ROOT, on the documented update command. Publishing it would postpone a privilege escalation by one release rather than close it. TWO WAYS OUT, and both put the answer outside that account: re-run supplying IMS_DRIVER_SHA256=<digest of the driver tree of the release you intend to install>, which must come from the release and not from this box — a digest computed here is what the tree under question says about itself and can CONFIRM the release's value, never stand in for it; or install the release tree as root, take group and other write off it, and publish from there, in which case nothing needs to vouch for it because nobody else could have written it. The digest is taken over the tree that WOULD be published — the three entrypoints and lib/ — with: ${DB_FENCE_ARTEFACT_RECIPE}" || true
    return 2
  fi

  # THE OBJECTS, BEFORE THE COPY. Compared with the same question after it, below.
  before="$(driver_source_ident)"
  if [[ -z "${before}" ]]; then
    driver_refuse "${scripts_dir} could not be inspected at all, so this run cannot say the bytes it copies are the bytes it checked. Nothing has been published" || return 1
  fi

  for name in "${IMS_DRIVER_ENTRYPOINTS[@]}"; do
    cat < "${scripts_dir}/${name}" > "${staged}/${name}" || return 1
    copied=$(( copied + 1 ))
  done
  (( copied == ${#IMS_DRIVER_ENTRYPOINTS[@]} )) || return 1
  driver_copy_regular_files "${scripts_dir}/lib" "${staged}/lib" || return 1

  # AND THE SAME OBJECTS AFTER IT (o3d-z5be r2). A rename under the copy changes no path, no owner
  # and no mode — only which object each path names — so the trust answer above would still be about
  # the tree that is no longer there. This is the check that says the bytes published are the bytes
  # vouched for.
  after="$(driver_source_ident)"
  if [[ "${before}" != "${after}" ]]; then
    driver_refuse "${scripts_dir} was not the same tree after the copy as before it: a component was renamed or replaced while the root-owned driver was being assembled from it, so the bytes staged are not the bytes this run checked. Nothing has been published" || return 1
  fi
  return 0
}

# THE CALL EVERY ENTRYPOINT MAKES AT STARTUP, and the only writer of
# ${IMS_DRIVER_HELPER_SHA256}.
#
# Returns 0 when a snapshot is standing that THIS run published, and 0 as well when the run is not
# privileged — an unprivileged run publishes nothing and executes nothing privileged, so there is
# nothing for it to refuse; privileged_helper_path() is what refuses, with the reason recorded
# here. Returns 1 only when a privileged run could NOT establish the snapshot, which every
# entrypoint treats as fatal before it has changed anything.
publish_privileged_helper_set() {
  IMS_DRIVER_REASON=""
  IMS_DRIVER_PUBLISH_NOTE=""
  # THE PUBLICATION IS ATTEMPTED WHATEVER THE EUID, and only whether a FAILURE IS FATAL depends on
  # being root. An earlier form returned early on `id -u != 0`, which made the whole mechanism
  # unreachable from the test suite — the suite does not run as root, so every rig would have been
  # measuring a re-implementation instead of the shipped function. This is the same move
  # _fence_tree_is_sealed() makes and records: ask the question of the CURRENT account, so that in
  # production (euid 0, always — all three entrypoints refuse to run as anything else) it is the
  # root-owned statement, and in a harness it is the real code.
  if driver_publish_tree helpers "${IMS_DRIVER_HELPER_DIR}" "${IMS_DRIVER_HELPER_RECORD}" \
    "${IMS_DRIVER_HELPER_MANIFEST}" "${IMS_DRIVER_EXPECTED_SHA256}" "the privileged helper set"; then
    if fence_valid_sha256 "${IMS_DRIVER_PUBLISHED_DIGEST}"; then
      readonly IMS_DRIVER_HELPER_SHA256="${IMS_DRIVER_PUBLISHED_DIGEST}"
      return 0
    fi
    driver_refuse "the privileged helper set was published to ${IMS_DRIVER_HELPER_DIR} but its digest could not be read back, so nothing this run executes later could be checked against it" || true
  fi
  IMS_DRIVER_PUBLISH_NOTE="${IMS_DRIVER_REASON}"
  # AN UNPRIVILEGED RUN IS NOT A FAILURE. It cannot own a directory under /etc and is not expected
  # to: `update.sh --dry-run` and `--print-fence-digest` are documented to work unprivileged, they
  # execute nothing as root, and so they have nothing to refuse. privileged_helper_path() is what
  # refuses, quoting ${IMS_DRIVER_PUBLISH_NOTE}. A PRIVILEGED run that could not publish stops, and
  # the caller says so before it has changed anything.
  [[ "$(id -u)" == "0" ]] || return 0
  return 1
}

# THE ROOT-OWNED DRIVER (o3d-z5be). Published from the tree this run was launched out of, or from the
# release it has just deployed — and only when something outside the service account's control
# vouches for that tree. Separate from the snapshot above and with its own record, because the two
# answer different questions: the snapshot is what THIS run executes, the driver is what the NEXT run
# is launched from, which is why the permission the two need is not the same (see the header).
#
# THE STATUS IS THREE-VALUED AND THE CALLERS READ ALL THREE: 0 published, 2 nothing vouched for the
# source so nothing was published, 1 anything else. A caller that collapsed 2 into 1 would either
# abort a deployment over a driver refresh or report a publication that did not happen.
publish_privileged_driver() {
  local scripts_dir="$1" rc=0
  IMS_DRIVER_REASON=""
  if [[ ! -d "${scripts_dir}" ]]; then
    driver_refuse "${scripts_dir} is not a directory, so there is no driver to publish from it" || return 1
  fi
  IMS_DRIVER_FILL_SOURCE="${scripts_dir}"
  driver_publish_tree driver "${IMS_DRIVER_PROGRAM_DIR}" "${IMS_DRIVER_PROGRAM_RECORD}" \
    "${IMS_DRIVER_PROGRAM_MANIFEST}" "${IMS_DRIVER_PROGRAM_EXPECTED_SHA256}" \
    "the root-owned deployment driver" IMS_DRIVER_SHA256 || rc=$?
  (( rc == 0 )) || return "${rc}"
  fence_valid_sha256 "${IMS_DRIVER_PUBLISHED_DIGEST}" || return 1
  return 0
}

# ---------------------------------------------------------------------------
# THE DEPLOYMENT METADATA (o3d-z5be)
# ---------------------------------------------------------------------------

# WHAT READS IT, WHEN, AND AS WHOM — stated here because that is the whole of the finding.
#
# update.sh reads GIT_REPO_URL, GIT_BRANCH and GIT_DEPLOY_KEY_ENABLED out of it AS ROOT, at startup,
# through env_file_value(): key by key, as DATA, never by sourcing it. The clone those values steer
# runs AS ${APP_USER} with `--` before the URL, so no privilege is crossed at the clone — but the
# RE-CLONE SOURCE OF A PRODUCTION UPDATE was chosen by a file in a directory ${APP_USER} owns. That
# is what moves here. install.sh is the only writer; nothing else on the box reads it.
#
# Mode 0600 under a 0755 root: the root-owned directory has to be traversable so an operator can
# reach the driver copy, and the metadata is the one thing in it that is nobody else's business.
publish_privileged_deploy_meta() {
  IMS_DRIVER_REASON=""
  driver_root_ready || return 1
  if ! _fence_publish_file "${IMS_DRIVER_DEPLOY_META}" 600; then
    driver_refuse "${IMS_DRIVER_DEPLOY_META} could not be published. It is written by rename, so whatever is at that path is a previous run's file, complete and unchanged" || return 1
  fi
  chown "$(id -u):$(id -g)" "${IMS_DRIVER_DEPLOY_META}" 2>/dev/null || true
  return 0
}

# Is this a regular file only this account can have written? Asked of the file rather than of its
# directory, because the directory being root-owned is what makes the answer meaningful and the mode
# of the file is what makes it complete.
driver_file_is_private() {
  local file="$1" meta kind owner mode
  meta="$(LC_ALL=C stat -c '%F|%u|%a' "${file}" 2>/dev/null)" || return 1
  IFS='|' read -r kind owner mode <<< "${meta}"
  [[ "${kind}" == "regular file" ]] || return 1
  [[ "${owner}" == "$(id -u)" ]] || return 1
  (( (8#${mode:-777} & 0022) == 0 )) || return 1
  return 0
}

# THE ROOT-OWNED METADATA IF THERE IS ONE, AND A REFUSAL WITH A REASON IF THERE IS NOT — never a
# silent fall back to the application-owned file. The caller decides what to do about an
# installation last touched by a release that did not write this file; what it must not be able to
# do is not notice.
privileged_deploy_meta_path() {
  IMS_DRIVER_REASON=""
  if [[ -L "${IMS_DRIVER_DEPLOY_META}" ]]; then
    driver_refuse "${IMS_DRIVER_DEPLOY_META} is a symbolic link. It lives in a root-owned directory, so only root can have put it there; it is not followed" || return 1
  fi
  if [[ ! -e "${IMS_DRIVER_DEPLOY_META}" ]]; then
    driver_refuse "there is no root-owned ${IMS_DRIVER_DEPLOY_META} on this host. install.sh writes it from o3d-z5be onwards, so an installation whose last install.sh run predates that release has none" || return 1
  fi
  if ! driver_file_is_private "${IMS_DRIVER_DEPLOY_META}"; then
    driver_refuse "${IMS_DRIVER_DEPLOY_META} is not a regular file owned by this account and writable by nobody else, so it is not evidence about anything" || return 1
  fi
  printf '%s' "${IMS_DRIVER_DEPLOY_META}"
  return 0
}

# ---------------------------------------------------------------------------
# THE RESOLUTION
# ---------------------------------------------------------------------------

# THE ONLY WAY A PRIVILEGED RUN MAY NAME A HELPER IT IS ABOUT TO EXECUTE.
#
# Everything below happens BEFORE the path is handed back, because the path is handed straight to
# `node` as root:
#
#   1. the name is a single component — no `/`, no `..` — so a caller cannot walk out of the tree;
#   2. this run published a snapshot at all (an unprivileged run, or a privileged one whose
#      publication failed, has no value here and is refused);
#   3. the tree is still SEALED: root-owned, no group or other write, regular files and directories
#      only. Without this a symbolic link planted inside it would be followed by node while the
#      manifest, which hashes regular files only, would not see it;
#   4. the tree still hashes to what THIS RUN published — not to what the record on disk says, which
#      another privileged run could have rewritten along with the tree;
#   5. the named file is there.
privileged_helper_path() {
  local name="$1" actual
  IMS_DRIVER_REASON=""
  if [[ ! "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    driver_refuse "'${name}' is not a single file name, so it will not be resolved inside ${IMS_DRIVER_HELPER_DIR}" || return 1
  fi
  if [[ -z "${IMS_DRIVER_HELPER_SHA256}" ]]; then
    driver_refuse "no root-owned snapshot of the helper set was published by this run, so there are no bytes it may execute as root: a helper read out of the checkout now could have been replaced since this run started. ${IMS_DRIVER_PUBLISH_NOTE:-no reason was recorded}" || return 1
  fi
  if ! _fence_tree_is_sealed "${IMS_DRIVER_HELPER_DIR}"; then
    driver_refuse "the root-owned helper set at ${IMS_DRIVER_HELPER_DIR} is no longer sealed, so nothing will be executed out of it: ${DB_FENCE_SEAL_REASON}" || return 1
  fi
  actual="$(_fence_tree_digest "${IMS_DRIVER_HELPER_DIR}")" || actual=""
  if [[ "${actual}" != "${IMS_DRIVER_HELPER_SHA256}" ]]; then
    driver_refuse "${IMS_DRIVER_HELPER_DIR} hashes to ${actual:-nothing readable} and this run published ${IMS_DRIVER_HELPER_SHA256}. Only root can write that directory, so something privileged has rewritten it while this run was in flight; refusing to execute bytes this run did not publish. ${IMS_DRIVER_HELPER_MANIFEST} lists the per-file digests: \`cd ${IMS_DRIVER_HELPER_DIR} && sha256sum -c ${IMS_DRIVER_HELPER_MANIFEST}\` names which file moved" || return 1
  fi
  if [[ ! -f "${IMS_DRIVER_HELPER_DIR}/${name}" ]]; then
    driver_refuse "${IMS_DRIVER_HELPER_DIR}/${name} is not in the snapshot this run published from ${IMS_SCRIPT_LIB_DIR}, so this release does not ship it. Restore the checkout and run again" || return 1
  fi
  printf '%s' "${IMS_DRIVER_HELPER_DIR}/${name}"
  return 0
}
