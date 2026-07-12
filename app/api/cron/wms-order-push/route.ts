import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderPushSweep } from '@/lib/domain/wms/order-push-sweep'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const rateLimitErr = await enforceCronRateLimit('wms-order-push', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsOrderPushSweep()
  return NextResponse.json(result)
}
