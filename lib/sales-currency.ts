type NumericLike = unknown

type DiscountOrderContext = {
  fxRateToBase: NumericLike
  pricesIncludeVat: boolean
  taxRatePercent: NumericLike
  shoppingLinks?: Array<{ connector: string }>
}

function toNumber(value: NumericLike): number {
  return Number(value ?? 0)
}

export function normalizeOrderDiscountBase(
  order: DiscountOrderContext & { discountAmount: NumericLike },
): number {
  const fxRate = toNumber(order.fxRateToBase) || 1
  const discountBaseRaw = toNumber(order.discountAmount) / fxRate
  const vatPct = toNumber(order.taxRatePercent)
  const isWooCommerceOrder = !!order.shoppingLinks?.some((link) => link.connector === 'woocommerce')

  if (isWooCommerceOrder) return discountBaseRaw
  if (order.pricesIncludeVat && vatPct > 0) return discountBaseRaw / (1 + vatPct)
  return discountBaseRaw
}

export function normalizeLineDiscountBase(
  order: DiscountOrderContext,
  discountAmount: NumericLike,
): number {
  const fxRate = toNumber(order.fxRateToBase) || 1
  const discountBaseRaw = toNumber(discountAmount) / fxRate
  const vatPct = toNumber(order.taxRatePercent)

  if (order.pricesIncludeVat && vatPct > 0) return discountBaseRaw / (1 + vatPct)
  return discountBaseRaw
}
