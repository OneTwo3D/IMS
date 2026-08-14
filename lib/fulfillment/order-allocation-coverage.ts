import { db } from '@/lib/db'
import { Prisma } from '@/app/generated/prisma/client'
import {
  requirementsMapToDecimalRows,
  requirementsMapToRows,
  type DecimalFulfillmentRequirement,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
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

const ZERO = new Prisma.Decimal(0)

// Matches the tolerance the backorder report / allocator use when comparing ordered vs covered qty.
const QUANTITY_TOLERANCE = new Prisma.Decimal('0.000001')

/**
 * OrderAllocation.qty is `Decimal(12,4)` (prisma/schema.prisma), so 1e-4 is the smallest
 * quantity a row can express and Postgres rounds HALF-UP into it on write.
 */
const ALLOCATION_QTY_DP = 4
const ALLOCATION_QTY_ULP = new Prisma.Decimal('0.0001')

/**
 * o3d-i4qd (Codex review, finding 1): slack for a line SPLIT across warehouses, where each row is
 * rounded into the column independently and the sum can therefore differ from the figure a single
 * row would have carried. It is a CONSTANT half-ULP, NOT a per-row budget: the previous
 * `(rows + 1) x half-ULP` GREW with the number of warehouses and at two rows already exceeded a
 * full ULP, so it could swallow an entire missing unit. Counterexample it wrongly cleared: factor
 * 1e-4, net demand 3 kits => required 0.0003; two warehouses holding 0.0001 each persist 0.0002
 * with one kit genuinely unallocated, yet the old allowance of 1.51e-4 declared it covered.
 *
 * The invariant that MUST hold: allowance < ALLOCATION_QTY_ULP. Every persisted qty and the
 * quantized requirement are multiples of 1e-4, so the smallest REAL shortfall the column can
 * express is exactly one ULP — an allowance that can reach 1e-4 can therefore hide a genuine one.
 * 1e-6 + 5e-5 = 5.1e-5 stays comfortably under it, at any row count.
 *
 * ACCEPTED TRADE-OFF: a split line whose independent per-row rounding drifts by more than half an
 * ULP from the aggregate figure (e.g. two rows of round(f, 4) against a requirement of
 * round(2f, 4)) IS re-selected and re-allocated even though nothing is actually missing. That is
 * wasted work — the SAFE direction. The unsafe direction is hiding a real shortfall, and we
 * refuse to trade the second for the first. Closing it properly needs the EXPECTED quantity per
 * warehouse rather than an aggregate, i.e. the writer half of o3d-i4qd, deliberately out of scope
 * here: this function may only change WHICH orders are looked at, never what is written.
 */
const SPLIT_ROUNDING_SLACK = ALLOCATION_QTY_ULP.div(2)
const SPLIT_ALLOWANCE = QUANTITY_TOLERANCE.add(SPLIT_ROUNDING_SLACK)

/** Composite map key; the NUL separator cannot occur in a cuid. */
function lineProductKey(lineId: string, productId: string): string {
  return `${lineId}\u0000${productId}`
}

/**
 * What the allocation writer would actually STORE for a computed component quantity.
 *
 * o3d-i4qd (Codex review, finding 2): `Prisma.Decimal.toDecimalPlaces(4, HALF_UP)`, NOT
 * `Math.round(value * 1e4) / 1e4`. The two disagree on exact halves, because the binary Number is
 * not the decimal value the database rounds: net demand 0.0003 at factor 0.5 is exactly 0.00015,
 * which Postgres stores as 0.0002, while JS evaluates the scaled product as 1.4999999999999998
 * and rounds it DOWN to 0.0001 — declaring a line covered by a row that is one ULP short. The
 * whole comparison (demand, refund netting, factor, aggregation, quantization) therefore stays in
 * Decimal; nothing crosses through Number.
 */
function atPersistedScale(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(ALLOCATION_QTY_DP, Prisma.Decimal.ROUND_HALF_UP)
}

/**
 * Quantities reach us typed as `unknown` (CoverageOrderLine.qty), so a value the schema could
 * never have produced must not reject the whole sweep. Callers below decide what `null` means in
 * their own direction — always the fail-CLOSED one (o3d-i4qd).
 */
function toQtyDecimal(value: unknown): Prisma.Decimal | null {
  try {
    const decimal = toDecimal(value as DecimalInput)
    return decimal.isFinite() ? decimal : null
  } catch {
    return null
  }
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
  // Two views of the SAME expansion. The number-typed rows exist only to feed the exported
  // `lineNeedsAllocation` predicate, whose signature is a public contract (backorder-allocator.ts
  // passes one); the Decimal rows are what the coverage comparison actually uses, so no factor is
  // ever narrowed through `toNumber()` before being compared (o3d-i4qd, Codex finding 2). Built
  // from one `expandFulfillmentRequirementsDecimal` call per line: no extra graph work, no
  // opportunity for the two views to disagree.
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  const decimalRequirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const order of candidates) {
    for (const line of order.lines) {
      if (!line.productId) continue
      const expanded = expandFulfillmentRequirementsDecimal(line.productId, 1, graph)
      requirementsByLine.set(line.id, requirementsMapToRows(expanded))
      decimalRequirementsByLine.set(line.id, requirementsMapToDecimalRows(expanded))
    }
  }

  // Coverage from OrderAllocation only (component units for KIT lines). Shipped orders are excluded by
  // the caller, so there are no committed shipment rows to add here.
  const allocRows = await client.orderAllocation.findMany({
    where: { orderId: { in: candidates.map((o) => o.id) } },
    select: { orderId: true, lineId: true, productId: true, qty: true },
  })
  // Kept as Decimal end to end: a stored 0.0001 must not become a binary approximation before it
  // is compared against a Decimal requirement (o3d-i4qd). An unreadable qty counts as ZERO — the
  // fail-closed direction, since inventing coverage is what re-selects nothing and hides shortfall.
  const coverageRowsByOrder = new Map<
    string,
    Array<{ lineId: string; productId: string; qty: Prisma.Decimal }>
  >()
  for (const row of allocRows) {
    const list = coverageRowsByOrder.get(row.orderId) ?? []
    list.push({
      lineId: row.lineId,
      productId: row.productId,
      qty: toQtyDecimal(row.qty) ?? ZERO,
    })
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
  const refundedByOrderLine = new Map<string, Prisma.Decimal>()
  const refundKey = (orderId: string, lineId: string) => `${orderId}\u0000${lineId}`
  const refundLines = await client.salesOrderRefundLine.findMany({
    where: { refund: { orderId: { in: candidates.map((o) => o.id) } } },
    select: { salesOrderLineId: true, qty: true, refund: { select: { orderId: true } } },
  })
  for (const row of refundLines) {
    if (!row.salesOrderLineId) continue
    const key = refundKey(row.refund.orderId, row.salesOrderLineId)
    // An unreadable refund qty nets NOTHING (fail closed): a refund that cannot be understood must
    // never cancel demand, because that silently drops the line out of the sweep for good.
    const refunded = toQtyDecimal(row.qty) ?? ZERO
    refundedByOrderLine.set(key, (refundedByOrderLine.get(key) ?? ZERO).add(refunded))
  }

  return candidates.filter((order) => {
    if (fullyRefunded(order)) return false

    // Persisted component quantities per (line, product), with the number of ROWS that make
    // them up — a line allocated across several warehouses has one row per warehouse, and
    // Postgres rounds each of them independently.
    const persistedByLineProduct = new Map<string, { qty: Prisma.Decimal; rows: number }>()
    for (const row of coverageRowsByOrder.get(order.id) ?? []) {
      const key = lineProductKey(row.lineId, row.productId)
      const entry = persistedByLineProduct.get(key) ?? { qty: ZERO, rows: 0 }
      // Decimal addition, exact: the sum of 4-dp rows is itself a 4-dp figure, so it is NOT
      // re-quantized here. Rounding the persisted side would round a genuinely short sum UP into
      // apparent coverage — quantization belongs on the REQUIREMENT (what the writer would store).
      persistedByLineProduct.set(key, { qty: entry.qty.add(row.qty), rows: entry.rows + 1 })
    }

    return order.lines.some((line) => {
      if (!line.productId) return false
      const reqs = requirementsByLine.get(line.id) ?? []
      if (lineNeedsAllocation && !lineNeedsAllocation(line, reqs)) return false
      // An unreadable ordered qty is UNKNOWN demand, not zero demand: leave the line outstanding
      // rather than declare it covered (o3d-i4qd, fail closed).
      const orderedQty = toQtyDecimal(line.qty)
      if (orderedQty === null) return true
      // Net demand, matching allocateSalesOrder. Clamped at zero: over-refunding a line means
      // no demand, not negative demand.
      const netDemand = Prisma.Decimal.max(
        ZERO,
        orderedQty.sub(refundedByOrderLine.get(refundKey(order.id, line.id)) ?? ZERO),
      )
      if (netDemand.lte(0)) return false
      const decimalReqs = decimalRequirementsByLine.get(line.id) ?? []
      // No expandable requirement (e.g. a KIT with no components) covers nothing, so demand is
      // outstanding — unchanged from the coverage-based form, where such a line scored 0.
      if (decimalReqs.length === 0) return true

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
      return decimalReqs.some((requirement) => {
        // FAIL CLOSED on a factor that cannot be divided by or multiplied with meaningfully.
        // ProductComponent.qty carries no positivity constraint in the schema, so a zero or
        // negative component qty reaches here as a factor <= 0; `calculateDecimalFulfillmentCoverage`
        // scored such a line 0 (permanently outstanding), and an interim form of this rewrite
        // SKIPPED the requirement instead — excluding a line with positive demand from the sweep
        // altogether, i.e. fail OPEN. Restored: an unusable factor makes the line OUTSTANDING so
        // the data defect stays visible rather than quietly dropping the order (o3d-i4qd, Codex
        // finding 3).
        if (!requirement.factor.isFinite() || requirement.factor.lte(0)) return true
        const required = atPersistedScale(netDemand.mul(requirement.factor))
        const persisted = persistedByLineProduct.get(lineProductKey(line.id, requirement.productId))
        // A line allocated from ONE warehouse needs no slack at all: the writer stores exactly
        // `required`, so the comparison is an identity and any shortfall is real. Slack applies
        // only to a line SPLIT across warehouses, and is capped at half an ULP TOTAL — see
        // SPLIT_ALLOWANCE for why it must never reach one ULP and what that costs.
        //
        // Deliberately not a blanket tolerance: one wide enough to absorb this defect would
        // also absorb a genuine shortfall, and the fix would then be the tolerance rather than
        // the scale alignment — passing for the wrong reason.
        const allowance = (persisted?.rows ?? 0) > 1 ? SPLIT_ALLOWANCE : QUANTITY_TOLERANCE
        return (persisted?.qty ?? ZERO).lt(required.sub(allowance))
      })
    })
  })
}
