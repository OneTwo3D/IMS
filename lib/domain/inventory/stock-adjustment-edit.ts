// decimal-boundary-ok: server-action-boundary (numeric stock adjustment input validation)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

const QUANTITY_EPSILON = 0.000001

export type AdjustmentStockDeltaInput = {
  oldSignedQty: number
  newSignedQty: number
  currentQuantity?: DecimalLike | null
  currentReservedQty?: DecimalLike | null
}

export type AdjustmentStockDelta = {
  stockDelta: number
  resultingQuantity: number
  reservedQty: number
}

export function calculateAdjustmentStockDelta({
  oldSignedQty,
  newSignedQty,
  currentQuantity,
  currentReservedQty,
}: AdjustmentStockDeltaInput): AdjustmentStockDelta {
  const stockDelta = newSignedQty - oldSignedQty
  const currentQty = decimalToNumber(currentQuantity ?? 0)
  const reservedQty = decimalToNumber(currentReservedQty ?? 0)
  const resultingQuantity = currentQty + stockDelta

  if (resultingQuantity + QUANTITY_EPSILON < reservedQty) {
    throw new Error(
      `Cannot edit adjustment: resulting stock (${resultingQuantity.toFixed(4)}) ` +
      `would be below reserved quantity (${reservedQty.toFixed(4)}).`,
    )
  }

  return { stockDelta, resultingQuantity, reservedQty }
}
