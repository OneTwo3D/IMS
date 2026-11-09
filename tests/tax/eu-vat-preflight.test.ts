import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateEuVatPreflight, planEuVatSeedApply, PREFLIGHT_CODES, type PreflightCode, type PreflightInput } from '@/lib/tax/eu-vat-preflight'
import { perfectWorld, syntheticChargedCode, withWorld, xeroType, type World } from './eu-vat-fixtures'

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
  expectError((w) => { w.mappings.set(151, { ...w.mappings.get(151)!, taxRateId: 'ims-150' }) }, 'IMS_COUNTRY_DIFFERS', 'SHARED_IMS_ROW')
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
    w.mappings.set(152, { ...w.mappings.get(152)!, taxRateId: 'ims-151' })
    w.mappings.set(219, { ...w.mappings.get(219)!, taxRateId: 'nowhere' })
  }))
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.wooId, s.reason]))
  assert.deepEqual(reasons, { 215: 'WOO_UNMAPPED', 216: 'MAPPING_DIFFERS', 217: 'IMS_RATE_INACTIVE', 218: 'IMS_RATE_NOT_SALES', 219: 'IMS_RATE_MISSING', 151: 'SHARED_IMS_ROW', 152: 'SHARED_IMS_ROW' })
  assert.equal(plan.changes.some((c) => [215, 216, 217, 218, 219].includes(c.wooId)), false)
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
