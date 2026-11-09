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
 */

export type DocumentClaim = {
  /** The ledger's id for the document. */
  documentId: string
  documentNumber: string
  /** Ledger status: DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED. */
  status: string
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

export function selectDocumentClaim(claims: readonly DocumentClaim[], label: string): ClaimSelection {
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
  // Only voided documents: a cancelled order's invoice is still the customer's document.
  if (voided.length === 1) return { outcome: 'select', claim: voided[0].claim }
  if (voided.length > 1) {
    return { outcome: 'attention', reason: `${label}: ${voided.length} voided documents and no live one hold this number, so IMS will not choose one` }
  }
  return { outcome: 'wait', reason: `${label}: the ledger holds no document under this number yet` }
}
