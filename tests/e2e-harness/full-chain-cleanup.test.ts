import assert from 'node:assert/strict'
import test from 'node:test'

import { runAllCleanups } from '../../e2e/full-chain/harness/cleanup.ts'

test('a rejecting cleanup step does not cancel the ones after it', async () => {
  // The regression this exists for: X-04's LAST two steps restore the drift Settings, and skipping them
  // leaves the snapshot pointing at a deliberately-drifted rate that later runs then capture and restore
  // forever. So an early failure must not abandon the tail.
  const ran: string[] = []
  await assert.rejects(
    () => runAllCleanups('X-04', [
      ['delete logs', async () => { ran.push('delete logs'); throw new Error('transient db blip') }],
      ['delete rate', async () => { ran.push('delete rate') }],
      ['restore snapshot', async () => { ran.push('restore snapshot') }],
      ['restore checked-at', async () => { ran.push('restore checked-at') }],
    ]),
    (e: Error) => {
      // Loud, and specific about what failed — a swallowed cleanup error would be worse than the abort.
      assert.match(e.message, /X-04 cleanup failed/)
      assert.match(e.message, /delete logs: transient db blip/)
      return true
    },
  )
  assert.deepEqual(ran, ['delete logs', 'delete rate', 'restore snapshot', 'restore checked-at'])
})

test('every failure is reported, not just the first', async () => {
  await assert.rejects(
    () => runAllCleanups('X-04', [
      ['first', async () => { throw new Error('boom one') }],
      ['second', async () => {}],
      ['third', async () => { throw new Error('boom two') }],
    ]),
    (e: Error) => {
      assert.match(e.message, /first: boom one/)
      assert.match(e.message, /third: boom two/)
      return true
    },
  )
})

test('all steps succeeding resolves quietly', async () => {
  const ran: string[] = []
  await runAllCleanups('X-04', [
    ['a', async () => { ran.push('a') }],
    ['b', async () => { ran.push('b') }],
  ])
  assert.deepEqual(ran, ['a', 'b'])
})
