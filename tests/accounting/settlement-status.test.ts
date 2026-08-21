import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregatePaymentSyncRows,
  effectivePaymentSyncRows,
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
  // A REAL excess is no longer swept into SETTLED (see the OVER_SETTLED case below). This line asserted
  // 1000.5 was settled — as a catch-all for "an excess is not a shortfall", which was true of the
  // question being asked then and hid an over-paid ledger once the verdict was put on screen.
  assert.equal(settlementStatus({ ...base, totalForeign: 1000, payment: row({ amount: 1000.5 }) }).status, 'OVER_SETTLED')
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
  for (const importedFromShop of [true, false]) {
    assert.equal(ledgerSalesInvoiceTotalForeign({ totalForeign: 120, taxForeign: 20, pricesIncludeVat: false, importedFromShop }), 120)
  }
})

test('an IMPORTED tax-inclusive invoice now posts at GROSS too, so the receipt it must match is the gross one (o3d-cyn)', () => {
  // This used to answer 100 — the net total, because the importer sent Woo's ex-tax amounts flagged
  // tax-inclusive and Xero extracted the VAT back out of them. The importer now sends every component
  // ex-tax on both conventions and Xero adds the tax, so the invoice totals to the order's 120 and a
  // gross receipt of 120 settles it exactly. Answering 100 here would refuse that ordinary receipt as
  // an over-payment.
  assert.equal(ledgerSalesInvoiceTotalForeign({ totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, importedFromShop: true }), 120)
  const v = settlementStatus({ ...base, payment: aggregatePaymentSyncRows([row({ amount: 120 })])!, totalForeign: 120 })
  assert.equal(v.status, 'SETTLED')
})

test('a tax-inclusive order raised IN IMS posts at GROSS — unchanged, and now the same rule as an import', () => {
  // queueSalesInvoiceForOrder sends the gross unit prices (and grosses shipping up) before flagging them
  // inclusive. Keying on pricesIncludeVat alone understated the invoice, and the over-pay guard then
  // refused every ordinary VAT receipt it exists to allow.
  assert.equal(ledgerSalesInvoiceTotalForeign({ totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, importedFromShop: false }), 120)
})

test('a PART-registered receipt is still measured against the ledger total, not waved through', () => {
  // The collapse must not have turned the comparison off: 60 of a 120 invoice is still a part payment.
  const v = settlementStatus({ ...base, payment: aggregatePaymentSyncRows([row({ amount: 60 })])!, totalForeign: 120 })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
})

// ---------------------------------------------------------------------------
// The disagreement pointing the OTHER way
// ---------------------------------------------------------------------------

test('a ledger payment for something IMS does not claim is a discrepancy, not "unpaid"', () => {
  // Deleting a receipt whose registration already reached the ledger succeeds locally: the payment stays
  // attached to the invoice there while paidAt clears here. A flat UNPAID hid exactly the case this
  // exists to surface, mirrored.
  const v = settlementStatus({ ...base, paidLocally: false, payment: row({ externalTransactionId: 'PAY-9' }) })
  assert.equal(v.status, 'LEDGER_UNMATCHED')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /PAY-9/)
})

test('a payment still on its way also counts as the ledger holding it', () => {
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const v = settlementStatus({ ...base, paidLocally: false, payment: row({ status, externalTransactionId: null }) })
    assert.equal(v.status, 'LEDGER_UNMATCHED', status)
  }
})

test('a rejected or cancelled payment leaves an unclaimed order genuinely unpaid', () => {
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const v = settlementStatus({ ...base, paidLocally: false, payment: row({ status, externalTransactionId: null }) })
    assert.equal(v.status, 'UNPAID', status)
    assert.equal(v.discrepancy, false, status)
  }
})

test('an order with no payment at all is simply unpaid', () => {
  const v = settlementStatus({ ...base, paidLocally: false, payment: null })
  assert.equal(v.status, 'UNPAID')
  assert.equal(v.discrepancy, false)
})

// ---------------------------------------------------------------------------
// Rows that describe something no longer true (o3d-lgo.15, Codex round 4)
// ---------------------------------------------------------------------------
//
// Worst-first is right for CURRENT rows and wrong for history. deletePayment retires a queued
// registration to CANCELLED rather than deleting it, and leaves FAILED rows alone — so without this,
// correcting a receipt left the order alarming for ever over a perfectly settled invoice.

test('a registration whose receipt was deleted no longer speaks for the order', () => {
  const live = new Set(['pay-2'])
  const rows = effectivePaymentSyncRows([
    row({ status: 'SYNCED', externalTransactionId: 'PAY-2', amount: 100, paymentId: 'pay-2' }),
    row({ status: 'CANCELLED', externalTransactionId: null, paymentId: 'pay-1' }),
  ], { livePaymentIds: live })
  assert.equal(rows.length, 1)
  const v = settlementStatus({ ...base, payment: aggregatePaymentSyncRows(rows), totalForeign: 100 })
  assert.equal(v.status, 'SETTLED')
  assert.equal(v.discrepancy, false)
})

test('a failure a later success overtook is history; one AFTER the last success is not', () => {
  // Newest first. A failure the ledger has since accepted is over; a failure that came after the last
  // success is the live state and must still be reported.
  const overtaken = effectivePaymentSyncRows([
    row({ status: 'SYNCED', externalTransactionId: 'PAY-9', amount: 100, paymentId: 'pay-1' }),
    row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'transient', paymentId: 'pay-1' }),
  ])
  assert.equal(aggregatePaymentSyncRows(overtaken)!.status, 'SYNCED')

  const stillBroken = effectivePaymentSyncRows([
    row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'rejected', paymentId: 'pay-2' }),
    row({ status: 'SYNCED', externalTransactionId: 'PAY-9', amount: 40, paymentId: 'pay-1' }),
  ])
  assert.equal(aggregatePaymentSyncRows(stillBroken)!.status, 'FAILED')
})

test('a row the invoice follow-up queued is never dropped as someone else\'s deleted receipt', () => {
  // It carries no payment id because it belongs to the ORDER, not to a local receipt — "was its receipt
  // deleted" cannot be asked of it, and dropping it would hide a real imported-payment failure.
  const rows = effectivePaymentSyncRows(
    [row({ status: 'FAILED', externalTransactionId: null, errorMessage: 'no bank account', paymentId: null })],
    { livePaymentIds: new Set<string>() },
  )
  assert.equal(rows.length, 1)
})

test('with no live-payment set known, nothing is dropped for ownership', () => {
  // The bill side passes rows without payment ids at all; it must behave exactly as before.
  const rows = effectivePaymentSyncRows([row({ status: 'CANCELLED', externalTransactionId: null, paymentId: 'pay-1' })])
  assert.equal(rows.length, 1)
})

test('a ledger that recorded MORE than IMS claims is over-paid, not settled', () => {
  // Only the shortfall was checked, so a larger ledger amount fell through to a green SETTLED. Reachable
  // after a synced receipt is deleted and a smaller correction recorded: the ledger keeps the larger
  // payment and the correction is refused as a second live registration.
  const v = settlementStatus({ ...base, payment: row({ externalTransactionId: 'PAY-1', amount: 100 }), totalForeign: 40 })
  assert.equal(v.status, 'OVER_SETTLED')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /OVER-paid/)
})

test('an exact settlement inside the rounding tolerance is still settled', () => {
  const v = settlementStatus({ ...base, payment: row({ externalTransactionId: 'PAY-1', amount: 100.004 }), totalForeign: 100 })
  assert.equal(v.status, 'SETTLED')
  assert.equal(v.discrepancy, false)
})

// ---------------------------------------------------------------------------
// o3d-nf9i r3, Codex finding 1 — AN OPERATOR ASSERTION IS NOT A LEDGER CONFIRMATION.
//
// settleAccountingSyncRow lets a human record "this DID post, here is the document id". That writes
// status=SYNCED + externalTransactionId, which is byte-identical to what the connector's own
// writeback produces after a real, successful call. The verdict below is the money-path reader of
// that column pair, and it used to compare `p.amount` (what IMS INTENDED to send) against the
// document total and return a green SETTLED when the two agreed.
//
// On an asserted row those two numbers agreeing proves only that the assertion is self-consistent.
// Xero accepts a payment smaller than the invoice as a PART payment and hands back a perfectly valid
// payment id, so the asserted id can name a part payment while IMS's local figures match exactly.
// The comparison is monetary-only, and a monetary-only comparison on an unverified basis must FAIL
// CLOSED — which is what the basis marker is for.
// ---------------------------------------------------------------------------

test('an operator-asserted payment whose amount MATCHES the total is NOT settled — it is ASSERTED_UNVERIFIED', () => {
  // The fixture can reach the defect: this is exactly the shape the settlement action writes on a
  // POSTED assertion (SYNCED, an id, and the payload amount the row was queued with), and 100 === 100
  // is the branch that returned `SETTLED, discrepancy: false` before the basis was read.
  const v = settlementStatus({
    ...base,
    payment: row({ amount: 100, settlementBasis: 'OPERATOR_ASSERTION' }),
    totalForeign: 100,
  })
  assert.equal(v.status, 'ASSERTED_UNVERIFIED')
  assert.equal(v.basis, 'OPERATOR_ASSERTION')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /never made the call/)
  assert.match(v.detail, /PAY-1/)
  // The remedy is nameable and an operator can perform it — no refusal may be a dead end.
  assert.match(v.detail, /confirm its amount against the/)
})

test('the SAME row with the connector as its basis is still SETTLED — the guard is the basis, not the amount', () => {
  // The other half of the pair: identical figures, identical id, only the basis differs. Without
  // this, "fail closed" could be satisfied by breaking full settlement for everybody.
  const v = settlementStatus({ ...base, payment: row({ amount: 100 }), totalForeign: 100 })
  assert.equal(v.status, 'SETTLED')
  assert.equal(v.basis, 'LEDGER_CONFIRMED')
  assert.equal(v.discrepancy, false)
})

test('a part payment the CONNECTOR posted is still reported on its figures, not swallowed by the basis check', () => {
  const v = settlementStatus({ ...base, payment: row({ amount: 1 }), totalForeign: 1000 })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
  assert.equal(v.basis, 'LEDGER_CONFIRMED')
  assert.match(v.detail, /PART payment of 1 against a total of 1000/)
})

test('one ASSERTED leg among several makes the whole aggregate unverified — the marker survives aggregation', () => {
  // Reachable: a sales order carries several INVOICE_PAYMENT rows (part payments, a manual receipt on
  // top of an imported one). aggregatePaymentSyncRows reduces them to ONE row, and dropping the basis
  // there would have re-laundered the assertion one function further along — the aggregate would have
  // arrived at settlementStatus looking connector-confirmed.
  const aggregate = aggregatePaymentSyncRows([
    { status: 'SYNCED', externalTransactionId: 'PAY-2', amount: 60, settlementBasis: 'OPERATOR_ASSERTION' },
    { status: 'SYNCED', externalTransactionId: 'PAY-1', amount: 40 },
  ])
  assert.ok(aggregate)
  assert.equal(aggregate.settlementBasis, 'OPERATOR_ASSERTION')
  assert.equal(aggregate.amount, 100)
  const v = settlementStatus({ ...base, payment: aggregate, totalForeign: 100 })
  assert.equal(v.status, 'ASSERTED_UNVERIFIED')
  assert.equal(v.basis, 'OPERATOR_ASSERTION')
})

test('an aggregate of purely connector-confirmed legs carries NO assertion basis', () => {
  const aggregate = aggregatePaymentSyncRows([
    { status: 'SYNCED', externalTransactionId: 'PAY-2', amount: 60 },
    { status: 'SYNCED', externalTransactionId: 'PAY-1', amount: 40 },
  ])
  assert.ok(aggregate)
  assert.equal(aggregate.settlementBasis, null)
  assert.equal(settlementStatus({ ...base, payment: aggregate, totalForeign: 100 }).status, 'SETTLED')
})

test('an asserted payment against a document IMS does NOT show as paid names the assertion, not the ledger', () => {
  // The disagreement pointing the other way. Before the basis was carried, this told the operator the
  // ledger held a payment — when all that exists is a colleague's statement that it does.
  const v = settlementStatus({
    paidLocally: false,
    syncEnabled: true,
    documentPosted: true,
    payment: row({ amount: 100, settlementBasis: 'OPERATOR_ASSERTION' }),
    totalForeign: 100,
  })
  assert.equal(v.status, 'LEDGER_UNMATCHED')
  assert.equal(v.basis, 'OPERATOR_ASSERTION')
  assert.match(v.detail, /OPERATOR ASSERTION, not something the ledger confirmed/)
})

test('an asserted SYNCED row with no document id is still the unverifiable case, and says which basis', () => {
  const v = settlementStatus({
    ...base,
    payment: row({ externalTransactionId: null, amount: 100, settlementBasis: 'OPERATOR_ASSERTION' }),
    totalForeign: 100,
  })
  assert.equal(v.status, 'AWAITING_LEDGER')
  assert.equal(v.basis, 'OPERATOR_ASSERTION')
  assert.equal(v.discrepancy, true)
})
