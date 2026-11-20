/**
 * THE ORDER DISCOUNT'S TAX, SPLIT BY THE RATE OF THE LINES IT DISCOUNTS.
 *
 * With `sales_order_discount_tax_apportion_enabled` on, a manual order's discount is taxed at its lines' own rates (see buildSalesOrderWriteModel) instead of the header rate. The order then
 * stores that split (SalesOrder.discountTaxSplit), and EVERY consumer reads this one record, so the invoice, the reconciliation, the refund reversal and the VAT report cannot disagree
 * with the tax the order carries: none of them re-derives it. An order without the record (every order written with the switch off, every WooCommerce order) keeps the header-rate
 * treatment everywhere; nothing here applies to it.
 *
 * Pure: no database, no clock, no setting.
 */
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

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

const round = (value: DecimalInput, places: number): number => roundQuantity(value, places).toNumber()

/** The same group key everywhere: a rate id, else its fraction. */
export function discountSplitKey(entry: { taxRateId: string | null; rate: number }): string {
  return entry.taxRateId ?? `rate:${entry.rate}`
}

/**
 * Groups the per-line discount shares (NET, foreign) by line rate. The totals are pinned to the header figures the order stores (`totalNetForeign`, `totalTaxForeign`, the same rounded
 * figures), the last group taking any rounding difference, so the split always sums to exactly what the header subtracted.
 */
export function buildDiscountTaxSplit(input: {
  lines: ReadonlyArray<{ taxRateId: string | null; accountingTaxType: string | null; reverseCharge: boolean; rate: number }>
  /** NET discount share of each line, order currency (allocateOrderDiscountBase). */
  shares: ReadonlyArray<DecimalInput>
  fxRate: number
  totalNetForeign: number
  totalTaxForeign: number
  totalNetBase: number
  totalTaxBase: number
}): DiscountTaxSplitEntry[] {
  const groups = new Map<string, { entry: Omit<DiscountTaxSplitEntry, 'netBase' | 'taxBase' | 'taxForeign'>; tax: ReturnType<typeof toDecimal> }>()
  input.lines.forEach((line, i) => {
    const share = toDecimal(input.shares[i] ?? 0)
    if (!share.gt(0)) return
    const key = discountSplitKey(line)
    const group = groups.get(key) ?? {
      entry: { taxRateId: line.taxRateId, accountingTaxType: line.accountingTaxType, reverseCharge: line.reverseCharge, rate: line.rate, netForeign: 0 },
      tax: toDecimal(0),
    }
    group.entry.netForeign = round(toDecimal(group.entry.netForeign).add(share), 4)
    group.tax = group.tax.add(share.mul(line.rate))
    groups.set(key, group)
  })
  const entries = [...groups.values()].map((g) => ({ ...g.entry, taxForeign: round(g.tax, 4) }))
  if (entries.length === 0) return []
  const last = entries[entries.length - 1]!
  const netGap = toDecimal(input.totalNetForeign).sub(entries.reduce((s, e) => s.add(e.netForeign), toDecimal(0)))
  last.netForeign = round(toDecimal(last.netForeign).add(netGap), 4)
  const taxGap = toDecimal(input.totalTaxForeign).sub(entries.reduce((s, e) => s.add(e.taxForeign), toDecimal(0)))
  last.taxForeign = round(toDecimal(last.taxForeign).add(taxGap), 4)
  const fx = input.fxRate || 1
  const withBase = entries.map((e) => ({ ...e, netBase: round(toDecimal(e.netForeign).div(fx), 4), taxBase: round(toDecimal(e.taxForeign).div(fx), 4) }))
  const lastBase = withBase[withBase.length - 1]!
  lastBase.netBase = round(toDecimal(lastBase.netBase).add(toDecimal(input.totalNetBase).sub(withBase.reduce((s, e) => s.add(e.netBase), toDecimal(0)))), 4)
  lastBase.taxBase = round(toDecimal(lastBase.taxBase).add(toDecimal(input.totalTaxBase).sub(withBase.reduce((s, e) => s.add(e.taxBase), toDecimal(0)))), 4)
  return withBase
}

/** Reads the stored JSON back; null for anything that is not a well-formed split (an order priced the header-rate way, or an unreadable value: the consumers then keep the header-rate treatment, never guess). */
export function parseDiscountTaxSplit(value: unknown): DiscountTaxSplitEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: DiscountTaxSplitEntry[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    const nums = ['rate', 'netForeign', 'taxForeign', 'netBase', 'taxBase'].map((k) => Number(r[k]))
    if (nums.some((n) => !Number.isFinite(n))) return null
    out.push({
      taxRateId: typeof r.taxRateId === 'string' ? r.taxRateId : null,
      accountingTaxType: typeof r.accountingTaxType === 'string' ? r.accountingTaxType : null,
      reverseCharge: r.reverseCharge === true,
      rate: nums[0]!, netForeign: nums[1]!, taxForeign: nums[2]!, netBase: nums[3]!, taxBase: nums[4]!,
    })
  }
  return out
}

/**
 * The split as the INVOICE posts it: one negative discount line per tax code, each carrying the discount's tax at that code. `amount` is in the document's own basis (gross when the
 * lines are sent inclusive of VAT, else net), rounded to the minor unit the ledger works to; the last part takes the rounding so the parts sum to exactly `totalAmount` (the single
 * discount figure the document already carries). Parts on the same posted code are merged.
 */
export function invoiceDiscountParts(input: {
  split: ReadonlyArray<DiscountTaxSplitEntry>
  lineAmountsIncludeTax: boolean
  /** The document's discount, rounded to the minor unit, that the parts must sum to. */
  totalAmount: number
  /** The code a split entry is sent on (its rate's code, after the reverse-charge swap), or null when none is known. */
  taxTypeOf: (entry: DiscountTaxSplitEntry) => string | null
}): { amount: number; taxType: string | null; taxRateId: string | null }[] {
  const merged = new Map<string, { amount: ReturnType<typeof toDecimal>; taxType: string | null; taxRateId: string | null }>()
  for (const entry of input.split) {
    const taxType = input.taxTypeOf(entry)
    const key = taxType ?? `rate:${discountSplitKey(entry)}`
    const part = merged.get(key) ?? { amount: toDecimal(0), taxType, taxRateId: entry.taxRateId }
    part.amount = part.amount.add(input.lineAmountsIncludeTax ? toDecimal(entry.netForeign).add(entry.taxForeign) : entry.netForeign)
    merged.set(key, part)
  }
  const parts = [...merged.values()].map((p) => ({ amount: round(p.amount, 2), taxType: p.taxType, taxRateId: p.taxRateId }))
  if (parts.length === 0) return []
  const gap = toDecimal(input.totalAmount).sub(parts.reduce((s, p) => s.add(p.amount), toDecimal(0)))
  // The rounding difference lands on the largest part, so no part can be pushed below zero by it.
  let largest = 0
  parts.forEach((p, i) => { if (p.amount > parts[largest]!.amount) largest = i })
  parts[largest]!.amount = round(toDecimal(parts[largest]!.amount).add(gap), 2)
  return parts.filter((p) => p.amount > 0)
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
