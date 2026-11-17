import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * NOTFOUND AFTER REPEATED WAREHOUSE 404s, AGAINST A REAL DATABASE: the status sweep, its snapshot rows, the operator-task table and the activity log
 * are real. ONLY the warehouse connector's two reads (fetchOrderStatus, probeOrderPresence) are scripted per order reference, and they are counted,
 * so "the sweep stopped polling" is an observed absence of calls. The connector has no write method here at all: IMS must write nothing to the
 * warehouse or the storefront (the warehouse's staff do not read notes), and the arms check no outbox job, no sync-log row and no push appeared.
 *
 * Committing, with its own cleanup, so it lives in the SERIAL concurrency tier. GATED on RUN_DB_CONCURRENCY_TESTS (npm run test:concurrency).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

type Script = { fetch: 'absent' | 'found' | 'throw'; probe: 'MISSING' | 'AMBIGUOUS' | 'FOUND' | 'throw' }
const scripts = new Map<string, Script>()
const fetchCalls = new Map<string, number>()
const foundStatus = (reference: string) => ({
  externalOrderId: `W-${reference}`, externalOrderNumber: reference, status: 'NEW', statusLabel: 'New', isSplit: false, partCount: null, isMerged: false,
  mergedOrderNumbers: [] as string[], deepLinkUrl: null, tracking: [] as Array<{ trackingNumber: string; carrier: string }>,
})

if (!skip) {
  mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }), isIntegrationPluginEnabled: async () => false } })
  mock.module('@/lib/connectors/wms/types', { namedExports: { WMS_CONNECTOR_IDS: ['mintsoft'] } })
  mock.module('@/lib/connectors/wms/order-lookup', { namedExports: { resolveWmsOrderLookupConnector: async () => ({ kind: 'one', connector: 'woocommerce' }) } })
  mock.module('@/lib/connectors/wms/registry', {
    namedExports: {
      getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
      getWmsConnector: () => ({
        fetchOrderStatus: async (reference: string) => {
          fetchCalls.set(reference, (fetchCalls.get(reference) ?? 0) + 1)
          const script = scripts.get(reference)
          if (!script || script.fetch === 'found') return foundStatus(reference)
          if (script.fetch === 'throw') throw new Error('Mintsoft is unreachable')
          return null
        },
        probeOrderPresence: async (reference: string) => {
          const script = scripts.get(reference)
          if (script?.probe === 'throw') throw new Error('probe failed')
          return script?.probe ?? 'MISSING'
        },
      }),
    },
  })
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, sweep] = await Promise.all([import('../../lib/db'), import('../../lib/domain/wms/order-status-sweep')])
  return { db, sweep }
}
type Deps = Awaited<ReturnType<typeof setup>>

/** An order IMS has pushed to the warehouse (a settled push link with a warehouse id), or one it has not pushed yet. */
async function seedOrder(d: Deps, options: { pushed?: boolean } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const reference = `NF${suffix}`
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `SO-${suffix}`,
      status: 'PROCESSING',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('10'),
      totalForeign: new Prisma.Decimal('10'),
      subtotalBase: new Prisma.Decimal('10'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('10'),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${suffix}`, externalOrderNumber: reference } },
      ...(options.pushed === false ? {} : { wmsOrderPush: { create: { connector: 'mintsoft', externalOrderId: `W-${reference}`, externalOrderNumber: reference, state: 'SYNCED' } } }),
    },
    select: { id: true, orderNumber: true },
  })
  return { ...order, reference }
}

async function cleanup(d: Deps, orders: Array<{ id: string; reference: string }>) {
  const ids = orders.map((order) => order.id)
  await d.db.wmsOperatorTask.deleteMany({ where: { orderId: { in: ids } } })
  await d.db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
  await d.db.wmsOrderStatusSnapshot.deleteMany({ where: { orderId: { in: ids } } })
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: ids } } })
  await d.db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
  await d.db.salesOrder.deleteMany({ where: { id: { in: ids } } })
  for (const order of orders) { scripts.delete(order.reference); fetchCalls.delete(order.reference) }
}

/** One sweep that treats every snapshot as stale (the 30 minute window is not what is under test). */
const sweepOnce = (d: Deps) => d.sweep.runWmsOrderStatusSweep({ staleMinutes: -1 })
const snapshotOf = (d: Deps, orderId: string) => d.db.wmsOrderStatusSnapshot.findUnique({ where: { orderId } })
const tasksOf = (d: Deps, orderId: string) => d.db.wmsOperatorTask.findMany({ where: { orderId } })
const polls = (reference: string) => fetchCalls.get(reference) ?? 0

test('N CONSECUTIVE 404s mark the order NOTFOUND, stop polling it and raise ONE operator task; nothing is written to the warehouse or the storefront', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order]))
  scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })

  for (let strike = 1; strike < d.sweep.WMS_NOT_FOUND_THRESHOLD; strike++) {
    await sweepOnce(d)
    const snapshot = await snapshotOf(d, order.id)
    assert.equal(snapshot?.notFoundStrikes, strike)
    assert.notEqual(snapshot?.status, 'NOTFOUND', `not yet after ${strike} strike(s)`)
    assert.equal((await tasksOf(d, order.id)).length, 0)
  }
  await sweepOnce(d)
  const marked = await snapshotOf(d, order.id)
  assert.equal(marked?.status, 'NOTFOUND')
  assert.equal(marked?.notFoundStrikes, d.sweep.WMS_NOT_FOUND_THRESHOLD)
  assert.ok(marked?.notFoundAt instanceof Date)
  assert.equal(marked?.lastError, d.sweep.WMS_LOOKUP_CONFIRMED_ABSENT, 'the delete guard still reads it as an authoritative absence')

  const tasks = await tasksOf(d, order.id)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.reason, 'ORDER_NOT_FOUND')
  assert.equal(tasks[0]!.status, 'OPEN')
  assert.equal(tasks[0]!.externalOrderId, `W-${order.reference}`)
  assert.match(tasks[0]!.queryText, new RegExp(order.orderNumber ?? 'SO-'))
  assert.match(tasks[0]!.queryText, /IMS has changed nothing/)
  assert.equal(await d.db.activityLog.count({ where: { entityId: order.id, action: 'wms_order_not_found' } }), 1)

  // STOP POLLING: further sweeps never look the order up again, and never raise a second task.
  const pollsAtMark = polls(order.reference)
  assert.equal(pollsAtMark, d.sweep.WMS_NOT_FOUND_THRESHOLD)
  for (let i = 0; i < 3; i++) await sweepOnce(d)
  assert.equal(polls(order.reference), pollsAtMark, 'no warehouse lookup after NOTFOUND')
  assert.equal((await tasksOf(d, order.id)).length, 1)

  // No warehouse or storefront write of any kind.
  assert.equal(await d.db.integrationOutbox.count({ where: { idempotencyKey: { contains: order.id } } }), 0)
  assert.equal(await d.db.shoppingSyncLog.count({ where: { entityId: order.id } }), 0)
})

test('an intervening SUCCESSFUL lookup resets the count: the order is NOTFOUND only after N absent answers in a row', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order]))
  const script = (fetch: Script['fetch']) => scripts.set(order.reference, { fetch, probe: 'MISSING' })

  script('absent'); await sweepOnce(d); await sweepOnce(d)
  assert.equal((await snapshotOf(d, order.id))?.notFoundStrikes, 2)
  script('found'); await sweepOnce(d)
  const reset = await snapshotOf(d, order.id)
  assert.equal(reset?.notFoundStrikes, 0, 'a lookup that found the order resets the count')
  assert.equal(reset?.status, 'NEW')
  script('absent'); await sweepOnce(d); await sweepOnce(d)
  const stillPolled = await snapshotOf(d, order.id)
  assert.equal(stillPolled?.notFoundStrikes, 2)
  assert.notEqual(stillPolled?.status, 'NOTFOUND', 'two strikes after the reset is not N')
  assert.equal((await tasksOf(d, order.id)).length, 0)
  await sweepOnce(d)
  assert.equal((await snapshotOf(d, order.id))?.status, 'NOTFOUND')
  assert.equal((await tasksOf(d, order.id)).length, 1)
})

test('a lookup that FAILED proves nothing: it neither counts nor resets, and an outage is never read as "the order is gone"', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order]))
  scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })
  await sweepOnce(d); await sweepOnce(d)
  // Mintsoft is down for a long time: many failed lookups, no strike.
  scripts.set(order.reference, { fetch: 'throw', probe: 'MISSING' })
  for (let i = 0; i < 5; i++) await sweepOnce(d)
  const held = await snapshotOf(d, order.id)
  assert.equal(held?.notFoundStrikes, 2, 'neither counted nor reset')
  assert.notEqual(held?.status, 'NOTFOUND')
  // A probe that could not answer is the same.
  scripts.set(order.reference, { fetch: 'absent', probe: 'throw' })
  await sweepOnce(d)
  assert.equal((await snapshotOf(d, order.id))?.notFoundStrikes, 2)
  assert.equal((await tasksOf(d, order.id)).length, 0)
  // And the next genuine absence is the Nth.
  scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })
  await sweepOnce(d)
  assert.equal((await snapshotOf(d, order.id))?.status, 'NOTFOUND')
})

test('an AMBIGUOUS or PRESENT answer (merged or split) means the order is there: it resets the count', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order]))
  for (const probe of ['AMBIGUOUS', 'FOUND'] as const) {
    scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })
    await sweepOnce(d); await sweepOnce(d)
    assert.equal((await snapshotOf(d, order.id))?.notFoundStrikes, 2)
    scripts.set(order.reference, { fetch: 'absent', probe })
    await sweepOnce(d)
    const after = await snapshotOf(d, order.id)
    assert.equal(after?.notFoundStrikes, 0, `${probe} resets`)
    assert.notEqual(after?.status, 'NOTFOUND')
  }
  assert.equal((await tasksOf(d, order.id)).length, 0)
})

test('an order IMS has NOT pushed is expected to be absent: it is never marked NOTFOUND however often it is looked up', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d, { pushed: false })
  t.after(() => cleanup(d, [order]))
  scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })
  for (let i = 0; i < d.sweep.WMS_NOT_FOUND_THRESHOLD + 2; i++) await sweepOnce(d)
  const snapshot = await snapshotOf(d, order.id)
  assert.notEqual(snapshot?.status, 'NOTFOUND')
  assert.equal(snapshot?.notFoundStrikes, 0)
  assert.equal((await tasksOf(d, order.id)).length, 0)
  assert.equal(polls(order.reference), d.sweep.WMS_NOT_FOUND_THRESHOLD + 2, 'still polled: it may be pushed later')
})

test('the operator task is created ONCE: a second mark of the same order (a reset snapshot) raises neither a second task nor a second log row', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order]))
  scripts.set(order.reference, { fetch: 'absent', probe: 'MISSING' })
  for (let i = 0; i < d.sweep.WMS_NOT_FOUND_THRESHOLD; i++) await sweepOnce(d)
  assert.equal((await tasksOf(d, order.id)).length, 1)
  // Something puts the order back in the polled set at the edge of the threshold (a person re-opened it): the same fact is the same task.
  await d.db.wmsOrderStatusSnapshot.update({ where: { orderId: order.id }, data: { status: '', notFoundStrikes: d.sweep.WMS_NOT_FOUND_THRESHOLD - 1 } })
  await sweepOnce(d)
  assert.equal((await snapshotOf(d, order.id))?.status, 'NOTFOUND')
  assert.equal((await tasksOf(d, order.id)).length, 1, 'deduplicated on the warehouse order')
  assert.equal(await d.db.activityLog.count({ where: { entityId: order.id, action: 'wms_order_not_found' } }), 1)
})
