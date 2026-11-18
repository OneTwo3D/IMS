import { multiplyMoney, roundMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * A supplier bill's NET PAYABLE: what is actually owed to the supplier.
 *
 * IMS keeps the reverse-charge VAT in the bill's stored tax and total (net 100 shows 120) because the VAT return needs it, while the ledger
 * holds the bill at 100 and the supplier is owed 100. The stored totals are deliberately NOT changed; this figure sits beside them. It is
 * the stored total less the VAT of each line booked as reverse charge (the line's net x its rate, rounded per line as the ledger does).
 * A line booked before the treatment was recorded carries no reverse-charge flag and counts at the stored total, so a bill without any
 * reverse-charge line has a net payable equal to its stored total.
 *
 * Every reader that asks "how much is owed on this bill" (the payment amount, the settlement verdict, the AP revaluation balance, the
 * cancellation credit gate, the return-draft credit ceiling) uses this, never the stored total. The VAT-return and display readers keep the stored total.
 */
export type NetPayableLine = { totalForeign: DecimalInput; taxRateValue?: DecimalInput | null; taxReverseCharge?: boolean | null }
export type NetPayableBill = { totalForeign: DecimalInput; totalBase: DecimalInput; lines?: ReadonlyArray<NetPayableLine> | null }

/** The VAT the bill accounts for itself (reverse-charge lines only), foreign currency. Zero when the bill has none. */
export function billReverseChargeVatForeign(lines: ReadonlyArray<NetPayableLine> | null | undefined, currency: string): Decimal {
  let vat = toDecimal(0)
  for (const l of lines ?? []) {
    if (l.taxReverseCharge !== true) continue
    vat = vat.add(roundMoney(multiplyMoney(l.totalForeign, l.taxRateValue ?? 0), currency))
  }
  return vat
}

/** What is owed to the supplier on the bill, foreign currency; never negative and never above the stored total. */
export function billNetPayableForeign(bill: NetPayableBill, currency: string): Decimal {
  const total = toDecimal(bill.totalForeign)
  const net = total.sub(billReverseChargeVatForeign(bill.lines, currency))
  return net.lt(0) ? toDecimal(0) : net.gt(total) ? total : net
}

/** The same, in base currency: the stored base total prorated by the payable share (one rate per bill). Equal to the stored base total when nothing is self-accounted. */
export function billNetPayableBase(bill: NetPayableBill, currency: string): Decimal {
  const total = toDecimal(bill.totalForeign)
  if (!total.gt(0)) return toDecimal(bill.totalBase)
  const net = billNetPayableForeign(bill, currency)
  if (net.eq(total)) return toDecimal(bill.totalBase)
  return toDecimal(bill.totalBase).mul(net).div(total)
}
