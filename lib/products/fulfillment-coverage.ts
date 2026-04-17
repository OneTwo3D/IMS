export type FulfillmentRequirement = {
  productId: string
  factor: number
}

export function requirementsMapToRows(
  requirements: Map<string, number>,
): FulfillmentRequirement[] {
  return [...requirements.entries()].map(([productId, factor]) => ({
    productId,
    factor,
  }))
}

export function calculateFulfillmentCoverage(
  requirements: Iterable<FulfillmentRequirement>,
  quantitiesByProduct: Map<string, number>,
): number {
  let coverage = Number.POSITIVE_INFINITY
  let hasRequirement = false

  for (const requirement of requirements) {
    if (!Number.isFinite(requirement.factor) || requirement.factor <= 0) {
      return 0
    }
    hasRequirement = true
    coverage = Math.min(
      coverage,
      (quantitiesByProduct.get(requirement.productId) ?? 0) / requirement.factor,
    )
  }

  if (!hasRequirement || !Number.isFinite(coverage)) {
    return 0
  }

  return Math.max(0, coverage)
}

export function calculateCoverageByLine(
  requirementsByLine: Map<string, FulfillmentRequirement[]>,
  rows: Array<{ lineId: string; productId: string; qty: number }>,
): Map<string, number> {
  const quantitiesByLine = new Map<string, Map<string, number>>()

  for (const row of rows) {
    const lineQuantities = quantitiesByLine.get(row.lineId) ?? new Map<string, number>()
    lineQuantities.set(row.productId, (lineQuantities.get(row.productId) ?? 0) + row.qty)
    quantitiesByLine.set(row.lineId, lineQuantities)
  }

  const coverageByLine = new Map<string, number>()
  for (const [lineId, requirements] of requirementsByLine) {
    coverageByLine.set(
      lineId,
      calculateFulfillmentCoverage(requirements, quantitiesByLine.get(lineId) ?? new Map()),
    )
  }

  return coverageByLine
}
