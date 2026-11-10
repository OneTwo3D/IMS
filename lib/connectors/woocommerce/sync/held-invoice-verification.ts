/**
 * A HELD SALES INVOICE IS CHECKED AGAINST THE ORDER BEFORE IT IS RELEASED OR TREATED (pure).
 *
 * An invoice held for a missing invoice number can wait days. WooCommerce can change the order meanwhile (a line edited, a fee added, shipping or tax changed), and the parked payload is frozen: "only the number is added on release". Posting it would put a
 * receivable in the ledger at figures the order no longer has, on a regime the order may no longer be in. So, with the Sales Invoices switch on, the parked payload is compared with the order as it is NOW, and any difference keeps the hold PENDING: it is
 * never released and never treated, and its reason says the order changed after it was held and needs its invoice rebuilt.
 *
 * WHAT IS COMPARED. The payload carries no WooCommerce line item id, so a line's identity is its position and its description, quantity, unit amount and line discount, which the importer derives from the order's own line and fee items in a fixed order (goods, then fees);
 * each is compared with what the order gives now. Also: the fee markers (a no-tax fee line stays a no-tax fee line), the shipping amount and the order-level discount; and, for a treated hold, that the lines beyond the order's own are exactly the VAT line and
 * the rounding line the treatment adds, and that the document still totals the order. A payload that does not carry what is needed to compare (a missing or unreadable figure) cannot be verified and does not match: fail closed.
 */
import { predictedUntaxedTotal, type TreatableLine, type TreatablePayload } from '@/lib/domain/accounting/eu-vat-treatment'
import { roundMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

export type ExpectedHeldLine = { description: string; quantity: number; unitAmount: number; discountAmount: number; untaxedFee: boolean; markedFee: boolean }
export type ExpectedHeldInvoice = {
  lines: readonly ExpectedHeldLine[]
  /** What the importer would send now: the shipping amount (undefined when none) and the order-level discount (undefined when none). */
  shippingAmount: number | undefined
  discountAmount: number | undefined
  orderTotal: string
  currency: string
}

const num = (value: unknown): Decimal | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? toDecimal(value) : null
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return toDecimal(value.trim())
  return null
}
const same = (a: unknown, b: number | undefined): boolean => {
  const left = a === undefined || a === null ? toDecimal(0) : num(a)
  return left !== null && left.eq(toDecimal(b ?? 0))
}
const NAMED_EXTRA_KINDS = ['eu-vat-recovery', 'rounding-difference']

/** null when the parked payload still matches the order; otherwise the first difference, as a sentence fragment. */
export function heldInvoiceDifference(
  parked: Record<string, unknown>,
  expected: ExpectedHeldInvoice,
  treated: boolean,
  /**
   * Whether the parked document is on zero-tax types (the scheme and B2B routes), so its lines sum to the order's total. An ordinary taxed invoice (route none) books net plus tax by the codes it is sent on, so
   * its untaxed sum is not the order's VAT-inclusive total and is not compared here; its total is compared by the caller from the order total recorded in the marker.
   */
  untaxedTotal: boolean = treated,
): string | null {
  // The currency every parked figure is in must be the order's currency now: a held invoice never releases in a currency the order has left.
  const parkedCurrency = typeof parked.currency === 'string' ? parked.currency.trim().toUpperCase() : ''
  if (parkedCurrency !== expected.currency.trim().toUpperCase()) return `the parked invoice is in ${parkedCurrency === '' ? '(no currency)' : parkedCurrency} but the order is now in ${expected.currency}`
  const lines = parked.lines
  if (!Array.isArray(lines)) return 'the parked payload has no readable lines'
  if (lines.length < expected.lines.length) return `the parked invoice has ${lines.length} line(s) but the order has ${expected.lines.length}`
  for (const [index, want] of expected.lines.entries()) {
    const line = lines[index] as Record<string, unknown> | null
    const label = `line ${index + 1} "${want.description}"`
    if (line === null || typeof line !== 'object') return `${label} is not readable in the parked invoice`
    if (line.description !== want.description) return `${label}: the parked description is "${String(line.description)}"`
    if (!same(line.quantity, want.quantity)) return `${label}: the parked quantity is ${String(line.quantity)}, the order's is ${want.quantity}`
    if (!same(line.unitAmount, want.unitAmount)) return `${label}: the parked unit amount is ${String(line.unitAmount)}, the order's is ${want.unitAmount}`
    if (!same(line.discountAmount, want.discountAmount > 0 ? want.discountAmount : undefined)) return `${label}: the parked discount is ${String(line.discountAmount ?? 0)}, the order's is ${want.discountAmount}`
    const noTax = line.noTaxKind === 'fee-no-tax'
    const wantNoTax = want.untaxedFee || (treated && want.markedFee)
    if (noTax !== wantNoTax) return `${label}: its no-tax fee marking differs from the order's`
    // The landed-cost fee marker is its own identity, apart from the no-tax status: a fee whose marker was removed from the order while held must not be released on the fee account (the treatment records the marker on the line).
    if ((line.euFeeMarked === true) !== (treated && want.markedFee)) return `${label}: its landed-cost fee marker differs from the order's`
  }
  const extras = lines.slice(expected.lines.length) as Array<Record<string, unknown> | null>
  if (!treated && extras.length > 0) return `the parked invoice has ${extras.length} line(s) the order does not`
  const kinds = extras.map((line) => (line !== null && typeof line === 'object' ? line.noTaxKind : undefined))
  if (kinds.some((kind) => typeof kind !== 'string' || !NAMED_EXTRA_KINDS.includes(kind)) || new Set(kinds).size !== kinds.length) {
    return 'the parked invoice carries a line beyond the order’s lines that is not the treatment’s VAT or rounding line'
  }
  if (!same(parked.shippingAmount, expected.shippingAmount)) return `the parked shipping is ${String(parked.shippingAmount ?? 0)}, the order's is ${expected.shippingAmount ?? 0}`
  if (!same(parked.discountAmount, expected.discountAmount)) return `the parked order discount is ${String(parked.discountAmount ?? 0)}, the order's is ${expected.discountAmount ?? 0}`
  if (untaxedTotal) {
    const total = predictedUntaxedTotal(parked as unknown as TreatablePayload)
    const order = num(expected.orderTotal)
    if (total === null || order === null) return 'the parked invoice total or the order total cannot be read'
    if (!total.eq(roundMoney(order, expected.currency))) return `the parked invoice totals ${total.toString()} but the order now totals ${order.toString()}`
  }
  return null
}

/**
 * The tax binding of a TREATED hold against the order now: the WooCommerce rate id of every line and of the shipping, and the accounting tax type each rate resolves to, must be what was recorded when the invoice was parked (before the treatment re-typed
 * any line). Equal-value lines that exchange tax classes change the ids; a re-mapped rate changes the type. A marker that recorded nothing (or a rate that is no longer mapped) cannot be verified and does not match.
 */
export function heldTaxBindingDifference(
  recorded: unknown,
  current: { lineRateIds: ReadonlyArray<number | null>; shippingRateIds: readonly number[]; resolved: Readonly<Record<string, { type: string | null; mapped: boolean }>> },
): string | null {
  if (typeof recorded !== 'object' || recorded === null) return 'the tax binding of the parked invoice was not recorded, so its tax cannot be verified'
  const r = recorded as { lineRateIds?: unknown; shippingRateIds?: unknown; resolved?: unknown }
  if (!Array.isArray(r.lineRateIds) || !Array.isArray(r.shippingRateIds) || typeof r.resolved !== 'object' || r.resolved === null) return 'the recorded tax binding of the parked invoice is unreadable'
  const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])
  if (!sameList(r.lineRateIds, current.lineRateIds)) return 'the tax rates on the order\u2019s lines changed (for example two lines exchanged tax classes)'
  if (!sameList(r.shippingRateIds, current.shippingRateIds)) return 'the tax rates on the order\u2019s shipping changed'
  for (const [id, type] of Object.entries(r.resolved as Record<string, unknown>)) {
    const now = current.resolved[id]
    if (now === undefined || !now.mapped) return `WooCommerce tax rate ${id} can no longer be resolved to an IMS rate`
    if (now.type !== type) return `WooCommerce tax rate ${id} now posts on ${String(now.type)}, not ${String(type)} as when the invoice was held`
  }
  return null
}

/**
 * The tax types of an UNTREATED hold against the order now: each parked line's tax type must be the one the order's line resolves to (`expected[i]`, computed by the caller with the invoice builder's own resolution; null = not verifiable, such as a line naming
 * no tax rate), and the parked shipping type must be one the shipping's rates resolve to.
 */
export function heldUntreatedTaxDifference(
  parked: Record<string, unknown>,
  expected: ReadonlyArray<string | null>,
  shippingTypes: readonly string[],
): string | null {
  const lines = Array.isArray(parked.lines) ? (parked.lines as Array<Record<string, unknown> | null>) : []
  for (const [index, want] of expected.entries()) {
    if (want === null) continue
    const taxType = lines[index]?.taxType
    if (typeof taxType !== 'string' || taxType.trim().toUpperCase() !== want.trim().toUpperCase()) return `line ${index + 1}: the parked tax type is ${String(taxType)}, the order's line now resolves to ${want}`
  }
  if (shippingTypes.length > 0 && Number(parked.shippingAmount ?? 0) > 0) {
    const shipping = typeof parked.shippingTaxType === 'string' ? parked.shippingTaxType.trim().toUpperCase() : ''
    if (!shippingTypes.some((t) => t.trim().toUpperCase() === shipping)) return `the parked shipping tax type is ${shipping || '(none)'}, the order's shipping now resolves to ${shippingTypes.join(' or ')}`
  }
  return null
}

export type { TreatableLine }
