import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-ngmt.21 — DELETE A SYNCED INVOICE OR BILL IN IMS AND XERO TOGETHER: the decision, the Xero side and the hold.
 *
 * The Xero transport is doubled; nothing here reaches the network. The service flows against a real database are in
 * tests/concurrency/xero-document-delete.concurrent.test.ts.
 */

type Call = { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; idempotencyKey?: string }
const calls: Call[] = []
let remote: Record<string, unknown> = {}
/** The next writes fail with this error (consumed one per write). */
const writeFailures: Array<{ error: string; notSent?: string }> = []

function invoiceFromBody(body: unknown): Record<string, unknown> {
  return ((body as { Invoices: Array<Record<string, unknown>> }).Invoices)[0]!
}

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      calls.push({ method: 'GET', path })
      return { ok: true, status: 200, data: { Invoices: [{ ...remote }] } }
    },
    xeroPost: async (path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
      calls.push({ method: 'POST', path, body: invoiceFromBody(body), idempotencyKey: opts?.idempotencyKey })
      const failure = writeFailures.shift()
      if (failure) return { ok: false, status: failure.notSent ? 0 : 500, error: failure.error, ...(failure.notSent ? { notSent: failure.notSent } : {}) }
      // The ledger applies the write to the document it holds, as Xero does.
      remote = { ...remote, ...invoiceFromBody(body), UpdatedDateUTC: '/Date(1763000000000+0000)/' }
      return { ok: true, status: 200, data: { Invoices: [{ ...remote }] } }
    },
  },
})

const ID = 'c1b3a1de-0000-4000-8000-000000000001'

function target(over: Partial<import('@/lib/connectors/xero/document-delete').XeroDeleteTarget> = {}): import('@/lib/connectors/xero/document-delete').XeroDeleteTarget {
  return {
    invoiceId: ID, expectedType: 'ACCREC' as const, originalNumber: 'INV-1001', releasedNumber: 'INV-1001-DEL-K7M2QX',
    originalReference: 'SO-1001', releasedReference: 'SO-1001-DEL-K7M2QX', ...over,
  }
}

function ledgerHolds(over: Record<string, unknown> = {}) {
  calls.length = 0
  writeFailures.length = 0
  remote = { InvoiceID: ID, Type: 'ACCREC', Status: 'AUTHORISED', InvoiceNumber: 'INV-1001', Reference: 'SO-1001', AmountPaid: 0, Payments: [], CreditNotes: [], ...over }
}

const runXeroDocumentDelete: typeof import('@/lib/connectors/xero/document-delete').runXeroDocumentDelete = async (...args) => (await connector()).runXeroDocumentDelete(...args)
const fenceOk = async () => ({ ok: true } as const)
const keys = (step: string) => `key-${step}`
const writes = () => calls.filter((c) => c.method === 'POST')

// ---------------------------------------------------------------------------------------------------------------------------
// THE DECISION
// ---------------------------------------------------------------------------------------------------------------------------

import { decideDocumentDelete, ledgerOwnershipVerdict, type DocumentDeleteFacts } from '@/lib/domain/accounting/document-delete-eligibility'
// The Xero connector module is loaded lazily, AFTER the transport double above is registered (static imports are hoisted above it).
const connector = () => import('@/lib/connectors/xero/document-delete')

const eligibleFacts = (over: Partial<DocumentDeleteFacts> = {}): DocumentDeleteFacts => ({
  kind: 'SALES_INVOICE', featureEnabled: true, label: 'invoice INV-1001', externalDocumentId: ID, documentConnector: 'xero', createdByIms: true,
  deleteInProgress: false, paymentCount: 0, creditNoteCount: 0, documentDate: '2026-11-10', lockDate: '2026-10-31', openPostingTypes: [], ...over,
})

test('an IMS-created, unpaid, unlocked, synced document is eligible', () => {
  assert.deepEqual(decideDocumentDelete(eligibleFacts()), { eligible: true })
  assert.deepEqual(decideDocumentDelete(eligibleFacts({ kind: 'PURCHASE_BILL', label: 'bill SUP-9' })), { eligible: true })
})

test('the switch off refuses first, whatever else is true', () => {
  const verdict = decideDocumentDelete(eligibleFacts({ featureEnabled: false, paymentCount: 2, createdByIms: false }))
  assert.ok(!verdict.eligible && verdict.code === 'FEATURE_OFF')
})

test('payments are refused, in words that send the operator to the accounting system first', () => {
  for (const kind of ['SALES_INVOICE', 'PURCHASE_BILL'] as const) {
    const verdict = decideDocumentDelete(eligibleFacts({ kind, paymentCount: 1 }))
    assert.ok(!verdict.eligible && verdict.code === 'HAS_PAYMENTS')
    assert.match(verdict.reason, /Remove the blocking items in the accounting system first/)
  }
})

test('credit notes, refunds and allocations are refused, in the same words', () => {
  for (const kind of ['SALES_INVOICE', 'PURCHASE_BILL'] as const) {
    const verdict = decideDocumentDelete(eligibleFacts({ kind, creditNoteCount: 2 }))
    assert.ok(!verdict.eligible && verdict.code === 'HAS_CREDIT_NOTES')
    assert.match(verdict.reason, /Remove the blocking items in the accounting system first/)
  }
})

test('a document dated on or before the imported Xero lock date is refused; one dated after it is not; no lock date refuses nothing', () => {
  const locked = (documentDate: string, lockDate: string | null) => decideDocumentDelete(eligibleFacts({ documentDate, lockDate }))
  for (const date of ['2026-10-31', '2026-10-30', '2025-01-01']) {
    const verdict = locked(date, '2026-10-31')
    assert.ok(!verdict.eligible && verdict.code === 'PERIOD_LOCKED', date)
    assert.match(verdict.reason, /2026-10-31/)
  }
  assert.deepEqual(locked('2026-11-01', '2026-10-31'), { eligible: true })
  assert.deepEqual(locked('2020-01-01', null), { eligible: true })
  assert.deepEqual(locked('2020-01-01', ''), { eligible: true })
})

test('a document IMS did not create (a hand link, or the incumbent writer\'s) is refused, as is one in another connector or never pushed', () => {
  assert.ok((() => { const v = decideDocumentDelete(eligibleFacts({ createdByIms: false })); return !v.eligible && v.code === 'NOT_IMS_OWNED' })())
  assert.ok((() => { const v = decideDocumentDelete(eligibleFacts({ documentConnector: 'retired-ledger' })); return !v.eligible && v.code === 'NOT_XERO' })())
  assert.ok((() => { const v = decideDocumentDelete(eligibleFacts({ documentConnector: null })); return !v.eligible && v.code === 'NOT_XERO' })())
  assert.ok((() => { const v = decideDocumentDelete(eligibleFacts({ externalDocumentId: null })); return !v.eligible && v.code === 'NOT_PUSHED' })())
})

test('a delete already queued, or another posting still in flight, is refused', () => {
  assert.ok((() => { const v = decideDocumentDelete(eligibleFacts({ deleteInProgress: true })); return !v.eligible && v.code === 'DELETE_IN_PROGRESS' })())
  const inFlight = decideDocumentDelete(eligibleFacts({ openPostingTypes: ['SALES_INVOICE_UPDATE'] }))
  assert.ok(!inFlight.eligible && inFlight.code === 'POSTING_IN_FLIGHT')
  assert.match(inFlight.reason, /SALES_INVOICE_UPDATE/)
})

// ---------------------------------------------------------------------------------------------------------------------------
// INVOICE-NUMBER OWNERSHIP: the ledger must name THIS document as the holder of the number
// ---------------------------------------------------------------------------------------------------------------------------

const claim = (invoiceId: string, over: Record<string, unknown> = {}) => ({ invoiceId, invoiceNumber: 'INV-1001', status: 'AUTHORISED', type: 'ACCREC', ...over })
const answered = (claims: Array<ReturnType<typeof claim>>) => ({ ok: true as const, claims, tenantId: 'tenant-1' })

test('ownership: the number held by exactly the order\'s own document is IMS\'s; a foreign holder, nobody, several, or an unanswered lookup is refused', () => {
  const ask = (lookup: Parameters<typeof ledgerOwnershipVerdict>[0]['lookup']) => ledgerOwnershipVerdict({ invoiceNumber: 'INV-1001', ownedInvoiceId: ID, orderLabel: 'order SO-1', lookup })
  assert.deepEqual(ask(answered([claim(ID)])), { ok: true, tenantId: 'tenant-1' })
  // The parallel-run case: Xeroom raised the document under this number.
  const foreign = ask(answered([claim('xeroom-doc')]))
  assert.ok(!foreign.ok); assert.match(foreign.reason, /will not delete it/)
  const nobody = ask(answered([]))
  assert.ok(!nobody.ok); assert.match(nobody.reason, /does not hold invoice number INV-1001 under the document IMS recorded/)
  assert.ok(!ask(answered([claim(ID), claim('xeroom-doc')])).ok)
  const unanswered = ask({ ok: false, error: 'HTTP 503' })
  assert.ok(!unanswered.ok); assert.match(unanswered.reason, /nothing was changed/i)
  assert.ok(!ask({ ok: false, error: 'comma', unaskable: true }).ok)
})

// ---------------------------------------------------------------------------------------------------------------------------
// THE XERO SIDE: suffix first, then DELETED or VOIDED; resumable; nothing sent when refused or held
// ---------------------------------------------------------------------------------------------------------------------------


test('the suffix is -DEL- and six random characters, and a token is always six of them', async () => {
  const { newDeleteSuffixToken, releasedDocumentNumber } = await connector()
  assert.equal(releasedDocumentNumber('INV-1001', 'K7M2QX'), 'INV-1001-DEL-K7M2QX')
  const tokens = new Set<string>()
  for (let i = 0; i < 50; i += 1) {
    const token = newDeleteSuffixToken()
    assert.match(token, /^[A-Z2-9]{6}$/)
    tokens.add(token)
  }
  assert.ok(tokens.size > 40, 'the token is random, not constant')
  assert.equal(newDeleteSuffixToken(() => 0), 'AAAAAA')
  assert.equal(newDeleteSuffixToken((max) => max - 1), '999999')
})

test('a DRAFT is renumbered first and then DELETED, in that order', async () => {
  ledgerHolds({ Status: 'DRAFT' })
  const run = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.equal(run.kind, 'done', JSON.stringify(run))
  assert.ok(run.kind === 'done' && run.status === 'DELETED')
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST'])
  assert.deepEqual(writes()[0]!.body, { InvoiceID: ID, InvoiceNumber: 'INV-1001-DEL-K7M2QX', Reference: 'SO-1001-DEL-K7M2QX' })
  assert.deepEqual(writes()[1]!.body, { InvoiceID: ID, Status: 'DELETED' })
  assert.deepEqual(writes().map((w) => w.idempotencyKey), ['key-document-renumber', 'key-document-status'])
})

test('an AUTHORISED document with no payments is renumbered first and then VOIDED, in that order', async () => {
  ledgerHolds({ Status: 'AUTHORISED' })
  const run = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(run.kind === 'done' && run.status === 'VOIDED')
  assert.deepEqual(writes().map((w) => Object.keys(w.body!).filter((k) => k !== 'InvoiceID')), [['InvoiceNumber', 'Reference'], ['Status']])
  assert.equal(writes()[1]!.body!.Status, 'VOIDED')
  assert.equal(remote.InvoiceNumber, 'INV-1001-DEL-K7M2QX')
})

test('a SUBMITTED document is deleted; a supplier bill is addressed as ACCPAY and a bill with no number is not renumbered by number', async () => {
  ledgerHolds({ Status: 'SUBMITTED' })
  const submitted = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(submitted.kind === 'done' && submitted.status === 'DELETED')

  ledgerHolds({ Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceNumber: 'SUP-77', Reference: '' })
  const bill = await runXeroDocumentDelete(target({ expectedType: 'ACCPAY', originalNumber: 'SUP-77', releasedNumber: 'SUP-77-DEL-AAAAAA', originalReference: '', releasedReference: '' }), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(bill.kind === 'done' && bill.status === 'VOIDED')
  assert.deepEqual(writes()[0]!.body, { InvoiceID: ID, InvoiceNumber: 'SUP-77-DEL-AAAAAA' }, 'no Reference to free: none is sent')

  ledgerHolds({ Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceNumber: '', Reference: 'PO-5' })
  const unnumbered = await runXeroDocumentDelete(target({ expectedType: 'ACCPAY', originalNumber: '', releasedNumber: '', originalReference: 'PO-5', releasedReference: 'PO-5-DEL-BBBBBB' }), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(unnumbered.kind === 'done')
  assert.deepEqual(writes()[0]!.body, { InvoiceID: ID, Reference: 'PO-5-DEL-BBBBBB' })
})

test('retry after a partial failure: the number was already freed, so only the status is written and no second suffix is added', async () => {
  ledgerHolds({ Status: 'AUTHORISED' })
  // First attempt: the renumber lands, the void fails.
  const first = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.equal(first.kind, 'done')
  ledgerHolds({ Status: 'AUTHORISED', InvoiceNumber: 'INV-1001-DEL-K7M2QX', Reference: 'SO-1001-DEL-K7M2QX' })
  writeFailures.push({ error: 'HTTP 500' })
  const failed = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.deepEqual(failed, { kind: 'failed', error: 'HTTP 500' })
  // The retry reads the ledger: it carries the released number, so there is NO renumber write.
  calls.length = 0
  const retry = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(retry.kind === 'done' && retry.status === 'VOIDED')
  assert.deepEqual(writes().map((w) => Object.keys(w.body!).filter((k) => k !== 'InvoiceID')), [['Status']])
  assert.equal(remote.InvoiceNumber, 'INV-1001-DEL-K7M2QX', 'the number is the one released suffix, never INV-1001-DEL-K7M2QX-DEL-...')
})

test('when the renumber fails the status is never written; a document already voided or deleted writes nothing and is done', async () => {
  ledgerHolds({ Status: 'AUTHORISED' })
  writeFailures.push({ error: 'HTTP 500' })
  const failed = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.equal(failed.kind, 'failed')
  assert.equal(writes().length, 1, 'only the renumber was attempted')
  assert.equal(remote.Status, 'AUTHORISED')

  for (const Status of ['VOIDED', 'DELETED']) {
    ledgerHolds({ Status, InvoiceNumber: 'INV-1001-DEL-K7M2QX', Reference: 'SO-1001-DEL-K7M2QX' })
    const done = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
    assert.ok(done.kind === 'done' && done.status === Status)
    assert.equal(writes().length, 0)
  }
})

test('refusals from the ledger\'s own state: payments, credit notes, a different document, a different number', async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['paid', { Status: 'PAID', AmountPaid: 10 }, /payment applied in Xero/],
    ['part-paid', { AmountPaid: 5 }, /payment applied in Xero/],
    ['a payment line', { Payments: [{ PaymentID: 'p1' }] }, /payment applied in Xero/],
    ['credit note', { CreditNotes: [{ CreditNoteID: 'c1' }] }, /credit notes or allocations applied/],
    ['prepayment', { Prepayments: [{ PrepaymentID: 'p1' }] }, /credit notes or allocations applied/],
    ['the other type', { Type: 'ACCPAY' }, /not the sales invoice IMS recorded/],
    ['another number', { InvoiceNumber: 'INV-9999' }, /not safe to treat it as the document IMS raised/],
  ]
  for (const [name, over, pattern] of cases) {
    ledgerHolds(over)
    const run = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
    assert.ok(run.kind === 'failed', name)
    assert.match(run.error, pattern, name)
    assert.match(run.error, /Nothing was changed/, name)
    assert.equal(writes().length, 0, `${name}: nothing was written`)
  }
  ledgerHolds({ Status: 'PAID', AmountPaid: 10 })
  const paid = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(paid.kind === 'failed' && /Remove the blocking items in Xero first/.test(paid.error))
})

test('HELD: when the fence or the transport holds the write, nothing is written and nothing is recorded as done', async () => {
  // The caller's fence refuses before the first write (the lease, or the producer hold): no write at all.
  ledgerHolds({ Status: 'AUTHORISED' })
  const held = await runXeroDocumentDelete<string>(target(), { fence: async () => ({ ok: false, result: 'producer-held' }), idempotencyKey: keys })
  assert.deepEqual(held, { kind: 'fenced', result: 'producer-held' })
  assert.equal(writes().length, 0)
  // The fence passes for the renumber and then refuses the status write: the number was freed, the document is not removed, and the run says so.
  ledgerHolds({ Status: 'AUTHORISED' })
  let asked = 0
  const midway = await runXeroDocumentDelete<string>(target(), { fence: async () => (++asked === 2 ? { ok: false, result: 'lease-lost' } : { ok: true }), idempotencyKey: keys })
  assert.deepEqual(midway, { kind: 'fenced', result: 'lease-lost' })
  assert.equal(writes().length, 1)
  assert.equal(remote.Status, 'AUTHORISED')
  // The transport's own hold (the outbound-write hold refuses the POST): a failure that wrote nothing, so the status write is not attempted either.
  ledgerHolds({ Status: 'AUTHORISED' })
  writeFailures.push({ error: 'Outbound writes to Xero are held', notSent: 'outbound-write-held' })
  const transportHeld = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(transportHeld.kind === 'failed' && /held/.test(transportHeld.error))
  assert.equal(remote.InvoiceNumber, 'INV-1001', 'nothing reached the ledger')
})

test('the plan reads the released number as the sign that the first write already landed', async () => {
  const { planXeroDocumentDelete } = await connector()
  const doc = { InvoiceID: ID, Type: 'ACCREC', Status: 'AUTHORISED', InvoiceNumber: 'INV-1001-DEL-K7M2QX', Reference: 'SO-1001-DEL-K7M2QX' }
  assert.deepEqual(planXeroDocumentDelete(doc, target()), { kind: 'steps', renumber: false, targetStatus: 'VOIDED' })
  assert.deepEqual(planXeroDocumentDelete({ ...doc, InvoiceNumber: 'INV-1001', Reference: 'SO-1001' }, target()), { kind: 'steps', renumber: true, targetStatus: 'VOIDED' })
  assert.deepEqual(planXeroDocumentDelete({ ...doc, InvoiceNumber: 'inv-1001' }, target()), { kind: 'steps', renumber: true, targetStatus: 'VOIDED' }, 'number identity is case-insensitive, as Xero\'s is')
})

test('a queued delete whose payload has no released number is refused before anything is read or sent', async () => {
  const { parseXeroDeleteTarget } = await connector()
  const ok = parseXeroDeleteTarget('SALES_INVOICE_DELETE', { accountingInvoiceId: ID, invoiceNumber: 'INV-1', releasedNumber: 'INV-1-DEL-AAAAAA' })
  assert.ok(ok.ok && ok.target.expectedType === 'ACCREC')
  assert.ok(!parseXeroDeleteTarget('SALES_INVOICE_DELETE', { accountingInvoiceId: ID, invoiceNumber: 'INV-1' }).ok)
  assert.ok(!parseXeroDeleteTarget('PURCHASE_INVOICE_DELETE', { invoiceNumber: 'INV-1', releasedNumber: 'x' }).ok)
  const bill = parseXeroDeleteTarget('PURCHASE_INVOICE_DELETE', { accountingInvoiceId: ID, invoiceNumber: 'B-1', releasedNumber: 'B-1-DEL-AAAAAA' })
  assert.ok(bill.ok && bill.target.expectedType === 'ACCPAY')
})

// ---------------------------------------------------------------------------------------------------------------------------
// THE PRODUCER HOLD: the delete is the writer's operation, so a held destination shadows it
// ---------------------------------------------------------------------------------------------------------------------------

import { xeroProducerSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const HELD_ENV = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }
const NOW = new Date('2026-06-01T12:00:00Z')

test('under the producer hold a sales invoice delete is always a shadow (Xeroom owns it), a bill delete is live after the cut-off and a shadow before it', () => {
  const sales = xeroProducerSeamVerdict({ connector: 'xero', type: 'SALES_INVOICE_DELETE', payload: { date: '2026-05-30' }, env: HELD_ENV, now: NOW })
  assert.ok(sales.kind === 'shadow' && sales.decision.reason === 'not_ims_owned')
  const bill = (date: string) => xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE_DELETE', payload: { date }, env: HELD_ENV, now: NOW })
  assert.equal(bill('2026-05-30').kind, 'live')
  const early = bill('2025-12-31')
  assert.ok(early.kind === 'shadow' && early.decision.reason === 'obligation_before_cutoff', 'a bill dated before IMS went live is not IMS\'s to delete')
  assert.equal(xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE_DELETE', payload: { date: '2026-05-30' }, env: {}, now: NOW }).kind, 'legacy', 'not enforced: unchanged')
})

test('the processor hands a held delete back unsent: the real processClaimedEntry sends nothing under the producer hold', async () => {
  ledgerHolds({ Status: 'AUTHORISED' })
  const previous = { ...process.env }
  Object.assign(process.env, HELD_ENV)
  try {
    const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
    const lease = { fenceBeforeRemoteWrite: async () => { throw new Error('the fence must not be reached') } } as never
    const result = await processClaimedEntry(
      'entry-1', 'SALES_INVOICE_DELETE', 'SalesOrder', 'so-1',
      { _postingMode: 'submitted', accountingInvoiceId: ID, invoiceNumber: 'INV-1001', releasedNumber: 'INV-1001-DEL-K7M2QX', date: '2026-05-30' } as never,
      lease, { attemptRevision: 1 } as never,
    )
    assert.equal(result.success, false)
    assert.equal(result.notPosted?.reason, 'producer-shadowed')
    assert.equal(calls.length, 0, 'not even the read was made')
  } finally {
    for (const key of Object.keys(HELD_ENV)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

test('an externally removed document that still carries the original number is renamed before the delete counts as done', async () => {
  for (const Status of ['VOIDED', 'DELETED']) {
    ledgerHolds({ Status })
    const run = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
    assert.ok(run.kind === 'done' && run.status === Status, Status)
    assert.deepEqual(writes().map((w) => w.body), [{ InvoiceID: ID, InvoiceNumber: 'INV-1001-DEL-K7M2QX', Reference: 'SO-1001-DEL-K7M2QX' }], 'only the rename; no status write on a removed document')
    assert.equal(remote.InvoiceNumber, 'INV-1001-DEL-K7M2QX')
  }
})

test('when Xero refuses to rename an already removed document the delete is NOT completed, and the operator is told how to free the number', async () => {
  ledgerHolds({ Status: 'VOIDED' })
  writeFailures.push({ error: 'HTTP 400: cannot modify a voided invoice' })
  const run = await runXeroDocumentDelete(target(), { fence: fenceOk, idempotencyKey: keys })
  assert.ok(run.kind === 'failed')
  assert.match(run.error, /still reserves its number/)
  assert.match(run.error, /IMS has not changed anything/)
  // The held fence refuses the rename too: nothing is sent.
  ledgerHolds({ Status: 'DELETED' })
  const held = await runXeroDocumentDelete<string>(target(), { fence: async () => ({ ok: false, result: 'held' }), idempotencyKey: keys })
  assert.deepEqual(held, { kind: 'fenced', result: 'held' })
  assert.equal(writes().length, 0)
})
