import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

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
    accountingSyncLog: { findMany: async () => state.syncRows },
    payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
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

async function redrive(postedInvoiceId = 'INV-1') {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: postedInvoiceId })
}

test.beforeEach(() => {
  state.syncRows = []
  state.queued = []
  state.activity = []
  state.payments = []
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

test('nothing is re-driven while the invoice has not posted', async () => {
  state.order.accountingInvoiceId = null
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
  // The re-drive exists precisely BECAUSE DOCUMENT_NOT_POSTED already warned once at the moment the
  // receipt was recorded; returning early is what stops it warning again on every invoice sync. A bare
  // "nothing queued" assertion would also be satisfied by falling through to a NO_BANK_ACCOUNT refusal.
  assert.deepEqual(state.activity, [])
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
  assert.match(refusals[0].description, /Re-run the invoice sync for this order/)
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
