import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runHsClassificationSweep } from '@/lib/trade/hs-classification-sweep'

/**
 * Background HS-code classification sweep (6igm.4). Classifies a batch of uncoded products and
 * enqueues PENDING proposals into the review queue. Suggested schedule: every 15-30 minutes.
 */
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('hs-classify', {
    request,
    max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX,
  })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runHsClassificationSweep()
  return NextResponse.json(result)
}
