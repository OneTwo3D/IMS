import { compareDecimal, subtractMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// IS THE ORDER FULLY PAID? (o3d-cdhl)
// ---------------------------------------------------------------------------
//
// `SalesOrder.paidAt` says the order was paid. It cannot say that the accounting ledger later stopped holding
// PART of that payment. That part is recorded in `paymentRemovedForeign`, and `paidAt` stays set (revenue was
// recognised on the payment, and whether to unwind it is the order owner's decision).
//
// So "fully paid" is `paidAt` set AND no part of the payment recorded as missing. Every reader that asks whether an
// order is fully paid, or how much of it is, asks through here, so one order shows one answer on every screen.

export type PaidStateFields = {
  paidAt: Date | null | undefined
  /** `SalesOrder.paymentRemovedForeign`: the part of the paid amount the ledger no longer holds, order currency. */
  paymentRemovedForeign?: DecimalInput
}

/** The part of the payment recorded as missing, as a Decimal (0 for none). */
export function paymentRemovedAmount(order: Pick<PaidStateFields, 'paymentRemovedForeign'>): Decimal {
  if (order.paymentRemovedForeign == null) return toDecimal(0)
  const value = toDecimal(order.paymentRemovedForeign)
  return compareDecimal(value, 0) > 0 ? value : toDecimal(0)
}

/** True when part of the payment is recorded as missing from the ledger. */
export function hasPaymentRemoved(order: Pick<PaidStateFields, 'paymentRemovedForeign'>): boolean {
  return compareDecimal(paymentRemovedAmount(order), 0) > 0
}

/** Paid, and no part of the payment is recorded as removed. */
export function isFullyPaid(order: PaidStateFields): boolean {
  return order.paidAt != null && !hasPaymentRemoved(order)
}

/** Paid, but only in part because the ledger no longer holds the rest. */
export function isPartlyPaidAfterRemoval(order: PaidStateFields): boolean {
  return order.paidAt != null && hasPaymentRemoved(order)
}

/** What the order is held as paid, in the order currency: the total less any part recorded as removed. Zero when unpaid. */
export function paidAmountForeign(order: PaidStateFields & { totalForeign: DecimalInput }): Decimal {
  if (order.paidAt == null) return toDecimal(0)
  const paid = subtractMoney(order.totalForeign, paymentRemovedAmount(order))
  return compareDecimal(paid, 0) < 0 ? toDecimal(0) : paid
}

/** The shortfall (order currency) standing as of a date: the sum of the signed history changes made on or before it. */
export function shortfallAsOf(
  history: ReadonlyArray<{ kind: string; amountForeign: unknown; createdAt: Date }>,
  asOf: Date,
): Decimal {
  let sum = toDecimal(0)
  for (const row of history) {
    if (row.createdAt.getTime() > asOf.getTime()) continue
    const amount = toDecimal(row.amountForeign as never)
    sum = row.kind === 'REMOVED' ? sum.plus(amount) : sum.minus(amount)
  }
  return compareDecimal(sum, 0) < 0 ? toDecimal(0) : sum
}
