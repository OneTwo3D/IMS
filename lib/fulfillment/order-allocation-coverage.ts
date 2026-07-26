import { db } from '@/lib/db'
import {
  calculateCoverageByLine,
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
  const graph = await loadFulfillmentProductGraph(db, lineProductIds)
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
  const allocRows = await db.orderAllocation.findMany({
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
  const refundLines = await db.salesOrderRefundLine.findMany({
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
    const coverageByLine = calculateCoverageByLine(
      requirementsByLine,
      coverageRowsByOrder.get(order.id) ?? [],
    )
    return order.lines.some((line) => {
      if (!line.productId) return false
      const reqs = requirementsByLine.get(line.id) ?? []
      if (lineNeedsAllocation && !lineNeedsAllocation(line, reqs)) return false
      const coverage = coverageByLine.get(line.id) ?? 0
      // Net demand, matching allocateSalesOrder. Clamped at zero: over-refunding a line means
      // no demand, not negative demand.
      const netDemand = Math.max(
        0,
        Number(line.qty) - (refundedByOrderLine.get(refundKey(order.id, line.id)) ?? 0),
      )
      return netDemand > coverage + QUANTITY_TOLERANCE
    })
  })
}
