import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * SO-to-PO pegging, proved against a real Postgres: stock received on a pegged purchase-order line is allocated to the
 * pegged order first, the sweep (an oldest-first allocation) cannot hand it to an older order, a peg ends when its order line is
 * fully allocated or its order is cancelled, a peg over the unreceived quantity is refused, and two receipts landing at once
 * neither over-allocate nor lose the pegged order's share.
 *
 * "The receipt's peg pass" is allocateSalesOrder with capPeggedLines for each pegged order, exactly what
 * allocatePeggedOrdersForProducts does through autoAllocateOrder; "the sweep" is allocateSalesOrder for the older order, exactly
 * what the sweep and the backorder pass do. Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })

type Deps = Awaited<ReturnType<typeof loadDeps>>
type TestDb = Deps['db']

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl?.startsWith('postgres')) throw new Error('DATABASE_URL (a scratch Postgres) is required')
  const [{ PrismaClient }, { PrismaPg }, allocation, pegService] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/allocation-service'),
    import('@/lib/domain/sales/peg-service'),
  ])
  // PrismaPg gets a CONFIG, not a pg.Pool (see allocation-eligibility-guard.concurrent.test.ts for why).
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 8 }) })
  return { db, allocateSalesOrder: allocation.allocateSalesOrder, sweepPegs: pegService.sweepPegs }
}

type Fixture = { warehouseId: string; productId: string; supplierId: string; poId: string; poLineId: string; orderIds: string[]; lineIds: string[] }

async function makeOrder(db: TestDb, f: { warehouseId: string; productId: string }, qty: number, createdAt: Date, tag: string) {
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `PEG-${tag}-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', createdAt,
      subtotalForeign: 10 * qty, totalForeign: 10 * qty, subtotalBase: 10 * qty, totalBase: 10 * qty, shipFromWarehouseId: f.warehouseId,
      lines: { create: [{ productId: f.productId, description: 'peg line', sku: `PEG-${tag}`, qty, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10 * qty, totalBase: 10 * qty }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { orderId: order.id, lineId: order.lines[0]!.id }
}

/** A warehouse, a product with NO stock, and a sent PO with one line of 10. Orders are added per test, oldest first. */
async function createFixture(db: TestDb): Promise<Fixture> {
  const suffix = randomUUID()
  const warehouse = await db.warehouse.create({ data: { code: `PEG-${suffix.slice(0, 8)}`, name: `peg ${suffix}`, active: true, availableForSale: true, syncToStore: false, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `PEG-${suffix}`, name: `peg ${suffix}`, type: 'SIMPLE', oversellAllowed: false }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: 0, reservedQty: 0 } })
  const supplier = await db.supplier.create({ data: { name: `peg supplier ${suffix}` }, select: { id: true } })
  const po = await db.purchaseOrder.create({
    data: {
      reference: `PEG-PO-${suffix.slice(0, 12)}`, supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 100, subtotalBase: 100, totalForeign: 100, totalBase: 100, destinationWarehouseId: warehouse.id,
      lines: { create: [{ productId: product.id, qty: 10, unitCostForeign: 10, unitCostBase: 10, totalForeign: 100, totalBase: 100 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { warehouseId: warehouse.id, productId: product.id, supplierId: supplier.id, poId: po.id, poLineId: po.lines[0]!.id, orderIds: [], lineIds: [] }
}

async function destroyFixture(db: TestDb, f: Fixture) {
  const run = async (label: string, op: () => Promise<unknown>) => { try { await op() } catch (error) { console.warn(`peg cleanup ${label}: ${(error as Error).message}`) } }
  await run('pegs', () => db.salesOrderLinePeg.deleteMany({ where: { OR: [{ purchaseOrderLineId: f.poLineId }, { salesOrderLineId: { in: f.lineIds } }] } }))
  await run('allocations', () => db.orderAllocation.deleteMany({ where: { orderId: { in: f.orderIds } } }))
  await run('activity', () => db.activityLog.deleteMany({ where: { entityId: { in: [...f.orderIds, f.poId] } } }))
  await run('lines', () => db.salesOrderLine.deleteMany({ where: { orderId: { in: f.orderIds } } }))
  await run('orders', () => db.salesOrder.deleteMany({ where: { id: { in: f.orderIds } } }))
  await run('po', async () => { await db.purchaseOrderLine.deleteMany({ where: { poId: f.poId } }); await db.purchaseOrder.delete({ where: { id: f.poId } }) })
  await run('stock', () => db.stockLevel.deleteMany({ where: { productId: f.productId } }))
  await run('supplier', () => db.supplier.delete({ where: { id: f.supplierId } }))
  await run('product', () => db.product.delete({ where: { id: f.productId } }))
  await run('warehouse', () => db.warehouse.delete({ where: { id: f.warehouseId } }))
}

/** A receipt: units land on the PO line and in stock in ONE transaction, as the manual receipt does. */
async function receive(db: TestDb, f: Fixture, qty: number) {
  await db.$transaction(async (tx) => {
    await tx.purchaseOrderLine.update({ where: { id: f.poLineId }, data: { qtyReceived: { increment: qty } } })
    await tx.stockLevel.update({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } }, data: { quantity: { increment: qty } } })
  })
}

const allocated = async (db: TestDb, orderId: string) => Number((await db.orderAllocation.aggregate({ where: { orderId }, _sum: { qty: true } }))._sum.qty ?? 0)

async function peg(db: TestDb, f: Fixture, lineId: string, qty: number) {
  const createdAt = new Date()
  return db.salesOrderLinePeg.create({ data: { salesOrderLineId: lineId, purchaseOrderLineId: f.poLineId, qty, createdAt }, select: { id: true } })
}

test('a receipt allocates to the pegged order first and the remainder to the oldest order; the sweep cannot hand pegged stock to the older order', { skip: SKIP }, async () => {
  const { db, allocateSalesOrder } = await loadDeps()
  const f = await createFixture(db)
  try {
    const older = await makeOrder(db, f, 5, new Date('2026-01-01T00:00:00Z'), 'old')
    const pegged = await makeOrder(db, f, 3, new Date('2026-02-01T00:00:00Z'), 'new')
    f.orderIds.push(older.orderId, pegged.orderId); f.lineIds.push(older.lineId, pegged.lineId)
    await peg(db, f, pegged.lineId, 3)

    await receive(db, f, 4)
    // THE SWEEP RUNS FIRST (the receipt's own pass has not happened yet): the older, unpegged order is allocated oldest-first.
    await allocateSalesOrder(db, { orderId: older.orderId })
    assert.equal(await allocated(db, older.orderId), 1, 'only 4 landed and 3 are held for the pegged order: the older order gets 1, not 4')

    // The receipt's peg pass, then the normal oldest-first remainder.
    await allocateSalesOrder(db, { orderId: pegged.orderId, capPeggedLines: true })
    assert.equal(await allocated(db, pegged.orderId), 3)
    await allocateSalesOrder(db, { orderId: older.orderId })
    assert.equal(await allocated(db, older.orderId), 1)

    const live = await db.salesOrderLinePeg.findMany({ where: { salesOrderLineId: pegged.lineId } })
    assert.equal(live[0]!.endReason, 'FULLY_ALLOCATED', 'fully allocated ends the peg')
    assert.ok(live[0]!.endedAt)
    const log = await db.activityLog.findMany({ where: { entityId: pegged.orderId, action: 'peg_ended' } })
    assert.equal(log.length, 1, 'the reason is in the activity log')
    assert.match(log[0]!.description, /fully allocated/)

    // The remainder then follows the normal rule: a later receipt goes to the older order.
    await receive(db, f, 4)
    await allocateSalesOrder(db, { orderId: older.orderId })
    assert.equal(await allocated(db, older.orderId), 5)
    const stock = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } } })
    assert.equal(Number(stock.reservedQty), 8)
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})

test('the peg pass is capped at the stock that landed for the peg: it never takes free stock an older order is owed', { skip: SKIP }, async () => {
  const { db, allocateSalesOrder } = await loadDeps()
  const f = await createFixture(db)
  try {
    const older = await makeOrder(db, f, 5, new Date('2026-01-01T00:00:00Z'), 'old')
    const pegged = await makeOrder(db, f, 6, new Date('2026-02-01T00:00:00Z'), 'new')
    f.orderIds.push(older.orderId, pegged.orderId); f.lineIds.push(older.lineId, pegged.lineId)
    await peg(db, f, pegged.lineId, 2)
    await receive(db, f, 6)
    await allocateSalesOrder(db, { orderId: pegged.orderId, capPeggedLines: true })
    assert.equal(await allocated(db, pegged.orderId), 2, 'the pegged order wants 6 but is first only for its pegged 2')
    await allocateSalesOrder(db, { orderId: older.orderId })
    assert.equal(await allocated(db, older.orderId), 4, 'the remainder goes to the oldest order')
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})

test('pegs end when the order is cancelled (recorded in the activity log), and the swept stock is free again', { skip: SKIP }, async () => {
  const { db, sweepPegs } = await loadDeps()
  const f = await createFixture(db)
  try {
    const order = await makeOrder(db, f, 3, new Date('2026-02-01T00:00:00Z'), 'cxl')
    f.orderIds.push(order.orderId); f.lineIds.push(order.lineId)
    const created = await peg(db, f, order.lineId, 3)
    await db.salesOrder.update({ where: { id: order.orderId }, data: { status: 'CANCELLED' } })
    const swept = await sweepPegs(db)
    assert.ok(swept.ended.some((p) => p.pegId === created.id && p.reason === 'SALES_ORDER_CANCELLED'))
    const row = await db.salesOrderLinePeg.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(row.endReason, 'SALES_ORDER_CANCELLED')
    assert.equal((await db.activityLog.findMany({ where: { entityId: order.orderId, action: 'peg_ended' } })).length, 1)
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})

test('a peg ends when its PO line is received without covering it, or its PO is cancelled', { skip: SKIP }, async () => {
  const { db, sweepPegs } = await loadDeps()
  const f = await createFixture(db)
  try {
    const a = await makeOrder(db, f, 3, new Date('2026-02-01T00:00:00Z'), 'a')
    const b = await makeOrder(db, f, 3, new Date('2026-02-02T00:00:00Z'), 'b')
    f.orderIds.push(a.orderId, b.orderId); f.lineIds.push(a.lineId, b.lineId)
    const pa = await peg(db, f, a.lineId, 3)
    await db.purchaseOrder.update({ where: { id: f.poId }, data: { status: 'CANCELLED' } })
    const swept = await sweepPegs(db)
    assert.ok(swept.ended.some((p) => p.pegId === pa.id && p.reason === 'PURCHASE_ORDER_CANCELLED'))
    await db.purchaseOrder.update({ where: { id: f.poId }, data: { status: 'PO_SENT' } })
    const pb = await peg(db, f, b.lineId, 3)
    // The line's 10 land elsewhere (the line itself is edited down to 2): nothing left for the peg.
    await db.purchaseOrderLine.update({ where: { id: f.poLineId }, data: { qty: 2, qtyReceived: 2 } })
    const again = await sweepPegs(db)
    assert.ok(again.ended.some((p) => p.pegId === pb.id && p.reason === 'PURCHASE_LINE_RECEIVED_ELSEWHERE'))
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})

test('a peg over the unreceived quantity is refused, and a valid one is created and audited', { skip: SKIP }, async () => {
  mock.module('@/lib/auth/server', {
    namedExports: {
      requirePermission: async () => ({ user: { role: 'ADMIN' } }),
      requireInternalUser: async () => ({ user: { role: 'ADMIN' } }),
    },
  })
  const { db } = await loadDeps()
  const f = await createFixture(db)
  try {
    const order = await makeOrder(db, f, 20, new Date('2026-02-01T00:00:00Z'), 'ref')
    f.orderIds.push(order.orderId); f.lineIds.push(order.lineId)
    const { createPeg } = await import('@/app/actions/pegging')
    const over = await createPeg({ salesOrderLineId: order.lineId, purchaseOrderLineId: f.poLineId, qty: 11 })
    assert.equal(over.success, false)
    assert.match(over.success ? '' : over.error, /Only 10 of that purchase order line is still unreceived/)
    const ok = await createPeg({ salesOrderLineId: order.lineId, purchaseOrderLineId: f.poLineId, qty: 6 })
    assert.deepEqual(ok, { success: true })
    const second = await createPeg({ salesOrderLineId: order.lineId, purchaseOrderLineId: f.poLineId, qty: 5 })
    assert.equal(second.success, false, 'the line already has a live peg to that PO line, and only 4 is left unpegged on it')
    assert.equal((await db.activityLog.findMany({ where: { entityId: order.orderId, action: 'peg_created' } })).length, 1)
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})

test('two receipts landing at once, each followed by the peg pass and the oldest-first pass, neither over-allocate nor lose the pegged share', { skip: SKIP }, async () => {
  const { db, allocateSalesOrder } = await loadDeps()
  const f = await createFixture(db)
  try {
    const older = await makeOrder(db, f, 8, new Date('2026-01-01T00:00:00Z'), 'old')
    const pegged = await makeOrder(db, f, 4, new Date('2026-02-01T00:00:00Z'), 'new')
    const youngest = await makeOrder(db, f, 8, new Date('2026-03-01T00:00:00Z'), 'young')
    f.orderIds.push(older.orderId, pegged.orderId, youngest.orderId); f.lineIds.push(older.lineId, pegged.lineId, youngest.lineId)
    await peg(db, f, pegged.lineId, 4)

    const receiptThenAllocate = async (qty: number) => {
      await receive(db, f, qty)
      // The receipt's peg pass, then the oldest-first pass over every waiting order, and the sweep's re-run of the same.
      await allocateSalesOrder(db, { orderId: pegged.orderId, capPeggedLines: true })
      for (const order of [older, pegged, youngest]) await allocateSalesOrder(db, { orderId: order.orderId })
    }
    await Promise.all([receiptThenAllocate(3), receiptThenAllocate(3), receiptThenAllocate(2)])
    // One last quiescent pass, as the sweep's next tick would do.
    for (const order of [older, pegged, youngest]) await allocateSalesOrder(db, { orderId: order.orderId })

    const stock = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } } })
    assert.equal(Number(stock.quantity), 8)
    assert.equal(await allocated(db, pegged.orderId), 4, 'the pegged order gets its pegged 4')
    assert.equal(await allocated(db, older.orderId), 4, 'the oldest order gets the remainder')
    assert.equal(await allocated(db, youngest.orderId), 0)
    assert.equal(Number(stock.reservedQty), 8, 'reservedQty equals the allocations: nothing over-allocated, nothing lost')
    const row = await db.salesOrderLinePeg.findFirstOrThrow({ where: { salesOrderLineId: pegged.lineId } })
    assert.equal(row.endReason, 'FULLY_ALLOCATED')
    assert.equal(Number(row.receivedQty), 4)
    assert.equal(Number(row.allocatedQty), 4)
  } finally { await destroyFixture(db, f); await db.$disconnect() }
})
