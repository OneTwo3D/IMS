import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  applyPegCapsToStockMap, applyPegHoldsToStockMap, decidePeg, grantReceipts, holdByWarehouse, settlePegs, sortReleaseCandidatesPeggedLast, splitLandedByWarehouse,
} from '@/lib/domain/sales/peg-service'

/**
 * SO-to-PO pegging, the arithmetic. The database-backed behaviour (a receipt allocating to the pegged order first, the
 * sweep, pegs ending, two concurrent receipts) is proved against Postgres in tests/concurrency/so-po-pegging.concurrent.test.ts.
 */

const D = (value: number | string) => new Prisma.Decimal(value)
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 17, 9, minutes))

const W = (entries: Record<string, number | string>) => new Map(Object.entries(entries).map(([key, value]) => [key, D(value)]))
const peg = (id: string, minutes: number, qty: number, received: Record<string, number> = {}, seen: Record<string, number> = {}) => (
  { id, createdAt: at(minutes), qty: D(qty), receivedByWarehouse: W(received), seenByWarehouse: W(seen) }
)
const apply = (pegs: ReturnType<typeof peg>[], landed: Record<string, number>) => {
  const granted = grantReceipts(pegs, W(landed))
  return { granted, next: pegs.map((p) => ({ ...p, receivedByWarehouse: granted.get(p.id)!.receivedByWarehouse, seenByWarehouse: granted.get(p.id)!.seenByWarehouse })) }
}

test('a receipt earmarks landed units for the oldest peg first, up to its quantity, and the remainder is left for others', () => {
  const { granted, next } = apply([peg('b', 5, 4), peg('a', 1, 3)], { w1: 5 })
  assert.equal(granted.get('a')!.receivedQty.toString(), '3', 'the older peg is filled first')
  assert.equal(granted.get('b')!.receivedQty.toString(), '2', 'the younger gets what is left of the receipt')
  const more = grantReceipts(next, W({ w1: 20 }))
  assert.equal(more.get('b')!.receivedQty.toString(), '4', 'capped at the pegged quantity; the other 11 units are nobody\'s peg')
})

test('replaying the same landed figure grants nothing (every receipt path can call the refresh)', () => {
  const { granted, next } = apply([peg('a', 1, 10)], { w1: 4 })
  assert.equal(granted.get('a')!.receivedQty.toString(), '4')
  assert.equal(grantReceipts(next, W({ w1: 4 })).get('a')!.receivedQty.toString(), '4')
})

test('units are earmarked in the warehouse they landed in, not the PO destination', () => {
  const { granted } = apply([peg('a', 1, 5)], { b: 3, a: 1 })
  assert.deepEqual([...granted.get('a')!.receivedByWarehouse].map(([k, v]) => [k, v.toString()]), [['a', '1'], ['b', '3']])
  assert.equal(granted.get('a')!.receivedQty.toString(), '4')
})

test('a landed-quantity correction takes the excess earmark back, newest peg first, so the units that land again are counted once', () => {
  const first = apply([peg('p1', 1, 5), peg('p2', 2, 5)], { w: 5 })
  assert.equal(first.granted.get('p1')!.receivedQty.toString(), '5')
  assert.equal(first.granted.get('p2')!.receivedQty.toString(), '0')
  const corrected = apply(first.next, { w: 0 })
  assert.equal(corrected.granted.get('p1')!.receivedQty.toString(), '0', 'the earmark follows the landed figure down')
  assert.equal(corrected.granted.get('p2')!.receivedQty.toString(), '0')
  const back = apply(corrected.next, { w: 5 })
  const total = [...back.granted.values()].reduce((sum, g) => sum.add(g.receivedQty), D(0))
  assert.equal(total.toString(), '5', 'holds total the 5 landed units, not 10')
  assert.equal(back.granted.get('p1')!.receivedQty.toString(), '5')
  // A partial correction trims the newest peg first.
  const both = apply([peg('p1', 1, 5), peg('p2', 2, 5)], { w: 8 })
  const trimmed = grantReceipts(both.next, W({ w: 6 }))
  assert.equal(trimmed.get('p1')!.receivedQty.toString(), '5')
  assert.equal(trimmed.get('p2')!.receivedQty.toString(), '1')
})

test('landed units are split by cost-layer warehouse, capped at the landed total, with the unlayered rest at the destination', () => {
  assert.deepEqual([...splitLandedByWarehouse(D(10), W({ b: 4, a: 2 }), 'dest')].map(([k, v]) => [k, v.toString()]), [['a', '2'], ['b', '4'], ['dest', '4']])
  assert.deepEqual([...splitLandedByWarehouse(D(3), W({ b: 4, a: 2 }), 'dest')].map(([k, v]) => [k, v.toString()]), [['a', '2'], ['b', '1']])
  assert.deepEqual([...splitLandedByWarehouse(D(2), W({}), null)].map(([k, v]) => [k, v.toString()]), [['', '2']])
})

test('a hold by warehouse takes the absorbed units from the warehouses the order already holds stock in first', () => {
  const held = holdByWarehouse(W({ a: 3, b: 4 }), D(5), ['b'])
  assert.deepEqual([...held].map(([k, v]) => [k, v.toString()]), [['a', '3'], ['b', '2']])
})

test('a peg is absorbed only by what the line gained since the peg was made, and the hold is the unabsorbed rest', () => {
  const pegs = [{ id: 'a', createdAt: at(1), qty: D(5), receivedQty: D(5), baselineAllocatedQty: D(2) }]
  const none = settlePegs(pegs, D(2), D(10))
  assert.equal(none.get('a')!.allocated.toString(), '0', 'the 2 it held beforehand do not count')
  assert.equal(none.get('a')!.hold.toString(), '5')
  const part = settlePegs(pegs, D(5), D(10))
  assert.equal(part.get('a')!.allocated.toString(), '3')
  assert.equal(part.get('a')!.hold.toString(), '2')
})

test('the hold never exceeds what the order line still lacks', () => {
  const settled = settlePegs([{ id: 'a', createdAt: at(1), qty: D(5), receivedQty: D(5), baselineAllocatedQty: D(0) }], D(0), D(3))
  assert.equal(settled.get('a')!.hold.toString(), '3')
})

test('a peg over the unreceived quantity of the PO line is refused, and net of other pegs', () => {
  const base = {
    qty: D(5), salesLineQty: D(10), salesLineRefundedQty: D(0), salesLineAllocated: D(0), salesLineOtherPegRemaining: D(0),
    purchaseLineQty: D(8), purchaseLineLanded: D(4), purchaseLineOtherPegRemaining: D(0),
  }
  const over = decidePeg(base)
  assert.equal(over.ok, false)
  assert.match(over.ok ? '' : over.error, /Only 4 of that purchase order line is still unreceived/)
  assert.equal(decidePeg({ ...base, qty: D(4) }).ok, true)
  assert.equal(decidePeg({ ...base, qty: D(3), purchaseLineOtherPegRemaining: D(2) }).ok, false, 'another order already pegged 2 of the 4')
  assert.equal(decidePeg({ ...base, qty: D(0) }).ok, false)
})

test('a peg over what the order line still lacks is refused', () => {
  const decision = decidePeg({
    qty: D(4), salesLineQty: D(10), salesLineRefundedQty: D(1), salesLineAllocated: D(4), salesLineOtherPegRemaining: D(2),
    purchaseLineQty: D(50), purchaseLineLanded: D(0), purchaseLineOtherPegRemaining: D(0),
  })
  assert.equal(decision.ok, false)
  assert.match(decision.ok ? '' : decision.error, /only still needs 3/)
})

test('other orders\' holds come out of the warehouse the units landed in only, never below zero and never from another warehouse', () => {
  const map = new Map([['p', new Map([['w1', D(2)], ['w2', D(10)]])]])
  applyPegHoldsToStockMap(map, [{ pegId: 'x', productId: 'p', warehouseId: 'w1', qty: D(5) }])
  assert.equal(map.get('p')!.get('w1')!.toString(), '0', 'a hold larger than the stock there only empties it')
  assert.equal(map.get('p')!.get('w2')!.toString(), '10', 'and does not spill into the other warehouse')
  applyPegHoldsToStockMap(map, [{ pegId: 'y', productId: 'p', warehouseId: '', qty: D(100) }])
  assert.equal(map.get('p')!.get('w2')!.toString(), '0', 'a hold with no recorded warehouse comes from wherever there is stock')
})

test('the peg pass may take, per warehouse, only what it already reserves there plus what landed there for its pegs', () => {
  const map = new Map([['p', new Map([['a', D(20)], ['b', D(6)]])]])
  applyPegCapsToStockMap(map, new Map([['p', W({ b: 4 })]]), [{ productId: 'p', warehouseId: 'a', qty: D(1) }])
  assert.equal(map.get('p')!.get('a')!.toString(), '1', 'a receipt into b does not open up the stock in a')
  assert.equal(map.get('p')!.get('b')!.toString(), '4')
})

test('the rebalancer releases a pegged order last and otherwise keeps its newest-first order', () => {
  const rows = [{ orderId: 'new' }, { orderId: 'pegged' }, { orderId: 'old' }]
  assert.deepEqual(sortReleaseCandidatesPeggedLast(rows, new Set(['pegged'])).map((r) => r.orderId), ['new', 'old', 'pegged'])
  assert.deepEqual(sortReleaseCandidatesPeggedLast(rows, new Set()).map((r) => r.orderId), ['new', 'pegged', 'old'])
})
