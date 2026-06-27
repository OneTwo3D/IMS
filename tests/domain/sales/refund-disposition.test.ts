import assert from 'node:assert/strict'
import test from 'node:test'

import { refundDispositionForStatus } from '@/lib/domain/sales/refund-disposition'

test('refundDispositionForStatus maps legacy refund statuses to dispositions', () => {
  assert.equal(refundDispositionForStatus('REFUNDED'), 'FULL')
  assert.equal(refundDispositionForStatus('PARTIALLY_REFUNDED'), 'PARTIAL')
})

test('refundDispositionForStatus returns NONE for non-refund lifecycle statuses', () => {
  for (const status of ['DRAFT', 'PROCESSING', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
    assert.equal(refundDispositionForStatus(status), 'NONE', `${status} should be NONE`)
  }
})
