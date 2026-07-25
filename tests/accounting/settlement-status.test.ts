import assert from 'node:assert/strict'
import test from 'node:test'

import { settlementStatus, type PaymentSyncRow } from '@/lib/domain/accounting/settlement-status'

/**
 * o3d-lgo.15. markBillPaid marks a bill paid in IMS and only QUEUES the BILL_PAYMENT. That sync can
 * fail — a missing scope, a stale bank-account mapping, any Xero error — and when it does, Xero never
 * settles the bill and never posts its native realised FX, while IMS goes on reporting it paid. Nothing
 * read the payment row back to qualify the local claim, so the two systems disagreed silently.
 *
 * The distinction that matters throughout: a state that is merely NOT YET confirmed is progress, and a
 * state where IMS claims a settlement the ledger does not support is a DISCREPANCY. Only the second is
 * worth waking anyone for, and calling the first one a fault is how alerts get ignored.
 */

const base = { paidLocally: true, syncEnabled: true, documentPosted: true }
const row = (over: Partial<PaymentSyncRow> = {}): PaymentSyncRow => ({ status: 'SYNCED', externalTransactionId: 'PAY-1', ...over })

test('a confirmed payment is the only fully settled state', () => {
  const v = settlementStatus({ ...base, payment: row() })
  assert.equal(v.status, 'SETTLED')
  assert.equal(v.discrepancy, false)
  assert.match(v.detail, /PAY-1/)
})

test('a payment still in the queue is progress, not a fault', () => {
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const v = settlementStatus({ ...base, payment: row({ status, externalTransactionId: null }) })
    assert.equal(v.status, 'AWAITING_LEDGER', status)
    assert.equal(v.discrepancy, false, `${status} must not be reported as a discrepancy`)
  }
})

test('a queued payment that has already failed attempts says so, while it retries', () => {
  const v = settlementStatus({ ...base, payment: row({ status: 'PENDING', externalTransactionId: null, retryCount: 3 }) })
  assert.equal(v.status, 'AWAITING_LEDGER')
  assert.match(v.detail, /3 attempt/)
})

test('a REJECTED payment is a discrepancy, and names the reason', () => {
  // The o3d-lgo.15 case exactly: IMS says paid, the ledger still shows it outstanding.
  const v = settlementStatus({
    ...base,
    payment: row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'AuthorizationUnsuccessful' }),
  })
  assert.equal(v.status, 'LEDGER_REJECTED')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /AuthorizationUnsuccessful/)
  assert.match(v.detail, /still shows the amount outstanding/)
})

test('a payment that was never queued is the QUIETEST failure, and still a discrepancy', () => {
  // addPayment records a manual sales receipt without queueing an INVOICE_PAYMENT at all, and
  // markBillPaid swallows a queue error. Either way there is no FAILED row to notice — the absence is
  // the fault, so absence has to be a verdict rather than a gap in the data.
  const v = settlementStatus({ ...base, payment: null })
  assert.equal(v.status, 'NOT_SENT')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /never learn/)
})

test('a cancelled payment sync is also "the ledger was never told"', () => {
  const v = settlementStatus({ ...base, payment: row({ status: 'CANCELLED', externalTransactionId: null }) })
  assert.equal(v.status, 'NOT_SENT')
  assert.equal(v.discrepancy, true)
})

test('SYNCED with no ledger id is NOT treated as settled', () => {
  // A success we cannot point at is not a settlement: there is nothing to reconcile against, and
  // claiming otherwise would hide the very disagreement this exists to surface.
  const v = settlementStatus({ ...base, payment: row({ externalTransactionId: null }) })
  assert.equal(v.status, 'AWAITING_LEDGER')
  assert.equal(v.discrepancy, true)
})

test('nothing is expected of a document that is not paid locally', () => {
  const v = settlementStatus({ ...base, paidLocally: false, payment: null })
  assert.equal(v.status, 'UNPAID')
  assert.equal(v.discrepancy, false)
})

test('with sync off, a local payment is not a discrepancy', () => {
  // Reporting one would paint every document red on an installation that deliberately does not sync.
  const v = settlementStatus({ ...base, syncEnabled: false, payment: null })
  assert.equal(v.status, 'NOT_APPLICABLE')
  assert.equal(v.discrepancy, false)
})

test('a document that has not posted yet points at the DOCUMENT, not the payment', () => {
  // A payment cannot attach to an invoice the ledger has never seen. Calling that a missing payment
  // sends someone looking in the wrong place for a fault that is one step earlier.
  const v = settlementStatus({ ...base, documentPosted: false, payment: null })
  assert.equal(v.status, 'NOT_APPLICABLE')
  assert.equal(v.discrepancy, false)
  assert.match(v.detail, /document sync is what to chase/)
})
