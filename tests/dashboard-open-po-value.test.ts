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

test('an order-level header discount is netted pro-rata to the outstanding portion (o3d-1di)', () => {
  // qty 10 received 0 @ £10 => £100 outstanding goods; £50 header discount (fx 1) fully outstanding
  // => 100 - 50*(100/100) = £50
  assert.equal(
    outstandingPoValueBase([
      { discountAmount: 50, fxRateToBase: 1, lines: [{ qty: 10, qtyReceived: 0, unitCostBase: 10 }] },
    ]),
    50,
  )
})

test('header discount allocates only the outstanding fraction on a partially-received PO', () => {
  // qty 10 received 5 @ £10 => gross 100, outstanding 50; £50 discount => 50 - 50*(50/100) = £25
  assert.equal(
    outstandingPoValueBase([
      { discountAmount: 50, fxRateToBase: 1, lines: [{ qty: 10, qtyReceived: 5, unitCostBase: 10 }] },
    ]),
    25,
  )
})

test('header discount is converted from foreign to base via fxRateToBase', () => {
  // discount 10 foreign * fx 2 = £20 base; qty 10 @ £5 gross 50 all outstanding => 50 - 20 = £30
  assert.equal(
    outstandingPoValueBase([
      { discountAmount: 10, fxRateToBase: 2, lines: [{ qty: 10, qtyReceived: 0, unitCostBase: 5 }] },
    ]),
    30,
  )
})

test('an oversized header discount never drives a PO negative (floored at 0)', () => {
  assert.equal(
    outstandingPoValueBase([
      { discountAmount: 999, fxRateToBase: 1, lines: [{ qty: 10, qtyReceived: 0, unitCostBase: 10 }] },
    ]),
    0,
  )
})

test('committed-incoming population includes SHIPPED and excludes the quote pipeline (o3d-1di)', () => {
  // Regression for the reported contradiction: a SHIPPED PO must count as Open;
  // an RFQ_SENT / QUOTE_RECEIVED PO must not.
  assert.ok(INCOMING_PO_STATUSES.includes('SHIPPED'), 'SHIPPED is committed incoming supply')
  assert.ok(!INCOMING_PO_STATUSES.includes('RFQ_SENT'), 'RFQ_SENT is not committed')
  assert.ok(!INCOMING_PO_STATUSES.includes('QUOTE_RECEIVED'), 'QUOTE_RECEIVED is not committed')
})
