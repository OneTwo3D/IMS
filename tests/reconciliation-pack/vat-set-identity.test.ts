import assert from 'node:assert/strict'
import test from 'node:test'

import type { NormalisedXeroTaxRate } from '../../lib/connectors/xero/tax-rate-list.ts'
import type { TaxComponentRateRow, TaxMappingRow, TaxRateRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { VAT_SET_REASON_LIST, compareVatSetIdentity, summariseVatSet, type VatSetInput, type VatSetRow } from '../../lib/reconciliation-pack/vat-set-identity.ts'
import type { WooTaxRateDetail } from '../../lib/reconciliation-pack/woo-source.ts'

/**
 * R13 SET IDENTITY, pure. One arm per closed reason, an identity swap, the regional rates (Canary Islands, PT-30), the scope boundaries
 * and the summary. [mutation: each rule below has a red mutation, listed in the PR]
 */

const woo = (id: string, over: Partial<WooTaxRateDetail> = {}): WooTaxRateDetail => ({ id, name: 'VAT', rate: '20.0000', country: 'GB', state: '', postcode: '', city: '', class: '', shipping: true, compound: false, ...over })
const ims = (id: string, accountingTaxType: string | null, over: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, name: 'GB VAT', rate: '0.2000', usedFor: 'SALES', reverseCharge: false, active: true, accountingTaxType, countryCode: 'GB', reportingCategory: 'DOMESTIC', isCompound: false, ...over })
const xero = (taxType: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({ taxType, name: 'GB VAT', status: 'ACTIVE', reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true }, ...over })
const map = (wooId: string, taxRateId: string): TaxMappingRow => ({ connector: 'woocommerce', externalTaxRateId: wooId, taxRateId, externalClass: null })

/** A consistent three-way set: UK 20, German OSS 19, the Canary Islands at 0 (Spain, region), Madeira at 22 (Portugal, PT-30). */
function base(): VatSetInput {
  return {
    woo: [
      woo('1', { name: 'GB VAT' }),
      woo('2', { name: 'DE VAT', country: 'DE', rate: '19.0000' }),
      woo('3', { name: 'ES-CN VAT', country: 'ES', state: 'CN', rate: '0.0000' }),
      woo('4', { name: 'PT-30 VAT', country: 'PT', state: 'PT-30', rate: '22.0000' }),
    ],
    rates: [
      ims('rGB', 'TAX001'),
      ims('rDE', 'TAX002', { name: 'DE VAT', rate: '0.1900', countryCode: 'DE', reportingCategory: 'OSS' }),
      ims('rCAN', 'TAX003', { name: 'ES-CN VAT', rate: '0.0000', countryCode: 'ES', reportingCategory: 'OSS' }),
      ims('rPT30', 'TAX004', { name: 'PT-30 VAT', rate: '0.2200', countryCode: 'PT', reportingCategory: 'OSS' }),
    ],
    mappings: [map('1', 'rGB'), map('2', 'rDE'), map('3', 'rCAN'), map('4', 'rPT30')],
    componentRates: [],
    xero: [
      xero('TAX001'),
      xero('TAX002', { name: 'DE VAT', reportTaxType: 'MOSSSALES', effectiveRate: '19.000000', displayTaxRate: '19.000000' }),
      xero('TAX003', { name: 'ES-CN VAT', reportTaxType: 'MOSSSALES', effectiveRate: '0.000000', displayTaxRate: '0.000000' }),
      xero('TAX004', { name: 'PT-30 VAT', reportTaxType: 'MOSSSALES', effectiveRate: '22.000000', displayTaxRate: '22.000000' }),
    ],
  }
}
const reasonsOf = (rows: VatSetRow[], system: VatSetRow['system'], id: string): string[] => rows.find((row) => row.system === system && row.id === id)?.reasons ?? ['<absent>']
const without = <T>(list: readonly T[], keep: (item: T) => boolean): T[] => list.filter(keep)

test('the consistent set is identical: every in-scope row has no reason, regional rates included', () => {
  const rows = compareVatSetIdentity(base())
  assert.equal(rows.length, 12)
  assert.deepEqual(rows.filter((row) => row.reasons.length > 0), [])
  assert.deepEqual(summariseVatSet(rows).identical, { woo: 4, ims: 4, xero: 4 })
})

test('WOO_UNMAPPED: a rate with no mapping, a mapping of another connector, or a mapping to an IMS rate that does not exist', () => {
  const input = base()
  input.mappings = without(input.mappings, (m) => m.externalTaxRateId !== '3')
  let rows = compareVatSetIdentity(input)
  assert.deepEqual(reasonsOf(rows, 'woo', '3'), ['WOO_UNMAPPED'])
  assert.deepEqual(reasonsOf(rows, 'ims', 'rCAN'), ['MISSING_IN_WOO'])
  assert.deepEqual(reasonsOf(rows, 'xero', 'TAX003'), ['MISSING_IN_WOO'])
  input.mappings = [...input.mappings, map('3', 'rGONE')]
  rows = compareVatSetIdentity(input)
  assert.deepEqual(reasonsOf(rows, 'woo', '3'), ['WOO_UNMAPPED'])
})

test('MISSING_IN_WOO: an IMS sales rate whose only mapping is from a rate the store no longer lists has no counterpart', () => {
  const input = base()
  input.woo = without(input.woo, (w) => w.id !== '4')
  const rows = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(rows, 'ims', 'rPT30'), reasonsOf(rows, 'xero', 'TAX004')], [['MISSING_IN_WOO'], ['MISSING_IN_WOO']])
  assert.equal(rows.some((row) => row.system === 'woo' && row.id === '4'), false)
})

test('XERO_NOT_IN_IMS: an ACTIVE custom sales type that no active IMS sales rate carries', () => {
  const input = base()
  input.xero = [...input.xero, xero('TAX099', { name: 'FR VAT' })]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'xero', 'TAX099'), ['XERO_NOT_IN_IMS'])
  // carried only by an inactive IMS rate: still no active carrier
  input.rates = [...input.rates, ims('rOld', 'TAX099', { active: false })]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'xero', 'TAX099'), ['XERO_NOT_IN_IMS'])
})

test('IMS_NOT_IN_XERO: no type, a type the list lacks, and a type that is not ACTIVE; the Xero row of a non-ACTIVE type is out of scope', () => {
  for (const [label, mutate] of [
    ['no type', (i: VatSetInput) => { i.rates = i.rates.map((r) => (r.id === 'rDE' ? { ...r, accountingTaxType: null } : r)) }],
    ['absent from the list', (i: VatSetInput) => { i.xero = without(i.xero, (x) => x.taxType !== 'TAX002') }],
    ['DELETED', (i: VatSetInput) => { i.xero = i.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, status: 'DELETED' as const } : x)) }],
    ['ARCHIVED', (i: VatSetInput) => { i.xero = i.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, status: 'ARCHIVED' as const } : x)) }],
    ['PENDING', (i: VatSetInput) => { i.xero = i.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, status: 'PENDING' as const } : x)) }],
  ] as const) {
    const input = base()
    mutate(input)
    const rows = compareVatSetIdentity(input)
    assert.deepEqual(reasonsOf(rows, 'ims', 'rDE'), ['IMS_NOT_IN_XERO'], label)
    assert.equal(rows.some((row) => row.system === 'xero' && row.id === 'TAX002'), label === 'no type', `${label}: a Xero row exists only while the type is an ACTIVE sales type (then it has no IMS carrier)`)
  }
})

test('PERCENT_DIFFERS: exact decimals, on every pair; neither Xero rate stated is a difference; components set the IMS percentage', () => {
  let input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: '20.000001', displayTaxRate: '20.000001' } : x))
  let rows = compareVatSetIdentity(input)
  assert.deepEqual(reasonsOf(rows, 'ims', 'rGB'), ['PERCENT_DIFFERS', 'COMPONENTS_DIFFER'], 'one stated component at the same wrong percentage differs too')
  assert.deepEqual(reasonsOf(rows, 'woo', '1'), [], 'Woo and IMS agree; the difference is IMS against Xero')
  input = base()
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: '20.0001' } : w))
  rows = compareVatSetIdentity(input)
  assert.deepEqual(reasonsOf(rows, 'woo', '1'), ['PERCENT_DIFFERS'])
  assert.deepEqual(reasonsOf(rows, 'ims', 'rGB'), [])
  // The display rate is used only when EffectiveRate is not stated; neither stated is a difference.
  input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: null } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), [])
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: null, displayTaxRate: null } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS', 'COMPONENTS_DIFFER'], 'nothing stated: no percentage, and no component to match the IMS one')
  // EffectiveRate wins over DisplayTaxRate when both are stated and differ: Xero's effective rate 20 matches IMS even though the display rate is 19; the reverse pair differs.
  input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: '20.000000', displayTaxRate: '19.000000' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), [], 'EffectiveRate 20 is the percentage, not DisplayTaxRate 19')
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: '19.000000', displayTaxRate: '20.000000' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS', 'COMPONENTS_DIFFER'], 'DisplayTaxRate 20 does not rescue EffectiveRate 19')
  // An unparseable Woo rate is a difference, not an equality.
  input = base()
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: 'abc' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'woo', '1'), ['PERCENT_DIFFERS'])
  // Components: the active components' effective rate is what IMS charges, not the column.
  input = base()
  const components: TaxComponentRateRow[] = [{ taxRateId: 'rGB', rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 0 }, { taxRateId: 'rGB', rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 1 }]
  input.componentRates = components
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, components: [{ name: 'A', rate: '10.000000', compound: false, nonRecoverable: false }, { name: 'B', rate: '10.000000', compound: false, nonRecoverable: false }] } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), [], '10 + 10 is 20, and Xero states the same two components')
  input.componentRates = [{ ...components[0]!, rate: '0.0500' }, components[1]!]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS', 'COMPONENTS_DIFFER'])
  input.componentRates = [{ ...components[0]!, rate: '0.0500' }, { ...components[1]!, active: false }]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS', 'COMPONENTS_DIFFER'], 'an inactive component is not counted')
})

test('COUNTRY_DIFFERS: the Woo country, the IMS code, the IMS name prefix and the Xero name prefix must agree; UK = GB and EL = GR; case-insensitive', () => {
  const cases: Array<[string, (i: VatSetInput) => void, string, string, boolean]> = [
    ['Woo country', (i) => { i.woo = i.woo.map((w) => (w.id === '2' ? { ...w, country: 'FR' } : w)) }, 'woo', '2', true],
    ['Woo has no country', (i) => { i.woo = i.woo.map((w) => (w.id === '2' ? { ...w, country: '' } : w)) }, 'woo', '2', true],
    ['IMS name prefix', (i) => { i.rates = i.rates.map((r) => (r.id === 'rDE' ? { ...r, name: 'AT VAT' } : r)) }, 'ims', 'rDE', true],
    ['Xero name prefix', (i) => { i.xero = i.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, name: 'AT VAT' } : x)) }, 'ims', 'rDE', true],
    ['lower-case Xero prefix of another country', (i) => { i.xero = i.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, name: 'at VAT' } : x)) }, 'ims', 'rDE', true],
    ['UK is GB', (i) => { i.woo = i.woo.map((w) => (w.id === '1' ? { ...w, country: 'UK' } : w)); i.xero = i.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, name: 'UK VAT' } : x)) }, 'woo', '1', false],
    ['EL is GR', (i) => { i.woo = [...i.woo, woo('9', { country: 'EL', rate: '24.0000' })]; i.rates = [...i.rates, ims('rGR', 'TAX009', { name: 'GR VAT', rate: '0.2400', countryCode: 'GR', reportingCategory: 'OSS' })]; i.mappings = [...i.mappings, map('9', 'rGR')]; i.xero = [...i.xero, xero('TAX009', { name: 'EL VAT', reportTaxType: 'MOSSSALES', effectiveRate: '24.000000', displayTaxRate: '24.000000' })] }, 'ims', 'rGR', false],
  ]
  for (const [label, mutate, system, id, differs] of cases) {
    const input = base()
    mutate(input)
    const rows = compareVatSetIdentity(input)
    const all = rows.flatMap((row) => row.reasons)
    assert.equal(reasonsOf(rows, system as VatSetRow['system'], id).includes('COUNTRY_DIFFERS'), differs, label)
    if (!differs) assert.ok(!all.includes('COUNTRY_DIFFERS'), `${label}: no row differs`)
  }
})

test('REPORT_TYPE_DIFFERS and REPORT_TYPE_UNKNOWN follow the re-key: the helper that creates the Xero rate decides, a missing live report type or an unknown category is unknown', () => {
  let input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, reportTaxType: 'OUTPUT' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rDE'), ['REPORT_TYPE_DIFFERS'])
  input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, reportTaxType: ' mosssales ' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rDE'), [], 'compared trimmed and upper case')
  input.xero = input.xero.map((x) => (x.taxType === 'TAX002' ? { ...x, reportTaxType: null } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rDE'), ['REPORT_TYPE_UNKNOWN'])
  input = base()
  input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, reportingCategory: 'WEIRD' } : r))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['REPORT_TYPE_UNKNOWN'])
})

test('XERO_NOT_SALES_TYPE: the live type cannot be applied to revenue (and then it is not an in-scope Xero row either)', () => {
  const input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, canApply: { ...x.canApply, revenue: false } } : x))
  const rows = compareVatSetIdentity(input)
  assert.deepEqual(reasonsOf(rows, 'ims', 'rGB'), ['XERO_NOT_SALES_TYPE'])
  assert.equal(rows.some((row) => row.system === 'xero' && row.id === 'TAX001'), false)
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, canApply: { ...x.canApply, revenue: null } } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['XERO_NOT_SALES_TYPE'], 'not stated is not sales')
})

test('IMS_RATE_NOT_ACTIVE_SALES: a Woo rate mapped to an inactive, purchase-only or reverse-charge IMS rate; those IMS rates are out of scope themselves', () => {
  for (const over of [{ active: false }, { usedFor: 'PURCHASE' }, { reverseCharge: true }] as const) {
    const input = base()
    input.rates = input.rates.map((r) => (r.id === 'rDE' ? { ...r, ...over } : r))
    const rows = compareVatSetIdentity(input)
    assert.ok(reasonsOf(rows, 'woo', '2').includes('IMS_RATE_NOT_ACTIVE_SALES'), JSON.stringify(over))
    assert.equal(rows.some((row) => row.system === 'ims' && row.id === 'rDE'), false)
    assert.equal(rows.some((row) => row.system === 'xero' && row.id === 'TAX002'), true, 'the Xero type is still a sales type with no active IMS carrier')
    assert.deepEqual(reasonsOf(rows, 'xero', 'TAX002'), ['XERO_NOT_IN_IMS'])
  }
  const both = base()
  both.rates = both.rates.map((r) => (r.id === 'rDE' ? { ...r, usedFor: 'BOTH' } : r))
  assert.deepEqual(compareVatSetIdentity(both).filter((row) => row.reasons.length > 0), [], 'a BOTH rate is a sales rate')
})

test('DUPLICATE_MAPPING: two or more Woo rates on one IMS rate, of equal or different scope, or two active IMS sales rates on one Xero type; one to one passes', () => {
  let input = base()
  input.woo = [...input.woo, woo('5', { name: 'ES-CN VAT', country: 'ES', state: 'CN', rate: '0.0000', shipping: false })]
  input.mappings = [...input.mappings, map('5', 'rCAN')]
  let same = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(same, 'woo', '3'), reasonsOf(same, 'woo', '5')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING']], 'the same scope listed twice is still two Woo rates on one IMS rate; flagged on both')
  assert.deepEqual(reasonsOf(same, 'ims', 'rCAN'), [])
  // Two identical-scope Woo rates (same everything, shipping on) on one IMS rate.
  input = base()
  input.woo = [...input.woo, woo('5', { name: 'ES-CN VAT', country: 'ES', state: 'CN', rate: '0.0000' })]
  input.mappings = [...input.mappings, map('5', 'rCAN')]
  same = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(same, 'woo', '3'), reasonsOf(same, 'woo', '5')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING']])
  assert.deepEqual(compareVatSetIdentity(base()).filter((row) => row.reasons.length > 0), [], 'one to one passes')
  input = base()
  input.woo = [...input.woo, woo('5', { name: 'ES-CN VAT', country: 'ES', state: 'TF', rate: '0.0000' })]
  input.mappings = [...input.mappings, map('5', 'rCAN')]
  const rows = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(rows, 'woo', '3'), reasonsOf(rows, 'woo', '5')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING', 'REGION_DIFFERS']], 'the Tenerife rate on the Canary-named IMS rate is also a different region')
  // A second Woo rate that differs ONLY in its tax class is a different scope (and its class matches its own mapping).
  input = base()
  input.woo = [...input.woo, woo('5', { name: 'GB VAT', class: 'reduced-rate' })]
  input.mappings = [...input.mappings, { ...map('5', 'rGB'), externalClass: 'reduced-rate' }]
  const byClass = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(byClass, 'woo', '1'), reasonsOf(byClass, 'woo', '5')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING']])
  input = base()
  input.rates = [...input.rates, ims('rGB2', 'TAX001')]
  const dup = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(dup, 'ims', 'rGB'), reasonsOf(dup, 'ims', 'rGB2')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING', 'MISSING_IN_WOO']])
})

test('IDENTITY SWAP: the same counts with a Woo rate mapped to the wrong IMS rate is a finding on both ends, never an identical set', () => {
  const input = base()
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '2' ? map('2', 'rPT30') : m.externalTaxRateId === '4' ? map('4', 'rDE') : m))
  const rows = compareVatSetIdentity(input)
  for (const id of ['2', '4']) assert.ok(reasonsOf(rows, 'woo', id).includes('PERCENT_DIFFERS') && reasonsOf(rows, 'woo', id).includes('COUNTRY_DIFFERS'), id)
})

test('SCOPE: built-in Xero types, non-ACTIVE and non-revenue types, and the IMS rates that are not active sales rates are out of scope; a built-in type is still a valid target', () => {
  const input = base()
  input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, accountingTaxType: 'OUTPUT2' } : r))
  input.xero = [...input.xero.filter((x) => x.taxType !== 'TAX001'), xero('OUTPUT2'), xero('ZERORATEDOUTPUT', { name: 'Zero Rated' }), xero('TAX050', { status: 'ARCHIVED' }), xero('TAX051', { canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } })]
  input.rates = [...input.rates, ims('rPur', 'TAX051', { usedFor: 'PURCHASE' }), ims('rRc', 'TAX052', { reverseCharge: true }), ims('rOff', 'TAX053', { active: false })]
  const rows = compareVatSetIdentity(input)
  assert.deepEqual(rows.filter((row) => row.reasons.length > 0), [])
  assert.deepEqual(rows.filter((row) => row.system === 'xero').map((row) => row.id).sort(), ['TAX002', 'TAX003', 'TAX004'])
  assert.deepEqual(rows.filter((row) => row.system === 'ims').map((row) => row.id).sort(), ['rCAN', 'rDE', 'rGB', 'rPT30'])
})

test('CLASS_DIFFERS: the live Woo class against the class the IMS mapping recorded; empty and "standard" are one class, case and spaces do not count', () => {
  const withClass = (wooClass: string, mapped: string | null): VatSetRow[] => {
    const input = base()
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, class: wooClass } : w))
    input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, externalClass: mapped } : m))
    return compareVatSetIdentity(input)
  }
  assert.deepEqual(reasonsOf(withClass('reduced-rate', null), 'woo', '1'), ['CLASS_DIFFERS'], 'moved from the standard class to a reduced one, same id, percent and country')
  assert.deepEqual(reasonsOf(withClass('', 'reduced-rate'), 'woo', '1'), ['CLASS_DIFFERS'], 'and the other way round')
  assert.deepEqual(reasonsOf(withClass('zero-rate', 'reduced-rate'), 'woo', '1'), ['CLASS_DIFFERS'])
  assert.deepEqual(reasonsOf(withClass('', null), 'woo', '1'), [])
  assert.deepEqual(reasonsOf(withClass('', 'standard'), 'woo', '1'), [], 'empty is the standard class')
  assert.deepEqual(reasonsOf(withClass('Standard ', ''), 'woo', '1'), [])
  assert.deepEqual(reasonsOf(withClass(' Reduced-Rate', 'reduced-rate'), 'woo', '1'), [], 'case and spaces do not count')
  assert.deepEqual(reasonsOf(withClass('reduced-rate', null), 'ims', 'rGB'), [], 'the IMS row itself is not touched by a Woo class')
})

test('COMPOUND_DIFFERS: the Woo compound flag against the IMS isCompound, either way round', () => {
  const run = (wooCompound: boolean, imsCompound: boolean): string[] => {
    const input = base()
    input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, compound: wooCompound } : w))
    input.rates = input.rates.map((r) => (r.id === 'rGB' ? { ...r, isCompound: imsCompound } : r))
    return reasonsOf(compareVatSetIdentity(input), 'woo', '1')
  }
  assert.deepEqual(run(true, false), ['COMPOUND_DIFFERS'], 'Woo compound, IMS not, same 20%')
  assert.deepEqual(run(false, true), ['COMPOUND_DIFFERS'])
  assert.deepEqual(run(true, true), [])
  assert.deepEqual(run(false, false), [])
})

test('COMPONENTS_DIFFER: IMS and Xero must tax the same way component by component (the re-key\'s componentMeaningDifference), not only to the same effective percentage', () => {
  const comp = (rate: string, over: Partial<TaxComponentRateRow> = {}): TaxComponentRateRow => ({ taxRateId: 'rGB', rate, compoundOnPrevious: false, active: true, sortOrder: 0, ...over })
  const part = (rate: string, over: Record<string, unknown> = {}) => ({ name: 'P', rate, compound: false, nonRecoverable: false, ...over })
  const run = (imsComponents: TaxComponentRateRow[], xeroComponents: NormalisedXeroTaxRate['components']): string[] => {
    const input = base()
    input.componentRates = imsComponents
    input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, components: xeroComponents } : x))
    return reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB')
  }
  const tenTen = [comp('0.1000'), comp('0.1000', { sortOrder: 1 })]
  assert.deepEqual(run(tenTen, [part('20.000000')]), ['COMPONENTS_DIFFER'], 'IMS 10+10 against one 20% Xero component: the same 20%, a different breakdown')
  assert.deepEqual(run([], [part('10.000000'), part('10.000000')]), ['COMPONENTS_DIFFER'], 'and the other way round')
  assert.deepEqual(run([], [part('20.000000', { compound: true })]), ['COMPONENTS_DIFFER'], 'compounding differs')
  assert.deepEqual(run([], [part('20.000000', { nonRecoverable: true })]), ['COMPONENTS_DIFFER'], 'a non-recoverable Xero component cannot be expressed by an IMS rate')
  assert.deepEqual(run(tenTen, [part('10.000000'), part('10.000000')]), [])
  assert.deepEqual(run([], [part('20.000000')]), [])
  assert.deepEqual(run([], []), [], 'no stored components is one component at the stated percentage')
})

test('SHIPPING_NOT_TAXED: a positive Woo rate with shipping off is a finding (the VAT difference report\'s rule); a zero rate is exempt; the reference is the live Xero percentage, else the IMS one', () => {
  const run = (id: string, shipping: boolean, edit: (input: VatSetInput) => void = () => {}): VatSetRow[] => {
    const input = base()
    input.woo = input.woo.map((w) => (w.id === id ? { ...w, shipping } : w))
    edit(input)
    return compareVatSetIdentity(input)
  }
  assert.deepEqual(reasonsOf(run('1', false), 'woo', '1'), ['SHIPPING_NOT_TAXED'], '20% on every side, shipping off')
  assert.deepEqual(reasonsOf(run('1', true), 'woo', '1'), [])
  assert.deepEqual(reasonsOf(run('3', false), 'woo', '3'), [], 'a 0% rate: shipping at 0% carries the goods\' 0%, so it is exempt')
  assert.deepEqual(reasonsOf(run('1', false), 'ims', 'rGB'), [], 'the finding belongs to the Woo row only')
  // Reference = the ACTIVE live Xero percentage, else IMS: a Woo 0% rate against IMS 20% and Xero 20% is PERCENT_DIFFERS and (reference 20) also not taxing shipping.
  const zeroWoo = run('1', false, (i) => { i.woo = i.woo.map((w) => (w.id === '1' ? { ...w, rate: '0.0000' } : w)) })
  assert.deepEqual(reasonsOf(zeroWoo, 'woo', '1'), ['PERCENT_DIFFERS', 'SHIPPING_NOT_TAXED'])
  // No ACTIVE live type: the IMS percentage is the reference.
  const noXero = run('1', false, (i) => { i.xero = i.xero.filter((x) => x.taxType !== 'TAX001') })
  assert.deepEqual(reasonsOf(noXero, 'woo', '1'), ['SHIPPING_NOT_TAXED'])
  const imsZeroNoXero = run('3', false, (i) => { i.rates = i.rates.map((r) => (r.id === 'rCAN' ? { ...r, rate: '0.0000' } : r)); i.xero = i.xero.filter((x) => x.taxType !== 'TAX003') })
  assert.deepEqual(reasonsOf(imsZeroNoXero, 'woo', '3'), [])
  // A Woo rate mapped to an IMS rate that is out of scope is judged by the IMS_RATE_NOT_ACTIVE_SALES reason only (the difference report skips it too).
  const inactive = run('1', false, (i) => { i.rates = i.rates.map((r) => (r.id === 'rGB' ? { ...r, active: false } : r)) })
  assert.deepEqual(reasonsOf(inactive, 'woo', '1'), ['IMS_RATE_NOT_ACTIVE_SALES'])
})

test('REGION_DIFFERS / REGION_UNVERIFIED: a swapped pair of regional rates cannot pass; where IMS records no region the Woo rate is a finding, never a pass; a single country-wide rate is unaffected', () => {
  // Two regions of Spain, same percentage, class, compound and shipping, each with its own IMS rate and Xero type.
  const pair = (): VatSetInput => {
    const input = base()
    input.woo = [...input.woo, woo('5', { name: 'ES-TF VAT', country: 'ES', state: 'TF', rate: '0.0000' })]
    input.rates = [...input.rates, ims('rTF', 'TAX005', { name: 'ES-TF VAT', rate: '0.0000', countryCode: 'ES', reportingCategory: 'OSS' })]
    input.xero = [...input.xero, xero('TAX005', { name: 'ES-TF VAT', reportTaxType: 'MOSSSALES', effectiveRate: '0.000000', displayTaxRate: '0.000000' })]
    input.mappings = [...input.mappings, map('5', 'rTF')]
    return input
  }
  assert.deepEqual(compareVatSetIdentity(pair()).filter((row) => row.reasons.length > 0), [], 'the correct pair passes')
  const swapped = pair()
  swapped.mappings = swapped.mappings.map((m) => (m.externalTaxRateId === '3' ? { ...m, taxRateId: 'rTF' } : m.externalTaxRateId === '5' ? { ...m, taxRateId: 'rCAN' } : m))
  const rows = compareVatSetIdentity(swapped)
  assert.deepEqual([reasonsOf(rows, 'woo', '3'), reasonsOf(rows, 'woo', '5')], [['REGION_DIFFERS', 'WOO_NAME_DIFFERS'], ['REGION_DIFFERS', 'WOO_NAME_DIFFERS']], 'the swap is a finding on both Woo rows')
  // The region is read with the country prefix and punctuation ignored (Woo "PT-30", "PT30" and "30" all state region 30).
  for (const state of ['PT30', '30', ' pt-30 ']) {
    const input = base(); input.woo = input.woo.map((w) => (w.id === '4' ? { ...w, state } : w))
    assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'woo', '4'), [], state)
  }
  // A country-wide Woo rate on a regional IMS rate (the Madeira rate), and the reverse.
  const wide = base(); wide.woo = wide.woo.map((w) => (w.id === '4' ? { ...w, state: '' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(wide), 'woo', '4'), ['REGION_DIFFERS'])
  // IMS records no region: a regional Woo rate cannot be confirmed.
  const noRegion = base(); noRegion.woo = noRegion.woo.map((w) => (w.id === '3' ? { ...w, name: 'ES Canary VAT' } : w)); noRegion.rates = noRegion.rates.map((r) => (r.id === 'rCAN' ? { ...r, name: 'ES Canary VAT' } : r))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(noRegion), 'woo', '3'), ['REGION_UNVERIFIED'])
  // A postcode or city IMS cannot record is never confirmed, even when the state matches.
  const postcode = base(); postcode.woo = postcode.woo.map((w) => (w.id === '3' ? { ...w, postcode: '35*; 38*' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(postcode), 'woo', '3'), ['REGION_UNVERIFIED'])
  // Two country-wide-looking rates of one country and class with a regional sibling: the unmarked ones are unverified; with no sibling a country-wide rate is untouched.
  const sibling = base()
  sibling.woo = [...sibling.woo, woo('5', { name: 'GB VAT 2', country: 'GB', state: 'SCT' })]
  sibling.rates = [...sibling.rates, ims('rSCT', 'TAX005', { name: 'GB VAT 2' })]
  sibling.xero = [...sibling.xero, xero('TAX005')]
  sibling.mappings = [...sibling.mappings, map('5', 'rSCT')]
  const sib = compareVatSetIdentity(sibling)
  assert.deepEqual([reasonsOf(sib, 'woo', '1'), reasonsOf(sib, 'woo', '5')], [['REGION_UNVERIFIED'], ['REGION_UNVERIFIED']])
  assert.deepEqual(reasonsOf(compareVatSetIdentity(base()), 'woo', '1'), [], 'a single country-wide rate is unaffected')
  // Regions that differ only in postcode make a country-wide sibling unverified too; a postcode alone on an unmarked IMS rate is unverified.
  const byPostcode = base()
  byPostcode.woo = [...byPostcode.woo, woo('5', { name: 'GB VAT 2', postcode: 'EH*' })]
  byPostcode.rates = [...byPostcode.rates, ims('rEH', 'TAX005', { name: 'GB VAT 2' })]
  byPostcode.xero = [...byPostcode.xero, xero('TAX005')]
  byPostcode.mappings = [...byPostcode.mappings, map('5', 'rEH')]
  const bp = compareVatSetIdentity(byPostcode)
  assert.deepEqual([reasonsOf(bp, 'woo', '1'), reasonsOf(bp, 'woo', '5')], [['REGION_UNVERIFIED'], ['REGION_UNVERIFIED']])
  const lone = base(); lone.woo = lone.woo.map((w) => (w.id === '1' ? { ...w, postcode: 'EH*' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(lone), 'woo', '1'), ['REGION_UNVERIFIED'], 'a lone rate with a postcode scope and no IMS region')
  // A generic word after the hyphen is not a region ("GB-VAT" states none).
  const generic = base(); generic.woo = generic.woo.map((w) => (w.id === '1' ? { ...w, name: 'GB-VAT' } : w)); generic.rates = generic.rates.map((r) => (r.id === 'rGB' ? { ...r, name: 'GB-VAT' } : r))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(generic), 'woo', '1'), [])
  // The sibling must be in scope: a rate whose IMS rate is inactive does not make a country-wide rate unverified.
  const outOfScope = base()
  outOfScope.woo = [...outOfScope.woo, woo('5', { name: 'GB VAT', state: 'SCT' })]
  outOfScope.rates = [...outOfScope.rates, ims('rSCT', null, { active: false })]
  outOfScope.mappings = [...outOfScope.mappings, map('5', 'rSCT')]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(outOfScope), 'woo', '1'), [])
})

test('XERO_REGION_DIFFERS / XERO_REGION_UNVERIFIED: the IMS name and the Xero name must state the same region, read by one parser; an unreadable name is a finding, never a pass', () => {
  const xeroName = (id: string, name: string, edit: (input: VatSetInput) => void = () => {}): VatSetRow[] => {
    const input = base(); input.xero = input.xero.map((x) => (x.taxType === id ? { ...x, name } : x)); edit(input)
    return compareVatSetIdentity(input)
  }
  assert.deepEqual(reasonsOf(compareVatSetIdentity(base()), 'ims', 'rPT30'), [], 'the correct pair passes')
  assert.deepEqual(reasonsOf(xeroName('TAX004', 'PT-20 VAT'), 'ims', 'rPT30'), ['XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS'], 'PT-30 against PT-20 at the same percentage, components and report type')
  assert.deepEqual(reasonsOf(xeroName('TAX004', 'PT-30 VAT'), 'ims', 'rPT30'), [])
  assert.deepEqual(reasonsOf(xeroName('TAX004', 'pt-30 VAT'), 'ims', 'rPT30'), [], 'case does not count')
  // An equal-rate regional swap of two Xero codes.
  const swap = base()
  swap.rates = [...swap.rates, ims('rAZ', 'TAX005', { name: 'PT-20 VAT', rate: '0.2200', countryCode: 'PT', reportingCategory: 'OSS' })]
  swap.xero = [...swap.xero, xero('TAX005', { name: 'PT-20 VAT', reportTaxType: 'MOSSSALES', effectiveRate: '22.000000', displayTaxRate: '22.000000' })]
  swap.woo = [...swap.woo, woo('5', { name: 'PT-20 VAT', country: 'PT', state: 'PT-20', rate: '22.0000' })]
  swap.mappings = [...swap.mappings, map('5', 'rAZ')]
  assert.deepEqual(compareVatSetIdentity(swap).filter((row) => row.reasons.length > 0), [], 'the correct two-region set passes')
  swap.rates = swap.rates.map((r) => (r.id === 'rPT30' ? { ...r, accountingTaxType: 'TAX005' } : r.id === 'rAZ' ? { ...r, accountingTaxType: 'TAX004' } : r))
  const swapped = compareVatSetIdentity(swap)
  assert.deepEqual([reasonsOf(swapped, 'ims', 'rPT30'), reasonsOf(swapped, 'ims', 'rAZ')], [['XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS'], ['XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS']])
  // One side regional and the other country-wide, both ways.
  assert.deepEqual(reasonsOf(xeroName('TAX004', 'PT VAT'), 'ims', 'rPT30'), ['XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS'], 'regional IMS, country-wide Xero')
  assert.deepEqual(reasonsOf(xeroName('TAX001', 'GB-SCT VAT'), 'ims', 'rGB'), ['XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS'], 'country-wide IMS, regional Xero')
  // A name this parser cannot read, on either side.
  assert.deepEqual(reasonsOf(xeroName('TAX004', 'PT Madeira VAT'), 'ims', 'rPT30'), ['XERO_NAME_DIFFERS', 'XERO_REGION_UNVERIFIED'])
  assert.deepEqual(reasonsOf(xeroName('TAX001', 'GB Standard Rate (20%)'), 'ims', 'rGB'), ['XERO_NAME_DIFFERS'], 'generic words after the prefix state no region: only the name differs')
  const imsSide = base(); imsSide.rates = imsSide.rates.map((r) => (r.id === 'rPT30' ? { ...r, name: 'PT Madeira VAT' } : r))
  assert.ok(reasonsOf(compareVatSetIdentity(imsSide), 'ims', 'rPT30').includes('XERO_REGION_UNVERIFIED'))
})

test('XERO_NAME_DIFFERS: an IMS rate and the Xero type its code names must have the same name (trimmed, whitespace collapsed, case ignored); the codes of two same-rate types cannot be swapped', () => {
  // PT-30 VAT and PT-30 IOSS VAT: same percentage, components and report type, codes swapped.
  const pair = (): VatSetInput => {
    const input = base()
    input.rates = [...input.rates, ims('rIOSS', 'TAX005', { name: 'PT-30 IOSS VAT', rate: '0.2200', countryCode: 'PT', reportingCategory: 'OSS' })]
    input.xero = [...input.xero, xero('TAX005', { name: 'PT-30 IOSS VAT', reportTaxType: 'MOSSSALES', effectiveRate: '22.000000', displayTaxRate: '22.000000' })]
    input.woo = [...input.woo, woo('5', { name: 'PT-30 IOSS VAT', country: 'PT', state: 'PT-30', class: 'ioss', rate: '22.0000' })]
    input.mappings = [...input.mappings, { ...map('5', 'rIOSS'), externalClass: 'ioss' }]
    return input
  }
  assert.deepEqual(compareVatSetIdentity(pair()).filter((row) => row.reasons.length > 0), [], 'the correct pair passes')
  const swapped = pair()
  swapped.rates = swapped.rates.map((r) => (r.id === 'rPT30' ? { ...r, accountingTaxType: 'TAX005' } : r.id === 'rIOSS' ? { ...r, accountingTaxType: 'TAX004' } : r))
  const rows = compareVatSetIdentity(swapped)
  assert.deepEqual([reasonsOf(rows, 'ims', 'rPT30'), reasonsOf(rows, 'ims', 'rIOSS')], [['XERO_NAME_DIFFERS'], ['XERO_NAME_DIFFERS']])
  assert.deepEqual(rows.find((row) => row.system === 'ims' && row.id === 'rPT30')?.names, { ims: 'PT-30 VAT', xero: 'PT-30 IOSS VAT' }, 'the row carries both names')
  assert.equal(rows.find((row) => row.system === 'woo' && row.id === '4')?.names, undefined)
  // Cosmetic differences pass: whitespace runs, surrounding spaces and case.
  for (const name of ['PT-30  VAT', ' PT-30 VAT ', 'pt-30 vat', 'PT-30\tVAT']) {
    const input = base(); input.xero = input.xero.map((x) => (x.taxType === 'TAX004' ? { ...x, name } : x))
    assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rPT30'), [], JSON.stringify(name))
  }
  // A genuinely different name is flagged, on the IMS side only.
  const other = base(); other.xero = other.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, name: 'GB VAT (Income)' } : x))
  const flagged = compareVatSetIdentity(other)
  assert.deepEqual([reasonsOf(flagged, 'ims', 'rGB'), reasonsOf(flagged, 'xero', 'TAX001')], [['XERO_NAME_DIFFERS'], []])
  // A type that is not ACTIVE is IMS_NOT_IN_XERO only: its name is not judged.
  const archived = base(); archived.xero = archived.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, name: 'something else', status: 'ARCHIVED' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(archived), 'ims', 'rGB'), ['IMS_NOT_IN_XERO'])
})

test('WOO_NAME_DIFFERS: a Woo rate must have the name of the IMS rate it maps to (trimmed, whitespace collapsed, case ignored); no swap of mapping targets can pass', () => {
  // Two same-scope, same-percent Woo rates with different labels (different treatments), each on its own IMS rate and Xero type.
  const pair = (): VatSetInput => {
    const input = base()
    input.woo = [...input.woo, woo('5', { name: 'GB VAT (digital)' })]
    input.rates = [...input.rates, ims('rDig', 'TAX005', { name: 'GB VAT (digital)' })]
    input.xero = [...input.xero, xero('TAX005', { name: 'GB VAT (digital)' })]
    input.mappings = [...input.mappings, map('5', 'rDig')]
    return input
  }
  const correct = compareVatSetIdentity(pair())
  assert.deepEqual(correct.filter((row) => row.reasons.length > 0).map((row) => `${row.system}|${row.id}|${row.reasons.join(',')}`), [], 'the correct pair passes')
  const swapped = pair()
  swapped.mappings = swapped.mappings.map((m) => (m.externalTaxRateId === '1' ? { ...m, taxRateId: 'rDig' } : m.externalTaxRateId === '5' ? { ...m, taxRateId: 'rGB' } : m))
  const rows = compareVatSetIdentity(swapped)
  assert.deepEqual([reasonsOf(rows, 'woo', '1'), reasonsOf(rows, 'woo', '5')], [['WOO_NAME_DIFFERS'], ['WOO_NAME_DIFFERS']], 'the swap is a finding on both Woo rows')
  assert.deepEqual(rows.find((row) => row.system === 'woo' && row.id === '1')?.names, { ims: 'GB VAT (digital)', woo: 'GB VAT' }, 'the row carries both names')
  assert.equal(rows.find((row) => row.system === 'ims' && row.id === 'rGB')?.names, undefined)
  // Cosmetic differences pass.
  for (const name of ['GB  VAT', ' GB VAT ', 'gb vat', 'GB\tVAT']) {
    const input = base(); input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, name } : w))
    assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'woo', '1'), [], JSON.stringify(name))
  }
  // A generic Woo label is a finding.
  const generic = base(); generic.woo = generic.woo.map((w) => (w.id === '1' ? { ...w, name: 'VAT' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(generic), 'woo', '1'), ['WOO_NAME_DIFFERS'])
  assert.deepEqual(reasonsOf(compareVatSetIdentity(generic), 'ims', 'rGB'), [], 'on the Woo row only')
})

test('the closed list is the one the report prints, every reason is reachable, and the summary counts rows and reasons exactly', () => {
  const input = base()
  input.woo = [...input.woo, woo('7', { country: 'FR' })]
  input.xero = [...input.xero, xero('TAX099', { name: 'IT VAT' })]
  const rows = compareVatSetIdentity(input)
  const summary = summariseVatSet(rows)
  assert.deepEqual(summary.inScope, { woo: 5, ims: 4, xero: 5 })
  assert.deepEqual(summary.identical, { woo: 4, ims: 4, xero: 4 })
  assert.equal(summary.byReason.WOO_UNMAPPED, 1)
  assert.equal(summary.byReason.XERO_NOT_IN_IMS, 1)
  assert.deepEqual(Object.keys(summary.byReason), VAT_SET_REASON_LIST)
  assert.deepEqual(VAT_SET_REASON_LIST, ['WOO_UNMAPPED', 'DUPLICATE_MAPPING', 'IMS_RATE_NOT_ACTIVE_SALES', 'IMS_NOT_IN_XERO', 'XERO_NOT_SALES_TYPE', 'PERCENT_DIFFERS', 'COUNTRY_DIFFERS', 'REPORT_TYPE_DIFFERS', 'REPORT_TYPE_UNKNOWN', 'CLASS_DIFFERS', 'COMPOUND_DIFFERS', 'COMPONENTS_DIFFER', 'SHIPPING_NOT_TAXED', 'REGION_DIFFERS', 'REGION_UNVERIFIED', 'WOO_NAME_DIFFERS', 'XERO_NAME_DIFFERS', 'XERO_REGION_DIFFERS', 'XERO_REGION_UNVERIFIED', 'MISSING_IN_WOO', 'XERO_NOT_IN_IMS'])
})
