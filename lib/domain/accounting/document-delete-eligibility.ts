/**
 * MAY THIS SYNCED INVOICE OR BILL BE DELETED IN IMS AND XERO TOGETHER? (o3d-ngmt.21)
 *
 * A pure decision over facts the caller has read. It reads nothing and writes nothing, so the same verdict serves the page that decides
 * whether to show a Delete button, the server action that must refuse a request the page should never have offered, and the tests.
 *
 * THE ORDER OF THE REFUSALS IS THE ORDER AN OPERATOR CAN ACT ON THEM: a switch that is off, then a document that is not one IMS may touch
 * at all (not linked, not IMS-owned), then the things only they can clear in the accounting system (payments, credit notes, a locked
 * period), then work IMS itself still has queued. Every refusal that needs something removed says so in the same words: remove the
 * blocking items in the accounting system first.
 *
 * IMS-OWNED, and what that is NOT. A document is IMS-owned only when IMS itself created it in the ledger: a connector-confirmed
 * create row names the document id. A document whose id was linked by hand, or created by the incumbent writer during the parallel
 * phase (Xeroom for sales invoices, Qoblex for bills), is not IMS-owned, even when the number it carries matches one IMS derives:
 * deleting it would remove a document another system raised and still reconciles against. The invoice-number-ownership rule is applied
 * on top for sales invoices (see `ledgerOwnershipVerdict`): the ledger must name THIS document as the holder of the number.
 */

import { decideInvoiceNumberPost, type InvoiceNumberLookup } from '@/lib/domain/accounting/invoice-number-ownership'

export type DeletableDocumentKind = 'SALES_INVOICE' | 'PURCHASE_BILL'

export type DocumentDeleteRefusalCode =
  | 'FEATURE_OFF'
  | 'NOT_PUSHED'
  | 'NOT_XERO'
  | 'NOT_IMS_OWNED'
  | 'DELETE_IN_PROGRESS'
  | 'HAS_PAYMENTS'
  | 'HAS_CREDIT_NOTES'
  | 'PERIOD_LOCKED'
  | 'POSTING_IN_FLIGHT'
  | 'LEDGER_OWNERSHIP'

export type DocumentDeleteFacts = {
  kind: DeletableDocumentKind
  /** The setting `xero_document_delete_enabled`. */
  featureEnabled: boolean
  /** How the operator names the document in a sentence: `invoice INV-1`, `bill SUP-9`. */
  label: string
  /** The ledger's id for the document, or null when it never reached the ledger. */
  externalDocumentId: string | null
  /** Which connector's document the id is (the recorded provenance); null = not recorded. */
  documentConnector: string | null
  /** IMS itself created the document in the ledger: a connector-confirmed create row names this id (and, for a bill, the link was written by IMS's own sync). */
  createdByIms: boolean
  /** A delete of this document is already queued or running. */
  deleteInProgress: boolean
  /** IMS-side money: receipts recorded against an invoice, or a payment recorded on a bill. */
  paymentCount: number
  /** IMS-side credit: refunds / credit notes against an invoice, supplier credit notes against a bill. */
  creditNoteCount: number
  /** The document's own date as `YYYY-MM-DD`; null when IMS cannot say. */
  documentDate: string | null
  /** The imported Xero books lock date `YYYY-MM-DD`; null/'' = none read or none set. */
  lockDate: string | null
  /** Sync types of this document's other queued or running postings (updates, payments, the create itself). */
  openPostingTypes: readonly string[]
}

export type DocumentDeleteVerdict =
  | { eligible: true }
  | { eligible: false; code: DocumentDeleteRefusalCode; reason: string }

const REMOVE_FIRST = 'Remove the blocking items in the accounting system first, then try again.'

function refuse(code: DocumentDeleteRefusalCode, reason: string): DocumentDeleteVerdict {
  return { eligible: false, code, reason }
}

export function decideDocumentDelete(facts: DocumentDeleteFacts): DocumentDeleteVerdict {
  const what = facts.kind === 'SALES_INVOICE' ? 'invoice' : 'bill'
  if (!facts.featureEnabled) {
    return refuse('FEATURE_OFF', `Deleting a synced ${what} is switched off. An administrator can turn it on in Settings, Integrations, Xero ("Allow deleting synced invoices and bills").`)
  }
  if (!facts.externalDocumentId) {
    return refuse('NOT_PUSHED', `${capitalise(facts.label)} has not been pushed to the accounting system, so there is nothing to delete there.`)
  }
  if (facts.documentConnector !== 'xero') {
    return refuse(
      'NOT_XERO',
      `${capitalise(facts.label)} is recorded against ${facts.documentConnector ?? 'no known accounting connector'}, not Xero, so IMS will not delete it. Remove it in the system that holds it.`,
    )
  }
  if (!facts.createdByIms) {
    return refuse(
      'NOT_IMS_OWNED',
      `${capitalise(facts.label)} was not created by IMS in Xero (it was raised by another system, or linked by hand), so IMS will not delete it. Delete it in the system that created it.`,
    )
  }
  if (facts.deleteInProgress) {
    return refuse('DELETE_IN_PROGRESS', `Deleting ${facts.label} is already queued or running. Wait for it to finish in Sync, then check the result.`)
  }
  if (facts.paymentCount > 0) {
    return refuse(
      'HAS_PAYMENTS',
      `${capitalise(facts.label)} has ${facts.paymentCount === 1 ? 'a payment' : `${facts.paymentCount} payments`} recorded against it. Xero will not void or delete a document that has been paid. ${REMOVE_FIRST}`,
    )
  }
  if (facts.creditNoteCount > 0) {
    return refuse(
      'HAS_CREDIT_NOTES',
      `${capitalise(facts.label)} has ${facts.creditNoteCount === 1 ? 'a credit note or refund' : `${facts.creditNoteCount} credit notes or refunds`} against it. Xero will not void or delete a document that has credit applied. ${REMOVE_FIRST}`,
    )
  }
  const lock = (facts.lockDate ?? '').trim()
  if (lock !== '' && facts.documentDate !== null && facts.documentDate <= lock) {
    return refuse(
      'PERIOD_LOCKED',
      `${capitalise(facts.label)} is dated ${facts.documentDate}, on or before the Xero books lock date ${lock}, so Xero will not change it. Reverse it with a credit note dated after the lock, or ask the accountant to move the lock date.`,
    )
  }
  if (facts.openPostingTypes.length > 0) {
    return refuse(
      'POSTING_IN_FLIGHT',
      `${capitalise(facts.label)} still has ${facts.openPostingTypes.length === 1 ? 'a posting' : 'postings'} queued or running for it (${[...new Set(facts.openPostingTypes)].join(', ')}). Let ${facts.openPostingTypes.length === 1 ? 'it' : 'them'} finish, or resolve ${facts.openPostingTypes.length === 1 ? 'it' : 'them'} in Sync, then try again.`,
    )
  }
  return { eligible: true }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * THE LEDGER'S HALF OF THE OWNERSHIP QUESTION, for a sales invoice: asked of invoice-number-ownership, not re-derived.
 *
 * The number the invoice carries must be held by exactly this document. `decideInvoiceNumberPost` answers `post: true, basis:
 * 'own-document'` when the only live holder of the number is the document IMS already owns for the order; anything else, including
 * `unclaimed` (nobody holds it: the ledger does not hold this invoice under that number), a foreign holder (the cutover case: the
 * incumbent's document), several holders, and a lookup that could not be answered, is a refusal. The answer is evidence about the
 * organisation that gave it, so a verdict is returned only with the tenant it was reached in.
 */
export function ledgerOwnershipVerdict(params: {
  invoiceNumber: string | null | undefined
  ownedInvoiceId: string
  orderLabel: string
  lookup: InvoiceNumberLookup
}): { ok: true; tenantId: string } | { ok: false; reason: string } {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: params.invoiceNumber,
    lookup: params.lookup,
    ownedInvoiceId: params.ownedInvoiceId,
    orderLabel: params.orderLabel,
  })
  if (decision.post && decision.basis === 'own-document' && decision.claimedInvoiceId === params.ownedInvoiceId) {
    return { ok: true, tenantId: decision.answeredByTenantId }
  }
  if (decision.post) {
    return {
      ok: false,
      reason: `Xero does not hold invoice number ${params.invoiceNumber ?? ''} under the document IMS recorded for ${params.orderLabel}, so IMS cannot show it owns the document it would delete. Nothing was changed. Check the invoice in Xero first.`,
    }
  }
  if (decision.retryable) {
    return { ok: false, reason: `Could not confirm in Xero that IMS owns ${params.orderLabel}'s invoice, so nothing was changed. ${decision.reason}` }
  }
  return {
    ok: false,
    reason: `Xero's holder of invoice number ${params.invoiceNumber ?? ''} is not the document IMS raised for ${params.orderLabel} (for example an invoice created by another system during the parallel run), so IMS will not delete it. Nothing was changed. Delete it in the system that created it.`,
  }
}
