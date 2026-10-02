import type { Prisma } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// o3d-nepa — AN UNRESOLVED ABANDONED CLAIM, AND WHY AGE IS NOT EVIDENCE THAT IT IS FINISHED.
//
// Retention expires accounting_sync_logs by AGE, and it releases a row the moment its status is no
// longer one a document can be posted from (POSTABLE_ACCOUNTING_SYNC_STATUSES). That leaves exactly
// two deletable statuses, and they are NOT the same kind of fact:
//
//   SYNCED     is an OUTCOME. The processor made the call, the ledger answered, and the row records
//              what came back. Age may expire it.
//   CANCELLED  is an ABANDONMENT. It says somebody or something gave up on the row — and o3d-o97
//              established, in three separate readers, that it says NOTHING about whether pounds
//              moved. Three writers reach it without any of them knowing: the cross-connector
//              orphan sweep, `cancelPendingSalesInvoiceSyncForOrder` / the post-time retirement of a
//              CLAIMED row, and an operator on the accounting-sync screen. The processors POST
//              BEFORE they persist SYNCED and the external id, so a claimed row that was abandoned
//              may already be in the ledger with nothing local saying so.
//
// So a CANCELLED row is, by default, a claim that was abandoned and never resolved. Deleting it by
// age is deleting the only local record that the question was ever open.
//
// AND — exactly as in the money-evidence case this issue also covers — NO READER FAILS WHEN THE ROW
// IS DELETED. Each answers "nothing has been sent" and means it:
//
//   • `dailyBatchRecreateVerdict` (lib/connectors/xero/daily-sync.ts) reads every row for a batch
//     and refuses to rebuild the journal unless the rows PROVE no remote call was made. With the
//     rows gone it takes the `rows.length === 0` arm — "no log at all, so the journal never posted"
//     — and re-raises a DUPLICATE journal into a live ledger. That is the single reader here that
//     writes money, and deleting the evidence is what flips it from refusing to posting.
//   • `retryFailedXeroSync`'s sibling snapshot (app/actions/xero-sync.ts) reads every row of a scope
//     AT ANY STATUS, because — in its own words — "a SYNCED or CANCELLED sibling can also represent
//     money already in the ledger". followup-retry-guard.ts refuses a money retry whose scope holds
//     more than one distinct idempotency token. Delete the CANCELLED sibling and the scope becomes
//     UNAMBIGUOUS, the refusal disappears, and the retry posts a second payment. Nothing bounds this
//     one to a window: it is reachable for any scope, at any age.
//   • `resolveStagedAllocationDebit` (allocated-inventory-debit.ts) degrades honestly — it already
//     says "no longer on record (retention)" and keeps the debit standing — but it can no longer
//     name the journal an operator has to go and look at.
//
// Xero's Idempotency-Key expires six minutes after the original call, so nothing remote catches the
// second post either. The local row is the whole of the control.
//
// ONE ABANDONMENT IS RESOLVED, and it is the reason this predicate is not simply "never delete a
// CANCELLED row".
//
//   THE SYSTEM'S OWN PROOF. `cancelOrphanedRowsUnderLock` matches `status = PENDING` only - a
//   PENDING row is provably PRE-CALL - and writes `abandonedBeforeRemoteCall: true` in the SAME
//   UPDATE as the status. Nothing was sent, no ledger holds its document, and no reader of it can be
//   misled.
//
//   AN OPERATOR'S NOT_POSTED ASSERTION IS NOT ONE (C1, o3d-f709 - this reverses round 4 of
//   o3d-nepa). `settleAccountingSyncRow` with outcome NOT_POSTED terminalises the row CANCELLED and
//   stamps `settlementBasis = OPERATOR_ASSERTION`: a person said "nothing posted" about a ledger IMS
//   never looked at. That is a statement worth RECORDING and worth reporting, and it is not proof -
//   a lost response, a late webhook and a hand-post all leave the same row. Treating it as proof
//   made every such row deletable by age and let every reader that asks "could this have reached
//   the ledger?" answer no. The row is now retained like any other unresolved abandonment, and the
//   assertion stays visible on it as `settlementBasis`.
//
// Everything else is unresolved.
//
// A row that NAMES A DOCUMENT outranks the flag whichever way the flag points: an
// externalTransactionId exists only because a remote call returned, so it is the ledger's own
// receipt and an abandonment written over the top of it does not undo it. That is the same rule
// `dailyBatchRecreateVerdict` already applies, and it is stated here once so the two cannot differ.
//
// WHY THIS IS NOT THE MONEY-EVIDENCE EXEMPTION AND NOT THE POSTABLE-STATUS ONE. Three clauses, three
// questions, and none subsumes another:
//   status ∉ POSTABLE  — "can a document still be posted FROM this row?" (unfinished work)
//   type   ∉ MONEY     — "is this row's bare existence the only thing suppressing a second remote
//                        call?" (finished work, of three specific types)
//   NOT UNRESOLVED_ABANDONED_CLAIM
//                      — "was this row ever RESOLVED at all?" A CANCELLED SALES_INVOICE is in
//                        neither of the other two sets: CANCELLED is outside POSTABLE by design, and
//                        SALES_INVOICE is deliberately outside the money-evidence list.
//
// AND UNLIKE THE MONEY ROWS, THESE ARE COMPACTED RATHER THAN RETAINED WHOLE. That difference is not
// a preference, it is what the readers need. A money row's payload is the request that would be
// re-sent, so blanking it leaves a row that can neither prove nothing was sent nor be re-sent. Every
// reader above needs only COLUMNS — id, referenceId, status, externalTransactionId, the flag, and
// the derived idempotency token's row identity — and none of them reads the payload. A CANCELLED
// SALES_INVOICE payload, by contrast, is customer names, email and delivery addresses and line
// descriptions, which is precisely what sank the earlier whole-row exemptions. So the row survives
// and its content expires on schedule, through the tombstone o3d-9kek already defined.
// ---------------------------------------------------------------------------

/**
 * Is this cancelled row's abandonment RESOLVED — i.e. does something on it establish that no remote
 * call is unaccounted for?
 *
 * The TS half of the same rule `UNRESOLVED_ABANDONED_CLAIM_WHERE` states as a query. Both are
 * exported from here so that retention and the readers cannot drift on what "resolved" means —
 * o3d-550x's rule, applied to this record: name it once, inside the retention delete predicate, via
 * a shared constant.
 *
 * ONE WAY TO BE RESOLVED, and an external id that vetoes it:
 *
 *   `abandonedBeforeRemoteCall === true` — only `cancelOrphanedRowsUnderLock` ever writes it, and
 *   only over a PENDING (pre-call) row. `null` is not "a call was made", it is "not on record",
 *   which every reader treats as unproved.
 *
 * An operator's NOT_POSTED assertion is NOT a way to be resolved (C1, o3d-f709): it is a person's
 * statement about a ledger IMS never looked at, kept on the row as `settlementBasis` and reported.
 *
 * An externalTransactionId outranks the flag whichever way it points: the id exists only because a
 * remote call returned, so it is the ledger's own receipt and no later abandonment — flagged,
 * asserted or otherwise — undoes it. (`buildCancelledSaleSettlementData` writes exactly that shape:
 * CANCELLED, an operator assertion, AND a document id. It is retained, by this clause.)
 */
export function cancelledClaimIsResolved(row: {
  abandonedBeforeRemoteCall: boolean | null
  externalTransactionId: string | null
  settlementBasis: string | null
}): boolean {
  if (row.externalTransactionId) return false
  // C1 (o3d-f709): `settlementBasis` is deliberately NOT read here any more. An operator's NOT_POSTED
  // settlement records what a person SAID about a ledger IMS never looked at; it is not proof that
  // the ledger was never touched (a lost response, a late webhook and a hand-post all leave the same
  // row). `settlementBasis` stays in the parameter type so every caller keeps selecting it - the
  // module that now owns the rule (ledger-standing.ts) reads it for the VERIFIED_REVERSAL proof.
  void row.settlementBasis
  return row.abandonedBeforeRemoteCall === true
}

/**
 * THE RECORD RETENTION MUST NOT DELETE: a CANCELLED row whose abandonment resolves nothing.
 *
 * EVERY ARM IS A POSITIVE ALTERNATIVE, never a bare `{ not: <value> }` on a nullable column. This
 * predicate is consumed under a `NOT` (retention's delete) and NOT under one (retention's
 * compaction), and a sub-expression that can evaluate to SQL NULL means those two uses do not
 * partition the population — a `NULL` row would be excluded from BOTH, i.e. neither retained nor
 * compacted, and nothing would say so. So each nullable column is tested as an explicit `IS NULL`
 * arm ORed with the negation, which makes every disjunction total and the negation exact.
 *
 * Deliberately NOT keyed on `processingStartedAt` or on `attemptRevision > 0`, though "abandoned
 * claim" names a claimed row: every canceller NULLS `processingStartedAt` as it retires the row, so
 * the evidence that it was ever claimed is destroyed by the very write that abandons it. Keying on
 * it would exempt exactly nothing. Settlement NULLs it too, for the same reason.
 */
export const UNRESOLVED_ABANDONED_CLAIM_WHERE: Prisma.AccountingSyncLogWhereInput = {
  status: 'CANCELLED',
  OR: [
    // The row names a document the ledger returned, which outranks every resolution below.
    { externalTransactionId: { not: null } },
    // ...or NOTHING resolved it: the orphan sweep's pre-call proof is absent. (An operator's
    // NOT_POSTED assertion no longer resolves anything - C1.)
    { abandonedBeforeRemoteCall: null },
    { abandonedBeforeRemoteCall: false },
  ],
}
