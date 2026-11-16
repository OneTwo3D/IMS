import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateHeldUnits,
  unallocatedRemainder,
  loadWcHeldUnitsByProduct,
  WC_HELD_ORDERS_MAX_PAGES,
  WC_HELD_ORDERS_PAGE_SIZE,
  type HeldProductRef,
  type WcHeldUnitsDeps,
} from '@/lib/connectors/woocommerce/sync/stock-held-orders'
import { buildStockMaps } from '@/lib/connectors/woocommerce/sync/stock-sync'

const simple = (id: string, ext: number, sku = id): HeldProductRef => ({ id, sku, type: 'SIMPLE', externalProductId: ext, components: [] })
const order = (id: number, ...lines: [number, number, number][]) => ({
  id,
  line_items: lines.map(([product_id, variation_id, quantity]) => ({ product_id, variation_id, quantity, sku: '' })),
})

function deps(over: Partial<WcHeldUnitsDeps> & { pages?: unknown[][] }): WcHeldUnitsDeps {
  const pages = over.pages ?? [[]]
  return {
    fetchOrdersPage: over.fetchOrdersPage ?? (async (_s, page) => ({ data: pages[page - 1] ?? [] })),
    findImportedOrders: over.findImportedOrders ?? (async () => new Map<string, Map<string, number>>()),
    findProducts: over.findProducts ?? (async () => [simple('p1', 11)]),
    findVariationIdsByParentExternalId: over.findVariationIdsByParentExternalId ?? (async () => []),
  }
}

test('BACS on-hold order IMS never imported is held against the product (the audit scenario)', async () => {
  const r = await loadWcHeldUnitsByProduct(deps({ pages: [[order(1, [11, 0, 1])]] }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 1)
  // 1 unit in stock, nothing reserved: the absolute push must be 0, not 1.
  const { stockByProduct } = buildStockMaps([{ productId: 'p1', warehouseId: 'w', quantity: 1, reservedQty: 0 }], r.heldByProduct)
  assert.equal(stockByProduct.get('p1'), 0)
})

test('a linked, FULLY allocated order is not charged', async () => {
  const r = await loadWcHeldUnitsByProduct(deps({
    pages: [[order(1, [11, 0, 2]), order(2, [11, 0, 3])]],
    findImportedOrders: async () => new Map([['1', new Map([['p1', 2]])]]),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 3)
  assert.equal(r.ordersConsidered, 1)
})

test('a linked, PARTIALLY allocated order is charged its unallocated remainder; an unallocated one in full', async () => {
  const r = await loadWcHeldUnitsByProduct(deps({
    pages: [[order(1, [11, 0, 5]), order(2, [11, 0, 4])]],
    findImportedOrders: async () => new Map([['1', new Map([['p1', 2]])], ['2', new Map<string, number>()]]),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 3 + 4)
  assert.equal(unallocatedRemainder(new Map([['a', 2]]), new Map([['a', 5]])).size, 0) // over-coverage never goes negative
})

test('variation id wins over parent product id; sku is the fallback', () => {
  const products = [simple('parent', 10), simple('var', 12), simple('bysku', 99, 'SKU-X')]
  const { held, unresolvedLines } = aggregateHeldUnits(
    [
      { productId: 10, variationId: 12, sku: '', quantity: 2 },
      { productId: 0, variationId: 0, sku: 'SKU-X', quantity: 1 },
      { productId: 777, variationId: 0, sku: '', quantity: 5 }, // unknown: ignored
    ],
    products,
  )
  assert.equal(unresolvedLines.length, 0)
  assert.equal(held.get('var'), 2)
  assert.equal(held.get('parent'), undefined)
  assert.equal(held.get('bysku'), 1)
})

test('a KIT line is charged to its components (nested kits included), never to the kit', () => {
  const inner: HeldProductRef = { id: 'inner', sku: 'inner', type: 'KIT', externalProductId: null, components: [{ componentId: 'c2', qty: 3 }] }
  const kit: HeldProductRef = { id: 'kit', sku: 'kit', type: 'KIT', externalProductId: 50, components: [{ componentId: 'c1', qty: 2 }, { componentId: 'inner', qty: 1 }] }
  const { held } = aggregateHeldUnits([{ productId: 50, variationId: 0, sku: '', quantity: 2 }], [kit, inner, simple('c1', 1), simple('c2', 2)])
  assert.equal(held.get('c1'), 4)
  assert.equal(held.get('c2'), 6)
  assert.equal(held.get('kit'), undefined)
})

test('a kit cycle does not loop', () => {
  const a: HeldProductRef = { id: 'a', sku: 'a', type: 'KIT', externalProductId: 1, components: [{ componentId: 'b', qty: 1 }] }
  const b: HeldProductRef = { id: 'b', sku: 'b', type: 'KIT', externalProductId: null, components: [{ componentId: 'a', qty: 1 }] }
  assert.equal(aggregateHeldUnits([{ productId: 1, variationId: 0, sku: '', quantity: 1 }], [a, b]).held.size, 0)
})

test('held units come out of warehouse rows in turn and never below zero', () => {
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(
    [
      { productId: 'p', warehouseId: 'a', quantity: 2, reservedQty: 0 },
      { productId: 'p', warehouseId: 'b', quantity: 5, reservedQty: 1 },
    ],
    new Map([['p', 3]]),
  )
  assert.equal(stockByProduct.get('p'), 3) // 2 + 4 - 3
  assert.equal(stockByProductWarehouse.get('p')?.get('a'), 0)
  assert.equal(stockByProductWarehouse.get('p')?.get('b'), 3)
  assert.equal(buildStockMaps([{ productId: 'p', warehouseId: 'a', quantity: 1, reservedQty: 0 }], new Map([['p', 9]])).stockByProduct.get('p'), 0)
  // no held map: unchanged behaviour
  assert.equal(buildStockMaps([{ productId: 'p', warehouseId: 'a', quantity: 4, reservedQty: 1 }]).stockByProduct.get('p'), 3)
})

test('fails closed when the order read errors, throws, is not a list, or is truncated', async () => {
  const bad = async (d: Partial<WcHeldUnitsDeps> & { pages?: unknown[][] }) => (await loadWcHeldUnitsByProduct(deps(d))).ok
  assert.equal(await bad({ fetchOrdersPage: async () => ({ data: null, error: 'WC API error: 500' }) }), false)
  assert.equal(await bad({ fetchOrdersPage: async () => { throw new Error('boom') } }), false)
  assert.equal(await bad({ fetchOrdersPage: async () => ({ data: { not: 'a list' } }) }), false)
  assert.equal(await bad({ pages: [[{ id: 5, line_items: 'nope' }]] }), false)
})

test('walks multiple pages until a short one', async () => {
  const p1 = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1, [11, 0, 1]))
  const r = await loadWcHeldUnitsByProduct(deps({ pages: [p1, [order(999, [11, 0, 2])]] }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), WC_HELD_ORDERS_PAGE_SIZE + 2)
})

test('an unmapped variation is NEVER charged to its VARIABLE parent: its variations are blocked instead', async () => {
  const parent: HeldProductRef = { id: 'parent', sku: 'P', type: 'VARIABLE', externalProductId: 10, components: [] }
  const r = await loadWcHeldUnitsByProduct(deps({
    pages: [[order(1, [10, 555, 2])]],
    findProducts: async () => [parent],
    findVariationIdsByParentExternalId: async (ids) => (ids.includes(10) ? ['var-a', 'var-b'] : []),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.size, 0)
  assert.deepEqual([...r.blockedProductIds].sort(), ['var-a', 'var-b'])
})

test('a variation matches by its id, then by SKU', () => {
  const v = simple('v', 12, 'V-SKU')
  const viaSku = aggregateHeldUnits([{ productId: 10, variationId: 999, sku: 'V-SKU', quantity: 1 }], [v])
  assert.equal(viaSku.held.get('v'), 1)
  const none = aggregateHeldUnits([{ productId: 10, variationId: 999, sku: '', quantity: 1 }], [v])
  assert.equal(none.unresolvedLines.length, 1)
})

test('a huge queue is walked to its end (no 2,000-order freeze) and a short page ends it', async () => {
  const full = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1, [11, 0, 1]))
  const pages = [...Array.from({ length: 30 }, () => full), [order(9999, [11, 0, 1])]]
  const r = await loadWcHeldUnitsByProduct(deps({ pages }))
  assert.ok(r.ok)
  assert.equal(r.truncated, false)
  assert.equal(r.heldByProduct.get('p1'), 30 * WC_HELD_ORDERS_PAGE_SIZE + 1)
})

test('hitting the safety ceiling reports truncated (the caller then pushes only forced zeros)', async () => {
  const full = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1))
  const r = await loadWcHeldUnitsByProduct(deps({ fetchOrdersPage: async () => ({ data: full }) }))
  assert.ok(r.ok)
  assert.equal(r.truncated, true)
  assert.ok(WC_HELD_ORDERS_MAX_PAGES >= 100)
})
