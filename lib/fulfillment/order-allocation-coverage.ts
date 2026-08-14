import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import {
  requirementsMapToRows,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'

export type CoverageOrderLine = { id: string; qty: unknown; productId: string | null }
export type CoverageOrder = {
  id: string
  lines: CoverageOrderLine[]
  /**
   * o3d-jby: allocateSalesOrder treats FULL as UNCONDITIONAL zero demand — no per-line netting
   * involved. Callers that can supply it must, or a fully-refunded order is selected on every
   * rotation forever. Optional so a caller that genuinely cannot is not silently wrong; absent
   * simply means "not known to be fully refunded".
   */
  refundStatus?: string | null
}

// Matches the tolerance the backorder report / allocator use when comparing ordered vs covered qty.
const QUANTITY_TOLERANCE = 1e-6

/**
 * OrderAllocation.qty is `Decimal(12,4)` (prisma/schema.prisma), so 1e-4 is the smallest
 * quantity a row can express and Postgres rounds HALF-UP into it on write.
 */
const ALLOCATION_QTY_SCALE = 1e4
const ALLOCATION_QTY_ULP = 1 / ALLOCATION_QTY_SCALE

/** Composite map key; the NUL separator cannot occur in a cuid. */
function lineProductKey(lineId: string, productId: string): string {
  return `${lineId}\u0000${productId}`
}

/** What the allocation writer would actually STORE for a computed component quantity. */
function atPersistedScale(value: number): number {
  return Math.round(value * ALLOCATION_QTY_SCALE) / ALLOCATION_QTY_SCALE
}

/**
 * From candidate sales orders (each with its lines), return those that have at least one line with
 * OUTSTANDING allocation demand — the ordered qty NET OF REFUNDS exceeds what OrderAllocation rows cover,
 * computed KIT-aware (component units, via the fulfillment product graph). Fully-allocated orders are
 * excluded so a caller never re-runs allocation on them (which would churn their existing allocations).
 *
 * `lineNeedsAllocation` optionally narrows which outstanding lines count — e.g. the replenishment
 * allocator passes a predicate keeping only lines whose leaf requirements touch a just-replenished
 * product, so an unrelated KIT bottleneck isn't needlessly rewritten. The periodic reallocation sweep
 * (o3d-9lx) passes no predicate: any outstanding line makes the order eligible.
 *
 * Single source of truth for "which orders still need allocation", shared so the two callers can't
 * drift apart. Callers MUST pre-exclude orders that already have a Shipment — autoAllocateOrder rebuilds
 * OrderAllocation without touching committed ShipmentLines, so reallocating a shipped order would
 * decrement stock against stale shipment rows.
 */
export async function selectOrdersNeedingAllocation<T extends CoverageOrder>(
  candidates: T[],
  lineNeedsAllocation?: (line: CoverageOrderLine, requirements: FulfillmentRequirement[]) => boolean,
  /**
   * Client to read coverage against. Defaults to the module-level `db`, which is what the
   * sweep and the backorder allocator use. A caller deciding something under an order lock
   * must pass `tx` — reading through `db` would see pre-lock state and decide against a
   * snapshot the lock exists to rule out (o3d-c9mi).
   */
  client: Prisma.TransactionClient | typeof db = db,
): Promise<T[]> {
  if (candidates.length === 0) return []

  // Per-line requirements in leaf (component) units so KIT lines can be compared in kit units;
  // SIMPLE/BOM lines degenerate to a single requirement of factor 1.
  const lineProductIds = [
    ...new Set(
      candidates.flatMap((order) =>
        order.lines.map((line) => line.productId).filter((id): id is string => !!id),
      ),
    ),
  ]
  // Through the SAME client as everything below. Loading the graph on the global `db` while
  // the caller holds an interactive transaction takes a SECOND pooled connection — twenty
  // concurrent callers exhaust the pool and each waits for a connection the others hold. It
  // also mixes snapshots: a KIT definition committed after this read makes existing
  // allocations look complete against the old graph while being short against the new one,
  // so the shortfall is never recorded (Codex review, o3d-c9mi r3).
  const graph = await loadFulfillmentProductGraph(client, lineProductIds)
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  for (const order of candidates) {
    for (const line of order.lines) {
      if (!line.productId) continue
      requirementsByLine.set(
        line.id,
        requirementsMapToRows(expandFulfillmentRequirementsDecimal(line.productId, 1, graph)),
      )
    }
  }

  // Coverage from OrderAllocation only (component units for KIT lines). Shipped orders are excluded by
  // the caller, so there are no committed shipment rows to add here.
  const allocRows = await client.orderAllocation.findMany({
    where: { orderId: { in: candidates.map((o) => o.id) } },
    select: { orderId: true, lineId: true, productId: true, qty: true },
  })
  const coverageRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
  for (const row of allocRows) {
    const list = coverageRowsByOrder.get(row.orderId) ?? []
    list.push({ lineId: row.lineId, productId: row.productId, qty: Number(row.qty) })
    coverageRowsByOrder.set(row.orderId, list)
  }

  // A FULL refund is zero demand outright, matching allocateSalesOrder, which short-circuits on
  // refundStatus rather than netting lines. Monetary-only, shipping-only and otherwise unlinked
  // refund lines net NOTHING below, so without this a fully refunded order keeps gross demand
  // here and is re-selected and rewritten on every rotation (o3d-jby).
  const fullyRefunded = (order: CoverageOrder) => order.refundStatus === 'FULL'

  // Refunded quantity per ORDER LINE (o3d-jby). allocateSalesOrder defines demand as ordered
  // MINUS refunded, netted under the order lock; comparing coverage against GROSS qty here made
  // the two disagree, so a line with 10 ordered, 5 refunded and 5 allocated read as outstanding
  // forever. Harmless while the only caller was the stock-event backorder allocator; with the
  // o3d-9lx sweep rotating continuously it became a permanent rewrite loop — every rotation
  // resetting staged allocation accounting, deleting and recreating identical allocations, and
  // emitting storefront syncs and activity for an order that was already fully covered.
  //
  // Keyed by (ORDER id, line id), not by line id alone. Nothing in the schema enforces that a
  // refund line's salesOrderLineId belongs to its refund's order, and createSalesOrderRefund
  // persists a caller-supplied lineId without checking that ownership — so a mislinked refund on
  // order A could otherwise cancel demand on order B's line and drop B out of the sweep for good.
  // Aggregating under the refund's OWN orderId makes a bad link inert instead of contagious.
  const refundedByOrderLine = new Map<string, number>()
  const refundKey = (orderId: string, lineId: string) => `${orderId}\u0000${lineId}`
  const refundLines = await client.salesOrderRefundLine.findMany({
    where: { refund: { orderId: { in: candidates.map((o) => o.id) } } },
    select: { salesOrderLineId: true, qty: true, refund: { select: { orderId: true } } },
  })
  for (const row of refundLines) {
    if (!row.salesOrderLineId) continue
    const key = refundKey(row.refund.orderId, row.salesOrderLineId)
    refundedByOrderLine.set(key, (refundedByOrderLine.get(key) ?? 0) + Number(row.qty))
  }

  return candidates.filter((order) => {
    if (fullyRefunded(order)) return false

    // Persisted component quantities per (line, product), with the number of ROWS that make
    // them up — a line allocated across several warehouses has one row per warehouse, and
    // Postgres rounds each of them independently.
    const persistedByLineProduct = new Map<string, { qty: number; rows: number }>()
    for (const row of coverageRowsByOrder.get(order.id) ?? []) {
      const key = lineProductKey(row.lineId, row.productId)
      const entry = persistedByLineProduct.get(key) ?? { qty: 0, rows: 0 }
      entry.qty += row.qty
      entry.rows += 1
      persistedByLineProduct.set(key, entry)
    }

    return order.lines.some((line) => {
      if (!line.productId) return false
      const reqs = requirementsByLine.get(line.id) ?? []
      if (lineNeedsAllocation && !lineNeedsAllocation(line, reqs)) return false
      // Net demand, matching allocateSalesOrder. Clamped at zero: over-refunding a line means
      // no demand, not negative demand.
      const netDemand = Math.max(
        0,
        Number(line.qty) - (refundedByOrderLine.get(refundKey(order.id, line.id)) ?? 0),
      )
      if (netDemand <= 0) return false
      // No expandable requirement (e.g. a KIT with no components) covers nothing, so demand is
      // outstanding — unchanged from the coverage-based form, where such a line scored 0.
      if (reqs.length === 0) return true

      // o3d-i4qd: compare in COMPONENT units at the scale the row is STORED at, rather than
      // dividing a stored quantity by an unquantized factor to get kit units.
      //
      // Nested KIT expansion multiplies factors without quantizing — 0.3332 x 0.3332 needs
      // 0.11102224 component units per kit — while OrderAllocation.qty holds Decimal(12,4), so
      // the row stores 0.1110. Read back as kit units that is 0.1110/0.11102224 = 0.99979968
      // of one kit: short by ~2e-4, two orders of magnitude beyond QUANTITY_TOLERANCE. A line
      // that is allocated as completely as the schema can express was therefore reported
      // outstanding on EVERY rotation, re-selecting the order forever and making
      // pre-fulfilment reallocation log a shortfall that no allocation run can ever close.
      //
      // Asking instead "is the stored quantity at least what the writer would store for this
      // demand" makes the question answerable: required and persisted are then the same kind
      // of number. This changes only which orders are LOOKED at — never what is written or
      // reserved. Canonicalising the written quantity is the rest of o3d-i4qd, and is an
      // inventory decision (rounding a component requirement down under-reserves so the kit
      // cannot be built; rounding up over-reserves and can block other orders).
      return reqs.some((requirement) => {
        if (!Number.isFinite(requirement.factor) || requirement.factor <= 0) return false
        const required = atPersistedScale(netDemand * requirement.factor)
        const persisted = persistedByLineProduct.get(lineProductKey(line.id, requirement.productId))
        // A line allocated from ONE warehouse needs no slack at all: the writer stores exactly
        // `required`, so the comparison is an identity and any shortfall is real. Slack is only
        // for a line SPLIT across warehouses, where each row rounds independently and the sum
        // can sit up to (rows + 1) half-ULPs below the single-row figure with nothing missing.
        //
        // Deliberately not a blanket tolerance: one wide enough to absorb this defect would
        // also absorb a genuine shortfall, and the fix would then be the tolerance rather than
        // the scale alignment — passing for the wrong reason.
        const rows = persisted?.rows ?? 0
        const allowance = rows > 1
          ? QUANTITY_TOLERANCE + (rows + 1) * (ALLOCATION_QTY_ULP / 2)
          : QUANTITY_TOLERANCE
        return (persisted?.qty ?? 0) < required - allowance
      })
    })
  })
}
