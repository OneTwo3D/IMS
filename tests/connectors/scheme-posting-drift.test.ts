import assert from 'node:assert/strict'
import test from 'node:test'

import { computeSchemePostingDrift, MAPPING_ISSUES_ID, type SchemeDriftMapping, type SchemeDriftRate } from '@/lib/connectors/xero/scheme-posting-drift'
import { buildDriftSnapshot, sweepTaxRateDrift } from '@/lib/connectors/xero/tax-rate-drift-sweeper'
import { loadEuVatSeed } from '@/lib/tax/eu-vat-seed'
import { STORE, xeroType } from '../tax/eu-vat-fixtures'

const seed = loadEuVatSeed()
const declared = seed.rates.filter((r) => [220, 239, 112].includes(r.wooId))
const mapping = (wooId: number, over: Partial<SchemeDriftMapping> = {}): SchemeDriftMapping => {
  const r = seed.rates.find((x) => x.wooId === wooId)!
  return { externalTaxRateId: String(wooId), taxRateId: `r${wooId}`, storeIdentity: STORE, externalCountry: r.country, externalRatePct: r.ratePercent, externalClass: r.wooClass, ...over }
}
const rate = (wooId: number, over: Partial<SchemeDriftRate> = {}): SchemeDriftRate => {
  const r = seed.rates.find((x) => x.wooId === wooId)!
  return { taxRateId: `r${wooId}`, name: r.imsName, active: true, accountingTaxType: r.accountingTaxType ?? `C${wooId}`, reportingCategory: r.reportingCategory, schemePostingTaxType: r.schemePostingTaxType, ...over }
}
const XERO = [xeroType('TAX131', 'DE IOSS VAT', '0.0000'), xeroType('TAX122', 'NO VOEC VAT', '0.0000'), xeroType('TAX999', 'XX IOSS VAT', '0.0000')]
const run = (rates: SchemeDriftRate[], xero = XERO, over: { storeIdentity?: string | null; mappings?: SchemeDriftMapping[] } = {}): string[] => computeSchemePostingDrift({
  declared, mappings: over.mappings ?? [mapping(220), mapping(239), mapping(112)], rates, storeIdentity: over.storeIdentity === undefined ? STORE : over.storeIdentity, xero,
}).flatMap((d) => d.lines)
const good = (): SchemeDriftRate[] => [rate(220), rate(239), rate(112)]

test('rates as declared, with their types ACTIVE at 0% and named as declared, are not drift', () => {
  assert.deepEqual(run(good()), [])
})

test('a CLEARED scheme type is drift, which the old check on carriers of a type could not see', () => {
  const lines = run([rate(220, { schemePostingTaxType: null }), rate(239), rate(112)])
  assert.match(lines[0]!, /Scheme posting type is not set, declared TAX131 for Woo rate 220/)
})

test('a type swapped for another VALID zero-rated type is drift', () => {
  const lines = run([rate(220, { schemePostingTaxType: 'TAX999' }), rate(239), rate(112)])
  assert.match(lines[0]!, /Scheme posting type is TAX999, declared TAX131/)
})

test('IOSS turned into VOEC (or the reverse, or cleared) is drift; a marker on a rate that is not a scheme rate is drift', () => {
  assert.match(run([rate(220, { reportingCategory: 'VOEC' }), rate(239), rate(112)])[0]!, /Reporting category is "VOEC", declared IOSS/)
  assert.match(run([rate(220), rate(239, { reportingCategory: 'IOSS' }), rate(112)])[0]!, /Reporting category is "IOSS", declared VOEC/)
  assert.match(run([rate(220, { reportingCategory: null }), rate(239), rate(112)])[0]!, /declared IOSS/)
  assert.match(run([rate(220), rate(239), rate(112, { reportingCategory: 'IOSS' })])[0]!, /declared neither IOSS nor VOEC/)
  assert.match(run([rate(220), rate(239), rate(112, { schemePostingTaxType: 'TAX131' })])[0]!, /but the declaration has none for Woo rate 112/)
  assert.deepEqual(run([rate(220, { reportingCategory: ' ioss ' }), rate(239), rate(112)]), [], 'case and spaces are not drift')
})

test('the declared type itself drifting in Xero is reported by code: gone, not ACTIVE, not 0, no rate, renamed; and on the charged code', () => {
  const lines = (xero: ReturnType<typeof xeroType>[], rates = good()): string => run(rates, xero).join(' | ')
  assert.match(lines([XERO[1]!]), /TAX131 is not in the Xero tax-rate list/)
  assert.match(lines([xeroType('TAX131', 'DE IOSS VAT', '0.0000', 'ARCHIVED'), XERO[1]!]), /ARCHIVED in Xero, not ACTIVE/)
  assert.match(lines([xeroType('TAX131', 'DE IOSS VAT', '19.0000'), XERO[1]!]), /19% in Xero, not 0%/)
  assert.match(lines([{ ...xeroType('TAX131', 'DE IOSS VAT', '0.0000'), effectiveRate: null, displayTaxRate: null }, XERO[1]!]), /states no rate/)
  assert.match(lines([xeroType('TAX131', 'DE IOSS  VAT', '0.0000'), XERO[1]!]), /named "DE IOSS  VAT" in Xero, declared "DE IOSS VAT"/)
  assert.match(lines(XERO, [rate(220, { accountingTaxType: 'TAX131' }), rate(239), rate(112)]), /post on the charged rate/)
})

test('a type carried by a rate no declared mapping names is drift', () => {
  const stray = { taxRateId: 'stray', name: 'Stray', active: true, accountingTaxType: null, reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' }
  assert.match(run([...good(), stray]).join(' | '), /no declared WooCommerce mapping names it/)
})

test('a declared mapping that is missing, never adopted, made against another store, recording another store rate, or naming a missing or inactive rate is DRIFT, in one item', () => {
  const issues = (mappings: SchemeDriftMapping[], rates = good(), store: string | null = STORE): string[] => computeSchemePostingDrift({ declared, mappings, rates, storeIdentity: store, xero: XERO }).filter((d) => d.taxRateId === MAPPING_ISSUES_ID).flatMap((d) => d.lines)
  assert.deepEqual(issues([mapping(220), mapping(239), mapping(112)]), [])
  assert.match(issues([mapping(239), mapping(112)])[0]!, /Declared Woo rate 220 has no storefront mapping/)
  assert.match(issues([mapping(220, { storeIdentity: null }), mapping(239), mapping(112)])[0]!, /never adopted/)
  assert.match(issues([mapping(220, { storeIdentity: 'https://other.example' }), mapping(239), mapping(112)])[0]!, /another store/)
  assert.match(issues([mapping(220, { externalRatePct: '21.0000' }), mapping(239), mapping(112)])[0]!, /another country, percentage or class/)
  assert.match(issues([mapping(220, { externalCountry: 'AT' }), mapping(239), mapping(112)])[0]!, /another country, percentage or class/)
  assert.match(issues([mapping(220, { externalClass: 'zero-rate' }), mapping(239), mapping(112)])[0]!, /another country, percentage or class/)
  assert.match(issues([mapping(220, { taxRateId: 'gone' }), mapping(239), mapping(112)])[0]!, /names a tax rate that does not exist/)
  assert.match(issues([mapping(220), mapping(239), mapping(112)], [rate(220, { active: false }), rate(239), rate(112)])[0]!, /inactive tax rate/)
  assert.match(issues([mapping(220), mapping(239), mapping(112)], good(), null)[0]!, /No usable WooCommerce store/)
  const item = computeSchemePostingDrift({ declared, mappings: [mapping(220, { storeIdentity: null })], rates: good(), storeIdentity: STORE, xero: XERO }).find((d) => d.taxRateId === MAPPING_ISSUES_ID)
  assert.equal(item?.name, 'EU VAT declaration: storefront mappings')
})

test('only a rate named by a mapping that PASSED the identity checks counts as declared: a rate behind a foreign or mismatched mapping that carries a type is also a stray', () => {
  for (const bad of [{ storeIdentity: 'https://other.example' }, { storeIdentity: null }, { externalRatePct: '21.0000' }]) {
    const lines = computeSchemePostingDrift({ declared, mappings: [mapping(220, bad), mapping(239), mapping(112)], rates: good(), storeIdentity: STORE, xero: XERO }).flatMap((d) => d.lines).join(' | ')
    assert.match(lines, /Carries scheme posting type TAX131 but no declared WooCommerce mapping names it/, JSON.stringify(bad))
  }
  assert.deepEqual(run(broken(), XERO, { storeIdentity: null }).filter((l) => /no declared WooCommerce mapping/.test(l)), [], 'with no store identifiable nothing is called a stray')
})

function broken(): SchemeDriftRate[] { return [rate(220, { schemePostingTaxType: null }), rate(239), rate(112)] }

test('the sweep reports it even for a rate with no components, records it, and the snapshot holds one entry per rate with the lines of both checks', async () => {
  const items = () => Promise.resolve(computeSchemePostingDrift({ declared, mappings: [mapping(220), mapping(239), mapping(112)], rates: broken(), storeIdentity: STORE, xero: XERO }))
  const recorded: string[] = []
  const result = await sweepTaxRateDrift({
    loadImsProfiles: async () => [],
    fetchXeroTaxRates: async () => { throw new Error('no Xero call for an empty profile list') },
    checkSchemePosting: items,
    recordDrift: async (item) => { recorded.push(item.taxRateId) },
  })
  assert.equal(result.drifted, 1)
  assert.deepEqual(recorded, ['r220'])
  assert.equal(buildDriftSnapshot(result).length, 1)

  const both = await sweepTaxRateDrift({
    loadImsProfiles: async () => [{ taxRateId: 'r220', profile: { name: 'DE VAT', components: [{ name: 'VAT', rate: 0.19, compoundOnPrevious: false }] } }],
    fetchXeroTaxRates: async () => [{ Name: 'DE VAT', TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: false }] }] as never,
    checkSchemePosting: items,
    recordDrift: async () => undefined,
  })
  const snapshot = buildDriftSnapshot(both)
  assert.equal(snapshot.length, 1, 'one entry per rate')
  assert.equal(snapshot[0]!.lines.length, 2)
  assert.match(snapshot[0]!.lines.join(' | '), /Scheme posting type is not set.*\|.*component rate: IMS 19%, Xero 20%/)
})

test('without the scheme check the sweep is what it was', async () => {
  const result = await sweepTaxRateDrift({ loadImsProfiles: async () => [], fetchXeroTaxRates: async () => [], recordDrift: async () => undefined })
  assert.deepEqual(result, { checked: 0, drifted: 0, items: [] })
})

test('an instance the declaration has not touched (no declared rate mapped, no scheme posting type anywhere) has nothing to drift from', () => {
  const untouched = [{ taxRateId: 'x', name: 'X', active: true, accountingTaxType: 'OUTPUT2', reportingCategory: null, schemePostingTaxType: null }]
  assert.deepEqual(computeSchemePostingDrift({ declared, mappings: [], rates: untouched, storeIdentity: null, xero: XERO }), [])
  assert.deepEqual(computeSchemePostingDrift({ declared, mappings: [], rates: untouched, storeIdentity: STORE, xero: XERO }), [])
  assert.notDeepEqual(computeSchemePostingDrift({ declared, mappings: [mapping(220)], rates: untouched, storeIdentity: STORE, xero: XERO }), [], 'one declared mapping engages it')
  assert.notDeepEqual(computeSchemePostingDrift({ declared, mappings: [], rates: [{ ...untouched[0]!, schemePostingTaxType: 'TAX131' }], storeIdentity: STORE, xero: XERO }), [], 'one scheme posting type engages it')
})
