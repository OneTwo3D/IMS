import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * THE WMS ORDER-PUSH SWEEP IS SINGLE-FLIGHT, AND A REMOVAL NOTE IS A DURABLE OBLIGATION.
 *
 *   arm 1  while one push sweep holds the connector's lock a second is SKIPPED (not queued); once it finishes a third runs
 *   arm 2  another connector is not blocked, and the dispatch sweep's lock (same hash, other namespace) does not exclude the push sweep
 *   arm 3  the lock is released even when the sweep throws
 *   arm 4  the removal-note obligation is idempotent: recording twice leaves one row (the first text), it lists until cleared, and clearing twice is true then false
 * Real Postgres, the real session advisory lock. Mutation: take the lock in the dispatch namespace -> arm 2 fails; skip the release -> arm 3 fails.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

test('the push sweep lock: a second sweep is skipped while the first holds it, and the lock is per connector and per namespace', SKIP, async () => {
  loadEnv()
  const { withOrderPushSweepLockOrSkip, withDispatchSweepLockOrSkip, DISPATCH_LOCK_SKIPPED } = await import('@/lib/domain/wms/dispatch-sweep-lock')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => { entered = resolve })

  const first = withOrderPushSweepLockOrSkip('conn-a', async () => { entered(); await gate; return 'first' })
  await inside

  assert.equal(await withOrderPushSweepLockOrSkip('conn-a', async () => 'second'), DISPATCH_LOCK_SKIPPED, 'arm 1: skipped while held')
  assert.equal(await withOrderPushSweepLockOrSkip('conn-b', async () => 'other connector'), 'other connector', 'arm 2: another connector is not blocked')
  assert.equal(await withDispatchSweepLockOrSkip('conn-a', async () => 'dispatch'), 'dispatch', 'arm 2: the dispatch sweep lock is a different namespace')

  release()
  assert.equal(await first, 'first')
  assert.equal(await withOrderPushSweepLockOrSkip('conn-a', async () => 'third'), 'third', 'arm 1: runs again once released')
})

test('the push sweep lock is released when the sweep throws', SKIP, async () => {
  loadEnv()
  const { withOrderPushSweepLockOrSkip } = await import('@/lib/domain/wms/dispatch-sweep-lock')
  await assert.rejects(withOrderPushSweepLockOrSkip('conn-throw', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await withOrderPushSweepLockOrSkip('conn-throw', async () => 'after'), 'after', 'arm 3')
})

test('the removal-note obligation store: recorded once as intended, patched under a row lock, listed, cleared', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort } = await import('@/lib/domain/wms/order-push-sweep')
  const { REMOVAL_NOTE_KEY_PREFIX } = await import('@/lib/domain/wms/removal-note-obligation')
  const port = createPrismaWmsOrderPushPort()
  const connector = 'test-removal-note-connector'
  t.after(async () => { await db.setting.deleteMany({ where: { key: { startsWith: `${REMOVAL_NOTE_KEY_PREFIX}${connector}:` } } }) })
  const note = { linkId: 'link-1', orderId: 'order-1', externalOrderId: 'wms-1', items: [{ externalItemId: '10', sku: 'SKU-A', quantity: 2 }] }

  const first = await port.recordRemovalNote!(connector, note)
  const second = await port.recordRemovalNote!(connector, { ...note, items: [] })
  assert.equal(second.id, first.id, 'idempotent: the first obligation (and its marker id) is kept')
  assert.deepEqual(second.items, note.items)
  assert.equal(first.state, 'intended')
  assert.equal(await port.updateRemovalNote!(connector, 'link-1', { state: 'owed' }), true)
  assert.equal(await port.updateRemovalNote!(connector, 'link-1', { attempted: true }), true)
  const [owed] = await port.pendingRemovalNotes!(connector, 10)
  assert.equal(owed.state, 'owed')
  assert.equal(owed.attempted, true, 'patches merge')
  assert.equal(await port.updateRemovalNote!(connector, 'no-such-link', { state: 'owed' }), false)
  assert.deepEqual(await port.pendingRemovalNotes!('another-connector', 10), [], 'scoped to the connector')
  assert.equal(await port.clearRemovalNote!(connector, 'link-1'), true)
  assert.equal(await port.clearRemovalNote!(connector, 'link-1'), false)
})

test('real database: an owed note posts ONCE with its marker; after the order is deleted (reset) or erased the obligation is dropped and nothing is posted', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort, runWmsOrderPushSweepCore } = await import('@/lib/domain/wms/order-push-sweep')
  const { removalNoteKey, removalNoteMarker, serializeRemovalNote } = await import('@/lib/domain/wms/removal-note-obligation')
  const { randomUUID } = await import('node:crypto')
  const tag = `rn${randomUUID().slice(0, 8)}`
  const connectorId = 'mintsoft'
  const ids: string[] = []
  const keys: string[] = []
  t.after(async () => {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
  })
  const seed = async (suffix: string) => {
    const id = `${tag}${suffix}`
    ids.push(id)
    await db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
    const link = await db.wmsOrderPushLink.create({ data: { orderId: id, connector: connectorId, state: 'CANCELLED', externalOrderId: `surv-${id}`, externalOrderNumber: 'MS-1' } })
    const ob = { id: 'ob1', linkId: link.id, orderId: id, externalOrderId: `surv-${id}`, state: 'owed' as const, attempted: false, items: [{ externalItemId: '10', sku: 'SKU-A', quantity: 1 }] }
    await db.setting.create({ data: { key: removalNoteKey(connectorId, link.id), value: serializeRemovalNote(ob) } })
    keys.push(removalNoteKey(connectorId, link.id))
    return { id, ob, linkId: link.id }
  }
  const posted: Array<{ id: string; comment: string }> = []
  const connector = {
    pushOrder: async () => { throw new Error('not used') },
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }),
    addOrderComment: async (id: string, comment: string) => { posted.push({ id, comment }) },
  }
  const run = () => runWmsOrderPushSweepCore(connector as never, connectorId, createPrismaWmsOrderPushPort(), { batchSize: 500 })

  const live = await seed('a')
  const reset = await seed('b')
  const erased = await seed('c')
  await db.salesOrder.deleteMany({ where: { id: reset.id } }) // the reset: orders go, the link cascades, the setting survives
  await db.salesOrder.update({ where: { id: erased.id }, data: { erasedAt: new Date() } })

  await run()
  const mine = (id: string) => posted.filter((p) => p.id === `surv-${id}`)
  assert.equal(mine(live.id).length, 1, 'the live obligation posts once')
  assert.ok(mine(live.id)[0].comment.startsWith(removalNoteMarker(live.ob)), 'the note carries its marker first')
  assert.equal(mine(reset.id).length, 0, 'after a reset nothing is posted')
  assert.equal(mine(erased.id).length, 0, 'an erased order is never posted')
  for (const x of [live, reset, erased]) assert.equal(await db.setting.count({ where: { key: removalNoteKey(connectorId, x.linkId) } }), 0, 'obligation gone')
  await run()
  assert.equal(mine(live.id).length, 1, 'and never again')
})
