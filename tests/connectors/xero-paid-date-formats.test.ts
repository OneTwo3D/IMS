// ACC-H5 — Xero's FullyPaidOnDate arrives as `/Date(ms+0000)/` or as a zone-less ISO string.
//
// The poller used to read it with `new Date(...)`: the .NET form is an Invalid Date, and a missing
// date silently became "now". These tests drive the real poller over a mocked Xero and database
// (no live call) and pin the parser fixtures: both formats, plus garbage.

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

/** The xero_payment_date_pending table, so a remembered id survives from one poll to the next. */
const pendingRows: Array<{ tenantId: string; kind: string; xeroInvoiceId: string; firstSeenAt: number; lastCheckedAt: number | null }> = []
const TENANT = 'tenant-A'
let connectedTenant: string | null = TENANT
let pendingClock = 1
let pendingWriteFails = false
let purchaseInvoiceReadFails = false

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
  pendingRows.length = 0
  pendingWriteFails = false
  purchaseInvoiceReadFails = false
  connectedTenant = TENANT
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
    // o3d-psrx r4: the scan is CONNECTOR-SCOPED now — both pollers write the same action names, so
    // the statement asks for its own markers plus (for the legacy owner) the ones written before the
    // key existed. Applied here for real: a double that ignored the predicate would make the
    // cross-connector test vacuous.
    // o3d-psrx r5 (Codex HIGH 2): NO HORIZON PARAMETER any more. The scan bounds itself by DOCUMENTS,
    // never by age — an age bound is what let an unresolved reversal be abandoned by an outage longer
    // than it. The list is positional, so a stale double here would silently mis-read every predicate.
    const [openActions, closedActions, allActions, connector, legacyOwner, limit] =
      values as [string[], string[], string[], string, boolean, number]
    const claims = (row: Row): boolean => {
      const meta = row.metadata as { connector?: unknown } | null | undefined
      const owner = typeof meta?.connector === 'string' ? meta.connector : null
      return owner === connector || (legacyOwner && owner === null)
    }
    const groups = new Map<string, { entityType: unknown; entityId: string; openMax: Date | null; closedMax: Date | null }>()
    for (const row of state.activityRows) {
      if (row.tag !== 'sync') continue
      if (!allActions.includes(row.action as string)) continue
      if (row.entityId == null) continue
      if (!claims(row)) continue
      const at = row.createdAt as Date
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
  accountingToken: { findUnique: async () => (connectedTenant === null ? null : { tenantId: connectedTenant }) },
  xeroPaymentDatePending: {
    upsert: async ({ create }: { create: { tenantId: string; kind: string; xeroInvoiceId: string } }) => {
      if (pendingWriteFails) throw new Error('connection terminated unexpectedly')
      if (!pendingRows.some((r) => r.tenantId === create.tenantId && r.kind === create.kind && r.xeroInvoiceId === create.xeroInvoiceId)) {
        pendingRows.push({ tenantId: create.tenantId, kind: create.kind, xeroInvoiceId: create.xeroInvoiceId, firstSeenAt: pendingClock++, lastCheckedAt: null })
      }
      return {}
    },
    findMany: async ({ where, take }: { where: { tenantId: { in: string[] } }; take: number }) =>
      pendingRows.filter((r) => where.tenantId.in.includes(r.tenantId))
        .sort((a, b) => (a.lastCheckedAt ?? -1) - (b.lastCheckedAt ?? -1) || a.firstSeenAt - b.firstSeenAt).slice(0, take)
        .map((r) => ({ tenantId: r.tenantId, kind: r.kind, xeroInvoiceId: r.xeroInvoiceId })),
    deleteMany: async ({ where }: { where: { tenantId: string; kind: string; xeroInvoiceId: string } }) => {
      const i = pendingRows.findIndex((r) => r.tenantId === where.tenantId && r.kind === where.kind && r.xeroInvoiceId === where.xeroInvoiceId)
      if (i >= 0) pendingRows.splice(i, 1)
      return {}
    },
    updateMany: async ({ where }: { where: { tenantId: string; kind: string; xeroInvoiceId: string } }) => {
      const row = pendingRows.find((r) => r.tenantId === where.tenantId && r.kind === where.kind && r.xeroInvoiceId === where.xeroInvoiceId)
      if (row) row.lastCheckedAt = pendingClock++
      return {}
    },
  },
  user: { findMany: async () => [{ id: 'admin_1' }] },
  salesOrderRefund: { findFirst: async () => null },
  salesOrder: {
    findMany: async ({ where }: { where: Row }) => state.salesOrders.filter((r) => rowMatches(r, where)),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (data.paidAt === undefined) return { count: 0 }
      state.salesOrderUpdates.push({ id: where.id, data })
      return { count: 1 }
    },
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
    findMany: async ({ where }: { where: Row }) => {
      if (purchaseInvoiceReadFails) throw new Error('connection terminated unexpectedly')
      return state.purchaseInvoices.filter((r) => rowMatches(r, where))
    },
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

import { parseXeroDate, parseXeroDateOrNull } from '@/lib/connectors/xero/xero-date'

const UNPAID_BILL = (): Row => ({ id: 'pi_1', accountingInvoiceId: 'XB1', paidAt: null, poId: 'po_1', po: { reference: 'PO-0001' } })
const UNPAID_ORDER = (): Row => ({
  id: 'so_1', accountingInvoiceId: 'XS1', paidAt: null, orderNumber: 'SO-0001', externalOrderNumber: null,
  status: 'PENDING_PAYMENT', refundStatus: 'NONE',
})
const paidBill = (paidOn: string | undefined): XeroInvoice =>
  ({ InvoiceID: 'XB1', Type: 'ACCPAY', Status: 'PAID', AmountPaid: 100, AmountDue: 0, Total: 100, FullyPaidOnDate: paidOn } as XeroInvoice)
const paidSale = (paidOn: string | undefined): XeroInvoice =>
  ({ InvoiceID: 'XS1', Type: 'ACCREC', Status: 'PAID', AmountPaid: 100, AmountDue: 0, Total: 100, FullyPaidOnDate: paidOn } as XeroInvoice)

const DOT_NET = '/Date(1782864000000+0000)/' // 2026-07-01T00:00:00Z
const ISO_NO_ZONE = '2026-07-01T00:00:00'

test('parser fixtures: .NET form, zone-less ISO (read as UTC), zoned ISO, garbage', () => {
  assert.equal(parseXeroDate(DOT_NET), Date.UTC(2026, 6, 1))
  assert.equal(parseXeroDate('/Date(1782864000000)/'), Date.UTC(2026, 6, 1))
  assert.equal(parseXeroDate(ISO_NO_ZONE), Date.UTC(2026, 6, 1))
  assert.equal(parseXeroDate('2026-07-01T00:00:00.000'), Date.UTC(2026, 6, 1))
  assert.equal(parseXeroDate('2026-07-01T00:00:00Z'), Date.UTC(2026, 6, 1))
  assert.equal(parseXeroDate('2026-07-01T01:00:00+01:00'), Date.UTC(2026, 6, 1))
  for (const bad of ['', '   ', 'garbage', '/Date(abc)/', '/Date()/', undefined, null, '2026-13-45T99:99:99']) {
    assert.ok(Number.isNaN(parseXeroDate(bad as string | undefined)), `${String(bad)} must be NaN`)
    assert.equal(parseXeroDateOrNull(bad as string | undefined), null, `${String(bad)} must be null, never now`)
  }
})

test('a bill PAID with a /Date(ms)/ FullyPaidOnDate is stamped with that date', async () => {
  reset()
  state.invoices = [paidBill(DOT_NET)]
  state.purchaseInvoices = [UNPAID_BILL()]
  const result = await poll()
  assert.deepEqual(result.errors, [])
  assert.equal(result.billsPaid, 1)
  assert.equal((state.purchaseInvoiceUpdates[0].data.paidAt as Date).toISOString(), '2026-07-01T00:00:00.000Z')
})

test('a bill PAID with a zone-less ISO FullyPaidOnDate is stamped as UTC', async () => {
  reset()
  state.invoices = [paidBill(ISO_NO_ZONE)]
  state.purchaseInvoices = [UNPAID_BILL()]
  await poll()
  assert.equal((state.purchaseInvoiceUpdates[0].data.paidAt as Date).toISOString(), '2026-07-01T00:00:00.000Z')
})

for (const bad of ['garbage', undefined]) {
  test(`a bill PAID with FullyPaidOnDate ${String(bad)} is skipped with a logged reason, never stamped`, async () => {
    reset()
    state.invoices = [paidBill(bad)]
    state.purchaseInvoices = [UNPAID_BILL()]
    const result = await poll()
    assert.deepEqual(state.purchaseInvoiceUpdates, [], 'no paidAt may be written (no Invalid Date, no now)')
    assert.equal(result.billsPaid, 0)
    assert.deepEqual(result.errors, [], 'an unreadable date must not hold the cursor and stall the poll')
    const logged = state.activity.find((a) => a.action === 'bill_payment_date_unreadable')
    assert.ok(logged)
    assert.equal(logged.level, 'WARNING')
  })
}

test('a sales order PAID with a /Date(ms)/ FullyPaidOnDate is stamped with that date', async () => {
  reset()
  state.invoices = [paidSale(DOT_NET)]
  state.salesOrders = [UNPAID_ORDER()]
  const result = await poll()
  assert.deepEqual(result.errors, [])
  const write = state.salesOrderUpdates.find((u) => u.data.paidAt !== undefined)
  assert.ok(write)
  assert.equal((write.data.paidAt as Date).toISOString(), '2026-07-01T00:00:00.000Z')
})

test('a sales order PAID with a garbage FullyPaidOnDate is skipped with a logged reason', async () => {
  reset()
  state.invoices = [paidSale('garbage')]
  state.salesOrders = [UNPAID_ORDER()]
  const result = await poll()
  assert.equal(state.salesOrderUpdates.length, 0)
  assert.deepEqual(result.errors, [])
  assert.ok(state.activity.some((a) => a.action === 'payment_date_unreadable' && a.level === 'WARNING'))
})

test('payment reconcile reads the same formats: .NET form and zone-less ISO (UTC) parse, garbage is null, never now', async () => {
  const { parseSettlementDate } = await import('@/lib/connectors/xero/payment-reconcile')
  assert.equal(parseSettlementDate(DOT_NET)?.toISOString(), '2026-07-01T00:00:00.000Z')
  assert.equal(parseSettlementDate(ISO_NO_ZONE)?.toISOString(), '2026-07-01T00:00:00.000Z')
  assert.equal(parseSettlementDate('2026-07-01T00:00:00Z')?.toISOString(), '2026-07-01T00:00:00.000Z')
  for (const bad of ['garbage', '/Date(abc)/', '', undefined]) assert.equal(parseSettlementDate(bad), null)
})

// --- a skipped document is revisited (no new modification event needed) -------------------------------------------------------------

const ids = (kind: string) => pendingRows.filter((r) => r.kind === kind).map((r) => r.xeroInvoiceId)

test('a bill PAID with no date is remembered, and a LATER poll with an empty delta applies it once the date is readable', async () => {
  reset()
  state.invoices = [paidBill(undefined)]
  state.recheckInvoices = [paidBill(undefined)] // what Xero returns when asked for it by id
  state.purchaseInvoices = [UNPAID_BILL()]
  const first = await poll()
  assert.equal(first.billsPaid, 0)
  assert.equal(state.purchaseInvoiceUpdates.length, 0)
  assert.deepEqual(ids('BILL'), ['XB1'])
  assert.ok(state.activity.some((a) => a.action === 'bill_payment_date_unreadable' && a.level === 'WARNING'), 'the WARNING is kept')

  // Xero has not modified the document since: the delta is empty. It is simply readable now, by id.
  state.invoices = []
  state.recheckInvoices = [paidBill(DOT_NET)]
  const second = await poll()
  assert.deepEqual(second.errors, [])
  assert.equal(second.billsPaid, 1)
  assert.equal((state.purchaseInvoiceUpdates[0].data.paidAt as Date).toISOString(), '2026-07-01T00:00:00.000Z')
  assert.deepEqual(ids('BILL'), [], 'and forgotten')
})

test('a sales order PAID with no date is remembered and applied by a later poll', async () => {
  reset()
  state.invoices = [paidSale(undefined)]
  state.recheckInvoices = [paidSale(undefined)]
  state.salesOrders = [UNPAID_ORDER()]
  await poll()
  assert.equal(state.salesOrderUpdates.length, 0)
  assert.deepEqual(ids('SALES'), ['XS1'])

  state.invoices = []
  state.recheckInvoices = [paidSale(ISO_NO_ZONE)]
  const second = await poll()
  assert.deepEqual(second.errors, [])
  const write = state.salesOrderUpdates.find((u) => u.data.paidAt !== undefined)
  assert.ok(write)
  assert.equal((write.data.paidAt as Date).toISOString(), '2026-07-01T00:00:00.000Z')
  assert.deepEqual(ids('SALES'), [])
})

test('a document still unreadable stays remembered, quietly (no second WARNING, no write); one that is no longer PAID is forgotten; the list is deduplicated', async () => {
  reset()
  state.invoices = [paidBill(undefined)]
  state.recheckInvoices = [paidBill(undefined)]
  state.purchaseInvoices = [UNPAID_BILL()]
  await poll()
  const warnings = () => state.activity.filter((a) => a.action === 'bill_payment_date_unreadable').length
  assert.equal(warnings(), 1)

  state.invoices = []
  state.recheckInvoices = [paidBill('garbage')]
  await poll()
  assert.equal(warnings(), 1)
  assert.equal(state.purchaseInvoiceUpdates.length, 0)
  assert.deepEqual(ids('BILL'), ['XB1'])

  // The same document skipped again by the delta is not listed twice.
  state.invoices = [paidBill(undefined)]
  state.recheckInvoices = [paidBill(undefined)]
  await poll()
  assert.deepEqual(ids('BILL'), ['XB1'])

  state.invoices = []
  state.recheckInvoices = [{ ...paidBill(undefined), Status: 'AUTHORISED' } as XeroInvoice]
  await poll()
  assert.deepEqual(ids('BILL'), [])
})

test('a failure to REMEMBER the skipped document holds the cursor, so the document comes back through the delta', async () => {
  reset()
  state.invoices = [paidBill(undefined)]
  state.purchaseInvoices = [UNPAID_BILL()]
  pendingWriteFails = true
  const failed = await poll()
  assert.ok(failed.errors.some((e) => /Could not remember the PAID bill XB1/.test(e)), failed.errors.join('|'))
  assert.equal(state.settingUpserts.length, 0, 'the cursor did NOT advance past the chunk')
  assert.deepEqual(ids('BILL'), [])

  // Next poll, the write works: the same chunk is read again, the document is remembered, and only now does the cursor move.
  pendingWriteFails = false
  state.recheckInvoices = [paidBill(undefined)]
  const ok = await poll()
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ids('BILL'), ['XB1'])
  assert.equal(state.settingUpserts.length, 1)
})

test('nothing is evicted: more than 200 remembered documents are all kept, and each poll re-reads the least recently checked 200', async () => {
  reset()
  for (let i = 0; i < 250; i++) pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: `OLD${i}`, firstSeenAt: pendingClock++, lastCheckedAt: null })
  state.invoices = []
  // Xero still reports every one of them PAID with no date.
  state.recheckInvoices = Array.from({ length: 250 }, (_, i) => ({ InvoiceID: `OLD${i}`, Type: 'ACCPAY', Status: 'PAID' }) as XeroInvoice)
  await poll()
  assert.equal(pendingRows.length, 250, 'none dropped')
  assert.equal(pendingRows.filter((r) => r.lastCheckedAt !== null).length, 200)
  await poll()
  assert.equal(pendingRows.length, 250)
  assert.ok(pendingRows.every((r) => r.lastCheckedAt !== null), 'the second poll reached the 50 that were waiting')
})

test('a document the Xero response OMITS stays remembered (an omission proves nothing); only a returned document that needs no retry is forgotten', async () => {
  reset()
  pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: 'GONE', firstSeenAt: pendingClock++, lastCheckedAt: null })
  pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: 'VOIDED', firstSeenAt: pendingClock++, lastCheckedAt: null })
  pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: 'STILL', firstSeenAt: pendingClock++, lastCheckedAt: null })
  state.invoices = []
  // A successful answer that leaves one of the three out.
  state.recheckInvoices = [
    { InvoiceID: 'VOIDED', Type: 'ACCPAY', Status: 'VOIDED' } as XeroInvoice,
    { InvoiceID: 'STILL', Type: 'ACCPAY', Status: 'PAID' } as XeroInvoice,
  ]
  const result = await poll()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(pendingRows.map((r) => r.xeroInvoiceId).sort(), ['GONE', 'STILL'], 'GONE (omitted) and STILL (unreadable) stay; VOIDED (returned, no longer PAID) is forgotten')
})

test('rows of ANOTHER Xero organisation are neither fetched nor changed, and a new row is stamped with the connected organisation', async () => {
  reset()
  pendingRows.push({ tenantId: 'tenant-B', kind: 'BILL', xeroInvoiceId: 'OTHER', firstSeenAt: pendingClock++, lastCheckedAt: null })
  pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: 'MINE', firstSeenAt: pendingClock++, lastCheckedAt: null })
  state.invoices = []
  state.recheckInvoices = [
    { InvoiceID: 'OTHER', Type: 'ACCPAY', Status: 'VOIDED' } as XeroInvoice,
    { InvoiceID: 'MINE', Type: 'ACCPAY', Status: 'VOIDED' } as XeroInvoice,
  ]
  await poll()
  assert.deepEqual(state.recheckFetches.map((p) => p.replace('Invoices?IDs=', '')), ['MINE'], 'only this organisation\'s ids were asked for')
  assert.deepEqual(pendingRows.map((r) => `${r.tenantId}/${r.xeroInvoiceId}`), ['tenant-B/OTHER'], 'the other organisation\'s row is untouched')

  reset()
  state.invoices = [paidBill(undefined)]
  state.recheckInvoices = [paidBill(undefined)]
  state.purchaseInvoices = [UNPAID_BILL()]
  await poll()
  assert.deepEqual(pendingRows.map((r) => `${r.tenantId}/${r.xeroInvoiceId}`), [`${TENANT}/XB1`])
})

test('with no Xero organisation connected the skipped document cannot be scoped: the poll holds its cursor instead of remembering it unscoped', async () => {
  reset()
  connectedTenant = null
  state.invoices = [paidBill(undefined)]
  state.purchaseInvoices = [UNPAID_BILL()]
  const result = await poll()
  assert.ok(result.errors.some((e) => /no Xero organisation is connected/.test(e)))
  assert.equal(state.settingUpserts.length, 0)
  assert.equal(pendingRows.length, 0)
})

test('a zone-less ISO date is UTC whatever the host\'s zone (the date parser never reads it in local time)', () => {
  const was = process.env.TZ
  try {
    for (const zone of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
      process.env.TZ = zone
      assert.equal(parseXeroDate(ISO_NO_ZONE), Date.UTC(2026, 6, 1), zone)
      assert.equal(parseXeroDateOrNull('2026-07-01T12:30:00')?.toISOString(), '2026-07-01T12:30:00.000Z', zone)
    }
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('a retry whose apply pass ERRORS forgets nothing: the remembered rows stay for the next poll', async () => {
  reset()
  pendingRows.push({ tenantId: TENANT, kind: 'BILL', xeroInvoiceId: 'XB1', firstSeenAt: pendingClock++, lastCheckedAt: null })
  state.invoices = []
  state.recheckInvoices = [paidBill(DOT_NET)]
  state.purchaseInvoices = [UNPAID_BILL()]
  purchaseInvoiceReadFails = true
  const result = await poll()
  assert.ok(result.errors.length > 0, 'the apply pass recorded its failure')
  assert.deepEqual(pendingRows.map((r) => r.xeroInvoiceId), ['XB1'], 'the row stays')
  assert.equal(state.purchaseInvoiceUpdates.length, 0)
  // The next poll, the read works: applied and forgotten.
  purchaseInvoiceReadFails = false
  const again = await poll()
  assert.deepEqual(again.errors, [])
  assert.equal(again.billsPaid, 1)
  assert.deepEqual(pendingRows, [])
})
