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
