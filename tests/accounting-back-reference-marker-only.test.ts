import assert from 'node:assert/strict'
import test from 'node:test'

import { applyBackReference } from '@/lib/domain/accounting/back-reference'

// o3d-0g2n. applyBackReference serves TWO callers with different needs:
//
//   the LIVE path posts a document right now, so stamping invoicedAt = now and taking the invoice
//   number from the payload is correct;
//   a REPAIR runs an arbitrary time later, so `now` is the repair time rather than the invoice date
//   — writing it can move a sale into a different VAT / currency-reporting period — and the queued
//   payload's number can disagree with what the connector actually assigned.
//
// markerOnly separates them. These tests pin the contract on BOTH sides, and pin the reason the
// option only needs to affect one branch.

type Write = { table: string; data: Record<string, unknown> }

function makeDeps(writes: Write[], opts: { unlinkedInvoiceId?: string } = {}) {
  const record = (table: string) => async ({ data }: { data: Record<string, unknown> }) => {
    writes.push({ table, data })
    return {}
  }
  return {
    salesOrder: { findUnique: async () => null, update: record('salesOrder') },
    salesOrderRefund: { findUnique: async () => null, update: record('salesOrderRefund') },
    purchaseInvoice: {
      findUnique: async () => null,
      findFirst: async () => (opts.unlinkedInvoiceId ? { id: opts.unlinkedInvoiceId } : null),
      update: record('purchaseInvoice'),
    },
    supplierCreditNote: { findUnique: async () => null, update: record('supplierCreditNote') },
  } as never
}

test('the LIVE path still writes invoiceNumber and invoicedAt (o3d-0g2n)', async () => {
  // Default behaviour must be byte-identical — this is the path that actually posts invoices.
  const writes: Write[] = []
  await applyBackReference(makeDeps(writes), {
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalId: 'X-1',
    invoiceNumber: 'INV-9',
  })

  assert.equal(writes.length, 1)
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['accountingInvoiceId', 'invoiceNumber', 'invoicedAt'])
  assert.equal(writes[0].data.invoiceNumber, 'INV-9')
  assert.ok(writes[0].data.invoicedAt instanceof Date)
})

test('markerOnly writes the external id and NOTHING else (o3d-0g2n)', async () => {
  const writes: Write[] = []
  await applyBackReference(
    makeDeps(writes),
    {
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      externalId: 'X-1',
      invoiceNumber: 'INV-FROM-STALE-PAYLOAD',
    },
    { markerOnly: true },
  )

  assert.equal(writes.length, 1)
  assert.deepEqual(
    Object.keys(writes[0].data),
    ['accountingInvoiceId'],
    'a repair restores only what was provably lost',
  )
  assert.equal(writes[0].data.accountingInvoiceId, 'X-1')
})

test('every OTHER document type is already marker-only, in both modes (o3d-0g2n)', async () => {
  // markerOnly needs to affect only the SalesOrder branch — because that is the only branch that
  // writes anything beyond its marker today. This pins that premise: if someone later adds a
  // timestamp or a number to one of these, the repair path would start writing it silently, and
  // this test is what should stop them.
  const cases = [
    { type: 'CREDIT_NOTE' as const, referenceType: 'SalesOrderRefund', table: 'salesOrderRefund', key: 'accountingCreditNoteId' },
    { type: 'PURCHASE_INVOICE' as const, referenceType: 'PurchaseInvoice', table: 'purchaseInvoice', key: 'accountingInvoiceId' },
    { type: 'PURCHASE_CREDIT_NOTE' as const, referenceType: 'SupplierCreditNote', table: 'supplierCreditNote', key: 'accountingCreditNoteId' },
  ]

  for (const c of cases) {
    for (const markerOnly of [false, true]) {
      const writes: Write[] = []
      await applyBackReference(
        makeDeps(writes),
        { type: c.type, referenceType: c.referenceType, referenceId: 'ref-1', externalId: 'X-1', invoiceNumber: 'INV-9' },
        { markerOnly },
      )
      assert.equal(writes.length, 1, `${c.type} wrote once`)
      assert.equal(writes[0].table, c.table)
      assert.deepEqual(
        Object.keys(writes[0].data),
        [c.key],
        `${c.type} writes only its marker (markerOnly=${markerOnly}) — if this fails, markerOnly must cover it too`,
      )
    }
  }
})

test('the PO-referenced branch resolves a bill and writes only its marker (o3d-0g2n)', async () => {
  const writes: Write[] = []
  await applyBackReference(
    makeDeps(writes, { unlinkedInvoiceId: 'bill-7' }),
    { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: 'po-1', externalId: 'X-2' },
    { markerOnly: true },
  )

  assert.equal(writes.length, 1)
  assert.deepEqual(Object.keys(writes[0].data), ['accountingInvoiceId'])
})

test('nothing is written without an external id (o3d-0g2n)', async () => {
  const writes: Write[] = []
  await applyBackReference(
    makeDeps(writes),
    // Cast: the type requires a string, but the runtime guard exists precisely because a row can
    // reach here without one — and blanking a marker would be worse than skipping the repair.
    { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1', externalId: undefined as unknown as string },
    { markerOnly: true },
  )
  assert.deepEqual(writes, [], 'no id, no write — a repair must never blank an existing marker')
})
