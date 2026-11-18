import assert from 'node:assert/strict'
import test from 'node:test'

import { partialRemovalCreditReason, planRemovalCreditNoteLines } from '@/lib/domain/accounting/partial-payment-removal-credit-note'

/**
 * o3d-hqvrp.395 (owner decision): a partial payment removal is a credit note for the removed amount, VAT apportioned pro rata, deferred revenue unwound the same way.
 * The pure planner is exercised here; the posting itself runs through the ordinary refund path behind the outbound hold, and the whole feature is behind the
 * setting `xero_partial_payment_removal_credit_note_enabled` (off by default). Nothing here reaches a network, a database or Xero.
 */
const net = (lines: Array<{ totalBase: number }>) => lines.reduce((s, l) => s + l.totalBase, 0)

test('the removed amount is spread pro rata: the credit is the same fraction of every part, so each keeps its own VAT share', () => {
  // order: goods 80 + 20 net, shipping 10 net, 20% VAT: net 110, gross 132. 33 of the 132 was removed: a quarter.
  const plan = planRemovalCreditNoteLines({
    lines: [{ lineId: 'a', productId: 'p1', description: 'A', totalBase: 80 }, { lineId: 'b', productId: 'p2', description: 'B', totalBase: 20 }],
    shippingBase: 10, orderNetTotalBase: 110, totalForeign: 132, removedForeign: 33,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.ratio.toNumber(), 0.25)
  assert.deepEqual(plan.lines.map((l) => [l.lineId ?? null, l.lineKind, l.qty, l.totalBase]), [['a', 'sale', 0, 20], ['b', 'sale', 0, 5], [null, 'shipping', 0, 2.5]])
  assert.equal(net(plan.lines), 27.5, 'net credit = a quarter of the order net')
  assert.equal(net(plan.lines) * 1.2, 33, 'with the 20% VAT each part carries, the credit is exactly the removed amount')
})

test('an order discount is already inside the net total, so the credit is still the removed fraction of the order', () => {
  // goods 100 + shipping 0, discount 20 (net total 80), VAT 16: gross 96; 48 removed = half.
  const plan = planRemovalCreditNoteLines({ lines: [{ lineId: 'a', productId: 'p', description: 'A', totalBase: 100 }], shippingBase: 0, orderNetTotalBase: 80, totalForeign: 96, removedForeign: 48 })
  assert.equal(plan.ok && net(plan.lines), 40)
})

test('rounding residue lands on the largest part so the credit net is exact', () => {
  const plan = planRemovalCreditNoteLines({
    lines: [{ lineId: 'a', productId: 'p', description: 'A', totalBase: 33.3333 }, { lineId: 'b', productId: 'q', description: 'B', totalBase: 33.3333 }, { lineId: 'c', productId: 'r', description: 'C', totalBase: 33.3334 }],
    shippingBase: 0, orderNetTotalBase: 100, totalForeign: 120, removedForeign: 40,
  })
  assert.equal(plan.ok, true)
  if (plan.ok) assert.equal(Math.round(net(plan.lines) * 10000) / 10000, 33.3333)
})

test('refuses what cannot be apportioned', () => {
  const base = { lines: [{ lineId: 'a', productId: 'p', description: 'A', totalBase: 10 }], shippingBase: 0, orderNetTotalBase: 10, totalForeign: 12 }
  assert.equal(planRemovalCreditNoteLines({ ...base, removedForeign: 0 }).ok, false)
  assert.equal(planRemovalCreditNoteLines({ ...base, removedForeign: 13 }).ok, false, 'more than the order total')
  assert.equal(planRemovalCreditNoteLines({ ...base, totalForeign: 0, removedForeign: 1 }).ok, false)
  assert.equal(planRemovalCreditNoteLines({ ...base, lines: [], removedForeign: 6 }).ok, false)
})

test('a removal equal to the whole order credits every part in full', () => {
  const plan = planRemovalCreditNoteLines({ lines: [{ lineId: 'a', productId: 'p', description: 'A', totalBase: 10 }], shippingBase: 5, orderNetTotalBase: 15, totalForeign: 18, removedForeign: 18 })
  assert.equal(plan.ok && net(plan.lines), 15)
})

test('the credit note reason names the removal, so a retry finds the credit note it already raised', () => {
  assert.match(partialRemovalCreditReason('rec_1'), /rec_1/)
})
