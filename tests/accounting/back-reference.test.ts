import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyBackReference,
  backReferenceIsMissing,
  resolvePurchaseOrderBackReference,
  syncTypeWritesBackReference,
  type BackReferenceDeps,
} from '@/lib/domain/accounting/back-reference'

type FakeBill = { id: string; poId: string; accountingInvoiceId: string | null; createdAt: number }

function makeDeps(overrides: {
  salesOrderAccountingInvoiceId?: string | null
  salesOrderRefundCreditNoteId?: string | null
  purchaseInvoiceAccountingInvoiceId?: string | null
  poNullInvoiceId?: string | null
  supplierCreditNoteAccountingCreditNoteId?: string | null
  throwOnUpdate?: boolean
  /** Bills the PO attribution sees. Filtered on poId + accountingInvoiceId, as production does. */
  bills?: FakeBill[]
  /** How many live sync rows reference the PO (o3d-9kek: counted globally). */
  poSyncRowCount?: number
}) {
  const calls = {
    salesOrderUpdate: 0,
    salesOrderRefundUpdate: 0,
    purchaseInvoiceUpdate: 0,
    supplierCreditNoteUpdate: 0,
    purchaseInvoiceUpdateIds: [] as string[],
    lastUpdateData: undefined as Record<string, unknown> | undefined,
    lastCountWhere: undefined as Record<string, unknown> | undefined,
    lastBillWhere: undefined as Record<string, unknown> | undefined,
  }
  const maybeThrow = () => {
    if (overrides.throwOnUpdate) throw new Error('back-reference write failed')
  }
  const deps: BackReferenceDeps = {
    salesOrder: {
      async update(args) { maybeThrow(); calls.salesOrderUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingInvoiceId: overrides.salesOrderAccountingInvoiceId ?? null } },
    },
    salesOrderRefund: {
      async update(args) { maybeThrow(); calls.salesOrderRefundUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingCreditNoteId: overrides.salesOrderRefundCreditNoteId ?? null } },
    },
    purchaseInvoice: {
      async update(args) { maybeThrow(); calls.purchaseInvoiceUpdate++; calls.purchaseInvoiceUpdateIds.push(args.where.id); calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingInvoiceId: overrides.purchaseInvoiceAccountingInvoiceId ?? null } },
      async findFirst(args) {
        // Honours poId / accountingInvoiceId like findMany does. A findFirst that ignored
        // its where would make "refuses to guess" pass for the wrong reason: the legacy
        // code path would find nothing and write nothing, instead of writing the wrong bill.
        if (overrides.bills) {
          const where = args.where as { poId?: string; accountingInvoiceId?: string | null }
          const bill = overrides.bills
            .filter((candidate) => (where.poId === undefined || candidate.poId === where.poId))
            .filter((candidate) => (where.accountingInvoiceId === undefined || candidate.accountingInvoiceId === where.accountingInvoiceId))
            .sort((a, b) => b.createdAt - a.createdAt)[0]
          return bill ? { id: bill.id } : null
        }
        return overrides.poNullInvoiceId ? { id: overrides.poNullInvoiceId } : null
      },
      // Honours the predicates production depends on: a double that returned every bill
      // regardless of poId / accountingInvoiceId would make the ambiguity tests vacuous.
      async findMany(args) {
        calls.lastBillWhere = args.where
        const where = args.where as { poId?: string; accountingInvoiceId?: string | null }
        const matched = (overrides.bills ?? [])
          .filter((bill) => (where.poId === undefined || bill.poId === where.poId))
          .filter((bill) => (where.accountingInvoiceId === undefined || bill.accountingInvoiceId === where.accountingInvoiceId))
          .sort((a, b) => b.createdAt - a.createdAt)
        return (args.take ? matched.slice(0, args.take) : matched).map((bill) => ({ id: bill.id }))
      },
    },
    supplierCreditNote: {
      async update(args) { maybeThrow(); calls.supplierCreditNoteUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingCreditNoteId: overrides.supplierCreditNoteAccountingCreditNoteId ?? null } },
    },
    accountingSyncLog: {
      async count(args) {
        calls.lastCountWhere = args.where
        return overrides.poSyncRowCount ?? 1
      },
    },
  }
  return { deps, calls }
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
  const hasNull = makeDeps({ poNullInvoiceId: 'pi-1' })
  assert.equal(await backReferenceIsMissing(hasNull.deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }), true)

  const allLinked = makeDeps({ poNullInvoiceId: null })
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
    poSyncRowCount: 1,
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1' })
  assert.deepEqual(resolved, { outcome: 'unique', purchaseInvoiceId: 'bill-1' })

  // The count must be scoped to this connector, this PO, and the row shapes that
  // actually compete for the link — otherwise "exactly one" means nothing.
  assert.equal(calls.lastCountWhere?.connector, 'xero')
  assert.equal(calls.lastCountWhere?.type, 'PURCHASE_INVOICE')
  assert.equal(calls.lastCountWhere?.referenceType, 'PurchaseOrder')
  assert.equal(calls.lastCountWhere?.referenceId, 'po-1')
  assert.deepEqual(calls.lastCountWhere?.status, { in: ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'] })
  assert.deepEqual(calls.lastBillWhere, { poId: 'po-1', accountingInvoiceId: null })
})

test('resolvePurchaseOrderBackReference is ambiguous when another sync row references the PO', async () => {
  const { deps } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 }],
    poSyncRowCount: 2,
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'MULTIPLE_SYNC_ROWS')
})

test('resolvePurchaseOrderBackReference is ambiguous when the PO has several unlinked bills', async () => {
  const { deps } = makeDeps({
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-2', poId: 'po-1', accountingInvoiceId: null, createdAt: 2 },
    ],
    poSyncRowCount: 1,
  })
  const resolved = await resolvePurchaseOrderBackReference(deps, { connector: 'xero', purchaseOrderId: 'po-1' })
  assert.equal(resolved.outcome, 'ambiguous')
  assert.equal(resolved.outcome === 'ambiguous' && resolved.reason, 'MULTIPLE_UNLINKED_BILLS')
})

test('applyBackReference REFUSES to guess which bill an ambiguous PO row belongs to', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-old', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-new', poId: 'po-1', accountingInvoiceId: null, createdAt: 9 },
    ],
    poSyncRowCount: 1,
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'ambiguous')
  // The old code wrote onto bill-new — the newest unlinked bill — which is a guess.
  assert.equal(calls.purchaseInvoiceUpdate, 0)
})

test('applyBackReference writes an unambiguous PO row onto that exact bill', async () => {
  const { deps, calls } = makeDeps({
    bills: [
      { id: 'bill-1', poId: 'po-1', accountingInvoiceId: null, createdAt: 1 },
      { id: 'bill-linked', poId: 'po-1', accountingInvoiceId: 'XBILL-0', createdAt: 9 },
    ],
    poSyncRowCount: 1,
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'applied')
  assert.deepEqual(calls.purchaseInvoiceUpdateIds, ['bill-1'])
  assert.equal(calls.lastUpdateData?.accountingInvoiceId, 'XBILL-1')
})

test('applyBackReference reports nothing-to-apply when every bill on the PO is already linked', async () => {
  const { deps, calls } = makeDeps({
    bills: [{ id: 'bill-1', poId: 'po-1', accountingInvoiceId: 'XBILL-1', createdAt: 1 }],
    poSyncRowCount: 1,
  })
  const applied = await applyBackReference(deps, { connector: 'xero', type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' })
  assert.equal(applied.outcome, 'nothing-to-apply')
  assert.equal(calls.purchaseInvoiceUpdate, 0)
})
