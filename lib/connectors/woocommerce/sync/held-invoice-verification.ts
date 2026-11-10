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
export function heldInvoiceDifference(parked: Record<string, unknown>, expected: ExpectedHeldInvoice, treated: boolean): string | null {
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
  if (treated) {
    const total = predictedUntaxedTotal(parked as unknown as TreatablePayload)
    const order = num(expected.orderTotal)
    if (total === null || order === null) return 'the parked invoice total or the order total cannot be read'
    if (!total.eq(roundMoney(order, expected.currency))) return `the parked invoice totals ${total.toString()} but the order now totals ${order.toString()}`
  }
  return null
}

export type { TreatableLine }
