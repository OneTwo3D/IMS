import assert from 'node:assert/strict'
import test from 'node:test'

import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'

test('flags paid documents whose external invoice regressed (reversed in Xero)', () => {
  const paid = [
    { id: 'o1', accountingInvoiceId: 'X1' },
    { id: 'o2', accountingInvoiceId: 'X2' },
    { id: 'o3', accountingInvoiceId: 'X3' },
  ]
  const reversed = new Set(['X2'])
  assert.deepEqual(detectPaymentReversals(paid, reversed).map((d) => d.id), ['o2'])
})

test('no reversals when none of the paid docs regressed', () => {
  const paid = [{ id: 'o1', accountingInvoiceId: 'X1' }]
  assert.deepEqual(detectPaymentReversals(paid, new Set(['X9'])), [])
})

test('ignores docs with no external invoice id', () => {
  const paid = [{ id: 'o1', accountingInvoiceId: null }]
  assert.deepEqual(detectPaymentReversals(paid, new Set(['X1'])), [])
})

test('empty inputs return no reversals', () => {
  assert.deepEqual(detectPaymentReversals([], new Set(['X1'])), [])
  assert.deepEqual(detectPaymentReversals([{ id: 'o1', accountingInvoiceId: 'X1' }], new Set<string>()), [])
})

test('two IMS docs linked to the same reversed invoice are both cleared (split shipment)', () => {
  const paid = [
    { id: 'o1', accountingInvoiceId: 'X1' },
    { id: 'o2', accountingInvoiceId: 'X1' },
  ]
  assert.deepEqual(detectPaymentReversals(paid, new Set(['X1'])).map((d) => d.id), ['o1', 'o2'])
})
