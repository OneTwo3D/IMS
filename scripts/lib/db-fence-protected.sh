# shellcheck shell=bash
# =============================================================================
# THE PROTECTED FENCE ARTEFACT — one mechanism, three entrypoints
# =============================================================================
# o3d-2sm1.5 r32, Codex CRITICAL. Sourced by scripts/install.sh, scripts/update.sh and
# scripts/deploy.sh, and it is the ONLY thing in this repository that decides which bytes the
# connection fence is executed from. Every mode goes through it: --preflight, --fence,
# --print-migration-url, --release, and the exit trap's re-fence.
#
# WHY IT IS A LIBRARY AND NOT A THIRD COPY. Three rounds running, one rule with several readers
# has been the shape of the finding: r29 published two root-owned artefacts and then made each of
# them the FALLBACK (deletion closed, substitution open); r30 inverted the precedence in update.sh
# and left deploy.sh and install.sh reading the old rule. A rule about which file may hold a
# privileged credential cannot be restated in three places and stay one rule. It is stated here,
# once, and the entrypoints have no fence-script resolution of their own.
#
# ---------------------------------------------------------------------------
# THE THREAT, STATED EXACTLY
# ---------------------------------------------------------------------------
# ${DB_FENCE_SCRIPT} lives in the application checkout, which is owned by the application account
# by construction. Root executes it — as the application user, with DEPLOY_ADMIN_DATABASE_URL in
# its environment — at four different moments spread across a cutover. The account that owns the
# file therefore has a window between every one of them in which to REPLACE it. Substituted code
# can report a fence it never raised and let a migration run against live writers.
#
# r29 closed DELETION: a root-owned copy is used when the checkout's file cannot be read.
# r30 closed SUBSTITUTION AT READ: the root-owned copy WINS whenever it exists, and is the only
#     file executed.
# r31 closed SUBSTITUTION AT WRITE: an existing protected copy is never overwritten from the
#     checkout; a new one is adopted only at bootstrap or against a digest supplied to the
#     privileged invocation.
# NONE OF THEM CLOSED SUBSTITUTION OF THE IMPORTS, which is this round. r31 published ONE FILE
#     into the protected directory and then symlinked `node_modules` straight back into the
#     application-owned checkout. `fence-db-connections.mjs` imported `dotenv` and `pg` at module
#     scope — BEFORE main() runs — so the account being defended against still chose executable
#     bytes in every supposedly protected process. A substituted `pg` can read argv, print a
#     migration URL of its own, exit 0 for --preflight and --fence, and never revoke anything.
#     Hashing the entry file authenticated a tenth of what was executed.
#
# ---------------------------------------------------------------------------
# THE RULE
# ---------------------------------------------------------------------------
#   THE PROTECTED ARTEFACT IS SELF-CONTAINED, ROOT-OWNED AND WHOLLY DIGESTED, AND AN EXISTING
#   ONE IS NEVER OVERWRITTEN FROM THE CHECKOUT.
#
# "Self-contained" is meant literally: ${DB_FENCE_PROTECTED_APP_DIR} holds the entry file AND a
# real, root-owned copy of every package the entry file's import graph resolves — no symlink, no
# hop back into ${APP_DIR}. "Wholly digested" means the recorded digest is taken over EVERY
# regular file in that tree, not over the entry file alone, and is re-verified before the tree is
# executed. See THE ARTEFACT DIGEST below for how it is computed and how an operator reproduces
# it.
#
# Three states, and nothing else:
#
#   NO PROTECTED ARTEFACT YET (bootstrap)      the checkout's entry file and its resolved
#                                              dependency closure are staged into the root-owned
#                                              directory and published there — ONLY when something
#                                              authenticated them. From an application-writable
#                                              source that means IMS_FENCE_ARTEFACT_SHA256, which
#                                              ships with the release; without it the bootstrap is
#                                              REFUSED, naming both ways to satisfy it. r33 let
#                                              this through as trust on first use with a warning
#                                              and Codex overruled it: a warning nobody has to
#                                              acknowledge does not make unauthenticated
#                                              privileged code execution safe.
#
#   ARTEFACT EXISTS, NO EXPECTED DIGEST        the artefact is used, unchanged. If the checkout's
#                                              entry file differs, that is REPORTED
#                                              (DB_FENCE_ROTATION_NOTE) and NOT promoted.
#
#   ARTEFACT EXISTS, EXPECTED DIGEST           an authenticated rotation. See below.
#
# WHY DIVERGENCE WARNS RATHER THAN REFUSES. Refusing would hand the application account a
# denial of service on every future cutover — write one byte into the checkout's helper and no
# deploy runs again — which trades a credential-theft path for an availability path the same
# account controls. The protected artefact is root-owned and was itself once shipped by this
# repository, so running it is safe; running it STALE is the risk, and a contract that has moved
# fails CLOSED at the fence (the helper refuses arguments it does not know) rather than silently.
# So: never silent, never fatal, never promoted.
#
# ---------------------------------------------------------------------------
# WHAT AUTHENTICATES AN UPGRADE
# ---------------------------------------------------------------------------
# NOT the checkout. Nothing computed from ${DB_FENCE_SCRIPT} can authenticate ${DB_FENCE_SCRIPT}:
# an account that can replace the bytes can replace the bytes their digest is taken from. The
# expected digest is therefore an INPUT TO THE PRIVILEGED INVOCATION, from the release source and
# not from the box:
#
#   IMS_FENCE_SCRIPT_SHA256=<64 hex> bash /path/to/release/scripts/update.sh      (as root)
#
# and the operator gets it from the release they are deploying, not from the deployed tree —
# `git show <tag>:scripts/fence-db-connections.mjs | sha256sum` on a machine that is not this one,
# or the checksum published with the release. Supplied, it is enforced on EVERY path, bootstrap
# included, so `IMS_FENCE_SCRIPT_SHA256=` is also how an operator pins a first install.
#
# IMS_FENCE_ARTEFACT_SHA256 pins the WHOLE TREE the same way, entry file and vendored packages
# together. It is the stronger of the two and it is what an operator who has already published
# this release on one host uses to require byte-identity on the next; see THE ARTEFACT DIGEST for
# the command that produces the value. Supplied, it is enforced at publication (the staged tree
# must hash to it, or nothing is published) AND at every execution (the standing record must say
# it, or nothing is run).
#
# THE SECOND ROTATION PATH IS ROOT ITSELF: remove ${DB_FENCE_PROTECTED_APP_DIR}. Only root can,
# the directory says so, and the next run bootstraps. It is the escape hatch for a box whose
# expected digest has been lost, and it is deliberately an act at the console rather than a flag.
#
# STAGING IS INSIDE THE PROTECTED DIRECTORY, AND THE VERIFIED TREE IS THE PUBLISHED TREE. The
# whole artefact is assembled at ${DB_FENCE_STAGED_APP_DIR}, which only root can write; it is
# sealed (ownership and modes), checked (no symlinks, no devices, nothing but regular files and
# directories), digested, and only then renamed into place. There is no window in which the
# checkout can change between the check and the publication, because after the copy the checkout
# is not read again.
#
# ROTATION IS REFUSED WHILE A FENCE MAY BE STANDING. ${DB_FENCE_STATE} existing means a fence was
# raised and not yet released; the helper that RELEASES it restores grants from a record the
# helper that RAISED it wrote, and swapping versions across that pair is how a release stops
# meaning what the fence meant. Release first, then rotate.
#
# ---------------------------------------------------------------------------
# WHAT IS VENDORED, AND WHY THAT IS ALL OF IT
# ---------------------------------------------------------------------------
# `fence-db-connections.mjs` imports exactly two kinds of specifier:
#
#   node: builtins   (node:crypto, node:fs, node:path, node:url)  — resolved by the interpreter,
#                    never from node_modules, and not something a file in ${APP_DIR} can shadow.
#   `pg`             the only bare specifier left.
#
# `dotenv` WAS THE OTHER ONE AND IT IS GONE (this round). It existed for a single call —
# `loadDotenv({ path: <app dir>/.env })` — whose only job was to put DEPLOY_ADMIN_DATABASE_URL
# into the environment when an operator pasted the printed `--release` command by hand. That call
# was already dead in the protected copy: the helper's `appDirectory()` (removed with the import)
# derived the app dir from the running file's own location, which under the mirror is
# ${DB_FENCE_PROTECTED_APP_DIR}, and there is no `.env` there. So it authenticated nothing and supplied nothing, while adding a whole package to
# the executable surface. The shell side already reads that file — env_file_value() in all three
# entrypoints — and passes the credential explicitly through `env`; the operator wrappers below
# do the same. Removing the import removed a dependency instead of vendoring it.
#
# THE CLOSURE IS RESOLVED, NOT LISTED. ${DB_FENCE_VENDOR_ROOTS[@]} names the roots; the transitive
# closure is walked with node's own resolver from ${APP_DIR}/scripts/, which is where the helper
# ships, so nesting (`pg-types/node_modules/postgres-array`) is preserved exactly. A package that
# will not resolve is a REFUSAL to publish, not a warning: a tree missing an import is a fence
# that dies at exec, and discovering that after the rename would leave exactly that standing.
#
# ---------------------------------------------------------------------------
# THE ARTEFACT DIGEST — HOW IT IS COMPUTED, AND HOW AN OPERATOR REPRODUCES IT
# ---------------------------------------------------------------------------
# Over the WHOLE tree, content only, path-relative so it is the same on every host:
#
#   cd /etc/ims-cutover-recovery/app \
#     && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum
#
# That is the literal command. ${DB_FENCE_ARTEFACT_RECIPE} below holds it as one string, the
# library computes the digest with exactly those bytes, and docs/installation.md prints the same
# string — a test asserts all three agree, because a documented recipe that does not reproduce
# the recorded value is a check an operator will conclude is broken and stop running.
#
#   * `-type f` and nothing else. Symlinks, devices, sockets and fifos are not hashed — they are
#     REFUSED outright by _fence_tree_is_sealed(), so nothing unhashable can be in the tree.
#   * `%P` prints the path relative to the tree root, so the manifest is host-independent.
#   * `LC_ALL=C sort -z` fixes the order under any locale.
#   * the per-file manifest is kept at ${DB_FENCE_MANIFEST_FILE} for forensics: when the digest
#     stops matching, `sha256sum -c` against it names the file, which "the digest changed" does
#     not.
#
# REPRODUCING IT FROM A RELEASE. The entry file comes from git, so
# `git show <tag>:scripts/fence-db-connections.mjs | sha256sum` is exact. The vendored packages
# come from the registry through package-lock.json, so `npm ci` at that tag in a clean tree
# produces the same package contents, and the same command run over a tree assembled the same way
# reproduces the artefact digest. What it does NOT survive is a package manager that rewrites
# package contents on install; if that is ever true here, the entry-file digest is still exact and
# the artefact digest degrades to "identical to what this box published", which is what the
# standing record is for.
#
# ---------------------------------------------------------------------------
# WHERE THE ARTEFACT LIVES, AND WHY IT IS NOT A BARE FILE UNDER /etc
# ---------------------------------------------------------------------------
# Node resolves bare specifiers by walking up from the IMPORTING MODULE'S directory, not from the
# working directory, and NODE_PATH does not apply to ESM at all — so a copy published at
# /etc/ims-cutover-recovery/…mjs resolves node_modules from /etc and /, finds neither, and dies
# with ERR_MODULE_NOT_FOUND before it can fence anything. r30 published exactly that, and every
# caller stubbed the process boundary, so no test saw it.
#
# So the artefact is a root-owned MIRROR OF THE SHIPPED LAYOUT:
#
#   /etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs   the only file executed
#   /etc/ims-cutover-recovery/app/node_modules/pg/…                  a real directory, root-owned
#   /etc/ims-cutover-recovery/app/node_modules/pg-protocol/…         …and the rest of the closure
#
# THE MODULE WALK CANNOT REACH ${APP_DIR}, and that is a property of the path rather than of a
# check. From /etc/ims-cutover-recovery/app/scripts/ node tries
# …/app/scripts/node_modules, …/app/node_modules (hit), and stops. Even for a specifier that is
# NOT vendored the walk continues /etc/ims-cutover-recovery/node_modules, /etc/node_modules,
# /node_modules and ends at the root — ${APP_DIR} is not an ancestor of the mirror, so no walk
# from inside it can arrive there. A missing package is ERR_MODULE_NOT_FOUND, which is a fence
# that refuses; it is never a package the application account chose.
#
# WHAT THE APPLICATION ACCOUNT STILL CONTROLS, STATED RATHER THAN HIDDEN:
#   * NOTHING, AT BOOTSTRAP, ANY MORE. The first publication takes the entry file and the packages
#     from the checkout because there is nothing else on the box to take them from — and it is
#     therefore REFUSED unless IMS_FENCE_ARTEFACT_SHA256 authenticates the whole tree, or the
#     source is one only the publishing account can write. See ${DB_FENCE_ARTEFACT_SOURCE_TEXT}
#     for where a first-ever install obtains that digest; it is a required input now, not a
#     hardening, so the answer is stated once and printed by every refusal that asks for it.
#   * THE PROCESS IT RUNS AS. The helper is executed AS THE APPLICATION USER on every in-script
#     path, by design — the fence state file has to be releasable by that account — so
#     DEPLOY_ADMIN_DATABASE_URL is reachable from that account through /proc and ptrace whatever
#     bytes run. Vendoring does not change that and does not claim to. What it closes is the
#     ability to LIE: to report a raised fence over an open database, or to hand back a migration
#     URL that points somewhere else. The operator wrappers published below run as the
#     application user for the same reason.
#   * THE INTERPRETER. `node` is taken from root's PATH. A root PATH containing an
#     application-writable directory would defeat this and every other protection here; that is a
#     host-hardening property, not one this file can assert.
#
# 0755, not 0700: the fence runs as the application user and must traverse and read this.
# Literals, not variables: a trust root chosen by a variable is only as trustworthy as whatever
# can set it. A deployment that must move it edits these lines.
# ---------------------------------------------------------------------------

DB_FENCE_RECOVERY_DIR="/etc/ims-cutover-recovery"
DB_FENCE_IDENTITY_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-identity.env"
DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"
DB_FENCE_SCRIPT_COPY="${DB_FENCE_PROTECTED_APP_DIR}/scripts/fence-db-connections.mjs"
# The whole artefact is assembled here and renamed into place in one step; the previous one is
# moved aside under this name so a failed swap leaves the OLD tree standing rather than none.
DB_FENCE_STAGED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/.app.staged"
DB_FENCE_RETIRED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/.app.retired"
# What the published tree hashes to, and the per-file manifest that says WHICH file moved when it
# stops matching. Root-owned, beside the tree and not inside it: a record that lived in the tree
# would be part of its own digest.
DB_FENCE_ARTEFACT_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-artefact.sha256"
DB_FENCE_MANIFEST_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-artefact.manifest"
# The two commands an operator is ever given. Root-owned, generated by root at fence time with
# this run's state file and connection identity baked in, so that what is PRINTED is a path that
# exists and runs — see db_fence_publish_operator_wrappers().
DB_FENCE_RELEASE_WRAPPER="${DB_FENCE_RECOVERY_DIR}/release-db-fence"
DB_FENCE_REFENCE_WRAPPER="${DB_FENCE_RECOVERY_DIR}/refence-db"

# The bare specifiers the entry file imports. The transitive closure is resolved from these; a
# test asserts this list is exactly the set of bare imports in scripts/fence-db-connections.mjs,
# so adding an import without vendoring it fails the suite rather than the cutover.
DB_FENCE_VENDOR_ROOTS=(pg)
# A cap on what a package.json in the checkout can talk this into copying under /etc. The real
# closure is ~140 files; a manifest that declares `next` as a dependency of `pg` would otherwise
# vendor several hundred megabytes. Exceeding it is a refusal, with the count named.
DB_FENCE_VENDOR_MAX_FILES=2000

# THE DOCUMENTED RECIPE, AS ONE STRING. The library hashes with exactly these bytes and
# docs/installation.md prints exactly this line; a test asserts the three agree and that running
# it reproduces the recorded digest.
DB_FENCE_ARTEFACT_RECIPE="find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum"

# WHERE THE WHOLE-TREE DIGEST COMES FROM, AS ONE STRING (o3d-2sm1.5 r34, Codex CRITICAL).
#
# Since an application-writable source with no whole-tree pin is now REFUSED, that digest is a
# REQUIRED INPUT rather than an optional hardening, and every refusal that names it has to say
# where a first-ever install gets it. Stated once here so the two refusals, the entrypoints and
# docs/installation.md cannot drift into three different answers — which is the defect this whole
# library was made a library to avoid. A test asserts the doc page contains it verbatim.
DB_FENCE_ARTEFACT_SOURCE_TEXT="WHERE THAT VALUE COMES FROM, ON A FIRST-EVER INSTALL AS MUCH AS ON ANY OTHER: it is published WITH THE RELEASE. The release is built on a host that is not this one — a clean checkout of the tag, 'npm ci', then 'bash scripts/update.sh --print-fence-digest', which assembles exactly this tree, prints the line 'THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO <digest>', and neither writes nor executes any part of it. That mode exists BECAUSE the build host has no installation: it resolves the tree from the checkout the command was typed out of, needs no application directory, no .env, no port, no database and no root, and it runs before every gate the update path would otherwise refuse at — and that digest is published with the release checksums. A host that has ALREADY published this release will also report it: grep '^fence_artefact_sha256=' ${DB_FENCE_ARTEFACT_FILE} there. Running either that mode or --dry-run on THIS box prints the same kind of line, but assembled from the checkout under question, so it can CONFIRM the release's value and never stand in for it. The other way out needs no digest at all: bootstrap from a source only this account can write — install the release tree as root and take group and other write off it — and the provenance question answers itself."

# The expected digests, from the ROOT INVOCATION and from nowhere else. Never read out of the
# checkout, never out of ${APP_DIR}/.env — both are writable by the account this authenticates
# against, and a digest that source can set authenticates nothing.
DB_FENCE_EXPECTED_SHA256="${IMS_FENCE_SCRIPT_SHA256:-}"
DB_FENCE_EXPECTED_ARTEFACT_SHA256="${IMS_FENCE_ARTEFACT_SHA256:-}"

# Why a divergence was not promoted, or why a rotation was refused. Printed by the caller; empty
# when there is nothing to say.
DB_FENCE_ROTATION_NOTE=""

# Why a tree was refused as unsealed. Set by _fence_tree_is_sealed(); it names the offending path,
# because "the artefact is not sealed" is not something an operator can act on.
DB_FENCE_SEAL_REASON=""

# Set by db_fence_probe_script(): the file a --preflight probe may run (EMPTY when nothing on this
# box is authenticated enough to be handed the admin credential), the throwaway directory that has
# to be removed afterwards, what the tree THIS CHECKOUT would publish hashes to — the value an
# operator pins the first publication with, obtainable from a run that writes nothing and executes
# nothing — what the artefact ALREADY STANDING hashes to, and why there is nothing to preflight
# with. The candidate and the standing digests are separate because during an upgrade they differ,
# and reporting the standing one answers a question nobody asked (o3d-2sm1.5 r34, Codex MEDIUM).
DB_FENCE_PROBE_SCRIPT=""
DB_FENCE_PROBE_TEMP=""
DB_FENCE_PROBE_ARTEFACT_SHA256=""
DB_FENCE_PROBE_STANDING_SHA256=""
DB_FENCE_PROBE_REASON=""

# Set by _fence_source_trust(): empty when the tree the artefact was assembled FROM is one only
# the publishing account could have written, and otherwise the first path that is not.
DB_FENCE_SOURCE_UNTRUSTED_PATH=""

# THE PRIVILEGE TRANSITION IS PART OF A PRINTED INSTRUCTION, NOT AN ASSUMPTION ABOUT ITS READER
# (o3d-2sm1.5 r33, Codex HIGH). The recovery wrappers below are root-owned and 0700, so an
# operator who launched the cutover with `sudo bash scripts/update.sh` returns to a NON-ROOT shell
# and gets `Permission denied` from a banner that printed a bare path. The banners therefore print
# this prefix in front of it.
#
# Empty when sudo is not installed, and that is not a fallback that leaves a reader stuck: every
# entrypoint refuses to run as anything but root, so on a box with no sudo the run cannot have
# been launched through it either, and the shell reading the banner is root's. `sudo <path>` is
# also correct FROM a root shell, so where sudo exists one form serves both readers.
DB_FENCE_SUDO_PREFIX=""
if command -v sudo >/dev/null 2>&1; then DB_FENCE_SUDO_PREFIX="sudo "; fi

# ---------------------------------------------------------------------------
# Durability, owned here rather than borrowed from the sourcing script.
#
# All three entrypoints define fsync_path()/publish_durable_file(), and which definition wins
# would depend on whether this file was sourced before or after them. A library whose behaviour
# depends on its source ORDER is the "one rule, several readers" defect again, in miniature. So
# these are private and unambiguous.
# ---------------------------------------------------------------------------

_fence_fsync_path() {
  local target="$1"
  sync "$target" 2>/dev/null && return 0
  sync 2>/dev/null && return 0
  return 1
}

# Publish stdin at "$1" atomically: a kill at any instant leaves the previous content or the
# complete new content, never a truncation. Mode 0644 because the application user must read it.
_fence_publish_file() {
  local target="$1" mode="${2:-644}" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod "$mode" "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! _fence_fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  _fence_fsync_path "$dir" || return 1
  return 0
}

# The digest of a file, or nothing. sha256sum is coreutils and is present wherever this runs; a
# box without it cannot bind the artefact to the record, and the callers refuse rather than raise
# a fence they cannot bind.
file_sha256() {
  local path="$1" out
  [[ -f "$path" ]] || return 1
  out="$(sha256sum -- "$path" 2>/dev/null)" || return 1
  out="${out%% *}"
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

# A digest is 64 lowercase hex characters or it is not a digest. An expected value of the wrong
# SHAPE is an operator error, and comparing against it would silently never match.
fence_valid_sha256() {
  [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]
}

# The digest ${DB_FENCE_IDENTITY_FILE} binds to the fence it records, and only from a COMPLETE
# record: a half-written one is not evidence about anything.
fence_record_script_digest() {
  local digest
  [[ -f "${DB_FENCE_IDENTITY_FILE}" ]] || return 1
  grep -qE '^fence_identity_complete=1$' "${DB_FENCE_IDENTITY_FILE}" 2>/dev/null || return 1
  digest="$(grep -m1 -E '^fence_script_sha256=' "${DB_FENCE_IDENTITY_FILE}" 2>/dev/null)" || return 1
  digest="${digest#fence_script_sha256=}"
  fence_valid_sha256 "${digest}" || return 1
  printf '%s' "${digest}"
}

# ---------------------------------------------------------------------------
# THE ARTEFACT: MANIFEST, DIGEST, SEAL
# ---------------------------------------------------------------------------

# "<sha256>  <path relative to the tree root>" for every regular file, in a locale-independent
# order. This is the exact byte stream the recorded digest is taken over, and it is the byte
# stream ${DB_FENCE_ARTEFACT_RECIPE} produces.
_fence_tree_manifest() {
  local root="$1" out
  [[ -d "$root" ]] || return 1
  out="$(cd "$root" 2>/dev/null && find . -type f -printf '%P\0' 2>/dev/null | LC_ALL=C sort -z | xargs -0 -r sha256sum --)" || return 1
  [[ -n "$out" ]] || return 1
  printf '%s\n' "$out"
}

# The digest of that manifest. Content and relative path only: no timestamps, no inode numbers,
# no absolute paths, so the value is the same on the box that published it, on the box that
# verifies it, and in a clean reproduction from the release.
_fence_tree_digest() {
  local manifest out
  manifest="$(_fence_tree_manifest "$1")" || return 1
  # printf '%s\n', not '%s': the manifest as a byte stream ENDS IN A NEWLINE, because that is
  # what `xargs sha256sum` emits and therefore what ${DB_FENCE_ARTEFACT_RECIPE} hashes. Command
  # substitution above stripped it; dropping it here instead would give a value no operator
  # running the documented command could ever reproduce.
  out="$(printf '%s\n' "$manifest" | sha256sum 2>/dev/null)" || return 1
  out="${out%% *}"
  fence_valid_sha256 "$out" || return 1
  printf '%s' "$out"
}

# IS THIS TREE STILL SOMETHING ONLY ROOT COULD HAVE WRITTEN?
#
# Two questions, and both of them are about what the digest CANNOT see:
#
#   1. Is everything a regular file or a directory? A symlink is not hashed by the manifest and
#      is still followed by node, so a tree containing one has an executable surface its digest
#      does not cover — which is precisely the defect this round closes, re-entering by the back
#      door. Devices, fifos and sockets are refused for the same reason.
#   2. Is everything owned by the account doing the publishing, and writable by nobody else? Under
#      root — which is every production path — that is "root-owned, no group or other write", and
#      it is what makes the digest a detector rather than the whole control: the application
#      account cannot alter these bytes at all, so a mismatch means something else went wrong.
#
# The ownership test is against the CURRENT euid rather than literal root so that the test suite
# exercises the real function; in production the current euid is 0 (all three entrypoints refuse
# to run otherwise) and the two are the same statement.
_fence_tree_is_sealed() {
  local root="$1" offender uid
  DB_FENCE_SEAL_REASON=""
  [[ -d "$root" ]] || { DB_FENCE_SEAL_REASON="${root} is not a directory"; return 1; }
  uid="$(id -u)" || return 1

  offender="$(find "$root" \( ! -type d -a ! -type f \) -print -quit 2>/dev/null)" || return 1
  if [[ -n "$offender" ]]; then
    DB_FENCE_SEAL_REASON="${offender} is neither a regular file nor a directory. The artefact digest is taken over regular files only, so a symlink, device or socket inside the protected tree is executable surface the digest does not cover — which is the substitution this mechanism exists to close. Nothing was published and nothing will be executed from ${root}."
    return 1
  fi

  offender="$(find "$root" \( ! -uid "${uid}" -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  if [[ -n "$offender" ]]; then
    DB_FENCE_SEAL_REASON="${offender} inside the protected tree is not owned by uid ${uid} or is writable by group or other, so the account this protection is against could rewrite it between the digest check and the exec. Nothing was published and nothing will be executed from ${root}."
    return 1
  fi
  return 0
}

# The root-owned directory the artefact lives in, created with the modes the fence needs.
_fence_protected_dir_ready() {
  mkdir -p "${DB_FENCE_RECOVERY_DIR}" || return 1
  chown root:root "${DB_FENCE_RECOVERY_DIR}" 2>/dev/null || true
  chmod 755 "${DB_FENCE_RECOVERY_DIR}" || return 1
  return 0
}

# ---------------------------------------------------------------------------
# VENDORING
# ---------------------------------------------------------------------------

# Node's own resolver, asked one question and given no chance to run anything: WHICH DIRECTORIES
# does the entry file's import graph resolve to? `require.resolve` and `readFileSync` of a
# package.json execute no package code, and the answer is checked before it is used —
#
#   * every directory must be inside ${app_dir} after realpath, so a node_modules entry that is a
#     symlink out of the checkout is a refusal rather than a silent copy of somewhere else;
#   * a specifier that will not resolve is a refusal, because a tree missing an import is a fence
#     that dies at exec, and discovering that after the rename would leave exactly that standing.
#
# The program is authored by THIS FILE — which root read in the same instant as the entrypoint —
# written into a directory this call already owns, and run from there. It is never read out of the
# checkout.
#
# ${app_dir} is dirname(dirname(${DB_FENCE_SCRIPT})) in every caller, so the entry file the
# resolution starts from is ${DB_FENCE_SCRIPT} itself. That is an invariant of the shipped layout
# rather than a second opinion about it: the mirror only works at all because the helper sits at
# <app>/scripts/, and a checkout where it does not is one whose imports would resolve differently
# from the mirror's in any case.
#
# THE ANSWER GOES TO A FILE, NOT TO STDOUT. Every caller would otherwise read it through a
# command substitution, and DB_FENCE_ROTATION_NOTE set inside one dies with the subshell — which
# is how the first version of this reported "could not be vendored" and swallowed the reason.
_fence_vendor_closure() {
  local app_dir="$1" scratch="$2" out_file="$3" program rc=0 out
  shift 3
  # THE SCRATCH DIRECTORY IS THE CALLER'S, and it is always one this call already owns — the
  # staging tree for a publication, the throwaway snapshot for a dry run. It was
  # ${DB_FENCE_RECOVERY_DIR}, which made the DRY-RUN probe create a directory under /etc; a dry
  # run writes nothing, least of all there, and that is the property the probe exists to keep.
  program="${scratch}/.fence-closure.cjs"
  mkdir -p "${scratch}" || return 1
  cat > "${program}" <<'CLOSURE_EOF' || return 1
'use strict'
const { createRequire } = require('module')
const fs = require('fs')
const path = require('path')

const appDir = path.resolve(process.argv[2])
const roots = process.argv.slice(3)
const entry = path.join(appDir, 'scripts', 'fence-db-connections.mjs')
const seen = new Set()
const out = []

function packageDirectory(name, fromFile) {
  const req = createRequire(fromFile)
  let manifest = null
  try {
    manifest = req.resolve(name + '/package.json')
  } catch (error) {
    // A package whose "exports" hides ./package.json still has one; walk node_modules by hand.
    let dir = path.dirname(fromFile)
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name, 'package.json')
      if (fs.existsSync(candidate)) { manifest = candidate; break }
      const up = path.dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
  return path.dirname(fs.realpathSync(manifest))
}

function walk(name, fromFile) {
  const dir = packageDirectory(name, fromFile)
  if (!dir) throw new Error(`${name} could not be resolved from ${fromFile}`)
  if (seen.has(dir)) return
  seen.add(dir)
  const relative = path.relative(appDir, dir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} resolves to ${dir}, which is outside ${appDir}`)
  }
  out.push(relative)
  const manifest = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  for (const dependency of Object.keys(pkg.dependencies || {})) walk(dependency, manifest)
  for (const dependency of Object.keys(pkg.optionalDependencies || {})) {
    // Optional by declaration: absent is normal (pg-cloudflare off Workers), and `pg` guards it.
    try { walk(dependency, manifest) } catch (error) { /* not installed */ }
  }
}

try {
  for (const root of roots) walk(root, entry)
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + '\n')
  process.exit(1)
}
out.sort()
process.stdout.write(out.length ? out.join('\n') + '\n' : '')
CLOSURE_EOF
  chmod 600 "${program}" 2>/dev/null || true
  out="$(node "${program}" "${app_dir}" "$@" 2>&1)" || rc=$?
  rm -f "${program}"
  if [[ "${rc}" -ne 0 ]]; then
    DB_FENCE_ROTATION_NOTE="the fence helper's dependency closure could not be resolved from ${app_dir}, so no self-contained artefact could be built: ${out}"
    return 1
  fi
  printf '%s\n' "${out}" > "${out_file}" || return 1
  return 0
}

# ---------------------------------------------------------------------------
# COULD ANYONE BUT THE PUBLISHER HAVE CHOSEN THESE BYTES?
#
# o3d-2sm1.5 r33, Codex CRITICAL, and it is the r32 finding one level up. r32 made the artefact
# self-contained and gave it a whole-tree digest — which authenticates the tree FROM THE MOMENT IT
# IS RECORDED. It does not authenticate what the tree was first assembled from. IMS_FENCE_SCRIPT_SHA256
# covers the ENTRY FILE; the closure is taken from ${APP_DIR}/node_modules; so an account that can
# write there can leave the legitimate helper untouched, replace one file inside `pg`, and have the
# substitution sealed, digested and recorded as the trusted artefact. `pg` is imported before
# main() runs, so those bytes can report a fence that was never raised and hand back a migration
# URL of their own. The recorded digest then detects every LATER change to bytes it should never
# have trusted in the first place.
#
# So a publication asks this — AFTER the copy, see _fence_vendor_into() — and the answer is a
# property of the source paths rather than a judgement about them:
#
#   * the entry file, and every directory the vendoring walks through to reach a package, and
#   * every file and directory inside every package that is copied
#
# must be owned by the publishing account — uid 0 in production, since all three entrypoints
# refuse to run as anything else — and writable by nobody else. Anything else and the source is
# APPLICATION-WRITABLE, which is the case this entire file exists for.
#
# AND EVERY ANCESTOR ABOVE ${app_dir}, UP TO / (o3d-2sm1.5 r34, Codex HIGH). r33 asked about
# ${app_dir} and everything under it and stopped there, which leaves the question begged: rename
# permission in Unix belongs to the CONTAINING directory, so an application account that can write
# ${app_dir}'s parent can move a root-owned, mode-clean tree aside and put its own in its place —
# and every check below then passes over bytes it chose, with the script-only pin accepted and
# nothing reported as untrusted. The parent chain is walked over the RESOLVED path, and with two
# stated relaxations (uid 0, and world-writable-but-sticky) that are the difference between a rule
# and a rule nobody can satisfy.
#
# Those directories are checked at depth 0 only. Descending them would walk the whole application
# directory, which says nothing: what matters about a directory on the way to a package is whether
# somebody else can swap what is IN it.
#
# It names the FIRST offending path rather than counting them, because an operator acts on a path.
# A find that cannot stat what it was asked about is a failure, not a pass: this is the one
# question whose "no answer" must never read as "no problem".
# ---------------------------------------------------------------------------
# THE PATH LISTS, DERIVED ONCE AND ASKED TWO DIFFERENT QUESTIONS. _fence_source_trust() asks who
# can write them; _fence_source_ident() asks whether they are still the same objects afterwards.
# One derivation, because two derivations of "which paths is this about" is the one-rule-several-
# readers defect this whole file exists to avoid.
#
#   _FENCE_SRC_STRICT    ${app_dir}, the entry file's directory, and every directory the vendoring
#                        walks THROUGH to reach a package. Depth 0 only: descending them would walk
#                        the whole application directory, which says nothing — what matters about a
#                        directory on the way to a package is whether somebody else can swap what
#                        is IN it.
#   _FENCE_SRC_PACKAGES  the entry file and the package roots themselves, examined recursively.
#   _FENCE_SRC_PARENTS   every directory from ${app_dir}'s parent up to /.
_FENCE_SRC_STRICT=()
_FENCE_SRC_PACKAGES=()
_FENCE_SRC_PARENTS=()

_fence_source_paths() {
  local app_dir="$1" list="$2" relative acc part resolved
  _FENCE_SRC_STRICT=("${app_dir}" "$(dirname "${DB_FENCE_SCRIPT}")")
  _FENCE_SRC_PACKAGES=("${DB_FENCE_SCRIPT}")
  _FENCE_SRC_PARENTS=()
  while IFS= read -r relative; do
    [[ -n "${relative}" ]] || continue
    acc="${app_dir}"
    while [[ "${relative}" == */* ]]; do
      part="${relative%%/*}"
      relative="${relative#*/}"
      acc="${acc}/${part}"
      _FENCE_SRC_STRICT+=("${acc}")
    done
    _FENCE_SRC_PACKAGES+=("${acc}/${relative}")
  done < "${list}"
  # THE PARENT CHAIN IS WALKED OVER THE RESOLVED PATH. A symlink component would otherwise be
  # stat'ed as a symlink — mode 0777 on Linux, which every mode test would call world-writable —
  # while the directory it actually names went unexamined. Resolving first asks about the objects
  # the copy will really read through; each symlink on the way is itself an entry in one of the
  # resolved directories, so nothing drops out of the question by being resolved.
  resolved="$(realpath -e -- "${app_dir}" 2>/dev/null)" || resolved="${app_dir}"
  while :; do
    resolved="$(dirname -- "${resolved}")"
    _FENCE_SRC_PARENTS+=("${resolved}")
    [[ "${resolved}" == "/" ]] && break
  done
  return 0
}

_fence_source_trust() {
  local app_dir="$1" list="$2" uid offender
  DB_FENCE_SOURCE_UNTRUSTED_PATH=""
  uid="$(id -u)" || return 1
  _fence_source_paths "${app_dir}" "${list}" || return 1

  offender="$(find "${_FENCE_SRC_STRICT[@]}" -maxdepth 0 \( ! -uid "${uid}" -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  if [[ -z "${offender}" ]]; then
    offender="$(find "${_FENCE_SRC_PACKAGES[@]}" \( ! -uid "${uid}" -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  fi
  if [[ -z "${offender}" ]]; then
    # THE ANCESTORS, ALL THE WAY UP (o3d-2sm1.5 r34, Codex HIGH). A root-owned, mode-clean
    # ${app_dir} says nothing while the account being defended against can write its PARENT: Unix
    # gives rename permission to the CONTAINING directory, so that account can move the whole
    # subtree aside and put its own there, and every check below ${app_dir} then passes over a tree
    # it wrote. So every directory from ${app_dir}'s parent to / is asked the same question.
    #
    # TWO DELIBERATE RELAXATIONS, because the strict rule above would refuse every real box:
    #   * uid 0 is accepted as well as the publishing account's own. root can replace anything on
    #     this filesystem whatever the modes say; a rule that called /usr or /home untrusted for
    #     being root-owned would be a refusal nobody can satisfy, which is the failure mode this
    #     round is explicitly under instructions to avoid.
    #   * a group- or world-writable directory carrying the STICKY BIT is accepted. /tmp is 1777,
    #     and sticky is precisely the kernel saying "only the owner of an entry may rename or
    #     remove it" — the rename this check exists to stop is the one sticky already forbids.
    offender="$(find "${_FENCE_SRC_PARENTS[@]}" -maxdepth 0 \
      \( \( ! -uid "${uid}" -a ! -uid 0 \) -o \( -perm /022 -a ! -perm -1000 \) \) -print -quit 2>/dev/null)" || return 1
  fi
  [[ -z "${offender}" ]] || DB_FENCE_SOURCE_UNTRUSTED_PATH="${offender}"
  return 0
}

# THE SOURCE AS THE KERNEL SEES IT: device, inode, owner and mode for every path the provenance
# answer is about. Taken before the copy and again after it, and compared.
#
# A rename changes neither a path, nor an owner, nor a mode — it changes which OBJECT the path
# names. That is invisible to _fence_source_trust() run twice and visible here, because the inode
# moves. It is the half of the r34 HIGH the ancestor walk alone does not close: the walk decides
# whether the swap is POSSIBLE, this decides whether it HAPPENED under the copy.
_fence_source_ident() {
  find "${_FENCE_SRC_STRICT[@]}" "${_FENCE_SRC_PACKAGES[@]}" "${_FENCE_SRC_PARENTS[@]}" \
    -maxdepth 0 -printf '%p %D %i %U %m\n' 2>/dev/null | LC_ALL=C sort
}

# Copy that closure into the staged tree at the SAME relative paths, so node's walk inside the
# mirror finds exactly what it finds inside the checkout — nesting included.
#
# --no-dereference on purpose: a symlink in the source is copied AS a symlink and then refused by
# _fence_tree_is_sealed(), which names it. Following it instead would quietly pull the target's
# bytes into the artefact and hide the escape, and hiding it is worse than the symlink.
#
# Parents are copied before children (the closure is sorted, and `node_modules/pg-types` sorts
# before `node_modules/pg-types/node_modules/...`), so a nested package already inside a copied
# parent is skipped rather than copied into itself.
_fence_vendor_into() {
  local app_dir="$1" staged="$2" list relative count rc=0 before after
  list="${staged}/.fence-closure.list"
  mkdir -p "${staged}" || return 1
  rm -f "${list}"
  _fence_vendor_closure "${app_dir}" "${staged}" "${list}" "${DB_FENCE_VENDOR_ROOTS[@]}" || { rm -f "${list}"; return 1; }
  if [[ ! -s "${list}" ]]; then
    rm -f "${list}"
    DB_FENCE_ROTATION_NOTE="the fence helper's dependency closure resolved to nothing at all from ${app_dir}, which cannot be right while it still imports ${DB_FENCE_VENDOR_ROOTS[*]}"
    return 1
  fi

  # COPY FIRST, THEN VERIFY WHAT WAS COPIED (o3d-2sm1.5 r34, Codex HIGH). The provenance question
  # used to be asked BEFORE the copy, which is a check with a window after it: the application
  # account renames the examined subtree aside between the answer and the `cp`, and the bytes that
  # land in the staging tree are not the bytes that were judged. So the order is inverted. The
  # copy is harmless on its own — the staging tree is root-owned, nothing executes it, and nothing
  # is published until the caller has read the answer below — and it is the copy that fixes which
  # bytes are under discussion.
  #
  # The identity snapshot is taken before it and again after it. Ownership and modes alone cannot
  # see a rename, because a rename preserves both; the inode does not survive one.
  _fence_source_paths "${app_dir}" "${list}" || {
    rm -f "${list}"
    DB_FENCE_ROTATION_NOTE="the paths the fence helper's dependency closure would be copied from could not be derived from ${app_dir}. Nothing was published."
    return 1
  }
  before="$(_fence_source_ident)"

  while IFS= read -r relative; do
    [[ -n "${relative}" ]] || continue
    [[ -e "${staged}/${relative}" ]] && continue
    mkdir -p "${staged}/$(dirname "${relative}")" || { rc=1; break; }
    cp -R --no-dereference -- "${app_dir}/${relative}" "${staged}/${relative}" || { rc=1; break; }
  done < "${list}"
  [[ "${rc}" -eq 0 ]] || { rm -f "${list}"; return 1; }

  # THE PROVENANCE OF WHAT IS NOW IN THE STAGING TREE. What the answer AUTHORISES is
  # _fence_stage_and_publish()'s business; establishing it is this function's, because this is
  # where the source paths are known and where the copy has just happened.
  if ! _fence_source_trust "${app_dir}" "${list}"; then
    rm -f "${list}"
    DB_FENCE_ROTATION_NOTE="the ownership and modes of the fence helper's dependency closure under ${app_dir} could not be read, so there is no answer to whether an account other than this one could have chosen those bytes. Nothing was published."
    return 1
  fi
  after="$(_fence_source_ident)"
  rm -f "${list}"
  if [[ -z "${before}" || "${before}" != "${after}" ]]; then
    DB_FENCE_ROTATION_NOTE="the source the fence helper's dependency closure was copied from under ${app_dir} is not the same set of filesystem objects it was when the copy started — a path was renamed, replaced or removed while root was reading it. The provenance answer would be about the tree that is there NOW and not about the bytes that were copied, so it authorises nothing. Nothing was published. Re-run when nothing else is writing to ${app_dir}."
    return 1
  fi

  count="$(find "${staged}" -type f 2>/dev/null | wc -l)" || return 1
  if [[ "${count}" -gt "${DB_FENCE_VENDOR_MAX_FILES}" ]]; then
    DB_FENCE_ROTATION_NOTE="the fence helper's dependency closure came to ${count} files, over the ${DB_FENCE_VENDOR_MAX_FILES} this will copy under ${DB_FENCE_RECOVERY_DIR}. A package manifest in the checkout can declare anything as a dependency, so this is a bound on what the application account can talk root into vendoring, not a bug in the closure. Nothing was published."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# PUBLICATION
# ---------------------------------------------------------------------------

# Assemble the WHOLE artefact under a staging name only root can write, seal it, digest it,
# require it to match whatever the invocation pinned, and only then rename it into place. The
# verified tree is the published tree: after the copy the checkout is never read again, so there
# is no interval in which it can change the outcome.
_fence_stage_and_publish() {
  local app_dir script_digest artefact_digest manifest
  [[ -f "${DB_FENCE_SCRIPT}" ]] || {
    DB_FENCE_ROTATION_NOTE="${DB_FENCE_SCRIPT} is not in this checkout, so there is nothing to publish into ${DB_FENCE_SCRIPT_COPY}"
    return 1
  }
  app_dir="$(dirname "$(dirname "${DB_FENCE_SCRIPT}")")"
  _fence_protected_dir_ready || return 1

  [[ -n "${DB_FENCE_STAGED_APP_DIR}" ]] || return 1
  rm -rf "${DB_FENCE_STAGED_APP_DIR}" || return 1
  mkdir -p "${DB_FENCE_STAGED_APP_DIR}/scripts" || return 1

  cat < "${DB_FENCE_SCRIPT}" > "${DB_FENCE_STAGED_APP_DIR}/scripts/fence-db-connections.mjs" || {
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1
  }
  script_digest="$(file_sha256 "${DB_FENCE_STAGED_APP_DIR}/scripts/fence-db-connections.mjs")" || {
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1
  }
  if [[ -n "${DB_FENCE_EXPECTED_SHA256}" ]] && [[ "${script_digest}" != "${DB_FENCE_EXPECTED_SHA256}" ]]; then
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_SCRIPT_SHA256 expects ${DB_FENCE_EXPECTED_SHA256} but ${DB_FENCE_SCRIPT} hashes to ${script_digest}, so it was NOT published to ${DB_FENCE_SCRIPT_COPY}"
    return 1
  fi

  # THE IMPORTS, BEFORE THE PUBLICATION AND NOT AFTER IT. A tree that cannot import `pg` is a
  # fence that dies at exec, and a failure discovered after the rename would leave exactly that
  # standing.
  if ! _fence_vendor_into "${app_dir}" "${DB_FENCE_STAGED_APP_DIR}"; then
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    [[ -n "${DB_FENCE_ROTATION_NOTE}" ]] || DB_FENCE_ROTATION_NOTE="the fence helper's dependency closure could not be vendored into ${DB_FENCE_PROTECTED_APP_DIR}"
    return 1
  fi

  chown -R root:root "${DB_FENCE_STAGED_APP_DIR}" 2>/dev/null || true
  chmod -R u=rwX,go=rX "${DB_FENCE_STAGED_APP_DIR}" || { rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1; }

  if ! _fence_tree_is_sealed "${DB_FENCE_STAGED_APP_DIR}"; then
    DB_FENCE_ROTATION_NOTE="${DB_FENCE_SEAL_REASON}"
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    return 1
  fi

  manifest="$(_fence_tree_manifest "${DB_FENCE_STAGED_APP_DIR}")" || { rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1; }
  artefact_digest="$(_fence_tree_digest "${DB_FENCE_STAGED_APP_DIR}")" || { rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1; }

  if [[ -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] && [[ "${artefact_digest}" != "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_ARTEFACT_SHA256 expects ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} but the artefact assembled from ${app_dir} hashes to ${artefact_digest}, so NOTHING was published to ${DB_FENCE_PROTECTED_APP_DIR}. The entry file hashes to ${script_digest}; the difference is therefore in the vendored dependency closure unless that value also differs."
    return 1
  fi

  # WHAT A PIN CAN AUTHENTICATE, AND WHAT NOTHING ON THIS BOX CAN (o3d-2sm1.5 r33/r34, Codex
  # CRITICAL twice).
  #
  # IMS_FENCE_SCRIPT_SHA256 authenticates the ENTRY FILE. That is a whole statement about a tenth
  # of what executes, and it is sufficient BY ITSELF only when the rest of the tree came from a
  # source the publishing account already owns outright.
  #
  # r33 refused THAT case and let the case with NO pin at all through, as trust on first use with
  # a loud warning. Codex overruled it, and the ruling is right: a warning nobody has to
  # acknowledge does not make unauthenticated privileged code execution safe, and this artefact is
  # handed DEPLOY_ADMIN_DATABASE_URL on every path it runs. The hidden premise in the r33 argument
  # was that the digest can only come from a PRIOR PUBLICATION — so a release nobody had deployed
  # anywhere could never start. It can also SHIP WITH THE RELEASE, which is where it comes from
  # now, and the refusal below says so in the words an operator needs at the moment they read it.
  #
  # So: an application-writable source and no whole-tree pin is a REFUSAL, on the first
  # publication and on every one after it. The two ways out are both stated in the message,
  # because a refusal whose precondition nobody can satisfy is worse than the finding it closes.
  if [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" && -n "${DB_FENCE_SOURCE_UNTRUSTED_PATH}" ]]; then
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    if [[ -n "${DB_FENCE_EXPECTED_SHA256}" ]]; then
      DB_FENCE_ROTATION_NOTE="IMS_FENCE_SCRIPT_SHA256 IS NOT SUFFICIENT HERE, so NOTHING was published to ${DB_FENCE_PROTECTED_APP_DIR}. It authenticates the entry file only — ${script_digest}, which did match — and the artefact also vendors that helper's dependency closure out of ${app_dir}, where ${DB_FENCE_SOURCE_UNTRUSTED_PATH} is owned or writable by an account other than this one. Leaving the entry file alone and replacing one file inside a vendored package would therefore have been sealed, digested and recorded as trusted. Re-run supplying IMS_FENCE_ARTEFACT_SHA256=<digest of the WHOLE tree> as well. ${DB_FENCE_ARTEFACT_SOURCE_TEXT} FOR INFORMATION ONLY, the tree assembled from ${app_dir} just now hashes to ${artefact_digest} — that value is REPORTED AND NOT AUTHENTICATED, it is what the checkout being questioned says about itself, so compare it against the release before pinning it."
      return 1
    fi
    DB_FENCE_ROTATION_NOTE="NOTHING AUTHENTICATED THIS ARTEFACT, so NOTHING was published to ${DB_FENCE_PROTECTED_APP_DIR}. The entry file and the whole vendored dependency closure would have been taken from ${app_dir}, where ${DB_FENCE_SOURCE_UNTRUSTED_PATH} is owned or writable by an account other than this one — and what is published here is executed with DEPLOY_ADMIN_DATABASE_URL beside it, four times across a cutover. Publishing it unpinned would be promoting bytes that account chose and then protecting them, which is the attack this mechanism exists to close and not a first-use exemption from it. Re-run supplying IMS_FENCE_ARTEFACT_SHA256=<digest of the WHOLE tree>. ${DB_FENCE_ARTEFACT_SOURCE_TEXT} FOR INFORMATION ONLY, the tree assembled from ${app_dir} just now hashes to ${artefact_digest} — that value is REPORTED AND NOT AUTHENTICATED, it is what the checkout being questioned says about itself, so it can CONFIRM a digest that came from the release and must never stand in for one."
    return 1
  fi

  # THE SWAP. The previous tree is moved aside rather than deleted, so a failure between the two
  # renames leaves the OLD artefact standing — which still fences — rather than none, which does
  # not.
  [[ -n "${DB_FENCE_RETIRED_APP_DIR}" ]] || return 1
  rm -rf "${DB_FENCE_RETIRED_APP_DIR}" || return 1
  if [[ -e "${DB_FENCE_PROTECTED_APP_DIR}" ]]; then
    mv -f "${DB_FENCE_PROTECTED_APP_DIR}" "${DB_FENCE_RETIRED_APP_DIR}" || { rm -rf "${DB_FENCE_STAGED_APP_DIR}"; return 1; }
  fi
  if ! mv -f "${DB_FENCE_STAGED_APP_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}"; then
    [[ -e "${DB_FENCE_RETIRED_APP_DIR}" ]] && mv -f "${DB_FENCE_RETIRED_APP_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}" 2>/dev/null
    rm -rf "${DB_FENCE_STAGED_APP_DIR}"
    return 1
  fi
  rm -rf "${DB_FENCE_RETIRED_APP_DIR}"

  # The record LAST, and only once the tree it describes is the one on disk. A digest published
  # ahead of its tree is a refusal on the next run.
  printf 'fence_artefact_sha256=%s\nfence_script_sha256=%s\nfence_artefact_recipe=%s\nfence_artefact_complete=1\n' \
    "${artefact_digest}" "${script_digest}" "${DB_FENCE_ARTEFACT_RECIPE}" \
    | _fence_publish_file "${DB_FENCE_ARTEFACT_FILE}" || return 1
  printf '%s\n' "${manifest}" | _fence_publish_file "${DB_FENCE_MANIFEST_FILE}" || return 1
  chown root:root "${DB_FENCE_ARTEFACT_FILE}" "${DB_FENCE_MANIFEST_FILE}" 2>/dev/null || true
  _fence_fsync_path "${DB_FENCE_RECOVERY_DIR}" || return 1
  return 0
}

# The artefact digest the standing record binds, from a COMPLETE record and nowhere else.
fence_record_artefact_digest() {
  local digest
  [[ -f "${DB_FENCE_ARTEFACT_FILE}" ]] || return 1
  grep -qE '^fence_artefact_complete=1$' "${DB_FENCE_ARTEFACT_FILE}" 2>/dev/null || return 1
  digest="$(grep -m1 -E '^fence_artefact_sha256=' "${DB_FENCE_ARTEFACT_FILE}" 2>/dev/null)" || return 1
  digest="${digest#fence_artefact_sha256=}"
  fence_valid_sha256 "${digest}" || return 1
  printf '%s' "${digest}"
}

# THE ONLY WRITER of ${DB_FENCE_PROTECTED_APP_DIR}, and it refuses to overwrite one from the
# checkout.
#
# Returns 0 when an artefact is standing afterwards — whether this call published it, rotated it,
# or left the existing one alone — and 1 when there is none and none could be made.
publish_fence_script_copy() {
  local existing="" candidate=""
  DB_FENCE_ROTATION_NOTE=""

  if [[ -n "${DB_FENCE_EXPECTED_SHA256}" ]] && ! fence_valid_sha256 "${DB_FENCE_EXPECTED_SHA256}"; then
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_SCRIPT_SHA256='${DB_FENCE_EXPECTED_SHA256}' is not a sha256 digest (64 lowercase hex characters). Refusing to treat it as one."
    return 1
  fi
  if [[ -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] && ! fence_valid_sha256 "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}"; then
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_ARTEFACT_SHA256='${DB_FENCE_EXPECTED_ARTEFACT_SHA256}' is not a sha256 digest (64 lowercase hex characters). Refusing to treat it as one."
    return 1
  fi

  if [[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    # BOOTSTRAP. Nothing this mechanism ever published is standing, so there is nothing here to
    # substitute FOR; an expected digest, if the operator supplied one, still has to match — and
    # IMS_FENCE_SCRIPT_SHA256 on its own does NOT match enough, which _fence_stage_and_publish()
    # refuses. A bootstrap with no pin at all is trust on first use and returns saying so in
    # ${DB_FENCE_ROTATION_NOTE}, which the caller prints.
    _fence_stage_and_publish || return 1
    return 0
  fi

  existing="$(file_sha256 "${DB_FENCE_SCRIPT_COPY}")" || existing=""

  if [[ -z "${DB_FENCE_EXPECTED_SHA256}" && -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    # THE CHECKOUT DOES NOT GET TO PROMOTE ITSELF. Say so when the two differ, and say what a
    # legitimate rotation would be, then use the artefact that is already there.
    if [[ -f "${DB_FENCE_SCRIPT}" ]]; then
      candidate="$(file_sha256 "${DB_FENCE_SCRIPT}")" || candidate=""
      if [[ -n "${candidate}" && -n "${existing}" && "${candidate}" != "${existing}" ]]; then
        DB_FENCE_ROTATION_NOTE="${DB_FENCE_SCRIPT} (${candidate}) differs from the protected copy at ${DB_FENCE_SCRIPT_COPY} (${existing}) and was NOT promoted: the checkout is application-owned and cannot authenticate itself. To adopt it deliberately, re-run with BOTH IMS_FENCE_SCRIPT_SHA256=<digest of the release's entry file> and IMS_FENCE_ARTEFACT_SHA256=<digest of the whole artefact tree>, taken from the release and not from this box — the entry-file digest alone does not cover the dependency closure this would also republish out of the checkout, and is refused on its own here. Or discard the artefact and let the next run bootstrap: ${DB_FENCE_SUDO_PREFIX}rm -rf ${DB_FENCE_PROTECTED_APP_DIR}"
      fi
    fi
    return 0
  fi

  if [[ -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    # THE STRONGER PIN DECIDES. If the standing artefact already hashes to what the invocation
    # asked for, there is nothing to rotate whatever the entry file's own digest says.
    local standing=""
    standing="$(fence_record_artefact_digest)" || standing=""
    if [[ -n "${standing}" && "${standing}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
      if [[ -z "${DB_FENCE_EXPECTED_SHA256}" || "${existing}" == "${DB_FENCE_EXPECTED_SHA256}" ]]; then
        return 0
      fi
    fi
  elif [[ "${existing}" == "${DB_FENCE_EXPECTED_SHA256}" ]]; then
    # Already the version the operator asked for. Nothing to rotate, and nothing to warn about.
    return 0
  fi

  # AN AUTHENTICATED ROTATION, and not while a fence may be standing: the release restores grants
  # from a record the raise wrote, and swapping versions across that pair is how a release stops
  # meaning what the fence meant.
  if [[ -n "${DB_FENCE_STATE:-}" && -f "${DB_FENCE_STATE:-}" ]]; then
    DB_FENCE_ROTATION_NOTE="a connection fence is recorded at ${DB_FENCE_STATE}, so the fence helper was NOT rotated: the version that raised a standing fence is the version that must release it. Release the fence first, then re-run with IMS_FENCE_SCRIPT_SHA256."
    return 0
  fi

  _fence_stage_and_publish || return 1
  # THE RECORD'S DIGEST MOVES WITH THE FILE IT NAMES. Leaving it behind would make
  # db_fence_script_in_use() refuse every subsequent run — a rotation that bricks the mechanism is
  # not a rotation. Only the digest line is touched; the identity of the fence that record
  # describes is not this run's to restate.
  _fence_rewrite_record_digest "$(file_sha256 "${DB_FENCE_SCRIPT_COPY}")" || return 1
  DB_FENCE_ROTATION_NOTE="the protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} was rotated: the entry file is now $(file_sha256 "${DB_FENCE_SCRIPT_COPY}") and the whole tree hashes to $(fence_record_artefact_digest), which are the digests this invocation authenticated."
  return 0
}

# Replace ONLY the fence_script_sha256 line of a complete recovery record, keeping every other
# line and the terminating sentinel exactly where they were. A record with no such line, or no
# record at all, is left alone: there is then nothing bound to the old file.
_fence_rewrite_record_digest() {
  local digest="$1" rewritten
  fence_valid_sha256 "${digest}" || return 1
  fence_record_script_digest >/dev/null 2>&1 || return 0
  rewritten="$(awk -v d="${digest}" '
    /^fence_script_sha256=/ { print "fence_script_sha256=" d; next }
    { print }
  ' "${DB_FENCE_IDENTITY_FILE}" 2>/dev/null)" || return 1
  [[ -n "${rewritten}" ]] || return 1
  printf '%s\n' "${rewritten}" | _fence_publish_file "${DB_FENCE_IDENTITY_FILE}" || return 1
  chown root:root "${DB_FENCE_IDENTITY_FILE}" 2>/dev/null || true
  chmod 644 "${DB_FENCE_IDENTITY_FILE}" || return 1
  return 0
}

# WHICH COPY OF THE FENCE HELPER THIS RUN MAY EXECUTE. It is always the root-owned one, and it is
# only ever executed out of a tree that has just been proved sealed and whole.
#
# ${DB_FENCE_SCRIPT} IS NEVER EXECUTED FROM ITS OWN PATH. Every caller hands the result
# DEPLOY_ADMIN_DATABASE_URL and runs it — preflight, fence, migration-URL composition, release and
# the exit trap's re-fence, in all three entrypoints.
#
# Prints the path it chose; on failure prints the reason on stderr and returns non-zero. The
# reason goes to stderr because every caller reads this through a command substitution, and a
# global set inside one dies with the subshell.
db_fence_script_in_use() {
  local recorded actual recorded_artefact actual_artefact

  # THE RECORD IS READ BEFORE ANYTHING IS PUBLISHED. A record naming a copy that is GONE is not a
  # bootstrap: only root can delete out of the protected directory, so it is a state the
  # application account cannot have produced, and minting a fresh copy from the checkout there
  # would both promote application bytes and leave a copy that can never match the record again.
  recorded="$(fence_record_script_digest)" || recorded=""
  if [[ -n "${recorded}" ]] && [[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    echo "The recovery record binds this fence to the root-owned fence script at ${DB_FENCE_SCRIPT_COPY}, and that file is gone. Only root can remove it, so this is not a state the application account can have produced." >&2
    return 1
  fi

  # Publication SECOND, and it overwrites nothing that already exists.
  if ! publish_fence_script_copy; then
    echo "The protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} could not be established: ${DB_FENCE_ROTATION_NOTE:-no reason was recorded}." >&2
    return 1
  fi
  if [[ -n "${DB_FENCE_ROTATION_NOTE}" ]]; then echo "${DB_FENCE_ROTATION_NOTE}" >&2; fi

  # Re-read: an authenticated rotation moves the record's digest with the file it names.
  recorded="$(fence_record_script_digest)" || recorded=""

  if [[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    echo "Neither a root-owned fence script at ${DB_FENCE_SCRIPT_COPY} nor ${DB_FENCE_SCRIPT} could be used." >&2
    return 1
  fi

  # THE WHOLE TREE, NOT THE ENTRY FILE (o3d-2sm1.5 r32, Codex CRITICAL). Everything below runs
  # before the path is handed back, because the path is handed straight to `node` with an
  # administrative database credential beside it.
  if ! _fence_tree_is_sealed "${DB_FENCE_PROTECTED_APP_DIR}"; then
    echo "The protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} is not sealed, so it will not be executed: ${DB_FENCE_SEAL_REASON}" >&2
    return 1
  fi

  recorded_artefact="$(fence_record_artefact_digest)" || recorded_artefact=""
  if [[ -z "${recorded_artefact}" ]]; then
    echo "There is no complete artefact record at ${DB_FENCE_ARTEFACT_FILE}, so nothing says what ${DB_FENCE_PROTECTED_APP_DIR} is supposed to hash to and the tree cannot be authenticated. Discard it and let the next run republish — ${DB_FENCE_SUDO_PREFIX}rm -rf ${DB_FENCE_PROTECTED_APP_DIR} — or supply IMS_FENCE_ARTEFACT_SHA256." >&2
    return 1
  fi
  actual_artefact="$(_fence_tree_digest "${DB_FENCE_PROTECTED_APP_DIR}")" || actual_artefact=""
  if [[ "${actual_artefact}" != "${recorded_artefact}" ]]; then
    echo "The protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} is not the tree its record binds (record: ${recorded_artefact}; tree: ${actual_artefact:-unreadable}). Refusing to run it. ${DB_FENCE_MANIFEST_FILE} lists the per-file digests: \`cd ${DB_FENCE_PROTECTED_APP_DIR} && sha256sum -c ${DB_FENCE_MANIFEST_FILE}\` names which file moved." >&2
    return 1
  fi
  if [[ -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" && "${recorded_artefact}" != "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    echo "IMS_FENCE_ARTEFACT_SHA256 expects ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} but the standing artefact at ${DB_FENCE_PROTECTED_APP_DIR} is ${recorded_artefact}. Refusing to run a tree this invocation did not authenticate." >&2
    return 1
  fi

  if [[ -n "${recorded}" ]]; then
    actual="$(file_sha256 "${DB_FENCE_SCRIPT_COPY}")" || actual=""
    if [[ "${actual}" != "${recorded}" ]]; then
      echo "The root-owned fence script at ${DB_FENCE_SCRIPT_COPY} is not the one the recovery record binds to this fence (record: ${recorded}; file: ${actual:-unreadable}). Refusing to run it." >&2
      return 1
    fi
  fi

  printf '%s' "${DB_FENCE_SCRIPT_COPY}"
  return 0
}

# ---------------------------------------------------------------------------
# THE TWO COMMANDS AN OPERATOR IS EVER GIVEN (o3d-2sm1.5 r32, Codex HIGH x2)
#
# Both findings were the same defect: the code was fixed and the operator-facing text still
# described the old world. The printed release command named the protected copy but had no way to
# obtain DEPLOY_ADMIN_DATABASE_URL — the helper's `.env` load resolved against the MIRROR, which
# has no `.env`, so the one command offered for taking a committed fence down could not open the
# connection that takes it down. And the re-fence banner, printed at the single highest-pressure
# moment in the whole script — schema moved, fence down — still said
# `node ${DB_FENCE_SCRIPT} --fence`, which is the application-owned path.
#
# So nothing prints a command line any more. Root writes two WRAPPERS, and the banners print an
# instruction that runs them:
#
#   ${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}   release the standing fence
#   ${DB_FENCE_SUDO_PREFIX}${DB_FENCE_REFENCE_WRAPPER}   raise it again
#
# THE PREFIX IS NOT DECORATION (o3d-2sm1.5 r33, Codex HIGH). r32 asked of every printed line
# "would it run if pasted?" and answered yes for these — correctly for root, and wrongly for the
# person most likely to be reading them. The wrappers are root-owned and 0700; an operator who
# launched the cutover as `sudo bash scripts/update.sh` reads the banner in a NON-ROOT shell and a
# bare path gives them `Permission denied` at the one moment there is no time to debug it. The
# question is therefore asked as: would this run when pasted BY THE ACCOUNT THAT READS IT.
#
# The mode stays 0700 and root-owned rather than being opened to the application account: the
# whole point of the artefact is that the account being defended against does not get to choose
# what runs with DEPLOY_ADMIN_DATABASE_URL beside it, and an executable-by-the-app-user wrapper is
# a file that account can at least invoke at a moment of its choosing. The identity gate inside
# stays too — a mode is not a proof, and the gate is what holds if one ever changes.
#
# Each one:
#   * is root-owned and 0700, written by root, and NEVER sources this library from the checkout —
#     everything it needs is baked in at publication, because a recovery command that reads
#     application-owned code is the finding it exists to close;
#   * carries this run's state file and connection identity, so there is nothing to fill in;
#   * takes DEPLOY_ADMIN_DATABASE_URL from its own environment, and falls back to the same
#     ${APP_DIR}/.env the entrypoints read, with the same one-key reader — so the paste works with
#     no arguments on a normal box, and says exactly what to set when it does not;
#   * re-verifies the artefact digest before exec, with the digest inlined, so a wrapper left
#     behind after the tree changed refuses instead of running something else;
#   * execs as the application user, which is who the in-script paths run the helper as and who
#     the state file has to be releasable by.
# ---------------------------------------------------------------------------
db_fence_publish_operator_wrappers() {
  local app_user="$1" env_file="$2" state_file="$3" artefact_digest
  shift 3
  _fence_protected_dir_ready || return 1
  artefact_digest="$(fence_record_artefact_digest)" || return 1

  local identity="" arg
  for arg in "$@"; do
    [[ -n "${arg}" ]] || continue
    identity+=" $(printf '%q' "${arg}")"
  done

  # LOWERCASE NAMES INSIDE THE GENERATED SCRIPT, deliberately. The wrapper body below is a
  # QUOTED heredoc — bash writes it out, it does not expand it — but the repository's `set -u`
  # guards scan this library line by line for `${NAME}` in capitals and cannot tell a written
  # name from an expanded one. Capitals here would make those guards report names that nothing
  # in this shell ever reads, and a guard that reports false names is a guard that gets switched
  # off. The one capitalised name in the wrapper is DEPLOY_ADMIN_DATABASE_URL, which is a real
  # environment variable in both scripts.
  local mode
  for mode in release fence; do
    local target="${DB_FENCE_RELEASE_WRAPPER}"
    [[ "${mode}" == "fence" ]] && target="${DB_FENCE_REFENCE_WRAPPER}"
    {
      printf '#!/bin/bash\n'
      printf '# GENERATED BY scripts/lib/db-fence-protected.sh. Root-owned, and deliberately\n'
      printf '# self-contained: it reads nothing out of the application checkout except the\n'
      printf '# credential in %s, which is where the deploy reads it from too.\n' "${env_file}"
      printf 'set -uo pipefail\n'
      printf 'app_env_file=%q\n' "${env_file}"
      printf 'app_account=%q\n' "${app_user}"
      printf 'protected_dir=%q\n' "${DB_FENCE_PROTECTED_APP_DIR}"
      printf 'helper=%q\n' "${DB_FENCE_SCRIPT_COPY}"
      printf 'state_file=%q\n' "${state_file}"
      printf 'expected_artefact=%q\n' "${artefact_digest}"
      printf 'mode=%q\n' "${mode}"
      # ITS OWN ABSOLUTE PATH, baked rather than taken from $0: an instruction this file prints
      # about itself has to be one that runs from anywhere, and $0 is whatever the caller typed.
      printf 'self=%q\n' "${target}"
      # AND THE PRIVILEGE TRANSITION, resolved when the wrapper RUNS rather than when it is
      # written: what it prints is for the shell reading it, which may not be the one that
      # published it, and sudo may have been installed since.
      printf '%s\n' 'sudo_prefix=""'
      printf '%s\n' 'if command -v sudo >/dev/null 2>&1; then sudo_prefix="sudo "; fi' 
      cat <<'WRAPPER_EOF'
# Root, because switching to the application account needs it — or the application account
# itself, which needs no switch and is who the helper runs as on every path anyway. Anyone else
# would fail at runuser with a less useful message.
#
# In practice this file is 0700 and root-owned, so a reader who is not root does not reach this
# line at all: they get EACCES from the kernel first, which is why every banner that names this
# file prints a privilege transition in front of it. The gate is kept because the mode is not a
# proof and this message is the better one if the mode ever changes.
if [[ "$(id -u)" -ne 0 && "$(id -un)" != "${app_account}" ]]; then
  echo "Run this as root — ${sudo_prefix}${self} — or as ${app_account}: it runs the protected fence helper as ${app_account}." >&2
  exit 1
fi
# The tree this is about to execute must still be the tree this wrapper was written for.
actual="$(cd "${protected_dir}" 2>/dev/null && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum)"
actual="${actual%% *}"
if [[ "${actual}" != "${expected_artefact}" ]]; then
  echo "REFUSING: ${protected_dir} hashes to ${actual:-nothing} but this wrapper was written for ${expected_artefact}." >&2
  echo "The protected fence artefact has changed since the fence was raised. Do not run it." >&2
  exit 1
fi
if [[ -z "${DEPLOY_ADMIN_DATABASE_URL:-}" ]] && [[ -f "${app_env_file}" ]]; then
  # The same one-key reader the entrypoints use: a quoted value ends at its closing quote, an
  # unquoted one at the first whitespace-preceded '#', and later definitions win. `source` is not
  # used, because that executes whatever is in the file.
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?DEPLOY_ADMIN_DATABASE_URL[[:space:]]*=' "${app_env_file}" 2>/dev/null | tail -1 || true)"
  if [[ -n "${line}" ]]; then
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    case "${value}" in
      \"*) value="${value#\"}"; value="${value%%\"*}" ;;
      \'*) value="${value#\'}"; value="${value%%\'*}" ;;
      *)   value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
    esac
    DEPLOY_ADMIN_DATABASE_URL="${value}"
  fi
fi
if [[ -z "${DEPLOY_ADMIN_DATABASE_URL:-}" ]]; then
  echo "DEPLOY_ADMIN_DATABASE_URL is not set and ${app_env_file} does not define it, so there is" >&2
  echo "no privileged connection to ${mode} with. Re-run supplying it:" >&2
  echo "" >&2
  # `env`, and the whole line prefixed rather than the assignment: `sudo VAR=x /path` is not a
  # thing sudo accepts, and a bare `VAR=x /path` is EACCES for the non-root shell this is most
  # likely being read in. The prefix is empty where sudo is not installed, which is a box the
  # reader can only have reached as root anyway.
  echo "  ${sudo_prefix}env DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' ${self}" >&2
  echo "" >&2
  echo "It must be a superuser or database-owner connection as a DIFFERENT role from the one the" >&2
  echo "fence revoked CONNECT from; see docs/installation.md." >&2
  exit 1
fi
run_helper() {
  if [[ "$(id -un)" == "${app_account}" ]]; then env "$@"; else runuser -u "${app_account}" -- env "$@"; fi
}
WRAPPER_EOF
      printf 'run_helper DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${helper}" --%s --state-file="${state_file}"%s\n' \
        "${mode}" "${identity}"
    } | _fence_publish_file "${target}" 700 || return 1
    chown root:root "${target}" 2>/dev/null || true
  done
  return 0
}

# ---------------------------------------------------------------------------
# THE DRY-RUN PROBE — TWO QUESTIONS, DELIBERATELY SEPARATED (o3d-2sm1.5 r34, Codex CRITICAL +
# MEDIUM)
#
# --dry-run is asked two different things and r33 answered them with one mechanism, which is how
# it managed to get both wrong at once:
#
#   WHAT WOULD A PUBLICATION RECORD?   the CANDIDATE digest. r33 returned the STANDING artefact's
#                                      digest whenever one existed, which during an upgrade is the
#                                      OLD tree — a value that cannot authorise the new candidate,
#                                      so the operator pins with it and gets another refusal. It
#                                      answered a question nobody asked.
#   WHAT MAY THIS RUN PREFLIGHT WITH?  a file that is about to be executed AS THE APPLICATION USER
#                                      WITH DEPLOY_ADMIN_DATABASE_URL IN ITS ENVIRONMENT. r33
#                                      snapshotted the checkout's helper AND its dependency
#                                      closure into a root-owned throwaway and ran THAT. Root
#                                      ownership freezes the copied bytes; it says nothing about
#                                      where they came from. A substituted `pg` in the checkout
#                                      therefore stole the credential from the operator following
#                                      the advertised digest-discovery procedure — before any
#                                      publication, and before any pin could be checked.
#
# So they are now two functions with two different rules:
#
#   THE CANDIDATE DIGEST IS COMPUTED FROM BYTES THAT ARE READ, NEVER RUN. The checkout's helper and
#   its resolved closure are assembled into a root-owned throwaway laid out the same way as the
#   artefact, hashed, and — unless the next rule licenses executing them — destroyed. Computing a
#   digest requires reading bytes, not running them, so the answerability this exists for survives
#   the restriction intact.
#
#   NOTHING IS EXECUTED WITH THE ADMIN CREDENTIAL UNLESS IT IS ALREADY AUTHENTICATED. Two sources
#   qualify and no third does:
#     * the STANDING protected artefact, when it is sealed and hashes to what its own record binds
#       (and to IMS_FENCE_ARTEFACT_SHA256, when the invocation supplied one). It was published by
#       root through the gate above; that is what makes it the preflight source of choice.
#     * the CANDIDATE snapshot, ONLY when IMS_FENCE_ARTEFACT_SHA256 was supplied and the snapshot
#       hashes to it. Then its bytes are the release's bytes by construction, and the operator has
#       authorised exactly this tree.
#   With neither, PREFLIGHT IS UNAVAILABLE and the dry run says so and says why. It still prints
#   the candidate digest, because that is the value the first real run needs.
#
# Sets:
#   DB_FENCE_PROBE_SCRIPT            the file that may be run, or empty
#   DB_FENCE_PROBE_TEMP              a directory to remove afterwards, or empty
#   DB_FENCE_PROBE_ARTEFACT_SHA256   what a publication FROM THIS CHECKOUT would record
#   DB_FENCE_PROBE_STANDING_SHA256   what the artefact already on this box hashes to
#   DB_FENCE_PROBE_REASON            why there is nothing this run may preflight with
# Globals rather than stdout because the caller needs all of them and must not lose any to a
# subshell.
# ---------------------------------------------------------------------------

# The candidate tree, assembled and hashed. The tree is LEFT ON DISK at ${DB_FENCE_PROBE_TEMP} so
# db_fence_probe_script() can execute it if — and only if — a supplied digest turns out to
# authenticate it; every path that does not reach that conclusion destroys it.
db_fence_probe_candidate_digest() {
  local dir app_dir
  DB_FENCE_PROBE_ARTEFACT_SHA256=""
  DB_FENCE_PROBE_TEMP=""
  [[ -f "${DB_FENCE_SCRIPT}" ]] || return 1
  app_dir="$(dirname "$(dirname "${DB_FENCE_SCRIPT}")")"
  dir="$(mktemp -d 2>/dev/null)" || return 1
  mkdir -p "${dir}/scripts" || { rm -rf "${dir}"; return 1; }
  cat < "${DB_FENCE_SCRIPT}" > "${dir}/scripts/fence-db-connections.mjs" || { rm -rf "${dir}"; return 1; }
  _fence_vendor_into "${app_dir}" "${dir}" || { rm -rf "${dir}"; return 1; }
  # Readable and traversable by the application user, which is who would execute it; writable by
  # nobody else, which is what lets the seal check below mean anything.
  chmod -R u=rwX,go=rX "${dir}" || { rm -rf "${dir}"; return 1; }
  _fence_tree_is_sealed "${dir}" || { rm -rf "${dir}"; return 1; }
  DB_FENCE_PROBE_ARTEFACT_SHA256="$(_fence_tree_digest "${dir}")" || {
    rm -rf "${dir}"; DB_FENCE_PROBE_ARTEFACT_SHA256=""; return 1
  }
  DB_FENCE_PROBE_TEMP="${dir}"
  return 0
}

# Destroy the candidate tree and keep what was learned from it.
_fence_probe_discard_candidate() {
  if [[ -n "${DB_FENCE_PROBE_TEMP}" ]]; then rm -rf "${DB_FENCE_PROBE_TEMP}"; fi
  DB_FENCE_PROBE_TEMP=""
  return 0
}

db_fence_probe_script() {
  local recorded="" standing=""
  DB_FENCE_PROBE_SCRIPT=""
  DB_FENCE_PROBE_STANDING_SHA256=""
  DB_FENCE_PROBE_REASON=""

  # QUESTION ONE, ALWAYS ASKED AND ANSWERED FROM THE CHECKOUT IN FRONT OF US. It is the answer an
  # upgrade needs, and it is the one the standing artefact cannot give.
  db_fence_probe_candidate_digest || true

  # QUESTION TWO. The standing artefact first: it is the only thing on the box that has been
  # through the publication gate.
  if [[ -f "${DB_FENCE_SCRIPT_COPY}" ]] && _fence_tree_is_sealed "${DB_FENCE_PROTECTED_APP_DIR}"; then
    standing="$(_fence_tree_digest "${DB_FENCE_PROTECTED_APP_DIR}")" || standing=""
    DB_FENCE_PROBE_STANDING_SHA256="${standing}"
    recorded="$(fence_record_artefact_digest)" || recorded=""
    if [[ -n "${standing}" && "${standing}" == "${recorded}" ]] &&
       { [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] || [[ "${standing}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; }; then
      _fence_probe_discard_candidate
      DB_FENCE_PROBE_SCRIPT="${DB_FENCE_SCRIPT_COPY}"
      return 0
    fi
    DB_FENCE_PROBE_REASON="the protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} is not one this run may execute: it hashes to ${standing:-nothing readable}, its record binds ${recorded:-nothing}${DB_FENCE_EXPECTED_ARTEFACT_SHA256:+, and this invocation pinned ${DB_FENCE_EXPECTED_ARTEFACT_SHA256}}."
  fi

  # And otherwise ONLY a candidate the invocation itself authenticated.
  if [[ -n "${DB_FENCE_PROBE_TEMP}" && -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" &&
        "${DB_FENCE_PROBE_ARTEFACT_SHA256}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
    # A reason recorded above is about a standing artefact this run declined to use, and this run
    # found something else to preflight with. Callers print the reason only when there is nothing
    # to run, so leaving it set would put a refusal next to a preflight that happened.
    DB_FENCE_PROBE_REASON=""
    DB_FENCE_PROBE_SCRIPT="${DB_FENCE_PROBE_TEMP}/scripts/fence-db-connections.mjs"
    return 0
  fi

  _fence_probe_discard_candidate
  if [[ -z "${DB_FENCE_PROBE_REASON}" ]]; then
    if [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
      DB_FENCE_PROBE_REASON="there is no protected fence artefact on this box yet, and this run was given nothing that authenticates the tree the checkout would publish. The preflight opens the admin connection with DEPLOY_ADMIN_DATABASE_URL, and the tree it would run is assembled out of the checkout, so it will not be executed on the strength of the checkout's own account of itself. Supply IMS_FENCE_ARTEFACT_SHA256 and this dry run preflights with the tree that value names; every run after the first publication preflights with the standing artefact instead, and needs nothing supplied."
    else
      DB_FENCE_PROBE_REASON="IMS_FENCE_ARTEFACT_SHA256 expects ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} and the tree this checkout would publish hashes to ${DB_FENCE_PROBE_ARTEFACT_SHA256:-nothing that could be assembled}, so there is nothing this run is willing to execute with an administrative credential beside it."
    fi
  fi
  return 1
}

# WHAT A DRY RUN HAS TO SAY, AS TEXT, WITHOUT DECIDING HOW IT IS SHOWN. One line per printf; the
# entrypoints have their own warn() and pipe these through it.
#
# It lives here rather than in each entrypoint for the reason this file exists at all: r30 changed
# update.sh and left deploy.sh saying the old thing, and this text is now an INSTRUCTION FOR
# OBTAINING A REQUIRED INPUT rather than a nicety. Two entrypoints printing two different accounts
# of where the digest comes from is the same defect in its documentation form.
db_fence_probe_report() {
  if [[ -n "${DB_FENCE_PROBE_ARTEFACT_SHA256}" ]]; then
    printf '%s\n' "THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO ${DB_FENCE_PROBE_ARTEFACT_SHA256}"
    printf '%s\n' "That is the value IMS_FENCE_ARTEFACT_SHA256 pins. This run produced it by READING the helper and its resolved dependency closure into a throwaway directory owned by this run and writable by nobody else, and hashing that: nothing was written outside the throwaway, the throwaway was removed, and no part of it was executed."
    printf '%s\n' "It is REPORTED AND NOT AUTHENTICATED — it is what the checkout in front of this run says about itself. ${DB_FENCE_ARTEFACT_SOURCE_TEXT}"
  else
    printf '%s\n' "This run could not assemble the tree this checkout would publish, so it cannot say what IMS_FENCE_ARTEFACT_SHA256 would have to be: ${DB_FENCE_ROTATION_NOTE:-no reason was recorded}."
  fi
  if [[ -n "${DB_FENCE_PROBE_STANDING_SHA256}" ]]; then
    if [[ "${DB_FENCE_PROBE_STANDING_SHA256}" == "${DB_FENCE_PROBE_ARTEFACT_SHA256}" ]]; then
      printf '%s\n' "The artefact already standing at ${DB_FENCE_PROTECTED_APP_DIR} hashes to that same value, so this checkout would publish the tree that is already there."
    else
      printf '%s\n' "THE ARTEFACT ALREADY STANDING at ${DB_FENCE_PROTECTED_APP_DIR} hashes to ${DB_FENCE_PROBE_STANDING_SHA256}, which is a DIFFERENT tree. That is what this box executes today; it is NOT the value that would authorise the candidate above, and pinning with it would produce a refusal rather than a rotation."
    fi
  fi
  return 0
}

db_fence_probe_cleanup() {
  _fence_probe_discard_candidate
  DB_FENCE_PROBE_SCRIPT=""
  DB_FENCE_PROBE_ARTEFACT_SHA256=""
  DB_FENCE_PROBE_STANDING_SHA256=""
  DB_FENCE_PROBE_REASON=""
  return 0
}

# ---------------------------------------------------------------------------
# THE RELEASE BUILD HOST'S ONE COMMAND (o3d-2sm1.5 r35, Codex HIGH).
#
# IMS_FENCE_ARTEFACT_SHA256 became a REQUIRED input in r34, and the host that has to produce it is
# the RELEASE BUILD HOST: a clean checkout of the tag with `npm ci` run in it, and nothing else.
# No installation under ${APP_DIR}, no ${APP_DIR}/.env, no service unit, no port, no database, no
# fence — and not necessarily root either, because a release is built by CI as often as by a
# person.
#
# r34 answered that need by printing the candidate digest FIRST inside --dry-run, ahead of every
# refusal that path can return. It is ahead of every refusal INSIDE require_fenceable_database();
# it is not ahead of the ones the update path takes to get there. `bash scripts/update.sh
# --dry-run` on a clean checkout exits at the layout gate — ${APP_DIR} defaults to the
# installation directory, which does not exist on a build host, and ${APP_DIR}/.env is mandatory —
# with no digest printed. So the one machine that MUST publish the value was the one machine that
# could not: exactly the "refusal whose precondition nobody can satisfy" shape r34 set out to
# avoid, one layer up from where it was looking.
#
# This function is that command's whole implementation. It lives here rather than in the
# entrypoint for the reason the rest of this file does: the value it prints has to be the value
# _fence_stage_and_publish() would RECORD, produced by the same assembly and the same digest, or
# it is a second opinion about the artefact and an operator pinning it gets a refusal.
#
# WHAT IT NEEDS: the checkout it is handed, and `node`. That is the entire list, and it is the
# point — the entrypoint calls it with dirname(dirname(<its own path>)), so the tree under
# question is the one the command was typed out of and never ${APP_DIR}.
#
# WHAT IT DOES NOT NEED, and must be able to prove it does not need: ${APP_DIR}, ${APP_DIR}/.env,
# a service unit, a port, DEPLOY_ADMIN_DATABASE_URL, a database, a standing artefact, or root.
#
# WHAT IT DOES NOT DO: it does not read ${DB_FENCE_PROTECTED_APP_DIR} or the recovery record — a
# build host has neither, and reporting on the box's standing artefact from a command about a
# RELEASE would answer a question nobody asked. It publishes nothing, opens no connection, and
# executes no part of the tree it hashes: the digest is computed by READING bytes into a
# throwaway directory this call creates and removes. ${DB_FENCE_SCRIPT} is restored afterwards so
# a caller that goes on to do anything else is unaffected by having asked.
db_fence_report_candidate_digest() {
  local checkout="$1" saved="${DB_FENCE_SCRIPT:-}" rc=0 line
  DB_FENCE_SCRIPT="${checkout}/scripts/fence-db-connections.mjs"
  db_fence_probe_candidate_digest || rc=1
  # db_fence_probe_report() prints the standing artefact's digest only when
  # DB_FENCE_PROBE_STANDING_SHA256 is set, and nothing above sets it: the candidate is the whole
  # answer here.
  while IFS= read -r line; do printf '%s\n' "${line}"; done < <(db_fence_probe_report)
  db_fence_probe_cleanup
  DB_FENCE_SCRIPT="${saved}"
  return "${rc}"
}
