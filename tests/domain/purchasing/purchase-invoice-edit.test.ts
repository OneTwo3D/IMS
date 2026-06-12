import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPurchaseInvoiceEditable,
  buildPurchaseInvoiceUpdateIdempotencyKey,
  hasPurchaseInvoiceEditChanges,
  type PurchaseInvoiceEditHeader,
  type PurchaseInvoiceEditLine,
} from '@/lib/domain/purchasing/purchase-invoice-edit'

const header: PurchaseInvoiceEditHeader = {
  invoiceNumber: 'SUP-1',
  invoiceDate: '2026-06-12',
  dueDate: '2026-07-12',
  notes: 'Original',
  supplierInvoiceUrl: '/uploads/invoice/supplier.pdf',
}

const lines: PurchaseInvoiceEditLine[] = [
  {
    id: 'line-1',
    description: null,
    qtyBilled: 2,
    unitCostForeign: 10,
    totalForeign: 20,
  },
  {
    id: 'line-2',
    description: 'Freight',
    qtyBilled: 1,
    unitCostForeign: 5,
    totalForeign: 5,
  },
]

test('assertPurchaseInvoiceEditable rejects paid bills', () => {
  assert.doesNotThrow(() => assertPurchaseInvoiceEditable({ paidAt: null }))
  assert.throws(
    () => assertPurchaseInvoiceEditable({ paidAt: '2026-06-12T10:00:00.000Z' }),
    /Paid bills cannot be edited/,
  )
})

test('hasPurchaseInvoiceEditChanges ignores line ordering but detects editable field changes', () => {
  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: { ...header },
    existingLines: lines,
    nextLines: [...lines].reverse(),
  }), false)

  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: { ...header, invoiceNumber: 'SUP-2' },
    existingLines: lines,
    nextLines: lines,
  }), true)

  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: header,
    existingLines: lines,
    nextLines: lines.map((line) => line.id === 'line-1' ? { ...line, qtyBilled: 3, totalForeign: 30 } : line),
  }), true)
})

test('buildPurchaseInvoiceUpdateIdempotencyKey is stable and payload-derived', () => {
  const basePayload = {
    accountingInvoiceId: 'xero-bill-1',
    invoiceNumber: 'PO-1',
    date: '2026-06-12',
    lines: [{ description: 'Line', quantity: 2, unitAmount: 10 }],
  }
  const first = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: basePayload,
  })
  const repeat = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: basePayload,
  })
  const changed = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: { ...basePayload, date: '2026-06-13' },
  })

  assert.equal(first, repeat)
  assert.notEqual(first, changed)
})
