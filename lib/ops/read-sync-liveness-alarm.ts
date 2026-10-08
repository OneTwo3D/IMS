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

export type ReadSyncAlarmTx = {
  setting: {
    upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<unknown>
  }
}

export type ReadSyncAlarmDb = {
  setting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>>
    upsert: ReadSyncAlarmTx['setting']['upsert']
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
  logWarning: (entry: { stream: ReadSyncStreamId; title: string; description: string; metadata: Record<string, unknown> }) => Promise<void>
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
    try {
      await db.$transaction(async (tx) => {
        await tx.setting.upsert({
          where: { key: stampKey },
          create: { key: stampKey, value: breachKey },
          update: { value: breachKey },
        })
        await deps.notifyAdmins(tx, alert.title, alert.message, '/sync')
      })
    } catch (error) {
      deliveryFailures += 1
      console.error(`[read-sync-liveness] alert delivery failed for ${entry.stream}:`, error)
      continue
    }
    alerted.push(entry.stream)
    await deps.logWarning({
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
    })
  }

  if (deliveryFailures > 0) {
    return { status: 'FAILED', evaluated: entries.length, alerted, deliveryFailures, reason: `${deliveryFailures} alert(s) could not be delivered` }
  }
  return { status: 'SUCCEEDED', evaluated: entries.length, alerted, deliveryFailures }
}

/** The real wiring: the shared database, the watchdog's own delivery, the activity log. */
export async function runReadSyncLivenessAlarmLive(now: Date = new Date()): Promise<ReadSyncAlarmResult> {
  const { db } = await import('@/lib/db')
  const { logActivity } = await import('@/lib/activity-log')
  const { notifyActiveAdmins } = await import('@/lib/domain/wms/watchdog-sweep')
  const { readReadSyncInputs } = await import('./read-sync-status')
  return runReadSyncLivenessAlarm({
    db: db as unknown as ReadSyncAlarmDb,
    now,
    readInputs: readReadSyncInputs,
    notifyAdmins: (tx, title, message, actionUrl) => notifyActiveAdmins(tx as never, title, message, actionUrl),
    logWarning: async (entry) => {
      await logActivity({
        entityType: 'SYNC',
        action: READ_SYNC_ALERT_ACTION,
        tag: 'sync',
        level: 'WARNING',
        description: entry.description,
        metadata: entry.metadata as never,
        resolveUser: false,
      })
    },
  })
}
