import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-batch-ret ROUND 6 (Codex HIGH) — A REQUESTED PAYMENT THAT COULD NOT BE QUEUED WAS REPORTED AS
 * ENQUEUED, AND THE FENCE CLEARED THE OBLIGATION OVER IT.
 *
 * `enqueueSalesInvoiceFollowUps` initialised `paymentOutcome` to `FOLLOW_UPS_ENQUEUED` and narrowed
 * it only on the arm that actually reached `enqueueFollowUpSyncLog`. The two configuration arms —
 * no payment account map at all, and no account mapped for this method/currency — wrote a WARNING
 * and fell out. So a payload carrying `_registerPayment` could queue NOTHING while the aggregate
 * verdict said `enqueued: true`, `obligationReleasePrerequisite` handed the receipt fence no
 * prerequisite, and the fence released the generation. The row ends SYNCED, linked and marker-null:
 * indistinguishable from one that completed, and no longer a candidate for anything.
 *
 * THIS IS A BEHAVIOURAL INSTRUMENT, NOT A STRUCTURAL ONE. The round-5 guard for the same invariant
 * (`enqueue-verdict-precedes-receipt-fence.test.ts`) judged the connectors by parsing them, and
 * Codex's round-6 MEDIUM is that such a judge has to model scope and hoisting to be sound — it can
 * be satisfied by a shape whose RUNTIME calls the fence first. So the claim is made the only way it
 * cannot be faked: drive the real `repairXeroBackReferences` over a real fixture, with the real
 * `registerDeferredOrderReceipts` and the real claim/release protocol, and read the MARKER COLUMN.
 * A fence that ran before the verdict existed would receive a hoisted `undefined` prerequisite and
 * clear the marker, which is exactly what these assertions catch.
 *
 * THE MARKER IS THE OBSERVABLE, because it is the only thing that distinguishes a row whose payment
 * is still owed from one whose follow-ups all ran: both are SYNCED and both carry the external id.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

/**
 * The payment account map the connector reads — MUTABLE, because the second half of the finding is
 * that repairing it must let the retained generation enqueue and clear LATER. `null` is the
 * "nothing configured at all" arm; an object missing the order's method is the "no account for this
 * method/currency" arm.
 */
let paymentMap: Record<string, string> | null = null

type OrderRow = { id: string; status: string; accountingInvoiceId: string | null }
let salesOrders: Map<string, OrderRow> = new Map()

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

function selectedKeys(select: Record<string, unknown> | undefined): string[] {
  return Object.keys(select ?? {})
}

const dbStub = {
  accountingSyncLog,
  salesOrder: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const row = salesOrders.get(where.id)
      if (!row) return null
      const projected: Record<string, unknown> = {}
      for (const key of selectedKeys(select)) {
        // The deferred-receipt re-drive selects the order's RECEIPTS as a nested relation. This
        // order has none — which is what puts the re-drive on its `no-receipts` path, the one that
        // discharges through the fence and therefore has to consult the caller's prerequisite.
        projected[key] = key === 'payments' ? [] : (row as unknown as Record<string, unknown>)[key]
      }
      return projected
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = salesOrders.get(where.id)
      if (!row) throw new Error(`no sales order ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  // The fenced pass re-reads the receipts under the sales-order lock rather than re-using the
  // snapshot above, so it needs its own answer — still none.
  payment: { findMany: async () => [] },
  salesOrderRefund: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  purchaseInvoice: { findUnique: async () => null, findFirst: async () => null, update: async () => { throw new Error('unused') } },
  supplierCreditNote: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  // The sweep's keyset cursor lives in one Setting row; absent means "start at the head", which is
  // what makes the SECOND run below re-read the row the first one deliberately left unsettled.
  setting: { findUnique: async () => null, upsert: async () => ({}) },
  $queryRaw: async () => [],
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    scheduleXeroAccountingOutbox: async () => ({}),
    parseXeroAccountingOutboxPayload: (value: unknown) => value,
    XERO_ACCOUNTING_POST_OPERATION: 'post',
    XERO_OUTBOX_CONNECTOR: 'xero-accounting',
  },
})
/**
 * THE VARIABLE UNDER TEST. `lookupPaymentAccount` is the REAL question asked of a real map rather
 * than a canned answer, so "no map at all" and "a map that does not name this method" are two
 * different states of one fixture instead of two different stubs.
 */
mock.module('@/lib/accounting', {
  namedExports: {
    getPaymentAccountMap: async () => paymentMap,
    lookupPaymentAccount: (map: Record<string, string> | null, method: string) => map?.[method] ?? null,
    isAccountingSyncTypeEnabled: async () => true,
    // The re-drive asks whether the PINNED connector posts payments at all. `false` would end the
    // call before the fence, so the fixture must say yes or it would prove nothing.
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    queueAccountingSyncTxWithOutcome: async () => ({ queued: true, connector: 'xero' }),
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async () => ({ success: true }) },
})
// NOTHING about the receipt fence is stubbed. `registerDeferredOrderReceipts`,
// `dischargeDeferredReceiptObligation`, `claimFollowUpObligation` and `releaseFollowUpObligation`
// all run for real — a stub of any of them would put the answer under test into the fixture.

async function loadSweep() {
  return (await import('@/lib/connectors/xero/sync-processor')).repairXeroBackReferences
}

/** An invoice posted for an order that PAID BY CARD — so a payment really is requested. */
const INVOICE_PAYLOAD = {
  invoiceNumber: 'INV-1',
  currency: 'GBP',
  _registerPayment: true,
  _paymentMethod: 'card',
  _paymentAmount: 120,
  _paymentDate: '2026-08-20',
}

/** The sweep's candidate shape: SYNCED, naming a document, on an order that is not linked yet. */
const SALES_CANDIDATE = {
  id: 'log-1',
  connector: 'xero',
  type: 'SALES_INVOICE',
  status: 'SYNCED',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  externalTransactionId: 'XERO-INV-1',
  attemptRevision: 4,
  payload: INVOICE_PAYLOAD,
}

function reset(map: Record<string, string> | null) {
  store = createSyncLogStore([syncLogRow(SALES_CANDIDATE)])
  activity.length = 0
  paymentMap = map
  salesOrders = new Map([['order-1', { id: 'order-1', status: 'PROCESSING', accountingInvoiceId: null }]])
}

/** The follow-up rows the sweep actually created. */
function followUpTypes(): string[] {
  return store.rows.filter((row) => row.id !== 'log-1').map((row) => row.type).sort()
}

/** The obligation marker as it stands on the parent row — the whole observable. */
function marker(): Date | null {
  return store.get('log-1')?.backReferenceFollowUpsPendingAt ?? null
}

function paymentRefusals(): Array<{ description: string; metadata?: Record<string, unknown> }> {
  return activity.filter((entry) => entry.action === 'xero_payment_skipped')
}

test('[o3d-batch-ret r6] a requested payment with NO account mapping is refused, and the obligation marker SURVIVES', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE whose payload asks for a
  // payment, with the payment account map empty. The real receipt fence runs and the real
  // `releaseFollowUpObligation` is the only thing that can clear the marker column read below.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/xero/sync-processor.ts, make
  // `decideInvoicePaymentFollowUp`'s two configuration arms `return FOLLOW_UPS_ENQUEUED` instead of
  // `refuse(...)` — i.e. restore the shipped defect. The refusal assertions fail, and so does the
  // marker assertion, because the fence is then handed no prerequisite and releases the generation.
  reset(null)

  await (await loadSweep())()

  assert.equal(
    salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
    'PRECONDITION: the repair really ran and linked the order — otherwise nothing below is about the enqueue',
  )
  assert.deepEqual(
    followUpTypes(), ['INVOICE_PDF'],
    'the PDF still goes out — a refused payment is no reason to withhold separate work — and the PAYMENT does not',
  )

  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1, 'the operator is told once, and told why')
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped', 'and the machine key names the refusal')
  assert.match(refusal[0].description, /NOTHING WAS QUEUED/)
  assert.match(refusal[0].description, /Payment Account Mapping/, 'the remedy is a SETTING, which is safe to repeat')
  assert.match(
    refusal[0].description, /a later sweep re-reads the marker/,
    'and what happens next is read off the connector registry, not promised here',
  )

  assert.notEqual(
    marker(), null,
    'THE FINDING: the row must still say it owes follow-ups. A cleared marker here is a payment that '
      + 'was requested, never queued, and can never be recovered — on a row that looks reconciled',
  )
  assert.equal(store.get('log-1')?.backReferenceCheckedAt, null, 'and it is left in the sweep candidate set')
})

test('[o3d-batch-ret r6] the same row with a map that does not name THIS method is refused too', async () => {
  // The second configuration arm, which the first test cannot reach: a map exists, and
  // `lookupPaymentAccount` finds nothing for card/GBP. Both arms inherited the same success default.
  //
  // MUTATION THAT KILLS IT: change the `if (!stored)` arm back to a bare `logActivity` warning.
  // ROUTE: as above, with `paymentMap` holding an unrelated method.
  reset({ bank_transfer: 'BANK-9' })

  await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'PRECONDITION: the repair ran')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'no payment row was created')
  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(refusal[0].description, /no bank account is mapped for method "card" \/ currency "GBP"/)
  assert.notEqual(marker(), null, 'the marker survives this arm as well')
})

test('[o3d-batch-ret r6] repairing the mapping lets the RETAINED generation enqueue and clear on a later run', async () => {
  // THE OTHER HALF OF THE FINDING, and the reason refusing is a deferral rather than a stall: the
  // marker is retained, the row stays a candidate, and the Xero sweep — which the registry declares
  // as this connector's consumer — picks it up once the setting is fixed.
  //
  // MUTATION THAT KILLS IT: make the refusal permanent (e.g. have the sweep stamp
  // `backReferenceCheckedAt` on a refusal), or leave the marker cleared on run 1 — run 2 then finds
  // no candidate and no INVOICE_PAYMENT is ever created.
  // ROUTE: two real sweep runs over one store, with `paymentMap` repaired between them.
  reset(null)

  await (await loadSweep())()
  const deferred = marker()
  assert.notEqual(deferred, null, 'PRECONDITION: run 1 refused and retained the generation')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'PRECONDITION: run 1 queued no payment')

  // The operator adds the mapping the refusal named.
  paymentMap = { card: 'BANK-1' }
  activity.length = 0

  await (await loadSweep())()

  assert.deepEqual(
    followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'the payment the first run refused is enqueued by the run after the mapping exists — and the PDF '
      + 'is not duplicated, because a live row already owns that scope',
  )
  assert.deepEqual(paymentRefusals(), [], 'and nothing is refused the second time')
  assert.equal(
    marker(), null,
    'only NOW is the obligation discharged: the marker is retained until the work it stands for is queued',
  )
})

test('[o3d-batch-ret r6] CONTROL: a mapped payment clears in ONE run, so the retention above is a real difference', async () => {
  // Without this the tests above could be passing because the fixture never clears the marker at
  // all. Same row, same fixture, mapping present from the start.
  // ROUTE: one real sweep run with the mapping already configured.
  reset({ card: 'BANK-1' })

  await (await loadSweep())()

  assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'])
  assert.deepEqual(paymentRefusals(), [])
  assert.equal(marker(), null, 'a pass that queued everything it owed DOES clear the generation')
})

/**
 * AND THE OTHER AXIS OF THE SAME FOLD (o3d-batch-ret r6).
 *
 * `combineFollowUpEnqueueOutcomes` exists because a refusal on EITHER half means the row still owes
 * work. The round-5 structural judge asserted that by reading the connector's source for a
 * prerequisite composed over the aggregate NAME; this asserts it by making the OTHER half refuse and
 * reading the marker. A FAILED INVOICE_PDF row left at attempt revision 0 is the enqueue's
 * `unprobed_unfenced_reuse`: nothing can establish whether that row's effect already happened, and
 * the PDF creates no ledger document to probe. The payment, fully mapped here, enqueues normally.
 */
test('[o3d-batch-ret r6] a refused PDF beside an ENQUEUED payment also keeps the marker', async () => {
  // MUTATION THAT KILLS IT: compose `obligationReleasePrerequisite` over `paymentOutcome` alone
  // instead of the aggregate `enqueueOutcome` — the payment succeeded, so the fence would release
  // while the PDF is still owed.
  // ROUTE: the real sweep, with the payment mapping present and an unfenced FAILED PDF row in scope.
  reset({ card: 'BANK-1' })
  store = createSyncLogStore([
    syncLogRow(SALES_CANDIDATE),
    syncLogRow({
      id: 'pdf-failed',
      connector: 'xero',
      type: 'INVOICE_PDF',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      // Revision 0 is the legacy population the attempt fence cannot reason about: the row reached
      // FAILED by RUNNING, so reviving it could repeat an effect nothing can take back.
      attemptRevision: 0,
      payload: { accountingInvoiceId: 'XERO-INV-1', referenceId: 'order-1' },
    }),
  ])

  await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'PRECONDITION: the repair ran')
  const refused = activity.filter((entry) => entry.action === 'xero_followup_enqueue_refused')
  assert.equal(refused.length, 1, 'PRECONDITION: the PDF enqueue really did refuse')
  assert.equal(refused[0].metadata?.reason, 'unprobed_unfenced_reuse')
  assert.equal(refused[0].metadata?.type, 'INVOICE_PDF', 'and it is the PDF half that refused, not the payment')
  assert.deepEqual(paymentRefusals(), [], 'PRECONDITION: the payment half was mapped and did NOT refuse')
  assert.ok(
    store.rows.some((row) => row.type === 'INVOICE_PAYMENT'),
    'PRECONDITION: the payment really was enqueued, so this is a mixed verdict rather than two refusals',
  )

  assert.notEqual(marker(), null, 'a refusal on EITHER half keeps the obligation open')
})
