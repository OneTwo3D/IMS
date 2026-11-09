/**
 * Is this ledger document THIS order's? A number alone does not say: the storefront's invoice number is not unique in IMS
 * and the ledger's number filter answers for whatever holds the number. So a selected document is stored and shown only when
 * the ledger's own record of it agrees with the order on independent keys. Pure.
 *
 * What the document carries that is independent of its number (all optional in the ledger's answer):
 *   total          the gross total, in the document's currency. For an invoice the order's total in the order currency; the
 *                  strongest key, and REQUIRED to match (a document that does not report one cannot be tied to the order).
 *   currency       must agree when both state one.
 *   reference      free text the invoicing writer fills; matched against the order's own numbers (storefront and IMS) on token
 *                  boundaries. The invoicing writer's format is not verified here, so this is used when it matches, never required.
 *   contact        the customer name, compared normalised.
 *   date           within a tolerance of the order's date.
 * Beyond the total (and currency) at least `minCorroboration` of reference / contact / date must agree. A credit note has no gross
 * total to compare (a refund stores net amounts), so it needs two of the three.
 */

import type { DocumentClaim } from './claim-selection'

export type EvidenceSubject = {
  /** The order's own numbers as a customer or the invoicing writer would write them (storefront order number, IMS order number). */
  orderNumbers: readonly string[]
  customerName: string | null
  currency: string
  /** The gross total the document must carry, or null when it cannot be derived. */
  expectedTotal: number | null
  anchorDate: Date
  dateToleranceDays: number
  /** How many of reference / contact / date must agree. */
  minCorroboration: number
}

export type EvidenceResult = { ok: true; matched: string[] } | { ok: false; reason: string }

export const TOTAL_TOLERANCE = 0.02

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function referenceMentions(reference: string, orderNumber: string): boolean {
  const token = orderNumber.trim().replace(/^#/, '').toLowerCase()
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])#?${escaped}($|[^a-z0-9])`).test(reference.toLowerCase())
}

function withinDays(dateString: string, anchor: Date, days: number): boolean {
  const at = new Date(dateString)
  if (Number.isNaN(at.getTime())) return false
  return Math.abs(at.getTime() - anchor.getTime()) <= days * 86_400_000
}

export function assessDocumentEvidence(subject: EvidenceSubject, claim: DocumentClaim): EvidenceResult {
  const matched: string[] = []

  if (subject.expectedTotal !== null) {
    if (typeof claim.total !== 'number') return { ok: false, reason: 'the ledger did not report the document total, so it cannot be tied to this order' }
    if (Math.abs(claim.total - subject.expectedTotal) > TOTAL_TOLERANCE) {
      return { ok: false, reason: `the ledger document totals ${claim.total} and the order totals ${subject.expectedTotal}: it may belong to a different order` }
    }
    matched.push('total')
  }
  if (claim.currencyCode && claim.currencyCode.toUpperCase() !== subject.currency.toUpperCase()) {
    return { ok: false, reason: `the ledger document is in ${claim.currencyCode} and the order is in ${subject.currency}` }
  }
  if (claim.currencyCode) matched.push('currency')

  const corroboration: string[] = []
  if (claim.reference && subject.orderNumbers.some((number) => referenceMentions(claim.reference!, number))) corroboration.push('reference')
  if (claim.contactName && subject.customerName && normaliseName(claim.contactName) !== '' && normaliseName(claim.contactName) === normaliseName(subject.customerName)) corroboration.push('contact')
  if (claim.dateString && withinDays(claim.dateString, subject.anchorDate, subject.dateToleranceDays)) corroboration.push('date')

  if (corroboration.length < subject.minCorroboration) {
    return {
      ok: false,
      reason: `only ${corroboration.length} of the reference, customer and date agree between the ledger document and the order (${subject.minCorroboration} needed), so it cannot be tied to this order`,
    }
  }
  return { ok: true, matched: [...matched, ...corroboration] }
}
