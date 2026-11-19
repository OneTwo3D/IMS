import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * THE WOOCOMMERCE STOCK-DRIFT OBSERVER AGAINST A REAL DATABASE, WITH A FAKE STORE READ (nothing leaves the box).
 * It commits (the observer writes in its own transaction), so each test deletes what it made; the three observer tables are new and used by nothing else.
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/stock-drift.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, drift, evidence] = await Promise.all([import('../../lib/db'), import('../../lib/connectors/woocommerce/stock-drift'), import('../../lib/ops/writers-check-step-evidence')])
  return { db, drift, evidence }
}
type Deps = Awaited<ReturnType<typeof setup>>

const ID = () => String(7_000_000 + Math.floor(Math.random() * 900_000))
const read = (id: string, quantity: number) => async () => [{ id, sku: `S-${id}`, quantity }]
const at = (minutes: number) => () => new Date(Date.UTC(2027, 0, 10, 12, 0) + minutes * 60_000)

async function wipe(d: Deps, extra: () => Promise<unknown> = async () => {}) {
  await d.db.wcStockDriftEvent.deleteMany({})
  await d.db.wcStockSnapshot.deleteMany({})
  await d.db.wcStockDriftRun.deleteMany({})
  await extra()
}

test('[db] first sight sets the baseline (no drift); an unexplained change is an event; an unchanged quantity is nothing', { skip }, async (t) => {
  const d = await setup()
  t.after(() => wipe(d))
  const id = ID()
  const first = await d.drift.observeWcStockDrift({ readCatalogue: read(id, 10), now: at(0) })
  assert.deepEqual([first.ok, first.productsSeen, first.driftFound], [true, 1, 0])
  assert.equal((await d.drift.observeWcStockDrift({ readCatalogue: read(id, 10), now: at(60) })).driftFound, 0)
  const changed = await d.drift.observeWcStockDrift({ readCatalogue: read(id, 7), now: at(120) })
  assert.equal(changed.driftFound, 1)
  const events = await d.db.wcStockDriftEvent.findMany({ where: { externalProductId: id } })
  assert.deepEqual(events.map((e) => [e.fromQuantity, e.toQuantity]), [[10, 7]])
  assert.equal((await d.db.wcStockSnapshot.findUnique({ where: { externalProductId: id } }))?.quantity, 7, 'the snapshot moves, so the same change is not reported twice')
  assert.equal((await d.drift.observeWcStockDrift({ readCatalogue: read(id, 7), now: at(180) })).driftFound, 0)
})

test('[db] a change IMS\'s own push explains, or an order that contains the product explains, is not drift', { skip }, async (t) => {
  const d = await setup()
  const suffix = randomUUID().slice(0, 8)
  const pushId = ID(); const orderId = ID()
  const pushed = await d.db.product.create({ data: { sku: `SD-P-${suffix}`, name: 'pushed', type: 'SIMPLE', externalProductId: BigInt(pushId) }, select: { id: true } })
  const ordered = await d.db.product.create({ data: { sku: `SD-O-${suffix}`, name: 'ordered', type: 'SIMPLE', externalProductId: BigInt(orderId) }, select: { id: true } })
  const order = await d.db.salesOrder.create({
    data: { orderNumber: `SD-${suffix}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'), subtotalForeign: new Prisma.Decimal('10'), totalForeign: new Prisma.Decimal('10'), subtotalBase: new Prisma.Decimal('10'), taxBase: new Prisma.Decimal('0'), totalBase: new Prisma.Decimal('10'),
      lines: { create: [{ productId: ordered.id, description: 'l', qty: new Prisma.Decimal('1'), unitPriceForeign: new Prisma.Decimal('10'), unitPriceBase: new Prisma.Decimal('10'), taxForeign: new Prisma.Decimal('0'), taxBase: new Prisma.Decimal('0'), totalForeign: new Prisma.Decimal('10'), totalBase: new Prisma.Decimal('10') }] } },
    select: { id: true },
  })
  t.after(() => wipe(d, async () => {
    await d.db.salesOrderLine.deleteMany({ where: { orderId: order.id } })
    await d.db.salesOrder.deleteMany({ where: { id: order.id } })
    await d.db.stockSyncState.deleteMany({ where: { productId: pushed.id } })
    await d.db.product.deleteMany({ where: { id: { in: [pushed.id, ordered.id] } } })
  }))
  const both = (a: number, b: number) => async () => [{ id: pushId, sku: 'a', quantity: a }, { id: orderId, sku: 'b', quantity: b }]
  // The baseline was seen BEFORE the order existed and before the push.
  await d.drift.observeWcStockDrift({ readCatalogue: both(10, 10), now: () => new Date(Date.now() - 3 * 3_600_000) })
  await d.db.stockSyncState.create({ data: { connector: 'woocommerce', productId: pushed.id, lastPushedQty: 4, lastPushedAt: new Date() } })
  const run = await d.drift.observeWcStockDrift({ readCatalogue: both(4, 9), now: () => new Date() })
  assert.equal(run.ok, true)
  assert.equal(run.driftFound, 0, 'IMS pushed 4, and an order touched the other product since the last look')
  // The same change with NOTHING to explain it is drift: a third product, changed again with no new order or push.
  const run2 = await d.drift.observeWcStockDrift({ readCatalogue: both(2, 9), now: () => new Date(Date.now() + 3_600_000) })
  assert.equal(run2.driftFound, 1, 'the pushed product moved again to 2, which IMS did not push')
  assert.equal((await d.db.wcStockDriftEvent.findMany()).map((e) => e.externalProductId).join(), pushId)
})

test('[db] a failed read is a run that is NOT ok, changes no snapshot and records no event', { skip }, async (t) => {
  const d = await setup()
  t.after(() => wipe(d))
  const id = ID()
  await d.drift.observeWcStockDrift({ readCatalogue: read(id, 10), now: at(0) })
  const failed = await d.drift.observeWcStockDrift({ readCatalogue: async () => { throw new Error('store down') }, now: at(60) })
  assert.deepEqual([failed.ok, failed.error], [false, 'store down'])
  assert.equal((await d.db.wcStockSnapshot.findUnique({ where: { externalProductId: id } }))?.quantity, 10)
  assert.equal(await d.db.wcStockDriftEvent.count(), 0)
  assert.deepEqual((await d.db.wcStockDriftRun.findMany({ orderBy: { startedAt: 'asc' } })).map((r) => r.ok), [true, false])
})

test('[db] the STOCK_DRIFT evidence reader against the real tables: quiet only after 24 h of complete runs since the owner\'s confirmation', { skip }, async (t) => {
  const d = await setup()
  const attestation = await d.db.writerAttestation.create({ data: { kind: 'qoblex-stock-push-stopped', attestedAt: new Date('2027-01-10T00:00:00Z'), userId: 'cli:test' } })
  t.after(() => wipe(d, async () => { await d.db.writerAttestation.deleteMany({ where: { id: attestation.id } }) }))
  const now = new Date('2027-01-12T00:00:00Z')
  const env = { MINTSOFT_WRITES_LIVE_FROM: '2027-01-05T00:00:00Z', WC_WRITES_LIVE_FROM: '2027-01-11T00:00:00Z' }
  const stockDrift = async () => (await d.evidence.readStepEvidence({ db: d.db as never, now, env, probe: async () => ({ ok: false, reason: 'unreachable', message: '' }), foreignOrders: async () => ({ foreign: 0 }) })).STOCK_DRIFT
  assert.deepEqual(await stockDrift(), { state: 'not-probed' }, 'no run yet')
  await d.db.wcStockDriftRun.createMany({ data: [{ startedAt: new Date('2027-01-10T01:00:00Z'), ok: true }, { startedAt: new Date('2027-01-11T23:00:00Z'), ok: true }] })
  assert.deepEqual(await stockDrift(), { state: 'counted', counted: 0, floor: '2027-01-10T00:00:00.000Z' })
  await d.db.wcStockDriftEvent.create({ data: { externalProductId: '1', fromQuantity: 5, toQuantity: 4, previousObservedAt: new Date('2027-01-11T00:00:00Z'), observedAt: new Date('2027-01-11T12:00:00Z') } })
  await d.db.wcStockDriftEvent.create({ data: { externalProductId: '2', fromQuantity: 5, toQuantity: 4, previousObservedAt: new Date('2027-01-09T00:00:00Z'), observedAt: new Date('2027-01-09T12:00:00Z') } })
  assert.deepEqual(await stockDrift(), { state: 'counted', counted: 1, floor: '2027-01-10T00:00:00.000Z' }, 'an event from before the confirmation is not counted')
})

test('[db] a push made BEFORE the previous look does not explain a later change to the same quantity', { skip }, async (t) => {
  const d = await setup()
  const suffix = randomUUID().slice(0, 8)
  const pushId = ID()
  const product = await d.db.product.create({ data: { sku: `SD-OLD-${suffix}`, name: 'oldpush', type: 'SIMPLE', externalProductId: BigInt(pushId) }, select: { id: true } })
  t.after(() => wipe(d, async () => { await d.db.stockSyncState.deleteMany({ where: { productId: product.id } }); await d.db.product.deleteMany({ where: { id: product.id } }) }))
  // IMS pushed 4 two days ago; the store was then read at 10 an hour ago (someone else moved it); now it reads 4 again with no push since.
  await d.db.stockSyncState.create({ data: { connector: 'woocommerce', productId: product.id, lastPushedQty: 4, lastPushedAt: new Date(Date.now() - 48 * 3_600_000) } })
  await d.drift.observeWcStockDrift({ readCatalogue: async () => [{ id: pushId, sku: 'a', quantity: 10 }], now: () => new Date(Date.now() - 3_600_000) })
  const run = await d.drift.observeWcStockDrift({ readCatalogue: async () => [{ id: pushId, sku: 'a', quantity: 4 }], now: () => new Date() })
  assert.equal(run.driftFound, 1, 'the old push of the same number explains nothing')
})

test('[db] an operator acknowledgement (who, why, audit entry) takes an event out of the STOCK_DRIFT count; it needs a reason and is never silent', { skip }, async (t) => {
  const d = await setup()
  const ack = await import('../../lib/connectors/woocommerce/stock-drift-ack')
  const attestation = await d.db.writerAttestation.create({ data: { kind: 'qoblex-stock-push-stopped', attestedAt: new Date('2027-01-10T00:00:00Z'), userId: 'cli:test' } })
  t.after(() => wipe(d, async () => { await d.db.writerAttestation.deleteMany({ where: { id: attestation.id } }); await d.db.activityLog.deleteMany({ where: { action: 'wc_stock_drift_acknowledged' } }) }))
  const now = new Date('2027-01-12T00:00:00Z')
  const env = { MINTSOFT_WRITES_LIVE_FROM: '2027-01-05T00:00:00Z', WC_WRITES_LIVE_FROM: '2027-01-11T00:00:00Z' }
  const stockDrift = async () => (await d.evidence.readStepEvidence({ db: d.db as never, now, env, probe: async () => ({ ok: false, reason: 'unreachable', message: '' }), foreignOrders: async () => ({ foreign: 0 }) })).STOCK_DRIFT
  await d.db.wcStockDriftRun.createMany({ data: [{ startedAt: new Date('2027-01-10T01:00:00Z'), ok: true }, { startedAt: new Date('2027-01-11T23:00:00Z'), ok: true }] })
  const first = await d.db.wcStockDriftEvent.create({ data: { externalProductId: '11', fromQuantity: 5, toQuantity: 4, previousObservedAt: new Date('2027-01-11T00:00:00Z'), observedAt: new Date('2027-01-11T12:00:00Z') } })
  const second = await d.db.wcStockDriftEvent.create({ data: { externalProductId: '12', fromQuantity: 5, toQuantity: 3, previousObservedAt: new Date('2027-01-11T00:00:00Z'), observedAt: new Date('2027-01-11T13:00:00Z') } })
  assert.deepEqual(await stockDrift(), { state: 'counted', counted: 2, floor: '2027-01-10T00:00:00.000Z' })
  assert.deepEqual(await ack.acknowledgeStockDriftEvents(d.db as never, { ids: [first.id], by: 'jan', note: '' }), { ok: false, error: 'Say why the event(s) are explained (--note): an acknowledgement needs a reason.' })
  assert.deepEqual(await stockDrift(), { state: 'counted', counted: 2, floor: '2027-01-10T00:00:00.000Z' }, 'no reason, nothing acknowledged')
  assert.deepEqual(await ack.acknowledgeStockDriftEvents(d.db as never, { ids: [first.id], by: 'jan', note: 'manual price-list edit in WooCommerce, checked with the buyer' }), { ok: true, acknowledged: 1 })
  assert.deepEqual(await stockDrift(), { state: 'counted', counted: 1, floor: '2027-01-10T00:00:00.000Z' }, 'only the unacknowledged event still counts')
  const row = await d.db.wcStockDriftEvent.findUniqueOrThrow({ where: { id: first.id } })
  assert.deepEqual([row.acknowledgedBy, row.acknowledgedNote, row.acknowledgedAt !== null], ['jan', 'manual price-list edit in WooCommerce, checked with the buyer', true])
  assert.equal(await d.db.activityLog.count({ where: { action: 'wc_stock_drift_acknowledged' } }), 1, 'the audit entry')
  assert.equal((await ack.acknowledgeStockDriftEvents(d.db as never, { ids: [first.id], by: 'jan', note: 'again' })).ok, false, 'already acknowledged: not acknowledged twice')
  assert.equal((await d.db.wcStockDriftEvent.findUniqueOrThrow({ where: { id: second.id } })).acknowledgedAt, null)
})
