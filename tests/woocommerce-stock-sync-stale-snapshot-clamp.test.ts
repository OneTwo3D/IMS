import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStockMaps,
  computeAvailableByProduct,
  resolvePushStockQuantity,
  type CandidateProduct,
  type StockLevelSnapshotRow,
} from '@/lib/connectors/woocommerce/sync/stock-sync'

function simpleProduct(id: string): CandidateProduct {
  return {
    id,
    sku: id,
    type: 'SIMPLE',
    lifecycleStatus: 'ACTIVE',
    externalProductId: null,
    parent: null,
    productComponents: [],
  }
}

function kitProduct(id: string, components: { componentId: string; qty: number }[]): CandidateProduct {
  return {
    id,
    sku: id,
    type: 'KIT',
    lifecycleStatus: 'ACTIVE',
    externalProductId: null,
    parent: null,
    productComponents: components.map((c) => ({
      componentId: c.componentId,
      // computeKitAvailability only does Number(component.qty)
      qty: c.qty as unknown as CandidateProduct['productComponents'][number]['qty'],
      component: { type: 'SIMPLE', lifecycleStatus: 'ACTIVE' },
    })),
  }
}

function rows(...r: [string, string, number, number][]): StockLevelSnapshotRow[] {
  return r.map(([productId, warehouseId, quantity, reservedQty]) => ({
    productId,
    warehouseId,
    quantity,
    reservedQty,
  }))
}

test('buildStockMaps sums available (qty - reserved, floored at 0) across warehouses', () => {
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(
    rows(['p1', 'wh-a', 5, 1], ['p1', 'wh-b', 3, 0], ['p2', 'wh-a', 2, 4]),
  )
  assert.equal(stockByProduct.get('p1'), 7) // (5-1) + (3-0)
  assert.equal(stockByProduct.get('p2'), 0) // max(0, 2-4)
  assert.equal(stockByProductWarehouse.get('p1')?.get('wh-a'), 4)
  assert.equal(stockByProductWarehouse.get('p1')?.get('wh-b'), 3)
})

test('resolvePushStockQuantity clamps DOWN to fresh when stock dropped', () => {
  // snapshot said 5, fresh re-read says 2 -> push 2 (the oversell guard)
  assert.equal(resolvePushStockQuantity(5, 2, false), 2)
})

test('resolvePushStockQuantity never rises above the snapshot when fresh grew', () => {
  // fresh 9 > snapshot 3 -> stays 3 (clamp DOWN only; never push more than snapshot saw)
  assert.equal(resolvePushStockQuantity(3, 9, false), 3)
})

test('resolvePushStockQuantity floors fractional availability down', () => {
  assert.equal(resolvePushStockQuantity(2.6, 4, false), 2)
  assert.equal(resolvePushStockQuantity(5, 2.9, false), 2)
})

test('resolvePushStockQuantity returns 0 for lifecycle-forced-zero products', () => {
  assert.equal(resolvePushStockQuantity(10, 10, true), 0)
})

test('computeAvailableByProduct values a kit from fresh component stock (floor of component/required)', () => {
  // kit needs 2x c1 per kit; component stock 3 -> floor(3/2) = 1 kit
  const c1 = simpleProduct('c1')
  const kit = kitProduct('kit1', [{ componentId: 'c1', qty: 2 }])
  const products = [c1, kit]
  const productById = new Map(products.map((p) => [p.id, p]))
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(rows(['c1', 'wh-a', 3, 0]))
  const available = computeAvailableByProduct(products, ['wh-a'], stockByProduct, stockByProductWarehouse, productById, [])
  assert.equal(available.get('kit1'), 1)

  // a kit whose component stock just dropped is re-valued down by resolvePushStockQuantity
  assert.equal(resolvePushStockQuantity(3 /* snapshot kits */, available.get('kit1') ?? 0, false), 1)
})
