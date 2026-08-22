import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { sweepUnallocatedProcessingOrders } from '@/lib/fulfillment/reallocation-sweep'
import { sweepUnresolvedDirectCreateMarkers } from '@/lib/fulfillment/pre-fulfilment-reallocation'

/**
 * The wall-clock budget for the whole tick, well inside the job's 15-minute cadence.
 *
 * The allocation sweep is bounded by its page size and cannot be interrupted safely — its cursor
 * advances over the whole batch, so stopping mid-batch would skip the remainder for a full
 * rotation. What it spends is therefore taken OFF the marker sweep's budget rather than added to
 * it, which is what keeps the endpoint's total time bounded rather than merely each half of it.
 */
const CRON_BUDGET_MS = 300_000

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

  const startedAt = Date.now()
  const failures: Record<string, string> = {}

  // o3d-z82a, Codex review r5: the two passes are INDEPENDENT, and each failure is caught here
  // rather than allowed to propagate. Sequencing them with a bare `await` meant a throw in the
  // allocation sweep skipped the marker sweep entirely — so the only mechanism that bounds the
  // marker retention exemption stopped running precisely when the system was unhealthy, which is
  // when markers accumulate fastest. The endpoint still REPORTS the failure — a throw used to
  // surface as a 500, and turning that into a silent 200 would trade one regression for another —
  // it just no longer lets one pass cancel the other.
  let result: Awaited<ReturnType<typeof sweepUnallocatedProcessingOrders>> | null = null
  try {
    result = await sweepUnallocatedProcessingOrders()
  } catch (error) {
    failures.reallocationSweep = error instanceof Error ? error.message : String(error)
    console.error('[reallocation-sweep] allocation pass failed:', error)
  }

  // The same tick also finishes the coverage question for orders CREATED directly at
  // PICKING / PACKING, which the sweep above cannot select and which no status transition ever
  // examines. It is the bound on the activity-log retention exemption those markers rely on.
  //
  // Whatever the pass above spent comes out of this one's budget; a zero remainder still resolves
  // one marker, so a chronically slow allocation pass throttles marker recovery but can never
  // stop it.
  let directCreateMarkers: Awaited<ReturnType<typeof sweepUnresolvedDirectCreateMarkers>> | null = null
  try {
    directCreateMarkers = await sweepUnresolvedDirectCreateMarkers({
      budgetMs: Math.max(0, CRON_BUDGET_MS - (Date.now() - startedAt)),
    })
  } catch (error) {
    failures.directCreateMarkerSweep = error instanceof Error ? error.message : String(error)
    console.error('[reallocation-sweep] direct-create marker pass failed:', error)
  }

  const failed = Object.keys(failures).length > 0
  return NextResponse.json(
    { ...(result ?? {}), directCreateMarkers, ...(failed ? { ok: false, failures } : {}) },
    { status: failed ? 500 : 200 },
  )
}
