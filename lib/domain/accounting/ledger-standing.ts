import type { Prisma } from '@/app/generated/prisma/client'
import {
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  OPERATOR_RELEASE_SETTLEMENT_BASIS,
  VERIFIED_REVERSAL_SETTLEMENT_BASIS,
} from '@/lib/domain/accounting/sync-row-settlement'

// ---------------------------------------------------------------------------
// o3d-f709 / o3d-vzje / o3d-kof8 - LEDGER STANDING: WHAT AN AccountingSyncLog ROW IS ALLOWED TO
// SAY ABOUT THE LEDGER, STATED ONCE.
//
// THE DEFECT THIS MODULE EXISTS TO END. `AccountingSyncLog.status` was read as a statement about the
// ledger in ~60 places, each with its own hand-written spelling:
//
//   status !== 'CANCELLED'   "an abandoned row committed nothing"        (FALSE: seven cancellers,
//                                                                         three of which know nothing)
//   status === 'SYNCED'      "the connector told us it posted"           (FALSE: an operator's typed
//                                                                         document id also lands here)
//   !!externalTransactionId  "a document exists"                          (FALSE for the same reason)
//
// Two columns make those readings checkable, and no reader consulted them: `settlementBasis` (HOW the
// row reached its status) and `abandonedBeforeRemoteCall` (whether the canceller PROVED the row was
// pre-call). This module reads them, in ONE function, and every reader that wants to conclude
// something about the ledger from a sync row asks it. The census guard
// (scripts/check-ledger-standing-readers.mjs) fails the build on a reader that does not.
//
// THE SIX STANDINGS, and the question each one answers.
//
//   CONFIRMED_POSTED     the ledger answered: a connector writeback carries the document id (or an
//                        id-less type reached SYNCED). A ledger fact.
//   ASSERTED_POSTED      a PERSON typed a document id in (settlement POSTED, or the cancelled-sale
//                        settlement). The document is claimed to EXIST; IMS never saw it. Counts for
//                        EXISTENCE questions ("do not post a second one") and never for AMOUNT
//                        questions ("how much relief is proved"). Always reported (D2).
//   ASSERTED_NOT_POSTED  a PERSON said NOT_POSTED. THIS IS NOT PROOF (C1): a lost response, a late
//                        webhook and a hand-post all leave the same row. It may have reached the
//                        ledger; it never frees a work slot; it is reported.
//   PROVEN_NOT_POSTED    the ONLY standing that licenses "this did not reach the ledger": the
//                        orphan sweep matched a PENDING row and stamped the fact in the same UPDATE
//                        (pre-call), IMS asked the ledger and it said the payment is gone
//                        (VERIFIED_REVERSAL), or a FAILED row's own stored body proves the connector
//                        rejected it before any request.
//   UNKNOWN              nothing on the row can say. Every reader that cannot proceed on "unknown"
//                        refuses, withholds or reports; none may read it as "nothing posted".
//   LIVE_WORK            PENDING or PROCESSING, no document id, no assertion: work still owed or in
//                        flight. Neither posted nor not-posted yet.
//
// THE TRUTH TABLE (first match wins; "id" = externalTransactionId, trimmed, non-empty):
//
//    1  any status, any NON-NULL basis this build does not recognise             -> UNKNOWN
//    2  PENDING|PROCESSING + OPERATOR_ASSERTION (no writer produces it)          -> UNKNOWN
//    3  any + OPERATOR_ASSERTION + id (SYNCED POSTED settlement, or the
//       CANCELLED cancelled-sale settlement)                                     -> ASSERTED_POSTED
//    4  CANCELLED + OPERATOR_ASSERTION + no id (the NOT_POSTED settlement)       -> ASSERTED_NOT_POSTED
//    5  CANCELLED + VERIFIED_REVERSAL (id or not)                                -> PROVEN_NOT_POSTED
//    6  any + (NULL | OPERATOR_RELEASE) + id                                     -> CONFIRMED_POSTED
//    7  SYNCED + (NULL | OPERATOR_RELEASE) + no id (id-less types)               -> CONFIRMED_POSTED
//    8  CANCELLED + NULL + no id + abandonedBeforeRemoteCall === true            -> PROVEN_NOT_POSTED
//    9  CANCELLED + NULL + no id + abandonedBeforeRemoteCall !== true            -> UNKNOWN
//   10  FAILED + NULL + no id + couldHaveReachedLedger === false (caller proof)  -> PROVEN_NOT_POSTED
//   11  FAILED + NULL + no id otherwise                                          -> UNKNOWN
//   12  PENDING|PROCESSING + NULL + no id                                        -> LIVE_WORK
//
// Anything the table does not name (VERIFIED_REVERSAL on a non-CANCELLED row, OPERATOR_RELEASE on a
// row with no id that is not SYNCED, ...) is UNKNOWN: the table lists what is KNOWN.
//
// WHY `couldHaveReachedLedger` IS SUPPLIED BY THE CALLER AND NEVER INFERRED. Row 10 is the one proof
// that lives in the PAYLOAD (a stored body missing a field the connector requires is rejected before
// any HTTP request). Which fields are required is per sync type and lives with the follow-up code
// (`billPaymentBodyCouldHavePosted`, `attemptCouldHaveReachedTheLedger`); this module must not grow a
// second copy of that. It is therefore a parameter, and a query cannot ask it: the Prisma fragments
// below treat every FAILED row as "may have reached" (the safe direction).
//
// THE PRISMA FRAGMENTS ARE POSITIVE ARMS ONLY AND NULL-TOTAL. `NOT (a AND b)` is SQL NULL when a
// column is NULL and drops the row from BOTH sides of a split; every nullable column below is tested
// as an explicit `IS NULL` arm ORed with its negation. NO COMPLEMENT IS EXPORTED, deliberately:
// writing one would be a second statement of the table. A reader that needs the other side filters in
// TypeScript with `ledgerStanding`, or asks the positive fragment of the standing it wants.
// tests/domain/accounting/ledger-standing.test.ts runs the fragments and the function over the full
// status x id x basis x abandoned cross product and asserts they never disagree.
//
// ONE KNOWN LIMIT, STATED: TypeScript trims the id before believing it, Prisma cannot. A
// whitespace-only id (not an empty one - both are handled) would read "present" in a query and
// "absent" in TypeScript. No writer produces one (every writer trims, and the settlement action
// rejects a blank), and the cross-product test pins the empty-string case.
// ---------------------------------------------------------------------------

/**
 * The columns any reader of this rule must have loaded. Spread into a Prisma `select` - and note
 * that spreading it is not what makes the reader correct, passing the row to {@link ledgerStanding}
 * is; this constant exists so the two cannot drift.
 */
export const LEDGER_STANDING_SELECT = {
  status: true,
  externalTransactionId: true,
  abandonedBeforeRemoteCall: true,
  settlementBasis: true,
} as const

/**
 * A row carrying enough of itself to answer the question. Every field is REQUIRED: an absent
 * optional column reads as `null`, which is the PERMISSIVE answer on rows 6-9, so a caller that
 * forgot to load one would get a silently weaker verdict instead of a compile error.
 *
 * (The plan listed `attemptRevision` here too. No truth-table row consults it - the writer that
 * needs it, the BILL_PAYMENT supersession CANCEL, fences on `attemptRevision: 0` in its own
 * compare-and-swap - so it is deliberately not part of the standing.)
 */
export type LedgerStandingRow = {
  status: string
  externalTransactionId: string | null
  abandonedBeforeRemoteCall: boolean | null
  settlementBasis: string | null
}

export type LedgerStanding =
  | 'CONFIRMED_POSTED'
  | 'ASSERTED_POSTED'
  | 'ASSERTED_NOT_POSTED'
  | 'PROVEN_NOT_POSTED'
  | 'UNKNOWN'
  | 'LIVE_WORK'

export type LedgerStandingOptions = {
  /**
   * Row 10's proof, from the caller: `false` means the stored body is PROVEN to have been rejected
   * before any request. `undefined`/`true` = it could have been sent. See the header.
   */
  couldHaveReachedLedger?: boolean
}

function hasId(row: LedgerStandingRow): boolean {
  return typeof row.externalTransactionId === 'string' && row.externalTransactionId.trim().length > 0
}

/** WHAT THIS ROW SAYS ABOUT THE LEDGER. The truth table in the header, first match wins. */
export function ledgerStanding(row: LedgerStandingRow, options: LedgerStandingOptions = {}): LedgerStanding {
  const basis = row.settlementBasis
  const status = row.status
  const live = status === 'PENDING' || status === 'PROCESSING'
  const id = hasId(row)
  const connectorOrRelease = basis === null
    || basis === OPERATOR_RELEASE_SETTLEMENT_BASIS

  // 1: a non-null basis this build does not recognise.
  if (
    basis !== null
    && basis !== OPERATOR_ASSERTION_SETTLEMENT_BASIS
    && basis !== OPERATOR_RELEASE_SETTLEMENT_BASIS
    && basis !== VERIFIED_REVERSAL_SETTLEMENT_BASIS
  ) return 'UNKNOWN'
  // 2: an assertion on unfinished work has no writer.
  if (live && basis === OPERATOR_ASSERTION_SETTLEMENT_BASIS) return 'UNKNOWN'
  // 3 / 4: what a person said.
  if (basis === OPERATOR_ASSERTION_SETTLEMENT_BASIS) {
    if (id) return 'ASSERTED_POSTED'
    if (status === 'CANCELLED') return 'ASSERTED_NOT_POSTED'
    return 'UNKNOWN'
  }
  // 5: IMS asked the ledger and it said the payment is gone.
  if (status === 'CANCELLED' && basis === VERIFIED_REVERSAL_SETTLEMENT_BASIS) return 'PROVEN_NOT_POSTED'
  // 6 / 7: the connector's own writeback (or an operator release of a connector-issued id).
  if (connectorOrRelease && (id || status === 'SYNCED')) return 'CONFIRMED_POSTED'
  // 8 / 9: a cancellation proves nothing unless the canceller recorded the proof.
  if (status === 'CANCELLED' && basis === null && !id) {
    return row.abandonedBeforeRemoteCall === true ? 'PROVEN_NOT_POSTED' : 'UNKNOWN'
  }
  // 10 / 11: a failure is not a non-call (o3d-ju8t) unless the caller proves the body never left.
  if (status === 'FAILED' && basis === null && !id) {
    return options.couldHaveReachedLedger === false ? 'PROVEN_NOT_POSTED' : 'UNKNOWN'
  }
  // 12: unfinished work.
  if (live && basis === null && !id) return 'LIVE_WORK'
  return 'UNKNOWN'
}

/**
 * COULD THIS ROW HAVE REACHED THE LEDGER? The reading every hand-written `status !== 'CANCELLED'`
 * was trying to be. `true` is the unproved answer and therefore the safe one: it keeps a blocker
 * standing, keeps a refusal firing, keeps a row counted. `false` is a POSITIVE claim that nothing
 * was sent, returned only where the row itself (or the caller's payload proof) carries it.
 */
export function mayHaveReachedLedger(row: LedgerStandingRow, options: LedgerStandingOptions = {}): boolean {
  return ledgerStanding(row, options) !== 'PROVEN_NOT_POSTED'
}

/**
 * Is this a LEDGER FACT - the connector answered - rather than a claim, a guess or unfinished work?
 * The reading AMOUNT questions need (relief proved, a posted line's contents): an operator-typed id
 * is a claim the document exists, not a figure anybody read.
 */
export function isProvenLedgerFact(row: LedgerStandingRow): boolean {
  return ledgerStanding(row) === 'CONFIRMED_POSTED'
}

// ---------------------------------------------------------------------------
// THE WORK SLOT - "may another posting for this key be raised?"
// ---------------------------------------------------------------------------

export type WorkSlot = 'OCCUPIED' | 'BLOCKED' | 'FREE'

export type WorkSlotStanding = {
  slot: WorkSlot
  /**
   * The row's standing rests on an OPERATOR'S ASSERTION. Every reader that acts on an asserted
   * result must REPORT it (D2): suppression with no report is the laundering this module ends.
   */
  asserted: boolean
}

/**
 * OCCUPIED  a PENDING / PROCESSING / SYNCED row: the partial unique indexes' own predicate
 *           (`accounting_sync_logs_idempotency_key_uq`, `accounting_sync_logs_followup_live_unique`).
 *           A second posting is not raised - the work exists or is done. `asserted: true` when the
 *           SYNCED rests on an operator-typed id: still occupied (the document is claimed to exist),
 *           never silently.
 * BLOCKED   a CANCELLED row an operator asserted NOT_POSTED. The partial indexes do NOT see it (it is
 *           CANCELLED), which is exactly why the settlement action used to be the way to re-queue
 *           work. C1: the assertion is not proof, so the slot is NEVER freed by it - the enqueue
 *           refuses, and the operator hand-posts and marks the posting handled (D1).
 * FREE      everything else; a new posting may be raised. (A FAILED or unproven-CANCELLED row is
 *           free of the SLOT, and its separate "may it have posted?" question is `ledgerStanding`'s.)
 */
export function workSlotStanding(row: LedgerStandingRow): WorkSlotStanding {
  const asserted = row.settlementBasis === OPERATOR_ASSERTION_SETTLEMENT_BASIS
  if (row.status === 'PENDING' || row.status === 'PROCESSING' || row.status === 'SYNCED') {
    return { slot: 'OCCUPIED', asserted }
  }
  if (ledgerStanding(row) === 'ASSERTED_NOT_POSTED') return { slot: 'BLOCKED', asserted: true }
  return { slot: 'FREE', asserted }
}

// ---------------------------------------------------------------------------
// PRISMA RENDERINGS. Positive arms, null-total (see the header). One per question.
// ---------------------------------------------------------------------------

/** `externalTransactionId` holds a value ('' counts as absent, matching the trim in TypeScript). */
const ID_PRESENT: Prisma.AccountingSyncLogWhereInput = {
  AND: [{ externalTransactionId: { not: null } }, { externalTransactionId: { not: '' } }],
}

/** The complement of {@link ID_PRESENT}, spelled as two positive arms. */
const ID_ABSENT: Prisma.AccountingSyncLogWhereInput = {
  OR: [{ externalTransactionId: null }, { externalTransactionId: '' }],
}

/** Basis is the connector's own writeback (NULL) or an operator release of a connector id. */
const BASIS_CONNECTOR_OR_RELEASE: Prisma.AccountingSyncLogWhereInput = {
  OR: [{ settlementBasis: null }, { settlementBasis: OPERATOR_RELEASE_SETTLEMENT_BASIS }],
}

/**
 * Rows that are a LEDGER FACT (CONFIRMED_POSTED, rows 6 + 7): the connector's own basis, and either
 * a document id or an id-less SYNCED.
 */
export const PROVEN_LEDGER_FACT_WHERE: Prisma.AccountingSyncLogWhereInput = {
  AND: [
    BASIS_CONNECTOR_OR_RELEASE,
    { OR: [ID_PRESENT, { status: 'SYNCED' }] },
  ],
}

/**
 * The CANCELLED rows that are NOT proven absent from the ledger - the three arms of the table's
 * rows 3, 4, 6, 9 and the unrecognised-basis row 1, restricted to CANCELLED:
 *
 *   (a) names a document and was not verified reversed        rows 3 / 6 / 1
 *   (b) no document, a basis that is neither NULL nor VR      rows 4 / 1
 *   (c) no document, NULL basis, no recorded pre-call proof   row 9
 *
 * Exported for retention (`UNRESOLVED_ABANDONED_CLAIM_WHERE`), which asks exactly "which CANCELLED
 * rows must I not delete".
 */
export const UNPROVEN_CANCELLED_WHERE: Prisma.AccountingSyncLogWhereInput = {
  status: 'CANCELLED',
  OR: [
    // (a)
    {
      AND: [
        ID_PRESENT,
        { OR: [{ settlementBasis: null }, { settlementBasis: { not: VERIFIED_REVERSAL_SETTLEMENT_BASIS } }] },
      ],
    },
    // (b)
    {
      AND: [
        ID_ABSENT,
        { settlementBasis: { not: null } },
        { settlementBasis: { not: VERIFIED_REVERSAL_SETTLEMENT_BASIS } },
      ],
    },
    // (c)
    {
      AND: [
        ID_ABSENT,
        { settlementBasis: null },
        { OR: [{ abandonedBeforeRemoteCall: null }, { abandonedBeforeRemoteCall: false }] },
      ],
    },
  ],
}

/**
 * The rows a query must still treat as possibly in the ledger: everything except a PROVEN_NOT_POSTED
 * row. A FAILED row is always included - row 10's proof is in the payload and a query cannot read it
 * (the safe direction).
 */
export const MAY_HAVE_REACHED_LEDGER_WHERE: Prisma.AccountingSyncLogWhereInput = {
  OR: [
    { status: { not: 'CANCELLED' } },
    UNPROVEN_CANCELLED_WHERE,
  ],
}

/**
 * The partial unique indexes' own predicate: rows that OCCUPY a posting's work slot. Restated here so
 * the query, the TypeScript (`workSlotStanding`) and the database agree by construction.
 */
export const WORK_SLOT_OCCUPIED_WHERE: Prisma.AccountingSyncLogWhereInput = {
  status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
}
