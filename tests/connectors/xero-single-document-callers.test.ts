import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-h9pb: the two WRITE-path callers that read a by-id Xero document through
 * `readSingleXeroDocument`, driven through their real production code with Xero and the database
 * doubled:
 *
 *   - `allocatePurchaseCreditNote` (credit-notes.ts) sizes a credit-note allocation from the credit
 *     note's RemainingCredit and the bill's AmountDue. A different document read in place of either
 *     sizes the PUT from somebody else's figures. Unreadable => failure, and NO allocation is sent.
 *   - `reconcileXeroPayments` -> `markPaid` (payment-reconcile.ts) re-reads the invoice before stamping
 *     paidAt. A different invoice that happens to be PAID must never stamp THIS document paid.
 *     Unreadable => `applied: false` with a reason, and NO write.
 *
 * Each arm varies ONE response and asserts its precondition (the raw shape was served) and prints its
 * case count.
 */

let xeroBodies: Record<string, unknown> = {}
let xeroServed: string[] = []
let puts: string[] = []
let salesUpdates = 0
let activity: Array<Record<string, unknown>> = []

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      xeroServed.push(path)
      if (!(path in xeroBodies)) return { ok: false, status: 404, error: 'not stubbed' }
      return { ok: true, status: 200, data: xeroBodies[path] }
    },
    xeroPost: async () => ({ ok: false, status: 500, error: 'not expected' }),
    xeroPut: async (path: string) => { puts.push(path); return { ok: true, status: 200, data: {} } },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => 'contact-1' } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async () => [{ id: 'o1', accountingInvoiceId: 'INV-1', paidAt: null, orderNumber: 'SO-1', externalOrderNumber: null }],
        updateMany: async () => { salesUpdates += 1; return { count: 1 } },
      },
      purchaseInvoice: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    },
  },
})
mock.module('@/lib/connectors/xero/payment-write-lock', {
  namedExports: {
    withPaymentWriteLockOrSkip: async (fn: () => Promise<unknown>) => fn(),
    isLockSkipped: () => false,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } },
})
mock.module('@/app/actions/allocation', { namedExports: { autoAllocateOrder: async () => undefined } })

beforeEach(() => {
  xeroBodies = {}
  xeroServed = []
  puts = []
  salesUpdates = 0
  activity = []
})

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

/* ------------------- allocatePurchaseCreditNote: two reads, two isolating arms ------------------- */

const PARAMS = { creditNoteId: 'cn-1', invoiceId: 'bill-1', amount: 25, date: '2026-08-01' }
const NOTE = { CreditNoteID: 'cn-1', RemainingCredit: 40 }
const BILL = { InvoiceID: 'bill-1', AmountDue: 25 }

test('[o3d-h9pb credit-notes.ts CreditNotes/{id}] an unreadable credit note allocates NOTHING', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [NOTE] }, 'Invoices/bill-1': { Invoices: [BILL] } }
  const control = await allocatePurchaseCreditNote(PARAMS)
  assert.equal(control.success, true, JSON.stringify(control))
  assert.equal(puts.length, 1, 'PRECONDITION: the control really sent the allocation')

  let cases = 0
  for (const shape of shapes('CreditNotes', 'CreditNoteID', 'cn-1', NOTE)) {
    puts = []
    xeroServed = []
    xeroBodies = { 'CreditNotes/cn-1': shape.body, 'Invoices/bill-1': { Invoices: [BILL] } }
    const result = await allocatePurchaseCreditNote(PARAMS)
    assert.deepEqual(xeroServed, ['CreditNotes/cn-1'], `PRECONDITION (${shape.name}): the shape was served and refused before the bill was asked`)
    assert.equal(result.success, false, `${shape.name}: ${JSON.stringify(result)}`)
    assert.match(result.error ?? '', /Credit note not read from Xero/, shape.name)
    assert.deepEqual(puts, [], `${shape.name}: nothing was allocated`)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb credit-notes.ts CreditNotes/{id}: ${cases} unreadable cases + 1 correct-document control`)
})

test('[o3d-h9pb credit-notes.ts Invoices/{id}] an unreadable bill allocates NOTHING', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  let cases = 0
  for (const shape of shapes('Invoices', 'InvoiceID', 'bill-1', BILL)) {
    puts = []
    xeroServed = []
    xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [NOTE] }, 'Invoices/bill-1': shape.body }
    const result = await allocatePurchaseCreditNote(PARAMS)
    assert.deepEqual(xeroServed, ['CreditNotes/cn-1', 'Invoices/bill-1'], `PRECONDITION (${shape.name}): the shape reached the bill read`)
    assert.equal(result.success, false, `${shape.name}: ${JSON.stringify(result)}`)
    assert.match(result.error ?? '', /Bill not read from Xero/, shape.name)
    assert.deepEqual(puts, [], `${shape.name}: nothing was allocated`)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb credit-notes.ts Invoices/{id}: ${cases} unreadable cases (control is in the CreditNotes test)`)
})

/* ------------------------- reconcile markPaid: the re-read before the write ------------------------- */

const PAID = { InvoiceID: 'INV-1', Status: 'PAID', FullyPaidOnDate: '2026-07-01T00:00:00Z' }

test('[o3d-h9pb payment-reconcile.ts markPaid] an unreadable invoice re-read stamps NOTHING paid', async () => {
  const { reconcileXeroPayments } = await import('@/lib/connectors/xero/payment-reconcile')
  const arrange = (fresh: unknown) => {
    salesUpdates = 0
    xeroServed = []
    // the batch status fetch says PAID (so the document is a candidate); the by-id re-read is the arm
    xeroBodies = { 'Invoices?IDs=INV-1': { Invoices: [PAID] }, 'Invoices/INV-1': fresh }
  }
  arrange({ Invoices: [PAID] })
  const control = await reconcileXeroPayments({ apply: true })
  assert.equal(control.missedPayments.length, 1, 'PRECONDITION: the document is a missed payment')
  assert.equal(control.missedPayments[0]!.applied, true, JSON.stringify(control.missedPayments))
  assert.ok(salesUpdates >= 1, 'PRECONDITION: the control really wrote paidAt')

  let cases = 0
  // The wrong-id body is a DIFFERENT invoice that is PAID with a settlement date: every later check
  // passes on it, so only the binding to the requested id can refuse it.
  for (const shape of shapes('Invoices', 'InvoiceID', 'INV-1', PAID)) {
    arrange(shape.body)
    const report = await reconcileXeroPayments({ apply: true })
    assert.ok(xeroServed.includes('Invoices/INV-1'), `PRECONDITION (${shape.name}): the by-id re-read happened`)
    assert.equal(report.missedPayments.length, 1, `${shape.name}: still reported as a missed payment`)
    assert.equal(report.missedPayments[0]!.applied, false, `${shape.name}: ${JSON.stringify(report.missedPayments)}`)
    assert.match(report.missedPayments[0]!.skipped ?? '', /could not re-read the invoice from Xero/, shape.name)
    assert.equal(salesUpdates, 0, `${shape.name}: paidAt was NOT written`)
    cases += 1
  }
  assert.equal(cases, 6)
  console.log(`# o3d-h9pb payment-reconcile.ts markPaid: ${cases} unreadable cases + 1 correct-document control`)
})

/* --------- o3d-h9pb (Codex HIGH): a bound document with a MISSING or unreadable figure is not zero --------- */

const BAD_FIGURES: Array<[string, (doc: Record<string, unknown>, field: string) => Record<string, unknown>]> = [
  ['omitted', (d, f) => { const c = { ...d }; delete c[f]; return c }],
  ['null', (d, f) => ({ ...d, [f]: null })],
  ['string', (d, f) => ({ ...d, [f]: '40' })],
  ['NaN', (d, f) => ({ ...d, [f]: Number.NaN })],
  ['Infinity', (d, f) => ({ ...d, [f]: Number.POSITIVE_INFINITY })],
  ['negative', (d, f) => ({ ...d, [f]: -1 })],
]

test('[o3d-h9pb HIGH] allocatePurchaseCreditNote: an unreadable RemainingCredit or AmountDue is a failure, not "nothing to allocate"', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [NOTE] }, 'Invoices/bill-1': { Invoices: [BILL] } }
  puts = []
  const control = await allocatePurchaseCreditNote(PARAMS)
  assert.equal(control.success, true)
  assert.equal(puts.length, 1, 'PRECONDITION: with readable figures the allocation IS sent')

  // A legitimate zero is still the idempotent no-op, so the fix did not turn every zero into a failure.
  puts = []
  xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [{ ...NOTE, RemainingCredit: 0 }] }, 'Invoices/bill-1': { Invoices: [BILL] } }
  const zero = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([zero.success, zero.allocatedAmount, puts.length], [true, 0, 0], 'a stated zero is a settled retry')

  let cases = 0
  for (const [label, corrupt] of BAD_FIGURES) {
    for (const [field, side] of [['RemainingCredit', 'note'], ['AmountDue', 'bill']] as const) {
      puts = []
      xeroBodies = {
        'CreditNotes/cn-1': { CreditNotes: [side === 'note' ? corrupt(NOTE, field) : NOTE] },
        'Invoices/bill-1': { Invoices: [side === 'bill' ? corrupt(BILL, field) : BILL] },
      }
      const result = await allocatePurchaseCreditNote(PARAMS)
      assert.equal(result.success, false, `${field} ${label}: ${JSON.stringify(result)}`)
      assert.match(result.error ?? '', new RegExp(field), `${field} ${label}: names the figure`)
      assert.equal(result.allocatedAmount, undefined, `${field} ${label}`)
      assert.deepEqual(puts, [], `${field} ${label}: NO allocation PUT`)
      cases += 1
    }
  }
  assert.equal(cases, 12)
  console.log(`# o3d-h9pb HIGH allocatePurchaseCreditNote figures: ${cases} unreadable cases + 2 controls`)
})

test('[o3d-h9pb HIGH] reconcile: a document that states no Status is UNKNOWN / not written, never "unpaid"', async () => {
  const { reconcileXeroPayments, classifyDoc } = await import('@/lib/connectors/xero/payment-reconcile')
  let cases = 0
  for (const [label, status] of [['omitted', undefined], ['null', null], ['empty', ''], ['number', 7]] as const) {
    const doc = { id: 'o1', accountingInvoiceId: 'INV-1', imsPaid: true, label: 'x' }
    const verdict = classifyDoc(doc, { InvoiceID: 'INV-1', Status: status as never })
    assert.equal(verdict.kind, 'unknown', `classifyDoc ${label} (IMS paid): not a suspect advance`)
    assert.equal(classifyDoc({ ...doc, imsPaid: false }, { InvoiceID: 'INV-1', Status: status as never }).kind, 'unknown', `classifyDoc ${label} (IMS unpaid): not "consistent"`)
    // markPaid's own re-read, ids matching but Status unreadable: nothing written.
    salesUpdates = 0
    const inv = { ...PAID, Status: status }
    xeroBodies = { 'Invoices?IDs=INV-1': { Invoices: [PAID] }, 'Invoices/INV-1': { Invoices: [inv] } }
    const report = await reconcileXeroPayments({ apply: true })
    assert.equal(report.missedPayments[0]!.applied, false, label)
    assert.match(report.missedPayments[0]!.skipped ?? '', /no Status/, label)
    assert.equal(salesUpdates, 0, `${label}: paidAt not written`)
    cases += 1
  }
  assert.equal(cases, 4)
  console.log(`# o3d-h9pb HIGH reconcile Status: ${cases} unreadable cases`)
})
