import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-4kfh — updateAllocation (the manual allocation editor) is the third release site, and the
 * one with NO shipment guard of any kind. It released `alloc.qty` verbatim: on a partially
 * dispatched line that is more than the order still holds, so the guarded decrement matched
 * nothing and the old floor branch zeroed the whole (product, warehouse) scope — taking every
 * other order's reservation with it.
 */

type StockLevelRow = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
type AllocationRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  /**
   * o3d-4kfh r6: the graph version this row was expanded against. `NOT NULL DEFAULT 0` in the
   * schema, so a real read NEVER returns undefined — the double defaults it for the same reason.
   * Leaving it undefined made every row read as stale against a product at 0, which is a defect in
   * the double, not a behaviour to encode.
   */
  fulfillmentGraphVersion?: number
  /**
   * o3d-0i5y r10: Group A2's RECORD — the units it has debited Allocated Inventory for, and
   * (through `postedUnitCostBase`) the amount it debited. `undefined` is the NULL of a row A2 has
   * never posted for.
   */
  costLayerSnapshot?: unknown
}
type ShipmentLineRow = { lineId: string; productId: string; warehouseId: string; status: string; qty: number }
type SalesOrderLineRow = {
  id: string
  orderId: string
  productId: string
  qty: number
  sku: string
  /** o3d-kouj: the line's PINNED fulfilment recipe; undefined is the NULL of a never-allocated line. */
  fulfillmentRequirements?: unknown
}
/** A PENDING draft, with the label metadata a retirement has to report (o3d-4kfh r4). */
type PendingShipmentRow = {
  id: string
  orderId: string
  warehouseId: string
  trackingNumber: string | null
  shippingService: string | null
  createdAt: string
  lines: Array<{ lineId: string; productId: string; qty: number }>
}

const state = {
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipmentLines: [] as ShipmentLineRow[],
  // The order's real lines. validateAllocationIntegrity runs at the end of EVERY updateAllocation
  // call; a double returning [] here made it exit at `lines.length === 0` before it compared
  // anything, so every assertion about the post-edit state was made against a validator that had
  // been switched off (Codex review of o3d-4kfh).
  lines: [] as SalesOrderLineRow[],
  /** o3d-kouj: every fulfilment-requirement pin written, in order. */
  lineSnapshotWrites: [] as Array<{ lineId: string; payload: unknown }>,
  /**
   * o3d-4kfh r7 (Codex finding 1): `Product.fulfillmentGraphVersion`, keyed by productId, served
   * from `product.findMany` — the graph read.
   *
   * It used to be served from `salesOrderLine.findMany` as `product: { fulfillmentGraphVersion }`,
   * mirroring a `select` production has now dropped: validation reading the version from a
   * different statement than the graph it validates against IS the defect r7 closes, so a double
   * that still offered it there would have kept passing after a revert of the fix. The version and
   * the component list must come out of the same answer here for the same reason they must in
   * Postgres.
   */
  graphVersions: {} as Record<string, number>,
  /**
   * THE OTHER SNAPSHOT (o3d-4kfh r7). What a `salesOrderLine.findMany` with
   * `product: { select: { fulfillmentGraphVersion } }` would have returned — i.e. the value the
   * r6 code read, one statement EARLIER than the graph.
   *
   * Under READ COMMITTED those two statements can straddle a component-graph edit, and then they
   * disagree. Setting this to a different number than `graphVersions` is how a test models that
   * interleaving; leaving it unset makes the two agree, which is the uncontended case. The double
   * keeps offering the field precisely so that reverting the fix makes the affected tests PASS
   * again — a double that stopped offering it would have made the revert crash instead of
   * demonstrating the hole.
   */
  lineProductGraphVersions: {} as Record<string, number>,
  /** productId -> component list. Absent products are fulfilment leaves (o3d-4kfh r7). */
  kits: {} as Record<string, Array<{ componentId: string; qty: number }>>,
  // Set by the concurrency test only: the snapshot the NON-transactional pre-read still sees after
  // a second editor has already committed. null = read the live rows like every other test.
  staleOuterAllocations: null as AllocationRow[] | null,
  // o3d-4kfh r4: the order's PENDING drafts. updateAllocation had NO draft cleanup at all, so a
  // double without them could not observe the defect in either direction.
  pendingShipments: [] as PendingShipmentRow[],
  /** Every activity-log entry, so the retirement record can be asserted rather than assumed. */
  activity: [] as Record<string, unknown>[],
  /**
   * o3d-4kfh r5 (finding 7): entries written through the TRANSACTION client. The retirement record
   * moved here from the post-commit `logActivity` above, because that one swallows its own failures
   * and could lose a purchased label's identity after the rows were already gone.
   */
  txActivity: [] as Record<string, unknown>[],
}

function decimalLikeToNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return (value as { toNumber(): number }).toNumber()
}

/**
 * o3d-0i5y r10 — THE REVERSAL IS A JOURNAL, so the only assertion worth making about it is the
 * amount. `@/lib/accounting` is the connector-agnostic enqueue `reverseOrphanedAllocationPosting`
 * reaches for, dynamically at call time, which is why registering the mock here works.
 *
 * The ATTEMPT and the ROW it writes are recorded separately, because that separation is the whole
 * of Codex finding 3: production's `queueAccountingSyncTx` writes nothing and throws nothing when
 * no active connector posts the type, when the posting is suppressed, or when the order was deleted
 * under it. A double whose enqueue could only ever succeed could not exercise the verification.
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
let accountingEnqueueOutcome: 'writes' | 'silent-no-op' = 'writes'

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({ inventoryAccount: '630', allocatedInventoryAccount: '631' }),
    queueAccountingSyncTx: async (_tx: unknown, params: QueuedAccountingSync) => {
      queuedAccountingSyncs.push(params)
      if (accountingEnqueueOutcome === 'silent-no-op') return false
      accountingSyncRows.push(params)
      return true
    },
    isAccountingSyncTypeEnabled: async () => true,
    isDailyBatchPostingEnabled: async () => true,
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
  },
})
mock.module('@/lib/auth/server', {
  // o3d-4kfh r5: production's requirePermission RETURNS the AuthSession (lib/auth/server.ts), and
  // the allocation actions now read session.user.id to attribute the draft-retirement audit row. A
  // double returning undefined models an API that does not exist.
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-test', role: 'ADMIN' } }),
    requireAuth: async () => ({ user: { id: 'user-test', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushOrderDeliveryMetadata: async () => {},
  },
})

const tx = {
  $queryRaw: async () => [],
  // o3d-0i5y r10: the post-enqueue verification asks the DATABASE for the row the enqueue was
  // supposed to create, under that enqueue's own predicate. It really searches the rows the enqueue
  // wrote and really honours the `_reversalToken` JSON-path filter, so the answer is decided in
  // production rather than hardcoded here.
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
  },
  activityLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      state.txActivity.push(data)
      return data
    },
  },
  salesOrder: {
    findUnique: async () => ({
      inventoryAllocatedDate: null,
      orderNumber: 'SO-1',
      externalOrderNumber: null,
    }),
    update: async () => ({}),
  },
  shipment: {
    findFirst: async () => null,
    // Honours the PENDING equality predicate and returns each draft's own lines plus its label
    // metadata, because that is exactly what `reconcilePendingShipments` reads. A double that
    // returned `[]` here (or ignored the status) would make every draft assertion below vacuous.
    findMany: async ({ where }: { where: { orderId: string; status?: string } }) => state.pendingShipments
      .filter((shipment) => shipment.orderId === where.orderId)
      .filter(() => where.status == null || where.status === 'PENDING')
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((shipment) => ({
        id: shipment.id,
        warehouseId: shipment.warehouseId,
        trackingNumber: shipment.trackingNumber,
        shippingService: shipment.shippingService,
        lines: shipment.lines.map((line) => ({ ...line })),
      })),
    // Real deletion, and it takes the draft's lines with it as the FK cascade does. Returning a
    // hard-coded `{ count: 0 }` here is precisely the vacuous double that hid the rebalancer's
    // destructive behaviour for a whole review round.
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = state.pendingShipments.length
      state.pendingShipments = state.pendingShipments.filter((shipment) => !where.id.in.includes(shipment.id))
      return { count: before - state.pendingShipments.length }
    },
  },
  salesOrderLine: {
    // o3d-kouj: `addAllocation` reads the ONE line it is about to pin, scoped by BOTH id and
    // orderId — a line belonging to another order must come back as ABSENT here, or the double
    // would hide the cross-order write the scoping exists to refuse.
    findFirst: async ({ where }: { where: { id?: string; orderId?: string } }) => state.lines
      .filter((line) => where.id == null || line.id === where.id)
      .filter((line) => where.orderId == null || line.orderId === where.orderId)
      .map((line) => ({
        id: line.id,
        productId: line.productId,
        qty: line.qty,
        sku: line.sku,
        description: line.sku,
        fulfillmentRequirements: line.fulfillmentRequirements ?? null,
      }))[0] ?? null,
    // o3d-kouj: the dormant-pin sweep selects only lines that CARRY a pin, so the filter is
    // honoured rather than ignored — a double that returned every line would make the sweep look
    // like it examined rows Postgres never hands it.
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
    findMany: async ({ where }: {
      where: {
        orderId?: string
        id?: string | { in: string[] }
        fulfillmentRequirements?: { not: unknown }
      }
    }) => state.lines
      .filter((line) => where.orderId == null || line.orderId === where.orderId)
      .filter((line) => {
        if (where.id == null) return true
        return typeof where.id === 'string' ? line.id === where.id : where.id.in.includes(line.id)
      })
      .filter((line) => where.fulfillmentRequirements == null || line.fulfillmentRequirements != null)
      .map((line) => ({
        id: line.id,
        productId: line.productId,
        qty: line.qty,
        sku: line.sku,
        description: line.sku,
        fulfillmentRequirements: line.fulfillmentRequirements ?? null,
        // The r6 read, kept alive on purpose — see `state.lineProductGraphVersions`.
        product: {
          fulfillmentGraphVersion:
            state.lineProductGraphVersions[line.productId] ?? state.graphVersions[line.productId] ?? 0,
        },
      })),
    // o3d-kouj: the pin write, mutating the SAME rows `findMany` answers from and round-tripping
    // through JSON as jsonb does.
    update: async ({ where, data }: { where: { id: string }; data: { fulfillmentRequirements?: unknown } }) => {
      const line = state.lines.find((row) => row.id === where.id)
      if (!line) throw new Error(`salesOrderLine.update: no line ${where.id}`)
      if ('fulfillmentRequirements' in data) {
        state.lineSnapshotWrites.push({ lineId: where.id, payload: data.fulfillmentRequirements })
        line.fulfillmentRequirements = JSON.parse(JSON.stringify(data.fulfillmentRequirements))
      }
      return line
    },
  },
  // SIMPLE unless `state.kits` says otherwise. validateAllocationIntegrity really does load the
  // graph, so it has to be answerable — and `addAllocation` EXPANDS it, so a double that could only
  // answer SIMPLE could never exercise the fractional-component arithmetic (o3d-4kfh r7).
  product: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => {
      const components = state.kits[id]
      return {
        id,
        type: components ? 'KIT' : 'SIMPLE',
        // o3d-4kfh r7: out of the SAME answer as `productComponents`, which is the whole point of
        // the column living on the graph node. `NOT NULL DEFAULT 0`, so a real read never nulls.
        fulfillmentGraphVersion: state.graphVersions[id] ?? 0,
        productComponents: (components ?? []).map((component, index) => ({
          componentId: component.componentId,
          qty: component.qty,
          component: { sku: component.componentId, type: 'SIMPLE', oversellAllowed: false },
          sortOrder: index,
        })),
      }
    }),
  },
  shipmentLine: {
    // Honours BOTH status shapes production asks for, and they are not the same question:
    // `status: 'SHIPPED'` is the reservation residual (the only status that gives reservation
    // back), `status: { not: 'PENDING' }` is committed demand. A double that understood only one
    // of them would answer the other with the wrong set (o3d-4kfh).
    findMany: async ({ where }: {
      where: { shipment: { status: string | { not: string } }; lineId?: string | { in: string[] } }
    }) => state.shipmentLines
      .filter((line) => (
        typeof where.shipment.status === 'string'
          ? line.status === where.shipment.status
          : line.status !== where.shipment.status.not
      ))
      // BOTH lineId shapes. `addAllocation` asks about ONE line by plain string; the coverage and
      // residual readers ask with `{ in: [...] }`. Handling only the set form threw on the string
      // form — invisible for as long as every fixture that reached it had no shipment lines at all,
      // which is a hole in the double rather than a behaviour.
      .filter((line) => {
        if (where.lineId == null) return true
        return typeof where.lineId === 'string'
          ? line.lineId === where.lineId
          : where.lineId.in.includes(line.lineId)
      })
      .map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
        // The STATUS is part of the row, not just of the filter. loadCommittedAllocationLines
        // fetches the non-PENDING set once and splits it into "committed" (the edit floor) and
        // "dispatched" (the reservation delta) by this field — a double that omitted it made every
        // line look un-dispatched, so the residual silently became the whole row (o3d-4kfh r2).
        shipment: { warehouseId: line.warehouseId, status: line.status },
      })),
  },
  stockLevel: {
    // TWO real shapes: `updateAllocation` filters one product across warehouses
    // (`productId: string`), `addAllocation` filters every expanded leaf
    // (`productId: { in: [...] }`). A double that understood only the first would hand
    // addAllocation an empty stock map and make it fail closed for the wrong reason.
    findMany: async ({ where }: {
      where: { productId: string | { in: string[] }; warehouseId: { in: string[] } }
    }) =>
      state.stockLevels
        .filter((row) => (
          typeof where.productId === 'string'
            ? row.productId === where.productId
            : where.productId.in.includes(row.productId)
        ))
        .filter((row) => where.warehouseId.in.includes(row.warehouseId))
        .map((row) => ({ ...row })),
    // Honours the guarded decrement, so a release bigger than the aggregate cannot silently "work".
    updateMany: async ({ where, data }: {
      where: { productId?: string; warehouseId?: string; reservedQty?: { gte?: unknown } }
      data: { reservedQty: { increment?: unknown; decrement?: unknown } }
    }) => {
      const rows = state.stockLevels.filter((row) => {
        if (where.productId != null && row.productId !== where.productId) return false
        if (where.warehouseId != null && row.warehouseId !== where.warehouseId) return false
        if (where.reservedQty?.gte != null && !(row.reservedQty >= decimalLikeToNumber(where.reservedQty.gte))) return false
        return true
      })
      for (const row of rows) {
        row.reservedQty += decimalLikeToNumber(data.reservedQty.increment)
        row.reservedQty -= decimalLikeToNumber(data.reservedQty.decrement)
      }
      return { count: rows.length }
    },
  },
  orderAllocation: {
    // Answers BOTH unique shapes production uses: the merge-target lookup by
    // (lineId, warehouseId, productId), and — since o3d-4kfh round 3 — the re-read by `id` that
    // updateAllocation performs under the order lock. A double that answered only the compound key
    // would return null for the re-read and make every edit fail closed, which would look like the
    // guard working when in fact nothing was being exercised.
    findUnique: async ({ where }: { where: { id?: string; lineId_warehouseId_productId?: { lineId: string; warehouseId: string; productId: string } } }) => {
      if (where.id) return state.allocations.find((row) => row.id === where.id) ?? null
      const key = where.lineId_warehouseId_productId
      if (!key) return null
      return state.allocations.find((row) => (
        row.lineId === key.lineId && row.warehouseId === key.warehouseId && row.productId === key.productId
      )) ?? null
    },
    // Filtered by the predicates production passes. Returning EVERY row regardless of `where`
    // would hand validateAllocationIntegrity another order's allocations as if they were this
    // order's, and hand the residual loader rows it never asked for.
    findMany: async ({ where }: {
      where?: {
        orderId?: string
        lineId?: string | { in: string[] }
        warehouseId?: string
        productId?: string | { in: string[] }
      }
    } = {}) => state
      .allocations
      .filter((row) => where?.orderId == null || row.orderId === where.orderId)
      .filter((row) => {
        if (where?.lineId == null) return true
        return typeof where.lineId === 'string' ? row.lineId === where.lineId : where.lineId.in.includes(row.lineId)
      })
      .filter((row) => where?.warehouseId == null || row.warehouseId === where.warehouseId)
      // BOTH productId shapes. The residual/integrity readers ask with `{ in: [...] }`; the r10
      // record carry-over asks about ONE product by plain string, because it speaks only for the
      // (line, product) it is editing. Handling only the set form threw on the string form.
      .filter((row) => {
        if (where?.productId == null) return true
        return typeof where.productId === 'string'
          ? row.productId === where.productId
          : where.productId.in.includes(row.productId)
      })
      .map((row) => ({ ...row, fulfillmentGraphVersion: row.fulfillmentGraphVersion ?? 0 })),
    // Answers BOTH `where` shapes production uses: the edit's own `{ id }`, and the r10 record
    // write's `{ lineId_warehouseId_productId }` — the same compound unique the merge-target lookup
    // above resolves by. A double that understood only `{ id }` would throw on the record write, and
    // one that ignored the compound keys would put a carried record on whichever row came first.
    update: async ({ where, data }: {
      where: {
        id?: string
        lineId_warehouseId_productId?: { lineId: string; warehouseId: string; productId: string }
      }
      data: { warehouseId?: string; qty?: unknown; costLayerSnapshot?: unknown }
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
      // The WRITTEN VALUE is honoured, never forced to null: forcing it would assert a destructive
      // rewrite as a requirement and make the carry-over unobservable (o3d-0i5y r8's lesson).
      // Round-trips through JSON as jsonb does.
      if ('costLayerSnapshot' in data) {
        row.costLayerSnapshot = data.costLayerSnapshot == null
          ? null
          : JSON.parse(JSON.stringify(data.costLayerSnapshot))
      }
      if (data.warehouseId) row.warehouseId = data.warehouseId
      // o3d-4kfh r7: `OrderAllocation.qty` is `@db.Decimal(12,4)` and Postgres rounds half-up ON
      // WRITE. A double that stored the caller's full precision let a test observe a row IMS could
      // never hold, and made the whole class of "the row and reservedQty disagree by half an ulp"
      // defects unobservable — which is exactly the defect Codex finding 4 is about.
      if (data.qty !== undefined) row.qty = persistAllocationQty(decimalLikeToNumber(data.qty))
      return row
    },
    create: async ({ data }: { data: Omit<AllocationRow, 'id' | 'qty'> & { qty: unknown; id?: string } }) => {
      const row: AllocationRow = {
        ...data,
        id: data.id ?? `alloc-${state.allocations.length + 1}`,
        qty: persistAllocationQty(decimalLikeToNumber(data.qty)),
        fulfillmentGraphVersion: data.fulfillmentGraphVersion ?? 0,
      }
      state.allocations.push(row)
      return row
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = state.allocations.findIndex((row) => row.id === where.id)
      if (index >= 0) state.allocations.splice(index, 1)
      return {}
    },
    // resetAllocationAccountingIfStaged clears costLayerSnapshot through here. Unreachable in this
    // file (the order is never staged — `salesOrder.findUnique` returns a null
    // inventoryAllocatedDate) but answered honestly so it cannot quietly become a lie if a future
    // fixture stages one.
    updateMany: async ({ where }: { where?: { orderId?: string } } = {}) => ({
      count: state.allocations.filter((row) => where?.orderId == null || row.orderId === where.orderId).length,
    }),
  },
}

/** Postgres `numeric(12,4)` rounds half-up on write. The double must, or precision is untestable. */
function persistAllocationQty(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...tx,
      orderAllocation: {
        ...tx.orderAllocation,
        findUnique: async ({ where }: { where: { id?: string } }) => {
          if (!where.id) return null
          // `staleOuterAllocations` models the ONE thing that separates the outer read from the
          // in-transaction one: it happens before the order lock, so another editor can commit in
          // between. When a test sets it, this read (and only this read) is served from that frozen
          // snapshot while `tx` keeps serving the committed state.
          const source = state.staleOuterAllocations ?? state.allocations
          const row = source.find((candidate) => candidate.id === where.id)
          if (!row) return null
          return {
            ...row,
            line: { qty: 10 },
            order: { orderNumber: 'SO-1', externalOrderNumber: null },
          }
        },
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  },
})

async function loadAction() {
  return import('@/app/actions/allocation')
}

/** The order's own lines. Kept in step with the fixtures so the integrity check is answerable. */
function seedLines(qty: number) {
  state.lines = [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty, sku: 'SKU-1' }]
  state.graphVersions = {}
  state.lineProductGraphVersions = {}
  state.kits = {}
  state.staleOuterAllocations = null
  state.pendingShipments = []
  state.activity.length = 0
  state.txActivity.length = 0
  state.lineSnapshotWrites.length = 0
  queuedAccountingSyncs.length = 0
  accountingSyncRows.length = 0
  accountingEnqueueOutcome = 'writes'
}

/**
 * Order A allocated 10 of product-1 @ warehouse-1 and dispatched 5 of them; order B holds 3 in the
 * same scope. reservedQty 8 = A's live 5 + B's 3.
 */
function seedPartiallyDispatched() {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 8, reservedQty: 8 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
}

function reservedAt(warehouseId: string): number | undefined {
  return state.stockLevels.find((row) => row.warehouseId === warehouseId)?.reservedQty
}

test('o3d-4kfh: updateAllocation releases the residual, so another order keeps its reservation', async () => {
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  // Trim A's row from 10 to 7: 5 dispatched + 2 still live, i.e. release 5 and reserve 2.
  const result = await updateAllocation('alloc-a', 'warehouse-1', 7)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 7)
  assert.equal(
    reservedAt('warehouse-1'),
    5,
    'A now holds 2 live and B still holds 3 — releasing the raw 10 used to floor this to 0',
  )
})

test('o3d-4kfh: a partially dispatched allocation cannot be REDUCED below what shipped from it', async () => {
  // The row is the only record of what shipped from this warehouse: the reservation residual, the
  // shipment remainder in confirmSalesOrderShipments and the accounting sub-ledger all read it as
  // `qty - shipped`. Shrinking it below 5 does not release anything (the residual is already
  // floored at zero) — it silently makes the dispatched units unaccounted for.
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 3)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10, 'the row is untouched')
  assert.equal(reservedAt('warehouse-1'), 8, 'and so is the reservation')
})

test('o3d-4kfh: deleting a fully dispatched allocation is REFUSED, and releases nothing either way', async () => {
  // Every allocated unit has shipped, so dispatch already returned the whole reservation: the only
  // correct release is zero, and releasing the retained 5 would come straight out of order B's 3.
  // Deleting the row would ALSO erase the dispatch attribution, so the edit is refused outright.
  seedLines(5)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations.length, 1, 'the dispatched row survives')
  assert.equal(reservedAt('warehouse-1'), 3, 'and order B\'s reservation is untouched')
})

test('o3d-4kfh: GROWING a fully dispatched allocation reserves only the added units', async () => {
  // The complement of the refusal above: dispatched quantity is a floor, not a freeze. Going 5 -> 8
  // on a row whose 5 have all shipped releases the residual (0) and reserves the 3 new units only.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 8)
  assert.equal(reservedAt('warehouse-1'), 6, 'order B keeps 3 and A reserves 3 more, not 8')
})

test('o3d-4kfh: a partially dispatched allocation cannot be MOVED to another warehouse (no merge)', async () => {
  // Dispatched quantity is attributed to the row it shipped from. Moving the row takes the history
  // with it: the destination has no dispatch to net, so it re-reserves the shipped units, and the
  // source keeps a shipment with no row to net it out of.
  seedPartiallyDispatched()
  state.stockLevels.push({ productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 0 })
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.equal(state.allocations[0].warehouseId, 'warehouse-1', 'the row stays where it shipped from')
  assert.equal(state.allocations[0].qty, 10)
  assert.equal(reservedAt('warehouse-1'), 8, 'warehouse-1 reservation untouched')
  assert.equal(reservedAt('warehouse-2'), 0, 'and nothing was re-reserved at the destination')
})

test('o3d-4kfh: nor MERGED into an existing row in another warehouse', async () => {
  // Codex\'s worked example. W1 holds 10 with 5 shipped, W2 holds 4; moving W1 to W2 at newQty 10
  // released W1\'s residual 5, wrote a W2 row of 14, saw no dispatch at W2 and reserved 10 more —
  // 14 live reserved units where 9 is correct, and the W1 row that nets the shipment destroyed.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 5 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 4 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 4 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.deepEqual(
    state.allocations.map((row) => [row.warehouseId, row.qty]),
    [['warehouse-1', 10], ['warehouse-2', 4]],
    'both rows survive exactly as they were',
  )
  assert.equal(reservedAt('warehouse-1'), 5)
  assert.equal(reservedAt('warehouse-2'), 4, 'the destination did not gain a second reservation')
})

test('o3d-4kfh: an UNdispatched row still merges, and reserves only the units it moves', async () => {
  // The merge path is not blanket-refused: only a source scope with its own dispatch is. Here W1\'s
  // 6 have not shipped and W2 already holds 10 of which 6 shipped (residual 4). Moving W1 into W2
  // must reserve the 6 moved units and nothing else — not the 16-unit merged row, and not the 6
  // W2 units dispatch already gave back.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 10, reservedQty: 4 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', status: 'SHIPPED', qty: 6 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(
    state.allocations.map((row) => [row.warehouseId, row.qty]),
    [['warehouse-2', 16]],
    'the W2 row keeps its 6 dispatched units and gains the 6 moved ones',
  )
  assert.equal(reservedAt('warehouse-1'), 0, 'W1 gave back its whole residual')
  assert.equal(reservedAt('warehouse-2'), 10, '4 residual + 6 moved — not 16')
})

/** 10 allocated at W1 with a `status` shipment of 5 against it, and nothing dispatched. */
function seedCommittedNotDispatched(status: 'PICKING' | 'PACKED') {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status, qty: 5 },
  ]
}

test('o3d-4kfh: a PICKED (not dispatched) shipment nets nothing from the reservation, but it IS a floor', async () => {
  // Two different subtractions, and this row is subject to both. reservedQty is decremented on the
  // transition to SHIPPED and nowhere else, so a PICKING shipment has released NOTHING and the
  // reservation delta must not net it (netting it would under-release and strand reservation
  // forever). But the picked units are still attached to this row: the shipment carries
  // (lineId, productId) and its shipment the warehouseId, and that triple is the only thing tying
  // them together. Cutting the row to 4 used to SUCCEED and drop the reservation to 4, leaving a
  // 5-unit shipment that transitionShipmentStatus can only dispatch by taking the missing unit out
  // of another order's share of the aggregate.
  seedCommittedNotDispatched('PICKING')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.equal(result.success, false, 'the edit is refused, not applied')
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10, 'the row still covers its committed shipment')
  assert.equal(reservedAt('warehouse-1'), 10, 'and the reservation is untouched')
})

test('o3d-4kfh: a PICKED shipment can still be trimmed DOWN TO its committed quantity', async () => {
  // The floor is a floor, not a freeze: the 5 uncommitted units are still the operator's to give
  // back, and doing so must release exactly 5 (the residual of the old row minus the residual of
  // the new one) — the picked 5 stay reserved because they have not shipped.
  seedCommittedNotDispatched('PICKING')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 5)
  assert.equal(reservedAt('warehouse-1'), 5, 'the 5 picked units keep their live reservation')
})

test('o3d-4kfh: a PACKED shipment is a floor too — reducing below it is refused', async () => {
  // PACKED is further along than PICKING and just as un-dispatched. Both are non-PENDING, which is
  // the whole test: the floor is the COMMITTED set, not the shipped one.
  seedCommittedNotDispatched('PACKED')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10)
  assert.equal(reservedAt('warehouse-1'), 10)
})

test('o3d-4kfh: an allocation with a PACKED shipment cannot be MOVED to another warehouse', async () => {
  // The packed units were picked from warehouse-1. Moving the row takes their only attribution with
  // it: warehouse-2 has no shipment to net, so it re-reserves them, and warehouse-1 keeps a packed
  // shipment with no allocation row behind it.
  seedCommittedNotDispatched('PACKED')
  state.stockLevels.push({ productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 0 })
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.equal(state.allocations[0].warehouseId, 'warehouse-1', 'the row stays where the shipment was picked')
  assert.equal(reservedAt('warehouse-1'), 10)
  assert.equal(reservedAt('warehouse-2'), 0, 'nothing was re-reserved at the destination')
})

test('o3d-4kfh: DELETING an allocation with a PACKED shipment is refused', async () => {
  // newQty 0 is the sharpest version of the under-allocation: the row that the shipment, the
  // residual and the accounting sub-ledger all resolve through simply stops existing, while the
  // packed shipment stays dispatchable.
  seedCommittedNotDispatched('PACKED')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations.length, 1, 'the row survives')
  assert.equal(reservedAt('warehouse-1'), 10)
})

test('o3d-4kfh: after the refusal the reservation still satisfies the DISPATCH precondition', async () => {
  // The consequence the guard exists to prevent, stated as the condition dispatch actually tests.
  // transitionShipmentStatus decrements stock with
  //   where: { ..., quantity: { gte: qty }, reservedQty: { gte: qty } }
  // and throws "Insufficient physical or reserved stock to dispatch" when that matches no row.
  // reservedQty is the SHARED per-(product, warehouse) aggregate, so a shortfall is resolved
  // either by failing the dispatch outright or — when another order happens to be holding enough
  // there — by silently spending that order's reservation.
  seedCommittedNotDispatched('PICKING')
  const committedShipmentQty = state.shipmentLines[0].qty
  const { updateAllocation } = await loadAction()

  await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.ok(
    (reservedAt('warehouse-1') ?? 0) >= committedShipmentQty,
    `reservedQty ${reservedAt('warehouse-1')} must still cover the ${committedShipmentQty} picked units; `
    + 'letting the edit through left 4 and made the dispatch impossible without robbing another order',
  )
  assert.ok(
    state.allocations[0].qty >= committedShipmentQty,
    'and the allocation row still covers the shipment it will be dispatched against',
  )
})

test('o3d-4kfh: a release bigger than the whole aggregate is REFUSED, not floored', async () => {
  // Genuine drift with no dispatch to explain it. There is no honest way to give 6 back out of a
  // scope holding 4, and zeroing it would take another order's reservation with it.
  seedLines(6)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 4 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot release 6 reserved unit\(s\)/)
  assert.equal(reservedAt('warehouse-1'), 4, 'the scope was NOT zeroed')
})

test('o3d-4kfh: the integrity check really runs — an edit past the remaining demand is refused', async () => {
  // Guards the doubles themselves. `salesOrderLine.findMany` returning [] made
  // validateAllocationIntegrity exit at `lines.length === 0`, so every test above was asserting
  // against a validator that never reached a comparison (Codex review of o3d-4kfh).
  seedLines(6)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 6 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  // Stock is plentiful, so nothing before the integrity check can refuse this: 9 allocated units
  // against a 6-unit line is over-allocation and only the validator can say so.
  const result = await updateAllocation('alloc-a', 'warehouse-1', 9)

  assert.equal(result.success, false)
  assert.match(String(result.error), /exceeds the remaining quantity to fulfill/)
})

test('o3d-4kfh: and it does NOT refuse a partially dispatched order (the retained row is not over-allocation)', async () => {
  // The same validator on the fixture from the first test: 10 ordered, 5 shipped, a retained row of
  // 10. Comparing the RAW row against demand that already has the 5 subtracted read as 10 allocated
  // against 5 remaining and refused every manual edit — and every shipment confirmation — for the
  // rest of that order's life.
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 10)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 10)
})

test('o3d-4kfh r3: TWO CONCURRENT EDITORS of the same row cannot steal the neighbour\'s reservation', async () => {
  // The A/B shared-scope case, run through the exact window the pre-transaction read opens.
  //
  // A=10 and B=3 share (product-1, warehouse-1); reservedQty 13 backs both. Two operators open the
  // editor on A and both see 10. The first commits A=8 (release 10, reserve 8 -> reservedQty 11).
  // The second then enters its transaction, takes the order lock — and used to carry on with its
  // STALE 10: release 10 (11 >= 10, so the guarded decrement happily succeeds) and reserve 9,
  // leaving reservedQty at 10 while the rows claim 8+3=12... except A is now 9, so 9+3=12 against
  // an aggregate of 10. B is short by two units nobody will ever notice: validateAllocationIntegrity
  // never looks at a stock level, and the guarded decrement had enough to hand over.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 13 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    // Order B's own row in the SAME (product, warehouse) scope. It is not this order's, so nothing
    // in updateAllocation reads it — it exists purely to own 3 of the 13 reserved units.
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  // Editor one, in full.
  const first = await updateAllocation('alloc-a', 'warehouse-1', 8)
  assert.equal(first.success, true, first.error)
  assert.equal(reservedAt('warehouse-1'), 11, 'A now holds 8 live, B still holds 3')

  // Editor two: its pre-read happened BEFORE the write above, so it still sees A=10.
  state.staleOuterAllocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  const second = await updateAllocation('alloc-a', 'warehouse-1', 9)

  // The invariant that actually matters FIRST, asserted independently of HOW it is kept: the shared
  // aggregate still equals the sum of the rows claiming it, so B's 3 units are still B's. Asserted
  // ahead of the message so a regression reports the theft rather than the wording.
  const rowTotal = state.allocations
    .filter((row) => row.productId === 'product-1' && row.warehouseId === 'warehouse-1')
    .reduce((sum, row) => sum + row.qty, 0)
  assert.equal(
    reservedAt('warehouse-1'),
    rowTotal,
    `reservedQty ${reservedAt('warehouse-1')} must equal the ${rowTotal} units the allocation rows claim`,
  )
  assert.equal(state.allocations.find((row) => row.id === 'alloc-b')?.qty, 3, 'B\'s row is untouched')
  assert.equal(second.success, false, 'the stale editor must be refused, not silently applied')
  assert.match(String(second.error), /changed while you were editing/)
})

// ---------------------------------------------------------------------------
// o3d-4kfh r4 (Codex finding 3) — a manual edit must reconcile the PENDING drafts it invalidates.
//
// updateAllocation validated only NON-PENDING commitments and then committed. Reducing an
// allocation 10 -> 5 left its 10-unit PENDING draft intact and perfectly ordinary-looking; the very
// next Start Picking — or a WMS dispatch applied against it — then failed the r3 commitment
// coverage guard. An external fulfilment dead-letter caused by an EARLIER SUCCESSFUL IMS action.
//
// The retirement now runs inside the same transaction, through the shared
// `reconcilePendingShipments`, and only drafts the post-edit rows no longer back are touched.
// ---------------------------------------------------------------------------

/** A PENDING draft on `warehouseId` for `qty` of product-1, as confirmAllocations would build it. */
function draft(
  id: string,
  warehouseId: string,
  qty: number,
  extra: { trackingNumber?: string; shippingService?: string; createdAt?: string; lineId?: string; productId?: string } = {},
) {
  return {
    id,
    orderId: 'order-1',
    warehouseId,
    trackingNumber: extra.trackingNumber ?? null,
    shippingService: extra.shippingService ?? null,
    createdAt: extra.createdAt ?? '2026-01-01T00:00:00Z',
    lines: [{ lineId: extra.lineId ?? 'line-1', productId: extra.productId ?? 'product-1', qty }],
  }
}

function draftIds(): string[] {
  return state.pendingShipments.map((shipment) => shipment.id).sort()
}

/**
 * o3d-4kfh r5 (finding 7): read from `txActivity`. Finding it in the post-commit `activity` mock
 * would mean the record had gone back to the lossy path — `logActivity` swallows persistence
 * failures, so a crash after the commit destroyed the only trace of a purchased label.
 */
function retirementLog() {
  return state.txActivity.find((entry) => entry.action === 'pending_shipments_retired')
}

test('o3d-4kfh r4: SHRINKING an allocation retires the oversized PENDING draft it no longer backs', async () => {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10)]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 5)
  assert.deepEqual(draftIds(), [], 'the 10-unit draft cannot survive a 5-unit allocation')
  assert.deepEqual(
    (result.retiredPendingShipments ?? []).map((row) => row.id),
    ['draft-1'],
    'and the caller is told which draft went, not merely that one did',
  )
})

test('o3d-4kfh r4: an edit that still backs its draft leaves it — and its tracking number — alone', async () => {
  // The complement, and the reason this is a coverage charge rather than a blanket delete: growing
  // (or trimming to a quantity the draft still fits inside) invalidates nothing, so a draft an
  // operator has already put a tracking number on must survive untouched.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 4 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 4, { trackingNumber: 'TRACK-KEEP', shippingService: 'DPD' })]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), ['draft-1'])
  assert.equal(state.pendingShipments[0].trackingNumber, 'TRACK-KEEP', 'the label is not thrown away')
  assert.deepEqual(result.retiredPendingShipments, [], 'and nothing is reported as retired')
  assert.equal(retirementLog(), undefined, 'a no-op retirement writes no activity at all')
})

test('o3d-4kfh r4: MOVING an allocation retires the draft at the old warehouse only', async () => {
  // Warehouse moves invalidate a draft without changing any quantity: the draft still points at the
  // warehouse the units left. A draft in the destination warehouse that its own row still backs is
  // untouched — the per-draft, per-scope charge is what tells the two apart.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 3 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 3 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [
    draft('draft-w1', 'warehouse-1', 6, { createdAt: '2026-01-01T00:00:00Z' }),
    draft('draft-w2', 'warehouse-2', 3, { createdAt: '2026-01-02T00:00:00Z', trackingNumber: 'TRACK-W2' }),
  ]
  const { updateAllocation } = await loadAction()

  // Move W1's 6 into W2, merging with the existing 3.
  const result = await updateAllocation('alloc-a', 'warehouse-2', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), ['draft-w2'], 'only the draft whose warehouse lost its row is retired')
  assert.equal(state.pendingShipments[0].trackingNumber, 'TRACK-W2', 'the surviving draft keeps its label')
})

test('o3d-4kfh r4: a retired draft carrying a tracking number is logged with enough identity to cancel the label', async () => {
  // Codex finding 2's complaint, asserted on the shared retirement record: a bare count cannot tell
  // an operator WHICH externally purchased label IMS has stopped referencing.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10, { trackingNumber: 'TRACK-LOST', shippingService: 'DPD Next Day' })]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, true, result.error)
  const entry = retirementLog()
  assert.ok(entry, 'the retirement is recorded')
  const metadata = entry!.metadata as Record<string, unknown>
  assert.deepEqual(metadata.retiredTrackingNumbers, ['TRACK-LOST'])
  assert.deepEqual(metadata.retiredShipments, [{
    shipmentId: 'draft-1',
    warehouseId: 'warehouse-1',
    trackingNumber: 'TRACK-LOST',
    shippingService: 'DPD Next Day',
    lineCount: 1,
    totalQty: 10,
  }])
  assert.match(String(entry!.description), /TRACK-LOST/)
})

test('o3d-4kfh r4: a REFUSED edit retires nothing — the reconciliation is inside the transaction', async () => {
  // The floor refusal throws out of the transaction callback, so the draft must survive with the
  // row it is drawn from. A reconciliation that ran after the transaction (or that ignored the
  // throw) would delete a draft the edit never applied.
  seedCommittedNotDispatched('PICKING')
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 5)]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.deepEqual(draftIds(), ['draft-1'], 'the draft survives the refusal')
  assert.equal(retirementLog(), undefined)
})

test('o3d-4kfh r4: a committed shipment is NOT counted as backing for a draft on the same scope', async () => {
  // 10 allocated, 5 of them already PICKING. Open quantity is 5, so a 10-unit draft is not backed —
  // charging it against the raw row instead of `qty - committed` would let a draft and a commitment
  // both claim the same units, which is the exact over-commitment r3 exists to reject.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 5 },
  ]
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10)]
  const { updateAllocation } = await loadAction()

  // A no-op-sized edit (10 -> 10 is rejected as unchanged upstream, so trim to the floor).
  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), [], 'the draft claimed units the PICKING shipment already owns')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r6 (Codex finding 1) — the manual editor is inside the CAS too.
// ---------------------------------------------------------------------------

test('o3d-4kfh r6: updateAllocation REFUSES a row written against an older component graph', async () => {
  // A stale row cannot be repaired by editing its quantity — the whole set has to be rebuilt from
  // the current recipe — so the editor must refuse and point at Re-Allocate rather than let the
  // operator adjust numbers that mean something different from what they say.
  seedLines(10)
  state.graphVersions['product-1'] = 5
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10, fulfillmentGraphVersion: 4 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, false)
  assert.match(String(result.error), /older version of that product's component graph/)
  assert.match(String(result.error), /Re-allocate this order/)
  // NOT asserted here: that the write is rolled back. This file's `$transaction` double just calls
  // the callback (line ~277) and keeps no snapshot, so post-throw state proves nothing about
  // rollback either way — claiming it would be exactly the kind of vacuous assertion this round is
  // auditing out. The rollback comes from `db.$transaction` propagating the throw, and it IS
  // exercised against a snapshotting double in
  // tests/domain/sales/shipment-service.test.ts ("the status flip is rolled back with the
  // transaction").
})

test('o3d-4kfh r6: updateAllocation is untouched when the stamp matches', async () => {
  // The boundary: the CAS must not become a dead end for the ordinary editor.
  seedLines(10)
  state.graphVersions['product-1'] = 5
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10, fulfillmentGraphVersion: 5 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(state.allocations[0].qty, 8)
  assert.equal(reservedAt('warehouse-1'), 8)
})

// ---------------------------------------------------------------------------
// o3d-4kfh r7 (Codex finding 1) — the CAS reads the version from the SAME snapshot as the graph.
// ---------------------------------------------------------------------------

test('o3d-4kfh r7: the graph-version CAS compares against the GRAPH read, not a separate product read', async () => {
  // THE RACE, modelled exactly. r6 loaded the line (with `product.fulfillmentGraphVersion`) in one
  // statement and the component graph in the next. A component-graph edit committing between them
  // makes those two statements disagree: the line query still returns the OLD version — which
  // MATCHES the old stamp on the rows, so the CAS passes — while the graph query returns the NEW
  // recipe, against which a uniform rescale is still perfectly proportional, so the coverage
  // backstop passes too. Both checks pass on rows derived from a recipe that no longer exists.
  //
  // Here: the rows are stamped 4, the pre-edit line read still says 4, the graph says 5.
  seedLines(10)
  state.lineProductGraphVersions['product-1'] = 4 // the statement taken BEFORE the edit committed
  state.graphVersions['product-1'] = 5            // the statement taken AFTER it committed
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10, fulfillmentGraphVersion: 4 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, false, 'the stale set must be refused even though the OLD read agreed with it')
  assert.match(String(result.error), /older version of that product's component graph/)
  assert.match(String(result.error), /allocation 4, product 5/, 'and it reports the GRAPH version, which is the one it judged against')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r7 (Codex finding 4) — the manual writers quantise to the persisted scale.
//
// `OrderAllocation.qty` is `@db.Decimal(12,4)`; `StockLevel.reservedQty` carries more. The
// allocator was fixed in r6 to decide equality, the write and the reserve against ONE canonical
// rendering of the number. The two MANUAL writers were not, so they kept recreating exactly the
// drift that fix removed: the row rounds, the reservation does not, and the difference sits on an
// aggregate shared with every other order in the (product, warehouse) scope. Neither the
// transaction's integrity check nor the residual arithmetic can see it — the first reads allocation
// rows and never stock, the second only ever credits what is actually left.
// ---------------------------------------------------------------------------

test('o3d-4kfh r7: updateAllocation reserves EXACTLY what the row persists, at a x.xxxx5 boundary', async () => {
  // Order B holds 3 in the same scope, so the drift has somewhere to steal from / leak into.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 13 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0.33335)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 0.3334, 'the row holds what numeric(12,4) can hold')
  assert.equal(
    reservedAt('warehouse-1'),
    3.3334,
    'and the aggregate is order B\'s untouched 3 plus EXACTLY the persisted row — not the operator\'s 0.33335',
  )
})

test('o3d-4kfh r7: updateAllocation DELETES on a quantity that quantises to zero', async () => {
  // 0.00004 is not "a very small allocation": it is a row Postgres stores as 0.0000, which every
  // structural check reads as a component missing from the set, while the reservation moved by
  // 0.00004. `newQty === 0` was the wrong test.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 13 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0.00004)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(state.allocations.map((row) => row.id), ['alloc-b'], 'the row is gone, not stored as 0.0000')
  assert.equal(reservedAt('warehouse-1'), 3, 'and order B keeps its 3 exactly')
})

test('o3d-4kfh r7: addAllocation reserves the PERSISTED component quantity, not the expanded one', async () => {
  // A KIT whose component factor is not representable at 4dp: one kit expands to 0.33335 of
  // component-1, which the column stores as 0.3334.
  seedLines(10)
  state.lines = [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1' }]
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 0.33335 }] }
  state.stockLevels = [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'component-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  state.shipmentLines = []
  const { addAllocation } = await loadAction()

  const result = await addAllocation('order-1', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, true, result.error)
  const added = state.allocations.find((row) => row.orderId === 'order-1')
  assert.equal(added?.qty, 0.3334, 'the component row holds what numeric(12,4) can hold')
  assert.equal(
    reservedAt('warehouse-1'),
    3.3334,
    'and the reservation moved by the persisted row, so order B\'s 3 is neither topped up nor eaten into',
  )
})

// ---------------------------------------------------------------------------
// o3d-kouj — `addAllocation` IS THE SECOND DOOR ONTO IN-FLIGHT STATE, AND IT PINS TOO.
//
// `allocateSalesOrder` is not the only writer of `OrderAllocation`. If the manual editor could give
// a line its first allocation row without pinning, every reader would keep answering that line from
// a graph free to move under it — a line the rest of the system believes is protected, and is not.
// ---------------------------------------------------------------------------

test('o3d-kouj: addAllocation pins the recipe when it gives a line its FIRST row', async () => {
  seedLines(10)
  state.lines = [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1' }]
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 2 }] }
  state.graphVersions = { 'kit-1': 6 }
  state.stockLevels = [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 0 }]
  state.allocations = []
  state.shipmentLines = []
  const { addAllocation } = await loadAction()

  const result = await addAllocation('order-1', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(state.lineSnapshotWrites.map((write) => write.lineId), ['line-1'])
  assert.deepEqual(state.lines[0].fulfillmentRequirements, {
    version: 1,
    productId: 'kit-1',
    graphVersion: 6,
    capturedAt: (state.lines[0].fulfillmentRequirements as { capturedAt: string }).capturedAt,
    requirements: [{ productId: 'component-1', factor: '2' }],
  })
})

test('o3d-kouj: addAllocation expands the PIN, and never re-pins a line that already holds rows', async () => {
  // The kit has since been re-composed 2 -> 5. Adding one more kit to a line that is already
  // in flight must add the PINNED two components, not five: the row it is topping up, the
  // reservation behind it and the shipment lines already committed are all in the pinned units.
  const pinned = {
    version: 1,
    productId: 'kit-1',
    graphVersion: 6,
    capturedAt: '2026-08-01T00:00:00.000Z',
    requirements: [{ productId: 'component-1', factor: '2' }],
  }
  seedLines(10)
  state.lines = [{
    id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1',
    fulfillmentRequirements: pinned,
  }]
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 5 }] }
  state.graphVersions = { 'kit-1': 11 }
  state.stockLevels = [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 2 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'component-1', warehouseId: 'warehouse-1', qty: 2 },
  ]
  state.shipmentLines = []
  const { addAllocation } = await loadAction()

  const result = await addAllocation('order-1', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 4, '2 already there plus the PINNED 2, not plus 5')
  assert.equal(reservedAt('warehouse-1'), 4)
  assert.deepEqual(state.lineSnapshotWrites, [], 'and the pin is not touched')
  assert.deepEqual(state.lines[0].fulfillmentRequirements, pinned)
})

test('o3d-kouj: addAllocation REFUSES a line that belongs to another order', async () => {
  // `lineId` arrives from the caller and nothing tied it to `orderId`. The lock is on the ORDER, so
  // a foreign line is outside it — and every in-flight fact the action reads is scoped to
  // `{ orderId, lineId }`, so another order's fully-allocated, half-picked line read as holding
  // NOTHING, was judged capturable, and had its pinned recipe overwritten.
  const pinned = {
    version: 1,
    productId: 'kit-1',
    graphVersion: 6,
    capturedAt: '2026-08-01T00:00:00.000Z',
    requirements: [{ productId: 'component-1', factor: '2' }],
  }
  seedLines(10)
  // line-1 belongs to order-1 and is in flight there: pinned, allocated, and picked.
  state.lines = [{
    id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1',
    fulfillmentRequirements: pinned,
  }]
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 5 }] }
  state.graphVersions = { 'kit-1': 11 }
  state.stockLevels = [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 20 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'component-1', warehouseId: 'warehouse-1', qty: 20 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'component-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 20 },
  ]
  const { addAllocation } = await loadAction()

  // order-2 names order-1's line.
  const result = await addAllocation('order-2', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, false)
  assert.match(
    result.error ?? '',
    /Line line-1 does not belong to order order-2/,
    'the refusal names the line and the order, so an operator can see which pairing was wrong',
  )
  assert.equal(state.allocations.length, 1, 'no allocation row was attached to the foreign order')
  assert.equal(state.allocations[0].qty, 20, "and order-1's own row is untouched")
  assert.equal(reservedAt('warehouse-1'), 20, "nothing was taken out of the shared aggregate")
  assert.deepEqual(state.lineSnapshotWrites, [], 'and no pin was written')
  assert.deepEqual(
    state.lines[0].fulfillmentRequirements,
    pinned,
    "order-1's pinned recipe survives — it is what its picked shipment was picked against",
  )
})

test('o3d-kouj: a manual addition to a PINNED line stamps the PIN\'s graph version, not the current one', async () => {
  // The column records the graph version the rows were EXPANDED from. A pinned line's rows come
  // from the pin, so stamping the current version leaves the row claiming a provenance it does not
  // have — and certifying itself as current, so that if the pin were ever lost the CAS (skipped per
  // line only while a pin exists) would come back and find a row agreeing with a recipe it was
  // never expanded from.
  const pinned = {
    version: 1,
    productId: 'kit-1',
    graphVersion: 6,
    capturedAt: '2026-08-01T00:00:00.000Z',
    requirements: [{ productId: 'component-1', factor: '2' }, { productId: 'component-2', factor: '1' }],
  }
  seedLines(10)
  state.lines = [{
    id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1',
    fulfillmentRequirements: pinned,
  }]
  // The current recipe has moved on, both in shape and in version.
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 5 }] }
  state.graphVersions = { 'kit-1': 11 }
  state.stockLevels = [
    { productId: 'component-1', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 2 },
    { productId: 'component-2', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 0 },
  ]
  // NO allocation rows: the line is held in flight by a PICKED shipment instead, so it is not
  // capturable (its pin stands) and BOTH components are CREATED by this addition — and the create
  // branch is the only one that stamps a version at all.
  state.allocations = []
  // A complete PINNED component set, picked: 2 x component-1 + 1 x component-2 for one kit.
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'component-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 2 },
    { lineId: 'line-1', productId: 'component-2', warehouseId: 'warehouse-1', status: 'PICKING', qty: 1 },
  ]
  const { addAllocation } = await loadAction()

  const result = await addAllocation('order-1', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, true, result.error)
  const componentOne = state.allocations.find((row) => row.productId === 'component-1')
  const componentTwo = state.allocations.find((row) => row.productId === 'component-2')
  assert.ok(componentTwo, 'the pinned component the current recipe no longer mentions did get a row')
  assert.equal(componentOne?.qty, 2, 'expanded from the PIN (factor 2), not the current recipe (5)')
  assert.equal(componentTwo.qty, 1, 'and the pinned factor-1 component too')
  assert.equal(
    componentTwo.fulfillmentGraphVersion,
    6,
    "stamped with the PIN's version — the recipe these rows actually came from",
  )
  assert.notEqual(componentTwo.fulfillmentGraphVersion, 11, 'and emphatically not the current graph version')
  assert.equal(componentOne?.fulfillmentGraphVersion, 6, 'both created rows carry the same honest provenance')
  assert.deepEqual(state.lineSnapshotWrites, [], 'and a pinned line is never re-pinned by this path')
})

test('o3d-kouj: an UNPINNED line still stamps the CURRENT graph version', async () => {
  // The bound on the rule. Without a pin the rows really were expanded from the current graph, so
  // that is the honest stamp — and the CAS still reads it for those lines.
  seedLines(10)
  state.lines = [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 10, sku: 'KIT-1' }]
  state.kits = { 'kit-1': [{ componentId: 'component-1', qty: 5 }] }
  state.graphVersions = { 'kit-1': 11 }
  state.stockLevels = [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 0 }]
  state.allocations = []
  state.shipmentLines = []
  const { addAllocation } = await loadAction()

  const result = await addAllocation('order-1', 'line-1', 'kit-1', 'warehouse-1', 1)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].productId, 'component-1')
  assert.equal(state.allocations[0].fulfillmentGraphVersion, 11)
})

// ---------------------------------------------------------------------------------------------
// o3d-0i5y r10 (Codex round 10, finding 1) — THE MANUAL EDITOR AND GROUP A2'S POSTED RECORD.
//
// r9 gave the carry-over and the orphan reversal to `allocateSalesOrder`, the one caller that
// declares its next set, and left this action out — the very action an operator uses to take units
// off an order by hand. Every test below is asserted on the AMOUNT, because that is what the defect
// is: pounds sitting in Allocated Inventory that nothing downstream will ever relieve.
// ---------------------------------------------------------------------------------------------

/** What A2 wrote when it posted these units: the pin, AND the amount it posted for each one. */
const POSTED_AT_FOUR = (qty: string) => [{
  costLayerId: 'layer-1',
  qty,
  unitCostBase: '4.000000',
  postedUnitCostBase: '4.000000',
}]

/** Total units a row's record accounts for, read back through production's own parser. */
async function recordedUnitsAt(warehouseId: string): Promise<string> {
  const { parseCostLayerSnapshot, sumCostLayerSnapshotQty } = await import('@/lib/cost-layer-snapshots')
  const row = state.allocations.find((candidate) => candidate.warehouseId === warehouseId)
  return sumCostLayerSnapshotQty(parseCostLayerSnapshot(row?.costLayerSnapshot ?? null)).toString()
}

function reversalLines(): Array<[string, number | null, number | null]> | undefined {
  return queuedAccountingSyncs[0]?.payload.lines?.map((line) => [line.accountCode, line.debit ?? null, line.credit ?? null])
}

test('o3d-0i5y r10: reducing an allocation by hand REVERSES the A2 debit of the units that left', async () => {
  // 10 units at £4 = £40 already in Allocated Inventory. The operator drops the allocation to 6.
  // The four units that left will never ship (Group B never credits) and were never invoiced (no
  // refund reversal sees them), so before r10 their £16 stayed in Allocated Inventory for ever with
  // Inventory understated by the same £16. The floor was doing its job the whole time — it stops
  // those units being posted AGAIN, and says nothing about the pounds already there.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 6)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 6)
  assert.equal(await recordedUnitsAt('warehouse-1'), '6', 'the record is trimmed to the units the row still holds')
  assert.equal(queuedAccountingSyncs.length, 1, 'and the four units that left are reversed')
  assert.equal(queuedAccountingSyncs[0].type, 'ALLOCATION_REVERSAL')
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

test('o3d-0i5y r10: reducing an allocation to ZERO reverses the WHOLE posted debit', async () => {
  // The limiting case, and the worst one: the row is deleted, so before r10 the record died with it
  // and nothing surviving could say the £40 had ever been posted.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(state.allocations, [], 'the row is gone')
  assert.deepEqual(
    reversalLines(),
    [
      ['630', 40, null],
      ['631', null, 40],
    ],
    'all ten units at £4',
  )
})

test('o3d-0i5y r10: the reversal is valued at what A2 POSTED, never at a pin a revaluation rewrote', async () => {
  // `updateSnapshotsForCostLayerChange` has since rewritten `unitCostBase` on this row from £4 to
  // £9. That revaluation posted to COGS/Inventory and never touched Allocated Inventory, so £4 a
  // unit is still what stands there. Valuing from the live pin would take £36 out of an account
  // that only ever received £40 for ten units.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: [{
      costLayerId: 'layer-1',
      qty: '10.000000',
      unitCostBase: '9.000000',
      postedUnitCostBase: '4.000000',
    }],
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(
    reversalLines(),
    [
      ['630', 16, null],
      ['631', null, 16],
    ],
    'still £16 — the recorded amount, not 4 x the revalued £9',
  )
})

test('o3d-0i5y r10: a record that cannot say what was posted for it reverses NOTHING, and is reported', async () => {
  // Every entry written before r9 is this shape. A reversal posted wrongly is as bad as the
  // original, so this needs positive evidence of the original — and the pin is not it.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '10.000000', unitCostBase: '4.000000' }],
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(queuedAccountingSyncs, [], 'no journal is invented from the live pin')
  const reported = state.txActivity.filter((row) => row.action === 'allocation_reversal_unevidenced')
  assert.equal(reported.length, 1, 'and the units that left are named for a human to settle by hand')
  assert.match(String(reported[0].description), /4 recorded unit\(s\)/)
})

test('o3d-0i5y r10: a MERGE carries the source row\'s record onto the row that inherits its units', async () => {
  // The merge deletes the source row outright, so before r10 its record went with it — and A2, on
  // its next pass, read a destination row recording 2 units where 12 had been posted and posted the
  // other ten a second time. Nothing reverses the first ten. Nothing is orphaned here: every unit is
  // still on the order.
  seedLines(12)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 20, reservedQty: 2 },
  ]
  state.allocations = [
    {
      id: 'alloc-a',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 10,
      costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
    },
    {
      id: 'alloc-b',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-2',
      qty: 2,
      costLayerSnapshot: POSTED_AT_FOUR('2.000000'),
    },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(
    state.allocations.map((row) => [row.warehouseId, row.qty]),
    [['warehouse-2', 12]],
    'one row is left, holding every unit',
  )
  assert.equal(
    await recordedUnitsAt('warehouse-2'),
    '12',
    'and it records all twelve posted units — its own 2 plus the 10 the deleted source row carried',
  )
  assert.deepEqual(queuedAccountingSyncs, [], 'nothing left the order, so nothing is reversed')
})

test('o3d-0i5y r10 (GUARD): moving a row to an empty warehouse reverses nothing', async () => {
  // The guard against the opposite failure — a reversal fired on a plain warehouse move would
  // credit Allocated Inventory for units that are still on the order and still going to ship.
  // Labelled a guard rather than a revert-detector: an in-place move keeps the row (and therefore
  // its record) whatever the carry-over decides, so this passes under every mutation of the fix.
  seedLines(10)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 20, reservedQty: 0 },
  ]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, true, result.error)
  assert.equal(await recordedUnitsAt('warehouse-2'), '10')
  assert.deepEqual(queuedAccountingSyncs, [])
})

test('o3d-0i5y r10: a manual reduction whose reversal the queue DROPPED is detected, with the amount', async () => {
  // The same silent no-op finding 3 closes on the allocator, reached through the manual editor:
  // `queueAccountingSyncTx` returns having written nothing, and the rows carrying the evidence have
  // already been trimmed in this same transaction.
  seedLines(10)
  accountingEnqueueOutcome = 'silent-no-op'
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 10 }]
  state.allocations = [{
    id: 'alloc-a',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 10,
    costLayerSnapshot: POSTED_AT_FOUR('10.000000'),
  }]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 6)

  assert.equal(result.success, true, result.error)
  assert.equal(accountingSyncRows.length, 0, 'the enqueue wrote nothing')
  const reported = state.txActivity.filter((row) => row.action === 'allocation_reversal_unqueued')
  assert.equal(reported.length, 1)
  assert.equal(reported[0].level, 'ERROR')
  assert.match(
    String(reported[0].description),
    /Allocation reversal of £16\.00 on order order-1 was NOT queued/,
    'the exact amount a human now has to post by hand',
  )
})
