import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateDispatchEmailEligibility } from '@/lib/dispatch-email'

const eligibleInput = {
  settingValue: 'true',
  order: { customerEmail: 'customer@example.com', shoppingLinkCount: 0 },
  alreadyQueued: false,
}

test('dispatch email queues for a direct order when the setting is on', () => {
  assert.deepEqual(evaluateDispatchEmailEligibility(eligibleInput), { eligible: true })
})

test('dispatch email is off by default (absent or non-true setting)', () => {
  for (const settingValue of [null, 'false', '1', 'yes', '']) {
    assert.deepEqual(
      evaluateDispatchEmailEligibility({ ...eligibleInput, settingValue }),
      { eligible: false, reason: 'disabled' },
    )
  }
})

test('dispatch email skips storefront-linked orders so WC is not doubled up', () => {
  assert.deepEqual(
    evaluateDispatchEmailEligibility({
      ...eligibleInput,
      order: { customerEmail: 'customer@example.com', shoppingLinkCount: 1 },
    }),
    { eligible: false, reason: 'storefront_order' },
  )
})

test('dispatch email skips orders without a customer email', () => {
  for (const customerEmail of [null, '']) {
    assert.deepEqual(
      evaluateDispatchEmailEligibility({
        ...eligibleInput,
        order: { customerEmail, shoppingLinkCount: 0 },
      }),
      { eligible: false, reason: 'no_customer_email' },
    )
  }
})

test('dispatch email is sent at most once per order', () => {
  assert.deepEqual(
    evaluateDispatchEmailEligibility({ ...eligibleInput, alreadyQueued: true }),
    { eligible: false, reason: 'already_queued' },
  )
})

test('dispatch email skips missing orders', () => {
  assert.deepEqual(
    evaluateDispatchEmailEligibility({ ...eligibleInput, order: null }),
    { eligible: false, reason: 'order_not_found' },
  )
})
