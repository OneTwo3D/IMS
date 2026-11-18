import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { purgeExpiredActivityLogs, purgeExpiredCronRuns } from '@/lib/activity-log-cleanup'
import { purgeExpiredDemandHistory } from '@/lib/connectors/woocommerce/sync/initial-import'
import { purgeExpiredData } from '@/lib/data-retention'
import { purgeExpiredWmsMutationEvents, WMS_MUTATION_EVENT_RETENTION_DAYS } from '@/lib/domain/wms/mutation-audit'
import { drainOrderAttachmentFileDeletions } from '@/lib/domain/order-attachments'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { cronResultResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

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

  // Attachment files owed a deletion (an erasure or a draft-order delete whose unlink failed or was interrupted): retried here until gone.
  const attachmentFiles = await drainOrderAttachmentFileDeletions()
  if (attachmentFiles.failed.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'attachment_files_not_removed',
      tag: 'system',
      level: 'ERROR',
      description: 'Order attachment files owed a deletion could not be removed; they stay queued',
      metadata: { storedNames: attachmentFiles.failed },
    })
  }

  const body = { totalDeleted, retention, demandDeleted, cronRuns, dataRetention, wmsMutationEvents, attachmentFiles }
  return cronResultResponse(body, { outcomeClass: cronOutcome('activity-cleanup', body) })
}
