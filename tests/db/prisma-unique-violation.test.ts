import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isUniqueConstraintViolation,
  uniqueConstraintFields,
  uniqueViolationTargetsField,
} from '@/lib/db/prisma-unique-violation'
import { adapterUniqueViolation, legacyUniqueViolation } from '@/tests/helpers/prisma-unique-error'

// o3d-5od. The first block is the regression that matters: this is a byte-for-byte copy of a
// P2002 captured from onetwo3d_ims_dev through @prisma/adapter-pg. Reading `meta.target` off it
// yields undefined, which is exactly why five idempotency guards were dead in production.
const LIVE_ADAPTER_P2002 = {
  code: 'P2002',
  message: '\nInvalid `prisma.integrationOutbox.create()` invocation\n\nUnique constraint failed',
  meta: {
    modelName: 'IntegrationOutbox',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        originalMessage:
          'duplicate key value violates unique constraint "integration_outbox_idempotencyKey_key"',
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['"idempotencyKey"'] },
      },
    },
  },
}

test('reads the column list off a real @prisma/adapter-pg P2002 (which has no meta.target)', () => {
  assert.equal((LIVE_ADAPTER_P2002.meta as { target?: unknown }).target, undefined)
  assert.deepEqual(uniqueConstraintFields(LIVE_ADAPTER_P2002), ['idempotencyKey'])
  assert.equal(uniqueViolationTargetsField(LIVE_ADAPTER_P2002, 'idempotencyKey'), true)
})

test('strips the quoting the adapter applies to camelCase columns', () => {
  assert.deepEqual(uniqueConstraintFields(adapterUniqueViolation(['externalRefundId'])), ['externalRefundId'])
  // All-lowercase identifiers arrive bare and must survive unchanged.
  assert.deepEqual(uniqueConstraintFields(adapterUniqueViolation(['barcode'])), ['barcode'])
})

test('reports every column of a composite unique violation', () => {
  const error = adapterUniqueViolation(['externalSystem', 'externalId'], { modelName: 'AccountingEvent' })
  assert.deepEqual(uniqueConstraintFields(error), ['externalSystem', 'externalId'])
})

test('still reads the classic query-engine meta.target shape', () => {
  assert.deepEqual(uniqueConstraintFields(legacyUniqueViolation(['idempotencyKey'])), ['idempotencyKey'])
  assert.deepEqual(uniqueConstraintFields(legacyUniqueViolation('idempotencyKey')), ['idempotencyKey'])
  assert.equal(uniqueViolationTargetsField(legacyUniqueViolation(['idempotencyKey']), 'idempotencyKey'), true)
})

test('falls back to the constraint name in the raw message when nothing is structured', () => {
  const error = {
    code: 'P2002',
    message: 'duplicate key value violates unique constraint "stock_movements_idempotencyKey_key"',
  }
  assert.deepEqual(uniqueConstraintFields(error), ['stock_movements_idempotencyKey_key'])
  assert.equal(uniqueViolationTargetsField(error, 'idempotencyKey'), true)
})

test('matches Postgres default constraint names but not merely similar columns', () => {
  assert.equal(uniqueViolationTargetsField(legacyUniqueViolation('sales_order_refunds_externalRefundId_key'), 'externalRefundId'), true)
  // Substring matching would wrongly accept all three of these.
  assert.equal(uniqueViolationTargetsField(adapterUniqueViolation(['externalRefundIdHash']), 'externalRefundId'), false)
  assert.equal(uniqueViolationTargetsField(legacyUniqueViolation('tenantExternalRefundIdKey'), 'externalRefundId'), false)
  assert.equal(uniqueViolationTargetsField(adapterUniqueViolation(['idempotencyKeyDigest']), 'idempotencyKey'), false)
})

test('returns null rather than a field list for anything that is not a P2002', () => {
  assert.equal(uniqueConstraintFields(new Error('Unique constraint failed')), null)
  assert.equal(uniqueConstraintFields({ code: 'P2003', meta: { target: ['idempotencyKey'] } }), null)
  assert.equal(uniqueConstraintFields(null), null)
  assert.equal(uniqueConstraintFields('P2002'), null)
  assert.equal(uniqueViolationTargetsField(undefined, 'idempotencyKey'), false)
})

test('returns null when a P2002 identifies no constraint at all', () => {
  assert.equal(isUniqueConstraintViolation({ code: 'P2002' }), true)
  assert.equal(uniqueConstraintFields({ code: 'P2002' }), null)
  assert.equal(uniqueConstraintFields({ code: 'P2002', meta: { modelName: 'IntegrationOutbox' } }), null)
})

test('accepts a list of candidate field names', () => {
  const error = adapterUniqueViolation(['reference'], { modelName: 'StockTransfer' })
  assert.equal(uniqueViolationTargetsField(error, ['idempotencyKey', 'reference']), true)
  assert.equal(uniqueViolationTargetsField(error, ['idempotencyKey', 'barcode']), false)
})
