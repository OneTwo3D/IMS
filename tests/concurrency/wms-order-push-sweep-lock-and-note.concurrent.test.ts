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

test('the removal-note obligation is idempotent and cleared once', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort, REMOVAL_NOTE_KEY_PREFIX } = await import('@/lib/domain/wms/order-push-sweep')
  const port = createPrismaWmsOrderPushPort()
  const connector = 'test-removal-note-connector'
  t.after(async () => { await db.setting.deleteMany({ where: { key: { startsWith: `${REMOVAL_NOTE_KEY_PREFIX}${connector}:` } } }) })
  const note = { linkId: 'link-1', orderId: 'order-1', externalOrderId: 'wms-1', comment: 'first text' }

  await port.recordRemovalNote!(connector, note)
  await port.recordRemovalNote!(connector, { ...note, comment: 'second text' })
  const owed = await port.pendingRemovalNotes!(connector, 10)
  assert.deepEqual(owed, [note], 'arm 4: one obligation, the first text kept')
  assert.deepEqual(await port.pendingRemovalNotes!('another-connector', 10), [], 'scoped to the connector')
  assert.equal(await port.clearRemovalNote!(connector, 'link-1'), true)
  assert.equal(await port.clearRemovalNote!(connector, 'link-1'), false)
  assert.deepEqual(await port.pendingRemovalNotes!(connector, 10), [])
})
