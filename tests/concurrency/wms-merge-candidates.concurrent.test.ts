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

test('overlapping runs whose view of the groups differs: the second skips, and the final state is exactly the groups that qualify now', SKIP, async (t) => {
  const w = await world()
  const e1 = `mc-${randomUUID().slice(0, 8)}@example.test`
  const e2 = `mc-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, e1, 'e'), await newOrder(w, e1, 'f')]
  const [c, d] = [await newOrder(w, e2, 'g'), await newOrder(w, e2, 'h')]
  const mine = new Set([a, b, c, d])
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [...mine] } } }) })
  const scoped = { ...w.port, loadOrders: async (ids?: readonly string[]) => (await w.port.loadOrders(ids)).filter((o) => mine.has(o.orderId)) }
  const open = () => w.db.wmsOperatorTask.findMany({ where: { reason: 'MERGE_CANDIDATE', status: 'OPEN', orderId: { in: [...mine] } }, select: { orderId: true } })

  // Run A reads both groups, then stalls while holding the pass lock.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let loaded!: () => void
  const hasLoaded = new Promise<void>((resolve) => { loaded = resolve })
  const slow = { ...scoped, loadOrders: async (ids?: readonly string[]) => { const view = await scoped.loadOrders(ids); loaded(); await gate; return view } }
  const runA = w.mc.runMergeCandidateDetection(slow)
  await hasLoaded

  // Membership changes while A is mid-pass: the second group stops qualifying.
  await w.db.wmsOrderStatusSnapshot.update({ where: { orderId: d }, data: { status: 'PICKING' } })

  // Run B overlaps A: it cannot take the lock, so it skips instead of resolving anything.
  const runB = await w.mc.runMergeCandidateDetection(scoped)
  assert.equal('skipped' in runB, true, 'the overlapping run skips')
  assert.equal((await open()).length, 0, 'the skipped run wrote nothing')

  release()
  await runA // A acts on its stale view of c+d, but re-reads the members under their locks first: only a+b is raised, and the owed marker B left makes A rerun once.
  assert.equal((await open()).length, 1)
  assert.equal(await w.db.wmsOperatorTask.count({ where: { reason: 'MERGE_CANDIDATE', orderId: { in: [c, d] } } }), 0, 'no task for the stale group')

  // The next pass agrees: only a+b qualifies.
  await w.mc.runMergeCandidateDetection(scoped)
  const finalOpen = await open()
  assert.equal(finalOpen.length, 1, 'exactly the groups that qualify now')
  assert.ok([a, b].includes(finalOpen[0].orderId))
  assert.equal(await w.db.wmsOperatorTask.count({ where: { reason: 'MERGE_CANDIDATE', orderId: { in: [c, d] } } }), 0, 'still no task for the group that no longer qualifies')
})

test('the status sweep skips while a pass holds the lock after one order moved to PICKING: no task is raised for the stale group, and the owed marker reconciles', SKIP, async (t) => {
  const w = await world()
  const email = `mc-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, email, 'i'), await newOrder(w, email, 'j')]
  const mine = new Set([a, b])
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [...mine] } } }) })
  const scoped = { ...w.port, loadOrders: async (ids?: readonly string[]) => (await w.port.loadOrders(ids)).filter((o) => mine.has(o.orderId)) }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let loaded!: () => void
  const hasLoaded = new Promise<void>((resolve) => { loaded = resolve })
  let first = true
  const slow = { ...scoped, loadOrders: async (ids?: readonly string[]) => { const view = await scoped.loadOrders(ids); if (first) { first = false; loaded(); await gate } return view } }
  const earlier = w.mc.runMergeCandidateDetection(slow) // read the group: both NEW
  await hasLoaded
  await w.db.wmsOrderStatusSnapshot.update({ where: { orderId: b }, data: { status: 'PICKING' } }) // the status sweep refreshes a snapshot ...
  const sweep = await w.mc.runMergeCandidateDetection(scoped) // ... and its detection pass cannot get the lock
  assert.equal('skipped' in sweep, true)
  assert.equal(await w.port.isOwed('mintsoft'), true, 'the skipped pass left the owed marker')
  release()
  await earlier
  assert.equal(await w.db.wmsOperatorTask.count({ where: { reason: 'MERGE_CANDIDATE', orderId: { in: [a, b] } } }), 0, 'no task claims both orders are NEW')
  assert.equal(await w.port.isOwed('mintsoft'), false, 'the holder reconciled the marker')
})

test('a marker left by a skipped pass triggers exactly one reconciliation that picks up a group formed meanwhile', SKIP, async (t) => {
  const w = await world()
  const e1 = `mc-${randomUUID().slice(0, 8)}@example.test`
  const e2 = `mc-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, e1, 'k'), await newOrder(w, e1, 'l')]
  const mine = new Set([a, b])
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [...mine] } } }) })
  let passes = 0
  const scoped = { ...w.port, loadOrders: async (ids?: readonly string[]) => (await w.port.loadOrders(ids)).filter((o) => mine.has(o.orderId)) }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let loaded!: () => void
  const hasLoaded = new Promise<void>((resolve) => { loaded = resolve })
  const counting = { ...scoped, loadOrders: async (ids?: readonly string[]) => { const view = await scoped.loadOrders(ids); if (!ids) { passes += 1; if (passes === 1) { loaded(); await gate } } return view } }
  const holder = w.mc.runMergeCandidateDetection(counting)
  await hasLoaded
  const [c, d] = [await newOrder(w, e2, 'm'), await newOrder(w, e2, 'n')]
  mine.add(c); mine.add(d)
  assert.equal('skipped' in await w.mc.runMergeCandidateDetection(scoped), true)
  release()
  await holder
  assert.equal(passes, 2, 'one pass plus exactly one reconciliation')
  assert.equal(await w.db.wmsOperatorTask.count({ where: { reason: 'MERGE_CANDIDATE', status: 'OPEN', orderId: { in: [a, b, c, d] } } }), 2, 'the group formed meanwhile is flagged without waiting for another sweep')
})
