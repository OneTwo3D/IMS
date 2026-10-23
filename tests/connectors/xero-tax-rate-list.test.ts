import assert from 'node:assert/strict'
import test from 'node:test'

import { driftViewOfList } from '@/lib/connectors/xero/tax-rate-drift-sweeper'
import { digestTaxRateList, parseXeroTaxRateList, readStoredComponents, sixPlaceDecimal, XERO_TAX_RATE_LIST_MAX_ROWS } from '@/lib/connectors/xero/tax-rate-list'

/**
 * The strict validation of GET /TaxRates and the digest that proves a stored copy is one complete read.
 * Mutations are listed in the PR.
 */

const row = (over: Record<string, unknown> = {}) => ({
  Name: 'Standard VAT', TaxType: 'OUTPUT2', Status: 'ACTIVE', ReportTaxType: 'OUTPUT2', DisplayTaxRate: 20, EffectiveRate: 20,
  CanApplyToAssets: false, CanApplyToEquity: false, CanApplyToExpenses: false, CanApplyToLiabilities: false, CanApplyToRevenue: true,
  TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: false, IsNonRecoverable: false }], ...over,
})
const body = (...rows: unknown[]) => ({ Id: 'x', Status: 'OK', ProviderName: 'p', DateTimeUTC: '/Date(1)/', TaxRates: rows })
const refused = (b: unknown) => { const r = parseXeroTaxRateList(b); assert.equal(r.ok, false, String(JSON.stringify(b)).slice(0, 200)); return r.ok ? '' : r.reason }

test('a well-formed body is read exactly: every field kept, decimals as six-place text, absent optional fields as null', () => {
  const r = parseXeroTaxRateList(body(row(), { Name: 'Zero', TaxType: 'NONE', Status: 'ACTIVE', TaxComponents: [{ Name: 'Zero', Rate: 0 }] }))
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.rows[0], {
    taxType: 'OUTPUT2', name: 'Standard VAT', status: 'ACTIVE', reportTaxType: 'OUTPUT2', effectiveRate: '20.000000', displayTaxRate: '20.000000',
    components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true },
  })
  assert.deepEqual(r.rows[1], {
    taxType: 'NONE', name: 'Zero', status: 'ACTIVE', reportTaxType: null, effectiveRate: null, displayTaxRate: null,
    components: [{ name: 'Zero', rate: '0.000000', compound: false, nonRecoverable: false }], canApply: { assets: null, equity: null, expenses: null, liabilities: null, revenue: null },
  })
  assert.equal(parseXeroTaxRateList({ TaxRates: [row()] }).ok, true, 'the envelope fields are optional')
})

// [mutation: the empty-list refusal removed]
test('an empty list, a body that is not the list and an oversized list are refused as a whole', () => {
  refused(body())
  refused({ TaxRates: [] })
  for (const b of [null, undefined, 'TaxRates', 7, [], [row()], {}, { TaxRates: null }, { TaxRates: {} }, { TaxRates: 'x' }, { Accounts: [row()] }]) refused(b)
  refused(body(...Array.from({ length: XERO_TAX_RATE_LIST_MAX_ROWS + 1 }, (_, i) => row({ TaxType: `T${i}` }))))
  refused({ Status: 'ERROR', TaxRates: [row()] })
})

// [mutation: the unknown key kept instead of dropped / not reported]
test('an unknown key at the body, row or component level is DROPPED (not stored, not digested) and reported by NAME only', () => {
  const plain = parseXeroTaxRateList(body(row()))
  const noisy = parseXeroTaxRateList({ ...body(row({ Surprise: 'secret-value', TaxComponents: [{ Name: 'VAT', Rate: 20, Extra: 'secret-component' }] })), Pagination: { page: 2 } })
  assert.ok(plain.ok && noisy.ok)
  if (!plain.ok || !noisy.ok) return
  assert.deepEqual(noisy.rows, plain.rows, 'the rows are exactly what they would have been without the unknown keys')
  assert.equal(digestTaxRateList('t', noisy.rows), digestTaxRateList('t', plain.rows), 'and so is the digest')
  assert.deepEqual(noisy.ignored, { body: ['Pagination'], row: ['Surprise'], component: ['Extra'] })
  assert.ok(!JSON.stringify(noisy.ignored).includes('secret'), 'names only, never values')
  assert.deepEqual(plain.ignored, { body: [], row: [], component: [] })
  const odd = parseXeroTaxRateList(body(row({ ['x\u0007y'.repeat(30)]: 1 })))
  assert.ok(odd.ok && odd.ignored.row[0]!.length <= 40 && /^[\x20-\x7e]+$/.test(odd.ignored.row[0]!), 'a name is printable and truncated')
})

// [mutation: the variant-of-a-known-key check removed (any level)]
test('a case or punctuation variant of a KNOWN key is not "unknown": it could shadow the real field, so the whole body is refused', () => {
  for (const variant of ['taxtype', 'TAXTYPE', 'Tax_Type', 'tax-type', 'name', 'STATUS', 'taxcomponents', 'Report_Tax_Type', 'canapplytorevenue', 'effectiverate']) {
    assert.match(refused(body(row({ [variant]: 'OUTPUT9' }))), /variant of a known field/, `row ${variant}`)
  }
  assert.match(refused(body(row({ TaxComponents: [{ Name: 'VAT', Rate: 20, rate: 5 }] }))), /variant of a known field/, 'component rate')
  assert.match(refused(body(row({ TaxComponents: [{ Name: 'VAT', Rate: 20, is_compound: true }] }))), /variant/, 'component IsCompound')
  assert.match(refused({ ...body(row()), taxrates: [] }), /variant of a known field/, 'body TaxRates')
  assert.match(refused({ ...body(row()), status: 'ERROR' }), /variant/, 'body Status')
  // A variant is refused even when the real key is absent (it would stand in for it).
  const { TaxType: _gone, ...withoutType } = row()
  void _gone
  refused(body({ ...withoutType, taxtype: 'OUTPUT2' }))
})

// [mutation: one validator removed per line]
test('a malformed field in ANY row refuses the whole body: one bad row among good ones keeps none of them', () => {
  const bad: Array<Record<string, unknown>> = [
    { TaxType: '' }, { TaxType: 'has space' }, { TaxType: 5 }, { TaxType: null }, { TaxType: 'X'.repeat(65) }, { TaxType: undefined },
    { Name: '' }, { Name: '   ' }, { Name: 5 }, { Name: 'a\nb' }, { Name: 'x'.repeat(256) },
    { Status: 'active' }, { Status: 'UNKNOWN' }, { Status: undefined }, { Status: 1 },
    { ReportTaxType: '' }, { ReportTaxType: 5 }, { ReportTaxType: 'x'.repeat(65) },
    { EffectiveRate: '20' }, { EffectiveRate: -1 }, { EffectiveRate: 1001 }, { EffectiveRate: Number.NaN }, { EffectiveRate: Infinity }, { EffectiveRate: 20.1234567 }, { DisplayTaxRate: '20' }, { DisplayTaxRate: null },
    { CanApplyToAssets: 'false' }, { CanApplyToEquity: 0 }, { CanApplyToExpenses: null }, { CanApplyToLiabilities: 'yes' }, { CanApplyToRevenue: {} },
    { TaxComponents: undefined }, { TaxComponents: null }, { TaxComponents: {} }, { TaxComponents: 'x' }, { TaxComponents: [null] }, { TaxComponents: [[]] },
    { TaxComponents: [{ Name: '', Rate: 20 }] }, { TaxComponents: [{ Name: 'VAT' }] }, { TaxComponents: [{ Name: 'VAT', Rate: '20' }] }, { TaxComponents: [{ Name: 'VAT', Rate: -5 }] }, { TaxComponents: [{ Name: 'VAT', Rate: 20.0000001 }] },
    { TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: 'true' }] }, { TaxComponents: [{ Name: 'VAT', Rate: 20, IsNonRecoverable: 1 }] }, { TaxComponents: [{ Name: 5, Rate: 20 }] },
  ]
  for (const over of bad) refused(body(row({ TaxType: 'GOOD1' }), row(over), row({ TaxType: 'GOOD2' })))
  // A row that is not an object, and a class instance posing as one.
  refused(body(row(), 'OUTPUT2'))
  refused(body(row(), null))
  refused(body(row(), new (class Fake { Name = 'x' })()))
})

// [mutation: the duplicate TaxType check removed]
test('a TaxType named twice is refused (it would make "the" row for that type a guess)', () => {
  refused(body(row(), row({ Name: 'Other name' })))
})

test('rates are held exactly or refused: four places and six places pass, a seventh place and float noise do not', () => {
  assert.equal(sixPlaceDecimal(16.6667), '16.666700')
  assert.equal(sixPlaceDecimal(0.123456), '0.123456')
  assert.equal(sixPlaceDecimal(20), '20.000000')
  assert.equal(sixPlaceDecimal(0.1 + 0.2), null, '0.30000000000000004 is not six places')
  assert.equal(sixPlaceDecimal(-0), '0.000000')
  for (const bad of [-0.000001, 1000.000001, '5', null, undefined, true, 1e21, 1e-7]) assert.equal(sixPlaceDecimal(bad), null, String(bad))
})

test('parse is total: whatever it is given it returns a verdict and never throws, and names no value from the body', () => {
  const hostile = { get TaxRates(): unknown { throw new Error('hunter2') } }
  const r = parseXeroTaxRateList(hostile)
  assert.equal(r.ok, false)
  assert.ok(!JSON.stringify(r).includes('hunter2'))
  const long = refused(body(row({ ['Tax_Type'.padEnd(500, 'x')]: 1, TaxType: 5 })))
  assert.ok(long.length < 120)
  assert.ok(!refused(body(row({ Name: 'secret-name\n' }))).includes('secret-name'))
})

// ---- the digest ---------------------------------------------------------------------------------

const parsed = (...rows: unknown[]) => { const r = parseXeroTaxRateList(body(...rows)); assert.ok(r.ok); return r.ok ? r.rows : [] }

// [mutation: the digest ignores one field / the tenant / the order]
test('the digest depends on the organisation and on every stored field, and not on the order of the rows', () => {
  const rows = parsed(row(), row({ TaxType: 'INPUT2', Name: 'Input' }))
  const base = digestTaxRateList('tenant-A', rows)
  assert.match(base, /^[0-9a-f]{64}$/)
  assert.equal(digestTaxRateList('tenant-A', [...rows].reverse()), base, 'row order is not part of it')
  assert.notEqual(digestTaxRateList('tenant-B', rows), base, 'the organisation is')
  assert.notEqual(digestTaxRateList('tenant-A', rows.slice(0, 1)), base, 'a missing row is')
  assert.notEqual(digestTaxRateList('tenant-A', []), base)
  const edits: Array<Record<string, unknown>> = [
    { TaxType: 'OUTPUT9' }, { Name: 'Renamed' }, { Status: 'ARCHIVED' }, { ReportTaxType: 'INPUT' }, { EffectiveRate: 19 }, { DisplayTaxRate: 19 }, { CanApplyToAssets: true }, { CanApplyToEquity: true }, { CanApplyToExpenses: true }, { CanApplyToLiabilities: true }, { CanApplyToRevenue: false },
    { TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: true }] }, { TaxComponents: [{ Name: 'VAT', Rate: 20, IsNonRecoverable: true }] }, { TaxComponents: [{ Name: 'VAT2', Rate: 20 }] }, { TaxComponents: [{ Name: 'VAT', Rate: 19.5 }] },
    { TaxComponents: [{ Name: 'VAT', Rate: 10 }, { Name: 'VAT', Rate: 10 }] },
  ]
  for (const edit of edits) assert.notEqual(digestTaxRateList('tenant-A', [...parsed(row(edit)), ...rows.slice(1)]), base, JSON.stringify(edit))
  // An absent optional field and a present false one are different data.
  const absent = parsed(row({ CanApplyToAssets: undefined }))
  assert.notEqual(digestTaxRateList('t', absent), digestTaxRateList('t', parsed(row())))
  // The ordering is by code point, so it cannot depend on a locale.
  assert.equal(digestTaxRateList('t', parsed(row({ TaxType: 'a' }), row({ TaxType: 'B' }))), digestTaxRateList('t', parsed(row({ TaxType: 'B' }), row({ TaxType: 'a' }))))
})

test('stored components are re-validated exactly as they were stored', () => {
  assert.deepEqual(readStoredComponents([{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: true }]), [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: true }])
  assert.deepEqual(readStoredComponents([]), [])
  for (const bad of [null, {}, 'x', [null], [{ name: 'VAT' }], [{ name: 'VAT', rate: 20, compound: false, nonRecoverable: false }], [{ name: 'VAT', rate: '20', compound: false, nonRecoverable: false }], [{ name: 'VAT', rate: '20.000000', compound: 'no', nonRecoverable: false }], [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false, extra: 1 }], [{ name: 'V', rate: '-1.000000', compound: false, nonRecoverable: false }]]) {
    assert.equal(readStoredComponents(bad), null, JSON.stringify(bad))
  }
})

// ---- the drift view -------------------------------------------------------------------------------

test('the drift comparison sees the list as it always did: no DELETED or ARCHIVED rate, components in percent', () => {
  const view = driftViewOfList(parsed(row(), row({ TaxType: 'D', Status: 'DELETED' }), row({ TaxType: 'A', Status: 'ARCHIVED' }), row({ TaxType: 'P', Name: 'Pending', Status: 'PENDING' }), row({ TaxType: 'C', Name: 'Compound', TaxComponents: [{ Name: 'a', Rate: 5 }, { Name: 'b', Rate: 7.5, IsCompound: true }] })))
  assert.deepEqual(view.map((rate) => rate.Name), ['Standard VAT', 'Pending', 'Compound'])
  assert.deepEqual(view[2]!.TaxComponents, [{ Name: 'a', Rate: 5, IsCompound: false, IsNonRecoverable: false }, { Name: 'b', Rate: 7.5, IsCompound: true, IsNonRecoverable: false }])
})
