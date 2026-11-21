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
const vp = (variant: string, parent: string, parentStatus: string, variationStatus: string) => ({ variantSku: variant, wooVariationId: '11', parentSku: parent, parentName: `Parent ${parent}`, parentStatus, wooParentId: '5001', variationStatus })

// The Qoblex shape: the products file has variants and NO parent row; the parent comes from variant-parents.
const qoblex = (variantType: string, lifecycle: string, parentStatus: string, ownStatus: string, extra: Partial<Parameters<typeof run>[0]> = {}) =>
  run({
    products: ds('products', [product('P-01', variantType, { lifecycleStatus: lifecycle })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', parentStatus, ownStatus)]),
    ...extra,
  })
const PUSH = 'LIFECYCLE_PUSH_WOULD_CHANGE_WOO_STATUS'

// [mutation: the check compares the PARENT status instead of the variation's own, or only providedParents is walked]
test('o3d-e9m7q: the variation OWN status decides, on the Qoblex shape (no parent rows); the parent is context only', (t) => {
  const draftOverPublish = qoblex('VARIANT', 'DRAFT', 'publish', 'publish')
  precondition(t, 'variations joined', emitted(draftOverPublish, 'variant-parents', 'VARIATION_JOINED'))
  assert.ok(findingCodes(draftOverPublish, 'ERROR').includes(PUSH))
  assert.equal(draftOverPublish.blocking, true)
  // the real-snapshot shape: published parent, PRIVATE variation, Qoblex Archived (DRAFT): consistent, no finding (119 rows in the real snapshot)
  const consistent = qoblex('VARIANT', 'DRAFT', 'publish', 'private')
  assert.ok(!findingCodes(consistent).includes(PUSH) && !findingCodes(consistent).includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.equal(consistent.blocking, false)
  // draft parent, published variation, ACTIVE: consistent (275 real rows); the ACTIVE variant under a DRAFT parent is silent
  const activeUnderDraftParent = qoblex('VARIANT', 'ACTIVE', 'draft', 'publish')
  assert.deepEqual(findingCodes(activeUnderDraftParent).filter((c) => c.startsWith('LIFECYCLE')), [])
  // EOL writes publish
  assert.equal(qoblex('VARIANT', 'EOL', 'publish', 'publish').blocking, false)
  // DRAFT against own publish under an UNPUBLISHED parent: warning only
  const unpublishedParent = qoblex('VARIANT', 'DRAFT', 'draft', 'publish')
  assert.ok(findingCodes(unpublishedParent, 'WARNING').includes('LIFECYCLE_DISAGREES_WITH_WOO'))
  assert.equal(unpublishedParent.blocking, false)
})

// [mutation: ACTIVE/EOL against a disabled own status is not checked]
test('o3d-e9m7q: ACTIVE or EOL against an own draft/private/pending status blocks (a push would re-enable it)', (t) => {
  for (const [lifecycle, own] of [['ACTIVE', 'private'], ['ACTIVE', 'draft'], ['EOL', 'pending']] as const) {
    const r = qoblex('VARIANT', lifecycle, 'publish', own)
    precondition(t, 'joined', emitted(r, 'variant-parents', 'VARIATION_JOINED'))
    assert.ok(findingCodes(r, 'ERROR').includes(PUSH), `${lifecycle}/${own}`)
  }
})

// [mutation: the status is not validated against the closed map]
test('o3d-e9m7q: an unmapped variationStatus rejects the row; a blank one skips the check', (t) => {
  const bad = qoblex('VARIANT', 'DRAFT', 'publish', 'trash')
  precondition(t, 'rejected rows', dispositionCodes(bad, 'variant-parents', 'REJECTED').length)
  assert.deepEqual(dispositionCodes(bad, 'variant-parents', 'REJECTED'), ['UNMAPPED_VARIATION_STATUS'])
})

// [mutation: only VARIANT is compared, not a KIT or BOM variation]
test('o3d-e9m7q: a DRAFT KIT or BOM variation over its own published status blocks too', (t) => {
  for (const type of ['KIT', 'BOM']) {
    const r = qoblex(type, 'DRAFT', 'publish', 'publish', type === 'BOM' ? { 'recipe-lines': ds('recipe-lines', [{ parentSku: 'P-01', componentSku: 'C1', qty: '1' }]) } : {})
    precondition(t, `${type} joined`, emitted(r, 'variant-parents', 'VARIATION_JOINED'))
    assert.ok(findingCodes(r, 'ERROR').includes(PUSH), type)
  }
})

// [mutation: the confirmation list is ignored, a used confirmation is reported stale, or a duplicate row is accepted twice]
test('o3d-e9m7q: lifecycle-confirmations accepts the SKU (INFO), a used one is not stale, an unused one is, a duplicate row is excluded', (t) => {
  const confirm = (...skus: string[]) => ({ 'lifecycle-confirmations': ds('lifecycle-confirmations', skus.map((sku) => ({ sku, reason: 'owner: accepted' }))) })
  const ok = qoblex('VARIANT', 'DRAFT', 'publish', 'publish', confirm(' p-01 '))
  precondition(t, 'confirmations read', emitted(ok, 'lifecycle-confirmations', 'LIFECYCLE_CONFIRMATION_REGISTERED'))
  assert.ok(!findingCodes(ok, 'ERROR').includes(PUSH))
  assert.ok(findingCodes(ok, 'INFO').includes('LIFECYCLE_CONFIRMED'))
  assert.ok(!findingCodes(ok).includes('STALE_LIFECYCLE_CONFIRMATION'), 'a used confirmation is not stale')
  assert.equal(ok.blocking, false)
  const other = qoblex('VARIANT', 'DRAFT', 'publish', 'publish', confirm('OTHER'))
  assert.ok(findingCodes(other, 'ERROR').includes(PUSH))
  assert.ok(findingCodes(other, 'WARNING').includes('STALE_LIFECYCLE_CONFIRMATION'))
  const noReason = qoblex('VARIANT', 'DRAFT', 'publish', 'publish', { 'lifecycle-confirmations': ds('lifecycle-confirmations', [{ sku: 'P-01', reason: '' }]) })
  assert.deepEqual(dispositionCodes(noReason, 'lifecycle-confirmations', 'REJECTED'), ['MISSING_REASON'])
  const dup = qoblex('VARIANT', 'DRAFT', 'publish', 'publish', confirm('P-01', 'p-01'))
  assert.deepEqual(dispositionCodes(dup, 'lifecycle-confirmations', 'EXCLUDED'), ['DUPLICATE_ROW'])
})

// [mutation: the woo-products check is removed, runs on every lifecycle in the wrong direction, or includes rows that have a parent]
test('o3d-e9m7q: with woo-products, a simple product is checked against its own status; a parented row is not', (t) => {
  const simple = (lifecycle: string, status: string) => run({
    products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: lifecycle })]),
    'woo-products': ds('woo-products', [{ sku: 'S-1', ...(status === '' ? {} : { status }) }]),
  })
  const published = simple('DRAFT', 'publish')
  precondition(t, 'woo rows', emitted(published, 'woo-products', 'COVERAGE_ROW'))
  assert.ok(findingCodes(published, 'ERROR').includes(PUSH))
  assert.ok(findingCodes(simple('ACTIVE', 'private'), 'ERROR').includes(PUSH))
  assert.ok(!findingCodes(simple('DRAFT', 'draft')).includes(PUSH))
  assert.ok(!findingCodes(simple('ACTIVE', 'publish')).includes(PUSH))
  assert.ok(findingCodes(simple('DRAFT', ''), 'WARNING').includes('DRAFT_PRODUCT_WOO_STATUS_UNKNOWN'))
  // a variation also listed in woo-products is judged by the variation check only (its own status there is publish: consistent)
  const parented = run({
    products: ds('products', [product('P-01', 'VARIANT', { lifecycleStatus: 'ACTIVE' })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', 'publish')]),
    'woo-products': ds('woo-products', [{ sku: 'P-01', status: 'private' }]),
  })
  assert.ok(!findingCodes(parented).includes(PUSH))
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
  for (const type of ['Unknown', 'UNKNOWN', '', 'non-inventory', 'Non-Inventory']) {
    const ok = prods(csv(stockRow('SYN-NS', type, NONE)))
    assert.equal(ok.rejected.length, 0, type)
    assert.equal(ok.rows[0].values.type, 'NON_INVENTORY', type)
  }
})

// [mutation: the conflict check runs before the State skip]
test('o3d-wink4: a Deleted typed row of a non-stock SKU is skipped by the State rule, not refused', (t) => {
  const deleted = stockRow('SYN-NS', 'simple', ['40', '40', '', '', '', ''])
  const withState = (row: string, state: string) => row.replace('"Active"', `"${state}"`)
  const data = csv(withState(deleted, 'Deleted'))
  const p = prods(data)
  const s = stock(data)
  precondition(t, 'rows skipped by State', (p.rowsSkipped.Deleted ?? 0) + (s.rowsSkipped.Deleted ?? 0))
  assert.deepEqual(p.rejected, [])
  assert.deepEqual(s.rejected, [])
  assert.equal(p.rowsSkipped.Deleted, 1)
  assert.deepEqual(s.notes ?? [], [])
  assert.equal(prods(csv(withState(deleted, 'Active'))).rejected[0]?.code, 'NON_STOCK_DECISION_CONFLICT')
})

// [mutation: the ignored quantity is not reported]
test('o3d-wink4: a nonzero quantity ignored on a non-stock SKU is reported; a zero or blank one is not', (t) => {
  assert.deepEqual((prods(csv(stockRow('SYN-NS', 'Unknown', ['5', '5', '', '', '', '']))).notes ?? []).map((n) => n.code), [], 'reported once, in the stock lots only')
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
