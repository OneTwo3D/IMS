/**
 * o3d-11rf r2 — WHY A MIRRORED ACCOUNTING EVENT IS VOID, AND WHETHER A LATER ATTEMPT MAY TAKE IT BACK.
 *
 * THE DEFECT THIS EXISTS FOR. Mirror identity is LOGICAL: every attempt at one document shares one
 * `AccountingEvent`, keyed by the payload's `_idempotencyKey`. Two writers act on that shared event
 * and o3d-11rf serialised them on `lockFollowUpScope`, so their order is now deterministic. It is
 * not, on its own, CORRECT — serialising two operations establishes that they are ordered, not that
 * both orders end somewhere right:
 *
 *   enqueue, then settlement -> settlement's sibling read (behind the same lock) SEES the live
 *     replacement, `findMirrorOwnershipConflict` fires, and the mirror is left alone. Correct.
 *   settlement, then enqueue -> settlement sees no sibling and commits the shared event VOID. The
 *     replacement is then enqueued and `mirrorAccountingSyncLogToEvent` meets the idempotency key
 *     that event already holds — and RETURNED WITHOUT TOUCHING IT. A live PENDING sync row with a
 *     VOID mirror, which is the precise state o3d-11rf claimed to remove.
 *
 * AND IT IS NOT ONLY A RACE. `classifyPriorAttempts` treats a CANCELLED attempt as asserting that
 * nothing was sent, so a settled-NOT_POSTED row is exactly what LETS a replacement be enqueued.
 * Settle a row on Monday and re-queue it on Tuesday and the mirror is still VOID: the lock decides
 * the concurrent case, and the wrong end state is reachable with no concurrency at all.
 *
 * THE FIX IS NOT "REVIVE A VOID EVENT". Reviving on the mere existence of a new live attempt would
 * resurrect work a LEGITIMATE void retired, and `voidMirroredAccountingEventsForOrder` writes
 * exactly such voids: an order was CANCELLED, so its unposted documents must never exist. Settlement
 * already refuses the mirror-image of this (`skipped_cancelled_sale`: a POSTED assertion on a
 * cancelled sale does not flip the mirror back to POSTED, "because re-POSTing it is another way of
 * telling the rest of the system this sale's work is live again"). A blanket revive would make that
 * exact mistake from the other side, and would be worse than the bug it fixes: the bug understates a
 * live document; the blanket revive re-animates a retired one.
 *
 * SO THE DISTINCTION IS THE FIX, and the row could not previously express it. A VOID event recorded
 * one bit — VOID — for two facts that differ in what they retire:
 *
 *   • THE SOURCE was retired. The sales order is cancelled; the document must not exist, whatever
 *     arrives later. An attempt enqueued after this is a defect in the enqueue path, and a mirror
 *     that quietly followed it would hide that defect rather than record it. NEVER revivable.
 *   • ONE ATTEMPT was retired. An operator settled a single sync row NOT_POSTED — asserting that
 *     THAT attempt reached nothing — having established under the scope lock that no other row owned
 *     the mirror. It says nothing about whether the document is still owed, and re-queueing is the
 *     ordinary next step. Revivable by a later live attempt in the same scope.
 *
 * NOT DERIVED FROM THE AUDIT LOG, deliberately. `AccountingEventLog` does carry the two actions
 * (`voided_source_cancelled` against settlement's `failed_from_sync_log`), but reading provenance out
 * of it means picking the LATEST entry, and `accounting_event_logs.createdAt` defaults to
 * `CURRENT_TIMESTAMP` — which PostgreSQL evaluates at TRANSACTION START, so two entries written in
 * one transaction are indistinguishable and one written in a long transaction can predate an earlier
 * one. That is the same column trap o3d-cvj9 removed a revision ordering for. The fact is recorded
 * ON THE ROW instead.
 *
 * NULL IS NOT REVIVABLE, and that is the whole safety argument for the rows that already exist.
 * Every VOID written before this column is NULL, so nothing revives it; the population is dominated
 * by `voidMirroredAccountingEventsForOrder`, i.e. by exactly the kind that must never be revived. A
 * predecessor binary serving across the migration window writes NULL too, and lands on the same
 * side. The column only ever ADDS a permission, and only to a row whose writer said so.
 *
 * A LEAF MODULE ON PURPOSE, for the reason ./mirrored-sync-types states at length: both
 * accounting-event-mirror.ts (which reads the basis to decide a revive) and sync-row-settlement.ts
 * (which decides what settlement stamps) need these values, and dozens of suites replace
 * accounting-event-mirror wholesale with a partial `mock.module`, under which everything it exports
 * and the mock does not name becomes `undefined`. This module imports nothing, so no mock can catch it.
 */

/**
 * The order this event's document belonged to was cancelled, so the document itself is retired.
 * Written by `voidMirroredAccountingEventsForOrder`. No later attempt may take this event back.
 */
export const SOURCE_CANCELLED_VOID_BASIS = 'source_cancelled'

/**
 * An operator settled ONE sync row NOT_POSTED — "nothing reached the accounting system" — for a
 * document that may still be owed. Written by the settlement action's mirror write (see
 * `settlementMirrorVoidBasis`). A later LIVE attempt in the same scope may take this event back to
 * PENDING, because the assertion was about that attempt and not about the document.
 */
export const ATTEMPT_SETTLED_VOID_BASIS = 'attempt_settled_not_posted'

/**
 * May a NEW LIVE ATTEMPT take a VOID mirrored event back to PENDING?
 *
 * ONE DEFINITION, read two ways: the SQL predicate in `reviveMirroredEventForNewAttempt` is built
 * from `REVIVABLE_VOID_BASES` and this function tests membership of the same list, so a basis added
 * to one cannot be missed by the other — the shape of drift o3d-11rf's own lock gate was found in.
 *
 * Only for a void that retired an attempt. Unknown provenance — including every row written before
 * the column existed, and any value a future writer adds without deciding this question — answers
 * NO, because the cost of the two mistakes is not symmetric: refusing leaves the o3d-11rf
 * understatement, which is visible and repairable; agreeing wrongly re-opens a document a
 * cancellation retired.
 */
export const REVIVABLE_VOID_BASES = [ATTEMPT_SETTLED_VOID_BASIS] as const

const REVIVABLE = new Set<string>(REVIVABLE_VOID_BASES)

export function isRevivableVoidBasis(basis: string | null | undefined): boolean {
  return typeof basis === 'string' && REVIVABLE.has(basis)
}
