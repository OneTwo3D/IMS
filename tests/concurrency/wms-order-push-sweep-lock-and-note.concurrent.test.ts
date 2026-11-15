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
  assert.equal(await port.updateRemovalNote!(connector, 'link-1', 'wms-1', { state: 'owed' }), true)
  assert.equal(await port.updateRemovalNote!(connector, 'link-1', 'wms-1', { attempted: true }), true)
  const [owed] = await port.pendingRemovalNotes!(connector, 10)
  assert.equal(owed.state, 'owed')
  assert.equal(owed.attempted, true, 'patches merge')
  assert.equal(await port.updateRemovalNote!(connector, 'no-such-link', 'wms-1', { state: 'owed' }), false)
  const other = await port.recordRemovalNote!(connector, { ...note, externalOrderId: 'wms-2' })
  assert.notEqual(other.id, first.id, 'one obligation per (link, warehouse order)')
  assert.equal(await port.clearRemovalNote!(connector, 'link-1', 'wms-2'), true)
  assert.deepEqual(await port.pendingRemovalNotes!('another-connector', 10), [], 'scoped to the connector')
  assert.equal(await port.clearRemovalNote!(connector, 'link-1', 'wms-1'), true)
  assert.equal(await port.clearRemovalNote!(connector, 'link-1', 'wms-1'), false)
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
    await db.setting.create({ data: { key: removalNoteKey(connectorId, link.id, `surv-${id}`), value: serializeRemovalNote(ob) } })
    keys.push(removalNoteKey(connectorId, link.id, `surv-${id}`))
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
  for (const x of [live, reset, erased]) assert.equal(await db.setting.count({ where: { key: removalNoteKey(connectorId, x.linkId, x.ob.externalOrderId) } }), 0, 'obligation gone')
  await run()
  assert.equal(mine(live.id).length, 1, 'and never again')
})

test('real database: 30 needs_check rows (the oldest) do not starve a newer owed note out of a 25-row batch', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort, runWmsOrderPushSweepCore } = await import('@/lib/domain/wms/order-push-sweep')
  const { removalNoteKey, serializeRemovalNote } = await import('@/lib/domain/wms/removal-note-obligation')
  const { randomUUID } = await import('node:crypto')
  const tag = `st${randomUUID().slice(0, 8)}`
  const connectorId = 'mintsoft'
  const keys: string[] = []
  t.after(async () => {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.salesOrder.deleteMany({ where: { id: `${tag}o` } })
  })
  const item = [{ externalItemId: '10', sku: 'SKU-A', quantity: 1 }]
  for (let i = 0; i < 30; i += 1) {
    const key = removalNoteKey(connectorId, `${tag}-stuck-${i}`, 'y')
    keys.push(key)
    await db.setting.create({ data: { key, value: serializeRemovalNote({ id: `s${i}`, linkId: `${tag}-stuck-${i}`, orderId: 'x', externalOrderId: 'y', state: 'needs_check', attempted: true, items: item }) } })
  }
  const id = `${tag}o`
  await db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
  const link = await db.wmsOrderPushLink.create({ data: { orderId: id, connector: connectorId, state: 'CANCELLED', externalOrderId: `surv-${id}`, externalOrderNumber: 'MS-1' } })
  const owedKey = removalNoteKey(connectorId, link.id, `surv-${id}`)
  keys.push(owedKey)
  await db.setting.create({ data: { key: owedKey, value: serializeRemovalNote({ id: 'ob1', linkId: link.id, orderId: id, externalOrderId: `surv-${id}`, state: 'owed', attempted: false, items: item }) } })

  const port = createPrismaWmsOrderPushPort()
  const batch = await port.pendingRemovalNotes!(connectorId, 25)
  assert.ok(batch.some((o) => o.linkId === link.id), 'the owed note is in the batch')
  assert.ok(batch.every((o) => o.state !== 'needs_check'), 'needs_check rows are excluded by the query')

  const posted: Array<{ id: string; comment: string }> = []
  const connector = {
    pushOrder: async () => { throw new Error('not used') },
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }),
    addOrderComment: async (target: string, comment: string) => { posted.push({ id: target, comment }) },
  }
  await runWmsOrderPushSweepCore(connector as never, connectorId, port, { batchSize: 25 })
  assert.equal(posted.filter((p) => p.id === `surv-${id}`).length, 1, 'the owed note posts')
  assert.equal(await db.setting.count({ where: { key: { in: keys.filter((k) => k !== owedKey) } } }), 30, 'the 30 needs_check rows are untouched')
})

test('real database: the dispatch sweep re-point is REFUSED while the amendment lease is held, and succeeds without one or once it has expired', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaDispatchDeps } = await import('@/lib/domain/wms/dispatch-sweep')
  const { randomUUID } = await import('node:crypto')
  const id = `rp${randomUUID().slice(0, 8)}`
  t.after(async () => { await db.salesOrder.deleteMany({ where: { id } }) })
  await db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
  const link = await db.wmsOrderPushLink.create({ data: { orderId: id, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'old-1', externalOrderNumber: 'MS-1' } })
  const deps = createPrismaDispatchDeps('mintsoft', {} as never)
  const to = { externalOrderId: 'new-1', externalOrderNumber: 'MS-2' }
  const external = async () => (await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })).externalOrderId

  await db.wmsOrderPushLink.update({ where: { id: link.id }, data: { amendLeaseOwner: 'tok', amendLeaseExpiresAt: new Date(Date.now() + 60_000) } })
  assert.equal(await deps.repointLink(link.id, to, { externalOrderId: 'old-1' }), false, 'refused under a live lease')
  assert.equal(await external(), 'old-1', 'and nothing was written')

  await db.wmsOrderPushLink.update({ where: { id: link.id }, data: { amendLeaseExpiresAt: new Date(Date.now() - 1000) } })
  assert.equal(await deps.repointLink(link.id, to, { externalOrderId: 'old-1' }), true, 'an EXPIRED lease does not block it')
  assert.equal(await external(), 'new-1')

  await db.wmsOrderPushLink.update({ where: { id: link.id }, data: { externalOrderId: 'old-2', amendLeaseOwner: null, amendLeaseExpiresAt: null } })
  assert.equal(await deps.repointLink(link.id, { externalOrderId: 'new-2', externalOrderNumber: 'MS-3' }, { externalOrderId: 'old-2' }), true, 'no lease: it repoints')
})

test('real database: the link is re-pointed after the removal is verified and before the close: the note still posts ONCE to the ORIGINAL warehouse order and is not dropped', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort, runWmsOrderPushSweepCore } = await import('@/lib/domain/wms/order-push-sweep')
  const { randomUUID } = await import('node:crypto')
  const id = `race${randomUUID().slice(0, 8)}`
  const orig = `surv-${id}`
  let linkId = ''
  t.after(async () => {
    if (linkId) await db.setting.deleteMany({ where: { key: { startsWith: `wms_order_push_removal_note:mintsoft:${linkId}:` } } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  await db.salesOrder.create({ data: { id, orderNumber: `IMSTEST-${id}`, status: 'CANCELLED', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100 } })
  const link = await db.wmsOrderPushLink.create({ data: { orderId: id, connector: 'mintsoft', state: 'MERGED', externalOrderId: orig, externalOrderNumber: 'MS-A+MS-B' } })
  linkId = link.id
  await db.wmsOrderPushItem.create({ data: { linkId: link.id, externalOrderId: orig, externalItemId: '501', sku: 'SKU-R', quantity: 1 } })

  const posted: Array<{ id: string; comment: string }> = []
  const lines = new Set(['501'])
  const connector = {
    pushOrder: async () => { throw new Error('not used') },
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }),
    removeOrderItems: async (target: string, _e: unknown, items: Array<{ externalItemId: string; sku: string; quantity: number }>) => {
      // The re-pointed link's stored line ids belong to the ORIGINAL order: the connector refuses them on any other order.
      if (target !== orig) return { kind: 'REFUSED' as const, removed: [], remaining: [], reason: 'lines are not on this order' }
      for (const item of items) lines.delete(item.externalItemId)
      // THE RACE: the dispatch sweep's re-point lands now (after the deletion is verified, before the close).
      await db.wmsOrderPushLink.update({ where: { id: link.id }, data: { externalOrderId: 'new-warehouse-order' } })
      return { kind: 'REMOVED' as const, removed: items }
    },
    cancelMergedOrder: async () => { throw new Error('not used') },
    fetchOrderItemRefs: async () => [...lines].map((externalItemId) => ({ externalItemId, sku: 'SKU-R', quantity: 1 })),
    addOrderComment: async (target: string, comment: string) => { posted.push({ id: target, comment }) },
  }
  const run = () => runWmsOrderPushSweepCore(connector as never, 'mintsoft', createPrismaWmsOrderPushPort(), { batchSize: 50 })
  const first = await run()
  const afterFirst = await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
  assert.notEqual(afterFirst.state, 'CANCELLED', 'the close did not land on a link that moved on')
  assert.equal(first.cancelled, 0)
  const mine = () => posted.filter((p) => p.id === orig)
  await run()
  assert.equal(mine().length, 1, 'the verified note posted once, to the original warehouse order')
  assert.match(mine()[0].comment, /^\[IMS removal-note /)
  assert.equal(posted.filter((p) => p.id === 'new-warehouse-order' && p.comment.startsWith('[IMS removal-note')).length, 0, 'and no removal note went to the new order')
  await run()
  assert.equal(mine().length, 1, 'never again')
  assert.equal(await db.setting.count({ where: { key: { endsWith: `${link.id}:${orig}` } } }), 0, 'the original order\'s obligation is cleared')
})
