import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BILL_PAYMENT_ENQUEUE_DECLINED_MESSAGE,
  BILL_PAYMENT_LEDGER_REVERSED_REASON,
  BILL_PAYMENT_SUPERSEDED_REASON,
  billPaymentRefusalMessage,
  LEDGER_SETTLED_REVERSAL_STATUSES,
  ledgerAloneProvesTheReversal,
  markBillPaidSupersedingStaleRegistrations,
  planBillPaymentSupersession,
  retireBillPaymentRegistrationsReversedInLedger,
  reversalIsProven,
} from '@/lib/domain/accounting/payment-reversal'
import { databaseLedgerFence } from '@/lib/connectors/xero/invoice-delta'

/**
 * o3d-a3wx. BILL_PAYMENT joined accounting_sync_logs_followup_live_unique. markBillPaid only wins the
 * `paidAt: null -> paid` transition when IMS currently holds the bill UNSETTLED, so a live BILL_PAYMENT
 * row at that moment contradicts it — and left in place it occupies the slot and refuses the legitimate
 * re-payment: the constraint meant to stop a double payment stranding a real one instead.
 *
 * ROUND 2 stopped retiring PROCESSING rows: a claimed row is a request that may be ON THE WIRE, and
 * cancelling the row does nothing to the call, so the replacement posts a SECOND supplier payment.
 *
 * ROUND 3 finishes the same argument one step later. Round 2 still called a SYNCED row "stale", on the
 * assumption that the poller's reversal pass must have been what cleared paidAt — an inference about
 * Xero drawn without reading Xero. Its own refusal message walked the operator into the counter-case:
 * "wait for that sync entry to finish, then try again" is exactly what a SLOW worker's entry does, and
 * the retry then cancelled a payment that had just succeeded and queued another one under a fresh
 * token. A claim cutoff measures elapsed time; "dead" and "slow then finished" do not differ by
 * duration. So the retirement moved to the payment poller, where it records a LEDGER OBSERVATION, and
 * markBillPaid keeps only what it can prove locally: a PENDING row was never sent.
 */

/**
 * `bodyCouldHavePosted` is what the planner consults for a FAILED row, and it is spelled out on every
 * fixture rather than defaulted: the whole round-4 point is that a registration's remote outcome is a
 * fact the planner must be TOLD, never one it may assume.
 */
const PROCESSING_ROW = { id: 'log-inflight', status: 'PROCESSING', bodyCouldHavePosted: true }
const SYNCED_ROW = { id: 'log-posted', status: 'SYNCED', bodyCouldHavePosted: true }
const PENDING_ROW = { id: 'log-1', status: 'PENDING', bodyCouldHavePosted: true }
const FAILED_ROW = { id: 'log-failed', status: 'FAILED', bodyCouldHavePosted: true }

test('a PENDING registration is superseded — nothing has been sent, so cancelling it IS the whole event', () => {
  const plan = planBillPaymentSupersession([PENDING_ROW])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede.map((r) => r.id), ['log-1'])
})

test('a SYNCED registration is REFUSED as already posted, not superseded (round 3 #1)', () => {
  // THE DEFECT THIS CLOSES. Round 2 returned this row as superseded. A worker that was merely slow
  // posts the supplier payment and then writes SYNCED; the operator, told to wait and retry, retries;
  // the row is cancelled as "stale", a replacement is queued under a different entry id and therefore
  // a different Idempotency-Key, and the supplier is paid twice for a bill settled a minute earlier.
  const plan = planBillPaymentSupersession([SYNCED_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_ALREADY_POSTED')
  assert.deepEqual(plan.proceed === false && plan.blocking.map((r) => r.id), ['log-posted'])
})

test('an IN-FLIGHT (PROCESSING) registration is refused, not superseded (round 2 #1)', () => {
  const plan = planBillPaymentSupersession([PROCESSING_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_IN_FLIGHT')
  assert.deepEqual(plan.proceed === false && plan.blocking.map((r) => r.id), ['log-inflight'])
})

test('in-flight is reported ahead of already-posted when both are present', () => {
  // Same outcome either way — nothing retired, nothing queued — but IN_FLIGHT is the one that resolves
  // on its own, so it is what the operator is told to watch.
  const plan = planBillPaymentSupersession([SYNCED_ROW, PROCESSING_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_IN_FLIGHT')
})

test('one posted row blocks the whole plan, even alongside retirable ones', () => {
  // Retiring the PENDING sibling would free the slot just as effectively, so the refusal has to be
  // about the BILL, not about each row.
  const plan = planBillPaymentSupersession([PENDING_ROW, SYNCED_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_ALREADY_POSTED')
})

test('a FAILED registration REFUSES as may-have-posted — the supplier side inherits the round-3 rule (round 4 #5)', () => {
  // THE DEFECT THIS CLOSES. A FAILED row matched no branch of the planner at all and fell into
  // `proceed: true` with an empty supersede list, so Mark Paid queued a replacement under a fresh
  // entry id and therefore a fresh Idempotency-Key. But the processor posts BEFORE it records the
  // outcome: a timeout, a lost response or a crash after Xero created the Payment is written down
  // identically to a rejection, and errorMessage carries no provenance. invoice-payment-capacity.ts
  // settled exactly this for the SALES side in round 3 (AMBIGUOUS_FAILED_REGISTRATION) and the
  // supplier side — where the money actually leaves — was left guessing.
  const plan = planBillPaymentSupersession([FAILED_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_MAY_HAVE_POSTED')
  assert.deepEqual(plan.proceed === false && plan.blocking.map((r) => r.id), ['log-failed'])
})

test('a FAILED registration whose stored body could never have been sent blocks nothing', () => {
  // The ONE exemption, and it is a proof rather than a guess: both connectors return from their
  // BILL_PAYMENT case before building any request when accountingInvoiceId, bankAccountId or amount is
  // missing. Without this the refusal would be unconditional and a bill could never be re-paid after a
  // malformed enqueue.
  const plan = planBillPaymentSupersession([{ ...FAILED_ROW, bodyCouldHavePosted: false }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede, [])
})

test('CANCELLED rows still block nothing, and a FAILED row is never rewritten', () => {
  // CANCELLED is the one status every writer in this tree asserts only where "nothing was sent" is
  // TRUE, so it frees the slot. FAILED now blocks — but the planner never returns it as superseded, so
  // nothing rewrites it and the evidence that an attempt was made survives.
  const plan = planBillPaymentSupersession([{ id: 'log-2', status: 'CANCELLED', bodyCouldHavePosted: true }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede, [])

  const withFailed = planBillPaymentSupersession([FAILED_ROW])
  assert.equal(withFailed.proceed, false)
  assert.equal(withFailed.proceed === false && withFailed.refusal, 'PAYMENT_MAY_HAVE_POSTED')
})

test('in-flight and already-posted are both reported ahead of may-have-posted', () => {
  // Same outcome — nothing retired, nothing queued — but the order decides which sentence the operator
  // reads first, and a FAILED row is the one that will not change on its own.
  const inFlightFirst = planBillPaymentSupersession([FAILED_ROW, PROCESSING_ROW])
  assert.equal(inFlightFirst.proceed === false && inFlightFirst.refusal, 'PAYMENT_IN_FLIGHT')
  const postedFirst = planBillPaymentSupersession([FAILED_ROW, SYNCED_ROW])
  assert.equal(postedFirst.proceed === false && postedFirst.refusal, 'PAYMENT_ALREADY_POSTED')
})

test('every refusal tells the operator what to do, and the posted one says where to look', () => {
  // A refusal an operator cannot act on is a refusal they will work around by re-recording the
  // payment, which is the single action that turns an ambiguity into a duplicate.
  assert.match(billPaymentRefusalMessage('PAYMENT_IN_FLIGHT'), /Wait for that sync entry to finish/)
  assert.match(billPaymentRefusalMessage('PAYMENT_ALREADY_POSTED'), /Open the bill in the connector/)
  assert.match(billPaymentRefusalMessage('PAYMENT_ALREADY_POSTED'), /cancel that sync entry/)
  assert.match(billPaymentRefusalMessage('PAYMENT_STATE_CHANGED'), /Nothing was changed/)
  // The may-have-posted refusal has to say WHY a failure is not a clean slate, or the operator reads
  // "it failed" as "nothing happened" and re-records the payment — the single action that turns the
  // ambiguity into a second supplier payment.
  assert.match(billPaymentRefusalMessage('PAYMENT_MAY_HAVE_POSTED'), /NOT proof/)
  assert.match(billPaymentRefusalMessage('PAYMENT_MAY_HAVE_POSTED'), /response lost/)
  assert.match(billPaymentRefusalMessage('PAYMENT_MAY_HAVE_POSTED'), /Open the bill in the connector/)
  assert.match(billPaymentRefusalMessage('PAYMENT_MAY_HAVE_POSTED'), /cancel that sync entry/)
})

// ---------------------------------------------------------------------------
// DB WIRING. Round 1 tested only the pure predicate, so nothing checked that the paidAt write and the
// retirement happen in ONE transaction, that the retirement is status-fenced, or that a refusal reaches
// the caller at all. These drive the real function against a recording transaction client.
// ---------------------------------------------------------------------------

type SyncRow = { id: string; status: string; payload?: unknown }

function mockTx(rows: SyncRow[], options: { paidCount?: number; retiredCount?: number; afterRetire?: SyncRow[] } = {}) {
  const calls = {
    syncFindMany: [] as Array<Record<string, unknown>>,
    syncUpdateMany: [] as Array<{ where?: unknown; data?: unknown }>,
    invoiceUpdateMany: [] as Array<{ where?: unknown; data?: unknown }>,
  }
  let findManyCount = 0
  const tx = {
    accountingSyncLog: {
      findMany: async (args: Record<string, unknown>) => {
        calls.syncFindMany.push(args)
        findManyCount += 1
        if (findManyCount === 1) return rows
        // The shortfall re-read APPLIES ITS OWN STATUS FILTER here. A mock that returned
        // `afterRetire` whole would answer every possible query identically, so a test asserting
        // "a row that went FAILED refuses" would pass against a version that only ever looked for
        // in-flight rows — it would be measuring the mock, not the code.
        const after = options.afterRetire ?? []
        const status = (args.where as { status?: { in?: string[]; not?: string } } | undefined)?.status
        if (status?.in) return after.filter((row) => status.in!.includes(row.status))
        if (status?.not) return after.filter((row) => row.status !== status.not)
        return after
      },
      updateMany: async (args: { where?: unknown; data?: unknown }) => {
        calls.syncUpdateMany.push(args)
        return { count: options.retiredCount ?? rows.filter((r) => r.status === 'PENDING').length }
      },
    },
    purchaseInvoice: {
      updateMany: async (args: { where?: unknown; data?: unknown }) => {
        calls.invoiceUpdateMany.push(args)
        return { count: options.paidCount ?? 1 }
      },
    },
  }
  return { tx, calls }
}

const PARAMS = {
  invoiceId: 'inv-1',
  paidAt: new Date('2026-08-20T10:00:00.000Z'),
  paymentAccountId: 'acct-1',
  paymentAccountName: 'Barclays GBP',
  paymentReference: 'PAY-1',
}

test('an in-flight registration refuses BEFORE the bill is written as paid', async () => {
  // THE WHOLE POINT. If the paidAt write happened first, the bill would be PAID in IMS with a payment
  // in flight and nothing queued — either a double payment (round 1) or a stranded one.
  const { tx, calls } = mockTx([PROCESSING_ROW])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.refusal, 'PAYMENT_IN_FLIGHT')
  assert.deepEqual(result.outcome === 'refused' && result.blockingIds, ['log-inflight'])
  assert.equal(calls.invoiceUpdateMany.length, 0, 'the bill must NOT be written as paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'the in-flight row must NOT be cancelled')
})

test('a POSTED registration refuses BEFORE the bill is written as paid, and is never cancelled', async () => {
  const { tx, calls } = mockTx([SYNCED_ROW])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.refusal, 'PAYMENT_ALREADY_POSTED')
  assert.deepEqual(result.outcome === 'refused' && result.blockingIds, ['log-posted'])
  assert.equal(calls.invoiceUpdateMany.length, 0, 'the bill must NOT be written as paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'a posted registration must NEVER be cancelled from here')
})

test('with nothing claimed or posted, the bill is marked paid and the PENDING rows are retired under a PENDING fence', async () => {
  const { tx, calls } = mockTx([{ id: 'log-1', status: 'PENDING' }, { id: 'log-2', status: 'PENDING' }])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'paid')
  assert.equal(result.outcome === 'paid' && result.retiredCount, 2)
  // The paidAt write is itself a compare-and-swap on `paidAt: null`.
  assert.deepEqual(calls.invoiceUpdateMany[0].where, { id: 'inv-1', paidAt: null })
  // PENDING only. SYNCED must not appear in this fence: a row read as PENDING that reached SYNCED in
  // between has POSTED, and a fence naming SYNCED would sweep it up as though it had not.
  assert.deepEqual(calls.syncUpdateMany[0].where, {
    id: { in: ['log-1', 'log-2'] },
    status: { in: ['PENDING'] },
  })
  assert.equal((calls.syncUpdateMany[0].data as { status: string }).status, 'CANCELLED')
  assert.equal((calls.syncUpdateMany[0].data as { errorMessage: string }).errorMessage, BILL_PAYMENT_SUPERSEDED_REASON)
  assert.match(BILL_PAYMENT_SUPERSEDED_REASON, /had not been sent/)
})

test('a row claimed between the survey and the fenced write refuses with PAYMENT_STATE_CHANGED', async () => {
  // The read is not FOR UPDATE, so a worker can take the PENDING row in between. The fenced update then
  // matches fewer rows than asked for, and that shortfall is the only signal that it happened.
  const { tx, calls } = mockTx(
    [{ id: 'log-1', status: 'PENDING' }],
    { retiredCount: 0, afterRetire: [{ id: 'log-1', status: 'PROCESSING' }] },
  )

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.refusal, 'PAYMENT_STATE_CHANGED')
  assert.deepEqual(result.outcome === 'refused' && result.blockingIds, ['log-1'])
  // The caller rolls the transaction back on this outcome, which is what undoes the paidAt write.
  assert.equal(calls.invoiceUpdateMany.length, 1)
})

test('a row that went FAILED under us REFUSES — leaving the live predicate is not evidence it sent nothing', async () => {
  // THE ROUND-3 CORRECTION TO ROUND 2. Round 2 let this through, reasoning that a row which fell out
  // of the live predicate by itself "holds nothing". It holds no live SLOT; that is not the same as
  // holding no payment. A PENDING row only reaches FAILED by being CLAIMED and ATTEMPTED, and o3d-ju8t
  // settled that a failed attempt proves nothing about the ledger — the payment may have been created
  // and the response lost. Queuing a replacement under a fresh token would then pay the supplier twice.
  const { tx } = mockTx(
    [{ id: 'log-1', status: 'PENDING' }],
    { retiredCount: 0, afterRetire: [{ id: 'log-1', status: 'FAILED' }] },
  )

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.refusal, 'PAYMENT_STATE_CHANGED')
  assert.deepEqual(result.outcome === 'refused' && result.blockingIds, ['log-1'])
})

test('the shortfall re-read asks only for rows that are NOT CANCELLED', async () => {
  // CANCELLED is the one destination that is not a refusal: whoever wrote it asserted, under the rule
  // o3d-sref set, that nothing was sent. Everything else is unknown and must be excluded from the
  // proceed path — so the query has to be shaped as "anything but CANCELLED", not "in flight".
  const { tx, calls } = mockTx([{ id: 'log-1', status: 'PENDING' }], { retiredCount: 0, afterRetire: [] })

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'paid', 'a row someone else retired pre-call must not strand the payment')
  assert.deepEqual(calls.syncFindMany[1].where, { id: { in: ['log-1'] }, status: { not: 'CANCELLED' } })
})

test('losing the paidAt compare-and-swap reports already-paid and retires nothing', async () => {
  const { tx, calls } = mockTx([{ id: 'log-1', status: 'PENDING' }], { paidCount: 0 })

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'already-paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'a bill we did not transition is not ours to retire rows for')
})

test('a FAILED registration read from the database refuses BEFORE the bill is written as paid (round 4 #5)', async () => {
  // End to end through the real function, not just the planner: the survey has to READ the payload and
  // put it through the shared body test, or the refusal never fires in production no matter what the
  // pure rule says.
  const { tx, calls } = mockTx([
    {
      id: 'log-failed',
      status: 'FAILED',
      payload: { accountingInvoiceId: 'xero-inv-1', bankAccountId: 'acct-1', amount: 120.5 },
    },
  ])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.refusal, 'PAYMENT_MAY_HAVE_POSTED')
  assert.deepEqual(result.outcome === 'refused' && result.blockingIds, ['log-failed'])
  assert.equal(calls.invoiceUpdateMany.length, 0, 'the bill must NOT be written as paid')
  assert.equal(calls.syncUpdateMany.length, 0, 'a failed registration must never be rewritten from here')
})

test('the survey reads the payload, so the FAILED exemption is decided by the shared body test', async () => {
  // billPaymentBodyCouldHavePosted delegates to storedBodyCouldHaveReachedTheLedger. A survey that
  // selected only id and status could not consult it at all, and the exemption would silently become
  // "every FAILED row blocks" — a different rule that happens to be safe, and so would never be caught
  // by a refusal test.
  const { tx, calls } = mockTx([
    { id: 'log-failed', status: 'FAILED', payload: { accountingInvoiceId: '', bankAccountId: '', amount: null } },
  ])

  const result = await markBillPaidSupersedingStaleRegistrations(tx as never, PARAMS)

  assert.deepEqual(calls.syncFindMany[0].select, { id: true, status: true, payload: true })
  assert.equal(result.outcome, 'paid', 'a body the connector would reject before sending blocks nothing')
})

// ---------------------------------------------------------------------------
// THE OTHER HALF: retirement moves to the one component that reads the ledger.
// ---------------------------------------------------------------------------

/**
 * ROUND 8. Every retirement below states the LEDGER STATUS it is acting on, because that is the fact
 * the whole destructive path now rests on and rounds 3–7 never had it. `VOIDED` is the only status
 * that proves a reversal without further evidence, and the tests that exercise the fence say so
 * explicitly rather than relying on a default — a default would be the branch re-deciding on the
 * fixtures' behalf, which is the defect one level up.
 *
 * AND THE DOUBLE NOW RETURNS COMPLETION PROVENANCE, NOT JUST IDS (o3d-m5qk, merging o3d-clxw #634).
 * The fence used to be a Prisma predicate over `syncedAt` alone, so a double only had to hand back
 * the rows the query "selected". It is now `databaseStampedCompletion` applied in this process, which
 * reads BOTH columns: `syncedAt` and the marker `syncedAtDatabaseClock` the database mints beside it.
 * So the rows a test hands in have to carry both, and the interesting cases are the ones where they
 * DISAGREE — that is an old build's host-clock write, and it is undecidable however early it looks.
 */
type RetirementRow = { id: string; syncedAt: Date | null; syncedAtDatabaseClock: Date | null }

/** A row the database stamped: both columns carry the same instant, which is what the trigger keeps true. */
function stamped(id: string, at: string): RetirementRow {
  return { id, syncedAt: new Date(at), syncedAtDatabaseClock: new Date(at) }
}

function retirementClient(rows: RetirementRow[], retiredCount = 1) {
  const updates: Array<{ where?: Record<string, unknown>; data?: unknown }> = []
  const finds: Array<{ where?: Record<string, unknown>; select?: unknown }> = []
  const client = {
    accountingSyncLog: {
      findMany: async (args: { where?: Record<string, unknown>; select?: unknown }) => {
        finds.push(args)
        return rows
      },
      updateMany: async (args: { where?: Record<string, unknown>; data?: unknown }) => {
        updates.push(args)
        return { count: retiredCount }
      },
    },
  }
  return { client, updates, finds }
}

test('a posted registration that finished AFTER the ledger read is REPORTED, not filtered away (round 4 #2)', async () => {
  // THE DEFECT THIS CLOSES. Round 3 expressed the fence as `syncedAt: { lt: observedBefore }` inside
  // the update, so such a row was not skipped — it was INVISIBLE. The poller cleared paidAt anyway,
  // the bill left `paidAt: { not: null }`, and with it left the ONLY query that ever produces another
  // reversal observation for that document. The row then refused every future Mark Paid, for ever,
  // with nothing recording why.
  const observedBefore = databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z'))
  const { client, updates, finds } = retirementClient([stamped('log-late', '2026-08-20T09:46:00.000Z')])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: observedBefore,
  })

  assert.equal(outcome.decided, false)
  assert.equal(outcome.decided === false && outcome.withheld, 'REGISTRATION_UNDECIDED')
  assert.deepEqual(
    outcome.decided === false && outcome.withheld === 'REGISTRATION_UNDECIDED' && outcome.undecided,
    ['log-late'],
  )
  assert.equal(updates.length, 0, 'nothing may be retired on a verdict this read cannot support')
  // SUPERSEDED ASSERTION (o3d-m5qk). This used to be
  //   assert.deepEqual(finds[0].where?.OR, [{ syncedAt: null }, { syncedAt: { gte: observedBefore } }])
  // — the undecidable predicate expressed in SQL over `syncedAt` alone. That column cannot answer the
  // question by itself (o3d-clxw #634: an old build writes its own host's clock into it), so the query
  // now selects the scope and the verdict is reached in this process by `databaseStampedCompletion`,
  // the SAME reader `classifyRegisteredPayment` uses. What is asserted instead is that the read asks
  // for both columns, because a select that omitted the marker would make every row undecidable
  // silently.
  assert.equal(finds[0].where?.OR, undefined, 'the fence is no longer a SQL predicate')
  assert.deepEqual(finds[0].select, { id: true, syncedAt: true, syncedAtDatabaseClock: true })
})

test('a completion time the database did not mint is UNDECIDABLE, however early it looks (o3d-clxw round 5)', async () => {
  // The one case the two branches answered differently, and the reason this predicate moved onto the
  // marker. `syncedAt` is well before the read, so the old `syncedAt`-alone fence called this row
  // DECIDED and retired it. But the marker disagrees with it, which is what a row written by a build
  // that does not know about the marker looks like — its `syncedAt` is that host's `new Date()`, and
  // comparing a foreign host's clock against a database fence is exactly the cross-host comparison
  // that clears paidAt over a payment still in flight and pays the supplier twice.
  const observedBefore = databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z'))
  const { client, updates } = retirementClient([
    { id: 'log-legacy', syncedAt: new Date('2026-08-20T09:00:00.000Z'), syncedAtDatabaseClock: null },
    {
      id: 'log-rewritten',
      syncedAt: new Date('2026-08-20T09:00:00.000Z'),
      syncedAtDatabaseClock: new Date('2026-08-20T09:00:00.001Z'),
    },
  ])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    // VOIDED, so the round-8 proof gate is satisfied and the fence is what decides this.
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: observedBefore,
  })

  assert.equal(outcome.decided, false)
  assert.equal(outcome.decided === false && outcome.withheld, 'REGISTRATION_UNDECIDED')
  assert.deepEqual(
    outcome.decided === false && outcome.withheld === 'REGISTRATION_UNDECIDED' ? outcome.undecided : null,
    ['log-legacy', 'log-rewritten'],
  )
  assert.equal(updates.length, 0)
})

test('a NULL fence decides nothing at all, even for a row stamped long ago', async () => {
  // The database clock could not be read, so this poll has no ordering whatever. Failing closed means
  // every registration might have landed after the snapshot — the same reading classifyRegisteredPayment
  // gives a null fence, so the two cannot disagree about a bill.
  const { client, updates } = retirementClient([stamped('log-old', '2020-01-01T00:00:00.000Z')])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: null,
  })

  assert.equal(outcome.decided, false)
  assert.equal(outcome.decided === false && outcome.withheld, 'REGISTRATION_UNDECIDED')
  assert.deepEqual(
    outcome.decided === false && outcome.withheld === 'REGISTRATION_UNDECIDED' ? outcome.undecided : null,
    ['log-old'],
  )
  assert.equal(updates.length, 0)
})

test('one undecidable registration withholds the whole bill, including its decidable siblings', async () => {
  // Retiring the siblings and abandoning the rest would leave the bill reading as fully reconciled
  // while one registration's payment may be sitting in the ledger unaccounted for. A later observation
  // — one taken after every row finished — decides them together.
  const { client, updates } = retirementClient([
    stamped('log-early', '2026-08-20T09:00:00.000Z'),
    stamped('log-late', '2026-08-20T09:46:00.000Z'),
  ])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
  })

  assert.equal(outcome.decided, false)
  assert.deepEqual(
    outcome.decided === false && outcome.withheld === 'REGISTRATION_UNDECIDED' ? outcome.undecided : null,
    ['log-late'],
  )
  assert.equal(updates.length, 0)
})

test('a reversed bill retires only SYNCED rows that had already posted when the ledger was read', async () => {
  const observedBefore = databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z'))
  const { client, updates } = retirementClient([stamped('log-posted', '2026-08-20T09:00:00.000Z')])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: observedBefore,
  })

  assert.equal(outcome.decided, true)
  assert.equal(outcome.decided === true && outcome.retired, 1)
  assert.deepEqual(updates[0].where, {
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'inv-1',
    // SYNCED only: a PENDING row is a re-payment someone has already queued and a PROCESSING row may
    // be posting this instant. Neither is the payment this ledger read failed to find.
    status: { in: ['SYNCED'] },
    // SUPERSEDED ASSERTION (o3d-m5qk): this used to be `syncedAt: { lt: observedBefore }`, a SECOND
    // spelling of the fence inside the destructive write. The fence is now decided once, above, by
    // `databaseStampedCompletion`, and the write names the exact rows that survived it — re-deriving
    // it here would be the two-answers-to-one-money-question defect this merge removed. The status
    // scope stays, so a row that changed underneath the read is still not retired.
    id: { in: ['log-posted'] },
  })
  assert.equal((updates[0].data as { status: string }).status, 'CANCELLED')
  assert.equal((updates[0].data as { errorMessage: string }).errorMessage, BILL_PAYMENT_LEDGER_REVERSED_REASON)
  // o3d-sref: CANCELLED must never silently assert "nothing was sent" where that is false, so the
  // reason string is what carries the truth — this entry DID post.
  assert.match(BILL_PAYMENT_LEDGER_REVERSED_REASON, /The entry posted/)
})

// ---------------------------------------------------------------------------
// ROUND 8: "NOT FULLY PAID" IS NOT "THE PAYMENT IS GONE".
// ---------------------------------------------------------------------------

test('an AUTHORISED bill is REFUSED by the retirement, and nothing is even read (round 8)', async () => {
  // THE DEFECT THIS CLOSES, and it is the money path. The poller's reversal set is AUTHORISED ∪
  // VOIDED, and Xero's AUTHORISED means APPROVED AND NOT FULLY PAID — a bill carrying a real PART
  // payment sits there, and so does one whose payment IMS has queued and not yet posted. Rounds 3–7
  // took selection into that set as the ledger observation, so both walked into the destructive path:
  // the SYNCED registration recording a real supplier payment was CANCELLED and paidAt cleared in the
  // same transaction, which re-arms Mark Paid. markBillPaid sends no idempotency key and BILL_PAYMENT
  // sits outside every live-row dedupe, so the second payment is refused by nothing.
  //
  // `retiredCount` is 1 and the undecidable list is EMPTY — i.e. this fixture is the shape that
  // previously retired successfully. The refusal has to come from the status alone.
  const { client, updates, finds } = retirementClient([], 1)

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'AUTHORISED',
    classifierProof: null,
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
  })

  assert.equal(outcome.decided, false)
  assert.equal(outcome.decided === false && outcome.withheld, 'REVERSAL_UNPROVEN')
  assert.equal(
    outcome.decided === false && outcome.withheld === 'REVERSAL_UNPROVEN' && outcome.ledgerStatus,
    'AUTHORISED',
    'the refusal must carry the status it refused, so the operator is told what Xero actually said',
  )
  assert.equal(updates.length, 0, 'a part-paid bill must not have its payment registration cancelled')
  assert.equal(
    finds.length,
    0,
    'the proof gate must be checked BEFORE the registration survey — an unproven bill has no business '
      + 'reaching the fence at all',
  )
})

test('a ledger status the read could not produce is not a proof either', async () => {
  // Absence of a status is not permission. If the invoice fell out of the delta map — a shape this
  // loop has no guarantee against — reading that as "nothing said, so proceed" would restore the
  // defect for exactly the rows nobody can explain afterwards.
  const { client, updates, finds } = retirementClient([], 1)

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: null,
    classifierProof: null,
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
  })

  assert.equal(outcome.decided === false && outcome.withheld, 'REVERSAL_UNPROVEN')
  assert.equal(outcome.decided === false && outcome.withheld === 'REVERSAL_UNPROVEN' && outcome.ledgerStatus, null)
  assert.equal(updates.length, 0)
  assert.equal(finds.length, 0)
})

test('VOIDED is the ONLY status that settles a reversal on its own', () => {
  // Xero requires every payment to be released before an invoice can be voided, and refuses a payment
  // against a voided one — so a voided invoice demonstrably holds no payment, and re-arming Mark Paid
  // on it cannot move money a second time. Nothing else in Xero's ACCPAY vocabulary carries that.
  //
  // This is the SAME rule as partitionPaymentReversals' `voided` bucket on o3d-batch-billpay, stated
  // once. The widening — a stated zero paid whose registrations the read accounts for — is that
  // branch's classifier and is deliberately absent here: two answers to one question is the defect.
  assert.deepEqual([...LEDGER_SETTLED_REVERSAL_STATUSES], ['VOIDED'])
  assert.equal(ledgerAloneProvesTheReversal('VOIDED'), true)
  for (const status of ['AUTHORISED', 'PAID', 'DRAFT', 'SUBMITTED', 'DELETED', '']) {
    assert.equal(ledgerAloneProvesTheReversal(status), false, `${status || '<empty>'} must not prove a reversal`)
  }
  assert.equal(ledgerAloneProvesTheReversal(null), false)
  assert.equal(ledgerAloneProvesTheReversal(undefined), false)
  // Not case-folded on purpose: Xero sends these upper-cased, and quietly accepting a variant would be
  // this module guessing what a status it does not recognise meant.
  assert.equal(ledgerAloneProvesTheReversal('voided'), false)
})

test('o3d-m5qk: the MERGED classifier\'s verdict is admissible proof, so a proved reversal is not stranded', async () => {
  // Round 8 said an AUTHORISED bill "is not decidable from anything this branch reads", and that the
  // widening — a stated zero paid whose registrations the read can account for, or a registered
  // PaymentID proved absent from the invoice's own list — "belongs to ITS classifier, handed in here as
  // further admissible proofs". That classifier is o3d-clxw, merged as #634, and this is the hand-in.
  //
  // WITHOUT IT the two answers collide in the worst direction: a bill whose supplier payment really was
  // deleted — proved by the ledger's own payment list — reads as REVERSAL_UNPROVEN for ever, its posted
  // registration is never retired, and every future Mark Paid on it is refused. AUTHORISED is the status
  // on both of these, because Xero's AUTHORISED is simply "approved and not fully paid".
  for (const proof of ['REGISTERED_PAYMENT_ABSENT', 'ZERO_PAID_REGISTRATIONS_ACCOUNTED'] as const) {
    const { client, updates } = retirementClient([stamped('log-posted', '2026-08-20T09:00:00.000Z')])
    const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
      connector: 'xero',
      invoiceId: 'inv-1',
      ledgerStatus: 'AUTHORISED',
      classifierProof: proof,
      ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
    })
    assert.equal(outcome.decided, true, `${proof} is a proof this retirement must accept`)
    assert.equal(updates.length, 1)
  }
})

test('o3d-m5qk: the fence still applies to a classifier-proved reversal — proof of WHAT, not of WHEN', async () => {
  // The two questions are independent and both must be answered. The classifier proves the payment is
  // gone from the ledger; it says nothing about whether a registration of ours finished after the
  // snapshot was taken. A registration this read cannot speak for still withholds the whole bill.
  const { client, updates } = retirementClient([stamped('log-late', '2026-08-20T09:46:00.000Z')])

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'AUTHORISED',
    classifierProof: 'REGISTERED_PAYMENT_ABSENT',
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
  })

  assert.equal(outcome.decided, false)
  assert.equal(outcome.decided === false && outcome.withheld, 'REGISTRATION_UNDECIDED')
  assert.equal(updates.length, 0)
})

test('o3d-m5qk: reversalIsProven is the ONE place both kinds of evidence are weighed', () => {
  // A caller with neither proof gets the round-8 answer unchanged, so nothing became weaker by the
  // widening: an AUTHORISED bill nobody has classified is still refused.
  assert.equal(reversalIsProven({ ledgerStatus: 'AUTHORISED', classifierProof: null }), false)
  assert.equal(reversalIsProven({ ledgerStatus: null, classifierProof: null }), false)
  // Either kind on its own is enough, and the status rule is untouched.
  assert.equal(reversalIsProven({ ledgerStatus: 'VOIDED', classifierProof: null }), true)
  assert.equal(reversalIsProven({ ledgerStatus: 'AUTHORISED', classifierProof: 'REGISTERED_PAYMENT_ABSENT' }), true)
  assert.equal(reversalIsProven({ ledgerStatus: null, classifierProof: 'ZERO_PAID_REGISTRATIONS_ACCOUNTED' }), true)
})

test('o3d-m5qk: the poller NAMES the classifier bucket rather than letting the retirement re-derive it', () => {
  // "It must never be re-derived at a call site" cuts both ways: the poller does not decide what its
  // buckets prove (that is reversalIsProven), and the retirement does not go back to the ledger to
  // work out which bucket a bill came from. The poller passes the two sets it is already iterating.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  const block = stripComments(src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart)))

  assert.ok(block.includes('classifierProof,'), 'the retirement must be told which bucket the bill came from')
  assert.ok(block.includes("billResidual.provenGone.has("), 'from the same provenGone map the loop already reads')
  assert.ok(block.includes('billResidual.zeroPaidReversed.has('), 'and the same zeroPaidReversed set')
  assert.ok(
    !block.includes('reversalIsProven') && !block.includes('ledgerAloneProvesTheReversal'),
    'but the poller must not weigh the evidence itself — that is the domain module\'s one job',
  )
})

test('a VOIDED bill still retires, so the proof gate did not just switch the pass off', async () => {
  // The counter-test. A gate that refused everything would also pass every assertion above, and would
  // strand every genuine reversal behind a refusal markBillPaid can never clear.
  const { client, updates } = retirementClient([], 2)

  const outcome = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerStatus: 'VOIDED',
    classifierProof: null,
    ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
  })

  assert.equal(outcome.decided, true)
  assert.equal(outcome.decided === true && outcome.retired, 2)
  assert.equal(updates.length, 1)
})

test('the two withheld causes are distinct verdicts, because they ask the operator for different things', async () => {
  // Both leave paidAt set and both count on `billReversalsWithheld` — "we would have cleared paidAt and
  // did not" is one fact an operator watches. But REGISTRATION_UNDECIDED resolves itself once a later
  // read covers the registrations, while REVERSAL_UNPROVEN needs somebody to look at the bill in Xero.
  // Collapsing them into a bare `decided: false` would hand both the same instructions, and the
  // undecided one's instructions ("IMS will decide this by itself") are wrong for a part payment.
  const undecided = await retireBillPaymentRegistrationsReversedInLedger(
    retirementClient([stamped('log-late', '2026-08-20T09:46:00.000Z')]).client as never,
    {
      connector: 'xero',
      invoiceId: 'inv-1',
      ledgerStatus: 'VOIDED',
      classifierProof: null,
      ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
    },
  )
  const unproven = await retireBillPaymentRegistrationsReversedInLedger(
    retirementClient([stamped('log-late', '2026-08-20T09:46:00.000Z')]).client as never,
    {
      connector: 'xero',
      invoiceId: 'inv-1',
      ledgerStatus: 'AUTHORISED',
      classifierProof: null,
      ledgerObservedBefore: databaseLedgerFence(new Date('2026-08-20T09:45:00.000Z')),
    },
  )

  assert.equal(undecided.decided === false && undecided.withheld, 'REGISTRATION_UNDECIDED')
  assert.equal(unproven.decided === false && unproven.withheld, 'REVERSAL_UNPROVEN')
  assert.notEqual(
    undecided.decided === false && undecided.withheld,
    unproven.decided === false && unproven.withheld,
  )
})

// ---------------------------------------------------------------------------
// Structural claims. Asserted against the source, because a mock harness for the poller or the server
// action would be testing the mocks rather than where these writes actually sit.
// ---------------------------------------------------------------------------

test('the Xero poller clears paidAt and retires the registration in ONE transaction', () => {
  // Split across two transactions, a crash in between leaves either a bill IMS thinks is unpaid with a
  // live SYNCED row that will refuse every re-payment, or a retired row with the bill still marked
  // paid. The observation and the action it justifies have to commit together.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  assert.ok(blockStart > 0, 'the bill reversal pass must exist')
  const block = src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart))

  const txAt = block.indexOf('await db.$transaction(async (tx) => {')
  assert.ok(txAt > 0, 'the bill reversal must open a transaction')
  assert.ok(
    block.indexOf('tx.purchaseInvoice.update(') > txAt,
    'paidAt must be cleared on the transaction client, not on db',
  )
  assert.ok(
    block.indexOf('retireBillPaymentRegistrationsReversedInLedger(tx,') > txAt,
    'the retirement must run on the same transaction client',
  )
})

test('the poller withholds the paidAt clear when the read cannot decide a registration (round 4 #2)', () => {
  // The retirement and the clear are two halves of one verdict. Clearing paidAt on an undecided
  // verdict is what makes the stranding permanent: it removes the bill from the reversal pass's
  // candidate query, so no later Xero read can ever revisit the registration. Holding it keeps the
  // bill in that query AND in the daily reconcile's suspect-advance report.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  assert.ok(blockStart > 0, 'the bill reversal pass must exist')
  const block = src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart))

  const retireAt = block.indexOf('retireBillPaymentRegistrationsReversedInLedger(tx,')
  const guardAt = block.indexOf('if (verdict.decided) {')
  const clearAt = block.indexOf('tx.purchaseInvoice.update(')
  assert.ok(retireAt > 0, 'the retirement must run inside the transaction')
  assert.ok(guardAt > retireAt, 'the verdict must be consulted before anything is cleared')
  assert.ok(clearAt > guardAt, 'the paidAt clear must sit INSIDE the decided branch')
  // The withheld case must be reported and counted, not silently skipped — a disagreement between IMS
  // and the ledger that nobody is told about is the same defect one layer up.
  assert.ok(block.includes("action: 'bill_payment_reversal_withheld'"), 'a withheld reversal must be logged')
  assert.ok(block.includes('result.billReversalsWithheld++'), 'a withheld reversal must be counted')
  assert.ok(
    block.includes("undecidedSyncLogIds: outcome.withheld === 'REGISTRATION_UNDECIDED' ? outcome.undecided : []"),
    'the log must name the registrations the read could not decide — and only when that is the cause, '
      + 'since round 8 added a second withheld cause that has no registration list at all',
  )
})

/**
 * Comments are stripped before any of the round-8 structural claims are read, and the strip is itself
 * asserted to have removed something. Every one of these claims is about what the CODE does, and this
 * block is heavily commented in exactly the vocabulary the assertions look for — "VOIDED",
 * "AUTHORISED", "ledgerStatus" — so an unstripped scan would pass on the prose after the code that
 * earned it had been deleted. That is the round-7 failure mode (a guard inspecting nothing) with a
 * different disguise.
 *
 * Line-oriented rather than tokenising: only whole-line `//` comments and block-comment runs are
 * removed, so a string literal is never touched.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

test('the poller hands the retirement the ledger\'s OWN status and classifies nothing itself (round 8)', () => {
  // THE DEFECT THIS CLOSES lives at this call site: the poller selected a bill into the reversal loop
  // from `AUTHORISED` ∪ `VOIDED` and then called the retirement, so "the ledger says the payment is
  // gone" was asserted by the SELECTION rather than by any status. The fix must not become a second
  // classifier here — one module decides what a status proves, and the poller passes a fact — so this
  // asserts both halves: the status IS handed over, and no judgement about it is made on the way.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  assert.ok(blockStart > 0, 'the bill reversal pass must exist')
  const raw = src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart))
  const block = stripComments(raw)
  assert.ok(
    block.length < raw.length,
    'the comment strip removed nothing — these assertions would be reading prose, not code',
  )
  assert.ok(
    block.includes('retireBillPaymentRegistrationsReversedInLedger(tx,'),
    'the strip must not have eaten the code under inspection',
  )

  assert.ok(
    /const ledgerStatus =[\s\S]*?invoiceById\.get\(/.test(block),
    'the status must be read off the invoice the delta actually returned, not inferred from the candidate set',
  )
  assert.ok(
    /retireBillPaymentRegistrationsReversedInLedger\(tx, \{[\s\S]*?ledgerStatus,/.test(block),
    'the retirement must be TOLD the ledger status — without it the destructive path has no proof to check',
  )
  // No second answer to the one question. A comparison against a Xero status literal here would mean
  // the poller deciding what counts as a reversal alongside the domain module, and the two would
  // eventually disagree about whether a supplier has been paid.
  assert.ok(
    !/[=!]==\s*'(VOIDED|AUTHORISED)'/.test(block) && !/'(VOIDED|AUTHORISED)'\s*[=!]==/.test(block),
    'the poller must not compare the ledger status itself — that decision belongs to ledgerAloneProvesTheReversal',
  )
  assert.ok(
    !block.includes('ledgerAloneProvesTheReversal') && !block.includes('LEDGER_SETTLED_REVERSAL_STATUSES'),
    'the proof rule must be applied at the destructive write, not re-applied at the call site',
  )
})

test('the poller reports WHICH withheld cause it hit, because the two need different actions (round 8)', () => {
  // One counter, two sentences. REGISTRATION_UNDECIDED tells the operator to wait — IMS will decide it
  // on a later read — and that instruction is actively wrong for a part payment, which no future Xero
  // read will resolve on its own. A single shared message would send every part-paid bill away with it.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  const raw = src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart))
  const block = stripComments(raw)
  assert.ok(block.length < raw.length, 'the comment strip removed nothing')

  assert.ok(block.includes("outcome.withheld === 'REVERSAL_UNPROVEN'"), 'the unproven cause must get its own description')
  assert.ok(block.includes('withheld: outcome.withheld'), 'the activity metadata must record which cause it was')
  assert.ok(block.includes('ledgerStatus,'), 'the activity metadata must record the status that was refused')
  // Still ONE counter and ONE action: splitting them per cause would hide the fact an operator watches.
  assert.equal(
    block.split('result.billReversalsWithheld++').length - 1,
    1,
    'both causes must increment the same single withheld counter',
  )
  assert.equal(
    block.split("action: 'bill_payment_reversal_withheld'").length - 1,
    1,
    'both causes must be logged under the one action o3d-batch-billpay also writes',
  )
})

test('the poller fences the retirement on when XERO WAS ASKED, not on the start of the delta window', () => {
  // lastPollDate is the start of the period the delta covers; the read happens at its END. Fenced on
  // the window start, every registration that posted during the preceding poll interval counted as
  // unreadable — and on a cold cursor that interval is the 24h default.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/payment-poller.ts'), 'utf8')
  // SUPERSEDED ASSERTION (o3d-m5qk). This used to require `ledgerObservedBefore: pollStartedAt`, and
  // `pollStartedAt` is `new Date()` on whichever instance runs the poll. o3d-clxw round 4 (#634)
  // established that a HOST clock may not appear on either end of this comparison at all — the row end
  // is `clock_timestamp()` written by the database, and comparing the two across machines is what
  // clears paidAt over a payment still in flight. The requirement the original was reaching for — the
  // instant XERO WAS ASKED, not the start of the window it covers — is unchanged and is what is
  // asserted now; only the clock it is read from has moved, and `pollStartedAt` is now the thing that
  // must NOT be passed.
  assert.ok(
    src.includes('const ledgerObservedBefore = await readDatabaseLedgerFence()'),
    'the observation instant must be minted from the DATABASE clock before the fetch',
  )
  assert.equal(
    src.indexOf('ledgerObservedBefore: pollStartedAt'),
    -1,
    'this host\'s clock must never stand in for the instant the ledger was asked',
  )
  assert.ok(src.includes('windowStart: lastPollDate'), 'the WooCommerce refund window is still the delta window')
  const blockStart = src.indexOf('--- Purchase bill payment reversals')
  const block = src.slice(blockStart, src.indexOf('export async function pollXeroPayments', blockStart))
  assert.ok(block.includes('ledgerObservedBefore,'), 'the retirement must be fenced on the read instant')
  assert.equal(
    block.indexOf('ledgerObservedBefore: windowStart'),
    -1,
    'the delta window start must no longer stand in for the moment Xero was asked',
  )
})

test('markBillPaid rolls back when the accounting queue DECLINES the enqueue (round 4 #4)', () => {
  // Round 3 moved the enqueue inside the transaction so the two writes share a fate — against a THROW.
  // queueAccountingSyncTx does not throw when it declines, it returns FALSE, and round 3 stored that
  // in `queued`, never read it, and committed: bill PAID in IMS, nothing queued, no FAILED row, ledger
  // still showing the full amount outstanding.
  const src = readFileSync(join(process.cwd(), 'app/actions/purchase-orders.ts'), 'utf8')
  const start = src.indexOf('MARK PAID, RETIRE THE PRE-CALL REGISTRATIONS, AND QUEUE THE REPLACEMENT')
  assert.ok(start > 0, 'the markBillPaid settlement block must exist')
  const block = src.slice(start, src.indexOf("action: 'bill_paid'", start))

  const queueAt = block.indexOf('queueAccountingSyncTx(tx,')
  const throwAt = block.indexOf('if (!queued) throw new BillPaymentEnqueueDeclined(')
  const txEndAt = block.indexOf('}, STOCK_TX_OPTIONS)')
  assert.ok(queueAt > 0, 'the enqueue must still be inside the transaction')
  assert.ok(throwAt > queueAt && throwAt < txEndAt, 'a falsy enqueue result must roll the transaction back')
  // The escape valve stays open: a bill the ledger never received has nothing to keep in step with.
  assert.ok(
    block.includes('if (invoice.accountingInvoiceId) {'),
    'the refusal must be scoped to bills the ledger actually holds',
  )
  // A decline is a SETTING to change, not a fault to retry, and the two must not share a message.
  assert.ok(block.includes("action: declined ? 'bill_payment_enqueue_declined'"), 'a decline must be logged as its own event')
  assert.match(BILL_PAYMENT_ENQUEUE_DECLINED_MESSAGE, /switched off/)
  assert.match(BILL_PAYMENT_ENQUEUE_DECLINED_MESSAGE, /nothing was changed/i)
})

test('markBillPaid queues the replacement INSIDE the transaction that marks the bill paid (round 3 #4)', () => {
  // Round 2 committed the paid transition and the retirement together, then queued afterwards — so a
  // crash in between left a bill marked PAID with nothing queued and no FAILED row to notice it. The
  // enqueue is PurchaseInvoice-scoped, so queueAccountingSyncTx applies with no order-lock hoist.
  const src = readFileSync(join(process.cwd(), 'app/actions/purchase-orders.ts'), 'utf8')
  const start = src.indexOf('MARK PAID, RETIRE THE PRE-CALL REGISTRATIONS, AND QUEUE THE REPLACEMENT')
  assert.ok(start > 0, 'the markBillPaid settlement block must exist')
  const block = src.slice(start, src.indexOf("action: 'bill_paid'", start))

  const txAt = block.indexOf('await db.$transaction(async (tx) => {')
  const markAt = block.indexOf('markBillPaidSupersedingStaleRegistrations(tx,')
  const queueAt = block.indexOf('queueAccountingSyncTx(tx,')
  const txEndAt = block.indexOf('}, STOCK_TX_OPTIONS)')
  assert.ok(txAt >= 0 && markAt > txAt, 'the paid transition must run on the transaction client')
  assert.ok(queueAt > markAt, 'the BILL_PAYMENT enqueue must run on the SAME transaction client')
  assert.ok(queueAt < txEndAt, 'the enqueue must be INSIDE the transaction, not after it')
  assert.equal(
    block.indexOf('queueAccountingSync({'),
    -1,
    'the post-transaction, own-transaction enqueue must be gone — that is the gap being closed',
  )
})
