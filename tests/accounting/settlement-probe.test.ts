import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normaliseXeroSettlementDate,
  probeQuickBooksSettlement,
  probeXeroSettlement,
  settlementProbeKey,
} from '@/lib/connectors/accounting-settlement-probe'

/**
 * o3d-0m56 — what the two ledgers are actually asked, and what is read back.
 *
 * This is the layer where a false CLEAR is manufactured: read the wrong endpoint, or the wrong
 * field, and the guard above it confidently allows a retry of a payment that is already in the
 * ledger. So every probe is driven against a recorded response shape, and every failure to read
 * one has to surface as `ok: false` rather than as an empty list.
 */

type Call = { path: string }

function xeroDouble(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const get = async <T>(path: string) => {
    calls.push({ path })
    const body = responses[path]
    if (body === undefined) return { ok: false, status: 404, error: 'not stubbed' }
    return { ok: true, status: 200, data: body as T }
  }
  return { get, calls }
}

test('xero reads payments from the SINGLE-invoice endpoint (o3d-0m56)', async () => {
  // Not Invoices?IDs=: Xero omits the Payments collection from a multi-invoice response, and an
  // absent collection would read as "no payments" — a false clear.
  const { get, calls } = xeroDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        Payments: [
          { PaymentID: 'PAY-1', Date: '/Date(1785542400000+0000)/', Amount: 10 },
          { PaymentID: 'PAY-2', Date: '2026-07-01T00:00:00', Amount: 25 },
        ],
      }],
    },
  })

  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)

  assert.deepEqual(calls, [{ path: 'Invoices/inv-1' }])
  assert.deepEqual(probe, {
    ok: true,
    records: [
      { amount: 10, date: '2026-08-01', id: 'PAY-1' },
      { amount: 25, date: '2026-07-01', id: 'PAY-2' },
    ],
  })
})

test('xero: a bill payment reads the same endpoint, and an unknown id fails closed (o3d-0m56)', async () => {
  const { get } = xeroDouble({ 'Invoices/bill-1': { Invoices: [{ InvoiceID: 'bill-1' }] } })
  assert.deepEqual(
    await probeXeroSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get),
    { ok: true, records: [] },
    'a document with no payments is a genuine CLEAR, not an error',
  )

  const missing = await probeXeroSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'nope' } }, get)
  assert.equal(missing.ok, false)

  const empty = xeroDouble({ 'Invoices/gone': { Invoices: [] } })
  const gone = await probeXeroSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'gone' } }, empty.get)
  assert.equal(gone.ok, false, 'a response with no document is not evidence that nothing is settled')
})

test('xero: a credit-note allocation is read from the credit note, filtered to THIS bill (o3d-0m56)', async () => {
  const { get, calls } = xeroDouble({
    'CreditNotes/cn-1': {
      CreditNotes: [{
        CreditNoteID: 'cn-1',
        Allocations: [
          { Amount: 10, Date: '/Date(1785542400000+0000)/', Invoice: { InvoiceID: 'bill-1' } },
          { Amount: 99, Date: '/Date(1785542400000+0000)/', Invoice: { InvoiceID: 'bill-OTHER' } },
        ],
      }],
    },
  })

  const probe = await probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } },
    get,
  )

  assert.deepEqual(calls, [{ path: 'CreditNotes/cn-1' }])
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01' }] },
    'the same credit note legitimately offsets other bills; only this one is evidence')
})

test('xero dates are read in BOTH serialisations, and anything else is unreadable (o3d-0m56)', () => {
  assert.equal(normaliseXeroSettlementDate('/Date(1785542400000+0000)/'), '2026-08-01')
  assert.equal(normaliseXeroSettlementDate('2026-08-01T00:00:00'), '2026-08-01')
  // Taken VERBATIM, not parsed: this instant is 2026-08-02 in UTC, and the date the attempt sent
  // is the one written down. Parsing it would move the settlement a day away from the attempt
  // that created it — on nothing but a timezone — and a settlement that no longer matches reads
  // as CLEAR.
  assert.equal(normaliseXeroSettlementDate('2026-08-01T20:00:00-05:00'), '2026-08-01')
  // Unreadable must be null, which the classifier turns into UNKNOWN — never a silent non-match.
  assert.equal(normaliseXeroSettlementDate('sometime last week'), null)
  assert.equal(normaliseXeroSettlementDate(''), null)
  assert.equal(normaliseXeroSettlementDate(undefined), null)
})

function qboDouble(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const get = async <T>(path: string) => {
    calls.push({ path })
    const body = responses[path]
    if (body === undefined) return { ok: false, status: 404, error: 'not stubbed' }
    return { ok: true, status: 200, data: body as T }
  }
  return { get, calls }
}

test('quickbooks follows the invoice\'s linked payments and measures the APPLIED amount (o3d-0m56)', async () => {
  // TotalAmt would be wrong: one QuickBooks payment can settle several invoices, and IMS's own
  // attempt posts a single line against a single document.
  const { get, calls } = qboDouble({
    'invoice/inv-1': { Invoice: { LinkedTxn: [{ TxnId: '55', TxnType: 'Payment' }, { TxnId: '9', TxnType: 'Estimate' }] } },
    'payment/55': {
      Payment: {
        TxnDate: '2026-08-01',
        TotalAmt: 500,
        Line: [
          { Amount: 10, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] },
          { Amount: 490, LinkedTxn: [{ TxnId: 'inv-OTHER', TxnType: 'Invoice' }] },
        ],
      },
    },
  })

  const probe = await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)

  assert.deepEqual(calls, [{ path: 'invoice/inv-1' }, { path: 'payment/55' }], 'the Estimate link is not a settlement')
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', id: '55' }] })
})

test('quickbooks: a linked settlement it cannot read fails the whole probe (o3d-0m56)', async () => {
  // Dropping it would leave a CLEAR verdict built from an incomplete list — the one outcome that
  // must never be reached by accident.
  const { get } = qboDouble({
    'invoice/inv-1': { Invoice: { LinkedTxn: [{ TxnId: '55', TxnType: 'Payment' }] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /Payment 55/)
})

test('quickbooks: a bill payment reads bill → billpayment (o3d-0m56)', async () => {
  const { get, calls } = qboDouble({
    'bill/bill-1': { Bill: { LinkedTxn: [{ TxnId: '77', TxnType: 'BillPayment' }] } },
    'billpayment/77': {
      BillPayment: { TxnDate: '2026-08-01', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
    },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.deepEqual(calls, [{ path: 'bill/bill-1' }, { path: 'billpayment/77' }])
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', id: '77' }] })
})

test('a row with no document id, and a type QuickBooks cannot answer, both fail closed (o3d-0m56)', async () => {
  const { get } = qboDouble({})
  assert.equal((await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: {} }, get)).ok, false)
  assert.equal((await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: {} }, get)).ok, false)
  assert.equal(
    (await probeQuickBooksSettlement({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { accountingInvoiceId: 'b' } }, get)).ok,
    false,
    'QuickBooks posts no credit-note allocation, so it can offer no evidence about one',
  )
})

test('the probe key separates documents (o3d-0m56)', () => {
  // The actions cache one probe per key. A key that collapsed two documents together would apply
  // one invoice\'s answer to another — a false clear with no symptom.
  const key = (type: string, payload: unknown) => settlementProbeKey({ type, payload })
  assert.notEqual(key('INVOICE_PAYMENT', { accountingInvoiceId: 'a' }), key('INVOICE_PAYMENT', { accountingInvoiceId: 'b' }))
  assert.notEqual(key('INVOICE_PAYMENT', { accountingInvoiceId: 'a' }), key('BILL_PAYMENT', { accountingInvoiceId: 'a' }))
  assert.notEqual(
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'c1' }),
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'c2' }),
  )
  assert.equal(key('INVOICE_PAYMENT', { accountingInvoiceId: 'a' }), key('INVOICE_PAYMENT', { accountingInvoiceId: ' a ' }))
})
