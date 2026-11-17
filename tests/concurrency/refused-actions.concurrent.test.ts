import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * REFUSED OR STALLED ACTIONS ON A REAL DATABASE. Synthetic orders and entity ids; nothing here reaches a warehouse or a store.
 *
 *   arm 1  the migration made the table, its unique key, the enums and the new operator-task reason
 *   arm 2  the upsert is idempotent: repeat refusals bump lastSeenAt/attempts, never a second row, and never move firstSeenAt
 *   arm 3  twenty concurrent refusals of one (entity, action, gate) make exactly one row with attempts = 20
 *   arm 4  resolution closes it; the same refusal again starts a NEW episode on the same row (firstSeenAt restarts, alert clears)
 *   arm 5  the age-based alert fires once per episode, even from concurrent escalation passes
 *   arm 6  an order that no longer needs the action closes its refusals
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

async function world() {
  loadEnv()
  const [{ db }, ra, wd] = await Promise.all([import('@/lib/db'), import('@/lib/domain/refused-actions'), import('@/lib/domain/wms/watchdog-sweep')])
  return { db, ra, notifyActiveAdmins: wd.notifyActiveAdmins }
}

const base = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityType: 'SALES_ORDER', entityId, action: 'WMS_ORDER_AMEND' as const, gate: 'WMS_ORDER_NOT_NEW', permanence: 'PERMANENT' as const, severity: 'HIGH' as const,
  intent: { orderNumber: 'SO-X', lines: [{ sku: 'A', quantity: 3 }] }, detail: 'past NEW', ...over,
})

test('migration: the table, its unique key, the enums and the new operator-task reason exist', SKIP, async () => {
  const w = await world()
  const cols = await w.db.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'refused_actions'`
  for (const c of ['entity_type', 'entity_id', 'action', 'gate', 'permanence', 'severity', 'intent', 'detail', 'attempts', 'first_seen_at', 'last_seen_at', 'resolved_at', 'resolution', 'alerted_at']) {
    assert.ok(cols.some((x) => x.column_name === c), `column ${c}`)
  }
  const idx = await w.db.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'refused_actions'`
  assert.ok(idx.some((i) => i.indexname === 'refused_actions_key'))
  const reasons = await w.db.$queryRaw<Array<{ enumlabel: string }>>`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'WmsOperatorTaskReason'`
  assert.ok(reasons.some((r) => r.enumlabel === 'AMENDMENT_NOT_APPLIED'))
})

test('upsert: idempotent on (entity, action, gate); firstSeenAt never moves, lastSeenAt only forward, severity and intent are the latest', SKIP, async (t) => {
  const w = await world()
  const id = `ra-${randomUUID()}`
  t.after(async () => { await w.db.refusedAction.deleteMany({ where: { entityId: id } }) })
  const t0 = new Date('2026-11-01T10:00:00Z')
  const first = await w.ra.recordRefusedAction(w.db, { ...base(id), now: t0 })
  assert.equal(first.episodeStarted, true)
  const again = await w.ra.recordRefusedAction(w.db, { ...base(id, { severity: 'LOW', intent: { orderNumber: 'SO-X', lines: [{ sku: 'A', quantity: 4 }] } }), now: new Date('2026-11-02T10:00:00Z') })
  assert.equal(again.episodeStarted, false)
  assert.equal(again.id, first.id)
  const stale = await w.ra.recordRefusedAction(w.db, { ...base(id), now: new Date('2026-10-01T00:00:00Z') })
  assert.equal(stale.id, first.id)
  const rows = await w.db.refusedAction.findMany({ where: { entityId: id } })
  assert.equal(rows.length, 1, 'never a duplicate')
  assert.equal(rows[0]!.attempts, 3)
  assert.equal(rows[0]!.firstSeenAt.toISOString(), t0.toISOString())
  assert.equal(rows[0]!.lastSeenAt.toISOString(), '2026-11-02T10:00:00.000Z', 'lastSeenAt never moves back')
  // a different gate or action is a different record
  await w.ra.recordRefusedAction(w.db, { ...base(id, { gate: 'WMS_ORDER_NOT_AMENDABLE' }) })
  assert.equal(await w.db.refusedAction.count({ where: { entityId: id } }), 2)
})

test('upsert under concurrency: twenty simultaneous refusals make one row and count all twenty', SKIP, async (t) => {
  const w = await world()
  const id = `ra-${randomUUID()}`
  t.after(async () => { await w.db.refusedAction.deleteMany({ where: { entityId: id } }) })
  const results = await Promise.all(Array.from({ length: 20 }, () => w.ra.recordRefusedAction(w.db, base(id))))
  assert.equal(new Set(results.map((r) => r.id)).size, 1)
  assert.equal(results.filter((r) => r.episodeStarted).length, 1, 'exactly one writer began the episode')
  const rows = await w.db.refusedAction.findMany({ where: { entityId: id } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.attempts, 20)
})

test('resolution closes the row; a later refusal starts a new episode on the same row and the alert can fire again', SKIP, async (t) => {
  const w = await world()
  const id = `ra-${randomUUID()}`
  t.after(async () => { await w.db.refusedAction.deleteMany({ where: { entityId: id } }) })
  await w.ra.recordRefusedAction(w.db, { ...base(id), now: new Date('2026-11-01T00:00:00Z') })
  await w.db.refusedAction.updateMany({ where: { entityId: id }, data: { alertedAt: new Date('2026-11-01T05:00:00Z') } })
  assert.equal(await w.ra.resolveRefusedActions(w.db, { entityType: 'SALES_ORDER', entityId: id, action: 'WMS_ORDER_AMEND' }, 'ACTION_SUCCEEDED'), 1)
  assert.equal(await w.ra.resolveRefusedActions(w.db, { entityType: 'SALES_ORDER', entityId: id, action: 'WMS_ORDER_AMEND' }, 'ACTION_SUCCEEDED'), 0, 'already closed')
  const closed = await w.db.refusedAction.findFirstOrThrow({ where: { entityId: id } })
  assert.ok(closed.resolvedAt)
  assert.equal(closed.resolution, 'ACTION_SUCCEEDED')
  const next = await w.ra.recordRefusedAction(w.db, { ...base(id), now: new Date('2026-11-10T00:00:00Z') })
  assert.equal(next.episodeStarted, true)
  const reopened = await w.db.refusedAction.findFirstOrThrow({ where: { entityId: id } })
  assert.equal(reopened.id, closed.id, 'the same row')
  assert.equal(reopened.resolvedAt, null)
  assert.equal(reopened.alertedAt, null)
  assert.equal(reopened.attempts, 1)
  assert.equal(reopened.firstSeenAt.toISOString(), '2026-11-10T00:00:00.000Z')
})

test('escalation: a stale HIGH refusal alerts once per episode even from concurrent passes; young, LOW and resolved rows never do', SKIP, async (t) => {
  const w = await world()
  const admin = await w.db.user.create({ data: { email: `ra-${randomUUID()}@example.test`, name: 'RA admin', role: 'ADMIN', active: true, passwordHash: 'x' } })
  const ids = { old: `ra-${randomUUID()}`, young: `ra-${randomUUID()}`, low: `ra-${randomUUID()}`, done: `ra-${randomUUID()}` }
  t.after(async () => {
    await w.db.refusedAction.deleteMany({ where: { entityId: { in: Object.values(ids) } } })
    await w.db.notification.deleteMany({ where: { userId: admin.id } })
    await w.db.user.delete({ where: { id: admin.id } })
  })
  const now = new Date('2026-11-17T12:00:00Z')
  await w.ra.recordRefusedAction(w.db, { ...base(ids.old), now: new Date('2026-11-17T06:00:00Z') })
  await w.ra.recordRefusedAction(w.db, { ...base(ids.young), now: new Date('2026-11-17T11:30:00Z') })
  await w.ra.recordRefusedAction(w.db, { ...base(ids.low, { severity: 'LOW' }), now: new Date('2026-10-01T00:00:00Z') })
  await w.ra.recordRefusedAction(w.db, { ...base(ids.done), now: new Date('2026-11-01T00:00:00Z') })
  await w.ra.resolveRefusedActions(w.db, { entityType: 'SALES_ORDER', entityId: ids.done }, 'NO_LONGER_NEEDED')
  const pass = () => w.ra.escalateAgedRefusedActions(w.db as never, w.notifyActiveAdmins as never, now)
  const results = await Promise.all([pass(), pass(), pass(), pass()])
  const mine = (await w.db.refusedAction.findMany({ where: { entityId: { in: Object.values(ids) } } })).filter((r) => r.alertedAt)
  assert.deepEqual(mine.map((r) => r.entityId), [ids.old], 'only the stale serious one was alerted')
  const notes = await w.db.notification.findMany({ where: { userId: admin.id, title: 'Order change not applied in the warehouse' } })
  assert.equal(notes.length, 1, 'ONE alert for the admin however many passes ran')
  assert.ok(results.reduce((n, r) => n + r.alerts, 0) >= 1)
  assert.equal((await pass()).alerts, 0, 'a later pass alerts nothing more')
})

test('obsolete: refusals of an order that was cancelled or deleted are closed; one still in flight stays open', SKIP, async (t) => {
  const w = await world()
  const live = `ra-${randomUUID()}`, cancelled = `ra-${randomUUID()}`, gone = `ra-${randomUUID()}`
  const mk = (id: string, status: 'PROCESSING' | 'CANCELLED') => w.db.salesOrder.create({
    data: { id, orderNumber: `IMSTEST-${id}`, status, currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, customerEmail: 'x@example.test', billingAddress: {}, shippingAddress: {} },
  })
  await mk(live, 'PROCESSING'); await mk(cancelled, 'CANCELLED')
  t.after(async () => {
    await w.db.refusedAction.deleteMany({ where: { entityId: { in: [live, cancelled, gone] } } })
    await w.db.salesOrder.deleteMany({ where: { id: { in: [live, cancelled] } } })
  })
  for (const id of [live, cancelled, gone]) await w.ra.recordRefusedAction(w.db, base(id))
  await w.ra.resolveObsoleteRefusedActions(w.db)
  const open = (await w.db.refusedAction.findMany({ where: { entityId: { in: [live, cancelled, gone] }, resolvedAt: null } })).map((r) => r.entityId)
  assert.deepEqual(open, [live])
})

test('marking the AMENDMENT_NOT_APPLIED task Done leaves the refusal OPEN; a terminal order then closes it', SKIP, async (t) => {
  const w = await world()
  const done = await import('@/lib/domain/wms/operator-task-done')
  const id = `ra-${randomUUID()}`
  const user = await w.db.user.create({ data: { email: `ra-${randomUUID()}@example.test`, name: 'RA done', role: 'ADMIN', active: true, passwordHash: 'x' } })
  await w.db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, customerEmail: 'x@example.test', billingAddress: {}, shippingAddress: {} } })
  t.after(async () => {
    await w.db.refusedAction.deleteMany({ where: { entityId: id } })
    await w.db.activityLog.deleteMany({ where: { userId: user.id } })
    await w.db.salesOrder.deleteMany({ where: { id } })
    await w.db.user.delete({ where: { id: user.id } })
  })
  await w.ra.recordRefusedAction(w.db, base(id))
  const task = await w.db.wmsOperatorTask.create({ data: { connector: 'mintsoft', orderId: id, externalOrderId: `w-${id}`, reason: 'AMENDMENT_NOT_APPLIED', queryText: 'q', contentHash: id } })
  const result = await done.completeWmsOperatorTask({ taskId: task.id, userId: user.id })
  assert.equal(result.ok, true)
  const open = () => w.db.refusedAction.count({ where: { entityId: id, resolvedAt: null } })
  assert.equal(await open(), 1, 'Done says the query was raised, not that the warehouse applied it')
  await w.ra.resolveObsoleteRefusedActions(w.db)
  assert.equal(await open(), 1, 'the order is still in flight')
  await w.db.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
  await w.ra.resolveObsoleteRefusedActions(w.db)
  assert.equal(await open(), 0, 'a terminal order closes it')
})

test('verification rotation: 25 open serious refusals over sweeps of 10 are ALL tried within 3 sweeps, and a new refusal within 3 more', SKIP, async (t) => {
  const w = await world()
  const sweep = await import('@/lib/domain/wms/order-push-sweep')
  const port = sweep.createPrismaWmsOrderPushPort()
  const connector = `rot${randomUUID().slice(0, 6)}`
  const ids: string[] = []
  const mk = async (n: number) => {
    const id = `rot-${randomUUID()}`
    ids.push(id)
    await w.db.salesOrder.create({
      data: { id, orderNumber: `IMSTEST-${id}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, customerEmail: 'x@example.test', billingAddress: {}, shippingAddress: {},
        wmsOrderPush: { create: { connector, state: 'SYNCED', externalOrderId: `w-${id}`, externalOrderNumber: `W-${id}` } } },
    })
    await w.ra.recordRefusedAction(w.db, base(id, { intent: { orderNumber: `SO-${n}`, lines: [{ sku: 'A', quantity: 3 }] }, now: new Date(Date.UTC(2026, 10, 1, 0, n)) }))
    return id
  }
  t.after(async () => {
    await w.db.refusedAction.deleteMany({ where: { entityId: { in: ids } } })
    await w.db.salesOrder.deleteMany({ where: { id: { in: ids } } })
  })
  for (let n = 0; n < 25; n += 1) await mk(n)
  const seen = new Set<string>()
  // Every one of these stays open (a persistent mismatch): they are never resolved here.
  for (let sweepNo = 1; sweepNo <= 3; sweepNo += 1) {
    const batch = await port.openAmendmentRefusals!(connector, 10)
    assert.ok(batch.length <= 10)
    for (const row of batch) seen.add(row.orderId)
    if (sweepNo === 1) assert.equal(batch.length, 10)
  }
  assert.equal(seen.size, 25, 'every open row was tried within 3 sweeps of 10')
  // A NEW refusal, arriving after the old rows were tried, is picked first (never tried) rather than starved behind them.
  const fresh = await mk(99)
  const next = await port.openAmendmentRefusals!(connector, 10)
  assert.ok(next.some((row) => row.orderId === fresh), 'the new refusal is checked in the very next sweep')
})
