/**
 * The filesystem side of the first-load apply command: the installation env file, the report directory, the published report pair, small bounded reads and file hashes.
 *
 * Copies the hardening of the fresh-install rehearsal and the readiness gate rather than inventing a second set (lib/ops/published-report.ts): reports are created exclusively and
 * never through a symlink, fsynced, linked into place without overwriting anything, Markdown first and the JSON last as the commit record that names the Markdown by SHA-256.
 *
 * What it does NOT defend against, stated: a process running as the same account (or root) can write anywhere this account can. Ownership and mode are what is checked, not authenticity.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import path from 'node:path'

import { checkAncestors, fsyncDirectory, writeExclusive } from '../../lib/ops/published-report'

const MAX_ENV_FILE_BYTES = 256 * 1024
const MAX_SMALL_FILE_BYTES = 4 * 1024 * 1024
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

const myUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0)

/** Read a regular file through one descriptor (opened O_NOFOLLOW), bounded. Returns the bytes and the facts of the descriptor, or a closed reason. */
export function readRegularFile(file: string, maxBytes: number): { ok: true; bytes: Buffer; mode: number; uid: number } | { ok: false; reason: 'unreadable' | 'not a regular file' | 'too large' } {
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) return { ok: false, reason: 'not a regular file' }
    if (info.size > maxBytes) return { ok: false, reason: 'too large' }
    const bytes = Buffer.alloc(info.size)
    let read = 0
    while (read < info.size) {
      const n = readSync(fd, bytes, read, info.size - read, read)
      if (n === 0) break
      read += n
    }
    return { ok: true, bytes: bytes.subarray(0, read), mode: info.mode, uid: info.uid }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}

export function readSmallFile(file: string): { ok: true; text: string } | { ok: false; reason: string } {
  const read = readRegularFile(file, MAX_SMALL_FILE_BYTES)
  return read.ok ? { ok: true, text: read.bytes.toString('utf8') } : { ok: false, reason: read.reason }
}

export function sha256OfFile(file: string): { ok: true; sha256: string; bytes: number } | { ok: false; reason: string } {
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, reason: 'not a regular file' }
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    let bytes = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      hash.update(chunk.subarray(0, n))
      bytes += n
    }
    return { ok: true, sha256: hash.digest('hex'), bytes }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}

/**
 * The installation env file: a regular file (never a symlink), owned by the running account, mode 600 (no group or other bit), bounded. Lines are KEY=VALUE (an optional `export `,
 * one pair of surrounding quotes removed); blank lines and comments are skipped. A line that is none of these is a problem, reported by COUNT (its text can be a secret).
 */
export function readEnvFile(file: string): { ok: true; env: Record<string, string> } | { ok: false; problem: string } {
  const read = readRegularFile(file, MAX_ENV_FILE_BYTES)
  if (!read.ok) return { ok: false, problem: `the env file is ${read.reason}` }
  if (read.uid !== myUid()) return { ok: false, problem: 'the env file is not owned by the account running this command' }
  if ((read.mode & 0o077) !== 0) return { ok: false, problem: 'the env file is readable or writable by group or others; it must be mode 600' }
  const env: Record<string, string> = {}
  let bad = 0
  for (const raw of read.bytes.toString('utf8').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = ENV_LINE.exec(line)
    if (!match) { bad++; continue }
    let value = match[2]!
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    env[match[1]!] = value
  }
  if (bad > 0) return { ok: false, problem: `the env file has ${bad} line(s) that are not KEY=VALUE` }
  return { ok: true, env }
}

export interface ReportDir {
  dir: string
  dev: number
  ino: number
}

/** A report directory: created 0700 if absent, a real directory owned by this account, no group or other access, every ancestor trustworthy. Its identity is recorded for the later writes. */
export function prepareReportDir(dir: string): { ok: true; value: ReportDir } | { ok: false; problem: string } {
  const resolved = path.resolve(dir)
  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 })
    const info = lstatSync(resolved)
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, problem: 'the report directory is not a real directory (a symlink is refused)' }
    if (info.uid !== myUid()) return { ok: false, problem: 'the report directory is not owned by the account running this command' }
    if ((info.mode & 0o077) !== 0) return { ok: false, problem: 'the report directory is accessible to group or others; it must be mode 700' }
    const ancestors = checkAncestors(resolved, 'the report directory')
    if (ancestors !== null) return { ok: false, problem: ancestors.replace(resolved, '<report directory>') }
    return { ok: true, value: { dir: resolved, dev: info.dev, ino: info.ino } }
  } catch {
    return { ok: false, problem: 'the report directory cannot be created or inspected' }
  }
}

export class ReportDirReplacedError extends Error {
  constructor() {
    super('the report directory was replaced while the run was in progress')
    this.name = 'ReportDirReplacedError'
  }
}

function assertSameDir(dir: ReportDir): void {
  const info = lstatSync(dir.dir)
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== dir.dev || info.ino !== dir.ino) throw new ReportDirReplacedError()
}

export interface PublishedFiles {
  json: string
  markdown: string
}

/**
 * Publish a report pair: the Markdown first and the JSON last. Each is written exclusively under a random temporary name and linked to its final name (a link fails if the name exists,
 * so nothing is ever overwritten), then the temporary name is removed. The JSON gets `companionMarkdownSha256`, so a JSON whose Markdown is missing or different is detectably not the pair
 * that was published (lib/ops/published-report.ts verifyPublishedReport). On failure only what this call created is removed.
 */
export function publishReportPair(dir: ReportDir, stem: string, record: Record<string, unknown>, markdownText: string, hooks: { writeFile?: (file: string, data: string) => void } = {}): PublishedFiles {
  const write = hooks.writeFile ?? writeExclusive
  const suffix = randomBytes(6).toString('hex')
  const finalMarkdown = path.join(dir.dir, `${stem}.md`)
  const finalJson = path.join(dir.dir, `${stem}.json`)
  const tmpMarkdown = path.join(dir.dir, `.${stem}.md.${suffix}.tmp`)
  const tmpJson = path.join(dir.dir, `.${stem}.json.${suffix}.tmp`)
  const created: string[] = []
  const link = (from: string, to: string): void => {
    assertSameDir(dir)
    linkSync(from, to)
    created.push(to)
    rmSync(from, { force: true })
  }
  try {
    assertSameDir(dir)
    const json = `${JSON.stringify({ ...record, companionMarkdownSha256: createHash('sha256').update(markdownText).digest('hex') }, null, 2)}\n`
    created.push(tmpMarkdown)
    write(tmpMarkdown, markdownText)
    created.push(tmpJson)
    write(tmpJson, json)
    link(tmpMarkdown, finalMarkdown)
    link(tmpJson, finalJson)
    fsyncDirectory(dir.dir)
    return { json: finalJson, markdown: finalMarkdown }
  } catch (error) {
    for (const file of created.splice(0)) rmSync(file, { force: true })
    throw error
  }
}

/** Write one small exclusive file into the report directory (the rehearsal record). */
export function publishRecord(dir: ReportDir, name: string, text: string): string {
  assertSameDir(dir)
  const file = path.join(dir.dir, name)
  writeExclusive(file, text)
  fsyncDirectory(dir.dir)
  return file
}
