import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runMintsoftDispatchPoll } from '@/lib/connectors/mintsoft/sync/dispatch-poll'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { cronResultResponse, cronSkippedResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-dispatch-sync', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return cronSkippedResponse('Mintsoft plugin disabled')
  }

  // The dispatch poll is Mintsoft's path (a push-primary WMS would ingest despatch via
  // webhooks instead); the
  // sweep itself is connector-agnostic and resolves the active WMS.
  const result = await runMintsoftDispatchPoll()
  return cronResultResponse(result, { outcomeClass: cronOutcome('mintsoft-dispatch-sync', result as Parameters<typeof cronOutcome<'mintsoft-dispatch-sync'>>[1]) })
}
