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
export type CoverageOrder = { id: string; lines: CoverageOrderLine[] }

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

  // Refunded quantity per ORDER LINE (o3d-jby). allocateSalesOrder defines demand as ordered
  // MINUS refunded, netted under the order lock; comparing coverage against GROSS qty here made
  // the two disagree, so a line with 10 ordered, 5 refunded and 5 allocated read as outstanding
  // forever. Harmless while the only caller was the stock-event backorder allocator; with the
  // o3d-9lx sweep rotating continuously it became a permanent rewrite loop — every rotation
  // resetting staged allocation accounting, deleting and recreating identical allocations, and
  // emitting storefront syncs and activity for an order that was already fully covered.
  const refundedByLine = new Map<string, number>()
  const refundLines = await db.salesOrderRefundLine.findMany({
    where: { refund: { orderId: { in: candidates.map((o) => o.id) } } },
    select: { salesOrderLineId: true, qty: true },
  })
  for (const row of refundLines) {
    if (!row.salesOrderLineId) continue
    refundedByLine.set(
      row.salesOrderLineId,
      (refundedByLine.get(row.salesOrderLineId) ?? 0) + Number(row.qty),
    )
  }

  return candidates.filter((order) => {
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
      const netDemand = Math.max(0, Number(line.qty) - (refundedByLine.get(line.id) ?? 0))
      return netDemand > coverage + QUANTITY_TOLERANCE
    })
  })
}
