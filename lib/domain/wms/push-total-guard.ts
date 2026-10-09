import { roundTransmittedMoney } from '@/lib/connectors/wms/transmitted-money'
import { currencyMinorUnits, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * Penny-precision guard on the warehouse order PAYLOAD (pure, Decimal arithmetic).
 *
 * Question it answers: "do the figures we are about to send add up to the order total we hold?" The
 * warehouse derives its own gross from the order lines, the shipping and discount figures and the VAT total
 * (the plugin comment: "Mintsoft will compute it from items + shipping - discount"), so a payload
 * whose parts do not add up is stored there as a different order from the one the customer paid for.
 * `orderTotalDriftPence` (order-push-sweep.ts) checks the order against its OWN stored components;
 * this checks the thing actually SENT, so it also sees what the payload builder drops or re-labels.
 *
 *   pushedGross   = SUM(qty * unitPriceExVat) + shippingExVat - discountExVat + totalVat
 *   expectedGross = order total - gross value of any line quantity withheld from the payload (refunds)
 *
 * TotalVat is taken as the VAT authority because it is what the payload states. How completely the VAT
 * is itemised across lines/shipping/discount is reported separately (`vatItemisationGap`) and is NOT a
 * penny mismatch: it is a different, structural property of the payload.
 *
 * TOLERANCE follows the plugin's `_drift_bound`: WooCommerce stores each line/shipping/fee amount rounded
 * to the minor unit but computes the order total from unrounded figures, so the rounding of independent
 * amounts ACCUMULATES. Every stored amount that appears in the comparison may sit half a minor unit from
 * the truth: the net of each line, the shipping and discount ex-VAT figures, the VAT total and the order
 * total (plus net and VAT of any refunded line). VAT amounts that are NOT in the comparison add no slack. The bound is that sum, capped at
 * MAX_ROUNDING_BOUND_MINOR_UNITS (the plugin's observed worst real case, 13p). A guard that flagged
 * ordinary rounding would train operators to ignore it, so a drift inside the bound is WITHIN_ROUNDING and
 * is not surfaced.
 *
 * The guard is ADVISORY by owner decision (measure first): it never changes or blocks a payload.
 */

/** The plugin's absolute ceiling on accumulated rounding drift, in minor units (13p for GBP). */
export const MAX_ROUNDING_BOUND_MINOR_UNITS = 13

export { PAYLOAD_TOTALS_DECIMALS } from '@/lib/connectors/wms/transmitted-money'
export { PUSH_TOTAL_MISMATCH_OPERATOR_NOTE } from './push-total-mismatch-note'

export type PushTotalsInput = {
  currency: string
  /** The order's stored gross total (what the customer was charged). */
  orderTotal: DecimalInput
  /** Gross value of line quantity deliberately left OUT of the payload (refunded units). */
  withheldGoodsGross?: DecimalInput
  /** How many lines contribute to withheldGoodsGross (each adds a stored net and a stored VAT to the expected side). */
  withheldLineCount?: number
  /**
   * Store credit applied to the order, GROSS. A payment, so the order total is LOWER than the goods the
   * payload states by exactly this: the payload carries the full goods value.
   */
  storeCreditGross?: DecimalInput
  /** The figures as the payload builder produced them. */
  payload: {
    lines: Array<{ quantity: number; unitPriceExVat: number; unitPriceVat: number }>
    totalVat: number
    shippingExVat: number
    shippingVat: number
    discountExVat: number
    discountVat: number
  }
  /** Needed only to NAME the cause of a mismatch. */
  pricesIncludeVat?: boolean
}

export type PushTotalsCause = 'DISCOUNT_VAT_NOT_SPLIT' | 'UNEXPLAINED'

export type PushTotalsVerdict = {
  /** RECONCILED: exact. WITHIN_ROUNDING: inside the accumulated-rounding bound. MISMATCH: outside it. */
  status: 'RECONCILED' | 'WITHIN_ROUNDING' | 'MISMATCH'
  pushedGross: string
  expectedGross: string
  /** pushedGross - expectedGross, signed. */
  drift: string
  /** |drift| in whole minor units (HALF_UP); what the exceptions page shows. */
  driftMinorUnits: number
  /** The rounding bound this order was allowed, in minor units (may be fractional). */
  boundMinorUnits: string
  /** TotalVat minus the VAT itemised on lines, shipping and discount. Informational. */
  vatItemisationGap: string
  /** Only for MISMATCH. */
  cause: PushTotalsCause | null
  /** Only for MISMATCH: operator-facing, built from the evidence above. */
  reason: string | null
}

function sumDecimals(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.add(v), toDecimal(0))
}

/** Half a minor unit per independently rounded amount, per the plugin's drift bound. */
export function roundingBoundMinorUnits(operandCount: number): Decimal {
  const bound = toDecimal(operandCount).div(2)
  const cap = toDecimal(MAX_ROUNDING_BOUND_MINOR_UNITS)
  return bound.gt(cap) ? cap : bound
}

export function reconcilePushTotals(input: PushTotalsInput): PushTotalsVerdict {
  const { currency, payload } = input
  const precision = currencyMinorUnits(currency)
  const unit = toDecimal(10).pow(-precision)
  // The payload rounds its shipping, discount and VAT totals with the connector's own function (shared, so
  // the two cannot diverge): float Math.round to 2dp whatever the order currency. The guard takes the OUTPUT of
  // that function and does its arithmetic on it in Decimal; it never re-rounds the input itself.
  const money = (v: number) => toDecimal(roundTransmittedMoney(v))

  const goodsNet = sumDecimals(payload.lines.map((l) => toDecimal(l.quantity).mul(toDecimal(l.unitPriceExVat))))
  const goodsVat = sumDecimals(payload.lines.map((l) => toDecimal(l.quantity).mul(toDecimal(l.unitPriceVat))))
  const shippingExVat = money(payload.shippingExVat)
  const shippingVat = money(payload.shippingVat)
  const discountExVat = money(payload.discountExVat)
  const discountVat = money(payload.discountVat)
  const totalVat = money(payload.totalVat)

  const pushedGross = goodsNet.add(shippingExVat).sub(discountExVat).add(totalVat)
  const expectedGross = toDecimal(input.orderTotal).add(toDecimal(input.storeCreditGross ?? 0)).sub(toDecimal(input.withheldGoodsGross))
  const drift = pushedGross.sub(expectedGross)

  const itemisedVat = goodsVat.add(shippingVat).sub(discountVat)
  const vatItemisationGap = totalVat.sub(itemisedVat)

  // Independently rounded amounts that APPEAR IN THE COMPARISON, and only those: the net of each pushed
  // line, the shipping and discount ex-VAT figures when present, the VAT total (one aggregate figure; the
  // per-line and shipping/discount VAT amounts are not part of pushedGross), the order total, and the net
  // and VAT of each line whose refunded units are subtracted from the expected side.
  const operands =
    payload.lines.length
    + (shippingExVat.isZero() ? 0 : 1)
    + (discountExVat.isZero() ? 0 : 1)
    + 1 // totalVat
    + 1 // order total
    + 2 * (input.withheldLineCount ?? 0)
  const bound = roundingBoundMinorUnits(operands)
  const driftMinor = drift.abs().div(unit)

  let status: PushTotalsVerdict['status']
  if (driftMinor.lt(0.5)) status = 'RECONCILED' // rounds to zero minor units
  else if (driftMinor.lte(bound)) status = 'WITHIN_ROUNDING'
  else status = 'MISMATCH'
  const driftMinorUnits = roundQuantity(driftMinor, 0).toNumber()

  let cause: PushTotalsCause | null = null
  let reason: string | null = null
  if (status === 'MISMATCH') {
    cause = 'UNEXPLAINED'
    // A VAT-inclusive order stores its order-level discount GROSS; the payload carries it in the
    // ex-VAT field with no VAT part, so the pushed gross is short/long by exactly the embedded VAT.
    if (input.pricesIncludeVat && !discountExVat.isZero() && discountVat.isZero()) {
      const rate = totalVat.gt(0) && expectedGross.gt(totalVat) ? totalVat.div(expectedGross.sub(totalVat)) : null
      if (rate && rate.gt(0)) {
        const embedded = discountExVat.mul(rate).div(rate.add(1))
        if (drift.abs().sub(embedded).abs().lte(bound.mul(unit))) cause = 'DISCOUNT_VAT_NOT_SPLIT'
      }
    }
    const direction = drift.gt(0) ? 'more' : 'less'
    const amount = drift.abs().toFixed(precision)
    reason =
      `The figures sent to the warehouse add up to ${pushedGross.toFixed(precision)} ${currency}, `
      + `${amount} ${direction} than the expected ${expectedGross.toFixed(precision)} ${currency}`
      + ` (allowed rounding: ${bound.mul(unit).toFixed(precision + 1)}).`
      + (cause === 'DISCOUNT_VAT_NOT_SPLIT'
        ? ' This order has an order-level discount on a VAT-inclusive order, which is sent as one figure with no VAT part; the difference matches that discount\'s VAT.'
        : '')
  }

  return {
    status,
    pushedGross: pushedGross.toFixed(precision + 4),
    expectedGross: expectedGross.toFixed(precision),
    drift: drift.toFixed(precision + 4),
    driftMinorUnits,
    boundMinorUnits: bound.toString(),
    vatItemisationGap: vatItemisationGap.toFixed(precision),
    cause,
    reason,
  }
}

/**
 * Gross value (net + VAT) of the line quantity the payload leaves out because it was refunded, so the
 * expected total can be reduced by exactly that. Per line: refunded fraction of ordered quantity times
 * the line's stored net + VAT; refunds beyond the ordered quantity count only up to it.
 */
export function withheldGoodsGross(
  lines: Array<{ id?: string; qty: unknown; totalForeign: unknown; taxForeign: unknown }>,
  refundedByLine: Map<string, number> | undefined,
): Decimal {
  let sum = toDecimal(0)
  for (const line of lines) {
    const refunded = (line.id && refundedByLine?.get(line.id)) || 0
    if (refunded <= 0) continue
    const ordered = toDecimal(line.qty as DecimalInput)
    const orderedQty = ordered.isZero() ? toDecimal(1) : ordered // buildLines treats qty 0 as 1
    const refundedQty = toDecimal(refunded)
    const withheldQty = refundedQty.lt(orderedQty) ? refundedQty : orderedQty
    sum = sum.add(withheldQty.div(orderedQty).mul(toDecimal(line.totalForeign as DecimalInput).add(toDecimal(line.taxForeign as DecimalInput))))
  }
  return sum
}

/** Number of lines whose refunded units are subtracted by withheldGoodsGross. */
export function withheldLineCount(
  lines: Array<{ id?: string }>,
  refundedByLine: Map<string, number> | undefined,
): number {
  return lines.filter((line) => ((line.id && refundedByLine?.get(line.id)) || 0) > 0).length
}
