import type { Prisma } from '@/app/generated/prisma/client'
import { uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'

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
 * WHY CANCELLED IS NOT A BLOCKER (unless it carries a document id). CANCELLED is this codebase's own
 * assertion that nothing was sent — `classifyRegisteredPayment` says so in as many words, and the
 * NOT_POSTED settlement moves a row there precisely so that it LEAVES the partial unique indexes.
 * `describeCreateDispatchRemedy` then prescribes "cancel this row and re-queue the work from the
 * source document, which raises a new row with no dispatch on record". Treating CANCELLED as a
 * blocker would delete that remedy, which is the only exit some rows have.
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
export const PRIOR_ATTEMPT_LIVE_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

/** The columns a verdict is reached from. Selecting fewer would make the verdict unsound, not partial. */
export type PriorAttemptRow = {
  id: string
  status: string
  externalTransactionId: string | null
}

export type PriorAttemptVerdict =
  /** No row for this key. The enqueue may write one. */
  | { kind: 'none' }
  /** A row is on the queue. The counterpart exists or will. */
  | { kind: 'live'; syncLogId: string }
  /** A row in some status names a document that exists in the ledger. */
  | { kind: 'posted'; syncLogId: string; externalTransactionId: string }
  /** A terminal row with no document id: nothing can say whether its attempt landed. */
  | { kind: 'unresolved'; syncLogId: string }

function documentId(row: PriorAttemptRow): string | null {
  const id = row.externalTransactionId?.trim() ?? ''
  return id.length > 0 ? id : null
}

function isLive(row: PriorAttemptRow): boolean {
  return (PRIOR_ATTEMPT_LIVE_STATUSES as readonly string[]).includes(row.status)
}

/**
 * The verdict for one idempotency key, from every row that carries it.
 *
 * PRECEDENCE IS DELIBERATE and it is not "first row wins":
 *
 *   1. `live` — a standing row is the ordinary, healthy answer, and it is the one the fourteen
 *      existing callers already depend on. A live row beside a failed one means the work IS queued.
 *   2. `posted` — no live row, but a document exists. The counterpart is there.
 *   3. `unresolved` — no live row and no document id, but a terminal attempt that cannot be ruled
 *      out. Only now does the enqueue refuse.
 *
 * Anything else (CANCELLED with no document id) is not a blocker at all — see the header.
 */
export function classifyPriorAttempts(rows: readonly PriorAttemptRow[]): PriorAttemptVerdict {
  const live = rows.find((row) => isLive(row))
  if (live) return { kind: 'live', syncLogId: live.id }

  for (const row of rows) {
    const id = documentId(row)
    if (id) return { kind: 'posted', syncLogId: row.id, externalTransactionId: id }
  }

  // FAILED only. CANCELLED asserts nothing was sent, so it is not one of these.
  const unresolved = rows.find((row) => row.status === 'FAILED')
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
export const PRIOR_ATTEMPT_SELECT = { id: true, status: true, externalTransactionId: true } as const

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
    + `${params.referenceId} (sync row ${params.syncLogId}) FAILED without recording a document id, so `
    + 'IMS cannot tell whether it reached the accounting system — the remote call is made before its '
    + 'result is written back, so a failure does not prove nothing posted. Queueing this posting again '
    + 'would create a SECOND document if the first one landed. REMEDY: resolve that row on /sync — '
    + 'retry it, or record its document id with the per-row settlement action if the document is '
    + 'already in the ledger. This posting is still outstanding until you do.'
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
