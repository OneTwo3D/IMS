import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSupplierOwnsResource,
  SupplierPortalAccessError,
} from '../../lib/security/supplier-portal-boundary.ts'

test('supplier portal boundary accepts resources owned by the session supplier', () => {
  assert.doesNotThrow(() => {
    assertSupplierOwnsResource(
      { userId: 'user-1', supplierId: 'supplier-1' },
      { supplierId: 'supplier-1' },
    )
  })
})

test('supplier portal boundary rejects cross-supplier and missing ownership', () => {
  assert.throws(
    () => assertSupplierOwnsResource(
      { userId: 'user-1', supplierId: 'supplier-1' },
      { supplierId: 'supplier-2' },
    ),
    SupplierPortalAccessError,
  )
  assert.throws(
    () => assertSupplierOwnsResource(
      { userId: 'user-1', supplierId: 'supplier-1' },
      { supplierId: null },
    ),
    SupplierPortalAccessError,
  )
})
