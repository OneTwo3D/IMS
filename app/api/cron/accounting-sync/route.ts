import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-sync', { max: 12 })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Dispatch to the active accounting connector
  if (await isIntegrationPluginEnabled('xero')) {
    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
    }
    const token = await db.accountingToken.findFirst({ where: { connector: 'xero' }, select: { id: true } })
    if (!token) {
      return NextResponse.json({ skipped: true, reason: 'Xero not connected' })
    }
    const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
    const result = await processPendingXeroSync()
    return NextResponse.json(result)
  }

  if (await isIntegrationPluginEnabled('quickbooks')) {
    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks sync disabled' })
    }
    const token = await db.accountingToken.findFirst({ where: { connector: 'quickbooks' }, select: { id: true } })
    if (!token) {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks not connected' })
    }
    const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
    const result = await processPendingQuickBooksSync()
    return NextResponse.json(result)
  }

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled' })
}
