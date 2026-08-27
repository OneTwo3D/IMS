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
 * ONE OF THE FOUR SUCCEEDS BY QUEUEING RATHER THAN BY DOING (Codex MEDIUM). `INVOICE_EMAIL` does not
 * send anything: it writes a PENDING row into the email outbox and returns success, and a separate
 * outbox cron delivers it later. For the other three the effect is already finished by the time an
 * operator reads the record; for the email, more of it is still coming.
 *
 * -----------------------------------------------------------------------------------------------
 * ROUND 3 (Codex HIGH): A REMEDY MUST BE PERFORMABLE, AND THIS ONE WAS NOT — EITHER HALF OF IT.
 * -----------------------------------------------------------------------------------------------
 * The wording told an operator to cancel the queued outbox rows and then settle the sync row.
 * NEITHER STEP EXISTS IN THE SHIPPED CODE, and this is the THIRD time on this branch that a remedy
 * has been written without being walked through the tree first. Each step below was checked against
 * the code before this comment was written, and there is a test that walks them again.
 *
 *   CANCEL THE QUEUED ROWS — there is nothing to cancel WITH. `EmailOutboxStatus` is PENDING,
 *   PROCESSING, SENT, FAILED; none of them means "deliberately not delivered", and the model carries
 *   no cancelled-at column. Every status write lives inside the outbox cron, which terminalises a
 *   row only by SENDING it or by exhausting five attempts. No server action, route handler or screen
 *   removes an individual unsent row — the only authenticated removal in the tree is
 *   `emailOutbox.deleteMany({})` inside the factory reset, i.e. the whole database. There is not
 *   even a page on which the rows the instruction says to enumerate can be seen.
 *
 *   THEN SETTLE THE ROW — the settlement action refuses this exact row WHILE QUICKBOOKS IS THE
 *   ACTIVE CONNECTOR. It requires a fenced attempt revision, and the QuickBooks processor stamps
 *   none, so every QuickBooks row sits at revision 0 and is answered UNFENCED_ATTEMPT; the adoption
 *   escape hatch needs the row's connector NOT to be the active one, which does not hold at the
 *   instant the incident is raised. (Round 3 also wrote that the control is "not rendered on any
 *   QuickBooks LOG view". That was itself false — see ROUND 6 below; it is rendered, in its refused
 *   state.) And "mark it SYNCED, or FAILED" named an outcome the action cannot produce at all: it
 *   emits SYNCED or CANCELLED.
 *
 * ----------------------------------------------------------------------------------------------
 * ROUND 4 (Codex HIGH): AND THAT REFUSAL IS NOT AN ABSOLUTE — IT IS A FACT ABOUT WHICH CONNECTOR
 * IS ACTIVE, WHICH IS THE ONE THING THE READER OF THIS RECORD IS MOST LIKELY TO CHANGE.
 * ----------------------------------------------------------------------------------------------
 * Round 3 wrote "the settlement action refuses EVERY QuickBooks row … and the settle control is not
 * rendered on any QuickBooks view", unqualified. Both halves are true only while QuickBooks is
 * ACTIVE, and the branch's own test proves it: tests/accounting/qbo-remedy-is-performable.test.ts
 * settles this very row successfully with Xero active. The live path, walked end to end:
 *
 *   • PROCESSING is in SETTLEABLE_ACCOUNTING_SYNC_STATUSES, and these four types are not
 *     DAILY_BATCH_*, so neither the status nor the type gate refuses;
 *   • `describeStrandedSyncRow` asks `isStrandedRowUnclaimable`, and when it answers yes a
 *     revision-0 row is settleable BY ADOPTION rather than refused UNFENCED_ATTEMPT;
 *   • `buildStrandedSyncRowWhere` selects PROCESSING rows whose connector is NOT the active one —
 *     which is exactly this row, once QuickBooks stops being active;
 *   • and the connector-orphan banner renders `SettleSyncRowControl` for every row it lists.
 *
 * ----------------------------------------------------------------------------------------------
 * ROUND 5 (Codex HIGH #1): AND THE REMEDY'S OWN PRECONDITION WAS FALSE FOR EXACTLY THESE ROWS.
 * ----------------------------------------------------------------------------------------------
 * Round 4 wrote that enabling Xero "is enough on its own" and that the replay "stops there too",
 * because `describeStrandedSyncRow` passed `unclaimable: true` unconditionally for every row on a
 * non-active connector. Both halves were wrong in the same place, and QuickBooks rows are the
 * population they are wrong about:
 *
 *   • the ACTIVE CONNECTOR is resolved from the PLUGIN flags. `triggerQuickBooksSync` — the manual
 *     Sync button, reachable by any holder of the `sync` permission — gates on
 *     `quickbooks_sync_enabled` and NOTHING ELSE, and never resolves the active connector at all.
 *     So "the replay stops there too" is true of the CRON and false of the button;
 *   • which means the adoption precondition did not hold either. The record directed an operator to
 *     enable Xero and settle the row, and one press of the QuickBooks Sync button then reclaimed the
 *     stale PROCESSING row, replayed the customer email, and let the worker's later update land on
 *     top of the settlement.
 *
 * The precondition is now the conjunction — not the active connector AND that connector's sync
 * toggle off — decided once in `isStrandedRowUnclaimable` (sync-row-claimability.ts) and shared by
 * the read model and the settlement action. The message below names BOTH, names the toggle, and
 * gives the order (toggle off, enable Xero, settle, toggle back on) that makes this a per-row
 * remedy rather than a permanent shutdown.
 *
 * AND THE LIST IT POINTS AT IS THE 50 OLDEST ROWS. `getStrandedAccountingSyncRows(50)` is
 * hard-truncated, with no paging, filter or search, and ordered `[{ createdAt: 'asc' }, { id: 'asc' }]`
 * — on the SYNC ROW's creation time, not the incident's. A row queued today therefore sorts last,
 * while one that has been replaying for weeks sorts near the front. The record's own instruction
 * strands every unresolved QuickBooks row at once, so on any install with 50 or more of them the
 * promise "it then appears in the list" is false. The message says the limit, says what the order
 * is measured on, and points at the banner's own truncation notice rather than promising a view
 * that will not show the row.
 *
 * ----------------------------------------------------------------------------------------------
 * ROUND 6 (Codex HIGH): TWO MORE SENTENCES THAT WERE NOT TRUE — AND NEITHER WAS ABOUT THE PART OF
 * THE REMEDY THE REVIEWS KEPT RE-LITIGATING.
 * ----------------------------------------------------------------------------------------------
 * Rounds 3, 4 and 5 each corrected the SETTLEABILITY sentence and each left something else beside
 * it uninspected. Round 6 walked every remaining clause into the tree. Two failed:
 *
 *   "THE SETTLE CONTROL IS NOT RENDERED ON ANY QUICKBOOKS LOG VIEW" — FALSE, and it has been since
 *   round 3 wrote it. QuickBooks has no client of its own: `ACCOUNTING_CONNECTOR_UI` in
 *   accounting-connector-panel.tsx maps BOTH connectors to `XeroClient`, and that component renders
 *   `<SettleSyncRowControl>` for every row whose status is FAILED or PROCESSING
 *   (`settlementApplies`). This row is PROCESSING, so the control IS mounted — it simply resolves to
 *   the words "not settleable" with `notSettleableReason` as its `title`. The distinction matters to
 *   the person reading the record: they are not looking at a screen with nothing on it, they are
 *   looking at a refusal, and they need to know that.
 *
 *   AND THE REASON THAT TOOLTIP GIVES IS THE WRONG ONE FOR THIS CONNECTOR. `xero-client.tsx` calls
 *   `describeSyncRowSettleability` with only `{ status, type, attemptRevision }` — no `connector`, no
 *   `unclaimableRefusalReason` — so a revision-0 row falls to the DEFAULT branch, which says the row
 *   is "on the ACTIVE connector, so the fence-aware processor will stamp one the next time it claims
 *   the row: retry the row, and settle it once it shows an attempt". The QuickBooks claim
 *   (`stampingCustodyOnClaim` at sync-processor.ts:783) writes `status` and custody and NEVER
 *   `attemptRevision`, unlike the Xero claim, which is itself a CAS on it. So that advice sends an
 *   operator into an unbounded retry loop on the one connector where the row can never acquire an
 *   attempt — and each of those retries is the replay this record exists to stop. The message now
 *   contradicts it explicitly. Making the tooltip itself connector-aware is a UI change with its own
 *   blast radius and is filed rather than smuggled in here (o3d-3lhp).
 *
 *   "BOTH CONNECTORS ENABLED IS A GUARDED STATE, NOT AN IMPOSSIBLE ONE … NO DELIBERATE RETIREMENT IS
 *   NEEDED" — FALSE, and this one told the operator to attempt a save the product refuses.
 *   `saveIntegrationPluginState` evaluates the RESULTING selection under the plugin-selection lock
 *   and returns `{ status: 'refused' }` for it: "Enable either Xero or QuickBooks, not both —
 *   accounting dispatch is single-connector." (The onboarding step does not even offer it: turning
 *   one on clears the other in the component.) The state the round-5 wording called merely "guarded"
 *   is reachable only through the write race that same guard was moved under the lock to close. So
 *   making Xero active IS a deliberate retirement of QuickBooks, and the message now says so and
 *   gives the shape of the save that works: the settings screen posts all five switches at once, so
 *   QuickBooks OFF and Xero ON in ONE save passes the guard, where two saves cannot.
 *
 * THE THIRD THING ROUND 6 CHANGED IS AN ORDERING, NOT A FALSEHOOD. The INVOICE_EMAIL `check` tells
 * an operator to COUNT the queued copies, and the count instruction reached them before the lever
 * that stops new ones being queued. A count taken first is stale by one copy per sweep, and it is
 * the number they were about to give a customer. The `check` now names the order.
 *
 * WHY GETTING THIS WRONG COSTS MORE HERE THAN ANYWHERE ELSE. This record is exempt from BOTH
 * retention (the ERROR-level exemption below) and the factory reset. It is the permanent
 * operator-facing account of a live remote effect, so a wrong ABSOLUTE in it outlives every other
 * statement in the system. The message therefore qualifies the refusal and POINTS AT THE STRANDED
 * SYNC ROWS BANNER — the one place the per-row control is rendered for this row.
 *
 * WHY THE MESSAGE WAS FIXED RATHER THAN THE HOLE. Providing the operation is not contained here.
 * The cancel needs a new outbox state — a schema change and a migration — and reusing FAILED would
 * be a lie the outbox's own sender writes for suppressed recipients and exhausted attempts, making
 * its failure signal unreadable, while deleting the row would destroy the only evidence a copy was
 * queued. The settle needs a QuickBooks attempt fence, and THIS BRANCH ALREADY TRIED THAT: the
 * no-identifier dispatch machinery of rounds 6 and 7 was reverted after four rounds precisely
 * because the connector lacks the primitives (a claim is not proof of dispatch; a failure is not
 * proof of no effect). Rebuilding it inside a wording fix is the same mistake with a deadline.
 *
 * SO THE MESSAGE NOW SAYS ONLY WHAT CAN BE DONE, NAMES WHAT CANNOT, AND POINTS AT THE FILED WORK
 * (o3d-3lhp). The one real lever it names was verified the same way as the refusals: turning
 * `quickbooks_sync_enabled` off stops the stale-claim sweep AND the manual sync, because both gate
 * on it before the processor is reached. It is a blunt lever — it stops every QuickBooks row — and
 * the message says that too, rather than implying a per-row control that does not exist.
 *
 * The `check` is what the operator does about the effect; the `effect` is what the replay costs.
 */
const QBO_OPERATIONS_WITHOUT_REQUEST_ID: Partial<Record<AccountingSyncType, { effect: string; check: string }>> = {
  BILL_ATTACHMENT: {
    // THE ONLY ONE OF THE FOUR WITH A KILL SWITCH IN FRONT OF IT (round 6). The handler reads
    // `quickbooks_sync_attach_pdf` and returns success WITHOUT uploading when it is 'false', so on
    // an install that has turned attachments off the replay costs nothing. Stating the repeat
    // unconditionally would send that operator hunting a duplicate that cannot exist.
    effect: 'the supplier invoice PDF is uploaded to the QuickBooks bill AGAIN, once per sweep — '
      + 'unless the setting quickbooks_sync_attach_pdf is "false", in which case the operation '
      + 'succeeds without uploading anything and the replay attaches nothing',
    check: 'check that setting first; if attachments are on, open the bill in QuickBooks and delete '
      + 'any duplicate attachment',
  },
  INVOICE_PDF: {
    effect: 'the invoice PDF is re-downloaded and written over the stored copy AGAIN, once per sweep',
    check: 'confirm the invoice PDF stored against the order is the document you expect',
  },
  INVOICE_EMAIL: {
    effect: 'ANOTHER COPY OF THE INVOICE EMAIL IS QUEUED TO THE CUSTOMER — one more PENDING '
      + 'accounting-invoice row in the email outbox per sweep, every one of which the outbox sender '
      + 'will deliver',
    check: 'this operation succeeds by QUEUEING, not by sending, and IMS CANNOT CANCEL A QUEUED COPY. '
      + 'EmailOutbox has four states — PENDING, PROCESSING, SENT, FAILED — none of which means '
      + '"deliberately not delivered", and no action, route or screen removes an unsent row, so every '
      + 'copy already queued WILL be delivered and there is nothing to press. What you CAN do is COUNT '
      + 'them — BUT STOP THE REPLAY FIRST (the blunt lever below), because until it is stopped the '
      + 'count grows by one every sweep and the number you give the customer is already wrong. Then '
      + 'query the email outbox directly for kind ACCOUNTING_INVOICE, referenceType SalesOrder, '
      + 'referenceId = the order id (no page in IMS lists them), and tell the customer how many copies '
      + 'are on their way',
  },
  WC_INVOICE_NOTE: {
    effect: 'a second invoice note is written onto the WooCommerce order, once per sweep',
    check: 'open the order in WooCommerce and remove any duplicate note',
  },
}

/**
 * THE FOUR TYPES, AS A VALUE, BECAUSE SOMETHING OTHER THAN THE WORDING NOW HAS TO ASK (Codex MEDIUM).
 *
 * Derived from the table above rather than written out again: a fifth no-identifier operation is one
 * edit there, and every reader of this set moves with it. A second hand-kept list would be the same
 * defect `UNRECORDED_POSTED_DOCUMENT_ACTIONS` exists to prevent, one level down.
 */
export const QBO_NO_IDENTIFIER_OPERATION_TYPES: readonly string[] =
  Object.freeze(Object.keys(QBO_OPERATIONS_WITHOUT_REQUEST_ID))

/**
 * WHAT ONE PRESERVED INCIDENT ACTUALLY IS.
 *
 * `LEDGER_DOCUMENT` — a document Xero or QuickBooks accepted and still holds. Real money in somebody
 * else's books; no reset of ours voids it.
 * `NO_IDENTIFIER_SIDE_EFFECT` — one of the four operations above. No ledger document was created at
 * all: a file was attached, a PDF was written over, an email was QUEUED, a note was pushed to
 * WooCommerce. `INVOICE_EMAIL` in particular creates only a LOCAL outbox row.
 * `UNCLASSIFIED` — the record does not carry a usable type. Counted separately and NEVER folded into
 * either: the whole point is to stop asserting a remote document, and guessing one is how the
 * assertion got made in the first place.
 */
export type UnrecordedIncidentKind = 'LEDGER_DOCUMENT' | 'NO_IDENTIFIER_SIDE_EFFECT' | 'UNCLASSIFIED'

/**
 * CLASSIFY BY THE OPERATION TYPE, NOT BY THE ACTION NAME (Codex MEDIUM).
 *
 * THE DEFECT. The factory reset preserved and counted every row under BOTH action names and then
 * told the operator each one was "a document still existing in Xero or QuickBooks". The QuickBooks
 * action does not mean that: it is written for the four no-identifier operations too, and for an
 * `INVOICE_EMAIL` there is no remote document anywhere — only a local `EmailOutbox` row, which the
 * same reset deleted a few statements earlier. The breadcrumb is exempt from retention and from the
 * reset, so that sentence was permanent evidence of something that never existed.
 *
 * BY TYPE RATHER THAN BY CONNECTOR, deliberately. `AccountingSyncType` is shared, and the four are
 * no-identifier operations wherever they run — a Xero-side `INVOICE_PDF` incident would be exactly
 * as much "not a ledger document" as a QuickBooks one. Keying on the ACTION would reproduce the
 * original mistake with the connectors swapped.
 *
 * Both record builders write `metadata.type` from `entry.type`
 * (xero/sync-processor.ts `unrecordedPostedDocumentRecord`, quickbooks/sync-processor.ts
 * `unpersistedQboPostRecord`), so the field this reads is written on every row either connector
 * produces. A row without it is UNCLASSIFIED rather than assumed.
 */
export function classifyUnrecordedIncident(metadata: unknown): UnrecordedIncidentKind {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return 'UNCLASSIFIED'
  const type = (metadata as { type?: unknown }).type
  if (typeof type !== 'string' || type.length === 0) return 'UNCLASSIFIED'
  return QBO_NO_IDENTIFIER_OPERATION_TYPES.includes(type) ? 'NO_IDENTIFIER_SIDE_EFFECT' : 'LEDGER_DOCUMENT'
}

/** One tally per kind, so a caller cannot report a total it has not broken down. */
export type UnrecordedIncidentCounts = Record<UnrecordedIncidentKind, number>

export function countUnrecordedIncidents(rows: readonly { metadata: unknown }[]): UnrecordedIncidentCounts {
  const counts: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0,
    NO_IDENTIFIER_SIDE_EFFECT: 0,
    UNCLASSIFIED: 0,
  }
  for (const row of rows) counts[classifyUnrecordedIncident(row.metadata)] += 1
  return counts
}

/**
 * THE RESET'S BREADCRUMB, BUILT FROM THE COUNTS RATHER THAN AROUND THEM.
 *
 * Each kind gets its own sentence and its own number, and a kind with nothing in it says NOTHING —
 * an install whose only preserved incident is a queued email must not be handed a paragraph about
 * documents standing in a ledger, which is precisely the falsehood this replaces. The wording lives
 * here, next to the classifier that decides which sentence a row earns, so the two cannot drift.
 */
export function describePreservedUnrecordedIncidents(counts: UnrecordedIncidentCounts): string {
  const total = counts.LEDGER_DOCUMENT + counts.NO_IDENTIFIER_SIDE_EFFECT + counts.UNCLASSIFIED
  const parts: string[] = [
    `Database reset kept ${total} record(s) of things IMS did against an accounting connector and `
    + 'could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately.',
  ]
  if (counts.LEDGER_DOCUMENT > 0) {
    parts.push(
      `${counts.LEDGER_DOCUMENT} name a DOCUMENT Xero or QuickBooks accepted and still holds — real `
      + 'money in somebody else\'s books, which no reset of ours voids. Open the id in that system.',
    )
  }
  if (counts.NO_IDENTIFIER_SIDE_EFFECT > 0) {
    parts.push(
      `${counts.NO_IDENTIFIER_SIDE_EFFECT} are NOT ledger documents and created nothing in Xero or `
      + 'QuickBooks to go and look for. They record an effect that landed somewhere else and can '
      + 'repeat: a file attached to a QuickBooks bill, an invoice PDF written over the stored copy, an '
      + 'invoice email QUEUED to a customer, a note written onto a WooCommerce order. The queued-email '
      + 'one never had a remote document at all — only a local email-outbox row, WHICH THIS RESET HAS '
      + 'JUST DELETED, so the copies that record tells you to count are gone with it and the count '
      + 'cannot be made after the fact.',
    )
  }
  if (counts.UNCLASSIFIED > 0) {
    parts.push(
      `${counts.UNCLASSIFIED} carry no readable operation type, so IMS cannot say which of the two `
      + 'they are. Read those records themselves before assuming either.',
    )
  }
  parts.push(
    'Each record says what the effect was and what can be done about it. Nothing else in IMS '
    + 'references any of them any more. Search this log for '
    + `${UNRECORDED_POSTED_DOCUMENT_ACTIONS.map((action) => `"${action}"`).join(' or ')}.`,
  )
  return parts.join(' ')
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
 *     reader has to be told to go and look at the effect — and told, in the same breath, that the
 *     per-row stop they would reach for does not exist and what the blunt one is (round 3).
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
      + `WHAT TO DO ABOUT THE EFFECT: ${noRequestId.check}. `
      + `WHAT YOU CANNOT DO WHILE QUICKBOOKS IS THE ACTIVE CONNECTOR: settle sync row ${entry.id} by `
      + 'hand. The settlement action refuses it — this connector stamps no attempt revision, so its rows '
      + 'stay at revision 0 and the attempt fence answers UNFENCED_ATTEMPT. THE LOG VIEW DOES SHOW YOU '
      + 'SOMETHING, AND IT IS NOT A BUTTON: the accounting log renders the settle control for every '
      + 'FAILED or PROCESSING row, and on this one it resolves to the words "not settleable", with its '
      + 'reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the generic reason, written for a '
      + 'connector that stamps attempts, and it tells you to retry the row until it shows one: '
      + 'QuickBooks never stamps one, so no number of retries will ever make an attempt appear — and '
      + 'every retry is another replay of the effect above. It could not mark a row FAILED in any case: '
      + 'settlement has only two outcomes, SYNCED and CANCELLED. '
      + 'THE BLUNT LEVER, AVAILABLE NOW, is turning QuickBooks sync OFF (Sync settings, the Sync '
      + 'Enabled toggle, i.e. quickbooks_sync_enabled). The stale-claim sweep and the manual sync both '
      + 'gate on it and both stop. It stops EVERY QuickBooks row, not this one, and it recalls nothing '
      + 'already queued or already done; until it is off, the effect above repeats every sweep. '
      + `AND THE PER-ROW REMEDY DOES EXIST, BUT IT NEEDS BOTH OF TWO THINGS, NOT ONE — the refusal above `
      + 'is a fact about the INSTALLATION, not about this row for ever. '
      + 'FIRST, QUICKBOOKS MUST STOP BEING THE ACTIVE CONNECTOR. That is resolved XERO-FIRST from the '
      + 'integration PLUGIN switches, so enabling the Xero plugin is what does it — BUT YOU CANNOT ENABLE '
      + 'XERO BESIDE QUICKBOOKS. The plugin save validates the RESULTING selection and refuses that state '
      + 'outright: "Enable either Xero or QuickBooks, not both — accounting dispatch is single-connector." '
      + 'SO THIS STEP IS A DELIBERATE RETIREMENT OF QUICKBOOKS, and it must be ONE save: on Settings > '
      + 'Integrations, turn the QuickBooks switch OFF and the Xero switch ON before saving, because that '
      + 'screen posts every switch together and a resulting state with both on is rejected. THAT STOPS THE '
      + 'CRON AND ONLY THE CRON — the accounting-sync route takes the Xero branch and never reaches the '
      + 'QuickBooks processor. '
      + 'IT DOES NOT STOP THE MANUAL SYNC, AND THAT IS THE SECOND THING. The QuickBooks Sync button gates '
      + 'on quickbooks_sync_enabled and NOTHING ELSE — it never asks which connector is active — so while '
      + 'that toggle is on, anyone holding the sync permission can press it and the stale-claim sweep '
      + `reclaims row ${entry.id} again. SO TURN quickbooks_sync_enabled OFF AS WELL. Until both hold, the `
      + 'STRANDED SYNC ROWS list withholds the Settle control from this row and gives its reason there, '
      + 'naming this toggle. '
      + 'THE ORDER THAT MAKES IT A PER-ROW REMEDY RATHER THAN A PERMANENT SHUTDOWN, AND IT IS ALSO WHAT '
      + 'MAKES THE COUNT ABOVE HOLD STILL: turn quickbooks_sync_enabled off FIRST — that alone stops both '
      + 'the sweep and the button, so nothing further can be queued while you work — then retire '
      + 'QuickBooks in favour of Xero as above, count the queued copies, settle this row, and turn '
      + 'quickbooks_sync_enabled back on. The row is terminal by then, so the sweep has nothing to '
      + 'reclaim — every OTHER QuickBooks row resumes and this one does not. '
      + `WHERE THE CONTROL IS. Sync row ${entry.id} appears in the STRANDED SYNC ROWS list in the `
      + 'connector-orphan banner on the Sync screen — that list selects unresolved rows on a NON-ACTIVE '
      + 'connector, PROCESSING included, and once QuickBooks is retired it is the only view this row still '
      + 'appears in at all — every accounting LOG view is scoped to the ACTIVE connector, so the row '
      + 'leaves the log the moment Xero takes over. IT IS NOT A COMPLETE LIST: it shows the 50 OLDEST '
      + 'stranded rows, with no paging, filter or search, ordered by the SYNC ROW\'s creation time — so a '
      + 'row queued today sorts LAST, while one that has been replaying for weeks sorts near the front. '
      + 'The banner states the total and says when it is cut short; if this row is not on the page, clear '
      + 'or settle older ones until it is. '
      + 'IT IS SETTLED THERE BY ADOPTION: with both conditions above holding, nothing — not the cron, not '
      + 'the manual sync — can claim a QuickBooks row, so the abandoned attempt in front of you is the '
      + 'only one this row can have had, and the adoption is itself compare-and-swapped on (row, '
      + 'revision 0, status). Settling it NOT_POSTED terminalises it CANCELLED and releases the claim. '
      + '(Settling is an assertion about the OUTSIDE world and does not undo anything already done or '
      + 'already queued — the copies above still arrive.) '
      + 'This is the known hole o3d-qn21, and the missing operations — an outbox cancel, and a per-row '
      + 'remediation that works WITHOUT retiring the connector — are filed as o3d-3lhp. Until those '
      + 'land this record is the only thing that says the effect repeated.'
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
