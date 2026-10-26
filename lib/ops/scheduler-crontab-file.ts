import { lstatSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { OTI_CRON_END_MARKER, OTI_CRON_START_MARKER } from '@/lib/crontab-sync'

/**
 * WHERE THE SCHEDULER'S CRONTAB COMES FROM WHEN THE PROCESS CANNOT RUN `crontab -l`.
 *
 * In the container image cron runs on the HOST, not in the container (two containers overlap during a blue/green deploy, and each
 * running its own scheduler would fire every job twice), and the image has no `crontab` binary. The deployment mounts the host's cron
 * file read-only and points IMS_SCHEDULER_CRONTAB_FILE at it. The report then judges "is the alarm job really scheduled?" from that
 * text, parsed exactly as `crontab -l` output is.
 *
 * IMS_SCHEDULER_CRONTAB_FORMAT says how the file is laid out:
 *   user    (default) the text `crontab -l` prints: `m h dom mon dow command`.
 *   cron.d  the PRODUCTION layout: the host's /etc/cron.d file itself, mounted read-only, so what is read is what cron runs. The layout: `m h dom mon dow USER command` (an `@reboot`-style line is `@word USER command`). The user field is
 *           removed from every job line before the text is judged; comments and NAME=value lines are left alone.
 *
 * UNSET means today's behaviour (`crontab -l`). SET means the file is the ONLY source, and anything wrong with it (a relative path, a
 * missing or unreadable file, a directory, an oversized file, an unknown format) is an UNRESOLVED read, never an empty crontab: "no
 * scheduler information" must not read as healthy.
 */
export const SCHEDULER_CRONTAB_FILE_ENV = 'IMS_SCHEDULER_CRONTAB_FILE'
export const SCHEDULER_CRONTAB_FORMAT_ENV = 'IMS_SCHEDULER_CRONTAB_FORMAT'
export const SCHEDULER_CRONTAB_MAX_BYTES = 1024 * 1024

export type SchedulerCrontabRead = { resolved: true; text: string } | { resolved: false; reason: string }

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/
const SPECIAL_RE = /^(@[A-Za-z]+)\s+(\S+)\s+(.*)$/
const FIVE_FIELD_RE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.*)$/
/** What cron accepts as the user field of a cron.d line. A command word (`CRON_SECRET=$(grep ...`) is not one. */
const USER_RE = /^[a-z_][a-z0-9_-]*\$?$/i
/** run-parts / Debian cron: a cron.d file whose name has any other character (a dot above all) is IGNORED by cron. */
export const CRON_D_FILE_NAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * Pure. Turns the text of a cron.d-layout file into the text `crontab -l` would show for the same jobs: the user field is removed
 * from every job line. A job line whose sixth field is not a plausible user name has NO user field, so cron would run the first word
 * of the command as the user and the job would never run correctly; such a line is DROPPED, so the job reads as unscheduled instead of
 * matching the generator's text. Comments, blank lines and NAME=value lines are left alone.
 */
export function stripCronDUserField(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || ASSIGNMENT_RE.test(trimmed)) { out.push(line); continue }
    const special = SPECIAL_RE.exec(trimmed)
    if (special) {
      if (USER_RE.test(special[2]!)) out.push(`${special[1]}  ${special[3]}`)
      continue
    }
    const five = FIVE_FIELD_RE.exec(trimmed)
    if (five) {
      if (USER_RE.test(five[2]!)) out.push(`${five[1]}  ${five[3]}`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Words that make a `NAME=value` assignment look like a credential; any value assignment is redacted in a preview anyway. */
const VALUE_ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g

/** A short preview of a stray line that cannot leak a value: every NAME=value is shown as NAME=<redacted>. Pure. */
export function redactedLinePreview(line: string): string {
  const redacted = line.trim().replace(VALUE_ASSIGNMENT_RE, '$1=<redacted>')
  return redacted.length > 100 ? `${redacted.slice(0, 100)}...` : redacted
}

/**
 * Pure. What a cron.d file holds OUTSIDE its managed block (user field already removed). In cron.d mode the file belongs entirely to
 * the renderer, so outside the START/END markers only blank lines and `#` comments are allowed:
 *   - an ACTIVE line is a job cron will also run (a copy of a managed job appended after END fires it twice);
 *   - a `NAME=value` assignment is applied by cron to every job that follows it (`SHELL=/bin/false` before the block would stop every
 *     managed job from running while the block itself still looks perfect).
 * Either way the block cannot vouch for the schedule. Marker problems (a second pair, an unbalanced one) are reported by
 * `parseManagedBlock`. Assignments INSIDE the block are whatever the renderer emits, covered by the exact block comparison.
 */
export function linesOutsideManagedBlock(text: string): { active: string[]; assignments: string[] } {
  const out = { active: [] as string[], assignments: [] as string[] }
  let inside = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === OTI_CRON_START_MARKER) { inside = true; continue }
    if (trimmed === OTI_CRON_END_MARKER) { inside = false; continue }
    if (inside || trimmed === '' || trimmed.startsWith('#')) continue
    if (ASSIGNMENT_RE.test(trimmed)) out.assignments.push(trimmed)
    else out.active.push(trimmed)
  }
  return out
}

export const OUTSIDE_LINES_REASON_PREFIX = 'Host cron is out of date:'

/** The configured file, or null when the variable is unset (or blank). Pure. */
export function configuredSchedulerCrontabFile(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const raw = env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()
  return raw ? raw : null
}

export type CronFileStat = { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number; nlink: number }
export type CronFileStatter = { lstat: (file: string) => CronFileStat; stat: (file: string) => CronFileStat }
const REAL_STATTER: CronFileStatter = { lstat: (f) => lstatSync(f), stat: (f) => statSync(f) }

/**
 * Debian cron silently IGNORES a cron.d file that is not a regular file with a single link, is not owned by root, or is writable by
 * group or others. The reader applies the same rules before it accepts the file, because a file cron ignores is a scheduler in which
 * no job ever fires. Through a read-only bind mount the container sees the host file's own uid and mode bits (a bind mount does not
 * remap them), so these are the values cron checks on the host. A symlink is followed and the TARGET is judged, as cron does.
 * Returns the reason cron would ignore the file, or null.
 */
export function cronWouldIgnore(file: string, statter: CronFileStatter = REAL_STATTER): string | null {
  let info: CronFileStat
  try {
    info = statter.lstat(file)
    if (info.isSymbolicLink()) info = statter.stat(file)
  } catch (error) {
    return `cron would ignore ${file}: it cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'error'})`
  }
  if (!info.isFile()) return `cron would ignore ${file}: not a regular file`
  if (info.uid !== 0) return `cron would ignore ${file}: not owned by root (uid ${info.uid})`
  if ((info.mode & 0o022) !== 0) return `cron would ignore ${file}: group/world-writable (mode ${(info.mode & 0o7777).toString(8).padStart(4, '0')})`
  if (info.nlink !== 1) return `cron would ignore ${file}: it has ${info.nlink} hard links`
  return null
}

export function readSchedulerCrontabFile(
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (file: string) => Buffer = (f) => readFileSync(f),
  statter: CronFileStatter = REAL_STATTER,
): SchedulerCrontabRead {
  const format = env[SCHEDULER_CRONTAB_FORMAT_ENV]?.trim() || 'user'
  if (format !== 'user' && format !== 'cron.d') {
    return { resolved: false, reason: `${SCHEDULER_CRONTAB_FORMAT_ENV} is not "user" or "cron.d"` }
  }
  if (!path.isAbsolute(file)) {
    return { resolved: false, reason: `${SCHEDULER_CRONTAB_FILE_ENV} must be an absolute path` }
  }
  if (format === 'cron.d' && !CRON_D_FILE_NAME_RE.test(path.basename(file))) {
    return { resolved: false, reason: `cron ignores a cron.d file named "${path.basename(file)}" (only letters, digits, "_" and "-" are allowed, so no dots); the installed file would never run` }
  }
  if (format === 'cron.d') {
    const ignored = cronWouldIgnore(file, statter)
    if (ignored !== null) return { resolved: false, reason: ignored }
  }
  let bytes: Buffer
  try {
    bytes = readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable'
    return { resolved: false, reason: `the scheduler crontab file named by ${SCHEDULER_CRONTAB_FILE_ENV} could not be read (${code})` }
  }
  if (bytes.length > SCHEDULER_CRONTAB_MAX_BYTES) {
    return { resolved: false, reason: `the scheduler crontab file is larger than ${SCHEDULER_CRONTAB_MAX_BYTES} bytes` }
  }
  const text = bytes.toString('utf8')
  if (format !== 'cron.d') return { resolved: true, text }
  const stripped = stripCronDUserField(text)
  const outside = linesOutsideManagedBlock(stripped)
  if (outside.active.length > 0 || outside.assignments.length > 0) {
    const preview = (lines: string[]) => lines.slice(0, 3).map((line) => `"${redactedLinePreview(line)}"`).join(', ') + (lines.length > 3 ? ', ...' : '')
    const found = [
      outside.active.length > 0 ? `${outside.active.length} active line(s) outside the managed block that cron would also run (${preview(outside.active)})` : '',
      outside.assignments.length > 0 ? `${outside.assignments.length} environment assignment(s) outside the managed block that cron applies to the jobs after them (${preview(outside.assignments)})` : '',
    ].filter(Boolean).join('; ')
    return { resolved: false, reason: `${OUTSIDE_LINES_REASON_PREFIX} ${found}; the cron.d file must contain only the rendered block` }
  }
  return { resolved: true, text: stripped }
}
