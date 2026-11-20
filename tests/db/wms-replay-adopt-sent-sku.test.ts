import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
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
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/wms-replay-adopt-sent-sku.test.ts would have been skipped.')
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
/** The order changed (an address or note edit): due for an amendment. */
const touchOrder = (d: Deps, s: Seeded) => d.db.$executeRawUnsafe(`UPDATE sales_orders SET "updatedAt" = now() + interval '1 hour' WHERE id = '${s.orderId}'`)


/**
 * o3d-jtfy7 (#1100 R1 HIGH): THE OPERATOR REPLAY ADOPTION DOES NOT KEEP A STALE SENT-SKU RECORD.
 *
 * The real replayWmsOrderPush action over the real Prisma port and a real database; only the warehouse connector, the auth gate and the plugin state are doubles
 * (nothing leaves the box). A link carrying the record of an earlier flag-ON warehouse order (the MISSING_IN_WMS re-push used to leave it on the link) is
 * parked AMBIGUOUS_CREATE; the operator presses Replay, the probe finds the order and ADOPTs it; the sweep verifies it; the flag is OFF and the next
 * amendment must send A, with no item delete or add.
 */
const warehouse = { adopt: { kind: 'ADOPT' as const, externalOrderId: 'wms-replayed', externalOrderNumber: 'WN-REPLAYED' } }
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'op-1' } }), requireInternalUser: async () => ({ user: { id: 'op-1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, redactActivityLogText: (text: string) => text } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) } })
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({ id: 'mintsoft', verifyPushedOrder: async () => 'ours', reconcileAmbiguousCreate: async () => warehouse.adopt, probeOrderPresence: async () => 'FOUND' as const }),
  },
})

function connectorDouble() {
  const sent = { amended: [] as Array<Array<{ sku: string; quantity: number }>>, created: [] as Array<{ sku: string; quantity: number }> }
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
const heldItems = (lines: Array<{ sku: string; quantity: number }>) => lines.map((l, i) => ({ ID: i + 1, SKU: l.sku, Quantity: l.quantity }))
const planFor = (d: Deps, created: Array<{ sku: string; quantity: number }>, amended: Array<{ sku: string; quantity: number }>) => d.planner.planMintsoftItemAmendments(heldItems(created) as never, amended as never)
const recordOf = (d: Deps, s: Seeded) => d.db.wmsOrderPushLink.findUnique({ where: { orderId: s.orderId }, select: { sentLineSkus: true, state: true } })

test('flag ON create {A:B}, re-push, flag OFF, ambiguous create, Replay ADOPT, verify, amend: the amendment sends A (no delete/add)', { skip }, async (t) => {
  const d = await deps()
  const s = await seed(d, `skr${randomUUID().slice(0, 8)}`)
  t.after(() => cleanup(d, s))
  await setFlag(d, true)
  await renameRow(d, s, 'RESOLVED')
  await setWarehouseSku(d, s, s.b)
  const double = connectorDouble()
  await run(d, double.connector)
  assert.deepEqual(double.sent.created.map((l) => l.sku), [s.b], 'precondition: sent as B')
  assert.notEqual((await recordOf(d, s))?.sentLineSkus, null, 'precondition: record {A:B}')
  // The MISSING_IN_WMS re-push resets the link (the real action is covered by its own tests; its write is the one asserted below), the flag is turned OFF and the
  // next create times out: the link is parked AMBIGUOUS_CREATE carrying whatever the reset left of the record.
  const record = (await recordOf(d, s))!.sentLineSkus
  await setFlag(d, false)
  await d.db.wmsOrderPushLink.update({
    where: { orderId: s.orderId },
    data: { state: 'DEAD_LETTER', externalOrderId: null, externalOrderNumber: null, pushedAt: null, attempts: 5, lastAttemptAt: new Date(Date.now() - 3_600_000), lastError: 'create timed out', sentLineSkus: record as never },
  })
  const { replayWmsOrderPush } = await import('../../app/actions/wms-order-push.ts')
  const outcome = await replayWmsOrderPush(s.orderId)
  assert.equal((outcome as { success: boolean }).success, true, JSON.stringify(outcome))
  const adopted = await recordOf(d, s)
  assert.equal(adopted?.state, 'PENDING_VERIFY', 'precondition: Replay adopted the order')
  assert.equal(adopted?.sentLineSkus, null, 'the adopted order is not the one the record described')
  await run(d, double.connector) // verify -> SYNCED
  assert.equal((await recordOf(d, s))?.state, 'SYNCED', 'precondition: verified')
  await touchOrder(d, s)
  await run(d, double.connector)
  assert.deepEqual(double.sent.amended.at(-1)!.map((l) => l.sku), [s.a])
  assert.deepEqual(planFor(d, [{ sku: s.a, quantity: 1 }], double.sent.amended.at(-1)!), [])
})
