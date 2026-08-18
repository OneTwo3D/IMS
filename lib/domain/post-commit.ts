import { unstable_rethrow } from 'next/navigation'

/**
 * THE ONE PLACE A POST-COMMIT STEP IS ALLOWED TO FAIL (o3d-osl8 round 9, findings 1 and 4).
 *
 * A "post-commit step" is anything a write still owes AFTER its transaction has committed: an
 * activity-log row, a `revalidatePath`, an OS crontab reconciliation. Every one of them is an
 * `await` that can reject, and every rejection escaping the action turns a DURABLE write into a
 * rejected server action — which the caller can only read as "the outcome is unknown", the one
 * thing that is certainly false.
 *
 * Rounds 7 and 8 fixed that at the sites someone remembered to look at: first one call site, then
 * one screen, then four. Round 9 found `setSetting` — which commits an upsert and then awaits
 * `logActivity` and `revalidatePath` — still doing it, under three screens the sweep had declared
 * clean. So the guard is not a shape to be re-typed per site; it is this function, and the
 * structural test in tests/settings/post-commit-contract.test.ts fails when a settings writer grows
 * a post-commit `await` outside it.
 *
 * WHY THE CATCH IS NOT A CATCH-ALL. Round 8's version mapped EVERY throwable to a failure outcome,
 * including Next's control-flow exceptions: `redirect()`, `notFound()`, `forbidden()` and the
 * dynamic-rendering bailouts all signal by THROWING, and a post-commit step that re-enters a
 * permission gate raises exactly those. Swallowing a `NEXT_REDIRECT` leaves an operator with an
 * invalidated or 2FA-unverified session sitting on a page reading "saved, but the scheduler is
 * behind" instead of at the challenge. `unstable_rethrow` is Next's own predicate for that set —
 * it rethrows framework control flow and returns silently for ordinary errors — so it runs FIRST,
 * before anything is classified.
 */
export type PostCommitOutcome =
  /** The write committed and everything it owed afterwards was done. */
  | { status: 'ok' }
  /**
   * The write COMMITTED. A step after it did not, so a derived artefact — the audit row, the
   * rendered cache, the OS crontab — may lag the stored value until an operator re-applies it.
   * Never a failed save.
   */
  | { status: 'failed'; error: string }

/**
 * Run `step` after a commit and classify it, converting a rejection into a returned outcome.
 *
 * `step` may itself RETURN `{ success: false }` (that is `syncCrontab`'s shape); returned and
 * thrown produce the identical outcome, which is the invariant rounds 8 and 9 are enforcing.
 */
export async function runPostCommit(
  step: () => Promise<void | { success: boolean; error?: string }>,
  fallbackError: string,
): Promise<PostCommitOutcome> {
  try {
    const result = await step()
    if (result && result.success === false) return { status: 'failed', error: result.error ?? fallbackError }
    return { status: 'ok' }
  } catch (error) {
    // FIRST. See the note above: a swallowed redirect is a security-relevant lie, not a warning.
    unstable_rethrow(error)
    return { status: 'failed', error: error instanceof Error ? error.message : fallbackError }
  }
}
