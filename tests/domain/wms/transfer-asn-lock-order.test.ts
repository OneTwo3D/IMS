import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertParentIsLocked,
  assertParentsWereLocked,
  AsnParentNotLockedError,
  LANDED_COST_PROPAGATION_MAX_DEPTH,
  LandedCostScopeRacedError,
  lockLandedCostRevaluationScope,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// o3d-nrl4 PR A — lockLandedCostRevaluationScope. The ORDER it takes is proved against real locks in
// tests/concurrency/landed-cost-revaluation-scope-lock.concurrent.test.ts; what a fake client can show is
// the statement sequence, the refusal's arithmetic, and the depth bound.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

type ScopeWorld = {
  links: string[]
  rootLayers: string[]
  /** layer -> output layers (cost_layer_source_lines) */
  outputs: Record<string, string[]>
  /** transfer -> layers named by its snapshots */
  transfers: Record<string, string[]>
}

function scopeClient(world: ScopeWorld, onLock?: (table: string) => void) {
  const log: string[] = []
  const client = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('FROM landed_cost_links')) {
        log.push('discover:links')
        return Promise.resolve(world.links.map((primaryPoId) => ({ primaryPoId })))
      }
      if (sql.includes('FROM cost_layers cl')) {
        log.push('discover:roots')
        return Promise.resolve(world.rootLayers.map((id) => ({ id })))
      }
      if (sql.includes('FROM cost_layer_source_lines')) {
        log.push('discover:outputs')
        const frontier = values[0] as string[]
        return Promise.resolve([...new Set(frontier.flatMap((id) => world.outputs[id] ?? []))].map((id) => ({ id })))
      }
      if (sql.includes('FROM stock_transfer_lines')) {
        log.push('discover:transfers')
        const patterns = (values[0] as string[]).map((p) => (JSON.parse(p) as Array<{ costLayerId: string }>)[0]!.costLayerId)
        const ids = Object.entries(world.transfers).filter(([, layers]) => layers.some((l) => patterns.includes(l))).map(([id]) => id)
        return Promise.resolve(ids.map((id) => ({ id })))
      }
      const lock = /FROM (stock_transfers|purchase_orders|purchase_order_lines|freight_cost_lines|cost_layers) WHERE[\s\S]*FOR (NO KEY UPDATE|UPDATE)/.exec(sql)
      if (lock) {
        log.push(`lock:${lock[1]}:${lock[2]}:${JSON.stringify(values[0])}`)
        onLock?.(lock[1]!)
        return Promise.resolve([])
      }
      throw new Error(`unexpected statement: ${sql}`)
    },
  }
  return { client, log }
}

/** Collapse a statement log into its phases: D = a discovery pass, then each lock's table. */
function phases(log: string[]): string[] {
  const out: string[] = []
  for (const entry of log) {
    const label = entry.startsWith('discover:') ? 'D' : entry.split(':')[1]!
    if (label === 'D' && out[out.length - 1] === 'D') continue
    out.push(label)
  }
  return out
}

test('lockLandedCostRevaluationScope takes transfers, then orders with their cost rows, re-discovers, then layers (NO KEY UPDATE), ascending, and re-discovers last (o3d-nrl4 A)', async () => {
  const world: ScopeWorld = {
    links: ['po-b', 'po-a'],
    rootLayers: ['l-2', 'l-1'],
    outputs: { 'l-1': ['l-3'] },
    transfers: { 't-9': ['l-3'], 't-2': ['l-1'], 't-x': ['l-unrelated'] },
  }
  const { client, log } = scopeClient(world)
  const scope = await lockLandedCostRevaluationScope(client as never, { freightPoId: 'fr-1' })
  assert.deepEqual(scope.transferIds, ['t-2', 't-9'])
  assert.deepEqual(scope.costLayerIds, ['l-1', 'l-2', 'l-3'])
  assert.deepEqual(scope.purchaseOrderIds, ['fr-1', 'po-a', 'po-b'])
  const locks = log.filter((entry) => entry.startsWith('lock:'))
  assert.deepEqual(locks, [
    'lock:stock_transfers:UPDATE:["t-2","t-9"]',
    'lock:purchase_orders:UPDATE:["fr-1","po-a","po-b"]',
    'lock:purchase_order_lines:UPDATE:["fr-1","po-a","po-b"]',
    'lock:freight_cost_lines:UPDATE:["fr-1","po-a","po-b"]',
    'lock:cost_layers:NO KEY UPDATE:["l-1","l-2","l-3"]',
  ])
  assert.deepEqual(
    phases(log),
    ['D', 'stock_transfers', 'purchase_orders', 'purchase_order_lines', 'freight_cost_lines', 'D', 'cost_layers', 'D'],
    'discovery, 2a, 2b-2d, re-discovery #1, 6, re-discovery #2 — in exactly that order',
  )
  assert.ok(!scope.transferIds.includes('t-x'), 'an unrelated transfer is not locked')
})

test('lockLandedCostRevaluationScope refuses a TRANSFER that appears while it queues for the orders — before taking any layer (o3d-nrl4 A)', async () => {
  const world: ScopeWorld = { links: ['po-a'], rootLayers: ['l-1'], outputs: {}, transfers: { 't-1': ['l-1'] } }
  const raced = scopeClient(world, (table) => { if (table === 'freight_cost_lines') world.transfers['t-2'] = ['l-1'] })
  await assert.rejects(
    lockLandedCostRevaluationScope(raced.client as never, { freightPoId: 'fr-1' }),
    (error: unknown) => {
      assert.ok(error instanceof LandedCostScopeRacedError)
      assert.deepEqual(error.unlockedTransferIds, ['t-2'])
      assert.deepEqual(error.unlockedCostLayerIds, [])
      assert.match(error.message, /Retry the action/)
      return true
    },
  )
  assert.equal(raced.log.filter((entry) => entry.startsWith('lock:cost_layers')).length, 0, 'refused before any layer lock')
})

test('lockLandedCostRevaluationScope refuses a transfer or layer that appears while the layers are being locked (o3d-nrl4 A)', async () => {
  const world: ScopeWorld = { links: ['po-a'], rootLayers: ['l-1'], outputs: {}, transfers: { 't-1': ['l-1'] } }
  const raced = scopeClient(world, (table) => { if (table === 'cost_layers') world.transfers['t-2'] = ['l-1'] })
  await assert.rejects(
    lockLandedCostRevaluationScope(raced.client as never, { freightPoId: 'fr-1' }),
    (error: unknown) => {
      assert.ok(error instanceof LandedCostScopeRacedError)
      assert.deepEqual(error.unlockedTransferIds, ['t-2'])
      return true
    },
  )
  // A new layer on a primary line after the layers were locked.
  const world2: ScopeWorld = { links: ['po-a'], rootLayers: ['l-1'], outputs: {}, transfers: {} }
  const raced2 = scopeClient(world2, (table) => { if (table === 'cost_layers') world2.rootLayers.push('l-new') })
  await assert.rejects(lockLandedCostRevaluationScope(raced2.client as never, { primaryPoIds: ['po-a'] }), (error: unknown) => {
    assert.ok(error instanceof LandedCostScopeRacedError)
    assert.deepEqual(error.unlockedCostLayerIds, ['l-new'])
    return true
  })
  // And the negative control: nothing changed -> no refusal (the check is not a blanket throw).
  const calm: ScopeWorld = { links: ['po-a'], rootLayers: ['l-1'], outputs: {}, transfers: { 't-1': ['l-1'] } }
  await lockLandedCostRevaluationScope(scopeClient(calm).client as never, { freightPoId: 'fr-1' })
})

test('lockLandedCostRevaluationScope takes a LAYER that appears while it queues for the orders — an alignment committing its receipt is not a race (o3d-nrl4 A)', async () => {
  const world: ScopeWorld = { links: [], rootLayers: [], outputs: {}, transfers: {} }
  const { client, log } = scopeClient(world, (table) => { if (table === 'freight_cost_lines') world.rootLayers.push('l-aligned') })
  const scope = await lockLandedCostRevaluationScope(client as never, { primaryPoIds: ['po-a'] })
  assert.deepEqual(scope.costLayerIds, ['l-aligned'], 'the layer the alignment created is part of the scope')
  assert.deepEqual(log.filter((entry) => entry.startsWith('lock:cost_layers')), ['lock:cost_layers:NO KEY UPDATE:["l-aligned"]'])
})

test('lockLandedCostRevaluationScope walks source lines to the propagation depth and no further, and survives a cycle (o3d-nrl4 A)', async () => {
  const outputs: Record<string, string[]> = {}
  const chain = Array.from({ length: LANDED_COST_PROPAGATION_MAX_DEPTH + 6 }, (_, i) => `l-${String(i).padStart(2, '0')}`)
  for (let i = 0; i < chain.length - 1; i += 1) outputs[chain[i]!] = [chain[i + 1]!]
  outputs[chain[chain.length - 1]!] = [chain[0]!] // a cycle back to the root
  const world: ScopeWorld = { links: ['po-a'], rootLayers: [chain[0]!], outputs, transfers: {} }
  const scope = await lockLandedCostRevaluationScope(scopeClient(world).client as never, { freightPoId: 'fr-1' })
  assert.equal(scope.costLayerIds.length, LANDED_COST_PROPAGATION_MAX_DEPTH + 1, 'the root plus exactly MAX_DEPTH levels of outputs')
  assert.ok(!scope.costLayerIds.includes(chain[LANDED_COST_PROPAGATION_MAX_DEPTH + 1]!), 'level MAX_DEPTH+1 is beyond what propagation revalues')
})

test('lockLandedCostRevaluationScope issues no lock statements for an empty scope (o3d-nrl4 A)', async () => {
  const { client, log } = scopeClient({ links: [], rootLayers: [], outputs: {}, transfers: {} })
  const scope = await lockLandedCostRevaluationScope(client as never, { freightPoId: 'fr-solo' })
  assert.deepEqual(scope.purchaseOrderIds, ['fr-solo'], 'the freight order itself is still locked')
  assert.deepEqual(log.filter((entry) => entry.startsWith('lock:')).map((entry) => entry.split(':')[1]), ['purchase_orders', 'purchase_order_lines', 'freight_cost_lines'])
})
