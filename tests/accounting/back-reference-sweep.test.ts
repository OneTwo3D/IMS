import assert from 'node:assert/strict'
import test from 'node:test'

import { BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { BACK_REFERENCE_PAIRS, syncTypeWritesBackReference } from '@/lib/domain/accounting/back-reference'
import {
  BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS,
  BACK_REFERENCE_CANDIDATE_SELECT,
  BACK_REFERENCE_SWEEP_TYPES,
  buildBackReferenceCandidateQuery,
  createBackReferenceSweepCursorStore,
  repairAccountingBackReferences,
  type BackReferenceCandidateCursor,
  type BackReferenceCandidateCursorStore,
  type BackReferenceSweepActivity,
  type BackReferenceSweepClient,
} from '@/lib/domain/accounting/back-reference-sweep'
import { adapterUniqueViolation } from '../helpers/prisma-unique-error'

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
  backReferenceAmbiguousLoggedAt: Date | null
  /** Retention has reduced this row to an attribution-only tombstone (r3 finding 3). */
  backReferenceEvidenceCompactedAt: Date | null
  /** The row's link is written but its follow-ups have not been enqueued yet (Codex r9 finding 1). */
  backReferenceFollowUpsPendingAt: Date | null
  /**
   * HOW the row reached its terminal status (o3d-nf9i r3). NULL = the connector's own writeback.
   * 'OPERATOR_ASSERTION' = a human typed a document id in and IMS verified nothing.
   */
  settlementBasis: string | null
}

type BillRow = {
  id: string
  poId: string
  accountingInvoiceId: string | null
  /** o3d-wf86: how that link was made. Undefined = never recorded (a pre-provenance row). */
  accountingInvoiceIdSource?: string | null
  createdAt: Date
}
type OrderRow = { id: string; accountingInvoiceId: string | null; invoiceNumber?: string | null; invoicedAt?: Date | null }
/** Supplier (purchase) credit note — PURCHASE_CREDIT_NOTE / ACCPAYCREDIT (r6 finding 2). */
type CreditNoteRow = { id: string; accountingCreditNoteId: string | null }

const SYNC_COLUMNS = new Set([
  'id', 'connector', 'type', 'referenceType', 'referenceId', 'externalTransactionId',
  'status', 'payload', 'createdAt', 'backReferenceCheckedAt', 'backReferenceAmbiguousLoggedAt',
  'backReferenceEvidenceCompactedAt', 'backReferenceFollowUpsPendingAt', 'settlementBasis',
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
  /** Optional so the existing stores need no edit; defaulted in makeHarness. */
  creditNotes?: CreditNoteRow[]
}

/**
 * purchase_invoices.accounting_invoice_id is UNIQUE (o3d-9kek r2 finding 1), and the fix depends
 * on that: the compare-and-swap's predicate cannot see a SIBLING bill acquiring the candidate id,
 * so the constraint is the only thing that refuses it. A double that cannot raise the violation
 * would leave "the id was not duplicated" passing against a production that dropped the handling.
 *
 * Raised in the LIVE ADAPTER'S shape (o3d-9kek r7 finding 2). It used to hand-build
 * `meta: { target: [...] }`, which `@prisma/adapter-pg` never produces — so the sweep's
 * classification of this violation was exercised only against a shape that does not occur.
 */
function enforceExternalIdUniqueness(bills: BillRow[], data: Record<string, unknown>, writtenBillIds: string[]): void {
  const externalId = data.accountingInvoiceId
  if (typeof externalId !== 'string' || externalId === '') return
  // On the VALUE ALONE, as the database index is. Namespacing it per connection in the double
  // would let a collision through here and hide the fact that production refuses it.
  const holder = bills.find((bill) => bill.accountingInvoiceId === externalId && !writtenBillIds.includes(bill.id))
  if (!holder) return
  throw adapterUniqueViolation(['accounting_invoice_id'], {
    modelName: 'PurchaseInvoice',
    constraintName: 'purchase_invoices_accounting_invoice_id_key',
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
   * Sync rows whose FOLLOW-UP OBLIGATION write fails (Codex r9 finding 1). Only that write — the
   * marker is claimed before the repair precisely so that its own failure is survivable, and a double
   * that failed every accountingSyncLog.update could not tell the two apart.
   */
  failPendingMarkerFor: Set<string>
  /**
   * Sales orders whose POST-REPAIR INVOICE-DATE READ fails (o3d-r5pj, Codex r10 #3). Separate from
   * failProbeFor because the two reads happen at different points and must fail differently: a
   * failed probe abandons the repair, a failed invoice-date read must leave an ALREADY REPAIRED row
   * unsettled rather than settling it on an answer nobody got.
   */
  failInvoiceDateReadFor: Set<string>
  /**
   * A concurrent writer, fired the instant the PO attribution has read the bills — i.e.
   * inside the resolve→apply window. Set by the finding-3 test.
   */
  raceAfterBillRead: ((bills: BillRow[]) => void) | null
}

function makeHarness(store: Store): Harness {
  store.creditNotes ??= []
  const activities: BackReferenceSweepActivity[] = []
  const followUps: Harness['followUps'] = []
  const calls = { candidateQueries: 0, syncRowsRead: 0, probes: 0, billUpdates: 0, transactions: 0, rawStatements: [] as Array<{ sql: string; values: unknown[] }> }
  const failFollowUpsFor = new Set<string>()
  const failProbeFor = new Set<string>()
  const failActivityFor = new Set<string>()
  const failPendingMarkerFor = new Set<string>()
  const failInvoiceDateReadFor = new Set<string>()
  const harness = {
    store, activities, followUps, calls, failFollowUpsFor, failProbeFor, failActivityFor, failPendingMarkerFor,
    failInvoiceDateReadFor, raceAfterBillRead: null,
  } as Harness

  const client = {
    accountingSyncLog: {
      async findMany(args: { where: Record<string, unknown>; select?: Record<string, boolean>; take: number }) {
        calls.candidateQueries++
        const rows = store.syncRows
          .filter((row) => matches(row as unknown as Record<string, unknown>, args.where, SYNC_COLUMNS))
          .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id))
          .slice(0, args.take)
        calls.syncRowsRead += rows.length
        // PROJECTED BY THE `select`, not handed the whole row (o3d-nf9i r3). Prisma returns only the
        // selected columns, and a double that ignores the select lets production read a column it
        // never asked the database for — so dropping `settlementBasis: true` from
        // BACK_REFERENCE_CANDIDATE_SELECT would leave the operator-assertion gate below passing
        // while production could not see the column at all. Copies, so the sweep cannot depend on
        // mutating the store's objects.
        return rows.map((row) => {
          const source = row as unknown as Record<string, unknown>
          if (!args.select) return { ...source }
          return Object.fromEntries(
            Object.keys(args.select).filter((column) => args.select![column]).map((column) => [column, source[column]]),
          )
        }) as never
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const row = store.syncRows.find((candidate) => candidate.id === args.where.id)
        if (!row) throw new Error(`fake db: no sync row ${args.where.id}`)
        // The obligation write specifically — the one the sweep makes BEFORE it repairs anything.
        // Clearing the marker (`null`, part of the verdict stamp) is a different write and is not
        // failed here.
        if (failPendingMarkerFor.has(args.where.id) && args.data.backReferenceFollowUpsPendingAt instanceof Date) {
          throw new Error('follow-up obligation write failed')
        }
        Object.assign(row, args.data)
        return row
      },
      async count(args: { where: Record<string, unknown> }) {
        return store.syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, args.where, SYNC_COLUMNS)).length
      },
    },
    salesOrder: {
      // SELECT-AWARE ON PURPOSE (o3d-r5pj, Codex r10 #3). The sweep now asks this table TWO
      // different questions — "is the back-reference still missing?" and "does the sale actually
      // have an invoice date?" — and a double that answered both with the same object would let
      // production read a column it never selected, or read the wrong one, and still pass. The
      // invoice-date read is not a probe and is not failed by failProbeFor: it happens after the
      // repair, so counting it would silently change every probe-count assertion in this file.
      async findUnique(args: { where: { id: string }; select?: Record<string, unknown> }) {
        const order = store.orders.find((candidate) => candidate.id === args.where.id)
        if (args.select?.invoicedAt) {
          if (failInvoiceDateReadFor.has(args.where.id)) throw new Error('invoice-date read blew up')
          return order ? { invoicedAt: order.invoicedAt ?? null } : null
        }
        calls.probes++
        if (failProbeFor.has(args.where.id)) throw new Error('probe blew up')
        return order ? { accountingInvoiceId: order.accountingInvoiceId } : null
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const order = store.orders.find((candidate) => candidate.id === args.where.id)
        if (!order) throw new Error(`fake db: no sales order ${args.where.id}`)
        // sales_orders.accounting_invoice_id is UNIQUE too now (r6 finding 3). Modelled here for the
        // same reason the bill index is: a double that cannot raise the violation would leave the
        // sweep's handling of it untestable while looking tested.
        const externalId = args.data.accountingInvoiceId
        if (typeof externalId === 'string' && store.orders.some((other) => other.id !== order.id && other.accountingInvoiceId === externalId)) {
          throw adapterUniqueViolation(['accounting_invoice_id'], {
            modelName: 'SalesOrder',
            constraintName: 'sales_orders_accounting_invoice_id_key',
          })
        }
        // PRISMA SEMANTICS, not Object.assign's (o3d-r5pj): `undefined` means "leave this column
        // alone", and the repair path relies on exactly that to avoid writing an invented invoice
        // date. A double that wrote undefined over an existing value would make the sweep look
        // correct while production silently CLEARED a date it was only meant to skip.
        for (const [column, value] of Object.entries(args.data)) {
          if (value !== undefined) (order as Record<string, unknown>)[column] = value
        }
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
        // poId included: the claim lookup asks the whole table who holds an id, then decides from
        // the HOLDER's order whether that is "already linked" or a cross-PO conflict. o3d-wf86 adds
        // the PROVENANCE, which the refusal quotes — a double that dropped it would report every
        // blocking link as unrecorded and make the wording untestable.
        return bill ? { id: bill.id, poId: bill.poId, accountingInvoiceIdSource: bill.accountingInvoiceIdSource ?? null } : null
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
    // r6 finding 2: BACKED BY THE STORE, not stubbed out. It used to answer null/throw, which is
    // why "PURCHASE_CREDIT_NOTE is not in the sweep's candidate types" was invisible — no test
    // could drive the type through the sweep at all, so the existing writer tests proved the pair
    // in isolation while the sweep never selected it.
    supplierCreditNote: {
      async findUnique(args: { where: { id: string } }) {
        calls.probes++
        if (failProbeFor.has(args.where.id)) throw new Error('probe blew up')
        const note = store.creditNotes!.find((candidate) => candidate.id === args.where.id)
        return note ? { accountingCreditNoteId: note.accountingCreditNoteId } : null
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const note = store.creditNotes!.find((candidate) => candidate.id === args.where.id)
        if (!note) throw new Error(`fake db: no supplier credit note ${args.where.id}`)
        Object.assign(note, args.data)
        return note
      },
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

function sweepDeps(harness: Harness, now?: () => Date, overrides: { cursorStore?: BackReferenceCandidateCursorStore } = {}) {
  return {
    db: harness.client,
    connector: 'xero',
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
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
    backReferenceFollowUpsPendingAt: null,
    settlementBasis: null,
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
  const first = buildBackReferenceCandidateQuery({ connector: 'xero', after: null, ambiguityRecheckBefore: recheckBefore, take: 50 })
  assert.equal(first.where.connector, 'xero')
  // A TOMBSTONE IS STILL A CANDIDATE (r4 finding 3). r3 filtered these out, which handed RETENTION
  // — a clock — the power to decide a row would never be repaired: compaction runs on age and says
  // nothing about repairability, so an ambiguity that cleared after the horizon, or a
  // back-reference that was merely failing transiently at it, was retired for good. The absence of
  // this predicate is load-bearing, so it is asserted as an absence.
  assert.equal('backReferenceEvidenceCompactedAt' in first.where, false)
  assert.deepEqual(first.where.status, { in: ['SYNCED', 'FAILED'] })
  // TWO REASONS TO BE A CANDIDATE, and they are alternatives (o3d-p5j3). Back-reference evidence is
  // one; an outstanding follow-up obligation is the other, and it has to be its own clause because
  // the row that needs it MOST — an INVOICE_PDF whose nested email and WooCommerce note never ran —
  // fails both halves of the first: it is not a back-reference type, and the PDF call returns no
  // external id. Asserted as a disjunction rather than as two top-level predicates, because the
  // difference between the two shapes IS the fix.
  assert.deepEqual(first.where.OR, [
    { type: { in: [...BACK_REFERENCE_SWEEP_TYPES] }, externalTransactionId: { not: null } },
    { backReferenceFollowUpsPendingAt: { not: null } },
  ])
  assert.equal('externalTransactionId' in first.where, false, 'the id predicate must not also stand alone, or the marker clause is dead')
  assert.equal('type' in first.where, false)
  // The verdict marker: a row the sweep has settled is no longer a candidate, ever.
  assert.equal(first.where.backReferenceCheckedAt, null)
  // The DEFERRAL marker: an ambiguous row is out of the set for one interval, not for good.
  assert.deepEqual(first.where.AND, [deferralClause])
  assert.deepEqual(first.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }])

  const cursor = { createdAt: at(7), id: 'log-0007' }
  const next = buildBackReferenceCandidateQuery({ connector: 'xero', after: cursor, ambiguityRecheckBefore: recheckBefore, take: 50 })
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
// o3d-9kek Codex r9 finding 1 — a TRANSIENT follow-up failure on a SYNCED repair was a PERMANENT
// verdict.
//
// The test above covers the FAILED shape, where `status` itself carries "follow-ups outstanding".
// The crash-after-post shape — the one this sweep primarily exists for — does not: that row is
// SYNCED with an external id and no back-reference. Once the sweep wrote the link, an enqueue that
// failed transiently left the row unstamped (correct) with nothing recording the outstanding work,
// and the NEXT sweep saw a linked SYNCED row, called it reconciled and stamped it. The payment, PDF
// or attachment was gone and no amount of re-running brought it back.
// ---------------------------------------------------------------------------

test('[o3d-9kek r9 f1] a SYNCED repair whose follow-ups fail transiently is retried, not retired', async () => {
  const harness = makeHarness({
    // SYNCED, external id present, back-reference missing: the process died between the post and the
    // id write, so the follow-ups never ran either.
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failFollowUpsFor.add('log-0001')

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(firstRun.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1', 'the link half succeeded')
  assert.equal(harness.followUps.length, 0, 'the follow-up half did not')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'so the row is not settled')
  assert.ok(
    harness.store.syncRows[0].backReferenceFollowUpsPendingAt,
    'and the outstanding work is recorded DURABLY — "still linked" is not evidence of it',
  )
  assert.equal(harness.store.syncRows[0].status, 'SYNCED', 'never flipped out of SYNCED: that would let the document post a second time')

  harness.failFollowUpsFor.clear()
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(secondRun.checked, 1, 'the row is looked at again, and is not treated as reconciled')
  assert.equal(secondRun.repaired, 0, 'nothing to re-apply — only the follow-ups were outstanding')
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'], 'the follow-ups finally run')
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_recovered'))
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'NOW it is settled')
  assert.equal(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, null, 'and the obligation is discharged in the same write')
})

test('[o3d-9kek r9 f1] a repair whose follow-up obligation cannot be recorded writes NOTHING', async () => {
  // The obligation is claimed BEFORE the link is written, so its own failure cannot recreate the
  // defect one layer down: a marker written only in the enqueue's catch block would be lost by
  // exactly the kind of transient database failure it exists to survive, and the row would again be
  // linked with nothing saying its follow-ups never ran.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failPendingMarkerFor.add('log-0001')

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(firstRun.failed, 1)
  assert.equal(firstRun.repaired, 0)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null, 'the link is NOT written — nothing would have recorded what it owes')
  assert.equal(harness.followUps.length, 0)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'and the row stays eligible')

  harness.failPendingMarkerFor.clear()
  const secondRun = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(secondRun.repaired, 1, 'the whole repair simply happens on the next sweep')
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'])
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

test('[o3d-9kek r9 f1] a SYNCED row TOMBSTONED while it still owed follow-ups is warned about, not stamped in silence', async () => {
  // The terminal case reached through the new marker. Retention compacted the payload away while the
  // follow-ups were still outstanding, so they can never be rebuilt — but the discard has to be
  // ANNOUNCED. Keyed on `status === 'FAILED'` this row said nothing at all: linked, SYNCED, stamped,
  // and a missing payment nobody would ever hear about.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      payload: {},
      backReferenceEvidenceCompactedAt: at(500),
      backReferenceFollowUpsPendingAt: at(400),
    })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 0, 'the id was already there')
  assert.equal(run.followUpsDiscarded, 1)
  assert.deepEqual(harness.followUps, [], 'a `{}` payload cannot rebuild a PDF or a payment')
  const discarded = harness.activities.find((entry) => entry.action === 'xero_backreference_followups_discarded')
  assert.ok(discarded, 'the loss is permanent, so it must be announced')
  assert.equal(discarded.level, 'WARNING')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'and only THEN is the row settled')
  assert.equal(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, null)
})

test('[o3d-9kek r10 f1] a CONNECTOR that died between the link and the enqueue is repaired by the sweep', async () => {
  // The other end of r10 finding 1. The connectors now claim the obligation in the same write that
  // marks a row SYNCED, so a process death between updateBackReference and enqueueFollowUps leaves
  // this exact row: SYNCED, LINKED, and marked as still owing its follow-ups.
  //
  // Every other signal on it says "reconciled" — which is why the marker had to exist and why the
  // connectors had to be the ones to write it. Nothing about a linked SYNCED row can be inferred
  // after the fact; if the writer had not recorded it at the moment it was true, this sweep would
  // stamp the row checked and the payment, PDF or attachment would be gone for good.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { backReferenceFollowUpsPendingAt: at(400) })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 0, 'nothing to re-apply — the connector had already written the link')
  assert.equal(run.checked, 1, 'but the row is NOT treated as reconciled')
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'], 'the follow-ups the crash lost are re-enqueued')
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_recovered'))
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'and only now is it settled')
  assert.equal(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, null, 'with the obligation discharged in the same write')
})

test('[o3d-9kek r10 f1] a linked SYNCED row with NO obligation marker is still settled without re-enqueueing', async () => {
  // The control for the test above, and the reason the marker cannot simply be "on for every SYNCED
  // row": the ordinary case — connector ran, follow-ups ran, obligation released — must remain a
  // one-line verdict. If it re-enqueued here, every successfully synced document in the system
  // would get a second PDF, payment registration or attachment on its first sweep.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.checked, 0)
  assert.equal(run.repaired, 0)
  assert.deepEqual(harness.followUps, [], 'nothing is owed, so nothing is re-run')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
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

test('an ambiguous PO row is warned about once per interval, not on every cron cycle', async () => {
  const harness = makeHarness({
    syncRows: [poRow(1, 'po-1'), poRow(2, 'po-1')],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: at(1) },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, createdAt: at(9) },
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) },
      { id: 'bill-2', poId: 'po-1', accountingInvoiceId: null, createdAt: at(9) },
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
    bills.push({ id: `bill-${index}a`, poId: `po-${index}`, accountingInvoiceId: null, createdAt: at(index) })
    bills.push({ id: `bill-${index}b`, poId: `po-${index}`, accountingInvoiceId: null, createdAt: at(index + 1) })
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: 'XBILL-old', createdAt: at(9) },
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
      { id: 'bill-elsewhere', poId: 'po-2', accountingInvoiceId: 'XBILL-1', createdAt: at(1) },
      { id: 'bill-here', poId: 'po-1', accountingInvoiceId: null, createdAt: at(9) },
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
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
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

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 3 — a retention TOMBSTONE must stay a repair candidate.
//
// r3 compacted an expired-but-unresolved row to attribution only AND excluded it from the sweep.
// The exclusion is the defect: compaction is scheduled by AGE, so it retires rows that are still
// perfectly repairable — an ambiguity that clears next week, a back-reference whose write happened
// to be failing at the cutoff. Keeping the claimant evidence stops a WRONG guess; it does nothing
// to recover the missing link, and "deferred, not retired" was the property being broken.
//
// The split is by DEPENDENCY. The id write reads externalTransactionId, referenceType and
// referenceId — all of which survive compaction, so it still runs. The follow-ups
// are built from the payload, which does not, so they are discarded under a stated terminal policy.
// ---------------------------------------------------------------------------

test('[o3d-9kek r4 f3] a retention TOMBSTONE is still repaired — only its follow-ups are discarded', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { payload: {}, backReferenceEvidenceCompactedAt: at(500) })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  // THE REPAIR STILL HAPPENS. Under r3 this row was never even read.
  assert.equal(run.scanned, 1)
  assert.equal(run.repaired, 1)
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')

  // THE FOLLOW-UPS DO NOT, and are not pretended to. Calling enqueueFollowUps with a compacted `{}`
  // payload would not throw — it would enqueue nothing and return normally — so the loss has to be
  // reported explicitly or it is invisible.
  assert.equal(run.followUpsDiscarded, 1)
  assert.deepEqual(harness.followUps, [])
  const discarded = harness.activities.find((entry) => entry.action === 'xero_backreference_followups_discarded')
  assert.ok(discarded, 'the discard is permanent, so it must be announced')
  assert.equal(discarded.level, 'WARNING')
  assert.match(discarded.description, /re-drive it manually/)

  // Settled, because nothing further is ever possible for this row — but NOT flipped to SYNCED:
  // its follow-ups were abandoned, not done, and SYNCED would erase the only trace of that.
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
  assert.equal(harness.store.syncRows[0].status, 'SYNCED', 'this row was already SYNCED; the sweep must not change it')
})

test('[o3d-9kek r4 f3] a TOMBSTONE whose discard warning is not persisted stays eligible', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { payload: {}, backReferenceEvidenceCompactedAt: at(500) })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failActivityFor.add('xero_backreference_followups_discarded')

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  // The id write is idempotent and safe, so it lands. Stamping the row is not: the discard cannot
  // be undone, so settling it after a warning nobody received would destroy the work and the notice
  // together. Same asymmetry as the ambiguity deferral — repeating a warning is noise, losing it is
  // silence.
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'unstamped, so the next run warns again')
})

test('[o3d-9kek r4 f3] a FAILED TOMBSTONE whose id is already applied is settled, not retried forever', async () => {
  // The "back-reference done, follow-ups not enqueued" state, after retention. r3's follow-ups-only
  // pass would re-enqueue from `{}` and then mark the row SYNCED — reporting a reconciliation that
  // enqueued nothing.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: {}, backReferenceEvidenceCompactedAt: at(500) })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 0, 'nothing was re-applied — the id was already there')
  assert.equal(run.followUpsDiscarded, 1)
  assert.deepEqual(harness.followUps, [], 'a `{}` payload cannot rebuild a PDF or a payment')
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_discarded'))
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
  assert.equal(harness.store.syncRows[0].status, 'FAILED', 'not SYNCED: the follow-ups were abandoned, not completed')
})

test('[o3d-9kek r4 f3] a TOMBSTONE with an unresolved PO ambiguity is still deferred, never settled', async () => {
  // The case r3's exclusion silently retired: two posted claimants for one PO. The ambiguity can
  // still clear — a sibling is cancelled, a human links a bill — and compaction has not changed
  // that, so the row must come back after the recheck interval rather than leave the set for good.
  const harness = makeHarness({
    syncRows: [
      poRow(1, 'po-1', { payload: {}, backReferenceEvidenceCompactedAt: at(500) }),
      poRow(2, 'po-1'),
    ],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.skippedAmbiguous, 2)
  assert.equal(harness.store.bills[0].accountingInvoiceId, null, 'refusing to guess survives compaction')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'DEFERRED, not retired')
  assert.ok(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt)
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

// ---------------------------------------------------------------------------
// o3d-9kek r6 finding 2 — SUPPLIER CREDIT NOTES were excluded from the sweep entirely.
//
// BACK_REFERENCE_SWEEP_TYPES was a hand-written list whose comment claimed it matched
// syncTypeWritesBackReference's pairs; it omitted PURCHASE_CREDIT_NOTE, which the shared writer has
// supported since audit-g5u2 (Xero posts ACCPAYCREDIT and writes
// SupplierCreditNote.accountingCreditNoteId). Two consequences, from one list:
//
//   • a credit note whose post SUCCEEDED and whose local id write FAILED was never a candidate —
//     its retries exhausted to FAILED and nothing ever came back to it;
//   • retention reads the same list, so the only row that knew an external credit note existed with
//     no local link was DELETED by age instead of compacted to a tombstone.
//
// The existing writer tests proved the PURCHASE_CREDIT_NOTE pair in isolation and stayed green
// throughout, which is precisely the non-discriminating coverage this drives out: these tests go
// through the real candidate query.
// ---------------------------------------------------------------------------

function creditNoteRow(index: number, overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    id: `log-cn-${String(index).padStart(4, '0')}`,
    connector: 'xero',
    type: 'PURCHASE_CREDIT_NOTE',
    referenceType: 'SupplierCreditNote',
    referenceId: `scn-${index}`,
    externalTransactionId: `XCN-${index}`,
    status: 'FAILED',
    payload: { invoiceNumber: `CN-${index}` },
    createdAt: at(index),
    backReferenceCheckedAt: null,
    backReferenceAmbiguousLoggedAt: null,
    backReferenceEvidenceCompactedAt: null,
    backReferenceFollowUpsPendingAt: null,
    settlementBasis: null,
    ...overrides,
  }
}

test('[o3d-9kek r6 f2] the candidate query SELECTS supplier credit notes', () => {
  const query = buildBackReferenceCandidateQuery({
    connector: 'xero',
    after: null,
    ambiguityRecheckBefore: at(100),
    take: 50,
  })
  const evidenceClause = (query.where.OR as Array<Record<string, unknown>>)[0]
  const types = (evidenceClause.type as { in: string[] }).in
  assert.ok(types.includes('PURCHASE_CREDIT_NOTE'), 'a type the shared writer supports must be swept')
  // Asserted as a SET against the writer's own pair table rather than as a literal, so the two
  // cannot drift again: the previous list was a literal, and the literal was the bug.
  assert.deepEqual([...types].sort(), [...new Set(BACK_REFERENCE_PAIRS.map((pair) => pair.type))].sort())
})

test('[o3d-9kek r6 f2] every pair the sweep selects is one applyBackReference actually writes', () => {
  // The derivation is only worth anything if the pairs it derives from are real. A pair listed but
  // unhandled would make the sweep select rows it can only ever mark structurally-incapable.
  for (const pair of BACK_REFERENCE_PAIRS) {
    for (const referenceType of pair.referenceTypes) {
      assert.equal(
        syncTypeWritesBackReference(pair.type, referenceType),
        true,
        `${pair.type}/${referenceType} must be writable`,
      )
    }
  }
  assert.equal(syncTypeWritesBackReference('PURCHASE_CREDIT_NOTE', 'SupplierCreditNote'), true)
  // ...and the derivation must not have widened it: a type with the wrong reference type still fails.
  assert.equal(syncTypeWritesBackReference('PURCHASE_CREDIT_NOTE', 'PurchaseInvoice'), false)
  assert.equal(syncTypeWritesBackReference('COGS_JOURNAL', 'CogsEntry'), false)
})

test('[o3d-9kek r6 f2] a supplier credit note whose id write failed is REPAIRED end-to-end', async () => {
  const harness = makeHarness({
    syncRows: [creditNoteRow(1)],
    bills: [],
    orders: [],
    creditNotes: [{ id: 'scn-1', accountingCreditNoteId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.scanned, 1, 'the row must reach the sweep at all — it never did before')
  assert.equal(run.repaired, 1)
  assert.equal(harness.store.creditNotes![0].accountingCreditNoteId, 'XCN-1')
  // A FAILED row whose back-reference is now applied AND whose follow-ups were enqueued is fully
  // reconciled: Xero's enqueueFollowUps routes PURCHASE_CREDIT_NOTE to its allocation follow-up,
  // so this is not a no-op branch.
  assert.deepEqual(harness.followUps, [{ entryId: 'log-cn-0001', referenceType: 'SupplierCreditNote', referenceId: 'scn-1' }])
  assert.equal(harness.store.syncRows[0].status, 'SYNCED')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_repaired'))
})

test('[o3d-9kek r6 f2] an already-linked supplier credit note is settled, not rewritten', async () => {
  // The probe has to work for this type too, not just the apply: a resolver that answered "missing"
  // for every credit note would re-write the id on every run and never settle the row.
  const harness = makeHarness({
    syncRows: [creditNoteRow(1, { status: 'SYNCED' })],
    bills: [],
    orders: [],
    creditNotes: [{ id: 'scn-1', accountingCreditNoteId: 'XCN-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.checked, 0, 'nothing was missing')
  assert.equal(run.repaired, 0)
  assert.deepEqual(harness.followUps, [])
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'reconciled rows leave the candidate set for good')
})

test('[o3d-9kek r6 f2] a TOMBSTONED supplier credit note is still id-repaired, follow-ups discarded', async () => {
  // The retention half of the same finding: the row survived to the cutoff unresolved, so it is a
  // tombstone rather than a deletion — and a tombstone is still a repair candidate.
  const harness = makeHarness({
    syncRows: [creditNoteRow(1, { payload: {}, backReferenceEvidenceCompactedAt: at(500) })],
    bills: [],
    orders: [],
    creditNotes: [{ id: 'scn-1', accountingCreditNoteId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 1)
  assert.equal(harness.store.creditNotes![0].accountingCreditNoteId, 'XCN-1')
  assert.equal(run.followUpsDiscarded, 1)
  assert.deepEqual(harness.followUps, [], 'the allocation follow-up cannot be rebuilt from `{}`')
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_discarded'))
  // Not flipped to SYNCED: the allocation was abandoned, not done.
  assert.equal(harness.store.syncRows[0].status, 'FAILED')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

test('[o3d-9kek r6 f3] an external id already held by another order is REPORTED and deferred, not console-only', async () => {
  // The sales-side unique index refuses the repair. Left in the generic catch this was a
  // `console.error` and a `failed++`: a permanent, human-only-fixable condition reported to nobody
  // and re-attempted every five minutes forever — exactly the defect r2 finding 1 fixed for the PO
  // path. It gets the same treatment: warn once per interval, then defer.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1)],
    bills: [],
    orders: [
      { id: 'so-1', accountingInvoiceId: null },
      // Another order already holds the id this row wants to write.
      { id: 'so-other', accountingInvoiceId: 'XINV-1' },
    ],
  })
  const clock = fakeClock()

  const firstRun = await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })

  assert.equal(firstRun.failed, 1, 'nothing was repaired, and the number must not quietly improve')
  assert.equal(harness.store.orders[0].accountingInvoiceId, null, 'nothing was overwritten')
  const conflict = harness.activities.find((entry) => entry.action === 'xero_backreference_id_conflict')
  assert.ok(conflict, 'a refusal only a human can clear must name the human action')
  assert.equal(conflict.level, 'WARNING')
  assert.match(conflict.description, /already held by another local record/)
  // r7 finding 1: "resolve it by hand" is not an instruction anyone can follow on its own — the same
  // index refuses a manual link too — so the message names the command that releases the claim, with
  // this row's id already in it.
  assert.match(conflict.description, /release-accounting-external-id-claim\.ts --sync-log log-0001 --holder <id> --apply/)
  assert.equal(conflict.metadata.externalId, 'XINV-1')
  // DEFERRED, not stamped: unlinking the wrong record makes this repairable again, and a row
  // excluded for good would never be reconsidered.
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
  assert.ok(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt)

  // Throttled: the next run inside the interval must not re-warn, or a permanent conflict writes an
  // activity entry every five minutes.
  harness.activities.length = 0
  await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.deepEqual(harness.activities.filter((entry) => entry.action === 'xero_backreference_id_conflict'), [])

  // ...and it comes back once the interval passes, because nothing has been retired.
  clock.advance(BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS + 1)
  harness.activities.length = 0
  await repairAccountingBackReferences(sweepDeps(harness, clock.now), { limit: 10 })
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_id_conflict'))
})

test('[o3d-9kek r6 f3] a TRANSIENT repair failure is still left alone — no warning, no deferral', async () => {
  // The conflict branch must not become a catch-all. A follow-up enqueue failure is expected to
  // succeed on its own, so deferring it for 24 hours would delay a repair nobody needs to touch.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED' })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failFollowUpsFor.add('log-0001')

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.deepEqual(harness.activities.filter((entry) => entry.action === 'xero_backreference_id_conflict'), [])
  assert.equal(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt, null, 'a transient failure is retried immediately')
})

// ---------------------------------------------------------------------------
// o3d-p5j3 — the obligation marker was written for EVERY type and consumed for four.
//
// r10 merged `followUpObligationClaim()` into the SYNCED write of every sync type in both
// connectors, while the candidate query still admitted only `type IN (back-reference types) AND
// externalTransactionId IS NOT NULL`. So the marker was recorded truthfully and then stranded on
// every row outside that shape — and the row where that costs real work is INVOICE_PDF, whose
// follow-ups are NESTED (a successful PDF enqueues INVOICE_EMAIL and WC_INVOICE_NOTE) and which
// fails BOTH halves of the old predicate at once: not a back-reference type, and no external id,
// because attaching a PDF returns none.
// ---------------------------------------------------------------------------

/** A SYNCED INVOICE_PDF row: no external id, not a back-reference type, follow-ups still owed. */
function invoicePdfRow(index: number, overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    ...salesInvoiceRow(index),
    type: 'INVOICE_PDF',
    externalTransactionId: null,
    payload: { accountingInvoiceId: 'XINV-1', referenceId: `so-${index}` },
    backReferenceFollowUpsPendingAt: at(400),
    ...overrides,
  }
}

test('[o3d-p5j3] an INVOICE_PDF row whose nested follow-ups never ran is a candidate and is rebuilt', async () => {
  const harness = makeHarness({
    syncRows: [invoicePdfRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.checked, 1, 'the row owes work, so it is not a one-line verdict')
  assert.equal(run.repaired, 0, 'there is no back-reference on this type to re-apply')
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'],
    'the INVOICE_EMAIL and WC_INVOICE_NOTE the crash lost are enqueued by re-running the connector dispatch')
  assert.ok(harness.activities.some((entry) => entry.action === 'xero_backreference_followups_recovered'))
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'and only then is the row settled')
  assert.equal(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, null, 'the obligation is discharged, not abandoned')
  assert.equal(harness.store.syncRows[0].status, 'SYNCED')
})

test('[o3d-p5j3] a row with no obligation and no back-reference is stamped WITHOUT enqueueing anything', async () => {
  // The control. Widening the candidate window must not turn every structurally-incapable row into
  // a re-enqueue: only the marker asks for one.
  const harness = makeHarness({
    syncRows: [invoicePdfRow(1, { backReferenceFollowUpsPendingAt: null })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.scanned, 0, 'with nothing owed and no external id, it is not a candidate at all')
  assert.deepEqual(harness.followUps, [])
})

test('[o3d-p5j3] a transient enqueue failure leaves the obligation standing and the row unsettled', async () => {
  const harness = makeHarness({
    syncRows: [invoicePdfRow(1)],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })
  harness.failFollowUpsFor.add('log-0001')

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.failed, 1)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'a failed attempt is not a verdict')
  assert.ok(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, 'and the obligation is still recorded')
  const deferred = harness.activities.find((entry) => entry.action === 'xero_backreference_followup_deferred')
  assert.ok(deferred)
  assert.equal(deferred.level, 'WARNING')

  harness.failFollowUpsFor.clear()
  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'], 'the next sweep completes it')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

test('[o3d-p5j3] discharging a FALSE obligation never flips a genuinely FAILED row to SYNCED', async () => {
  // Most types owe nothing to enqueueFollowUps, so their marker is a false obligation left behind by
  // a release write that did not land. Draining it must not also rewrite the row's own verdict: a
  // FAILED INVOICE_EMAIL that never sent is still a failure, and calling it SYNCED because a marker
  // was cleared would retire it off the failed-sync dashboard with nobody having fixed anything.
  const harness = makeHarness({
    syncRows: [invoicePdfRow(1, { type: 'INVOICE_EMAIL', status: 'FAILED' })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.syncRows[0].status, 'FAILED', 'the row keeps its own verdict')
  assert.equal(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, null, 'but the false obligation drains')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

// ---------------------------------------------------------------------------
// o3d-r5pj — a repair must not invent a business date.
// ---------------------------------------------------------------------------

test('[o3d-r5pj] a repair stamps the date the invoice was POSTED with, not the time the sweep ran', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { date: '2026-01-05', invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  // Deliberately months after the post: the whole defect is that the gap between the two silently
  // became the sale's VAT period.
  const sweptAt = new Date(Date.UTC(2026, 5, 30, 11, 0))
  const run = await repairAccountingBackReferences(sweepDeps(harness, () => sweptAt), { limit: 10 })

  assert.equal(run.repaired, 1)
  assert.deepEqual(harness.store.orders[0].invoicedAt, new Date('2026-01-05'),
    'the sale belongs to the period it was invoiced in, not the one it was repaired in')
  assert.notDeepEqual(harness.store.orders[0].invoicedAt, sweptAt)
})

test('[o3d-r5pj] a repair that cannot recover the date writes NONE, and says so', async () => {
  // A tombstone, or any legacy payload without a date. Writing `now` would move the sale into this
  // month's VAT return; writing nothing leaves it in no period at all — which is only acceptable
  // because it is announced, so the settle is gated on the warning having been persisted.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null, invoicedAt: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 1, 'the LINK is still worth writing — that half is not a guess')
  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-1')
  assert.equal(harness.store.orders[0].invoicedAt ?? null, null, 'and no date is invented')
  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable')
  assert.ok(warned, 'a sale in no reporting period must not be settled in silence')
  assert.equal(warned.level, 'WARNING')
  assert.match(warned.description, /NO reporting period/)
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

test('[o3d-r5pj] the row is NOT settled when that warning could not be persisted', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null, invoicedAt: null }],
  })
  harness.failActivityFor.add('xero_backreference_invoice_date_unrecoverable')

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null,
    'stamping past a lost warning would freeze the sale out of every VAT return with nothing saying so')
  assert.equal(harness.store.syncRows[0].status, 'FAILED', 'and it keeps the status that makes it visible')
})

test('[o3d-r5pj] a repairable type that does not carry an invoice date is settled normally', async () => {
  // The control: only SALES_INVOICE/SalesOrder writes `invoicedAt`, so a supplier credit note with
  // no date in its payload must not be dragged into the refusal.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      type: 'PURCHASE_CREDIT_NOTE',
      referenceType: 'SupplierCreditNote',
      referenceId: 'scn-1',
      externalTransactionId: 'XCN-1',
      status: 'FAILED',
      payload: {},
    })],
    bills: [],
    orders: [],
    creditNotes: [{ id: 'scn-1', accountingCreditNoteId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.repaired, 1)
  assert.equal(harness.store.creditNotes![0].accountingCreditNoteId, 'XCN-1')
  assert.equal(harness.activities.some((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable'), false)
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt)
})

test('[o3d-r5pj] an invoice date the order already has is left alone, never blanked', async () => {
  // `invoicedAt` is also set by generateInvoiceNumber, so an order can carry a perfectly good date
  // that this sync row cannot corroborate. "Do not invent one" must mean skip the column, not write
  // NULL over it — the second would take a sale OUT of the period it was correctly in.
  const alreadyInvoicedAt = new Date(Date.UTC(2026, 0, 5))
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null, invoicedAt: alreadyInvoicedAt }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.deepEqual(harness.store.orders[0].invoicedAt, alreadyInvoicedAt)
  // ...AND THE OPERATOR IS NOT TOLD OTHERWISE (Codex r10 #3). An unrecoverable payload date is a
  // fact about this sync row. Reporting it as "this sale is in NO reporting period" is a different
  // and false claim about an order that is correctly dated, and it sends a human to fix something
  // that is not broken — which is how the warning that DOES matter stops being read.
  assert.equal(
    harness.activities.some((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable'),
    false,
    'a dated sale must not be reported as having no invoice date',
  )
  assert.equal(run.repaired, 1)
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'and it settles, with nothing outstanding')
})

test('[o3d-r5pj] the warning is spent only on a sale that genuinely has no date', async () => {
  // The pair to the test above, run through the SAME unrecoverable payload, so the two differ in
  // exactly one thing: what the order itself holds. The claim in the description is checked
  // against the order, not merely against the row.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null, invoicedAt: null }],
  })

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable')
  assert.ok(warned)
  assert.match(warned.description, /the order has no invoice date of its own/,
    'the warning must say the order was checked, because that is what makes the claim true')
})

test('[o3d-r5pj] a failed invoice-date read leaves the row UNSETTLED rather than settling on no answer', async () => {
  // The read decides whether a sale is silently outside every VAT period. Swallowing its failure
  // and settling would stamp the row — and a stamped row is never looked at again.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null, invoicedAt: null }],
  })
  harness.failInvoiceDateReadFor.add('so-1')

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
  assert.equal(run.failed, 1)
  assert.equal(
    harness.activities.some((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable'),
    false,
    'and no claim is made about a period nobody could establish',
  )
})

test('[o3d-r5pj] a repair whose sales order no longer exists makes no reporting-period claim', async () => {
  // A deleted order has no period to be missing from. Warning here would name a document that is
  // not there and ask a human to date it.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { status: 'FAILED', payload: { invoiceNumber: 'INV-1' } })],
    bills: [],
    orders: [],
  })

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(
    harness.activities.some((entry) => entry.action === 'xero_backreference_invoice_date_unrecoverable'),
    false,
  )
})

test('[o3d-wf86] the sweep\'s conflict warning says which kind of link is in the way', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      type: 'PURCHASE_INVOICE',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      externalTransactionId: 'XBILL-1',
      payload: {},
    })],
    bills: [
      { id: 'bill-other', poId: 'po-other', accountingInvoiceId: 'XBILL-1', accountingInvoiceIdSource: 'PO_KEYED_REPAIR', createdAt: at(1) },
      { id: 'bill-mine', poId: 'po-1', accountingInvoiceId: null, createdAt: at(2) },
    ],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.skippedAmbiguous, 1, 'the refusal itself is unchanged — provenance informs it, it does not decide it')
  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.ok(warned)
  assert.match(warned.description, /DEDUCED by an earlier repair/, 'the operator is told the blocker is itself a guess')
  assert.equal(warned.metadata.linkedAccountingInvoiceIdSource, 'PO_KEYED_REPAIR')
})

test('[o3d-wf86] an UNRECORDED blocking link is described as unproven, not as authoritative', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      type: 'PURCHASE_INVOICE',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      externalTransactionId: 'XBILL-1',
      payload: {},
    })],
    bills: [
      { id: 'bill-other', poId: 'po-other', accountingInvoiceId: 'XBILL-1', createdAt: at(1) },
      { id: 'bill-mine', poId: 'po-1', accountingInvoiceId: null, createdAt: at(2) },
    ],
    orders: [],
  })

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_repair_ambiguous')
  assert.match(warned!.description, /never recorded/)
  assert.equal(warned!.metadata.linkedAccountingInvoiceIdSource, null)
})

// ---------------------------------------------------------------------------
// o3d-nf9i r3 (Codex round 3, finding 1) — THE SWEEP PROMOTED AN OPERATOR'S ASSERTION INTO THE
// LEDGER LINK.
//
// app/actions/accounting-settlement.ts lets a named human assert "this DID post, here is the
// document id". That writes status='SYNCED' + externalTransactionId — byte-identical to the
// connector's own writeback — and that pair IS this sweep's candidate shape. So the next cron cycle
// stamped the operator-typed string onto SalesOrder.accountingInvoiceId, which is the ledger link
// every later reader trusts: the follow-ups (PDF, attachment, PAYMENT) are built from it, the
// settlement verdict is derived against it, and the order delete guard reads it as post evidence.
//
// Round 2 shipped the basis COLUMN and made settlement-status.ts fail closed on it, and flagged in
// its own commit message that this sweep still did not consult it. These are that gate.
//
// The fixtures are the exact shape buildSettlementData writes (sync-row-settlement.ts:516): SYNCED,
// an external id, and settlementBasis='OPERATOR_ASSERTION' — on a LIVE sale, because a POSTED
// assertion on a CANCELLED sale is terminalised CANCELLED and never reaches the candidate query.
// ---------------------------------------------------------------------------

const ASSERTED = 'OPERATOR_ASSERTION'

test('[o3d-nf9i r3] the candidate SELECT reads the basis column, so the gate can see it at all', () => {
  // The gate is worthless if production never asks the database for the column: the row would
  // arrive with `settlementBasis` undefined and every assertion would read as a confirmation. The
  // harness projects by this select, so dropping the line breaks the behavioural tests below too —
  // this one names the reason.
  assert.equal(BACK_REFERENCE_CANDIDATE_SELECT.settlementBasis, true)
})

test('[o3d-nf9i r3] an OPERATOR-ASSERTED document id is NOT stamped onto the sales order', async () => {
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: ASSERTED })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.orders[0].accountingInvoiceId, null,
    'the ledger link is still empty — an unverified claim did not become the system\'s evidence')
  assert.equal(run.repaired, 0)
  assert.equal(run.skippedUnverified, 1, 'counted as a refusal in its own right')
  assert.equal(run.failed, 0, 'and NOT as a failure: nothing went wrong, the sweep declined')
  assert.deepEqual(harness.followUps, [], 'no PDF, attachment or PAYMENT is built from the asserted id')

  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_unverified_assertion')
  assert.ok(warned, 'the refusal is announced, not silent')
  assert.equal(warned.level, 'WARNING')
  assert.match(warned.description, /OPERATOR ASSERTION, not by the connector/)
  assert.match(warned.description, /XINV-TYPED/)
  assert.match(warned.description, /link it to this SalesOrder by hand/, 'the remedy is nameable and a human can perform it')
  // THE BASIS IS REPORTED, so a reader of the entry can name what the row rested on.
  assert.equal(warned.metadata.settlementBasis, ASSERTED)
  assert.equal(warned.metadata.refused, 'the back-reference')

  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null,
    'NOT stamped: a human linking the document by hand clears this, and a stamped row is never looked at again')
  assert.ok(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt, 'deferred instead, so the warning is throttled')
})

test('[o3d-nf9i r3] the SAME row shape with a CONNECTOR-CONFIRMED basis is still repaired', async () => {
  // The control that makes the test above mean something. The two rows differ in exactly one
  // column, so a gate that refused on the shape — or refused everything — would fail here.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: null })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.orders[0].accountingInvoiceId, 'XINV-TYPED')
  assert.equal(run.repaired, 1)
  assert.equal(run.skippedUnverified, 0)
  assert.deepEqual(harness.followUps.map((entry) => entry.entryId), ['log-0001'])
})

test('[o3d-nf9i r3] an asserted row whose document is ALREADY linked is settled normally', async () => {
  // The gate is narrow ON PURPOSE. A blanket "asserted rows are never candidates" would be the
  // starvation bug by a seventh route: the operator's own remedy — verify the document, link it by
  // hand — produces exactly this state, and the row must then drain rather than warn for ever.
  // Nothing here comes from the assertion; the verdict is about the DOCUMENT's state.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: ASSERTED })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-TYPED' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(run.skippedUnverified, 0, 'there is nothing left to refuse')
  assert.ok(harness.store.syncRows[0].backReferenceCheckedAt, 'so it leaves the candidate set for good')
  assert.deepEqual(harness.activities, [], 'and nobody is warned about a row that needs nothing')
})

test('[o3d-nf9i r3] an asserted row that owes FOLLOW-UPS is refused them, and keeps its FAILED verdict', async () => {
  // Reachable: the sweep claims backReferenceFollowUpsPendingAt on a FAILED candidate BEFORE it
  // repairs (claimFollowUpObligation), the apply then fails, and the row stays FAILED carrying the
  // marker. An operator settles that FAILED row as POSTED, and the document is meanwhile linked by
  // a bill-keyed sync — so `missing` is false and only the follow-ups are outstanding. Those are
  // the PDF, the attachment and the PAYMENT, all built against the asserted id.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      status: 'FAILED',
      externalTransactionId: 'XINV-TYPED',
      settlementBasis: ASSERTED,
      backReferenceFollowUpsPendingAt: at(400),
    })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-TYPED' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.deepEqual(harness.followUps, [], 'no money-moving follow-up is queued against an unverified document')
  assert.equal(run.skippedUnverified, 1)
  assert.equal(run.repaired, 0)
  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_unverified_assertion')
  assert.ok(warned)
  assert.equal(warned.metadata.refused, 'the follow-ups')
  assert.match(warned.description, /an attachment or a PAYMENT against a document nothing has checked/)
  assert.equal(harness.store.syncRows[0].status, 'FAILED', 'and the row is not rewritten to SYNCED on the way past')
  assert.ok(harness.store.syncRows[0].backReferenceFollowUpsPendingAt, 'the obligation survives for the sweep after a human checks it')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
})

test('[o3d-nf9i r3] an asserted row with no back-reference of its own is refused its outstanding follow-ups', async () => {
  // The OTHER path into the enqueue — settleOutstandingFollowUpsOnly, for a type that writes no
  // back-reference. Reachable: the outbox claims the obligation on the SYNCED write of EVERY type
  // (sync-processor.ts:1167), the nested enqueue then fails, markSyncLogForFollowUpRetry drives the
  // row to FAILED WITHOUT clearing the marker, and an operator settles that FAILED row as POSTED.
  // There is no id to stamp here, but the enqueue is handed row.externalTransactionId as the
  // syncResult's external id — so INVOICE_PDF's nested INVOICE_EMAIL would carry a document nobody
  // checked.
  const harness = makeHarness({
    syncRows: [invoicePdfRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: ASSERTED })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: 'XINV-1' }],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.deepEqual(harness.followUps, [])
  assert.equal(run.skippedUnverified, 1)
  assert.equal(run.checked, 0, 'the row was refused, not worked on')
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null, 'the obligation is not destroyed by a stamp')
  assert.ok(harness.store.syncRows[0].backReferenceFollowUpsPendingAt)
  const warned = harness.activities.find((entry) => entry.action === 'xero_backreference_unverified_assertion')
  assert.equal(warned!.metadata.refused, 'the follow-ups')
})

test('[o3d-nf9i r3] the unverified refusal is throttled and re-reported like any other, never stamped', async () => {
  // Same asymmetry as every refusal in this file: repeating a warning is noise, losing it is
  // silence. The row must come back on its own, because the only thing that clears it is a person.
  const clock = { at: at(500) }
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: ASSERTED })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })

  const first = await repairAccountingBackReferences(sweepDeps(harness, () => clock.at), { limit: 10 })
  assert.equal(first.skippedUnverified, 1)
  assert.equal(harness.activities.length, 1)

  const second = await repairAccountingBackReferences(sweepDeps(harness, () => clock.at), { limit: 10 })
  assert.equal(second.scanned, 0, 'deferred out of the candidate set for the interval')
  assert.equal(harness.activities.length, 1, 'and not re-warned about within it')

  clock.at = new Date(clock.at.getTime() + BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS + 1)
  const third = await repairAccountingBackReferences(sweepDeps(harness, () => clock.at), { limit: 10 })
  assert.equal(third.skippedUnverified, 1, 'it comes back on its own — silence about it would read as handled')
  assert.equal(harness.activities.length, 2)
  assert.match(harness.activities[1].description, /Still unresolved since this was last reported/)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null, 'and it is still refused')
})

test('[o3d-nf9i r3] an unpersisted unverified warning leaves the row immediately eligible', async () => {
  // Deferring a row nobody was told about is the one combination that helps nobody — the same
  // property r2 finding 3 established for the ambiguity warning.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, { externalTransactionId: 'XINV-TYPED', settlementBasis: ASSERTED })],
    bills: [],
    orders: [{ id: 'so-1', accountingInvoiceId: null }],
  })
  harness.failActivityFor.add('xero_backreference_unverified_assertion')

  await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.syncRows[0].backReferenceAmbiguousLoggedAt, null)
  assert.equal(harness.store.syncRows[0].backReferenceCheckedAt, null)
  assert.equal(harness.store.orders[0].accountingInvoiceId, null)
})

test('[o3d-nf9i r3] an asserted PURCHASE_INVOICE id is not written onto a bill either', async () => {
  // The gate sits after the PO attribution, so a row the resolver would have attributed UNIQUELY —
  // the one case that reaches a bill write — is still refused. Keying the gate on SalesOrder alone
  // would leave the supplier-bill half of the money path open.
  const harness = makeHarness({
    syncRows: [salesInvoiceRow(1, {
      type: 'PURCHASE_INVOICE',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      externalTransactionId: 'XBILL-TYPED',
      settlementBasis: ASSERTED,
      payload: {},
    })],
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: at(1) }],
    orders: [],
  })

  const run = await repairAccountingBackReferences(sweepDeps(harness), { limit: 10 })

  assert.equal(harness.store.bills[0].accountingInvoiceId, null)
  assert.equal(run.skippedUnverified, 1)
  assert.equal(run.skippedAmbiguous, 0, 'this is not an attribution problem — the row names exactly one bill')
  assert.equal(harness.calls.billUpdates, 0)
})
