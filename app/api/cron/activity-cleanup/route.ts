import { NextResponse } from 'next/server'
import { purgeExpiredActivityLogs } from '@/lib/activity-log-cleanup'
import { logActivity } from '@/lib/activity-log'

// Called daily by cron: curl http://localhost:3000/api/cron/activity-cleanup
export async function GET() {
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

  return NextResponse.json({ totalDeleted, retention })
}
