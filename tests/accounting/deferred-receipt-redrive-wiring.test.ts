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
        return { queued: true, connector: 'xero' }
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
      return { queued: true, connector: 'xero' }
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

test('[o3d-ekn8 r3] the SELECTOR no longer treats a retired document\'s row as speaking for the receipt', async () => {
  // Isolated to the first gate: the old row carries an ANCHORED key for INV-1, so the enqueue's
  // idempotency short-circuit cannot fire whatever the key is, and only the selection rule decides.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [rowForRetiredInvoice('invoice-payment:payment:pay-1:invoice:INV-1')]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 1, 'the replacement invoice is still owed this receipt')
  assert.equal(state.queued[0].payload.accountingInvoiceId, 'INV-2', 'and it is registered against the REPLACEMENT')
  assert.equal(state.queued[0].payload.paymentId, 'pay-1')
})

test('[o3d-ekn8 r3] the whole re-drive settles the REPLACEMENT invoice, legacy un-anchored key and all', async () => {
  // Both gates, in the shape production actually presents: the surviving row was written before the
  // key carried a document, so it holds `invoice-payment:payment:pay-1`. With the anchor missing from
  // the key the enqueue would find that row, report `queued` and write nothing — the second gate — so
  // relaxing the selector alone would have changed nothing an operator could see.
  state.order.accountingInvoiceId = 'INV-2'
  state.syncRows = [rowForRetiredInvoice('invoice-payment:payment:pay-1')]
  state.payments = [...ONE_RECEIPT]

  await redrive('INV-2')

  assert.equal(state.queued.length, 1, 'the replacement invoice is settled rather than left outstanding for ever')
  assert.equal(state.queued[0].payload.accountingInvoiceId, 'INV-2')
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
