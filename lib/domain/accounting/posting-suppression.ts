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
 * A READ THAT FAILS IS "NOT SUPPRESSED", reported. The table exists before any row can be suppressed, so
 * the only realistic failure is code ahead of `migrate deploy`, when nothing can be suppressed yet;
 * refusing every posting then would be an outage for a guard with nothing to guard. Run under a savepoint
 * so the failure cannot abort the caller's transaction (25P02).
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
        `Could not read whether ${key.type} for ${key.referenceType} ${key.referenceId} was posted by hand; it `
        + `was treated as NOT handled. Cause: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { ...key },
    }).catch(() => { /* nothing else to try */ })
    return { suppressed: false }
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
