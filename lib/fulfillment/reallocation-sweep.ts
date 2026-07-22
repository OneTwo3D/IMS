import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync } from '@/lib/shopping'
import {
  selectOrdersNeedingAllocation,
  type CoverageOrder,
} from '@/lib/fulfillment/order-allocation-coverage'

// Bound the scan so one tick can't load an unbounded number of orders; the sweep runs periodically, so
// any residue is picked up next tick. A limitReached run is logged (never silently truncated).
const DEFAULT_SWEEP_LIMIT = 200

// autoAllocateOrder reports these via { success:false, error } for orders that simply can't be covered
// right now (a genuine backorder) or already have shipments — expected, not a failure to log.
const BENIGN_ALLOC_ERRORS = new Set([
  'No stock available for allocation',
  'Order has existing shipments; reallocation refused',
])

type SweepCandidate = CoverageOrder & {
  orderNumber: string | null
  externalOrderNumber: string | null
}

type AllocResult = {
  success: boolean
  error?: string
  allocationCount?: number
  syncProductIds?: string[]
}

export type ReallocationSweepResult = {
  scanned: number
  needing: number
  allocated: number
  errors: number
  limitReached: boolean
}

export interface ReallocationSweepDeps {
  loadCandidates: (limit: number) => Promise<SweepCandidate[]>
  selectNeedingAllocation: (candidates: SweepCandidate[]) => Promise<SweepCandidate[]>
  autoAllocateOrder: (
    orderId: string,
    opts: { internalBypassToken: symbol; deferStockSync: boolean; refuseIfShipmentsExist: boolean },
  ) => Promise<AllocResult>
  enqueueStockSync: (productIds: string[], reason: 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL') => Promise<unknown>
  logActivity: typeof logActivity
}

async function defaultLoadCandidates(limit: number): Promise<SweepCandidate[]> {
  // PROCESSING orders with no Shipment (reallocating a shipped order would decrement stock against
  // stale ShipmentLines). Oldest first, so the longest-waiting customer is retried before the cap.
  return db.salesOrder.findMany({
    where: { status: 'PROCESSING', shipments: { none: {} } },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

/**
 * Periodic backstop that re-runs allocation for PROCESSING sales orders left with outstanding demand
 * (o3d-9lx). The payment pollers advance a paid order PENDING_PAYMENT->PROCESSING and then call
 * autoAllocateOrder best-effort; if that call fails transiently the order is never retried, because the
 * pollers only re-select unpaid (paidAt:null) orders. This sweep is gated on ALLOCATION state, not
 * payment state: any PROCESSING order whose ordered qty still exceeds its OrderAllocation coverage is
 * re-attempted. It is a pure internal stock operation — idempotent (fully-allocated orders are
 * pre-filtered out, so nothing is churned) and connector-independent — so it catches stranded
 * allocations regardless of which poller (or crash) caused them.
 */
export async function sweepUnallocatedProcessingOrders(
  opts: { limit?: number; deps?: Partial<ReallocationSweepDeps> } = {},
): Promise<ReallocationSweepResult> {
  const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT
  const deps: ReallocationSweepDeps = {
    loadCandidates: defaultLoadCandidates,
    selectNeedingAllocation: (candidates) => selectOrdersNeedingAllocation(candidates),
    autoAllocateOrder: async (orderId, o) =>
      (await import('@/app/actions/allocation')).autoAllocateOrder(orderId, o),
    enqueueStockSync,
    logActivity,
    ...opts.deps,
  }

  const result: ReallocationSweepResult = {
    scanned: 0,
    needing: 0,
    allocated: 0,
    errors: 0,
    limitReached: false,
  }

  const candidates = await deps.loadCandidates(limit)
  result.scanned = candidates.length
  result.limitReached = candidates.length >= limit
  if (candidates.length === 0) return result

  const needing = await deps.selectNeedingAllocation(candidates)
  result.needing = needing.length

  const syncProductIds = new Set<string>()
  for (const order of needing) {
    const orderRef = order.orderNumber ?? order.externalOrderNumber ?? order.id.slice(0, 8)
    try {
      const res = await deps.autoAllocateOrder(order.id, {
        internalBypassToken: INTERNAL_ACTION_BYPASS,
        deferStockSync: true,
        refuseIfShipmentsExist: true,
      })
      for (const pid of res.syncProductIds ?? []) syncProductIds.add(pid)
      if (res.success && (res.allocationCount ?? 0) > 0) {
        result.allocated += 1
      } else if (res.error && !BENIGN_ALLOC_ERRORS.has(res.error)) {
        result.errors += 1
        await deps.logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'reallocation_sweep_failed',
          tag: 'sales',
          level: 'ERROR',
          description: `Reallocation sweep failed for ${orderRef}: ${res.error}`,
          resolveUser: false,
        })
      }
    } catch (e) {
      result.errors += 1
      await deps.logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'reallocation_sweep_failed',
        tag: 'sales',
        level: 'ERROR',
        description: `Reallocation sweep failed for ${orderRef}: ${e instanceof Error ? e.message : String(e)}`,
        resolveUser: false,
      })
    }
  }

  // Coalesce the per-order storefront syncs (each autoAllocateOrder deferred its own) into one push.
  if (syncProductIds.size > 0) {
    try {
      await deps.enqueueStockSync([...syncProductIds], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
  }

  if (result.allocated > 0) {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: 'reallocation-sweep',
      action: 'reallocation_sweep_allocated',
      tag: 'sales',
      level: 'INFO',
      description: `Reallocation sweep allocated ${result.allocated} previously-stranded order(s)`,
      resolveUser: false,
    })
  }

  // Surface a capped run so a persistent backlog larger than one tick isn't invisible.
  if (result.limitReached) {
    await deps.logActivity({
      entityType: 'SALES_ORDER',
      entityId: 'reallocation-sweep',
      action: 'reallocation_sweep_capped',
      tag: 'sales',
      level: 'WARNING',
      description: `Reallocation sweep hit its ${limit}-order scan cap; remaining PROCESSING orders retry next tick`,
      resolveUser: false,
    })
  }

  return result
}
