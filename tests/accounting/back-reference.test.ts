import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccountingLinkSource } from '@/app/generated/prisma/client'

import {
  BACK_REFERENCE_REPAIRABLE_STATUSES,
  applyBackReference,
  backReferenceHolder,
  backReferenceIsMissing,
  claimFollowUpObligation,
  followUpObligationClaim,
  isExternalBillIdConflict,
  isExternalCreditNoteIdConflict,
  isExternalDocumentIdConflict,
  releaseAndRelinkExternalDocumentId,
  nextFollowUpObligationGeneration,
  releaseFollowUpObligation,
  resolvePurchaseOrderBackReference,
  syncTypeWritesBackReference,
  type BackReferenceDeps,
  type ExternalDocumentIdReleaseDeps,
  type ExternalDocumentIdReleaseRecorder,
} from '@/lib/domain/accounting/back-reference'
import {
  UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
  buildBackReferenceCandidateQuery,
} from '@/lib/domain/accounting/back-reference-sweep'
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
  /** o3d-wf86: how the link above was made. Undefined = never recorded (a pre-provenance row). */
  accountingInvoiceIdSource?: AccountingLinkSource | null
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
        // o3d-wf86: the provenance is returned because production SELECTS it and puts it in the
        // refusal. A double that dropped it would report every blocking link as unrecorded.
        return bill ? { id: bill.id, poId: bill.poId, accountingInvoiceIdSource: bill.accountingInvoiceIdSource ?? null } : null
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
      // THE TX CLIENT KEEPS `$transaction`, because Prisma's does (Codex r9 finding 2).
      //
      // An earlier revision deleted it here and in makeClaimDeps, on the strength of
      // `ITXClientDenyList`. That type is not the runtime: verified in
      // node_modules/@prisma/client/runtime/client.js (7.7.0), the deny list is exactly
      // ["$connect","$disconnect","$on","$use","$extends"] and `_createItxClient` removes only those
      // five, so `$transaction` survives and `_transactionWithCallback` opens a NESTED savepoint
      // transaction for every provider but MongoDB. Deleting it here made the double diverge from
      // production in the direction that HIDES a bug: code that would nest a transaction in
      // production looked safe in the tests. The spread below carries `deps.$transaction` through,
      // which also models the nesting — a second call simply opens another one and counts it.
      const tx = {
        ...deps,
        async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
          calls.rawStatements.push({ sql: query.join('?'), values })
          return 0
        },
      }
      return fn(tx)
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

/** The sync row the operator names on the command line, as the release re-reads it at write time. */
type ReleaseSourceRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  errorMessage: string | null
  backReferenceAmbiguousLoggedAt: Date | null
  backReferenceEvidenceCompactedAt: Date | null
  /** o3d-anu8: NULL = the connector's own writeback. 'OPERATOR_ASSERTION' = a human's claim. */
  settlementBasis: string | null
}

const CLAIM_ROW_COLUMNS = new Set(['id', 'accountingInvoiceId'])

/**
 * The double for the release path, and the two things it MUST be able to do (o3d-9kek r8):
 *
 *   • ROLL BACK. The whole of finding 1 is a failure BETWEEN the release and the re-link, so a
 *     double whose `$transaction` merely calls its callback cannot model the defect at all: every
 *     test of "the holder survives a failed re-link" would pass against a production that had no
 *     transaction, because the double never undoes anything either. This one snapshots every table
 *     it owns on entry and restores it when the callback throws.
 *   • FAIL AT A CHOSEN POINT, so that "between the two writes" is a place a test can stand.
 *
 * It also hands out a tx client with NO `$transaction`, exactly as Prisma does — see makeDeps.
 */
function makeClaimDeps(options: {
  bills: FakeBill[]
  salesOrders?: ClaimRow[]
  /** Live PURCHASE_INVOICE sync rows for the PO, for the PO-keyed attribution's count. */
  poSyncRows?: FakeSyncRow[]
  /** The named sync row. Defaults to the quarantined row RELEASE_PARAMS describes; null = deleted. */
  source?: Partial<ReleaseSourceRow> | null
  /** Runs after the claim lookup and before the conditional clear — the race `contended` reports. */
  raceAfterClaimLookup?: (bills: FakeBill[]) => void
  /** Runs after the destination has been READ as unlinked — the race the write-time fence catches. */
  raceAfterDestinationRead?: (bills: FakeBill[], salesOrders: ClaimRow[]) => void
  /** Runs after the PO attribution has read its bills — the sibling-bill interleaving. */
  raceAfterResolve?: (bills: FakeBill[]) => void
  /** Called by the write that LINKS the destination. Throw from it to die between the two writes. */
  onLinkWrite?: () => void
  /** The audit row's own write fails — the r9 finding 3 case: a destructive act with no record. */
  failAuditWrite?: boolean
}) {
  const { deps, calls } = makeDeps({ bills: options.bills, poSyncRows: options.poSyncRows, raceAfterResolve: options.raceAfterResolve })
  const bills = options.bills
  const salesOrders = options.salesOrders ?? []
  const source: ReleaseSourceRow | null = options.source === null ? null : {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseInvoice',
    referenceId: 'bill-target',
    externalTransactionId: '145',
    status: 'SYNCED',
    errorMessage: 'QuickBooks PURCHASE_INVOICE for PurchaseInvoice bill-target POSTED SUCCESSFULLY as external id 145, but …',
    backReferenceAmbiguousLoggedAt: null,
    backReferenceEvidenceCompactedAt: null,
    settlementBasis: null,
    ...options.source,
  }
  const claimCalls = {
    salesOrderFindFirst: 0,
    transactions: 0,
    /**
     * Transactions opened INSIDE another one — a savepoint, in Prisma terms. Counted separately
     * because the release's whole design is that applyBackReference joins its transaction rather
     * than nesting one, and the tx client now KEEPS `$transaction` (Codex r9 finding 2), so this is
     * the number that would move if the stripping were removed.
     */
    nestedTransactions: 0,
    rollbacks: 0,
    /** Every conditional write the release makes, in order, so a test can see WHAT it fenced on. */
    updateManyWheres: [] as Array<Record<string, unknown>>,
    sourceUpdates: [] as Array<Record<string, unknown>>,
    /** Audit rows written through the transaction — the durable record of a destructive act. */
    audits: [] as Array<Record<string, unknown>>,
  }
  let claimLookupsSeen = 0

  /** Fires the claim-lookup race exactly once, and only for the lookup's own where shape. */
  const afterClaimLookup = (where: Record<string, unknown>) => {
    const isClaimLookup = Object.keys(where).length === 1 && 'accountingInvoiceId' in where
    if (!isClaimLookup) return
    if (claimLookupsSeen++ > 0) return
    options.raceAfterClaimLookup?.(bills)
  }

  const matchSalesOrders = (where: Record<string, unknown>) => salesOrders
    .filter((row) => matches(row as unknown as Record<string, unknown>, where, CLAIM_ROW_COLUMNS))

  /**
   * THE UNDO LOG — what makes the rollback below a rollback rather than a time machine.
   *
   * It records only what a write THROUGH A DELEGATE changed, by comparing the rows either side of
   * the call. The race hooks mutate the arrays directly, standing in for another database session,
   * and their writes must SURVIVE our rollback exactly as a committed concurrent transaction does.
   * A snapshot-and-restore of every row would undo those too — and the `contended` test, whose whole
   * subject is a concurrent writer, would then assert that the concurrent write never happened.
   */
  const undo: Array<() => void> = []
  const trackWrite = async <T>(rows: Array<Record<string, unknown>>, field: string, run: () => Promise<T>): Promise<T> => {
    const before = rows.map((row) => ({ row, value: row[field] }))
    try {
      return await run()
    } finally {
      for (const { row, value } of before) if (row[field] !== value) undo.push(() => { row[field] = value })
    }
  }
  const asRows = (rows: unknown[]) => rows as Array<Record<string, unknown>>

  const claimDeps = {
    ...deps,
    salesOrder: {
      ...deps.salesOrder,
      async findFirst(args: { where: Record<string, unknown> }) {
        claimCalls.salesOrderFindFirst++
        const row = matchSalesOrders(args.where)[0]
        afterClaimLookup(args.where)
        return row ? { id: row.id } : null
      },
      async findUnique(args: { where: { id: string } }) {
        const found = salesOrders.find((candidate) => candidate.id === args.where.id)
        const row = found ? { accountingInvoiceId: found.accountingInvoiceId } : null
        options.raceAfterDestinationRead?.(bills, salesOrders)
        return row
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        return trackWrite(asRows(salesOrders), 'accountingInvoiceId', async () => {
          if (args.data.accountingInvoiceId != null) options.onLinkWrite?.()
          const row = salesOrders.find((candidate) => candidate.id === args.where.id)
          if (row) row.accountingInvoiceId = args.data.accountingInvoiceId as string | null
          return {}
        })
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        claimCalls.updateManyWheres.push(args.where)
        return trackWrite(asRows(salesOrders), 'accountingInvoiceId', async () => {
          if (args.data.accountingInvoiceId != null) options.onLinkWrite?.()
          const matched = matchSalesOrders(args.where)
          for (const row of matched) row.accountingInvoiceId = args.data.accountingInvoiceId as string | null
          return { count: matched.length }
        })
      },
    },
    salesOrderRefund: { ...deps.salesOrderRefund, async findFirst() { return null }, async updateMany() { return { count: 0 } } },
    supplierCreditNote: { ...deps.supplierCreditNote, async findFirst() { return null }, async updateMany() { return { count: 0 } } },
    purchaseInvoice: {
      ...deps.purchaseInvoice,
      async findFirst(args: { where: Record<string, unknown>; select: Record<string, unknown> }) {
        const found = await deps.purchaseInvoice.findFirst(args as never)
        afterClaimLookup(args.where)
        return found
      },
      // Per-id, against the SAME array everything else mutates. The canned version in makeDeps
      // answers every id with one value, which would make the destination check below unable to
      // tell the destination from the holder — i.e. vacuous exactly where finding 2 lives.
      async findUnique(args: { where: { id: string } }) {
        // The value is read BEFORE the concurrent writer runs, because that is what the sequence
        // being modelled is: this read saw an unlinked destination, and the link landed after it. A
        // double that returned the post-race value would collapse the race into the plain
        // already-linked case and leave the write-time fence untested.
        const bill = bills.find((candidate) => candidate.id === args.where.id)
        const row = bill ? { accountingInvoiceId: bill.accountingInvoiceId } : null
        options.raceAfterDestinationRead?.(bills, salesOrders)
        return row
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        return trackWrite(asRows(bills), 'accountingInvoiceId', async () => {
          if (args.data.accountingInvoiceId != null) options.onLinkWrite?.()
          return deps.purchaseInvoice.update(args as never)
        })
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        claimCalls.updateManyWheres.push(args.where)
        return trackWrite(asRows(bills), 'accountingInvoiceId', async () => {
          if (args.data.accountingInvoiceId != null) options.onLinkWrite?.()
          return deps.purchaseInvoice.updateMany(args as never)
        })
      },
    },
    accountingSyncLog: {
      ...deps.accountingSyncLog,
      async findUnique(args: { where: { id: string } }) {
        return source && source.id === args.where.id ? { ...source } : null
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        claimCalls.sourceUpdates.push(args.data)
        return trackWrite(source ? [source as unknown as Record<string, unknown>] : [], 'errorMessage', async () => {
          if (source && source.id === args.where.id) Object.assign(source, args.data)
          return {}
        })
      },
    },
  }

  /**
   * SAVEPOINT SEMANTICS, because Prisma has them (Codex r9 finding 2).
   *
   * A nested `$transaction` unwinds only what IT wrote and leaves the outer transaction alive, which
   * is exactly why nesting is dangerous here and not merely wasteful: applyBackReference's own catch
   * would swallow the unique-index violation, return `ambiguous` normally, and the release would
   * report a refusal with no `conflictMessage` — the one message that names which document holds the
   * id. Modelling it properly is what lets `nestedTransactions` be a real assertion rather than a
   * counter nothing can move.
   */
  let depth = 0
  const runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    claimCalls.transactions++
    if (depth > 0) claimCalls.nestedTransactions++
    // A committed transaction's writes are permanent; only the current one's are undoable.
    if (depth === 0) undo.length = 0
    const savepoint = undo.length
    depth++
    try {
      return await fn(txClient)
    } catch (error) {
      // Reverse order, so a row written twice inside the transaction ends on the value it had
      // before the FIRST of those writes.
      for (const restore of undo.splice(savepoint).reverse()) restore()
      claimCalls.rollbacks++
      throw error
    } finally {
      depth--
    }
  }

  const txClient = {
    ...claimDeps,
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
      calls.rawStatements.push({ sql: query.join('?'), values })
      return 0
    },
    // KEPT, exactly as Prisma's interactive-transaction client keeps it (Codex r9 finding 2). The
    // previous double deleted it, so the branch production actually takes — applyBackReference
    // opening a nested savepoint transaction — was never exercised, and the test that asserted "it
    // did not open one" was asserting something the double had made impossible.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => runTransaction(fn),
    activityLog: {
      async create(args: { data: Record<string, unknown> }) {
        // Through the TRANSACTION, and therefore undoable with it — which is the whole point of
        // r9 finding 3. A double that appended unconditionally would let "the audit survives a
        // rolled-back release" pass.
        if (options.failAuditWrite) throw new Error('activity log write failed')
        claimCalls.audits.push(args.data)
        undo.push(() => { claimCalls.audits.pop() })
        return {}
      },
    },
  }

  ;(claimDeps as { $transaction?: unknown }).$transaction = runTransaction

  return { claimDeps: claimDeps as unknown as ExternalDocumentIdReleaseDeps, calls, claimCalls, bills, salesOrders, source }
}

/**
 * The audit recorder every release in these tests passes — the same shape
 * scripts/release-accounting-external-id-claim.ts passes (Codex r9 finding 3).
 *
 * Module-level and shared on purpose: it writes through whatever transaction client it is handed, so
 * the SINK belongs to the harness and the recorder does not need to. What matters is that it is a
 * required argument — a release cannot be performed without something to record it.
 */
const recordRelease: ExternalDocumentIdReleaseRecorder = async (tx, release) => {
  await tx.activityLog.create({
    data: {
      entityType: 'SYSTEM',
      action: 'accounting_external_id_claim_released',
      tag: 'sync',
      level: 'WARNING',
      description: `released ${release.releasedFrom} → ${release.appliedTo.referenceType} ${release.appliedTo.referenceId}`,
      metadata: { releasedFrom: release.releasedFrom, appliedTo: release.appliedTo },
    },
  })
}

const RELEASE_PARAMS = {
  connector: 'quickbooks' as const,
  type: 'PURCHASE_INVOICE' as const,
  referenceType: 'PurchaseInvoice',
  referenceId: 'bill-target',
  externalId: '145',
  syncLogId: 'log-1',
}

/** The legacy keying: the row names the ORDER, so the bill is resolved rather than named. */
const PO_RELEASE_PARAMS = { ...RELEASE_PARAMS, referenceType: 'PurchaseOrder', referenceId: 'po-1' }
const PO_SOURCE = { referenceType: 'PurchaseOrder', referenceId: 'po-1' }
/** The one live row the PO attribution requires as evidence — the row under repair itself. */
const PO_SYNC_ROWS = [{
  id: 'log-1', connector: 'quickbooks', type: 'PURCHASE_INVOICE',
  referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'SYNCED', externalTransactionId: '145',
}]

test('[o3d-9kek r7 f1] releasing the confirmed holder links the id to the document that posted it', async () => {
  // The realm switch, end to end: company A's retired bill holds 145, company B has just issued 145
  // to bill-target, and the index refused the write. One confirmed operator action resolves both.
  const { claimDeps, bills, source, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, {
    outcome: 'relinked',
    releasedFrom: 'bill-retired',
    appliedTo: { referenceType: 'PurchaseInvoice', referenceId: 'bill-target' },
  })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null, 'the stale claim is gone')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145', 'and the ledger document is recorded')
  // Both halves in ONE transaction, and the quarantine marker cleared inside it: a resolved conflict
  // that keeps advertising itself is exactly the marker something else acts on later.
  assert.equal(claimCalls.transactions, 1)
  assert.equal(claimCalls.rollbacks, 0)
  assert.equal(source?.errorMessage, null)
})

// ---------------------------------------------------------------------------
// o3d-9kek Codex r10 finding 1 + o3d-0bfh r4 Codex HIGH — the shared obligation helpers, on their own.
//
// The connectors' behaviour is asserted end-to-end in tests/accounting/followup-obligation-writers;
// these pin the CONTRACT that makes the shape safe to reuse, so a future writer inherits the
// generation protocol instead of reinventing it — which is exactly how the connector release came to
// be standing outside it.
// ---------------------------------------------------------------------------

/** A one-row double for the obligation client, with a hook to move the row mid-call. */
function obligationClient(initial: Date | null, options: {
  onFindUnique?: () => void
  failFindUnique?: boolean
  failUpdateMany?: boolean
} = {}) {
  const row = { backReferenceFollowUpsPendingAt: initial }
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const client = {
    accountingSyncLog: {
      async findUnique(_args: { where: { id: string }; select: { backReferenceFollowUpsPendingAt: true } }) {
        if (options.failFindUnique) throw new Error('transient: read failed')
        const snapshot = { backReferenceFollowUpsPendingAt: row.backReferenceFollowUpsPendingAt }
        // THE INTERLEAVING POINT. Fired AFTER the value is snapshotted and BEFORE the compare-and-set
        // sees the row, which is the only window in which another writer can make this call's
        // observation stale — the window the CAS exists to detect.
        options.onFindUnique?.()
        return snapshot
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        if (options.failUpdateMany) throw new Error('transient: write failed')
        writes.push(args)
        const expected = (args.where as { backReferenceFollowUpsPendingAt?: Date | null }).backReferenceFollowUpsPendingAt
        const current = row.backReferenceFollowUpsPendingAt
        const matched = expected === undefined
          ? true
          : (expected === null ? current === null : current !== null && current.getTime() === expected.getTime())
        if (!matched) return { count: 0 }
        row.backReferenceFollowUpsPendingAt = (args.data as { backReferenceFollowUpsPendingAt: Date | null }).backReferenceFollowUpsPendingAt
        return { count: 1 }
      },
    },
  }
  return { client, row, writes }
}

test('[o3d-9kek r10 f1] the claim fragment is still exactly the marker, and nothing else', () => {
  const now = new Date('2026-08-17T09:00:00Z')
  assert.deepEqual(followUpObligationClaim(now), { backReferenceFollowUpsPendingAt: now })
  assert.ok(followUpObligationClaim().backReferenceFollowUpsPendingAt instanceof Date, 'and it defaults to now')
})

test('[o3d-0bfh r4] the mint is STRICTLY later than the generation observed, including inside one millisecond', () => {
  // ONE definition of the rule, shared by the sweep's compare-and-set and by both connectors. A
  // restated copy is how the connector fell out of the protocol, and a plain `now()` is not a mint:
  // the column is TIMESTAMP(3), so two writers in one millisecond would each write the value the
  // other observed and every fence built on it would prove nothing.
  const observed = new Date('2026-08-17T09:00:00.000Z')
  assert.deepEqual(nextFollowUpObligationGeneration(null, observed), observed, 'nothing observed: the clock stands')
  assert.equal(
    nextFollowUpObligationGeneration(observed, observed).getTime(),
    observed.getTime() + 1,
    'the SAME millisecond still advances',
  )
  assert.equal(
    nextFollowUpObligationGeneration(observed, new Date(observed.getTime() - 5_000)).getTime(),
    observed.getTime() + 1,
    'and a clock that has gone BACKWARDS cannot mint a generation an earlier writer could hold',
  )
  assert.equal(
    nextFollowUpObligationGeneration(observed, new Date(observed.getTime() + 5_000)).getTime(),
    observed.getTime() + 5_000,
    'a clock that has moved on is used as-is',
  )
})

test('[o3d-0bfh r4] a connector claim advances the stored generation and reports the value it wrote', async () => {
  const stored = new Date('2026-08-17T09:00:00.000Z')
  const { client, row, writes } = obligationClient(stored)
  const claim = await claimFollowUpObligation(client, {
    syncLogId: 'log-1',
    connector: 'xero',
    // The same millisecond the row already carries — the case that proved a plain `now()` unsound.
    now: stored,
  })
  assert.equal(claim.claimed, true)
  assert.ok(claim.claimed && claim.generation.getTime() === stored.getTime() + 1, 'strictly later than what it observed')
  assert.equal(row.backReferenceFollowUpsPendingAt?.getTime(), stored.getTime() + 1, 'and that is what the row now carries')
  assert.deepEqual(
    writes[0].where,
    { id: 'log-1', backReferenceFollowUpsPendingAt: stored },
    'the claim is a COMPARE-AND-SET on the generation it observed, not a write by id',
  )
})

test('[o3d-0bfh r4] a connector claim that loses the compare-and-set owns nothing and leaves the winner in place', async () => {
  const stored = new Date('2026-08-17T09:00:00.000Z')
  const other = new Date('2026-08-17T09:00:05.000Z')
  const { client, row } = obligationClient(stored, {
    // A sweep claims between this call's read and its write.
    onFindUnique: () => { row.backReferenceFollowUpsPendingAt = other },
  })
  const claim = await claimFollowUpObligation(client, { syncLogId: 'log-1', connector: 'xero', now: stored })
  assert.deepEqual(claim, { claimed: false, reason: 'contended' })
  assert.equal(row.backReferenceFollowUpsPendingAt?.getTime(), other.getTime(), "the other writer's generation stands")
})

test('[o3d-0bfh r4] a claim whose statement fails owns nothing, and the row still says it owes follow-ups', async () => {
  // Failing CLOSED is the whole asymmetry: whatever the outcome, the marker is non-null, so the row
  // still records the debt. All that is lost is the standing to say it has been paid.
  const stored = new Date('2026-08-17T09:00:00.000Z')
  const read = await claimFollowUpObligation(obligationClient(stored, { failFindUnique: true }).client,
    { syncLogId: 'log-1', connector: 'xero' })
  assert.deepEqual(read, { claimed: false, reason: 'unwritable' })
  const written = obligationClient(stored, { failUpdateMany: true })
  const wrote = await claimFollowUpObligation(written.client, { syncLogId: 'log-1', connector: 'xero' })
  assert.deepEqual(wrote, { claimed: false, reason: 'unwritable' })
  assert.equal(written.row.backReferenceFollowUpsPendingAt?.getTime(), stored.getTime(), 'the obligation is still recorded')
})

test('[o3d-0bfh r4] a release clears ONLY the generation it minted', async () => {
  const mine = new Date('2026-08-17T09:00:00.000Z')
  const { client, row, writes } = obligationClient(mine)
  const outcome = await releaseFollowUpObligation(client, { syncLogId: 'log-1', connector: 'xero', generation: mine })
  assert.equal(outcome, 'released')
  assert.equal(row.backReferenceFollowUpsPendingAt, null)
  assert.deepEqual(writes[0].where, { id: 'log-1', backReferenceFollowUpsPendingAt: mine }, 'fenced on the generation, not the id alone')
  assert.deepEqual(writes[0].data, { backReferenceFollowUpsPendingAt: null }, 'and it clears ONLY the obligation')
})

test('[o3d-0bfh r4] a release over a NEWER generation is superseded, and the newer obligation survives', async () => {
  // THE FINDING, at the unit. The connector claimed C, paused, and a sweep advanced C to S and
  // deliberately retained S over a receipt it could not register. Clearing by id erased S and the
  // next sweep stamped the row reconciled with the money still unregistered.
  const mine = new Date('2026-08-17T09:00:00.000Z')
  const sweep = new Date('2026-08-17T09:00:00.001Z')
  const { client, row } = obligationClient(sweep)
  const outcome = await releaseFollowUpObligation(client, { syncLogId: 'log-1', connector: 'xero', generation: mine })
  assert.equal(outcome, 'superseded')
  assert.equal(row.backReferenceFollowUpsPendingAt?.getTime(), sweep.getTime(), "the sweep's obligation is intact")
})

test('[o3d-0bfh r4] a release that owns no generation writes nothing at all', async () => {
  const sweep = new Date('2026-08-17T09:00:00.000Z')
  const { client, row, writes } = obligationClient(sweep)
  const outcome = await releaseFollowUpObligation(client, { syncLogId: 'log-1', connector: 'xero', generation: null })
  assert.equal(outcome, 'superseded')
  assert.equal(writes.length, 0, 'a caller that owns nothing does not get to write')
  assert.equal(row.backReferenceFollowUpsPendingAt?.getTime(), sweep.getTime())
})

test('[o3d-9kek r10 f1] a release that fails REPORTS rather than throws, leaving the work recorded as owed', async () => {
  // By the time this runs the follow-ups have already been enqueued, so a throw here would drive the
  // caller's follow-up-failure path and re-run work that succeeded. Failing to clear the marker
  // costs one idempotent re-enqueue on a later sweep; failing the entry costs a duplicate.
  const mine = new Date('2026-08-17T09:00:00.000Z')
  const { client, row } = obligationClient(mine, { failUpdateMany: true })
  const failing = await releaseFollowUpObligation(client, { syncLogId: 'log-1', connector: 'xero', generation: mine })
  assert.equal(failing, 'unwritable', 'reported, not thrown')
  assert.equal(row.backReferenceFollowUpsPendingAt?.getTime(), mine.getTime(), 'and the obligation survives the failure')
})

test('[o3d-9kek r10 f1] the release writes a link but does NOT discharge the follow-up obligation', async () => {
  // The release is the THIRD path that writes a back-reference, after the two connectors and the
  // sweep — and unlike them it enqueues no follow-ups at all. Its precondition guarantees the source
  // row owes some: the write it is repairing was REFUSED by the unique index, so on Xero the refusal
  // propagated and the follow-ups never ran, and on QuickBooks the row was quarantined mid-way.
  //
  // So the correct behaviour here is to touch neither the obligation marker nor the sweep's verdict
  // marker, leaving the row a repair candidate that still says what it owes. Asserted on the WRITES,
  // not on the resulting row: "the marker survived" would also be true of a function that set it and
  // cleared it again, and it is the absence of any write to it that is the property.
  const { claimDeps, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.deepEqual(
    claimCalls.sourceUpdates,
    [{ errorMessage: null }],
    'clearing the resolved quarantine is the ONLY thing the release may write to the sync row',
  )
  for (const update of claimCalls.sourceUpdates) {
    assert.equal('backReferenceFollowUpsPendingAt' in update, false, 'the follow-ups it did not run are still owed')
    assert.equal('backReferenceCheckedAt' in update, false, 'and the row must stay a candidate so the sweep runs them')
  }
})

// ---------------------------------------------------------------------------
// o3d-9kek Codex r9 finding 3 — the RECORD of a destructive act must be as durable as the act.
//
// The release used to commit and then write its activity entry through `logActivity`, which
// deliberately swallows database errors and returns void. So the one operation in IMS that
// intentionally clears a live accounting link could complete — holder detached, destination linked —
// with nothing anywhere saying anyone had done it. Nor could a re-run recover the record: the second
// run answers `already-correct` and exits before it would be written.
// ---------------------------------------------------------------------------

test('[o3d-9kek r9 f3] a completed release writes its audit record inside the same transaction', async () => {
  const { claimDeps, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(claimCalls.audits.length, 1, 'the release left a record')
  assert.equal(claimCalls.audits[0].action, 'accounting_external_id_claim_released')
  // It names BOTH halves, because "an id moved" without saying what was detached is not something an
  // operator can act on months later.
  assert.deepEqual(claimCalls.audits[0].metadata, {
    releasedFrom: 'bill-retired',
    appliedTo: { referenceType: 'PurchaseInvoice', referenceId: 'bill-target' },
  })
  assert.equal(claimCalls.transactions, 1, 'and it went through the release\'s own transaction, not a second one')
})

test('[o3d-9kek r9 f3] a release whose audit record cannot be written is ROLLED BACK, not left unrecorded', async () => {
  // The half that makes the previous test mean something. If the audit row could fail on its own, the
  // release would still be exactly as unrecorded as it was before — an entry that is written
  // "usually" is not a record of anything.
  const { claimDeps, claimCalls, bills, source } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    failAuditWrite: true,
  })

  await assert.rejects(
    releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease),
    /activity log write failed/,
  )

  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'the stale claim was NOT released')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null, 'and nothing was linked')
  assert.ok(source?.errorMessage, 'the quarantine text is still there, so the row still reads as unresolved')
  assert.equal(claimCalls.audits.length, 0)
  assert.equal(claimCalls.rollbacks, 1)
  // Which leaves the pre-release state intact, so the operator simply runs the command again — the
  // documented recovery for every other failure of this command.
})

test('[o3d-9kek r8 f2] running the same command a SECOND time is already-correct, not a refusal', async () => {
  // Success clears the quarantine text, which is the only conflict evidence a QuickBooks row has —
  // so a re-run has to be answered by "the id is already where you were putting it", not by the
  // no-conflict-evidence refusal, which reads as "you named the wrong row". The distinction matters
  // because the wrong reading sends an operator looking for another row to release.
  const { claimDeps, bills, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })
  const first = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)
  assert.equal(first.outcome, 'relinked')

  const second = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(second, { outcome: 'already-correct' })
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145', 'and it is still linked')
  assert.equal(claimCalls.rollbacks, 1, 'the second run wrote nothing — the no-op unwinds like any other refusal')
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

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-stale-from-an-old-warning' }, recordRelease)

  assert.deepEqual(result, { outcome: 'holder-mismatch', currentHolderId: 'bill-live' })
  assert.equal(bills.find((bill) => bill.id === 'bill-live')?.accountingInvoiceId, '145', 'the unconfirmed link is untouched')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
})

test('[o3d-9kek r7 f1] a SAME-VALUE id in another table is not a claim on this one', async () => {
  // The four unique indexes are PER TABLE. QuickBooks issues Invoice ids and Bill ids from separate
  // sequences, so Invoice 145 and Bill 145 routinely coexist and are unrelated. A lookup across all
  // four tables would name an innocent sales order as the blocker — and this path then invites an
  // operator to detach it.
  const { claimDeps, salesOrders } = makeClaimDeps({
    bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 }],
    salesOrders: [{ id: 'so-unrelated', accountingInvoiceId: '145' }],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'so-unrelated' }, recordRelease)

  // No bill holds 145, so nothing is blocking — and the sales order is neither consulted nor cleared.
  assert.deepEqual(result, { outcome: 'no-claim' })
  assert.equal(salesOrders[0].accountingInvoiceId, '145', 'the innocent sales order keeps its invoice id')
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

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'contended', holderId: 'bill-retired' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '999', 'the id it had gained is not blanked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
})

test('[o3d-9kek r7 f1] the id already being where it belongs is a no-op, not a release', async () => {
  const { claimDeps, bills } = makeClaimDeps({
    bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: '145', createdAt: 2 }],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-target' }, recordRelease)

  assert.deepEqual(result, { outcome: 'already-correct' })
  assert.equal(bills[0].accountingInvoiceId, '145', 'the link this row asked for must never be cleared by its own release')
})

// ---------------------------------------------------------------------------
// o3d-9kek r8 finding 1 — the release and the re-link are ONE TRANSACTION.
//
// Doing both halves in one FUNCTION was the r7 answer, and it was not enough: a failure between the
// two writes left the id owned by nobody — the exact state the design existed to prevent — and left
// it UNRECOVERABLE, because a re-run no longer found the holder the operator had confirmed and
// answered `no-claim` for ever. These tests stand in that window.
// ---------------------------------------------------------------------------

test('[o3d-9kek r8 f1] a re-link that dies mid-operation rolls the RELEASE back', async () => {
  // The connection drops after the claim has been cleared and before the id has been written. The
  // pre-atomic version left bill-retired with no id and bill-target with no id: one ledger document
  // attached to nothing at all, permanently for QuickBooks.
  const { claimDeps, bills, source, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    onLinkWrite: () => { throw new Error('Connection terminated unexpectedly') },
  })

  await assert.rejects(
    releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease),
    /Connection terminated unexpectedly/,
  )

  assert.equal(claimCalls.rollbacks, 1)
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'the holder still holds the id')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null, 'and nothing was linked')
  assert.notEqual(source?.errorMessage, null, 'the conflict is still recorded, because it is still unresolved')
})

test('[o3d-9kek r8 f1] and the recovery from that failure is simply running the command again', async () => {
  // The half-state was not merely bad, it was a DEAD END: with the id cleared, the operator's
  // confirmed holder no longer held anything, so every retry answered `no-claim` and the document
  // stayed detached. Rolling back is what makes the retry meaningful.
  let dropConnection = true
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    onLinkWrite: () => { if (dropConnection) throw new Error('Connection terminated unexpectedly') },
  })
  await assert.rejects(releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease))

  dropConnection = false
  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, {
    outcome: 'relinked',
    releasedFrom: 'bill-retired',
    appliedTo: { referenceType: 'PurchaseInvoice', referenceId: 'bill-target' },
  })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null)
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f1] a re-link REFUSED (not thrown) also rolls the release back', async () => {
  // Not every failed re-link throws: a PO-keyed row whose bill cannot be identified returns
  // `ambiguous`, and the r7 code took that as licence to leave the id released. The PO here has two
  // unlinked bills once the retired claim is gone, so the attribution refuses to guess.
  const { claimDeps, bills, source } = makeClaimDeps({
    bills: [
      { id: 'bill-a', poId: 'po-1', accountingInvoiceId: null, createdAt: 3 },
      { id: 'bill-b', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    poSyncRows: PO_SYNC_ROWS,
    source: PO_SOURCE,
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...PO_RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'not-relinked', applyOutcome: 'ambiguous' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'nothing was released')
  assert.equal(bills.find((bill) => bill.id === 'bill-a')?.accountingInvoiceId, null)
  assert.equal(bills.find((bill) => bill.id === 'bill-b')?.accountingInvoiceId, null)
  assert.notEqual(source?.errorMessage, null, 'and the conflict is still marked as unresolved')
})

test('[o3d-9kek r8 f1] a concurrent claimant taking the id after the resolve rolls the release back', async () => {
  // THE INTERLEAVING NO COMPARE-AND-SWAP CAN SEE, and the one only the unique index forbids: between
  // the attribution's read and its conditional write, the AUTHORITATIVE bill-keyed writer — which
  // does not take the per-PO advisory lock, because it is allowed to overwrite a legacy guess —
  // links a bill of a DIFFERENT order with this same external id. The swap's own predicate is
  // satisfied (its bill is still unlinked), the PO-scoped resolve never saw that bill at all, and
  // only the constraint stops 145 landing on two bills. The release must not survive it: the id
  // would end up on the other order's bill with the confirmed holder emptied for nothing.
  //
  // The concurrent bill is on ANOTHER PO deliberately. A second unlinked bill of THIS PO is refused
  // one step earlier, by the resolve, as MULTIPLE_UNLINKED_BILLS — which is a different code path,
  // and staging it that way leaves the constraint-classification below completely unexercised while
  // looking exactly like this test.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 3 },
      { id: 'bill-elsewhere', poId: 'po-2', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    poSyncRows: PO_SYNC_ROWS,
    source: PO_SOURCE,
    raceAfterResolve: (rows) => {
      const elsewhere = rows.find((row) => row.id === 'bill-elsewhere')
      // Only once the resolve has read its page and chosen bill-target, and only if 145 is free —
      // i.e. after the release cleared it, which is exactly the window being modelled.
      if (elsewhere && !elsewhere.accountingInvoiceId && !rows.some((row) => row.accountingInvoiceId === '145')) {
        elsewhere.accountingInvoiceId = '145'
      }
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...PO_RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'not-relinked')
  assert.equal(result.outcome === 'not-relinked' && result.applyOutcome, 'ambiguous')
  // The constraint's own words survive the classification — reaching this assertion at all is what
  // proves the write got as far as the DATABASE refusing it, rather than the resolve refusing first.
  // (On the PO-keyed path the violation propagates raw: applyBackReference's descriptive rewrite is
  // on the bill-keyed and sales-side branches, not this one.)
  assert.match(String(result.outcome === 'not-relinked' && result.conflictMessage), /Unique constraint failed/)
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'the release was rolled back')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
  // The concurrent writer's own commit SURVIVES our rollback, as a committed concurrent transaction
  // does. A double that snapshot-restored everything would undo it and make this assert the race
  // never happened.
  assert.equal(bills.find((bill) => bill.id === 'bill-elsewhere')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f1] the PO-keyed release takes the per-PO advisory lock in its OWN transaction', async () => {
  // The release must hold the lock ITSELF, for the whole operation. applyBackReference would take
  // the same lock inside a transaction of its own — and Prisma WOULD let it, since a tx client keeps
  // `$transaction` (Codex r9 finding 2) — so the release strips the method before handing the client
  // over. What that buys is not just tidiness: a nested savepoint would let applyBackReference's own
  // catch swallow a unique-index violation and answer `ambiguous` with no message, throwing away the
  // text that names which document holds the id.
  const { claimDeps, calls, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    poSyncRows: PO_SYNC_ROWS,
    source: PO_SOURCE,
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...PO_RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(claimCalls.transactions, 1, 'ONE transaction — the re-link must not open a second one')
  // The assertion that actually discriminates. Its predecessor read `calls.transactions` — makeDeps'
  // counter — which makeClaimDeps overwrites with its own `$transaction`, so nothing in the release
  // path could ever have incremented it and the assertion held whatever production did.
  assert.equal(claimCalls.nestedTransactions, 0, 'and applyBackReference did not nest one inside it')
  assert.equal(calls.rawStatements.length, 1)
  assert.match(calls.rawStatements[0].sql, /pg_advisory_xact_lock/)
  assert.deepEqual(calls.rawStatements[0].values, [BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE, 'po-1'])
})

test('[o3d-9kek r9 f2] the tx double EXPOSES $transaction, exactly as Prisma 7.7 does', async () => {
  // The fidelity check behind the assertion above, kept as its own test so that a double which
  // quietly went back to deleting the method is caught by a failure that says so.
  //
  // Verified against the installed runtime, not inferred from `ITXClientDenyList`:
  // node_modules/@prisma/client/runtime/client.js (7.7.0) defines the deny list as
  // ["$connect","$disconnect","$on","$use","$extends"], `_createItxClient` removes only those five,
  // and `$transaction` branches on `kind === "nested"` — rejecting nesting for MongoDB alone. So a
  // Prisma tx client CAN open a nested savepoint transaction, and a double without the method models
  // a client that does not exist.
  const { claimDeps } = makeClaimDeps({ bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 }] })
  let seen: unknown
  await (claimDeps as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> })
    .$transaction(async (tx) => { seen = (tx as { $transaction?: unknown }).$transaction; return null })

  assert.equal(typeof seen, 'function', 'a Prisma interactive-transaction client retains $transaction')
})

test('[o3d-9kek r9 f2] a NESTED transaction is a savepoint: it unwinds itself and leaves the outer one alive', async () => {
  // What the release avoids by stripping the method — and the reason avoiding it matters. The double
  // has to model this or "it did not nest one" is a claim about a capability the double removed.
  const { claimDeps, claimCalls, bills } = makeClaimDeps({
    bills: [{ id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 }],
  })
  const deps = claimDeps as unknown as {
    $transaction: (fn: (tx: {
      $transaction: (inner: (tx: unknown) => Promise<unknown>) => Promise<unknown>
      purchaseInvoice: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> }
    }) => Promise<unknown>) => Promise<unknown>
  }

  await deps.$transaction(async (tx) => {
    await tx.purchaseInvoice.updateMany({ where: { id: 'bill-target' }, data: { accountingInvoiceId: 'outer' } })
    await assert.rejects(tx.$transaction(async (inner) => {
      await (inner as typeof tx).purchaseInvoice.updateMany({ where: { id: 'bill-target' }, data: { accountingInvoiceId: 'inner' } })
      throw new Error('savepoint fails')
    }))
    return null
  })

  assert.equal(claimCalls.nestedTransactions, 1)
  assert.equal(bills[0].accountingInvoiceId, 'outer', 'the savepoint rolled back; the outer transaction survived and committed')
})

// ---------------------------------------------------------------------------
// o3d-9kek r8 finding 2 — the DESTINATION and the SOURCE are re-verified at write time.
//
// The operator names a sync row read off an activity entry that may be hours old. Nothing re-checked
// that the destination still NEEDED the link, so a document that had since acquired a newer, valid
// back-reference was overwritten with the older id — and the unique index could not object, because
// the old value had just been released and the two values differ.
// ---------------------------------------------------------------------------

test('[o3d-9kek r8 f2] a destination that has since acquired a NEWER id is refused, not overwritten', async () => {
  const { claimDeps, bills, source } = makeClaimDeps({
    bills: [
      // Linked correctly since the warning was written — 900 is the id this bill really posted as.
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: '900', createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'destination-refused', reason: 'ALREADY_LINKED' })
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '900', 'the newer link stands')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'and nothing was released for it')
  assert.notEqual(source?.errorMessage, null)
})

test('[o3d-9kek r8 f2] a destination linked BETWEEN the read and the write is refused by the fence', async () => {
  // The read alone cannot be the guarantee: the operator's confirmation is minutes old and another
  // writer can land between the check and the write. The write is predicated on the column still
  // being null, so the concurrent link wins and this refuses.
  let linked = false
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    raceAfterDestinationRead: (rows) => {
      if (linked) return
      const target = rows.find((row) => row.id === 'bill-target')
      if (target) { target.accountingInvoiceId = '900'; linked = true }
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'destination-refused', reason: 'CHANGED_UNDER_READ' })
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '900', 'the newer link stands')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145', 'and the holder was not emptied for it')
})

test('[o3d-9kek r8 f2] a destination that no longer exists is refused, and says so', async () => {
  const { claimDeps, bills } = makeClaimDeps({
    bills: [{ id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 }],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'destination-refused', reason: 'MISSING' })
  assert.equal(bills[0].accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f2] the sales-side release fences its destination the same way', async () => {
  // The same defect, one table over: a stale CREDIT_NOTE/SALES_INVOICE warning would move an old
  // invoice id onto a sales order that had since been invoiced properly — and payment polling marks
  // EVERY order carrying a matching id as paid, so the damage is a wrong payment, not just a wrong link.
  const { claimDeps, salesOrders } = makeClaimDeps({
    bills: [],
    salesOrders: [
      { id: 'so-target', accountingInvoiceId: '900' },
      { id: 'so-retired', accountingInvoiceId: '145' },
    ],
    source: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-target' },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, {
    ...RELEASE_PARAMS, type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-target', confirmedHolderId: 'so-retired',
  }, recordRelease)

  assert.deepEqual(result, { outcome: 'destination-refused', reason: 'ALREADY_LINKED' })
  assert.equal(salesOrders.find((row) => row.id === 'so-target')?.accountingInvoiceId, '900')
  assert.equal(salesOrders.find((row) => row.id === 'so-retired')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f2] a PO whose bill already carries the id is already-correct, not a re-attribution', async () => {
  // The PO-keyed destination is not named, it is resolved — so "does it still need the link?" has to
  // be asked of the whole order. A bill of THIS PO already holding 145 means the repair happened;
  // releasing it and re-resolving could land the id on a DIFFERENT bill of the same order.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-done', poId: 'po-1', accountingInvoiceId: '145', createdAt: 2 },
      { id: 'bill-other', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
    ],
    poSyncRows: PO_SYNC_ROWS,
    source: PO_SOURCE,
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...PO_RELEASE_PARAMS, confirmedHolderId: 'bill-done' }, recordRelease)

  assert.deepEqual(result, { outcome: 'already-correct' })
  assert.equal(bills.find((bill) => bill.id === 'bill-done')?.accountingInvoiceId, '145')
  assert.equal(bills.find((bill) => bill.id === 'bill-other')?.accountingInvoiceId, null)
})

test('[o3d-9kek r8 f2] a sync row that has since re-posted under a NEW id is refused', async () => {
  // The row the operator read said 145; it now says 146, so 145 is an id this row no longer owns and
  // releasing another record's claim on its behalf is a guess.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: { externalTransactionId: '146' },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'EXTERNAL_ID_CHANGED' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null)
})

test('[o3d-9kek r8 f2] a sync row with a sync IN FLIGHT is refused', async () => {
  // PENDING/PROCESSING means a sync is running that may post again and return a DIFFERENT id, so the
  // id the operator confirmed a holder for may be about to stop being this row's id at all.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: { status: 'PENDING' },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'NOT_REPAIRABLE_STATUS' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f2] a CANCELLED sync row is refused', async () => {
  // Deliberately abandoned (audit-46ry) — not evidence of anything owed.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: { status: 'CANCELLED' },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'NOT_REPAIRABLE_STATUS' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145')
})

test('[o3d-anu8] an OPERATOR-SETTLED source is refused, and the posted bill KEEPS its id and its provenance', async () => {
  // THE WORST OF THE EIGHT LAUNDERING READERS.
  //
  // The operator settlement action writes exactly this row: status SYNCED, the document id the
  // operator TYPED, and — into errorMessage — its own note. errorMessage is the first of the four
  // conflict markers `releaseSourceRefusal` accepts, so before o3d-anu8 this row sailed through the
  // NO_CONFLICT_EVIDENCE gate on the strength of a note the settlement itself had just written.
  //
  // What the command then did is the point, and it is why this test asserts state rather than a log
  // line: it NULLED bill-retired's accountingInvoiceId AND its accountingInvoiceIdSource — one
  // statement, deliberately, so the pair cannot come apart — and wrote the typed id onto bill-target
  // with linkSource MANUAL. bill-retired is a genuinely posted bill. Afterwards nothing in IMS names
  // the ledger document at all, and the transaction has committed, so there is nothing to undo.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', accountingInvoiceIdSource: 'BILL_KEYED_SYNC', createdAt: 1 },
    ],
    source: {
      status: 'SYNCED',
      // The note buildSettlementData writes. It is NOT conflict evidence, and the gate used to read
      // it as such.
      errorMessage: 'Settled by operator: verified POSTED as 145.',
      settlementBasis: 'OPERATOR_ASSERTION',
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'OPERATOR_ASSERTED_ID' })
  // THE EVIDENCE SURVIVES. Asserting the refusal alone would pass against a version that refused
  // AFTER releasing, and asserting only that something was logged would reproduce the defect exactly.
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145',
    'the genuinely posted bill must still hold its document id')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceIdSource, 'BILL_KEYED_SYNC',
    'and how it acquired that id — the provenance is cleared in the same statement as the id')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, null,
    'and the operator-typed id must not have been written onto the other document')
})

test('[o3d-anu8] a connector-written SYNCED row with the same shape is still repairable', async () => {
  // The other side of the fence: without this, "refuse everything SYNCED with an errorMessage" would
  // pass the test above while destroying the QuickBooks quarantine route this command exists for.
  // Same row, same note-shaped errorMessage, settlementBasis NULL — it must still release.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', accountingInvoiceIdSource: 'BILL_KEYED_SYNC', createdAt: 1 },
    ],
    source: { status: 'SYNCED', settlementBasis: null },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null)
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f2] a FAILED sync row is repairable — it is what a XERO conflict looks like', async () => {
  // The question the previous attempt at r8 left open, and getting it wrong would have made this
  // whole command useless for Xero. Xero does NOT quarantine a refused back-reference the way
  // QuickBooks does: updateBackReference lets the refusal propagate, markSyncLogForFollowUpRetry
  // retries it, and the last retry lands the row on FAILED — still carrying the external id, which
  // is persisted before the back-reference is ever attempted. So SYNCED-only would have refused
  // every Xero conflict there is: sound, and useless. The sweep and retention already treat FAILED
  // as repairable, and the release reads the SAME list.
  const { claimDeps, bills, source, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: {
      connector: 'xero',
      status: 'FAILED',
      errorMessage: 'Xero follow-up work failed after connector post: Error: Refusing to link PurchaseInvoice bill-target …',
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, connector: 'xero', confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null)
  // And its errorMessage is LEFT ALONE. On a SYNCED row that text is the quarantine marker and must
  // not outlive the conflict; on a FAILED row it is the record of what actually went wrong, and
  // erasing it would leave a FAILED row with no explanation. The status is not rewritten either —
  // moving a row into or out of SYNCED changes whether it suppresses its own re-enqueue.
  assert.deepEqual(claimCalls.sourceUpdates, [])
  assert.equal(source?.status, 'FAILED')
  assert.match(String(source?.errorMessage), /Refusing to link/)
})

test('[o3d-9kek r8 f2] the repairable-status list is the sweep\'s, not a copy of it', () => {
  // r6 finding 2 was a restated list that silently dropped a document type; the same mistake with a
  // STATUS list would have made a whole connector's conflicts unrepairable by one route and swept by
  // the other. Both read this constant, so they cannot disagree.
  assert.deepEqual([...BACK_REFERENCE_REPAIRABLE_STATUSES], ['SYNCED', 'FAILED'])
  // What retention protects from deletion / compacts to a tombstone …
  assert.deepEqual(UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE.status.in, [...BACK_REFERENCE_REPAIRABLE_STATUSES])
  // … and what the sweep actually selects to repair.
  const candidates = buildBackReferenceCandidateQuery({
    connector: 'xero', after: null, ambiguityRecheckBefore: new Date('2026-08-01T00:00:00Z'), take: 10,
  })
  assert.deepEqual((candidates.where as { status: { in: string[] } }).status.in, [...BACK_REFERENCE_REPAIRABLE_STATUSES])
})

test('[o3d-9kek r8 f2] a sync row with no record of a refusal is not evidence of one', async () => {
  // Any SYNCED row carrying an external id would otherwise do, including one whose back-reference
  // was never refused at all — and releasing another document's claim on the strength of that is the
  // wrong-document write this whole module refuses everywhere else.
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: { errorMessage: null, backReferenceAmbiguousLoggedAt: null },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'NO_CONFLICT_EVIDENCE' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f2] the repair sweep\'s deferred-refusal stamp counts as evidence too', async () => {
  // Xero's refusals come from the connector-agnostic sweep, which records them by DEFERRING the row
  // rather than by writing errorMessage. Accepting only errorMessage would leave every Xero conflict
  // with no route out at all — the defect r7 fixed, reintroduced by the fix to r8.
  const { claimDeps, bills, source, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: { connector: 'xero', errorMessage: null, backReferenceAmbiguousLoggedAt: new Date('2026-08-01T00:00:00Z') },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, {
    ...RELEASE_PARAMS, connector: 'xero', confirmedHolderId: 'bill-retired',
  }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145')
  // Nothing to clear, so nothing is written to the row: the deferral stamp is the sweep's
  // once-per-interval throttle, not a conflict marker to be reset.
  assert.deepEqual(claimCalls.sourceUpdates, [])
  assert.notEqual(source?.backReferenceAmbiguousLoggedAt, null)
})

test('[o3d-9kek r8 f2] a RETENTION TOMBSTONE is still evidence — the route out must survive compaction', async () => {
  // The guard undoing the thing it guards, one more time. Data retention compacts an unresolved row
  // to an attribution-only tombstone and NULLS errorMessage (it is free text quoting the payload).
  // For a QuickBooks conflict that erases the only marker there is — QuickBooks has no repair sweep,
  // so there is no deferred-refusal stamp either — and a release that accepted only the other
  // markers would let RETENTION permanently retire the operator's ability to fix it. Compaction is
  // scheduled by AGE and says nothing about repairability; the stamp is written exclusively to rows
  // matching UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE, so it is the strongest marker of the four.
  const { claimDeps, bills, claimCalls } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: {
      errorMessage: null,
      backReferenceAmbiguousLoggedAt: null,
      backReferenceEvidenceCompactedAt: new Date('2026-07-01T00:00:00Z'),
    },
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceId, '145')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, null)
  // Nothing to clear — the tombstone already nulled the text, and the stamp itself is a retention
  // fact, not a conflict marker to be reset.
  assert.deepEqual(claimCalls.sourceUpdates, [])
})

test('[o3d-9kek r8 f2] a sync row that has been deleted is refused', async () => {
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
    source: null,
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.deepEqual(result, { outcome: 'source-refused', reason: 'MISSING' })
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceId, '145')
})

test('[o3d-9kek r8 f1] a non-transactional client is refused outright, not run unprotected', async () => {
  // There is no degraded mode: without a transaction the release cannot be rolled back, and a
  // release that cannot be rolled back is the defect, not a lesser version of the fix.
  const { claimDeps } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', createdAt: 1 },
    ],
  })
  delete (claimDeps as { $transaction?: unknown }).$transaction

  await assert.rejects(
    releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease),
    /requires a transactional client/,
  )
})

test('[o3d-9kek r7 f1] the holder table is derived from BACK_REFERENCE_PAIRS, not restated', () => {
  // r6 finding 2 was a restated list that silently dropped a document type. A second restated list
  // would be the same defect with a new name, so the (model, column) facts live on the pairs table.
  assert.deepEqual(backReferenceHolder('SALES_INVOICE', 'SalesOrder'), { model: 'SalesOrder', column: 'accountingInvoiceId' })
  assert.deepEqual(backReferenceHolder('CREDIT_NOTE', 'SalesOrderRefund'), { model: 'SalesOrderRefund', column: 'accountingCreditNoteId' })
  // o3d-wf86: the PROVENANCE column rides on the same table, so the release path can clear the link
  // and the record of how it was made in one statement without a second per-model list. Only the
  // bill has one — it is the only document an id can be attributed to by DEDUCTION.
  assert.deepEqual(backReferenceHolder('PURCHASE_INVOICE', 'PurchaseInvoice'), { model: 'PurchaseInvoice', column: 'accountingInvoiceId', sourceColumn: 'accountingInvoiceIdSource' })
  // A PO-keyed row names the ORDER; the id still lands on one of its bills.
  assert.deepEqual(backReferenceHolder('PURCHASE_INVOICE', 'PurchaseOrder'), { model: 'PurchaseInvoice', column: 'accountingInvoiceId', sourceColumn: 'accountingInvoiceIdSource' })
  assert.deepEqual(backReferenceHolder('PURCHASE_CREDIT_NOTE', 'SupplierCreditNote'), { model: 'SupplierCreditNote', column: 'accountingCreditNoteId' })
  assert.equal(backReferenceHolder('COGS_JOURNAL', 'Shipment'), null)
})

// ---------------------------------------------------------------------------
// o3d-wf86 — a bill's link now records HOW it was made.
//
// o3d-9kek made purchase_invoices.accounting_invoice_id unique and made the PO-keyed repair refuse
// rather than overwrite an id another bill holds. That refusal is permanent because nothing recorded
// whether the blocking link came from the authoritative bill-keyed sync or from the old
// newest-unlinked-bill guess: two identical column writes, no way to tell them apart afterwards.
//
// NOTHING HERE CHANGES A DECISION. Automatic adjudication also needs connector-side confirmation —
// reading the remote bill and comparing it against both candidates — which does not exist, so the
// sweep still refuses and still names a manual action. What is now possible is telling the operator
// WHICH of the two links is the unproven one.
// ---------------------------------------------------------------------------

test('[o3d-wf86] the bill-keyed write records an AUTHORITATIVE link', async () => {
  const { deps, calls } = makeDeps({ bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }] })

  await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', externalId: 'XBILL-1' })

  assert.equal(calls.lastUpdateData?.accountingInvoiceIdSource, 'BILL_KEYED_SYNC')
})

test('[o3d-wf86] the PO-keyed repair records a DEDUCED one, in the same statement as the id', async () => {
  // Same statement deliberately: a provenance written separately could fail on its own and leave a
  // guess wearing an authoritative link's clothes, which is the state the column exists to end.
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRows: [{ id: 'log-1', connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'SYNCED', externalTransactionId: 'XBILL-1' }],
  })

  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })

  assert.equal(applied.outcome, 'applied')
  assert.equal(calls.lastUpdateData?.accountingInvoiceId, 'XBILL-1')
  assert.equal(calls.lastUpdateData?.accountingInvoiceIdSource, 'PO_KEYED_REPAIR',
    'a link reached by elimination over the PO population is not something the ledger told us')
})

test('[o3d-wf86] the conflict refusal carries the blocking link\'s provenance', async () => {
  const { deps } = makeDeps({
    bills: [
      { id: 'bill-other', poId: 'po-other', accountingInvoiceId: 'XBILL-1', accountingInvoiceIdSource: 'PO_KEYED_REPAIR', createdAt: 1 },
      { id: 'bill-mine', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
    ],
  })

  const attribution = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })

  assert.equal(attribution.outcome, 'ambiguous')
  assert.equal(attribution.outcome === 'ambiguous' ? attribution.reason : undefined, 'EXTERNAL_ID_LINKED_ELSEWHERE')
  assert.equal(attribution.outcome === 'ambiguous' ? attribution.linkedAccountingInvoiceIdSource : undefined, 'PO_KEYED_REPAIR',
    'the operator is being told the blocker is itself a guess — which is the whole point of recording it')
})

test('[o3d-wf86] a pre-provenance link reports as UNRECORDED, never as authoritative', async () => {
  // Every bill linked before this column existed answers null, and null is the honest answer: the
  // two writers were indistinguishable, so the value cannot be reconstructed. Backfilling them as
  // BILL_KEYED_SYNC would manufacture confidence on exactly the legacy rows least entitled to it.
  const { deps } = makeDeps({
    bills: [
      { id: 'bill-other', poId: 'po-other', accountingInvoiceId: 'XBILL-1', createdAt: 1 },
      { id: 'bill-mine', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
    ],
  })

  const attribution = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1', externalId: 'XBILL-1' })

  assert.equal(attribution.outcome === 'ambiguous' ? attribution.linkedAccountingInvoiceIdSource : 'missing', null)
})

test('[o3d-wf86] an operator relink records MANUAL, and the loser keeps no record of a link it lost', async () => {
  const { claimDeps, bills } = makeClaimDeps({
    bills: [
      { id: 'bill-target', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
      { id: 'bill-retired', poId: 'po-old', accountingInvoiceId: '145', accountingInvoiceIdSource: 'BILL_KEYED_SYNC', createdAt: 1 },
    ],
  })

  const result = await releaseAndRelinkExternalDocumentId(claimDeps, { ...RELEASE_PARAMS, confirmedHolderId: 'bill-retired' }, recordRelease)

  assert.equal(result.outcome, 'relinked')
  assert.equal(bills.find((bill) => bill.id === 'bill-target')?.accountingInvoiceIdSource, 'MANUAL',
    'a human comparing two documents is the strongest provenance there is, and recording it as a sync would lose it')
  assert.equal(bills.find((bill) => bill.id === 'bill-retired')?.accountingInvoiceIdSource, null,
    'a bill with no link must not keep a record of how it acquired one — the next conflict report would read it as a claim')
})
