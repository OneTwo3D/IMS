// o3d-clxw — AUTHORISED IS NOT "UNPAID".
//
// The poller's reversal passes used to read every ACCREC/ACCPAY invoice sitting at AUTHORISED as a
// payment REMOVAL. AUTHORISED is Xero's status for an approved invoice that is not FULLY paid, which
// a bill carrying a real PART payment satisfies — Xero only moves an invoice to PAID when the
// outstanding amount reaches zero.
//
// What followed on the BILL side was a duplicate supplier payment: paidAt was cleared, the activity
// log said the payment was "no longer present in Xero", and Mark Paid re-armed in the UI (it renders
// only while paidAt is null). markBillPaid sends no idempotency key and BILL_PAYMENT is outside every
// live-row dedupe, so the second press posts a second payment on top of the part payment.
//
// On the SALES side the same reading additionally raised an automatic chargeback credit note,
// unwinding recognised revenue against a payment the ledger was still holding.
//
// These tests drive the real poller over a mocked Xero and database.

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { XeroInvoice } from '@/lib/connectors/xero/invoice-delta'

type Row = Record<string, unknown>
type LoggedActivity = {
  entityType?: string
  entityId?: string | null
  action?: string
  tag?: string
  level?: string
  description?: string
  metadata?: Record<string, unknown>
}

const state = {
  invoices: [] as XeroInvoice[],
  salesOrders: [] as Row[],
  purchaseInvoices: [] as Row[],
  /** AccountingSyncLog rows: the BILL_PAYMENT / INVOICE_PAYMENT registrations IMS holds. */
  syncLogs: [] as Row[],
  /**
   * o3d-psrx: the LOCAL receipts IMS has recorded — the `Payment` rows `addPayment` writes in the
   * same transaction as the order's `paidAt`. A receipt here that no registration in `syncLogs`
   * names is the window between that commit and the registration being queued.
   */
  payments: [] as Row[],
  attempts: 0,
  activity: [] as LoggedActivity[],
  notifications: [] as { title?: string; message?: string; userId?: string | null }[],
  chargebacks: [] as string[],
  purchaseInvoiceUpdates: [] as { id: unknown; data: Row }[],
  /** o3d-a3wx: every registration retirement the bill-reversal transaction wrote. */
  syncLogUpdates: [] as { where: Row; data: Row }[],
  salesOrderUpdates: [] as { id: unknown; data: Row }[],
  /** Every cursor write the drain made. Empty means the chunk was NOT checkpointed. */
  settingUpserts: [] as unknown[],
  /** Set to make the activity-log / notification write REPORT failure, as the real ones do. */
  activityWriteFails: false,
  notificationWriteFails: false,
  // --- o3d-clxw round 4 -----------------------------------------------------
  /**
   * THE DATABASE'S clock, which is now the ONLY clock the reversal fence is allowed to read: the
   * poller selects `clock_timestamp()` from it before asking Xero, and the sync processor stamps
   * `synced_at` with it after posting a payment. Deliberately independent of whatever the poll HOST's
   * `new Date()` says — see withHostClockSkew.
   */
  dbClockSkewMs: 0,
  /** Make `SELECT clock_timestamp()` fail, so the poll has no ordering at all. */
  dbClockFails: false,
  /** Persisted activity rows, as `db.activityLog.findMany` would return them. */
  activityRows: [] as Row[],
  /** Invoices `Invoices?IDs=` returns to the withheld-reversal recheck. */
  recheckInvoices: [] as XeroInvoice[],
  /** Every `Invoices?IDs=` path the recheck asked for. */
  recheckFetches: [] as string[],
  /** Make the recheck's Xero read fail. */
  recheckFetchFails: false,
  /**
   * Make the REGISTRATION read fail — the database read inside the decision pass, the one that
   * answers "is our payment still there?". Transient by nature: a dropped connection, a pool
   * timeout, a statement cancelled under load (o3d-clxw round 5, finding 2).
   */
  registrationReadFails: false,
  /** Every raw statement the poll issued, so the SQL itself can be asserted about (round 6). */
  rawStatements: [] as string[],
}

/** The unpatched clock, so the database double keeps real time while a HOST clock is skewed. */
const RealDate = Date
const realNow = (): number => RealDate.now()

/** What `SELECT clock_timestamp()` (and the sync processor's `synced_at` stamp) would return. */
function databaseNow(offsetMs = 0): Date {
  // `realNow()` is the DATABASE's clock here — deliberately unaffected by whatever the host running
  // the poll believes the time is. Constructed through the ambient `Date` so the value still behaves
  // like one while withHostClockSkew has the constructor replaced.
  return new Date(realNow() + state.dbClockSkewMs + offsetMs)
}

/**
 * Run the poll on a HOST whose wall clock is `skewMs` out.
 *
 * This is the whole point of round 4: the sync processor and the payment poller run on different app
 * instances, and round 3 fenced a supplier payment on those two clocks agreeing. Every registration
 * stamp in these tests comes from `databaseNow()`, so skewing the poll host here reproduces exactly
 * the disagreement that used to decide whether a supplier got paid twice.
 */
async function withHostClockSkew<T>(skewMs: number, fn: () => Promise<T>): Promise<T> {
  class SkewedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() + skewMs)
      else super(...(args as ConstructorParameters<typeof RealDate>))
    }
    static now(): number { return realNow() + skewMs }
  }
  ;(globalThis as { Date: unknown }).Date = SkewedDate
  try {
    return await fn()
  } finally {
    ;(globalThis as { Date: unknown }).Date = RealDate
  }
}

function reset(): void {
  state.invoices = []
  state.salesOrders = []
  state.purchaseInvoices = []
  state.syncLogs = []
  state.payments = []
  state.rawStatements = []
  state.attempts = 0
  state.activity = []
  state.notifications = []
  state.chargebacks = []
  state.purchaseInvoiceUpdates = []
  state.syncLogUpdates = []
  state.salesOrderUpdates = []
  state.settingUpserts = []
  state.activityWriteFails = false
  state.notificationWriteFails = false
  state.dbClockSkewMs = 0
  state.dbClockFails = false
  state.activityRows = []
  state.recheckInvoices = []
  state.recheckFetches = []
  state.recheckFetchFails = false
  state.registrationReadFails = false
}

/** Just enough Prisma `where` to answer the poller's own queries honestly. */
function rowMatches(row: Row, where: Row | undefined): boolean {
  for (const [key, condition] of Object.entries(where ?? {})) {
    // The fixture holds manual orders only, so `shoppingLinks: { none: {} }` matches every row.
    if (key === 'shoppingLinks') continue
    const actual = row[key]
    if (condition === null) {
      if (actual != null) return false
      continue
    }
    if (typeof condition === 'object') {
      const c = condition as { in?: unknown[]; not?: unknown }
      if (Array.isArray(c.in) && !c.in.includes(actual)) return false
      if ('not' in c) {
        if (c.not === null ? actual == null : actual === c.not) return false
      }
      continue
    }
    if (actual !== condition) return false
  }
  return true
}

// Both real helpers SWALLOW their write failures and report them through the *Persisted variants —
// the doubles do the same, so a test can make the write fail without making the call throw.
function recordActivity(entry: LoggedActivity): void {
  state.activity.push(entry)
  // The activity log is not just a firehose here: the withheld-reversal recheck reads its own
  // warnings back as the work queue, so the double has to PERSIST them the way the real one does.
  state.activityRows.push({
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    action: entry.action ?? '',
    tag: entry.tag ?? '',
    createdAt: databaseNow(),
  })
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { if (!state.activityWriteFails) recordActivity(entry) },
    logActivityPersisted: async (entry: LoggedActivity) => {
      if (state.activityWriteFails) return false
      recordActivity(entry)
      return true
    },
  },
})
mock.module('@/lib/notifications', {
  namedExports: {
    notify: async (n: { title?: string; message?: string }) => { if (!state.notificationWriteFails) state.notifications.push(n) },
    notifyPersisted: async (n: { title?: string; message?: string }) => {
      if (state.notificationWriteFails) return false
      state.notifications.push(n)
      return true
    },
  },
})
mock.module('@/lib/connectors/xero/payment-write-lock', {
  namedExports: {
    withPaymentWriteLockOrSkip: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    isLockSkipped: () => false,
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroHttpAttemptCount: () => state.attempts,
    xeroGet: async (path: string) => {
      state.attempts += 1
      // The withheld-reversal recheck asks for specific invoices by id, precisely because they will
      // never come back through the modified-since delta on their own.
      if (typeof path === 'string' && path.startsWith('Invoices?IDs=')) {
        state.recheckFetches.push(path)
        if (state.recheckFetchFails) return { ok: false, status: 503, error: 'Xero unavailable' }
        const ids = path.slice('Invoices?IDs='.length).split(',')
        return { ok: true, status: 200, data: { Invoices: state.recheckInvoices.filter((i) => ids.includes(i.InvoiceID)) } }
      }
      // One short page: walkPages treats it as the last, so the whole window is one chunk.
      return { ok: true, status: 200, data: { Invoices: state.invoices } }
    },
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    raiseChargebackForReversedOrder: async (orderId: string) => {
      state.chargebacks.push(orderId)
      return { raised: true }
    },
  },
})
/**
 * Hoisted out of the `mock.module` call so it can hand ITSELF to `$transaction` (o3d-a3wx).
 *
 * The bill-reversal pass is now one interactive transaction — the paidAt clear and the registration
 * retirement commit together or not at all — and a double with no `$transaction` throws inside the
 * pass, which the poller catches and records as a polling error. Every reversal in this file then
 * "fails" for a reason that has nothing to do with what it asserts.
 */
const dbDouble: Record<string, unknown> = {
  // Two raw statements reach this double, and it answers the one it was actually asked.
  //
  //  - `SELECT clock_timestamp() AT TIME ZONE 'UTC'` — the fence end of the ordering. Answers
  //    from the DATABASE clock, never from whatever `new Date()` says on the host running the
  //    poll.
  //  - the withheld-marker scan, which GROUPS the activity log per document and computes BOTH
  //    aggregates — each document's last open marker and its last closure — then keeps only the
  //    documents whose latest marker across the two is an open one, and only then applies the
  //    bound. All three of those are the fix (round 6, finding 2), so all three are computed
  //    here for real: a double that returned rows, or that filtered after slicing, would make
  //    the starvation tests vacuous exactly as a row-returning double did in round 5.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? [...strings].join('?') : String(strings)
    state.rawStatements.push(sql)
    if (sql.includes('clock_timestamp()')) {
      if (state.dbClockFails) throw new Error('database clock unavailable')
      return [{ fence: databaseNow() }]
    }
    if (!sql.includes('activity_logs')) throw new Error(`unexpected raw statement: ${sql}`)
    // The statement binds its horizon as an explicit UTC instant and renders both aggregates as
    // explicit UTC strings, because the column is TIMESTAMP WITHOUT TIME ZONE; the double
    // answers in the same shapes, so the production side's parsing is exercised rather than
    // bypassed.
    const [openActions, closedActions, allActions, horizonIso, limit] =
      values as [string[], string[], string[], string, number]
    const horizon = new Date(horizonIso)
    const groups = new Map<string, { entityType: unknown; entityId: string; openMax: Date | null; closedMax: Date | null }>()
    for (const row of state.activityRows) {
      if (row.tag !== 'sync') continue
      if (!allActions.includes(row.action as string)) continue
      if (row.entityId == null) continue
      const at = row.createdAt as Date
      if (at.getTime() < horizon.getTime()) continue
      const key = `${String(row.entityType)}:${String(row.entityId)}`
      const held = groups.get(key)
        ?? { entityType: row.entityType, entityId: row.entityId as string, openMax: null, closedMax: null }
      if (openActions.includes(row.action as string) && (held.openMax == null || held.openMax.getTime() < at.getTime())) held.openMax = at
      if (closedActions.includes(row.action as string) && (held.closedMax == null || held.closedMax.getTime() < at.getTime())) held.closedMax = at
      groups.set(key, held)
    }
    return [...groups.values()]
      .filter((g) => g.openMax != null && (g.closedMax == null || g.openMax.getTime() > g.closedMax.getTime()))
      .sort((a, b) => a.openMax!.getTime() - b.openMax!.getTime())
      .slice(0, limit)
      .map((g) => ({
        entityType: g.entityType,
        entityId: g.entityId,
        openMax: g.openMax!.toISOString(),
        closedMax: g.closedMax?.toISOString() ?? null,
      }))
  },
  activityLog: {
    // The pre-round-5 scan: marker ROWS, ordered and bounded as rows. Production does not call
    // this any more — it is kept because it is the harness the starvation test's revert evidence
    // needs, and a double that cannot run the old query cannot show what the old query did.
    findMany: async (
      { where, take, orderBy }:
      { where: Row; take?: number; orderBy?: { createdAt?: 'asc' | 'desc' } },
    ) => {
      const actions = (where.action as { in?: string[] } | undefined)?.in ?? null
      const since = (where.createdAt as { gte?: Date } | undefined)?.gte ?? null
      const direction = orderBy?.createdAt === 'asc' ? 1 : -1
      return state.activityRows
        .filter((r) => (where.tag == null || r.tag === where.tag))
        .filter((r) => (actions == null || actions.includes(r.action as string)))
        .filter((r) => r.entityId != null)
        .filter((r) => since == null || (r.createdAt as Date).getTime() >= since.getTime())
        .sort((a, b) => direction * ((a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()))
        .slice(0, take ?? undefined)
    },
    // Prisma's groupBy, reduced to what the withheld-marker scan asked of it BEFORE round 6:
    // one entry per document, ordered by an aggregate of its markers, bounded in DOCUMENTS.
    // Production does not call this any more either — the two grouped queries were the reason
    // the bound had to be spent before the closures were known (finding 2) — and it is kept for
    // the same reason `findMany` is: the revert evidence for the round-6 test needs to be able
    // to run the round-5 query. It really groups —
    // a double that returned rows and called them groups would make the starvation test vacuous,
    // because grouping is the entire fix (o3d-clxw round 5, finding 3). BOTH `_max` and `_min`
    // are computed and either may be ordered on, because WHICH aggregate the scan reads is
    // itself one of the things under test: `_min` would time a document from its FIRST marker,
    // which is the history-reading the round robin exists to stop.
    groupBy: async (
      { where, orderBy, take }:
      {
        by: string[]
        where: Row
        orderBy?: { _max?: { createdAt?: 'asc' | 'desc' }; _min?: { createdAt?: 'asc' | 'desc' } }
        take?: number
      },
    ) => {
      const actions = (where.action as { in?: string[] } | undefined)?.in ?? null
      const since = (where.createdAt as { gte?: Date } | undefined)?.gte ?? null
      const onlyIds = (where.entityId as { in?: string[] } | undefined)?.in ?? null
      const orderKey = orderBy?._min ? '_min' as const : '_max' as const
      const direction = (orderBy?._max?.createdAt ?? orderBy?._min?.createdAt) === 'asc' ? 1 : -1
      const groups = new Map<string, { entityType: unknown; entityId: unknown; _max: { createdAt: Date }; _min: { createdAt: Date } }>()
      for (const row of state.activityRows) {
        if (where.tag != null && row.tag !== where.tag) continue
        if (actions != null && !actions.includes(row.action as string)) continue
        if (row.entityId == null) continue
        if (onlyIds != null && !onlyIds.includes(row.entityId as string)) continue
        const at = row.createdAt as Date
        if (since != null && at.getTime() < since.getTime()) continue
        const key = `${String(row.entityType)}:${String(row.entityId)}`
        const held = groups.get(key)
        if (!held) {
          groups.set(key, { entityType: row.entityType, entityId: row.entityId, _max: { createdAt: at }, _min: { createdAt: at } })
          continue
        }
        if (held._max.createdAt.getTime() < at.getTime()) held._max = { createdAt: at }
        if (held._min.createdAt.getTime() > at.getTime()) held._min = { createdAt: at }
      }
      return [...groups.values()]
        .sort((a, b) => direction * (a[orderKey].createdAt.getTime() - b[orderKey].createdAt.getTime()))
        .slice(0, take ?? undefined)
    },
  },
  setting: {
    findUnique: async () => ({ key: 'xero_last_payment_poll', value: new Date(Date.now() - 60_000).toISOString() }),
    upsert: async (args: unknown) => { state.settingUpserts.push(args); return {} },
  },
  user: { findMany: async () => [{ id: 'admin_1' }] },
  salesOrderRefund: { findFirst: async () => null },
  salesOrder: {
    findMany: async ({ where }: { where: Row }) => state.salesOrders.filter((r) => rowMatches(r, where)),
    updateMany: async () => ({ count: 0 }),
    update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
      state.salesOrderUpdates.push({ id: where.id, data })
      return {}
    },
  },
  accountingSyncLog: {
    findMany: async ({ where }: { where: Row }) => {
      // The real one throws; `processDeltaChunk` catches it and records the failure on the poll
      // result rather than letting it escape.
      if (state.registrationReadFails) throw new Error('connection terminated unexpectedly')
      return state.syncLogs.filter((r) => rowMatches(r, where))
    },
    // o3d-a3wx: the bill-reversal transaction RETIRES the registrations the ledger has just
    // disproved. Without this the retirement throws a TypeError, the poller records it as a polling
    // error, and every reversal in this file silently stops happening.
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      state.syncLogUpdates.push({ where, data })
      const ids = (where.id as { in?: string[] } | undefined)?.in ?? null
      let count = 0
      for (const row of state.syncLogs) {
        if (ids != null && !ids.includes(row.id as string)) continue
        if (ids == null && !rowMatches(row, where)) continue
        Object.assign(row, data)
        count++
      }
      return { count }
    },
  },
  // o3d-psrx: the receipts the sales residual reading now consults. A bill has none, which is why
  // this is only ever asked about sales orders.
  payment: {
    findMany: async ({ where }: { where: Row }) => state.payments.filter((r) => rowMatches(r, where)),
  },
  purchaseInvoice: {
    findMany: async ({ where }: { where: Row }) => state.purchaseInvoices.filter((r) => rowMatches(r, where)),
    update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
      state.purchaseInvoiceUpdates.push({ id: where.id, data })
      return {}
    },
  },
}

// An INTERACTIVE transaction hands the callback a client; this double is that client, so a write made
// on `tx` lands in the same recorded state as one made on `db`. Rollback is not modelled: no test here
// asserts on a failed transaction, and pretending to roll back would be a second, wrong answer.
dbDouble.$transaction = async (fn: (tx: unknown) => unknown) => fn(dbDouble)

mock.module('@/lib/db', { namedExports: { db: dbDouble } })

async function poll(hostClockSkewMs = 0) {
  const { pollXeroPayments } = await import('@/lib/connectors/xero/payment-poller')
  return hostClockSkewMs === 0
    ? pollXeroPayments()
    : withHostClockSkew(hostClockSkewMs, () => pollXeroPayments())
}

function bill(overrides: Partial<XeroInvoice> = {}): XeroInvoice {
  return { InvoiceID: 'XB1', Type: 'ACCPAY', Status: 'AUTHORISED', ...overrides }
}

function paidBillRow(): Row {
  return {
    id: 'pi_1',
    accountingInvoiceId: 'XB1',
    paidAt: new Date('2026-08-01T00:00:00.000Z'),
    poId: 'po_1',
    po: { reference: 'PO-0001', status: 'RECEIVED' },
  }
}

function paidOrderRow(): Row {
  return {
    id: 'so_1',
    accountingInvoiceId: 'XS1',
    paidAt: new Date('2026-08-01T00:00:00.000Z'),
    orderNumber: 'SO-0001',
    externalOrderNumber: null,
    status: 'SHIPPED',
    refundStatus: 'NONE',
    revenueDeferredDate: new Date('2026-07-01T00:00:00.000Z'),
  }
}

const clearedPaidAt = (updates: { id: unknown; data: Row }[]) => updates.filter((u) => u.data.paidAt === null)

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

test('a PART-paid bill is not a reversal: paidAt is kept and Mark Paid is not re-armed (o3d-clxw)', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'the ledger still holds a payment, so paidAt must not be cleared — clearing it re-arms Mark Paid over a payment already made')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.ok(withheld, 'the disagreement must be reported, not swallowed')
  assert.equal(withheld.level, 'WARNING')
  assert.match(withheld.description ?? '', /PART payment, NOT a reversal/)
  assert.match(withheld.description ?? '', /pay the supplier twice/)
  assert.match(withheld.description ?? '', /400\.00/)
  assert.match(withheld.description ?? '', /100\.00/)
  assert.equal(withheld.metadata?.reason, 'part-payment')
  assert.equal(withheld.metadata?.amountPaid, 400)

  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'), false,
    'nothing was reversed, so nothing may be logged as "no longer present in Xero"')
})

test('a bill whose payment really is gone (nothing paid in the ledger) is still reversed', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)
  assert.ok(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'))
})

test('a VOIDED bill is reversed even though it states no amounts', async () => {
  reset()
  // Xero requires payments to be removed before an invoice can be voided, and refuses a payment
  // against a voided one — so re-arming here cannot move money twice.
  state.invoices = [bill({ Status: 'VOIDED' })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
})

test('an AUTHORISED bill that states no AmountPaid withholds the verdict rather than guessing', async () => {
  reset()
  state.invoices = [bill({ AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'unknown must not read as "the payment is gone" on a path whose next step pays a supplier')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'amount-not-stated')
  assert.match(withheld?.description ?? '', /did not state how much has been paid/)
})

test('an AUTHORISED bill IMS does not hold as paid is not reported at all', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100 })]
  state.purchaseInvoices = [{ ...paidBillRow(), paidAt: null }]

  const result = await poll()

  assert.equal(result.billReversalsWithheld, 0, 'an ordinary unpaid bill sitting at AUTHORISED is not a disagreement')
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld'), false)
})

// ---------------------------------------------------------------------------
// Sales — the same reading, and it drives a chargeback as well as clearPaidAt
// ---------------------------------------------------------------------------

test('a PART-paid sales invoice raises NO chargeback and keeps paidAt (o3d-clxw)', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 90, AmountDue: 10 }]
  state.salesOrders = [paidOrderRow()]

  const result = await poll()

  assert.deepEqual(state.chargebacks, [],
    'the ledger is still holding the payment, so unwinding revenue against it would be a wrong credit note')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [])
  assert.equal(result.salesReversed, 0)
  assert.equal(result.salesReversalsWithheld, 1)
  assert.equal(state.notifications.some((n) => n.title === 'Payment reversal detected'), false,
    'no "payment reversal detected" alert for a payment that is present')
  assert.equal(state.notifications.filter((n) => n.title === 'Payment reversal withheld').length, 1,
    'the disagreement itself IS alerted — an activity row in a firehose is a record, not an alert (o3d-clxw r2)')

  const withheld = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.ok(withheld)
  assert.match(withheld.description ?? '', /NO chargeback credit note was raised/)
  assert.match(withheld.description ?? '', /PART payment, NOT a reversal/)
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_detected'), false)
})

test('a sales invoice whose payment really is gone is still reversed and charged back', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100 }]
  state.salesOrders = [paidOrderRow()]

  const result = await poll()

  assert.deepEqual(state.chargebacks, ['so_1'])
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates).map((u) => u.id), ['so_1'])
  assert.equal(result.salesReversed, 1)
  assert.equal(result.salesReversalsWithheld, 0)
  assert.equal(state.notifications.length, 1)
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 2 — WHOSE PAYMENT IS GONE?
//
// Round 1 asked "does the ledger hold ANY payment". A residual payment somebody applied in Xero
// AFTER deleting the one IMS registered answers yes, so the reversal was withheld for ever: the
// supplier payment IMS believes it made is gone, the cursor moves past the invoice, and the bill
// reads settled until a human happens to reconcile it.
// ---------------------------------------------------------------------------

/**
 * A registration written by the CURRENT build: `syncedAt` and its provenance marker are the same
 * instant, because one statement stamped both from one reading of `clock_timestamp()` (round 5).
 * A row that models an OLD build overrides `syncedAtDatabaseClock` explicitly.
 */
function databaseStamped(row: Row): Row {
  return { syncedAtDatabaseClock: row.syncedAt, ...row }
}

/** A BILL_PAYMENT registration IMS holds against bill pi_1. */
function billRegistration(overrides: Row = {}): Row {
  return databaseStamped({
    id: 'log_1',
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi_1',
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS',
    // Stamped by `clock_timestamp()` in the sync processor's own transaction (round 4).
    syncedAt: databaseNow(-5 * 60_000),
    ...overrides,
  })
}

function salesRegistration(overrides: Row = {}): Row {
  return databaseStamped({
    id: 'log_s1',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    status: 'SYNCED',
    externalTransactionId: 'PAY-OURS-S',
    // Stamped by `clock_timestamp()` in the sync processor's own transaction (round 4).
    syncedAt: databaseNow(-5 * 60_000),
    ...overrides,
  })
}

test('OUR supplier payment deleted with a smaller one left behind IS a reversal, not a part payment (o3d-clxw r2)', async () => {
  reset()
  // IMS registered 500 (payment PAY-OURS). Somebody in Xero deleted it and applied 20 of their own.
  // Round 1 reads AmountPaid 20 as "a payment is present" and keeps paidAt for ever.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'],
    'the payment IMS registered is not among the payments Xero lists, so it is gone and paidAt must be cleared')
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)

  const detected = state.activity.find((a) => a.action === 'bill_payment_reversal_detected')
  assert.ok(detected, 'the reversal must be logged')
  assert.match(detected.description ?? '', /PAY-OURS/)
  assert.match(detected.description ?? '', /still shows 20\.00 paid/)
  assert.match(detected.description ?? '', /residual payment is somebody else's/)
})

test('a residual payment that IS ours is still a part payment: paidAt kept, and the warning says whose it is', async () => {
  reset()
  // Xero lists our payment, so the shortfall is a genuine part payment (the bill was edited upward).
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'our payment is still in the ledger — clearing paidAt would re-arm Mark Paid over money already sent')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.registrationVerdict, 'STILL_HELD')
  assert.match(withheld?.description ?? '', /payment IMS registered \(PAY-OURS\) is still among the payments/)
})

test('a registration that finished AFTER the Xero read cannot be declared gone by it', async () => {
  reset()
  // The Mark Paid race: paidAt is set locally at once, the worker posts the payment a few seconds
  // later. A read taken in between lists a payment that is not ours and does not list ours YET —
  // and declaring a reversal there re-arms Mark Paid over a payment that was just made.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ syncedAt: databaseNow(60_000) })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'a registration this read cannot speak for withholds the verdict — the next press of Mark Paid pays a supplier')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.match(withheld?.description ?? '', /log_1/)
})

test('an in-flight (PROCESSING) registration withholds the verdict too', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
})

test('a payload that does not list the payments cannot prove ours is absent', async () => {
  reset()
  // No Payments array at all. Absent is not empty: reading it as "the ledger holds no payments" would
  // manufacture the proof, which is the Number('') === 0 mistake one field over.
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'LEDGER_DID_NOT_LIST_PAYMENTS')
})

test('a bill IMS never registered a payment for stays a part payment: IMS has no payment to be missing', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = []

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'NOTHING_REGISTERED')
})

test('OUR sales payment gone with a residual one left: paidAt clears but NO chargeback is raised', async () => {
  reset()
  state.invoices = [{
    InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 15, AmountDue: 85,
    Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }],
  }]
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [salesRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates).map((u) => u.id), ['so_1'],
    'the payment IMS registered is gone, so the order is not paid')
  assert.equal(result.salesReversed, 1)
  assert.deepEqual(state.chargebacks, [],
    'a chargeback unwinds the WHOLE recognised revenue, and the ledger is still holding 15 against this invoice')
  const detected = state.activity.find((a) => a.action === 'payment_reversal_detected')
  assert.match(detected?.description ?? '', /PAY-OURS-S/)
  assert.match(detected?.description ?? '', /NO chargeback credit note was raised automatically/)
  const alert = state.notifications.find((n) => n.title === 'Payment reversal detected')
  assert.match(alert?.message ?? '', /revenue was NOT unwound automatically/)
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 2 — A WITHHELD VERDICT THAT LEFT NO RECORD MUST NOT BE CHECKPOINTED PAST
//
// A withheld verdict writes nothing to the database; the warning is its only artefact. logActivity
// and notify both swallow their own write failures, so round 1 could count a verdict, write nothing,
// and let the drain move the cursor past an invoice the delta will never return again.
// ---------------------------------------------------------------------------

test('a withheld verdict whose warning did not reach the activity log holds the poll cursor', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]
  state.activityWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [],
    'checkpointing here loses the disagreement for good: the delta only returns an invoice when it CHANGES')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal: the activity warning could not be written/)
  assert.match(result.errors[0], /PO PO-0001/)
})

test('a withheld verdict whose operator alert did not land holds the poll cursor too', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]
  state.notificationWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal: the operator alert could not be written/)
})

test('a withheld verdict that WAS recorded checkpoints normally', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 400, AmountDue: 100, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(result.errors, [])
  assert.equal(state.settingUpserts.length, 1,
    'a recorded disagreement must not stall the poller — the cursor is held only when nothing was written')
  assert.equal(state.notifications.filter((n) => n.title === 'Bill payment reversal withheld').length, 1)
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 3 — AND AN IN-FLIGHT PAYMENT READS AS A ZERO
//
// This branch exists because a PART-paid bill read as a reversal. Round 1 replaced that with "the
// ledger holds nothing" — and a payment IMS posted moments ago, or is posting right now, also reads
// as nothing held. Mark Paid sets paidAt at once and queues a BILL_PAYMENT registration; until the
// worker posts it the ledger is empty. A poll landing in that gap cleared paidAt, re-armed the
// button over IMS's OWN payment, and the operator pressed it: markBillPaid sends no idempotency key,
// BILL_PAYMENT is outside every live-row dedupe, and Xero's own key expires after six minutes, so
// nothing anywhere refuses the second supplier payment.
// ---------------------------------------------------------------------------

test('a zero-paid bill whose payment is STILL ON THE WIRE is not reversed: Mark Paid stays disarmed (o3d-clxw r3)', async () => {
  reset()
  // Nothing paid in the ledger, and IMS is holding a PROCESSING registration — the request may be
  // in Xero's hands this instant.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'the zero is our own unposted payment, not a removal — clearing paidAt re-arms Mark Paid and pays the supplier twice')
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)

  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.ok(withheld, 'a withheld money verdict must leave a durable record')
  assert.equal(withheld.metadata?.reason, 'zero-paid-unproven')
  assert.equal(withheld.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.equal(withheld.metadata?.amountPaid, 0)
  assert.match(withheld.description ?? '', /NOTHING paid against it/)
  assert.match(withheld.description ?? '', /may be in flight/)
  assert.match(withheld.description ?? '', /idempotency key expires after six minutes/)
  assert.match(withheld.description ?? '', /log_1/)

  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'), false,
    'nothing was reversed, so nothing may be logged as "no longer present in Xero"')
  assert.equal(state.notifications.filter((n) => n.title === 'Bill payment reversal withheld').length, 1)
})

test('a zero-paid bill whose registration SYNCED after the Xero read is not reversed either', async () => {
  reset()
  // The exact Mark Paid race: paidAt set locally, the worker posts a few seconds later, and this read
  // was taken in between. Its emptiness says nothing about a payment created after it.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ syncedAt: databaseNow(60_000) })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
})

test('a zero-paid bill whose payment attempt FAILED is not reversed: a failure is not proof nothing posted', async () => {
  reset()
  // The processor posts BEFORE it persists the outcome, so a lost response is written down exactly
  // like a rejection. Re-arming here queues a replacement under a fresh entry id and therefore a
  // fresh Idempotency-Key, on top of a payment that may already exist.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'FAILED', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.match(withheld?.description ?? '', /cancel the sync entry named below by hand/)
})

test('a zero-paid bill whose registration POSTED before the read IS reversed: our payment really is gone', async () => {
  reset()
  // The counter-guard. The registration finished before Xero was asked and the ledger holds nothing,
  // so the payment IMS made has been removed and Mark Paid must be re-armed.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 0)
  assert.ok(state.activity.some((a) => a.action === 'bill_payment_reversal_detected'))
})

test('a zero-paid bill whose only registration is CANCELLED IS reversed: nothing of ours can be in flight', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'CANCELLED', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'],
    'CANCELLED is only ever asserted where nothing was sent — and it is the operator remedy for a stuck FAILED row')
  assert.equal(result.billsReversed, 1)
})

test('a zero-paid bill whose payload omits Payments[] IS reversed: a stated zero needs no list', async () => {
  reset()
  // LEDGER_DID_NOT_LIST_PAYMENTS blocks a RESIDUAL-paid invoice, where the list is the only way to
  // tell whose payment is there. Against a stated zero there is no money to attribute.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.billsReversed, 1)
})

test('a zero-paid SALES invoice with a payment in flight raises NO chargeback and keeps paidAt', async () => {
  reset()
  // The sales half of the same race: a credit note raised here unwinds recognised revenue against a
  // payment that is about to land.
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [salesRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(state.chargebacks, [], 'no credit note against a payment that has not landed yet')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [])
  assert.equal(result.salesReversed, 0)
  assert.equal(result.salesReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.match(withheld?.description ?? '', /NOTHING paid against it/)
  assert.match(withheld?.description ?? '', /wrong credit note/)
  assert.equal(state.notifications.some((n) => n.title === 'Payment reversal detected'), false)
})

test('a withheld zero-paid verdict that left no record holds the poll cursor', async () => {
  reset()
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]
  state.activityWriteFails = true

  const result = await poll()

  assert.deepEqual(state.settingUpserts, [],
    'checkpointing past an unsignalled disagreement loses it for good — the delta only returns an invoice when it CHANGES')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /left no durable signal/)
})

test('a zero-paid bill IMS does not hold as paid is neither reversed nor reported', async () => {
  reset()
  // An ordinary unpaid bill sitting at AUTHORISED with nothing paid is the commonest row in the
  // window. It must not become a withheld "disagreement" now that zero-paid rows reach the reading.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [{ ...paidBillRow(), paidAt: null }]
  state.syncLogs = [billRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.equal(result.billReversalsWithheld, 0)
  assert.equal(result.billsReversed, 0)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld'), false)
})

test('two bills on one Xero invoice: an in-flight payment on either holds BOTH', async () => {
  reset()
  // The promoted sets are keyed by INVOICE id while the verdicts are per DOCUMENT, and the reversal
  // pass selects on the invoice id. Admitting the clean bill would carry the withheld one's paidAt
  // away with it — a second supplier payment on the bill nobody could decide.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [] })]
  state.purchaseInvoices = [
    paidBillRow(),
    { ...paidBillRow(), id: 'pi_2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.syncLogs = [billRegistration({ id: 'log_2', referenceId: 'pi_2', status: 'PROCESSING', externalTransactionId: null, syncedAt: null })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
    'one undecidable document makes the whole invoice undecidable — pi_1 must not be reversed on pi_2 behalf')
  assert.equal(result.billsReversed, 0)
})

test('a ledger that lists our payment while stating nothing is paid withholds rather than guesses', async () => {
  reset()
  // Reachable: Xero can carry a payment in Payments[] that has since been deleted, so the aggregate
  // falls to zero while the id is still listed. IMS cannot settle that from one read, and an
  // unsettled contradiction is not proof of a removal.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500, Payments: [{ PaymentID: 'pay-ours' }] })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven')
  assert.equal(withheld?.metadata?.registrationVerdict, 'STILL_HELD')
  assert.match(withheld?.description ?? '', /while also stating that nothing has been paid/)
  assert.doesNotMatch(withheld?.description ?? '', /genuine PART payment/,
    'a zero has no reading as a part payment')
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 4 — AN ORDERING MUST NOT REST ON TWO HOSTS AGREEING
//
// Round 3's fence was `syncedAt < ledgerObservedBefore`, and both were application clocks: `syncedAt`
// came from `new Date()` on whichever instance ran the sync processor, `ledgerObservedBefore` from
// `new Date()` on whichever instance ran the poll. IMS runs more than one instance.
//
// One skew direction merely withholds. The other pays a supplier twice: with the poll host running
// ahead, a payment posted AFTER the ledger snapshot carries a stamp BELOW the fence, the fence calls
// it decided, its (correct) absence from the older snapshot reads as proof of removal, paidAt is
// cleared and Mark Paid re-arms over a payment that has already left the bank.
//
// Both ends are now `clock_timestamp()` from the SAME database, ordered by the poller's own program
// order — SELECT the fence, THEN ask Xero. These tests make the two hosts disagree by five minutes in
// BOTH directions and require the verdict to be identical, which is the only way to show that no host
// takes part in it.
// ---------------------------------------------------------------------------

const HOST_SKEWS: Array<[string, number]> = [
  ['the poll host runs five minutes FAST', 5 * 60_000],
  ['the poll host runs five minutes SLOW', -5 * 60_000],
]

test('a payment posted AFTER the ledger read stays undecided however the two hosts disagree (o3d-clxw r4)', async () => {
  for (const [label, skew] of HOST_SKEWS) {
    reset()
    // The database — the one clock either end is allowed to read — says the registration completed
    // THIRTY SECONDS AFTER the snapshot. The snapshot therefore cannot see the payment, and its
    // absence proves nothing whatsoever.
    state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
    state.purchaseInvoices = [paidBillRow()]
    state.syncLogs = [billRegistration({ syncedAt: databaseNow(30_000) })]

    const result = await poll(skew)

    assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [],
      `${label}: the payment landed after the read — clearing paidAt here re-arms Mark Paid over money already sent`)
    assert.equal(result.billsReversed, 0, label)
    assert.equal(result.billReversalsWithheld, 1, label)
    const withheld = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')
    assert.equal(withheld?.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED', label)
    assert.equal(withheld?.metadata?.reason, 'zero-paid-unproven', label)
  }
})

test('a payment posted BEFORE the ledger read stays decidable however the two hosts disagree (o3d-clxw r4)', async () => {
  for (const [label, skew] of HOST_SKEWS) {
    reset()
    // The mirror image: the database says the registration completed thirty seconds BEFORE the
    // snapshot, so the snapshot DOES speak for it — and it lists somebody else's payment, not ours.
    // Withholding here is the failure that hides a deleted supplier payment for ever.
    state.invoices = [bill({ AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })]
    state.purchaseInvoices = [paidBillRow()]
    state.syncLogs = [billRegistration({ syncedAt: databaseNow(-30_000) })]

    const result = await poll(skew)

    assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'], label)
    assert.equal(result.billsReversed, 1, label)
    assert.equal(result.billReversalsWithheld, 0, label)
    const detected = state.activity.find((a) => a.action === 'bill_payment_reversal_detected')
    assert.match(detected?.description ?? '', /PAY-OURS/, label)
  }
})

test('a poll that cannot read the database clock orders nothing, so every registration withholds', async () => {
  reset()
  // No fence, no ordering. The fail-closed reading of "no ordering" is that any registration might
  // have landed after the snapshot — including this one, which is five minutes old and would
  // otherwise be decidable.
  state.dbClockFails = true
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration()]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(
    state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
  assert.ok(result.errors.some((e) => /database clock could not be read/.test(e)),
    'losing the ordering is an error, not a silent downgrade')
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 4 — A WITHHELD VERDICT IS RECONSIDERED, NOT FILED AWAY
//
// A withheld reversal that WAS reported is checkpointed like any other outcome, and the delta only
// returns an invoice that CHANGES. What settles the question is usually not a change in Xero at all —
// it is IMS's own registration finishing, or an operator cancelling a FAILED one. Neither touches the
// invoice, so nothing ever puts it back in front of the poller.
// ---------------------------------------------------------------------------

function withheldMarker(overrides: Row = {}): Row {
  return {
    entityType: 'PURCHASE_ORDER',
    entityId: 'po_1',
    action: 'bill_payment_reversal_withheld',
    tag: 'sync',
    createdAt: databaseNow(-2 * 60 * 60_000),
    ...overrides,
  }
}

test('a withheld reversal is asked again on a timer, and a cancelled registration finally lets it through', async () => {
  reset()
  // NOTHING is in the delta: the invoice has not changed since it was withheld, and it never will.
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  // The operator cancelled the stuck registration, which is exactly what the withheld warning told
  // them to do. CANCELLED asserts nothing was sent, so the zero is now the whole story.
  state.syncLogs = [billRegistration({ status: 'CANCELLED', externalTransactionId: null, syncedAt: null })]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]

  const result = await poll()

  assert.equal(result.withheldRechecked, 1, 'the withheld verdict must be re-asked, not left filed')
  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB1'],
    'the invoice is read by ID precisely because it will never re-enter the modified-since delta')
  assert.equal(result.billsReversed, 1)
  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_1'])
  assert.equal(result.withheldResolved, 1)
  const cleared = state.activity.find((a) => a.action === 'bill_payment_reversal_withheld_cleared')
  assert.ok(cleared, 'a settled document must LEAVE the candidate set, not be re-scanned for ever')
  assert.equal(cleared.metadata?.resolution, 'settled')
})

test('a reversal that is still withheld has its marker rewritten, so it cannot hold the head of the queue', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  // A FAILED registration is not proof that nothing posted, so it withholds — and on its own it
  // withholds for ever, because it never becomes SYNCED.
  state.syncLogs = [billRegistration({ status: 'FAILED', externalTransactionId: null, syncedAt: null })]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]

  const result = await poll()

  assert.equal(result.withheldRechecked, 1)
  assert.equal(result.withheldResolved, 0, 'nothing was settled, so nothing may be closed')
  assert.equal(result.billsReversed, 0)
  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld_cleared'), false)
  const refreshed = state.activity.filter((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(refreshed.length, 1,
    'the marker is REWRITTEN, which restarts its timer and sends it to the back of the oldest-first page')
  assert.equal(refreshed[0]?.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.equal(state.notifications.filter((n) => n.title === 'Bill payment reversal withheld').length, 0,
    'the operator was alerted when the verdict was first withheld; re-alerting every interval is noise, not signal')
})

test('a withheld reversal younger than the recheck interval is left to rest', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker({ createdAt: databaseNow(-60_000) })]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]

  const result = await poll()

  assert.equal(result.withheldRechecked, 0)
  assert.deepEqual(state.recheckFetches, [], 'a fresh verdict costs no Xero budget')
})

test('a withheld marker whose document IMS no longer holds as paid is closed, not re-asked for ever', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [{ ...paidBillRow(), paidAt: null }]

  const result = await poll()

  assert.equal(result.withheldRechecked, 1)
  assert.equal(result.withheldResolved, 1)
  assert.deepEqual(state.recheckFetches, [], 'there is no document left to ask Xero about')
  assert.equal(
    state.activity.find((a) => a.action === 'bill_payment_reversal_withheld_cleared')?.metadata?.resolution,
    'no-paid-document')
})

test('a marker that has already been cleared is not re-opened by its own history', async () => {
  reset()
  state.invoices = []
  state.activityRows = [
    withheldMarker({ createdAt: databaseNow(-3 * 60 * 60_000) }),
    withheldMarker({ action: 'bill_payment_reversal_withheld_cleared', createdAt: databaseNow(-2 * 60 * 60_000) }),
  ]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]

  const result = await poll()

  assert.equal(result.withheldRechecked, 0, 'the LATEST row decides the state, and it says closed')
  assert.deepEqual(state.recheckFetches, [])
})

test('a recheck whose Xero read fails closes nothing and leaves the document due', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckFetchFails = true

  const result = await poll()

  assert.equal(result.withheldResolved, 0)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld_cleared'), false)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_recheck_deferred'), false,
    'a read that never happened is not a deferral of THIS document; the marker it already has keeps it due')
  assert.ok(result.errors.some((e) => /recheck could not read Xero/.test(e)))
})

test('a document Xero did not return is deferred rather than closed', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckInvoices = [] // asked for XB1, Xero returned nothing

  const result = await poll()

  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB1'])
  assert.equal(result.withheldResolved, 0, 'a read that came back empty settles nothing')
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld_cleared'), false)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_recheck_deferred'), true,
    'the marker is rewritten anyway, or this document holds the head of an oldest-first page for ever')
})

test('the due set is oldest-reconsidered-first, latest marker wins, and it is bounded', async () => {
  const { dueWithheldMarkers, WITHHELD_RECHECK_INTERVAL_MS } =
    await import('@/lib/connectors/xero/payment-poller')
  const old = (minutes: number) => new Date(Date.now() - WITHHELD_RECHECK_INTERVAL_MS - minutes * 60_000)
  // One entry per document per side, which is what the grouped scan hands it (round 5, finding 3):
  // the action that classified a marker is the query's business, and history is not in here at all.
  const marker = (entityId: string, createdAt: Date) =>
    ({ entityType: 'PURCHASE_ORDER' as const, entityId, createdAt })

  const due = dueWithheldMarkers([
    marker('po_b', old(10)),
    marker('po_a', old(30)),
    // po_c is still open as far as the open side can see, but it has since been closed.
    marker('po_c', old(40)),
    // po_d was re-asked one minute ago, so it is not due again yet.
    marker('po_d', new Date(Date.now() - 60_000)),
  ], [
    marker('po_c', old(5)),
  ], Date.now())

  assert.deepEqual(due.map((m) => m.entityId), ['po_a', 'po_b'],
    'least recently reconsidered first — a round robin, not a queue with a permanent head')
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 5 — THE DEPLOY MUST NOT PUT THE SECOND CLOCK BACK (Codex finding 1)
//
// Round 4 removed both application clocks from the fence. What it could not remove is the PREVIOUS
// RELEASE: during a rollout both builds run at once, and a worker on the old one still stamps
// `syncedAt` from its own host's `new Date()`. A poller on the new build comparing THAT against a
// database fence is the same cross-host comparison, reintroduced by the release rather than by the
// code — and its dangerous direction is the one this branch exists to prevent.
//
// A host-clock stamp is now DISTINGUISHABLE, because the database writes the completion time and its
// provenance marker in one statement from one reading of the clock. A row that cannot prove which
// clock produced it decides nothing at all.
// ---------------------------------------------------------------------------

test('an OLD BUILD row and a database-stamped row in one poll: only the one with a provable clock decides (r5)', async () => {
  reset()
  // Two bills, both zero-paid, both with a registration that completed five minutes before the read.
  // The ONLY difference is which build wrote the stamp.
  state.invoices = [
    bill({ InvoiceID: 'XB1', AmountPaid: 0, AmountDue: 500 }),
    bill({ InvoiceID: 'XB2', AmountPaid: 0, AmountDue: 500 }),
  ]
  state.purchaseInvoices = [
    paidBillRow(),
    { ...paidBillRow(), id: 'pi_2', accountingInvoiceId: 'XB2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.syncLogs = [
    // Written by a worker still on the previous release: `syncedAt` is that host's wall clock, and
    // nothing in the row says so. Round 4 would have called this decided — it is five minutes old,
    // which is "outside any plausible skew" — and that reasoning is the defect.
    billRegistration({ id: 'log_old', syncedAtDatabaseClock: null }),
    // Written by this build: one statement, one reading of `clock_timestamp()`, both columns.
    billRegistration({ id: 'log_new', referenceId: 'pi_2', externalTransactionId: 'PAY-OURS-2' }),
  ]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_2'],
    'the host-clock row must NOT clear paidAt: clearing it re-arms Mark Paid over a payment that may '
    + 'still be in flight, and the second press pays the supplier again')
  assert.equal(result.billsReversed, 1)
  assert.equal(result.billReversalsWithheld, 1)
  const withheld = state.activity.filter((a) => a.action === 'bill_payment_reversal_withheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0]?.metadata?.accountingInvoiceId, 'XB1')
  assert.equal(withheld[0]?.metadata?.registrationVerdict, 'REGISTRATION_UNDECIDED')
  assert.match(withheld[0]?.description ?? '', /log_old/,
    'the withheld warning names the registration a human has to look at')
})

test('an old build REWRITING syncedAt under the marker announces itself, and the verdict withholds (r5)', async () => {
  reset()
  // The other half of a mixed deploy: the database stamped this row, then a worker on the previous
  // release re-synced it and wrote `syncedAt` from its host clock, leaving the marker where it was.
  // The row now states two different completion times, and a row that contradicts itself orders
  // nothing.
  state.invoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  state.purchaseInvoices = [paidBillRow()]
  state.syncLogs = [billRegistration({
    syncedAt: databaseNow(-2 * 60_000),
    syncedAtDatabaseClock: databaseNow(-9 * 60_000),
  })]

  const result = await poll()

  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.equal(result.billsReversed, 0)
  assert.equal(result.billReversalsWithheld, 1)
  assert.equal(
    state.activity.find((a) => a.action === 'bill_payment_reversal_withheld')?.metadata?.registrationVerdict,
    'REGISTRATION_UNDECIDED')
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 5 — A FAILED RECONSIDERATION IS NOT A SETTLED ONE (Codex finding 2)
// ---------------------------------------------------------------------------

test('a transient failure on the decision path DEFERS the recheck instead of closing it for ever (r5)', async () => {
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]
  // Xero answered. The DATABASE read that turns that answer into a verdict did not — one dropped
  // connection, lasting a second. No document in this chunk was reconsidered, so nothing in it may be
  // treated as reconsidered-and-settled.
  state.registrationReadFails = true

  const result = await poll()

  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB1'])
  assert.equal(result.withheldResolved, 0, 'nothing was decided, so nothing may be counted as resolved')
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_reversal_withheld_cleared'), false,
    'closing here retires the recheck permanently on a cause that lasted a second, leaving paidAt set '
    + 'against a ledger that disagrees and no marker left to bring the question back')
  const deferred = state.activity.find((a) => a.action === 'bill_payment_reversal_recheck_deferred')
  assert.ok(deferred, 'the marker is rewritten so the document stays open and goes to the back of the page')
  assert.match(String(deferred.metadata?.reason ?? ''), /reconsideration pass could not complete/)
  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates), [])
  assert.ok(result.errors.some((e) => /registered-payment reading error/.test(e)))
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 5 — MARKER HISTORY MUST NOT OWN THE PAGE (Codex finding 3)
// ---------------------------------------------------------------------------

test('one document\'s marker HISTORY cannot starve another document out of the recheck page (r5)', async () => {
  reset()
  state.invoices = []
  // po_1 has been withheld for a month and reconsidered all the way through it. Every reconsideration
  // APPENDED a marker, so its history alone is larger than the whole scan — and an oldest-row-first
  // page of a bounded size fills with it. Its own newest marker is three hours old.
  const day = 24 * 60 * 60_000
  const oldest = -29 * day
  const newest = -3 * 60 * 60_000
  const step = (newest - oldest) / 499
  for (let i = 0; i < 500; i += 1) {
    state.activityRows.push(withheldMarker({ createdAt: databaseNow(oldest + i * step) }))
  }
  // po_2 became withheld two hours ago and has exactly one marker. Under a page bounded by ROWS it is
  // invisible — and being invisible means never being reconsidered, which means never writing a newer
  // marker, so it never becomes visible either. Permanent, and self-sustaining.
  state.activityRows.push(withheldMarker({ entityId: 'po_2', createdAt: databaseNow(-2 * 60 * 60_000) }))
  state.purchaseInvoices = [
    paidBillRow(),
    { ...paidBillRow(), id: 'pi_2', accountingInvoiceId: 'XB2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.recheckInvoices = [
    bill({ InvoiceID: 'XB1', AmountPaid: 0, AmountDue: 500 }),
    bill({ InvoiceID: 'XB2', AmountPaid: 0, AmountDue: 500 }),
  ]

  const result = await poll()

  assert.equal(result.withheldRechecked, 2,
    'the page is bounded in DOCUMENTS, not in marker rows — one document occupies one place in it')
  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB1,XB2'])
  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id).sort(), ['pi_1', 'pi_2'])
  assert.equal(result.withheldResolved, 2)
})

test('the due order is each document\'s LAST reconsideration, not its first (r5)', async () => {
  reset()
  state.invoices = []
  // po_1 was first withheld four hours ago and reconsidered thirty minutes ago; po_2 was withheld two
  // hours ago and not touched since. Read from history, po_1 looks the more overdue and is asked
  // again while it is still resting. Read from each document's LAST marker, po_1 is not due at all.
  state.activityRows = [
    withheldMarker({ createdAt: databaseNow(-4 * 60 * 60_000) }),
    withheldMarker({ action: 'bill_payment_reversal_recheck_deferred', createdAt: databaseNow(-30 * 60_000) }),
    withheldMarker({ entityId: 'po_2', createdAt: databaseNow(-2 * 60 * 60_000) }),
  ]
  state.purchaseInvoices = [
    paidBillRow(),
    { ...paidBillRow(), id: 'pi_2', accountingInvoiceId: 'XB2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.recheckInvoices = [
    bill({ InvoiceID: 'XB1', AmountPaid: 0, AmountDue: 500 }),
    bill({ InvoiceID: 'XB2', AmountPaid: 0, AmountDue: 500 }),
  ]

  const result = await poll()

  assert.equal(result.withheldRechecked, 1, 'a document reconsidered half an hour ago is still resting')
  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB2'])
})

// ---------------------------------------------------------------------------
// o3d-clxw ROUND 6 — A BOUND ON DOCUMENTS IS NOT A BOUND ON DOCUMENTS THAT NEED SOMETHING
// (Codex finding 2)
//
// Round 5 made the scan group per document, and then applied its bound to the OPEN markers alone,
// before any closure had been read. A settled document keeps its historical open marker for the rest
// of the thirty-day horizon, and that marker is FROZEN — nothing rewrites it, because the document is
// never reconsidered again — while an open document's marker is rewritten every time it IS
// reconsidered. So under oldest-first every settled document sorts ahead of every worked one, and
// once the horizon holds as many settled documents as the scan is wide, the page is entirely
// documents with nothing left to decide. Reading the closures afterwards cannot help: the bound has
// already been spent.
// ---------------------------------------------------------------------------

test('documents whose withheld verdict is already CLOSED cannot spend the scan (r6)', async () => {
  const { WITHHELD_MARKER_SCAN } = await import('@/lib/connectors/xero/payment-poller')
  reset()
  state.invoices = []
  const day = 24 * 60 * 60_000
  // A full scan's worth of documents that were withheld and then SETTLED weeks ago. Each still has
  // its open marker in the horizon, older than anything still being worked, and each has a closure
  // written after it. They need nothing.
  for (let i = 0; i < WITHHELD_MARKER_SCAN; i += 1) {
    const entityId = `po_settled_${i}`
    state.activityRows.push(withheldMarker({ entityId, createdAt: databaseNow(-20 * day + i * 1000) }))
    state.activityRows.push(withheldMarker({
      entityId,
      action: 'bill_payment_reversal_withheld_cleared',
      createdAt: databaseNow(-19 * day + i * 1000),
    }))
  }
  // And one document that is genuinely open, withheld two hours ago. Under a bound applied to open
  // markers before closures are known it is the (SCAN + 1)th row and never appears — which means it
  // is never reconsidered, which means it never writes a newer marker, so it never appears. The same
  // permanent, self-sustaining starvation as round 5's, one column over.
  state.activityRows.push(withheldMarker({ entityId: 'po_2', createdAt: databaseNow(-2 * 60 * 60_000) }))
  state.purchaseInvoices = [
    { ...paidBillRow(), id: 'pi_2', accountingInvoiceId: 'XB2', poId: 'po_2', po: { reference: 'PO-0002', status: 'RECEIVED' } },
  ]
  state.recheckInvoices = [bill({ InvoiceID: 'XB2', AmountPaid: 0, AmountDue: 500 })]

  const result = await poll()

  assert.equal(result.withheldRechecked, 1,
    'the scan is a scan of documents that are STILL OPEN — a settled document never reaches the bound')
  assert.deepEqual(state.recheckFetches, ['Invoices?IDs=XB2'])
  assert.deepEqual(clearedPaidAt(state.purchaseInvoiceUpdates).map((u) => u.id), ['pi_2'])
  assert.equal(result.withheldResolved, 1)
  assert.equal(
    state.activity.filter((a) => a.action === 'bill_payment_reversal_withheld_cleared').length, 1,
    'and no settled document is re-opened, re-asked, or written about again')
})

test('the scan classifies open against closed BEFORE it cuts the page, in the statement itself (r6)', async () => {
  // The double above models this statement, and a model cannot notice the statement changing. What is
  // asserted here is the one property the model cannot re-derive: WHERE THE BOUND SITS. Move the
  // LIMIT inside the aggregate and every behavioural test still passes — the double would go on
  // filtering before slicing — while production would go back to spending its page on documents that
  // were settled weeks ago.
  reset()
  state.invoices = []
  state.activityRows = [withheldMarker()]
  state.purchaseInvoices = [paidBillRow()]
  state.recheckInvoices = [bill({ AmountPaid: 0, AmountDue: 500 })]

  await poll()

  const sql = state.rawStatements.find((s) => s.includes('activity_logs'))
  assert.ok(sql, 'the withheld-marker scan is a statement of its own')
  assert.equal((sql.match(/MAX\("createdAt"\) FILTER \(WHERE "action" = ANY/g) ?? []).length, 2,
    'both aggregates — the last open marker AND the last closure — come from ONE grouped pass')

  const subquery = sql.slice(sql.indexOf('FROM ('), sql.indexOf(') d'))
  assert.doesNotMatch(subquery, /LIMIT/,
    'a bound inside the aggregate is a bound spent before any closure is known, which is the finding')
  const classification = sql.indexOf('d."openMax" IS NOT NULL')
  const bound = sql.indexOf('LIMIT')
  assert.ok(classification >= 0 && bound > classification,
    'the settled documents are dropped first; only what is still open reaches the bound')
  assert.match(sql.slice(classification, bound), /d\."openMax" > d\."closedMax"/,
    'and "still open" means this document\'s latest marker across BOTH kinds is an open one')
  assert.match(sql.slice(0, bound), /ORDER BY d\."openMax" ASC/,
    'least recently reconsidered first — the round robin round 4 built')
  assert.doesNotMatch(sql, /bill_payment_reversal/,
    'the action lists are bound as parameters, never interpolated into the statement')
})

// ---------------------------------------------------------------------------
// o3d-psrx — THE WINDOW BETWEEN A RECEIPT COMMITTING AND ITS REGISTRATION BEING QUEUED
//
// `addPayment` writes the local Payment row and the order's `paidAt` in ONE transaction and queues
// the INVOICE_PAYMENT registration afterwards, outside it — with a `revalidatePath` and an awaited
// `logActivity` in between. Every fixture below is the durable state at an instant inside that gap:
// an order IMS holds as paid, a receipt recorded against it, and no registration at all.
//
// Before this, the poll read that as NOTHING_REGISTERED, cleared `paidAt` and raised a chargeback
// credit note against a sale nobody reversed.
// ---------------------------------------------------------------------------

const localReceipt = (overrides: Row = {}): Row => ({ id: 'pay_1', orderId: 'so_1', refundId: null, ...overrides })

test('[o3d-psrx] a zero-paid sales invoice with an UNREGISTERED receipt raises NO chargeback and keeps paidAt', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  // The whole fixture: a receipt, and NOTHING in syncLogs. This is the gap.
  state.payments = [localReceipt()]

  const result = await poll()

  // MUTATION ROUTE: delete the `db.payment.findMany` read from readResidualVerdicts (or pass `[]`
  // for `unregisteredReceiptIds`) and the verdict falls back to NOTHING_REGISTERED — chargebacks
  // becomes ['so_1'], paidAt is cleared, and salesReversalsWithheld drops to 0.
  assert.deepEqual(state.chargebacks, [],
    'a credit note here reverses revenue against a receipt IMS simply had not told Xero about yet')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [], 'and paidAt must stay set')
  assert.equal(result.salesReversed, 0)
  assert.equal(result.salesReversalsWithheld, 1, 'withheld and REPORTED, never silently skipped')

  const withheld = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.match(withheld?.description ?? '', /never registered with Xero/,
    'the warning must name IMS\'s own silence — an operator sent to /sync finds no row to look at')
  assert.match(withheld?.description ?? '', /pay_1/, 'and name the receipt')
  assert.equal(state.notifications.some((n) => n.title === 'Payment reversal detected'), false)
})

test('[o3d-psrx] once the registration names the receipt, the poll decides normally again', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  state.payments = [localReceipt()]
  // The same instant one step later: the registration exists, SYNCED before the ledger read, and the
  // ledger does not list it. That is a real removal and it must STILL be reversed.
  state.syncLogs = [salesRegistration({ payload: { paymentId: 'pay_1' } })]

  const result = await poll()

  // MUTATION ROUTE: make `unregisteredLocalReceipts` ignore `paymentId` in the other direction —
  // report every receipt as unregistered — and this fails, because the fix would then have disabled
  // sales reversal detection outright.
  assert.deepEqual(state.chargebacks, ['so_1'], 'a genuine reversal is still detected')
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates).map((u) => u.id), ['so_1'])
  assert.equal(result.salesReversalsWithheld, 0)
})

test('[o3d-psrx] a SECOND receipt on an already-registered order reopens the window for itself alone', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  state.payments = [localReceipt(), localReceipt({ id: 'pay_2' })]
  state.syncLogs = [salesRegistration({ payload: { paymentId: 'pay_1' } })]

  const result = await poll()

  // The order DOES have a registration, so a check that asked only "is there a row for this order?"
  // would answer yes and admit the reversal. The question has to be per RECEIPT.
  //
  // MUTATION ROUTE: pair on the order instead of on `paymentId` and chargebacks becomes ['so_1'].
  assert.deepEqual(state.chargebacks, [])
  assert.deepEqual(clearedPaidAt(state.salesOrderUpdates), [])
  assert.equal(result.salesReversalsWithheld, 1)
  assert.match(state.activity.find((a) => a.action === 'payment_reversal_withheld')?.description ?? '', /pay_2/)
})

test('[o3d-psrx] a REFUND receipt is not an invoice receipt and does not withhold', async () => {
  reset()
  state.invoices = [{ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 100, Payments: [] }]
  state.salesOrders = [paidOrderRow()]
  // A refund receipt settles a credit note, not this invoice: it owes no INVOICE_PAYMENT and bears
  // on nothing this poll is reading.
  //
  // MUTATION ROUTE: drop `refundId: null` from the receipt read and this fails — every refunded
  // order would withhold its reversal for ever.
  state.payments = [localReceipt({ id: 'pay_refund', refundId: 'ref_1' })]

  const result = await poll()

  assert.deepEqual(state.chargebacks, ['so_1'])
  assert.equal(result.salesReversalsWithheld, 0)
})
