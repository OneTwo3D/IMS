import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { purgeExpiredActivityLogs, purgeExpiredCronRuns } from '@/lib/activity-log-cleanup'
import { purgeExpiredDemandHistory } from '@/lib/connectors/woocommerce/sync/initial-import'
import { purgeExpiredData } from '@/lib/data-retention'
import { purgeExpiredWmsMutationEvents, WMS_MUTATION_EVENT_RETENTION_DAYS } from '@/lib/domain/wms/mutation-audit'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('activity-cleanup', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const { totalDeleted, retention } = await purgeExpiredActivityLogs()

  if (totalDeleted > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Purged ${totalDeleted} expired activity log entries (INFO >${retention.INFO}d, WARNING >${retention.WARNING}d, ERROR >${retention.ERROR}d)`,
      metadata: { totalDeleted, retention },
    })
  }

  // Purge expired demand history (WcInitialImport records older than 12 months)
  const demandDeleted = await purgeExpiredDemandHistory()
  const cronRuns = await purgeExpiredCronRuns()

  // Data retention cleanup (archive/delete expired records)
  const dataRetention = await purgeExpiredData()

  // q66in.4.6: WMS mutation-audit timeline retention (single window).
  const wmsMutationEvents = await purgeExpiredWmsMutationEvents()
  if (wmsMutationEvents > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Purged ${wmsMutationEvents} WMS mutation-audit events older than ${WMS_MUTATION_EVENT_RETENTION_DAYS}d`,
      metadata: { wmsMutationEvents },
    })
  }

  return NextResponse.json({ totalDeleted, retention, demandDeleted, cronRuns, dataRetention, wmsMutationEvents })
}
