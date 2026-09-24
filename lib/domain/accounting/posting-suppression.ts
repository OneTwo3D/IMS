import type { Prisma } from '@/app/generated/prisma/client'
import { ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { withSavepoint } from '@/lib/db/savepoint'
import type { PostingRefusalKey } from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-j625 r7 (owner decision 2026-09-19, "Handled + stop retry") — A POSTING SOMEONE POSTED BY HAND IS
 * NEVER POSTED BY IMS.
 *
 * Marking a refused posting handled is an operator's assertion: "I posted this, by hand, in the ledger".
 * Several refused postings are ALSO retried by IMS (a sweep, the landed-cost outbox, a refund retry, a
 * follow-up). Before r7 the two could both happen, and a hand-posted journal was then posted a second
 * time by the retry. So the mark sets `accounting_posting_refusals.suppressedAt` for the EXACT posting key
 * (lib/accounting/posting-key.ts), and this module is how every writer of an accounting sync row asks
 * about it — createAccountingSyncLogRow calls it before every create, so no path can post around it.
 *
 * SERIALISED WITH THE MARK. Both sides take the same transaction-scoped advisory lock on the posting key
 * (ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE) before they read or write: the mark cancels any
 * unposted row and sets the suppression under it, and a create reads the suppression under it, so a row
 * cannot be written between the mark's cancellation and its commit. On a client that is not in a
 * transaction the lock is released at once; every production caller of the primitive is in one.
 *
 * ── o3d-j625 r8 (Codex HIGH) — A READ THAT FAILS REFUSES. IT USED TO MEAN "NOT SUPPRESSED". ──
 *
 * r7 logged a failed lookup and returned `{ suppressed: false }`, and `createAccountingSyncLogRow` then
 * created a PENDING sync row for the posting. So a lookup that failed AFTER an operator marked the
 * posting handled — while the insert itself succeeded — queued, durably, exactly the posting the
 * "Handled + stop retry" decision exists to stop IMS posting. Measured against a real Postgres
 * transaction with the failure injected on that one query: one PENDING row, committed. The savepoint
 * this read runs under is what made it survivable enough to reach the insert.
 *
 * r7's argument for the degrade was that the only realistic failure is code running ahead of
 * `migrate deploy`, when nothing can be suppressed yet, so refusing would be an outage for a guard with
 * nothing to guard. THAT PREMISE IS FALSE FOR THIS DEPLOYMENT. scripts/deploy.sh builds, then STOPS the
 * application, and only then migrates (the order is asserted in tests/scripts/deploy-order.test.ts:
 * "deploy.sh builds and validates before it stops anything, and migrates only once stopped"), precisely
 * so that no binary ever serves against a schema it disagrees with. A read that fails at runtime is
 * therefore not a schema that has not caught up; it is a state that cannot be read — a lost connection,
 * a lock timeout, a statement timeout, an aborted transaction — and "cannot be read" is not "nothing was
 * marked".
 *
 * It throws {@link PostingSuppressionUnreadableError}, and NOTHING here catches it:
 *
 *   • The caller's transaction rolls back. Nothing commits — not the sync row, and not the business
 *     writes it was queued alongside — so IMS and the ledger stay in step and there is nothing to
 *     reconcile afterwards. Whatever drives the operation (a sweep, the landed-cost outbox, a follow-up,
 *     an operator re-submitting) tries again, which is the right response to a transient read failure.
 *   • THE ALTERNATIVE — refusing just this enqueue with `{ queued: false, reason: 'refused' }` and letting
 *     the caller commit — was rejected. It converts an infrastructure blip into durable operator work;
 *     the record of that work is an upsert into the very table that has just proved unreadable
 *     (recordAccountingPostingRefusal reads `suppressedAt` first), so in the realistic failure mode the
 *     refusal is not recorded at all and only logged; and it leaves IMS-side state committed against a
 *     ledger that never got the posting. A refusal has to be visible and retryable; this one would be
 *     neither.
 *   • WHAT IT MUST NEVER BECOME is `{ queued: true, reason: 'handled-by-hand' }`. That answer means "a
 *     counterpart exists in the ledger, stop retrying": `postingIsOwed()` reads it as nothing owed and the
 *     landed-cost outbox stops re-driving. It is reachable ONLY from a positive `suppressed: true` read
 *     (lib/accounting.ts, and the `null` return of createAccountingSyncLogRow, which only a positive read
 *     produces). An unreadable state can no longer reach it, because it no longer returns at all.
 *
 * The failure is still logged before it is thrown — the exception surfaces where the call was made, the
 * activity entry says which posting could not be checked.
 */
export type PostingSuppressionClient = {
  $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  accountingPostingRefusal?: {
    findUnique(args: {
      where: { type_referenceType_referenceId_scope: PostingRefusalKey }
      select: { suppressedAt: true; resolvedBy: true }
    }): Promise<{ suppressedAt: Date | null; resolvedBy: string | null } | null>
  }
}

/**
 * o3d-j625 r8 — WHY THE TWO OPTIONAL MEMBERS ABOVE ARE NOT A SECOND WAY TO FAIL OPEN.
 *
 * `readPostingSuppression` answers "not suppressed" when the client carries no `accountingPostingRefusal`
 * delegate, and `lockPostingKey` returns without a lock when it carries no `$executeRaw`. Both are
 * capability checks for TEST DOUBLES — a structural double that implements only `accountingSyncLog` — and
 * both would be a failure treated as permission if a REAL client could take them.
 *
 * It cannot, and this is the proof rather than the assertion: every production caller passes a Prisma
 * client or an interactive transaction client, and this type error fires if either member ever stops
 * being present on one. It costs nothing at runtime (a type-only import) and is checked by `tsc`.
 */
type AssertTrue<T extends true> = T
export type PrismaClientCanAlwaysReadTheSuppression = AssertTrue<
  Prisma.TransactionClient extends {
    $executeRaw: (query: TemplateStringsArray, ...values: never[]) => unknown
    accountingPostingRefusal: { findUnique: (args: never) => unknown }
  } ? true : false
>

/**
 * THROWN when the suppression state could not be read, so nothing may be posted (o3d-j625 r8, Codex HIGH).
 *
 * Retryable in the strict sense: it is raised BEFORE any write this module's callers make, so a caller
 * that sees it has queued nothing, changed nothing and may simply attempt the same enqueue again.
 */
export class PostingSuppressionUnreadableError extends Error {
  /** For a caller deciding whether to re-drive: nothing happened, so re-driving is safe. */
  readonly retryable = true
  readonly posting: PostingRefusalKey
  /** The underlying failure, kept for the caller's own logging. */
  readonly reason: string

  constructor(key: PostingRefusalKey, cause: unknown) {
    const reason = describeSuppressionReadFailure(cause)
    super(
      `IMS could not read whether ${key.type} for ${key.referenceType} ${key.referenceId} had already been `
      + 'posted by hand, so it refused to queue it rather than risk posting it twice. Nothing was written; '
      + `this can be retried. Cause: ${reason}`,
    )
    this.name = 'PostingSuppressionUnreadableError'
    this.posting = key
    this.reason = reason
  }
}

/**
 * What went wrong, in one line that is never blank.
 *
 * `message` alone is not enough: measured against `@prisma/adapter-pg`, a raw-query failure inside a
 * transaction arrives as an Error whose `message` is the EMPTY STRING, so the r8 refusal's first draft
 * read "Cause: " and named nothing. The error code is where the information actually is (o3d-5od is the
 * same lesson about `meta.target`), so it leads, and the class name stands in when there is no text.
 */
function describeSuppressionReadFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const code = (cause as { code?: unknown }).code
  const driverCode = (cause as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    .meta?.driverAdapterError?.cause?.originalCode
  const text = cause.message.trim() || cause.name
  const codes = [code, driverCode].filter((value) => typeof value === 'string' && value.length > 0)
  return codes.length > 0 ? `${codes.join('/')}: ${text}` : text
}

/** A stable 32-bit id for a posting key, for the lock's second argument. */
export function postingKeyLockId(key: PostingRefusalKey): number {
  const value = [key.type, key.referenceType, key.referenceId, key.scope].join('|')
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  return hash
}

export async function lockPostingKey(client: PostingSuppressionClient, key: PostingRefusalKey): Promise<void> {
  if (typeof client.$executeRaw !== 'function') return
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE}, ${postingKeyLockId(key)})`
}

export type PostingSuppression = { suppressed: false } | { suppressed: true; at: Date; by: string | null }

export async function readPostingSuppression(
  client: PostingSuppressionClient,
  key: PostingRefusalKey,
): Promise<PostingSuppression> {
  const table = client.accountingPostingRefusal
  if (!table || typeof table.findUnique !== 'function') return { suppressed: false }
  try {
    // The savepoint is still here, and its job is unchanged: a failed statement inside a Postgres
    // transaction aborts it (25P02), so without it the caller could not even roll back cleanly, and the
    // error that reached them would be an opaque one about a later statement. It makes the failure
    // REPORTABLE; it is not permission to carry on past it.
    const row = await withSavepoint(client, () => table.findUnique({
      where: { type_referenceType_referenceId_scope: key },
      select: { suppressedAt: true, resolvedBy: true },
    }))
    return row?.suppressedAt ? { suppressed: true, at: row.suppressedAt, by: row.resolvedBy } : { suppressed: false }
  } catch (error) {
    const { logActivity } = await import('@/lib/activity-log')
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_posting_suppression_unreadable',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `Could not read whether ${key.type} for ${key.referenceType} ${key.referenceId} was posted by hand, so `
        + `IMS did NOT queue it: an unreadable suppression is not permission to post. Nothing was written and `
        + `this can be retried. Cause: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { ...key },
    }).catch(() => { /* nothing else to try — and a failed report must not soften the refusal below */ })
    throw new PostingSuppressionUnreadableError(key, error)
  }
}

/** The activity entry every refused automatic enqueue of a hand-posted posting writes. */
export async function reportSuppressedPosting(key: PostingRefusalKey, suppression: Extract<PostingSuppression, { suppressed: true }>): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_posting_suppressed_handled_by_hand',
    tag: 'accounting',
    level: 'INFO',
    description:
      `IMS did NOT post ${key.type} for ${key.referenceType} ${key.referenceId}: it was marked handled — posted `
      + `by hand in the ledger — on ${suppression.at.toISOString()}, so posting it again would post it twice.`,
    metadata: { ...key, suppressedAt: suppression.at.toISOString(), markedBy: suppression.by },
  }).catch(() => { /* a report that cannot be written must not turn a suppression into a post */ })
}
