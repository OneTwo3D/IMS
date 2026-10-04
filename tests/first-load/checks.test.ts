/**
 * The remaining checks of the first-load transform: normalisation and collisions, duplicates, decimals, currency, recipes,
 * open purchase orders, R14 coverage, load order and configuration. Table-driven; every table prints its case count.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError } from '../../lib/first-load/transform.ts'
import { parseCsv } from '../../lib/csv.ts'
import { dispositionCodes, ds, findingCodes, loadFixtureDatasets, lot, precondition, product, rowsOf, run } from './helpers.ts'

const rejectedCodes = (result: ReturnType<typeof run>, dataset: string) => dispositionCodes(result, dataset, 'REJECTED')

test('SKU normalisation: outer whitespace is trimmed and other datasets resolve case-insensitively to the catalogue spelling', (t) => {
  const result = run({
    products: ds('products', [product(' Mixed-Case ')]),
    'stock-lots': ds('stock-lots', [lot('MIXED-CASE', '4', '2'), lot('  mixed-case', '1', '2', { warehouseCode: 'OVER' })]),
  })
  precondition(t, 'stock rows resolved', 2)
  assert.equal(result.blocking, false)
  assert.deepEqual(rowsOf(result, 'products').map((r) => r.sku), ['Mixed-Case'])
  assert.deepEqual(rowsOf(result, 'opening-stock').map((r) => [r.sku, r.warehouseCode]), [['Mixed-Case', 'MAIN'], ['Mixed-Case', 'OVER']])
})

test('SKU collisions, forbidden characters and "#" are rejected, and ALL colliding rows are rejected (no arbitrary winner)', (t) => {
  const collision = run({ products: ds('products', [product('abc'), product('ABC'), product('other')]) })
  const bad = run({ products: ds('products', [product('#hash'), product('with\u00a0nbsp'), product('ok')]) })
  precondition(t, 'collision cases', 2)
  assert.deepEqual(rejectedCodes(collision, 'products'), ['SKU_CASE_COLLISION', 'SKU_CASE_COLLISION'])
  assert.deepEqual(rejectedCodes(bad, 'products'), ['BAD_SKU', 'BAD_SKU'])
  assert.equal(collision.blocking && bad.blocking, true)
})

test('duplicate keys: identical duplicates collapse, conflicting duplicates are all rejected', (t) => {
  const identical = run({ products: ds('products', [product('A'), product('A')]), suppliers: ds('suppliers', [{ name: 'Acme' }, { name: 'Acme' }]) })
  const conflicting = run({ products: ds('products', [product('A'), product('A', 'SIMPLE', { name: 'Different' })]), suppliers: ds('suppliers', [{ name: 'Acme', currency: 'GBP' }, { name: 'acme', currency: 'EUR' }]) })
  precondition(t, 'duplicate groups', 4)
  assert.equal(identical.blocking, false)
  assert.deepEqual(dispositionCodes(identical, 'products', 'EXCLUDED'), ['DUPLICATE_ROW'])
  assert.equal(rowsOf(identical, 'products').length, 1)
  assert.equal(rowsOf(identical, 'suppliers').length, 1, 'an exact duplicate supplier row loads once')
  assert.deepEqual(rejectedCodes(conflicting, 'products'), ['DUPLICATE_SKU_CONFLICT', 'DUPLICATE_SKU_CONFLICT'])
  assert.deepEqual(rejectedCodes(conflicting, 'suppliers'), ['DUPLICATE_SUPPLIER_CONFLICT', 'DUPLICATE_SUPPLIER_CONFLICT'])
})

test('a barcode shared by two products rejects both (the importer would refuse the second)', (t) => {
  const result = run({ products: ds('products', [product('A', 'SIMPLE', { barcode: '5000000000011' }), product('B', 'SIMPLE', { barcode: '5000000000011' }), product('C')]) })
  precondition(t, 'barcode groups', 1)
  assert.deepEqual(rejectedCodes(result, 'products'), ['DUPLICATE_BARCODE', 'DUPLICATE_BARCODE'])
})

test('decimals: commas, thousands separators, exponents, over-precision and negatives are rejected with a reason, never guessed', (t) => {
  const cases: Array<[string, string]> = [
    ['1,5', 'decimal comma'],
    ['1,000.50', 'thousands separator'],
    ['1e3', 'not a plain decimal'],
    ['.5', 'not a plain decimal'],
    ['+4', 'not a plain decimal'],
    ['4 pcs', 'not a plain decimal'],
    ['1.1234567', 'more than 6 decimal places'],
    ['123456789', 'more than 8 integer digits'],
    ['-1', 'negative'],
  ]
  precondition(t, 'bad numbers', cases.length)
  for (const [qty, expected] of cases) {
    const result = run({ products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', [lot('A', qty, '1')]) })
    const reason = result.report.dispositions.find((d) => d.dataset === 'stock-lots' && d.outcome === 'REJECTED')?.reason ?? ''
    assert.ok(reason.includes(expected) || (qty === '-1' && reason.includes('negative')), `${qty}: ${reason}`)
    assert.equal(result.blocking, true, qty)
  }
})

test('decimals: unit costs beyond 15 significant digits (a double would round them) are rejected on purchase orders', (t) => {
  precondition(t, 'cases', 1)
  const result = run({
    products: ds('products', [product('A')]),
    'purchase-order-lines': ds('purchase-order-lines', [{ orderKey: 'O1', supplierName: 'S', sku: 'A', qtyOrdered: '1', qtyReceived: '0', unitCostForeign: '1234567890.5', currency: 'GBP' }]),
  })
  assert.deepEqual(rejectedCodes(result, 'purchase-order-lines'), ['BAD_UNIT_COST'])
})

test('currency: fxRateToBase is required for a non-base currency on lots and on purchase orders; for the base it must be 1 or blank', (t) => {
  const stock = (extra: Record<string, string>) => run({ products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', [lot('A', '1', '2', extra)]) })
  const po = (extra: Record<string, string>) => run({
    products: ds('products', [product('A')]),
    'purchase-order-lines': ds('purchase-order-lines', [{ orderKey: 'O1', supplierName: 'S', sku: 'A', qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '1', currency: 'GBP', ...extra }]),
  })
  precondition(t, 'cases', 6)
  assert.deepEqual(rejectedCodes(stock({ currency: 'EUR' }), 'stock-lots'), ['BAD_FX'])
  assert.deepEqual(rejectedCodes(stock({ currency: 'GBP', fxRateToBase: '2' }), 'stock-lots'), ['BAD_FX'])
  assert.deepEqual(rejectedCodes(stock({ currency: 'EUR', fxRateToBase: '0' }), 'stock-lots'), ['BAD_FX'])
  assert.deepEqual(rejectedCodes(po({ currency: 'USD' }), 'purchase-order-lines'), ['BAD_FX'])
  assert.deepEqual(rejectedCodes(po({ currency: 'gb' }), 'purchase-order-lines'), ['BAD_CURRENCY'])
  const ok = stock({ currency: 'EUR', fxRateToBase: '0.85' })
  assert.equal(ok.blocking, false)
  assert.equal(rowsOf(ok, 'opening-stock')[0].unitCostBase, '1.700000')
})

test('variants: a VARIANT needs a VARIABLE parent that is itself loaded; parentSku on anything else is refused', (t) => {
  const result = run({
    products: ds('products', [
      product('V1', 'VARIANT'),
      product('V2', 'VARIANT', { parentSku: 'SIMPLE-PARENT' }),
      product('SIMPLE-PARENT'),
      product('V3', 'VARIANT', { parentSku: 'EXCLUDED-PARENT' }),
      product('EXCLUDED-PARENT', 'VARIABLE'),
      product('S', 'SIMPLE', { parentSku: 'EXCLUDED-PARENT' }),
    ]),
    'sku-exclusions': ds('sku-exclusions', [{ sku: 'EXCLUDED-PARENT', reason: 'discontinued' }]),
  })
  precondition(t, 'variant cases', 4)
  assert.deepEqual(rejectedCodes(result, 'products').sort(), ['PARENT_ON_NON_VARIANT', 'VARIANT_PARENT_INVALID', 'VARIANT_PARENT_INVALID', 'VARIANT_WITHOUT_PARENT'])
})

test('recipes: a KIT or BOM with no loadable lines, or no recipe dataset at all, blocks the run', (t) => {
  const none = run({ products: ds('products', [product('K', 'KIT'), product('P')]) })
  const empty = run({ products: ds('products', [product('K', 'KIT'), product('P')]), 'recipe-lines': ds('recipe-lines', [{ parentSku: 'OTHER', componentSku: 'P', qty: '1' }]) })
  precondition(t, 'cases', 2)
  assert.ok(findingCodes(none, 'ERROR').includes('RECIPES_NOT_SUPPLIED'))
  assert.ok(findingCodes(empty, 'ERROR').includes('NO_RECIPE_LINES'))
})

test('recipes: bad lines are rejected (unknown component, duplicate line, 5 decimals, non-recipe parent, delimiter in a SKU)', (t) => {
  const result = run({
    products: ds('products', [product('K', 'KIT'), product('P'), product('Q'), product('S;1')]),
    'recipe-lines': ds('recipe-lines', [
      { parentSku: 'K', componentSku: 'GHOST', qty: '1' },
      { parentSku: 'K', componentSku: 'P', qty: '1' },
      { parentSku: 'K', componentSku: 'P', qty: '2' },
      { parentSku: 'K', componentSku: 'Q', qty: '1.00001' },
      { parentSku: 'P', componentSku: 'Q', qty: '1' },
      { parentSku: 'K', componentSku: 'S;1', qty: '1' },
    ]),
  })
  const codes = rejectedCodes(result, 'recipe-lines').sort()
  precondition(t, 'rejected recipe lines', codes.length)
  assert.deepEqual(codes, ['BAD_QTY', 'COMPONENT_SKU_HAS_DELIMITER', 'DUPLICATE_RECIPE_LINE', 'DUPLICATE_RECIPE_LINE', 'PARENT_NOT_RECIPE_TYPE', 'SKU_NOT_IN_CATALOGUE'])
})

test('recipes: the components cell is ordered by sortOrder then SKU, and uses the catalogue spelling', (t) => {
  const result = run({
    products: ds('products', [product('Kit', 'KIT'), product('b-part'), product('A-PART'), product('c-part')]),
    'recipe-lines': ds('recipe-lines', [
      { parentSku: 'KIT', componentSku: 'B-PART', qty: '1' },
      { parentSku: 'KIT', componentSku: 'a-part', qty: '2.5' },
      { parentSku: 'KIT', componentSku: 'C-PART', qty: '3', sortOrder: '1' },
    ]),
  })
  precondition(t, 'recipe lines', 3)
  assert.equal(result.blocking, false)
  assert.equal(rowsOf(result, 'products').find((r) => r.sku === 'Kit')?.components, 'c-part:3;A-PART:2.5;b-part:1')
})

test('load order: parents and components never come after the rows that need them, whatever the input order', (t) => {
  const result = run({
    products: ds('products', [
      product('TABLE', 'BOM'), product('LEG', 'BOM'), product('V-1', 'VARIANT', { parentSku: 'PARENT' }),
      product('GIFT', 'KIT'), product('PARENT', 'VARIABLE'), product('BOARD'),
    ]),
    'recipe-lines': ds('recipe-lines', [
      { parentSku: 'TABLE', componentSku: 'LEG', qty: '4' }, { parentSku: 'LEG', componentSku: 'BOARD', qty: '1' },
      { parentSku: 'GIFT', componentSku: 'V-1', qty: '1' }, { parentSku: 'GIFT', componentSku: 'TABLE', qty: '1' },
    ]),
  })
  const order = rowsOf(result, 'products').map((r) => r.sku)
  precondition(t, 'products ordered', order.length)
  const at = (sku: string) => order.indexOf(sku)
  assert.ok(at('PARENT') < at('V-1'), 'a variant follows its parent')
  assert.ok(at('BOARD') < at('LEG') && at('LEG') < at('TABLE') && at('TABLE') < at('GIFT'), 'nested recipes follow their components')
  assert.ok(at('V-1') < at('GIFT'))
  assert.deepEqual(result.report.selfCheckFailures, [])
})

const poLine = (extra: Record<string, string>) => ({ orderKey: 'O1', supplierName: 'Acme', sku: 'A', qtyOrdered: '10', qtyReceived: '0', unitCostForeign: '2.5', currency: 'GBP', ...extra })

test('purchase orders: only the outstanding quantity is loaded, never negative, and anomalies are reported', (t) => {
  const result = run({
    products: ds('products', [product('A'), product('B'), product('C')]),
    suppliers: ds('suppliers', [{ name: 'Acme' }]),
    'purchase-order-lines': ds('purchase-order-lines', [
      poLine({ sku: 'A', qtyOrdered: '10', qtyReceived: '3.5' }),
      poLine({ sku: 'B', qtyOrdered: '4', qtyReceived: '4' }),
      poLine({ sku: 'C', qtyOrdered: '4', qtyReceived: '9' }),
    ]),
  })
  precondition(t, 'lines', 3)
  assert.deepEqual(rowsOf(result, 'purchase-orders').map((r) => [r.orderKey, r.sku, r.qty]), [['T-O1', 'A', '6.5']])
  assert.deepEqual(dispositionCodes(result, 'purchase-order-lines', 'EXCLUDED').sort(), ['FULLY_RECEIVED', 'OVER_RECEIVED'])
  assert.ok(findingCodes(result, 'WARNING').includes('PO_OVER_RECEIVED'))
  assert.equal(result.report.purchaseOrders.orders, 1)
})

test('purchase orders: inconsistent order-level fields, unknown suppliers, KIT lines and bad dates are rejected', (t) => {
  const inconsistent = run({
    products: ds('products', [product('A'), product('B')]),
    'purchase-order-lines': ds('purchase-order-lines', [poLine({ sku: 'A' }), poLine({ sku: 'B', currency: 'EUR', fxRateToBase: '0.9' })]),
  })
  const other = run({
    products: ds('products', [product('A'), product('K', 'KIT'), product('P')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'K', componentSku: 'P', qty: '1' }]),
    suppliers: ds('suppliers', [{ name: 'Acme' }]),
    'purchase-order-lines': ds('purchase-order-lines', [
      poLine({ orderKey: 'O2', supplierName: 'Nobody' }),
      poLine({ orderKey: 'O3', sku: 'K' }),
      poLine({ orderKey: 'O4', expectedDelivery: '2026-02-30' }),
    ]),
  })
  precondition(t, 'cases', 2)
  assert.deepEqual(rejectedCodes(inconsistent, 'purchase-order-lines'), ['INCONSISTENT_ORDER_FIELDS', 'INCONSISTENT_ORDER_FIELDS'])
  assert.deepEqual(rejectedCodes(other, 'purchase-order-lines').sort(), ['BAD_DATE', 'SUPPLIER_NOT_IN_FILE', 'TYPE_CANNOT_BE_PURCHASED'])
})

test('purchase orders: without a suppliers dataset the names are unchecked and the report says so', (t) => {
  const result = run({ products: ds('products', [product('A')]), 'purchase-order-lines': ds('purchase-order-lines', [poLine({})]) })
  precondition(t, 'lines', 1)
  assert.equal(result.blocking, false)
  assert.ok(findingCodes(result, 'WARNING').includes('SUPPLIER_NAMES_UNCHECKED'))
})

test('transfers: draft and fully received transfers are excluded; contradictory statuses and same-warehouse rows are rejected', (t) => {
  const base = { transferKey: 'T', status: 'IN_TRANSIT', fromWarehouseCode: 'MAIN', toWarehouseCode: 'OVER', sku: 'A', qtyShipped: '2', qtyReceived: '0' }
  const result = run({
    products: ds('products', [product('A')]),
    'stock-lots': ds('stock-lots', [lot('A', '9', '1')]),
    transfers: ds('transfers', [
      { ...base, transferKey: 'DRAFT1', status: 'DRAFT' },
      { ...base, transferKey: 'DONE', status: 'RECEIVED', qtyReceived: '2' },
      { ...base, transferKey: 'LIE', status: 'RECEIVED', qtyReceived: '1' },
      { ...base, transferKey: 'SAME', toWarehouseCode: 'MAIN' },
      { ...base, transferKey: 'OK' },
    ]),
  })
  precondition(t, 'transfer rows', 5)
  assert.deepEqual(dispositionCodes(result, 'transfers', 'EXCLUDED').sort(), ['FULLY_RECEIVED', 'NOT_IN_TRANSIT'])
  assert.deepEqual(rejectedCodes(result, 'transfers').sort(), ['SAME_WAREHOUSE', 'STATUS_CONTRADICTS_QUANTITY'])
})

test('transfers: lines of one transferKey that disagree are all rejected; a KIT cannot be transferred', (t) => {
  const base = { transferKey: 'T', status: 'IN_TRANSIT', fromWarehouseCode: 'MAIN', toWarehouseCode: 'OVER', qtyShipped: '1', qtyReceived: '0' }
  const result = run({
    products: ds('products', [product('A'), product('B'), product('K', 'KIT'), product('P')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'K', componentSku: 'P', qty: '1' }]),
    'stock-lots': ds('stock-lots', [lot('A', '5', '1'), lot('B', '5', '1')]),
    transfers: ds('transfers', [{ ...base, sku: 'A' }, { ...base, sku: 'B', toWarehouseCode: 'ELSEWHERE' }, { ...base, transferKey: 'T2', sku: 'K' }]),
  })
  precondition(t, 'transfer rows', 3)
  assert.deepEqual(rejectedCodes(result, 'transfers').sort(), ['INCONSISTENT_TRANSFER', 'INCONSISTENT_TRANSFER', 'TYPE_CANNOT_BE_TRANSFERRED'])
})

test('the exclusion list: needs a reason, flags stock it would drop, and a stale entry is a warning', (t) => {
  const stockDropped = run({
    products: ds('products', [product('KEEP'), product('DROP')]),
    'stock-lots': ds('stock-lots', [lot('DROP', '5', '1'), lot('KEEP', '1', '1')]),
    'sku-exclusions': ds('sku-exclusions', [{ sku: 'DROP', reason: 'written off' }, { sku: 'NEVER-SEEN', reason: 'old' }]),
  })
  const noReason = run({ 'sku-exclusions': ds('sku-exclusions', [{ sku: 'X', reason: '' }]) })
  precondition(t, 'cases', 2)
  assert.ok(findingCodes(stockDropped, 'ERROR').includes('EXCLUDED_SKU_HOLDS_STOCK'))
  assert.ok(findingCodes(stockDropped, 'WARNING').includes('STALE_EXCLUSION'))
  assert.deepEqual(rejectedCodes(noReason, 'sku-exclusions'), ['MISSING_REASON'])
  assert.deepEqual(rowsOf(stockDropped, 'opening-stock').length, 0, 'a blocked run has no files')
})

test('R14: a SKU in the 3PL or WooCommerce that is neither loaded nor excluded blocks; an IMS-existing or excluded SKU does not', (t) => {
  const result = run({
    products: ds('products', [product('A')]),
    'wms-products': ds('wms-products', [{ sku: 'A' }, { sku: 'M-ONLY' }, { sku: 'IN-IMS' }]),
    'woo-products': ds('woo-products', [{ sku: 'a' }, { sku: 'W-ONLY' }, { sku: 'W-EXCLUDED' }]),
    'ims-skus': ds('ims-skus', [{ sku: 'IN-IMS', type: 'SIMPLE' }]),
    'sku-exclusions': ds('sku-exclusions', [{ sku: 'W-EXCLUDED', reason: 'sample' }]),
  })
  precondition(t, 'SKUs subject to coverage', 6)
  const finding = result.report.findings.find((f) => f.code === 'R14_SKU_NOT_LOADED')
  assert.deepEqual(finding?.keys, ['M-ONLY (L)', 'W-ONLY (W)'])
  assert.deepEqual(result.report.coverage.excludedAccepted, ['W-EXCLUDED'])
  const noCatalogue = run({ 'wms-products': ds('wms-products', [{ sku: 'A' }]) })
  assert.ok(findingCodes(noCatalogue, 'ERROR').includes('R14_NEEDS_CATALOGUE'))
})

test('rows without a SKU or with a bad value are rejected on products; booleans and lifecycle are strict', (t) => {
  const result = run({
    products: ds('products', [
      product('NOBOOL', 'SIMPLE', { active: 'maybe' }),
      product('LIFE', 'SIMPLE', { lifecycleStatus: 'RETIRED' }),
      { sku: '', name: 'No sku', type: 'SIMPLE' },
      { sku: 'NOTYPE', name: 'x', type: 'WIDGET' },
      product('OKAY', 'SIMPLE', { active: 'yes', lifecycleStatus: 'active', weight: '0.5' }),
    ]),
  })
  precondition(t, 'product rows', 5)
  assert.deepEqual(rejectedCodes(result, 'products').sort(), ['BAD_BOOLEAN', 'BAD_LIFECYCLE', 'BAD_SKU', 'BAD_TYPE'])
})

test('configuration: a missing key prefix, convention or malformed base currency is refused before any row is read', (t) => {
  const withPo = { products: ds('products', [product('A')]), 'purchase-order-lines': ds('purchase-order-lines', [poLine({})]) }
  precondition(t, 'cases', 4)
  assert.throws(() => run(withPo, { purchaseOrderKeyPrefix: null }), ConfigError)
  assert.throws(() => run(withPo, { purchaseOrderKeyPrefix: 'bad prefix' }), ConfigError)
  assert.throws(() => run({ transfers: ds('transfers', [{ transferKey: 'T', status: 'DRAFT', fromWarehouseCode: 'A', toWarehouseCode: 'B', sku: 'x', qtyShipped: '1', qtyReceived: '0' }]) }, { inTransitConvention: null }), ConfigError)
  assert.throws(() => run({}, { baseCurrency: 'pound' }), ConfigError)
})

test('zero-cost opening stock is accepted but warned about', (t) => {
  const result = run({ products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', [lot('A', '3', '0')]) })
  precondition(t, 'groups', result.report.stock.groups.length)
  assert.equal(result.blocking, false)
  assert.ok(findingCodes(result, 'WARNING').includes('ZERO_COST_OPENING_STOCK'))
})

test('the report carries SKU-normalisation counts and the warehouse codes the files use (mixed fixture)', (t) => {
  const result = run(loadFixtureDatasets())
  const notes = result.report.findings.filter((f) => f.code === 'SKU_NORMALISED')
  precondition(t, 'normalisation notes', notes.length)
  const stock = notes.find((f) => f.dataset === 'stock-lots')
  assert.ok(stock?.message.includes('0 SKU cell(s) had outer whitespace trimmed and 2 were matched to the catalogue under a different letter case'), stock?.message)
  assert.deepEqual(result.report.warehouseCodesUsed, ['MAIN', 'OVER'])
  assert.ok(result.report.findings.every((f) => f.severity !== 'INFO' || f.code === 'SKU_NORMALISED'))
})

test('a CR or CRLF inside a quoted value is written as LF, which is exactly what the importers will read', (t) => {
  const result = run({ products: ds('products', [product('A', 'SIMPLE', { description: 'line one\r\nline two\rline three' })]) })
  precondition(t, 'products', 1)
  assert.equal(result.blocking, false)
  assert.deepEqual(result.report.selfCheckFailures, [])
  const parsed = parseCsv(result.outputs[0].content)
  assert.equal(parsed[0].description, 'line one\nline two\nline three')
})
