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
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncSuccessAt: mins(200), syncFrequencyMinutes: 60, createdAt: days(30) }, NOW), true)
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncSuccessAt: mins(100), syncFrequencyMinutes: 60, createdAt: days(30) }, NOW), false)
  // Tight cadences use the one-hour floor, not 3×5m.
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncSuccessAt: mins(30), syncFrequencyMinutes: 5, createdAt: days(30) }, NOW), false)
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncSuccessAt: mins(70), syncFrequencyMinutes: 5, createdAt: days(30) }, NOW), true)
  // Never-SUCCESSFULLY-synced bindings anchor on creation (Codex r5: the
  // predicate deliberately never sees the attempt timestamp — FAILED attempts
  // advancing lastStockSyncAt must not count as freshness).
  assert.equal(watchdog.isBindingSyncStale({ lastStockSyncSuccessAt: null, syncFrequencyMinutes: 60, createdAt: mins(200) }, NOW), true)
})

// ---------------------------------------------------------------------------
// o3d-hl8l r3 (Codex r2 finding 1): this alert is the ONLY push a refused booked-in callback ever
// produces, so it is the only place the remedy can be said. "Chase the shipment / callback in the
// WMS" sent the reader looking for a receipt-event row that a refused callback never created.
// ---------------------------------------------------------------------------

test('o3d-hl8l r3: the overdue-ASN alert names the Re-check remedy, not a callback that left no row', () => {
  const { breach, creditNote } = watchdog.describeAsnOverdueBreach(
    { eta: days(2), lastCallbackAt: null, createdAt: days(10) },
    [],
    NOW,
  )
  const message = watchdog.buildAsnOverdueAlertMessage({
    externalAsnId: 'ASN-77',
    warehouseCode: 'CAM',
    breach,
    creditNote,
    sourceType: 'PURCHASE_ORDER',
  })

  assert.match(message, /^ASN ASN-77 \(CAM\) is past its ETA \(2026-07-10\) with no booked-in callback\./)
  assert.match(message, /"Re-check"/, 'the reader must be told the action that exists')
  assert.match(message, /purchase order → ASNs/, 'and where to find it')
  assert.match(message, /books in only what is still outstanding/, 'and that pressing it is safe')
  assert.doesNotMatch(message, /Chase the shipment/, 'the old text named no remedy at all')
})

test('o3d-hl8l r4: a STOCK-TRANSFER ASN is sent to the screen that can actually act on it', () => {
  // Codex r3 #1. The remedy was one fixed sentence naming "purchase order → ASNs", and this
  // processor serves stock-transfer ASNs too — for which that screen does not exist. An operator
  // following the alert was sent somewhere with nothing to press, which reads as though the remedy
  // had been tried and failed rather than as a wrong signpost.
  const { breach, creditNote } = watchdog.describeAsnOverdueBreach(
    { eta: days(2), lastCallbackAt: null, createdAt: days(10) },
    [],
    NOW,
  )
  const message = watchdog.buildAsnOverdueAlertMessage({
    externalAsnId: 'ASN-T1',
    warehouseCode: 'CAM',
    breach,
    creditNote,
    sourceType: 'STOCK_TRANSFER',
  })

  assert.match(message, /"Re-check"/, 'the remedy is still named')
  assert.match(message, /stock transfer → WMS ASN/, 'and it points at the transfer screen')
  assert.doesNotMatch(
    message,
    /purchase order/,
    'naming the purchase-order screen for a transfer ASN sends the reader somewhere that cannot act on it',
  )
})

test('o3d-hl8l r4: the notification link follows the ASN kind, not a blanket /sync', () => {
  assert.equal(
    watchdog.describeAsnRecheckRemedy('PURCHASE_ORDER').actionUrl,
    '/purchase-orders',
  )
  assert.equal(
    watchdog.describeAsnRecheckRemedy('STOCK_TRANSFER').actionUrl,
    '/stock-control/transfers',
    'the alert must link to the table that carries THIS ASN\'s Re-check control',
  )
  // The line-level source types resolve the same way, so a row carrying one is not silently
  // routed to the purchase-order default.
  assert.equal(
    watchdog.describeAsnRecheckRemedy('STOCK_TRANSFER_LINE').actionUrl,
    '/stock-control/transfers',
  )
})

test('o3d-hl8l r3: the remedy is appended after the alignment-credit blast radius, not instead of it', () => {
  const { breach, creditNote } = watchdog.describeAsnOverdueBreach(
    { eta: null, lastCallbackAt: days(8), createdAt: days(30) },
    [{ sku: 'SKU-1' }, { sku: 'SKU-2' }],
    NOW,
  )
  const message = watchdog.buildAsnOverdueAlertMessage({
    externalAsnId: 'ASN-88',
    warehouseCode: 'EAR2',
    breach,
    creditNote,
    sourceType: 'PURCHASE_ORDER',
  })

  assert.match(message, /no further booked-in callback for 8 days/)
  assert.match(message, /2 line\(s\) carry unreconciled alignment credits \(e\.g\. SKU-1\)/)
  assert.ok(
    message.indexOf('alignment credits') < message.indexOf('"Re-check"'),
    'the breach and its blast radius come first; the remedy closes the message',
  )
})
