import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-0m56 round 2, Codex CRITICAL — the check that authorises a money POST has to live at the
 * POST, not at the click that eventually leads to one.
 *
 * The first round put the ledger read in the two manual retry actions and in both connectors'
 * follow-up revival. Neither is where money actually moves. A failed money row does not go
 * straight to FAILED: it returns to PENDING for up to five attempts, and every one of those
 * re-posts with no ledger read at all — so a payment Xero committed and failed to acknowledge was
 * sent again by the next cron run, long after Xero's idempotency window closed.
 *
 * `remoteAttemptedAt` is what lets a row answer "have I been sent before?" across the retryCount
 * resets that both revival paths perform. First attempt: stamp and go. Every repeat: read the
 * ledger and refuse unless it positively does not hold the attempt.
 */

const xeroCalls: string[] = []
let xeroResponse: unknown = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (p: string) => {
      xeroCalls.push(p)
      return { ok: true, status: 200, data: xeroResponse }
    },
  },
})

/** QuickBooks responses, keyed by path, for the bill-payment shapes this connector really writes. */
let qboResponses: Record<string, unknown> = {}
const qboCalls: string[] = []

mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboGet: async (p: string) => {
      qboCalls.push(p)
      const body = qboResponses[p]
      if (body === undefined) return { ok: false, status: 404, error: 'not stubbed' }
      return { ok: true, status: 200, data: body }
    },
  },
})

const load = async () => (await import('@/lib/connectors/accounting-settlement-probe')).authoriseMoneyPost
const loadFence = async () => (await import('@/lib/connectors/accounting-settlement-probe')).postMoneyUnderLedgerFence

/**
 * A `pg_try_advisory_lock` in memory: one holder per scope key, and a caller that cannot have it
 * is told so rather than queued. Modelled rather than stubbed to `true`, because a lock double
 * that always grants makes every serialization test vacuous.
 */
function lockDouble() {
  const held = new Set<string>()
  const acquisitions: string[] = []
  const contended: string[] = []
  let onAcquire: (() => void) | null = null
  // Set to make the pinned connection "die" while the lock is nominally held — the state in which
  // PostgreSQL has already freed it and another worker may be posting to this document.
  let lost = false
  const lock = async <T>(
    scope: { connector: string; type: string; referenceType: string; referenceId: string },
    run: (held: { assertHeld: (context?: string) => void }) => Promise<T>,
  ): Promise<{ locked: true; result: T } | { locked: false }> => {
    const key = [scope.connector, scope.type, scope.referenceType, scope.referenceId].join(' ')
    if (held.has(key)) {
      contended.push(key)
      return { locked: false }
    }
    held.add(key)
    acquisitions.push(key)
    onAcquire?.()
    try {
      return {
        locked: true,
        result: await run({
          assertHeld: (context?: string) => {
            if (lost) throw new Error(`Advisory lock was lost before ${context}`)
          },
        }),
      }
    } finally {
      held.delete(key)
    }
  }
  return {
    lock,
    held,
    acquisitions,
    contended,
    whenAcquired: (fn: () => void) => { onAcquire = fn },
    loseIt: () => { lost = true },
  }
}

type Row = { id: string; remoteAttemptedAt: Date | null; scope?: string; payload?: unknown }

/** The scope every row in these tests belongs to, unless it says otherwise. */
const SCOPE = 'INVOICE_PAYMENT SalesOrder so-1'

/** What a sibling sent, unless the test pins something else: the same receipt as the target. */
const DEFAULT_PAYLOAD = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }

function dbDouble(rows: Row[]) {
  const writes: Array<{ id: string; at: Date }> = []
  const counts: Array<Record<string, unknown>> = []
  return {
    writes,
    rows,
    counts,
    db: {
      accountingSyncLog: {
        findMany: async ({ where }: { where: Record<string, unknown>; select: { id: true; payload: true } }) => {
          counts.push(where)
          // Implemented, not stubbed to []: a scope query that silently answered "nothing" would
          // make the sibling check vacuous, which is the whole point of the check.
          return rows.filter((r) =>
            (r.scope ?? SCOPE) === `${where.type} ${where.referenceType} ${where.referenceId}`
            && r.remoteAttemptedAt !== null
            && r.id !== (where.id as { not: string }).not)
            .map((r) => ({ id: r.id, payload: r.payload ?? DEFAULT_PAYLOAD }))
        },
        updateMany: async ({ where, data }: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => {
          // The double enforces the CONDITION, because the whole point of the conditional write is
          // that two workers racing one row cannot both read "never attempted". A write that
          // dropped the condition would stamp an already-stamped row and report count 1 — "first
          // attempt" — for every repeat, so the condition is asserted, not assumed.
          assert.ok('remoteAttemptedAt' in where && where.remoteAttemptedAt === null,
            'the stamp must be claimed conditionally on it being unset')
          const row = rows.find((r) => r.id === where.id && r.remoteAttemptedAt === null)
          if (!row) return { count: 0 }
          row.remoteAttemptedAt = data.remoteAttemptedAt
          writes.push({ id: where.id, at: data.remoteAttemptedAt })
          return { count: 1 }
        },
      },
    },
  }
}

const payment = {
  connector: 'xero' as const,
  type: 'INVOICE_PAYMENT',
  referenceType: 'SalesOrder',
  referenceId: 'so-1',
  payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
}

test('the FIRST attempt is stamped, and READS the ledger before it is allowed (o3d-0m56)', async () => {
  // Round 4 removed the free pass. The stamp still happens first and still happens before any
  // call — but "this row has never posted" is no longer on its own a reason to send money.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db, writes, rows } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })

  assert.deepEqual(verdict, { proceed: true })
  assert.equal(writes.length, 1, 'the attempt must be recorded BEFORE the call, not after it')
  assert.notEqual(rows[0]!.remoteAttemptedAt, null)
  assert.deepEqual(xeroCalls, ['Invoices/inv-1'], 'and it pays for the reading that says the document is unsettled')
})

test('a REPEAT attempt is refused when the ledger already holds it (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }],
  }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z') }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })

  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
  assert.equal(verdict.proceed, false)
  assert.match(verdict.proceed === false ? verdict.error : '', /already holds a settlement of 10\.00 dated 2026-08-01/)
  assert.match(verdict.proceed === false ? verdict.error : '', /Not sent/)
})

test('a REPEAT attempt proceeds when the ledger does not hold it (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-07-01', Amount: 10 }] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z') }])

  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-1', db }), { proceed: true })
  assert.deepEqual(xeroCalls, ['Invoices/inv-1'], 'and it paid for the reading that says so')
})

test('an unreadable ledger stops a repeat attempt (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = { Invoices: [] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z') }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })
  assert.equal(verdict.proceed, false, 'unknown is not clear, at the posting site either')
})

test('a row that has VANISHED is treated as a repeat, not as a first attempt (o3d-0m56)', async () => {
  // Retention or a connector switch can delete the row mid-flight. The stamp write then matches
  // nothing, exactly as it does for a row already stamped — and that is the right reading: "I
  // cannot claim the first attempt" is not evidence that nothing has been sent.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }],
  }
  const { db, writes } = dbDouble([])

  const verdict = await (await load())({ ...payment, entryId: 'gone', db })

  assert.equal(verdict.proceed, false)
  assert.deepEqual(writes, [], 'and nothing is stamped on a row that is not there')
})

test('losing the stamp race means taking the repeat path (o3d-0m56)', async () => {
  // Two workers can read the same row before either writes. The conditional update is what breaks
  // the tie: the loser gets count 0 and must NOT conclude it is the first attempt.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }],
  }
  const authorise = await load()
  const db = {
    // The row was claimed by another worker between this call reading and writing: the conditional
    // update matches nothing.
    accountingSyncLog: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
  }

  const verdict = await authorise({ ...payment, entryId: 'log-1', db })
  assert.equal(verdict.proceed, false, 'the loser must fall through to the ledger check')
  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
})

test('a non-money post is never gated (o3d-0m56)', async () => {
  xeroCalls.length = 0
  const { db, writes } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date() }])
  for (const type of ['SALES_INVOICE', 'INVOICE_PDF', 'COGS_JOURNAL']) {
    assert.deepEqual(await (await load())({ ...payment, type, entryId: 'log-1', db }), { proceed: true }, type)
  }
  assert.deepEqual(xeroCalls, [])
  assert.deepEqual(writes, [], 'and costs neither a read nor a write')
})

/**
 * Every site in either processor that sends money. A branch that skips the guard is not weakly
 * protected, it is unprotected, so the list is enumerated rather than spot-checked.
 */
const MONEY_POSTS = [
  { file: 'lib/connectors/xero/sync-processor.ts', branches: ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION'] },
  { file: 'lib/connectors/quickbooks/sync-processor.ts', branches: ['INVOICE_PAYMENT', 'BILL_PAYMENT'] },
]

for (const target of MONEY_POSTS) {
  test(`${target.file}: every money branch posts INSIDE the fence (o3d-0m56)`, async () => {
    const source = await readFile(path.join(process.cwd(), target.file), 'utf8')
    const guards = source.split('return postMoneyUnderLedgerFence({').length - 1
    assert.equal(guards, target.branches.length,
      `expected one fenced post per money branch (${target.branches.join(', ')})`)

    // Codex round 4, CRITICAL #2: the bare fence returns a verdict and leaves the caller to post,
    // which is a decision and a write with a network round trip and no lock between them. A
    // processor must not be able to reach it — the only spelling available to a money branch is
    // the one that takes the lock and runs the post inside it.
    assert.equal(source.includes('authoriseMoneyPost('), false,
      'a processor must not call the unlocked fence directly')

    for (const branch of target.branches) {
      const at = source.indexOf(`case '${branch}': {`)
      assert.notEqual(at, -1, `${branch} branch must exist`)
      const body = source.slice(at, source.indexOf('\n    case ', at + 10))
      const guardAt = body.indexOf('postMoneyUnderLedgerFence({')
      assert.notEqual(guardAt, -1, `${branch} must post under the fence`)

      // ...and the request must be INSIDE the callback, not merely after the call.
      const callbackAt = body.indexOf('}, async () => {', guardAt)
      assert.notEqual(callbackAt, -1, `${branch} must pass its post as the fence's callback`)
      const postAt = body.search(/xeroPost<|qboPostIdempotent<|allocatePurchaseCreditNote\(/)
      assert.ok(postAt > callbackAt, `${branch} must post inside the fence, not after it`)
    }
  })
}

test('a FRESH row in a scope where something has ALREADY been sent is checked too (o3d-0m56)', async () => {
  // Codex round 3. A receipt recorded beside an older failed attempt queues a brand-new row, whose
  // authorisation came from a ledger reading taken before it existed. Its own stamp is unset, so
  // "first attempt" would be true of the ROW and false of the DOCUMENT — and the document is what
  // gets paid twice.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }],
  }
  const { db, counts } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    { id: 'log-old', remoteAttemptedAt: new Date('2026-07-01T00:00:00Z') },
  ])

  const verdict = await (await load())({ ...payment, entryId: 'log-new', db })

  assert.equal(verdict.proceed, false, 'the older attempt makes this a document that has been posted to')
  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
  assert.equal(counts.length, 1, 'and the scope is asked exactly once')
  assert.deepEqual(counts[0]!.id, { not: 'log-new' }, 'about the OTHER rows, not this one')
})

test('a fresh row in a scope nothing has been sent from posts once the ledger says so (o3d-0m56)', async () => {
  // The scope rule is unchanged: a sibling in ANOTHER scope, and an unattempted one in this
  // scope, are still not evidence and still do not make this row a repeat. What changed is that
  // "not a repeat" no longer means "do not look".
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    { id: 'log-other-scope', remoteAttemptedAt: new Date(), scope: 'INVOICE_PAYMENT SalesOrder so-2' },
    { id: 'log-unattempted', remoteAttemptedAt: null },
  ])

  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-new', db }), { proceed: true })
  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
})

/**
 * o3d-0m56 round 3 follow-up — THE RIVAL ATTEMPT IS A CONTENDER, NOT JUST A TRIGGER.
 *
 * The sibling check above notices that something else in the scope has been sent and then reads
 * the ledger about THIS row only. That is the hole the mark was invented to close, reopened one
 * level down: a payment committed by the rival carries the RIVAL's mark, derived from the rival's
 * token, so this row's marker cannot see it — and the amount-and-date fallback cannot either, the
 * moment the second receipt is entered for a different day or amount. Which is precisely what an
 * operator re-recording a payment they believe failed will do.
 *
 * So the fence judges every contender by its own mark, exactly as `planManualRetry` does.
 */

test('a rival attempt\'s committed payment is found by ITS OWN mark (o3d-0m56)', async () => {
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  // The payment log-old committed before its response was lost — and then had its amount and date
  // corrected in Xero, which is the case amount-and-date matching exists to be beaten by. Nothing
  // about it matches EITHER row's numbers any more; only the mark says who made it.
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const { db } = dbDouble([
    // The new receipt: a different day, a different amount. Its own mark is not in the ledger and
    // its own numbers match nothing there, so judged alone it is provably clear — and posting it
    // would settle an invoice that is already settled.
    { id: 'log-new', remoteAttemptedAt: null, payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' } },
    { id: 'log-old', remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'), payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' } },
  ])

  const verdict = await (await load())({
    ...payment,
    entryId: 'log-new',
    payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' },
    db,
  })

  assert.equal(verdict.proceed, false, 'the rival settled this document; sending again pays it twice')
  const error = verdict.proceed === false ? verdict.error : ''
  assert.match(error, /log-old/, 'and it must name the entry that settled it, or the operator cannot act')
  assert.match(error, /PAY-OLD/, 'and the settlement it found')
})

test('a rival against a DIFFERENT document does not strand this payment (o3d-0m56)', async () => {
  // The fence must not refuse on row count alone. An attempt against a replacement invoice cannot
  // have settled this one — and is not even covered by this probe — so it is not a contender.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }] }],
  }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    { id: 'log-old', remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'), payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' } },
  ])

  const verdict = await (await load())({
    ...payment,
    entryId: 'log-new',
    payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' },
    db,
  })
  assert.deepEqual(verdict, { proceed: true }, 'a payment against another invoice is not evidence about this one')
})

test('a rival too incomplete to have posted does not strand this payment (o3d-0m56)', async () => {
  // Judged the same way planManualRetry judges it: a body missing a field the connector requires
  // was rejected before any HTTP call, so it provably committed nothing. Without this, one
  // malformed row makes a valid payment unsendable for ever.
  xeroCalls.length = 0
  // The ledger DOES hold a settlement of the broken row's amount and date, and NOT of this row's.
  // That is what makes this test discriminating: were the malformed row treated as a contender it
  // would match here and this payment would be refused for ever. It provably never posted, so it
  // is not a contender and the match is not its. (The amounts differ deliberately — a settlement
  // matching THIS row's own numbers is a human settlement, which round 4 refuses on, and would
  // confound what this test is about.)
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-X', Date: '2026-08-01', Amount: 10 }] }],
  }
  const newPayload = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 42, paymentDate: '2026-09-09' }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: newPayload },
    // No bankAccountId: the Xero branch cannot build a request from this.
    { id: 'log-broken', remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'), payload: { accountingInvoiceId: 'inv-1', amount: 10, paymentDate: '2026-08-01' } },
  ])

  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-new', payload: newPayload, db }), { proceed: true })
})

test('a rival whose outcome cannot be read stops the post (o3d-0m56)', async () => {
  // Unknown is never clear — for a rival either. A contender with no amount or date recorded
  // cannot be matched against the ledger at all, and "I cannot tell" is not permission to send
  // money.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    { id: 'log-vague', remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'), payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 } },
  ])

  const verdict = await (await load())({ ...payment, entryId: 'log-new', db })
  assert.equal(verdict.proceed, false)
  assert.match(verdict.proceed === false ? verdict.error : '', /log-vague/)
})

/* ------------------------------------------------------------------------------------------- *
 * o3d-0m56 round 4 (Codex) — the three doubles the review said must exist.
 * ------------------------------------------------------------------------------------------- */

test('a BillPaymentCheck-shaped settlement stops a repeat bill payment (o3d-0m56 r4, CRITICAL 1)', async () => {
  // The link QuickBooks records on a Bill is named after the PayType, so IMS's own
  // `PayType: 'Check'` posts land as `BillPaymentCheck` — NOT `BillPayment`. A probe matching the
  // entity name found none of them, reported an empty ledger, and the fence read that as
  // permission to pay the bill a second time. This is the fence-level expression of that: the
  // settlement is real, it carries this entry's own mark, and the post must be refused.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  qboCalls.length = 0
  qboResponses = {
    'bill/bill-1': { Bill: { TotalAmt: 10, Balance: 0, LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }] } },
    'billpayment/77': {
      BillPayment: {
        TxnDate: '2026-08-01',
        PrivateNote: settlementMarkerFor('log-1'),
        Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }],
      },
    },
  }
  const billPayload = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'), payload: billPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' }])

  const verdict = await (await load())({
    connector: 'quickbooks',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-1',
    payload: billPayload,
    db,
  })

  assert.deepEqual(qboCalls, ['bill/bill-1', 'billpayment/77'])
  assert.equal(verdict.proceed, false, 'the bill is already paid; sending again pays it twice')
  assert.match(verdict.proceed === false ? verdict.error : '', /already holds a settlement/)
})

test('a human settlement made BEFORE any attempt stops the first post (o3d-0m56 r4, HIGH 3)', async () => {
  // The case a first attempt cannot know about from its own history, and the reason the free pass
  // is gone: an operator records the payment in Xero by hand, then marks the invoice paid in IMS.
  // The row that queues has never been sent, has no sibling, and — under the old rule — posted
  // without looking. The money is real.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      AmountPaid: 10,
      Payments: [{ PaymentID: 'PAY-HUMAN', Date: '2026-08-01', Amount: 10 }],
    }],
  }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })

  assert.deepEqual(xeroCalls, ['Invoices/inv-1'], 'the first attempt reads the ledger now')
  assert.equal(verdict.proceed, false)
  const error = verdict.proceed === false ? verdict.error : ''
  assert.match(error, /PAY-HUMAN/, 'and names the settlement, or the operator cannot reconcile it')
  assert.match(error, /recorded outside IMS/, 'and says whose it is, because it is not ours')
})

test('a settlement that is NOT this attempt still lets the first post through (o3d-0m56 r4)', async () => {
  // The discriminating other half. Refusing on the mere existence of a payment would strand every
  // second instalment; the rule is still same-amount-and-same-date, or our own mark.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      AmountPaid: 99,
      Payments: [{ PaymentID: 'PAY-OTHER', Date: '2026-06-01', Amount: 99 }],
    }],
  }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-1', db }), { proceed: true })
})

test('a first post is refused when the LEDGER cannot be read, and allowed when OUR ROW cannot be described (o3d-0m56 r4)', async () => {
  // The one place `unknown` does not refuse, pinned so it cannot spread. A ledger that will not
  // answer is a statement about the ledger — refuse. A payload with no date is a statement about
  // this row: the processors default a missing date to the day they run, so such a row can NEVER
  // be described, and refusing on it would make it permanently unsendable while telling us
  // nothing about whether the document is settled.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [] }
  const unreadable = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const refused = await (await load())({ ...payment, entryId: 'log-1', db: unreadable.db })
  assert.equal(refused.proceed, false, 'a first post on a reading that failed could pay it twice')
  assert.match(refused.proceed === false ? refused.error : '', /could not establish/)

  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }] }
  const undated = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 }
  const dateless = dbDouble([{ id: 'log-2', remoteAttemptedAt: null, payload: undated }])
  assert.deepEqual(
    await (await load())({ ...payment, entryId: 'log-2', payload: undated, db: dateless.db }),
    { proceed: true },
    'an undescribable FIRST attempt is not evidence of anything and must not be stranded',
  )
})

test('a first post is refused when a settlement it CANNOT MEASURE is present (o3d-0m56 r4)', async () => {
  // The third unknown, and it is a statement about the ledger, so it refuses like the first.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-?', Date: '2026-08-01' }] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })
  assert.equal(verdict.proceed, false)
})

test('a first post whose PINNED token already settled the document is caught by its own mark (o3d-0m56 r4)', async () => {
  // Why the virgin check carries a marker even though this row has never posted: a revival that
  // re-planned a row retention had deleted carries the SAME `_idempotencyKey` forward, so the
  // vanished predecessor's payment bears this row's mark and leaves no sibling behind to find it.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  const pinned = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20', _followUpIdempotencyKey: 'tok-vanished' }
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      // Nothing matches this row's numbers — only the mark says the document is already settled.
      Payments: [{ PaymentID: 'PAY-GHOST', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('tok-vanished') }],
    }],
  }
  const { db } = dbDouble([{ id: 'log-new', remoteAttemptedAt: null, payload: pinned }])

  const verdict = await (await load())({ ...payment, entryId: 'log-new', payload: pinned, db })
  assert.equal(verdict.proceed, false)
  assert.match(verdict.proceed === false ? verdict.error : '', /PAY-GHOST/)
})

/* --------------------------- CRITICAL 2: probe and post, serialized -------------------------- */

test('two rows racing the SAME document cannot both post (o3d-0m56 r4, CRITICAL 2)', async () => {
  // THE RACE. Both rows are fresh, both target the same invoice, both probe an empty ledger and
  // both were free to post: the fence read the ledger in the right place and still left a window
  // for a competing row to post inside it. The lock is what makes the read and the write one step.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: null },
    { id: 'log-b', remoteAttemptedAt: null },
  ])
  const { lock, contended, whenAcquired } = lockDouble()
  const fence = await loadFence()
  const posts: string[] = []

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let acquired!: () => void
  const acquiredP = new Promise<void>((resolve) => { acquired = resolve })
  whenAcquired(() => acquired())

  const first = fence({ ...payment, entryId: 'log-a', db, lock }, async () => {
    posts.push('log-a')
    await gate
    return { success: true, externalId: 'PAY-A' }
  })
  await acquiredP

  const second = await fence({ ...payment, entryId: 'log-b', db, lock }, async () => {
    posts.push('log-b')
    return { success: true, externalId: 'PAY-B' }
  })
  release()
  const winner = await first

  assert.deepEqual(posts, ['log-a'], 'exactly one row may be inside the probe→post span at a time')
  assert.equal(second.success, false)
  assert.match(second.error ?? '', /posting to the accounting connector right now/)
  assert.equal(contended.length, 1, 'and the loser was refused by the lock, not by luck')
  assert.deepEqual(winner, { success: true, externalId: 'PAY-A' })
})

test('the loser of the race is then refused by the LEDGER, not allowed through (o3d-0m56 r4)', async () => {
  // The other half of the same story: serialization only buys the second row a later reading, so
  // that reading has to be the thing that stops it. Once the winner's payment is in the ledger,
  // the retry sees the sibling's stamp, probes, and matches it by the SIBLING's own mark.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      AmountPaid: 10,
      Payments: [{ PaymentID: 'PAY-A', Date: '2026-08-01', Amount: 10, Reference: settlementMarkerFor('log-a') }],
    }],
  }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z') },
    { id: 'log-b', remoteAttemptedAt: null },
  ])
  const { lock } = lockDouble()
  const posts: string[] = []

  const outcome = await (await loadFence())({ ...payment, entryId: 'log-b', db, lock }, async () => {
    posts.push('log-b')
    return { success: true }
  })

  assert.deepEqual(posts, [], 'the post callback must never run when the fence refuses')
  assert.equal(outcome.success, false)
  assert.match(outcome.error ?? '', /log-a/)
})

test('the fence releases the lock even when the post throws (o3d-0m56 r4)', async () => {
  // A lock that leaked on an exception would make the document unpayable until the process
  // restarted — a worse outage than the bug it prevents.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, held } = lockDouble()
  const fence = await loadFence()

  await assert.rejects(
    fence({ ...payment, entryId: 'log-1', db, lock }, async () => { throw new Error('Xero exploded') }),
    /Xero exploded/,
  )
  assert.equal(held.size, 0, 'the lock must be released on the way out, however it is left')
})

test('rows for DIFFERENT documents do not serialize against each other (o3d-0m56 r4)', async () => {
  // The cost has to stay proportionate: the lock is per document, so two unrelated payments run
  // concurrently. A lock coarse enough to serialize the whole connector would be a throughput
  // bug wearing a safety badge.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: null },
    { id: 'log-b', remoteAttemptedAt: null, scope: 'INVOICE_PAYMENT SalesOrder so-2' },
  ])
  const { lock, contended, whenAcquired } = lockDouble()
  const fence = await loadFence()
  const posts: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let acquired!: () => void
  const acquiredP = new Promise<void>((resolve) => { acquired = resolve })
  whenAcquired(() => acquired())

  const first = fence({ ...payment, entryId: 'log-a', db, lock }, async () => {
    posts.push('log-a')
    await gate
    return { success: true }
  })
  await acquiredP
  const second = await fence({ ...payment, entryId: 'log-b', referenceId: 'so-2', db, lock }, async () => {
    posts.push('log-b')
    return { success: true }
  })
  release()
  await first

  assert.deepEqual(contended, [], 'a different document is a different lock')
  assert.equal(second.success, true)
  assert.deepEqual(posts.sort(), ['log-a', 'log-b'])
})

test('a non-money post takes no lock and no reading (o3d-0m56 r4)', async () => {
  xeroCalls.length = 0
  const { lock, acquisitions } = lockDouble()
  const { db, writes } = dbDouble([{ id: 'log-1', remoteAttemptedAt: new Date() }])
  const outcome = await (await loadFence())(
    { ...payment, type: 'INVOICE_PDF', entryId: 'log-1', db, lock },
    async () => ({ success: true, externalId: 'PDF' }),
  )
  assert.deepEqual(outcome, { success: true, externalId: 'PDF' })
  assert.deepEqual(acquisitions, [], 'ordinary queue traffic must not queue behind a payment')
  assert.deepEqual(xeroCalls, [])
  assert.deepEqual(writes, [])
})

test('a lock lost between the reading and the post stops the post (o3d-0m56 r4)', async () => {
  // PostgreSQL frees a session advisory lock the instant its connection dies. A verdict taken
  // under an exclusion that has since evaporated is not stale, it is void: another worker may be
  // inside its own probe→post span right now. The reading must not be spent on a post.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt, held } = lockDouble()
  loseIt()
  const posts: string[] = []

  await assert.rejects(
    (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      posts.push('log-1')
      return { success: true }
    }),
    /Advisory lock was lost/,
  )
  assert.deepEqual(posts, [], 'the post must not run once the exclusion is gone')
  assert.equal(held.size, 0)
})
