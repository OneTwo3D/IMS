import { readFileSync } from 'node:fs'
import path from 'node:path'

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

/** The configured file, or null when the variable is unset (or blank). Pure. */
export function configuredSchedulerCrontabFile(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const raw = env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()
  return raw ? raw : null
}

export function readSchedulerCrontabFile(
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (file: string) => Buffer = (f) => readFileSync(f),
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
  return { resolved: true, text: format === 'cron.d' ? stripCronDUserField(text) : text }
}
