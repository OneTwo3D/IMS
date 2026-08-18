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
          { PaymentID: 'PAY-1', Date: '/Date(1785542400000+0000)/', Amount: 10, Reference: 'IMS-abc123abc123' },
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
      { amount: 10, date: '2026-08-01', id: 'PAY-1', reference: 'IMS-abc123abc123' },
      { amount: 25, date: '2026-07-01', id: 'PAY-2', reference: null },
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
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', reference: null }] },
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
        PrivateNote: 'IMS-deadbeef0000',
        Line: [
          { Amount: 10, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] },
          { Amount: 490, LinkedTxn: [{ TxnId: 'inv-OTHER', TxnType: 'Invoice' }] },
        ],
      },
    },
  })

  const probe = await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)

  assert.deepEqual(calls, [{ path: 'invoice/inv-1' }, { path: 'payment/55' }], 'the Estimate link is not a settlement')
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', id: '55', reference: 'IMS-deadbeef0000' }] },
    'and PrivateNote is carried through as the mark')
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

/**
 * o3d-0m56 round 4, Codex CRITICAL #1 — THE LINK TYPE QUICKBOOKS ACTUALLY WRITES.
 *
 * The entity is `BillPayment`; the link recorded on the Bill is named after the PayType, so IMS's
 * own `PayType: 'Check'` posts land as `BillPaymentCheck`. The probe matched `BillPayment` and
 * therefore matched NONE of the bill payments this system has ever made — it returned an empty
 * record list, which the classifier reads as `clear`, which the fence reads as permission to pay
 * the bill again. The fixture below used the wrong spelling too, so the test passed on a shape
 * QuickBooks does not produce.
 */
test('quickbooks: a REAL bill payment is recorded as BillPaymentCheck, and is found (o3d-0m56)', async () => {
  const { get, calls } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 10, Balance: 0, LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }] } },
    'billpayment/77': {
      BillPayment: { TxnDate: '2026-08-01', PrivateNote: 'IMS-abc123abc123', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
    },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.deepEqual(calls, [{ path: 'bill/bill-1' }, { path: 'billpayment/77' }],
    'the link says BillPaymentCheck; the entity is still read from /billpayment')
  assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', id: '77', reference: 'IMS-abc123abc123' }] })
})

test('quickbooks: a credit-card bill payment is found too, and the bare entity name still works (o3d-0m56)', async () => {
  for (const linkType of ['BillPaymentCreditCard', 'BillPayment']) {
    const { get } = qboDouble({
      'bill/bill-1': { Bill: { TotalAmt: 10, Balance: 0, LinkedTxn: [{ TxnId: '77', TxnType: linkType }] } },
      'billpayment/77': {
        BillPayment: { TxnDate: '2026-08-01', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
      },
    })
    const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
    assert.deepEqual(probe, { ok: true, records: [{ amount: 10, date: '2026-08-01', id: '77', reference: null }] }, linkType)
  }
})

test('quickbooks: a link type nobody has classified fails the probe (o3d-0m56)', async () => {
  // The structural answer to "a payment shape was missed, twice". An unrecognised link is a
  // settlement the probe cannot account for, and dropping it silently is exactly how a blind
  // probe reports a clear. It is now an `unknown`, which every caller refuses on.
  const { get } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 10, Balance: 10, LinkedTxn: [{ TxnId: '99', TxnType: 'BillPaymentSomethingNew' }] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /BillPaymentSomethingNew/,
    'and it must name the type, or nobody can classify it')
})

test('quickbooks: links that carry NO money off the document are ignored, not refused (o3d-0m56)', async () => {
  // The other half of the rule. A bill raised from a purchase order is ordinary, and refusing on
  // it would make every such document unpayable through IMS — a self-inflicted outage, not a
  // safety property. The discriminator is the document's own balance: nothing has come off it.
  const { get, calls } = qboDouble({
    'bill/bill-1': {
      Bill: { TotalAmt: 100, Balance: 100, LinkedTxn: [{ TxnId: '5', TxnType: 'PurchaseOrder' }] },
    },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.deepEqual(probe, { ok: true, records: [] })
  assert.deepEqual(calls, [{ path: 'bill/bill-1' }], 'and it is not fetched — it is not the shape IMS posts')
})

/**
 * o3d-0m56 round 5, Codex HIGH #3 — RECOGNISED IS NOT ACCOUNTED FOR.
 *
 * Round 4 ignored credit memos, vendor credits, deposits and journal entries because they are not
 * the shape IMS posts, and returned `records: []` — which the classifier reads as `clear` and the
 * fence acts on. But those links SETTLE the document: an operator who clears a bill with a
 * journal entry has paid it, and a probe that answers "clear" to that is not out of scope, it is
 * wrong. An unrecognised type already fails closed; a recognised-but-uncovered one now fails
 * closed too, whenever the document's own numbers say money has actually come off it.
 */
test('quickbooks: each recognised-but-uncovered settlement type is NOT reported as clear (o3d-0m56 r5, HIGH 3)', async () => {
  // Each type is put on the document kind QuickBooks actually links it to — vendor credits and
  // expenses onto a Bill, credit memos and deposits onto an Invoice — because a fixture that
  // tests a shape the ledger never produces is how round 4's `BillPayment`/`BillPaymentCheck` bug
  // survived a passing test.
  const cases: Array<[type: string, kind: 'Bill' | 'Invoice']> = [
    ['VendorCredit', 'Bill'], ['Check', 'Bill'], ['Expense', 'Bill'], ['JournalEntry', 'Bill'],
    ['CreditCardCredit', 'Bill'], ['Purchase', 'Bill'],
    ['CreditMemo', 'Invoice'], ['Deposit', 'Invoice'], ['JournalEntry', 'Invoice'],
    ['RefundReceipt', 'Invoice'], ['Transfer', 'Invoice'],
  ]
  for (const [linkType, kind] of cases) {
    const isBill = kind === 'Bill'
    const documentId = isBill ? 'bill-1' : 'inv-1'
    const { get } = qboDouble({
      [`${isBill ? 'bill' : 'invoice'}/${documentId}`]: {
        [kind]: { TotalAmt: 100, Balance: 40, LinkedTxn: [{ TxnId: '6', TxnType: linkType }] },
      },
    })
    const probe = await probeQuickBooksSettlement(
      { type: isBill ? 'BILL_PAYMENT' : 'INVOICE_PAYMENT', payload: { accountingInvoiceId: documentId } },
      get,
    )
    const label = `${linkType} on a ${kind.toLowerCase()}`
    assert.equal(probe.ok, false, `${label} took 60.00 off it; reporting clear would pay it twice`)
    assert.match(probe.ok === false ? probe.reason : '', new RegExp(linkType), `${label}: name what it cannot account for`)
    assert.match(probe.ok === false ? probe.reason : '', /60\.00 already applied/, label)
  }
})

test('quickbooks: an uncovered link that took NOTHING off the document changes no verdict (o3d-0m56 r5)', async () => {
  // The cost is kept proportionate by arithmetic rather than by vocabulary: a credit memo linked
  // to a document whose balance is untouched has settled nothing, so there is nothing to fail
  // closed about.
  const { get } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 100, Balance: 100, LinkedTxn: [{ TxnId: '6', TxnType: 'VendorCredit' }] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.deepEqual(probe, { ok: true, records: [] })
})

test('quickbooks: an uncovered link with NO total or balance to measure it fails the probe (o3d-0m56 r5)', async () => {
  // Without the document's own numbers there is nothing to reconcile the uncovered settlement
  // against, so the probe has a recognised settlement and no way to size it. That is an unknown.
  const { get } = qboDouble({
    'bill/bill-1': { Bill: { LinkedTxn: [{ TxnId: '6', TxnType: 'JournalEntry' }] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /no total or balance/)
})

test('quickbooks: a payment that fully explains the applied amount is still a clear (o3d-0m56 r5)', async () => {
  // The accounting must not refuse the ordinary case: the bill payment IMS itself made accounts
  // for every penny that has come off the bill, so the record list IS the whole picture.
  const { get } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 100, Balance: 40, LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }] } },
    'billpayment/77': {
      BillPayment: { TxnDate: '2026-08-01', Line: [{ Amount: 60, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
    },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.deepEqual(probe, { ok: true, records: [{ amount: 60, date: '2026-08-01', id: '77', reference: null }] })
})

test('quickbooks: money off the document that the payments do not explain fails the probe (o3d-0m56)', async () => {
  // The shape-independent accounting. Everything above depends on a list of type names being
  // right, and the bug this replaces was a list of type names being wrong. TotalAmt and Balance
  // are the document's own account of how much of it has been settled, by any means at all — so
  // the question asked is arithmetic, not vocabulary.
  const { get } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 100, Balance: 40, LinkedTxn: [] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /60\.00 already applied/)

  // And a payment that explains only PART of it is the same short picture.
  const partial = qboDouble({
    'bill/bill-2': { Bill: { TotalAmt: 100, Balance: 40, LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }] } },
    'billpayment/77': {
      BillPayment: { TxnDate: '2026-08-01', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'bill-2', TxnType: 'Bill' }] }] },
    },
  })
  const short = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-2' } }, partial.get)
  assert.equal(short.ok, false)
  assert.match(short.ok === false ? short.reason : '', /only 10\.00 of it is accounted for/)
})

/**
 * o3d-0m56 round 5, Codex HIGH #4 — THE TWO WAYS ROUND THE FAIL-CLOSED.
 *
 * The rule "an unclassified link fails the probe" had two silent exits, and both end in the same
 * place: a settlement the probe knows about is dropped from a list it then reports as complete.
 */
test('quickbooks: a link with NO READABLE TYPE fails the probe (o3d-0m56 r5, HIGH 4)', async () => {
  // Escape one. `type !== ''` excluded it from the unclassified check, and it matched no payment
  // type either, so it was matched by nothing at all — invisible in both directions.
  for (const link of [{ TxnId: '9' }, { TxnId: '9', TxnType: '' }, { TxnId: '9', TxnType: 42 as unknown as string }]) {
    const { get } = qboDouble({
      'bill/bill-1': { Bill: { TotalAmt: 100, Balance: 100, LinkedTxn: [link] } },
    })
    const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
    assert.equal(probe.ok, false, JSON.stringify(link))
    assert.match(probe.ok === false ? probe.reason : '', /\(untyped\)/, 'and it says so, rather than naming nothing')
  }
})

test('quickbooks: a payment link with NO ID fails the probe (o3d-0m56 r5, HIGH 4)', async () => {
  // Escape two. `.filter(Boolean)` dropped it, so a settlement this probe KNOWS exists was left
  // out of the record list — the same shape as the unreadable-settlement refusal, and it has to
  // fail the same way rather than quietly shrinking the list.
  const { get, calls } = qboDouble({
    'bill/bill-1': { Bill: { TotalAmt: 100, Balance: 100, LinkedTxn: [{ TxnType: 'BillPaymentCheck' }] } },
  })
  const probe = await probeQuickBooksSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /BillPayment to this bill with no id/)
  assert.deepEqual(calls, [{ path: 'bill/bill-1' }], 'and nothing is fetched under a blank id')
})

test('xero: a Payments collection short of AmountPaid fails the probe (o3d-0m56)', async () => {
  // The same class of bug on the other connector, checked with data rather than an assumption:
  // AmountPaid is Xero's own total of the very collection being read, so the two must agree. An
  // omitted or truncated collection is indistinguishable from "no payments" without it.
  const { get } = xeroDouble({
    'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 25, Payments: [] }] },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /25\.00 paid.*no payments/)
})

test('xero: AmountPaid agreeing with the collection is not a refusal (o3d-0m56)', async () => {
  const { get } = xeroDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        AmountPaid: 30,
        Payments: [{ PaymentID: 'P1', Date: '2026-08-01', Amount: 10 }, { PaymentID: 'P2', Date: '2026-08-02', Amount: 20 }],
      }],
    },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, true)
  assert.equal(probe.ok === true ? probe.records.length : 0, 2)
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
