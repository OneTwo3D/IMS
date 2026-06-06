import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export function assertFinitePurchaseReceiptUnitCost(
  unitCostBase: DecimalInput,
  context?: { poLineId?: string; poRef?: string },
): void {
  // Zero-cost receipts are intentional for replacement, sample, or consigned stock.
  let cost
  try {
    cost = toDecimal(unitCostBase)
  } catch {
    cost = null
  }
  if (cost == null || !cost.isFinite() || cost.lt(0)) {
    const contextLabel = context
      ? ` (${context.poRef ?? '?'} line ${context.poLineId ?? '?'})`
      : ''
    throw new Error(`Purchase receipt unitCostBase must be finite and zero or greater${contextLabel}`)
  }
}
