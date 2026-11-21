/**
 * First-load P2 beads (all fixtures synthetic):
 *   - a DRAFT variation / KIT / BOM variation under a published WooCommerce parent blocks the run unless confirmed (Qoblex shape: no parent rows in the products file);
 *   - non-stock-skus fills only a blank / Unknown kind and refuses a stated stock-bearing type;
 *   - sku-renames never overrides a sku-exclusions entry.
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { decisionSkuKey, ingestDataset, parseColumnMap, type IngestDecisions } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, findingCodes, precondition, product, run } from './helpers.ts'

const emitted = (r: ReturnType<typeof run>, dataset: string, code: string): number => r.report.accountingByCode.filter((a) => a.dataset === dataset && a.outcome === 'EMITTED' && a.code === code).reduce((n, a) => n + a.count, 0)
const vp = (variant: string, parent: string, status: string) => ({ variantSku: variant, wooVariationId: '11', parentSku: parent, parentName: `Parent ${parent}`, parentStatus: status, wooParentId: '5001' })

// The Qoblex shape: the products file has variants and NO parent row; the parent comes from variant-parents.
const qoblex = (variantType: string, lifecycle: string, status: string, extra: Partial<Parameters<typeof run>[0]> = {}) =>
  run({
    products: ds('products', [product('P-01', variantType, { lifecycleStatus: lifecycle })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', status)]),
    ...extra,
  })

// [mutation: the variation check is removed (only providedParents is walked) or the ERROR is downgraded to WARNING]
test('o3d-e9m7q: an Archived (DRAFT) VARIANT under a published parent, with no parent row in the products file, blocks the run', (t) => {
  const bad = qoblex('VARIANT', 'DRAFT', 'publish')
  precondition(t, 'variations joined', emitted(bad, 'variant-parents', 'VARIATION_JOINED'))
  assert.ok(findingCodes(bad, 'ERROR').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.equal(bad.blocking, true)
  const agree = qoblex('VARIANT', 'DRAFT', 'draft')
  assert.ok(!findingCodes(agree).includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.equal(agree.blocking, false)
  const active = qoblex('VARIANT', 'ACTIVE', 'publish')
  assert.ok(!findingCodes(active).includes('LIFECYCLE_DISAGREES_WITH_WOO'))
})

// [mutation: only VARIANT is compared, not a KIT or BOM variation]
test('o3d-e9m7q: a DRAFT KIT or BOM variation under a published parent blocks too', (t) => {
  for (const type of ['KIT', 'BOM']) {
    const r = qoblex(type, 'DRAFT', 'publish', type === 'BOM' ? { 'recipe-lines': ds('recipe-lines', [{ parentSku: 'P-01', componentSku: 'C1', qty: '1' }]) } : {})
    precondition(t, `${type} joined`, emitted(r, 'variant-parents', 'VARIATION_JOINED'))
    assert.ok(findingCodes(r, 'ERROR').includes('LIFECYCLE_DISAGREES_WITH_WOO'), type)
  }
})

// [mutation: the confirmation list is ignored, or a confirmation of another SKU lifts the block]
test('o3d-e9m7q: lifecycle-confirmations accepts the SKU (INFO) and an unused confirmation is a WARNING', (t) => {
  const confirm = (sku: string) => ({ 'lifecycle-confirmations': ds('lifecycle-confirmations', [{ sku, reason: 'owner: listing may go to draft' }]) })
  const ok = qoblex('VARIANT', 'DRAFT', 'publish', confirm(' p-01 '))
  precondition(t, 'confirmations read', emitted(ok, 'lifecycle-confirmations', 'LIFECYCLE_CONFIRMATION_REGISTERED'))
  assert.ok(!findingCodes(ok, 'ERROR').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.ok(findingCodes(ok, 'INFO').includes('LIFECYCLE_CONFIRMED'))
  assert.equal(ok.blocking, false)
  const other = qoblex('VARIANT', 'DRAFT', 'publish', confirm('OTHER'))
  assert.ok(findingCodes(other, 'ERROR').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.ok(findingCodes(other, 'WARNING').includes('STALE_LIFECYCLE_CONFIRMATION'))
  const noReason = qoblex('VARIANT', 'DRAFT', 'publish', { 'lifecycle-confirmations': ds('lifecycle-confirmations', [{ sku: 'P-01', reason: '' }]) })
  assert.deepEqual(dispositionCodes(noReason, 'lifecycle-confirmations', 'REJECTED'), ['MISSING_REASON'])
})

// [mutation: the woo-products DRAFT check is removed]
test('o3d-e9m7q: with woo-products, a DRAFT simple product against a published listing blocks; unknown status is listed', (t) => {
  const simple = (status: string) => run({
    products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'DRAFT' })]),
    'woo-products': ds('woo-products', [{ sku: 'S-1', ...(status === '' ? {} : { status }) }]),
  })
  const published = simple('publish')
  precondition(t, 'woo rows', emitted(published, 'woo-products', 'COVERAGE_ROW'))
  assert.ok(findingCodes(published, 'ERROR').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.ok(!findingCodes(simple('draft')).includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  const unknown = simple('')
  assert.ok(findingCodes(unknown, 'WARNING').includes('DRAFT_PRODUCT_WOO_STATUS_UNKNOWN'))
})

// ----- non-stock-skus -----
const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const stockMap = parseColumnMap(readFileSync(path.join(NATIVE, 'maps', 'qoblex-stock-on-hand.map.json'), 'utf8'), 'qoblex-stock-on-hand.map.json')
const lines = readFileSync(path.join(NATIVE, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((l) => l !== '')
const cellsOf = (line: string): string[] => line.replace(/^﻿/, '').slice(1, -1).split('","')
const HEADER = cellsOf(lines[1])
const TEMPLATE = cellsOf(lines.find((l) => l.includes('"SYN-1001"'))!)
const QTY_AT = HEADER.map((h, i) => (h === 'Quantity' ? i : -1)).filter((i) => i >= 0)
function stockRow(sku: string, type: string, qty: string[]): string {
  const cells = [...TEMPLATE]
  cells[0] = `Name of ${sku}`
  cells[1] = sku
  cells[5] = type
  QTY_AT.forEach((at, i) => (cells[at] = qty[i] ?? ''))
  return `"${cells.join('","')}"`
}
const csv = (...rows: string[]) => Buffer.from([lines[0], lines[1], ...rows, ''].join('\r\n'))
const decisions: IngestDecisions = { nonStockSkus: new Set(['SYN-NS'].map(decisionSkuKey)), skuByName: new Map() }
const stock = (data: Buffer) => ingestDataset('stock-lots', data, 's.csv', stockMap.datasets['stock-lots']!, decisions)
const prods = (data: Buffer) => ingestDataset('products', data, 's.csv', stockMap.datasets.products!, decisions)
const NONE = ['', '', '', '', '', '']

// [mutation: the overwrite is applied whatever the source cell says]
test('o3d-wink4: a stated stock-bearing type on a non-stock SKU is refused in products and stock lots; Unknown / blank still load as non-inventory', (t) => {
  const data = csv(stockRow('SYN-NS', 'simple', ['40', '40', '', '', '', '']))
  const p = prods(data)
  const s = stock(data)
  precondition(t, 'records read', p.recordsRead + s.recordsRead)
  assert.deepEqual(p.rejected.map((x) => x.code), ['NON_STOCK_DECISION_CONFLICT'])
  assert.deepEqual(s.rejected.map((x) => x.code), ['NON_STOCK_DECISION_CONFLICT'])
  assert.equal(p.rows.length, 0)
  for (const type of ['kit', 'bom', 'variable']) assert.equal(prods(csv(stockRow('SYN-NS', type, NONE))).rejected[0]?.code, 'NON_STOCK_DECISION_CONFLICT', type)
  for (const type of ['Unknown', '', 'non-inventory']) {
    const ok = prods(csv(stockRow('SYN-NS', type, NONE)))
    assert.equal(ok.rejected.length, 0, type)
    assert.equal(ok.rows[0].values.type, 'NON_INVENTORY', type)
  }
})

// [mutation: the ignored quantity is not reported]
test('o3d-wink4: a nonzero quantity ignored on a non-stock SKU is reported; a zero or blank one is not', (t) => {
  const withQty = stock(csv(stockRow('SYN-NS', 'Unknown', ['5', '5', '', '', '', ''])))
  precondition(t, 'records skipped', withQty.rowsSkipped['non-inventory'] ?? 0)
  assert.deepEqual((withQty.notes ?? []).map((n) => n.code), ['NON_STOCK_QTY_IGNORED'])
  const zero = stock(csv(stockRow('SYN-NS', 'Unknown', ['0', '0', '0', '0', '0', '0'])))
  assert.deepEqual((zero.notes ?? []).map((n) => n.code), [])
})

// ----- sku-renames vs sku-exclusions -----
// [mutation: the exclusion check is removed from loadSkuRenames]
test('o3d-gqel4: a rename whose fromSku or toSku is on sku-exclusions is refused; the exclusion keeps its effect', (t) => {
  const base = { products: ds('products', [product('AV-1'), product('OK-1')]) }
  const from = run({ ...base, 'sku-exclusions': ds('sku-exclusions', [{ sku: 'av-1', reason: 'owner: not sold' }]), 'sku-renames': ds('sku-renames', [{ fromSku: 'AV-1', toSku: 'W-1', reason: 'woo spelling' }]) })
  precondition(t, 'rename rows read', dispositionCodes(from, 'sku-renames', 'REJECTED').length)
  assert.deepEqual(dispositionCodes(from, 'sku-renames', 'REJECTED'), ['RENAME_FROM_EXCLUDED'])
  assert.equal(from.blocking, true)
  const to = run({ ...base, 'sku-exclusions': ds('sku-exclusions', [{ sku: 'W-2', reason: 'owner: not sold' }]), 'sku-renames': ds('sku-renames', [{ fromSku: 'OK-1', toSku: 'W-2', reason: 'woo spelling' }]) })
  assert.deepEqual(dispositionCodes(to, 'sku-renames', 'REJECTED'), ['RENAME_TO_EXCLUDED'])
  const fine = run({ ...base, 'sku-exclusions': ds('sku-exclusions', [{ sku: 'AV-1', reason: 'owner: not sold' }]), 'sku-renames': ds('sku-renames', [{ fromSku: 'OK-1', toSku: 'W-3', reason: 'woo spelling' }]) })
  assert.deepEqual(dispositionCodes(fine, 'sku-renames', 'REJECTED'), [])
  assert.equal(emitted(fine, 'sku-renames', 'SKU_RENAMED'), 1)
})
