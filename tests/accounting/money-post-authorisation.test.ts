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

const load = async () => (await import('@/lib/connectors/accounting-settlement-probe')).authoriseMoneyPost

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

test('the FIRST attempt is stamped and allowed, with no ledger read (o3d-0m56)', async () => {
  xeroCalls.length = 0
  const { db, writes, rows } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db })

  assert.deepEqual(verdict, { proceed: true })
  assert.equal(writes.length, 1, 'the attempt must be recorded BEFORE the call, not after it')
  assert.notEqual(rows[0]!.remoteAttemptedAt, null)
  assert.deepEqual(xeroCalls, [], 'nothing to check — a first attempt cannot duplicate anything')
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
  test(`${target.file}: every money branch authorises before it posts (o3d-0m56)`, async () => {
    const source = await readFile(path.join(process.cwd(), target.file), 'utf8')
    const guards = source.split('const authorised = await authoriseMoneyPost({').length - 1
    assert.equal(guards, target.branches.length,
      `expected one guard per money branch (${target.branches.join(', ')})`)

    for (const branch of target.branches) {
      const at = source.indexOf(`case '${branch}': {`)
      assert.notEqual(at, -1, `${branch} branch must exist`)
      const body = source.slice(at, source.indexOf('\n    case ', at + 10))
      const guardAt = body.indexOf('authoriseMoneyPost')
      assert.notEqual(guardAt, -1, `${branch} must authorise`)
      assert.match(body.slice(guardAt, guardAt + 400), /if \(!authorised\.proceed\) return \{ success: false, error: authorised\.error \}/,
        `${branch} must stop on a refusal`)

      // ...and BEFORE the request, not after it.
      const postAt = body.search(/xeroPost<|qboPostIdempotent<|allocatePurchaseCreditNote\(/)
      assert.ok(postAt > guardAt, `${branch} must authorise before it posts`)
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

test('a fresh row in a scope nothing has been sent from posts freely (o3d-0m56)', async () => {
  // The cost has to stay proportionate: the ordinary first payment for an order must not pay for a
  // ledger read it has no reason to make.
  xeroCalls.length = 0
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    // A sibling in ANOTHER scope, and an unattempted one in this scope: neither is evidence.
    { id: 'log-other-scope', remoteAttemptedAt: new Date(), scope: 'INVOICE_PAYMENT SalesOrder so-2' },
    { id: 'log-unattempted', remoteAttemptedAt: null },
  ])

  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-new', db }), { proceed: true })
  assert.deepEqual(xeroCalls, [])
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
  // The ledger DOES hold a settlement of the broken row's amount and date. That is what makes this
  // test discriminating: were the malformed row treated as a contender, it would match here and
  // this payment would be refused for ever. It provably never posted, so it is not a contender and
  // the match is not its.
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-X', Date: '2026-08-01', Amount: 10 }] }],
  }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    // No bankAccountId: the Xero branch cannot build a request from this.
    { id: 'log-broken', remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'), payload: { accountingInvoiceId: 'inv-1', amount: 10, paymentDate: '2026-08-01' } },
  ])

  assert.deepEqual(await (await load())({ ...payment, entryId: 'log-new', db }), { proceed: true })
  assert.deepEqual(xeroCalls, [], 'and with no contender left there is nothing for a ledger read to rule out')
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
