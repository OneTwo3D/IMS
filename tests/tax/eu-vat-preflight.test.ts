import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateEuVatPreflight, planEuVatSeedApply, PREFLIGHT_CODES, type PreflightCode, type PreflightInput } from '@/lib/tax/eu-vat-preflight'
import { STORE, perfectWorld, syntheticChargedCode, withWorld, xeroType, type World } from './eu-vat-fixtures'

const codesOf = (input: PreflightInput): string[] => {
  const result = evaluateEuVatPreflight(input)
  assert.equal(result.status, 'checked')
  return result.status === 'checked' ? [...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.code))].sort() : []
}
let caseNo = 0
const expectError = (mutate: (w: World) => void, ...codes: PreflightCode[]): void => { caseNo += 1; // A country's only scheme rate being broken also uncovers the country (tested on its own below), so that code is compared only where a case names it.
  const actual = codesOf(withWorld(mutate)).filter((c) => c !== 'COUNTRY_NOT_COVERED' || codes.includes('COUNTRY_NOT_COVERED'))
  assert.deepEqual(actual, [...codes].sort(), `case ${caseNo}: ${mutate.toString().slice(0, 150)}`) }
const setIms = (w: World, wooId: number, patch: Record<string, unknown>): void => { w.ims.set(wooId, { ...w.ims.get(wooId)!, ...patch }) }

test('an unproven stored Xero list refuses: nothing is judged', () => {
  const result = evaluateEuVatPreflight({ ...perfectWorld().input, xero: { proven: false, reason: 'XERO_LIST_STALE: old' } })
  assert.deepEqual(result, { status: 'refused', seedVersion: '2026-11-09.1', reason: 'XERO_LIST_STALE: old' })
})

test('every finding code has a description, and a seeded failure for each check reports exactly that code', () => {
  assert.deepEqual(codesOf(perfectWorld().input), [])
  expectError((w) => { w.mappings.delete(220) }, 'WOO_UNMAPPED', 'COUNTRY_NOT_COVERED', 'SCHEME_FIELD_ON_UNDECLARED_RATE')
  expectError((w) => { w.mappings.set(220, { ...w.mappings.get(220)!, externalRatePct: '21.0000' }) }, 'MAPPING_DIFFERS', 'COUNTRY_NOT_COVERED')
  expectError((w) => { w.mappings.set(220, { ...w.mappings.get(220)!, taxRateId: 'gone' }) }, 'IMS_RATE_MISSING', 'COUNTRY_NOT_COVERED', 'SCHEME_FIELD_ON_UNDECLARED_RATE')
  expectError((w) => { setIms(w, 112, { active: false }) }, 'IMS_RATE_INACTIVE')
  expectError((w) => { setIms(w, 112, { usedFor: 'PURCHASE' }) }, 'IMS_RATE_NOT_SALES')
  expectError((w) => { setIms(w, 112, { reverseCharge: true }) }, 'IMS_RATE_NOT_SALES')
  expectError((w) => { setIms(w, 220, { rate: '0.2100' }) }, 'IMS_PERCENT_DIFFERS')
  expectError((w) => { setIms(w, 220, { countryCode: 'AT' }) }, 'IMS_COUNTRY_DIFFERS')
  expectError((w) => { setIms(w, 220, { accountingTaxType: null }) }, 'CHARGED_TYPE_MISSING')
  expectError((w) => { setIms(w, 220, { accountingTaxType: 'NONE' }) }, 'CHARGED_TYPE_DIFFERS', 'CHARGED_TYPE_NONE')
  expectError((w) => { setIms(w, 220, { accountingTaxType: 'TAX001' }) }, 'CHARGED_TYPE_NOT_IN_XERO', 'CHARGED_TYPE_DIFFERS')
  expectError((w) => { w.xero.set(syntheticChargedCode(220), xeroType(syntheticChargedCode(220), 'DE VAT', '19.0000', 'ARCHIVED')) }, 'CHARGED_TYPE_NOT_IN_XERO', 'CHARGED_NAME_NOT_IN_XERO')
  expectError((w) => { w.xero.delete(syntheticChargedCode(220)); w.xero.set('TAXZ', xeroType('TAXZ', 'DE VAT', '19.0000')) }, 'CHARGED_TYPE_NOT_IN_XERO', 'CHARGED_TYPE_DIFFERS')
  expectError((w) => { setIms(w, 239, { accountingTaxType: 'TAX999' }) }, 'CHARGED_TYPE_NOT_IN_XERO', 'CHARGED_TYPE_DIFFERS')
  expectError((w) => { w.xero.set(syntheticChargedCode(220), xeroType(syntheticChargedCode(220), 'DE VAT', '19.0000')); w.xero.set('TAXDUP', xeroType('TAXDUP', 'DE VAT', '19.0000')) }, 'CHARGED_NAME_AMBIGUOUS')
  expectError((w) => { w.xero.set(syntheticChargedCode(220), xeroType(syntheticChargedCode(220), 'DE VAT (old)', '19.0000')) }, 'CHARGED_NAME_DIFFERS', 'CHARGED_NAME_NOT_IN_XERO')
  expectError((w) => { w.xero.set(syntheticChargedCode(220), xeroType(syntheticChargedCode(220), 'DE VAT', '20.0000')) }, 'CHARGED_PERCENT_DIFFERS')
  expectError((w) => { setIms(w, 220, { schemePostingTaxType: null }) }, 'SCHEME_FIELDS_DIFFER')
  expectError((w) => { setIms(w, 220, { reportingCategory: null }) }, 'SCHEME_FIELDS_DIFFER')
  expectError((w) => { setIms(w, 112, { reportingCategory: 'IOSS' }) }, 'SCHEME_FIELDS_DIFFER')
  expectError((w) => { setIms(w, 220, { accountingTaxType: 'TAX131' }) }, 'SCHEME_ON_CHARGED_CODE', 'CHARGED_NAME_DIFFERS', 'CHARGED_PERCENT_DIFFERS', 'CHARGED_TYPE_DIFFERS')
  expectError((w) => { w.xero.delete('TAX131') }, 'SCHEME_TYPE_NOT_IN_XERO')
  expectError((w) => { w.xero.set('TAX131', xeroType('TAX131', 'DE IOSS VAT', '0.0000', 'ARCHIVED')) }, 'SCHEME_TYPE_NOT_IN_XERO')
  expectError((w) => { w.xero.set('TAX131', xeroType('TAX131', 'DE IOSS  VAT', '0.0000')) }, 'SCHEME_NAME_DIFFERS')
  expectError((w) => { w.xero.set('TAX131', xeroType('TAX131', 'DE IOSS VAT', '19.0000')) }, 'SCHEME_NOT_ZERO')
  expectError((w) => { w.xero.set('TAX131', { ...xeroType('TAX131', 'DE IOSS VAT', '0.0000'), effectiveRate: null, displayTaxRate: null }) }, 'SCHEME_NOT_ZERO')
  expectError((w) => { w.ims.set(9999, { id: 'ims-x', name: 'Stray', rate: '0.2000', usedFor: 'SALES', active: true, reverseCharge: false, countryCode: 'DE', accountingTaxType: null, reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' }) }, 'SCHEME_FIELD_ON_UNDECLARED_RATE')
  assert.ok(Object.keys(PREFLIGHT_CODES).length >= 30)
})

test('WooCommerce rates declared to be one Xero rate share one IMS rate without a finding; a rate declared as a different Xero rate on it is a SHARED_IMS_ROW error', () => {
  assert.deepEqual(codesOf(perfectWorld().input), [])
  const stranger = codesOf(withWorld((w) => { w.mappings.set(220, { ...w.mappings.get(220)!, taxRateId: 'ims-139' }) }))
  assert.ok(stranger.includes('SHARED_IMS_ROW'))
  const second = codesOf(withWorld((w) => { w.ims.set(9998, { ...w.ims.get(150)!, id: 'ims-other', name: 'Another zero rate' }); w.mappings.set(150, { ...w.mappings.get(150)!, taxRateId: 'ims-other' }) }))
  assert.ok(second.includes('XERO_TYPE_ON_TWO_IMS_RATES'), 'two IMS rates on one Xero type are refused')
  assert.ok(second.includes('SHARED_IMS_ROW') === false)
})

test('"No VAT" and "NO VAT" stay distinct: Norway\'s charged type must be the one named exactly "NO VAT", never NONE', () => {
  expectError((w) => { w.xero.set('TAX124', xeroType('TAX124', 'No VAT', '25.0000')) }, 'CHARGED_NAME_DIFFERS', 'COUNTRY_NOT_COVERED')
  expectError((w) => { setIms(w, 239, { accountingTaxType: 'NONE' }) }, 'CHARGED_TYPE_NONE', 'COUNTRY_NOT_COVERED')
})

test('a country with no complete scheme rate is reported, for each EU-27 state, Monaco and Norway', () => {
  const input = withWorld((w) => { setIms(w, 236, { active: false }); setIms(w, 239, { active: false }) })
  const result = evaluateEuVatPreflight(input)
  assert.equal(result.status, 'checked')
  if (result.status !== 'checked') return
  assert.deepEqual(result.findings.filter((f) => f.code === 'COUNTRY_NOT_COVERED').map((f) => f.subject).sort(), ['MC', 'NO'])
})

test('Portugal needs only one complete rate of the two, but both are judged', () => {
  expectError((w) => { setIms(w, 241, { active: false }) }, 'IMS_RATE_INACTIVE')
})

test('accounts: missing from the chart, wrong name, blank or different setting, an uncached chart, an invalid hold setting', () => {
  const base = perfectWorld().input
  const run = (patch: Partial<PreflightInput>): string[] => codesOf({ ...base, ...patch })
  assert.deepEqual(run({ accounts: base.accounts.filter((a) => a.code !== '821') }), ['ACCOUNT_NOT_IN_CHART'])
  assert.deepEqual(run({ accounts: base.accounts.map((a) => (a.code === '821' ? { ...a, name: 'Other' } : a)) }), ['ACCOUNT_NAME_DIFFERS'])
  assert.deepEqual(run({ accounts: [] }), ['CHART_NOT_CACHED'])
  assert.deepEqual(run({ settings: { ...base.settings, xero_eu_vat_ioss_account: '' } }), ['ACCOUNT_SETTING_NOT_SET'])
  assert.deepEqual(run({ settings: { ...base.settings, xero_eu_vat_ioss_account: '820' } }), ['ACCOUNT_SETTING_DIFFERS'])
  assert.deepEqual(run({ settings: { ...base.settings, xero_rounding_difference_account: '821' } }), ['ACCOUNT_SETTING_DIFFERS'], 'rounding posts to 860, not 821 (ruling Q7)')
  assert.deepEqual(run({ settings: { ...base.settings, eu_vat_refund182_hold_threshold: 'ten' } }), ['HOLD_SETTING_INVALID'])
  assert.deepEqual(run({ settings: { ...base.settings, eu_vat_refund182_held_count: '-1' } }), ['HOLD_SETTING_INVALID'])
  assert.deepEqual(run({ settings: { ...base.settings, eu_vat_refund182_hold_threshold: '10', eu_vat_refund182_held_count: '0' } }), [])
})

test('an IMS name that differs is an advisory, not an error', () => {
  const result = evaluateEuVatPreflight(withWorld((w) => { setIms(w, 220, { name: 'Germany VAT' }) }))
  assert.equal(result.status, 'checked')
  if (result.status !== 'checked') return
  assert.equal(result.ready, true)
  assert.ok(result.findings.some((f) => f.code === 'IMS_NAME_DIFFERS' && f.severity === 'advisory'))
})

// ---- the apply plan ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The world as a freshly imported store is: scheme fields not set yet. */
const unseeded = (): PreflightInput => withWorld((w) => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) })

test('the plan sets the scheme fields on exactly the 30 scheme rates, through the mappings, and touches nothing else', () => {
  const plan = planEuVatSeedApply(unseeded())
  assert.equal(plan.changes.length, 30)
  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.unchanged, 35)
  assert.equal(plan.changes.filter((c) => c.to.reportingCategory === 'IOSS').length, 29)
  assert.deepEqual(plan.changes.filter((c) => c.to.reportingCategory === 'VOEC').map((c) => c.to.schemePostingTaxType), ['TAX122'])
  for (const c of plan.changes) assert.deepEqual(c.from, { schemePostingTaxType: null, reportingCategory: null })
  assert.match(plan.digest, /^[0-9a-f]{64}$/)
})

test('the plan is a dry run that is stable: the same state gives the same digest, and a different state a different one', () => {
  assert.equal(planEuVatSeedApply(unseeded()).digest, planEuVatSeedApply(unseeded()).digest)
  const other = planEuVatSeedApply(withWorld((w) => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }); setIms(w, 220, { reportingCategory: 'OSS' }) }))
  assert.notEqual(other.digest, planEuVatSeedApply(unseeded()).digest)
})

test('an already seeded world has nothing to apply', () => {
  const plan = planEuVatSeedApply(perfectWorld().input)
  assert.equal(plan.changes.length, 0)
  assert.equal(plan.unchanged, 65)
})

test('rates that cannot be touched are skipped with the preflight\'s reason, and the apply never writes through a mapping made against another store', () => {
  const plan = planEuVatSeedApply(withWorld((w) => {
    for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null })
    w.mappings.delete(215)
    w.mappings.set(216, { ...w.mappings.get(216)!, externalCountry: 'FR' })
    setIms(w, 217, { active: false })
    setIms(w, 218, { usedFor: 'PURCHASE' })
    w.mappings.set(220, { ...w.mappings.get(220)!, taxRateId: 'ims-139' })
    w.mappings.set(219, { ...w.mappings.get(219)!, taxRateId: 'nowhere' })
  }))
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.wooId, s.reason]))
  assert.deepEqual([215, 216, 217, 218, 219, 220].map((id) => reasons[id]), ['WOO_UNMAPPED', 'MAPPING_DIFFERS', 'IMS_RATE_INACTIVE', 'IMS_RATE_NOT_SALES', 'IMS_RATE_MISSING', 'SHARED_IMS_ROW'])
  assert.equal(plan.changes.some((c) => [215, 216, 217, 218, 219, 220].includes(c.wooId)), false)
})

test('a foreign, unstamped or unidentifiable store never enters the plan or passes the preflight, and the store is bound into the digest', () => {
  const clear = (w: World): void => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }
  const base = planEuVatSeedApply(withWorld(clear))
  const foreign = withWorld((w) => { clear(w); w.mappings.set(220, { ...w.mappings.get(220)!, storeIdentity: 'https://other.example' }) })
  const unstamped = withWorld((w) => { clear(w); w.mappings.set(220, { ...w.mappings.get(220)!, storeIdentity: null }) })
  assert.deepEqual(planEuVatSeedApply(foreign).skipped.map((s) => [s.wooId, s.reason]), [[220, 'MAPPING_OTHER_STORE']])
  assert.deepEqual(planEuVatSeedApply(unstamped).skipped.map((s) => [s.wooId, s.reason]), [[220, 'MAPPING_UNSTAMPED']])
  assert.equal(planEuVatSeedApply(foreign).changes.some((c) => c.wooId === 220), false)
  assert.ok(codesOf(foreign).includes('MAPPING_OTHER_STORE'))
  assert.ok(codesOf(unstamped).includes('MAPPING_UNSTAMPED'))
  const none = planEuVatSeedApply({ ...withWorld(clear), storeIdentity: null })
  assert.equal(none.changes.length, 0)
  assert.equal(new Set(none.skipped.map((s) => s.reason)).size, 1)
  assert.equal(none.skipped[0]!.reason, 'STORE_NOT_IDENTIFIED')
  assert.ok(codesOf({ ...withWorld(clear), storeIdentity: null }).includes('STORE_NOT_IDENTIFIED'))
  assert.notEqual(planEuVatSeedApply({ ...withWorld(clear), storeIdentity: 'https://shop2.example' }).digest, base.digest, 'the configured store is in the digest')
})

test('a row enters the plan only if its identity and charged code are right, and what the plan judged is bound into the digest', () => {
  const clear = (w: World): void => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }
  const base = planEuVatSeedApply(withWorld(clear))
  assert.ok(base.changes.every((c) => c.identity.charged.code !== '' && c.identity.scheme !== null))
  const skippedReason = (mutate: (w: World) => void, id = 220): string | undefined => planEuVatSeedApply(withWorld((w) => { clear(w); mutate(w) })).skipped.find((s) => s.wooId === id)?.reason
  assert.equal(skippedReason((w) => { setIms(w, 220, { rate: '0.2100' }) }), 'IMS_PERCENT_DIFFERS')
  assert.equal(skippedReason((w) => { setIms(w, 220, { countryCode: 'AT' }) }), 'IMS_COUNTRY_DIFFERS')
  assert.equal(skippedReason((w) => { setIms(w, 220, { name: 'Germany VAT' }) }), 'IMS_NAME_DIFFERS')
  assert.equal(skippedReason((w) => { setIms(w, 220, { accountingTaxType: 'NONE' }) }), 'CHARGED_TYPE_NONE')
  assert.equal(skippedReason((w) => { setIms(w, 220, { accountingTaxType: null }) }), 'CHARGED_TYPE_MISSING')
  assert.equal(skippedReason((w) => { setIms(w, 220, { accountingTaxType: 'TAX001' }) }), 'CHARGED_TYPE_NOT_IN_XERO')
  assert.equal(skippedReason((w) => { w.xero.set('TAX131', xeroType('TAX131', 'DE IOSS VAT', '19.0000')) }), 'SCHEME_NOT_ZERO')
  assert.equal(skippedReason((w) => { w.xero.delete('TAX131') }), 'SCHEME_TYPE_NOT_IN_XERO')
  // A change in a fact the plan judged moves the digest even where the row stays plannable (the percentage Xero states for the charged type is not one: it skips, so use the identity of a type).
  const renamed = planEuVatSeedApply(withWorld((w) => { clear(w); w.xero.set('TAXC239', xeroType('TAXC239', 'NO VAT', '25.0000')) }))
  assert.equal(renamed.digest, base.digest, 'control: an equal Xero fact leaves the digest alone')
  assert.equal(planEuVatSeedApply({ ...withWorld(clear), xero: { proven: false, reason: 'x' } }).changes.length, 0, 'no proven Xero list, no plan')
})

test('the apply sets the marker only where declared and never clears a category it did not set', () => {
  const plan = planEuVatSeedApply(withWorld((w) => { setIms(w, 112, { reportingCategory: 'DOMESTIC' }); setIms(w, 220, { reportingCategory: 'OSS', schemePostingTaxType: null }) }))
  assert.deepEqual(plan.changes.map((c) => [c.wooId, c.to.reportingCategory]), [[220, 'IOSS']])
  assert.equal(plan.changes.some((c) => c.wooId === 112), false, 'DOMESTIC on the UK rate is left alone')
  const stale = planEuVatSeedApply(withWorld((w) => { setIms(w, 112, { reportingCategory: 'IOSS' }) }))
  assert.deepEqual(stale.changes.map((c) => [c.wooId, c.to.reportingCategory]), [[112, null]], 'an IOSS marker on a rate that is not a scheme rate is removed')
})

test('the identity facts the plan judged are in the digest even where the row stays plannable (case of the name, side, a replaced mapping), and the changes are in ascending id order', () => {
  const clear = (w: World): void => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }
  const base = planEuVatSeedApply(withWorld(clear))
  for (const [label, mutate] of [
    ['name case', (w: World) => { setIms(w, 220, { name: 'de vat' }) }],
    ['side', (w: World) => { setIms(w, 220, { usedFor: 'BOTH' }) }],
    ['mapping id', (w: World) => { w.mappings.set(220, { ...w.mappings.get(220)!, id: 'another-mapping' }) }],
  ] as const) {
    const changed = planEuVatSeedApply(withWorld((w) => { clear(w); mutate(w) }))
    assert.equal(changed.changes.some((c) => c.wooId === 220), true, `${label}: still plannable`)
    assert.notEqual(changed.digest, base.digest, label)
  }
  // The seed order is by WooCommerce id; the ids of the IMS rows are made to run the other way, so only the plan's own sort puts them in ascending id order (the lock order of the apply).
  const reversed = planEuVatSeedApply(withWorld((w) => {
    clear(w)
    for (const [wooId, r] of [...w.ims]) { const id = `z${String(1000 - wooId).padStart(4, '0')}`; w.ims.set(wooId, { ...r, id }); w.mappings.set(wooId, { ...w.mappings.get(wooId)!, taxRateId: id }) }
  }))
  const ids = reversed.changes.map((c) => c.taxRateId)
  assert.equal(ids.length, 30)
  assert.deepEqual(ids, [...ids].sort())
})

test('a shared IMS rate is ONE change that carries the facts of every mapping that names it; each mapping fact is in the digest', () => {
  const stale = (mutate: (w: World) => void = () => undefined): ReturnType<typeof planEuVatSeedApply> => planEuVatSeedApply(withWorld((w) => { setIms(w, 139, { reportingCategory: 'IOSS' }); mutate(w) }))
  const plan = stale()
  const change = plan.changes.find((c) => c.taxRateId === 'ims-139')
  assert.ok(change, 'the shared rate is planned once')
  assert.equal(plan.changes.filter((c) => c.taxRateId === 'ims-139').length, 1)
  assert.equal(change.identity.mappings.length, 33)
  assert.deepEqual(change.identity.mappings.map((m) => m.id), [...change.identity.mappings.map((m) => m.id)].sort())
  assert.deepEqual([change.from.reportingCategory, change.to.reportingCategory], ['IOSS', null])
  const d = plan.digest
  // A mapping that still passes every check but records a different (equal-meaning) class spelling, or has another id, moves the digest.
  assert.notEqual(stale((w) => { w.mappings.set(150, { ...w.mappings.get(150)!, id: 'swapped' }) }).digest, d)
  assert.notEqual(stale((w) => { w.mappings.set(150, { ...w.mappings.get(150)!, externalClass: ' Zero-Rate ' }) }).digest, d)
  assert.equal(stale((w) => { w.mappings.set(150, { ...w.mappings.get(150)!, externalRatePct: '0.00' }) }).digest, d, 'the percentage is judged and bound by value (four decimals): an equal value keeps the digest')
})

test('a type sales lines cannot use (canApply.revenue not true) is an error for the charged and the scheme type, and the rate is not planned', () => {
  const noRevenue = (code: string) => (w: World): void => { w.xero.set(code, { ...w.xero.get(code)!, canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } }) }
  expectError(noRevenue('TAX131'), 'XERO_NOT_SALES_TYPE')
  expectError(noRevenue(syntheticChargedCode(220)), 'XERO_NOT_SALES_TYPE')
  expectError((w) => { w.xero.set('TAX131', { ...w.xero.get('TAX131')!, canApply: { assets: null, equity: null, expenses: null, liabilities: null, revenue: null } }) }, 'XERO_NOT_SALES_TYPE')
  const clear = (w: World): void => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }
  for (const code of ['TAX131', syntheticChargedCode(220)]) {
    const plan = planEuVatSeedApply(withWorld((w) => { clear(w); noRevenue(code)(w) }))
    assert.equal(plan.changes.some((c) => c.wooId === 220), false, code)
    assert.equal(plan.skipped.find((s) => s.wooId === 220)?.reason, 'XERO_NOT_SALES_TYPE', code)
  }
})

test('an UNDECLARED WooCommerce mapping onto a declared rate (scheme or shared) is a sharer the check sees: preflight error, the rate is not planned, and the mapping set is bound into the digest', () => {
  const stray = (target: string) => (w: World): void => { w.mappings.set(88888, { id: 'map-stray', externalTaxRateId: '88888', externalName: 'Stray', externalCountry: 'DE', externalRatePct: '19.0000', externalClass: 'standard', taxRateId: target, storeIdentity: STORE }) }
  expectError(stray('ims-220'), 'SHARED_IMS_ROW')
  expectError(stray('ims-139'), 'SHARED_IMS_ROW')
  const clear = (w: World): void => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }
  const plan = planEuVatSeedApply(withWorld((w) => { clear(w); stray('ims-220')(w) }))
  assert.equal(plan.changes.some((c) => c.wooId === 220), false)
  assert.equal(plan.skipped.find((s) => s.wooId === 220)?.reason, 'SHARED_IMS_ROW')
  const base = planEuVatSeedApply(withWorld(clear))
  assert.deepEqual(base.changes.find((c) => c.wooId === 220)!.identity.allMappingIds, ['map-220'])
  // A declared sharer whose own mapping is unusable does not make the shared rate unplannable, but its mapping is part of the bound set.
  const withBadSharer = planEuVatSeedApply(withWorld((w) => { clear(w); setIms(w, 139, { reportingCategory: 'IOSS' }); w.mappings.set(151, { ...w.mappings.get(151)!, externalCountry: 'DE' }) }))
  const zero = withBadSharer.changes.find((c) => c.taxRateId === 'ims-139')
  assert.ok(zero)
  assert.equal(zero.identity.allMappingIds.length, 33)
  assert.equal(zero.identity.mappings.length, 32)
})

test('the percentage is the one tax is computed at: the active components\' effective rate when there are any (the set-identity report\'s function), else the rate column', () => {
  const comp = (rateId: string, rate: string, over: Partial<{ active: boolean; compoundOnPrevious: boolean; sortOrder: number }> = {}) => ({ taxRateId: rateId, rate, compoundOnPrevious: false, active: true, sortOrder: 0, ...over })
  const world = (components: ReturnType<typeof comp>[]): PreflightInput => ({ ...withWorld(() => undefined), componentRates: components })
  const unseeded = (components: ReturnType<typeof comp>[]): PreflightInput => ({ ...withWorld((w) => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }), componentRates: components })
  const codes = (input: PreflightInput): string[] => codesOf(input)
  assert.deepEqual(codes(world([comp('ims-220', '0.1900')])), [], 'a component that agrees with the column and the declaration')
  assert.deepEqual(codes(world([comp('ims-220', '0.2100')])).filter((c) => c === 'IMS_PERCENT_DIFFERS'), ['IMS_PERCENT_DIFFERS'], 'the column says 19, the active component 21')
  assert.deepEqual(codes(world([comp('ims-220', '0.2100', { active: false })])), [], 'an inactive component is ignored')
  assert.deepEqual(codes(world([comp('ims-220', '0.1000', { sortOrder: 0 }), comp('ims-220', '0.0800', { sortOrder: 1, compoundOnPrevious: true })])).filter((c) => c === 'IMS_PERCENT_DIFFERS'), ['IMS_PERCENT_DIFFERS'], 'compound 10% then 8% is 18.8%, not 19')
  const plan = planEuVatSeedApply(unseeded([comp('ims-220', '0.2100')]))
  assert.equal(plan.changes.some((c) => c.wooId === 220), false)
  assert.equal(plan.skipped.find((s) => s.wooId === 220)?.reason, 'IMS_PERCENT_DIFFERS')
  // The components are bound into the plan: a change that leaves the percentage alone still moves the digest.
  const a = planEuVatSeedApply(unseeded([comp('ims-220', '0.1900')]))
  const b = planEuVatSeedApply(unseeded([comp('ims-220', '0.1900', { sortOrder: 3 })]))
  const c = planEuVatSeedApply(unseeded([comp('ims-220', '0.1900', { compoundOnPrevious: true })]))
  assert.deepEqual(a.changes.find((x) => x.wooId === 220)!.identity.components, [{ rate: '0.1900', compoundOnPrevious: false, sortOrder: 0 }])
  assert.notEqual(a.digest, b.digest)
  assert.notEqual(a.digest, c.digest)
})
