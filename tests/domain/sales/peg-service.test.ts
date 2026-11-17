import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  applyPegHoldsToStockMap, decidePeg, grantReceipts, settlePegs, sortReleaseCandidatesPeggedLast,
} from '@/lib/domain/sales/peg-service'

/**
 * SO-to-PO pegging, the arithmetic. The database-backed behaviour (a receipt allocating to the pegged order first, the
 * sweep, pegs ending, two concurrent receipts) is proved against Postgres in tests/concurrency/so-po-pegging.concurrent.test.ts.
 */

const D = (value: number | string) => new Prisma.Decimal(value)
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 17, 9, minutes))

test('a receipt earmarks landed units for the oldest peg first, up to its quantity, and the remainder is left for others', () => {
  const pegs = [
    { id: 'b', createdAt: at(5), qty: D(4), receivedQty: D(0), seenLandedQty: D(0) },
    { id: 'a', createdAt: at(1), qty: D(3), receivedQty: D(0), seenLandedQty: D(0) },
  ]
  const granted = grantReceipts(pegs, D(5))
  assert.equal(granted.get('a')!.receivedQty.toString(), '3', 'the older peg is filled first')
  assert.equal(granted.get('b')!.receivedQty.toString(), '2', 'the younger gets what is left of the receipt')
  const more = grantReceipts(pegs.map((p) => ({ ...p, receivedQty: granted.get(p.id)!.receivedQty, seenLandedQty: granted.get(p.id)!.seenLandedQty })), D(20))
  assert.equal(more.get('b')!.receivedQty.toString(), '4', 'capped at the pegged quantity; the other 11 units are nobody\'s peg')
})

test('replaying the same landed figure grants nothing (every receipt path can call the refresh)', () => {
  const first = grantReceipts([{ id: 'a', createdAt: at(1), qty: D(10), receivedQty: D(0), seenLandedQty: D(0) }], D(4))
  const replay = grantReceipts([{ id: 'a', createdAt: at(1), qty: D(10), receivedQty: first.get('a')!.receivedQty, seenLandedQty: first.get('a')!.seenLandedQty }], D(4))
  assert.equal(replay.get('a')!.receivedQty.toString(), '4')
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

test('other orders\' holds come out of the destination warehouse first, then the rest, never below zero', () => {
  const map = new Map([['p', new Map([['w1', D(2)], ['w2', D(10)]])]])
  applyPegHoldsToStockMap(map, [{ pegId: 'x', productId: 'p', warehouseHint: 'w1', qty: D(5) }])
  assert.equal(map.get('p')!.get('w1')!.toString(), '0')
  assert.equal(map.get('p')!.get('w2')!.toString(), '7')
  applyPegHoldsToStockMap(map, [{ pegId: 'y', productId: 'p', warehouseHint: null, qty: D(100) }])
  assert.equal(map.get('p')!.get('w2')!.toString(), '0', 'a hold larger than the stock only empties it')
})

test('the rebalancer releases a pegged order last and otherwise keeps its newest-first order', () => {
  const rows = [{ orderId: 'new' }, { orderId: 'pegged' }, { orderId: 'old' }]
  assert.deepEqual(sortReleaseCandidatesPeggedLast(rows, new Set(['pegged'])).map((r) => r.orderId), ['new', 'old', 'pegged'])
  assert.deepEqual(sortReleaseCandidatesPeggedLast(rows, new Set()).map((r) => r.orderId), ['new', 'pegged', 'old'])
})
