import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextRequest } from 'next/server'

// Gates that fail OPEN if broken (a missing check still renders a page): the product actions, the stock-levels CSV, the stock-counts
// action and the adjustments CSV. Doubles only: no database, no network.

const SENTINEL_COST = '4321.5'
let role = 'WAREHOUSE'
const calls: string[] = []

function product(id: string, type: string) {
  return {
    id, sku: `SKU-${id}`, name: `Product ${id}`, type, stockUnit: 'pcs', active: true, lifecycleStatus: 'ACTIVE', category: null, parent: null,
    preferredSupplier: null, preferredSupplierLocked: false, variants: [], stockLevels: [{ quantity: '3', reservedQty: '0', warehouse: { id: 'w1', code: 'WH1', name: 'Main', type: 'STANDARD' } }],
    costLayers: [{ id: 'cl1', receivedAt: new Date('2026-01-01'), receivedQty: '3', remainingQty: '3', unitCostBase: SENTINEL_COST }],
    salesPriceBase: null, salePriceBase: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    tags: [], images: [], customFields: null,
  }
}

// A db double: every delegate method returns an empty list/null unless a fixture is given, and every call is recorded.
function delegate(name: string, overrides: Record<string, (args?: unknown) => unknown> = {}) {
  return new Proxy({}, {
    get: (_t, method: string) => (args?: unknown) => {
      calls.push(`${name}.${method}`)
      if (overrides[method]) return overrides[method]!(args)
      if (method === 'count') return 0
      if (method === 'findFirst' || method === 'findUnique') return null
      if (method === 'aggregate') return { _sum: {} }
      return []
    },
  })
}

const fixtures: Record<string, Record<string, (args?: unknown) => unknown>> = {}
const dbDouble = new Proxy({}, { get: (_t, name: string) => {
  if (name === '$queryRaw') return async () => { calls.push('$queryRaw'); return [{ productId: 'p1', unitCost: '12.5' }] }
  if (name === '$transaction') return async (fn: (tx: unknown) => unknown) => fn(dbDouble)
  return delegate(name, fixtures[name] ?? {})
} })

mock.module('@/lib/db', { namedExports: { db: dbDouble } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireInternalUser: async () => ({ user: { id: 'u1', role } }),
    requirePermission: async () => ({ user: { id: 'u1', role } }),
    getSession: async () => ({ user: { id: 'u1', role } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role } }),
    requireAuth: async () => ({ user: { id: 'u1', role } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (fn: unknown) => fn } })

const NO_VALUE_ROLES = ['WAREHOUSE', 'READONLY']
const VALUE_ROLES = ['ADMIN', 'MANAGER', 'FINANCE']

test('getProduct: no inventoryValue, no cost layers, no kit costing for WAREHOUSE and READONLY; ADMIN unchanged', async () => {
  fixtures.product = { findUnique: () => product('p1', 'SIMPLE') }
  const { getProduct } = await import('../app/actions/products.ts')
  for (const r of NO_VALUE_ROLES) {
    role = r
    calls.length = 0
    const detail = await getProduct('p1')
    assert.equal(detail!.inventoryValue, null, r)
    assert.deepEqual(detail!.costLayers, [], r)
    assert.ok(!JSON.stringify(detail).includes(SENTINEL_COST), r)
  }
  role = 'ADMIN'
  const admin = await getProduct('p1')
  assert.equal(admin!.inventoryValue, '12964.50')
  assert.equal(admin!.costLayers.length, 1)
})

test('getProduct: the cost-layer include is not requested, and no kit costing runs, without inventory.prices', async () => {
  let includeSeen: Record<string, unknown> | undefined
  fixtures.product = { findUnique: (args) => { includeSeen = (args as { include: Record<string, unknown> }).include; return product('k1', 'KIT') } }
  const { getProduct } = await import('../app/actions/products.ts')
  for (const r of NO_VALUE_ROLES) {
    role = r
    calls.length = 0
    await getProduct('k1')
    assert.equal(includeSeen && 'costLayers' in includeSeen, false, r)
    assert.ok(!calls.includes('productComponent.findMany'), `${r}: computeKitUnitCostBase not called`)
  }
  role = 'ADMIN'
  calls.length = 0
  await getProduct('k1')
  assert.ok(includeSeen && 'costLayers' in includeSeen)
  assert.ok(calls.includes('productComponent.findMany'))
})

test('listProducts: inventoryValue null and cost layers not queried without inventory.prices; ADMIN unchanged', async () => {
  let includeSeen: Record<string, unknown> | undefined
  fixtures.product = {
    findMany: (args) => { includeSeen = (args as { include: Record<string, unknown> }).include; return [product('p1', 'SIMPLE')] },
    count: () => 1,
  }
  const { listProducts } = await import('../app/actions/products.ts')
  for (const r of NO_VALUE_ROLES) {
    role = r
    const result = await listProducts({})
    assert.equal(result.products[0]!.inventoryValue, null, r)
    assert.equal(includeSeen && 'costLayers' in includeSeen, false, r)
    assert.ok(!JSON.stringify(result).includes(SENTINEL_COST), r)
  }
  role = 'FINANCE'
  const result = await listProducts({})
  assert.equal(result.products[0]!.inventoryValue, '12964.50')
  assert.ok(includeSeen && 'costLayers' in includeSeen)
})

test('stock-levels CSV: blank cost columns and no cost-layer read without inventory.prices; value roles keep them', async () => {
  fixtures.stockLevel = { findMany: () => [{ productId: 'p1', warehouseId: 'w1', quantity: '3', reservedQty: '0', product: { sku: 'S1', name: 'N', type: 'SIMPLE', stockUnit: 'pcs' }, warehouse: { code: 'WH1', name: 'Main' } }] }
  fixtures.costLayer = { findMany: () => [{ productId: 'p1', warehouseId: 'w1', remainingQty: '3', unitCostBase: SENTINEL_COST }] }
  const { GET } = await import('../app/api/export/stock-levels/route.ts')
  const request = () => new NextRequest('http://localhost/api/export/stock-levels')
  for (const r of NO_VALUE_ROLES) {
    role = r
    calls.length = 0
    const text = await (await GET(request())).text()
    const [header, line] = text.split('\r\n')
    assert.ok(header!.includes('unitCostBase') && header!.includes('inventoryValueBase'), 'headers kept')
    assert.ok(!text.includes(SENTINEL_COST) && !line!.includes('12964'), r)
    assert.ok(!calls.includes('costLayer.findMany'), `${r}: costLayer.findMany never called`)
  }
  for (const r of VALUE_ROLES) {
    role = r
    calls.length = 0
    const text = await (await GET(request())).text()
    assert.ok(text.includes('4321.500000'), r)
    assert.ok(calls.includes('costLayer.findMany'), r)
  }
})

test('adjustments CSV: unitCost blank (column kept) without inventory.prices; value roles keep it', async () => {
  fixtures.stockMovement = { findMany: () => [{ type: 'ADJUSTMENT', toWarehouseId: 'w1', fromWarehouseId: null, qty: '2', unitCostBase: SENTINEL_COST, note: 'Found', product: { sku: 'S1' }, toWarehouse: { code: 'WH1' }, fromWarehouse: null, createdAt: new Date() }] }
  const { GET } = await import('../app/api/export/adjustments/route.ts')
  const request = () => new Request('http://localhost/api/export/adjustments') as never
  for (const r of NO_VALUE_ROLES.filter((x) => x !== 'READONLY')) {
    role = r
    const text = await (await GET(request())).text()
    assert.ok(text.split('\r\n')[0]!.includes('unitCost'), 'header kept')
    assert.ok(!text.includes(SENTINEL_COST), r)
  }
  role = 'ADMIN'
  assert.ok((await (await GET(request())).text()).includes(SENTINEL_COST))
})

test('stock counts: unitCost is null and cost layers are not read without inventory.prices', async () => {
  const count = {
    id: 'c1', reference: 'SC-1', warehouseId: 'w1', status: 'IN_PROGRESS', prepared: true, notes: null, startedAt: null, completedAt: null, reconciledAt: null,
    createdAt: new Date('2026-01-01'), warehouse: { code: 'WH1', name: 'Main' },
    lines: [{ id: 'l1', productId: 'p1', sku: 'S1', expectedQty: '5', countedQty: '3', variance: '-2', reconciledQty: null, notes: null }],
  }
  fixtures.stockCount = { findUnique: () => count }
  const { getStockCount } = await import('../app/actions/stock-counts.ts')
  for (const r of NO_VALUE_ROLES.filter((x) => x !== 'READONLY')) {
    role = r
    calls.length = 0
    const result = await getStockCount('c1')
    assert.equal(result!.lines[0]!.unitCost, null, r)
    assert.ok(!calls.includes('$queryRaw'), `${r}: cost layers not read`)
  }
  role = 'ADMIN'
  calls.length = 0
  assert.equal((await getStockCount('c1'))!.lines[0]!.unitCost, 12.5)
  assert.ok(calls.includes('$queryRaw'))
})
