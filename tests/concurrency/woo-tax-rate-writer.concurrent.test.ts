import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWorld } from '../helpers/woo-tax-world.ts'
import { loadEnv } from './po-landed-fixtures'

/**
 * TWO APPLIES OF THE WOOCOMMERCE TAX-RATE PLAN AT ONCE (lib/connectors/woocommerce/tax-rate-writer.ts, WOO_TAX_RATE_WRITE_LOCK_KEY).
 *
 * The first apply is held inside its first send (the store does not answer until the test says so); the second is started with the SAME confirmed digest and must be WAITING on the
 * single-runner lock, not sending. When the first finishes, the second rebuilds its plan from the store as the first left it and has nothing to do.
 *   arm 1  released: the store receives each planned change EXACTLY ONCE (not twice), one change record per change, one mapping row per CREATE
 *   arm 2  held: both applies finish, nothing is sent, and the shadow of each change was counted by both, one row each
 * Real Postgres, the real session lock. Mutation: take the lock out of applyWooTaxPlan -> arm 1 sees every change sent twice (and the second CREATE makes a second rate).
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }
const LIVE = { ...HELD, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }

async function modules() {
  loadEnv()
  const [{ db }, writer] = await Promise.all([import('@/lib/db'), import('@/lib/connectors/woocommerce/tax-rate-writer')])
  return { db, writer }
}

type Db = Awaited<ReturnType<typeof modules>>['db']
const KEY = 918_274_501 // WOO_TAX_RATE_WRITE_LOCK_KEY, read back from pg_locks below so a changed constant fails the precondition rather than this file

/** How many sessions hold (granted) or wait for (not granted) the writer's lock, read from pg_locks. */
async function lockSessions(db: Db, granted: boolean): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND granted = ${granted} AND ((classid::bigint << 32) | objid::bigint) = ${KEY}`
  return Number(rows[0]?.n ?? 0)
}
async function until(db: Db, granted: boolean, atLeast: number): Promise<number> {
  let n = 0
  for (let i = 0; i < 200 && n < atLeast; i++) {
    n = await lockSessions(db, granted)
    if (n < atLeast) await new Promise((r) => setTimeout(r, 50))
  }
  return n
}

test('two applies at once with one confirmed digest: the second waits on the lock and then has nothing to do; every change is sent exactly once', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.equal(plan.changes.length, 4, 'PRECONDITION: the world has four changes')
    // The first send waits for the test.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const store = w.store
    const slow = {
      create: async (...a: Parameters<typeof store.create>) => { await gate; return store.create(...a) },
      update: async (...a: Parameters<typeof store.update>) => { await gate; return store.update(...a) },
      remove: async (...a: Parameters<typeof store.remove>) => { await gate; return store.remove(...a) },
    }
    const deps = { ...w.deps(LIVE), port: slow }
    let first: ReturnType<typeof w.m.writer.applyWooTaxPlan> | null = null
    let second: ReturnType<typeof w.m.writer.applyWooTaxPlan> | null = null
    try {
      first = w.m.writer.applyWooTaxPlan(deps, { confirm: plan.digest })
      // Wait until the first holds the lock (it is then inside its first send, which waits for the gate), then start the second.
      assert.equal(await until(w.m.db, true, 1), 1, 'PRECONDITION: the first apply holds the single-runner lock')
      second = w.m.writer.applyWooTaxPlan(deps, { confirm: plan.digest })
      assert.equal(await until(w.m.db, false, 1), 1, 'PRECONDITION: the second apply is blocked on the single-runner lock while the first is mid-send')
      assert.equal(store.calls.length, 0, 'nothing has reached the store: the first is held in its first send and the second is waiting')
      release()
      const [a, b] = await Promise.all([first, second!])
      assert.equal(a.outcome, 'DONE')
      assert.equal(b.outcome, 'NOTHING_TO_DO', 'the second rebuilt its plan from the store the first left, and found nothing to do')
      assert.equal(store.calls.length, 4, 'each planned change was sent exactly once')
      assert.deepEqual(store.calls.map((c) => c.op), ['remove', 'update', 'update', 'create'])
      assert.equal(store.list().filter((r) => r.name === 'FR VAT').length, 1, 'one FR rate in the store, not two')
      assert.deepEqual(await w.counts(), { writes: 4, mappings: 5, shadows: 0 }, 'one record per change, one mapping row for the one CREATE')
    } finally {
      // A failed precondition must not leave the first apply parked on its gate holding the lock: release it and let both settle, so the process can end.
      release()
      await Promise.allSettled([first, second])
    }
  })
})

test('two applies at once while held: both finish, nothing is sent, nothing but shadows is written, one row per change counted twice', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(HELD))).plan!
    const results = await Promise.all([w.m.writer.applyWooTaxPlan(w.deps(HELD), { confirm: plan.digest }), w.m.writer.applyWooTaxPlan(w.deps(HELD), { confirm: plan.digest })])
    assert.deepEqual(results.map((r) => r.outcome), ['DONE', 'DONE'])
    assert.deepEqual(w.store.calls, [], 'zero sends while held, however many applies')
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 4 })
    assert.deepEqual((await w.m.db.outboundShadowWrite.findMany({ where: { destination: 'woocommerce', operation: 'tax-rate' } })).map((s) => s.occurrences), [2, 2, 2, 2])
  })
})

test('two ADOPTIONS at once: the second waits on the same lock and then has nothing to stamp; each row is stamped and recorded exactly once', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    await w.m.db.shoppingTaxRateMapping.updateMany({ where: { externalTaxRateId: { in: [w.woo.w1, w.woo.w2, w.woo.w3, w.woo.w4] } }, data: { storeIdentity: null } })
    const plan = (await w.m.writer.readWooAdoptionPlan(w.deps(LIVE))).plan!
    assert.equal(plan.rows.length, 4, 'PRECONDITION: four legacy rows')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    // The first adoption is held inside its store read, which happens under the lock.
    const slowDeps = { ...w.deps(LIVE), readWoo: async () => { await gate; return w.store.readWoo() } }
    let first: ReturnType<typeof w.m.writer.applyWooAdoption> | null = null
    let second: ReturnType<typeof w.m.writer.applyWooAdoption> | null = null
    try {
      first = w.m.writer.applyWooAdoption(slowDeps, { confirm: plan.digest })
      assert.equal(await until(w.m.db, true, 1), 1, 'PRECONDITION: the first adoption holds the single-runner lock')
      second = w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: plan.digest })
      assert.equal(await until(w.m.db, false, 1), 1, 'PRECONDITION: the second adoption waits on the lock')
      release()
      const [a, b] = await Promise.all([first, second])
      assert.equal(a.outcome, 'ADOPTED')
      assert.equal(b.outcome, 'NOTHING_TO_DO')
      assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'ADOPT', imsTaxRateId: { in: Object.values(w.ids) } } }), 4, 'one ADOPT record per row, not two')
    } finally {
      release()
      await Promise.allSettled([first, second])
    }
  })
})
