import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'

function uniqueError(target: unknown) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}

test('isExternalRefundIdUniqueConflict accepts WooCommerce refund idempotency conflicts', () => {
  assert.equal(isExternalRefundIdUniqueConflict(uniqueError(['externalRefundId'])), true)
  assert.equal(isExternalRefundIdUniqueConflict(uniqueError('sales_order_refunds_externalRefundId_key')), true)
})

test('isExternalRefundIdUniqueConflict rejects unrelated unique conflicts', () => {
  assert.equal(isExternalRefundIdUniqueConflict(uniqueError(['creditNoteNumber'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(uniqueError(['externalRefundIdHash'])), false)
  assert.equal(isExternalRefundIdUniqueConflict(uniqueError('tenantExternalRefundIdKey')), false)
  assert.equal(isExternalRefundIdUniqueConflict(new Error('Unique constraint failed')), false)
})
