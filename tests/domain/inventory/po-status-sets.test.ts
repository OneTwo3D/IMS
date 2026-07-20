import assert from 'node:assert/strict'
import test from 'node:test'

import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'

// o3d-s8n.8: the product-page Incoming aggregate and its drill-down popup used DIFFERENT PO-status sets,
// so they disagreed (a DRAFT PO inflated the aggregate but not the drill-down) and SHIPPED POs were
// dropped from Incoming entirely. This pins the single canonical set both now consume.
test('INCOMING_PO_STATUSES is exactly the committed-supply set', () => {
  assert.deepEqual([...INCOMING_PO_STATUSES].sort(), ['PARTIALLY_RECEIVED', 'PO_SENT', 'SHIPPED'])
})

test('uncommitted and completed statuses are excluded', () => {
  // DRAFT/RFQ_SENT/QUOTE_RECEIVED are not ordered yet; RECEIVED/CLOSED/RETURNED are done.
  for (const excluded of ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'RECEIVED', 'CLOSED', 'RETURNED']) {
    assert.ok(!INCOMING_PO_STATUSES.includes(excluded as never), `${excluded} must not count as incoming`)
  }
})

test('SHIPPED (genuinely in-transit) IS counted', () => {
  assert.ok(INCOMING_PO_STATUSES.includes('SHIPPED' as never), 'in-transit POs must count as incoming')
})
