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
#
# ---------------------------------------------------------------------------
# AND `readonly`, ON EVERY ONE OF THEM (o3d-secops r2, Codex HIGH)
# ---------------------------------------------------------------------------
# The previous round put `readonly` on the publication constants the three ENTRYPOINTS declare and
# stopped at the file boundary. That left the enforcement everywhere except the file that names the
# recovery root, the protected tree and THE EXECUTABLE HELPER — one rule, several files, one
# protected, which is this branch's own recurring defect and the third time it has been found here.
#
# The reasoning that made `readonly` right there applies with more force here. A scanner proves a
# name is assigned exactly once at script scope; that is a claim about ASSIGNMENT SYNTAX, and bash
# does not need an assignment word to change a variable:
#
#     printf -v DB_FENCE_SCRIPT_COPY %s /home/imsapp/evil.mjs
#     read DB_FENCE_SCRIPT_COPY <<<'/home/imsapp/evil.mjs'
#     declare -n ref=DB_FENCE_SCRIPT_COPY; ref=/home/imsapp/evil.mjs
#     (( DB_FENCE_VENDOR_MAX_FILES = 0 ))
#
# Not one of those is a `NAME=` word, all four take effect, and the first three of them re-aim the
# file root EXECUTES with DEPLOY_ADMIN_DATABASE_URL beside it. A mutable path to an executable is a
# worse hole than a mutable staging directory name. So bash is made the authority, exactly as it was
# for the entrypoints: `readonly` at the canonical declaration refuses every mutation path including
# the ones nobody has listed, and the scanner keeps the job it can do.
#
# WHICH NAMES, AND WHY THESE. Every name below is declared ONCE in this repository and reassigned
# NOWHERE — checked before this was applied and asserted by the census in
# tests/scripts/install-root-safe-writes.test.ts — and each is something the PRIVILEGED mechanism
# trusts without re-deriving:
#
#   the ten PATHS      the recovery root, the identity record, the protected application tree, the
#                      executable helper inside it, the staging and retired trees a publication
#                      renames through, the artefact digest record and its per-file manifest, and
#                      the two root-owned operator wrappers. Re-aim any one of them and a run that
#                      reports a protected artefact is reading, writing or EXECUTING somewhere else.
#
#   the two DIGESTS    ${DB_FENCE_EXPECTED_SHA256} and ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} are what
#                      AUTHENTICATES a rotation. They are inputs to the privileged invocation and
#                      are derived from the environment HERE, once; a later write to either is a
#                      forged authentication, which is the same hole as a re-aimed path and not a
#                      smaller one. Anything that wants to vary them sets the environment variable
#                      this line reads, which is the route an operator has.
#
#   the two VENDOR     ${DB_FENCE_VENDOR_ROOTS} decides which packages are copied into the tree that
#   POLICY constants   is executed, and ${DB_FENCE_VENDOR_MAX_FILES} is the bound on what a manifest
#                      in the checkout can talk root into copying under /etc. Both are decisions
#                      about the executable surface.
#
#   the two STRINGS    ${DB_FENCE_ARTEFACT_RECIPE} is the recorded definition of what "wholly
#                      digested" means, and ${DB_FENCE_ARTEFACT_SOURCE_TEXT} is the one answer every
#                      refusal gives to "where do I get that digest". Both are read by an operator
#                      deciding whether to trust a tree; a rewritten one misdirects that decision.
#
# WHAT IS DELIBERATELY NOT READONLY, and it is not a residue: the report variables further down
# (${DB_FENCE_ROTATION_NOTE}, ${DB_FENCE_SEAL_REASON} and the three ${DB_FENCE_PROBE_*}) are
# WRITTEN BY THIS LIBRARY'S OWN FUNCTIONS — they are how it reports — so `readonly` would break the
# mechanism rather than protect it. ${DB_FENCE_SUDO_PREFIX} is assigned twice by construction (a
# default, then a conditional) and is a display prefix resolved from PATH. The census names each of
# them with that reason, so a NEW declaration added here is in neither list and FAILS until
# somebody classifies it — a path added later is covered by the rule rather than silently outside
# it.
#
# AND "NOT READONLY" IS NOT THE SAME PERMISSION AS "MUTABLE GLOBAL" (o3d-secops r3, Codex HIGH).
# Four of the names that used to sit on that list were not reports at all — ${DB_FENCE_PROBE_SCRIPT}
# was EXECUTED with DEPLOY_ADMIN_DATABASE_URL beside it, ${DB_FENCE_PROBE_TEMP} was the operand of
# an `rm -rf`, ${DB_FENCE_PROBE_ARTEFACT_SHA256} was half of the equality that authenticated
# checkout-derived bytes, and ${DB_FENCE_SOURCE_UNTRUSTED_PATH} was the gate that decides whether an
# unauthenticated tree is PUBLISHED — and the three ${_FENCE_SRC_*} arrays are the argv of the find
# that computes it. The census had asked its question at the declaration, where they look like
# scratch, instead of at the sink, where they steer execution, authentication, publication and
# deletion. None of them can carry `readonly` (all are computed per run), so the answer is one step
# further on: THEY ARE NOT SCRIPT-SCOPE NAMES AT ALL. Each is a `local` of the function that
# derives and consumes it, so no path — enumerated or not — has a name to write. What remains
# below is what is genuinely printed and nothing else, and the census now checks that at the sink.
#
# THE HARNESSES DID NOT WEAKEN THIS. Every fence harness used to source this file and then reassign
# these paths at a scratch directory, which `readonly` refuses. They now substitute the ONE literal
# below — ${DB_FENCE_RECOVERY_DIR} — in the shipped text before sourcing it, and the nine paths
# composed from it are composed by THIS FILE, unchanged, `readonly` and all. See
# tests/scripts/fence-artefact-harness.ts.
# ---------------------------------------------------------------------------

readonly DB_FENCE_RECOVERY_DIR="/etc/ims-cutover-recovery"
readonly DB_FENCE_IDENTITY_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-identity.env"
readonly DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"
readonly DB_FENCE_SCRIPT_COPY="${DB_FENCE_PROTECTED_APP_DIR}/scripts/fence-db-connections.mjs"
# The whole artefact is assembled here and renamed into place in one step; the previous one is
# moved aside under this name so a failed swap leaves the OLD tree standing rather than none.
readonly DB_FENCE_STAGED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/.app.staged"
readonly DB_FENCE_RETIRED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/.app.retired"
# What the published tree hashes to, and the per-file manifest that says WHICH file moved when it
# stops matching. Root-owned, beside the tree and not inside it: a record that lived in the tree
# would be part of its own digest.
readonly DB_FENCE_ARTEFACT_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-artefact.sha256"
readonly DB_FENCE_MANIFEST_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-artefact.manifest"
# The two commands an operator is ever given. Root-owned, generated by root at fence time with
# this run's state file and connection identity baked in, so that what is PRINTED is a path that
# exists and runs — see db_fence_publish_operator_wrappers().
readonly DB_FENCE_RELEASE_WRAPPER="${DB_FENCE_RECOVERY_DIR}/release-db-fence"
readonly DB_FENCE_REFENCE_WRAPPER="${DB_FENCE_RECOVERY_DIR}/refence-db"
# AND THE THIRD, WHICH NO CUTOVER EVER RUNS (o3d-secops r26, Codex HIGH). A record published before
# the applied stamp existed cannot be shown to be either a standing fence or a spent publication,
# so every automatic path refuses it. This is the one-time, operator-driven way OUT of that
# refusal: it asks the live ACL -- the only evidence there is -- and then either clears a record no
# fence stands behind or stamps one that a fence does. It is published alongside the other two so
# that the refusal can name a path that exists, and it is separate from them because resolving an
# ambiguity is a decision an operator takes and not a step a deploy performs.
readonly DB_FENCE_RESOLVE_WRAPPER="${DB_FENCE_RECOVERY_DIR}/resolve-legacy-db-fence"

# The bare specifiers the entry file imports. The transitive closure is resolved from these; a
# test asserts this list is exactly the set of bare imports in scripts/fence-db-connections.mjs,
# so adding an import without vendoring it fails the suite rather than the cutover.
readonly DB_FENCE_VENDOR_ROOTS=(pg)
# A cap on what a package.json in the checkout can talk this into copying under /etc. The real
# closure is ~140 files; a manifest that declares `next` as a dependency of `pg` would otherwise
# vendor several hundred megabytes. Exceeding it is a refusal, with the count named.
readonly DB_FENCE_VENDOR_MAX_FILES=2000

# THE DOCUMENTED RECIPE, AS ONE STRING. The library hashes with exactly these bytes and
# docs/installation.md prints exactly this line; a test asserts the three agree and that running
# it reproduces the recorded digest.
readonly DB_FENCE_ARTEFACT_RECIPE="find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum"

# WHERE THE WHOLE-TREE DIGEST COMES FROM, AS ONE STRING (o3d-2sm1.5 r34, Codex CRITICAL).
#
# Since an application-writable source with no whole-tree pin is now REFUSED, that digest is a
# REQUIRED INPUT rather than an optional hardening, and every refusal that names it has to say
# where a first-ever install gets it. Stated once here so the two refusals, the entrypoints and
# docs/installation.md cannot drift into three different answers — which is the defect this whole
# library was made a library to avoid. A test asserts the doc page contains it verbatim.
readonly DB_FENCE_ARTEFACT_SOURCE_TEXT="WHERE THAT VALUE COMES FROM, ON A FIRST-EVER INSTALL AS MUCH AS ON ANY OTHER: it is published WITH THE RELEASE. The release is built on a host that is not this one — a clean checkout of the tag, 'npm ci', then 'bash scripts/update.sh --print-fence-digest', which assembles exactly this tree, prints the line 'THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO <digest>', and neither writes nor executes any part of it. That mode exists BECAUSE the build host has no installation: it resolves the tree from the checkout the command was typed out of, needs no application directory, no .env, no port, no database and no root, and it runs before every gate the update path would otherwise refuse at — and that digest is published with the release checksums. A host that has ALREADY published this release will also report it: grep '^fence_artefact_sha256=' ${DB_FENCE_ARTEFACT_FILE} there. Running either that mode or --dry-run on THIS box prints the same kind of line, but assembled from the checkout under question, so it can CONFIRM the release's value and never stand in for it. The other way out needs no digest at all: bootstrap from a source only this account can write — install the release tree as root and take group and other write off it — and the provenance question answers itself."

# The expected digests, from the ROOT INVOCATION and from nowhere else. Never read out of the
# checkout, never out of ${APP_DIR}/.env — both are writable by the account this authenticates
# against, and a digest that source can set authenticates nothing.
readonly DB_FENCE_EXPECTED_SHA256="${IMS_FENCE_SCRIPT_SHA256:-}"
readonly DB_FENCE_EXPECTED_ARTEFACT_SHA256="${IMS_FENCE_ARTEFACT_SHA256:-}"

# Why a divergence was not promoted, or why a rotation was refused. Printed by the caller; empty
# when there is nothing to say.
DB_FENCE_ROTATION_NOTE=""

# Why a tree was refused as unsealed. Set by _fence_tree_is_sealed(); it names the offending path,
# because "the artefact is not sealed" is not something an operator can act on.
DB_FENCE_SEAL_REASON=""

# Set by db_fence_probe_digests(): what the tree THIS CHECKOUT would publish hashes to — the value
# an operator pins the first publication with, obtainable from a run that writes nothing and
# executes nothing — and what the artefact ALREADY STANDING hashes to. The candidate and the
# standing digests are separate because during an upgrade they differ, and reporting the standing
# one answers a question nobody asked (o3d-2sm1.5 r34, Codex MEDIUM).
#
# AND THEY ARE REPORTS, WHICH IS NOW TRUE OF THEM RATHER THAN SAID ABOUT THEM (o3d-secops r3,
# Codex HIGH). The digest that AUTHENTICATES a candidate — the one compared against
# ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} before checkout-derived bytes are handed the admin
# credential — is derived inside db_fence_preflight() and never leaves it. These two are what is
# PRINTED. Overwrite them and the operator is told a wrong digest, pins with it, and the
# publication gate refuses; there is no path by which they license anything.
DB_FENCE_PROBE_ARTEFACT_SHA256=""
DB_FENCE_PROBE_STANDING_SHA256=""

# Why there is nothing this run may preflight with. After db_fence_preflight() a non-empty value
# means exactly "nothing was executed", which is the fact the entrypoints' banners assert.
DB_FENCE_PROBE_REASON=""

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
#
# AND THEY ARE NOT SCRIPT-SCOPE NAMES (o3d-secops r3, Codex HIGH). They read like scratch, but they
# are the ARGV of the `find` whose answer decides whether an artefact assembled out of an
# application-writable checkout may be published into ${DB_FENCE_RECOVERY_DIR} and executed with
# DEPLOY_ADMIN_DATABASE_URL for the rest of the box's life. Empty one of them and that `find`
# examines nothing, reports no offender, and the provenance gate passes over a tree nobody checked
# — a vacuous check that reads exactly like a clean one. `readonly` cannot apply (they are rebuilt
# per call), so instead every frame that calls _fence_vendor_into() declares all three `local`, and
# the three names exist only inside the call that derives and consumes them.
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
  # THE PATH LISTS ARE THIS CALL'S, NOT THE SCRIPT'S. _fence_source_paths() derives them and
  # _fence_source_trust() and _fence_source_ident() read them, all three inside this frame — so
  # the `find` that answers the provenance question can only ever be aimed at paths derived by
  # this same call. See the block above the derivation for why that matters.
  local -a _FENCE_SRC_STRICT=() _FENCE_SRC_PACKAGES=() _FENCE_SRC_PARENTS=()
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
  # THE PROVENANCE ANSWER IS THIS CALL'S (o3d-secops r3, Codex HIGH). _fence_source_trust(), two
  # frames down, writes it; the gate below — "publish nothing that nothing authenticated" — reads
  # it. It is not a report: emptying it turns an unpinned publication of an application-writable
  # tree from a refusal into a publication, after which root executes those bytes with
  # DEPLOY_ADMIN_DATABASE_URL beside them on every cutover. `readonly` cannot apply (it is computed
  # per call), so it is a `local` of the frame that consumes it, and there is no script-scope name
  # for another path to pre-set. Every caller of _fence_vendor_into() declares it the same way.
  local DB_FENCE_SOURCE_UNTRUSTED_PATH=""
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
# THE CONNECTION-FENCE AUTHORITY, AND THE PRIVILEGED STEP THAT PUBLISHES IT
# (o3d-secops r23, Codex CRITICAL)
#
# THE FINDING. ${DB_FENCE_STATE} names the roles a `--release` hands `GRANT CONNECT` back to. It
# was published BY THE HELPER, which runs as ${APP_USER}, into a directory that was owned by
# ${APP_USER} for exactly that reason -- so the account being defended against could pre-create or
# replace the file that decides who gets database access, and readState() authenticated its SHAPE.
# A well-formed JSON object proves the file is well-formed JSON. It says nothing about who wrote
# it. That is the same defect as the legacy fence marker one round earlier, with another file in
# it: AUTHENTICATING THE ARTEFACT INSTEAD OF ITS PROVENANCE.
#
# THE SPLIT. Raising a fence is now three steps and the privileged one is in the middle:
#
#   1. `--plan`, as ${APP_USER}.  Opens the admin connection, reads the ACL, computes the grantee
#                                 list, PRINTS it as one line of JSON and writes nothing at all.
#                                 It is a REQUEST.
#   2. db_fence_authorise_plan(), as root.  Validates that request field by field against what
#                                 THIS run supplied on the command line, REBUILDS the record from
#                                 its own template -- nothing the request carried that is not in
#                                 the template survives -- and publishes it durably: temporary in
#                                 the destination directory, fsync, atomic rename, directory
#                                 fsync. The same barriers in the same order the helper own
#                                 publisher used to make, because the ordering property has not
#                                 changed: a REVOKE is a committed transaction that outlives a
#                                 power cut, and its undo record has to be on the medium first.
#   3. `--fence`, as ${APP_USER}. EXECUTES the authority. It cannot write it, and an absent or
#                                 unauthenticated record is a refusal rather than a fresh fence.
#
# AND ROOT STAMPS WHICH KIND OF FENCE THIS IS (o3d-secops r24, Codex HIGH). Step 2 records
# `fence_mode` in the record it rebuilds: "initial" when nothing was at ${DB_FENCE_STATE} when it
# looked, "recovery" when an authority was already there -- which can only mean a previous cutover
# revoked and did not release, so its fence is still standing. Step 3 executes the two under
# different rules: an INITIAL fence requires the live grantee list to match the record EXACTLY, in
# both directions, because the record is supposed to BE the ACL `--plan` had just read; a RECOVERY
# re-fence tolerates recorded grantees that no longer hold CONNECT, because the standing fence is
# what took it from them, while still refusing any grantee that has APPEARED.
#
# THE FINDING THAT MADE IT NECESSARY. Step 3 compared the two lists in one direction only -- it
# asked what had appeared -- so a role that LOST CONNECT between step 1 and step 3 left that
# comparison empty and the stale record was accepted whole. `--release` then granted CONNECT to
# every role the record named, including the one an administrator had just removed. Checking for
# additions is not checking for equality, and the fix cannot be a bare equality either, because a
# standing fence's own record can never satisfy one.
#
# WHY THE STAMP IS ROOT'S AND NOT THE PLAN'S. It is the difference between the two rules, so it is
# the thing worth forging: a plan that could declare itself a recovery would buy the lax rule. It
# is computed by the validator, in the process that does the rename, in a directory root owns and
# ${APP_USER} cannot write -- so that account can neither create a record to obtain the tolerance
# nor unlink one to escape it -- and a `fence_mode` carried in the plan is dropped by the template
# like every other field root does not compute for itself.
#
# AND IT IS NOT COMPUTED FROM THE PRESENCE OF A FILE (o3d-secops r25, Codex HIGH).
#
# DO NOT INFER A STANDING FENCE SOLELY FROM RECORD PRESENCE. r24 stamped `recovery` whenever
# anything was at ${DB_FENCE_STATE}, and presence conflates two different states: ROOT PUBLISHED AN
# AUTHORITY and THE FENCE WAS ACTUALLY APPLIED. Only the second is a standing fence, and only the
# second may buy the recovery tolerance. Every way the first can happen without the second leaves
# the same file at the same name:
#
#   * the publication itself failing AFTER the rename -- the directory fsync below is the last
#     barrier, it explicitly leaves the authority visible when it fails, and r24's cleanup was
#     hung off the EXECUTION's exit 3 rather than off the publication (that is this round's HIGH);
#   * `--fence` failing with any status r24 did not enumerate, or the whole cutover being killed,
#     between the rename and `BEGIN`;
#   * SIGKILL or power loss at the same point, where no cleanup runs at all because no process is
#     left to run one.
#
# So the record carries `fence_applied`, written 0 by this validator and raised to 1 BY ROOT, from
# db_fence_raise(), only after `--fence` reports that the REVOKEs are (or may be) on the medium.
# `standing` is that stamp and not the pathname. A record left behind by any publication or
# execution failure -- this one, the next one, or one nobody has thought of -- is then INERT BY
# CONSTRUCTION: it can only ever produce another INITIAL fence, held to the strict rule.
#
# THE UNSTAMPED RECORD IS AMBIGUOUS, AND IT IS REFUSED (o3d-secops r26, Codex HIGH).
#
# r25 read an absent `fence_applied` key as RECOVERY, and the argument for it was: the key is
# absent only in records a validator predating the stamp wrote, so the record can only be a fence
# raised before this upgrade, therefore standing. THE FIRST HALF IS TRUE AND THE SECOND DOES NOT
# FOLLOW. The predecessor published its record BEFORE invoking `--fence`, so its own documented
# SIGKILL/power-loss window between the rename and `BEGIN` leaves exactly this record with no fence
# behind it. An absent key dates the WRITER; it says nothing about which phase that writer reached.
# So an unstamped record is exactly as ambiguous as a present-but-zero one -- and reading it as
# recovery grants drift tolerance to a fence nobody can show exists, which is the failure direction
# this file refuses everywhere else.
#
#   key absent            AMBIGUOUS. Nothing on the filesystem can settle it -> REFUSE. Nothing is
#                         published, nothing is revoked, and the refusal names the record and the
#                         wrapper that resolves it.
#   key present, === 1    root saw `--fence` succeed -> standing -> RECOVERY.
#   key present, anything published, never applied -> NOT standing -> INITIAL, strict rule.
#   else
#
# The two present-key readings hold because ${DB_FENCE_DIR} is root-owned and unwritable by
# anything else: ${APP_USER} can neither raise the stamp to buy the lax rule nor strip it. It is
# the same argument `fence_mode` rests on. What that argument never established -- and what r25
# borrowed it for -- is what an ABSENT key means, and the answer is that it means two things.
#
# AND ONLY THE ACL CAN SETTLE IT, WHICH IS WHY THE RESOLUTION IS AN OPERATOR STEP AND NOT A
# HEURISTIC HERE. The mtime, the owner, the mode and the fields of that file all describe its
# writer. Whether the recorded grantees have actually lost CONNECT does not, and it is the fence's
# entire effect. ${DB_FENCE_RESOLVE_WRAPPER} -- root-owned, published beside the other two, run BY
# AN OPERATOR and never by a cutover -- drives `--audit-authority` against the live database and
# then either clears a record no fence stands behind or stamps one that a fence does. It refuses on
# a mixed reading. This branch reads no database at all.
#
# AND WHERE IT FAILS, SAID PLAINLY. If the process dies between a successful REVOKE and root
# raising the stamp, the record says 0 and a fence IS standing. The next run reads INITIAL, the
# strict both-directions rule sees the recorded grantees missing from the ACL, and it REFUSES.
# That is the direction this fails in and it is the deliberate one: a refusal that names the
# record is recoverable by the release wrapper, which reads the record and grants back regardless
# of the stamp, while the other direction hands drift tolerance to a fence nobody can show exists.
#
# WHAT IS LEFT ON THE APPLICATION SIDE: NOTHING. There is no request file, no progress note and no
# app-writable directory in the cutover namespace any more -- the plan travels on a pipe, and
# ${DB_FENCE_DIR} is root-owned. `--release` still READS the authority, and must, because the
# executor is unprivileged. Readable is not writable, and the record holds role names, not secrets.
#
# WHAT THIS DOES NOT CLOSE, SAID PLAINLY. The helper runs with DEPLOY_ADMIN_DATABASE_URL in its
# environment for the length of a cutover, so during that window the application account can issue
# any SQL the admin can, this record included. What the split closes is the PERSISTENT half, which
# is the half that matters: a file planted at any time, by an account holding no credential at
# all, that makes some later privileged release grant CONNECT to roles of its choosing. Closing
# the window itself means not handing that account the credential -- see docs/installation.md.
#
# WHY THE VALIDATOR IS AN INLINE PROGRAM. It runs AS ROOT, so it may not be a file out of the
# application checkout -- that is the r31 CRITICAL, and it applies to a validator exactly as it
# applies to the helper. It is held in ONE constant, which db_fence_authorise_plan() runs and
# which the generated operator wrappers BAKE IN at publication, so a wrapper carries a copy that
# was generated rather than a second one somebody wrote. `node -e` resolves no module and reads no
# path: the whole of what root executes here is the text below.
#
# Arguments: <expected database> <expected app role> <destination>. The plan arrives on stdin.
# IT IS A FUNCTION AND NOT A CONSTANT, and the reason is the census in
# tests/scripts/install-root-safe-writes.test.ts rather than taste: every script-scope name this
# library declares is read, mutated and re-read one declaration at a time, and a scanner that
# reads a declaration as a LINE cannot carry a fifty-line quoted value. A function body is the
# shell's own way to hold a program; the function census covers it, so it still cannot come to
# have two definitions.
db_fence_authorise_plan_program() {
  cat <<'AUTHORISE_PLAN_EOF'

var fs = require("fs");
var path = require("path");
function fail(m) { process.stderr.write("NOT AUTHORISED: " + m + "\n"); process.exit(1); }
var CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");
function text(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);
}
var wantDatabase = process.argv[1] || "";
var wantAppRole = process.argv[2] || "";
var destination = process.argv[3] || "";
// ADVISORY ONLY, AND DELIBERATELY NOT REQUIRED (o3d-secops r26). The fourth argument is the path
// of the operator resolution wrapper, named in the refusal an unstamped record produces so that
// the message carries a command instead of a description of one. It licenses nothing and is never
// executed here; a run that omits it gets the same refusal with one sentence fewer.
var resolveWrapper = process.argv[4] || "";
if (!wantDatabase || !wantAppRole || !destination) fail("the validator was not told which database, role and destination this run is fencing");
var raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (e) { fail("the plan could not be read: " + e.message); }
var plan = null;
try { plan = JSON.parse(raw); } catch (e) { fail("the plan is not valid JSON (" + e.message + ")"); }
if (plan === null || typeof plan !== "object" || Array.isArray(plan)) fail("the plan is not a JSON object");
if (!text(plan.database, 128)) fail("the plan names no usable database");
if (plan.database !== wantDatabase) fail("the plan names the database " + JSON.stringify(plan.database) + " and this run is fencing " + JSON.stringify(wantDatabase));
if (!text(plan.app_role, 128)) fail("the plan names no usable application role");
if (plan.app_role !== wantAppRole) fail("the plan names the application role " + JSON.stringify(plan.app_role) + " and this run supplied " + JSON.stringify(wantAppRole));
if (!text(plan.owner_role, 128)) fail("the plan names no usable database owner");
if (!text(plan.admin_role, 128)) fail("the plan names no usable admin role");
if (!Array.isArray(plan.revoked) || plan.revoked.length < 1 || plan.revoked.length > 64) fail("the plan carries no usable list of grantees");
var seen = Object.create(null);
for (var i = 0; i < plan.revoked.length; i++) {
  if (!text(plan.revoked[i], 128)) fail("grantee " + i + " is not a usable role name");
  if (seen[plan.revoked[i]]) fail("the plan lists " + JSON.stringify(plan.revoked[i]) + " twice");
  seen[plan.revoked[i]] = true;
}
var acl = plan.datacl_before === undefined ? null : plan.datacl_before;
if (acl !== null && !(typeof acl === "string" && acl.length <= 8192 && !CONTROL.test(acl))) fail("the recorded prior ACL is not a usable string");
// THE CLUSTER FINGERPRINT, VALIDATED LIKE EVERY OTHER FIELD (o3d-secops r28, Codex HIGH 1). Two
// values and nothing else: the system identifier initdb stamps into pg_control, and the database
// OID. Both are unsigned integers in their text form, so the shape is checkable rather than
// merely bounded, and anything that is not one is a refusal rather than a field carried through.
// NULL is ALLOWED and means "this server would not say", which is not the same as a value and is
// never compared as one -- see compareClusterIdentity() in the helper.
var systemIdentifier = plan.cluster_system_identifier === undefined ? null : plan.cluster_system_identifier;
if (systemIdentifier !== null && !(typeof systemIdentifier === "string" && /^[0-9]{1,20}$/.test(systemIdentifier))) fail("the plan's cluster system identifier is not a usable value");
var databaseOid = plan.cluster_database_oid === undefined ? null : plan.cluster_database_oid;
if (databaseOid !== null && !(typeof databaseOid === "string" && /^[0-9]{1,10}$/.test(databaseOid))) fail("the plan's database OID is not a usable value");
if (!(typeof plan.fenced_at === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$/.test(plan.fenced_at))) fail("the plan carries no usable timestamp");
var directory = path.dirname(destination);
var meta = null;
try { meta = fs.lstatSync(directory); } catch (e) { fail(directory + " could not be examined (" + e.message + ")"); }
if (!meta.isDirectory()) fail(directory + " is not a directory");
if (meta.uid !== process.getuid()) fail(directory + " is owned by uid " + meta.uid + " and this run is uid " + process.getuid() + ", so what it publishes there could be replaced by somebody else");
if ((meta.mode & 18) !== 0) fail(directory + " is writable by group or other, so any name in it can be renamed or unlinked by another account");
var standing = false;
var priorMeta = null;
try {
  priorMeta = fs.lstatSync(destination);
} catch (e) {
  if (!(e && e.code === "ENOENT")) fail(destination + " could not be examined (" + e.message + ")");
}
if (priorMeta !== null) {
  if (!priorMeta.isFile()) {
    process.stderr.write("There is no fence record at " + destination + ", only a " + (priorMeta.isSymbolicLink() ? "symbolic link" : "non-regular file") + ", so nothing there says a fence was ever applied. Publishing an INITIAL authority.\n");
  } else {
    var priorRaw = "";
    try { priorRaw = fs.readFileSync(destination, "utf8"); } catch (e) { fail(destination + " could not be opened (" + e.message + "), so this run cannot tell whether the fence it records was ever applied. Nothing has been published."); }
    var prior = null;
    try { prior = JSON.parse(priorRaw); } catch (ignored) { void ignored; prior = null; }
    if (prior === null || typeof prior !== "object" || Array.isArray(prior)) {
      process.stderr.write("The record at " + destination + " is not a usable JSON object, so it cannot show that a fence was applied. Publishing an INITIAL authority.\n");
    } else if (!Object.prototype.hasOwnProperty.call(prior, "fence_applied")) {
      // THE AMBIGUOUS RECORD, REFUSED (o3d-secops r26, Codex HIGH). See the section above this
      // program: an absent stamp dates the writer and does not say whether that writer's REVOKE
      // committed, so this record is both "a fence raised before the stamp existed" and "a
      // publication by that same predecessor that never reached BEGIN". Publishing either mode
      // over it would be a guess -- and the recovery guess is the one that hands drift tolerance
      // to a fence nobody can show exists, which is how a later --release comes to GRANT CONNECT
      // back to a role an administrator deliberately removed.
      process.stderr.write("The record at " + destination + " carries no applied stamp at all (no `fence_applied` key), so it was published by a validator that predates the stamp. That dates its WRITER and says nothing about whether that writer's REVOKE ever committed: the predecessor published its record BEFORE running the fence, so this is equally what a fence raised then leaves and what a publication killed before BEGIN leaves.\n");
      process.stderr.write("Nothing on the filesystem can tell those apart, and the live ACL settles only half of it: a grantee that STILL HOLDS CONNECT proves no revoke took it, so a record every grantee still holds against is one no fence stands behind. The other half it cannot settle -- the ACL records what the grants ARE and never what made them so, and roles that have all lost CONNECT look the same whether this fence took it or an administrator did.\n");
      if (resolveWrapper) {
        process.stderr.write("Resolve it once, deliberately, by running " + resolveWrapper + " AS ROOT (prefix it with `sudo` if the shell reading this is not root's). It READS and REPORTS, and on its own it changes NOTHING: it prints the grantee list, says which of those roles still hold CONNECT, and says whether the server that answered can be shown to be the one this record was written against. Acting on that reading takes a second run naming the decision -- --no-fence-stands-here to REMOVE the record, --this-fence-revoked-them to STAMP it -- and then a confirmation typed at your terminal, because both directions are irreversible in one way or another. If a fence IS standing and you would rather simply take it down, the release wrapper restores from this record without needing the stamp.\n");
      } else {
        process.stderr.write("Resolve it once, deliberately, with the operator resolution wrapper in the cutover recovery directory. It READS and REPORTS, and on its own it changes NOTHING: acting on that reading takes a second run naming the decision (--no-fence-stands-here to REMOVE, --this-fence-revoked-them to STAMP) and a confirmation typed at your terminal. If a fence IS standing and you would rather simply take it down, the release wrapper restores from this record without needing the stamp.\n");
      }
      fail("an authority that cannot be shown to be either standing or spent may not be re-fenced automatically. Nothing has been published and nothing has been revoked.");
    } else if (prior.fence_applied === 1) {
      standing = true;
    } else {
      process.stderr.write("The record at " + destination + " was published and never stamped applied (fence_applied " + JSON.stringify(prior.fence_applied) + "), so no fence stands behind it: it is what a publication or an execution that failed before REVOKE leaves. Publishing an INITIAL authority.\n");
    }
  }
}
var record = {
  database: plan.database,
  owner_role: plan.owner_role,
  app_role: plan.app_role,
  admin_role: plan.admin_role,
  revoked: plan.revoked.slice(),
  datacl_before: acl,
  cluster_system_identifier: systemIdentifier,
  cluster_database_oid: databaseOid,
  fenced_at: plan.fenced_at,
  fence_mode: standing ? "recovery" : "initial",
  fence_applied: 0,
  state_complete: 1
};
var body = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
var temporary = destination + ".authority." + process.pid + ".tmp";
var fd = -1;
try {
  fd = fs.openSync(temporary, "wx", 384);
  fs.writeFileSync(fd, body);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = -1;
  fs.chmodSync(temporary, 420);
  fs.renameSync(temporary, destination);
} catch (e) {
  if (fd !== -1) { try { fs.closeSync(fd); } catch (ignored) { void ignored; } }
  try { fs.unlinkSync(temporary); } catch (ignored) { void ignored; }
  fail("the authority could not be published at " + destination + " (" + e.message + ")");
}
var dirFd = -1;
try {
  dirFd = fs.openSync(directory, "r");
  fs.fsyncSync(dirFd);
  fs.closeSync(dirFd);
} catch (e) {
  if (dirFd !== -1) { try { fs.closeSync(dirFd); } catch (ignored) { void ignored; } }
  fail("the authority is visible at " + destination + " and its NAME is not durable (" + e.message + "), so a power cut can restore the previous directory entry");
}
process.stderr.write("Connection-fence authority published at " + destination + " (" + record.fence_mode + "): CONNECT will be revoked from " + record.revoked.join(", ") + " on " + record.database + ".\n");
// THE DIGEST OF WHAT WAS ACTUALLY WRITTEN, ON THE MACHINE CHANNEL (o3d-secops r28, Codex HIGH 3).
// The caller stamps this record a moment later, and the stamp must be conditional on the exact
// bytes it is stamping rather than on the path. This is where those bytes are known for certain:
// the buffer that was fsynced and renamed. Taken over the BUFFER and not by re-reading the file,
// because re-reading is the very window the stamp's compare-and-swap exists to close.
process.stdout.write("authority_sha256=" + require("crypto").createHash("sha256").update(body).digest("hex") + "\n");
AUTHORISE_PLAN_EOF
}

# Validate a plan on stdin and publish the authority it authorises. ROOT ONLY -- that is the whole
# point of the function. Returns non-zero, having published nothing, on anything it cannot prove.
db_fence_authorise_plan() {
  local expected_database="$1" expected_app_role="$2" destination="$3" program
  # CAPTURED, WITH ITS STATUS TAKEN. `node -e "$(...)"` inline would hand node an EMPTY program on
  # any failure of the substitution -- and node exits 0 having done nothing, which here means a
  # revoke with no record. The rule this file is held to (docs/installation.md, the producer
  # roster) is that a command substitution's status is taken or its failure is already a refusal.
  program="$(db_fence_authorise_plan_program)" || return 1
  [[ -n "${program}" ]] || return 1
  # AND THE INTERPRETER IS GIVEN NOTHING TO LOAD. `node -e` resolves no module and reads no path
  # from the program -- but NODE_OPTIONS carries `--require`, and NODE_PATH decides where a
  # `require` would look, so an environment variable is a way to make this root-side run execute a
  # file nobody here named. They belong to whatever shell launched the cutover rather than to
  # ${APP_USER}, which is why this is a hardening and not the finding; it costs one word.
  # THE FOURTH ARGUMENT IS TEXT FOR A MESSAGE (o3d-secops r26). An unstamped record is refused, and
  # a refusal an operator cannot act on is a refusal that gets worked around; this hands the
  # validator the path of the wrapper that resolves it. It is root's own `readonly` constant, it is
  # never executed by the program it is passed to, and the refusal happens with or without it.
  #
  # BARE, AND THE PRIVILEGE TRANSITION IS IN THE SENTENCE INSTEAD. ${DB_FENCE_SUDO_PREFIX} is the
  # one name here bash assigns twice by construction, so it is a report rather than a protected
  # constant -- and a report may not reach an execution, which is a rule this file is held to by
  # the sink census in tests/scripts/install-root-safe-writes.test.ts. r33's point stands and is
  # made in words: the message says to run the wrapper AS ROOT.
  env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
    node -e "${program}" -- "${expected_database}" "${expected_app_role}" "${destination}" "${DB_FENCE_RESOLVE_WRAPPER}"
}

# ---------------------------------------------------------------------------
# THE APPLIED STAMP (o3d-secops r25, Codex HIGH)
#
# The other half of "do not infer a standing fence solely from record presence": the validator
# writes `fence_applied: 0` and this raises it to 1, so that the two states presence conflated --
# root published an authority, and the fence was actually applied -- are two different bytes on the
# medium. Only this one is ever written after a REVOKE, and only this one buys recovery tolerance.
#
# ROOT ONLY, for exactly the reason the publication is root only: a stamp ${APP_USER} could write
# is a way for that account to declare a fence standing and obtain the lax rule. It is a SEPARATE
# program from the validator rather than a mode of it, because the validator's whole contract is
# "rebuild the record from root's own template out of a plan", and this one rebuilds nothing: it
# reads what root already published, changes one field, and re-publishes it through the same
# barriers -- temporary in the destination directory, fsync, atomic rename, directory fsync.
#
# WHAT ITS OWN FAILURES COST. A stamp that never lands leaves `fence_applied: 0` behind a fence
# that IS standing, and the next run reads that as INITIAL and refuses. That is the fail-closed
# direction, it is announced by db_fence_raise() at the moment it happens, and the release wrapper
# -- which reads the record and grants back regardless of the stamp -- still takes the fence down.
# A post-rename directory-fsync failure here is the benign case of the same thing: the stamp is
# truthful while it is visible, and if the rename is lost to a power cut the record reverts to 0,
# which is the safe reading.
#
# Argument: <destination>. It is a FUNCTION for the same reason the validator is -- the script-scope
# census in tests/scripts/install-root-safe-writes.test.ts reads declarations one line at a time
# and cannot carry a fifty-line quoted value; a function body is the shell's own way to hold a
# program, and the function census covers it.
db_fence_mark_applied_program() {
  cat <<'MARK_APPLIED_EOF'

var fs = require("fs");
var path = require("path");
function fail(m) { process.stderr.write("NOT STAMPED: " + m + "\n"); process.exit(1); }
var destination = process.argv[1] || "";
// THE DIGEST OF THE RECORD THE CALLER READ AND AUDITED (o3d-secops r28, Codex HIGH 3).
//
// WHAT IT CLOSES. This program used to load the record and, some lines later, rename a modified
// copy over the path -- with no lock and nothing tying the write to the read. Between them a
// concurrent release can restore CONNECT and remove the record; the rename then RESURRECTS it,
// stamped, claiming a fence that is not standing. That stamped record buys the recovery rule and
// licenses a later GRANT CONNECT back to every role it names.
//
// The caller now holds the cutover lock across its whole read/audit/action sequence, which is
// what actually serialises this. The digest is the second half of the same answer and is worth
// having on its own: it makes the write conditional on the exact bytes that were audited, so even
// unserialised the stamp cannot land on a record that changed underneath it.
//
// REQUIRED WHEN SUPPLIED, and never quietly skipped: a caller that has a digest and passes an
// empty string would otherwise get the old unconditional behaviour with the appearance of the new
// one. Omitted entirely it is the pre-r28 contract, which is what db_fence_raise() uses on the
// path where publication and stamp are one privileged step under one lock.
var expectedDigest = process.argv[2] === undefined ? null : String(process.argv[2]);
if (expectedDigest !== null && !/^[0-9a-f]{64}$/.test(expectedDigest)) fail("the stamp was given something that is not a sha256 digest to hold the record to");
if (!destination) fail("the stamp was not told which authority it is marking applied");
var directory = path.dirname(destination);
var meta = null;
try { meta = fs.lstatSync(directory); } catch (e) { fail(directory + " could not be examined (" + e.message + ")"); }
if (!meta.isDirectory()) fail(directory + " is not a directory");
if (meta.uid !== process.getuid()) fail(directory + " is owned by uid " + meta.uid + " and this run is uid " + process.getuid() + ", so a stamp written there could be replaced by somebody else");
if ((meta.mode & 18) !== 0) fail(directory + " is writable by group or other, so any name in it can be renamed or unlinked by another account");
var fileMeta = null;
try { fileMeta = fs.lstatSync(destination); } catch (e) { fail(destination + " could not be examined (" + e.message + "), so there is no authority to stamp"); }
if (!fileMeta.isFile()) fail(destination + " is not a regular file");
if (fileMeta.uid !== process.getuid()) fail(destination + " is owned by uid " + fileMeta.uid + " and this run is uid " + process.getuid() + ", so it was not published by this account");
var raw = "";
var rawBytes = null;
try { rawBytes = fs.readFileSync(destination); } catch (e) { fail(destination + " could not be opened (" + e.message + ")"); }
raw = rawBytes.toString("utf8");
// THE COMPARE, BEFORE ANYTHING IS DECIDED ABOUT THE CONTENT. A record that changed between the
// caller's audit and this one is not a record whose "already stamped" is reassuring either: it
// is a DIFFERENT record, and the only safe thing to do with it is refuse and say so.
if (expectedDigest !== null) {
  var actualDigest = require("crypto").createHash("sha256").update(rawBytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    fail(destination + " is not the record that was inspected and audited: it hashed to " + expectedDigest + " then and hashes to " + actualDigest + " now, so something rewrote or replaced it in between. Stamping it would attach a decision taken about one record to a different one. NOTHING HAS BEEN CHANGED; inspect it again and decide again.");
  }
}
var record = null;
try { record = JSON.parse(raw); } catch (e) { fail(destination + " does not hold valid JSON (" + e.message + ")"); }
if (record === null || typeof record !== "object" || Array.isArray(record)) fail(destination + " does not hold a JSON object");
if (record.state_complete !== 1) fail(destination + " does not carry the completeness sentinel, so it is truncated or is not an authority record");
if (record.fence_applied === 1) { process.stderr.write("The connection-fence authority at " + destination + " is already stamped applied.\n"); process.exit(0); }
record.fence_applied = 1;
var temporary = destination + ".applied." + process.pid + ".tmp";
var fd = -1;
try {
  fd = fs.openSync(temporary, "wx", 384);
  fs.writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = -1;
  fs.chmodSync(temporary, 420);
  fs.renameSync(temporary, destination);
} catch (e) {
  if (fd !== -1) { try { fs.closeSync(fd); } catch (ignored) { void ignored; } }
  try { fs.unlinkSync(temporary); } catch (ignored) { void ignored; }
  fail("the applied stamp could not be written at " + destination + " (" + e.message + ")");
}
var dirFd = -1;
try {
  dirFd = fs.openSync(directory, "r");
  fs.fsyncSync(dirFd);
  fs.closeSync(dirFd);
} catch (e) {
  if (dirFd !== -1) { try { fs.closeSync(dirFd); } catch (ignored) { void ignored; } }
  fail("the applied stamp is in place at " + destination + " and its NAME is not durable (" + e.message + "), so a power cut can restore the unstamped record");
}
process.stderr.write("The connection-fence authority at " + destination + " is stamped APPLIED: the fence it records is standing, and a later re-fence over it may use the recovery rule.\n");
MARK_APPLIED_EOF
}

# Raise this run's published authority to "applied". ROOT ONLY. Same capture-with-status and same
# stripped interpreter environment as db_fence_authorise_plan(), for the same two reasons.
db_fence_mark_authority_applied() {
  local destination="$1" expected_digest="${2:-}" program
  [[ -n "${destination}" ]] || return 1
  program="$(db_fence_mark_applied_program)" || return 1
  [[ -n "${program}" ]] || return 1
  # OMITTED MEANS OMITTED, AND EMPTY MEANS EMPTY (o3d-secops r28). The program refuses a second
  # argument that is not a sha256, so passing "" would turn "this caller has no digest" into a
  # refusal -- and passing it silently as though it were absent would turn "this caller's digest
  # went missing" into an unconditional write wearing the appearance of a conditional one. Two
  # branches, because they are two different facts. Every caller that HAS a digest is required to
  # supply it; see db_fence_raise(), which refuses to stamp without one.
  if [[ -n "${expected_digest}" ]]; then
    env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
      node -e "${program}" -- "${destination}" "${expected_digest}"
  else
    env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
      node -e "${program}" -- "${destination}"
  fi
}

# ---------------------------------------------------------------------------
# IS THIS THE AMBIGUOUS RECORD, AND NOTHING ELSE? (o3d-secops r26, Codex HIGH)
#
# The first step of the operator resolution, and it is a GATE rather than a reading: the wrapper
# that follows it is allowed to CLEAR a record or STAMP one applied, so before it asks the database
# anything it has to establish that the record in front of it is the one narrow thing the whole
# procedure is for -- an authority a validator predating the stamp published, carrying no
# `fence_applied` key at all.
#
# EVERYTHING ELSE IS REFUSED BY NAME, and each refusal is a different mistake:
#   * no record          nothing to resolve; if a fence is standing it is standing behind no
#                        account of what it revoked, which this cannot fix and must not paper over.
#   * `fence_applied` 1  already resolved, or raised by this round. There is no ambiguity to
#                        settle and stamping it again would say a decision was taken that was not.
#   * `fence_applied` 0  NOT ambiguous either: this round's own validator wrote it, and it means
#                        published-never-applied. The ordinary path already reads it as INITIAL and
#                        re-fences it under the strict rule; there is nothing for an operator here.
#   * not an authority   truncated, not JSON, not root's. A record that cannot be read is not a
#                        record whose grantee list may be handed to an ACL comparison.
#
# ROOT ONLY, and READ-ONLY: it opens nothing, writes nothing and removes nothing. It prints the
# grantee list so the operator sees what the ACL is about to be asked about, and its EXIT STATUS is
# the whole of what the wrapper acts on.
#
# It is a FUNCTION for the reason the other two programs are: the script-scope census in
# tests/scripts/install-root-safe-writes.test.ts reads declarations one line at a time and cannot
# carry a fifty-line quoted value.
db_fence_legacy_inspect_program() {
  cat <<'LEGACY_INSPECT_EOF'

var fs = require("fs");
var path = require("path");
function fail(m) { process.stderr.write("NOT RESOLVABLE: " + m + "\n"); process.exit(1); }
var destination = process.argv[1] || "";
if (!destination) fail("the inspection was not told which authority it is examining");
var directory = path.dirname(destination);
var meta = null;
try { meta = fs.lstatSync(directory); } catch (e) { fail(directory + " could not be examined (" + e.message + ")"); }
if (!meta.isDirectory()) fail(directory + " is not a directory");
if (meta.uid !== process.getuid()) fail(directory + " is owned by uid " + meta.uid + " and this run is uid " + process.getuid() + ", so what it holds could have been put there by somebody else");
if ((meta.mode & 18) !== 0) fail(directory + " is writable by group or other, so any name in it can be renamed or unlinked by another account");
var fileMeta = null;
try { fileMeta = fs.lstatSync(destination); } catch (e) { fail("there is no connection-fence authority at " + destination + " to resolve (" + e.message + "). Nothing has been changed."); }
if (!fileMeta.isFile()) fail(destination + " is not a regular file");
if (fileMeta.uid !== process.getuid()) fail(destination + " is owned by uid " + fileMeta.uid + " and this run is uid " + process.getuid() + ", so it was not published by this account and its grantee list is somebody else's");
var raw = "";
var rawBytes = null;
try { rawBytes = fs.readFileSync(destination); } catch (e) { fail(destination + " could not be opened (" + e.message + ")"); }
raw = rawBytes.toString("utf8");
var record = null;
try { record = JSON.parse(raw); } catch (e) { fail(destination + " does not hold valid JSON (" + e.message + ")"); }
if (record === null || typeof record !== "object" || Array.isArray(record)) fail(destination + " does not hold a JSON object");
if (record.state_complete !== 1) fail(destination + " does not carry the completeness sentinel, so it is truncated or is not an authority record. Nothing may be concluded from a record that is not whole.");
if (Object.prototype.hasOwnProperty.call(record, "fence_applied")) {
  if (record.fence_applied === 1) fail(destination + " is already stamped applied, so it records a fence that is known to stand and there is nothing ambiguous about it. To take that fence down, use the release wrapper.");
  fail(destination + " carries `fence_applied` at " + JSON.stringify(record.fence_applied) + ", which this round's own validator writes and which means PUBLISHED, NEVER APPLIED. That is not ambiguous either: the ordinary cutover already reads it as an INITIAL fence and re-fences under the strict rule. There is nothing here for an operator to resolve.");
}
if (!Array.isArray(record.revoked) || record.revoked.length < 1) fail(destination + " names no grantees, so there is nothing whose CONNECT could show whether a fence stands. Nothing may be concluded from it.");
for (var i = 0; i < record.revoked.length; i++) {
  if (typeof record.revoked[i] !== "string" || record.revoked[i].length === 0) fail("grantee " + i + " in " + destination + " is not a usable role name");
}
process.stderr.write("The authority at " + destination + " carries no applied stamp: it was published by a validator that predates the stamp, and it is ambiguous between a fence raised then and a publication that never reached BEGIN. It names " + record.revoked.length + " grantee(s) on " + JSON.stringify(record.database) + ": " + record.revoked.join(", ") + ".\n");
process.stderr.write("Asking the live ACL which of the two it is. Nothing has been changed yet.\n");
// THE DIGEST OF THE RECORD THIS INSPECTION PASSED, ON THE MACHINE CHANNEL (o3d-secops r28, Codex
// HIGH 3). Everything the wrapper does after this -- an audit in another process, then a stamp or
// a removal -- is a decision about THIS record, and the caller binds the action to it with this
// value. Printed at the very end so that a refusal above emits nothing for a caller to act on.
process.stdout.write("authority_sha256=" + require("crypto").createHash("sha256").update(rawBytes).digest("hex") + "\n");
LEGACY_INSPECT_EOF
}

# ---------------------------------------------------------------------------
# REMOVING A RECORD, CONDITIONALLY ON ITS BEING THE ONE THAT WAS READ (o3d-secops r28, Codex HIGH 3)
#
# The other side of the stamp's compare-and-swap, and it is the more expensive mistake of the two:
# a record removed in error destroys the only account of what a standing fence revoked, and the
# release wrapper then has nothing to restore from. `rm -f` cannot ask the question -- it acts on
# a NAME, and between the audit that decided and the unlink that acts, a concurrent release can
# have removed the record and a concurrent fence published a new one at the same path.
#
# ROOT ONLY, for the reason every other write here is: the directory is root-owned.
db_fence_clear_authority_program() {
  cat <<'CLEAR_AUTHORITY_EOF'

var fs = require("fs");
var path = require("path");
function fail(m) { process.stderr.write("NOT CLEARED: " + m + "\n"); process.exit(1); }
var destination = process.argv[1] || "";
var expectedDigest = String(process.argv[2] || "");
if (!destination) fail("the removal was not told which authority it is clearing");
if (!/^[0-9a-f]{64}$/.test(expectedDigest)) fail("the removal was not given the digest of the record that was inspected and audited, so it cannot show that the record it is about to destroy is that one");
var directory = path.dirname(destination);
var meta = null;
try { meta = fs.lstatSync(directory); } catch (e) { fail(directory + " could not be examined (" + e.message + ")"); }
if (!meta.isDirectory()) fail(directory + " is not a directory");
if (meta.uid !== process.getuid()) fail(directory + " is owned by uid " + meta.uid + " and this run is uid " + process.getuid() + ", so what it holds could have been put there by somebody else");
if ((meta.mode & 18) !== 0) fail(directory + " is writable by group or other, so any name in it can be renamed or unlinked by another account");
var fileMeta = null;
try { fileMeta = fs.lstatSync(destination); } catch (e) { fail("there is no authority at " + destination + " to clear (" + e.message + ")"); }
if (!fileMeta.isFile()) fail(destination + " is not a regular file");
if (fileMeta.uid !== process.getuid()) fail(destination + " is owned by uid " + fileMeta.uid + " and this run is uid " + process.getuid() + ", so it was not published by this account");
var rawBytes = null;
try { rawBytes = fs.readFileSync(destination); } catch (e) { fail(destination + " could not be opened (" + e.message + ")"); }
var actualDigest = require("crypto").createHash("sha256").update(rawBytes).digest("hex");
if (actualDigest !== expectedDigest) fail(destination + " is not the record that was inspected and audited: it hashed to " + expectedDigest + " then and hashes to " + actualDigest + " now, so something rewrote or replaced it in between. Removing it would destroy an account of a fence nobody here has looked at. NOTHING HAS BEEN CHANGED; inspect it again and decide again.");
try { fs.unlinkSync(destination); } catch (e) { fail(destination + " could not be removed (" + e.message + ")"); }
var dirFd = -1;
try {
  dirFd = fs.openSync(directory, "r");
  fs.fsyncSync(dirFd);
  fs.closeSync(dirFd);
} catch (e) {
  if (dirFd !== -1) { try { fs.closeSync(dirFd); } catch (ignored) { void ignored; } }
  fail("the authority at " + destination + " is gone and its REMOVAL is not durable (" + e.message + "), so a power cut can bring the record back. It describes a fence that is not standing; if it returns, resolve it again.");
}
process.stderr.write("The connection-fence authority at " + destination + " has been removed.\n");
CLEAR_AUTHORITY_EOF
}

# Establish that ${1} is the ambiguous legacy record and nothing else. ROOT ONLY, READ-ONLY. Same
# capture-with-status and same stripped interpreter environment as the other two, for the same two
# reasons: an empty program would exit 0 having examined nothing, and an environment variable is a
# way to make a root-side `node` load a file nobody here named.
db_fence_inspect_legacy_authority() {
  local destination="$1" program
  [[ -n "${destination}" ]] || return 1
  program="$(db_fence_legacy_inspect_program)" || return 1
  [[ -n "${program}" ]] || return 1
  env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
    node -e "${program}" -- "${destination}"
}

# The whole privileged step, from the plan text a caller captured to a published authority.
#
# THE DIRECTORY IS ASKED ABOUT TWICE, HERE AND INSIDE THE PROGRAM, and that is deliberate rather
# than redundant: this one refuses BEFORE `node` is started, so the failure a caller sees names
# the namespace; the one inside is made in the same process that does the rename, which is the
# only one that cannot be raced. dir_is_private_to_this_run() is lib/cutover-namespace.sh own, and
# every entrypoint sources both libraries before either of them runs.
db_fence_publish_authority() {
  local plan="$1" destination="$2" expected_database="$3" expected_app_role="$4" directory
  directory="$(dirname "${destination}")"
  if ! declare -F dir_is_private_to_this_run >/dev/null 2>&1; then
    echo "The cutover namespace library is not loaded, so this run cannot establish that ${directory} is a directory only it may write. Refusing to publish a connection-fence authority into it." >&2
    return 1
  fi
  if ! dir_is_private_to_this_run "${directory}"; then
    echo "${directory} is not a directory only this run may write, so an authority published there could be replaced before anything acted on it. Refusing to publish a connection-fence authority into it." >&2
    return 1
  fi
  [[ -n "${plan}" ]] || { echo "The fence plan is empty, so there is nothing to authorise and nothing has been published." >&2; return 1; }
  # THE DIGEST OF WHAT WAS PUBLISHED, HANDED BACK IN THE CALLER'S OWN FRAME (o3d-secops r28, Codex
  # HIGH 3). The validator prints it on stdout; the caller stamps the record a moment later and
  # holds the stamp to these exact bytes. It is a name the CALLER declares `local` -- the idiom
  # _fence_probe_assemble() uses and for the same reason -- so a value that steers a privileged
  # write lives only in the frame that consumes it and there is no script-scope name for another
  # path to write. A command substitution cannot be used instead: it would take the validator's
  # stderr with the subshell, and that stderr is what tells an operator what was published.
  _fence_published_digest=""
  local authorised
  authorised="$(printf '%s\n' "${plan}" | db_fence_authorise_plan "${expected_database}" "${expected_app_role}" "${destination}")" || return 1
  _fence_published_digest="$(printf '%s\n' "${authorised}" | sed -n 's/^authority_sha256=\([0-9a-f]\{64\}\)$/\1/p' | tail -1)"
  return 0
}

# WHOSE JOB IT IS TO REMOVE THE RECORD (o3d-secops r23). The helper cannot: an unlink is a write to
# the directory, and that directory is root own. So a verified release is followed by this -- and,
# since r24, so is an INITIAL fence that was refused before it revoked anything, where the record
# this run published describes a fence that does not exist and would otherwise make the next
# attempt a "recovery". Those are the two callers and there are no others. The ORDER is deliberate
# for the release: between the GRANTs landing and this call the record
# describes a fence that has been released, which is the safe way round -- a `--fence` over it
# re-applies the same grantee list and a second `--release` re-grants what is already granted,
# where removing it first would lose the only account of what was revoked.
# AND IT IS NOT AUTHORISED BY A DATABASE (o3d-secops r30, Codex HIGH 1)
#
# THE FINDING, AND WHY IT IS THE END OF AN ARGUMENT RATHER THAN THE START OF ONE. r29 measured, on
# real clusters, that a PHYSICAL CLONE TAKEN AFTER THE FENCE is indistinguishable from the cluster
# it was copied from: same system identifier, same database OID, same timeline, the same revoked
# ACL, and even the same xmin and ctid on the pg_database row. A `--release` pointed at such a copy
# therefore reads a standing fence, grants, verifies, and exits 0 -- correctly, on the evidence it
# has -- and every fact it could ever gather was copied along with the data. r29 disclosed that
# residual honestly and left this unlink hanging off that exit status, which is the defect: the
# release succeeds on the copy and root then destroys the ONE account of the fence still standing
# on the real server, the only thing a genuine release could have been built from.
#
# A MEASURED RESIDUAL IN A DESTRUCTIVE PATH IS A FINDING, and no in-database attestation retires
# it. The connection endpoint was the tempting candidate -- inet_server_addr() and
# inet_server_port() are properties of the socket rather than of the data directory, so a copy
# running elsewhere does report different ones -- but it is not a total rule either: a copy that
# takes over the origin's address after the origin has moved reads as the origin. It would shrink
# this residual and not close it, at the price of a new recorded field through the validator, the
# compare-and-swap and the census, and a fallback to "unproven" on every unix-socket and pooled
# installation. Trading a total rule for a smaller residual in the same destructive path is how
# this defect gets re-found in a later round with a longer comment attached.
#
# SO THE ATTESTATION IS NOT ABOUT THE DATABASE AT ALL. It is root's own memory, in this process, of
# an act it performed itself: THIS RUN RAISED THE FENCE IT IS NOW RELEASING. On the ordinary
# cutover that is simply true -- db_fence_raise() published this record and revoked from it minutes
# ago, over the same connection string, under the same cutover lock -- and it is a fact no copy of
# any cluster can produce, because it is not in any cluster. The ordinary deploy, update and
# install therefore stay exactly as automatic as they were, which is what the arm exists for.
#
# AND THAT WAS HALF OF THE QUESTION (o3d-secops r31, Codex HIGH 1). "This run raised the fence it is
# now releasing" is a fact about a PROCESS, and the paragraph above rests it on "over the same
# connection string" -- which is precisely the thing a DNS change, a connection pooler or a failover
# re-points between the two processes that do the raising and the releasing. The memory stays true
# across such a redirect, so it could license the removal of the record of a fence still standing on
# a server this run is no longer talking to: the residual the paragraph above claims to have escaped,
# re-entered one layer up.
#
# NOTE WHAT r29's REASONING RULES OUT, because it rules out the cheap answers here too. Nothing in a
# data directory separates an origin from a copy, and the two connection-level candidates -- the
# server address, and the postmaster's start time -- are refused a few hundred lines up in
# fence-db-connections.mjs for reasons this round does not improve on. Each would shrink the
# residual and not close it, and the paragraph above says what that is worth.
#
# So the removal now takes a SECOND answer, about WHERE rather than WHO, and it is measured rather
# than remembered: a witness session, opened before anything was revoked and still holding a lock on
# a nonce generated seconds ago, that BOTH the fencing connection and the releasing connection could
# see for themselves. See the section above db_fence_witness_start(), and ${3} below.
#
# WHERE THAT MEMORY IS ABSENT, NOTHING HERE DELETES. A release of a record some EARLIER run
# published -- the standalone release wrapper an operator runs days later, or the start path
# checking whether a previous cutover left a fence standing -- is precisely the case in which the
# copy is realistic and the record is somebody else's account of what they revoked. That returns 2
# and says so: distinct from 1, because "must not" and "could not" want different sentences from
# the caller, and neither of them is success.
#
# THE WORD ITSELF IS A LITERAL AND NOT A SCRIPT-SCOPE NAME, deliberately. A name holding the value
# that licenses an unlink is a name some later path can assign to, which is the whole subject of
# the sink census in tests/scripts/install-root-safe-writes.test.ts; a literal compared in place has
# nothing to write. Nothing else is accepted -- not an empty argument, not `true`, and not a value
# the shell might produce by accident from an unset name under `set -u`.
db_fence_clear_authority() {
  local destination="$1" attestation="${2:-}" server="${3:-}"
  [[ -n "${destination}" ]] || return 0
  # NOTHING THERE IS NOTHING TO REFUSE. Callers reach this after a release that found no record at
  # all -- adopt_db_connections() takes that path deliberately -- and a gate that turned an absent
  # file into a refusal would stop a recovery on the one state that needs no decision at all.
  [[ -e "${destination}" || -L "${destination}" ]] || return 0
  if [[ "${attestation}" != "raised-by-this-run" ]]; then
    echo "NOT REMOVING ${destination}: this run did not raise the fence that record describes, so it cannot show that the server it just released is the server the record was written against." >&2
    echo "A copy of a fenced cluster -- a base backup, a restored snapshot, a staging clone reachable at the same name -- carries the fence with it and answers a release exactly as the original does; nothing readable separates the two. Removing the record here would destroy the only account of what a fence still standing on the real server revoked." >&2
    echo "The grants this run issued are unaffected and are safe to repeat. What is left is the record, and it is ended by a person: run ${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER} as root, which reaches the same answer and then offers to remove it once, after a token derived from that record's exact bytes is typed at your terminal." >&2
    return 2
  fi
  # AND THE SECOND HALF OF THE ATTESTATION: WHICH SERVER (o3d-secops r31, Codex HIGH 1).
  #
  # r30 asked only whether THIS RUN raised the fence, which is a fact about this PROCESS. A process
  # spans two connections and a connection is what a proxy or a failover re-points, so that answer
  # could be true of a run whose release landed on a copy of the fenced cluster -- and the removal
  # would then destroy the only account of the fence still standing on the original. So the caller
  # must also say WHICH SERVER it is speaking about, and there are exactly two things it may say:
  #
  #   same-server-as-the-fence   the release's OWN connection saw the witness session that
  #                              `--fence` saw from the backend it revoked on. See
  #                              db_fence_witness_challenge() and the section above it.
  #   nothing-was-revoked        no REVOKE was ever issued from this record, so there is no server
  #                              to be wrong about. db_fence_raise()'s two removals of its own
  #                              never-executed publication, and only those.
  #
  # BOTH ARE LITERALS COMPARED IN PLACE, for the reason the first attestation is: a name holding the
  # value that licenses an unlink is a name some later path can assign to, which is the subject of
  # the sink census in tests/scripts/install-root-safe-writes.test.ts. Nothing else is accepted --
  # not an empty argument, and not a value `set -u` might produce from an unset name.
  if [[ "${server}" != "same-server-as-the-fence" && "${server}" != "nothing-was-revoked" ]]; then
    echo "NOT REMOVING ${destination}: nothing here can show that the server this run released is the server the record was written against, so the record is kept." >&2
    echo "A release runs on a connection, and a connection is what DNS, a pooler or a failover re-points; the fence and the release are two of them. This run held no connection witness across the pair, or the release's own connection could not see one -- so \"this run raised a fence\" is all that is known, and that is a fact about this process rather than about a server." >&2
    echo "A copy of a fenced cluster -- a base backup, a restored snapshot, a staging clone reachable at the same name -- answers a release exactly as the original does, so removing the record here could destroy the only account of what a fence still standing on the real server revoked." >&2
    echo "The grants this run issued are unaffected and are safe to repeat. What is left is the record, and it is ended by a person: run ${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER} as root, which reaches the same answer and then offers to remove it once, after a token derived from that record's exact bytes is typed at your terminal." >&2
    return 2
  fi
  rm -f "${destination}" 2>/dev/null || true
  [[ ! -e "${destination}" ]] || return 1
  return 0
}


# ---------------------------------------------------------------------------
# RAISING A FENCE, END TO END, IN ONE PLACE (o3d-secops r23)
#
# Three steps, and the middle one is the privileged one. Every entrypoint calls this instead of
# invoking the helper directly, because the ORDER is the property: the authority is on the medium
# before a single REVOKE is issued, and a publication that cannot be proved aborts the fence
# rather than permitting a revoke nothing records. Three copies of an ordering is how two of them
# come to disagree.
#
# WHAT ROOT VALIDATES THE PLAN AGAINST IS WHAT ROOT TOLD THE HELPER. The database and the role are
# read back out of the identity arguments this function is passing on, not taken from the plan and
# not passed in separately: a second parameter could drift from the argument, and then root would
# be checking the request against the request.
#
# db_fence_helper() is the one thing each entrypoint supplies for itself -- the three of them drop
# to ${APP_USER} in three different ways, with three different environments -- and it is the only
# part of raising a fence that is not written down once.
# ---------------------------------------------------------------------------
# THE CONNECTION WITNESS (o3d-secops r31, Codex HIGH 1)
#
# WHY IT EXISTS, in one paragraph; the argument in full is above doWitness() in
# fence-db-connections.mjs. r30 made root's automatic removal of the fence record conditional on
# ${DB_FENCE_RAISED} -- this run's memory of having raised the fence. That is a fact about a
# PROCESS, and `--fence` and `--release` are two processes on two connections; a proxy, a DNS
# change or a failover between them re-points the connection while the Boolean stays true, so the
# attestation could be spent against a backend that never saw the fence. What binds to a
# CONNECTION is a connection that stays open, so one does: a witness session takes a session-scoped
# advisory lock -- shared memory, carried by no file-level copy of a cluster -- and `--fence` and
# `--release` each ASK THEIR OWN CONNECTION whether it is visible.
#
# ROOT DOES NOT BELIEVE THE WITNESS, WHICH IS WHY THE CHANNEL BELOW MAY BE A PIPE. Nothing this
# co-process says is evidence of anything. The nonce is root's; the only party told it is the
# witness; and the answer root acts on comes from `--release` reporting what ITS OWN DATABASE
# CONNECTION could see. A co-process that lied about holding a lock would produce a `--release`
# that reports `witness_colocated=no`, and the record would be kept.
#
# AND IT CAN NEVER COST A DEPLOY ITS FENCE. Every failure here -- no coproc, no second database in
# the cluster, a session dropped by an idle timeout, a pooler that gives out no stable backend --
# leaves ${DB_FENCE_WITNESS_BOUND} at 0, and that costs exactly one thing: the record is kept at
# the end of the run and a person ends it with the release wrapper. No path here refuses a fence,
# fails a release, or returns non-zero into anything that decides whether a migration may run.
# ---------------------------------------------------------------------------

# `set -u` is in force in every entrypoint, and the coproc array does not exist until one is
# started, so all four names are initialised here and never merely declared.
# THE TWO NONCES ARE NOT AMONG THEM, DELIBERATELY (o3d-secops r31). A nonce is minted by the
# function that is about to spend it and handed to the witness as an ARGUMENT, so it lives in one
# `local` in one frame and there is no script-scope name any later path could write. That is the
# remedy the sink census in tests/scripts/install-root-safe-writes.test.ts asks for by name, and it
# is the right shape here for its own sake: a value that steers what a privileged run will accept as
# proof should not be reachable from anywhere but the two lines that use it.
#
# AND NEITHER IS THE CO-PROCESS'S PID. Nothing here kills the witness or waits on it: closing the
# write end of its pipe is what ends it, the witness's own stdin loop ends on EOF, and bash reaps it
# before the next `coproc` -- measured over forty same-name restarts with no "coproc still exists"
# warning between them. A pid is the operand of `kill`, which is a DESTRUCTIVE COMMAND POSITION, and
# the census in tests/scripts/install-root-safe-writes.test.ts is right to refuse a script-scope name
# that reaches one. There is no reaping to be done that closing the pipe does not already do.
#
# SO EXACTLY ONE NAME IS LEFT: a 0/1 flag this file sets from `--fence`'s own report and reads in
# one `[[ ]]`. It can only ever WITHHOLD the automatic removal of the record.
DB_FENCE_WITNESS_BOUND=0

# 128 bits of kernel randomness as lower-case hex. It is a NONCE and not a secret: what it has to
# be is unguessable-in-advance and never reused, so that a lock on it cannot be a fact some earlier
# snapshot of a cluster happens to contain.
db_fence_witness_nonce() {
  local hex
  hex="$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')" || return 1
  [[ "${hex}" =~ ^[0-9a-f]{32}$ ]] || return 1
  printf '%s\n' "${hex}"
}

# Take the witness down. Idempotent, silent, and it returns 0 from every path: it is called on the
# way out of a run that may already be failing, and a teardown that could fail the caller would be
# a teardown that turns a lost witness into a lost deploy.
db_fence_witness_stop() {
  local fd
  # IT CLOSES THE PIPE, IT DOES NOT WRITE DOWN IT (o3d-secops r31). Closing the write end is what
  # the witness's stdin loop already ends on, and it CANNOT RAISE SIGPIPE. A `close` command sent
  # here could: the reader is very often already gone by the time this runs -- a witness that
  # refused to start is the ordinary case -- and bash does not ignore SIGPIPE, so the write killed
  # the ENTIRE ENTRYPOINT with a signal. That was measured, by an existing r23 test failing with a
  # null exit status the moment a witness could not start, and it is the worst possible shape for
  # this mechanism: a deploy lost to a witness that was never load-bearing.
  # THE CLOSES ARE GROUPED, AND THAT IS NOT COSMETIC (o3d-secops r31). `exec {fd}>&- 2>/dev/null`
  # is a BARE `exec` WITH A REDIRECTION, so bash applies the `2>/dev/null` TO THE SHELL, PERMANENTLY:
  # every warning, refusal and `die` the entrypoint printed after its first witness teardown went to
  # /dev/null. It was measured -- eight tests in tests/scripts/deploy-order.test.ts failed
  # intermittently, each of them on a message that had simply stopped existing, and each of them
  # about a fence rather than about a witness. Wrapped in `{ ...; }` the suppression belongs to the
  # group and is taken back at its closing brace, while the close itself is still the shell's.
  if [[ "${DB_FENCE_WITNESS[1]:-}" =~ ^[0-9]+$ ]]; then
    fd="${DB_FENCE_WITNESS[1]}"
    { exec {fd}>&-; } 2>/dev/null || true
  fi
  if [[ "${DB_FENCE_WITNESS[0]:-}" =~ ^[0-9]+$ ]]; then
    fd="${DB_FENCE_WITNESS[0]}"
    { exec {fd}<&-; } 2>/dev/null || true
  fi
  unset DB_FENCE_WITNESS 2>/dev/null || true
  DB_FENCE_WITNESS_BOUND=0
  return 0
}

# Open the witness session. Returns 0 when it is holding its lock and has said so, 1 otherwise —
# and every caller treats 1 as "carry on without one".
#
# THE PREVIOUS ONE IS TAKEN DOWN FIRST, because the exit trap's re-fence raises a second fence in
# the same shell and bash keeps exactly one co-process. Without this the second `coproc` warns and
# the run would go on holding a witness bound to a fence that is no longer the one being released.
db_fence_witness_start() {
  local fence_script="$1" nonce="$2"
  shift 2
  db_fence_witness_stop
  local line
  [[ "${nonce}" =~ ^[0-9a-f]{32,64}$ ]] || {
    echo "No connection witness for this run: it was given no usable nonce to hold. The fence is unaffected; its record will be kept at the end of the run for a person to end." >&2
    return 1
  }
  # The co-process inherits this shell's stderr, so everything the helper says to an operator is
  # printed live exactly as every other invocation's is. Only stdout — the protocol — is a pipe.
  coproc DB_FENCE_WITNESS { db_fence_helper "${fence_script}" --witness --witness-nonce="${nonce}" "$@"; }
  # `read` is given a deadline on every use here. A witness that never answers must cost this run
  # its automatic removal and nothing else; a blocking read would cost it the deploy.
  # THE FALLBACK IS A REFUSAL, NOT A FILE DESCRIPTOR (o3d-secops r31). Bash UNSETS the coproc array
  # the moment the co-process is reaped, so this name is routinely absent -- and a `:-0` default
  # here would have this loop read THE ENTRYPOINT'S OWN STDIN, consuming whatever an operator was
  # about to type at a confirmation prompt.
  local ready_fd="${DB_FENCE_WITNESS[0]:-}"
  if [[ ! "${ready_fd}" =~ ^[0-9]+$ ]]; then
    echo "No connection witness for this run: the witness process could not be started at all. The fence is unaffected; its record will be kept at the end of the run for a person to end." >&2
    db_fence_witness_stop
    return 1
  fi
  while read -r -t60 line <&"${ready_fd}" 2>/dev/null; do
    if [[ "${line}" == "WITNESS_READY ${nonce}" ]]; then
      return 0
    fi
  done
  echo "No connection witness for this run: the witness session did not report holding its lock (the reason, if it gave one, is printed above). The fence is unaffected; its record will be kept at the end of the run for a person to end." >&2
  db_fence_witness_stop
  return 1
}

# Ask the witness to take a lock on the nonce the CALLER minted a moment ago and is about to hand
# to `--release` to look for. The nonce is an argument rather than a script-scope name: it lives in
# one `local` in the frame that spends it, so there is nothing here a later path could write to
# change what a privileged run will accept as proof.
#
# THE FRESHNESS IS THE WHOLE MECHANISM. A lock on a number that did not exist when a copy of a
# cluster was taken cannot be in that copy, however the copy was made and whatever else it carries.
# It is generated here rather than reused from the fence for exactly that reason: the fence's nonce
# is minutes old by now, and minutes is long enough for the snapshot this is about.
db_fence_witness_challenge() {
  local nonce="$1"
  [[ "${nonce}" =~ ^[0-9a-f]{32,64}$ ]] || return 1
  [[ "${DB_FENCE_WITNESS_BOUND:-0}" -eq 1 ]] || return 1
  # READ INTO PLAIN NAMES AND VALIDATED AS NUMBERS FIRST (o3d-secops r31). Bash unsets the coproc
  # array when the co-process is reaped, and `set -u` is in force in all three entrypoints: a bare
  # ${DB_FENCE_WITNESS[1]} between the guard and the write is a fatal shell error rather than a
  # missing witness, which would turn "no automatic removal" into "no deploy".
  local read_fd="${DB_FENCE_WITNESS[0]:-}" write_fd="${DB_FENCE_WITNESS[1]:-}"
  [[ "${read_fd}" =~ ^[0-9]+$ && "${write_fd}" =~ ^[0-9]+$ ]] || return 1
  # THERE IS NO LIVENESS TEST HERE, and there does not need to be one: `kill -0` on the co-process
  # would narrow a window it cannot close -- the witness can die between the test and the write --
  # and everything below already survives a dead witness. The write ignores PIPE and reports EPIPE,
  # and the read has a deadline. A pid would also be a script-scope name reaching `kill`, which the
  # sink census refuses and is right to.
  local line wrote=0
  # AND SIGPIPE IS IGNORED ACROSS THE WRITE. `kill -0` above narrows the window and does not close
  # it: the witness can die between that test and this line, and an unignored SIGPIPE would then
  # kill the entrypoint outright. Nothing in these scripts traps PIPE, so this saves and restores
  # nothing -- it turns the signal into the EPIPE that `|| wrote=1` is written for.
  trap '' PIPE
  printf 'challenge %s\n' "${nonce}" >&"${write_fd}" 2>/dev/null || wrote=1
  trap - PIPE
  [[ "${wrote}" -eq 0 ]] || return 1
  while read -r -t60 line <&"${read_fd}" 2>/dev/null; do
    if [[ "${line}" == "WITNESS_HELD ${nonce}" ]]; then
      return 0
    fi
  done
  return 1
}

db_fence_raise() {
  local fence_script="$1" state_file="$2"
  shift 2
  local plan rc=0 argument database="" app_role="" app_user="" had_authority=0
  # Declared here so db_fence_publish_authority()'s answer lands in a frame that dies with this
  # call. Initialised, not merely declared: these scripts run under `set -u`.
  local _fence_published_digest=""
  for argument in "$@"; do
    case "${argument}" in
      --app-database=*) database="${argument#--app-database=}" ;;
      --app-user=*) app_user="${argument#--app-user=}" ;;
      --app-role=*) app_role="${argument#--app-role=}" ;;
    esac
  done
  [[ -n "${app_role}" ]] || app_role="${app_user}"
  if [[ -z "${database}" || -z "${app_role}" ]]; then
    echo "NOT FENCED: this run was not told which database and role it is fencing, so nothing could validate what a fence would revoke. Nothing has been revoked." >&2
    return 3
  fi

  # WAS A FENCE ALREADY STANDING WHEN THIS RUN ARRIVED? (o3d-secops r24.) Asked BEFORE step 2
  # republishes over whatever is there, because it decides two things and cannot be asked
  # afterwards: it is the same fact root stamps into `fence_mode`, and it is what says whether the
  # authority this run is about to publish is this run's OWN — the only one it may ever remove.
  # ${DB_FENCE_DIR} is root-owned and unwritable by anything else, so an entry at that name was put
  # there by a privileged process and the question has one answer. `-L` as well as `-e`, so a
  # dangling link counts as something being there rather than as nothing.
  if [[ -e "${state_file}" || -L "${state_file}" ]]; then had_authority=1; fi

  # STEP 1, UNPRIVILEGED: what WOULD be revoked, printed. Nothing is written and nothing is
  # revoked, so a failure here costs a message.
  plan="$(db_fence_helper "${fence_script}" --plan --state-file="${state_file}" --state-owner="$(id -u)" "$@")" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    echo "NOT FENCED: the connection fence could not be PLANNED (exit ${rc}); the reason is printed above. Nothing has been revoked, nothing has been recorded, and nothing has been migrated." >&2
    return "${rc}"
  fi

  # STEP 2, PRIVILEGED: validated field by field, rebuilt from root own template, and published
  # durably. A failure here is the refusal that keeps the asymmetry closed.
  if ! db_fence_publish_authority "${plan}" "${state_file}" "${database}" "${app_role}"; then
    # A PUBLICATION FAILS WITH THE RECORD ALREADY VISIBLE MORE OFTEN THAN IT LOOKS (o3d-secops r25,
    # Codex HIGH). The validator's LAST barrier is the directory fsync, which runs AFTER the atomic
    # rename: when it fails it says so and deliberately leaves the authority in place, because the
    # file is genuinely there and pretending otherwise would be the worse lie. Anything else that
    # can go wrong between that rename and this line -- an OOM kill of `node`, a signal -- ends the
    # same way. r24 hung its cleanup off the EXECUTION's exit 3 and this route never reaches it, so
    # the leftover record was left for the next run to read.
    #
    # It is inert either way now: it carries `fence_applied: 0`, so the next publication stamps
    # INITIAL and the strict rule applies. This is the defence in depth on top of that -- the same
    # removal, on the sibling path -- and it is bounded by ${had_authority} for the same reason it
    # is there: where a fence WAS standing when this run arrived, that record is somebody else's
    # account of what was revoked and is never this run's to remove.
    if [[ "${had_authority}" -eq 0 ]]; then
      # THIS RUN'S OWN PUBLICATION, seconds old and never revoked from: ${had_authority} was read
      # before step 2 precisely so this branch can say so. That is the attestation, and it is why
      # this removal is still automatic while the release's is not.
      if ! db_fence_clear_authority "${state_file}" "raised-by-this-run" "nothing-was-revoked"; then
        echo "The connection-fence authority could not be published AND the partial record at ${state_file} could not be removed. It carries no applied stamp, so no later run can treat it as a standing fence and it cannot buy the recovery rule; it is still litter at the authoritative path. Remove it by hand." >&2
      fi
    fi
    echo "NOT FENCED: the connection-fence authority could not be published at ${state_file} (the reason is printed above)." >&2
    echo "Refusing to revoke CONNECT. A REVOKE is a committed transaction that survives a power cut;" >&2
    echo "this record is the only thing that undoes it, and a revoke whose undo record may not survive" >&2
    echo "locks the application out of its database with nothing left to say how to let it back in." >&2
    echo "Nothing has been revoked by this run. Fix the filesystem (space, permissions, mount) and re-run." >&2
    return 3
  fi

  # STEP 2b: OPEN THE WITNESS SESSION, BEFORE ANYTHING IS REVOKED (o3d-secops r31, Codex HIGH 1).
  #
  # HERE AND NOT EARLIER, and here and not later. Not later, because the connection it has to be
  # measured against is the one `--fence` is about to revoke on, and a witness that appeared
  # afterwards would have proved nothing about the session that issued the REVOKEs. Not earlier,
  # because a fence refused at step 1 or step 2 has no server to be right or wrong about and should
  # open no connections at all.
  #
  # ITS FAILURE IS NOT A FAILURE. The status is deliberately discarded: what a missing witness costs
  # is the automatic removal of the record at the end of this run, and nothing in this function's
  # contract, its return value or the caller's next step changes because of it.
  local witness_argv=() witness_nonce=""
  witness_nonce="$(db_fence_witness_nonce)" || witness_nonce=""
  if [[ -n "${witness_nonce}" ]] && db_fence_witness_start "${fence_script}" "${witness_nonce}" "$@"; then
    witness_argv=(--witness-lock="${witness_nonce}")
  fi

  # STEP 3, UNPRIVILEGED AGAIN: execute exactly what step 2 recorded.
  #
  # ITS STDOUT IS CAPTURED AND PRINTED BACK, the way release_the_fence() has captured `--release`
  # since r28 and for the same reason: the one machine-readable line this run needs -- whether the
  # witness is on the backend that was fenced -- arrives there, while every word an operator reads
  # is on stderr and is never captured, so refusals, drains and reasons all still stream live.
  rc=0
  local fenced=""
  fenced="$(db_fence_helper "${fence_script}" --fence --state-file="${state_file}" --state-owner="$(id -u)" "${witness_argv[@]}" "$@")" || rc=$?
  [[ -z "${fenced}" ]] || printf '%s\n' "${fenced}"
  # THE ONLY THING THAT MAY RAISE THE BOUND FLAG is `--fence` saying, on the connection it fenced,
  # that it could see the witness. It is re-derived from this run's own output every time rather
  # than left standing from a previous fence in the same shell -- the exit trap's re-fence goes
  # through here too, and a flag left true across it would attest a link the new fence never made.
  if [[ "${fenced}" == *"fence_witness=colocated"* ]]; then
    DB_FENCE_WITNESS_BOUND=1
  else
    DB_FENCE_WITNESS_BOUND=0
  fi

  # STEP 4, PRIVILEGED AGAIN: THE RECORD IS TOLD THAT THE FENCE WAS APPLIED (o3d-secops r25, Codex
  # HIGH). This is the only write that ever happens AFTER a REVOKE, and it is what a later run's
  # `recovery` is read from -- rather than from the record simply being there, which says only that
  # root published something.
  #
  # THE TWO STATUSES IT IS WRITTEN FOR. 0 is a fence this run watched go up. 5 is
  # EXIT_FENCE_STANDING -- the COMMIT was issued and the acknowledgement may have been lost -- and
  # a fence that MAY be standing has to be stamped for the same reason its record is kept: the only
  # safe reading of unknown is that CONNECT may be revoked. Every other status is left unstamped,
  # and 1 in particular is NOT enumerated here on purpose: it is the helper's catch-all, it covers
  # a connection that never opened as well as a `client.end()` that threw after a successful fence,
  # and a status that cannot tell those apart may not be allowed to declare a fence applied.
  #
  # A FAILURE HERE DOES NOT FAIL THE FENCE. The fence is up; the stamp only decides what a LATER
  # run may assume, and on the ordinary path there is no later run -- the release removes the whole
  # record. So it is announced and the raise's own status is returned unchanged.
  #
  # AND IT IS HELD TO THE BYTES STEP 2 WROTE (o3d-secops r28, Codex HIGH 3). Nothing reads or
  # decides anything about this record between the publication and this line, and the whole
  # sequence runs under the cutover lock the entrypoint holds -- so the window here is narrow. It
  # is bound anyway, because binding it is one argument and because "narrow" is not a property
  # this file lets itself assert about a write that follows a read.
  if [[ "${rc}" -eq 0 || "${rc}" -eq 5 ]]; then
    if [[ -z "${_fence_published_digest}" ]]; then
      echo "The fence is up, and the publication did not report the digest of the record it wrote, so this run cannot show that the record it would stamp is the one it just published. NOT STAMPING. The fence itself is unaffected; take it down with the release wrapper printed above rather than re-running the fence, because a re-fence over an unstamped record is held to the strict rule and will refuse." >&2
    elif ! db_fence_mark_authority_applied "${state_file}" "${_fence_published_digest}"; then
      echo "The fence is up, and the authority at ${state_file} could not be stamped as applied (the reason is printed above). This costs nothing if this cutover finishes: the release removes that record. If this run DIES before the release, the next cutover reads an unstamped-in-this-round record as an INITIAL fence and REFUSES rather than re-applying, because it cannot show the fence ever stood. Take the fence down with the release wrapper printed above rather than re-running the fence." >&2
    fi
  fi

  # AND A REFUSED INITIAL FENCE LEAVES NO AUTHORITY BEHIND (o3d-secops r24, Codex HIGH).
  #
  # Exit 3 from `--fence` is EXIT_NOT_FENCEABLE, and every path in the helper that returns it is
  # strictly BEFORE `BEGIN`: nothing has been revoked, so the record this run published a moment
  # ago describes a fence that does not exist. Left there it is not merely litter. The next
  # cutover's `--plan` reads it as a standing fence and unions its grantee list, and root — which
  # decides `fence_mode` from whether an authority is present — stamps the retry RECOVERY. The
  # strict both-directions rule that just refused this run would then be unavailable to the very
  # next attempt, and one re-run would buy the tolerance the refusal exists to withhold.
  #
  # ONLY THIS RUN'S OWN PUBLICATION, WHICH IS WHY ${had_authority} IS READ BEFORE STEP 2. Where a
  # fence WAS already standing, that record is the only account of what an earlier run revoked and
  # removing it would strand every grantee it names. Then the refusal is left with the record
  # intact, exactly as before.
  if [[ "${rc}" -eq 3 && "${had_authority}" -eq 0 ]]; then
    # Again this run's own publication and nothing else: ${had_authority} bounds it.
    if ! db_fence_clear_authority "${state_file}" "raised-by-this-run" "nothing-was-revoked"; then
      echo "The connection fence was REFUSED before anything was revoked, and the authority this run published at ${state_file} could not be removed. Nothing is fenced and nothing has been migrated, but that file now describes a fence that does not exist: the next cutover will treat it as a standing one. Remove it by hand before re-running." >&2
    fi
  fi
  return "${rc}"
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
# AND A THIRD THAT IS NOT ONE OF THEM (o3d-secops r26, Codex HIGH). ${DB_FENCE_RESOLVE_WRAPPER} is
# not printed by any banner and is named by exactly one thing: the refusal an authority with no
# applied stamp produces. It is the one-time way out of an ambiguity nothing on the filesystem can
# settle, it is driven BY AN OPERATOR rather than by a cutover, and it is published here with the
# other two so that the refusal names a path that already exists on the host reading it. It is
# generated in the same loop, from the same body, and differs only in which of the three functions
# at the bottom the dispatch line calls.
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
# stays too — a mode is not a proof, and the gate is what holds if one ever changes — and since
# r23 that gate is root-only, matching what the wrapper now has to do.
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
#   * runs as ROOT and drops to the application user for the helper only. Until o3d-secops r23 it
#     also accepted being run BY that account, because the state file was that account's to write.
#     It is not any more: the authority is published, and removed, by root — so a wrapper the
#     application account could usefully run is a wrapper that could write the authority, which is
#     the finding this round closes.
#   * carries the three steps of raising a fence, not one: `--plan` as the application user, the
#     privileged validator (baked in from the library's single copy) which publishes the authority
#     durably, and then `--fence`. Releasing is the same shape in reverse — release, then root
#     removes the record.
# ---------------------------------------------------------------------------
db_fence_publish_operator_wrappers() {
  # THE CUTOVER LOCK IS PASSED IN, NOT RE-SPELT (o3d-secops r28, Codex HIGH 3). It is the
  # entrypoint's own ${LOCK_FILE}; a second literal in this library is a second thing to keep in
  # step with /etc/ims-cutover-state, and a wrapper locking a DIFFERENT file from the one deploy.sh
  # locks would report an exclusion it does not have -- which is the shape of the finding, not a
  # fix for it.
  local app_user="$1" env_file="$2" state_file="$3" cutover_lock="$4" artefact_digest
  shift 4
  if [[ -z "${cutover_lock}" ]]; then
    echo "The operator wrappers were not told which file the shared cutover lock lives at. They open a fence record, ask the database about it and then write or remove it, and a sequence that is not serialised against a running cutover can act on a record that changed underneath it. Refusing to publish them." >&2
    return 1
  fi
  _fence_protected_dir_ready || return 1
  artefact_digest="$(fence_record_artefact_digest)" || return 1

  local identity="" arg expected_database="" expected_app_role="" expected_app_user="" baked_program baked_stamp baked_inspect baked_clear
  # The validator these wrappers carry is the library's own, captured with its status taken: a
  # wrapper baked around an empty program would validate nothing and publish nothing, silently.
  baked_program="$(db_fence_authorise_plan_program)" || return 1
  [[ -n "${baked_program}" ]] || return 1
  # AND SO IS THE APPLIED STAMP (o3d-secops r25). A re-fence wrapper that raised a fence and did not
  # stamp it would leave the record saying "published, never applied" behind a fence that IS
  # standing, and the next cutover would refuse it. The two programs are baked the same way, from
  # the same single copy, for the same reason: a wrapper carries a generated copy rather than a
  # second one somebody wrote.
  baked_stamp="$(db_fence_mark_applied_program)" || return 1
  [[ -n "${baked_stamp}" ]] || return 1
  # AND THE LEGACY GATE (o3d-secops r26). The resolution wrapper may CLEAR a record or STAMP one
  # applied, so the check that the record in front of it is the ambiguous legacy one is baked from
  # the library's single copy exactly like the other two -- a gate a wrapper carried its own
  # version of is a gate that can come to disagree with the refusal that sent the operator to it.
  baked_inspect="$(db_fence_legacy_inspect_program)" || return 1
  [[ -n "${baked_inspect}" ]] || return 1
  # AND THE CONDITIONAL REMOVAL (o3d-secops r28). The resolution may DESTROY the only account of
  # what a fence revoked, so the removal is held to the digest of the record that was audited
  # exactly as the stamp is -- and it is baked from the library's single copy like the other three.
  baked_clear="$(db_fence_clear_authority_program)" || return 1
  [[ -n "${baked_clear}" ]] || return 1
  for arg in "$@"; do
    [[ -n "${arg}" ]] || continue
    identity+=" $(printf '%q' "${arg}")"
    case "${arg}" in
      --app-database=*) expected_database="${arg#--app-database=}" ;;
      --app-user=*) expected_app_user="${arg#--app-user=}" ;;
      --app-role=*) expected_app_role="${arg#--app-role=}" ;;
    esac
  done
  [[ -n "${expected_app_role}" ]] || expected_app_role="${expected_app_user}"

  # LOWERCASE NAMES INSIDE THE GENERATED SCRIPT, deliberately. The wrapper body below is a
  # QUOTED heredoc — bash writes it out, it does not expand it — but the repository's `set -u`
  # guards scan this library line by line for `${NAME}` in capitals and cannot tell a written
  # name from an expanded one. Capitals here would make those guards report names that nothing
  # in this shell ever reads, and a guard that reports false names is a guard that gets switched
  # off. The one capitalised name in the wrapper is DEPLOY_ADMIN_DATABASE_URL, which is a real
  # environment variable in both scripts.
  local mode
  for mode in release fence resolve; do
    local target="${DB_FENCE_RELEASE_WRAPPER}"
    [[ "${mode}" == "fence" ]] && target="${DB_FENCE_REFENCE_WRAPPER}"
    [[ "${mode}" == "resolve" ]] && target="${DB_FENCE_RESOLVE_WRAPPER}"
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
      # THE IDENTITY AS AN ARRAY, not as a pre-quoted string: it is passed to two invocations now
      # (--plan and --fence) and a string that was correct when it was spliced into one command
      # line is a second thing to get right at the other.
      printf 'identity_argv=(%s)\n' "${identity}"
      # AND THE TWO VALUES ROOT VALIDATES THE PLAN AGAINST, read out of that same identity for the
      # reason db_fence_raise() reads them out of its own arguments: a value carried separately
      # can drift from the one the helper was actually told.
      printf 'expected_database=%q\n' "${expected_database}"
      printf 'expected_app_role=%q\n' "${expected_app_role}"
      printf 'authorise_plan=%q\n' "${baked_program}"
      printf 'mark_applied=%q\n' "${baked_stamp}"
      printf 'legacy_inspect=%q\n' "${baked_inspect}"
      printf 'clear_authority=%q\n' "${baked_clear}"
      printf 'cutover_lock=%q\n' "${cutover_lock}"
      # The path the validator names in its refusal, so the wrapper the operator lands on and the
      # message that sent them there are the same string composed once.
      printf 'resolve_wrapper=%q\n' "${DB_FENCE_RESOLVE_WRAPPER}"
      printf 'release_wrapper=%q\n' "${DB_FENCE_RELEASE_WRAPPER}"
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
# BASH BUILTINS ONLY, AND FOR A STATED REASON. This gate runs before anything else in the
# wrapper, including the digest check, so it has to hold on a PATH that carries nothing: a
# `dirname` or a `stat` here turns "you are not the right account" into "command not found" at
# the one moment there is no time to debug it. `${var%/*}` is the shell own dirname and `-O` is
# the shell own "owned by the effective uid". The mode of that directory is asked as well, but
# in the process that does the publication -- see the validator, which lstats it and refuses a
# group- or other-writable one before it renames anything.
authority_dir="${state_file%/*}"
if [[ -z "${authority_dir}" || ! -d "${authority_dir}" || ! -O "${authority_dir}" ]]; then
  echo "Run this as the account that owns ${authority_dir} — on an installed host that is root: ${sudo_prefix}${self}" >&2
  echo "This wrapper PUBLISHES and REMOVES the connection-fence authority in that directory, and drops to ${app_account} to run the protected helper. Until o3d-secops r23 it also accepted being run BY ${app_account}, because the record was that account's to write; it is not any more, and a wrapper that account could usefully run is one that could write the record." >&2
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
# `runuser` needs root; where this is already running AS the application account there is no
# switch to make. The branch is about the switch and never about the gate above, which is what
# decides whether this wrapper may run at all.
run_helper() {
  if [[ "$(id -un)" == "${app_account}" ]]; then env "$@"; else runuser -u "${app_account}" -- env "$@"; fi
}
# THE SHARED CUTOVER LOCK, TAKEN FOR THE WHOLE SEQUENCE (o3d-secops r28, Codex HIGH 3).
#
# WHAT WAS WRONG. Each of these three wrappers READS the authority, asks something about it, and
# then WRITES or REMOVES it -- and none of them excluded anything for the duration. A release
# running beside a resolution can restore CONNECT and delete the record between the resolution's
# read and its rename, and the rename then resurrects that record STAMPED, claiming a fence that
# is not standing; the next re-fence reads it as recovery and a later release grants CONNECT back
# to every role it names. deploy.sh, update.sh and install.sh have excluded each other on this
# exact file since r22. The wrappers, which do the same reads and the same writes with no cutover
# around them, were simply outside it.
#
# IT IS THE ENTRYPOINTS' OWN LOCK FILE, baked in at publication, so "another cutover is running"
# and "another wrapper is running" are the same exclusion and not two that pass through each other.
#
# READ-ONLY, AND JUDGED AS A DESCRIPTOR, for the reasons lib/cutover-namespace.sh gives at length:
# flock(2) locks the open file description whatever its access mode, so nothing here needs write
# permission -- and permission to OPEN this file is permission to hold this lock forever, which is
# why the mode is narrowed and then proved off the same descriptor that will be locked. The parent
# is asked about first: a lock taken on a name inside a directory somebody else may write proves
# nothing, because the entry can be renamed out from under it.
#
# fd 9 is the entrypoints' allocation for this same file. These are separate processes, so there is
# no clash; using the same number keeps `fuser -v` and every runbook line about it true here too.
take_cutover_lock() {
  local dir="${cutover_lock%/*}" dir_mode fd_meta fd_kind fd_owner fd_mode fd_inode path_inode
  if [[ -z "${dir}" || ! -d "${dir}" || ! -O "${dir}" ]]; then
    # NO APOSTROPHE IN A ${x:-default}: inside double quotes bash processes the default word, and
    # a lone quote there opens a quoted string that never closes -- the whole wrapper then fails to
    # parse, which the `bash -n` the publisher is held to is what catches.
    echo "REFUSING: the directory holding the cutover lock (${dir:-unset}) is not one this account owns, so a lock taken inside it excludes nobody -- the entry can be renamed between one run's open and another's. ${self} has examined nothing and changed nothing." >&2
    return 1
  fi
  dir_mode="$(LC_ALL=C stat -c '%a' "${dir}" 2>/dev/null || true)"
  if [[ -z "${dir_mode}" ]] || (( (8#${dir_mode} & 0022) != 0 )); then
    echo "REFUSING: ${dir} is writable by group or other (mode ${dir_mode:-unreadable}), so the lock file inside it can be replaced under this run and the exclusion would be one this run does not hold. ${self} has examined nothing and changed nothing." >&2
    return 1
  fi
  if [[ ! -e "${cutover_lock}" && ! -L "${cutover_lock}" ]]; then
    # O_EXCL through the shell's own noclobber, in a subshell so the setting does not survive.
    ( set -C; : > "${cutover_lock}" ) 2>/dev/null || true
  fi
  # Narrowed BEFORE it is opened and proved AFTER, which is the order that matters: `chmod` cannot
  # reach a descriptor another account already holds, so this closes the door to new opens and the
  # proof below is about the inode this run is actually locking.
  chmod 600 "${cutover_lock}" 2>/dev/null || true
  if ! exec 9<"${cutover_lock}"; then
    echo "REFUSING: ${cutover_lock} could not be opened, so this run cannot take the exclusion every cutover on this host takes. ${self} has examined nothing and changed nothing." >&2
    return 1
  fi
  fd_meta="$(LC_ALL=C stat -L -c '%F|%u|%a|%i' /dev/fd/9 2>/dev/null || true)"
  IFS='|' read -r fd_kind fd_owner fd_mode fd_inode <<< "${fd_meta}"
  path_inode="$(LC_ALL=C stat -c '%i' "${cutover_lock}" 2>/dev/null || true)"
  # BOTH SPELLINGS OF "REGULAR FILE": GNU stat says `regular empty file` for a zero-length one, and
  # this lock file is zero-length by construction -- nothing ever writes it. lib/cutover-namespace.sh
  # has accepted both since r22 for exactly this reason; a check that took only one of them would
  # refuse every lock on the first run after it was created.
  if [[ ( "${fd_kind}" != "regular file" && "${fd_kind}" != "regular empty file" ) || "${fd_owner}" != "$(id -u)" || -z "${fd_mode}" || -z "${fd_inode}" || "${fd_inode}" != "${path_inode}" ]] || (( (8#${fd_mode} & 0077) != 0 )); then
    echo "REFUSING: the descriptor this run opened on ${cutover_lock} is not that name's own inode, or is not a regular file owned by this account and unreadable by everyone else (${fd_meta:-unreadable}). Either something followed a link at that name, the name was replaced between the open and the check, or the file is one another account can open and therefore lock indefinitely. ${self} has examined nothing and changed nothing." >&2
    exec 9<&-
    return 1
  fi
  if ! flock -n 9; then
    echo "REFUSING: ${cutover_lock} is held by another run -- a cutover (deploy.sh, update.sh or install.sh) or another of these wrappers. This one reads the fence authority, asks the database about it and then writes or removes it, and two of those sequences interleaved can stamp a record that the other has already released. If nothing is running, \`fuser -v ${cutover_lock}\` names what holds it. ${self} has examined nothing and changed nothing." >&2
    exec 9<&-
    return 1
  fi
  return 0
}
# A CONFIRMATION THAT A SCRIPT CANNOT GIVE (o3d-secops r28, Codex MEDIUM).
#
# WHAT WAS WRONG. The confirmation was a command-line flag. Any root-running process could supply
# it, on the FIRST invocation, without a terminal and without ever having seen the roles it was
# authorising a later GRANT for -- so the "two-step" was a convention and the "human evidentiary
# bar" was a string in argv. A flag in a runbook gets copy-pasted with the command it sits next to.
#
# WHAT IT IS NOW. The answer is read from ${self}'s CONTROLLING TERMINAL, /dev/tty, and never from
# stdin: a heredoc, a pipe and a `< /dev/null` cron job all fail to open it and are refused. And
# the thing that has to be typed is a TOKEN DERIVED FROM THIS DECISION -- the sha256 of the action,
# the exact bytes of the record that was inspected, and the cluster identity that answered the
# audit -- so it cannot exist in a runbook, cannot be reused on a second host, and cannot be typed
# by anybody who has not just been shown the grantee list this run printed. Change any of the
# three and the token changes.
#
# WHAT IT IS NOT, said plainly so nobody mistakes it for more. It is not authentication. A person
# who is already root and who runs this under `expect` or a pty can read the token back. The bar is
# that the decision is taken ONCE, DELIBERATELY, ABOUT THIS RECORD, by somebody looking at it --
# not that root is prevented from doing what root can do. There is deliberately NO non-interactive
# escape hatch: automation that needs to resolve these records is a different interface, and it
# would have to be designed and audited as one rather than borrowing the word "confirmation".
tty_answer() {
  local reply=""
  {
    printf '%s' "$1" >&3
    IFS= read -r reply <&3
  } 3<>/dev/tty 2>/dev/null || return 1
  printf '%s' "${reply}"
}
operator_confirms() {
  local action="$1" token="$2" answer="" want
  want="${action}-${token}"
  answer="$(tty_answer "Type ${want} to proceed, or anything else to abort: ")" || {
    echo "" >&2
    echo "NOT CONFIRMED: this run has no controlling terminal, so there is nobody here to confirm to." >&2
    echo "This step is deliberately interactive and has no flag that replaces it: it authorises a change to the record that decides which roles a later ${sudo_prefix}${release_wrapper} hands CONNECT back to, and that decision is a person's. Re-run it from a terminal." >&2
    echo "Nothing has been changed." >&2
    return 1
  }
  if [[ "${answer}" != "${want}" ]]; then
    echo "" >&2
    echo "NOT CONFIRMED: '${answer}' is not '${want}'. Nothing has been changed and the record is exactly as it was found." >&2
    return 1
  fi
  return 0
}
# The token itself: this action, these exact record bytes, this cluster. `sha256sum` is already
# required by the artefact check at the top of this wrapper, so it is not a new dependency.
decision_token() {
  printf '%s|%s|%s' "$1" "$2" "$3" | sha256sum | cut -c1-12
}
# THE THREE STEPS, BAKED (o3d-secops r23, Codex CRITICAL). The authority this wrapper acts on is
# published by ROOT out of a plan the unprivileged helper prints, validated field by field and
# rebuilt from the validator own template. The validator is the SAME program lib/db-fence-protected.sh
# runs, written in here at publication rather than re-typed, so there is one text and two callers.
raise_the_fence() {
  local plan rc=0 had_authority=0 published_digest=""
  # o3d-secops r28: held across the whole publish/fence/stamp sequence, so a release or a
  # resolution cannot move the record between this run's steps. See take_cutover_lock().
  take_cutover_lock || return 1
  # o3d-secops r24: the same question db_fence_raise() asks, for the same two reasons -- it is what
  # root stamps into fence_mode, and it says whether the authority published below is this run's
  # own and therefore the only one this run may remove.
  if [[ -e "${state_file}" || -L "${state_file}" ]]; then had_authority=1; fi
  plan="$(run_helper DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${helper}" --plan --state-file="${state_file}" --state-owner="$(id -u)" "${identity_argv[@]}")" || return 1
  # o3d-secops r25: the publication's own failures are the sibling r24 missed. The validator's last
  # barrier is the directory fsync, which runs after the rename and leaves the record visible when
  # it fails, so a failed publication is a publication that may well have published.
  if ! published_digest="$(printf '%s\n' "${plan}" | env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
    node -e "${authorise_plan}" -- "${expected_database}" "${expected_app_role}" "${state_file}" "${resolve_wrapper}")"; then
    if [[ "${had_authority}" -eq 0 ]]; then
      rm -f "${state_file}" 2>/dev/null || true
      if [[ -e "${state_file}" ]]; then
        echo "The authority could not be published AND the partial record at ${state_file} could not be removed. It carries no applied stamp, so no later run can treat it as a standing fence, but it is litter at the authoritative path. Remove it by hand." >&2
      fi
    fi
    return 1
  fi
  run_helper DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${helper}" --fence --state-file="${state_file}" --state-owner="$(id -u)" "${identity_argv[@]}" || rc=$?
  # o3d-secops r25: and the record is told the fence went up. Exit 0 is a fence this run watched
  # rise, exit 5 is one that may be standing with a lost acknowledgement; both mean CONNECT may be
  # revoked, and both must therefore be readable as a standing fence by whatever runs next.
  if [[ "${rc}" -eq 0 || "${rc}" -eq 5 ]]; then
    # o3d-secops r28: bound to the bytes the validator just wrote, so the stamp cannot land on a
    # record something else replaced in between. Under the lock above that window is already shut;
    # this is the second answer to the same question and it costs one argument.
    published_digest="$(printf '%s\n' "${published_digest}" | sed -n 's/^authority_sha256=\([0-9a-f]\{64\}\)$/\1/p' | tail -1)"
    if [[ -z "${published_digest}" ]]; then
      echo "The fence is up and the publication did not report the digest of the record it wrote, so this run cannot show that the record it would stamp is the one it just published. NOT STAMPING. Take the fence down with ${sudo_prefix}${release_wrapper} rather than re-running this one: a re-fence over an unstamped record is held to the strict rule and will refuse." >&2
    else
      env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
        node -e "${mark_applied}" -- "${state_file}" "${published_digest}" \
        || echo "The fence is up and ${state_file} could not be stamped as applied. Take it down with the release wrapper rather than re-running this one: a re-fence over an unstamped record is held to the strict rule and will refuse." >&2
    fi
  fi
  # Exit 3 is EXIT_NOT_FENCEABLE, which the helper returns only before BEGIN: nothing was revoked,
  # so an authority this run itself published describes a fence that does not exist, and leaving it
  # would make the next attempt a "recovery" and hand it the tolerance this refusal withheld.
  if [[ "${rc}" -eq 3 && "${had_authority}" -eq 0 ]]; then
    rm -f "${state_file}" 2>/dev/null || true
    if [[ -e "${state_file}" ]]; then
      echo "The fence was REFUSED before anything was revoked and ${state_file} could not be removed. Nothing is fenced, but the next cutover reads that file as a STANDING FENCE. Remove it by hand." >&2
      return 1
    fi
  fi
  return "${rc}"
}
# THE STANDALONE RELEASE, AND WHY IT NO LONGER ENDS THE RECORD BY ITSELF (o3d-secops r30, Codex
# HIGH 1 + MEDIUM).
#
# THIS WRAPPER IS THE CASE THE FINDING IS ABOUT. It is run BY A PERSON, against a record some
# EARLIER run published -- a cutover that died, a fence raised days ago -- so it has none of the
# memory db_fence_raise() has, and the clone it may be pointed at is not a thought experiment: a
# base backup, a restored snapshot or a staging copy reachable through the same name carries the
# fence with it and answers this release exactly as the original does. r29 measured that the two
# are indistinguishable in identifier, OID, timeline, ACL, xmin and ctid, and left the unlink
# hanging off the helper's exit status anyway. So the unlink is gone from here.
#
# THE GRANTS STAY AUTOMATIC AND THE REMOVAL DOES NOT, which is the line that actually matters:
# restoring CONNECT to the roles a record names is idempotent and harmless to repeat -- on the
# real server it is the release, on a copy it is a no-op or a privilege restored on a copy --
# while destroying the record is neither idempotent nor recoverable, and it is the ONLY thing a
# genuine release could later be built from.
#
# AND IT IS RETRYABLE, WHICH IT WAS NOT (Codex MEDIUM). Between the grants landing and the record
# being removed there is an interval no amount of ordering closes, because the two acts are two
# processes. A crash there used to leave a state that read as "no fence stands here" and REFUSED,
# with the resolution wrapper bouncing a STAMPED record straight back to this one -- a loop with
# no way out but an operator deleting the file by hand. The helper now answers that reading with
# exit 6 on a stamped record, and this wrapper treats 6 exactly as it treats 0: the fence is down
# on the server that answered, and what remains is the record. Re-running only ever re-grants and
# re-offers, which is what makes it safe to run twice.
release_the_fence() {
  local released rc=0 identity="" digest=""
  # o3d-secops r28: the release READS the record, GRANTs from it and then offers to remove it.
  # Held across all three, so a re-fence or a resolution cannot move the record between them.
  take_cutover_lock || return 1
  # Its stdout is captured for the machine line below and printed straight back afterwards; the
  # prose an operator reads is on stderr and is never captured, so it still streams live.
  released="$(run_helper DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${helper}" --release --state-file="${state_file}" --state-owner="$(id -u)" "${identity_argv[@]}")" || rc=$?
  [[ -z "${released}" ]] || printf '%s\n' "${released}"
  # 0 is a release this run performed. 6 is EXIT_ALREADY_RELEASED -- a record stamped applied whose
  # every grantee already holds CONNECT, which is what a crash between the grants and this step
  # leaves. Both mean the same thing about the database: there is nothing left to grant here.
  if [[ "${rc}" -ne 0 && "${rc}" -ne 6 ]]; then
    return 1
  fi
  if [[ ! -e "${state_file}" && ! -L "${state_file}" ]]; then
    echo "The fence is released and there is no record at ${state_file} to remove." >&2
    return 0
  fi
  if [[ "${rc}" -eq 6 ]]; then
    echo "" >&2
    echo "The grants this record describes were ALREADY in place, so this run issued none. That is what an earlier release that finished and then died before its record could be removed leaves behind, and completing it is the whole reason this arm exists." >&2
  fi
  digest="$(sha256sum < "${state_file}" 2>/dev/null | cut -d' ' -f1)"
  if [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "The fence was released and ${state_file} could not be hashed, so nothing here can hold a removal to the bytes it read. The record is untouched and the next cutover reads it as a STANDING FENCE. Remove it by hand once you have confirmed CONNECT is back." >&2
    return 1
  fi
  identity="$(printf '%s\n' "${released}" | sed -n 's/^release_cluster_identity=\(.*\)$/\1/p' | tail -1)"
  echo "" >&2
  echo "ABOUT TO REMOVE the connection-fence authority at ${state_file}." >&2
  echo "  record digest:    ${digest}" >&2
  echo "  cluster released: ${identity:-<this server would not say>}" >&2
  echo "THE ONE THING THIS RUN CANNOT SHOW YOU is that the server above is the server this record was written against. A physical copy of a fenced cluster -- a base backup, a restored snapshot, a staging clone reachable at the same name -- inherits the system identifier, the database OID, the timeline and the fenced ACL itself, so it satisfies every check this program can make. Releasing on such a copy succeeds, and removing the record afterwards destroys the only account of the fence still standing on the original." >&2
  echo "Confirm only if you know the host in DEPLOY_ADMIN_DATABASE_URL is the fenced server and not a replica, a proxy or a restored copy of it. This destroys the record; it cannot be undone and nothing else holds the grantee list it names. The GRANTs above are already done either way and are safe to repeat, so declining costs you nothing but this file." >&2
  operator_confirms clear "$(decision_token clear "${digest}" "${identity}")" || {
    echo "The fence is released and ${state_file} is exactly as it was found. Every automatic path goes on reading it as a STANDING FENCE until it is gone, so re-run this wrapper from a terminal when you are ready to end it." >&2
    return 1
  }
  if ! env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
    node -e "${clear_authority}" -- "${state_file}" "${digest}"; then
    echo "The fence was released and ${state_file} could not be removed (the reason is above). The next cutover reads that file as a STANDING FENCE. Remove it by hand." >&2
    return 1
  fi
  echo "RESOLVED: ${state_file} is gone and the fence it described is down." >&2
  return 0
}
# THE ONE-TIME OPERATOR RESOLUTION (o3d-secops r26, Codex HIGH; reworked r28, Codex HIGH 1 + 3
# and MEDIUM). Run BY A PERSON, never by a cutover, and only when an automatic path has refused an
# authority that carries no applied stamp.
#
# FOUR STEPS NOW, AND ALL FOUR UNDER ONE LOCK. This run takes the shared cutover lock before it
# reads anything and holds it until it has acted, so no release, re-fence or second resolution can
# move the record between the reading and the writing (r28, Codex HIGH 3). Root establishes that
# the record really is the ambiguous legacy one AND REPORTS THE DIGEST OF THE EXACT BYTES it read;
# the unprivileged helper asks the live ACL whether the grantees it names still hold CONNECT, and
# reports which cluster answered; root then acts on that answer and on nothing else, holding the
# write to the digest so that even unserialised it cannot land on a record that changed.
#
#   every recorded grantee still holds CONNECT   the REVOKE cannot have run -> the record is what a
#                                                publication killed before BEGIN left -> CLEAR it.
#                                                AUTOMATICALLY ONLY IF THE CLUSTER IS PROVEN --
#                                                see the asymmetry below, which r28 rewrote.
#   not one of them holds CONNECT                EVIDENCE, NOT A CAUSE (o3d-secops r27). The fence
#                                                this record describes produces this reading, and
#                                                so does an administrator who revoked those same
#                                                roles independently; the ACL records the STATE of
#                                                the grants and never what made them that way.
#                                                REPORT it and STOP, unless the operator confirms.
#   anything else                                REFUSE. A half-applied fence and an administrator
#                                                who removed one of these roles by hand read
#                                                identically here, and guessing between them is the
#                                                whole defect r26 removed.
#
# WHAT r28 CHANGED, AND WHY THE CLEAR IS NO LONGER FREE (Codex HIGH 1).
#
# r27 said the two outcomes are not symmetric: stamping later restores privilege and clearing is
# inert, so only stamping needed the operator. That reasoning holds only if the reading is a
# reading of THIS cluster, and r27 also said, in as many words, that nothing here can show that.
# Both were true and the conclusion drawn from them was wrong. A same-named database on another
# server -- DNS, a proxy, a failover that re-pointed a name -- has never been fenced, so every
# recorded grantee holds CONNECT there, the verdict is `absent`, and the automatic arm DELETES the
# sole authority for a fence standing on the real cluster. Clearing is inert about the cluster it
# read; it is not inert about the record, and the record is the only thing the release wrapper can
# restore from. THE ARM JUDGED SAFE WAS THE ARM THAT DELETES.
#
# So the helper now reports a cluster verdict beside the ACL verdict, and this wrapper reads both:
#
#   mismatch   the helper refuses outright and prints no verdict line. Nothing reaches here.
#   proven     the record's fingerprint and the answering cluster's agree. `absent` clears
#              automatically, exactly as r26 and r27 had it -- the evidence is now attributable.
#   unproven   THE ABSENCE OF EVIDENCE, AND EVERY LEGACY RECORD IS THIS BY DEFINITION: a validator
#              that predates the applied stamp predates the fingerprint too, so there is nothing in
#              it to compare. The clear then needs the operator, exactly as the stamp does. Between
#              refusing and deleting, this refuses: a record left alone keeps every automatic path
#              refusing, which is annoying and recoverable, and a record deleted in error cannot be
#              got back.
#
# AND THE CONFIRMATION IS NO LONGER A FLAG (o3d-secops r28, Codex MEDIUM). The two arguments below
# say WHICH decision is being taken; neither authorises it. What authorises it is a token typed at
# ${self}'s controlling terminal, derived from the action, the exact bytes of the record that was
# inspected and the cluster that answered -- so it cannot be written into a runbook, cannot be
# reused on another host or another record, and cannot be given by a process with no terminal. See
# operator_confirms(), which also says plainly what that bar is not.
#
# Run with NO argument the resolution still does its whole read -- the record is inspected, the ACL
# is audited, the grantee lists, the cluster verdict and both possible histories are printed -- and
# then changes nothing. That is the first step of the two on purpose: it is what shows the operator
# the roles and the evidence they are about to decide about.
#
# AND A PARTIAL RESULT FAILS TOWARD REFUSING, at every step and not only at the verdict: an audit
# that cannot connect, cannot read the record, is pointed at another database or another cluster,
# exits with a status this does not enumerate, or prints a verdict line that does not agree with
# that status, changes NOTHING. The record is left exactly as it was found, which keeps every
# automatic path refusing -- the state this procedure exists to leave when it cannot do better.
resolve_legacy_fence() {
  local audited verdict="" cluster="" identity="" rc=0 confirmed_stamp=0 confirmed_clear=0 inspected digest token
  # 0. THE OPERATOR'S OWN ARGUMENTS, AND THE ONLY ONES THIS ACCEPTS. An unrecognised argument is a
  #    REFUSAL rather than something ignored: a mistyped confirmation that is silently dropped
  #    reads to the operator as "it refused for no reason", and a mistyped ANYTHING that is
  #    silently dropped is how a flag comes to mean something nobody typed. Nothing is read from
  #    the database or the filesystem before this returns, and no lock is taken.
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --this-fence-revoked-them) confirmed_stamp=1 ;;
      --no-fence-stands-here) confirmed_clear=1 ;;
      *)
        echo "${self}: unrecognised argument '$1'. This wrapper takes these arguments and no others:" >&2
        echo "" >&2
        echo "  ${sudo_prefix}${self}                             inspect the record, audit the ACL, print what they say, change NOTHING" >&2
        echo "  ${sudo_prefix}${self} --this-fence-revoked-them   the same, and offer to STAMP if the ACL shows every recorded grantee has lost CONNECT" >&2
        echo "  ${sudo_prefix}${self} --no-fence-stands-here      the same, and offer to REMOVE if the ACL shows every recorded grantee still holds CONNECT" >&2
        echo "" >&2
        echo "Neither argument authorises anything by itself: each selects a decision, and the decision is then confirmed at this terminal." >&2
        echo "Nothing has been examined and nothing has been changed." >&2
        return 1 ;;
    esac
    shift
  done
  # 1. THE LOCK, BEFORE THE FIRST READ. Everything below is one read/audit/act sequence and it is
  #    excluded against every cutover and every other wrapper for the whole of it.
  take_cutover_lock || return 1
  # 2. ROOT: is this the ambiguous record at all? It refuses a stamped one, a
  #    published-never-applied one, a truncated one and one nobody published. Its stdout is the
  #    digest of the exact bytes it passed; its stderr is the prose the operator reads.
  inspected="$(env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
    node -e "${legacy_inspect}" -- "${state_file}")" || return 1
  digest="$(printf '%s\n' "${inspected}" | sed -n 's/^authority_sha256=\([0-9a-f]\{64\}\)$/\1/p' | tail -1)"
  if [[ -z "${digest}" ]]; then
    echo "NOT RESOLVED: the inspection passed the record at ${state_file} and did not report the digest of the bytes it read." >&2
    echo "Every write below is held to those exact bytes -- that is what stops a decision taken about one record landing on another -- so without the digest there is nothing to hold it to. Nothing has been changed." >&2
    return 1
  fi
  # 3. UNPRIVILEGED: the live ACL, read through the protected helper as the application account.
  #    Read-only -- it issues no REVOKE, no GRANT and no BEGIN, and writes no file. Its stdout is
  #    the verdict, the cluster verdict and the cluster identity; its stderr is the prose.
  audited="$(run_helper DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${helper}" --audit-authority --state-file="${state_file}" --state-owner="$(id -u)" "${identity_argv[@]}")" || rc=$?
  verdict="$(printf '%s\n' "${audited}" | sed -n 's/^\(legacy_fence_verdict=.*\)$/\1/p' | tail -1)"
  cluster="$(printf '%s\n' "${audited}" | sed -n 's/^legacy_fence_cluster=\(.*\)$/\1/p' | tail -1)"
  identity="$(printf '%s\n' "${audited}" | sed -n 's/^legacy_fence_cluster_identity=\(.*\)$/\1/p' | tail -1)"
  # 4. ROOT: act, and only on a status and a verdict line that agree. Two channels for one fact is
  #    deliberate -- an exit status can be produced by a shell that never ran the helper, and a
  #    line of stdout can be produced by a helper that could not decide.
  if [[ "${rc}" -eq 0 && "${verdict}" == "legacy_fence_verdict=absent" ]]; then
    echo "Every grantee the record names still holds CONNECT on the database that answered, so the REVOKE this record describes cannot have run there." >&2
    if [[ "${cluster}" != "proven" ]]; then
      echo "" >&2
      echo "AND THAT READING CANNOT BE ATTRIBUTED TO THE CLUSTER THIS RECORD WAS WRITTEN AGAINST." >&2
      echo "The host, port, database name and role all match, and two servers can satisfy all four at once." >&2
      # WHICH KIND OF "not proven" (o3d-secops r29, Codex HIGH 1). r28 printed one sentence here
      # and it described the LEGACY record -- "carries no cluster fingerprint" -- for both of the
      # helper's two absences. The other one is a record that DOES name a cluster against a server
      # that would not identify itself, and telling an operator that record carries no fingerprint
      # is telling them something untrue about the evidence they are about to act on.
      case "${cluster}" in
        fingerprint-unverifiable)
          echo "This record DOES name the cluster its fence was raised on. What is missing is the other half of the comparison: the server that answered would not report its own identity, so the fingerprint in the record had nothing to be checked against. THAT IS NOT THE LEGACY CASE, and it is usually one statement away from being settled -- GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO the admin role in DEPLOY_ADMIN_DATABASE_URL, then run this again, and this answer becomes evidence instead of the absence of it." >&2
          ;;
        *)
          echo "This record carries no cluster fingerprint at all to settle it, which is what every record published before this round looks like." >&2
          ;;
      esac
      echo "An unfenced bystander cluster reachable at the same name produces EXACTLY the reading above. Removing the record on it would destroy the only account of what a fence still standing on the real cluster revoked, and ${sudo_prefix}${release_wrapper} would then have no grantee list to restore from." >&2
      if [[ "${confirmed_clear}" -ne 1 ]]; then
        echo "" >&2
        echo "NOT RESOLVED, and deliberately: nothing has been changed and the record is exactly as it was found." >&2
        echo "IF YOU ARE SATISFIED that the database audited above is the one this record was written against -- check the host in DEPLOY_ADMIN_DATABASE_URL, and check it is not a replica, a proxy or a staging server reached through the same name -- say so and re-run:" >&2
        echo "" >&2
        echo "  ${sudo_prefix}${self} --no-fence-stands-here" >&2
        echo "" >&2
        echo "IF YOU ARE NOT SURE, leave it alone. Every automatic path goes on refusing this record, which stops nothing you cannot restart, and the record itself is what a release restores from." >&2
        return 1
      fi
      echo "" >&2
      echo "ABOUT TO REMOVE the connection-fence authority at ${state_file}." >&2
      echo "  record digest:   ${digest}" >&2
      echo "  cluster audited: ${identity:-<this server would not say>}" >&2
      echo "This destroys the record. It cannot be undone and nothing else holds the grantee list it names." >&2
      operator_confirms clear "$(decision_token clear "${digest}" "${identity}")" || return 1
    fi
    echo "Removing it." >&2
    if ! env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
      node -e "${clear_authority}" -- "${state_file}" "${digest}"; then
      echo "The record at ${state_file} describes a fence that was never applied and it could not be removed (the reason is above). Nothing else has changed. Until it is gone every cutover will refuse." >&2
      return 1
    fi
    echo "RESOLVED: ${state_file} is gone. Nothing was fenced and nothing was released; the next cutover plans and publishes an INITIAL authority as it would on any other host." >&2
    return 0
  fi
  if [[ "${rc}" -eq 5 && "${verdict}" == "legacy_fence_verdict=stands" ]]; then
    echo "Not one grantee the record names holds CONNECT. THAT IS THE EVIDENCE, and it is all of it: the list above is what the record names, and none of those roles holds CONNECT on ${expected_database} now." >&2
    echo "It is consistent with TWO HISTORIES -- the fence this record describes revoked those roles, or an administrator revoked them independently of it -- and the ACL cannot tell you which. It records what the grants ARE, never what made them so." >&2
    if [[ "${confirmed_stamp}" -ne 1 ]]; then
      echo "" >&2
      echo "NOT RESOLVED, and deliberately: nothing has been changed and the record is exactly as it was found." >&2
      echo "Stamping it applied is what later lets ${sudo_prefix}${release_wrapper} GRANT CONNECT back to EVERY role listed above, and a recovery re-fence do the same, so it must not follow from a reading that cannot rule out an administrator's own revoke. You know whether you revoked those roles; this does not." >&2
      echo "" >&2
      echo "IF THIS FENCE IS YOURS -- those roles lost CONNECT to the cutover this record describes, and not to anything you or another administrator did -- say so and re-run:" >&2
      echo "" >&2
      echo "  ${sudo_prefix}${self} --this-fence-revoked-them" >&2
      echo "" >&2
      echo "IF ANY OF THOSE ROLES WAS REVOKED DELIBERATELY and must stay revoked, do not stamp. Either leave the record alone -- every automatic path goes on refusing it, which is safe -- or take the fence down with ${sudo_prefix}${release_wrapper}, which restores from this record without needing the stamp AND will grant those roles back too, so re-revoke them by hand afterwards." >&2
      return 1
    fi
    echo "" >&2
    echo "ABOUT TO STAMP the connection-fence authority at ${state_file} as APPLIED." >&2
    echo "  record digest:   ${digest}" >&2
    echo "  cluster audited: ${identity:-<this server would not say>}" >&2
    echo "This licenses a later ${sudo_prefix}${release_wrapper} to GRANT CONNECT back to every role printed above." >&2
    # AND THIS ARM READS THE CLUSTER VERDICT TOO (o3d-secops r29, Codex HIGH 1). r28 consulted it
    # only on the clear arm. Stamping does not destroy the record, and it is never automatic --
    # it takes the explicit argument above AND a token typed at this terminal that already binds
    # the audited identity -- so the verdict does not GATE anything here. It is disclosed, because
    # the operator is being asked to license a GRANT on a server this run could not name.
    if [[ "${cluster}" != "proven" ]]; then
      echo "  NOTE: which cluster that reading came from is NOT PROVEN (${cluster:-<none>}). The roles above come from whatever server answered; confirm below only if you know it is the one this record was written against." >&2
    fi
    operator_confirms stamp "$(decision_token stamp "${digest}" "${identity}")" || return 1
    echo "CONFIRMED BY THE OPERATOR: the fence this record describes is what took CONNECT from those roles. Stamping it applied." >&2
    if ! env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE \
      node -e "${mark_applied}" -- "${state_file}" "${digest}"; then
      echo "The fence is standing and ${state_file} could not be stamped (the reason is above). Nothing has changed: the record still carries no stamp and every cutover still refuses it. Fix the filesystem and re-run this, or take the fence down with ${sudo_prefix}${release_wrapper}, which restores from the record without needing the stamp." >&2
      return 1
    fi
    echo "RESOLVED: ${state_file} is stamped applied. The fence is still standing -- this changed a record and not a database. Take it down with ${sudo_prefix}${release_wrapper}, or re-fence over it, which now uses the recovery rule." >&2
    return 0
  fi
  echo "NOT RESOLVED: the live ACL does not settle what this record means (helper exit ${rc}, verdict '${verdict:-<none>}', cluster '${cluster:-<none>}')." >&2
  echo "Nothing has been changed: the record is exactly as it was found, and every automatic path will go on refusing it." >&2
  if [[ "${confirmed_stamp}" -eq 1 || "${confirmed_clear}" -eq 1 ]]; then
    echo "The argument you supplied is NOT what decided this. Each is consulted on ONE reading -- --this-fence-revoked-them on every recorded grantee having lost CONNECT, --no-fence-stands-here on every one of them still holding it -- and this is neither, so it authorised nothing." >&2
  fi
  echo "A MIXED reading -- some recorded grantees hold CONNECT and some do not -- is not a half-answer this may round off:" >&2
  echo "a fence applied halfway and an administrator who removed one of those roles by hand look identical from here." >&2
  echo "Read the grantee list printed above against the database's ACL yourself and decide. The record's own list is what" >&2
  echo "${sudo_prefix}${release_wrapper} would GRANT CONNECT back to, and it works on this record as it stands, stamp or no stamp." >&2
  return 1
}
WRAPPER_EOF
      # THE OPERATOR'S ARGUMENTS REACH resolve_legacy_fence AND NOTHING ELSE. The other two modes
      # are run by automatic paths with no arguments at all, and a confirmation that could be
      # passed to a re-fence or a release would be a flag with two meanings.
      printf '%s\n' 'if [[ "${mode}" == "fence" ]]; then raise_the_fence; elif [[ "${mode}" == "resolve" ]]; then resolve_legacy_fence "$@"; else release_the_fence; fi'
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
# AND WHAT THE ANSWER IS KEPT IN (o3d-secops r3, Codex HIGH).
#
# Until this round the resolution above finished by publishing its answer into three script-scope
# variables — ${DB_FENCE_PROBE_SCRIPT}, ${DB_FENCE_PROBE_TEMP} and
# ${DB_FENCE_PROBE_ARTEFACT_SHA256} — and each entrypoint then ran
# `node "${DB_FENCE_PROBE_SCRIPT}" --preflight` some sixty lines later. The census that reviewed
# those names classified all three as REPORTS, because it asked its question at the DECLARATION.
# Asked at the SINK the answer is the opposite one: the first is EXECUTED as the application user
# with DEPLOY_ADMIN_DATABASE_URL in its environment, the second is the operand of an `rm -rf`, and
# the third is the equality that decides whether checkout-derived bytes are handed the credential
# at all. Three of the seven names on the "harmless" list steered privileged execution.
#
# And they sat in mutable slots ACROSS THE GATES IN BETWEEN. require_db_identity() and
# require_env_file_is_sole_definition() both run in that window, and both parse ${APP_DIR}/.env —
# a file owned by the account this entire library exists to defend against.
#
# `readonly` is not the fix here: these values differ on every run and are computed, so the word
# cannot be applied to them. THE FIX IS THAT THEY ARE NOT VARIABLES AT ALL. Resolution and
# execution are one function; the path, the throwaway and the digest are `local` to it and are
# consumed inside it; and the entrypoints hand in the only two things they know that this file
# does not — how to print a line, and how to drop privilege. What survives the call is text an
# operator reads and nothing else.
#
# Sets, and every one of them a report — printed, never acted on:
#   DB_FENCE_PROBE_ARTEFACT_SHA256   what a publication FROM THIS CHECKOUT would record
#   DB_FENCE_PROBE_STANDING_SHA256   what the artefact already on this box hashes to
#   DB_FENCE_PROBE_REASON            why there is nothing this run may preflight with, and — after
#                                    db_fence_preflight() — the fact that nothing was executed
# Globals rather than stdout because the caller needs all of them and must not lose any to a
# subshell.
# ---------------------------------------------------------------------------

# The candidate tree, assembled, sealed and hashed, with no part of it executed.
#
# Sets the caller's ${_fence_probe_dir} and ${_fence_probe_sha}. Both callers declare them `local`,
# so the directory that may be executed and the digest that may authenticate it exist only inside
# the frame that consumes them, and there is no script-scope name for any other path to write.
# Not stdout, because _fence_vendor_into() records WHY it failed in ${DB_FENCE_ROTATION_NOTE} and a
# command substitution would take that with the subshell.
_fence_probe_assemble() {
  local dir app_dir digest
  # _fence_vendor_into() answers the provenance question as a side effect of vendoring, and this
  # path has no use for the answer — a candidate is authenticated by its whole-tree digest, not by
  # its source. It is declared here anyway so the assignment two frames down lands in a frame that
  # dies with this call, rather than creating the script-scope name the rest of the file refuses to
  # have. Every caller of _fence_vendor_into() declares it.
  local DB_FENCE_SOURCE_UNTRUSTED_PATH=""
  _fence_probe_dir=""
  _fence_probe_sha=""
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
  digest="$(_fence_tree_digest "${dir}")" || { rm -rf "${dir}"; return 1; }
  _fence_probe_dir="${dir}"
  _fence_probe_sha="${digest}"
  return 0
}

# The artefact already standing on this box. Sets the caller's ${_fence_standing_sha} — a REPORT,
# what the tree hashes to — and returns 0 only when this run may EXECUTE it: the tree is sealed, it
# hashes to what its own record binds, and it hashes to IMS_FENCE_ARTEFACT_SHA256 when the
# invocation supplied one. Otherwise it sets the caller's ${_fence_standing_reason} and returns 1.
#
# The digest and the verdict are separate returns on purpose: an unusable artefact still has a
# digest an operator needs to see, and a digest is not a licence to run the tree it came from.
_fence_standing_artefact() {
  local standing="" recorded=""
  _fence_standing_sha=""
  _fence_standing_reason=""
  [[ -f "${DB_FENCE_SCRIPT_COPY}" ]] || return 1
  _fence_tree_is_sealed "${DB_FENCE_PROTECTED_APP_DIR}" || return 1
  standing="$(_fence_tree_digest "${DB_FENCE_PROTECTED_APP_DIR}")" || standing=""
  _fence_standing_sha="${standing}"
  recorded="$(fence_record_artefact_digest)" || recorded=""
  if [[ -n "${standing}" && "${standing}" == "${recorded}" ]] &&
     { [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] || [[ "${standing}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; }; then
    return 0
  fi
  _fence_standing_reason="the protected fence artefact at ${DB_FENCE_PROTECTED_APP_DIR} is not one this run may execute: it hashes to ${standing:-nothing readable}, its record binds ${recorded:-nothing}${DB_FENCE_EXPECTED_ARTEFACT_SHA256:+, and this invocation pinned ${DB_FENCE_EXPECTED_ARTEFACT_SHA256}}."
  return 1
}

# THE TWO DIGESTS A DRY RUN REPORTS, and nothing else. The candidate is assembled, hashed and
# DESTROYED here: this function hands back no path, because it answers a question about bytes and
# not a question about what may be run. The tree that is executed, if any, is assembled again
# inside db_fence_preflight() and consumed there.
#
# Returns 0 when it established at least one digest — a producer nobody can take a status from is a
# shape this subsystem no longer carries anywhere.
db_fence_probe_digests() {
  local _fence_probe_dir="" _fence_probe_sha="" _fence_standing_sha="" _fence_standing_reason=""
  DB_FENCE_PROBE_ARTEFACT_SHA256=""
  DB_FENCE_PROBE_STANDING_SHA256=""
  if _fence_probe_assemble; then DB_FENCE_PROBE_ARTEFACT_SHA256="${_fence_probe_sha}"; fi
  [[ -z "${_fence_probe_dir}" ]] || rm -rf "${_fence_probe_dir}"
  _fence_standing_artefact || true
  DB_FENCE_PROBE_STANDING_SHA256="${_fence_standing_sha}"
  [[ -n "${DB_FENCE_PROBE_ARTEFACT_SHA256}" || -n "${DB_FENCE_PROBE_STANDING_SHA256}" ]]
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

# RESOLVE AND EXECUTE, IN ONE FUNCTION, WITH THE ANSWER NEVER LEAVING IT.
#
#   db_fence_preflight <notice> -- <runner> [<runner arg>...]
#
# <notice> is a command the CALLER supplies that prints one line. The entrypoints pass their own
# warn(), so the explanation of what is about to be run still arrives in the caller's voice and
# ahead of the helper's own output — which is where it has to be, because it is the line an
# operator reads while the preflight is still opening its connection.
#
# <runner> is the command prefix that drops privilege and carries DEPLOY_ADMIN_DATABASE_URL. The
# two entrypoints spell it differently (`as_app_user env …` and `run_as_user "${APP_USER}" env …`)
# and neither spelling belongs in this file. `--` separates them so neither list has to be guessed.
#
# RETURNS the helper's own exit status when the helper ran, and 1 with ${DB_FENCE_PROBE_REASON} set
# when nothing on this box was authenticated enough to be handed the credential. A non-empty
# ${DB_FENCE_PROBE_REASON} after this call means EXACTLY "nothing was executed" — that is the fact
# the caller's banner asserts, and it is the only thing this function reports through a variable.
db_fence_preflight() {
  local notice="${1:-}" probe="" rc=0
  local _fence_probe_dir="" _fence_probe_sha="" _fence_standing_sha="" _fence_standing_reason=""
  DB_FENCE_PROBE_REASON=""
  [[ -n "${notice}" ]] || return 1
  shift
  [[ "${1:-}" == "--" ]] || return 1
  shift
  [[ "$#" -gt 0 ]] || return 1

  # THE STANDING ARTEFACT FIRST: it is the only thing on the box that has been through the
  # publication gate.
  if _fence_standing_artefact; then
    probe="${DB_FENCE_SCRIPT_COPY}"
    "${notice}" "This dry run probes with the root-owned artefact at ${probe}, which is the"
    "${notice}" "tree this box already publishes and verifies — not with the checkout's copy."
  else
    DB_FENCE_PROBE_REASON="${_fence_standing_reason}"
    # And otherwise ONLY a candidate the invocation itself authenticated. The tree is assembled
    # HERE, immediately before it is run, and the digest that authenticates it is derived in this
    # same frame — not carried in a variable across the entrypoint's ${APP_DIR}/.env parsing.
    if [[ -n "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] && _fence_probe_assemble &&
       [[ "${_fence_probe_sha}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
      probe="${_fence_probe_dir}/scripts/fence-db-connections.mjs"
      # A reason recorded above is about a standing artefact this run declined to use, and this run
      # found something else to preflight with. Callers read a set reason as "nothing ran", so
      # leaving it would put a refusal next to a preflight that happened.
      DB_FENCE_PROBE_REASON=""
      "${notice}" "This dry run probes with a throwaway copy of the tree IMS_FENCE_ARTEFACT_SHA256 named,"
      "${notice}" "which is the only checkout-derived tree it will execute with the admin credential."
    fi
  fi

  if [[ -z "${probe}" ]]; then
    [[ -z "${_fence_probe_dir}" ]] || rm -rf "${_fence_probe_dir}"
    if [[ -z "${DB_FENCE_PROBE_REASON}" ]]; then
      if [[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]]; then
        DB_FENCE_PROBE_REASON="there is no protected fence artefact on this box yet, and this run was given nothing that authenticates the tree the checkout would publish. The preflight opens the admin connection with DEPLOY_ADMIN_DATABASE_URL, and the tree it would run is assembled out of the checkout, so it will not be executed on the strength of the checkout's own account of itself. Supply IMS_FENCE_ARTEFACT_SHA256 and this dry run preflights with the tree that value names; every run after the first publication preflights with the standing artefact instead, and needs nothing supplied."
      else
        DB_FENCE_PROBE_REASON="IMS_FENCE_ARTEFACT_SHA256 expects ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} and the tree this checkout would publish hashes to ${_fence_probe_sha:-nothing that could be assembled}, so there is nothing this run is willing to execute with an administrative credential beside it."
      fi
    fi
    return 1
  fi

  "$@" node "${probe}" --preflight "${DB_FENCE_IDENTITY_ARGS[@]:-}" || rc=$?
  [[ -z "${_fence_probe_dir}" ]] || rm -rf "${_fence_probe_dir}"
  return "${rc}"
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
# WHAT IT NEEDS: ${DB_FENCE_SCRIPT} and `node`. That is the entire list. And ${DB_FENCE_SCRIPT} is
# THE CALLER'S to set, here as everywhere else in this file — where the checkout's helper lives is
# the one thing this library must never work out for itself, and a digest-report mode that derived
# its own path would be a second answer to that question. The entrypoint points it at
# dirname(dirname(<its own path>))/scripts/fence-db-connections.mjs, so the tree under question is
# the one the command was typed out of and never ${APP_DIR}.
#
# WHAT IT DOES NOT NEED, and must be able to prove it does not need: ${APP_DIR}, ${APP_DIR}/.env,
# a service unit, a port, DEPLOY_ADMIN_DATABASE_URL, a database, a standing artefact, or root.
#
# WHAT IT DOES NOT DO: it does not read ${DB_FENCE_PROTECTED_APP_DIR} or the recovery record — a
# build host has neither, and reporting on the box's standing artefact from a command about a
# RELEASE would answer a question nobody asked. It publishes nothing, opens no connection, and
# executes no part of the tree it hashes: the digest is computed by READING bytes into a
# throwaway directory this call creates and removes. The throwaway is removed before it
# returns, so a caller that goes on to do anything else is unaffected by having asked.
db_fence_report_candidate_digest() {
  local rc=0 _fence_probe_dir="" _fence_probe_sha=""
  DB_FENCE_PROBE_ARTEFACT_SHA256=""
  # db_fence_probe_report() prints the standing artefact's digest only when
  # DB_FENCE_PROBE_STANDING_SHA256 is set, and nothing here sets it: the candidate is the whole
  # answer, and the box's own artefact is not this command's business.
  DB_FENCE_PROBE_STANDING_SHA256=""
  _fence_probe_assemble || rc=1
  DB_FENCE_PROBE_ARTEFACT_SHA256="${_fence_probe_sha}"
  # THE THROWAWAY IS REMOVED HERE AND NOT BY A LATER CALL. The path to it is a `local` of this
  # function: nothing outside this frame can name it, so nothing outside this frame can be relied
  # on to clean it up, and nothing outside this frame can re-aim the `rm`.
  [[ -z "${_fence_probe_dir}" ]] || rm -rf "${_fence_probe_dir}"
  # CALLED, NOT PROCESS-SUBSTITUTED (o3d-p9dq, Codex r33). The loop this replaces re-emitted the
  # report line by line through a producer whose exit reached nobody; calling it writes the same
  # bytes to the same stdout with no second process to fail, and its status is this shell's.
  db_fence_probe_report || rc=1
  return "${rc}"
}
