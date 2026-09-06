#!/usr/bin/env node
/**
 * chown-tree.mjs — a recursive ownership change that is aimed at INODES, never at pathnames.
 *
 * WHY THIS EXISTS (o3d-n8xx, Codex CRITICAL).
 *
 * scripts/install.sh hands ${DATA_DIR} to the service account on every run, and it must PRUNE two
 * subtrees out of that walk: ${DATA_DIR}/locks — the root-owned crontab reconciliation lock — and
 * every `.ims-publish` staging directory, at any depth. `chown -R` cannot express a prune, so the
 * line was:
 *
 *     find "${DATA_DIR}" \( -path "${CRONTAB_LOCK_DIR}" -o -name .ims-publish \) -prune \
 *       -o -exec chown -h "${APP_USER}:${APP_USER}" {} +
 *
 * `find -exec` ENUMERATES PATHNAMES and hands them to a `chown` that resolves them AGAIN, later.
 * `-h` protects only the FINAL component. On an upgrade the service account owns this tree — the
 * previous run gave it to them — and section 8 runs BEFORE the service is stopped, so that account
 * is live while this walk is happening. A descendant directory renamed aside and replaced by a
 * symlink between the enumeration and the execution therefore redirects a ROOT-SIDE ownership
 * change through it: `find` prints `${DATA_DIR}/d/f`, `d` becomes a symlink to /etc, and
 * `chown -h ${DATA_DIR}/d/f` changes the ownership of /etc/f. GNU find's own documentation calls
 * `-exec` insecure for exactly this. The same finding was fixed for ${LOG_DIR} in o3d-secops r7 by
 * moving to `chown -Rh .` inside a root entered by descriptor; ${DATA_DIR} could not follow it
 * because of the two prunes.
 *
 * WHAT THIS DOES INSTEAD. It descends by DESCRIPTOR. Every directory is opened
 * `O_DIRECTORY|O_NOFOLLOW` relative to the descriptor of its parent, and every ownership change is
 * made either of a descriptor this process holds (`fchown`) or of a single name resolved from one
 * (`fchownat(..., AT_SYMLINK_NOFOLLOW)`). There is no pathname left for anybody to re-resolve, so
 * a rename ANYWHERE in the tree — before, during or after — can no longer aim this at a directory
 * outside it. The worst it can achieve is that a file the attacker moved INTO the tree gets
 * chowned, and that is a file in a tree they already own.
 *
 * WHY NODE, AND WHY /proc. Node has no `dir_fd` parameter on any `fs` call, but `/proc/self/fd/N`
 * is resolved BY THE KERNEL to the open file rather than to a pathname, so `/proc/self/fd/N/child`
 * IS `openat(N, "child", …)` and `lchown("/proc/self/fd/N/child")` IS
 * `fchownat(N, "child", …, AT_SYMLINK_NOFOLLOW)`. That is the same primitive install.sh already
 * enters a root with (`cd "/proc/self/fd/${fd}"`), and it costs no new dependency: node is
 * installed by section 4, which runs before section 8, and the installer already ships and runs
 * scripts/lib/pg-auth-request.mjs. A python3 helper would express the same thing with real
 * `dir_fd=` arguments and no /proc, but python3 is NOT a declared dependency of this installer —
 * it arrives only as a transitive dependency of `unattended-upgrades` and `apt-listchanges` — and
 * resting a security primitive on that is a dependency in all but name. /proc is mandatory for
 * this script as of the same change that added this file.
 *
 * PRUNING. The lock directory is pruned BY VERIFIED IDENTITY: it is opened once from the root's
 * own descriptor, its `dev:ino` is recorded, and any directory the walk opens whose `dev:ino`
 * matches is skipped wherever it is met — so a rename of the lock directory during the walk cannot
 * get it chowned by presenting it under another name. The staging directories cannot be enumerated
 * up front (there is one wherever a publication has happened, at any depth), so they are pruned by
 * NAME, resolved once against the pinned parent descriptor. That is sound: what must not be handed
 * to the service account is the directory the publisher will USE, which is by definition the one
 * at the name `.ims-publish` when the publisher looks; a directory renamed away from that name is
 * no longer a staging directory but debris, and publish_durable_file() re-establishes root
 * ownership, the 0700 mode and the `..` identity of whatever it does find there on every run.
 *
 * FAILURE IS FATAL. Every error other than "the entry is gone" or "it is not a directory any more"
 * ends the process non-zero; the caller dies. A partial ownership change that reported success is
 * how a service ends up unable to read its own state directory.
 *
 * USAGE: node chown-tree.mjs <root> <uid> <gid> <prune-name-at-root> <prune-name-at-any-depth>
 *        Either prune name may be the empty string, which prunes nothing.
 */
import { closeSync, fchownSync, fstatSync, lchownSync, lstatSync, openSync, readdirSync, statSync } from 'node:fs'
import { constants } from 'node:fs'

/** Deeper than any state directory this application creates, and shallow enough that the recursion
 *  below cannot exhaust either the descriptor limit or the JS stack. A tree deeper than this is
 *  refused rather than half-owned: it is either a bug or a loop somebody built. */
const MAX_DEPTH = 512

const die = (message) => {
  process.stderr.write(`chown-tree: ${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
if (argv.length !== 5) {
  die('usage: chown-tree.mjs <root> <uid> <gid> <prune-name-at-root> <prune-name-at-any-depth>')
}
const [root, uidText, gidText, pruneAtRoot, pruneAnywhere] = argv

const asId = (text, what) => {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    die(`the ${what} to change ownership to must be a numeric id, and this run was given ${JSON.stringify(text)}. A name resolved to nothing is not an id.`)
  }
  return Number(text)
}
const uid = asId(uidText, 'uid')
const gid = asId(gidText, 'gid')

for (const [name, value] of [['prune-name-at-root', pruneAtRoot], ['prune-name-at-any-depth', pruneAnywhere]]) {
  if (value === '.' || value === '..' || value.includes('/')) {
    die(`${name} must be a single path component and this run was given ${JSON.stringify(value)}. A prune this cannot resolve against one directory is a prune that silently protects nothing.`)
  }
}

// /proc IS REQUIRED, AND ITS ABSENCE IS A REFUSAL. Without it there is no way to name an open
// directory from Node, and the by-name walk that would replace this is the defect itself.
try {
  if (!statSync('/proc/self/fd').isDirectory()) throw new Error('not a directory')
} catch (error) {
  die(`/proc/self/fd is not available (${error && error.message}), so this run cannot address a directory by the descriptor it holds on it. It will not fall back to changing ownership by pathname, which is the defect this exists to remove. Mount /proc.`)
}

const OPEN_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (constants.O_NOCTTY ?? 0)
/** The kernel resolves this prefix to the OPEN FILE, so what follows it is resolved from that
 *  directory and from nowhere else. This is the whole mechanism. */
const at = (dirFd, name) => `/proc/self/fd/${dirFd}/${name}`
const identity = (stats) => `${stats.dev}:${stats.ino}`

/** GONE, or NO LONGER A DIRECTORY — the two outcomes a concurrent rename can produce that are not
 *  this program's problem. Anything else is. */
const RACED = new Set(['ENOENT', 'ELOOP', 'ENOTDIR'])

/** Opens one component from a descriptor its parent holds. Returns null if the entry raced away or
 *  stopped being a directory; dies on anything else. */
const openChildDir = (dirFd, name) => {
  try {
    return openSync(at(dirFd, name), OPEN_DIR)
  } catch (error) {
    if (RACED.has(error.code)) return null
    die(`${name} could not be opened as a directory below ${root}: ${error.code ?? error.message}. Nothing further has been changed.`)
  }
  return null
}

/** fchownat(dirFd, name, uid, gid, AT_SYMLINK_NOFOLLOW). A symlink here has its OWN ownership
 *  changed, exactly as `chown -h` promised and unlike `chown`, which would follow it. */
const chownEntry = (dirFd, name) => {
  try {
    lchownSync(at(dirFd, name), uid, gid)
  } catch (error) {
    if (error.code === 'ENOENT') return
    die(`the ownership of ${name} below ${root} could not be changed: ${error.code ?? error.message}. Nothing further has been changed.`)
  }
}

const rootFd = (() => {
  try {
    return openSync(root, OPEN_DIR)
  } catch (error) {
    die(`${root} could not be opened as a directory: ${error.code ?? error.message}. Nothing has been changed.`)
  }
  return -1
})()

// THE PROTECTED SUBTREE, BY IDENTITY RATHER THAN BY NAME. Opened once, from the root's own
// descriptor, and recorded as a device and an inode: a directory the walk meets later that IS this
// one is skipped whatever name it is wearing by then.
const protectedIds = new Set()
if (pruneAtRoot !== '') {
  const fd = openChildDir(rootFd, pruneAtRoot)
  if (fd !== null) {
    try {
      protectedIds.add(identity(fstatSync(fd)))
    } finally {
      closeSync(fd)
    }
  }
}

const walk = (dirFd, depth) => {
  if (depth >= MAX_DEPTH) {
    die(`${root} is more than ${MAX_DEPTH} directories deep, which this run will not walk. Nothing further has been changed.`)
  }
  let names
  try {
    names = readdirSync(`/proc/self/fd/${dirFd}`)
  } catch (error) {
    if (RACED.has(error.code)) return
    die(`a directory below ${root} could not be read: ${error.code ?? error.message}. Nothing further has been changed.`)
  }
  for (const name of names) {
    if (pruneAnywhere !== '' && name === pruneAnywhere) continue
    if (depth === 0 && pruneAtRoot !== '' && name === pruneAtRoot) continue
    let entry
    try {
      entry = lstatSync(at(dirFd, name))
    } catch (error) {
      if (RACED.has(error.code)) continue
      die(`${name} below ${root} could not be examined: ${error.code ?? error.message}. Nothing further has been changed.`)
    }
    if (!entry.isDirectory()) {
      chownEntry(dirFd, name)
      continue
    }
    const childFd = openChildDir(dirFd, name)
    if (childFd === null) {
      // It was a directory when it was examined and is not one now — which is precisely the rename
      // this program exists to be indifferent to. Whatever is at the name gets its OWN ownership
      // changed, and nothing is descended into.
      chownEntry(dirFd, name)
      continue
    }
    try {
      if (protectedIds.has(identity(fstatSync(childFd)))) continue
      // AIMED AT THE DESCRIPTOR, not at the name it was reached by: fchown(2) takes no path at all.
      try {
        fchownSync(childFd, uid, gid)
      } catch (error) {
        die(`the ownership of a directory below ${root} could not be changed: ${error.code ?? error.message}. Nothing further has been changed.`)
      }
      walk(childFd, depth + 1)
    } finally {
      closeSync(childFd)
    }
  }
}

try {
  fchownSync(rootFd, uid, gid)
} catch (error) {
  die(`the ownership of ${root} itself could not be changed: ${error.code ?? error.message}. Nothing has been changed.`)
}
walk(rootFd, 0)
closeSync(rootFd)
