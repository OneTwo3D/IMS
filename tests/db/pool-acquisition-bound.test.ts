import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { mock } from 'node:test'

/**
 * o3d-xl63: THE POOL IS THE OTHER HALF OF EVERY TIMEOUT WE SET.
 *
 * The direct-create marker deferral is bounded by `SET LOCAL statement_timeout`, which is enforced by
 * Postgres — so it cannot begin counting until the statement HAS a connection. pg-pool's `connect()`
 * takes a second path when every connection is checked out: it pushes the request onto `_pendingQueue`,
 * and without `connectionTimeoutMillis` it attaches no timer at all, so the caller is woken only by a
 * release that may never come. The bounded statement then waits unboundedly to start, and the sweep's
 * per-tick wall-clock budget — the thing that bound exists to protect — goes with it.
 *
 * THIS IS DRIVEN THROUGH THE REAL `pg.Pool`, built from the REAL exported config, because the defect is
 * a property of that library's queueing rather than of anything IMS computes. A test that asserted our
 * own constant against itself would pass with the option misspelled, dropped from the adapter config, or
 * renamed by pg — which are the three ways this actually breaks. No database is involved: the pool is
 * given a stub Client, so "the pool is full" is reached without a server, and node's timer mock advances
 * the clock so the ten-second bound is proved to the millisecond in no time at all.
 */

/** Enough of a `pg.Client` for pg-pool to hand it out, connect it and end it. Never touches a socket. */
class StubClient extends EventEmitter {
  connect(callback: (error?: Error) => void) { callback() }
  end(callback?: () => void) { callback?.() }
  isConnected() { return true }
  query() { return Promise.resolve({ rows: [] }) }
  ref() {}
  unref() {}
}

/** Let already-scheduled microtasks run; timers stay under the test's control. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('a caller that cannot get a connection gives up at the bound instead of waiting for ever (o3d-xl63)', async () => {
  const { default: pg } = await import('pg')
  const { dbPoolConfig, DB_POOL_ACQUISITION_TIMEOUT_MS } = await import('@/lib/db')

  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // The production config, with only `max` narrowed so exhaustion is one checkout away. The bound
    // under test is NOT overridden — it is read from the same object the adapter is built with.
    const pool = new pg.Pool({ ...dbPoolConfig(), max: 1, Client: StubClient as never })

    const held = await pool.connect()
    assert.ok(held, 'the first caller gets the only connection')

    let outcome: string | null = null
    void pool.connect().then(
      () => { outcome = 'acquired' },
      (error: Error) => { outcome = error.message },
    )
    await settle()
    assert.equal(outcome, null, 'the second caller is queued, because the pool is full')

    mock.timers.tick(DB_POOL_ACQUISITION_TIMEOUT_MS - 1)
    await settle()
    assert.equal(outcome, null, 'and is still waiting one millisecond short of the bound')

    // NEVER awaited: the whole point is that without the bound this promise does not settle, and a test
    // that awaited it would HANG on the reverted code instead of failing. The rejection is observed
    // through `outcome` after the microtask queue drains.
    mock.timers.tick(1)
    await settle()
    assert.equal(
      outcome, 'timeout exceeded when trying to connect',
      'at the bound the pool gives up — without connectionTimeoutMillis this promise never settles, '
        + 'and the marker deferral waiting on it spends the sweep budget it was bounded to protect',
    )
  } finally {
    mock.timers.reset()
  }
})

test('the bound is the one the adapter is actually built with, and sits above Prisma\'s own (o3d-xl63)', async () => {
  const { dbPoolConfig, DB_POOL_ACQUISITION_TIMEOUT_MS, DB_POOL_MAX } = await import('@/lib/db')
  const config = dbPoolConfig()

  assert.equal(
    config.connectionTimeoutMillis, DB_POOL_ACQUISITION_TIMEOUT_MS,
    'the acquisition bound reaches the pool — a constant declared and not passed bounds nothing',
  )
  assert.equal(config.max, DB_POOL_MAX)
  assert.ok(
    DB_POOL_ACQUISITION_TIMEOUT_MS > 5_000,
    'above the 5s maxWait the sweep\'s interactive transactions carry, so Prisma\'s bound still fires '
      + 'first where there is one and this only covers the paths with none',
  )
})
