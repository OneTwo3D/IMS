import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderPushSweep } from '@/lib/domain/wms/order-push-sweep'
import { cronResultResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const rateLimitErr = await enforceCronRateLimit('wms-order-push', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsOrderPushSweep()
  return cronResultResponse(result, { outcomeClass: cronOutcome('wms-order-push', result) })
}
