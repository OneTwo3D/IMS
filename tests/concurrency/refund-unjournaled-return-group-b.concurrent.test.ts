import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-hqvrp.32 — stock returned BEFORE its shipment is journaled, then Group B runs, against a real Postgres.
 *
 * The return restocks at the issued cost with a cost layer, but refund staging only reads journaled shipments, so
 * it records no COGS reversal. Group B must then book it: DR Inventory / CR COGS for the returned value, beside
 * the shipment's own DR COGS / CR Allocated Inventory. Final GL: COGS = shipped - returned, Inventory debit =
 * the returned cost layer, Allocated Inventory credit = the whole shipped cost (the A2 contra is fully relieved).
 *
 * Offline: the batch only writes PENDING sync-log rows; no connector is called. Gated behind
 * RUN_DB_CONCURRENCY_TESTS=1.
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

type Line = { accountCode: string; debit?: number; credit?: number }

test('o3d-hqvrp.32: a partial return of an unjournaled shipment, then Group B: COGS = shipped - returned, Inventory debit = the returned layer', { skip }, async () => {
  const rig = await openRig()
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const keys = ['xero_sync_enabled', 'xero_cogs_account', 'xero_inventory_account', 'xero_allocated_inventory_account', 'xero_unearned_revenue_account', 'xero_sales_account']
  const ids: { productId?: string; orderId?: string; whs: string[] } = { whs: [] }
  try {
    for (const [key, value] of [['xero_sync_enabled', 'true'], ['xero_cogs_account', '5000'], ['xero_inventory_account', '1200'], ['xero_allocated_inventory_account', '1210'], ['xero_unearned_revenue_account', '2100'], ['xero_sales_account', '4000']]) {
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    const product = await db.product.create({ data: { sku: `GB-${suffix}`, name: 'gb', type: 'SIMPLE' }, select: { id: true } })
    ids.productId = product.id
    const main = await db.warehouse.create({ data: { code: `GM${suffix.slice(0, 8)}`, name: 'gb main' }, select: { id: true } })
    const returns = await db.warehouse.create({ data: { code: `GR${suffix.slice(0, 8)}`, name: 'gb returns' }, select: { id: true } })
    ids.whs = [main.id, returns.id]
    const layer = await db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: D('2'), remainingQty: D('0'), unitCostBase: D('45') }, select: { id: true } })
    const snapshot = [{ costLayerId: layer.id, qty: '2', unitCostBase: '45' }]
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `GB-${suffix.slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'),
        subtotalForeign: D('200'), totalForeign: D('200'), subtotalBase: D('200'), taxBase: D('0'), totalBase: D('200'),
        paidAt: new Date(), revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'), unearnedRevenueAmount: D('200'),
        inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'), allocationBatchAmount: D('90'),
        lines: { create: [{ productId: product.id, description: 'gb', qty: D('2'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('200'), totalBase: D('200') }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    ids.orderId = order.id
    const lineId = order.lines[0].id
    await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: main.id, qty: D('2'), costLayerSnapshot: snapshot, allocationBatchAmount: D('90') } })
    await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(), cogsBatchAmount: D('90'),
        lines: { create: [{ lineId, productId: product.id, qty: D('2'), costLayerSnapshot: snapshot }] },
      },
    })
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })

    // 1. A return of ONE unit before the shipment is journaled (accounting staging does not run: nothing journaled).
    const refund = await rig.createSalesOrderRefund(rig.db, {
      orderId: order.id,
      lines: [{ lineId, productId: product.id, description: 'gb', qty: 1, totalBase: 100 }],
      reason: 'Customer return', returnWarehouseId: returns.id, creditNotePrefix: `GB${suffix.slice(0, 6)}-`,
    })
    assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
    const layers = await db.costLayer.findMany({ where: { productId: product.id, warehouseId: returns.id }, select: { receivedQty: true, unitCostBase: true } })
    assert.deepEqual(layers.map((l) => [Number(l.receivedQty), Number(l.unitCostBase)]), [[1, 45]], 'the returned unit carries a layer at its issued cost')

    // 2. Group B runs.
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [], 'the batch ran clean')
    assert.equal(run.groupB, 1)
    const logs = await db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_GROUP_B' }, select: { payload: true } })
    const mine = logs.map((l) => l.payload as { lines: Line[] }).filter((p) => p.lines.some((line) => (line.debit ?? line.credit ?? 0) === 90))
    assert.equal(mine.length, 1, 'one Group B journal for the shipment')
    const lines = mine[0].lines
    const sum = (code: string, side: 'debit' | 'credit') => lines.filter((l) => l.accountCode === code).reduce((s, l) => s + (l[side] ?? 0), 0)
    const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0)
    const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0)
    assert.equal(Math.round(totalDebit * 100), Math.round(totalCredit * 100), 'the journal balances')
    assert.equal(sum('1200', 'debit'), 45, 'Inventory debit = the returned layer (1 x 45)')
    assert.equal(sum('5000', 'debit') - sum('5000', 'credit'), 45, 'COGS = shipped (90) - returned (45)')
    assert.equal(sum('1210', 'credit'), 90, 'the Allocated Inventory contra is relieved in full')

    // 3. A second batch run does not book the same return twice.
    await db.shipment.updateMany({ where: { orderId: order.id }, data: { shipmentJournalDate: null } })
    const again = await rig.runDailyBatchSync()
    assert.deepEqual(again.errors, [])
    const movements = await db.cogsSubledgerMovement.findMany({ where: { sourceType: 'REFUND_REVERSAL', idempotencyKey: { startsWith: 'refund-unjournaled-return:' }, sourceRef: refund.success ? refund.createdRefund.id : '' } })
    assert.equal(movements.length, 1, 'recorded once, keyed on the refund')
    assert.equal(Number(movements[0].baseDelta), -45)
    const logsAfter = await db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_GROUP_B' }, select: { payload: true } })
    const second = logsAfter.map((l) => l.payload as { lines: Line[] }).filter((p) => p.lines.some((line) => line.accountCode === '1200' && (line.debit ?? 0) > 0))
    assert.equal(second.length, 1, 'the return is in exactly one journal')
  } finally {
    void keys
    const oid = ids.orderId
    const pid = ids.productId
    if (oid) {
      await db.accountingSyncLog.deleteMany({ where: { type: 'DAILY_BATCH_GROUP_B' } }).catch(() => {})
      await db.cogsSubledgerMovement.deleteMany({ where: { idempotencyKey: { startsWith: 'refund-unjournaled-return:' } } }).catch(() => {})
      await db.cogsSubledgerMovement.deleteMany({ where: { idempotencyKey: { startsWith: 'dispatch:' } } }).catch(() => {})
      await db.activityLog.deleteMany({ where: { entityId: oid } }).catch(() => {})
      await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: oid } } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: oid } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId: oid } } }).catch(() => {})
      await db.shipment.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.orderAllocation.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: oid } }).catch(() => {})
    }
    if (pid) {
      await db.stockMovement.deleteMany({ where: { productId: pid } }).catch(() => {})
      await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId: pid } } }).catch(() => {})
      await db.costLayer.deleteMany({ where: { productId: pid } }).catch(() => {})
      await db.stockLevel.deleteMany({ where: { productId: pid } }).catch(() => {})
    }
    await db.warehouse.deleteMany({ where: { id: { in: ids.whs } } }).catch(() => {})
    if (pid) await db.product.delete({ where: { id: pid } }).catch(() => {})
    await db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('o3d-hqvrp.32: 3 units shipped across 3 shipments journaled in SEPARATE runs (batch limit 1), 2 returned first: each run books its own share, once', { skip }, async () => {
  const rig = await openRig()
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const previousLimit = process.env.XERO_DAILY_BATCH_LIMIT
  process.env.XERO_DAILY_BATCH_LIMIT = '1'
  let orderId: string | undefined
  let productId: string | undefined
  const whs: string[] = []
  try {
    for (const [key, value] of [['xero_sync_enabled', 'true'], ['xero_cogs_account', '5000'], ['xero_inventory_account', '1200'], ['xero_allocated_inventory_account', '1210'], ['xero_unearned_revenue_account', '2100'], ['xero_sales_account', '4000']]) {
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    const product = await db.product.create({ data: { sku: `GS-${suffix}`, name: 'gs', type: 'SIMPLE' }, select: { id: true } })
    productId = product.id
    const main = await db.warehouse.create({ data: { code: `SM${suffix.slice(0, 8)}`, name: 'gs main' }, select: { id: true } })
    const returns = await db.warehouse.create({ data: { code: `SR${suffix.slice(0, 8)}`, name: 'gs returns' }, select: { id: true } })
    whs.push(main.id, returns.id)
    const costs = ['40', '45', '50']
    const layers = [] as Array<{ id: string; unit: string }>
    for (const unit of costs) {
      const l = await db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: D('1'), remainingQty: D('0'), unitCostBase: D(unit) }, select: { id: true } })
      layers.push({ id: l.id, unit })
    }
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `GS-${suffix.slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'),
        subtotalForeign: D('300'), totalForeign: D('300'), subtotalBase: D('300'), taxBase: D('0'), totalBase: D('300'),
        paidAt: new Date(), revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'), unearnedRevenueAmount: D('300'),
        inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'), allocationBatchAmount: D('135'),
        lines: { create: [{ productId: product.id, description: 'gs', qty: D('3'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('300'), totalBase: D('300') }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    orderId = order.id
    const lineId = order.lines[0].id
    await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: main.id, qty: D('3'), allocationBatchAmount: D('135'), costLayerSnapshot: layers.map((l) => ({ costLayerId: l.id, qty: '1', unitCostBase: l.unit })) } })
    for (const [i, l] of layers.entries()) {
      await db.shipment.create({
        data: {
          orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(), cogsBatchAmount: D(l.unit), createdAt: new Date(Date.now() - (10 - i) * 60_000),
          lines: { create: [{ lineId, productId: product.id, qty: D('1'), costLayerSnapshot: [{ costLayerId: l.id, qty: '1', unitCostBase: l.unit }] }] },
        },
      })
    }
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })

    const refund = await rig.createSalesOrderRefund(rig.db, {
      orderId: order.id,
      lines: [{ lineId, productId: product.id, description: 'gs', qty: 2, totalBase: 200 }],
      reason: 'Customer return', returnWarehouseId: returns.id, creditNotePrefix: `GS${suffix.slice(0, 6)}-`,
    })
    assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
    const returnedLayers = await db.costLayer.findMany({ where: { productId: product.id, warehouseId: returns.id }, select: { unitCostBase: true, receivedQty: true } })
    const returnedValue = returnedLayers.reduce((s, l) => s + Number(l.unitCostBase) * Number(l.receivedQty), 0)
    assert.equal(returnedLayers.length, 2)

    let inventoryDebit = 0
    let cogsNet = 0
    for (let run = 0; run < 3; run++) {
      const r = await rig.runDailyBatchSync()
      assert.deepEqual(r.errors, [], `run ${run + 1} clean`)
      assert.equal(r.groupB, 1, `run ${run + 1} journals one shipment`)
    }
    const logs = await db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_GROUP_B' }, select: { payload: true } })
    for (const l of logs) {
      const lines = (l.payload as { lines: Line[] }).lines
      if (!lines.some((x) => x.accountCode === '1210')) continue
      inventoryDebit += lines.filter((x) => x.accountCode === '1200').reduce((s, x) => s + (x.debit ?? 0), 0)
      cogsNet += lines.filter((x) => x.accountCode === '5000').reduce((s, x) => s + (x.debit ?? 0) - (x.credit ?? 0), 0)
    }
    assert.equal(Math.round(inventoryDebit * 100), Math.round(returnedValue * 100), 'Inventory debit across the runs = the returned layers')
    assert.equal(Math.round(cogsNet * 100), Math.round((135 - returnedValue) * 100), 'COGS = shipped - returned')
    const rows = await db.cogsSubledgerMovement.findMany({ where: { idempotencyKey: { startsWith: 'refund-unjournaled-return:' } } })
    assert.equal(rows.length, 2, 'one row per (refund, source shipment)')
    const again = await rig.runDailyBatchSync()
    assert.equal(again.groupB, 0, 'nothing left to journal, nothing booked twice')
    assert.equal(await db.cogsSubledgerMovement.count({ where: { idempotencyKey: { startsWith: 'refund-unjournaled-return:' } } }), 2)
  } finally {
    if (previousLimit === undefined) delete process.env.XERO_DAILY_BATCH_LIMIT
    else process.env.XERO_DAILY_BATCH_LIMIT = previousLimit
    const oid = orderId
    if (oid) {
      await db.accountingSyncLog.deleteMany({ where: { type: 'DAILY_BATCH_GROUP_B' } }).catch(() => {})
      await db.cogsSubledgerMovement.deleteMany({ where: { OR: [{ idempotencyKey: { startsWith: 'refund-unjournaled-return:' } }, { idempotencyKey: { startsWith: 'dispatch:' } }] } }).catch(() => {})
      await db.activityLog.deleteMany({ where: { entityId: oid } }).catch(() => {})
      await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: oid } } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: oid } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId: oid } } }).catch(() => {})
      await db.shipment.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.orderAllocation.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: oid } }).catch(() => {})
    }
    if (productId) {
      await db.stockMovement.deleteMany({ where: { productId } }).catch(() => {})
      await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId } } }).catch(() => {})
      await db.costLayer.deleteMany({ where: { productId } }).catch(() => {})
      await db.stockLevel.deleteMany({ where: { productId } }).catch(() => {})
    }
    await db.warehouse.deleteMany({ where: { id: { in: whs } } }).catch(() => {})
    if (productId) await db.product.delete({ where: { id: productId } }).catch(() => {})
    await db.$disconnect()
    await rig.appDb.$disconnect()
  }
})
