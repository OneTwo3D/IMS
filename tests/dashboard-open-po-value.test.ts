import assert from 'node:assert/strict'
import test from 'node:test'

import { outstandingPoValueBase } from '@/app/actions/dashboard'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'

// o3d-1di: the 'Open POs' KPI must value only the OUTSTANDING (not-yet-received) portion of each
// committed PO, and must use the canonical committed-incoming population (SHIPPED in, RFQ_SENT out).

test('outstandingPoValueBase values only the un-received line qty', () => {
  // qty 10, received 0 @ £5 => £50 outstanding
  assert.equal(
    outstandingPoValueBase([{ lines: [{ qty: 10, qtyReceived: 0, unitCostBase: 5 }] }]),
    50,
  )
})

test('a partially-received PO contributes only the remaining qty', () => {
  // qty 10, received 8 @ £5 => remaining 2 => £10
  assert.equal(
    outstandingPoValueBase([{ lines: [{ qty: 10, qtyReceived: 8, unitCostBase: 5 }] }]),
    10,
  )
})

test('a fully- or over-received line contributes nothing (floored at 0)', () => {
  assert.equal(
    outstandingPoValueBase([{ lines: [{ qty: 10, qtyReceived: 10, unitCostBase: 5 }] }]),
    0,
  )
  assert.equal(
    outstandingPoValueBase([{ lines: [{ qty: 10, qtyReceived: 12, unitCostBase: 5 }] }]),
    0,
  )
})

test('sums across multiple lines and POs; Decimal-like string inputs coerce', () => {
  const value = outstandingPoValueBase([
    { lines: [
      { qty: '10', qtyReceived: '3', unitCostBase: '2.5' }, // remaining 7 * 2.5 = 17.5
      { qty: '4', qtyReceived: '4', unitCostBase: '9' },    // 0
    ] },
    { lines: [{ qty: '6', qtyReceived: '0', unitCostBase: '1.5' }] }, // 9
  ])
  assert.equal(value, 26.5)
})

test('empty input is zero', () => {
  assert.equal(outstandingPoValueBase([]), 0)
})

test('committed-incoming population includes SHIPPED and excludes the quote pipeline (o3d-1di)', () => {
  // Regression for the reported contradiction: a SHIPPED PO must count as Open;
  // an RFQ_SENT / QUOTE_RECEIVED PO must not.
  assert.ok(INCOMING_PO_STATUSES.includes('SHIPPED'), 'SHIPPED is committed incoming supply')
  assert.ok(!INCOMING_PO_STATUSES.includes('RFQ_SENT'), 'RFQ_SENT is not committed')
  assert.ok(!INCOMING_PO_STATUSES.includes('QUOTE_RECEIVED'), 'QUOTE_RECEIVED is not committed')
})
