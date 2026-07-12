import assert from 'node:assert/strict'
import test from 'node:test'
import * as watchdogNs from '../lib/domain/wms/watchdog-sweep.ts'

const watchdog = 'default' in watchdogNs
  ? watchdogNs.default as typeof import('../lib/domain/wms/watchdog-sweep.ts')
  : watchdogNs

const NOW = new Date('2026-07-12T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

test('isAsnOverdue: never-called-back ASNs anchor on the ETA (with grace)', () => {
  assert.equal(watchdog.isAsnOverdue({ eta: days(2), lastCallbackAt: null, createdAt: days(10) }, NOW), true)
  // Within the 24h grace after the ETA: not yet overdue.
  assert.equal(watchdog.isAsnOverdue({ eta: new Date(NOW.getTime() - 3_600_000), lastCallbackAt: null, createdAt: days(10) }, NOW), false)
})

test('isAsnOverdue: after a (partial) callback, RENEWED silence is a fresh breach (Codex r4)', () => {
  // Recent callback: the warehouse is booking it in.
  assert.equal(watchdog.isAsnOverdue({ eta: days(2), lastCallbackAt: days(1), createdAt: days(10) }, NOW), false)
  // Partial callback then a week of silence with the ASN still open: breach —
  // a partial receipt must not make the ASN unwatchable forever.
  assert.equal(watchdog.isAsnOverdue({ eta: days(20), lastCallbackAt: days(8), createdAt: days(30) }, NOW), true)
  assert.equal(watchdog.isAsnOverdue({ eta: null, lastCallbackAt: days(8), createdAt: days(30) }, NOW), true)
  assert.equal(watchdog.isAsnOverdue({ eta: null, lastCallbackAt: days(3), createdAt: days(30) }, NOW), false)
})

test('isAsnOverdue: without an ETA only a completely silent, old ASN is overdue', () => {
  assert.equal(watchdog.isAsnOverdue({ eta: null, lastCallbackAt: null, createdAt: days(8) }, NOW), true)
  assert.equal(watchdog.isAsnOverdue({ eta: null, lastCallbackAt: null, createdAt: days(3) }, NOW), false)
})

test('isBindingSyncStale: stale after 3× its own cadence, floored at an hour', () => {
  const mins = (n: number) => new Date(NOW.getTime() - n * 60_000)
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncAt: mins(200), syncFrequencyMinutes: 60, createdAt: days(30) }, NOW), true)
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncAt: mins(100), syncFrequencyMinutes: 60, createdAt: days(30) }, NOW), false)
  // Tight cadences use the one-hour floor, not 3×5m.
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncAt: mins(30), syncFrequencyMinutes: 5, createdAt: days(30) }, NOW), false)
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncAt: mins(70), syncFrequencyMinutes: 5, createdAt: days(30) }, NOW), true)
  // Never-synced bindings anchor on creation.
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncAt: null, syncFrequencyMinutes: 60, createdAt: mins(200) }, NOW), true)
})
