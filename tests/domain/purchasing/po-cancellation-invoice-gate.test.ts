import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePurchaseOrderCancellationInvoiceGate } from '@/lib/domain/purchasing/po-cancellation'

// audit-g5u2.4: an invoiced freight PO can be cancelled only when POSTED supplier
// credit notes fully offset its bills; everything else stays blocked.

test('uninvoiced PO is always cancellable', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 0, isFreight: false, invoiceTotalForeign: 0, postedCreditTotalForeign: 0 })
  assert.deepEqual(r, { allowed: true, reason: null })
})

test('freight PO fully offset by posted credit notes is cancellable', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 1, isFreight: true, invoiceTotalForeign: 120, postedCreditTotalForeign: 120 })
  assert.equal(r.allowed, true)
})

test('freight PO offset within epsilon is cancellable', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 1, isFreight: true, invoiceTotalForeign: 120, postedCreditTotalForeign: 119.995 })
  assert.equal(r.allowed, true)
})

test('freight PO only PARTIALLY credited is blocked with a guiding reason', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 1, isFreight: true, invoiceTotalForeign: 120, postedCreditTotalForeign: 50 })
  assert.equal(r.allowed, false)
  assert.match(r.reason ?? '', /not fully offset by posted credit notes/)
})

test('freight PO with no credit notes is blocked', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 1, isFreight: true, invoiceTotalForeign: 120, postedCreditTotalForeign: 0 })
  assert.equal(r.allowed, false)
})

test('non-freight invoiced PO is blocked even when fully credited', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ invoiceCount: 1, isFreight: false, invoiceTotalForeign: 120, postedCreditTotalForeign: 120 })
  assert.equal(r.allowed, false)
  assert.match(r.reason ?? '', /after supplier invoices have been recorded/)
})
