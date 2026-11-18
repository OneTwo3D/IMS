import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { receiptJournalAmount } from '@/lib/domain/accounting/receipt-journal-amount'

test('a sub-half-penny receipt value owes no journal', () => {
  assert.equal(receiptJournalAmount('0.004999'), null)
  assert.equal(receiptJournalAmount(0.001), null)
  assert.equal(receiptJournalAmount(0), null)
  assert.equal(receiptJournalAmount(null), null)
})

test('a receipt value that rounds to a penny or more posts the rounded amount', () => {
  assert.equal(receiptJournalAmount('0.005'), 0.01)
  assert.equal(receiptJournalAmount('12.344'), 12.34)
})

test('both receipt writers gate the journal on the rounded amount', () => {
  for (const file of ['app/actions/purchase-orders.ts', 'lib/domain/wms/booked-in-service.ts']) {
    const src = readFileSync(file, 'utf8')
    assert.match(src, /receiptJournalAmount\(/, `${file} must use receiptJournalAmount`)
    assert.doesNotMatch(src, /(totalReceiptValue|receiptValueBase)\.gt\(0\)/, `${file} must not gate on the unrounded value`)
  }
})
