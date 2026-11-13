import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runMintsoftProductVerify } from '@/lib/connectors/mintsoft/sync/product-sync'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { cronResultResponse } from '@/lib/ops/cron-response'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-product-verify', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return cronResultResponse({ skipped: true, reason: 'Mintsoft plugin disabled' })
  }

  const result = await runMintsoftProductVerify('cron')
  return cronResultResponse(result)
}
