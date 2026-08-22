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

/** Where the lost-exclusion incident is asserted to be DURABLE (round 6, HIGH 4). */
const activityEntries: Array<Record<string, unknown>> = []
/**
 * How many of the next writes FAIL to persist (round 7, MEDIUM 3).
 *
 * `logActivityPersisted` never throws — it reports. A double that always returned `true` would
 * make "the incident is durable" a claim about a function that cannot fail, which is exactly the
 * false premise the old `logActivity` double carried: it recorded the call and could not express a
 * write that was accepted and then lost.
 */
let activityWriteFailures = 0
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivityPersisted: async (params: Record<string, unknown>) => {
      activityEntries.push(params)
      if (activityWriteFailures > 0) {
        activityWriteFailures -= 1
        return false
      }
      return true
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
    document: { connector: string; type: string; referenceType: string; referenceId: string; documentKey: string },
    run: (held: { assertHeld: (context?: string) => void; readonly lost: boolean }) => Promise<T>,
  ): Promise<{ locked: true; result: T } | { locked: false }> => {
    // Keyed on the DOCUMENT (round 6, CRITICAL 2). Keying this double on the scope would have made
    // every cross-scope serialization test pass against a lock that does not serialize them.
    const key = [document.connector, document.documentKey].join(' ')
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
          // `lost` is a GETTER, not a snapshot: the whole hazard is that the connection dies
          // between the assertion and the post returning, so a double that captured the flag at
          // entry could never express it.
          get lost() { return lost },
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
          // Implemented, not stubbed to []: a query that silently answered "nothing" would make the
          // sibling check vacuous, which is the whole point of the check. BOTH arms of the OR are
          // evaluated — a double that only understood the scope arm would make the cross-scope
          // contender (round 6, CRITICAL 2) untestable, which is how it stayed a residual.
          const arms = where.OR as Array<Record<string, never>>
          return rows.filter((r) => {
            if (r.remoteAttemptedAt === null) return false
            if (r.id === (where.id as { not: string }).not) return false
            return arms.some((arm: Record<string, unknown>) => {
              if ('referenceType' in arm) {
                return (r.scope ?? SCOPE) === `${where.type} ${arm.referenceType} ${arm.referenceId}`
              }
              // BOTH JSON PREDICATE SHAPES, EACH AS POSTGRES REALLY EVALUATES IT — verified against
              // `onetwo3d_ims_dev` (Prisma 7.7.0) with a mixed-case row in a rolled-back
              // transaction:
              //   `equals`                         → `payload#>path = $1`, byte-exact: matched 0
              //   `string_contains` + insensitive  → `LOWER(payload#>>path) LIKE LOWER('%'||$1||'%')
              //                                      AND JSONB_TYPEOF(payload#>path) = 'string'`
              // Modelling `equals` too is deliberate: it is what the query said before round 8, so
              // reverting the production change makes the rival genuinely unfetchable here rather
              // than crashing the double, and the test fails for the reason the bug fails.
              const json = arm.payload as { path: string[]; equals?: string; string_contains?: string; mode?: string }
              const payload = (r.payload ?? DEFAULT_PAYLOAD) as Record<string, unknown>
              const value = payload[json.path[0]!]
              if (typeof json.equals === 'string') return value === json.equals
              if (typeof json.string_contains !== 'string') return false
              if (typeof value !== 'string') return false
              return json.mode === 'insensitive'
                ? value.toLowerCase().includes(json.string_contains.toLowerCase())
                : value.includes(json.string_contains)
            })
          }).map((r) => ({ id: r.id, payload: r.payload ?? DEFAULT_PAYLOAD }))
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
  // What the processor branch resolved ONCE and is putting on the wire (round 7, HIGH 1). It is a
  // required parameter, so every call site here has to state the date its post is sending — which
  // is the whole point: the fence has no clock of its own to disagree with.
  postingDate: '2026-08-01',
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

      // ...and it must HAND OVER the date it resolved, not leave the fence to resolve one (round
      // 7, HIGH 1). The variable asserted here is the same one the branch puts on the wire, so
      // the date the post is authorised against and the date the ledger will hold are one value.
      const resolved = /const (\w+) = posting\.date/.exec(body)
      assert.ok(resolved, `${branch} must resolve its date from moneyPostDateToSend`)
      const params = body.slice(guardAt, callbackAt)
      assert.ok(params.includes(`postingDate: ${resolved![1]},`),
        `${branch} must carry ${resolved![1]} to the fence as postingDate`)
      assert.ok(body.indexOf(`${resolved![1]},`, postAt) > 0 || body.includes(`Date: ${resolved![1]}`)
        || body.includes(`TxnDate: ${resolved![1]}`) || body.includes(`date: ${resolved![1]}`),
        `${branch} must send the very value it handed the fence`)
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

test('a fresh row against a document nothing has been sent to posts once the ledger says so (o3d-0m56)', async () => {
  // What is NOT evidence, after round 6: an attempt against ANOTHER DOCUMENT (wherever it is
  // filed), and an unattempted row against this one. Another SCOPE is no longer on that list —
  // see the cross-scope test below — so the sibling here is given an invoice of its own, which is
  // what "unrelated" has to mean now.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null },
    {
      id: 'log-other-document',
      remoteAttemptedAt: new Date(),
      scope: 'INVOICE_PAYMENT SalesOrder so-2',
      payload: { accountingInvoiceId: 'inv-2', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
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
    postingDate: '2026-09-20',
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
    postingDate: '2026-09-20',
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

  assert.deepEqual(
    await (await load())({ ...payment, entryId: 'log-new', payload: newPayload, postingDate: '2026-09-09', db }),
    { proceed: true },
  )
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
    postingDate: '2026-08-01',
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

test('a first post is refused when the LEDGER cannot be read (o3d-0m56 r4)', async () => {
  // A ledger that will not answer is a statement about the ledger, and the fence has no business
  // paying money on a reading that failed.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [] }
  const unreadable = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const refused = await (await load())({ ...payment, entryId: 'log-1', db: unreadable.db })
  assert.equal(refused.proceed, false, 'a first post on a reading that failed could pay it twice')
  assert.match(refused.proceed === false ? refused.error : '', /could not establish/)
})

/* ------------- round 5, CRITICAL 1: a virgin row with no pinned date is DESCRIBED ------------ */

const POSTING_TODAY = () => new Date('2026-08-18T09:00:00Z')

test('a virgin row with NO PINNED DATE is judged on the date it will post (o3d-0m56 r5, CRITICAL 1)', async () => {
  // THE HOLE ROUND 4 LEFT. `attempt-undescribable` was allowed to proceed on the reasoning that a
  // row the processors date "today at post time" can never be described — which let a virgin
  // undated row walk straight past a settlement the probe could SEE. It is describable: the row
  // has not been sent yet, so the date it WILL carry is exactly what the branch below the fence
  // computes, `payload.paymentDate || today`.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      AmountPaid: 10,
      // The human recorded it today, which is the day this row would post for.
      Payments: [{ PaymentID: 'PAY-TODAY', Date: '2026-08-18', Amount: 10 }],
    }],
  }
  const undated = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: undated }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', payload: undated, postingDate: '2026-08-18', db, now: POSTING_TODAY })

  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
  assert.equal(verdict.proceed, false, 'the settlement is the payment this row is about to make again')
  assert.match(verdict.proceed === false ? verdict.error : '', /PAY-TODAY/)
})

test('a virgin undated row is NOT stranded by a settlement it would not create (o3d-0m56 r5)', async () => {
  // The discriminating half: pinning the date must not become "any settlement refuses". A receipt
  // for the same amount on a different day is a different payment, and instalments are ordinary.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      AmountPaid: 10,
      Payments: [{ PaymentID: 'PAY-JUNE', Date: '2026-06-01', Amount: 10 }],
    }],
  }
  const undated = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: undated }])
  assert.deepEqual(
    await (await load())({ ...payment, entryId: 'log-1', payload: undated, postingDate: '2026-08-18', db, now: POSTING_TODAY }),
    { proceed: true },
  )
})

test('a row that CANNOT be described may not walk past a visible settlement (o3d-0m56 r5, CRITICAL 1)', async () => {
  // What is left once the date is pinned: a payload with no readable AMOUNT (or a date field set
  // to something the processors would send verbatim and this module cannot predict). Such a row
  // still cannot say what it would create — so it is not allowed to reason its way past what the
  // ledger visibly holds. Refusing on the row's own indescribability is the point: the ledger is
  // not being read as clear, it is being read as "something is there and IMS cannot tell".
  // The third element is what the processor branch is ACTUALLY sending — `moneyPostDateToSend`
  // reports `'2026-08'` verbatim, because that is the string the branch puts on the wire and Xero
  // will normalise it to something this module cannot predict.
  for (const [label, undescribable, postingDate] of [
    ['no amount', { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', paymentDate: '2026-08-01' }, '2026-08-01'],
    ['a date it cannot predict', { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 99, paymentDate: '2026-08' }, '2026-08'],
  ] as const) {
    xeroCalls.length = 0
    xeroResponse = {
      Invoices: [{
        InvoiceID: 'inv-1',
        AmountPaid: 10,
        Payments: [{ PaymentID: 'PAY-HUMAN', Date: '2026-08-01', Amount: 10 }],
      }],
    }
    const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: undescribable }])
    const verdict = await (await load())({ ...payment, entryId: 'log-1', payload: undescribable, postingDate, db, now: POSTING_TODAY })
    assert.equal(verdict.proceed, false, `${label}: a visible settlement must stop it`)
    assert.match(verdict.proceed === false ? verdict.error : '', /Resolve this entry by hand/, label)
  }
})

test('an undescribable row still posts against a ledger that positively holds NOTHING (o3d-0m56 r5)', async () => {
  // The other half, and the reason this is not simply "refuse". An empty ledger is the one state
  // in which there is nothing to duplicate, so such a row is not permanently unsendable — which
  // was the correct half of round 4's reasoning.
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 0, Payments: [] }] }
  const noAmount = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', paymentDate: '2026-08-01' }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: noAmount }])
  assert.deepEqual(
    await (await load())({ ...payment, entryId: 'log-1', payload: noAmount, postingDate: '2026-08-01', db, now: POSTING_TODAY }),
    { proceed: true },
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

  const verdict = await (await load())({ ...payment, entryId: 'log-new', payload: pinned, postingDate: '2026-09-20', db })
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
  // bug wearing a safety badge. A DIFFERENT SCOPE is no longer what makes them different (round
  // 6) — a different invoice is.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }
  const otherDocument = { accountingInvoiceId: 'inv-2', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: null },
    { id: 'log-b', remoteAttemptedAt: null, scope: 'INVOICE_PAYMENT SalesOrder so-2', payload: otherDocument },
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
  const second = await fence({ ...payment, entryId: 'log-b', referenceId: 'so-2', payload: otherDocument, db, lock }, async () => {
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

/* ---------------- round 5, CRITICAL 2: the lock that dies DURING the call ---------------- */

/** Capture what the fence announces, so "it is detectable" is asserted rather than asserted-about. */
function captureErrors() {
  const lines: string[] = []
  const spy = mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  return { lines, restore: () => spy.mock.restore() }
}

test('a lock lost DURING the post is detected afterwards and announced (o3d-0m56 r5, CRITICAL 2)', async () => {
  // THE RESIDUAL `assertHeld` CANNOT COVER. It runs before the call; the pinned connection can die
  // after it and while the HTTP request is in flight, and no re-check makes a check-then-act
  // atomic against a remote system. So the exclusion is asked about again once the call has
  // returned — the first moment the answer is knowable — and a post made without it is announced.
  //
  // The successful outcome is KEPT: the payment is real, and its externalId is the handle any
  // reversal needs. Throwing it away would hide a real payment and prevent nothing.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { lines, restore } = captureErrors()
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      // The connection dies mid-flight: the assertion has already passed.
      loseIt()
      return { success: true, externalId: 'PAY-A' }
    })
    assert.deepEqual(outcome, { success: true, externalId: 'PAY-A' }, 'the payment is real; do not discard its id')
    const announced = lines.filter((l) => l.includes('[money-post] EXCLUSION LOST'))
    assert.equal(announced.length, 1, 'a post made without its exclusion must be announced, not inferred later')
    assert.match(announced[0] ?? '', /entry=log-1/)
    assert.match(announced[0] ?? '', /scope=SalesOrder:so-1/, 'and name the document, or it cannot be reconciled')
    assert.match(announced[0] ?? '', /outcome=committed/)
  } finally {
    restore()
  }
})

test('a FAILED post whose lock was lost is reported as unsafe, not as an ordinary failure (o3d-0m56 r5)', async () => {
  // A failure and a lost exclusion together is the worst-read case: the call may still have
  // committed. The row must not go back as a plain "Xero said no" that reads as "try again".
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { lines, restore } = captureErrors()
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: false, error: 'HTTP 504' }
    })
    assert.equal(outcome.success, false)
    assert.match(outcome.error ?? '', /lock for this document was lost/)
    assert.match(outcome.error ?? '', /HTTP 504/, 'the connector\'s own words are kept, not replaced')
    assert.match(outcome.error ?? '', /duplicate/)
    assert.equal(lines.filter((l) => l.includes('[money-post] EXCLUSION LOST')).length, 1)
  } finally {
    restore()
  }
})

test('a post that THREW with the lock lost still announces the exclusion (o3d-0m56 r5)', async () => {
  // The throw path bypasses every return statement in the fence, which is exactly how a detection
  // written only on the happy path goes missing.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt, held } = lockDouble()
  const { lines, restore } = captureErrors()
  try {
    await assert.rejects(
      (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
        loseIt()
        throw new Error('socket hang up')
      }),
      /socket hang up/,
    )
    const announced = lines.filter((l) => l.includes('[money-post] EXCLUSION LOST'))
    assert.equal(announced.length, 1)
    assert.match(announced[0] ?? '', /outcome=threw/)
    assert.equal(held.size, 0, 'and the lock is still released on the way out')
  } finally {
    restore()
  }
})

test('a post whose lock SURVIVES announces nothing (o3d-0m56 r5)', async () => {
  // The alarm has to be silent in the ordinary case or it is noise, and noise is not detection.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock } = lockDouble()
  const { lines, restore } = captureErrors()
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => ({ success: true, externalId: 'PAY-A' }))
    assert.deepEqual(outcome, { success: true, externalId: 'PAY-A' })
    assert.deepEqual(lines.filter((l) => l.includes('[money-post] EXCLUSION LOST')), [])
  } finally {
    restore()
  }
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

/* ------------------------------------------------------------------------------------------- *
 * o3d-0m56 round 6 (Codex) — the three doubles this round has to express.
 * ------------------------------------------------------------------------------------------- */

test('a bill payment is judged on the date the PROCESSOR will send, not the payload\'s other date field (o3d-0m56 r6, CRITICAL 1)', async () => {
  // THE MIRROR THAT DRIFTED. Round 5 predicted the post's date with `paymentDate ?? date` for
  // every type. Both payment branches read ONLY `paymentDate`, so a bill payment carrying the
  // BILL's `date` and no `paymentDate` was predicted to post on 2026-07-04 when the processor
  // will in fact post TODAY. The probe went looking for a settlement on a day the post will never
  // create, found none, and authorised a second payment onto a bill a human settled this morning.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'bill-1',
      Total: 10,
      AmountDue: 0,
      AmountPaid: 10,
      Payments: [{ PaymentID: 'PAY-TODAY', Date: '2026-08-18', Amount: 10 }],
    }],
  }
  // No `paymentDate`; a `date` that is NOT what this branch sends.
  const billPayload = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 10, date: '2026-07-04' }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: billPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' }])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-1',
    payload: billPayload,
    // What `moneyPostDateToSend` gave the BILL_PAYMENT branch: this type reads `paymentDate` only,
    // and the payload pins none, so the branch is sending today.
    postingDate: '2026-08-18',
    db,
    now: POSTING_TODAY,
  })

  assert.equal(verdict.proceed, false, 'the bill is already settled for the day this post will carry')
  assert.match(verdict.proceed === false ? verdict.error : '', /PAY-TODAY/)
})

test('an allocation is judged on `date`, not on a stray `paymentDate` (o3d-0m56 r6, CRITICAL 1)', async () => {
  // The same drift the other way round, which is why the difference between the branches has to
  // be REPRESENTED rather than averaged: Xero's allocation branch dates itself from `date` and
  // ignores `paymentDate` entirely, so a payload carrying only the latter posts for TODAY.
  xeroCalls.length = 0
  xeroResponse = {
    CreditNotes: [{
      CreditNoteID: 'cn-1',
      Total: 10,
      RemainingCredit: 0,
      Allocations: [{ Amount: 10, Date: '2026-08-18', Invoice: { InvoiceID: 'bill-1' } }],
    }],
  }
  const allocation = { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1', amount: 10, paymentDate: '2026-07-04' }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: allocation, scope: 'PURCHASE_CREDIT_NOTE_ALLOCATION SupplierCreditNote scn-1' }])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
    referenceType: 'SupplierCreditNote',
    referenceId: 'scn-1',
    entryId: 'log-1',
    payload: allocation,
    // An allocation dates itself from `date`, which this payload does not pin — so the branch sends
    // today, and the stray `paymentDate` is not what Xero receives.
    postingDate: '2026-08-18',
    db,
    now: POSTING_TODAY,
  })

  assert.deepEqual(xeroCalls, ['CreditNotes/cn-1'])
  assert.equal(verdict.proceed, false, 'this credit is already allocated to this bill for that day')
})

test('a rival in ANOTHER SCOPE naming the same document is a contender (o3d-0m56 r6, CRITICAL 2)', async () => {
  // THE HOLE CARRIED AS A RESIDUAL FOR TWO ROUNDS. The sibling query asked only about
  // (referenceType, referenceId) — where the row lives in IMS. A bill payment queued against the
  // PurchaseOrder in one release and re-queued against the PurchaseInvoice in the next is TWO
  // scopes and ONE bill: the older row was invisible, this row looked virgin, and its own mark and
  // its own numbers match nothing, so it was cleared to pay a bill that is already paid.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'bill-1',
      Total: 25,
      AmountDue: 13.5,
      AmountPaid: 11.5,
      // Committed by log-old, then corrected in Xero — only the mark still says whose it is.
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const newPayload = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' }
  const { db, counts } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: newPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
    {
      id: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      // A DIFFERENT scope entirely — and the same bill.
      scope: 'BILL_PAYMENT PurchaseOrder po-1',
      payload: { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-new',
    payload: newPayload,
    postingDate: '2026-09-20',
    db,
  })

  assert.equal(verdict.proceed, false, 'the rival settled this bill; sending again pays it twice')
  assert.match(verdict.proceed === false ? verdict.error : '', /log-old/)
  const where = counts[0] as { OR: Array<Record<string, unknown>> }
  assert.deepEqual(where.OR[0], { referenceType: 'PurchaseInvoice', referenceId: 'pi-1' }, 'scope arm first')
  // The document arm matches the id in ANY case (round 8, HIGH 1): `equals` on a JSON path is
  // byte-exact, and the three spellings round 7 enumerated still missed a mixed-case rival, so the
  // fold is done by the database inside the predicate instead.
  assert.deepEqual(where.OR.slice(1), [
    { payload: { path: ['accountingInvoiceId'], string_contains: 'bill-1', mode: 'insensitive' } },
  ], 'document arm second, case-folded by the predicate')
})

test('two rows in DIFFERENT scopes naming one document take the SAME lock (o3d-0m56 r6, CRITICAL 2)', async () => {
  // The other half of the same hole: even with the sibling query fixed, two rows in different
  // scopes each probing an empty ledger and each posting is a double payment, and a scope-keyed
  // lock serialized neither of them.
  xeroResponse = { Invoices: [{ InvoiceID: 'bill-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const billPayload = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: null, payload: billPayload, scope: 'BILL_PAYMENT PurchaseOrder po-1' },
    { id: 'log-b', remoteAttemptedAt: null, payload: billPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
  ])
  const { lock, contended, whenAcquired } = lockDouble()
  const fence = await loadFence()
  const posts: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let acquired!: () => void
  const acquiredP = new Promise<void>((resolve) => { acquired = resolve })
  whenAcquired(() => acquired())

  const bill = { connector: 'xero' as const, type: 'BILL_PAYMENT', payload: billPayload, postingDate: '2026-08-01', db, lock }
  const first = fence({ ...bill, referenceType: 'PurchaseOrder', referenceId: 'po-1', entryId: 'log-a' }, async () => {
    posts.push('log-a')
    await gate
    return { success: true, externalId: 'PAY-A' }
  })
  await acquiredP
  const second = await fence({ ...bill, referenceType: 'PurchaseInvoice', referenceId: 'pi-1', entryId: 'log-b' }, async () => {
    posts.push('log-b')
    return { success: true, externalId: 'PAY-B' }
  })
  release()
  await first

  assert.deepEqual(posts, ['log-a'], 'one bill, one probe→post span at a time, whatever scope the row is filed under')
  assert.equal(second.success, false)
  assert.equal(contended.length, 1, 'and the loser was refused by the lock, not by luck')
})

test('a Xero credit note Xero says is APPLIED is not reported as unallocated (o3d-0m56 r6, HIGH 3)', async () => {
  // `Allocations` absent and `Allocations` empty are the same value in JavaScript, and this branch
  // had no cross-check at all — so a credit note Xero reports as fully applied came back as
  // "positively nothing settles this bill", which the classifier reads as CLEAR and the fence acts
  // on by allocating it a second time.
  xeroCalls.length = 0
  xeroResponse = { CreditNotes: [{ CreditNoteID: 'cn-1', Total: 10, RemainingCredit: 0 }] }
  const allocation = { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1', amount: 10, date: '2026-08-18' }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: allocation, scope: 'PURCHASE_CREDIT_NOTE_ALLOCATION SupplierCreditNote scn-1' }])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
    referenceType: 'SupplierCreditNote',
    referenceId: 'scn-1',
    entryId: 'log-1',
    payload: allocation,
    postingDate: '2026-08-18',
    db,
    now: POSTING_TODAY,
  })

  assert.equal(verdict.proceed, false)
  assert.match(verdict.proceed === false ? verdict.error : '', /could not establish/)
})

test('a Xero invoice settled by a CREDIT the payments do not explain stops the post (o3d-0m56 r6, HIGH 3)', async () => {
  // A credit-note allocation reduces `AmountCredited`, never `AmountPaid`, and never appears in
  // `Payments`. An invoice a human settled with a credit note therefore reads as
  // `AmountPaid: 0, Payments: []` — the strongest answer the probe can give, and false.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 0, AmountPaid: 0, AmountCredited: 10, Payments: [] }],
  }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])

  const verdict = await (await load())({ ...payment, entryId: 'log-1', db, now: POSTING_TODAY })

  assert.equal(verdict.proceed, false, 'money has come off this invoice that no readable payment explains')
  assert.match(verdict.proceed === false ? verdict.error : '', /credited, not paid/)
})

test('a lost exclusion leaves a DURABLE incident, not just a stderr line (o3d-0m56 r6, HIGH 4)', async () => {
  // Round 5 wrote this to stderr and called it announced. Stderr is a stream: whoever is watching
  // at that second sees it and nobody else ever does. The sync row cannot carry it either — the
  // success write sets `errorMessage: null` immediately afterwards — so the incident goes to the
  // activity log, at ERROR, naming the document.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { restore } = captureErrors()
  activityEntries.length = 0
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: true, externalId: 'PAY-A' }
    })
    assert.deepEqual(outcome, { success: true, externalId: 'PAY-A' })
  } finally {
    restore()
  }

  assert.equal(activityEntries.length, 1, 'a post made without its exclusion must survive the process that made it')
  const entry = activityEntries[0] as Record<string, unknown>
  assert.equal(entry.level, 'ERROR')
  assert.equal(entry.action, 'money_post_exclusion_lost')
  assert.equal(entry.entityType, 'SYNC')
  assert.equal(entry.entityId, 'log-1')
  const metadata = entry.metadata as Record<string, unknown>
  assert.equal(metadata.documentKey, '["invoice_payment","inv-1"]',
    'and name the document, or it cannot be reconciled')
  assert.equal(metadata.externalId, 'PAY-A', 'and the payment id a reversal would need')
  assert.equal(metadata.outcome, 'committed')
})

test('a FAILED and a THROWN post with a lost lock are durable too (o3d-0m56 r6, HIGH 4)', async () => {
  // Both non-happy paths, because a record written only where the code returns normally is exactly
  // how an incident goes missing on the path that needs it most.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  for (const [label, post] of [
    ['failed', async () => ({ success: false, error: 'HTTP 504' })],
    ['threw', async () => { throw new Error('socket hang up') }],
  ] as const) {
    const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
    const { lock, loseIt } = lockDouble()
    const { restore } = captureErrors()
    activityEntries.length = 0
    try {
      const run = (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
        loseIt()
        return post()
      })
      if (label === 'threw') await assert.rejects(run, /socket hang up/)
      else await run
    } finally {
      restore()
    }
    assert.equal(activityEntries.length, 1, `${label}: the incident must be durable here too`)
    assert.equal((activityEntries[0] as Record<string, unknown>).action, 'money_post_exclusion_lost', label)
    assert.equal(((activityEntries[0] as Record<string, unknown>).metadata as Record<string, unknown>).outcome, label, label)
  }
})

test('a post whose lock survives writes no incident (o3d-0m56 r6, HIGH 4)', async () => {
  // An incident channel that fires on the ordinary case is noise, and noise is not detection.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock } = lockDouble()
  activityEntries.length = 0
  await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => ({ success: true, externalId: 'PAY-A' }))
  assert.deepEqual(activityEntries, [])
})

test('the fence has an index for the attempted-rows lookup it now makes (o3d-0m56 r6)', async () => {
  // The document arm of the sibling query is a JSON predicate no index serves, and it runs inside
  // the money-post lock. What keeps it cheap is that `remoteAttemptedAt` is written by exactly one
  // place — the fence, immediately before a remote money call — so a PARTIAL index on it is the
  // set of payments this business has ever made, not the whole sync log.
  const sql = await readFile(
    path.join(process.cwd(), 'prisma/migrations/20260818140000_money_post_attempted_document_index/migration.sql'),
    'utf8',
  )
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "accounting_sync_logs_money_attempted_idx"/)
  assert.match(sql, /ON "accounting_sync_logs" \("connector", "type"\)/)
  assert.match(sql, /WHERE "remoteAttemptedAt" IS NOT NULL/, 'partial, or it indexes every sync row ever written')
})

test('no other copy of the money-post date rule survives (o3d-0m56 r6, CRITICAL 1)', async () => {
  // Finding 1 was a SECOND copy of one rule. The registration path held a third, and a fourth would
  // be found the same way it was: by a payment nobody can explain.
  //
  // SUPERSEDED LOCATION, SAME PROPERTY: o3d-ekn8 lifted that path out of the 'use server' file into
  // lib/domain/accounting/invoice-payment-enqueue.ts so the connector could re-drive it. BOTH files
  // are checked for the copy — the rule must not be re-spelt in either, and pinning only the new one
  // would let a copy reappear in the old.
  const enqueue = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/invoice-payment-enqueue.ts'), 'utf8',
  )
  const salesActions = await readFile(path.join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  for (const [name, source] of [['invoice-payment-enqueue.ts', enqueue], ['sales.ts', salesActions]] as const) {
    assert.equal(/payload\.paymentDate\.slice\(0, 10\)/.test(source), false,
      `${name} must date attempts from the shared function, not a local copy of the rule`)
  }
  assert.ok(enqueue.includes("pinnedAttemptDate('INVOICE_PAYMENT'"),
    'the registration path must carry the attempt date from the shared money-post date rule')
})

/* ----------------- round 7, HIGH 1: one clock reading, carried, not two ----------------- */

test('a post spanning a UTC MIDNIGHT is judged on the date it is sending (o3d-0m56 r7, HIGH 1)', async () => {
  // ROUND 6 REMOVED THE MIRROR AND LEFT THE CLOCK. Both sides called one function — and its
  // wall-clock arm answers about whatever `Date` it is handed, so the processor resolving at
  // 23:59:59.900Z and the fence resolving at 00:00:00.100Z got two different DAYS. The probe then
  // hunted a settlement dated the 19th while the post was about to create one dated the 18th, so
  // the payment a human entered on the 18th matched nothing and a second one was authorised. A
  // weakened match is not a conservative failure on this path; it IS the double post.
  const { moneyPostDateToSend } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'inv-1',
      Total: 10,
      AmountDue: 0,
      AmountPaid: 10,
      // The human recorded it on the 18th — the day this post is dated, not the day the fence
      // would have read off its own clock.
      Payments: [{ PaymentID: 'PAY-HUMAN', Date: '2026-08-18', Amount: 10 }],
    }],
  }
  const undated = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 }
  // The processor resolves the date it will send, a breath before midnight...
  const sending = moneyPostDateToSend('INVOICE_PAYMENT', undated, new Date('2026-08-18T23:59:59.900Z'))
  assert.equal(sending.ok && sending.date, '2026-08-18')
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: undated }])

  const verdict = await (await load())({
    ...payment,
    entryId: 'log-1',
    payload: undated,
    postingDate: sending.ok ? sending.date : '',
    db,
    // ...and the fence runs a breath after it. Anything the fence resolves for itself is now the
    // NEXT day.
    now: () => new Date('2026-08-19T00:00:00.100Z'),
  })

  assert.deepEqual(xeroCalls, ['Invoices/inv-1'])
  assert.equal(verdict.proceed, false,
    'the settlement is the payment this row is about to make again, whatever day the fence woke up on')
  assert.match(verdict.proceed === false ? verdict.error : '', /PAY-HUMAN/)
})

test('the fence resolves no posting date of its own (o3d-0m56 r7, HIGH 1)', async () => {
  // The structural half. One shared function was not enough, because it could be CALLED twice; the
  // fence must have no way to ask for a wall-clock posting date at all, so that the value it
  // authorises against can only be the one the caller is sending.
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/accounting-settlement-probe.ts'), 'utf8')
  assert.equal(/plannedAttemptDate\(/.test(source), false,
    'the resolver the fence used to call must not be called by it')
  assert.equal(/moneyPostDateToSend\(/.test(source), false,
    'and it must not resolve the send date itself either — the caller has already done it')
  const evidence = await readFile(path.join(process.cwd(), 'lib/domain/accounting/ledger-settlement-evidence.ts'), 'utf8')
  assert.equal(/export function plannedAttemptDate/.test(evidence), false,
    'an on-demand wall-clock resolver is a second resolution site waiting to be used')
})

/* ------------- round 7, HIGH 2: one document id, two spellings, one exclusion ------------- */

test('a rival naming the same document in ANOTHER CASE is a contender (o3d-0m56 r7, HIGH 2)', async () => {
  // A Xero GUID is case-insensitive: `4D8A…` and `4d8a…` are one invoice. Compared byte-exactly,
  // the rival was declared a DIFFERENT document and dropped from the contender list — so this row
  // looked virgin, its own mark matched nothing, and it was cleared to pay an invoice the rival
  // has already paid.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const LOWER = '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44'
  const UPPER = LOWER.toUpperCase()
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: LOWER,
      Total: 25,
      AmountDue: 13.5,
      AmountPaid: 11.5,
      // The rival's payment, corrected in Xero afterwards — only its own mark still names it.
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const ours = { accountingInvoiceId: LOWER, bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: ours },
    {
      id: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      // Same scope, so the query returns it either way: what used to drop it was the anchor
      // comparison, one level further in.
      payload: { accountingInvoiceId: UPPER, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({ ...payment, entryId: 'log-new', payload: ours, postingDate: '2026-09-20', db })

  assert.equal(verdict.proceed, false, 'one GUID in two cases is one invoice, and it is already paid')
  assert.match(verdict.proceed === false ? verdict.error : '', /log-old/)
})

test('a rival in another SCOPE and another CASE is still found by the query (o3d-0m56 r7, HIGH 2)', async () => {
  // The half the anchor comparison cannot reach: a row in a different scope is only ever seen if
  // the DOCUMENT arm returns it, and `equals` on a JSON path is byte-exact in PostgreSQL. One
  // spelling in the query meant the rival was never fetched, so nothing downstream could judge it.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const LOWER = '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44'
  const UPPER = LOWER.toUpperCase()
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: LOWER,
      Total: 25,
      AmountDue: 13.5,
      AmountPaid: 11.5,
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const ours = { accountingInvoiceId: LOWER, bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' }
  const { db, counts } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: ours, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
    {
      id: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      scope: 'BILL_PAYMENT PurchaseOrder po-1',
      payload: { accountingInvoiceId: UPPER, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-new',
    payload: ours,
    postingDate: '2026-09-20',
    db,
  })

  assert.equal(verdict.proceed, false, 'the rival settled this bill under another spelling of its id')
  assert.match(verdict.proceed === false ? verdict.error : '', /log-old/)
  const where = counts[0] as { OR: Array<Record<string, unknown>> }
  assert.deepEqual(where.OR.slice(1), [
    { payload: { path: ['accountingInvoiceId'], string_contains: LOWER, mode: 'insensitive' } },
  ], 'the fold is IN the predicate, so no set of spellings has to be enumerated')
})

test('two rows naming one document in two CASES take the same lock (o3d-0m56 r7, HIGH 2)', async () => {
  // And the exclusion itself. Even with the query fixed, a case-keyed lock lets both rows be
  // inside their probe→post span at once, which is the race the document key exists to stop.
  const LOWER = '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44'
  const UPPER = LOWER.toUpperCase()
  xeroResponse = { Invoices: [{ InvoiceID: LOWER, Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const lowerPayload = { accountingInvoiceId: LOWER, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const upperPayload = { accountingInvoiceId: UPPER, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const { db } = dbDouble([
    { id: 'log-a', remoteAttemptedAt: null, payload: lowerPayload, scope: 'BILL_PAYMENT PurchaseOrder po-1' },
    { id: 'log-b', remoteAttemptedAt: null, payload: upperPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
  ])
  const { lock, contended, whenAcquired } = lockDouble()
  const fence = await loadFence()
  const posts: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let acquired!: () => void
  const acquiredP = new Promise<void>((resolve) => { acquired = resolve })
  whenAcquired(() => acquired())

  const bill = { connector: 'xero' as const, type: 'BILL_PAYMENT', postingDate: '2026-08-01', db, lock }
  const first = fence(
    { ...bill, payload: lowerPayload, referenceType: 'PurchaseOrder', referenceId: 'po-1', entryId: 'log-a' },
    async () => { posts.push('log-a'); await gate; return { success: true, externalId: 'PAY-A' } },
  )
  await acquiredP
  const second = await fence(
    { ...bill, payload: upperPayload, referenceType: 'PurchaseInvoice', referenceId: 'pi-1', entryId: 'log-b' },
    async () => { posts.push('log-b'); return { success: true, externalId: 'PAY-B' } },
  )
  release()
  await first

  assert.deepEqual(posts, ['log-a'], 'one bill, one probe→post span, whatever case its id is written in')
  assert.equal(second.success, false)
  assert.equal(contended.length, 1, 'and the loser was refused by the lock, not by luck')
})

/* --------- round 7, MEDIUM 3: an incident that cannot be persisted says so out loud --------- */

test('an incident the activity log REFUSES is retried, then announced as unpersisted (o3d-0m56 r7, MEDIUM 3)', async () => {
  // `logActivityPersisted` never throws — it REPORTS. The old call swallowed that report, so a
  // write that failed looked exactly like one that succeeded and the durable record could vanish
  // at the one moment it matters. Now the answer is used: one retry, and failing that a line that
  // says the durable record does not exist and carries the whole incident.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { lines, restore } = captureErrors()
  activityEntries.length = 0
  activityWriteFailures = 2
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: true, externalId: 'PAY-A' }
    })
    assert.deepEqual(outcome, { success: true, externalId: 'PAY-A' }, 'and it still does not turn a committed payment into an exception')
  } finally {
    restore()
    activityWriteFailures = 0
  }

  assert.equal(activityEntries.length, 2, 'a refused write is retried once — the usual cause is a transient blip')
  const announced = lines.join('\n')
  assert.match(announced, /INCIDENT NOT PERSISTED/, 'silence here is a durable record that does not exist')
  assert.ok(announced.includes('"documentKey":"[\\"invoice_payment\\",\\"inv-1\\"]"'),
    'and the stream is now the only copy, so it has to carry the incident, not point at it')
})

test('a TRANSIENT activity-log failure is recovered by the retry (o3d-0m56 r7, MEDIUM 3)', async () => {
  // The discriminating half: the retry must actually be a retry, and a recovered write must not be
  // reported as a lost one.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { lines, restore } = captureErrors()
  activityEntries.length = 0
  activityWriteFailures = 1
  try {
    await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: true, externalId: 'PAY-A' }
    })
  } finally {
    restore()
    activityWriteFailures = 0
  }
  assert.equal(activityEntries.length, 2)
  assert.equal(/INCIDENT NOT PERSISTED/.test(lines.join('\n')), false, 'the record exists; saying otherwise is noise')
})

test('a FAILED post whose incident could not be persisted says so in the row (o3d-0m56 r7, MEDIUM 3)', async () => {
  // The durable fallback that exists. A failed post's error message IS written to the sync row and
  // is not overwritten by a success write, so when the activity log cannot take the incident the
  // row itself carries it — which is the only place left.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { restore } = captureErrors()
  activityEntries.length = 0
  activityWriteFailures = 2
  let outcome: { success: boolean; error?: string }
  try {
    outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: false, error: 'HTTP 504' }
    })
  } finally {
    restore()
    activityWriteFailures = 0
  }
  assert.equal(outcome.success, false)
  assert.match(outcome.error ?? '', /lock for this document was lost/)
  assert.match(outcome.error ?? '', /only durable record/,
    'the operator must be told the incident exists nowhere else')
})

test('a persisted incident does not claim the row is its only record (o3d-0m56 r7, MEDIUM 3)', async () => {
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { restore } = captureErrors()
  activityEntries.length = 0
  try {
    const outcome = await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      return { success: false, error: 'HTTP 504' }
    })
    assert.equal(/only durable record/.test(outcome.error ?? ''), false)
  } finally {
    restore()
  }
  assert.equal(activityEntries.length, 1, 'and a write that succeeded is not retried')
})

/* ---- round 8, HIGH 1: a spelling nobody enumerated is still the same document ---- */

test('a rival holding this document in MIXED case, in another scope, is still fetched (o3d-0m56 r8, HIGH 1)', async () => {
  // The hole three spellings left. Round 7 asked for the id as stored, lower-cased and upper-cased;
  // `4D8a…` is none of those, so the rival was never fetched and nothing downstream could judge it
  // — the same cross-scope double post, one spelling further along. Whether either connector can
  // produce such an id is not the point: this arm exists to catch what the scope key cannot see,
  // and it must not depend on an assumption about a payload IMS does not control.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const LOWER = '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44'
  const MIXED = '4D8a1F2e-0000-4c11-9A3b-7e5D2c9b1A44'
  assert.notEqual(MIXED, LOWER.toUpperCase(), 'the whole point is a spelling the old list did not hold')
  assert.notEqual(MIXED, LOWER)
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: LOWER,
      Total: 25,
      AmountDue: 13.5,
      AmountPaid: 11.5,
      // The rival's payment, since corrected in Xero — only its own mark still names it, so the
      // amount-and-date fallback cannot find it either.
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const ours = { accountingInvoiceId: LOWER, bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' }
  const { db, counts } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: ours, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
    {
      id: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      // ANOTHER scope, so the scope arm cannot reach it: only the document arm can, and only if the
      // database itself folds the case.
      scope: 'BILL_PAYMENT PurchaseOrder po-1',
      payload: { accountingInvoiceId: MIXED, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-new',
    payload: ours,
    postingDate: '2026-09-20',
    db,
  })

  assert.equal(verdict.proceed, false, 'one bill in two spellings is one bill, and it is already paid')
  assert.match(verdict.proceed === false ? verdict.error : '', /log-old/)
  const where = counts[0] as { OR: Array<Record<string, unknown>> }
  assert.deepEqual(where.OR.slice(1), [
    { payload: { path: ['accountingInvoiceId'], string_contains: LOWER, mode: 'insensitive' } },
  ], 'one predicate that folds case, not a list of spellings that cannot be complete')
})

test('a row naming NO document still asks only its own scope (o3d-0m56 r8, HIGH 1)', async () => {
  // The guard the insensitive match makes load-bearing: an empty needle inside a LIKE '%…%' matches
  // EVERY row, so a payload with no `accountingInvoiceId` would drag in every attempted money row
  // for this connector and type. The arm is left off entirely instead.
  xeroResponse = { Invoices: [] }
  const anchorless = { bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' }
  const { db, counts } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null, payload: anchorless }])

  await (await load())({ ...payment, entryId: 'log-1', payload: anchorless, db })

  const where = counts[0] as { OR: Array<Record<string, unknown>> }
  assert.equal(where.OR.length, 1, 'no document named, no document arm')
  assert.deepEqual(where.OR[0], { referenceType: 'SalesOrder', referenceId: 'so-1' })
})

/* ---- round 8, MEDIUM 2: a thrown post keeps the unpersisted-incident fallback ---- */

test('a THROWN post whose incident could not be persisted says so in the error the row keeps (o3d-0m56 r8, MEDIUM 2)', async () => {
  // A throw here is a post of UNKNOWN outcome made without its exclusion. Both processors record
  // `String(e)` as the row's errorMessage, so the thrown text is written to the sync row exactly as
  // a failed post's error text is — and when the activity log has refused the incident, that row is
  // the only place left to put it. Rethrowing the bare error discarded it.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt, held } = lockDouble()
  const { lines, restore } = captureErrors()
  activityEntries.length = 0
  activityWriteFailures = 2
  let thrown: unknown
  try {
    await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      throw new Error('socket hang up')
    }).catch((error: unknown) => { thrown = error })
  } finally {
    restore()
    activityWriteFailures = 0
  }

  assert.ok(thrown instanceof Error, 'it still THROWS — the caller must not read this as a failure it can retry quietly')
  const message = (thrown as Error).message
  assert.match(message, /socket hang up/, "the connector's own words are kept")
  assert.match(message, /^socket hang up/, 'and kept first, so the retry classification still reads them')
  assert.match(message, /lock for this document was lost/)
  assert.match(message, /only durable record/, 'the row is the last place left to say the incident exists nowhere else')
  assert.equal((thrown as Error).cause instanceof Error, true, 'and the original error survives as the cause')
  assert.equal(activityEntries.length, 2, 'after both write attempts failed')
  assert.equal(lines.filter((l) => l.includes('INCIDENT NOT PERSISTED')).length, 1)
  assert.equal(held.size, 0, 'and the lock is still released on the way out')
})

test('a THROWN post whose incident WAS persisted does not claim the error is its only record (o3d-0m56 r8, MEDIUM 2)', async () => {
  // The over-correction. The activity log holds it, so the thrown text must not tell an operator
  // this message is all there is — and a rate-limit throw must still read as one to the processors'
  // `isRateLimitError`, which matches on this same text.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock, loseIt } = lockDouble()
  const { restore } = captureErrors()
  activityEntries.length = 0
  let thrown: unknown
  try {
    await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => {
      loseIt()
      throw new Error('HTTP 429 rate limited, retry after 2000ms')
    }).catch((error: unknown) => { thrown = error })
  } finally {
    restore()
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown)
  assert.match(message, /lock for this document was lost/, 'the unsafe post is still announced in the row')
  assert.equal(/only durable record/.test(message), false, 'the activity log has it; saying otherwise is noise')
  assert.match(message, /rate limit|http 429/i, 'and the processors can still classify it as a rate limit')
  assert.match(message, /retry after 2000ms/, 'including the backoff hint they parse out of it')
  assert.equal(activityEntries.length, 1, 'a write that succeeded is not retried')
})

test('a throw with the lock INTACT is rethrown exactly as it came (o3d-0m56 r8, MEDIUM 2)', async () => {
  // The other over-correction. Nothing was posted unprotected, so there is no incident to attach:
  // an ordinary connector exception must reach the processor unaltered, as the same object.
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Total: 10, AmountDue: 10, AmountPaid: 0, Payments: [] }] }
  const { db } = dbDouble([{ id: 'log-1', remoteAttemptedAt: null }])
  const { lock } = lockDouble()
  activityEntries.length = 0
  const original = new Error('socket hang up')
  let thrown: unknown
  await (await loadFence())({ ...payment, entryId: 'log-1', db, lock }, async () => { throw original })
    .catch((error: unknown) => { thrown = error })

  assert.equal(thrown, original, 'the very same error, not a wrapper')
  assert.equal(thrown === original ? original.message : '', 'socket hang up')
  assert.deepEqual(activityEntries, [], 'and no incident, because the exclusion held')
})

/* ------------------- round 9, HIGH 1: the anchors are the TYPE'S, not the payload's ------------------ */

test('a rival payment row carrying a stray creditNoteId is still a contender (o3d-0m56 r9, HIGH 1)', async () => {
  // THE DOUBLE. Both rows pay bill-1. The rival's payload happens to record a `creditNoteId` — a
  // field no payment body sends and neither probe reads on a payment branch — and the fence
  // compared the UNION of every anchor a money payload can hold, so it declared the rival a
  // DIFFERENT document and dropped it from the contenders. Its committed payment carries ITS
  // token's mark, not this row's, so the amount-and-date fallback misses it too: nothing refuses,
  // and the bill is paid twice. Same field, same split, in the LOCK as well — see
  // money-post-lock.test.ts.
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{
      InvoiceID: 'bill-1',
      Total: 25,
      AmountDue: 13.5,
      AmountPaid: 11.5,
      Payments: [{ PaymentID: 'PAY-OLD', Date: '2026-08-04', Amount: 11.5, Reference: settlementMarkerFor('log-old') }],
    }],
  }
  const newPayload = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 25, paymentDate: '2026-09-20' }
  const { db } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload: newPayload, scope: 'BILL_PAYMENT PurchaseInvoice pi-1' },
    {
      id: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      scope: 'BILL_PAYMENT PurchaseOrder po-1',
      // The ONLY difference from the round-6 cross-scope rival: it records a credit note as well.
      payload: { accountingInvoiceId: 'bill-1', creditNoteId: 'cn-7', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    entryId: 'log-new',
    payload: newPayload,
    postingDate: '2026-09-20',
    db,
  })

  assert.equal(verdict.proceed, false, 'the rival settled this bill; a field the post never sends must not hide it')
  assert.match(verdict.proceed === false ? verdict.error : '', /log-old/)
})

test('an allocation asks on BOTH its anchors, and one credit on another bill is another document (o3d-0m56 r9, HIGH 1)', async () => {
  // The query arms are the TYPE's anchors now, so an allocation pre-filters on the bill AND the
  // credit note. They are OR'd, not AND'd: a row that really is this allocation matches both, while
  // an AND would drop a rival whose payload omits either. The extras an OR lets in are rejected by
  // `attemptCouldBeTheSameDocument` — one credit note allocated to TWO bills is two settlements,
  // and refusing on the second would strand a legitimate offset.
  xeroCalls.length = 0
  xeroResponse = { CreditNotes: [{ CreditNoteID: 'cn-1', Total: 40, RemainingCredit: 40, Allocations: [] }] }
  const payload = { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-1', amount: 25, date: '2026-09-20' }
  const { db, counts } = dbDouble([
    { id: 'log-new', remoteAttemptedAt: null, payload, scope: 'PURCHASE_CREDIT_NOTE_ALLOCATION SupplierCreditNote scn-1' },
    {
      id: 'log-other',
      remoteAttemptedAt: new Date('2026-08-01T00:00:00Z'),
      scope: 'PURCHASE_CREDIT_NOTE_ALLOCATION SupplierCreditNote scn-9',
      payload: { creditNoteId: 'cn-1', accountingInvoiceId: 'bill-OTHER', amount: 10, date: '2026-08-01' },
    },
  ])

  const verdict = await (await load())({
    connector: 'xero',
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
    referenceType: 'SupplierCreditNote',
    referenceId: 'scn-1',
    entryId: 'log-new',
    payload,
    postingDate: '2026-09-20',
    db,
  })

  const where = counts[0] as { OR: Array<Record<string, unknown>> }
  assert.deepEqual(where.OR, [
    { referenceType: 'SupplierCreditNote', referenceId: 'scn-1' },
    { payload: { path: ['accountingInvoiceId'], string_contains: 'bill-1', mode: 'insensitive' } },
    { payload: { path: ['creditNoteId'], string_contains: 'cn-1', mode: 'insensitive' } },
  ], 'scope arm first, then one arm per anchor this TYPE is identified by')
  assert.deepEqual(verdict, { proceed: true }, 'the same credit on ANOTHER bill is another settlement, not this one')
  assert.deepEqual(xeroCalls, ['CreditNotes/cn-1'])
})
