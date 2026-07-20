import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isPermanentStatusTransitionError,
  PermanentStatusTransitionError,
} from '@/lib/domain/sales/status-transition-errors'
import { WorkflowTransitionError } from '@/lib/domain/workflows/status-types'

test('a permanent business rejection is recognised', () => {
  const error = new PermanentStatusTransitionError('Cannot cancel a shipped order — process a refund instead')
  assert.equal(isPermanentStatusTransitionError(error), true)
  // The message is unchanged, so anything matching on it still works.
  assert.match(error.message, /Cannot cancel a shipped order/)
  assert.ok(error instanceof Error)
})

test('a generic invalid state-machine move is TRANSIENT — the pair can become valid', () => {
  // DRAFT -> SHIPPED is invalid, but ALLOCATED -> SHIPPED becomes valid once allocation completes, so an
  // invalid current/target pair is timing-dependent, not terminal. Only physical conflicts qualify.
  assert.equal(isPermanentStatusTransitionError(new WorkflowTransitionError('sales', 'DRAFT', 'SHIPPED')), false)
})

test('TRANSIENT failures are NOT permanent — this is the safety-critical direction', () => {
  // Acknowledging one of these would silently drop a real status change, so anything unrecognised must
  // keep retrying. These are the shapes a DB/lock/transaction failure actually arrives in.
  assert.equal(isPermanentStatusTransitionError(new Error('could not serialize access due to concurrent update')), false)
  assert.equal(isPermanentStatusTransitionError(new Error('Transaction API error: Transaction already closed')), false)
  assert.equal(isPermanentStatusTransitionError(new Error('Timed out fetching a new connection from the connection pool')), false)
  assert.equal(isPermanentStatusTransitionError(undefined), false)
  assert.equal(isPermanentStatusTransitionError(null), false)
  assert.equal(isPermanentStatusTransitionError('a string'), false)
  assert.equal(isPermanentStatusTransitionError({}), false)
})

test('UNMET PREREQUISITES stay transient — they describe a state that changes', () => {
  // These read like business rules but are not terminal: allocation happens, shipments get created and
  // shipped. Acknowledging one would drop the status change, and polling re-imports order data without
  // retrying a status sync — so recovery would depend on an unrelated future webhook.
  for (const message of [
    'Cannot start picking — no products have been allocated. Allocate stock first.',
    'Shipments are required before an order can be marked as shipped',
    'Ship individual shipments first — not all shipments are shipped yet',
  ]) {
    assert.equal(isPermanentStatusTransitionError(new Error(message)), false, message)
  }
})

test('only an irreversible physical conflict is permanent', () => {
  // Goods do not un-ship, so these can never become valid.
  assert.equal(
    isPermanentStatusTransitionError(new PermanentStatusTransitionError('Cannot cancel a shipped order — process a refund instead')),
    true,
  )
  assert.equal(
    isPermanentStatusTransitionError(new PermanentStatusTransitionError('Cannot cancel an order with a dispatched shipment — process a refund instead')),
    true,
  )
  // A missing order may appear after a later import, so it is NOT marked permanent.
  assert.equal(isPermanentStatusTransitionError(new Error('Order not found')), false)
})

test('a re-thrown copy that lost its prototype is still recognised via its marker', () => {
  // Errors crossing a serialization boundary lose `instanceof`; the explicit flag survives.
  assert.equal(isPermanentStatusTransitionError({ message: 'Cannot cancel a shipped order', permanent: true }), true)
  // But a lookalike without the marker must not be promoted.
  assert.equal(isPermanentStatusTransitionError({ message: 'Cannot cancel a shipped order' }), false)
})
