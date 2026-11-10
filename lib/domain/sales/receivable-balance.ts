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
 *    subtracted). Conversion to base:
 *      - a payment (or cash refund-out) in the ORDER'S OWN currency reduces the receivable at the order's
 *        BOOKED rate, totalBase / totalForeign (1 for a base-currency order). The invoice was booked at that
 *        rate, so the receivable runs down at it; the difference to the rate the payment actually settled at
 *        is a realised FX gain or loss, which belongs to the FX report and not to what a customer owes.
 *        $100 booked at 80, paid $100 at 1.20, owes 0 (not a 3.33 credit).
 *      - a payment in a DIFFERENT currency has to be converted: at its stored settlement rate when it has one,
 *        else at the booked rate, and the balance is marked `indeterminate` either way.
 *    DIRECTION OF THE SETTLEMENT RATE: `Payment.settlementRateToBase` is "1 base = X receipt currency" (schema
 *    comment on the column), i.e. FOREIGN units per ONE BASE unit, and lib/accounting-fx.ts converts
 *    with `amountForeign / settlementRate`. So base = amount / rate: 100 EUR at 1.25 is 80.
 *  - HELD AS PAID: when `paidAt` is on or before `asOf` the order is settled. markSalesOrderPaid and the
 *    importer set `paidAt` with no (or only a part) Payment row, and nothing stored says whether a
 *    receipt is missing or the paid state was set off-ledger (`unregisteredPaidAt` records only that no
 *    LEDGER receipt is registered), so the uncovered remainder is treated as received off-ledger at
 *    `paidAt`: receipts = max(customer receipts in base, invoiceGross). Cash paid out is then
 *    subtracted as usual, and an over-payment stays an over-payment.
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
    const sameCurrency = !p.currency || !order.currency || p.currency === order.currency
    // Own-currency money moves the receivable at the booked rate; settlement-rate differences are FX gain/loss.
    if (sameCurrency) return amount * bookedRate
    bound = 'indeterminate'
    const settlement = p.settlementRateToBase == null ? NaN : Number(p.settlementRateToBase)
    return Number.isFinite(settlement) && settlement > 0 ? amount / settlement : amount * bookedRate
  }

  const inRange = order.payments.filter((p) => onOrBefore(p.paidAt))
  const customerPayments = inRange.filter((p) => p.refundId == null)
  const cashOut = inRange.filter((p) => p.refundId != null)

  let receipts = customerPayments.reduce((sum, p) => sum + toBase(p), 0)
  if (order.paidAt != null && onOrBefore(order.paidAt)) receipts = Math.max(receipts, invoiceGross)
  receipts -= cashOut.reduce((sum, p) => sum + Math.abs(toBase(p)), 0)

  const balance = round2(invoiceGross - creditResult.credit - receipts)
  const status: ReceivableStatus = balance > MONEY_EPSILON ? 'outstanding' : balance < -MONEY_EPSILON ? 'credit' : 'settled'
  return { balance, status, bound, invoiceGross: round2(invoiceGross), credits: creditResult.credit, receipts: round2(receipts) }
}
