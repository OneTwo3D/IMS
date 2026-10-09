/**
 * THE ALARM OF THE ALARM, ON A JOB THAT IS ALREADY SCHEDULED.
 *
 * A newly registered cron job (the read-sync liveness alarm) is not scheduled on an installation that
 * already has a managed crontab block: neither the installer nor `update.sh` rewrites the block, and the
 * only writer is the in-app scheduler sync. Left alone, an upgraded installation would run without the
 * alarm indefinitely and nothing would say so. The `delivery-status` job is in the installer's
 * bootstrap crontab and runs every 15 minutes on every installation, so it calls this guard after its
 * own work. The guard evaluates the same scheduler check `read-sync:status` does and, when a job the
 * liveness report depends on is switched off or not really in the crontab, raises ONE admin
 * notification (the channel the WMS watchdog uses), once per distinct problem, through the same
 * conditional claim as the alarm. It says what it found and the existing remedy; it changes nothing.
 *
 * An unreadable crontab raises a distinct "could not be verified" reminder, per OBSERVER (host + OS
 * user) and at most once per UTC day, because a web process may structurally be unable to read it;
 * the setting `read_sync_scheduler_guard_expect_unreadable` = `true` silences that for a known
 * structural limitation. `read-sync:status` still exits 6 for it.
 *
 * Every database read the guard makes runs in a short transaction with a server-side statement timeout
 * (a stalled dependency errors out instead of holding a connection), and the number of runs that have
 * not settled is capped, whatever the hard expiry says.
 */

import os from 'node:os'
import { createHash } from 'node:crypto'

import { raceWithDeadline } from './bounded-wait'
import { claimBreachAndDeliver, liveAlarmDelivery, withStatementTimeout, type ReadSyncAlarmDeps, type ReadSyncAlarmTx } from './read-sync-liveness-alarm'
import { READ_SYNC_ALERT_ACTION, READ_SYNC_STATUS_COMMAND } from './read-sync-liveness-constants'
import { checkScheduler, readCrontabForReport, readReadSyncInputs, type ReadSyncInputs } from './read-sync-status'

export const READ_SYNC_SCHEDULER_ALERTED_SETTING = 'read_sync_scheduler_alerted'
export const READ_SYNC_SCHEDULER_STALLED_SETTING = 'read_sync_scheduler_guard_stalled'
/** `true` = this installation knows its web process cannot read the crontab; the "could not be verified" reminder is not raised. */
export const READ_SYNC_SCHEDULER_EXPECT_UNREADABLE_SETTING = 'read_sync_scheduler_guard_expect_unreadable'

/** Ceiling on how long one guard run's PROMISE is awaited (crontab read 5 s, DB reads, claim transaction 15 s). */
export const SCHEDULER_GUARD_CEILING_MS = 30_000
/** Server-side bound on every statement of the guard's own reads. */
export const SCHEDULER_GUARD_READ_STATEMENT_TIMEOUT_MS = 5_000
/**
 * The in-flight mark is held until the underlying work has actually settled, or this much MONOTONIC time
 * has passed since it started, whichever comes first.
 */
export const SCHEDULER_GUARD_HARD_EXPIRY_MS = 60 * 60_000
/** Never more than this many guard runs that have not settled, whatever the hard expiry says. */
export const SCHEDULER_GUARD_MAX_OUTSTANDING = 2

export type SchedulerGuardResult = {
  status: 'OK' | 'ALERTED' | 'ALREADY_ALERTED' | 'NOT_EXAMINED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_IN_FLIGHT' | 'SKIPPED_STALLED'
  problems: string[]
}

/** A short stable identity for the process doing the observing: host + OS user, hashed. */
export function schedulerObserverId(): string {
  let user = ''
  try { user = os.userInfo().username } catch { /* no passwd entry: host alone */ }
  return createHash('sha256').update(`${os.hostname()}\u0000${user}`).digest('hex').slice(0, 8)
}

export function unverifiedSettingKey(observer: string): string {
  return `${READ_SYNC_SCHEDULER_ALERTED_SETTING}_unverified_${observer}`
}

export function describeSchedulerProblems(check: ReturnType<typeof checkScheduler>): string[] {
  const problems: string[] = []
  if (check.blockProblem) problems.push(`the managed crontab block cannot be trusted (${check.blockProblem})`)
  if (check.unscheduled.length > 0) problems.push(`enabled but not scheduled: ${check.unscheduled.join(', ')}`)
  if (check.disabled.length > 0) problems.push(`switched off: ${check.disabled.join(', ')}`)
  return problems
}

type GuardDeps = Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'> & {
  /** Reads the inputs on the BOUNDED client it is handed; the crontab was read before, outside any transaction. */
  readInputs: (client: ReadSyncAlarmTx, crontab: Awaited<ReturnType<typeof readCrontabForReport>>) => Promise<ReadSyncInputs>
  readCrontab?: () => Promise<Awaited<ReturnType<typeof readCrontabForReport>>>
  now?: () => Date
  observer?: string
}

export async function runSchedulerCoverageGuard(deps: GuardDeps): Promise<SchedulerGuardResult> {
  const observer = deps.observer ?? schedulerObserverId()
  const unverifiedKey = unverifiedSettingKey(observer)
  // The crontab is a child process: read it first, outside any transaction (its own 5 s kill applies).
  const crontab = await (deps.readCrontab ?? readCrontabForReport)()
  // EVERY database read of the guard, in one short transaction with a server-side statement timeout.
  const { inputs, stored } = await withStatementTimeout(deps.db, SCHEDULER_GUARD_READ_STATEMENT_TIMEOUT_MS, async (tx) => {
    const inputs = await deps.readInputs(tx, crontab)
    const rows = await tx.setting.findMany({
      where: { key: { in: [READ_SYNC_SCHEDULER_ALERTED_SETTING, unverifiedKey, READ_SYNC_SCHEDULER_STALLED_SETTING, READ_SYNC_SCHEDULER_EXPECT_UNREADABLE_SETTING] } },
      select: { key: true, value: true },
    })
    return { inputs, stored: new Map(rows.map((row) => [row.key, row.value])) }
  })
  const check = checkScheduler(inputs)
  if (!check.examined) return { status: 'NOT_EXAMINED', problems: [] }

  if (check.unreadable !== null) {
    // The scheduler could not be VERIFIED. That is not the same as broken, and this process may
    // structurally be unable to read the crontab, so: a documented suppression, and otherwise one
    // reminder per observer per UTC day. The key is the observer's own, so a healthy replica never clears
    // or reclaims it.
    if (stored.get(READ_SYNC_SCHEDULER_EXPECT_UNREADABLE_SETTING) === 'true') return { status: 'NOT_EXAMINED', problems: [] }
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
    const breachKey = `unverified:${day}`
    const prior = stored.get(unverifiedKey)
    if (prior === breachKey) return { status: 'ALREADY_ALERTED', problems: [] }
    const alert = {
      title: 'Scheduler coverage could not be verified',
      message: `The crontab could not be read by one of the processes that checks the read-sync alarm's scheduling (observer ${observer}: ${check.unreadable}), so it is not known whether the alarm jobs are scheduled. `
        + `Run ${READ_SYNC_STATUS_COMMAND} as the application user to check. This reminder repeats at most once a day per observer while its crontab stays unreadable; `
        + `if this process can never read the crontab, set the setting ${READ_SYNC_SCHEDULER_EXPECT_UNREADABLE_SETTING} to true to silence it.`,
    }
    const won = await claimBreachAndDeliver(deps, {
      stampKey: unverifiedKey, prior, breachKey, alert,
      logEntry: { stream: 'scheduler', title: alert.title, description: alert.message, metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'scheduler-unverified', observer, reason: check.unreadable.slice(0, 200) } },
    })
    return { status: won ? 'ALERTED' : 'ALREADY_ALERTED', problems: [] }
  }

  const problems = describeSchedulerProblems(check)
  if (problems.length === 0) {
    // Healthy: forget this observer's own breach state only.
    const own = [READ_SYNC_SCHEDULER_ALERTED_SETTING, unverifiedKey, READ_SYNC_SCHEDULER_STALLED_SETTING].filter((key) => stored.has(key))
    if (own.length > 0) {
      await withStatementTimeout(deps.db, SCHEDULER_GUARD_READ_STATEMENT_TIMEOUT_MS, async (tx) => {
        for (const key of own) await tx.setting.deleteMany({ where: { key } })
      })
    }
    return { status: 'OK', problems }
  }
  const breachKey = `scheduler:${problems.join('|')}`
  const prior = stored.get(READ_SYNC_SCHEDULER_ALERTED_SETTING)
  if (prior === breachKey) return { status: 'ALREADY_ALERTED', problems }
  const alert = {
    title: 'Read-sync alarm may not be running',
    message: `The jobs that keep the read-sync liveness alarm running have a problem: ${problems.join('; ')}. `
      + 'While that stands, a read feed that stops may not be reported. A job registered by an upgrade is only scheduled by '
      + `Settings > System > Scheduler > Save & Apply; check with ${READ_SYNC_STATUS_COMMAND} as the application user.`,
  }
  const won = await claimBreachAndDeliver(deps, {
    stampKey: READ_SYNC_SCHEDULER_ALERTED_SETTING,
    prior,
    breachKey,
    alert,
    logEntry: { stream: 'scheduler', title: alert.title, description: alert.message, metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'scheduler', problems } },
  })
  return { status: won ? 'ALERTED' : 'ALREADY_ALERTED', problems }
}

/** For a job that must not fail because of this check: any error is logged and swallowed. */
export async function runSchedulerCoverageGuardSafely(): Promise<SchedulerGuardResult> {
  try {
    return await runSchedulerCoverageGuard({
      ...(await liveAlarmDelivery()),
      readInputs: (client, crontab) => readReadSyncInputs({ client, crontab }),
    })
  } catch (error) {
    console.error('[read-sync-liveness] scheduler coverage guard failed:', error)
    return { status: 'FAILED', problems: [] }
  }
}

/** ONE deduplicated, hedged warning that the guard itself is not completing. Bounded like every guard read. */
export async function reportSchedulerGuardStalled(deps?: Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'>): Promise<'ALERTED' | 'ALREADY_ALERTED'> {
  const d = deps ?? await liveAlarmDelivery()
  const prior = (await withStatementTimeout(d.db, SCHEDULER_GUARD_READ_STATEMENT_TIMEOUT_MS, (tx) =>
    tx.setting.findMany({ where: { key: { in: [READ_SYNC_SCHEDULER_STALLED_SETTING] } }, select: { key: true, value: true } })))[0]?.value
  if (prior === 'stalled') return 'ALREADY_ALERTED'
  const alert = {
    title: 'Scheduler coverage check is not completing',
    message: `Earlier runs of the check that watches the read-sync alarm's scheduling have not finished, so new runs are being skipped and scheduler coverage may not be verified. This usually means the database or the crontab is not answering. Run ${READ_SYNC_STATUS_COMMAND} as the application user to check.`,
  }
  const won = await claimBreachAndDeliver(d, {
    stampKey: READ_SYNC_SCHEDULER_STALLED_SETTING, prior, breachKey: 'stalled', alert,
    logEntry: { stream: 'scheduler', title: alert.title, description: alert.message, metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'scheduler-guard-stalled' } },
  })
  return won ? 'ALERTED' : 'ALREADY_ALERTED'
}

let guardInFlight: { startedAt: number } | null = null
let outstanding = 0
let stalledReported = false

/**
 * START the guard in the background and hand back a promise that NEVER REJECTS and settles within the
 * ceiling. The CALLER MUST NOT AWAIT IT ON A RESPONSE PATH: the cron route starts it and returns.
 *
 * Re-entrancy: while a run is in flight a second call starts nothing (SKIPPED_IN_FLIGHT). The mark is
 * held until the underlying work has SETTLED, or the hard monotonic expiry. After an expiry a new run may
 * start, but NEVER while `SCHEDULER_GUARD_MAX_OUTSTANDING` runs have not settled (SKIPPED_STALLED): the
 * expiry cannot accumulate unbounded work against a stalled dependency. A cap hit raises one
 * deduplicated "not completing" warning per stall episode.
 */
export function startSchedulerCoverageGuard(
  options: {
    run?: () => Promise<SchedulerGuardResult>
    onStalled?: () => Promise<unknown>
    ceilingMs?: number
    hardExpiryMs?: number
    maxOutstanding?: number
    monotonicNow?: () => number
    unrefTimers?: boolean
  } = {},
): Promise<SchedulerGuardResult> {
  const clock = options.monotonicNow ?? (() => performance.now())
  if (guardInFlight && clock() - guardInFlight.startedAt < (options.hardExpiryMs ?? SCHEDULER_GUARD_HARD_EXPIRY_MS)) {
    return Promise.resolve({ status: 'SKIPPED_IN_FLIGHT', problems: [] })
  }
  if (outstanding >= (options.maxOutstanding ?? SCHEDULER_GUARD_MAX_OUTSTANDING)) {
    if (!stalledReported) {
      stalledReported = true
      const report = options.onStalled ?? (() => reportSchedulerGuardStalled())
      void raceWithDeadline(Promise.resolve().then(report).catch((error) => { console.error('[read-sync-liveness] stalled-guard report failed:', error) }), options.ceilingMs ?? SCHEDULER_GUARD_CEILING_MS, null, { unref: options.unrefTimers ?? true })
    }
    return Promise.resolve({ status: 'SKIPPED_STALLED', problems: [] })
  }
  const mark = { startedAt: clock() }
  guardInFlight = mark
  outstanding += 1
  const run = options.run ?? runSchedulerCoverageGuardSafely
  const underlying: Promise<SchedulerGuardResult> = (async () => {
    try { return await run() } catch (error) {
      console.error('[read-sync-liveness] scheduler coverage guard failed:', error)
      return { status: 'FAILED', problems: [] } as SchedulerGuardResult
    }
  })()
  void underlying.finally(() => {
    outstanding -= 1
    stalledReported = false
    if (guardInFlight === mark) guardInFlight = null
  })
  return raceWithDeadline(underlying, options.ceilingMs ?? SCHEDULER_GUARD_CEILING_MS, { status: 'TIMED_OUT', problems: [] } as SchedulerGuardResult, { unref: options.unrefTimers ?? true })
}

/** Test seam: forget every run. */
export function resetSchedulerCoverageGuardForTests(): void { guardInFlight = null; outstanding = 0; stalledReported = false }
