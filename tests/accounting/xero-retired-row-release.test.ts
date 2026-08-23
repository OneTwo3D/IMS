import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-psvi — A ROW THE SWEEP RETIRED, AND THE OPERATOR PATH BACK.
 *
 * `decideSaleRelease` retires a candidate to CANCELLED when the sale behind it is not live, and keeps
 * the id of a document that really did post. That is right, and it is also a dead end: CANCELLED is
 * outside `BACK_REFERENCE_REPAIRABLE_STATUSES`, so the sweep never looks again; retry and Retry All
 * are FAILED-only; settle answers "already CANCELLED". Meanwhile the sale CAN come back — a
 * reinstated storefront order is pushed into IMS through the full status-transition bypass, which is
 * the only route out of `CANCELLED: []` in the lifecycle table.
 *
 * THESE TESTS DRIVE THE WHOLE ROUND TRIP, not the release in isolation. Asserting that the action
 * returned `success: true` would pass against a remedy nothing can act on — which is precisely the
 * failure mode this issue is named for — so every acceptance test here ends by running the REAL
 * sweep afterwards and asserting the order was linked and the follow-ups were created.
 *
 * The refusals are driven the same way: after each one the row is re-read and asserted UNCHANGED, so
 * "it refused" cannot be passing because the write failed for some other reason.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

type OrderRow = { status: string; accountingInvoiceId: string | null }
let salesOrders: Map<string, OrderRow> = new Map()
/** How many of the next row-LOCK attempts must fail — a lock timeout, or a lost deadlock. */
let lockFailures = 0

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
      return Object.fromEntries(selectedKeys(select).map((key) => [key, (row as unknown as Record<string, unknown>)[key]]))
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = salesOrders.get(where.id)
      if (!row) throw new Error(`no sales order ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  salesOrderRefund: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  purchaseInvoice: { findUnique: async () => null, findFirst: async () => null, update: async () => { throw new Error('unused') } },
  supplierCreditNote: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  setting: { findUnique: async () => null, upsert: async () => ({}) },
  // `lockSalesOrder` issues `SELECT id FROM "sales_orders" WHERE id = $1 FOR UPDATE`. Making THIS
  // throw — rather than the whole delegate — is the only faithful way to produce the third state:
  // the row is there, nobody can currently speak for it.
  $queryRaw: async () => {
    if (lockFailures > 0) {
      lockFailures -= 1
      throw new Error('could not lock the sales order row')
    }
    return []
  },
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => {},
    requireInternalUser: async () => {},
    requireRole: async () => {},
    freshAuthFailureResult: () => ({ success: false, error: 'stale' }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
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
// A payment account map that RESOLVES, so the released row's `_registerPayment` really reaches the
// INVOICE_PAYMENT enqueue. Without it the payment is skipped with a warning and the end-to-end
// assertion below would be about a row that was never going to be created.
mock.module('@/lib/accounting', {
  namedExports: {
    getPaymentAccountMap: async () => ({ card: 'BANK-1' }),
    lookupPaymentAccount: () => 'BANK-1',
  },
})
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async () => ({ success: true }) },
})

async function loadSweep() {
  return (await import('@/lib/connectors/xero/sync-processor')).repairXeroBackReferences
}

async function loadRelease() {
  return (await import('@/app/actions/accounting-sync')).releaseRetiredAccountingSyncRowForLiveSale
}

const INVOICE_PAYLOAD = {
  invoiceNumber: 'INV-1',
  currency: 'GBP',
  _registerPayment: true,
  _paymentMethod: 'card',
  _paymentAmount: 120,
  _paymentDate: '2026-08-20',
}

const SALES_CANDIDATE = {
  id: 'log-1',
  type: 'SALES_INVOICE',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  externalTransactionId: 'XERO-INV-1',
  attemptRevision: 4,
  payload: INVOICE_PAYLOAD,
  status: 'SYNCED',
}

function reset(order: OrderRow, overrides: Record<string, unknown> = {}) {
  store = createSyncLogStore([syncLogRow({ ...SALES_CANDIDATE, ...overrides })])
  activity.length = 0
  lockFailures = 0
  salesOrders = new Map([['order-1', { ...order }]])
}

function followUpTypes(): string[] {
  return store.rows.filter((row) => row.id !== 'log-1').map((row) => row.type).sort()
}

/**
 * Put the fixture into the state the whole issue is about, USING THE REAL SWEEP rather than by
 * writing CANCELLED by hand. A hand-written row could be in a shape the sweep never actually
 * produces, and then every assertion below would be about a state that does not occur.
 */
async function retireBySweep() {
  await (await loadSweep())()
  const retired = store.get('log-1')
  assert.equal(retired?.status, 'CANCELLED', 'precondition: the sweep retired the row')
  assert.equal(retired?.externalTransactionId, 'XERO-INV-1', 'precondition: the posted document is still named on it')
  assert.equal(retired?.attemptRevision, 5, 'precondition: retiring advanced the fence')
  activity.length = 0
  return retired!
}

test('[o3d-psvi] a retired row whose sale is LIVE again is released, and the sweep then finishes the job', async () => {
  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  await retireBySweep()

  // The storefront order is reinstated: WooCommerce pushes the new status in through the full
  // transition bypass, which is the only way out of CANCELLED.
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  const released = await (await loadRelease())('log-1', 5)
  assert.deepEqual(released, { success: true })

  const row = store.get('log-1')
  assert.equal(row?.status, 'SYNCED', 'back in the sweep\'s candidate status set')
  assert.equal(row?.backReferenceCheckedAt, null, 'and unstamped, which is the other half of being a candidate')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'the document is untouched — nothing was posted by the release')
  assert.match(String(row?.errorMessage), /back-reference repair sweep/, 'the row says why it came back')

  // THE PART THAT MAKES IT A REMEDY. Everything above is a status change; this is the work.
  const result = await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'the link is finally written')
  assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'], 'and the follow-ups the retirement withheld are enqueued')
  assert.equal(result.repaired, 1)
  assert.equal(result.retiredCancelledSale, 0)
})

test('[o3d-psvi] the release refuses while the sale is STILL cancelled, and names what to do instead', async () => {
  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  const retired = await retireBySweep()

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /still CANCELLED/)
  assert.match(String(result.error), /void or credit-note it/, 'a refusal has to say what the operator can actually do')
  assert.match(String(result.error), /reinstate the order first/)
  assert.deepEqual(store.get('log-1'), retired, 'and nothing about the row moved')
})

test('[o3d-psvi] a sale that could not be READ is the third state — refused, and explicitly not a verdict', async () => {
  // Not "the sale is gone" — "nobody can speak for it right now". Collapsing this into CANCELLED is
  // the fail-closed reading that produced the stranded row in the first place, and doing it again in
  // the recovery would make the recovery unable to recover.
  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  const retired = await retireBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })
  lockFailures = 1

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /could not be read/)
  assert.match(String(result.error), /try again/)
  assert.equal(
    /void or credit-note/.test(String(result.error)),
    false,
    'it must not tell the operator to undo a document on the strength of a read that did not answer',
  )
  assert.deepEqual(store.get('log-1'), retired, 'nothing was changed')
})

test('[o3d-psvi] a row settled on an OPERATOR ASSERTION is refused — the basis is read from the column', async () => {
  // Built directly rather than through the sweep, because the sweep cannot produce it: an asserted
  // row is refused by the unverified-assertion gate BEFORE the cancellation gate runs, so it is
  // never retired. This shape comes from the other writer of CANCELLED — an operator asserting
  // POSTED on a row whose sale is cancelled (`buildCancelledSaleSettlementData`) — which is exactly
  // the second terminal state a status filter cannot tell apart from the first.
  reset({ status: 'PROCESSING', accountingInvoiceId: null }, {
    status: 'CANCELLED',
    attemptRevision: 5,
    settlementBasis: 'OPERATOR_ASSERTION',
  })
  const retired = store.get('log-1')

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /OPERATOR ASSERTION/)
  assert.match(String(result.error), /link it to this sales order by hand/)
  assert.deepEqual(store.get('log-1'), retired)
})

test('[o3d-psvi] a row the sweep has already reached a verdict on is refused — releasing it would be a remedy nothing performs', async () => {
  // The end-to-end check, stated as a refusal. The sweep's candidate window is
  // `backReferenceCheckedAt IS NULL`; a stamped row released to SYNCED would look repaired and no
  // pass would ever touch it again.
  reset({ status: 'CANCELLED', accountingInvoiceId: null }, {
    status: 'CANCELLED',
    attemptRevision: 5,
    backReferenceCheckedAt: new Date('2026-08-21T00:00:00.000Z'),
  })

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /already reached a verdict/)
  assert.match(String(result.error), /external-id release command/)
  assert.equal(store.get('log-1')?.status, 'CANCELLED')
})

test('[o3d-psvi] the release is FENCED on the attempt the operator was shown', async () => {
  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  const retired = await retireBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  // The operator's page was rendered before the retirement advanced the fence.
  const result = await (await loadRelease())('log-1', 4)

  assert.equal(result.success, false)
  assert.deepEqual(store.get('log-1'), retired, 'a decision taken about a different attempt is not recorded')

  // …and the same call on the attempt actually in front of them works, so the refusal above is the
  // fence rather than something else refusing everything.
  assert.deepEqual(await (await loadRelease())('log-1', 5), { success: true })
})

test('[o3d-psvi] a CANCELLED row that names no document is refused — releasing it would record a post that never happened', async () => {
  reset({ status: 'PROCESSING', accountingInvoiceId: null }, {
    status: 'CANCELLED',
    attemptRevision: 5,
    externalTransactionId: null,
  })

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /names no document/)
  assert.match(String(result.error), /Raise the invoice again from the sales order/)
})
