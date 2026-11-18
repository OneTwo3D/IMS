import assert from 'node:assert/strict'
import test from 'node:test'
import { DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, groupBShipmentWhere } from '@/lib/domain/accounting/daily-batch-group-b-lock'

/**
 * Owner ruling 2026-11-18: a mixed-warehouse WMS despatch ships only its own warehouse's shipment. Stock, COGS and the daily batch follow the SHIPMENT, so
 * Group B must select by the shipment's own status - never by the order's - and so journals the shipped part while the other warehouse's open shipment is
 * not picked up.
 */
test('Group B selects shipments by their own SHIPPED status and places no condition on the order status (both passes)', () => {
  for (const mode of ['direct', 'paid'] as const) {
    const where = groupBShipmentWhere(mode) as { status?: string; order?: Record<string, unknown> }
    assert.equal(where.status, 'SHIPPED', `${mode}: only a shipped shipment is journalled; an open shipment in another warehouse is not`)
    assert.equal(where.order && 'status' in where.order, false, `${mode}: a partly shipped order (not SHIPPED) is still journalled for its shipped part`)
  }
  assert.ok(DAILY_BATCH_GROUP_B_SHIPMENT_WHERE.OR.length === 2)
})
