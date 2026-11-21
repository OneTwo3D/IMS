/**
 * The owner lifecycle review model (lib/first-load/lifecycle-review/model.ts), pure: the #1122 R1 rules on stock (any single warehouse, a VARIABLE parent's
 * variations, a variation's own WooCommerce stock), the review set (a variation under a draft parent) and a SKU WooCommerce holds twice. Synthetic data only.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReviewModel, ReviewModelError, type ReviewInputs } from '../../lib/first-load/lifecycle-review/model.ts'
import type { SnapshotPayload } from '../../lib/first-load/snapshot.ts'
import type { CatalogueEntry } from '../../lib/first-load/transform.ts'

const entry = (sku: string, type: CatalogueEntry['type'], parentSku = '', lifecycle = 'ACTIVE'): CatalogueEntry => ({ sku, name: sku, type, parentSku, lifecycle, lifecycleSource: 'qoblex' })

function inputs(change: Partial<ReviewInputs> = {}, snapshot: Partial<SnapshotPayload> = {}): ReviewInputs {
  return {
    catalogue: [entry('SPLIT', 'SIMPLE'), entry('PAR', 'VARIABLE'), entry('PAR-A', 'VARIANT', 'PAR'), entry('PAR-B', 'VARIANT', 'PAR'), entry('PUB', 'VARIABLE'), entry('PUB-A', 'VARIANT', 'PUB')],
    skuRenames: [],
    qoblexProducts: [
      { sku: 'SPLIT', name: 'Split', type: 'SIMPLE', state: 'Archived' },
      { sku: 'PAR-A', name: 'A', type: 'VARIANT', state: 'Active' },
      { sku: 'PAR-B', name: 'B', type: 'VARIANT', state: 'Active' },
      { sku: 'PUB-A', name: 'PA', type: 'VARIANT', state: 'Active' },
    ],
    qoblexStock: [
      { sku: 'SPLIT', warehouseCode: 'mil1', qty: '5' }, { sku: 'SPLIT', warehouseCode: 'CAMB', qty: '-5' },
      { sku: 'PAR-A', warehouseCode: 'MIL1', qty: '0' }, { sku: 'PAR-B', warehouseCode: 'CAMB', qty: '2' },
    ],
    snapshot: {
      source: 'woocommerce',
      products: [
        { id: 1, sku: 'SPLIT', name: 'Split (Woo)', type: 'simple', status: 'publish', manageStock: true, stockQuantity: 0 },
        { id: 2, sku: 'PAR', name: 'Parent', type: 'variable', status: 'draft', manageStock: false, stockQuantity: null },
        { id: 3, sku: 'PUB', name: 'Published parent', type: 'variable', status: 'publish', manageStock: false, stockQuantity: null },
      ],
      parents: [{ id: 2, sku: 'PAR', name: 'Parent', status: 'draft', variationIds: [21, 22] }, { id: 3, sku: 'PUB', name: 'Published parent', status: 'publish', variationIds: [31] }],
      variations: [
        { id: 21, parentId: 2, sku: 'PAR-A', status: 'publish', attributes: [{ name: 'Size', option: 'S' }], manageStock: 'parent', stockQuantity: 0 },
        { id: 22, parentId: 2, sku: 'PAR-B', status: 'publish', attributes: [{ name: 'Size', option: 'L' }], manageStock: false, stockQuantity: null },
        { id: 31, parentId: 3, sku: 'PUB-A', status: 'publish', attributes: [], manageStock: true, stockQuantity: null },
      ],
      ...snapshot,
    },
    wms: null,
    ...change,
  }
}

// [mutation: stock is judged on the Qoblex total again (+5 and -5 is 0)] (MED-2)
test('MED-2: a row holds stock when ANY single Qoblex warehouse is above zero, never on the sum; the record keeps the figure per warehouse', () => {
  const model = buildReviewModel(inputs())
  const split = model.rows.find((r) => r.imsSku === 'SPLIT')!
  assert.deepEqual(split.qoblexStock, { total: '0', byWarehouse: { MIL1: '5', CAMB: '-5' } })
  assert.equal(split.stockAboveZero, true, '+5 in MIL1 is stock although the total is 0')
  assert.deepEqual(model.entries.find((e) => e.sku === 'SPLIT')?.qoblexByWarehouse, { MIL1: '5', CAMB: '-5' })
})

// [mutation: a VARIABLE parent's stock is its own (none) again, or is judged on the sum of its variations] (MED-3)
test('MED-3: a VARIABLE parent shows its variations\' stock summed, holds stock when any variation does, and its record carries each variation\'s figures', () => {
  const model = buildReviewModel(inputs())
  const parent = model.rows.find((r) => r.imsSku === 'PAR')!
  assert.deepEqual(parent.qoblexStock, { total: '2', byWarehouse: { MIL1: '0', CAMB: '2' } })
  assert.equal(parent.stockAboveZero, true)
  assert.deepEqual(parent.wooStock, { kind: 'qty', qty: '0' }, 'the variation figures summed (one is not managed)')
  const record = model.entries.find((e) => e.sku === 'PAR')!
  assert.deepEqual(record.reasons, ['WooCommerce draft'])
  assert.deepEqual(record.variations, [
    { sku: 'PAR-A', qoblexByWarehouse: { MIL1: '0' }, wooStock: { kind: 'qty', qty: '0' }, wmsStock: { kind: 'unknown' } },
    { sku: 'PAR-B', qoblexByWarehouse: { CAMB: '2' }, wooStock: { kind: 'unmanaged' }, wmsStock: { kind: 'unknown' } },
  ])
  // Two variations at +3 and -3 in one warehouse: the parent's sum is 0, but it holds stock.
  const balanced = buildReviewModel(inputs({ qoblexStock: [{ sku: 'PAR-A', warehouseCode: 'MIL1', qty: '3' }, { sku: 'PAR-B', warehouseCode: 'MIL1', qty: '-3' }] }))
  const p2 = balanced.rows.find((r) => r.imsSku === 'PAR')!
  assert.equal(p2.qoblexStock?.total, '0')
  assert.equal(p2.stockAboveZero, true)
})

// [mutation: the variation's Woo stock is "not read" again, or a managed variation without a quantity reads as not managed] (MED-5)
test('MED-5: a variation\'s Woo stock comes from the snapshot: "parent" stock is the quantity the store reports, not managed is not managed, managed without a quantity is not read', () => {
  const model = buildReviewModel(inputs())
  assert.deepEqual(['PAR-A', 'PAR-B', 'PUB-A'].map((sku) => model.rows.find((r) => r.imsSku === sku)!.wooStock), [{ kind: 'qty', qty: '0' }, { kind: 'unmanaged' }, { kind: 'unknown' }])
})

// [mutation: a variation is reviewed only for its own WooCommerce status] (L10)
test('L10: a published variation under a draft parent is in the review set ("WooCommerce parent draft"); under a published parent it is not', () => {
  const model = buildReviewModel(inputs())
  assert.deepEqual(model.rows.find((r) => r.imsSku === 'PAR-A')!.reviewReasons, ['WooCommerce parent draft'])
  assert.deepEqual(model.rows.find((r) => r.imsSku === 'PUB-A')!.reviewReasons, [])
  assert.deepEqual(model.entries.map((e) => e.sku), ['PAR', 'PAR-A', 'PAR-B', 'SPLIT'])
})

// [mutation: the Woo map lets the later record overwrite the earlier one] (L11)
test('L11: a SKU WooCommerce holds as a product AND a variation (or twice) is refused, never overwritten', () => {
  const base = inputs()
  const clash = inputs({}, { products: [...base.snapshot.products, { id: 9, sku: 'PAR-A', name: 'Clash', type: 'simple', status: 'publish', manageStock: false, stockQuantity: null }] })
  assert.throws(() => buildReviewModel(clash), (e: unknown) => e instanceof ReviewModelError && /WooCommerce holds the SKU "PAR-A" twice \(ids 9 and 21\)/.test(e.message))
})
