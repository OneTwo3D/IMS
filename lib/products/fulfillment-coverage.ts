import { Prisma } from '@/app/generated/prisma/client'
import { floorQuantity, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type FulfillmentRequirement = {
  productId: string
  factor: number
}

export type DecimalFulfillmentRequirement = {
  productId: string
  factor: Prisma.Decimal
}

export function requirementsMapToRows(
  requirements: Map<string, DecimalInput>,
): FulfillmentRequirement[] {
  return [...requirements.entries()].map(([productId, factor]) => ({
    productId,
    factor: toDecimal(factor).toNumber(),
  }))
}

export function requirementsMapToDecimalRows(
  requirements: Map<string, DecimalInput>,
): DecimalFulfillmentRequirement[] {
  return [...requirements.entries()].map(([productId, factor]) => ({
    productId,
    factor: toDecimal(factor),
  }))
}

/**
 * THE ONE CANONICAL QUANTITY SCALE FOR THE FULFILMENT CHAIN (o3d-i4qd).
 *
 * `ProductComponent.qty`, `SalesOrderLine.qty`, `OrderAllocation.qty` and `ShipmentLine.qty` are
 * ALL `@db.Decimal(12, 4)`. A requirement expanded through the graph is a PRODUCT of those columns
 * and is therefore routinely NOT representable at four decimals: 0.3333 x 0.3333 = 0.11108889, and
 * a plain single-level kit ordered in a fractional quantity does it too (0.5 x 0.3333 = 0.16665).
 *
 * So an expanded requirement is not a quantity IMS has — it is a quantity IMS is about to round.
 * Every comparison between a COMPUTED requirement and a PERSISTED quantity must therefore happen at
 * this scale, with this rounding, or the two sides are different numbers by construction. That
 * mismatch is what made a fully allocated kit read as short on every sweep rotation, and what made
 * `validateAllocationIntegrity` refuse an allocation IT HAD JUST WRITTEN ITSELF.
 */
export const FULFILLMENT_QTY_DP = 4

/**
 * Half an ulp at {@link FULFILLMENT_QTY_DP} — the largest error `numeric(12,4)` can introduce on a
 * single stored quantity, and therefore the width of the band a stored quantity stands for: a row
 * holding 0.1667 was written from some value in [0.16665, 0.16675).
 */
export const FULFILLMENT_QTY_HALF_ULP = new Prisma.Decimal('0.00005')

/**
 * Quantise to {@link FULFILLMENT_QTY_DP} with the SAME rounding Postgres `numeric(12,4)` applies on
 * write (half-up). Rounding happens ONCE, after the whole multiplication — never per term, and
 * never on the persisted side, which is already at this scale and must not be re-rounded.
 */
export function canonicalFulfillmentQty(qty: DecimalInput): Prisma.Decimal {
  return roundQuantity(qty, FULFILLMENT_QTY_DP)
}

/**
 * The largest quantity at {@link FULFILLMENT_QTY_DP} that a CEILING can still honour (o3d-aqke,
 * Codex r1 finding 2).
 *
 * This is NOT the quantisation rule and does not compete with it. {@link canonicalFulfillmentQty}
 * is half-up and belongs to the COMPUTED side, once, after the whole multiplication. This one is a
 * FLOOR, and it belongs to a LIMIT the computed side is not allowed to cross — proven availability,
 * a dispatch cap, a remaining budget. The two have to be different functions, because a ceiling that
 * rounded half-UP would authorise a quantity that does not exist: `canonicalFulfillmentQty` may
 * legitimately move a computed value UP by as much as {@link FULFILLMENT_QTY_HALF_ULP}, so a plan
 * drawn against a raw 6dp availability can persist a row that exceeds it.
 *
 * The guarantee, and it is worth stating because everything below depends on it: for any
 * `x <= floorFulfillmentQty(A)`, `canonicalFulfillmentQty(x) <= floorFulfillmentQty(A) <= A`.
 * Rounding half-up is monotone, and it is the identity on a value already at this scale, so the
 * rounded row can never cross the floored ceiling. Planning against the raw `A` gives no such
 * guarantee at all.
 *
 * What is given up is at most one ulp of availability — a quantity `Decimal(12,4)` cannot represent
 * and no allocation row could ever have held.
 */
export function floorFulfillmentQty(qty: DecimalInput): Prisma.Decimal {
  return floorQuantity(qty, FULFILLMENT_QTY_DP)
}

/**
 * How many independently rounded terms a cumulative quantity is the sum of. One is the floor: a
 * quantity that came from a single stored row is still one rounding, and a missing, zero, negative
 * or non-integral count must never NARROW the band below what a single write can move.
 */
function fulfillmentRoundingCount(
  countsByProduct: ReadonlyMap<string, number> | undefined,
  productId: string,
): number {
  const count = countsByProduct?.get(productId)
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return 1
  return Math.ceil(count)
}

/**
 * IS THIS SET OF PERSISTED COMPONENT QUANTITIES A PROPORTIONAL KIT SET, JUDGED AT THE SCALE THEY
 * ARE STORED AT (o3d-i4qd)?
 *
 * THE TEST THIS REPLACES, AND WHY IT WAS WRONG. The old form derived one coverage as
 * `min(qty / factor)` and then demanded `qty == coverage * factor` for every component to within
 * 1e-6. Both halves assume the quantities are exact. They are not: each is the half-up rounding of
 * `coverage * factor` to four decimals, so the inferred coverage is off by up to
 * `halfUlp / factor` — and multiplying that back out by a LARGER factor scales the error up. A
 * kit of 0.3333 x A + 1 x B ordered as 0.5 kits stores A = 0.1667, B = 0.5000; the old test infers
 * coverage 0.5 from B, expects A = 0.16665, sees 0.1667, and refuses a set the allocator had just
 * written itself. That refusal arrives at shipment confirmation, so the order allocates and can
 * then never be picked.
 *
 * THE TEST THAT IS CORRECT AT THIS SCALE. Each stored quantity `q_i` says only that the coverage
 * `c` satisfied `round(c * f_i, 4) == q_i`, i.e. `c` lies in `[(q_i - halfUlp) / f_i,
 * (q_i + halfUlp) / f_i)`. The set is proportional iff those bands share at least one `c` —
 * `max(lower) < min(upper)`. No tolerance is invented: the band width is exactly what the column
 * can represent.
 *
 * STRICTLY MORE PERMISSIVE THAN THE OLD TEST, never less: any set the old test accepted was within
 * 1e-6 of a single coverage, and 1e-6 < halfUlp, so that coverage is inside every band. The
 * disproportion the check exists to catch is unaffected — a kit re-composed from 2xA+1xB to
 * 2xA+2xB leaves A=2/B=1, whose bands are [0.999975, 1.000025) and [0.499975, 0.500025), disjoint.
 *
 * A non-positive or non-finite factor is reported as a breach: a component that is required in a
 * quantity of zero (or less) has no proportional representation at all, and silently treating it
 * as satisfied would let an incomplete set through.
 *
 * A SUM OF SEPARATELY ROUNDED QUANTITIES CARRIES A SEPARATELY ROUNDED ERROR (o3d-aqke, Codex r1
 * finding 1). The band above is derived from ONE stored quantity standing for ONE rounding of
 * `c * f_i`. A cumulative figure — the committed quantity of a component across a SEQUENCE of
 * partial shipments, each row rounded on its own write — is `sum_k round(c_k * f_i, 4)`, whose
 * distance from `(sum_k c_k) * f_i` is up to `n * halfUlp`, not `halfUlp`. Judging such a sum
 * against a one-ulp band is judging it by a rule it was never built to satisfy, and the refusal
 * lands at dispatch, on goods already picked and packed, with the units permanently unshippable.
 *
 * `roundingCountsByProduct` therefore says how many independently rounded terms went into each
 * quantity; the band for that component widens to exactly that many half-ulps and no more. Absent
 * or non-positive counts mean one term, which is the single-row case and reproduces the old band
 * exactly. Widening is proportional to the rounding actually performed — it is not a tolerance,
 * and it is orders of magnitude below any real disproportion: a kit rescaled from 2xA+1xB to
 * 2xA+2xB is out by HALF A KIT, which no plausible number of ulps reaches.
 *
 * Returns the component whose band excludes the rest (the one that is SHORT, which is the useful
 * one to name) together with the component it conflicts with, or null when the set is proportional.
 */
export function findDisproportionateFulfillmentComponent(
  requirements: Iterable<DecimalFulfillmentRequirement>,
  quantitiesByProduct: Map<string, DecimalInput>,
  roundingCountsByProduct?: ReadonlyMap<string, number>,
): { productId: string; conflictsWithProductId: string } | null {
  let lower: Prisma.Decimal | null = null
  let lowerProductId = ''
  let upper: Prisma.Decimal | null = null
  let upperProductId = ''

  for (const requirement of requirements) {
    if (!requirement.factor.isFinite() || requirement.factor.lte(0)) {
      return { productId: requirement.productId, conflictsWithProductId: requirement.productId }
    }
    const qty = toDecimal(quantitiesByProduct.get(requirement.productId))
    const tolerance = FULFILLMENT_QTY_HALF_ULP.mul(
      fulfillmentRoundingCount(roundingCountsByProduct, requirement.productId),
    )
    const lowerBound = qty.sub(tolerance).div(requirement.factor)
    const upperBound = qty.add(tolerance).div(requirement.factor)
    if (lower == null || lowerBound.gt(lower)) {
      lower = lowerBound
      lowerProductId = requirement.productId
    }
    if (upper == null || upperBound.lt(upper)) {
      upper = upperBound
      upperProductId = requirement.productId
    }
  }

  if (lower == null || upper == null) return null
  if (lower.lt(upper)) return null
  return { productId: upperProductId, conflictsWithProductId: lowerProductId }
}

/**
 * How far a coverage figure INFERRED from quantities stored at {@link FULFILLMENT_QTY_DP} can be
 * from the coverage that produced them, in KIT units (o3d-i4qd).
 *
 * `calculateDecimalFulfillmentCoverage` divides a stored quantity by an unquantised factor, so each
 * term carries `halfUlp / factor` of error and the minimum carries the largest of those. Any check
 * that compares such a coverage against a demand figure has to allow for it, or a rounding the
 * column itself performed reads as an over-allocation. It also shows how expensive a very small
 * factor is: at factor 0.0001 one ulp of that component IS a whole kit of coverage.
 */
export function fulfillmentCoverageQuantisationSlack(
  requirements: Iterable<DecimalFulfillmentRequirement>,
): Prisma.Decimal {
  let smallestFactor: Prisma.Decimal | null = null
  for (const requirement of requirements) {
    if (!requirement.factor.isFinite() || requirement.factor.lte(0)) continue
    if (smallestFactor == null || requirement.factor.lt(smallestFactor)) {
      smallestFactor = requirement.factor
    }
  }
  if (smallestFactor == null) return new Prisma.Decimal(0)
  return FULFILLMENT_QTY_HALF_ULP.div(smallestFactor)
}

export function calculateDecimalFulfillmentCoverage(
  requirements: Iterable<DecimalFulfillmentRequirement>,
  quantitiesByProduct: Map<string, DecimalInput>,
): Prisma.Decimal {
  let coverage: Prisma.Decimal | null = null
  let hasRequirement = false

  for (const requirement of requirements) {
    if (!requirement.factor.isFinite() || requirement.factor.lte(0)) {
      return new Prisma.Decimal(0)
    }
    hasRequirement = true
    const quantity = toDecimal(quantitiesByProduct.get(requirement.productId))
    const productCoverage = quantity.div(requirement.factor)
    coverage = coverage == null ? productCoverage : Prisma.Decimal.min(coverage, productCoverage)
  }

  if (!hasRequirement || !coverage?.isFinite()) {
    return new Prisma.Decimal(0)
  }

  return Prisma.Decimal.max(new Prisma.Decimal(0), coverage)
}

/**
 * What `qty` units of a product require, in leaf units, from a per-unit requirement set (o3d-kouj).
 *
 * ONE multiplication per requirement, applied to the whole per-unit factor rather than pushed term
 * by term down a graph walk, and NOTHING is quantised here — quantisation belongs to whichever
 * caller persists the result, once, after the whole multiplication (o3d-i4qd). Requirements that
 * name the same product are summed, matching `expandFulfillmentRequirementsDecimal`, which
 * accumulates a leaf reachable by two paths rather than replacing it.
 */
export function scaleFulfillmentRequirements(
  requirements: Iterable<DecimalFulfillmentRequirement>,
  qty: DecimalInput,
): Map<string, Prisma.Decimal> {
  const scale = toDecimal(qty)
  const quantities = new Map<string, Prisma.Decimal>()
  for (const requirement of requirements) {
    quantities.set(
      requirement.productId,
      (quantities.get(requirement.productId) ?? new Prisma.Decimal(0)).add(requirement.factor.mul(scale)),
    )
  }
  return quantities
}

/**
 * HOW MANY WHOLE UNITS OF A LINE'S PRODUCT ONE WAREHOUSE CAN COVER, judged from a REQUIREMENT SET
 * rather than by re-walking the component graph (o3d-kouj).
 *
 * This is `getFulfillmentAvailableQtyDecimal` expressed over the same flat requirement set every
 * other check on the path uses, and it exists because the allocator cannot ask two different
 * questions: if the rows it writes are expanded from a line's PINNED recipe while the feasibility
 * that authorised them came from the CURRENT graph, the allocator can decide "three kits fit" from
 * one recipe and then write the components of another. Availability and expansion have to come from
 * one source, and after o3d-kouj that source is the requirement set.
 *
 * It is arithmetically identical to the graph walk for a tree — min over leaves of
 * `available / factor`, non-positive factors yielding zero, the result floored at zero — and it
 * DIFFERS for a diamond, where the same leaf is reachable by two paths. The walk asks each branch
 * independently and so sees the leaf's whole stock twice; the requirement set has already SUMMED
 * that leaf, which is also what `mergeAllocationRows` does to the rows the allocator then writes.
 * So the walk could authorise an allocation whose own rows it would then have to refuse. Where the
 * two disagree the requirement set is the correct one, and it is the one the persisted rows agree
 * with.
 */
export function availableQtyFromRequirements(
  requirements: Iterable<DecimalFulfillmentRequirement>,
  warehouseId: string,
  stockByProductWarehouse: Map<string, Map<string, DecimalInput>>,
): Prisma.Decimal {
  const quantities = new Map<string, DecimalInput>()
  for (const requirement of requirements) {
    quantities.set(requirement.productId, stockByProductWarehouse.get(requirement.productId)?.get(warehouseId))
  }
  return calculateDecimalFulfillmentCoverage(requirements, quantities)
}

export function calculateDecimalCoverageByLine(
  requirementsByLine: Map<string, DecimalFulfillmentRequirement[]>,
  rows: Array<{ lineId: string; productId: string; qty: DecimalInput }>,
): Map<string, Prisma.Decimal> {
  const quantitiesByLine = new Map<string, Map<string, Prisma.Decimal>>()

  for (const row of rows) {
    const lineQuantities = quantitiesByLine.get(row.lineId) ?? new Map<string, Prisma.Decimal>()
    lineQuantities.set(
      row.productId,
      (lineQuantities.get(row.productId) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)),
    )
    quantitiesByLine.set(row.lineId, lineQuantities)
  }

  const coverageByLine = new Map<string, Prisma.Decimal>()
  for (const [lineId, requirements] of requirementsByLine) {
    coverageByLine.set(
      lineId,
      calculateDecimalFulfillmentCoverage(requirements, quantitiesByLine.get(lineId) ?? new Map()),
    )
  }

  return coverageByLine
}

export function calculateCoverageByLine(
  requirementsByLine: Map<string, FulfillmentRequirement[]>,
  rows: Array<{ lineId: string; productId: string; qty: number }>,
): Map<string, number> {
  return new Map(
    [...calculateDecimalCoverageByLine(
      new Map([...requirementsByLine].map(([lineId, requirements]) => [
        lineId,
        requirements.map((requirement) => ({
          productId: requirement.productId,
          factor: toDecimal(requirement.factor),
        })),
      ])),
      rows,
    )].map(([lineId, coverage]) => [lineId, coverage.toNumber()]),
  )
}
