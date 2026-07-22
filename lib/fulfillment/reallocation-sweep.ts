import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync } from '@/lib/shopping'
import {
  selectOrdersNeedingAllocation,
  type CoverageOrder,
} from '@/lib/fulfillment/order-allocation-coverage'

// Bound the work per tick. A durable keyset cursor (below) advances across ticks so EVERY PROCESSING
// order is scanned within ceil(total/limit) runs — a stable page of permanent no-stock backorders can't
// monopolise the sweep and starve later stranded orders (o3d-9lx Codex review).
const DEFAULT_SWEEP_LIMIT = 200
const CURSOR_SETTING_KEY = 'reallocation_sweep_cursor'

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
  /** true when this tick's keyset page was full — more orders remain for the next tick. */
  hasRemainder: boolean
  /** the cursor persisted for the next run ('' means the scan wrapped back to the start). */
  nextCursor: string
}

export interface ReallocationSweepDeps {
  readCursor: () => Promise<string>
  writeCursor: (cursor: string) => Promise<void>
  /** Up to `limit + 1` PROCESSING, shipment-free orders with id > cursor, ordered by id ascending. */
  loadCandidatesPage: (cursor: string, limit: number) => Promise<SweepCandidate[]>
  selectNeedingAllocation: (candidates: SweepCandidate[]) => Promise<SweepCandidate[]>
  autoAllocateOrder: (
    orderId: string,
    opts: { internalBypassToken: symbol; deferStockSync: boolean; refuseIfShipmentsExist: boolean },
  ) => Promise<AllocResult>
  enqueueStockSync: (productIds: string[], reason: 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL') => Promise<unknown>
  logActivity: typeof logActivity
}

async function defaultReadCursor(): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: CURSOR_SETTING_KEY } })
  return row?.value ?? ''
}

async function defaultWriteCursor(cursor: string): Promise<void> {
  await db.setting.upsert({
    where: { key: CURSOR_SETTING_KEY },
    create: { key: CURSOR_SETTING_KEY, value: cursor },
    update: { value: cursor },
  })
}

async function defaultLoadCandidatesPage(cursor: string, limit: number): Promise<SweepCandidate[]> {
  // Keyset pagination by id (id > cursor). Shipped orders are excluded — reallocating one would decrement
  // stock against stale ShipmentLines. take = limit + 1 so the caller can tell a full page (remainder
  // exists) from the final page (wrap) without a separate count.
  return db.salesOrder.findMany({
    where: {
      status: 'PROCESSING',
      shipments: { none: {} },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
    orderBy: { id: 'asc' },
    take: limit + 1,
  })
}

/**
 * Periodic backstop that re-runs allocation for PROCESSING sales orders left with outstanding demand
 * (o3d-9lx). The payment pollers advance a paid order PENDING_PAYMENT->PROCESSING and then call
 * autoAllocateOrder best-effort; if that call fails transiently the order is never retried, because the
 * pollers only re-select unpaid (paidAt:null) orders. This sweep is gated on ALLOCATION state, not
 * payment state, and walks the PROCESSING set via a durable keyset cursor so a stable page of permanent
 * backorders can't starve later stranded orders. It is a pure internal stock operation — idempotent
 * (fully-allocated orders are pre-filtered out) and connector-independent — so it catches stranded
 * allocations regardless of which poller (or crash) caused them.
 *
 * The sweep relies on the SAME under-lock allocation semantics as the shipped backorder allocator:
 * allocateSalesOrder re-reads status/refundStatus and nets refunded qty under the order lock, so a
 * concurrently CANCELLED/fully-refunded order is deallocated correctly. The stale-pre-filter edge cases
 * (a PROCESSING->ON_HOLD race under the lock; the selector counting gross vs net-of-refund demand) are
 * pre-existing to autoAllocateOrder/backorder-allocator and tracked as follow-ups (o3d-6ab: under-lock ON_HOLD guard; o3d-jby: net-of-refund selection).
 */
export async function sweepUnallocatedProcessingOrders(
  opts: { limit?: number; deps?: Partial<ReallocationSweepDeps> } = {},
): Promise<ReallocationSweepResult> {
  const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT
  const deps: ReallocationSweepDeps = {
    readCursor: defaultReadCursor,
    writeCursor: defaultWriteCursor,
    loadCandidatesPage: defaultLoadCandidatesPage,
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
    hasRemainder: false,
    nextCursor: '',
  }

  const cursor = await deps.readCursor()
  const page = await deps.loadCandidatesPage(cursor, limit)
  const hasRemainder = page.length > limit
  const batch = hasRemainder ? page.slice(0, limit) : page

  // Advance the cursor over the RAW batch (not the allocation-filtered subset) so benign no-stock
  // backorders still move the scan forward — that is what guarantees progress and prevents starvation.
  // A short/empty page wraps the cursor to '' so the next run restarts from the beginning.
  const nextCursor = hasRemainder && batch.length > 0 ? batch[batch.length - 1].id : ''
  await deps.writeCursor(nextCursor)

  result.scanned = batch.length
  result.hasRemainder = hasRemainder
  result.nextCursor = nextCursor
  if (batch.length === 0) return result

  const needing = await deps.selectNeedingAllocation(batch)
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

  return result
}
