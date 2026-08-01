import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_WDRAW_APPROVED_STATUS,
  DEFAULT_WDRAW_SUBMITTED_STATUS,
  classifyWithdrawalStatus,
  normaliseStatus,
} from '../lib/connectors/woocommerce/sync/withdrawal.ts'

const DEFAULTS = {
  submitted: DEFAULT_WDRAW_SUBMITTED_STATUS,
  approved: DEFAULT_WDRAW_APPROVED_STATUS,
}

// --- status normalisation --------------------------------------------------
// The sibling WooCommerce<->Mintsoft sync shipped a prefix strip written as
// lstrip('wc-'), which strips a CHARACTER SET rather than a prefix and turned
// "cancelled" into "ancelled" — silently disabling the guard it protected.
// The same shape of bug here would turn "withdrawn" into "ithdrawn".

test('normaliseStatus strips the wc- PREFIX, not a character set', () => {
  assert.equal(normaliseStatus('wc-withdrawn'), 'withdrawn')
  assert.equal(normaliseStatus('withdrawn'), 'withdrawn')
  assert.equal(normaliseStatus('wc-pending-wdraw'), 'pending-wdraw')
  assert.equal(normaliseStatus('cancelled'), 'cancelled')
  assert.equal(normaliseStatus('completed'), 'completed')
})

test('normaliseStatus tolerates case and whitespace', () => {
  assert.equal(normaliseStatus('  WC-Withdrawn '), 'withdrawn')
  assert.equal(normaliseStatus('PENDING-WDRAW'), 'pending-wdraw')
})

test('normaliseStatus handles absent and non-string values', () => {
  for (const v of [null, undefined, 0, false, {}, []]) {
    assert.equal(typeof normaliseStatus(v), 'string')
  }
  assert.equal(normaliseStatus(null), '')
  assert.equal(normaliseStatus(undefined), '')
})

// --- the branch table ------------------------------------------------------

test('a submitted request with no existing hold places one', () => {
  assert.equal(classifyWithdrawalStatus('pending-wdraw', DEFAULTS, false), 'submitted')
})

test('a submitted request is idempotent once held', () => {
  assert.equal(classifyWithdrawalStatus('pending-wdraw', DEFAULTS, true), 'already-held')
})

test('an approved request cancels, held or not', () => {
  assert.equal(classifyWithdrawalStatus('withdrawn', DEFAULTS, true), 'approved')
  assert.equal(classifyWithdrawalStatus('withdrawn', DEFAULTS, false), 'approved')
})

test('the wc- prefixed forms classify identically', () => {
  assert.equal(classifyWithdrawalStatus('wc-pending-wdraw', DEFAULTS, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('wc-withdrawn', DEFAULTS, false), 'approved')
})

test('ordinary statuses on an unheld order are not withdrawals', () => {
  for (const s of ['processing', 'completed', 'on-hold', 'pending', 'cancelled', 'refunded', 'failed']) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, false), 'not-a-withdrawal', s)
  }
})

test('ANY other status while held is the rejection, and keeps the hold', () => {
  // There is no "rejected" storefront status: the plugin simply returns the
  // order to whatever it was. Every one of these must retain the hold rather
  // than release the goods back onto the pick line.
  for (const s of ['processing', 'completed', 'on-hold', 'pending', 'failed', 'some-custom-status']) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, true), 'rejected-held', s)
  }
})

test('an empty or missing status while held still retains the hold', () => {
  for (const s of ['', '   ', null, undefined]) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, true), 'rejected-held', String(s))
  }
})

test('an empty status on an unheld order is not a withdrawal', () => {
  assert.equal(classifyWithdrawalStatus('', DEFAULTS, false), 'not-a-withdrawal')
})

// --- configurability -------------------------------------------------------

test('renamed storefront statuses are honoured', () => {
  const custom = { submitted: 'widerruf-offen', approved: 'widerrufen' }
  assert.equal(classifyWithdrawalStatus('widerruf-offen', custom, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('widerrufen', custom, false), 'approved')
  // ...and the WebToffee defaults are then just ordinary statuses.
  assert.equal(classifyWithdrawalStatus('pending-wdraw', custom, false), 'not-a-withdrawal')
})

test('settings entered with a wc- prefix still match', () => {
  const prefixed = { submitted: 'wc-pending-wdraw', approved: 'wc-withdrawn' }
  assert.equal(classifyWithdrawalStatus('pending-wdraw', prefixed, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('withdrawn', prefixed, false), 'approved')
})

test('a misconfiguration mapping both to one slug resolves to the safer branch', () => {
  // Cancelling is a safer reading of an ambiguous configuration than holding:
  // it stops the goods outright rather than parking them for a release that
  // may never be authorised.
  const same = { submitted: 'withdrawn', approved: 'withdrawn' }
  assert.equal(classifyWithdrawalStatus('withdrawn', same, false), 'approved')
  assert.equal(classifyWithdrawalStatus('withdrawn', same, true), 'approved')
})

// --- ordering, via the real lifecycle state machine -------------------------
// The handler no longer uses the blanket transition bypass, so the state
// machine is what makes concurrent deliveries safe. These pin that the
// machine actually refuses the transitions the withdrawal paths rely on it
// refusing — if a future edit widens SALES_ORDER_TRANSITIONS, the withdrawal
// races reopen silently and these fail.

import { canTransitionSalesOrder } from '../lib/domain/workflows/sales-order-state.ts'

test('a dispatched order cannot be dragged back to ON_HOLD', () => {
  // A delayed `submitted` delivery arriving after dispatch.
  for (const from of ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'ON_HOLD'), false, from)
  }
})

test('a cancelled order cannot be re-held or re-cancelled', () => {
  // An older `submitted` losing the race to a concurrent approval.
  assert.equal(canTransitionSalesOrder('CANCELLED', 'ON_HOLD'), false)
  assert.equal(canTransitionSalesOrder('CANCELLED', 'CANCELLED'), false)
})

test('the transitions the withdrawal paths DO need are permitted', () => {
  for (const from of ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'ON_HOLD'), true, from)
    assert.equal(canTransitionSalesOrder(from, 'CANCELLED'), true, from)
  }
  // Approval after a hold.
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'CANCELLED'), true)
  // Operator release: back into fulfilment after the hold is cleared.
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'PROCESSING'), true)
})

test('a dispatched order cannot be cancelled either, so approval must not try', () => {
  for (const from of ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'CANCELLED'), false, from)
  }
})
