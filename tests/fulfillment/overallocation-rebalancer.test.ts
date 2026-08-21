import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0qoo — releaseOverallocations un-stages Group A2 for an order whose allocations it is
 * about to release. inventoryAllocatedBatchRef holds the exact AccountingSyncLog.referenceId
 * A2 staged that order into, and findSalesOrderDeleteBlocker matches on it INDEPENDENTLY of
 * inventoryAllocatedDate. So the ref has to be nulled in the same update as the stamp: a row
 * left holding a ref with no stamp is blocked forever against a batch it has already left.
 *
 * The rebalancer swallows every per-item failure into an activity log, so a broken double
 * would otherwise look like a pass. Every test below asserts the failure log stayed empty.
 *
 * o3d-4kfh r4 (Codex finding 2) — THE DOUBLE BELOW USED TO BE VACUOUS.
 *
 * `shipment.deleteMany` returned `{ count: 0 }` unconditionally and `shipment.findMany` did not
 * exist, so the destructive behaviour of this module was never exercised at all: it ran
 * `deleteMany({ orderId, status: 'PENDING' })` — every draft on the order — while releasing ONE
 * allocation, and the tests could not tell the difference. Drafts are now real rows with real
 * lines, real label metadata and a real cascade, and the allocation/stock state actually mutates,
 * so a regression to the blanket delete turns these red.
 */

type Row = Record<string, unknown>

type AllocationRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  /**
   * o3d-0i5y r11: Group A2's RECORD — the units it has debited Allocated Inventory for and, through
   * `postedUnitCostBase`, the amount it debited. `undefined` is the NULL of a row A2 never posted
   * for. Absent from this double entirely until r11, which is why the sweep's treatment of it could
   * not be observed here at all.
   */
  costLayerSnapshot?: unknown
  order: {
    id: string
    orderNumber: string | null
    externalOrderNumber: string | null
    status: string
    createdAt: string
    inventoryAllocatedDate: Date | null
  }
}

type StockLevelRow = { productId: string; warehouseId: string; quantity: number; reservedQty: number }

type ShipmentRow = {
  id: string
  orderId: string
  warehouseId: string
  status: string
  trackingNumber: string | null
  shippingService: string | null
  createdAt: string
}

type ShipmentLineRow = { id: string; shipmentId: string; lineId: string; productId: string; qty: number }
type SalesOrderLineRow = { id: string; orderId: string; fulfillmentRequirements?: unknown }

const state = {
  /** Every salesOrder.update payload, in call order. */
  salesOrderUpdates: [] as Row[],
  /** Every orderAllocation.updateMany payload. */
  allocationUpdates: [] as Row[],
  activity: [] as Row[],
  /**
   * o3d-4kfh r5 (finding 7): the draft-retirement audit row is written on the TRANSACTION client
   * now, not post-commit. Recorded separately from `activity` (which is the post-commit
   * `logActivity` mock) so a test can tell the two apart — that distinction is the whole point.
   */
  txActivity: [] as Row[],
  accountingSyncLogs: [] as Array<{ id: string; status: string }>,
  /** o3d-4kfh r5 (finding 4): what the post-release FIFO pass was actually asked to repair. */
  backorderCalls: [] as Array<{ productIds: string[] }>,
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipments: [] as ShipmentRow[],
  shipmentLines: [] as ShipmentLineRow[],
  /**
   * o3d-kouj: the sales LINES of the orders under test, and whether each carries a pinned recipe.
   * The rebalancer can delete a line's LAST allocation row, which is one of the moments a pin goes
   * dormant — so the retirement sweep runs here too and needs something real to read.
   */
  lines: [] as SalesOrderLineRow[],
  /** Every fulfilment-pin write the sweep performed, in call order. */
  lineSnapshotWrites: [] as Array<{ lineId: string; payload: unknown }>,
  /** Set when the fixture wants a journaled (Group B posted) shipment on the order. */
  journaledShipment: null as Row | null,
  deletedAllocationIds: [] as string[],
  /**
   * o3d-0i5y r11: what the LOCKED re-read of a (line, product) scope sees, keyed by warehouseId —
   * the late-landed-cost correction committing between this sweep's reads and its write. null =
   * every read sees the live row.
   */
  lockedScopeRecords: null as Record<string, unknown> | null,
  /** Every statement the transaction issued, in order. */
  txCalls: [] as string[],
}

function reset() {
  state.salesOrderUpdates.length = 0
  state.allocationUpdates.length = 0
  state.activity.length = 0
  state.txActivity.length = 0
  state.accountingSyncLogs.length = 0
  state.backorderCalls.length = 0
  state.allocations.length = 0
  state.shipments.length = 0
  state.shipmentLines.length = 0
  state.lines.length = 0
  state.lineSnapshotWrites.length = 0
  state.stockLevels.length = 0
  state.deletedAllocationIds.length = 0
  state.journaledShipment = null
  state.lockedScopeRecords = null
  state.txCalls.length = 0
  queuedAccountingSyncs.length = 0
  accountingSyncRows.length = 0
}

mock.module('next/cache', {
  namedExports: { revalidatePath: () => {} },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

/**
 * o3d-0i5y r11 — THE REVERSAL IS A JOURNAL, so the only assertion worth making about it is the
 * amount. `@/lib/accounting` is the connector-agnostic enqueue `reverseOrphanedAllocationPosting`
 * reaches for, dynamically at call time.
 *
 * The ATTEMPT and the ROW it writes are recorded separately, because production's
 * `queueAccountingSyncTx` writes nothing and throws nothing when no active connector posts the type,
 * when the posting is suppressed, or when the order went away under it. A double whose enqueue could
 * only ever succeed cannot exercise the verification that follows it.
 */
type QueuedAccountingSync = {
  type: string
  referenceType: string
  referenceId: string
  payload: {
    _reversalToken?: string
    lines?: Array<{ accountCode: string; debit?: number; credit?: number }>
  }
}
const queuedAccountingSyncs: QueuedAccountingSync[] = []
const accountingSyncRows: QueuedAccountingSync[] = []

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({ inventoryAccount: '630', allocatedInventoryAccount: '631' }),
    queueAccountingSyncTx: async (_tx: unknown, params: QueuedAccountingSync) => {
      queuedAccountingSyncs.push(params)
      accountingSyncRows.push(params)
      return true
    },
    isAccountingSyncTypeEnabled: async () => true,
    isDailyBatchPostingEnabled: async () => true,
  },
})

// Dynamically imported by the reconcile pass at the end of releaseOverallocations; stubbed so
// the test never reaches the real allocator (which would want a database).
//
// o3d-4kfh r5 (Codex finding 4): THIS MOCK IS WHY THE RETAINED-DRAFT STRAND WAS INVISIBLE HERE.
// Stubbing the allocator out entirely means this file can say nothing at all about whether the
// post-release repair actually runs — the strand lived inside `allocateBackordersForProducts`'s
// candidate filter, which this replaces. It now at least RECORDS the call, so a regression that
// stops dispatching the repair is visible; the filter itself is tested against its own doubles in
// tests/fulfillment/backorder-allocator.test.ts, which is the only place it can be.
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: {
    allocateBackordersForProducts: async (productIds: string[]) => {
      state.backorderCalls.push({ productIds: [...productIds] })
      return {}
    },
  },
})

function decimalLikeToNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return (value as { toNumber(): number }).toNumber()
}

const tx = {
  /**
   * o3d-0i5y r11: THREE call shapes reach here and they are not the same question. The sales-order
   * and stock-level locks want nothing back; `lockAccountedRecordsForScope` is a ROW-RETURNING lock
   * that hands back the record each row of a (line, product) scope holds AS OF THE LOCK — the base
   * the re-filing re-authors. Answering it with `[]`, as this double did while every raw statement
   * here was only ever a lock, hands the writer an EMPTY BASE: no record to trim, nothing orphaned,
   * and every reversal assertion below would decide nothing.
   */
  $queryRaw: async (...args: unknown[]) => {
    const first = args[0]
    const text = first && typeof first === 'object' && 'sql' in (first as Record<string, unknown>)
      ? String((first as { sql: unknown }).sql)
      : Array.isArray(first)
      ? first.join(' ')
      : String(first)
    const sql = text.replace(/\s+/g, ' ').trim()
    state.txCalls.push(`$queryRaw:${sql}`)
    if (sql.includes('order_allocations') && sql.includes('FOR UPDATE')) {
      const [orderId, lineId, productId] = ((first as { values?: unknown[] }).values ?? []) as string[]
      return state.allocations
        .filter((row) => row.orderId === orderId && row.lineId === lineId && row.productId === productId)
        .map((row) => ({
          lineId: row.lineId,
          productId: row.productId,
          warehouseId: row.warehouseId,
          costLayerSnapshot: state.lockedScopeRecords && row.warehouseId in state.lockedScopeRecords
            ? state.lockedScopeRecords[row.warehouseId]
            : row.costLayerSnapshot ?? null,
        }))
    }
    return []
  },
  // o3d-0i5y r11: the post-enqueue verification asks the DATABASE for the row the enqueue was
  // supposed to create, under that enqueue's own predicate — really searching the rows the enqueue
  // wrote and really honouring the `_reversalToken` JSON-path filter.
  accountingSyncLog: {
    findFirst: async ({ where }: {
      where: {
        type?: string
        referenceType?: string
        referenceId?: string
        payload?: { path: string[]; equals: unknown }
      }
    }) => accountingSyncRows.find((row) => {
      if (where.type != null && row.type !== where.type) return false
      if (where.referenceType != null && row.referenceType !== where.referenceType) return false
      if (where.referenceId != null && row.referenceId !== where.referenceId) return false
      if (where.payload != null) {
        const value = where.payload.path.reduce<unknown>(
          (node, key) => (node == null ? undefined : (node as Record<string, unknown>)[key]),
          row.payload,
        )
        if (value !== where.payload.equals) return false
      }
      return true
    }) ?? null,
    // o3d-o97 r4: the A2 journal probed by its own id. null = no row (retention took it, or the
    // fixture named none), which the un-stage reads as "cannot prove nothing was debited".
    findUnique: async ({ where }: { where: { id: string } }) => (
      state.accountingSyncLogs.find((row) => row.id === where.id) ?? null
    ),
  },
  activityLog: {
    create: async ({ data }: { data: Row }) => { state.txActivity.push(data); return data },
  },
  salesOrder: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const alloc = state.allocations.find((row) => row.orderId === where.id)
      return {
        orderNumber: alloc?.order.orderNumber ?? null,
        externalOrderNumber: alloc?.order.externalOrderNumber ?? null,
      }
    },
    update: async ({ data }: { data: Row }) => {
      state.salesOrderUpdates.push(data)
      return {}
    },
  },
  stockLevel: {
    findUnique: async ({ where }: { where: { productId_warehouseId: { productId: string; warehouseId: string } } }) => {
      const key = where.productId_warehouseId
      const row = state.stockLevels.find((candidate) => (
        candidate.productId === key.productId && candidate.warehouseId === key.warehouseId
      ))
      return row ? { ...row } : null
    },
    // Real decrement against real rows: a no-op double would let the release loop believe it had
    // given back units it never did, and `excess` would then never converge.
    updateMany: async ({ where, data }: {
      where: { productId: string; warehouseId: string }
      data: { reservedQty: { decrement?: unknown; increment?: unknown } }
    }) => {
      const rows = state.stockLevels.filter((row) => (
        row.productId === where.productId && row.warehouseId === where.warehouseId
      ))
      for (const row of rows) {
        row.reservedQty += decimalLikeToNumber(data.reservedQty.increment)
        row.reservedQty -= decimalLikeToNumber(data.reservedQty.decrement)
      }
      return { count: rows.length }
    },
  },
  // o3d-kouj: the dormant-pin retirement reads and clears this table.
  salesOrderLine: {
    findMany: async ({ where }: {
      where: { orderId?: string; fulfillmentRequirements?: { not: unknown } }
    }) => state.lines
      .filter((line) => where.orderId == null || line.orderId === where.orderId)
      // "carries a pin" — honoured, so a line that never had one is never even selected.
      .filter((line) => where.fulfillmentRequirements == null || line.fulfillmentRequirements != null)
      .map((line) => ({ id: line.id, fulfillmentRequirements: line.fulfillmentRequirements ?? null })),
    updateMany: async ({ where, data }: {
      where: { id: { in: string[] }; orderId?: string }
      data: { fulfillmentRequirements?: unknown }
    }) => {
      let count = 0
      for (const line of state.lines) {
        if (!where.id.in.includes(line.id)) continue
        if (where.orderId != null && line.orderId !== where.orderId) continue
        if ('fulfillmentRequirements' in data) {
          state.lineSnapshotWrites.push({ lineId: line.id, payload: data.fulfillmentRequirements })
          line.fulfillmentRequirements = undefined
        }
        count += 1
      }
      return { count }
    },
  },
  shipmentLine: {
    // The COMMITTED (non-PENDING) set, joined to its shipment for the warehouse. Honours the
    // `not: 'PENDING'` predicate, so a PENDING draft's lines are never mistaken for a commitment.
    findMany: async ({ where }: {
      where: {
        productId?: string
        lineId?: string | { in: string[] }
        shipment: { orderId?: string; warehouseId?: string; status: string | { not: string } }
      }
    }) => state.shipmentLines.flatMap((line) => {
      const shipment = state.shipments.find((row) => row.id === line.shipmentId)
      if (!shipment) return []
      if (where.lineId != null) {
        const matchesLine = typeof where.lineId === 'string'
          ? line.lineId === where.lineId
          : where.lineId.in.includes(line.lineId)
        if (!matchesLine) return []
      }
      if (where.shipment.orderId != null && shipment.orderId !== where.shipment.orderId) return []
      if (where.shipment.warehouseId != null && shipment.warehouseId !== where.shipment.warehouseId) return []
      if (where.productId != null && line.productId !== where.productId) return []
      const status = where.shipment.status
      const matches = typeof status === 'string' ? shipment.status === status : shipment.status !== status.not
      if (!matches) return []
      return [{
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
        shipment: { warehouseId: shipment.warehouseId },
      }]
    }),
  },
  shipment: {
    findFirst: async () => state.journaledShipment,
    // PENDING drafts with their own lines and label metadata, ordered oldest-first exactly as
    // production asks for them.
    findMany: async ({ where }: { where: { orderId: string; status?: string } }) => state.shipments
      .filter((shipment) => shipment.orderId === where.orderId)
      .filter((shipment) => where.status == null || shipment.status === where.status)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((shipment) => ({
        id: shipment.id,
        warehouseId: shipment.warehouseId,
        trackingNumber: shipment.trackingNumber,
        shippingService: shipment.shippingService,
        lines: state.shipmentLines
          .filter((line) => line.shipmentId === shipment.id)
          .map((line) => ({ lineId: line.lineId, productId: line.productId, qty: line.qty })),
      })),
    // Deletes for real AND cascades the lines, as the FK does. Leaving orphaned lines behind would
    // let a deleted draft keep answering every shipmentLine query.
    deleteMany: async ({ where }: { where: { id?: { in: string[] }; orderId?: string; status?: string } }) => {
      const doomed = state.shipments.filter((shipment) => {
        if (where.id && !where.id.in.includes(shipment.id)) return false
        if (where.orderId != null && shipment.orderId !== where.orderId) return false
        if (where.status != null && shipment.status !== where.status) return false
        return true
      })
      const doomedIds = new Set(doomed.map((shipment) => shipment.id))
      state.shipments = state.shipments.filter((shipment) => !doomedIds.has(shipment.id))
      state.shipmentLines = state.shipmentLines.filter((line) => !doomedIds.has(line.shipmentId))
      return { count: doomed.length }
    },
  },
  orderAllocation: {
    // Honours BOTH shapes production asks for: the release loop's
    // `{ productId, warehouseId, order: { status: { in } } }` scan, and the reconciler's
    // `{ orderId }`. A double that ignored the predicate would hand the reconciler another order's
    // rows and make an unbacked draft look backed.
    findMany: async ({ where }: {
      where: {
        productId?: string
        warehouseId?: string
        orderId?: string
        // o3d-0i5y r11: BOTH shapes, and they are different questions. The re-filing reads the rows
        // of ONE (line, product) scope as persisted (`lineId: string`); the dormant-pin sweep asks
        // which of a SET of pinned lines still holds a row (`{ in: [...] }`). Handling only the
        // string form silently answered the sweep with nothing, so every pinned line on the order
        // read as empty and had its recipe retired.
        lineId?: string | { in: string[] }
        order?: { status: { in: string[] } }
      }
    }) => state.allocations
      .filter((row) => where.productId == null || row.productId === where.productId)
      .filter((row) => where.warehouseId == null || row.warehouseId === where.warehouseId)
      .filter((row) => where.orderId == null || row.orderId === where.orderId)
      .filter((row) => {
        if (where.lineId == null) return true
        return typeof where.lineId === 'string' ? row.lineId === where.lineId : where.lineId.in.includes(row.lineId)
      })
      .filter((row) => where.order == null || where.order.status.in.includes(row.order.status))
      .slice()
      .sort((a, b) => (a.order.createdAt < b.order.createdAt ? 1 : -1))
      .map((row) => ({ ...row, order: { ...row.order } })),
    updateMany: async ({ data }: { data: Row }) => {
      state.allocationUpdates.push(data)
      return { count: 1 }
    },
    update: async ({ where, data }: {
      where: {
        id?: string
        // o3d-0i5y r11: the record write addresses the row by the compound unique, exactly as the
        // manual editor does. A double that understood only `{ id }` would throw on it.
        lineId_warehouseId_productId?: { lineId: string; warehouseId: string; productId: string }
      }
      data: { qty?: unknown; costLayerSnapshot?: unknown }
    }) => {
      const key = where.lineId_warehouseId_productId
      const row = where.id
        ? state.allocations.find((candidate) => candidate.id === where.id)
        : state.allocations.find((candidate) => (
          candidate.lineId === key!.lineId
          && candidate.warehouseId === key!.warehouseId
          && candidate.productId === key!.productId
        ))
      if (!row) throw new Error('allocation not found')
      state.txCalls.push(`orderAllocation.update:${row.id}:${'costLayerSnapshot' in data ? 'record' : 'row'}`)
      // The WRITTEN VALUE is honoured, never forced to null — forcing it would assert a destructive
      // rewrite as a requirement and make the trim unobservable. Round-trips through JSON as jsonb does.
      if ('costLayerSnapshot' in data) {
        row.costLayerSnapshot = data.costLayerSnapshot == null
          ? null
          : JSON.parse(JSON.stringify(data.costLayerSnapshot))
      }
      if (data.qty === undefined) return row
      // o3d-4kfh r7: `OrderAllocation.qty` is `@db.Decimal(12,4)` and Postgres rounds half-up on
      // write. Storing the caller's full precision let the double show a row IMS cannot hold, which
      // made "the row and reservedQty disagree by half an ulp" — the whole of Codex finding 4 —
      // impossible to observe here.
      row.qty = Math.round(decimalLikeToNumber(data.qty) * 10_000) / 10_000
      return row
    },
    delete: async ({ where }: { where: { id: string } }) => {
      state.txCalls.push(`orderAllocation.delete:${where.id}`)
      state.deletedAllocationIds.push(where.id)
      const index = state.allocations.findIndex((row) => row.id === where.id)
      if (index >= 0) state.allocations.splice(index, 1)
      return {}
    },
    count: async ({ where }: { where: { orderId: string } }) => state.allocations
      .filter((row) => row.orderId === where.orderId).length,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        // Phase 1 candidate gather, outside the transaction.
        findMany: async ({ where }: { where: { productId: string; warehouseId: string } }) => state.allocations
          .filter((row) => row.productId === where.productId && row.warehouseId === where.warehouseId)
          .map((row) => ({ orderId: row.orderId, order: { createdAt: new Date(row.order.createdAt) } })),
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  },
})

async function loadRebalancer() {
  return import('@/lib/fulfillment/overallocation-rebalancer')
}

function order(
  id: string,
  overrides: {
    status?: string
    createdAt?: string
    inventoryAllocatedDate?: Date | null
    // o3d-o97 r4: what A2 recorded for the order, which is what decides whether the un-stage below
    // may clear the stamp or must keep it.
    allocationBatchAmount?: number | null
    allocationBatchSyncLogId?: string | null
  } = {},
) {
  return {
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    status: overrides.status ?? 'ALLOCATED',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    inventoryAllocatedDate: overrides.inventoryAllocatedDate ?? null,
    allocationBatchAmount: overrides.allocationBatchAmount ?? null,
    allocationBatchSyncLogId: overrides.allocationBatchSyncLogId ?? null,
  }
}

function seedStagedOverallocation(
  a2: { allocationBatchAmount?: number | null; allocationBatchSyncLogId?: string | null; journalStatus?: string } = {},
) {
  // 1 unit on hand, 2 reserved by a single A2-staged order: excess 1, so the order's
  // allocation is fully released and the A2 un-stage branch runs.
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 2 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 1,
    order: order('order-1', {
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
      allocationBatchAmount: a2.allocationBatchAmount ?? null,
      allocationBatchSyncLogId: a2.allocationBatchSyncLogId ?? null,
    }),
  }]
  if (a2.allocationBatchSyncLogId && a2.journalStatus) {
    state.accountingSyncLogs.push({ id: a2.allocationBatchSyncLogId, status: a2.journalStatus })
  }
}

/** o3d-o97 r4: the record that the un-stage was WITHHELD because the A2 debit still stands. */
function stageRetainedEntries() {
  return state.txActivity.filter((entry) => entry.action === 'allocation_accounting_stage_retained')
}

/** The A2 un-stage write, distinguished from the ALLOCATED→PROCESSING status write. */
function unstageWrite() {
  return state.salesOrderUpdates.find((data) => 'inventoryAllocatedDate' in data)
}

function assertNoSwallowedFailure() {
  const failures = state.activity.filter((entry) => entry.action === 'overallocation_release_failed')
  assert.deepEqual(
    failures.map((entry) => entry.description),
    [],
    'releaseOverallocations swallows exceptions into an activity log — a failure here means the test never exercised the un-stage',
  )
}

/**
 * o3d-4kfh r5 (finding 7): read from `txActivity`, NOT `activity`. The retirement record is written
 * through the transaction client now, so a post-commit `logActivity` entry would mean the durable
 * write had been lost — reading the post-commit mock would hide exactly the regression this guards.
 */
function retirementEntries() {
  return state.txActivity.filter((entry) => entry.action === 'pending_shipments_retired')
}

function shipmentIds(): string[] {
  return state.shipments.map((shipment) => shipment.id).sort()
}

test('releaseOverallocations clears inventoryAllocatedBatchRef in the same update as the stamp (o3d-0qoo)', async () => {
  // o3d-o97 r4: the clear only happens where the A2 debit is positively known NOT to stand, so the
  // fixture says so. o3d-o97 r5: and it says so with A2's OWN RECORD — a recorded debit of exactly
  // £0.00 — rather than with a journal STATUS. r4 used a CANCELLED journal here, which is an
  // abandonment written by a sweep or an operator and proves nothing about whether pounds moved.
  reset()
  seedStagedOverallocation({ allocationBatchAmount: 0, allocationBatchSyncLogId: 'a2-log-1', journalStatus: 'CANCELLED' })
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 1, 'the overallocated unit was actually released')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-1'])

  const write = unstageWrite()
  assert.ok(write, 'the A2 un-stage write must have happened')
  // deepEqual, not a per-key lookup: it proves the ref key is PRESENT and null rather than
  // merely absent, which is exactly what an omitted Prisma field would look like.
  assert.deepEqual(write, {
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
    // o3d-o97 r3: the journal ATTRIBUTION goes in the same update as the amount it describes —
    // which journal row carried the debit, on which ledger, to which account. An order that is no
    // longer staged must not keep describing a posting the next A2 run has not made.
    allocationBatchSyncLogId: null,
    allocationBatchConnector: null,
    allocationBatchAccountCode: null,
  })
  // o3d-0i5y r10 asserted the OPPOSITE here — `state.allocationUpdates` empty, on the reasoning that
  // nulling every row's `costLayerSnapshot` makes Group A2 read an empty row and post the WHOLE
  // order again. That assertion is superseded rather than deleted (rebase onto o3d-o97 / PR #635):
  // the merged rule keeps the STAMP wherever the debit stands, and A2 selects only on
  // `inventoryAllocatedDate: null`, so it never looks at this order again and the second posting
  // r10 was defending against is unreachable. This test is the branch where the debit is proved NOT
  // to stand, so the record it clears is an empty one.
  assert.deepEqual(state.allocationUpdates.length, 1, 'and the cost snapshots are still nulled alongside it')
  assert.deepEqual(stageRetainedEntries(), [])
})

test('releaseOverallocations KEEPS the A2 stamp and its recorded debit when the journal POSTED (o3d-o97 r4)', async () => {
  // THE FINDING, on the rebalancer's copy of the same un-stage. Nulling the stamp here destroys the
  // only record of the £40 A2 put into Allocated Inventory AND puts the order back into the A2
  // window, where the next run raises a SECOND debit at the new pins. Only the second one has a
  // record, so a later refund's residue can only relieve that one and the first is stranded for
  // ever. The RELEASE still happens — the over-allocated unit is still given back — but the
  // accounting evidence survives it.
  reset()
  seedStagedOverallocation({ allocationBatchAmount: 40, allocationBatchSyncLogId: 'a2-log-1', journalStatus: 'SYNCED' })
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 1, 'the over-allocated unit is still released')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-1'])
  assert.equal(unstageWrite(), undefined, 'and no un-stage write happened at all — the £40 record stays')
  assert.equal(stageRetainedEntries().length, 1)
  assert.match(
    String(stageRetainedEntries()[0].description),
    /Group A2 debited Allocated Inventory £40\.00 for this order under journal a2-log-1 \(SYNCED\)/,
  )
  assert.equal(state.allocationUpdates.length, 1, 'the pins this pass changed are still cleared')
})

test('releaseOverallocations KEEPS the A2 stamp when the journal is CANCELLED too (o3d-o97 r5)', async () => {
  // r4 let one status through the gate: a CANCELLED journal cleared the stamp, the £40 and the
  // attribution outright. CANCELLED is written by the cross-connector orphan sweep, by an order
  // cancellation and by an operator, and a claimed row is retired without anyone being able to see
  // whether the remote call had already landed — the processors post BEFORE persisting SYNCED.
  //
  // WORKED. A2 debits £40 under a2-log-1, which reaches Xero; the row is later marked CANCELLED.
  // The rebalancer then releases an over-allocated unit:
  //   r4  the stamp and the £40 are nulled, so Group A2 — which selects on
  //       `inventoryAllocatedDate: null` — re-values the order at its new pins and raises a SECOND
  //       debit. Allocated Inventory holds both; only the second is on record; the first is
  //       stranded for ever with its only evidence deleted by the same write.
  //   r5  the release still happens and the record survives it.
  reset()
  seedStagedOverallocation({ allocationBatchAmount: 40, allocationBatchSyncLogId: 'a2-log-1', journalStatus: 'CANCELLED' })
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 1, 'the over-allocated unit is still released')
  assert.equal(unstageWrite(), undefined, 'and no un-stage write happened at all — the £40 record stays')
  assert.equal(stageRetainedEntries().length, 1)
  assert.match(
    String(stageRetainedEntries()[0].description),
    /£40\.00 debit is recorded CANCELLED, which says the row was abandoned and not that the ledger was never reached/,
  )
  assert.equal(state.allocationUpdates.length, 1, 'the pins this pass changed are still cleared')
})

test('releaseOverallocations KEEPS the A2 stamp for an order staged before the attribution existed (o3d-o97 r4)', async () => {
  // The legacy shape, and the one every order in the database has on the day this ships: a stamp
  // and a recorded amount, but no journal id. Nothing can retroactively prove that batch never
  // posted, so the record is kept — the reading that cannot strand pounds.
  reset()
  seedStagedOverallocation({ allocationBatchAmount: 40 })
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(unstageWrite(), undefined)
  assert.equal(stageRetainedEntries().length, 1)
  assert.match(String(stageRetainedEntries()[0].description), /named no journal/)
})

test('releaseOverallocations skips the order entirely when a shipment is journaled (o3d-0qoo)', async () => {
  // Group B posted means the release is refused, so neither the stamp nor the ref is touched —
  // the order stays findable against its A2 batch rather than silently losing the handle.
  reset()
  seedStagedOverallocation()
  state.journaledShipment = { id: 'shipment-1' }
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'transfer_dispatch', referenceId: 'tr-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 0)
  assert.equal(result.skipped, 1)
  assert.equal(unstageWrite(), undefined, 'no un-stage write at all on the refused path')
  assert.deepEqual(state.deletedAllocationIds, [], 'and the allocation survives')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r4 (Codex finding 2) — the release must retire ONLY the drafts it unbacked.
// ---------------------------------------------------------------------------

/**
 * One order with two independent drafts: A@W1 (the SKU about to lose stock) and B@W2 (an unrelated
 * product in another warehouse, fully backed by its own allocation row and carrying a purchased
 * label). Codex's worked example.
 */
function seedTwoWarehouseOrder() {
  state.stockLevels = [
    { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 },
    { productId: 'product-b', warehouseId: 'warehouse-2', quantity: 3, reservedQty: 3 },
  ]
  state.allocations = [
    {
      id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-1'),
    },
    {
      id: 'alloc-b', orderId: 'order-1', lineId: 'line-b', productId: 'product-b',
      warehouseId: 'warehouse-2', qty: 3, order: order('order-1'),
    },
  ]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'draft-b', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'PENDING', trackingNumber: 'TRACK-B', shippingService: 'DPD Next Day', createdAt: '2026-01-02T00:00:00Z' },
  ]
  state.shipmentLines = [
    { id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 2 },
    { id: 'sl-b', shipmentId: 'draft-b', lineId: 'line-b', productId: 'product-b', qty: 3 },
  ]
}

test('o3d-4kfh r4: releasing A@W1 does not destroy the unrelated, still-backed B@W2 draft', async () => {
  reset()
  seedTwoWarehouseOrder()
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2, 'A@W1 is fully released — its stock went to zero')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-a'])
  assert.deepEqual(shipmentIds(), ['draft-b'], 'B@W2 survives: its own allocation row still backs it')
  assert.equal(
    state.shipments[0].trackingNumber,
    'TRACK-B',
    'and it keeps the tracking number — the blanket delete threw this away',
  )
  assert.deepEqual(
    state.shipmentLines.map((line) => line.id),
    ['sl-b'],
    'only the retired draft\'s lines cascade away',
  )
})

test('o3d-4kfh r4: the retirement is logged with shipment identity and tracking number, not a bare count', async () => {
  // The whole point of the metadata: an externally purchased label on a retired draft has to be
  // correlatable from the activity log, because IMS no longer holds the row.
  reset()
  seedTwoWarehouseOrder()
  // This time BOTH warehouses lose their stock, so both drafts go — and the one with the label is
  // the one the operator has to act on.
  state.stockLevels = [
    { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 },
    { productId: 'product-b', warehouseId: 'warehouse-2', quantity: 0, reservedQty: 3 },
  ]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [
      { productId: 'product-a', warehouseId: 'warehouse-1' },
      { productId: 'product-b', warehouseId: 'warehouse-2' },
    ],
    { source: 'stock_adjustment', referenceId: 'adj-1', referenceLabel: 'stock adjustment ADJ-1' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(shipmentIds(), [], 'both drafts lost their backing')
  const entries = retirementEntries()
  assert.equal(entries.length, 2, 'one entry per release pass that retired something')
  const withLabel = entries.find((entry) => {
    const metadata = entry.metadata as { retiredTrackingNumbers?: string[] }
    return (metadata.retiredTrackingNumbers ?? []).includes('TRACK-B')
  })
  assert.ok(withLabel, 'the label-carrying retirement is recorded with its tracking number')
  const metadata = withLabel!.metadata as Record<string, unknown>
  assert.deepEqual(metadata.retiredShipments, [{
    shipmentId: 'draft-b',
    warehouseId: 'warehouse-2',
    trackingNumber: 'TRACK-B',
    shippingService: 'DPD Next Day',
    lineCount: 1,
    totalQty: 3,
  }])
  assert.match(String(withLabel!.description), /draft-b/)
  assert.match(String(withLabel!.description), /cancel the label/)
})

test('o3d-4kfh r4: a PARTIAL release retires the draft it no longer fully backs', async () => {
  // 5 allocated, stock drops to 3: the row is trimmed to 3 and the 5-unit draft no longer fits.
  // Trimming the draft instead would silently ship less than the operator confirmed, so it goes
  // whole and the operator re-runs confirm-for-picking.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 5 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 5, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 5 }]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2)
  assert.equal(state.allocations[0].qty, 3, 'the row is trimmed, not deleted')
  assert.deepEqual(shipmentIds(), [], 'and the 5-unit draft it no longer covers is retired')
})

test('o3d-4kfh r4: a release that leaves the draft fully backed retires nothing at all', async () => {
  // The complement — and the property the blanket delete could never have: trimming 5 -> 3 with a
  // 3-unit draft invalidates nothing, so the draft and its label stay put and no warning is logged.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 5 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 5, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: 'TRACK-A', shippingService: 'DPD', createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 3 }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(shipmentIds(), ['draft-a'])
  assert.equal(state.shipments[0].trackingNumber, 'TRACK-A')
  assert.deepEqual(retirementEntries(), [], 'nothing retired, nothing logged')
})

test('o3d-4kfh r4: an UNTOUCHED order on the same SKU keeps its drafts', async () => {
  // The release loop is newest-order-first and stops as soon as the excess is covered. An older
  // order that was never touched must not have its drafts swept up — the blanket delete only
  // avoided this by accident (it was keyed on the released order), and the per-order reconciliation
  // makes it explicit.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 4 }]
  state.allocations = [
    {
      id: 'alloc-new', orderId: 'order-new', lineId: 'line-new', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-new', { createdAt: '2026-02-01T00:00:00Z' }),
    },
    {
      id: 'alloc-old', orderId: 'order-old', lineId: 'line-old', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-old', { createdAt: '2026-01-01T00:00:00Z' }),
    },
  ]
  state.shipments = [
    { id: 'draft-new', orderId: 'order-new', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-02-01T00:00:00Z' },
    { id: 'draft-old', orderId: 'order-old', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: 'TRACK-OLD', shippingService: 'DPD', createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [
    { id: 'sl-new', shipmentId: 'draft-new', lineId: 'line-new', productId: 'product-a', qty: 2 },
    { id: 'sl-old', shipmentId: 'draft-old', lineId: 'line-old', productId: 'product-a', qty: 2 },
  ]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2, 'the newest order gives back the whole excess')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-new'])
  assert.deepEqual(shipmentIds(), ['draft-old'], 'the older, untouched order keeps its draft')
  assert.equal(state.shipments[0].trackingNumber, 'TRACK-OLD')
})

test('o3d-4kfh r4: a COMMITTED shipment on the released order is never deleted', async () => {
  // The reconciliation only ever looks at PENDING rows. A PICKING draft is a commitment the
  // warehouse is already acting on — and this order's allocation is skipped for exactly that
  // reason, so nothing about it changes.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 2, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'picking-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'picking-a', lineId: 'line-a', productId: 'product-a', qty: 2 }]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 0, 'the committed allocation is skipped')
  assert.equal(result.skipped, 1)
  assert.deepEqual(shipmentIds(), ['picking-a'], 'and its shipment is untouched')
  assert.deepEqual(retirementEntries(), [])
})

// ---------------------------------------------------------------------------
// o3d-4kfh r5 (Codex finding 4) — a RETAINED draft must not stop the post-release repair.
// ---------------------------------------------------------------------------

test('o3d-4kfh r5: a KIT leaf release retains the unrelated draft AND still dispatches the repair pass', async () => {
  // The strand, end to end from this side. A KIT line holds leaf A and leaf B; only A's stock drops,
  // so this pass trims A alone and leaves B disproportionate — a half-kit reservation. The repair is
  // `allocateBackordersForProducts`, which rebuilds the order through autoAllocateOrder.
  //
  // The order also carries a PENDING draft in ANOTHER warehouse that is still fully backed, so the
  // selective reconciler deliberately KEEPS it. Under the old blanket `shipments: { none: {} }`
  // candidate filter plus `refuseIfShipmentsExist`, that retained draft made the repair a no-op and
  // B's reservation stayed stranded until it failed integrity at confirm-for-picking.
  //
  // What this file can assert is that the retention happens and the repair is DISPATCHED with the
  // right product. Whether the repair is then accepted lives in the allocator's candidate filter and
  // is tested in tests/fulfillment/backorder-allocator.test.ts — mocking the allocator here is
  // exactly why this defect was invisible in this file.
  reset()
  state.stockLevels = [
    { productId: 'kit-leaf-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 },
    { productId: 'kit-leaf-b', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 },
    { productId: 'product-c', warehouseId: 'warehouse-2', quantity: 4, reservedQty: 4 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-kit', productId: 'kit-leaf-a', warehouseId: 'warehouse-1', qty: 2, order: order('order-1') },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-kit', productId: 'kit-leaf-b', warehouseId: 'warehouse-1', qty: 1, order: order('order-1') },
    { id: 'alloc-c', orderId: 'order-1', lineId: 'line-c', productId: 'product-c', warehouseId: 'warehouse-2', qty: 4, order: order('order-1') },
  ]
  state.shipments = [{
    id: 'draft-c', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'PENDING',
    trackingNumber: 'TRACK-C', shippingService: 'DPD', createdAt: '2026-01-01T00:00:00Z',
  }]
  state.shipmentLines = [{ id: 'sl-c', shipmentId: 'draft-c', lineId: 'line-c', productId: 'product-c', qty: 4 }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'kit-leaf-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-kit', referenceLabel: 'stock adjustment ADJ-KIT' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(shipmentIds(), ['draft-c'], 'the unrelated, still-backed draft is RETAINED')
  assert.deepEqual(retirementEntries(), [], 'and nothing was retired, so nothing was recorded')
  assert.deepEqual(
    state.allocations.map((row) => [row.productId, row.qty]),
    [['kit-leaf-b', 1], ['product-c', 4]],
    'leaf A is released and leaf B is left disproportionate — this is the state needing repair',
  )
  assert.deepEqual(
    state.backorderCalls,
    [{ productIds: ['kit-leaf-a'] }],
    'the repair pass is dispatched for the released leaf',
  )
})

// ---------------------------------------------------------------------------
// o3d-4kfh r7 (Codex finding 4) — the rebalancer is a producer of `OrderAllocation.qty` too.
// ---------------------------------------------------------------------------

test('o3d-4kfh r7: a partial release decrements reservedQty by what the ROW actually gave up', async () => {
  // `excess` is `reservedQty − quantity`, and `reservedQty` carries more decimal places than
  // `OrderAllocation.qty` can hold. Writing `allocQty − release` therefore rounded the row while
  // the stock decrement used the unrounded figure, leaving the two books permanently apart on an
  // aggregate shared with every other order in the scope.
  //
  // 8 allocated, 7.666655 on hand: excess 0.333345, which the 4dp column cannot express. The row
  // can only go to 7.6667, i.e. give up 0.3333 — so 0.3333 is the only correct decrement.
  reset()
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 7.666655, reservedQty: 8 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 8,
    order: order('order-1'),
  }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(state.allocations[0].qty, 7.6667, 'the row holds what numeric(12,4) can hold')
  const reserved = state.stockLevels[0].reservedQty
  assert.ok(
    Math.abs(reserved - state.allocations[0].qty) < 1e-9,
    `reservedQty ${reserved} must equal the only allocation row backing it (${state.allocations[0].qty}) — `
    + 'a difference here is stock this order neither holds nor released, sitting on a shared aggregate',
  )
})

test('o3d-kouj: the rebalancer retires the pin on a line it emptied, and leaves the other alone', async () => {
  // Releasing A@W1 deletes line-a's LAST allocation row, so line-a's pinned recipe now certifies
  // nothing — and the next allocation of that line will expand the CURRENT graph. Until the pin is
  // retired, every reader keeps answering from the old recipe instead. line-b keeps its row, and
  // therefore keeps its pin: this is a per-line rule, not a per-order one.
  reset()
  seedTwoWarehouseOrder()
  const pinA = {
    version: 1, productId: 'product-a', graphVersion: 3,
    capturedAt: '2026-08-01T00:00:00.000Z', requirements: [{ productId: 'component-1', factor: '2' }],
  }
  const pinB = {
    version: 1, productId: 'product-b', graphVersion: 4,
    capturedAt: '2026-08-01T00:00:00.000Z', requirements: [{ productId: 'component-2', factor: '1' }],
  }
  state.lines = [
    { id: 'line-a', orderId: 'order-1', fulfillmentRequirements: pinA },
    { id: 'line-b', orderId: 'order-1', fulfillmentRequirements: pinB },
  ]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(state.deletedAllocationIds, ['alloc-a'], 'only line-a lost its row')
  assert.equal(
    state.lines.find((line) => line.id === 'line-a')?.fulfillmentRequirements,
    undefined,
    'so line-a\'s pin is retired',
  )
  assert.deepEqual(
    state.lines.find((line) => line.id === 'line-b')?.fulfillmentRequirements,
    pinB,
    'while line-b still holds a row, so its pin is untouchable',
  )
  assert.deepEqual(
    state.lineSnapshotWrites.map((write) => write.lineId),
    ['line-a'],
    'and exactly one line was written to',
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-0i5y r11 (Codex round 11, finding 2) — THE UNITS THIS SWEEP REMOVES TAKE THEIR SHARE OF
// GROUP A2'S DEBIT WITH THEM.
//
// r10 stopped this sweep ERASING the record (its private copy of the old blanket reset nulled
// `costLayerSnapshot` on every row of the order, so one unit released off ten re-posted all ten)
// and left the debit of the removed units stranded, naming the prerequisite: the sweep row-locked
// `sales_orders` with raw SQL rather than through `lockSalesOrder`, so `queueAccountingSyncTx`'s
// hoisted-lock assertion would have refused the enqueue.
//
// Every assertion below is on the AMOUNT, because that is what the defect is: pounds sitting in
// Allocated Inventory that nothing downstream will ever relieve — Group B credits only what ships,
// and a refund credits only what is taken back.
// ---------------------------------------------------------------------------------------------

/** What A2 wrote when it posted these units: the pin, AND the amount it posted for each one. */
const POSTED_AT_FOUR = (qty: string) => [{
  costLayerId: 'layer-1',
  qty,
  unitCostBase: '4.000000',
  postedUnitCostBase: '4.000000',
}]

async function recordedUnitsOn(allocationId: string): Promise<string> {
  const { parseCostLayerSnapshot, sumCostLayerSnapshotQty } = await import('@/lib/cost-layer-snapshots')
  const row = state.allocations.find((candidate) => candidate.id === allocationId)
  return sumCostLayerSnapshotQty(parseCostLayerSnapshot(row?.costLayerSnapshot ?? null)).toString()
}

function reversalLines(): Array<[string, number | null, number | null]> | undefined {
  return queuedAccountingSyncs[0]?.payload.lines?.map((line) => [line.accountCode, line.debit ?? null, line.credit ?? null])
}

test('o3d-0i5y r11: a PARTIAL over-allocation release reverses the A2 debit of the units it removed', async () => {
  // Product P at W1: 10 units allocated to SO-1, pinned and posted by A2 at £4 — £40 of DR Allocated
  // / CR Inventory. A stock adjustment drops the shelf to 6, so this sweep releases 4.
  //
  // BEFORE r11 the row was trimmed to 6 and still RECORDED 10: Group B credits Allocated 6 x £4 =
  // £24 when those six ship, the other four are never invoiced so no refund ever sees them, and £16
  // of a real debit sits in Allocated Inventory for ever with Inventory understated by the same £16.
  reset()
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
    order: order('order-1', { inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z') }),
  }]
  state.lines = [{ id: 'line-1', orderId: 'order-1' }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(state.allocations[0].qty, 6, 'the row keeps the six units the shelf can still back')
  assert.equal(state.stockLevels[0].reservedQty, 6, 'and the reservation follows it')
  assert.equal(await recordedUnitsOn('alloc-1'), '6', 'the record is trimmed to the units the row still holds')
  assert.equal(queuedAccountingSyncs.length, 1, 'and the four units that left are reversed')
  assert.equal(queuedAccountingSyncs[0].type, 'ALLOCATION_REVERSAL')
  assert.equal(queuedAccountingSyncs[0].referenceId, 'order-1')
  assert.deepEqual(
    reversalLines(),
    [
      ['630', 16, null],
      ['631', null, 16],
    ],
    'DR Inventory £16 / CR Allocated Inventory £16 — 4 units at the £4 A2 recorded posting, leaving '
    + 'exactly the £24 Group B will relieve when the remaining six ship',
  )
})

test('o3d-0i5y r11: a WHOLE-ROW release reverses the whole posted debit', async () => {
  // The limiting case: the shelf goes to nothing, the row is deleted outright and the record dies
  // with it, so before r11 nothing surviving could even say the £40 had been posted.
  //
  // The order carries NO A2 stamp here, deliberately and reachably: an earlier release on the same
  // order cleared the stamp alone (r10) and left the record standing. The evidence a reversal needs
  // is the RECORD — `postedUnitCostBase`, written by the posting it stands for — never the stamp,
  // which is a claim about what remains to be done.
  reset()
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
    order: order('order-1'),
  }]
  state.lines = [{ id: 'line-1', orderId: 'order-1' }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-2' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(state.deletedAllocationIds, ['alloc-1'], 'the row is gone')
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(queuedAccountingSyncs.length, 1)
  assert.deepEqual(
    reversalLines(),
    [
      ['630', 40, null],
      ['631', null, 40],
    ],
    'DR Inventory £40 / CR Allocated Inventory £40 — the whole recorded debit, at what A2 recorded posting',
  )
  assert.equal(
    state.txCalls.indexOf('orderAllocation.delete:alloc-1') >= 0
    && state.txCalls.findIndex((call) => call.includes('order_allocations') && call.includes('FOR UPDATE'))
      < state.txCalls.indexOf('orderAllocation.delete:alloc-1'),
    true,
    'and the record was read under its row lock BEFORE the delete — after it, the record is unreadable',
  )
})

test('o3d-0i5y r11: the sweep hoists the order lock through lockSalesOrder, which is what lets it enqueue', async () => {
  // The raw `SELECT ... FOR UPDATE` this replaced took the same lock and told nothing. The registry
  // `queueAccountingSyncTx` asserts against is in-process and only `lockSalesOrder` writes to it, so
  // without this the enqueue refuses by design — and the refusal is swallowed by the per-item catch,
  // which is why the failure log is asserted empty rather than trusted.
  reset()
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-lock',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
    order: order('order-lock'),
  }]
  state.lines = [{ id: 'line-1', orderId: 'order-lock' }]
  const { releaseOverallocations } = await loadRebalancer()
  const { hasLockedSalesOrder } = await import('@/lib/domain/sales/allocation-service')

  await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-3' },
  )

  assertNoSwallowedFailure()
  assert.equal(
    hasLockedSalesOrder(tx as unknown as never, 'order-lock'),
    true,
    'the order is recorded as locked BY THIS TRANSACTION, which is the fact the enqueue assertion reads',
  )
  assert.equal(queuedAccountingSyncs.length, 1, 'so the reversal is actually queued rather than refused')
  assert.deepEqual(reversalLines(), [['630', 16, null], ['631', null, 16]])
})
