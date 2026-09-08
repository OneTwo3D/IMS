#!/usr/bin/env node
/**
 * write-new-file.mjs — CREATE one entry that did not exist, and write stdin into THAT descriptor.
 *
 * WHY THIS EXISTS (o3d-ov60 r3, Codex HIGH).
 *
 * scripts/update.sh dumps the whole database, as root, into `${BACKUP_DIR}/pre-update-<stamp>.sql.gz.part`
 * — a PREDICTABLE name inside a directory `IMS_BACKUP_DIR` may legitimately point at a path
 * ${APP_USER} owns. r2 aimed that write at a proved directory DESCRIPTOR, which answered "which
 * directory", and created the partial with `set -C` — bash's `noclobber` — which was supposed to
 * answer "and only if nothing is there already". It does not:
 *
 *     $ mkfifo p; ( set -C; echo hi > p )        # blocks for ever
 *     $ : > r;    ( set -C; echo hi > r )        # bash: r: cannot overwrite existing file
 *
 * `set -C` is `open(O_WRONLY|O_CREAT|O_EXCL)` ONLY UNTIL IT FAILS. On EEXIST bash stats the name,
 * and if what is there is NOT a regular file it re-opens WITHOUT `O_EXCL` — POSIX requires exactly
 * that, because `> /dev/null` under `noclobber` has to keep working. So the one type `noclobber`
 * lets through is the one type whose `open(2)` BLOCKS: a named pipe with no reader. The service
 * account plants one at the `.part` name and root's `gzip >` waits for a reader that never comes —
 * with the service already stopped, cron already stopped and the database connections already
 * fenced. A refusal unwinds; that does not.
 *
 * WHY A HELPER AND NOT A BETTER REDIRECTION. There is no better redirection. What removes the block
 * is `O_NONBLOCK` — and, to refuse rather than open at all, an `O_EXCL` that is not retried — and a
 * shell redirection has no syntax for either. `scripts/lib/chown-tree.mjs` is this repository's
 * precedent for dropping into node exactly where a shell cannot spell the `open(2)` flags the
 * safety argument rests on; this is the same move, for a flag set instead of a walk.
 *
 * WHAT IT DOES. One `openat(2)`-equivalent, with every flag the refusal needs:
 *
 *   • O_CREAT|O_EXCL — the entry must not exist. A FIFO, a device, a directory, a symlink dangling
 *     or not, or an ordinary file left by a previous run are all EEXIST, and EEXIST is a REFUSAL
 *     here rather than a second attempt. This is the flag `set -C` silently dropped.
 *   • O_NOFOLLOW — redundant beside O_CREAT|O_EXCL, which never follows a final-component symlink,
 *     and stated anyway: the refusal must not depend on a reader knowing that.
 *   • O_NONBLOCK — so that an open which somehow reached a FIFO RETURNS instead of waiting. Stated
 *     honestly: no regression can kill this one on its own, because O_EXCL above already refuses a
 *     named pipe with EEXIST and the open never gets far enough to block. It is here because the
 *     finding is a HANG and the flag that ends a hang costs nothing — on the regular file O_EXCL
 *     guarantees was just created it has no effect on the writes below. Removing it passes every
 *     test in tests/scripts/install-root-safe-writes.test.ts; removing O_EXCL does not.
 *
 * `<dir>` is passed as `/proc/self/fd/N` by the caller, N being the descriptor scripts/update.sh
 * holds on the backup directory it walked into and proved. The kernel resolves that prefix to the
 * OPEN FILE, so `/proc/self/fd/N/<name>` IS `openat(N, "<name>", …)` and no component of
 * ${BACKUP_DIR} is looked up again — the same primitive chown-tree.mjs walks with, and the reason
 * the descriptor is inherited by this process rather than the pathname being passed to it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not unlink on failure: scripts/update.sh removes the
 * partial in the same statement as the dump, because the dump can fail after this process has
 * written a perfectly good descriptor's worth of truncated bytes, and one owner for that removal is
 * better than two. It does not fsync: the caller publishes with `mv -T` exactly as it did before,
 * and adding a durability barrier this code never had is a different change.
 *
 * USAGE: node write-new-file.mjs <dir> <name>      (the content is stdin)
 */
import { constants, createWriteStream, fstatSync, openSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const die = (message) => {
  process.stderr.write(`write-new-file: ${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
if (argv.length !== 2) {
  die('usage: write-new-file.mjs <dir> <name> — the content is read from stdin')
}
const [dir, name] = argv

// A SINGLE COMPONENT, because that is the whole claim: the entry is created in the directory the
// caller proved, and a name carrying `/` or `..` would resolve somewhere the caller proved nothing
// about. Refused rather than sanitised — a name this cannot resolve against one directory is a
// caller bug, and silently rewriting it would hide it.
if (name === '' || name === '.' || name === '..' || name.includes('/')) {
  die(`the file to create must be a single path component, and this run was given ${JSON.stringify(name)}. `
    + 'A name that resolves anywhere but inside the directory this was handed is not a name this will create.')
}
if (dir === '') {
  die('the directory to create the file in must be named, and this run was given an empty string.')
}

/**
 * EVERY FLAG THE REFUSAL RESTS ON, TOGETHER. See the header: O_EXCL is the one `set -C` drops on a
 * non-regular file, and O_NONBLOCK is the one no shell redirection can ask for.
 */
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
  | constants.O_NOFOLLOW | constants.O_NONBLOCK

const target = `${dir}/${name}`
let fd
try {
  fd = openSync(target, CREATE_NEW)
} catch (error) {
  const code = error && error.code
  die(`${name} could not be CREATED in the directory this run proved (${code ?? error}). `
    + 'It is created with O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK, so anything already at that name — an '
    + 'ordinary file left by an earlier run, a symlink, a directory, or a named pipe planted there by '
    + 'the account that owns the directory — is a REFUSAL and never a second attempt without O_EXCL. '
    + 'Nothing has been written.')
}

// O_CREAT|O_EXCL cannot have handed back anything but a regular file it has just made. Asked of the
// DESCRIPTOR anyway, because that is the property everything below assumes and the cost of stating
// it is one fstat(2): a reader should not have to re-derive it from the flag list.
try {
  if (!fstatSync(fd).isFile()) {
    die(`${name} was created and is not a regular file. Nothing has been written.`)
  }
} catch (error) {
  die(`${name} was created and could not then be identified (${(error && error.code) || error}). Nothing has been written.`)
}

try {
  await pipeline(process.stdin, createWriteStream('', { fd, autoClose: true }))
} catch (error) {
  die(`${name} was created and the content could not be written into it (${(error && error.code) || (error && error.message) || error}). `
    + 'The partial file is left for the caller to remove, which is where its removal already lived.')
}
