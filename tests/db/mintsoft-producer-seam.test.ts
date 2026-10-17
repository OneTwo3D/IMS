import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE MINTSOFT PRODUCER SEAMS AGAINST A REAL DATABASE: THE DIFFERENTIAL, THE SHADOW STORE, THE TRANSACTION, THE REAL ORDER-PUSH PORT AND RETENTION.
 *
 * Drives the REAL entry points (the seam through the pooled client and through a caller's transaction, and the REAL order-push sweep
 * over the REAL Prisma port with a seeded, paid, bound order) with the switch OFF, with the switch ON and no grant (the P0/P1
 * posture), and in the live phase, and reads the rows each run leaves: the push link, and the outbound_shadow_writes record that is
 * the only evidence a Mintsoft shadow has. Mintsoft is LIVE and is never contacted: the connector in the sweep is a double that
 * records its calls, and the tests/no-outbound-network.cjs trap fails a test that tried to leave the box.
 *
 * Fixtures are unique per run and removed afterwards. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  claim-then-shadow           the create pass claims the order before asking the seam: the "no link row" arm goes red
 *  c  drop-the-unique-key         the shadow upsert becomes a plain insert: the repeat and the concurrent arms go red
 *  g  shadow-outside-the-tx       the shadow is written on the pool instead of the caller's transaction: the rollback arm goes red
 *  h  retention-deletes-shadows   purgeExpiredData also deletes outbound_shadow_writes: the retention arm goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/mintsoft-producer-seam.test.ts would have been skipped.')
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM']
const ON = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }
const LIVE = { ...ON, MINTSOFT_WRITE_ALLOWED: 'https://wms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: '2026-06-01T00:00:00Z' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, seam, record, retention, sweep, evidence] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/mintsoft/producer-seam.ts'),
    import('../../lib/domain/outbound-shadow/record.ts'),
    import('../../lib/data-retention.ts'),
    import('../../lib/domain/wms/order-push-sweep.ts'),
    import('../../lib/domain/outbound-shadow/durable-evidence.ts'),
  ])
  return { db, seam, record, retention, sweep, evidence }
}
type Deps = Awaited<ReturnType<typeof deps>>

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

const shadowsFor = (d: Deps, id: string) => d.db.outboundShadowWrite.findMany({
  where: { subjectId: { contains: id } },
  select: { destination: true, operation: true, subjectType: true, subjectId: true, occurrences: true, reason: true, owner: true, phase: true, grantState: true, payloadDigest: true, firstProducedAt: true, summary: true },
})
async function cleanupShadows(d: Deps, ids: string[]): Promise<void> {
  for (const id of ids) await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { contains: id } } })
}

test('SEAM through the pooled client: OFF records nothing (the control); ON records one shadow per piece of work, counts a repeat, and keeps the digest of the payload but not the payload', { skip }, async (t) => {
  const d = await deps()
  const id = `mss-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  await withEnv({}, async () => {
    const answer = await d.seam.mintsoftProducerSeam({ operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload: { orderNumber: id } })
    assert.equal(answer.proceed, true)
    assert.equal('clearance' in answer, true, 'a proceed carries the clearance')
    assert.equal((await shadowsFor(d, id)).length, 0, 'CONTROL: nothing is recorded when the switch is off')
  })
  await withEnv(ON, async () => {
    const payload = { orderNumber: id, customerEmail: 'private@example.com', lines: [{ sku: 'A', quantity: 1 }] }
    const first = await d.seam.mintsoftProducerSeam({ operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload, obligationAt: new Date('2026-05-01T00:00:00Z') })
    const second = await d.seam.mintsoftProducerSeam({ operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload })
    const other = await d.seam.mintsoftProducerSeam({ operation: 'order.cancel', subjectType: 'SalesOrder', subjectId: id, payload: { externalOrderId: 'x' } })
    assert.equal(first.proceed, false)
    assert.equal(second.proceed, false)
    assert.equal(other.proceed, false)
    const rows = await shadowsFor(d, id)
    console.log(`# ON: shadows=${JSON.stringify(rows.map((r) => [r.operation, r.subjectType, r.occurrences, r.reason, r.owner, r.phase, r.grantState]))}`)
    assert.equal(rows.length, 2, 'create and cancel are different work on the same order: one record each')
    const create = rows.find((row) => row.operation === 'order.create')!
    assert.equal(create.occurrences, 2, 'the same work produced twice is ONE record that counts the repeat')
    assert.deepEqual([create.destination, create.subjectType, create.reason, create.owner, create.phase, create.grantState], ['mintsoft', 'SalesOrder', 'no_grant', 'woo-mintsoft-plugin', 'P1', 'absent'])
    assert.match(create.payloadDigest, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(rows).includes('private@example.com'), false, 'the payload (and its personal data) is digested, never stored')
  })
})

test('CONCURRENCY: eight producers of the same work make ONE shadow row counting eight, never a lost update or a duplicate', { skip }, async (t) => {
  const d = await deps()
  const id = `msc-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'woo-mintsoft-plugin', phase: 'P1', cutoff: null, grant: 'absent' } as never
  const results = await Promise.all(Array.from({ length: 8 }, () => d.record.recordOutboundShadow(d.db, {
    destination: 'mintsoft', operation: 'product.upsert', subjectType: 'Product', subjectId: id, payload: { productId: id }, decision,
  })))
  const shadows = await shadowsFor(d, id)
  console.log(`# concurrent: rows=${shadows.length} occurrences=${shadows[0]?.occurrences} inserted=${results.filter((r) => r.inserted).length}`)
  assert.equal(shadows.length, 1)
  assert.equal(shadows[0]!.occurrences, 8)
  assert.equal(results.filter((r) => r.inserted).length, 1, 'exactly one producer created it')
})

test('TRANSACTION: the shadow commits WITH the business change and rolls back WITH it', { skip }, async (t) => {
  const d = await deps()
  const id = `mst-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  await withEnv(ON, async () => {
    await d.db.$transaction(async (tx: Tx) => {
      const answer = await d.seam.mintsoftProducerSeam({ operation: 'asn.create', subjectType: 'PurchaseOrder', subjectId: id, payload: { id }, client: tx })
      assert.equal(answer.proceed, false)
    }, { timeout: 60_000 })
    assert.equal((await shadowsFor(d, id)).length, 1, 'committed with the business change')
    await cleanupShadows(d, [id])
    await assert.rejects(d.db.$transaction(async (tx: Tx) => {
      await d.seam.mintsoftProducerSeam({ operation: 'asn.create', subjectType: 'PurchaseOrder', subjectId: id, payload: { id }, client: tx })
      assert.equal(await tx.outboundShadowWrite.count({ where: { subjectId: id } }), 1, 'precondition: visible inside the transaction')
      throw new Error('the business change failed after the seam')
    }, { timeout: 60_000 }), /the business change failed/)
    assert.equal((await shadowsFor(d, id)).length, 0, 'rolled back with the business change (it is evidence of work that did not happen)')
  })
})

// ───────────────────────── the REAL order-push port ─────────────────────────

async function seedOrder(d: Deps, tag: string, paidAt: Date) {
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const binding = await d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() },
    select: { id: true },
  })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `MSP-${tag}`,
      status: 'PROCESSING',
      paidAt,
      shipFromWarehouseId: warehouse.id,
      customerName: 'Pat Example',
      customerEmail: 'pat@example.com',
      currency: 'GBP',
      shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `SKU-${tag}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  return { warehouseId: warehouse.id, connectionId: connection.id, bindingId: binding.id, orderId: order.id }
}
async function cleanupOrder(d: Deps, seeded: { warehouseId: string; connectionId: string; bindingId: string; orderId: string }) {
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: seeded.orderId } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: seeded.orderId } })
  await d.db.salesOrder.deleteMany({ where: { id: seeded.orderId } })
  await d.db.externalWmsBinding.deleteMany({ where: { id: seeded.bindingId } })
  await d.db.wmsConnection.deleteMany({ where: { id: seeded.connectionId } })
  await d.db.warehouse.deleteMany({ where: { id: seeded.warehouseId } })
  await cleanupShadows(d, [seeded.orderId])
}

function connectorDouble() {
  const calls: string[] = []
  return {
    calls,
    connector: {
      pushOrder: async (input: { orderNumber: string }) => { calls.push(`pushOrder:${input.orderNumber}`); return { externalOrderId: 'wms-db-1', externalOrderNumber: 'WN-DB-1', status: 'NEW' } },
      updateOrder: async () => { calls.push('updateOrder'); return { updated: true, status: 'NEW' } },
      cancelOrder: async () => { calls.push('cancelOrder'); return { cancelled: true, status: 'CANCELLED' } },
      addOrderComment: async () => { calls.push('addOrderComment') },
      verifyPushedOrder: async () => 'ours' as const,
      probeOrderPresence: async () => 'MISSING' as const,
    },
  }
}

test('REAL ORDER-PUSH PORT: OFF claims and links the order (the control); ON leaves NO link row, no attempt, no connector call, and one shadow that counts the repeat tick', { skip }, async (t) => {
  const d = await deps()
  const tag = `msp${randomUUID().slice(0, 8)}`
  const seeded = await seedOrder(d, tag, new Date('2026-06-10T00:00:00Z'))
  t.after(() => cleanupOrder(d, seeded))
  const port = d.sweep.createPrismaWmsOrderPushPort()

  await withEnv(ON, async () => {
    const double = connectorDouble()
    const first = await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port, { batchSize: 1000 })
    const second = await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port, { batchSize: 1000 })
    const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: seeded.orderId } })
    const shadows = await shadowsFor(d, seeded.orderId)
    console.log(`# ON: link=${JSON.stringify(link)} calls=${JSON.stringify(double.calls)} shadows=${JSON.stringify(shadows.map((s) => [s.operation, s.occurrences, s.reason]))} results=${first.shadowed},${second.shadowed}`)
    assert.equal(link, null, 'no claim, no PENDING_CREATE, no stamp, no attempt: the order is simply offered again')
    assert.deepEqual(double.calls, [])
    assert.ok((first.shadowed ?? 0) >= 1 && (second.shadowed ?? 0) >= 1, 'precondition: the seeded order was a create candidate in both ticks')
    assert.equal(shadows.length, 1)
    assert.equal(shadows[0]!.occurrences, 2, 'two ticks, one record that counts both')
    assert.deepEqual([shadows[0]!.operation, shadows[0]!.subjectType, shadows[0]!.reason], ['order.create', 'SalesOrder', 'no_grant'])
  })

  await withEnv({}, async () => {
    const double = connectorDouble()
    const result = await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port, { batchSize: 1000 })
    const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: seeded.orderId } })
    console.log(`# OFF (control): link=${JSON.stringify({ state: link?.state, externalOrderId: link?.externalOrderId })} calls=${JSON.stringify(double.calls)}`)
    assert.ok(result.created >= 1, 'CONTROL: the same sweep over the same order pushes it when the switch is off')
    assert.deepEqual(double.calls.filter((call) => call.startsWith('pushOrder')), [`pushOrder:MSP-${tag}`])
    assert.equal(link?.state, 'SYNCED')
    assert.equal('shadowed' in result, false)
  })
})

test('REAL ORDER-PUSH PORT, LIVE PHASE: an order paid BEFORE the live-from instant is left out of the create query (never claimed, no link); one paid AFTER it is pushed', { skip }, async (t) => {
  const d = await deps()
  const before = await seedOrder(d, `msb${randomUUID().slice(0, 8)}`, new Date('2026-05-01T00:00:00Z'))
  const after = await seedOrder(d, `msa${randomUUID().slice(0, 8)}`, new Date('2026-06-10T00:00:00Z'))
  t.after(async () => { await cleanupOrder(d, before); await cleanupOrder(d, after) })
  const port = d.sweep.createPrismaWmsOrderPushPort()
  await withEnv(LIVE, async () => {
    const double = connectorDouble()
    await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port, { batchSize: 1000 })
    const linkBefore = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: before.orderId } })
    const linkAfter = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: after.orderId } })
    const shadowBefore = await shadowsFor(d, before.orderId)
    console.log(`# LIVE: before link=${linkBefore?.state ?? null} after link=${linkAfter?.state ?? null} shadow=${JSON.stringify(shadowBefore.map((s) => s.reason))}`)
    assert.equal(linkBefore, null, 'the pre-cutoff order was never claimed')
    assert.equal(linkAfter?.state, 'SYNCED', 'the post-cutoff order was pushed')
    assert.deepEqual(shadowBefore, [], 'the pre-cutoff order is not selected at all, so it cannot occupy a slot of the bounded batch')
    assert.equal((await shadowsFor(d, after.orderId)).length, 0)
  })
})

// ───────────────────────── retention and evidence ─────────────────────────

test('RETENTION: the shadow record of a Mintsoft write (its only evidence) survives the real retention sweep, aged far past every window', { skip }, async (t) => {
  const d = await deps()
  const id = `msr-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  await withEnv(ON, async () => {
    const answer = await d.seam.mintsoftProducerSeam({ operation: 'product.upsert', subjectType: 'Product', subjectId: id, payload: { productId: id } })
    assert.equal(answer.proceed, false, 'precondition: the seam recorded a shadow through the pooled client')
  })
  const old = new Date(Date.now() - 2000 * 24 * 3600 * 1000)
  await d.db.outboundShadowWrite.updateMany({ where: { subjectId: id }, data: { firstProducedAt: old, lastProducedAt: old } })
  const purged = await d.retention.purgeExpiredData()
  const after = await shadowsFor(d, id)
  console.log(`# retention ran (${Object.keys(purged).length} counters); aged shadow records remaining: ${after.length}`)
  assert.equal(after.length, 1)
  assert.ok(after[0]!.firstProducedAt.getTime() < Date.now() - 1500 * 24 * 3600 * 1000, 'precondition: the row really is older than every retention window')
})

test('SEPARATE EVIDENCE STATE: a Mintsoft shadow is never read as a Xero or WooCommerce posting - the durable-evidence reader answers per destination', { skip }, async (t) => {
  const d = await deps()
  const id = `msx-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'woo-mintsoft-plugin', phase: 'P1', cutoff: null, grant: 'absent' } as never
  await d.record.recordOutboundShadow(d.db, { destination: 'mintsoft', operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload: { a: 1 }, decision })
  for (const other of ['xero', 'woocommerce']) {
    assert.deepEqual(await d.evidence.findDurableShadowRecords(d.db as never, other, [{ subjectType: 'SalesOrder', exactIds: [id] }]), [], `a Mintsoft shadow does not make an order look shadowed for ${other}`)
  }
  const own = await d.evidence.findDurableShadowRecords(d.db as never, 'mintsoft', [{ subjectType: 'SalesOrder', exactIds: [id] }])
  assert.deepEqual(own.map((r) => r.operation), ['order.create'], 'only the Mintsoft question is answered by it')
})

test('EVIDENCE READER FOR THE ORDER PAGE: a shadowed order is its own state (with the count), only while the hold is enforced, only for Mintsoft, and only for order creates', { skip }, async (t) => {
  const d = await deps()
  const id = `msv-${randomUUID()}`
  t.after(() => cleanupShadows(d, [id]))
  const { wmsOrderCreateShadowEvidence } = await import('../../lib/connectors/wms/producer-seam.ts')
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'woo-mintsoft-plugin', phase: 'P1', cutoff: null, grant: 'absent' } as never
  await d.record.recordOutboundShadow(d.db, { destination: 'mintsoft', operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload: { a: 1 }, decision })
  await d.record.recordOutboundShadow(d.db, { destination: 'mintsoft', operation: 'order.create', subjectType: 'SalesOrder', subjectId: id, payload: { a: 1 }, decision })
  await d.record.recordOutboundShadow(d.db, { destination: 'mintsoft', operation: 'order.cancel', subjectType: 'SalesOrder', subjectId: id, payload: { a: 2 }, decision })
  await withEnv({}, async () => assert.equal(await wmsOrderCreateShadowEvidence('mintsoft', id), null, 'CONTROL: not enforced, so no read and no state'))
  await withEnv(ON, async () => {
    const evidence = await wmsOrderCreateShadowEvidence('mintsoft', id)
    console.log(`# evidence: ${JSON.stringify(evidence)}`)
    assert.equal(evidence?.occurrences, 2, 'the create shadow counted twice; the cancel shadow is another operation and is not counted')
    assert.match(evidence!.notice, /^Not sent by IMS: writes to the warehouse are held on this installation/)
    assert.match(evidence!.notice, /does not say whether the warehouse already holds it/)
    assert.equal(await wmsOrderCreateShadowEvidence('mintsoft', `${id}-other`), null)
    assert.equal(await wmsOrderCreateShadowEvidence('acme-wms', id), null, 'a connector this build does not register has none')
  })
  await withEnv({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => assert.equal(await wmsOrderCreateShadowEvidence('mintsoft', id), null))
})
