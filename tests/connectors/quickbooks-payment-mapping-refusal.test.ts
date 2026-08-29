import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'
// The REAL recovery note. The refusal message under test is composed out of it, and on this
// connector it is the sentence that says NOTHING will come back for the row — a mock would replace
// the thing being asserted.
import { followUpObligationRecoveryNote } from '@/lib/domain/accounting/back-reference'

/**
 * o3d-batch-ret ROUND 6 (Codex HIGH), THE QUICKBOOKS HALF — AND IT IS THE WORSE HALF.
 *
 * `enqueueSalesInvoiceFollowUps` seeded `paymentOutcome` with `FOLLOW_UPS_ENQUEUED` and narrowed it
 * only where the enqueue was actually reached. A payload asking for a payment whose method has no
 * mapped bank account therefore queued NOTHING and reported `enqueued: true`, the receipt fence was
 * handed no prerequisite, and it released the obligation generation.
 *
 * ON XERO THAT COSTS A LAP OF THE SWEEP. HERE IT COSTS THE MONEY. This connector's registry entry
 * declares `consumer: 'none'`: nothing re-reads a retained marker, so the marker is not a deferral,
 * it is the only EVIDENCE the payment is owed — and the exception inbox is built on it. Clearing it
 * over a payment that was never queued ends the trail, and no later correction of the mapping can
 * find the row again.
 *
 * BEHAVIOURAL, FOR THE REASON CODEX GAVE IN ROUND 6. The structural ordering judge this replaces
 * could be satisfied by a shape whose RUNTIME called the fence first. Here the real
 * `processPendingQuickBooksSync` runs, the real `registerDeferredOrderReceipts` takes the fenced
 * pass, and the observable is whether `releaseFollowUpObligation` was reached with a generation it
 * could clear. A fence invoked before the verdict existed would carry a hoisted `undefined`
 * prerequisite and release — which is exactly what the retention assertions catch.
 */

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description?: string; metadata?: Record<string, unknown> }> = []
/** Every sync row whose follow-up obligation was actually DISCHARGED. */
const released: string[] = []
/** The generations the connector's claim minted, so the fenced release can be modelled honestly. */
const claimed: Array<{ syncLogId: string; generation: Date }> = []

/**
 * The payment account map the connector reads — MUTABLE, so "nothing configured", "configured but
 * not for this method" and "configured correctly" are three states of ONE fixture.
 */
let paymentMap: Record<string, string> | null = null

/**
 * The order under test: GBP 120, paid by card, and NO receipt of its own.
 *
 * No receipt is deliberate and load-bearing. The deferred-receipt re-drive then takes its
 * `no-receipts` path, where the ONLY thing that can hold the obligation open is the enqueue verdict
 * this test is about. With a receipt present, retention would be ambiguous between the two.
 */
const order = {
  id: 'order-1',
  orderNumber: 'SO-1',
  externalOrderNumber: null as string | null,
  accountingInvoiceId: null as string | null,
  currency: 'GBP',
  totalForeign: 120,
  taxForeign: 0,
  pricesIncludeVat: false,
  shoppingLinks: [] as Array<{ connector: string }>,
  customer: { accountingContactId: null, accountingContactProvenance: null },
}

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  salesOrder: { findUnique: async () => ({ ...order, payments: [] }) },
  payment: { findUnique: async () => null, findMany: async () => [] },
  // The advisory locks the enqueue and the fence take. They must ANSWER, or the enqueue dies before
  // writing anything and every assertion below would read zero for the wrong reason.
  $executeRaw: async () => 1,
  $queryRaw: async () => [],
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const rowMark = store.rows.length
    try {
      return await fn(dbStub)
    } catch (error) {
      store.rows.length = rowMark
      throw error
    }
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityPersisted: async (entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'quickbooks' }),
    // THE VARIABLE UNDER TEST, asked as a real question of a real map.
    getPaymentAccountMap: async () => paymentMap,
    lookupPaymentAccount: (map: Record<string, string> | null, method: string) => map?.[method] ?? null,
    queueAccountingSyncTxWithOutcome: async () => ({ queued: true, connector: 'quickbooks' }),
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/domain/accounting/back-reference', {
  namedExports: {
    applyBackReference: async (_db: unknown, params: { externalId: string }) => {
      order.accountingInvoiceId = params.externalId
      return { outcome: 'applied' as const, attribution: { reason: '' } }
    },
    backReferenceHolder: () => ({}),
    findExternalDocumentIdClaim: async () => null,
    claimFollowUpObligation: async (_client: unknown, params: { syncLogId: string }) => {
      const generation = new Date(`2026-08-2${claimed.length + 1}T00:00:00.000Z`)
      claimed.push({ syncLogId: params.syncLogId, generation })
      return { claimed: true as const, generation }
    },
    isExternalDocumentIdConflict: () => false,
    // NOT faked: it is pure, and the refusal message under test is composed out of it.
    followUpObligationRecoveryNote,
    releaseFollowUpObligation: async (_client: unknown, params: { syncLogId: string; generation: Date | null }) => {
      // FENCED, so a release carrying no generation clears nothing — which is what keeps `released`
      // able to tell a discharge from a refusal.
      const mine = claimed.find((entry) => entry.syncLogId === params.syncLogId)
      if (params.generation === null || mine === undefined || mine.generation.getTime() !== params.generation.getTime()) {
        return 'superseded' as const
      }
      released.push(params.syncLogId)
      return 'released' as const
    },
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

/** A PENDING SALES_INVOICE whose payload ASKS for a card payment to be registered. */
function pendingSalesInvoice() {
  return syncLogRow({
    id: 'entry-invoice',
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: {
      currency: 'GBP',
      lines: [{ quantity: 1, unitAmount: 120 }],
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
    },
    attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
  })
}

function reset(map: Record<string, string> | null) {
  store = createSyncLogStore([pendingSalesInvoice()])
  activity.length = 0
  released.length = 0
  claimed.length = 0
  paymentMap = map
  order.accountingInvoiceId = null
}

async function runQuickBooks() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).processPendingQuickBooksSync()
}

/** The follow-up rows the post actually created. */
function followUpTypes(): string[] {
  return store.rows.filter((row) => row.id !== 'entry-invoice').map((row) => row.type).sort()
}

function paymentRefusals(): Array<{ description?: string; metadata?: Record<string, unknown> }> {
  return activity.filter((entry) => entry.action === 'quickbooks_payment_skipped')
}

test('[o3d-batch-ret r6] a requested payment with NO account mapping is refused, and the obligation is NOT discharged', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE whose payload asks
  // for a payment, with no payment account map configured. The real receipt fence runs; `released`
  // is populated only by a `releaseFollowUpObligation` call carrying the generation this pass claimed.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/quickbooks/sync-processor.ts, make
  // `decideInvoicePaymentFollowUp`'s configuration arms `return FOLLOW_UPS_ENQUEUED` instead of
  // `refuse(...)` — the shipped defect. The refusal assertions fail, and the marker is released
  // because the fence is handed no prerequisite.
  reset(null)

  await runQuickBooks()

  assert.equal(
    order.accountingInvoiceId, 'QBINV-9',
    'PRECONDITION: the invoice really did post — otherwise nothing below is about the follow-up enqueue',
  )
  assert.deepEqual(
    followUpTypes(), ['INVOICE_PDF'],
    'the PDF still goes out and the PAYMENT does not',
  )

  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1, 'the operator is told once, and told why')
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(String(refusal[0].description), /NOTHING WAS QUEUED/)
  assert.match(String(refusal[0].description), /Payment Account Mapping/, 'the remedy is a SETTING, safe to repeat')
  assert.match(
    String(refusal[0].description), /NOTHING re-enqueues them on this connector/,
    'and what follows is THIS connector\'s registry declaration, never Xero\'s "the next sweep picks it up"',
  )
  assert.match(String(refusal[0].description), /ESCALATE/, 'which on this connector means a human, not a sweep')

  assert.deepEqual(
    released, [],
    'THE FINDING: the row must go on saying it owes follow-ups. Nothing on this connector re-reads a '
      + 'cleared marker, so releasing it here loses the payment permanently',
  )
})

test('[o3d-batch-ret r6] a map that does not name THIS method is refused too', async () => {
  // The second configuration arm. Both inherited the same success default.
  // MUTATION THAT KILLS IT: revert the `if (!stored)` arm to a bare warning.
  // ROUTE: as above, with `paymentMap` naming an unrelated method.
  reset({ bank_transfer: 'QBO-BANK-9' })

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'PRECONDITION: the invoice really did post')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'no payment row was created')
  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(String(refusal[0].description), /no bank account is mapped for method "card" \/ currency "GBP"/)
  assert.deepEqual(released, [], 'the obligation survives this arm as well')
})

test('[o3d-batch-ret r6] with the mapping in place the payment IS enqueued and the obligation clears', async () => {
  // THE CONTROL THAT MAKES THE TWO ABOVE NON-VACUOUS: identical fixture, mapping present, and the
  // release demonstrably happens. Without it "released is empty" could be true of every run.
  //
  // It is a SEPARATE PASS rather than a second run over the same row, and deliberately so: on this
  // connector nothing re-drives a retained marker, so there is no "later" to test. That asymmetry
  // with the Xero twin (tests/accounting/xero-payment-mapping-refusal.test.ts, where the sweep does
  // pick the row back up) is the registry's declaration, not an omission here.
  // ROUTE: one real processor run with the mapping configured.
  reset({ card: 'QBO-BANK-1' })

  await runQuickBooks()

  assert.deepEqual(
    followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'the payment the refusal withheld is queued once its account is mapped',
  )
  assert.deepEqual(paymentRefusals(), [], 'and nothing is refused')
  assert.deepEqual(
    released, ['entry-invoice'],
    'a pass that queued everything it owed DOES discharge the obligation',
  )
})
