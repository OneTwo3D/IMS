import { addMoney, multiplyMoney, roundQuantity, subtractMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

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

// cogs-audit scjz.63: all discount-allocation math runs through the shared Decimal
// helpers instead of native float (`Number`/`Math.round`/`*`/`/`). This module
// feeds per-line net revenue (and therefore margin), so float contamination here
// biased the allocation; the last-line residual-plug pattern is preserved.
function dec(value: NumericLike): Decimal {
  if (value == null) return toDecimal(0)
  try {
    return toDecimal(value as DecimalInput)
  } catch {
    return toDecimal(0)
  }
}

function round4(value: DecimalInput): Decimal {
  return roundQuantity(value, 4)
}

function fxRateOf(order: DiscountOrderContext): Decimal {
  const rate = dec(order.fxRateToBase)
  return rate.gt(0) ? rate : toDecimal(1)
}

function isWooCommerceOrder(order: DiscountOrderContext): boolean {
  return !!order.shoppingLinks?.some((link) => link.connector === 'woocommerce')
}

function lineTaxRate(order: DiscountOrderContext, line?: DiscountLineContext): Decimal {
  const rate = dec(line?.taxRatePercent ?? line?.taxRate?.rate ?? order.taxRatePercent)
  return rate.isFinite() && rate.gt(0) ? rate : toDecimal(0)
}

function lineNetBase(order: DiscountOrderContext, line: DiscountLineContext): Decimal {
  const totalBase = dec(line.totalBase)
  if (totalBase.gt(0)) return totalBase
  return dec(line.totalForeign).div(fxRateOf(order))
}

function normalizeRoundedAllocations(values: Decimal[], expectedTotal: Decimal): number[] {
  let running = toDecimal(0)
  return values.map((value, index) => {
    if (index === values.length - 1) return round4(subtractMoney(expectedTotal, running)).toNumber()
    const rounded = round4(value)
    running = addMoney(running, rounded)
    return rounded.toNumber()
  })
}

export function allocateOrderDiscountBase(
  order: DiscountOrderContext & { discountAmount: NumericLike },
  lines: DiscountLineContext[],
): number[] {
  const discountBaseRaw = dec(order.discountAmount).div(fxRateOf(order))
  const includeVatWeight = order.pricesIncludeVat && !isWooCommerceOrder(order)
  const weightedLines = lines
    .map((line, index) => {
      const rate = lineTaxRate(order, line)
      const netBase = lineNetBase(order, line)
      const weightBase = includeVatWeight
        ? multiplyMoney(netBase, toDecimal(1).add(rate))
        : netBase
      return { index, rate, weightBase }
    })
    .filter((line) => line.weightBase.gt(0))

  if (weightedLines.length === 0) return lines.map(() => 0)

  const totalDiscountBase = dec(normalizeOrderDiscountBase(order, lines))
  const weightTotal = weightedLines.reduce((sum, line) => addMoney(sum, line.weightBase), toDecimal(0))
  if (weightTotal.lte(0)) return lines.map(() => 0)

  const allocated = lines.map(() => 0)
  const weightedAllocations = weightedLines.map((line) => {
    const allocatedBase = multiplyMoney(discountBaseRaw, line.weightBase.div(weightTotal))
    if (isWooCommerceOrder(order) || !order.pricesIncludeVat) return allocatedBase
    return allocatedBase.div(toDecimal(1).add(line.rate))
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
  const discountBaseRaw = dec(order.discountAmount).div(fxRateOf(order))

  if (isWooCommerceOrder(order)) return round4(discountBaseRaw).toNumber()
  if (!order.pricesIncludeVat) return round4(discountBaseRaw).toNumber()

  const weightedLines = (lines ?? [])
    .map((line) => {
      const rate = lineTaxRate(order, line)
      const netBase = lineNetBase(order, line)
      return { rate, grossBase: multiplyMoney(netBase, toDecimal(1).add(rate)) }
    })
    .filter((line) => line.grossBase.gt(0))

  if (weightedLines.length === 0) {
    const vatPct = lineTaxRate(order)
    return round4(vatPct.gt(0) ? discountBaseRaw.div(toDecimal(1).add(vatPct)) : discountBaseRaw).toNumber()
  }

  const grossBase = weightedLines.reduce((sum, line) => addMoney(sum, line.grossBase), toDecimal(0))
  if (grossBase.lte(0)) return round4(discountBaseRaw).toNumber()

  const netDiscount = weightedLines.reduce((sum, line) => {
    const allocatedGross = multiplyMoney(discountBaseRaw, line.grossBase.div(grossBase))
    return addMoney(sum, allocatedGross.div(toDecimal(1).add(line.rate)))
  }, toDecimal(0))

  return round4(netDiscount).toNumber()
}

export function normalizeLineDiscountBase(
  order: DiscountOrderContext,
  discountAmount: NumericLike,
  lineTaxRatePercent?: NumericLike,
): number {
  const discountBaseRaw = dec(discountAmount).div(fxRateOf(order))
  const vatPct = lineTaxRate(order, { taxRatePercent: lineTaxRatePercent })

  if (isWooCommerceOrder(order)) return round4(discountBaseRaw).toNumber()
  if (order.pricesIncludeVat && vatPct.gt(0)) return round4(discountBaseRaw.div(toDecimal(1).add(vatPct))).toNumber()
  return round4(discountBaseRaw).toNumber()
}
