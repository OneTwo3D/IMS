import assert from 'node:assert/strict'
import test from 'node:test'

import { compareDespatchQuantities, describeDespatchQuantityMismatch } from '../lib/fulfillment/despatch-quantity-check.ts'
import { reconcileOneOrder, runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderPart, WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * o3d-hqvrp.115: the units the warehouse despatched are compared with the units IMS books. EXACT, per SKU, over and under; a difference holds the
 * despatch as a standing refused action carrying both quantities. Pure and sweep-level: no database, no network.
 */
const ims = (rows: Array<[string, string[], number]>) => rows.map(([productId, skus, qty]) => ({ productId, skus, qty }))

test('SO-5001: 4 x SKU-C despatched, IMS books 3 (a refund of 1 with no restock, the amendment refused as NOT_NEW): a mismatch of 4 against 3', () => {
  const mismatches = compareDespatchQuantities([{ sku: 'SKU-C', qty: 4 }], ims([['p-c', ['SKU-C'], 3]]))
  assert.deepEqual(mismatches, [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }])
  assert.equal(describeDespatchQuantityMismatch(mismatches), 'SKU-C: warehouse despatched 4, IMS books 3')
})

test('an exact match books nothing to raise; SKUs match ignoring case and spacing', () => {
  assert.deepEqual(compareDespatchQuantities([{ sku: ' sku-c ', qty: 3 }, { sku: 'SKU-D', qty: 2 }], ims([['p-c', ['SKU-C'], 3], ['p-d', ['SKU-D'], 2]])), [])
})

test('under-despatch is a mismatch too (a short despatch with no split)', () => {
  assert.deepEqual(compareDespatchQuantities([{ sku: 'SKU-C', qty: 2 }], ims([['p-c', ['SKU-C'], 3]])), [{ sku: 'SKU-C', wmsQty: 2, imsQty: 3 }])
})

test('a SKU the warehouse sent that IMS does not book (substitution), and a SKU IMS books that the warehouse did not send, are both raised', () => {
  const mismatches = compareDespatchQuantities([{ sku: 'SKU-X', qty: 1 }], ims([['p-c', ['SKU-C'], 1]]))
  assert.deepEqual(mismatches, [{ sku: 'SKU-C', wmsQty: 0, imsQty: 1 }, { sku: 'SKU-X', wmsQty: 1, imsQty: 0 }])
})

test('a product known by its earlier or current SKU matches whichever the warehouse sent; one line listed twice is summed', () => {
  assert.deepEqual(compareDespatchQuantities([{ sku: 'OLD-C', qty: 1 }, { sku: 'OLD-C', qty: 2 }], ims([['p-c', ['SKU-C', 'OLD-C'], 3]])), [])
})

test('no tolerance: a difference of one unit in a hundred is still a mismatch', () => {
  assert.equal(compareDespatchQuantities([{ sku: 'A', qty: 100 }], ims([['p', ['A'], 99]])).length, 1)
})

const LONDON = 'europe-london' as const
function status(overrides: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'SO-5001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }], dispatched: true, raw: null,
    items: [{ sku: 'SKU-C', qty: 4 }], ...overrides,
  }
}
type Applied = { options: { despatchedQuantities?: Array<{ sku: string; qty: number }> } | undefined }
function deps(applied: Applied[], overrides: Partial<WmsDispatchSweepDeps> = {}): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'SO-5001' }],
    fetchOrderStatus: async () => status({}),
    applyDispatch: async (_orderId, _tracking, options) => { applied.push({ options: options as Applied['options'] }); return { success: true } },
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
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

test('an ordinary order hands its item rows to the apply as the despatched units (no extra read)', async () => {
  const applied: Applied[] = []
  await reconcileOneOrder(deps(applied), candidate, status({}))
  assert.deepEqual(applied[0].options?.despatchedQuantities, [{ sku: 'SKU-C', qty: 4 }])
})

test('a record with no item rows, and a merged survivor, send no quantities (nothing is compared)', async () => {
  const none: Applied[] = []
  await reconcileOneOrder(deps(none), candidate, status({ items: undefined }))
  assert.equal(none[0].options?.despatchedQuantities, undefined)
  const merged: Applied[] = []
  await reconcileOneOrder(deps(merged), candidate, status({ isMerged: true, mergedOrderNumbers: ['SO-5001', 'SO-5002'] }))
  assert.equal(merged[0].options?.despatchedQuantities, undefined)
})

test('a split order sums the items of its despatched parts, read once each (the reads the storefront push already makes)', async () => {
  const applied: Applied[] = []
  const reads: string[] = []
  const parts: WmsOrderPart[] = [
    { externalId: 'P1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T1', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }] },
    { externalId: 'P2', partNumber: 2, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T2', carrier: 'DPD', despatchedAt: '2026-11-19T11:00:00' }] },
  ]
  await reconcileOneOrder(deps(applied, {
    fetchOrderParts: async () => parts,
    fetchPartItems: async (id) => { reads.push(id); return id === 'P1' ? [{ sku: 'SKU-C', qty: 3 }] : [{ sku: 'SKU-C', qty: 1 }, { sku: 'SKU-D', qty: 1 }] },
  }), candidate, status({ isSplit: true, partCount: 2, items: undefined }))
  assert.deepEqual(reads, ['P1', 'P2'])
  assert.deepEqual(applied[0].options?.despatchedQuantities, [{ sku: 'SKU-C', qty: 4 }, { sku: 'SKU-D', qty: 1 }])
})

const mismatchResult = { success: false, error: 'SKU-C: warehouse despatched 4, IMS books 3', refusal: 'despatch_quantity_mismatch', quantityMismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }] }

test('a held quantity mismatch is pending, not an error: nothing counted against the link, a HIGH refusal records both quantities', async () => {
  const errors: string[] = []
  const refusals: Array<{ gate: string; severity: string; permanence: string; action: string; intent: unknown }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps([], {
    applyDispatch: async () => mismatchResult,
    recordDispatchError: async (_c, reason) => { errors.push(reason); return { deadLettered: false } },
    recordRefusedAction: async (_c, refusal) => { refusals.push(refusal as never) },
  }))
  assert.deepEqual(errors, [])
  assert.equal(counters.errors, 0)
  assert.equal(counters.dispatched, 0)
  assert.equal(refusals.length, 1)
  assert.deepEqual({ gate: refusals[0].gate, severity: refusals[0].severity, permanence: refusals[0].permanence, action: refusals[0].action }, { gate: 'WMS_QUANTITY_MISMATCH', severity: 'HIGH', permanence: 'RETRYABLE', action: 'WMS_DESPATCH_QUANTITY' })
  assert.deepEqual(refusals[0].intent, { mismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }] })
  assert.equal(logs[0].action, 'pending')
  assert.match(logs[0].reason, /despatched 4, IMS books 3/)
})

test('the held outcome does not hold the connector-wide watermark, and the standing row is closed once the order despatches', async () => {
  const held = await reconcileOneOrder(deps([], { applyDispatch: async () => mismatchResult }), candidate, status({}))
  assert.equal(held.holdWatermark, undefined)
  assert.equal(held.unresolved, undefined)
  const resolved: string[] = []
  await runWmsDispatchSweepCore(deps([], { resolveRefusedActions: async (orderId) => { resolved.push(orderId) } }))
  assert.deepEqual(resolved, ['o1'], 'a despatch that applies closes any standing refusal')
})

test('the real apply dependency sends the despatch time and the quantities only while their switches are on (source-level pin; both OFF by default)', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../lib/domain/wms/dispatch-sweep.ts', import.meta.url), 'utf8')
  const body = text.slice(text.indexOf('async applyDispatch(orderId, tracking, options)'), text.indexOf('partsSupported: Boolean(connector.fetchOrderParts)'))
  assert.match(body, /isWmsDespatchDateEnabled\(\)/)
  assert.match(body, /isWmsDespatchQuantityCheckEnabled\(\)/)
  assert.match(body, /datedByWarehouse && options\?\.despatchedAt \? \{ despatchedAt/)
  assert.match(body, /quantityChecked && options\?\.despatchedQuantities \? \{ despatchedQuantities/)
  const flags = readFileSync(new URL('../lib/domain/wms/despatch-flags.ts', import.meta.url), 'utf8')
  assert.match(flags, /=== 'true'/)
})

test('without passDespatchFacts the apply is called exactly as it was before either fix existed; the production dependencies set it', async () => {
  const applied: Applied[] = []
  await reconcileOneOrder(deps(applied, { passDespatchFacts: undefined }), candidate, status({}))
  assert.equal(applied[0].options, undefined)
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../lib/domain/wms/dispatch-sweep.ts', import.meta.url), 'utf8')
  assert.match(text, /zonelessDespatchReading: getWmsConnectorHooks\(connectorId\)\.zonelessDespatchReading\?\.\(\),\n\s+passDespatchFacts: true,/)
})
