import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

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
