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
  /**
   * Documents the by-id read is allowed to answer about, keyed by id.
   *
   * o3d-psrx r10 (Codex HIGH 2/3): `Balance` and `TotalAmt` are `unknown`, not `number`. QuickBooks
   * may serialise money as a string, and typing them as numbers here would make the very payload the
   * by-id defect turns on unwritable in this harness. `CurrencyRef` is on the row for the same reason
   * production reads it there: `qboQuery` issues `SELECT *`.
   */
  qboDocuments: new Map<string, { Id: string; Balance: unknown; TotalAmt: unknown; CurrencyRef?: unknown }>(),
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
      //
      // o3d-psrx r9: and they answer with the WHOLE ROW, because `qboQuery` issues `SELECT *` and the
      // amounts r8 made load-bearing are on it. Returning a bare `{ Id }` here — as this double did
      // until r9 — models a QuickBooks that states no figures at all, under which EVERY delta-found
      // reversal is withheld as unreadable and no test in this file can reach the reversal path it is
      // about. That is what silently broke the fence control below: it asserted a reversal that the
      // double had made impossible, for a reason having nothing to do with the fence.
      if (where?.startsWith('Balance > ')) {
        const rows = state.deltaBalanceDue.map((Id) => state.qboDocuments.get(Id) ?? { Id })
        return { ok: true, data: { QueryResponse: { [entity]: rows } } }
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

// ---------------------------------------------------------------------------
// o3d-psrx r9 (Codex HIGH) — THE PART-PAID DOCUMENT, END TO END.
//
// r8's gate refuses to reverse a document the ledger has not been shown to hold NOTHING on. Codex's
// finding is what that did to the case where the ledger states its position perfectly: a 100 document
// with 50 settled against it. `paidAt` stays set — which is right — and the verdict said only "IMS
// could not establish this", which is false and is what made the disagreement unfindable. The tests
// below drive the real poller and assert on what the MARKER carries, because the marker is the whole
// of what an operator has: there is no partial-settlement accounting path (o3d-cdhl) and IMS will
// never settle this document by itself.
//
// o3d-psrx r10 (Codex HIGH 1) renamed what they assert on. The verdict is `LEDGER_PARTIALLY_PAID` and
// its third figure is the OUTSTANDING amount, because `TotalAmt - Balance` cannot tell a document that
// lost a payment from one that was only ever part paid — see the shared-classifier tests.
// ---------------------------------------------------------------------------

test('[o3d-psrx r9] a PART-PAID QuickBooks document is recorded and quantified, not absorbed as paid', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  // A registration that PROVABLY posted before the read, so the registration half of the gate would
  // ADMIT. Without this the test could pass on the document being undecidable for some other reason,
  // and would say nothing about the amount rule at all.
  state.syncLogs = [postedRegistration()]
  // TotalAmt 100, Balance 50: QuickBooks accounts for half of this document and IMS holds all of it.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 50, TotalAmt: 100, CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  const first = await poll()

  // NOTHING IS REVERSED, which is r8's rule and is unchanged.
  assert.equal(first.salesReversed, 0,
    'reversing the whole document would credit the 50 QuickBooks still accounts for')
  assert.deepEqual(state.chargebacks, [], 'and no chargeback credit note is raised over it')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [])

  // ...AND THE DISAGREEMENT IS ON THE RECORD AS ONE. This is r9: before it, the marker said
  // LEDGER_NOT_PROVEN_ZERO_PAID — the same thing it says about a payload IMS cannot parse — so a
  // document whose figures IMS read perfectly and an unreadable response were one row, and neither
  // could be found.
  assert.equal(first.partiallyPaidDocuments, 1,
    'the poll must count this apart from the withheld verdicts that are merely undecided: it is the '
    + 'only one that will never resolve on its own')
  const marker = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.ok(marker, 'the withheld verdict must leave a durable marker — it is the only way back')
  assert.equal(marker.metadata?.registrationVerdict, 'LEDGER_PARTIALLY_PAID',
    'and the marker must say WHICH withheld state this is, or a document the ledger stated is '
    + 'indistinguishable from a figure IMS could not read')
  // THE FIGURES AS FIELDS, not only inside the sentence: the numbers have to be queryable, or the
  // only way to find every unreconciled disagreement is to read English.
  assert.equal(marker.metadata?.ledgerPartiallyPaid, true)
  assert.equal(marker.metadata?.ledgerPaidAmount, 50)
  assert.equal(marker.metadata?.documentTotal, 100)
  assert.equal(marker.metadata?.outstandingAmount, 50)
  // o3d-psrx r10 (Codex HIGH 1/3): AND THE CURRENCY THEY ARE IN. A bare 50 filed beside amounts from
  // other documents is not a figure anybody can add up, and the threshold that classified it is
  // itself currency-dependent.
  assert.equal(marker.metadata?.ledgerCurrency, 'GBP')
  assert.equal(marker.metadata?.removedAmount, undefined,
    'and NOT a removed amount: these two figures cannot establish that anything was taken away')
  assert.match(String(marker.description), /50/)
  assert.match(String(marker.description), /100/)
  assert.match(String(marker.description), /WILL NOT correct that by itself/,
    'the operator must be told IMS does not reconcile this, or they wait for a poll that never comes')
  assert.match(String(marker.description), /only ever part paid/i,
    'o3d-psrx r10 (Codex HIGH 1): and the warning must say what these figures do NOT establish. A '
    + 'document that was only ever part paid states exactly the same TotalAmt and Balance as one a '
    + 'payment was taken back from, so telling an operator a payment was removed asserts a history '
    + 'IMS has not got')

  // ---- AND IT COMES BACK, for ever, off the delta cursor. A document that stays part paid never
  // reaches a zero paid amount, so nothing about it resolves — which is why it must not be closed.
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)
  const markersBefore = state.activityRows.filter((r) => r.action === 'payment_reversal_withheld').length

  const second = await poll()
  assert.equal(second.withheldRechecked, 1)
  assert.equal(second.partiallyPaidDocuments, 1, 'the recheck reaches the same stated answer')
  assert.equal(second.salesReversed, 0)
  assert.equal(state.activityRows.filter((r) => r.action === 'payment_reversal_withheld').length,
    markersBefore + 1, 'the marker is REWRITTEN, which restarts its timer and keeps the page a round robin')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false,
    'and it is NOT closed: a disagreement nobody has acted on is not a settled document')
})

test('[o3d-psrx r9] CONTROL: a FULL chargeback on the same order still reverses on the zero proof', async () => {
  // The same order, the same registration, the same delta — differing ONLY in what QuickBooks says it
  // still holds. Without this the test above is satisfied by a poller that withholds everything, which
  // would be a worse defect than the one r9 fixes.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 100, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  const result = await poll()
  assert.equal(result.salesReversed, 1,
    'QuickBooks states it holds NOTHING on this document, which is the proof r8 requires — the '
    + 'part-paid verdict must narrow what reverses, not switch the reversal pass off')
  assert.equal(result.partiallyPaidDocuments, 0, 'and nothing part-paid is reported about it')
  assert.deepEqual(state.chargebacks, ['so_1'])
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null).map((u) => u.id), ['so_1'])
})

test('[o3d-psrx r9] an ordinary FULLY PAID document produces no marker and no partial report', async () => {
  // THE TEST THAT STOPS THE FIX CRYING WOLF. A rule that read every "paid is less than the total" as
  // something to warn about would fire on documents that have nothing wrong with them, and an operator
  // shown a warning on a settled order learns to ignore the ones that are real.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  // Balance 0: QuickBooks holds the whole 100. It is therefore not in the `Balance > 0` delta at all.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 0, TotalAmt: 100 })
  state.deltaBalanceDue = []

  const clean = await poll()
  assert.equal(clean.salesReversalsWithheld, 0)
  assert.equal(clean.partiallyPaidDocuments, 0)
  assert.equal(clean.salesReversed, 0)
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld'), false,
    'a document nobody has a disagreement about must leave no marker whatever')

  // ---- AND THE SAME THING SAID THROUGH THE LIFECYCLE: a part-paid document that is PUT RIGHT stops
  // being reported. This is the one route by which a fully-paid document reaches the recheck at all,
  // and it must close the marker rather than write another part-paid one.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 50, TotalAmt: 100 })
  state.deltaBalanceDue = ['QI1']

  const partial = await poll()
  assert.equal(partial.partiallyPaidDocuments, 1, 'the precondition: there IS an open disagreement to settle')

  // The operator re-applies the payment in QuickBooks. Nothing else changes.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 0, TotalAmt: 100 })
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)

  const settled = await poll()
  assert.equal(settled.withheldRechecked, 1)
  assert.equal(settled.partiallyPaidDocuments, 0,
    'the document is whole again, so there is nothing left to report')
  assert.equal(settled.withheldResolved, 1)
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'),
    'and the marker is CLOSED — a disagreement that has been settled must leave the page')
  assert.equal(settled.salesReversed, 0, 'nothing is reversed: the document is fully paid')
})

// ---------------------------------------------------------------------------
// o3d-psrx r10 (Codex HIGH 2) — TWO READERS OF ONE FIELD, AND THE STRICTER ONE CLOSED THE MARKER.
//
// The by-id recheck decided void/balance-due with `typeof row.Balance === 'number'`, while the amount
// reader on the very next line went through `parseLedgerAmount`, which deliberately accepts a numeric
// STRING. A payload serialising `Balance` as "50.00" therefore failed the strict test: the document
// was recorded as RETURNED with no disagreement against it, and the recheck's closing loop reads
// "returned, nothing still withheld, no error" as SETTLED — so it closed the marker while the ledger
// and IMS still disagreed, and nothing would ever bring the document back.
//
// The route matters: this cannot be reached through the delta pass, which never applied the strict
// test. It needs a marker written on poll 1 and reconsidered by the BY-ID read on poll 2.
// ---------------------------------------------------------------------------

test('[o3d-psrx r10] a numeric-string Balance keeps the withheld marker OPEN', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  // QuickBooks serialising both figures as strings. `parseLedgerAmount` reads them; `typeof x ===
  // 'number'` does not.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '50.00', TotalAmt: '100.00', CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  // ---- POLL 1, through the DELTA read, which has always parsed strings. The marker is written.
  const first = await poll()
  assert.equal(first.partiallyPaidDocuments, 1,
    'the precondition: the delta pass must reach the part-paid verdict on a string payload, or poll 2 '
    + 'has no marker to reconsider and this test proves nothing')
  assert.equal(first.salesReversed, 0)

  // ---- POLL 2, through the BY-ID read, with the delta window empty. This is the defect's route.
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)
  const second = await poll()

  assert.ok(state.queries.some((q) => q === "Invoice: Id IN ('QI1')"),
    `the recheck must actually have re-read the document by id. Saw: ${JSON.stringify(state.queries)}`)
  assert.equal(second.withheldRechecked, 1, 'and the marker must have been due, or nothing was decided')
  // THE HEADLINE. Under the two-reader bug the by-id row is returned, contributes no balance due, and
  // the closing loop reads "returned + nothing withheld + no error" as SETTLED.
  assert.equal(second.withheldResolved, 0,
    'a document the ledger still reports a balance on must NOT be closed as settled because its '
    + 'Balance arrived as a string')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false,
    'and no closure row is written for it')
  assert.equal(second.partiallyPaidDocuments, 1,
    'the recheck reaches the same stated answer through the by-id read as the delta read did')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [],
    'and nothing about paidAt moves in either direction')
})

test('[o3d-psrx r10] CONTROL: a string TotalAmt of zero is still recognised as VOIDED', async () => {
  // The other half of the same one-parse change. `typeof row.TotalAmt === 'number' && === 0` was the
  // void test; a payload stating "0.00" would have failed it, and a voided document would have stopped
  // reversing. Paired here so the fix cannot have been "treat everything as balance due".
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '100.00' })
  state.deltaBalanceDue = ['QI1']

  // Poll 1 leaves a marker: QuickBooks states the document fully settled, which is UNPROVEN, not a
  // reversal — the same reading a payload IMS cannot read gets.
  const first = await poll()
  assert.equal(first.salesReversalsWithheld, 1, 'the precondition: a marker exists to reconsider')
  assert.equal(first.salesReversed, 0)

  // ...and now QuickBooks zeroes the document, stating the zero as a STRING.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '0.00' })
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)

  const second = await poll()
  assert.equal(second.salesReversed, 1,
    'a VOIDED document must still reverse when its zero total arrives as a string — the one-parse '
    + 'change must not have made the void test unreachable')
  assert.deepEqual(state.chargebacks, [],
    'and a voided document raises NO chargeback: QuickBooks has already reversed the AR')
})

// ---------------------------------------------------------------------------
// o3d-psrx r10 (Codex HIGH 3) — THE THRESHOLD BELONGS TO THE DOCUMENT'S CURRENCY.
//
// `PAYMENT_PRESENT_EPSILON` is 0.005 and is documented for Xero's two-decimal amounts. This poller
// receives QuickBooks documents, and the repository supports three- and four-decimal currencies, in
// which 0.005 is five whole minor units or fifty. Under the fixed threshold a Kuwaiti dinar document
// still holding 0.001 read as holding NOTHING, the registration gate admitted, and `paidAt` was
// cleared with a full chargeback credit note raised over a document the ledger was still accounting
// for. That is the o3d-psrx defect itself, reached through the tolerance rather than through the
// verdict.
//
// The pair below differs in the CURRENCY CODE and in nothing else — same total, same balance, same
// order, same registration — and the outcomes are opposite. A fixed epsilon cannot produce that.
// ---------------------------------------------------------------------------

test('[o3d-psrx r10] the smallest amount a 3-decimal currency can hold is not treated as zero', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  // KWD is a 3-decimal currency: 0.001 is ONE minor unit, the smallest amount that can exist in it.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 99.999, TotalAmt: 100, CurrencyRef: { value: 'KWD' } })
  state.deltaBalanceDue = ['QI1']

  const kwd = await poll()
  assert.equal(kwd.salesReversed, 0,
    'THE FINDING: QuickBooks states one whole minor unit is still settled on this document, so it has '
    + 'NOT been shown to hold nothing — reversing it credits money the ledger is still accounting for')
  assert.deepEqual(state.chargebacks, [], 'and no chargeback credit note is raised over it')
  assert.equal(kwd.partiallyPaidDocuments, 1, 'it is reported as the part-paid document it is')
  const marker = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.equal(marker?.metadata?.registrationVerdict, 'LEDGER_PARTIALLY_PAID')
  assert.equal(marker?.metadata?.ledgerCurrency, 'KWD')

  // THE CONTROL, and it is the whole proof that the threshold is currency-derived rather than merely
  // smaller: the SAME figures in a two-decimal currency really are nothing. 0.001 GBP is not an
  // amount that exists, so the ledger holds nothing and a genuine chargeback still reverses.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: 99.999, TotalAmt: 100, CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  const gbp = await poll()
  assert.equal(gbp.salesReversed, 1,
    'the same figures in GBP ARE nothing — a threshold that is simply smaller everywhere would have '
    + 'switched this reversal off too, and narrowing the pass is not the same as disabling it')
  assert.equal(gbp.partiallyPaidDocuments, 0)
  assert.deepEqual(state.chargebacks, ['so_1'])
})

// ---------------------------------------------------------------------------
// o3d-psrx r11 (Codex HIGH) — A FIGURE `Number()` HAPPENS TO READ IS NOT A FIGURE QUICKBOOKS STATED.
//
// `parseLedgerAmount` handed its string branch to `Number()`, which accepts radix-prefixed literals.
// `Balance: "0x64"` therefore read as 100; against a `TotalAmt` of 100 that makes paid = 0, which is
// HOLDS_NOTHING — the exact proof the registration gate is waiting for. A posted registration then
// admits the reversal: `paidAt` cleared and a chargeback credit note raised over a document nobody
// ever said was unpaid.
//
// The pair below is the two halves of the fix, on the two routes that reach the two halves:
//   - the DELTA read, where the invented number steered the reversal itself;
//   - the BY-ID recheck, where the refusal must not become a settlement. An unreadable Balance
//     contributes no balance due, and the closing loop reads "returned + nothing withheld + no
//     error" as SETTLED — so the stricter parser would have CLOSED the marker on the very document
//     it refused to read.
// ---------------------------------------------------------------------------

test('[o3d-psrx r11] a hex-literal Balance does not steer a QuickBooks reversal', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  // POSTED, not in flight: the registration evidence is clean, so nothing but the amount reading is
  // holding this reversal back. That is what makes the invented zero decisive here.
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0x64', TotalAmt: '100.00', CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  const first = await poll()

  assert.equal(first.salesReversed, 0,
    'THE FINDING: "0x64" is not an amount QuickBooks stated in decimal money. Read as 100 it makes '
    + 'paid = 0 on a total of 100, the ledger appears to have PROVEN it holds nothing, and the '
    + 'reversal is admitted on a number IMS invented')
  assert.deepEqual(state.chargebacks, [],
    'and no chargeback credit note is raised against revenue on the strength of it')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [],
    'and paidAt is not cleared')
  assert.equal(first.salesReversalsWithheld, 1,
    'the unreadable figure WITHHOLDS — refusing is not the same as answering zero, and a refusal that '
    + 'came back as 0 would be indistinguishable from the reversal itself')
  const marker = state.activity.find((a) => a.action === 'payment_reversal_withheld')
  assert.equal(marker?.metadata?.registrationVerdict, 'LEDGER_NOT_PROVEN_ZERO_PAID',
    'and it is withheld for want of a LEDGER reading, not for want of registration evidence — the '
    + 'registration here is posted and clean')
})

test('[o3d-psrx r11] a Balance IMS could not read DEFERS the marker, it never closes it as settled', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0x64', TotalAmt: '100.00', CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  const first = await poll()
  assert.equal(first.salesReversalsWithheld, 1,
    'the precondition: poll 1 must leave a marker, or poll 2 reconsiders nothing and this test proves nothing')

  // ---- POLL 2, through the BY-ID read, with the delta window empty. QuickBooks says the same thing.
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)
  const second = await poll()

  assert.ok(state.queries.some((q) => q === "Invoice: Id IN ('QI1')"),
    `the recheck must actually have re-read the document by id. Saw: ${JSON.stringify(state.queries)}`)
  assert.equal(second.withheldRechecked, 1, 'and the marker must have been due, or nothing was decided')
  assert.equal(second.withheldResolved, 0,
    'THE SECOND HALF: the document came back, contributed no balance due (nobody could read its '
    + 'Balance) and nothing was still withheld — which the closing loop reads as SETTLED. Spending '
    + '"we could not read it" as "there is nothing left to decide" is the r10 defect through a parser')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false,
    'so no closure row is written for it')
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_recheck_deferred'),
    'it is DEFERRED instead, which rewrites the marker and sends the document to the back of the page')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [])
})

test('[o3d-psrx r11] CONTROL: a decimal-string Balance the ledger settles still CLOSES its marker', async () => {
  // The control for the defer above, and the whole reason it is keyed on UNREADABLE rather than on
  // "no balance due": a document QuickBooks states as settled in ordinary decimal money must still
  // close, or the recheck page fills up with markers that can never resolve.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [inFlightRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '100.00', TotalAmt: '100.00' })
  state.deltaBalanceDue = ['QI1']

  const first = await poll()
  assert.equal(first.salesReversalsWithheld, 1, 'the precondition: a marker exists to reconsider')

  // The registration finishes and QuickBooks now states the document fully settled — a real zero,
  // stated as a string, which the grammar reads.
  state.syncLogs = [inFlightRegistration({ status: 'CANCELLED' })]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '100.00' })
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)

  const second = await poll()
  assert.equal(second.withheldRechecked, 1)
  assert.equal(second.withheldResolved, 1,
    'a stated zero is a READING, and the disagreement it settles must still close — the r11 defer '
    + 'must fire on unreadable figures only')
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'))
})

// ---------------------------------------------------------------------------
// o3d-psrx r12 (Codex HIGH 2) — THE UNREADABLE SET COVERED ONE FIELD OF TWO.
//
// r11 added `unreadable` so that a refused amount could not close a marker, and pointed it at
// `Balance`. The escape is the other figure the same rows carry. On `Balance: "0.00", TotalAmt:
// "0x0"`:
//   - the balance is READABLE and zero, so nothing is due and the document never becomes a
//     reversal candidate — it cannot be withheld;
//   - the total is REFUSED, so `isVoided` is false and r11's `parsed.balance === null` never fires;
//   - the closing loop therefore sees returned + nothing withheld + no error, and CLOSES the marker
//     as settled, having never read QuickBooks' statement of what the document is worth.
//
// The fix is stated over BOTH figures the decision reads rather than over the field that was named:
// every non-void row with an unreadable `Balance` OR an unreadable `TotalAmt` is unreadable. (The
// other two fields on the row cannot close: an unmatched `Id` leaves the document out of `returned`
// and defers, and a missing `CurrencyRef` takes the FINEST epsilon, which only ever withholds more.)
// ---------------------------------------------------------------------------

test('[o3d-psrx r12] a readable zero Balance with an unreadable TotalAmt DEFERS, it never closes', async () => {
  reset()
  state.salesOrders = [paidOrderRow()]
  // POSTED and clean, so nothing but the amount reading decides anything here.
  state.syncLogs = [postedRegistration()]
  // THE SHAPE FROM THE FINDING, and it is one document held throughout: a stated zero balance beside
  // a total that is not decimal money.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '0x0', CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  // ---- POLL 1, through the DELTA read, which writes the marker.
  const first = await poll()
  assert.equal(first.salesReversalsWithheld, 1,
    'the precondition: poll 1 must leave a marker, or poll 2 reconsiders nothing and this test '
    + 'proves nothing. The total is unreadable, so `paid` is null and the gate withholds')
  assert.equal(first.salesReversed, 0)
  assert.deepEqual(state.chargebacks, [])

  // ---- POLL 2, through the BY-ID read, with the delta window empty. This is the defect's route.
  state.deltaBalanceDue = []
  ageMarkers(HOUR + 60_000)
  const second = await poll()

  assert.ok(state.queries.some((q) => q === "Invoice: Id IN ('QI1')"),
    `the recheck must actually have re-read the document by id. Saw: ${JSON.stringify(state.queries)}`)
  assert.equal(second.withheldRechecked, 1, 'and the marker must have been due, or nothing was decided')
  assert.equal(second.withheldResolved, 0,
    'THE FINDING: a readable zero Balance makes this document a non-candidate, so nothing is '
    + 'withheld against it — and with only `Balance` watched the closing loop reads "returned, '
    + 'nothing withheld, no error" as SETTLED and closes the marker over a total nobody could read')
  assert.equal(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'), false,
    'so no closure row is written for it')
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_recheck_deferred'),
    'it is DEFERRED instead, which rewrites the marker and sends the document to the back of the page')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [],
    'and nothing about paidAt moves in either direction')

  // ---- POLL 3, THE CONTROL ON THE SAME ROUTE AND THE SAME DOCUMENT. QuickBooks states the total in
  // ordinary decimal money; the document is genuinely settled, and it must CLOSE. Without this the
  // fix could have been "defer everything", which fills the recheck page with markers that never go.
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '100.00', CurrencyRef: { value: 'GBP' } })
  ageMarkers(HOUR + 60_000)
  const third = await poll()

  assert.equal(third.withheldRechecked, 1)
  assert.equal(third.withheldResolved, 1,
    'both figures are READINGS now and they agree with IMS, so the disagreement is over and the '
    + 'marker must be closed')
  assert.ok(state.activity.some((a) => a.action === 'payment_reversal_withheld_cleared'))
  assert.equal(third.salesReversed, 0, 'and a settled document is not reversed on its way out')
  assert.deepEqual(state.chargebacks, [])
})

test('[o3d-psrx r12] CONTROL: an unreadable TotalAmt of ZERO is not read as a void', async () => {
  // The void exemption is what makes `unreadable` skip a zeroed document, and it must rest on a
  // READ zero. "0x0" is `Number()`'s zero, not QuickBooks'; if the exemption were reached through it
  // the document would be reversed — paidAt cleared with no chargeback — on a number IMS invented.
  reset()
  state.salesOrders = [paidOrderRow()]
  state.syncLogs = [postedRegistration()]
  state.qboDocuments.set('QI1', { Id: 'QI1', Balance: '0.00', TotalAmt: '0x0', CurrencyRef: { value: 'GBP' } })
  state.deltaBalanceDue = ['QI1']

  const only = await poll()
  assert.equal(only.salesReversed, 0,
    'a hexadecimal zero total is not a void: QuickBooks never said this document was zeroed')
  assert.deepEqual(state.salesOrderUpdates.filter((u) => u.data.paidAt === null), [])
  assert.equal(only.salesReversalsWithheld, 1)
})
