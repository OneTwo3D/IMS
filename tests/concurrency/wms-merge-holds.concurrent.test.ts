import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * MERGE HOLDS ON A REAL DATABASE. Synthetic orders. Mintsoft and WooCommerce are NEVER contacted: the warehouse request is an injected double
 * (`requestHold`), everything else is IMS tables.
 *
 *   arm 1  both orders are held (rows HELD, ONE task, activity), flag OFF writes nothing, a second run sends nothing
 *   arm 2  ten concurrent runs send exactly one request per order and raise one task
 *   arm 3  while held, the push sweep's amend / hold / cancel queries leave the order out; once cleared they return it
 *   arm 4  the hold clears on a snapshot read after it; the overdue reminder fires exactly once (task, activity, notification)
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

async function world(enabled = true) {
  loadEnv()
  const [{ db }, hold, holdPort, sweep] = await Promise.all([
    import('@/lib/db'), import('@/lib/domain/wms/merge-hold'), import('@/lib/domain/wms/merge-hold-port'), import('@/lib/domain/wms/order-push-sweep'),
  ])
  const requests: string[] = []
  const port = {
    ...holdPort.prismaMergeHoldPort,
    isEnabled: async () => enabled,
    requestHold: async (_env: unknown, member: { orderId: string }) => { requests.push(member.orderId); return { held: true, status: 'HELD' as const } },
  }
  const env = { connectorId: 'mintsoft', connectorLabel: 'Mintsoft' }
  return { db, hold, holdPort, sweep, port, env, requests }
}
type World = Awaited<ReturnType<typeof world>>

async function newOrder(w: World, email: string, tag: string, over: Record<string, unknown> = {}) {
  const id = `mh${tag}${randomUUID().slice(0, 6)}`
  const address = { address1: '1 Test Street', city: 'Testville', postcode: 'AB1 2CD', country: 'GB' }
  await w.db.salesOrder.create({
    data: {
      id, orderNumber: `IMSTEST-${id}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      customerEmail: email, billingAddress: { ...address, email }, shippingAddress: address,
      wmsOrderPush: { create: { connector: 'mintsoft', state: 'SYNCED', externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}`, pushedAt: new Date(Date.now() - 3_600_000) } },
      wmsOrderStatus: { create: { connector: 'mintsoft', connectorLabel: 'Mintsoft', externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}`, status: 'NEW', statusLabel: 'New' } },
      ...over,
    },
  })
  return id
}
const memberOf = (id: string) => ({ orderId: id, orderNumber: `IMSTEST-${id}`, externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}` })
const groupOf = (ids: string[]) => ({ basis: `merge-candidate:${[...ids].sort().join(',')}`, members: ids.map(memberOf), warnings: ['EU destination: check the customs declaration.'] })

test('both orders are held with rows, one task and activity; flag OFF writes nothing; a second run sends nothing', SKIP, async (t) => {
  const w = await world()
  const email = `mh-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, email, 'a'), await newOrder(w, email, 'b')]
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [a, b] } } }) })

  const off = await world(false)
  await w.hold.placeMergeHolds(off.port, off.env, [groupOf([a, b])])
  assert.equal(await w.db.wmsMergeHold.count({ where: { orderId: { in: [a, b] } } }), 0, 'flag OFF: no row')
  assert.deepEqual(off.requests, [])
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: { in: [a, b] } } }), 0, 'flag OFF: no task')

  const run = await w.hold.placeMergeHolds(w.port, w.env, [groupOf([a, b])])
  assert.equal(run.held, 2)
  const rows = await w.db.wmsMergeHold.findMany({ where: { orderId: { in: [a, b] } } })
  assert.deepEqual(rows.map((r) => r.state), ['HELD', 'HELD'])
  assert.ok(rows.every((r) => r.heldAt && r.remindedAt === null))
  const tasks = await w.db.wmsOperatorTask.findMany({ where: { orderId: { in: [a, b] }, reason: 'MERGE_HOLD' } })
  assert.equal(tasks.length, 1)
  assert.match(tasks[0].queryText, /EU destination/)
  assert.equal(await w.db.activityLog.count({ where: { action: 'wms_merge_hold_placed', entityId: { in: [a, b] } } }), 2)

  await w.hold.placeMergeHolds(w.port, w.env, [groupOf([a, b])])
  assert.equal(w.requests.length, 2, 'the second run sent nothing')
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: { in: [a, b] }, reason: 'MERGE_HOLD' } }), 1)
})

test('ten concurrent runs send exactly one hold request per order and raise one task', SKIP, async (t) => {
  const w = await world()
  const email = `mh-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, email, 'c'), await newOrder(w, email, 'd')]
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [a, b] } } }) })
  await Promise.all(Array.from({ length: 10 }, () => w.hold.placeMergeHolds(w.port, w.env, [groupOf([a, b])])))
  assert.deepEqual([...w.requests].sort(), [a, b].sort())
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: { in: [a, b] }, reason: 'MERGE_HOLD' } }), 1)
})

test('while held the amend, hold and cancel queries of the push sweep leave the order out; cleared, they return it', SKIP, async (t) => {
  const w = await world()
  const email = `mh-${randomUUID().slice(0, 8)}@example.test`
  const edit = await newOrder(w, email, 'e') // edited after its push
  const withdrawn = await newOrder(w, email, 'f', { status: 'ON_HOLD' })
  const cancelled = await newOrder(w, email, 'g', { status: 'CANCELLED' })
  const ids = [edit, withdrawn, cancelled]
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: ids } } }) })
  await w.db.salesOrder.update({ where: { id: edit }, data: { notes: 'edited' } }) // bumps updatedAt past pushedAt
  const sweepPort = w.sweep.createPrismaWmsOrderPushPort()
  const seen = async () => {
    const [u, h, c] = await Promise.all([sweepPort.updatableLinks('mintsoft', 500), sweepPort.holdableLinks('mintsoft', 500), sweepPort.cancellableLinks('mintsoft', 500)])
    return { amend: u.some((l) => l.order.id === edit), hold: h.some((l) => l.orderId === withdrawn), cancel: c.some((l) => l.orderId === cancelled) }
  }
  assert.deepEqual(await seen(), { amend: true, hold: true, cancel: true }, 'without a hold all three are due (the baseline)')

  for (const id of ids) await w.port.beginHold(w.env, memberOf(id), 'g').then((row) => w.port.recordHeld(row!, new Date()))
  assert.deepEqual(await seen(), { amend: false, hold: false, cancel: false }, 'held: nothing is pushed')

  await w.db.wmsMergeHold.updateMany({ where: { orderId: { in: ids } }, data: { state: 'CLEARED' } })
  assert.deepEqual(await seen(), { amend: true, hold: true, cancel: true }, 'cleared: due again')
})

test('the hold clears on a snapshot read after it; the overdue reminder fires exactly once', SKIP, async (t) => {
  const w = await world()
  const email = `mh-${randomUUID().slice(0, 8)}@example.test`
  const [a, b] = [await newOrder(w, email, 'h'), await newOrder(w, email, 'i')]
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id: { in: [a, b] } } }); await w.db.notification.deleteMany({ where: { message: { contains: a } } }) })
  await w.hold.placeMergeHolds(w.port, w.env, [groupOf([a, b])])
  const longAgo = new Date(Date.now() - 5 * 3_600_000)
  await w.db.wmsMergeHold.updateMany({ where: { orderId: { in: [a, b] } }, data: { heldAt: longAgo } })
  // The warehouse shows both held (read after the hold), edit on `a`.
  const fresh = new Date()
  await w.db.wmsOrderStatusSnapshot.updateMany({ where: { orderId: { in: [a, b] } }, data: { status: 'AWAITINGCONFIRMATION', fetchedAt: fresh } })
  await w.db.wmsOrderPushLink.update({ where: { orderId: b }, data: { pushedAt: new Date(Date.now() + 60_000) } }) // pushed after its last change
  await w.db.salesOrder.update({ where: { id: a }, data: { notes: 'edited while held' } })

  const mine = (rows: Awaited<ReturnType<typeof w.port.activeRows>>) => rows.filter((r) => [a, b].includes(r.row.orderId))
  const scoped = { ...w.port, activeRows: async (c: string) => mine(await w.port.activeRows(c)) }
  const first = await w.hold.runMergeHoldMaintenance(scoped, w.env, { hours: 4 })
  assert.deepEqual([first.reminded, first.cleared, first.editsBlocked], [2, 0, 1])
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: { in: [a, b] }, reason: 'MERGE_HOLD_OVERDUE' } }), 2)
  assert.equal(await w.db.activityLog.count({ where: { action: 'wms_merge_hold_overdue', entityId: { in: [a, b] } } }), 2)
  const flagged = await w.db.refusedAction.findFirst({ where: { entityId: a, gate: 'WMS_MERGE_HELD', resolvedAt: null } })
  assert.ok(flagged, 'the edit shows as "act in Mintsoft"')
  const second = await w.hold.runMergeHoldMaintenance(scoped, w.env, { hours: 4 })
  assert.equal(second.reminded, 0, 'the reminder fires once')
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: { in: [a, b] }, reason: 'MERGE_HOLD_OVERDUE' } }), 2)

  // `b` is confirmed by a person in the warehouse: the next snapshot says NEW.
  await w.db.wmsOrderStatusSnapshot.update({ where: { orderId: b }, data: { status: 'PICKING', fetchedAt: new Date(Date.now() + 1000) } })
  const third = await w.hold.runMergeHoldMaintenance(scoped, w.env, { hours: 4 })
  assert.equal(third.cleared, 1)
  assert.equal((await w.db.wmsMergeHold.findFirstOrThrow({ where: { orderId: b } })).state, 'CLEARED')
  assert.equal((await w.db.wmsMergeHold.findFirstOrThrow({ where: { orderId: a } })).state, 'HELD')
  // A withdrawal on the still-held order escalates to a person.
  await w.db.salesOrder.update({ where: { id: a }, data: { withdrawalHoldAt: new Date(), status: 'ON_HOLD' } })
  await w.hold.runMergeHoldMaintenance(scoped, w.env, { hours: 4 })
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: a, reason: 'MERGE_HOLD_WITHDRAWAL' } }), 1)
})
