/**
 * THE ALARM: tells the admins when a read feed has gone quiet.
 *
 * It uses the channel the WMS watchdog already uses and invents no other: one in-app notification per
 * active ADMIN (`notifyActiveAdmins`, the watchdog's own delivery, which throws rather than swallows
 * when there is nobody to tell) plus a WARNING activity-log line, claimed and delivered in ONE
 * transaction so a breach is either recorded as alerted AND delivered, or neither and retried.
 *
 * Once per breach: the dedupe stamp holds the breach it alerted on (`stale:<last success>` or `never`).
 * It is cleared when the feed is fresh again or switched off, so a RENEWED breach alerts again, and a
 * breach that continues does not repeat.
 *
 * A feed whose registry row says another job raises its alarm (the warehouse stock sync: the WMS
 * watchdog, over the same `bindingStaleAfterMs` rule this registry owns) is deliberately not handled
 * here. Everything else is.
 *
 * A feed that has NEVER recorded a success is alarmed only once its limit has elapsed since this job
 * first evaluated (`read_sync_liveness_first_evaluated_at`), because a deployment that adds the stamps
 * cannot tell "has not run yet" from "has never worked" any sooner than one cadence.
 */

import {
  READ_SYNC_ALERT_ACTION,
  READ_SYNC_FIRST_EVALUATED_SETTING,
  READ_SYNC_STREAMS,
  buildReadSyncAlert,
  readSyncAlertedSettingKey,
  type ReadSyncStreamId,
} from './read-sync-liveness-constants'
import { parseReadSyncStamp } from './read-sync-liveness'
import { assembleReadSyncReport, type ReadSyncInputs } from './read-sync-status'

export type ReadSyncAlarmLogEntry = {
  stream: ReadSyncStreamId | 'scheduler'
  title: string
  description: string
  metadata: Record<string, unknown>
}

export type ReadSyncAlarmTx = {
  setting: {
    /** Insert-if-absent: `count` is 1 only for the transaction whose insert took effect. */
    createMany(args: { data: Array<{ key: string; value: string }>; skipDuplicates: true }): Promise<{ count: number }>
    /** Conditional write: `count` is 1 only if the row still held `where.value` when this transaction took its lock. */
    updateMany(args: { where: { key: string; value: string }; data: { value: string } }): Promise<{ count: number }>
  }
}

export type ReadSyncAlarmDb = {
  setting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>>
    upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<unknown>
    deleteMany(args: { where: { key: string } }): Promise<unknown>
  }
  $transaction<T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>): Promise<T>
}

export type ReadSyncAlarmDeps = {
  db: ReadSyncAlarmDb
  now: Date
  readInputs: () => Promise<ReadSyncInputs>
  /** Deliver to every active admin inside the claim transaction; must THROW when nobody can be told. */
  notifyAdmins: (tx: ReadSyncAlarmTx, title: string, message: string, actionUrl: string) => Promise<void>
  /** Write the WARNING activity entry INSIDE the claim transaction; must THROW if it cannot, so the claim rolls back and the breach is retried. */
  logWarning: (tx: ReadSyncAlarmTx, entry: ReadSyncAlarmLogEntry) => Promise<void>
}

export type ReadSyncAlarmResult = {
  status: 'SUCCEEDED' | 'FAILED'
  evaluated: number
  alerted: ReadSyncStreamId[]
  deliveryFailures: number
  reason?: string
}

/** Streams whose alert belongs to another job, read from the registry so no connector is named here. */
const ALARMED_ELSEWHERE: ReadonlySet<ReadSyncStreamId> = new Set<ReadSyncStreamId>(
  READ_SYNC_STREAMS.filter((def) => def.alarm !== 'read-sync-liveness').map((def) => def.id),
)

/**
 * CLAIM, DELIVER AND RECORD IN ONE TRANSACTION, AND DELIVER ONLY IF THIS TRANSACTION WON THE CLAIM.
 * The claim is a conditional write against the value read earlier: an insert-if-absent when no breach
 * was recorded, otherwise an update that matches only if the row still holds what was read. Two runs
 * racing over the same breach take the row's lock in turn; the second finds the first's value (or its
 * row) and its write matches nothing, so it delivers nothing. The activity entry is written in the same
 * transaction, so a failed write rolls the claim back and the breach is retried rather than being
 * marked alerted with no record of it. Returns whether this call delivered.
 */
export async function claimBreachAndDeliver(
  deps: Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'>,
  claim: { stampKey: string; prior: string | undefined; breachKey: string; alert: { title: string; message: string }; logEntry: ReadSyncAlarmLogEntry },
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    const claimed = claim.prior === undefined
      ? await tx.setting.createMany({ data: [{ key: claim.stampKey, value: claim.breachKey }], skipDuplicates: true })
      : await tx.setting.updateMany({ where: { key: claim.stampKey, value: claim.prior }, data: { value: claim.breachKey } })
    if (claimed.count !== 1) return false
    await deps.notifyAdmins(tx, claim.alert.title, claim.alert.message, '/sync')
    await deps.logWarning(tx, claim.logEntry)
    return true
  })
}

export async function runReadSyncLivenessAlarm(deps: ReadSyncAlarmDeps): Promise<ReadSyncAlarmResult> {
  const { db, now } = deps
  const inputs = await deps.readInputs()
  const report = assembleReadSyncReport(inputs, now)

  const entries = report.entries.filter((entry) => !ALARMED_ELSEWHERE.has(entry.stream))
  const stampKeys = [READ_SYNC_FIRST_EVALUATED_SETTING, ...entries.map((entry) => readSyncAlertedSettingKey(entry.stream))]
  const stored = new Map((await db.setting.findMany({ where: { key: { in: stampKeys } }, select: { key: true, value: true } })).map((row) => [row.key, row.value]))

  // The first-evaluation anchor is written once and never moved.
  let trackedSince = parseReadSyncStamp(stored.get(READ_SYNC_FIRST_EVALUATED_SETTING))
  if (trackedSince === null) {
    trackedSince = now
    await db.setting.upsert({
      where: { key: READ_SYNC_FIRST_EVALUATED_SETTING },
      create: { key: READ_SYNC_FIRST_EVALUATED_SETTING, value: now.toISOString() },
      update: { value: now.toISOString() },
    })
  }

  const alerted: ReadSyncStreamId[] = []
  let deliveryFailures = 0

  for (const entry of entries) {
    const stampKey = readSyncAlertedSettingKey(entry.stream)
    if (entry.state === 'fresh' || entry.state === 'off') {
      // Healed or switched off: forget the breach so a renewed one alerts again.
      if (stored.has(stampKey)) await db.setting.deleteMany({ where: { key: stampKey } })
      continue
    }
    const maxAgeMs = entry.maxAgeMs as number
    if (entry.state === 'never' && now.getTime() - trackedSince.getTime() < maxAgeMs) continue

    const breachKey = entry.state === 'stale' ? `stale:${entry.lastSuccessAt}` : 'never'
    if (stored.get(stampKey) === breachKey) continue

    const alert = buildReadSyncAlert({
      stream: entry.stream,
      state: entry.state,
      lastSuccessAt: entry.lastSuccessAt,
      maxAgeMs,
      trackedSince: trackedSince.toISOString(),
      futureTimestamp: entry.futureTimestamp,
    })
    const logEntry: ReadSyncAlarmLogEntry = {
      stream: entry.stream,
      title: alert.title,
      description: alert.message,
      metadata: {
        action: READ_SYNC_ALERT_ACTION,
        stream: entry.stream,
        state: entry.state,
        lastSuccessAt: entry.lastSuccessAt,
        maxAgeMs,
        trackedSince: trackedSince.toISOString(),
      },
    }
    // CLAIM, DELIVER AND RECORD IN ONE TRANSACTION, AND DELIVER ONLY IF THIS TRANSACTION WON THE CLAIM.
    // The claim is a conditional write against the value read above: an insert-if-absent when no breach
    // was recorded, otherwise an update that matches only if the row still holds what was read. Two runs
    // of the job racing over the same breach take the row's lock in turn; the second finds the first's
    // value (or its row) and its write matches nothing, so it delivers nothing. The activity entry is
    // written in the same transaction, so a failed write rolls the claim back and the breach is retried
    // rather than being marked alerted with no record of it.
    try {
      const won = await claimBreachAndDeliver(deps, { stampKey, prior: stored.get(stampKey), breachKey, alert, logEntry })
      if (won) alerted.push(entry.stream)
    } catch (error) {
      deliveryFailures += 1
      console.error(`[read-sync-liveness] alert delivery failed for ${entry.stream}:`, error)
    }
  }

  if (deliveryFailures > 0) {
    return { status: 'FAILED', evaluated: entries.length, alerted, deliveryFailures, reason: `${deliveryFailures} alert(s) could not be delivered` }
  }
  return { status: 'SUCCEEDED', evaluated: entries.length, alerted, deliveryFailures }
}

/** The real delivery wiring, shared with the scheduler guard: the watchdog's own notify, and a transactional activity write. */
export async function liveAlarmDelivery(): Promise<Pick<ReadSyncAlarmDeps, 'db' | 'notifyAdmins' | 'logWarning'>> {
  const { db } = await import('@/lib/db')
  const { notifyActiveAdmins } = await import('@/lib/domain/wms/watchdog-sweep')
  return {
    db: db as unknown as ReadSyncAlarmDb,
    notifyAdmins: (tx, title, message, actionUrl) => notifyActiveAdmins(tx as never, title, message, actionUrl),
    logWarning: async (tx, entry) => {
      // Not logActivity(): that swallows its own failures, and a swallowed failure here would mark the
      // breach alerted with nothing recorded. Same redaction, written on the claim's transaction.
      const { redactActivityLogText, sanitizeActivityLogMetadata } = await import('@/lib/activity-log')
      await (tx as unknown as { activityLog: { create(args: unknown): Promise<unknown> } }).activityLog.create({
        data: {
          entityType: 'SYNC',
          action: READ_SYNC_ALERT_ACTION,
          tag: 'sync',
          level: 'WARNING',
          description: redactActivityLogText(entry.description),
          metadata: sanitizeActivityLogMetadata(entry.metadata),
        },
      })
    },
  }
}

/** The real wiring of the alarm job. */
export async function runReadSyncLivenessAlarmLive(now: Date = new Date()): Promise<ReadSyncAlarmResult> {
  const { readReadSyncInputs } = await import('./read-sync-status')
  return runReadSyncLivenessAlarm({ ...(await liveAlarmDelivery()), now, readInputs: readReadSyncInputs })
}
