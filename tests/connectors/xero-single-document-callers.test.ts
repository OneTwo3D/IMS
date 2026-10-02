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
/** o3d-h9pb r5: how the doubled Xero answers an Allocations PUT. */
type PutMode = 'echo' | 'replay-always' | 'keyed-replay' | 'reject-changed' | { raw: unknown }
let putMode: PutMode = 'echo'
let putKeys: Array<string | undefined> = []
let firstResponse: unknown = null
const idemStore = new Map<string, { body: string; response: unknown }>()
let putBodies: Array<{ Allocations: Array<{ Amount: number; Invoice: { InvoiceID: string } }> }> = []
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
    xeroPut: async (path: string, body: { Allocations: Array<{ Amount: number; Invoice: { InvoiceID: string } }> }, opts?: { idempotencyKey?: string }) => {
      puts.push(path); putBodies.push(body); putKeys.push(opts?.idempotencyKey)
      const echo = { Allocations: body.Allocations.map((a) => ({ Amount: a.Amount, Invoice: { InvoiceID: a.Invoice.InvoiceID } })) }
      if (typeof putMode === 'object') return { ok: true, status: 200, data: putMode.raw }
      if (putMode === 'replay-always') {
        if (firstResponse === null) firstResponse = echo
        return { ok: true, status: 200, data: firstResponse }
      }
      const key = opts?.idempotencyKey
      if ((putMode === 'keyed-replay' || putMode === 'reject-changed') && key) {
        const seen = idemStore.get(key)
        if (seen) {
          if (putMode === 'reject-changed' && seen.body !== JSON.stringify(body)) return { ok: false, status: 400, error: 'idempotency key reused with a different request body' }
          return { ok: true, status: 200, data: seen.response }
        }
        idemStore.set(key, { body: JSON.stringify(body), response: echo })
      }
      return { ok: true, status: 200, data: echo }
    },
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
  putBodies = []
  putKeys = []
  putMode = 'echo'
  firstResponse = null
  idemStore.clear()
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
const NOTE = { CreditNoteID: 'cn-1', RemainingCredit: 40, Allocations: [] as unknown[] }
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

  // A zero balance is idempotent success ONLY when the credit note's own Allocations show OUR allocation.
  puts = []
  xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [{ ...NOTE, RemainingCredit: 0, Allocations: [{ Amount: 25, Invoice: { InvoiceID: 'BILL-1' } }] }] }, 'Invoices/bill-1': { Invoices: [{ ...BILL, AmountDue: 0 }] } }
  const zero = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([zero.success, zero.allocatedAmount, puts.length], [true, 0, 0], 'our allocation exists: a settled retry')

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

/* ------------- o3d-h9pb (Codex round 2): a READABLE zero balance is not "already allocated" ------------- */

test('[o3d-h9pb HIGH r2] allocatePurchaseCreditNote decision table: RC x AD x allocated-to-THIS-bill', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const OTHER = { Amount: 40, Invoice: { InvoiceID: 'bill-OTHER' } }
  const OURS = (amount: number) => ({ Amount: amount, Invoice: { InvoiceID: 'bill-1' } })
  // [name, RC, AD, allocations, expected: 'put:<amount>' | 'ok-noop' | 'refuse:<regex source>']
  const table: Array<[string, number, number, unknown[], string]> = [
    ['RC>0 AD>0, not allocated: allocate', 40, 25, [], 'put:25'],
    ['RC>0 AD>0, ours already covers it: no second allocation', 40, 25, [OURS(25)], 'ok-noop'],
    ['RC>0 AD>0, ours covers part: allocate only the residual', 40, 25, [OURS(10)], 'put:15'],
    ['RC=0 AD>0, not allocated to this bill (exhausted on ANOTHER bill)', 0, 25, [OTHER], 'refuse:no credit remaining \\(it was allocated to another document or refunded\\)'],
    ['RC=0 AD>0, no allocations at all (refunded)', 0, 25, [], 'refuse:no credit remaining'],
    ['RC=0 AD>0, ours covers it: our allocation exists', 0, 25, [OURS(25)], 'ok-noop'],
    ['RC=0 AD>0, ours covers only part: a shortfall, not success', 0, 25, [OURS(10)], 'refuse:10.00 of the 25.00 requested'],
    ['RC>0 AD=0, not allocated to this bill (bill settled by something else)', 40, 0, [OTHER], 'refuse:the bill has nothing due'],
    ['RC>0 AD=0, ours covers it', 40, 0, [OURS(25)], 'ok-noop'],
    ['RC=0 AD=0, not allocated to this bill', 0, 0, [OTHER], 'refuse:neither is explained'],
    ['RC=0 AD=0, ours covers it', 0, 0, [OURS(25)], 'ok-noop'],
    ['RC=0 AD=0, ours covers part', 0, 0, [OURS(5)], 'refuse:5.00 of the 25.00'],
  ]
  let cases = 0
  for (const [name, rc, ad, allocations, expected] of table) {
    puts = []
    xeroBodies = {
      'CreditNotes/cn-1': { CreditNotes: [{ ...NOTE, RemainingCredit: rc, Allocations: allocations }] },
      'Invoices/bill-1': { Invoices: [{ ...BILL, AmountDue: ad }] },
    }
    const result = await allocatePurchaseCreditNote(PARAMS)
    if (expected.startsWith('put:')) {
      assert.equal(result.success, true, `${name}: ${JSON.stringify(result)}`)
      assert.equal(result.allocatedAmount, Number(expected.slice(4)), name)
      assert.equal(puts.length, 1, `${name}: exactly one PUT`)
    } else if (expected === 'ok-noop') {
      assert.deepEqual([result.success, result.allocatedAmount, puts.length], [true, 0, 0], name)
    } else {
      assert.equal(result.success, false, `${name}: ${JSON.stringify(result)}`)
      assert.match(result.error ?? '', new RegExp(expected.slice(7)), name)
      assert.deepEqual(puts, [], `${name}: NO PUT`)
    }
    cases += 1
  }
  assert.equal(cases, 12)
  console.log(`# o3d-h9pb HIGH r2 allocation decision table: ${cases} cells`)
})

test('[o3d-h9pb HIGH r2] an unreadable Allocations collection is a failure, never "not allocated" and never "already allocated"', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const shapes: Array<[string, unknown]> = [
    ['omitted', undefined], ['null', null], ['string', 'x'], ['object', {}],
    ['entry not an object', ['x']], ['entry without invoice', [{ Amount: 25 }]],
    ['entry with blank invoice id', [{ Amount: 25, Invoice: { InvoiceID: ' ' } }]],
    ['entry amount string', [{ Amount: '25', Invoice: { InvoiceID: 'bill-1' } }]],
    ['entry amount NaN', [{ Amount: Number.NaN, Invoice: { InvoiceID: 'bill-1' } }]],
    ['entry amount negative', [{ Amount: -5, Invoice: { InvoiceID: 'bill-1' } }]],
  ]
  let cases = 0
  for (const [name, allocations] of shapes) {
    puts = []
    const note: Record<string, unknown> = { ...NOTE }
    if (allocations === undefined) delete note.Allocations; else note.Allocations = allocations
    xeroBodies = { 'CreditNotes/cn-1': { CreditNotes: [note] }, 'Invoices/bill-1': { Invoices: [BILL] } }
    const result = await allocatePurchaseCreditNote(PARAMS)
    assert.equal(result.success, false, `${name}: ${JSON.stringify(result)}`)
    assert.match(result.error ?? '', /no readable Allocations/, name)
    assert.deepEqual(puts, [], `${name}: NO PUT`)
    cases += 1
  }
  assert.equal(cases, 10)
  console.log(`# o3d-h9pb HIGH r2 Allocations shapes: ${cases} unreadable cases`)
})

/* ------- o3d-h9pb (Codex round 4): success ONLY when the bill holds the whole requested amount ------- */

const stateFor = (rc: number, ad: number, allocations: unknown[]) => {
  xeroBodies = {
    'CreditNotes/cn-1': { CreditNotes: [{ ...NOTE, RemainingCredit: rc, Allocations: allocations }] },
    'Invoices/bill-1': { Invoices: [{ ...BILL, AmountDue: ad }] },
  }
  puts = []
  putBodies = []
  putKeys = []
}
const OURS_ = (amount: number) => ({ Amount: amount, Invoice: { InvoiceID: 'bill-1' } })

test('[o3d-h9pb HIGH r4] a PUT capped by the credit is a PARTIAL failure, not success (Codex: 25 / 10 / 25 with another bill)', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  stateFor(10, 25, [{ Amount: 40, Invoice: { InvoiceID: 'bill-OTHER' } }])
  const result = await allocatePurchaseCreditNote(PARAMS)
  assert.equal(putBodies.length, 1, 'PRECONDITION: the capped PUT really was sent')
  assert.equal(putBodies[0]!.Allocations[0]!.Amount, 10, 'and it was the available credit, not the request')
  assert.equal(result.success, false, JSON.stringify(result))
  assert.deepEqual(result.partial, { allocatedNow: 10, totalAllocatedToThisBill: 10, requested: 25, shortfall: 15 })
  assert.match(result.error ?? '', /PARTIAL allocation: 10\.00 was allocated/)
  assert.match(result.error ?? '', /15\.00 is still outstanding/)
  assert.match(result.error ?? '', /a retry sends only the remainder/)
  console.log('# o3d-h9pb HIGH r4 capped PUT: partial reported as failure')
})

test('[o3d-h9pb HIGH r4] the retry after a capped PUT is idempotent: residual only, then a no-op once complete', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  // 1. first attempt: 10 of 25 goes in
  stateFor(10, 25, [])
  const first = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([first.success, putBodies.map((b) => b.Allocations[0]!.Amount)], [false, [10]])
  // 2. retry while the credit is still exhausted: nothing sent, still a failure naming the cause
  stateFor(0, 15, [OURS_(10)])
  const stuck = await allocatePurchaseCreditNote(PARAMS)
  assert.equal(stuck.success, false)
  assert.match(stuck.error ?? '', /no credit remaining/)
  assert.match(stuck.error ?? '', /10\.00 of the 25\.00 requested/)
  assert.deepEqual(puts, [], 'no PUT while exhausted')
  // 3. credit added: ONLY the residual 15 is sent, and now it is success
  stateFor(20, 15, [OURS_(10)])
  const done = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([done.success, putBodies.map((b) => b.Allocations[0]!.Amount)], [true, [15]])
  // 4. a further retry is a no-op success
  stateFor(5, 0, [OURS_(25)])
  const again = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([again.success, puts.length], [true, 0])
  console.log('# o3d-h9pb HIGH r4 retry: 4 steps (partial, stuck, residual, no-op)')
})

test('[o3d-h9pb HIGH r4] exact fit succeeds; and NEVER more than min(remaining credit, amount due, requested - already allocated) is sent', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  stateFor(25, 25, [])
  const fit = await allocatePurchaseCreditNote(PARAMS)
  assert.deepEqual([fit.success, putBodies.map((b) => b.Allocations[0]!.Amount)], [true, [25]], 'exact fit')

  let cells = 0
  for (const rc of [0, 5, 10, 25, 40]) for (const ad of [0, 5, 10, 25, 40]) for (const a of [0, 10, 25, 30]) {
    stateFor(rc, ad, a === 0 ? [] : [OURS_(a)])
    const r = await allocatePurchaseCreditNote(PARAMS)
    const sent = putBodies.reduce((t, b) => t + b.Allocations[0]!.Amount, 0)
    const cap = Math.max(0, Math.min(rc, ad, 25 - a))
    assert.ok(sent <= cap + 1e-9, `rc=${rc} ad=${ad} a=${a}: sent ${sent} exceeds the cap ${cap}`)
    assert.equal(sent, cap, `rc=${rc} ad=${ad} a=${a}: sends exactly the cap`)
    // THE PROPERTY: success iff the bill now holds the whole request
    assert.equal(r.success, a + sent >= 25, `rc=${rc} ad=${ad} a=${a}: success iff allocated(${a + sent}) >= requested(25): ${JSON.stringify(r)}`)
    cells += 1
  }
  assert.equal(cells, 100)
  console.log(`# o3d-h9pb HIGH r4 grid: ${cells} (RC x AD x A) cells, success iff allocated >= requested, never over-sent`)
})

/* ------- o3d-h9pb (Codex round 5): one idempotency key per distinct allocation; completion only from the response ------- */

const KEYED = { idempotencyKey: 'ims-purchase-credit-note-allocation-row-1' }

test('[o3d-h9pb HIGH r5] the PUT carries a derived per-allocation key: same residual => same key, a different one => a different key', async () => {
  const { allocatePurchaseCreditNote, deriveAllocationIdempotencyKey } = await import('@/lib/connectors/xero/credit-notes')
  stateFor(40, 25, [])
  const ok = await allocatePurchaseCreditNote(PARAMS, KEYED)
  assert.equal(ok.success, true, JSON.stringify(ok))
  assert.equal(putKeys.length, 1, 'PRECONDITION: a PUT was sent')
  assert.match(putKeys[0] ?? '', /^ims-pcna-[0-9a-f]{64}$/)
  assert.ok((putKeys[0] ?? '').length <= 128)
  assert.notEqual(putKeys[0], KEYED.idempotencyKey, 'not the raw row key')
  // retry of the SAME residual reuses the key
  stateFor(40, 25, [])
  await allocatePurchaseCreditNote(PARAMS, KEYED)
  const sameAgain = putKeys[0]
  assert.equal(sameAgain, deriveAllocationIdempotencyKey(KEYED.idempotencyKey, 'cn-1', 'bill-1', 2500, 0))
  // a DIFFERENT residual (10 already allocated => 15) gets a different key
  stateFor(40, 25, [OURS_(10)])
  await allocatePurchaseCreditNote(PARAMS, KEYED)
  assert.notEqual(putKeys[0], sameAgain)
  const k = (cn: string, inv: string, c: number, a: number) => deriveAllocationIdempotencyKey('r', cn, inv, c, a)
  const keys = new Set([k('cn-1', 'b', 1500, 10), k('cn-2', 'b', 1500, 10), k('cn-1', 'b2', 1500, 10), k('cn-1', 'b', 1000, 10), k('cn-1', 'b', 1500, 0)])
  assert.equal(keys.size, 5, 'every input changes the key')
  assert.equal(k('CN-1', 'B', 1, 1), k('cn-1', 'b', 1, 1), 'ids compare case-insensitively')
  console.log('# o3d-h9pb HIGH r5 key derivation: 3 PUT-level + 5 distinctness + 1 case cases')
})

test('[o3d-h9pb HIGH r5] capped PUT then residual retry against a Xero that REPLAYS on a reused key and one that REJECTS a changed body', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  for (const mode of ['keyed-replay', 'reject-changed'] as const) {
    putMode = mode
    idemStore.clear()
    stateFor(10, 25, [])
    const first = await allocatePurchaseCreditNote(PARAMS, KEYED)
    assert.equal(first.success, false, `${mode}: capped PUT is partial`)
    assert.equal(first.partial?.shortfall, 15, mode)
    stateFor(20, 15, [OURS_(10)])
    const second = await allocatePurchaseCreditNote(PARAMS, KEYED)
    assert.equal(putBodies.length, 1, `${mode}: PRECONDITION the residual PUT was sent`)
    assert.equal(putBodies[0]!.Allocations[0]!.Amount, 15, mode)
    assert.equal(second.success, true, `${mode}: ${JSON.stringify(second)}`)
    assert.equal(idemStore.size, 2, `${mode}: two distinct keys reached Xero`)
  }
  console.log('# o3d-h9pb HIGH r5 two-attempt scenario: 2 Xero models (keyed replay, reject changed body)')
})

test('[o3d-h9pb HIGH r5] a response that does not confirm THIS amount on THIS bill is never completion', async () => {
  const { allocatePurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  // A Xero that replays the FIRST response to the residual retry whatever key it carries.
  putMode = 'replay-always'
  stateFor(10, 25, [])
  await allocatePurchaseCreditNote(PARAMS, KEYED)
  stateFor(20, 15, [OURS_(10)])
  const replayed = await allocatePurchaseCreditNote(PARAMS, KEYED)
  assert.equal(putBodies.length, 1, 'PRECONDITION: the residual PUT was sent and answered with the OLD response')
  assert.equal(replayed.success, false, JSON.stringify(replayed))
  assert.match(replayed.error ?? '', /Allocation not confirmed/)
  assert.equal(replayed.allocatedAmount, undefined, 'no completion claim')

  const shapes: Array<[string, unknown]> = [
    ['no Allocations', {}], ['null body', null], ['empty list', { Allocations: [] }], ['not a list', { Allocations: 'x' }],
    ['other bill', { Allocations: [{ Amount: 25, Invoice: { InvoiceID: 'bill-OTHER' } }] }],
    ['no invoice stated', { Allocations: [{ Amount: 25 }] }],
    ['wrong amount', { Allocations: [{ Amount: 10, Invoice: { InvoiceID: 'bill-1' } }] }],
    ['amount as string', { Allocations: [{ Amount: '25', Invoice: { InvoiceID: 'bill-1' } }] }],
    ['malformed entry', { Allocations: ['x'] }],
  ]
  let cases = 0
  for (const [name, raw] of shapes) {
    putMode = { raw }
    stateFor(40, 25, [])
    const r = await allocatePurchaseCreditNote(PARAMS, KEYED)
    assert.equal(putBodies.length, 1, `${name}: PRECONDITION PUT sent`)
    assert.equal(r.success, false, `${name}: ${JSON.stringify(r)}`)
    assert.match(r.error ?? '', /Allocation not confirmed/, name)
    cases += 1
  }
  // CONTROLS: the matching response (any id case, extra entries) confirms.
  for (const raw of [
    { Allocations: [{ Amount: 25, Invoice: { InvoiceID: 'BILL-1' } }] },
    { Allocations: [{ Amount: 5, Invoice: { InvoiceID: 'bill-OTHER' } }, { Amount: 25, Invoice: { InvoiceID: 'bill-1' } }] },
  ]) {
    putMode = { raw }
    stateFor(40, 25, [])
    assert.equal((await allocatePurchaseCreditNote(PARAMS, KEYED)).success, true)
  }
  assert.equal(cases, 9)
  console.log(`# o3d-h9pb HIGH r5 response confirmation: replay + ${cases} unconfirmed shapes + 2 controls`)
})
