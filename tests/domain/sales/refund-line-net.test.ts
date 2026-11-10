import assert from 'node:assert/strict'
import test from 'node:test'

import { refundableBase, refundableNet } from '@/lib/domain/sales/refund-line-net'

const line = { qty: 100, net: 0.5 }

// [mutation: pro-rate the ORIGINAL net per refund, or let the last unit take its share instead of the remainder]
test('100 refunds of one unit on a 0.50 line sum to exactly 0.50, never more', () => {
  let taken = 0
  let takenQty = 0
  for (let i = 0; i < 100; i += 1) {
    const net = refundableNet({ line, prior: { qty: takenQty, net: taken }, qty: 1, minorUnits: 2 })
    assert.ok(net <= Math.max(0, Math.round((0.5 - taken) * 10000) / 10000) + 1e-9, `refund ${i + 1} stays within what is left`)
    taken = Math.round((taken + net) * 10000) / 10000
    takenQty += 1
  }
  assert.equal(taken, 0.5)
  assert.equal(refundableNet({ line, prior: { qty: 100, net: 0.5 }, qty: 1, minorUnits: 2 }), 0, 'a fully refunded line has nothing left')
})

// [mutation: remove the min() cap, or the remainder branch]
test('taking all the remaining units takes exactly the remainder, whatever the units rounded to before', () => {
  assert.equal(refundableNet({ line: { qty: 3, net: 10 }, prior: { qty: 2, net: 6.67 }, qty: 1, minorUnits: 2 }), 3.33)
  assert.equal(refundableNet({ line: { qty: 3, net: 10 }, prior: { qty: 0, net: 0 }, qty: 5, minorUnits: 2 }), 10, 'more units than left is capped at the line')
  assert.equal(refundableNet({ line: { qty: 3, net: 10 }, prior: { qty: 0, net: 0 }, qty: 1, minorUnits: 2 }), 3.33)
  assert.equal(refundableNet({ line: { qty: 3, net: 1000 }, prior: { qty: 0, net: 0 }, qty: 1, minorUnits: 0 }), 333, 'a zero-decimal currency rounds to the unit')
  assert.equal(refundableNet({ line: { qty: 3, net: 10 }, prior: { qty: 0, net: 0 }, qty: 0, minorUnits: 2 }), 0)
})

// [mutation: the base column cut on the foreign remainder, or no remainder branch]
test('the base column is cut the same way: remainder on the last unit, the rate otherwise', () => {
  assert.equal(refundableBase({ line: { qty: 3, net: 10 }, prior: { qty: 2, net: 6.66 }, qty: 1, foreignNet: 3.33, fxRateToBase: 1, minorUnits: 2 }), 3.34)
  assert.equal(refundableBase({ line: { qty: 4, net: 20 }, prior: { qty: 0, net: 0 }, qty: 1, foreignNet: 6.25, fxRateToBase: 1.25, minorUnits: 2 }), 5)
  assert.equal(refundableBase({ line: { qty: 4, net: 4 }, prior: { qty: 0, net: 0 }, qty: 1, foreignNet: 6.25, fxRateToBase: 1.25, minorUnits: 2 }), 4, 'capped at what the line has left, however the rate converts')
})

// [mutation: cap removed (rounding up beyond what is left); share from the original net; no nothing-left guard; last unit takes a rounded share]
test('a refund never exceeds what is left, is cut from what is left, and a fully refunded line credits nothing', () => {
  assert.equal(refundableNet({ line: { qty: 100, net: 0.0054 }, prior: { qty: 0, net: 0 }, qty: 99, minorUnits: 2 }), 0.0054, 'rounding up is capped at the remainder')
  assert.equal(refundableNet({ line: { qty: 4, net: 10 }, prior: { qty: 1, net: 3 }, qty: 1, minorUnits: 2 }), 2.33, 'cut from the 7 left over 3 units, not 10 over 4')
  assert.equal(refundableNet({ line: { qty: 2, net: 10 }, prior: { qty: 2, net: 5 }, qty: 1, minorUnits: 2 }), 0, 'no units left')
  assert.equal(refundableNet({ line: { qty: 2, net: 0.1234 }, prior: { qty: 0, net: 0 }, qty: 2, minorUnits: 2 }), 0.1234, 'the last units take the exact (4 dp) remainder')
})
