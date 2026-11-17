import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * SO-to-PO pegging, the Codex round-1 regressions, over a real Postgres and the REAL receipt and PO edit paths:
 *   1. a receipt into a warehouse other than the PO destination is held and allocated in THAT warehouse;
 *   2. saving a pristine PO (full edit) keeps the pegs on the lines it keeps and ends the others with a reason and an activity row;
 *   3. the sweep reaches every live peg, not only the first batch, and a closed PO's pegs hold nothing back;
 *   4. a landed-quantity correction does not earmark the same units twice.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

// The activity log has a foreign key to users: the session user is a real row, made in before().
const actor = { id: 'unset' }
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: actor.id, role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: actor.id, role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: actor.id, role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: actor.id, role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

test.before(async () => {
  if (!RUN) return
  fixtures.loadEnv()
  await fixtures.enableStockReceiptPosting()
  const { db } = await import('@/lib/db')
  actor.id = (await db.user.create({ data: { email: `${fixtures.uid()}@peg-fixes.test`, name: 'peg fixes', role: 'ADMIN', active: true, passwordHash: 'x' }, select: { id: true } })).id
})

// The guard refuses a database that holds users, so the actor is removed again (with the activity rows that name it).
test.after(async () => {
  if (!RUN || actor.id === 'unset') return
  const { db } = await import('@/lib/db')
  await db.activityLog.deleteMany({ where: { userId: actor.id } })
  await db.user.delete({ where: { id: actor.id } })
})

type Db = Awaited<typeof import('@/lib/db')>['db']

async function makeOrder(db: Db, f: { warehouseId: string; productId: string }, qty: number, createdAt: Date, tag: string) {
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `PEGFIX-${tag}-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', createdAt,
      subtotalForeign: 10 * qty, totalForeign: 10 * qty, subtotalBase: 10 * qty, totalBase: 10 * qty, shipFromWarehouseId: f.warehouseId,
      lines: { create: [{ productId: f.productId, description: 'peg line', sku: `PEGFIX-${tag}`, qty, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10 * qty, totalBase: 10 * qty }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { orderId: order.id, lineId: order.lines[0]!.id }
}

const pegTo = (db: Db, poLineId: string, lineId: string, qty: number) =>
  db.salesOrderLinePeg.create({ data: { salesOrderLineId: lineId, purchaseOrderLineId: poLineId, qty }, select: { id: true } })

const allocationsByWarehouse = async (db: Db, orderId: string) => {
  const rows = await db.orderAllocation.findMany({ where: { orderId }, select: { warehouseId: true, qty: true } })
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.warehouseId, (out.get(row.warehouseId) ?? 0) + Number(row.qty))
  return out
}

test('a receipt into a warehouse other than the PO destination is held and allocated in that warehouse, not the destination', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { allocateSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await fixtures.seedPo('peg-div', [10])
  const line = po.lines[0]!
  const warehouseB = await db.warehouse.create({ data: { code: `${fixtures.uid()}-WB`, name: 'peg divergent B', type: 'STANDARD', active: true, availableForSale: true }, select: { id: true } })
  try {
    // Existing, unrelated stock in the destination A.
    await db.stockLevel.update({ where: { productId_warehouseId: { productId: line.productId, warehouseId: po.warehouseId } }, data: { quantity: 5 } })
    const older = await makeOrder(db, { warehouseId: po.warehouseId, productId: line.productId }, 8, new Date('2026-01-01T00:00:00Z'), 'old')
    const pegged = await makeOrder(db, { warehouseId: po.warehouseId, productId: line.productId }, 3, new Date('2026-02-01T00:00:00Z'), 'new')
    const created = await pegTo(db, line.poLineId, pegged.lineId, 3)

    const received = await receivePurchaseOrder(po.poId, [{ poLineId: line.poLineId, qtyReceived: 3, warehouseId: warehouseB.id }], undefined, { confirmWarehouseDivergence: true })
    assert.equal(received.success, true, String(received.error))

    // The older order (the sweep) may not take the 3 that landed in B for the pegged order: it gets only A's 5.
    await allocateSalesOrder(db, { orderId: older.orderId })
    const olderRows = await allocationsByWarehouse(db, older.orderId)
    assert.equal(olderRows.get(warehouseB.id) ?? 0, 0, 'the hold sits on B, where the receipt landed')
    assert.equal(olderRows.get(po.warehouseId), 5)

    // The receipt's peg pass: the pegged order gets its 3 from B, and does not reserve anything in A.
    await allocateSalesOrder(db, { orderId: pegged.orderId, capPeggedLines: true })
    const peggedRows = await allocationsByWarehouse(db, pegged.orderId)
    assert.equal(peggedRows.get(warehouseB.id), 3)
    assert.equal(peggedRows.get(po.warehouseId) ?? 0, 0, 'existing stock in A is not pulled to the pegged order')
    const row = await db.salesOrderLinePeg.findUniqueOrThrow({ where: { id: created.id } })
    assert.deepEqual(row.receivedByWarehouse, { [warehouseB.id]: '3' })
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: line.poLineId } })
  }
})

test('saving a pristine purchase order keeps the pegs on the lines it keeps and ends the rest with a reason and an activity row', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await fixtures.seedPo('peg-edit', [10])
  const line = po.lines[0]!
  const order = await makeOrder(db, { warehouseId: po.warehouseId, productId: line.productId }, 6, new Date('2026-02-01T00:00:00Z'), 'edit')
  const edit = (qty: number, keepLineId: boolean) => ({
    currency: 'GBP', pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ ...(keepLineId ? { poLineId: line.poLineId } : {}), productId: line.productId, sku: line.sku, productName: 'p', qty, unitCostForeign: fixtures.UNIT_COST }],
  }) as Parameters<typeof updatePurchaseOrder>[1]
  try {
    const created = await pegTo(db, line.poLineId, order.lineId, 4)

    // Same line, quantity still covers the peg: the peg survives on the SAME line row.
    const saved = (qty: number, keep: boolean) => updatePurchaseOrder(po.poId, edit(qty, keep)).then((r) => { assert.equal(r.success, true, String(r.error)); return r })
    await saved(12, true)
    const row = await db.salesOrderLinePeg.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(row.endedAt, null, 'the stock promise survives the save')
    assert.equal(row.purchaseOrderLineId, line.poLineId)
    assert.equal(await db.purchaseOrderLine.count({ where: { id: line.poLineId } }), 1)
    assert.equal(Number((await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.poLineId } })).qty), 12, 'and the line carries the edit')

    // The line is cut below the pegged quantity: the peg ends with its line, and both entities' activity logs say why (the row
    // itself goes with the line, as it always has; the log is the record).
    await saved(2, true)
    assert.equal(await db.salesOrderLinePeg.count({ where: { id: created.id } }), 0)
    const ended = await db.activityLog.findMany({ where: { entityId: order.orderId, action: 'peg_ended' } })
    assert.equal(ended.length, 1)
    assert.equal((ended[0]!.metadata as { reason?: string }).reason, 'PURCHASE_LINE_REMOVED')
    assert.equal((await db.activityLog.findMany({ where: { entityId: po.poId, action: 'peg_ended' } })).length, 1)

    // The line is replaced by a new one (no line id in the request): the peg ends with its line, recorded first.
    const current = await db.purchaseOrderLine.findFirstOrThrow({ where: { poId: po.poId }, select: { id: true } })
    await pegTo(db, current.id, order.lineId, 1)
    await saved(5, false)
    assert.equal((await db.activityLog.findMany({ where: { entityId: order.orderId, action: 'peg_ended' } })).length, 2, 'the end was recorded before its line went')
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { salesOrderLineId: order.lineId } })
  }
})

test('the sweep reaches every live peg (more than one batch), and a closed PO\'s pegs hold nothing back', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { sweepPegs } = await import('@/lib/domain/sales/peg-service')
  const { allocateSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const po = await fixtures.seedPo('peg-many', [1000])
  const line = po.lines[0]!
  const prefix = `zzpeg${randomUUID().slice(0, 6)}`
  const count = 205
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`)
  const orderIds = ids.map((id) => `o${id}`)
  const lineIds = ids.map((id) => `l${id}`)
  try {
    await db.salesOrder.createMany({
      data: orderIds.map((id, i) => ({
        id, orderNumber: `PEGMANY-${id}`, status: i === count - 1 ? 'CANCELLED' as const : 'PROCESSING' as const, currency: 'GBP',
        subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10, shipFromWarehouseId: po.warehouseId,
      })),
    })
    await db.salesOrderLine.createMany({
      data: lineIds.map((id, i) => ({ id, orderId: orderIds[i]!, productId: line.productId, description: 'many', sku: 'PEGMANY', qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 })),
    })
    await db.salesOrderLinePeg.createMany({ data: ids.map((id, i) => ({ id, salesOrderLineId: lineIds[i]!, purchaseOrderLineId: line.poLineId, qty: 1 })) })

    const swept = await sweepPegs(db)
    assert.equal(swept.exhausted, true)
    assert.ok(swept.checked >= count, `every live peg is evaluated, not only the first 200 (checked ${swept.checked})`)
    const last = await db.salesOrderLinePeg.findUniqueOrThrow({ where: { id: ids[count - 1]! } })
    assert.equal(last.endReason, 'SALES_ORDER_CANCELLED', 'the peg beyond the first batch was evaluated and ended')
    assert.equal(await db.salesOrderLinePeg.count({ where: { id: { in: ids }, endedAt: null } }), count - 1)
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { id: { in: ids } } })
  }

  // Defence in depth: a CANCELLED PO's peg holds nothing back before the sweep has ended it.
  const po2 = await fixtures.seedPo('peg-closed', [10])
  const line2 = po2.lines[0]!
  const older = await makeOrder(db, { warehouseId: po2.warehouseId, productId: line2.productId }, 3, new Date('2026-01-01T00:00:00Z'), 'old')
  const pegged = await makeOrder(db, { warehouseId: po2.warehouseId, productId: line2.productId }, 3, new Date('2026-02-01T00:00:00Z'), 'new')
  try {
    await pegTo(db, line2.poLineId, pegged.lineId, 3)
    const received = await fixtures.receive(po2, line2, 3)
    assert.equal(received.success, true, String(received.error))
    await db.purchaseOrder.update({ where: { id: po2.poId }, data: { status: 'CANCELLED' } })
    await allocateSalesOrder(db, { orderId: older.orderId })
    assert.equal((await allocationsByWarehouse(db, older.orderId)).get(po2.warehouseId), 3, 'the cancelled PO\'s peg did not hold the stock back')
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: line2.poLineId } })
  }
})

test('a landed-quantity correction does not earmark the same units twice', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { lockPegsForProducts, loadLivePegs, refreshPegReceipts } = await import('@/lib/domain/sales/peg-service')
  const po = await fixtures.seedPo('peg-corr', [10])
  const line = po.lines[0]!
  const a = await makeOrder(db, { warehouseId: po.warehouseId, productId: line.productId }, 5, new Date('2026-02-01T00:00:00Z'), 'a')
  const b = await makeOrder(db, { warehouseId: po.warehouseId, productId: line.productId }, 5, new Date('2026-02-02T00:00:00Z'), 'b')
  const refresh = () => db.$transaction(async (tx) => {
    await lockPegsForProducts(tx, [line.productId])
    await refreshPegReceipts(tx, await loadLivePegs(tx, { purchaseOrderLineId: line.poLineId }))
  })
  const earmarked = async () => (await db.salesOrderLinePeg.findMany({ where: { purchaseOrderLineId: line.poLineId } })).map((p) => Number(p.receivedQty))
  try {
    await pegTo(db, line.poLineId, a.lineId, 5)
    await pegTo(db, line.poLineId, b.lineId, 5)
    const received = await fixtures.receive(po, line, 5)
    assert.equal(received.success, true, String(received.error))
    await refresh()
    assert.equal((await earmarked()).reduce((x, y) => x + y, 0), 5)

    // The receipt is corrected away, then the units land again.
    await db.purchaseOrderLine.update({ where: { id: line.poLineId }, data: { qtyReceived: 0 } })
    await db.costLayer.deleteMany({ where: { poLineId: line.poLineId } })
    await refresh()
    assert.equal((await earmarked()).reduce((x, y) => x + y, 0), 0, 'the earmark follows the landed quantity down')
    await db.purchaseOrderLine.update({ where: { id: line.poLineId }, data: { qtyReceived: 5 } })
    await refresh()
    assert.equal((await earmarked()).reduce((x, y) => x + y, 0), 5, 'holds total the 5 landed units, not 10')
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: line.poLineId } })
  }
})

test('a pegged line is served from its receipt before an unpegged line for the same product on the same order', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { allocateSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const po = await fixtures.seedPo('peg-twolines', [10])
  const line = po.lines[0]!
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `PEGFIX-two-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', shipFromWarehouseId: po.warehouseId,
      subtotalForeign: 60, totalForeign: 60, subtotalBase: 60, totalBase: 60,
      lines: { create: [
        { productId: line.productId, description: 'unpegged', sku: 'TWO-A', qty: 3, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 30, totalBase: 30 },
        { productId: line.productId, description: 'pegged', sku: 'TWO-B', qty: 3, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 30, totalBase: 30 },
      ] },
    },
    select: { id: true, lines: { select: { id: true, sku: true } } },
  })
  const unpeggedId = order.lines.find((l) => l.sku === 'TWO-A')!.id
  const peggedId = order.lines.find((l) => l.sku === 'TWO-B')!.id
  try {
    await pegTo(db, line.poLineId, peggedId, 3)
    const received = await fixtures.receive(po, line, 3)
    assert.equal(received.success, true, String(received.error))
    await allocateSalesOrder(db, { orderId: order.id, capPeggedLines: true })
    const byLine = async (lineId: string) => Number((await db.orderAllocation.aggregate({ where: { lineId }, _sum: { qty: true } }))._sum.qty ?? 0)
    assert.equal(await byLine(peggedId), 3, 'the pegged line gets the receipt')
    assert.equal(await byLine(unpeggedId), 0, 'the unpegged line does not consume it')
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: line.poLineId } })
  }
})

test('the peg pass allocates only pegged demand: a pegged order\'s unpegged line waits behind an older order for the same receipt', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { allocateSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const po = await fixtures.seedPo('peg-multi', [10, 10])
  const [p, q] = po.lines as [typeof po.lines[number], typeof po.lines[number]]
  const mk = (createdAt: Date, lines: Array<{ productId: string; qty: number }>) => db.salesOrder.create({
    data: {
      orderNumber: `PEGFIX-multi-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', createdAt, shipFromWarehouseId: po.warehouseId,
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: lines.map((l, i) => ({ productId: l.productId, description: `l${i}`, sku: `MULTI-${i}`, qty: l.qty, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10 * l.qty, totalBase: 10 * l.qty })) },
    },
    select: { id: true, lines: { select: { id: true, productId: true } } },
  })
  const older = await mk(new Date('2026-01-01T00:00:00Z'), [{ productId: q.productId, qty: 3 }])
  const newer = await mk(new Date('2026-02-01T00:00:00Z'), [{ productId: p.productId, qty: 3 }, { productId: q.productId, qty: 3 }])
  const total = async (orderId: string, productId: string) => Number((await db.orderAllocation.aggregate({ where: { orderId, productId }, _sum: { qty: true } }))._sum.qty ?? 0)
  try {
    await pegTo(db, p.poLineId, newer.lines.find((l) => l.productId === p.productId)!.id, 3)
    for (const line of [p, q]) assert.equal((await fixtures.receive(po, line, 3)).success, true)
    await allocateSalesOrder(db, { orderId: newer.id, capPeggedLines: true })
    assert.equal(await total(newer.id, p.productId), 3, 'the pegged line is served from its receipt')
    assert.equal(await total(newer.id, q.productId), 0, 'its unpegged Q line takes nothing in the peg pass')
    await allocateSalesOrder(db, { orderId: older.id })
    assert.equal(await total(older.id, q.productId), 3, 'the older order gets the Q')
  } finally {
    await db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: p.poLineId } })
  }
})
