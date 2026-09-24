import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import type { PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'
import { accountingPostingKeyForRow } from '@/lib/accounting/posting-key'
import { runUnderPostingKeyLock, type PostingKeyLockClient } from '@/lib/domain/accounting/posting-suppression'
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
      select: { suppressedAt: true; resolvedBy: true; resolvedAt?: true; resolution?: true }
    }): Promise<{ suppressedAt: Date | null; resolvedBy: string | null; resolvedAt?: Date | null; resolution?: string | null } | null>
  }
  /**
   * o3d-j625 r9 — THE ACCOUNTING SYNC LOG, read only when the posting key was CONTENDED.
   *
   * A refusal racing the FIRST successful enqueue of a posting has no resolved row to learn from: the
   * enqueue's clear matched nothing, because no refusal row existed yet. The evidence that the posting is
   * nonetheless queued is the sync row itself. Optional, so a structural double is unchanged — and read
   * only under contention, never as a blanket "a row exists, so nothing is owed" (see the header).
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
    select: { payload: true; createdAt: true }
  }): Promise<Array<{ payload: unknown; createdAt: Date }>>
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
   * o3d-j625 r9 — WHEN THE REFUSAL WAS DECIDED, not when it is being written.
   *
   * A refusal is decided from state read before this call, and the write can land arbitrarily later: after
   * an await, after a report, after waiting for this posting's lock. If the posting was QUEUED inside that
   * window the refusal is stale, and reopening the row would be a debt nobody owes. The enqueue funnels
   * pass the moment the enqueue began; every other site gets the moment this call began, which is the
   * shortest honest answer available where nothing carries one.
   */
  decidedAt?: Date
  /**
   * o3d-j625 r10 — THE POSTING KEY WAS HELD BY ANOTHER TRANSACTION WHEN THIS REFUSAL WAS DECIDED.
   *
   * Set only by `reconcileProvisionalPostingRefusals`, replaying a refusal whose in-transaction call
   * could not take the key. By the time the replay runs that transaction has ended and the key is free,
   * so the replay looks UNCONTENDED and would not otherwise consult the accounting sync log — the one
   * piece of evidence a FIRST refusal racing a FIRST enqueue can have. This carries the contention
   * forward so the replay reaches the same answer the original call would have, had it been allowed to
   * wait for the key.
   */
  contendedWhenDecided?: boolean
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
 * Was this posting QUEUED after this refusal was decided — on the evidence of the accounting sync log
 * rather than of the refusal row?
 *
 * Scoped the same way the mark scopes its candidates (posting-mark-handled.ts): the indexed columns
 * narrow it, and `accountingPostingKeyForRow` — the same function the row-creating primitive keys its
 * clear on — decides whether a row belongs to this posting or to a different one sharing the document.
 * `false` when the client cannot answer (a structural double), which records as before.
 *
 * A LIVE ROW IS NOT ON ITS OWN THE ANSWER, and this is the "what would still pass it" question the
 * header asks. Several types share ONE key across successive postings by design (SALES_INVOICE_UPDATE,
 * PURCHASE_INVOICE_UPDATE, BILL_PAYMENT — lib/accounting/posting-key.ts): edit 1 queues, its row stays
 * live forever, edit 2 is refused, and the ledger now holds a stale document. That refusal is a REAL
 * debt. So the row must post-date the refusal, in one of the two ways a row can:
 *
 *  • IT WAS CREATED AFTER THE REFUSAL WAS DECIDED (`createdAt` beats the decision). This is the
 *    direct answer, and it is what closes r9's residual — a successful enqueue that both started and
 *    committed in the gap between the decision and this call, taking the key uncontended, used to be
 *    recorded as a debt that was already discharged.
 *  • OR THE KEY WAS CONTENDED when the refusal was decided, which means another transaction was
 *    settling this exact posting at that moment. Its row may have been created BEFORE the decision and
 *    committed after — commit order is not a thing PostgreSQL exposes here (no `track_commit_timestamp`,
 *    which must stay off), so contention is the only evidence there is, and it is exact evidence: this
 *    call, or the in-transaction call this one is replaying, actually queued for that key.
 *
 * CLOCK DOMAINS, because the first arm crosses one. `decidedAt` is an application clock (`new Date()` in
 * a Node process) and `accounting_sync_logs.createdAt` is a DATABASE clock (`@default(now())`), so
 * comparing them directly would make a skew between the two into a rule about which debts are kept — and
 * the dangerous direction (a database clock running ahead) is the one that SWALLOWS a real debt. The
 * comparison is therefore made entirely in database time: the cutoff is the database's own clock minus
 * the age of the decision as measured on the application clock, so only an INTERVAL crosses the boundary
 * and the offset cancels.
 */
async function postingQueuedAfterThisRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  options: { decidedAt: Date; contended: boolean },
): Promise<boolean> {
  // The delegate is never bound to a local: tests/accounting/sync-log-row-primitive.test.ts reports any
  // such binding, because a `.create` reached through one is invisible to it. Every use of it here is
  // visible at the access site, and both of them are reads.
  const reader = client as { accountingSyncLog?: SyncLogReader }
  if (typeof reader.accountingSyncLog?.findMany !== 'function') return false
  const rows = await reader.accountingSyncLog.findMany({
    where: {
      type: key.type,
      referenceType: key.referenceType,
      referenceId: key.referenceId,
      status: { not: 'CANCELLED' },
    },
    select: { payload: true, createdAt: true },
  })
  const forThisPosting = rows.filter((row) => accountingPostingKeyForRow({ ...key, payload: row.payload }).scope === key.scope)
  if (forThisPosting.length === 0) return false
  if (options.contended) return true
  const cutoff = await databaseTimeOf(client, options.decidedAt)
  if (!cutoff) return false
  return forThisPosting.some((row) => row.createdAt instanceof Date && row.createdAt.getTime() > cutoff.getTime())
}

/**
 * `at` expressed on the DATABASE's clock: the database's clock now, less however long ago `at` was here.
 *
 * `clock_timestamp()`, NEVER `now()`. `now()` is `transaction_timestamp()` — the moment THIS TRANSACTION
 * began — and on the in-transaction path that transaction is the CALLER'S: a goods receipt or an MO
 * completion that may have started minutes before this refusal was decided. The cutoff would then sit
 * minutes in the past, and rows created well BEFORE the decision would count as having come after it,
 * which is the direction that swallows a real debt.
 *
 * `null` when the client cannot be asked, which leaves the comparison unmade and the refusal RECORDED —
 * the direction that keeps a debt rather than losing one.
 */
async function databaseTimeOf(client: PostingRefusalClient, at: Date): Promise<Date | null> {
  const raw = client as { $queryRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> }
  if (typeof raw.$queryRaw !== 'function') return null
  const rows = await raw.$queryRaw`SELECT clock_timestamp() AS at` as Array<{ at?: unknown }> | undefined
  const databaseNow = rows?.[0]?.at
  if (!(databaseNow instanceof Date)) return null
  return new Date(databaseNow.getTime() - (Date.now() - at.getTime()))
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
 *   2. QUEUED WHILE THIS REFUSAL WAS IN FLIGHT — the posting was queued after this refusal was decided,
 *      on the evidence of the refusal row's own resolution or of the accounting sync log. Then the
 *      refusal is stale. `postingQueuedAfterThisRefusal` states exactly what counts as that evidence.
 *   3. CONTENDED AND UNABLE TO WAIT — inside a caller's transaction, a key another transaction holds.
 *      Nothing can be read that will still be true, so nothing is written HERE; since r10 the refusal is
 *      instead persisted with the caller's own transaction and replayed under the key (see below).
 *
 * WHAT IS DELIBERATELY *NOT* CHECKED, and why (the "what would still pass it" question). Not "is there a
 * live sync row for this key" on its own. Several types share one key across successive postings by
 * design (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT — see lib/accounting/posting-key.ts):
 * edit 1 queues and clears the row, edit 2 is refused, and the ledger now holds a stale document. That
 * refusal is a REAL debt, and a blanket "a live row exists, so nothing is owed" would swallow it — the
 * table's whole purpose, lost to a guard meant to protect it. Only a posting that can be shown to have
 * been queued AFTER this refusal was decided supersedes it.
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
 * r9's RESIDUAL WINDOW IS CLOSED BY THE SAME ROUND, and it had to be: a refusal decided before a
 * successful enqueue that both started and committed in the gap before this call took the key
 * UNCONTENDED used to be recorded as a debt that was in fact discharged. The reconciler runs minutes
 * after the claim, uncontended by then, so leaving that window open would have turned it from a rare race
 * into the ordinary path. `postingQueuedAfterThisRefusal` now compares the sync row's own creation
 * against the moment this refusal was decided, in database time, which answers the case the contention
 * probe could not see.
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
      { callerTransaction: Boolean(options?.withSavepoint) },
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
            { decidedAt, mergeOnly: options?.mergeOnly === true, nonce: randomUUID() },
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
        // 2. QUEUED WHILE THIS REFUSAL WAS IN FLIGHT (r9). See the header for why a live sync row on its
        //    own is NOT this check.
        //
        //    STRICTLY LATER, not "at or after". These timestamps are milliseconds, and a refusal decided in
        //    the SAME millisecond as the clear is the ordinary fast case, not a race — measured: the r5 M-13
        //    test (refuse, queue, refuse again through in-memory doubles) runs all of it inside one
        //    millisecond, and `>=` swallowed the third refusal, losing a real debt. A tie is therefore
        //    recorded, and the CONTENDED case below — which needs no clock at all — is what covers a race
        //    this comparison is too coarse to see.
        //
        //    `lock.contended` is deliberately NOT an alternative here. A mutation that removed it changed
        //    nothing measurable (the contended check below caught the same case), and in one state it would
        //    be WRONG: a row resolved as `queued` whose sync row was CANCELLED afterwards is owed again, and
        //    the sync-log check below sees that where "it was once queued" cannot.
        if (
          existing?.resolvedAt
          && existing.resolution === 'queued'
          && existing.resolvedAt.getTime() > decidedAt.getTime()
        ) {
          return { recorded: false, because: 'queued', at: existing.resolvedAt }
        }
        // And the FIRST refusal of a posting that was queued concurrently has no resolved row to learn
        // from — the enqueue's clear matched nothing because there was no row yet. The sync log is the
        // evidence, and `postingQueuedAfterThisRefusal` states exactly what makes a live row count:
        // it was created after this refusal was decided, or the key was contended when it was.
        if (lock.held && await postingQueuedAfterThisRefusal(locked as unknown as PostingRefusalClient, key, {
          decidedAt,
          contended: lock.contended || options?.contendedWhenDecided === true,
        })) {
          return { recorded: false, because: 'queued', at: existing?.resolvedAt ?? now }
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
        `${key.type} for ${key.referenceType} ${key.referenceId} was refused, but the posting was queued at `
        + `${outcome.at.toISOString()}, while this refusal was being decided. The posting is in the accounting `
        + 'sync log, nothing is owed, and nothing was recorded as outstanding.',
      metadata: { ...key, reason: record.reason, queuedAt: outcome.at.toISOString() },
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
 */
export async function clearAccountingPostingRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  options?: RecordRefusalOptions,
): Promise<void> {
  await guarded('clearing', key, options, async () => {
    await runUnderPostingKeyLock(
      client as unknown as PostingKeyLockClient,
      key,
      { callerTransaction: Boolean(options?.withSavepoint) },
      async (locked) => {
        await (locked as unknown as PostingRefusalClient).accountingPostingRefusal.updateMany({
          where: { ...key, resolvedAt: null },
          data: { resolvedAt: new Date(), resolution: 'queued' },
        })
      },
    )
  })
}
