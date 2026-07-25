import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import test from 'node:test'

import { isLockOwnerAlive, LOCK_STALE_AFTER_MS } from '../../e2e/full-chain/harness/quiesce.ts'

test('a live process on THIS host is reported alive — the lock must not be stolen', () => {
  // This test IS a live process, so its own pid is the clearest possible "alive" case.
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid, ownerHost: hostname() }), true)
})

test('a dead pid on THIS host is reported dead — safe to recover immediately', () => {
  // pid 2^22 is above the default pid_max on Linux, so it cannot be running.
  assert.equal(isLockOwnerAlive({ ownerPid: 4_194_304, ownerHost: hostname() }), false)
})

test('an owner on ANOTHER host is UNKNOWABLE, not assumed dead', () => {
  // Guessing "dead" here is what would let a second machine steal a live lock; the caller falls back to age.
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid, ownerHost: `${hostname()}-somewhere-else` }), null)
})

test('a lock written by an older build (no owner recorded) is UNKNOWABLE, not assumed dead', () => {
  assert.equal(isLockOwnerAlive({}), null)
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid }), null)
  assert.equal(isLockOwnerAlive({ ownerHost: hostname() }), null)
})

test('the staleness window is far longer than any legitimate hold', () => {
  // A full-chain invocation is minutes and the longest single test allows 15; the window must clear that by a
  // wide margin, or a slow-but-healthy run would have its lock recovered underneath it.
  assert.ok(LOCK_STALE_AFTER_MS >= 30 * 60_000, 'at least 30 minutes')
})
