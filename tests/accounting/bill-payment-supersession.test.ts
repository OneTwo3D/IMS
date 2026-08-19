import assert from 'node:assert/strict'
import test from 'node:test'

import { supersededBillPaymentRows } from '@/lib/domain/accounting/payment-reversal'

/**
 * o3d-a3wx. BILL_PAYMENT joined accounting_sync_logs_followup_live_unique, keyed by
 * (connector, type, reference, accountingInvoiceId). markBillPaid only wins the `paidAt: null -> paid`
 * transition when IMS currently holds the bill UNSETTLED — which, if a live BILL_PAYMENT row exists, can
 * only mean the poller's reversal pass cleared paidAt because the payment is gone from the ledger. Left
 * in place that stale row would occupy the slot and refuse the legitimate re-payment: the constraint
 * meant to stop a double payment stranding a real one instead.
 */

test('a SYNCED registration for a bill being re-marked paid is superseded', () => {
  assert.deepEqual(
    supersededBillPaymentRows([{ id: 'log-1', status: 'SYNCED' }]).map((r) => r.id),
    ['log-1'],
  )
})

test('an in-flight registration is superseded too', () => {
  // PENDING/PROCESSING rows are inside the index's live predicate, so they hold the slot exactly as
  // firmly as a SYNCED one.
  assert.deepEqual(
    supersededBillPaymentRows([{ id: 'log-1', status: 'PENDING' }, { id: 'log-2', status: 'PROCESSING' }]).map((r) => r.id),
    ['log-1', 'log-2'],
  )
})

test('FAILED and CANCELLED rows are left exactly as they are', () => {
  // They are already outside the live predicate, so they block nothing — and rewriting a FAILED row as
  // CANCELLED would erase the fact that the ledger rejected it, which is the evidence an operator needs
  // and which the "FAILED does not prove nothing posted" reading (o3d-ju8t) depends on.
  assert.deepEqual(
    supersededBillPaymentRows([{ id: 'log-1', status: 'FAILED' }, { id: 'log-2', status: 'CANCELLED' }]),
    [],
  )
})
