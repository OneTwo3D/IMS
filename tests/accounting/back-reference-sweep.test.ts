import assert from 'node:assert/strict'
import test from 'node:test'

import { BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import {
  BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS,
  BACK_REFERENCE_SWEEP_TYPES,
  buildBackReferenceCandidateQuery,
  createBackReferenceSweepCursorStore,
  repairAccountingBackReferences,
  type BackReferenceCandidateCursor,
  type BackReferenceCandidateCursorStore,
  type BackReferenceSweepActivity,
  type BackReferenceSweepClient,
} from '@/lib/domain/accounting/back-reference-sweep'

/** The tenant/realm namespaces these tests reason in (o3d-9kek r3 finding 1). */
const XERO_A = 'xero:tenant-A'
const XERO_B = 'xero:tenant-B'

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
  /** The connection that ISSUED externalTransactionId (o3d-9kek r3 finding 1). */
  provenance: string | null
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: unknown
  createdAt: Date
  backReferenceCheckedAt: Date | null
  backReferenceAmbiguousLoggedAt: Date | null
  /** Retention has reduced this row to an attribution-only tombstone (r3 finding 3). */
  backReferenceEvidenceCompactedAt: Date | null
}

type BillRow = {
  id: string
  poId: string
  accountingInvoiceId: string | null
  accountingInvoiceProvenance: string
  createdAt: Date
}
type OrderRow = { id: string; accountingInvoiceId: string | null; invoiceNumber?: string | null; invoicedAt?: Date | null }

const SYNC_COLUMNS = new Set([
  'id', 'connector', 'provenance', 'type', 'referenceType', 'referenceId', 'externalTransactionId',
  'status', 'payload', 'createdAt', 'backReferenceCheckedAt', 'backReferenceAmbiguousLoggedAt',
  'backReferenceEvidenceCompactedAt',
])
const BILL_COLUMNS = new Set(['id', 'poId', 'accountingInvoiceId', 'accountingInvoiceProvenance', 'createdAt'])

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

/**
 * purchase_invoices.accounting_invoice_id is UNIQUE (o3d-9kek r2 finding 1), and the fix depends
 * on that: the compare-and-swap's predicate cannot see a SIBLING bill acquiring the candidate id,
 * so the constraint is the only thing that refuses it. A double that cannot raise the violation
 * would leave "the id was not duplicated" passing against a production that dropped the handling.
 * Raised as Prisma raises it: P2002 with the column in meta.target.
 */
function enforceExternalIdUniqueness(bills: BillRow[], data: Record<string, unknown>, writtenBillIds: string[]): void {
  const externalId = data.accountingInvoiceId
  if (typeof externalId !== 'string' || externalId === '') return
  // Over the (id, provenance) PAIR, as the database index is since r3 finding 1 — an external id
  // is tenant-owned, so the same QuickBooks integer in two realms is not a duplicate.
  const provenance = typeof data.accountingInvoiceProvenance === 'string' ? data.accountingInvoiceProvenance : ''
  const holder = bills.find((bill) => bill.accountingInvoiceId === externalId
    && bill.accountingInvoiceProvenance === provenance
    && !writtenBillIds.includes(bill.id))
  if (!holder) return
  throw Object.assign(new Error('Unique constraint failed on the fields: (`accounting_invoice_id`,`accounting_invoice_provenance`)'), {
    code: 'P2002',
    meta: { target: ['accounting_invoice_id', 'accounting_invoice_provenance'] },
  })
}

type Harness = {
  store: Store
  client: BackReferenceSweepClient
  activities: BackReferenceSweepActivity[]
  followUps: Array<{ entryId: string; referenceType: string; referenceId: string }>
  calls: {
    candidateQueries: number
    syncRowsRead: number
    probes: number
    billUpdates: number
    transactions: number
    rawStatements: Array<{ sql: string; values: unknown[] }>
  }
  failFollowUpsFor: Set<string>
  failProbeFor: Set<string>
  /**
   * Activity-log persistence failures, by action. The PRODUCTION logActivity swallows its write
   * errors and resolves normally, so a double that always succeeds cannot exercise the contract
   * the deferral depends on — which is exactly how "warn, then hide the row for 24 hours" shipped
   * with a failing log untested (o3d-9kek r2 finding 3).
   */
  failActivityFor: Set<string>
  /**
   * A concurrent writer, fired the instant the PO attribution has read the bills — i.e.
   * inside the resolve→apply window. Set by the finding-3 test.
   */
  raceAfterBillRead: ((bills: BillRow[]) => void) | null
}

function makeHarness(store: Store): Harness {
  const activities: BackReferenceSweepActivity[] = []
  const followUps: Harness['followUps'] = []
  const calls = { candidateQueries: 0, syncRowsRead: 0, probes: 0, billUpdates: 0, transactions: 0, rawStatements: [] as Array<{ sql: string; values: unknown[] }> }
  const failFollowUpsFor = new Set<string>()
  const failProbeFor = new Set<string>()
  const failActivityFor = new Set<string>()
  const harness = { store, activities, followUps, calls, failFollowUpsFor, failProbeFor, failActivityFor, raceAfterBillRead: null } as Harness

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
        return bill ? { accountingInvoiceId: bill.accountingInvoiceId, accountingInvoiceProvenance: bill.accountingInvoiceProvenance } : null
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        const bill = store.bills
          .filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where, BILL_COLUMNS))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        // poId included: the claim lookup asks the whole table who holds an id, then decides from
        // the HOLDER's order whether that is "already linked" or a cross-PO conflict.
        return bill ? { id: bill.id, poId: bill.poId } : null
      },
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        const bills = store.bills
          .filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where, BILL_COLUMNS))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        const page = (args.take ? bills.slice(0, args.take) : bills).map((bill) => ({ id: bill.id }))
        harness.raceAfterBillRead?.(store.bills)
        return page
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const bill = store.bills.find((candidate) => candidate.id === args.where.id)
        if (!bill) throw new Error(`fake db: no bill ${args.where.id}`)
        enforceExternalIdUniqueness(store.bills, args.data, [bill.id])
        calls.billUpdates++
        Object.assign(bill, args.data)
        return bill
      },
      // The compare-and-swap. It honours `accountingInvoiceId: null` and reports the rows it
      // actually touched — a double that ignored the predicate would make finding 3's fix
      // untestable while looking tested. It also enforces the UNIQUE INDEX, which is what
      // catches the interleaving the predicate cannot see (r2 finding 1).
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const matched = store.bills.filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where, BILL_COLUMNS))
        enforceExternalIdUniqueness(store.bills, args.data, matched.map((bill) => bill.id))
        for (const bill of matched) {
          calls.billUpdates++
          Object.assign(bill, args.data)
        }
        return { count: matched.length }
      },
    },
    supplierCreditNote: {
      async findUnique() { return null },
      async update() { throw new Error('unexpected supplierCreditNote.update') },
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      calls.transactions++
      return fn({
        ...client,
        async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
          calls.rawStatements.push({ sql: query.join('?'), values })
          return 0
        },
      })
    },
  } as unknown as BackReferenceSweepClient

  harness.client = client
  return harness
}

function sweepDeps(harness: Harness, now?: () => Date, overrides: { provenance?: string | null; cursorStore?: BackReferenceCandidateCursorStore } = {}) {
  return {
    db: harness.client,
    connector: 'xero',
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    provenance: 'provenance' in overrides ? overrides.provenance : XERO_A,
    cursorStore: overrides.cursorStore,
    now,
    // Models the PRODUCTION contract: never throws, and reports whether the entry was PERSISTED.
    // A failed write pushes nothing — the operator did not see it — and answers false.
    logActivity: async (entry: BackReferenceSweepActivity) => {
      if (harness.failActivityFor.has(entry.action)) return false
      harness.activities.push(entry)
      return true
    },
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
    provenance: XERO_A,
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: `so-${index}`,
    externalTransactionId: `XINV-${index}`,
    status: 'SYNCED',
    payload: {},
    createdAt: at(index),
    backReferenceCheckedAt: null,
    backReferenceAmbiguousLoggedAt: null,
    backReferenceEvidenceCompactedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The candidate query itself — asserted directly, so the tests below cannot pass
// because the fake ignored a predicate.
// ---------------------------------------------------------------------------

test('the candidate query excludes already-checked rows and keyset-paginates past the page boundary', () => {
  const recheckBefore = at(100)
  const deferralClause = {
    OR: [
      { backReferenceAmbiguousLoggedAt: null },
      { backReferenceAmbiguousLoggedAt: { lt: recheckBefore } },
    ],
  }
  const first = buildBackReferenceCandidateQuery({ connector: 'xero', provenance: XERO_A, after: null, ambiguityRecheckBefore: recheckBefore, take: 50 })
  assert.equal(first.where.connector, 'xero')
  // THE NAMESPACE (r3 finding 1): an exact match, so a row issued by a former tenant/realm is not
  // a candidate at all. A `{ in: [...] }` or an omission here is the collision this fixes.
  assert.equal(first.where.provenance, XERO_A)
  // A tombstoned row is evidence, not work (r3 finding 3): its payload is gone.
  assert.equal(first.where.backReferenceEvidenceCompactedAt, null)
  assert.deepEqual(first.where.status, { in: ['SYNCED', 'FAILED'] })
  assert.deepEqual(first.where.externalTransactionId, { not: null })
  assert.deepEqual(first.where.type, { in: [...BACK_REFERENCE_SWEEP_TYPES] })
  // The verdict marker: a row the sweep has settled is no longer a candidate, ever.
  assert.equal(first.where.backReferenceCheckedAt, null)
  // The DEFERRAL marker: an ambiguous row is out of the set for one interval, not for good.
  assert.deepEqual(first.where.AND, [deferralClause])
  assert.deepEqual(first.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }])

  const cursor = { createdAt: at(7), id: 'log-0007' }
  const next = buildBackReferenceCandidateQuery({ connector: 'xero', provenance: XERO_A, after: cursor, ambiguityRecheckBefore: recheckBefore, take: 50 })
  assert.deepEqual(next.where.AND, [
    deferralClause,
    {
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.id } }] },
      ],
    },
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
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
      { id: 'bill-old', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) },
      // Created while sync was disabled: newest, and the old code's "newest unlinked bill"
      // heuristic would have written the other bill's external id onto it.
      { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(9) },
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
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
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) },
      // A linked bill on the same PO is not a competitor — it already has its id.
      { id: 'bill-0', poId: 'po-1', accountingInvoiceId: 'XBILL-0', accountingInvoiceProvenance: XERO_A, createdAt: at(0) },
      // ...nor is another PO's bill.
      { id: 'bill-other', poId: 'po-2', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(2) },
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

test('an ambiguous PO row is warned about once per interval, not on every cron cycle', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })
  let clock = new Date(Date.UTC(2026, 1, 1))
  const now = () => clock

  await repairAccountingBackReferences(sweepDeps(harness, now), { limit: 10 })
  const afterFirst = harness.activities.filter((entry) => entry.action === 'xero_backreference_repair_ambiguous').length
  assert.equal(afterFirst, 2, 'both rows report once')

  // Two more cycles inside the interval: no new warnings.
  clock = new Date(clock.getTime() + 60 * 60 * 1000)
  await repairAccountingBackReferences(sweepDeps(harness, now), { limit: 10 })
  await repairAccountingBackReferences(sweepDeps(harness, now), { limit: 10 })
  assert.equal(harness.activities.filter((entry) => entry.action === 'xero_backreference_repair_ambiguous').length, 2)

  // ...and the row is DEFERRED, not retired: no verdict was recorded, so it comes back.
  assert.equal(harness.store.syncRows.every((row) => row.backReferenceCheckedAt === null), true)
  assert.equal(harness.store.bills[0].accountingInvoiceId, null)

  // Past the interval it reports again, saying it is a repeat — silence would read as
  // "handled" for a row that needs a human.
  clock = new Date(clock.getTime() + BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS)
  await repairAccountingBackReferences(sweepDeps(harness, now), { limit: 10 })
  const warnings = harness.activities.filter((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.equal(warnings.length, 4)
  assert.equal(warnings[0].metadata.previouslyLoggedAt, null)
  assert.equal(typeof warnings[2].metadata.previouslyLoggedAt, 'string')
  assert.match(warnings[2].description, /Still unresolved since this was last reported/)
})

// ---------------------------------------------------------------------------
// Defect 3 — an already-repaired legacy row stamping its id onto a DIFFERENT bill,
// ambiguity frozen as a permanent verdict, and an unconditional apply.
// ---------------------------------------------------------------------------

test('[o3d-9kek f1] a legacy row already linked to one bill does not stamp its id onto another', async () => {
  // ONE live sync row, and its external id is already on bill-a from an earlier repair.
  // bill-b is unlinked and belongs to something else. "Exactly one live row AND exactly one
  // unlinked bill" calls that unique — and copies bill-a's id onto bill-b.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: 'XBILL-1', accountingInvoiceProvenance: XERO_A, createdAt: at(1) },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(9) },
    ],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 0)
  assert.equal(harness.calls.billUpdates, 0)
  assert.equal(harness.store.bills[1].accountingInvoiceId, null, 'bill-b must be untouched')
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
  // Already linked and SYNCED is a genuine verdict: the row leaves the candidate set.
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt !== null, true)
})

/** A clock the sweep can be driven by, so the recheck interval is exercised rather than waited on. */
function fakeClock(start = new Date(Date.UTC(2026, 1, 1))) {
  let clock = start
  return { now: () => clock, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
}

test('[o3d-9kek f2] an ambiguous row stays eligible and is repaired once the ambiguity clears', async () => {
  // The starvation bug's second route: stamping transient ambiguity as a verdict excluded
  // the row for good, so the repair never happened even after the competing row was
  // cancelled.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })
  const clock = fakeClock()

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(firstRun.skippedAmbiguous, 2)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'ambiguity is not a verdict')

  // The competing row is cancelled (audit-46ry — deliberately abandoned).
  harness.store.syncRows[1].status = 'CANCELLED'

  clock.advance(BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS + 1)
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt !== null, true)
})

test('[o3d-9kek f2] MULTIPLE_UNLINKED_BILLS also stays eligible, and repairs when the other bill links', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) },
      { id: 'bill-2', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(9) },
    ],
    orders: [],
  })
  const clock = fakeClock()

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(firstRun.skippedAmbiguous, 1)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)

  // bill-2's own bill-keyed sync posts and links it — the population shrank to one.
  harness.store.bills[1].accountingInvoiceId = 'XBILL-2'

  clock.advance(BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS + 1)
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
})

test('[o3d-9kek f2] a backlog of unattributable rows does not starve a newer broken row', async () => {
  // The reason ambiguity is DEFERRED rather than merely left eligible. Ten legacy PO rows
  // that can never be attributed sit at the head of the scan, and the run budget is ten.
  // Left fully eligible they would consume the whole budget on every cycle forever, and the
  // newer broken row behind them would never be reached — the starvation this sweep exists
  // to fix, arriving through the fix for the stamping bug.
  const syncRows: SyncRow[] = []
  const bills: BillRow[] = []
  for (let index = 1; index <= 10; index++) {
    syncRows.push(poRow(index, `po-${index}`))
    bills.push({ id: `bill-${index}a`, poId: `po-${index}`, accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(index) })
    bills.push({ id: `bill-${index}b`, poId: `po-${index}`, accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(index + 1) })
  }
  syncRows.push(salesInvoiceRow(50))
  const harness = makeHarness({ syncRows, bills, orders: [{ id: 'so-50', accountingInvoiceId: null }] })
  const clock = fakeClock()

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(firstRun.scanned, 10)
  assert.equal(firstRun.skippedAmbiguous, 10)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null, 'the newer row is out of budget')

  // Next cycle, same day: the ten are deferred, so the budget reaches the row behind them.
  clock.advance(60 * 1000)
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(secondRun.skippedAmbiguous, 0)
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-50')

  // ...and the deferred rows come back once the interval passes: deferred, not retired.
  clock.advance(BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS)
  const thirdRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(thirdRun.skippedAmbiguous, 10)
})

test('[o3d-9kek f2] a sibling that never posted carries no external id and manufactures no ambiguity', async () => {
  const harness = makeHarness({
    syncRows: [
      poRow(1, 'po-1'),
      poRow(2, 'po-1', { status: 'FAILED', externalTransactionId: null }),
      poRow(3, 'po-1', { status: 'PENDING', externalTransactionId: null }),
    ],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.skippedAmbiguous, 0)
  assert.equal(run.repaired, 1)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-1')
})

test('[o3d-9kek f3] a bill linked between the probe and the apply keeps the winner\'s id', async () => {
  // The probe resolves bill-1 as the only unlinked bill; a normal bill-keyed sync links it
  // with its OWN correct id before the write lands. The unconditional update replaced that
  // valid id with the legacy row's.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })
  let reads = 0
  harness.raceAfterBillRead = (bills) => {
    // Fire on the FENCED re-read only, i.e. genuinely inside the resolve→apply window.
    reads++
    if (reads === 2) bills[0].accountingInvoiceId = 'XBILL-authoritative'
  }

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.failed, 1)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-authoritative')
  // Not stamped: the next run re-resolves and will settle it as already-linked.
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)

  harness.raceAfterBillRead = null
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(secondRun.repaired, 0)
  assert.equal(secondRun.failed, 0)
  assert.equal(harness.store.bills[0].accountingInvoiceId, 'XBILL-authoritative')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt !== null, true)
})

test('[o3d-9kek f3] the PO repair resolves and writes inside one transaction, under a per-PO lock', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 1)
  assert.equal(harness.calls.transactions, 1)
  assert.equal(harness.calls.rawStatements.length, 1)
  assert.match(harness.calls.rawStatements[0].sql, /pg_advisory_xact_lock/)
  assert.deepEqual(harness.calls.rawStatements[0].values, [BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE, 'po-1'])
})

// ---------------------------------------------------------------------------
// o3d-9kek ROUND 2 — the already-linked guard was PO-scoped and not atomic with the write,
// zero matching sync rows was accepted as "unique", and a failed warning still bought 24
// hours of silence.
// ---------------------------------------------------------------------------

test('[o3d-9kek r2 f2] evidence deleted mid-attribution is refused, not treated as certainty', async () => {
  // Retention deletes accounting_sync_logs by AGE, on its own schedule, while the sweep reads its
  // candidate page outside the transaction that acts on it. Here the row is deleted after the
  // page read: the sweep still holds its external id in memory, and the PO still has exactly one
  // unlinked bill. Accepting zero rows as "exactly one" stamped that id with nothing left to
  // justify it — and no later reader could tell it had been guessed.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })
  // Fires between the bill read and the sync-row count, i.e. exactly inside the window.
  harness.raceAfterBillRead = () => { harness.store.syncRows.length = 0 }

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 1)
  assert.equal(harness.calls.billUpdates, 0)
  assert.equal(harness.store.bills[0].accountingInvoiceId, null)
  // The deferral stamp targets a row that no longer exists. That is expected, not a failure:
  // there is nothing to defer, and nothing to retry.
  assert.equal(run.failed, 0)

  const warning = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warning)
  assert.equal(warning.metadata.reason, 'NO_LIVE_SYNC_ROW')
  assert.equal(warning.level, 'WARNING')
})

test('[o3d-9kek r2 f1] a sibling bill claiming the id mid-apply is reported, not overwritten', async () => {
  // bill-a is the only unlinked bill, so the attribution is legitimately unique, and bill-b holds
  // an older id so nothing looks contested. The authoritative bill-keyed writer then links bill-b
  // with THIS id between the fenced re-resolve and the swap. The swap's predicate only asks
  // whether bill-a is still unlinked — it is — so nothing in the application layer refuses it.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: 'XBILL-old', accountingInvoiceProvenance: XERO_A, createdAt: at(9) },
    ],
    orders: [],
  })
  let reads = 0
  harness.raceAfterBillRead = (bills) => {
    reads++
    if (reads === 2) bills[1].accountingInvoiceId = 'XBILL-1'
  }

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 1, 'an attribution conflict is a refusal, not a generic failure')
  // EXACTLY one bill carries the id, and it is the one the authoritative writer chose.
  assert.deepEqual(harness.store.bills.filter((bill) => bill.accountingInvoiceId === 'XBILL-1').map((bill) => bill.id), ['bill-b'])
  assert.equal(harness.store.bills[0].accountingInvoiceId, null, 'bill-a must not have received a second copy')

  const warning = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warning)
  assert.equal(warning.metadata.reason, 'EXTERNAL_ID_CLAIMED_CONCURRENTLY')
  // Deferred, never retired: the conflict can be resolved by hand.
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
  assert.equal(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt !== null, true)
})

test('[o3d-9kek r2 f1] an id held by ANOTHER PO\'s bill is reported, and no second copy is written', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1')],
    bills: [
      // The holder sits on a different order, so the PO-scoped guard never looked at it.
      { id: 'bill-elsewhere', poId: 'po-2', accountingInvoiceId: 'XBILL-1', accountingInvoiceProvenance: XERO_A, createdAt: at(1) },
      { id: 'bill-here', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(9) },
    ],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedAmbiguous, 1)
  assert.equal(harness.calls.billUpdates, 0)
  assert.equal(harness.store.bills[1].accountingInvoiceId, null)

  const warning = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warning)
  assert.equal(warning.metadata.reason, 'EXTERNAL_ID_LINKED_ELSEWHERE')
  assert.equal(warning.metadata.linkedPurchaseInvoiceId, 'bill-elsewhere')
  assert.equal(warning.metadata.linkedPurchaseOrderId, 'po-2')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'a conflict is not a verdict')
})

test('[o3d-9kek r2 f3] a warning that was NOT persisted does not buy 24 hours of silence', async () => {
  // logActivity swallows its write errors and resolves normally, so awaiting it cannot establish
  // that anybody was told — yet the deferral stamp used to follow unconditionally. One transient
  // activity-log failure therefore suppressed BOTH the operator's warning and any further repair
  // attempt for a day, including one that would have succeeded because the ambiguity cleared.
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, accountingInvoiceProvenance: '', createdAt: at(1) }],
    orders: [],
  })
  const clock = fakeClock()
  harness.failActivityFor.add('xero_backreference_repair_ambiguous')

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(firstRun.skippedAmbiguous, 2)
  assert.equal(harness.activities.length, 0, 'nothing reached the log')
  assert.equal(
    harness.store.syncRows.every((row) => row.backReferenceAmbiguousLoggedAt === null),
    true,
    'an unreported ambiguity must not be deferred — that is silence with no warning behind it',
  )
  assert.equal(harness.store.syncRows.every((row) => row.backReferenceCheckedAt === null), true)

  // The very next cycle, well INSIDE the recheck interval, tries again — and now that the log is
  // healthy the operator is told. A deferred row would have reported nothing here.
  harness.failActivityFor.clear()
  clock.advance(60 * 1000)
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(secondRun.skippedAmbiguous, 2)
  assert.equal(harness.activities.filter((entry) => entry.action === 'xero_backreference_repair_ambiguous').length, 2)
  // ...and NOW it is deferred, because the warning is known to have landed.
  assert.equal(harness.store.syncRows.every((row) => row.backReferenceAmbiguousLoggedAt !== null), true)

  clock.advance(60 * 1000)
  const thirdRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.equal(thirdRun.skippedAmbiguous, 0, 'a reported ambiguity is throttled as before')
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

// ---------------------------------------------------------------------------
// o3d-9kek ROUND 3 — the uniqueness namespace, the missing QuickBooks-side sweep's shape, the
// retention tombstone, and the third incarnation of the starvation bug.
// ---------------------------------------------------------------------------

/**
 * A cursor store that actually PERSISTS across runs, because that is the property under test.
 * A double that forgot between calls would make the starvation test pass for the wrong reason
 * (each run "resuming" from nothing is exactly the bug).
 */
function memoryCursorStore(): BackReferenceCandidateCursorStore & { value: BackReferenceCandidateCursor | null; saves: number } {
  const store = {
    value: null as BackReferenceCandidateCursor | null,
    saves: 0,
    async load() { return store.value },
    async save(cursor: BackReferenceCandidateCursor | null) { store.saves++; store.value = cursor },
  }
  return store
}

test('[o3d-9kek r3 f4] 200 PERSISTENTLY FAILING rows do not starve the repairable row behind them', async () => {
  // The boundary test above only used rows that BECOME CHECKED, so it proved nothing about the
  // failure mode this sweep exists to survive: rows that stay eligible run after run. They stay
  // eligible on purpose — a transient failure and an unreported ambiguity must both be retried —
  // and the run budget counts rows SCANNED, so a persistently failing head consumed every budget
  // and the row behind it was never reached. That is the original starvation, third incarnation.
  const syncRows: SyncRow[] = []
  const orders: OrderRow[] = []
  for (let index = 1; index <= 200; index++) {
    syncRows.push(salesInvoiceRow(index))
    orders.push({ id: `so-${index}`, accountingInvoiceId: null })
  }
  syncRows.push(salesInvoiceRow(201))
  orders.push({ id: 'so-201', accountingInvoiceId: null })

  const harness = makeHarness({ syncRows, bills: [], orders })
  // Every one of the oldest 200 fails, every run — the shape of "the activity log cannot be
  // written", "the connector's document store is down", "this PO can never be attributed".
  for (let index = 1; index <= 200; index++) harness.failProbeFor.add(`so-${index}`)
  const cursor = memoryCursorStore()

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, undefined, { cursorStore: cursor }), { limit: 200 })
  assert.equal(firstRun.scanned, 200)
  assert.equal(firstRun.failed, 200)
  assert.equal(firstRun.repaired, 0)
  // Unstamped, deliberately: they must be retried, which is exactly why they refill the head.
  assert.equal(harness.store.syncRows.every((row) => row.backReferenceCheckedAt === null), true)
  assert.equal(harness.store.orders[200].accountingInvoiceId, null, 'out of budget on the first run')
  assert.ok(cursor.value, 'the run must record where it stopped')

  // The next run RESUMES behind them. Nothing about the failing rows changed, and nothing about
  // them could be recorded — that is the point.
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness, undefined, { cursorStore: cursor }), { limit: 200 })
  assert.equal(secondRun.repaired, 1)
  assert.equal(harness.store.orders[200].accountingInvoiceId, 'XINV-201')

  // ...and the failing rows are still being retried, not abandoned: the third run comes back to
  // them. Forward progress and durable retry at the same time.
  const thirdRun = await repairAccountingBackReferences(sweepDeps(harness, undefined, { cursorStore: cursor }), { limit: 200 })
  assert.ok(thirdRun.failed > 0, 'the failing head is retried once the cursor comes round again')
})

test('[o3d-9kek r3 f4] the cursor ROTATES, so a row before the resume point is reached again', async () => {
  // A cursor that only ever moved forward would strand rows behind it: an ambiguity that cleared,
  // a deferral that expired, a transient failure that healed. It wraps once per run.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1), salesInvoiceRow(2)],
    bills: [],
    orders: [
      { id: 'so-1', accountingInvoiceId: null },
      { id: 'so-2', accountingInvoiceId: 'XINV-2' },
    ],
  })
  const cursor = memoryCursorStore()
  // The previous run stopped after the LAST row, leaving the older broken one behind it.
  cursor.value = { createdAt: at(2), id: 'log-0002' }

  const run = await repairAccountingBackReferences(sweepDeps(harness, undefined, { cursorStore: cursor }), { limit: 10 })
  assert.equal(run.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
})

test('[o3d-9kek r3 f4] an unreadable cursor degrades to a head scan, not to no scan at all', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  const broken: BackReferenceCandidateCursorStore = {
    async load() { throw new Error('settings table unavailable') },
    async save() { throw new Error('settings table unavailable') },
  }

  const run = await repairAccountingBackReferences(sweepDeps(harness, undefined, { cursorStore: broken }), { limit: 10 })
  assert.equal(run.repaired, 1, 'a lost bookmark must never stop the repair')
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
})

test('[o3d-9kek r3 f1] a row issued by a FORMER tenant/realm is not swept', async () => {
  // The row posted to tenant B carries an id that means something else — or nothing — in tenant A.
  // Repairing it under A writes A's bill a link to B's document.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { provenance: XERO_B }), salesInvoiceRow(2, { provenance: null })],
    bills: [],
    orders: [
      { id: 'so-1', accountingInvoiceId: null },
      { id: 'so-2', accountingInvoiceId: null },
    ],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.scanned, 0)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null)
  // NULL provenance too: an id whose issuing connection cannot be identified has no namespace to
  // be attributed in, and guessing one is the wrong-bill write.
  assert.equal(harness.store.orders[1].accountingInvoiceId, null)
})

test('[o3d-9kek r3 f1] with no connected tenant the sweep does nothing at all', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness, undefined, { provenance: null }), { limit: 10 })
  assert.equal(run.scanned, 0)
  assert.equal(harness.calls.candidateQueries, 0, 'it must not even ask — there is no namespace to ask within')
  assert.equal(harness.store.orders[0].accountingInvoiceId, null)
})

test('[o3d-9kek r3 f3] a retention TOMBSTONE is evidence, not a repair candidate', async () => {
  // Retention has cleared the payload, so the follow-ups can no longer be rebuilt and there is
  // nothing a repair could complete. The row still exists so the PO resolver can see that
  // something claimed this order's bill.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { payload: {}, backReferenceEvidenceCompactedAt: at(500) })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.equal(run.scanned, 0)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null)
})

test('[o3d-9kek r3 f4] the Setting-backed cursor store round-trips, and treats junk as "no cursor"', async () => {
  const rows = new Map<string, string>()
  const settingDb = {
    setting: {
      async findUnique(args: { where: { key: string } }) {
        const value = rows.get(args.where.key)
        return value === undefined ? null : { value }
      },
      async upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
        rows.set(args.where.key, args.update.value)
        return {}
      },
    },
  }
  const store = createBackReferenceSweepCursorStore(settingDb, 'xero')

  assert.equal(await store.load(), null)
  await store.save({ createdAt: at(7), id: 'log-0007' })
  assert.deepEqual(await store.load(), { createdAt: at(7), id: 'log-0007' })
  // Per connector: a QuickBooks sweep must not resume from Xero's bookmark.
  assert.equal(await createBackReferenceSweepCursorStore(settingDb, 'quickbooks').load(), null)

  rows.set('xero_backreference_sweep_cursor', 'not json')
  assert.equal(await store.load(), null)
  rows.set('xero_backreference_sweep_cursor', '{"id":"log-1","createdAt":"nonsense"}')
  assert.equal(await store.load(), null)
  await store.save(null)
  assert.equal(await store.load(), null)
})
