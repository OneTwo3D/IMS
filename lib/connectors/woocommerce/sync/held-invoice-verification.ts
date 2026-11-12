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
 * The tax binding of a TREATED hold against the order now: EVERY input recorded when it was parked (lib/connectors/woocommerce/sync/wc-tax-binding.ts lists them) must be what the order resolves to now, and so must each line's and the shipping's
 * effective tax type. A marker that recorded nothing, a rate no longer mapped, or anything unreadable cannot be verified and does not match.
 */
export function heldTaxBindingDifference(recorded: unknown, current: unknown): string | null {
  if (typeof recorded !== 'object' || recorded === null) return 'the tax binding of the parked invoice was not recorded, so its tax cannot be verified'
  const r = recorded as Record<string, unknown>
  const c = current as Record<string, unknown>
  if (!Array.isArray(r.lineRateIds) || !Array.isArray(r.shippingRateIds) || typeof r.rates !== 'object' || r.rates === null || !Array.isArray(r.lines) || typeof r.shipping !== 'object' || r.shipping === null || typeof r.discount !== 'object' || r.discount === null || typeof r.reverseChargeSalesTaxType !== 'string') {
    return 'the recorded tax binding of the parked invoice is unreadable'
  }
  // Key order is not part of the value: the recorded binding comes back from a jsonb column, which orders keys by length.
  const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val !== null && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val))
  const same = (a: unknown, b: unknown) => canon(a) === canon(b)
  // THE OUTPUTS FIRST: what the invoice builder's own function resolves each line and the shipping to (the rate, where it came from, the posted type). Any difference, or a line that no longer resolves where it did, is a change.
  const wasLines = r.lines as Array<unknown>
  const nowLines = (Array.isArray(c.lines) ? c.lines : []) as Array<unknown>
  if (wasLines.length !== nowLines.length) return `the invoice now has ${nowLines.length} lines, the hold ${wasLines.length}`
  for (const [index, was] of wasLines.entries()) {
    if (!same(was, nowLines[index])) return `line ${index + 1}: the resolved tax rate and type changed from ${JSON.stringify(was)} to ${JSON.stringify(nowLines[index])}`
  }
  if (!same(r.shipping, c.shipping)) return `the shipping's resolved tax rate and type changed from ${JSON.stringify(r.shipping)} to ${JSON.stringify(c.shipping)}`
  if (!same(r.discount, c.discount)) return `the order discount's resolved tax rate and type changed from ${JSON.stringify(r.discount)} to ${JSON.stringify(c.discount)}`
  // Then the inputs, which say why.
  if (!same(r.lineRateIds, c.lineRateIds)) return 'the tax rates on the order\u2019s lines changed (for example two lines exchanged tax classes)'
  if (!same(r.shippingRateIds, c.shippingRateIds)) return 'the tax rates on the order\u2019s shipping changed'
  if (r.reverseChargeSalesTaxType !== c.reverseChargeSalesTaxType) return `the reverse-charge sales tax type setting changed from "${r.reverseChargeSalesTaxType}" to "${String(c.reverseChargeSalesTaxType)}"`
  const nowRates = (c.rates ?? {}) as Record<string, Record<string, unknown>>
  for (const [id, was] of Object.entries(r.rates as Record<string, Record<string, unknown>>)) {
    const now = nowRates[id]
    if (now === undefined) return `WooCommerce tax rate ${id} can no longer be resolved`
    if (now.mapped !== true) return `WooCommerce tax rate ${id} can no longer be resolved to an IMS rate`
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!same(was[key], now[key])) return `WooCommerce tax rate ${id}: ${key} changed from ${JSON.stringify(was[key])} to ${JSON.stringify(now[key])}`
    }
  }
  return null
}

/**
 * The tax types of an UNTREATED hold against the order now: each parked line's tax type must be exactly the effective type the invoice builder's own function resolves for the line now (every input, the reverse-charge setting and the category/default
 * selection included), and the parked shipping type the one it resolves for the shipping.
 */
export function heldUntreatedTaxDifference(
  parked: Record<string, unknown>,
  current: { lines: ReadonlyArray<{ type: string | null }>; shipping: { type: string | null }; discount: { type: string | null } },
): string | null {
  const parkedLines = Array.isArray(parked.lines) ? (parked.lines as Array<Record<string, unknown> | null>) : []
  const norm = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : null)
  // NO SKIPS: a line the order's function resolves to no type must have been parked with none, and one it resolves to a type must carry that type.
  for (const [index, want] of current.lines.entries()) {
    const parkedType = norm(parkedLines[index]?.taxType)
    if (parkedType !== norm(want.type)) return `line ${index + 1}: the parked tax type is ${parkedType ?? '(none)'}, the order's line now resolves to ${norm(want.type) ?? '(none)'}`
  }
  // The shipping line is sent only with a positive amount; then its parked type must be the one the order's shipping resolves to now.
  if (Number(parked.shippingAmount ?? 0) > 0 && norm(parked.shippingTaxType) !== norm(current.shipping.type)) {
    return `the parked shipping tax type is ${norm(parked.shippingTaxType) ?? '(none)'}, the order's shipping now resolves to ${norm(current.shipping.type) ?? '(none)'}`
  }
  // The order-level discount is sent only with a positive amount; then its parked type must be the one the order default resolves to now.
  if (Number(parked.discountAmount ?? 0) > 0 && norm(parked.discountTaxType) !== norm(current.discount.type)) {
    return `the parked discount tax type is ${norm(parked.discountTaxType) ?? '(none)'}, the order's discount now resolves to ${norm(current.discount.type) ?? '(none)'}`
  }
  return null
}

export type { TreatableLine }

/**
 * THE AUTHORITY: A PARKED INVOICE AGAINST A FRESH BUILD OF THE SAME DOCUMENT FROM THE CURRENT ORDER (pure).
 *
 * The per-fact checks above name what they were written to catch; a document has more inputs than any list remembers. The importer's own builder is run again on the order as it is now (lines, shipping, discount, fees,
 * tax types, the treatment, the payment legs) and the result is compared with the parked payload on EVERY field, so an input nobody listed cannot slip through. Only identity and timing fields are left out: the contact, dates and
 * reference, the FX stamp and the receipt's identity. The treatment marker is left out too (its facts are checked above and its effects are in the lines). Returns the path of the first difference, or null when they are the same.
 */
const FRESH_COMPARE_EXCLUDED = new Set(['contactName', 'contactEmail', 'date', 'reference', 'currencyRateToBase', 'invoiceNumber', '_postingMode', '_paymentMethod', '_paymentDate', '_paymentSettlementRateToBase', '_paymentId', '_euVatTreatment'])

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonical(v)
    }
    return out
  }
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
}

const firstDifference = (parked: unknown, fresh: unknown, path: string): string | null => {
  if (Array.isArray(parked) || Array.isArray(fresh)) {
    if (!Array.isArray(parked) || !Array.isArray(fresh)) return path
    if (parked.length !== fresh.length) return `${path} (${parked.length} entries parked, ${fresh.length} now)`
    for (let i = 0; i < parked.length; i++) {
      const d = firstDifference(parked[i], fresh[i], `${path}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  if (parked !== null && fresh !== null && typeof parked === 'object' && typeof fresh === 'object') {
    const keys = [...new Set([...Object.keys(parked as object), ...Object.keys(fresh as object)])].sort()
    for (const key of keys) {
      const d = firstDifference((parked as Record<string, unknown>)[key], (fresh as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`)
      if (d !== null) return d
    }
    return null
  }
  return parked === fresh ? null : path
}

export function heldFreshBuildDifference(parked: Record<string, unknown>, fresh: Record<string, unknown>): string | null {
  const keep = (payload: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload)) if (!FRESH_COMPARE_EXCLUDED.has(key)) out[key] = value
    return canonical(JSON.parse(JSON.stringify(out))) as Record<string, unknown>
  }
  const path = firstDifference(keep(parked), keep(fresh), '')
  return path === null ? null : `the parked invoice differs from the invoice the order produces now at ${path}`
}
