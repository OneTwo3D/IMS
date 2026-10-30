import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { FakeWooStore, woo } from '../helpers/woo-tax-fakes.ts'
import { withWooTaxWorldLock } from '../helpers/woo-tax-db-lock.ts'

/**
 * AN OWNERSHIP STAMP ENDS WHEN ITS ROW STOPS MEANING WHAT IT WAS STAMPED FOR (lib/tax/storefront-mapping-write.ts), against a real database.
 *
 * The real importWcTaxRates runs with only the store's read replaced (wcFetch returns the rates the test says the store has; nothing is contacted). A stamped mapping row keeps its stamp when an
 * import changes nothing of its IMS rate or its identity snapshot (name, country, percent, class), loses it IN THE SAME WRITE when it changes any of them, and a row an import creates is born
 * unstamped. The scenario of the review: the owner replaces WooCommerce rate 10 by a different rate and imports; the planner must then see MAPPING_NOT_ADOPTED and plan no DELETE.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/storefront-mapping-stamp.test.ts would have been skipped.')
const SKIP = { skip: skip && 'set RUN_DB_RETENTION_TESTS=1' } as const

const STORE = 'https://store.example'
let wcRates: Array<Record<string, unknown>> = []
mock.module(new URL('../../lib/connectors/woocommerce/api.ts', import.meta.url).href, {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => ({ data: params.page === '1' ? wcRates : [], totalPages: 1, totalItems: wcRates.length, totalItemsPresent: true }),
  },
})

const wcRate = (id: number, name: string, rate: string, over: Record<string, unknown> = {}) => ({ id, country: 'GB', state: '', postcode: '', city: '', rate, name, priority: 1, compound: false, shipping: true, order: 1, class: 'standard', ...over })

async function modules() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, imp, helper, writer] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/woocommerce/sync/taxes.ts'),
    import('../../lib/tax/storefront-mapping-write.ts'),
    import('../../lib/connectors/woocommerce/tax-rate-writer.ts'),
  ])
  return { db, importWcTaxRates: imp.importWcTaxRates, helper, writer }
}

/** A run-unique name prefix, the ids of the mapping rows used, and cleanup of everything the import created. */
async function withRun(t: test.TestContext, body: (r: Awaited<ReturnType<typeof modules>> & { tag: string; ids: string[] }) => Promise<void>) {
  const m = await modules()
  await withWooTaxWorldLock(() => runLocked(m, body))
}

async function runLocked(m: Awaited<ReturnType<typeof modules>>, body: (r: Awaited<ReturnType<typeof modules>> & { tag: string; ids: string[] }) => Promise<void>) {
  const tag = `ZZ${Math.random().toString(36).slice(2, 8)}`
  const base = 6_000_000 + Math.floor(Math.random() * 90_000) * 10
  const ids = [String(base + 10), String(base + 11)]
  const others = (await m.db.taxRate.findMany({ where: { active: true }, select: { id: true } })).map((x) => x.id)
  await m.db.taxRate.updateMany({ where: { id: { in: others } }, data: { active: false } })
  const cleanup = async () => {
    await m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: { in: ids } } })
    await m.db.taxRate.deleteMany({ where: { name: { startsWith: tag } } })
    await m.db.taxRate.updateMany({ where: { id: { in: others } }, data: { active: true } })
  }
  try {
    await body({ ...m, tag, ids })
  } finally {
    await cleanup()
  }
}
const rowOf = (m: { db: Awaited<ReturnType<typeof modules>>['db'] }, id: string) => m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: id } } })
const stamp = (m: { db: Awaited<ReturnType<typeof modules>>['db'] }, id: string) => m.db.shoppingTaxRateMapping.update({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: id } }, data: { storeIdentity: STORE } })

test('IMPORT creates a new mapping row UNSTAMPED, and an import that changes nothing keeps a stamped row\'s stamp', SKIP, async (t) => {
  await withRun(t, async (r) => {
    wcRates = [wcRate(Number(r.ids[0]), `${r.tag} VAT`, '20.0000')]
    await r.importWcTaxRates()
    assert.equal((await rowOf(r, r.ids[0]!))?.storeIdentity, null, 'a created row is unstamped')
    await stamp(r, r.ids[0]!)
    const again = await r.importWcTaxRates()
    assert.equal(again.mappedRates, 1)
    assert.equal((await rowOf(r, r.ids[0]!))?.storeIdentity, STORE, 'nothing changed: the stamp stays')
  })
})

test('IMPORT clears the stamp in the same write when the rate behind the id changes: name (and so the IMS rate), percent, country, class', SKIP, async (t) => {
  const changes: Array<[string, (r: { tag: string }) => Record<string, unknown>]> = [
    ['percent', (r) => ({ name: `${r.tag} VAT`, rate: '21.0000' })],
    ['country', (r) => ({ name: `${r.tag} VAT`, country: 'IE' })],
    ['class', (r) => ({ name: `${r.tag} VAT`, class: 'reduced-rate' })],
    ['name and IMS rate', (r) => ({ name: `${r.tag} Replacement VAT` })],
  ]
  for (const [label, change] of changes) {
    await withRun(t, async (r) => {
      wcRates = [wcRate(Number(r.ids[0]), `${r.tag} VAT`, '20.0000')]
      await r.importWcTaxRates()
      await stamp(r, r.ids[0]!)
      wcRates = [wcRate(Number(r.ids[0]), `${r.tag} VAT`, '20.0000', change(r))]
      await r.importWcTaxRates()
      const row = await rowOf(r, r.ids[0]!)
      assert.equal(row?.storeIdentity, null, `${label}: the stamp is cleared`)
      assert.ok(row, label)
    })
  }
})

test('REPLACED RATE 10: the owner replaces the store rate by another and imports; the planner then sees MAPPING_NOT_ADOPTED and plans no DELETE', SKIP, async (t) => {
  await withRun(t, async (r) => {
    wcRates = [wcRate(Number(r.ids[0]), `${r.tag} Old VAT`, '20.0000')]
    await r.importWcTaxRates()
    const first = await rowOf(r, r.ids[0]!)
    await stamp(r, r.ids[0]!)
    await r.db.taxRate.update({ where: { id: first!.taxRateId }, data: { active: false } }) // IMS wants this rate gone: an owned mapping would be a DELETE
    // the store now has a DIFFERENT rate under the same id
    const replaced = wcRate(Number(r.ids[0]), `${r.tag} Other VAT`, '5.0000', { country: 'IE' })
    wcRates = [replaced]
    await r.importWcTaxRates()
    const row = await rowOf(r, r.ids[0]!)
    assert.equal(row?.storeIdentity, null)
    const store = new FakeWooStore([woo(r.ids[0]!, { name: replaced.name as string, rate: '5.0000', country: 'IE' })])
    const deps = { readWoo: store.readWoo, readWooRate: store.readWooRate, storeIdentity: async () => STORE, configuredStoreIdentity: async () => STORE, port: store, context: { env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }, now: new Date('2026-06-01T00:00:00Z') } }
    const plan = (await r.writer.readWooTaxPlan(deps)).plan!
    assert.ok(plan.findings.some((f) => f.code === 'MAPPING_NOT_ADOPTED' && f.wooId === r.ids[0]))
    assert.ok(!plan.changes.some((c) => c.kind === 'DELETE'), 'no DELETE of the replaced rate')
    assert.deepEqual(store.calls, [])
  })
})

test('THE HELPER (lib/tax/storefront-mapping-write.ts): an upsert or a re-point of a stamped row clears the stamp when the IMS rate or the identity changes and keeps it when not; a created row and an unstamped row stay unstamped; re-pointing a missing row is an error', SKIP, async (t) => {
  await withRun(t, async (r) => {
    const a = await r.db.taxRate.create({ data: { name: `${r.tag} A`, rate: '0.2000', usedFor: 'SALES' } })
    const b = await r.db.taxRate.create({ data: { name: `${r.tag} B`, rate: '0.2000', usedFor: 'SALES' } })
    const key = { connector: 'woocommerce', externalTaxRateId: r.ids[1]! }
    const fields = { externalName: `${r.tag} A`, externalCountry: 'GB', externalRatePct: '20.0000', externalClass: 'standard', taxRateId: a.id }
    const stampOf = async () => (await rowOf(r, r.ids[1]!))?.storeIdentity
    assert.deepEqual(await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, fields)), { created: true })
    assert.equal(await stampOf(), null, 'a created row is unstamped')
    await stamp(r, r.ids[1]!)
    assert.deepEqual(await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, fields)), { created: false })
    assert.equal(await stampOf(), STORE, 'an upsert that changes nothing keeps the stamp')
    await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, { ...fields, externalName: `  ${r.tag.toLowerCase()}   a `, externalCountry: 'uk', externalRatePct: '20', externalClass: '' }))
    assert.equal(await stampOf(), STORE, 'the same rate by R13\'s comparisons keeps it')
    await r.db.$transaction((tx) => r.helper.repointStorefrontTaxMapping(tx, key, a.id))
    assert.equal(await stampOf(), STORE, 're-pointing to the same IMS rate keeps it')
    for (const over of [{ externalRatePct: '21.0000' }, { externalCountry: 'IE' }, { externalClass: 'zero-rate' }, { externalName: `${r.tag} A2` }, { taxRateId: b.id }]) {
      await stamp(r, r.ids[1]!)
      await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, { ...fields, ...over }))
      assert.equal(await stampOf(), null, `an upsert that changes ${Object.keys(over)[0]} clears it`)
      await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, fields))
    }
    await stamp(r, r.ids[1]!)
    await r.db.$transaction((tx) => r.helper.repointStorefrontTaxMapping(tx, key, b.id))
    assert.equal(await stampOf(), null, 're-pointing to another IMS rate clears it')
    await r.db.$transaction((tx) => r.helper.repointStorefrontTaxMapping(tx, key, a.id))
    assert.equal(await stampOf(), null, 'an unstamped row stays unstamped')
    await assert.rejects(() => r.db.$transaction((tx) => r.helper.repointStorefrontTaxMapping(tx, { connector: 'woocommerce', externalTaxRateId: '1' }, a.id)), /no storefront tax-rate mapping/)
  })
})

test('DIFFERENTIAL: the SQL decision and mappingKeepsStamp agree over a matrix of names, countries, percents and classes (SQL may only be stricter)', SKIP, async (t) => {
  await withRun(t, async (r) => {
    const a = await r.db.taxRate.create({ data: { name: `${r.tag} A`, rate: '0.2000', usedFor: 'SALES' } })
    const key = { connector: 'woocommerce', externalTaxRateId: r.ids[1]! }
    const base = { externalName: `${r.tag} Alpha VAT`, externalCountry: 'GB' as string | null, externalRatePct: '20.0000', externalClass: 'standard' as string | null, taxRateId: a.id }
    const names = [base.externalName, `  ${r.tag.toLowerCase()}  alpha   vat `, `${r.tag} Alpha  VAT`, `${r.tag} Beta VAT`, `${r.tag} alpha vat.`]
    const countries: Array<string | null> = ['GB', 'gb', ' GB ', 'UK', 'uk', null, '', 'IE', 'EL', 'GR']
    const pcts = ['20.0000', '20', '20.00', '20.0001', '19.9999', '0']
    const classes: Array<string | null> = ['standard', '', null, ' Standard ', 'zero-rate', 'reduced-rate']
    let compared = 0
    let sqlStricter = 0
    for (const externalName of names) for (const externalCountry of countries) for (const externalRatePct of pcts.slice(0, 4)) for (const externalClass of classes) {
      const next = { ...base, externalName, externalCountry, externalRatePct, externalClass }
      await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, base))
      await stamp(r, r.ids[1]!)
      await r.db.$transaction((tx) => r.helper.upsertStorefrontTaxMapping(tx, key, next))
      const sqlKept = (await rowOf(r, r.ids[1]!))?.storeIdentity === STORE
      const jsKept = r.helper.mappingKeepsStamp(base, next)
      compared += 1
      if (sqlKept && !jsKept) assert.fail(`SQL kept a stamp the reference rule clears: ${JSON.stringify(next)}`)
      if (!sqlKept && jsKept) sqlStricter += 1
      if (compared > 400) break
    }
    console.log(`# differential: ${compared} combinations, SQL stricter in ${sqlStricter}`)
    assert.ok(compared >= 200)
    assert.ok(sqlStricter <= 4, `SQL should differ from the reference rule only in rare whitespace corners, differed in ${sqlStricter}`)
  })
})

test('DELETE ENDS THE STAMP: a deleted rate\'s mapping row stays (historic orders) but is unstamped, so a store that reuses the id for a look-alike rate gets no DELETE', SKIP, async (t) => {
  const { buildWorld } = await import('../helpers/woo-tax-world.ts')
  await buildWorld(t, async () => { const m = await modules(); return { db: m.db, writer: m.writer } }, async (w) => {
    const live = { env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' } }
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(live.env))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(live.env), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    const row = await rowOf({ db: w.m.db }, w.woo.w4)
    assert.ok(row, 'the mapping row of the deleted rate is kept')
    assert.equal(row.storeIdentity, null, 'but its stamp is gone')
    // The store gives that id to a rate that looks identical (same name, country, percent, class). IMS never adopted it.
    w.store.rates.set(w.woo.w4, woo(w.woo.w4, { name: 'XX Old VAT', country: 'XX', rate: '10.0000' }))
    const next = (await w.m.writer.readWooTaxPlan(w.deps(live.env))).plan!
    assert.ok(!next.changes.some((c) => c.kind === 'DELETE' && c.wooId === w.woo.w4), 'the look-alike is not deleted')
    assert.ok(next.findings.some((f) => f.code === 'MAPPING_NOT_ADOPTED' && f.wooId === w.woo.w4))
    const calls = w.store.calls.length
    await w.m.writer.applyWooTaxPlan(w.deps(live.env), { confirm: next.digest })
    assert.equal(w.store.calls.length, calls)
    assert.equal(w.store.rates.has(w.woo.w4), true)
    // and it can be adopted explicitly
    const adoption = (await w.m.writer.readWooAdoptionPlan(w.deps(live.env))).plan!
    assert.ok(adoption.rows.some((x) => x.wooId === w.woo.w4 && x.reason === 'UNSTAMPED'))
  })
})

test('PURE: the stamp is kept only for the same IMS rate and the same name, country, percent and class (R13\'s comparisons)', SKIP, async () => {
  const { helper } = await modules()
  const base = { externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: '20.0000', externalClass: 'standard', taxRateId: 'r1' }
  assert.equal(helper.mappingKeepsStamp(base, { ...base }), true)
  assert.equal(helper.mappingKeepsStamp(base, { ...base, externalName: '  gb   vat ', externalClass: null, externalCountry: 'UK', externalRatePct: '20' }), true, 'R13 treats these as the same rate')
  for (const over of [{ taxRateId: 'r2' }, { externalName: 'GB VAT 2' }, { externalCountry: 'IE' }, { externalRatePct: '20.0001' }, { externalClass: 'zero-rate' }]) {
    assert.equal(helper.mappingKeepsStamp(base, { ...base, ...over }), false, JSON.stringify(over))
  }
})
