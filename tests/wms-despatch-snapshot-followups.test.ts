import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { reconcileOneOrder, despatchStampsMatch, sameWmsInstant, partsReadStamp, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import { SNAPSHOT_RUNNING_MARK, tryLockInventorySnapshotFloorShared } from '../lib/domain/sales/despatch-instant.ts'
import { classifyDespatchDatePrerequisite } from '../lib/ops/rollout-readiness.ts'
import type { WmsOrderPart, WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * The #1095 round-2 follow-ups that need no database (the database-tier counterparts are tests/db/despatch-snapshot-followups.test.ts): the split path
 * pushes no partial shipment while a quantity hold stands, a stored despatch is re-applied only while the warehouse's stamp is unchanged, a despatch refused
 * because the snapshot is running is neither an error nor a refusal row, the readiness warnings, and the two guards that are about the ORDER of statements.
 */
const LONDON = 'europe-london' as const
function status(overrides: Partial<WmsOrderStatus> = {}): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'SO-5001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }], dispatched: true, raw: null,
    ...overrides,
  }
}
function deps(log: string[], overrides: Partial<WmsDispatchSweepDeps> = {}): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => status(),
    applyDispatch: async () => { log.push('apply'); return { success: true } },
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => { log.push('push'); return { ok: true } },
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    zonelessDespatchReading: LONDON,
    passDespatchFacts: true,
    ...overrides,
  }
}
const candidate = { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'SO-5001' }
const part = (n: number, dispatched: boolean, lastUpdated: string | null = `2026-11-19T1${n}:00:00`): WmsOrderPart => ({
  externalId: `P${n}`, partNumber: n, status: dispatched ? 'DESPATCHED' : 'NEW', dispatched, lastUpdated,
  tracking: dispatched ? [{ trackingNumber: `T${n}`, carrier: 'DPD', despatchedAt: `2026-11-19T1${n}:00:00` }] : [],
})

// ---- item 5: no partial pushes while a hold stands ---------------------------------------------------------------------------------------------

test('item 5: while a quantity hold stands NO partial shipment is pushed to the storefront (part-way split, and a complete split whose units now agree)', async () => {
  // Part-way: one of two parts despatched. Before the fix the part was pushed (a customer e-mail that cannot be taken back) for goods IMS holds.
  const partWay: string[] = []
  const held = await reconcileOneOrder(deps(partWay, {
    hasOpenQuantityHold: async () => true,
    fetchOrderParts: async () => [part(1, true), part(2, false)],
    fetchPartItems: async () => [{ sku: 'SKU-C', qty: 2 }],
  }), candidate, status({ isSplit: true, partCount: 2 }))
  assert.equal(held.action, 'pending')
  assert.deepEqual(partWay, [], 'no push while the hold stands')
  // Complete and the units now agree (preview passes): the apply releases the hold; still no partial pushes (the apply completes the storefront order).
  const complete: string[] = []
  const outcome = await reconcileOneOrder(deps(complete, {
    hasOpenQuantityHold: async () => true,
    previewQuantityMismatch: async () => null,
    fetchOrderParts: async () => [part(1, true), part(2, true)],
    fetchPartItems: async () => [{ sku: 'SKU-C', qty: 2 }],
  }), candidate, status({ isSplit: true, partCount: 2 }))
  assert.equal(outcome.action, 'dispatched')
  assert.deepEqual(complete, ['apply'])
  // No hold: pushed as before.
  const free: string[] = []
  await reconcileOneOrder(deps(free, { hasOpenQuantityHold: async () => false, fetchOrderParts: async () => [part(1, true), part(2, false)], fetchPartItems: async () => [{ sku: 'SKU-C', qty: 2 }] }), candidate, status({ isSplit: true, partCount: 2 }))
  assert.deepEqual(free, ['push'])
})

// ---- item 3: stale stored quantities -----------------------------------------------------------------------------------------------------------

test('item 3: stored quantities are re-applied only while the warehouse stamp stored with them is unchanged (non-split)', async () => {
  const stored = { lastUpdated: '2026-11-19T10:30:00' }
  const base = { hasOpenQuantityHold: async () => true, standingDespatchedQuantities: async () => [{ sku: 'SKU-C', qty: 3 }], standingDespatchStamp: async () => stored }
  const same: unknown[] = []
  assert.equal((await reconcileOneOrder(deps([], { ...base, applyDispatch: async (_o, _t, options) => { same.push(options?.despatchedQuantities); return { success: true } } }), candidate, status({ lastUpdated: '2026-11-19T10:30:00' }))).action, 'dispatched')
  assert.deepEqual(same, [[{ sku: 'SKU-C', qty: 3 }]])
  // The warehouse changed the order since (LastUpdated moved) and this read carries no items: the stored units may be stale, so the hold stays.
  const log: string[] = []
  const moved = await reconcileOneOrder(deps(log, base), candidate, status({ lastUpdated: '2026-11-19T12:00:00' }))
  assert.equal(moved.action, 'pending')
  assert.deepEqual(log, [], 'never applied on the stale units')
  // No stamp on the read, or none stored (a row from before stamps): cannot be proven unchanged, so held.
  assert.equal((await reconcileOneOrder(deps([], base), candidate, status())).action, 'pending')
  assert.equal((await reconcileOneOrder(deps([], { ...base, standingDespatchStamp: async () => null }), candidate, status({ lastUpdated: '2026-11-19T10:30:00' }))).action, 'pending')
})

test('item 3: a MERGED split order (whose parts mix several orders, so carry no comparable items) re-applies only while its part set (ids and each part stamp) is unchanged', async () => {
  const parts = [part(1, true), part(2, true)]
  const storedStamp = partsReadStamp(parts)
  const base = (current: WmsOrderPart[], log: string[]) => deps(log, {
    hasOpenQuantityHold: async () => true,
    standingDespatchedQuantities: async () => [{ sku: 'SKU-C', qty: 4 }],
    standingDespatchStamp: async () => storedStamp,
    fetchOrderParts: async () => current,
    fetchPartItems: async () => [],
  })
  const same: string[] = []
  assert.equal((await reconcileOneOrder(base(parts, same), candidate, status({ isSplit: true, partCount: 2, isMerged: true, mergedOrderNumbers: ['SO-5001', 'SO-5002'] }))).action, 'dispatched')
  // A part changed in the warehouse since (its stamp moved), or a part was added: kept.
  for (const current of [[part(1, true), part(2, true, '2026-11-19T18:00:00')], [part(1, true), part(2, true), part(3, true)]]) {
    const log: string[] = []
    const outcome = await reconcileOneOrder(base(current, log), candidate, status({ isSplit: true, partCount: current.length, isMerged: true, mergedOrderNumbers: ['SO-5001', 'SO-5002'] }))
    assert.equal(outcome.action, 'pending', JSON.stringify(current.map((p) => p.lastUpdated)))
    assert.deepEqual(log, [])
  }
  // A part with no stamp makes the stamp unusable: it can never match.
  assert.equal(despatchStampsMatch(partsReadStamp([part(1, true, null)]), partsReadStamp([part(1, true, null)])), false)
})

test('item 3: the standing row stores the stamp with the despatched units', async () => {
  const refusals: Array<{ intent: unknown }> = []
  const { runWmsDispatchSweepCore } = await import('../lib/domain/wms/dispatch-sweep.ts')
  await runWmsDispatchSweepCore(deps([], {
    listCandidates: async () => [candidate],
    fetchOrderStatus: async () => status({ items: [{ sku: 'SKU-C', qty: 4 }], lastUpdated: '2026-11-19T10:30:00' }),
    applyDispatch: async () => ({ success: false, error: 'x', refusal: 'despatch_quantity_mismatch', quantityMismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }], despatchedQuantities: [{ sku: 'SKU-C', qty: 4 }] }),
    recordRefusedAction: async (_c, refusal) => { refusals.push(refusal as never) },
  }))
  assert.deepEqual((refusals[0].intent as { stamp?: unknown }).stamp, { lastUpdated: '2026-11-19T10:30:00', parts: null })
})

// ---- item 4: a despatch refused because the snapshot runs --------------------------------------------------------------------------------------

test('item 4: a despatch refused because the snapshot holds the floor lock is pending: not an error, no refusal row, the watermark is held', async () => {
  const outcome = await reconcileOneOrder(deps([], {
    applyDispatch: async () => ({ success: false, error: `${SNAPSHOT_RUNNING_MARK}applied again on the next pass`, refusal: 'snapshot_in_progress' }),
  }), candidate, status())
  assert.equal(outcome.action, 'pending')
  assert.equal(outcome.refusal, undefined, 'a transient wait is not raised for a person')
  assert.equal(outcome.holdWatermark, true)
})

test('item 4: the floor lock is TRIED, never waited for', async () => {
  const sqls: string[] = []
  const grant = (locked: boolean) => ({ $queryRaw: async (strings: TemplateStringsArray) => { sqls.push(strings.join('?')); return [{ locked }] } })
  assert.equal(await tryLockInventorySnapshotFloorShared(grant(true)), true)
  assert.equal(await tryLockInventorySnapshotFloorShared(grant(false)), false)
  assert.match(sqls[0], /pg_try_advisory_xact_lock_shared/)
  // And the dispatch transaction uses it before the stock-level locks (source guard: the blocking form is gone from the dispatch path).
  const source = readFileSync(new URL('../lib/domain/sales/shipment-service.ts', import.meta.url), 'utf8')
  assert.match(source, /tryLockInventorySnapshotFloorShared\(tx\)/)
  assert.doesNotMatch(source, /await lockInventorySnapshotFloorShared\(tx\)/)
  assert.doesNotMatch(source, /The stock levels are locked FIRST/, 'the stale comment is gone')
})

// ---- items 6 and 7: readiness ------------------------------------------------------------------------------------------------------------------

test('item 6: readiness warns when the latest snapshot run is stale while the switch is effective', () => {
  const warned = classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true, snapshotRunStale: true, latestSnapshotRunAt: '2026-11-17T00:00:10.000Z' })
  assert.deepEqual(warned.map((f) => f.id), ['wms-despatch-date:snapshot-stale'])
  assert.equal(warned[0].severity, 'warning')
  assert.deepEqual(classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true, snapshotRunStale: false }), [])
  // Both at once: two findings. Switch off: nothing.
  assert.equal(classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true, snapshotRunStale: true, lockDateStale: true }).length, 2)
  assert.deepEqual(classifyDespatchDatePrerequisite({ switchOn: false, snapshotCronEnabled: true, effective: false, snapshotRunStale: true }), [])
})

// ---- item 8: statement order -------------------------------------------------------------------------------------------------------------------

test('item 8a: the stock-adjustment in-place edit takes the stock-level lock BEFORE its guards read (source-order guard)', () => {
  const source = readFileSync(new URL('../app/actions/stock.ts', import.meta.url), 'utf8')
  const lock = source.indexOf('await lockStockLevelRow(tx, movement.productId, oldWarehouseId)')
  const later = source.indexOf('const laterMovementCount = await tx.stockMovement.count(')
  const journal = source.indexOf('await adjustmentJournalMayHaveReachedLedger(tx, id)')
  assert.ok(lock > 0 && later > 0 && journal > 0)
  assert.ok(lock < later && lock < journal, 'the lock precedes both guards')
})

test('item 8b: the scoped (mixed-warehouse) despatch path carries the in-lock quantity fence (source guard)', () => {
  const source = readFileSync(new URL('../lib/fulfillment/external-fulfillment.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function applyScopedWmsDespatch(')
  const end = source.indexOf('async function recordScopedApplication(')
  assert.ok(start > 0 && end > start)
  const body = source.slice(start, end)
  assert.match(body, /withQuantityFence\(update, order\.id, wmsWarehouseId, quantityCaptured\)/)
  assert.match(body, /shipFence: scopedFence/)
  assert.match(body, /startsWith\(QUANTITY_FENCE_MARK\)/)
})

test('stamp compare: the same moment with a different fractional precision (7 digits against 3) or an offset spelling compares equal; a different moment does not', () => {
  // Order/List may write 7 digits, Order/{id} 3 (truncated or rounded).
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:22.747'), true)
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:22.748'), true, 'rounded')
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:22'), true)
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:22.7476691'), true)
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:22.749'), false)
  assert.equal(sameWmsInstant('2026-09-24T11:20:22.7476691', '2026-09-24T11:20:23.747'), false)
  assert.equal(sameWmsInstant('2026-09-24T12:20:22+01:00', '2026-09-24T11:20:22Z'), true)
  assert.equal(sameWmsInstant('2026-09-24T11:20:22', '2026-09-24T11:20:22Z'), false, 'zoneless against zoned: cannot say')
  assert.equal(sameWmsInstant('garbage', 'garbage'), false)
  assert.equal(sameWmsInstant(null, '2026-09-24T11:20:22'), false)
  // And through the stamp compare, for both a non-split and a per-part stamp.
  assert.equal(despatchStampsMatch({ lastUpdated: '2026-09-24T11:20:22.7476691' }, { lastUpdated: '2026-09-24T11:20:22.747' }), true)
  assert.equal(despatchStampsMatch({ parts: ['P1@2026-09-24T11:20:22.7476691'] }, { parts: ['P1@2026-09-24T11:20:22.747'] }), true)
  assert.equal(despatchStampsMatch({ parts: ['P1@2026-09-24T11:20:22.7476691'] }, { parts: ['P2@2026-09-24T11:20:22.747'] }), false)
})
