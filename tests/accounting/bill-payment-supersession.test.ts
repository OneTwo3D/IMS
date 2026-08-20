import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BILL_PAYMENT_SUPERSEDED_REASON,
  markBillPaidSupersedingStaleRegistrations,
  planBillPaymentSupersession,
} from '@/lib/domain/accounting/payment-reversal'

/**
 * o3d-a3wx. BILL_PAYMENT joined accounting_sync_logs_followup_live_unique, keyed by
 * (connector, type, reference, accountingInvoiceId). markBillPaid only wins the `paidAt: null -> paid`
 * transition when IMS currently holds the bill UNSETTLED — which, if a live BILL_PAYMENT row exists, can
 * only mean the poller's reversal pass cleared paidAt because the payment is gone from the ledger. Left
 * in place that stale row would occupy the slot and refuse the legitimate re-payment: the constraint
 * meant to stop a double payment stranding a real one instead.
 *
 * ROUND 2. The first version retired PENDING, PROCESSING and SYNCED alike. A PROCESSING row is a
 * request that may be ON THE WIRE: cancelling the row frees the index slot and does nothing at all to
 * the call already on its way to Xero, so the replacement posts a SECOND supplier payment. The line
 * between "retire" and "leave alone" is not FAILED-vs-live, it is IN-FLIGHT-vs-not — the same line
 * deletePayment already draws on the sales side, and the same one o3d-sref drew for the orphan sweep.
 */

const PROCESSING_ROW = { id: 'log-inflight', status: 'PROCESSING' }

test('a SYNCED registration for a bill being re-marked paid is superseded', () => {
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'SYNCED' }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede.map((r) => r.id), ['log-1'])
})

test('a PENDING registration is superseded — nothing has been sent, so cancelling it IS the whole event', () => {
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'PENDING' }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede.map((r) => r.id), ['log-1'])
})

test('an IN-FLIGHT (PROCESSING) registration is refused, not superseded (round 2 #1)', () => {
  // THE DEFECT THIS CLOSES. Round 1 returned this row as superseded; cancelling it freed the live-row
  // slot while the worker's POST /Payments was still on its way to Xero, and the replacement queued
  // behind it registered the supplier payment a SECOND time.
  const plan = planBillPaymentSupersession([PROCESSING_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_IN_FLIGHT')
  assert.deepEqual(plan.proceed === false && plan.inFlight.map((r) => r.id), ['log-inflight'])
})

test('one in-flight row blocks the whole plan, even alongside retirable ones', () => {
  // Retiring the PENDING sibling would free the slot just as effectively as retiring the PROCESSING
  // one, so the refusal has to be about the BILL, not about each row.
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'PENDING' }, PROCESSING_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_IN_FLIGHT')
})

test('FAILED and CANCELLED rows are left exactly as they are', () => {
  // They are already outside the live predicate, so they block nothing — and rewriting a FAILED row as
  // CANCELLED would erase the fact that the ledger rejected it, which is the evidence an operator needs
  // and which the "FAILED does not prove nothing posted" reading (o3d-ju8t) depends on.
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'FAILED' }, { id: 'log-2', status: 'CANCELLED' }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede, [])
})

// ---------------------------------------------------------------------------
// DB WIRING. Round 1 tested only the pure predicate, so nothing checked that the paidAt write and the
// retirement happen in ONE transaction, that the retirement is status-fenced, or that a refusal reaches
// the caller at all. These drive the real function against a recording transaction client.
// ---------------------------------------------------------------------------

type SyncRow = { id: string; status: string }

function mockTx(rows: SyncRow[], options: { paidCount?: number; retiredCount?: number; afterRetire?: SyncRow[] } = {}) {
  const calls = {
    syncFindMany: [] as Array<Record<string, unknown>>,
    syncUpdateMany: [] as Array<{ where?: unknown; data?: unknown }>,
    invoiceUpdateMany: [] as Array<{ where?: unknown; data?: unknown }>,
  }
  let findManyCount = 0
  const tx = {
    accountingSyncLog: {
      findMany: async (args: Record<string, unknown>) => {
        calls.syncFindMany.push(args)
        findManyCount += 1
        // The first read is the survey; a second read only happens on the fenced-write shortfall path
        // and asks specifically for rows that are now in flight.
        return findManyCount === 1 ? rows : (options.afterRetire ?? [])
      },
      updateMany: async (args: { where?: unknown; data?: unknown }) => {
        calls.syncUpdateMany.push(args)
        return { count: options.retiredCount ?? rows.filter((r) => r.status === 'PENDING' || r.status === 'SYNCED').length }
      },
    },
    purchaseInvoice: {
      updateMany: async (args: { where?: unknown; data?: unknown }) => {
        calls.invoiceUpdateMany.push(args)
        return { count: options.paidCount ?? 1 }
      },
    },
  }
  return { tx, calls }
}

const PARAMS = {
  invoiceId: 'inv-1',
  paidAt: new Date('2026-08-20T10:00:00.000Z'),
  paymentAccountId: 'acct-1',
  paymentAccountName: 'Barclays GBP',
  paymentReference: 'PAY-1',
}

test('an in-flight registration refuses BEFORE the bill is written as paid', async () => {
  // THE WHOLE POINT. If the paidAt write happened first, the bill would be PAID in IMS with a payment
  // in flight and nothing queued — either a double payment (round 1) or a stranded one.
  const { tx, calls } = mockTx([PROCESSING_ROW])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'payment-in-flight')
  assert.deepEqual(result.outcome === 'payment-in-flight' && result.inFlightIds, ['log-inflight'])
  assert.equal(calls.invoiceUpdateMany.length, 0, 'the bill must NOT be written as paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'the in-flight row must NOT be cancelled')
})

test('with nothing in flight, the bill is marked paid and the stale rows are retired under a status fence', async () => {
  const { tx, calls } = mockTx([{ id: 'log-1', status: 'SYNCED' }, { id: 'log-2', status: 'PENDING' }])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'paid')
  assert.equal(result.outcome === 'paid' && result.retiredCount, 2)
  // The paidAt write is itself a compare-and-swap on `paidAt: null`.
  assert.deepEqual(calls.invoiceUpdateMany[0].where, { id: 'inv-1', paidAt: null })
  // The retirement names the statuses it read, so a row claimed in between is NOT swept up.
  assert.deepEqual(calls.syncUpdateMany[0].where, {
    id: { in: ['log-1', 'log-2'] },
    status: { in: ['PENDING', 'SYNCED'] },
  })
  assert.equal((calls.syncUpdateMany[0].data as { status: string }).status, 'CANCELLED')
  assert.equal((calls.syncUpdateMany[0].data as { errorMessage: string }).errorMessage, BILL_PAYMENT_SUPERSEDED_REASON)
})

test('a row claimed between the survey and the fenced write is reported as in flight, not silently skipped', async () => {
  // The read is not FOR UPDATE, so a worker can take the PENDING row in between. The fenced update then
  // matches fewer rows than asked for, and that shortfall is the only signal that it happened.
  const { tx, calls } = mockTx(
    [{ id: 'log-1', status: 'PENDING' }],
    { retiredCount: 0, afterRetire: [{ id: 'log-1', status: 'PROCESSING' }] },
  )

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'payment-in-flight')
  assert.deepEqual(result.outcome === 'payment-in-flight' && result.inFlightIds, ['log-1'])
  // The caller rolls the transaction back on this outcome, which is what undoes the paidAt write below.
  assert.equal(calls.invoiceUpdateMany.length, 1)
})

test('a row that went FAILED on its own between the survey and the write does NOT refuse the payment', async () => {
  // A shortfall is not automatically a refusal: a row that left the live predicate by itself holds
  // nothing, and treating that as in-flight would strand a legitimate re-payment.
  const { tx } = mockTx([{ id: 'log-1', status: 'PENDING' }], { retiredCount: 0, afterRetire: [] })

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'paid')
})

test('losing the paidAt compare-and-swap reports already-paid and retires nothing', async () => {
  const { tx, calls } = mockTx([{ id: 'log-1', status: 'PENDING' }], { paidCount: 0 })

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'already-paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'a bill we did not transition is not ours to retire rows for')
})
