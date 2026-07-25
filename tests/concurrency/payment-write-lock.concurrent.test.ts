import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The payment-write lock serializes the payment poll and the backlog reconcile (o3d-2s8). A session
 * advisory lock only works if acquire and release land on the SAME connection — through a Prisma
 * pool they may not, which silently leaks the lock and wedges every future poll (Codex review #496
 * round 3). This proves the connection-pinned helper is genuinely mutually exclusive under
 * concurrency and releases cleanly. Gated behind RUN_DB_CONCURRENCY_TESTS=1 (needs a real Postgres).
 */
test(
  'payment-write lock: mutually exclusive under concurrency, releases cleanly',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { withPaymentWriteLockOrSkip, isLockSkipped } = await import('../../lib/connectors/xero/payment-write-lock.ts')

    let concurrent = 0
    let maxConcurrent = 0
    const hold = (label: string) =>
      withPaymentWriteLockOrSkip(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 300)) // hold long enough that the two overlap
        concurrent--
        return label
      })

    // Two holders contend at the same instant.
    const [a, b] = await Promise.all([hold('A'), hold('B')])
    const outcomes = [a, b].map((r) => (isLockSkipped(r) ? 'SKIPPED' : r))

    assert.equal(maxConcurrent, 1, 'never more than one holder inside the lock')
    assert.equal(outcomes.filter((o) => o === 'SKIPPED').length, 1, 'exactly one contender skips')
    assert.ok(outcomes.includes('A') || outcomes.includes('B'), 'one contender runs')

    // A later acquisition must succeed — proves both prior holders released (no leak).
    const c = await withPaymentWriteLockOrSkip(async () => 'C')
    assert.equal(isLockSkipped(c), false, 'lock is free again after the contention — it did not leak')
  },
)
