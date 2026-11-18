import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Mixed-warehouse scoped despatch (flag `wms_mixed_warehouse_push_enabled`): a warehouse despatch ships ONLY the warehouse's own shipments, once per scope
 * version, and refuses (retryably, as a scope mismatch) when the part sent no longer matches IMS. A storefront 'completed' echo is ignored while the
 * warehouse's part is open. Mocked: no database, no network.
 */
type Row = Record<string, unknown>
const state = {
  flag: true,
  order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED' } as Row,
  link: null as Row | null,
  scopeLines: [] as Row[],
  currentScope: null as Row | null,
  shipments: [] as Row[],
  wmsAllocations: [] as Row[],
  applications: [] as Row[],
  transitions: [] as Array<[string, string]>,
  activity: [] as Row[],
  confirmCalls: 0,
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) }, logActivityPersisted: async () => true } })
mock.module('@/lib/domain/wms/mixed-scope-flag', { namedExports: { isMixedWarehousePushEnabled: async () => state.flag } })
mock.module('@/lib/domain/wms/mixed-scope-loader', { namedExports: { loadMixedScopeForOrder: async () => (state.currentScope ? { ...state.currentScope } : null) } })
const dbMock = {
  wmsOrderPushLink: {
    findUnique: async () => (state.link ? { ...state.link } : null),
    update: async ({ data }: { data: Row }) => { Object.assign(state.link ?? {}, data) },
  },
  wmsOrderPushScopeLine: { findMany: async () => state.scopeLines.map((row) => ({ ...row })) },
  wmsDespatchApplication: {
    findUnique: async ({ where }: { where: { idempotencyKey: string } }) => state.applications.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (state.applications.some((row) => row.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error('unique'), { code: 'P2002' })
      state.applications.push({ ...data })
    },
  },
  salesOrder: { findUnique: async () => ({ ...state.order, shipFromWarehouseId: 'wh-wms' }), findFirst: async () => ({ ...state.order }) },
  salesOrderLine: { findMany: async () => [] },
  shipmentLine: { findMany: async () => [] },
  salesOrderRefundLine: { findMany: async () => [] },
  stockMovement: { findMany: async () => [] },
  orderAllocation: { count: async () => 1, findMany: async () => state.wmsAllocations.map((row) => ({ ...row })) },
  shipment: { count: async () => state.shipments.length, findMany: async () => state.shipments.map((row) => ({ ...row })) },
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(dbMock),
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })
mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1, unallocatedQty: 0 }),
    confirmAllocations: async () => { state.confirmCalls += 1; return { success: true } },
    updateShipmentStatus: async (shipmentId: string, target: string) => { state.transitions.push([shipmentId, target]); return { success: true } },
  },
})
mock.module('@/lib/products/kit-fulfillment', { namedExports: { loadFulfillmentProductGraph: async () => new Map(), expandFulfillmentRequirementsDecimal: () => [] } })

const WMS_SHIPMENT = { id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms', lines: [{ lineId: 'l1', productId: 'p1', qty: '1.0000' }] }
const OWN_SHIPMENT = { id: 'shp-own', status: 'PENDING', warehouseId: 'wh-own', lines: [{ lineId: 'l2', productId: 'p2', qty: '1.0000' }] }

function reset() {
  state.flag = true
  state.order = { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED' }
  state.link = { id: 'link-1', scopeMode: 'MIXED', scopeVersion: 2, pushWarehouseId: 'wh-wms', despatchSettledAt: null, scopeFrozenAt: null, state: 'SYNCED' }
  state.scopeLines = [{ orderLineId: 'l1', quantity: '1.0000' }]
  state.currentScope = { mode: 'MIXED', lines: [{ lineId: 'l1', quantity: 1 }] }
  state.shipments = [{ ...WMS_SHIPMENT }, { ...OWN_SHIPMENT }]
  state.wmsAllocations = [{ lineId: 'l1', productId: 'p1', qty: '1.0000' }]
  state.applications = []
  state.transitions = []
  state.activity = []
  state.confirmCalls = 0
}

async function apply(source: 'mintsoft' | 'woocommerce') {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({ source, lookup: { orderId: 'so-1' }, targetShipmentStatus: 'SHIPPED', tracking: [{ trackingNumber: 'TRK1' }] })
}

test('a scoped despatch ships only the warehouse\'s own shipments, leaves the other warehouse open, and records the application once', async () => {
  reset()
  const result = await apply('mintsoft')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions.filter(([, target]) => target === 'SHIPPED').map(([id]) => id), ['shp-wms'])
  assert.equal(state.transitions.some(([id]) => id === 'shp-own'), false)
  assert.equal(state.applications.length, 1)
  assert.equal(state.applications[0].idempotencyKey, 'link-1:2')
  assert.ok(state.link?.despatchSettledAt instanceof Date, 'the link is settled so polling stops')
})

test('a replayed scoped despatch is a no-op (idempotency key and settled link)', async () => {
  reset()
  await apply('mintsoft')
  state.transitions = []
  const again = await apply('mintsoft')
  assert.deepEqual(again, { success: true, noop: true })
  assert.deepEqual(state.transitions, [])
  assert.equal(state.applications.length, 1)
  // even with the settled stamp lost, the application row alone stops a second apply
  state.link = { ...(state.link as Row), despatchSettledAt: null }
  assert.deepEqual(await apply('mintsoft'), { success: true, noop: true })
  assert.deepEqual(state.transitions, [])
})

test('a concurrent apply that loses the insert race is a success, not a failure', async () => {
  reset()
  state.applications.push({ idempotencyKey: 'other', linkId: 'link-1' })
  const create = dbMock.wmsDespatchApplication.create
  dbMock.wmsDespatchApplication.create = async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }) }
  try {
    assert.deepEqual(await apply('mintsoft'), { success: true })
  } finally {
    dbMock.wmsDespatchApplication.create = create
  }
})

test('the scope IMS holds now differs from the part sent: refused as a scope mismatch (retryable), nothing shipped', async () => {
  reset()
  state.currentScope = { mode: 'MIXED', lines: [{ lineId: 'l1', quantity: 2 }] }
  const result = await apply('mintsoft')
  assert.equal(result.success, false)
  assert.equal((result as { refusal?: string }).refusal, 'wms_scope_mismatch')
  assert.equal((result as { permanent?: boolean }).permanent, false)
  assert.deepEqual(state.transitions, [])
  assert.equal(state.applications.length, 0)
  assert.ok(state.activity.some((entry) => entry.action === 'external_fulfillment_scope_mismatch'))
})

test('the order is no longer mixed (scope HOLD / FULL): scope mismatch', async () => {
  for (const mode of ['HOLD', 'FULL']) {
    reset()
    state.currentScope = { mode }
    const result = await apply('mintsoft')
    assert.equal((result as { refusal?: string }).refusal, 'wms_scope_mismatch', mode)
  }
})

test('the warehouse\'s shipments do not hold exactly the warehouse\'s allocations: scope mismatch, nothing shipped', async () => {
  reset()
  state.wmsAllocations = [{ lineId: 'l1', productId: 'p1', qty: '2.0000' }]
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_scope_mismatch')
  assert.deepEqual(state.transitions, [])
})

test('no shipments yet: they are created from the allocations, then only the warehouse\'s are shipped', async () => {
  reset()
  state.shipments = []
  const realFindMany = dbMock.shipment.findMany
  let reads = 0
  dbMock.shipment.findMany = async () => { reads += 1; return reads === 1 ? [] : [{ ...WMS_SHIPMENT }, { ...OWN_SHIPMENT }] }
  try {
    assert.deepEqual(await apply('mintsoft'), { success: true })
  } finally {
    dbMock.shipment.findMany = realFindMany
  }
  assert.equal(state.confirmCalls, 1)
  assert.deepEqual(state.transitions.filter(([, target]) => target === 'SHIPPED').map(([id]) => id), ['shp-wms'])
})

test('Q6: a storefront completed echo while the warehouse part is open is ignored with a permanent refusal; nothing is shipped', async () => {
  reset()
  const result = await apply('woocommerce')
  assert.equal(result.success, false)
  assert.equal((result as { refusal?: string }).refusal, 'wms_part_open')
  assert.equal((result as { permanent?: boolean }).permanent, true, 'acknowledged, and recorded as an exception by the completion flow')
  assert.deepEqual(state.transitions, [])
  assert.ok(state.activity.some((entry) => entry.action === 'external_fulfillment_completion_echo_ignored'))
})

test('once the warehouse part is settled, a storefront completion proceeds as before (ships the rest)', async () => {
  reset()
  state.link = { ...(state.link as Row), despatchSettledAt: new Date() }
  state.shipments = [{ ...WMS_SHIPMENT, status: 'SHIPPED' }, { ...OWN_SHIPMENT }]
  const result = await apply('woocommerce')
  assert.deepEqual(result, { success: true })
  assert.ok(state.transitions.length > 0 && state.transitions.every(([id]) => id === 'shp-own'), 'only the remaining shipment is driven')
  assert.equal(state.transitions.at(-1)?.[1], 'SHIPPED')
})

test('FLAG OFF, link NOT pushed as a part: behaviour is development\'s - refused as foreign shipments; a storefront echo is not ignored', async () => {
  reset()
  state.flag = false
  state.link = { ...(state.link as Row), scopeMode: null }
  const refused = await apply('mintsoft')
  assert.equal((refused as { refusal?: string }).refusal, 'wms_other_warehouse_shipments')
  assert.deepEqual(state.transitions, [])
  state.shipments = [{ ...OWN_SHIPMENT, status: 'PACKED' }]
  const echo = await apply('woocommerce')
  assert.deepEqual(echo, { success: true })
})

test('FLAG OFF, link pushed as a part: the despatch is still scoped (the link\'s data decides, so a rollback cannot ship the whole order)', async () => {
  reset()
  state.flag = false
  assert.deepEqual(await apply('mintsoft'), { success: true })
  assert.deepEqual(state.transitions.filter(([, target]) => target === 'SHIPPED').map(([id]) => id), ['shp-wms'])
})

test('a settled part is a no-op even with the flag off and however the link is recorded (no second apply, no repeated event)', async () => {
  reset()
  state.flag = false
  state.link = { ...(state.link as Row), scopeMode: null, despatchSettledAt: new Date() }
  const result = await apply('mintsoft')
  assert.deepEqual(result, { success: true, noop: true })
  assert.deepEqual(state.transitions, [])
})

test('the way out of a mismatch: every warehouse shipment already shipped by hand records the despatch and settles the link', async () => {
  reset()
  state.currentScope = { mode: 'HOLD' }
  state.shipments = [{ ...WMS_SHIPMENT, status: 'SHIPPED' }, { ...OWN_SHIPMENT }]
  assert.deepEqual(await apply('mintsoft'), { success: true })
  assert.equal(state.applications.length, 1)
  assert.deepEqual(state.transitions, [])
  assert.ok(state.link?.despatchSettledAt instanceof Date)
})

test('the mismatch text names the real fix', async () => {
  reset()
  state.currentScope = { mode: 'MIXED', lines: [{ lineId: 'l1', quantity: 2 }] }
  const result = await apply('mintsoft')
  assert.match((result as { error?: string }).error ?? '', /ship the warehouse's shipment\(s\) for the order in IMS by hand/)
})

test('a FROZEN link recorded FULL is guarded against double shipping while a warehouse shipment is open', async () => {
  reset()
  state.link = { ...(state.link as Row), scopeMode: 'FULL', scopeFrozenAt: new Date() }
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_scope_mismatch')
  assert.deepEqual(state.transitions, [])
})

test('a link recorded FULL whose order is now split (flag on) is refused while a warehouse shipment is open', async () => {
  reset()
  state.link = { ...(state.link as Row), scopeMode: 'FULL' }
  state.currentScope = { mode: 'MIXED', lines: [{ lineId: 'l1', quantity: 1 }] }
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_scope_mismatch')
  state.currentScope = { mode: 'FULL' }
  state.shipments = [{ ...WMS_SHIPMENT }]
  assert.deepEqual(await apply('mintsoft'), { success: true }, 'a still-FULL order ships normally')
})

test('an order held in IMS (not ready) with a MIXED link does not bypass the scoped path', async () => {
  reset()
  state.order.status = 'ON_HOLD'
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'order_not_ready_to_ship')
  assert.deepEqual(state.transitions, [])
})

test('a link that is not MIXED (FULL or unscoped) is the ordinary path even with the flag on', async () => {
  reset()
  state.link = { ...(state.link as Row), scopeMode: 'FULL' }
  state.currentScope = { mode: 'FULL' }
  state.shipments = [{ ...WMS_SHIPMENT }]
  assert.deepEqual(await apply('mintsoft'), { success: true })
  assert.equal(state.applications.length, 0)
})

test('a storefront completed echo on a MIXED link whose warehouse order is held or cancelled is the ordinary completion (no open warehouse part)', async () => {
  for (const linkState of ['HELD', 'CANCELLED', 'PENDING_CREATE']) {
    reset()
    state.link = { ...(state.link as Row), state: linkState }
    state.shipments = [{ ...OWN_SHIPMENT, status: 'PACKED' }]
    assert.deepEqual(await apply('woocommerce'), { success: true }, linkState)
  }
})
