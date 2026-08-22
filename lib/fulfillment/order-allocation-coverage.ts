import { db } from '@/lib/db'
import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  FULFILLMENT_QTY_HALF_ULP,
  canonicalFulfillmentQty,
  type DecimalFulfillmentRequirement,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirements } from '@/lib/products/fulfillment-requirement-snapshot'

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
const QUANTITY_TOLERANCE = new Prisma.Decimal('0.000001')

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

  // o3d-kouj: the PINNED recipe wins over the current graph, and this function loads it itself
  // rather than requiring it in `CoverageOrderLine`. This is documented as the single source of
  // truth for "which orders still need allocation", and its four callers each build their candidate
  // lines with their own `select`; a caller that simply forgot the column would silently answer
  // from the live graph while every other reader answered from the snapshot, which is exactly the
  // reader disagreement o3d-kouj exists to prevent. One indexed read on ids already in hand is the
  // cheaper half of that trade. Through the SAME client as everything else here, for the reasons in
  // the note above the graph load.
  const snapshotLines = await client.salesOrderLine.findMany({
    where: { id: { in: candidates.flatMap((order) => order.lines.map((line) => line.id)) } },
    select: { id: true, productId: true, fulfillmentRequirements: true },
  })
  const snapshotLineById = new Map(snapshotLines.map((line) => [line.id, line]))

  // Two renderings of the SAME requirement set: the number rows are the `lineNeedsAllocation`
  // predicate's published contract (the replenishment allocator filters on them), the Decimal rows
  // are what the shortfall test below uses — quantities are never decided in float. Both are
  // derived from ONE call to o3d-kouj's seam, so the float rendering can never disagree with the
  // Decimal one about which recipe the line was allocated from.
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  const decimalRequirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const order of candidates) {
    for (const line of order.lines) {
      if (!line.productId) continue
      const resolvable = snapshotLineById.get(line.id) ?? { id: line.id, productId: line.productId }
      const requirements = lineFulfillmentRequirements(resolvable, graph)
      requirementsByLine.set(
        line.id,
        requirements.map((requirement) => ({
          productId: requirement.productId,
          factor: requirement.factor.toNumber(),
        })),
      )
      decimalRequirementsByLine.set(line.id, requirements)
    }
  }

  // Allocated quantity from OrderAllocation only, in COMPONENT units. Shipped orders are excluded
  // by the caller, so there are no committed shipment rows to add here.
  //
  // `warehouseId` is selected (o3d-i4qd) purely to COUNT the scopes a (line, product) total was
  // assembled from. Each of those rows was rounded to `Decimal(12,4)` independently, so the sum can
  // sit up to half an ulp per row below the single rounding the requirement side performs, and the
  // shortfall test has to allow exactly that much and no more.
  const allocRows = await client.orderAllocation.findMany({
    where: { orderId: { in: candidates.map((o) => o.id) } },
    select: { orderId: true, lineId: true, productId: true, warehouseId: true, qty: true },
  })
  const allocatedByOrderLineProduct = new Map<string, { qty: Prisma.Decimal; scopes: Set<string> }>()
  const allocationKey = (orderId: string, lineId: string, productId: string) =>
    `${orderId}\u0000${lineId}\u0000${productId}`
  for (const row of allocRows) {
    const key = allocationKey(row.orderId, row.lineId, row.productId)
    const entry = allocatedByOrderLineProduct.get(key)
      ?? { qty: new Prisma.Decimal(0), scopes: new Set<string>() }
    entry.qty = entry.qty.add(toDecimal(row.qty as DecimalInput))
    entry.scopes.add(row.warehouseId)
    allocatedByOrderLineProduct.set(key, entry)
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
  const refundedByOrderLine = new Map<string, Prisma.Decimal>()
  const refundKey = (orderId: string, lineId: string) => `${orderId}\u0000${lineId}`
  const refundLines = await client.salesOrderRefundLine.findMany({
    where: { refund: { orderId: { in: candidates.map((o) => o.id) } } },
    select: { salesOrderLineId: true, qty: true, refund: { select: { orderId: true } } },
  })
  for (const row of refundLines) {
    if (!row.salesOrderLineId) continue
    const key = refundKey(row.refund.orderId, row.salesOrderLineId)
    refundedByOrderLine.set(
      key,
      (refundedByOrderLine.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty as DecimalInput)),
    )
  }

  return candidates.filter((order) => {
    if (fullyRefunded(order)) return false
    return order.lines.some((line) => {
      if (!line.productId) return false
      const reqs = requirementsByLine.get(line.id) ?? []
      if (lineNeedsAllocation && !lineNeedsAllocation(line, reqs)) return false

      // Net demand, matching allocateSalesOrder. Clamped at zero: over-refunding a line means
      // no demand, not negative demand.
      const netDemand = Prisma.Decimal.max(
        new Prisma.Decimal(0),
        toDecimal(line.qty as DecimalInput)
          .sub(refundedByOrderLine.get(refundKey(order.id, line.id)) ?? new Prisma.Decimal(0)),
      )
      if (netDemand.lte(QUANTITY_TOLERANCE)) return false

      const requirements = decimalRequirementsByLine.get(line.id) ?? []
      // No requirements at all (a kit whose every component expanded away) is not something an
      // allocation run can satisfy, but it is also not something this function may declare
      // covered — that is the pre-existing answer and it is preserved deliberately.
      if (requirements.length === 0) return true

      return requirements.some((requirement) => {
        // A non-positive or non-finite factor has no coverage, at any scale. Unchanged.
        if (!requirement.factor.isFinite() || requirement.factor.lte(0)) return true

        // o3d-i4qd — ASK IN COMPONENT UNITS, AT THE SCALE THE WRITER PERSISTS AT.
        //
        // This used to divide the persisted (rounded) component quantity by the UNQUANTISED
        // requirement factor and compare the resulting kit-unit coverage against demand. For a kit
        // whose expanded factor the column cannot hold — a nested 0.3332 x 0.3332 = 0.11102224,
        // stored as 0.1110 — that reads as 0.99979968 of one kit, short by 2e-4, which is two
        // hundred times the tolerance. A FULLY allocated line was therefore re-selected on every
        // 15-minute rotation, forever, and (before the write became canonical) rewritten each time.
        //
        // Quantising the requirement instead asks exactly what `allocateSalesOrder` will store:
        // one rounding, half-up, after the whole multiplication.
        const required = canonicalFulfillmentQty(netDemand.mul(requirement.factor))
        const allocated = allocatedByOrderLineProduct
          .get(allocationKey(order.id, line.id, requirement.productId))
        const allocatedQty = allocated?.qty ?? new Prisma.Decimal(0)
        // One half-ulp of slack per allocation row that fed this total (at least one), because each
        // was rounded on its own — see the `warehouseId` note on the read above.
        const slack = FULFILLMENT_QTY_HALF_ULP
          .mul(Math.max(1, allocated?.scopes.size ?? 1))
          .add(QUANTITY_TOLERANCE)
        return required.sub(allocatedQty).gt(slack)
      })
    })
  })
}
