import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * Two refund defects against a real Postgres, through the real `createSalesOrderRefund`.
 *
 * (1) NO STOCK RETURNED, NO COGS REVERSAL. A refund of shipped units that returns no stock used to post
 *     DR Inventory / CR COGS for the shipped cost, with no stock and no cost layer coming back: the GL
 *     Inventory account then sat above the cost-layer sub-ledger by exactly that amount and margin was
 *     overstated. The rule: COGS is the cost of goods that LEFT; if the goods are not back, the cost
 *     stays expensed (as for a chargeback). The control arm (stock returned) still reverses, and its
 *     debit equals the value of the cost layer that came back, which is what makes the first arm meaningful.
 *
 * (2) A RESTOCKED UNIT CARRIES A COST LAYER. Returns of shipments that were never journaled (or on orders
 *     with accounting off) used to restock stock with no cost layer. The unit now comes back at the ISSUED
 *     cost of the shipment, in dispatch order. Where that cost is not on record the operator's return is
 *     refused, and a storefront refund (already issued, so it cannot be refused) parks the units with a
 *     WARNING instead of restocking costless stock.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`). Offline: no connector is called, the
 * accounting syncs are only RETURNED by the service.
 */

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

  const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { createSalesOrderRefund }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/refund-service'),
  ])
  // Config form, not `new PrismaPg(pool)` (o3d-4ajo).
  const poolConfig = { connectionString: databaseUrl, max: 4 }
  const pool = new pg.Pool(poolConfig)
  const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
  return { Prisma, db, pool, createSalesOrderRefund }
}

type Rig = Awaited<ReturnType<typeof openRig>>
type Fixture = Awaited<ReturnType<typeof seed>>

const accountingSettings = {
  connector: 'xero',
  syncEnabled: true,
  salesAccount: '4000',
  shippingAccount: '4010',
  discountAccount: '',
  cogsAccount: '5000',
  inventoryRevaluationAccount: '',
  inventoryAccount: '1200',
  allocatedInventoryAccount: '1210',
  unearnedRevenueAccount: '2100',
  transitAccount: '',
  accountsReceivableAccount: '',
  accountsPayableAccount: '',
  realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '',
  manufacturingOverheadAccount: '',
  euVatIossAccount: '',
  euVatDdpAccount: '',
  euFeeAccount: '',
  roundingDifferenceAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
  reverseChargeSalesTaxType: '',
} as never

/**
 * One order line of 2 units shipped in one SHIPPED shipment. `layers` are the cost layers the dispatch consumed
 * (real rows, so the returned unit's layer can copy their sources); `snapshot` says whether the shipment line
 * records them. `journaled` stamps the shipment and the order as already journaled.
 */
async function seed(rig: Rig, suffix: string, opts: { layers: Array<{ qty: string; unit: string }>; snapshot?: boolean; journaled?: boolean }) {
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const product = await db.product.create({ data: { sku: `RC-${suffix}`, name: `rc ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `RM${suffix.slice(0, 8)}`, name: `rc main ${suffix}` }, select: { id: true } })
  const returns = await db.warehouse.create({ data: { code: `RR${suffix.slice(0, 8)}`, name: `rc returns ${suffix}` }, select: { id: true } })
  const layerIds: Array<{ id: string; qty: string; unit: string }> = []
  for (const layer of opts.layers) {
    const row = await db.costLayer.create({
      data: { productId: product.id, warehouseId: main.id, receivedQty: D(layer.qty), remainingQty: D('0'), unitCostBase: D(layer.unit) },
      select: { id: true },
    })
    layerIds.push({ id: row.id, ...layer })
  }
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `RC-${suffix.slice(0, 8)}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: D('1'),
      subtotalForeign: D('200'),
      totalForeign: D('200'),
      subtotalBase: D('200'),
      taxBase: D('0'),
      totalBase: D('200'),
      ...(opts.journaled ? { revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'), unearnedRevenueAmount: D('200') } : {}),
      lines: {
        create: [{
          productId: product.id, description: 'rc line', qty: D('2'),
          unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('200'), totalBase: D('200'),
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  const snapshot = layerIds.map((l) => ({ costLayerId: l.id, qty: l.qty, unitCostBase: l.unit }))
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id,
      warehouseId: main.id,
      status: 'SHIPPED',
      shippedAt: new Date(),
      ...(opts.journaled ? { shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'), revenueRecognizedAmount: D('200'), cogsBatchAmount: D('90') } : {}),
      lines: { create: [{ lineId, productId: product.id, qty: D('2'), ...(opts.snapshot === false ? {} : { costLayerSnapshot: snapshot }) }] },
    },
    select: { id: true },
  })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  return { productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId, shipmentId: shipment.id }
}

async function cleanup(rig: Rig, fx: Fixture | undefined) {
  if (!fx) return
  const { db } = rig
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

function refundInput(fx: Fixture, suffix: string, opts: { qty: number; returnWarehouse: boolean; storefrontId?: number; accounting?: boolean }) {
  return {
    orderId: fx.orderId,
    lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'rc line', qty: opts.qty, totalBase: opts.qty * 100 }],
    reason: opts.storefrontId ? 'WooCommerce refund' : 'Customer return',
    ...(opts.returnWarehouse ? { returnWarehouseId: fx.returnsId } : {}),
    ...(opts.storefrontId ? { externalRefundId: opts.storefrontId } : {}),
    creditNotePrefix: `RC${suffix.slice(0, 6)}-`,
    ...(opts.accounting ? { accountingSettings } : {}),
  }
}

async function returnedLayers(rig: Rig, fx: Fixture) {
  const layers = await rig.db.costLayer.findMany({
    where: { productId: fx.productId, warehouseId: fx.returnsId },
    orderBy: { receivedAt: 'asc' },
    select: { receivedQty: true, remainingQty: true, unitCostBase: true },
  })
  return layers.map((l) => ({ qty: Number(l.receivedQty), remaining: Number(l.remainingQty), unit: Number(l.unitCostBase) }))
}

async function returnedStock(rig: Rig, fx: Fixture) {
  const level = await rig.db.stockLevel.findFirst({ where: { productId: fx.productId, warehouseId: fx.returnsId }, select: { quantity: true } })
  return level ? Number(level.quantity) : 0
}

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

async function withFixture(
  opts: Parameters<typeof seed>[2],
  body: (rig: Rig, fx: Fixture, suffix: string) => Promise<void>,
) {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Fixture | undefined
  try {
    fx = await seed(rig, suffix, opts)
    await body(rig, fx, suffix)
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
}

type Sync = { type: string; payload: { lines: Array<{ accountCode: string; debit?: number; credit?: number }> } }

function assertBalanced(syncs: Sync[]) {
  for (const sync of syncs) {
    const debit = sync.payload.lines.reduce((sum, line) => sum + (line.debit ?? 0), 0)
    const credit = sync.payload.lines.reduce((sum, line) => sum + (line.credit ?? 0), 0)
    assert.equal(Math.round(debit * 100), Math.round(credit * 100), `${sync.type} journal balances`)
  }
}

test('o3d-hqvrp.26: a refund of shipped units that returns NO stock posts no COGS reversal (no Inventory debit)', { skip }, async () => {
  await withFixture({ layers: [{ qty: '2', unit: '45' }], journaled: true }, async (rig, fx, suffix) => {
    const result = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: false, accounting: true }))
    assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
    if (!result.success) return
    const syncs = result.accountingSyncs as unknown as Sync[]
    assertBalanced(syncs)
    assert.equal(syncs.some((s) => s.type === 'COGS_REVERSAL'), false, 'the goods are not back: there is nothing to debit Inventory with')
    assert.equal(syncs.some((s) => s.payload.lines.some((line) => line.accountCode === '1200' && (line.debit ?? 0) > 0)), false, 'no journal at all debits Inventory')
    assert.equal(await returnedStock(rig, fx), 0, 'no stock came back')
    assert.deepEqual(await returnedLayers(rig, fx), [], 'and no cost layer: the GL and the sub-ledger still agree')
    const refundLine = await rig.db.salesOrderRefundLine.findFirst({ where: { refund: { orderId: fx.orderId } }, select: { costLayerSnapshot: true } })
    assert.deepEqual(refundLine?.costLayerSnapshot ?? [], [], 'the shipped cost is not consumed, so a later refund that does return the unit still has it')
  })
})

test('o3d-hqvrp.26 (control): the same refund WITH a stock return still reverses COGS, and the Inventory debit equals the cost layer that came back', { skip }, async () => {
  await withFixture({ layers: [{ qty: '2', unit: '45' }], journaled: true }, async (rig, fx, suffix) => {
    const result = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true, accounting: true }))
    assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
    if (!result.success) return
    const syncs = result.accountingSyncs as unknown as Sync[]
    assertBalanced(syncs)
    const cogs = syncs.find((s) => s.type === 'COGS_REVERSAL')
    assert.ok(cogs, 'stock returned: the shipped COGS is reversed')
    const inventoryDebit = cogs.payload.lines.find((line) => line.accountCode === '1200')?.debit
    assert.equal(inventoryDebit, 45)
    const layers = await returnedLayers(rig, fx)
    assert.deepEqual(layers, [{ qty: 1, remaining: 1, unit: 45 }], 'one unit back at its issued cost')
    assert.equal(layers.reduce((sum, l) => sum + l.qty * l.unit, 0), inventoryDebit, 'GL Inventory debit == cost-layer value that came back')
  })
})

test('o3d-hqvrp.32: a return of a shipment that was NEVER journaled (accounting off) restocks at the issued cost with a cost layer', { skip }, async () => {
  await withFixture({ layers: [{ qty: '2', unit: '45' }], journaled: false }, async (rig, fx, suffix) => {
    const result = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true }))
    assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
    assert.equal(await returnedStock(rig, fx), 1)
    assert.deepEqual(await returnedLayers(rig, fx), [{ qty: 1, remaining: 1, unit: 45 }], 'stock is never costless: the unit carries a layer at the shipment\'s cost')
    const movement = await rig.db.stockMovement.findFirst({ where: { productId: fx.productId, type: 'RETURN_INBOUND' }, select: { unitCostBase: true, totalValueBase: true } })
    assert.equal(Number(movement?.unitCostBase), 45, 'the movement is valued, not zero')
    assert.equal(Number(movement?.totalValueBase), 45)
  })
})

test('o3d-hqvrp.32: successive returns take the shipment\'s layers in dispatch order (40 then 50), never the same unit twice', { skip }, async () => {
  await withFixture({ layers: [{ qty: '1', unit: '40' }, { qty: '1', unit: '50' }], journaled: false }, async (rig, fx, suffix) => {
    const first = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true }))
    assert.equal(first.success, true, `first refund (${first.success ? '' : first.error})`)
    const second = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true }))
    assert.equal(second.success, true, `second refund (${second.success ? '' : second.error})`)
    assert.equal(await returnedStock(rig, fx), 2)
    assert.deepEqual(
      (await returnedLayers(rig, fx)).map((l) => l.unit).sort((a, b) => a - b),
      [40, 50],
      'each returned unit is priced from a different issued unit',
    )
  })
})

test('o3d-hqvrp.32: an operator return whose shipped units have NO cost on record is refused, and nothing is committed', { skip }, async () => {
  await withFixture({ layers: [], snapshot: false, journaled: false }, async (rig, fx, suffix) => {
    const result = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true }))
    assert.equal(result.success, false)
    assert.match(result.success ? '' : result.error, /cost of the shipped units is not on record/)
    assert.equal(await rig.db.salesOrderRefund.count({ where: { orderId: fx.orderId } }), 0, 'no credit note either: the refusal rolled the refund back')
    assert.equal(await returnedStock(rig, fx), 0)
    assert.deepEqual(await returnedLayers(rig, fx), [])
  })
})

test('o3d-hqvrp.32: a STOREFRONT refund with no cost on record is parked with a WARNING: recorded, not restocked costless', { skip }, async () => {
  await withFixture({ layers: [], snapshot: false, journaled: false }, async (rig, fx, suffix) => {
    const result = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, { qty: 1, returnWarehouse: true, storefrontId: 3_000_000 + Math.floor(Math.random() * 900_000) }))
    assert.equal(result.success, true, `the storefront refund is already issued, so it is recorded (${result.success ? '' : result.error})`)
    const refunds = await rig.db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { returnWarehouseId: true } })
    assert.equal(refunds.length, 1)
    assert.equal(refunds[0].returnWarehouseId, null, 'no return warehouse recorded: nothing came back into stock')
    assert.equal(await returnedStock(rig, fx), 0, 'no costless stock')
    assert.deepEqual(await returnedLayers(rig, fx), [])
    const warning = await rig.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_return_parked_unknown_cost' }, select: { level: true } })
    assert.equal(warning?.level, 'WARNING', 'the parked units are visible on the order')
  })
})
