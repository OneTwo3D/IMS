import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePurchaseOrderCancellationInvoiceGate } from '@/lib/domain/purchasing/po-cancellation'

// audit-g5u2.4: an invoiced freight PO can be cancelled only when EVERY bill is
// fully offset (base currency) by POSTED credit notes attributed to that bill.

test('uninvoiced PO is always cancellable', () => {
  assert.deepEqual(
    evaluatePurchaseOrderCancellationInvoiceGate({ isFreight: false, invoices: [] }),
    { allowed: true, reason: null },
  )
})

test('freight PO with every bill fully offset is cancellable', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({
    isFreight: true,
    invoices: [{ totalBase: 120, creditedBase: 120 }, { totalBase: 30, creditedBase: 30 }],
  })
  assert.equal(r.allowed, true)
})

test('freight PO offset within the half-cent tolerance is cancellable', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ isFreight: true, invoices: [{ totalBase: 120, creditedBase: 119.998 }] })
  assert.equal(r.allowed, true)
})

test('freight PO with ANY under-offset bill is blocked (a credit for one bill cannot satisfy another)', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({
    isFreight: true,
    // First bill over-credited, second uncredited — must still block on the second.
    invoices: [{ totalBase: 100, creditedBase: 150 }, { totalBase: 40, creditedBase: 0 }],
  })
  assert.equal(r.allowed, false)
  assert.match(r.reason ?? '', /not fully offset by posted credit notes/)
})

test('freight PO with a partial offset is blocked with the shortfall', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ isFreight: true, invoices: [{ totalBase: 120, creditedBase: 50 }] })
  assert.equal(r.allowed, false)
  assert.match(r.reason ?? '', /shortfall 70\.00/)
})

test('non-freight invoiced PO is blocked even when fully credited', () => {
  const r = evaluatePurchaseOrderCancellationInvoiceGate({ isFreight: false, invoices: [{ totalBase: 120, creditedBase: 120 }] })
  assert.equal(r.allowed, false)
  assert.match(r.reason ?? '', /after supplier invoices have been recorded/)
})
