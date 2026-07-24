/**
 * Run every cleanup step even when one rejects.
 *
 * A `finally` block of sequential awaits abandons the rest of its cleanup on the first transient failure,
 * which is how a full-chain test leaves the rig dirtier than it found it. The steps that matter most tend to
 * be LAST — restoring a Setting the test deliberately perturbed — and skipping those does not just lose
 * cleanup, it poisons later runs: X-04 captures the drift snapshot as its "prior" state, so a snapshot left
 * pointing at a deleted, deliberately-drifted rate is then faithfully restored by every subsequent run
 * (Codex). Global teardown voids Xero documents; it does not repair IMS state.
 *
 * So: attempt all, collect failures, then throw once with every failure named — cleanup stays LOUD, but a
 * failure in step 1 can no longer silently cancel step 4.
 */
export async function runAllCleanups(
  label: string,
  steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>,
): Promise<void> {
  const failures: string[] = []
  for (const [what, fn] of steps) {
    try {
      await fn()
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length) {
    throw new Error(`${label} cleanup failed (every step was still attempted):\n  ${failures.join('\n  ')}`)
  }
}
