import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { woo } from '../helpers/woo-tax-fakes.ts'
import { buildWorld, type World } from '../helpers/woo-tax-world.ts'

/**
 * THE WOOCOMMERCE TAX-RATE WRITER AGAINST A REAL DATABASE AND AN IN-MEMORY STORE (lib/connectors/woocommerce/tax-rate-writer.ts).
 *
 * The store is a fake that counts every send; WooCommerce is never contacted (the no-outbound-network trap would fail a test that tried). The hold is read from an injected environment,
 * so the process environment is never touched.
 *   held        enforced, no grant: the apply records SHADOW rows, sends NOTHING, writes no change record and no mapping row; a repeat only counts
 *   not held    hold not enforced: refused, nothing recorded, nothing sent
 *   released    (test only) grant + live-from reached: sends EXACTLY the plan, records each change with its mapping row, and a re-run is a no-op
 *   refusals    a wrong or missing digest, a plan that changed after the preview, a blocker: nothing sent, nothing written
 *   store       a store refusal stops the run and keeps what was done; a send that cannot be recorded rolls the record AND the mapping row back together
 *   ownership   a store rate nobody mapped is never sent anything; a rate the writer created is owned by its record
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db). Fixtures are unique per run and removed afterwards; every other active tax rate is switched off for the run and restored.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/woo-tax-rate-writer.test.ts would have been skipped.')
}
const SKIP = { skip: skip && 'set RUN_DB_RETENTION_TESTS=1' } as const

const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }
const LIVE = { ...HELD, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }
const NOW = new Date('2026-06-01T00:00:00Z')
const ctx = (env: Record<string, string>) => ({ env, now: NOW })

async function modules() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, writer] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/connectors/woocommerce/tax-rate-writer.ts')])
  return { db, writer }
}
const withWorld = (t: test.TestContext, body: (w: World) => Promise<void>) => buildWorld(t, modules, body)

const expectedKeys = (w: World): string[] => [`delete:${w.woo.w4}`, `update:${w.woo.w2}`, `update:${w.woo.w3}`, `create:${w.ids.fr}`]

test('PRECONDITION: the world plans one DELETE, two UPDATEs and one CREATE, the hold reads as held / live / not enforced, and the unowned store rate is not in the plan', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const preview = await w.m.writer.readWooTaxPlan(w.deps(HELD))
    assert.equal(preview.refused, null)
    const plan = preview.plan!
    console.log(`# writer world: ${plan.changes.map((c) => c.key.replace(/\d{7}/, 'N')).join(', ')}; hold ${preview.hold.mode}; unowned ${plan.unownedLeftAlone}`)
    assert.deepEqual(plan.changes.map((c) => c.key), expectedKeys(w))
    assert.equal(plan.unownedLeftAlone, 1)
    assert.equal(w.m.writer.wooTaxHold(ctx(HELD)).mode, 'held')
    assert.equal(w.m.writer.wooTaxHold(ctx(LIVE)).mode, 'live')
    assert.equal(w.m.writer.wooTaxHold(ctx({})).mode, 'not-enforced')
    assert.ok(!JSON.stringify(plan).includes(w.woo.w5))
    assert.deepEqual(w.store.calls, [], 'a preview sends nothing')
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 }, 'a preview writes nothing')
  })
})

test('HELD: an apply records one SHADOW per change, sends NOTHING, writes no change record and no mapping row; a repeat only counts', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(HELD))).plan!
    const before = await w.mappingRows()
    const result = await w.m.writer.applyWooTaxPlan(w.deps(HELD), { confirm: plan.digest })
    assert.equal(result.outcome, 'DONE')
    if (result.outcome !== 'DONE') return
    assert.deepEqual(result.shadowed, plan.changes.map((c) => c.key))
    assert.deepEqual(result.applied, [])
    assert.equal(result.failed, null)
    assert.deepEqual(w.store.calls, [], 'zero sends while held')
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 4 })
    assert.deepEqual(await w.mappingRows(), before, 'no mapping row was created or changed')
    const shadows = await w.m.db.outboundShadowWrite.findMany({ where: { destination: 'woocommerce', operation: 'tax-rate' } })
    assert.deepEqual(shadows.map((s) => s.owner), ['operator-manual', 'operator-manual', 'operator-manual', 'operator-manual'])
    assert.ok(shadows.every((s) => s.phase === 'P1' && s.subjectType === 'WooTaxRate' && s.occurrences === 1))
    assert.deepEqual(shadows.map((s) => s.subjectId).sort(), plan.changes.map((c) => c.key).sort(), 'one shadow per change, identified by the change key')
    // A repeat: the same work again adds to the occurrences, not to the rows.
    const again = await w.m.writer.applyWooTaxPlan(w.deps(HELD), { confirm: plan.digest })
    assert.equal(again.outcome, 'DONE')
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 4 })
    assert.deepEqual((await w.m.db.outboundShadowWrite.findMany({ where: { destination: 'woocommerce', operation: 'tax-rate' } })).map((s) => s.occurrences), [2, 2, 2, 2])
    assert.deepEqual(w.store.calls, [])
  })
})

test('NOT ENFORCED: the apply is refused before anything is read; nothing is sent, recorded or shadowed', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps({}))).plan!
    const result = await w.m.writer.applyWooTaxPlan(w.deps({}), { confirm: plan.digest })
    assert.deepEqual(result, { outcome: 'REFUSED', code: 'HOLD_NOT_ENFORCED', plan: null })
    assert.deepEqual(w.store.calls, [])
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 })
  })
})

test('RELEASED (test only): the apply sends EXACTLY the plan, records each change with its mapping row, and a re-run has nothing to do', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const result = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(result.outcome, 'DONE')
    if (result.outcome !== 'DONE') return
    assert.equal(result.failed, null)
    assert.equal(result.sentButUnrecorded, null)
    assert.deepEqual(result.shadowed, [])
    assert.deepEqual(result.applied.map((a) => a.key), plan.changes.map((c) => c.key))
    // Exactly the plan: one send per change, in plan order, with exactly the planned values.
    assert.deepEqual(w.store.calls.map((c) => `${c.op}:${c.id ?? ''}`), [`remove:${w.woo.w4}`, `update:${w.woo.w2}`, `update:${w.woo.w3}`, 'create:'])
    assert.deepEqual(w.store.calls[1]!.body, { rate: '19.0000' })
    assert.deepEqual(w.store.calls[2]!.body, { state: '30' })
    assert.deepEqual(w.store.calls[3]!.body, { name: 'FR VAT', rate: '20.0000', country: 'FR', state: '', class: 'standard', compound: false, shipping: true })
    // The unowned rate was never named in a send and is exactly as it was.
    assert.ok(w.store.calls.every((c) => c.id !== w.woo.w5))
    assert.equal(w.store.rates.get(w.woo.w5)!.rate, '99.0000')
    // Records and mapping rows, together.
    const writes = await w.m.db.wooTaxRateWrite.findMany({ where: { planDigest: plan.digest }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(writes.map((r) => `${r.kind}:${r.status}`), ['DELETE:APPLIED', 'UPDATE:APPLIED', 'UPDATE:APPLIED', 'CREATE:APPLIED'])
    const created = result.applied.find((a) => a.kind === 'CREATE')!.wooId!
    assert.equal(writes[3]!.wooTaxRateId, created)
    const mapping = await w.m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: created } } })
    assert.equal(mapping?.taxRateId, w.ids.fr)
    assert.equal(mapping?.externalName, 'FR VAT')
    assert.equal(mapping?.externalRatePct.toFixed(4), '20.0000')
    const de = await w.m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: w.woo.w2 } } })
    assert.equal(de?.externalRatePct.toFixed(4), '19.0000', 'an UPDATE refreshes its mapping row')
    assert.equal(await w.m.db.shoppingTaxRateMapping.count({ where: { externalTaxRateId: w.woo.w4 } }), 1, 'a DELETE keeps its mapping row (historic orders resolve through it)')
    assert.deepEqual(await w.counts(), { writes: 4, mappings: 5, shadows: 0 })
    // The store now matches IMS, so the next plan is empty and a re-run sends nothing and writes nothing.
    const sends = w.store.calls.length
    const rerun = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(rerun.outcome, 'NOTHING_TO_DO')
    assert.equal(w.store.calls.length, sends)
    assert.deepEqual(await w.counts(), { writes: 4, mappings: 5, shadows: 0 })
    assert.deepEqual((await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!.changes, [])
  })
})

test('DIGEST: a missing, malformed or wrong digest is refused, and so is a plan that changed after the preview; nothing is sent or written', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    for (const confirm of [undefined, '', 'abc', plan.digest.toUpperCase(), plan.digest.slice(1)]) {
      const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm })
      assert.deepEqual(r, { outcome: 'REFUSED', code: 'CONFIRM_REQUIRED', plan: null })
    }
    const wrong = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: '0'.repeat(64) })
    assert.equal(wrong.outcome === 'REFUSED' ? wrong.code : wrong.outcome, 'DIGEST_MISMATCH')
    // The store changes between the preview and the apply (someone corrected a rate by hand): the old digest no longer holds.
    w.store.rates.set(w.woo.w2, { ...w.store.rates.get(w.woo.w2)!, rate: '19.0000' })
    const stale = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(stale.outcome === 'REFUSED' ? stale.code : stale.outcome, 'DIGEST_MISMATCH')
    assert.deepEqual(w.store.calls, [])
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 })
  })
})

test('BLOCKER: an unmapped store rate that looks like the rate a CREATE would add refuses the apply; nothing is sent', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    w.store.rates.set('8000001', woo('8000001', { name: 'FR VAT', country: 'FR' }))
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.deepEqual(plan.blockers.map((b) => b.code), ['UNMAPPED_TWIN'])
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome === 'REFUSED' ? r.code : r.outcome, 'BLOCKED')
    assert.deepEqual(w.store.calls, [])
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 })
  })
})

test('STORE REFUSAL: the run stops at the refused change, records it FAILED, keeps what was done and sends nothing after it', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    w.store.refuse = (n) => (n === 2 ? 'the class does not exist' : null)
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    if (r.outcome !== 'DONE') return
    assert.deepEqual(r.applied.map((a) => a.key), [`delete:${w.woo.w4}`])
    assert.equal(r.failed?.key, `update:${w.woo.w2}`)
    assert.equal(w.store.calls.length, 2, 'nothing was sent after the refusal')
    const writes = await w.m.db.wooTaxRateWrite.findMany({ where: { planDigest: plan.digest }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(writes.map((x) => `${x.kind}:${x.status}`), ['DELETE:APPLIED', 'UPDATE:FAILED'])
    assert.equal(writes[1]!.error, 'the class does not exist')
    // The refused UPDATE did not change its mapping row.
    const de = await w.m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: w.woo.w2 } } })
    assert.equal(de?.externalRatePct.toFixed(4), '18.0000')
  })
})

test('ONE TRANSACTION: when the mapping row cannot be written, the change record is rolled back with it, and the run says the send was not recorded', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    // The id the store will give the created rate already has a mapping row (to another IMS rate): the mapping insert violates its unique key.
    await w.m.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(Number(w.woo.w1) + 99), taxRateId: w.ids.old, externalName: 'x', externalRatePct: '1', externalClass: '' } })
    const created = String(Number(w.woo.w1) + 99)
    assert.equal(await w.m.db.shoppingTaxRateMapping.count({ where: { externalTaxRateId: created } }), 1, 'PRECONDITION: the next created id is already mapped')
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    if (r.outcome !== 'DONE') return
    assert.equal(r.sentButUnrecorded, `create:${w.ids.fr}`)
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'CREATE', imsTaxRateId: w.ids.fr } }), 0, 'the CREATE record did not survive its failed mapping row')
    assert.deepEqual(r.applied.map((a) => a.kind), ['DELETE', 'UPDATE', 'UPDATE'])
  })
})

test('A CREATE the store answers without a usable id is reported as sent but unrecorded, and nothing is written for it', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const port = { create: async () => ({ ok: true as const, id: 'not-an-id' }), update: w.store.update.bind(w.store), remove: w.store.remove.bind(w.store) }
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), port }, { confirm: plan.digest })
    assert.equal(r.outcome === 'DONE' ? r.sentButUnrecorded : null, `create:${w.ids.fr}`)
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'CREATE', imsTaxRateId: w.ids.fr } }), 0)
  })
})

test('OWNERSHIP BY RECORD: a rate the writer created is owned by its record: once unmapped it is reported and blocks a duplicate, never touched or deleted', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    const created = r.outcome === 'DONE' ? r.applied.find((a) => a.kind === 'CREATE')!.wooId! : ''
    await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: created } })
    const next = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.deepEqual(next.blockers.map((b) => `${b.code}:${b.imsRateId}:${b.wooId}`), [`UNMAPPED_TWIN:${w.ids.fr}:${created}`], 'the writer\'s own unmapped rate is a twin: no second FR rate is created')
    assert.ok(next.findings.some((f) => f.code === 'OWNED_BUT_UNMAPPED' && f.wooId === created))
    const sends = w.store.calls.length
    const blocked = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: next.digest })
    assert.equal(blocked.outcome === 'REFUSED' ? blocked.code : blocked.outcome, 'BLOCKED')
    assert.equal(w.store.calls.length, sends, 'nothing more was sent: the owned rate is neither adopted, changed nor deleted')
    assert.equal(next.unownedLeftAlone, 1, 'only the hand-made rate is unowned')
  })
})

test('REFRESH_MAPPING: a stale mapping row is brought up to date with NOTHING sent to the store, and recorded', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    // Make the world otherwise right: only the stored class of the GB mapping is stale.
    await w.m.db.shoppingTaxRateMapping.update({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: w.woo.w1 } }, data: { externalClass: 'zero-rate' } })
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.ok(plan.changes.some((c) => c.kind === 'REFRESH_MAPPING' && c.wooId === w.woo.w1))
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    assert.ok(!w.store.calls.some((c) => c.id === w.woo.w1), 'nothing was sent for the refreshed rate')
    const mapping = await w.m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: w.woo.w1 } } })
    assert.equal(mapping?.externalClass, 'standard')
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'REFRESH_MAPPING', wooTaxRateId: w.woo.w1, status: 'APPLIED' } }), 1)
  })
})

test('NO PORT: an apply with no write port is refused before the database is read', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const noPort = { ...w.deps(LIVE), port: undefined }
    assert.deepEqual(await w.m.writer.applyWooTaxPlan(noPort, { confirm: plan.digest }), { outcome: 'REFUSED', code: 'PORT_MISSING', plan: null })
    assert.deepEqual(w.store.calls, [])
  })
})

test('A STORE THAT CANNOT BE READ is a refusal, never an empty store: the preview refuses and an apply sends and writes nothing (an empty read would plan a CREATE of every rate)', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const good = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const unreadable = { ...w.deps(LIVE), readWoo: async () => ({ ok: false as const }) }
    const preview = await w.m.writer.readWooTaxPlan(unreadable)
    assert.equal(preview.refused, 'WOO_UNREADABLE')
    assert.equal(preview.plan, null)
    const applied = await w.m.writer.applyWooTaxPlan(unreadable, { confirm: good.digest })
    assert.deepEqual(applied, { outcome: 'REFUSED', code: 'WOO_UNREADABLE', plan: null })
    assert.deepEqual(w.store.calls, [])
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 })
  })
})
