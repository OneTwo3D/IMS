/**
 * Which ledger document is THE customer invoice (or credit note) for an order, from what the ledger holds
 * under its number. Pure: the lookup that produced `claims` is lib/connectors/xero/invoice-number-claim.ts
 * (or the credit-note equivalent), which has already refused anything it could not prove complete.
 *
 * The ledger document is created by another writer (the sales invoicing incumbent), so this module never
 * assumes there is exactly one. It selects a document only when the answer is unambiguous, WAITS when the
 * document is not issued yet, and asks for a person when the ledger's answer cannot be trusted to name one
 * document. It never picks "the first" or "the newest": which of two live documents the customer should
 * see is a finance question.
 *
 * Selecting a document by number is NOT proof that it is THIS order's: that is order-evidence.ts.
 */

export type DocumentClaim = {
  /** The ledger's id for the document. */
  documentId: string
  documentNumber: string
  /** Ledger status: DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED. */
  status: string
  /** What the ledger says about the document, when it says: read by the order-evidence check. */
  total?: number
  reference?: string
  contactName?: string
  currencyCode?: string
  dateString?: string
  /** The ledger's last-modified stamp for the document. */
  updatedDateUtc?: string
}

export type ClaimSelection =
  | { outcome: 'select'; claim: DocumentClaim }
  /** Nothing to fetch yet; ask again later. */
  | { outcome: 'wait'; reason: string }
  /** The ledger's answer needs a person; never retried on its own. */
  | { outcome: 'attention'; reason: string }

const LIVE = new Set(['AUTHORISED', 'PAID'])
const NOT_ISSUED = new Set(['DRAFT', 'SUBMITTED'])
const KNOWN = new Set([...LIVE, ...NOT_ISSUED, 'VOIDED', 'DELETED'])

/**
 * `orderCancelled` is whether IMS holds the order as cancelled. A voided document is the customer's only when the order
 * itself is cancelled: on an active order a voided invoice is a document the ledger withdrew, usually to re-issue, and showing
 * it would show the customer a cancelled invoice for an order that is live. There it is waited for (and escalated if the
 * replacement never comes).
 */
export function selectDocumentClaim(claims: readonly DocumentClaim[], label: string, options: { orderCancelled: boolean }): ClaimSelection {
  const normalised = claims.map((claim) => ({ claim, status: claim.status.trim().toUpperCase() }))
  const unknown = normalised.filter((entry) => !KNOWN.has(entry.status))
  if (unknown.length > 0) {
    return {
      outcome: 'attention',
      reason: `${label}: the ledger reports a status IMS does not know (${unknown.map((entry) => entry.status).join(', ')}), so it cannot tell which document is the customer's`,
    }
  }
  // A deleted document is gone from the customer's point of view.
  const present = normalised.filter((entry) => entry.status !== 'DELETED')
  const live = present.filter((entry) => LIVE.has(entry.status))
  const notIssued = present.filter((entry) => NOT_ISSUED.has(entry.status))
  const voided = present.filter((entry) => entry.status === 'VOIDED')

  if (live.length === 1) return { outcome: 'select', claim: live[0].claim }
  if (live.length > 1) {
    return { outcome: 'attention', reason: `${label}: ${live.length} live documents hold this number in the ledger, so IMS will not choose one` }
  }
  if (notIssued.length > 0) {
    return { outcome: 'wait', reason: `${label}: the ledger document is still ${notIssued.map((entry) => entry.status).join('/')}, not issued yet` }
  }
  if (voided.length > 0) {
    if (!options.orderCancelled) {
      return { outcome: 'wait', reason: `${label}: the only document under this number is voided and the order is not cancelled, so IMS waits for the replacement` }
    }
    if (voided.length === 1) return { outcome: 'select', claim: voided[0].claim }
    return { outcome: 'attention', reason: `${label}: ${voided.length} voided documents and no live one hold this number, so IMS will not choose one` }
  }
  return { outcome: 'wait', reason: `${label}: the ledger holds no document under this number yet` }
}

/**
 * Do two readings of the SAME ledger document agree on every field the ownership check and the selection rest on? Used after the PDF is
 * downloaded: the document is re-read and must still be the document that passed (same id, status, total, currency, customer,
 * reference, date and last-modified stamp). Any difference means the ledger changed it between the check and the download, so the
 * bytes are discarded and the next pass starts again.
 */
export function ownershipFingerprintsMatch(before: DocumentClaim, after: DocumentClaim): boolean {
  const norm = (value: string | undefined) => (value ?? '').trim().toLowerCase()
  return before.documentId === after.documentId
    && norm(before.status) === norm(after.status)
    && before.total === after.total
    && norm(before.currencyCode) === norm(after.currencyCode)
    && norm(before.contactName) === norm(after.contactName)
    && norm(before.reference) === norm(after.reference)
    && norm(before.dateString) === norm(after.dateString)
    && norm(before.updatedDateUtc) === norm(after.updatedDateUtc)
}
