import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * COSTING P1 BATCH, AGAINST A REAL DATABASE (committing, with its own cleanup).
 *
 *  - supplier returns consume the RETURNED PO LINE's layers before the warehouse's oldest layers: old 10 @ 5,
 *    PO 10 @ 8, return 2 removes 16 (not 10), so the transit reversal matches the credit note;
 *  - late landed cost on units already sold is funded from Stock in Transit: DR COGS / CR Transit, and the
 *    inventory account is not credited (the on-hand reclass already debited it only for the units on hand).
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/costing-p1-batch.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const layers = await import('../../lib/cost-layers')
  return { db, layers }
}
type Ctx = Awaited<ReturnType<typeof load>>

const D = (v: string | number) => new Prisma.Decimal(v)

async function seedBase(db: Ctx['db']) {
  const suffix = randomUUID().slice(0, 8)
  const product = await db.product.create({ data: { sku: `CP1-${suffix}`, name: `cp1 ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { name: `cp1 ${suffix}`, code: `CP1${suffix}` }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `cp1 ${suffix}` }, select: { id: true } })
  const po = await db.purchaseOrder.create({
    data: {
      reference: `CP1-${suffix}`,
      supplierId: supplier.id,
      status: 'RECEIVED',
      currency: 'GBP',
      fxRateToBase: D(1),
      subtotalForeign: D(80), subtotalBase: D(80), totalForeign: D(80), totalBase: D(80),
      lines: {
        create: [{
          productId: product.id, qty: D(10), unitCostForeign: D(8), unitCostBase: D(8), totalForeign: D(80), totalBase: D(80),
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { suffix, productId: product.id, warehouseId: warehouse.id, supplierId: supplier.id, poId: po.id, poLineId: po.lines[0].id }
}

async function cleanup(db: Ctx['db'], s: Awaited<ReturnType<typeof seedBase>>) {
  await db.cogsEntry.deleteMany({ where: { costLayer: { productId: s.productId } } })
  await db.stockMovement.deleteMany({ where: { productId: s.productId } })
  await db.costLayer.deleteMany({ where: { productId: s.productId } })
  await db.stockLevel.deleteMany({ where: { productId: s.productId } })
  await db.purchaseOrderLine.deleteMany({ where: { poId: s.poId } })
  await db.purchaseOrder.deleteMany({ where: { id: s.poId } })
  await db.supplier.deleteMany({ where: { id: s.supplierId } })
  await db.product.deleteMany({ where: { id: s.productId } })
  await db.warehouse.deleteMany({ where: { id: s.warehouseId } })
}

test('supplier return consumes only the returned PO line layers and refuses a quantity beyond them', { skip }, async () => {
  const { db, layers } = await load()
  const s = await seedBase(db)
  try {
    // Older stock from another source: 10 @ 5. Then the PO's layer: 10 @ 8.
    const other = await db.costLayer.create({ data: { productId: s.productId, warehouseId: s.warehouseId, receivedQty: D(10), remainingQty: D(10), unitCostBase: D(5), receivedAt: new Date('2026-01-01T00:00:00Z'), isOpeningStock: true }, select: { id: true } })
    const poLayer = await db.costLayer.create({ data: { productId: s.productId, warehouseId: s.warehouseId, receivedQty: D(10), remainingQty: D(10), unitCostBase: D(8), receivedAt: new Date('2026-02-01T00:00:00Z'), poLineId: s.poLineId }, select: { id: true } })

    assert.equal((await db.$transaction((tx) => layers.getPoLineAttributableLayerQty(tx, s.productId, s.warehouseId, s.poLineId))).toString(), '10')

    const out = await db.$transaction(async (tx) => layers.consumeFifoLayersStrict(tx, s.productId, s.warehouseId, 2, { onlyPoLineId: s.poLineId }))
    assert.equal(out.consumed.length, 1)
    assert.equal(out.consumed[0].costLayerId, poLayer.id)
    assert.equal(out.totalCost.toString(), '16')

    // Plain FIFO (no option) is unchanged: the oldest layer goes first.
    const plain = await db.$transaction(async (tx) => layers.consumeFifoLayersStrict(tx, s.productId, s.warehouseId, 2))
    assert.equal(plain.totalCost.toString(), '10')

    // More than the PO line's 8 remaining: refused, and the other order's layer is NOT touched.
    assert.equal((await db.$transaction((tx) => layers.getPoLineAttributableLayerQty(tx, s.productId, s.warehouseId, s.poLineId))).toString(), '8')
    await assert.rejects(
      db.$transaction(async (tx) => layers.consumeFifoLayersStrict(tx, s.productId, s.warehouseId, 9, { onlyPoLineId: s.poLineId })),
      /Insufficient FIFO layers/,
    )
    const rows = await db.costLayer.findMany({ where: { productId: s.productId }, select: { id: true, remainingQty: true } })
    assert.equal(rows.find((r) => r.id === other.id)!.remainingQty.toString(), '8')
    assert.equal(rows.find((r) => r.id === poLayer.id)!.remainingQty.toString(), '8')

    // A layer a transfer recreated from the PO layer (no poLineId, one source-line hop) is attributable too.
    const wh2 = await db.warehouse.create({ data: { name: `cp1b ${s.suffix}`, code: `CP1B${s.suffix}` }, select: { id: true } })
    try {
      const moved = await db.costLayer.create({ data: { productId: s.productId, warehouseId: wh2.id, receivedQty: D(3), remainingQty: D(3), unitCostBase: D(8) }, select: { id: true } })
      await db.costLayerSourceLine.create({ data: { costLayerId: moved.id, sourceProductId: s.productId, sourceCostLayerId: poLayer.id, qty: D(3), unitCostBase: D(8), totalCostBase: D(24) } })
      assert.equal((await db.$transaction((tx) => layers.getPoLineAttributableLayerQty(tx, s.productId, wh2.id, s.poLineId))).toString(), '3')
      const back = await db.$transaction(async (tx) => layers.consumeFifoLayersStrict(tx, s.productId, wh2.id, 3, { onlyPoLineId: s.poLineId }))
      assert.equal(back.totalCost.toString(), '24')
    } finally {
      await db.cogsEntry.deleteMany({ where: { costLayer: { warehouseId: wh2.id } } })
      await db.costLayer.deleteMany({ where: { warehouseId: wh2.id } })
      await db.warehouse.deleteMany({ where: { id: wh2.id } })
    }
  } finally {
    await cleanup(db, s)
    await db.$disconnect()
  }
})

test('late landed cost on shipped units posts DR COGS / CR transit and leaves inventory alone', { skip }, async () => {
  const { db, layers } = await load()
  const s = await seedBase(db)
  const extra: { orderId?: string; shipmentId?: string } = {}
  try {
    const layer = await db.costLayer.create({
      data: { productId: s.productId, warehouseId: s.warehouseId, receivedQty: D(10), remainingQty: D(7), unitCostBase: D(10), poLineId: s.poLineId },
      select: { id: true },
    })
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `CP1-${s.suffix}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D(1),
        subtotalForeign: D(100), totalForeign: D(100), subtotalBase: D(100), taxBase: D(0), totalBase: D(100),
        accountingInvoiceId: `inv-${s.suffix}`,
        lines: { create: [{ productId: s.productId, description: 'l', qty: D(3), unitPriceBase: D(30), unitPriceForeign: D(30), totalForeign: D(90), totalBase: D(90) }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    extra.orderId = order.id
    // 3 units sold at 10, journaled at 30. The layer is then revalued to 11 (snapshot rewritten, as the recalc does).
    const shipment = await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: s.warehouseId, status: 'SHIPPED',
        shipmentJournalDate: new Date('2026-03-01T00:00:00Z'), cogsBatchAmount: D(30),
        lines: { create: [{ lineId: order.lines[0].id, productId: s.productId, qty: D(3), costLayerSnapshot: [{ costLayerId: layer.id, qty: 3, unitCostBase: 11 }] }] },
      },
      select: { id: true },
    })
    extra.shipmentId = shipment.id

    const queued: Array<{ payload: { lines: Array<{ accountCode: string; debit?: number; credit?: number }> } }> = []
    const result = await db.$transaction(async (tx) => layers.refreshShipmentCogsForCostLayerChange(tx, layer.id, {
      offsetCostDeltaToTransit: true,
      recalcRunId: 'run-1',
      accountingSettings: { inventoryAccount: '630', cogsAccount: '310', transitAccount: '815', connector: null },
      isReversalPostingEnabled: async () => true,
      queueAccountingSync: (async (_tx: unknown, input: { payload: { lines: Array<{ accountCode: string; debit?: number; credit?: number }> } }) => {
        queued.push(input)
        return true
      }) as never,
    }))
    assert.equal(result.cogsRevaluationDelta.toString(), '3')
    assert.equal(queued.length, 1)
    const lines = queued[0].payload.lines
    assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? null, l.credit ?? null]), [['310', 3, null], ['815', null, 3]])
    assert.ok(!lines.some((l) => l.accountCode === '630'), 'inventory must not be touched')
    const transit = await db.transitSubledgerMovement.findMany({ where: { sourceRef: shipment.id } })
    assert.equal(transit.length, 1)
    assert.equal(transit[0].baseDelta.toString(), '-3')
  } finally {
    if (extra.shipmentId) {
      await db.transitSubledgerMovement.deleteMany({ where: { sourceRef: extra.shipmentId } })
      await db.cogsSubledgerMovement.deleteMany({ where: { sourceRef: extra.shipmentId } })
      await db.shipment.deleteMany({ where: { id: extra.shipmentId } })
    }
    if (extra.orderId) await db.salesOrderLine.deleteMany({ where: { orderId: extra.orderId } })
    if (extra.orderId) await db.salesOrder.deleteMany({ where: { id: extra.orderId } })
    await cleanup(db, s)
    await db.$disconnect()
  }
})
