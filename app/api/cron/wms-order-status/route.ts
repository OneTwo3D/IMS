import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderStatusSweep } from '@/lib/domain/wms/order-status-sweep'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const rateLimitErr = await enforceCronRateLimit('wms-order-status', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsOrderStatusSweep()
  return NextResponse.json(result)
}
