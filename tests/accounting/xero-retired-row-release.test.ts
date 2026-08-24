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
/**
 * o3d-psvi r2: run when the sales-order row lock is TAKEN, which is the instant a writer that was
 * queued behind it has just finished. It is how a concurrent sweep verdict is landed in the window
 * the in-transaction re-read exists to close.
 */
let onSaleLock: (() => void) | null = null

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
  $queryRaw: rowLockQuery,
  $executeRaw: async () => 1,
  /**
   * o3d-psvi r3 (Codex HIGH) — THE DOUBLE HAS POSTGRES ABORT SEMANTICS.
   *
   * The previous double handed the transaction body the bare `dbStub`, so a statement that threw
   * left every LATER statement working normally. Real Postgres does the opposite: the first failed
   * statement ABORTS the transaction, and everything after it raises 25P02 until the block ends,
   * whatever the application code does with the first error.
   *
   * That difference is not cosmetic — it is the entire finding. Under the old double, catching the
   * lock failure INSIDE the transaction and carrying on looked like it produced the UNREADABLE
   * refusal; in production the very next statement raised 25P02 and a raw Prisma error reached the
   * operator instead. The test asserted a shape production did not have, and it could not fail.
   */
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(abortingTransactionScope()),
}

/** The lock's raw statement, shared by the top-level stub and the transaction scope. */
async function rowLockQuery(): Promise<unknown[]> {
  if (lockFailures > 0) {
    lockFailures -= 1
    throw new Error('could not lock the sales order row')
  }
  const landed = onSaleLock
  onSaleLock = null
  landed?.()
  return []
}

/** What Postgres says to every statement issued after one has failed inside a transaction. */
const TRANSACTION_ABORTED = 'current transaction is aborted, commands ignored until end of transaction block'

function abortingTransactionScope(): unknown {
  let aborted = false
  const guard = (call: (...args: never[]) => Promise<unknown>) => async (...args: never[]): Promise<unknown> => {
    if (aborted) {
      const error = new Error(TRANSACTION_ABORTED) as Error & { code?: string }
      error.code = '25P02'
      throw error
    }
    try {
      return await call(...args)
    } catch (error) {
      aborted = true
      throw error
    }
  }
  const guardedDelegate = (delegate: Record<string, unknown>) => new Proxy({}, {
    get: (_target, prop: string) => guard(
      (...args: never[]) => (delegate[prop] as (...a: never[]) => Promise<unknown>)(...args),
    ),
  })
  return {
    accountingSyncLog: guardedDelegate(accountingSyncLog as unknown as Record<string, unknown>),
    salesOrder: guardedDelegate(dbStub.salesOrder as unknown as Record<string, unknown>),
    salesOrderRefund: guardedDelegate(dbStub.salesOrderRefund as unknown as Record<string, unknown>),
    purchaseInvoice: guardedDelegate(dbStub.purchaseInvoice as unknown as Record<string, unknown>),
    supplierCreditNote: guardedDelegate(dbStub.supplierCreditNote as unknown as Record<string, unknown>),
    setting: guardedDelegate(dbStub.setting as unknown as Record<string, unknown>),
    $queryRaw: guard(rowLockQuery),
    $executeRaw: guard(async () => 1),
  }
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
  onSaleLock = null
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
  assert.equal(row?.settlementBasis, 'OPERATOR_RELEASE', 'and the column says an OPERATOR reached this status')

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

// ---------------------------------------------------------------------------
// o3d-psvi ROUND 2 (Codex HIGH) — THE REMEDY WAS UNREACHABLE FOR THE POPULATION IT WAS WRITTEN FOR.
//
// `applyFencedAttemptDecision` refuses revision 0 as UNFENCED_ATTEMPT unless adoption is asked for,
// and this action never asked. Revision 0 is not a corner case: the attempt-revision migration left
// every pre-existing row there, and the sweep's own retirement deliberately does NOT advance a row
// that is still at 0 (a bump would invent an attempt nothing ever made). So the one control written
// to rescue a retired row refused exactly the retired rows there are, and its refusal named a claim
// that was never coming — a refusal with no remedy, which is the failure this issue is named for.
//
// These tests drive the WHOLE round trip on a revision-0 row, because "the action returned success"
// is precisely the assertion that would have passed while the remedy did nothing.
// ---------------------------------------------------------------------------

/** Retire a LEGACY row — one no fence-aware processor has ever claimed — through the real sweep. */
async function retireLegacyBySweep() {
  await (await loadSweep())()
  const retired = store.get('log-1')
  assert.equal(retired?.status, 'CANCELLED', 'precondition: the sweep retired the row')
  assert.equal(
    retired?.attemptRevision,
    0,
    'precondition: the sweep deliberately does NOT advance a row nothing has ever claimed',
  )
  activity.length = 0
  return retired!
}

test('[o3d-psvi r2] a LEGACY row at revision 0 is released, and the sweep then finishes the job', async () => {
  reset({ status: 'CANCELLED', accountingInvoiceId: null }, { attemptRevision: 0 })
  await retireLegacyBySweep()

  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  const released = await (await loadRelease())('log-1', 0)
  assert.deepEqual(released, { success: true }, 'the remedy must be performable for the rows it exists for')

  const row = store.get('log-1')
  assert.equal(row?.status, 'SYNCED')
  assert.equal(row?.backReferenceCheckedAt, null)
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'nothing was sent to the ledger')
  assert.equal(row?.attemptRevision, 1, 'adoption bumps to 1 exactly as a processor\'s first claim would')

  // THE PART THAT MAKES IT A REMEDY RATHER THAN A STATUS CHANGE.
  const result = await (await loadSweep())()
  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'the link is finally written')
  assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'], 'and the withheld follow-ups are enqueued')
  assert.equal(result.repaired, 1)
})

test('[o3d-psvi r2] the adoption is still a COMPARE-AND-SWAP — a second one loses', async () => {
  // Revision zero is fenced BY THE REVISION: it only ever moves up, so `(id, CANCELLED, 0)` is
  // strictly stronger than the `(id, CANCELLED)` identity check adoption is accused of degrading to.
  // Once the first release has taken the row to 1, the same call cannot land again.
  reset({ status: 'CANCELLED', accountingInvoiceId: null }, { attemptRevision: 0 })
  await retireLegacyBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  assert.deepEqual(await (await loadRelease())('log-1', 0), { success: true })

  const second = await (await loadRelease())('log-1', 0)
  assert.equal(second.success, false)
  assert.equal(store.get('log-1')?.attemptRevision, 1, 'the row moved once, not twice')
})

test('[o3d-psvi r2] a row STAMPED between the operator\'s read and the write is refused, not released', async () => {
  // THE REASON THE ROW'S SHAPE IS RE-READ UNDER THE LOCK. The revision cannot testify to this: an
  // adoption deliberately accepts a revision that has NOT moved, so the row's own columns are the only
  // witness left. Releasing a stamped row produces a tidy-looking SYNCED row that no later pass ever
  // looks at — a remedy nothing performs, which is the whole of this issue.
  reset({ status: 'CANCELLED', accountingInvoiceId: null }, { attemptRevision: 0 })
  await retireLegacyBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  // The sweep reaches a verdict while this call is waiting on the sales-order lock.
  onSaleLock = () => { store.get('log-1')!.backReferenceCheckedAt = new Date('2026-08-22T00:00:00.000Z') }

  const result = await (await loadRelease())('log-1', 0)

  assert.equal(result.success, false)
  assert.match(String(result.error), /already reached a verdict/)
  assert.match(String(result.error), /external-id release command/, 'and it names a remedy that IS performable')
  assert.equal(store.get('log-1')?.status, 'CANCELLED', 'nothing was written')
})

// ---------------------------------------------------------------------------
// o3d-psvi ROUND 3 (Codex MEDIUM) — AN OPERATOR'S STATUS WRITE MUST NOT READ AS THE CONNECTOR'S.
//
// The retirement this control undoes is reachable from EITHER SYNCED or FAILED and preserves
// neither, so the SYNCED written by the release is not a restatement of anything the connector said
// — it is an operator's write, and an UNMARKED SYNCED is the strongest claim this table can make.
// `settlementBasis` is the column that exists so a status a human reached is never read as one the
// connector reached, and this branch's own refusal already reads that column rather than the note.
//
// The stamp is OPERATOR_RELEASE and not OPERATOR_ASSERTION on purpose: the DOCUMENT ID on a
// released row is the connector's own (an asserted row is refused outright), so the readers that
// fail closed on an unverified id must not fire — folding the two together would make the sweep
// refuse the very row the release exists to hand it.
// ---------------------------------------------------------------------------

test('[o3d-psvi r3] the release stamps its OWN basis, and the sweep still finishes the job', async () => {
  const { isOperatorAssertedSettlement, isOperatorReleasedSettlement, OPERATOR_RELEASE_SETTLEMENT_BASIS } =
    await import('@/lib/domain/accounting/sync-row-settlement')

  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  await retireBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })

  assert.deepEqual(await (await loadRelease())('log-1', 5), { success: true })

  const released = store.get('log-1')
  assert.equal(released?.settlementBasis, OPERATOR_RELEASE_SETTLEMENT_BASIS)
  assert.equal(
    isOperatorReleasedSettlement(released?.settlementBasis ?? null),
    true,
    'a reader asking "did an operator reach this status?" must be able to see that it did',
  )
  // ...and it is NOT the assertion basis, because the id was never asserted. This is the half that
  // keeps the remedy performable: the sweep refuses to write a back-reference or build follow-ups
  // from an ASSERTED row, so a released row marked that way would be a remedy nothing performs.
  assert.equal(isOperatorAssertedSettlement(released?.settlementBasis ?? null), false)

  const result = await (await loadSweep())()
  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'the link is still written')
  assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'], 'and the follow-ups are still enqueued')
  assert.equal(result.repaired, 1)
})

test('[o3d-psvi r3] a lock failure REFUSES rather than escaping as a raw database error', async () => {
  // THE THIRD STATE, ASSERTED AGAINST ABORT SEMANTICS. `$transaction` here aborts on the first
  // failed statement exactly as Postgres does, so a `try` placed INSIDE the transaction cannot
  // produce this refusal: the row re-read that follows it raises 25P02 and escapes. What the
  // operator must never see is that error, or any word of it.
  reset({ status: 'CANCELLED', accountingInvoiceId: null })
  const retired = await retireBySweep()
  salesOrders.set('order-1', { status: 'PROCESSING', accountingInvoiceId: null })
  lockFailures = 1

  const result = await (await loadRelease())('log-1', 5)

  assert.equal(result.success, false)
  assert.match(String(result.error), /could not be read/)
  assert.equal(
    /aborted|25P02|commands ignored/i.test(String(result.error)),
    false,
    'a raw database error is not a refusal an operator can act on',
  )
  assert.deepEqual(store.get('log-1'), retired, 'and the rollback is what makes "nothing was changed" true')
})
