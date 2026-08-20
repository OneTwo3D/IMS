import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xnwu, second half: every refusal now leaves a record ON THE ORDER, and says
 * WHY in a form a caller can act on.
 *
 * Three of these returned a bare string to a caller that discarded it. The stock
 * refusal in particular — "External fulfillment requires physical stock — order
 * has N unit(s) on backorder" — produced no activity row at all, so an order the
 * storefront showed as completed simply sat unfulfilled with nothing anywhere
 * recording that it had been refused.
 */

type LoggedActivity = {
  action?: string
  level?: string
  entityId?: string | null
  description?: string
  metadata?: Record<string, unknown>
}

const activityLog: LoggedActivity[] = []

let order: { id: string; orderNumber: string | null; externalOrderNumber: string | null; status: string } | null = {
  id: 'so-1',
  orderNumber: 'SO-1',
  externalOrderNumber: '4242',
  status: 'PROCESSING',
}
let allocationCount = 0
let shipmentCount = 0
let autoAllocateResult: { success: boolean; error?: string; allocationCount?: number; unallocatedQty?: number } = {
  success: true,
  allocationCount: 2,
  unallocatedQty: 0,
}
let confirmResult: { success: boolean; error?: string } = { success: true }

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { activityLog.push(entry) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findUnique: async () => order },
      orderAllocation: { count: async () => allocationCount },
      shipment: {
        count: async () => shipmentCount,
        findMany: async () => [],
      },
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => autoAllocateResult,
    confirmAllocations: async () => confirmResult,
    updateShipmentStatus: async () => ({ success: true }),
  },
})

async function apply() {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId: 'so-1' },
    targetShipmentStatus: 'SHIPPED',
  })
}

function reset() {
  activityLog.length = 0
  order = { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: '4242', status: 'PROCESSING' }
  allocationCount = 0
  shipmentCount = 1
  autoAllocateResult = { success: true, allocationCount: 2, unallocatedQty: 0 }
  confirmResult = { success: true }
}

function refusals() {
  return activityLog.filter((entry) => entry.action === 'external_fulfillment_refused')
}

test('the physical-stock refusal leaves an activity row naming the order and the reason (o3d-xnwu)', async () => {
  reset()
  autoAllocateResult = { success: true, allocationCount: 0, unallocatedQty: 3 }

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(result.reason, 'insufficient-stock', 'the caller must be able to classify this without matching strings')
  assert.match(String(result.error), /3 unit\(s\) on backorder/)

  assert.equal(refusals().length, 1, 'this refusal used to produce literally no record')
  assert.equal(refusals()[0].level, 'WARNING')
  assert.equal(refusals()[0].entityId, 'so-1', 'and it is filed against the order, so the order page shows it')
  assert.match(String(refusals()[0].description), /4242/, 'named by the number the operator knows it by')
  assert.match(String(refusals()[0].description), /requires physical stock/)
  assert.equal((refusals()[0].metadata as { reason?: string }).reason, 'insufficient-stock')
})

test('an order that cannot be resolved is refused with a reason, even with no order to file against', async () => {
  reset()
  order = null

  const result = await apply()

  assert.equal(result.reason, 'order-not-found')
  assert.equal(refusals().length, 1)
  assert.equal(refusals()[0].entityId, undefined, 'there is no order id to attach — the row is still written')
})

test('a failed allocation and a failed shipment creation are distinguished from each other', async () => {
  reset()
  autoAllocateResult = { success: false, error: 'allocator lost a race' }
  assert.equal((await apply()).reason, 'allocation-failed')
  assert.match(String(refusals()[0].description), /allocator lost a race/)

  reset()
  allocationCount = 4
  shipmentCount = 0
  confirmResult = { success: false, error: 'shipment write rejected' }
  const second = await apply()
  assert.equal(second.reason, 'shipment-creation-failed')
  assert.equal(second.error, 'shipment write rejected')
  assert.equal(refusals().length, 1)
})

test('a fulfilment that applies writes no refusal row', async () => {
  reset()
  allocationCount = 2
  shipmentCount = 1

  const result = await apply()

  assert.equal(result.success, true)
  assert.equal(result.reason, undefined)
  assert.deepEqual(refusals(), [], 'a WARNING per successful dispatch would bury the ones that matter')
  assert.ok(activityLog.some((entry) => entry.action === 'external_fulfillment_applied'))
})
