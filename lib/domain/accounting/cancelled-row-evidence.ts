import type { Prisma } from '@/app/generated/prisma/client'
import {
  UNRESOLVED_ABANDONED_CLAIM_WHERE,
  cancelledClaimIsResolved,
} from '@/lib/domain/accounting/unresolved-abandoned-claim'

// ---------------------------------------------------------------------------
// o3d-f709 — WHAT `AccountingSyncLog.status = 'CANCELLED'` IS ALLOWED TO MEAN ABOUT THE LEDGER.
//
// THE CLAIM THIS MODULE EXISTS TO STOP BEING HAND-WRITTEN. `status: { not: 'CANCELLED' }` — and
// its spelling as the four-status complement `['PENDING','PROCESSING','SYNCED','FAILED']`, and its
// TypeScript form `if (row.status === 'CANCELLED') continue` — all say the same thing: "a cancelled
// row committed nothing, so it cannot be evidence about a document." Every copy of it was written
// when that was true, and every copy of it carries a comment saying so.
//
// IT IS NO LONGER TRUE, AND THE WRITERS THAT MADE IT FALSE ARE ON `development`.
// `buildSettlementData` (NOT_POSTED) and `buildCancelledSaleSettlementData`
// (lib/domain/accounting/sync-row-settlement.ts) both terminalise a row to CANCELLED on an
// OPERATOR'S WORD, and the second of them writes a DOCUMENT ID onto it. Three further writers reach
// CANCELLED knowing nothing at all: the cross-connector orphan sweep over a claimed row,
// `cancelPendingSalesInvoiceSyncForOrder`, and the post-time retirement of a row a worker already
// held. The processors POST BEFORE they persist SYNCED and the external id, so an abandoned row may
// already be in a ledger with nothing local saying so.
//
// THE RULE IS NOT RESTATED HERE. `cancelledClaimIsResolved` (o3d-nepa, in
// unresolved-abandoned-claim.ts) already decides exactly this question for retention, and its two
// clauses plus the external-id veto are argued there at length. Restating them here — even
// identically — would be the defect this module is against, one file further on. So this module
// IMPORTS that rule and does one thing to it: turns "is the abandonment RESOLVED?" into the
// question the ten readers actually ask, "COULD THIS ROW HAVE REACHED THE LEDGER?", in the two
// languages they ask it in.
//
//   status ≠ CANCELLED           → may have reached the ledger. (SYNCED and FAILED both may;
//                                  o3d-ju8t settled that a failure is not proof of a non-call.
//                                  PENDING and PROCESSING may still.)
//   CANCELLED, unresolved        → may have reached the ledger. THE CORRECTION: this is the row
//                                  every hand-written copy drops, and it is the majority of them.
//   CANCELLED, resolved          → did NOT reach the ledger. Either the orphan sweep proved the row
//                                  was pre-call, or a human opened the ledger, looked, and signed a
//                                  NOT_POSTED assertion — and in neither case does the row name a
//                                  document.
//
// WHAT THIS DOES NOT DECIDE. `status = 'SYNCED'` reached by an operator's POSTED assertion is a
// SEPARATE laundering with a separate carrier (`settlementBasis`, read through
// `isOperatorAssertedSettlement`), and this module deliberately does not answer it: a reader that
// conflated the two would report an asserted post as a ledger fact in order to avoid reporting an
// abandoned row as one. Readers that need both ask both.
//
// WHY A `select` CONSTANT IS EXPORTED AND WHY IT IS NOT OPTIONAL. The TS reading needs three
// columns beyond `status`, and a reader that forgets one gets `undefined` — which
// `cancelledClaimIsResolved` would read as "absent", i.e. as UNRESOLVED, i.e. fail-closed but for
// the wrong reason and invisibly. `LedgerStandingRow` names all four as REQUIRED, so a caller that
// selected three of them fails `tsc` rather than quietly answering a question it did not load the
// evidence for. That is the enforcement for the TS half; `scripts/check-accounting-cancelled-row-
// predicates.mjs` is the enforcement for the query half.
// ---------------------------------------------------------------------------

/**
 * The columns any reader of this rule must have loaded. Spread into a Prisma `select` — and note
 * that spreading it is not what makes the reader correct, passing the row to
 * {@link mayHaveReachedLedger} is; this constant exists so the two cannot drift.
 */
export const LEDGER_STANDING_SELECT = {
  status: true,
  externalTransactionId: true,
  abandonedBeforeRemoteCall: true,
  settlementBasis: true,
} as const

/**
 * A row carrying enough of itself to answer the question. Every field is REQUIRED — see the note
 * above on why an optional one would fail closed invisibly.
 */
export type LedgerStandingRow = {
  status: string
  externalTransactionId: string | null
  abandonedBeforeRemoteCall: boolean | null
  settlementBasis: string | null
}

/**
 * COULD THIS ROW HAVE REACHED THE LEDGER? The reading every hand-written `status !== 'CANCELLED'`
 * was trying to be.
 *
 * `true` is the unproved answer and therefore the safe one: it keeps a blocker standing, keeps a
 * refusal firing, keeps a row counted. `false` is a POSITIVE claim that nothing was sent, and it is
 * returned only where the row itself carries the proof.
 */
export function mayHaveReachedLedger(row: LedgerStandingRow): boolean {
  if (row.status !== 'CANCELLED') return true
  return !cancelledClaimIsResolved(row)
}

/**
 * The same reading as a Prisma predicate: the rows a query must still treat as possibly posted.
 *
 * Written as a DISJUNCTION over the two arms rather than as a negation of the resolved set, for the
 * reason `UNRESOLVED_ABANDONED_CLAIM_WHERE` gives about itself: several of the columns are
 * NULLABLE, and `NOT` over a conjunction containing a NULL comparison excludes the row from BOTH
 * sides of the split. `status` is NOT NULL, so its arm is total on its own; the CANCELLED arm is
 * the predicate that was already made total for exactly this reason, imported whole.
 *
 * IT MUST NOT BE NEGATED. `{ NOT: MAY_HAVE_REACHED_LEDGER_WHERE }` is not "the rows that prove
 * nothing posted": the imported arm's totality is a property of the arm, not of its complement
 * under Prisma's compilation, and `status: { not: 'CANCELLED' }` under a further `NOT` is a double
 * negation Prisma renders but nobody reads correctly. NO COMPLEMENT IS EXPORTED, deliberately —
 * writing one would mean restating `cancelledClaimIsResolved`'s two clauses in a second place,
 * which is the defect this module exists to end. A reader that needs the other side asks
 * `retention`'s `UNRESOLVED_ABANDONED_CLAIM_WHERE` directly, or negates nothing and filters in TS
 * with {@link mayHaveReachedLedger}.
 */
export const MAY_HAVE_REACHED_LEDGER_WHERE: Prisma.AccountingSyncLogWhereInput = {
  OR: [
    { status: { not: 'CANCELLED' } },
    UNRESOLVED_ABANDONED_CLAIM_WHERE,
  ],
}
