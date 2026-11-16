import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * ACC-H14 — A COST EDIT ON A COMPLETED MANUFACTURING ORDER SPLITS COGS BY WHAT HAPPENED TO THE UNITS.
 *
 * Drives the real `updateManufacturingCostLines` against a COMPLETED order whose output layer was partly
 * sold (a journaled shipment), partly transferred (an IN_TRANSIT transfer line) and partly returned (a refund
 * line that restocked), then reads the GL the edit queued: the MANUFACTURING_RECLASS journal and the
 * shipment path's COGS_REVERSAL. The ledger is checked AGAINST THE COST LAYERS — what the layer rows say is
 * sold, on hand, on a transfer and returned — rather than against numbers copied from the implementation.
 *
 * Before the fix: transferred units were read as sold (COGS overstated by transferred x delta), and a journaled
 * sold shipment made the edit throw "rounding produced an unbalanced reclass journal".
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

const SETTINGS: Array<[string, string]> = [
  ['plugin_xero_enabled', 'true'],
  ['xero_sync_enabled', 'true'],
  ['xero_sync_cogs_reversal', 'submitted'],
  ['xero_sync_manufacturing_journal', 'submitted'],
  ['xero_inventory_account', '630'],
  ['xero_cogs_account', '500'],
  ['xero_manufacturing_overhead_account', '700'],
]

type Scenario = {
  /** Units on the output layer. */
  received: number
  /** Units still on hand. */
  remaining: number
  /** Units shipped on a journaled shipment (INCLUDING any later returned). */
  shipped: number
  /** Units on an in-transit transfer. */
  transferred: number
  /** Of the shipped units, how many came back (a restocking refund). */
  returned: number
  oldOverhead: number
  newOverhead: number
}

async function seed(label: string, sc: Scenario) {
  const { db } = await import('@/lib/db')
  const tag = `ACCH14-${label}-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const now = new Date()
  const w1 = await db.warehouse.create({ data: { code: `${tag}-1`, name: `${tag} w1`, type: 'STANDARD', availableForSale: true, active: true }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${tag}-2`, name: `${tag} w2`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true }, select: { id: true } })
  const customer = await db.customer.create({ data: { firstName: 'ACCH14', lastName: tag, email: `${tag.toLowerCase()}@example.invalid`, active: true }, select: { id: true, email: true } })
  const component = await db.product.create({ data: { sku: `${tag}-c`, name: `component ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const finished = await db.product.create({
    data: { sku: `${tag}-f`, name: `finished ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN', lifecycleStatus: 'ACTIVE', salesPriceBase: 20, salesPriceTaxInclusive: false, taxCategory: 'STANDARD', stockUnit: 'pcs', oversellAllowed: false, active: true },
    select: { id: true, sku: true, name: true },
  })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 50, subtotalBase: 50, taxForeign: 0, taxBase: 0, totalForeign: 50, totalBase: 50,
      destinationWarehouseId: w1.id, receivedAt: now,
      lines: { create: [{ productId: component.id, description: component.id, qty: 10, unitCostForeign: 5, unitCostBase: 5, totalForeign: 50, totalBase: 50, landedUnitCostBase: 5, qtyReceived: 10, qtyReturned: 0, sortOrder: 0 }] },
    },
    select: { lines: { select: { id: true } } },
  })
  const source = await db.costLayer.create({
    data: { productId: component.id, warehouseId: w1.id, receivedQty: 10, remainingQty: 0, unitCostBase: 5, receivedAt: new Date(now.getTime() - 120_000), poLineId: goods.lines[0]!.id },
    select: { id: true },
  })
  const bom = await db.bom.create({ data: { name: `bom ${tag}` }, select: { id: true } })
  const production = await db.productionOrder.create({
    data: {
      reference: `MO-${tag}`, bomId: bom.id, outputProductId: finished.id, warehouseId: w1.id, qtyPlanned: sc.received, qtyProduced: sc.received,
      status: 'COMPLETED', completedAt: now,
      manufacturingCostLines: { create: [{ description: 'overhead', amountForeign: sc.oldOverhead, amountBase: sc.oldOverhead, accountCode: '700', sortOrder: 0 }] },
    },
    select: { id: true },
  })
  const oldUnit = (50 + sc.oldOverhead) / sc.received
  const layer = await db.costLayer.create({
    data: { productId: finished.id, warehouseId: w1.id, receivedQty: sc.received, remainingQty: sc.remaining, unitCostBase: oldUnit, productionOrderId: production.id, receivedAt: new Date(now.getTime() - 60_000) },
    select: { id: true },
  })
  await db.costLayerSourceLine.create({
    data: { costLayerId: layer.id, sourceProductId: component.id, sourceCostLayerId: source.id, qty: 10, unitCostBase: 5, totalCostBase: 50 },
  })
  const snapshot = (qty: number) => [{ costLayerId: layer.id, qty: `${qty}.000000`, unitCostBase: oldUnit.toFixed(6) }]

  let shipmentId: string | null = null
  if (sc.shipped > 0) {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `SO-${tag}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, customerId: customer.id,
        customerName: 'ACCH14', customerEmail: customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
        subtotalForeign: 20 * sc.shipped, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, totalForeign: 20 * sc.shipped,
        subtotalBase: 20 * sc.shipped, shippingBase: 0, taxBase: 0, totalBase: 20 * sc.shipped, shipFromWarehouseId: w1.id, shippedAt: now,
        revenueDeferredDate: new Date(now.getTime() - 10_000), unearnedRevenueAmount: 20 * sc.shipped, accountingInvoiceId: `INV-${tag}`,
        lines: { create: [{ productId: finished.id, sku: finished.sku, description: finished.name, qty: sc.shipped, unitPriceForeign: 20, unitPriceBase: 20, totalForeign: 20 * sc.shipped, totalBase: 20 * sc.shipped, cogsBase: oldUnit * sc.shipped }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    const shipment = await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: w1.id, status: 'SHIPPED', shippedAt: now,
        shipmentJournalDate: new Date(now.getTime() - 5_000), cogsBatchAmount: Number((oldUnit * sc.shipped).toFixed(2)),
        revenueRecognizedAmount: 20 * sc.shipped, allocatedReliefAmount: Number((oldUnit * sc.shipped).toFixed(2)), shipmentJournalBatchRef: `B-${tag}`,
        lines: { create: [{ lineId: order.lines[0]!.id, productId: finished.id, qty: sc.shipped, costLayerSnapshot: snapshot(sc.shipped) as never }] },
      },
      select: { id: true },
    })
    shipmentId = shipment.id
    if (sc.returned > 0) {
      await db.salesOrderRefund.create({
        data: {
          orderId: order.id, returnWarehouseId: w1.id, totalForeign: 20 * sc.returned, totalBase: 20 * sc.returned,
          lines: { create: [{ productId: finished.id, description: finished.name, qty: sc.returned, unitPriceBase: 20, totalBase: 20 * sc.returned, costLayerSnapshot: snapshot(sc.returned) as never }] },
        },
      })
    }
  }
  if (sc.transferred > 0) {
    await db.stockTransfer.create({
      data: {
        reference: `T-${tag}`, fromWarehouseId: w1.id, toWarehouseId: w2.id, status: 'IN_TRANSIT', dispatchedAt: now,
        lines: { create: [{ productId: finished.id, sku: finished.sku, productName: finished.name, qty: `${sc.transferred}.0000`, qtyReceived: '0.0000', costLayerSnapshot: snapshot(sc.transferred) as never }] },
      },
    })
  }
  return { productionId: production.id, layerId: layer.id, shipmentId, tag, finished, w1: w1.id, w2: w2.id, customer, oldUnit }
}

type Line = { accountCode: string; debit?: number; credit?: number }
const sum = (lines: Line[], pick: (l: Line) => number) => lines.reduce((s, l) => s + pick(l), 0)
/** Net DEBIT to an account across journals. */
function netDebit(lines: Line[], account: string): number {
  return lines.filter((l) => l.accountCode === account).reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0)
}

async function runCase(label: string, sc: Scenario, extend?: (world: Awaited<ReturnType<typeof seed>>) => Promise<{ extraShipmentIds: string[]; downstreamSold: number; downstreamHeld: number }>) {
  const { db } = await import('@/lib/db')
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  const world = await seed(label, sc)
  const ext = extend ? await extend(world) : { extraShipmentIds: [] as string[], downstreamSold: 0, downstreamHeld: 0 }
  const result = await updateManufacturingCostLines(world.productionId, [{ description: 'overhead', amountForeign: sc.newOverhead, accountCode: '700' }])
  assert.equal(result.success, true, `the edit must succeed (was refused as unbalanced before the fix): ${String(result.error)}`)

  const layer = await db.costLayer.findUniqueOrThrow({ where: { id: world.layerId }, select: { unitCostBase: true, receivedQty: true, remainingQty: true } })
  const unitDelta = Number(layer.unitCostBase) - (50 + sc.oldOverhead) / sc.received
  assert.ok(Math.abs(unitDelta - (sc.newOverhead - sc.oldOverhead) / sc.received) < 1e-6, 'the layer moved by the overhead per unit')

  const reclassRows = await db.accountingSyncLog.findMany({ where: { type: 'MANUFACTURING_RECLASS', referenceId: world.productionId }, select: { payload: true } })
  assert.equal(reclassRows.length, 1, 'exactly one reclass journal')
  const reclass = (reclassRows[0]!.payload as { lines: Line[] }).lines
  const shipmentIds = [world.shipmentId, ...ext.extraShipmentIds].filter((id): id is string => id != null)
  const reversals = shipmentIds.length > 0
    ? await db.accountingSyncLog.findMany({ where: { type: 'COGS_REVERSAL', referenceId: { in: shipmentIds } }, select: { payload: true } })
    : []
  const reversalLines = reversals.flatMap((r) => (r.payload as { lines: Line[] }).lines)
  const all = [...reclass, ...reversalLines]

  // Every journal balances on its own.
  for (const [name, lines] of [['reclass', reclass], ['reversal', reversalLines]] as const) {
    if (lines.length === 0) continue
    assert.ok(Math.abs(sum(lines, (l) => l.debit ?? 0) - sum(lines, (l) => l.credit ?? 0)) < 0.005, `${name} journal balances`)
  }

  // THE GL AGAINST THE COST LAYERS. What the layer rows say happened to the units:
  const soldNet = sc.shipped - sc.returned + ext.downstreamSold
  const stillInInventory = sc.received - soldNet // on hand + on a transfer + back from a customer (+ downstream units still held)
  // Layer-derived cross-check: every unit not sold is on hand, on a transfer, restocked, or downstream and unsold.
  assert.ok(Math.abs(Number(layer.remainingQty) + sc.transferred + sc.returned + ext.downstreamHeld - stillInInventory) < 1e-9, 'fixture: every unit is accounted for')
  const cogs = netDebit(all, '500')
  const inventory = netDebit(all, '630')
  const overhead = -netDebit(all, '700')
  assert.ok(Math.abs(cogs - soldNet * unitDelta) < 0.011, `COGS moved by ${cogs}; only the ${soldNet} net-sold unit(s) are COGS (${soldNet * unitDelta}) — transferred, returned and on-hand units are not`)
  assert.ok(Math.abs(inventory - stillInInventory * unitDelta) < 0.011, `Inventory moved by ${inventory}; the ${stillInInventory} unit(s) on hand, on a transfer or returned are Inventory (${stillInInventory * unitDelta})`)
  assert.ok(Math.abs(overhead - (sc.newOverhead - sc.oldOverhead)) < 0.011, 'the overhead credit is the whole edit')
  assert.ok(Math.abs(cogs + inventory - overhead) < 0.011, 'and the debits equal it')
  return { cogs, inventory }
}

test('ACC-H14: setup', { skip }, async () => {
  loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  const { db } = await import('@/lib/db')
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
})

test('ACC-H14: 10 units, 6 transferred, +10 overhead -> COGS 0, Inventory 10 (was COGS 6)', { skip }, async () => {
  const r = await runCase('xfer', { received: 10, remaining: 4, shipped: 0, transferred: 6, returned: 0, oldOverhead: 20, newOverhead: 30 })
  assert.ok(Math.abs(r.cogs) < 0.005, 'a transferred unit is not COGS')
  assert.ok(Math.abs(r.inventory - 10) < 0.005)
})

test('ACC-H14: output partly sold, partly transferred, partly returned, then cost-edited', { skip }, async () => {
  // 10 units: 4 shipped (1 of them returned), 2 on a transfer, 4 on hand.
  await runCase('mixed', { received: 10, remaining: 4, shipped: 4, transferred: 2, returned: 1, oldOverhead: 20, newOverhead: 30 })
})

test('ACC-H14: all units sold on a journaled shipment -> the edit is accepted and COGS carries the whole delta', { skip }, async () => {
  const r = await runCase('sold', { received: 10, remaining: 0, shipped: 10, transferred: 0, returned: 0, oldOverhead: 20, newOverhead: 30 })
  assert.ok(Math.abs(r.cogs - 10) < 0.011)
})

test('ACC-H14: a cost DECREASE splits the same way (mixed, -10 overhead)', { skip }, async () => {
  await runCase('down', { received: 10, remaining: 4, shipped: 4, transferred: 2, returned: 1, oldOverhead: 30, newOverhead: 20 })
})

/** A journaled shipment of `qty` units out of `layerId` (product `productId`), on its own order. */
async function shipFromLayer(world: Awaited<ReturnType<typeof seed>>, label: string, warehouseId: string, productId: string, layerId: string, qty: number, unit: number) {
  const { db } = await import('@/lib/db')
  const now = new Date()
  const product = await db.product.findUniqueOrThrow({ where: { id: productId }, select: { sku: true, name: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${world.tag}-${label}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, customerId: world.customer.id,
      customerName: 'ACCH14', customerEmail: world.customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 20 * qty, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, totalForeign: 20 * qty,
      subtotalBase: 20 * qty, shippingBase: 0, taxBase: 0, totalBase: 20 * qty, shipFromWarehouseId: warehouseId, shippedAt: now,
      revenueDeferredDate: new Date(now.getTime() - 10_000), unearnedRevenueAmount: 20 * qty, accountingInvoiceId: `INV-${world.tag}-${label}`,
      lines: { create: [{ productId, sku: product.sku, description: product.name, qty, unitPriceForeign: 20, unitPriceBase: 20, totalForeign: 20 * qty, totalBase: 20 * qty, cogsBase: unit * qty }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id, warehouseId, status: 'SHIPPED', shippedAt: now,
      shipmentJournalDate: new Date(now.getTime() - 5_000), cogsBatchAmount: unit * qty, revenueRecognizedAmount: 20 * qty,
      allocatedReliefAmount: unit * qty, shipmentJournalBatchRef: `B-${world.tag}-${label}`,
      lines: { create: [{ lineId: order.lines[0]!.id, productId, qty, costLayerSnapshot: [{ costLayerId: layerId, qty: `${qty}.000000`, unitCostBase: unit.toFixed(6) }] as never }] },
    },
    select: { id: true },
  })
  return shipment.id
}

test('ACC-H14: transferred and component-reused units SOLD before the edit: COGS follows them, Inventory holds only what is held', { skip }, async () => {
  const { db } = await import('@/lib/db')
  // 10 units: 6 on hand, 2 transferred (received, landed in a destination layer, sold), 2 used as a component
  // of a later production run (its output layer, sold). +10 overhead => +1 per output unit.
  const r = await runCase('down-sold', { received: 10, remaining: 6, shipped: 0, transferred: 0, returned: 0, oldOverhead: 20, newOverhead: 30 }, async (world) => {
    const oldUnit = world.oldUnit
    const now = new Date()
    // Destination layer of a RECEIVED transfer, sold in full.
    await db.stockTransfer.create({
      data: {
        reference: `T-${world.tag}`, fromWarehouseId: world.w1, toWarehouseId: world.w2, status: 'RECEIVED', dispatchedAt: now,
        lines: { create: [{ productId: world.finished.id, sku: world.finished.sku, productName: world.finished.name, qty: '2.0000', qtyReceived: '2.0000', costLayerSnapshot: [{ costLayerId: world.layerId, qty: '2.000000', unitCostBase: oldUnit.toFixed(6) }] as never }] },
      },
    })
    const dest = await db.costLayer.create({ data: { productId: world.finished.id, warehouseId: world.w2, receivedQty: 2, remainingQty: 0, unitCostBase: oldUnit, receivedAt: now }, select: { id: true } })
    await db.costLayerSourceLine.create({ data: { costLayerId: dest.id, sourceProductId: world.finished.id, sourceCostLayerId: world.layerId, qty: 2, unitCostBase: oldUnit, totalCostBase: 2 * oldUnit } })
    const destShipment = await shipFromLayer(world, 'dest', world.w2, world.finished.id, dest.id, 2, oldUnit)

    // A later production run that used 2 of the units as a component: PRODUCTION_OUT evidence on our layer, a
    // layer for the later output (2 units, same unit cost), linked by a source line, sold in full.
    const later = await db.product.create({ data: { sku: `${world.tag}-l`, name: `later ${world.tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
    await db.$transaction(async (tx) => {
      const movement = await tx.stockMovement.create({ data: { type: 'PRODUCTION_OUT', productId: world.finished.id, fromWarehouseId: world.w1, qty: 2, referenceType: 'ProductionOrder', referenceId: world.productionId } })
      await tx.cogsEntry.create({ data: { costLayerId: world.layerId, movementId: movement.id, qty: 2, unitCostBase: oldUnit, totalCostBase: 2 * oldUnit } })
    })
    const laterLayer = await db.costLayer.create({ data: { productId: later.id, warehouseId: world.w1, receivedQty: 2, remainingQty: 0, unitCostBase: oldUnit, receivedAt: now }, select: { id: true } })
    await db.costLayerSourceLine.create({ data: { costLayerId: laterLayer.id, sourceProductId: world.finished.id, sourceCostLayerId: world.layerId, qty: 2, unitCostBase: oldUnit, totalCostBase: 2 * oldUnit } })
    const laterShipment = await shipFromLayer(world, 'later', world.w1, later.id, laterLayer.id, 2, oldUnit)
    return { extraShipmentIds: [destShipment, laterShipment], downstreamSold: 4, downstreamHeld: 0 }
  })
  // 4 sold units carry +1 each into COGS; the 6 held units carry +1 each into Inventory; nothing else.
  assert.ok(Math.abs(r.cogs - 4) < 0.011, `COGS for the sold units equals the new cost: ${r.cogs}`)
  assert.ok(Math.abs(r.inventory - 6) < 0.011, `Inventory equals the new cost for the units still held: ${r.inventory}`)
})
