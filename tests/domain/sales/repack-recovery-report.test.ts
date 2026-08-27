import assert from 'node:assert/strict'
import test from 'node:test'

import { describeRepackReallocation } from '../../../lib/domain/sales/repack-recovery-report.ts'

/**
 * o3d-2k5r — a COMMITTED re-allocation that returned `success: false` told the operator the
 * opposite of what happened.
 */

test('o3d-2k5r: a fully successful re-allocation says nothing', () => {
  assert.equal(describeRepackReallocation('SO-1', { success: true, committed: true }), null)
})

test('o3d-2k5r: a REFUSED re-allocation names the shipment that blocked it', () => {
  const warning = describeRepackReallocation('SO-1', { success: false, refused: true, committed: false })
  assert.match(warning!, /another committed \(picking or packed\) shipment/)
  // Nothing was re-allocated and no backstop row was consumed, so this one really is unfinished.
  assert.doesNotMatch(warning!, /reservation was released/)
})

test('o3d-2k5r: a COMMITTED backorder reports the netting as DONE, not as a retry', () => {
  // The transaction committed: the refunded units' reservation was released and onReconciledInTx
  // resolved the durable backstop rows immediately before that commit. Sending the operator to
  // "run allocation again" points them at a retry whose driver has already been consumed.
  const warning = describeRepackReallocation('SO-1', {
    success: false, committed: true, unallocatedQty: 3, error: 'insufficient stock',
  })
  assert.match(warning!, /reservation was released/)
  assert.match(warning!, /3 unit\(s\) are on backorder/)
  assert.match(warning!, /insufficient stock/)
  assert.doesNotMatch(warning!, /run allocation on this order again/)
  assert.doesNotMatch(warning!, /may still be reserved/)
})

test('o3d-2k5r: an UNCOMMITTED failure still says the reservation may be stale and to retry', () => {
  // A pre-transaction bail or a rolled-back transaction. Here re-running allocation IS the remedy,
  // and the two branches must not be collapsed into one another in either direction.
  const warning = describeRepackReallocation('SO-1', { success: false, committed: false, error: 'no eligible warehouse' })
  assert.match(warning!, /run allocation on this order again/)
  assert.match(warning!, /may still be reserved/)
  assert.doesNotMatch(warning!, /reservation was released/)
})

test('o3d-2k5r: `committed` is what separates the two failures — nothing else in the result does', () => {
  const base = { success: false as const, error: 'insufficient stock', unallocatedQty: 3 }
  // Identical inputs but for the one flag; if the branch stopped reading it, these would collide.
  assert.notEqual(
    describeRepackReallocation('SO-1', { ...base, committed: true }),
    describeRepackReallocation('SO-1', { ...base, committed: false }),
  )
})
