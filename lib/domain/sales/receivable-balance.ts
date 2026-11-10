import { refundCreditsAsGross, type TurnoverBound, type TurnoverRefund } from '@/lib/domain/sales/customer-turnover'

/**
 * THE ONE RECEIVABLE ARITHMETIC. AR Aging (as of a date), Customer Aging (now) and the Invoices tab
 * balance all call this, so one order shows one balance on every screen.
 *
 * Everything is in BASE currency, as of `asOf` (inclusive; pass `new Date()` for "now"):
 *
 *   balance = invoiceGross - credits - receipts
 *
 *  - `invoiceGross` is `totalBase`.
 *  - `credits` are the credit notes raised on or before `asOf`, valued by `refundCreditsAsGross`
 *    (the same reading customer turnover uses). A credit that cannot be placed counts 0 and sets
 *    `bound` to `upper` or `indeterminate`.
 *  - `receipts` are customer payments on or before `asOf` less cash paid back out on or before it
 *    (payments against a credit note, recorded negative; the sign is not trusted, the magnitude is
 *    subtracted). Each payment is converted to base at its stored settlement rate
 *    (`Payment.settlementRateToBase`); without one, at the order's booked rate (totalBase /
 *    totalForeign) when the payment is in the order's currency. A payment in another currency with
 *    no settlement rate cannot be converted: it is counted at the booked rate and `bound` becomes
 *    `indeterminate`.
 *  - HELD AS PAID: when `paidAt` is on or before `asOf` and there is no customer payment row on or
 *    before it, receipts start from `invoiceGross` (settled with no local receipt: markSalesOrderPaid
 *    and the importer set paidAt without a Payment row), then cash paid out is subtracted as usual.
 *
 * `balance > 0.01` is a receivable, `balance < -0.01` a customer credit balance, otherwise settled.
 * A payment, refund or credit with no date counts as already happened (real rows always have one).
 */
export type ReceivablePayment = {
  amount: unknown
  currency?: string | null
  refundId?: string | null
  paidAt?: Date | null
  settlementRateToBase?: unknown
}

export type ReceivableOrder = {
  totalBase: unknown
  totalForeign?: unknown
  currency?: string | null
  paidAt?: Date | null
  payments: ReceivablePayment[]
  refunds?: Array<TurnoverRefund & { refundedAt?: Date | null }>
}

export type ReceivableStatus = 'outstanding' | 'credit' | 'settled'

export type ReceivableBalance = {
  /** Signed: positive owed to us, negative owed to the customer. Rounded to 2 places. */
  balance: number
  status: ReceivableStatus
  bound: TurnoverBound
  invoiceGross: number
  credits: number
  receipts: number
}

const MONEY_EPSILON = 0.01
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function receivableBalance(order: ReceivableOrder, asOf: Date): ReceivableBalance {
  const cutoff = asOf.getTime()
  const onOrBefore = (d: Date | null | undefined) => d == null || d.getTime() <= cutoff

  const invoiceGross = Number(order.totalBase)
  const foreign = order.totalForeign == null ? NaN : Number(order.totalForeign)
  const bookedRate = Number.isFinite(foreign) && foreign > 0 ? invoiceGross / foreign : 1

  const creditResult = refundCreditsAsGross((order.refunds ?? []).filter((r) => onOrBefore(r.refundedAt)))
  let bound: TurnoverBound = creditResult.bound

  const toBase = (p: ReceivablePayment): number => {
    const amount = Number(p.amount)
    const settlement = p.settlementRateToBase == null ? NaN : Number(p.settlementRateToBase)
    if (Number.isFinite(settlement) && settlement > 0) return amount * settlement
    if (p.currency && order.currency && p.currency !== order.currency) bound = 'indeterminate'
    return amount * bookedRate
  }

  const inRange = order.payments.filter((p) => onOrBefore(p.paidAt))
  const customerPayments = inRange.filter((p) => p.refundId == null)
  const cashOut = inRange.filter((p) => p.refundId != null)

  let receipts = customerPayments.reduce((sum, p) => sum + toBase(p), 0)
  if (customerPayments.length === 0 && order.paidAt != null && onOrBefore(order.paidAt)) receipts = invoiceGross
  receipts -= cashOut.reduce((sum, p) => sum + Math.abs(toBase(p)), 0)

  const balance = round2(invoiceGross - creditResult.credit - receipts)
  const status: ReceivableStatus = balance > MONEY_EPSILON ? 'outstanding' : balance < -MONEY_EPSILON ? 'credit' : 'settled'
  return { balance, status, bound, invoiceGross: round2(invoiceGross), credits: creditResult.credit, receipts: round2(receipts) }
}
