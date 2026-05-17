import { db } from '@/lib/db'

const DEFAULTS: Record<string, number> = {
  INFO: 30,
  WARNING: 60,
  ERROR: 90,
}
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
