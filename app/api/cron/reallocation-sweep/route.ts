import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { sweepUnallocatedProcessingOrders } from '@/lib/fulfillment/reallocation-sweep'

// o3d-9lx: the payment pollers advance a paid order to PROCESSING and call autoAllocateOrder
// best-effort; if that call fails transiently the order is never retried, because the pollers only
// re-select unpaid (paidAt:null) orders. This unconditional sweep re-runs allocation for any PROCESSING
// order with outstanding demand and no shipments — a pure internal stock op, idempotent
// (already-allocated orders are pre-filtered out), so it recovers stranded allocations regardless of
// which poller (or crash) caused them. Connector-independent: it runs on every store.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('reallocation-sweep', {
    request,
    max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX,
  })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await sweepUnallocatedProcessingOrders()
  return NextResponse.json(result)
}
