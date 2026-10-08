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

import { claimBreachAndDeliver, liveAlarmDelivery, type ReadSyncAlarmDeps } from './read-sync-liveness-alarm'
import { READ_SYNC_ALERT_ACTION, READ_SYNC_STATUS_COMMAND } from './read-sync-liveness-constants'
import { checkScheduler, readReadSyncInputs, type ReadSyncInputs } from './read-sync-status'

export const READ_SYNC_SCHEDULER_ALERTED_SETTING = 'read_sync_scheduler_alerted'

export type SchedulerGuardResult = {
  status: 'OK' | 'ALERTED' | 'ALREADY_ALERTED' | 'NOT_EXAMINED' | 'FAILED'
  problems: string[]
}

export function describeSchedulerProblems(check: ReturnType<typeof checkScheduler>): string[] {
  const problems: string[] = []
  if (check.blockProblem) problems.push(`the managed crontab block cannot be trusted (${check.blockProblem})`)
  if (check.unscheduled.length > 0) problems.push(`enabled but not scheduled: ${check.unscheduled.join(', ')}`)
  if (check.disabled.length > 0) problems.push(`switched off: ${check.disabled.join(', ')}`)
  return problems
}

export async function runSchedulerCoverageGuard(deps: Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'> & { readInputs: () => Promise<ReadSyncInputs> }): Promise<SchedulerGuardResult> {
  const check = checkScheduler(await deps.readInputs())
  if (!check.examined || check.unreadable !== null) return { status: 'NOT_EXAMINED', problems: [] }
  const problems = describeSchedulerProblems(check)
  const stored = (await deps.db.setting.findMany({ where: { key: { in: [READ_SYNC_SCHEDULER_ALERTED_SETTING] } }, select: { key: true, value: true } }))[0]?.value
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
