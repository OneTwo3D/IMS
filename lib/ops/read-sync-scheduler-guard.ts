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
 * An unreadable crontab raises nothing: a web process may legitimately be unable to read it, and a
 * permanent alert about that would teach admins to ignore the channel. `read-sync:status` still exits 6
 * for it.
 */

import { raceWithDeadline } from './bounded-wait'
import { claimBreachAndDeliver, liveAlarmDelivery, type ReadSyncAlarmDeps } from './read-sync-liveness-alarm'
import { READ_SYNC_ALERT_ACTION, READ_SYNC_STATUS_COMMAND } from './read-sync-liveness-constants'
import { checkScheduler, readReadSyncInputs, type ReadSyncInputs } from './read-sync-status'

export const READ_SYNC_SCHEDULER_ALERTED_SETTING = 'read_sync_scheduler_alerted'

/** Ceiling on how long one guard run's PROMISE is awaited (crontab read 5 s, DB reads, claim transaction 15 s). */
export const SCHEDULER_GUARD_CEILING_MS = 30_000
/**
 * The in-flight mark is held until the underlying work has actually settled, or this much MONOTONIC time
 * has passed since it started, whichever comes first. Repeated 15-minute invocations therefore cannot stack
 * runs against a stalled dependency; a run stuck for an hour is written off so the guard is not disabled for ever.
 */
export const SCHEDULER_GUARD_HARD_EXPIRY_MS = 60 * 60_000
/** An unverifiable scheduler (unreadable crontab) is reminded about at most once per UTC day. */
export const SCHEDULER_UNVERIFIED_REMINDER = 'daily'

export type SchedulerGuardResult = {
  status: 'OK' | 'ALERTED' | 'ALREADY_ALERTED' | 'NOT_EXAMINED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_IN_FLIGHT'
  problems: string[]
}

export function describeSchedulerProblems(check: ReturnType<typeof checkScheduler>): string[] {
  const problems: string[] = []
  if (check.blockProblem) problems.push(`the managed crontab block cannot be trusted (${check.blockProblem})`)
  if (check.unscheduled.length > 0) problems.push(`enabled but not scheduled: ${check.unscheduled.join(', ')}`)
  if (check.disabled.length > 0) problems.push(`switched off: ${check.disabled.join(', ')}`)
  return problems
}

export async function runSchedulerCoverageGuard(deps: Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'> & { readInputs: () => Promise<ReadSyncInputs>; now?: () => Date }): Promise<SchedulerGuardResult> {
  const check = checkScheduler(await deps.readInputs())
  if (!check.examined) return { status: 'NOT_EXAMINED', problems: [] }
  const stored = (await deps.db.setting.findMany({ where: { key: { in: [READ_SYNC_SCHEDULER_ALERTED_SETTING] } }, select: { key: true, value: true } }))[0]?.value
  if (check.unreadable !== null) {
    // The scheduler could not be VERIFIED. That is not the same as broken, and a web process may structurally
    // be unable to read the crontab, so this is one distinct reminder per UTC day, not one per run.
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
    const breachKey = `unverified:${day}`
    if (stored === breachKey) return { status: 'ALREADY_ALERTED', problems: [] }
    const alert = {
      title: 'Scheduler coverage could not be verified',
      message: `The crontab could not be read by the process that checks the read-sync alarm's scheduling (${check.unreadable}), so it is not known whether the alarm jobs are scheduled. `
        + `Run ${READ_SYNC_STATUS_COMMAND} as the application user to check. This reminder repeats at most once a day while the crontab stays unreadable here.`,
    }
    const won = await claimBreachAndDeliver(deps, {
      stampKey: READ_SYNC_SCHEDULER_ALERTED_SETTING, prior: stored, breachKey, alert,
      logEntry: { stream: 'scheduler', title: alert.title, description: alert.message, metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'scheduler-unverified', reason: check.unreadable.slice(0, 200) } },
    })
    return { status: won ? 'ALERTED' : 'ALREADY_ALERTED', problems: [] }
  }
  const problems = describeSchedulerProblems(check)
  if (problems.length === 0) {
    if (stored !== undefined) await deps.db.setting.deleteMany({ where: { key: READ_SYNC_SCHEDULER_ALERTED_SETTING } })
    return { status: 'OK', problems }
  }
  const breachKey = `scheduler:${problems.join('|')}`
  if (stored === breachKey) return { status: 'ALREADY_ALERTED', problems }
  const alert = {
    title: 'Read-sync alarm may not be running',
    message: `The jobs that keep the read-sync liveness alarm running have a problem: ${problems.join('; ')}. `
      + 'While that stands, a read feed that stops may not be reported. A job registered by an upgrade is only scheduled by '
      + `Settings > System > Scheduler > Save & Apply; check with ${READ_SYNC_STATUS_COMMAND} as the application user.`,
  }
  const won = await claimBreachAndDeliver(deps, {
    stampKey: READ_SYNC_SCHEDULER_ALERTED_SETTING,
    prior: stored,
    breachKey,
    alert,
    logEntry: { stream: 'scheduler', title: alert.title, description: alert.message, metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'scheduler', problems } },
  })
  return { status: won ? 'ALERTED' : 'ALREADY_ALERTED', problems }
}

/** For a job that must not fail because of this check: any error is logged and swallowed. */
export async function runSchedulerCoverageGuardSafely(): Promise<SchedulerGuardResult> {
  try {
    return await runSchedulerCoverageGuard({ ...(await liveAlarmDelivery()), readInputs: readReadSyncInputs })
  } catch (error) {
    console.error('[read-sync-liveness] scheduler coverage guard failed:', error)
    return { status: 'FAILED', problems: [] }
  }
}

let guardInFlight: { startedAt: number } | null = null

/**
 * START the guard in the background and hand back a promise that NEVER REJECTS and settles within the
 * ceiling. The CALLER MUST NOT AWAIT IT ON A RESPONSE PATH: the cron route starts it and returns.
 * Re-entrancy safe: while a run is in flight a second call starts nothing and answers SKIPPED_IN_FLIGHT.
 * The mark is held until the underlying work has actually settled (or the hard monotonic expiry), NOT
 * released when the ceiling merely stops waiting, so a stalled dependency cannot collect stacked runs.
 */
export function startSchedulerCoverageGuard(
  options: { run?: () => Promise<SchedulerGuardResult>; ceilingMs?: number; hardExpiryMs?: number; monotonicNow?: () => number; unrefTimers?: boolean } = {},
): Promise<SchedulerGuardResult> {
  const clock = options.monotonicNow ?? (() => performance.now())
  if (guardInFlight && clock() - guardInFlight.startedAt < (options.hardExpiryMs ?? SCHEDULER_GUARD_HARD_EXPIRY_MS)) {
    return Promise.resolve({ status: 'SKIPPED_IN_FLIGHT', problems: [] })
  }
  const mark = { startedAt: clock() }
  guardInFlight = mark
  const run = options.run ?? runSchedulerCoverageGuardSafely
  const underlying: Promise<SchedulerGuardResult> = (async () => {
    try { return await run() } catch (error) {
      console.error('[read-sync-liveness] scheduler coverage guard failed:', error)
      return { status: 'FAILED', problems: [] } as SchedulerGuardResult
    }
  })()
  void underlying.finally(() => { if (guardInFlight === mark) guardInFlight = null })
  return raceWithDeadline(underlying, options.ceilingMs ?? SCHEDULER_GUARD_CEILING_MS, { status: 'TIMED_OUT', problems: [] } as SchedulerGuardResult, { unref: options.unrefTimers ?? true })
}

/** Test seam: forget an in-flight run. */
export function resetSchedulerCoverageGuardForTests(): void { guardInFlight = null }
