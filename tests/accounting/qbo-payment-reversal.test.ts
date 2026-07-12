import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyQboReversals } from '@/lib/connectors/quickbooks/payment-poller'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'

test('balance-due entities are reversed but not voided (chargeback-eligible)', () => {
  const { all, voided } = classifyQboReversals([{ Id: 'I1' }, { Id: 'I2' }], [])
  assert.deepEqual([...all].sort(), ['I1', 'I2'])
  assert.equal(voided.size, 0)
})

test('zeroed entities are both reversed and voided (chargeback-skipped)', () => {
  const { all, voided } = classifyQboReversals([], [{ Id: 'I3' }])
  assert.ok(all.has('I3'))
  assert.ok(voided.has('I3'))
})

test('an entity that is both balance-due and zeroed lands in voided (union, deduped)', () => {
  const { all, voided } = classifyQboReversals([{ Id: 'I4' }], [{ Id: 'I4' }])
  assert.deepEqual([...all], ['I4'])
  assert.ok(voided.has('I4'))
})

test('empty inputs yield empty sets', () => {
  const { all, voided } = classifyQboReversals([], [])
  assert.equal(all.size, 0)
  assert.equal(voided.size, 0)
})

test('classifier output drives detectPaymentReversals over IMS-paid orders', () => {
  const paidOrders = [
    { id: 'o1', accountingInvoiceId: 'I1' }, // payment un-applied -> reversed
    { id: 'o2', accountingInvoiceId: 'I3' }, // voided -> reversed (skip chargeback)
    { id: 'o3', accountingInvoiceId: 'I9' }, // untouched -> not reversed
  ]
  const { all, voided } = classifyQboReversals([{ Id: 'I1' }], [{ Id: 'I3' }])
  const reversed = detectPaymentReversals(paidOrders, all)
  assert.deepEqual(reversed.map((o) => o.id).sort(), ['o1', 'o2'])
  // I1 is live (chargeback-eligible); I3 is voided (chargeback-skipped)
  assert.equal(voided.has('I1'), false)
  assert.equal(voided.has('I3'), true)
})
