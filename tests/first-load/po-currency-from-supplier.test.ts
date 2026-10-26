/**
 * Owner rulings (2026-10-25) on the first-load purchase orders:
 *   1. A PO's currency is its SUPPLIER's, taken from the supplier row with the same name in the SAME run's suppliers dataset. The Qoblex Incoming report has no currency
 *      column and the pinned map carries no supplier-to-currency or currency-to-rate table. (A PO whose currency differs from its supplier's cannot arise, so nothing refuses it.)
 *   2. A foreign PO's rate comes only from fx_rates (the ims-fx-rates list), through the central rule, as of the END of the PO's created day (UTC). A missing rate refuses.
 *
 * Every arm names the mutation that turns it red; each arm prints how many cases it examined and fails when it examined none.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ingestDataset, parseColumnMap } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, loadFixtureDatasets, precondition, product, rowsOf, run, runBare } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')

const RATES = [
  { currency: 'USD', rate: '1.30', fetchedAt: '2026-09-23T06:00:00Z' },
  { currency: 'USD', rate: '1.25', fetchedAt: '2026-09-24T06:00:00Z' },
  { currency: 'USD', rate: '1.20', fetchedAt: '2026-09-25T00:00:00Z' },
  { currency: 'EUR', rate: '1.15', fetchedAt: '2026-09-24T23:30:00Z' },
]
const SUPPLIERS = [{ name: 'Sup USD', currency: 'USD' }, { name: 'Sup EUR', currency: 'EUR' }, { name: 'Sup GBP', currency: 'GBP' }]
const line = (orderKey: string, supplierName: string, extra: Record<string, string> = {}) => ({ orderKey, supplierName, sku: 'A', qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3', ...extra })
const po = (lines: Array<Record<string, string>>, rates: Array<Record<string, string>> | null = RATES, suppliers: Array<Record<string, string>> | null = SUPPLIERS) => runBare({
  products: ds('products', [product('A')]),
  ...(suppliers ? { suppliers: ds('suppliers', suppliers) } : {}),
  ...(rates ? { 'ims-fx-rates': ds('ims-fx-rates', rates) } : {}),
  'purchase-order-lines': ds('purchase-order-lines', lines),
})
const rejectedCodes = (r: ReturnType<typeof run>) => dispositionCodes(r, 'purchase-order-lines', 'REJECTED')

// [mutation: read the currency from anything but the supplier row (a constant, the file, a map), or from the wrong row]
test('the order currency is its supplier\'s: USD, EUR and GBP suppliers give USD, EUR and GBP orders (base: rate 1, no date or list needed)', (t) => {
  const r = po([line('O-USD', 'Sup USD', { createdOn: '2026-09-24' }), line('O-EUR', 'sup eur', { createdOn: '2026-09-25' }), line('O-GBP', 'SUP GBP')])
  const rows = rowsOf(r, 'purchase-orders')
  precondition(t, 'orders', rows.length)
  assert.deepEqual(r.report.verdict, 'PASS')
  assert.deepEqual(rows.map((x) => [x.orderKey, x.supplierName, x.currency, x.fxRateToBase]), [
    ['T-O-EUR', 'Sup EUR', 'EUR', '1.15'],
    ['T-O-GBP', 'Sup GBP', 'GBP', '1'],
    ['T-O-USD', 'Sup USD', 'USD', '1.25'],
  ])
})

// [mutation: drop the SUPPLIER_NOT_IN_FILE reject, or fall back to the IMS supplier list / the base currency]
test('an unknown supplier is rejected SUPPLIER_NOT_IN_FILE, also one that exists only in the IMS supplier list; a rejected supplier row rejects its orders', (t) => {
  const unknown = po([line('O1', 'Nobody', { createdOn: '2026-09-24' })])
  const imsOnly = runBare({ products: ds('products', [product('A')]), 'ims-suppliers': ds('ims-suppliers', [{ name: 'Sup USD' }]), 'purchase-order-lines': ds('purchase-order-lines', [line('O1', 'Sup USD', { createdOn: '2026-09-24' })]) })
  const rejectedSupplier = po([line('O1', 'Acme')], RATES, [{ name: 'Acme', currency: 'USD' }, { name: 'ACME', currency: 'USD' }])
  const badCurrencySupplier = po([line('O1', 'Bad')], RATES, [{ name: 'Bad', currency: 'ZZ' }])
  precondition(t, 'cases', 4)
  assert.deepEqual(rejectedCodes(badCurrencySupplier), ['SUPPLIER_NOT_IN_FILE'], 'a supplier row that cannot be read is not in the file')
  assert.deepEqual(rejectedCodes(unknown), ['SUPPLIER_NOT_IN_FILE'])
  assert.deepEqual(rejectedCodes(imsOnly), ['SUPPLIER_NOT_IN_FILE'])
  assert.deepEqual(rejectedCodes(rejectedSupplier), ['SUPPLIER_ROW_REJECTED'])
  assert.deepEqual(rowsOf(unknown, 'purchase-orders'), [])
})

// [mutation: look the rate up at the latest row, at the start of the day, or at the order date's following day; or take the lowest/first row]
test('a foreign order\'s rate is the fx_rates row at the END of its created day (UTC): a row fetched late that day counts, one fetched at midnight after does not', (t) => {
  const rate = (createdOn: string, supplierName = 'Sup USD') => rowsOf(po([line('O', supplierName, { createdOn })]), 'purchase-orders')[0]?.fxRateToBase
  precondition(t, 'dates', 4)
  assert.equal(rate('2026-09-23'), '1.3')
  assert.equal(rate('2026-09-24'), '1.25', 'the 09-25T00:00 row is the next day\'s')
  assert.equal(rate('2026-09-25'), '1.2')
  assert.equal(rate('2026-09-24', 'Sup EUR'), '1.15', 'fetched 23:30 on the created day')
})

// [mutation: default a missing rate to 1 or to a stale row, let a file rate in, or skip the zero-row refusal]
test('a missing or unusable rate rejects the order with a named code (never a default, never an older row)', (t) => {
  const cases: Array<[string, ReturnType<typeof run>, string]> = [
    ['created before the first row', po([line('O', 'Sup USD', { createdOn: '2026-09-22' })]), 'FX_RATE_MISSING'],
    ['currency absent from the list', po([line('O', 'Sup USD', { createdOn: '2026-09-24' })], [{ currency: 'EUR', rate: '1.1', fetchedAt: '2026-09-01T00:00:00Z' }]), 'FX_RATE_MISSING'],
    ['no list at all', po([line('O', 'Sup USD', { createdOn: '2026-09-24' })], null), 'FX_RATES_NOT_SUPPLIED'],
    ['a zero row on the day (an older good row is not the rate)', po([line('O', 'Sup USD', { createdOn: '2026-09-24' })], [...RATES.slice(0, 1), { currency: 'USD', rate: '0', fetchedAt: '2026-09-24T01:00:00Z' }]), 'FX_RATE_UNUSABLE'],
    ['two different rates at one instant', po([line('O', 'Sup USD', { createdOn: '2026-09-24' })], [...RATES.slice(0, 2), { currency: 'USD', rate: '1.26', fetchedAt: '2026-09-24T06:00:00Z' }]), 'FX_RATE_UNUSABLE'],
    ['more than 8 decimal places', po([line('O', 'Sup USD', { createdOn: '2026-09-24' })], [{ currency: 'USD', rate: '1.234567891', fetchedAt: '2026-09-24T01:00:00Z' }]), 'FX_RATE_UNUSABLE'],
    ['no created date', po([line('O', 'Sup USD', { createdOn: '' })]), 'MISSING_CREATED_DATE'],
    ['a created date that is not a date', po([line('O', 'Sup USD', { createdOn: '2026-02-30' })]), 'BAD_DATE'],
  ]
  precondition(t, 'cases', cases.length)
  for (const [name, result, code] of cases) {
    assert.deepEqual(rejectedCodes(result), [code], name)
    assert.deepEqual(rowsOf(result, 'purchase-orders'), [], name)
    assert.equal(result.blocking, true, name)
  }
})

test('a base-currency order needs no created date and no rate list; a bad row in the rate list is itself rejected', (t) => {
  const base = po([line('O', 'Sup GBP')], null)
  const badList = po([line('O', 'Sup GBP')], [{ currency: 'USD', rate: 'abc', fetchedAt: '2026-09-24T01:00:00Z' }, { currency: 'USD', rate: '1', fetchedAt: '2026-09-24' }, { currency: 'GBP', rate: '1', fetchedAt: '2026-09-24T01:00:00Z' }])
  precondition(t, 'cases', 2)
  assert.equal(base.blocking, false)
  assert.deepEqual(rowsOf(base, 'purchase-orders').map((x) => [x.currency, x.fxRateToBase]), [['GBP', '1']])
  assert.deepEqual(dispositionCodes(badList, 'ims-fx-rates', 'REJECTED').sort(), ['BAD_FETCHED_AT', 'BAD_RATE', 'BASE_CURRENCY_RATE'])
})

// [mutation: put a currency/rate table, a derived entry or a currency constant back into the map; or accept currency/fxRateToBase columns in a canonical PO file]
test('the pinned incoming-stock map has no currency, supplier or rate table; and the dataset has no currency or rate column to carry one', (t) => {
  const text = readFileSync(path.join(NATIVE, 'maps', 'qoblex-incoming-stock.map.json'), 'utf8')
  const mapping = parseColumnMap(text, 'm.json').datasets['purchase-order-lines']!
  precondition(t, 'checks', 6)
  assert.deepEqual(Object.keys(mapping.valueMaps), ['status'])
  assert.deepEqual(mapping.derived, {})
  assert.deepEqual(Object.keys(mapping.constants), ['destinationWarehouseCode'])
  assert.ok(!('currency' in mapping.columns) && !('fxRateToBase' in mapping.columns))
  assert.equal(mapping.columns.createdOn, 'Created on')
  assert.ok(!/Supplier (Alpha|Beta|Gamma)|"USD"|"EUR"|"GBP"|1\.25|1\.15|fxRateToBase/.test(text), 'no synthetic supplier, currency or rate in the map text')
  // a map that tries to bring them back is refused (the columns do not exist)
  const withCurrency = text.replace('"createdOn": "Created on"', '"createdOn": "Created on",\n        "currency": "Currency"')
  assert.throws(() => parseColumnMap(withCurrency, 'm.json'), /currency/)
  // and so is a canonical file that carries a rate column
  const csv = new TextEncoder().encode('orderKey,supplierName,sku,qtyOrdered,qtyReceived,unitCostForeign,fxRateToBase\nO,S,A,1,0,1,1.25\n')
  const refused = (() => { try { return ingestDataset('purchase-order-lines', csv, 'x.csv', null) } catch (e) { return e } })()
  assert.ok(refused instanceof Error || ('rejected' in (refused as object) && (refused as { rejected: unknown[] }).rejected.length > 0), 'a file rate column is not accepted')
})

test('the native Qoblex fixture prepares over the real export shape: supplier currencies USD/GBP/EUR, rates from the fx list at each Created on date', (t) => {
  const datasets = loadFixtureDatasets(NATIVE)
  // The native fixture as shipped is blocked for variants with no parent; the purchase orders are judged on their own rows.
  const r = run({ suppliers: datasets.suppliers, 'ims-tax-rates': datasets['ims-tax-rates'], 'ims-fx-rates': datasets['ims-fx-rates'], 'purchase-order-lines': datasets['purchase-order-lines'], products: ds('products', ['SYN-1001', 'SYN-1002', 'SYN-3001', 'SYN-3002'].map((s) => product(s))) })
  const rows = rowsOf(r, 'purchase-orders')
  precondition(t, 'rows', rows.length)
  assert.deepEqual(rows.map((x) => [x.orderKey, x.supplierName, x.currency, x.fxRateToBase]), [
    ['T-PO900', 'Supplier Alpha', 'USD', '1.25'],
    ['T-PO900', 'Supplier Alpha', 'USD', '1.25'],
    ['T-PO901', 'Supplier Gamma', 'EUR', '1.15'],
  ])
})

// Local smoke over the owner's real export. Counts and reasons only; never committed data. Skipped (and said so) when the files are not on this machine.
test('local smoke: the real Incoming export with the real supplier file (counts and reasons only)', { skip: !(existsSync('/var/tmp/qoblex-incoming-2026-10-25.csv') && existsSync('/var/tmp/fl-sup-real-contacts.csv')) && 'the owner\'s real export is not on this machine' }, (t) => {
  // The PINNED map as shipped (Approved/PartiallyReceived -> OPEN, Closed -> CLOSED), unmodified.
  const map = parseColumnMap(readFileSync(path.join(NATIVE, 'maps', 'qoblex-incoming-stock.map.json'), 'utf8'), 'm.json').datasets['purchase-order-lines']!
  const incoming = ingestDataset('purchase-order-lines', readFileSync('/var/tmp/qoblex-incoming-2026-10-25.csv'), 'incoming.csv', map)
  const supMap = parseColumnMap(readFileSync(path.join(NATIVE, 'maps', 'qoblex-contacts.map.json'), 'utf8'), 'c.json').datasets.suppliers!
  const suppliers = ingestDataset('suppliers', readFileSync('/var/tmp/fl-sup-real-contacts.csv'), 'contacts.csv', supMap)
  precondition(t, 'incoming records', incoming.recordsRead)
  const skus = [...new Set(incoming.rows.map((x) => x.values.sku))]
  const currencies = new Set(suppliers.rows.map((x) => x.values.currency))
  const rates = [...currencies].filter((c) => c !== 'GBP' && c !== '').map((c) => ({ currency: c, rate: '1.2', fetchedAt: '2000-01-01T00:00:00Z' }))
  const r = runBare({ products: ds('products', skus.map((s) => product(s))), suppliers, ...(rates.length ? { 'ims-fx-rates': ds('ims-fx-rates', rates) } : {}), 'purchase-order-lines': incoming })
  const tally = (outcome: string) => Object.fromEntries([...dispositionCodes(r, 'purchase-order-lines', outcome as 'REJECTED').reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())])
  t.diagnostic(`map-level rejects ${incoming.rejected.length} ${JSON.stringify(Object.fromEntries(incoming.rejected.reduce((m, x) => m.set(JSON.stringify((x as { code?: string }).code ?? 'unknown'), (m.get(JSON.stringify((x as { code?: string }).code ?? 'unknown')) ?? 0) + 1), new Map<string, number>())))}`)
  t.diagnostic(`incoming records ${incoming.recordsRead}, supplier records ${suppliers.recordsRead}, supplier currencies ${[...currencies].sort().join('/')}`)
  t.diagnostic(`rejected by code ${JSON.stringify(tally('REJECTED'))}; excluded by code ${JSON.stringify(tally('EXCLUDED'))}; emitted PO lines ${r.report.accountingByCode.filter((x) => x.dataset === 'purchase-order-lines' && x.outcome === 'EMITTED').reduce((n, x) => n + x.count, 0)}; orders ${r.report.purchaseOrders?.orders}; supplier rejects ${JSON.stringify(tally('REJECTED'))}; blocking ${r.blocking}`)
  assert.ok(true)
})
