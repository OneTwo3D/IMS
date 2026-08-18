import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { adapterUniqueViolation } from '../helpers/prisma-unique-error'

// ---------------------------------------------------------------------------
// o3d-9kek — QuickBooks writes its back-references through the SHARED writer.
//
// QuickBooks used to keep its own copy of the back-reference logic: a per-type switch whose
// PurchaseOrder branch wrote the external id onto "the newest bill on this PO with no id yet", and
// whose bill-keyed branch issued a bare `update`. That copy is how the two connectors drifted —
// Xero's refusal to guess, the per-PO advisory lock, the compare-and-swap and the unique-index
// handling all lived in lib/domain/accounting/back-reference.ts and none of them were reachable
// from here.
//
// These tests are the guard on that. They drive the real processPendingQuickBooksSync down its
// idempotency-retry branch (a row that already carries an externalTransactionId posts nothing, so
// no HTTP client has to be simulated) and assert two properties that ONLY the shared writer has:
//
//   1. an ambiguous PO is REFUSED — the hand-rolled version wrote the newest unlinked bill, which
//      is precisely the wrong-bill write the whole area exists to prevent;
//   2. an unambiguous PO is written inside a transaction that took the per-PO advisory lock — a
//      bare `update` takes no lock and would leave rawStatements empty.
// ---------------------------------------------------------------------------

type SyncRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: Record<string, unknown>
  retryCount: number
  processingStartedAt: Date | null
  createdAt: Date
  /** Written by the quarantine path (r7 finding 1) — the durable half of the conflict record. */
  errorMessage?: string | null
}

type BillRow = { id: string; poId: string; accountingInvoiceId: string | null; createdAt: number }

const state = {
  syncRows: [] as SyncRow[],
  bills: [] as BillRow[],
  activities: [] as Array<{ action: string; description?: string; metadata?: Record<string, unknown> }>,
  rawStatements: [] as Array<{ sql: string; values: unknown[] }>,
  billUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}

/** Honours the predicates production depends on, so a dropped one cannot pass silently. */
function billMatches(bill: BillRow, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = (bill as unknown as Record<string, unknown>)[key] ?? null
    if (condition === null) {
      if (value !== null) return false
    } else if (value !== condition) {
      return false
    }
  }
  return true
}

const billClient = {
  async findFirst(args: { where: Record<string, unknown> }) {
    const bill = state.bills
      .filter((candidate) => billMatches(candidate, args.where))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return bill ? { id: bill.id, poId: bill.poId } : null
  },
  async findMany(args: { where: Record<string, unknown>; take?: number }) {
    const bills = state.bills
      .filter((candidate) => billMatches(candidate, args.where))
      .sort((a, b) => b.createdAt - a.createdAt)
    return (args.take ? bills.slice(0, args.take) : bills).map((bill) => ({ id: bill.id }))
  },
  async findUnique(args: { where: { id: string } }) {
    const bill = state.bills.find((candidate) => candidate.id === args.where.id)
    return bill ? { accountingInvoiceId: bill.accountingInvoiceId } : null
  },
  async update(args: { where: { id: string }; data: Record<string, unknown> }) {
    const bill = state.bills.find((candidate) => candidate.id === args.where.id)
    if (!bill) throw new Error(`fake db: no bill ${args.where.id}`)
    // purchase_invoices.accounting_invoice_id is UNIQUE, globally, on the value alone. Raised the
    // way Prisma raises it, so the writer's conflict classification is exercised rather than
    // assumed — and so the QuickBooks catch below actually has an exception to swallow.
    // In the LIVE ADAPTER'S shape (o3d-9kek r7 finding 2): `meta.target` is undefined under
    // `@prisma/adapter-pg` and the columns arrive at driverAdapterError.cause.constraint.fields.
    const externalId = args.data.accountingInvoiceId
    if (typeof externalId === 'string' && state.bills.some((other) => other.id !== bill.id && other.accountingInvoiceId === externalId)) {
      throw adapterUniqueViolation(['accounting_invoice_id'], {
        modelName: 'PurchaseInvoice',
        constraintName: 'purchase_invoices_accounting_invoice_id_key',
      })
    }
    state.billUpdates.push({ id: bill.id, data: args.data })
    Object.assign(bill, args.data)
    return bill
  },
  async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
    const matched = state.bills.filter((candidate) => billMatches(candidate, args.where))
    for (const bill of matched) {
      state.billUpdates.push({ id: bill.id, data: args.data })
      Object.assign(bill, args.data)
    }
    return { count: matched.length }
  },
}

const db = {
  accountingSyncLog: {
    async findMany() { return state.syncRows.map((row) => ({ ...row })) },
    async updateMany() { return { count: 1 } },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.syncRows.find((candidate) => candidate.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return row
    },
    async count(args: { where: Record<string, unknown> }) {
      const where = args.where as { referenceId?: string; externalTransactionId?: { not: null } }
      return state.syncRows.filter((row) => row.referenceId === where.referenceId && row.externalTransactionId !== null).length
    },
  },
  salesOrder: { async findUnique() { return null }, async update() { return {} } },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
  supplierCreditNote: { async findUnique() { return null }, async update() { return {} } },
  purchaseInvoice: billClient,
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    return fn({
      ...db,
      async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
        state.rawStatements.push({ sql: query.join('?'), values })
        return 0
      },
    })
  },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; description?: string; metadata?: Record<string, unknown> }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string; description?: string; metadata?: Record<string, unknown> }) => { state.activities.push(entry); return true },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})

function poRow(externalTransactionId: string): SyncRow {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseOrder',
    referenceId: 'po-1',
    externalTransactionId,
    status: 'PENDING',
    // No supplierInvoicePath, so the follow-up enqueue is a no-op and nothing else has to be mocked.
    payload: {},
    retryCount: 0,
    processingStartedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function reset(bills: BillRow[]) {
  state.syncRows = [poRow('1042')]
  state.bills = bills
  state.activities = []
  state.rawStatements = []
  state.billUpdates = []
}

test('[o3d-9kek] QuickBooks REFUSES an ambiguous PO instead of stamping the newest unlinked bill', async () => {
  // Two unlinked bills on the order. The hand-rolled QuickBooks writer picked bill-new; the shared
  // resolver cannot tell which one the id belongs to and refuses.
  reset([
    { id: 'bill-old', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
    { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
  ])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  assert.deepEqual(state.billUpdates, [], 'nothing may be written while the bill cannot be identified')
  assert.equal(state.bills.find((bill) => bill.id === 'bill-new')?.accountingInvoiceId, null)
  const warning = state.activities.find((entry) => entry.action === 'quickbooks_backreference_ambiguous')
  assert.ok(warning, 'the refusal must name a manual action, not be silent')
  assert.equal(warning.metadata?.reason, 'MULTIPLE_UNLINKED_BILLS')
  // r6 finding 1: the warning MUST NOT promise a repair sweep. QuickBooks has no back-reference
  // sweep binding — one existed briefly on this branch and was removed, because the sweep is scoped
  // by connector alone and a QuickBooks id is realm-local. A message that says a sweep "re-checks
  // it daily" reads as "nothing to do", and nothing would ever come back to the row.
  assert.doesNotMatch(
    String(warning.description),
    /sweep (?:will retry|retries|re-checks|rechecks)/i,
    'no sweep exists for QuickBooks — the previous text promised one that re-checked daily',
  )
  assert.match(String(warning.description), /NOTHING re-checks this automatically/, 'the absence has to be stated, not left implied')
  assert.match(String(warning.description), /manually/i, 'the only remedy is manual, and must be named')
})

test('[o3d-9kek r7 f1] a refused bill-keyed link is QUARANTINED with a route forward, not just reported', async () => {
  // The unique index refuses the write because another bill already holds this QuickBooks id — the
  // realm-switch case the index exists to catch. The document IS IN QUICKBOOKS; only its local
  // record was refused. The old warning ended in "link the document by hand", which cannot be done:
  // the same index refuses a manual link for exactly the same reason, and with the QuickBooks sweep
  // unwired nothing ever came back to it. A refusal with no route forward is not acceptable for a
  // document that already exists in the ledger.
  reset([
    { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
    { id: 'bill-other', poId: 'po-9', accountingInvoiceId: '1042', createdAt: 2 },
  ])
  state.syncRows = [{ ...poRow('1042'), referenceType: 'PurchaseInvoice', referenceId: 'bill-target' }]
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  assert.equal(state.bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null, 'the index refused it')
  const conflict = state.activities.find((entry) => entry.action === 'quickbooks_backreference_id_conflict')
  assert.ok(conflict, 'an external-id conflict is not an ordinary back-reference failure')
  const description = String(conflict.description)

  // What actually happened, stated: the ledger document exists.
  assert.match(description, /POSTED SUCCESSFULLY as external id 1042/)
  // WHO is blocking. Without this the operator has four tables to search by hand.
  assert.match(description, /PurchaseInvoice bill-other currently holds it/)
  assert.equal(conflict.metadata?.blockedById, 'bill-other')
  assert.equal(conflict.metadata?.blockedByModel, 'PurchaseInvoice')
  // THE ROUTE FORWARD, with both ids already filled in.
  assert.match(description, /release-accounting-external-id-claim\.ts --sync-log log-1 --holder bill-other --apply/)
  // …and the guard on it, because releasing a LIVE link is worse than the refusal it replaces.
  assert.match(description, /Do NOT release it if that record is a live, correctly linked document/)
  // r6 finding 1 still holds: no sweep exists for QuickBooks and the message must not imply one.
  assert.doesNotMatch(description, /sweep (?:will retry|retries|re-checks|rechecks)/i)
  assert.match(description, /NOT retried/)

  // THE DURABLE HALF. An activity entry can be pruned or never read; the row that carries the
  // external id carries the conflict too.
  const row = state.syncRows.find((candidate) => candidate.id === 'log-1')
  assert.match(String(row?.errorMessage), /POSTED SUCCESSFULLY as external id 1042/)
  // …and it stays SYNCED. Moving it to FAILED would surface it in the failed-sync banner, and would
  // also stop it suppressing its own re-enqueue — queueQuickBooksSync dedupes on
  // `status in (PENDING, PROCESSING, SYNCED)` — so the document would post to QuickBooks twice.
  assert.equal(row?.status, 'SYNCED', 'a posted document that cannot be recorded is bad; two posted documents are worse')
})

test('[o3d-9kek r7 f1] a NON-conflict back-reference failure still gets the generic warning', async () => {
  // The quarantine must not become a catch-all: a transient write failure is a different thing with
  // a different remedy, and telling an operator to release a claim that is not blocking anything
  // would send them to detach a document for no reason.
  reset([{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }])
  state.syncRows = [{ ...poRow('1042'), referenceType: 'PurchaseInvoice', referenceId: 'bill-missing' }]
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  assert.equal(state.activities.find((entry) => entry.action === 'quickbooks_backreference_id_conflict'), undefined)
  const failure = state.activities.find((entry) => entry.action === 'quickbooks_backreference_failed')
  assert.ok(failure, 'a swallowed exception must still reach the operator')
  assert.match(String(failure.description), /NOTHING retries this/, 'the absence has to be stated, not left implied')
  assert.match(String(failure.description), /by hand/i, 'the message must name the manual action it actually requires')
})

test('[o3d-9kek] an unambiguous QuickBooks PO row is written under the per-PO advisory lock', async () => {
  reset([{ id: 'bill-only', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }])
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')

  await processPendingQuickBooksSync()

  assert.equal(state.bills[0].accountingInvoiceId, '1042')
  // The lock is what makes resolve-then-swap atomic against a second sweep. A bare `update` — the
  // shape QuickBooks used to have — takes no lock, so an empty list here is the regression.
  assert.equal(state.rawStatements.length, 1)
  assert.match(state.rawStatements[0].sql, /pg_advisory_xact_lock/)
  assert.ok(state.rawStatements[0].values.includes('po-1'), 'locked on the PurchaseOrder, by id')
})
