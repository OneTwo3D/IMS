import assert from 'node:assert/strict'
import test from 'node:test'

import { probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import { readSingleXeroDocument } from '@/lib/connectors/xero/single-document'
import {
  classifyLedgerSettlement,
  type AttemptDescription,
  type LedgerSettlementProbe,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-h9pb: `readSingleXeroDocument`, and the three settlement-probe arms that read a by-id Xero
 * document through it (Invoices/{id}, CreditNotes/{id}, Payments/{id}).
 *
 * THE LESSON CLASS: unreadable state is not empty state. A different, untouched document read in place
 * of the requested one reads as "nothing settled here" and classifies CLEAR, which authorises a money
 * post a second time. Every arm below therefore asserts two things about a bad answer: the probe is
 * `ok: false`, and the classifier does not call it `clear`.
 *
 * Each section prints its case count and asserts it, so a table edited down to nothing fails loudly.
 */

/* ------------------------------ the helper itself ------------------------------ */

const GOOD = { InvoiceID: 'INV-1', Total: 10 }

test('helper: the correct document is found, whatever the case or padding of the id', () => {
  let cases = 0
  for (const requested of ['INV-1', 'inv-1', '  INV-1  ']) {
    const read = readSingleXeroDocument<typeof GOOD>({ Invoices: [GOOD] }, 'Invoices', 'InvoiceID', requested)
    assert.equal(read.status, 'found', requested)
    assert.equal(read.status === 'found' ? read.document.Total : null, 10)
    cases += 1
  }
  // and the id on the wire may be the one with different case
  const lowered = readSingleXeroDocument({ Invoices: [{ InvoiceID: 'inv-1' }] }, 'Invoices', 'InvoiceID', 'INV-1')
  assert.equal(lowered.status, 'found')
  cases += 1
  assert.equal(cases, 4)
  console.log(`# helper: ${cases} found cases`)
})

test('helper: every other shape is UNREADABLE with a named problem — there is no "absent" outcome', () => {
  const table: Array<[string, unknown, string, number | null]> = [
    ['wrong id', { Invoices: [{ InvoiceID: 'INV-2' }] }, 'id-mismatch', 1],
    ['empty array', { Invoices: [] }, 'no-document', 0],
    ['multiple documents', { Invoices: [GOOD, { InvoiceID: 'INV-2' }] }, 'multiple-documents', 2],
    ['multiple, both the right id', { Invoices: [GOOD, GOOD] }, 'multiple-documents', 2],
    ['missing key', {}, 'missing-key', null],
    ['key is null', { Invoices: null }, 'missing-key', null],
    ['key is not a list', { Invoices: 'x' }, 'malformed-body', null],
    ['key is an object', { Invoices: GOOD }, 'malformed-body', null],
    ['malformed body (string)', 'nope', 'malformed-body', null],
    ['malformed body (array)', [GOOD], 'malformed-body', null],
    ['null', null, 'malformed-body', null],
    ['undefined', undefined, 'malformed-body', null],
    ['document is not an object', { Invoices: ['INV-1'] }, 'malformed-document', 1],
    ['document is null', { Invoices: [null] }, 'malformed-document', 1],
    ['document states no id', { Invoices: [{ Total: 10 }] }, 'id-missing', 1],
    ['document id is not a string', { Invoices: [{ InvoiceID: 1 }] }, 'id-missing', 1],
    ['document id is blank', { Invoices: [{ InvoiceID: '  ' }] }, 'id-missing', 1],
  ]
  for (const [name, body, problem, count] of table) {
    const read = readSingleXeroDocument(body, 'Invoices', 'InvoiceID', 'INV-1')
    assert.equal(read.status, 'unreadable', name)
    if (read.status !== 'unreadable') continue
    assert.equal(read.problem, problem, name)
    assert.equal(read.count, count, name)
    assert.ok(read.reason.length > 0, `${name}: carries a reason`)
  }
  const mismatch = readSingleXeroDocument({ Invoices: [{ InvoiceID: 'INV-2' }] }, 'Invoices', 'InvoiceID', 'INV-1')
  assert.equal(mismatch.status === 'unreadable' ? mismatch.returnedId : null, 'INV-2', 'names what came back instead')
  for (const requested of ['', '   ']) {
    const none = readSingleXeroDocument({ Invoices: [GOOD] }, 'Invoices', 'InvoiceID', requested)
    assert.equal(none.status === 'unreadable' ? none.problem : null, 'no-requested-id',
      'a request that named nothing can match nothing, even a document that names nothing')
  }
  assert.equal(table.length, 17)
  console.log(`# helper: ${table.length} unreadable cases + 2 no-requested-id cases`)
})

/* --------------------------- the settlement-probe arms --------------------------- */

function ledgerDouble(responses: Record<string, unknown>) {
  const get = async <T>(path: string) => {
    const body = responses[path]
    if (!(path in responses)) return { ok: false, status: 404, error: 'not stubbed' }
    return { ok: true, status: 200, data: body as T }
  }
  return { get }
}

const attempt = (amount: string): AttemptDescription =>
  ({ amount: toDecimal(amount), currency: 'GBP', date: '2026-08-01', marker: null })

function shapes(key: string, idField: string, id: string, good: Record<string, unknown>) {
  return [
    { name: 'wrong id', body: { [key]: [{ ...good, [idField]: `OTHER-${id}` }] } },
    { name: 'empty array', body: { [key]: [] } },
    { name: 'multiple documents', body: { [key]: [good, { ...good, [idField]: `OTHER-${id}` }] } },
    { name: 'missing key', body: {} },
    { name: 'malformed body', body: 'not-an-object' },
    { name: 'null', body: null },
  ]
}

/** An unsettled invoice: the wrong-id body is a DIFFERENT, untouched one, so it would prove "clear". */
const INVOICE = { InvoiceID: 'inv-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0, Payments: [] }

test('[o3d-h9pb probe arm Invoices/{id}] an unreadable answer is UNKNOWN, never an empty settled record', async () => {
  const target = { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } } as const
  const control = await probeXeroSettlement(target, ledgerDouble({ 'Invoices/inv-1': { Invoices: [INVOICE] } }).get)
  assert.equal(control.ok, true, 'PRECONDITION: the correct document reads')
  assert.equal(classifyLedgerSettlement(attempt('100.00'), control).outcome, 'clear', 'PRECONDITION: and an unsettled invoice IS clear')

  let cases = 0
  for (const shape of shapes('Invoices', 'InvoiceID', 'inv-1', INVOICE)) {
    const probe = await probeXeroSettlement(target, ledgerDouble({ 'Invoices/inv-1': shape.body }).get) as LedgerSettlementProbe
    assert.equal(probe.ok, false, `${shape.name}: ${JSON.stringify(probe)}`)
    assert.notEqual(classifyLedgerSettlement(attempt('100.00'), probe).outcome, 'clear', `${shape.name}: must not authorise a post`)
    assert.equal(classifyLedgerSettlement(attempt('100.00'), probe).outcome, 'unknown', shape.name)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb probe Invoices/{id}: ${cases} unreadable cases + 1 correct-document control`)
})

const NOTE = { CreditNoteID: 'cn-1', CurrencyCode: 'GBP', Total: 40, RemainingCredit: 40, Allocations: [] }

test('[o3d-h9pb probe arm CreditNotes/{id}] an unreadable answer is UNKNOWN, never an unallocated credit note', async () => {
  const target = { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } } as const
  const control = await probeXeroSettlement(target, ledgerDouble({ 'CreditNotes/cn-1': { CreditNotes: [NOTE] } }).get)
  assert.equal(control.ok, true, 'PRECONDITION: the correct document reads')
  assert.equal(classifyLedgerSettlement(attempt('40.00'), control).outcome, 'clear', 'PRECONDITION: and an unallocated note IS clear')

  let cases = 0
  for (const shape of shapes('CreditNotes', 'CreditNoteID', 'cn-1', NOTE)) {
    const probe = await probeXeroSettlement(target, ledgerDouble({ 'CreditNotes/cn-1': shape.body }).get) as LedgerSettlementProbe
    assert.equal(probe.ok, false, `${shape.name}: ${JSON.stringify(probe)}`)
    assert.equal(classifyLedgerSettlement(attempt('40.00'), probe).outcome, 'unknown', shape.name)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb probe CreditNotes/{id}: ${cases} unreadable cases + 1 correct-document control`)
})

test('[o3d-h9pb probe arm Payments/{id}] an unreadable refund lookup is UNKNOWN, never a reversed refund', async () => {
  const target = { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'inv-1' } } as const
  // 100 has come off the 400 and the allocation collection is empty; only a resolved AUTHORISED refund
  // accounts for it. A DIFFERENT payment that states DELETED would make the 100 vanish from the sum.
  const note = { CreditNoteID: 'cn-1', CurrencyCode: 'GBP', Total: 400, RemainingCredit: 300, Allocations: [], Payments: [{ PaymentID: 'PAY-R1', Amount: 100 }] }
  const authorised = { PaymentID: 'PAY-R1', Amount: 100, Status: 'AUTHORISED', PaymentType: 'APCREDITPAYMENT' }
  const respond = (payments: unknown) => ledgerDouble({ 'CreditNotes/cn-1': { CreditNotes: [note] }, 'Payments/PAY-R1': payments }).get
  const control = await probeXeroSettlement(target, respond({ Payments: [authorised] }))
  assert.equal(control.ok, true, 'PRECONDITION: the correct payment resolves')
  assert.equal(classifyLedgerSettlement(attempt('300.00'), control).outcome, 'clear', 'PRECONDITION: and the refund is counted')

  let cases = 0
  for (const shape of shapes('Payments', 'PaymentID', 'PAY-R1', authorised)) {
    const probe = await probeXeroSettlement(target, respond(shape.body)) as LedgerSettlementProbe
    assert.equal(probe.ok, false, `${shape.name}: ${JSON.stringify(probe)}`)
    assert.equal(classifyLedgerSettlement(attempt('300.00'), probe).outcome, 'unknown', shape.name)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb probe Payments/{id}: ${cases} unreadable cases + 1 correct-document control`)
})
