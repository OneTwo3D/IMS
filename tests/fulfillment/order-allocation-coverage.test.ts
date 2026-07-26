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
let refundLineRows: Array<{ salesOrderLineId: string | null; qty: number; refund: { orderId: string } }> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        findMany: async () => allocRows,
      },
      salesOrderRefundLine: {
        findMany: async () => refundLineRows,
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

// Every existing test predates the refund netting; default to "nothing refunded".
function resetRefunds() {
  refundLineRows = []
}

test('an order with no allocations for its ordered line needs allocation', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('a fully-allocated order is excluded', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a partially-allocated order still needs allocation', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 3 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('over-allocation (coverage >= qty) is not flagged', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 6 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a line with no productId is ignored (never flags the order)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const needing = await select([order('SO-1', 5, null)])
  assert.deepEqual(needing, [])
})

test('the lineNeedsAllocation predicate narrows which outstanding lines count', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const orders = [order('SO-1', 5, 'p1'), order('SO-2', 5, 'p2')]
  // Only lines whose requirements touch p2 count -> only SO-2 is returned.
  const needing = await select(orders, (_line, reqs) => reqs.some((r) => r.productId === 'p2'))
  assert.deepEqual(needing.map((o) => o.id), ['SO-2'])
})

test('empty candidate list short-circuits to []', async () => {
  const select = await load()
  resetRefunds()
  assert.deepEqual(await select([]), [])
})

// --- o3d-jby: demand is NET of refunds, matching allocateSalesOrder ---------

test('a partially refunded line covered on NET demand is excluded (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // 10 ordered, 5 refunded, 5 allocated. allocateSalesOrder nets refunds under the lock and
  // considers this fully covered; comparing against GROSS qty here made the selector disagree
  // and hand the order back on every sweep rotation — each one resetting staged allocation
  // accounting and rewriting identical allocations.
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 5, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [], 'net demand 5 is fully covered by 5 allocated')
})

test('a partially refunded line still SHORT on net demand is included (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // 10 ordered, 2 refunded, 5 allocated -> net demand 8, still 3 short.
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 2, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'netting refunds must not hide real shortfall')
})

test('a fully refunded, unallocated line is not selected forever (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 10, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [], 'zero net demand is not outstanding demand')
})

test('over-refunding clamps net demand at zero rather than going negative (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 12, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [])
})

test('refund lines not linked to an order line are ignored (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // A monetary-only refund line carries no salesOrderLineId; it reduces no line's demand.
  allocRows = []
  refundLineRows = [{ salesOrderLineId: null, qty: 10, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'an unlinked refund line must not cancel demand')
})

test('a FULL-refunded order is excluded even with no linked refund lines (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // allocateSalesOrder short-circuits on refundStatus rather than netting lines, so a full
  // MONETARY refund (nothing linked to an order line) is zero demand there. Without the same
  // short-circuit here, gross demand survived and the order was rewritten every rotation.
  allocRows = []
  refundLineRows = []

  const needing = await select([{ ...order('SO-1', 10), refundStatus: 'FULL' }])

  assert.deepEqual(needing.map((o) => o.id), [])
})

test('a PARTIAL refundStatus still uses per-line netting (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = []

  const needing = await select([{ ...order('SO-1', 10), refundStatus: 'PARTIAL' }])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'only FULL is unconditional zero demand')
})

test('a refund linked to ANOTHER order cannot cancel this order\'s demand (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // Nothing in the schema enforces that a refund line's salesOrderLineId belongs to its refund's
  // order, and createSalesOrderRefund does not validate it. Keyed by line id alone, order A's
  // mislinked refund would cancel order B's demand and drop B out of the sweep for good.
  allocRows = []
  refundLineRows = [
    { salesOrderLineId: 'SO-2-l1', qty: 10, refund: { orderId: 'SO-1' } },
  ]

  const needing = await select([order('SO-1', 10), order('SO-2', 10)])

  assert.deepEqual(
    needing.map((o) => o.id).sort(),
    ['SO-1', 'SO-2'],
    'the bad link is inert: it nets against SO-1 (which has no such line) and leaves SO-2 alone',
  )
})
