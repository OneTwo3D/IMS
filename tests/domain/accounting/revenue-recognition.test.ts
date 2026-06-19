import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FULLY_SHIPPED_TERMINAL_STATUSES,
  isFullyShippedTerminalStatus,
} from '@/lib/domain/accounting/revenue-recognition'

test('fully-shipped terminal statuses true up deferred revenue', () => {
  // These reach a terminal post-shipment state, so the final shipment must
  // recognize all remaining deferred revenue (scjz.41).
  for (const status of ['SHIPPED', 'COMPLETED', 'DELIVERED']) {
    assert.equal(isFullyShippedTerminalStatus(status), true, `${status} should true up`)
  }
})

test('partially-refunded, full-reversal and pre-shipment statuses do not true up deferred revenue', () => {
  // PARTIALLY_REFUNDED is excluded: it can be set pre-shipment (refunding unshipped
  // lines) and already posts an UNEARNED_REV_REVERSAL that remainingDeferred does
  // not subtract, so truing up there would over-recognize (scjz.68). REFUNDED/
  // CANCELLED are full reversals (no revenue); the rest may still ship.
  for (const status of ['PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'ON_HOLD']) {
    assert.equal(isFullyShippedTerminalStatus(status), false, `${status} should not true up`)
  }
})

test('the terminal-status set is exactly the three fully-shipped states', () => {
  assert.deepEqual([...FULLY_SHIPPED_TERMINAL_STATUSES].sort(), ['COMPLETED', 'DELIVERED', 'SHIPPED'])
})
