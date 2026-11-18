import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runProductSyncSweep } from '@/lib/products/csv-roundtrip/sync-sweep'
import { cronResultResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export const runtime = 'nodejs'

// Drains the storefront and warehouse sync that products edited by CSV owe, a few at a time (see sync-sweep.ts). It
// does not depend on any connector being enabled: with none, the marks are simply cleared, and a connector enabled later
// catches the products up on its own verify run.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('product-sync-marks', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const body = await runProductSyncSweep()
  return cronResultResponse(body, { outcomeClass: cronOutcome('product-sync-marks', body) })
}
