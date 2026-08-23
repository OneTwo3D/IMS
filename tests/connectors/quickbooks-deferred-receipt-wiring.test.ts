import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

// ---------------------------------------------------------------------------
// o3d-ekn8, THE QUICKBOOKS HALF — A RECEIPT RECORDED BEFORE ITS INVOICE POSTS MUST BE REGISTERED
// WHEN THE INVOICE LANDS.
//
// `registerInvoicePaymentWithLedger` refuses a receipt with DOCUMENT_NOT_POSTED while the order has no
// accountingInvoiceId, and nothing re-visited it afterwards: the receipt stayed recorded, the ledger
// stayed unsettled, and the only sign was a red NOT_SENT verdict somebody had to notice.
//
// The re-drive that closes it (`registerDeferredOrderReceipts`) shipped on the XERO connector only.
// The receipt-registration path it re-drives is connector-agnostic — this processor posts
// INVOICE_PAYMENT rows itself — so on QuickBooks the lost registration was still whole.
//
// THIS TEST MODELS THE LOSS, NOT THE CALL. It drives the real `processPendingQuickBooksSync` over a
// PENDING SALES_INVOICE for an order that already carries a receipt, and asserts the RECEIPT ENDS UP
// QUEUED to the ledger. The real `registerDeferredOrderReceipts` runs — nothing about it is stubbed —
// so the assertion is about money reaching the ledger, not about a function having been reached.
// ---------------------------------------------------------------------------

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description?: string }> = []
/** Everything the receipt-registration path queued, in order. */
const queued: Array<{ type: string; payload: Record<string, unknown>; idempotencyKey?: string }> = []

/**
 * o3d-ekn8 r2 — THE THREE FACTS THE RE-DRIVE USED TO RE-DERIVE, now controlled independently so a
 * divergence between "what posted" and "what is live now" is expressible at all.
 *
 * `activeConnector` is what `getActiveAccountingConnectorInfo` / the active-connector enable check
 * answer; `enqueueConnector` is the connector the enqueue actually WRITES the row under; `reinvoiceTo`
 * makes the back-reference land a DIFFERENT document than the post returned. With the old signature
 * all three were the same value by construction, which is exactly why the defect was invisible.
 */
const live = {
  activeConnector: 'quickbooks' as 'xero' | 'quickbooks',
  /** Whether the ACTIVE-connector enable form says payments post. */
  activeTypeEnabled: true,
  /** Whether the named connector posts payments — the explicit-connector form. */
  typeEnabledFor: (connector: string) => connector === 'quickbooks',
  enqueueConnector: 'quickbooks' as 'xero' | 'quickbooks',
  reinvoiceTo: null as string | null,
}

/** Every connector the INVOICE_PAYMENT sync-row read was scoped to, in order. */
const paymentRowScopes: Array<string | null> = []

/** The order under test: GBP 100, and its invoice has just posted as QBINV-9. */
const order = {
  id: 'order-1',
  orderNumber: 'SO-1',
  externalOrderNumber: null as string | null,
  accountingInvoiceId: null as string | null,
  currency: 'GBP',
  totalForeign: 100,
  taxForeign: 0,
  pricesIncludeVat: false,
  shoppingLinks: [] as Array<{ connector: string }>,
}

/** The receipt an operator recorded while the invoice did not yet exist. */
const receipts = [
  { id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null as string | null, paidAt: new Date('2026-08-01T00:00:00.000Z') },
]

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => {
    // Record WHICH connector's rows the registration path asked for. Scoping this to the active
    // connector rather than the one that posted is how a receipt already registered on QuickBooks
    // becomes invisible and gets paid a second time.
    const where = (args as { where?: { type?: string; connector?: string } } | undefined)?.where
    if (prop === 'findMany' && where?.type === 'INVOICE_PAYMENT') paymentRowScopes.push(where.connector ?? null)
    return (store.delegate[prop] as (a: never) => Promise<unknown>)(args)
  },
})

const dbStub = {
  accountingSyncLog,
  salesOrder: {
    findUnique: async () => ({ ...order, payments: receipts }),
  },
  payment: {
    findUnique: async ({ where }: { where: { id: string } }) => receipts.find((r) => r.id === where.id) ?? null,
  },
  // The advisory locks the enqueue takes. No-ops here, but they must ANSWER or the registration dies
  // before queueing anything and the assertion below would read zero for the wrong reason.
  $executeRaw: async () => 1,
  $queryRaw: async () => [],
  // Models ROLLBACK, which o3d-ekn8 r2 relies on: the pinned-connector fence throws out of the
  // transaction so a row written for the wrong ledger is UNWRITTEN, not merely reported. A fake that
  // kept the push would pass with the fence removed.
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const mark = queued.length
    try {
      return await fn(dbStub)
    } catch (error) {
      queued.length = mark
      throw error
    }
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description?: string }) => { activity.push(entry) },
    logActivityPersisted: async (entry: { action: string; level?: string; description?: string }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description?: string }) => {
      activity.push(entry)
    },
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => live.activeTypeEnabled,
    // o3d-ekn8 r2: the explicit-connector form, which is what a pinned hand-off must ask.
    isAccountingSyncTypeEnabledFor: async (connector: string) => live.typeEnabledFor(connector),
    getActiveAccountingConnectorInfo: async () => ({ id: live.activeConnector }),
    getPaymentAccountMap: async () => ({ default: 'QBO-BANK-1' }),
    lookupPaymentAccount: () => 'QBO-BANK-1',
    queueAccountingSyncTxWithOutcome: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      // The enqueue resolves the active connector for ITSELF, so it — not the caller — is the only
      // thing that can say which ledger the row landed in (o3d-2sm1 r8).
      return { queued: true, connector: live.enqueueConnector }
    },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/domain/accounting/back-reference', {
  namedExports: {
    // The write that puts accountingInvoiceId on the order. Modelled rather than stubbed away: the
    // re-drive re-READS the order, and it is this write landing BEFORE the follow-ups that makes the
    // DOCUMENT_NOT_POSTED refusal stop applying. Setting it here reproduces that ordering exactly.
    applyBackReference: async (_db: unknown, params: { externalId: string }) => {
      // `reinvoiceTo` models a delete-and-re-post whose back-reference landed FIRST: the order ends up
      // pointing at a document this post did not create, while `syncResult.externalId` is still the id
      // this post returned. That divergence is the whole of o3d-ekn8 r2.
      order.accountingInvoiceId = live.reinvoiceTo ?? params.externalId
      return { outcome: 'applied' as const, attribution: { reason: '' } }
    },
    backReferenceHolder: () => ({}),
    findExternalDocumentIdClaim: async () => null,
    followUpObligationClaim: () => ({}),
    isExternalDocumentIdConflict: () => false,
    releaseFollowUpObligation: async () => {},
  },
})
mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    ledgerClearsFollowUpRevival: async () => ({ clear: true }),
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
  },
})
mock.module('@/lib/connectors/quickbooks/invoices', {
  namedExports: {
    pushSalesInvoice: async () => ({ success: true, invoiceId: 'QBINV-9', invoiceNumber: 'INV-9' }),
  },
})
mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboPost: async () => ({ ok: true, data: {} }),
    qboPostIdempotent: async () => ({ ok: true, data: {} }),
    qboUploadAttachment: async () => ({ ok: true }),
    resolveAccountRef: async () => ({ value: 'qbo-bank-1' }),
  },
})

/** A PENDING SALES_INVOICE for order-1, ready for the processor to post. */
function pendingSalesInvoice() {
  return syncLogRow({
    id: 'entry-invoice',
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { currency: 'GBP', lines: [{ quantity: 1, unitAmount: 100 }] },
    attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
  })
}

test.beforeEach(() => {
  store = createSyncLogStore([pendingSalesInvoice()])
  activity.length = 0
  queued.length = 0
  paymentRowScopes.length = 0
  live.activeConnector = 'quickbooks'
  live.activeTypeEnabled = true
  live.typeEnabledFor = (connector: string) => connector === 'quickbooks'
  live.enqueueConnector = 'quickbooks'
  live.reinvoiceTo = null
  order.totalForeign = 100
  // The state the defect lives in: the receipt exists, the invoice does NOT yet.
  order.accountingInvoiceId = null
})

async function runQuickBooks() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).processPendingQuickBooksSync()
}

test('[o3d-ekn8] a receipt recorded before the QuickBooks invoice posted IS registered once it lands', async () => {
  // THE LOST REGISTRATION. Before this cross-port the SALES_INVOICE posted, the order went green, and
  // this receipt was never sent to QuickBooks by anything, ever.
  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'precondition: the invoice really did post')
  const payments = queued.filter((row) => row.type === 'INVOICE_PAYMENT')
  assert.equal(payments.length, 1, 'the receipt recorded before the invoice must be registered when it lands')
  assert.equal(payments[0].payload.accountingInvoiceId, 'QBINV-9', 'and against the invoice that just posted')
  assert.equal(payments[0].payload.amount, 100)
  assert.equal(
    payments[0].idempotencyKey,
    'invoice-payment:payment:pay-1',
    'keyed to the RECEIPT, so a re-drive of the same receipt is a no-op rather than a second payment',
  )
})

test('[o3d-ekn8] the re-drive runs the real guard — a receipt that cannot fit the invoice is NOT registered', async () => {
  // The re-drive must not be a laxer second path. The same capacity arithmetic that guards a
  // hand-recorded receipt guards this one: an order whose ledger total is 40 has no room for a 100
  // receipt, and the re-drive has to refuse it rather than post an over-settlement.
  order.totalForeign = 40

  await runQuickBooks()

  // The precondition is asserted HERE TOO, and it is not ceremony: without it "nothing was queued"
  // is also what a run that never posted the invoice at all produces, and this test would pass for
  // the wrong reason on any harness breakage.
  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'precondition: the invoice really did post')
  assert.deepEqual(
    queued.filter((row) => row.type === 'INVOICE_PAYMENT'),
    [],
    'over-settlement is refused on the re-drive exactly as it is on the manual path',
  )
  order.totalForeign = 100
})

// ---------------------------------------------------------------------------
// o3d-ekn8 ROUND 2 (Codex HIGH) — THE RE-DRIVE IS PINNED TO THE POST THAT TRIGGERED IT.
//
// The hand-off passed ONLY the order id while the caller was holding the two authoritative facts: the
// connector whose processor made the call, and the ledger id that call returned. The callee then went
// and asked the world again — "which connector is active NOW", "which document does this order point at
// NOW" — so anything moving between the post and the re-drive silently redirected it. Re-resolving
// after a pin is the race being closed, not a check of it.
//
// Each test below drives the REAL processor and asserts about money, and each is stated so that it
// cannot pass while the corresponding re-derivation is back in place.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r2] the PINNED connector decides whether payments post, not whichever is active now', async () => {
  // The connector flipped to Xero after the QuickBooks invoice posted, and Xero does not post payments.
  // The active-connector enable form therefore answers "no" — but it is answering about a ledger this
  // post was never made against. The receipt is owed to QuickBooks and must still be registered.
  live.activeConnector = 'xero'
  live.activeTypeEnabled = false
  live.typeEnabledFor = (connector: string) => connector === 'quickbooks'

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'precondition: the invoice really did post')
  const payments = queued.filter((row) => row.type === 'INVOICE_PAYMENT')
  assert.equal(payments.length, 1, 'the pinned connector posts payments, so the receipt is registered')
  assert.equal(payments[0].payload.accountingInvoiceId, 'QBINV-9')
})

test('[o3d-ekn8 r2] the sync rows are read for the connector that POSTED, so a receipt is not paid twice', async () => {
  // pay-1 has ALREADY been registered on QuickBooks. Read under the pin, that row is visible and the
  // receipt is spoken for. Read under whatever is active now — Xero — it is invisible, the receipt looks
  // unregistered, and the re-drive queues a SECOND payment for it.
  live.activeConnector = 'xero'
  store = createSyncLogStore([
    pendingSalesInvoice(),
    syncLogRow({
      id: 'entry-existing-payment',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'SYNCED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: { accountingInvoiceId: 'QBINV-9', amount: 100, paymentId: 'pay-1' },
    }),
  ])

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'precondition: the invoice really did post')
  assert.deepEqual(
    paymentRowScopes,
    ['quickbooks'],
    'the capacity read names the connector the post was made against',
  )
  assert.deepEqual(
    queued.filter((row) => row.type === 'INVOICE_PAYMENT'),
    [],
    'a receipt already registered on the posting connector is not registered a second time',
  )
})

test('[o3d-ekn8 r2] a re-post between the invoice landing and the re-drive refuses instead of settling the wrong document', async () => {
  // This post returned QBINV-9, but by the time the re-drive reads the order it points at QBINV-10 —
  // a document this post did not create and has no evidence about. Settling against it is a payment
  // registered on the strength of somebody else's post.
  live.reinvoiceTo = 'QBINV-10'

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-10', 'precondition: the order moved to another document')
  assert.deepEqual(
    queued.filter((row) => row.type === 'INVOICE_PAYMENT'),
    [],
    'nothing is registered against a document this post did not return',
  )
  const skipped = activity.filter((entry) => entry.action === 'deferred_invoice_payment_registration_skipped')
  assert.equal(skipped.length, 1, 'and the refusal is reported rather than silent')
  assert.match(String(skipped[0].description), /QBINV-9/, 'the message names the invoice that actually posted')
  assert.match(String(skipped[0].description), /QBINV-10/, 'and the one the order moved to')
})

test('[o3d-ekn8 r2] a row the enqueue wrote for another connector is ROLLED BACK, not reported as queued', async () => {
  // The capacity arithmetic was measured against QuickBooks rows; the enqueue resolved the active
  // connector for itself and wrote the row for Xero. A row measured against nothing must not survive.
  live.enqueueConnector = 'xero'

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'precondition: the invoice really did post')
  assert.deepEqual(
    queued.filter((row) => row.type === 'INVOICE_PAYMENT'),
    [],
    'the registration is unwritten, not merely flagged',
  )
  const refusals = activity.filter((entry) => entry.action === 'invoice_payment_not_registered')
  assert.equal(refusals.length, 1, 'and the operator is told, with a remedy')
  assert.match(String(refusals[0].description), /register the payment in the accounting connector by hand/i)
})
