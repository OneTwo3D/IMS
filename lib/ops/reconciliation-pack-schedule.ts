import path from 'node:path'

import { logActivityPersisted } from '@/lib/activity-log'
import { acquirePinnedAdvisoryLockOrNull, type PinnedAdvisoryLock } from '@/lib/db/pinned-advisory-lock'
import { RECONCILIATION_PACK_SCHEDULE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'
import { buildChildEnv, startNpmScript, type ChildResult, type ChildSpec, type StartedScript } from '@/lib/ops/readiness-gate-collect'
import { VENDOR_ENV } from '@/lib/reconciliation-pack/cli'
import { checkAncestors, readTrustedRegularFileBytes } from '@/lib/ops/published-report'
import { DEFAULT_PACK_REPORT_DIR, MAX_EVIDENCE_BYTES, MAX_REPORT_JSON_BYTES, PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN, PACK_SCHEMA_VERSION } from '@/lib/reconciliation-pack/constants'
import { RUN_ID_RE, parseReport, sha256Hex, verifyEvidence } from '@/lib/reconciliation-pack/report'
import { lockPackScheduleSettings } from '@/lib/reconciliation-pack/schedule-lock'
import { db } from '@/lib/db'
import {
  classifyChildEnd, isNotAFault, parseScheduleSettings, refusalRecord, scheduledPackArgs,
  type ParsedPackOutput, type ScheduledRunRecord,
} from '@/lib/reconciliation-pack/schedule'
import {
  PACK_SCHEDULE_CHILD_TIMEOUT_MS, PACK_SCHEDULE_SPAWN_TIMEOUT_MS, PACK_SCHEDULE_DEFAULT_ENABLED, PACK_SCHEDULE_NPM_SCRIPT, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING,
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
  /** Runs `fn` with the job's rows re-read under the settings fence, holding the fence until `fn` returns (default: a transaction holding the settings advisory lock). */
  fenced?: <T>(keys: string[], fn: (settings: Map<string, string>) => Promise<T>) => Promise<T>
  /** Starts the child and reports when it has spawned (default: startNpmScript). */
  startChild?: (spec: ChildSpec) => StartedScript
  /** Test seam: runs inside the fence after the final read and before the child is started. */
  beforeSpawn?: () => Promise<void>
  spawnTimeoutMs?: number
  acquireLock?: () => Promise<Pick<PinnedAdvisoryLock, 'release'> | null>
  /** True when a run that reads a vendor may start now. */
  vendorGate?: () => Promise<boolean>
  runChild?: (spec: ChildSpec) => Promise<ChildResult>
  /** The verified report the command named (see verifyNamedPackReport), or null when it does not verify. */
  verifyReport?: (parsed: ParsedPackOutput, exitCode: number) => { sequence: number } | null
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

/**
 * The settings fence: a transaction that takes the fence, reads the job's rows from the database and runs `fn` with them, holding the
 * fence until `fn` returns. The runner's `fn` starts the child and waits only for its spawn, so a save waits for at most that, never
 * for the child's life. The transaction timeout covers the spawn alone.
 */
export async function runUnderSettingsFence<T>(keys: string[], fn: (settings: Map<string, string>) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockPackScheduleSettings(tx)
    return fn(await getSettingValues(keys, tx))
  }, { timeout: PACK_SCHEDULE_SPAWN_TIMEOUT_MS + 15_000, maxWait: 10_000 })
}

/** A child started by a test double of `runChild`: it counts as spawned at once. */
function adaptRunChild(run: (spec: ChildSpec) => Promise<ChildResult>): (spec: ChildSpec) => StartedScript {
  return (spec) => ({ spawned: Promise.resolve(), done: (async () => run(spec))(), kill: () => undefined })
}

/**
 * A report counts as published only after the pack's own reader verifies it: the JSON parses under the report grammar, names the run
 * id the command printed (and the directory it sits in), the Markdown it names has the digest the JSON records, the evidence has the
 * digest, line count and content the JSON records, the sequence is a positive integer, and the exit code the JSON derived is the
 * exit code the command ended with. Files are read as trusted regular files (never symlinks, owned by root or this account).
 */
export function verifyNamedPackReport(parsed: ParsedPackOutput, exitCode: number, reportDir: string = DEFAULT_PACK_REPORT_DIR): { sequence: number } | null {
  try {
    if (parsed.runId === null || !RUN_ID_RE.test(parsed.runId)) return null
    if (checkAncestors(reportDir, 'report directory') !== null) return null
    const dir = path.join(reportDir, parsed.runId)
    const jsonBytes = readTrustedRegularFileBytes(path.join(dir, PACK_REPORT_JSON), MAX_REPORT_JSON_BYTES)
    const record = parseReport(jsonBytes.toString('utf8'))
    if (record.runId !== parsed.runId) return null
    // A report this build just published is the current schema version; version 1 is read-only history.
    if (record.schemaVersion !== PACK_SCHEMA_VERSION) return null
    const markdown = readTrustedRegularFileBytes(path.join(dir, PACK_REPORT_MARKDOWN), MAX_REPORT_JSON_BYTES)
    if (sha256Hex(markdown) !== record.companionMarkdownSha256) return null
    const evidence = readTrustedRegularFileBytes(path.join(dir, PACK_EVIDENCE_FILE), MAX_EVIDENCE_BYTES)
    verifyEvidence(evidence.toString('utf8'), record)
    if (sha256Hex(evidence) !== record.evidence.sha256) return null
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) return null
    if (record.exitCode !== exitCode) return null
    return { sequence: record.sequence }
  } catch { return null }
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

    // 6. THE FINAL READ AND THE SPAWN, both under the settings fence. Everything above waited on something (the lock, the rate gate),
    // so the values read at the top may be stale: a disable or a vendor-off saved meanwhile must not be followed by a start that
    // uses them. Every writer of the four rows takes the same transaction-scoped advisory lock in its save. This transaction takes
    // it, re-reads the rows from the database (not a cache), and STARTS THE CHILD BEFORE IT ENDS, waiting only for the process to
    // exist (the 'spawn' event, or its error, within PACK_SCHEDULE_SPAWN_TIMEOUT_MS). A save arriving in that window waits for the
    // spawn and is ordered after the start; one that committed earlier was seen by the read. The fence is released when the
    // transaction ends, i.e. as soon as the child has spawned: the child's lifetime is never inside the transaction, and a
    // settings save never waits for a running child. Vendor reads are conservative: they run only if the top read said on (and the
    // gate above was consulted for it) AND this read still says on; a turned-off option runs the pack without the flag and
    // without the keys, a newly turned-on one waits for the next start.
    type Fenced = { kind: 'refuse'; refusal: PackScheduleRefusal } | { kind: 'spawned' } | { kind: 'spawn-failed' }
    let started: StartedScript | null = null
    let spawnState: 'none' | 'ok' | 'failed' = 'none'
    let fenced: Fenced
    try {
      fenced = await (deps.fenced ?? runUnderSettingsFence)([PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_VENDOR_READS_SETTING], async (finalSettings): Promise<Fenced> => {
        const last = parseScheduleSettings({ phase: finalSettings.get(PACK_SCHEDULE_PHASE_SETTING), vendorReads: finalSettings.get(PACK_SCHEDULE_VENDOR_READS_SETTING) })
        phase = last.ok ? last.phase : null
        vendorReads = parsed.vendorReads && last.vendorReads
        if (!resolveCronEnablement({ canonical: finalSettings.get(PACK_SCHEDULE_ENABLED_SETTING), legacy: undefined, hasLegacyKey: false, defaultEnabled: PACK_SCHEDULE_DEFAULT_ENABLED })) return { kind: 'refuse', refusal: 'SCHEDULE_DISABLED' }
        if (!last.ok) return { kind: 'refuse', refusal: last.refusal }
        await deps.beforeSpawn?.()
        const spec: ChildSpec = {
          script: PACK_SCHEDULE_NPM_SCRIPT,
          silent: true,
          args: scheduledPackArgs(last.phase, vendorReads),
          env: scheduledChildEnv(deps.env ?? process.env, vendorReads),
          cwd: deps.cwd ?? process.cwd(),
          timeoutMs: PACK_SCHEDULE_CHILD_TIMEOUT_MS,
        }
        const begin = deps.startChild ?? (deps.runChild ? adaptRunChild(deps.runChild) : startNpmScript)
        let timer: ReturnType<typeof setTimeout> | null = null
        try {
          started = begin(spec)
          const spawnedOk = await Promise.race([
            started.spawned.then(() => true, () => false),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deps.spawnTimeoutMs ?? PACK_SCHEDULE_SPAWN_TIMEOUT_MS) }),
          ])
          if (!spawnedOk) { started.kill(); spawnState = 'failed'; return { kind: 'spawn-failed' } }
        } catch {
          started?.kill()
          spawnState = 'failed'
          return { kind: 'spawn-failed' }
        } finally {
          if (timer) clearTimeout(timer)
        }
        spawnState = 'ok'
        return { kind: 'spawned' }
      })
    } catch {
      // The fence itself failed. If the child had already spawned it runs on and is recorded; otherwise nothing started.
      if (spawnState === 'none') return await refuse('SETTINGS_UNREADABLE')
      fenced = spawnState === 'ok' ? { kind: 'spawned' } : { kind: 'spawn-failed' }
    }
    if (fenced.kind === 'refuse') return await refuse(fenced.refusal)

    // 7. The operator's command has been started; wait for it OUTSIDE the transaction.
    let ended: ChildResult = { exitCode: null, stdout: '', stderr: '', timedOut: false }
    if (fenced.kind === 'spawned' && started !== null) {
      try { ended = await (started as StartedScript).done } catch { /* a result that never came is a start that failed */ }
    }
    const verifyReport = deps.verifyReport ?? ((output: ParsedPackOutput, exitCode: number) => verifyNamedPackReport(output, exitCode))
    const record = classifyChildEnd(base(), { exitCode: ended.exitCode, timedOut: ended.timedOut, stderr: ended.stderr }, verifyReport)
    return await finish(record)
  } finally {
    await lock.release().catch(() => undefined)
  }
}

