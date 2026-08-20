import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BILL_PAYMENT_LEDGER_REVERSED_REASON,
  BILL_PAYMENT_SUPERSEDED_REASON,
  billPaymentRefusalMessage,
  markBillPaidSupersedingStaleRegistrations,
  planBillPaymentSupersession,
  retireBillPaymentRegistrationsReversedInLedger,
} from '@/lib/domain/accounting/payment-reversal'

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

const PROCESSING_ROW = { id: 'log-inflight', status: 'PROCESSING' }
const SYNCED_ROW = { id: 'log-posted', status: 'SYNCED' }

test('a PENDING registration is superseded — nothing has been sent, so cancelling it IS the whole event', () => {
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'PENDING' }])
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
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'PENDING' }, SYNCED_ROW])
  assert.equal(plan.proceed, false)
  assert.equal(plan.proceed === false && plan.refusal, 'PAYMENT_ALREADY_POSTED')
})

test('FAILED and CANCELLED rows are left exactly as they are', () => {
  // They are already outside the live predicate, so they block nothing — and rewriting a FAILED row as
  // CANCELLED would erase the fact that the ledger rejected it, which is the evidence an operator needs
  // and which the "FAILED does not prove nothing posted" reading (o3d-ju8t) depends on.
  const plan = planBillPaymentSupersession([{ id: 'log-1', status: 'FAILED' }, { id: 'log-2', status: 'CANCELLED' }])
  assert.equal(plan.proceed, true)
  assert.deepEqual(plan.proceed && plan.supersede, [])
})

test('every refusal tells the operator what to do, and the posted one says where to look', () => {
  // A refusal an operator cannot act on is a refusal they will work around by re-recording the
  // payment, which is the single action that turns an ambiguity into a duplicate.
  assert.match(billPaymentRefusalMessage('PAYMENT_IN_FLIGHT'), /Wait for that sync entry to finish/)
  assert.match(billPaymentRefusalMessage('PAYMENT_ALREADY_POSTED'), /Open the bill in the connector/)
  assert.match(billPaymentRefusalMessage('PAYMENT_ALREADY_POSTED'), /cancel that sync entry/)
  assert.match(billPaymentRefusalMessage('PAYMENT_STATE_CHANGED'), /Nothing was changed/)
})

// ---------------------------------------------------------------------------
// DB WIRING. Round 1 tested only the pure predicate, so nothing checked that the paidAt write and the
// retirement happen in ONE transaction, that the retirement is status-fenced, or that a refusal reaches
// the caller at all. These drive the real function against a recording transaction client.
// ---------------------------------------------------------------------------

type SyncRow = { id: string; status: string }

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

// ---------------------------------------------------------------------------
// THE OTHER HALF: retirement moves to the one component that reads the ledger.
// ---------------------------------------------------------------------------

test('a reversed bill retires only SYNCED rows that had already posted when the ledger was read', async () => {
  const updates: Array<{ where?: Record<string, unknown>; data?: unknown }> = []
  const client = {
    accountingSyncLog: {
      updateMany: async (args: { where?: Record<string, unknown>; data?: unknown }) => {
        updates.push(args)
        return { count: 1 }
      },
    },
  }
  const observedBefore = new Date('2026-08-20T09:45:00.000Z')

  const retired = await retireBillPaymentRegistrationsReversedInLedger(client as never, {
    connector: 'xero',
    invoiceId: 'inv-1',
    ledgerObservedBefore: observedBefore,
  })

  assert.equal(retired, 1)
  assert.deepEqual(updates[0].where, {
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'inv-1',
    // SYNCED only: a PENDING row is a re-payment someone has already queued and a PROCESSING row may
    // be posting this instant. Neither is the payment this ledger read failed to find.
    status: { in: ['SYNCED'] },
    // And only a row that had already posted when the snapshot behind this verdict was taken. One
    // that synced afterwards may have created a payment the read never saw, so "not present" says
    // nothing about it — and a row with no syncedAt is excluded by the comparison, which is the safe
    // direction: it falls through to markBillPaid's refusal and a human.
    syncedAt: { lt: observedBefore },
  })
  assert.equal((updates[0].data as { status: string }).status, 'CANCELLED')
  assert.equal((updates[0].data as { errorMessage: string }).errorMessage, BILL_PAYMENT_LEDGER_REVERSED_REASON)
  // o3d-sref: CANCELLED must never silently assert "nothing was sent" where that is false, so the
  // reason string is what carries the truth — this entry DID post.
  assert.match(BILL_PAYMENT_LEDGER_REVERSED_REASON, /The entry posted/)
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
