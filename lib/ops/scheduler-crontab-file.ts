import { lstatSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { OTI_CRON_END_MARKER, OTI_CRON_START_MARKER, validateCronSchedule } from '@/lib/crontab-sync'

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
 * of the command as the user and the job would never run correctly; such a line is replaced by an inert comment (so line numbers hold), and
 * the job reads as unscheduled instead of matching the generator's text. Comments, blank lines and NAME=value lines are left alone.
 */
/** Stands in for a dropped line, so every later line keeps its line number in diagnostics. An inert comment. */
const IGNORED_LINE = '# (a line without a valid user field was ignored here)'

export function stripCronDUserField(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || ASSIGNMENT_RE.test(trimmed)) { out.push(line); continue }
    const special = SPECIAL_RE.exec(trimmed)
    if (special) {
      out.push(USER_RE.test(special[2]!) ? `${special[1]}  ${special[3]}` : IGNORED_LINE)
      continue
    }
    const five = FIVE_FIELD_RE.exec(trimmed)
    if (five) {
      out.push(USER_RE.test(five[2]!) ? `${five[1]}  ${five[3]}` : IGNORED_LINE)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/*
 * DIAGNOSTICS NEVER CARRY INSTALLED COMMAND TEXT. A host cron line can hold a bearer token or any other credential, and these
 * messages reach the Scheduler page and the status output, so they give line numbers and a classification only; the one piece of an
 * assignment that is ever shown is its variable NAME, never its value.
 */

/**
 * Pure. What a cron.d file holds OUTSIDE its managed block (user field already removed). In cron.d mode the file belongs entirely to
 * the renderer, so outside the START/END markers only blank lines and `#` comments are allowed:
 *   - an ACTIVE line is a job cron will also run (a copy of a managed job appended after END fires it twice);
 *   - a `NAME=value` assignment is applied by cron to every job that follows it (`SHELL=/bin/false` before the block would stop every
 *     managed job from running while the block itself still looks perfect).
 * Either way the block cannot vouch for the schedule. Marker problems (a second pair, an unbalanced one) are reported by
 * `parseManagedBlock`. Assignments INSIDE the block are whatever the renderer emits, covered by the exact block comparison.
 */
export function linesOutsideManagedBlock(text: string): { active: number[]; assignments: { line: number; name: string }[] } {
  const out = { active: [] as number[], assignments: [] as { line: number; name: string }[] }
  let inside = false
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim()
    if (trimmed === OTI_CRON_START_MARKER) { inside = true; continue }
    if (trimmed === OTI_CRON_END_MARKER) { inside = false; continue }
    if (inside || trimmed === '' || trimmed.startsWith('#')) continue
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed)
    if (assignment) out.assignments.push({ line: i + 1, name: assignment[1]! })
    else out.active.push(i + 1)
  }
  return out
}

/**
 * Pure. Installed job lines (anywhere in the file, user field already removed) whose five schedule fields are not a valid cron
 * schedule. cron ignores such a line, so the job never runs while an exact-text comparison with the renderer's output can still match.
 */
export function invalidScheduleLines(text: string): { line: number; field: string; kind: string }[] {
  const out: { line: number; field: string; kind: string }[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim()
    if (!/^[0-9*]/.test(trimmed)) continue
    const check = validateCronSchedule(trimmed.split(/\s+/).slice(0, 5).join(' '))
    if (!check.ok) out.push({ line: i + 1, field: check.field, kind: check.kind })
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
  const invalid = invalidScheduleLines(stripped)
  if (invalid.length > 0) {
    const shown = invalid.slice(0, 5).map((entry) => `line ${entry.line}: invalid ${entry.field} (${entry.kind})`).join('; ')
    return { resolved: false, reason: `${OUTSIDE_LINES_REASON_PREFIX} ${invalid.length} installed job line(s) with a schedule cron would not run (${shown}${invalid.length > 5 ? '; ...' : ''})` }
  }
  const outside = linesOutsideManagedBlock(stripped)
  if (outside.active.length > 0 || outside.assignments.length > 0) {
    const found = [
      ...outside.active.slice(0, 5).map((line) => `line ${line}: active job line outside the managed block`),
      ...outside.assignments.slice(0, 5).map((entry) => `line ${entry.line}: environment assignment outside the managed block (${entry.name})`),
    ]
    const total = outside.active.length + outside.assignments.length
    return { resolved: false, reason: `${OUTSIDE_LINES_REASON_PREFIX} ${total} line(s) outside the managed block that cron would run or apply (${found.join('; ')}${total > found.length ? '; ...' : ''}); the cron.d file must contain only the rendered block` }
  }
  return { resolved: true, text: stripped }
}
