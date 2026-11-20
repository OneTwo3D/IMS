/**
 * THE PURE-NUMBER HALF OF THE ORDER DISCOUNT'S PER-RATE SPLIT (see discount-tax-split.ts): the entry type, its group key and the refund reversal plan.
 * No Decimal runtime and no imports: the refund dialog (a client component, through sales-order-money-view.ts) reads this module, and anything that reaches the Prisma client
 * pulls `node:module` into the browser bundle and breaks the build. Keep it import-free.
 */
export type DiscountTaxSplitEntry = {
  taxRateId: string | null
  /** The rate's own accounting tax code (before any reverse-charge swap), as the order lines resolve it. */
  accountingTaxType: string | null
  reverseCharge: boolean
  /** A fraction (0.2 = 20%). */
  rate: number
  /** The NET of the discount that falls on lines at this rate, and the VAT it carries, in the order currency and in base. */
  netForeign: number
  taxForeign: number
  netBase: number
  taxBase: number
}

/** The same group key everywhere: a rate id, else its fraction. */
export function discountSplitKey(entry: { taxRateId: string | null; rate: number }): string {
  return entry.taxRateId ?? `rate:${entry.rate}`
}

/**
 * WHAT A REFUND REVERSES OF AN APPORTIONED ORDER DISCOUNT, PER TAX RATE.
 *
 * An order whose discount was taxed at its lines' rates posted the discount as one negative line per rate, so a refund gives back each rate's discount in proportion to the sale net it refunds
 * AT THAT RATE (the same cut `orderDiscountReversal` makes for the whole discount, applied to each rate's own share and its own lines), and the refund that completes a rate's lines takes
 * exactly what is left of that rate's share. The credit note then credits the right VAT per rate, because each reversal posts under its own rate's code. One function for the refund service
 * (under the order lock) and the dialog preview.
 */
export function planSplitDiscountReversal(input: {
  split: ReadonlyArray<DiscountTaxSplitEntry>
  /** The order's lines: id, rate id and NET (order currency). */
  lines: ReadonlyArray<{ id: string; taxRateId: string | null; totalForeign: number }>
  /** The refunded sale-line nets of THIS refund, by order line id. */
  refundedNetByLine: ReadonlyMap<string, number>
  /** Earlier refund rows: sale rows name their line; discount rows name the rate group they reversed (null on a row of the header-rate treatment). */
  prior: ReadonlyArray<{ lineKind: string | null; salesOrderLineId: string | null; discountTaxRateId: string | null; totalForeign: number; totalBase: number }>
  fxRateToBase: number
  minorUnits: number
  /** `orderDiscountReversal`, passed in so this module stays free of the refund arithmetic's imports. */
  reversal: (input: { discountNet: number; orderSaleNet: number; priorSaleNet: number; priorDiscountForeign: number; priorDiscountBase: number; refundedSaleNet: number }) => { foreign: number; base: number }
}): Array<{ entry: DiscountTaxSplitEntry; foreign: number; base: number }> {
  const out: Array<{ entry: DiscountTaxSplitEntry; foreign: number; base: number }> = []
  for (const entry of input.split) {
    const groupLines = input.lines.filter((l) => l.taxRateId === entry.taxRateId)
    const ids = new Set(groupLines.map((l) => l.id))
    const refundedSaleNet = groupLines.reduce((s, l) => s + (input.refundedNetByLine.get(l.id) ?? 0), 0)
    if (!(refundedSaleNet > 0)) continue
    const priorSaleNet = input.prior.filter((p) => p.lineKind !== 'discount' && p.lineKind !== 'shipping' && p.salesOrderLineId !== null && ids.has(p.salesOrderLineId)).reduce((s, p) => s + p.totalForeign, 0)
    const priorDiscounts = input.prior.filter((p) => p.lineKind === 'discount' && p.discountTaxRateId !== null && p.discountTaxRateId === (entry.taxRateId ?? ''))
    const result = input.reversal({
      discountNet: entry.netForeign,
      orderSaleNet: groupLines.reduce((s, l) => s + l.totalForeign, 0),
      priorSaleNet,
      priorDiscountForeign: -priorDiscounts.reduce((s, p) => s + p.totalForeign, 0),
      priorDiscountBase: -priorDiscounts.reduce((s, p) => s + p.totalBase, 0),
      refundedSaleNet,
    })
    if (result.foreign > 0 || result.base > 0) out.push({ entry, foreign: result.foreign, base: result.base })
  }
  return out
}
