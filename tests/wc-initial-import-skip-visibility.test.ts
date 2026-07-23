import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS,
  shouldLogInitialImportPendingSkip,
} from '@/lib/connectors/woocommerce/webhooks'

// o3d-mqz: the initial-import-pending order-webhook guard ACKs+discards silently while the
// last-received telemetry keeps ticking. A throttled WARNING now makes that gap visible; this pins the
// throttle so a live store's webhook volume can't spam the activity log.

const NOW = 1_800_000_000_000

test('logs when there is no prior skip record (first skip is visible)', () => {
  assert.equal(shouldLogInitialImportPendingSkip(null, NOW), true)
  assert.equal(shouldLogInitialImportPendingSkip(undefined, NOW), true)
})

test('fails toward visibility on an unparseable timestamp', () => {
  assert.equal(shouldLogInitialImportPendingSkip('not-a-date', NOW), true)
})

test('throttles a repeat skip within the window', () => {
  const lastIso = new Date(NOW - 60_000).toISOString() // 1 min ago
  assert.equal(shouldLogInitialImportPendingSkip(lastIso, NOW), false)
})

test('logs again once the throttle window has elapsed', () => {
  const justOver = new Date(NOW - INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS - 1).toISOString()
  assert.equal(shouldLogInitialImportPendingSkip(justOver, NOW), true)
  const exactly = new Date(NOW - INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS).toISOString()
  assert.equal(shouldLogInitialImportPendingSkip(exactly, NOW), true)
})
