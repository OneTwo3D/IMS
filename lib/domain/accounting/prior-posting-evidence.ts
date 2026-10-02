import type { Prisma } from '@/app/generated/prisma/client'
import { uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'
import {
  LEDGER_STANDING_SELECT,
  WORK_SLOT_STATUSES,
  workSlotStanding,
  ledgerStanding,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/ledger-standing'

/**
 * o3d-d0pd — WHAT AN ALREADY-PRESENT CHECK HAS TO PROVE BEFORE IT RAISES A SECOND ROW.
 *
 * THE DEFECT. Three enqueues (lib/connectors/xero/queue.ts, lib/connectors/quickbooks/queue.ts,
 * `queueAccountingSyncTx` in lib/accounting.ts) answered "does a posting for this idempotency key
 * already exist?" with
 *
 *     status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] }
 *
 * and the partial unique index `accounting_sync_logs_idempotency_key_uq` carries the SAME predicate,
 * so neither the query nor the database saw a prior attempt that had reached FAILED. An operator
 * running `retryRefundAccounting` on a refund whose reversal was queued and has since failed
 * therefore enqueued the same posting a SECOND time, and both rows could post: a duplicate credit
 * note, a duplicate COGS reversal. Real money, posted twice.
 *
 * A STATUS IS NOT A POSTING. That sentence is already load-bearing elsewhere in this directory and
 * it is the whole of this module:
 *
 *   • `postable-sync-statuses.ts` — FAILED is POSTABLE. o3d-ju8t: the remote call happens BEFORE the
 *     result is written back, so a lost response is written down as a rejection. A FAILED row can
 *     name a real document in a live ledger.
 *   • `create-dispatch-record.ts` — exists entirely because the transaction that records a
 *     successful create can fail AT COMMIT, leaving a FAILED/PENDING row over a document that is
 *     really there.
 *   • `sync-row-settlement.ts` — `findMirrorOwnershipConflict` already treats "a FAILED row with an
 *     externalTransactionId is a document that exists, whatever its status".
 *
 * So the question the enqueue is really asking is not "is a row live?" but "could a posting for this
 * key already exist?", and that is answered from the row's own EVIDENCE, in ANY status.
 *
 * THE THREE ANSWERS, and why each maps to the outcome it does:
 *
 *   live        a row is on the queue in a status a worker can still post from. Unchanged behaviour:
 *               the GL counterpart exists or will, so the caller's obligation is met.
 *   posted      a row in ANY status carries an `externalTransactionId`. The document EXISTS. Raising
 *               a second row would post a second document beside it. The counterpart exists, so the
 *               obligation is met — but nothing new is written.
 *   unresolved  a terminal row that carries no document id. NOTHING here can say whether its attempt
 *               reached the ledger, and both available lies are expensive: reporting `queued` would
 *               discharge an obligation over work nobody is going to do, and writing a second row
 *               would duplicate the posting if the first one landed. So the enqueue REFUSES, the
 *               posting stays owed, and the refusal names the row an operator can resolve — retry
 *               that row, or settle it with the per-row settlement action on /sync.
 *
 * WHY AN UNPROVEN CANCELLED ROW IS NOT A BLOCKER, AND WHY AN OPERATOR-SETTLED ONE IS (o3d-f709, C1).
 * A CANCELLED row leaves the partial unique indexes, so the DATABASE no longer stops a same-key retry.
 * What stops it is this classifier, and it reads the row's standing (o3d-f709 / o3d-kj718):
 *
 *   PROVEN_NOT_POSTED  frees the key. Three writers stamp `abandonedBeforeRemoteCall` in the SAME UPDATE as
 *                      the status, each over a row nobody ever claimed (PENDING, attemptRevision 0, no
 *                      document id): the cross-connector orphan sweep, the BILL_PAYMENT supersession,
 *                      and `cancelPendingSalesInvoiceSyncForOrder` for its never-claimed PENDING rows. A
 *                      verified reversal records VERIFIED_REVERSAL.
 *   UNKNOWN            REFUSES (`unresolved`). A CLAIMED attempt that was cancelled without proof: the
 *                      sale-cancel sweep over a FAILED / PROCESSING / retried-PENDING row, the post-time
 *                      retirement of a claimed row, the capacity refusal, mark-handled.
 *
 * (The cancel-and-requeue remedy `describeCreateDispatchRemedy` prescribes therefore no longer works for a
 * claimed attempt: the operator hand-posts and marks the posting handled.)
 *
 * ONE CANCELLED ROW IS DIFFERENT: the NOT_POSTED settlement (CANCELLED + OPERATOR_ASSERTION, no id).
 * It used to be the way to re-queue work: "the operator looked, nothing posted, free the slot".
 * C1: an operator's word about a ledger IMS never read is not proof, so the slot is BLOCKED - the
 * enqueue refuses, and the operator hand-posts and marks the posting handled. And a SYNCED row an
 * operator typed a document id into still occupies the slot (the document is claimed to exist) but
 * the suppression is REPORTED, never silent.
 *
 * WHY THIS IS NOT `attemptProvenNeverMade`. That predicate is the canonical "no remote call left this
 * row" test and it is the right one — for the three STAMPED_MONEY_TYPES, which are the only types
 * whose processor writes `remoteAttemptedAt` before the socket. A CREDIT_NOTE or COGS_REVERSAL row
 * carries stamping custody and NO `remoteAttemptedAt` for the whole of its life, so that predicate
 * would answer "proven never made" for every one of them and license exactly the duplicate this
 * module exists to stop. The evidence that generalises across every type is the document id.
 */

/**
 * Statuses a worker can still post from, plus SYNCED.
 *
 * NOT `POSTABLE_ACCOUNTING_SYNC_STATUSES`: that set answers "can a claim still succeed against this
 * row", and it includes FAILED — which is the very status this module refuses to read as live. This
 * one is the unique index's own predicate, restated so the query and the index agree by construction.
 */
export const PRIOR_ATTEMPT_LIVE_STATUSES = WORK_SLOT_STATUSES

/**
 * The columns a verdict is reached from. Selecting fewer would make the verdict unsound, not partial:
 * the whole {@link LedgerStandingRow} is REQUIRED, so a caller that did not load `settlementBasis`
 * fails `tsc` rather than reading an operator's assertion as a connector's answer.
 */
export type PriorAttemptRow = LedgerStandingRow & { id: string }

export type PriorAttemptVerdict =
  /** No row for this key. The enqueue may write one. */
  | { kind: 'none' }
  /**
   * A row OCCUPIES the work slot. The counterpart exists or will. `asserted` is true when EVERY
   * occupant rests on an operator's typed document id: the suppression is then REPORTED (D2).
   */
  | { kind: 'live'; syncLogId: string; asserted: boolean; externalTransactionId: string | null }
  /** A row in some status names a document that exists in the ledger. `asserted`: only an operator says so. */
  | { kind: 'posted'; syncLogId: string; externalTransactionId: string; asserted: boolean }
  /**
   * C1 / D1: an operator settled a prior attempt NOT_POSTED. The slot is BLOCKED - not free, not
   * occupied. The enqueue REFUSES; the operator hand-posts and marks the posting handled. No
   * automatic re-post.
   */
  | { kind: 'blocked'; syncLogId: string }
  /** A FAILED row, or a CANCELLED one with no proof, and no document id: nothing can say whether its attempt landed. */
  | { kind: 'unresolved'; syncLogId: string }

function documentId(row: PriorAttemptRow): string | null {
  const id = row.externalTransactionId?.trim() ?? ''
  return id.length > 0 ? id : null
}

/**
 * The verdict for one idempotency key, from every row that carries it.
 *
 * PRECEDENCE IS DELIBERATE and it is not "first row wins":
 *
 *   1. `live` - a row OCCUPIES the slot (`workSlotStanding`). The ordinary, healthy answer, and the
 *      one the fourteen existing callers already depend on. A connector-backed occupant outranks an
 *      asserted one: the suppression then rests on evidence, and is not flagged.
 *   2. `posted` - no occupant, but a document id exists in some status. The counterpart is there.
 *   3. `blocked` - no occupant and no document, but an operator settled an attempt NOT_POSTED.
 *   4. `unresolved` - a FAILED attempt that cannot be ruled out. Only now does the enqueue refuse for
 *      the older reason.
 *
 * Anything else (a CANCELLED row PROVEN not posted) frees the slot.
 */
export function classifyPriorAttempts(rows: readonly PriorAttemptRow[]): PriorAttemptVerdict {
  const standings = rows.map((row) => ({ row, slot: workSlotStanding(row), id: documentId(row) }))

  const occupants = standings.filter((s) => s.slot.slot === 'OCCUPIED')
  if (occupants.length > 0) {
    const backed = occupants.find((s) => !s.slot.asserted)
    const chosen = backed ?? occupants[0]
    return { kind: 'live', syncLogId: chosen.row.id, asserted: backed === undefined, externalTransactionId: chosen.id }
  }

  const documented = standings.filter((s) => s.id !== null)
  if (documented.length > 0) {
    const backed = documented.find((s) => !s.slot.asserted)
    const chosen = backed ?? documented[0]
    return {
      kind: 'posted',
      syncLogId: chosen.row.id,
      externalTransactionId: chosen.id as string,
      asserted: backed === undefined,
    }
  }

  const blocked = standings.find((s) => s.slot.slot === 'BLOCKED')
  if (blocked) return { kind: 'blocked', syncLogId: blocked.row.id }

  // FAILED, or a CANCELLED row whose standing is UNKNOWN (o3d-f709 / o3d-kj718, Codex HIGH on #724). The
  // partial unique index no longer covers a cancelled row, so nothing else stops a same-key retry
  // writing a SECOND posting beside an attempt that may have reached the ledger. The key is freed ONLY
  // by a row the module calls PROVEN_NOT_POSTED: the orphan sweep, the supersession, and the sale-cancel
  // sweep over a PENDING row nobody ever claimed each stamp `abandonedBeforeRemoteCall` in the same
  // UPDATE; a verified reversal records its basis. A CLAIMED attempt that was cancelled (the sale-cancel
  // sweep over a FAILED or PROCESSING row, the post-time retirement of a claimed row, the capacity
  // refusal, an operator's mark-handled) carries no such proof and is refused here.
  // Read as "the standing is UNKNOWN" (a FAILED row with no id is UNKNOWN by truth-table row 11), not as a
  // status test: LIVE rows returned above, documented rows above that, so what is left and unproven is
  // exactly the terminal attempt nobody can speak for.
  const unresolved = rows.find((row) => ledgerStanding(row) === 'UNKNOWN')
  if (unresolved) return { kind: 'unresolved', syncLogId: unresolved.id }

  return { kind: 'none' }
}

/**
 * The `where` that finds every prior attempt for a key — IN ANY STATUS, which is the fix.
 *
 * Shaped as one exported builder so the three enqueues cannot drift apart: the defect was three
 * copies of one predicate, and three copies of the correction would be the same defect waiting.
 */
export function priorAttemptsWhere(scope: {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  idempotencyKey: string
}): Prisma.AccountingSyncLogWhereInput {
  return {
    connector: scope.connector,
    type: scope.type as Prisma.AccountingSyncLogWhereInput['type'],
    referenceType: scope.referenceType,
    referenceId: scope.referenceId,
    // NO status filter. That absence is the whole change.
    payload: { path: ['_idempotencyKey'], equals: scope.idempotencyKey },
  }
}

/** The columns {@link classifyPriorAttempts} reads, as a Prisma `select`. */
export const PRIOR_ATTEMPT_SELECT = { id: true, ...LEDGER_STANDING_SELECT } as const

/**
 * "A COUNTERPART FOR THIS POSTING EXISTS OR WILL", as a Prisma predicate — the `live` and `posted`
 * arms of {@link classifyPriorAttempts}, and nothing else.
 *
 * For readers that only need the yes/no and cannot act on the third answer. The WooCommerce held-
 * invoice release is the one: it enqueues, then looks for the row to confirm the enqueue really
 * wrote something, and a predicate NARROWER than the enqueue's own short-circuit would report
 * "nothing was queued" about a row the enqueue had just deduped against — stranding a held invoice
 * for ever. The two are pinned together by a test rather than by this comment.
 *
 * POSITIVE ARMS ONLY, deliberately: `NOT (status = $1 AND ...)` is NULL for a NULL column and would
 * silently drop rows. Both arms here are `IS NOT NULL` / `IN`, which have no three-valued surprise.
 */
export const PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR: NonNullable<Prisma.AccountingSyncLogWhereInput['OR']> = [
  { status: { in: [...PRIOR_ATTEMPT_LIVE_STATUSES] } },
  // The empty-string arm matches `classifyPriorAttempts`, which trims before believing an id. The
  // `not: null` conjunct comes first so the second is only ever evaluated on a non-null column.
  { AND: [{ externalTransactionId: { not: null } }, { externalTransactionId: { not: '' } }] },
]

/**
 * What an operator is told when an enqueue refuses because a prior attempt cannot be ruled out.
 *
 * It names the ROW, because the remedy acts on that row and not on the document the caller was
 * trying to queue: an operator sent to "re-run the refund retry" would come straight back here.
 */
export function describeUnresolvedPriorAttempt(params: {
  type: string
  referenceType: string
  referenceId: string
  syncLogId: string
}): string {
  return `NOTHING WAS QUEUED. A previous ${params.type} attempt for ${params.referenceType} `
    + `${params.referenceId} (sync row ${params.syncLogId}) FAILED, or was cancelled without proof that it never `
    + 'reached the accounting system, and recorded no document id, so '
    + 'IMS cannot tell whether it reached the accounting system — the remote call is made before its '
    + 'result is written back, so a failure does not prove nothing posted. Queueing this posting again '
    + 'would create a SECOND document if the first one landed. REMEDY: resolve that row on /sync — '
    + 'retry it, or record its document id with the per-row settlement action if the document is '
    + 'already in the ledger. This posting is still outstanding until you do.'
}

/**
 * What is REPORTED when an enqueue is suppressed because a row an OPERATOR typed a document id into
 * occupies (or names) the posting (D2). The suppression is right - the document is claimed to exist -
 * but it must never be silent: IMS has not seen that document, and if the typed id is wrong the
 * posting is simply never made.
 */
export function describeAssertedPriorAttempt(params: {
  type: string
  referenceType: string
  referenceId: string
  syncLogId: string
  externalTransactionId?: string
}): string {
  return `NOTHING WAS QUEUED, ON AN OPERATOR'S WORD. A ${params.type} for ${params.referenceType} `
    + `${params.referenceId} was not raised because sync row ${params.syncLogId} was settled by an operator as `
    + `posted${params.externalTransactionId ? ` (document ${params.externalTransactionId})` : ''} - a document id typed in `
    + 'by hand, which IMS never saw in the accounting system. Raising it again could post a second document if '
    + 'the operator is right; not raising it leaves the posting missing if they are wrong. Open that document in '
    + 'the accounting system and confirm it exists.'
}

/**
 * What an operator is told when an enqueue REFUSES because a prior attempt was settled NOT_POSTED
 * (C1, D1). It names the ROW and states the remedy, which is NOT "settle it again" and NOT "re-queue":
 * IMS will not send this posting again on an operator's word.
 */
export function describeBlockedPriorAttempt(params: {
  type: string
  referenceType: string
  referenceId: string
  syncLogId: string
}): string {
  return `NOTHING WAS QUEUED. A previous ${params.type} attempt for ${params.referenceType} ${params.referenceId} `
    + `(sync row ${params.syncLogId}) was settled by an operator as "not posted". That is a person's word about an `
    + 'accounting system IMS never read - a lost response, a late webhook or a hand-posted document would leave the '
    + 'same row - so IMS will not post this again on the strength of it, and posting again could create a SECOND '
    + 'document. REMEDY: open the accounting system. If the document is there, nothing more is owed. If it is not, '
    + 'post it there by hand and mark this posting handled in the refusal inbox. This posting is still outstanding '
    + 'until you do.'
}

/**
 * IS THIS P2002 THE IDEMPOTENCY INDEX SAYING A CONCURRENT ENQUEUE GOT THERE FIRST?
 *
 * A SEPARATE DEFECT, FOUND BY THE o3d-d0pd CONCURRENCY PROBE, ON THE SAME THREE LINES. All three
 * enqueues end with
 *
 *     if (String(error).includes('accounting_sync_logs_idempotency_key_uq')) return { queued: true }
 *
 * and that condition has never once been true under the driver adapter this build uses. o3d-5od
 * established it and lib/db/prisma-unique-violation.ts documents it from a live probe: `@prisma/
 * adapter-pg` reports a P2002 as a COLUMN LIST (`meta.driverAdapterError.cause.constraint.fields`)
 * and populates neither `meta.target` nor the index name anywhere `String(error)` can see it. The
 * message the caller gets is "Unique constraint failed on the fields: (`connector`, `type`, …)".
 *
 * So the handler for "another writer queued this posting a millisecond ago" was dead code, and two
 * concurrent enqueues for one key threw a raw P2002 out of the enqueue instead of reporting the
 * counterpart that demonstrably exists. Safe — nothing duplicates — but it turns an ordinary race
 * into a failed refund retry, and it made the enqueue's own comment ("already present") untrue.
 *
 * THE DISCRIMINATOR IS `_idempotencyKey`. `accounting_sync_logs` carries two partial unique indexes
 * and only this one mentions that path: `accounting_sync_logs_followup_live_unique` is expressed
 * over `accountingInvoiceId` / `creditNoteId` / `paymentId`. The index NAME is still matched as a
 * fallback, so this keeps working if the adapter is swapped back for the query engine — which is
 * exactly the case the dead condition was written for.
 */
export function isIdempotencyKeyIndexCollision(error: unknown): boolean {
  const names = uniqueConstraintFields(error)
  if (!names) return false
  return names.some((name) =>
    name.includes('_idempotencyKey') || name === 'accounting_sync_logs_idempotency_key_uq')
}
