import assert from 'node:assert/strict'
import test from 'node:test'

import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { adapterUniqueViolation, legacyUniqueViolation } from '@/tests/helpers/prisma-unique-error'

// o3d-5od: these assertions used to run ONLY against a hand-built `meta.target`, which is not
// the shape @prisma/adapter-pg produces. They passed while the guard was dead in production.
// The adapter shape is now the primary case; the query-engine shape is kept as a fallback case.

test('isExternalRefundIdUniqueConflict accepts the real adapter-pg refund conflict', () => {
  assert.equal(
    isExternalRefundIdUniqueConflict(adapterUniqueViolation(['externalRefundId'], {
      modelName: 'SalesOrderRefund',
      constraintName: 'sales_order_refunds_externalRefundId_key',
    })),
    true,
  )
})

test('isExternalRefundIdUniqueConflict still accepts the query-engine meta.target shape', () => {
  assert.equal(isExternalRefundIdUniqueConflict(legacyUniqueViolation(['externalRefundId'])), true)
  assert.equal(isExternalRefundIdUniqueConflict(legacyUniqueViolation('sales_order_refunds_externalRefundId_key')), true)
})

test('isExternalRefundIdUniqueConflict rejects unrelated unique conflicts', () => {
  assert.equal(isExternalRefundIdUniqueConflict(adapterUniqueViolation(['creditNoteNumber'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(adapterUniqueViolation(['externalRefundIdHash'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(legacyUniqueViolation(['creditNoteNumber'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(legacyUniqueViolation(['externalRefundIdHash'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(legacyUniqueViolation('tenantExternalRefundIdKey')), false)
  assert.equal(isExternalRefundIdUniqueConflict(new Error('Unique constraint failed')), false)
})
