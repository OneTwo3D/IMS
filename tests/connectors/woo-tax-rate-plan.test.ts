import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DELETE_REASONS, WOO_TAX_BLOCKER_CODES, WOO_TAX_FINDING_CODES, ownedWooIdsFromRecords, planWooTaxRates,
  type WooTaxChange, type WooTaxMappingRow, type WooTaxPlan, type WooTaxPlanInput,
} from '../../lib/connectors/woocommerce/tax-rate-plan.ts'
import { compareVatSetIdentity } from '../../lib/reconciliation-pack/vat-set-identity.ts'
import type { WooTaxRateDetail } from '../../lib/reconciliation-pack/woo-source.ts'
import { consistent, ims, mapOf, woo } from '../helpers/woo-tax-fakes.ts'

/**
 * THE WOOCOMMERCE TAX-RATE PLAN, pure. One arm per change kind and per field, the ownership rule, the shipping rule, regional rates, and the property the plan exists for: applied to
 * the store, R13's WooCommerce side holds. [mutation: each rule below has a red mutation in /scratch/wootax/mut.py, listed in the PR]
 */

type Input = { woo: WooTaxRateDetail[]; rates: ReturnType<typeof consistent>['rates']; mappings: WooTaxMappingRow[]; recorded?: string[] }
const plan = (input: Input): WooTaxPlan =>
  planWooTaxRates({ woo: input.woo, rates: input.rates, mappings: input.mappings, componentRates: [], recordedOwnedWooIds: new Set(input.recorded ?? []) } satisfies WooTaxPlanInput)
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
    } else {
      const w = wooRates.find((x) => x.id === change.wooId)!
      mappings = mappings.map((m) => (m.externalTaxRateId === change.wooId ? mapOf(w, m.taxRateId) : m))
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
    woo: input.woo, rates: input.rates, mappings: input.mappings, recordedOwnedWooIds: new Set(),
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

test('REFRESH_MAPPING: the store already matches but the stored mapping row is stale (class, name, country or percent): bookkeeping only', () => {
  for (const over of [{ externalClass: 'zero-rate' }, { externalName: 'Old name' }, { externalCountry: 'IE' }, { externalRatePct: '15.0000' }]) {
    const input = consistent()
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, ...over } : m))
    const change = only(plan(input))
    assert.equal(change.kind, 'REFRESH_MAPPING')
    assert.equal(change.kind === 'REFRESH_MAPPING' ? change.wooId : null, '1')
  }
  // An empty class and "standard" are the same class (R13): not stale.
  const input = consistent()
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, externalClass: null } : m))
  assert.deepEqual(plan(input).changes, [])
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
  const other = build(); other.woo = other.woo.map((w) => (w.id === '1' ? { ...w, rate: '14.0000' } : w))
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

test('OWNERSHIP BY RECORD: only APPLIED creates and updates own a store rate; a delete, a failure and a mapping refresh do not', () => {
  const rows = [
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '10' },
    { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '11' },
    { kind: 'DELETE', status: 'APPLIED', wooTaxRateId: '11' },
    { kind: 'UPDATE', status: 'FAILED', wooTaxRateId: '12' },
    { kind: 'CREATE', status: 'FAILED', wooTaxRateId: null },
    { kind: 'REFRESH_MAPPING', status: 'APPLIED', wooTaxRateId: '13' },
    { kind: 'UPDATE', status: 'APPLIED', wooTaxRateId: '14' },
    { kind: 'DELETE', status: 'FAILED', wooTaxRateId: '14' },
  ]
  assert.deepEqual([...ownedWooIdsFromRecords(rows)].sort(), ['10', '14'])
  // In order: a delete before a create of the same id leaves it owned; after, not.
  assert.deepEqual([...ownedWooIdsFromRecords([{ kind: 'DELETE', status: 'APPLIED', wooTaxRateId: '5' }, { kind: 'CREATE', status: 'APPLIED', wooTaxRateId: '5' }])], ['5'])
  assert.deepEqual([...ownedWooIdsFromRecords([])], [])
})
