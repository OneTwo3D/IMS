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
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
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
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
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
    isAccountingSyncTypeEnabled: async () => true,
    // QuickBooks, so the connector-agnostic registration path is scoped to THIS connector's rows.
    getActiveAccountingConnectorInfo: async () => ({ id: 'quickbooks' }),
    getPaymentAccountMap: async () => ({ default: 'QBO-BANK-1' }),
    lookupPaymentAccount: () => 'QBO-BANK-1',
    queueAccountingSyncTx: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      return true
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
      order.accountingInvoiceId = params.externalId
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
