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
import { discountSplitKey, type DiscountTaxSplitEntry } from '@/lib/domain/sales/discount-tax-split-plan'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { isNoTaxType } from '@/lib/domain/accounting/sales-document-tax-types'

export { discountSplitKey, type DiscountTaxSplitEntry }

const round = (value: DecimalInput, places: number): number => roundQuantity(value, places).toNumber()

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
}): { amount: number; taxType: string | null; taxRateId: string | null }[] | null {
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
  // Only a rounding penny per part is absorbed. A split that disagrees with the discount by more (stale or corrupt JSON, a net/gross mismatch) is refused, never spread onto one rate.
  if (gap.abs().gt(toDecimal('0.01').mul(parts.length).add('0.000001'))) return null
  // The rounding difference lands on the largest part, so no part can be pushed below zero by it.
  let largest = 0
  parts.forEach((p, i) => { if (p.amount > parts[largest]!.amount) largest = i })
  parts[largest]!.amount = round(toDecimal(parts[largest]!.amount).add(gap), 2)
  return parts.filter((p) => p.amount > 0)
}

/**
 * THE TAX CODE ONE GROUP OF THE SPLIT IS POSTED ON, the ONE derivation shared by the invoice (its discount parts), the refund (its per-rate discount reversal) and the save / finalise
 * refusal below, so none of them can name a different code for the same group. It is the goods line's own rule (queueSalesInvoiceForOrder): the group's rate code, else the order default
 * rate's code (a group with no code of its own is the lines that fell back to the order default), then the reverse-charge swap. Null when neither gives a code.
 */
export function discountSplitEntryTaxType(
  entry: Pick<DiscountTaxSplitEntry, 'accountingTaxType' | 'reverseCharge'>,
  ctx: { orderDefaultTaxType: string | null | undefined; reverseChargeSalesTaxType: string | null | undefined },
): string | null {
  return resolveSalesLineTaxType({ baseTaxType: entry.accountingTaxType ?? ctx.orderDefaultTaxType ?? null, reverseCharge: entry.reverseCharge, reverseChargeSalesTaxType: ctx.reverseChargeSalesTaxType }) ?? null
}

/**
 * THE SPLIT WITH EACH GROUP'S CODE READ FROM ITS RATE NOW. An entry's `accountingTaxType` is a snapshot taken when the order was saved, so a draft saved while its rate had no accounting tax code
 * would stay refused after the operator mapped the rate. The goods lines read their rate's code live (queueSalesInvoiceForOrder), so the finalisation check and the invoice build read the split's
 * the same way: `codeByRateId` holds the current code of every rate id the split names (a rate absent from the map keeps its stored code; an entry with no rate id, the no-rate lines, has none to refresh).
 */
export function refreshDiscountSplitCodes(split: ReadonlyArray<DiscountTaxSplitEntry>, codeByRateId: ReadonlyMap<string, string | null>): DiscountTaxSplitEntry[] {
  return split.map((entry) => (entry.taxRateId !== null && codeByRateId.has(entry.taxRateId) ? { ...entry, accountingTaxType: codeByRateId.get(entry.taxRateId) ?? null } : entry))
}

const pct = (rate: number): string => `${toDecimal(rate).mul(100).toDecimalPlaces(4).toString()}%`

/** Where a refusal is shown: it decides how the message ends (what the operator can do next), never what it says is wrong. */
export type DiscountSplitRefusalContext = 'live-save' | 'finalise' | 'invoice'

/**
 * The refusal of a split with a group that has NO tax code to post its share of the discount on (discountSplitEntryTaxType answers null, or the explicit `NONE` code, which no discount part may carry),
 * or null. Such a group is, in practice, the lines with no tax rate of a discounted order whose default rate does not resolve to a rate with a code, or lines at a rate nobody has mapped yet: its
 * invoice would carry a discount part (and goods lines) with no tax code and be refused at the sync processor ("NOTHING WAS SENT"), so a live order is refused when it is saved or finalised instead.
 * Stricter than the invoice (which drops a part that rounds to nothing), never weaker. `context` picks the ending: a live save can fall back to a draft, a finalisation to fixing the mapping, and the
 * invoice build (whose error adds its own ending) to none.
 */
export function discountSplitTaxCodeRefusal(
  split: ReadonlyArray<DiscountTaxSplitEntry> | null,
  ctx: { orderDefaultTaxType: string | null | undefined; reverseChargeSalesTaxType: string | null | undefined },
  context: DiscountSplitRefusalContext = 'invoice',
): string | null {
  if (!split) return null
  const uncoded = split.filter((entry) => {
    const code = discountSplitEntryTaxType(entry, ctx)
    return code === null || isNoTaxType(code)
  })
  if (uncoded.length === 0) return null
  const groups = [...new Set(uncoded.map((entry) => (entry.taxRateId ? `the lines at ${pct(entry.rate)}` : `the lines with no tax rate (${pct(entry.rate)})`)))]
  const problem = `The order discount is taxed per line rate, but ${groups.join(' and ')} have no accounting tax code, so the invoice could not post their share of the discount (or the lines) and would be refused when it is sent.`
  if (context === 'live-save') return `${problem} Choose an order default VAT rate that has an accounting tax code, or give those lines a tax rate that has one, and try again. A draft can still be saved.`
  if (context === 'finalise') return `${problem} Map the tax rate to an accounting tax code (the draft is read again when it is finalised, so it need not be re-saved), or edit the draft to choose an order default VAT rate that has a code, then finalise it again.`
  return problem
}
