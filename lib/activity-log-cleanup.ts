import { db } from '@/lib/db'

const DEFAULTS: Record<string, number> = {
  INFO: 30,
  WARNING: 60,
  ERROR: 90,
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
    const { count } = await db.activityLog.deleteMany({
      where: { level: level as 'INFO' | 'WARNING' | 'ERROR', createdAt: { lt: cutoff } },
    })
    totalDeleted += count
  }

  return { totalDeleted, retention }
}
