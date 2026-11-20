import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.115 through applyExternalFulfillmentUpdate. The bead's own scenario: SO-5001 ordered 4 x SKU-C, a refund of 1 with no restock, the
 * warehouse amendment refused as NOT_NEW, so IMS demand net of the refund is 3 and its one shipment holds 3, while Mintsoft despatches 4.
 * The coverage check passes (3 covers 3); the despatch used to apply and relieve 3, leaving on-hand overstated by 1. It must be HELD.
 * Mocked: no database, no network.
 */
type Row = Record<string, unknown>
const state = {
  shipments: [] as Row[],
  orderLines: [] as Row[],
  transitions: [] as Array<{ id: string; target: string; options: Row }>,
  activity: [] as Row[],
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) }, logActivityPersisted: async () => true } })
mock.module('@/lib/storefront-customer-email', { namedExports: { queueStorefrontPartialShipmentEmailsAfterBatch: async () => undefined } })
mock.module('@/lib/domain/wms/mixed-scope-flag', { namedExports: { isMixedWarehousePushEnabled: async () => false } })
mock.module('@/lib/domain/wms/mixed-scope-loader', { namedExports: { loadMixedScopeForOrder: async () => null } })
const dbMock = {
  wmsOrderPushLink: { findUnique: async () => null },
  wmsDespatchApplication: { findUnique: async () => null },
  salesOrder: { findUnique: async () => ({ id: 'so-5001', orderNumber: 'SO-5001', externalOrderNumber: 'SO-5001', status: 'ALLOCATED', shipFromWarehouseId: 'wh-wms' }) },
  salesOrderLine: { findMany: async () => state.orderLines.map((row) => ({ ...row })) },
  // 4 ordered, 1 refunded without a restock: demand is 3.
  salesOrderRefundLine: { findMany: async () => [{ salesOrderLineId: 'l1', productId: 'p-c', qty: 1, refundId: 'r1', refund: { returnWarehouseId: null, chargeback: false, accountingRetryRequired: false } }] },
  stockMovement: { findMany: async () => [] },
  shipmentLine: { findMany: async () => state.shipments.flatMap((shipment) => (shipment.lines as Row[]).map((line) => ({ ...line }))) },
  orderAllocation: { count: async () => 1 },
  shipment: { count: async () => state.shipments.length, findMany: async () => state.shipments.map((row) => ({ ...row })) },
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })
mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1, unallocatedQty: 0 }),
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (id: string, target: string, _extra: unknown, options: Row) => { state.transitions.push({ id, target, options }); return { success: true } },
  },
})
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => new Map(),
    expandFulfillmentRequirementsDecimal: (productId: string, qty: unknown) => new Map([[productId, qty]]),
  },
})

function reset(shippedQty: number, status = 'PACKED') {
  state.orderLines = [{ id: 'l1', productId: 'p-c', qty: 4, sku: 'SKU-C', description: 'C', fulfillmentRequirements: null, product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status, warehouseId: 'wh-wms', lines: [{ lineId: 'l1', productId: 'p-c', qty: String(shippedQty), product: { sku: 'SKU-C' } }] }]
  state.transitions = []
  state.activity = []
}

async function apply(despatchedQuantities?: Array<{ sku: string; qty: number }>, extra: Row = {}) {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({
    source: 'mintsoft', lookup: { orderId: 'so-5001' }, targetShipmentStatus: 'SHIPPED', tracking: [{ trackingNumber: 'TRK1' }],
    ...(despatchedQuantities ? { despatchedQuantities } : {}), ...extra,
  } as never)
}

test('SO-5001: Mintsoft despatched 4, IMS books 3 (demand net of the refund is 3 and the shipment covers it): HELD, nothing shipped, both quantities named', async () => {
  reset(3)
  const result = await apply([{ sku: 'SKU-C', qty: 4 }])
  assert.equal(result.success, false)
  const refused = result as { refusal?: string; error?: string; permanent?: boolean; quantityMismatches?: unknown }
  assert.equal(refused.refusal, 'despatch_quantity_mismatch')
  assert.equal(refused.permanent, false, 'retryable: it clears when the order is corrected or shipped by hand')
  assert.deepEqual(refused.quantityMismatches, [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }])
  assert.match(refused.error ?? '', /SKU-C: warehouse despatched 4, IMS books 3/)
  assert.deepEqual(state.transitions, [], 'no shipment is driven to SHIPPED, so on-hand is not relieved by 3')
  assert.ok(state.activity.some((entry) => entry.action === 'external_fulfillment_quantity_mismatch' && entry.level === 'WARNING'))
})

test('the same order despatched at 3 (the quantities agree) applies normally', async () => {
  reset(3)
  const result = await apply([{ sku: 'SKU-C', qty: 3 }])
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions.map((t) => t.target), ['SHIPPED'])
})

test('an under-despatch (Mintsoft sent 2, IMS books 3) is held as well', async () => {
  reset(3)
  const result = await apply([{ sku: 'SKU-C', qty: 2 }])
  assert.equal((result as { refusal?: string }).refusal, 'despatch_quantity_mismatch')
  assert.deepEqual(state.transitions, [])
})

test('with no quantities supplied (the switch is off, or the connector could not say) nothing is compared: the despatch applies as it always did', async () => {
  reset(3)
  assert.deepEqual(await apply(undefined), { success: true })
  assert.equal(state.transitions.length, 1)
})

test('the way out: when every shipment in the warehouse is already shipped (by hand) the despatch is not held on a standing mismatch', async () => {
  reset(3, 'SHIPPED')
  assert.deepEqual(await apply([{ sku: 'SKU-C', qty: 4 }]), { success: true })
})

test('a storefront-sourced completion is never compared (a warehouse despatch is the only evidence of units)', async () => {
  reset(3)
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  // Not a WMS connector: the quantities (which a storefront caller never sends) would be ignored even if present.
  const result = await applyExternalFulfillmentUpdate({ source: 'woocommerce', lookup: { orderId: 'so-5001' }, targetShipmentStatus: 'SHIPPED', despatchedQuantities: [{ sku: 'SKU-C', qty: 4 }] } as never)
  assert.notEqual((result as { refusal?: string }).refusal, 'despatch_quantity_mismatch')
})

test('the warehouse despatch time is handed to every shipment transition; a storefront source never passes one', async () => {
  reset(3)
  const despatchedAt = new Date('2026-11-19T22:50:00Z')
  await apply([{ sku: 'SKU-C', qty: 3 }], { despatchedAt })
  assert.equal((state.transitions[0].options as { despatchedAt?: Date }).despatchedAt?.getTime(), despatchedAt.getTime())
  reset(3)
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  await applyExternalFulfillmentUpdate({ source: 'woocommerce', lookup: { orderId: 'so-5001' }, targetShipmentStatus: 'SHIPPED', despatchedAt } as never)
  assert.equal((state.transitions[0]?.options as { despatchedAt?: Date } | undefined)?.despatchedAt, undefined)
})
