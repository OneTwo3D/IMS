import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyBackReference,
  backReferenceHolder,
  backReferenceIsMissing,
  isExternalBillIdConflict,
  isExternalCreditNoteIdConflict,
  isExternalDocumentIdConflict,
  releaseAndRelinkExternalDocumentId,
  resolvePurchaseOrderBackReference,
  syncTypeWritesBackReference,
  type BackReferenceDeps,
  type ExternalDocumentIdClaimDeps,
} from '@/lib/domain/accounting/back-reference'
import { BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { adapterUniqueViolation, legacyUniqueViolation } from '../helpers/prisma-unique-error'

/** The mapped table names, so a constraint-name fixture reads like the one Postgres actually raises. */
const TABLES = {
  salesOrder: 'sales_orders',
  salesOrderRefund: 'sales_order_refunds',
  supplierCreditNote: 'supplier_credit_notes',
  purchaseInvoice: 'purchase_invoices',
} as const

type FakeBill = {
  id: string
  poId: string
  accountingInvoiceId: string | null
  createdAt: number
}
/** A competing PURCHASE_INVOICE sync row for the PO. Counted, not canned (see below). */
type FakeSyncRow = {
  id: string
  connector?: string
  type?: string
  referenceType?: string
  referenceId?: string
  status: string
  externalTransactionId: string | null
}

const SYNC_ROW_COLUMNS = new Set(['connector', 'type', 'referenceType', 'referenceId', 'status', 'externalTransactionId'])
const BILL_COLUMNS = new Set(['poId', 'accountingInvoiceId', 'id'])

/**
 * A where-clause interpreter, shared by the count and the bill queries.
 *
 * `accountingSyncLog.count` used to return a canned `poSyncRowCount` and IGNORE its where
 * entirely — which meant the status predicate and (once it existed) the
 * `externalTransactionId: { not: null }` predicate could not be exercised at all: a version
 * of production that dropped either one passed every test. It throws on an unknown column or
 * an unsupported operator so a predicate cannot silently become a no-op.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>, columns: Set<string>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matches(row, clause, columns))) return false
      continue
    }
    if (!columns.has(key)) throw new Error(`fake db: unknown column "${key}" in where clause`)
    const value = row[key] ?? null
    if (condition === null) {
      if (value !== null) return false
      continue
    }
    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>
      const unsupported = Object.keys(operators).filter((op) => !['in', 'not'].includes(op))
      if (unsupported.length > 0) throw new Error(`fake db: unsupported operator(s) ${unsupported.join(', ')} on "${key}"`)
      if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false
      if ('not' in operators) {
        if (operators.not === null) { if (value === null) return false } else if (value === operators.not) return false
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function makeDeps(overrides: {
  salesOrderAccountingInvoiceId?: string | null
  salesOrderRefundCreditNoteId?: string | null
  purchaseInvoiceAccountingInvoiceId?: string | null
  supplierCreditNoteAccountingCreditNoteId?: string | null
  throwOnUpdate?: boolean
  /** Bills the PO attribution sees. Filtered on poId + accountingInvoiceId, as production does. */
  bills?: FakeBill[]
  /** Live sync rows for the PO. The count interprets its where against these (o3d-9kek). */
  poSyncRows?: FakeSyncRow[]
  /** Omit the transaction seam, i.e. behave like a client already inside a transaction. */
  unfenced?: boolean
  /**
   * A concurrent writer, run the instant the attribution has read the bills — i.e. exactly
   * in the resolve→apply window that finding 3 is about. Mutates the SAME bill array the
   * conditional write then matches against.
   */
  raceAfterResolve?: (bills: FakeBill[]) => void
  /**
   * Which of the sales-side writes the UNIQUE INDEX rejects (o3d-9kek r6 finding 3). The three
   * sales-side columns are globally unique now too, so these updates can be refused exactly as the
   * bill update already could — and a double that could not raise the violation would leave the new
   * classification and its operator message untestable while looking tested.
   */
  uniqueViolationOn?: Array<'salesOrder' | 'salesOrderRefund' | 'supplierCreditNote'>
}) {
  const bills = overrides.bills ?? []
  const calls = {
    salesOrderUpdate: 0,
    salesOrderRefundUpdate: 0,
    purchaseInvoiceUpdate: 0,
    purchaseInvoiceUpdateMany: 0,
    supplierCreditNoteUpdate: 0,
    purchaseInvoiceUpdateIds: [] as string[],
    lastUpdateData: undefined as Record<string, unknown> | undefined,
    lastCountWhere: undefined as Record<string, unknown> | undefined,
    lastBillWhere: undefined as Record<string, unknown> | undefined,
    billFindFirstWheres: [] as Array<Record<string, unknown>>,
    transactions: 0,
    rawStatements: [] as Array<{ sql: string; values: unknown[] }>,
  }
  const maybeThrow = () => {
    if (overrides.throwOnUpdate) throw new Error('back-reference write failed')
  }
  /**
   * Raised the way PRODUCTION raises it (o3d-9kek r7 finding 2).
   *
   * This used to hand-build `meta: { target: [column] }`, which is the one shape production never
   * produces: lib/db/index.ts builds the client with `@prisma/adapter-pg`, under which `meta.target`
   * is `undefined` and the column list arrives at `meta.driverAdapterError.cause.constraint.fields`.
   * Every assertion below about the conflict message therefore passed against a classifier that,
   * live, classified EVERY P2002 — including unrelated ones — as an external-id conflict.
   */
  const maybeUniqueViolation = (model: 'salesOrder' | 'salesOrderRefund' | 'supplierCreditNote', column: string) => {
    if (!overrides.uniqueViolationOn?.includes(model)) return
    throw adapterUniqueViolation([column], { modelName: model, constraintName: `${TABLES[model]}_${column}_key` })
  }
  const matchBills = (where: Record<string, unknown>) => bills
    .filter((bill) => matches(bill as unknown as Record<string, unknown>, where, BILL_COLUMNS))
    .sort((a, b) => b.createdAt - a.createdAt)

  /**
   * THE UNIQUE INDEX, modelled. o3d-9kek r2 finding 1 is fixed by a database constraint, so a
   * double that cannot RAISE one would leave the fix untestable while looking tested: every
   * assertion about "the id was not duplicated" would pass against a production that had removed
   * the constraint handling entirely.
   *
   * Raised in the LIVE ADAPTER'S shape (o3d-9kek r7 finding 2) — `@prisma/adapter-pg`'s
   * `meta.driverAdapterError.cause.constraint.fields`, not the query engine's `meta.target`, which
   * production has not produced since the driver adapter was adopted. See tests/helpers.
   */
  const enforceExternalIdUniqueness = (data: Record<string, unknown>, writtenBillIds: string[]) => {
    const externalId = data.accountingInvoiceId
    if (typeof externalId !== 'string' || externalId === '') return
    // On the VALUE ALONE, exactly as the database index is. A double that namespaced it per
    // connection would let the realm-collision write through and hide the fact that production
    // refuses it — which is the behaviour the global index was deliberately kept for.
    const holder = bills.find((bill) => bill.accountingInvoiceId === externalId && !writtenBillIds.includes(bill.id))
    if (!holder) return
    throw adapterUniqueViolation(['accounting_invoice_id'], {
      modelName: 'PurchaseInvoice',
      constraintName: 'purchase_invoices_accounting_invoice_id_key',
    })
  }

  const deps: BackReferenceDeps = {
    salesOrder: {
      async update(args) { maybeThrow(); maybeUniqueViolation('salesOrder', 'accounting_invoice_id'); calls.salesOrderUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingInvoiceId: overrides.salesOrderAccountingInvoiceId ?? null } },
    },
    salesOrderRefund: {
      async update(args) { maybeThrow(); maybeUniqueViolation('salesOrderRefund', 'accounting_credit_note_id'); calls.salesOrderRefundUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingCreditNoteId: overrides.salesOrderRefundCreditNoteId ?? null } },
    },
    purchaseInvoice: {
      async update(args) {
        maybeThrow()
        enforceExternalIdUniqueness(args.data, [args.where.id])
        calls.purchaseInvoiceUpdate++
        calls.purchaseInvoiceUpdateIds.push(args.where.id)
        calls.lastUpdateData = args.data
        const bill = bills.find((candidate) => candidate.id === args.where.id)
        if (bill) Object.assign(bill, args.data)
        return {}
      },
      // The COMPARE-AND-SWAP. It honours `accountingInvoiceId: null` and reports how many
      // rows it actually touched — a double that ignored the predicate, or that always
      // answered 1, would make finding 3's fix untestable while looking tested.
      async updateMany(args) {
        maybeThrow()
        calls.purchaseInvoiceUpdateMany++
        const matched = matchBills(args.where)
        enforceExternalIdUniqueness(args.data, matched.map((bill) => bill.id))
        for (const bill of matched) {
          calls.purchaseInvoiceUpdateIds.push(bill.id)
          calls.lastUpdateData = args.data
          Object.assign(bill, args.data)
        }
        return { count: matched.length }
      },
      async findUnique() {
        return { accountingInvoiceId: overrides.purchaseInvoiceAccountingInvoiceId ?? null }
      },
      async findFirst(args) {
        // Honours poId / accountingInvoiceId like findMany does. A findFirst that ignored
        // its where would make "refuses to guess" pass for the wrong reason: the legacy
        // code path would find nothing and write nothing, instead of writing the wrong bill
        // — and it would make the already-linked probe indistinguishable from the
        // unlinked-bill probe, since both go through here with DIFFERENT predicates.
        //
        // Returns poId, because the claim lookup asks the WHOLE table who holds an id and then
        // decides from the OWNER's PO whether that is "already linked" or a conflict. A double
        // that dropped poId would answer every claim as a conflict — passing the new test for the
        // wrong reason and silently breaking the already-linked one.
        calls.billFindFirstWheres.push(args.where)
        const bill = matchBills(args.where)[0]
        return bill ? { id: bill.id, poId: bill.poId } : null
      },
      // Honours the predicates production depends on: a double that returned every bill
      // regardless of poId / accountingInvoiceId would make the ambiguity tests vacuous.
      async findMany(args) {
        calls.lastBillWhere = args.where
        const matched = matchBills(args.where)
        const page = (args.take ? matched.slice(0, args.take) : matched).map((bill) => ({ id: bill.id }))
        overrides.raceAfterResolve?.(bills)
        return page
      },
    },
    supplierCreditNote: {
      async update(args) { maybeThrow(); maybeUniqueViolation('supplierCreditNote', 'accounting_credit_note_id'); calls.supplierCreditNoteUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingCreditNoteId: overrides.supplierCreditNoteAccountingCreditNoteId ?? null } },
    },
    accountingSyncLog: {
      async count(args) {
        calls.lastCountWhere = args.where
        return (overrides.poSyncRows ?? [])
          .filter((row) => matches(row as unknown as Record<string, unknown>, args.where, SYNC_ROW_COLUMNS))
          .length
      },
    },
  }
  if (!overrides.unfenced) {
    deps.$transaction = async (fn) => {
      calls.transactions++
      return fn({
        ...deps,
        async $executeRaw(query, ...values) {
          calls.rawStatements.push({ sql: query.join('?'), values })
          return 0
        },
      })
    }
  }
  return { deps, calls }
}

/** The row under repair itself — every PO scenario has one, and it is counted like any other. */
function selfRow(poId: string, externalTransactionId: string | null, status = 'SYNCED'): FakeSyncRow {
  return { id: 'log-self', connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: poId, status, externalTransactionId }
}

test('syncTypeWritesBackReference covers the four back-referencing pairs only', () => {
  assert.equal(syncTypeWritesBackReference('SALES_INVOICE', 'SalesOrder'), true)
  assert.equal(syncTypeWritesBackReference('CREDIT_NOTE', 'SalesOrderRefund'), true)
  assert.equal(syncTypeWritesBackReference('PURCHASE_INVOICE', 'PurchaseInvoice'), true)
  assert.equal(syncTypeWritesBackReference('PURCHASE_INVOICE', 'PurchaseOrder'), true)
  assert.equal(syncTypeWritesBackReference('INVOICE_PAYMENT', 'SalesOrder'), false)
  assert.equal(syncTypeWritesBackReference('COGS_JOURNAL', 'CogsEntry'), false)
})

test('applyBackReference writes the external id onto a sales order', async () => {
  const { deps, calls } = makeDeps({})
  await applyBackReference(deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1', invoiceNumber: 'INV-100' })
  assert.equal(calls.salesOrderUpdate, 1)
  assert.equal(calls.lastUpdateData?.accountingInvoiceId, 'XINV-1')
})

test('applyBackReference PROPAGATES (does not swallow) a write failure so the caller can retry', async () => {
  const { deps } = makeDeps({ throwOnUpdate: true })
  await assert.rejects(
    () => applyBackReference(deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }),
    /back-reference write failed/,
  )
})

test('backReferenceIsMissing is true when the document lacks the external id, false when set', async () => {
  const missing = makeDeps({ salesOrderAccountingInvoiceId: null })
  assert.equal(await backReferenceIsMissing(missing.deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), true)

  const present = makeDeps({ salesOrderAccountingInvoiceId: 'XINV-1' })
  assert.equal(await backReferenceIsMissing(present.deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), false)
})

test('repair flow: a document orphaned by a back-reference failure is detected and re-applied', async () => {
  // 1) push succeeds, external id persisted on the sync row, but the back-reference write throws.
  const failing = makeDeps({ salesOrderAccountingInvoiceId: null, throwOnUpdate: true })
  await assert.rejects(() => applyBackReference(failing.deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }))

  // 2) repair sweep later: the document still lacks the id...
  const repair = makeDeps({ salesOrderAccountingInvoiceId: null })
  assert.equal(await backReferenceIsMissing(repair.deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), true)
  // ...so it re-applies from the stored external id and succeeds.
  await applyBackReference(repair.deps, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' })
  assert.equal(repair.calls.salesOrderUpdate, 1)
  assert.equal(repair.calls.lastUpdateData?.accountingInvoiceId, 'XINV-1')
})

test('backReferenceIsMissing for PURCHASE_INVOICE/PurchaseOrder reflects an unlinked bill', async () => {
  // Bill-backed rather than a canned findFirst result: `poNullInvoiceId` answered the SAME
  // id to every query, so the already-linked probe and the unlinked-bill probe were
  // indistinguishable and either one could be deleted without a test noticing.
  const hasNull = makeDeps({ bills: [{ id: 'pi-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }] })
  assert.equal(await backReferenceIsMissing(hasNull.deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }), true)

  const allLinked = makeDeps({ bills: [{ id: 'pi-1', poId: 'po-1', accountingInvoiceId: 'XBILL-other', createdAt: 1 }] })
  assert.equal(await backReferenceIsMissing(allLinked.deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }), false)
})

test('PURCHASE_CREDIT_NOTE/SupplierCreditNote writes accountingCreditNoteId back (g5u2)', async () => {
  assert.equal(syncTypeWritesBackReference('PURCHASE_CREDIT_NOTE', 'SupplierCreditNote'), true)

  const d = makeDeps({})
  await applyBackReference(d.deps, { connector: 'xero', type: 'PURCHASE_CREDIT_NOTE', referenceType: 'SupplierCreditNote', referenceId: 'scn-1', externalId: 'XCN-9' })
  assert.equal(d.calls.supplierCreditNoteUpdate, 1)
  assert.equal(d.calls.lastUpdateData?.accountingCreditNoteId, 'XCN-9')

  // repair probe: missing when the credit note still has no external id
  const missing = makeDeps({ supplierCreditNoteAccountingCreditNoteId: null })
  assert.equal(await backReferenceIsMissing(missing.deps, { connector: 'xero', type: 'PURCHASE_CREDIT_NOTE', referenceType: 'SupplierCreditNote', referenceId: 'scn-1', externalId: 'XCN-9' }), true)
  const linked = makeDeps({ supplierCreditNoteAccountingCreditNoteId: 'XCN-9' })
  assert.equal(await backReferenceIsMissing(linked.deps, { connector: 'xero', type: 'PURCHASE_CREDIT_NOTE', referenceType: 'SupplierCreditNote', referenceId: 'scn-1', externalId: 'XCN-9' }), false)
})

// ---------------------------------------------------------------------------
// o3d-9kek — PurchaseOrder → bill attribution. Shared by BOTH connectors' writers
// (Xero's updateBackReference and QuickBooks', which used to keep its own copy of the
// "newest unlinked bill" guess) and by the repair sweep.
// ---------------------------------------------------------------------------

test('resolvePurchaseOrderBackReference counts the whole population for the PO, not a page', async () => {
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.deepEqual(resolved, { outcome: 'unique', purchaseInvoiceId: 'bill-1' })

  // The count must be scoped to this connector, this PO, and the row shapes that
  // actually compete for the link — otherwise "exactly one" means nothing.
  assert.equal(calls.lastCountWhere?.connector, 'xero')
  assert.equal(calls.lastCountWhere?.type, 'PURCHASE_INVOICE')
  assert.equal(calls.lastCountWhere?.referenceType, 'PurchaseOrder')
  assert.equal(calls.lastCountWhere?.referenceId, 'po-1')
  assert.deepEqual(calls.lastCountWhere?.status, { in: ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'] })
  assert.deepEqual(calls.lastCountWhere?.externalTransactionId, { not: null })
  assert.deepEqual(calls.lastBillWhere, { poId: 'po-1', accountingInvoiceId: null })
})

test('resolvePurchaseOrderBackReference is ambiguous when another sync row references the PO', async () => {
  const { deps } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1'), { id: 'log-other', connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'SYNCED', externalTransactionId: 'XBILL-2' }],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'MULTIPLE_SYNC_ROWS')
})

test('resolvePurchaseOrderBackReference is ambiguous when the PO has several unlinked bills', async () => {
  const { deps } = makeDeps({
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-2', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'MULTIPLE_UNLINKED_BILLS')
})

test('[o3d-9kek f1] an external id already on a bill of the PO is already-linked, never re-attributed', async () => {
  // The exact shape of the defect: ONE legacy sync row, repaired long ago onto bill-a, and
  // ONE unlinked bill that belongs to something else. "Exactly one live row, exactly one
  // unlinked bill" calls that unique — and copies bill-a's id onto bill-b. Nothing in the
  // schema forbids the duplicate.
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: 1 },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.deepEqual(resolved, { outcome: 'already-linked', purchaseInvoiceId: 'bill-a' })

  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.deepEqual(applied, { outcome: 'already-linked', purchaseInvoiceId: 'bill-a' })
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, [], 'bill-b must not have been written to')
})

test('[o3d-9kek f2] a sibling with NO external id has posted nothing and cannot make the PO ambiguous', async () => {
  // A FAILED sibling that never reached the connector carries no external id, so it competes
  // for no bill link. Counting it manufactured ambiguity and blocked a repair that was in
  // fact unambiguous.
  const { deps } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [
      selfRow('po-1', 'XBILL-1'),
      { id: 'log-failed', connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'FAILED', externalTransactionId: null },
      { id: 'log-pending', connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'PENDING', externalTransactionId: null },
    ],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.deepEqual(resolved, { outcome: 'unique', purchaseInvoiceId: 'bill-1' })
})

test('applyBackReference REFUSES to guess which bill an ambiguous PO row belongs to', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-old', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'ambiguous')
  // The old code wrote onto bill-new — the newest unlinked bill — which is a guess.
  assert.equal(calls.purchaseInvoiceUpdate, 0)
  assert.equal(calls.purchaseInvoiceUpdateMany, 0)
})

test('applyBackReference writes an unambiguous PO row onto that exact bill', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-linked', poId: 'po-1', accountingInvoiceId: 'XBILL-0', createdAt: 9 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  // The outcome names the BILL it wrote, not the PO the row named — the caller logs that.
  assert.deepEqual(applied, { outcome: 'applied', referenceType: 'PurchaseInvoice', referenceId: 'bill-1' })
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, ['bill-1'])
  assert.equal(calls.lastUpdateData?.accountingInvoiceId, 'XBILL-1')
})

test('[o3d-9kek f3] the PO apply resolves and writes inside ONE transaction, under a per-PO advisory lock', async () => {
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'applied')
  assert.equal(calls.transactions, 1)
  assert.equal(calls.rawStatements.length, 1)
  assert.match(calls.rawStatements[0].sql, /pg_advisory_xact_lock/)
  // Keyed on the PurchaseOrder — the scope the attribution reads.
  assert.deepEqual(calls.rawStatements[0].values, [BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE, 'po-1'])
})

test('[o3d-9kek f3] a bill linked between the resolve and the write is NOT overwritten', async () => {
  // The real race: the attribution reads bill-1 as the one unlinked bill, and a normal
  // bill-keyed sync links it with its OWN (correct) external id before the write lands.
  let raced = false
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-legacy')],
    raceAfterResolve: (bills) => {
      if (raced) return
      raced = true
      bills[0].accountingInvoiceId = 'XBILL-authoritative'
    },
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-legacy' })
  assert.deepEqual(applied, { outcome: 'contended', purchaseInvoiceId: 'bill-1' })
  assert.equal(calls.purchaseInvoiceUpdateMany, 1, 'the conditional write must be attempted')
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, [], 'and must match no row')
  // The winner's id survives. The old unconditional update replaced it with XBILL-legacy.
  assert.equal(calls.lastUpdateData, undefined)
})

test('[o3d-9kek f3] the conditional write still fences when the caller is already in a transaction', async () => {
  // A tx client has no `$transaction`, so the lock cannot be taken — the compare-and-swap is
  // what still refuses the overwrite.
  let raced = false
  const { deps, calls } = makeDeps({
    unfenced: true,
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-legacy')],
    raceAfterResolve: (bills) => {
      if (raced) return
      raced = true
      bills[0].accountingInvoiceId = 'XBILL-authoritative'
    },
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-legacy' })
  assert.equal(applied.outcome, 'contended')
  assert.equal(calls.transactions, 0)
  assert.equal(calls.rawStatements.length, 0)
})

test('[o3d-9kek r2 f1] inside somebody else\'s transaction a P2002 PROPAGATES, it is not classified away', async () => {
  // The FENCED path catches the unique-index violation and returns `ambiguous`, deliberately
  // OUTSIDE the transaction (a failed statement aborts the Postgres transaction, so returning
  // normally from inside would only make the COMMIT fail). On the unfenced path there is no
  // transaction of ours to abort — we are inside the CALLER's — so swallowing the error would
  // leave their transaction aborted while telling them everything succeeded.
  let raced = false
  const { deps, calls } = makeDeps({
    unfenced: true,
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
    // bill-1 is the ONE unlinked bill when the resolver looks, so the attribution is unambiguous.
    // Then a bill-keyed writer creates a SIBLING already carrying the candidate id, after the
    // resolve and before the swap. The swap's predicate is about bill-1 alone and still matches —
    // the unique index is the only thing that can refuse it.
    raceAfterResolve: (bills) => {
      if (raced) return
      raced = true
      bills.push({ id: 'bill-sibling', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: 2 })
    },
  })
  await assert.rejects(
    () => applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'P2002', 'the caller must see the real constraint violation')
      return true
    },
  )
  assert.equal(calls.transactions, 0, 'no transaction of ours was opened — this is the caller\'s')
  assert.equal(calls.lastUpdateData, undefined, 'and no second copy of the id was written')
})

test('applyBackReference reports nothing-to-apply when every bill on the PO is already linked', async () => {
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: 'XBILL-other', createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'nothing-to-apply')
  assert.equal(calls.purchaseInvoiceUpdate, 0)
  assert.equal(calls.purchaseInvoiceUpdateMany, 0)
})

// ---------------------------------------------------------------------------
// o3d-9kek ROUND 2 — the already-linked guard was PO-scoped and ran in a separate statement
// from the compare-and-swap, so two interleavings still produced two bills carrying one
// external id. The invariant is now enforced by a unique index; these tests exist to prove
// the index is actually relied upon, and that a violation is CLASSIFIED rather than retried
// into an overwrite.
// ---------------------------------------------------------------------------

test('[o3d-9kek r2 f1] the claim lookup asks the whole table, not just this PO', async () => {
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  // A poId in this predicate is the defect: it is what made an id held by another order's bill
  // invisible, and the write a silent duplicate. The predicate must be the id and NOTHING else —
  // the whole table, matching the global unique index that backs it.
  assert.deepEqual(calls.billFindFirstWheres[0], { accountingInvoiceId: 'XBILL-1' })
})

test('[o3d-9kek r2 f1] an external id already on ANOTHER PO\'s bill is a conflict, not a free slot', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      // The holder — a bill of a DIFFERENT order. The PO-scoped guard never saw it.
      { id: 'bill-elsewhere', poId: 'po-2', accountingInvoiceId: 'XBILL-1', createdAt: 1 },
      { id: 'bill-here', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })

  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'EXTERNAL_ID_LINKED_ELSEWHERE')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.linkedPurchaseInvoiceId, 'bill-elsewhere')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.linkedPurchaseOrderId, 'po-2')

  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'ambiguous')
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, [], 'nothing may be written while the id is spoken for')
  assert.equal(calls.purchaseInvoiceUpdateMany, 0)
})

test('[o3d-9kek r2 f1] a SIBLING bill taking the id after the resolve cannot receive a second copy', async () => {
  // The interleaving neither the guard nor the compare-and-swap can see. bill-a is the sole
  // unlinked bill, so the attribution is legitimately unique; bill-b holds an older id, so the
  // guard finds no conflict. Then the authoritative bill-keyed writer links bill-b with the very
  // id this repair is about to write. The swap's predicate asks only whether BILL-A is still
  // unlinked — it is — so the swap matches and the id lands twice. Only the unique index refuses.
  let raced = false
  const bills: FakeBill[] = [
    { id: 'bill-a', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
    { id: 'bill-b', poId: 'po-1', accountingInvoiceId: 'XBILL-old', createdAt: 9 },
  ]
  const { deps, calls } = makeDeps({
    bills,
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
    raceAfterResolve: (live) => {
      if (raced) return
      raced = true
      live[1].accountingInvoiceId = 'XBILL-1'
    },
  })

  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'ambiguous')
  assert.equal(applied.outcome === 'ambiguous' && applied.attribution.reason, 'EXTERNAL_ID_CLAIMED_CONCURRENTLY')
  assert.equal(calls.purchaseInvoiceUpdateMany, 1, 'the swap must have been attempted — that is the race')
  // The point of the whole exercise: exactly ONE bill carries XBILL-1, and it is the one the
  // authoritative writer chose. bill-a is still unlinked, which is the acceptable outcome.
  assert.deepEqual(bills.filter((bill) => bill.accountingInvoiceId === 'XBILL-1').map((bill) => bill.id), ['bill-b'])
  assert.equal(bills[0].accountingInvoiceId, null)
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, [], 'and the swap wrote nothing')
})

test('[o3d-9kek r2 f1] the authoritative bill-keyed write refuses a duplicate id with an explanation', async () => {
  // The bill-keyed path is allowed to overwrite a legacy guess, but it is not allowed to give a
  // second local bill the same ledger document (the o3d-6l3 upsert defect did exactly that).
  const { deps } = makeDeps({
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: 1 },
      { id: 'bill-2', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
    ],
  })
  await assert.rejects(
    () => applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: 'bill-2', externalId: 'XBILL-1' }),
    /ALREADY HELD LOCALLY by another purchase invoice/,
  )
})

test('[o3d-9kek r2 f2] ZERO live sync rows is refused, not silently treated as "exactly one"', async () => {
  // Retention deletes accounting_sync_logs by age, independently of the sweep, so the row whose
  // external id is being repaired can be gone by the time the attribution is decided. Zero used
  // to fall through to `unique` and stamp an in-memory id after its evidence had disappeared.
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [],
  })

  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'NO_LIVE_SYNC_ROW')

  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'ambiguous')
  assert.equal(calls.purchaseInvoiceUpdateMany, 0)
  assert.equal(calls.lastUpdateData, undefined)
})

test('[o3d-9kek f1] backReferenceIsMissing stops reporting a PO row whose id is already on a bill', async () => {
  const alreadyApplied = makeDeps({
    bills: [
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: 1 },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  assert.equal(
    await backReferenceIsMissing(alreadyApplied.deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }),
    false,
  )

  const genuinelyMissing = makeDeps({
    bills: [{ id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 }],
    poSyncRows: [selfRow('po-1', 'XBILL-1')],
  })
  assert.equal(
    await backReferenceIsMissing(genuinelyMissing.deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }),
    true,
  )
})

// ---------------------------------------------------------------------------
// o3d-9kek — THE REALM-COLLISION TRADE, made explicit.
//
// The unique index is GLOBAL, on the value alone. QuickBooks realm ids are integers that repeat
// across companies, and disconnect keeps historical bill ids, so after a reconnect to a different
// company a new bill can post remotely and then collide locally with a retired realm's bill.
//
// That is a REFUSED WRITE WITH A LOUD ERROR, deliberately, and it is what these two tests pin. The
// alternative — namespacing the id per connection so both bills can hold the same integer — was
// implemented and reverted: it permits the collision, and ~190 call sites read a naked
// accountingInvoiceId on models that have no provenance column at all. Failing to repair is
// acceptable; repairing onto the wrong bill is not. See o3d-gt8r.
// ---------------------------------------------------------------------------

test('[o3d-9kek] a bill id a retired realm still holds BLOCKS the new link, loudly', async () => {
  // 1042 was issued by the company we used to be connected to and is still on bill-old. QuickBooks
  // has since reissued 1042 in the company we are connected to now.
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-old', poId: 'po-9', accountingInvoiceId: '1042', createdAt: 1 }],
  })
  await assert.rejects(
    () => applyBackReference(deps, { connector: 'quickbooks', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: 'bill-new', externalId: '1042' }),
    (error: Error) => {
      // The operator has to be able to act on this without reading the source: what is wrong (the
      // id is already held locally) and the likeliest cause (a reconnect to a different company).
      assert.match(error.message, /ALREADY HELD LOCALLY/)
      assert.match(error.message, /reconnected to a different company/)
      assert.match(error.message, /1042/)
      return true
    },
  )
  // And nothing was written: the refusal is the whole point.
  assert.equal(calls.purchaseInvoiceUpdateIds.length, 0)
})

test('[o3d-9kek] the PO-keyed repair path reports the same collision instead of duplicating the id', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-old', poId: 'po-9', accountingInvoiceId: '1042', createdAt: 1 },
      { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRows: [{ id: 'log-self', connector: 'quickbooks', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'SYNCED', externalTransactionId: '1042' }],
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'quickbooks', purchaseOrderId: 'po-1', externalId: '1042' })
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'EXTERNAL_ID_LINKED_ELSEWHERE')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.linkedPurchaseInvoiceId, 'bill-old')

  const applied = await applyBackReference(deps, { connector: 'quickbooks', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: '1042' })
  assert.equal(applied.outcome, 'ambiguous')
  assert.equal(calls.purchaseInvoiceUpdateIds.length, 0, 'the new bill must NOT receive a second copy of 1042')
})

// ---------------------------------------------------------------------------
// o3d-9kek r6 finding 3 — the SALES-SIDE columns are globally unique too.
//
// 20260815140000 constrained purchase_invoices.accounting_invoice_id and argued the case in full,
// but the argument was never bill-specific: it is about what a stored external id is USED FOR.
// sales_orders.accounting_invoice_id, sales_order_refunds.accounting_credit_note_id and
// supplier_credit_notes.accounting_credit_note_id had no constraint at all, and on the sales side a
// duplicate is if anything worse — payment polling selects EVERY local row carrying a matching id
// and marks each one paid, so one customer payment settles two orders.
//
// These tests are about the WRITER's half: a refusal has to arrive as something an operator can act
// on. A bare `update` would surface Prisma's `Unique constraint failed on the fields:
// (accounting_invoice_id)` — a column name, no document, no action — which is indistinguishable
// from a schema bug.
// ---------------------------------------------------------------------------

const CONFLICT_CASES = [
  {
    label: 'SalesOrder',
    model: 'salesOrder' as const,
    params: { type: 'SALES_INVOICE' as const, referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-9' },
    expectDocument: /SalesOrder so-1/,
    expectRemote: /invoice XINV-9/,
  },
  {
    label: 'SalesOrderRefund',
    model: 'salesOrderRefund' as const,
    params: { type: 'CREDIT_NOTE' as const, referenceType: 'SalesOrderRefund', referenceId: 'ref-1', externalId: 'XCN-9' },
    expectDocument: /SalesOrderRefund ref-1/,
    expectRemote: /credit note XCN-9/,
  },
  {
    label: 'SupplierCreditNote',
    model: 'supplierCreditNote' as const,
    params: { type: 'PURCHASE_CREDIT_NOTE' as const, referenceType: 'SupplierCreditNote', referenceId: 'scn-1', externalId: 'XCN-8' },
    expectDocument: /SupplierCreditNote scn-1/,
    expectRemote: /credit note XCN-8/,
  },
]

for (const testCase of CONFLICT_CASES) {
  test(`[o3d-9kek r6 f3] a duplicate external id on ${testCase.label} is refused with an explanation`, async () => {
    const { deps } = makeDeps({ uniqueViolationOn: [testCase.model] })

    await assert.rejects(
      () => applyBackReference(deps, { connector: 'xero', ...testCase.params }),
      (error: Error) => {
        // The document, the remote id, and what the operator must do. Prisma's own message has none
        // of the three.
        assert.match(error.message, /Refusing to link/)
        assert.match(error.message, testCase.expectDocument)
        assert.match(error.message, testCase.expectRemote)
        assert.match(error.message, /ALREADY HELD LOCALLY/)
        assert.match(error.message, /resolve it by hand/)
        // The realm-switch cause named, as the bill writer does: this is the single likeliest
        // explanation and the one an operator would otherwise never think of.
        assert.match(error.message, /reconnected to a different company/)
        // The original P2002 is preserved as the cause — the sweep classifies on it, and a message
        // that replaced rather than wrapped it would make every explanatory rethrow unrecognisable.
        assert.equal((error.cause as { code?: string } | undefined)?.code, 'P2002')
        return true
      },
    )
  })
}

test('[o3d-9kek r6 f3] the supplier credit-note refusal names the blank-number collision', async () => {
  // Xero's POST /CreditNotes is create-or-update on CreditNoteNumber, and the payload builder falls
  // back to the PO reference when the operator leaves the number blank — so two manual credit notes
  // on one PO can post the same number and come back with the same id. That is the one cause with a
  // live code path today, and the message points at it rather than leaving a puzzle.
  const { deps } = makeDeps({ uniqueViolationOn: ['supplierCreditNote'] })

  await assert.rejects(
    () => applyBackReference(deps, {
      connector: 'xero', type: 'PURCHASE_CREDIT_NOTE', referenceType: 'SupplierCreditNote', referenceId: 'scn-1', externalId: 'XCN-8',
    }),
    /blank credit-note number/,
  )
})

test('[o3d-9kek r6 f3] a NON-uniqueness write failure is still propagated untouched', async () => {
  // The classification must not become a catch-all: a transient write error has to keep reaching the
  // caller as itself, so the sync row retries instead of being reported as a permanent conflict.
  const { deps } = makeDeps({ throwOnUpdate: true })

  await assert.rejects(
    () => applyBackReference(deps, {
      connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-9',
    }),
    /back-reference write failed/,
  )
})

// ---------------------------------------------------------------------------
// o3d-9kek r7 finding 2 — the P2002 classifier must identify the CONSTRAINT, not just the code.
//
// The classifier read `meta.target` and nothing else, and treated an absent target as "ours".
// `meta.target` is `undefined` under `@prisma/adapter-pg`, which is what lib/db/index.ts builds the
// client with — so LIVE, every unique-constraint violation of any kind on any of these models was
// reported to the operator as an accounting external-id collision, complete with a message about
// realm switches and a remedy for a constraint that had not failed.
//
// Every test below is paired with the OTHER column's classifier returning false, because that pairing
// is what the old code could not satisfy: it answered true to both for anything it could not read.
// ---------------------------------------------------------------------------

test('[o3d-9kek r7 f2] the LIVE adapter shape is classified by the right column classifier only', () => {
  const violation = adapterUniqueViolation(['accounting_invoice_id'], {
    modelName: 'PurchaseInvoice',
    constraintName: 'purchase_invoices_accounting_invoice_id_key',
  })

  assert.equal(isExternalBillIdConflict(violation), true, 'meta.target is undefined here — the adapter reports constraint.fields')
  assert.equal(isExternalCreditNoteIdConflict(violation), false, 'a bill-column violation is not a credit-note conflict')
})

test('[o3d-9kek r7 f2] an UNRELATED unique constraint is NOT reported as an external-id conflict', () => {
  // The concrete regression: SalesOrderRefund carries its own unique externalRefundId. Under the
  // live adapter this violation has no meta.target at all, so the old classifier claimed it — and
  // the operator was told an accounting id was duplicated and pointed at a realm switch.
  const violation = adapterUniqueViolation(['externalRefundId'], {
    modelName: 'SalesOrderRefund',
    constraintName: 'sales_order_refunds_connector_externalRefundId_key',
  })

  assert.equal(isExternalBillIdConflict(violation), false)
  assert.equal(isExternalCreditNoteIdConflict(violation), false)
  assert.equal(isExternalDocumentIdConflict(violation), false, 'the sweep would have deferred it as a human-only id conflict')
})

test('[o3d-9kek r7 f2] a P2002 that identifies NOTHING is not claimed — fail closed', () => {
  // FAIL CLOSED means "do not claim what you cannot identify". The old comment called the opposite
  // fail-closed on the grounds that refusing a write is safe — but nothing here decides whether to
  // write. The write has ALREADY been refused by the database; this only decides what is reported.
  assert.equal(isExternalBillIdConflict({ code: 'P2002' }), false)
  assert.equal(isExternalCreditNoteIdConflict({ code: 'P2002', meta: {} }), false)
})

test('[o3d-9kek r7 f2] a column that merely CONTAINS ours is not ours', () => {
  // The old matcher was `String(target).includes(column)`.
  assert.equal(isExternalBillIdConflict(legacyUniqueViolation(['accounting_invoice_id_hash'])), false)
  assert.equal(isExternalCreditNoteIdConflict(legacyUniqueViolation(['accounting_credit_note_id_digest'])), false)
})

test('[o3d-9kek r7 f2] the constraint NAME alone identifies the column when no field list arrives', () => {
  // Some adapter builds report the index name rather than the columns, and the raw-message fallback
  // always does. Postgres names a single-column unique index `<table>_<column>_key`, which the
  // shared reader anchors on by suffix.
  const byMessageOnly = {
    code: 'P2002',
    meta: {
      driverAdapterError: {
        cause: { originalMessage: 'duplicate key value violates unique constraint "purchase_invoices_accounting_invoice_id_key"' },
      },
    },
  }

  assert.equal(isExternalBillIdConflict(byMessageOnly), true)
  assert.equal(isExternalCreditNoteIdConflict(byMessageOnly), false, 'the old reader saw no meta.target here and claimed it for both columns')

  const byIndexName = legacyUniqueViolation('purchase_invoices_accounting_invoice_id_key')
  assert.equal(isExternalBillIdConflict(byIndexName), true)
  assert.equal(isExternalCreditNoteIdConflict(byIndexName), false)
})

test('[o3d-9kek r7 f2] the cause chain is still walked, in the live shape', () => {
  // applyBackReference rethrows a plain Error with the violation as `cause`, so the sweep only ever
  // sees the wrapper. r6 finding 3 fixed that; this holds it while the shape underneath changes.
  const wrapped = new Error('Refusing to link PurchaseInvoice bill-1 …', {
    cause: adapterUniqueViolation(['accounting_invoice_id'], { constraintName: 'purchase_invoices_accounting_invoice_id_key' }),
  })

  assert.equal(isExternalDocumentIdConflict(wrapped), true)
  assert.equal(isExternalCreditNoteIdConflict(wrapped), false)
})

// ---------------------------------------------------------------------------
// o3d-9kek r7 finding 1 — the release path.
//
// A refused back-reference for a document that HAS ALREADY POSTED left the operator with an
// instruction they could not carry out: "link it by hand" is refused by the same unique index.
// releaseAndRelinkExternalDocumentId is the route out — but it is also the one operation in this
// module that DELIBERATELY clears a link, so the guards on it are the whole point.
// ---------------------------------------------------------------------------

type ClaimRow = { id: string; accountingInvoiceId: string | null }

function makeClaimDeps(options: {
  bills: Array<{ id: string; poId: string; accountingInvoiceId: string | null; createdAt: number }>
  salesOrders?: ClaimRow[]
  /** Runs after the claim lookup and before the conditional clear — the race `contended` reports. */
  raceAfterClaimLookup?: (bills: Array<{ id: string; accountingInvoiceId: string | null }>) => void
}) {
  const { deps, calls } = makeDeps({ bills: options.bills })
  const salesOrders = options.salesOrders ?? []
  const claimCalls = { salesOrderFindFirst: 0, billUpdateManyWheres: [] as Array<Record<string, unknown>> }

  const claimDeps: ExternalDocumentIdClaimDeps & BackReferenceDeps = {
    ...deps,
    salesOrder: {
      ...deps.salesOrder,
      async findFirst(args: { where: Record<string, unknown> }) {
        claimCalls.salesOrderFindFirst++
        return salesOrders.find((row) => row.accountingInvoiceId === args.where.accountingInvoiceId) ?? null
      },
      async updateMany() { throw new Error('the sales-order claim must not be touched by a bill release') },
    } as never,
    salesOrderRefund: { ...deps.salesOrderRefund, async findFirst() { return null }, async updateMany() { return { count: 0 } } } as never,
    supplierCreditNote: { ...deps.supplierCreditNote, async findFirst() { return null }, async updateMany() { return { count: 0 } } } as never,
    purchaseInvoice: {
      ...deps.purchaseInvoice,
      async findFirst(args: { where: Record<string, unknown>; select: Record<string, unknown> }) {
        const found = await deps.purchaseInvoice.findFirst(args as never)
        options.raceAfterClaimLookup?.(options.bills)
        return found
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        claimCalls.billUpdateManyWheres.push(args.where)
        return deps.purchaseInvoice.updateMany(args as never)
      },
    } as never,
  }
  return { claimDeps, calls, claimCalls, bills: options.bills }
}

const RELEASE_PARAMS = {
  connector: 'quickbooks' as const,
  type: 'PURCHASE_INVOICE' as const,
  referenceType: 'PurchaseInvoice',
  referenceId: 'bill-target',
  externalId: '145',
}

test('[o3d-9kek r7 f1] releasing the confirmed holder links the id to the document that posted it', async () => {
  // The realm switch, end to end: company A's retired bill holds 145, company B has just issued 145
  // to bill-target, and the index refused the write. One confirmed operator action resolves both.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' })

  assert.deepEqual(result, {
    outcome: 'relinked',
    releasedFrom: 'bill-retired',
    appliedTo: { referenceType: 'PurchaseInvoice', referenceId: 'bill-target' },
  })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null, 'the stale claim is gone')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145', 'and the ledger document is recorded')
})

test('[o3d-9kek r7 f1] a holder the operator did NOT confirm is refused, not released', async () => {
  // The confirmation is the ONLY thing separating a retired realm's stale id from a live, correct
  // link — nothing in the database distinguishes them. A confirmation about a different document
  // confirms nothing, so this must write nothing at all.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-live', poId: 'po-other', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-stale-from-an-old-warning' })

  assert.deepEqual(result, { outcome: 'holder-mismatch', currentHolderId: 'bill-live' })
  assert.equal(bills.find((bill) => bill.id === 'bill-live')?.accountingInvoiceId, '145', 'the unconfirmed link is untouched')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
})

test('[o3d-9kek r7 f1] a SAME-VALUE id in another table is not a claim on this one', async () => {
  // The four unique indexes are PER TABLE. QuickBooks issues Invoice ids and Bill ids from separate
  // sequences, so Invoice 145 and Bill 145 routinely coexist and are unrelated. A lookup across all
  // four tables would name an innocent sales order as the blocker — and this path then invites an
  // operator to detach it.
  const { claimDeps } = makeClaimDeps({
    bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 }],
    salesOrders: [{ id: 'so-unrelated', accountingInvoiceId: '145' }],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'so-unrelated' })

  // No bill holds 145, so nothing is blocking — and the sales order is neither consulted nor cleared.
  assert.deepEqual(result, { outcome: 'no-claim' })
})

test('[o3d-9kek r7 f1] a holder that changes under the read is contended, not clobbered', async () => {
  // The clear is a conditional updateMany requiring exactly one row, the same compare-and-swap idiom
  // as the PO attribution. Without the predicate this would blank whatever the id had become.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    raceAfterClaimLookup: (rows) => {
      const retired = rows.find((row) => row.id === 'bill-retired')
      if (retired) retired.accountingInvoiceId = '999'
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' })

  assert.deepEqual(result, { outcome: 'contended', holderId: 'bill-retired' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '999', 'the id it had gained is not blanked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
})

test('[o3d-9kek r7 f1] the id already being where it belongs is a no-op, not a release', async () => {
  const { claimDeps, bills } = makeClaimDeps({
    bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: '145', createdAt: 2 }],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-target' })

  assert.deepEqual(result, { outcome: 'already-correct' })
  assert.equal(bills[0].accountingInvoiceId, '145', 'the link this row asked for must never be cleared by its own release')
})

test('[o3d-9kek r7 f1] the holder table is derived from BACK_REFERENCE_PAIRS, not restated', () => {
  // r6 finding 2 was a restated list that silently dropped a document type. A second restated list
  // would be the same defect with a new name, so the (model, column) facts live on the pairs table.
  assert.deepEqual(backReferenceHolder('SALES_INVOICE', 'SalesOrder'), { model: 'SalesOrder', column: 'accountingInvoiceId' })
  assert.deepEqual(backReferenceHolder('CREDIT_NOTE', 'SalesOrderRefund'), { model: 'SalesOrderRefund', column: 'accountingCreditNoteId' })
  assert.deepEqual(backReferenceHolder('PURCHASE_INVOICE', 'PurchaseInvoice'), { model: 'PurchaseInvoice', column: 'accountingInvoiceId' })
  // A PO-keyed row names the ORDER; the id still lands on one of its bills.
  assert.deepEqual(backReferenceHolder('PURCHASE_INVOICE', 'PurchaseOrder'), { model: 'PurchaseInvoice', column: 'accountingInvoiceId' })
  assert.deepEqual(backReferenceHolder('PURCHASE_CREDIT_NOTE', 'SupplierCreditNote'), { model: 'SupplierCreditNote', column: 'accountingCreditNoteId' })
  assert.equal(backReferenceHolder('COGS_JOURNAL', 'Shipment'), null)
})
