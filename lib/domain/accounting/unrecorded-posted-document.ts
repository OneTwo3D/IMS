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
  // ROUND 8 (Codex MEDIUM): THE REMEDY MAY ONLY NAME AN ID THE RECORD ACTUALLY CARRIES. Both fields
  // are nullable, and "(no id returned)" is what this line already printed when one was — so
  // "find it by the id above" and "open both ids" were instructions to open a string that says
  // there is no string. An id that is absent gets a remedy that does not need one instead.
  const posted = typeof postedExternalId === 'string' && postedExternalId.length > 0 ? postedExternalId : null
  const named = typeof namedExternalId === 'string' && namedExternalId.length > 0 ? namedExternalId : null
  const postedText = posted ?? '(no id returned)'
  return reason === 'ROW_MISSING'
    ? `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as ${postedText}, `
      + `but its sync row ${entry.id} no longer exists, so nothing in IMS references the document. `
      + (posted
        ? 'REMEDY: find it in Xero by the id above and either keep it (re-enter the reference by hand) or void it; '
        : 'NO ID WAS RETURNED, so there is nothing to open — do not go looking for one. REMEDY: find it in Xero '
          + 'by the reference above, its amount and its date, and either keep it (re-enter the reference by hand) '
          + 'or void it; ')
      + 'nothing further will be retried for this row.'
    : `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as ${postedText}, `
      + `but sync row ${entry.id} already names a DIFFERENT document (${named ?? 'unknown'}) — a newer `
      + 'claim posted while this attempt was on the wire. BOTH documents exist in Xero. The row was left naming the '
      + 'first one. '
      + (posted && named
        ? 'REMEDY: open both ids in Xero, keep the one the row names, and void or credit the duplicate; '
        : 'ONE OF THE TWO IDS IS NOT RECORDED HERE, so they cannot both be opened. REMEDY: find the documents in '
          + 'Xero by the reference above, their amount and their date, keep the one the row names, and void or '
          + 'credit the duplicate; ')
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
    // distinguish "rejected" from "accepted, then the connection died". EXACTLY ONE FAILED PATH IS
    // CONCLUSIVE and it is conclusive because it runs BEFORE the send: the `emailSuppression`
    // lookup at the top of the loop, which writes `lastError: `Suppressed recipient: …``. That is
    // the discriminator the wording now hands the operator, and it is a recorded field rather than
    // an inference.
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
      + 'HOLDS NO DURABLE CONFIRMATION OF DELIVERY. ONE FAILED PATH IS CONCLUSIVE, because it runs '
      + 'BEFORE anything is handed to a mail server: the suppression check, whose lastError begins '
      + '"Suppressed recipient:" — that copy was never sent. EVERY OTHER FAILED ROW IS AMBIGUOUS. '
      + 'The sender stamps SENT only after the transport call has returned, and that stamp is inside '
      + 'the same try whose catch writes FAILED on the fifth attempt (and PENDING before it, which '
      + 'sends the copy again), so a copy that WAS delivered and could not be stamped ends up FAILED; '
      + 'and a send is judged from the transport error alone, which cannot say whether the server had '
      + 'already accepted the message. Read them by status, lastError and time, and DO NOT REPORT A '
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
 * `LEDGER_DOCUMENT` — a standalone document Xero or QuickBooks accepted and still holds, with an id
 * that opens it. Real money in somebody else's books; no reset of ours voids it.
 * `LEDGER_DOCUMENT_NO_IDENTIFIER` — the same class of write, from an operation whose handler DOES
 * return a document id, on a record that carries NO id (round 8, Codex MEDIUM). The document is
 * exactly as real; what is missing is the way to reach it. It gets its own sentence because the
 * `LEDGER_DOCUMENT` one ends "Open the id in that system", and there is no id to open.
 * `LEDGER_NON_DOCUMENT` — a write the ledger accepted that is NOT a standalone document and returns
 * no id to open: a credit note APPLIED to a bill, a tax rate written into the organisation. The
 * write stands, and the allocation moves money — but there is nothing to go and look up by id.
 * `NO_IDENTIFIER_SIDE_EFFECT` — one of the four operations above. Nothing was created in the ledger
 * at all: a file was attached, a PDF was written over, an email was QUEUED, a note was pushed to
 * WooCommerce. `INVOICE_EMAIL` in particular creates only a LOCAL outbox row.
 * `UNCLASSIFIED` — the record carries no type this codebase has classified. Counted separately and
 * NEVER folded into any of the others: the whole point is to stop asserting a remote document, and
 * guessing one is how the assertion got made in the first place.
 */
export type UnrecordedIncidentKind =
  | 'LEDGER_DOCUMENT'
  | 'LEDGER_DOCUMENT_NO_IDENTIFIER'
  | 'LEDGER_NON_DOCUMENT'
  | 'NO_IDENTIFIER_SIDE_EFFECT'
  | 'UNCLASSIFIED'

/**
 * EVERY OPERATION TYPE, CLASSIFIED ONCE, SHARED BY BOTH CONNECTORS (round 7, Codex MEDIUM).
 *
 * THE DEFECT THIS REPLACES. Round 6 classified by asking one question — "is this one of the four
 * no-identifier operations?" — and sent every other readable type to `LEDGER_DOCUMENT` by fallback.
 * That is the round-6 defect pointing the other way: an unknown was resolved to the CONFIDENT
 * answer. `PURCHASE_CREDIT_NOTE_ALLOCATION` is the proof. Xero processes it successfully and
 * deliberately returns NO external id — "the allocation is a sub-resource of the credit note, not a
 * standalone document" (xero/sync-processor.ts) — so a preserved incident for one was being counted
 * as a document that exists in Xero, carrying real money, openable by id. All three false, in the
 * one record in this system that outlives a factory reset. `TAX_RATE_SYNC` is the second: it returns
 * a tax TYPE code, which is neither money nor a document.
 *
 * SO THE MAP IS EXHAUSTIVE AND THE COMPILER ENFORCES IT. `Record<AccountingSyncType, …>` fails to
 * build the day a type is added to the enum, which is the only mechanism that reliably survives a
 * schema change; `tests/accounting/reset-preserves-unrecorded-posted-documents.ts` re-derives the
 * enum from prisma/schema.prisma and checks the same thing from the outside.
 *
 * KEYED ON THE TYPE, NOT THE CONNECTOR, deliberately — `AccountingSyncType` is shared, and the four
 * no-identifier operations return `{ success: true }` with no id on BOTH connectors (verified in
 * xero/sync-processor.ts and quickbooks/sync-processor.ts). A type QuickBooks has no branch for at
 * all (the allocation is one) is classified by what it IS, not by who could have posted it.
 *
 * HOW EACH ROW WAS DECIDED: by what the connector's handler RETURNS. A handler that returns an
 * `externalId` naming a document you can open is `LEDGER_DOCUMENT` — including the two *_UPDATE
 * types, which return the id of the document they wrote to; the kind asserts that a document stands
 * at that id, not that this operation created it. A handler that reaches the ledger and returns no
 * openable document id is `LEDGER_NON_DOCUMENT`. The four that reach no ledger at all are
 * `NO_IDENTIFIER_SIDE_EFFECT`.
 */
export const INCIDENT_KIND_BY_OPERATION_TYPE: Readonly<Record<AccountingSyncType, UnrecordedIncidentKind>> =
  Object.freeze({
    // Documents: the handler returns an invoice/bill/credit-note/payment/journal id.
    SALES_INVOICE: 'LEDGER_DOCUMENT',
    SALES_INVOICE_UPDATE: 'LEDGER_DOCUMENT',
    PURCHASE_INVOICE: 'LEDGER_DOCUMENT',
    PURCHASE_INVOICE_UPDATE: 'LEDGER_DOCUMENT',
    INVOICE_PAYMENT: 'LEDGER_DOCUMENT',
    BILL_PAYMENT: 'LEDGER_DOCUMENT',
    CREDIT_NOTE: 'LEDGER_DOCUMENT',
    PURCHASE_CREDIT_NOTE: 'LEDGER_DOCUMENT',
    // Manual journals — one shared branch on both connectors, returning `journalId`.
    COGS_JOURNAL: 'LEDGER_DOCUMENT',
    INVENTORY_ADJUSTMENT: 'LEDGER_DOCUMENT',
    STOCK_IN_TRANSIT: 'LEDGER_DOCUMENT',
    STOCK_RECEIPT: 'LEDGER_DOCUMENT',
    COGS_REVERSAL: 'LEDGER_DOCUMENT',
    STOCK_ALLOCATION: 'LEDGER_DOCUMENT',
    DAILY_BATCH_REVENUE_DEFERRAL: 'LEDGER_DOCUMENT',
    DAILY_BATCH_INVENTORY_ALLOC: 'LEDGER_DOCUMENT',
    DAILY_BATCH_GROUP_B: 'LEDGER_DOCUMENT',
    DAILY_BATCH_INVENTORY_RECONCILIATION: 'LEDGER_DOCUMENT',
    DAILY_BATCH_COGS_RECONCILIATION: 'LEDGER_DOCUMENT',
    DAILY_BATCH_TRANSIT_RECONCILIATION: 'LEDGER_DOCUMENT',
    UNEARNED_REV_REVERSAL: 'LEDGER_DOCUMENT',
    ALLOCATION_REVERSAL: 'LEDGER_DOCUMENT',
    REALISED_FX_JOURNAL: 'LEDGER_DOCUMENT',
    UNREALISED_FX_JOURNAL: 'LEDGER_DOCUMENT',
    MANUFACTURING_JOURNAL: 'LEDGER_DOCUMENT',
    MANUFACTURING_RECLASS: 'LEDGER_DOCUMENT',
    // Accepted by the ledger, but not a document and no id to open.
    PURCHASE_CREDIT_NOTE_ALLOCATION: 'LEDGER_NON_DOCUMENT',
    TAX_RATE_SYNC: 'LEDGER_NON_DOCUMENT',
    // The four the table above is written for: nothing reaches the ledger.
    BILL_ATTACHMENT: 'NO_IDENTIFIER_SIDE_EFFECT',
    INVOICE_PDF: 'NO_IDENTIFIER_SIDE_EFFECT',
    INVOICE_EMAIL: 'NO_IDENTIFIER_SIDE_EFFECT',
    WC_INVOICE_NOTE: 'NO_IDENTIFIER_SIDE_EFFECT',
  })

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
  if (typeof type !== 'string' || type.length === 0) return 'UNCLASSIFIED'
  const kind = (INCIDENT_KIND_BY_OPERATION_TYPE as Record<string, UnrecordedIncidentKind | undefined>)[type]
    ?? 'UNCLASSIFIED'
  // THE OPERATION SAYS A DOCUMENT ID EXISTS; THE RECORD SAYS WHETHER ONE WAS WRITTEN DOWN.
  if (kind !== 'LEDGER_DOCUMENT') return kind
  const postedExternalId = (metadata as { postedExternalId?: unknown }).postedExternalId
  return typeof postedExternalId === 'string' && postedExternalId.length > 0
    ? 'LEDGER_DOCUMENT'
    : 'LEDGER_DOCUMENT_NO_IDENTIFIER'
}

/** One tally per kind, so a caller cannot report a total it has not broken down. */
export type UnrecordedIncidentCounts = Record<UnrecordedIncidentKind, number>

export function countUnrecordedIncidents(rows: readonly { metadata: unknown }[]): UnrecordedIncidentCounts {
  const counts: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0,
    LEDGER_DOCUMENT_NO_IDENTIFIER: 0,
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
  const total = counts.LEDGER_DOCUMENT + counts.LEDGER_DOCUMENT_NO_IDENTIFIER
    + counts.LEDGER_NON_DOCUMENT + counts.NO_IDENTIFIER_SIDE_EFFECT + counts.UNCLASSIFIED
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
  if (counts.LEDGER_DOCUMENT_NO_IDENTIFIER > 0) {
    parts.push(
      `${counts.LEDGER_DOCUMENT_NO_IDENTIFIER} are the same kind of write — a DOCUMENT Xero or `
      + 'QuickBooks accepted, which no reset of ours voids — ON A RECORD THAT CARRIES NO ID. DO NOT '
      + 'GO LOOKING FOR AN ID: there is none to open. Read those records themselves and find the '
      + 'document in that system by the reference, the amount and the date they name.',
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
      `${counts.UNCLASSIFIED} carry no operation type this version of IMS has classified, so it `
      + 'cannot say which kind they are. Read those records themselves before assuming any of them.',
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
 *     reader is told to go and look at the effect, told the one lever that stops new runs starting,
 *     told what that lever does NOT do (round 7), and told to escalate the row rather than settle
 *     it — because IMS cannot show them that the row is quiet (o3d-4b5p).
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
  const posted = typeof postedExternalId === 'string' && postedExternalId.length > 0 ? postedExternalId : null
  return `QuickBooks ${entry.type} for ${entry.referenceType} ${entry.referenceId} POSTED as `
    + `${posted ?? '(no id returned)'}, but IMS could not record the post: ${String(cause)}. `
    + `Sync row ${entry.id} still names no document, so nothing in IMS points at this one and no `
    + 'mirrored accounting event was written for it — deliberately, because a FAILED one would deny a '
    + 'document that exists. The row keeps its claim and will be re-attempted once the claim goes '
    + 'stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated '
    + 'rather than duplicated. '
    + (posted
      ? 'REMEDY: open the id above in QuickBooks, confirm exactly one document exists for this '
        + 'reference, and void any duplicate.'
      : 'AND THE RESPONSE CARRIED NO ID EITHER, so there is nothing to open — do not go looking for '
        + 'one. REMEDY: find the document in QuickBooks by the reference above, its amount and its '
        + 'date, confirm exactly one exists for this reference, and void any duplicate.')
}
