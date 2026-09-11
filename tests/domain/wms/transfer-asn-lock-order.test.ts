import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertParentIsLocked,
  assertParentsWereLocked,
  AsnParentNotLockedError,
  lockPurchaseOrders,
  lockStockTransfers,
  lockWmsAsnLineMaps,
  lockWmsAsnLineMapsForTransferLines,
  lockWmsAsnMaps,
} from '@/lib/domain/wms/transfer-asn-lock-order'

/**
 * 6oyu.19 / Codex round-9 MEDIUM-1.
 *
 * The ORDER these helpers impose is proved against a real PostgreSQL, by observing
 * which row each production path blocks on
 * (tests/concurrency/transfer-asn-lock-order.concurrent.test.ts). What is proved
 * here is the part a database cannot show: that the parent-lock assertions can
 * actually FAIL, and that the within-step ordering the helpers emit is sorted.
 *
 * `assertParentsWereLocked` is the abort that stands where "lock the extra parent
 * too" would be an inversion. An assertion nothing can trip is worse than no
 * assertion, because it reads as cover.
 */

test('assertParentsWereLocked throws when the re-read names a parent the lock set does not (Codex r9)', () => {
  assert.throws(
    () => assertParentsWereLocked({
      observedParentIds: ['tr-a', 'tr-b'],
      lockedParentIds: ['tr-a'],
      parentTable: 'stock_transfers',
      context: 'booked-in reconciliation for ASN X',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AsnParentNotLockedError, `expected AsnParentNotLockedError, got ${String(error)}`)
      assert.deepEqual(error.unlockedParentIds, ['tr-b'], 'it must name the parent that was NOT locked')
      assert.match(error.message, /stock_transfers/)
      assert.match(error.message, /booked-in reconciliation for ASN X/)
      // The reason it aborts rather than locking, in the message an operator reads.
      assert.match(error.message, /invert the global transfer\/ASN lock order/)
      return true
    },
  )
})

test('assertParentsWereLocked passes when every observed parent was locked — not a blanket throw (Codex r9)', () => {
  // Without this the test above would be satisfied by a function that always threw,
  // and every booked-in event would fail.
  assertParentsWereLocked({
    observedParentIds: ['tr-a', 'tr-b', 'tr-a'],
    lockedParentIds: ['tr-b', 'tr-a', 'tr-unused'],
    parentTable: 'stock_transfers',
    context: 'ok',
  })
  // An empty observation is the ordinary case for an ASN with no transfer lines.
  assertParentsWereLocked({
    observedParentIds: [],
    lockedParentIds: [],
    parentTable: 'stock_transfers',
    context: 'ok',
  })
})

test('assertParentIsLocked replaces a deleted FOR UPDATE with a live check (Codex r9)', () => {
  // This stands where booked-in-service used to take `purchase_orders` and
  // `stock_transfers` FOR UPDATE inside its receipt loops. Deleting a lock leaves an
  // assumption behind; this is what turns it back into a check.
  assert.throws(
    () => assertParentIsLocked('po-x', ['po-a', 'po-b'], 'purchase_orders'),
    AsnParentNotLockedError,
  )
  assertParentIsLocked('po-a', ['po-a', 'po-b'], 'purchase_orders')
})

/** Records the SQL each helper emits, without a database. */
function recordingClient() {
  const statements: string[] = []
  return {
    statements,
    client: {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(`${strings.join('?')} :: ${JSON.stringify(values)}`)
        return Promise.resolve([])
      },
    },
  }
}

test('every step-lock sorts its ids, and skips the statement entirely when there are none (Codex r9)', async () => {
  // WHY SORTING IS LOAD-BEARING. The global order stops two transactions at
  // DIFFERENT steps from crossing. Two transactions at the SAME step still cross if
  // they take the rows in different orders, which is what the booked-in receipt
  // loops did — they iterated Map insertion order, i.e. ASN-line order, so two
  // events over the same two transfers could deadlock on each other.
  for (const lock of [lockStockTransfers, lockPurchaseOrders, lockWmsAsnMaps, lockWmsAsnLineMaps]) {
    const { statements, client } = recordingClient()
    const returned = await lock(client as never, ['id-c', 'id-a', 'id-b', 'id-a'])
    assert.deepEqual(returned, ['id-a', 'id-b', 'id-c'], `${lock.name} must sort and de-duplicate`)
    assert.equal(statements.length, 1)
    assert.match(statements[0]!, /ORDER BY id\s+FOR UPDATE/, `${lock.name} must order the lock itself`)
    assert.deepEqual(statements[0]!.split(' :: ')[1], JSON.stringify([['id-a', 'id-b', 'id-c']]))

    const empty = recordingClient()
    assert.deepEqual(await lock(empty.client as never, []), [])
    assert.equal(empty.statements.length, 0, `${lock.name} must issue no statement for an empty set`)
  }
})

test('lockWmsAsnLineMapsForTransferLines locks by source line and returns the rows it locked (Codex r9)', async () => {
  const statements: string[] = []
  const client = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(`${strings.join('?')} :: ${JSON.stringify(values)}`)
      return Promise.resolve([{ id: 'asnline-2' }, { id: 'asnline-1' }])
    },
  }
  const locked = await lockWmsAsnLineMapsForTransferLines(client as never, ['tl-b', 'tl-a', 'tl-b'])
  assert.deepEqual(locked, ['asnline-2', 'asnline-1'], 'it returns the rows the database reported locking')
  assert.equal(statements.length, 1)
  assert.match(statements[0]!, /"sourceType" = 'STOCK_TRANSFER_LINE'/)
  assert.match(statements[0]!, /ORDER BY id\s+FOR UPDATE/)
  assert.deepEqual(statements[0]!.split(' :: ')[1], JSON.stringify([['tl-a', 'tl-b']]))

  const empty = recordingClient()
  assert.deepEqual(await lockWmsAsnLineMapsForTransferLines(empty.client as never, []), [])
  assert.equal(empty.statements.length, 0)
})
