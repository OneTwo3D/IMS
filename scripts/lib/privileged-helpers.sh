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
# WHAT THIS DOES NOT CLAIM, STATED HERE RATHER THAN DISCOVERED LATER. It does not authenticate the
# CHECKOUT. An account that can write ${APP_DIR}/scripts before a run starts can still choose what
# the operator launches — it can replace the entrypoint itself, which is a window this repository
# has always accepted and docs/installation.md names. What is gone is the LATE window: the bytes
# root executes at minute twenty are the bytes that were on disk at minute zero, and nothing but
# root can have touched them in between. Provenance, where an operator wants it, is
# ${IMS_HELPER_SET_SHA256} on the privileged invocation — the same shape, the same refusal and the
# same source of trust (outside the checkout, from the operator) as IMS_FENCE_ARTEFACT_SHA256.
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
# the residual above narrows to "whatever install.sh was run from". install.sh publishes it from
# the release it is installing; update.sh refreshes it at the END of a successful run from the
# release it has just deployed, so the copy tracks what is deployed rather than freezing at
# install time.
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

# Assembled here and renamed into place in one step; the previous tree is moved aside under the
# retired name so a failed swap leaves the OLD tree standing rather than none.
readonly IMS_DRIVER_STAGED_SUFFIX=".staged"
readonly IMS_DRIVER_RETIRED_SUFFIX=".retired"

# The three files that ARE the driver. Enumerated, because "every .sh beside install.sh" would
# publish the development helpers as well and the digest is a statement about what root may run.
readonly IMS_DRIVER_ENTRYPOINTS=(install.sh update.sh deploy.sh)

# THE EXPECTED DIGEST, FROM THE ROOT INVOCATION AND FROM NOWHERE ELSE. Never read out of the
# checkout and never out of ${APP_DIR}/.env — both are writable by the account this protects
# against, and a digest that source can set authenticates nothing. Optional, for the reason the
# header gives: the snapshot's job is immutability-after-start, which needs no operator input;
# this is how an operator who wants provenance as well gets it.
readonly IMS_DRIVER_EXPECTED_SHA256="${IMS_HELPER_SET_SHA256:-}"

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
  local staged="${target}${IMS_DRIVER_STAGED_SUFFIX}" retired="${target}${IMS_DRIVER_RETIRED_SUFFIX}"
  local tree_manifest="" digest="" filled=1
  IMS_DRIVER_REASON=""
  IMS_DRIVER_PUBLISHED_DIGEST=""
  driver_root_ready || return 1

  rm -rf "${staged}" || return 1
  mkdir -p "${staged}" || return 1
  case "${kind}" in
    helpers) driver_fill_helper_set "${staged}" && filled=0 ;;
    driver)  driver_fill_program "${staged}" && filled=0 ;;
    *)
      rm -rf "${staged}"
      driver_refuse "'${kind}' is not a tree this file knows how to publish. This is a bug in these scripts, not an operator error" || return 1
      ;;
  esac
  if (( filled != 0 )); then
    rm -rf "${staged}"
    # The filler has already said why, on stderr as well as in the variable. A filler that somehow
    # did not is given a sentence here rather than letting the caller print an empty reason.
    [[ -n "${IMS_DRIVER_REASON}" ]] || driver_refuse "${what} could not be assembled in ${staged}" || true
    return 1
  fi

  chown -R "$(id -u):$(id -g)" "${staged}" 2>/dev/null || true
  chmod -R u=rwX,go=rX "${staged}" || { rm -rf "${staged}"; return 1; }

  if ! _fence_tree_is_sealed "${staged}"; then
    rm -rf "${staged}"
    driver_refuse "${DB_FENCE_SEAL_REASON}" || return 1
  fi

  tree_manifest="$(_fence_tree_manifest "${staged}")" || { rm -rf "${staged}"; return 1; }
  digest="$(_fence_tree_digest "${staged}")" || { rm -rf "${staged}"; return 1; }

  if [[ -n "${expected}" ]] && [[ "${digest}" != "${expected}" ]]; then
    rm -rf "${staged}"
    driver_refuse "IMS_HELPER_SET_SHA256 expects ${expected} but ${what} assembled from this checkout hashes to ${digest}, so NOTHING was published to ${target} and nothing will be executed out of it. The digest is taken with: ${DB_FENCE_ARTEFACT_RECIPE}" || return 1
  fi

  rm -rf "${retired}" || return 1
  if [[ -e "${target}" ]]; then
    mv -f "${target}" "${retired}" || { rm -rf "${staged}"; return 1; }
  fi
  if ! mv -f "${staged}" "${target}"; then
    [[ -e "${retired}" ]] && mv -f "${retired}" "${target}" 2>/dev/null
    rm -rf "${staged}"
    driver_refuse "${what} could not be renamed into ${target}; the tree that was there is still there" || return 1
  fi
  rm -rf "${retired}"

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

# The driver's filler: the three entrypoints and the library beside them, one level down.
driver_fill_program() {
  local staged="$1" scripts_dir name
  scripts_dir="${IMS_DRIVER_FILL_SOURCE}"
  if [[ -z "${scripts_dir}" ]]; then
    driver_refuse "no source directory was named for the root-owned driver. This is a bug in these scripts, not an operator error" || return 1
  fi
  for name in "${IMS_DRIVER_ENTRYPOINTS[@]}"; do
    if [[ ! -f "${scripts_dir}/${name}" ]]; then
      driver_refuse "${scripts_dir}/${name} is not in this checkout, so the root-owned driver would be missing an entrypoint an operator is told to run" || return 1
    fi
    cat < "${scripts_dir}/${name}" > "${staged}/${name}" || return 1
  done
  driver_copy_regular_files "${scripts_dir}/lib" "${staged}/lib"
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

# THE ROOT-OWNED DRIVER (o3d-z5be). Published from the tree this run was launched out of. Separate
# from the snapshot above and with its own record, because the two answer different questions: the
# snapshot is what THIS run executes, the driver is what the NEXT run is launched from.
publish_privileged_driver() {
  local scripts_dir="$1"
  IMS_DRIVER_REASON=""
  if [[ ! -d "${scripts_dir}" ]]; then
    driver_refuse "${scripts_dir} is not a directory, so there is no driver to publish from it" || return 1
  fi
  IMS_DRIVER_FILL_SOURCE="${scripts_dir}"
  driver_publish_tree driver "${IMS_DRIVER_PROGRAM_DIR}" "${IMS_DRIVER_PROGRAM_RECORD}" \
    "${IMS_DRIVER_PROGRAM_MANIFEST}" "" "the root-owned deployment driver" || return 1
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
