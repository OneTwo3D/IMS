import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { OTHER_STORE, STORE } from '../helpers/woo-tax-fakes.ts'
import { buildWorld, type World } from '../helpers/woo-tax-world.ts'
import { loadEnv } from './po-landed-fixtures'

/**
 * THE WRITER RE-CHECKS WHAT A CHANGE RESTS ON IMMEDIATELY BEFORE EACH SEND, UNDER A LOCK EVERY MAPPING WRITER TAKES (lib/connectors/woocommerce/tax-rate-writer.ts, recheckBeforeSend;
 * lib/tax/storefront-mapping-write.ts, lockStorefrontMappingWrites). Real Postgres, the real session lock, an in-memory store that counts every send.
 *
 * The apply is paused at a point the test controls (the settings read that follows the plan, a slow port, or the single-rate re-read) and the world is changed there by a write that does NOT take
 * the lock (a writer that predates the rule, or one that raced it): the re-check must still catch it.
 *   a repointed mapping            no DELETE of that rate, the run stops, the change is reported
 *   a cleared stamp                no send
 *   the live rate changed          (the fake store's GET) no send
 *   the configured store changed   before the run: refused; mid-run: the next change is not sent
 *   a mapping writer               blocks while the apply holds the lock, then proceeds
 * Mutations (each is in /scratch/wootax/mut.py): drop the re-check; drop a single check inside it; take the shared lock out of the helper.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

const LIVE = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }

async function modules() {
  loadEnv()
  const [{ db }, writer, helper] = await Promise.all([import('@/lib/db'), import('@/lib/connectors/woocommerce/tax-rate-writer'), import('@/lib/tax/storefront-mapping-write')])
  return { db, writer, helper }
}
type Mods = Awaited<ReturnType<typeof modules>>
const KEY = 918_274_501

async function lockWaiters(db: Mods['db']): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = ${KEY}`
  return Number(rows[0]?.n ?? 0)
}

/** The deps of the world, with `afterPlan` run once, at the first settings read (which the apply makes right after it has built the plan, before any send). */
function depsWith(w: World, afterPlan: () => Promise<void>) {
  const base = w.deps(LIVE)
  let reads = 0
  return { ...base, configuredStoreIdentity: async () => { reads += 1; if (reads === 1) await afterPlan(); return w.configured.value } }
}

async function applyWith(w: World, afterPlan: () => Promise<void>) {
  const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
  assert.equal(plan.changes.length, 4, 'PRECONDITION: the world has four changes')
  assert.equal(plan.changes[0]!.key, `delete:${w.woo.w4}`, 'PRECONDITION: the first change is the DELETE of the inactive rate')
  const result = await w.m.writer.applyWooTaxPlan(depsWith(w, afterPlan), { confirm: plan.digest })
  assert.equal(result.outcome, 'DONE')
  return result.outcome === 'DONE' ? result : (() => { throw new Error('unreachable') })()
}

const mappingOf = (w: World, wooId: string) => w.m.db.shoppingTaxRateMapping.findFirstOrThrow({ where: { connector: 'woocommerce', externalTaxRateId: wooId } })

test('a mapping repointed to another ACTIVE IMS rate after the plan: the DELETE is not sent, the run stops there, the change is reported, nothing is recorded', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const done = await applyWith(w, async () => { await w.m.db.shoppingTaxRateMapping.update({ where: { id: (await mappingOf(w, w.woo.w4)).id }, data: { taxRateId: w.ids.gb } }) })
    assert.deepEqual(w.store.calls, [], 'no send at all: the DELETE was first and the run stopped there')
    assert.equal(done.stopped?.key, `delete:${w.woo.w4}`)
    assert.match(done.stopped?.reason ?? '', /^MAPPING_REPOINTED/)
    assert.deepEqual(done.applied, [])
    assert.ok(w.store.rates.has(w.woo.w4), 'the store rate is still there')
    assert.equal((await w.counts()).writes, 0, 'no change record')
  })
})

test('a stamp cleared after the plan: nothing is sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const done = await applyWith(w, async () => { await w.m.db.shoppingTaxRateMapping.updateMany({ where: { externalTaxRateId: w.woo.w4 }, data: { storeIdentity: null } }) })
    assert.deepEqual(w.store.calls, [])
    assert.match(done.stopped?.reason ?? '', /^STAMP_CHANGED/)
  })
})

test('the mapping row deleted after the plan: nothing is sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const done = await applyWith(w, async () => { await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: w.woo.w4 } }) })
    assert.deepEqual(w.store.calls, [])
    assert.match(done.stopped?.reason ?? '', /^MAPPING_GONE/)
  })
})

test('the snapshot no longer matches after the plan: nothing is sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const done = await applyWith(w, async () => { await w.m.db.shoppingTaxRateMapping.updateMany({ where: { externalTaxRateId: w.woo.w4 }, data: { externalName: 'Something else' } }) })
    assert.deepEqual(w.store.calls, [])
    assert.match(done.stopped?.reason ?? '', /^SNAPSHOT_CHANGED/)
  })
})

test('the live store rate changed after the plan (the re-GET sees it): that change is not sent and the run stops; earlier changes stay applied', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    // The DELETE (first) goes through; the store rate of the first UPDATE is changed by the owner while the re-GET of it is in flight.
    w.store.onRateRead = (id) => { if (id === w.woo.w2) w.store.rates.set(id, { ...w.store.rates.get(id)!, rate: '17.0000' }) }
    const done = await applyWith(w, async () => undefined)
    assert.deepEqual(w.store.calls.map((c) => c.op), ['remove'], 'only the DELETE was sent')
    assert.deepEqual(done.applied.map((a) => a.kind), ['DELETE'])
    assert.equal(done.stopped?.key, `update:${w.woo.w2}`)
    assert.match(done.stopped?.reason ?? '', /^LIVE_CHANGED/)
    assert.equal(w.store.rates.get(w.woo.w2)!.rate, '17.0000', 'the owner\'s value was not overwritten')
    assert.deepEqual(w.store.rateReads, [w.woo.w4, w.woo.w2], 'each UPDATE and DELETE re-read its one rate, and the run stopped at the second')
  })
})

test('the store rate vanished after the plan (the re-GET fails): the DELETE is not sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const done = await applyWith(w, async () => { w.store.rates.delete(w.woo.w4) })
    assert.deepEqual(w.store.calls, [])
    assert.match(done.stopped?.reason ?? '', /^WOO_UNREADABLE/)
  })
})

test('a CREATE is re-checked too: the IMS rate deactivated after the plan, or a mapping that appeared for it, means no create', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    // Everything before the CREATE goes through; the FR rate is switched off while the apply is running.
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const base = w.deps(LIVE)
    const deps = { ...base, port: { ...w.store, create: (...a: Parameters<typeof w.store.create>) => w.store.create(...a), update: w.store.update.bind(w.store), remove: async (...a: Parameters<typeof w.store.remove>) => { const r = await w.store.remove(...a); await w.m.db.taxRate.update({ where: { id: w.ids.fr }, data: { active: false } }); return r } } }
    const done = await w.m.writer.applyWooTaxPlan(deps, { confirm: plan.digest })
    assert.equal(done.outcome === 'DONE' ? done.stopped?.key : null, `create:${w.ids.fr}`)
    assert.match((done.outcome === 'DONE' ? done.stopped?.reason : '') ?? '', /^IMS_RATE_CHANGED/)
    assert.ok(!w.store.calls.some((c) => c.op === 'create'), 'no create was sent')
    await w.m.db.taxRate.update({ where: { id: w.ids.fr }, data: { active: true } })
  })
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const done = await w.m.writer.applyWooTaxPlan(depsWith(w, async () => { await w.m.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(Number(w.woo.w5) + 50), taxRateId: w.ids.fr, externalName: 'FR VAT', externalCountry: 'FR', externalRatePct: '20', externalClass: 'standard', storeIdentity: null } }) }), { confirm: plan.digest })
    assert.equal(done.outcome === 'DONE' ? done.stopped?.key : null, `create:${w.ids.fr}`)
    assert.match((done.outcome === 'DONE' ? done.stopped?.reason : '') ?? '', /^MAPPING_APPEARED/)
    assert.deepEqual(w.store.calls.map((c) => c.op), ['remove', 'update', 'update'], 'the three earlier changes were sent; the create was not')
    await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: w.ids.fr } })
  })
})

test('the configured store changed BEFORE the apply: refused, nothing sent; changed DURING it: the next change is not sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    w.configured.value = OTHER_STORE
    const refused = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.deepEqual(refused.outcome === 'REFUSED' ? refused.code : refused.outcome, 'STORE_CHANGED')
    assert.deepEqual(w.store.calls, [])
    w.configured.value = null
    const unusable = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.deepEqual(unusable.outcome === 'REFUSED' ? unusable.code : unusable.outcome, 'STORE_CHANGED', 'a store that cannot be identified now is not the pinned store')
    assert.deepEqual(w.store.calls, [])
    w.configured.value = STORE
    // during the run: wc_url changes once the first change has been sent
    const base = w.deps(LIVE)
    const deps = { ...base, port: { create: w.store.create.bind(w.store), update: w.store.update.bind(w.store), remove: async (...a: Parameters<typeof w.store.remove>) => { const r = await w.store.remove(...a); w.configured.value = OTHER_STORE; return r } } }
    const done = await w.m.writer.applyWooTaxPlan(deps, { confirm: plan.digest })
    assert.deepEqual(w.store.calls.map((c) => c.op), ['remove'], 'only the change sent before the URL moved')
    assert.equal(done.outcome === 'DONE' ? done.stopped?.key : null, `update:${w.woo.w2}`)
    assert.match((done.outcome === 'DONE' ? done.stopped?.reason : '') ?? '', /^STORE_CHANGED/)
  })
})

test('a mapping writer BLOCKS while the apply holds the lock, and proceeds when it ends; shared writers do not block each other', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const store = w.store
    const slow = {
      create: async (...a: Parameters<typeof store.create>) => { await gate; return store.create(...a) },
      update: async (...a: Parameters<typeof store.update>) => { await gate; return store.update(...a) },
      remove: async (...a: Parameters<typeof store.remove>) => { await gate; return store.remove(...a) },
    }
    const { upsertStorefrontTaxMapping, repointStorefrontTaxMapping, lockStorefrontMappingWrites } = w.m.helper
    const current = await mappingOf(w, w.woo.w1)
    const fields = { externalName: current.externalName, externalCountry: current.externalCountry, externalRatePct: current.externalRatePct.toFixed(4), externalClass: current.externalClass, taxRateId: current.taxRateId }
    let apply: ReturnType<typeof w.m.writer.applyWooTaxPlan> | null = null
    const finished: string[] = []
    const writers: Array<Promise<unknown>> = []
    try {
      apply = w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), port: slow }, { confirm: plan.digest }).then((r) => { finished.push('apply'); return r })
      // the apply holds the lock once it is inside its first send (the gate)
      for (let i = 0; i < 200 && store.rateReads.length < 1; i++) await new Promise((r) => setTimeout(r, 25))
      assert.equal(store.rateReads.length, 1, 'PRECONDITION: the apply is inside its first send')
      writers.push(w.m.db.$transaction((tx) => upsertStorefrontTaxMapping(tx, { connector: 'woocommerce', externalTaxRateId: w.woo.w1 }, fields)).then(() => finished.push('upsert')))
      writers.push(w.m.db.$transaction((tx) => repointStorefrontTaxMapping(tx, { connector: 'woocommerce', externalTaxRateId: w.woo.w1 }, current.taxRateId)).then(() => finished.push('repoint')))
      writers.push(w.m.db.$transaction(async (tx) => { await lockStorefrontMappingWrites(tx); await tx.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: '1' } }) }).then(() => finished.push('delete')))
      for (let i = 0; i < 200 && (await lockWaiters(w.m.db)) < 3; i++) await new Promise((r) => setTimeout(r, 25))
      assert.equal(await lockWaiters(w.m.db), 3, 'all three mapping writers are WAITING on the apply\'s lock')
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(finished, [], 'none of them has finished while the apply is paused in a send')
      release()
      await Promise.all([apply, ...writers])
      assert.equal(finished[0], 'apply', 'the apply finished first; the writers proceeded after it released the lock')
      assert.deepEqual([...finished].sort(), ['apply', 'delete', 'repoint', 'upsert'])
    } finally {
      release()
      await Promise.allSettled([apply, ...writers])
    }
  })
})

test('shared writers do not block one another: a second writer takes the lock while the first still holds it', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const { lockStorefrontMappingWrites } = w.m.helper
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    let firstHasLock!: () => void
    const first = new Promise<void>((resolve) => { firstHasLock = resolve })
    const a = w.m.db.$transaction(async (tx) => { await lockStorefrontMappingWrites(tx); firstHasLock(); await hold })
    try {
      await first
      let second = false
      await w.m.db.$transaction(async (tx) => { await lockStorefrontMappingWrites(tx); second = true })
      assert.equal(second, true, 'the second writer got the lock while the first still held it')
    } finally {
      release()
      await a
    }
  })
})

test('an apply without the means to re-check (no single-rate read, no configured-store read) is refused before anything is read or sent', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    for (const drop of ['readWooRate', 'configuredStoreIdentity'] as const) {
      const deps = { ...w.deps(LIVE), [drop]: undefined }
      const r = await w.m.writer.applyWooTaxPlan(deps, { confirm: plan.digest })
      assert.deepEqual(r.outcome === 'REFUSED' ? r.code : r.outcome, 'PORT_MISSING', drop)
    }
    assert.deepEqual(w.store.calls, [])
  })
})

test('an ADOPTION is bound to the pinned store too: if the configured store differs, nothing is stamped', SKIP, async (t) => {
  await buildWorld(t, modules, async (w) => {
    await w.m.db.shoppingTaxRateMapping.updateMany({ where: { externalTaxRateId: { in: [w.woo.w1, w.woo.w2] } }, data: { storeIdentity: null } })
    const plan = (await w.m.writer.readWooAdoptionPlan(w.deps(LIVE))).plan!
    assert.ok(plan.rows.length >= 2, 'PRECONDITION: legacy rows to adopt')
    w.configured.value = OTHER_STORE
    const r = await w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: plan.digest })
    assert.deepEqual(r.outcome === 'REFUSED' ? r.code : r.outcome, 'STORE_CHANGED')
    assert.equal(await w.m.db.shoppingTaxRateMapping.count({ where: { externalTaxRateId: { in: [w.woo.w1, w.woo.w2] }, storeIdentity: { not: null } } }), 0)
  })
})
