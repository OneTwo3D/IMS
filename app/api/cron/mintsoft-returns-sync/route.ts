import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runMintsoftReturnsSync } from '@/lib/connectors/mintsoft/sync/returns-sync'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { cronResultResponse, cronSkippedResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-returns-sync', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return cronSkippedResponse('Mintsoft plugin disabled')
  }

  const result = await runMintsoftReturnsSync('cron')
  return cronResultResponse(result, { outcomeClass: cronOutcome('mintsoft-returns-sync', result) })
}
