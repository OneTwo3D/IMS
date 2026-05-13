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
