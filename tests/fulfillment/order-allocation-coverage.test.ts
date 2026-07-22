import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-9lx: selectOrdersNeedingAllocation is the single source of truth for "which orders still have
// outstanding allocation demand", shared by the replenishment backorder allocator and the periodic
// reallocation sweep. The real (pure) coverage math is exercised; only the product graph and the
// OrderAllocation read are stubbed.

// A SIMPLE product expands to a single leaf requirement of factor 1.
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})

let allocRows: Array<{ orderId: string; lineId: string; productId: string; qty: number }> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        findMany: async () => allocRows,
      },
    },
  },
})

async function load() {
  return (await import('@/lib/fulfillment/order-allocation-coverage')).selectOrdersNeedingAllocation
}

function order(id: string, qty: number, productId: string | null = 'p1') {
  return { id, lines: [{ id: `${id}-l1`, qty, productId }] }
}

test('an order with no allocations for its ordered line needs allocation', async () => {
  const select = await load()
  allocRows = []
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('a fully-allocated order is excluded', async () => {
  const select = await load()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a partially-allocated order still needs allocation', async () => {
  const select = await load()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 3 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('over-allocation (coverage >= qty) is not flagged', async () => {
  const select = await load()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 6 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a line with no productId is ignored (never flags the order)', async () => {
  const select = await load()
  allocRows = []
  const needing = await select([order('SO-1', 5, null)])
  assert.deepEqual(needing, [])
})

test('the lineNeedsAllocation predicate narrows which outstanding lines count', async () => {
  const select = await load()
  allocRows = []
  const orders = [order('SO-1', 5, 'p1'), order('SO-2', 5, 'p2')]
  // Only lines whose requirements touch p2 count -> only SO-2 is returned.
  const needing = await select(orders, (_line, reqs) => reqs.some((r) => r.productId === 'p2'))
  assert.deepEqual(needing.map((o) => o.id), ['SO-2'])
})

test('empty candidate list short-circuits to []', async () => {
  const select = await load()
  assert.deepEqual(await select([]), [])
})
