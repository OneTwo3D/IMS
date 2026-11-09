import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { evaluateEuVatPreflight, SCHEME_COUNTRIES } from '@/lib/tax/eu-vat-preflight'
import { isSchemeRate, loadEuVatSeed, seedPostingTaxType, validateEuVatSeed } from '@/lib/tax/eu-vat-seed'
import { perfectWorld } from './eu-vat-fixtures'

/**
 * THE PARITY TEST: the 65 live WooCommerce tax rates, as measured against Xeroom on 2026-11-09 (tests/fixtures/eu-vat-parity.json), judged against the declaration
 * (lib/tax/eu-vat-seed.json). For every row, the Xero type a line of that rate would post on under the declaration equals the one Xeroom resolves the rate to, a scheme rate never posts on its
 * charged code, and nothing posts on NONE. The fixture is an independent record: a rate added to one file and not the other fails here.
 */
type FixtureRow = {
  wooId: number; country: string; ratePercent: string; wooName: string; wooClass: string; xeroomAssocName: string; xeroomTaxType: string
  group: 'scheme' | 'uk-zero-or-182' | 'outside-scheme'
  expectedAccountingTaxType: string | null; expectedSchemePostingTaxType: string | null; expectedReportingCategory: 'IOSS' | 'VOEC' | null; postsNone: boolean
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/eu-vat-parity.json', import.meta.url), 'utf8')) as { rows: FixtureRow[] }
const seed = loadEuVatSeed()
const seedById = new Map(seed.rates.map((r) => [r.wooId, r]))

test('the declaration is internally consistent', () => {
  assert.deepEqual(validateEuVatSeed(seed), [])
})

test('the fixture and the declaration hold the same 65 WooCommerce rates, and the counts are the measured ones', () => {
  assert.equal(fixture.rows.length, 65)
  assert.equal(seed.rates.length, 65, 'a rate added to the declaration alone (or to the fixture alone) fails here until it is in both files')
  assert.deepEqual([...seedById.keys()].sort((a, b) => a - b), fixture.rows.map((r) => r.wooId).sort((a, b) => a - b))
  const scheme = fixture.rows.filter((r) => r.group === 'scheme')
  assert.equal(scheme.length, 30)
  assert.equal(scheme.filter((r) => r.expectedReportingCategory === 'IOSS').length, 29)
  assert.equal(scheme.filter((r) => r.expectedReportingCategory === 'VOEC').length, 1)
  assert.deepEqual(scheme.filter((r) => r.expectedReportingCategory === 'VOEC').map((r) => r.wooId), [239])
  assert.equal(fixture.rows.filter((r) => r.group === 'uk-zero-or-182').length, 33, 'UK, zero-rate and 182 rows')
  assert.deepEqual(fixture.rows.filter((r) => r.group === 'outside-scheme').map((r) => r.wooId).sort(), [223, 231])
})

for (const row of fixture.rows) {
  test(`Woo ${row.wooId} ${row.country || '(none)'} "${row.wooName}" ${row.ratePercent}% posts as Xeroom does`, () => {
    const rate = seedById.get(row.wooId)
    assert.ok(rate, 'declared')
    assert.equal(rate.country, row.country)
    assert.equal(rate.ratePercent, row.ratePercent)
    assert.equal(rate.wooName, row.wooName)
    assert.equal(rate.wooClass, row.wooClass)
    // The type a line posts on: the zero-rated type for a scheme rate, the rate's own type otherwise. Xeroom's resolution is the reference.
    if (row.group === 'scheme') {
      assert.equal(isSchemeRate(rate), true)
      assert.equal(rate.schemePostingTaxType, row.xeroomTaxType)
      assert.equal(seedPostingTaxType(rate), row.xeroomTaxType)
      assert.equal(rate.schemePostingXeroName, row.xeroomAssocName, 'the name is byte-exact, double spaces included')
      assert.notEqual(rate.accountingTaxType, row.xeroomTaxType, 'a scheme-rate line is never on the charged code')
      assert.notEqual(rate.schemePostingTaxType, rate.accountingTaxType)
      assert.ok(Number(rate.ratePercent) > 0, 'the charged rate carries the charged percentage')
      assert.equal(rate.reportingCategory, row.expectedReportingCategory)
      assert.equal(rate.accountingXeroName, rate.imsName, 'the charged rate is the "XX VAT" type')
    } else {
      assert.equal(isSchemeRate(rate), false)
      assert.equal(rate.schemePostingTaxType, null)
      assert.equal(rate.reportingCategory, null)
      assert.equal(rate.accountingTaxType, row.xeroomTaxType, 'a rate outside the scheme posts on its own type')
      assert.equal(seedPostingTaxType(rate), row.xeroomTaxType)
    }
    assert.equal(rate.accountingTaxType, row.expectedAccountingTaxType)
    assert.equal(rate.schemePostingTaxType, row.expectedSchemePostingTaxType)
    assert.equal(row.postsNone, false)
    assert.notEqual((seedPostingTaxType(rate) ?? '').toUpperCase(), 'NONE', 'no row posts on NONE')
    assert.notEqual((rate.accountingTaxType ?? '').toUpperCase(), 'NONE')
  })
}

test('rate 182 keeps ZERORATEDOUTPUT (ruling Q4); 223 and 231 are outside the scheme; Norway is VOEC on TAX122', () => {
  assert.equal(seedById.get(182)!.accountingTaxType, 'ZERORATEDOUTPUT')
  for (const id of [223, 231]) assert.equal(seedById.get(id)!.schemePostingTaxType, null)
  assert.equal(seedById.get(231)!.accountingTaxType, 'TAX019')
  const norway = seedById.get(239)!
  assert.equal(norway.schemePostingTaxType, 'TAX122')
  assert.equal(norway.reportingCategory, 'VOEC')
  assert.equal(norway.accountingXeroName, 'NO VAT')
  assert.equal(seedById.get(220)!.schemePostingTaxType, 'TAX131')
  assert.equal(seedById.get(215)!.schemePostingXeroName, 'AT IOSS  VAT')
})

test('every EU-27 member state, Monaco and Norway has a declared scheme rate; Portugal has two (the region is why the mapping is per rate)', () => {
  assert.equal(SCHEME_COUNTRIES.length, 29)
  for (const country of SCHEME_COUNTRIES) assert.ok(seed.rates.some((r) => r.country === country && isSchemeRate(r)), `${country} has a scheme rate`)
  assert.deepEqual(seed.rates.filter((r) => r.country === 'PT' && isSchemeRate(r)).map((r) => r.schemePostingTaxType).sort(), ['TAX149', 'TAX150'])
})

test('no declared rate shares its IMS name with another: one IMS rate per WooCommerce rate, no shared zero-rated row (ruling Q2)', () => {
  assert.equal(new Set(seed.rates.map((r) => r.imsName)).size, 65)
})

test('a world in which everything is as declared passes the preflight; the only listing is that many IMS rates share one Xero type, which R13 reports and is not exempted', () => {
  const result = evaluateEuVatPreflight(perfectWorld().input)
  assert.equal(result.status, 'checked')
  if (result.status !== 'checked') return
  assert.deepEqual(result.findings.filter((f) => f.severity === 'error'), [])
  assert.equal(result.ready, true)
  assert.deepEqual([...new Set(result.findings.map((f) => f.code))], ['XERO_TYPE_SHARED_BY_RATES'])
  assert.deepEqual(result.findings.map((f) => f.subject), ['Xero type ZERORATEDOUTPUT'])
  assert.match(result.findings[0]!.detail, /^33 rates /)
})
