import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { findOverAllocatedRefundTarget, refundSafeguards } from '@/lib/domain/sales/refund-target-balances'

// [mutation: public callers uncapped again, internal callers force-capped, or the re-cut applied to internal callers]
test('a public refund is always capped and re-cut; an internal one keeps the cap opt-in and is never re-cut', () => {
  assert.deepEqual(refundSafeguards({ isInternal: false }), { enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true })
  assert.deepEqual(refundSafeguards({ isInternal: false, requestedPerTargetCap: false }), { enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true })
  assert.deepEqual(refundSafeguards({ isInternal: true }), { enforcePerTargetBalances: false, deriveSaleLineNetsFromStoredBalance: false })
  assert.deepEqual(refundSafeguards({ isInternal: true, requestedPerTargetCap: true }), { enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: false })
})

// [mutation: the cap compares against the charged figure instead of what is left, or never trips]
test('a line cannot be refunded above its stored net, net of earlier refunds', () => {
  const order = { lines: [{ id: 'l1', description: 'Tiny', totalForeign: 0.5 }] }
  assert.equal(findOverAllocatedRefundTarget({ order, priorRefundLines: [], allocations: [{ lineId: 'l1', netForeign: 0.5 }] }), null)
  assert.ok(findOverAllocatedRefundTarget({ order, priorRefundLines: [], allocations: [{ lineId: 'l1', netForeign: 0.51 }] }))
  assert.ok(findOverAllocatedRefundTarget({ order, priorRefundLines: [{ salesOrderLineId: 'l1', totalForeign: 0.4 }], allocations: [{ lineId: 'l1', netForeign: 0.2 }] }))
})

// [mutation: the action stops calling the shared policy, or the order page stops reading the posted column]
test('the action and the order read use the shared definitions', () => {
  const actions = readFileSync('app/actions/sales.ts', 'utf8')
  assert.match(actions, /refundSafeguards\(\{ isInternal, requestedPerTargetCap: options\?\.enforcePerTargetBalances \}\)/)
  assert.match(actions, /^\s+enforcePerTargetBalances,$/m)
  assert.match(actions, /^\s+deriveSaleLineNetsFromStoredBalance,$/m)
  assert.match(actions, /creditNoteLineFacts\(\{/)
  assert.match(actions, /postedNet: creditFactsByRefund\.get\(r\.id\)!\[index\]\.postedNet/)
  assert.match(actions, /vatRate: creditFactsByRefund\.get\(r\.id\)!\[index\]\.vatRate/)
})

test('[fee VAT cap] a fee line\'s cumulative refunded VAT is held to the VAT it bore; prior lines with no stated VAT count at the line\'s own rate; goods lines and unrequested lines are not VAT-capped', () => {
  const order = { shippingForeign: 0, lines: [{ id: 'fee', description: 'Fee', totalForeign: 10, taxForeign: 2 }, { id: 'goods', description: 'Goods', totalForeign: 10, taxForeign: 2 }] }
  const over = (prior: Array<{ salesOrderLineId: string; totalForeign: number; chargedTaxForeign?: number | null }>, allocation: { lineId: string; netForeign: number; taxForeign: number | null }, capped = true) =>
    findOverAllocatedRefundTarget({ order, priorRefundLines: prior.map((p) => ({ ...p, lineKind: 'sale' })), allocations: [allocation], taxCappedLineIds: capped ? new Set(['fee']) : new Set() })
  assert.equal(over([{ salesOrderLineId: 'fee', totalForeign: 5, chargedTaxForeign: 1.5 }], { lineId: 'fee', netForeign: 5, taxForeign: 1 })?.kind, 'tax')
  assert.equal(over([{ salesOrderLineId: 'fee', totalForeign: 5, chargedTaxForeign: 1.5 }], { lineId: 'fee', netForeign: 5, taxForeign: 0.5 }), null, 'exactly the remainder')
  // an unstated prior half (net 5 of 10 at 2/10) counts 1.00, leaving 1.00
  assert.equal(over([{ salesOrderLineId: 'fee', totalForeign: 5 }], { lineId: 'fee', netForeign: 5, taxForeign: 1.2 })?.kind, 'tax')
  assert.equal(over([{ salesOrderLineId: 'fee', totalForeign: 5 }], { lineId: 'fee', netForeign: 5, taxForeign: 1 }), null)
  assert.equal(over([], { lineId: 'fee', netForeign: 5, taxForeign: null }), null, 'no stated VAT, no VAT cap (the net cap still applies)')
  assert.equal(over([{ salesOrderLineId: 'goods', totalForeign: 5, chargedTaxForeign: 1.9 }], { lineId: 'goods', netForeign: 5, taxForeign: 1.9 }), null, 'goods are not VAT-capped')
  assert.equal(over([{ salesOrderLineId: 'fee', totalForeign: 5, chargedTaxForeign: 1.5 }], { lineId: 'fee', netForeign: 5, taxForeign: 1 }, false), null, 'not requested for this line')
})
