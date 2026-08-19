import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-5ct. The o3d-y14 backfill used to PATCH the queued SALES_INVOICE payload, because the
 * processors post from a payload snapshot rather than re-reading the order. That can never be made
 * safe from the writer's side: both processors read the sync row BEFORE they conditionally claim it,
 * so a worker can be holding the old payload while the row still reads PENDING. Re-checking the
 * status inside a transaction does not reach another process's memory — it only narrows the window.
 *
 * So the backfill does not touch the queue at all. It takes the sales-order row lock — the SAME
 * `SELECT ... FOR UPDATE` that `lockOrderForAccountingEnqueue` takes inside queueXeroSync /
 * queueQuickBooksSync, and that queueAccountingSyncTx refuses to run without — and DECLINES any order
 * that has live invoice work, reporting it.
 *
 * The second half of that fence is NOT here: the lock serialises the INSERT of a queue row, not the
 * CONSTRUCTION of its payload. See tests/domain/accounting/enqueue-discount-fence.test.ts for the
 * producer that snapshots BEFORE blocking on the lock, which this file's ordering cannot express.
 *
 * The doubles below honour their `where` clauses. A double that returned a fixed count, or ignored
 * the status filter, could not tell "declined because a job is live" from "corrected anyway" — which
 * is the entire property under test.
 */

const events: string[] = []
const locked: string[] = []

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => {
      events.push(`lock:${orderId}`)
      locked.push(orderId)
    },
  },
})

type SyncLogRow = {
  id: string
  referenceType: string
  referenceId: string
  type: string
  status: string
  externalTransactionId?: string | null
}

type OrderRow = {
  id: string
  discountAmount: number
  discountModel: string | null
  /** o3d-y14 r4 finding 1 — the durable "this row was restated" record. */
  discountRestatement?: unknown
  lines: Array<{ discountAmount: number }>
  importedAt: string | null
  accountingInvoiceId?: string | null
  revenueDeferredBatchRef?: string | null
  unearnedRevenueAmount?: number | null
  /** o3d-y14 r6 finding 1 — the two refund signals read under the same lock. */
  refundStatus?: 'NONE' | 'PARTIAL' | 'FULL'
  refunds?: Array<{ id: string; accountingCreditNoteId: string | null }>
}

/** A mirrored AccountingEvent — what the o3d-y14 r5 ledger handoff replays the connector rule over. */
type EventRow = {
  sourceEntityType: string
  sourceEntityId: string
  type: string
  status: string
  currency: string
  externalSystem: string | null
  externalId: string | null
  businessDate: string
  createdAt: string
  linesJson: unknown
}

/** o3d-y14 r7 finding 1 — a WooCommerce refund that ARRIVED and could not be recorded. */
type ParkRow = {
  connector: string
  direction: string
  entityType: string
  status: string
  entityId: string | null
  externalId: string | null
}

/** o3d-y14 r7 finding 4 — the persisted refund lines the credit-note derivation reads. */
type RefundRow = {
  id: string
  chargeback: boolean
  totalsBasis: string | null
  accountingCreditNoteId: string | null
  lines: Array<{ salesOrderLineId: string | null; totalBase: number; totalForeign: number; lineKind: string | null }>
}

type Store = {
  orders: OrderRow[]
  syncLogs: SyncLogRow[]
  events?: EventRow[]
  parks?: ParkRow[]
  refundRows?: RefundRow[]
  /**
   * Mirrored CREDIT_NOTE events (o3d-y14 r8 finding 3) — IMS's only record of whether a credit note
   * still STANDS as its persisted lines describe. Undefined means "the mirror says nothing", which
   * is itself a refusal, so a store that forgets them cannot accidentally net.
   */
  creditNoteEvents?: Array<{
    sourceEntityId: string
    type: string
    status: string
    externalId: string | null
    /** o3d-y14 r9 finding 1 — WHICH LEDGER it stands in. A netting needs both sides in one. */
    externalSystem?: string | null
  }>
  activity: Array<{ action: string; entityId: string | null; description?: string; metadata: Record<string, unknown> }>
}

/** A PENDING/FAILED/QUARANTINED refund park on `order-1`, matching the partial unique index exactly. */
function park(over: Partial<ParkRow> = {}): ParkRow {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    status: 'QUARANTINED',
    entityId: 'order-1',
    externalId: '9001',
    ...over,
  }
}

/**
 * A transaction stub that actually EVALUATES its predicates: findUnique matches on id and returns
 * the FULL evidence set (amount, lines, link timestamp) the way the real select does, updateMany
 * applies the full compare-and-set and only mutates on a match, and count filters by
 * referenceType/referenceId/type/status. Anything on `accountingSyncLog` other than `count` throws —
 * the backfill must never write to the queue.
 */
function makeTx(store: Store, hooks: { afterRead?: () => void } = {}) {
  return {
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        events.push(`findUnique:${where.id}`)
        const found = store.orders.find((order) => order.id === where.id)
        const snapshot = found
          ? {
              id: found.id,
              discountAmount: found.discountAmount,
              discountModel: found.discountModel,
              accountingInvoiceId: found.accountingInvoiceId ?? null,
              revenueDeferredBatchRef: found.revenueDeferredBatchRef ?? null,
              unearnedRevenueAmount: found.unearnedRevenueAmount ?? null,
              refundStatus: found.refundStatus ?? 'NONE',
              refunds: (found.refunds ?? []).map((refund) => ({ ...refund })),
              lines: found.lines.map((line) => ({ ...line })),
              shoppingLinks: found.importedAt ? [{ createdAt: new Date(found.importedAt) }] : [],
            }
          : null
        // Lets a test land a concurrent write in the window BETWEEN the read and the update — the
        // window the row lock closes for enqueue paths, and the compare-and-set closes for anything
        // that reaches the row without taking it.
        hooks.afterRead?.()
        return snapshot
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; discountAmount?: number; discountModel?: null }
        data: { discountAmount?: number; discountModel: string; discountRestatement?: unknown }
      }) => {
        events.push(`updateMany:${where.id}`)
        // Modelled on Prisma: a predicate that is ABSENT does not constrain. If it did, dropping the
        // compare-and-set from production would make the double reject every write and every test
        // would fail for the wrong reason — hiding which property the CAS actually carries.
        const target = store.orders.find(
          (order) =>
            order.id === where.id &&
            (!('discountAmount' in where) || order.discountAmount === where.discountAmount) &&
            (!('discountModel' in where) || order.discountModel === where.discountModel),
        )
        if (!target) return { count: 0 }
        // Likewise: a field the write does NOT set must stay as it was, or a stamp-only write would
        // be indistinguishable from a correction that happened to keep the amount.
        if ('discountAmount' in data && data.discountAmount !== undefined) {
          target.discountAmount = data.discountAmount
        }
        target.discountModel = data.discountModel
        // Applied only when the write sets it, for the same reason as the amount above: a stamp that
        // silently acquired a restatement record would be indistinguishable from a correction.
        if ('discountRestatement' in data) target.discountRestatement = data.discountRestatement
        return { count: 1 }
      },
    },
    // r7 finding 1 — the PARK read, under the same lock. The double HONOURS the whole predicate
    // (connector, direction, entityType, status set, both id fields) because the production query
    // copies the partial unique index's predicate exactly, and a double that matched on entityId
    // alone would pass a version that counted an unrelated failed ORDER IMPORT as a refund.
    shoppingSyncLog: {
      findMany: async ({
        where,
      }: {
        where: {
          connector: string
          direction: string
          entityType: string
          status: { in: string[] }
          externalId: { not: null }
          entityId: string
        }
      }) => {
        events.push(`park:findMany:${where.entityId}`)
        return (store.parks ?? [])
          .filter(
            (row) =>
              row.connector === where.connector &&
              row.direction === where.direction &&
              row.entityType === where.entityType &&
              where.status.in.includes(row.status) &&
              row.externalId !== null &&
              row.entityId === where.entityId,
          )
          .map((row) => ({ externalId: row.externalId }))
      },
    },
    // r7 finding 4 — the persisted refund lines the credit-note discount derivation reads back.
    salesOrderRefund: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        events.push(`refundLines:findMany:${where.id.in.join('|')}`)
        return (store.refundRows ?? []).filter((row) => where.id.in.includes(row.id))
      },
    },
    accountingSyncLog: {
      // Honours BOTH shapes the production code uses: the order-scoped invoice count keys on a bare
      // `referenceId`, the daily-batch count on `referenceId: { in: [...] }` with a single `type`.
      // A double that ignored either would pass whether or not the batch producer is checked at all.
      count: async ({
        where,
      }: {
        where: {
          referenceType: string
          referenceId: string | { in: string[] }
          type: { in: string[] } | string
          status: { in: string[] }
        }
      }) => {
        const refs = typeof where.referenceId === 'string' ? [where.referenceId] : where.referenceId.in
        const types = typeof where.type === 'string' ? [where.type] : where.type.in
        events.push(`count:${refs.join('|')}`)
        return store.syncLogs.filter(
          (log) =>
            log.referenceType === where.referenceType &&
            refs.includes(log.referenceId) &&
            types.includes(log.type) &&
            where.status.in.includes(log.status),
        ).length
      },
      // The POSTED-invoice evidence read (o3d-y14 r2 finding 2). Filters on status AND on
      // `externalTransactionId: { not: null }`, because a SYNCED row with no id is not a document.
      //
      // BOTH `referenceId` shapes, like `count` above: the invoice read keys on a bare id, the
      // CREDIT-NOTE read (o3d-y14 r6 finding 1) on `{ in: [refundIds] }`. A double that understood
      // only the first would return [] for every credit-note query and could not tell an order with
      // a posted credit note from one without — which is the distinction that suppresses a remedy.
      findMany: async ({
        where,
      }: {
        where: {
          referenceType: string
          referenceId: string | { in: string[] }
          type: { in: string[] }
          status: { in: string[] }
          externalTransactionId: { not: null }
        }
      }) => {
        const refs = typeof where.referenceId === 'string' ? [where.referenceId] : where.referenceId.in
        events.push(`findMany:${where.referenceType}:${refs.join('|')}`)
        return store.syncLogs
          .filter(
            (log) =>
              log.referenceType === where.referenceType &&
              refs.includes(log.referenceId) &&
              where.type.in.includes(log.type) &&
              where.status.in.includes(log.status) &&
              (!('externalTransactionId' in where) || !!log.externalTransactionId),
          )
          .map((log) => ({ externalTransactionId: log.externalTransactionId ?? null }))
      },
      update: async () => {
        throw new Error('the backfill must never mutate a queued payload (o3d-5ct)')
      },
      updateMany: async () => {
        throw new Error('the backfill must never mutate a queued payload (o3d-5ct)')
      },
      delete: async () => {
        throw new Error('the backfill must never retire a queued job (o3d-5ct)')
      },
    },
    // The mirrored-document read the o3d-y14 r5 ledger handoff makes. It honours its `where` for the
    // same reason every other double here does: a double that ignored `status` could not tell a
    // POSTED document from an unsettled invoice UPDATE, and those two produce OPPOSITE operator
    // instructions ("nothing to do" versus "no remedy is prescribed").
    accountingEvent: {
      count: async ({
        where,
      }: {
        where: { sourceEntityType: string; sourceEntityId: string; type: string; status: { notIn: string[] } }
      }) => {
        events.push(`event:count:${where.sourceEntityId}`)
        return (store.events ?? []).filter(
          (event) =>
            event.sourceEntityType === where.sourceEntityType &&
            event.sourceEntityId === where.sourceEntityId &&
            event.type === where.type &&
            !where.status.notIn.includes(event.status),
        ).length
      },
      findMany: async ({
        where,
      }: {
        where: {
          sourceEntityType: string
          sourceEntityId: string | { in: string[] }
          type: { in: string[] } | string
          status?: string
        }
      }) => {
        // The CREDIT-NOTE standing read (o3d-y14 r8 finding 3): a different entity type, an `in`
        // list of refund ids, a scalar type and NO status filter. Served on its own branch rather
        // than by loosening the invoice one, so a query of the wrong shape still fails loudly — the
        // previous double answered it by comparing `event.status === undefined` and returned [] for
        // everything, which is a refusal that looks like a considered one.
        if (where.sourceEntityType === 'SalesOrderRefund') {
          const ids = typeof where.sourceEntityId === 'string' ? [where.sourceEntityId] : where.sourceEntityId.in
          if (typeof where.type !== 'string') throw new Error('the credit-note read filters on a scalar type')
          events.push(`event:creditNotes:${ids.join('|')}`)
          return (store.creditNoteEvents ?? []).filter(
            (event) => ids.includes(event.sourceEntityId) && event.type === where.type,
          )
        }
        if (typeof where.sourceEntityId !== 'string' || typeof where.type === 'string') {
          throw new Error('the double only implements the invoice read in this shape')
        }
        const typeIn = where.type.in
        const sourceEntityId = where.sourceEntityId
        events.push(`event:findMany:${sourceEntityId}`)
        return (store.events ?? []).filter(
          (event) =>
            event.sourceEntityType === where.sourceEntityType &&
            event.sourceEntityId === sourceEntityId &&
            typeIn.includes(event.type) &&
            event.status === where.status,
        )
      },
    },
    activityLog: {
      create: async ({ data }: { data: { action: string; entityId: string | null; description?: string; metadata: Record<string, unknown> } }) => {
        events.push('activityLog:create')
        store.activity.push(data)
        return data
      },
    },
  } as never
}

async function load() {
  return await import('@/lib/connectors/woocommerce/sync/coupon-discount-backfill')
}

const IMPORTED_AT = '2026-05-01T00:00:00.000Z'

function makeStore(over: Partial<Store> = {}): Store {
  return {
    orders: [
      { id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 10 }], importedAt: IMPORTED_AT },
    ],
    syncLogs: [],
    activity: [],
    ...over,
  }
}

/** The reviewed allowlist entry — the ONLY thing apply is allowed to act on. */
const entry = {
  orderId: 'order-1',
  orderNumber: 'WC-1001',
  externalOrderNumber: '1001',
  currency: 'GBP',
  storedOrderDiscount: 10,
  lineDiscountTotal: 10,
  importedAt: IMPORTED_AT,
  keptOrderLevel: 0,
  clearedBy: 10,
  partial: false,
  accountingInvoiceId: null,
  postedInvoiceExternalIds: [] as string[],
  revenueDeferredBatchRef: null,
  // o3d-y14 r6 finding 1. The reviewed refund position; apply refuses the row if the live one has
  // moved, so a fixture that omitted it would not describe an entry apply can accept.
  refunds: { disposition: 'NONE' as const, refundIds: [] as string[], postedCreditNoteExternalIds: [] as string[], unresolvedRefundParkExternalIds: [] as string[] },
  nearCutoff: false,
}

/** What a CORRECTED order with nothing in the ledger reports. */
const NO_LEDGER_DOCUMENTS = {
  accountingInvoiceId: null,
  postedInvoiceExternalIds: [],
  revenueDeferredBatchRef: null,
  unearnedRevenueAmount: null,
  refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
}

function reset() {
  events.length = 0
  locked.length = 0
}

test('a reviewed order is corrected and STAMPED in the same write (o3d-5ct/o3d-9te)', async () => {
  const { applyWcCouponCorrection, WC_COUPON_DISCOUNT_MODEL } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(result, { outcome: 'CORRECTED', posted: NO_LEDGER_DOCUMENTS, handoff: null })
  assert.equal(store.orders[0].discountAmount, 0, 'the duplicated part is cleared')
  assert.equal(
    store.orders[0].discountModel,
    WC_COUPON_DISCOUNT_MODEL,
    'and the row now SAYS what its amount means, so a later run cannot re-derive it',
  )
  assert.equal(store.activity.length, 1)
  assert.equal(store.activity[0].entityId, 'order-1')
})

test('the correction writes the durable RESTATEMENT RECORD in that same write (o3d-y14 r4 F1)', async () => {
  // The record a chargeback months later depends on. It has to be part of THIS update, because its
  // absence is read as "this row was never restated" — a marker written in a later step would leave
  // a window in which a restated row looks untouched, and the ActivityLog entry beside it is pruned
  // at 30 days.
  const { applyWcCouponCorrection } = await load()
  const { readDiscountRestatement } = await import('@/lib/domain/accounting/discount-restatement')
  reset()
  const store = makeStore()

  await applyWcCouponCorrection(makeTx(store), entry)

  const read = readDiscountRestatement(store.orders[0].discountRestatement)
  assert.equal(read.present, true)
  assert.equal(read.present && read.ok, true)
  if (!read.present || !read.ok) return
  assert.equal(read.value.reason, 'o3d-y14-wc-coupon')
  assert.equal(read.value.from, 10, 'what the column said, which is what any earlier invoice charged')
  assert.equal(read.value.to, 0)
  assert.equal(read.value.currency, 'GBP')
  assert.deepEqual(read.value.ledger, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: null,
  }, 'and it states positively that nothing was in the ledger when the amount was rewritten')
})

test('the restatement record carries the LIVE posting evidence, not the reviewed copy (o3d-y14 r4 F1)', async () => {
  // Including the o3d-9kek shape — a posted invoice the order is not linked to. That id is the whole
  // reason the record exists: retention DELETES the SYNCED sync log it came from, and the
  // back-reference that would have named it never got written.
  const { applyWcCouponCorrection } = await load()
  const { readDiscountRestatement } = await import('@/lib/domain/accounting/discount-restatement')
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        accountingInvoiceId: 'INV-778',
      },
    ],
    syncLogs: [
      {
        id: 'job-1',
        referenceType: 'SalesOrder',
        referenceId: 'order-1',
        type: 'SALES_INVOICE',
        status: 'SYNCED',
        externalTransactionId: 'INV-999',
      },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    accountingInvoiceId: 'INV-778',
    postedInvoiceExternalIds: ['INV-999'],
  })

  assert.equal(result.outcome, 'CORRECTED')
  const read = readDiscountRestatement(store.orders[0].discountRestatement)
  assert.equal(read.present && read.ok, true)
  if (!read.present || !read.ok) return
  assert.deepEqual(read.value.ledger, {
    accountingInvoiceId: 'INV-778',
    postedInvoiceExternalIds: ['INV-999'],
    revenueDeferredBatchRef: null,
  })
})

test('a DECLINED correction writes no restatement record (o3d-y14 r4 F1)', async () => {
  // Every refusal stays re-runnable, and a record left behind by a refusal would put an untouched
  // order onto the chargeback path's refuse-or-recover branch for good.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'PENDING' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(store.orders[0].discountRestatement, undefined)
})

test('the order row lock is taken BEFORE anything is read or decided (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()

  await applyWcCouponCorrection(makeTx(makeStore()), entry)

  assert.deepEqual(locked, ['order-1'], 'the same row every accounting enqueue path locks')
  assert.deepEqual(
    events,
    [
      'lock:order-1',
      'findUnique:order-1',
      'count:order-1',
      // No `count:` for the batch: this order carries no revenueDeferredBatchRef, so there is no
      // batch to look for. The posted-evidence read still happens, under the same lock.
      'findMany:SalesOrder:order-1',
      // r7 finding 1: the PARK read is under the lock too, and UNCONDITIONAL — a park is exactly the
      // shape that exists when there is no SalesOrderRefund row, so skipping it when the refund list
      // is empty is what let a parked refund read as an unrefunded order.
      'park:findMany:order-1',
      'updateMany:order-1',
      'activityLog:create',
    ],
    'reading or counting before the lock would make every live-work check a sample, not a decision',
  )
})

test('an order with a PENDING invoice job is DECLINED and nothing is written (o3d-5ct)', async () => {
  // The exact race: a worker has already read this row and kept its payload. It will claim next and
  // post the old figure. Correcting the order here would record it as fixed anyway.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'PENDING' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
  assert.equal(store.orders[0].discountAmount, 10, 'the order is untouched, so a re-run re-evaluates it')
  assert.equal(store.orders[0].discountModel, null, 'and unstamped, so nothing hides it from a re-run')
  assert.equal(store.activity.length, 0, 'no marker: it was NOT corrected')
})

test('a PROCESSING job — a worker mid-post — also declines (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'PROCESSING' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
})

test('a retryable FAILED job blocks too — "Retry All" would still post it (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE_UPDATE', status: 'FAILED' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
})

test('a TERMINAL job does not block, and another order\'s job is not confused for this one (o3d-5ct)', async () => {
  // Proves the double's filter is really applied: SYNCED/CANCELLED rows cannot be claimed, so no
  // worker can still post them; and a live job on a DIFFERENT order is irrelevant here.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { id: 'job-synced', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED' },
      { id: 'job-cancelled', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'CANCELLED' },
      { id: 'job-other', referenceType: 'SalesOrder', referenceId: 'order-2', type: 'SALES_INVOICE', status: 'PENDING' },
      { id: 'job-cogs', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'COGS_JOURNAL', status: 'PENDING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(result, { outcome: 'CORRECTED', posted: NO_LEDGER_DOCUMENTS, handoff: null })
})

test('the queue is never written to, only counted (o3d-5ct)', async () => {
  // The stub throws on any accountingSyncLog write. Patching a payload is the behaviour this issue
  // removed, and it must not come back under a different name.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(
    events.filter((event) => event.startsWith('count:')),
    ['count:order-1'],
    'the only queue interaction is a read',
  )
})

// ---------------------------------------------------------------------------
// The DAILY-BATCH producer (o3d-y14 r2 finding 1)
//
// The invoice count above cannot see these rows at all: a Group A1 journal is keyed
// `referenceType: 'DailyBatch'` on the BATCH's reference id, not on the order. That is the whole
// reason the fence missed this producer, so the store below models it exactly that way.
// ---------------------------------------------------------------------------

const BATCH_REF = 'A1-2026-07-01-abcd1234'

function batchStore(over: Partial<Store> = {}): Store {
  return makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        revenueDeferredBatchRef: BATCH_REF,
        unearnedRevenueAmount: 90,
      },
    ],
    ...over,
  })
}

const batchEntry = { ...entry, revenueDeferredBatchRef: BATCH_REF }

test('an order in a PENDING daily revenue-deferral batch is DECLINED (o3d-y14 r2 F1)', async () => {
  // The batch derived `subtotal + shipping − this discount` and staged it as a GL journal a worker
  // will post. Correcting the order now stamps it as fixed while that journal is still in flight —
  // the identical defect the invoice fence exists for, in the producer the invoice fence never saw.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = batchStore({
    syncLogs: [
      { id: 'batch-1', referenceType: 'DailyBatch', referenceId: BATCH_REF, type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), batchEntry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_BATCH_QUEUED')
  assert.equal(store.orders[0].discountAmount, 10, 'untouched, so a re-run re-evaluates it')
  assert.equal(store.orders[0].discountModel, null, 'and unstamped — nothing hides it from a later run')
  assert.equal(store.activity.length, 0)
})

test('a PROCESSING batch journal — a worker mid-post — also declines (o3d-y14 r2 F1)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = batchStore({
    syncLogs: [
      { id: 'batch-1', referenceType: 'DailyBatch', referenceId: BATCH_REF, type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PROCESSING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), batchEntry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_BATCH_QUEUED')
})

test('a POSTED batch journal does not block — it is reported instead (o3d-y14 r2 F1)', async () => {
  // A SYNCED journal cannot be re-claimed, so no worker can still post it. It is not a reason to
  // refuse; it is a reason to tell the operator the ledger now needs a manual adjustment. Proving
  // both halves in one test is what stops "declines everything" passing for "declines the right
  // thing" — most candidate orders have an already-posted deferral.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = batchStore({
    syncLogs: [
      { id: 'batch-1', referenceType: 'DailyBatch', referenceId: BATCH_REF, type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'SYNCED' },
      // A DIFFERENT batch is live. It must not block this order — proving the count is keyed on
      // THIS order's batch reference and not on "is any batch running".
      { id: 'batch-other', referenceType: 'DailyBatch', referenceId: 'A1-2026-07-02-ffff0000', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), batchEntry)

  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(store.orders[0].discountAmount, 0)
  assert.deepEqual(
    result.outcome === 'CORRECTED' ? result.posted : null,
    {
      accountingInvoiceId: null,
      postedInvoiceExternalIds: [],
      revenueDeferredBatchRef: BATCH_REF,
      unearnedRevenueAmount: 90,
      refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
    },
    'the posted deferral is REPORTED as needing a manual adjustment, not silently ignored',
  )
  assert.equal(store.activity[0].metadata.revenueDeferredBatchRef, BATCH_REF)
  assert.equal(store.activity[0].metadata.posted, true)
})

test('an order with no batch reference never queries for one (o3d-y14 r2 F1)', async () => {
  // Cheap, but it is the difference between "keyed on the order's own batch" and "counts every
  // DailyBatch row in the table", which would decline every order whenever any batch is pending.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { id: 'batch-1', referenceType: 'DailyBatch', referenceId: BATCH_REF, type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome, 'CORRECTED')
  assert.deepEqual(
    events.filter((event) => event.startsWith('count:')),
    ['count:order-1'],
    'no batch lookup at all when the order carries no batch reference',
  )
})

// ---------------------------------------------------------------------------
// Posting state is read LIVE, and drift is a refusal (o3d-y14 r2 finding 2)
// ---------------------------------------------------------------------------

test('an invoice posted BETWEEN review and apply is DECLINED, not silently corrected (o3d-y14 r2 F2)', async () => {
  // The race Codex named: the row was proposed while unposted, an invoice was queued and posted
  // before apply ran, and its job row is now SYNCED — so the live-job count permits the correction.
  // Reporting posting state from the reviewed file would then call this order "not posted" and tell
  // the operator no ledger correction is needed for the one order that most needs one.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        accountingInvoiceId: 'INV-778',
      },
    ],
    syncLogs: [
      { id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: 'INV-778' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10, 'nothing was written')
  assert.equal(store.orders[0].discountModel, null, 'so the next report re-proposes it WITH the invoice visible')
  assert.equal(store.activity.length, 0)
})

test('a posted-but-UNLINKED invoice is caught even though the column says nothing (o3d-y14 r2 F2)', async () => {
  // o3d-9kek: a post can succeed and still fail to write its id back. `accountingInvoiceId` is NULL,
  // matching the reviewed entry exactly — so a check on the column alone waves this through, and a
  // real Xero document silently keeps understating with nobody told.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: 'INV-999' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.match(result.outcome === 'DECLINED' ? result.detail : '', /INV-999/)
  assert.equal(store.orders[0].discountAmount, 10)
})

test('a SYNCED invoice row with NO external id is not a posted document (o3d-y14 r2 F2)', async () => {
  // The other side of the same predicate: without an id there is no document to adjust, so refusing
  // would strand the row forever. Without this case the test above would pass on a check that just
  // declined on "any SYNCED row exists".
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: null },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome, 'CORRECTED')
  assert.deepEqual(result.outcome === 'CORRECTED' ? result.posted : null, NO_LEDGER_DOCUMENTS)
})

test('a deferral batch stamped BETWEEN review and apply is DECLINED (o3d-y14 r2 F2)', async () => {
  // The daily batch ran in the gap: this order now carries a deferral derived from the pre-correction
  // discount, which the reviewer never saw and never agreed to leave inconsistent.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = batchStore()

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10)
})

test('the reported posting state is the LIVE read, not the reviewed file (o3d-y14 r2 F2)', async () => {
  // The reviewed entry names INV-1. Live, the same order also carries a SECOND posted invoice row
  // and a deferral batch. A report built from the entry would name only INV-1; the operator would
  // adjust one document and never learn about the others.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
        accountingInvoiceId: 'INV-1',
        revenueDeferredBatchRef: BATCH_REF,
        unearnedRevenueAmount: 42.5,
      },
    ],
    syncLogs: [
      { id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: 'INV-1' },
      { id: 'job-2', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE_UPDATE', status: 'SYNCED', externalTransactionId: 'INV-1-REV2' },
      { id: 'batch-1', referenceType: 'DailyBatch', referenceId: BATCH_REF, type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'SYNCED' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    accountingInvoiceId: 'INV-1',
    // The reviewer saw BOTH posted documents; apply compares that reviewed set against the live one
    // (o3d-y14 r3 F2), so an unchanged set is not a reason to refuse.
    postedInvoiceExternalIds: ['INV-1', 'INV-1-REV2'],
    revenueDeferredBatchRef: BATCH_REF,
  })

  assert.equal(result.outcome, 'CORRECTED')
  assert.deepEqual(result.outcome === 'CORRECTED' ? result.posted : null, {
    accountingInvoiceId: 'INV-1',
    postedInvoiceExternalIds: ['INV-1', 'INV-1-REV2'],
    revenueDeferredBatchRef: BATCH_REF,
    unearnedRevenueAmount: 42.5,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
  })
  assert.deepEqual(
    store.activity[0].metadata.postedInvoiceExternalIds,
    ['INV-1', 'INV-1-REV2'],
    'the durable record of what still needs adjusting is the live one too',
  )
})

// ---------------------------------------------------------------------------
// Re-verifying the REVIEWED evidence (Codex r1 F3)
// ---------------------------------------------------------------------------

test('an order whose amount moved since the review is DECLINED, not clobbered', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 7, discountModel: null, lines: [{ discountAmount: 10 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountAmount, 7)
})

test('an order whose LINE discounts moved since the review is DECLINED (Codex r1 F3)', async () => {
  // The order-level amount still matches, so the old value-only check would have proceeded — and
  // written a residual computed from lines that no longer exist. The subtraction reads the lines,
  // so the lines are part of the evidence the reviewer approved.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LINES_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10, 'untouched')
  assert.equal(store.orders[0].discountModel, null, 'and unstamped, so a later review sees it again')
})

test('an order RE-IMPORTED since the review is DECLINED — its provenance evidence moved (Codex r1 F3)', async () => {
  // importedAt IS the provenance. A row whose link timestamp changed was re-linked or re-imported,
  // so the reviewer's dating of it — the only thing that made it a candidate — no longer applies.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'IMPORT_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10)
})

test('a HAND-EDITED residual in the allowlist is refused, never written (Codex r1 F3)', async () => {
  // The allowlist decides WHICH orders, never WHAT is written: the amount is re-derived from the
  // live evidence, and a file that disagrees with its own inputs is a refusal. Otherwise a typo in a
  // reviewed file would be an instruction to write a wrong figure.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(makeTx(store), { ...entry, keptOrderLevel: 9 })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'PLAN_MISMATCH')
  assert.equal(store.orders[0].discountAmount, 10, 'nothing was written')
  assert.equal(store.orders[0].discountModel, null)
})

test('the residual actually written comes from the LIVE evidence, not the file', async () => {
  // Same row, a genuine partial: 4 of the 10 reached the lines, so 6 is real order-level money and
  // must survive. The reviewed entry agrees, and the write is the re-derived figure.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    lineDiscountTotal: 4,
    keptOrderLevel: 6,
    clearedBy: 4,
    partial: true,
  })

  assert.deepEqual(result, { outcome: 'CORRECTED', posted: NO_LEDGER_DOCUMENTS, handoff: null })
  assert.equal(store.orders[0].discountAmount, 6)
})

test('a write that lands BETWEEN the read and the update loses to the compare-and-set', async () => {
  // The re-read alone cannot catch this one: at the moment it ran, the value still matched. Only the
  // predicate ON THE WRITE does. Anything that reaches the row without taking the order lock — which
  // no enqueue path does, but a future one might — must make this a no-op rather than a clobber.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(
    makeTx(store, {
      afterRead: () => {
        store.orders[0].discountAmount = 3
      },
    }),
    entry,
  )

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountAmount, 3, 'the concurrent value stands; ours is discarded')
  assert.equal(store.orders[0].discountModel, null, 'and nothing is stamped, so a re-run re-evaluates it')
  assert.equal(store.activity.length, 0, 'no marker for a correction that did not happen')
})

test('an order stamped since the review is DECLINED — the stamp is now the truth', async () => {
  const { applyWcCouponCorrection, WC_COUPON_DISCOUNT_MODEL } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
      },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'ALREADY_MARKED')
  assert.equal(store.orders[0].discountAmount, 10, 'a stamped residual is never re-derived')
})

test('an order deleted since the review is DECLINED, not resurrected', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ orders: [] })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'ORDER_GONE')
  assert.equal(store.activity.length, 0)
})

// ---------------------------------------------------------------------------
// stampWcCouponDiscountModel — the reviewer's "this one is already correct"
// ---------------------------------------------------------------------------

test('stamping records the model WITHOUT touching the amount (Codex r1 F3)', async () => {
  // The row a manual correction already fixed: 6 residual with 4 on the lines. Re-deriving it would
  // take it to 2. Stamping says so durably, so no later run can.
  const { stampWcCouponDiscountModel, WC_COUPON_DISCOUNT_MODEL, WC_COUPON_STAMP_ACTION } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), {
    ...entry,
    storedOrderDiscount: 6,
    lineDiscountTotal: 4,
    keptOrderLevel: 2,
    clearedBy: 4,
  })

  // `posted: null`, not an empty evidence set: stamping changes no amount, so it creates no ledger
  // inconsistency and must not add this order to the operator's manual-adjustment list.
  assert.deepEqual(result, { outcome: 'CORRECTED', posted: null, handoff: null })
  assert.equal(store.orders[0].discountAmount, 6, 'the manually corrected amount SURVIVES')
  assert.equal(store.orders[0].discountModel, WC_COUPON_DISCOUNT_MODEL)
  assert.equal(store.activity[0].action, WC_COUPON_STAMP_ACTION, 'a distinct action: a human assertion, not a computation')
  assert.equal(store.activity[0].metadata.amountChanged, false)
  // o3d-y14 r4 finding 1: NO restatement record. This row's discount was never rewritten, so its
  // column is still what any document for it charged — and a record here would make its chargeback
  // depend on a mirrored accounting event existing, for no reason at all.
  assert.equal(store.orders[0].discountRestatement, undefined)
})

test('a stamped row is thereafter refused by the CORRECTION path (Codex r1 F3)', async () => {
  // The point of stamping first: after it, the destructive path cannot reach the row at all — by
  // evidence on the row, not by anyone remembering to keep it off a list.
  const { stampWcCouponDiscountModel, applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })
  const correct = { ...entry, storedOrderDiscount: 6, lineDiscountTotal: 4, keptOrderLevel: 2, clearedBy: 4 }

  await stampWcCouponDiscountModel(makeTx(store), correct)
  const second = await applyWcCouponCorrection(makeTx(store), correct)

  assert.equal(second.outcome === 'DECLINED' && second.reason, 'ALREADY_MARKED')
  assert.equal(store.orders[0].discountAmount, 6, 'still 6 — never eroded to 2')
})

test('stamping is refused when the amount it was asserted about has moved', async () => {
  const { stampWcCouponDiscountModel } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 5, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), { ...entry, storedOrderDiscount: 6 })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountModel, null, 'an assertion about a different value is not recorded')
})

test('stamping takes the same row lock as the correction', async () => {
  const { stampWcCouponDiscountModel } = await load()
  reset()

  await stampWcCouponDiscountModel(makeTx(makeStore()), entry)

  assert.deepEqual(locked, ['order-1'])
  assert.equal(events[0], 'lock:order-1')
})

// ---------------------------------------------------------------------------
// stampOnly re-verifies the WHOLE evidence set (o3d-y14 r3 finding 3)
//
// The stamp is the single most irreversible write this script makes. A correction leaves the row
// re-proposable, because a later report reads the amount and re-derives it; a stamp is precisely
// what excludes the row from every future run, so a stamp on the wrong row is permanent. And the
// assertion being recorded — "this amount is ALREADY only the residual" — is a claim about the
// amount RELATIVE TO THE LINES, so the amount matching on its own does not establish it.
// ---------------------------------------------------------------------------

test('stamping is refused when the LINE discounts moved since the review (o3d-y14 r3 F3)', async () => {
  // The gap the amount check cannot see: `discountAmount` is still the 6 the reviewer approved, but
  // the lines now carry 6 instead of 4, so the residual they asserted (2) is no longer what this row
  // holds. Stamping here records a false assertion that no later run can revisit.
  const { stampWcCouponDiscountModel } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 6 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), {
    ...entry,
    storedOrderDiscount: 6,
    lineDiscountTotal: 4,
    keptOrderLevel: 2,
    clearedBy: 4,
  })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LINES_CHANGED')
  assert.match(result.outcome === 'DECLINED' ? result.detail : '', /now carry 6/)
  assert.equal(store.orders[0].discountModel, null, 'nothing is stamped, so the next report re-proposes it')
  assert.equal(store.orders[0].discountAmount, 6, 'and nothing monetary is touched either')
  assert.equal(store.activity.length, 0)
})

test('stamping is refused when the IMPORT timestamp moved since the review (o3d-y14 r3 F3)', async () => {
  // The import timestamp is the provenance the reviewer dated the assertion against. A re-link or
  // re-import makes their dating describe a different row.
  const { stampWcCouponDiscountModel } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'IMPORT_CHANGED')
  assert.equal(store.orders[0].discountModel, null)
  assert.equal(store.activity.length, 0)
})

test('stamping still succeeds when the whole evidence set matches (o3d-y14 r3 F3 control)', async () => {
  // Without this, the two refusals above would pass on a stamp path that refuses everything — which
  // would silently disable the "already correct" half of the workflow and push those rows back
  // towards the destructive one.
  const { stampWcCouponDiscountModel, WC_COUPON_DISCOUNT_MODEL } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), {
    ...entry,
    storedOrderDiscount: 6,
    lineDiscountTotal: 4,
    keptOrderLevel: 2,
    clearedBy: 4,
  })

  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(store.orders[0].discountModel, WC_COUPON_DISCOUNT_MODEL)
  assert.equal(store.orders[0].discountAmount, 6)
  assert.equal(store.activity[0].metadata.lineDiscountTotal, 4, 'the LIVE line total is what is recorded')
})

// ---------------------------------------------------------------------------
// The posted-but-unlinked state is REVIEWABLE (o3d-y14 r3 finding 2)
//
// o3d-9kek: a post succeeds and its back-reference write fails, leaving a real Xero document and a
// NULL accountingInvoiceId. The previous revision refused any such row and the report — which read
// only the column — re-proposed it with identical evidence on every run. The row could never be
// applied and never be seen to be stuck, and the operator's only route was a separate repair they
// had no reason to know existed.
// ---------------------------------------------------------------------------

const UNLINKED_SYNCED_INVOICE = {
  id: 'job-1',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  type: 'SALES_INVOICE',
  status: 'SYNCED',
  externalTransactionId: 'INV-999',
}

// ---------------------------------------------------------------------------
// o3d-y14 r6 finding 1 — the REFUND position is read live, from both sources
// ---------------------------------------------------------------------------

/** A credit note that POSTED and never wrote its id onto the refund — o3d-9kek on the refund side. */
const UNLINKED_SYNCED_CREDIT_NOTE = {
  id: 'job-cn-1',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  type: 'CREDIT_NOTE',
  status: 'SYNCED',
  externalTransactionId: 'CN-501',
}

test('a posted credit note the refund row denies is still read (o3d-y14 r6 F1)', async () => {
  // `accountingCreditNoteId` is NULL and the credit note is in the ledger anyway. Reading only the
  // column would report this order as carrying no credit note — and an order carrying no credit
  // note gets a remedy prescribed for it.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ syncLogs: [UNLINKED_SYNCED_CREDIT_NOTE] })
  store.orders[0].refundStatus = 'FULL'
  store.orders[0].refunds = [{ id: 'refund-1', accountingCreditNoteId: null }]

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    refunds: { disposition: 'FULL', refundIds: ['refund-1'], postedCreditNoteExternalIds: ['CN-501'], unresolvedRefundParkExternalIds: [] },
  })

  assert.equal(result.outcome, 'CORRECTED')
  assert.deepEqual(result.outcome === 'CORRECTED' ? result.posted?.refunds : null, {
    disposition: 'FULL',
    refundIds: ['refund-1'],
    postedCreditNoteExternalIds: ['CN-501'],
  unresolvedRefundParkExternalIds: [],
  })
  assert.equal(store.activity[0].metadata.refunded, true)
  assert.match(
    (store.activity[0].metadata.handoffLines as string[]).join('\n'),
    /NO REMEDY IS PRESCRIBED/,
    'and a refunded order gets no prescribed remedy, whatever its invoice says',
  )
})

test('a credit note with NO invoice evidence still produces a handoff (o3d-y14 r6 F1)', async () => {
  // The trigger for classifying the ledger at all used to be invoice-or-deferral only. An order can
  // carry a posted CREDIT NOTE and no invoice evidence whatever — the back-reference never written,
  // the sync row pruned — and the refunded order this refusal exists for would then be corrected
  // with nothing said about the ledger at all.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ syncLogs: [UNLINKED_SYNCED_CREDIT_NOTE] })
  store.orders[0].accountingInvoiceId = null
  store.orders[0].refundStatus = 'FULL'
  store.orders[0].refunds = [{ id: 'refund-1', accountingCreditNoteId: null }]

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    refunds: { disposition: 'FULL', refundIds: ['refund-1'], postedCreditNoteExternalIds: ['CN-501'], unresolvedRefundParkExternalIds: [] },
  })

  assert.equal(result.outcome, 'CORRECTED')
  assert.notEqual(result.outcome === 'CORRECTED' ? result.handoff : null, null, 'the ledger IS classified')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.invoice.case, 'NO_INVOICE_IN_LEDGER')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.needsAccountingAction, true)
  assert.equal(store.activity[0].metadata.posted, true)
  assert.match((store.activity[0].metadata.handoffLines as string[]).join('\n'), /CN-501/)
})

test('an order with NO refunds never queries for a credit note (o3d-y14 r6 F1)', async () => {
  // The cost of the new read is bounded by the refunded orders, not by the run: nearly every
  // candidate is unrefunded, and for those this issues no statement at all.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(
    events.filter((event) => event.startsWith('findMany:')),
    ['findMany:SalesOrder:order-1'],
    'the invoice read, and nothing keyed on SalesOrderRefund',
  )
})

test('an unlinked posted invoice the reviewer SAW is applied, not refused forever (o3d-y14 r3 F2)', async () => {
  // The recovery path, end to end: the first run refused because the report had not shown the
  // document; the re-run reports it, the reviewer approves the row WITH it, and this is that apply.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ syncLogs: [UNLINKED_SYNCED_INVOICE] })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    postedInvoiceExternalIds: ['INV-999'],
  })

  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(store.orders[0].discountAmount, 0)
  assert.deepEqual(result.outcome === 'CORRECTED' ? result.posted : null, {
    accountingInvoiceId: null,
    postedInvoiceExternalIds: ['INV-999'],
    revenueDeferredBatchRef: null,
    unearnedRevenueAmount: null,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
  })
  assert.equal(
    store.activity[0].metadata.posted,
    true,
    'and it is still on the manual-adjustment list — approving it is not pretending the document is fine',
  )
})

test('the SAME row reviewed as unposted is still refused (o3d-y14 r3 F2)', async () => {
  // The half that must not be lost: a document that appeared between review and apply is exactly
  // the race the check was added for. Only an UNCHANGED set is waved through.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ syncLogs: [UNLINKED_SYNCED_INVOICE] })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.match(result.outcome === 'DECLINED' ? result.detail : '', /INV-999/)
  assert.equal(store.orders[0].discountAmount, 10, 'and re-running the report re-proposes it WITH the invoice')
})

test('an invoice that VANISHED since the review is refused too (o3d-y14 r3 F2)', async () => {
  // The other direction, which a "reviewed set is a subset of live" check would wave through: the
  // reviewer approved a row whose ledger document they could see, and it is no longer there.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    postedInvoiceExternalIds: ['INV-999'],
  })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.equal(store.orders[0].discountModel, null)
})

test('the comparison is by SET, so query row order cannot cause a false refusal (o3d-y14 r3 F2)', async () => {
  // Neither Prisma nor PostgreSQL promises an order for either read. An ordered comparison would
  // refuse for a row-order difference, which reads to an operator exactly like a real posting change
  // and cannot be fixed by re-running.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { ...UNLINKED_SYNCED_INVOICE, id: 'job-b', externalTransactionId: 'INV-B' },
      { ...UNLINKED_SYNCED_INVOICE, id: 'job-a', externalTransactionId: 'INV-A' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    postedInvoiceExternalIds: ['INV-A', 'INV-B'],
  })

  assert.equal(result.outcome, 'CORRECTED')
})

// ---------------------------------------------------------------------------
// o3d-y14 r7 finding 1 — a PARKED WooCommerce refund, read by the LIVE collector
//
// A refund that arrived and could NOT be recorded writes no SalesOrderRefund, changes no
// refundStatus and posts no credit note, so every one of r6's three signals reads "not refunded" —
// while the money has already left the business. These orders are exactly where a wrong remedy is
// most likely (a quarantined refund is one IMS refused to post because it could not do so safely),
// and they used to receive the full "raise a further invoice" text.
//
// EVERY TEST HERE GOES THROUGH `applyWcCouponCorrection`, i.e. through the live collector, because
// the defect was in the collector and not in the classifier: r6's classifier tests injected evidence
// directly and would have passed unchanged with parks never read at all.
// ---------------------------------------------------------------------------

/**
 * An order whose invoice IS in the ledger and DOES carry the duplicate — the only shape that
 * produces a remedy at all, and therefore the only one on which "the remedy was suppressed" or
 * "the remedy was withdrawn" can be asserted at all.
 */
function invoicedStore(over: Partial<Store> = {}): Store {
  const store = makeStore(over)
  store.orders[0].accountingInvoiceId = 'INV-778'
  store.events = [
    {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: 'order-1',
      type: 'SALES_INVOICE',
      status: 'POSTED',
      currency: 'GBP',
      externalSystem: 'xero',
      externalId: 'INV-778',
      businessDate: '2026-05-02',
      createdAt: '2026-05-02T09:00:00.000Z',
      linesJson: {
        kind: 'accounting-document',
        schemaVersion: 1,
        documentType: 'SALES_INVOICE',
        currency: 'GBP',
        // The basis the builder always stamps. Production payloads carry it, so a fixture without it
        // would be testing a shape that does not occur (o3d-y14 r8 finding 1).
        lineAmountMode: 'EXCLUSIVE',
        lineAmountsIncludeTax: false,
        lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200' }],
        discount: { amount: 10, accountCode: '260' },
      },
      ...(over.events?.[0] ?? {}),
    },
  ]
  return store
}

const invoicedEntry = { ...entry, accountingInvoiceId: 'INV-778' }

const PARKED = { disposition: 'NONE' as const, refundIds: [] as string[], postedCreditNoteExternalIds: [] as string[], unresolvedRefundParkExternalIds: ['9001'] }

test('a QUARANTINED refund park makes the order REFUNDED, with no refund row at all (o3d-y14 r7 F1)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore({ parks: [park({ status: 'QUARANTINED' })] })

  const result = await applyWcCouponCorrection(makeTx(store), { ...invoicedEntry, refunds: PARKED })

  assert.equal(result.outcome, 'CORRECTED', 'the AMOUNT is still corrected — the coupon was duplicated either way')
  assert.deepEqual(result.outcome === 'CORRECTED' ? result.posted?.refunds.unresolvedRefundParkExternalIds : null, ['9001'])
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, true)
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.remedy, null)
  assert.deepEqual(store.activity[0].metadata.unresolvedRefundParkExternalIds, ['9001'])
  const lines = (store.activity[0].metadata.handoffLines as string[]).join('\n')
  assert.match(lines, /NO REMEDY IS PRESCRIBED/)
  assert.match(lines, /9001 ARRIVED AND COULD NOT BE RECORDED/)
  assert.doesNotMatch(lines, /Otherwise raise a further invoice/)
  assert.match(store.activity[0].description ?? '', /unrecorded WooCommerce refund\(s\) 9001/)
})

for (const status of ['PENDING', 'FAILED'] as const) {
  test(`a ${status} refund park counts as a refund too (o3d-y14 r7 F1)`, async () => {
    // All three actionable statuses mean the same thing for this decision — the refund is
    // UNRESOLVED and IMS holds no row for it. QUARANTINED is merely the longest-lived of them.
    const { applyWcCouponCorrection } = await load()
    reset()
    const store = invoicedStore({ parks: [park({ status })] })

    const result = await applyWcCouponCorrection(makeTx(store), { ...invoicedEntry, refunds: PARKED })

    assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, true)
    assert.equal(result.outcome === 'CORRECTED' && result.handoff?.remedy, null)
  })
}

test('a PARKED refund and NO refund produce DIFFERENT handoffs through the collector (o3d-y14 r7 F1)', async () => {
  // The fixture pair the finding turns on, at the level the defect lived. Identical stores except
  // for one row in `shopping_sync_logs`; if the two rendered the same classification the tests above
  // would prove nothing.
  const { applyWcCouponCorrection } = await load()

  reset()
  const parkedStore = invoicedStore({ parks: [park()] })
  const parked = await applyWcCouponCorrection(makeTx(parkedStore), { ...invoicedEntry, refunds: PARKED })

  reset()
  const cleanStore = invoicedStore()
  const clean = await applyWcCouponCorrection(makeTx(cleanStore), invoicedEntry)

  assert.equal(parked.outcome, 'CORRECTED')
  assert.equal(clean.outcome, 'CORRECTED')
  const parkedHandoff = parked.outcome === 'CORRECTED' ? parked.handoff : null
  const cleanHandoff = clean.outcome === 'CORRECTED' ? clean.handoff : null
  assert.notEqual(parkedHandoff?.refunded, cleanHandoff?.refunded)
  assert.notDeepEqual(parkedHandoff?.lines, cleanHandoff?.lines)
  assert.equal(parkedHandoff?.remedy, null)
  assert.equal(cleanHandoff?.remedy?.kind, 'INCREASE_RECEIVABLE', 'the unrefunded remedy is untouched')
})

test('a park on ANOTHER order is not this order\'s refund (o3d-y14 r7 F1)', async () => {
  // The index is keyed on (connector, externalId), so a park for a refund id can legitimately exist
  // against a different order. Counting it here would suppress a correct remedy forever.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore({ parks: [park({ entityId: 'order-2' })] })

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)

  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, false)
  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.remedy?.kind, 'INCREASE_RECEIVABLE')
})

test('a park that RESOLVED to SYNCED is no longer a refund signal (o3d-y14 r7 F1)', async () => {
  // `resolveActionableParks` flips a park to SYNCED once the refund lands. Counting SYNCED rows
  // would mean every order that ever had a retried refund stayed suppressed for good — and the
  // refund it became is picked up as a SalesOrderRefund row instead.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore({ parks: [park({ status: 'SYNCED' })] })

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)

  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, false)
})

test('an order-import failure log is not mistaken for a refund park (o3d-y14 r7 F1)', async () => {
  // `order-import.ts` writes FAILED rows with the same connector/direction/entityType and NO
  // entityId. The production predicate copies the partial unique index exactly — `entityId IS NOT
  // NULL` included — for precisely this reason.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore({ parks: [park({ status: 'FAILED', entityId: null })] })

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)

  assert.equal(result.outcome === 'CORRECTED' && result.handoff?.refunded, false)
})

test('a park that appeared SINCE the review is REFUSED, not silently re-classified (o3d-y14 r7 F1)', async () => {
  // Same argument as the refund-row drift check: the reviewer approved a row whose instruction was
  // "raise a further invoice", and on the parked version of that row the honest instruction is that
  // no remedy may be prescribed. Those are different decisions, so the reviewer makes the second.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore({ parks: [park()] })

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
  assert.match(result.outcome === 'DECLINED' ? result.detail : '', /unrecorded WooCommerce refund\(s\) \[9001\]/)
  assert.equal(store.orders[0].discountAmount, 10, 'and nothing was written')
  assert.equal(store.activity.length, 0)
})

test('a park that RESOLVED since the review is a change too (o3d-y14 r7 F1)', async () => {
  // The other direction. The reviewer saw an unrecorded refund; it has since landed as a real row
  // they never saw, and what the ledger holds for it is a different question from the one they
  // answered.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), { ...invoicedEntry, refunds: PARKED })

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(result.outcome === 'DECLINED' && result.reason, 'POSTING_CHANGED')
})

// ---------------------------------------------------------------------------
// o3d-y14 r7 finding 2 — a remedy that was true at commit and is not true now
// ---------------------------------------------------------------------------

test('a refund recorded AFTER the correction committed WITHDRAWS the remedy (o3d-y14 r7 F2)', async () => {
  // THE FINDING. The correction's lock is decisive for the moment the amount is rewritten and for
  // nothing after it. A refund taking the same lock the instant that transaction commits — before
  // the next order is even corrected, let alone before anything is printed — leaves "raise a further
  // invoice for 10 GBP" on the screen against a customer who has just been refunded.
  const { applyWcCouponCorrection, revalidateWcCouponHandoff } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  assert.equal(result.outcome, 'CORRECTED')
  const handoff = result.outcome === 'CORRECTED' ? result.handoff : null
  assert.equal(handoff?.remedy?.kind, 'INCREASE_RECEIVABLE')
  assert.match(handoff?.lines.join('\n') ?? '', /raise a further invoice to the same contact for 10 GBP/)

  // ... and now a refund lands, after the commit.
  store.orders[0].refundStatus = 'FULL'
  store.orders[0].refunds = [{ id: 'refund-1', accountingCreditNoteId: 'CN-501' }]
  store.syncLogs.push(UNLINKED_SYNCED_CREDIT_NOTE)

  const revalidated = await revalidateWcCouponHandoff(makeTx(store), 'order-1', handoff!)

  assert.equal(revalidated.outcome, 'SUPERSEDED')
  assert.equal(revalidated.handoff.remedy, null)
  assert.equal(revalidated.handoff.needsAccountingAction, true)
  const text = revalidated.handoff.lines.join('\n')
  assert.doesNotMatch(text, /raise a further invoice to the same contact for 10 GBP/)
  assert.match(text, /THE REMEDY PRINTED FOR THIS ORDER IS WITHDRAWN/)
  assert.match(text, /moved\s+AFTER the correction committed/)
  assert.match(text, /Post NOTHING on the strength of it/)
  assert.match(text, /invoice INV-778 carries an order-level discount of 10 GBP/, 'the FACTS survive')
})

test('a park that lands after the correction withdraws the remedy too (o3d-y14 r7 F1 + F2)', async () => {
  const { applyWcCouponCorrection, revalidateWcCouponHandoff } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  const handoff = result.outcome === 'CORRECTED' ? result.handoff : null
  store.parks = [park()]

  const revalidated = await revalidateWcCouponHandoff(makeTx(store), 'order-1', handoff!)

  assert.equal(revalidated.outcome, 'SUPERSEDED')
  assert.equal(revalidated.handoff.remedy, null)
})

test('an UNCHANGED position leaves the remedy exactly as it was (o3d-y14 r7 F2)', async () => {
  // The property that makes the withdrawal meaningful: if it fired regardless, "the remedy was
  // withdrawn" would carry no information and operators would learn to ignore it.
  const { applyWcCouponCorrection, revalidateWcCouponHandoff } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  const handoff = result.outcome === 'CORRECTED' ? result.handoff : null

  const revalidated = await revalidateWcCouponHandoff(makeTx(store), 'order-1', handoff!)

  assert.equal(revalidated.outcome, 'CURRENT')
  assert.deepEqual(revalidated.handoff.lines, handoff!.lines)
  assert.equal(revalidated.handoff.remedy?.kind, 'INCREASE_RECEIVABLE')
})

test('an order that VANISHED after the correction withdraws the remedy rather than vouching for it', async () => {
  const { applyWcCouponCorrection, revalidateWcCouponHandoff } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  const handoff = result.outcome === 'CORRECTED' ? result.handoff : null
  store.orders = []

  const revalidated = await revalidateWcCouponHandoff(makeTx(store), 'order-1', handoff!)

  assert.equal(revalidated.outcome, 'SUPERSEDED')
  assert.equal(revalidated.handoff.remedy, null)
})

test('the apply script REVALIDATES every handoff before it prints any of them (o3d-y14 r7 F2)', async () => {
  // A source assertion, because the ordering is the whole point: the previous shape corrected every
  // order first and printed at the end, so a refund landing during the loop was never looked for.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const revalidateAt = src.indexOf('revalidateWcCouponHandoff(db')
  const printAt = src.indexOf('printHandoff(entry, handoff)')
  assert.ok(revalidateAt > 0, 'the apply path revalidates')
  assert.ok(printAt > revalidateAt, 'and it does so BEFORE anything is printed')
  assert.match(src, /REMEDY WITHDRAWN/, 'and a withdrawal is reported, not silently swallowed')
})

// ---------------------------------------------------------------------------
// o3d-y14 r8 finding 4 — the revalidation's two promises, made true
// ---------------------------------------------------------------------------

/**
 * r7 promised that every remedy is re-validated "immediately before each handoff is printed" and
 * that "re-running the report reproduces the whole handoff". Neither held. The first was one pass
 * over every handoff followed, much later, by the printing; the second is impossible for exactly the
 * rows that carry a handoff, because a CORRECTED order is stamped and marked and therefore SKIPPED
 * by every later scan.
 */

test('a CORRECTED order is skipped by the report, so no report can reproduce its handoff (r8 F4)', async () => {
  // The premise of the finding, asserted rather than assumed: after apply, the decision for this
  // order is SKIP and the report only builds handoffs for CORRECT rows.
  const { applyWcCouponCorrection, decideWcCouponBackfill } = await load()
  reset()
  const store = invoicedStore()

  const result = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  assert.equal(result.outcome, 'CORRECTED')
  assert.equal(result.outcome === 'CORRECTED' && !!result.handoff, true, 'and it carried a handoff')

  const decision = decideWcCouponBackfill(
    {
      orderId: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: '1001',
      currency: 'GBP',
      storedOrderDiscount: store.orders[0].discountAmount,
      lineDiscountTotal: 10,
      accountingInvoiceId: 'INV-778',
      postedInvoiceExternalIds: [],
      discountModel: store.orders[0].discountModel,
      importedAt: new Date('2026-05-01T00:00:00.000Z'),
      // The ActivityLog marker apply just wrote.
      alreadyBackfilled: true,
      liveInvoiceJobs: 0,
      revenueDeferredBatchRef: null,
      liveBatchDeferralJobs: 0,
      refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
    },
    { importedBefore: new Date('2026-07-25T14:00:00.000Z') },
  )

  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'ALREADY_BACKFILLED')
})

test('REPRINT re-derives that same handoff from live state, after the correction (o3d-y14 r8 F4)', async () => {
  const { applyWcCouponCorrection, reprintWcCouponLedgerHandoff } = await load()
  reset()
  const store = invoicedStore()

  const applied = await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  const original = applied.outcome === 'CORRECTED' ? applied.handoff : null
  assert.ok(original)

  const reprinted = await reprintWcCouponLedgerHandoff(makeTx(store), { orderId: 'order-1', currency: 'GBP' })

  assert.equal(reprinted.outcome, 'REPRINTED')
  assert.equal(reprinted.outcome === 'REPRINTED' && reprinted.corrected, true)
  // The residual is taken from the CORRECTED column, not re-derived — re-deriving a corrected row is
  // the "10 -> 6 -> 2 -> 0" bug this whole script is built to avoid.
  assert.equal(reprinted.outcome === 'REPRINTED' && reprinted.keptOrderLevel, 0)
  // The remedy's precondition line stamps the moment the position was READ, so the two derivations
  // differ by whatever milliseconds separate them. That is the one thing that is SUPPOSED to differ
  // — it is the point of the line — so it is normalised out rather than the comparison weakened.
  const withoutReadAt = (lines: string[]) => lines.map((line) => line.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<at>'))
  assert.deepEqual(
    withoutReadAt(reprinted.outcome === 'REPRINTED' ? (reprinted.handoff?.lines ?? []) : []),
    withoutReadAt(original.lines),
    'the same handoff, from live state',
  )
  assert.match(
    (reprinted.outcome === 'REPRINTED' ? reprinted.handoff?.lines : [])?.join('\n') ?? '',
    /as read \d{4}-\d{2}-\d{2}T/,
    'and it stamps its OWN read time, not the one the correction recorded',
  )
  assert.match(
    reprinted.outcome === 'REPRINTED' ? reprinted.detail : '',
    /corrected by an earlier run .*IS the residual it retains/,
  )
})

test('REPRINT writes NOTHING and takes no lock — it is a query (o3d-y14 r8 F4)', async () => {
  const { applyWcCouponCorrection, reprintWcCouponLedgerHandoff } = await load()
  reset()
  const store = invoicedStore()

  await applyWcCouponCorrection(makeTx(store), invoicedEntry)
  const activityAfterApply = store.activity.length
  const amountAfterApply = store.orders[0].discountAmount
  events.length = 0
  locked.length = 0

  await reprintWcCouponLedgerHandoff(makeTx(store), { orderId: 'order-1', currency: 'GBP' })

  assert.deepEqual(locked, [], 'no row lock')
  assert.equal(store.activity.length, activityAfterApply, 'no ActivityLog row')
  assert.equal(store.orders[0].discountAmount, amountAfterApply, 'no write')
  assert.equal(events.some((event) => event.startsWith('updateMany')), false)
})

test('REPRINT on an UNCORRECTED order derives the residual a correction would keep (r8 F4)', async () => {
  // The other world: a declined entry, or a reprint run before apply. `discountAmount` is still the
  // duplicated coupon there, so the residual has to be re-derived exactly as apply re-derives it.
  const { reprintWcCouponLedgerHandoff } = await load()
  reset()
  const store = invoicedStore()

  const reprinted = await reprintWcCouponLedgerHandoff(makeTx(store), { orderId: 'order-1', currency: 'GBP' })

  assert.equal(reprinted.outcome === 'REPRINTED' && reprinted.corrected, false)
  assert.equal(reprinted.outcome === 'REPRINTED' && reprinted.keptOrderLevel, 0)
  assert.match(reprinted.outcome === 'REPRINTED' ? reprinted.detail : '', /has NOT been corrected/)
})

test('REPRINT on a deleted order says so rather than inventing a position', async () => {
  const { reprintWcCouponLedgerHandoff } = await load()
  reset()
  const store = invoicedStore()
  store.orders = []

  const reprinted = await reprintWcCouponLedgerHandoff(makeTx(store), { orderId: 'order-1', currency: 'GBP' })

  assert.equal(reprinted.outcome, 'ORDER_GONE')
})

test('the apply script re-validates PER PRINT, not once for the batch (o3d-y14 r8 F4)', async () => {
  // A source assertion, because the ORDERING is the whole property and no unit test of a pure
  // function can express it. r7's own test asserted only that SOME revalidation preceded SOME print,
  // which the batch-then-print shape satisfied while leaving order 1 re-read and printed an
  // unbounded number of queries apart.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const sectionAt = src.indexOf('async function printSection(')
  assert.ok(sectionAt > 0, 'printing goes through a section printer')
  const section = src.slice(sectionAt, src.indexOf('\n  }\n', sectionAt))
  assert.match(section, /revalidateWcCouponHandoff\(db, entry\.orderId, handoff\)/, 'which re-validates each entry')
  assert.match(section, /printHandoff\(entry, revalidated\.handoff\)/, 'and prints the RE-VALIDATED handoff')
  // Both lists go through it, so a "settled" entry is re-checked as hard as an actionable one.
  assert.match(src, /await printSection\(actionable\)/)
  assert.match(src, /await printSection\(settled\)/)
  // And an entry that moves after the two lists were decided is named again, because its heading
  // had already been written.
  assert.match(src, /movedWhilePrinting/)
  assert.match(src, /MOVE WHILE THIS REPORT/)
})

test('the script implements --reprint, and it cannot be combined with --apply (o3d-y14 r8 F4)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  assert.match(src, /parsedFlags\.flags\.reprint/)
  assert.match(src, /reprintWcCouponLedgerHandoff\(db/)
  assert.match(src, /--reprint is read-only and cannot be combined with --apply/)
})

test('the script reads the command line ONLY through the strict parser (o3d-y14 r9 F3)', async () => {
  // A SOURCE assertion, because the property is about the absence of a second reader. The mode
  // selection is decided by these flags, and the old `argv.indexOf(flag) + 1` helper turned
  // `--apply --reprint` into a WRITING run — a flag with nothing after it read as absent, so the
  // read-only branch that is checked first and made mutually exclusive with apply was never
  // entered. Re-introducing any ad-hoc argv read anywhere in this file re-opens that.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  assert.match(src, /parseWcCouponCliFlags\(process\.argv\.slice\(2\)\)/)
  assert.match(src, /REFUSING to run: \$\{parsedFlags\.detail\}/)
  // The one other `process.argv` use is the run-vs-import guard at the bottom of the file, which
  // reads argv[1] (the script path) and decides nothing about mode.
  const argvUses = src.match(/process\.argv/g) ?? []
  assert.equal(argvUses.length, 2, `the script reads process.argv ${argvUses.length} times, not 2`)
  assert.match(src, /process\.argv\[1\]\?\.includes\('backfill-wc-coupon-order-discount'\)/)
  assert.doesNotMatch(src, /function flagValue/, 'the reader that could not tell a flag from a value is gone')
  assert.doesNotMatch(src, /argv\.indexOf/)
  assert.doesNotMatch(src, /argv\.includes\('--apply'\)/)
})

test('every "re-derive this" sentence an operator reads names --reprint, not the report (r8 F4)', async () => {
  // The claim and the mechanism have to agree. Three separate places told the operator to re-run the
  // report for a position only --reprint can produce.
  const { wcCouponRemedySteps } = await import('@/lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff')

  const steps = wcCouponRemedySteps({
    kind: 'INCREASE_RECEIVABLE',
    amount: 4,
    currency: 'GBP',
    externalSystem: 'xero',
    documentRef: 'invoice INV-778',
    keptOrderLevel: 0,
    documentIsAllocated: true,
    nettedAgainst: ['CN-501'],
    validAgainst: { disposition: 'FULL', refundIds: ['refund-1'], postedCreditNoteExternalIds: ['CN-501'], unresolvedRefundParkExternalIds: [] },
    derivedAt: '2026-08-01T00:00:00.000Z',
  }).join('\n')

  assert.match(steps, /--reprint <allowlist>/)
  assert.doesNotMatch(steps, /re-running the report reproduces/)
})

// ---------------------------------------------------------------------------
// o3d-y14 r10 finding 1 — a superseded netting takes its CONCLUSION with it
// ---------------------------------------------------------------------------

/** A fully-refunded order whose credit note reversed exactly what the invoice discounted. */
function nettedToZeroStore(): Store {
  const store = invoicedStore()
  store.orders[0].refundStatus = 'FULL'
  store.orders[0].refunds = [{ id: 'refund-1', accountingCreditNoteId: 'CN-501' }]
  store.refundRows = [
    {
      id: 'refund-1',
      chargeback: true,
      totalsBasis: 'NET',
      accountingCreditNoteId: 'CN-501',
      lines: [
        { salesOrderLineId: 'line-1', totalBase: 100, totalForeign: 100, lineKind: 'sale' },
        { salesOrderLineId: null, totalBase: -10, totalForeign: -10, lineKind: 'discount' },
      ],
    },
  ]
  store.creditNoteEvents = [
    { sourceEntityId: 'refund-1', type: 'CREDIT_NOTE', status: 'POSTED', externalId: 'CN-501', externalSystem: 'xero' },
  ]
  return store
}

const NETTED_ZERO_REFUNDS = {
  disposition: 'FULL' as const,
  refundIds: ['refund-1'],
  postedCreditNoteExternalIds: ['CN-501'],
  unresolvedRefundParkExternalIds: [] as string[],
}

test('a refund landing after the correction WITHDRAWS the netted "nothing to do" too (o3d-y14 r10 F1)', async () => {
  // THE GAP. `withdrawRemedy` stripped the lines a `WcCouponRemedy` had rendered, and a netted-to-
  // ZERO order carries no remedy at all — so "THE TWO ERRORS CANCEL … there is NO ACCOUNTING ACTION"
  // survived every withdrawal, on the one outcome that takes an order off the operator's list. The
  // netting is a subtraction against the credit-note side, and a refund arriving afterwards is
  // exactly a change to that side.
  const { applyWcCouponCorrection, revalidateWcCouponHandoff } = await load()
  reset()
  const store = nettedToZeroStore()

  const result = await applyWcCouponCorrection(makeTx(store), { ...invoicedEntry, refunds: NETTED_ZERO_REFUNDS })
  assert.equal(result.outcome, 'CORRECTED')
  const handoff = result.outcome === 'CORRECTED' ? result.handoff : null
  assert.equal(handoff?.netPosition?.net, 0, 'the netting ran and came to zero')
  assert.equal(handoff?.needsAccountingAction, false)
  assert.match(handoff?.lines.join('\n') ?? '', /THE TWO ERRORS CANCEL/)

  // ... and now an unrecordable WooCommerce refund lands, after the commit.
  store.parks = [park()]

  const revalidated = await revalidateWcCouponHandoff(makeTx(store), 'order-1', handoff!)

  assert.equal(revalidated.outcome, 'SUPERSEDED')
  assert.equal(revalidated.handoff.netPosition, null, 'the netting no longer stands')
  assert.equal(revalidated.handoff.needsAccountingAction, true)
  const text = revalidated.handoff.lines.join('\n')
  assert.doesNotMatch(text, /THE TWO ERRORS CANCEL/)
  assert.doesNotMatch(text, /THE POSITION NETS/)
  assert.match(text, /THE NETTED CONCLUSION PRINTED FOR THIS ORDER IS WITHDRAWN/)
  assert.match(text, /do not file this order as settled/)
  // The FACTS survive, exactly as they do when a remedy is withdrawn.
  assert.match(text, /invoice INV-778 carries an order-level discount of 10 GBP/)
})

test('the netted position is recorded on the ActivityLog, so "nobody could tell" is not "square" (r10 F1)', async () => {
  // `creditNoteReversal.ok` does NOT answer whether the two sides were compared — a perfectly
  // derivable credit-note side can still have its subtraction withdrawn — so the log records the
  // netting itself, and NULL is the durable statement that it never ran.
  const { applyWcCouponCorrection } = await load()
  reset()
  const netted = nettedToZeroStore()
  await applyWcCouponCorrection(makeTx(netted), { ...invoicedEntry, refunds: NETTED_ZERO_REFUNDS })

  assert.deepEqual(netted.activity[0].metadata.netPosition, {
    postedDiscount: 10,
    reversedAmount: 10,
    net: 0,
    nettedAgainst: ['CN-501'],
  })

  // The SAME order with its credit note in another ledger: the subtraction is withdrawn, and the
  // log says so rather than recording a net nobody computed.
  reset()
  const crossLedger = nettedToZeroStore()
  crossLedger.creditNoteEvents = [
    { sourceEntityId: 'refund-1', type: 'CREDIT_NOTE', status: 'POSTED', externalId: 'CN-501', externalSystem: 'quickbooks' },
  ]
  await applyWcCouponCorrection(makeTx(crossLedger), { ...invoicedEntry, refunds: NETTED_ZERO_REFUNDS })

  assert.equal(crossLedger.activity[0].metadata.netPosition, null)
  assert.equal(crossLedger.activity[0].metadata.creditNoteReversal !== null, true, 'the credit-note side derived')
  assert.equal(crossLedger.activity[0].metadata.needsAccountingAction, true)
})
