import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BACK_REFERENCE_SWEEP_TYPES,
  buildBackReferenceCandidateQuery,
  repairAccountingBackReferences,
  type BackReferenceSweepActivity,
  type BackReferenceSweepClient,
} from '@/lib/domain/accounting/back-reference-sweep'

// ---------------------------------------------------------------------------
// o3d-9kek — the repair sweep starved newer rows and inferred PO ambiguity from the
// capped candidate page.
//
// These tests run against an in-memory store that INTERPRETS the where clause rather
// than returning a canned array. That is deliberate: a double that ignores
// `backReferenceCheckedAt: null`, or an `update` that ignores its `where`, would make
// every assertion below pass whether or not the fix is present. The matcher throws on an
// unknown column or an unsupported operator so a predicate production relies on cannot
// silently become a no-op.
// ---------------------------------------------------------------------------

type SyncRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: unknown
  createdAt: Date
  backReferenceCheckedAt: Date | null
}

type BillRow = { id: string; poId: string; accountingInvoiceId: string | null; createdAt: Date }
type OrderRow = { id: string; accountingInvoiceId: string | null; invoiceNumber?: string | null; invoicedAt?: Date | null }

const SYNC_COLUMNS = new Set([
  'id', 'connector', 'type', 'referenceType', 'referenceId', 'externalTransactionId',
  'status', 'payload', 'createdAt', 'backReferenceCheckedAt',
])
const BILL_COLUMNS = new Set(['id', 'poId', 'accountingInvoiceId', 'createdAt'])

const COMPARABLE_OPERATORS = ['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'equals']

function scalar(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

/** A where-clause interpreter. Throws rather than silently matching everything. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>, columns: Set<string>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matches(row, clause, columns))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matches(row, clause, columns))) return false
      continue
    }
    if (!columns.has(key)) throw new Error(`fake db: unknown column "${key}" in where clause`)
    const value = row[key]
    if (condition === null) {
      if (value !== null && value !== undefined) return false
      continue
    }
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>
      const unsupported = Object.keys(operators).filter((op) => !COMPARABLE_OPERATORS.includes(op))
      if (unsupported.length > 0) throw new Error(`fake db: unsupported operator(s) ${unsupported.join(', ')} on "${key}"`)
      if ('in' in operators && !(operators.in as unknown[]).map(scalar).includes(scalar(value))) return false
      if ('notIn' in operators && (operators.notIn as unknown[]).map(scalar).includes(scalar(value))) return false
      if ('equals' in operators && scalar(value) !== scalar(operators.equals)) return false
      if ('not' in operators) {
        if (operators.not === null) {
          if (value === null || value === undefined) return false
        } else if (scalar(value) === scalar(operators.not)) return false
      }
      if ('gt' in operators && !((scalar(value) as number) > (scalar(operators.gt) as number))) return false
      if ('gte' in operators && !((scalar(value) as number) >= (scalar(operators.gte) as number))) return false
      if ('lt' in operators && !((scalar(value) as number) < (scalar(operators.lt) as number))) return false
      if ('lte' in operators && !((scalar(value) as number) <= (scalar(operators.lte) as number))) return false
      continue
    }
    if (scalar(value) !== scalar(condition)) return false
  }
  return true
}

type Store = {
  syncRows: SyncRow[]
  bills: BillRow[]
  orders: OrderRow[]
}

type Harness = {
  store: Store
  client: BackReferenceSweepClient
  activities: BackReferenceSweepActivity[]
  followUps: Array<{ entryId: string; referenceType: string; referenceId: string }>
  calls: { candidateQueries: number; syncRowsRead: number; probes: number; billUpdates: number }
  failFollowUpsFor: Set<string>
  failProbeFor: Set<string>
}

function makeHarness(store: Store): Harness {
  const activities: BackReferenceSweepActivity[] = []
  const followUps: Harness['followUps'] = []
  const calls = { candidateQueries: 0, syncRowsRead: 0, probes: 0, billUpdates: 0 }
  const failFollowUpsFor = new Set<string>()
  const failProbeFor = new Set<string>()

  const client = {
    accountingSyncLog: {
      async findMany(args: { where: Record<string, unknown>; take: number }) {
        calls.candidateQueries++
        const rows = store.syncRows
          .filter((row) => matches(row as unknown as Record<string, unknown>, args.where, SYNC_COLUMNS))
          .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id))
          .slice(0, args.take)
        calls.syncRowsRead += rows.length
        // Return copies: the sweep must not depend on mutating the store's objects.
        return rows.map((row) => ({ ...row })) as never
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const row = store.syncRows.find((candidate) => candidate.id === args.where.id)
        if (!row) throw new Error(`fake db: no sync row ${args.where.id}`)
        Object.assign(row, args.data)
        return row
      },
      async count(args: { where: Record<string, unknown> }) {
        return store.syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, args.where, SYNC_COLUMNS)).length
      },
    },
    salesOrder: {
      async findUnique(args: { where: { id: string } }) {
        calls.probes++
        if (failProbeFor.has(args.where.id)) throw new Error('probe blew up')
        const order = store.orders.find((candidate) => candidate.id === args.where.id)
        return order ? { accountingInvoiceId: order.accountingInvoiceId } : null
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const order = store.orders.find((candidate) => candidate.id === args.where.id)
        if (!order) throw new Error(`fake db: no sales order ${args.where.id}`)
        Object.assign(order, args.data)
        return order
      },
    },
    salesOrderRefund: {
      async findUnique() { return null },
      async update() { throw new Error('unexpected salesOrderRefund.update') },
    },
    purchaseInvoice: {
      async findUnique(args: { where: { id: string } }) {
        const bill = store.bills.find((candidate) => candidate.id === args.where.id)
        return bill ? { accountingInvoiceId: bill.accountingInvoiceId } : null
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        const bill = store.bills
          .filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where, BILL_COLUMNS))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        return bill ? { id: bill.id } : null
      },
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        const bills = store.bills
          .filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where, BILL_COLUMNS))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return (args.take ? bills.slice(0, args.take) : bills).map((bill) => ({ id: bill.id }))
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const bill = store.bills.find((candidate) => candidate.id === args.where.id)
        if (!bill) throw new Error(`fake db: no bill ${args.where.id}`)
        calls.billUpdates++
        Object.assign(bill, args.data)
        return bill
      },
    },
    supplierCreditNote: {
      async findUnique() { return null },
      async update() { throw new Error('unexpected supplierCreditNote.update') },
    },
  } as unknown as BackReferenceSweepClient

  return { store, client, activities, followUps, calls, failFollowUpsFor, failProbeFor }
}

function sweepDeps(harness: Harness) {
  return {
    db: harness.client,
    connector: 'xero',
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    logActivity: async (entry: BackReferenceSweepActivity) => { harness.activities.push(entry) },
    enqueueFollowUps: async (entryId: string, _type: string, referenceType: string, referenceId: string) => {
      if (harness.failFollowUpsFor.has(entryId)) throw new Error('follow-up enqueue failed')
      harness.followUps.push({ entryId, referenceType, referenceId })
    },
  } as Parameters<typeof repairAccountingBackReferences>[0]
}

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes))
}

function salesInvoiceRow(index: number, overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    id: `log-${String(index).padStart(4, '0')}`,
    connector: 'xero',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: `so-${index}`,
    externalTransactionId: `XINV-${index}`,
    status: 'SYNCED',
    payload: {},
    createdAt: at(index),
    backReferenceCheckedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The candidate query itself — asserted directly, so the tests below cannot pass
// because the fake ignored a predicate.
// ---------------------------------------------------------------------------

test('the candidate query excludes already-checked rows and keyset-paginates past the page boundary', () => {
  const first = buildBackReferenceCandidateQuery({ connector: 'xero', after: null, take: 50 })
  assert.equal(first.where.connector, 'xero')
  assert.deepEqual(first.where.status, { in: ['SYNCED', 'FAILED'] })
  assert.deepEqual(first.where.externalTransactionId, { not: null })
  assert.deepEqual(first.where.type, { in: [...BACK_REFERENCE_SWEEP_TYPES] })
  // The marker: a row the sweep has settled is no longer a candidate.
  assert.equal(first.where.backReferenceCheckedAt, null)
  assert.equal(first.where.OR, undefined)
  assert.deepEqual(first.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }])

  const cursor = { createdAt: at(7), id: 'log-0007' }
  const next = buildBackReferenceCandidateQuery({ connector: 'xero', after: cursor, take: 50 })
  assert.deepEqual(next.where.OR, [
    { createdAt: { gt: cursor.createdAt } },
    { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.id } }] },
  ])
})

// ---------------------------------------------------------------------------
// Defect 1 — starvation.
// ---------------------------------------------------------------------------

test('a newly broken row beyond the 200-row boundary is eventually repaired', async () => {
  // 200 ordinary historical rows whose documents are already linked — exactly the
  // population that used to fill the bounded page on every cron cycle, forever.
  const syncRows: SyncRow[] = []
  const orders: OrderRow[] = []
  for (let index = 1; index <= 200; index++) {
    syncRows.push(salesInvoiceRow(index))
    orders.push({ id: `so-${index}`, accountingInvoiceId: `XINV-${index}` })
  }
  // ...and one NEWER row whose back-reference write failed: the document has no id.
  syncRows.push(salesInvoiceRow(201))
  orders.push({ id: 'so-201', accountingInvoiceId: null })

  const harness = makeHarness({ syncRows, bills: [], orders })

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 200 })
  assert.equal(firstRun.scanned, 200)
  assert.equal(firstRun.repaired, 0)
  // The broken row is beyond this run's budget — the point of the test.
  assert.equal(harness.store.orders[200].accountingInvoiceId, null)

  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 200 })
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.orders[200].accountingInvoiceId, 'XINV-201')
})

test('a checked row leaves the candidate set, so each cycle makes forward progress', async () => {
  const syncRows: SyncRow[] = []
  const orders: OrderRow[] = []
  for (let index = 1; index <= 120; index++) {
    syncRows.push(salesInvoiceRow(index))
    orders.push({ id: `so-${index}`, accountingInvoiceId: `XINV-${index}` })
  }
  const harness = makeHarness({ syncRows, bills: [], orders })

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 50 })
  assert.equal(firstRun.scanned, 50)
  assert.equal(harness.store.syncRows.filter((row) => row.backReferenceCheckedAt !== null).length, 50)

  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 50 })
  assert.equal(secondRun.scanned, 50)
  assert.equal(harness.store.syncRows.filter((row) => row.backReferenceCheckedAt !== null).length, 100)
  // The second cycle looked at DIFFERENT rows: rows 51-100, not 1-50 again.
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt !== null, true)
  assert.equal(harness.store.syncRows[99].backReferenceCheckedAt !== null, true)
  assert.equal(harness.store.syncRows[100].backReferenceCheckedAt, null)

  const thirdRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 50 })
  assert.equal(thirdRun.scanned, 20)
  const fourthRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 50 })
  // Nothing left to look at — the population is reconciled, so the sweep stops probing it.
  assert.equal(fourthRun.scanned, 0)
  assert.equal(harness.calls.probes, 120)
})

test('a transient probe failure leaves the row eligible so a later sweep retries it', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failProbeFor.add('so-1')

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(firstRun.failed, 1)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)

  harness.failProbeFor.clear()
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
})

test('a FAILED row whose id is already applied re-enqueues its follow-ups, then settles', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED' })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.checked, 1)
  assert.equal(run.repaired, 0) // nothing was re-applied — it must not claim a repair
  assert.equal(harness.followUps.length, 1)
  assert.equal(harness.store.syncRows[0].status, 'SYNCED')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt !== null, true)
  assert.equal(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_recovered'), true)
})

test('a deferred follow-up enqueue leaves the row FAILED and unstamped, so it is retried', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED' })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failFollowUpsFor.add('log-0001')

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
  assert.equal(harness.store.syncRows[0].status, 'FAILED')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
  assert.equal(harness.activities.some((entry) => entry.action === 'xero_backreference_followup_deferred'), true)
})

// ---------------------------------------------------------------------------
// Defect 2 — PO attribution decided globally, not within the page.
// ---------------------------------------------------------------------------

function poRow(index: number, poId: string, overrides: Partial<SyncRow> = {}): SyncRow {
  return salesInvoiceRow(index, {
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseOrder',
    referenceId: poId,
    externalTransactionId: `XBILL-${index}`,
    ...overrides,
  })
}

test('ambiguity is detected when a second sync row for the same PO lies beyond the page', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
    orders: [],
  })

  // limit 1 → only the FIRST row is in this run's page. The old page-local count saw one
  // row, called it unambiguous, and stamped bill-1 with the first row's external id —
  // which is a coin flip between two posted bills.
  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 1 })
  assert.equal(run.scanned, 1)
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 1)
  assert.equal(harness.calls.billUpdates, 0)
  assert.equal(harness.store.bills[0].accountingInvoiceId, null)

  const warning = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warning)
  assert.equal(warning.level, 'WARNING')
  assert.equal(warning.metadata.reason, 'MULTIPLE_SYNC_ROWS')
})

test('ambiguity is detected when one sync row maps to a PO with several unlinked bills', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      { id: 'bill-old', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) },
      // Created while sync was disabled: newest, and the old code's "newest unlinked bill"
      // heuristic would have written the other bill's external id onto it.
      { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, createdAt: at(9) },
    ],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 1)
  assert.equal(harness.calls.billUpdates, 0)
  assert.equal(harness.store.bills.every((bill) => bill.accountingInvoiceId === null), true)

  const warning = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warning)
  assert.equal(warning.metadata.reason, 'MULTIPLE_UNLINKED_BILLS')
})

test('a CANCELLED sibling row does not make a PO ambiguous', async () => {
  // audit-46ry: a cancelled row is deliberately abandoned and competes for nothing.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1', { status: 'CANCELLED' })],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 1)
  assert.equal(run.skippedAmbiguous, 0)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
})

test('the unambiguous single-bill PO row is still repaired, onto that exact bill', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) },
      // A linked bill on the same PO is not a competitor — it already has its id.
      { id: 'bill-0', poId: 'po-1', accountingInvoiceId: 'XBILL-0', createdAt: at(0) },
      // ...nor is another PO's bill.
      { id: 'bill-other', poId: 'po-2', accountingInvoiceId: null, createdAt: at(2) },
    ],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 1)
  assert.equal(run.skippedAmbiguous, 0)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
  assert.equal(harness.store.bills[2].accountingInvoiceId, null)
  const repairLog = harness.activities.find((entry) => entry.action === 'xero_backreference_repaired')
  assert.ok(repairLog)
  // Logged against the BILL it actually wrote, not the PO the row named.
  assert.equal(repairLog.metadata.referenceType, 'PurchaseInvoice')
  assert.equal(repairLog.metadata.referenceId, 'bill-1')
})

test('an ambiguous PO row is warned about once, not on every cron cycle', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
    orders: [],
  })

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.activities.filter((entry) => entry.action === 'xero_backreference_repair_ambiguous').length, 2)
  assert.equal(harness.store.syncRows.every((row) => row.backReferenceCheckedAt !== null), true)
  assert.equal(harness.store.bills[0].accountingInvoiceId, null)
})

test('the sweep stays inside its own connector', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1), salesInvoiceRow(2, { connector: 'quickbooks' })],
    bills: [],
    orders: [
      { id: 'so-1', accountingInvoiceId: null },
      { id: 'so-2', accountingInvoiceId: null },
    ],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.scanned, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
  assert.equal(harness.store.orders[1].accountingInvoiceId, null)
})
