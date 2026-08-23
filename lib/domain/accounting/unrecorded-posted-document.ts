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

/**
 * BOTH CONNECTORS' INCIDENTS, NAMED ONCE, SO NOBODY CAN PROTECT ONE AND FORGET THE OTHER.
 *
 * The two constants above describe the SAME class of thing — a document that exists in somebody
 * else's ledger which nothing in IMS points at, and which nothing in IMS can re-derive — arrived at
 * by two different accidents on two different connectors. Every eraser in this codebase that spares
 * one of them has to spare the other, and there is no rule that makes that happen: an exemption
 * written as a single constant name LOOKS complete, compiles, passes its own test, and is wrong only
 * for the member of the pair the author was not thinking about. The activity-log retention sweep
 * shipped correct because both were in front of the author at once; the factory reset shipped
 * exempting only Xero, and quietly deleted every QuickBooks incident record (Codex HIGH).
 *
 * So the pair is a value, not a convention. An eraser imports THIS, and a third connector's incident
 * becomes one edit here rather than a hunt through every deleter in the tree.
 *
 * It is deliberately NOT the activity-log sweep's whole exempt list: that list also carries the
 * direct-create marker, which is an OPEN OBLIGATION rather than evidence of a remote document, and
 * which a factory reset is right to discharge because the order it is about is being deleted too.
 * The two kinds are exempt for different reasons and the erasers treat them differently, so folding
 * them into one constant would be the same mistake wearing the opposite hat.
 */
export const UNRECORDED_POSTED_DOCUMENT_ACTIONS: readonly string[] = [
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
]

export type UnpersistedQboPost = {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  /** What QuickBooks accepted, and what this process could not write down. */
  postedExternalId: string | null
}

/**
 * THE FOUR OPERATIONS NO REQUEST-ID PROTECTS, AND WHAT REPLAYING ONE ACTUALLY DOES (o3d-qn21).
 *
 * Every successful QuickBooks operation is routed through the same escalation, and until now that
 * escalation told an operator ONE story: the row keeps its claim, the stale-claim reclaim re-posts
 * under the SAME derived Intuit Request-Id, so the replay is deduplicated rather than duplicated.
 * FOR THESE FOUR THAT SENTENCE IS FALSE. They are not document posts — they upload a file, save a
 * PDF, send an email to a customer, write a note onto a WooCommerce order — none of them reaches the
 * idempotent poster, none carries a Request-Id, and none returns an id that could ever name it
 * again. Nothing on the far side collapses a second attempt into the first, so the reclaim does not
 * replay an identifier, it REPEATS THE EFFECT.
 *
 * THIS TABLE SELECTS WORDING AND NOTHING ELSE. It is not a fence, and it is deliberately not one:
 * rounds 6 and 7 tried to build the fence out of a claim-time marker and it was unsound both times
 * (a claim is not proof of dispatch; a failure is not proof of no effect). The durable fix is a
 * pre-post dispatch record and it is filed as o3d-qn21. Until that lands, the honest thing this
 * module can do is stop promising a protection that does not exist — because an incident record that
 * describes a protection that is not there sends an operator looking for a duplicate to reconcile
 * when what they need to do is stop a send from repeating.
 *
 * The `check` is what the operator does about the effect; the `effect` is what the replay costs.
 *
 * ONE OF THE FOUR SUCCEEDS BY QUEUEING RATHER THAN BY DOING (Codex MEDIUM). `INVOICE_EMAIL` does not
 * send anything: it writes a PENDING row into the email outbox and returns success, and a separate
 * outbox cron delivers it later. That changes the remedy, not just the wording. For the other three
 * the effect is already finished by the time an operator reads the record, so "settle the row" is the
 * whole of the stopping half — nothing further is pending. For the email, settling the row stops the
 * SWEEP adding more copies and CANCELS NOTHING THAT IS ALREADY QUEUED: every sweep so far has left a
 * PENDING outbox row behind it, and each of those is still going to be delivered to the customer
 * after the sync row is settled. So the check has to be done FIRST and has to be about the outbox,
 * not about the mailbox: find the pending accounting-invoice rows for this order and cancel the ones
 * the customer should not receive, THEN settle. An operator told only to "check what was sent" would
 * look at a mail log, see one delivery, settle the row, and watch the rest arrive afterwards.
 */
const QBO_OPERATIONS_WITHOUT_REQUEST_ID: Partial<Record<AccountingSyncType, { effect: string; check: string }>> = {
  BILL_ATTACHMENT: {
    effect: 'the supplier invoice PDF is uploaded to the QuickBooks bill AGAIN, once per sweep',
    check: 'open the bill in QuickBooks and delete any duplicate attachment',
  },
  INVOICE_PDF: {
    effect: 'the invoice PDF is re-downloaded and written over the stored copy AGAIN, once per sweep',
    check: 'confirm the invoice PDF stored against the order is the document you expect',
  },
  INVOICE_EMAIL: {
    effect: 'ANOTHER COPY OF THE INVOICE EMAIL IS QUEUED TO THE CUSTOMER — one more PENDING '
      + 'accounting-invoice row in the email outbox per sweep, every one of which the outbox sender '
      + 'will deliver',
    check: 'this operation succeeds by QUEUEING, not by sending, so SETTLING THE ROW CANCELS NOTHING '
      + 'THAT IS ALREADY QUEUED — before you settle, list every PENDING accounting-invoice email-outbox '
      + 'row for this order (kind ACCOUNTING_INVOICE, referenceType SalesOrder, referenceId = the order '
      + 'id), keep at most the one copy the customer should receive, and cancel the rest; any pending '
      + 'row you leave behind is still sent after the sync row is settled, and tell the customer if '
      + 'more than one copy has already gone out',
  },
  WC_INVOICE_NOTE: {
    effect: 'a second invoice note is written onto the WooCommerce order, once per sweep',
    check: 'open the order in WooCommerce and remove any duplicate note',
  },
}

/**
 * The operator-facing account of it — ONE wording, used by the durable record and by the
 * last-resort console escalation, so a single incident cannot be described two different ways.
 *
 * IT IS OPERATION-AWARE, and that is the point of it (o3d-qn21). There are two genuinely different
 * incidents behind this one escalation and they need opposite actions from the reader:
 *
 *   • A DOCUMENT POST whose id could not be recorded. It goes out under a Request-Id derived from
 *     the sync row's own id, so the re-attempt re-posts under an id Intuit has already seen — which
 *     is why the remedy is "check, then reconcile" rather than "assume a duplicate".
 *   • ONE OF THE FOUR NO-IDENTIFIER OPERATIONS above. No id came back and no Request-Id was ever
 *     sent, so nothing deduplicates the re-attempt: stale-claim recovery REPLAYS THE EFFECT
 *     OUTRIGHT, and goes on replaying it every sweep for as long as the row stays claimed. That
 *     reader has to be told to go and look at the effect, and to settle the row so it stops.
 */
export function describeUnpersistedQboPost(incident: UnpersistedQboPost, cause: unknown): string {
  const { entry, postedExternalId } = incident
  const noRequestId = QBO_OPERATIONS_WITHOUT_REQUEST_ID[entry.type]
  if (noRequestId) {
    return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} SUCCEEDED — the `
      + 'external effect has happened — but IMS could not record that it did: '
      + `${String(cause)}. THIS OPERATION RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: unlike a `
      + 'document post it is not sent under a derived Intuit Request-Id, so there is nothing for '
      + `QuickBooks or WooCommerce or a mail server to deduplicate it against. Sync row ${entry.id} still `
      + 'holds this worker\'s claim and no mirrored accounting event was written, so once that claim goes '
      + `stale THE SWEEP WILL RECLAIM THE ROW AND RUN THE OPERATION AGAIN OUTRIGHT — ${noRequestId.effect}, `
      + 'unbounded, because no retry is consumed while the row never leaves PROCESSING. '
      + `REMEDY: ${noRequestId.check}; then settle sync row ${entry.id} by hand (mark it SYNCED, or FAILED `
      + 'if the operation must not run again) so the sweep stops re-running it. This is the known hole '
      + 'o3d-qn21 — the durable fix is a pre-post dispatch record, not this message, and until it lands '
      + 'this record is the only thing that says the effect repeated.'
  }
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as `
    + `${postedExternalId ?? '(no id returned)'}, but IMS could not record that id: ${String(cause)}. `
    + `Sync row ${entry.id} still names no document, so nothing in IMS points at this one and no `
    + 'mirrored accounting event was written for it — deliberately, because a FAILED one would deny a '
    + 'document that exists. The row keeps its claim and will be re-attempted once the claim goes '
    + 'stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated '
    + 'rather than duplicated. REMEDY: open the id above in QuickBooks, confirm exactly one document '
    + 'exists for this reference, and void any duplicate.'
}
