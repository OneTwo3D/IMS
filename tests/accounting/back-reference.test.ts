import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyBackReference,
  backReferenceIsMissing,
  syncTypeWritesBackReference,
  type BackReferenceDeps,
} from '@/lib/domain/accounting/back-reference'

function makeDeps(overrides: {
  salesOrderAccountingInvoiceId?: string | null
  salesOrderRefundCreditNoteId?: string | null
  purchaseInvoiceAccountingInvoiceId?: string | null
  poNullInvoiceId?: string | null
  throwOnUpdate?: boolean
}) {
  const calls = {
    salesOrderUpdate: 0,
    salesOrderRefundUpdate: 0,
    purchaseInvoiceUpdate: 0,
    lastUpdateData: undefined as Record<string, unknown> | undefined,
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
      async update(args) { maybeThrow(); calls.purchaseInvoiceUpdate++; calls.lastUpdateData = args.data; return {} },
      async findUnique() { return { accountingInvoiceId: overrides.purchaseInvoiceAccountingInvoiceId ?? null } },
      async findFirst() { return overrides.poNullInvoiceId ? { id: overrides.poNullInvoiceId } : null },
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
  await applyBackReference(deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1', invoiceNumber: 'INV-100' })
  assert.equal(calls.salesOrderUpdate, 1)
  assert.equal(calls.lastUpdateData?.accountingInvoiceId, 'XINV-1')
})

test('applyBackReference PROPAGATES (does not swallow) a write failure so the caller can retry', async () => {
  const { deps } = makeDeps({ throwOnUpdate: true })
  await assert.rejects(
    () => applyBackReference(deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }),
    /back-reference write failed/,
  )
})

test('backReferenceIsMissing is true when the document lacks the external id, false when set', async () => {
  const missing = makeDeps({ salesOrderAccountingInvoiceId: null })
  assert.equal(await backReferenceIsMissing(missing.deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), true)

  const present = makeDeps({ salesOrderAccountingInvoiceId: 'XINV-1' })
  assert.equal(await backReferenceIsMissing(present.deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), false)
})

test('repair flow: a document orphaned by a back-reference failure is detected and re-applied', async () => {
  // 1) push succeeds, external id persisted on the sync row, but the back-reference write throws.
  const failing = makeDeps({ salesOrderAccountingInvoiceId: null, throwOnUpdate: true })
  await assert.rejects(() => applyBackReference(failing.deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }))

  // 2) repair sweep later: the document still lacks the id...
  const repair = makeDeps({ salesOrderAccountingInvoiceId: null })
  assert.equal(await backReferenceIsMissing(repair.deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' }), true)
  // ...so it re-applies from the stored external id and succeeds.
  await applyBackReference(repair.deps, { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', externalId: 'XINV-1' })
  assert.equal(repair.calls.salesOrderUpdate, 1)
  assert.equal(repair.calls.lastUpdateData?.accountingInvoiceId, 'XINV-1')
})

test('backReferenceIsMissing for PURCHASE_INVOICE/PurchaseOrder reflects an unlinked bill', async () => {
  const hasNull = makeDeps({ poNullInvoiceId: 'pi-1' })
  assert.equal(await backReferenceIsMissing(hasNull.deps, { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }), true)

  const allLinked = makeDeps({ poNullInvoiceId: null })
  assert.equal(await backReferenceIsMissing(allLinked.deps, { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'XBILL-1' }), false)
})
