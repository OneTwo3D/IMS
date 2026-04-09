import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { processPendingXeroSync } from '@/lib/connectors/xero/sync-processor'

// Called by cron every 5 minutes
export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr

  // Check if sync is enabled
  const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
  }

  // Check if connected
  const token = await db.xeroToken.findFirst({ select: { id: true } })
  if (!token) {
    return NextResponse.json({ skipped: true, reason: 'Xero not connected' })
  }

  const result = await processPendingXeroSync()
  return NextResponse.json(result)
}
