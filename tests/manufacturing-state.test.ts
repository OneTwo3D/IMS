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

test('completion state evaluator accepts in-progress orders', () => {
  assert.deepEqual(evaluateProductionOrderCompletion('IN_PROGRESS'), { allowed: true, action: 'complete' })
})

test('completion state evaluator blocks completing a never-started DRAFT order (scjz.32)', () => {
  // A DRAFT order has no frozen component snapshot or stock reservation, so
  // completing it directly would consume the live BOM at completion time
  // (non-deterministic, not retry-safe). Require Start first.
  assert.deepEqual(evaluateProductionOrderCompletion('DRAFT'), {
    allowed: false,
    error: 'Cannot complete a production order that has not been started — start production first to reserve stock and freeze the bill of materials.',
  })
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
})

test('cancellation transition refuses completed orders (no silent cost-line strip)', () => {
  assert.deepEqual(evaluateProductionOrderCancellation('COMPLETED'), {
    allowed: false,
    error: 'Cannot cancel a COMPLETED production order — it has posted stock movements and cost layers. Reverse it instead.',
  })
})

test('cancellation transition reports already-cancelled orders', () => {
  assert.deepEqual(evaluateProductionOrderCancellation('CANCELLED'), {
    allowed: false,
    error: 'Production order is already cancelled',
  })
})
