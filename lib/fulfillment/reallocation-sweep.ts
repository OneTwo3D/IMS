import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync } from '@/lib/shopping'
import {
  selectOrdersNeedingAllocation,
  type CoverageOrder,
} from '@/lib/fulfillment/order-allocation-coverage'
import type { SalesOrderStatus } from '@/app/generated/prisma/client'

// Bound the work per tick. A durable keyset cursor (below) advances across ticks so EVERY PROCESSING
// order is scanned within ceil(total/limit) runs — a stable page of permanent no-stock backorders can't
// monopolise the sweep and starve later stranded orders (o3d-9lx Codex review).
const DEFAULT_SWEEP_LIMIT = 200
const CURSOR_SETTING_KEY = 'reallocation_sweep_cursor'
// Each cycle is bounded by a high-watermark id snapshotted when the cycle starts, so PROCESSING orders
// inserted ABOVE the watermark mid-cycle (a sustained influx of higher ids) can't keep every page full
// and prevent the wrap — the wrap is guaranteed once the fixed snapshot is exhausted, and rows below the
// cursor are then picked up on the next cycle (o3d-9lx Codex review).
const WATERMARK_SETTING_KEY = 'reallocation_sweep_watermark'

// The status the sweep SELECTS on, re-asserted under the order lock (o3d-6ab/o3d-lvcb). It has to
// match defaultLoadCandidatesPage's `status: 'PROCESSING'`: a wider set here would allow a write the
// selector never intended, and a narrower one would skip every candidate.
const REALLOCATION_ELIGIBLE_STATUSES = ['PROCESSING'] as const satisfies readonly SalesOrderStatus[]

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
  /** o3d-6ab: the under-lock status was no longer allocation-eligible; nothing was written. */
  skipped?: boolean
}

export type ReallocationSweepResult = {
  scanned: number
  needing: number
  allocated: number
  /** left PROCESSING between selection and the order lock — a deliberate no-op, not a failure. */
  skipped: number
  errors: number
  /** true when this tick's keyset page was full — more orders remain for the next tick. */
  hasRemainder: boolean
  /** the cursor persisted for the next run ('' means the scan wrapped back to the start). */
  nextCursor: string
}

export type SweepCursorState = { cursor: string; watermark: string }

export interface ReallocationSweepDeps {
  readState: () => Promise<SweepCursorState>
  writeState: (state: SweepCursorState) => Promise<void>
  /** The current max PROCESSING order id — the per-cycle upper id bound. '' when there are none. */
  snapshotWatermark: () => Promise<string>
  /** Up to `limit + 1` PROCESSING, shipment-free orders with cursor < id <= watermark, id ascending. */
  loadCandidatesPage: (cursor: string, watermark: string, limit: number) => Promise<SweepCandidate[]>
  selectNeedingAllocation: (candidates: SweepCandidate[]) => Promise<SweepCandidate[]>
  autoAllocateOrder: (
    orderId: string,
    opts: {
      internalBypassToken: symbol
      deferStockSync: boolean
      refuseIfShipmentsExist: boolean
      requireStatusUnderLock: readonly SalesOrderStatus[]
    },
  ) => Promise<AllocResult>
  enqueueStockSync: (productIds: string[], reason: 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL') => Promise<unknown>
  logActivity: typeof logActivity
}

async function defaultReadState(): Promise<SweepCursorState> {
  const rows = await db.setting.findMany({
    where: { key: { in: [CURSOR_SETTING_KEY, WATERMARK_SETTING_KEY] } },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return { cursor: byKey.get(CURSOR_SETTING_KEY) ?? '', watermark: byKey.get(WATERMARK_SETTING_KEY) ?? '' }
}

async function defaultWriteState(state: SweepCursorState): Promise<void> {
  await db.$transaction([
    db.setting.upsert({
      where: { key: CURSOR_SETTING_KEY },
      create: { key: CURSOR_SETTING_KEY, value: state.cursor },
      update: { value: state.cursor },
    }),
    db.setting.upsert({
      where: { key: WATERMARK_SETTING_KEY },
      create: { key: WATERMARK_SETTING_KEY, value: state.watermark },
      update: { value: state.watermark },
    }),
  ])
}

async function defaultSnapshotWatermark(): Promise<string> {
  const row = await db.salesOrder.findFirst({
    where: { status: 'PROCESSING' },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  return row?.id ?? ''
}

async function defaultLoadCandidatesPage(
  cursor: string,
  watermark: string,
  limit: number,
): Promise<SweepCandidate[]> {
  // Keyset pagination within the cycle snapshot: cursor < id <= watermark. Shipped orders are excluded —
  // reallocating one would decrement stock against stale ShipmentLines. take = limit + 1 so the caller
  // can tell a full page (remainder exists) from the final page (wrap) without a separate count.
  return db.salesOrder.findMany({
    where: {
      status: 'PROCESSING',
      shipments: { none: {} },
      ...(cursor ? { id: { gt: cursor, lte: watermark } } : { id: { lte: watermark } }),
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
 * concurrently CANCELLED/fully-refunded order is deallocated correctly. It also passes
 * requireStatusUnderLock (o3d-6ab), so a candidate that left PROCESSING between selection and the lock
 * is skipped rather than silently re-reserved.
 *
 * That guard and this sweep are only correct TOGETHER (o3d-lvcb), which is why they ship in one change:
 *   - the guard alone turns a wrong write into a LOST write on the backorder path. A stock receipt is a
 *     ONE-SHOT replenishment trigger; if allocation skips because the order was briefly ON_HOLD, the
 *     trigger is consumed and nothing re-runs allocation when the order returns to PROCESSING.
 *   - this sweep is that missing backstop: it is gated on ALLOCATION state, not on any trigger, so the
 *     order is re-selected on a later cycle and allocated then.
 *   - and this sweep WITHOUT the guard would reintroduce the very ON_HOLD race the guard closes.
 *
 * The remaining stale-pre-filter edge case (the selector counting gross vs net-of-refund demand) is
 * pre-existing to autoAllocateOrder/backorder-allocator and tracked as o3d-jby.
 */
export async function sweepUnallocatedProcessingOrders(
  opts: { limit?: number; deps?: Partial<ReallocationSweepDeps> } = {},
): Promise<ReallocationSweepResult> {
  const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT
  const deps: ReallocationSweepDeps = {
    readState: defaultReadState,
    writeState: defaultWriteState,
    snapshotWatermark: defaultSnapshotWatermark,
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
    skipped: 0,
    errors: 0,
    hasRemainder: false,
    nextCursor: '',
  }

  const state = await deps.readState()
  const cursor = state.cursor
  let watermark = state.watermark
  // Start of a new cycle (cursor cleared): snapshot the current max PROCESSING id as the fixed upper
  // bound for this cycle, so a mid-cycle influx of higher ids can't stop the wrap.
  if (!cursor) {
    watermark = await deps.snapshotWatermark()
    if (!watermark) {
      // No PROCESSING orders at all — clear any stale state and finish.
      await deps.writeState({ cursor: '', watermark: '' })
      return result
    }
  }

  const page = await deps.loadCandidatesPage(cursor, watermark, limit)
  const hasRemainder = page.length > limit
  const batch = hasRemainder ? page.slice(0, limit) : page

  // The cursor advances over the RAW batch (not the allocation-filtered subset) so benign no-stock
  // backorders still move the scan forward — that is what guarantees progress. A full page continues the
  // cycle from the last-scanned id; a short/empty page means the snapshot is exhausted, so wrap (clear
  // both, re-snapshot next run). The state is persisted AFTER the batch is processed, so a mid-batch
  // throw/crash leaves the cursor unchanged and the batch is retried idempotently next tick.
  const nextState: SweepCursorState =
    hasRemainder && batch.length > 0
      ? { cursor: batch[batch.length - 1].id, watermark }
      : { cursor: '', watermark: '' }

  result.scanned = batch.length
  result.hasRemainder = hasRemainder
  result.nextCursor = nextState.cursor

  if (batch.length === 0) {
    await deps.writeState(nextState)
    return result
  }

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
        // o3d-6ab/o3d-lvcb: candidates are selected as PROCESSING OUTSIDE the order lock. Without
        // this the sweep would re-reserve stock for an order that moved to ON_HOLD in the window —
        // exactly the race o3d-6ab exists to close, reintroduced through the sweep's own door.
        requireStatusUnderLock: REALLOCATION_ELIGIBLE_STATUSES,
      })
      for (const pid of res.syncProductIds ?? []) syncProductIds.add(pid)
      if (res.success && (res.allocationCount ?? 0) > 0) {
        result.allocated += 1
      } else if (res.skipped) {
        // The order left PROCESSING between selection and the lock. Nothing was written. It is not
        // an error and not lost: the sweep is cyclic, so if it returns to PROCESSING while still
        // under-allocated a later cycle re-selects it. Counted so a persistently skipped order is
        // visible in telemetry rather than being an invisible no-op (o3d-lvcb).
        result.skipped += 1
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

  // Persist the cursor ONLY after the batch has been fully processed. A batch-level throw (selection,
  // a timeout) above this point leaves the cursor unchanged, so the unprocessed batch is retried next
  // tick rather than skipped until a full rotation. Per-order allocation failures are caught above and
  // still advance (they're benign/logged), so a single bad order can't wedge the cursor.
  await deps.writeState(nextState)

  return result
}
