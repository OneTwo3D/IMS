import { LEDGER_STANDING_SELECT, ledgerStanding } from '@/lib/domain/accounting/ledger-standing'
import { ATTEMPT_PROVEN_NEVER_MADE_WHERE, attemptProvenNeverMade } from '@/lib/domain/accounting/money-attempt-provenance'
import type { Prisma } from '@/app/generated/prisma/client'
import type { PurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'

/**
 * EDITING A BILL BEFORE ITS FIRST POSTING HAS REACHED THE LEDGER.
 *
 * A bill edit queues a PURCHASE_INVOICE_UPDATE against the ledger document, and that needs the document's id. Until the
 * bill's first posting (the PURCHASE_INVOICE row) has been written back there is none, so the edit was saved in IMS and
 * nothing at all was queued: the create row still carried the PRE-edit figures and posted them, and the ledger and IMS
 * disagreed for good (AP, VAT and the transit clearing leg all wrong, and a later payment settling a bill the ledger holds
 * at a different total).
 *
 * The first posting is therefore made to carry the edit. While the create row has not left IMS (queued, or failed before
 * any request was made) its payload is replaced with the edited bill's, in the same transaction as the edit, and the
 * single posting that goes out is the latest version: one document, no update, nothing posted twice. The processor reads a
 * row's payload AFTER it claims it (lib/domain/accounting/claimed-sync-payload.ts), and this write is a compare-and-swap on
 * the row still being unsent, so a worker either has not claimed the row (and posts the new payload) or has (and the swap
 * matches nothing).
 *
 * Where the create row HAS been, or may have been, sent (claimed, posted but not yet linked back, or failed after a request
 * left) the bill cannot be rewritten in place and no update can be addressed to a document nobody has an id for. The edit is
 * REFUSED, so IMS never holds a version the ledger will not receive; the operator is told to edit once the posting has settled.
 */

export const PURCHASE_BILL_FIRST_POSTING_IN_FLIGHT_MESSAGE =
  'This bill is being posted to the accounting system for the first time, or has been posted and not yet linked back, '
  + 'so an edit could not reach the ledger. Nothing was saved. Wait until its posting has finished (Sync), then edit the bill.'

export class PurchaseBillFirstPostingInFlightError extends Error {
  constructor() {
    super(PURCHASE_BILL_FIRST_POSTING_IN_FLIGHT_MESSAGE)
    this.name = 'PurchaseBillFirstPostingInFlightError'
  }
}

export type PendingCreateRefreshOutcome =
  /** The unsent create row now carries the edited bill; the first posting will be the edited version. */
  | { kind: 'refreshed'; syncLogId: string }
  /** No create row exists for this bill (sync off, a hold recorded it as a shadow, or it was never queued): nothing is owed to a ledger document. */
  | { kind: 'no-create-row' }

export type PendingCreateRefreshTx = Pick<Prisma.TransactionClient, 'accountingSyncLog'>

/** The keys the enqueue stamped on the row (`_postingMode`, `_idempotencyKey`, the connection stamp): the row's identity, never the document. */
function enqueueStamps(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key.startsWith('_')))
}

export async function refreshPendingPurchaseInvoiceCreate(params: {
  tx: PendingCreateRefreshTx
  invoiceId: string
  /** The connector whose chart `accountingPayload` was built from; the row must belong to it. */
  chartConnector: string | null
  /** The edited bill, built exactly as the create builds it (no ledger document id). */
  accountingPayload: PurchaseInvoiceAccountingPayload
}): Promise<PendingCreateRefreshOutcome> {
  const rows = await params.tx.accountingSyncLog.findMany({
    where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: params.invoiceId },
    select: {
      ...LEDGER_STANDING_SELECT,
      id: true,
      connector: true,
      remoteAttemptedAt: true,
      attemptStampingCustodyAt: true,
      backReferenceEvidenceCompactedAt: true,
      payload: true,
    },
  })
  // What each row says about the ledger is the ledger-standing module's to say. A shadow IMS recorded instead of queuing, and an attempt
  // proven never to have been sent that was then retired, are not postings: nothing is owed to the ledger for them.
  const postings = rows.filter((row) => {
    const standing = ledgerStanding(row)
    return standing !== 'SHADOW_NOT_SENT_BY_IMS' && standing !== 'PROVEN_NOT_POSTED'
  })
  if (postings.length === 0) return { kind: 'no-create-row' }
  // Two live create rows for one bill cannot be told apart.
  if (postings.length > 1) throw new PurchaseBillFirstPostingInFlightError()
  const row = postings[0]!
  // Refreshable only while the row is queued (or failed) and PROVEN never to have made a request: a claim, an attempt, a posted-but-unlinked
  // document or a row nobody can vouch for are all "may have left".
  // The standing is read with the proof of "never sent" the row itself carries: queued work is LIVE_WORK, and a failure is PROVEN_NOT_POSTED only
  // when no request ever left. Anything else (a document id, an operator's word, a basis this build does not write, a claim) is not refreshable.
  const standing = ledgerStanding(row, { couldHaveReachedLedger: !attemptProvenNeverMade(row) })
  const unsent = (row.status === 'PENDING' || row.status === 'FAILED')
    && (standing === 'LIVE_WORK' || standing === 'PROVEN_NOT_POSTED')
    && attemptProvenNeverMade(row)
    && row.backReferenceEvidenceCompactedAt === null
    && row.connector === params.chartConnector
  if (!unsent) throw new PurchaseBillFirstPostingInFlightError()

  const payload = { ...params.accountingPayload, accountingInvoiceId: undefined, ...enqueueStamps(row.payload) }
  const swapped = await params.tx.accountingSyncLog.updateMany({
    where: {
      id: row.id,
      status: { in: ['PENDING', 'FAILED'] },
      ...ATTEMPT_PROVEN_NEVER_MADE_WHERE,
    },
    data: { payload: payload as never },
  })
  // A worker claimed it between the read and the swap: it holds the pre-edit payload's attempt, and may be on the wire.
  if (swapped.count !== 1) throw new PurchaseBillFirstPostingInFlightError()
  return { kind: 'refreshed', syncLogId: row.id }
}
