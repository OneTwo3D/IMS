/**
 * Owner rulings 2026-11-20 on the first load of the Qoblex exports (all fixtures synthetic):
 *   - rowSelect takes a list of selectors, every one of which must pass (and the single-object form still works);
 *   - State Archived loads as DRAFT (purchasable), Deleted is skipped from products and stock lots;
 *   - decisions lists: non-stock SKUs, SKU by product name, supplier currency/tax override, recipe override.
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { decisionSkuKey, ingestDataset, parseColumnMap, type DatasetMapping, type IngestDecisions } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, findingCodes, precondition, product, rowsOf, run } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const stockMap = parseColumnMap(readFileSync(path.join(NATIVE, 'maps', 'qoblex-stock-on-hand.map.json'), 'utf8'), 'qoblex-stock-on-hand.map.json')
const lines = readFileSync(path.join(NATIVE, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((l) => l !== '')
// the fixture's clean template row (synthetic): columns are Product, Sku, Barcode, State, Brand, Product Type, ...
const TEMPLATE = lines.find((l) => l.includes('"SYN-1001"'))!
const row = (sku: string, state: string, type: string, name = `Name of ${sku}`) =>
  TEMPLATE.replace('"Synthetic widget A","SYN-1001","","Active","Unknown","simple"', `"${name}","${sku}","","${state}","Unknown","${type}"`)
const csv = (...extra: string[]) => Buffer.from([lines[0], lines[1], ...extra, ''].join('\r\n'))
const products = (data: Buffer, decisions?: IngestDecisions) => ingestDataset('products', data, 's.csv', stockMap.datasets.products!, decisions)
const stock = (data: Buffer, decisions?: IngestDecisions) => ingestDataset('stock-lots', data, 's.csv', stockMap.datasets['stock-lots']!, decisions)

// A map with no header row of its own, to test rowSelect alone.
const smallMap = (rowSelect: unknown): DatasetMapping =>
  parseColumnMap(JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets: { products: { columns: { sku: 'S', name: 'N', type: 'T' }, rowSelect } } }), 'm').datasets.products!
const small = (rowSelect: unknown, rows: string[]) => ingestDataset('products', Buffer.from(['S,N,T,K,V', ...rows, ''].join('\r\n')), 'p.csv', smallMap(rowSelect))

// [mutation: only the first selector is applied, or any one selector passing is enough]
test('rowSelect list: a row must pass EVERY selector; a skip on any leaves it out; an unlisted value refuses it', (t) => {
  const sel = [{ column: 'T', keep: ['simple'], skip: ['kit'] }, { column: 'K', keep: ['Active'], skip: ['Deleted'] }]
  const r = small(sel, ['A,a,simple,Active,', 'B,b,kit,Active,', 'C,c,simple,Deleted,', 'D,d,simple,Weird,', 'E,e,odd,Deleted,', 'F,f,odd,Active,'])
  precondition(t, 'rows read or skipped', r.recordsRead + Object.values(r.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.deepEqual(r.rows.map((x) => x.values.sku), ['A'], 'pass: only the row that passes both is read')
  assert.deepEqual(r.rowsSkipped, { kit: 1, Deleted: 2 }, 'a skip on either selector counts; Deleted of an unlisted type is skipped, not refused')
  assert.deepEqual(r.rejected.map((x) => [x.code, x.line]).sort(), [['UNLISTED_ROW_KIND', 5], ['UNLISTED_ROW_KIND', 7]], 'fail: the unlisted State and the unlisted type are refused')
})

// [mutation: the single-object form stops parsing, or is parsed as a list of zero]
test('rowSelect single object (the original form) still works and a bad list is refused', (t) => {
  const single = { column: 'T', keep: ['simple'], skip: ['kit'] }
  const r = small(single, ['A,a,simple,x,', 'B,b,kit,x,', 'C,c,odd,x,'])
  precondition(t, 'rows read or skipped', r.recordsRead + Object.values(r.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.deepEqual(r.rows.map((x) => x.values.sku), ['A'])
  assert.deepEqual(r.rowsSkipped, { kit: 1 })
  assert.deepEqual(r.rejected.map((x) => x.code), ['UNLISTED_ROW_KIND'])
  assert.equal(smallMap(single).rowSelect?.length, 1)
  assert.throws(() => smallMap([]), /must not be an empty list/)
  assert.throws(() => smallMap([single, { ...single }]), /selected twice/)
})

// [mutation: Archived mapped to FALSE/EOL again, or dropped from the State list]
test('State Archived loads as a DRAFT product, Active as ACTIVE, Inactive as EOL; Deleted is skipped from products AND stock lots', (t) => {
  const data = csv(row('ST-ACT', 'Active', 'simple'), row('ST-ARC', 'Archived', 'simple'), row('ST-OFF', 'Inactive', 'simple'), row('ST-DEL', 'Deleted', 'simple'), row('ST-DELX', 'Deleted', 'Unknown'))
  const p = products(data)
  const s = stock(data)
  precondition(t, 'products read', p.recordsRead)
  const state = Object.fromEntries(p.rows.map((x) => [x.values.sku, x.values.lifecycleStatus]))
  assert.equal(state['ST-ACT'], 'ACTIVE')
  assert.equal(state['ST-ARC'], 'DRAFT')
  assert.equal(state['ST-OFF'], 'EOL')
  assert.ok(!('ST-DEL' in state) && !('ST-DELX' in state), 'Deleted is not a product')
  assert.equal(p.rowsSkipped.Deleted, 2)
  assert.ok(!s.rows.some((x) => x.values.sku.startsWith('ST-DEL')), 'Deleted is not a stock lot')
  assert.ok(s.rows.some((x) => x.values.sku === 'ST-ARC'), 'an Archived row still holds its stock')
  assert.equal(s.rowsSkipped.Deleted, 2)
  const made = run({ products: ds('products', [product('ST-ARC', 'SIMPLE', { lifecycleStatus: p.rows.find((x) => x.values.sku === 'ST-ARC')!.values.lifecycleStatus })]) })
  assert.equal(rowsOf(made, 'products')[0].lifecycleStatus, 'DRAFT')
})

// [mutation: PRODUCT_NOT_PURCHASABLE refuses DRAFT again]
test('a purchase order line on a DRAFT product is accepted; on an EOL product it is refused', (t) => {
  const line = (sku: string) => ({ orderKey: `O-${sku}`, supplierName: 'Sup', sku, qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3' })
  const result = run({
    products: ds('products', [product('DR', 'SIMPLE', { lifecycleStatus: 'DRAFT' }), product('EO', 'SIMPLE', { lifecycleStatus: 'EOL' })]),
    'purchase-order-lines': ds('purchase-order-lines', [line('DR'), line('EO')]),
  })
  precondition(t, 'order lines', result.report.inputs.find((i) => i.dataset === 'purchase-order-lines')?.recordsRead ?? 0)
  assert.deepEqual(dispositionCodes(result, 'purchase-order-lines', 'REJECTED'), ['PRODUCT_NOT_PURCHASABLE'])
  const onlyDraft = run({ products: ds('products', [product('DR', 'SIMPLE', { lifecycleStatus: 'DRAFT' })]), 'purchase-order-lines': ds('purchase-order-lines', [line('DR')]) })
  assert.equal(onlyDraft.blocking, false)
  assert.deepEqual(rowsOf(onlyDraft, 'purchase-orders').map((r) => r.orderKey), ['T-O-DR'])
})

// [mutation: the disagreement is silently resolved, or reported as INFO]
test('a Qoblex lifecycle that disagrees with the WooCommerce status of a VARIABLE product is a WARNING; agreement is silent', (t) => {
  const vp = (status: string) => ({ variantSku: 'M-01', wooVariationId: '11', parentSku: 'M', parentName: 'Parent M', parentStatus: status, wooParentId: '5001' })
  const disagree = run({ products: ds('products', [product('M', 'VARIABLE', { lifecycleStatus: 'DRAFT' }), product('M-01', 'VARIANT', { parentSku: 'M' })]), 'variant-parents': ds('variant-parents', [vp('publish')]) })
  const agree = run({ products: ds('products', [product('M', 'VARIABLE', { lifecycleStatus: 'DRAFT' }), product('M-01', 'VARIANT', { parentSku: 'M' })]), 'variant-parents': ds('variant-parents', [vp('draft')]) })
  precondition(t, 'runs examined', [disagree, agree].filter((x) => x.report.findings !== undefined).length)
  assert.ok(findingCodes(disagree, 'WARNING').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.ok(!findingCodes(agree).includes('LIFECYCLE_DISAGREES_WITH_WOO'))
})

const decisions = (nonStock: string[], byName: Array<[string, string]> = []): IngestDecisions => ({ nonStockSkus: new Set(nonStock.map(decisionSkuKey)), skuByName: new Map(byName) })

// [mutation: the nonStock overwrite is not applied, or applied after the row selection]
test('non-stock SKUs: a source row of type Unknown loads as NON_INVENTORY and its stock row is skipped, not refused; without the decision it is refused', (t) => {
  const data = csv(row('99992345678', 'Active', 'Unknown', 'Synthetic fee'))
  const without = products(data)
  const withIt = products(data, decisions([' 99992345678 ']))
  precondition(t, 'products records read', without.recordsRead + withIt.recordsRead)
  assert.equal(without.rows.length, 0)
  assert.equal(without.rejected[0]?.code, 'UNMAPPED_VALUE')
  assert.equal(withIt.rows[0].values.type, 'NON_INVENTORY')
  assert.equal(stock(data).rejected[0]?.code, 'UNLISTED_ROW_KIND')
  const lots = stock(data, decisions(['99992345678']))
  assert.equal(lots.rejected.length, 0)
  assert.equal(lots.rows.length, 0)
  assert.equal(lots.rowsSkipped['non-inventory'], 1)
})

// [mutation: a blank SKU is dropped silently, or the override matches a different name]
test('a row with stock and a blank SKU is refused naming the product; a sku-name-overrides entry supplies the SKU', (t) => {
  const blank = csv(row('', 'Active', 'simple', 'Synthetic kit without printed parts'))
  const plain = stock(blank)
  precondition(t, 'stock records read', plain.recordsRead)
  assert.equal(plain.rows.length, 0)
  assert.equal(plain.rejected[0].code, 'BLANK_SKU')
  assert.match(plain.rejected[0].reason, /Synthetic kit without printed parts/)
  const filled = stock(blank, decisions([], [['Synthetic kit without printed parts', 'SYN-KIT-03']]))
  assert.deepEqual([...new Set(filled.rows.map((r) => r.values.sku))], ['SYN-KIT-03'], 'one row per warehouse block, all with the supplied SKU')
  assert.equal(products(blank, decisions([], [['Synthetic kit without printed parts', 'SYN-KIT-03']])).rows[0].values.sku, 'SYN-KIT-03')
  assert.equal(stock(blank, decisions([], [['Another name', 'SYN-KIT-03']])).rejected[0].code, 'BLANK_SKU')
})

// [mutation: the override overwrites a stated value, or is not applied to a blank one]
test('supplier-overrides fill a blank currency and tax type; a different stated value is refused', (t) => {
  const blank = { name: 'Synthetic Supplier', currency: '', purchaseTaxType: '' }
  const filled = run({ suppliers: ds('suppliers', [blank]), 'supplier-overrides': ds('supplier-overrides', [{ name: 'synthetic supplier', currency: 'USD', purchaseTaxType: 'NONE', reason: 'owner' }]) })
  const conflict = run({ suppliers: ds('suppliers', [{ ...blank, currency: 'EUR', purchaseTaxType: 'NONE' }]), 'supplier-overrides': ds('supplier-overrides', [{ name: 'Synthetic Supplier', currency: 'USD', purchaseTaxType: '', reason: 'owner' }]) })
  const none = run({ suppliers: ds('suppliers', [blank]) })
  precondition(t, 'supplier rows loaded or refused', [filled, conflict, none].reduce((n, x) => n + x.report.dispositions.filter((d) => d.dataset === 'suppliers').length, 0))
  assert.equal(filled.blocking, false)
  assert.deepEqual([rowsOf(filled, 'suppliers')[0].currency, rowsOf(filled, 'suppliers')[0].purchaseTaxType], ['USD', 'NONE'])
  assert.deepEqual(dispositionCodes(conflict, 'suppliers', 'REJECTED'), ['SUPPLIER_OVERRIDE_CONFLICT'])
  assert.deepEqual(dispositionCodes(none, 'suppliers', 'REJECTED'), ['MISSING_CURRENCY'])
})

// [mutation: the override is merged with the export lines instead of replacing them]
test('recipe-overrides REPLACE a broken export recipe; an unknown component or a zero quantity is refused', (t) => {
  const base = { products: ds('products', [product('KIT-1', 'BOM'), product('C1'), product('C2'), product('C3')]) }
  const broken = ds('recipe-lines', [{ parentSku: 'KIT-1', componentSku: 'C1', qty: '1' }, { parentSku: 'KIT-1', componentSku: 'C1', qty: '1' }])
  const good = ds('recipe-overrides', [
    { parentSku: 'KIT-1', componentSku: 'C1', qty: '1', reason: 'owner' },
    { parentSku: 'KIT-1', componentSku: 'C2', qty: '4', reason: 'owner' },
    { parentSku: 'KIT-1', componentSku: 'C3', qty: '1', reason: 'owner' },
  ])
  const withExport = run({ ...base, 'recipe-lines': broken })
  const overridden = run({ ...base, 'recipe-lines': broken, 'recipe-overrides': good })
  const onlyOverride = run({ ...base, 'recipe-overrides': good })
  const bad = run({ ...base, 'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'KIT-1', componentSku: 'NOPE', qty: '1', reason: 'o' }, { parentSku: 'KIT-1', componentSku: 'C2', qty: '0', reason: 'o' }]) })
  precondition(t, 'recipe dispositions', [withExport, overridden, onlyOverride, bad].reduce((n, x) => n + x.report.dispositions.filter((d) => d.dataset.startsWith('recipe')).length, 0))
  assert.equal(withExport.blocking, true, 'the broken export alone blocks')
  assert.equal(overridden.blocking, false, 'the override wins')
  assert.deepEqual(dispositionCodes(overridden, 'recipe-lines', 'EXCLUDED'), ['REPLACED_BY_RECIPE_OVERRIDE', 'REPLACED_BY_RECIPE_OVERRIDE'])
  assert.equal(rowsOf(overridden, 'products').find((r) => r.sku === 'KIT-1')!.components, rowsOf(onlyOverride, 'products').find((r) => r.sku === 'KIT-1')!.components)
  assert.match(rowsOf(overridden, 'products').find((r) => r.sku === 'KIT-1')!.components, /C2:4/)
  assert.deepEqual(dispositionCodes(bad, 'recipe-overrides', 'REJECTED').sort(), ['BAD_QTY', 'SKU_NOT_IN_CATALOGUE'])
  assert.equal(bad.blocking, true)
})

// [mutation: the ghost rule drops a row when both are typed, or does not report the quantity]
test('ghost rows: a typed row and an Unknown row of one SKU keep the typed one and report the ghost with its quantity; two typed or two Unknown stay refused', (t) => {
  const withQty = (r: string, q: string) => r.replace('"15.000000","0.000000","15.000000"', `"${q}","0.000000","${q}"`)
  const typed = row('GH-1', 'Active', 'simple', 'Synthetic typed')
  const ghost = row('GH-1', 'Active', 'Unknown', 'Synthetic ghost')
  assert.ok(typed.includes('"15.000000","0.000000","15.000000"'), 'the fixture template carries the all-warehouses total')
  const data = csv(typed, withQty(ghost, '7.000000'))
  const lots = stock(data)
  const prods = products(data)
  precondition(t, 'stock records read or skipped', lots.recordsRead + Object.values(lots.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.deepEqual(prods.rows.map((r) => r.values.sku), ['GH-1'])
  assert.equal(prods.rejected.length, 0, 'the ghost is not refused as an unmapped type')
  assert.equal(lots.rowsSkipped['ghost row dropped'], 1)
  assert.equal(lots.notes?.[0].code, 'GHOST_ROW_DROPPED')
  assert.match(lots.notes![0].reason, /ghost row dropped.*quantity 7\.000000/)
  assert.ok(!lots.rejected.some((r) => r.code === 'DUPLICATE_SOURCE_ROW'))
  const twoTyped = stock(csv(row('GH-2', 'Active', 'simple'), row('GH-2', 'Active', 'variable')))
  assert.deepEqual(twoTyped.rejected.map((r) => r.code), ['DUPLICATE_SOURCE_ROW', 'DUPLICATE_SOURCE_ROW'])
  const twoGhosts = stock(csv(row('GH-3', 'Active', 'Unknown'), row('GH-3', 'Active', 'Unknown')))
  assert.deepEqual(twoGhosts.rejected.map((r) => r.code), ['DUPLICATE_SOURCE_ROW', 'DUPLICATE_SOURCE_ROW'])
  assert.equal(twoGhosts.notes?.length, 0)
})

// [mutation: the KIT decision does not suppress the stock, or the report line is missing]
test('a blank-SKU stock row mapped by override to a KIT: its on-hand is ignored and the report says why', (t) => {
  const kit = row('', 'Active', 'Unknown', 'Synthetic bundle')
  const d: IngestDecisions = { nonStockSkus: new Set(), skuByName: new Map([['Synthetic bundle', 'SYN-BUNDLE']]), typeByName: new Map([['Synthetic bundle', 'KIT']]) }
  const lots = stock(csv(kit), d)
  const prods = products(csv(kit), d)
  precondition(t, 'stock rows skipped', Object.values(lots.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.equal(lots.rows.length, 0, 'no stock lot for a KIT')
  assert.equal(lots.rejected.length, 0)
  assert.equal(lots.notes?.[0].code, 'KIT_STOCK_IGNORED')
  assert.match(lots.notes![0].reason, /SYN-BUNDLE.*KIT.*computed availability/)
  assert.equal(prods.rows[0].values.type, 'KIT')
  const result = run({ products: ds('products', [product('SYN-BUNDLE', 'KIT')]), 'stock-lots': lots })
  assert.ok(result.report.findings.some((f) => f.code === 'KIT_STOCK_IGNORED' && f.severity === 'INFO'))
})

// [mutation: the ghost grouping counts a row the map skips as the typed row (or as a ghost)]
test('ghost rows: a SKIPPED typed row (Deleted, or a skipped Product Type) never justifies dropping the Unknown row, which is refused as before', (t) => {
  const cases: Array<[string, string, string]> = [['Deleted typed row', 'Deleted', 'simple'], ['skipped Product Type (kit)', 'Active', 'kit'], ['skipped Product Type (non-inventory)', 'Active', 'non-inventory']]
  let examined = 0
  for (const [label, state, type] of cases) {
    const data = csv(row('GS-1', state, type, 'Synthetic typed'), row('GS-1', 'Active', 'Unknown', 'Synthetic unknown'))
    const lots = stock(data)
    examined += lots.recordsRead + Object.values(lots.rowsSkipped).reduce((n, c) => n + c, 0)
    assert.equal(lots.rowsSkipped['ghost row dropped'], undefined, `${label}: nothing is dropped as a ghost`)
    assert.equal(lots.notes?.length, 0, label)
    assert.deepEqual(lots.rejected.map((r) => r.code), ['UNLISTED_ROW_KIND'], `${label}: the Unknown row is refused, never silently lost`)
  }
  const prods = products(csv(row('GS-2', 'Deleted', 'simple'), row('GS-2', 'Active', 'Unknown')))
  examined += prods.recordsRead + Object.values(prods.rowsSkipped).reduce((n, c) => n + c, 0)
  precondition(t, 'rows read or skipped', examined)
  assert.equal(prods.rowsSkipped['ghost row dropped'], undefined)
  assert.deepEqual(prods.rejected.map((r) => r.code), ['UNMAPPED_VALUE'])
})
