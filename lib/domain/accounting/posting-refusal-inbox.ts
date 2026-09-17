import type { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-j625 r4 — A REFUSED POSTING IS OUTSTANDING WORK, NOT A LOG LINE.
 *
 * Rounds 2-4 taught the accounting enqueues to REFUSE rather than write a row into books that cannot
 * describe it, and reported every refusal to the Activity log. That is the right decision and the wrong
 * surface: the Activity page is a thing somebody has to already be looking at, and the refusals that
 * matter most are the ones nobody is looking for. The WooCommerce held-invoice release is the case that
 * settled it — it refuses days after the order imported, on a sweep, with no operator present.
 *
 * So each refusal also upserts a row in `AccountingPostingRefusal`, which the exception inbox — the
 * surface that already exists for "work IMS owes and nothing will re-drive" — lists beside the follow-up
 * obligations it already shows. Deliberately NOT a new UI surface, and deliberately not a re-shaped one:
 * the inbox row carries the same five things every other row there carries (what, which reference, since
 * when, why, what to do).
 *
 * WHY A ROW AND NOT A QUERY. Every other inbox section selects rows some writer already persists — a
 * dead-lettered push, a parked refund, a sync row carrying a follow-up marker. A refusal persists NOTHING
 * by construction: refusing is exactly the decision not to write the row. There is no existing table to
 * select from, so the durable record has to be created; this is that record, and it is queried the same
 * way everything else in the inbox is.
 *
 * WHAT IT CARRIES, AND WHY BOTH CONNECTORS. Round 2's warning named the chart the payload was built from
 * and not the connector now active — half the fact. An operator reading "built from Xero's chart" cannot
 * tell whether to switch the selection back or re-raise the posting in the other books until they are
 * told what IS active. Both are columns here.
 *
 * ONE OPEN ROW PER POSTING, AND IT CLEARS WHEN THE POSTING IS MADE. The natural key is (type,
 * referenceType, referenceId): a sweep refusing the same release every five minutes updates one row and
 * increments `refusedCount` rather than filling the page. `resolvedAt` is stamped by the enqueue that
 * finally queues that posting — see {@link clearAccountingPostingRefusal}, called from both enqueues'
 * success paths — so nothing ages a row out on a timer and no operator has to tick it off.
 *
 * NOTHING HERE MAY THROW. A refusal has already happened; an inbox write that failed must not turn it
 * into an exception on the caller's path. Every entry point swallows, exactly as `logActivity` does.
 */

/** The Prisma surface these helpers need. Structural, so a transaction client or a double satisfies it. */
export type PostingRefusalClient = {
  accountingPostingRefusal: {
    upsert(args: {
      where: { type_referenceType_referenceId: { type: string; referenceType: string; referenceId: string } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }): Promise<unknown>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

export type AccountingPostingRefusalRecord = {
  /** The accounting document that was not queued. */
  type: string
  referenceType: string
  referenceId: string
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

/**
 * Record a refused posting as outstanding.
 *
 * Re-refusing the same posting REOPENS the row (`resolvedAt: null`) rather than leaving a resolved one
 * behind: the posting is owed again, and a row that says otherwise because it was once cleared is the
 * silence this table exists to end.
 */
export async function recordAccountingPostingRefusal(
  client: PostingRefusalClient,
  record: AccountingPostingRefusalRecord,
): Promise<void> {
  const now = new Date()
  try {
    await client.accountingPostingRefusal.upsert({
      where: {
        type_referenceType_referenceId: {
          type: record.type,
          referenceType: record.referenceType,
          referenceId: record.referenceId,
        },
      },
      create: {
        type: record.type,
        referenceType: record.referenceType,
        referenceId: record.referenceId,
        chartConnector: record.chartConnector,
        activeConnector: record.activeConnector,
        reason: record.reason,
        committed: record.committed,
        remedy: record.remedy,
        detail: (record.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        firstRefusedAt: now,
        lastRefusedAt: now,
      },
      update: {
        // The LATEST facts about the same owed posting. A later refusal can have a different active
        // connector from the first — that is the fact an operator acts on, so it is the one kept.
        chartConnector: record.chartConnector,
        activeConnector: record.activeConnector,
        reason: record.reason,
        committed: record.committed,
        remedy: record.remedy,
        detail: (record.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        lastRefusedAt: now,
        resolvedAt: null,
        refusedCount: { increment: 1 },
      },
    })
  } catch {
    // An inbox write that cannot happen must not become the caller's exception: the refusal itself has
    // already been decided, and the Activity record of it is written separately.
  }
}

/**
 * Clear the outstanding row for a posting that has now been queued.
 *
 * Called from BOTH enqueues' success paths, with the transaction client on the in-transaction one so the
 * clear commits with the sync row it is about — a clear that survived a rolled-back enqueue would mark
 * the debt paid over a posting that was never written.
 */
export async function clearAccountingPostingRefusal(
  client: PostingRefusalClient,
  posting: { type: string; referenceType: string; referenceId: string },
): Promise<void> {
  try {
    await client.accountingPostingRefusal.updateMany({
      where: {
        type: posting.type,
        referenceType: posting.referenceType,
        referenceId: posting.referenceId,
        resolvedAt: null,
      },
      data: { resolvedAt: new Date() },
    })
  } catch {
    // Same rule as the write: the posting IS queued, and failing to tidy the inbox row must not undo it.
  }
}
