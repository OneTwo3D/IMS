// o3d-psrx r4 / o3d-a6i2 (Codex HIGH) — A WITHHELD QUICKBOOKS REVERSAL COMES BACK.
//
// r3 gave this poller the paid-provenance gate and deliberately let the watermark advance past a
// withheld verdict: a paid flag that by design is never registered would otherwise freeze every later
// QuickBooks payment and reversal behind it. That reasoning was right and it was only half the answer.
// QuickBooks selects reversal candidates only where `MetaData.LastUpdatedTime` exceeds the watermark,
// and several withholding causes resolve with NO QuickBooks document change at all — a PROCESSING
// registration finishing or being CANCELLED, or a database fence that failed once. So the document was
// checkpointed past and never asked about again, and a genuine chargeback stayed represented as paid.
//
// These tests drive the real poller over a mocked QuickBooks and database, across TWO polls, and the
// second one's delta window is deliberately EMPTY: whatever reverses the order there cannot have come
// from the cursor.

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

type Row = Record<string, unknown>
type LoggedActivity = {
  entityType?: string
  entityId?: string | null
  action?: string
  description?: string
  metadata?: Record<string, unknown> | null
}

const HOUR = 60 * 60 * 1000

const state = {
  salesOrders: [] as Row[],
  purchaseInvoices: [] as Row[],
  syncLogs: [] as Row[],
  payments: [] as Row[],
  activityRows: [] as Row[],
  activity: [] as LoggedActivity[],
  salesOrderUpdates: [] as { id: unknown; data: Row }[],
  settingUpserts: [] as { key: unknown; value: unknown }[],
  chargebacks: [] as string[],
  /** Every QuickBooks query string this run issued, so the by-id read can be told from the delta read. */
  queries: [] as string[],
  /** Documents the by-id read is allowed to answer about, keyed by id. */
  qboDocuments: new Map<string, { Id: string; Balance: number; TotalAmt: number }>(),
  /** Ids the DELTA read reports as balance-due. Empty on the second poll: the cursor has moved past. */
  deltaBalanceDue: [] as string[],
  dbClockFails: false,
  lastPoll: '2026-08-01T00:00:00.000Z',
}

function reset(): void {
  state.salesOrders = []
  state.purchaseInvoices = []
  state.syncLogs = []
  state.payments = []
  state.activityRows = []
  state.activity = []
  state.salesOrderUpdates = []
  state.settingUpserts = []
  state.chargebacks = []
  state.queries = []
  state.qboDocuments = new Map()
  state.deltaBalanceDue = []
  state.dbClockFails = false
  state.lastPoll = '2026-08-01T00:00:00.000Z'
}

const recordActivity = (entry: LoggedActivity): void => {
  state.activity.push(entry)
  state.activityRows.push({
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    tag: 'sync',
    metadata: entry.metadata ?? null,
    createdAt: new Date(),
  })
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { recordActivity(entry) },
    logActivityPersisted: async (entry: LoggedActivity) => { recordActivity(entry); return true },
  },
})

mock.module('@/lib/settings-store', {
  namedExports: { getSettingValue: async () => state.lastPoll },
})

mock.module('@/app/actions/sales', {
  namedExports: {
    raiseChargebackForReversedOrder: async (orderId: string) => { state.chargebacks.push(orderId); return {} },
  },
})
mock.module('@/app/actions/allocation', { namedExports: { autoAllocateOrder: async () => ({ success: true }) } })

mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboQuery: async (entity: string, where?: string) => {
      state.queries.push(`${entity}: ${where ?? ''}`)
      // THE BY-ID READ — the whole point of the recheck. It is independent of the watermark, so it
      // answers about whatever it was asked about.
      const byId = where?.match(/^Id IN \((.*)\)$/)
      if (byId) {
        const ids = byId[1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''))
        const rows = ids.map((id) => state.qboDocuments.get(id)).filter((d) => d != null)
        return { ok: true, data: { QueryResponse: { [entity]: rows } } }
      }
      // THE DELTA READS, which only ever see what changed since the watermark.
      if (where?.startsWith('Balance > ')) {
        return { ok: true, data: { QueryResponse: { [entity]: state.deltaBalanceDue.map((Id) => ({ Id })) } } }
      }
      return { ok: true, data: { QueryResponse: {} } }
    },
  },
})

const rowMatches = (row: Row, where: Row): boolean => {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'po' || key === 'shoppingLinks') continue
    const value = row[key]
    if (cond === null) { if (value != null) return false; continue }
    if (cond instanceof Date) { if ((value as Date)?.getTime() !== cond.getTime()) return false; continue }
    if (typeof cond === 'object') {
      const c = cond as Row
      if ('not' in c) {
        if (c.not === null && value == null) return false
        if (c.not !== null && value === c.not) return false
      }
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

const dbDouble: Record<string, unknown> = {
  // Two statements reach raw SQL: the database fence, and the withheld-marker scan. The scan is run
  // for real here — grouped per document, both aggregates, connector-scoped, filtered BEFORE the bound
  // — because a double that returned rows would make every assertion below vacuous.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? [...strings].join('?') : String(strings)
    if (sql.includes('clock_timestamp()')) {
      if (state.dbClockFails) throw new Error('database clock unavailable')
      return [{ fence: new Date() }]
    }
    if (!sql.includes('activity_logs')) throw new Error(`unexpected raw statement: ${sql}`)
    // NO HORIZON PARAMETER (o3d-psrx r5, Codex HIGH 2). The scan bounds itself by DOCUMENTS, never by
    // age: an age bound is what let an unresolved reversal be abandoned by a poll outage longer than
    // it. Reading a positional list is why this had to be updated — which is the point of running the
    // real reduction here rather than stubbing a row set.
    const [openActions, closedActions, allActions, connector, legacyOwner, limit] =
      values as [string[], string[], string[], string, boolean, number]
    const groups = new Map<string, { entityType: unknown; entityId: string; openMax: Date | null; closedMax: Date | null }>()
    for (const row of state.activityRows) {
      if (row.tag !== 'sync') continue
      if (!allActions.includes(row.action as string)) continue
      if (row.entityId == null) continue
      const meta = row.metadata as { connector?: unknown } | null
      const owner = typeof meta?.connector === 'string' ? meta.connector : null
      if (!(owner === connector || (legacyOwner && owner === null))) continue
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
  salesOrder: {
    findMany: async ({ where }: { where: Row }) => state.salesOrders.filter((r) => rowMatches(r, where)),
    update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
      state.salesOrderUpdates.push({ id: where.id, data })
      const row = state.salesOrders.find((r) => r.id === where.id)
      if (row) Object.assign(row, data)
      return {}
    },
  },
  purchaseInvoice: {
    findMany: async ({ where }: { where: Row }) => state.purchaseInvoices.filter((r) => rowMatches(r, where)),
    update: async () => ({}),
  },
  accountingSyncLog: {
    findMany: async ({ where }: { where: Row }) => state.syncLogs.filter((r) => rowMatches(r, where)),
  },
  payment: { findMany: async ({ where }: { where: Row }) => state.payments.filter((r) => rowMatches(r, where)) },
  setting: {
    findUnique: async () => ({ value: state.lastPoll }),
    upsert: async ({ where, update }: { where: { key: unknown }; update: { value: unknown } }) => {
      state.settingUpserts.push({ key: where.key, value: update.value })
      return {}
    },
  },
  user: { findMany: async () => [] },
}

mock.module('@/lib/db', { namedExports: { db: dbDouble } })

const poll = async () => {
  const { pollQuickBooksPayments } = await import('@/lib/connectors/quickbooks/payment-poller')
  return pollQuickBooksPayments()
}

/** A sales order IMS holds as paid from QuickBooks' own forward pass (no marker to withhold on). */
function paidOrderRow(): Row {
  return {
    id: 'so_1',
    accountingInvoiceId: 'QI1',
    paidAt: new Date('2026-08-01T00:00:00.000Z'),
    unregisteredPaidAt: null,
    orderNumber: 'SO-0001',
    externalOrderNumber: null,
    status: 'SHIPPED',
    refundStatus: 'NONE',
    revenueDeferredDate: new Date('2026-07-01T00:00:00.000Z'),
    shoppingLinks: [],
  }
}

/** The registration that withholds the reversal: claimed, possibly on the wire, decidable by nobody. */
function inFlightRegistration(overrides: Row = {}): Row {
  return {
    id: 'log_1',
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    status: 'PROCESSING',
    externalTransactionId: null,
    syncedAt: null,
    syncedAtDatabaseClock: null,
    payload: { accountingInvoiceId: 'QI1' },
    ...overrides,
  }
}

/** Age every marker written so far, so the recheck timer has elapsed on the next poll. */
function ageMarkers(byMs: number): void {
  for (const row of state.activityRows) {
    row.createdAt = new Date((row.createdAt as Date).getTime() - byMs)
  }
}

test('a withheld QuickBooks reversal is revisited after its cause resolves, WITHOUT holding the cursor', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [inFlightRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  // ---- POLL 1: the delta finds the regression, the gate withholds, the cursor MOVES ON.
  const first = await poll()
  assert.equal(first.salesReversalsWithheld, 1)
  assert.equal(first.salesReversed, 0)
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [],
    'paidAt must NOT be cleared while a registration may be on the wire')
  const marker = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.ok(marker, 'the withheld verdict must leave a durable marker — it is the only way back')
  assert.equal(marker.metadata?.connector, 'quickbooks',
    'the marker must name its connector, or the scan cannot claim it (and Xero would)')
  assert.deepEqual(state.settingUpserts.map((u) => u.key), ['quickbooks_last_payment_poll'],
    'THE CURSOR STILL ADVANCES. Holding it for a withheld verdict is the freeze o3d-w00 records — '
    + 'the marker, not the cursor, is what brings this document back')

  // ---- The cause resolves LOCALLY, with nothing whatever happening in QuickBooks.
  state.syncLogs = [inFlightRegistration({ status: 'CANCELLED' })]
  // ...and the delta window is now empty, because the invoice has not been touched since poll 1.
  state.deltaBalanceDue = []
  state.settingUpserts = []
  state.queries = []
  ageMarkers(HOUR + 60_000)

  // ---- POLL 2: nothing the cursor can see, and the reversal happens anyway.
  const second = await poll()
  assert.deepEqual(state.queries.filter((q) => q.includes('Balance > ')).length > 0, true,
    'the delta read still runs — this test must not pass by the delta having been switched off')
  assert.ok(state.queries.some((q) => q === "Invoice: Id IN ('QI1')"),
    `the recheck must re-read the document BY ID, off the cursor entirely. Saw: ${JSON.stringify(state.queries)}`)
  assert.equal(second.withheldRechecked, 1)
  assert.equal(second.salesReversed, 1,
    'the withholding cause is gone and the ledger still reports a balance due, so the reversal is now '
    + 'admitted — and nothing in the delta window could have produced it')
  assert.deepEqual(state.chargebacks, ['so_1'])
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null).map((u) => u.id), ['so_1'])
  assert.equal(second.withheldResolved, 1)
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'),
    'and the marker is CLOSED, or the document is reconsidered for ever')
})

test('a withheld reversal that is STILL withheld is re-asked, not closed and not left to starve', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [inFlightRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  await poll()
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)
  const markersBefore = state.activityRows.filter((r) => r.action === 'payment_reversal_withheld').length

  const second = await poll()
  assert.equal(second.withheldRechecked, 1)
  assert.equal(second.salesReversed, 0, 'the registration is still PROCESSING, so nothing is decided')
  assert.equal(second.withheldResolved, 0)
  assert.equal(state.activityRows.filter((r) => r.action === 'payment_reversal_withheld').length,
    markersBefore + 1,
    'the marker is REWRITTEN, which restarts its timer — without that this document holds the head of '
    + 'an oldest-first page for ever and starves every other one')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false,
    'and it is NOT closed: still withheld is not settled')
})

test('a document QuickBooks did not return is DEFERRED, never closed', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [inFlightRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  await poll()
  // QuickBooks stops answering about this document at all (deleted, or a realm the token no longer
  // covers). "We did not hear" must never be spent as "there is nothing left to decide".
  state.qboDocuments.delete('QI1')
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)

  const second = await poll()
  assert.equal(second.withheldRechecked, 1)
  assert.equal(second.withheldResolved, 0)
  assert.equal(second.salesReversed, 0)
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_recheck_deferred'),
    'deferring rewrites the marker so the document goes to the BACK of the page rather than holding it')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false)
})

test('a marker written by the OTHER connector is not claimed by this recheck', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = []
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  // A Xero-written marker for the same order, an hour old and due — and a legacy one with no connector
  // at all, which belongs to Xero because Xero is the only poller that had a recheck before r4.
  state.activityRows.push(
    { entityType: 'SALES_ORDER', entityId: 'so_1', action: 'payment_reversal_withheld', tag: 'sync',
      metadata: { connector: 'xero' }, createdAt: new Date(Date.now() - HOUR - 60_000) },
    { entityType: 'SALES_ORDER', entityId: 'so_2', action: 'payment_reversal_withheld', tag: 'sync',
      metadata: null, createdAt: new Date(Date.now() - HOUR - 60_000) },
  )

  const result = await poll()
  assert.equal(result.withheldRechecked, 0,
    'both pollers write the same action names; claiming the other connector\'s markers would send '
    + 'QuickBooks asking about Xero invoice ids for ever')
  assert.equal(state.queries.some((q) => q.includes('Id IN')), false)
})

/** A registration that PROVABLY posted before any ledger read — decidable, but only against a fence. */
function postedRegistration(): Row {
  const at = new Date(Date.now() - 10 * 60_000)
  return inFlightRegistration({
    status: 'SYNCED',
    externalTransactionId: 'PAY-1',
    syncedAt: at,
    syncedAtDatabaseClock: at,
  })
}

test('a database fence that could not be read makes the poll INCOMPLETE, not clean', async () => {
  // THE CONTROL FIRST, so the arm below cannot pass by the reversal being impossible anyway: with a
  // readable fence this registration is decidable and the reversal is admitted.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  const control = await poll()
  assert.equal(control.salesReversed, 1, 'with a fence, a registration that posted before the read is decided')
  assert.deepEqual(state.settingUpserts.map((u) => u.key), ['quickbooks_last_payment_poll'])

  // ...and now the only thing that changes is the database clock.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']
  state.dbClockFails = true

  const result = await poll()
  assert.equal(result.salesReversed, 0, 'with no fence every registration might have landed after the '
    + 'snapshot, so nothing is decided')
  assert.equal(result.salesReversalsWithheld, 1)
  assert.deepEqual(state.settingUpserts, [],
    'and a window in which NOTHING could be decided must not be checkpointed past — that is a poll '
    + 'that did not do its job, not a clean one')
  assert.ok(result.errors.some((e) => /database clock could not be read/.test(e)),
    `the reason must be reported. Saw: ${JSON.stringify(result.errors)}`)
})
