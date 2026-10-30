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
    assert.equal(result.unrecorded, null)
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
    assert.equal(r.unrecorded?.key, `create:${w.ids.fr}`)
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'CREATE', imsTaxRateId: w.ids.fr } }), 0, 'the CREATE record did not survive its failed mapping row')
    assert.deepEqual(r.applied.map((a) => a.kind), ['DELETE', 'UPDATE', 'UPDATE'])
  })
})

test('A CREATE the store answers without a usable id is reported as sent but unrecorded, and nothing is written for it', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const port = { create: async () => ({ ok: true as const, id: 'not-an-id' }), update: w.store.update.bind(w.store), remove: w.store.remove.bind(w.store) }
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), port }, { confirm: plan.digest })
    assert.equal(r.outcome === 'DONE' ? r.unrecorded?.key : null, `create:${w.ids.fr}`)
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

const OTHER = 'https://other-store.example'
const mappingOf = (w: World, wooId: string) => w.m.db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: wooId } } })

test('STORE IDENTITY ON WRITE: every record and every mapping row the writer makes is stamped with the store it was made against', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    const writes = await w.m.db.wooTaxRateWrite.findMany({ where: { planDigest: plan.digest } })
    assert.equal(writes.length, 4)
    assert.ok(writes.every((x) => x.storeIdentity === 'https://store.example'))
    const created = r.outcome === 'DONE' ? r.applied.find((a) => a.kind === 'CREATE')!.wooId! : ''
    assert.equal((await mappingOf(w, created))?.storeIdentity, 'https://store.example')
  })
})

test('STORE URL CHANGE: the old mappings are no longer owned: findings only, nothing is changed, sent or recorded, and the digest is not the old one', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    await w.m.db.taxRate.update({ where: { id: w.ids.fr }, data: { active: false } }) // so that nothing at all is left to create
    const before = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.ok(before.changes.length > 0, 'PRECONDITION: against the store the mappings were made for, there is work')
    const moved = { ...w.deps(LIVE), storeIdentity: async () => OTHER }
    const plan = (await w.m.writer.readWooTaxPlan(moved)).plan!
    assert.deepEqual(plan.changes, [])
    assert.deepEqual(plan.findings.map((f) => f.code), ['MAPPING_NOT_ADOPTED', 'MAPPING_NOT_ADOPTED', 'MAPPING_NOT_ADOPTED', 'MAPPING_NOT_ADOPTED'])
    assert.notEqual(plan.digest, before.digest)
    const r = await w.m.writer.applyWooTaxPlan(moved, { confirm: before.digest })
    assert.equal(r.outcome, 'NOTHING_TO_DO')
    assert.deepEqual(w.store.calls, [])
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 })
    // A store with no usable URL is a refusal, not a guess.
    const none = await w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), storeIdentity: async () => null }, { confirm: before.digest })
    assert.deepEqual(none, { outcome: 'REFUSED', code: 'STORE_UNIDENTIFIED', plan: null })
    assert.equal((await w.m.writer.readWooTaxPlan({ ...w.deps(LIVE), storeIdentity: async () => { throw new Error('x') } })).refused, 'STORE_UNIDENTIFIED')
  })
})

test('RECORDS OF ANOTHER STORE own nothing: a rate the writer created against one store is only a finding-free stranger against another', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    const created = r.outcome === 'DONE' ? r.applied.find((a) => a.kind === 'CREATE')!.wooId! : ''
    await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: created } })
    const here = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.ok(here.findings.some((f) => f.code === 'OWNED_BUT_UNMAPPED' && f.wooId === created))
    const there = (await w.m.writer.readWooTaxPlan({ ...w.deps(LIVE), storeIdentity: async () => OTHER })).plan!
    assert.ok(!there.findings.some((f) => f.code === 'OWNED_BUT_UNMAPPED'), 'a record made against another store does not own this store\'s rate')
  })
})

test('RATE IDENTITY: a replaced or reused store rate (differs from the snapshot) is RE_ADOPTION_REQUIRED: nothing is sent for it, its IMS rate is not re-created, the rest proceeds', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    w.store.rates.set(w.woo.w2, woo(w.woo.w2, { name: 'Another shop rate', country: 'IE', rate: '5.0000' })) // id reused by an unrelated rate
    w.store.rates.set(w.woo.w4, { ...w.store.rates.get(w.woo.w4)!, rate: '77.0000' }) // the rate IMS wants deleted was re-purposed by hand
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.deepEqual(plan.findings.filter((f) => f.code === 'RE_ADOPTION_REQUIRED').map((f) => f.wooId).sort(), [w.woo.w2, w.woo.w4].sort())
    assert.deepEqual(plan.changes.map((c) => c.key), [`update:${w.woo.w3}`, `create:${w.ids.fr}`])
    const r = await w.m.writer.applyWooTaxPlan(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    assert.ok(w.store.calls.every((c) => c.id !== w.woo.w2 && c.id !== w.woo.w4), 'nothing was sent for a rate that needs re-adoption')
    assert.equal(w.store.rates.get(w.woo.w2)!.name, 'Another shop rate')
    assert.equal(w.store.rates.has(w.woo.w4), true, 'the re-purposed rate was not deleted')
    assert.equal(await w.m.db.taxRate.count({ where: { id: w.ids.de } }), 1)
  })
})

test('ADOPTION: legacy rows (no store identity) are findings until the operator adopts them; adopting stamps them, re-snapshots from the live rate, records ADOPT, sends nothing, and a re-run is a no-op', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    await w.m.db.shoppingTaxRateMapping.updateMany({ where: { externalTaxRateId: { in: [w.woo.w1, w.woo.w2, w.woo.w3, w.woo.w4] } }, data: { storeIdentity: null } })
    const before = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.deepEqual(before.changes.map((c) => c.key), [`create:${w.ids.fr}`], 'legacy rows own nothing: no update and no delete of the four mapped rates (only FR, which has no mapping at all, is created)')
    assert.equal(before.findings.filter((f) => f.code === 'MAPPING_NOT_ADOPTED').length, 4)
    // the preview
    const preview = await w.m.writer.readWooAdoptionPlan(w.deps(LIVE))
    assert.equal(preview.refused, null)
    const plan = preview.plan!
    assert.deepEqual(plan.rows.map((x) => `${x.wooId}:${x.reason}`), [w.woo.w1, w.woo.w2, w.woo.w3, w.woo.w4].map((id) => `${id}:UNSTAMPED`))
    assert.deepEqual(await w.counts(), { writes: 0, mappings: 4, shadows: 0 }, 'a preview writes nothing')
    // digest discipline
    assert.equal((await w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: undefined })).outcome, 'REFUSED')
    const wrong = await w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: '0'.repeat(64) })
    assert.equal(wrong.outcome === 'REFUSED' ? wrong.code : wrong.outcome, 'DIGEST_MISMATCH')
    assert.equal((await mappingOf(w, w.woo.w2))?.storeIdentity, null)
    // the adoption
    const done = await w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(done.outcome, 'ADOPTED')
    assert.deepEqual(w.store.calls, [], 'adoption sends nothing to the store')
    const de = await mappingOf(w, w.woo.w2)
    assert.equal(de?.storeIdentity, 'https://store.example')
    assert.equal(de?.externalRatePct.toFixed(4), '18.0000', 'the snapshot is rewritten from the live rate (18, not IMS\'s 19)')
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'ADOPT', planDigest: plan.digest, status: 'APPLIED', storeIdentity: 'https://store.example' } }), 4)
    const again = await w.m.writer.applyWooAdoption(w.deps(LIVE), { confirm: plan.digest })
    assert.equal(again.outcome, 'NOTHING_TO_DO')
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'ADOPT' } }), 4)
    // and now the writer has its ordinary work again; an ADOPT record owns nothing by itself
    const after = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    assert.deepEqual(after.changes.map((c) => c.key), expectedKeys(w))
    assert.equal(after.findings.filter((f) => f.code === 'MAPPING_NOT_ADOPTED').length, 0)
  })
})

test('ADOPTION also re-stamps a rate that drifted from its snapshot, in ONE transaction: a mapping row that goes away rolls every stamp back', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    w.store.rates.set(w.woo.w2, woo(w.woo.w2, { name: 'DE VAT', country: 'DE', rate: '19.0000' })) // hand-corrected since the snapshot (18)
    const plan = (await w.m.writer.readWooAdoptionPlan(w.deps(LIVE))).plan!
    assert.deepEqual(plan.rows.map((x) => `${x.wooId}:${x.reason}`), [`${w.woo.w2}:SNAPSHOT_DIFFERS`])
    // a second candidate whose row vanishes during the adoption
    await w.m.db.shoppingTaxRateMapping.update({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: w.woo.w1 } }, data: { storeIdentity: null } })
    const two = (await w.m.writer.readWooAdoptionPlan(w.deps(LIVE))).plan!
    assert.equal(two.rows.length, 2)
    const racing = { ...w.deps(LIVE), readWoo: async () => { const r = await w.store.readWoo(); await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: w.woo.w2 } }); return r } }
    const r = await w.m.writer.applyWooAdoption(racing, { confirm: two.digest })
    assert.deepEqual(r, { outcome: 'REFUSED', code: 'ADOPTION_FAILED', plan: two })
    assert.equal((await mappingOf(w, w.woo.w1))?.storeIdentity, null, 'the other stamp was rolled back with it')
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'ADOPT' } }), 0)
  })
})

test('UNRECORDED: a mapping row that went away between the send and the record leaves the send UNRECORDED with its reason, rolls the record back and stops the run', SKIP, async (t) => {
  await withWorld(t, async (w) => {
    const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
    const port = {
      create: w.store.create.bind(w.store), remove: w.store.remove.bind(w.store),
      update: async (id: string, body: Parameters<typeof w.store.update>[1]) => {
        const sent = await w.store.update(id, body)
        if (id === w.woo.w2) await w.m.db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: id } }) // removed after the send, before the record
        return sent
      },
    }
    const r = await w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), port }, { confirm: plan.digest })
    assert.equal(r.outcome, 'DONE')
    if (r.outcome !== 'DONE') return
    assert.equal(r.unrecorded?.key, `update:${w.woo.w2}`)
    assert.match(r.unrecorded?.reason ?? '', /not the planned one any more \(0 row\(s\) matched/)
    assert.deepEqual(r.applied.map((a) => a.key), [`delete:${w.woo.w4}`])
    assert.equal(w.store.calls.length, 2, 'the run stopped: nothing was sent after the unrecorded change')
    assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { changeKey: `update:${w.woo.w2}` } }), 0, 'no APPLIED record for a change whose mapping could not be written')
  })
})

test('UNRECORDED: a mapping row re-pointed at another IMS rate (or stamped for another store) is not the planned one either; a DELETE rests on its row too', SKIP, async (t) => {
  for (const tamper of ['repoint', 'restamp'] as const) {
    await withWorld(t, async (w) => {
      const plan = (await w.m.writer.readWooTaxPlan(w.deps(LIVE))).plan!
      const port = {
        create: w.store.create.bind(w.store), update: w.store.update.bind(w.store),
        remove: async (id: string) => {
          const sent = await w.store.remove(id)
          await w.m.db.shoppingTaxRateMapping.update({ where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: id } }, data: tamper === 'repoint' ? { taxRateId: w.ids.gb } : { storeIdentity: OTHER } })
          return sent
        },
      }
      const r = await w.m.writer.applyWooTaxPlan({ ...w.deps(LIVE), port }, { confirm: plan.digest })
      assert.equal(r.outcome === 'DONE' ? r.unrecorded?.key : r.outcome, `delete:${w.woo.w4}`, tamper)
      assert.equal(w.store.calls.length, 1, tamper)
      assert.equal(await w.m.db.wooTaxRateWrite.count({ where: { kind: 'DELETE' } }), 0, tamper)
    })
  }
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
