import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const FULL_REFUND_RATIO = '0.999'

export function isFullRefundAmount(refundedTotal: DecimalInput, orderTotal: DecimalInput): boolean {
  return toDecimal(refundedTotal).gte(toDecimal(orderTotal).mul(FULL_REFUND_RATIO))
}
