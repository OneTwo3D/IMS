/**
 * First-load P2 beads (all fixtures synthetic):
 *   - OWNER RULING 2026-11-21, "Use Woo's status as gospel": the lifecycle of a joined variation (its own variationStatus) and of a simple/KIT/BOM product (woo-products status)
 *     is DERIVED FROM WOOCOMMERCE, overriding the Qoblex State; no Woo status keeps the Qoblex lifecycle; every change is an INFO, never a warning or an error;
 *   - non-stock-skus fills only a blank / Unknown kind and refuses a stated stock-bearing type;
 *   - sku-renames never overrides a sku-exclusions entry.
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { decisionSkuKey, ingestDataset, parseColumnMap, type IngestDecisions } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, findingCodes, lot, precondition, product, rowsOf, run } from './helpers.ts'

const emitted = (r: ReturnType<typeof run>, dataset: string, code: string): number => r.report.accountingByCode.filter((a) => a.dataset === dataset && a.outcome === 'EMITTED' && a.code === code).reduce((n, a) => n + a.count, 0)
const vp = (variant: string, parent: string, parentStatus: string, variationStatus: string) => ({ variantSku: variant, wooVariationId: String(1000 + variant.length * 37 + [...variant].reduce((n, c) => n + c.charCodeAt(0), 0)), parentSku: parent, parentName: `Parent ${parent}`, parentStatus, wooParentId: String(5000 + [...parent].reduce((n, c) => n + c.charCodeAt(0), 0)), variationStatus })
const lifecycleOf = (r: ReturnType<typeof run>, sku: string): string => rowsOf(r, 'products').find((row) => row.sku === sku)?.lifecycleStatus ?? '(no row)'
const infoMessages = (r: ReturnType<typeof run>, code: string): string[] => r.report.findings.filter((f) => f.code === code).map((f) => f.message)

// The Qoblex shape: the products file has variants and NO parent row; the parent comes from variant-parents.
const qoblex = (variantType: string, lifecycle: string, parentStatus: string, ownStatus: string, extra: Partial<Parameters<typeof run>[0]> = {}) =>
  run({
    products: ds('products', [product('P-01', variantType, { lifecycleStatus: lifecycle })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', parentStatus, ownStatus)]),
    ...extra,
  })
const simple = (lifecycle: string, status: string, extra: Partial<Parameters<typeof run>[0]> = {}) => run({
  products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: lifecycle })]),
  'woo-products': ds('woo-products', [{ sku: 'S-1', ...(status === '' ? {} : { status }) }]),
  ...extra,
})
const QOBLEX = ['ACTIVE', 'EOL', 'DRAFT', 'ARCHIVED']
/** Woo status -> [expected lifecycle per Qoblex state in QOBLEX order]. publish keeps EOL; everything else is DRAFT. */
const EXPECTED: Record<string, string[]> = {
  publish: ['ACTIVE', 'EOL', 'ACTIVE', 'ACTIVE'],
  draft: ['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT'],
  pending: ['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT'],
  private: ['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT'],
}

// [mutation: the mapping is wrong for one cell, the parent's status is used, or Qoblex EOL is flipped by publish]
test('woo gospel: every Woo status x Qoblex state for a VARIANT takes the lifecycle from its OWN status, whatever the parent says', (t) => {
  let cells = 0
  for (const [wooStatus, expected] of Object.entries(EXPECTED)) {
    for (const [i, state] of QOBLEX.entries()) {
      for (const parentStatus of ['publish', 'draft']) {
        const r = qoblex('VARIANT', state, parentStatus, wooStatus)
        assert.equal(lifecycleOf(r, 'P-01'), expected[i], `${state} + own ${wooStatus} (parent ${parentStatus})`)
        assert.equal(r.blocking, false, `${state}/${wooStatus} never blocks`)
        assert.deepEqual(findingCodes(r, 'ERROR').concat(findingCodes(r, 'WARNING')).filter((c) => c.startsWith('LIFECYCLE')), [], `${state}/${wooStatus}: no error or warning`)
        assert.equal(findingCodes(r, 'INFO').includes('LIFECYCLE_TAKEN_FROM_WOO'), expected[i] !== state, `${state}/${wooStatus}: INFO exactly when the lifecycle changed`)
        cells++
      }
    }
  }
  precondition(t, 'cells', cells)
})

// [mutation: a KIT or BOM variation is not covered]
test('woo gospel: a KIT or BOM variation takes its own Woo status too (DRAFT over publish, ACTIVE over private)', (t) => {
  const withRecipe = (type: string, lifecycle: string, own: string) => run({
    products: ds('products', [product('P-01', type, { lifecycleStatus: lifecycle }), product('C1', 'SIMPLE')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'P-01', componentSku: 'C1', qty: '1' }]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', own)]),
  })
  for (const type of ['KIT', 'BOM']) {
    const toDraft = withRecipe(type, 'ACTIVE', 'private')
    precondition(t, `${type} joined`, emitted(toDraft, 'variant-parents', 'VARIATION_JOINED'))
    assert.equal(lifecycleOf(toDraft, 'P-01'), 'DRAFT', type)
    const toActive = withRecipe(type, 'DRAFT', 'publish')
    assert.equal(lifecycleOf(toActive, 'P-01'), 'ACTIVE', type)
    assert.equal(toActive.blocking, false, type)
  }
})

// [mutation: a simple product is not covered, or the woo-products status column is ignored]
test('woo gospel: every Woo status x Qoblex state for a SIMPLE product (woo-products status)', (t) => {
  let cells = 0
  for (const [wooStatus, expected] of Object.entries(EXPECTED)) {
    for (const [i, state] of QOBLEX.entries()) {
      const r = simple(state, wooStatus)
      assert.equal(lifecycleOf(r, 'S-1'), expected[i], `${state} + woo ${wooStatus}`)
      assert.equal(r.blocking, false)
      assert.equal(findingCodes(r, 'INFO').includes('LIFECYCLE_TAKEN_FROM_WOO'), expected[i] !== state)
      cells++
    }
  }
  precondition(t, 'cells', cells)
  // a status is trimmed and read in lower case
  assert.equal(lifecycleOf(simple('DRAFT', ' PUBLISH '), 'S-1'), 'ACTIVE')
})

// [mutation: a product with no Woo status is changed, or a mismatch is still a warning]
test('woo gospel: a product with no visible Woo status keeps the Qoblex lifecycle exactly (unjoined variant, absent from woo-products, blank/unmapped status)', (t) => {
  const unjoined = run({
    products: ds('products', [product('P-01', 'SIMPLE', { lifecycleStatus: 'ARCHIVED' }), product('Q-1', 'SIMPLE', { lifecycleStatus: 'ARCHIVED' })]),
    'variant-parents': ds('variant-parents', [vp('OTHER-01', 'OTHER', 'publish', 'publish')]),
  })
  precondition(t, 'run produced rows', rowsOf(unjoined, 'products').length)
  assert.equal(lifecycleOf(unjoined, 'Q-1'), 'ARCHIVED')
  assert.equal(lifecycleOf(unjoined, 'P-01'), 'ARCHIVED', 'a product the variant-parents rows do not name keeps its Qoblex lifecycle')
  assert.equal(findingCodes(unjoined).includes('LIFECYCLE_TAKEN_FROM_WOO'), false)
  const noWoo = run({ products: ds('products', [product('Q-1', 'SIMPLE', { lifecycleStatus: 'ARCHIVED' })]) })
  assert.equal(lifecycleOf(noWoo, 'Q-1'), 'ARCHIVED')
  const absent = run({ products: ds('products', [product('Q-1', 'SIMPLE', { lifecycleStatus: 'ARCHIVED' })]), 'woo-products': ds('woo-products', [{ sku: 'OTHER', status: 'publish' }]) })
  // (the coverage check blocks this run, so no rows are written; the point is that nothing was changed from Woo)
  assert.equal(findingCodes(absent).includes('LIFECYCLE_TAKEN_FROM_WOO'), false)
  for (const lifecycle of ['ACTIVE', 'EOL', 'DRAFT']) {
    // (L7) a listed product with a blank or unmapped status keeps its lifecycle, and is listed, whatever the lifecycle; another row states a status so the column is in use
    for (const status of ['', 'trash']) {
      const r = simple(lifecycle, status, { products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: lifecycle }), product('OTHER', 'SIMPLE')]), 'woo-products': ds('woo-products', [{ sku: 'S-1', ...(status === '' ? {} : { status }) }, { sku: 'OTHER', status: 'publish' }]) })
      assert.equal(lifecycleOf(r, 'S-1'), lifecycle, `${lifecycle}/${JSON.stringify(status)}`)
      assert.ok(findingCodes(r, 'WARNING').includes('LIFECYCLE_WOO_STATUS_UNUSABLE'), `${lifecycle}/${JSON.stringify(status)}`)
      assert.equal(findingCodes(r).includes('LIFECYCLE_TAKEN_FROM_WOO'), false)
    }
  }
  // no row states a status at all: the column is absent, one INFO, no warning
  const noColumn = simple('ACTIVE', '')
  assert.equal(lifecycleOf(noColumn, 'S-1'), 'ACTIVE')
  assert.ok(findingCodes(noColumn, 'INFO').includes('LIFECYCLE_WOO_STATUS_ABSENT'))
  assert.equal(findingCodes(noColumn, 'WARNING').includes('LIFECYCLE_WOO_STATUS_UNUSABLE'), false)
})

// [mutation: the finding lacks a field, the count is wrong, or an unchanged SKU is listed]
test('woo gospel: each changed SKU is one INFO with SKU, Qoblex state, Woo status and result, plus a per-run count; unchanged SKUs are not listed', (t) => {
  const r = run({
    products: ds('products', [
      product('A-01', 'VARIANT', { lifecycleStatus: 'ARCHIVED' }), product('B-01', 'VARIANT', { lifecycleStatus: 'ACTIVE' }), product('C-01', 'VARIANT', { lifecycleStatus: 'EOL' }),
      product('S-1', 'SIMPLE', { lifecycleStatus: 'DRAFT' }), product('S-2', 'SIMPLE', { lifecycleStatus: 'ACTIVE' }),
    ]),
    'variant-parents': ds('variant-parents', [vp('A-01', 'A', 'publish', 'publish'), vp('B-01', 'B', 'publish', 'private'), vp('C-01', 'C', 'publish', 'publish')]),
    'woo-products': ds('woo-products', [{ sku: 'S-1', status: 'publish' }, { sku: 'S-2', status: 'publish' }]),
  })
  const lines = infoMessages(r, 'LIFECYCLE_TAKEN_FROM_WOO')
  precondition(t, 'changed lines', lines.length)
  assert.equal(lines.length, 3, 'A-01 (ARCHIVED->ACTIVE), B-01 (ACTIVE->DRAFT), S-1 (DRAFT->ACTIVE); C-01 EOL/publish and S-2 ACTIVE/publish are unchanged')
  assert.ok(lines.some((l) => l.includes('A-01') && l.includes('ARCHIVED') && l.includes('publish') && l.includes('ACTIVE')))
  assert.ok(lines.some((l) => l.includes('B-01') && l.includes('ACTIVE') && l.includes('private') && l.includes('DRAFT')))
  assert.ok(lines.some((l) => l.includes('S-1') && l.includes('DRAFT') && l.includes('publish') && l.includes('ACTIVE')))
  assert.ok(!lines.some((l) => l.includes('C-01') || l.includes('S-2')))
  const count = infoMessages(r, 'LIFECYCLE_TAKEN_FROM_WOO_COUNT')
  assert.equal(count.length, 1)
  assert.ok(count[0].startsWith('3 product(s)'), count[0])
  assert.equal(r.blocking, false)
  for (const severity of ['ERROR', 'WARNING'] as const) assert.deepEqual(findingCodes(r, severity).filter((c) => c.startsWith('LIFECYCLE')), [])
  // the code that no longer arises is gone from the whole report
  assert.equal(findingCodes(r).some((c) => c === 'LIFECYCLE_PUSH_WOULD_CHANGE_WOO_STATUS' || c === 'LIFECYCLE_DISAGREES_WITH_WOO' || c === 'STALE_LIFECYCLE_CONFIRMATION'), false)
})

// [mutation: a variation also listed in woo-products is judged by the products status, not its own variation status]
test('woo gospel: a variation also listed in woo-products takes its OWN variation status, not the woo-products row', (t) => {
  const parented = run({
    products: ds('products', [product('P-01', 'VARIANT', { lifecycleStatus: 'ACTIVE' })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', 'publish')]),
    'woo-products': ds('woo-products', [{ sku: 'P-01', status: 'private' }]),
  })
  precondition(t, 'joined', emitted(parented, 'variant-parents', 'VARIATION_JOINED'))
  assert.equal(lifecycleOf(parented, 'P-01'), 'ACTIVE')
  assert.equal(findingCodes(parented).includes('LIFECYCLE_TAKEN_FROM_WOO'), false)
})

// [mutation: the closed list is not enforced, or a blank status is accepted again (L3)]
test('o3d-7lxrt L3: an unmapped variationStatus rejects the row (UNMAPPED_VARIATION_STATUS); a blank one rejects it too (MISSING_VARIATION_STATUS)', (t) => {
  const bad = qoblex('VARIANT', 'DRAFT', 'publish', 'trash')
  precondition(t, 'rejected rows', dispositionCodes(bad, 'variant-parents', 'REJECTED').length)
  assert.deepEqual(dispositionCodes(bad, 'variant-parents', 'REJECTED'), ['UNMAPPED_VARIATION_STATUS'])
  for (const blank of ['', '   ']) {
    const r = qoblex('VARIANT', 'DRAFT', 'publish', blank)
    assert.deepEqual(dispositionCodes(r, 'variant-parents', 'REJECTED'), ['MISSING_VARIATION_STATUS'], JSON.stringify(blank))
    assert.equal(r.blocking, true)
  }
  // the column absent altogether is the same refusal (an old row shape)
  const { variationStatus: _gone, ...old } = vp('P-01', 'P', 'publish', 'publish')
  void _gone
  const absent = run({ products: ds('products', [product('P-01', 'VARIANT')]), 'variant-parents': ds('variant-parents', [old]) })
  assert.deepEqual(dispositionCodes(absent, 'variant-parents', 'REJECTED'), ['MISSING_VARIATION_STATUS'])
})

// [mutation: ownStatus is dropped from the duplicate signature, or is not trimmed/lower-cased (L6)]
test('o3d-7lxrt L6: the variation own status takes part in the duplicate signature and is trimmed and lower-cased', (t) => {
  const exact = run({ products: ds('products', [product('P-01', 'VARIANT')]), 'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', 'publish'), vp('P-01', 'P', 'publish', ' Publish ')]) })
  precondition(t, 'rows read', exact.report.inputs.find((i) => i.dataset === 'variant-parents')?.recordsRead ?? 0)
  assert.deepEqual(dispositionCodes(exact, 'variant-parents', 'EXCLUDED'), ['DUPLICATE_ROW'], 'the same status in another spelling is an exact duplicate')
  const differing = run({ products: ds('products', [product('P-01', 'VARIANT')]), 'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', 'publish'), vp('P-01', 'P', 'publish', 'private')]) })
  assert.deepEqual(dispositionCodes(differing, 'variant-parents', 'REJECTED'), ['DUPLICATE_VARIATION_SKU', 'DUPLICATE_VARIATION_SKU'], 'rows differing only in the own status cannot be decided')
})

// [mutation: lifecycle-confirmations raises an error again, or a row changes the result]
test('woo gospel: a lifecycle-confirmations row is an INFO no-op (the lifecycle is taken from WooCommerce); bad rows and duplicates are no-ops too', (t) => {
  const confirm = (...rows: Array<Record<string, string>>) => ({ 'lifecycle-confirmations': ds('lifecycle-confirmations', rows) })
  const withRow = qoblex('VARIANT', 'DRAFT', 'publish', 'publish', confirm({ sku: ' p-01 ', reason: 'owner: accepted' }, { sku: 'P-01', reason: '' }, { sku: 'GONE', reason: 'x' }))
  const without = qoblex('VARIANT', 'DRAFT', 'publish', 'publish')
  precondition(t, 'confirmations read', withRow.report.inputs.find((i) => i.dataset === 'lifecycle-confirmations')?.recordsRead ?? 0)
  assert.deepEqual(dispositionCodes(withRow, 'lifecycle-confirmations', 'EXCLUDED'), ['LIFECYCLE_CONFIRMATION_NOT_NEEDED', 'LIFECYCLE_CONFIRMATION_NOT_NEEDED', 'LIFECYCLE_CONFIRMATION_NOT_NEEDED'])
  assert.deepEqual(dispositionCodes(withRow, 'lifecycle-confirmations', 'REJECTED'), [])
  assert.ok(findingCodes(withRow, 'INFO').includes('LIFECYCLE_CONFIRMATIONS_NOT_NEEDED'))
  assert.ok(infoMessages(withRow, 'LIFECYCLE_CONFIRMATIONS_NOT_NEEDED')[0].includes('taken from WooCommerce'))
  assert.equal(withRow.blocking, false)
  assert.equal(lifecycleOf(withRow, 'P-01'), lifecycleOf(without, 'P-01'))
  assert.equal(lifecycleOf(withRow, 'P-01'), 'ACTIVE')
  assert.deepEqual(findingCodes(withRow, 'ERROR').concat(findingCodes(withRow, 'WARNING')).filter((c) => c.includes('CONFIRM')), [])
})

// [mutation: the Woo lifecycle is applied after the order checks, or a changed product is judged by its Qoblex lifecycle]
test('woo gospel: purchase-order lines are judged by the Woo-derived lifecycle (ACTIVE/DRAFT load, EOL and ARCHIVED-that-stays refuse); an open PO on a DRAFT stays loadable', (t) => {
  const line = (sku: string) => ({ orderKey: `O-${sku}`, supplierName: 'Sup', sku, qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3' })
  const make = (rows: Array<[string, string, string]>) => run({
    products: ds('products', rows.map(([sku, , lifecycle]) => product(sku, 'SIMPLE', { lifecycleStatus: lifecycle }))),
    'woo-products': ds('woo-products', rows.map(([sku, status]) => ({ sku, status }))),
    'purchase-order-lines': ds('purchase-order-lines', rows.map(([sku]) => line(sku))),
  })
  // Qoblex ARCHIVED + Woo publish -> ACTIVE: loadable (Qoblex alone would refuse it as not purchasable). Qoblex EOL + publish stays EOL: refused, as before.
  const upgraded = make([['AR', 'publish', 'ARCHIVED']])
  precondition(t, 'order lines', upgraded.report.inputs.find((i) => i.dataset === 'purchase-order-lines')?.recordsRead ?? 0)
  assert.equal(upgraded.blocking, false)
  assert.deepEqual(rowsOf(upgraded, 'purchase-orders').map((r) => r.orderKey), ['T-O-AR'])
  assert.deepEqual(dispositionCodes(make([['EO', 'publish', 'EOL']]), 'purchase-order-lines', 'REJECTED'), ['PRODUCT_NOT_PURCHASABLE'])
  assert.deepEqual(dispositionCodes(make([['AR', '', 'ARCHIVED']]), 'purchase-order-lines', 'REJECTED'), ['PRODUCT_NOT_PURCHASABLE'], 'no Woo status: ARCHIVED stays refused')
  // Qoblex ACTIVE + Woo private -> DRAFT, Qoblex EOL + draft -> DRAFT: DRAFT is purchasable, so an open PO stays loadable
  const downgraded = make([['AC', 'private', 'ACTIVE'], ['EO', 'draft', 'EOL'], ['DR', 'publish', 'DRAFT']])
  assert.equal(downgraded.blocking, false)
  assert.deepEqual(rowsOf(downgraded, 'purchase-orders').map((r) => r.orderKey).sort(), ['T-O-AC', 'T-O-DR', 'T-O-EO'])
  assert.equal(lifecycleOf(downgraded, 'AC'), 'DRAFT')
  assert.equal(lifecycleOf(downgraded, 'EO'), 'DRAFT')
  assert.equal(lifecycleOf(downgraded, 'DR'), 'ACTIVE')
  // a variation too: Qoblex EOL, Woo private -> DRAFT is purchasable
  const variation = qoblex('VARIANT', 'EOL', 'publish', 'private', { 'purchase-order-lines': ds('purchase-order-lines', [line('P-01')]) })
  assert.deepEqual(dispositionCodes(variation, 'purchase-order-lines', 'REJECTED'), [])
})

// [mutation: ARCHIVED handling of transfers regresses, or a Woo-derived lifecycle is ever ARCHIVED]
test('woo gospel: transfers still refuse an ARCHIVED product, and no Woo-derived lifecycle is ARCHIVED (shouldForceWooZeroStock stays ARCHIVED-only)', (t) => {
  const transfer = { transferKey: 'T', status: 'IN_TRANSIT', fromWarehouseCode: 'MAIN', toWarehouseCode: 'OVER', sku: 'S-1', qtyShipped: '1', qtyReceived: '0' }
  const stock = { 'stock-lots': ds('stock-lots', [lot('S-1', '5', '1')]) }
  const stays = simple('ARCHIVED', '', { transfers: ds('transfers', [transfer]), ...stock })
  precondition(t, 'transfer rows', stays.report.inputs.find((i) => i.dataset === 'transfers')?.recordsRead ?? 0)
  assert.deepEqual(dispositionCodes(stays, 'transfers', 'REJECTED'), ['PRODUCT_ARCHIVED'], 'no Woo status: still ARCHIVED, still refused')
  const followed = simple('ARCHIVED', 'publish', { transfers: ds('transfers', [transfer]), ...stock })
  assert.deepEqual(dispositionCodes(followed, 'transfers', 'REJECTED'), [], 'Woo publish makes it ACTIVE, so the transfer is allowed')
  for (const [status, expected] of Object.entries(EXPECTED)) for (const [i, state] of QOBLEX.entries()) assert.notEqual(expected[i], 'ARCHIVED', `${state}/${status}`)
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

// [mutation: the stock-lots dataset skips the kit conflict, or the quantity note is counted for a row another selector (State Deleted) skips]
test('o3d-7lxrt L4/L5: a stated kit/bom/variable type on a non-stock SKU is refused in stock lots too; a Deleted non-stock row reports no ignored quantity', (t) => {
  for (const type of ['kit', 'bom', 'variable']) {
    const s = stock(csv(stockRow('SYN-NS', type, ['40', '40', '', '', '', ''])))
    assert.equal(s.rejected[0]?.code, 'NON_STOCK_DECISION_CONFLICT', type)
  }
  const deletedWithQty = stockRow('SYN-NS', 'Unknown', ['5', '5', '', '', '', '']).replace('"Active"', '"Deleted"')
  const gone = stock(csv(deletedWithQty))
  precondition(t, 'rows skipped', Object.values(gone.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.deepEqual(gone.notes ?? [], [], 'a Deleted row is not a row of this dataset: its quantity is not reported')
  assert.deepEqual((stock(csv(stockRow('SYN-NS', 'Unknown', ['5', '5', '', '', '', '']))).notes ?? []).map((n) => n.code), ['NON_STOCK_QTY_IGNORED'], 'control: an Active one still is')
  // L9: the decision accepts a stated non-inventory type in any letter case, through the map's own value only
  for (const type of ['non-inventory', 'Non-Inventory']) assert.equal(prods(csv(stockRow('SYN-NS', type, NONE))).rejected.length, 0, type)
})
