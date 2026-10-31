import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADOPTION_REASONS, DELETE_REASONS, WOO_TAX_BLOCKER_CODES, WOO_TAX_FINDING_CODES, identityOfMapping, identityOfWoo, normaliseStoreIdentity, ownedWooIdsFromRecords, planAdoption, planWooTaxRates, revalidateWooTaxChange, sameRateIdentity,
  type WooTaxChange, type WooTaxMappingRow, type WooTaxPlan, type WooTaxPlanInput,
} from '../../lib/connectors/woocommerce/tax-rate-plan.ts'
import { compareVatSetIdentity } from '../../lib/reconciliation-pack/vat-set-identity.ts'
import type { WooTaxRateDetail } from '../../lib/reconciliation-pack/woo-source.ts'
import { OTHER_STORE, STORE, consistent, ims, mapOf, woo } from '../helpers/woo-tax-fakes.ts'

/**
 * THE WOOCOMMERCE TAX-RATE PLAN, pure. One arm per change kind and per field, the ownership rule, the shipping rule, regional rates, and the property the plan exists for: applied to
 * the store, R13's WooCommerce side holds. [mutation: each rule below has a red mutation in /scratch/wootax/mut.py, listed in the PR]
 */

type Input = { woo: WooTaxRateDetail[]; rates: ReturnType<typeof consistent>['rates']; mappings: WooTaxMappingRow[]; recorded?: string[] }
const plan = (input: Input): WooTaxPlan =>
  planWooTaxRates({ woo: input.woo, rates: input.rates, mappings: input.mappings, componentRates: [], recordedOwnedWooIds: new Set(input.recorded ?? []), storeIdentity: STORE } satisfies WooTaxPlanInput)
const kinds = (p: WooTaxPlan): string[] => p.changes.map((c) => `${c.kind}:${c.key}`)
const only = (p: WooTaxPlan): WooTaxChange => { assert.equal(p.changes.length, 1, `expected one change, got ${kinds(p).join(', ')}`); return p.changes[0]! }

/** Apply a plan to the in-memory store and mapping, as the writer does, and report what R13 then says about the WooCommerce side. */
function applyToWorld(input: Input, p: WooTaxPlan): { world: Input; woo: string[] } {
  const wooRates = input.woo.map((w) => ({ ...w }))
  let mappings = input.mappings.map((m) => ({ ...m }))
  let next = 900
  for (const change of p.changes) {
    if (change.kind === 'CREATE') {
      const id = String(next++)
      const a = change.after
      const created = { id, name: a.name, rate: a.rate, country: a.country, state: a.state, postcode: '', city: '', class: a.class, shipping: a.shipping, compound: a.compound }
      wooRates.push(created)
      mappings.push(mapOf(created, change.imsRateId))
    } else if (change.kind === 'UPDATE') {
      const w = wooRates.find((x) => x.id === change.wooId)!
      Object.assign(w, change.after)
      mappings = mappings.map((m) => (m.externalTaxRateId === change.wooId ? mapOf(w, m.taxRateId) : m))
    } else if (change.kind === 'DELETE') {
      wooRates.splice(wooRates.findIndex((x) => x.id === change.wooId), 1)
    }
  }
  const world = { ...input, woo: wooRates, mappings }
  const rows = compareVatSetIdentity({
    woo: wooRates, rates: input.rates,
    mappings: mappings.map((m) => ({ connector: 'woocommerce', externalTaxRateId: m.externalTaxRateId, taxRateId: m.taxRateId, externalClass: m.externalClass })),
    componentRates: [], xero: [],
  })
  const problems = rows.filter((r) => r.system === 'woo' || r.reasons.includes('MISSING_IN_WOO')).flatMap((r) => r.reasons.filter((reason) => r.system === 'woo' || reason === 'MISSING_IN_WOO').map((reason) => `${r.system}:${r.id}:${reason}`))
  return { world, woo: problems }
}

test('PRECONDITION: the consistent set needs nothing, and R13 agrees it is identical on the WooCommerce side', () => {
  const input = consistent()
  const p = plan(input)
  console.log(`# plan(consistent): ${p.changes.length} changes, ${p.blockers.length} blockers, ${p.findings.length} findings, ${p.inScopeRates} in-scope rates, ${p.wooRates} store rates`)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.blockers, [])
  assert.deepEqual(p.findings, [])
  assert.equal(p.inScopeRates, 4)
  assert.equal(p.wooRates, 4)
  assert.deepEqual(applyToWorld(input, p).woo, [])
})

test('CREATE: an in-scope IMS rate with no mapping is created, with shipping on, the region of its name and the class of its category', () => {
  const input = consistent()
  input.rates.push(ims('rFR', { name: 'FR VAT', rate: '0.2000', countryCode: 'FR', reportingCategory: 'OSS' }))
  input.rates.push(ims('rPT20', { name: 'PT-20 VAT', rate: '0.1600', countryCode: 'PT', reportingCategory: 'OSS', taxCategory: 'REDUCED' }))
  const p = plan(input)
  assert.equal(p.counts.CREATE, 2)
  const fr = p.changes.find((c) => c.key === 'create:rFR')!
  assert.equal(fr.kind, 'CREATE')
  assert.deepEqual(fr.kind === 'CREATE' ? fr.after : null, { name: 'FR VAT', rate: '20.0000', country: 'FR', state: '', class: 'standard', compound: false, shipping: true })
  const pt = p.changes.find((c) => c.key === 'create:rPT20')!
  assert.deepEqual(pt.kind === 'CREATE' ? pt.after : null, { name: 'PT-20 VAT', rate: '16.0000', country: 'PT', state: '20', class: 'reduced-rate', compound: false, shipping: true })
  assert.deepEqual(applyToWorld(input, p).woo, [])
})

test('CREATE: a mapping to a store rate the store no longer has is not a counterpart; the stale id is named and its mapping row is kept', () => {
  const input = consistent()
  input.woo = input.woo.filter((w) => w.id !== '2')
  const change = only(plan(input))
  assert.equal(change.kind, 'CREATE')
  assert.deepEqual(change.kind === 'CREATE' ? change.staleWooIds : null, ['2'])
})

const FIELD_CASES: Array<{ field: string; mutate: (w: WooTaxRateDetail) => WooTaxRateDetail; before: string | boolean; after: string | boolean }> = [
  { field: 'name', mutate: (w) => ({ ...w, name: 'United Kingdom VAT' }), before: 'United Kingdom VAT', after: 'GB VAT' },
  { field: 'rate', mutate: (w) => ({ ...w, rate: '15.0000' }), before: '15.0000', after: '20.0000' },
  { field: 'country', mutate: (w) => ({ ...w, country: 'IE' }), before: 'IE', after: 'GB' },
  { field: 'class', mutate: (w) => ({ ...w, class: 'reduced-rate' }), before: 'reduced-rate', after: 'standard' },
  { field: 'compound', mutate: (w) => ({ ...w, compound: true }), before: true, after: false },
  { field: 'shipping', mutate: (w) => ({ ...w, shipping: false }), before: false, after: true },
]
for (const c of FIELD_CASES) {
  test(`UPDATE ${c.field}: a store rate that differs only in ${c.field} gets exactly that field, with before and after, and R13 then holds`, () => {
    const input = consistent()
    input.woo = input.woo.map((w) => (w.id === '1' ? c.mutate(w) : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(input.woo.find((w) => w.id === '1')!, 'rGB') : m))
    const p = plan(input)
    const change = only(p)
    assert.equal(change.kind, 'UPDATE')
    if (change.kind !== 'UPDATE') return
    assert.equal(change.wooId, '1')
    assert.deepEqual(change.fields, [{ field: c.field, before: c.before, after: c.after }])
    assert.deepEqual(applyToWorld(input, p).woo, [])
  })
}

test('UPDATE: a case or spacing difference of the name is not a difference (R13 compares trimmed, collapsed, case-insensitive)', () => {
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, name: '  gb   vat ' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(input.woo[0]!, 'rGB') : m))
  assert.deepEqual(plan(input).changes, [])
})

test('UPDATE state: a regional rate whose store state is another region, or none, is corrected to the region its IMS name states (PT-30)', () => {
  for (const state of ['20', '']) {
    const input = consistent()
    input.woo = input.woo.map((w) => (w.id === '4' ? { ...w, state } : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '4' ? mapOf(input.woo.find((w) => w.id === '4')!, 'rPT30') : m))
    const p = plan(input)
    const change = only(p)
    assert.equal(change.kind, 'UPDATE')
    assert.deepEqual(change.kind === 'UPDATE' ? change.fields : null, [{ field: 'state', before: state, after: '30' }])
    assert.deepEqual(applyToWorld(input, p).woo, [])
  }
  // The store's PT-30 spelling of the same region is the same region: no change.
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '4' ? { ...w, state: 'PT-30' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '4' ? mapOf(input.woo.find((w) => w.id === '4')!, 'rPT30') : m))
  assert.deepEqual(plan(input).changes, [])
})

test('UPDATE: several differences in one rate are one UPDATE listing every field, in a fixed order', () => {
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '2' ? { ...w, rate: '21.0000', compound: true, shipping: false, name: 'Germany' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '2' ? mapOf(input.woo.find((w) => w.id === '2')!, 'rDE') : m))
  const change = only(plan(input))
  assert.deepEqual(change.kind === 'UPDATE' ? change.fields.map((f) => f.field) : null, ['name', 'rate', 'compound', 'shipping'])
})

test('the percent is the one IMS computes tax at: the active components\' effective rate when it has any, not the rate column', () => {
  const input = consistent()
  const p = planWooTaxRates({
    woo: input.woo, rates: input.rates, mappings: input.mappings, recordedOwnedWooIds: new Set(), storeIdentity: STORE,
    componentRates: [
      { taxRateId: 'rGB', rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 0 },
      { taxRateId: 'rGB', rate: '0.0500', compoundOnPrevious: false, active: true, sortOrder: 1 },
      { taxRateId: 'rGB', rate: '0.5000', compoundOnPrevious: false, active: false, sortOrder: 2 },
    ],
  })
  const change = only(p)
  assert.equal(change.kind, 'UPDATE')
  assert.deepEqual(change.kind === 'UPDATE' ? change.fields : null, [{ field: 'rate', before: '20.0000', after: '15.0000' }])
})

test('DELETE: an owned store rate mapped to an inactive, purchase-only or reverse-charge IMS rate is deleted, with the reason', () => {
  const cases: Array<[string, Partial<ReturnType<typeof ims>>, keyof typeof DELETE_REASONS]> = [
    ['inactive', { active: false }, 'IMS_RATE_INACTIVE'],
    ['purchase only', { usedFor: 'PURCHASE' }, 'IMS_RATE_PURCHASE_ONLY'],
    ['reverse charge', { reverseCharge: true }, 'IMS_RATE_REVERSE_CHARGE'],
  ]
  for (const [label, over, reason] of cases) {
    const input = consistent()
    input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, ...over } : r))
    const p = plan(input)
    const change = only(p)
    assert.equal(change.kind, 'DELETE', label)
    if (change.kind !== 'DELETE') return
    assert.equal(change.wooId, '2', label)
    assert.equal(change.reason, reason, label)
    assert.equal(change.before.name, 'DE VAT')
    assert.deepEqual(applyToWorld(input, p).woo, [], label)
  }
})

test('DELETE: of two store rates mapped to one IMS rate, the one nearer the desired state is kept and the other deleted', () => {
  const input = consistent()
  const twin = woo('5', { name: 'GB VAT', rate: '17.5000' })
  input.woo.push(twin)
  input.mappings.push(mapOf(twin, 'rGB'))
  const p = plan(input)
  const change = only(p)
  assert.equal(change.kind, 'DELETE')
  assert.equal(change.kind === 'DELETE' ? change.wooId : null, '5')
  assert.equal(change.kind === 'DELETE' ? change.reason : null, 'DUPLICATE_COUNTERPART')
  // The nearer one wins even when it has the HIGHER id.
  const nearer = consistent()
  nearer.woo = nearer.woo.map((w) => (w.id === '1' ? { ...w, rate: '17.5000' } : w))
  nearer.mappings = nearer.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(nearer.woo.find((w) => w.id === '1')!, 'rGB') : m))
  const right = woo('5')
  nearer.woo.push(right)
  nearer.mappings.push(mapOf(right, 'rGB'))
  const swapped = only(plan(nearer))
  assert.equal(swapped.kind === 'DELETE' ? swapped.wooId : null, '1', 'the worse rate goes, whatever its id')
  // Equally near: the lower id is kept.
  const equal = consistent()
  const same = woo('5')
  equal.woo.push(same)
  equal.mappings.push(mapOf(same, 'rGB'))
  const tie = only(plan(equal))
  assert.equal(tie.kind === 'DELETE' ? tie.wooId : null, '5')
  assert.deepEqual(applyToWorld(input, p).woo, [])
})

// [mutation: keeper left out of the DELETE (set to null) -> the recorded-keeper arm fails; mutation: one keeper field dropped from keeperFieldsOfWoo -> its digest arm fails; mutation: the keeper not required by revalidation -> the revalidation arm fails]
test('DELETE (duplicate): the plan names the intended keeper and binds its full live fields into the delete and the digest', () => {
  const build = (keeperOver: Partial<WooTaxRateDetail> = {}) => {
    const input = consistent()
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, ...keeperOver } : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(input.woo.find((w) => w.id === '1')!, 'rGB') : m))
    const twin = woo('5', { name: 'GB VAT', rate: '17.5000' })
    input.woo.push(twin)
    input.mappings.push(mapOf(twin, 'rGB'))
    return { input, plan: plan(input) }
  }
  const { input, plan: p } = build()
  const change = only(p)
  assert.equal(change.kind, 'DELETE')
  if (change.kind !== 'DELETE') return
  const keeperLive = input.woo.find((w) => w.id === '1')!
  assert.deepEqual(change.keeper, {
    wooId: '1',
    fields: { name: keeperLive.name, rate: keeperLive.rate, country: keeperLive.country, state: keeperLive.state, postcode: keeperLive.postcode, city: keeperLive.city, class: keeperLive.class, shipping: keeperLive.shipping, compound: keeperLive.compound },
  })
  // A keeper with a postcode and a city (the plan reports them as a finding and leaves them alone): both are recorded.
  const located = build({ postcode: 'AB1 2CD', city: 'Leeds' })
  const locatedChange = only(located.plan)
  assert.deepEqual(locatedChange.kind === 'DELETE' ? [locatedChange.keeper?.fields.postcode, locatedChange.keeper?.fields.city] : null, ['AB1 2CD', 'Leeds'])
  // Differences the plan's own comparisons treat as equal (so no UPDATE, no finding) still move the digest, because the keeper's live fields are bound.
  const base = p.digest
  assert.equal(build().plan.digest, base, 'control: same state, same digest')
  const variants: Array<[string, Partial<WooTaxRateDetail>]> = [
    ['name spelling', { name: 'gb  vat' }],
    ['rate text', { rate: '20' }],
    ['class spelling', { class: '' }],
    ['country spelling', { country: 'UK' }],
  ]
  for (const [label, over] of variants) {
    const other = build(over).plan
    assert.deepEqual(other.changes.filter((c) => c.kind !== 'DELETE'), [], `${label}: precondition, the keeper still needs no update`)
    assert.notEqual(other.digest, base, `${label}: the keeper's live field is in the digest`)
  }
  // An out-of-scope delete has no keeper.
  const gone = consistent()
  gone.rates = gone.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r))
  const out = only(plan(gone))
  assert.equal(out.kind === 'DELETE' ? out.keeper : undefined, null)
  // Revalidation: the keeper must still be a stamped counterpart of the IMS rate.
  const mappings = input.mappings
  const base2 = { change, storeIdentity: STORE, rate: input.rates.find((r) => r.id === 'rGB'), componentRates: [], live: input.woo.find((w) => w.id === '5') }
  assert.equal(revalidateWooTaxChange({ ...base2, mappings }), null)
  assert.equal(revalidateWooTaxChange({ ...base2, mappings: mappings.filter((m) => m.externalTaxRateId !== '1') }), 'IMS_RATE_CHANGED', 'the keeper mapping is gone')
  assert.equal(revalidateWooTaxChange({ ...base2, mappings: mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, storeIdentity: null } : m)) }), 'IMS_RATE_CHANGED', 'the keeper is no longer stamped')
  assert.equal(revalidateWooTaxChange({ ...base2, change: { ...change, keeper: null }, mappings }), 'IMS_RATE_CHANGED', 'a duplicate delete with no keeper is not sent')
  // Another stamped counterpart of the IMS rate does not stand in for the intended keeper, and a keeper that is the deleted rate itself is no keeper.
  const third = woo('9', { name: 'GB VAT' })
  assert.equal(revalidateWooTaxChange({ ...base2, mappings: [...mappings.filter((m) => m.externalTaxRateId !== '1'), mapOf(third, 'rGB')] }), 'IMS_RATE_CHANGED', 'the intended keeper is gone, another counterpart exists')
  assert.equal(revalidateWooTaxChange({ ...base2, change: { ...change, keeper: { ...change.keeper!, wooId: '5' } }, mappings }), 'IMS_RATE_CHANGED', 'the keeper is the rate being deleted')
  // Another counterpart does not stand in for the intended keeper.
  assert.equal(revalidateWooTaxChange({ ...base2, mappings: mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, taxRateId: 'rDE' } : m)) }), 'IMS_RATE_CHANGED', 'the keeper mapping now points elsewhere')
})

test('OWNERSHIP: a store rate that is not mapped and not recorded is never touched, however wrong it is, and is only counted', () => {
  const input = consistent()
  input.woo.push(woo('77', { name: 'Hand made', rate: '99.0000', country: 'FR', class: 'weird', shipping: false, compound: true }))
  input.woo.push(woo('78', { name: 'PT-30 VAT', country: 'PT', state: '30', rate: '22.0000' })) // looks like rPT30's rate but is not its counterpart
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.equal(p.unownedLeftAlone, 2)
  assert.ok(!JSON.stringify(p).includes('"77"'), 'the unowned rate does not appear in the plan')
})

test('OWNERSHIP: a store rate mapped to a rate that is out of scope is owned by the mapping; one mapped to nothing and unrecorded is not', () => {
  const input = consistent()
  input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, active: false } : r))
  assert.deepEqual(plan(input).changes.map((c) => c.key), ['delete:1'])
  input.mappings = input.mappings.filter((m) => m.externalTaxRateId !== '1')
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.equal(p.unownedLeftAlone, 1)
})

test('OWNERSHIP: a rate this writer created and recorded, since unmapped, is a finding and never a change', () => {
  const input: Input = consistent()
  input.mappings = input.mappings.filter((m) => m.externalTaxRateId !== '3')
  input.rates = input.rates.filter((r) => r.id !== 'rCAN')
  input.recorded = ['3']
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.findings, [{ code: 'OWNED_BUT_UNMAPPED', wooId: '3' }])
  assert.equal(p.unownedLeftAlone, 0)
})

test('SHIPPING: a positive rate is always created and updated with shipping on; a 0% rate keeps shipping off (R13\'s exemption) and is never switched off or on', () => {
  const input = consistent()
  // 0%: shipping off already (Canary): no change. Switched ON by hand: no change either (the writer never turns shipping off).
  assert.deepEqual(plan(input).changes, [])
  input.woo = input.woo.map((w) => (w.id === '3' ? { ...w, shipping: true } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '3' ? mapOf(input.woo.find((w) => w.id === '3')!, 'rCAN') : m))
  assert.deepEqual(plan(input).changes, [])
  // A 0% rate is created with shipping off; a positive one with it on.
  input.rates.push(ims('rZero', { name: 'FR Zero', rate: '0.0000', countryCode: 'FR', taxCategory: 'ZERO' }))
  input.rates.push(ims('rFR', { name: 'FR VAT', rate: '0.2000', countryCode: 'FR' }))
  const p = plan(input)
  const zero = p.changes.find((c) => c.key === 'create:rZero')!
  const fr = p.changes.find((c) => c.key === 'create:rFR')!
  assert.equal(zero.kind === 'CREATE' ? zero.after.shipping : null, false)
  assert.equal(fr.kind === 'CREATE' ? fr.after.shipping : null, true)
  // A rate that becomes positive: shipping off is an UPDATE.
  const raise = consistent()
  raise.rates = raise.rates.map((r) => (r.id === 'rCAN' ? { ...r, rate: '0.0300' } : r))
  const change = only(plan(raise))
  assert.deepEqual(change.kind === 'UPDATE' ? change.fields.map((f) => f.field) : null, ['rate', 'shipping'])
})

test('REGIONAL: the Canary Islands and PT-30 rates are mapped counterparts like any other: created with their region, and left alone when right', () => {
  const input = consistent()
  assert.deepEqual(plan(input).changes, [])
  const fresh = consistent()
  fresh.woo = fresh.woo.filter((w) => w.id !== '3' && w.id !== '4')
  fresh.mappings = fresh.mappings.filter((m) => m.externalTaxRateId !== '3' && m.externalTaxRateId !== '4')
  const p = plan(fresh)
  const can = p.changes.find((c) => c.key === 'create:rCAN')!
  const pt = p.changes.find((c) => c.key === 'create:rPT30')!
  assert.equal(can.kind === 'CREATE' ? can.after.state : null, 'CN')
  assert.equal(can.kind === 'CREATE' ? can.after.class : null, 'zero-rate')
  assert.equal(pt.kind === 'CREATE' ? pt.after.state : null, '30')
  assert.deepEqual(applyToWorld(fresh, p).woo, [])
})

test('NEVER CLEARS: a state the IMS name does not record, and a country the IMS rate has not, are findings and not changes; a postcode or city is a finding', () => {
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, state: 'ENG', postcode: 'SW1*', city: 'London' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(input.woo.find((w) => w.id === '1')!, 'rGB') : m))
  input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, countryCode: null } : r))
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.findings.map((f) => `${f.code}:${f.wooId}`).sort(), ['COUNTRY_NOT_RECORDED:2', 'REGION_NOT_RECORDED:1', 'SCOPE_NOT_RECORDABLE:1'])
  for (const code of Object.keys(WOO_TAX_FINDING_CODES)) assert.ok(code.length > 0)
})

test('an IMS name that may state a region in a form the parser does not read leaves the store state alone and says so', () => {
  const input = consistent()
  input.rates = input.rates.map((r) => (r.id === 'rPT30' ? { ...r, name: 'PT Madeira VAT' } : r))
  input.woo = input.woo.map((w) => (w.id === '4' ? { ...w, name: 'PT Madeira VAT' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '4' ? mapOf(input.woo.find((w) => w.id === '4')!, 'rPT30') : m))
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.findings, [{ code: 'REGION_NAME_UNREADABLE', wooId: '4', imsRateId: 'rPT30' }])
})

test('BLOCKER: an unmapped store rate that already has the identity a CREATE would give is an UNMAPPED_TWIN (adopt it, do not duplicate it)', () => {
  const input = consistent()
  input.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' }))
  input.woo.push(woo('50', { name: 'fr vat', country: 'FR' }))
  const p = plan(input)
  assert.deepEqual(p.blockers, [{ code: 'UNMAPPED_TWIN', imsRateId: 'rFR', wooId: '50' }])
  assert.equal(p.changes.length, 1)
  assert.ok(WOO_TAX_BLOCKER_CODES.UNMAPPED_TWIN.length > 10)
  // A different country is not a twin.
  input.woo = input.woo.map((w) => (w.id === '50' ? { ...w, country: 'BE' } : w))
  assert.deepEqual(plan(input).blockers, [])
})

test('an IMS rate with an unreadable percentage is a finding and is not planned', () => {
  const input = consistent()
  input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, rate: 'abc' } : r))
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.findings, [{ code: 'IMS_PERCENT_UNREADABLE', imsRateId: 'rGB' }])
})

test('DIGEST: stable for equal input, different for any change of the plan, independent of the order the store lists its rates in', () => {
  const build = () => { const i = consistent(); i.woo = i.woo.map((w) => (w.id === '1' ? { ...w, rate: '15.0000' } : w)); i.mappings = i.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(i.woo.find((w) => w.id === '1')!, 'rGB') : m)); return i }
  const a = plan(build())
  assert.match(a.digest, /^[0-9a-f]{64}$/)
  assert.equal(plan(build()).digest, a.digest)
  const reversed = build(); reversed.woo.reverse()
  assert.equal(plan(reversed).digest, a.digest)
  const other = build(); other.woo = other.woo.map((w) => (w.id === '1' ? { ...w, rate: '14.0000' } : w)); other.mappings = other.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(other.woo.find((w) => w.id === '1')!, 'rGB') : m))
  assert.deepEqual(plan(other).changes.map((c) => c.kind), ['UPDATE'], 'PRECONDITION: the other store state is an UPDATE of its own (rate 14 against IMS 20)')
  assert.notEqual(plan(other).digest, a.digest)
  assert.notEqual(plan(consistent()).digest, a.digest)
  // The blockers and the findings are bound too: the same changes with another blocker or finding is another plan.
  const withFinding = build(); withFinding.woo = withFinding.woo.map((w) => (w.id === '4' ? { ...w, postcode: '9000*' } : w))
  assert.deepEqual(plan(withFinding).changes, a.changes)
  assert.notEqual(plan(withFinding).digest, a.digest)
  const blocked = build(); blocked.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' })); const blockedTwin = build(); blockedTwin.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' })); blockedTwin.woo.push(woo('50', { name: 'FR VAT', country: 'FR' }))
  assert.deepEqual(plan(blocked).changes.map((c) => c.key), plan(blockedTwin).changes.map((c) => c.key))
  assert.notEqual(plan(blocked).digest, plan(blockedTwin).digest)
})

test('COUNTRY: the IMS country code is normalised (UK is GB, EL is GR, case and spaces ignored) for a create and for the comparison', () => {
  const input = consistent()
  input.rates.push(ims('rEL', { name: 'EL VAT', rate: '0.2400', countryCode: ' el ' }))
  const create = plan(input).changes.find((c) => c.key === 'create:rEL')!
  assert.equal(create.kind === 'CREATE' ? create.after.country : null, 'GR')
  input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, countryCode: 'uk' } : r))
  assert.deepEqual(plan(input).changes.map((c) => c.key), ['create:rEL'], 'a store rate for GB is the counterpart of an IMS rate whose code is UK')
})

test('IDEMPOTENT: applied to the store, a plan leaves a world whose own plan is empty (a re-run has nothing to do), whatever the mix of changes', () => {
  const input = consistent()
  input.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' }))
  input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r))
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: '15.0000', shipping: false } : w.id === '4' ? { ...w, state: '' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' || m.externalTaxRateId === '4' ? mapOf(input.woo.find((w) => w.id === m.externalTaxRateId)!, m.taxRateId) : m))
  const first = plan(input)
  assert.deepEqual(first.changes.map((c) => c.kind).sort(), ['CREATE', 'DELETE', 'UPDATE', 'UPDATE'])
  const { world, woo: problems } = applyToWorld(input, first)
  assert.deepEqual(problems, [])
  const second = plan(world)
  assert.deepEqual(second.changes, [])
  assert.deepEqual(second.blockers, [])
})

test('the percent is compared as a number, not as text: "20", "20.00" and "20.0000" are the same rate', () => {
  for (const text of ['20', '20.0', '20.00', '020.0000']) {
    const input = consistent()
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: text } : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, externalRatePct: '20.0000' } : m))
    assert.deepEqual(plan(input).changes, [], text)
  }
})

test('DIGEST: the same plan whatever order the store lists its rates in, with several deletes, updates and a create in it', () => {
  const build = () => {
    const input = consistent()
    input.rates = input.rates.map((r) => (r.id === 'rDE' || r.id === 'rPT30' ? { ...r, active: false } : r))
    input.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' }))
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: '15.0000' } : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? mapOf(input.woo.find((w) => w.id === '1')!, 'rGB') : m))
    return input
  }
  const forward = plan(build())
  assert.deepEqual(forward.changes.map((c) => c.kind), ['DELETE', 'DELETE', 'UPDATE', 'CREATE'])
  const reversed = build(); reversed.woo.reverse(); reversed.mappings.reverse(); reversed.rates.reverse()
  assert.equal(plan(reversed).digest, forward.digest)
  assert.deepEqual(plan(reversed).changes, forward.changes)
})

test('BLOCKER: a rate this writer created, since unmapped, that looks like the rate a CREATE would add is a twin too (never a second copy)', () => {
  const input: Input = consistent()
  input.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' }))
  input.woo.push(woo('60', { name: 'FR VAT', country: 'FR' }))
  input.recorded = ['60']
  const p = plan(input)
  assert.deepEqual(p.blockers, [{ code: 'UNMAPPED_TWIN', imsRateId: 'rFR', wooId: '60' }])
  assert.deepEqual(p.findings, [{ code: 'OWNED_BUT_UNMAPPED', wooId: '60' }])
})

test('OWNERSHIP BY RECORD: only APPLIED creates and updates own a store rate; a delete, a failure, an adoption and a record of another store do not', () => {
  const rows = [
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '10' },
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '11' },
    { kind: 'DELETE', status: 'APPLIED', wooTaxRateId: '11' },
    { kind: 'UPDATE', status: 'FAILED', wooTaxRateId: '12' },
    { kind: 'CREATE', status: 'FAILED', wooTaxRateId: null },
    { kind: 'ADOPT', status: 'APPLIED', wooTaxRateId: '13' },
    { kind: 'UPDATE', status: 'APPLIED', wooTaxRateId: '14' },
    { kind: 'DELETE', status: 'FAILED', wooTaxRateId: '14' },
  ]
  assert.deepEqual([...ownedWooIdsFromRecords(rows.map((r) => ({ ...r, storeIdentity: STORE })), STORE)].sort(), ['10', '14'])
  // In order: a delete before a create of the same id leaves it owned; after, not.
  assert.deepEqual([...ownedWooIdsFromRecords([{ kind: 'DELETE', status: 'APPLIED', wooTaxRateId: '5', storeIdentity: STORE }, { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '5', storeIdentity: STORE }], STORE)], ['5'])
  assert.deepEqual([...ownedWooIdsFromRecords([], STORE)], [])
})

// ───────────────────────────── store identity and rate identity ─────────────────────────────

test('STORE IDENTITY: the normal form is scheme, host and path, with nothing else, and a non-http URL has none', () => {
  assert.equal(normaliseStoreIdentity('https://Shop.Example.com/'), 'https://shop.example.com')
  assert.equal(normaliseStoreIdentity(' https://shop.example.com:443/ '), 'https://shop.example.com')
  assert.equal(normaliseStoreIdentity('https://shop.example.com/store/?a=1#x'), 'https://shop.example.com/store')
  assert.equal(normaliseStoreIdentity('https://shop.example.com:8443'), 'https://shop.example.com:8443')
  assert.equal(normaliseStoreIdentity('http://shop.example.com'), 'http://shop.example.com')
  assert.notEqual(normaliseStoreIdentity('https://a.example'), normaliseStoreIdentity('https://b.example'))
  for (const bad of ['', 'ftp://x.example', 'not a url', 'javascript:alert(1)']) assert.equal(normaliseStoreIdentity(bad), null, bad)
})

test('STORE URL CHANGE: mappings stamped for another store, or not stamped at all, are not owned: findings only, no change of any kind, even where the ids overlap', () => {
  for (const identity of [OTHER_STORE, null]) {
    const input = consistent()
    input.mappings = input.mappings.map((m) => ({ ...m, storeIdentity: identity }))
    input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r)) // would be a DELETE if owned
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: '15.0000' } : w)) // would be an UPDATE if owned
    const p = plan(input)
    assert.deepEqual(p.changes, [], String(identity))
    assert.deepEqual(p.findings.map((f) => `${f.code}:${f.wooId}`), ['MAPPING_NOT_ADOPTED:1', 'MAPPING_NOT_ADOPTED:2', 'MAPPING_NOT_ADOPTED:3', 'MAPPING_NOT_ADOPTED:4'])
    assert.equal(p.unownedLeftAlone, 4, 'none of them is owned')
  }
})

test('STORE URL CHANGE: the digest is bound to the store, and an IMS rate whose mapping names a present rate of another store gets no CREATE', () => {
  const input = consistent()
  const a = plan(input).digest
  const moved = consistent()
  moved.mappings = moved.mappings.map((m) => ({ ...m, storeIdentity: OTHER_STORE }))
  const p = plan(moved)
  assert.equal(p.changes.some((c) => c.kind === 'CREATE'), false, 'no duplicate of a rate that may be the counterpart')
  assert.notEqual(p.digest, a)
  const ownedElsewhere = planWooTaxRates({ woo: input.woo, rates: input.rates, mappings: input.mappings, componentRates: [], recordedOwnedWooIds: new Set(), storeIdentity: OTHER_STORE })
  assert.notEqual(ownedElsewhere.digest, plan(input).digest)
})

test('RATE IDENTITY: a store rate whose id was reused or replaced (any of name, country, percent, class differs from the snapshot) is RE_ADOPTION_REQUIRED: never updated, deleted or duplicated', () => {
  const replacements: Array<[string, Partial<WooTaxRateDetail>]> = [
    ['name', { name: 'Something else' }], ['country', { country: 'IE' }], ['percent', { rate: '99.0000' }], ['class', { class: 'reduced-rate' }],
  ]
  for (const [label, over] of replacements) {
    const input = consistent()
    input.woo = input.woo.map((w) => (w.id === '2' ? { ...w, ...over } : w)) // the snapshot (mapping) is NOT realigned
    const p = plan(input)
    assert.deepEqual(p.changes, [], label)
    assert.deepEqual(p.findings, [{ code: 'RE_ADOPTION_REQUIRED', wooId: '2', imsRateId: 'rDE' }], label)
    // Even when IMS wants it gone, a replaced rate is not deleted.
    input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r))
    assert.deepEqual(plan(input).changes, [], `${label}: out of scope`)
  }
  // A duplicate counterpart that no longer matches its snapshot is not deleted either, and the matching one is still the keeper.
  const input = consistent()
  const twin = woo('5', { name: 'Unrelated', rate: '3.0000' })
  input.woo.push(twin)
  input.mappings.push(mapOf({ ...twin, name: 'GB VAT', rate: '20.0000' }, 'rGB'))
  const p = plan(input)
  assert.deepEqual(p.changes, [])
  assert.deepEqual(p.findings, [{ code: 'RE_ADOPTION_REQUIRED', wooId: '5', imsRateId: 'rGB' }])
})

test('RATE IDENTITY: the four identity fields are compared as R13 compares them (name case and spacing, country alias, exact percent, empty class is standard)', () => {
  const snap = { name: 'GB VAT', country: 'GB', rate: '20.0000', class: 'standard' }
  assert.equal(sameRateIdentity(snap, { name: '  gb   vat', country: 'uk', rate: '20', class: '' }), true)
  for (const over of [{ name: 'GB V' }, { country: 'IE' }, { rate: '20.0001' }, { rate: 'x' }, { class: 'zero-rate' }]) assert.equal(sameRateIdentity(snap, { ...snap, ...over }), false, JSON.stringify(over))
  const w = woo('9', { class: '' })
  assert.deepEqual(identityOfWoo(w), { name: 'GB VAT', country: 'GB', rate: '20.0000', class: '' })
  assert.deepEqual(identityOfMapping(mapOf(woo('9'), 'rGB', { externalCountry: null, externalClass: null })), { name: 'GB VAT', country: '', rate: '20.0000', class: '' })
})

test('RATE IDENTITY: state, compound and shipping are not identity: a store rate that differs only there is still the rate IMS owns and is corrected', () => {
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '4' ? { ...w, state: '', compound: true, shipping: false } : w))
  const p = plan(input)
  assert.deepEqual(p.findings, [])
  const change = only(p)
  assert.deepEqual(change.kind === 'UPDATE' ? change.fields.map((f) => f.field) : null, ['state', 'compound', 'shipping'])
})

test('ADOPTION PLAN: unstamped, other-store and drifted rows are candidates with snapshot and live side by side; rows whose rate is absent and rows already right are not', () => {
  const input = consistent()
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, storeIdentity: null } : m.externalTaxRateId === '2' ? { ...m, storeIdentity: OTHER_STORE } : m))
  input.woo = input.woo.map((w) => (w.id === '3' ? { ...w, rate: '1.0000' } : w))
  input.woo = input.woo.filter((w) => w.id !== '4')
  const a = planAdoption({ woo: input.woo, rates: input.rates, mappings: input.mappings, storeIdentity: STORE })
  assert.deepEqual(a.rows.map((r) => `${r.wooId}:${r.reason}`), ['1:UNSTAMPED', '2:OTHER_STORE', '3:SNAPSHOT_DIFFERS'])
  assert.equal(a.rows[2]!.snapshot.rate, '0.0000')
  assert.equal(a.rows[2]!.live.rate, '1.0000')
  assert.equal(a.rows[0]!.imsRateName, 'GB VAT')
  assert.match(a.digest, /^[0-9a-f]{64}$/)
  assert.equal(planAdoption({ woo: [...input.woo].reverse(), rates: input.rates, mappings: [...input.mappings].reverse(), storeIdentity: STORE }).digest, a.digest)
  assert.notEqual(planAdoption({ woo: input.woo, rates: input.rates, mappings: input.mappings, storeIdentity: OTHER_STORE }).digest, a.digest)
  assert.deepEqual(planAdoption({ ...consistent(), storeIdentity: STORE }).rows, [])
  assert.equal(Object.keys(ADOPTION_REASONS).length, 3)
})

test('OWNERSHIP BY RECORD: a record made against another store (or with no store) owns nothing', () => {
  const rows = [
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '1', storeIdentity: OTHER_STORE },
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '2', storeIdentity: null },
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '3' },
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '4', storeIdentity: STORE },
  ]
  assert.deepEqual([...ownedWooIdsFromRecords(rows, STORE)], ['4'])
})

test('STORE IDENTITY: the digest names the store: the same (here empty) plan against another store is another plan', () => {
  const empty = (storeIdentity: string) => planWooTaxRates({ woo: [], rates: [], mappings: [], componentRates: [], recordedOwnedWooIds: new Set(), storeIdentity })
  assert.equal(empty(STORE).digest, empty(STORE).digest)
  assert.notEqual(empty(STORE).digest, empty(OTHER_STORE).digest)
})


// ---------------------------------------------------------------------------
// The check made immediately before each send
// ---------------------------------------------------------------------------

/** The input the writer hands the check: the world as the plan saw it, with the live rate of the change, then edited by the case. */
function recheck(input: Input, changeKey: string, edit: (w: { rates: Input['rates']; mappings: WooTaxMappingRow[]; live: WooTaxRateDetail | undefined }) => void = () => undefined): string | null {
  const change = plan(input).changes.find((c) => c.key === changeKey)
  assert.ok(change, `PRECONDITION: the plan has ${changeKey}`)
  const w = { rates: input.rates.map((r) => ({ ...r })), mappings: input.mappings.map((m) => ({ ...m })), live: 'wooId' in change ? input.woo.find((x) => x.id === change.wooId) : undefined }
  edit(w)
  return revalidateWooTaxChange({ change, storeIdentity: STORE, rate: w.rates.find((r) => r.id === change.imsRateId), componentRates: [], mappings: w.mappings, live: w.live })
}
const deleteWorld = (): Input => { const i = consistent(); i.rates = i.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r)); return i }
const updateWorld = (): Input => { const i = consistent(); i.woo = i.woo.map((x) => (x.id === '2' ? { ...x, rate: '18.0000' } : x)); i.mappings = i.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, externalRatePct: '18.0000' } : m)); return i }
const createWorld = (): Input => { const i = consistent(); i.rates = [...i.rates, ims('rFR', { name: 'FR VAT', countryCode: 'FR' })]; return i }

test('RECHECK: a change whose world is unchanged passes, for each kind', () => {
  assert.equal(recheck(deleteWorld(), 'delete:2'), null)
  assert.equal(recheck(updateWorld(), 'update:2'), null)
  assert.equal(recheck(createWorld(), 'create:rFR'), null)
})

test('RECHECK DELETE/UPDATE: every way the ownership can move is named and refuses the send', () => {
  for (const [key, world] of [['delete:2', deleteWorld], ['update:2', updateWorld]] as const) {
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.filter((m) => m.externalTaxRateId !== '2') }), 'MAPPING_GONE', key)
    // repointed to another ACTIVE IMS rate: the case where a planned DELETE would remove a rate IMS now uses
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, taxRateId: 'rGB' } : m)) }), 'MAPPING_REPOINTED', key)
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, storeIdentity: null } : m)) }), 'STAMP_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, storeIdentity: OTHER_STORE } : m)) }), 'STAMP_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, externalName: 'Another rate' } : m)) }), 'SNAPSHOT_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '2' ? { ...m, externalClass: 'reduced-rate' } : m)) }), 'SNAPSHOT_CHANGED', key)
    // the live rate read again is not the rate the plan saw
    assert.equal(recheck(world(), key, (w) => { w.live = { ...w.live!, rate: '25.0000' } }), 'LIVE_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.live = { ...w.live!, shipping: !w.live!.shipping } }), 'LIVE_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.live = undefined }), 'LIVE_CHANGED', key)
    assert.equal(recheck(world(), key, (w) => { w.rates = w.rates.filter((r) => r.id !== 'rDE') }), 'IMS_RATE_CHANGED', key)
  }
})

test('RECHECK DELETE: the IMS rate must still be out of scope for the same reason (reactivated, or a different reason, refuses); an UPDATE needs the rate in scope with the same desired state', () => {
  assert.equal(recheck(deleteWorld(), 'delete:2', (w) => { w.rates = w.rates.map((r) => (r.id === 'rDE' ? { ...r, active: true } : r)) }), 'IMS_RATE_CHANGED')
  const reverse = deleteWorld(); reverse.rates = reverse.rates.map((r) => (r.id === 'rDE' ? { ...r, active: true, reverseCharge: true } : r))
  assert.equal(recheck(reverse, 'delete:2'), null)
  assert.equal(recheck(reverse, 'delete:2', (w) => { w.rates = w.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r)) }), 'IMS_RATE_CHANGED', 'a different reason is a different plan')
  assert.equal(recheck(updateWorld(), 'update:2', (w) => { w.rates = w.rates.map((r) => (r.id === 'rDE' ? { ...r, active: false } : r)) }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(updateWorld(), 'update:2', (w) => { w.rates = w.rates.map((r) => (r.id === 'rDE' ? { ...r, rate: '0.2100' } : r)) }), 'IMS_RATE_CHANGED')
})

test('RECHECK DELETE of a duplicate counterpart needs the other counterpart still stamped for this store', () => {
  const input = consistent()
  const extra = woo('9', { name: 'GB VAT', rate: '21.0000' })
  input.woo = [...input.woo, extra]
  input.mappings = [...input.mappings, mapOf(extra, 'rGB')]
  assert.equal(recheck(input, 'delete:9'), null)
  assert.equal(recheck(input, 'delete:9', (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, storeIdentity: null } : m)) }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(input, 'delete:9', (w) => { w.mappings = w.mappings.filter((m) => m.externalTaxRateId !== '1') }), 'IMS_RATE_CHANGED')
})

test('RECHECK DELETE for an out-of-scope reason: the IMS rate back in scope refuses it even where another stamped counterpart exists', () => {
  const input = deleteWorld()
  const extra = woo('9', { name: 'DE VAT', country: 'DE', rate: '19.0000' })
  input.woo = [...input.woo, extra]
  input.mappings = [...input.mappings, mapOf(extra, 'rDE')]
  assert.equal(recheck(input, 'delete:2'), null)
  assert.equal(recheck(input, 'delete:2', (w) => { w.rates = w.rates.map((r) => (r.id === 'rDE' ? { ...r, active: true } : r)) }), 'IMS_RATE_CHANGED')
})

test('RECHECK CREATE with a stale mapping row already known to the plan: a second mapping that appears is still a refusal', () => {
  const input = createWorld()
  input.mappings = [...input.mappings, { externalTaxRateId: '50', taxRateId: 'rFR', externalName: 'FR VAT', externalCountry: 'FR', externalRatePct: '20.0000', externalClass: 'standard', storeIdentity: STORE }]
  assert.deepEqual((plan(input).changes.find((c) => c.key === 'create:rFR') as { staleWooIds: string[] }).staleWooIds, ['50'], 'PRECONDITION: the plan knows the stale row')
  assert.equal(recheck(input, 'create:rFR'), null)
  assert.equal(recheck(input, 'create:rFR', (w) => { w.mappings = [...w.mappings, { externalTaxRateId: '60', taxRateId: 'rFR', externalName: 'FR VAT', externalCountry: 'FR', externalRatePct: '20.0000', externalClass: 'standard', storeIdentity: null }] }), 'MAPPING_APPEARED')
  assert.equal(recheck(input, 'create:rFR', (w) => { w.mappings = w.mappings.map((m) => (m.externalTaxRateId === '50' ? { ...m, externalTaxRateId: '4' } : m)) }), 'MAPPING_APPEARED', 'a different row is a different set')
})

test('RECHECK CREATE: the IMS rate must still be in scope with the same desired rate, and no mapping may have appeared for it', () => {
  assert.equal(recheck(createWorld(), 'create:rFR', (w) => { w.rates = w.rates.map((r) => (r.id === 'rFR' ? { ...r, active: false } : r)) }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(createWorld(), 'create:rFR', (w) => { w.rates = w.rates.map((r) => (r.id === 'rFR' ? { ...r, usedFor: 'PURCHASE' } : r)) }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(createWorld(), 'create:rFR', (w) => { w.rates = w.rates.map((r) => (r.id === 'rFR' ? { ...r, rate: '0.2500' } : r)) }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(createWorld(), 'create:rFR', (w) => { w.rates = w.rates.filter((r) => r.id !== 'rFR') }), 'IMS_RATE_CHANGED')
  assert.equal(recheck(createWorld(), 'create:rFR', (w) => { w.mappings = [...w.mappings, { externalTaxRateId: '77', taxRateId: 'rFR', externalName: 'FR VAT', externalCountry: 'FR', externalRatePct: '20.0000', externalClass: 'standard', storeIdentity: null }] }), 'MAPPING_APPEARED')
})
