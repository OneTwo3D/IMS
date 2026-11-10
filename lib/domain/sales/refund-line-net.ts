/**
 * WHAT REFUNDING `qty` UNITS OF AN ORDER LINE CREDITS, from the line's REMAINING stored value.
 *
 * A refund line is stored NET. Pro-rating the line's ORIGINAL net per refund rounds every partial refund on its own: 100 refunds of one
 * unit on a line worth 0.50 for 100 units would each round 0.005 up to 0.01 and credit 1.00 against a 0.50 line. So each refund is cut from
 * what is LEFT of the line (its stored net less what earlier refunds credited it) over the units that are left, and the refund that takes
 * the last remaining unit takes exactly the remainder: the refunds of one line always sum to the line's stored net, never above it.
 *
 * Pure numbers, no database or Decimal runtime: the refund service (under the order lock) and the refund dialog's preview read this one
 * function, so the preview is the figure the server will write unless another refund lands first.
 */

// decimal-boundary-ok: display-only (one rounding to the currency's minor unit; the server writes Decimals from these)
const roundTo = (n: number, places: number): number => {
  const f = 10 ** places
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f
}

const QTY_EPSILON = 1e-9

export type RefundableLine = {
  /** The line's quantity and its stored NET (foreign column, or base column when `net` is the base figure). */
  qty: number
  net: number
}

export type PriorRefunds = { qty: number; net: number }

/** The net credited for `qty` units: 0 when nothing is left to refund or `qty` is not positive. */
export function refundableNet(input: {
  line: RefundableLine
  prior: PriorRefunds
  qty: number
  /** Decimal places of the currency the figure is in (2 for most; 0 for JPY). */
  minorUnits: number
}): number {
  const remainingQty = input.line.qty - input.prior.qty
  if (!(input.qty > 0) || remainingQty <= QTY_EPSILON) return 0
  const remainingNet = Math.max(0, roundTo(input.line.net - input.prior.net, 4))
  if (input.qty >= remainingQty - QTY_EPSILON) return remainingNet
  const share = roundTo((remainingNet * input.qty) / remainingQty, input.minorUnits)
  return Math.min(remainingNet, Math.max(0, share))
}

/**
 * The same cut in the BASE column. A base-currency order posts this column, so it is cut from the base remainder in the same way;
 * for a foreign order the base figure follows the foreign one at the order's booked rate, capped at what is left.
 */
export function refundableBase(input: {
  line: RefundableLine
  prior: PriorRefunds
  qty: number
  /** The foreign net this refund was just cut to. */
  foreignNet: number
  fxRateToBase: number
  minorUnits: number
}): number {
  const remainingQty = input.line.qty - input.prior.qty
  if (!(input.qty > 0) || remainingQty <= QTY_EPSILON) return 0
  const remainingBase = Math.max(0, roundTo(input.line.net - input.prior.net, 4))
  if (input.qty >= remainingQty - QTY_EPSILON) return remainingBase
  const viaRate = input.fxRateToBase === 1 ? input.foreignNet : roundTo(input.foreignNet / (input.fxRateToBase || 1), 4)
  return Math.min(remainingBase, Math.max(0, viaRate))
}

/**
 * THE SHARE OF THE ORDER DISCOUNT A REFUND REVERSES. The invoice posts the discount as its own negative line and the sale lines at their
 * pre-discount nets, so refunding sale lines must give back the refunded share of the discount: discount (net) x refunded sale net / the order's
 * sale net, less what earlier refunds already reversed, and the refund that completes the order's sale lines takes exactly the remainder.
 * One function for the refund service (under the order lock) and the dialog preview, so the two cannot drift.
 */
export function orderDiscountReversal(input: {
  /** SalesOrder.discountAmount, in the order's own currency and convention. */
  discountAmount: number
  /** Whether that convention includes VAT (storedAmountsIncludeVat) and the order's default rate, to strip it to NET. */
  amountsIncludeVat: boolean
  vatRate: number
  orderSaleNet: number
  /** Sale net and discount already reversed by earlier refunds (discount as positive numbers). */
  priorSaleNet: number
  priorDiscountForeign: number
  priorDiscountBase: number
  /** The sale-line net this refund takes. */
  refundedSaleNet: number
  fxRateToBase: number
  minorUnits: number
}): { foreign: number; base: number } {
  const round4 = (n: number) => Math.round((n + Number.EPSILON * Math.sign(n)) * 10000) / 10000
  if (!(input.discountAmount > 0) || !(input.refundedSaleNet > 0)) return { foreign: 0, base: 0 }
  const discountNet = round4(input.amountsIncludeVat && input.vatRate > 0 ? input.discountAmount / (1 + input.vatRate) : input.discountAmount)
  const fx = input.fxRateToBase || 1
  const remainingForeign = Math.max(0, round4(discountNet - input.priorDiscountForeign))
  const remainingBase = Math.max(0, round4((fx === 1 ? discountNet : discountNet / fx) - input.priorDiscountBase))
  const completes = input.priorSaleNet + input.refundedSaleNet >= input.orderSaleNet - 0.005
  if (completes || !(input.orderSaleNet > 0)) return { foreign: remainingForeign, base: remainingBase }
  const foreign = Math.min(
    remainingForeign,
    refundableNet({ line: { qty: 1, net: discountNet }, prior: { qty: 0, net: 0 }, qty: input.refundedSaleNet / input.orderSaleNet, minorUnits: input.minorUnits }),
  )
  const base = Math.min(remainingBase, fx === 1 ? foreign : round4(foreign / fx))
  return { foreign, base }
}
