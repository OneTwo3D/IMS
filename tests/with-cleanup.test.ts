import assert from 'node:assert/strict'
import test from 'node:test'
import { CLEANUP_FAILURE_KEY, withCleanup } from './helpers/with-cleanup.ts'

/**
 * o3d-n3yt r20, Codex r19 MEDIUM: "an awaited rejection from `deleteMany` in `finally` overrides an
 * error already propagating from the assertions. The run stays red but reports only the cleanup
 * failure, hiding the retention regression that caused it."
 *
 * These are the three cases, and the third is the finding.
 */

test('the body value comes back when both halves succeed', async () => {
  const order: string[] = []
  const value = await withCleanup(
    async () => { order.push('body'); return 41 + 1 },
    async () => { order.push('cleanup') },
  )
  assert.equal(value, 42)
  assert.deepEqual(order, ['body', 'cleanup'], 'the cleanup runs, and runs after the body')
})

test('a cleanup that fails on a SUCCESSFUL body is thrown, because nothing else would say so', async () => {
  await assert.rejects(
    () => withCleanup(async () => 'fine', async () => { throw new Error('deleteMany failed') }),
    (error: unknown) => {
      assert.match((error as Error).message, /deleteMany failed/)
      return true
    },
  )
})

test('an assertion failure SURVIVES a simultaneous cleanup failure, and both are reported', async () => {
  // MUTATION ROUTE: rewrite withCleanup as `try { ... } finally { await cleanup() }`. This test then
  // reports "deleteMany failed" and the assertion below — the regression a reader has to see — is
  // gone from the output entirely, which is the r19 MEDIUM.
  const assertionFailure = new assert.AssertionError({
    message: 'a WooCommerce order delivery must survive the retention run whatever its age',
    operator: 'notDeepEqual',
  })
  const cleanupFailure = new Error('deleteMany failed: connection terminated')

  await assert.rejects(
    () => withCleanup(
      async () => { throw assertionFailure },
      async () => { throw cleanupFailure },
    ),
    (error: unknown) => {
      // THE FINDING IS THE ONE THAT PROPAGATES, unchanged in identity.
      assert.equal(error, assertionFailure, 'the propagating error is the assertion failure itself')
      assert.ok(error instanceof assert.AssertionError, 'and it is still an AssertionError')
      assert.match((error as Error).message, /a WooCommerce order delivery must survive the retention run/)
      // AND THE CLEANUP FAILURE IS REPORTED TOO, on the same error.
      assert.match((error as Error).message, /the cleanup after this failure ALSO failed/)
      assert.match((error as Error).message, /connection terminated/)
      assert.equal((error as unknown as Record<string, unknown>)[CLEANUP_FAILURE_KEY], cleanupFailure)
      return true
    },
  )
})

test('a non-Error body failure still propagates rather than being replaced by the cleanup failure', async () => {
  await assert.rejects(
    () => withCleanup(
      async () => { throw 'a string, thrown' },
      async () => { throw new Error('deleteMany failed') },
    ),
    (error: unknown) => {
      assert.equal(error, 'a string, thrown')
      return true
    },
  )
})
