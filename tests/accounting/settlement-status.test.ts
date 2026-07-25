import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregatePaymentSyncRows,
  ledgerSalesInvoiceTotalForeign,
  settlementStatus,
  type PaymentSyncRow,
} from '@/lib/domain/accounting/settlement-status'

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


test('a PART payment the ledger accepted is not full settlement', () => {
  // markBillPaid accepts an explicit amountForeign and queues only that. A GBP1 payment against a
  // GBP1,000 bill posted a SYNCED row with an id — and the badge went green over the GBP999 the ledger
  // still shows outstanding.
  const v = settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: 1 }) })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /PART payment of 1 against a total of 1000/)
})

test('a payment for the full amount is settled, and sub-penny rounding does not make it partial', () => {
  assert.equal(settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: 1000 }) }).status, 'SETTLED')
  assert.equal(settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: 999.999 }) }).status, 'SETTLED')
  assert.equal(settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: 1000.5 }) }).status, 'SETTLED')
})

test('with no amount recorded, a confirmed payment is still settled rather than guessed at', () => {
  // Absent data must not manufacture a discrepancy: older rows carry no amount in their payload.
  assert.equal(settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: null }) }).status, 'SETTLED')
  assert.equal(settlementStatus({ ...base, totalForeign: null, payment: row({ amount: 1 }) }).status, 'SETTLED')
})

test('turning sync OFF does not unmake a payment the ledger already rejected', () => {
  // The operator disabling an unhealthy connector is exactly when a known outstanding balance must stay
  // visible — evaluating the flag first turned it green.
  const v = settlementStatus({
    ...base,
    syncEnabled: false,
    payment: row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'rejected' }),
  })
  assert.equal(v.status, 'LEDGER_REJECTED')
  assert.equal(v.discrepancy, true)
})

test('a cancelled payment also survives sync being switched off', () => {
  const v = settlementStatus({ ...base, syncEnabled: false, payment: row({ status: 'CANCELLED', externalTransactionId: null }) })
  assert.equal(v.status, 'NOT_SENT')
  assert.equal(v.discrepancy, true)
})

test('a rejected payment on an unposted document is still a discrepancy', () => {
  // The document-not-posted shortcut is for the case where nothing has been attempted. Once a payment
  // has actually FAILED, that fact outranks the tidy explanation.
  const v = settlementStatus({
    ...base,
    documentPosted: false,
    payment: row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'no such invoice' }),
  })
  assert.equal(v.status, 'LEDGER_REJECTED')
})

// ---------------------------------------------------------------------------
// Aggregating MANY payment rows (o3d-lgo.15, sales side)
// ---------------------------------------------------------------------------
//
// A bill carries one payment. A sales order can carry several — part payments, a manual receipt on top
// of an imported one — each its own sync row with its own fate. Reducing them to "the latest" would
// print a green Settled over an earlier payment the ledger rejected.

test('no payment rows at all is nothing to aggregate', () => {
  assert.equal(aggregatePaymentSyncRows([]), null)
})

test('several confirmed payments settle for their SUM, not for the last one', () => {
  const agg = aggregatePaymentSyncRows([
    row({ externalTransactionId: 'PAY-1', amount: 40 }),
    row({ externalTransactionId: 'PAY-2', amount: 60 }),
  ])!
  assert.equal(agg.status, 'SYNCED')
  assert.equal(agg.amount, 100)
  const v = settlementStatus({ ...base, payment: agg, totalForeign: 100 })
  assert.equal(v.status, 'SETTLED')
  assert.equal(v.discrepancy, false)
})

test('confirmed payments that do not cover the claim are a PART settlement', () => {
  const agg = aggregatePaymentSyncRows([row({ amount: 40 }), row({ externalTransactionId: 'PAY-2', amount: 20 })])!
  const v = settlementStatus({ ...base, payment: agg, totalForeign: 100 })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
  assert.equal(v.discrepancy, true)
})

test('one rejected payment outranks any number of confirmed ones', () => {
  // The question is "does the ledger support what IMS claims", and one unposted payment is enough for
  // the answer to be no — the ledger still shows that much outstanding.
  const agg = aggregatePaymentSyncRows([
    row({ amount: 40 }),
    row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'bank account not found', amount: null }),
  ])!
  assert.equal(agg.status, 'FAILED')
  assert.equal(agg.errorMessage, 'bank account not found')
  const v = settlementStatus({ ...base, payment: agg, totalForeign: 100 })
  assert.equal(v.status, 'LEDGER_REJECTED')
  assert.equal(v.discrepancy, true)
})

test('a cancelled payment outranks confirmed ones, but not a rejected one', () => {
  const cancelled = aggregatePaymentSyncRows([row({ amount: 40 }), row({ status: 'CANCELLED', externalTransactionId: null })])!
  assert.equal(cancelled.status, 'CANCELLED')
  const bothBad = aggregatePaymentSyncRows([
    row({ status: 'CANCELLED', externalTransactionId: null }),
    row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'rejected' }),
  ])!
  assert.equal(bothBad.status, 'FAILED', 'a rejection names an error worth showing; a cancellation does not')
})

test('a payment still in flight is reported as in flight, and PROCESSING wins over PENDING', () => {
  const agg = aggregatePaymentSyncRows([
    row({ status: 'PENDING', externalTransactionId: null, retryCount: 1 }),
    row({ status: 'PROCESSING', externalTransactionId: null, retryCount: 4 }),
  ])!
  assert.equal(agg.status, 'PROCESSING')
  assert.equal(agg.retryCount, 4, 'the worst retry count is the one worth showing')
  assert.equal(settlementStatus({ ...base, payment: agg }).discrepancy, false)
})

test('one unverifiable success makes the WHOLE settlement unverifiable', () => {
  // A SYNCED row with no ledger payment id cannot be reconciled against anything, and the ids we DO have
  // do not make up for it — claiming settlement would hide the disagreement this exists to surface.
  const agg = aggregatePaymentSyncRows([row({ amount: 40 }), row({ externalTransactionId: null, amount: 60 })])!
  assert.equal(agg.externalTransactionId, null)
  const v = settlementStatus({ ...base, payment: agg, totalForeign: 100 })
  assert.equal(v.status, 'AWAITING_LEDGER')
  assert.equal(v.discrepancy, true)
})

test('a confirmed payment with no recorded amount makes the SUM unknown, not zero', () => {
  // Unknown must not read as a shortfall: a wrong sum is what decides full settlement from part
  // settlement, and inventing 0 for an unreadable payload would report every such order as under-paid.
  const agg = aggregatePaymentSyncRows([row({ amount: 40 }), row({ externalTransactionId: 'PAY-2', amount: null })])!
  assert.equal(agg.amount, null)
  const v = settlementStatus({ ...base, payment: agg, totalForeign: 100 })
  assert.equal(v.status, 'SETTLED', 'an uncomparable amount cannot be called a part payment')
})

// ---------------------------------------------------------------------------
// What the ledger's copy of the invoice was actually built at
// ---------------------------------------------------------------------------

test('a tax-exclusive invoice posts at the order total', () => {
  assert.equal(ledgerSalesInvoiceTotalForeign({ totalForeign: 120, taxForeign: 20, pricesIncludeVat: false }), 120)
})

test('a tax-inclusive invoice posts at the NET total (o3d-cyn), which is what a payment must match', () => {
  // Not a claim that net is correct — o3d-cyn is the defect that builds it that way. But a payment that
  // matches the invoice IMS really posted is not a SETTLEMENT fault, and reporting it as one would send
  // an operator to the payment when the invoice is what is wrong.
  assert.equal(ledgerSalesInvoiceTotalForeign({ totalForeign: 120, taxForeign: 20, pricesIncludeVat: true }), 100)
  const v = settlementStatus({ ...base, payment: aggregatePaymentSyncRows([row({ amount: 100 })])!, totalForeign: 100 })
  assert.equal(v.status, 'SETTLED')
})
