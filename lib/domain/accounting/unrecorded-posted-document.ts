import type { AccountingSyncType } from '@/app/generated/prisma/client'

/**
 * A DOCUMENT EXISTS IN THE LEDGER AND ITS SYNC ROW WILL NEVER NAME IT (o3d-550x).
 *
 * The wording, the action name and the "it could not be written down" failure live together in one
 * dependency-free module because THREE modules must agree about them and none of them may drag the
 * others in: the Xero sync processor writes the record, the activity-log retention sweep must know
 * the action to exempt it from deletion, and the tests assert both. A `const` in the connector that
 * the retention sweep imported would invert the layering and pull the whole connector — and its
 * `auth` chain — into a cron cleanup path; a second spelling of the string in the sweep would be a
 * silent drift the day anybody renamed the action.
 */

/** The one action name. Retention exempts exactly this string — see lib/activity-log-cleanup.ts. */
export const UNRECORDED_POSTED_DOCUMENT_ACTION = 'xero_posted_document_unrecorded'

export type UnrecordablePostedDocumentReason = 'ROW_MISSING' | 'ANOTHER_DOCUMENT_NAMED'

export type UnrecordablePostedDocument = {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  /** What THIS worker posted and cannot record. */
  postedExternalId: string | null
  reason: UnrecordablePostedDocumentReason
  /** What the row keeps instead (null when the row is gone). */
  namedExternalId: string | null
}

/**
 * The operator-facing account of the incident — ONE wording, used by the durable record, by the
 * outbox job's failure message and by the last-resort console escalation, so a single incident can
 * never be described three different ways on three different screens.
 *
 * Every refusal names BOTH identifiers, says plainly that nothing will retry either of them, and ends
 * in something a person can actually do.
 */
export function describeUnrecordablePostedDocument(incident: UnrecordablePostedDocument): string {
  const { entry, postedExternalId, namedExternalId, reason } = incident
  const posted = postedExternalId ?? '(no id returned)'
  return reason === 'ROW_MISSING'
    ? `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as ${posted}, `
      + `but its sync row ${entry.id} no longer exists, so nothing in IMS references the document. `
      + 'REMEDY: find it in Xero by the id above and either keep it (re-enter the reference by hand) or void it; '
      + 'nothing further will be retried for this row.'
    : `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as ${posted}, `
      + `but sync row ${entry.id} already names a DIFFERENT document (${namedExternalId ?? 'unknown'}) — a newer `
      + 'claim posted while this attempt was on the wire. BOTH documents exist in Xero. The row was left naming the '
      + 'first one. REMEDY: open both ids in Xero, keep the one the row names, and void or credit the duplicate; '
      + 'no further sync attempt will touch either.'
}

/**
 * THE DURABLE RECORD OF THE INCIDENT COULD NOT BE WRITTEN (Codex r2, HIGH).
 *
 * Thrown from inside the transaction that observed the conflict, so that transaction ABORTS: a caller
 * can never settle a row, complete an outbox job or bury one while believing an escalation was filed
 * that was not.
 *
 * It carries the displaced identifier rather than only a message, and THAT IS THE POINT. Round 2
 * justified the throw by saying the job would be "retried rather than buried" — but the retry re-enters
 * as an ORDINARY sync attempt, and an ordinary attempt has no idea this identifier ever existed: it
 * finds the row already naming the other document, settles it, and completes the job as a success. The
 * identifier is only in this process's memory, and the retry is what throws it away. So the failure
 * hands it upward, in a type the runners match on, and they escalate it out of band instead of feeding
 * it back into the ordinary retry that would lose it.
 */
export class PostedDocumentEvidenceUnwritten extends Error {
  /**
   * The whole incident, not only its parts. A caller that still has a working database — the record
   * failed inside a transaction that then rolled back, which says nothing about the next statement —
   * can write the record from this, in exactly the shape the transaction meant to write it.
   */
  readonly incident: UnrecordablePostedDocument
  readonly syncLogId: string
  readonly postedExternalId: string | null
  readonly namedExternalId: string | null
  readonly reason: UnrecordablePostedDocumentReason
  /**
   * The whole story in one string: the incident wording plus why it could not be saved. This is what
   * goes on the outbox job and into the process log, because at that point it is the ONLY place the
   * displaced identifier is written down.
   */
  readonly operatorMessage: string

  constructor(incident: UnrecordablePostedDocument, cause: unknown) {
    const operatorMessage = describeUnrecordablePostedDocument(incident)
    // The cause is spelled into the message, not only attached: this string is what reaches an outbox
    // job's failure column and the process log, and "why it could not be written" is the part an
    // operator needs to fix the store before the next one happens.
    super(
      `${operatorMessage} AND THIS RECORD COULD NOT BE SAVED: ${String(cause)}. `
      + 'The identifier above exists only in this message.',
      { cause },
    )
    this.name = 'PostedDocumentEvidenceUnwritten'
    this.incident = incident
    this.syncLogId = incident.entry.id
    this.postedExternalId = incident.postedExternalId
    this.namedExternalId = incident.namedExternalId
    this.reason = incident.reason
    this.operatorMessage = this.message
  }
}

/* ---------------------------------------------------------------------------------------------
 * THE SAME INCIDENT, ARRIVING BY A DIFFERENT DOOR, ON THE OTHER CONNECTOR (o3d-peh1 r5).
 *
 * Everything above is about a document whose id the row REFUSES — it names another one, or it is
 * gone. This is about a document whose id the row never gets the chance to hold: the connector
 * accepted the post, the id came back, and the transaction that would have made it durable failed.
 * The end state is identical — a real document in the ledger that nothing in IMS points at — so it
 * gets the same treatment: an ERROR ActivityLog row that RETENTION MAY NOT DELETE, because a record
 * that expires converts a recorded orphan into an invisible one.
 *
 * A SEPARATE ACTION NAME, not a reuse of the Xero one. The retention sweep exempts literal strings,
 * the operator reading it needs to know which ledger to go and look in, and the two connectors'
 * incidents are found by different searches. The constant lives here for exactly the reason the Xero
 * one does: three modules must agree about it and none may drag the others in.
 * ------------------------------------------------------------------------------------------- */

/** The one action name for the QuickBooks incident. Retention exempts exactly this string. */
export const QBO_UNRECORDED_POSTED_DOCUMENT_ACTION = 'quickbooks_posted_document_unrecorded'

export type UnpersistedQboPost = {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  /** What QuickBooks accepted, and what this process could not write down. */
  postedExternalId: string | null
}

/**
 * The operator-facing account of it — ONE wording, used by the durable record and by the
 * last-resort console escalation, so a single incident cannot be described two different ways.
 *
 * It names the identifier, says plainly what state the row was left in, and ends in something a
 * person can do. It does NOT claim the document is unreachable: the QuickBooks Request-Id is derived
 * from the sync row's own id, so the retry that follows re-posts under an id Intuit has already
 * seen — which is why the remedy is "check, then reconcile" rather than "assume a duplicate".
 */
export function describeUnpersistedQboPost(incident: UnpersistedQboPost, cause: unknown): string {
  const { entry, postedExternalId } = incident
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as `
    + `${postedExternalId ?? '(no id returned)'}, but IMS could not record that id: ${String(cause)}. `
    + `Sync row ${entry.id} still names no document, so nothing in IMS points at this one and no `
    + 'mirrored accounting event was written for it — deliberately, because a FAILED one would deny a '
    + 'document that exists. The row keeps its claim and will be re-attempted once the claim goes '
    + 'stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated '
    + 'rather than duplicated. REMEDY: open the id above in QuickBooks, confirm exactly one document '
    + 'exists for this reference, and void any duplicate.'
}

/* ---------------------------------------------------------------------------------------------
 * AND THE CASE THAT IS NOT A DOCUMENT AT ALL (o3d-peh1 r6, Codex HIGH).
 *
 * Everything above is about an IDENTIFIER: a document QuickBooks holds, whose id the sync row can
 * never carry. The re-drive-and-escalate treatment above is correct for those and ONLY for those,
 * and the reason is spelled out in `describeUnpersistedQboPost`: the row is left CLAIMED so the
 * stale-claim reclaim re-attempts it, and that re-attempt goes out under the SAME derived Intuit
 * Request-Id, which makes it a deduplicated replay rather than a second document.
 *
 * FOUR QuickBooks OPERATIONS LEGITIMATELY RETURN NO ID — BILL_ATTACHMENT, INVOICE_PDF,
 * INVOICE_EMAIL and WC_INVOICE_NOTE. They are not document posts. They upload a file, save a PDF,
 * SEND AN EMAIL, write a note onto a WooCommerce order — and NONE of them carries a Request-Id,
 * because none of them goes through the idempotent post helper. So the sentence the escalation above
 * rests on is simply false about them: their replay is not deduplicated by anything, and leaving the
 * row claimed means the email is sent again on the next sweep, and the one after that, for as long
 * as the settling write keeps failing.
 *
 * So they get a SETTLING path instead of an escalating one, and this is the record of the case where
 * even that could not be written. It is retention-exempt for the kind-(2) reason the two above are:
 * the effect happened OUTSIDE this database, the row does not record it, and nothing re-derives it.
 * ------------------------------------------------------------------------------------------- */

/** The one action name for a no-id QuickBooks operation that could not be settled. Retention exempts exactly this string. */
export const QBO_UNSETTLED_OPERATION_ACTION = 'quickbooks_operation_unsettled'

/**
 * The action name for the LESSER incident: the operation WAS settled, by the narrowed write, but the
 * mirrored accounting event it should have carried is missing. Deliberately NOT retention-exempt —
 * nothing is stuck, nothing repeats, and the row itself records the outcome.
 */
export const QBO_UNMIRRORED_OPERATION_ACTION = 'quickbooks_operation_unmirrored'

export type UnsettledQboOperation = {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
}

/**
 * The operator-facing account of a no-id operation whose effect happened and whose row could not be
 * moved out of the claim — ONE wording, used by the durable record and by the console escalation.
 *
 * It does NOT offer the "it will be re-attempted under the same Request-Id" reassurance the document
 * wording does, because that reassurance does not exist here. What it says instead is the honest
 * bound: the ONLY way this effect can happen a second time is a fresh claim, and a fresh claim is a
 * write to the very row whose write just failed three times.
 */
export function describeUnsettledQboOperation(incident: UnsettledQboOperation, cause: unknown): string {
  const { entry } = incident
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} COMPLETED — the attachment, PDF, `
    + `email or order note was actually sent — but sync row ${entry.id} could not be settled: ${String(cause)}. `
    + 'This operation returns no external id and carries no Intuit Request-Id, so a re-attempt would REPEAT the '
    + 'effect rather than being deduplicated. The row still holds this run\'s claim; it can only be re-run by a '
    + 'fresh claim, which is a write to the same row that just refused three settling writes. REMEDY: fix the '
    + 'write failure above, then settle the row by hand so the sweep does not send it a second time.'
}
