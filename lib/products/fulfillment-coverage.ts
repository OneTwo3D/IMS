import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

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
 * Returns the component whose band excludes the rest (the one that is SHORT, which is the useful
 * one to name) together with the component it conflicts with, or null when the set is proportional.
 */
export function findDisproportionateFulfillmentComponent(
  requirements: Iterable<DecimalFulfillmentRequirement>,
  quantitiesByProduct: Map<string, DecimalInput>,
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
    const lowerBound = qty.sub(FULFILLMENT_QTY_HALF_ULP).div(requirement.factor)
    const upperBound = qty.add(FULFILLMENT_QTY_HALF_ULP).div(requirement.factor)
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
