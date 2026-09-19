import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import type { PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'

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
    /** o3d-j625 r7: read to honour a suppression (a posting marked handled). Optional for older doubles. */
    findUnique?(args: {
      where: { type_referenceType_referenceId_scope: PostingRefusalKey }
      select: { suppressedAt: true; resolvedBy: true }
    }): Promise<{ suppressedAt: Date | null; resolvedBy: string | null } | null>
  }
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
   */
  withSavepoint?: <T>(fn: () => Promise<T>) => Promise<T>
}

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
 * Record a refused posting as outstanding.
 *
 * Re-refusing REOPENS the row rather than leaving a resolved one behind: the posting is owed again, and a
 * row that says otherwise because it was once cleared is the silence this table exists to end.
 */
export async function recordAccountingPostingRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  record: AccountingPostingRefusalRecord,
  options?: RecordRefusalOptions,
): Promise<void> {
  const now = new Date()
  await guarded('recording', key, options, async () => {
    // o3d-j625 r7 — A POSTING MARKED HANDLED STAYS HANDLED. Someone asserted they posted it by hand, and
    // IMS will never post it (posting-suppression.ts), so a later refusal of the same key is not new
    // debt: recording it would reopen a row whose only remedy has already been carried out. Reported, not
    // recorded. (A mark committing between this read and the upsert below would leave the row reopened;
    // the suppression column is not in the upsert, so it survives, and nothing can be posted twice.)
    const existing = typeof client.accountingPostingRefusal.findUnique === 'function'
      ? await client.accountingPostingRefusal.findUnique({
        where: { type_referenceType_referenceId_scope: key },
        select: { suppressedAt: true, resolvedBy: true },
      })
      : null
    if (existing?.suppressedAt) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_posting_refused_after_handled_by_hand',
        tag: 'accounting',
        level: 'INFO',
        description:
          `${key.type} for ${key.referenceType} ${key.referenceId} was refused again, but it was marked handled — `
          + `posted by hand — on ${existing.suppressedAt.toISOString()}. Nothing is owed and nothing was recorded.`,
        metadata: { ...key, reason: record.reason },
      }).catch(() => { /* nothing else to try */ })
      return
    }
    if (!options?.mergeOnly) {
      // review M-13: a resolved row being refused again is a NEW episode. Reset before the increment, so
      // `firstRefusedAt` is when THIS gap opened and the count is this episode's.
      await client.accountingPostingRefusal.updateMany({
        where: { ...key, resolvedAt: { not: null } },
        // r6 (review H4): a row someone MARKED HANDLED reopens the same way — the same posting refused again
        // is a new debt, whoever closed the last one. (How it was closed is cleared with `resolvedAt`, below.)
        data: { firstRefusedAt: now, refusedCount: 0, detail: null },
      })
    }
    await client.accountingPostingRefusal.upsert({
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
      update: options?.mergeOnly
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
          },
    })
  })
}

/**
 * Clear the outstanding row for a posting that has now been queued.
 *
 * Called from BOTH enqueues' success paths with a key derived from the enqueue's own params, and on the
 * in-transaction path with the transaction client so the clear commits with the sync row it is about — a
 * clear that survived a rolled-back enqueue would mark the debt paid over a posting never written.
 */
export async function clearAccountingPostingRefusal(
  client: PostingRefusalClient,
  key: PostingRefusalKey,
  options?: RecordRefusalOptions,
): Promise<void> {
  await guarded('clearing', key, options, async () => {
    await client.accountingPostingRefusal.updateMany({
      where: { ...key, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution: 'queued' },
    })
  })
}
