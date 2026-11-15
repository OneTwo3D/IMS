import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderPushSweep } from '@/lib/domain/wms/order-push-sweep'
import { runCronWithLogging } from '@/lib/ops/cron-run'
import { cronRunResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const rateLimitErr = await enforceCronRateLimit('wms-order-push', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // The sweep takes its own per-connector advisory lock and answers `skipped` when another run holds it (a skip answers 200, never a
  // failure). It is logged as a cron run like the other cron routes.
  const run = await runCronWithLogging({
    jobName: 'wms-order-push',
    run: async () => (await runWmsOrderPushSweep()) as unknown as Record<string, unknown>,
    outcomeOf: (result) => cronOutcome('wms-order-push', result as never),
  })
  return cronRunResponse(run)
}
