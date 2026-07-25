import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { pgLockStore } from '../../e2e/full-chain/harness/quiesce.ts'

/**
 * The quiesce lock's mutual exclusion IS its SQL (o3d-lgo.14): a conditional INSERT for the claim, and
 * compare-and-set for every write that follows. The unit tests exercise the protocol against an in-memory
 * store that mirrors those semantics — this proves the semantics are real, on a live Postgres, with
 * genuinely separate connections racing.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (needs a real database). It never touches the real lock row: it
 * works on a throwaway settings key and deletes it afterwards.
 */
test(
  'quiesce lock: exactly one of N concurrent claims wins, and every later write is owner-guarded',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })

    const url = process.env.DATABASE_URL
    assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')

    const { Client } = await import('pg')
    // A key of our own: the real lock row is load-bearing for the full-chain rig and must never be
    // disturbed by a test run.
    const key = `e2e_quiesce_lock_test_${randomUUID()}`

    const CONTENDERS = 8
    const clients = Array.from({ length: CONTENDERS }, () => new Client({ connectionString: url }))
    await Promise.all(clients.map((c) => c.connect()))
    const cleanup = new Client({ connectionString: url })
    await cleanup.connect()

    try {
      const stores = clients.map((c) => pgLockStore(c, key))
      const tokens = stores.map((_, i) => `tok-${i}-${randomUUID()}`)
      const record = (i: number) => JSON.stringify({
        takenAt: new Date().toISOString(), runId: `race-${i}`, token: tokens[i],
        stageSettings: {}, e2eSettings: {}, createdWebhookIds: [],
      })

      // 1. THE CLAIM. All eight inserts hit the same key at once; ON CONFLICT DO NOTHING means exactly one
      //    of them returns a row. Read-then-write is what let two runs both conclude the lock was free.
      const claims = await Promise.all(stores.map((s, i) => s.claim(record(i))))
      const winners = claims.filter(Boolean)
      assert.equal(winners.length, 1, `exactly one claim may succeed, got ${winners.length}`)
      const winner = claims.indexOf(true)

      const held = await stores[0].read()
      assert.equal(held?.lock.token, tokens[winner], 'the row belongs to the one that won')

      // 2. A LOSER CANNOT RENEW. Every write after the claim carries the owner's token, so a run that
      //    never acquired cannot overwrite the record — nor can one whose lock was recovered from under it.
      const loser = (winner + 1) % CONTENDERS
      assert.equal(await stores[loser].writeIfOwned(tokens[loser], record(loser)), false)
      assert.equal((await stores[0].read())?.lock.token, tokens[winner], 'the row is unchanged')

      // 3. THE OWNER CAN. That is the heartbeat: renewing the lease in place.
      assert.equal(await stores[winner].writeIfOwned(tokens[winner], record(winner)), true)

      // 4. A LOSER CANNOT RELEASE. The teardown of a REFUSED invocation runs anyway; if it could delete
      //    the row it would hand the shared store to a third run mid-suite.
      assert.equal(await stores[loser].deleteIfOwned(tokens[loser]), false)
      assert.ok(await stores[0].read(), 'the lock survives a stranger trying to release it')

      // 5. RECOVERY IS COMPARE-AND-SET. Deleting an abandoned lock is conditional on the exact bytes that
      //    were judged, so two recoverers cannot both conclude they took it over.
      const current = await stores[0].read()
      assert.ok(current)
      assert.equal(await stores[loser].deleteIfUnchanged(JSON.stringify({ stale: true })), false)
      assert.equal(await stores[loser].deleteIfUnchanged(current.raw), true, 'the row it actually judged')
      assert.equal(await stores[0].read(), null)

      // 6. And the freed key is claimable again — the lock recovers rather than wedging.
      assert.equal(await stores[loser].claim(record(loser)), true)
      assert.equal(await stores[winner].deleteIfOwned(tokens[winner]), false, 'ownership moved on')
      assert.equal(await stores[loser].deleteIfOwned(tokens[loser]), true)
    } finally {
      await cleanup.query(`delete from settings where key = $1`, [key]).catch(() => {})
      await cleanup.end().catch(() => {})
      await Promise.all(clients.map((c) => c.end().catch(() => {})))
    }
  },
)
