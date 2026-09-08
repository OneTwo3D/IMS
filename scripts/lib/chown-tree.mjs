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
 * get it chowned by presenting it under another name.
 *
 * THE STAGING DIRECTORIES ARE PRUNED BY A PROPERTY, AND UNTIL o3d-secops r19 THEY WERE PRUNED BY A
 * NAME (Codex CRITICAL). They cannot be enumerated up front — there is one wherever a publication
 * has happened, at any depth — so the previous round resolved the single component `.ims-publish`
 * against each pinned parent descriptor and skipped it. The justification written here for that was
 *
 *     "what must not be handed to the service account is the directory the publisher will USE,
 *      which is by definition the one at the name `.ims-publish` when the publisher looks; a
 *      directory renamed away from that name is no longer a staging directory but debris"
 *
 * and it is a proof of the wrong property. It reasons about WHICH DIRECTORY THE PUBLISHER WILL USE
 * NEXT. The question the prune has to answer is WHAT THE DEBRIS CONTAINS. publish_durable_file()
 * applies the mode and the owner to its temporary and then fills it, and every failure path removes
 * it — but a SIGKILL or a power loss between the fill and the rename cannot run a failure path, so
 * the staging directory is left holding a complete, root-owned copy of whatever was being
 * published. The service account owns the containing directory, so it may rename `.ims-publish` to
 * an ordinary name at any time before section 8 (a rename WITHIN one parent needs no permission on
 * the directory being moved). The walk then met an ordinary name, fchowned that directory, and
 * descended into it — handing the interrupted publication to the account that renamed it.
 *
 * SO THE PRUNE IS NOT A FACT ABOUT A NAME ANY MORE. A staging directory is created by
 * `(umask 077; mkdir …)` and `chown -h` to the privileged uid, and publish_durable_file() REFUSES
 * to use one that is not exactly that: `%u|%a` must read `${self}|700`. That shape — owned by the
 * uid running this walk, mode exactly 0700 — is one the account being handed the tree cannot
 * MANUFACTURE (it cannot chown anything to root) and cannot ALTER (it does not own it, so `chmod`
 * is EPERM). It is therefore invariant under every rename it can perform, which is precisely what
 * a name was not. Such a directory below the root is by construction something the privileged side
 * created and kept to itself: the crontab lock, a live staging directory, or the debris of an
 * interrupted publication. All three are exactly what must not be handed over.
 *
 * AND IT CANNOT WITHHOLD A DIRECTORY A WORKING INSTALL NEEDS. Everything this installer creates for
 * the service account it creates under `umask 022`, so 0755; a directory that is 0700 and owned by
 * the privileged uid is one the service account cannot enter TODAY, so a run that stops handing it
 * over takes away nothing that was working. The rule is applied to DIRECTORIES only — the finding is
 * about a directory whose contents become reachable — and never to the root itself, which must be
 * handed over and is chowned before the walk begins.
 *
 * AND UNTIL o3d-secops r20 THE PRUNE WAS DECIDED ON ONE LOOKUP AND THE CHANGE MADE ON ANOTHER
 * (Codex HIGH). The shape prune above is only ever consulted when the walk has decided the entry is
 * a DIRECTORY, and that decision used to come from an `lstat()` OF THE NAME. An entry that looked
 * like anything else took the other branch, which `lchown()`ed THE SAME NAME a moment later:
 *
 *     entry = lstatSync(at(dirFd, name))          // "a regular file"
 *     if (!entry.isDirectory()) { chownEntry(dirFd, name); continue }   // resolves the name AGAIN
 *
 * Two lookups of one name, with the account that owns the parent live in between — which is the
 * whole premise of this file, applied everywhere except here. That account plants a sacrificial
 * regular file, waits for the walk to reach it, and renames a directory onto the name in the gap:
 * `rename(2)` within one parent needs no permission on what is being moved, so the directory it
 * renames in may be the staging directory, or the debris of an interrupted publication, or the
 * crontab lock. `lchown()` differs from `chown()` only on a SYMLINK; on a directory it does exactly
 * what `chown` does. The prune therefore never ran, and the walk handed over the one thing it
 * exists to withhold — without descending, so the entry did not even appear as a directory in what
 * the run reported.
 *
 * THE SAME GAP WAS IN THE DIRECTORY BRANCH, one step further along. When the `O_DIRECTORY` open of
 * an entry `lstat` had called a directory failed with ENOTDIR or ELOOP — the swap in the other
 * direction — the code fell back to `chownEntry(dirFd, name)`, the identical second lookup, and a
 * directory renamed in after THAT failure was chowned by name with no prune consulted either.
 *
 * SO NO ENTRY IS NAMED TWICE ANY MORE. Every entry — directory, file, symlink, fifo, socket,
 * device — is OPENED once with `O_PATH | O_NOFOLLOW` from its parent's descriptor; `fstat()` on
 * that descriptor answers what it is, what its mode and owner are and which inode it is; both
 * prunes are applied to THAT answer; and the ownership change is aimed at the descriptor. There is
 * no second resolution for a rename to get between, so an entry swapped from a file to a directory
 * — or from a directory to a file — between the walk noticing it and the walk acting on it is
 * simply the thing the descriptor holds, and it faces the prunes like any other.
 *
 * WHY `O_PATH`, AND WHY THE CHANGE IS STILL AIMED AT A DESCRIPTOR. `O_PATH` opens the entry for
 * METADATA ALONE: it needs no read permission, it does not block on a fifo or a device, and with
 * `O_NOFOLLOW` it opens a SYMLINK ITSELF rather than failing with ELOOP — which is what lets one
 * primitive cover every type and removes the last by-name case. Node has no `fchownat()` and
 * `fchown()` on an `O_PATH` descriptor is EBADF by design, so the change is made through
 * `/proc/self/fd/N`, which the kernel resolves to THE OPEN FILE and not to a pathname — the same
 * mechanism this file already descends by, and the same one tests/temp-dir-sentinel.ts pins its
 * chmods with. On a symlink that is verified NOT to follow the link: the link's own ownership
 * changes and its target's does not, exactly as `chown -h` promised.
 *
 * AND `O_PATH` IS PROVEN AT RUNTIME, NOT ASSUMED. `open(2)` IGNORES flag bits it does not know, so
 * a kernel without `O_PATH` would hand back ORDINARY read descriptors — which would block forever
 * on a fifo and fail with ELOOP on a symlink. The root descriptor is therefore asked for an
 * `fchown()` first: on a real `O_PATH` descriptor that is EBADF, and anything else means the flag
 * was ignored and this run REFUSES rather than walking with a primitive it does not have.
 *
 * FAILURE IS FATAL. Every error other than "the entry is gone" or "it is not a directory any more"
 * ends the process non-zero; the caller dies. A partial ownership change that reported success is
 * how a service ends up unable to read its own state directory.
 *
 * USAGE: node chown-tree.mjs <root> <uid> <gid> <prune-name-at-root>
 *        The prune name may be the empty string, which prunes nothing by identity. The
 *        privileged-and-private prune above is not switchable: it is the security boundary, and an
 *        argument that could turn it off is an argument somebody will get wrong.
 */
import { chownSync, closeSync, fchownSync, fstatSync, openSync, readdirSync, statSync } from 'node:fs'
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
if (argv.length !== 4) {
  die('usage: chown-tree.mjs <root> <uid> <gid> <prune-name-at-root>')
}
const [root, uidText, gidText, pruneAtRoot] = argv

const asId = (text, what) => {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    die(`the ${what} to change ownership to must be a numeric id, and this run was given ${JSON.stringify(text)}. A name resolved to nothing is not an id.`)
  }
  return Number(text)
}
const uid = asId(uidText, 'uid')
const gid = asId(gidText, 'gid')

for (const [name, value] of [['prune-name-at-root', pruneAtRoot]]) {
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

/** Linux's, and Node does not export it — tests/temp-dir-sentinel.ts spells the same constant for
 *  the same reason. It opens an entry for METADATA ALONE: no read permission is needed, a fifo or a
 *  device does not block, and with O_NOFOLLOW a SYMLINK opens as itself instead of failing ELOOP.
 *  That is what makes ONE open cover every type an entry can be, which is what removes the last
 *  ownership change this walk made by name. */
const O_PATH = 0o010000000
/** ONE OPEN PER ENTRY, WHATEVER IT IS. No O_DIRECTORY: the point is that the walk finds out what
 *  the entry is from the descriptor it already holds on it, rather than deciding from a name and
 *  acting on the name again. */
const OPEN_ENTRY = O_PATH | constants.O_NOFOLLOW
/** The same, asserted to be a directory — used only for the identity prune's one lookup at the
 *  root, where a non-directory is not the thing being protected. */
const OPEN_DIR = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
/** The kernel resolves this prefix to the OPEN FILE, so what follows it is resolved from that
 *  directory and from nowhere else. This is the whole mechanism. */
const at = (dirFd, name) => `/proc/self/fd/${dirFd}/${name}`
/** And with nothing after it, it IS the open file: a chown through this changes the inode the
 *  descriptor holds, with no name resolved on the way and nothing for a rename to redirect. */
const held = (fd) => `/proc/self/fd/${fd}`
const identity = (stats) => `${stats.dev}:${stats.ino}`

/** THE UID THIS WALK RUNS AS — asked, exactly as publish_durable_file() asks `id -u` instead of
 *  hardcoding 0. The property is "the privileged account that owns this install", and asking it
 *  lets an unprivileged regression rig exhibit the mechanism with two ordinary directories rather
 *  than needing two accounts. Under the installer it is 0. */
const SELF_UID = process.getuid()

/** A DIRECTORY THE PRIVILEGED SIDE MADE AND KEPT TO ITSELF, and therefore one that is NOT handed
 *  over however it has been renamed. See the PRUNING section at the top of this file: the service
 *  account can neither create such a directory (it cannot chown to the privileged uid) nor change
 *  one (it is not the owner, so `chmod` is EPERM), so this answer is invariant under every rename
 *  it can perform — which is exactly what the `.ims-publish` NAME was not.
 *
 *  0700 EXACTLY, and not merely "nothing for group or other". Every directory this installer makes
 *  for the service account it makes under `umask 022`, so 0755; the two it makes for itself —
 *  prepare_crontab_lock() and publish_durable_file()'s staging directory — it makes under
 *  `umask 077`, so 0700, and publish_durable_file() REFUSES to use a staging directory whose `%a`
 *  is anything else. Testing for the exact mode keeps the rule to the shape those two produce
 *  instead of withholding, say, a root-owned 0755 directory the walk exists to hand over. */
const privilegedAndPrivate = (stats) => stats.uid === SELF_UID && (stats.mode & 0o777) === 0o700

/** GONE, or NO LONGER A DIRECTORY — the two outcomes a concurrent rename can produce that are not
 *  this program's problem. Anything else is. openEntry() can only ever meet the first of them,
 *  because `O_PATH | O_NOFOLLOW` opens an entry of any type; the other two remain because
 *  openChildDir() asserts O_DIRECTORY and can still be answered ENOTDIR or ELOOP. */
const RACED = new Set(['ENOENT', 'ELOOP', 'ENOTDIR'])

/** Opens one component from a descriptor its parent holds, WHATEVER TYPE IT IS. Returns null if
 *  the entry raced away; dies on anything else. This is the only lookup of the name that happens:
 *  everything after it — the type, the mode, the owner, the inode, the prunes and the ownership
 *  change — is asked of the descriptor this returns. */
const openEntry = (dirFd, name) => {
  try {
    return openSync(at(dirFd, name), OPEN_ENTRY)
  } catch (error) {
    if (RACED.has(error.code)) return null
    die(`${name} below ${root} could not be opened: ${error.code ?? error.message}. Nothing further has been changed.`)
  }
  return null
}

/** Opens one component and INSISTS it is a directory — the identity prune's single lookup. */
const openChildDir = (dirFd, name) => {
  try {
    return openSync(at(dirFd, name), OPEN_DIR)
  } catch (error) {
    if (RACED.has(error.code)) return null
    die(`${name} could not be opened as a directory below ${root}: ${error.code ?? error.message}. Nothing further has been changed.`)
  }
  return null
}

/** THE OWNERSHIP CHANGE, AIMED AT THE INODE THE DESCRIPTOR HOLDS. `fchown()` is EBADF on an
 *  `O_PATH` descriptor, so this goes through the descriptor's own /proc name, which the kernel
 *  resolves to the open file rather than resolving a path. On a symlink that changes THE LINK and
 *  not its target — exactly what `chown -h` promised and what `lchown` did, without a second
 *  lookup of the name for a rename to get between. */
const chownPinned = (fd, name) => {
  try {
    chownSync(held(fd), uid, gid)
  } catch (error) {
    // The entry was unlinked between the open and this; there is no directory entry left to own.
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

// O_PATH IS PROVEN BEFORE ANYTHING IS WALKED WITH IT. open(2) silently IGNORES flag bits it does
// not recognise, so a kernel without O_PATH hands back ordinary read descriptors and says nothing —
// and this walk would then block forever on the first fifo and die on the first symlink. fchown()
// on a real O_PATH descriptor is EBADF whatever the permissions are, and on an ordinary one it is
// not; so the answer to this one call is the answer to "do I have the primitive". Anything but
// EBADF is a refusal, including a SUCCESS: a descriptor that accepts fchown is not an O_PATH one.
try {
  fchownSync(rootFd, uid, gid)
  die(`this kernel accepted fchown() on what should be an O_PATH descriptor for ${root}, so the O_PATH flag was ignored and every entry below would be opened for real — which blocks on a fifo and refuses a symlink. This run will not walk by pathname instead. Nothing further has been changed.`)
} catch (error) {
  if (error.code !== 'EBADF') {
    die(`O_PATH is not available on this kernel (fchown on the descriptor for ${root} answered ${error.code ?? error.message}, not EBADF), so this run cannot open an entry of every type without following a link or blocking on it. It will not fall back to changing ownership by pathname, which is the defect this exists to remove.`)
  }
}

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
    if (depth === 0 && pruneAtRoot !== '' && name === pruneAtRoot) continue
    // THE NAME IS RESOLVED ONCE, HERE, AND NEVER AGAIN. Whatever the entry turns out to be — a
    // directory, a file, a symlink, a fifo — this descriptor holds THAT inode, so the type check
    // below and the ownership change after it are questions about one object rather than two
    // lookups of one name with the parent's owner live in between (o3d-secops r20).
    const entryFd = openEntry(dirFd, name)
    if (entryFd === null) continue
    try {
      // ONE fstat, ASKED OF THE DESCRIPTOR THIS PROCESS HOLDS, answering the type AND both prunes.
      // None of the three is a question about the name the entry was reached by, so none can be
      // defeated by a rename: the first is the lock directory's recorded identity, the second the
      // shape of a directory the privileged side made and kept — a live staging directory, or the
      // debris of a publication a SIGKILL interrupted between the fill and the rename.
      const stats = fstatSync(entryFd)
      // THE PRUNES ARE ABOUT DIRECTORIES, and they are asked of what the descriptor IS rather than
      // of what the name looked like a moment ago. A file the walk was about to hand over, swapped
      // for the staging directory in the gap, arrives here as a directory and is withheld.
      if (stats.isDirectory()) {
        if (protectedIds.has(identity(stats))) continue
        if (privilegedAndPrivate(stats)) continue
      }
      chownPinned(entryFd, name)
      if (stats.isDirectory()) walk(entryFd, depth + 1)
    } finally {
      closeSync(entryFd)
    }
  }
}

try {
  chownSync(held(rootFd), uid, gid)
} catch (error) {
  die(`the ownership of ${root} itself could not be changed: ${error.code ?? error.message}. Nothing has been changed.`)
}
walk(rootFd, 0)
closeSync(rootFd)
