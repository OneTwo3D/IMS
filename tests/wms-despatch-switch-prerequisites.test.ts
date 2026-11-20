import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DESPATCH_LOCK_DATE_MAX_AGE_HOURS,
  loadDespatchInstantFloors,
  readStoredLockDate,
  resolveDespatchInstant,
} from '../lib/domain/sales/despatch-instant.ts'
import {
  compareDespatchQuantities,
  describeDespatchQuantityExit,
  despatchQuantityMismatchKey,
  findDespatchQuantityMismatch,
  lineExpandsBeyondItself,
} from '../lib/fulfillment/despatch-quantity-check.ts'
import { reconcileOneOrder, runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import { classifyDespatchDatePrerequisite } from '../lib/ops/rollout-readiness.ts'
import type { WmsOrderPart, WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * #1088 R1 follow-ups (the prerequisites of the two warehouse despatch switches). Pure and sweep-level: no database, no network. The database-tier
 * counterparts are tests/db/despatch-switch-prerequisites.test.ts and tests/db/warehouse-despatch-dating.test.ts.
 */
const NOW = new Date('2026-11-20T10:00:00Z')
const at = (iso: string) => new Date(iso)

// ---- lock date: refreshed-or-skipped, and "no lock" stated ------------------------------------------------------------------------------------

test('lock date: a fresh read of a parseable day is the lock; a fresh EMPTY value is an explicit "no lock"; nothing ever stored is "no lock"', () => {
  const fresh = new Date(NOW.getTime() - 3_600_000).toISOString()
  assert.equal(readStoredLockDate({ value: '2026-11-15', readAt: fresh, now: NOW }).afterLock?.toISOString(), '2026-11-16T00:00:00.000Z')
  assert.deepEqual(readStoredLockDate({ value: '', readAt: fresh, now: NOW }), { afterLock: null, lockUnknown: false })
  assert.deepEqual(readStoredLockDate({ value: null, readAt: null, now: NOW }), { afterLock: null, lockUnknown: false })
})

test('lock date: a stale read, a value with no read time, and an unparseable value are UNKNOWN (the despatch is not backdated)', () => {
  const stale = new Date(NOW.getTime() - (DESPATCH_LOCK_DATE_MAX_AGE_HOURS + 1) * 3_600_000).toISOString()
  assert.equal(readStoredLockDate({ value: '2026-11-15', readAt: stale, now: NOW }).lockUnknown, true)
  assert.equal(readStoredLockDate({ value: '', readAt: stale, now: NOW }).lockUnknown, true, 'an empty value last read long ago may have been locked since')
  assert.equal(readStoredLockDate({ value: '2026-11-15', readAt: null, now: NOW }).lockUnknown, true)
  assert.equal(readStoredLockDate({ value: 'not-a-day', readAt: new Date(NOW.getTime() - 1000).toISOString(), now: NOW }).lockUnknown, true)
})

test('an unknown lock books the despatch at the apply instant, named; a layer receipt floors the despatch (never COGS before the stock arrived)', () => {
  const unknown = resolveDespatchInstant({ requested: at('2026-11-19T23:50:00Z'), now: NOW, floors: { lockUnknown: true } })
  assert.equal(unknown.instant.getTime(), NOW.getTime())
  assert.equal(unknown.adjustedFor, 'LOCK_UNKNOWN')
  const receipt = resolveDespatchInstant({ requested: at('2026-11-18T10:00:00Z'), now: NOW, floors: { afterLayerReceipt: at('2026-11-19T09:00:00Z') } })
  assert.equal(receipt.instant.toISOString(), '2026-11-19T09:00:00.000Z')
  assert.equal(receipt.adjustedFor, 'BEFORE_RECEIPT')
})

// ---- the floors are read UNDER the snapshot lock ----------------------------------------------------------------------------------------------

test('the floors are read only AFTER the inventory snapshot floor lock is taken (shared), and the layer receipt is the latest among the layers FIFO takes', async () => {
  const calls: string[] = []
  const client = {
    $executeRaw: async (strings: TemplateStringsArray) => { calls.push(`lock:${strings.join('?')}`); return 1 },
    $queryRaw: async () => {
      calls.push('layers')
      // Oldest first: 2 @ Mon, 5 @ Tue, 9 @ Wed. A need of 6 takes Mon + Tue and never touches Wed.
      return [
        { remainingQty: 2, receivedAt: at('2026-11-16T00:00:00Z') },
        { remainingQty: 5, receivedAt: at('2026-11-17T00:00:00Z') },
        { remainingQty: 9, receivedAt: at('2026-11-18T00:00:00Z') },
      ]
    },
    setting: { findMany: async () => { calls.push('settings'); return [] } },
    inventorySnapshotRun: { findFirst: async () => { calls.push('run'); return null } },
    orderAllocation: { aggregate: async () => { calls.push('allocation'); return { _max: { createdAt: null } } } },
    salesOrder: { findUnique: async () => { calls.push('order'); return { createdAt: at('2026-11-01T00:00:00Z') } } },
  }
  const floors = await loadDespatchInstantFloors(client, { orderId: 'o', lineIds: ['l'], layerNeeds: [{ productId: 'p', warehouseId: 'w', qty: 6 }], now: NOW })
  assert.match(calls[0], /^lock:.*pg_advisory_xact_lock_shared/, 'the lock is the first thing taken')
  assert.ok(calls.slice(1).length >= 5 && !calls.slice(1).some((c) => c.startsWith('lock')))
  assert.equal(floors.afterLayerReceipt?.toISOString(), '2026-11-17T00:00:00.000Z')
  assert.equal(floors.lockUnknown, false)
})

// ---- MED2 / kit pin ---------------------------------------------------------------------------------------------------------------------------

type Line = { id: string; productId: string; sku: string; fulfillmentRequirements: unknown; product: { type: string } }
function client(lines: Line[], shipments: Array<{ status: string; lines: Array<{ lineId: string; productId: string; qty: number; product: { sku: string } }> }>) {
  return {
    shipment: { findMany: async () => shipments },
    salesOrderLine: { findMany: async () => lines },
  } as never
}
const simple = (id: string, sku: string, extra: Partial<Line> = {}): Line => ({ id: `l-${id}`, productId: id, sku, fulfillmentRequirements: null, product: { type: 'SIMPLE' }, ...extra })
const shipmentOf = (id: string, sku: string, qty: number) => ({ status: 'PACKED', lines: [{ lineId: `l-${id}`, productId: id, qty, product: { sku } }] })

test('MED2: a fully refunded line (an order line with no shipment row) that the warehouse despatched is a mismatch of 2 against 0', async () => {
  const verdict = await findDespatchQuantityMismatch(
    { orderId: 'o', wmsWarehouseId: null, wmsQuantities: [{ sku: 'SKU-C', qty: 4 }, { sku: 'SKU-D', qty: 2 }] },
    client([simple('pc', 'SKU-C'), simple('pd', 'SKU-D')], [shipmentOf('pc', 'SKU-C', 4)]),
  )
  assert.deepEqual(verdict, { status: 'MISMATCH', mismatches: [{ sku: 'SKU-D', wmsQty: 2, imsQty: 0 }] })
})

test('MED2: a SKU of a line IMS can never book (NON_INVENTORY, VARIABLE) is not a standing mismatch', async () => {
  const verdict = await findDespatchQuantityMismatch(
    { orderId: 'o', wmsWarehouseId: null, wmsQuantities: [{ sku: 'SKU-C', qty: 4 }, { sku: 'FEE', qty: 1 }] },
    client([simple('pc', 'SKU-C'), simple('pf', 'FEE', { product: { type: 'NON_INVENTORY' } })], [shipmentOf('pc', 'SKU-C', 4)]),
  )
  assert.deepEqual(verdict, { status: 'MATCH' })
  assert.deepEqual(compareDespatchQuantities([{ sku: 'FEE', qty: 1 }], [], { ignoreSkus: new Set(['fee']) }), [])
  assert.equal(compareDespatchQuantities([{ sku: 'FEE', qty: 1 }], []).length, 1, 'without the exclusion it is raised')
})

test('kit exclusion follows the PINNED recipe: a pin that expands elsewhere is a kit though the product is SIMPLE; a pin to itself is not, though the product is a KIT now', async () => {
  const pin = (productId: string, requirements: Array<{ productId: string; factor: string }>) => ({ version: 1, productId, graphVersion: 1, capturedAt: '2026-11-01T00:00:00.000Z', requirements })
  assert.equal(lineExpandsBeyondItself(simple('pk', 'KIT-1', { fulfillmentRequirements: pin('pk', [{ productId: 'comp', factor: '1' }]) })), true)
  assert.equal(lineExpandsBeyondItself(simple('ps', 'S-1', { product: { type: 'KIT' }, fulfillmentRequirements: pin('ps', [{ productId: 'ps', factor: '1' }]) })), false)
  assert.equal(lineExpandsBeyondItself(simple('pn', 'S-2', { product: { type: 'KIT' } })), true, 'no pin: the current type decides')
  assert.equal(lineExpandsBeyondItself(simple('pm', 'S-3')), false)
  // An unreadable pin is "cannot say", never a guess.
  const verdict = await findDespatchQuantityMismatch(
    { orderId: 'o', wmsWarehouseId: null, wmsQuantities: [{ sku: 'S-3', qty: 9 }] },
    client([simple('pm', 'S-3', { fulfillmentRequirements: { version: 99 } })], [shipmentOf('pm', 'S-3', 1)]),
  )
  assert.equal(verdict.status, 'NOT_COMPARABLE')
})

test('the operator exit is stated per direction, and the mismatch key is order- and case-stable', () => {
  assert.match(describeDespatchQuantityExit([{ sku: 'A', wmsQty: 4, imsQty: 3 }]), /MORE[^.]*stock adjustment/)
  assert.doesNotMatch(describeDespatchQuantityExit([{ sku: 'A', wmsQty: 4, imsQty: 3 }]), /FEWER/)
  assert.match(describeDespatchQuantityExit([{ sku: 'A', wmsQty: 2, imsQty: 3 }]), /FEWER[^.]*ship it by hand/)
  assert.equal(describeDespatchQuantityExit([{ sku: 'A', wmsQty: 4, imsQty: 3 }, { sku: 'B', wmsQty: 1, imsQty: 2 }]).includes('FEWER'), true)
  assert.equal(despatchQuantityMismatchKey([{ sku: 'B', wmsQty: 1, imsQty: 2 }, { sku: 'A', wmsQty: 4, imsQty: 3 }]), despatchQuantityMismatchKey([{ sku: 'A', wmsQty: 4, imsQty: 3 }, { sku: 'B', wmsQty: 1, imsQty: 2 }]))
})

// ---- MED3: the sweep keeps a hold ------------------------------------------------------------------------------------------------------------

const LONDON = 'europe-london' as const
function status(overrides: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'SO-5001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }], dispatched: true, raw: null,
    items: [{ sku: 'SKU-C', qty: 4 }], ...overrides,
  }
}
function deps(log: string[], overrides: Partial<WmsDispatchSweepDeps> = {}): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'SO-5001' }],
    fetchOrderStatus: async () => status({ items: undefined }),
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

test('MED3: a read with NO item rows while a quantity hold stands stays held: not applied, no error, no refusal that would overwrite the standing row', async () => {
  const log: string[] = []
  const outcome = await reconcileOneOrder(deps(log, { hasOpenQuantityHold: async () => true }), candidate, status({ items: undefined }))
  assert.equal(outcome.action, 'pending')
  assert.equal(outcome.refusal, undefined)
  assert.equal(outcome.unresolved, undefined)
  assert.deepEqual(log, [], 'never applied on IMS\'s own quantities')
})

test('MED3: with no standing hold (or no way to ask) a read with no item rows applies as before; a read WITH items is compared as before', async () => {
  const none: string[] = []
  assert.equal((await reconcileOneOrder(deps(none, { hasOpenQuantityHold: async () => false }), candidate, status({ items: undefined }))).action, 'dispatched')
  assert.deepEqual(none, ['apply'])
  const absent: string[] = []
  assert.equal((await reconcileOneOrder(deps(absent), candidate, status({ items: undefined }))).action, 'dispatched')
  const withItems: string[] = []
  assert.equal((await reconcileOneOrder(deps(withItems, { hasOpenQuantityHold: async () => true }), candidate, status({}))).action, 'dispatched', 'items present: the apply does the comparing')
})

test('MED3 / LOW: only a DESPATCH closes the standing quantity row; a held pending pass does not (it would reopen as a new episode and restart the 2-hour alert)', async () => {
  const resolved: unknown[] = []
  await runWmsDispatchSweepCore(deps([], { hasOpenQuantityHold: async () => true, resolveRefusedActions: async (_id, outcome) => { resolved.push(outcome) } }))
  assert.deepEqual(resolved, [{ dispatched: false }])
  const afterDespatch: unknown[] = []
  await runWmsDispatchSweepCore(deps([], { fetchOrderStatus: async () => status({}), resolveRefusedActions: async (_id, outcome) => { afterDespatch.push(outcome) } }))
  assert.deepEqual(afterDespatch, [{ dispatched: true }])
})

test('LOW: the split path decides the hold BEFORE any partial shipment is pushed to the storefront', async () => {
  const log: string[] = []
  const parts: WmsOrderPart[] = [
    { externalId: 'P1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T1', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }] },
    { externalId: 'P2', partNumber: 2, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T2', carrier: 'DPD', despatchedAt: '2026-11-19T11:00:00' }] },
  ]
  const outcome = await reconcileOneOrder(deps(log, {
    fetchOrderParts: async () => parts,
    fetchPartItems: async (id) => { log.push(`read:${id}`); return id === 'P1' ? [{ sku: 'SKU-C', qty: 3 }] : [{ sku: 'SKU-C', qty: 1 }] },
    previewQuantityMismatch: async (_o, quantities) => { log.push(`preview:${JSON.stringify(quantities)}`); return { error: 'SKU-C: warehouse despatched 4, IMS books 3', mismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }] } },
  }), candidate, status({ isSplit: true, partCount: 2, items: undefined }))
  assert.equal(outcome.action, 'pending')
  assert.equal(outcome.refusal?.action, 'WMS_DESPATCH_QUANTITY')
  assert.deepEqual(log, ['read:P1', 'read:P2', 'preview:[{"sku":"SKU-C","qty":4}]'], 'no push, no apply: a partial shipment e-mails the customer and cannot be taken back')
  // Not held: the pushes happen, then the apply, in that order.
  const ok: string[] = []
  await reconcileOneOrder(deps(ok, {
    fetchOrderParts: async () => parts,
    fetchPartItems: async () => [{ sku: 'SKU-C', qty: 2 }],
    previewQuantityMismatch: async () => null,
  }), candidate, status({ isSplit: true, partCount: 2, items: undefined }))
  assert.deepEqual(ok, ['push', 'push', 'apply'])
})

// ---- MED5: readiness warning ------------------------------------------------------------------------------------------------------------------

test('MED5: readiness warns when the despatch-date switch is on and the snapshot job is off, and only then', () => {
  const warned = classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: false, effective: false })
  assert.equal(warned.length, 1)
  assert.equal(warned[0].severity, 'warning')
  assert.equal(warned[0].id, 'wms-despatch-date:snapshot-cron-disabled')
  assert.deepEqual(classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true }), [])
  assert.deepEqual(classifyDespatchDatePrerequisite({ switchOn: false, snapshotCronEnabled: false, effective: false }), [])
  assert.deepEqual(classifyDespatchDatePrerequisite(null), [])
})

// ---- #1095 R1 ---------------------------------------------------------------------------------------------------------------------------------

test('R1 MED1: an EMPTY item list, or all-zero quantities, is read like no items while a hold stands: never applied on IMS quantities', async () => {
  for (const items of [[], [{ sku: 'SKU-C', qty: 0 }]]) {
    const log: string[] = []
    const outcome = await reconcileOneOrder(deps(log, { hasOpenQuantityHold: async () => true }), candidate, status({ items }))
    assert.equal(outcome.action, 'pending', JSON.stringify(items))
    assert.deepEqual(log, [])
  }
})

test('R1 MED3: a hold whose IMS side was corrected releases itself: the next read with no items re-checks against the quantities last reported', async () => {
  const seen: unknown[] = []
  const withStored = deps([], {
    hasOpenQuantityHold: async () => true,
    standingDespatchedQuantities: async () => [{ sku: 'SKU-C', qty: 3 }],
    applyDispatch: async (_o, _t, options) => { seen.push(options?.despatchedQuantities); return { success: true } },
  })
  const outcome = await reconcileOneOrder(withStored, candidate, status({ items: undefined }))
  assert.equal(outcome.action, 'dispatched')
  assert.deepEqual(seen, [[{ sku: 'SKU-C', qty: 3 }]], 'the apply compares IMS with what the warehouse last reported, so it applies only when they now match')
  // Nothing stored (a row from before they were): stays held.
  const log: string[] = []
  assert.equal((await reconcileOneOrder(deps(log, { hasOpenQuantityHold: async () => true, standingDespatchedQuantities: async () => null }), candidate, status({ items: undefined }))).action, 'pending')
  assert.deepEqual(log, [])
  // The standing row keeps the despatched quantities.
  const refusals: Array<{ intent: unknown }> = []
  await runWmsDispatchSweepCore(deps([], {
    fetchOrderStatus: async () => status({}),
    applyDispatch: async () => ({ success: false, error: 'x', refusal: 'despatch_quantity_mismatch', quantityMismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }], despatchedQuantities: [{ sku: 'SKU-C', qty: 4 }] }),
    recordRefusedAction: async (_c, refusal) => { refusals.push(refusal as never) },
  }))
  assert.deepEqual((refusals[0].intent as { despatched?: unknown }).despatched, [{ sku: 'SKU-C', qty: 4 }])
})

test('R1 LOW: a line on the ignore list never hides the SKU of a product IMS really books; the product SKU is added to the list', async () => {
  // A VARIABLE line whose sku equals the booked product's sku: the warehouse units for that SKU are still compared.
  const verdict = await findDespatchQuantityMismatch(
    { orderId: 'o', wmsWarehouseId: null, wmsQuantities: [{ sku: 'SKU-C', qty: 4 }] },
    client([simple('pc', 'SKU-C'), simple('pv', 'SKU-C', { product: { type: 'VARIABLE' } })], [shipmentOf('pc', 'SKU-C', 3)]),
  )
  assert.deepEqual(verdict, { status: 'MISMATCH', mismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }] })
  // A service line the warehouse lists under the PRODUCT's sku (not the line's) is ignored too.
  const service = await findDespatchQuantityMismatch(
    { orderId: 'o', wmsWarehouseId: null, wmsQuantities: [{ sku: 'SKU-C', qty: 3 }, { sku: 'FEE-PRODUCT', qty: 1 }] },
    client([simple('pc', 'SKU-C'), { ...simple('pf', 'FEE-LINE', { product: { type: 'NON_INVENTORY', sku: 'FEE-PRODUCT' } as never }) }], [shipmentOf('pc', 'SKU-C', 3)]),
  )
  assert.deepEqual(service, { status: 'MATCH' })
})

test('R1 LOW: a stale lock date read raises its own readiness warning while the switch is effective', () => {
  const warned = classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true, lockDateStale: true })
  assert.equal(warned[0]?.id, 'wms-despatch-date:lock-date-stale')
  assert.deepEqual(classifyDespatchDatePrerequisite({ switchOn: true, snapshotCronEnabled: true, effective: true, lockDateStale: false }), [])
})
