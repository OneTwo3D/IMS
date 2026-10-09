/**
 * PUBLISHING A REPORT, AND READING ONE BACK, WITHOUT TRUSTING THE DIRECTORY IT SITS IN.
 *
 * Shared by the fresh-install rehearsal (scripts/rehearse-first-install.ts, which published these first)
 * and the readiness gate (scripts/readiness-gate.ts). A report is a JSON commit record that names its
 * companion Markdown by sha256 (`verifyPublishedReport`); files are created exclusively and never through a
 * symlink, fsynced, and renamed into place, Markdown first and the JSON last. The directory checks refuse a
 * location any OTHER account could modify. Moved here unchanged so there is one copy of this logic.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/** Facts about one path component, as `lstat` reports them. */
export type ComponentInfo = { isDirectory: boolean; isSymlink: boolean; uid: number; mode: number }

/**
 * Why a directory is NOT trustworthy as an ancestor of the rehearsal's work or report directories, or
 * null when it is: it must be a real directory (never a symlink), owned by root or the running account,
 * and not writable by group or others, unless it carries the sticky bit AND is owned by root (the
 * /tmp and /var/tmp shape, where others can create names but cannot rename or remove ours).
 */
export function ancestorProblem(info: ComponentInfo, myUid: number): string | null {
  if (info.isSymlink) return 'is a symlink'
  if (!info.isDirectory) return 'is not a directory'
  if (info.uid !== 0 && info.uid !== myUid) return `is owned by uid ${info.uid}, neither root nor the running account`
  if ((info.mode & 0o022) !== 0 && !((info.mode & 0o1000) !== 0 && info.uid === 0)) return 'is writable by group or others and is not a root-owned sticky directory'
  return null
}

/**
 * Check `target` and every ancestor up to `/`. A same-host attacker who can ALREADY rename or replace one
 * of these is out of scope: this refuses configurations in which OTHER accounts could, and it cannot
 * defend against an account that already owns (or is root over) a validated ancestor. Node offers no
 * directory-descriptor-anchored `openat`, so what follows the check is a path walk, not a held handle.
 */
export function checkAncestors(target: string, label: string): string | null {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0
  let current = path.resolve(target)
  for (;;) {
    let info: ComponentInfo
    try {
      const stat = lstatSync(current)
      info = { isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode }
    } catch (error) {
      return `${label} ${target}: cannot inspect ${current}: ${error instanceof Error ? error.message : String(error)}`
    }
    const problem = ancestorProblem(info, myUid)
    if (problem !== null) return `${label} ${target}: ${current} ${problem}. Use a directory whose every ancestor only root or this account can modify.`
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}


/**
 * Create a file that must not exist yet, never through a symlink, readable by this account only:
 * O_EXCL (fail if anything, including a symlink, is already at the name) with O_NOFOLLOW, then fsync so
 * the bytes are on disk before anything is renamed over a published name.
 */
export function writeExclusive(file: string, data: string): void {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The JSON is the commit record of a published report and names its companion Markdown by sha256.
 * `{ ok: true }` only when the JSON parses, and the Markdown beside it exists with exactly that digest.
 */
export function verifyPublishedReport(jsonFile: string): { ok: true } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(readFileSync(jsonFile, 'utf8')) as { companionMarkdownSha256?: unknown }
    if (typeof parsed.companionMarkdownSha256 !== 'string') return { ok: false, reason: 'the JSON carries no companionMarkdownSha256' }
    const markdown = readFileSync(jsonFile.replace(/\.json$/, '.md'))
    const actual = createHash('sha256').update(markdown).digest('hex')
    return actual === parsed.companionMarkdownSha256 ? { ok: true } : { ok: false, reason: 'the Markdown does not match the digest the JSON records' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}


// ---------------------------------------------------------------------------------------------
// Trusting a file or directory somebody else might have written (the readiness gate reads decisions
// and evidence from disk, so WHO COULD HAVE WRITTEN THEM matters).
// ---------------------------------------------------------------------------------------------

export class UntrustedPathError extends Error {}

/**
 * Open `file` as a regular file that only root or the running account could have written: opened
 * O_NOFOLLOW (a symlink is never followed), a regular file by fstat on the open descriptor, owned by root
 * or the running account, not writable by group or others, and in a directory whose every ancestor passes
 * `checkAncestors`. Throws UntrustedPathError with the reason; any other failure (ENOENT, EACCES) propagates.
 *
 * WHAT THIS DOES NOT DEFEND: a process running as the same account (or as root) can still write the file;
 * that is out of scope and the callers say so. Ownership and mode are what is checked, not authenticity.
 */
export function readTrustedRegularFile(file: string, maxBytes: number): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new UntrustedPathError(`${file} is not a regular file`)
    const me = typeof process.getuid === 'function' ? process.getuid() : 0
    if (info.uid !== 0 && info.uid !== me) throw new UntrustedPathError(`${file} is owned by uid ${info.uid}, neither root nor the running account`)
    if ((info.mode & 0o022) !== 0) throw new UntrustedPathError(`${file} is writable by group or others`)
    const ancestors = checkAncestors(path.dirname(file), 'directory of a trusted file')
    if (ancestors) throw new UntrustedPathError(ancestors)
    if (info.size > maxBytes) throw new Error(`${file} is larger than ${maxBytes} bytes`)
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < info.size) {
      const n = readSync(fd, buffer, read, info.size - read, read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
