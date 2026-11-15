import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * WMS OPERATOR QUERY TASKS ON A REAL DATABASE (IMS writes no warehouse comment; a task is how the warehouse is told).
 *
 *   arm 1  the table dedupes on (connector, order, warehouse order, reason, content hash): the same fact raised twice, or by ten writers at once, is one
 *          row; the same fact after it was DONE stays done (not re-opened); a new episode (a different basis) is a new task
 *   arm 2  tasks go with their order (cascade), so the transaction reset and an order delete leave none
 *   arm 3  Done on an ordinary task flips OPEN to DONE once (compare-and-set) with who and when, and writes the audit entry in the same transaction
 *   arm 4  Done on a PARTIAL-REMOVAL CHECK re-reads the order and REFUSES while any recorded line is still there (nothing changes); when every line is
 *          gone, ONE transaction marks it done, closes the link CANCELLED (guarded on the link's state and warehouse order) and drops the obligation row
 *   arm 5  a link that moved on (re-pointed) is not closed by Done; the task is still done and the answer says so; a read that fails changes nothing
 *   arm 6  the tasks carry no personal data
 *
 * MINTSOFT IS LIVE AND IS NEVER CONTACTED: the lines read is an injected double.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

async function world() {
  loadEnv()
  const [{ db }, tasks, done, ob] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/domain/wms/operator-tasks'),
    import('@/lib/domain/wms/operator-task-done'),
    import('@/lib/domain/wms/removal-note-obligation'),
  ])
  return { db, tasks, done, ob }
}
type World = Awaited<ReturnType<typeof world>>

async function order(w: World, tag: string) {
  const id = `${tag}${randomUUID().slice(0, 6)}`
  await w.db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
  return id
}
async function user(w: World) {
  const email = `wmsq-${randomUUID().slice(0, 8)}@example.test`
  return (await w.db.user.create({ data: { email, name: 'Task fixture', role: 'ADMIN', active: true, passwordHash: 'x' }, select: { id: true } })).id
}
const base = (orderId: string) => ({ connector: 'mintsoft', orderId, externalOrderId: 'surv-1', reason: 'MERGED_LINES_REMOVED' as const, queryText: 'raise a query' })

test('the table dedupes: twice is one, ten at once is one, done stays done, a new episode is a new task', SKIP, async (t) => {
  const w = await world()
  const id = await order(w, 'dd')
  t.after(async () => { await w.db.salesOrder.deleteMany({ where: { id } }) })
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), dedupeBasis: 'lines-removed:1,2' }), true)
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), queryText: 'different words, same fact', dedupeBasis: 'lines-removed:1,2' }), false, 'same fact, other wording: not a second task')
  const results = await Promise.all(Array.from({ length: 10 }, () => w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), reason: 'COURIER_FALLBACK', dedupeBasis: 'courier-fallback' })))
  assert.equal(results.filter(Boolean).length, 1, 'ten concurrent writers: exactly one wins, none throws')
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: id } }), 2)
  await w.db.wmsOperatorTask.updateMany({ where: { orderId: id }, data: { status: 'DONE', doneAt: new Date() } })
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), dedupeBasis: 'lines-removed:1,2' }), false, 'a done task is not re-opened by the same fact being raised again')
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), reason: 'PUSH_CONFLICT', dedupeBasis: 'notice:HOLD:2026-11-15T00:00:00.000Z' }), true)
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), reason: 'PUSH_CONFLICT', dedupeBasis: 'notice:HOLD:2026-11-16T00:00:00.000Z' }), true, 'a later episode of the notice is a new task')
  assert.equal(await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), externalOrderId: 'surv-2', dedupeBasis: 'lines-removed:1,2' }), true, 'another warehouse order is another task')
})

test('tasks go with their order: deleting the order (the reset) leaves none', SKIP, async () => {
  const w = await world()
  const id = await order(w, 'cs')
  await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), dedupeBasis: 'x' })
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: id } }), 1)
  await w.db.salesOrder.deleteMany({ where: { id } })
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: id } }), 0, 'the foreign key cascades')
})

test('Done on an ordinary task: OPEN to DONE once, with who and when, and an audit entry; a second Done is refused', SKIP, async (t) => {
  const w = await world()
  const id = await order(w, 'dn')
  const userId = await user(w)
  t.after(async () => { await w.db.activityLog.deleteMany({ where: { entityId: id } }); await w.db.salesOrder.deleteMany({ where: { id } }); await w.db.user.deleteMany({ where: { id: userId } }) })
  await w.tasks.raiseWmsOperatorTask(w.db, { ...base(id), dedupeBasis: 'a' })
  const task = await w.db.wmsOperatorTask.findFirstOrThrow({ where: { orderId: id } })
  const [first, second] = await Promise.all([w.done.completeWmsOperatorTask({ taskId: task.id, userId }), w.done.completeWmsOperatorTask({ taskId: task.id, userId })])
  assert.equal([first, second].filter((r) => r.ok).length, 1, 'exactly one of two concurrent Done presses wins')
  const after = await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: task.id } })
  assert.equal(after.status, 'DONE')
  assert.equal(after.doneBy, userId)
  assert.ok(after.doneAt)
  const audit = await w.db.activityLog.findMany({ where: { entityId: id, action: 'wms_operator_task_done' } })
  assert.equal(audit.length, 1, 'one audit entry, who and when')
  assert.equal(audit[0]!.userId, userId)
})

async function partialFixture(w: World, tag: string) {
  const id = await order(w, tag)
  const link = await w.db.wmsOrderPushLink.create({ data: { orderId: id, connector: 'mintsoft', state: 'MERGED', externalOrderId: 'surv-p', externalOrderNumber: 'MS-A+MS-B' } })
  const items = [{ externalItemId: '11', sku: 'A', quantity: 2 }, { externalItemId: '12', sku: 'B', quantity: 1 }]
  const key = w.ob.removalNoteKey('mintsoft', link.id, 'surv-p')
  await w.db.setting.create({ data: { key, value: w.ob.serializeRemovalNote({ id: 'ob1', linkId: link.id, orderId: id, externalOrderId: 'surv-p', state: 'needs_check', detail: 'partial', taskRaised: true, items }) } })
  await w.tasks.raiseWmsOperatorTask(w.db, {
    connector: 'mintsoft', orderId: id, externalOrderId: 'surv-p', reason: 'PARTIAL_REMOVAL_CHECK', queryText: 'take them out', dedupeBasis: 'lines-partial:11,12',
    payload: { orderNumber: `IMSTEST-${id}`, linkId: link.id, items },
  })
  const task = await w.db.wmsOperatorTask.findFirstOrThrow({ where: { orderId: id } })
  return { id, link, key, task, items }
}
const present = (ids: string[]) => async () => ids.map((externalItemId) => ({ externalItemId, sku: 'X', quantity: 1 }))

test('Done on a partial-removal check: refused while ANY recorded line is still on the order (nothing changes); when all are gone ONE transaction closes the link, drops the obligation and marks it done', SKIP, async (t) => {
  const w = await world()
  const f = await partialFixture(w, 'pc')
  const userId = await user(w)
  t.after(async () => { await w.db.activityLog.deleteMany({ where: { entityId: f.id } }); await w.db.setting.deleteMany({ where: { key: f.key } }); await w.db.salesOrder.deleteMany({ where: { id: f.id } }); await w.db.user.deleteMany({ where: { id: userId } }) })

  const refused = await w.done.completeWmsOperatorTask({ taskId: f.task.id, userId, readLines: present(['12', '999']) })
  assert.equal(refused.ok, false)
  assert.match((refused as { error: string }).error, /1 of the 2 recorded line\(s\) are still on the warehouse order \(12\)/)
  assert.equal((await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: f.task.id } })).status, 'OPEN', 'still open')
  assert.equal((await w.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: f.link.id } })).state, 'MERGED', 'link untouched')
  assert.equal(await w.db.setting.count({ where: { key: f.key } }), 1, 'obligation untouched')

  const unreadable = await w.done.completeWmsOperatorTask({ taskId: f.task.id, userId, readLines: async () => null })
  assert.equal(unreadable.ok, false)
  assert.equal((await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: f.task.id } })).status, 'OPEN', 'an unreadable order changes nothing')

  const ok = await w.done.completeWmsOperatorTask({ taskId: f.task.id, userId, readLines: present(['900']) })
  assert.equal(ok.ok, true)
  const link = await w.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: f.link.id } })
  assert.equal(link.state, 'CANCELLED')
  assert.ok(link.cancelledAt)
  assert.equal(link.lastError, null)
  assert.equal(await w.db.setting.count({ where: { key: f.key } }), 0, 'the obligation is dropped')
  const task = await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: f.task.id } })
  assert.equal(task.status, 'DONE')
  assert.equal(task.doneBy, userId)
  const audit = await w.db.activityLog.findMany({ where: { entityId: f.id, action: 'wms_operator_task_done' } })
  assert.equal(audit.length, 1)
  assert.match(audit[0]!.description, /link was closed as cancelled/)
})

test('Done on a partial-removal check whose link moved on: the link is NOT closed, the task is done, and the answer says so; a failure inside the transaction leaves ALL of it unchanged', SKIP, async (t) => {
  const w = await world()
  const f = await partialFixture(w, 'mv')
  const userId = await user(w)
  t.after(async () => { await w.db.activityLog.deleteMany({ where: { entityId: f.id } }); await w.db.setting.deleteMany({ where: { key: f.key } }); await w.db.salesOrder.deleteMany({ where: { id: f.id } }); await w.db.user.deleteMany({ where: { id: userId } }) })

  // Atomicity: an audit write that cannot succeed (no such user) rolls the task, the link and the obligation back together.
  const failed = await w.done.completeWmsOperatorTask({ taskId: f.task.id, userId: 'no-such-user', readLines: present([]) }).catch((e) => e)
  assert.ok(failed instanceof Error || (failed as { ok: boolean }).ok === false, 'the audit entry could not be written')
  assert.equal((await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: f.task.id } })).status, 'OPEN', 'task rolled back')
  assert.equal((await w.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: f.link.id } })).state, 'MERGED', 'link rolled back')
  assert.equal(await w.db.setting.count({ where: { key: f.key } }), 1, 'obligation rolled back')

  await w.db.wmsOrderPushLink.update({ where: { id: f.link.id }, data: { externalOrderId: 'other-order' } }) // the dispatch sweep re-pointed it
  const result = await w.done.completeWmsOperatorTask({ taskId: f.task.id, userId, readLines: present([]) })
  assert.equal(result.ok, true)
  assert.match((result as { notice: string }).notice, /already moved on/)
  const link = await w.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: f.link.id } })
  assert.equal(link.state, 'MERGED', 'a link that now names another warehouse order is not closed')
  assert.equal((await w.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: f.task.id } })).status, 'DONE')
})

test('the tasks hold no personal data: order numbers, SKUs, quantities and line ids only', SKIP, async (t) => {
  const w = await world()
  const f = await partialFixture(w, 'pi')
  t.after(async () => { await w.db.setting.deleteMany({ where: { key: f.key } }); await w.db.salesOrder.deleteMany({ where: { id: f.id } }) })
  await w.db.salesOrder.update({ where: { id: f.id }, data: { customerName: 'Pat Example', customerEmail: 'pat@example.com', shippingAddress: { line1: '1 Test Street', postcode: 'LS1 1AA' } } })
  const text = JSON.stringify(await w.db.wmsOperatorTask.findMany({ where: { orderId: f.id } }))
  assert.doesNotMatch(text, /Pat Example|pat@example|Test Street|LS1 1AA/)
  assert.deepEqual(Object.keys(f.task.payload as object).sort(), ['items', 'linkId', 'orderNumber'])
})
