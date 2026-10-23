import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs'

import { logActivityPersisted } from '@/lib/activity-log'
import { acquirePinnedAdvisoryLockOrNull, type PinnedAdvisoryLock } from '@/lib/db/pinned-advisory-lock'
import { RECONCILIATION_PACK_SCHEDULE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'
import { buildChildEnv, runNpmScript, type ChildResult, type ChildSpec } from '@/lib/ops/readiness-gate-collect'
import { VENDOR_ENV } from '@/lib/reconciliation-pack/cli'
import { MAX_REPORT_JSON_BYTES } from '@/lib/reconciliation-pack/constants'
import {
  classifyChildEnd, isNotAFault, parseScheduleSettings, refusalRecord, scheduledPackArgs, sequenceOfReport,
  type ParsedPackOutput, type ScheduledRunRecord,
} from '@/lib/reconciliation-pack/schedule'
import {
  PACK_SCHEDULE_CHILD_TIMEOUT_MS, PACK_SCHEDULE_DEFAULT_ENABLED, PACK_SCHEDULE_NPM_SCRIPT, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING,
  PACK_SCHEDULE_RECORD_ACTION, PACK_SCHEDULE_VENDOR_READS_SETTING, PACK_SCHEDULE_VENDOR_RATE_KEY, PACK_SCHEDULE_VENDOR_WINDOW_MS,
  type PackSchedulePhase, type PackScheduleRefusal,
} from '@/lib/reconciliation-pack/schedule-constants'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSettingValues } from '@/lib/settings-store'

/**
 * THE SCHEDULED RECONCILIATION PACK: start `npm run reconcile:pack` as a child, wait, and keep ONE activity-log record.
 *
 * The command is the operator's command. Its environment whitelist, its account check (by uid), its credential-argument
 * screen, its report-directory trust check and its run lock all run in the child exactly as they do from a terminal; this
 * module passes the child the same short environment the other gate commands get (plus the two storefront-credential key names,
 * and only when vendor reads are on) and a fixed argument list built from the phase and the vendor flag. No path, date, item
 * list or file name is passed: the command's defaults apply.
 *
 * OFF BY DEFAULT, in two places. The crontab line exists only when `cron_reconciliation_pack_enabled` is `true` (the framework
 * builds the crontab from it); and the route calls this function, which re-reads the same row and refuses when it is not
 * `true`, so a stale scheduler entry cannot run a switched-off job. Vendor reads are a second row, also off by default.
 *
 * OVERLAP. A pinned session advisory lock is taken before the child starts and held until the record is written, so a
 * second scheduled start does not run (ALREADY_RUNNING, recorded). If the lock holder's process dies the lock is gone with its
 * connection while an orphaned child may still run; that child and a later one are then held apart at publication by the pack's
 * own file run lock (LOCK_HELD), which a live holder never loses.
 *
 * THE RECORD. One activity-log row per start, whatever happened: a published report, a refusal (this module's or the
 * command's) or a failure. Closed codes, counts, run id, sequence and the two report paths under the default report directory;
 * never file contents, URLs, credentials or vendor data (lib/reconciliation-pack/schedule-constants.ts lists every field). A
 * record that cannot be written does not hide the outcome: the result carries it and `recorded: false`, the route answers red
 * with the same closed code and exit code, the scheduled-job run log (a separate writer) holds them, and one closed line goes to
 * the process log. For a published report the report itself is the durable outcome.
 */

export type ScheduledPackOutcome = {
  record: ScheduledRunRecord
  /** Did the activity-log row reach the database? */
  recorded: boolean
  /** The framework's view: completed (a report was published), failed (a fault), skipped (not a fault, see schedule-constants). */
  status: 'completed' | 'failed' | 'skipped'
}

export type ScheduledPackDeps = {
  now?: () => number
  readSettings?: (keys: string[]) => Promise<Map<string, string>>
  acquireLock?: () => Promise<Pick<PinnedAdvisoryLock, 'release'> | null>
  /** True when a run that reads a vendor may start now. */
  vendorGate?: () => Promise<boolean>
  runChild?: (spec: ChildSpec) => Promise<ChildResult>
  /** The report JSON text of a run id, or null when it cannot be read. */
  readReport?: (parsed: ParsedPackOutput) => string | null
  env?: Record<string, string | undefined>
  cwd?: string
  log?: typeof logActivityPersisted
  consoleError?: (line: string) => void
}

/** The child's environment: the gate commands' whitelist, plus the storefront-credential key names ONLY for a vendor-reads run. */
export function scheduledChildEnv(source: Record<string, string | undefined>, vendorReads: boolean): Record<string, string> {
  const env = buildChildEnv(source)
  if (vendorReads) {
    for (const name of VENDOR_ENV) {
      const value = source[name]
      if (value !== undefined && value !== '') env[name] = value
    }
  }
  return env
}

/** Read a published report: a real file (never a symlink), no larger than the pack's own limit. */
export function readPublishedReport(parsed: ParsedPackOutput): string | null {
  if (parsed.reportJson === null) return null
  let fd: number | null = null
  try {
    fd = openSync(parsed.reportJson, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_REPORT_JSON_BYTES) return null
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < info.size) {
      const n = readSync(fd, buffer, read, info.size - read, read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } catch { return null } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* nothing to close */ } }
  }
}

const levelOf = (record: ScheduledRunRecord): 'INFO' | 'WARNING' | 'ERROR' => {
  if (record.outcome === 'failed') return 'ERROR'
  if (record.outcome === 'refused') return isNotAFault(record) ? 'INFO' : 'ERROR'
  return record.code === 'all-pass' ? 'INFO' : 'WARNING'
}

const describe = (record: ScheduledRunRecord): string => {
  const exit = record.exitCode === null ? 'no exit code' : `exit code ${record.exitCode}`
  if (record.outcome === 'published') return `Scheduled reconciliation pack: report ${record.sequence === null ? '(sequence unreadable)' : `sequence ${record.sequence}`} published, ${record.code} (${exit}).`
  return `Scheduled reconciliation pack: ${record.outcome} (${record.code}; ${exit}).`
}

export async function runScheduledReconciliationPack(scheduleRunId: string, deps: ScheduledPackDeps = {}): Promise<ScheduledPackOutcome> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? logActivityPersisted
  const consoleError = deps.consoleError ?? ((line: string) => { console.error(line) })
  const startedAt = now()
  let phase: PackSchedulePhase | null = null
  let vendorReads = false
  const base = () => ({ scheduleRunId, phase, vendorReads, durationMs: Math.max(0, Math.trunc(now() - startedAt)) })

  const finish = async (record: ScheduledRunRecord): Promise<ScheduledPackOutcome> => {
    let recorded = false
    try {
      recorded = await log({
        entityType: 'SYSTEM',
        entityId: null,
        action: PACK_SCHEDULE_RECORD_ACTION,
        tag: 'sync',
        level: levelOf(record),
        description: describe(record),
        metadata: { ...record },
        resolveUser: false,
      })
    } catch { recorded = false }
    if (!recorded) {
      // Closed words and integers only. The outcome is also in the result, the route's red answer and the run log.
      consoleError(`[reconciliation-pack-schedule] record not written: outcome=${record.outcome} code=${record.code} exit=${record.exitCode === null ? 'none' : record.exitCode}`)
    }
    const status = record.outcome === 'published' ? 'completed' : isNotAFault(record) ? 'skipped' : 'failed'
    return { record, recorded, status }
  }
  const refuse = (refusal: PackScheduleRefusal) => finish(refusalRecord(base(), refusal))

  // 1. Settings. Unreadable settings are a refusal, never a guess at the defaults.
  let settings: Map<string, string>
  try {
    settings = await (deps.readSettings ?? ((keys: string[]) => getSettingValues(keys)))([PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_VENDOR_READS_SETTING])
  } catch {
    return refuse('SETTINGS_UNREADABLE')
  }
  const parsed = parseScheduleSettings({ phase: settings.get(PACK_SCHEDULE_PHASE_SETTING), vendorReads: settings.get(PACK_SCHEDULE_VENDOR_READS_SETTING) })
  vendorReads = parsed.vendorReads
  if (parsed.ok) phase = parsed.phase

  // 2. Switched off: the route is reachable by a stale scheduler entry, so the row is enforced here too.
  const enabled = resolveCronEnablement({ canonical: settings.get(PACK_SCHEDULE_ENABLED_SETTING), legacy: undefined, hasLegacyKey: false, defaultEnabled: PACK_SCHEDULE_DEFAULT_ENABLED })
  if (!enabled) return refuse('SCHEDULE_DISABLED')

  // 3. No default phase.
  if (!parsed.ok) return refuse(parsed.refusal)

  // 4. One scheduled run at a time.
  let lock: Pick<PinnedAdvisoryLock, 'release'> | null
  try {
    lock = await (deps.acquireLock ?? (() => acquirePinnedAdvisoryLockOrNull(RECONCILIATION_PACK_SCHEDULE_LOCK_KEY)))()
  } catch {
    return refuse('LOCK_UNAVAILABLE')
  }
  if (lock === null) return refuse('ALREADY_RUNNING')

  try {
    // 5. Vendor reads are spaced (the pack's own request budget and pace apply inside each run).
    if (parsed.vendorReads) {
      const allowed = await (deps.vendorGate ?? (async () => (await checkRateLimit(PACK_SCHEDULE_VENDOR_RATE_KEY, 1, PACK_SCHEDULE_VENDOR_WINDOW_MS)).allowed))().catch(() => false)
      if (!allowed) return await refuse('VENDOR_READS_TOO_SOON')
    }

    // 6. The operator's command, as a child.
    let ended: ChildResult
    try {
      ended = await (deps.runChild ?? runNpmScript)({
        script: PACK_SCHEDULE_NPM_SCRIPT,
        silent: true,
        args: scheduledPackArgs(parsed.phase, parsed.vendorReads),
        env: scheduledChildEnv(deps.env ?? process.env, parsed.vendorReads),
        cwd: deps.cwd ?? process.cwd(),
        timeoutMs: PACK_SCHEDULE_CHILD_TIMEOUT_MS,
      })
    } catch {
      ended = { exitCode: null, stdout: '', stderr: '', timedOut: false }
    }
    const readReport = deps.readReport ?? readPublishedReport
    const record = classifyChildEnd(base(), { exitCode: ended.exitCode, timedOut: ended.timedOut, stderr: ended.stderr }, (output) => {
      const text = readReport(output)
      return text === null || output.runId === null ? null : sequenceOfReport(text, output.runId)
    })
    return await finish(record)
  } finally {
    await lock.release().catch(() => undefined)
  }
}

