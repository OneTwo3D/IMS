import { isLockedPluginSelectionRead, lockedPluginSelectionRows } from '../helpers/plugin-selection-double.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-ekn8 r4 (Codex MEDIUM) — `queued: true` WITHOUT A WRITE HAS TO SAY SO.
 *
 * `queueAccountingSyncTx` short-circuits when it finds a LIVE row on the same scope whose payload
 * carries this idempotency key: it reports success and writes nothing. That is right for the fourteen
 * callers that only ask "is this work on the queue", and wrong for the one that then decides whether
 * to ROLL THE WRITE BACK.
 *
 * `registerInvoicePaymentWithLedger` throws out of its transaction when the enqueue names a connector
 * other than the pinned one, to unwrite the row. On the short-circuit there is no row to unwrite: the
 * pre-existing one is untouched, still live, and still going to post — while the operator is told
 * "Nothing was sent", which is the one message that stops anyone looking for it.
 *
 * So the outcome carries `reason: 'already-queued'`. This drives the REAL function, because the
 * caller's own tests fake the enqueue and would pass whatever the fake says.
 */

const state = {
  // o3d-d0pd: the already-present check now reads every row for the key in ANY status and decides
  // from its evidence, so the fixture carries the columns that verdict is reached from.
  existingRow: null as {
    id: string
    status: string
    externalTransactionId: string | null
    settlementBasis?: string | null
    abandonedBeforeRemoteCall?: boolean | null
  } | null,
  created: [] as unknown[],
  /** Every `tx.activityLog.create` - the report/refusal rows written THROUGH the caller's transaction. */
  activity: [] as Array<{ action: string; description: string }>,
}

mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => id === 'xero' },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({ xero_sync_enabled: 'true', xero_sync_sales_invoice: 'submitted' }),
  },
})
// INVOICE_PAYMENT is not in XERO_SYNC_TYPE_SETTING, so its posting mode is the unconditional
// 'submitted' — no setting to stub. SALES_INVOICE is stubbed above for the second case.
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: { resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }) },
})
mock.module('@/lib/domain/accounting/followup-scope-lock', {
  namedExports: { lockFollowUpScope: async () => undefined },
})
mock.module('@/lib/connectors/accounting-id-provenance', {
  namedExports: { activeAccountingIdProvenance: async () => ({}) },
})
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined },
})

function tx() {
  return {
    accountingSyncLog: {
      // The `where` is HONOURED, not ignored. A stub that returns the fixture whatever it is asked
      // makes every claim about the query vacuous — and the query is half of o3d-d0pd: a classifier
      // that handles FAILED correctly is worth nothing behind a read that filters FAILED out.
      findMany: async ({ where }: { where?: { status?: { in?: string[] } } } = {}) => {
        // o3d-f709: an omitted ledger column reads as `undefined` (an unrecognised basis: UNKNOWN), so the
        // fixture defaults them to what Prisma returns for an untouched row.
        const rows = state.existingRow
          ? [{ settlementBasis: null, abandonedBeforeRemoteCall: null, ...state.existingRow }]
          : []
        const statuses = where?.status?.in
        return statuses ? rows.filter((row) => statuses.includes(row.status)) : rows
      },
      create: async ({ data }: { data: unknown }) => {
        state.created.push(data)
        return { id: 'log-new', ...(data as Record<string, unknown>) }
      },
    },
    activityLog: {
      create: async ({ data }: { data: { action: string; description: string } }) => {
        state.activity.push({ action: data.action, description: data.description })
        return { id: 'act-1' }
      },
    },
    $executeRaw: async () => 1,
    // o3d-j625 r13: the selection FENCE now runs on every enqueue, so the double answers its locked read
    // (tests/helpers/plugin-selection-double.ts). Xero enabled, which is this fixture's premise — an empty
    // answer reports every plugin disabled and the enqueue then refuses for a reason these tests are not
    // about.
    $queryRaw: async (query: TemplateStringsArray) => (
      isLockedPluginSelectionRead(query) ? lockedPluginSelectionRows(['xero']) : []
    ),
  }
}

const params = {
  type: 'INVOICE_PAYMENT' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  payload: { amount: 100 },
  idempotencyKey: 'invoice-payment:payment:pay-1:invoice:INV-1',
  unlockedOrderScopeReason: 'test harness: the order guard is stubbed to a non-order scope',
  // o3d-j625 r2: required on the enqueue now, and 'xero' is the only connector this file's plugin
  // double has switched on — so the chart check passes and every outcome below still comes from the
  // idempotency classification it is about.
  chartConnector: 'xero' as const,
}

test.beforeEach(() => {
  state.existingRow = null
  state.created = []
  state.activity = []
})

test('[o3d-ekn8 r4] a WRITE reports queued with no already-queued reason', async () => {
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  assert.equal(outcome.queued, true)
  assert.equal(state.created.length, 1, 'this call is the one that put the work on the queue')
  assert.notEqual(outcome.reason, 'already-queued', 'so a caller that rolls back really does undo something')
})

test('[o3d-ekn8 r4] the idempotency short-circuit reports queued AND says nothing was written', async () => {
  state.existingRow = { id: 'log-live', status: 'PENDING', externalTransactionId: null }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  assert.equal(outcome.queued, true, 'the work IS on the queue — that half is unchanged')
  assert.equal(state.created.length, 0, 'but this call wrote nothing')
  assert.equal(
    outcome.reason,
    'already-queued',
    'and it must say so, or a caller that rolls back reports "nothing was sent" over a live row that will post',
  )
})

// ---------------------------------------------------------------------------
// o3d-d0pd — A FAILED ATTEMPT IS NOT NOTHING
//
// The short-circuit above only saw PENDING/PROCESSING/SYNCED, and so did the partial unique index
// that would otherwise have been the backstop. A refund whose reversal was queued and has since
// FAILED therefore let `retryRefundAccounting` enqueue the same posting a SECOND time, and both rows
// could post. These drive the real enqueue, because the caller's own tests fake it.
// ---------------------------------------------------------------------------

test('[o3d-d0pd] a FAILED row for this key REFUSES the enqueue instead of duplicating it', async () => {
  state.existingRow = { id: 'log-failed', status: 'FAILED', externalTransactionId: null }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  // MUTATION ROUTE: put `status: { in: ['PENDING','PROCESSING','SYNCED'] }` back on the read in
  // lib/accounting.ts (or make `classifyPriorAttempts` ignore FAILED) and `created.length` becomes 1
  // — the duplicate posting this issue is about.
  assert.equal(state.created.length, 0, 'a second row for this key is the duplicate posting')
  assert.equal(outcome.queued, false, 'and it must not be reported as queued: nothing was written')
  assert.equal(outcome.reason, 'refused',
    'refused, not not-configured: the posting is STILL OWED and the caller must not settle on it')
})

test('[o3d-d0pd] a FAILED row that NAMES a document reports the counterpart, and still writes nothing', async () => {
  state.existingRow = { id: 'log-failed', status: 'FAILED', externalTransactionId: 'PAY-777' }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  // MUTATION ROUTE: drop the `posted` arm and this reports `refused`, which leaves an obligation
  // outstanding for a document an operator can already see in the ledger.
  assert.equal(state.created.length, 0)
  assert.equal(outcome.queued, true, 'the document exists — the GL counterpart is there (o3d-ju8t)')
  assert.equal(outcome.reason, 'already-queued', 'and this call wrote nothing, so a roll-back would undo nothing')
})

test('[o3d-f709 / o3d-kj718] a CLAIMED attempt that was cancelled without proof REFUSES the same-key retry at the ENQUEUE DECISION', async () => {
  // The sale-cancel sweep over a FAILED/PROCESSING row, the post-time retirement of a claimed row and
  // a capacity refusal all leave CANCELLED + no id + NO pre-call stamp. The index does not cover it,
  // so the enqueue is the only thing between this retry and a second posting.
  state.existingRow = { id: 'log-claimed-cancelled', status: 'CANCELLED', externalTransactionId: null }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  console.log(`# precondition kj718 enqueue: created=${state.created.length} outcome=${JSON.stringify(outcome)} activity=${state.activity.map((a) => a.action)}`)
  assert.equal(state.created.length, 0, 'no second posting beside a possibly-posted attempt')
  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'refused', 'still owed: the caller must not settle on it')
  assert.deepEqual(state.activity.map((a) => a.action), ['accounting_enqueue_refused_unresolved_attempt'])
  assert.match(state.activity[0].description, /cancelled without proof/)
})

test('[o3d-f709 / o3d-kj718] ISOLATING ARM: a NEVER-CLAIMED cancelled row (stamped pre-call) re-enqueues', async () => {
  state.existingRow = { id: 'log-never-claimed', status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  assert.equal(state.created.length, 1, 'the sale-cancel / supersession / sweep cancellation of an unclaimed row stays re-enqueueable')
  assert.equal(outcome.queued, true)
  assert.deepEqual(state.activity, [])
})

// ---------------------------------------------------------------------------
// o3d-f709 / M11 - the two answers a row an OPERATOR settled gets, driven through the REAL enqueue.
//
// TWO-MECHANISM ISOLATION. These tests bypass the BILL_PAYMENT supersession planner entirely (they
// call the enqueue directly), and the planner tests (bill-payment-supersession.test.ts) never reach an
// enqueue, so a refusal here can only be the enqueue's own classification.
// ---------------------------------------------------------------------------

test('[o3d-f709 M11, D2] an operator-typed SYNCED id SUPPRESSES the enqueue AND a report row is written through tx', async () => {
  state.existingRow = {
    id: 'log-typed', status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION',
  }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  console.log(`# precondition M11 asserted: created=${state.created.length} activity=${JSON.stringify(state.activity.map((a) => a.action))}`)
  assert.equal(state.created.length, 0, 'suppressed: the document is claimed to exist')
  assert.equal(outcome.queued, true)
  assert.equal(outcome.reason, 'already-queued')
  assert.deepEqual(state.activity.map((a) => a.action), ['accounting_enqueue_suppressed_by_operator_assertion'],
    'and the suppression is REPORTED, never silent')
  assert.match(state.activity[0].description, /OPERATOR'S WORD/)
  assert.match(state.activity[0].description, /TYPED-1/)
})

test('[o3d-f709 M11, D2] ISOLATING ARM: the same SYNCED row confirmed by the connector suppresses WITHOUT a report', async () => {
  // Mutating the suppression to "report always" or "never report" is told apart by this pair: with
  // the assertion the report row exists, without it none does.
  state.existingRow = { id: 'log-real', status: 'SYNCED', externalTransactionId: 'PAY-1', settlementBasis: null }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  assert.equal(state.created.length, 0)
  assert.equal(outcome.reason, 'already-queued')
  assert.deepEqual(state.activity, [], 'an ordinary suppression is not a warning')
})

test('[o3d-f709 M11, C1/D1] a CANCELLED row an operator settled NOT_POSTED REFUSES the enqueue - nothing written, refusal reported', async () => {
  state.existingRow = {
    id: 'log-settled', status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION',
  }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  console.log(`# precondition M11 blocked: created=${state.created.length} outcome=${JSON.stringify(outcome)}`)
  assert.equal(state.created.length, 0, 'a second row for this key is the duplicate posting')
  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'refused', 'the posting is STILL OWED, so a caller must not settle on it')
  assert.deepEqual(state.activity.map((a) => a.action), ['accounting_enqueue_refused_asserted_not_posted'])
  assert.match(state.activity[0].description, /settled by an operator as "not posted"/)
  assert.match(state.activity[0].description, /mark this posting handled/)
})

test('[o3d-f709 M11] ISOLATING ARM: the identical CANCELLED row WITHOUT the assertion, but PROVEN pre-call, writes the replacement', async () => {
  state.existingRow = { id: 'log-cancelled', status: 'CANCELLED', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: true }
  const { queueAccountingSyncTxWithOutcome } = await import('@/lib/accounting')
  const outcome = await queueAccountingSyncTxWithOutcome(tx() as never, params)

  assert.equal(state.created.length, 1)
  assert.equal(outcome.queued, true)
})
