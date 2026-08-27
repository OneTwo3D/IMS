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

/**
 * WHAT THIS ATTEMPT ACTUALLY DID, WHERE THE OPERATION TYPE CANNOT SAY (round 10, Codex HIGH).
 *
 * THE DEFECT THIS EXISTS FOR. Round 9 made the classifier and the formatter share one decision and
 * keyed it on the OPERATION TYPE — a map that is exhaustive over every member of
 * `AccountingSyncType`, which reads as total and is not. `SALES_INVOICE_UPDATE` and
 * `PURCHASE_INVOICE_UPDATE` MODIFY a document that already existed, so a persistence conflict does
 * not imply a duplicate and "void it" can VOID A VALID PRE-EXISTING INVOICE OR BILL. And the same
 * type that posts a live journal posts an unposted DRAFT when the row's `_postingMode` is `draft`:
 * no balance has moved, "post a reversing journal" would move them for real, and the reset
 * breadcrumb described every such incident as real money in the books.
 *
 * So the enum member is not the thing that decides the remedy. Two facts decide it and neither is
 * derivable from the type:
 *
 *   • `postingMode` — whether the document reached the ledger or was created as a DRAFT. On Xero it
 *     is `resolveInvoiceStatus`/`resolveJournalStatus` reading `payload._postingMode`; on
 *     QuickBooks there is no draft form of any document at all (quickbooks/invoices.ts says so in as
 *     many words: "No DRAFT/AUTHORISED status distinction on creation"), so that connector resolves
 *     LIVE and a test holds it to that. THE SAME FALSEHOOD IS STILL LIVE IN A SIBLING RECORD: the
 *     fence-loss escalation's `postEffectFor` applies its draft wording to journals only, so a draft
 *     INVOICE there is still told to be voided or credit-noted (filed as o3d-d3re).
 *   • `externalEffect` — whether the handler touched the remote system at all. `BILL_ATTACHMENT`
 *     returns `{ success: true }` WITHOUT uploading when its connector's attach-PDF setting is
 *     `'false'`, so one operation type covers "an attachment now exists on that bill" and "nothing
 *     left this process".
 *
 * BOTH ARE OPTIONAL, AND AN ABSENT ONE IS NOT A DEFAULT. A record that does not carry the fact says
 * so and tells the operator to escalate. Guessing LIVE is how this record came to prescribe voiding
 * a document that was already there; guessing an upload is how it came to send someone to remove an
 * attachment this attempt never created.
 */
export type LedgerPostingMode = 'LIVE' | 'DRAFT'
export type RemoteEffectOutcome = 'MADE' | 'NONE'
export type PostedOperationOutcome = {
  postingMode?: LedgerPostingMode
  externalEffect?: RemoteEffectOutcome
}

export type UnrecordablePostedDocument = {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  /** What THIS worker posted and cannot record. */
  postedExternalId: string | null
  reason: UnrecordablePostedDocumentReason
  /** What the row keeps instead (null when the row is gone). */
  namedExternalId: string | null
  /** What the attempt DID — see {@link PostedOperationOutcome}. Absent means "not recorded". */
  outcome?: PostedOperationOutcome
}

/**
 * The operator-facing account of the incident — ONE wording, used by the durable record, by the
 * outbox job's failure message and by the last-resort console escalation, so a single incident can
 * never be described three different ways on three different screens.
 *
 * Every refusal says plainly that nothing will retry the row, and ends in something a person can
 * actually do — which, for an operation that created no document, is never a document instruction
 * (round 9).
 */
export function describeUnrecordablePostedDocument(incident: UnrecordablePostedDocument): string {
  const { entry, postedExternalId, namedExternalId, reason } = incident
  // ROUND 8 (Codex MEDIUM): THE REMEDY MAY ONLY NAME AN ID THE RECORD ACTUALLY CARRIES. Both fields
  // are nullable, and "(no id returned)" is what this line already printed when one was — so
  // "find it by the id above" and "open both ids" were instructions to open a string that says
  // there is no string. An id that is absent gets a remedy that does not need one instead.
  const posted = nonEmpty(postedExternalId)
  const named = nonEmpty(namedExternalId)
  // ROUND 10 (Codex HIGH): AND THE KIND IS DECIDED BY WHAT THE ATTEMPT DID, NOT BY WHICH ENUM
  // MEMBER IT WAS. See `PostedOperationOutcome`: an UPDATE creates nothing, a DRAFT moves nothing,
  // and an unrecorded posting mode is not a live posting.
  const kind = incidentKindForOperation(entry.type, posted, incident.outcome)
  if (!isDocumentKind(kind)) {
    return describeNonDocumentIncident({
      ledger: 'Xero',
      entry,
      kind,
      postedExternalId: posted,
      outcome: incident.outcome,
      rowState: reason === 'ROW_MISSING'
        ? `Its sync row ${entry.id} no longer exists, so nothing in IMS references it. `
        : `Sync row ${entry.id} already names a different external id (${named ?? 'unknown'}) and was `
          + 'left naming that one. ',
    })
  }
  const w = documentIncidentWording(entry.type, kind)
  const slots: WordingSlots = {
    ledger: 'Xero', postedExternalId: posted, lookup: w.lookup, lookupNoun: w.noun,
  }
  const did = render(posted ? w.didWithId : w.didWithoutId, slots)
  const head = `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} ${did}, `
  return reason === 'ROW_MISSING'
    ? head
      + `but its sync row ${entry.id} no longer exists, so nothing in IMS references ${render(w.noun, slots)}. `
      + (posted
        ? render(w.remedyRowGone, slots)
        : 'NO ID WAS RETURNED, so there is nothing to open — do not go looking for one. '
          + `${render(w.absent, slots)} ${ESCALATE_REMEDY}, and note that `)
      + 'nothing further will be retried for this row. '
      + INCIDENT_IDENTIFICATION_TAIL
    : head
      + `but sync row ${entry.id} already names a DIFFERENT ${render(w.conflictNoun, slots)} `
      + `(${named ?? 'unknown'}) — a newer claim posted while this attempt was on the wire. `
      + `${render(w.bothExist, slots)} The row was left naming the first one. `
      + (posted && named
        ? render(w.remedyDuplicate, slots)
        : 'ONE OF THE TWO IDS IS NOT RECORDED HERE, so they cannot both be opened. '
          + `${ESCALATE_REMEDY}, and note that `)
      + 'no further sync attempt will touch either. '
      + INCIDENT_IDENTIFICATION_TAIL
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
  /** What the attempt DID — see {@link PostedOperationOutcome}. Absent means "not recorded". */
  outcome?: PostedOperationOutcome
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
 * ----------------------------------------------------------------------------------------------
 * ROUND 7 (Codex HIGH): THE WHOLE REMEDY RESTED ON A FENCE THAT DOES NOT EXIST, SO THE REMEDY IS
 * GONE — THIS RECORD NOW REQUIRES THE CONNECTOR TO STAY OFF AND THE ROW TO BE ESCALATED.
 * ----------------------------------------------------------------------------------------------
 * Rounds 5 and 6 built a per-row remedy on one sentence: turn `quickbooks_sync_enabled` off and
 * "nothing further can be queued while you work", then count, settle, and turn it back on. THAT
 * SENTENCE IS FALSE, and every step after it inherited the falsehood. Walked into the tree:
 *
 *   • BOTH claim paths READ the setting and THEN call the processor with nothing in between —
 *     app/api/cron/accounting-sync/route.ts and `triggerQuickBooksSync` in
 *     app/actions/quickbooks-sync.ts. The toggle is an ADMISSION CHECK. A run that passed the read
 *     a moment before the operator flipped it is still running, and still claims rows.
 *   • That run's claim is indistinguishable from the abandoned one. `stampingCustodyOnClaim` writes
 *     status and custody and NEVER `attemptRevision`, so the freshly claimed row is PROCESSING at
 *     revision 0 — exactly what adoption's compare-and-swap on (id, revision 0, status) matches.
 *   • And the writeback has no fence at all. `persistFreshQboPost` issues
 *     `accountingSyncLog.update({ where: { id } })` with SYNCED and the external id: no claim token,
 *     no attempt revision, no status predicate. It lands on whatever the row says by then —
 *     including a settlement made in between.
 *
 * So an admitted worker can queue ANOTHER customer email after the operator's count, win a race
 * against a successful settlement, and overwrite the CANCELLED row with a SYNCED one. Nothing in
 * IMS reports an in-flight run, so there is no moment an operator can point at and call the row
 * quiet.
 *
 * THE CHOICE, MADE DELIBERATELY. The alternative was to build the missing quiescence — a shared
 * execution or generation fence honoured by the cron branch, the manual sync, the claim AND the
 * writeback. That is not a wording fix: it is the attempt fence this branch has already built and
 * reverted TWICE (o3d-peh1 rounds 6 and 7) because this connector lacks the primitives, and the
 * branch is under a no-migration rule. Writing a third one to justify a paragraph would be the same
 * mistake with a deadline. So the record stops prescribing the unsafe procedure instead: it names
 * the lever, says plainly what the lever does NOT do, tells the operator to LEAVE IT OFF, and
 * escalates the row for manual recovery. The missing fence is filed as o3d-4b5p.
 *
 * WHAT WAS DELETED RATHER THAN SOFTENED: the instruction to retire QuickBooks in favour of Xero,
 * the instruction to count the queued copies and report that number, the instruction to settle the
 * row, and the instruction to turn the toggle back on. A softer version of an unsafe procedure is
 * still an unsafe procedure. What was KEPT is the warning about the settle control's tooltip,
 * because the operator sees that control whether this record mentions it or not, and following it
 * replays the effect.
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
 * (o3d-3lhp, o3d-4b5p). The one lever it names was verified the same way as the refusals — including
 * WHAT THE OPERATOR SEES: the checkbox that writes it is labelled "Enable Xero Sync" on the
 * QuickBooks panel too, because `ACCOUNTING_CONNECTOR_UI` maps both connectors to `XeroClient` and
 * that label is a literal while the KEY comes from `settingKeyFor(connectorId, 'sync_enabled')`. The
 * message says so rather than naming a "Sync Enabled" control nobody can find (o3d-m9wm). Turning
 * `quickbooks_sync_enabled` off stops a NEW cron pass and a NEW press of the manual Sync button,
 * because both READ that setting before they call the processor. What it does not do is stop a run
 * already past that read — see ROUND 7 below, which is why the message no longer builds a remedy on
 * top of it. It is also a blunt lever, stopping every QuickBooks row, and the message says so.
 *
 * The `check` is what the operator does about the effect; the `effect` is what the replay costs.
 */
type ReplayWording = { effect: string; check: string }
const QBO_OPERATIONS_WITHOUT_REQUEST_ID: Partial<Record<
  AccountingSyncType,
  ReplayWording | Readonly<Record<RemoteEffectKnowledge, ReplayWording>>
>> = {
  // ROUND 10 (Codex MEDIUM): THE ONLY ONE OF THE FOUR WITH A KILL SWITCH IN FRONT OF IT, AND THE
  // RECORD NOW SAYS WHICH SIDE OF IT THIS ATTEMPT FELL. The handler reads
  // `quickbooks_sync_attach_pdf` and returns success WITHOUT uploading when it is 'false'. Round 6
  // wrote that as a HEDGE inside one sentence — "…unless the setting is false, in which case…" —
  // which is a wording that is never true, only never quite false: an operator on an install with
  // uploads ON reads a conditional about a setting they must go and check, and an operator with
  // them OFF reads that a PDF is being uploaded. The handler's actual outcome is recorded now, so
  // each case gets a sentence that is simply true, and the hedge survives ONLY where the record
  // genuinely does not know.
  BILL_ATTACHMENT: {
    MADE: {
      effect: 'the supplier invoice PDF is uploaded to the QuickBooks bill AGAIN, once per sweep',
      check: 'open the bill in QuickBooks and delete any duplicate attachment',
    },
    NONE: {
      effect: 'NOTHING AT ALL — attachment upload is turned off for this connector, so every sweep '
        + 're-runs a handler that returns success without contacting QuickBooks and without '
        + 'uploading anything',
      check: 'nothing needs undoing for the attachment: this attempt created none, and no replay '
        + 'creates one while that setting stays off',
    },
    UNRECORDED: {
      effect: 'the supplier invoice PDF is uploaded to the QuickBooks bill AGAIN, once per sweep — '
        + 'unless attachment upload is turned off for this connector, in which case every sweep does '
        + 'nothing at all',
      check: 'IMS DID NOT RECORD WHETHER THIS ATTEMPT UPLOADED ANYTHING, so do not delete an '
        + 'attachment on the strength of this record — it may never have created one. Read the '
        + 'setting quickbooks_sync_attach_pdf, then open the bill in QuickBooks and compare what is '
        + 'attached against what should be there',
    },
  },
  INVOICE_PDF: {
    effect: 'the invoice PDF is re-downloaded and written over the stored copy AGAIN, once per sweep',
    check: 'confirm the invoice PDF stored against the order is the document you expect',
  },
  INVOICE_EMAIL: {
    // NO DELIVERY CLAIM (round 7, Codex MEDIUM). The previous wording said every queued copy "will
    // be delivered". The outbox sender terminalises a row FAILED for a suppressed recipient, for a
    // permanent send failure, and when EMAIL_MAX_ATTEMPTS is exhausted (lib/email-outbox.ts), so
    // that was an absolute the data cannot carry. What IS true is the row.
    //
    // AND NO NON-DELIVERY CLAIM EITHER (round 8, Codex HIGH). Round 7 then said a FAILED row "never
    // went at all", which is the same mistake inverted: an ABSENCE OF CONFIRMATION read as a
    // NEGATIVE ANSWER. `processPendingEmailOutbox` stamps SENT only AFTER `sendEmail` has returned,
    // and that stamp is inside the try whose catch writes `status: permanentFailure ? 'FAILED' :
    // 'PENDING'` — so a delivered copy whose stamp could not be written lands FAILED on the fifth
    // attempt and lands PENDING (and is SENT AGAIN) before it. `sendEmail` itself decides
    // success from the transport error's responseCode/code/message (lib/mailer.ts), which cannot
    // distinguish "rejected" from "accepted, then the connection died".
    //
    // AND NOT EVEN THE SUPPRESSION PREFIX (round 9, Codex HIGH) — THE SEVENTH TIME ON THIS BRANCH
    // THAT "WE DO NOT KNOW" HAS BEEN READ AS "IT DID NOT HAPPEN". Round 8 called the
    // `emailSuppression` lookup "the one conclusive FAILED", because it runs BEFORE the send. It
    // runs before THIS retry's send, which is not the same claim. The branch reads nothing but the
    // suppression table: not `attempts`, not `sentAt`, not the error already on the row. So an
    // earlier attempt can hand the message to a mail server, fail to write SENT, and be returned to
    // PENDING by the catch; a suppression added before the next sweep then overwrites that row with
    // FAILED and `Suppressed recipient: …`, and a stale PROCESSING row left by a post-send crash
    // takes the same branch to the same place. The prefix therefore says a copy was refused on the
    // attempt that wrote it, and nothing about the attempts before it — so the conclusive claim is
    // DELETED rather than narrowed. Supporting one needs a durable per-attempt outcome instead of a
    // final error string read backwards, and that is filed as o3d-ch0h.
    //
    // AND THE INSPECTION IS NOT ORDERED BEHIND A STOP (round 8, Codex MEDIUM). The check used to
    // say "STOP THE REPLAY FIRST", then inspect. The only lever is the sync toggle, which this same
    // record already says is an admission check and not a fence, so that ordering cannot be
    // established: the query is a snapshot that can still grow, and it says so.
    effect: 'ANOTHER COPY OF THE INVOICE EMAIL IS QUEUED TO THE CUSTOMER — one more PENDING '
      + 'accounting-invoice row in the email outbox per sweep',
    check: 'this operation succeeds by QUEUEING, not by sending, and IMS CANNOT CANCEL A QUEUED COPY. '
      + 'EmailOutbox has four states — PENDING, PROCESSING, SENT, FAILED — none of which means '
      + '"deliberately not delivered", and no action, route or screen removes an unsent row, so there '
      + 'is nothing to press. TURN THE LEVER BELOW OFF FIRST, so that no NEW run is admitted — but '
      + 'it is an ADMISSION CHECK, NOT A FENCE: a run admitted a moment before you flipped it can '
      + 'queue another copy afterwards, and nothing in IMS reports whether one is doing so. Then '
      + 'INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, '
      + 'referenceId = the order id (no page in IMS lists them) and read each row\'s status, attempts, '
      + 'lastError, createdAt and sentAt. WHAT COMES BACK IS A NON-QUIESCENT SNAPSHOT: the set can '
      + 'still grow after you have read it, so re-run the query rather than treating one result as '
      + 'the final list. AND IMS CANNOT NARROW IT: no outbox row records the sync attempt that queued '
      + 'it, so nothing attributes a copy to this incident; the authenticated accounting-invoice '
      + 'email action writes the identical shape, so ordinary operator sends are in the same result; '
      + 'a SENT row has already gone; and A FAILED ROW IS NOT PROOF THAT NOTHING WENT — it means IMS '
      + 'HOLDS NO DURABLE CONFIRMATION OF DELIVERY. NO FAILED ROW PROVES A COPY WAS NEVER SENT, '
      + 'WHATEVER ITS lastError SAYS — NOT EVEN "Suppressed recipient:". '
      + 'The sender stamps SENT only after the transport call has returned, and that stamp is inside '
      + 'the same try whose catch writes FAILED on the fifth attempt (and PENDING before it, which '
      + 'sends the copy again), so a copy that WAS delivered and could not be stamped ends up FAILED; '
      + 'a send is judged from the transport error alone, which cannot say whether the server had '
      + 'already accepted the message; and the suppression check that writes that prefix runs at the '
      + 'top of the sweep, reads only the suppression table, and overwrites whatever the row already '
      + 'carried — so it speaks for the attempt that wrote it and for no attempt before it. IMS keeps '
      + 'no per-attempt outcome, so no row can be read backwards into its own history (o3d-ch0h). '
      + 'Read them by status, lastError and time, and DO NOT REPORT A '
      + 'COUNT OF DUPLICATES, OF PENDING DELIVERIES OR OF COPIES THAT DID NOT ARRIVE FROM THIS QUERY: '
      + 'it cannot establish any of them (o3d-il7a)',
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
 * `LEDGER_DOCUMENT` — a LIVE effect stands in Xero or QuickBooks, with an id that opens it: a
 * document created, a document modified, a payment applied, or a journal posted. Real money is
 * involved and no reset of ours undoes it. WHICH of those four it was decides the remedy and is a
 * separate question — see {@link OPERATION_SEMANTIC_BY_TYPE}.
 * `LEDGER_DOCUMENT_NO_IDENTIFIER` — the same class of write, on a record that carries NO id (round
 * 8, Codex MEDIUM). The effect is exactly as real; what is missing is the way to reach it.
 * `LEDGER_DRAFT` — a document or manual journal CREATED UNPOSTED (round 10, Codex HIGH). It sits in
 * the ledger's drafts and NO BALANCE HAS MOVED. Its remedy is DELETION: a reversal or a credit note
 * posts for real, so following the live remedy moves the accounts by exactly the amount the draft
 * never moved, and leaves the draft sitting there as well.
 * `LEDGER_OUTCOME_UNRECORDED` — an operation that is live on one posting-mode setting and a draft on
 * the other, on a record that does not carry which was used. IMS cannot say whether a balance moved,
 * so it says that, and nothing else.
 * `LEDGER_NON_DOCUMENT` — a write the ledger accepted that is NOT a standalone document and returns
 * no id to open: a credit note APPLIED to a bill, a tax rate written into the organisation. The
 * write stands, and the allocation moves money — but there is nothing to go and look up by id.
 * `NO_IDENTIFIER_SIDE_EFFECT` — an operation that creates no accounting document anywhere: a file
 * attached to an existing bill, a PDF written over, an email QUEUED, a note pushed to WooCommerce.
 * `INVOICE_EMAIL` in particular creates only a LOCAL outbox row, and `BILL_ATTACHMENT` may create
 * nothing at all.
 * `UNCLASSIFIED` — the record carries no type this codebase has classified. Counted separately and
 * NEVER folded into any of the others: the whole point is to stop asserting a remote document, and
 * guessing one is how the assertion got made in the first place.
 */
export type UnrecordedIncidentKind =
  | 'LEDGER_DOCUMENT'
  | 'LEDGER_DOCUMENT_NO_IDENTIFIER'
  | 'LEDGER_DRAFT'
  | 'LEDGER_OUTCOME_UNRECORDED'
  | 'LEDGER_NON_DOCUMENT'
  | 'NO_IDENTIFIER_SIDE_EFFECT'
  | 'UNCLASSIFIED'

/** The kinds whose wording is a DOCUMENT wording. Everything else takes the non-document message. */
const DOCUMENT_KINDS = new Set<UnrecordedIncidentKind>([
  'LEDGER_DOCUMENT', 'LEDGER_DOCUMENT_NO_IDENTIFIER', 'LEDGER_DRAFT', 'LEDGER_OUTCOME_UNRECORDED',
])
function isDocumentKind(kind: UnrecordedIncidentKind): boolean {
  return DOCUMENT_KINDS.has(kind)
}

/** How much this record knows about whether the handler touched the remote system at all. */
type RemoteEffectKnowledge = 'MADE' | 'NONE' | 'UNRECORDED'
function remoteEffectKnowledge(outcome: PostedOperationOutcome | undefined): RemoteEffectKnowledge {
  return outcome?.externalEffect ?? 'UNRECORDED'
}

/** '' and null are the same answer here, and both of them are "no id". */
function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * WHAT EACH OPERATION SEMANTICALLY DOES — CREATE, UPDATE, PAY, JOURNAL (round 10, Codex HIGH).
 *
 * THE DEFECT THIS REPLACES. Round 9's map answered ONE question — "is there a document at this
 * id?" — and answered it `LEDGER_DOCUMENT` for every type whose handler returns a document id. That
 * map is exhaustive over the enum and it LOOKS total, which is exactly why it went unquestioned for
 * two rounds: `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` return the id of a document they
 * MODIFIED and did not create, so a persistence conflict on one implies no duplicate at all, and the
 * remedy "keep it or void it" could VOID A VALID PRE-EXISTING INVOICE OR BILL. `INVOICE_PAYMENT` and
 * `BILL_PAYMENT` return a PAYMENT id, and voiding or credit-noting the invoice a payment was applied
 * to is the wrong document entirely. The kinds were exhaustive over enum NAMES and not over
 * OUTCOMES.
 *
 * SO THE AXIS IS THE OPERATION, and the compiler enforces it the same way: `satisfies
 * Readonly<Record<AccountingSyncType, …>>` fails the build the day a member is added to the enum.
 * The literals are preserved with `as const` rather than erased by an annotation, because
 * {@link NonDocumentOperationType} is derived from them.
 *
 * HOW EACH ROW WAS DECIDED: by walking the connector handler. `CREATE_DOCUMENT` reaches a create
 * call and returns the new document's id; `UPDATE_DOCUMENT` reaches an update call against an id the
 * row already knew; `APPLY_PAYMENT` returns a payment id and creates no invoice or bill;
 * `POST_JOURNAL` goes through `pushManualJournal`; `LEDGER_NON_DOCUMENT` reaches the ledger and
 * returns nothing openable; `NO_LEDGER_EFFECT` never reaches an accounting ledger at all.
 *
 * KEYED ON THE TYPE, NOT THE CONNECTOR, deliberately — `AccountingSyncType` is shared, the same four
 * no-identifier operations exist on both, and a type QuickBooks has no branch for at all (the
 * allocation is one) is classified by what it IS rather than by who could have posted it.
 */
export type PostedOperationSemantic =
  | 'CREATE_DOCUMENT'
  | 'UPDATE_DOCUMENT'
  | 'APPLY_PAYMENT'
  | 'POST_JOURNAL'
  | 'LEDGER_NON_DOCUMENT'
  | 'NO_LEDGER_EFFECT'

export const OPERATION_SEMANTIC_BY_TYPE =
  Object.freeze({
    // Created here: the handler posts a NEW invoice, bill or credit note and returns its id.
    SALES_INVOICE: 'CREATE_DOCUMENT',
    PURCHASE_INVOICE: 'CREATE_DOCUMENT',
    CREDIT_NOTE: 'CREATE_DOCUMENT',
    PURCHASE_CREDIT_NOTE: 'CREATE_DOCUMENT',
    // NOT created here: the handler writes to a document that already stood in the ledger, and
    // returns the id OF THAT DOCUMENT. There is no duplicate and nothing to void.
    SALES_INVOICE_UPDATE: 'UPDATE_DOCUMENT',
    PURCHASE_INVOICE_UPDATE: 'UPDATE_DOCUMENT',
    // A PAYMENT id, applied against a document nobody created here.
    INVOICE_PAYMENT: 'APPLY_PAYMENT',
    BILL_PAYMENT: 'APPLY_PAYMENT',
    // Manual journals — one shared branch on both connectors, returning `journalId`. A journal is
    // not voidable or credit-notable; it is reversed, unless it is a DRAFT, when it is deleted.
    COGS_JOURNAL: 'POST_JOURNAL',
    INVENTORY_ADJUSTMENT: 'POST_JOURNAL',
    STOCK_IN_TRANSIT: 'POST_JOURNAL',
    STOCK_RECEIPT: 'POST_JOURNAL',
    COGS_REVERSAL: 'POST_JOURNAL',
    STOCK_ALLOCATION: 'POST_JOURNAL',
    DAILY_BATCH_REVENUE_DEFERRAL: 'POST_JOURNAL',
    DAILY_BATCH_INVENTORY_ALLOC: 'POST_JOURNAL',
    DAILY_BATCH_GROUP_B: 'POST_JOURNAL',
    DAILY_BATCH_INVENTORY_RECONCILIATION: 'POST_JOURNAL',
    DAILY_BATCH_COGS_RECONCILIATION: 'POST_JOURNAL',
    DAILY_BATCH_TRANSIT_RECONCILIATION: 'POST_JOURNAL',
    UNEARNED_REV_REVERSAL: 'POST_JOURNAL',
    ALLOCATION_REVERSAL: 'POST_JOURNAL',
    REALISED_FX_JOURNAL: 'POST_JOURNAL',
    UNREALISED_FX_JOURNAL: 'POST_JOURNAL',
    MANUFACTURING_JOURNAL: 'POST_JOURNAL',
    MANUFACTURING_RECLASS: 'POST_JOURNAL',
    // Accepted by the ledger, but not a document and no id to open.
    PURCHASE_CREDIT_NOTE_ALLOCATION: 'LEDGER_NON_DOCUMENT',
    TAX_RATE_SYNC: 'LEDGER_NON_DOCUMENT',
    // Nothing reaches an accounting ledger.
    BILL_ATTACHMENT: 'NO_LEDGER_EFFECT',
    INVOICE_PDF: 'NO_LEDGER_EFFECT',
    INVOICE_EMAIL: 'NO_LEDGER_EFFECT',
    WC_INVOICE_NOTE: 'NO_LEDGER_EFFECT',
  } as const) satisfies Readonly<Record<AccountingSyncType, PostedOperationSemantic>>

/**
 * WHICH OPERATIONS ARE SENT WITH A POSTING MODE AT ALL — READ OFF THE HANDLERS (round 11, Codex
 * MEDIUM).
 *
 * ROUND 10 GOT THE AXIS RIGHT AND THEN LET ONE SEMANTIC IGNORE HALF OF IT. It wrote that "an UPDATE
 * writes to a document that already existed … so the mode cannot turn a real effect into no effect".
 * THAT IS FALSE OF THIS CODEBASE. Both update handlers send `resolveInvoiceStatus(postingMode)`
 * exactly as the creates do (`SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` in the Xero
 * processor), and `_postingMode` is one per-sync-type operator setting shared by the create and the
 * update of the same document. So an update issued while that setting is `draft` sends status DRAFT:
 * the document it changed is an UNPOSTED DRAFT, no balance has moved, and round 10 counted it as a
 * LIVE document — which made the reset breadcrumb call it "real money in somebody else's books".
 *
 * THE MODEL IS NOW TWO INDEPENDENT AXES, and this set is the whole of the second one. The SEMANTIC
 * says what the operation did to the ledger (create / update / pay / journal); the POSTING STATE
 * says whether what it did reached the ledger at all. Membership here is decided by ONE question —
 * does the handler send a status resolved from `_postingMode`? — and not by whether the operation
 * feels like it creates something. A payment is the only document operation that does not: Xero
 * Payments have no draft form and no status is resolved for them.
 */
const DRAFT_CAPABLE_SEMANTICS = new Set<PostedOperationSemantic>([
  'CREATE_DOCUMENT', 'UPDATE_DOCUMENT', 'POST_JOURNAL',
])

/** The operation types this map classifies as reaching no ledger document — derived, never re-listed. */
type NonDocumentOperationType = {
  [K in keyof typeof OPERATION_SEMANTIC_BY_TYPE]:
    (typeof OPERATION_SEMANTIC_BY_TYPE)[K] extends 'LEDGER_NON_DOCUMENT' | 'NO_LEDGER_EFFECT'
      ? K
      : never
}[keyof typeof OPERATION_SEMANTIC_BY_TYPE]

/**
 * WHAT A WORDING IS ALLOWED TO SEND AN OPERATOR TO USE — DECLARED, NOT DETECTED (round 10, Codex
 * MEDIUM).
 *
 * THE DEFECT. Three remedies told an operator to find the write in the ledger "by the reference
 * above, its amount and its date". Neither record builder stores an amount or a date. Round 9
 * removed those words and then guarded them with a DETECTOR: a hand-written table of English
 * phrases, scanned over every generated message. That guard is bypassable by writing different
 * words. A new remedy saying "search by gross total and posting day" names two fields the record
 * does not hold, produces an EMPTY detected-field set, and passes. Generating every formatter branch
 * does not make an open-ended phrase allowlist exhaustive, and a permanent record is the last place
 * to rely on one.
 *
 * SO THE DESIGN IS INVERTED. The renderer no longer has its prose inspected; it DECLARES what it
 * needs, and the declaration is checked against what the builders actually write:
 *
 *   • a wording names a record value ONLY through a `{placeholder}`, and the placeholder set is this
 *     union — so `needs: ['grossTotal']` does not compile;
 *   • every wording entry carries `needs`, and `tests/accounting/record-names-only-what-it-holds.
 *     test.ts` parses the two record builders and fails if a declared key is one either builder does
 *     not write;
 *   • {@link render} throws on a placeholder that is not a slot, or on one whose value is absent —
 *     so a remedy selected in a state where its id is null cannot silently print "null", and the
 *     test that generates every message is what catches it before it ships.
 *
 * ROUND 11 (Codex MEDIUM): AND THAT WAS STILL NOT AN ENFORCED DECLARATION — IT WAS AN AUTHOR
 * CONVENTION WITH A TEST NEXT TO IT. Round 10 closed the sentence above with "whatever words it is
 * written in", and that was the third version of this invariant to claim closure it did not have.
 * The check reads `{placeholder}`s and trusts `needs`; a remedy that writes "search by gross total
 * and posting day" IN PROSE introduces no placeholder, leaves `needs` truthful, and passes. So the
 * LOOKUP CLAUSE ITSELF stopped being prose — see {@link LOOKUP_FIELD_PHRASE} and the fence in
 * tests/accounting/record-names-only-what-it-holds.test.ts, and read there what the invariant now
 * provably covers and what it provably does not.
 */
export const RECORD_LOOKUP_FIELDS = ['syncLogId', 'type', 'referenceType', 'referenceId', 'postedExternalId'] as const
export type RecordLookupField = (typeof RECORD_LOOKUP_FIELDS)[number]

/**
 * THE ONE PRODUCER OF A LOOKUP INSTRUCTION (round 11, Codex MEDIUM).
 *
 * THE DEFECT IT REPLACES. Round 10 made a wording DECLARE the record values it names, and checked
 * the declaration against what the two builders write. That check reads `{placeholder}`s and trusts
 * each entry's `needs` array — so a remedy that adds "search by gross total and posting day" in
 * ORDINARY PROSE introduces no placeholder, leaves `needs` truthful, compiles, and passes. `needs`
 * was an author convention, not an enforced declaration, and the exact bypass round 10 claimed to
 * eliminate survived it. Round 9's version was bypassable a different way, and round 8's a third.
 *
 * SO THE LOOKUP CLAUSE IS NOT PROSE ANY MORE. An entry declares `lookup: RecordLookupField[]`, and
 * the sentence that tells an operator what to search by is GENERATED here from that declaration
 * against the values this incident actually carries. A field that is not a `RecordLookupField` does
 * not compile; a field the builders do not both write fails the declaration test; a field whose
 * value is absent on THIS incident throws while rendering, and the test that generates every message
 * for every combination is what turns that into a red build.
 *
 * WHAT IS RESERVED. The renderer owns the WHOLE lookup clause — the verb, the ledger and the
 * criterion — so a template cannot supply half of one. The fence in
 * tests/accounting/record-names-only-what-it-holds.test.ts then refuses any template containing a
 * LOOKUP VERB at all, which leaves `{lookup}` as the only way a remedy can tell an operator to go
 * and find something. What prose MAY still do is name a value THIS MESSAGE HAS ALREADY PRINTED —
 * "open both ids", "the reference above" — because that is text the reader already has in front of
 * them, not data they must go and search on.
 *
 * WHAT THIS PROVABLY DOES NOT COVER, said plainly rather than implied: see the fence's own comment
 * in that test file, which is the honest half of this answer. English has no closed set of ways to
 * name a datum, and these remedies are hand-written operator prose that could not survive being
 * generated from a grammar without losing everything ten rounds of review put into them.
 */
const LOOKUP_FIELD_PHRASE: Readonly<Record<RecordLookupField, string>> = Object.freeze({
  syncLogId: 'the sync row id above',
  type: 'the operation type above',
  referenceType: 'the kind of IMS record named above',
  referenceId: 'the IMS reference above',
  postedExternalId: 'the id above',
})

/**
 * The slots a wording template may substitute: the ledger's name, the record fields, and — for
 * `{lookup}` — the DECLARATION rather than a finished sentence. The clause is built only if a
 * template actually reaches for it, because a wording that declares a lookup may also have branches
 * that do not use one (the same entry answers both "the id is in hand" and "no id came back").
 */
type WordingSlots = {
  ledger: 'Xero' | 'QuickBooks'
  lookup?: readonly RecordLookupField[]
  /** What the generated clause calls the thing being looked for — the entry's own `noun`. */
  lookupNoun?: string
} & Partial<Record<RecordLookupField, string | null>>

/**
 * Build the lookup clause for one incident, or throw if this incident cannot support it.
 *
 * The values come from the incident's own slots, so a remedy selected in a state where its lookup
 * field is null cannot render at all — it does not degrade into "look it up by null".
 */
function lookupInstruction(fields: readonly RecordLookupField[], slots: WordingSlots): string {
  if (fields.length === 0) {
    throw new Error('a lookup instruction with no declared field is not an instruction')
  }
  const phrases = fields.map((field) => {
    const value = slots[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`incident wording sends an operator to look up by "${field}", which this record does not carry`)
    }
    return LOOKUP_FIELD_PHRASE[field]
  })
  return `find ${slots.lookupNoun ?? 'it'} in ${slots.ledger} by ${phrases.join(' and ')}`
}

/**
 * Substitute `{ledger}`, `{LEDGER}`, `{lookup}` and any {@link RecordLookupField} the caller supplies.
 *
 * THROWS on an unknown placeholder and on a declared one whose value is absent. Both are programming
 * errors in a constant table, and the test that renders every message for every combination is what
 * turns them into a red build rather than a record that tells an operator to open "null".
 */
function render(template: string, slots: WordingSlots): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_whole, slot: string) => {
    if (slot === 'ledger') return slots.ledger
    if (slot === 'LEDGER') return slots.ledger.toUpperCase()
    if (slot === 'lookup' || slot === 'Lookup') {
      if (!slots.lookup) {
        throw new Error('incident wording named "{lookup}" without declaring a lookup field for it')
      }
      const clause = lookupInstruction(slots.lookup, slots)
      return slot === 'Lookup' ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause
    }
    if (!(RECORD_LOOKUP_FIELDS as readonly string[]).includes(slot)) {
      throw new Error(`incident wording named "${slot}", which is not a field this record holds`)
    }
    const value = slots[slot as RecordLookupField]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`incident wording named "${slot}", which this record does not carry`)
    }
    return value
  })
}


/** The one escalation instruction, so the seven places that end in it cannot each word it slightly differently. */
const ESCALATE_REMEDY = 'REMEDY: escalate this record to whoever administers this installation'

/**
 * WHAT THE RECORD HOLDS, SAID ONCE. Every message ends in it, so no remedy has to imply the record
 * carries more than this, and an escalation names what the person it escalates to will be given.
 */
export const INCIDENT_IDENTIFICATION_TAIL =
  'WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the '
  + 'time this record was written — the write it describes was made in the same sync attempt. That '
  + 'is all of it.'

/**
 * THE ANSWER WHEN THE OUTCOME WAS NOT RECORDED, and it is deliberately the same in all three frames.
 * A record that cannot say whether a balance moved has one honest instruction, and every variation
 * on it would be a hint about which way to guess.
 */
const OUTCOME_UNRECORDED_REMEDY: string =
  'REMEDY: THIS RECORD DOES NOT SAY WHETHER THAT WAS A LIVE POSTING OR A DRAFT. This operation '
  + 'creates a live ledger document on one posting-mode setting and an UNPOSTED DRAFT on the other, '
  + 'and IMS did not record which was used for this attempt — so it cannot say whether any balance '
  + 'moved. DO NOT void, credit-note, reverse or delete anything on the strength of this record: the '
  + 'remedy for a live posting is the one that does the most damage to a draft, and the other way '
  + 'round. Escalate this record to whoever administers this installation'

/**
 * THE SAME ANSWER FOR AN UPDATE, WHICH KNOWS ONE MORE THING (round 11, Codex MEDIUM).
 *
 * The posting state is unknown, so nothing may be acted on — but "this attempt created nothing" is
 * known from the operation itself and does not depend on the mode. Losing that sentence is how a
 * reader of an update incident ends up looking for a duplicate that cannot exist.
 */
const UPDATE_OUTCOME_UNRECORDED_REMEDY: string =
  'REMEDY: NO DOCUMENT WAS CREATED — this operation changed one that already existed, so there is no '
  + 'duplicate of it in existence and nothing this attempt brought into being. WHAT THIS RECORD '
  + 'DOES NOT '
  + 'SAY is whether the document it changed is LIVE or an UNPOSTED DRAFT: the update is sent with a '
  + 'status resolved from the same posting-mode setting the create uses, and IMS did not record '
  + 'which was in force for this attempt. So it cannot say whether any balance moved. DO NOT void, '
  + 'credit-note, reverse or delete anything on the strength of this record. Escalate this record to '
  + 'whoever administers this installation'

/**
 * THE DOCUMENT REMEDY, PER OPERATION SEMANTIC AND PER POSTING MODE (round 10, Codex HIGH).
 *
 * ONE TABLE FOR BOTH CONNECTORS AND BOTH FRAMES. The Xero formatter reaches a document incident by
 * two doors (the row is gone; the row names another id) and the QuickBooks one by a third (the id
 * could not be written at all), and until now each door wrote its own remedy. Three authors of one
 * instruction is how "keep it or void it" came to be said about an UPDATE, and about a DRAFT, on
 * every one of them at once. The frames now contribute only the sentence about the ROW; every word
 * about the DOCUMENT comes from here.
 *
 * WHY THE KEY IS NOT THE OPERATION TYPE. It is the semantic AND the posting mode, because those are
 * the two things that decide what an operator must do:
 *
 *   CREATE_LIVE        a new document is in the ledger        → keep it or void it
 *   CREATE_DRAFT       a document exists, UNPOSTED            → DELETE it; a reversal would post
 *   JOURNAL_LIVE       a manual journal is in the ledger      → reverse it (journals do not void)
 *   JOURNAL_DRAFT      a journal exists, UNPOSTED             → DELETE it; a reversal would post
 *   UPDATE_LIVE        a live document that was already there was changed → inspect and correct it
 *   UPDATE_DRAFT       an UNPOSTED document was changed       → correct it; do NOT delete it either
 *   UPDATE_UNRECORDED  a document was changed, posted or not  → correct nothing, escalate
 *   PAYMENT            a payment was applied to a document nobody created here → remove the PAYMENT
 *   OUTCOME_UNRECORDED live or draft, and this record does not say → touch nothing, escalate
 *
 * ROUND 11 (Codex MEDIUM): THE UPDATE ROW IS NOW THREE ROWS, because the posting state is asked of
 * an update like it is asked of anything else. Round 10 had ONE update wording and reached it
 * without consulting the mode, so a draft update was described as a live document and counted as
 * real money. Note that UPDATE_DRAFT is the one draft wording that must NOT say "delete it": the
 * draft it changed stood there before this attempt ran, and deleting it destroys somebody's work.
 */
type DocumentWordingKey =
  | 'CREATE_LIVE' | 'CREATE_DRAFT' | 'JOURNAL_LIVE' | 'JOURNAL_DRAFT'
  | 'UPDATE_LIVE' | 'UPDATE_DRAFT' | 'UPDATE_UNRECORDED'
  | 'PAYMENT' | 'OUTCOME_UNRECORDED'

export type DocumentIncidentWording = {
  /** Completes "Xero SALES_INVOICE for SalesOrder order-1 …, but …". */
  didWithId: string
  didWithoutId: string
  /** What the rest of the sentence calls the thing, e.g. "the document". */
  noun: string
  /** What the row names a DIFFERENT one OF, e.g. "document". */
  conflictNoun: string
  /** The sentence about both of them existing, for the conflict frame. */
  bothExist: string
  /** What still stands when this record carries no id at all. */
  absent: string
  /** Xero, the row is gone, and the id is in hand. */
  remedyRowGone: string
  /** Xero, the row names another document, and both ids are in hand. */
  remedyDuplicate: string
  /** QuickBooks, the id is in hand and the row never learned it. */
  remedyIdUnrecorded: string
  /** Every record field the templates above name. Checked against the builders by the test. */
  needs: readonly RecordLookupField[]
  /**
   * What `{lookup}` searches by — the ONLY route by which a remedy may introduce a search criterion
   * (round 11, Codex MEDIUM). Omitted where no template reaches for one.
   */
  lookup?: readonly RecordLookupField[]
}

export const DOCUMENT_INCIDENT_WORDING: Readonly<Record<DocumentWordingKey, DocumentIncidentWording>> = Object.freeze({
  CREATE_LIVE: {
    didWithId: 'POSTED as {postedExternalId}',
    didWithoutId: 'POSTED as (no id returned)',
    noun: 'the document',
    conflictNoun: 'document',
    bothExist: 'BOTH documents exist in {ledger}.',
    absent: 'The document is in {ledger} all the same.',
    remedyRowGone: 'REMEDY: {lookup} and either keep it (re-enter the '
      + 'reference manually) or void it; ',
    remedyDuplicate: 'REMEDY: open both ids in {ledger}, keep the one the row names, and void or '
      + 'credit the duplicate; ',
    remedyIdUnrecorded: 'REMEDY: open the id above in {ledger}, confirm exactly one document exists '
      + 'for this reference, and void any duplicate.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  CREATE_DRAFT: {
    didWithId: 'created a DRAFT document in {ledger} as {postedExternalId} — nothing was posted to the ledger',
    didWithoutId: 'created a DRAFT document in {ledger} (no id returned) — nothing was posted to the ledger',
    noun: 'the draft',
    conflictNoun: 'draft',
    bothExist: 'BOTH drafts exist in {ledger}, and neither has moved a balance.',
    absent: 'The draft is in {ledger} all the same, and it moved no balances.',
    remedyRowGone: 'REMEDY: THE DRAFT MOVED NO BALANCES — it was created unposted, so nothing has '
      + 'reached the ledger. {Lookup} and DELETE it if it should not '
      + 'exist. DO NOT void it, credit-note it or reverse it: a reversal POSTS FOR REAL, so it would '
      + 'move the accounts by exactly the amount this draft never moved, and leave the draft sitting '
      + 'there as well; ',
    remedyDuplicate: 'REMEDY: NEITHER DRAFT HAS MOVED A BALANCE. Open both ids in {ledger}, keep the '
      + 'one the row names, and DELETE the duplicate. DO NOT void, credit-note or reverse either: a '
      + 'reversal POSTS FOR REAL, and would move accounts these drafts never moved; ',
    remedyIdUnrecorded: 'REMEDY: THE DRAFT MOVED NO BALANCES — it was created unposted. Open the id '
      + 'above in {ledger}, confirm exactly one draft exists for this reference, and DELETE any '
      + 'duplicate. DO NOT void, credit-note or reverse one: a reversal POSTS FOR REAL.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  JOURNAL_LIVE: {
    didWithId: 'POSTED a manual journal to the {ledger} ledger as {postedExternalId}',
    didWithoutId: 'POSTED a manual journal to the {ledger} ledger (no id returned)',
    noun: 'the journal',
    conflictNoun: 'journal',
    bothExist: 'BOTH journals are in the {ledger} ledger.',
    absent: 'The journal is in the {ledger} ledger all the same.',
    remedyRowGone: 'REMEDY: {lookup} and either keep it '
      + '(re-enter the reference manually) or POST A REVERSING JOURNAL against it — a manual journal '
      + 'is not voided or credit-noted; ',
    remedyDuplicate: 'REMEDY: open both ids in {ledger}, keep the one the row names, and REVERSE the '
      + 'duplicate with a reversing journal — a manual journal is not voided or credit-noted; ',
    remedyIdUnrecorded: 'REMEDY: open the id above in {ledger}, confirm exactly one journal exists '
      + 'for this reference, and REVERSE any duplicate with a reversing journal. A manual journal is '
      + 'not voided or credit-noted.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  JOURNAL_DRAFT: {
    didWithId: 'created a DRAFT manual journal in {ledger} as {postedExternalId} — nothing was posted to the ledger',
    didWithoutId: 'created a DRAFT manual journal in {ledger} (no id returned) — nothing was posted to the ledger',
    noun: 'the draft journal',
    conflictNoun: 'draft journal',
    bothExist: 'BOTH draft journals exist in {ledger}, and neither has moved a balance.',
    absent: 'The draft journal is in {ledger} all the same, and it moved no balances.',
    remedyRowGone: 'REMEDY: THE DRAFT MOVED NO BALANCES — it was created unposted, so no account has '
      + 'been touched. {Lookup} and DELETE it if it should not exist. DO '
      + 'NOT post a reversing journal: the reversal POSTS FOR REAL, so it would move the accounts by '
      + 'exactly the amount this draft never moved, and leave the draft sitting there as well; ',
    remedyDuplicate: 'REMEDY: NEITHER DRAFT HAS MOVED A BALANCE. Open both ids in {ledger}, keep the '
      + 'one the row names, and DELETE the duplicate. DO NOT post a reversing journal for either: a '
      + 'reversal POSTS FOR REAL; ',
    remedyIdUnrecorded: 'REMEDY: THE DRAFT MOVED NO BALANCES — it was created unposted. Open the id '
      + 'above in {ledger}, confirm exactly one draft journal exists for this reference, and DELETE '
      + 'any duplicate. DO NOT post a reversing journal: a reversal POSTS FOR REAL.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  UPDATE_LIVE: {
    didWithId: 'MODIFIED the existing {ledger} document {postedExternalId}',
    didWithoutId: 'MODIFIED an existing {ledger} document (no id returned)',
    noun: 'the document it changed',
    conflictNoun: 'document',
    bothExist: 'BOTH documents exist in {ledger}, and NEITHER was created by this attempt — it '
      + 'changed the one it names.',
    absent: 'The document it changed is in {ledger} all the same, and it stood there before this '
      + 'attempt ran.',
    remedyRowGone: 'REMEDY: NO DOCUMENT WAS CREATED — this operation changed one that already '
      + 'existed, so there is no duplicate here and nothing that this attempt brought into being. DO '
      + 'NOT VOID OR CREDIT-NOTE IT: doing so would void a document that was valid before this '
      + 'attempt ran. {Lookup}, compare it against the reference above in '
      + 'IMS, and correct it in {ledger} if the change should not stand; ',
    remedyDuplicate: 'REMEDY: NO DOCUMENT WAS CREATED BY THIS ATTEMPT — it changed one that already '
      + 'existed, and the row names a different one. DO NOT VOID OR CREDIT-NOTE EITHER. Open both '
      + 'ids in {ledger}, compare each against the reference above in IMS, and correct whichever is '
      + 'wrong; ',
    remedyIdUnrecorded: 'REMEDY: NO DOCUMENT WAS CREATED — this operation changed one that already '
      + 'existed. DO NOT VOID OR CREDIT-NOTE IT, and no duplicate of it exists to open. Open the id '
      + 'above in {ledger}, compare it against the reference above in IMS, and correct it there if '
      + 'the change should not stand.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  // ROUND 11 (Codex MEDIUM): AN UPDATE SENT ON `draft` CHANGED A DOCUMENT THAT IS UNPOSTED. Two
  // facts hold at once and each one forbids a different remedy: nothing was CREATED, so voiding or
  // credit-noting destroys a document that was valid before the attempt ran; and nothing has
  // POSTED, so a reversal would move balances this draft never moved. Deletion is forbidden too,
  // which is what makes this different from CREATE_DRAFT — the draft existed first.
  UPDATE_DRAFT: {
    didWithId: 'MODIFIED the existing {ledger} DRAFT document {postedExternalId} — it is still '
      + 'unposted, and no balance moved',
    didWithoutId: 'MODIFIED an existing {ledger} DRAFT document (no id returned) — it is still '
      + 'unposted, and no balance moved',
    noun: 'the draft it changed',
    conflictNoun: 'draft document',
    bothExist: 'BOTH drafts exist in {ledger}, NEITHER was created by this attempt, and neither has '
      + 'moved a balance.',
    absent: 'The draft it changed is in {ledger} all the same, it stood there before this attempt '
      + 'ran, and it moved no balances.',
    remedyRowGone: 'REMEDY: NOTHING WAS CREATED AND NOTHING WAS POSTED. This operation changed a '
      + 'document that already existed, and it was sent unposted, so no balance moved. DO NOT VOID '
      + 'OR CREDIT-NOTE IT — that would act on a document that was valid before this attempt ran. DO '
      + 'NOT REVERSE IT — a reversal POSTS FOR REAL and would move accounts this draft never moved. '
      + 'AND DO NOT DELETE IT — the draft was there before this attempt and deleting it destroys '
      + 'work this attempt did not do. {Lookup}, compare it against the '
      + 'reference above in IMS, and correct the draft in place if the change should not stand; ',
    remedyDuplicate: 'REMEDY: NOTHING WAS CREATED, NOTHING WAS POSTED, and the row names a different '
      + 'draft. DO NOT VOID, CREDIT-NOTE, REVERSE OR DELETE EITHER: neither was created by this '
      + 'attempt and neither has moved a balance. Open both ids in {ledger}, compare each against '
      + 'the reference above in IMS, and correct whichever draft is wrong in place; ',
    remedyIdUnrecorded: 'REMEDY: NOTHING WAS CREATED AND NOTHING WAS POSTED — this operation changed '
      + 'a document that already existed, unposted. DO NOT VOID, CREDIT-NOTE, REVERSE OR DELETE IT, '
      + 'and no duplicate of it exists to open. Open the id above in {ledger}, compare it against '
      + 'the reference above in IMS, and correct the draft in place if the change should not stand.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  // The update whose posting mode was not recorded. The UPDATE facts still hold in full — this
  // attempt created nothing — so the update-specific refusals are kept. What is unknown is only
  // whether the document it changed is live or a draft, and that decides nothing an operator may
  // safely do here, so it is told to change nothing.
  UPDATE_UNRECORDED: {
    didWithId: 'MODIFIED the existing {ledger} document {postedExternalId}',
    didWithoutId: 'MODIFIED an existing {ledger} document (no id returned)',
    noun: 'the document it changed',
    conflictNoun: 'document',
    bothExist: 'BOTH documents exist in {ledger}, and NEITHER was created by this attempt — it '
      + 'changed the one it names.',
    absent: 'The document it changed is in {ledger} all the same, and it stood there before this '
      + 'attempt ran.',
    remedyRowGone: UPDATE_OUTCOME_UNRECORDED_REMEDY + '; ',
    remedyDuplicate: UPDATE_OUTCOME_UNRECORDED_REMEDY + '; ',
    remedyIdUnrecorded: UPDATE_OUTCOME_UNRECORDED_REMEDY + '.',
    needs: ['postedExternalId'],
  },
  PAYMENT: {
    didWithId: 'APPLIED a payment in {ledger}, recorded as {postedExternalId}',
    didWithoutId: 'APPLIED a payment in {ledger} (no id returned)',
    noun: 'the payment',
    conflictNoun: 'payment',
    bothExist: 'BOTH payments are in {ledger}.',
    absent: 'The payment is in {ledger} all the same.',
    remedyRowGone: 'REMEDY: A PAYMENT WAS APPLIED TO A DOCUMENT THAT ALREADY EXISTED — no invoice, '
      + 'bill or credit note was created here. {Lookup} and '
      + 'either keep it (re-enter the reference manually) or REMOVE OR REVERSE THAT PAYMENT. DO NOT '
      + 'void or credit-note the document it was applied to; ',
    remedyDuplicate: 'REMEDY: open both payment ids in {ledger}, keep the one the row names, and '
      + 'remove or reverse the duplicate PAYMENT. DO NOT void or credit-note the invoice or bill '
      + 'either payment was applied to — neither of them was created here; ',
    remedyIdUnrecorded: 'REMEDY: open the id above in {ledger}, confirm exactly one payment exists '
      + 'for this reference, and remove or reverse any duplicate PAYMENT. DO NOT void or credit-note '
      + 'the document it was applied to — that document was not created here.',
    needs: ['postedExternalId'],
    lookup: ['postedExternalId'],
  },
  OUTCOME_UNRECORDED: {
    didWithId: 'reached {ledger} as {postedExternalId}',
    didWithoutId: 'reached {ledger} (no id returned)',
    noun: 'what it created',
    conflictNoun: 'external id',
    bothExist: 'BOTH ids were accepted by {ledger}.',
    absent: 'Something was created in {ledger} all the same.',
    remedyRowGone: OUTCOME_UNRECORDED_REMEDY + '; ',
    remedyDuplicate: OUTCOME_UNRECORDED_REMEDY + '; ',
    remedyIdUnrecorded: OUTCOME_UNRECORDED_REMEDY + '.',
    needs: ['postedExternalId'],
  },
})


/**
 * THE POSTING STATE OF THE ATTEMPT, AS A VALUE (round 11, Codex MEDIUM).
 *
 * Derived from the kind rather than from the operation, because that is the whole correction: what
 * the operation MEANT and where its write ENDED UP are two questions, and round 10 answered the
 * second one out of the first for updates.
 */
type PostingState = 'LIVE' | 'DRAFT' | 'UNRECORDED'
function postingStateOf(kind: UnrecordedIncidentKind): PostingState {
  if (kind === 'LEDGER_DRAFT') return 'DRAFT'
  if (kind === 'LEDGER_OUTCOME_UNRECORDED') return 'UNRECORDED'
  return 'LIVE'
}

/** The four document semantics — the ones `isDocumentKind` can be reached with. */
type DocumentSemantic = 'CREATE_DOCUMENT' | 'UPDATE_DOCUMENT' | 'APPLY_PAYMENT' | 'POST_JOURNAL'

/**
 * THE TWO AXES, AS A TABLE RATHER THAN A LADDER OF `if`s (round 11, Codex MEDIUM).
 *
 * Round 10's selector asked the semantic first and the posting state second, and the UPDATE arm
 * returned before the state was ever consulted — which is precisely how a draft update came to be
 * described as a live document and counted as real money. A table cannot do that: every semantic
 * has a cell for every state, and the compiler fails the build if one is missing.
 *
 * APPLY_PAYMENT's three cells are the same wording ON PURPOSE, and it is not a shrug. A payment is
 * not in {@link DRAFT_CAPABLE_SEMANTICS} — no status is resolved for it and Xero Payments have no
 * draft form — so `incidentKindForOperation` cannot produce DRAFT or UNRECORDED for one. The cells
 * exist so that the day a payment DOES acquire a draft form, the change is made here where it is
 * visible, rather than by an arm that silently never looked.
 */
const DOCUMENT_WORDING_BY_SEMANTIC: Readonly<Record<
  DocumentSemantic,
  Readonly<Record<PostingState, DocumentIncidentWording>>
>> = Object.freeze({
  CREATE_DOCUMENT: {
    LIVE: DOCUMENT_INCIDENT_WORDING.CREATE_LIVE,
    DRAFT: DOCUMENT_INCIDENT_WORDING.CREATE_DRAFT,
    UNRECORDED: DOCUMENT_INCIDENT_WORDING.OUTCOME_UNRECORDED,
  },
  POST_JOURNAL: {
    LIVE: DOCUMENT_INCIDENT_WORDING.JOURNAL_LIVE,
    DRAFT: DOCUMENT_INCIDENT_WORDING.JOURNAL_DRAFT,
    UNRECORDED: DOCUMENT_INCIDENT_WORDING.OUTCOME_UNRECORDED,
  },
  UPDATE_DOCUMENT: {
    LIVE: DOCUMENT_INCIDENT_WORDING.UPDATE_LIVE,
    DRAFT: DOCUMENT_INCIDENT_WORDING.UPDATE_DRAFT,
    UNRECORDED: DOCUMENT_INCIDENT_WORDING.UPDATE_UNRECORDED,
  },
  APPLY_PAYMENT: {
    LIVE: DOCUMENT_INCIDENT_WORDING.PAYMENT,
    DRAFT: DOCUMENT_INCIDENT_WORDING.PAYMENT,
    UNRECORDED: DOCUMENT_INCIDENT_WORDING.PAYMENT,
  },
})

/** Which wording a document incident earns — one cell of {@link DOCUMENT_WORDING_BY_SEMANTIC}. */
function documentIncidentWording(type: string, kind: UnrecordedIncidentKind): DocumentIncidentWording {
  const semantic = operationSemanticFor(type)
  const row = semantic && semantic in DOCUMENT_WORDING_BY_SEMANTIC
    ? DOCUMENT_WORDING_BY_SEMANTIC[semantic as DocumentSemantic]
    : DOCUMENT_WORDING_BY_SEMANTIC.CREATE_DOCUMENT
  return row[postingStateOf(kind)]
}

/**
 * THE REMEDY FOR A WRITE THAT IS NOT A DOCUMENT, PER OPERATION (round 9, Codex HIGH).
 *
 * Keyed on `NonDocumentOperationType`, so the compiler refuses the day the map above calls a new
 * type non-document and nobody writes it a remedy — the same mechanism, one level down, that stops
 * an operation type going unclassified. `{ledger}` is substituted at render time because these
 * operations are identical on both connectors and the incident is not.
 *
 * `stands` IS PER ENTRY RATHER THAN PER KIND (round 10, Codex MEDIUM). It used to be one of two
 * sentences chosen by the kind, and one of them — "NOTHING WAS CREATED IN XERO AT ALL" — is not
 * true of every operation it covered. `BILL_ATTACHMENT` with uploads enabled CREATES AN ATTACHMENT
 * ON THE REMOTE BILL; with them disabled it makes no request at all. One sentence could not be true
 * of both, so the sentence moved to where the difference is known.
 */
export type NonDocumentIncidentWording = {
  /** What now stands (or does not) in the ledger. */
  stands: string
  /** Completes "WHAT THE OPERATION DID: …". */
  did: string
  remedy: string
  needs: readonly RecordLookupField[]
  /** As {@link DocumentIncidentWording.lookup}: the only route to a search criterion. */
  lookup?: readonly RecordLookupField[]
}

const NOT_A_DOCUMENT_STANDS =
  'THIS IS NOT A DOCUMENT. {ledger} accepted the write and no reset of ours undoes it, but nothing '
  + 'stands at an id, so there is nothing here to open, keep or void as one. '
const NOTHING_CREATED_STANDS =
  'NOTHING WAS CREATED IN {LEDGER} AT ALL, so there is no document there to open. '

export const NON_DOCUMENT_INCIDENT_WORDING: Readonly<Record<
  NonDocumentOperationType,
  NonDocumentIncidentWording | Readonly<Record<RemoteEffectKnowledge, NonDocumentIncidentWording>>
>> = Object.freeze({
    PURCHASE_CREDIT_NOTE_ALLOCATION: {
      stands: NOT_A_DOCUMENT_STANDS,
      did: 'it APPLIED an already-posted supplier credit note to an already-posted bill. An allocation '
        + 'is a sub-resource of the credit note, not a standalone document, and {ledger} returns no id '
        + 'for one',
      remedy: 'REMEDY: DO NOT OPEN, KEEP OR VOID EITHER THE BILL OR THE CREDIT NOTE ON THE STRENGTH OF '
        + 'THIS RECORD. Both of them existed before this operation and neither was created by it; what '
        + 'happened is that one was applied to the other, and the only thing that undoes it is removing '
        + 'that allocation from the credit note in {ledger}. Escalate this record to whoever '
        + 'administers this installation.',
      needs: [],
    },
    TAX_RATE_SYNC: {
      stands: NOT_A_DOCUMENT_STANDS,
      did: 'it wrote a TAX RATE into the {ledger} organisation. A tax rate is a setting on the '
        + 'organisation rather than a document, and the value the write returns is a tax TYPE code',
      remedy: 'REMEDY: THERE IS NOTHING TO VOID OR CREDIT — nothing was posted to a customer or a '
        + 'supplier account. Review the tax rates in {ledger}, and correct or archive that rate there '
        + 'if this write was wrong.',
      needs: [],
    },
    // ROUND 10 (Codex MEDIUM): THE ONE OPERATION WHOSE OWN OUTCOME DECIDES THE SENTENCE. The handler
    // returns success WITHOUT uploading when its connector's attach-PDF setting is 'false', so the
    // round-9 wording — "it uploaded a supplier-invoice PDF", under a headline reading "NOTHING WAS
    // CREATED AT ALL" — was two claims that could not both hold, and on a disabled install BOTH were
    // false. It could send an operator to remove a duplicate attachment this attempt never created.
    BILL_ATTACHMENT: {
      MADE: {
        stands: 'AN ATTACHMENT NOW EXISTS ON THAT BILL IN {LEDGER}, and no standalone accounting '
          + 'document was created. ',
        did: 'it uploaded a supplier-invoice PDF onto a bill that already existed in {ledger}. THE '
          + 'UPLOAD HAPPENED. No id came back because an attachment is not a document',
        remedy: 'REMEDY: open that bill in {ledger} and remove the duplicate attachment. There is no '
          + 'document to void, and the bill itself was not created by this attempt.',
        needs: [],
      },
      NONE: {
        stands: 'NOTHING LEFT THIS PROCESS AND NOTHING IN {LEDGER} CHANGED. ',
        did: 'it did nothing at all. Attachment upload is turned off for this connector, so the '
          + 'handler returned success without contacting {ledger} and without uploading anything',
        remedy: 'REMEDY: THERE IS NOTHING TO UNDO. No attachment was created, no document was '
          + 'created, and nothing in {ledger} was touched by this attempt.',
        needs: [],
      },
      UNRECORDED: {
        stands: 'IMS DID NOT RECORD WHETHER THE UPLOAD HAPPENED. ',
        did: 'it either uploaded a supplier-invoice PDF onto a bill that already existed in {ledger} '
          + 'or did nothing at all — the handler skips the upload and STILL RETURNS SUCCESS when '
          + 'attachment upload is turned off for this connector, and this record does not say which '
          + 'of the two this attempt was',
        remedy: 'REMEDY: DO NOT REMOVE AN ATTACHMENT ON THE STRENGTH OF THIS RECORD — this attempt '
          + 'may never have created one. Open that bill in {ledger}, compare what is attached against '
          + 'what should be there, and escalate this record to whoever administers this installation.',
        needs: [],
      },
    },
    INVOICE_PDF: {
      stands: NOTHING_CREATED_STANDS,
      did: 'it re-downloaded the invoice PDF and wrote it over the copy IMS had stored, so the effect '
        + 'landed inside IMS',
      remedy: 'REMEDY: confirm the invoice PDF stored against the order is the document you expect. '
        + 'There is nothing to void in {ledger}.',
      needs: [],
    },
    INVOICE_EMAIL: {
      stands: NOTHING_CREATED_STANDS,
      did: 'it QUEUED an invoice email to the customer — one PENDING row in the local email outbox. It '
        + 'succeeds by QUEUEING, not by sending',
      remedy: 'REMEDY: IMS CANNOT CANCEL A QUEUED COPY — EmailOutbox has four states (PENDING, '
        + 'PROCESSING, SENT, FAILED), none of which means "deliberately not delivered", and no action, '
        + 'route or screen removes an unsent row. Inspect the outbox rows for this order and read each '
        + 'row\'s status, attempts, lastError and sentAt. A FAILED ROW IS NOT PROOF THAT NOTHING WENT, '
        + 'whatever its lastError says: IMS keeps no per-attempt outcome, so a row\'s final error '
        + 'cannot be read backwards into its history (o3d-ch0h).',
      needs: [],
    },
    WC_INVOICE_NOTE: {
      stands: NOTHING_CREATED_STANDS,
      did: 'it wrote an invoice note onto the WooCommerce order',
      remedy: 'REMEDY: open that order in WooCommerce and remove any duplicate note. There is nothing '
        + 'to void in {ledger}.',
      needs: [],
    },
  })

/** The wording for one non-document operation, after its own outcome has been asked for. */
function nonDocumentWordingFor(
  type: string,
  outcome: PostedOperationOutcome | undefined,
): NonDocumentIncidentWording | undefined {
  const entry = (NON_DOCUMENT_INCIDENT_WORDING as Partial<Record<string, NonDocumentIncidentWording
    | Readonly<Record<RemoteEffectKnowledge, NonDocumentIncidentWording>>>>)[type]
  if (!entry) return undefined
  return 'did' in entry ? entry : entry[remoteEffectKnowledge(outcome)]
}

/**
 * WHAT THE FRAME MAY CLAIM ABOUT THE EFFECT (round 11, Codex HIGH).
 *
 * THE DEFECT. The shared head opened every non-document incident with "SUCCEEDED — the external
 * effect has happened — but IMS could not record that it did", and round 10 then wrote
 * `BILL_ATTACHMENT`'s no-op its own BODY while leaving it inside that head. The message therefore
 * asserted an external effect in its first clause and denied one three sentences later, for an
 * attempt that made no request at all.
 *
 * THE CLAIM IS NOW READ OFF THE SAME FACT THE BODY IS. An operation with no no-op form — a PDF
 * write, an email queue, a WooCommerce note — always did its thing, and its head says so whatever
 * the record carries. An operation that CAN return success without acting says only what this
 * attempt's recorded outcome supports, and says "we do not know" when it carries none.
 */
type EffectClaim = 'MADE' | 'NONE' | 'UNKNOWN'
function nonDocumentEffectClaim(type: string, outcome: PostedOperationOutcome | undefined): EffectClaim {
  const entry = (NON_DOCUMENT_INCIDENT_WORDING as Partial<Record<string, NonDocumentIncidentWording
    | Readonly<Record<RemoteEffectKnowledge, NonDocumentIncidentWording>>>>)[type]
  // No entry at all, or one wording for the whole operation: the handler has no success path that
  // skips the work, so the effect happened.
  if (!entry || 'did' in entry) return 'MADE'
  const knowledge = remoteEffectKnowledge(outcome)
  return knowledge === 'UNRECORDED' ? 'UNKNOWN' : knowledge
}

/** The opening sentence, per {@link nonDocumentEffectClaim}. */
function nonDocumentHead(
  ledger: 'Xero' | 'QuickBooks',
  entry: { type: AccountingSyncType; referenceType: string; referenceId: string },
  claim: EffectClaim,
): string {
  const subject = `${ledger} ${entry.type} for ${entry.referenceType} ${entry.referenceId} `
  if (claim === 'NONE') {
    return subject + 'SUCCEEDED WITHOUT MAKING ANY EXTERNAL EFFECT — nothing left this process and '
      + `nothing in ${ledger} changed — and IMS could not record that it ran. `
  }
  if (claim === 'UNKNOWN') {
    return subject + 'SUCCEEDED, but IMS RECORDED NEITHER WHAT IT DID NOR THAT IT RAN — this '
      + 'operation has a success path that acts and a success path that does nothing, and this '
      + 'record does not say which one this attempt took. '
  }
  return subject + 'SUCCEEDED — the external effect has happened — but IMS could not record that it '
    + 'did. '
}

/**
 * THE WHOLE MESSAGE FOR AN INCIDENT WHOSE OPERATION IS NOT A DOCUMENT POST (round 9, Codex HIGH).
 *
 * Shared by both connectors' formatters, because the reason a formatter may not emit "find it, keep
 * it or void it" is a property of the OPERATION and both formatters were emitting it. The row-state
 * sentence is the one part that differs, so it is passed in.
 */
function describeNonDocumentIncident(params: {
  ledger: 'Xero' | 'QuickBooks'
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  kind: UnrecordedIncidentKind
  postedExternalId: string | null
  outcome: PostedOperationOutcome | undefined
  rowState: string
}): string {
  const { ledger, entry, kind, postedExternalId, rowState } = params
  const wording = nonDocumentWordingFor(entry.type, params.outcome)
  const slots: WordingSlots = { ledger, postedExternalId, lookup: wording?.lookup }
  const head = nonDocumentHead(ledger, entry, nonDocumentEffectClaim(entry.type, params.outcome))
  if (kind === 'UNCLASSIFIED' || !wording) {
    return head + rowState
      + 'THIS VERSION OF IMS DOES NOT CLASSIFY THAT OPERATION TYPE, so it cannot say what, if '
      + `anything, now stands in ${ledger}. REMEDY: DO NOT ASSUME A DOCUMENT. This record will not tell `
      + `you to open, keep or void one, because it cannot establish that there is one. ${ESCALATE_REMEDY}. `
      + INCIDENT_IDENTIFICATION_TAIL
  }
  return head
    + `WHAT THE OPERATION DID: ${render(wording.did, slots)}. `
    + rowState
    + render(wording.stands, slots)
    + (postedExternalId
      ? `The value recorded against this incident (${postedExternalId}) is not a document id. `
      : '')
    + `${render(wording.remedy, slots)} `
    + INCIDENT_IDENTIFICATION_TAIL
}

/**
 * THE ONE CLASSIFICATION, ASKED DIRECTLY (round 9, Codex HIGH).
 *
 * `classifyUnrecordedIncident` reads a stored `metadata` blob; the formatters hold the incident in
 * their hands and have no blob. Round 8 taught the blob reader that a document kind needs BOTH the
 * operation semantics and a recorded id, and left the formatters asking only about the id — so the
 * two disagreed about `PURCHASE_CREDIT_NOTE_ALLOCATION`, and the formatter was the one an operator
 * reads. There is now one implementation and two entry points into it.
 */
export function operationSemanticFor(type: string | null | undefined): PostedOperationSemantic | undefined {
  if (typeof type !== 'string' || type.length === 0) return undefined
  return (OPERATION_SEMANTIC_BY_TYPE as Record<string, PostedOperationSemantic | undefined>)[type]
}

export function incidentKindForOperation(
  type: string | null | undefined,
  postedExternalId: string | null | undefined,
  outcome?: PostedOperationOutcome,
): UnrecordedIncidentKind {
  const semantic = operationSemanticFor(type)
  if (!semantic) return 'UNCLASSIFIED'
  if (semantic === 'NO_LEDGER_EFFECT') return 'NO_IDENTIFIER_SIDE_EFFECT'
  if (semantic === 'LEDGER_NON_DOCUMENT') return 'LEDGER_NON_DOCUMENT'
  // ROUND 10 (Codex HIGH): THE POSTING MODE DECIDES WHETHER A BALANCE MOVED, AND ITS ABSENCE IS NOT
  // A LIVE POSTING.
  // ROUND 11 (Codex MEDIUM): AND IT IS ASKED OF THE UPDATE TOO. See DRAFT_CAPABLE_SEMANTICS: the
  // update handlers resolve their status from the same `_postingMode` the creates do, so an update
  // sent on `draft` left an UNPOSTED DRAFT behind and moved nothing. The posting state is a fact
  // about the ATTEMPT, asked independently of what the operation semantically did.
  if (DRAFT_CAPABLE_SEMANTICS.has(semantic)) {
    if (outcome?.postingMode === 'DRAFT') return 'LEDGER_DRAFT'
    if (outcome?.postingMode !== 'LIVE') return 'LEDGER_OUTCOME_UNRECORDED'
  }
  // THE OPERATION SAYS A DOCUMENT ID EXISTS; THE RECORD SAYS WHETHER ONE WAS WRITTEN DOWN.
  return nonEmpty(postedExternalId) ? 'LEDGER_DOCUMENT' : 'LEDGER_DOCUMENT_NO_IDENTIFIER'
}

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
 * ROUND 7 (Codex MEDIUM): AND THE LOOKUP HAS NO FALLBACK DIRECTION ANY MORE. It reads
 * {@link INCIDENT_KIND_BY_OPERATION_TYPE}, which classifies every member of the enum; anything not
 * in it — a type from a future schema, a truncated string, a row written by a newer binary — is
 * UNCLASSIFIED. That is the humble answer rather than the confident one, and it is the correction
 * this module has now had to make in both directions: round 6 stopped an unknown being called a
 * side effect, and round 7 stops it being called a document.
 *
 * Both record builders write `metadata.type` from `entry.type`
 * (xero/sync-processor.ts `unrecordedPostedDocumentRecord`, quickbooks/sync-processor.ts
 * `unpersistedQboPostRecord`), so the field this reads is written on every row either connector
 * produces. A row without it is UNCLASSIFIED rather than assumed.
 *
 * ROUND 8 (Codex MEDIUM): AND THE OPERATION IS ONLY HALF THE ANSWER. The map says what a SUCCESSFUL
 * handler for that type RETURNS; the record says what this incident actually GOT. Those come apart:
 * both payment handlers return `{ success: true, externalId: res.data?.Payment?.Id }` (and
 * `?.BillPayment?.Id`), a deeply-optional read with no presence check, and the caller passes
 * `syncResult.externalId ?? null` on, so a QuickBooks post can succeed with NO id and still be
 * recorded here. The Xero record has the same hole from the other side: `postedExternalId` is
 * nullable on `UnrecordablePostedDocument` and its wording already prints "(no id returned)".
 * Classifying such a row `LEDGER_DOCUMENT` earned it the breadcrumb sentence that ends "Open the id
 * in that system" — an instruction to open something the record does not contain. So the classifier
 * reads BOTH: the type decides the semantics, and `metadata.postedExternalId` decides whether the
 * document-with-an-id sentence or the document-without-an-id sentence is true of this row. Only
 * `LEDGER_DOCUMENT` is downgraded; the other kinds are the ones whose id is EXPECTED to be absent,
 * and their wording never promised one.
 */
export function classifyUnrecordedIncident(metadata: unknown): UnrecordedIncidentKind {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return 'UNCLASSIFIED'
  const type = (metadata as { type?: unknown }).type
  const postedExternalId = (metadata as { postedExternalId?: unknown }).postedExternalId
  // ROUND 9: the decision itself lives in `incidentKindForOperation`, which the two formatters call
  // too. This function is the part that is only about reading a stored blob.
  // ROUND 10: the two facts the TYPE cannot supply. A blob that carries neither is not a blob about
  // a live posting; it is a blob that does not say, and `incidentKindForOperation` treats it so.
  const postingMode = (metadata as { postingMode?: unknown }).postingMode
  const externalEffect = (metadata as { externalEffect?: unknown }).externalEffect
  return incidentKindForOperation(
    typeof type === 'string' ? type : null,
    typeof postedExternalId === 'string' ? postedExternalId : null,
    {
      postingMode: postingMode === 'LIVE' || postingMode === 'DRAFT' ? postingMode : undefined,
      externalEffect: externalEffect === 'MADE' || externalEffect === 'NONE' ? externalEffect : undefined,
    },
  )
}

/** One tally per kind, so a caller cannot report a total it has not broken down. */
export type UnrecordedIncidentCounts = Record<UnrecordedIncidentKind, number>

export function countUnrecordedIncidents(rows: readonly { metadata: unknown }[]): UnrecordedIncidentCounts {
  const counts: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0,
    LEDGER_DOCUMENT_NO_IDENTIFIER: 0,
    LEDGER_DRAFT: 0,
    LEDGER_OUTCOME_UNRECORDED: 0,
    LEDGER_NON_DOCUMENT: 0,
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
  const total = counts.LEDGER_DOCUMENT + counts.LEDGER_DOCUMENT_NO_IDENTIFIER + counts.LEDGER_DRAFT
    + counts.LEDGER_OUTCOME_UNRECORDED + counts.LEDGER_NON_DOCUMENT + counts.NO_IDENTIFIER_SIDE_EFFECT
    + counts.UNCLASSIFIED
  const parts: string[] = [
    `Database reset kept ${total} record(s) of things IMS did against an accounting connector and `
    + 'could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately.',
  ]
  if (counts.LEDGER_DOCUMENT > 0) {
    parts.push(
      `${counts.LEDGER_DOCUMENT} name a LIVE effect Xero or QuickBooks accepted and still holds — `
      + 'real money in somebody else\'s books, which no reset of ours undoes. THEY ARE NOT ALL NEW '
      + 'DOCUMENTS: this count also holds documents that were MODIFIED rather than created, and '
      + 'payments applied to documents nobody created here. Open the id in that system, and read the '
      + 'record itself for what the operation actually did before you void, credit or reverse '
      + 'anything.',
    )
  }
  if (counts.LEDGER_DRAFT > 0) {
    parts.push(
      `${counts.LEDGER_DRAFT} MOVED NO BALANCES — the posting mode on those rows was \`draft\`, so `
      + 'what they wrote sits UNPOSTED in Xero. DO NOT void, credit-note or reverse any of them: a '
      + 'reversal POSTS FOR REAL, and would move the accounts by exactly the amount the draft never '
      + 'moved. THEY WERE NOT ALL CREATED AS DRAFTS: this count also holds documents that were '
      + 'MODIFIED while unposted, and deleting one of those destroys a draft that stood there before '
      + 'the attempt ran. Read the record itself before deleting anything.',
    )
  }
  if (counts.LEDGER_OUTCOME_UNRECORDED > 0) {
    parts.push(
      `${counts.LEDGER_OUTCOME_UNRECORDED} are from operations that create a LIVE ledger document on `
      + 'one posting-mode setting and an UNPOSTED DRAFT on the other, ON RECORDS THAT DO NOT SAY '
      + 'WHICH. IMS cannot tell you whether those balances moved. Do not void, credit, reverse or '
      + 'delete anything on the strength of these. Escalate them.',
    )
  }
  if (counts.LEDGER_DOCUMENT_NO_IDENTIFIER > 0) {
    parts.push(
      `${counts.LEDGER_DOCUMENT_NO_IDENTIFIER} are the same kind of write — a DOCUMENT Xero or `
      + 'QuickBooks accepted, which no reset of ours voids — ON A RECORD THAT CARRIES NO ID. DO NOT '
      + 'GO LOOKING FOR AN ID: there is none to open. Read those records themselves; each one says '
      + 'what it holds, and none of them holds enough to pick that document out of a ledger. '
      + 'Escalate them.',
    )
  }
  if (counts.LEDGER_NON_DOCUMENT > 0) {
    parts.push(
      `${counts.LEDGER_NON_DOCUMENT} record a write Xero or QuickBooks ACCEPTED that is NOT a `
      + 'standalone document and has NO id to open — a credit note APPLIED to a bill, a tax rate '
      + 'written into the organisation. The write stands and no reset of ours undoes it, and the '
      + 'allocation moved money. Read those records themselves; do not go looking for a document.',
    )
  }
  if (counts.NO_IDENTIFIER_SIDE_EFFECT > 0) {
    parts.push(
      `${counts.NO_IDENTIFIER_SIDE_EFFECT} are NOT accounting documents — no invoice, bill, credit `
      + 'note, payment or journal was created in Xero or QuickBooks for any of them. They record an '
      + 'effect that landed somewhere else and can repeat: a file attached to an EXISTING bill, an '
      + 'invoice PDF written over the stored copy, an '
      + 'invoice email QUEUED to a customer, a note written onto a WooCommerce order. '
      // ROUND 11 (Codex MEDIUM): THE UNKNOWN BUCKET IS NAMED RATHER THAN ASSUMED AWAY. This sentence
      // used to read "(or, where attachment upload is off, nothing at all — each record says which)".
      // A record written before IMS captured the handler's outcome says the opposite of "which": it
      // says it does not know. This count does not separate the three, so the breadcrumb may not
      // imply it does.
      + 'AN ATTACHMENT RECORD IN HERE MAY BE A NO-OP: that handler returns success WITHOUT uploading '
      + 'when attachment upload is off for its connector. Records written since IMS began capturing '
      + 'that outcome say which of the two happened; OLDER ONES SAY THEY DO NOT KNOW, and this count '
      + 'does not separate them, so it cannot tell you how many of either there are. '
      + 'The queued-email '
      + 'one never had a remote document at all — only a local email-outbox row, WHICH THIS RESET HAS '
      + 'JUST DELETED: the outbox rows that record tells you to inspect are gone with it, so their '
      + 'statuses can no longer be inspected.',
    )
  }
  if (counts.UNCLASSIFIED > 0) {
    parts.push(
      `${counts.UNCLASSIFIED} carry no operation type this version of IMS has classified, so it `
      + 'cannot say which kind they are. Read those records themselves before assuming any of them.',
    )
  }
  parts.push(
    // ROUND 11 (Codex MEDIUM): NOT "each record says what the effect was". Some of them say the
    // opposite — an unclassified operation type, an attachment written before the handler's outcome
    // was captured, a posting mode that was never recorded — and this breadcrumb is exempt from
    // retention and from the reset, so a universal it cannot support outlives everything else here.
    'Read each record. It says what can be done about it, and where IMS could not establish what the '
    + 'effect was, it says that instead of guessing. Nothing else in IMS '
    + 'references any of them any more. Search this log for '
    + `${UNRECORDED_POSTED_DOCUMENT_ACTIONS.map((action) => `"${action}"`).join(' or ')}.`,
  )
  return parts.join(' ')
}

/**
 * THE WHOLE MESSAGE FOR AN ATTEMPT THAT MADE NO EXTERNAL EFFECT (round 11, Codex HIGH).
 *
 * THE DEFECT. Round 10 gave the disabled-upload case its own wording and left it inside the generic
 * no-Request-Id frame. That frame opens by asserting an external effect has happened, and closes by
 * instructing the operator to turn QuickBooks sync off, LEAVE it off, and escalate — while itself
 * acknowledging that doing so "stops EVERY QuickBooks row, not this one". So an operation that made
 * no request at all, changed nothing anywhere and cost nothing to repeat became the reason to halt
 * unrelated invoice, bill, payment and journal processing across the whole installation, for as long
 * as it took someone to come and look.
 *
 * The wording round 10 added was correct and is still here, in `effect` and `check`. What was wrong
 * was everything around it, and a paragraph cannot correct its own frame — so the frame is separate.
 *
 * WHAT THIS ONE SAYS INSTEAD. It states that nothing happened; it says what a replay costs, which is
 * nothing while the setting stays as it is; it REFUSES the connector-wide shutdown, and says why —
 * there is no effect to contain, and the switch stops work that has nothing to do with this row; it
 * names the one setting that is actually load-bearing here and says to leave it as it is until the
 * write failure is fixed; and it points at the failure that IS real, which is that IMS could not
 * record the attempt and the row is now stuck.
 */
function describeQboNoEffectIncident(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  wording: ReplayWording,
  cause: unknown,
): string {
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} MADE NO EXTERNAL `
    + 'EFFECT. The handler returned success WITHOUT ACTING: no request was sent, nothing was '
    + 'created, changed, uploaded or emailed, and nothing in QuickBooks or anywhere else is '
    + 'different because this attempt ran. WHAT COULD NOT BE RECORDED IS THAT IT RAN AT ALL: '
    + `${String(cause)}. `
    + `WHAT A REPLAY WOULD COST: sync row ${entry.id} still holds this worker's claim and no `
    + 'mirrored accounting event was written, so once that claim goes stale the sweep will reclaim '
    + `the row and run the operation again. Running it again does ${wording.effect}. `
    + `WHAT TO DO ABOUT THE EFFECT: ${wording.check}. `
    + 'DO NOT TURN QUICKBOOKS SYNC OFF FOR THIS ONE. That switch is the containment lever for an '
    + 'incident where something DID reach QuickBooks. There is nothing here to contain, and turning '
    + 'it off stops EVERY QuickBooks row on this installation — invoices, bills, payments and '
    + 'journals with nothing to do with this row — for as long as it stays off. '
    + 'IF YOU WANT THE REPLAY TO STAY A NO-OP, LEAVE ATTACHMENT UPLOAD DISABLED: the setting is '
    + 'quickbooks_sync_attach_pdf, and enabling it is the single change that would make the next '
    + 'sweep act for real. Leave it as it is until the write failure above is fixed. '
    + `WHAT IS ACTUALLY WRONG IS THE WRITE, NOT THE OPERATION: sync row ${entry.id} is left `
    + 'PROCESSING at attempt revision 0 with no mirrored event, and nothing in IMS will settle it. '
    + `Fix the failure named above, and ESCALATE sync row ${entry.id}, with this record, to whoever `
    + 'administers this installation: closing it safely needs someone who can read the database '
    + 'directly (o3d-4b5p, o3d-3lhp). '
    + 'ONE THING ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a '
    + 'settle control for every FAILED or PROCESSING row, and on this one it resolves to the words '
    + '"not settleable" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It tells you to '
    + 'retry the row until it shows an attempt revision, and the QuickBooks claim never stamps one, '
    + 'so no number of retries will ever make an attempt appear. This is the known hole o3d-qn21. '
    + INCIDENT_IDENTIFICATION_TAIL
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
 *     reader is told to go and look at the effect, told the one lever that stops new runs starting,
 *     told what that lever does NOT do (round 7), and told to escalate the row rather than settle
 *     it — because IMS cannot show them that the row is quiet (o3d-4b5p).
 */
export function describeUnpersistedQboPost(incident: UnpersistedQboPost, cause: unknown): string {
  const { entry, postedExternalId } = incident
  const replayEntry = QBO_OPERATIONS_WITHOUT_REQUEST_ID[entry.type]
  // ROUND 10 (Codex MEDIUM): `BILL_ATTACHMENT` has one wording per OUTCOME, not one wording. See the
  // table: the handler returns success without uploading when attachment upload is off.
  const noRequestId = replayEntry && ('effect' in replayEntry
    ? replayEntry
    : replayEntry[remoteEffectKnowledge(incident.outcome)])
  // ROUND 11 (Codex HIGH): AND AN ATTEMPT THAT DID NOTHING GETS ITS OWN WHOLE MESSAGE, NOT ITS OWN
  // PARAGRAPH INSIDE THIS ONE. See `describeQboNoEffectIncident`. The test for it asserts the ENTIRE
  // generated string, because round 10's tests asserted the outcome-specific fragments, passed, and
  // left the fragments sitting inside a frame that contradicted every one of them.
  //
  // The gate is that the NONE VARIANT OF THE REPLAY WORDING WAS THE ONE SELECTED — not merely that
  // the record says `externalEffect: 'NONE'`. Only an operation with a no-op success path has a
  // variant to select; an `INVOICE_PDF` record carrying NONE would otherwise be handed a frame
  // saying nothing happened, above a replay sentence describing the PDF being written again.
  const noExternalEffect = replayEntry !== undefined && !('effect' in replayEntry)
    && remoteEffectKnowledge(incident.outcome) === 'NONE'
  if (noRequestId && noExternalEffect) {
    return describeQboNoEffectIncident(entry, noRequestId, cause)
  }
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
      + 'HOW TO STOP MORE OF IT: turn QuickBooks sync OFF. The control is the checkbox at the top of '
      + 'the SYNC tab of the QuickBooks connector panel, and it writes the setting '
      + 'quickbooks_sync_enabled. IT IS LABELLED "Enable Xero Sync" EVEN THERE, and its helper text '
      + 'says Xero too: the QuickBooks panel renders the Xero client and those two strings are '
      + 'hardcoded. The words are wrong; the checkbox is the right one. (Filed as o3d-m9wm.) '
      + 'The stale-claim sweep and the manual Sync button both READ '
      + 'that setting before they call the QuickBooks processor, so while it is off neither one '
      + 'STARTS another run. It stops EVERY QuickBooks row, not this one, and it recalls nothing '
      + 'already queued or already done. '
      + 'THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE. Both of those call sites read the '
      + 'setting and then call the processor with nothing in between, so a run admitted a moment '
      + 'before you flipped it keeps going: it can claim THIS row afterwards, run the operation '
      + 'again, and then write over the row — the write that records a QuickBooks post updates the '
      + 'row BY ID ALONE, with no claim token, no attempt revision and no status check, so it lands '
      + 'on whatever the row says by then. That claim also leaves the row at attempt revision 0, '
      + 'which is indistinguishable from the abandoned attempt in front of you. Nothing in IMS '
      + 'reports whether such a run is still going, so there is no moment you can point at and call '
      + 'this row quiet. '
      + `SO DO NOT CLOSE THIS ROW YOURSELF, AND DO NOT TURN QUICKBOOKS SYNC BACK ON TO FINISH THE `
      + `JOB. Leave the toggle off and ESCALATE sync row ${entry.id}, with this record, to whoever `
      + 'administers this installation: closing it safely needs someone who can read the database '
      + 'directly, and the machinery that would make an operator remedy sound is filed as o3d-4b5p '
      + '(a quiescence fence the cron, the manual sync, the claim and the writeback all honour) and '
      + 'o3d-3lhp (a per-row remediation, and a way to cancel a queued email). '
      + 'ONE THING ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a '
      + 'settle control for every FAILED or PROCESSING row, and on this one it resolves to the words '
      + '"not settleable" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the '
      + 'generic reason, written for a connector that stamps attempt revisions, and it tells you to '
      + 'retry the row until it shows one: QuickBooks never stamps one, so no number of retries will '
      + 'ever make an attempt appear — and every retry is another replay of the effect above. '
      + 'This is the known hole o3d-qn21. Until the work above lands, this record is the only thing '
      + 'that says the effect repeated.'
  }
  // ROUND 8 (Codex MEDIUM), as above: a post can succeed with no id at all — both payment handlers
  // return `res.data?.Payment?.Id` / `?.BillPayment?.Id` without checking presence, and the caller
  // passes `syncResult.externalId ?? null` straight through — so the remedy is written from whether
  // an id is here, not from the fact that this operation type usually has one.
  const posted = nonEmpty(postedExternalId)
  // ROUND 9 (Codex HIGH): AND EVERYTHING BELOW IS WRITTEN FOR A DOCUMENT POST. The four
  // no-identifier operations are taken by the branch above; every OTHER non-document operation —
  // an allocation, a tax rate, a type this binary does not know — fell through to it and was told
  // to open, confirm and void a document. Same defect as the Xero formatter, same shared answer.
  // ROUND 10 (Codex HIGH): and a document incident is no longer one wording either — an UPDATE, a
  // PAYMENT, a DRAFT and a live CREATE need four different things done, and the enum member does not
  // say which. QuickBooks has no draft form of any document (quickbooks/invoices.ts: "No
  // DRAFT/AUTHORISED status distinction on creation"), so its caller resolves LIVE and the DRAFT
  // wordings below are unreachable from this connector — by fact, not by assumption.
  const kind = incidentKindForOperation(entry.type, posted, incident.outcome)
  if (!isDocumentKind(kind)) {
    return describeNonDocumentIncident({
      ledger: 'QuickBooks',
      entry,
      kind,
      postedExternalId: posted,
      outcome: incident.outcome,
      rowState: `The failure that stopped it being recorded: ${String(cause)}. Sync row ${entry.id} `
        + 'still holds this worker\'s claim and names no document. ',
    })
  }
  const w = documentIncidentWording(entry.type, kind)
  const slots: WordingSlots = {
    ledger: 'QuickBooks', postedExternalId: posted, lookup: w.lookup, lookupNoun: w.noun,
  }
  const did = render(posted ? w.didWithId : w.didWithoutId, slots)
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} ${did}, but IMS `
    + `could not record the post: ${String(cause)}. `
    + `Sync row ${entry.id} still names no document, so nothing in IMS points at this one and no `
    + 'mirrored accounting event was written for it — deliberately, because a FAILED one would deny a '
    + 'document that exists. The row keeps its claim and will be re-attempted once the claim goes '
    + 'stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated '
    + 'rather than duplicated. '
    + (posted
      ? render(w.remedyIdUnrecorded, slots)
      : 'AND THE RESPONSE CARRIED NO ID EITHER, so there is nothing to open — do not go looking for '
        + `one. ${render(w.absent, slots)} ${ESCALATE_REMEDY}.`)
    + ` ${INCIDENT_IDENTIFICATION_TAIL}`
}
