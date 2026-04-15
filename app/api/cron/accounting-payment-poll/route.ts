import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { pollXeroPayments } from '@/lib/connectors/xero/payment-poller'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  if (!(await isIntegrationPluginEnabled('xero'))) {
    return NextResponse.json({ skipped: true, reason: 'Accounting plugin disabled' })
  }

  const enabled = await db.setting.findUnique({ where: { key: 'xero_payment_polling_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Accounting payment polling disabled' })
  }

  const syncEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (syncEnabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Accounting sync disabled' })
  }

  const result = await pollXeroPayments()
  return NextResponse.json(result)
}
