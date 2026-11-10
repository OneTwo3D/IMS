/**
 * THE TAX CODE ON A SUPPLIER BILL OR SUPPLIER CREDIT NOTE IS A DECISION, NEVER A DEFAULT.
 *
 * The purchase-side twin of lib/domain/accounting/sales-document-tax-types.ts (IOSS PR 1). The Xero connector used
 * to send `NONE` ("No VAT") on any bill or supplier-credit-note line that arrived without a tax type, and the bill
 * builder itself left the type blank on every line it could not decide (a vatable cost line with no supplier
 * default rate, a goods line with neither its own rate nor a supplier default). A missing mapping was therefore
 * indistinguishable from "this line carries no VAT", and input VAT recorded in IMS was silently not claimed in Xero.
 * A blank code now REFUSES, and `NONE` itself is only accepted on a line that names WHY it carries no tax.
 *
 * NAMED KINDS. Each is a decision made by the code that builds the line, never inferred from a blank:
 *   - `cost-not-vatable`: a bill cost line (freight, duty, handling) the order flags as not vatable.
 *   - `no-vat-rate`: the line's configured rate (or the supplier's default rate, or the offset bill's treatment on a
 *     supplier credit note) is itself "No VAT" - a deliberate configuration, not an absence.
 *
 * Pure: no database, no network. The producers, the poster and the connectors all call this one module.
 */

import { isNoTaxType } from './sales-document-tax-types'

export const PURCHASE_NO_TAX_LINE_KINDS = ['cost-not-vatable', 'no-vat-rate'] as const
export type PurchaseNoTaxLineKind = (typeof PURCHASE_NO_TAX_LINE_KINDS)[number]

export function isPurchaseNoTaxLineKind(value: unknown): value is PurchaseNoTaxLineKind {
  return typeof value === 'string' && (PURCHASE_NO_TAX_LINE_KINDS as readonly string[]).includes(value)
}

export type PurchaseDocumentTaxTypeProblem = {
  /** Where on the document: `line 2 "Freight"`. */
  where: string
  kind: 'missing' | 'explicit-none'
}

type TaxTypedLine = { description?: unknown; taxType?: unknown; noTaxKind?: unknown }

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

function lineLabel(line: TaxTypedLine, index: number): string {
  const description = typeof line.description === 'string' ? line.description.trim() : ''
  return description ? `line ${index + 1} "${description}"` : `line ${index + 1}`
}

/** Every line of a bill or supplier credit note that would reach the ledger without a decided tax code. */
export function findPurchaseDocumentTaxTypeProblems(doc: { lines?: ReadonlyArray<TaxTypedLine> | null }): PurchaseDocumentTaxTypeProblem[] {
  const problems: PurchaseDocumentTaxTypeProblem[] = []
  const lines = Array.isArray(doc.lines) ? doc.lines : []
  lines.forEach((line, index) => {
    if (isBlank(line.taxType)) problems.push({ where: lineLabel(line, index), kind: 'missing' })
    else if (isNoTaxType(line.taxType as string) && !isPurchaseNoTaxLineKind(line.noTaxKind)) {
      problems.push({ where: lineLabel(line, index), kind: 'explicit-none' })
    }
  })
  return problems
}

/** The operator-facing refusal, or `null` when every line carries a decided code. It is the `error` of an ordinary failed sync row, so it shows on /sync. */
export function describePurchaseDocumentTaxTypeRefusal(
  document: string,
  problems: ReadonlyArray<PurchaseDocumentTaxTypeProblem>,
): string | null {
  if (problems.length === 0) return null
  const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.where)
  const none = problems.filter((p) => p.kind === 'explicit-none').map((p) => p.where)
  const parts: string[] = []
  if (missing.length > 0) parts.push(`no tax type on ${missing.join(', ')}`)
  if (none.length > 0) parts.push(`"No VAT" (NONE) on ${none.join(', ')}, which does not say why it carries no tax`)
  return (
    `NOTHING WAS SENT. ${document} was refused: ${parts.join('; ')}. IMS never posts a supplier line on "No VAT" by default - `
    + `a missing code means the input VAT recorded in IMS would not be claimed in the ledger. `
    + `Give the supplier a default VAT rate (or the purchase order line its own rate) that is mapped to a real accounting tax type, `
    + `then edit and save the bill again so it is queued with the corrected tax type.`
  )
}

/** Convenience for the poster and the connectors: the refusal text for a document, or `null` to proceed. */
export function purchaseDocumentTaxTypeRefusal(document: string, doc: { lines?: ReadonlyArray<TaxTypedLine> | null }): string | null {
  return describePurchaseDocumentTaxTypeRefusal(document, findPurchaseDocumentTaxTypeProblems(doc))
}

/** The named kind for a line whose decided type came out as NONE from a configured rate, else undefined. */
export function noVatRateKind(taxType: string | null | undefined): PurchaseNoTaxLineKind | undefined {
  return isNoTaxType(taxType) ? 'no-vat-rate' : undefined
}
