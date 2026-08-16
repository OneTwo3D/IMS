import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 2 — the processor's own use of issuer provenance.
//
// TWO WINDOWS, both closed here. The row's stamp used to come from
// activeAccountingIdProvenance() called AFTER processEntry returned, and updateBackReference then
// called it AGAIN — so one post could stamp its sync row with realm A and its document with realm B,
// with nothing afterwards able to reconcile the two. And the `externalTransactionId` retry branch
// never looked at the row's stored provenance at all: it handed a legacy or foreign id straight to
// the back-reference writer, which attributed it to whoever happened to be connected.
//
// THE DOUBLES MODEL THE RACE RATHER THAN NARRATING IT. `pushPurchaseBill` below does what the real
// HTTP client does — it notes the realm it talked to — and then MUTATES the stored token, so every
// later sample returns a different realm. A processor that resamples cannot pass; a processor that
// carries the captured value cannot fail. The db double interprets its where clauses, so a fenced
// write that stopped being fenced would show up as the wrong row changing.
// ---------------------------------------------------------------------------

const REALM_A = 'quickbooks:realm-A'
const REALM_B = 'quickbooks:realm-B'

type SyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  provenance: string | null
  payload: Record<string, unknown>
  errorMessage: string | null
  retryCount: number
  processingStartedAt: Date | null
  syncedAt: Date | null
  createdAt: Date
}

type BillRow = { id: string; accountingInvoiceId: string | null; accountingInvoiceProvenance: string }

const state: {
  syncRows: SyncRow[]
  bills: BillRow[]
  /** The realm the AccountingToken row currently names. Mutated mid-post by the doubles. */
  connectedRealm: string | null
  /** What the push double reports to the issuer capture, i.e. where the request really went. */
  postedToRealm: string
  activities: Array<{ action: string; level?: string; description?: string; metadata?: Record<string, unknown> }>
} = { syncRows: [], bills: [], connectedRealm: 'realm-A', postedToRealm: REALM_A, activities: [] }

function syncRow(overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'PURCHASE_INVOICE',
    status: 'PENDING',
    referenceType: 'PurchaseInvoice',
    referenceId: 'bill-1',
    externalTransactionId: null,
    provenance: null,
    payload: { contactName: 'Acme', date: '2026-08-01', currency: 'GBP', lines: [] },
    errorMessage: null,
    retryCount: 0,
    processingStartedAt: null,
    syncedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  }
}

/** Minimal where matching — enough for the claim fence and the FAILED-row lookups. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matches(row, clause))) return false
      continue
    }
    const value = row[key] ?? null
    if (condition === null) { if (value !== null) return false; continue }
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>
      if ('in' in ops && !(ops.in as unknown[]).includes(value)) return false
      if ('lt' in ops && !((value as number) < (ops.lt as number))) return false
      if ('lte' in ops && !(value === null || (value as number) <= (ops.lte as number))) return false
      if ('gte' in ops && !((value as number) >= (ops.gte as number))) return false
      if ('not' in ops) {
        if (ops.not === null) { if (value === null) return false } else if (value === ops.not) return false
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

const db = {
  accountingToken: {
    async findUnique() {
      return state.connectedRealm === null ? null : { tenantId: state.connectedRealm }
    },
  },
  accountingSyncLog: {
    async findMany(args: { where: Record<string, unknown> }) {
      return state.syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, args.where)).map((row) => ({ ...row }))
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const rows = state.syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, args.where))
      for (const row of rows) Object.assign(row, args.data)
      return { count: rows.length }
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.syncRows.find((candidate) => candidate.id === args.where.id)
      if (!row) throw new Error(`no sync row ${args.where.id}`)
      Object.assign(row, args.data)
      return row
    },
    async create(args: { data: Record<string, unknown> }) {
      state.syncRows.push(syncRow({ id: `log-${state.syncRows.length + 1}`, ...args.data } as Partial<SyncRow>))
      return {}
    },
    async count(args: { where: Record<string, unknown> }) {
      return state.syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, args.where)).length
    },
  },
  purchaseInvoice: {
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const bill = state.bills.find((candidate) => candidate.id === args.where.id)
      if (!bill) throw new Error(`no bill ${args.where.id}`)
      Object.assign(bill, args.data)
      return bill
    },
    async findUnique(args: { where: { id: string } }) {
      return state.bills.find((candidate) => candidate.id === args.where.id) ?? null
    },
    async findFirst() { return null },
    async findMany() { return [] },
    async updateMany() { return { count: 0 } },
  },
  salesOrder: { async findUnique() { return null }, async update() { return {} } },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
  supplierCreditNote: { async findUnique() { return null }, async update() { return {} } },
  purchaseOrder: { async findUnique() { return null } },
  setting: { async findUnique() { return null }, async upsert() { return {} } },
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(db) },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string }) => { state.activities.push(entry); return true },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/domain/accounting/cancel-order-invoice-sync', {
  namedExports: { retireSalesInvoiceForCancelledOrder: async () => {} },
})
mock.module('@/lib/accounting', {
  namedExports: { lookupPaymentAccount: () => null, getPaymentAccountMap: async () => ({}) },
})
mock.module('@/lib/upload-storage', { namedExports: { resolveStoredInvoiceUploadPath: () => null } })
mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboPost: async () => ({ ok: false }),
    qboPostIdempotent: async () => ({ ok: false }),
    qboUploadAttachment: async () => ({ ok: false }),
    resolveAccountRef: async () => null,
  },
})
mock.module('@/lib/connectors/quickbooks/invoices', { namedExports: { pushSalesInvoice: async () => ({ success: false }) } })
mock.module('@/lib/connectors/quickbooks/credit-notes', { namedExports: { pushCreditMemo: async () => ({ success: false }) } })
mock.module('@/lib/connectors/quickbooks/journals', { namedExports: { pushJournalEntry: async () => ({ success: false }) } })
mock.module('@/lib/connectors/quickbooks/bills', {
  namedExports: {
    // THE RACE, executed rather than described. The realm this request goes to is noted the way the
    // real client notes it — and then the connection changes, so anything sampled after this point
    // reports the OTHER company.
    pushPurchaseBill: async () => {
      const { noteIssuerProvenance } = await import('@/lib/domain/accounting/issuer-provenance')
      for (const realm of state.postedToRealm.split('|')) noteIssuerProvenance(realm)
      state.connectedRealm = 'realm-B'
      return { success: true, invoiceId: '42' }
    },
  },
})

function reset(rows: SyncRow[], bills: BillRow[] = [{ id: 'bill-1', accountingInvoiceId: null, accountingInvoiceProvenance: '' }]) {
  state.syncRows = rows
  state.bills = bills
  state.connectedRealm = 'realm-A'
  state.postedToRealm = REALM_A
  state.activities = []
}

test('[o3d-9kek r4 f2] the id is stamped with the realm it was POSTED to, not the one connected afterwards', async () => {
  reset([syncRow()])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  const result = await processPendingQuickBooksSync()
  assert.equal(result.succeeded, 1)

  // The connection moved to realm B while the bill was posting — that is the whole point of the
  // double — and both writes must still say realm A.
  assert.equal(state.connectedRealm, 'realm-B', 'the race really did happen')
  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')!
  assert.equal(row.externalTransactionId, '42')
  assert.equal(row.provenance, REALM_A, 'the sync row records the ISSUING realm')
  // And the document agrees with the row. Under the old code updateBackReference took its own
  // sample, so this one said realm B while the row said realm A — one post, two irreconcilable
  // records of which company it went to.
  assert.equal(state.bills[0].accountingInvoiceId, '42')
  assert.equal(state.bills[0].accountingInvoiceProvenance, REALM_A)
})

test('[o3d-9kek r4 f2] a post whose issuing realm cannot be established is RETAINED as FAILED, never attributed', async () => {
  reset([syncRow()])
  // Two realms seen inside one entry: the id belongs to one of them and the references inside the
  // document to the other. There is no honest single value, so none is written.
  state.postedToRealm = `${REALM_A}|${REALM_B}`
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  const result = await processPendingQuickBooksSync()
  assert.equal(result.failed, 1)

  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')!
  // The id IS kept: the document exists in someone's ledger and losing the id would orphan it and
  // invite a duplicate post.
  assert.equal(row.externalTransactionId, '42')
  // The provenance is NOT invented, and the row is not quietly marked SYNCED — which is what left
  // rows the sweep's exact-provenance match permanently excludes while the code promised a retry.
  assert.equal(row.provenance, null)
  assert.equal(row.status, 'FAILED')
  assert.match(row.errorMessage ?? '', /connection changed/)
  assert.equal(state.bills[0].accountingInvoiceId, null, 'nothing was linked')
  assert.ok(state.activities.some((entry) => entry.action === 'quickbooks_issuer_provenance_unavailable'))
})

test('[o3d-9kek r4 f2] a retry of a row with NO recorded issuer is refused, not re-attributed to whoever is connected', async () => {
  // The legacy population: an external id recorded before ids were namespaced. It is an integer, and
  // integers repeat across QuickBooks companies, so "the realm connected now" is a guess dressed as
  // a fact.
  reset([syncRow({ externalTransactionId: '42', provenance: null })])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  const result = await processPendingQuickBooksSync()
  assert.equal(result.failed, 1)

  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')!
  assert.equal(row.status, 'FAILED')
  assert.match(row.errorMessage ?? '', /unknown \(recorded before ids were namespaced\)/)
  assert.equal(state.bills[0].accountingInvoiceId, null, 'a legacy id must not land on this company\'s bill')
  assert.ok(state.activities.some((entry) => entry.action === 'quickbooks_external_id_provenance_refused'))
})

test('[o3d-9kek r4 f2] a retry of a FOREIGN realm\'s id is refused too', async () => {
  reset([syncRow({ externalTransactionId: '42', provenance: REALM_B })])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')!
  assert.equal(row.status, 'FAILED')
  assert.equal(state.bills[0].accountingInvoiceId, null)
})

test('[o3d-9kek r4 f2] a retry of THIS realm\'s own id proceeds, and links the bill', async () => {
  // The guard must not turn the idempotency branch into a brick wall: a row whose recorded issuer IS
  // the connected company is exactly the case this branch exists for.
  reset([syncRow({ externalTransactionId: '42', provenance: REALM_A })])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  const result = await processPendingQuickBooksSync()
  assert.equal(result.succeeded, 1)
  assert.equal(state.syncRows[0].status, 'SYNCED')
  assert.equal(state.bills[0].accountingInvoiceId, '42')
  assert.equal(state.bills[0].accountingInvoiceProvenance, REALM_A)
})

test('[o3d-9kek r4 f2] a retry with the connector DISCONNECTED is held, not terminalised', async () => {
  // "No company connected" says nothing about who issued the id — it is a transient condition, and
  // burning the row to FAILED for it would turn every disconnect window into permanent manual work.
  reset([syncRow({ externalTransactionId: '42', provenance: REALM_A })])
  state.connectedRealm = null
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')!
  assert.equal(row.status, 'PENDING', 'held for the next run')
  assert.equal(row.retryCount, 0, 'and no retry burned for something the row did not do wrong')
  assert.equal(state.bills[0].accountingInvoiceId, null)
})
