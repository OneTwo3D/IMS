import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * SHP-H1 (WMS retry half): when every shipment on an order is already SHIPPED but the order was
 * never promoted (the promotion failed or was interrupted after the dispatch committed), the next
 * external update has no shipment left to transition. The retry must reconcile the ORDER, on the
 * unfenced WMS path too, and must report success only once the order really is shipped.
 * It used to log `external_fulfillment_applied` and return success on every sweep tick while the
 * order sat un-promoted for ever.
 */

type Row = Record<string, unknown>

const state = {
  orderStatus: 'PROCESSING',
  reconcileCalls: [] as Array<{ orderId: string; options: Row | undefined }>,
  reconcileResult: { orderReachedShipped: true } as Row,
  activity: [] as Row[],
  /** Shipments not yet SHIPPED, and the total on the order. */
  openShipments: [] as Row[],
  totalShipments: 1,
  transitions: [] as Array<{ target: string; options: Row | undefined }>,
  notifications: [] as Row[],
  /** Activity rows already persisted (what `db.activityLog.findFirst` sees). */
  persistedActivity: [] as Row[],
  /** The status the dispatch transaction finds UNDER THE LOCK; null means it is promotable. */
  lockedStatus: null as string | null,
  notifyOk: true,
  markerOk: true,
  /** Which admins the bell reaches (ids absent from the list fail to persist). */
  admins: ['admin-1'] as string[],
  failingAdmins: [] as string[],
  allocationCount: 1,
  autoAllocations: 0,
  shipmentResults: null as null | (() => Row),
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Row) => { state.activity.push(entry); state.persistedActivity.push(entry) },
    logActivityPersisted: async (entry: Row) => {
      if (!state.markerOk) return false
      state.activity.push(entry); state.persistedActivity.push(entry)
      return true
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({ id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: state.orderStatus }),
      },
      user: { findMany: async () => state.admins.map((id) => ({ id })) },
      activityLog: { findFirst: async ({ where }: { where: Row }) => state.persistedActivity.find((row) => row.action === where.action) ?? null },
      salesOrderLine: { findMany: async () => [] },
      shipmentLine: { findMany: async () => [] },
      salesOrderRefundLine: { findMany: async () => [] },
      stockMovement: { findMany: async () => [] },
      orderAllocation: { count: async () => state.allocationCount },
      // o3d-hqvrp.78: the WMS push-link read; no link, so the warehouse falls back to the order's ship-from (null here: nothing is refused).
      wmsOrderPushLink: { findUnique: async () => null },
      // Every shipment is already SHIPPED, so none is `not: SHIPPED`.
      shipment: { count: async () => state.totalShipments, findMany: async () => state.openShipments },
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => { state.autoAllocations += 1; return { success: true, allocationCount: 1, unallocatedQty: 0 } },
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (_id: string, target: string, _extra: unknown, options: Row | undefined) => {
      state.transitions.push({ target, options })
      if (state.shipmentResults) return state.shipmentResults()
      return state.lockedStatus ? { success: true, despatchedWhileNotReady: state.lockedStatus } : { success: true }
    },
  },
})

mock.module('@/lib/notifications', {
  namedExports: {
    notifyPersisted: async (entry: Row) => {
      if (!state.notifyOk || state.failingAdmins.includes(String(entry.userId))) return false
      state.notifications.push(entry)
      return true
    },
  },
})

mock.module('@/lib/domain/sales/shipment-service', {
  namedExports: {
    reconcileOrderAfterShipment: async (_db: unknown, shipment: { orderId: string }, _extra: unknown, options: Row | undefined) => {
      state.reconcileCalls.push({ orderId: shipment.orderId, options })
      return { shouldGenerateInvoice: false, orderId: shipment.orderId, ...state.reconcileResult }
    },
  },
})

const partialFlushes: string[][] = []
mock.module('@/lib/storefront-customer-email', {
  namedExports: {
    queueStorefrontPartialShipmentEmailsAfterBatch: async (ids: readonly string[]) => { partialFlushes.push([...ids]) },
    queueStorefrontPartialShipmentEmailIfEligible: async () => undefined,
  },
})

function reset() {
  partialFlushes.length = 0
  state.orderStatus = 'PROCESSING'
  state.reconcileCalls = []
  state.reconcileResult = { orderReachedShipped: true }
  state.activity = []
  state.openShipments = []
  state.totalShipments = 1
  state.transitions = []
  state.notifications = []
  state.persistedActivity = []
  state.lockedStatus = null
  state.notifyOk = true
  state.markerOk = true
  state.admins = ['admin-1']
  state.failingAdmins = []
  state.allocationCount = 1
  state.autoAllocations = 0
  state.shipmentResults = null
}

async function apply(extra: Row = {}) {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({
    source: 'mintsoft',
    lookup: { orderId: 'so-1' },
    targetShipmentStatus: 'SHIPPED',
    ...extra,
  } as never)
}

test('SHP-H1: an unfenced WMS retry with every shipment already SHIPPED reconciles the order and enqueues the completion', async () => {
  reset()
  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.equal(state.reconcileCalls.length, 1, 'the order must be reconciled, not skipped')
  assert.equal(state.reconcileCalls[0].options?.completionAuthority, 'EXTERNAL')
  assert.equal(state.reconcileCalls[0].options?.storefrontCompletion, true)
  assert.equal(state.reconcileCalls[0].options?.fence, undefined)
})

test('SHP-H1: the retry is NOT reported as applied while the order is still not shipped', async () => {
  reset()
  state.reconcileResult = {}
  state.orderStatus = 'PROCESSING'

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(state.activity.some((row) => row.action === 'external_fulfillment_applied'), false)
})

test('SHP-H1: a retry for an order that is already SHIPPED stays a success', async () => {
  reset()
  state.reconcileResult = {}
  state.orderStatus = 'SHIPPED'

  assert.deepEqual(await apply(), { success: true })
})

test('SHP-H1: a retry for an order the storefront already completed does not enqueue another completion', async () => {
  reset()
  const result = await apply({ source: 'woocommerce', storefrontAlreadyCompleted: true })

  assert.deepEqual(result, { success: true })
  assert.equal(state.reconcileCalls[0].options?.storefrontCompletion, false)
})

for (const held of ['ON_HOLD', 'PENDING_PAYMENT']) {
  test(`SHP-H1: a WMS despatch of a ${held} order is recorded, the order is not promoted, and a notice is raised`, async () => {
    reset()
    state.orderStatus = held
    state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
    state.lockedStatus = held

    const result = await apply()

    assert.deepEqual(result, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.transitions.length, 1)
    assert.equal(state.transitions[0].target, 'SHIPPED')
    assert.equal(state.transitions[0].options?.allowRecordWhenNotReady, true)
    // The decision is the transaction's, under the order lock; it enqueues the completion only if it promotes.
    assert.equal(state.reconcileCalls.length, 0, 'the order is not reconciled or promoted')
    assert.ok(state.activity.some((row) => row.action === 'external_despatch_recorded_order_not_ready' && row.level === 'WARNING'))
    assert.equal(state.notifications.length, 1)
  })

  test(`SHP-H1: the next sweep tick for a recorded ${held} despatch is a quiet success, not a second notice`, async () => {
    reset()
    state.orderStatus = held
    state.persistedActivity = [{ action: 'external_despatch_recorded_order_not_ready' }]

    const result = await apply()

    assert.deepEqual(result, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.reconcileCalls.length, 0)
    assert.equal(state.notifications.length, 0)
    assert.equal(state.activity.length, 0)
  })

  test(`SHP-H1: a crash after the ${held} despatch committed but before the review event was written is healed by the retry`, async () => {
    reset()
    state.orderStatus = held // no open shipment left, and no marker row: the first pass died before raising the event

    const result = await apply()

    assert.deepEqual(result, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.notifications.length, 1, 'the notice is raised on the retry')
    assert.ok(state.activity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'))

    const again = await apply()
    assert.deepEqual(again, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.notifications.length, 1, 'and only once')
  })
}

test('SHP-H1: a WMS despatch for a DRAFT order is not recorded: it stays an unreconciled despatch for the operator', async () => {
  reset()
  state.orderStatus = 'DRAFT'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(!result.success && result.refusal, 'order_not_ready_to_ship')
  assert.equal(!result.success && result.permanent, false, 'retried, then dead-lettered into the exception inbox')
  assert.equal(state.transitions.length, 0, 'nothing is written: a draft has no allocation to consume')
  assert.equal(state.reconcileCalls.length, 0)
})

test('SHP-H1: a WMS despatch for a held order with no shipment is not recorded (creating one would lift the hold)', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.totalShipments = 0

  const result = await apply()

  assert.equal(!result.success && result.refusal, 'order_not_ready_to_ship')
  assert.equal(state.transitions.length, 0)
})

test('SHP-H1: a WMS despatch for a PROCESSING order still promotes it', async () => {
  reset()
  state.orderStatus = 'PROCESSING'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.equal(state.transitions[0].options?.allowRecordWhenNotReady, true, 'the decision is made under the lock, not on the pre-read')
  assert.equal(state.transitions[0].options?.storefrontCompletion, true)
})

test('SHP-H1: a held order released between the pre-read and the dispatch lock is promoted normally, with no review event', async () => {
  reset()
  state.orderStatus = 'ON_HOLD' // the pre-read
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = null // under the lock it was already released

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.equal(state.notifications.length, 0)
  assert.equal(state.persistedActivity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'), false)
})

test('SHP-H1: an order that looked ready but is on hold under the lock is recorded without promotion and reviewed', async () => {
  reset()
  state.orderStatus = 'PROCESSING' // the pre-read
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'

  const result = await apply()

  assert.deepEqual(result, { success: true, despatchedWhileNotReady: 'ON_HOLD' })
  assert.equal(state.notifications.length, 1)
})

test('SHP-H1: a failed bell notice leaves no marker, so the next tick raises the event again', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'
  state.notifyOk = false

  const first = await apply()

  assert.equal(first.success, false, 'a failed notice is a retryable failure, not a quiet success')
  assert.equal((first as { refusal?: string; permanent?: boolean }).refusal, 'despatch_review_not_recorded')
  assert.equal((first as { permanent?: boolean }).permanent, false)
  assert.equal(state.persistedActivity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'), false, 'no marker while the notice is unwritten')

  // Next tick: the shipment is recorded, nothing left to transition; the bell now works.
  state.openShipments = []
  state.lockedStatus = null
  state.notifyOk = true
  const second = await apply()

  assert.deepEqual(second, { success: true, despatchedWhileNotReady: 'ON_HOLD' })
  assert.equal(state.notifications.length, 1)
  assert.equal(state.persistedActivity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'), true)
})

test('SHP-H1: the review marker is written only when EVERY admin notice persisted', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'
  state.admins = ['admin-1', 'admin-2']
  state.failingAdmins = ['admin-2']

  const partial = await apply()

  assert.equal(partial.success, false)
  assert.equal(state.notifications.length, 1, 'one notice persisted, one did not')
  assert.equal(state.persistedActivity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'), false, 'so the retry must raise it again')
})

test('SHP-H1: a held order with no allocation row is not auto-allocated (that would lift the hold)', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.allocationCount = 0
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'

  await apply()

  assert.equal(state.autoAllocations, 0)
  assert.equal(state.transitions.length, 1)
})

test('SHP-H1: a despatch the storefront already completed enqueues no completion even for a WMS source', async () => {
  reset()
  state.orderStatus = 'PROCESSING'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

  await apply({ storefrontAlreadyCompleted: true })

  assert.equal(state.transitions[0].options?.storefrontCompletion, false)
})

test('o3d-hqvrp.330: zero active admins is not a persisted review; no marker, retryable failure', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'
  state.admins = []

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal((result as { refusal?: string }).refusal, 'despatch_review_not_recorded')
  assert.equal(state.persistedActivity.some((row) => row.action === 'external_despatch_recorded_order_not_ready'), false)
})

test('o3d-hqvrp.330: a failed marker write is a retryable failure, so the notice is not silently repeated as success', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.lockedStatus = 'ON_HOLD'
  state.markerOk = false

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal((result as { refusal?: string }).refusal, 'despatch_review_not_recorded')
})

test('PARTIAL e-mail: when a later shipment of the batch FAILS (the fence refusing the order flip after the last shipment shipped), no partial e-mail is judged for the earlier ones (MUTATION: flush on failure => red)', async () => {
  reset()
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }, { id: 'shp-2', status: 'PACKED' }]
  state.totalShipments = 2
  let call = 0
  state.shipmentResults = () => (++call === 1 ? { success: true } : { success: false, error: 'verification fence refused the order flip' })
  const result = await apply()
  assert.equal(result.success, false)
  assert.equal(state.transitions.length, 2, 'precondition: both shipments were attempted, the second failed')
  assert.deepEqual(partialFlushes, [], 'a failed batch queues no partial e-mail')
  // CONTROL: the same batch succeeding is flushed once with both shipments.
  reset()
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }, { id: 'shp-2', status: 'PACKED' }]
  state.totalShipments = 2
  state.shipmentResults = null
  await apply()
  assert.deepEqual(partialFlushes, [['shp-1', 'shp-2']], 'CONTROL: a successful batch is flushed once')
})

test('o3d-3634b PARTIAL e-mail: a failure on a NON-last shipment flushes no partial either (the external system reported the whole despatch; a partial would be false). Accepted limit: that partial is lost (MUTATION: flush on a middle failure => red)', async () => {
  reset()
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }, { id: 'shp-2', status: 'PACKED' }, { id: 'shp-3', status: 'PACKED' }]
  state.totalShipments = 3
  let call = 0
  state.shipmentResults = () => (++call === 2 ? { success: false, error: 'transient WMS error' } : { success: true })
  const result = await apply()
  assert.equal(result.success, false)
  assert.equal(state.transitions.length, 2, 'precondition: shipment 1 shipped, shipment 2 failed, shipment 3 was never attempted')
  assert.deepEqual(partialFlushes, [], 'no partial e-mail is judged on any failure')
})
