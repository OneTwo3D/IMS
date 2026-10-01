import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 — a shipment shipped INSIDE IMS must complete the WooCommerce order.
 *
 * `updateShipmentStatus` (the in-app dispatch) reconciled the order to SHIPPED and then pushed only
 * the tracking, so the WooCommerce order stayed `processing` and no "completed" email went out —
 * while the WMS path (`applyExternalFulfillmentUpdate`) did push the status. These tests drive the
 * REAL `updateShipmentStatus` and the REAL completion helper; only the storage and the connector
 * edge are doubles.
 *
 * Since the review of #719 the completion is a DURABLE job: the reconcile enqueues it in the flip's own
 * transaction and hands back its key, and the action makes one un-awaited post-commit attempt with that
 * key. So the contract asserted here is: a key exists exactly for the call that completed the order and
 * owns the storefront; the attempt is made with exactly that key; the shipment never waits on or fails
 * with it. (What the job DOES — tracking, then status, retry — is tested where the job lives.)
 *
 * The reconcile double mirrors the one thing the action reads from the real function — "did THIS
 * call move the order to SHIPPED" — over shipment rows it owns, and every arm asserts its
 * precondition from the double's own record (`reconcileResults`, the order's final status) so a
 * double that never reached the branch cannot pass an arm by examining nothing.
 */

type Shipment = { id: string; orderId: string; status: string }

const state = {
  orderStatus: 'ALLOCATED',
  shipments: [] as Shipment[],
  /** Everything the connector edge was asked to do, in order. */
  calls: [] as string[],
  reconcileResults: [] as Array<Record<string, unknown>>,
  reconcileOptions: [] as Array<Record<string, unknown> | undefined>,
  activity: [] as Array<Record<string, unknown>>,
  /** How the post-commit attempt behaves: resolves, rejects, or never settles. */
  attemptBehaviour: 'ok' as 'ok' | 'reject' | 'hang',
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    requireInternalUser: async () => ({ user: { id: 'op-1' } }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('@/lib/dispatch-email', {
  namedExports: { queueDispatchEmailIfEligible: async () => {} },
})
mock.module('@/lib/db', { namedExports: { db: {} } })

mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => { state.calls.push('stock') },
    pushOrderDeliveryMetadata: async (orderId: string) => {
      state.calls.push(`tracking:${orderId}`)
      return { success: true }
    },
    scheduleShoppingOrderCompletion: async () => null,
    processShoppingOrderCompletions: async (options: { idempotencyKeys?: string[] }) => {
      state.calls.push(`attempt:${(options.idempotencyKeys ?? []).join(',')}`)
      if (state.attemptBehaviour === 'reject') throw new Error('WooCommerce is down')
      if (state.attemptBehaviour === 'hang') return new Promise(() => {})
      return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
    },
  },
})

mock.module('@/lib/domain/sales/shipment-service', {
  namedExports: {
    // Flips the shipment row; reports `transitioned: false` for a repeat, exactly like the real one.
    transitionShipmentStatus: async (_client: unknown, input: { shipmentId: string; targetStatus: string }) => {
      const row = state.shipments.find((s) => s.id === input.shipmentId)
      if (!row) return { success: false, error: 'Shipment not found' }
      const transitioned = row.status !== input.targetStatus
      const previousStatus = row.status
      row.status = input.targetStatus
      return {
        success: true,
        transitioned,
        dispatched: false,
        previousStatus,
        targetStatus: input.targetStatus,
        stockSyncProductIds: ['prod-1'],
        shipment: {
          id: row.id,
          orderId: row.orderId,
          lines: [],
          warehouse: { code: 'WH1' },
          order: { orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
        },
      }
    },
    // The decision the action consumes: every shipment SHIPPED and the order not already terminal
    // -> THIS call promoted it, and says so with `orderReachedShipped`.
    reconcileOrderAfterShipment: async (
      _client: unknown,
      shipment: { orderId: string },
      _extra?: unknown,
      options?: Record<string, unknown>,
    ) => {
      state.reconcileOptions.push(options)
      const allShipped = state.shipments.every((s) => s.status === 'SHIPPED')
      let result: Record<string, unknown> = { shouldGenerateInvoice: false, orderId: shipment.orderId }
      if (allShipped && !['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'].includes(state.orderStatus)) {
        state.orderStatus = 'SHIPPED'
        result = { ...result, orderReachedShipped: true }
        // The real function enqueues the job in the flip's transaction when asked and the order is linked.
        if (options?.storefrontCompletion) result = { ...result, storefrontCompletionKey: `key-${shipment.orderId}` }
      }
      state.reconcileResults.push(result)
      return result
    },
    confirmSalesOrderShipments: async () => ({}),
    discardCancelledOrderShipmentsInTx: async () => ({ discarded: [] }),
    reopenShipmentForRepack: async () => ({}),
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    allocateSalesOrder: async () => ({}),
    applyAllocationReservationDelta: async () => {},
    buildAvailableStockMap: () => new Map(),
    canonicalAllocationQty: (v: unknown) => v,
    clearDormantFulfillmentPinsInTx: async () => {},
    lockAccountedRecordsForScope: async () => {},
    floorAvailableStockMapToCanonicalScale: () => new Map(),
    lockSalesOrder: async () => {},
    lockStockLevels: async () => {},
    refileAccountedRecordsForScope: async () => {},
    releaseOrderAllocationsForDeallocationInTx: async () => ({ allocs: [], deletedPendingShipmentCount: 0 }),
    resetAllocationAccountingIfStaged: async () => {},
    validateAllocationIntegrity: async () => {},
    ALLOCATION_TX_OPTIONS: { maxWait: 5000, timeout: 20000 },
  },
})

function seed(orderStatus: string, shipmentStatuses: string[]) {
  state.orderStatus = orderStatus
  state.shipments = shipmentStatuses.map((status, i) => ({ id: `ship-${i + 1}`, orderId: 'so-1', status }))
  state.calls.length = 0
  state.reconcileResults.length = 0
  state.reconcileOptions.length = 0
  state.activity.length = 0
  state.attemptBehaviour = 'ok'
}

beforeEach(() => seed('ALLOCATED', ['PACKED']))

async function ship(shipmentId: string, options?: Record<string, unknown>) {
  const { updateShipmentStatus } = await import('@/app/actions/allocation')
  return updateShipmentStatus(shipmentId, 'SHIPPED', undefined, options)
}

const ATTEMPTS = (calls: string[]) => calls.filter((c) => c.startsWith('attempt:'))
const TRACKING = (calls: string[]) => calls.filter((c) => c.startsWith('tracking:'))
/** Let the un-awaited post-commit attempt run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('o3d-zvec.15 (a): the LAST shipment shipped makes exactly one post-commit attempt, on the key enqueued with the flip', async () => {
  seed('ALLOCATED', ['PACKED'])
  const result = await ship('ship-1')
  await settle()

  // Preconditions: the shipment really shipped and THIS call really took the order to SHIPPED and got a key.
  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.reconcileResults.length, 1, 'the reconcile double was reached')
  assert.equal(state.reconcileResults[0].orderReachedShipped, true, 'and it promoted the order')
  assert.equal(state.reconcileResults[0].storefrontCompletionKey, 'key-so-1')
  assert.equal(state.orderStatus, 'SHIPPED')
  // The IMS-authority default asked for the durable completion.
  assert.equal(state.reconcileOptions[0]?.storefrontCompletion, true)

  assert.deepEqual(ATTEMPTS(state.calls), ['attempt:key-so-1'], 'one attempt, on that key (tracking-then-status is the job\'s own order)')
  assert.deepEqual(TRACKING(state.calls), [], 'the action does not push tracking separately when the job owns it')
})

test('o3d-zvec.15 (b): a PARTIAL shipment pushes tracking but makes NO completion attempt', async () => {
  seed('ALLOCATED', ['PACKED', 'PACKED'])
  const result = await ship('ship-1')
  await settle()

  assert.equal(result.success, true)
  assert.deepEqual(state.shipments.map((s) => s.status), ['SHIPPED', 'PACKED'])
  assert.equal(state.reconcileResults.length, 1, 'the reconcile double was reached')
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.equal(state.orderStatus, 'ALLOCATED')

  assert.deepEqual(TRACKING(state.calls), ['tracking:so-1'], 'tracking still flows for the shipped part')
  assert.deepEqual(ATTEMPTS(state.calls), [])
})

test('o3d-zvec.15 (b2): shipping the SECOND of two shipments is the one that completes it', async () => {
  seed('ALLOCATED', ['PACKED', 'PACKED'])
  await ship('ship-1')
  await settle()
  assert.deepEqual(ATTEMPTS(state.calls), [], 'precondition: no attempt after the first')
  await ship('ship-2')
  await settle()

  assert.equal(state.orderStatus, 'SHIPPED', 'precondition: the second shipment completed the order')
  assert.deepEqual(ATTEMPTS(state.calls), ['attempt:key-so-1'])
})

test('o3d-zvec.15 (b3): a shortfall-held / not-promoted order makes no attempt', async () => {
  seed('CANCELLED', ['PACKED'])
  const result = await ship('ship-1')
  await settle()

  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.reconcileResults.length, 1)
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.deepEqual(ATTEMPTS(state.calls), [])
})

test('o3d-zvec.15 (arm 11): the shipment SUCCEEDS when the post-commit attempt rejects, and when it never settles', async () => {
  let evaluated = 0
  for (const behaviour of ['reject', 'hang'] as const) {
    seed('ALLOCATED', ['PACKED'])
    state.attemptBehaviour = behaviour
    // `hang` would make this await forever if the action awaited the attempt: that is the proof.
    const result = await ship('ship-1')
    await settle()

    // Preconditions: the failing double was reached and the order did reach SHIPPED.
    assert.deepEqual(ATTEMPTS(state.calls), ['attempt:key-so-1'], `${behaviour}: the attempt was made`)
    assert.equal(state.orderStatus, 'SHIPPED')

    assert.equal(result.success, true, `${behaviour}: the shipment must not be failed by a storefront attempt`)
    assert.equal(state.shipments[0].status, 'SHIPPED', `${behaviour}: and not rolled back`)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-zvec.15 (e): re-running the same shipment (a retry) makes no second attempt', async () => {
  seed('ALLOCATED', ['PACKED'])
  await ship('ship-1')
  await settle()
  assert.deepEqual(ATTEMPTS(state.calls), ['attempt:key-so-1'], 'precondition: the first run attempted once')

  const retry = await ship('ship-1')
  await settle()
  assert.equal(retry.success, true)
  assert.equal(state.reconcileResults.length, 2, 'precondition: the retry reached reconcile')
  assert.equal(state.reconcileResults[1].orderReachedShipped, undefined, 'and reconcile reported nothing new')
  assert.deepEqual(ATTEMPTS(state.calls), ['attempt:key-so-1'], 'still exactly one attempt')
})

test('o3d-zvec.15 (e2): an order ALREADY SHIPPED by another path gets no attempt when its last shipment lands', async () => {
  // This call DOES transition the shipment, so only "did this call promote the order" keeps it single.
  seed('SHIPPED', ['PACKED'])
  const result = await ship('ship-1')
  await settle()

  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED', 'precondition: the shipment really transitioned')
  assert.equal(state.reconcileResults.length, 1)
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.deepEqual(ATTEMPTS(state.calls), [])
})

test('o3d-zvec.15 (g): an EXTERNAL-authority dispatch asks for the durable completion only when its caller says so', async () => {
  const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
  let evaluated = 0
  for (const [storefrontCompletion, expectedAttempts] of [[undefined, 0], [false, 0], [true, 1]] as const) {
    seed('ALLOCATED', ['PACKED'])
    const result = await ship('ship-1', { internalBypassToken: INTERNAL_ACTION_BYPASS, completionAuthority: 'EXTERNAL', storefrontCompletion })
    await settle()
    assert.equal(result.success, true)
    assert.equal(state.reconcileResults[0]?.orderReachedShipped, true, 'precondition: the order did reach SHIPPED')
    assert.equal(state.reconcileOptions[0]?.completionAuthority, 'EXTERNAL')
    assert.equal(state.reconcileOptions[0]?.storefrontCompletion, storefrontCompletion ?? false, `storefrontCompletion=${storefrontCompletion}`)
    assert.equal(ATTEMPTS(state.calls).length, expectedAttempts, `storefrontCompletion=${storefrontCompletion}`)
    if (expectedAttempts === 0) assert.deepEqual(TRACKING(state.calls), ['tracking:so-1'], 'tracking still goes')
    evaluated++
  }
  assert.equal(evaluated, 3)
})
