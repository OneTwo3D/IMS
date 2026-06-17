import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { landedCostAdjustmentEventKey } from '@/lib/domain/purchasing/landed-cost-service'

// audit-g4la: the event key (which feeds the journal idempotency key) must be
// unique PER RECALC RUN, so an A→B→A→B sequence — where the second A→B has
// identical layer content to the first — produces a DISTINCT key and its real
// correction journal is not deduped against the first. The same run id must
// still produce the SAME key, so the grob direct-call + drain dedupe each other.

const layers = [
  {
    costLayerId: 'cl-1',
    oldUnitCost: new Prisma.Decimal('10'),
    newUnitCost: new Prisma.Decimal('12'),
    receivedQty: new Prisma.Decimal('5'),
    remainingQty: new Prisma.Decimal('2'),
    returnedQty: new Prisma.Decimal('0'),
    supplierReturnedQty: new Prisma.Decimal('0'),
    manufacturingConsumedQty: new Prisma.Decimal('0'),
  },
]

test('identical layer content with DIFFERENT recalc-run ids yields different keys', () => {
  const k1 = landedCostAdjustmentEventKey('po-1', layers, 'run-A')
  const k2 = landedCostAdjustmentEventKey('po-1', layers, 'run-B')
  assert.notEqual(k1, k2)
})

test('the SAME recalc-run id yields a stable key (direct call + grob drain dedupe)', () => {
  const k1 = landedCostAdjustmentEventKey('po-1', layers, 'run-A')
  const k2 = landedCostAdjustmentEventKey('po-1', layers, 'run-A')
  assert.equal(k1, k2)
})

test('different POs still differ within one run', () => {
  assert.notEqual(
    landedCostAdjustmentEventKey('po-1', layers, 'run-A'),
    landedCostAdjustmentEventKey('po-2', layers, 'run-A'),
  )
})
