import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { pollXeroPayments } from '@/lib/connectors/xero/payment-poller'

// Called by cron every 15 min: curl http://localhost:3000/api/cron/xero-payment-poll
export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Check if payment polling is enabled
  const enabled = await db.setting.findUnique({ where: { key: 'xero_payment_polling_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Xero payment polling disabled' })
  }

  // Check Xero connection
  const xeroEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (xeroEnabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
  }

  const result = await pollXeroPayments()
  return NextResponse.json(result)
}
