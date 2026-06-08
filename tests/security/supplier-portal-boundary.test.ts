import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSupplierResourceBoundary } from '@/app/actions/supplier-portal'

test('supplier portal boundary assertion accepts resources owned by the session supplier', () => {
  assert.doesNotThrow(() => {
    assertSupplierResourceBoundary(
      { supplierId: 'supplier-1' },
      { supplierId: 'supplier-1' },
      'purchase order',
    )
  })
})

test('supplier portal boundary assertion rejects resources owned by another supplier', () => {
  assert.throws(
    () => assertSupplierResourceBoundary(
      { supplierId: 'supplier-1' },
      { supplierId: 'supplier-2' },
      'purchase order',
    ),
    /Supplier purchase order is not accessible/,
  )
})
