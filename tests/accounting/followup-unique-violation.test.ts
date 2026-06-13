import assert from 'node:assert/strict'
import test from 'node:test'

import { isUniqueConstraintViolation } from '@/lib/connectors/xero/sync-processor'

// audit-42co: a concurrent follow-up enqueue that loses the race against the
// partial unique index surfaces as a Prisma P2002 and must be swallowed as an
// idempotent no-op; anything else must propagate.

test('recognises a Prisma P2002 unique-violation', () => {
  assert.equal(isUniqueConstraintViolation({ code: 'P2002', meta: { target: ['connector'] } }), true)
})

test('does NOT swallow other Prisma error codes', () => {
  assert.equal(isUniqueConstraintViolation({ code: 'P2025' }), false)
  assert.equal(isUniqueConstraintViolation({ code: 'P2003' }), false)
})

test('does NOT swallow plain errors or non-objects', () => {
  assert.equal(isUniqueConstraintViolation(new Error('boom')), false)
  assert.equal(isUniqueConstraintViolation('P2002'), false)
  assert.equal(isUniqueConstraintViolation(null), false)
  assert.equal(isUniqueConstraintViolation(undefined), false)
})
