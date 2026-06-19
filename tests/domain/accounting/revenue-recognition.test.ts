import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FULLY_SHIPPED_TERMINAL_STATUSES,
  isFullyShippedTerminalStatus,
} from '@/lib/domain/accounting/revenue-recognition'

test('fully-shipped terminal statuses true up deferred revenue', () => {
  // These reach a terminal post-shipment state, so the final shipment must
  // recognize all remaining deferred revenue (scjz.41).
  for (const status of ['SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED']) {
    assert.equal(isFullyShippedTerminalStatus(status), true, `${status} should true up`)
  }
})

test('full-reversal and pre-shipment statuses do not true up deferred revenue', () => {
  // REFUNDED/CANCELLED are full reversals (no revenue); the rest may still ship.
  for (const status of ['REFUNDED', 'CANCELLED', 'DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'ON_HOLD']) {
    assert.equal(isFullyShippedTerminalStatus(status), false, `${status} should not true up`)
  }
})

test('the terminal-status set is exactly the four fully-shipped states', () => {
  assert.deepEqual([...FULLY_SHIPPED_TERMINAL_STATUSES].sort(), ['COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED', 'SHIPPED'])
})
