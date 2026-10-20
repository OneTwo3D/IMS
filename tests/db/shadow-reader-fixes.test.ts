import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE READERS OF A SHADOW AGAINST A REAL DATABASE: the queries a unit double cannot prove.
 *
 * Arms: (1) the warehouse reconcile while the hold stands (no "not pushed" drift; open findings closed with a disposition), (2) the held
 * create pass's rotating cursor on the real port, (3) the daily-batch rebuild verdict over real rows, (4) the Xero ordering reads that
 * must not wait behind a never-claimable pre-cutoff row, (5) the outbox re-arm that must not erase a retirement shadow, (6) the durable
 * record that names an expired shadow row.
 *
 * Fixtures are unique per run and removed afterwards. GATED on RUN_DB_RETENTION_TESTS (npm run test:db). No vendor is contacted.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  reconcile-ignores-hold      listUnpushedIntentOrders / resolveNotPushedChunk stop asking wmsProducerHold: arm 1 goes red
 *  b  cursor-ignored              createCandidates drops the id > afterId clause: arm 2 goes red
 *  c  verdict-counts-shadow       dailyBatchRecreateVerdict stops filtering shadows out of the refusal: arm 3 goes red
 *  d  payments-wait-on-never      the ordering reads drop xeroNotNeverDeliverablePendingWhere: arm 4 goes red
 *  e  rearm-erases-shadowed       scheduleXeroAccountingOutbox re-arms a SHADOWED job: arm 5 goes red
 *  f  record-not-asked            shadowRecordNamesSyncLog answers false: arm 6 goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/shadow-reader-fixes.test.ts would have been skipped.')
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const OFF = {}
const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }
const XERO_LIVE = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: '4f7f0c6e-1111-4222-8333-944455556666', XERO_WRITES_LIVE_FROM: '2026-06-01T00:00:00Z' }

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, sweep, reconcile, daily, processor, outbox, evidence, xeroOutbox] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/wms/order-push-sweep.ts'),
    import('../../lib/domain/wms/order-reconcile-sweep.ts'),
    import('../../lib/connectors/xero/daily-sync.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/integrations/outbox.ts'),
    import('../../lib/domain/outbound-shadow/durable-evidence.ts'),
    import('../../lib/connectors/xero/outbox.ts'),
  ])
  return { db, sweep, reconcile, daily, processor, outbox, evidence, xeroOutbox }
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

async function seedWarehouse(d: Deps, tag: string) {
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const binding = await d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() },
    select: { id: true },
  })
  return { warehouseId: warehouse.id, connectionId: connection.id, bindingId: binding.id, orderIds: [] as string[] }
}
async function seedOrderIn(d: Deps, wh: Awaited<ReturnType<typeof seedWarehouse>>, tag: string, paidAt: Date): Promise<string> {
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `SRF-${tag}`, status: 'PROCESSING', paidAt, shipFromWarehouseId: wh.warehouseId,
      customerName: 'Pat Example', customerEmail: 'pat@example.com', currency: 'GBP',
      shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `SKU-${tag}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  wh.orderIds.push(order.id)
  return order.id
}
async function cleanupWarehouse(d: Deps, wh: Awaited<ReturnType<typeof seedWarehouse>>) {
  await d.db.wmsOrderDiscrepancy.deleteMany({ where: { orderId: { in: wh.orderIds } } })
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: wh.orderIds } } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: { in: wh.orderIds } } })
  await d.db.salesOrder.deleteMany({ where: { id: { in: wh.orderIds } } })
  await d.db.externalWmsBinding.deleteMany({ where: { id: wh.bindingId } })
  await d.db.wmsConnection.deleteMany({ where: { id: wh.connectionId } })
  await d.db.warehouse.deleteMany({ where: { id: wh.warehouseId } })
  await d.db.setting.deleteMany({ where: { key: d.sweep.HELD_CREATE_CURSOR_KEY } })
}

test('RECONCILE WHILE HELD: an unlinked paid order is NOT_PUSHED drift with the switch off (the control) and is not while the hold stands; an open finding is closed with the held disposition, not left open', { skip }, async (t) => {
  const d = await deps()
  const tag = `srf${randomUUID().slice(0, 8)}`
  const wh = await seedWarehouse(d, tag)
  const orderId = await seedOrderIn(d, wh, tag, new Date('2026-05-01T00:00:00Z'))
  t.after(() => cleanupWarehouse(d, wh))
  const deps2 = d.reconcile.createPrismaReconcileDeps('mintsoft', {} as never)
  const listed = async () => (await deps2.listUnpushedIntentOrders(1_000_000)).some((row: { orderId: string }) => row.orderId === orderId)
  await withEnv(OFF, async () => assert.equal(await listed(), true, 'CONTROL: detection finds the unlinked paid order'))
  await withEnv(HELD, async () => assert.equal(await listed(), false, 'no link is written while every create is a shadow, so absence of a link is not drift'))
  await withEnv({ ...HELD, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => assert.equal(await listed(), true, 'CONTROL: enforced for another destination'))
  const finding = await d.db.wmsOrderDiscrepancy.create({ data: { connector: 'mintsoft', orderId, category: 'NOT_PUSHED', status: 'OPEN', detail: 'old' }, select: { id: true } })
  const resolve = () => d.reconcile.resolveNotPushedChunk({ connectorId: 'mintsoft', boundWarehouseIds: [wh.warehouseId], rows: [{ id: finding.id, orderId }], now: new Date() })
  await withEnv(OFF, async () => {
    const outcome = await resolve()
    assert.deepEqual([outcome.resolved, outcome.outOfScope], [0, 0], 'CONTROL: still drifting, so the finding stays open')
  })
  await withEnv(HELD, async () => {
    const outcome = await resolve()
    const row = await d.db.wmsOrderDiscrepancy.findUnique({ where: { id: finding.id } })
    assert.equal(outcome.outOfScope, 1)
    assert.equal(row?.status, 'RESOLVED')
    assert.equal(row?.detail, d.reconcile.WMS_RECONCILE_HELD_DETAIL)
    assert.equal(await d.db.wmsOrderPushLink.findUnique({ where: { orderId } }), null, 'closed without a push link')
  })
})

test('HELD CREATE PASS CURSOR: the real port pages candidates by id after the cursor; the cursor is stored and cleared; without a rotation the legacy updatedAt order is untouched', { skip }, async (t) => {
  const d = await deps()
  const tag = `srg${randomUUID().slice(0, 8)}`
  const wh = await seedWarehouse(d, tag)
  const ids: string[] = []
  for (let i = 0; i < 3; i += 1) ids.push(await seedOrderIn(d, wh, `${tag}${i}`, new Date('2026-05-01T00:00:00Z')))
  ids.sort()
  t.after(() => cleanupWarehouse(d, wh))
  const port = d.sweep.createPrismaWmsOrderPushPort()
  const page = async (afterId: string | null) => (await port.createCandidates('mintsoft', [wh.warehouseId], 2, undefined, { afterId })).map((row: { id: string }) => row.id)
  assert.deepEqual(await page(null), ids.slice(0, 2), 'the walk starts at the head in id order')
  assert.deepEqual(await page(ids[1]!), ids.slice(2), 'and continues after the cursor')
  assert.deepEqual(await page(ids[2]!), [], 'past the last id the page is empty')
  const legacy = (await port.createCandidates('mintsoft', [wh.warehouseId], 3)).map((row: { id: string }) => row.id)
  assert.equal(legacy.length, 3, 'CONTROL: no rotation is the legacy query')
  const cursor = port.heldCreateCursor!
  assert.equal(await cursor.read(), null)
  await cursor.write(ids[1]!)
  assert.equal(await cursor.read(), ids[1])
  await cursor.write(ids[2]!)
  assert.equal(await cursor.read(), ids[2], 'overwritten, not duplicated')
  await cursor.write(null)
  assert.equal(await cursor.read(), null)
})

async function seedLog(d: Deps, overrides: Record<string, unknown>) {
  return d.db.accountingSyncLog.create({
    data: { connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING', referenceType: 'DailyBatch', referenceId: 'x', payload: {}, ...overrides } as never,
    select: { id: true },
  })
}

test('DAILY-BATCH REBUILD VERDICT over real rows: a shadow blocks the rebuild quietly; a FAILED row still gets the refusal; a live row blocks as before; no row is not blocked', { skip }, async (t) => {
  const d = await deps()
  const tag = randomUUID().slice(0, 8)
  const ref = (n: string) => `A1-2099-0${n}-${tag}`
  const ids: string[] = []
  t.after(async () => { await d.db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } }) })
  const seed = async (overrides: Record<string, unknown>) => { ids.push((await seedLog(d, overrides)).id) }
  await seed({ referenceId: ref('1'), status: 'CANCELLED', settlementBasis: 'HELD_SHADOW', abandonedBeforeRemoteCall: true })
  await seed({ referenceId: ref('2'), status: 'CANCELLED', settlementBasis: 'HELD_SHADOW', abandonedBeforeRemoteCall: true })
  await seed({ referenceId: ref('2'), status: 'FAILED', abandonedBeforeRemoteCall: false })
  await seed({ referenceId: ref('3'), status: 'PENDING' })
  await seed({ referenceId: ref('4'), status: 'CANCELLED', settlementBasis: null, abandonedBeforeRemoteCall: true })
  const verdict = (n: string) => d.daily.dailyBatchRecreateVerdict('DAILY_BATCH_REVENUE_DEFERRAL', { exact: [ref(n)], derived: [] })
  const shadowOnly = await verdict('1')
  assert.deepEqual(shadowOnly, { blocked: true, refusal: null }, 'a shadow blocks the rebuild and raises nothing')
  const mixed = await verdict('2')
  assert.equal(mixed.blocked, true)
  assert.match(mixed.refusal ?? '', /not recreated/, 'a FAILED row beside the shadow keeps the refusal')
  assert.doesNotMatch(mixed.refusal ?? '', /HELD_SHADOW/)
  assert.deepEqual(await verdict('3'), { blocked: true, refusal: null }, 'CONTROL: a live row blocks as before')
  assert.deepEqual(await verdict('4'), { blocked: false, refusal: null }, 'CONTROL: a proven-pre-call orphan row is rebuildable as before')
  assert.deepEqual(await verdict('9'), { blocked: false, refusal: null }, 'CONTROL: nothing there')
})

test('XERO ORDERING READS: a never-claimable pre-cutoff PENDING payment/create does not defer the later ones; with the switch off, or a PROCESSING row, they still wait', { skip }, async (t) => {
  const d = await deps()
  const tag = randomUUID().slice(0, 8)
  const order = `so-${tag}`
  const ids: string[] = []
  t.after(async () => { await d.db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } }) })
  const mk = async (overrides: Record<string, unknown>) => {
    const row = await seedLog(d, { referenceType: 'SalesOrder', referenceId: order, ...overrides })
    ids.push(row.id)
    return row.id
  }
  const oldPay = await mk({ type: 'INVOICE_PAYMENT', status: 'PENDING', payload: { accountingInvoiceId: 'inv-a' }, createdAt: new Date('2026-05-01T00:00:00Z') })
  const newPay = await mk({ type: 'INVOICE_PAYMENT', status: 'PENDING', payload: { accountingInvoiceId: 'inv-b' }, createdAt: new Date('2026-07-01T00:00:00Z') })
  const entry = (id: string, createdAt: string) => ({ id, type: 'INVOICE_PAYMENT' as const, referenceType: 'SalesOrder', referenceId: order, createdAt: new Date(createdAt) })
  const blocked = (entries: ReturnType<typeof entry>[]) => d.processor.findInvoicePaymentsBlockedByEarlierLiveLogs(d.db as never, entries)
  const entries = [entry(oldPay, '2026-05-01T00:00:00Z'), entry(newPay, '2026-07-01T00:00:00Z')]
  await withEnv(OFF, async () => {
    const set = await blocked(entries)
    assert.equal(set.has(newPay), true, 'CONTROL: switch off, the later payment waits behind the earlier PENDING one')
  })
  await withEnv(XERO_LIVE, async () => {
    const set = await blocked([entries[1]!])
    assert.equal(set.has(newPay), false, 'the earlier row predates the live-from instant and can never be claimed, so it is not work to wait behind')
  })
  // a PROCESSING row created before the floor may be an attempt in flight: it keeps blocking.
  await d.db.accountingSyncLog.update({ where: { id: oldPay }, data: { status: 'PROCESSING', processingStartedAt: new Date() } })
  await withEnv(XERO_LIVE, async () => {
    const set = await blocked([entries[1]!])
    assert.equal(set.has(newPay), true, 'a pre-cutoff PROCESSING row still blocks: waiting behind an undetermined attempt is the money-safe answer')
  })
  // the updates ordering read
  const purchase = `po-${tag}`
  const createRow = await seedLog(d, { type: 'PURCHASE_INVOICE', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId: purchase, createdAt: new Date('2026-05-01T00:00:00Z') })
  const updateRow = await seedLog(d, { type: 'PURCHASE_INVOICE_UPDATE', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId: purchase, createdAt: new Date('2026-07-01T00:00:00Z') })
  ids.push(createRow.id, updateRow.id)
  const updateEntry = { id: updateRow.id, type: 'PURCHASE_INVOICE_UPDATE' as const, referenceType: 'PurchaseOrder', referenceId: purchase, createdAt: new Date('2026-07-01T00:00:00Z') }
  await withEnv(OFF, async () => assert.equal((await d.processor.findInvoiceUpdatesBlockedByPendingCreate(d.db as never, [updateEntry as never])).has(updateRow.id), true, 'CONTROL'))
  await withEnv(XERO_LIVE, async () => assert.equal((await d.processor.findInvoiceUpdatesBlockedByPendingCreate(d.db as never, [updateEntry as never])).has(updateRow.id), false))
})

test('OUTBOX RE-ARM: a job the retirement SHADOWED is not re-armed to PENDING; a job in any other settled state still is (the control)', { skip }, async (t) => {
  const d = await deps()
  const tag = randomUUID().slice(0, 8)
  const syncRow = await seedLog(d, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: `so-${tag}` })
  const syncRow2 = await seedLog(d, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: `so2-${tag}` })
  t.after(async () => {
    await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { in: [d.xeroOutbox.buildXeroAccountingOutboxIdempotencyKey(syncRow.id), d.xeroOutbox.buildXeroAccountingOutboxIdempotencyKey(syncRow2.id)] } } })
    await d.db.accountingSyncLog.deleteMany({ where: { id: { in: [syncRow.id, syncRow2.id] } } })
  })
  const prepare = async (id: string, status: string) => {
    await d.xeroOutbox.scheduleXeroAccountingOutbox(d.db as never, { accountingSyncLogId: id })
    await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: d.xeroOutbox.buildXeroAccountingOutboxIdempotencyKey(id) }, data: { status } })
  }
  const statusOf = async (id: string) => (await d.db.integrationOutbox.findUnique({ where: { idempotencyKey: d.xeroOutbox.buildXeroAccountingOutboxIdempotencyKey(id) } }))?.status
  await prepare(syncRow.id, 'SHADOWED')
  await prepare(syncRow2.id, 'PERMANENT_FAILED')
  await d.xeroOutbox.scheduleXeroAccountingOutbox(d.db as never, { accountingSyncLogId: syncRow.id })
  await d.xeroOutbox.scheduleXeroAccountingOutbox(d.db as never, { accountingSyncLogId: syncRow2.id })
  assert.equal(await statusOf(syncRow.id), 'SHADOWED', 'the retirement record is not erased')
  assert.equal(await statusOf(syncRow2.id), 'PENDING', 'CONTROL: a dead letter is re-armed as before')
})

test('DURABLE RECORD NAMING AN EXPIRED SHADOW ROW: shadowRecordNamesSyncLog answers true for the named row id only', { skip }, async (t) => {
  const d = await deps()
  const named = `gone-${randomUUID()}`
  const record = await d.db.outboundShadowWrite.create({
    data: { destination: 'xero', operation: 'inventory.journals', subjectType: 'DailyBatch', subjectId: `B-${named}`, payloadDigest: 'a'.repeat(64), reason: 'no_grant', owner: 'qoblex-native', phase: 'P1', grantState: 'absent', accountingSyncLogId: named },
    select: { id: true },
  })
  t.after(async () => { await d.db.outboundShadowWrite.deleteMany({ where: { id: record.id } }) })
  assert.equal(await d.evidence.shadowRecordNamesSyncLog(d.db as never, named), true)
  assert.equal(await d.evidence.shadowRecordNamesSyncLog(d.db as never, `${named}-other`), false, 'CONTROL: another row id')
  await assert.rejects(() => d.evidence.shadowRecordNamesSyncLog({} as never, named), /refusing to treat/, 'a client that cannot ask throws; it never reads as none')
})
