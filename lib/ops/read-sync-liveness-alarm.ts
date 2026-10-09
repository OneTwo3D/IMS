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
import { parseReadSyncStamp, READ_SYNC_FUTURE_TOLERANCE_MS } from './read-sync-liveness'
import { assembleReadSyncReport, type ReadSyncInputs } from './read-sync-status'

export type ReadSyncAlarmLogEntry = {
  stream: ReadSyncStreamId | 'scheduler' | 'liveness-anchor'
  title: string
  description: string
  metadata: Record<string, unknown>
}

export type ReadSyncAlarmTx = {
  /** Present on a real transaction client; used to bound statements server-side. */
  $executeRawUnsafe?: (sql: string) => Promise<unknown>
  setting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>>
    deleteMany(args: { where: { key: string } }): Promise<unknown>
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
    updateMany(args: { where: { key: string; value: string }; data: { value: string } }): Promise<{ count: number }>
  }
  $transaction<T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>
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
  return withStatementTimeout(deps.db, ALARM_STATEMENT_TIMEOUT_MS, async (tx) => {
    const claimed = claim.prior === undefined
      ? await tx.setting.createMany({ data: [{ key: claim.stampKey, value: claim.breachKey }], skipDuplicates: true })
      : await tx.setting.updateMany({ where: { key: claim.stampKey, value: claim.prior }, data: { value: claim.breachKey } })
    if (claimed.count !== 1) return false
    await deps.notifyAdmins(tx, claim.alert.title, claim.alert.message, '/sync')
    await deps.logWarning(tx, claim.logEntry)
    return true
  })
}

/**
 * Run `fn` in a short transaction whose statements the SERVER cancels after `timeoutMs`
 * (`SET LOCAL statement_timeout`), with a bounded wait for a connection and a bounded transaction. An
 * unresponsive dependency therefore errors out instead of holding a connection indefinitely.
 */
export async function withStatementTimeout<T>(db: ReadSyncAlarmDb, timeoutMs: number, fn: (tx: ReadSyncAlarmTx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe?.(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
    return fn(tx)
  }, ALARM_TRANSACTION_BOUNDS)
}

/** The claim transaction is bounded: a stuck connection or lock cannot hold a cron run indefinitely. */
export const ALARM_STATEMENT_TIMEOUT_MS = 10_000
export const ALARM_TRANSACTION_BOUNDS = { maxWait: 5_000, timeout: 15_000 } as const

export async function runReadSyncLivenessAlarm(deps: ReadSyncAlarmDeps): Promise<ReadSyncAlarmResult> {
  const { db, now } = deps
  const inputs = await deps.readInputs()
  const report = assembleReadSyncReport(inputs, now)

  const entries = report.entries.filter((entry) => !ALARMED_ELSEWHERE.has(entry.stream))
  const stampKeys = [READ_SYNC_FIRST_EVALUATED_SETTING, ...entries.map((entry) => readSyncAlertedSettingKey(entry.stream))]
  const stored = new Map((await db.setting.findMany({ where: { key: { in: stampKeys } }, select: { key: true, value: true } })).map((row) => [row.key, row.value]))

  // The first-evaluation anchor is written once and never moved, with ONE exception: a stored value that
  // is not a time is replaced - once, by a compare-and-set on the bad value - and reported. Overwriting it
  // on every run instead would keep "tracking began" at "now" for ever, so a feed that has never
  // succeeded would never reach its limit and its alarm would never fire.
  const storedAnchor = stored.get(READ_SYNC_FIRST_EVALUATED_SETTING)
  let trackedSince = parseReadSyncStamp(storedAnchor)
  if (storedAnchor === undefined) {
    trackedSince = now
    await db.setting.upsert({
      where: { key: READ_SYNC_FIRST_EVALUATED_SETTING },
      create: { key: READ_SYNC_FIRST_EVALUATED_SETTING, value: now.toISOString() },
      update: { value: now.toISOString() },
    })
  } else if (trackedSince === null || trackedSince.getTime() > now.getTime() + READ_SYNC_FUTURE_TOLERANCE_MS) {
    const invalidWhy = trackedSince === null ? 'was not a time' : 'is in the future of this server\'s clock'
    const replaced = await db.$transaction(async (tx) => {
      const claimed = await tx.setting.updateMany({ where: { key: READ_SYNC_FIRST_EVALUATED_SETTING, value: storedAnchor }, data: { value: now.toISOString() } })
      if (claimed.count !== 1) return false
      await deps.logWarning(tx, {
        stream: 'liveness-anchor',
        title: 'Read-sync liveness start time was unreadable',
        description: `The stored start time of read-sync liveness tracking (${READ_SYNC_FIRST_EVALUATED_SETTING}) ${invalidWhy} and has been replaced with ${now.toISOString()}. Feeds that have never succeeded are alarmed only after their limit has passed since then.`,
        metadata: { action: READ_SYNC_ALERT_ACTION, kind: 'anchor-replaced', invalidValue: storedAnchor.slice(0, 80) },
      })
      return true
    }, ALARM_TRANSACTION_BOUNDS)
    if (replaced) {
      trackedSince = now
    } else {
      // Another run replaced it first: use what it persisted; never write again here.
      const reread = await db.setting.findMany({ where: { key: { in: [READ_SYNC_FIRST_EVALUATED_SETTING] } }, select: { key: true, value: true } })
      const rival = parseReadSyncStamp(reread[0]?.value)
      trackedSince = rival !== null && rival.getTime() <= now.getTime() + READ_SYNC_FUTURE_TOLERANCE_MS ? rival : now
    }
  }
  if (trackedSince === null) trackedSince = now

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
