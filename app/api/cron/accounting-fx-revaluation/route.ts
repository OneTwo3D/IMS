import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { retiredArApFxRevaluation } from '@/lib/accounting-fx-revaluation'
import { cronResultResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

/**
 * RETIRED (owner decision 2026-11-22): Xero revalues open foreign-currency balances itself, so this job no longer runs the IMS period
 * revaluation. It still authenticates and rate-limits like every cron route, then answers a successful, named skip and touches nothing
 * (see UNREALISED_FX_REVALUATION_RETIRED_REASON). Kept so a server cron still pointing here is not met with a 404.
 */
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-fx-revaluation', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const url = new URL(request.url)
  const valuationDate = url.searchParams.get('date') ?? undefined
  const result = retiredArApFxRevaluation({ valuationDate })
  return cronResultResponse(result, { outcomeClass: cronOutcome('accounting-fx-revaluation', result) })
}
