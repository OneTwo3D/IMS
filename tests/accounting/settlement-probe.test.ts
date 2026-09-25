import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  normaliseXeroSettlementDate,
  probeLedgerSettlement,
  probeXeroSettlement,
  settlementProbeKey,
} from '@/lib/connectors/accounting-settlement-probe'
// o3d-78rq: a settlement record's amount is the ledger's EXACT stated figure now, not its wire
// double, so every expectation below states the same figure as a Decimal.
import { toDecimal } from '@/lib/domain/math/decimal'

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
        // o3d-obyd r31: the invoice's own figures, which Xero returns on every invoice. Without them
        // nothing measures the Payments collection, so the probe cannot report it as the whole of it.
        Total: 100,
        AmountDue: 65,
        AmountPaid: 35,
        AmountCredited: 0,
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
    provedComplete: true,
    records: [
      { amount: toDecimal(10), date: '2026-08-01', id: 'PAY-1', reference: 'IMS-abc123abc123' },
      { amount: toDecimal(25), date: '2026-07-01', id: 'PAY-2', reference: null },
    ],
  })
})

test('xero: a bill payment reads the same endpoint, and an unknown id fails closed (o3d-0m56)', async () => {
  // o3d-nk5n: the document STATES that nothing has settled it — `Total` and `AmountDue` equal, as
  // Xero returns them on every bill that exists. It used to be the bare stub `{ InvoiceID: 'bill-1' }`,
  // which said nothing at all, and the clear below was then drawn from having read no figure rather
  // than from a figure that says zero. Same verdict, now on evidence.
  const { get } = xeroDouble({
    'Invoices/bill-1': { Invoices: [{ InvoiceID: 'bill-1', CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0 }] },
  })
  assert.deepEqual(
    await probeXeroSettlement({ type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get),
    { ok: true, provedComplete: true, records: [] },
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
        // o3d-obyd r31: `Total - RemainingCredit` is the note's own account of how much of it has
        // been used, and it is what proves the Allocations collection whole — 109 across both bills.
        Total: 200,
        RemainingCredit: 91,
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
  assert.deepEqual(probe, { ok: true, provedComplete: true, records: [{ amount: toDecimal(10), date: '2026-08-01', reference: null }] },
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

// o3d-remove-parked-connectors: the QuickBooks arm of this file is DELETED with the connector.
// `probeQuickBooksSettlement` and its fixtures are archived; the cases that drove them were the
// twin of every Xero case here, and several of them ("all THREE arms read a string figure", "the rule
// is ONE function, and all three arms reach it") were the ONLY assertions that the rule was reached
// by more than one arm. That evidence is gone. What the rules themselves protect — string-typed money
// (o3d-obyd), the difference magnitude bound (o3d-mm51), the completeness band (o3d-r948) — is still
// asserted through the Xero arms. Recoverable with the connector:
// `git show archive/quickbooks-connector:<this path>`.

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
/**
 * o3d-0m56 round 5, Codex HIGH #4 — THE TWO WAYS ROUND THE FAIL-CLOSED.
 *
 * The rule "an unclassified link fails the probe" had two silent exits, and both end in the same
 * place: a settlement the probe knows about is dropped from a list it then reports as complete.
 */
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
  // ...and one document written in two cases is ONE cached reading (round 7, HIGH 2). A Xero id is
  // a GUID: keeping case here would have made the actions probe the same invoice twice and — worse
  // — take two different money-post locks on it, since both come from this key.
  const GUID = '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44'
  assert.equal(key('BILL_PAYMENT', { accountingInvoiceId: GUID }), key('BILL_PAYMENT', { accountingInvoiceId: GUID.toUpperCase() }))
  // But the parts still cannot run together: as one space-delimited string these were equal, and a
  // cache key that collapses two documents hands one of them the other's ledger reading.
  assert.notEqual(
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a b', creditNoteId: 'c' }),
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'b c' }),
  )
})

/* ------------------------------------------------------------------------------------------- *
 * o3d-0m56 round 6, finding 3 — what Xero CAN and CANNOT see, and the arithmetic that says so.
 * ------------------------------------------------------------------------------------------- */

test('xero: a credit note Xero reports as APPLIED must not read as unallocated (o3d-0m56 r6, HIGH 3)', async () => {
  // `Allocations` absent and `Allocations` empty are one value in JavaScript, and this branch had
  // no cross-check at all. `Total - RemainingCredit` is Xero's own account of how much of the
  // credit has been used, so the collection has to add up to it or the picture is incomplete.
  const { get } = xeroDouble({ 'CreditNotes/cn-1': { CreditNotes: [{ CreditNoteID: 'cn-1', Total: 40, RemainingCredit: 0 }] } })
  const probe = await probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } },
    get,
  )
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /40\.00 of this credit note already applied but returned no allocations/)
})

test('xero: allocations to OTHER documents still count towards the credit note\'s own total (o3d-0m56 r6)', async () => {
  // The discriminating half. A credit legitimately offsets several bills, so the completeness test
  // is about the COLLECTION, not about this bill's share of it — otherwise every partly-shared
  // credit note would refuse for ever.
  const { get } = xeroDouble({
    'CreditNotes/cn-1': {
      CreditNotes: [{
        CreditNoteID: 'cn-1',
        Total: 40,
        RemainingCredit: 0,
        Allocations: [
          { Amount: 10, Date: '2026-08-01', Invoice: { InvoiceID: 'bill-1' } },
          { Amount: 30, Date: '2026-08-02', Invoice: { InvoiceID: 'bill-9' } },
        ],
      }],
    },
  })
  const probe = await probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } },
    get,
  )
  assert.deepEqual(probe, { ok: true, provedComplete: true, records: [{ amount: toDecimal(10), date: '2026-08-01', reference: null }] })
})

test('xero: an allocation whose amount cannot be read fails the credit note probe (o3d-0m56 r6)', async () => {
  const { get } = xeroDouble({
    'CreditNotes/cn-1': {
      CreditNotes: [{
        CreditNoteID: 'cn-1',
        Total: 40,
        RemainingCredit: 0,
        Allocations: [{ Date: '2026-08-01', Invoice: { InvoiceID: 'bill-9' } }],
      }],
    },
  })
  const probe = await probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } },
    get,
  )
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /allocation whose amount could not be read/)
})

test('xero: an unapplied credit note with no allocations is a clean, empty answer (o3d-0m56 r6)', async () => {
  const { get } = xeroDouble({ 'CreditNotes/cn-1': { CreditNotes: [{ CreditNoteID: 'cn-1', Total: 40, RemainingCredit: 40, Allocations: [] }] } })
  assert.deepEqual(
    await probeXeroSettlement({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1' } }, get),
    { ok: true, provedComplete: true, records: [] },
  )
})

test('xero: an invoice settled by a CREDIT is not reported as positively empty (o3d-0m56 r6, HIGH 3)', async () => {
  // A credit-note allocation reduces `AmountCredited`, NOT `AmountPaid`, and appears in no
  // `Payments` collection. Reading only those two, a fully credited invoice answers "positively
  // nothing settles this document" — the strongest answer available, and wrong.
  const { get } = xeroDouble({
    'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', Total: 120, AmountDue: 0, AmountPaid: 0, AmountCredited: 120, Payments: [] }] },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /120\.00 already settled against this document/)
  assert.match(probe.ok === false ? probe.reason : '', /120\.00 of it credited, not paid/)
})

test('xero: a credit the response ITEMISES explains itself and changes no verdict (o3d-0m56 r6)', async () => {
  // The discriminating half, and the reason this reads the collections instead of refusing on
  // `AmountCredited > 0`: a part-credited invoice whose credit is accounted for still pays
  // automatically. Prepayment and overpayment allocations are the same shape.
  const { get } = xeroDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        Total: 120,
        AmountDue: 60,
        AmountPaid: 20,
        // o3d-nk5n: 40, not 30. `AmountCredited` is money taken off the document by credit notes,
        // prepayments AND overpayments — the probe's own type says so — so an itemised 30 of credit
        // beside 10 of prepayment is 40 credited. At 30 this body was a response Xero cannot send:
        // `Total - AmountDue` says 60 has settled while `AmountPaid + AmountCredited` says 50, and
        // those are two forms of ONE figure. The primary pair decides this test either way, so the
        // verdict is unchanged; what changes is that the fallback form now agrees with it.
        AmountCredited: 40,
        Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 20 }],
        CreditNotes: [{ AppliedAmount: 30 }],
        Prepayments: [{ AppliedAmount: 10 }],
      }],
    },
  })
  assert.deepEqual(
    await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get),
    { ok: true, provedComplete: true, records: [{ amount: toDecimal(20), date: '2026-08-01', id: 'PAY-1', reference: null }] },
  )
})

test('xero: an applied amount that cannot be READ is not an explanation (o3d-0m56 r6)', async () => {
  // An unknown addend makes the whole sum unknown, and an unknown sum must not be allowed to
  // explain money that has come off a document.
  const { get } = xeroDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        Total: 120,
        AmountDue: 90,
        AmountPaid: 0,
        AmountCredited: 30,
        Payments: [],
        CreditNotes: [{}],
      }],
    },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, false)
  assert.match(probe.ok === false ? probe.reason : '', /could not measure what it holds against it/)
})

test('xero: an ordinary unsettled invoice is still a positive, empty answer (o3d-0m56 r6)', async () => {
  // The arithmetic must not turn every first payment into a refusal — an untouched invoice has
  // nothing to explain.
  const { get } = xeroDouble({
    'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', Total: 120, AmountDue: 120, AmountPaid: 0, AmountCredited: 0, Payments: [] }] },
  })
  assert.deepEqual(
    await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get),
    { ok: true, provedComplete: true, records: [] },
  )
})

test('the probe key is not split by an anchor the TYPE does not have (o3d-0m56 r9, HIGH 1)', () => {
  // This key caches the ledger reading AND keys the money-post lock, so splitting it splits both.
  // A payment is identified by the invoice or bill it pays; `creditNoteId` is not in its request
  // body and is not read back on either connector's payment branch, so a payment row that carries
  // one must share the lock and the reading with one that does not.
  const key = (type: string, payload: unknown) => settlementProbeKey({ type, payload })
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT']) {
    assert.equal(
      key(type, { accountingInvoiceId: 'a', bankAccountId: 'bank-1', amount: 10 }),
      key(type, { accountingInvoiceId: 'a', bankAccountId: 'bank-1', amount: 10, creditNoteId: 'c' }),
      `${type}: one document, one reading`,
    )
  }
  // ...while an allocation still splits on the credit note, which is half of what it settles.
  assert.notEqual(
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'c1' }),
    key('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'c2' }),
  )
})

/* ------------------------------------------------------------------------------------------- *
 * o3d-r948 r6 — THE PROBE NO LONGER SAYS WHOSE LEDGER ANSWERED, BECAUSE IT COULD NOT SAY SOUNDLY.
 *
 * RETIRED HERE, NAMED. Four tests pinned r5's `connectionProvenance`:
 *
 *   [o3d-r948 r5] a settled probe names the organisation that answered
 *   [o3d-r948 r5] a connection that MOVES across the read is reported as unknown, not mislabelled
 *   [o3d-r948 r5] no connected organisation at all is unknown too, not an empty name
 *   [o3d-r948 r5] a token read that FAILS does not destroy the reading of the ledger
 *
 * They were true of what they tested. What they could not test is the interval BETWEEN the two
 * reads: an A→B→A reconnect across the remote call leaves both snapshots saying A while B served
 * the fetch, so the records would be labelled A and could then activate the registration decision's
 * exclusion. Reading one value twice proves nothing about the time between the reads.
 *
 * The exclusion those labels fed is gone (see `classifyLedgerSettlement`), so the unsound label goes
 * with it rather than sitting on the probe result inviting reuse. A sound version is REQUEST-BOUND:
 * `XeroResponse` already carries the `tenantId` its request went out under, and `qboFetch` resolves
 * a `realmId` per request that `QboResponse` discards — and a QuickBooks probe makes 1 + N fetches,
 * so every one of those responses would have to be proven to belong to one realm. bd o3d-llyw.
 * ------------------------------------------------------------------------------------------- */

/** Counts reads of the local `accounting_tokens` row, so "it does not read it" can be asserted. */
const TENANT_CALLS: string[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        findUnique: async ({ where }: { where: { connector: string } }) => {
          TENANT_CALLS.push(where.connector)
          return { tenantId: 'tenant-b' }
        },
      },
    },
  },
})

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({
      ok: true,
      status: 200,
      data: { Invoices: [{ InvoiceID: 'inv-9', Payments: [{ PaymentID: 'PAY-9', Date: '2026-08-01T00:00:00', Amount: 10 }] }] },
    }),
  },
})

const XERO_TARGET = { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-9' } }

test('[o3d-r948 r6] the probe reads the ledger and NOT the token row, and labels nothing', async () => {
  // Asserted as an ABSENCE with a witness, not as a missing property. `assert.equal(probe.x,
  // undefined)` passes for a field that was never spelt correctly; counting the token reads proves
  // the removed code is not merely renamed, and the record assertions prove the probe still did its
  // actual job — so this cannot pass by the probe having failed.
  //
  // ROUTE: probeLedgerSettlement, which now dispatches straight to the connector's own reader.
  // MUTATION (run): restore the `readConnection` helper and the before/after reads and spread
  //        `connectionProvenance` onto the result. The TENANT_CALLS assertion then fails with 2, and
  //        the `'connectionProvenance' in probe` assertion fails too. Reverted after running.
  TENANT_CALLS.length = 0
  const probe = await probeLedgerSettlement('xero', XERO_TARGET)

  // THE PRECONDITION: this is the ordinary success path, with the records the caller needs — so the
  // zero below is "it never asked", not "it never got that far".
  assert.equal(probe.ok, true)
  assert.equal(probe.ok && probe.records.length, 1, 'the records must still come back')
  assert.equal(probe.ok && probe.records[0].id, 'PAY-9')

  assert.equal(TENANT_CALLS.length, 0, 'the probe must not read the active connection at all')
  assert.equal('connectionProvenance' in probe, false, 'and must attach no organisation label')
})

test('[o3d-r948 r6] no caller can ask the probe which organisation answered', async () => {
  // The field is gone from the TYPE as well as from the value, so a caller cannot read it and a
  // future contributor cannot re-add half of it. Asserted on the source because a removed optional
  // property is invisible at runtime on every construction that never set it.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/ledger-settlement-evidence.ts'), 'utf8',
  )
  const at = source.indexOf('export type LedgerSettlementProbe =')
  assert.notEqual(at, -1, 'the probe result type must still be declared here')
  const decl = source.slice(at, source.indexOf('/** What a row', at))
  assert.doesNotMatch(decl, /connectionProvenance\?:/, 'no organisation label on the probe result type')

  const impl = await readFile(
    path.join(process.cwd(), 'lib/connectors/accounting-settlement-probe.ts'), 'utf8',
  )
  assert.doesNotMatch(impl, /activeAccountingIdProvenance/,
    'and the probe must not resurrect a token-snapshot reading — see bd o3d-llyw for what a sound one needs')
})
