/**
 * THE TAX CODE ON A SALES DOCUMENT IS A DECISION, NEVER A DEFAULT.
 *
 * The Xero connector used to send `NONE` ("No VAT") on any sales invoice or credit-note line that arrived
 * without a tax type. That made a missing mapping, an unresolved rate, or a rate row whose code had been
 * cleared indistinguishable from "this line carries no VAT" - and on an EU sale that was charged VAT the
 * result is a document that silently books the VAT as turnover-free. A missing code now REFUSES, and
 * `NONE` itself is only accepted on a line that names WHY it carries no tax.
 *
 * TWO WAYS A LINE REACHES `NONE`, BOTH CLOSED HERE
 *
 *   1. By default: `line.taxType || 'NONE'`. Removed from the connectors; an absent or blank code is a problem.
 *   2. By configuration: a mapped rate whose own code is literally `NONE` (WooCommerce rate 182, "Taxes & Duties",
 *      is mapped that way). Removing the default alone would not catch it, so an explicit `NONE` is a problem
 *      too, unless the line carries one of the named kinds below.
 *
 * WHAT A NAMED KIND IS. A line kind whose accounting treatment IS "outside the VAT return" by design, decided
 * by the code that builds the line - never inferred from the rate. A kind is added here only together with the
 * producer that sets it, so the list is exactly the set of lines IMS can currently emit on `NONE`. The EU
 * IOSS/VOEC/DDP work adds its own (the recovered-VAT line, marked landed-cost fees, store-credit and gift-card
 * lines) in the changes that start producing those lines.
 *
 * Shipping and the order-level discount can never be a named kind: they must carry a real tax type.
 *
 * Pure: no database, no network. The connectors, the poster and the importer all call this one function, so
 * the importer's view of a document and the connector's cannot drift.
 */

/** Xero's "No VAT" code. Compared case-insensitively and trimmed, as Xero treats it. */
export const NO_TAX_TYPE = 'NONE'

/**
 * Line kinds allowed to post on `NONE`.
 *
 *   - `fee-no-tax`: a WooCommerce FEE line the shop charged no tax on and named no tax rate for (a legacy untaxed
 *     fee, or the over-threshold non-taxable import duty). Left to the order default it would pick up the
 *     order's taxable code and Xero would add VAT to a line the shop charged none on, so the importer decides
 *     it and says so (resolveWcLineAccountingTaxType `forceNoTax`).
 */
export const SALES_NO_TAX_LINE_KINDS = ['fee-no-tax'] as const
export type SalesNoTaxLineKind = (typeof SALES_NO_TAX_LINE_KINDS)[number]

export function isSalesNoTaxLineKind(value: unknown): value is SalesNoTaxLineKind {
  return typeof value === 'string' && (SALES_NO_TAX_LINE_KINDS as readonly string[]).includes(value)
}

/** True for `NONE` in any case, with surrounding whitespace ignored. */
export function isNoTaxType(taxType: string | null | undefined): boolean {
  return typeof taxType === 'string' && taxType.trim().toUpperCase() === NO_TAX_TYPE
}

export type SalesDocumentTaxTypeProblem = {
  /** Where on the document: `line 2 "Widget"`, `shipping`, `order discount`. */
  where: string
  kind: 'missing' | 'explicit-none'
}

type TaxTypedLine = { description?: unknown; taxType?: unknown; noTaxKind?: unknown }

export type SalesDocumentTaxTypeInput = {
  lines?: ReadonlyArray<TaxTypedLine> | null
  shippingAmount?: unknown
  shippingAccountCode?: unknown
  shippingTaxType?: unknown
  discountAmount?: unknown
  discountAccountCode?: unknown
  discountTaxType?: unknown
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

function isPositive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function lineLabel(line: TaxTypedLine, index: number): string {
  const description = typeof line.description === 'string' ? line.description.trim() : ''
  return description ? `line ${index + 1} "${description}"` : `line ${index + 1}`
}

/**
 * Every part of a sales invoice or credit note that would reach the ledger without a decided tax code.
 *
 * Shipping and the discount are only inspected when the connector would actually emit them (a positive amount),
 * (a positive amount AND an account code: the Xero builder drops either one without the other), because a line that
 * is not sent has no code to get wrong. A credit note has neither field and is covered by
 * the same function.
 */
/**
 * WHICH OF A SALES DOCUMENT'S SHIPPING AND DISCOUNT LINES THE CONNECTOR WILL ACTUALLY SEND. One decision, used by the Xero builder when it assembles the
 * lines, by the tax-type check below and by the invoice-to-order reconciliation, so what is checked is exactly what goes out: an amount with no account
 * code is dropped by the builder, and a reconciliation that counted it would pass an invoice short of that money.
 */
export type SalesDocumentExtras = Pick<SalesDocumentTaxTypeInput, 'shippingAmount' | 'shippingAccountCode' | 'discountAmount' | 'discountAccountCode'>

export function connectorEmitsShipping<T extends SalesDocumentExtras>(doc: T): doc is T & { shippingAmount: number; shippingAccountCode: string } {
  return isPositive(doc.shippingAmount) && !isBlank(doc.shippingAccountCode)
}

export function connectorEmitsDiscount<T extends SalesDocumentExtras>(doc: T): doc is T & { discountAmount: number; discountAccountCode: string } {
  return isPositive(doc.discountAmount) && !isBlank(doc.discountAccountCode)
}

/** The mapping setting an amount is waiting on when the connector would drop it (a positive amount with no account code), else null. */
export function droppedExtraMapping(doc: SalesDocumentExtras): 'shipping' | 'discount' | null {
  if (isPositive(doc.shippingAmount) && !connectorEmitsShipping(doc)) return 'shipping'
  if (isPositive(doc.discountAmount) && !connectorEmitsDiscount(doc)) return 'discount'
  return null
}

export function findSalesDocumentTaxTypeProblems(doc: SalesDocumentTaxTypeInput): SalesDocumentTaxTypeProblem[] {
  const problems: SalesDocumentTaxTypeProblem[] = []
  const lines = Array.isArray(doc.lines) ? doc.lines : []
  lines.forEach((line, index) => {
    if (isBlank(line.taxType)) {
      problems.push({ where: lineLabel(line, index), kind: 'missing' })
    } else if (isNoTaxType(line.taxType as string) && !isSalesNoTaxLineKind(line.noTaxKind)) {
      problems.push({ where: lineLabel(line, index), kind: 'explicit-none' })
    }
  })
  for (const [where, emitted, taxType] of [
    ['shipping', connectorEmitsShipping(doc), doc.shippingTaxType],
    ['order discount', connectorEmitsDiscount(doc), doc.discountTaxType],
  ] as const) {
    if (!emitted) continue
    if (isBlank(taxType)) problems.push({ where, kind: 'missing' })
    else if (isNoTaxType(taxType as string)) problems.push({ where, kind: 'explicit-none' })
  }
  return problems
}

/**
 * The operator-facing refusal, or `null` when every part carries a decided code. The text names each part and
 * says what to fix; it is the `error` of an ordinary failed sync row, so it shows on /sync.
 */
export function describeSalesDocumentTaxTypeRefusal(
  document: string,
  problems: ReadonlyArray<SalesDocumentTaxTypeProblem>,
): string | null {
  if (problems.length === 0) return null
  const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.where)
  const none = problems.filter((p) => p.kind === 'explicit-none').map((p) => p.where)
  const parts: string[] = []
  if (missing.length > 0) parts.push(`no tax type on ${missing.join(', ')}`)
  if (none.length > 0) parts.push(`"No VAT" (NONE) on ${none.join(', ')}, which is not a line kind allowed to carry it`)
  return (
    `NOTHING WAS SENT. ${document} was refused: ${parts.join('; ')}. IMS never posts a sales line on "No VAT" by default - `
    + `a missing code is a mapping fault, and an explicit "No VAT" is only accepted on a line that names why it carries no tax. `
    + `Map the tax rate to a real accounting tax type in IMS (or, for a rate that is deliberately NONE, give it a real type), `
    + `then re-import or re-queue the document.`
  )
}

/** Convenience for the poster and the connectors: the refusal text for a document, or `null` to proceed. */
export function salesDocumentTaxTypeRefusal(document: string, doc: SalesDocumentTaxTypeInput): string | null {
  return describeSalesDocumentTaxTypeRefusal(document, findSalesDocumentTaxTypeProblems(doc))
}
