/**
 * HEARTBEATS FOR THE MANAGED CRON JOBS (opt-in).
 *
 * When enabled, every managed job line's command is wrapped so Healthchecks hears about each run:
 *
 *   <schedule>  /usr/local/bin/o3d-hc <check-slug> -- sh -c '<the existing command, single quotes escaped>'
 *
 * `o3d-hc` (infra repo) pings start / exit code and never fails the job; it passes stdin through, and the wrapped command is the
 * unchanged existing text, so the `echo ... | curl -K -` secret handling is exactly as before (the secret never reaches an argv).
 * The app NEVER calls Healthchecks: it only emits the wrapped lines and, for the operator, the list of checks to create
 * (`listHeartbeatChecks`).
 *
 * DEFAULT OFF: without options the generated text is byte-identical to the unwrapped form. The form is part of the exact-line
 * comparison everywhere (stage drift, production cron reader): a job counts as scheduled only in the form the CURRENT options
 * produce, so a half-applied state (wrapped lines with heartbeats off, or the reverse) reads as drift.
 *
 * Pure, and imports nothing from lib/crontab-sync.ts (which imports this).
 */

import { SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV } from './scheduler-crontab-env'

export const HEARTBEAT_WRAPPER_PATH = '/usr/local/bin/o3d-hc'
export const HEARTBEATS_ENV = 'IMS_CRON_HEARTBEATS'
export const HEARTBEATS_PREFIX_ENV = 'IMS_CRON_HEARTBEATS_PREFIX'
/** Healthchecks slugs are kept within this many characters, prefix included. */
export const HEARTBEAT_SLUG_MAX = 50
export const PRODUCTION_HEARTBEAT_PREFIX = 'ims-'
export const STAGE_HEARTBEAT_PREFIX = 'ims-stage-'

export type HeartbeatOptions = { slugPrefix: string }

const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,19}-$/

/** Pure. A usable prefix (lowercase letters, digits and hyphens, ending in a hyphen, at most 20 characters), or null. */
export function validHeartbeatPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix)
}

/** Small stable hash (FNV-1a, 32 bit) for the truncation suffix. */
function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Pure. The check slug for a job: prefix + the job's registry slug, lowercased, anything outside [a-z0-9-] turned into a hyphen,
 * at most 50 characters. A name that does not fit keeps its head and ends in `-<8 hex of a hash of the full name>`, so two long
 * names never collide. Stable: depends only on the two inputs.
 */
export function heartbeatCheckSlug(prefix: string, jobSlug: string): string {
  const full = `${prefix}${jobSlug}`.toLowerCase()
  const clean = full.replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/-+$/, '')
  if (clean.length <= HEARTBEAT_SLUG_MAX) return clean
  const head = clean.slice(0, HEARTBEAT_SLUG_MAX - 9).replace(/-+$/, '')
  return `${head}-${shortHash(full)}`
}

/**
 * Pure. Heartbeat options from the environment, or null (off). On when IMS_CRON_HEARTBEATS is `1`/`true`. The prefix is
 * IMS_CRON_HEARTBEATS_PREFIX when set (and valid; an invalid one turns heartbeats off rather than guessing), else `ims-` in container
 * mode (the production cron.d layout) and `ims-stage-` everywhere else, so stage and production checks are distinct.
 */
export function resolveHeartbeatsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): HeartbeatOptions | null {
  const flag = env[HEARTBEATS_ENV]?.trim().toLowerCase()
  if (flag !== '1' && flag !== 'true') return null
  const explicit = env[HEARTBEATS_PREFIX_ENV]?.trim()
  if (explicit) return validHeartbeatPrefix(explicit) ? { slugPrefix: explicit } : null
  const containerMode = Boolean(env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()) && env[SCHEDULER_CRONTAB_FORMAT_ENV]?.trim() === 'cron.d'
  return { slugPrefix: containerMode ? PRODUCTION_HEARTBEAT_PREFIX : STAGE_HEARTBEAT_PREFIX }
}

/** Pure. The command wrapped for `o3d-hc`: the existing command as ONE single-quoted `sh -c` argument. */
export function wrapJobCommand(command: string, checkSlug: string): string {
  return `${HEARTBEAT_WRAPPER_PATH} ${checkSlug} -- sh -c '${command.replaceAll("'", "'\\''")}'`
}

const WRAPPED_LINE_RE = /^(\s*\S+(?:\s+\S+){4}\s+)\/usr\/local\/bin\/o3d-hc ([a-z0-9-]+) -- sh -c '(.*)'$/

/** Pure. The unwrapped form of a job line (schedule, then the original command) and its check slug; null when the line is not wrapped. */
export function unwrapJobLine(line: string): { line: string; checkSlug: string } | null {
  const match = WRAPPED_LINE_RE.exec(line)
  if (!match) return null
  return { line: `${match[1]}${match[3]!.replaceAll("'\\''", "'")}`, checkSlug: match[2]! }
}

export type HeartbeatCheck = { slug: string; schedule: string; tz: string; job: string }

/**
 * Pure. What the operator creates in Healthchecks: one check per ENABLED job, with the job's cron schedule and time zone. The
 * caller passes the jobs already filtered to the enabled ones, with their effective schedules.
 */
export function heartbeatChecksFor(entries: readonly { jobSlug: string; schedule: string }[], options: HeartbeatOptions, tz: string): HeartbeatCheck[] {
  return entries.map((entry) => ({ slug: heartbeatCheckSlug(options.slugPrefix, entry.jobSlug), schedule: entry.schedule, tz, job: entry.jobSlug }))
}
