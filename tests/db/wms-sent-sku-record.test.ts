import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE SKU SENT AT CREATE IS RECORDED PER LINE AND EVERY AMENDMENT IS BUILT FROM IT (the real Prisma order-push port, a real database).
 *
 * Drives the REAL sweep over the REAL Prisma port and the REAL Mintsoft item-reconcile planner (planMintsoftItemAmendments) with a seeded, paid, bound order
 * and real rename-history rows. The Mintsoft connector in the sweep is a double that records what it is asked to send: Mintsoft is LIVE and is never contacted
 * (tests/no-outbound-network.cjs fails a test that tried to leave the box). Fixtures are unique per run and removed afterwards.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/wms-sent-sku-record.test.ts would have been skipped.')
}
const FLAG = 'wms_sku_rename_remap_enabled'

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, sweep, planner] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/wms/order-push-sweep.ts'),
    import('../../lib/connectors/mintsoft/api/order-push.ts'),
  ])
  return { db, sweep, planner }
}
type Deps = Awaited<ReturnType<typeof deps>>

async function seed(d: Deps, tag: string) {
  const [w1, w2] = await Promise.all([1, 2].map((n) => d.db.warehouse.create({ data: { code: `${tag}-${n}`.slice(0, 20), name: `${tag} wh${n}`, type: 'STANDARD' }, select: { id: true } })))
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const bind = (warehouseId: string, n: number) => d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId, connector: 'mintsoft', externalWarehouseId: `ext-${tag}-${n}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() }, select: { id: true },
  })
  const b1 = await bind(w1!.id, 1)
  // The product was renamed A -> B in IMS; the order line still carries the snapshot A.
  const product = await d.db.product.create({ data: { sku: `B-${tag}`, name: `Widget ${tag}` }, select: { id: true } })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `SKR-${tag}`, status: 'PROCESSING', paidAt: new Date('2026-06-10T00:00:00Z'), shipFromWarehouseId: w1!.id, customerName: 'Pat Example', customerEmail: 'pat@example.com', currency: 'GBP',
      shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' }, subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `A-${tag}`, productId: product.id, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  return { w1: w1!.id, w2: w2!.id, connectionId: connection.id, bindingIds: [b1.id], bind, productId: product.id, orderId: order.id, a: `A-${tag}`, b: `B-${tag}`, tag }
}
type Seeded = Awaited<ReturnType<typeof seed>>
async function cleanup(d: Deps, s: Seeded) {
  await d.db.setting.deleteMany({ where: { key: FLAG } })
  await d.db.wmsStockDiscrepancy.deleteMany({ where: { productId: s.productId } })
  await d.db.wmsProductLink.deleteMany({ where: { productId: s.productId } })
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrder.deleteMany({ where: { id: s.orderId } })
  await d.db.product.deleteMany({ where: { id: s.productId } })
  await d.db.externalWmsBinding.deleteMany({ where: { connectionId: s.connectionId } })
  await d.db.wmsConnection.deleteMany({ where: { id: s.connectionId } })
  await d.db.warehouse.deleteMany({ where: { id: { in: [s.w1, s.w2] } } })
}
const setFlag = (d: Deps, on: boolean) => d.db.setting.upsert({ where: { key: FLAG }, create: { key: FLAG, value: on ? 'true' : 'false' }, update: { value: on ? 'true' : 'false' } })
const setWarehouseSku = (d: Deps, s: Seeded, sku: string) => d.db.wmsProductLink.upsert({
  where: { connector_productId: { connector: 'mintsoft', productId: s.productId } },
  create: { connector: 'mintsoft', productId: s.productId, externalProductId: `ext-p-${s.tag}`, metadata: { SKU: sku } }, update: { metadata: { SKU: sku } },
})
const renameRow = (d: Deps, s: Seeded, status: 'OPEN' | 'RESOLVED') => d.db.wmsStockDiscrepancy.create({
  data: { connector: 'mintsoft', warehouseId: s.w1, productId: s.productId, category: 'PRODUCT_SKU_RENAMED', status, imsValue: s.b, wmsValue: s.a, ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}) },
})
const resolveRow = (d: Deps, s: Seeded) => d.db.wmsStockDiscrepancy.updateMany({ where: { productId: s.productId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } })
/** The order changed (an address or note edit): due for an amendment. */
const touchOrder = (d: Deps, s: Seeded) => d.db.$executeRawUnsafe(`UPDATE sales_orders SET "updatedAt" = now() + interval '1 hour' WHERE id = '${s.orderId}'`)

function connectorDouble() {
  const sent = { created: [] as Array<{ sku: string; quantity: number }>, amended: [] as Array<Array<{ sku: string; quantity: number }>> }
  return {
    sent,
    connector: {
      pushOrder: async (input: { lines: Array<{ sku: string; quantity: number }> }) => { sent.created = input.lines; return { externalOrderId: 'wms-db-sku', externalOrderNumber: 'WN-DB-SKU', status: 'NEW' } },
      updateOrder: async (_id: string, input: { lines: Array<{ sku: string; quantity: number }> }) => { sent.amended.push(input.lines); return { updated: true, status: 'NEW' } },
      cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
      addOrderComment: async () => {},
      verifyPushedOrder: async () => 'ours' as const,
      probeOrderPresence: async () => 'MISSING' as const,
    },
  }
}
const run = (d: Deps, connector: unknown) => d.sweep.runWmsOrderPushSweepCore(connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 1000 })
/** What Mintsoft holds after the create, as the planner reads it (one item per line sent). */
const heldItems = (lines: Array<{ sku: string; quantity: number }>) => lines.map((l, i) => ({ ID: i + 1, SKU: l.sku, Quantity: l.quantity }))
const planFor = (d: Deps, created: Array<{ sku: string; quantity: number }>, amended: Array<{ sku: string; quantity: number }>) => d.planner.planMintsoftItemAmendments(heldItems(created) as never, amended as never)
const recordOf = async (d: Deps, s: Seeded) => (await d.db.wmsOrderPushLink.findUnique({ where: { orderId: s.orderId }, select: { sentLineSkus: true, state: true } }))

test('created as A while the rename row is OPEN, the row resolves, flag ON: the amendment sends A; the real planner plans no item delete or add', { skip }, async (t) => {
  const d = await deps()
  const s = await seed(d, `skr${randomUUID().slice(0, 8)}`)
  t.after(() => cleanup(d, s))
  await setFlag(d, true)
  await renameRow(d, s, 'OPEN')
  await setWarehouseSku(d, s, s.a) // Mintsoft still holds A: not confirmed on the current SKU, so no remap entry
  const double = connectorDouble()
  await run(d, double.connector)
  assert.deepEqual(double.sent.created.map((l) => l.sku), [s.a], 'precondition: the OPEN row let the old snapshot through')
  const link = await recordOf(d, s)
  assert.equal(link?.state, 'SYNCED')
  assert.deepEqual(Object.values(link?.sentLineSkus as Record<string, { own: string; sent: string }>), [{ own: s.a, sent: s.a }], 'the SKU sent is recorded per line, in the create transaction')
  // Mintsoft is renamed: sync writes SKU=B and the row resolves (kept as history). The order is then edited.
  await resolveRow(d, s)
  await setWarehouseSku(d, s, s.b)
  await touchOrder(d, s)
  await run(d, double.connector)
  assert.equal(double.sent.amended.length, 1, 'precondition: the amendment ran')
  assert.deepEqual(double.sent.amended[0]!.map((l) => l.sku), [s.a], 'built from the recorded sent SKU, not the now-resolved remap')
  assert.deepEqual(planFor(d, double.sent.created, double.sent.amended[0]!), [])
})

test('flag ON, create as B, flag OFF, amend: the amendment still sends B; the real planner plans no item delete or add', { skip }, async (t) => {
  const d = await deps()
  const s = await seed(d, `skr${randomUUID().slice(0, 8)}`)
  t.after(() => cleanup(d, s))
  await setFlag(d, true)
  await renameRow(d, s, 'RESOLVED')
  await setWarehouseSku(d, s, s.b)
  const double = connectorDouble()
  await run(d, double.connector)
  assert.deepEqual(double.sent.created.map((l) => l.sku), [s.b], 'precondition: remapped to the warehouse SKU at create')
  await setFlag(d, false)
  await touchOrder(d, s)
  await run(d, double.connector)
  assert.deepEqual(double.sent.amended[0]!.map((l) => l.sku), [s.b])
  assert.deepEqual(planFor(d, double.sent.created, double.sent.amended[0]!), [])
  // CONTROL (the documented limit): an order created before the record existed has nothing recorded and follows the flag (here OFF: the snapshot).
  await d.db.$executeRawUnsafe(`UPDATE wms_order_push_links SET sent_line_skus = NULL WHERE "orderId" = '${s.orderId}'`)
  await run(d, double.connector)
  assert.deepEqual(double.sent.amended[1]!.map((l) => l.sku), [s.a], 'no record: development behaviour (flag off sends the snapshot)')
})

test('ship-from change to a warehouse with NO rename history: the amendment still sends the SKU the order was created with', { skip }, async (t) => {
  const d = await deps()
  const s = await seed(d, `skr${randomUUID().slice(0, 8)}`)
  t.after(() => cleanup(d, s))
  await setFlag(d, true)
  await renameRow(d, s, 'RESOLVED') // the history is of warehouse 1 only
  await setWarehouseSku(d, s, s.b)
  const double = connectorDouble()
  await run(d, double.connector)
  assert.deepEqual(double.sent.created.map((l) => l.sku), [s.b])
  // A binding added after the rename, and the order's ship-from moves to it.
  const b2 = await s.bind(s.w2, 2)
  s.bindingIds.push(b2.id)
  await d.db.salesOrder.update({ where: { id: s.orderId }, data: { shipFromWarehouseId: s.w2 } })
  await touchOrder(d, s)
  await run(d, double.connector)
  assert.deepEqual(double.sent.amended[0]!.map((l) => l.sku), [s.b])
  assert.deepEqual(planFor(d, double.sent.created, double.sent.amended[0]!), [])
  const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: s.orderId }, select: { pushWarehouseId: true } })
  assert.equal(link?.pushWarehouseId, s.w2, 'the applied amendment stamps the warehouse it was sent to')
})
