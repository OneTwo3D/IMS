import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStockMaps,
  computeAvailableByProduct,
  clampEntriesToAvailable,
  type CandidateProduct,
  type PushEntry,
  type StockLevelSnapshotRow,
} from '@/lib/connectors/woocommerce/sync/stock-sync'

const WH = ['wh-a', 'wh-b']

function simpleProduct(id: string, lifecycleStatus: CandidateProduct['lifecycleStatus'] = 'ACTIVE'): CandidateProduct {
  return {
    id,
    sku: id,
    type: 'SIMPLE',
    lifecycleStatus,
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
      // Prisma.Decimal-like: computeKitAvailability only does Number(component.qty)
      qty: c.qty as unknown as CandidateProduct['productComponents'][number]['qty'],
      component: { type: 'SIMPLE', lifecycleStatus: 'ACTIVE' },
    })),
  }
}

function pushEntry(productId: string, stockQuantity: number): PushEntry {
  return {
    productId,
    sku: productId,
    externalId: 1,
    payload: { id: 1, stock_quantity: stockQuantity, manage_stock: true },
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
  // p1: (5-1) + (3-0) = 7
  assert.equal(stockByProduct.get('p1'), 7)
  // p2: max(0, 2-4) = 0 (negative clamped)
  assert.equal(stockByProduct.get('p2'), 0)
  assert.equal(stockByProductWarehouse.get('p1')?.get('wh-a'), 4)
  assert.equal(stockByProductWarehouse.get('p1')?.get('wh-b'), 3)
})

test('clampEntriesToAvailable lowers a payload when fresh stock dropped', () => {
  const products = [simpleProduct('p1')]
  const productById = new Map(products.map((p) => [p.id, p]))
  const fresh = computeAvailableByProduct(
    products,
    WH,
    new Map([['p1', 2]]),
    new Map(),
    productById,
    [],
  )
  // snapshot pushed 5, but only 2 are available now
  const entries = [pushEntry('p1', 5)]
  clampEntriesToAvailable(entries, fresh, productById)
  assert.equal(entries[0].payload.stock_quantity, 2)
})

test('clampEntriesToAvailable never raises a payload when fresh stock grew', () => {
  const products = [simpleProduct('p1')]
  const productById = new Map(products.map((p) => [p.id, p]))
  const fresh = computeAvailableByProduct(products, WH, new Map([['p1', 9]]), new Map(), productById, [])
  const entries = [pushEntry('p1', 3)]
  clampEntriesToAvailable(entries, fresh, productById)
  // stale-low is harmless and must NOT be raised (oversell-safe)
  assert.equal(entries[0].payload.stock_quantity, 3)
})

test('clampEntriesToAvailable floors fractional fresh availability down', () => {
  const products = [simpleProduct('p1')]
  const productById = new Map(products.map((p) => [p.id, p]))
  const fresh = computeAvailableByProduct(products, WH, new Map([['p1', 2.6]]), new Map(), productById, [])
  const entries = [pushEntry('p1', 5)]
  clampEntriesToAvailable(entries, fresh, productById)
  assert.equal(entries[0].payload.stock_quantity, 2)
})

test('clampEntriesToAvailable leaves lifecycle-forced-zero products at 0', () => {
  const products = [simpleProduct('p1', 'ARCHIVED')]
  const productById = new Map(products.map((p) => [p.id, p]))
  // even if fresh stock says 10, an archived product stays forced-zero
  const fresh = computeAvailableByProduct(products, WH, new Map([['p1', 10]]), new Map(), productById, [])
  const entries = [pushEntry('p1', 0)]
  clampEntriesToAvailable(entries, fresh, productById)
  assert.equal(entries[0].payload.stock_quantity, 0)
})

test('clamp re-evaluates kit availability from fresh component stock', () => {
  // kit needs 2x component c1 per kit; component stock dropped to 3 -> floor(3/2)=1 kit
  const c1 = simpleProduct('c1')
  const kit = kitProduct('kit1', [{ componentId: 'c1', qty: 2 }])
  const products = [c1, kit]
  const productById = new Map(products.map((p) => [p.id, p]))
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(rows(['c1', 'wh-a', 3, 0]))
  const fresh = computeAvailableByProduct(products, ['wh-a'], stockByProduct, stockByProductWarehouse, productById, [])
  assert.equal(fresh.get('kit1'), 1)

  // snapshot had pushed 3 kits; clamp must drop to 1
  const entries = [pushEntry('kit1', 3)]
  clampEntriesToAvailable(entries, fresh, productById)
  assert.equal(entries[0].payload.stock_quantity, 1)
})
