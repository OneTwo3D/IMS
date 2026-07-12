import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FULLY_SHIPPED_TERMINAL_STATUSES,
  isFullyShippedTerminalStatus,
  recognizeShipmentRevenue,
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

test('recognizeShipmentRevenue: final terminal shipment trues up the remaining deferred', () => {
  // Order deferred £100, £66.66 recognized on an earlier shipment this batch.
  // The final shipment of a fully-shipped terminal order must recognize ALL the
  // remainder (33.34), not the rounded proportional slice (which would strand
  // pence in deferral) — cogs-audit scjz.41.
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 33.33,
      remainingDeferred: 100,
      runningRevenue: 66.66,
      isFinalShipmentOfFullyShippedTerminalOrder: true,
    }),
    33.34,
  )
})

test('recognizeShipmentRevenue: final terminal trues up even when proportional rounds high', () => {
  // The true-up is the remaining deferred regardless of the proportional value —
  // it never over-recognizes beyond what is left.
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 50,
      remainingDeferred: 100,
      runningRevenue: 95,
      isFinalShipmentOfFullyShippedTerminalOrder: true,
    }),
    5,
  )
})

test('recognizeShipmentRevenue: non-final shipment recognizes the proportional slice', () => {
  // When there is plenty of deferral left, recognize exactly the proportional slice.
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 25,
      remainingDeferred: 100,
      runningRevenue: 0,
      isFinalShipmentOfFullyShippedTerminalOrder: false,
    }),
    25,
  )
})

test('recognizeShipmentRevenue: non-final slice is capped at the remaining deferred', () => {
  // A proportional slice can never recognize more than what is left deferred,
  // so an order never recognizes beyond what it deferred.
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 40,
      remainingDeferred: 100,
      runningRevenue: 80,
      isFinalShipmentOfFullyShippedTerminalOrder: false,
    }),
    20,
  )
})

test('recognizeShipmentRevenue: never returns negative when already over-recognized', () => {
  // Defensive: if runningRevenue already exceeds remainingDeferred (rounding
  // drift), the cap floors at 0 rather than clawing back.
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 10,
      remainingDeferred: 100,
      runningRevenue: 105,
      isFinalShipmentOfFullyShippedTerminalOrder: true,
    }),
    0,
  )
  assert.equal(
    recognizeShipmentRevenue({
      proportionalRevenue: 10,
      remainingDeferred: 100,
      runningRevenue: 105,
      isFinalShipmentOfFullyShippedTerminalOrder: false,
    }),
    0,
  )
})
