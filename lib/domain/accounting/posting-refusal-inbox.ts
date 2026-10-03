import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { withSavepoint } from '@/lib/db/savepoint'
import type { PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'
import { accountingPostingKeyForRow } from '@/lib/accounting/posting-key'
import { accountingSyncRowCanPostOrHasPosted } from '@/lib/domain/accounting/postable-sync-statuses'
import { recordHandPostDeferral, runUnderPostingKeyLock, type PostingKeyLockClient, type PostingSuppressionClient } from '@/lib/domain/accounting/posting-suppression'
import { enqueueProvisionalPostingRefusal } from '@/lib/domain/accounting/posting-refusal-provisional'
import type { IntegrationOutboxClient } from '@/lib/domain/integrations/outbox'

/**
 * o3d-j625 r10 — THE DEFERRED PATH IS NOT A CAPABILITY A REAL CLIENT CAN LACK.
 *
 * `enqueueProvisionalPostingRefusal` is reached only from inside a caller's TRANSACTION (the contended
 * branch is unreachable otherwise), and it writes through that same transaction client. This is the proof
 * — checked by `tsc`, costing nothing at runtime — that such a client can always make that write, so the
 * deferral can never quietly degrade back into r9's discard. It is the same shape as
 * `PrismaClientCanAlwaysReadTheSuppression` in posting-suppression.ts, and for the same reason.
 */
type AssertTrue<T extends true> = T
export type PrismaClientCanAlwaysHoldAProvisionalRefusal = AssertTrue<
  Prisma.TransactionClient extends IntegrationOutboxClient ? true : false
>

/**
 * o3d-j625 r4/r5 — A REFUSED POSTING IS OUTSTANDING WORK, NOT A LOG LINE.
 *
 * Rounds 2-4 taught the accounting enqueues to REFUSE rather than write a row into books that cannot
 * describe it, and reported every refusal to the Activity log. That is the right decision and the wrong
 * surface: the Activity page is a thing somebody has to already be looking at, and the refusals that
 * matter most are the ones nobody is looking for. The WooCommerce held-invoice release is the case that
 * settled it — it refuses days after the order imported, on a sweep, with no operator present.
 *
 * So each refusal upserts a row in `AccountingPostingRefusal`, which the exception inbox — the surface
 * that already exists for "work IMS owes and nothing will re-drive" — lists beside the follow-up
 * obligations it already shows. Deliberately NOT a new UI surface.
 *
 * WHY A ROW AND NOT A QUERY. Every other inbox section selects rows some writer already persists. A
 * refusal persists NOTHING by construction: refusing is exactly the decision not to write the row. There
 * is no existing table to select from, so the durable record has to be created; this is that record.
 *
 * ── o3d-j625 r5, the three things the independent review found wrong with r4's version ──
 *
 * 1. THE KEY IS NOW DERIVED FROM THE ENQUEUE'S OWN PARAMS ({@link accountingPostingKey}), never re-typed
 *    at the reporting site. r4's hand-written keys disagreed with the clear at three sites: one row could
 *    never clear, one shared a key with a DIFFERENT posting (so a successful PO cancellation stamped
 *    `resolvedAt` over a supplier-return reversal that was never written), and payments were keyed per
 *    document where the obligation is per RECEIPT. Both this writer and the clear take a key produced by
 *    that one function, so a row cannot be recorded under a key its own clear will not match.
 *
 * 2. A RE-REFUSAL AFTER A RESOLUTION IS A NEW EPISODE (review M-13). The schema says `firstRefusedAt` is
 *    when the gap opened; reopening a resolved row kept the FIRST episode's timestamp and carried its
 *    count forward, so the inbox aged a fresh debt from a gap that had already been closed. A resolved row
 *    is therefore reset before the upsert increments it.
 *
 * 3. THE IN-TRANSACTION WRITES RUN IN A SAVEPOINT (review M-14, in practice a HIGH). A failed statement
 *    inside a Postgres transaction aborts it (25P02) whatever the client does with the error, so
 *    swallowing an exception here did NOT protect the caller: every later write in a goods receipt, a bill
 *    or an MO completion would fail and the whole thing would roll back with an opaque error. The most
 *    plausible trigger is code deployed ahead of `migrate deploy`. Wrapped in a savepoint, a failure here
 *    rolls back to the savepoint and the caller's transaction stays committable — which is what "must not
 *    turn it into an exception on the caller's path" has to mean to be true of EFFECT and not just of
 *    `throw`.
 *
 * 4. A FAILED WRITE IS ITSELF REPORTED (review L-1). Swallowing silently meant the one case where the
 *    inbox row is missing is also the case nobody is told about.
 */

/** The Prisma surface these helpers need. Structural, so a transaction client or a double satisfies it. */
export type PostingRefusalClient = {
  accountingPostingRefusal: {
    upsert(args: {
      where: { type_referenceType_referenceId_scope: { type: string; referenceType: string; referenceId: string; scope: string } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }): Promise<unknown>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
    /**
     * o3d-j625 r7: read to honour a suppression (a posting marked handled). Optional for older doubles.
     *
     * o3d-j625 r9: and the RESOLUTION, so a refusal that lost a race with the posting being queued can
     * see that it did. Read under the posting key's lock; a real client can always read it
     * (`PrismaClientCanAlwaysReadTheSuppression`, checked by tsc).
     */
    findUnique?(args: {
      where: { type_referenceType_referenceId_scope: PostingRefusalKey }
      /**
       * o3d-j625 r26: and WHO IS SETTLING IT BY HAND, for the clear's decline path. Optional like the two
       * above, so a structural double that selects only what it needs keeps compiling.
       */
      select: { suppressedAt: true; resolvedBy: true; resolvedAt?: true; resolution?: true; handPostClaimedAt?: true; handPostClaimedBy?: true }
    }): Promise<{
      suppressedAt: Date | null; resolvedBy: string | null; resolvedAt?: Date | null; resolution?: string | null
      handPostClaimedAt?: Date | null; handPostClaimedBy?: string | null
    } | null>
  }
  /**
   * o3d-j625 r9 — THE ACCOUNTING SYNC LOG, the only durable trace a FIRST enqueue of a posting leaves.
   *
   * A refusal racing the FIRST successful enqueue of a posting has no resolved row to learn from: the
   * enqueue's clear matched nothing, because no refusal row existed yet. The evidence that the posting is
   * nonetheless queued is the sync row itself. Optional, so a structural double is unchanged — and never
   * read as a blanket "a row exists, so nothing is owed" (see the header).
   *
   * o3d-j625 r11: read for the ROW IDS as much as for the rows. A sync row's id exists only if the
   * transaction that inserted it committed, so a row id that was not there when this refusal was shut out
   * of the posting key IS the enqueue saying, in its own writing, that it happened.
   */
  /**
   * Typed `unknown` and narrowed at runtime on purpose: the clients passed here carry a dozen different
   * shapes of this delegate (a create-only double, a full Prisma client, a narrowed transaction alias),
   * and an all-optional structural type would reject every one of them under TypeScript's weak-type
   * check. What the code needs is asked of the value, which is what it has to do anyway.
   */
  accountingSyncLog?: unknown
}

type SyncLogReader = {
  findMany?(args: {
    where: Record<string, unknown>
    select: { id: true; payload: true; status: true; settlementBasis: true; externalTransactionId: true; abandonedBeforeRemoteCall: true }
  }): Promise<Array<{
    id: string; payload: unknown
    // o3d-1e7sl: the columns the ledger-standing module needs to say whether a row is a posting that
    // can still post / has posted (`live`) or a retired one.
    status: string; settlementBasis: string | null; externalTransactionId: string | null
    abandonedBeforeRemoteCall: boolean | null
  }>>
}

/** The key of the posting a row is about — produced by `accountingPostingKey` in lib/accounting.ts. */
export type PostingRefusalKey = { type: string; referenceType: string; referenceId: string; scope: string }

export type AccountingPostingRefusalRecord = {
  /**
   * o3d-j625 r6 (review H4) — WHICH SITE REFUSED, from the closed set in posting-refusal-kinds.ts. Required,
   * so a new refusal site cannot compile without saying whether its row clears itself or is marked handled.
   * `null` only where the enqueue itself records and no kind is defined for the posting — never markable.
   */
  kind: PostingRefusalKind | null
  /** Whose chart of accounts the refused payload was built from; `null` = nothing was switched on. */
  chartConnector: string | null
  /** What was active at the moment of refusal — the half round 2's warning left out. */
  activeConnector: string | null
  /** A machine code for what was refused. */
  reason: string
  /** What stands in IMS regardless — the thing the ledger now disagrees with. */
  committed: string
  /** What the operator has to do; nothing retries these on its own. */
  remedy: string
  detail?: Record<string, unknown>
}

export type RecordRefusalOptions = {
  /**
   * o3d-j625 r5 (review M-5) — MERGE, DO NOT COUNT AGAIN.
   *
   * A facade-path refusal is written twice: once by the enqueue, which knows the specific reason, and once
   * by the caller reporting it, which knows what stands in IMS and the remedy. r4 let the second write
   * increment the attempt count and overwrite the specific reason with a generic `refused`. With this set,
   * the second write fills in what only the caller knows and leaves the count and the reason alone.
   */
  mergeOnly?: boolean
  /**
   * A savepoint wrapper, supplied when the client is a CALLER'S TRANSACTION. See point 3 above: without it
   * a failure here aborts the caller's transaction whatever this module does with the exception.
   *
   * o3d-j625 r9: it is also the CONTRACT that says this client is inside a transaction, which decides
   * whether this module may WAIT for the posting key's lock. See `runUnderPostingKeyLock`.
   */
  withSavepoint?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * o3d-j625 r9 — WHEN THE REFUSAL WAS DECIDED, not when it is being written. The enqueue funnels pass the
   * moment the enqueue began; every other site gets the moment this call began.
   *
   * o3d-j625 r12 — AND IT IS NO LONGER COMPARED WITH ANYTHING. It was, until Codex round 11's HIGH 2: this
   * is one IMS process's clock and every candidate to compare it against (`accounting_sync_logs.createdAt`,
   * `AccountingPostingRefusal.resolvedAt`) is ANOTHER process's, so the comparison ordered clocks and not
   * events. What it is still for is the PROVISIONAL CLAIM: it identifies the claim
   * (`provisionalIdempotencyKey`), it is replayed verbatim so a retry describes the same decision rather
   * than a new one, and the exception inbox ages an unreconciled claim from it. Nothing reads it to decide
   * whether a debt is owed — see the evidence block below.
   */
  decidedAt?: Date
  /**
   * o3d-j625 r11 (Codex round 10, HIGH 1), r12 (Codex round 11) — WHICH ROWS THIS POSTING KEY ALREADY HAD
   * WHEN THIS REFUSAL WAS SHUT OUT OF IT. The baseline, not a flag — and since r12 the ONLY evidence that
   * discharges a refusal.
   *
   * Set only by `reconcileProvisionalPostingRefusals`, replaying a refusal whose in-transaction call could
   * not take the key. By the time the replay runs that transaction has ended and the key is free, so the
   * replay cannot observe the race it is recovering from; the claim carries the observation forward.
   *
   * r10 carried a BOOLEAN here (`contendedWhenDecided`), and under it the replay treated ANY live sync row
   * for the key as proof that the contending transaction had queued the posting. Successive edits of one
   * invoice share a posting key (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT), so edit 1's
   * row — live for ever — discharged a refusal whose lock holder had ROLLED BACK and queued nothing. The
   * debt then existed and nothing listed it. Contention says another transaction was settling this
   * posting; it says nothing about WHAT it did, and only what it WROTE can.
   *
   * IT COVERS EVERY ROW FOR THE KEY, WHATEVER ITS STATUS (r12). r11 observed only the LIVE rows, so a
   * CANCELLED row was missing from the baseline — and `releaseRetiredAccountingSyncRowForLiveSale`
   * (o3d-psvi) puts such a row back in front of the connector UNDER ITS ORIGINAL ID, which then satisfied
   * "a live row the baseline had not seen". A release is not an enqueue, and the baseline now knows it.
   *
   * THREE VALUES, and the difference between the last two is the r11 fix:
   *   • `undefined` — either this call was never shut out of the key, or the claim is a LEGACY one written
   *     before this field existed. Either way there is no moment this refusal can point at, so nothing
   *     discharges it and the debt is kept.
   *   • `null` — it was shut out and the observation could not be made. "I cannot tell", never "nothing
   *     was there": the identity comparison is abstained from and the refusal is RECORDED.
   *   • an evidence object — the ids the key already had at that moment. A LIVE row that is NOT among them
   *     was written by a transaction that committed after this refusal was shut out, which is the enqueue's
   *     own evidence that it happened.
   */
  queuedWhenShutOut?: QueuedPostingEvidence | null
}

/**
 * Why nothing was written. Every value is something the operator is TOLD, never a silent no-op.
 *
 * `contended` is a refusal to guess rather than a failure: another transaction is settling this exact
 * posting, and this caller — inside its own transaction — may not wait for it (see the deadlock note in
 * posting-suppression.ts). Since r10 it is also not a LOSS: `deferred` says the refusal was persisted in
 * the caller's transaction as a provisional claim for `reconcileProvisionalPostingRefusals` to replay.
 *
 * `failed` is the write that did not land at all (review L-1 reports it; M-14 contains it). It is
 * returned rather than swallowed so a CALLER THAT CAN RETRY — the reconciler — can tell "nothing is owed"
 * from "nothing was written", which are the same silence from the outside.
 */
export type RefusalRecordOutcome =
  | { recorded: true }
  | { recorded: false; because: 'suppressed' | 'queued'; at: Date }
  | { recorded: false; because: 'contended'; deferred: boolean }
  | { recorded: false; because: 'failed' }

/**
 * o3d-j625 r30 (Codex round 29, HIGH 1) — READ THIS BEFORE PUBLISHING ANYTHING COMPUTED INSIDE `write`.
 *
 * This wrapper SWALLOWS the error and lets the caller carry on. That is deliberate (review L-1): an inbox
 * tidy-up must not become the posting's exception, and a failure is reported at ERROR instead. But it makes a
 * specific hazard available to every caller, and that hazard has now been reached TWICE, in two different
 * shapes:
 *
 *   r10, on the `recording` path: the outcome holder started at an OPTIMISTIC value, so a write that threw
 *        was reported to the caller as `recorded`. Fixed by making the initializer pessimistic (`failed`).
 *   r30, on the `clearing` path: the holder started SAFE, but the reportable value was assigned into it from
 *        INSIDE the transaction, before the write it asserts and before the commit. A rollback does not undo a
 *        JavaScript assignment, and the swallowed error meant nothing else told the caller — so a decline was
 *        published for a postponement that had rolled back.
 *
 * THE RULE BOTH FIXES OBEY, and the one to keep: whatever this function's caller publishes must be the value
 * `write` RETURNED, taken after `guarded` has returned — never a value assigned into an outer variable from
 * inside the transaction. Then a throw or a failed commit means nothing was published at all, which is the
 * only version of this that is safe by construction rather than by inspection.
 *
 * AUDITED, r30: those are the only two call sites, and both now obey the rule. There is nothing to file.
 */
async function guarded(
  what: string,
  key: PostingRefusalKey,
  options: RecordRefusalOptions | undefined,
  write: () => Promise<void>,
): Promise<void> {
  try {
    if (options?.withSavepoint) await options.withSavepoint(write)
    else await write()
  } catch (error) {
    // review L-1: the one case where the inbox row is missing must not also be the case nobody is told
    // about. Reported, never rethrown — the refusal itself has already been decided.
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_posting_refusal_not_recorded',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `IMS refused an accounting posting and could not record it as outstanding work (${what}). The `
        + `refusal itself stands and is in the accounting activity log, but the exception inbox will NOT `
        + `list it: ${key.type} for ${key.referenceType} ${key.referenceId}. Cause: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { ...key, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => { /* nothing else to try */ })
  }
}

/**
 * ── o3d-j625 r12 (Codex round 11, both HIGHs) — WHAT COUNTS AS EVIDENCE THAT A POSTING WAS QUEUED ──
 *
 * r11 asked the right question — "did an enqueue leave, in its own writing, something that was not there
 * before" — and then kept two answers beside it that are not that: `resolvedAt`/`queued` on the refusal
 * row, and `createdAt` later than `decidedAt`. Codex executed both, and they are the same defect in two
 * places: A STATE THAT LOOKS SETTLED WAS BEING TREATED AS PROOF THAT THE DEBT WAS DISCHARGED.
 *
 *   • A CANCELLED ROW IS NOT A POSTED ROW (HIGH 1). `resolvedAt`/`queued` records that an enqueue once
 *     happened. It survives the row that enqueue wrote being cancelled before it could post — by the
 *     capacity guard, by a payment being deleted, by an operator settling it NOT_POSTED — and it
 *     short-circuited AHEAD of every liveness check, so a refusal decided before that enqueue was settled
 *     on replay while the posting was owed and no row existed to make it.
 *   • A LATER TIMESTAMP IS NOT A LATER EVENT (HIGH 2). `createdAt` is stamped by whichever IMS process
 *     performed the INSERT (Prisma supplies `@default(now())` in the client, at the INSERT — r11 measured
 *     this) and `decidedAt` by whichever decided the refusal. Nothing here establishes they are the same
 *     process, and the comparison is only sound if they are: an older row written by a process whose clock
 *     runs ahead reads as later than a genuine refusal elsewhere, and discharged it. Even ONE process is
 *     not enough — `Date.now()` is a WALL clock, so an NTP step between the decision and the insert
 *     reverses them without any second process at all.
 *
 * SO THERE IS NOW EXACTLY ONE WAY A REFUSAL IS SUPERSEDED BY A POSTING, AND IT IS AN IDENTITY:
 *
 *   A LIVE ROW FOR THIS POSTING KEY WHOSE ID IS NOT IN A BASELINE THIS REFUSAL ITSELF OBSERVED at a
 *   moment it knows to precede the event in question — the instant the posting key was refused to it,
 *   before the transaction holding the key could commit ({@link RecordRefusalOptions.queuedWhenShutOut}).
 *
 * A row id exists only if the transaction that inserted it committed, and a row that was already there
 * when this refusal looked was not inserted by that transaction. Nothing in that sentence is a clock, and
 * nothing in it is satisfied by a row that cannot post.
 *
 * WHY NO ORDERING ARM SURVIVES, stated plainly because it COSTS something and the cost is the safe
 * direction. r9's residual — an enqueue that both started and committed in the gap before an UNCONTENDED
 * refusal took the key — is real, and this module can no longer tell it from a refusal that is genuinely
 * owed. The only evidence that would tell them apart is an ordering of two events that were recorded
 * independently, and the three candidates available here are all wall clocks: `createdAt`, `resolvedAt`,
 * and `decidedAt` itself. A monotonic source that held ACROSS INSTANCES would have to be the database's own
 * (a sequence, or a commit-time column), which neither the sync row nor the refusal carries — that is a
 * migration and a watermark read at every decision site, not a comparison. Until it exists, the honest
 * answer to "I cannot tell" is the one the rest of this module already gives: KEEP THE DEBT. The inbox's
 * failure mode is SILENCE, so a debt listed that was in fact discharged is a row an operator can read and
 * close, while a debt discharged that was owed is a posting nobody will ever make. And the false-debt
 * direction is not unguarded, and o3d-j625 r16 is where that guarding actually became true. Two things
 * stand between a kept false debt and a second ledger entry:
 *   · the remedy is an ACT, not a sentence. An operator TAKES the posting for hand posting
 *     (`claimPostingForHandPosting`) before going to the ledger; that transaction cancels every provably
 *     unsent row under the key, refuses if any row may already have been sent, and makes every enqueue of
 *     the posting refuse for as long as the claim is held. Round 15's HIGH 1 was that the previous answer —
 *     an inverted INSTRUCTION — left the whole interval between reading the page and posting unguarded.
 *   · a row that could not post THIS posting no longer blocks it. On the three types whose key successive
 *     postings share, a COMPLETED row posted an earlier edit; round 15's HIGH 2 was that it made the remedy
 *     refuse for ever, so the debt was kept AND unclosable. See `accountingSyncRowPostedAnEarlierPosting`.
 *
 * WHAT IS DELIBERATELY *NOT* EVIDENCE, and the "what would still pass it" question for each:
 *   • a live sync row on its own — several types share one key across successive postings by design
 *     (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT), so edit 1's row is live for ever and
 *     would discharge every later refusal (r11's HIGH 1 from round 10);
 *   • `resolvedAt`/`queued` on the refusal row — it outlives the row it was written for (this round);
 *   • any comparison of two timestamps — see above (this round);
 *   • a CANCELLED row that is later RELEASED back to the connector
 *     (`releaseRetiredAccountingSyncRowForLiveSale`, o3d-psvi) — the same row, the same id, so the
 *     baseline must know it. That is why the baseline covers EVERY row for the key whatever its status and
 *     the comparison covers the LIVE ones: r11 excluded cancelled rows from both, and a released row was
 *     then absent from the baseline and present in the comparison, i.e. indistinguishable from a new
 *     enqueue.
 */

/**
 * The ids of the sync rows for one posting key: `live` = everything that is not CANCELLED, i.e. the
 * postings that are queued or posted; `every` = every row there has ever been, which is what a BASELINE
 * needs (see the release case above — a row can come back from CANCELLED under its original id).
 *
 * Scoped the same way the mark scopes its candidates (posting-mark-handled.ts): the indexed columns narrow
 * it, and `accountingPostingKeyForRow` — the same function the row-creating primitive keys its clear on —
 * decides whether a row belongs to this posting or to a different one sharing the document. `null` when
 * the client cannot answer (a structural double), which records the refusal as before.
 */
async function readPostingRowIdsForKey(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  statuses: 'live' | 'every',
): Promise<string[] | null> {
  // The delegate is never bound to a local: tests/accounting/sync-log-row-primitive.test.ts reports any
  // such binding, because a `.create` reached through one is invisible to it. Every use of it here is
  // visible at the access site, and all of them are reads.
  const reader = client as { accountingSyncLog?: SyncLogReader }
  if (typeof reader.accountingSyncLog?.findMany !== 'function') return null
  const rows = await reader.accountingSyncLog.findMany({
    where: {
      type: key.type,
      referenceType: key.referenceType,
      referenceId: key.referenceId,
    },
    // EVERY row is read and `live` is decided in TypeScript through `accountingSyncRowCanPostOrHasPosted`
    // (o3d-1e7sl), not by `status: { not: 'CANCELLED' }`: a CANCELLED row is not a queued posting - and it
    // IS part of a baseline, because it can be put back in front of the connector under the same id.
    select: { id: true, payload: true, status: true, settlementBasis: true, externalTransactionId: true, abandonedBeforeRemoteCall: true },
  })
  return rows
    .filter((row) => statuses === 'every' || accountingSyncRowCanPostOrHasPosted(row))
    .filter((row) => accountingPostingKeyForRow({ ...key, payload: row.payload }).scope === key.scope)
    .filter((row) => typeof row.id === 'string')
    .map((row) => row.id)
}

/**
 * DOES THIS TRANSACTION SEE EVERY ROW COMMITTED BEFORE NOW? (o3d-j625 r12)
 *
 * The baseline's whole meaning rests on it. "This id was not there when I looked" is evidence that the row
 * was inserted AFTERWARDS only if the look could see everything already committed. READ COMMITTED takes a
 * fresh snapshot per statement and does. REPEATABLE READ and SERIALIZABLE take ONE snapshot, at the
 * transaction's first statement, so a row committed after that is invisible to the baseline read and would
 * later read as NEW — a false discharge, which is the failure this round exists to remove.
 *
 * Today no refusal is recorded from such a transaction: the cluster default is read committed and the only
 * `isolationLevel` in lib/ or app/ is the SERIALIZABLE on-hand replay in
 * lib/domain/inventory/get-on-hand-as-of.ts, which is read-only and records nothing. That is a CENSUS, and
 * a census is a fact about today that a future edit breaks silently — so the transaction is ASKED instead.
 * Anything other than read committed, or an answer that cannot be read at all, abstains: the observation
 * comes back as `null` ("I cannot tell"), which keeps the debt.
 */
async function seesEveryCommittedRow(client: PostingKeyLockClient): Promise<boolean> {
  if (typeof client.$queryRaw !== 'function') return false
  // Parameterless, so this module stays off the runtime-assembled-SQL inventory
  // (tests/accounting/plugin-selection-lock), like every other raw statement on this path.
  const rows = await client.$queryRaw`SELECT current_setting('transaction_isolation') AS level` as Array<{ level?: unknown }> | undefined
  const level = rows?.[0]?.level
  return typeof level === 'string' && level.toLowerCase() === 'read committed'
}

/** The postings that are queued or posted for this key right now. */
export const readLiveQueuedPostings = (client: PostingRefusalClient, key: PostingRefusalKey) =>
  readPostingRowIdsForKey(client, key, 'live')

/** Every row this key has, whatever its status — what a baseline must know about. */
export const readEveryPostingRowForKey = (client: PostingRefusalClient, key: PostingRefusalKey) =>
  readPostingRowIdsForKey(client, key, 'every')

/**
 * THE ROWS THIS KEY ALREADY HAD, AS IDENTITIES — the baseline a refusal that was refused the posting key
 * takes, so that later, holding the key, it can tell a NEW enqueue from an old one.
 *
 * `complete` is not decoration. The list is carried in a provisional claim's payload, so it is capped; a
 * key with more rows than the cap yields `complete: false` and the identity comparison ABSTAINS, which
 * records the refusal — keeping a debt that may not be owed rather than losing one that is. Reading it as
 * "nothing changed" would be the failure mode this round exists to remove, one cap away.
 */
export type QueuedPostingEvidence = {
  /** Sorted, so two observations of the same state are equal however the rows came back. */
  ids: string[]
  complete: boolean
}

/**
 * How many sync-row ids a baseline may carry. A document-scoped posting has one row; the
 * idempotency-keyed types have a handful. This is a bound on the CLAIM PAYLOAD, not an expectation.
 */
const QUEUED_POSTING_EVIDENCE_LIMIT = 200

export function queuedPostingEvidenceOf(ids: string[]): QueuedPostingEvidence {
  const sorted = [...ids].sort()
  return sorted.length > QUEUED_POSTING_EVIDENCE_LIMIT
    ? { ids: [], complete: false }
    : { ids: sorted, complete: true }
}

/**
 * Did an enqueue commit for this posting while this refusal was shut out of its key?
 *
 * UNIVERSAL, not existential: every live row must be one the baseline already knew about for the answer
 * to be "no". An unreadable or over-long baseline answers "no" as well — see `complete` above — and the
 * refusal is then recorded.
 */
function aPostingWasQueuedSinceTheBaseline(
  baseline: QueuedPostingEvidence,
  live: string[],
): boolean {
  if (!baseline.complete) return false
  const known = new Set(baseline.ids)
  return live.some((id) => !known.has(id))
}

/**
 * ONE ARM, AND IT IS AN IDENTITY (see the block above for why there is no second one).
 *
 * `undefined` means this refusal was never shut out of the key, so there is no baseline and no moment it
 * can point at and say "the posting was not queued then"; `null` means it was shut out and could not look,
 * which is "I cannot tell", never "nothing was there". Both keep the debt.
 */
async function postingSupersedesThisRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  options: { queuedWhenShutOut: QueuedPostingEvidence | null | undefined },
): Promise<boolean> {
  const live = await readLiveQueuedPostings(client, key)
  // No live row at all: nothing is queued and nothing will post, whatever any row or column once said.
  if (live === null || live.length === 0) return false
  if (!options.queuedWhenShutOut) return false
  return aPostingWasQueuedSinceTheBaseline(options.queuedWhenShutOut, live)
}

/**
 * Record a refused posting as outstanding.
 *
 * Re-refusing REOPENS the row rather than leaving a resolved one behind: the posting is owed again, and a
 * row that says otherwise because it was once cleared is the silence this table exists to end.
 *
 * ── o3d-j625 r9 (Codex HIGH) — AND IT IS SERIALISED WITH THE MARK AND WITH THE CLEAR ──
 *
 * r7 read `suppressedAt` here and took no lock, which made the read a guess with a window behind it:
 *
 *   read (not suppressed) → `markPostingHandled` commits → upsert
 *
 * left the row OUTSTANDING with `suppressedAt` still set, so the exception inbox listed a posting an
 * operator had already posted BY HAND as work still owed — and its remedy asks them to post it. The same
 * shape with a successful enqueue instead of a mark (`clearAccountingPostingRefusal` commits between the
 * read and the upsert) leaves a debt that is not owed. r7's comment argued the second half was harmless
 * "because the suppression column is not in the upsert"; that is true of the COLUMN and false of the
 * INBOX, which keys off `resolvedAt`.
 *
 * So the read and the write happen under this posting key's lock, the one the mark and every sync-row
 * creation already take (`runUnderPostingKeyLock`, which also explains why waiting for it is safe from
 * the pool and forbidden inside a caller's transaction). Under it, three things are checked:
 *
 *   1. SUPPRESSED — a posting marked handled stays handled. Reported, never recorded, and the write
 *      itself refuses suppressed rows (`suppressedAt: null` in its predicate), so this does not rest on
 *      the read alone.
 *   2. QUEUED WHILE THIS REFUSAL WAS SHUT OUT OF ITS KEY — a LIVE sync row for this posting whose id is
 *      not in the baseline this refusal observed at the instant the key was refused to it. Since r12 that
 *      is the whole of it: `postingSupersedesThisRefusal` states the rule and the evidence block above
 *      says why every other candidate was removed.
 *   3. CONTENDED AND UNABLE TO WAIT — inside a caller's transaction, a key another transaction holds.
 *      Nothing can be read that will still be true, so nothing is written HERE; since r10 the refusal is
 *      instead persisted with the caller's own transaction and replayed under the key (see below).
 *
 * WHAT IS DELIBERATELY *NOT* CHECKED, and why (the "what would still pass it" question). Not "is there a
 * live sync row for this key" on its own. Several types share one key across successive postings by
 * design (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT — see lib/accounting/posting-key.ts):
 * edit 1 queues and clears the row, edit 2 is refused, and the ledger now holds a stale document. That
 * refusal is a REAL debt, and a blanket "a live row exists, so nothing is owed" would swallow it — the
 * table's whole purpose, lost to a guard meant to protect it. Nor `resolvedAt`/`queued` on the row, nor
 * any comparison of two timestamps: the evidence block above gives the failure each one produced.
 *
 * ── o3d-j625 r10 (Codex round 9, HIGH) — AND CONTENTION NO LONGER DISCARDS THE REFUSAL ──
 *
 * Case 3 above used to end there: nothing recorded, a WARNING in the activity log, and the caller's
 * business transaction committing anyway. If the transaction holding the key then rolled back, or failed
 * to queue its posting, the debt existed and nothing listed it. The refusal is now PERSISTED IN THE
 * CALLER'S OWN TRANSACTION as a provisional claim and replayed from the pool, where waiting for the key
 * is allowed — see posting-refusal-provisional.ts for the design, the reconciler, and what an
 * unreconciled claim looks like in the inbox.
 *
 * ── o3d-j625 r11 (Codex round 10, HIGH 1) — AND THE DEFERRED PATH TAKES A BASELINE WITH IT ──
 *
 * The claim r10 persists is replayed under the key, and the replay has to answer a question the clock
 * cannot: did the transaction that held the key QUEUE this posting, or did it roll back? r10 answered
 * "there is a live row, so it queued it", and for the types whose successive edits share one posting key
 * an ancient row answered for ever. So the deferring call records WHAT THE KEY ALREADY HAD at the
 * moment it was refused ({@link RecordRefusalOptions.queuedWhenShutOut}), and the replay looks for a LIVE
 * row that was not in that set. That read is the observation `runUnderPostingKeyLock` takes for it,
 * before it waits or gives up — the only moment at which the holder's writes are still distinguishable
 * from everybody else's.
 *
 * ── o3d-j625 r12 (Codex round 11) — AND r9's RESIDUAL WINDOW IS DELIBERATELY REOPENED, IN THE SAFE
 *    DIRECTION ──
 *
 * r10 closed it with a clock: a refusal decided before an enqueue that both started and committed in the
 * gap before this call took the key UNCONTENDED was discharged because the sync row's `createdAt` beat
 * `decidedAt`. Round 11 showed that comparison is between two IMS PROCESSES' clocks, so it settles nothing
 * — and there is no ordering available here that is not one (the evidence block states the migration that
 * would be needed to get one). The window is therefore open again and such a refusal is RECORDED. That is
 * a debt that may not be owed, which an operator can read and close; the alternative was a debt that was
 * owed and which nothing would ever list. It does NOT affect the deferred path, which the baseline answers
 * without any clock — the case r10 was most worried about ("the reconciler runs minutes after the claim,
 * uncontended by then") is exactly the one the baseline covers.
 */
export async function recordAccountingPostingRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  record: AccountingPostingRefusalRecord,
  options?: RecordRefusalOptions,
): Promise<RefusalRecordOutcome> {
  const now = new Date()
  const decidedAt = options?.decidedAt ?? now
  // A holder rather than a plain `let`: the assignment happens inside a callback, and TypeScript would
  // otherwise narrow the variable to the initializer and call every branch below unreachable.
  //
  // r10: it starts at `failed`, not at `recorded: true`. `guarded` REPORTS a write that threw and does
  // not rethrow it, so with an optimistic initial value this function returned "recorded" for a row that
  // was never written — invisible to a caller that can retry, which the reconciler is.
  const state: { outcome: RefusalRecordOutcome } = { outcome: { recorded: false, because: 'failed' } }
  await guarded('recording', key, options, async () => {
    state.outcome = await runUnderPostingKeyLock(
      client as unknown as PostingKeyLockClient,
      key,
      {
        callerTransaction: Boolean(options?.withSavepoint),
        // o3d-j625 r11 — THE BASELINE, taken at the only moment it means anything: the key has just been
        // refused to this caller, so the transaction holding it has not committed and nothing it wrote is
        // visible here yet. A live row that appears after this is that transaction's own evidence that it
        // queued the posting; r10 had only "the key was contended", which an older edit's row satisfied.
        //
        // IT IS A READ, AND IT TAKES ITS OWN SAVEPOINT — on BOTH paths, not only the in-transaction one.
        // A statement that raises aborts the whole PostgreSQL transaction (25P02), and on either path there
        // is a transaction to abort: the CALLER'S when it was refused the key, and the one
        // `runUnderPostingKeyLock` opened for itself when it is about to wait for it. Without the
        // savepoint a failed observation would take the lock acquisition and the write down with it, so
        // the deferred refusal would be reported as unwritable instead of simply unobserved. Wrapped, it
        // comes back as `observed: null` — "I cannot tell", which records the refusal, never "nothing was
        // queued". The module's own helper rather than `options.withSavepoint`, so the pooled path is
        // covered too; on a client that is in no transaction at all it simply runs the read.
        // EVERY row for the key, not only the live ones (r12). A CANCELLED row can be put back in front
        // of the connector under its original id (`releaseRetiredAccountingSyncRowForLiveSale`), and a
        // baseline that had not seen it would then read that release as a NEW enqueue.
        observeWhenContended: async (on) => withSavepoint(on, async () => {
          // A snapshot older than "everything committed now" cannot serve as a baseline — see
          // `seesEveryCommittedRow`. Abstaining is `null`, which keeps the debt.
          if (!await seesEveryCommittedRow(on)) return null
          const ids = await readEveryPostingRowForKey(on as unknown as PostingRefusalClient, key)
          return ids === null ? null : queuedPostingEvidenceOf(ids)
        }),
      },
      async (locked, lock) => {
        const table = (locked as unknown as PostingRefusalClient).accountingPostingRefusal
        // ── o3d-j625 r10 (Codex round 9, HIGH) — CONTENDED IS DEFERRED, NOT DISCARDED ──
        //
        // Another transaction is settling this exact posting and this caller — inside its own
        // transaction — may not wait for it. Nothing read now would still be true when it was written, so
        // nothing is written HERE. But the caller's business transaction commits regardless (review
        // M-14), and until r10 that meant a posting the other transaction then failed to queue, or rolled
        // back entirely, was simply absent from the exception inbox behind an activity-log WARNING.
        //
        // So the refusal is persisted as a PROVISIONAL CLAIM in the caller's own transaction — one
        // INSERT into a table nothing here holds a lock on — and replayed from the pool, where waiting
        // for this key is allowed. See posting-refusal-provisional.ts for why an INSERT is the only
        // durable write available on this path, and what the claim looks like until it is reconciled.
        if (!lock.held && lock.reason === 'busy') {
          await enqueueProvisionalPostingRefusal(
            // The CALLER'S client, deliberately: the claim must commit with the business writes it
            // describes and vanish with them if the caller rolls back.
            locked as unknown as IntegrationOutboxClient,
            key,
            record,
            {
              decidedAt,
              mergeOnly: options?.mergeOnly === true,
              nonce: randomUUID(),
              // What was already queued when the key was refused. `null` is carried as `null`: the replay
              // must be able to tell "nothing was queued then" from "this call could not look".
              queuedWhenShutOut: lock.observed,
            },
          )
          return { recorded: false, because: 'contended', deferred: true }
        }
        const existing = typeof table.findUnique === 'function'
          ? await table.findUnique({
            where: { type_referenceType_referenceId_scope: key },
            select: { suppressedAt: true, resolvedBy: true, resolvedAt: true, resolution: true },
          })
          : null
        // 1. A POSTING MARKED HANDLED STAYS HANDLED (r7). Someone asserted they posted it by hand and IMS
        //    will never post it (posting-suppression.ts), so a later refusal of the same key is not new
        //    debt: recording it would reopen a row whose only remedy has already been carried out.
        if (existing?.suppressedAt) return { recorded: false, because: 'suppressed', at: existing.suppressedAt }
        // 2. THE POSTING WAS QUEUED WHILE THIS REFUSAL WAS SHUT OUT OF ITS KEY, and that is the ONLY
        //    thing that discharges it (see the evidence block above for the full argument).
        //
        //    r12 REMOVED TWO CHECKS THAT USED TO STAND HERE, and both removals lose a case on purpose:
        //
        //      · `existing.resolvedAt` + `resolution === 'queued'` + later than `decidedAt`. Codex round 11,
        //        HIGH 1: this returned BEFORE anything looked at whether a posting still existed, so an
        //        enqueue whose row was CANCELLED before it could post — the capacity guard's retirement, a
        //        deleted payment, an operator settling it NOT_POSTED — went on discharging every refusal
        //        decided before it. The column records that an enqueue once happened; the obligation is
        //        about whether the ledger has the posting or is going to.
        //      · `createdAt` later than `decidedAt`. Codex round 11, HIGH 2: two application clocks from two
        //        IMS processes. A process running fast stamps an OLDER row with a LATER `createdAt`, and the
        //        debt vanishes.
        //
        //    WHAT IS LOST: r9's residual — an enqueue that both started and committed in the gap before an
        //    UNCONTENDED refusal took the key — is now recorded as a debt. That is the safe direction, it is
        //    the direction the rest of this module already takes when it cannot tell, and `markPostingHandled`
        //    refuses the remedy for any posting whose sync row might have reached the ledger.
        //
        //    WHICH BASELINE, when there could be two. A replay carries the ORIGINAL call's observation
        //    (`options.queuedWhenShutOut`) and may ALSO have waited for the key itself; the original is
        //    strictly earlier, so it is the one that answers "was this queued while the refusal was shut
        //    out". The key being PRESENT in `options` is what distinguishes a replay — including a LEGACY
        //    claim, which carries the key with `undefined` and must not fall back to this call's own
        //    observation, because that one was taken minutes after the race it is recovering from.
        if (lock.held && await postingSupersedesThisRefusal(locked as unknown as PostingRefusalClient, key, {
          queuedWhenShutOut: options && 'queuedWhenShutOut' in options
            ? options.queuedWhenShutOut
            : lock.contended ? lock.observed : undefined,
        })) {
          // `now`, not `existing.resolvedAt` (r12): this arm establishes that a row APPEARED, not when it
          // was written, and `resolvedAt` could belong to an older episode of the same key. The instant
          // reported is the instant it was observed, which is the only one this arm actually knows.
          return { recorded: false, because: 'queued', at: now }
        }
        if (!options?.mergeOnly) {
          // review M-13: a resolved row being refused again is a NEW episode. Reset before the increment, so
          // `firstRefusedAt` is when THIS gap opened and the count is this episode's.
          await table.updateMany({
            // r6 (review H4): a row someone MARKED HANDLED reopens the same way — the same posting refused again
            // is a new debt, whoever closed the last one. (How it was closed is cleared with `resolvedAt`, below.)
            // r9: EXCEPT a suppressed one, which is never reopened by anyone — asserted in the predicate and
            // not only in the read above, so a client that cannot read the suppression still cannot clear it.
            where: { ...key, resolvedAt: { not: null }, suppressedAt: null },
            data: { firstRefusedAt: now, refusedCount: 0, detail: null },
          })
        }
        const update = options?.mergeOnly
          ? {
              // What only the caller knows. The reason and the count belong to the enqueue's own write.
              committed: record.committed,
              remedy: record.remedy,
              // review L-2: `detail` is REPLACED, never merged — a stale detail can describe a different
              // refusal of the same posting.
              detail: (record.detail ?? null) as Prisma.InputJsonValue | null,
              // The SITE names the kind; the enqueue's own write could only default it (posting-refusal-kinds.ts).
              ...(record.kind ? { kind: record.kind } : {}),
              resolvedAt: null,
              resolution: null,
              resolvedBy: null,
              resolutionNote: null,
            }
          : {
              chartConnector: record.chartConnector,
              activeConnector: record.activeConnector,
              reason: record.reason,
              committed: record.committed,
              remedy: record.remedy,
              detail: (record.detail ?? null) as Prisma.InputJsonValue | null,
              lastRefusedAt: now,
              ...(record.kind ? { kind: record.kind } : {}),
              resolvedAt: null,
              resolution: null,
              resolvedBy: null,
              resolutionNote: null,
              refusedCount: { increment: 1 },
            }
        if (existing) {
          // A row IS there, so this is an update — and it carries the suppression predicate, which is what
          // makes "a suppressed row is never updated" a property of the STATEMENT. `upsert` cannot express
          // it (its `where` must be the unique key), which is why the two cases are split.
          const { count } = await table.updateMany({ where: { ...key, suppressedAt: null }, data: update })
          if (count === 0) {
            throw new Error(
              `the row for ${key.type} ${key.referenceType} ${key.referenceId} was not reopened: under this `
              + 'posting\'s lock it is marked handled (posted by hand), or it is no longer there',
            )
          }
        } else {
          // No row to fence. `upsert` rather than `create` so a client that cannot READ the row (a
          // structural test double) still behaves as it did before this round.
          await table.upsert({
            where: { type_referenceType_referenceId_scope: key },
            create: {
              ...key,
              kind: record.kind,
              chartConnector: record.chartConnector,
              activeConnector: record.activeConnector,
              reason: record.reason,
              committed: record.committed,
              remedy: record.remedy,
              detail: (record.detail ?? undefined) as Prisma.InputJsonValue | undefined,
              firstRefusedAt: now,
              lastRefusedAt: now,
            },
            update,
          })
        }
        return { recorded: true }
      },
    )
  })
  // Reported OUTSIDE the lock: a refusal that is not recorded must still be visible, and the activity
  // write is on another connection — holding a posting key while waiting for it buys nothing.
  const outcome = state.outcome
  if (outcome.recorded) return outcome
  // A write that threw has already been reported by `guarded`, under its own action. Returning it
  // unreported here is deliberate: reporting the same failure twice would make the activity log say the
  // row was missing for two different reasons.
  if (outcome.because === 'failed') return outcome
  if (outcome.because === 'suppressed') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_posting_refused_after_handled_by_hand',
      tag: 'accounting',
      level: 'INFO',
      description:
        `${key.type} for ${key.referenceType} ${key.referenceId} was refused again, but it was marked handled — `
        + `posted by hand — on ${outcome.at.toISOString()}. Nothing is owed and nothing was recorded.`,
      metadata: { ...key, reason: record.reason },
    }).catch(() => { /* nothing else to try */ })
    return outcome
  }
  if (outcome.because === 'queued') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_posting_refused_after_queued',
      tag: 'accounting',
      level: 'INFO',
      description:
        `${key.type} for ${key.referenceType} ${key.referenceId} was refused, but a posting for it appeared `
        + `while this refusal was being decided — seen at ${outcome.at.toISOString()}. The posting is in the `
        + 'accounting sync log, nothing is owed, and nothing was recorded as outstanding.',
      metadata: { ...key, reason: record.reason, postingSeenAt: outcome.at.toISOString() },
    }).catch(() => { /* nothing else to try */ })
    return outcome
  }
  if (outcome.because !== 'contended') return outcome
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_posting_refusal_not_recorded_contended',
    tag: 'accounting',
    // r10: INFO, not WARNING. Nothing is lost any more — the refusal is persisted in this caller's own
    // transaction and reconciled under the key it could not take. It is recorded here because "which
    // refusals took the deferred path" is a question the activity log should be able to answer.
    level: 'INFO',
    description:
      `IMS refused ${key.type} for ${key.referenceType} ${key.referenceId} while another transaction was `
      + 'queueing, marking or refusing this same posting, and this one is inside a transaction that must not '
      + 'wait for it. The refusal is held as a provisional claim that commits with this transaction, and the '
      + 'accounting-sync tick settles it under this posting\'s lock: if the other transaction queued the '
      + 'posting nothing is owed, and if it did not the refusal is listed in the exception inbox.',
    metadata: { ...key, reason: record.reason, deferred: outcome.deferred },
  }).catch(() => { /* nothing else to try */ })
  return outcome
}

/**
 * Clear the outstanding row for a posting that has now been queued.
 *
 * Called from BOTH enqueues' success paths with a key derived from the enqueue's own params, and on the
 * in-transaction path with the transaction client so the clear commits with the sync row it is about — a
 * clear that survived a rolled-back enqueue would mark the debt paid over a posting never written.
 *
 * o3d-j625 r9 — UNDER THE POSTING KEY'S LOCK, like every other write to this table. On the path that
 * matters most (`createAccountingSyncLogRow`) the caller's transaction already holds the key, so this is
 * re-entrant and costs nothing; on the facade's pooled clear it is a real acquisition, and it is what
 * makes a concurrent `recordAccountingPostingRefusal` able to SEE that the posting was queued rather than
 * read a row that is about to change. A clear that cannot take the key still runs: it is a monotone
 * CAS — it only ever closes a row that is open — so the worst it can do is settle a debt the posting has
 * in fact discharged, and skipping it would leave the false debt this round exists to remove.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r26 (Codex round 25, HIGH 1) — AND IT MUST NOT CLOSE A ROW SOMEBODY IS SETTLING BY HAND
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE INTERLEAVING. The Xero queue commits the PENDING sync row and the facade clears the refusal in a
 * SEPARATE step. Between the two, an operator can take that refusal for hand posting — and taking it
 * CANCELS the provably-unsent row it was about (`claimPostingForHandPosting`). This clear then arrived at a
 * claimed row, matched it on `resolvedAt: null` alone, and resolved it: `resolution: 'queued'` over a
 * posting whose row had just been cancelled, with the claim stamp left in place.
 *
 * WHAT THAT COSTS, and it is the exact failure round 18's discoverability work exists to prevent, arriving
 * through a different door: the refusal is resolved, so it leaves the outstanding list AND the active-claims
 * list (both select `resolvedAt: null`). It can no longer be released and no longer be marked handled — both
 * refuse an already-resolved row. But `handPostClaimedAt` is still set, so `readPostingSuppression` goes on
 * reporting the key as one IMS must not queue, FOR EVER. A permanent stuck suppression that nothing lists
 * and no human can end.
 *
 * SO THE CLEAR IS CONDITIONAL ON THERE BEING NO CLAIM, and a clear that matches nothing is handled
 * EXPLICITLY rather than as a silent no-op:
 *
 *   · `handPostClaimedAt: null` joins the predicate. The property is a fact about the STATEMENT, not about a
 *     read that preceded it, so a claim taken between a check and this write cannot slip through.
 *   · When nothing matched, the row is re-read UNDER THE SAME LOCK. If it is claimed, the clear DECLINES and
 *     says so at WARNING, naming the holder — the refusal stays outstanding, the claim stays theirs, and the
 *     operator settles it by hand. That is the right answer on the merits too: the row this clear was about
 *     has been cancelled, so "the posting has now been queued" is false.
 *   · It NEVER clears the claim to make its own write succeed. Taking the claim out from under an operator
 *     who is in the ledger is the duplicate-posting window r16 closed.
 *   · A row that was simply already resolved (no claim) is the ordinary idempotent case and stays silent.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r28 (Codex round 27, HIGH 1) — AND THE DECLINE IS RETURNED, BECAUSE A SILENT DECLINE IS THE
 * SAME DEFECT ONE LAYER OUT
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r26 got the decline right and then dropped it on the floor: this function returned `void`, so the facade
 * went on returning `queued: true` for a posting whose sync row the claim had just CANCELLED. Callers such
 * as the sales-invoice update then took their success path — the refusal row stayed visible, but the
 * caller's own answer said its work was queued, which is round 17's swallowed edit arriving through round
 * 26's own fix. Ninth finding in this lineage and the first one that is purely a plumbing omission.
 *
 * So the result is a DISCRIMINATED UNION, not a boolean and not `void`. `outcome` is a required literal, so
 * the facade's `switch` over it is exhaustive with a `never` default: a future author who adds a third way
 * for the clear to decline gets a `tsc` error at every consumer instead of a silent `queued: true`. That is
 * the same device the connector switch in `lib/accounting.ts` uses, and the same device r18 used when
 * `createAccountingSyncLogRow` began returning `{ row, suppressed }` so `if (!created)` stopped compiling.
 *
 * `'cleared'` covers "closed it" and "there was nothing open to close" TOGETHER, deliberately: both mean the
 * debt is discharged and no caller has ever had a reason to tell them apart. Only the claimed case is
 * actionable, so only the claimed case is a separate member.
 */
export type PostingRefusalClearResult =
  | { outcome: 'cleared' }
  | { outcome: 'declined-hand-post-claim'; claimedAt: Date; claimedBy: string | null }
  /**
   * o3d-j625 r30 (Codex round 29, HIGH 1) — A CLAIM WAS READ, AND THE POSTPONEMENT DID NOT SURVIVE.
   *
   * The clear saw a live claim but the transaction that was to record the postponement did not commit. The
   * posting is therefore OWED — the queue's row was cancelled by the claim — but it is NOT durably postponed,
   * and a caller must not be able to read it as though it were. This exists as its own member so that the
   * distinction cannot be lost in a boolean, and so the exhaustive switch forces every consumer to choose.
   */
  | { outcome: 'declined-hand-post-claim-not-recorded'; claimedAt: Date; claimedBy: string | null; because: string }

export async function clearAccountingPostingRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  options?: RecordRefusalOptions,
): Promise<PostingRefusalClearResult> {
  // o3d-j625 r28: `guarded` swallows a failed write by design (review L-1) — an inbox tidy-up must not
  // become the posting's exception. A swallowed failure with nothing observed therefore reports `'cleared'`,
  // and that is the SAFE direction there: the row stays outstanding and visible, and the posting really was
  // queued, so nothing is lost.
  //
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════
  // o3d-j625 r30 (Codex round 29, HIGH 1) — PUBLISH THE DECLINE ONLY AFTER IT IS TRUE
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════
  //
  // r28 assigned `result = { outcome: 'declined-hand-post-claim' }` BEFORE the deferral write and before the
  // lock transaction committed. `result` is a JavaScript variable, so a rollback does not undo the
  // assignment, and `guarded` swallows the error — so the decline reached the caller while
  // `handPostDeferredCount` stayed zero. The caller then recorded the edit as owed with nothing counting it,
  // and marking a REUSED-KEY posting handled closed the refusal and took the postponed edit with it. That is
  // round 17's swallowed edit for the tenth time in this lineage, arriving through the ERROR PATH of the fix
  // that closed it.
  //
  // THE SAME WRAPPER, THE SAME HAZARD, ALREADY SEEN ONCE: r10 fixed it on the `recording` path, where the
  // holder started at an OPTIMISTIC value and `guarded` let it be returned for a row that was never written.
  // That fix was a pessimistic initializer. This one is the other half of the discipline — publish the lock
  // callback's RETURN VALUE, so a throw or a failed commit means no publication happened at all, rather than
  // assigning into an outer variable from inside a transaction that may still roll back.
  //
  // WHY A THIRD MEMBER RATHER THAN A THROW: throwing here would let an inbox tidy-up roll back a goods
  // receipt or a bill edit, which is the denial of service enqueue-outcome.ts refuses to trade for. So the
  // caller is told, precisely, that the posting is owed and the postponement is NOT recorded.
  let result: PostingRefusalClearResult = { outcome: 'cleared' }
  // A HOLDER rather than a plain `let`, for the reason the `recording` path gives: TypeScript would narrow
  // the variable to its initializer and call the branches below unreachable.
  //
  // This one is READ-ONLY EVIDENCE and is deliberately allowed to survive a rollback: "we saw a live claim"
  // stays true whatever happens to the write afterwards, and it is the only way to tell a failed decline from
  // an ordinary failure. Acting on it is strictly CONSERVATIVE — it can only turn a `'cleared'` into an owed
  // posting, never the reverse. The cost when the claim is released moments later is a transient debt that the
  // next enqueue's clear resolves by itself; the cost of the other choice is an edit nobody ever posts.
  const seen: { claim: { claimedAt: Date; claimedBy: string | null } | null } = { claim: null }
  await guarded('clearing', key, options, async () => {
    const settled = await runUnderPostingKeyLock<PostingRefusalClearResult>(
      client as unknown as PostingKeyLockClient,
      key,
      { callerTransaction: Boolean(options?.withSavepoint) },
      async (locked) => {
        const table = (locked as unknown as PostingRefusalClient).accountingPostingRefusal
        const { count } = await table.updateMany({
          // o3d-j625 r26: `handPostClaimedAt: null` is the whole fix. See the block above.
          where: { ...key, resolvedAt: null, handPostClaimedAt: null },
          data: { resolvedAt: new Date(), resolution: 'queued' },
        })
        if (count > 0) return { outcome: 'cleared' }
        // Nothing matched. Two states can produce that, and only one of them is worth saying anything about.
        const standing = typeof table.findUnique === 'function'
          ? await table.findUnique({
            where: { type_referenceType_referenceId_scope: key },
            select: { suppressedAt: true, resolvedBy: true, resolvedAt: true, resolution: true, handPostClaimedAt: true, handPostClaimedBy: true },
          })
          : null
        if (!standing?.handPostClaimedAt) return { outcome: 'cleared' }
        const claim = { claimedAt: standing.handPostClaimedAt, claimedBy: standing.handPostClaimedBy ?? null }
        seen.claim = claim
        // o3d-j625 r28 — AND IT COUNTS AS A POSTPONEMENT, because that is exactly what it is.
        //
        // r18 made `handPostDeferredCount` mean "edits that arrived while you were holding this claim", and
        // r18 also established the invariant that a `hand-post-deferred` answer is never given without the
        // postponement being recorded — `HandPostDeferralUnrecordableError` exists because "a `queued: false`
        // nobody records" is one of the two ways round 17's edit was lost. This path returns exactly that
        // reason through the facade, so it owes the same record. The bump happens HERE because here it is
        // causal: under this key's lock, on the row just read as claimed, so it cannot increment against a
        // claim that has already been given back.
        //
        // o3d-j625 r30: and its result IS inspected now. `'no-claim'` is impossible under the lock we hold and
        // `'unrecordable'` means a client with no table, which `standing` proves is not the case — but "cannot
        // happen" is what r28 said about every step between the assignment and the commit. A value that is
        // announced before the write that makes it true has to be checked, not reasoned about.
        /**
         * o3d-j625 r34 (Codex round 33, HIGH) — THE EVIDENCE IS WRITTEN UNDER THIS LOCK, IN THIS TRANSACTION.
         *
         * r32 attempted the bump here and, when it failed, stamped `handPostDeclineUncountedAt` afterwards
         * through the POOL. Round 33 named the mechanism that leaves open: this transaction has already ended
         * and the key lock is already released by the time that second write is attempted, so it can fail on
         * its own, or the process can stop while it waits for a connection — and then neither signal exists and
         * a later mark resolves the row. The ERROR line was the only remaining trace, and its own write is
         * swallowed, so "an operator reads the log" was never a mitigation.
         *
         * So the bump is now attempted inside a SAVEPOINT. A failed statement aborts a PostgreSQL transaction
         * (25P02) unless it is contained, which is exactly why r32 could not write the stamp here; contained,
         * the failure rolls back to the savepoint and THIS transaction is still usable. The stamp is then
         * written under the SAME lock, in the SAME transaction as the decline itself, so the two commit
         * together or not at all. There is no window between them to fail in, and no lock to have been
         * released.
         *
         * WHAT IS LEFT is the whole transaction failing to commit, which is one condition where there were two,
         * and it is caught by the best-effort fallback after `guarded` — see below. Recorded honestly rather
         * than claimed away.
         */
        let counted = false
        try {
          counted = await withSavepoint(locked, async () => {
            const recorded = await recordHandPostDeferral(locked as unknown as PostingSuppressionClient, key, new Date())
            if (recorded !== 'recorded') {
              throw new Error(`the postponement could not be recorded against the live claim (${recorded})`)
            }
            return true
          })
        } catch {
          // Contained by the savepoint: this transaction is still alive, which is the whole point.
          counted = false
        }
        if (!counted) {
          await table.updateMany({
            where: { ...key, resolvedAt: null },
            data: { handPostDeclineUncountedAt: new Date() },
          })
        }
        await reportClearDeclinedForHandPostClaim(key, claim.claimedAt, claim.claimedBy, counted)
        return counted
          ? { outcome: 'declined-hand-post-claim', ...claim }
          : {
            outcome: 'declined-hand-post-claim-not-recorded',
            ...claim,
            because: 'the postponement could not be counted; the refusal is stamped as unaccounted instead',
          }
      },
    )
    // Reached ONLY if the lock callback returned and its transaction committed. Everything the decline claims
    // is durable by the time this assignment happens, which is the whole of the fix.
    result = settled
  })
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════
   * o3d-j625 r36 — THE RESIDUAL. Written for somebody deciding whether to accept it, not only for the next
   * author. Read it before "improving" any of the code above.
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════
   *
   * THE FAILURE, in one sentence: an invoice-update posting that IMS owed the ledger can be silently written off
   * when an operator marks the original hand posting handled, leaving the ledger behind IMS with nothing
   * outstanding to say so.
   *
   * WHAT HAS TO HAPPEN, AND IT IS ALL OF IT AT ONCE — SIX CONDITIONS:
   *
   *   1. a hand-post claim is held on a REUSED posting key (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE,
   *      BILL_PAYMENT). On every other kind the operator's hand posting settles the debt and closing the row is
   *      correct, so there is nothing to lose;
   *   2. an enqueue that BEGAN BEFORE the claim was taken reaches this clear afterwards. An edit arriving DURING
   *      the claim cannot: `createAccountingSyncLogRow` reads the suppression under this same lock and records
   *      the postponement inside the caller's own transaction, throwing rather than proceeding (r18);
   *   3. the locked transaction above fails to COMMIT. Note what this does NOT require — see below;
   *   4. the post-lock fallback write then also fails, or the process stops before it runs;
   *   5. an operator marks the original posting handled;
   *   6. and their hand posting used a version of the document OLDER than the enqueue in (2) was carrying.
   *      Otherwise that enqueue's content is already in what they posted and nothing is actually lost.
   *
   * WHAT r34 GOT WRONG, corrected by Codex round 35: it listed "the deferral bump fails" as a condition. IT IS
   * NOT ONE. On a SUCCESSFUL bump no stamp is written — the bump itself is the evidence — but it lives in this
   * same transaction, so a commit failure rolls it back too, `result` is never published, and the caller falls
   * through to the same fallback. Fewer conditions, same end. A residual described with more conditions than it
   * needs is a residual UNDERSTATED, which is worse than one described plainly.
   * The end state is pinned by `[o3d-j625 r36 RESIDUAL]` in the concurrency tests, which asserts the LOSS rather
   * than a defence: if that test ever fails, the residual has narrowed and this note is wrong.
   *
   * WHAT AN OPERATOR SEES, SURFACE BY SURFACE:
   *   · conditions 1–3 only (the common failure): the refusal row shows "Incomplete history" ABOVE its buttons;
   *     the claims list shows "at least one, NOT COUNTED" instead of a number; marking handled KEEPS the row
   *     outstanding and says the history is incomplete; releasing says the same. They cannot miss it.
   *   · conditions 1–4 (the fallback failed too): NOTHING on any screen. The only trace is an ERROR activity
   *     line, `accounting_posting_refusal_decline_not_recorded`, which states in plain words that the stamp could
   *     not be written and that marking handled WILL close the refusal. An operator would have to have been
   *     reading the log before acting, which is why a log line was never accepted as the mitigation.
   *   · conditions 1–6: the row resolves normally and the ledger may be behind. Nothing anywhere says so.
   *
   * WHAT THE OPERATOR MUST DO, and it is the same instruction in every case: when a refusal says its history is
   * incomplete, compare the document with the ledger and then RE-SAVE the document, which queues its current
   * version. Re-saving is the discharge for these three kinds; releasing and marking handled are not.
   *
   * WHAT IMS WILL NOT DO FOR THEM: it will not replay the declined payload (on these kinds a posting OVERWRITES
   * the document, so the only correct posting is the current state, and a captured payload may already be
   * superseded); it will not retry the posting on a timer; and it will not detect after the fact that a resolved
   * refusal should not have been resolved — there is no record left to detect it from, which is the residual.
   *
   * WHY IT IS NOT CLOSED, both options having been tried. A narrower fail-closed rule — "for a reused key whose
   * claim we cannot account for, refuse the mark" — does not work: the ORDINARY case (claim taken, posting made
   * by hand, nothing declined behind it) leaves exactly the same durable state as the dangerous one, namely a
   * claim with no count and no stamp. Demanding positive evidence of what happened during the claim therefore
   * refuses the ordinary mark too, which is a false debt on every hand-settled invoice update (the r6 failure),
   * and "the ordinary case accounts for itself by resolving normally" is circular because resolving normally is
   * the thing being decided. No durable artefact separates them either: the claim cancelling a queued row happens
   * in the ordinary flow as well. An automated reconciliation sweep needs a durable "this claim ended
   * unaccounted-for" record to sweep FOR — the same write that can fail — so it moves the window rather than
   * closing it, unless it reconciles against the connector's own ledger state, which is a far larger surface than
   * this branch.
   */
  // o3d-j625 r34: reached only when the locked transaction above did not COMMIT — the in-transaction stamp went
  // with it, so this is the last-ditch attempt, through the pool, with the lock no longer held. It is the
  // narrowed residual, not the primary path it was in r32.
  if (result.outcome === 'cleared' && seen.claim) {
    // A live claim was read and the postponement did not commit. Owed, and explicitly not postponed.
    //
    // o3d-j625 r32 (Codex round 31, HIGH 1) — AND THE MARK HAS TO BE ABLE TO SEE IT.
    //
    // r30 told the CALLER, which was necessary and not sufficient: `markPostingHandled` keeps a reused key's
    // debt outstanding only when `handPostDeferredCount > 0`, and on this path it is 0. So an operator marking
    // the original posting handled resolved the refusal for a later edit with no sync row — round 17's lost
    // edit for the eleventh time, through the edge of r30's own remedy.
    //
    // THE MARKER IS WRITTEN HERE, OUTSIDE THE FAILED TRANSACTION, and that placement is the fix rather than an
    // implementation detail: the deferral bump failed inside the lock transaction, so anything written there is
    // rolled back by the very failure it would record. Best-effort and ordered BEFORE the report, so that when
    // both are attempted the durable fact lands first.
    const marked = await markDeclineUncounted(client, key)
    await reportDeclineNotRecorded(key, seen.claim.claimedAt, seen.claim.claimedBy, marked)
    return {
      outcome: 'declined-hand-post-claim-not-recorded',
      ...seen.claim,
      because: marked
        ? 'the postponement write or its transaction did not commit'
        : 'the postponement write or its transaction did not commit, AND the uncounted marker could not be stored',
    }
  }
  return result
}

/**
 * o3d-j625 r30 — THE DECLINE THAT COULD NOT BE MADE DURABLE, said out loud.
 *
 * ERROR, not WARNING: the ordinary decline (r26) is a WARNING because everything about it is recorded and an
 * operator will meet it in the inbox. This one means the postponement count does NOT include an edit that
 * arrived, so the row an operator is looking at understates what is owed. Never throws, for the same reason
 * nothing else on this path does.
 */
/**
 * o3d-j625 r32 — STAMP "a postponement happened here that nothing counted", through a client that is not the
 * transaction which just failed.
 *
 * Returns whether it landed, because the caller says so out loud either way. A second failure on top of the
 * first leaves the mark unable to see the uncounted decline — that residual window is stated in the ERROR line
 * and in the issue notes rather than papered over; what it is not is the COMMON case, which this closes.
 *
 * `resolvedAt: null` in the predicate: a refusal that has already been closed is not made outstanding again by
 * this stamp. The claim is deliberately NOT part of the predicate — the operator may release it between the
 * failure and this write, and the uncounted edit is owed either way.
 */
async function markDeclineUncounted(client: PostingRefusalClient, key: PostingRefusalKey): Promise<boolean> {
  try {
    const { count } = await client.accountingPostingRefusal.updateMany({
      where: { ...key, resolvedAt: null },
      data: { handPostDeclineUncountedAt: new Date() },
    })
    return count > 0
  } catch {
    return false
  }
}

async function reportDeclineNotRecorded(
  key: PostingRefusalKey,
  claimedAt: Date,
  claimedBy: string | null,
  marked: boolean,
): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_posting_refusal_decline_not_recorded',
    tag: 'accounting',
    level: 'ERROR',
    description:
      `A queued ${key.type} for ${key.referenceType} ${key.referenceId} was declined because ${claimedBy ?? 'an operator'} `
      + `has been settling it by hand since ${claimedAt.toISOString()}, but IMS could NOT record the postponement: `
      + 'the write or its transaction did not commit. The posting is reported as still owed, so it will be '
      + 'recorded as outstanding in the usual way, but the "postings declined behind this claim" count does NOT '
      + 'include this one. '
      + (marked
        ? 'The refusal is stamped as carrying an uncounted postponement, so marking the claim handled will KEEP '
          + 'it outstanding rather than closing it.'
        : 'AND THE STAMP THAT WOULD KEEP IT OUTSTANDING COULD NOT BE WRITTEN EITHER, so marking this posting '
          + 'handled WILL close the refusal. Check the ledger holds the current version of this document before '
          + 'anybody marks it handled.')
      + ' Check the ledger for this posting before marking the claim handled.',
    metadata: { ...key, claimedBy, claimedAt: claimedAt.toISOString(), uncountedMarkerStored: marked },
  }).catch(() => { /* a report that cannot be written must not become the caller's exception */ })
}

/**
 * o3d-j625 r26 — THE CLEAR DECLINED, AND A DECLINE THAT NOBODY CAN SEE IS THE DEFECT ONE LAYER DOWN.
 *
 * WARNING rather than INFO: the interleaving that produces it means a sync row was written and then
 * cancelled by the claim, so somebody should be able to find out afterwards why a posting the queue thought
 * it had written is being settled by hand instead. Never throws — this runs inside the enqueue's own
 * transaction on the path that matters, and a failed audit line must not roll back a posting.
 */
async function reportClearDeclinedForHandPostClaim(
  key: PostingRefusalKey,
  claimedAt: Date,
  claimedBy: string | null,
  /** o3d-j625 r34: whether the postponement was COUNTED, or only stamped as unaccounted. */
  counted = true,
): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_posting_refusal_clear_declined_hand_post_claim',
    tag: 'accounting',
    level: 'WARNING',
    description:
      `A queued ${key.type} for ${key.referenceType} ${key.referenceId} did NOT close its refused-posting row: `
      + `an operator took it to settle by hand at ${claimedAt.toISOString()} and still holds it, which cancelled `
      + 'the queued row this clear was about. The refusal stays OUTSTANDING and the claim stays theirs — '
      + 'clearing it would hide a posting nobody could then release or mark handled, while its claim went on '
      + 'stopping IMS queueing it.'
      // o3d-j625 r34: which of the two durable signals this decline left behind. The signal itself is what
      // stops the mark resolving the row; this line only describes it, and is no longer the mechanism.
      + (counted
        ? ' The postponement is COUNTED against the claim.'
        : ' The postponement could NOT be counted, so the refusal is stamped as carrying an UNACCOUNTED decline '
          + 'instead — written in this same transaction, under this same lock, so it commits with this decline or '
          + 'not at all. Marking the claim handled will keep the refusal outstanding either way.'),
    metadata: { ...key, handPostClaimedAt: claimedAt.toISOString(), handPostClaimedBy: claimedBy, postponementCounted: counted },
  }).catch(() => { /* an audit line that cannot be written must not fail the enqueue it describes */ })
}
