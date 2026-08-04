import { db } from '@/lib/db'
import { DIRECT_CREATE_PENDING_ACTION } from '@/lib/fulfillment/pre-fulfilment-reallocation'

const DEFAULTS: Record<string, number> = {
  INFO: 30,
  WARNING: 60,
  ERROR: 90,
}
/**
 * Actions exempt from retention, because they are STATE rather than history.
 *
 * A direct-create marker is an open obligation: it says an order entered fulfilment and its
 * allocation coverage has not been verified yet. Deleting it does not age out a record — it
 * silently discharges the obligation, and the resolver then reads "no marker" as "already
 * resolved" and can never write the shortfall record (o3d-z82a, Codex review).
 *
 * Anything added here must be a row that something else is responsible for CLEARING. A marker
 * that is resolved is deleted by the resolver, so this exempts only ones still outstanding.
 *
 * The predicate is `<> ALL`, NOT `<> ANY`. `action <> ANY(ARRAY['a','b'])` is true when the
 * action differs from AT LEAST ONE element, so `'a' <> 'b'` alone satisfies it and a row whose
 * action IS exempt gets deleted anyway. With one entry the two forms agree, which is exactly
 * what makes it a landmine: it would work until the day someone added a second action.
 */
const RETAINED_ACTIONS = [DIRECT_CREATE_PENDING_ACTION]

const DELETE_BATCH_SIZE = 10_000
const DEFAULT_CRON_RUN_RETENTION_DAYS = 90

export type CronRunCleanupClient = {
  cronRun: {
    deleteMany(args: unknown): Promise<{ count: number }>
  }
}

async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

/**
 * Purge activity log entries older than their retention period.
 * Retention days are configurable via settings:
 *   activity_log_retention_info, activity_log_retention_warning, activity_log_retention_error
 * Call this on a daily schedule (e.g. cron or API route).
 */
export async function purgeExpiredActivityLogs() {
  const [infoVal, warnVal, errorVal] = await Promise.all([
    getSetting('activity_log_retention_info'),
    getSetting('activity_log_retention_warning'),
    getSetting('activity_log_retention_error'),
  ])

  const retention: Record<string, number> = {
    INFO: infoVal ? parseInt(infoVal, 10) : DEFAULTS.INFO,
    WARNING: warnVal ? parseInt(warnVal, 10) : DEFAULTS.WARNING,
    ERROR: errorVal ? parseInt(errorVal, 10) : DEFAULTS.ERROR,
  }

  const now = Date.now()
  let totalDeleted = 0

  for (const [level, days] of Object.entries(retention)) {
    if (days <= 0) continue // 0 = keep forever
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000)
    for (;;) {
      const rows = await db.$queryRaw<Array<{ count: number }>>`
        WITH deleted AS (
          DELETE FROM "activity_logs"
          WHERE id IN (
            SELECT id
            FROM "activity_logs"
            WHERE level = ${level}::"ActivityLogLevel"
              AND "createdAt" < ${cutoff}
              AND action <> ALL(${RETAINED_ACTIONS}::text[])
            ORDER BY "createdAt" ASC
            LIMIT ${DELETE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `
      const batchDeleted = rows[0]?.count ?? 0
      totalDeleted += batchDeleted
      if (batchDeleted < DELETE_BATCH_SIZE) break
    }
  }

  return { totalDeleted, retention }
}

export async function purgeExpiredCronRuns(
  options: {
    client?: CronRunCleanupClient
    now?: Date
    retentionDays?: number
  } = {},
) {
  const retentionDays = Math.floor(options.retentionDays ?? DEFAULT_CRON_RUN_RETENTION_DAYS)
  if (retentionDays <= 0) return { deleted: 0, retentionDays }

  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const result = await (options.client ?? db).cronRun.deleteMany({
    where: {
      startedAt: { lt: cutoff },
    },
  })

  return { deleted: result.count, retentionDays }
}
