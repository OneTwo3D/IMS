type NumericLike = unknown

type DiscountOrderContext = {
  fxRateToBase: NumericLike
  pricesIncludeVat: boolean
  taxRatePercent: NumericLike
  shoppingLinks?: Array<{ connector: string }>
}

type DiscountLineContext = {
  totalBase?: NumericLike
  totalForeign?: NumericLike
  taxRatePercent?: NumericLike
  taxRate?: { rate?: NumericLike } | null
}

function toNumber(value: NumericLike): number {
  return Number(value ?? 0)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function isWooCommerceOrder(order: DiscountOrderContext): boolean {
  return !!order.shoppingLinks?.some((link) => link.connector === 'woocommerce')
}

function lineTaxRate(order: DiscountOrderContext, line?: DiscountLineContext): number {
  const rate = toNumber(line?.taxRatePercent ?? line?.taxRate?.rate ?? order.taxRatePercent)
  return Number.isFinite(rate) && rate > 0 ? rate : 0
}

function lineNetBase(order: DiscountOrderContext, line: DiscountLineContext): number {
  const totalBase = toNumber(line.totalBase)
  if (totalBase > 0) return totalBase
  const fxRate = toNumber(order.fxRateToBase) || 1
  return toNumber(line.totalForeign) / fxRate
}

function normalizeRoundedAllocations(values: number[], expectedTotal: number): number[] {
  let running = 0
  return values.map((value, index) => {
    if (index === values.length - 1) return round4(expectedTotal - running)
    const rounded = round4(value)
    running += rounded
    return rounded
  })
}

export function allocateOrderDiscountBase(
  order: DiscountOrderContext & { discountAmount: NumericLike },
  lines: DiscountLineContext[],
): number[] {
  const fxRate = toNumber(order.fxRateToBase) || 1
  const discountBaseRaw = toNumber(order.discountAmount) / fxRate
  const weightedLines = lines
    .map((line, index) => {
      const rate = lineTaxRate(order, line)
      const netBase = lineNetBase(order, line)
      const weightBase = order.pricesIncludeVat && !isWooCommerceOrder(order)
        ? netBase * (1 + rate)
        : netBase
      return { index, rate, weightBase }
    })
    .filter((line) => line.weightBase > 0)

  if (weightedLines.length === 0) return lines.map(() => 0)

  const totalDiscountBase = normalizeOrderDiscountBase(order, lines)
  const weightTotal = weightedLines.reduce((sum, line) => sum + line.weightBase, 0)
  if (weightTotal <= 0) return lines.map(() => 0)

  const allocated = lines.map(() => 0)
  const weightedAllocations = weightedLines.map((line) => {
    const allocatedBase = discountBaseRaw * (line.weightBase / weightTotal)
    if (isWooCommerceOrder(order) || !order.pricesIncludeVat) return allocatedBase
    return allocatedBase / (1 + line.rate)
  })
  const rounded = normalizeRoundedAllocations(weightedAllocations, totalDiscountBase)

  weightedLines.forEach((line, idx) => {
    allocated[line.index] = rounded[idx]
  })
  return allocated
}

export function normalizeOrderDiscountBase(
  order: DiscountOrderContext & { discountAmount: NumericLike },
  lines?: DiscountLineContext[],
): number {
  const fxRate = toNumber(order.fxRateToBase) || 1
  const discountBaseRaw = toNumber(order.discountAmount) / fxRate

  if (isWooCommerceOrder(order)) return round4(discountBaseRaw)
  if (!order.pricesIncludeVat) return round4(discountBaseRaw)

  const weightedLines = (lines ?? [])
    .map((line) => {
      const rate = lineTaxRate(order, line)
      const netBase = lineNetBase(order, line)
      return { rate, grossBase: netBase * (1 + rate) }
    })
    .filter((line) => line.grossBase > 0)

  if (weightedLines.length === 0) {
    const vatPct = lineTaxRate(order)
    return round4(vatPct > 0 ? discountBaseRaw / (1 + vatPct) : discountBaseRaw)
  }

  const grossBase = weightedLines.reduce((sum, line) => sum + line.grossBase, 0)
  if (grossBase <= 0) return round4(discountBaseRaw)

  const netDiscount = weightedLines.reduce((sum, line) => {
    const allocatedGross = discountBaseRaw * (line.grossBase / grossBase)
    return sum + allocatedGross / (1 + line.rate)
  }, 0)

  return round4(netDiscount)
}

export function normalizeLineDiscountBase(
  order: DiscountOrderContext,
  discountAmount: NumericLike,
  lineTaxRatePercent?: NumericLike,
): number {
  const fxRate = toNumber(order.fxRateToBase) || 1
  const discountBaseRaw = toNumber(discountAmount) / fxRate
  const vatPct = lineTaxRate(order, { taxRatePercent: lineTaxRatePercent })

  if (isWooCommerceOrder(order)) return round4(discountBaseRaw)
  if (order.pricesIncludeVat && vatPct > 0) return round4(discountBaseRaw / (1 + vatPct))
  return round4(discountBaseRaw)
}
