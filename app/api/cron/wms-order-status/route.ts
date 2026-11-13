import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderStatusSweep } from '@/lib/domain/wms/order-status-sweep'
import { cronResultResponse } from '@/lib/ops/cron-response'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const rateLimitErr = await enforceCronRateLimit('wms-order-status', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsOrderStatusSweep()
  return cronResultResponse(result)
}
