import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-2k5r r3 — `reopenShipmentForRepackAction` is a THREE-STEP recovery, and the question here is
 * only ever "can it stop after step one?".
 *
 * Before this change the reopen was its own committed transaction and the re-allocation followed
 * it. A worker killed in that window left the shipment a PENDING draft with the order's reservation
 * still holding the pre-refund quantity and the refund backstop still deferred — and re-running the
 * advertised action did not resume it, because reopening refuses an already-pending shipment.
 *
 * The doubles below are built so that the difference between "wrote through the transaction" and
 * "wrote through the connection" is REAL rather than assumed: `db.$transaction` hands the callback
 * its own client over a STAGING copy of the store and merges only on a clean return, while a write
 * through `db` itself lands on the committed store immediately. A test whose fake transaction just
 * ran the callback could not tell a rollback from a write that was never attempted.
 */

type ShipmentRow = { id: string; orderId: string; status: string }
type Store = {
  shipments: Map<string, ShipmentRow>
  refunds: Array<{ id: string; orderId: string }>
  /** Refund-reservation-release backstop rows resolved through this store's client. */
  resolved: string[]
  activity: Array<Record<string, unknown>>
}

type FakeClient = ReturnType<typeof makeClient>

const state = {
  /** Which client object each collaborator was handed — the structural half of "one transaction". */
  reopenClient: null as FakeClient | null,
  allocClient: null as FakeClient | null,
  transactions: 0,
  allocCalls: 0,
  /** 'kill' throws from inside the allocation, i.e. the worker dies between step 1 and step 2. */
  allocBehaviour: 'ok' as 'ok' | 'kill',
  allocResult: {} as Record<string, unknown>,
  loggedActivity: [] as Array<Record<string, unknown>>,
  stockSyncs: [] as string[][],
}

function emptyStore(): Store {
  return { shipments: new Map(), refunds: [], resolved: [], activity: [] }
}

let committed: Store = emptyStore()

function cloneStore(store: Store): Store {
  return {
    shipments: new Map([...store.shipments].map(([id, row]) => [id, { ...row }])),
    refunds: store.refunds.map((r) => ({ ...r })),
    resolved: [...store.resolved],
    activity: store.activity.map((a) => ({ ...a })),
  }
}

function makeClient(store: Store) {
  return {
    /** How a double reached from inside the action finds the store its client writes to. */
    __store: store,
    shipment: {
      findUnique: async ({ where }: { where: { id: string } }) => store.shipments.get(where.id) ?? null,
      // o3d-2k5r r6: the action re-reads the order's blockers under the lock after a refusal, so
      // the double has to answer the same query the real client does — including the
      // `status: { not: 'PENDING' }` filter, or the test would pass on a read that found nothing.
      findMany: async ({ where }: { where: { orderId: string; status?: { not: string } } }) =>
        [...store.shipments.values()].filter((row) =>
          row.orderId === where.orderId
          && (where.status?.not === undefined || row.status !== where.status.not)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.shipments.get(where.id)
        if (!row) throw new Error(`no shipment ${where.id}`)
        Object.assign(row, data)
        return row
      },
    },
    salesOrderRefund: {
      findMany: async ({ where }: { where: { orderId: string } }) =>
        store.refunds.filter((r) => r.orderId === where.orderId).map((r) => ({ id: r.id })),
    },
    activityLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => { store.activity.push(data) },
    },
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/db', {
  namedExports: {
    get db() {
      return {
        ...makeClient(committed),
        // ROLLBACK IS REAL, and so is the distinction between the two clients. The callback writes
        // to a staging copy; a throw discards it, a clean return merges it. A write made through
        // the outer `db` inside this window bypasses staging entirely and SURVIVES an abort —
        // which is exactly the pre-fix shape this file has to be able to fail on.
        $transaction: async (fn: (tx: FakeClient) => Promise<unknown>) => {
          state.transactions += 1
          const staging = cloneStore(committed)
          const result = await fn(makeClient(staging))
          committed = staging
          return result
        },
      }
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    requireInternalUser: async () => ({ user: { id: 'op-1' } }),
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.loggedActivity.push(entry) },
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async (ids: string[]) => { state.stockSyncs.push(ids) },
    pushOrderDeliveryMetadata: async () => {},
  },
})

mock.module('@/lib/domain/sales/refund-reservation-release-outbox', {
  namedExports: {
    resolveRefundReservationReleaseOutbox: async (
      refundId: string,
      options: { client: FakeClient },
    ) => { options.client.__store.resolved.push(refundId) },
  },
})

mock.module('@/lib/domain/sales/shipment-service', {
  namedExports: {
    // Behaves like the real one on the two axes the action reads: it WRITES THROUGH THE CLIENT IT
    // IS GIVEN, and it reports an already-pending draft as ALREADY_PENDING with the order
    // identifiers rather than as a bare error string.
    reopenShipmentForRepack: async (client: FakeClient, shipmentId: string) => {
      state.reopenClient = client
      const row = client.__store.shipments.get(shipmentId)
      if (!row) return { success: false as const, error: 'Shipment not found' }
      const orderRef = row.orderId.toUpperCase()
      if (row.status === 'PENDING') {
        return {
          success: false as const,
          code: 'ALREADY_PENDING' as const,
          orderId: row.orderId,
          orderRef,
          error: 'This shipment is already a pending draft — nothing has been committed to it.',
        }
      }
      await client.shipment.update({ where: { id: shipmentId }, data: { status: 'PENDING' } })
      await client.activityLog.create({ data: { action: 'shipment_reopened_for_repack', shipmentId } })
      return {
        success: true as const,
        orderId: row.orderId,
        orderRef,
        previousStatus: 'PACKED',
        trackingNumber: null,
        shippingService: null,
        lineCount: 1,
      }
    },
    confirmSalesOrderShipments: async () => ({}),
    discardCancelledOrderShipmentsInTx: async () => ({ discarded: [] }),
    reconcileOrderAfterShipment: async () => ({}),
    transitionShipmentStatus: async () => ({}),
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    allocateSalesOrder: async (
      client: FakeClient,
      input: { onReconciledInTx?: (tx: FakeClient) => Promise<void> },
    ) => {
      state.allocClient = client
      state.allocCalls += 1
      if (state.allocBehaviour === 'kill') throw new Error('worker killed mid-allocation')
      // The real service runs this immediately before its commit, on the committed path only.
      if (input.onReconciledInTx && state.allocResult.logAttempt === true) {
        await input.onReconciledInTx(client)
      }
      return state.allocResult
    },
    // Unused by these paths, but every named import of a mocked module has to exist.
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

/** A committed allocation result — `logAttempt` is the only honest "runAllocation actually ran". */
function allocationRan(over: Record<string, unknown> = {}) {
  return {
    success: true,
    syncProductIds: ['prod-1'],
    allocationCount: 1,
    unallocatedLines: [],
    unallocatedQty: 0,
    backorderLineCount: 0,
    orderRef: 'SO-1',
    logAttempt: true,
    ...over,
  }
}

function reset(shipmentStatus: string, siblingStatuses: string[] = []) {
  committed = emptyStore()
  committed.shipments.set('ship-1', { id: 'ship-1', orderId: 'so-1', status: shipmentStatus })
  siblingStatuses.forEach((status, i) => {
    const id = `ship-sib-${i + 1}`
    committed.shipments.set(id, { id, orderId: 'so-1', status })
  })
  committed.refunds.push({ id: 'refund-1', orderId: 'so-1' })
  state.reopenClient = null
  state.allocClient = null
  state.transactions = 0
  state.allocCalls = 0
  state.allocBehaviour = 'ok'
  state.allocResult = allocationRan()
  state.loggedActivity = []
  state.stockSyncs = []
}

async function loadAction() {
  return (await import('@/app/actions/allocation')).reopenShipmentForRepackAction
}

test('o3d-2k5r r3: a kill BETWEEN the reopen and the allocation leaves nothing half-applied', async () => {
  // THE KILL POINT. The reopen has written, and the process dies before the netting and the
  // backstop resolution. Pre-fix that write was already committed, so what survived was a draft
  // shipment on an order whose reservation still held the pre-refund quantity — and no door back.
  reset('PACKED')
  state.allocBehaviour = 'kill'
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, false)
  assert.equal(committed.shipments.get('ship-1')!.status, 'PACKED', 'the revert must not survive the kill')
  assert.deepEqual(committed.resolved, [], 'and no backstop row may be consumed by a recovery that did not finish')
  assert.deepEqual(
    committed.activity.filter((a) => a.action === 'shipment_reopened_for_repack'),
    [],
    'nor may the warehouse be told to unpack a box for a revert that was rolled back',
  )
})

test('o3d-2k5r r3: the reopen, the netting and the backstop resolution are handed the SAME transaction', async () => {
  // The structural half of the same claim. Two clients means two transactions, whatever the
  // rollback assertions happen to show on any one path.
  reset('PACKED')
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, true)
  assert.equal(state.transactions, 1)
  assert.ok(state.reopenClient, 'the reopen ran')
  assert.equal(state.allocClient, state.reopenClient, 'and the allocation ran on the same client')
  assert.equal(committed.shipments.get('ship-1')!.status, 'PENDING')
  assert.deepEqual(committed.resolved, ['refund-1'], 'the deferred backstop was resolved inside it')
  assert.deepEqual(state.stockSyncs, [['prod-1']], 'and the storefront push happened only after the commit')
})

test('o3d-2k5r r3: an allocation that never RAN rolls the reopen back rather than leaving two thirds of it', async () => {
  // A pre-transaction bail — no eligible warehouse, order missing. Nothing was netted, so keeping
  // the revert would strand exactly the state the kill test is about, only deterministically.
  reset('PACKED')
  state.allocResult = { success: false, error: 'No warehouses available for sale', syncProductIds: [], allocationCount: 0, unallocatedLines: [], unallocatedQty: 0, backorderLineCount: 0 }
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /was NOT reopened/)
  assert.match(result.error!, /No warehouses available for sale/)
  assert.equal(committed.shipments.get('ship-1')!.status, 'PACKED')
  assert.deepEqual(committed.resolved, [])
})

test('o3d-2k5r r3: a REFUSED re-allocation KEEPS the reopen — otherwise two packed shipments could never be reopened at all', async () => {
  // The one outcome that deliberately commits a partial recovery, and the reason it must. With
  // shipments A and B both packed, `refuseIfCommittedShipmentsExist` refuses A because B is
  // committed and refuses B because A is; rolling back on refusal would make the order permanently
  // unrecoverable. The operator reopens the other one and THAT transaction nets the whole order.
  // o3d-2k5r r6: the blocker is seeded, and it is PACKED — the partial commit is justified by the
  // deadlock two reopenable shipments create, so the test has to be in that state to claim it.
  reset('PACKED', ['PACKED'])
  state.allocResult = { success: false, refused: true, syncProductIds: [], allocationCount: 0, unallocatedLines: [], unallocatedQty: 0, backorderLineCount: 0 }
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, true)
  assert.equal(committed.shipments.get('ship-1')!.status, 'PENDING')
  assert.match(result.warning!, /another committed \(picking or packed\) shipment/)
  // o3d-2k5r r5: and it points at REOPEN, not at "Finish repack recovery", because that control is
  // not offered while the order still holds a commitment — the action would be refused again.
  assert.match(result.warning!, /REOPEN that one too/)
  assert.match(result.warning!, /Once nothing committed is left/)
  assert.deepEqual(committed.resolved, [], 'nothing was netted, so no backstop row may be consumed')
})

test('o3d-2k5r r3: re-running the action on an ALREADY-PENDING draft RESUMES the recovery instead of refusing it', async () => {
  // The other half of "it cannot stop a third of the way": a recovery the refusal above left open
  // has to be finishable, and the advertised action is the only door. Pre-fix this returned "this
  // shipment is already a pending draft" and the order stayed unnetted for good.
  reset('PENDING')
  state.allocResult = allocationRan({ success: false, error: 'insufficient stock', unallocatedQty: 2, allocationCount: 1 })
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, true)
  assert.equal(state.allocCalls, 1, 'the netting ran')
  assert.deepEqual(committed.resolved, ['refund-1'], 'and the deferred backstop was resolved')
  // ...and it says what actually happened. "Shipment reopened, but…" would send the operator
  // looking for a revert that this run never performed.
  assert.match(result.warning!, /The shipment was already a draft/)
  assert.match(result.warning!, /reservation was released/)
  assert.match(result.warning!, /2 unit\(s\) are on backorder/)
  assert.doesNotMatch(result.warning!, /Shipment reopened/)
})

test('o3d-2k5r r3: a shipment that does not exist is still a plain refusal, not an abort', async () => {
  // The resume must not swallow every refusal — only ALREADY_PENDING, which is the one that means
  // "step one is already done".
  reset('PACKED')
  const result = await (await loadAction())('ship-missing')
  assert.equal(result.success, false)
  assert.equal(result.error, 'Shipment not found')
  assert.equal(state.allocCalls, 0, 'nothing may be allocated for a shipment we could not read')
})

test('o3d-2k5r r6: a refusal caused by a DISPATCHED sibling rolls the reopen back instead of committing it', async () => {
  // THE FINDING, on the write path. Pre-fix, `refused` alone kept the reopen — whatever caused it.
  // With a SHIPPED sibling the refusal is permanent (`refuseIfCommittedShipmentsExist` matches
  // every non-PENDING status, and a dispatched shipment can never be reopened), so keeping the
  // revert converted a shipment that could still go out into a draft no control can finish. There
  // is no deadlock to break here: the blocker will never move.
  reset('PACKED', ['SHIPPED'])
  state.allocResult = { success: false, refused: true, syncProductIds: [], allocationCount: 0, unallocatedLines: [], unallocatedQty: 0, backorderLineCount: 0 }
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /cannot be completed/)
  assert.match(result.error!, /1 dispatched shipment/)
  assert.equal(committed.shipments.get('ship-1')!.status, 'PACKED', 'the revert must not survive a refusal that leads nowhere')
  assert.deepEqual(
    committed.activity.filter((a) => a.action === 'shipment_reopened_for_repack'),
    [],
    'and the warehouse must not be told to unpack a box for a revert that was rolled back',
  )
  assert.deepEqual(committed.resolved, [], 'nothing was netted, so no backstop row may be consumed')
})

test('o3d-2k5r r6: the same guard covers the RESUME path, where no reopen ran to check anything', async () => {
  // The draft is already open (the state an older IMS could strand, or a refused earlier run left)
  // and a sibling has since been dispatched. `reopenShipmentForRepack` returns ALREADY_PENDING and
  // never reaches its own lock-time sibling check, so without the action's re-read this returned
  // `success: true` with a warning for a run that netted nothing and resolved nothing.
  reset('PENDING', ['SHIPPED'])
  state.allocResult = { success: false, refused: true, syncProductIds: [], allocationCount: 0, unallocatedLines: [], unallocatedQty: 0, backorderLineCount: 0 }
  const result = await (await loadAction())('ship-1')

  assert.equal(result.success, false)
  assert.match(result.error!, /cannot be completed/)
  assert.deepEqual(committed.resolved, [], 'and it must not report a recovery it did not perform')
})
