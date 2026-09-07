#!/usr/bin/env node
/**
 * pin-source-file.mjs — read a file OUT OF A DIRECTORY SOMEBODY ELSE OWNS, by opening its name
 * exactly once, judging the DESCRIPTOR that open returned, and copying the bytes from that same
 * descriptor. The name is never resolved a second time.
 *
 * WHY THIS EXISTS (o3d-secops r21, Codex HIGH).
 *
 * r20 moved the cutover marker OUT of ${CUTOVER_STATE_DIR} — the application's own data directory,
 * which the installer hands to ${APP_USER} — because `unlink(2)` and `rename(2)` ask for write
 * permission on the PARENT and ask nothing at all about the file. It then left the relocation
 * itself reaching back into that directory BY NAME:
 *
 *     [[ -f "${LEGACY_STATE_DIR_FENCE_FILE}" ]] || return 0
 *     publish_durable_file "${FENCE_FILE}" < "${LEGACY_STATE_DIR_FENCE_FILE}"
 *
 * `[[ -f ]]` FOLLOWS A SYMLINK and says nothing about who wrote what it found, and the redirection
 * then resolves the same name a second time, as root. So the account the fence exists to stop could
 * leave a marker of its own at that name — or a symlink to any file root can read — and the
 * relocation would launder it into a root-owned marker at ${FENCE_FILE}, where the destination
 * checks (type, owner, mode, private parent) all pass, BECAUSE THE PUBLICATION MADE THEM PASS.
 * Validating the copy proves the copy is well-formed; it says nothing about where the bytes came
 * from. That is the fifth appearance of one shape on this branch: judge one thing, act on another.
 *
 * THE SOURCE'S PARENT CANNOT BE PART OF THE ANSWER, and that is what makes this different from
 * fence_marker_is_trustworthy(). That function can demand a private root-owned parent because it is
 * asking about ${FENCE_FILE}, which lives in a directory this round created for it. The legacy path
 * is in the service account's own directory BY DEFINITION — that is the whole reason the marker was
 * moved — so nothing about its parent can ever be reassuring. What is left is the file itself, and
 * the only trustworthy way to ask about "the file itself" is to hold it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 *
 *   1. ONE `open(2)`, with `O_NOFOLLOW`, so a symlink at that name is ELOOP — a refusal made by the
 *      kernel before this process has a descriptor at all, rather than a check this process makes
 *      and something else invalidates. And with `O_NONBLOCK`, so a FIFO at that name returns
 *      immediately instead of parking a root-side cutover forever waiting for a writer. Neither
 *      flag has any effect on the regular file this is meant to read.
 *
 *   2. `fstat(2)` ON THAT DESCRIPTOR — not `stat` on the name — for every fact acted on: it is a
 *      regular file, it is owned by the uid this privileged run has, it is not writable by group or
 *      other, and it has exactly ONE link.
 *
 *      THE LINK COUNT IS NOT PADDING. Ownership is the check that keeps the service account from
 *      manufacturing a source (it cannot chown to root), and a HARD LINK is the one way to get a
 *      root-owned inode to appear at a name in a directory that account controls without owning it.
 *      `fs.protected_hardlinks` normally forbids linking to a file you neither own nor may write,
 *      but that is a sysctl and not a guarantee this script can make, whereas `st_nlink` is a fact
 *      about the inode being held. A marker published by publish_durable_file() is a freshly
 *      renamed temporary and always has exactly one.
 *
 *   3. AND `O_NOFOLLOW` IS PROVEN RATHER THAN ASSUMED, the way chown-tree.mjs proves `O_PATH`.
 *      `open(2)` silently IGNORES flag bits it does not know, so a runtime that dropped this one
 *      would follow the link and say nothing. The proof is free and complete for the one open made
 *      here: `lstat` the name afterwards and require it to be the SAME inode the descriptor holds.
 *      If the open followed a link, the two differ. If the name was swapped between the two calls,
 *      they differ as well — and that is refused too, which is the safe direction: a DISAGREEMENT
 *      is never read as an acceptance, and the bytes acted on are the descriptor's either way.
 *
 *   4. The bytes are copied from THE DESCRIPTOR to stdout. The caller redirects that into a file in
 *      the marker's own root-owned, 0700 directory and publishes from there.
 *
 * WHY A NODE HELPER, AND WHY IT ADDS NO DEPENDENCY. bash cannot express `O_NOFOLLOW`: there is no
 * redirection, no test operator and no coreutils command that opens a name without following it,
 * so every shell-only version of this is an `lstat` of a name followed by an `open` of the same
 * name — two resolutions, and a window between them. The same argument produced chown-tree.mjs one
 * round ago, and the entrypoints already resolve `${IMS_SCRIPT_LIB_DIR}` and already run
 * pg-auth-request.mjs and chown-tree.mjs from it. A host with a legacy marker to relocate is by
 * construction a host that has already had this application installed on it, so it has node; a host
 * that somehow does not gets a refusal, not a fallback to reading the name twice.
 *
 * EXIT STATUS, because the caller acts on all three differently:
 *   0  the descriptor was judged and its bytes are on stdout
 *   2  there is nothing at that name (the entry went away between the caller's look and this open)
 *   1  REFUSED — the reason is on stderr, and nothing was written to stdout
 *   3  this run cannot ask the question at all (bad arguments, no O_NOFOLLOW)
 */

import { openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, constants } from 'node:fs'

/** A refusal names what was found and why it is not a record a privileged run wrote. It never
 *  writes to stdout: the caller redirects stdout into the file it is about to publish, so a
 *  refusal that printed anything there would publish it. */
const refuse = (message) => {
  process.stderr.write(`pin-source-file: ${message}\n`)
  process.exit(1)
}

const path = process.argv[2]
const expectedUidRaw = process.argv[3]

if (typeof path !== 'string' || path === '' || !/^[0-9]+$/.test(expectedUidRaw ?? '')) {
  process.stderr.write('pin-source-file: usage: pin-source-file.mjs <path> <expected-uid>\n')
  process.exit(3)
}
const expectedUid = Number(expectedUidRaw)

// O_NOFOLLOW MUST BE A REAL FLAG. A runtime that reported it as 0 would hand this process a
// descriptor on whatever the link pointed at, and every check below would then describe the
// attacker's choice of file. There is no reading of that which is safe, so it is not attempted.
if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
  process.stderr.write('pin-source-file: this runtime does not define O_NOFOLLOW, so a name cannot be opened without following a symlink at it. This will not read the name twice instead.\n')
  process.exit(3)
}

// ONE OPEN. O_NOFOLLOW makes a symlink ELOOP; O_NONBLOCK makes a fifo or a device return instead of
// blocking a privileged cutover indefinitely. On a regular file both are inert.
let fd
try {
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
} catch (error) {
  const code = error && error.code
  if (code === 'ENOENT') process.exit(2)
  if (code === 'ELOOP') {
    refuse(`${path} is a SYMBOLIC LINK. A cutover marker is a file a privileged run published; a link at that name was put there by something else, and following it would republish whatever it points at as this host's record of an interrupted deploy.`)
  }
  refuse(`${path} could not be opened without following a link at it (${code ?? (error && error.message)}), so nothing can be established about what is there.`)
}

try {
  const held = fstatSync(fd)

  if (!held.isFile()) {
    const kind = held.isDirectory() ? 'a directory'
      : held.isSymbolicLink() ? 'a symbolic link'
      : held.isFIFO() ? 'a FIFO'
      : held.isSocket() ? 'a socket'
      : held.isBlockDevice() ? 'a block device'
      : held.isCharacterDevice() ? 'a character device'
      : 'not a regular file'
    refuse(`${path} is ${kind}. A cutover marker is a regular file this installer published; anything else at that name was put there by something else.`)
  }

  if (held.uid !== expectedUid) {
    refuse(`${path} is owned by uid ${held.uid} and this cutover runs as uid ${expectedUid}, so it is not a record this run wrote and not one it may act on. The account that owns the directory it is in can create files there at will.`)
  }

  if ((held.mode & 0o022) !== 0) {
    refuse(`${path} is mode ${(held.mode & 0o7777).toString(8)}, which is writable by group or other, so its contents are not a record of what any particular run did.`)
  }

  if (held.nlink !== 1) {
    refuse(`${path} has ${held.nlink} links, and a marker this installer published has exactly one. A second link means this inode also has a name somewhere this run did not put it, which is how a file that passes every check above is made to appear at a name the service account controls.`)
  }

  // AND THE DESCRIPTOR IS THE NAME'S OWN INODE. See point 3 at the top: this is the proof that the
  // open did not follow anything, and it is complete for this one open. A disagreement — a runtime
  // that ignored O_NOFOLLOW, or a name replaced since — is a refusal and never an acceptance.
  let named
  try {
    named = lstatSync(path)
  } catch (error) {
    refuse(`${path} could not be examined without following it (${(error && error.code) ?? (error && error.message)}) after it was opened, so this run cannot show that the descriptor it holds is that name's own inode.`)
  }
  if (named.dev !== held.dev || named.ino !== held.ino) {
    refuse(`${path} names inode ${named.dev}:${named.ino} and the descriptor opened from it holds ${held.dev}:${held.ino}. Either the open followed a link — which O_NOFOLLOW was asked to prevent — or the name was replaced in between. Neither is a file this run may republish as a privileged record.`)
  }

  // THE BYTES, FROM THE DESCRIPTOR. `readSync` with no position reads from the descriptor's own
  // offset; the name is not mentioned again, and cannot be.
  const buffer = Buffer.allocUnsafe(65536)
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, null)
    if (read === 0) break
    let written = 0
    while (written < read) {
      // EAGAIN IS NOT AN END. Standard output may be a pipe some other process has put into
      // non-blocking mode; a `writeSync` that gave up there would truncate the marker silently,
      // which is precisely the class of thing `marker_complete=1` exists to catch afterwards and
      // this loop exists to prevent in the first place.
      try {
        written += writeSync(1, buffer, written, read - written)
      } catch (error) {
        if ((error && error.code) !== 'EAGAIN') throw error
      }
    }
  }
} finally {
  try { closeSync(fd) } catch { /* the process is ending either way */ }
}
