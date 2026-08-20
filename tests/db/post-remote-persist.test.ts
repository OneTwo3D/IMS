import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isConnectionAcquisitionTimeout,
  persistAfterRemoteWrite,
  UnrecordedRemoteWriteError,
} from '@/lib/db/post-remote-persist'

/**
 * o3d-xl63 round 2, finding 2 — THE POOL BOUND MUST NOT REACH THE RECORD OF A COMPLETED POST.
 *
 * Round 1 gave the pool a 10s acquisition bound. That is right for a caller queueing to START work
 * and wrong for the caller that has ALREADY posted to Xero and is queueing only to write down what it
 * did: there, failing fast throws away the external id of a document the ledger holds, the row goes
 * back as FAILED, and the next attempt re-posts under an Idempotency-Key Xero forgot six minutes ago.
 * The bound would have manufactured the duplicate it was nowhere near thinking about.
 *
 * These drive the REAL pg.Pool for the same reason the round-1 test does: the behaviour under test is
 * that library's queueing and its exact rejection, not a string we compute.
 */

/** Enough of a `pg.Client` for pg-pool to hand out, connect and end. Never touches a socket. */
class StubClient extends EventEmitter {
  connect(callback: (error?: Error) => void) { callback() }
  end(callback?: () => void) { callback?.() }
  isConnected() { return true }
  query() { return Promise.resolve({ rows: [] }) }
  ref() {}
  unref() {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('a persist that follows a remote write survives an exhausted pool that would reject a pre-flight one', async (t) => {
  const { default: pg } = await import('pg')
  const { dbPoolConfig } = await import('@/lib/db')

  // The production config, with `max` narrowed so exhaustion is one checkout away and the bound
  // shortened so the real timer fires in milliseconds. The PRODUCTION value of that bound is pinned
  // by tests/db/pool-acquisition-bound.test.ts; what matters here is what happens WHEN it fires.
  const pool = new pg.Pool({ ...dbPoolConfig(), max: 1, connectionTimeoutMillis: 25, Client: StubClient as never })
  // pg-pool UNREFS its acquisition timer, so nothing it schedules keeps node alive. Without a ref'd
  // handle of our own the process would exit mid-test and the assertions below would never run — and
  // it is released in `after`, not at the end of the body, so a FAILING assertion still ends the run
  // instead of leaving the interval holding the loop open for ever (the revert of this fix fails here,
  // and a revert that hangs proves nothing).
  const keepAlive = setInterval(() => {}, 5)
  t.after(async () => {
    clearInterval(keepAlive)
    await pool.end().catch(() => {})
  })
  const held = await pool.connect()

  // 1. The shape of the failure, from the real pool: a pre-flight acquisition is DENIED.
  const preflight = await pool.connect().then(() => null, (error: Error) => error)
  assert.ok(preflight, 'the pool is full, so an ordinary acquisition rejects rather than waiting')
  assert.match(preflight!.message, /timeout exceeded when trying to connect/)
  assert.ok(isConnectionAcquisitionTimeout(preflight), 'and that is the failure the helper must recognise')

  // 2. The same acquisition, made to RECORD a completed remote write, must not be denied.
  let attempts = 0
  const denials: number[] = []
  const recorded = persistAfterRemoteWrite('xero sync log test-1 (INVOICE_PAYMENT)', async () => {
    attempts += 1
    const client = await pool.connect()
    client.release()
    return 'recorded'
  }, { deadlineMs: 5_000, retryDelayMs: 5, onRetry: (detail) => denials.push(detail.attempts) })

  // Pool pressure clears while it is still trying — which is the whole point: the connection was
  // never unavailable for ever, only for longer than a bound meant for work that had not started.
  await wait(120)
  held.release()

  assert.equal(await recorded, 'recorded', 'the record of the post is written instead of being lost')
  assert.ok(attempts > 1, `it had to outlive at least one denial to get there (attempts: ${attempts})`)
  assert.ok(denials.length > 0, 'and each denial is reported, so pool pressure this severe is not silent')
})

test('only a failure to ACQUIRE is re-driven — anything that may have executed is rethrown at once', async () => {
  let attempts = 0
  const duplicateKey = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })

  await assert.rejects(
    () => persistAfterRemoteWrite('xero sync log test-2 (SALES_INVOICE)', async () => {
      attempts += 1
      throw duplicateKey
    }, { deadlineMs: 5_000, retryDelayMs: 1 }),
    /duplicate key value/,
  )
  // The soundness argument for retrying is that no connection means no statement ran. A constraint
  // violation ran; repeating it for two minutes would be a second defect, not a fix.
  assert.equal(attempts, 1, 'a statement that already executed is never repeated')
})

test('a driver-adapter error is recognised through its cause chain, not just its own message', () => {
  // Prisma hands the driver's failure back wrapped, so the pg-pool text arrives as `cause`.
  const wrapped = new Error('Invalid `prisma.accountingSyncLog.update()` invocation', {
    cause: new Error('timeout exceeded when trying to connect'),
  })
  assert.equal(isConnectionAcquisitionTimeout(wrapped), true)
  assert.equal(
    isConnectionAcquisitionTimeout(new Error('Timed out fetching a new connection from the connection pool')),
    true,
    "Prisma's own pool bound says the same thing in different words",
  )
  assert.equal(isConnectionAcquisitionTimeout(new Error('connection terminated unexpectedly')), false,
    'a connection that DIED may have run the statement — that is not an acquisition timeout')
  assert.equal(isConnectionAcquisitionTimeout(null), false)
})

test('waiting for ever is not coming back: past the deadline it gives up, and says what was lost', async () => {
  let now = 0
  const attemptsAt: number[] = []

  await assert.rejects(
    () => persistAfterRemoteWrite('xero sync log test-3 (INVOICE_PAYMENT)', async () => {
      attemptsAt.push(now)
      throw new Error('timeout exceeded when trying to connect')
    }, {
      deadlineMs: 1_000,
      retryDelayMs: 250,
      now: () => now,
      sleep: async (ms: number) => { now += ms },
    }),
    (error: unknown) => {
      assert.ok(error instanceof UnrecordedRemoteWriteError, 'a distinct error type, so callers can tell it apart')
      // The row's errorMessage is what an operator reads. "Connection timeout" reads as "nothing
      // happened"; this has to read as "something happened remotely and we did not record it".
      assert.match(error.message, /completed remote write/i)
      assert.match(error.message, /xero sync log test-3 \(INVOICE_PAYMENT\)/, 'naming the write, not a category')
      assert.match(error.message, /remote system holds the document/i)
      assert.equal((error.cause as Error).message, 'timeout exceeded when trying to connect')
      return true
    },
  )
  assert.deepEqual(attemptsAt, [0, 250, 500, 750, 1000], 'it kept trying across the whole deadline, then stopped')
})

test('both Xero post-remote persists are routed through the helper, not straight at the pool', () => {
  // The wrap is the fix; the helper alone is a library nothing calls. `syncResult.success` is the
  // exact point at which Xero has accepted the document and only the local record is outstanding —
  // in the direct processor and in the outbox one.
  const source = readFileSync(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const lines = source.split('\n')
  const successBranches = lines.flatMap((line, index) => (line.includes('if (syncResult.success) {') ? [index] : []))

  assert.equal(successBranches.length, 2, 'the direct path and the outbox path — if this changed, so did the fix')
  for (const index of successBranches) {
    const branch = lines.slice(index, index + 12).join('\n')
    assert.match(
      branch, /persistAfterRemoteWrite\(/,
      `the post-remote persist at line ${index + 1} must not be denied by the pre-flight pool bound`,
    )
  }
})
