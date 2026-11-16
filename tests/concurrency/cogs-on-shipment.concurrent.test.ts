import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * COGS ON SHIPMENT, PAID OR NOT (ACC-H12), through the real daily batch and refund service against a real Postgres.
 *
 * The rule (owner ruling): an order shipped before it is paid posts DR COGS / CR Inventory directly when it ships.
 * Group A2 never ran for it, so Allocated Inventory holds no debit for those units; the payment-time steps (A1
 * deferral, A2 reclassification, Group B) skip what is already costed; a written-off order keeps its cost; the
 * invoice already booked the revenue, so the shipment posts no revenue leg.
 *
 * Offline: the batch only writes PENDING sync-log rows and the refund service only RETURNS its syncs; no
 * connector is called and nothing reaches Xero. Every test asserts that the journals it produced balance.
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1.
 */

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ Prisma, PrismaClient }, { PrismaPg }, { createSalesOrderRefund }, { runDailyBatchSync }, { db: appDb }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/connectors/xero/daily-sync'),
    import('@/lib/db'),
  ])
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 4 }) })
  return { Prisma, db, appDb, createSalesOrderRefund, runDailyBatchSync }
}
type Rig = Awaited<ReturnType<typeof openRig>>

const SETTINGS: Array<[string, string]> = [
  ['xero_sync_enabled', 'true'], ['xero_cogs_account', '5000'], ['xero_inventory_account', '1200'],
  ['xero_allocated_inventory_account', '1210'], ['xero_unearned_revenue_account', '2100'], ['xero_sales_account', '4000'],
]
const accountingSettings = {
  connector: 'xero', syncEnabled: true, salesAccount: '4000', shippingAccount: '4010', discountAccount: '', cogsAccount: '5000',
  inventoryRevaluationAccount: '', inventoryAccount: '1200', allocatedInventoryAccount: '1210', unearnedRevenueAccount: '2100',
  transitAccount: '', accountsReceivableAccount: '', accountsPayableAccount: '', realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '', manufacturingOverheadAccount: '', euVatIossAccount: '', euVatDdpAccount: '', euFeeAccount: '',
  roundingDifferenceAccount: '', paymentAccountMap: '{}', invoiceUrlTemplate: '', billUrlTemplate: '', reverseChargeSalesTaxType: '',
} as never

type Line = { accountCode: string; debit?: number; credit?: number }
type Journal = { type: string; lines: Line[] }

/** An order of 4 units at 100 each, allocated 4 from one warehouse; shipments of 2 units cost 10 a unit. */
async function seed(rig: Rig, suffix: string, opts: { paid: boolean; shipUnits: number; allocQty?: number; qty?: number }) {
  const { Prisma, db } = rig
  const D = (v: string | number) => new Prisma.Decimal(String(v))
  const qty = opts.qty ?? 4
  const product = await db.product.create({ data: { sku: `CS-${suffix}`, name: `cs ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `CM${suffix.slice(0, 8)}`, name: `cs main ${suffix}` }, select: { id: true } })
  const returns = await db.warehouse.create({ data: { code: `CR${suffix.slice(0, 8)}`, name: `cs returns ${suffix}` }, select: { id: true } })
  const layer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: main.id, receivedQty: D(qty), remainingQty: D(qty - opts.shipUnits), unitCostBase: D('10') },
    select: { id: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `CS-${suffix.slice(0, 8)}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D(qty * 100), totalForeign: D(qty * 100), subtotalBase: D(qty * 100), taxBase: D('0'), totalBase: D(qty * 100),
      accountingInvoiceId: `INV-${suffix}`,
      ...(opts.paid ? { paidAt: new Date() } : {}),
      lines: { create: [{ productId: product.id, description: 'cs', qty: D(qty), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D(qty * 100), totalBase: D(qty * 100) }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: main.id, qty: D(opts.allocQty ?? qty) } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  const ids = { productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId, layerId: layer.id, shipmentIds: [] as string[] }
  const ship = async (units: number) => {
    const shipment = await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(), createdAt: new Date(Date.now() - 60_000 + ids.shipmentIds.length * 1000),
        lines: { create: [{ lineId, productId: product.id, qty: D(units), costLayerSnapshot: [{ costLayerId: layer.id, qty: String(units), unitCostBase: '10' }] }] },
      },
      select: { id: true },
    })
    ids.shipmentIds.push(shipment.id)
    return shipment.id
  }
  return { ...ids, ship }
}
type Fixture = Awaited<ReturnType<typeof seed>>

async function clean(rig: Rig, fx: Fixture | undefined) {
  const { db } = rig
  await db.accountingSyncLog.deleteMany({ where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B', 'DAILY_BATCH_INVENTORY_RECONCILIATION', 'DAILY_BATCH_COGS_RECONCILIATION', 'DAILY_BATCH_TRANSIT_RECONCILIATION'] } } }).catch(() => {})
  await db.cogsSubledgerMovement.deleteMany({ where: { OR: [{ idempotencyKey: { startsWith: 'dispatch:' } }, { idempotencyKey: { startsWith: 'refund-unjournaled-return:' } }] } }).catch(() => {})
  if (fx) {
    await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
    await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: fx.orderId } } }).catch(() => {})
    await db.stockMovement.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId: fx.productId } } }).catch(() => {})
    await db.costLayer.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
    await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.shipmentLine.deleteMany({ where: { shipment: { orderId: fx.orderId } } }).catch(() => {})
    await db.shipment.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
    await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.warehouse.deleteMany({ where: { id: { in: [fx.mainId, fx.returnsId] } } }).catch(() => {})
    await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
  }
}

async function close(rig: Rig) {
  await rig.db.$disconnect()
  await rig.appDb.$disconnect()
}

async function journals(rig: Rig): Promise<Journal[]> {
  const rows = await rig.db.accountingSyncLog.findMany({
    where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'] } },
    select: { type: true, payload: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({ type: row.type as string, lines: (row.payload as { lines: Line[] }).lines }))
}
const cents = (n: number) => Math.round(n * 100)
function assertBalanced(list: Journal[], label: string) {
  for (const journal of list) {
    const debit = journal.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
    const credit = journal.lines.reduce((s, l) => s + (l.credit ?? 0), 0)
    assert.equal(cents(debit), cents(credit), `${label}: ${journal.type} journal balances (DR ${debit} / CR ${credit})`)
  }
}
/** Net DR - CR on one account across the given journals. */
function net(list: Journal[], account: string, type?: string): number {
  return list.filter((j) => !type || j.type === type).flatMap((j) => j.lines).filter((l) => l.accountCode === account).reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0)
}

async function setup(rig: Rig) {
  for (const [key, value] of SETTINGS) await rig.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

test('ACC-H12: shipped before paid, then paid: COGS once, A1 defers only the unshipped part, A2 skips the costed units', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 2 })
    const shipment1 = await fx.ship(2)

    // 1. The unpaid shipment is costed when it ships: DR COGS / CR Inventory, no revenue leg, no Allocated Inventory.
    const run1 = await rig.runDailyBatchSync()
    assert.deepEqual(run1.errors, [], 'the batch ran clean')
    assert.equal(run1.groupB, 1)
    const afterShip = await journals(rig)
    assertBalanced(afterShip, 'on shipment')
    assert.equal(afterShip.length, 1, 'one journal: the shipment cost')
    assert.equal(net(afterShip, '5000'), 20, 'COGS DR 20 (2 units x 10)')
    assert.equal(net(afterShip, '1200'), -20, 'Inventory CR 20')
    assert.equal(net(afterShip, '1210'), 0, 'Allocated Inventory untouched')
    assert.equal(net(afterShip, '2100') + net(afterShip, '4000'), 0, 'no revenue leg: the invoice already booked it')
    const stamped = await rig.db.shipment.findUniqueOrThrow({ where: { id: shipment1 } })
    assert.ok(stamped.shipmentJournalDate && stamped.cogsRelievedFromInventoryAt, 'journal stamp and marker written together')
    assert.equal(Number(stamped.cogsRelievedFromInventoryAmount), 20)
    assert.ok(stamped.cogsRelievedFromInventorySyncLogId, 'the marker names its journal')
    assert.equal(Number(stamped.revenueRecognizedAmount), 200, 'the shipment records its revenue share (half the order)')
    assert.equal(Number(stamped.allocatedReliefAmount), 0, 'it relieved no Allocated Inventory')

    // 2. A rerun is a no-op (idempotent).
    const rerun = await rig.runDailyBatchSync()
    assert.deepEqual(rerun.errors, [])
    assert.equal(rerun.groupB, 0)
    assert.equal((await journals(rig)).length, 1, 'rerun posts nothing')

    // 3. Paid: A1 defers only the unshipped half; A2 pins only the 2 unshipped units; Group B does not cost shipment 1 again.
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { paidAt: new Date() } })
    const run2 = await rig.runDailyBatchSync()
    assert.deepEqual(run2.errors, [], 'the paid-day run is clean')
    const afterPay = await journals(rig)
    assertBalanced(afterPay, 'after payment')
    const a1 = afterPay.filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.equal(a1.length, 1)
    assert.equal(net(a1, '2100'), -200, 'A1 CR Unearned 200: only the part not yet shipped')
    assert.equal(net(a1, '4000'), 200, 'A1 DR Sales 200')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(Number(order.unearnedRevenueAmount), 400, 'the order keeps the FULL deferral figure')
    const a2 = afterPay.filter((j) => j.type === 'DAILY_BATCH_INVENTORY_ALLOC')
    assert.equal(a2.length, 1)
    assert.equal(net(a2, '1210'), 20, 'A2 DR Allocated 20: the 2 unshipped units only, not the 4 allocated')
    assert.equal(net(a2, '1200'), -20)
    assert.equal(Number(order.allocationBatchAmount), 20)
    assert.equal(afterPay.filter((j) => j.type === 'DAILY_BATCH_GROUP_B').length, 1, 'no second shipment journal for the costed units')
    assert.equal(net(afterPay, '5000'), 20, 'COGS still booked exactly once')

    // 4. The rest ships: ordinary path, true-up recognises the remaining 200, relieves exactly the pinned 2 units.
    await fx.ship(2)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    const run3 = await rig.runDailyBatchSync()
    assert.deepEqual(run3.errors, [], 'the second shipment run is clean')
    const all = await journals(rig)
    assertBalanced(all, 'final')
    assert.equal(net(all, '5000'), 40, 'COGS 4 x 10 for the whole order')
    assert.equal(net(all, '1200'), -40, 'Inventory relieved once per unit (20 directly + 20 through A2)')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero: 200 deferred, 200 recognised')
    assert.equal(net(all, '4000'), 0, 'Sales net of the deferral and its release is unchanged (the invoice booked it)')
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: shipped and never paid: the cost is booked at shipment and stays, no deferral or reclassification ever posts', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 4 })
    await fx.ship(4)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    for (let i = 0; i < 3; i++) {
      const run = await rig.runDailyBatchSync()
      assert.deepEqual(run.errors, [], `run ${i + 1} is clean`)
    }
    // The debt is written off: the order is closed without ever being paid. The cost was booked when the goods left.
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'COMPLETED' } })
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'written off')
    assert.equal(all.length, 1, 'exactly one journal, ever')
    assert.equal(net(all, '5000'), 40, 'the written-off order keeps its cost')
    assert.equal(net(all, '1200'), -40)
    assert.equal(all.filter((j) => j.type !== 'DAILY_BATCH_GROUP_B').length, 0, 'no A1 or A2 for an order that was never paid')
    const shipment = await rig.db.shipment.findFirstOrThrow({ where: { orderId: fx.orderId } })
    assert.equal(Number(shipment.revenueRecognizedAmount), 400, 'the true-up records the whole order as recognised, with no journal leg')
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: A2 does not double-value units already costed: everything shipped before payment, then paid', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 4 })
    await fx.ship(4)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { paidAt: new Date() } })
    const paid = await rig.runDailyBatchSync()
    assert.deepEqual(paid.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'paid after shipping')
    assert.equal(all.filter((j) => j.type === 'DAILY_BATCH_INVENTORY_ALLOC').length, 0, 'A2 raised no journal: nothing is left to reclassify')
    assert.equal(all.filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL').length, 0, 'A1 raised no journal: every pound already shipped')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory never touched')
    assert.equal(net(all, '5000'), 40, 'COGS once')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.ok(order.revenueDeferredDate, 'the order is still stamped deferred')
    assert.equal(Number(order.unearnedRevenueAmount), 400)
    assert.ok(order.inventoryAllocatedDate, 'and stamped allocated, so A2 never looks again')
    assert.equal(Number(order.allocationBatchAmount ?? 0), 0)
    const again = await rig.runDailyBatchSync()
    assert.deepEqual(again.errors, [])
    assertBalanced(await journals(rig), 'rerun')
    assert.equal((await journals(rig)).length, all.length, 'a further run posts nothing')
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: an unpaid shipment followed by a refund return: the COGS reversal goes to Inventory and nothing else is staged', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 2, qty: 2 })
    await fx.ship(2)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const costed = await journals(rig)
    assert.equal(net(costed, '5000'), 20)

    const refund = await rig.createSalesOrderRefund(rig.db, {
      orderId: fx.orderId,
      lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'cs', qty: 1, totalBase: 100 }],
      reason: 'Customer return', returnWarehouseId: fx.returnsId, creditNotePrefix: `CS${suffix.slice(0, 6)}-`,
      accountingSettings,
    })
    assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
    if (!refund.success) return
    const syncs = refund.accountingSyncs as unknown as Array<{ type: string; payload: { lines: Line[] } }>
    const cogs = syncs.find((s) => s.type === 'COGS_REVERSAL')
    assert.ok(cogs, 'the returned unit of a costed shipment owes a COGS reversal even though the order is unpaid')
    const reversal: Journal = { type: 'COGS_REVERSAL', lines: cogs!.payload.lines }
    assertBalanced([reversal], 'refund reversal')
    assert.equal(net([reversal], '1200'), 10, 'DR Inventory 10: the cost the unit was relieved at')
    assert.equal(net([reversal], '5000'), -10, 'CR COGS 10')
    assert.equal(net([reversal], '1210'), 0, 'never Allocated Inventory')
    assert.equal(syncs.some((s) => s.type === 'UNEARNED_REV_REVERSAL'), false, 'no deferral exists to unwind and no allocation was ever pinned')
    const returned = await rig.db.costLayer.findMany({ where: { productId: fx.productId, warehouseId: fx.returnsId }, select: { receivedQty: true, unitCostBase: true } })
    assert.deepEqual(returned.map((l) => [Number(l.receivedQty), Number(l.unitCostBase)]), [[1, 10]], 'the returned unit carries a layer at its issued cost; the journal debit equals it')
    const row = await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refund.createdRefund.id } })
    assert.ok(row.returnCostSplit, 'returnCostSplit is still recorded for the unjournaled-return path')
    assert.equal(Number(row.allocatedReliefAmount ?? 0), 0)

    // A rerun does not cost the shipment or the return twice.
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal((await journals(rig)).length, costed.length)
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: a paid order is unchanged: A1, A2, then Group B DR COGS / CR Allocated Inventory, no direct relief, no marker', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: true, shipUnits: 0, qty: 2 })
    const run1 = await rig.runDailyBatchSync()
    assert.deepEqual(run1.errors, [])
    const shipmentId = await fx.ship(2)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    const run2 = await rig.runDailyBatchSync()
    assert.deepEqual(run2.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'paid order')
    assert.equal(net(all, '2100'), 0, 'deferral fully recognised')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory: A2 debit relieved by Group B')
    assert.equal(net(all, '5000'), 20)
    assert.equal(net(all, '1200'), -20, 'Inventory relieved once, through Allocated Inventory')
    const groupB = all.filter((j) => j.type === 'DAILY_BATCH_GROUP_B')
    assert.equal(net(groupB, '1210'), -20, 'Group B credits Allocated Inventory, not Inventory')
    assert.equal(net(groupB, '1200'), 0)
    const shipment = await rig.db.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    assert.equal(shipment.cogsRelievedFromInventoryAt, null, 'no marker on an ordinarily costed shipment')
    assert.equal(Number(shipment.allocatedReliefAmount), 20)
    assert.ok(shipment.allocatedReliefSyncLogId)
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(Number(order.unearnedRevenueAmount), 200)
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: shipped before paid, paid, then fully refunded with the stock back: shipped cost reverses to Inventory, only the pinned remainder to Allocated Inventory', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 2 })
    await fx.ship(2)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { paidAt: new Date() } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const before = await journals(rig)
    assertBalanced(before, 'before the refund')
    // The refund proves the A2 debit against a SETTLED journal (queued is not posted), so settle the batch rows first.
    await rig.db.accountingSyncLog.updateMany({
      where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'] } },
      data: { status: 'SYNCED', syncedAt: new Date(), externalTransactionId: `JNL-${suffix}` },
    })

    const refund = await rig.createSalesOrderRefund(rig.db, {
      orderId: fx.orderId,
      lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'cs', qty: 4, totalBase: 400 }],
      reason: 'Customer return', returnWarehouseId: fx.returnsId, creditNotePrefix: `CS${suffix.slice(0, 6)}-`,
      accountingSettings, activeAccountingConnector: 'xero',
    })
    assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
    if (!refund.success) return
    const syncs = refund.accountingSyncs as unknown as Array<{ type: string; payload: { lines: Line[] } }>
    const cogs = syncs.find((s) => s.type === 'COGS_REVERSAL')
    const rest = syncs.find((s) => s.type === 'UNEARNED_REV_REVERSAL')
    assert.ok(cogs && rest)
    const cogsJournal: Journal = { type: 'COGS_REVERSAL', lines: cogs!.payload.lines }
    const restJournal: Journal = { type: 'UNEARNED_REV_REVERSAL', lines: rest!.payload.lines }
    assertBalanced([cogsJournal, restJournal], 'refund reversals')
    assert.equal(net([cogsJournal], '1200'), 20, 'the 2 shipped units (costed from Inventory) come back DR Inventory 20')
    assert.equal(net([cogsJournal], '5000'), -20)
    assert.equal(net([cogsJournal], '1210'), 0, 'the costed shipment never credits Allocated Inventory')
    assert.equal(net([restJournal], '1210'), -20, 'the 2 pinned (unshipped) units reverse the A2 debit: CR Allocated 20')
    assert.equal(net([restJournal], '1200'), 20, 'DR Inventory 20')
    assert.equal(net([restJournal], '2100'), 200, 'the unshipped half of the revenue leaves Unearned (400 stored - 200 recognised)')
    // Whole life of the order: Allocated Inventory and Unearned Revenue both net to zero.
    const lifetime = [...before, cogsJournal, restJournal]
    assert.equal(net(lifetime, '1210'), 0, 'Allocated Inventory nets to zero across A2 and the refund')
    assert.equal(net(lifetime, '2100'), 0, 'Unearned Revenue nets to zero across A1 and the refund')
    assert.equal(net(lifetime, '5000'), 0, 'COGS nets to zero: everything came back')
    assert.equal(net(lifetime, '1200'), 0, 'Inventory nets to zero: 40 relieved, 40 returned')
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})

test('ACC-H12: a lost costed-on-shipment journal is rebuilt DR COGS / CR Inventory with no revenue leg, and A1 later rebuilds at the unshipped part only', { skip }, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    await clean(rig, undefined)
    await setup(rig)
    fx = await seed(rig, suffix, { paid: false, shipUnits: 2 })
    await fx.ship(2)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { paidAt: new Date() } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const original = await journals(rig)
    assert.equal(original.length, 3, 'shipment cost, deferral, reclassification')
    // The two journals are lost from the sync log (a deleted row, not a settled one); the sweep rebuilds each once.
    await rig.db.accountingSyncLog.deleteMany({ where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_GROUP_B'] } } })
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const rebuilt = await journals(rig)
    assertBalanced(rebuilt, 'rebuilt')
    const groupB = rebuilt.filter((j) => j.type === 'DAILY_BATCH_GROUP_B')
    assert.equal(groupB.length, 1)
    assert.equal(net(groupB, '5000'), 20)
    assert.equal(net(groupB, '1200'), -20, 'rebuilt credit goes to Inventory')
    assert.equal(net(groupB, '1210'), 0)
    assert.equal(net(groupB, '2100') + net(groupB, '4000'), 0, 'no revenue leg is invented for the costed shipment')
    const a1 = rebuilt.filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.equal(a1.length, 1)
    assert.equal(net(a1, '2100'), -200, 'the deferral is rebuilt at the unshipped part, not the full 400')
    const again = await rig.runDailyBatchSync()
    assert.deepEqual(again.errors, [])
    assert.equal((await journals(rig)).length, rebuilt.length, 'rebuilt once')
  } finally {
    await clean(rig, fx)
    await close(rig)
  }
})
