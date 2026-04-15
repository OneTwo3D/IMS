import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { processPendingXeroSync } from '@/lib/connectors/xero/sync-processor'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  if (!(await isIntegrationPluginEnabled('xero'))) {
    return NextResponse.json({ skipped: true, reason: 'Accounting plugin disabled' })
  }

  const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Accounting sync disabled' })
  }

  const token = await db.accountingToken.findFirst({ select: { id: true } })
  if (!token) {
    return NextResponse.json({ skipped: true, reason: 'Accounting connector not connected' })
  }

  const result = await processPendingXeroSync()
  return NextResponse.json(result)
}
