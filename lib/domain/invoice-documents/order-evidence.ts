/**
 * Is this ledger document THIS order's? A number does not say: the storefront's invoice number is not unique in IMS and the
 * ledger's number filter answers for whatever holds the number. So a selected document is stored and shown only when the
 * ledger's own record of it agrees with the order on independent keys. Pure.
 *
 * REQUIRED, all of them:
 *   currency   the ledger must REPORT one, and it must equal the order's. A document that states no currency cannot be tied to the
 *              order's money.
 *   total      (invoice) the gross total, within 0.02, and the ledger must report it. A credit note has no gross total to compare (a
 *              refund stores net amounts).
 *   identity   the customer name (normalised) OR the order reference (the ledger's Reference text contains the order's storefront or
 *              IMS order number, on token boundaries) must match.
 * AND NO CONFLICT: if the ledger states a customer and it differs from the order's, or states a reference that does not mention
 * the order, the document needs a person EVEN IF another key matches. Same number, total, currency and date with an explicitly
 * different customer is a different order's invoice.
 * The date is supporting evidence only: it is reported as matched when it falls inside the tolerance and never decides.
 *
 * KNOWN LIMIT (unverified): what the invoicing writer puts in the ledger's Reference field and Contact name. If its Reference is
 * not the order number, or the Contact is a company where the order has a person, the conflict rules refuse every such document
 * until a person looks; that is the safe direction for a document shown to a customer.
 */

import { toDecimal } from '@/lib/domain/math/decimal'
import type { DocumentClaim } from './claim-selection'

export type EvidenceSubject = {
  /** The order's own numbers as a customer or the invoicing writer would write them (storefront order number, IMS order number). */
  orderNumbers: readonly string[]
  customerName: string | null
  currency: string
  /** The gross total the document must carry, or null when it cannot be derived (a credit note). */
  expectedTotal: number | null
  anchorDate: Date
  dateToleranceDays: number
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

  if (!claim.currencyCode) return { ok: false, reason: 'the ledger did not report the document currency, so it cannot be tied to this order' }
  if (claim.currencyCode.toUpperCase() !== subject.currency.toUpperCase()) {
    return { ok: false, reason: `the ledger document is in ${claim.currencyCode} and the order is in ${subject.currency}` }
  }
  matched.push('currency')

  if (subject.expectedTotal !== null) {
    if (typeof claim.total !== 'number') return { ok: false, reason: 'the ledger did not report the document total, so it cannot be tied to this order' }
    if (Math.abs(claim.total - subject.expectedTotal) > TOTAL_TOLERANCE) {
      return { ok: false, reason: `the ledger document totals ${claim.total} and the order totals ${subject.expectedTotal}: it may belong to a different order` }
    }
    matched.push('total')
  }

  const orderName = subject.customerName ? normaliseName(subject.customerName) : ''
  const docName = claim.contactName ? normaliseName(claim.contactName) : ''
  const customerStated = docName !== '' && orderName !== ''
  const customerMatches = customerStated && docName === orderName
  const referenceStated = Boolean(claim.reference && claim.reference.trim())
  const referenceMatches = referenceStated && subject.orderNumbers.some((number) => referenceMentions(claim.reference!, number))

  // An explicit conflict is a refusal whatever else agrees.
  if (customerStated && !customerMatches) {
    return { ok: false, reason: `the ledger document is for "${claim.contactName}" and the order is for "${subject.customerName}": it may belong to a different order` }
  }
  if (referenceStated && !referenceMatches) {
    return { ok: false, reason: `the ledger document's reference "${claim.reference}" does not mention this order: it may belong to a different order` }
  }
  if (!customerMatches && !referenceMatches) {
    return { ok: false, reason: 'neither the customer nor the order reference is stated by the ledger, so the document cannot be tied to this order' }
  }
  if (customerMatches) matched.push('contact')
  if (referenceMatches) matched.push('reference')
  if (claim.dateString && withinDays(claim.dateString, subject.anchorDate, subject.dateToleranceDays)) matched.push('date')
  return { ok: true, matched }
}

export type ExpectedInvoiceGross = { ok: true; total: number } | { ok: false; reason: string }

/**
 * The gross the LEDGER invoice states for an order. The WooCommerce import records `totalForeign` as what the customer PAID, which is
 * after store credit (Smart Coupons credit, wallet, gift card: all kept on `storeCreditForeign`), while the invoice states the FULL goods
 * value and the credit is settled against it as a payment (store-credit-invoice-refusal.ts). The importer proves
 * lines + tax + shipping - order discount - credit = total before it accepts the credit (checkWcStoreCreditReconciles), so the invoice
 * gross is `totalForeign + storeCreditForeign`.
 *
 * That identity is only trusted for an order whose credit was ASSESSED by the importer. Credit that was never assessed, or an order held
 * for store-credit review, has no total IMS can vouch for, and the document needs a person rather than being compared with a guess.
 */
export function expectedInvoiceGross(order: { totalForeign: unknown; storeCreditForeign: unknown; storeCreditAssessment: unknown }): ExpectedInvoiceGross {
  if (order.storeCreditAssessment === 'REVIEW_REQUIRED') {
    return { ok: false, reason: 'the order is held for store-credit review, so the gross its invoice states cannot be derived' }
  }
  let credit
  try {
    credit = toDecimal(order.storeCreditForeign as string | number)
  } catch {
    return { ok: false, reason: 'the order\'s store-credit amount is unreadable, so the gross its invoice states cannot be derived' }
  }
  if (!credit.isFinite()) return { ok: false, reason: 'the order\'s store-credit amount is unreadable, so the gross its invoice states cannot be derived' }
  if (credit.gt(0) && order.storeCreditAssessment !== 'ASSESSED') {
    return { ok: false, reason: 'the order carries store credit that the import never assessed, so the gross its invoice states cannot be derived' }
  }
  return { ok: true, total: toDecimal(order.totalForeign as string | number).add(credit).toNumber() }
}
