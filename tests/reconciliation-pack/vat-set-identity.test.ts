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
const ims = (id: string, accountingTaxType: string | null, over: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, name: 'GB VAT', rate: '0.2000', usedFor: 'SALES', reverseCharge: false, active: true, accountingTaxType, countryCode: 'GB', reportingCategory: 'DOMESTIC', ...over })
const xero = (taxType: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({ taxType, name: 'GB VAT', status: 'ACTIVE', reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true }, ...over })
const map = (wooId: string, taxRateId: string): TaxMappingRow => ({ connector: 'woocommerce', externalTaxRateId: wooId, taxRateId })

/** A consistent three-way set: UK 20, German OSS 19, the Canary Islands at 0 (Spain, region), Madeira at 22 (Portugal, PT-30). */
function base(): VatSetInput {
  return {
    woo: [
      woo('1'),
      woo('2', { country: 'DE', rate: '19.0000' }),
      woo('3', { country: 'ES', state: 'CN', postcode: '35*; 38*', rate: '0.0000' }),
      woo('4', { country: 'PT', state: 'PT-30', rate: '22.0000' }),
    ],
    rates: [
      ims('rGB', 'TAX001'),
      ims('rDE', 'TAX002', { name: 'DE VAT', rate: '0.1900', countryCode: 'DE', reportingCategory: 'OSS' }),
      ims('rCAN', 'TAX003', { name: 'ES Canary VAT', rate: '0.0000', countryCode: 'ES', reportingCategory: 'OSS' }),
      ims('rPT30', 'TAX004', { name: 'PT Madeira VAT', rate: '0.2200', countryCode: 'PT', reportingCategory: 'OSS' }),
    ],
    mappings: [map('1', 'rGB'), map('2', 'rDE'), map('3', 'rCAN'), map('4', 'rPT30')],
    componentRates: [],
    xero: [
      xero('TAX001'),
      xero('TAX002', { name: 'DE VAT', reportTaxType: 'MOSSSALES', effectiveRate: '19.000000', displayTaxRate: '19.000000' }),
      xero('TAX003', { name: 'ES Canary VAT', reportTaxType: 'MOSSSALES', effectiveRate: '0.000000', displayTaxRate: '0.000000' }),
      xero('TAX004', { name: 'PT Madeira VAT', reportTaxType: 'MOSSSALES', effectiveRate: '22.000000', displayTaxRate: '22.000000' }),
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
  assert.deepEqual(reasonsOf(rows, 'ims', 'rGB'), ['PERCENT_DIFFERS'])
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
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS'])
  // EffectiveRate wins over DisplayTaxRate when both are stated and differ: Xero's effective rate 20 matches IMS even though the display rate is 19; the reverse pair differs.
  input = base()
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: '20.000000', displayTaxRate: '19.000000' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), [], 'EffectiveRate 20 is the percentage, not DisplayTaxRate 19')
  input.xero = input.xero.map((x) => (x.taxType === 'TAX001' ? { ...x, effectiveRate: '19.000000', displayTaxRate: '20.000000' } : x))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS'], 'DisplayTaxRate 20 does not rescue EffectiveRate 19')
  // An unparseable Woo rate is a difference, not an equality.
  input = base()
  input.woo = input.woo.map((w) => (w.id === '1' ? { ...w, rate: 'abc' } : w))
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'woo', '1'), ['PERCENT_DIFFERS'])
  // Components: the active components' effective rate is what IMS charges, not the column.
  input = base()
  const components: TaxComponentRateRow[] = [{ taxRateId: 'rGB', rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 0 }, { taxRateId: 'rGB', rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 1 }]
  input.componentRates = components
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), [], '10 + 10 is 20')
  input.componentRates = [{ ...components[0]!, rate: '0.0500' }, components[1]!]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS'])
  input.componentRates = [{ ...components[0]!, rate: '0.0500' }, { ...components[1]!, active: false }]
  assert.deepEqual(reasonsOf(compareVatSetIdentity(input), 'ims', 'rGB'), ['PERCENT_DIFFERS'], 'an inactive component is not counted')
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

test('DUPLICATE_MAPPING: two Woo rates of DIFFERENT scope on one IMS rate, or two active IMS sales rates on one Xero type; the same scope twice is one counterpart', () => {
  let input = base()
  input.woo = [...input.woo, woo('5', { country: 'ES', state: 'CN', postcode: '35*; 38*', rate: '0.0000', shipping: false })]
  input.mappings = [...input.mappings, map('5', 'rCAN')]
  assert.deepEqual(compareVatSetIdentity(input).filter((row) => row.reasons.length > 0), [], 'the same scope listed twice (shipping toggled) is not a duplicate')
  input = base()
  input.woo = [...input.woo, woo('5', { country: 'ES', state: 'TF', rate: '0.0000' })]
  input.mappings = [...input.mappings, map('5', 'rCAN')]
  const rows = compareVatSetIdentity(input)
  assert.deepEqual([reasonsOf(rows, 'woo', '3'), reasonsOf(rows, 'woo', '5')], [['DUPLICATE_MAPPING'], ['DUPLICATE_MAPPING']])
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
  assert.deepEqual(VAT_SET_REASON_LIST, ['WOO_UNMAPPED', 'DUPLICATE_MAPPING', 'IMS_RATE_NOT_ACTIVE_SALES', 'IMS_NOT_IN_XERO', 'XERO_NOT_SALES_TYPE', 'PERCENT_DIFFERS', 'COUNTRY_DIFFERS', 'REPORT_TYPE_DIFFERS', 'REPORT_TYPE_UNKNOWN', 'MISSING_IN_WOO', 'XERO_NOT_IN_IMS'])
})
