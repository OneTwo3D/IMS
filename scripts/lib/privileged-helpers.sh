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
# overlap (the shared cutover lock is taken later than this), so without it a run could verify a tree
# ANOTHER run had just published and execute its bytes. With it, a republication by anybody is a
# REFUSAL in every run that did not perform it. `readonly` is what makes that unspoofable from inside
# the run: nothing later in the script can restate it.
#
# AND IT TOOK THREE ROUNDS TO MAKE THE PUBLICATION ITSELF WORTH THAT SENTENCE. Both defects were in
# the machinery, not in the digest, and both are worth recording because each was argued away once:
#
#   * r2 (Codex HIGH). Every publication of a kind assembled at ONE fixed name beside its target,
#     `${target}.staged`, and removed whatever was there first — so a second run could empty and
#     refill the FIRST run's staging tree between the first run assembling it and the first run
#     HASHING it, after which the first hashed, renamed and recorded the second's bytes AS ITS OWN.
#     Fixed by giving every publication its own `mktemp -d` directory.
#   * r3 (Codex HIGH). That fixed the staging and left the FINAL name, and r2's own summary — "two
#     overlapping runs share no object but the final name, where the rename is atomic" — was wrong
#     about the half it did not change. The sequence was retire-then-rename: `mv ${target} retired`
#     then `mv staged ${target}`. Between those two the documented name did not exist, so a second
#     run could put its tree there first; and `mv src dst` where `dst` IS AN EXISTING DIRECTORY moves
#     src INSIDE dst and RETURNS SUCCESS. The loser therefore left its tree nested at
#     `${target}/staged`, recorded its own digest, and reported a publication — while the documented
#     command executed the winner's top-level files. Fixed by publishing through a POINTER: see THE
#     PUBLICATION IS ONE RENAME above driver_publish_tree(), which is now the only statement in this
#     file that changes what a documented name resolves to.
#
# WHY THE PUBLICATION IS NOT UNDER A LOCK — neither the shared cutover lock nor a narrow one over the
# critical section, which is what the r3 reviewer proposed and which would have been a real
# improvement over the sequence it protected. Four reasons, and the last is the one that decides it:
#
#   * this publication exists so that NOTHING root executes after startup comes out of the checkout,
#     and acquiring the cutover lock is itself work a run does before it holds any lock — moving the
#     snapshot after it would put root-side code before the snapshot meant to cover root-side code;
#   * the cutover lock does not span the population: `--dry-run` and `--print-fence-digest` publish
#     nothing and take no lock, and install.sh takes it at a different point on a fresh box. (This
#     objection does NOT apply to a narrow lock scoped to the publication — a run that publishes
#     nothing needs no such lock — and it was wrong to carry it over to that proposal in r2.);
#   * a lock is how you serialise writers to one object, and the fix here was to make the object one
#     that needs no serialising: `rename(2)` over a symbolic link is atomic in the kernel, so there
#     is no critical section left to hold a lock across;
#   * AND THE OTHER PUBLISHER MAY BE A DIFFERENT RELEASE. The standing driver can be arbitrarily many
#     releases old — that is the documented consequence of refusing to publish unvouched bytes — so
#     `update.sh` from release N-7 can be publishing while `install.sh` from release N publishes.
#     Mutual exclusion requires every participant to have heard of the lock; only one of them was
#     written after it existed. A rename requires nothing of the other participant. That is the
#     difference between structural atomicity and a scheduling property, and it is why a lock is not
#     even kept as a belt on top: a lock some publishers do not take invites a reader to believe the
#     critical section is protected when it is not.
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

# THE TWO NAMES ROOT IS DOCUMENTED TO RUN THINGS OUT OF, AND WHAT THEY ACTUALLY ARE: SYMBOLIC LINKS
# TO A VERSIONED DIRECTORY, FLIPPED BY ONE `rename()` (o3d-z5be r3, Codex HIGH).
#
# Each is the SINGLE MUTABLE OBJECT of its publication. Nothing else under the root is ever rewritten
# in place: a publication assembles a whole new versioned directory — tree, record and manifest
# together — and then replaces one symbolic link. `rename(2)` over an existing symbolic link is
# atomic and total, so at every instant, from any other process, these names resolve to exactly one
# COMPLETE, sealed, digested, vouched-for publication. There is no interval in which they resolve to
# nothing, to half a tree, or to two trees at once. See THE PUBLICATION IS ONE RENAME below for why
# the retire-then-rename sequence this replaces could not say that, and why a lock could not either.
readonly IMS_DRIVER_HELPER_DIR="${IMS_DRIVER_ROOT}/helpers"
readonly IMS_DRIVER_PROGRAM_DIR="${IMS_DRIVER_ROOT}/driver"

# AND THE RECORDS, EXPRESSED RELATIVE TO THE POINTER — which is what makes them part of the same
# commit (o3d-z5be r3, Codex HIGH). They used to be fixed paths beside the trees, written AFTER the
# swap: two mutable objects, updated in sequence, so two overlapping runs could leave the pointer
# naming one run's bytes and the record naming the other's, and a failure between the two left a
# record that described a tree nobody was running. The record now lives inside the versioned
# directory, one level up from the tree, and `${pointer}/../<name>` reaches it: the kernel resolves
# `..` from the directory the link landed in, so THIS PATH ALWAYS NAMES THE RECORD OF THE TREE THAT
# IS STANDING, and one rename commits both. It is still outside the tree, so it is still not part of
# its own digest.
readonly IMS_DRIVER_HELPER_RECORD="${IMS_DRIVER_HELPER_DIR}/../helper-set.sha256"
readonly IMS_DRIVER_HELPER_MANIFEST="${IMS_DRIVER_HELPER_DIR}/../helper-set.manifest"
readonly IMS_DRIVER_PROGRAM_RECORD="${IMS_DRIVER_PROGRAM_DIR}/../driver.sha256"
readonly IMS_DRIVER_PROGRAM_MANIFEST="${IMS_DRIVER_PROGRAM_DIR}/../driver.manifest"

# THE DEPLOYMENT METADATA (o3d-z5be). Root-owned and 0600: update.sh reads GIT_REPO_URL,
# GIT_BRANCH and GIT_DEPLOY_KEY_ENABLED out of it AS ROOT, at startup, as DATA through
# env_file_value() and never by sourcing it — and the re-clone source of a production update
# stops being a value the application account chooses.
readonly IMS_DRIVER_DEPLOY_META="${IMS_DRIVER_ROOT}/deploy-meta"

# THE FOUR NAMES ONE PUBLICATION USES, ALL DERIVED FROM ONE `mktemp -d` SUFFIX so that no two
# publications — overlapping or not — can ever share an object:
#
#   .publish-<kind>.<pid>.<rand>   where the tree is assembled, sealed, digested and recorded.
#                                  `mktemp -d` creates it atomically, so no second run is assembling
#                                  in the same place (o3d-z5be r2, Codex HIGH). It BECOMES the
#                                  versioned directory by rename, so nothing is copied twice.
#   .version-<kind>.<pid>.<rand>   the committed publication: the tree, and the record and manifest
#                                  beside it. Immutable from the instant it exists under this name.
#   .pointer-<kind>.<pid>.<rand>   the new symbolic link, before it takes the documented name. It is
#                                  created here so that the step which makes it visible is a rename
#                                  and not an unlink-then-symlink, which is what `ln -sf` does and
#                                  which has a window in which the name resolves to NOTHING.
#   .retired-<kind>.<pid>.<rand>   used on ONE path only: an installation whose documented name is
#                                  still a REAL DIRECTORY from a release that predates the pointer
#                                  scheme. `rename()` cannot put a symbolic link over a non-empty
#                                  directory, so that one directory is moved to this unique name
#                                  first. A unique destination is the point: `mv src dst` with `dst`
#                                  an existing directory moves src INSIDE it, which is the trap the
#                                  previous sequence fell into.
#
# The pid is the publishing shell's, so an operator reading `/etc` can tell what each directory was
# and the sweep can tell a publication in flight from the residue of one that was killed.
readonly IMS_DRIVER_PUBLISH_PREFIX=".publish-"
readonly IMS_DRIVER_VERSION_PREFIX=".version-"
readonly IMS_DRIVER_POINTER_PREFIX=".pointer-"
readonly IMS_DRIVER_RETIRE_PREFIX=".retired-"

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

# THE VERSIONED DIRECTORY A DOCUMENTED NAME CURRENTLY RESOLVES TO. Written by driver_standing_tree()
# and read in the same frame: in a variable rather than on stdout for the reason the block below gives —
# a caller reading it through `$(...)` would lose ${IMS_DRIVER_REASON} with the subshell, which is how
# the first version of this library reported every refusal as an empty sentence.
IMS_DRIVER_STANDING_TREE=""

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

# WHAT A PUBLICATION LEAVES BEHIND THAT NOTHING WILL EVER USE AGAIN, AND NOTHING ELSE.
#
# Three kinds of residue accumulate under the root, and an operator should not have to wonder what
# any of them are:
#
#   * a staging directory whose run was killed between the `mktemp` and the rename;
#   * a SUPERSEDED versioned directory — the previous release, still complete and still root-owned,
#     but no longer named by any pointer. These are the cost of publishing by pointer flip instead of
#     by overwriting, and leaving them forever would fill /etc with every release ever deployed;
#   * a leftover `.pointer-` symbolic link, and a `.retired-` directory from an interrupted migration.
#
# TWO QUESTIONS, BOTH OF WHICH MUST ANSWER "REAPABLE", and either one alone would be wrong:
#
#   1. IS ANY POINTER NAMING IT? A versioned directory the documented name resolves to is the standing
#      publication and is never touched, whatever the pid in its name says — the run that published it
#      is normally long gone, which is exactly why liveness alone cannot protect it.
#   2. IS ITS PUBLISHER GONE? The pid in the name is the publishing shell's. A live pid — including
#      one a live unrelated process has reused — is SKIPPED, so a publication in flight (its versioned
#      directory exists, its pointer has not been flipped yet) is never taken, and every ambiguity
#      resolves towards leaving the directory alone.
#
# AND THE WORST CASE IS STILL NOT A SUBSTITUTION. This only ever DELETES, and deleting cannot put
# bytes anywhere: were both questions somehow answered wrongly, the outcome is a refused publication
# in another run or a resolution that refuses because the tree is gone — never root executing bytes it
# did not check. A run already executing out of a directory swept here keeps its own bytes: bash holds
# an open descriptor on the script it is running and node has already read its helper, and an unlinked
# inode outlives its last descriptor.
driver_sweep_orphans() {
  local keep="$1" entry base rest pid link referenced=0
  local -a standing=()
  # WHAT IS STANDING, READ OFF THE POINTERS THEMSELVES rather than assumed from a name. Only the first
  # component matters: the link is `<version dir>/<tree>`, and it is the version dir that is at risk.
  for link in "${IMS_DRIVER_HELPER_DIR}" "${IMS_DRIVER_PROGRAM_DIR}"; do
    [[ -L "${link}" ]] || continue
    base="$(readlink -- "${link}" 2>/dev/null)" || continue
    [[ -n "${base}" ]] || continue
    standing+=("${base%%/*}")
  done
  for entry in "${IMS_DRIVER_ROOT}/${IMS_DRIVER_PUBLISH_PREFIX}"* \
               "${IMS_DRIVER_ROOT}/${IMS_DRIVER_VERSION_PREFIX}"* \
               "${IMS_DRIVER_ROOT}/${IMS_DRIVER_RETIRE_PREFIX}"* \
               "${IMS_DRIVER_ROOT}/${IMS_DRIVER_POINTER_PREFIX}"*; do
    # A symbolic link is reaped as a link and never followed; anything else must be a directory.
    if [[ ! -L "${entry}" ]] && [[ ! -d "${entry}" ]]; then
      continue
    fi
    [[ "${entry}" != "${keep}" ]] || continue
    base="${entry##*/}"
    referenced=0
    for link in "${standing[@]+"${standing[@]}"}"; do
      [[ "${base}" != "${link}" ]] || referenced=1
    done
    (( referenced == 0 )) || continue
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
# READING A POINTER
# ---------------------------------------------------------------------------

# WHICH VERSIONED DIRECTORY IS STANDING AT A DOCUMENTED NAME — in a variable and not on stdout, so a
# caller does not have to lose ${IMS_DRIVER_REASON} to a subshell to find out.
#
# THE LINK TEXT IS VALIDATED RATHER THAN RESOLVED, and that is the whole of the safety argument. A
# `realpath` would tell us where we landed; this says where we are ALLOWED to land: exactly one
# `.version-<kind>.<pid>.<rand>` component and one tree component beneath the root, so there is no
# absolute path, no `..` and no second directory level a link could use to leave ${IMS_DRIVER_ROOT} —
# which is the only directory in the chain whose ownership and modes have been established. Only root
# can write that directory, so only root can have created this link at all; this is what makes a
# malformed one a refusal with a reason instead of a path handed to `node`.
driver_standing_tree() {
  local pointer="$1" what="$2" link owner
  IMS_DRIVER_STANDING_TREE=""
  if [[ ! -L "${pointer}" ]]; then
    if [[ -d "${pointer}" ]]; then
      driver_refuse "${pointer} is a directory and not the symbolic link a publication commits, so it was put there by a release that predates the pointer scheme or by hand. Nothing is resolved through it: run install.sh to republish ${what}" || return 1
    fi
    driver_refuse "there is no ${what} published at ${pointer}" || return 1
  fi
  owner="$(LC_ALL=C stat -c '%u' "${pointer}" 2>/dev/null)" || {
    driver_refuse "${pointer} could not be inspected, so this run cannot say who published ${what}" || return 1
  }
  if [[ "${owner}" != "$(id -u)" ]]; then
    driver_refuse "${pointer} is owned by uid ${owner} and not by this account, so it is not a pointer this publication mechanism wrote. Nothing is resolved through it" || return 1
  fi
  link="$(readlink -- "${pointer}" 2>/dev/null)" || link=""
  if [[ ! "${link}" =~ ^\.version-[a-z]+\.[1-9][0-9]*\.[A-Za-z0-9]+/[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    driver_refuse "${pointer} names '${link:-nothing}', which is not one versioned publication directory and one tree beneath ${IMS_DRIVER_ROOT}. A pointer that could name anything else could name a tree outside the only directory whose ownership this run has established, so it is refused rather than followed" || return 1
  fi
  if [[ ! -d "${IMS_DRIVER_ROOT}/${link}" ]]; then
    driver_refuse "${pointer} names ${link}, which is not a directory under ${IMS_DRIVER_ROOT}: the publication it pointed at has been removed. Nothing will be executed out of ${pointer}" || return 1
  fi
  IMS_DRIVER_STANDING_TREE="${IMS_DRIVER_ROOT}/${link}"
  return 0
}

# ---------------------------------------------------------------------------
# THE PUBLICATION
# ---------------------------------------------------------------------------

# UNDOING A PUBLICATION THAT HAS NOT COMMITTED YET. Called from the failure paths between the
# versioned directory existing and the pointer being flipped — the only interval in which this run has
# created anything under the root that it must take away again.
#
# THE MIGRATION TREE IS PUT BACK ONLY IF NOTHING HAS TAKEN THE NAME. A concurrent publication that
# flipped its own pointer in while this one was failing owns that name now, and moving an old directory
# over it would be this mechanism destroying a good publication on its way out.
driver_publish_unwind() {
  local version_dir="$1" pointer_tmp="$2" retire_dir="$3" target="$4" migrated="$5"
  if (( migrated == 1 )) && [[ ! -e "${target}" ]] && [[ ! -L "${target}" ]] && [[ -d "${retire_dir}" ]]; then
    mv -T "${retire_dir}" "${target}" 2>/dev/null || true
  fi
  rm -rf "${version_dir}" "${retire_dir}" 2>/dev/null || true
  rm -f "${pointer_tmp}" 2>/dev/null || true
  return 0
}

# THE PUBLICATION IS ONE RENAME (o3d-z5be r3, Codex HIGH and MEDIUM).
#
# Assemble, seal, digest, authenticate, RECORD, make the whole thing durable, and only then FLIP ONE
# SYMBOLIC LINK. The flip is the last mutation of the publication and it is a single `rename(2)`.
#
# WHAT THE PREVIOUS SEQUENCE WAS AND WHY IT COULD NOT BE FIXED BY NARROWING. It was: move the standing
# tree aside, then `mv staged target`, then write the record. Two defects, and they are the same defect
# seen from two sides:
#
#   * BETWEEN the retire and the rename the documented name did not exist, so a second run could put
#     ITS tree there first. `mv src dst` with `dst` an existing DIRECTORY does not replace dst — it
#     moves src INSIDE it, as `dst/staged`, AND RETURNS SUCCESS. The first run then recorded its own
#     digest for a target whose top-level files were the second run's: the documented command executed
#     bytes nobody intended and the run reported that it had published its own.
#   * the record was written AFTER the swap, and the retired tree was deleted BEFORE the record. A
#     failure writing the record therefore returned nonzero — callers say "the driver was NOT
#     refreshed" — with the NEW tree already standing and nothing left to restore. Driver execution
#     does not consult the record, so the next documented invocation ran the new bytes anyway.
#
# WHY THIS IS ATOMIC AND NOT MERELY NARROWER. There is no interval to narrow. The versioned directory
# is built under a name no other run can hold and is complete before it is reachable from any
# documented name; the pointer is then replaced by `rename(2)`, which the kernel performs as one
# operation. A reader of ${target} at any instant — including an instant during this publication — gets
# either the previous publication or this one, never neither and never a mixture, and the `mv` cannot
# silently nest because its destination is a symbolic link and not a directory. The RECORD moved inside
# the versioned directory for the same reason: one commit point can only commit one object, so the
# record had to become part of the object the rename commits rather than a second thing updated after
# it. And a `rename()` that returns EEXIST-free success has no "succeeded into a state nobody intended"
# case left to report.
#
# WHY NOT A NARROW LOCK OVER THE RETIRE-AND-RENAME, which is the other answer and the one the reviewer
# proposed. It would be a real improvement over the sequence it protects, and the objection this file
# raised to the CUTOVER lock — that unlocked runs exist — does not apply to a lock scoped to the
# critical section, because a run that publishes nothing needs no lock. The reason it is not the answer
# here is specific to this mechanism: THE OTHER PUBLISHER MAY BE A DIFFERENT RELEASE. That is not a
# hypothetical — it is the whole purpose of ${IMS_DRIVER_PROGRAM_DIR} and the subject of the update
# documentation: the standing driver can be arbitrarily many releases old, so `update.sh` from release
# N-7 can be publishing while `install.sh` from release N publishes. Mutual exclusion requires every
# participant to agree on the protocol, and only one of them was written after the lock existed. A
# rename requires nothing of the other participant: the kernel serialises it whether the loser has ever
# heard of this scheme or not. That is the difference between structural atomicity and a scheduling
# property, and it is why the lock is not even kept as a belt on top — a lock that some publishers do
# not take would invite the reader to believe the critical section is protected when it is not.
#
# AND THE LOSER OF A RACE LOSES CLEANLY. Two runs that flip within the same instant both publish
# complete, sealed, separately-vouched-for trees; the later rename decides which one stands, exactly as
# the later of two writes to any single object does. The loser then finds, by reading the pointer back,
# that the name does not resolve to the tree it published, and REFUSES rather than reporting a
# publication: ${IMS_DRIVER_PUBLISHED_DIGEST} stays empty, so no caller can announce a digest for bytes
# the documented command will not execute. For the helper snapshot that refusal is the same refusal the
# in-memory digest has always produced, arriving at startup with a name attached instead of at minute
# twenty.
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
  local run_dir suffix version_dir version_name pointer_tmp retire_dir staged link
  local tree_name record_name manifest_name tree_manifest="" digest="" filled=0 migrated=0
  local published_at published_utc
  IMS_DRIVER_REASON=""
  IMS_DRIVER_PUBLISHED_DIGEST=""

  # THE THREE NAMES INSIDE ONE PUBLICATION, TAKEN FROM THE CALLER'S PATHS RATHER THAN RESTATED. The
  # tree keeps the pointer's own basename inside the versioned directory, so `${pointer}/../<record>`
  # reaches the record of the tree that is standing and the two publications need no second table of
  # names to stay in step.
  tree_name="${target##*/}"
  record_name="${record##*/}"
  manifest_name="${manifest##*/}"
  # AND THE RECORD MUST BE A PATH THE FLIP COMMITS. A record anywhere else would be a second mutable
  # object, which is the defect this shape exists to remove; a caller that passes one is a bug in these
  # scripts and is refused here rather than publishing something whose record can disagree with it.
  if [[ "${record}" != "${target}/../${record_name}" ]] || [[ "${manifest}" != "${target}/../${manifest_name}" ]]; then
    driver_refuse "the record and manifest for ${what} must be named relative to ${target} so that one rename commits them with the tree; '${record}' and '${manifest}' are not. This is a bug in these scripts, not an operator error" || return 1
  fi
  if [[ "${target%/*}" != "${IMS_DRIVER_ROOT}" ]]; then
    driver_refuse "${target} is not directly under ${IMS_DRIVER_ROOT}, which is the only directory whose ownership this run has established. This is a bug in these scripts, not an operator error" || return 1
  fi
  driver_root_ready || return 1

  # THE PER-RUN STAGING DIRECTORY (o3d-z5be r2, Codex HIGH). `mktemp -d` creates it atomically, so no
  # second run can be assembling in the same place — and the `rm -rf` of a fixed name that used to
  # stand here could not tell its own staging tree from another run's.
  run_dir="$(mktemp -d "${IMS_DRIVER_ROOT}/${IMS_DRIVER_PUBLISH_PREFIX}${kind}.$$.XXXXXX" 2>/dev/null)" || {
    driver_refuse "a private staging directory for ${what} could not be created under ${IMS_DRIVER_ROOT}, so nothing has been published" || return 1
  }
  # EVERY OTHER NAME THIS PUBLICATION USES COMES OFF THAT ONE SUFFIX, so all four are unique to this
  # call by the same argument that makes the `mktemp` unique — no second `mktemp`, and no name that
  # another run could be holding.
  suffix="${run_dir##*.}"
  version_name="${IMS_DRIVER_VERSION_PREFIX}${kind}.$$.${suffix}"
  version_dir="${IMS_DRIVER_ROOT}/${version_name}"
  pointer_tmp="${IMS_DRIVER_ROOT}/${IMS_DRIVER_POINTER_PREFIX}${kind}.$$.${suffix}"
  retire_dir="${IMS_DRIVER_ROOT}/${IMS_DRIVER_RETIRE_PREFIX}${kind}.$$.${suffix}"
  driver_sweep_orphans "${run_dir}"
  staged="${run_dir}/${tree_name}"
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
  # AND THE VERSIONED DIRECTORY ITSELF, which this one becomes. `mktemp -d` makes it 0700, and a 0700
  # directory above the tree would make the driver unreachable by every account but root — the reason
  # driver_root_ready() takes ${IMS_DRIVER_ROOT} to 0755 rather than the 0711 the cutover root uses is
  # that the driver is code every account may READ and none but root may write. The record beside the
  # tree is published 0644 for the same reason and would be behind a closed door otherwise.
  chown "$(id -u):$(id -g)" "${run_dir}" 2>/dev/null || true
  chmod 755 "${run_dir}" || { rm -rf "${run_dir}"; return 1; }

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

  # THE RECORD AND THE MANIFEST, WRITTEN BESIDE THE TREE AND BEFORE ANYTHING IS REACHABLE (o3d-z5be
  # r3, Codex MEDIUM). They used to be written after the swap, so a failure here left the new tree
  # standing while the caller reported that nothing had been refreshed. Here they are inside the
  # directory the flip commits: a failure at this point has nothing to undo but this run's own staging
  # tree, and the previous publication is still the one every documented name resolves to.
  #
  # AND THE PUBLICATION DATE IS IN THE RECORD (o3d-z5be r3, Codex MEDIUM 2). A deployment that never
  # supplies a digest refreshes nothing, release after release, and had no way to say how far behind
  # the standing driver had drifted. This is what privileged_driver_age_note() reads.
  published_at="$(date -u +%s 2>/dev/null)" || published_at=""
  published_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || published_utc=""
  if ! printf 'tree_sha256=%s\ntree_recipe=%s\ntree_published_at=%s\ntree_published_utc=%s\ntree_complete=1\n' \
    "${digest}" "${DB_FENCE_ARTEFACT_RECIPE}" "${published_at}" "${published_utc}" \
    | _fence_publish_file "${run_dir}/${record_name}"; then
    rm -rf "${run_dir}"
    driver_refuse "the digest record for ${what} could not be written, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi
  if ! printf '%s\n' "${tree_manifest}" | _fence_publish_file "${run_dir}/${manifest_name}"; then
    rm -rf "${run_dir}"
    driver_refuse "the per-file manifest for ${what} could not be written, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi
  chown "$(id -u):$(id -g)" "${run_dir}/${record_name}" "${run_dir}/${manifest_name}" 2>/dev/null || true
  if ! _fence_fsync_path "${run_dir}"; then
    rm -rf "${run_dir}"
    driver_refuse "${what} could not be made durable before publication, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi

  # THE PUBLICATION BECOMES A VERSION. One rename, into a name nothing else can hold, after which the
  # directory is immutable: every later step only reads it. The staging name is retired by this rename
  # rather than copied out of, so there is no second copy to keep in step.
  if ! mv -T "${run_dir}" "${version_dir}"; then
    rm -rf "${run_dir}"
    driver_refuse "${what} could not be moved to ${version_dir}, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi
  if ! _fence_fsync_path "${IMS_DRIVER_ROOT}"; then
    driver_publish_unwind "${version_dir}" "${pointer_tmp}" "${retire_dir}" "${target}" "${migrated}"
    driver_refuse "${IMS_DRIVER_ROOT} could not be made durable, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi

  # THE ONE MIGRATION: A DOCUMENTED NAME THAT IS STILL A REAL DIRECTORY. `rename()` will not put a
  # symbolic link over a non-empty directory, so an installation last touched by a release that
  # published trees directly has to have that directory moved away once. The destination is a name
  # unique to this publication, which is the whole point — a destination that already existed as a
  # directory is what let the previous sequence nest one tree inside another and call it success.
  if [[ ! -L "${target}" ]] && [[ -e "${target}" ]]; then
    if ! mv -T "${target}" "${retire_dir}"; then
      driver_publish_unwind "${version_dir}" "${pointer_tmp}" "${retire_dir}" "${target}" 0
      driver_refuse "${target} is a directory from a release that published trees directly and it could not be moved aside, so nothing was published and it is still there" || return 1
    fi
    migrated=1
  fi

  # THE POINTER, BUILT UNDER ITS OWN NAME AND THEN RENAMED. `ln -sf` would unlink the documented name
  # and create it again, and between the two it resolves to nothing at all — for a name root is
  # documented to run a program out of, that is a window this scheme exists to not have.
  if ! ln -s -- "${version_name}/${tree_name}" "${pointer_tmp}"; then
    driver_publish_unwind "${version_dir}" "${pointer_tmp}" "${retire_dir}" "${target}" "${migrated}"
    driver_refuse "the pointer for ${what} could not be created under ${IMS_DRIVER_ROOT}, so nothing was published to ${target} and the copy standing there is unchanged" || return 1
  fi

  # THE COMMIT. Everything above this line is invisible to every documented name; everything below it
  # only reads. One `rename(2)`: the name resolves to the previous publication before it and to this
  # one after it, with no third state and no possibility of nesting, because the destination is a
  # symbolic link and not a directory.
  if ! mv -T "${pointer_tmp}" "${target}"; then
    driver_publish_unwind "${version_dir}" "${pointer_tmp}" "${retire_dir}" "${target}" "${migrated}"
    driver_refuse "${what} could not be published at ${target}; the copy that was there is still there" || return 1
  fi
  _fence_fsync_path "${IMS_DRIVER_ROOT}" || true

  # AND THE POINTER IS READ BACK, so a run that lost a race says so instead of announcing a digest for
  # bytes the documented command will not execute. The tree standing here is another run's complete,
  # separately vouched-for publication — this is not a corruption to repair, it is a later write to the
  # one object, and what must not happen is this run claiming the outcome.
  link="$(readlink -- "${target}" 2>/dev/null)" || link=""
  if [[ "${link}" != "${version_name}/${tree_name}" ]]; then
    rm -rf "${retire_dir}" 2>/dev/null || true
    driver_refuse "${target} names ${link:-a tree this publication did not create} and this run published ${version_name}/${tree_name}: another privileged run published ${what} at the same moment and its copy is the one standing there. Nothing of this run's is being reported as published; that run's tree was vouched for by its own operator and is complete, and re-running this one will publish over it" || return 1
  fi
  rm -rf "${retire_dir}" 2>/dev/null || true
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
#   3. the pointer resolves to one versioned publication directory under ${IMS_DRIVER_ROOT} and to
#      nothing else. THE PATH IS VALIDATED, NOT MERELY RESOLVED, because ${IMS_DRIVER_ROOT} is the only
#      directory in the chain whose ownership and modes this run has established;
#   4. the tree it names is still SEALED: root-owned, no group or other write, regular files and
#      directories only. Without this a symbolic link planted inside it would be followed by node while
#      the manifest, which hashes regular files only, would not see it;
#   5. that tree still hashes to what THIS RUN published — not to what the record on disk says, which
#      another privileged run could have rewritten along with the tree;
#   6. the named file is there.
#
# AND WHAT IS HANDED BACK IS THE RESOLVED PATH, not the pointer (o3d-z5be r3). The tree inside a
# versioned directory is immutable for as long as that directory exists, so the bytes sealed and
# digested above are the bytes `node` opens even if another privileged run flips the pointer in the
# interval. Through the pointer they would not have been. The REFUSAL above is unchanged and is still
# the answer to a concurrent republication: a run whose pointer no longer names the tree it published
# stops here rather than quietly carrying on with its own copy, which is the property this file has
# claimed since it was written.
privileged_helper_path() {
  local name="$1" actual tree
  IMS_DRIVER_REASON=""
  if [[ ! "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    driver_refuse "'${name}' is not a single file name, so it will not be resolved inside ${IMS_DRIVER_HELPER_DIR}" || return 1
  fi
  if [[ -z "${IMS_DRIVER_HELPER_SHA256}" ]]; then
    driver_refuse "no root-owned snapshot of the helper set was published by this run, so there are no bytes it may execute as root: a helper read out of the checkout now could have been replaced since this run started. ${IMS_DRIVER_PUBLISH_NOTE:-no reason was recorded}" || return 1
  fi
  driver_standing_tree "${IMS_DRIVER_HELPER_DIR}" "the privileged helper set" || return 1
  tree="${IMS_DRIVER_STANDING_TREE}"
  if ! _fence_tree_is_sealed "${tree}"; then
    driver_refuse "the root-owned helper set at ${IMS_DRIVER_HELPER_DIR} is no longer sealed, so nothing will be executed out of it: ${DB_FENCE_SEAL_REASON}" || return 1
  fi
  actual="$(_fence_tree_digest "${tree}")" || actual=""
  if [[ "${actual}" != "${IMS_DRIVER_HELPER_SHA256}" ]]; then
    driver_refuse "${IMS_DRIVER_HELPER_DIR} hashes to ${actual:-nothing readable} and this run published ${IMS_DRIVER_HELPER_SHA256}. Only root can write that directory, so something privileged has rewritten it while this run was in flight; refusing to execute bytes this run did not publish. ${IMS_DRIVER_HELPER_MANIFEST} lists the per-file digests: \`cd ${IMS_DRIVER_HELPER_DIR} && sha256sum -c ${IMS_DRIVER_HELPER_MANIFEST}\` names which file moved" || return 1
  fi
  if [[ ! -f "${tree}/${name}" ]]; then
    driver_refuse "${IMS_DRIVER_HELPER_DIR}/${name} is not in the snapshot this run published from ${IMS_SCRIPT_LIB_DIR}, so this release does not ship it. Restore the checkout and run again" || return 1
  fi
  printf '%s' "${tree}/${name}"
  return 0
}

# ---------------------------------------------------------------------------
# HOW OLD THE STANDING DRIVER IS (o3d-z5be r3, Codex MEDIUM 2)
# ---------------------------------------------------------------------------

# ONE SENTENCE ABOUT THE COPY THAT WILL RUN THE NEXT UPDATE, or nothing at all.
#
# WHY THIS EXISTS. A deployment whose operator never supplies ${IMS_DRIVER_SHA256} refreshes the driver
# NEVER — not once per release, never — because the tree it would copy from belongs to ${APP_USER} and
# nothing can vouch for it. That is the correct behaviour and it is documented, but the run said only
# "the previous release's driver stands", which is true after one such update and progressively less
# true after ten. The standing driver can be arbitrarily many releases old, and the operator had no
# way to notice: the same warning appears every time and names no age. So the record now carries the
# date it was published and this reads it back.
#
# IT NEVER REFUSES AND NEVER FAILS A CALLER. It is a sentence for an operator; a missing or unreadable
# record means an older release published the standing copy, which is itself the answer to "how old is
# it" and is printed as such.
privileged_driver_age_note() {
  local record published digest days now
  driver_standing_tree "${IMS_DRIVER_PROGRAM_DIR}" "the root-owned deployment driver" 2>/dev/null || {
    IMS_DRIVER_REASON=""
    printf 'There is no root-owned deployment driver standing at %s.' "${IMS_DRIVER_PROGRAM_DIR}"
    return 0
  }
  IMS_DRIVER_REASON=""
  record="$(dirname -- "${IMS_DRIVER_STANDING_TREE}")/${IMS_DRIVER_PROGRAM_RECORD##*/}"
  if [[ ! -f "${record}" ]] || ! grep -qE '^tree_complete=1$' "${record}" 2>/dev/null; then
    printf 'The driver standing at %s carries no complete publication record, so it was published by a release that predates this one and its age cannot be read off the box.' "${IMS_DRIVER_PROGRAM_DIR}"
    return 0
  fi
  digest="$(grep -m1 -E '^tree_sha256=' "${record}" 2>/dev/null)" || digest=""
  digest="${digest#tree_sha256=}"
  published="$(grep -m1 -E '^tree_published_at=' "${record}" 2>/dev/null)" || published=""
  published="${published#tree_published_at=}"
  if [[ ! "${published}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'The driver standing at %s hashes to %s and records no publication date, so it predates the release that started recording one.' "${IMS_DRIVER_PROGRAM_DIR}" "${digest:-an unreadable digest}"
    return 0
  fi
  now="$(date -u +%s 2>/dev/null)" || now=""
  if [[ ! "${now}" =~ ^[1-9][0-9]*$ ]] || (( now < published )); then
    printf 'The driver standing at %s hashes to %s and was published at %s UTC.' "${IMS_DRIVER_PROGRAM_DIR}" "${digest:-an unreadable digest}" "${published}"
    return 0
  fi
  days=$(( (now - published) / 86400 ))
  printf 'The driver standing at %s hashes to %s and was published %s day(s) ago. It is NOT one release behind — it is whatever release last vouched for itself, and it is the program that will run every future update until one does.' \
    "${IMS_DRIVER_PROGRAM_DIR}" "${digest:-an unreadable digest}" "${days}"
  return 0
}
