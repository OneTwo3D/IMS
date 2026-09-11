/**
 * A CLEANUP FAILURE MUST NOT REPLACE THE FAILURE IT FOLLOWS (o3d-n3yt r20, Codex r19 MEDIUM).
 *
 * The shape this exists to remove:
 *
 *   try { ...assertions... } finally { await db.thing.deleteMany({ ... }) }
 *
 * An awaited rejection inside `finally` OVERRIDES an error already propagating out of the block. The
 * run stays red, so nothing is lost from the pass/fail verdict — but the report names the cleanup and
 * not the assertion, and the assertion is the finding. On the retention evidence test that is the
 * diagnostic equivalent of the defect the branch is closing: a real failure replaced by a misleading
 * one, with nothing saying a substitution took place.
 *
 * WHAT THIS DOES, IN THE THREE CASES THAT EXIST:
 *
 *   1. body succeeds, cleanup succeeds  -> the body's value.
 *   2. body succeeds, cleanup FAILS     -> the cleanup error is thrown. A cleanup that did not run is
 *                                          rows left in a shared database, and nothing else would say
 *                                          so.
 *   3. body FAILS, cleanup FAILS        -> the BODY's error propagates, unchanged in type, stack and
 *                                          assertion fields, with the cleanup failure appended to its
 *                                          message, attached as `cleanupFailure`, and written to
 *                                          stderr. Both are reported; only one of them is the finding.
 */

/** The property the body's error carries when a cleanup failed alongside it. */
export const CLEANUP_FAILURE_KEY = 'cleanupFailure'

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failure: { error: unknown } | undefined
  try {
    return await body()
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Case 2: nothing else is propagating, so this IS the finding.
      if (failure === undefined) throw cleanupError
      // Case 3: it is a note on the finding, and must not become the finding.
      const note =
        'the cleanup after this failure ALSO failed, so rows it was meant to remove may have been '
        + `left behind: ${describe(cleanupError)}`
      console.error(`[withCleanup] ${note}`)
      if (failure.error instanceof Error) {
        failure.error.message = `${failure.error.message}\n\n[${note}]`
        Object.defineProperty(failure.error, CLEANUP_FAILURE_KEY, {
          value: cleanupError,
          enumerable: false,
          configurable: true,
          writable: true,
        })
      }
      // Deliberately NOT rethrown: leaving `finally` normally lets the body's error continue.
    }
  }
}
