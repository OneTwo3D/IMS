import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * MERGE CANDIDATES ON A REAL DATABASE (flag mode). Synthetic orders; Mintsoft and WooCommerce are never contacted (the connector environment
 * is an injected double; the detection reads only IMS tables).
 *
 *   arm 1  two NEW orders of one customer are found, ONE task is raised (and one activity entry per member), and a second run raises nothing
 *   arm 2  when an order leaves NEW the open task is resolved by the system; when it is NEW again the same task is re-opened
 *   arm 3  a task a person marked Done is not re-opened
 *   arm 4  ten concurrent runs raise exactly one task
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

async function world() {
  loadEnv()
  const [{ db }, mc] = await Promise.all([import('@/lib/db'), import('@/lib/domain/wms/merge-candidates')])
  const port = { ...mc.prismaMergeCandidatePort, readMode: async () => 'flag' as const, environment: async () => ({ connectorId: 'mintsoft', connectorLabel: 'Mintsoft', tenantScoped: true }) }
  return { db, mc, port }
}
type World = Awaited<ReturnType<typeof world>>

async function newOrder(w: World, email: string, tag: string) {
  const id = `mc${tag}${randomUUID().slice(0, 6)}`
  const address = { address1: '1 Test Street', city: 'Testville', postcode: 'AB1 2CD', country: 'GB' }
  await w.db.salesOrder.create({
    data: {
      id, orderNumber: `IMSTEST-${id}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      customerEmail: email, billingAddress: { ...address, email }, shippingAddress: address,
      wmsOrderPush: { create: { connector: 'mintsoft', state: 'SYNCED', externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}` } },
      wmsOrderStatus: { create: { connector: 'mintsoft', connectorLabel: 'Mintsoft', externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}`, status: 'NEW', statusLabel: 'New' } },
    },
  })
  return id
}

test('detection on a real database: one task per group, resolved when the group stops qualifying, re-opened, done-by-person left alone', SKIP, async (t) => {
  const w = await world()
  const email = `mc-${randomUUID().slice(0, 8)}@example.test`
  const a = await newOrder(w, email, 'a')
  const b = await newOrder(w, email, 'b')
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [a, b] } } }) })
  const mine = (r: Awaited<ReturnType<typeof w.mc.runMergeCandidateDetection>>) => r.groups.filter((g) => g.members.some((m) => m.orderId === a))

  const first = await w.mc.runMergeCandidateDetection(w.port)
  assert.equal(mine(first).length, 1)
  const tasks = () => w.db.wmsOperatorTask.findMany({ where: { reason: 'MERGE_CANDIDATE', orderId: { in: [a, b] } } })
  assert.equal((await tasks()).length, 1)
  assert.match((await tasks())[0].queryText, /merge them there if appropriate/)
  const logs = () => w.db.activityLog.count({ where: { action: 'wms_merge_candidate_flagged', entityId: { in: [a, b] } } })
  assert.equal(await logs(), 2)
  await w.mc.runMergeCandidateDetection(w.port)
  assert.equal((await tasks()).length, 1)
  assert.equal(await logs(), 2, 'no second entry for the same group')

  await w.db.wmsOrderStatusSnapshot.update({ where: { orderId: b }, data: { status: 'PICKING' } })
  await w.mc.runMergeCandidateDetection(w.port)
  const resolved = (await tasks())[0]
  assert.equal(resolved.status, 'DONE')
  assert.equal(resolved.doneBy, w.mc.MERGE_TASK_SYSTEM_ACTOR)

  await w.db.wmsOrderStatusSnapshot.update({ where: { orderId: b }, data: { status: 'NEW' } })
  await w.mc.runMergeCandidateDetection(w.port)
  assert.equal((await tasks()).length, 1)
  assert.equal((await tasks())[0].status, 'OPEN', 're-opened')

  await w.db.wmsOperatorTask.updateMany({ where: { orderId: { in: [a, b] } }, data: { status: 'DONE', doneBy: 'a-person' } })
  await w.mc.runMergeCandidateDetection(w.port)
  assert.equal((await tasks())[0].status, 'DONE', 'a person closed it: it stays closed')
})

test('ten concurrent runs raise exactly one task', SKIP, async (t) => {
  const w = await world()
  const email = `mc-${randomUUID().slice(0, 8)}@example.test`
  const a = await newOrder(w, email, 'c')
  const b = await newOrder(w, email, 'd')
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [a, b] } } }) })
  await Promise.all(Array.from({ length: 10 }, () => w.mc.runMergeCandidateDetection(w.port)))
  assert.equal(await w.db.wmsOperatorTask.count({ where: { reason: 'MERGE_CANDIDATE', orderId: { in: [a, b] } } }), 1)
})
