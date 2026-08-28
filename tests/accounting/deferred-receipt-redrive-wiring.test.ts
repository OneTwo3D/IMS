import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  FOLLOW_UPS_ENQUEUED,
  obligationReleasePrerequisite,
  refusedFollowUpEnqueue,
} from '@/lib/domain/accounting/followup-enqueue-outcome'

/**
 * o3d-ekn8 — DB WIRING for the deferred-receipt re-drive.
 *
 * Round 1 covered `selectReceiptsAwaitingRegistration` and `decideInvoicePaymentRegistration` as pure
 * functions and stopped there, so nothing checked the part that actually moves money: that
 * `registerDeferredOrderReceipts` re-reads the LIVE sync rows between receipts, so the second receipt is
 * measured against an invoice the first has already consumed part of. Get that wrong — hoist the read,
 * or re-use the selection snapshot — and a two-receipt order double-settles its invoice, with every
 * pure test still green.
 *
 * This drives the real function against a stateful fake database.
 */

type QueuedRow = { type: string; payload: Record<string, unknown>; idempotencyKey?: string }

const state = {
  // `id` is not decoration: o3d-0m56 derives the token an attempt POSTED under from the row id when
  // its payload pinned none, so a row without one makes the settlement marker a hash of `undefined`.
  syncRows: [] as Array<{ id: string; status: string; externalTransactionId: null; errorMessage: null; retryCount: number; payload: Record<string, unknown> }>,
  queued: [] as QueuedRow[],
  activity: [] as Array<{ action: string; level: string; description: string; metadata: Record<string, unknown> }>,
  payments: [] as Array<{ id: string; amount: number; currency: string; method: string | null; reference: string | null; paidAt: Date }>,
  /**
   * o3d-0bfh r15: every write that CLEARS the follow-up obligation marker, with the predicate it was
   * fenced on. The finding is about a marker cleared over a receipt nothing considered, so the test
   * has to be able to see the clearing write itself — not just the boolean the pass returned.
   */
  markerClears: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  // o3d-ekn8 r4: WHICH connector the enqueue reports the row was written under. The pinned
  // registration fences on this, so it has to be able to differ from the pin.
  enqueueConnector: 'xero' as string,
  order: {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null as string | null,
    accountingInvoiceId: 'INV-1' as string | null,
    currency: 'GBP',
    totalForeign: 100,
    taxForeign: 0,
    pricesIncludeVat: false,
    shoppingLinks: [] as Array<{ connector: string }>,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
      accountingSyncLog: { findMany: async () => state.syncRows },
      salesOrder: {
        findUnique: async () => ({
          ...state.order,
          payments: state.payments,
        }),
      },
      payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
    },
  },
})

function txClient() {
  return {
    accountingSyncLog: {
      findMany: async () => state.syncRows,
      // o3d-0bfh r15: the obligation release now happens INSIDE the fenced transaction, so the
      // transaction client is what performs it. Recorded rather than swallowed — see markerClears.
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.markerClears.push({ where, data })
        return { count: 1 }
      },
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null,
      // o3d-0bfh r15: THE FENCE'S OWN RE-READ. Deliberately served from `state.payments` as it is at
      // the moment of the call, so a receipt appended by `onOrderLock` — i.e. one that committed
      // after the pass's snapshot — is visible to it and to nothing else.
      findMany: async () => state.payments,
    },
    // o3d-ekn8 r2: the pinned document is re-read UNDER THE LOCK, so the transaction client has to be
    // able to answer for the order too.
    salesOrder: { findUnique: async () => ({ ...state.order, payments: state.payments }) },
    // o3d-0m56 took a SECOND lock inside this transaction: `lockFollowUpScope` is a
    // `pg_advisory_xact_lock` issued through `$executeRaw`, on top of the sales-order row lock
    // (`$queryRaw ... FOR UPDATE`). Both are no-ops here — this file drives one caller at a time and
    // asserts ORDERING of registrations, not of locks — but they must EXIST, or the enqueue dies
    // before it registers anything and every count below reads zero.
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level: string; description: string; metadata: Record<string, unknown> }) => {
      // o3d-ekn8 r3: the DESCRIPTION is kept too. A refusal branch whose only assertion is its metadata
      // code can be reached with an operator message that says nothing, and one of these branches had
      // never been executed by a test at all.
      state.activity.push({ action: entry.action, level: entry.level, description: entry.description, metadata: entry.metadata })
    },
  },
})

/**
 * o3d-ekn8 r3 (Codex MEDIUM) — RUN WHEN THE ORDER ROW LOCK IS TAKEN.
 *
 * That instant is the one the in-lock re-read exists for: a writer queued behind the lock has just
 * committed, so anything it changed is now visible and the PRE-lock comparison was made in a window
 * that has since reopened. Without a way to land a re-post exactly here, the `document-moved` branch
 * cannot be driven at all — which is why it had never been executed by a test.
 */
let onOrderLock: (() => void) | null = null

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async () => {
      const landed = onOrderLock
      onOrderLock = null
      landed?.()
    },
  },
})

mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    // o3d-ekn8 r2: the re-drive now asks the EXPLICIT-connector form, because the answer has to be about
    // the connector that posted rather than whichever one is active when the re-drive runs.
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getPaymentAccountMap: async () => ({ default: 'BANK-1' }),
    lookupPaymentAccount: () => 'BANK-1',
    queueAccountingSyncTxWithOutcome: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      // o3d-ekn8 r3 — THE IDEMPOTENCY SHORT-CIRCUIT IS MODELLED, because it is one of the gates.
      //
      // `queueAccountingSync` looks for a LIVE row on the same scope whose payload carries this key and,
      // finding one, REPORTS `queued: true` HAVING WRITTEN NOTHING. A fake that always wrote made that
      // gate invisible, so a key that cannot tell two documents apart looked harmless here while it
      // silently swallowed the replacement invoice's payment in production.
      if (params.idempotencyKey && state.syncRows.some((row) =>
        ['PENDING', 'PROCESSING', 'SYNCED'].includes(row.status)
        && (row.payload as Record<string, unknown>)._idempotencyKey === params.idempotencyKey)) {
        // o3d-ekn8 r4: and it says SO. `queued: true` here means "the work is on the queue", not
        // "this call put it there" — the caller that rolls the write back needs to know the
        // difference, because there is nothing to roll back and the existing row still posts.
        return { queued: true, reason: 'already-queued', connector: state.enqueueConnector }
      }
      state.queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      // A queued row is immediately live and visible to the next receipt's capacity read — which is the
      // whole behaviour under test.
      state.syncRows.unshift({
        id: `log-${state.queued.length}`,
        status: 'PENDING',
        externalTransactionId: null,
        errorMessage: null,
        retryCount: 0,
        // Stamped exactly as the real enqueue stamps it, or the short-circuit above could never fire.
        payload: { ...params.payload, ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}) },
      })
      // The enqueue names the connector the row was WRITTEN under (o3d-2sm1 r8), which the pinned
      // registration fences on.
      return { queued: true, connector: state.enqueueConnector }
    },
  },
})

/** The generation the "caller" claimed — the exact value the fenced release must clear on. */
const OBLIGATION = new Date('2026-08-01T00:00:00.000Z')

async function redrive(
  postedInvoiceId = 'INV-1',
  obligation: Date | null = OBLIGATION,
  /**
   * o3d-0bfh r16: the CALLER'S own settlement prerequisite. Absent on every test above, which is the
   * post path's shape — one fenced pass, exactly as r15 left it.
   */
  settlementPrerequisite?: () => Promise<boolean>,
) {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: postedInvoiceId }, {
    syncLogId: 'sync-1',
    connector: 'xero',
    generation: obligation,
    recovery: { consumer: 'sweep' },
    ...(settlementPrerequisite ? { settlementPrerequisite } : {}),
  })
}

test.beforeEach(() => {
  state.syncRows = []
  state.queued = []
  state.activity = []
  state.payments = []
  state.markerClears = []
  state.order.accountingInvoiceId = 'INV-1'
  onOrderLock = null
  state.order.totalForeign = 100
  state.order.taxForeign = 0
  state.order.pricesIncludeVat = false
  state.order.shoppingLinks = []
  state.enqueueConnector = 'xero'
})

test('each receipt is measured against what the PREVIOUS one already consumed', async () => {
  // Two GBP 100 receipts against a GBP 100 invoice. Only the first fits; the second must be refused
  // with a named reason, not queued behind it.
  state.payments = [
    { id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') },
    { id: 'pay-2', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02') },
  ]

  await redrive()

  assert.equal(state.queued.length, 1, 'exactly one receipt may be registered against a fully consumed invoice')
  assert.equal(state.queued[0].idempotencyKey, 'invoice-payment:payment:pay-1:invoice:INV-1')
  assert.equal(state.queued[0].payload.paymentId, 'pay-1')

  const refusals = state.activity.filter((a) => a.action === 'invoice_payment_not_registered')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].metadata.refusal, 'WOULD_OVERPAY')
  assert.equal(refusals[0].metadata.paymentId, 'pay-2')
  assert.equal(refusals[0].metadata.alreadyRegistered, 100)
})

test('a deposit and a balance that together fit are BOTH registered', async () => {
  // The guard must not collapse back into one-payment-per-order, which is the key mistake o3d-cjt8
  // corrected in the first place.
  state.payments = [
    { id: 'pay-1', amount: 40, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') },
    { id: 'pay-2', amount: 60, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02') },
  ]

  await redrive()

  assert.deepEqual(state.queued.map((q) => q.idempotencyKey), [
    'invoice-payment:payment:pay-1:invoice:INV-1',
    'invoice-payment:payment:pay-2:invoice:INV-1',
  ])
  assert.equal(state.activity.filter((a) => a.action === 'invoice_payment_not_registered').length, 0)
})

test('an UNATTRIBUTED live registration suppresses the whole re-drive', async () => {
  // The imported-order shape: the SALES_INVOICE follow-up registered a receipt with no local Payment
  // row, so it cannot be matched to one, and "which receipt is this?" unanswered has to read as
  // "possibly that one".
  state.syncRows = [{ id: 'log-live', status: 'PENDING', externalTransactionId: null, errorMessage: null, retryCount: 0, payload: { amount: 100, accountingInvoiceId: 'INV-1' } }]
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
  // And not merely refused downstream: the receipt is never CONSIDERED, so no refusal is reported
  // either. Asserting only "nothing was queued" would pass on the capacity arithmetic alone and stop
  // pinning the suppression rule at all.
  assert.deepEqual(state.activity, [])
})

test('a receipt that already has its OWN sync row is never re-driven', async () => {
  // A FAILED row may have committed remotely before failing; re-driving it here would post under a
  // token the ledger has never seen. That belongs to the retry path, which pins the token.
  state.syncRows = [{ id: 'log-failed', status: 'FAILED', externalTransactionId: null, errorMessage: null, retryCount: 3, payload: { amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1' } }]
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
})

test('an order carrying NO invoice id is the back-reference having failed, and is reported', async () => {
  // THIS TEST CHANGED MEANING WITH THE PIN (o3d-ekn8 r5, Codex HIGH), so its old name and its old
  // assertion are both gone rather than quietly adjusted.
  //
  // It used to read "nothing is re-driven while the invoice has not posted", and asserted SILENCE on
  // the grounds that DOCUMENT_NOT_POSTED had already warned once when the receipt was recorded, so
  // warning again on every invoice sync would be noise. That was true while the callee re-read the
  // order's own column to find the document: a null column then genuinely meant "no invoice yet".
  //
  // Since r2 the caller PINS the id the post just returned, and the only caller is a connector that
  // has just posted a SALES_INVOICE. "The invoice has not posted" is no longer expressible here at
  // all. What a null column now means is the opposite: the invoice IS in the ledger and the local
  // back-reference write did not land — the exact state QuickBooks reaches by catching that failure.
  // Staying silent there is what let the receipts stay unregistered while the connector cleared the
  // row's follow-up obligation, so silence is now the bug and the report is the fix.
  state.order.accountingInvoiceId = null
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  const result = await redrive()

  assert.equal(state.queued.length, 0, 'a receipt cannot be attached to a document the order has no record of')
  assert.equal(result.settled, false, 'and the caller must NOT read that as work completed')
  assert.equal(state.activity.length, 1, 'the early return is reported exactly once, not per receipt')
  assert.equal(state.activity[0].action, 'deferred_invoice_payment_registration_unlinked')
  assert.equal(state.activity[0].level, 'ERROR', 'money nothing will retry')
  assert.match(String(state.activity[0].description), /INV-1/, 'naming the document that DID post')
})

// ---------------------------------------------------------------------------
// o3d-ekn8 ROUND 3 (Codex HIGH) — THE INVOICE WAS DELETED IN THE LEDGER AND RE-POSTED.
//
// o3d-hbgo taught the READ side that a sync row naming a different ledger document says nothing
// about the current invoice: it paid one this order no longer has. Two WRITE-side gates were left
// keyed on the order and the receipt instead — `selectReceiptsAwaitingRegistration`, and the
// enqueue's idempotency key — and either one alone is enough to lose the replacement's payment
// entirely. The receipt reads as spoken for, nothing is awaiting, and the function returns with
// NOTHING LOGGED, because a gate that returns an empty list has nothing to report.
//
// The scenario below is the one the branch's own commit message names as motivating.
// ---------------------------------------------------------------------------

/** The row that registered pay-1 against the invoice that has since been deleted. */
function rowForRetiredInvoice(idempotencyKey: string) {
  return {
    id: 'log-retired',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1', _idempotencyKey: idempotencyKey },
  }
}

const ONE_RECEIPT = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

// ---------------------------------------------------------------------------
// o3d-ekn8 r4 (Codex HIGH) — AND THEN THE ANCHORING WENT ONE STEP TOO FAR.
//
// r3's two tests here asserted that a SYNCED row for pay-1 against INV-1 leaves pay-1 free to be
// registered AGAINST INV-2 — the same payment id, queued a second time. That is silent
// over-settlement replacing silent under-settlement. The row is the record of a payment that was
// actually SENT, and "the old document has been deleted, so its payment went with it" is an
// assumption about a ledger nothing in this path has read. On QuickBooks a deleted invoice leaves
// its payment behind as an unapplied credit, and the customer is credited twice.
//
// So the receipt is still SELECTED — that is what keeps o3d-ekn8's "never silently unsettled"
// property, because the guarded decision then runs and REPORTS — and the decision refuses, naming
// the row an operator has to go and read. Cancelling that row is the one thing that is evidence
// rather than assumption, and it is what re-opens the path.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r4] a retired document\'s row for THIS receipt refuses, loudly, instead of queueing a second payment', async () => {
  // The old row carries an ANCHORED key for INV-1, so the enqueue's idempotency short-circuit cannot
  // fire whatever the key is: nothing but the decision decides this.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [rowForRetiredInvoice('invoice-payment:payment:pay-1:invoice:INV-1')]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 0, 'pay-1 has already been sent to the ledger once')
  const refusals = state.activity.filter((a) => a.action === 'invoice_payment_not_registered')
  assert.equal(refusals.length, 1, 'and it is REPORTED — silence is the failure o3d-ekn8 exists to prevent')
  assert.equal(refusals[0].metadata.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
  assert.match(refusals[0].description, /already registered/i)
  assert.match(refusals[0].description, /INV-1/, 'the message names the document to go and read')
  assert.match(refusals[0].description, /cancel the earlier sync row/i, 'and the remedy that clears it')
})

test('[o3d-ekn8 r4] an UN-ATTRIBUTED live row on the retired document refuses too', async () => {
  // It cannot be shown to belong to some other receipt, and for money unknown reads as "possibly
  // this one" — the direction that can only ever withhold, never duplicate.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [{
    ...rowForRetiredInvoice('invoice-payment:payment:pay-1:invoice:INV-1'),
    payload: { amount: 100, accountingInvoiceId: 'INV-1', _idempotencyKey: 'x' },
  }]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 0)
  assert.equal(
    state.activity.filter((a) => a.metadata.refusal === 'SETTLED_ON_RETIRED_DOCUMENT').length,
    1,
  )
})

test('[o3d-ekn8 r4] once the retired row is CANCELLED the replacement invoice IS settled, key and all', async () => {
  // Cancelling it is an operator asserting they read the ledger and the old payment is gone — the one
  // fact this code cannot establish for itself. o3d-ekn8's outcome then holds exactly as before: the
  // replacement is settled rather than left outstanding for ever, under a key anchored to INV-2 so
  // the retired row can never claim to be this one. The legacy un-anchored key is used deliberately,
  // because that is the shape production presents and it is what the anchor exists to defeat.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [{ ...rowForRetiredInvoice('invoice-payment:payment:pay-1'), status: 'CANCELLED' }]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 1, 'the replacement is settled rather than left outstanding for ever')
  assert.equal(state.queued[0].payload.accountingInvoiceId, 'INV-2', 'and against the REPLACEMENT')
  assert.equal(state.queued[0].payload.paymentId, 'pay-1')
  assert.equal(
    state.queued[0].idempotencyKey,
    'invoice-payment:payment:pay-1:invoice:INV-2',
    'the key names the DOCUMENT as well as the receipt, so the retired row cannot claim to be this one',
  )
  assert.equal(
    state.activity.filter((a) => a.action === 'invoice_payment_not_registered').length,
    0,
    'and it is not merely reported as refused — it is actually sent',
  )
})

test('[o3d-ekn8 r3] a receipt already registered against the CURRENT invoice is still never re-driven', async () => {
  // The narrowing must not become a licence. A row naming the document being registered against still
  // speaks for its receipt, which is the property that stops this path paying an invoice twice.
  state.syncRows = [{
    id: 'log-live',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1', _idempotencyKey: 'invoice-payment:payment:pay-1:invoice:INV-1' },
  }]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-1')

  assert.equal(state.queued.length, 0)
  assert.deepEqual(state.activity, [], 'never considered, so nothing to report — as before')
})

test('[o3d-ekn8 r3] a row that names NO document still speaks for its receipt', async () => {
  // For money, unknown is not the same as irrelevant. A row queued before the payload recorded the
  // document could be against either one, so it has to keep suppressing — the same direction the read
  // side takes, and the only one that cannot duplicate a payment.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [{
    id: 'log-unanchored',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1' },
  }]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 0)
})

// ---------------------------------------------------------------------------
// o3d-ekn8 r3 (Codex MEDIUM) — THE IN-LOCK RE-READ, DRIVEN RATHER THAN GREPPED.
//
// r2 added a second comparison of the pinned document INSIDE the write transaction, after the order
// lock, because the pre-lock one runs in a window the lock has since reopened. Its only test was an
// `indexOf` over the source: deleting the entire block failed one assertion about a string, and the
// `document-moved` branch and its operator message were executed by nothing at all.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r3] a re-post landing AFTER the pre-lock check is refused UNDER THE LOCK', async () => {
  state.payments = [...ONE_RECEIPT]
  // The delete-and-re-post was queued behind the order lock and commits the moment this call takes it.
  // Every check made before that instant was made about a document the order no longer holds.
  onOrderLock = () => { state.order.accountingInvoiceId = 'INV-9' }

  await redrive('INV-1')

  assert.equal(state.queued.length, 0, 'nothing is registered against a document this post did not return')
  const refusals = state.activity.filter((a) => a.action === 'invoice_payment_not_registered')
  assert.equal(refusals.length, 1, 'and the operator is told, rather than the receipt going quiet')
  assert.equal(refusals[0].metadata.refusal, 'DOCUMENT_MOVED')
  assert.equal(refusals[0].metadata.postedInvoiceId, 'INV-1')
  // The message itself, which nothing had ever executed: it has to say what happened and what to do.
  assert.match(refusals[0].description, /re-posted while the payment was being queued/)
  assert.match(refusals[0].description, /Nothing was sent/)
  // o3d-0bfh r13 (Codex HIGH). It used to end "Re-run the invoice sync for this order, or register
  // the payment in the ledger by hand". Both halves are unsafe HERE and only here: the branch is
  // inside `if (pinned)`, so it is only ever the deferred re-drive that reaches it, the connector
  // retains the follow-up obligation on the `settled: false` this produces, and on Xero a bound
  // cron-invoked sweep re-reads that marker and re-drives this very function. The hand-made payment
  // would race it, and no request id can deduplicate one keyed into the Xero UI.
  assert.doesNotMatch(refusals[0].description, /Re-run the invoice sync for this order/)
  assert.doesNotMatch(refusals[0].description, /register the payment in the ledger by hand/i)
  assert.match(refusals[0].description, /HAND SETTLEMENT IS REFUSED HERE/)
  assert.match(
    refusals[0].description, /a later sweep re-reads the marker and re-enqueues them idempotently/,
    "the recovery half is the REGISTRY's declared fact for the pinned connector, not prose written here",
  )
  assert.match(refusals[0].description, /ESCALATE/)
})

test('[o3d-ekn8 r3] the same order registers normally when nothing moves under the lock', async () => {
  // The control for the test above: without it, "nothing was queued" is also what a broken harness
  // produces, and the refusal would be passing for a reason that has nothing to do with the re-read.
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-1')

  assert.equal(state.queued.length, 1)
  assert.deepEqual(state.activity.filter((a) => a.action === 'invoice_payment_not_registered'), [])
})

// ---------------------------------------------------------------------------
// o3d-ekn8 r4 (Codex MEDIUM) — THE ROLLBACK THAT ROLLS NOTHING BACK.
//
// The pinned registration throws out of its transaction when the enqueue reports a row written for a
// connector other than the pinned one, so the write is UNDONE and the operator is told nothing was
// sent. But `queueAccountingSync` reports `queued: true` WITHOUT WRITING when its idempotency
// short-circuit finds a live row under the same key. Throwing there rolls back an empty transaction:
// the pre-existing PENDING row is untouched and WILL post, and "Nothing was sent" is the one message
// that guarantees nobody goes looking for it.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r4] a row this call WROTE for the wrong connector is rolled back, and says so', async () => {
  state.payments = [...ONE_RECEIPT]
  state.enqueueConnector = 'quickbooks'

  await redrive('INV-1')

  const refusals = state.activity.filter((a) => a.metadata.refusal === 'PINNED_CONNECTOR_MOVED')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].metadata.rolledBack, true)
  assert.equal(refusals[0].metadata.wroteFor, 'quickbooks')
  assert.match(refusals[0].description, /Nothing was sent/)
})

test('[o3d-ekn8 r4] but a row that was ALREADY QUEUED elsewhere is not rolled back, and is not reported as unsent', async () => {
  // The short-circuit's real shape: a concurrent registration for the SAME receipt commits while this
  // one is queued behind the order lock, so the selection saw nothing and the enqueue finds a live row
  // under the same key. The row is this receipt's own, so the re-decision under the lock excludes it
  // from the capacity sum (`live` drops our own row) and registers — and the fence then fires on a
  // call that wrote nothing.
  state.payments = [...ONE_RECEIPT]
  state.enqueueConnector = 'quickbooks'
  onOrderLock = () => {
    state.syncRows = [{
      id: 'log-live',
      status: 'PENDING',
      externalTransactionId: null,
      errorMessage: null,
      retryCount: 0,
      payload: {
        amount: 100,
        accountingInvoiceId: 'INV-1',
        paymentId: 'pay-1',
        _idempotencyKey: 'invoice-payment:payment:pay-1:invoice:INV-1',
      },
    }]
  }

  await redrive('INV-1')

  assert.equal(state.queued.length, 0, 'the enqueue short-circuited, so nothing was written to roll back')
  assert.equal(state.syncRows.length, 1, 'and the row that was already there is untouched — it will post')
  const refusals = state.activity.filter((a) => a.metadata.refusal === 'PINNED_CONNECTOR_MOVED')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].metadata.rolledBack, false, 'there was no write to undo')
  assert.ok(
    !/Nothing was sent/.test(refusals[0].description),
    'telling an operator nothing was sent, while a live row is still going to post, is the defect',
  )
  assert.match(refusals[0].description, /ALREADY QUEUED/)
  assert.match(refusals[0].description, /STILL LIVE AND WILL POST/)
  assert.match(refusals[0].description, /cancel it/i, 'and the message names what to do about it')
})

// ---------------------------------------------------------------------------
// o3d-0bfh r15 (Codex HIGH) — A RECEIPT THAT COMMITS AFTER THE PASS'S SNAPSHOT.
//
// r14 made the receipt path read the durable obligation marker and answer `held` — which REFUSES a
// hand settlement — whenever a deferred pass is in flight for the order. The marker is live for that
// whole window, and that much was right. What it does not establish is what the notice promises:
// THE MARKER SAYS A PASS IS IN FLIGHT, NOT THAT THE PASS SAW THIS RECEIPT. The pass's view of which
// receipts exist was fixed at its own `order.payments` snapshot, and its final verification re-used
// that same snapshot — so a receipt committing while the pass was making its remote calls was
// invisible to it, read `held`, was told not to settle by hand, and then had the marker cleared over
// it. No sync row, no retained marker, no future sweep: a recorded customer payment permanently
// absent from the ledger.
//
// The release is therefore taken UNDER THE SAME SALES-ORDER LOCK `addPayment` takes, over a re-read
// of the receipts that exist NOW, in one transaction. `onOrderLock` is what lands the receipt in the
// only window that matters: the instant the fence acquires that lock.
// ---------------------------------------------------------------------------

test('[o3d-0bfh r15] a receipt committed AFTER the pass\'s snapshot keeps the marker, and is not settled over', async () => {
  // The pass's own snapshot: one receipt, already registered against this document, so the
  // registration loop does nothing and the fence is the first thing to take the order lock.
  state.payments = [...ONE_RECEIPT]
  state.syncRows = [{
    id: 'log-existing',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' },
  }]
  // `addPayment` commits a SECOND receipt the moment the fence takes the lock — after the pass read
  // the order, and with no sync row of its own.
  onOrderLock = () => {
    state.payments = [...state.payments, {
      id: 'pay-late', amount: 25, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02T00:00:00.000Z'),
    }]
  }

  const result = await redrive('INV-1')

  assert.equal(result.settled, false, 'the pass must not report itself finished over a receipt it never considered')
  assert.equal(result.reason, 'left-unregistered')
  assert.equal(result.awaiting, 1, 'and it names the receipt that arrived, not the one it snapshotted')
  assert.equal(result.release, 'retained')
  assert.deepEqual(
    state.markerClears, [],
    'THE LOAD-BEARING ASSERTION: no write cleared the obligation marker. The late receipt read it as '
    + 'held and was told its recovery is retained; clearing it here is what made that a lie.',
  )
})

test('[o3d-0bfh r15] with nothing arriving, the fence clears THE GENERATION IT WAS HANDED and nothing else', async () => {
  // The control. Without it, "the marker was not cleared" above is also what a fence that never
  // clears anything produces, and the regression would pass for the wrong reason.
  state.payments = [...ONE_RECEIPT]
  state.syncRows = [{
    id: 'log-existing',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' },
  }]

  const result = await redrive('INV-1')

  assert.equal(result.settled, true)
  assert.equal(result.release, 'released')
  assert.equal(state.markerClears.length, 1, 'exactly one clearing write')
  assert.deepEqual(state.markerClears[0].where, { id: 'sync-1', backReferenceFollowUpsPendingAt: OBLIGATION },
    'fenced on the generation THIS pass was handed — a generation re-read here would be somebody else\'s')
  assert.deepEqual(state.markerClears[0].data, { backReferenceFollowUpsPendingAt: null })
})

test('[o3d-0bfh r15] an order whose receipts were all EMPTY at the snapshot is fenced too', async () => {
  // `no-receipts` returned `settled: true` unfenced, and it is the same snapshot claim: a receipt
  // committing between that read and the caller's release reads a live marker and is settled over.
  state.payments = []
  onOrderLock = () => {
    state.payments = [{
      id: 'pay-late', amount: 40, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02T00:00:00.000Z'),
    }]
  }

  const result = await redrive('INV-1')

  assert.equal(result.settled, false, 'an order that had no receipts a moment ago can have one now')
  assert.equal(result.reason, 'left-unregistered')
  assert.deepEqual(state.markerClears, [], 'and the marker the late receipt read stays exactly where it is')
})

test('[o3d-0bfh r15] a caller holding no generation clears nothing, and says so', async () => {
  // `null` is a statement, not a default: the pass took no generation, so it has no standing to
  // clear one. The old code path reached `releaseFollowUpObligation` and short-circuited there; the
  // fence must not have quietly acquired an ability to clear a marker it does not own.
  state.payments = [...ONE_RECEIPT]
  state.syncRows = [{
    id: 'log-existing',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' },
  }]

  const result = await redrive('INV-1', null)

  assert.equal(result.settled, true)
  assert.equal(result.release, 'superseded', 'a pass that owns no generation is not the one to clear the marker')
  assert.deepEqual(state.markerClears, [])
})

test('[o3d-0bfh r15] a fence that cannot be taken retains the marker rather than reporting success', async () => {
  // The transaction can fail — lock timeout, a dead connection — and the direction that failure
  // resolves in is the whole asymmetry the obligation marker was designed around.
  state.payments = [...ONE_RECEIPT]
  state.syncRows = [{
    id: 'log-existing',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' },
  }]
  onOrderLock = () => { throw new Error('could not lock sales order') }

  const result = await redrive('INV-1')

  assert.equal(result.settled, false)
  assert.equal(result.reason, 'failed')
  assert.equal(result.release, 'retained')
  assert.deepEqual(state.markerClears, [])
})

// ---------------------------------------------------------------------------
// o3d-0bfh r16 (Codex HIGH) — THE RELEASE MUST NOT OUTRUN THE CALLER'S OWN EVIDENCE.
//
// r15 put the clear inside the fence, which is right. What it also did was make the clear the FIRST
// of the caller's settlement writes: the back-reference sweep hands its generation down here and
// only afterwards persists the terminal warning that says WHY a tombstone's follow-ups will never
// run. A warning that then failed to persist left the row discharged with nothing recording the loss.
//
// So a caller may state a prerequisite, and it is answered BETWEEN a fenced re-read that found
// nothing awaiting and the fenced release. The fence is not weakened: the release still only ever
// happens in the same transaction as a re-read that found nothing awaiting — which is what the
// third test here drives, by landing a receipt in the window the split creates.
// ---------------------------------------------------------------------------

const ONE_SETTLED_RECEIPT = () => {
  state.payments = [...ONE_RECEIPT]
  state.syncRows = [{
    id: 'log-existing',
    status: 'SYNCED',
    externalTransactionId: null,
    errorMessage: null,
    retryCount: 0,
    payload: { amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' },
  }]
}

test('[o3d-0bfh r16] a prerequisite that cannot be met clears NOTHING, and says which of the two failed', async () => {
  // The regression. Nothing is awaiting registration — the receipt half is finished — and the marker
  // must still survive, because the caller has just said its own record of the settlement is not
  // durable.
  //
  // MUTATION THAT KILLS THIS: drop the prerequisite branch from
  // `dischargeDeferredReceiptObligation` (call `fencedReceiptPass(orderId, posted, obligation)`
  // unconditionally). The marker is then cleared over a warning that was never written.
  ONE_SETTLED_RECEIPT()

  const result = await redrive('INV-1', OBLIGATION, async () => false)

  assert.deepEqual(
    state.markerClears, [],
    'THE LOAD-BEARING ASSERTION: no write cleared the obligation. The caller is the party that just '
    + 'said its terminal notice is not on record, and the marker is what brings the row back for it.',
  )
  assert.equal(result.release, 'prerequisite-unmet',
    'and it is named, not folded into `retained`: the receipts DID settle, and the caller has to be able '
    + 'to tell "a receipt is still owed" from "my own notice did not land"')
  assert.equal(result.settled, true, 'the receipt half is genuinely finished, and saying otherwise would be a second untruth')
})

test('[o3d-0bfh r16] a prerequisite that IS met is answered BEFORE the clear, and the clear still happens once', async () => {
  // The control. Without it, "nothing was cleared" above is also what a fence that never clears
  // anything produces.
  ONE_SETTLED_RECEIPT()
  let clearsWhenAsked = -1

  const result = await redrive('INV-1', OBLIGATION, async () => {
    clearsWhenAsked = state.markerClears.length
    return true
  })

  assert.equal(clearsWhenAsked, 0,
    'the caller is asked while the marker is still there — being asked after the clear is the whole finding')
  assert.equal(result.release, 'released')
  assert.equal(result.settled, true)
  assert.equal(state.markerClears.length, 1, 'exactly one clearing write, after the answer')
  assert.deepEqual(state.markerClears[0].where, { id: 'sync-1', backReferenceFollowUpsPendingAt: OBLIGATION },
    'still fenced on the generation THIS pass was handed')
})

test('[o3d-0bfh r16] a receipt landing in the window the split creates is STILL seen, and keeps the marker', async () => {
  // THE FENCE IS NOT WEAKENED BY THE SPLIT. Splitting the pass in two opens a window between the
  // re-read and the release — so the release re-reads AGAIN, under the lock, and a receipt that
  // commits while the caller is writing its warning is seen by that second pass exactly as r15
  // requires.
  //
  // MUTATION THAT KILLS THIS: have the second phase release without re-reading (e.g. call
  // `releaseFollowUpObligation` directly once the prerequisite answers true). The late receipt is
  // then settled over — the r15 defect, reopened one step further along.
  ONE_SETTLED_RECEIPT()

  const result = await redrive('INV-1', OBLIGATION, async () => {
    // `addPayment` commits while the caller is persisting its notice: the receipt lands on the NEXT
    // lock acquisition, which is the release's own.
    onOrderLock = () => {
      state.payments = [...state.payments, {
        id: 'pay-late', amount: 25, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02T00:00:00.000Z'),
      }]
    }
    return true
  })

  assert.deepEqual(state.markerClears, [], 'the late receipt keeps the marker it read as held')
  assert.equal(result.settled, false)
  assert.equal(result.reason, 'left-unregistered')
  assert.equal(result.awaiting, 1)
  assert.equal(result.release, 'retained')
})

test('[o3d-0bfh r16] a receipt already awaiting is answered BEFORE the caller is ever asked', async () => {
  // The ordering that keeps the sweep's existing rule intact: a terminal loss is never announced on
  // a pass that also failed to register a receipt, because announcing it is what permits the
  // settlement. The first fenced pass answers that without consulting the caller at all.
  //
  // MUTATION THAT KILLS THIS: ask the prerequisite before the `awaiting > 0` check.
  ONE_SETTLED_RECEIPT()
  // A receipt commits the instant the FIRST fenced pass takes the lock — the r15 window — so that
  // pass finds one awaiting and must answer on it alone.
  onOrderLock = () => {
    state.payments = [...state.payments, {
      id: 'pay-late', amount: 25, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02T00:00:00.000Z'),
    }]
  }
  let asked = false

  const result = await redrive('INV-1', OBLIGATION, async () => { asked = true; return true })

  assert.equal(asked, false, 'the caller is not asked to announce anything while a receipt is still owed')
  assert.deepEqual(state.markerClears, [])
  assert.equal(result.settled, false)
  assert.equal(result.awaiting, 1)
  assert.equal(result.release, 'retained')
})

// ---------------------------------------------------------------------------
// o3d-batch-ret (Codex HIGH) — THE ENQUEUE'S OWN REFUSAL IS THE THIRD THING THE RELEASE IS OWED.
//
// r16 gave the fence a caller-side prerequisite and both connectors declined to state one on their
// post path, because "this processor has no settlement write of its own after the enqueue". True of
// its WRITES, false of its VERDICT: the payment and PDF enqueues run immediately above the fence and
// either of them can REFUSE — return normally, having queued nothing. Those two outcomes were folded
// into a `FollowUpEnqueueOutcome` in the `return` statement four lines BELOW the fence, and every
// consumer of that outcome — `requireFollowUpsEnqueued` on the post path, `followUpSettlement` in the
// sweep — therefore read a correct answer about a marker that was already gone. The row is left
// SYNCED, linked and marker-null, which the next sweep reads as reconciled and stamps; the refused
// payment is never re-enqueued, and the refusal notice promises the exact opposite ("the row is
// deliberately left marked as owing follow-ups").
//
// A CORRECT CHECK PLACED AFTER THE IRREVERSIBLE STEP IS NOT A CHECK. So the verdict is computed
// before the fence and composed into the prerequisite by `obligationReleasePrerequisite`, and these
// drive the real helper into the real fence.
// ---------------------------------------------------------------------------

const REFUSED_PAYMENT_ENQUEUE = () => refusedFollowUpEnqueue({
  type: 'INVOICE_PAYMENT',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  reason: 'ledger_not_clear',
  message: 'The ledger would not confirm this payment attempt is absent, so it was not re-posted.',
})

test('[o3d-batch-ret] a REFUSED enqueue keeps the marker even though every receipt IS settled', async () => {
  // THE LOAD-BEARING CASE, and every one of its three axes is deliberate: the receipts are settled
  // (so the fence's own re-read finds nothing and would release), the caller states no prerequisite
  // of its own (the post path's shape, which is what made `undefined` look safe), and the enqueue
  // REFUSED. Before the fix those three met at a `released`.
  //
  // MUTATION THAT KILLS THIS: make `obligationReleasePrerequisite` return `callerPrerequisite`
  // unconditionally — i.e. ignore the refusal, which is the shipped behaviour this replaced. The
  // release becomes `released`, `state.markerClears` gains its one write, and the assertion below
  // that the SECOND pass can still clear the generation becomes vacuous because the first already
  // did. ROUTE: `registerDeferredOrderReceipts` → `dischargeDeferredReceiptObligation`, whose
  // prerequisite branch is only entered because the helper produced a closure.
  ONE_SETTLED_RECEIPT()
  const refusalPrerequisite = obligationReleasePrerequisite(REFUSED_PAYMENT_ENQUEUE())
  assert.ok(
    refusalPrerequisite,
    'a refusal must STATE a prerequisite. `undefined` here is the single-pass fence, which clears the '
    + 'marker unconditionally — so this precondition is the one the whole finding turns on',
  )

  const result = await redrive('INV-1', OBLIGATION, refusalPrerequisite)

  assert.deepEqual(
    state.markerClears, [],
    'THE LOAD-BEARING ASSERTION: nothing cleared the obligation. The payment was REFUSED and nothing '
    + 'was queued, so the marker is the only record left that the work is owed',
  )
  assert.equal(result.release, 'prerequisite-unmet',
    'named rather than folded into `retained`: the receipts settled, and what failed is the caller\'s own half')
  assert.equal(result.settled, true,
    'and the receipt half is genuinely finished — this is exactly the state in which the old ordering released')

  // AND IT IS DEFERRED, NOT RETIRED. The generation is still on the row, so the next sweep's pass —
  // once the refusal has cleared — finds it and clears THAT generation. If the first pass had
  // released it, this second one would answer `superseded` and write nothing.
  const later = await redrive('INV-1', OBLIGATION, obligationReleasePrerequisite(FOLLOW_UPS_ENQUEUED))
  assert.equal(later.release, 'released', 'the later sweep completes the work the refusal deferred')
  assert.equal(state.markerClears.length, 1, 'and only NOW is there a clearing write')
  assert.deepEqual(state.markerClears[0].where, { id: 'sync-1', backReferenceFollowUpsPendingAt: OBLIGATION },
    'fenced on the same generation the refused pass left standing — which is what proves it survived')
})

test('[o3d-batch-ret] an ENQUEUED outcome states no prerequisite of its own, so the post path keeps its single pass', async () => {
  // The control, and it is about COST as much as correctness: the composition must not turn every
  // healthy post into the two-pass split, and "nothing was cleared" above must not be reachable by a
  // helper that simply always refuses.
  ONE_SETTLED_RECEIPT()
  assert.equal(
    obligationReleasePrerequisite(FOLLOW_UPS_ENQUEUED), undefined,
    'no refusal and no caller condition is the one shape that goes back to the single-pass fence',
  )

  const result = await redrive('INV-1', OBLIGATION, obligationReleasePrerequisite(FOLLOW_UPS_ENQUEUED))

  assert.equal(result.release, 'released')
  assert.equal(state.markerClears.length, 1, 'the healthy path still clears, exactly once')
})

test('[o3d-batch-ret] a refusal overrides the caller\'s own prerequisite without ever spending it', async () => {
  // The sweep DOES state a prerequisite, and its closure ANNOUNCES a terminal loss. Announcing one
  // on a pass that queued nothing is the same mistake the fence avoids when its re-read answers
  // `retained`: the announcement is what licenses the settlement, so it must not be spent by a pass
  // that is not going to settle.
  //
  // MUTATION THAT KILLS THIS: compose as `enqueued && await callerPrerequisite()` in the other order
  // (`await callerPrerequisite() && enqueued`). `announced` flips to true, the terminal notice is
  // written for a row that stays marked, and the next sweep re-announces it.
  ONE_SETTLED_RECEIPT()
  let announced = false
  const prerequisite = obligationReleasePrerequisite(
    REFUSED_PAYMENT_ENQUEUE(),
    async () => { announced = true; return true },
  )

  const result = await redrive('INV-1', OBLIGATION, prerequisite)

  assert.equal(announced, false, 'the caller\'s terminal notice is not spent on a pass that queued nothing')
  assert.equal(result.release, 'prerequisite-unmet')
  assert.deepEqual(state.markerClears, [])
})

test('[o3d-batch-ret] an enqueued outcome hands the caller\'s own prerequisite straight through', async () => {
  // The other control: the composition must not swallow the condition r16 added. Without this, a
  // helper that returned `undefined` whenever the enqueue succeeded would pass every test above and
  // silently undo r16 for the sweep.
  ONE_SETTLED_RECEIPT()
  let asked = false
  const prerequisite = obligationReleasePrerequisite(FOLLOW_UPS_ENQUEUED, async () => { asked = true; return false })

  const result = await redrive('INV-1', OBLIGATION, prerequisite)

  assert.equal(asked, true, 'the caller\'s condition still runs')
  assert.equal(result.release, 'prerequisite-unmet', 'and it still withholds the release')
  assert.deepEqual(state.markerClears, [])
})
