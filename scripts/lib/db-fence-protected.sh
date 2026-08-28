# shellcheck shell=bash
# =============================================================================
# THE PROTECTED FENCE HELPER — one mechanism, three entrypoints
# =============================================================================
# o3d-2sm1.5 r31, Codex CRITICAL x2. Sourced by scripts/install.sh, scripts/update.sh and
# scripts/deploy.sh, and it is the ONLY thing in this repository that decides which bytes the
# connection fence is executed from. Every mode goes through it: --preflight, --fence,
# --print-migration-url, --release, and the exit trap's re-fence.
#
# WHY IT IS A LIBRARY AND NOT A THIRD COPY. Two rounds running, one rule with several readers has
# been the shape of the finding: r29 published two root-owned artefacts and then made each of them
# the FALLBACK (deletion closed, substitution open); r30 inverted the precedence in update.sh and
# left deploy.sh and install.sh reading the old rule. A rule about which file may hold a
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
# NEITHER CLOSED SUBSTITUTION AT WRITE, which is this round. Publication still took whatever was
#     in the checkout and promoted it into the protected path on every fence — so the account
#     being defended against supplied the trusted artefact, and the digest recorded beside it
#     proved only that the substitution was self-consistent.
#
# ---------------------------------------------------------------------------
# THE RULE
# ---------------------------------------------------------------------------
#   AN EXISTING PROTECTED COPY IS NEVER OVERWRITTEN FROM THE CHECKOUT.
#
# Three states, and nothing else:
#
#   NO PROTECTED COPY YET (bootstrap)          the checkout's file is staged into the root-owned
#                                              directory and published there. This is trust on
#                                              first use and it is named as such: there is no
#                                              earlier artefact to compare against and no
#                                              operator digest, so the alternative is a mechanism
#                                              that cannot start. An expected digest supplied on
#                                              the invocation is still enforced here when given.
#
#   PROTECTED COPY EXISTS, NO EXPECTED DIGEST  the protected copy is used, unchanged. If the
#                                              checkout's file differs, that is REPORTED
#                                              (DB_FENCE_ROTATION_NOTE) and NOT promoted.
#
#   PROTECTED COPY EXISTS, EXPECTED DIGEST     an authenticated rotation. See below.
#
# WHY DIVERGENCE WARNS RATHER THAN REFUSES. Refusing would hand the application account a
# denial of service on every future cutover — write one byte into the checkout's helper and no
# deploy runs again — which trades a credential-theft path for an availability path the same
# account controls. The protected copy is root-owned and was itself once shipped by this
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
#   IMS_FENCE_SCRIPT_SHA256=<64 hex> sudo -E scripts/update.sh
#
# and the operator gets it from the release they are deploying, not from the deployed tree —
# `git show <tag>:scripts/fence-db-connections.mjs | sha256sum` on a machine that is not this one,
# or the checksum published with the release. Supplied, it is enforced on EVERY path, bootstrap
# included, so `IMS_FENCE_SCRIPT_SHA256=` is also how an operator pins a first install.
#
# THE SECOND ROTATION PATH IS ROOT ITSELF: remove ${DB_FENCE_SCRIPT_COPY}. Only root can, the
# directory says so, and the next run bootstraps. It is the escape hatch for a box whose expected
# digest has been lost, and it is deliberately an act at the console rather than a flag.
#
# STAGING IS INSIDE THE PROTECTED DIRECTORY, AND THE VERIFIED INODE IS THE PUBLISHED INODE. The
# bytes are copied to a staging name that only root can write, the digest is taken FROM THAT FILE,
# and that same file is renamed into place. There is no window in which the checkout can change
# between the check and the publication, because after the copy the checkout is not read again.
#
# ROTATION IS REFUSED WHILE A FENCE MAY BE STANDING. ${DB_FENCE_STATE} existing means a fence was
# raised and not yet released; the helper that RELEASES it restores grants from a record the
# helper that RAISED it wrote, and swapping versions across that pair is how a release stops
# meaning what the fence meant. Release first, then rotate.
#
# ---------------------------------------------------------------------------
# WHERE THE PROTECTED COPY LIVES, AND WHY IT IS NOT A BARE FILE UNDER /etc
# ---------------------------------------------------------------------------
# fence-db-connections.mjs imports `pg` and `dotenv`, and derives the application directory from
# ITS OWN LOCATION (appDirectory() = dirname(dirname(__file__))). Node resolves bare specifiers by
# walking up from the importing module's directory, NOT from the working directory, and NODE_PATH
# does not apply to ESM at all — so a copy published at /etc/ims-cutover-recovery/…mjs resolves
# node_modules from /etc and /, finds neither, and dies with ERR_MODULE_NOT_FOUND before it can
# fence anything. r30 published exactly that, and every caller stubs the process boundary, so no
# test saw it.
#
# So the protected copy is published into a root-owned MIRROR OF THE SHIPPED LAYOUT:
#
#   /etc/ims-cutover-recovery/app/scripts/fence-db-connections.mjs   the only file executed
#   /etc/ims-cutover-recovery/app/node_modules -> <app dir>/node_modules
#
# which makes appDirectory() name a root-owned directory (so `.env` is not read from `/`, and a
# stray /etc/.env is not read either) and makes the module walk find the application's installed
# dependencies at the first hop.
#
# THE DEPENDENCIES REMAIN APPLICATION-OWNED, and that is stated rather than hidden. This mechanism
# fixes WHICH BYTES OF THE HELPER RUN; it does not make the helper's node_modules trusted, and it
# never could without vendoring a runtime. Note what bounds that: the helper is executed AS THE
# APPLICATION USER on every path, by design — the fence state file has to be releasable by that
# account — so DEPLOY_ADMIN_DATABASE_URL is reachable from that account through /proc regardless
# of which bytes run. What substitution bought that ownership does not is the ability to LIE:
# to report a raised fence over an open database. That is what is closed here.
#
# 0755, not 0700: the fence runs as the application user and must traverse and read this.
# Literals, not variables: a trust root chosen by a variable is only as trustworthy as whatever
# can set it. A deployment that must move it edits these lines.
# ---------------------------------------------------------------------------

DB_FENCE_RECOVERY_DIR="/etc/ims-cutover-recovery"
DB_FENCE_IDENTITY_FILE="${DB_FENCE_RECOVERY_DIR}/db-fence-identity.env"
DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"
DB_FENCE_SCRIPT_COPY="${DB_FENCE_PROTECTED_APP_DIR}/scripts/fence-db-connections.mjs"
DB_FENCE_SCRIPT_STAGED="${DB_FENCE_PROTECTED_APP_DIR}/scripts/.fence-db-connections.mjs.staged"
DB_FENCE_MODULES_LINK="${DB_FENCE_PROTECTED_APP_DIR}/node_modules"

# The expected digest, from the ROOT INVOCATION and from nowhere else. Never read out of the
# checkout, never out of ${APP_DIR}/.env — both are writable by the account this authenticates
# against, and a digest that source can set authenticates nothing.
DB_FENCE_EXPECTED_SHA256="${IMS_FENCE_SCRIPT_SHA256:-}"

# Why a divergence was not promoted, or why a rotation was refused. Printed by the caller; empty
# when there is nothing to say.
DB_FENCE_ROTATION_NOTE=""

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
  local target="$1" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! chmod 644 "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  if ! _fence_fsync_path "$tmp"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  _fence_fsync_path "$dir" || return 1
  return 0
}

# The digest of a file, or nothing. sha256sum is coreutils and is present wherever this runs; a
# box without it cannot bind the copy to the record, and the callers refuse rather than raise a
# fence they cannot bind.
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

# The root-owned directory the protected copy lives in, created with the modes the fence needs.
_fence_protected_dir_ready() {
  mkdir -p "${DB_FENCE_PROTECTED_APP_DIR}/scripts" || return 1
  chown root:root "${DB_FENCE_RECOVERY_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}/scripts" 2>/dev/null || true
  chmod 755 "${DB_FENCE_RECOVERY_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}" "${DB_FENCE_PROTECTED_APP_DIR}/scripts" || return 1
  return 0
}

# The node_modules hop, pointed at the checkout the helper shipped with. Refreshed on every
# publication rather than created once, because an application directory that moved would
# otherwise leave the protected copy unable to import anything.
#
# THE TARGET IS NOT REQUIRED TO EXIST. A checkout with no installed dependencies is a checkout
# whose fence helper cannot run from ANY path, protected or not — node says so, with the same
# ERR_MODULE_NOT_FOUND either way — so refusing to publish over it would convert one clear failure
# into a different, less clear one, and would make publication depend on a directory the
# application account owns.
_fence_link_modules() {
  local app_modules
  app_modules="$(dirname "$(dirname "${DB_FENCE_SCRIPT}")")/node_modules"
  ln -sfn "${app_modules}" "${DB_FENCE_MODULES_LINK}" 2>/dev/null || return 1
  return 0
}

# Copy the checkout's helper into the protected directory under a staging name, digest THAT FILE,
# require it to match ${DB_FENCE_EXPECTED_SHA256} when one was supplied, and only then rename it
# over the protected copy. The verified inode is the published inode: after the copy the checkout
# is never read again, so there is no interval in which it can change the outcome.
_fence_stage_and_publish() {
  local digest
  [[ -f "${DB_FENCE_SCRIPT}" ]] || {
    DB_FENCE_ROTATION_NOTE="${DB_FENCE_SCRIPT} is not in this checkout, so there is nothing to publish into ${DB_FENCE_SCRIPT_COPY}"
    return 1
  }
  _fence_protected_dir_ready || return 1
  # BEFORE the publication, not after it: a copy that cannot import `pg` is a fence that dies at
  # exec, and a failure discovered after the rename would leave exactly that standing.
  _fence_link_modules || {
    DB_FENCE_ROTATION_NOTE="the protected copy at ${DB_FENCE_SCRIPT_COPY} could not be given the node_modules hop it imports \`pg\` through: ${DB_FENCE_MODULES_LINK} could not be created"
    return 1
  }
  _fence_publish_file "${DB_FENCE_SCRIPT_STAGED}" < "${DB_FENCE_SCRIPT}" || return 1
  digest="$(file_sha256 "${DB_FENCE_SCRIPT_STAGED}")" || { rm -f "${DB_FENCE_SCRIPT_STAGED}"; return 1; }
  if [[ -n "${DB_FENCE_EXPECTED_SHA256}" ]] && [[ "${digest}" != "${DB_FENCE_EXPECTED_SHA256}" ]]; then
    rm -f "${DB_FENCE_SCRIPT_STAGED}"
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_SCRIPT_SHA256 expects ${DB_FENCE_EXPECTED_SHA256} but ${DB_FENCE_SCRIPT} hashes to ${digest}, so it was NOT published to ${DB_FENCE_SCRIPT_COPY}"
    return 1
  fi
  mv -f "${DB_FENCE_SCRIPT_STAGED}" "${DB_FENCE_SCRIPT_COPY}" 2>/dev/null || { rm -f "${DB_FENCE_SCRIPT_STAGED}"; return 1; }
  chown root:root "${DB_FENCE_SCRIPT_COPY}" 2>/dev/null || true
  chmod 644 "${DB_FENCE_SCRIPT_COPY}" || return 1
  _fence_fsync_path "$(dirname "${DB_FENCE_SCRIPT_COPY}")" || return 1
  return 0
}

# THE ONLY WRITER of ${DB_FENCE_SCRIPT_COPY}, and it refuses to overwrite one from the checkout.
#
# Returns 0 when a protected copy is standing afterwards — whether this call published it, rotated
# it, or left the existing one alone — and 1 when there is none and none could be made.
publish_fence_script_copy() {
  local existing="" candidate=""
  DB_FENCE_ROTATION_NOTE=""

  if [[ -n "${DB_FENCE_EXPECTED_SHA256}" ]] && ! fence_valid_sha256 "${DB_FENCE_EXPECTED_SHA256}"; then
    DB_FENCE_ROTATION_NOTE="IMS_FENCE_SCRIPT_SHA256='${DB_FENCE_EXPECTED_SHA256}' is not a sha256 digest (64 lowercase hex characters). Refusing to treat it as one."
    return 1
  fi

  if [[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    # BOOTSTRAP. Nothing this mechanism ever published is standing, so there is nothing here to
    # substitute FOR; an expected digest, if the operator supplied one, still has to match.
    _fence_stage_and_publish || return 1
    return 0
  fi

  existing="$(file_sha256 "${DB_FENCE_SCRIPT_COPY}")" || existing=""
  _fence_link_modules || true

  if [[ -z "${DB_FENCE_EXPECTED_SHA256}" ]]; then
    # THE CHECKOUT DOES NOT GET TO PROMOTE ITSELF. Say so when the two differ, and say what a
    # legitimate rotation would be, then use the copy that is already there.
    if [[ -f "${DB_FENCE_SCRIPT}" ]]; then
      candidate="$(file_sha256 "${DB_FENCE_SCRIPT}")" || candidate=""
      if [[ -n "${candidate}" && -n "${existing}" && "${candidate}" != "${existing}" ]]; then
        DB_FENCE_ROTATION_NOTE="${DB_FENCE_SCRIPT} (${candidate}) differs from the protected copy at ${DB_FENCE_SCRIPT_COPY} (${existing}) and was NOT promoted: the checkout is application-owned and cannot authenticate itself. To adopt it deliberately, re-run with IMS_FENCE_SCRIPT_SHA256=<digest of the release's scripts/fence-db-connections.mjs>, taken from the release and not from this box; or remove ${DB_FENCE_SCRIPT_COPY} as root and re-run."
      fi
    fi
    return 0
  fi

  if [[ "${existing}" == "${DB_FENCE_EXPECTED_SHA256}" ]]; then
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
  _fence_rewrite_record_digest "${DB_FENCE_EXPECTED_SHA256}" || return 1
  DB_FENCE_ROTATION_NOTE="the protected fence helper at ${DB_FENCE_SCRIPT_COPY} was rotated to ${DB_FENCE_EXPECTED_SHA256}, which is the digest supplied on this invocation."
  return 0
}

# Replace ONLY the fence_script_sha256 line of a complete recovery record, keeping every other
# line and the terminating sentinel exactly where they were. A record with no such line, or no
# record at all, is left alone: there is then nothing bound to the old file.
_fence_rewrite_record_digest() {
  local digest="$1" rewritten
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

# WHICH COPY OF THE FENCE HELPER THIS RUN MAY EXECUTE. It is always the root-owned one.
#
# ${DB_FENCE_SCRIPT} IS NEVER EXECUTED FROM ITS OWN PATH. Every caller hands the result
# DEPLOY_ADMIN_DATABASE_URL and runs it — preflight, fence, migration-URL composition, release and
# the exit trap's re-fence, in all three entrypoints.
#
# Prints the path it chose; on failure prints the reason on stderr and returns non-zero. The
# reason goes to stderr because every caller reads this through a command substitution, and a
# global set inside one dies with the subshell.
db_fence_script_in_use() {
  local recorded actual

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
    echo "The protected fence helper at ${DB_FENCE_SCRIPT_COPY} could not be established: ${DB_FENCE_ROTATION_NOTE:-no reason was recorded}." >&2
    return 1
  fi
  if [[ -n "${DB_FENCE_ROTATION_NOTE}" ]]; then echo "${DB_FENCE_ROTATION_NOTE}" >&2; fi

  # Re-read: an authenticated rotation moves the record's digest with the file it names.
  recorded="$(fence_record_script_digest)" || recorded=""

  if [[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    echo "Neither a root-owned fence script at ${DB_FENCE_SCRIPT_COPY} nor ${DB_FENCE_SCRIPT} could be used." >&2
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
# THE DRY-RUN PROBE
#
# --dry-run writes nothing, least of all under /etc, so it may not bootstrap the protected copy.
# It also may not run the checkout's helper in place: --preflight opens the admin connection with
# DEPLOY_ADMIN_DATABASE_URL, and "it only reads" is a property of the SHIPPED script, not of
# whatever file is at that path. So when there is a protected copy it is used, and when there is
# not, the checkout's bytes are snapshotted into a THROWAWAY ROOT-OWNED DIRECTORY laid out the
# same way and run from there. Root-owned means the application account cannot alter it between
# this function and the exec; throwaway means the dry run leaves nothing behind.
#
# Sets DB_FENCE_PROBE_SCRIPT (the file to run) and DB_FENCE_PROBE_TEMP (a directory to remove, or
# empty). Globals rather than stdout because the caller needs both and must not lose the second
# one to a subshell.
# ---------------------------------------------------------------------------
db_fence_probe_script() {
  local dir app_modules
  DB_FENCE_PROBE_SCRIPT=""
  DB_FENCE_PROBE_TEMP=""

  if [[ -f "${DB_FENCE_SCRIPT_COPY}" ]]; then
    _fence_link_modules || true
    DB_FENCE_PROBE_SCRIPT="${DB_FENCE_SCRIPT_COPY}"
    return 0
  fi

  [[ -f "${DB_FENCE_SCRIPT}" ]] || return 1
  dir="$(mktemp -d 2>/dev/null)" || return 1
  mkdir -p "${dir}/scripts" || { rm -rf "${dir}"; return 1; }
  # Readable and traversable by the application user, which is what executes it; writable by
  # nobody else, which is what makes the snapshot mean anything.
  chmod 755 "${dir}" "${dir}/scripts" || { rm -rf "${dir}"; return 1; }
  cat < "${DB_FENCE_SCRIPT}" > "${dir}/scripts/fence-db-connections.mjs" || { rm -rf "${dir}"; return 1; }
  chmod 644 "${dir}/scripts/fence-db-connections.mjs" || { rm -rf "${dir}"; return 1; }
  app_modules="$(dirname "$(dirname "${DB_FENCE_SCRIPT}")")/node_modules"
  ln -sfn "${app_modules}" "${dir}/node_modules" 2>/dev/null || true
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
