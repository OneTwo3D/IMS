import type { Prisma } from '@/app/generated/prisma/client'
import type { FollowUpObligationRecovery } from '@/lib/domain/accounting/back-reference'

// ---------------------------------------------------------------------------
// WHO ACTUALLY RE-READS A RETAINED FOLLOW-UP OBLIGATION, DECLARED IN ONE PLACE (o3d-0bfh r6).
//
// r5 made `releaseFollowUpObligation` demand a `FollowUpObligationRecovery` from its caller, so a
// connector could no longer inherit Xero's "a later sweep will discharge it" by omission. Codex's r6
// review is right that this stopped short of what it claimed: `{ consumer: 'sweep' }` is an ordinary
// copyable object literal. It has no relationship to a registered sweep, to an exported binding or
// to a cron invocation, so a THIRD connector could copy Xero's literal, have no consumer whatsoever,
// and compile — which is precisely the defect r5 set out to make unrepresentable.
//
// The declaration therefore lives HERE, once per connector, and the connectors read it rather than
// writing one. That alone is still only a convention, so two things enforce it:
//
//   • tests/accounting/follow-up-recovery-registry.test.ts requires every `consumer: 'sweep'` entry
//     to have BOTH an exported sweep binding on that connector's module AND a scheduled or manual
//     invocation of it (a binding nothing calls is exactly as dead as no binding), and requires
//     every `consumer: 'none'` entry to have neither;
//   • the same test bans the `consumer: 'sweep'` literal anywhere outside this module, so the copy
//     route Codex described does not type-check its way past the registry.
//
// A connector with NO entry gets `consumer: 'none'` naming its own absence — the fail-safe
// direction. The dangerous default is the other one: silently promising a sweep that does not exist.
// ---------------------------------------------------------------------------

/**
 * The Xero repair sweep IS bound and IS invoked: `repairXeroBackReferences` is exported from
 * lib/connectors/xero/sync-processor.ts, called by the accounting-sync cron
 * (app/api/cron/accounting-sync/route.ts) and by the manual sync action (app/actions/xero-sync.ts).
 * Both halves are asserted by the registry test; this comment is not the evidence, that test is.
 */
const XERO_RECOVERY: FollowUpObligationRecovery = { consumer: 'sweep' }

// ---------------------------------------------------------------------------
// WHY THE REMEDY BELOW REFUSES TO AUTHORISE A CREATION AT ALL (o3d-0bfh r8, Codex HIGH).
//
// r7 replaced "the follow-ups were never enqueued, re-drive them" with "read QuickBooks first, then
// create only what is verifiably absent". That is safer, and it is still not safe: REMOTE ABSENCE IS
// NOT PROOF THAT CREATION IS SAFE.
//
// `enqueueFollowUps` on the QuickBooks connector writes each follow-up as its OWN local sync-log row,
// and it enqueues INVOICE_PAYMENT BEFORE INVOICE_PDF, in separate transactions. So the ordinary way
// this marker is retained — the PDF enqueue failing — leaves a payment row already PENDING in the
// local queue, not yet executed. An operator following r7's remedy reads QuickBooks in that window,
// finds no payment, creates one, and the queued row posts its own minutes later. The connector's
// idempotency is a request id it generated; it cannot deduplicate a payment a human created in the
// QuickBooks UI. The result is a double payment against one invoice, which is not undoable.
//
// The honest remedy is therefore READ AND ESCALATE. A remedy that permits creation would have to
// serialize against the local queue first — inspect every follow-up row for the document, hold or
// cancel it under one lock, and only then reconcile the remote document — and IMS has no such
// workflow (o3d-8prh gates building one: this connector does not enforce the connection/realm verdict
// at post time and its follow-up rows record no origin). Until it exists, this surface must not tell
// an operator to do by hand what it cannot make safe. Filed as follow-up work, not shipped as prose.
// ---------------------------------------------------------------------------

/**
 * QUICKBOOKS HAS THE CLAIM SIDE OF THE PROTOCOL AND NOT THE CONSUMER SIDE, and `blockedBy` names the
 * CURRENT blocker — not the one this codebase named for three rounds. o3d-s36z (realm isolation)
 * CLOSED on 2026-08-21 and unblocked nothing here: the remaining prerequisites are POST-TIME
 * AUTHORIZATION (o3d-8prh) and ORIGIN PROPAGATION on the rows a consumer would create. See the block
 * at the end of lib/connectors/quickbooks/sync-processor.ts for the order of work.
 */
const QUICKBOOKS_RECOVERY: FollowUpObligationRecovery = {
  consumer: 'none',
  blockedBy: 'the QuickBooks back-reference repair sweep is not bound and no cron invokes it (o3d-8prh: '
    + 'this connector does not enforce the connection/realm verdict at post time, and its follow-up rows '
    + 'record no origin, so a re-enqueued payment could post to a different company)',
  operatorRemedy: 'READ AND ESCALATE — DO NOT CREATE ANYTHING FOR THIS ROW, and in particular do not register a '
    + 'payment. NOTHING will come back for it, but that does NOT establish that its follow-ups never ran (see '
    + 'FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN), and reading QuickBooks first does NOT make creation safe: the '
    + 'follow-ups are separate LOCAL queue rows and INVOICE_PAYMENT is enqueued BEFORE INVOICE_PDF, so this marker '
    + 'survives a pass in which a payment is already sitting PENDING locally and has simply not executed yet. You '
    + 'would read QuickBooks, see no payment, create one, and the queued row would post its own afterwards — its '
    + 'request id cannot deduplicate a payment a human created, and a second payment against an invoice is not '
    + 'undoable. The row is listed in the exception inbox under "Accounting follow-ups owed, with nothing to '
    + 're-drive them" (/sync/exceptions): open the document in QuickBooks, record what is actually there — payment, '
    + 'PDF, email, attachment — and hand that reading to accounting. Deciding what may be created requires the '
    + "document's remaining local follow-up rows to be held or cancelled first, under one lock, which IMS does not "
    + 'yet do (o3d-8prh) — so there is no self-service remedy here and this surface deliberately offers none. '
    + 'Reading the document is safe to repeat as often as you like',
}

/**
 * Every accounting connector that CLAIMS a follow-up obligation, and what re-reads it afterwards.
 *
 * The keys are the `connector` values written onto `AccountingSyncLog.connector`, because that is
 * what the backlog query below has to match on.
 */
export const ACCOUNTING_FOLLOW_UP_RECOVERY: Readonly<Record<string, FollowUpObligationRecovery>> = {
  xero: XERO_RECOVERY,
  quickbooks: QUICKBOOKS_RECOVERY,
}

/**
 * The declaration for a connector — FAIL-SAFE for one nobody has decided about.
 *
 * An unknown connector answers `consumer: 'none'` naming its own absence rather than throwing: this
 * is called on the money path immediately after a document has already reached the ledger, so
 * throwing here would turn "nobody filled in the registry" into a failed sync entry over a posted
 * invoice. It must never answer `sweep`, because that is the answer that tells an operator the work
 * is in hand when nothing is holding it.
 */
export function followUpObligationRecoveryFor(connector: string): FollowUpObligationRecovery {
  const declared = ACCOUNTING_FOLLOW_UP_RECOVERY[connector]
  if (declared) return declared
  return {
    consumer: 'none',
    blockedBy: `no entry for connector "${connector}" in ACCOUNTING_FOLLOW_UP_RECOVERY, so nothing is known to `
      + 'read its retained markers back',
    operatorRemedy: 'declare the connector in lib/domain/accounting/follow-up-obligation-registry.ts. Until then '
      + 'treat any listed row as an UNKNOWN outcome, not an undone one: READ the document in the accounting '
      + 'package, record what is already present, and ESCALATE that reading. Do not create a payment, PDF or email '
      + 'from this surface — an absent document is not proof that nothing is queued to produce one, and on the '
      + 'payment path the mistake is not undoable',
  }
}

/** Connectors whose retained obligation markers are read by NOTHING — the backlog population. */
export const CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER: readonly string[] = Object.entries(ACCOUNTING_FOLLOW_UP_RECOVERY)
  .filter(([, recovery]) => recovery.consumer === 'none')
  .map(([connector]) => connector)

/**
 * Statuses in which a retained marker means the work is STRANDED rather than in flight.
 *
 * The processor selects PENDING and stale PROCESSING rows, so a marked row in either of those is
 * still on the automatic ladder and listing it would be self-resolving noise. SYNCED and FAILED are
 * the two the processor will never select again: SYNCED is the one this whole finding is about (the
 * post landed, the follow-ups did not, and nothing distinguishes the row from one that completed
 * except this marker), and FAILED is where a row whose retries exhausted comes to rest still owing.
 */
export const STRANDED_FOLLOW_UP_OBLIGATION_STATUSES = ['SYNCED', 'FAILED'] as const

// -------------------------------------------------------------------------
// WHAT `backReferenceFollowUpsPendingAt` IS, AND WHAT IT IS NOT (o3d-0bfh r7, Codex HIGH).
//
// IT IS A MONOTONIC GENERATION TOKEN. `nextFollowUpObligationGeneration` mints it as
// `max(now, observed + 1ms)` — deliberately AHEAD of the minting host's clock whenever a generation
// is already on the row, precisely so that two writers inside one TIMESTAMP(3) millisecond, or two
// hosts whose clocks disagree, still cannot mint a value the other could be holding. Its whole job
// is ORDERING and OWNERSHIP: a release clears only the exact generation it minted.
//
// IT IS NOT A TIMESTAMP. It does not answer "when did this row start owing follow-ups", and under
// contention (or after a backward clock correction on the minting host) it is a value that has not
// happened yet. So:
//
//   • never compare it to a clock — `lt`/`gt`/`gte`/`lte` against `new Date()` is exactly the bug
//     this comment exists to stop. r6 excluded backlog rows with `marker < now - grace`, which hid a
//     genuinely stranded obligation until the FUTURE marker plus the grace, by an amount that grows
//     with contention. The hidden row is a stalled payment nobody is told about;
//   • never render it to an operator as an age or an "owed since";
//   • never subtract it from anything.
//
// THE ONLY QUESTION A READER OUTSIDE THE CLAIM/RELEASE PROTOCOL MAY ASK OF IT IS WHETHER IT IS NULL.
// Non-null means "some pass took this obligation and no pass has discharged it". That is a fact
// about STATE, needs no interpretation, and is all the backlog below uses it for.
// tests/accounting/follow-up-recovery-registry.test.ts enforces the rule by scanning for a range
// comparison on the column, so the next reader cannot re-introduce it quietly.
// -------------------------------------------------------------------------

/**
 * How long after the row REACHED ITS TERMINAL STATE it is still assumed to be mid-pass.
 *
 * The connector claims the obligation in the SYNCED transaction and releases it a few statements
 * later, so a marked SYNCED row exists for a moment on every healthy post. Without this window the
 * backlog would flicker with rows that are perfectly fine, and an operator surface that cries wolf
 * every few seconds is not a surface.
 *
 * IT IS A NOISE FILTER OVER A REAL AGE, NOT AN OWNERSHIP FENCE. Ownership is the generation's job
 * and the generation is never read here (see above). Five minutes is far longer than the
 * claim→release interval and far shorter than "someone will notice tomorrow"; a pass that genuinely
 * runs longer than this is listed while still active, which is why the remedy this backlog carries
 * treats every row as an UNKNOWN outcome to be reconciled rather than as work known to be undone.
 */
export const FOLLOW_UP_OBLIGATION_SETTLING_GRACE_MS = 5 * 60 * 1000

/**
 * The columns the grace is measured from — and BOTH ARE STAMPED BY THE DATABASE (o3d-0bfh r8, Codex
 * HIGH).
 *
 * r7 measured on `syncedAt`, which is a real wall-clock time but one the CONNECTOR writes with the
 * application host's `new Date()`. The cutoff it was compared against was another application
 * `new Date()`, on whichever host renders the inbox. Two free-running clocks — the exact
 * disagreement `syncedAtDatabaseClock` was added to this same table to make visible — and the
 * dangerous direction is the silent one: if the minting host runs ahead, or is stepped backwards
 * afterwards, `syncedAt` stays above the cutoff and a genuinely stranded payment is HIDDEN from the
 * only surface that reports it, for as long as the two hosts disagree.
 *
 * `backReferenceFollowUpsClaimedAtDatabaseClock` is stamped from `clock_timestamp()` by a trigger on
 * the marker column itself (migration 20260827120000), so it is written by the database, in the same
 * statement as the generation, and no writer can forget it. `createdAt` is a database `now()`
 * DEFAULT. Neither is ever advanced by the fencing protocol and neither is an application clock, and
 * the cutoff they are compared against is a `clock_timestamp()` read from the SAME database
 * (`readFollowUpObligationDatabaseNow`). Every end of every comparison is one clock.
 *
 * `syncedAt` is deliberately ABSENT. It is still on the row and still shown elsewhere; it is simply
 * not evidence about ordering, and this backlog is an ordering question.
 */
export const FOLLOW_UP_OBLIGATION_AGE_COLUMNS = ['backReferenceFollowUpsClaimedAtDatabaseClock', 'createdAt'] as const

/**
 * `clock_timestamp()` from the application database — the ONLY clock this backlog is allowed to age
 * against.
 *
 * `clock_timestamp()` rather than `now()` for the same reason the stamp uses it: `now()` is
 * transaction-start time and would be free to report an instant before the claim it is being
 * compared with. `AT TIME ZONE 'UTC'` because both columns are `TIMESTAMP(3)` without time zone and
 * Prisma reads them back as UTC — the writing end (the trigger) uses the identical expression, so
 * the two are comparable whatever the session's TimeZone is.
 *
 * RETURNS `null` RATHER THAN THROWING, AND `null` MEANS "NO GRACE" (see the query below). A database
 * that cannot be asked the time must not silently fall back to this host's clock — that is the defect
 * — and it must not take the exception inbox down either. Listing every marked row is noisy and
 * correct; hiding one is quiet and wrong.
 */
export async function readFollowUpObligationDatabaseNow(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<Date | null> {
  try {
    const rows = await client.$queryRaw<Array<{ now: Date | null }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`
    const now = rows?.[0]?.now
    return now instanceof Date ? now : null
  } catch (error) {
    console.error('follow-up obligation backlog: could not read the database clock, so every marked row is listed', error)
    return null
  }
}

/**
 * THE OPERATIONAL BACKLOG (o3d-0bfh r6 Codex HIGH; the grace corrected in r7).
 *
 * Rows carrying a follow-up obligation on a connector that has no consumer for it. This is the whole
 * point of the finding: the previous design made an ACTIVITY-LOG LINE the only notice an operator
 * would ever get, and `logActivity` swallows its own persistence failure, so a transient failure of
 * that one insert left a payment, PDF, email or attachment permanently stalled with nothing anywhere
 * saying so. A row carrying a marker with no consumer is ALREADY a queryable state — this view over
 * it depends on no second write landing at the worst possible moment.
 *
 * THE MARKER IS TESTED FOR EXISTENCE ONLY. The age comes from the claim's database-stamped wall
 * clock (else `createdAt`), which are times; the marker is a generation and is not one. See the
 * block above. Both ends of the age comparison are readings of the DATABASE's clock — the cutoff is
 * derived from `readFollowUpObligationDatabaseNow`, never from this host.
 *
 * Backed by @@index([connector, status, createdAt]) on AccountingSyncLog for the connector+status
 * half; the marker predicate narrows a population that is empty in the healthy case.
 */
export function buildFollowUpObligationBacklogWhere(options: {
  /**
   * `clock_timestamp()` read from the application database — see `readFollowUpObligationDatabaseNow`.
   * REQUIRED, and deliberately not defaulted to `new Date()`: a default is how an application clock
   * gets back into this comparison without anyone deciding to put it there. `null` means the
   * database could not be asked, and then NO grace is applied at all.
   */
  databaseNow: Date | null
  settlingGraceMs?: number
  connectors?: readonly string[]
}): Prisma.AccountingSyncLogWhereInput {
  const grace = options.settlingGraceMs ?? FOLLOW_UP_OBLIGATION_SETTLING_GRACE_MS
  const connectors = options.connectors ?? CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER
  const where: Prisma.AccountingSyncLogWhereInput = {
    connector: { in: [...connectors] },
    status: { in: [...STRANDED_FOLLOW_UP_OBLIGATION_STATUSES] },
    // Existence, and nothing else. A range comparison here is the r7 defect.
    backReferenceFollowUpsPendingAt: { not: null },
  }
  // No database clock, no grace: every marked row is listed. Noise in the safe direction beats a
  // filter applied against a clock nobody can identify.
  if (options.databaseNow === null) return where
  const settledBefore = new Date(options.databaseNow.getTime() - grace)
  return {
    ...where,
    OR: [
      // The claim's own database-stamped wall clock. `not: null` is redundant in SQL (a comparison
      // with NULL is never true) and is stated anyway, so the predicate says which rows it means
      // without the reader having to know that.
      { backReferenceFollowUpsClaimedAtDatabaseClock: { not: null, lt: settledBefore } },
      // A claim minted before the stamp existed, or one whose trigger did not fire, carries no
      // database-stamped claim time. `createdAt` is a database `now()` DEFAULT, so this is still not
      // an application clock — it is merely EARLIER than the claim, which lists the row sooner. That
      // is the fail-safe direction for a surface whose failure mode is silence. Explicitly
      // `...: null` so the two branches cannot both match.
      { backReferenceFollowUpsClaimedAtDatabaseClock: null, createdAt: { lt: settledBefore } },
    ],
  }
}

/**
 * Oldest obligation first, tie-broken on `id` so a truncated page is deterministic across renders —
 * the same reason buildStrandedSyncRowOrderBy does it.
 *
 * On `createdAt`, NOT on the marker: sorting by the generation would order the page by who last
 * contended for a row rather than by how long the work has been owed, and would put a
 * contention-inflated marker at the wrong end of the list. `createdAt` is always present, is a real
 * time, and is the trailing column of @@index([connector, status, createdAt]).
 */
export function buildFollowUpObligationBacklogOrderBy(): Prisma.AccountingSyncLogOrderByWithRelationInput[] {
  return [{ createdAt: 'asc' }, { id: 'asc' }]
}

/**
 * WHAT A RETAINED MARKER DOES AND DOES NOT ESTABLISH (o3d-0bfh r7, Codex HIGH).
 *
 * Carried to the operator surface verbatim, because the r6 wording said the follow-up work "was
 * never enqueued" and told an operator to re-drive it. That is not established by the marker.
 * `settleFollowUpObligation` retains it when the enqueue SUCCEEDED and only the back-reference write
 * failed afterwards, and `releaseFollowUpObligation` retains it when every follow-up succeeded and
 * only the clearing write failed. On a money path, "redo it" against work that may already be queued
 * is worse than the stall being reported: a payment registered twice is not undoable.
 *
 * What IS established is the thing the backlog exists for: nothing on this connector will ever
 * re-read the marker, so no automatic route out exists. That is a statement about the SYSTEM and it
 * is true unconditionally. What happened to the work itself is a statement about the PAST, and the
 * marker does not carry it.
 */
export const FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN =
  'What is known: nothing on this connector will re-read this marker, so no automatic route out exists. What is '
  + 'NOT known: whether the payment, PDF, email or attachment was enqueued before the pass stopped — the same '
  + 'marker survives a pass whose follow-ups all ran and whose LAST write failed, AND a pass in which the payment '
  + 'was enqueued and the PDF was not, leaving a payment PENDING in the local queue right now. Neither the marker '
  + 'nor a reading of the accounting package distinguishes those, so the outcome of this row is UNKNOWN in both '
  + 'directions: read the document, record what is there, and escalate. Nothing here authorises creating a '
  + 'payment, PDF or email by hand.'

/** The columns the loader selects — the row as it comes off the database. */
export type FollowUpObligationBacklogSource = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  /** Read for its NULL-ness only — it is a generation, not a time. */
  backReferenceFollowUpsPendingAt: Date | null
  /** The DATABASE-STAMPED times. `owedSince` below is one of these, never the marker and never `syncedAt`. */
  backReferenceFollowUpsClaimedAtDatabaseClock: Date | null
  createdAt: Date
}

/** One row as an operator sees it, carrying the remedy its connector declared. */
export type FollowUpObligationBacklogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  /**
   * When the obligation was CLAIMED, as the database stamped it — else `createdAt`. NOT the
   * obligation marker (a generation, and displaying it as a time is the r7 defect) and NOT
   * `syncedAt` (an application host's `new Date()`, and comparing it to anything is the r8 defect).
   */
  owedSince: Date | null
  /** Why nothing re-drives it, straight from the connector's own declaration. */
  blockedBy: string
  /** What a human must do, because nothing automated will. */
  operatorRemedy: string
}

/**
 * Describe a marked row for the operator surface.
 *
 * The reason and the remedy are READ FROM THE REGISTRY rather than written here, so the sentence an
 * operator reads and the sentence the connector's log line carries cannot drift apart — they are the
 * same two strings. A row on a connector that DOES have a sweep is a programming error rather than a
 * backlog entry, and says so instead of being silently described as unrecoverable.
 */
export function describeFollowUpObligationBacklogRow(row: FollowUpObligationBacklogSource): FollowUpObligationBacklogRow {
  const recovery = followUpObligationRecoveryFor(row.connector)
  return {
    id: row.id,
    connector: row.connector,
    type: row.type,
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalTransactionId: row.externalTransactionId,
    owedSince: row.backReferenceFollowUpsClaimedAtDatabaseClock ?? row.createdAt,
    blockedBy: recovery.consumer === 'none'
      ? recovery.blockedBy
      : `connector "${row.connector}" declares a sweep consumer, so this row should not be in the backlog at all`,
    operatorRemedy: recovery.consumer === 'none'
      ? recovery.operatorRemedy
      : 'check the sweep binding for this connector — a row selected here means the backlog query and the '
        + 'recovery declaration disagree',
  }
}
