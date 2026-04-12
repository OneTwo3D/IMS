import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { purgeExpiredActivityLogs } from '@/lib/activity-log-cleanup'
import { purgeExpiredDemandHistory } from '@/lib/connectors/woocommerce/sync/initial-import'
import { purgeExpiredData } from '@/lib/data-retention'
import { logActivity } from '@/lib/activity-log'

export async function GET(request: Request) {
  const err = verifyCron(request)
  if (err) return err
  const { totalDeleted, retention } = await purgeExpiredActivityLogs()

  if (totalDeleted > 0) {
    logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Purged ${totalDeleted} expired activity log entries (INFO >${retention.INFO}d, WARNING >${retention.WARNING}d, ERROR >${retention.ERROR}d)`,
      metadata: { totalDeleted, retention },
    })
  }

  // Purge expired demand history (WcInitialImport records older than 12 months)
  const demandDeleted = await purgeExpiredDemandHistory()

  // Data retention cleanup (archive/delete expired records)
  const dataRetention = await purgeExpiredData()

  return NextResponse.json({ totalDeleted, retention, demandDeleted, dataRetention })
}
