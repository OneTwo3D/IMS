import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE LEGACY BRIDGE IMPORT AGAINST A REAL DATABASE (o3d-zvec.22): the six importable shapes the stage proof seeds (a verify-pending order is a gate blocker, covered by the unit tests: nothing is written for it), linked by the REAL ports, and
 * then the REAL order-push sweep over the REAL Prisma port run three times with a connector double that records its calls.
 *
 * The claim under test is the one the cutover rests on: after the import, the push sweep creates ZERO Mintsoft orders for any order the
 * bridge created. The control (an order the bridge never touched) is created by the same sweeps, so the zero is not an artefact of an
 * idle sweep. WooCommerce and Mintsoft are never contacted: the WooCommerce read is a double, and the connector double records its calls.
 * Fixtures are unique per run and removed afterwards. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/legacy-bridge-import.test.ts would have been skipped.')
}

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, sweep, run, ports] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/wms/order-push-sweep.ts'),
    import('../../lib/connectors/mintsoft/legacy-bridge-import/run.ts'),
    import('../../lib/connectors/mintsoft/legacy-bridge-import/ports.ts'),
  ])
  return { db, sweep, run, ports }
}

const meta = (pairs: Record<string, unknown>) => Object.entries(pairs).map(([key, value]) => ({ id: 1, key, value }))

type Shape = { name: string; status: string; meta: Record<string, unknown>; expect: { state: string; externalOrderId: string | null } | null }
const SHAPES: Shape[] = [
  { name: 'plain', status: 'processing', meta: { _mintsoft_order_id: '9001', _mintsoft_order_number: '', _mintsoft_status: 'NEW' }, expect: { state: 'SYNCED', externalOrderId: '9001' } },
  { name: 'split', status: 'processing', meta: { _mintsoft_order_id: '9002', _mintsoft_total_parts: 2, _mintsoft_split_part_statuses: { '1': 'NEW', '2': 'ONBACKORDER' } }, expect: { state: 'SYNCED', externalOrderId: '9002' } },
  { name: 'merged', status: 'processing', meta: { _mintsoft_order_id: '9100', _mintsoft_merged: '1' }, expect: { state: 'MERGED', externalOrderId: '9100' } },
  { name: 'partial', status: 'partial-shipped', meta: { _mintsoft_order_id: '9004', _mintsoft_total_parts: 2, _mintsoft_split_parts_done: [1], _mintsoft_split_part_statuses: { '1': 'DESPATCHED', '2': 'NEW' } }, expect: { state: 'SYNCED', externalOrderId: '9004' } },
  { name: 'withdrawal', status: 'pending-wdraw', meta: { _mintsoft_order_id: '9005', _mintsoft_wdraw_pending: 'hold', _mintsoft_wdraw_token: 't', _mintsoft_wdraw_hold_owned: '1' }, expect: { state: 'SYNCED', externalOrderId: '9005' } },
  { name: 'dead', status: 'processing', meta: { _mintsoft_sync_dead: '1', _mintsoft_sync_attempts: '5', _mintsoft_sync_pending: 'create' }, expect: { state: 'DEAD_LETTER', externalOrderId: null } },
  { name: 'control', status: 'processing', meta: {}, expect: null },
]

test('after the import the push sweep creates zero orders for bridge-created orders (three sweeps), and a rerun of the import changes nothing', { skip }, async (t) => {
  const d = await deps()
  const tag = `lbi${randomUUID().slice(0, 8)}`
  const base = 7_000_000 + Math.floor(Math.random() * 900_000)
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const binding = await d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() },
    select: { id: true },
  })
  const seeded: Array<{ shape: Shape; wcId: number; orderId: string; number: string }> = []
  for (const [i, shape] of SHAPES.entries()) {
    const wcId = base + i
    const number = `${wcId}`
    const order = await d.db.salesOrder.create({
      data: {
        orderNumber: number, status: 'PROCESSING', paidAt: new Date('2026-06-10T00:00:00Z'), shipFromWarehouseId: warehouse.id,
        customerName: 'Pat Example', customerEmail: `${tag}-${i}@example.com`, currency: 'GBP',
        shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
        subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
        lines: { create: [{ description: 'Widget', sku: `SKU-${tag}-${i}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
      },
      select: { id: true },
    })
    await d.db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: String(wcId), externalOrderNumber: number } })
    seeded.push({ shape, wcId, orderId: order.id, number })
  }
  const orderIds = seeded.map((s) => s.orderId)
  t.after(async () => {
    await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: orderIds } } })
    await d.db.shoppingOrderLink.deleteMany({ where: { orderId: { in: orderIds } } })
    await d.db.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } })
    await d.db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await d.db.externalWmsBinding.deleteMany({ where: { id: binding.id } })
    await d.db.wmsConnection.deleteMany({ where: { id: connection.id } })
    await d.db.warehouse.deleteMany({ where: { id: warehouse.id } })
  })

  const wcOrders = seeded.map((s) => ({ id: s.wcId, number: s.number, status: s.shape.status, meta_data: meta(s.shape.name === 'plain' ? { ...s.shape.meta, _mintsoft_order_number: s.number } : s.shape.meta) }))
  const real = d.ports.createLegacyImportPorts({})
  const ports = {
    ...real,
    readWcOrders: async () => ({ orders: wcOrders, pagesRead: 1, complete: true }),
    readOrderPrefix: async () => '',
    readConnectorId: async () => 'mintsoft',
    // Only this test's fixtures: the shared database may hold other rows.
    readOpenMergeState: async () => ({ holds: [], tasks: [] }),
  }
  const port = d.sweep.createPrismaWmsOrderPushPort()

  // PREMISE: before the import every one of these orders is a create candidate (no link), so the zero below is the import's doing.
  const before = (await port.createCandidates('mintsoft', [warehouse.id], 1000)).map((c: { id: string }) => c.id)
  for (const id of orderIds) assert.ok(before.includes(id), 'precondition: the order is a create candidate before the import')

  // DRY RUN writes nothing.
  const dry = await d.run.runLegacyBridgeImport(ports, { statuses: ['processing'] })
  assert.equal(dry.plan.create, 6)
  assert.equal(await d.db.wmsOrderPushLink.count({ where: { orderId: { in: orderIds } } }), 0)
  assert.equal(dry.gate.exitCode, 0)

  const auditBefore = await d.db.activityLog.count({ where: { action: 'legacy_bridge_import_applied' } })
  const applied = await d.run.runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ['processing'] })
  assert.equal(applied.auditRecorded, true)
  assert.equal(await d.db.activityLog.count({ where: { action: 'legacy_bridge_import_applied' } }), auditBefore + 1)
  assert.deepEqual(applied.applied, { created: 6, adopted: 0, unchanged: 0, conflict: 0, gone: 0 })
  for (const s of seeded) {
    const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: s.orderId } })
    if (s.shape.expect === null) { assert.equal(link, null); continue }
    assert.equal(link?.state, s.shape.expect.state, s.shape.name)
    assert.equal(link?.externalOrderId, s.shape.expect.externalOrderId, s.shape.name)
    assert.equal(link?.connector, 'mintsoft')
    assert.equal(link?.pushWarehouseId, warehouse.id)
  }
  const merged = seeded.find((s) => s.shape.name === 'merged')!
  assert.equal((await d.db.wmsOrderPushLink.findUnique({ where: { orderId: merged.orderId } }))?.state, 'MERGED')

  // IDEMPOTENT: a rerun changes nothing (not a column, not an updatedAt).
  const snapshot = JSON.stringify(await d.db.wmsOrderPushLink.findMany({ where: { orderId: { in: orderIds } }, orderBy: { orderId: 'asc' } }))
  const again = await d.run.runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ['processing'] })
  assert.deepEqual(again.plan, { create: 0, adopt: 0, unchanged: 6, conflict: 0, none: 0, blocked: 0, unreadable: 0, noImsOrder: 0 })
  assert.equal(JSON.stringify(await d.db.wmsOrderPushLink.findMany({ where: { orderId: { in: orderIds } }, orderBy: { orderId: 'asc' } })), snapshot)

  // A DIFFERING LINK IS NEVER OVERWRITTEN: point the plain order's link elsewhere; the import reports a conflict and leaves it.
  const plain = seeded.find((s) => s.shape.name === 'plain')!
  await d.db.wmsOrderPushLink.update({ where: { orderId: plain.orderId }, data: { externalOrderId: '123456' } })
  const conflicted = await d.run.runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ['processing'] })
  assert.equal(conflicted.conflicts.length, 1)
  assert.equal(conflicted.gate.exitCode, 3)
  assert.equal((await d.db.wmsOrderPushLink.findUnique({ where: { orderId: plain.orderId } }))?.externalOrderId, '123456')
  await d.db.wmsOrderPushLink.update({ where: { orderId: plain.orderId }, data: { externalOrderId: '9001' } })

  // THE STATE COUNTS: the same id in a DEAD_LETTER link is a conflict (no sweep pass acts on it), never "unchanged".
  await d.db.wmsOrderPushLink.update({ where: { orderId: plain.orderId }, data: { state: 'DEAD_LETTER' } })
  const staleState = await d.run.runLegacyBridgeImport(ports, { statuses: ['processing'] })
  assert.equal(staleState.conflicts.length, 1)
  assert.equal(staleState.plan.unchanged, 5)
  assert.equal(staleState.gate.exitCode, 3)
  assert.equal((await d.db.wmsOrderPushLink.findUnique({ where: { orderId: plain.orderId } }))?.state, 'DEAD_LETTER')
  await d.db.wmsOrderPushLink.update({ where: { orderId: plain.orderId }, data: { state: 'SYNCED' } })

  // THE SWEEP: three runs create nothing for any bridge-created order; the control (no bridge state, no link) is created, once.
  const calls: string[] = []
  const connector = {
    pushOrder: async (input: { orderNumber: string }) => { calls.push(`pushOrder:${input.orderNumber}`); return { externalOrderId: 'wms-ctl-1', externalOrderNumber: 'WN-CTL-1', status: 'NEW' } },
    updateOrder: async () => { calls.push('updateOrder'); return { updated: true, status: 'NEW' } },
    cancelOrder: async () => { calls.push('cancelOrder'); return { cancelled: true, status: 'CANCELLED' } },
    addOrderComment: async () => { calls.push('addOrderComment') },
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'MISSING' as const,
  }
  const results = []
  for (let i = 0; i < 3; i += 1) results.push(await d.sweep.runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { batchSize: 1000 }))
  const control = seeded.find((s) => s.shape.name === 'control')!
  const pushes = calls.filter((c) => c.startsWith('pushOrder'))
  console.log(`# sweeps created=${results.map((r) => r.created).join(',')} calls=${JSON.stringify(calls)}`)
  assert.deepEqual(pushes, [`pushOrder:${control.number}`], 'only the control order is created, and once; no bridge-created order is')
  assert.deepEqual(results.map((r) => r.created), [1, 0, 0])
  assert.equal(calls.includes('updateOrder'), false, 'adoption does not amend a Mintsoft order')
  assert.equal(calls.includes('cancelOrder'), false)
  for (const s of seeded.filter((x) => x.shape.expect !== null)) {
    const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: s.orderId } })
    assert.equal(link?.externalOrderId, s.shape.expect!.externalOrderId, `${s.shape.name} still names the bridge's Mintsoft order`)
  }
})
