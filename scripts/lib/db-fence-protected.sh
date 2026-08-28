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
#                                              directory and published there. This is trust on
#                                              first use and it is named as such: there is no
#                                              earlier artefact to compare against, so the
#                                              alternative is a mechanism that cannot start.
#                                              IMS_FENCE_SCRIPT_SHA256 and
#                                              IMS_FENCE_ARTEFACT_SHA256 are still enforced here
#                                              when supplied.
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
# was already dead in the protected copy: `appDirectory()` derives the app dir from the running
# file's own location, which under the mirror is ${DB_FENCE_PROTECTED_APP_DIR}, and there is no
# `.env` there. So it authenticated nothing and supplied nothing, while adding a whole package to
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
#   * BOOTSTRAP. The first publication takes the entry file and the packages from the checkout,
#     because there is nothing else on the box to take them from. IMS_FENCE_SCRIPT_SHA256 and
#     IMS_FENCE_ARTEFACT_SHA256 are how an operator refuses to trust that.
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

# Set by db_fence_probe_script(): the file a --preflight probe may run, and the throwaway
# directory (if any) that has to be removed afterwards.
DB_FENCE_PROBE_SCRIPT=""
DB_FENCE_PROBE_TEMP=""

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
# The program is written into the ROOT-OWNED recovery directory and run from there, never from the
# checkout: it is authored by this file, which root read in the same instant as the entrypoint.
#
# THE ANSWER GOES TO A FILE, NOT TO STDOUT. Every caller would otherwise read it through a
# command substitution, and DB_FENCE_ROTATION_NOTE set inside one dies with the subshell — which
# is how the first version of this reported "could not be vendored" and swallowed the reason.
_fence_vendor_closure() {
  local app_dir="$1" out_file="$2" program rc=0 out
  shift 2
  program="${DB_FENCE_RECOVERY_DIR}/.fence-closure.cjs"
  _fence_protected_dir_ready || return 1
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
  local app_dir="$1" staged="$2" list relative count rc=0
  list="${DB_FENCE_RECOVERY_DIR}/.fence-closure.list"
  rm -f "${list}"
  _fence_vendor_closure "${app_dir}" "${list}" "${DB_FENCE_VENDOR_ROOTS[@]}" || { rm -f "${list}"; return 1; }
  if [[ ! -s "${list}" ]]; then
    rm -f "${list}"
    DB_FENCE_ROTATION_NOTE="the fence helper's dependency closure resolved to nothing at all from ${app_dir}, which cannot be right while it still imports ${DB_FENCE_VENDOR_ROOTS[*]}"
    return 1
  fi
  while IFS= read -r relative; do
    [[ -n "${relative}" ]] || continue
    [[ -e "${staged}/${relative}" ]] && continue
    mkdir -p "${staged}/$(dirname "${relative}")" || { rc=1; break; }
    cp -R --no-dereference -- "${app_dir}/${relative}" "${staged}/${relative}" || { rc=1; break; }
  done < "${list}"
  rm -f "${list}"
  [[ "${rc}" -eq 0 ]] || return 1

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
    # substitute FOR; an expected digest, if the operator supplied one, still has to match.
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
        DB_FENCE_ROTATION_NOTE="${DB_FENCE_SCRIPT} (${candidate}) differs from the protected copy at ${DB_FENCE_SCRIPT_COPY} (${existing}) and was NOT promoted: the checkout is application-owned and cannot authenticate itself. To adopt it deliberately, re-run with IMS_FENCE_SCRIPT_SHA256=<digest of the release's scripts/fence-db-connections.mjs>, taken from the release and not from this box; or remove ${DB_FENCE_PROTECTED_APP_DIR} as root and re-run."
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
    echo "There is no complete artefact record at ${DB_FENCE_ARTEFACT_FILE}, so nothing says what ${DB_FENCE_PROTECTED_APP_DIR} is supposed to hash to and the tree cannot be authenticated. Remove ${DB_FENCE_PROTECTED_APP_DIR} as root and re-run to republish it, or supply IMS_FENCE_ARTEFACT_SHA256." >&2
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
# So nothing prints a command line any more. Root writes two WRAPPERS, and the banners print
# their paths:
#
#   ${DB_FENCE_RELEASE_WRAPPER}   release the standing fence
#   ${DB_FENCE_REFENCE_WRAPPER}   raise it again
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
      printf 'APP_DIR_ENV=%q\n' "${env_file}"
      printf 'APP_USER=%q\n' "${app_user}"
      printf 'PROTECTED_DIR=%q\n' "${DB_FENCE_PROTECTED_APP_DIR}"
      printf 'HELPER=%q\n' "${DB_FENCE_SCRIPT_COPY}"
      printf 'STATE_FILE=%q\n' "${state_file}"
      printf 'EXPECTED_ARTEFACT=%q\n' "${artefact_digest}"
      printf 'MODE=%q\n' "${mode}"
      cat <<'WRAPPER_EOF'
if [[ $EUID -ne 0 ]]; then
  echo "Run this as root: it runs the protected fence helper as ${APP_USER}." >&2
  exit 1
fi
# The tree this is about to execute must still be the tree this wrapper was written for.
actual="$(cd "${PROTECTED_DIR}" 2>/dev/null && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum)"
actual="${actual%% *}"
if [[ "${actual}" != "${EXPECTED_ARTEFACT}" ]]; then
  echo "REFUSING: ${PROTECTED_DIR} hashes to ${actual:-nothing} but this wrapper was written for ${EXPECTED_ARTEFACT}." >&2
  echo "The protected fence artefact has changed since the fence was raised. Do not run it." >&2
  exit 1
fi
if [[ -z "${DEPLOY_ADMIN_DATABASE_URL:-}" ]] && [[ -f "${APP_DIR_ENV}" ]]; then
  # The same one-key reader the entrypoints use: a quoted value ends at its closing quote, an
  # unquoted one at the first whitespace-preceded '#', and later definitions win. `source` is not
  # used, because that executes whatever is in the file.
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?DEPLOY_ADMIN_DATABASE_URL[[:space:]]*=' "${APP_DIR_ENV}" 2>/dev/null | tail -1 || true)"
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
  echo "DEPLOY_ADMIN_DATABASE_URL is not set and ${APP_DIR_ENV} does not define it, so there is no" >&2
  echo "privileged connection to ${MODE} with. Re-run supplying it:" >&2
  echo "" >&2
  echo "  DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' $0" >&2
  echo "" >&2
  echo "It must be a superuser or database-owner connection as a DIFFERENT role from the one the" >&2
  echo "fence revoked CONNECT from; see docs/installation.md." >&2
  exit 1
fi
run() {
  if [[ "$(id -un)" == "${APP_USER}" ]]; then env "$@"; else runuser -u "${APP_USER}" -- env "$@"; fi
}
WRAPPER_EOF
      printf 'run DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "${HELPER}" --%s --state-file="${STATE_FILE}"%s\n' \
        "${mode}" "${identity}"
    } | _fence_publish_file "${target}" 700 || return 1
    chown root:root "${target}" 2>/dev/null || true
  done
  return 0
}

# ---------------------------------------------------------------------------
# THE DRY-RUN PROBE
#
# --dry-run writes nothing under /etc, least of all a published artefact, so it may not bootstrap
# one. It also may not run the checkout's helper in place: --preflight opens the admin connection
# with DEPLOY_ADMIN_DATABASE_URL, and "it only reads" is a property of the SHIPPED script, not of
# whatever file is at that path — nor of whatever `pg` it would import. So when there is a
# protected artefact it is used, and when there is not, the checkout's bytes AND their resolved
# dependency closure are snapshotted into a THROWAWAY ROOT-OWNED TREE laid out the same way and
# run from there. Root-owned means the application account cannot alter it between this function
# and the exec; throwaway means the dry run leaves nothing behind.
#
# Sets DB_FENCE_PROBE_SCRIPT (the file to run) and DB_FENCE_PROBE_TEMP (a directory to remove, or
# empty). Globals rather than stdout because the caller needs both and must not lose the second
# one to a subshell.
# ---------------------------------------------------------------------------
db_fence_probe_script() {
  local dir app_dir
  DB_FENCE_PROBE_SCRIPT=""
  DB_FENCE_PROBE_TEMP=""

  if [[ -f "${DB_FENCE_SCRIPT_COPY}" ]] && _fence_tree_is_sealed "${DB_FENCE_PROTECTED_APP_DIR}"; then
    DB_FENCE_PROBE_SCRIPT="${DB_FENCE_SCRIPT_COPY}"
    return 0
  fi

  [[ -f "${DB_FENCE_SCRIPT}" ]] || return 1
  app_dir="$(dirname "$(dirname "${DB_FENCE_SCRIPT}")")"
  dir="$(mktemp -d 2>/dev/null)" || return 1
  mkdir -p "${dir}/scripts" || { rm -rf "${dir}"; return 1; }
  cat < "${DB_FENCE_SCRIPT}" > "${dir}/scripts/fence-db-connections.mjs" || { rm -rf "${dir}"; return 1; }
  _fence_vendor_into "${app_dir}" "${dir}" || { rm -rf "${dir}"; return 1; }
  # Readable and traversable by the application user, which is what executes it; writable by
  # nobody else, which is what makes the snapshot mean anything.
  chmod -R u=rwX,go=rX "${dir}" || { rm -rf "${dir}"; return 1; }
  _fence_tree_is_sealed "${dir}" || { rm -rf "${dir}"; return 1; }
  DB_FENCE_PROBE_SCRIPT="${dir}/scripts/fence-db-connections.mjs"
  DB_FENCE_PROBE_TEMP="${dir}"
  return 0
}

db_fence_probe_cleanup() {
  if [[ -n "${DB_FENCE_PROBE_TEMP}" ]]; then rm -rf "${DB_FENCE_PROBE_TEMP}"; fi
  DB_FENCE_PROBE_TEMP=""
  DB_FENCE_PROBE_SCRIPT=""
  return 0
}
