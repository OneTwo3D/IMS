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
// o3d-kouj: the pinned per-line recipes this selector now reads for itself, keyed by line id. Empty
// means every line is unpinned, which is the pre-snapshot state the tests below were written for —
// so they still exercise the live-graph fallback, and the pinned path is asserted separately.
let lineSnapshotRows: Array<{ id: string; productId: string | null; fulfillmentRequirements: unknown }> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        findMany: async () => allocRows,
      },
      salesOrderRefundLine: {
        findMany: async () => refundLineRows,
      },
      salesOrderLine: {
        // Honours the id filter: a double that answered every id with every row would let a
        // snapshot seeded for one line silently answer for another.
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => lineSnapshotRows
          .filter((row) => where.id.in.includes(row.id)),
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
  lineSnapshotRows = []
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

// ---------------------------------------------------------------------------
// o3d-kouj — THE SELECTOR ASKS THE LINE, NOT THE CATALOGUE.
//
// This function decides which orders the 15-minute reallocation sweep and the backorder allocator
// pick up, by comparing ordered quantity against what the allocation rows cover. Those rows are in
// the COMPONENT units of the recipe the order was allocated from. Measuring them against the
// current graph is how a fully-covered kit order reads as permanently outstanding and gets
// destructively rewritten on every rotation — or, in the other direction, how a genuinely short one
// drops out of the sweep for good.
// ---------------------------------------------------------------------------

test('o3d-kouj: a pinned kit line is measured in ITS OWN component units, not the catalogue\'s', async () => {
  const select = await load()
  resetRefunds()
  // 5 kits ordered; the line was allocated when 1 kit = 2 x comp-1, so 10 component units cover it
  // exactly. The mocked graph says the line's product expands to itself at factor 1 — i.e. the
  // catalogue no longer describes this kit at all — so the pin is the only thing that can read the
  // rows correctly.
  lineSnapshotRows = [{
    id: 'SO-1-l1',
    productId: 'p1',
    fulfillmentRequirements: {
      version: 1,
      productId: 'p1',
      graphVersion: 4,
      capturedAt: '2026-08-01T00:00:00.000Z',
      requirements: [{ productId: 'comp-1', factor: '2' }],
    },
  }]
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'comp-1', qty: 10 }]

  assert.deepEqual(await select([order('SO-1', 5)]), [], 'ten component units ARE five kits')

  // One unit short of the pinned requirement, and it is selected again — the pin makes the
  // shortfall visible, it does not simply suppress selection.
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'comp-1', qty: 9 }]
  assert.deepEqual((await select([order('SO-1', 5)])).map((o) => o.id), ['SO-1'])
})
