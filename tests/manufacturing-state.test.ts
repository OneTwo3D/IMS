import assert from 'node:assert/strict'
import test from 'node:test'
import { ProductionOrderStatus } from '@/app/generated/prisma/enums'
import {
  evaluateProductionOrderCancellation,
  evaluateProductionOrderCompletion,
  evaluateProductionOrderStart,
} from '../lib/domain/manufacturing/manufacturing-state.ts'

const EXPECTED_PRODUCTION_ORDER_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]

test('production order status tests cover every Prisma enum value', () => {
  assert.deepEqual(Object.values(ProductionOrderStatus).sort(), EXPECTED_PRODUCTION_ORDER_STATUSES.sort())
})

test('completion state evaluator accepts draft and in-progress orders', () => {
  assert.deepEqual(evaluateProductionOrderCompletion('DRAFT'), { allowed: true, action: 'complete' })
  assert.deepEqual(evaluateProductionOrderCompletion('IN_PROGRESS'), { allowed: true, action: 'complete' })
})

test('completion state evaluator treats completed orders as idempotent', () => {
  assert.deepEqual(evaluateProductionOrderCompletion('COMPLETED'), { allowed: true, action: 'already-completed' })
})

test('completion state evaluator returns a reason for cancelled orders', () => {
  assert.deepEqual(evaluateProductionOrderCompletion('CANCELLED'), {
    allowed: false,
    error: 'Cannot complete a production order in CANCELLED status',
  })
})

test('start transition is allowed only from draft', () => {
  assert.deepEqual(evaluateProductionOrderStart('DRAFT'), { allowed: true, action: 'start' })
  assert.deepEqual(evaluateProductionOrderStart('IN_PROGRESS'), {
    allowed: false,
    error: 'Cannot start a production order in IN_PROGRESS status',
  })
})

test('cancellation transition reports whether reservations should be released', () => {
  assert.deepEqual(evaluateProductionOrderCancellation('IN_PROGRESS'), {
    allowed: true,
    action: 'release-reservations',
  })
  assert.deepEqual(evaluateProductionOrderCancellation('DRAFT'), {
    allowed: true,
    action: 'cancel-without-reservations',
  })
  assert.deepEqual(evaluateProductionOrderCancellation('COMPLETED'), {
    allowed: true,
    action: 'cancel-without-reservations',
  })
})
