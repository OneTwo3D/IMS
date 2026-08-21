import { randomUUID } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import {
  availableQtyFromRequirements,
  calculateDecimalCoverageByLine,
  calculateDecimalFulfillmentCoverage,
  scaleFulfillmentRequirements,
  type DecimalFulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  loadFulfillmentProductGraph,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'
import {
  captureFulfillmentRequirementSnapshot,
  hasFulfillmentRequirementSnapshot,
  lineFulfillmentLeafProductIds,
  lineFulfillmentRequirements,
  parseFulfillmentRequirementSnapshot,
  selectCapturableLineIds,
  type SnapshotResolvableLine,
} from '@/lib/products/fulfillment-requirement-snapshot'
import { buildBackorderReport, type BackorderReportLine } from '@/lib/domain/inventory/backorder-report'
import {
  RESERVATION_RELEASING_SHIPMENT_STATUS,
  UNCOMMITTED_SHIPMENT_STATUS,
  allocationScopeKey,
  residualAllocationRows,
  residualAllocationRowsForOrder,
  type AllocationScope,
} from '@/lib/domain/inventory/reservation-residual'
import {
  EMPTY_PENDING_SHIPMENT_RECONCILIATION,
  reconcilePendingShipments,
  type RetiredPendingShipment,
} from '@/lib/domain/sales/pending-shipment-reconciliation'
import { resolveStagedAllocationDebit } from '@/lib/domain/accounting/allocated-inventory-debit'
import {
  assertNoSalesInvoicePostingInFlight,
  cancelPendingSalesInvoiceSyncForOrder,
} from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { PermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'
import {
  validateManualSalesOrderStatusTransition,
  validateSalesOrderStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  accountedAllocationQty,
  parseCostLayerSnapshot,
  reduceSnapshotByQty,
  serializeCostLayerSnapshot,
  sumCostLayerSnapshotQty,
  sumPostedCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
  type SerializedCostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'

export const ALLOCATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const ALLOCATION_EPSILON = 0.000001
const ALLOCATION_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

/**
 * The scale `OrderAllocation.qty` is persisted at — `@db.Decimal(12, 4)` (o3d-4kfh r6, Codex
 * finding 2).
 *
 * THE ONE CANONICAL REPRESENTATION. Everything downstream reads the PERSISTED row: the reservation
 * residual, `confirmSalesOrderShipments`, the draft reconciler, the accounting sub-ledger and the
 * `stock_reserved_source_mismatch` census. So a computed quantity the column cannot hold is not a
 * quantity IMS has — it is a quantity IMS is about to round. Deciding equality, feasibility, the
 * release and the reserve against three different renderings of "the same" number is what let
 * reservedQty and the rows disagree by 0.00002 per fractional-KIT run.
 */
const ALLOCATION_QTY_DP = 4

/**
 * Quantise to the persisted scale, with the SAME rounding Postgres `numeric(12,4)` applies on write
 * (half-up). Not a floor and not a truncation: flooring each row independently breaks the KIT
 * proportionality invariant (`validateAllocationIntegrity` enforces it to 1e-6) and — worse —
 * disagrees with what the column would have stored anyway, which is the divergence being removed.
 *
 * This does NOT fix o3d-i4qd. Rounding half-up can still land a row fractionally above the
 * availability the allocator proved, and with the reserve now taken from the persisted value that
 * over-claim reaches `reservedQty` as well as the row instead of only the row. That is a deliberate
 * trade: an over-claim of at most half an ulp that the row and the reservation AGREE about is
 * recoverable and visible to the census, whereas a disagreement between them silently consumed
 * another order's reservation on every subsequent rewrite.
 */
export function canonicalAllocationQty(qty: DecimalInput): Prisma.Decimal {
  return roundQuantity(qty, ALLOCATION_QTY_DP)
}

export type AllocationServiceClient = Prisma.TransactionClient | typeof db

export type AllocateSalesOrderInput = {
  orderId: string
  refuseIfShipmentsExist?: boolean
  /**
   * o3d-4kfh r5 (Codex finding 4): the NARROWER refusal — decline only when a COMMITTED
   * (non-PENDING) shipment exists, and proceed when the order's only shipments are PENDING drafts.
   *
   * `refuseIfShipmentsExist` predates `reconcilePendingShipments`. It exists because rebuilding
   * `OrderAllocation` while leaving stale draft ShipmentLines behind produced a dispatch against
   * rows that no longer matched. That hazard is now closed at the source: every allocation rewrite
   * reconciles the drafts against the rows it just wrote, retiring exactly the ones it unbacked and
   * leaving the rest — with their tracking metadata — alone.
   *
   * Keeping the blanket refusal after that turned a fix into a trap: the overallocation rebalancer
   * releases ONE (product, warehouse) row at a time, so trimming leaf A of an A+B kit leaves sibling
   * B disproportionate, and its post-release FIFO pass is what is supposed to rebuild the order. The
   * selective reconciler now RETAINS an unrelated still-backed PENDING draft — and that retained
   * draft made the rebuild refuse, stranding B's reservation until it failed integrity at
   * confirm-for-picking. The flat census does not report it.
   *
   * A non-PENDING shipment still refuses: those are commitments, and rebuilding rows underneath one
   * is the original hazard.
   */
  refuseIfCommittedShipmentsExist?: boolean
  /**
   * o3d-67y (Codex review r11): run INSIDE the allocation transaction, after reservations are mutated and
   * immediately before it commits, ONLY on the committed (non-refused) path. Lets the caller atomically mark a
   * durable backstop resolved so a redundant, non-idempotent re-allocation cannot run in the window between the
   * allocation commit and a separate resolve. A throw here rolls the allocation back (the backstop then retries).
   */
  onReconciledInTx?: (tx: Prisma.TransactionClient) => Promise<void>
  /**
   * o3d-6ab: the set of statuses the order must STILL be in when the row lock is acquired, for this
   * allocation to be legitimate. Batch callers (the backorder allocator, the periodic reallocation
   * sweep) pick candidates by status OUTSIDE the lock; the lock serializes the writes but does not
   * revalidate the REASON for writing, so an order that moved PROCESSING→ON_HOLD (or →PICKING) in the
   * selection→lock window would still be released, deleted, recreated and re-reserved. When set and the
   * under-lock status is not in the set, allocation is an explicit no-op: nothing is written, and the
   * result is `skipped` — NOT an error (the caller's premise simply expired; another actor now owns the
   * order). Leave unset for user- and event-driven callers that allocate a specific order on purpose.
   *
   * CANCELLED / refundStatus=FULL are deliberately exempt: those already take the zero-demand path
   * below, which RELEASES reservations. Deallocation is always safe and always wanted, so the guard
   * must not turn it into a no-op that strands reservations on a cancelled order.
   */
  requireStatusUnderLock?: readonly SalesOrderStatus[]
  /**
   * o3d-6zr2: the acting user, for the pending-shipment retirement record this allocation may write.
   * That record is written through the transaction client (`reconcilePendingShipments`), which
   * cannot resolve a session, so the identity has to arrive from the action boundary. Leave null on
   * the cron/batch paths (the reallocation sweep, the overallocation rebalancer): they genuinely
   * have no user, and inventing one would be worse than recording none.
   */
  userId?: string | null
}

export type AllocateSalesOrderResult = {
  success: boolean
  error?: string
  syncProductIds: string[]
  allocationCount: number
  unallocatedLines: AllocationUnallocatedLine[]
  unallocatedQty: number
  backorderLineCount: number
  /**
   * o3d-4kfh r4: the PENDING drafts this rewrite invalidated and retired, with their tracking /
   * shipping-service metadata. Reported so the caller can log something an operator can correlate
   * against an externally purchased label — a bare count cannot be.
   */
  retiredPendingShipments?: RetiredPendingShipment[]
  orderRef?: string
  isShoppingOrder?: boolean
  shipFromWarehouseId?: string | null
  logAttempt?: boolean
  // o3d-67y: true when refuseIfShipmentsExist declined because a shipment exists — the
  // reservation was deliberately left untouched (not a failure, not a reconciliation).
  refused?: boolean
  // o3d-6ab: true when requireStatusUnderLock was set and the under-lock status was no longer
  // allocation-eligible. Explicit no-op: nothing was written, nothing was committed, and it is NOT a
  // failure — `error` is undefined so batch callers don't log it as one.
  skipped?: boolean
  // o3d-6ab: the under-lock status that caused the skip, for logging/telemetry.
  skippedStatus?: SalesOrderStatus
}

export type AllocationUnallocatedLine = Pick<
  BackorderReportLine,
  | 'lineId'
  | 'productId'
  | 'sku'
  | 'description'
  | 'orderedQty'
  | 'committedShipmentQty'
  | 'allocatedQty'
  | 'unallocatedQty'
  | 'backorderEligible'
  | 'reason'
> & { componentBlockers: string[] }

type AllocationRowInput = {
  lineId: string
  productId: string
  warehouseId: string
  qty: Prisma.Decimal
}

type DecimalStockMap = Map<string, Map<string, Prisma.Decimal>>

function canRunTransaction(
  client: AllocationServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

export function buildAvailableStockMap(
  rows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
): DecimalStockMap {
  const stockMap: DecimalStockMap = new Map()
  for (const row of rows) {
    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(
      row.warehouseId,
      Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(row.quantity).sub(toDecimal(row.reservedQty))),
    )
  }
  return stockMap
}

/**
 * Available stock with THIS order's own reservation added back, so a recomputation is not fighting
 * reservations it already holds.
 *
 * `ownRows` MUST be residual rows (`residualAllocationRows`) — this order's LIVE reservation, not
 * its retained `OrderAllocation` quantities. Raw rows over-state ownQty on a dispatched order,
 * which under-computes `otherReservedQty` by the shipped amount and lets this order allocate
 * straight into another order's live reservation (o3d-4kfh).
 */
export function buildAvailableStockMapIncludingOwnReservations(
  stockRows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
): DecimalStockMap {
  const ownByProductWarehouse = new Map<string, Prisma.Decimal>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByProductWarehouse.set(
      key,
      (ownByProductWarehouse.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)),
    )
  }

  const stockMap: DecimalStockMap = new Map()
  for (const row of stockRows) {
    const quantity = toDecimal(row.quantity)
    const reservedQty = toDecimal(row.reservedQty)
    const ownQty = ownByProductWarehouse.get(`${row.productId}:${row.warehouseId}`) ?? new Prisma.Decimal(0)
    if (ownQty.gt(reservedQty.add(ALLOCATION_EPSILON_DECIMAL))) {
      console.warn(
        `[allocation-service] own allocations exceed reserved stock for product ${row.productId} in warehouse ${row.warehouseId}; reservedQty=${reservedQty.toString()}, ownQty=${ownQty.toString()}`,
      )
    }
    const otherReservedQty = Prisma.Decimal.max(new Prisma.Decimal(0), reservedQty.sub(ownQty))
    const available = Prisma.Decimal.max(new Prisma.Decimal(0), quantity.sub(otherReservedQty))

    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(row.warehouseId, available)
  }
  return stockMap
}

/**
 * (product, warehouse) scopes where this order's OWN LIVE reservation exceeds what is actually
 * reserved against it (o3d-4kfh).
 *
 * `ownRows` MUST be residual rows (`residualAllocationRows`), never raw `OrderAllocation` rows.
 * Dispatch decrements reservedQty and retains the allocation row, so on any partially or fully
 * dispatched order `rawQty > reservedQty` is the CORRECT steady state — feeding raw rows here made
 * this fire on healthy data, which is exactly the noise that hid the real leak.
 *
 * Detection only. The unconditional release/delete/recreate/reserve cycle does NOT repair such a
 * row — it releases this order's own quantity and reserves the same quantity straight back, which
 * nets to zero against the discrepancy. So neither allocating nor short-circuiting fixes it, and
 * forcing a rewrite would only reintroduce churn.
 *
 * With the release paths fixed to release residuals and to fail closed rather than floor a whole
 * scope to zero, the leak that GENERATED these shortfalls is gone. A surviving report now means a
 * writer outside these paths, and `invariants.ts` (`stock_reserved_source_mismatch`) is the census.
 */
export function findUnderReservedScopes(
  stockRows: Array<{ productId: string; warehouseId: string; reservedQty: DecimalInput }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
): Array<{ productId: string; warehouseId: string }> {
  const ownByScope = new Map<string, Prisma.Decimal>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByScope.set(key, (ownByScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }

  const scopes: Array<{ productId: string; warehouseId: string }> = []
  for (const row of stockRows) {
    const ownQty = ownByScope.get(`${row.productId}:${row.warehouseId}`)
    if (!ownQty) continue
    if (ownQty.gt(toDecimal(row.reservedQty).add(ALLOCATION_EPSILON_DECIMAL))) {
      scopes.push({ productId: row.productId, warehouseId: row.warehouseId })
    }
  }
  return scopes
}

function cloneAvailableStockMap(
  stockMap: DecimalStockMap,
): DecimalStockMap {
  const copy: DecimalStockMap = new Map()
  for (const [productId, byWarehouse] of stockMap) {
    copy.set(productId, new Map(byWarehouse))
  }
  return copy
}

function applyRequirementDeltaToAvailableMap(
  stockMap: DecimalStockMap,
  requirements: Map<string, DecimalInput>,
  warehouseId: string,
  direction: 'reserve' | 'release',
) {
  for (const [productId, qty] of requirements) {
    const byWarehouse = stockMap.get(productId) ?? new Map<string, Prisma.Decimal>()
    const current = byWarehouse.get(warehouseId) ?? new Prisma.Decimal(0)
    const delta = toDecimal(qty)
    byWarehouse.set(
      warehouseId,
      direction === 'reserve' ? current.sub(delta) : current.add(delta),
    )
    stockMap.set(productId, byWarehouse)
  }
}

/**
 * Which sales orders each open transaction has row-locked (o3d-3zgy).
 *
 * Postgres cannot answer this for us: an uncontended `SELECT ... FOR UPDATE` records the lock in the
 * tuple header, not in `pg_locks`, so there is nothing to query. This registry is therefore an
 * IN-PROCESS assertion aid, not a distributed guarantee — its job is to make a caller that forgot to
 * hoist the lock fail loudly instead of silently reopening the delete race.
 *
 * Keyed weakly on the transaction client, so entries disappear with the transaction object and
 * nothing has to clean up on commit or rollback.
 */
const ordersLockedByTx = new WeakMap<object, Set<string>>()

/** Has THIS transaction already row-locked this order? See ordersLockedByTx for the caveats. */
export function hasLockedSalesOrder(tx: Prisma.TransactionClient, orderId: string): boolean {
  return ordersLockedByTx.get(tx as object)?.has(orderId) ?? false
}

export async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`,
  )
  // Recorded AFTER the lock is actually held, so a failed lock never registers.
  const locked = ordersLockedByTx.get(tx as object)
  if (locked) locked.add(orderId)
  else ordersLockedByTx.set(tx as object, new Set([orderId]))
}


export async function lockStockLevels(
  tx: Prisma.TransactionClient,
  productIds: string[],
  warehouseIds: string[],
): Promise<void> {
  if (productIds.length === 0 || warehouseIds.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`
      SELECT id
      FROM "stock_levels"
      WHERE "productId" IN (${Prisma.join(productIds)})
        AND "warehouseId" IN (${Prisma.join(warehouseIds)})
      FOR UPDATE
    `,
  )
}

/**
 * The journal-safe check: would this proposed allocation set destroy evidence a Group B journal
 * has already posted against? (o3d-0i5y r4)
 *
 * Two ways to fail, and the message names which row and by how much, because "allocation change
 * refused" with no coordinates is not something an operator can act on:
 *
 *   - the caller DECLARED NOTHING. It cannot be permitted, because nothing it says can be checked.
 *     The remedy is stated outright: re-allocate the order, which does declare its set.
 *   - the declared set drops a posted row, or covers less of it than the journal posted. That
 *     really is the destructive case the original refusal existed for, and there is no way to
 *     write it safely — the remedy is a refund/return, which reverses through the very rows this
 *     refuses to disturb.
 *
 * Compared with the allocation epsilon, not exactly: `persistedAllocations` is canonicalised to
 * `numeric(12,4)` and a fractional-KIT component can round half an ulp below the raw shipped
 * quantity it covers. Refusing the whole recovery over 0.00005 of a component would be the same
 * over-refusal in miniature.
 */
async function assertJournalSafeAllocationChange(
  tx: Prisma.TransactionClient,
  orderId: string,
  nextAllocations: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }> | undefined,
): Promise<void> {
  if (!nextAllocations) {
    throw new Error(
      'Cannot modify allocations one row at a time after shipments have been posted to accounting. '
      + 'Use Re-Allocate on the order instead — a re-allocation keeps every posted shipment\'s '
      + 'quantity on the row it was picked from, so it is allowed here. If the order has to lose '
      + 'allocated quantity that has already shipped, process a refund or return: that reverses '
      + 'through these rows instead of deleting them.',
    )
  }

  const floors = await journaledAllocationFloors(tx, orderId)
  if (floors.size === 0) return

  const nextByKey = new Map<string, Prisma.Decimal>()
  for (const row of nextAllocations) {
    const key = allocationScopeKey(row)
    nextByKey.set(key, (nextByKey.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }

  const shortfalls: string[] = []
  for (const [key, floor] of floors) {
    const proposed = nextByKey.get(key) ?? new Prisma.Decimal(0)
    if (proposed.gte(floor.qty.sub(ALLOCATION_EPSILON_DECIMAL))) continue
    shortfalls.push(
      `${floor.productId} @ ${floor.warehouseId} on line ${floor.lineId} `
      + `(posted ${floor.qty.toString()}, allocation would keep ${proposed.toString()})`,
    )
  }
  if (shortfalls.length === 0) return

  throw new Error(
    'Cannot reduce an allocation below the quantity already posted to accounting: '
    + `${shortfalls.join('; ')}. `
    + 'The shipment journal and the refund cost reversal both resolve their cost basis through '
    + 'these rows, so shrinking one reverses cost for units that have already left. Process a '
    + 'refund or return for the quantity that is coming back instead.',
  )
}

/**
 * The quantity each allocation row has already had POSTED against it by a Group B shipment
 * journal, at (lineId, warehouseId, productId) grain — the same grain `OrderAllocation` is unique
 * on, and the grain `residualAllocationRows` nets at.
 *
 * o3d-0i5y r4 — THIS IS THE FACT THE JOURNALED REFUSAL WAS STANDING IN FOR. Once Group B has
 * posted a shipment, two things on the allocation row it was picked from become evidence for a
 * ledger entry that already exists: the row's `id` (a shipment line's `costLayerSnapshot` carries
 * it as `orderAllocationId`, and `refund-service` relieves the allocation basis through exactly
 * that reference) and the row's own `costLayerSnapshot`. Destroy either and the refund reversal
 * silently reverses cost for units that already shipped, because a dangling `orderAllocationId`
 * relieves nothing.
 *
 * What must NOT happen is that a row is deleted, or shrunk below what a journal posted against it.
 * That is narrower than "no allocation change at all", and the difference is the whole of this
 * issue — see {@link resetAllocationAccountingIfStaged}.
 */
export async function journaledAllocationFloors(
  client: Pick<Prisma.TransactionClient, 'shipmentLine'>,
  orderId: string,
): Promise<Map<string, AllocationScope & { qty: Prisma.Decimal }>> {
  const lines = await client.shipmentLine.findMany({
    where: { shipment: { orderId, shipmentJournalDate: { not: null } } },
    select: {
      lineId: true,
      productId: true,
      qty: true,
      shipment: { select: { warehouseId: true } },
    },
  })
  const floors = new Map<string, AllocationScope & { qty: Prisma.Decimal }>()
  for (const line of lines) {
    const scope: AllocationScope = {
      lineId: line.lineId,
      productId: line.productId,
      warehouseId: line.shipment.warehouseId,
    }
    const key = allocationScopeKey(scope)
    const running = floors.get(key)?.qty ?? new Prisma.Decimal(0)
    floors.set(key, { ...scope, qty: running.add(toDecimal(line.qty)) })
  }
  return floors
}

/** What one (line, warehouse, product) scope will hold as its A2 record after a rewrite. */
export type AccountedRecordPlanEntry = {
  /** The complete record — the entries Group A2 has already posted against these units. */
  entries: CostLayerSnapshotEntry[]
  /**
   * The value to WRITE onto the row, when a record moved onto this scope from one the rewrite is
   * dropping. `null` when the row already holds its record and must simply be left alone.
   */
  write: SerializedCostLayerSnapshotEntry[] | null
}

/** Keyed by {@link allocationScopeKey} of the row in the NEXT set. */
export type AccountedRecordPlan = Map<string, AccountedRecordPlanEntry>

export type AccountedRecordCarryOver = {
  /** Where each surviving posted record lives once the caller has written its set. */
  records: AccountedRecordPlan
  /**
   * o3d-0i5y r9: recorded units NO row in the new set can hold — the part of Group A2's
   * Allocated-Inventory debit this rewrite orphans. Nothing downstream will ever relieve it (the
   * units will not ship, so Group B never credits; they were not refunded, so the refund reversal
   * never sees them), which makes it a reversal the caller owes, not a rounding detail. Valued by
   * {@link sumPostedCostLayerSnapshot} at what was POSTED, never at the pin as it stands now.
   */
  orphaned: CostLayerSnapshotEntry[]
}

/**
 * WHERE EACH POSTED RECORD LIVES AFTER THIS REWRITE (o3d-0i5y r8).
 *
 * An allocation row's `costLayerSnapshot` is not decoration and not a cache: it is the record that
 * Group A2 has already debited Allocated Inventory for those units. Group A2 decides what it owes by
 * reading it, so anything that DESTROYS it re-presents posted units as unaccounted, and the next
 * pass posts them a second time. Nothing reverses the first posting.
 *
 * The rewrite destroyed it in the ordinary course of business. Move a residual from warehouse-1 to
 * warehouse-2 — a stock transfer, a warehouse going out of stock, the 15-minute re-allocation sweep
 * finding a better source — and the (line, w1, product) scope is not in the new set, so its row is
 * deleted and a brand-new (line, w2, product) row is created with no record at all. A2 then sees a
 * row with an empty record and its full quantity outstanding, and pins and posts every unit again:
 *
 *   10 units allocated at w1, pinned and posted by A2 at £5 = £50 in Allocated Inventory.
 *   the stock moves to w2. The w1 row is deleted, the w2 row created blank.
 *   the next A2 pass posts another £50 for the SAME 10 units. Allocated Inventory now holds £100.
 *
 * So the record follows the units instead of following the row. A scope the new set keeps holds its
 * own record; a scope it drops hands its record to the new scopes of the same (line, product),
 * oldest warehouse first, filling each up to its quantity.
 *
 * AND WHAT NO SURVIVING ROW CAN HOLD IS NOT SILENTLY LEFT ON A ROW — IT IS HANDED BACK AS A DEBIT
 * TO REVERSE (o3d-0i5y r9). r8 filled the last destination with whatever was left over and let a
 * kept-but-SHRUNK row go on recording more units than it holds, on the reading that
 * {@link unaccountedAllocationQty}'s floor already tolerates that. The floor does — and the floor
 * is the wrong instrument, because it only stops the units being posted AGAIN. It says nothing
 * about the pounds already sitting in Allocated Inventory for units that have left the order:
 *
 *   line L allocated 10 at w1. A2 pins and posts 10 x £4 = £40 into Allocated Inventory.
 *   the customer drops the line to 6, so the rewrite leaves the w1 row holding 6.
 *   r8: the row still records 10. Group B relieves 6 x £4 = £24 when they ship, a refund relieves
 *       nothing (the 4 units were never invoiced), and £16 of a real debit stays in Allocated
 *       Inventory for ever, with Inventory understated by the same £16.
 *   r9: the record is trimmed to the 6 units the row will hold, and the 4 orphaned units are
 *       returned to the caller to REVERSE at the £4 a unit A2 recorded posting — CR Allocated £16,
 *       DR Inventory £16. Allocated Inventory then holds exactly the £24 Group B will relieve.
 *
 * A record whose (line, product) has no row left at all is orphaned in full, for the same reason:
 * those units are off the order (a deallocation, a cancellation, a full refund), nothing will
 * re-allocate them, and nothing else will ever relieve their debit either.
 *
 * The orphaned entries are valued by the caller AT WHAT WAS POSTED FOR THEM
 * ({@link sumPostedCostLayerSnapshot}), never at the pin as it stands now — see
 * `postedUnitCostBase`. A reversal posted wrongly is as bad as the original.
 *
 * This is the same rule as {@link resetAllocationAccountingIfStaged}'s: what has been posted is a
 * recorded FACT. A reset means "come back to A2 for whatever is NEW", never "forget what was posted".
 */
export function planAccountedRecordCarryOver(
  existing: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; costLayerSnapshot?: Prisma.JsonValue | null }>,
  next: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }>,
): AccountedRecordCarryOver {
  const nextQtyByKey = new Map<string, Prisma.Decimal>()
  for (const row of next) {
    const key = allocationScopeKey(row)
    nextQtyByKey.set(key, (nextQtyByKey.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }

  const plan: AccountedRecordPlan = new Map()
  const orphaned: CostLayerSnapshotEntry[] = []
  const poolByLineProduct = new Map<string, CostLayerSnapshotEntry[]>()
  const addToPool = (lineId: string, productId: string, entries: CostLayerSnapshotEntry[]) => {
    if (entries.length === 0) return
    const lineProduct = `${lineId}|${productId}`
    poolByLineProduct.set(lineProduct, [...(poolByLineProduct.get(lineProduct) ?? []), ...entries])
  }

  for (const row of existing) {
    const entries = parseCostLayerSnapshot(row.costLayerSnapshot ?? null)
    if (entries.length === 0) continue
    const key = allocationScopeKey(row)
    const surviving = nextQtyByKey.get(key)
    if (surviving === undefined) {
      addToPool(row.lineId, row.productId, entries)
      continue
    }
    const recordedQty = sumCostLayerSnapshotQty(entries)
    // Compared against the allocation epsilon, not exactly: `persistedAllocations` is canonicalised
    // to numeric(12,4) and can land half an ulp below the record it covers exactly. Trimming half a
    // millionth of a unit off a record — and raising a reversal for it — would be noise, not a fix.
    if (recordedQty.lte(surviving.add(ALLOCATION_EPSILON_DECIMAL))) {
      plan.set(key, { entries, write: null })
      continue
    }
    // FIFO from the FRONT, so the units this row keeps are the ones recorded earliest — which is
    // where A2 writes its `source: 'shipment'` entries, the record of units that have already left.
    // Trimming those off would re-present dispatched units as never accounted.
    const { taken } = takeFromSnapshotEntries(entries, surviving.toNumber())
    plan.set(key, { entries: taken, write: serializeCostLayerSnapshot(taken) })
    addToPool(row.lineId, row.productId, reduceSnapshotByQty(entries, sumCostLayerSnapshotQty(taken)))
  }

  for (const [lineProduct, stranded] of poolByLineProduct) {
    const destinations = next
      .filter((row) => `${row.lineId}|${row.productId}` === lineProduct)
      .slice()
      .sort((a, b) => (a.warehouseId === b.warehouseId ? 0 : a.warehouseId < b.warehouseId ? -1 : 1))

    let pool = stranded
    for (const destination of destinations) {
      if (pool.length === 0) break
      const key = allocationScopeKey(destination)
      const held = plan.get(key)?.entries ?? []
      const headroom = (nextQtyByKey.get(key) ?? toDecimal(0)).sub(sumCostLayerSnapshotQty(held))
      if (headroom.lte(ALLOCATION_EPSILON_DECIMAL)) continue
      const { taken } = takeFromSnapshotEntries(pool, headroom.toNumber())
      if (taken.length === 0) continue
      pool = reduceSnapshotByQty(pool, sumCostLayerSnapshotQty(taken))
      const entries = [...held, ...taken]
      plan.set(key, { entries, write: serializeCostLayerSnapshot(entries) })
    }

    // NOT dumped on the last destination the way r8 dumped it. A row cannot hold a record for units
    // it does not have without the floor quietly absorbing a debit nobody will ever relieve; these
    // units are off the order, and what they are owed is a REVERSAL.
    if (sumCostLayerSnapshotQty(pool).gt(ALLOCATION_EPSILON_DECIMAL)) orphaned.push(...pool)
  }

  return { records: plan, orphaned }
}

/** One (line, product) scope's rows, with the record each held AS OF THE LOCK. */
export type LockedAccountedRecordRow = {
  lineId: string
  productId: string
  warehouseId: string
  costLayerSnapshot: Prisma.JsonValue | null
}

/**
 * ROW-LOCK THE RECORDS OF ONE (line, product) SCOPE AND HAND BACK WHAT THEY HOLD AS OF THE LOCK
 * (o3d-0i5y r11 — Codex round 11, finding 1).
 *
 * The sales-order lock does not cover `order_allocations`, and there is exactly one writer that
 * touches them without it: `updateSnapshotsForCostLayerChange`, the late-landed-cost correction. It
 * selects rows by `costLayerSnapshot @> [{costLayerId}] FOR UPDATE` across every table that carries
 * a snapshot and takes no order lock at all, because it is a purchasing-side sweep that does not
 * know which orders it will touch. So it is the one writer that can move a row a re-filing pass has
 * already read.
 *
 * The two locks answer two different questions and both are needed:
 *
 *   THE ORDER LOCK stops rows APPEARING OR DISAPPEARING in the scope — every writer of allocation
 *   rows takes it (the allocator, `addAllocation`, the manual editor, the rebalancer), and the
 *   correction only ever UPDATEs.
 *   THIS ROW LOCK stops the RECORD ON A ROW being revalued underneath the plan. Held from here to
 *   commit, so a correction that arrives after it waits, then patches the array this pass wrote.
 *
 * TAKEN AT THE WRITE, NOT EARLIER, and for round 10's reason. The correction runs
 * cost_layers -> order_allocations; a pass that locked these rows before its own cost-layer or
 * stock work would run order_allocations -> (cost_layers | stock_levels) and close a real deadlock
 * cycle between two writers that both matter. Taken at the point the caller's own UPDATE/DELETE
 * would take the row lock anyway, the ordering is unchanged and nothing new can wait on anything
 * new.
 *
 * Ordered by id so two lockers of the same set queue rather than interleave.
 */
export async function lockAccountedRecordsForScope(
  tx: Prisma.TransactionClient,
  orderId: string,
  lineId: string,
  productId: string,
): Promise<LockedAccountedRecordRow[]> {
  return tx.$queryRaw<LockedAccountedRecordRow[]>(
    Prisma.sql`
      SELECT "lineId", "productId", "warehouseId", "costLayerSnapshot"
      FROM "order_allocations"
      WHERE "orderId" = ${orderId} AND "lineId" = ${lineId} AND "productId" = ${productId}
      ORDER BY id
      FOR UPDATE
    `,
  )
}

/**
 * The same lock, for a caller that rewrites a WHOLE ORDER's rows rather than one scope's
 * (o3d-0i5y r11). See {@link lockAccountedRecordsForScope} for why it is taken where it is taken.
 */
export async function lockAccountedRecordsForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<LockedAccountedRecordRow[]> {
  return tx.$queryRaw<LockedAccountedRecordRow[]>(
    Prisma.sql`
      SELECT "lineId", "productId", "warehouseId", "costLayerSnapshot"
      FROM "order_allocations"
      WHERE "orderId" = ${orderId}
      ORDER BY id
      FOR UPDATE
    `,
  )
}

/**
 * A BASE WHOSE QUANTITY MOVED IS REFUSED BY NAME (o3d-0i5y r11, r10's rule for Group A2).
 *
 * The landed-cost correction maps each entry to itself: it rewrites `unitCostBase` and can change
 * neither the recorded quantity nor the entry count. So a locked base recording a different quantity
 * than the read this pass planned from means a writer nothing here can account for, and the plan
 * built on that read — which scope inherits which units, and how many are orphaned — is describing
 * rows that no longer exist.
 *
 * It cannot be reached today: every path that changes WHICH units are recorded takes the order row
 * lock this pass holds. It fails closed rather than trusting that to stay true.
 */
function assertAccountedRecordBaseUnmoved(
  planned: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; costLayerSnapshot?: Prisma.JsonValue | null }>,
  locked: ReadonlyArray<LockedAccountedRecordRow>,
): void {
  const qtyByScope = (rows: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; costLayerSnapshot?: Prisma.JsonValue | null }>) => {
    const map = new Map<string, Prisma.Decimal>()
    for (const row of rows) {
      const key = allocationScopeKey(row)
      const qty = sumCostLayerSnapshotQty(parseCostLayerSnapshot(row.costLayerSnapshot ?? null))
      map.set(key, (map.get(key) ?? toDecimal(0)).add(qty))
    }
    return map
  }
  const plannedQty = qtyByScope(planned)
  const lockedQty = qtyByScope(locked)
  for (const key of new Set([...plannedQty.keys(), ...lockedQty.keys()])) {
    const before = plannedQty.get(key) ?? toDecimal(0)
    const after = lockedQty.get(key) ?? toDecimal(0)
    if (!before.eq(after)) {
      throw new Error(
        `Allocation scope ${key} recorded ${before.toString()} unit(s) when this pass planned from it `
        + `and ${after.toString()} unit(s) under the write lock — Group A2's record moved underneath `
        + 'the re-allocation and the plan built on it cannot be trusted',
      )
    }
  }
}

/**
 * RE-FILE GROUP A2'S RECORD ONTO THE ROWS THIS CHANGE LEFT BEHIND, AND REVERSE WHAT NOTHING CAN
 * HOLD (o3d-0i5y r11).
 *
 * ONE implementation, for the same reason {@link reverseOrphanedAllocationPosting} is exported: the
 * manual editor and the over-allocation rebalancer both take recorded units off a single
 * (line, product) scope, and a second copy of this sequence is a second thing to get wrong. The
 * allocator keeps its own call to {@link planAccountedRecordCarryOver} because it declares a whole
 * ORDER's next set in one pass and interleaves the record write with the row rewrite it is already
 * doing.
 *
 * `base` is what {@link lockAccountedRecordsForScope} read UNDER THE LOCK, before the caller's first
 * row write. It is not re-derived here: by the time this runs the source row may have been deleted
 * outright (a reduction to zero, a merge), and its record — which the surviving rows inherit — would
 * be unreadable.
 *
 * A2 APPENDS AND SO IT REBASES; THIS PATH RE-AUTHORS, SO IT PLANS FROM A BASE NOTHING CAN HAVE
 * MOVED. Round 10 gave A2 the append rule ("it appends, it does not re-author what it merely read")
 * because A2's own entries are additions to a record it has no business rewriting. A carry-over
 * cannot append: trimming a row to the units it keeps, and moving the remainder to the scopes that
 * inherit those units, is re-authoring by definition. So the equivalent guarantee is taken on the
 * other side — the base is read under a lock held to commit, so the correction cannot land between
 * the read and the write at all, and the entries this writes carry the CORRECTED `unitCostBase`
 * rather than the one the plan was drawn from.
 *
 * The reversal amount is unaffected either way: it comes from `postedUnitCostBase`, which no
 * revaluation rewrites. What the lock protects is the PIN the surviving rows keep, which Group B
 * relieves against when those units ship.
 */
export async function refileAccountedRecordsForScope(
  tx: Prisma.TransactionClient,
  orderId: string,
  scope: { lineId: string; productId: string },
  base: ReadonlyArray<LockedAccountedRecordRow>,
): Promise<void> {
  const writtenRows = await tx.orderAllocation.findMany({
    where: { orderId, lineId: scope.lineId, productId: scope.productId },
    select: { lineId: true, productId: true, warehouseId: true, qty: true },
  })
  const { records, orphaned } = planAccountedRecordCarryOver(
    base,
    writtenRows.map((row) => ({ ...row, qty: toDecimal(row.qty) })),
  )
  for (const row of writtenRows) {
    // `write` is null for a row that already holds its own record and must simply be left alone;
    // re-writing it would serialize a value nothing asked to change.
    const carried = records.get(allocationScopeKey(row))?.write
    if (!carried) continue
    await tx.orderAllocation.update({
      where: {
        lineId_warehouseId_productId: {
          lineId: row.lineId,
          warehouseId: row.warehouseId,
          productId: row.productId,
        },
      },
      data: { costLayerSnapshot: carried as Prisma.InputJsonValue },
    })
  }
  // LAST, after every row write, so the journal and the state it describes commit together (the r9
  // rebase decision), and inside the caller's transaction under the order row lock it already holds
  // — which is what `queueAccountingSyncTx` requires of an order-scoped enqueue.
  await reverseOrphanedAllocationPosting(tx, orderId, orphaned)
}

/**
 * PRESERVE WHAT GROUP A2 POSTED FOR AN ORDER BEING CANCELLED — AND DO NOT REVERSE IT HERE
 * (o3d-0i5y r11 — Codex round 11, finding 3).
 *
 * A whole-order cancellation `deleteMany`s every allocation row, and each row's `costLayerSnapshot`
 * is Group A2's record that it DEBITED Allocated Inventory for those units and (through
 * `postedUnitCostBase`) the amount it debited. After this transaction commits, no row anywhere says
 * how many pounds of that debit these particular units carried, or which layers they came off.
 *
 * SO THE EVIDENCE IS KEPT, AND ONLY THE EVIDENCE — the reversal itself is not raised here.
 *
 * r11 justified that with an arithmetic claim: o3d-batch-cancelrb's open balance could not SEE an
 * `ALLOCATION_REVERSAL`, so raising one here would have been credited a second time on a
 * cancelled-then-refunded order. THAT CLAIM IS NO LONGER TRUE and must not be left where somebody
 * would trust it (o3d-xlk7). That branch merged as PR #635, and this branch's rebase onto it taught
 * the open balance to net `ALLOCATION_REVERSAL` relief — proved from those journals' own lines and
 * recorded durably on `SalesOrder.allocationReversalAmount`. A reversal raised here would now be
 * counted exactly once.
 *
 * WHAT STILL HOLDS, and is now the whole reason:
 *
 *   * THE MERGED BRANCH OWNS THIS CONTRA ON THE REFUND SIDE, and says so in
 *     `lib/domain/accounting/allocated-inventory-debit.ts`: "What is deliberately NOT attempted here
 *     is REVERSING the debit when the order's allocations shrink or the order is cancelled
 *     outright... keeping the record is what makes that repair possible later instead of
 *     impossible." What it reverses is the residual contra on a REFUND, and a cancelled order that
 *     is then refunded in full gets exactly that. Raising a second, competing reversal on the
 *     cancellation itself is a behaviour change this rebase has no evidence for, and it would credit
 *     an account for an order a human may still be deciding about.
 *   * AND THE ORDER-LEVEL RECORD SURVIVES THIS PATH, which is what makes waiting safe. r11 wrote
 *     that the un-stage a few statements earlier had already cleared the stamp, the batch ref and
 *     `allocationBatchAmount`, so every copy of the record died together. It has NOT since #635:
 *     `resetAllocationAccountingIfStaged` keeps the stamp, the recorded debit and the journal
 *     attribution wherever `resolveStagedAllocationDebit` says the debit stands. The refund's open
 *     balance, the batch-log recreate sweep and the delete guard all still find their figure.
 *
 * A RECORD CANNOT DOUBLE-COUNT: nothing is queued, nothing is posted, no relief is claimed. What it
 * adds over the surviving order-level figure is the part that figure cannot express — WHICH LAYERS
 * and HOW MANY UNITS were standing when the rows went, which is what a human repairing a cancelled,
 * never-refunded order needs and what `deleteMany` is about to destroy.
 *
 * The units that cannot say what was posted for them are named separately, on the same rule the
 * reversal path applies: an entry with no `postedUnitCostBase` is not evidence of £0, it is evidence
 * of nothing, and a human decides.
 */
async function recordStandingAllocationDebitOnCancel(
  tx: Prisma.TransactionClient,
  orderId: string,
  records: CostLayerSnapshotEntry[],
): Promise<void> {
  if (records.length === 0) return
  const { posted, unevidenced } = sumPostedCostLayerSnapshot(records)
  const amount = roundQuantity(posted, 2)
  if (amount.lte(0) && unevidenced.length === 0) return

  const unevidencedQty = sumCostLayerSnapshotQty(unevidenced)
  await tx.activityLog.create({
    data: {
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'allocation_debit_standing_on_cancel',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `Order ${orderId} was cancelled holding ${sumCostLayerSnapshotQty(records).toString()} unit(s) `
        + `Group A2 had already reclassified. £${amount.toFixed(2)} of DR Allocated Inventory / CR `
        + 'Inventory stands against this order and nothing downstream will relieve it: the units will '
        + 'not ship (Group B credits only what dispatches) and they were not refunded. The allocation '
        + 'rows carrying that record are deleted by this cancellation, so it is recorded here instead. '
        + 'NO reversal journal was raised here — the refund side of this contra owns it (o3d-o97): a '
        + 'full refund of this order reverses whatever of the A2 debit is still open. The order still '
        + 'carries its A2 stamp and recorded debit, so that repair remains available. Reverse by hand, '
        + 'or through a refund, if the debit is real and no refund is coming.'
        + (unevidenced.length > 0
          ? ` ${unevidencedQty.toString()} of those unit(s) carry no record of what was posted for them `
            + `(cost layer(s) ${[...new Set(unevidenced.map((entry) => entry.costLayerId))].join(', ')}) `
            + 'and are NOT included in the amount above.'
          : ''),
      metadata: {
        postedAmountBase: amount.toNumber(),
        recordedQty: sumCostLayerSnapshotQty(records).toString(),
        unevidencedQty: unevidencedQty.toString(),
        costLayerIds: [...new Set(records.map((entry) => entry.costLayerId))],
      },
    },
  })
}

/**
 * REVERSE THE PART OF GROUP A2'S DEBIT THIS REWRITE ORPHANED (o3d-0i5y r9).
 *
 * Group A2 posts DR Allocated Inventory / CR Inventory for the units an order has allocated. Before
 * this function existed, two things relieved that debit and only two: Group B credits Allocated
 * Inventory for the units a shipment dispatches, and a refund credits it for the units it takes
 * back. A rewrite that removes recorded units from the order reaches NEITHER — the units will not
 * ship and were not refunded — so their share of the debit sat in Allocated Inventory for ever,
 * with Inventory understated by the same amount. r8 named this itself: a shrunk row's over-posted
 * value needs a REVERSAL, not a floor. This is the reversal, and it is the THIRD relief source.
 *
 * BEING THE THIRD IS NOT FREE (o3d-xlk7). o3d-o97's refund arithmetic computes how many pounds of
 * the A2 debit are still open by subtracting relief it can prove, and it was written knowing only
 * the first two — so a reversal raised here and a full refund later would credit the SAME units
 * twice. The enqueue below is therefore paired with a durable record on the order
 * (`SalesOrder.allocationReversalAmount`) that the refund's open balance nets off, and the refund
 * proves the figure from these journals' own lines. Neither half works without the other: without
 * the record the relief disappears when retention sweeps the journal, and without the netting the
 * account is credited twice.
 *
 * THE AMOUNT IS THE ONE A2 RECORDED, AND THE RECORD IS THE EVIDENCE THAT IT POSTED.
 * o3d-o97 (merged as PR #635) established the rule on the refund side of this same contra, and
 * both halves of it apply here:
 *
 *   * A reversal posted wrongly is as bad as the original, so this needs POSITIVE evidence that
 *     the original posted — never the absence of evidence against it, and never a stamp. The
 *     evidence used here is `postedUnitCostBase`: an amount A2 WROTE onto the entry, in the same
 *     statement that wrote the entry and the same transaction that raised the journal for it. An
 *     entry that carries one was valued by a pass whose batch total was therefore positive, which
 *     is a pass that created a journal. An entry WITHOUT one — every entry written before r9, and
 *     any entry a future path forgets to stamp — says nothing about what was posted, so it
 *     contributes NOTHING and is reported instead, exactly as the sibling reports a stamp with no
 *     recorded amount.
 *   * It reverses what was recorded, never the pin revalued since. `unitCostBase` on these very
 *     entries is rewritten in place by `updateSnapshotsForCostLayerChange` when a landed cost
 *     arrives late, and that revaluation posts to COGS/Inventory and never to Allocated Inventory.
 *     Valuing the reversal from the live pin would credit £12 against a £30 debit when layers fell,
 *     or £42 when they rose. `sumPostedCostLayerSnapshot` consults no layer cost at all.
 *
 * THE SIBLING'S RULE IS REUSED; ITS CODE IS NOT, and deliberately. That path answers a LEDGER
 * BALANCE for a whole order — how many pounds of a debit nobody will relieve — from a per-order
 * amount, because a refund can fire long after the rows have been deleted and re-created. This one
 * answers a much smaller question at a much finer grain: these specific units, identified as they
 * leave, in the same transaction that removes them. Re-deriving an order-level balance here would
 * be the second notion of "what was posted" the rule warns against.
 *
 * NO IDEMPOTENCY KEY, on purpose. The enqueue is inside the caller's transaction, alongside the
 * row rewrite that orphaned the units, so it commits or rolls back with it — a retry re-does both
 * or neither. A key would instead make two genuinely separate shrinks of the same units at
 * different times collapse into one reversal, which is a silent under-reversal.
 *
 * AND THE ENQUEUE IS VERIFIED AGAINST THE DATABASE, NOT AGAINST ITS OWN RETURN (o3d-0i5y r10).
 * See {@link assertAllocationReversalQueued}.
 *
 * EXPORTED because it is not the allocator's private business: every path that takes recorded
 * units off an order owes the same reversal, and there must be exactly one implementation of it
 * (o3d-0i5y r10 — the manual editor and the deallocation teardown both call it now).
 */
export async function reverseOrphanedAllocationPosting(
  tx: Prisma.TransactionClient,
  orderId: string,
  orphaned: CostLayerSnapshotEntry[],
): Promise<void> {
  if (orphaned.length === 0) return

  const { posted, unevidenced } = sumPostedCostLayerSnapshot(orphaned)
  if (unevidenced.length > 0) {
    // Not silently dropped, and not guessed at either: a human has to decide whether a legacy
    // debit needs reversing by hand, and cannot if nothing says the units left.
    await tx.activityLog.create({
      data: {
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'allocation_reversal_unevidenced',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `Re-allocation removed ${sumCostLayerSnapshotQty(unevidenced).toString()} recorded unit(s) `
          + `from order ${orderId} that carry no record of what Group A2 posted for them `
          + `(cost layer(s) ${[...new Set(unevidenced.map((entry) => entry.costLayerId))].join(', ')}). `
          + 'No Allocated Inventory reversal was raised for them — the amount cannot be established '
          + 'from the allocation pin, which a landed-cost revaluation rewrites. Reverse by hand if '
          + 'the debit is real.',
      },
    })
  }

  const amount = roundQuantity(posted, 2).toNumber()
  if (amount <= 0) return

  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  // Caught, not thrown, exactly as `queueShipmentCogsRevaluationSync` catches it: a settings read
  // that fails must not roll back the ALLOCATION. The un-postable branch below then reports the
  // orphaned amount instead of losing it silently.
  const settings = await getAccountingSettings().catch(() => null)
  if (!settings?.allocatedInventoryAccount || !settings.inventoryAccount) {
    await tx.activityLog.create({
      data: {
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'allocation_reversal_unpostable',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `Re-allocation orphaned £${amount.toFixed(2)} of Group A2 Allocated Inventory on order `
          + `${orderId}, but the allocated-inventory/inventory accounts are not configured, so no `
          + 'reversal journal could be raised.',
      },
    })
    return
  }

  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    // o3d-0i5y r12: the running total of pounds earlier reversals have already credited back out
    // of Allocated Inventory for this order. Read here, inside the caller's transaction and under
    // the order row lock it already holds, so the read-modify-write below cannot interleave.
    select: { orderNumber: true, externalOrderNumber: true, allocationReversalAmount: true },
  })
  const orderRef = order?.orderNumber ?? order?.externalOrderNumber ?? orderId

  // o3d-0i5y r10: a fresh identity for THIS enqueue, so the row it is supposed to create can be
  // asked for by name afterwards. Deliberately NOT `_idempotencyKey`: a key would make two
  // genuinely separate shrinks of the same units collapse into one reversal (see the note above),
  // whereas a token is unique per call and dedupes nothing.
  const reversalToken = randomUUID()

  await queueAccountingSyncTx(tx, {
    type: 'ALLOCATION_REVERSAL',
    referenceType: 'SalesOrder',
    referenceId: orderId,
    payload: {
      _reversalToken: reversalToken,
      date: new Date().toISOString().slice(0, 10),
      reference: `Allocation reversal: ${orderRef}`,
      narration:
        `Allocation reversal — re-allocation of order ${orderRef} removed `
        + `${sumCostLayerSnapshotQty(orphaned).toString()} unit(s) Group A2 had already reclassified`,
      lines: [
        { accountCode: settings.inventoryAccount, description: `Allocation reversal: ${orderRef}`, debit: amount },
        { accountCode: settings.allocatedInventoryAccount, description: `Allocation reversal: ${orderRef}`, credit: amount },
      ],
    },
  })

  const wasQueued = await assertAllocationReversalQueued(tx, orderId, reversalToken, amount, orphaned)
  if (!wasQueued) return

  // o3d-0i5y r12 / o3d-xlk7 — AND THE CREDIT IS RECORDED WHERE THE REFUND'S OPEN BALANCE LOOKS.
  //
  // o3d-o97 computes how many pounds of A2's debit are still open as `allocationBatchAmount` less
  // relief it can PROVE, and it knows exactly two relief sources: each journaled shipment's
  // `Shipment.allocatedReliefAmount` and each earlier refund's `SalesOrderRefund.allocatedReliefAmount`.
  // An ALLOCATION_REVERSAL is NEITHER. Left unrecorded, the journal above credits the orphaned
  // units and the eventual full refund's residue credits them AGAIN, because its open balance
  // still contains them — the double-credit measured in o3d-xlk7.
  //
  // The refund proves the figure from these journals' OWN LINES, netted, exactly as it proves the
  // other two. This record exists because the journals do not survive: `retention_sync_logs_months`
  // hard-deletes a terminal AccountingSyncLog row past the cutoff, and an orphaning can precede its
  // order's refund by months, after which a swept reversal reads as no relief at all.
  //
  // WRITTEN ONLY WHERE THE ROW EXISTS. `queueAccountingSyncTx` silently does nothing under three
  // ordinary conditions (see `assertAllocationReversalQueued`), and recording relief for a journal
  // nobody raised would SHRINK the open balance and under-reverse the refund — pounds left standing
  // in Allocated Inventory with nothing pointing at them. The un-queued case already writes its own
  // ERROR-level record naming the amount to post by hand; it must not also claim relief.
  //
  // A RUNNING TOTAL, because one order can be trimmed many times and there is no per-orphaning
  // business row to hang a figure on. Not netted into `allocationBatchAmount`: that is what A2
  // POSTED, `recreateMissingDailyBatchLogs` rebuilds the batch from it, and
  // `resolveStagedAllocationDebit` reads a recorded ZERO as positive proof that no debit stands —
  // so a fully-reversed order would clear its stamp and be posted all over again.
  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      allocationReversalAmount: roundQuantity(
        addMoney(toDecimal(order?.allocationReversalAmount ?? 0), toDecimal(amount)),
        4,
      ).toNumber(),
    },
  })
}

/**
 * A REVERSAL THAT WAS NOT QUEUED IS NOT A REVERSAL (o3d-0i5y r10 — Codex round 10, finding 3).
 *
 * `queueAccountingSyncTx` does nothing at all under three ordinary, non-exceptional conditions:
 * the order was deleted while we were enqueuing (`scope: 'deleted'`), no active connector posts
 * this type (`getAccountingPostingContext` returns null), or the posting is suppressed for the
 * connector. It throws in none of them. So `await queueAccountingSyncTx(...)` followed by nothing
 * is the shape that treats all three as "reversed" — and this is the worst place in the codebase
 * to make that assumption, because the caller has already trimmed or deleted the very rows that
 * carried the evidence. The debit is stranded AND the record it could have been reconstructed
 * from is gone, in the same committed transaction.
 *
 * ITS RETURN VALUE IS NOT THE THING TO TRUST. It is a summary of a decision made several layers
 * away, and it can be `true` for "an existing row matched the idempotency key" as easily as for "I
 * created one". A queue call that silently does nothing has now been found three times in this
 * session on three unrelated queues; the answer each time was the same, and it is the answer here:
 * ASK THE DATABASE FOR THE ROW, under the enqueue's own predicate — same type, same reference,
 * plus the `_reversalToken` that identifies THIS call and no other.
 *
 * It does not throw. Rolling back would undo the allocation edit the operator asked for because
 * the accounting connector is switched off, which is the same trade the `unpostable` branch above
 * already refused. What it does instead is leave a durable, ERROR-level record that names the
 * exact amount, both account codes and the units — everything a human needs to post the reversal
 * by hand — which is precisely what the silent path destroyed.
 */
async function assertAllocationReversalQueued(
  tx: Prisma.TransactionClient,
  orderId: string,
  reversalToken: string,
  amount: number,
  orphaned: CostLayerSnapshotEntry[],
): Promise<boolean> {
  const queued = await tx.accountingSyncLog.findFirst({
    where: {
      type: 'ALLOCATION_REVERSAL',
      referenceType: 'SalesOrder',
      referenceId: orderId,
      payload: { path: ['_reversalToken'], equals: reversalToken },
    },
    select: { id: true },
  })
  // o3d-0i5y r12: the answer is RETURNED as well as reported, because the caller records relief off
  // the back of it. Relief claimed for a journal that was never queued shrinks the refund's open
  // balance and strands real pounds — the opposite error, and the silent one.
  if (queued) return true

  await tx.activityLog.create({
    data: {
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'allocation_reversal_unqueued',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `Allocation reversal of £${amount.toFixed(2)} on order ${orderId} was NOT queued — no `
        + `AccountingSyncLog row exists for reversal token ${reversalToken}. `
        + `${sumCostLayerSnapshotQty(orphaned).toString()} recorded unit(s) left the order and their `
        + 'Group A2 Allocated Inventory debit has been left standing with nothing downstream to '
        + 'relieve it. Post DR Inventory / CR Allocated Inventory for this amount by hand.',
    },
  })
  return false
}

/**
 * Does the declared allocation set leave quantity that Group A2 has never reclassified? (o3d-0i5y r5)
 *
 * THIS IS THE HALF r4 LEFT OUT. r4 was right that a journaled order must keep its A2 stamp for what
 * has already shipped — clearing it would re-post a reclassification the ledger already holds, and
 * re-snapshot nothing, because A2 values a shipped order from its SHIPMENT snapshots. But keeping the
 * stamp unconditionally answers a question nobody asked: the stamp is order-level, and the residual
 * rebuild this branch exists to enable ADDS allocated quantity to that same order. The added quantity
 * was never reclassified by anything. A2 never looks at a stamped order again, so DR Allocated /
 * CR Inventory never happens for it — and when the residual finally ships, Group B still posts
 * DR COGS / CR Allocated. The credit stands against a debit that was never made, so Allocated
 * Inventory drifts short by the residual's cost and Inventory stays overstated by it, permanently.
 *
 * So the stamp is cleared exactly when there is something new to account, and the decision is made at
 * the same (line, warehouse, product) grain as {@link journaledAllocationFloors}, by asking the same
 * accounted-quantity rule A2 itself applies (`accountedAllocationQty`) with the same two inputs:
 *
 *   * `costLayerSnapshot` on the persisted row — the layers a previous A2 pinned. Kept, never cleared
 *     here, because a journal was posted against them. Entries marked `source: 'shipment'` are units
 *     A2 accounted THROUGH a dispatch it arrived after, and they are DISJOINT from the allocated pin.
 *   * quantity already DISPATCHED at that scope — which overlaps the allocated pin, because a
 *     dispatch consumes the allocation it ships, and overlaps NOTHING that was recorded as shipped.
 *
 * A rebuild that only re-states what is already accounted (the common case: the residual reconciler
 * re-declaring committed shipment rows unchanged) leaves the stamp exactly where r4 put it — including
 * the case r5 got wrong, a residual pinned beside a shipment that predates A2, where reading the two
 * records as one made an unchanged rebuild look like new work and sent the residual back to be posted
 * a second time (o3d-0i5y r6).
 *
 * Cleared, the order is picked up by the very next A2 pass, which posts the residual ALONE — the
 * journaled shipment's value is excluded there by its journal date. Group B is held for one pass at
 * most, since the batch runs A1 → A2 → B in that order within a single run.
 */
async function declaresUnaccountedAllocationQty(
  tx: Prisma.TransactionClient,
  orderId: string,
  nextAllocations: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }>,
  /**
   * o3d-0i5y r8: where each posted record will LIVE once the caller has written its set. Read the
   * records off the persisted rows instead and a warehouse move reads as "10 units nothing has
   * reclassified" at the destination scope, because the record is still filed under the scope the
   * rewrite is about to drop — which hands A2 an order to post a second time.
   */
  records?: AccountedRecordPlan,
): Promise<{ unaccounted: boolean; accountedQty: Prisma.Decimal }> {
  const nextByKey = new Map<string, Prisma.Decimal>()
  for (const row of nextAllocations) {
    const key = allocationScopeKey(row)
    nextByKey.set(key, (nextByKey.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }
  if (nextByKey.size === 0) return { unaccounted: false, accountedQty: new Prisma.Decimal(0) }

  const [persisted, shippedLines] = await Promise.all([
    records
      ? Promise.resolve([])
      : tx.orderAllocation.findMany({
        where: { orderId },
        select: { lineId: true, productId: true, warehouseId: true, costLayerSnapshot: true },
      }),
    tx.shipmentLine.findMany({
      where: { shipment: { orderId, status: 'SHIPPED' } },
      select: { lineId: true, productId: true, qty: true, shipment: { select: { warehouseId: true } } },
    }),
  ])

  const pinnedByKey = new Map<string, CostLayerSnapshotEntry[]>()
  for (const [key, record] of records ?? []) pinnedByKey.set(key, record.entries)
  for (const row of persisted) {
    const key = allocationScopeKey(row)
    pinnedByKey.set(key, [
      ...(pinnedByKey.get(key) ?? []),
      ...parseCostLayerSnapshot(row.costLayerSnapshot),
    ])
  }
  const shippedByKey = new Map<string, Prisma.Decimal>()
  for (const line of shippedLines) {
    const key = allocationScopeKey({
      lineId: line.lineId,
      productId: line.productId,
      warehouseId: line.shipment.warehouseId,
    })
    shippedByKey.set(key, (shippedByKey.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(line.qty)))
  }

  // o3d-0i5y r12 (rebase onto o3d-o97): the TOTAL accounted quantity is returned as well as the
  // verdict, because the caller now has a second question to answer — see the corroboration gate in
  // `resetAllocationAccountingIfStaged`. It is accumulated over every declared scope, so the loop
  // can no longer return early.
  let unaccounted = false
  let accountedQty = new Prisma.Decimal(0)
  for (const [key, nextQty] of nextByKey) {
    // o3d-0i5y r6: ONE accounted-quantity rule, shared with A2 itself. Asking it here with the row's
    // own entries — rather than re-deriving it from a bare quantity — is what keeps a residual pinned
    // beside a pre-A2 shipment out of this test: A2 records those shipped units on the row, so they
    // and the pin ADD UP instead of being maxed, and a rebuild that changes nothing no longer reads
    // as "there is something new to account" and hands the order back to A2 to post a second time.
    const { accounted } = accountedAllocationQty({
      snapshot: pinnedByKey.get(key) ?? [],
      shippedQty: shippedByKey.get(key) ?? 0,
    })
    accountedQty = accountedQty.add(accounted)
    if (nextQty.gt(accounted.add(ALLOCATION_EPSILON_DECIMAL))) unaccounted = true
  }
  return { unaccounted, accountedQty }
}

/**
 * If the daily batch A2 has already staged this order's allocations for
 * accounting (inventoryAllocatedDate is set), any subsequent allocation
 * edit would orphan the FIFO snapshots that Group B and refund reversals
 * depend on. Reset the accounting flags so A2 re-runs for this order on
 * the next daily batch, re-snapshotting the updated allocations.
 *
 * Invariant: allocation accounting is staged at the order level. A staged
 * order must treat every allocation snapshot as a single replaceable set; the
 * schema does not support mixed staged/unstaged snapshots for one order.
 *
 * Safe to call unconditionally; no-ops when inventoryAllocatedDate is null.
 * Must run inside the same transaction as the allocation mutation.
 *
 * ---------------------------------------------------------------------------
 * o3d-0i5y r4 — A JOURNALED PARTIAL SHIPMENT NO LONGER REFUSES THE RESIDUAL REBUILD.
 *
 * This guard used to refuse EVERY allocation change once any shipment on the order carried a
 * `shipmentJournalDate`. That took the r1–r3 remedy away from the exact orders r3 existed to
 * rescue: an order held short at PICKING/PACKING whose despatched part has since been posted by
 * Group B. The advice — re-allocate, create the residual shipments, dispatch them — begins with a
 * re-allocation, `allocateSalesOrder` rewrites the rows whenever the computed set differs, and
 * that rewrite came through here. So the order was stranded again, and a refusal with no remedy
 * the operator can perform is the defect r1 set out to avoid.
 *
 * The refusal is replaced by the invariant it was a proxy for: **no row a journal posted against
 * may be dropped or reduced below the posted quantity** ({@link journaledAllocationFloors}). A
 * caller that can show its proposed set honours those floors is allowed through — and by the
 * o3d-4kfh whole-claim contract the residual rebuild always can, because `persistedAllocations`
 * re-adds every committed shipment line, journaled ones included.
 *
 * The permit is CALLER-DECLARED, in the same sense as r2's completion authority: `nextAllocations`
 * is the caller stating what it is about to write, and this function checks it against the
 * database's own record of what was posted. A caller that declares nothing — `updateAllocation`,
 * `addAllocation`, the cancellation and teardown releases — is refused the JOURNAL-SAFE PATH
 * exactly as before, because none of them can show what the order will be left holding. It is no
 * longer refused the record: since r9 the blanket reset clears the stamp alone and leaves every
 * row's posted evidence where it stands.
 *
 * A permitted change also SKIPS THE UN-STAGE. That is not laziness, it is the only correct answer
 * here: A2 derives a shipped order's allocated value from its SHIPMENT snapshots and writes an
 * EMPTY `costLayerSnapshot` to every allocation row (see Group A2 in `xero/daily-sync.ts`), so
 * clearing the stamp on a journaled order would re-post the same inventory reclassification while
 * re-snapshotting nothing. Keeping the stamp keeps the posted evidence — and the row's snapshot —
 * exactly where Group B and the refund reversal expect to find it.
 * ---------------------------------------------------------------------------
 */
export async function resetAllocationAccountingIfStaged(
  tx: Prisma.TransactionClient,
  orderId: string,
  options: {
    /**
     * The complete set of allocation rows the caller is about to leave on this order, already
     * canonicalised to the persisted scale. Supplying it is what unlocks the journal-safe path;
     * omitting it keeps the old blanket refusal.
     */
    nextAllocations?: ReadonlyArray<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }>
    /**
     * o3d-0i5y r8: where the caller is about to leave each POSTED RECORD, from
     * {@link planAccountedRecordCarryOver}. Only meaningful alongside `nextAllocations`, and only
     * needed when the set moves a scope — without it a moved record is looked for under the scope
     * being dropped and the destination reads as never reclassified.
     */
    accountedRecords?: AccountedRecordPlan
  } = {},
): Promise<void> {
  const so = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      inventoryAllocatedDate: true,
      // o3d-o97 r4: read WITH the stamp, because whether the stamp may be cleared depends on
      // whether the debit it stands for is still in a ledger.
      allocationBatchAmount: true,
      allocationBatchSyncLogId: true,
    },
  })
  if (!so?.inventoryAllocatedDate) return

  /**
   * HAND THE ORDER BACK TO GROUP A2 — AND KEEP EVERY RECORD OF WHAT A2 ALREADY POSTED
   * (o3d-0i5y r5, corrected on the rebase onto o3d-o97 / PR #635).
   *
   * This runs on the DECLARED path only, and it means one thing: the caller's set leaves quantity
   * nothing has reclassified, so A2 must look at this order again and post the INCREMENT. The stamp
   * is the claim about work still to be done, so the stamp is what is cleared.
   *
   * `allocationBatchAmount` is NOT. It is the record of what A2 has ALREADY debited to Allocated
   * Inventory for this order, and o3d-o97 made it the basis of the refund's open-balance
   * arithmetic, of `recreateMissingDailyBatchLogs` and of the hard-delete guard. Nulling it here
   * used to be harmless because the stamp only ever came off an order A2 was about to re-value in
   * full; it is not harmless now, because A2 comes back and posts the increment ALONE:
   *
   *   A2 debits £50 for 10 units and records £50. A residual rebuild adds 4 units, this clears the
   *   stamp, and A2 returns and posts £20 for the 4. Allocated Inventory holds £70. Under the
   *   nulled record the order says £20, so the eventual full refund reverses £20 and £50 STANDS FOR
   *   EVER with nothing anywhere pointing at it — the same "the debit is stranded AND the evidence
   *   died in the same committed transaction" failure o3d-o97 r4 refused at the other un-stage.
   *
   * So the record and its journal attribution survive, and Group A2's own write ADDS this pass's
   * pounds to them rather than replacing them (see the A2 order update in `xero/daily-sync.ts`).
   */
  const unstage = () => tx.salesOrder.update({
    where: { id: orderId },
    data: {
      // o3d-0qoo: stamp and batch ref move together, as everywhere else that un-stages.
      inventoryAllocatedDate: null,
      inventoryAllocatedBatchRef: null,
    },
  })

  const journaledShipment = await tx.shipment.findFirst({
    where: { orderId, shipmentJournalDate: { not: null } },
    select: { id: true },
  })
  if (journaledShipment) {
    await assertJournalSafeAllocationChange(tx, orderId, options.nextAllocations)
  }

  // o3d-0i5y r8 — ONE RULE FOR EVERY DECLARED SET, JOURNALED OR NOT.
  //
  // r4 gave the journaled order this treatment (keep the record, un-stage only for what is new) and
  // left the unjournaled one on the blanket reset below, on the reading that an unposted order has
  // no evidence worth keeping. It does: `inventoryAllocatedDate` is set precisely because GROUP A2
  // has already posted DR Allocated / CR Inventory for these rows, and Group B's journal is a later,
  // independent event. So the blanket reset was throwing away A2's posted evidence on every
  // ordinary allocation change — the extra unit arriving, the warehouse moving — and the next A2
  // pass, finding empty records, posted the whole order a second time. Nothing reverses the first.
  //
  // The record therefore stays wherever the caller's own plan puts it, and the stamp is cleared
  // exactly when the declared set leaves quantity nothing has reclassified.
  if (options.nextAllocations) {
    const declared = await declaresUnaccountedAllocationQty(
      tx,
      orderId,
      options.nextAllocations,
      options.accountedRecords,
    )
    if (!declared.unaccounted) return

    // o3d-0i5y r12 — AND THE RECORD HAS TO CORROBORATE THE STAMP BEFORE THE STAMP COMES OFF
    // (rebase onto o3d-o97 / PR #635).
    //
    // r5 cleared the stamp on the strength of "the declared set holds quantity nothing has
    // accounted", full stop. That is safe exactly while the ROWS say what A2 already accounted,
    // because A2's next pass reads those records and posts the difference. It is NOT safe when they
    // say nothing at all: the stamp then asserts that A2 ran, the records assert that it accounted
    // NOTHING, and the two cannot both be true. Hand that order back and A2 re-values EVERY unit —
    // the second whole-order debit o3d-o97 r4 built its gate against, arrived at from the other
    // side.
    //
    // Two questions, in the order that costs least:
    //
    //   1. IS A DEBIT STANDING AT ALL? Only o3d-o97's positive evidence answers no — no stamp
    //      (unreachable here) or a recorded debit of exactly £0.00. Then there is nothing to
    //      re-post and nothing to preserve, so the stamp, the amount and the attribution all go,
    //      exactly as the blanket path below clears them.
    //   2. DOES THE RECORD ACCOUNT FOR ANYTHING? With a debit standing, the stamp may come off only
    //      where the rows can show what was already accounted. Any accounted quantity at all is
    //      enough, because A2 posts the DIFFERENCE from those same records; zero is the legacy
    //      shape (a row staged before the pins were recorded, or one whose pins the blanket path
    //      cleared) and it is refused and reported rather than guessed at.
    //
    // Refusing costs the increment a pass, not a posting: the order is reported, and an operator or
    // a later pass with records can release it. Guessing costs a duplicate debit nothing reverses.
    const stagedDebit = await resolveStagedAllocationDebit(tx, so)
    if (!stagedDebit.standing) {
      await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          inventoryAllocatedDate: null,
          inventoryAllocatedBatchRef: null,
          allocationBatchAmount: null,
          allocationBatchSyncLogId: null,
          allocationBatchConnector: null,
          allocationBatchAccountCode: null,
        },
      })
      return
    }
    if (declared.accountedQty.lte(0)) {
      await tx.activityLog.create({
        data: {
          entityType: 'SALES_ORDER',
          entityId: orderId,
          action: 'allocation_accounting_stage_retained',
          tag: 'accounting',
          level: 'WARNING',
          description:
            `Allocations changed on an order whose Group A2 posting still stands, so the A2 stamp and its `
            + `recorded debit were KEPT rather than cleared: ${stagedDebit.reason}. The declared set holds `
            + `quantity nothing has accounted, but NO allocation row records what A2 already accounted, so `
            + `handing this order back would re-value and re-post every unit on it rather than the new ones. `
            + `The newly allocated quantity is NOT reclassified — reclassify it by hand, or re-run the `
            + `change once the rows carry their posted records.`,
        },
      })
      return
    }
    await unstage()
    return
  }

  // o3d-o97 r4 — THE UN-STAGE IS NO LONGER A DELETION OF EVIDENCE.
  //
  // r3 nulled the stamp, the recorded amount and the journal attribution here unconditionally, and
  // flagged this site itself. Two harms, and the second only follows from the first: the ONLY
  // record of what A2 debited for this order goes (the refund's open-balance arithmetic, the
  // batch-log recreate sweep and the hard-delete guard all read it), and with the stamp gone Group
  // A2 — which selects on `inventoryAllocatedDate: null` — re-values the order at its new pins and
  // raises a SECOND debit. Only the second one has a record, so a later refund's residue can only
  // ever relieve that one and the first is stranded for ever, invisibly.
  //
  // Refusing was not an option: this function is on the allocation-edit, release AND ORDER
  // CANCELLATION paths, and blocking those would be a far larger harm than the one being fixed.
  // Keeping the record costs nothing instead — A2 will not re-post an order it can still see a
  // stamp on, so no second debit is raised, and the amount stays where every reader already looks
  // for it. What is cleared either way is the per-allocation pins, which the caller is replacing.
  //
  // NOT a reversal. Where the order is then cancelled outright the debit still stands unrelieved;
  // that needs a reversal journal of its own, and keeping the record is what leaves that repair
  // possible instead of impossible.
  //
  // o3d-0i5y r9, SUPERSEDED BY THE ABOVE (rebase onto o3d-o97 / PR #635). r9 argued the opposite
  // split for this same site: clear the STAMP alone and KEEP every row's `costLayerSnapshot`, on
  // the reading that the stamp is a claim about work still TO BE DONE while the record states what
  // already HAPPENED — so an undeclared caller may clear the first and must not touch the second,
  // because A2 reading an empty row posts the WHOLE order a second time.
  //
  // The premise was right and the conclusion no longer follows, because the merged rule removes the
  // re-post r9 was defending against: where the debit STANDS the stamp is kept, and Group A2 selects
  // only on `inventoryAllocatedDate: null`, so it never looks at this order again and cannot re-post
  // anything — with or without the row records. The only branch that DOES clear the record is the
  // one `resolveStagedAllocationDebit` proves is not standing, and that is either "A2 never staged
  // this order" (unreachable here — the early return above requires a stamp) or "A2 recorded a debit
  // of exactly £0.00". Clearing an empty record is not a deletion of evidence.
  //
  // Kept from r9 is the half the merged rule does not cover: the row is not the only place the
  // record can die. Where the row itself is DESTROYED — the deallocation teardown, the manual
  // editor, the rebalancer — the units are orphaned and their debit is stranded, so those paths
  // raise `reverseOrphanedAllocationPosting` rather than relying on a record that no longer exists.
  const stagedDebit = await resolveStagedAllocationDebit(tx, so)
  if (stagedDebit.standing) {
    await tx.activityLog.create({
      data: {
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'allocation_accounting_stage_retained',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `Allocations changed on an order whose Group A2 posting still stands, so the A2 stamp and its `
          + `recorded debit were KEPT rather than cleared: ${stagedDebit.reason}. Group A2 will not re-post `
          + `this order, and the recorded debit remains available for a refund to reverse. The allocation `
          + `pins behind it have been cleared and will not be re-valued.`,
      },
    })
  } else {
    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        // o3d-0qoo: the A2 batch ref goes with its stamp in the same update — see the note at the
        // REFUNDED un-stage in refund-service.ts for why a ref without a stamp is worse than neither.
        inventoryAllocatedDate: null,
        inventoryAllocatedBatchRef: null,
        allocationBatchAmount: null,
        // o3d-o97 r3: the journal attribution goes with the amount it describes. Leaving a sync log
        // id, connector and account code behind on an order that is no longer staged would leave
        // them describing a posting the next A2 run has not made yet.
        allocationBatchSyncLogId: null,
        allocationBatchConnector: null,
        allocationBatchAccountCode: null,
      },
    })
  }
  await tx.orderAllocation.updateMany({
    where: { orderId },
    // o3d-o97 r3: and the per-row posted basis with the row's pinned layers. Cleared on BOTH paths:
    // the pins are being replaced either way, and a per-row basis left pointing at layers the row no
    // longer holds is the revaluation defect in miniature. The ORDER-level record is the one that
    // has to survive, and above it does.
    data: { costLayerSnapshot: Prisma.DbNull, allocationBatchAmount: null },
  })
}

export type ReleasedOrderAllocation = {
  lineId: string
  productId: string
  warehouseId: string
  qty: number
}

/**
 * TEARDOWN release: give the reserved quantities back and DESTROY every allocation row, inside a
 * caller-supplied transaction. Extracted from deallocateOrder (o3d-5r8) so deleteSalesOrder
 * can run the guard checks, the release and the delete under ONE order-row lock — checking
 * deletability in one transaction and deleting in another reopens exactly the window a
 * posting worker needs to claim the order out from under the deleter.
 *
 * o3d-4kfh — THIS FUNCTION IS FOR PATHS WHERE THE ORDER ITSELF IS GOING AWAY (hard delete, and the
 * cancellation shape that deletes the shipments alongside it). It deletes the rows unconditionally,
 * so it destroys two things a surviving order still needs:
 *
 *   - the row a committed (PICKING/PACKED) shipment was picked from. The reservation goes back but
 *     the shipment stays dispatchable, and dispatch checks only the shared per-(product, warehouse)
 *     `reservedQty` — so it either fails or spends another order's reservation.
 *   - the allocation IDENTITY and its `costLayerSnapshot`, which the Group B shipment journal and
 *     the refund cost reversal resolve through `orderAllocationId`.
 *
 * User-initiated deallocation on a LIVE order must therefore go through
 * {@link releaseOrderAllocationsForDeallocationInTx}, which refuses instead.
 *
 * o3d-0i5y r10 — AND IT DESTROYS A THIRD THING, WHICH IS WHY THE REVERSAL AT THE END EXISTS: the
 * `costLayerSnapshot` on each row is Group A2's record that it has DEBITED Allocated Inventory for
 * those units, and the amount it debited. Deleting the rows leaves that debit standing with
 * nothing that will ever relieve it and nothing left that can say what it was. On the live-order
 * (deallocation) path the debit is therefore REVERSED here; on the hard-delete path — where a
 * journal about the order could not resolve to one — the delete is refused instead.
 *
 * The caller MUST already hold the order's row lock (lockSalesOrder).
 *
 * Throws (via resetAllocationAccountingIfStaged) when a shipment on this order has already
 * been journaled — those allocations back a posted cost entry and must not be released.
 */
export type ReleaseOrderAllocationsResult = {
  allocations: ReleasedOrderAllocation[]
  clampedReservationCount: number
  deletedPendingShipmentCount: number
  /** o3d-4kfh r4: identity + tracking metadata of every retired draft, for the caller's log. */
  retiredPendingShipments: RetiredPendingShipment[]
}

export async function releaseOrderAllocationsInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  /**
   * o3d-4kfh r5: who/what to attribute the draft retirement to. The audit row is written inside
   * this transaction now (see `reconcilePendingShipments`), so the cause must arrive with the call
   * rather than being narrated by the caller after the commit.
   */
  audit: {
    cause?: string
    userId?: string | null
    /**
     * o3d-0i5y r10: the caller is about to DELETE the sales order in this same transaction.
     *
     * It changes exactly one thing — what may be done about a posted debit these rows carry. A
     * reversal is a journal ABOUT an order, enqueued as `referenceType: 'SalesOrder'`, so raising
     * one against an order that ceases to exist a few statements later is the o3d-hrak orphan the
     * enqueue lock exists to prevent. There is no third option that leaves the ledger right, so
     * this path REFUSES instead (see below) — and the refusal is already unreachable in the
     * ordinary case, because `findSalesOrderDeleteBlocker` will not let an order out of a live A2
     * batch be deleted at all.
     */
    orderIsBeingDeleted?: boolean
  } = {},
): Promise<ReleaseOrderAllocationsResult> {
  // READ THE RECORD BEFORE THE UN-STAGE, NOT AFTER (o3d-0i5y r12, rebase onto o3d-o97 / PR #635).
  //
  // o3d-0i5y r10: the RECORD is selected, because this function is about to delete the rows that
  // hold it — see the orphan reversal at the end. o3d-o97's blanket un-stage path clears
  // `costLayerSnapshot` on EVERY row of the order (the pins are being replaced or, here, deleted),
  // so reading after it returns an empty record for every row: the reversal below would value the
  // orphaned units at nothing and raise no journal at all, and the hard-delete refusal — which asks
  // the same question — would let a posted order through. Two statements swapped, no rule bent:
  // o3d-o97 still clears the pins, and this still reverses what they said.
  const currentAllocs = await tx.orderAllocation.findMany({
    where: { orderId },
    select: { lineId: true, productId: true, warehouseId: true, qty: true, costLayerSnapshot: true },
  })
  await resetAllocationAccountingIfStaged(tx, orderId)
  await lockStockLevels(
    tx,
    [...new Set(currentAllocs.map((alloc) => alloc.productId))],
    [...new Set(currentAllocs.map((alloc) => alloc.warehouseId))],
  )

  const allocations = currentAllocs.map((alloc) => ({
    lineId: alloc.lineId,
    productId: alloc.productId,
    warehouseId: alloc.warehouseId,
    qty: Number(alloc.qty),
  }))

  // o3d-4kfh: release the RESIDUAL, not the retained quantity. This path has no dispatched-shipment
  // guard at all, so it is routinely handed allocation rows whose units have already left: dispatch
  // decrements reservedQty and RETAINS the row. Releasing the raw row quantity therefore asked for
  // more than the order still holds, which the guarded decrement cannot satisfy.
  const releasedRows = await residualAllocationRowsForOrder(tx, orderId, currentAllocs)
  const releasedScopes = uniqueReservationScopes(releasedRows)
  const stockBefore = releasedScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  await applyAllocationReservationDelta(tx, releasedRows, 'release')
  const clampedReservations = await tx.stockLevel.updateMany({
    where: { reservedQty: { lt: 0 } },
    data: { reservedQty: 0 },
  })
  const stockAfter = releasedScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  // Bracket the release with the same fail-closed assertion cancelSalesOrderFulfillmentState uses,
  // so the actual database delta is verified rather than the requested decrement merely trusted.
  assertReservationReleaseDelta(stockBefore, stockAfter, releasedRows)
  // o3d-4kfh r3: THE DRAFTS GO WITH THE ROWS THEY WERE DRAWN FROM, in the same transaction.
  //
  // A PENDING shipment is a draft `confirmSalesOrderShipments` generated directly from these
  // allocation rows — same (line, warehouse, product), same quantities. Deleting the rows and
  // leaving the draft behind produced a shipment nothing backs, and PENDING is precisely the status
  // every guard on this branch is entitled to ignore: the deallocation refusal lets it through, the
  // committed floor in `updateAllocation` does not count it, and `allocateSalesOrder` does not
  // retain it. The ordinary UI sequence — raise a shipment, Deallocate, Re-Allocate somewhere else,
  // Start Picking — then committed a shipment with no allocation and no reservation behind it.
  // Deleting them here is what makes the teardown TOTAL; the commitment-transition check in
  // `transitionShipmentStatus` is the backstop for drafts invalidated by any other route.
  //
  // o3d-4kfh r4: through the SHARED reconciliation, and AFTER the allocation rows are gone. This
  // path used to `deleteMany({ orderId, status: 'PENDING' })` directly — correct here (there is no
  // backing left at all, so every draft is unbacked and the shared rule retires all of them) but it
  // was that blanket delete which got copied into the rebalancer, where it destroyed drafts that
  // were still fully backed. One rule, one implementation, no copy to get wrong.
  //
  // The allocation rows are deleted FIRST so the shared helper reads the true post-teardown state
  // (zero open quantity everywhere) rather than being told what to conclude.
  await tx.orderAllocation.deleteMany({ where: { orderId } })
  // o3d-kouj: the rows are gone, so any pin on a line that holds nothing else is now dormant — a
  // recipe no reader should still be answering from. Retired here, under the same lock, in the same
  // transaction as the release that made it dormant.
  await clearDormantFulfillmentPinsInTx(tx, orderId)
  const pendingShipmentReconciliation = await reconcilePendingShipments(tx, orderId, {
    cause: audit.cause ?? 'a release of the order’s allocations',
    userId: audit.userId ?? null,
  })

  // -----------------------------------------------------------------------------------------
  // o3d-0i5y r10 (Codex round 10, finding 2) — THE ROWS GO; THE POSTED DEBIT DOES NOT JUST GO
  // WITH THEM.
  //
  // r9 flagged this itself and deferred it: "the teardown path deletes rows and the record dies
  // with them". That is not a bookkeeping detail, it is the entire evidence of a real posting
  // being destroyed by the one path that destroys the most of it. Every other route trims a
  // record; this one deletes all of them, for the whole order, unconditionally.
  //
  // What Group A2 posted for these units is DR Allocated Inventory / CR Inventory. Exactly two
  // things ever relieve that debit — Group B crediting Allocated Inventory when a shipment
  // dispatches, and a refund crediting it for units taken back — and a deallocation reaches
  // NEITHER: the units will not ship (there is nothing left to ship them from) and they were not
  // refunded. So on the live-order path the debit sits in Allocated Inventory for ever, with
  // Inventory understated by the same amount, and after `deleteMany` there is not one row left
  // that says how much it was.
  //
  // Ten units posted at £4 = £40. Deallocate: r9 left £40 of Allocated Inventory with nothing
  // that could ever relieve it and no record of the £40. r10 raises CR Allocated £40 / DR
  // Inventory £40 in this same transaction, so the account is back where it stood before A2 ran.
  //
  // ORPHANED IN FULL, and rightly: `planAccountedRecordCarryOver` moves a record between the
  // scopes of a DECLARED next set, and this teardown's next set is empty by construction. There
  // is no surviving row for any unit to carry to.
  //
  // RAISED LAST, after the delete and the pin retirement, for the reason the rebase settled: the
  // journal and the state it describes commit together. And the sibling's rule holds on both
  // halves — the amount comes from what A2 RECORDED posting (`postedUnitCostBase`), never from
  // the pin as a landed-cost correction has since revalued it, and a record that cannot say what
  // was posted for it reverses nothing and is reported.
  const orphanedRecord = currentAllocs.flatMap((alloc) => parseCostLayerSnapshot(alloc.costLayerSnapshot))
  if (audit.orderIsBeingDeleted) {
    // A reversal journal keyed to an order that is about to stop existing resolves to nothing, and
    // deleting without one strands the debit — so neither is available and the delete is refused.
    // `findSalesOrderDeleteBlocker` already refuses an order in a live A2 batch, which is why this
    // is a backstop rather than the primary guard; it is here so a retention sweep that removes
    // the batch log cannot quietly turn a posted order into a deletable one.
    const { posted } = sumPostedCostLayerSnapshot(orphanedRecord)
    if (roundQuantity(posted, 2).gt(0)) {
      throw new Error(
        `Cannot delete this order: Group A2 has already posted £${roundQuantity(posted, 2).toFixed(2)} of `
        + 'Allocated Inventory against its allocation rows, and deleting them would strand that debit with '
        + 'nothing left to say it exists. Cancel the order instead, so the reversal can be raised against an '
        + 'order that still exists.',
      )
    }
  } else {
    await reverseOrphanedAllocationPosting(tx, orderId, orphanedRecord)
  }

  return {
    allocations,
    clampedReservationCount: clampedReservations.count,
    deletedPendingShipmentCount: pendingShipmentReconciliation.retired.length,
    retiredPendingShipments: pendingShipmentReconciliation.retired,
  }
}

/**
 * o3d-kouj: DROP A PIN THAT IS NO LONGER ABOUT ANYTHING IN FLIGHT.
 *
 * The capture rule says a line pins while it holds nothing in flight and is untouchable once it
 * holds an allocation row or a committed shipment line. Read forward that is exactly right; read
 * backward it leaves a gap. When a line's last allocation row goes away — deallocation, an
 * allocation edited down to nothing, the rebalancer removing the row, an order cancelled — the line
 * becomes capturable again, and the NEXT allocation will therefore expand the CURRENT graph. But the
 * old pin is still sitting on the row until that allocation happens, and every reader goes through
 * `lineFulfillmentRequirements`, which uses a pin whenever one is present.
 *
 * So between the deallocation and the re-allocation, the coverage checks, the backorder report and
 * the fulfilment analytics answer from a recipe the next allocation has already decided not to use.
 * `allocateSalesOrder` gets this right for itself by nulling the pin for capturable lines in the set
 * it resolves against — but that is one reader making a local correction, and the disagreement is
 * between readers.
 *
 * The pin is therefore RETIRED at the moment it goes dormant, so the fallback (expand the current
 * graph) is what every reader and the next allocation both do. Nothing is lost: a dormant pin
 * certifies no allocation row, no shipment and no cost — that is precisely what made it dormant.
 *
 * DELIBERATELY RE-DERIVED, not passed in. The caller has just deleted rows; asking it which lines
 * are now empty is asking it to restate a fact the database already holds, and the two would drift.
 * Lines that still hold a committed shipment keep their pin, which is the frozen-forever half of the
 * rule — the unconditional teardown (`releaseOrderAllocationsInTx`) deletes allocation rows even for
 * those lines, so that distinction is load-bearing here rather than theoretical.
 *
 * The caller MUST already hold the order's row lock, and must call this AFTER the rows are gone.
 * Returns how many pins were retired.
 */
export async function clearDormantFulfillmentPinsInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const pinnedLines = await tx.salesOrderLine.findMany({
    // `not: DbNull` and not `NOT: { equals: DbNull }`: on a nullable Json column Prisma's own
    // documented form for "the SQL value is not NULL" is the filter shorthand.
    where: { orderId, fulfillmentRequirements: { not: Prisma.DbNull } },
    select: { id: true },
  })
  if (pinnedLines.length === 0) return 0

  const pinnedLineIds = pinnedLines.map((line) => line.id)
  const [linesHoldingAllocations, linesHoldingCommittedShipments] = await Promise.all([
    tx.orderAllocation.findMany({
      where: { orderId, lineId: { in: pinnedLineIds } },
      select: { lineId: true },
    }),
    tx.shipmentLine.findMany({
      where: {
        lineId: { in: pinnedLineIds },
        shipment: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } },
      },
      select: { lineId: true },
    }),
  ])
  const dormant = selectCapturableLineIds({
    lineIds: pinnedLineIds,
    lineIdsHoldingAllocations: linesHoldingAllocations.map((row) => row.lineId),
    lineIdsHoldingCommittedShipments: linesHoldingCommittedShipments.map((row) => row.lineId),
  })
  if (dormant.length === 0) return 0

  const cleared = await tx.salesOrderLine.updateMany({
    where: { id: { in: dormant }, orderId },
    data: { fulfillmentRequirements: Prisma.DbNull },
  })
  return cleared.count
}

/**
 * USER deallocation: the same release, but REFUSED while the order holds any committed shipment
 * (o3d-4kfh).
 *
 * "Deallocate" is offered in the SO detail UI whenever allocations exist, and it used to run the
 * teardown release above on any order at all. On a PICKING or PACKED shipment that released the
 * live reservation while leaving the shipment dispatchable; on a SHIPPED-but-unjournaled one it
 * deleted the allocation identity and cost snapshot the Group B journal and the refund reversal
 * resolve through `orderAllocationId` — the very thing the manual-edit guard in `updateAllocation`
 * refuses to do one row at a time.
 *
 * The bounded fix is to refuse, not to invent cancellation semantics for a committed shipment.
 * A PENDING shipment is not a commitment and never blocks — but it is DELETED with the rows it was
 * drawn from (o3d-4kfh r3, see `releaseOrderAllocationsInTx`), because a draft that outlives its
 * allocation is exactly what later becomes a committed shipment with nothing behind it.
 *
 * BUT NOTE WHAT THE OPERATOR IS ACTUALLY LEFT WITH, because it is narrower than it looks:
 * IMS has NO per-shipment cancel or rollback at all. `SHIPMENT_TRANSITIONS` is forward-only
 * (PENDING -> PICKING -> PACKED -> SHIPPED) and no action deletes a non-PENDING shipment. So the
 * only two ways out of this refusal are to DISPATCH the shipment, or to cancel the WHOLE order —
 * `cancelSalesOrderFulfillmentState` deletes the PENDING/PICKING/PACKED shipments in the same
 * transaction as the release, which is exactly the atomicity this path lacks. The refusal message
 * must therefore not tell the operator to "cancel the shipment": that button does not exist.
 * Filling that gap (o3d-q8r6) is a product decision, not part of this fix.
 *
 * The caller MUST already hold the order's row lock (lockSalesOrder).
 */
export async function releaseOrderAllocationsForDeallocationInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  audit: { cause?: string; userId?: string | null } = {},
): Promise<ReleaseOrderAllocationsResult> {
  const committedShipments = await tx.shipment.findMany({
    where: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } },
    select: { id: true, status: true },
  })
  if (committedShipments.length > 0) {
    const byStatus = new Map<string, number>()
    for (const shipment of committedShipments) {
      const status = String(shipment.status)
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    }
    const summary = [...byStatus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
      .join(', ')
    throw new Error(
      `Cannot deallocate this order while it has committed shipments (${summary}). `
      + 'A picked or packed shipment is stock the warehouse is already holding against this order, and a '
      + 'shipped one is the cost evidence the accounting sub-ledger reverses through its allocation row — '
      + 'releasing either would leave the shipment dispatchable against another order\'s reservation. '
      + 'Dispatch those shipments, or cancel the whole order.',
    )
  }
  return releaseOrderAllocationsInTx(tx, orderId, {
    cause: audit.cause ?? 'deallocating the order',
    userId: audit.userId ?? null,
  })
}

export async function updateSalesOrderStatusUnderLock(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string
    targetStatus: SalesOrderStatus
    data?: Prisma.SalesOrderUpdateInput
    bypass?: boolean
    beforeUpdate?: (context: {
      tx: Prisma.TransactionClient
      previousStatus: string
    }) => Promise<void>
  },
): Promise<{ previousStatus: string }> {
  await lockSalesOrder(tx, input.orderId)
  const lockedOrder = await tx.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { status: true },
  })
  if (!lockedOrder) throw new Error('Order not found')

  const transition = validateManualSalesOrderStatusTransition(lockedOrder.status, input.targetStatus, {
    bypass: input.bypass,
  })
  if (!transition.success) throw new Error(transition.error)

  await input.beforeUpdate?.({ tx, previousStatus: lockedOrder.status })
  await tx.salesOrder.update({
    where: { id: input.orderId },
    data: { ...(input.data ?? {}), status: input.targetStatus },
  })
  return { previousStatus: lockedOrder.status }
}

export async function applyAllocationReservationDelta(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
  direction: 'reserve' | 'release',
) {
  for (const row of rows) {
    const qty = toDecimal(row.qty)
    if (qty.lte(0)) continue
    if (direction === 'reserve') {
      const updated = await tx.stockLevel.updateMany({
        where: { productId: row.productId, warehouseId: row.warehouseId },
        data: { reservedQty: { increment: qty } },
      })
      if (updated.count === 0) {
        throw new Error(`Cannot reserve stock for product ${row.productId} in warehouse ${row.warehouseId}: no stock level exists`)
      }
      continue
    }

    // l4jq: guard the release decrement so it can never drive reservedQty
    // negative (the reserve branch above already checks updated.count).
    // reservedQty is a per-(product,warehouse) AGGREGATE: in the normal case
    // (reservedQty >= qty) the guarded decrement below releases exactly this
    // allocation's qty and PRESERVES any co-existing reservations from other
    // orders (reservedQty - qty stays positive).
    const released = await tx.stockLevel.updateMany({
      where: { productId: row.productId, warehouseId: row.warehouseId, reservedQty: { gte: qty } },
      data: { reservedQty: { decrement: qty } },
    })
    if (released.count === 0) {
      // o3d-4kfh: FAIL CLOSED. This used to floor the WHOLE (product, warehouse) scope to 0 and
      // log about "upstream drift". reservedQty is an aggregate shared by every sales order and
      // every production order, so that floor annihilated every OTHER holder's reservation in the
      // scope — orders that were never touched by this transaction, and could not even be named in
      // the log line. It was also self-fulfilling: the commonest way to reach it was releasing an
      // allocation's RAW retained quantity instead of its residual after a partial dispatch, so the
      // line blaming "upstream drift" WAS the upstream drift.
      //
      // Refusing the write is strictly better. The caller's transaction rolls back, this order's
      // reservation is left exactly as it was, and no third party is silently robbed. It is the
      // same stance assertReservationReleaseDelta already took for cancellation — which is why
      // cancelSalesOrderFulfillmentState was the one release path that could not cause this.
      throw new Error(
        `Cannot release ${qty.toString()} reserved unit(s) of product ${row.productId} @ ${row.warehouseId}: `
        + 'reservedQty is lower than the release, or no stock level exists. Releasing anyway would '
        + 'zero the reservations of other orders sharing this product/warehouse (o3d-4kfh).',
      )
    }
  }
}

type ReservationScope = { productId: string; warehouseId: string }

function reservationScopeKey(scope: ReservationScope): string {
  return `${scope.productId}:${scope.warehouseId}`
}

function uniqueReservationScopes(rows: ReservationScope[]): ReservationScope[] {
  const scopes = new Map<string, ReservationScope>()
  for (const row of rows) {
    // Construct a clean scope rather than storing `row`: callers pass allocation rows that also carry
    // `qty`, and these scopes are fed straight into `stockLevel.findMany({ where: { OR: scopes } })`.
    // A stray `qty` there is an "Unknown argument `qty`" Prisma error that makes cancelling any
    // ALLOCATED order throw (unallocated orders skip the read, which is why it stayed hidden).
    scopes.set(reservationScopeKey(row), { productId: row.productId, warehouseId: row.warehouseId })
  }
  return [...scopes.values()]
}

function sumReservationRows(rows: Array<ReservationScope & { qty: DecimalInput }>): Map<string, Prisma.Decimal> {
  const totals = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    const key = reservationScopeKey(row)
    totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }
  return totals
}

export function assertReservationReleaseDelta(
  beforeRows: Array<ReservationScope & { reservedQty: DecimalInput }>,
  afterRows: Array<ReservationScope & { reservedQty: DecimalInput }>,
  releasedRows: Array<ReservationScope & { qty: DecimalInput }>,
): void {
  const beforeByKey = new Map(beforeRows.map((row) => [reservationScopeKey(row), toDecimal(row.reservedQty)]))
  const afterByKey = new Map(afterRows.map((row) => [reservationScopeKey(row), toDecimal(row.reservedQty)]))
  const releasedByKey = sumReservationRows(releasedRows)

  for (const [key, releasedQty] of releasedByKey) {
    const beforeQty = beforeByKey.get(key)
    const afterQty = afterByKey.get(key)
    if (beforeQty == null || afterQty == null) {
      throw new Error(`Reservation release invariant failed for ${key}: stock level missing`)
    }
    if (beforeQty.lt(releasedQty)) {
      throw new Error(
        `Cannot cancel order because reservedQty drifted below allocation for ${key}: reservedQty ${beforeQty.toString()}, allocationQty ${releasedQty.toString()}`,
      )
    }
    const expectedAfter = beforeQty.sub(releasedQty)
    if (afterQty.lt(0)) {
      throw new Error(`Reservation release invariant failed for ${key}: reservedQty cannot be negative`)
    }
    if (afterQty.sub(expectedAfter).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
      throw new Error(
        `Reservation release invariant failed for ${key}: expected reservedQty ${expectedAfter.toString()}, got ${afterQty.toString()}`,
      )
    }
  }
}

export async function cancelSalesOrderFulfillmentState(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string
    data?: Prisma.SalesOrderUpdateInput
    bypass?: boolean
  },
): Promise<{
  previousStatus: string
  releasedAllocationCount: number
  deletedShipmentCount: number
  releasedReservationScopes: ReservationScope[]
  // o3d-gz6: true when the order was SHIPPED with no dispatch evidence and its status was repaired to a
  // pre-ship state so this cancel could proceed. The caller should audit it.
  repairedFalseShipped: boolean
}> {
  await lockSalesOrder(tx, input.orderId)
  const lockedOrder = await tx.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { status: true },
  })
  if (!lockedOrder) throw new Error('Order not found')

  // o3d-7o0: REFUSE WHILE AN INVOICE POST IS ON THE WIRE, under the row lock just taken and BEFORE any
  // write. The processor's PROCESSING claim is the posting intent, and `guardCancelledSalesOrderInvoice`
  // now reads the order status under this same lock — so a post that gets past its guard is one this
  // check can see, and a post whose guard has not run yet will read the CANCELLED this cancellation is
  // about to commit. The refusal is transient: the claim ages out within fifteen minutes.
  //
  // Also asserted again at the end of this function, inside cancelPendingSalesInvoiceSyncForOrder — the
  // invariant lives with the module that owns it, and this earlier call only avoids doing work that a
  // rollback would undo anyway.
  await assertNoSalesInvoicePostingInFlight(tx, input.orderId, new Date())

  // Durable evidence that goods actually left. Read BEFORE the status guard because it is what decides
  // whether a refusal is PERMANENT: SalesOrder.status alone is not proof of dispatch — importWcOrder
  // writes the configurable WooCommerce status mapping straight into it, and a store may map a status to
  // SHIPPED on an order that has allocations but no shipment at all (o3d-bx9).
  //
  // A partially-shipped order stays ALLOCATED (it only flips to SHIPPED when ALL
  // shipments ship), so the order-status guard below is not enough on its own. If any
  // shipment has already been dispatched/journaled, cancelling would release
  // reservations and delete pending shipments while the dispatched shipment's
  // COGS + revenue stay recognised in the ledger with no reversal. The
  // resetAllocationAccountingIfStaged check below is gated on inventoryAllocatedDate
  // (it early-returns when A2 hasn't run), so guard here unconditionally.
  const dispatchedShipment = await tx.shipment.findFirst({
    where: {
      orderId: input.orderId,
      OR: [{ shipmentJournalDate: { not: null } }, { status: 'SHIPPED' }],
    },
    select: { id: true },
  })

  // The status used to validate the CANCELLED transition. Normally the order's real status; for a
  // FALSE-SHIPPED order (o3d-gz6, below) it is repaired to the correct pre-ship state.
  let effectiveStatus: string = lockedOrder.status
  let repairedFalseShipped = false

  if (lockedOrder.status === 'SHIPPED') {
    if (dispatchedShipment) {
      // Genuinely dispatched — an irreversible fact. Cancelling would release reservations and delete
      // pending shipments while the dispatched shipment's recognised COGS + revenue stay in the ledger
      // with no reversal. Refuse permanently: process a refund instead.
      throw new PermanentStatusTransitionError(
        'Cannot cancel a shipped order — process a refund instead')
    }
    // FALSE-SHIPPED (o3d-gz6): the SHIPPED status came from the configurable WooCommerce status mapping
    // (importWcOrder writes it straight into status), NOT a real dispatch — there is no SHIPPED/journaled
    // shipment. The status is therefore unreliable, so REPAIR it to its correct pre-ship state and let
    // the Woo cancellation proceed to release fulfilment and reach CANCELLED, instead of the shipped-order
    // guard refusing it forever (the event exhausted its retries and dead-lettered). An order carrying
    // allocations is canonically ALLOCATED (allocation flow), else PROCESSING; both legally transition to
    // CANCELLED. The anomaly is surfaced via repairedFalseShipped so the caller can audit it.
    const allocCount = await tx.orderAllocation.count({ where: { orderId: input.orderId } })
    effectiveStatus = allocCount > 0 ? 'ALLOCATED' : 'PROCESSING'
    repairedFalseShipped = true
  }

  if (dispatchedShipment) {
    throw new PermanentStatusTransitionError('Cannot cancel an order with a dispatched shipment — process a refund instead')
  }

  const transition = validateManualSalesOrderStatusTransition(effectiveStatus, 'CANCELLED', {
    bypass: input.bypass,
  })
  if (!transition.success) throw new Error(transition.error)

  // o3d-0i5y r11 (Codex round 11, finding 3): the RECORD is selected with the rows, because the
  // `deleteMany` below destroys the only statement of WHICH LAYERS and HOW MANY UNITS Group A2
  // debited for this order. See `recordStandingAllocationDebitOnCancel`.
  //
  // o3d-0i5y r12 (rebase onto o3d-o97 / PR #635): read BEFORE the un-stage, which now clears
  // `costLayerSnapshot` on every row — read after it and the record written below is empty and the
  // cancellation is described as carrying no posted units at all.
  const currentAllocs = await tx.orderAllocation.findMany({
    where: { orderId: input.orderId },
    select: { productId: true, warehouseId: true, qty: true, costLayerSnapshot: true },
  })
  await resetAllocationAccountingIfStaged(tx, input.orderId)
  const releasedReservationScopes = uniqueReservationScopes(currentAllocs)
  await lockStockLevels(
    tx,
    releasedReservationScopes.map((scope) => scope.productId),
    releasedReservationScopes.map((scope) => scope.warehouseId),
  )
  const stockBefore = releasedReservationScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedReservationScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []

  // Keep the before/after reads bracketing the release: the extra locked-row
  // read is small, and it verifies the actual database delta rather than only
  // trusting the requested decrement shape.
  await applyAllocationReservationDelta(tx, currentAllocs, 'release')
  // o3d-0i5y r11: written BEFORE the delete, from the rows as they still stand, so a failure to
  // record the evidence cannot leave the rows gone and the debit undescribed.
  await recordStandingAllocationDebitOnCancel(
    tx,
    input.orderId,
    currentAllocs.flatMap((alloc) => parseCostLayerSnapshot(alloc.costLayerSnapshot)),
  )
  await tx.orderAllocation.deleteMany({ where: { orderId: input.orderId } })

  const deletedShipments = await tx.shipment.deleteMany({
    where: {
      orderId: input.orderId,
      status: { in: ['PENDING', 'PICKING', 'PACKED'] },
    },
  })
  // o3d-kouj: same rule as the release path — a pin with nothing in flight behind it is dormant.
  // AFTER the shipment delete, not before: the picked/packed shipments this cancel destroys are
  // exactly what would otherwise still make their lines look untouchable, and a line whose only
  // remaining evidence is a SHIPPED shipment correctly keeps its pin forever.
  await clearDormantFulfillmentPinsInTx(tx, input.orderId)

  const stockAfter = releasedReservationScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedReservationScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  assertReservationReleaseDelta(stockBefore, stockAfter, currentAllocs)

  await tx.salesOrder.update({
    where: { id: input.orderId },
    data: { ...(input.data ?? {}), status: 'CANCELLED' },
  })

  // Retire any still-pending SALES_INVOICE accounting work in the SAME transaction, so the real-time
  // sync drain cannot post an ACCREC invoice for this now-cancelled, never-shipped order (o3d-5rs).
  await cancelPendingSalesInvoiceSyncForOrder(tx, input.orderId, new Date())

  return {
    previousStatus: lockedOrder.status,
    releasedAllocationCount: currentAllocs.length,
    deletedShipmentCount: deletedShipments.count,
    releasedReservationScopes,
    repairedFalseShipped,
  }
}

/** A quantity carried at the grain `OrderAllocation` and `ShipmentLine` share (o3d-4kfh). */
type AllocationScopeQty = {
  lineId: string
  warehouseId: string
  productId: string
  qty: DecimalInput
}

/**
 * IS EVERY COMMITTED SHIPMENT LINE BACKED BY AN ALLOCATION ROW BIG ENOUGH TO COVER IT (o3d-4kfh)?
 *
 * The contract runs one way — `OrderAllocation.qty` = outstanding demand PLUS every committed
 * (non-PENDING) shipment line — and every other consumer takes it on trust: the reservation
 * residual, `confirmSalesOrderShipments`, the accounting sub-ledger and the reservation invariant
 * all compute `qty − committed` and floor at zero. A commitment LARGER than its row therefore does
 * not overflow anywhere; it silently vanishes, and the units it represents come out of whatever
 * shared `(product, warehouse)` reservation happens to be there at dispatch time.
 *
 * Three things are checked per `(line, warehouse)` that has any commitment:
 *   1. the committed product belongs to the line (no stranger components),
 *   2. an allocation row exists at that exact scope with `qty >= committed`,
 *   3. the committed quantities form a COMPLETE, PROPORTIONAL component set.
 *
 * (3) is not redundant with (2) for a KIT: 2 of a 2xA + 1xB kit committed as A-only is covered
 * product-by-product while covering zero whole kits, so `calculateDecimalCoverageByLine` credits
 * nothing and those A units strand against demand that still reads as unshipped. Shipment lines are
 * created only by `confirmSalesOrderShipments`, straight from the allocation rows the structural
 * check above already holds proportional to `ALLOCATION_EPSILON_DECIMAL`, so a proportional
 * commitment is the normal case and the same epsilon is the right one to judge it by.
 *
 * Returns the operator-facing message, or null when every commitment is backed.
 */
export function findUncoveredCommittedShipment(
  requirementsByLine: Map<string, DecimalFulfillmentRequirement[]>,
  lineLabelById: Map<string, string>,
  allocations: AllocationScopeQty[],
  committedShipmentLines: AllocationScopeQty[],
): string | null {
  const scopeKey = (row: { lineId: string; warehouseId: string; productId: string }) =>
    `${row.lineId}|${row.warehouseId}|${row.productId}`

  const allocatedByScope = new Map<string, Prisma.Decimal>()
  for (const allocation of allocations) {
    const key = scopeKey(allocation)
    allocatedByScope.set(
      key,
      (allocatedByScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(allocation.qty)),
    )
  }

  // Grouped per (line, warehouse) because that is the grain a bundle is shipped at: one shipment
  // belongs to one warehouse, and its component lines are only a complete kit together.
  const committedByLineWarehouse = new Map<string, Map<string, Prisma.Decimal>>()
  for (const shipmentLine of committedShipmentLines) {
    // Lines outside the validated set (or with no product) have no requirements to judge against.
    if (!requirementsByLine.has(shipmentLine.lineId)) continue
    const group = `${shipmentLine.lineId}|${shipmentLine.warehouseId}`
    const quantities = committedByLineWarehouse.get(group) ?? new Map<string, Prisma.Decimal>()
    quantities.set(
      shipmentLine.productId,
      (quantities.get(shipmentLine.productId) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)),
    )
    committedByLineWarehouse.set(group, quantities)
  }

  for (const [group, quantities] of committedByLineWarehouse) {
    // warehouseId never contains the separator, and lineId is whatever precedes the LAST one.
    const separator = group.lastIndexOf('|')
    const lineId = group.slice(0, separator)
    const warehouseId = group.slice(separator + 1)
    const requirements = requirementsByLine.get(lineId) ?? []
    if (requirements.length === 0) continue
    const label = lineLabelById.get(lineId) ?? lineId
    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))

    for (const [productId, committedQty] of quantities) {
      if (committedQty.lte(ALLOCATION_EPSILON_DECIMAL)) continue
      if (!requiredProductIds.has(productId)) {
        return `Shipments for sales line ${label} in warehouse ${warehouseId} commit a component that is not part of that line`
      }
      const allocatedQty = allocatedByScope.get(`${lineId}|${warehouseId}|${productId}`)
        ?? new Prisma.Decimal(0)
      if (committedQty.sub(allocatedQty).gt(ALLOCATION_EPSILON_DECIMAL)) {
        return `Shipments for sales line ${label} in warehouse ${warehouseId} commit ${committedQty.toString()} unit(s) `
          + `but only ${allocatedQty.toString()} are allocated there — the allocation row is what the shipment, the `
          + 'reservation residual and the accounting sub-ledger net against, so it must cover what has been committed'
      }
    }

    const committedCoverage = calculateDecimalFulfillmentCoverage(requirements, quantities)
    for (const requirement of requirements) {
      const actualQty = quantities.get(requirement.productId) ?? new Prisma.Decimal(0)
      const expectedQty = committedCoverage.mul(requirement.factor)
      if (actualQty.sub(expectedQty).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
        return `Shipments for sales line ${label} in warehouse ${warehouseId} do not commit a complete component set`
      }
    }
  }

  return null
}

/**
 * IS EVERY ALLOCATION ROW STILL ANSWERING THE QUESTION IT WAS COMPUTED FOR (o3d-4kfh r6, Codex
 * finding 1)?
 *
 * `OrderAllocation.fulfillmentGraphVersion` records `Product.fulfillmentGraphVersion` of the ORDER
 * LINE's product at the moment the row was expanded. A component-graph edit bumps that version for
 * the edited product AND every KIT above it, in the same transaction as the edit
 * (`bumpFulfillmentGraphVersions`). A stamp that no longer matches therefore means: these rows were
 * derived from a recipe that no longer exists.
 *
 * THIS IS THE CHECK THE PROPORTIONALITY BACKSTOP CANNOT REPLACE, and r5 was wrong to claim it
 * could. Interleave an allocation with an editor:
 *
 *   allocation reads 2xA + 1xB and computes A=2 / B=1;
 *   the editor sees no committed allocation (that transaction is still open) and rescales the kit
 *   to 4xA + 2xB;
 *   the allocation commits A=2 / B=1.
 *
 * `findUncoveredCommittedShipment` computes coverage 0.5 against the NEW graph and expects exactly
 * A=2 / B=1 — which is what it finds. The per-leaf dispatch cap sees neither leaf exceeding
 * A=4 / B=2. Both pass, and half the current kit ships. Proportionality against a MUTABLE current
 * graph cannot distinguish that race from a legitimate partial shipment, because on the numbers it
 * is not distinguishable. The version moves even when the proportions scale uniformly, which is
 * exactly why it catches this.
 *
 * Rows and products both start at 0, so nothing pre-existing reads as stale.
 *
 * `graphVersion` MUST be the version carried by the graph node the caller expanded (o3d-4kfh r7,
 * Codex finding 1) — never a separately-queried `Product.fulfillmentGraphVersion`. The check's
 * whole content is "were these rows derived from the recipe I am judging them against"; sourcing
 * the two halves from two snapshots reintroduces the race at the checking end, where an old version
 * certifies old rows while the quantities are compared against a new graph.
 *
 * ---------------------------------------------------------------------------------------------
 * o3d-kouj — THIS CHECK IS NOW SKIPPED FOR ANY LINE THAT CARRIES A REQUIREMENT SNAPSHOT, AND THAT
 * IS THE WHOLE OF o3d-57b0'S SERIALIZATION HALF BEING SUBSUMED. It is not an optimisation and it is
 * not optional: leaving the CAS running over a snapshot-backed line would be actively wrong.
 *
 * Read the escape above again with the snapshot in place. The allocation pins 2xA + 1xB onto the
 * line in the same transaction as the rows; the editor rescales the kit to 4xA + 2xB; the
 * allocation commits A=2 / B=1. `findUncoveredCommittedShipment` now expands the PINNED recipe, so
 * it computes coverage 1.0 against 2xA + 1xB and finds a complete set — because it IS a complete
 * set of what this order requires. There is no half-kit, so there is nothing for a version
 * comparison to catch. The current graph stopped being the authority for in-flight work, which is
 * the only reason the CAS ever had to exist.
 *
 * What the CAS WOULD do if it kept running is resurrect the o3d-4kfh r4 defect one layer down.
 * `bumpFulfillmentGraphVersions` walks the whole KIT-ancestor set, so after ANY component edit
 * anywhere below a kit, every in-flight order for that kit carries a stamp that no longer matches
 * the product — permanently, since the snapshot deliberately refuses to be re-captured while the
 * line holds allocations. Every such order would be refused at commitment and at dispatch, and the
 * remedy the message names ("re-allocate this order") would not clear it. A refusal with no
 * operator remedy is exactly what r5 removed from the edit guard.
 *
 * It is NOT deleted, because a line with a NULL snapshot — one that has never been allocated since
 * this column shipped, or whose snapshot was captured for a product the line no longer references —
 * is still resolved from the current graph, and for those lines every word above the line still
 * applies. One rule, conditioned on the same predicate the requirement resolution is conditioned on.
 * ---------------------------------------------------------------------------------------------
 */
export function findStaleFulfillmentGraphAllocation(
  lines: Array<{ id: string; sku: string | null; description: string; graphVersion: number; snapshotBacked?: boolean }>,
  allocations: Array<{ lineId: string; fulfillmentGraphVersion: number }>,
): string | null {
  const lineById = new Map(lines.map((line) => [line.id, line]))
  for (const allocation of allocations) {
    const line = lineById.get(allocation.lineId)
    if (!line) continue // outside the validated set — not this check's business
    // o3d-kouj: the line's requirements came from its own pinned snapshot, not from the product's
    // current graph, so the product's current version says nothing about these rows.
    if (line.snapshotBacked) continue
    if (allocation.fulfillmentGraphVersion === line.graphVersion) continue
    return `Allocation for sales line ${line.sku ?? line.description} was computed against an older `
      + `version of that product's component graph (allocation ${allocation.fulfillmentGraphVersion}, `
      + `product ${line.graphVersion}). The kit recipe changed after these rows were written, so what `
      + 'they represent is no longer what the order requires — a uniform rescale of a kit passes every '
      + 'quantity and proportionality check while shipping a fraction of it. Re-allocate this order '
      + 'to rebuild the rows against the current graph, then retry.'
  }
  return null
}

/**
 * The rows both allocation checks read. Extracted so `validateCommittedShipmentCoverage` cannot
 * end up asking a DIFFERENT question of a differently-filtered set than the full integrity check —
 * the two must agree about which shipments count as committed and which rows back them.
 *
 * THE SNAPSHOT BOUNDARY (o3d-4kfh r7/r8, Codex finding 1). There is exactly ONE read on this path
 * that is allowed to answer "what does this line require, and which version of the graph says so",
 * and it is `loadFulfillmentProductGraph` below. r7 said the two answers "come out of the same
 * statement per node" and treated that as sufficient; it is not, and r8 corrects it. Per-node
 * atomicity leaves the MAP torn: the walk is one statement per BFS level, so a nested KIT edited
 * between two levels paired an OLD root version with a NEW descendant recipe, and the CAS compares
 * the stamp to the ROOT. `loadFulfillmentProductGraph` now re-reads the version of EVERY visited
 * node after the walk and re-walks if any moved, so the map it returns belongs to one version of
 * the graph — that, not the per-node select, is why the version the CAS compares against is the
 * version of the recipe the quantities were checked against.
 *
 * r6 got this half right. It stamped the ALLOCATOR from the graph node, and then let VALIDATION
 * read `Product.fulfillmentGraphVersion` back through `salesOrderLine.product` — a THIRD snapshot,
 * taken one statement before the graph. Under READ COMMITTED an editor committing between those two
 * statements produced exactly the hole the stamp exists to close: the line query returns the OLD
 * version (matching the OLD stamp on the rows, so the CAS passes) while the graph query returns the
 * NEW recipe (against which a uniform rescale is still perfectly proportional, so
 * `findUncoveredCommittedShipment` passes too). Both checks pass and half a kit dispatches. The
 * `select` is gone rather than merely unused, so the stale value is not available to be read again.
 *
 * NOT solved here, and not claimed to be: this path still takes no lock against graph writers, so
 * an edit committing AFTER the graph load's verify read is invisible to the whole transaction. That
 * is the serialization gap filed as o3d-57b0 and described in the component-graph guard's
 * docstring. Nor is the CAS a whole-graph CAS — the stamp is still the ROOT's single `Int`, so a
 * descendant edit is caught only because `bumpFulfillmentGraphVersions` walks up to the root; the
 * per-node version set is validated inside the loader, not persisted onto the allocation rows. What
 * r7 and r8 removed are the two AVOIDABLE windows inside our own read sequence: the third snapshot
 * that read `Product.fulfillmentGraphVersion` back through `salesOrderLine.product`, and the tear
 * between the graph walk's own statements.
 *
 * Returns null when the order has no product-bearing lines in scope; nothing to check.
 */
async function loadAllocationIntegrityRows(
  client: AllocationServiceClient,
  orderId: string,
  lineIds?: string[],
) {
  const lines = await client.salesOrderLine.findMany({
    where: {
      orderId,
      productId: { not: null },
      ...(lineIds?.length ? { id: { in: lineIds } } : {}),
    },
    select: {
      id: true,
      productId: true,
      qty: true,
      sku: true,
      description: true,
      // o3d-kouj: the pinned recipe, if this line has one. Selected HERE rather than resolved by a
      // second query for the same reason the graph version is taken from the graph node: the
      // requirements and the thing that certifies them have to come out of one read.
      fulfillmentRequirements: true,
    },
  })
  if (lines.length === 0) return null

  const graph = await loadFulfillmentProductGraph(
    client,
    lines.map((line) => line.productId!).filter(Boolean),
  )
  const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  // The CAS input, built in the SAME loop as the requirements and from the SAME graph, so the two
  // cannot drift apart later. A line whose product is missing from the graph (deleted under us)
  // reads 0 and therefore fails closed against any stamped row — there is no recipe left to certify.
  //
  // o3d-kouj: `snapshotBacked` is computed from the SAME `line` object the requirements were
  // resolved from, so "these requirements came from the snapshot" and "skip the CAS for this line"
  // can never disagree — they are one fact read once.
  const versionedLines: Array<{
    id: string
    sku: string | null
    description: string
    graphVersion: number
    snapshotBacked: boolean
  }> = []
  for (const line of lines) {
    requirementsByLine.set(line.id, lineFulfillmentRequirements(line, graph))
    versionedLines.push({
      id: line.id,
      sku: line.sku,
      description: line.description,
      graphVersion: graph.get(line.productId!)?.fulfillmentGraphVersion ?? 0,
      snapshotBacked: hasFulfillmentRequirementSnapshot(line),
    })
  }

  const [allocations, activeShipmentLines] = await Promise.all([
    client.orderAllocation.findMany({
      where: {
        orderId,
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        warehouseId: true,
        qty: true,
        fulfillmentGraphVersion: true,
      },
    }),
    client.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        qty: true,
        // o3d-4kfh: the warehouse is what makes a shipment line attributable to the allocation row
        // it commits — (lineId, warehouseId, productId) is the grain both tables share.
        shipment: { select: { warehouseId: true } },
      },
    }),
  ])

  return { lines, versionedLines, requirementsByLine, allocations, activeShipmentLines }
}

/** The committed shipment lines re-expressed at allocation-row grain. */
function committedScopeRows(
  activeShipmentLines: Array<{ lineId: string; productId: string; qty: DecimalInput; shipment: { warehouseId: string } }>,
): AllocationScopeQty[] {
  return activeShipmentLines.map((shipmentLine) => ({
    lineId: shipmentLine.lineId,
    productId: shipmentLine.productId,
    warehouseId: shipmentLine.shipment.warehouseId,
    qty: shipmentLine.qty,
  }))
}

/**
 * The DOWNWARD half of the integrity check on its own (o3d-4kfh r3): every committed shipment line
 * is backed by an allocation row big enough to cover it.
 *
 * Split out from {@link validateAllocationIntegrity} for the COMMITMENT TRANSITION
 * (PENDING -> PICKING), where the upward half must not be run: an order can legitimately sit with
 * allocation rows that a later refund has left above the remaining demand, and refusing to let the
 * warehouse start picking because of that would be a new operator dead end. What must never happen
 * is a shipment BECOMING committed with nothing behind it.
 */
export async function validateCommittedShipmentCoverage(
  client: AllocationServiceClient,
  orderId: string,
  lineIds?: string[],
): Promise<string | null> {
  const rows = await loadAllocationIntegrityRows(client, orderId, lineIds)
  if (!rows) return null
  // o3d-4kfh r6: THE CAS FIRST. It is the only check that catches a uniform kit rescale, and it is
  // cheap (an integer comparison on rows already loaded). Running it before the proportionality
  // check also means the operator gets the accurate, actionable message ("re-allocate") rather than
  // a proportionality complaint about numbers that are, against the new graph, proportional.
  //
  // r7: `versionedLines` — the version out of the graph read that produced `requirementsByLine`
  // below, not a separately-read `Product` column. See the snapshot-boundary note on
  // `loadAllocationIntegrityRows`.
  const staleGraphError = findStaleFulfillmentGraphAllocation(rows.versionedLines, rows.allocations)
  if (staleGraphError) return staleGraphError
  return findUncoveredCommittedShipment(
    rows.requirementsByLine,
    new Map(rows.lines.map((line) => [line.id, line.sku ?? line.description])),
    rows.allocations,
    committedScopeRows(rows.activeShipmentLines),
  )
}

/**
 * Structural + quantity check on an order's allocation rows.
 *
 * o3d-4kfh — reads `OrderAllocation.qty` under the contract stated in `allocateSalesOrder`: a row
 * covers its committed shipment lines as well as the outstanding demand. So the quantity test
 * subtracts the SAME non-PENDING shipment set from both sides — from the rows (per allocation
 * scope) and from the line's ordered quantity — and compares what is left. Comparing raw rows
 * against a net demand figure is not a stricter check, it is an incoherent one.
 */
export async function validateAllocationIntegrity(
  client: AllocationServiceClient,
  orderId: string,
  lineIds?: string[],
): Promise<string | null> {
  const rows = await loadAllocationIntegrityRows(client, orderId, lineIds)
  if (!rows) return null
  const { lines, versionedLines, requirementsByLine, allocations, activeShipmentLines } = rows

  // o3d-4kfh r6: the graph-version CAS runs here too, not only at the commitment/dispatch seam.
  // `confirmSalesOrderShipments` builds its drafts straight from these rows, so letting a stale set
  // through here would only move the refusal to the warehouse floor at Start Picking. The manual
  // allocation editor calls this as well: a stale row cannot be repaired by editing its quantity —
  // the whole set has to be rebuilt — so refusing with "re-allocate" is the correct answer there.
  //
  // r7: same snapshot as `requirementsByLine` — see `loadAllocationIntegrityRows`.
  const staleGraphError = findStaleFulfillmentGraphAllocation(versionedLines, allocations)
  if (staleGraphError) return staleGraphError

  const committedByLine = calculateDecimalCoverageByLine(
    requirementsByLine,
    activeShipmentLines,
  )
  // o3d-4kfh: committed quantity per ALLOCATION ROW, the subtrahend that turns a retained row into
  // the open (still-to-ship) quantity this check is about. Same non-PENDING set as committedByLine
  // above, so the two sides of the final comparison net the SAME shipments out.
  const committedByAllocationScope = new Map<string, Prisma.Decimal>()
  for (const shipmentLine of activeShipmentLines) {
    const key = `${shipmentLine.lineId}|${shipmentLine.shipment.warehouseId}|${shipmentLine.productId}`
    committedByAllocationScope.set(
      key,
      (committedByAllocationScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)),
    )
  }

  // o3d-4kfh r3: THE COMMITMENT MUST BE BACKED, and this is the only check that looks DOWNWARD.
  //
  // Everything else here rejects coverage ABOVE the remaining demand. Nothing rejected coverage
  // BELOW the commitment, and the arithmetic hid it perfectly: with committed 10 against a row of
  // 5, `openQuantities` floors `5 - 10` to 0 and `remainingQty` floors `qty - 10` to 0, so open
  // coverage 0 <= remaining 0 and validation SUCCEEDED on an order with five shipped-or-picked
  // units no allocation row accounts for. The residual arithmetic cannot surface it either — it
  // credits only what is actually left — so an order could be corrupted through the stale-PENDING
  // path or an unlocked commitment race and then pass every check IMS has.
  const committedCoverageError = findUncoveredCommittedShipment(
    requirementsByLine,
    new Map(lines.map((line) => [line.id, line.sku ?? line.description])),
    allocations,
    committedScopeRows(activeShipmentLines),
  )
  if (committedCoverageError) return committedCoverageError

  for (const line of lines) {
    const requirements = requirementsByLine.get(line.id) ?? []
    if (requirements.length === 0) continue

    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))
    const lineAllocations = allocations.filter((allocation) => allocation.lineId === line.id)
    const byWarehouse = new Map<string, Map<string, Prisma.Decimal>>()

    for (const allocation of lineAllocations) {
      const quantities = byWarehouse.get(allocation.warehouseId) ?? new Map<string, Prisma.Decimal>()
      quantities.set(
        allocation.productId,
        (quantities.get(allocation.productId) ?? new Prisma.Decimal(0)).add(toDecimal(allocation.qty)),
      )
      byWarehouse.set(allocation.warehouseId, quantities)
    }

    // o3d-4kfh: the STRUCTURAL checks below (complete component set, proportional components, no
    // stranger components) run on the RAW row quantities, because that is what is persisted and
    // what every other consumer expands. Only the total is netted, in `openCoverage`.
    let openCoverage = new Prisma.Decimal(0)
    for (const [warehouseId, quantities] of byWarehouse) {
      const coverage = calculateDecimalFulfillmentCoverage(requirements, quantities)
      if (coverage.lte(ALLOCATION_EPSILON_DECIMAL)) {
        return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} does not contain a complete component set`
      }

      for (const requirement of requirements) {
        const actualQty = quantities.get(requirement.productId) ?? new Prisma.Decimal(0)
        const expectedQty = coverage.mul(requirement.factor)
        if (actualQty.sub(expectedQty).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
          return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} must keep bundle components in matching quantities`
        }
      }

      for (const productId of quantities.keys()) {
        if (!requiredProductIds.has(productId)) {
          return `Allocation for sales line ${line.sku ?? line.description} contains an unexpected component`
        }
      }

      // The OPEN coverage of this warehouse's rows: the same rows with their own committed
      // shipment lines netted off, floored per row exactly as `residualAllocationQty` floors.
      // Without this the check compared a retained row (which covers its shipments by contract)
      // against a demand figure with those same shipments already subtracted, so every partially
      // dispatched order read as over-allocated by the dispatched amount — blocking shipment
      // confirmation and every manual allocation edit for the rest of that order's life.
      const openQuantities = new Map<string, Prisma.Decimal>()
      for (const [productId, qty] of quantities) {
        const committed = committedByAllocationScope.get(`${line.id}|${warehouseId}|${productId}`)
          ?? new Prisma.Decimal(0)
        openQuantities.set(productId, Prisma.Decimal.max(new Prisma.Decimal(0), qty.sub(committed)))
      }
      openCoverage = openCoverage.add(calculateDecimalFulfillmentCoverage(requirements, openQuantities))
    }

    const committedCoverage = committedByLine.get(line.id) ?? new Prisma.Decimal(0)
    const remainingQty = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committedCoverage))
    if (openCoverage.sub(remainingQty).abs().gt(ALLOCATION_EPSILON_DECIMAL) && openCoverage.gt(remainingQty)) {
      return `Allocation for sales line ${line.sku ?? line.description} exceeds the remaining quantity to fulfill`
    }
  }

  return null
}

function mergeAllocationRows(rows: AllocationRowInput[]): AllocationRowInput[] {
  const merged = new Map<string, AllocationRowInput>()

  for (const row of rows) {
    const key = `${row.lineId}|${row.warehouseId}|${row.productId}`
    const existing = merged.get(key)
    if (existing) {
      existing.qty = existing.qty.add(row.qty)
      continue
    }
    merged.set(key, { ...row })
  }

  return [...merged.values()].filter((row) => row.qty.gt(0))
}

/**
 * Is the freshly computed allocation set identical to what is already persisted (o3d-i5it)?
 *
 * Compared as a SET keyed on (lineId, warehouseId, productId) — the same key mergeAllocationRows
 * dedupes on — because row order is not meaningful and neither side is ordered.
 *
 * The quantity comparison is EXACT — Decimal.eq, not a tolerance. Comparing at one scale while
 * mutating reservations at another is precisely the mismatch that made an earlier version of this
 * check unreliable, so it must not quietly absorb a difference (o3d-i4qd).
 *
 * The consequence is that a computed quantity the column cannot represent exactly — a nested KIT's
 * 0.11102224 against its persisted 0.1110 — reports as a CHANGE, so the short-circuit does not fire
 * and that order keeps being rewritten. That is the pre-existing behaviour and is tracked as
 * o3d-i4qd; the fix belongs in how the set is canonicalised, not in loosening this comparison.
 *
 * Decimal.eq rather than `===` because two Decimals of equal value can differ in representation.
 *
 * DO NOT ADD `fulfillmentGraphVersion` TO THIS COMPARISON (o3d-4kfh r7). It is the tempting fix for
 * the stale-stamp case Codex finding 3 raised, and it is the wrong one: a stamp mismatch would then
 * report the set as CHANGED and trigger the full destructive cycle — accounting reset, release,
 * delete, recreate, re-reserve — on an order whose quantities did not move. That is exactly the
 * churn o3d-i5it removed, and the reset is what lets the daily batch re-post an A2 journal. The
 * question this function answers is "would a rewrite move anything?", and the answer is still no.
 * The stamp is repaired by a targeted `updateMany` on the unchanged branch of `allocateSalesOrder`.
 */
export function allocationSetsMatch(
  existing: Array<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }>,
  next: AllocationRowInput[],
): boolean {
  if (existing.length !== next.length) return false

  const key = (row: { lineId: string; warehouseId: string; productId: string }) =>
    `${row.lineId}|${row.warehouseId}|${row.productId}`

  const existingByKey = new Map(existing.map((row) => [key(row), toDecimal(row.qty)]))
  if (existingByKey.size !== existing.length) return false // duplicate keys: not a canonical set

  for (const row of next) {
    const persisted = existingByKey.get(key(row))
    if (!persisted || !persisted.eq(row.qty)) return false
  }
  return true
}

function collectNonOversellLeafComponents(
  productId: string,
  graph: Map<string, FulfillmentGraphNode>,
): string[] {
  const blockers = new Set<string>()

  function visit(currentProductId: string, stack: Set<string>) {
    if (stack.has(currentProductId)) return
    const node = graph.get(currentProductId)
    if (!node || node.type !== 'KIT') return

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      if (component.componentType === 'KIT') {
        visit(component.componentId, stack)
        continue
      }
      if (!component.componentOversellAllowed) {
        blockers.add(component.componentSku || component.componentId)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, new Set<string>())
  return [...blockers].sort()
}

function noAllocationResult(error: string): AllocateSalesOrderResult {
  return {
    success: false,
    error,
    syncProductIds: [],
    allocationCount: 0,
    unallocatedLines: [],
    unallocatedQty: 0,
    backorderLineCount: 0,
  }
}

export async function allocateSalesOrder(
  client: AllocationServiceClient,
  input: AllocateSalesOrderInput,
): Promise<AllocateSalesOrderResult> {
  const { orderId } = input
  const so = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      // b8i6.1: any shopping connector (not just WooCommerce) — a storefront order
      // allocates only from storefront-synced warehouses regardless of connector.
      shoppingLinks: { select: { id: true }, take: 1 },
      status: true,
      shipFromWarehouseId: true,
      lines: {
        select: {
          id: true,
          orderId: true,
          productId: true,
          qty: true,
          sku: true,
          description: true,
          product: {
            select: {
              id: true,
              sku: true,
              type: true,
              oversellAllowed: true,
            },
          },
        },
      },
    },
  })
  if (!so) return noAllocationResult('Order not found')

  const isShoppingOrder = so.shoppingLinks.length > 0
  const orderRef = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const allWarehouses = await client.warehouse.findMany({
    where: {
      active: true,
      availableForSale: true,
      ...(isShoppingOrder ? { syncToStore: true } : {}),
    },
    select: { id: true, code: true, name: true, isDefault: true, syncToStore: true },
    orderBy: { isDefault: 'desc' },
  })
  if (!allWarehouses.length) {
    return {
      ...noAllocationResult(isShoppingOrder ? 'No storefront-synced warehouses available for sale' : 'No warehouses available for sale'),
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
    }
  }

  const primaryId = so.shipFromWarehouseId
  const sorted = [...allWarehouses].sort((a, b) => {
    if (a.id === primaryId) return -1
    if (b.id === primaryId) return 1
    if (a.isDefault && !b.isDefault) return -1
    if (!a.isDefault && b.isDefault) return 1
    if (a.syncToStore && !b.syncToStore) return -1
    if (!a.syncToStore && b.syncToStore) return 1
    return 0
  })

  const productIds = so.lines.filter((line) => line.productId).map((line) => line.productId!)

  const runAllocation = async (tx: Prisma.TransactionClient) => {
    await lockSalesOrder(tx, orderId)

    // Re-read status UNDER the row lock. `so.status` above was read for warehouse selection BEFORE
    // the lock, and the order may have moved since — a concurrent CANCELLED, ON_HOLD, or full refund.
    // Every decision below that depends on status uses THIS value, not the stale one (o3d-2s8, Codex
    // review of #496).
    const locked = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { status: true, refundStatus: true },
    })
    const lockedStatus = locked?.status ?? so.status

    if (input.refuseIfShipmentsExist || input.refuseIfCommittedShipmentsExist) {
      const shipmentExists = await tx.shipment.findFirst({
        where: {
          orderId,
          // o3d-4kfh r5: the narrow flag ignores PENDING drafts entirely — `reconcilePendingShipments`
          // below handles them selectively. Both flags set means the strict one wins.
          ...(input.refuseIfShipmentsExist
            ? {}
            : { status: { not: UNCOMMITTED_SHIPMENT_STATUS } }),
        },
        select: { id: true },
      })
      if (shipmentExists) {
        return { nextAllocations: [], syncProductIds: [], refused: true as const, skippedStatus: null }
      }
    }

    // A CANCELLED or fully-refunded order has ZERO allocation demand — it must hold no reservations.
    // We do NOT refuse (that would strand its existing allocations); instead demand is treated as zero
    // so the release-and-delete below runs and reserves nothing, making allocation a pure
    // deallocation. FULL is included because it is a MONETARY classification (a full-value refund can
    // occur with less than full product QUANTITY — an amount-only or shipping refund), so the
    // per-line quantity demand can be non-zero even when the order is fully refunded; without this an
    // order refunded in full could be re-reserved and promoted. Both are read UNDER the lock, so a
    // refund committing between the payment advance and this allocation is honoured (Codex review #496).
    const zeroDemand = lockedStatus === 'CANCELLED' || locked?.refundStatus === 'FULL'

    // o3d-6ab: revalidate the CALLER'S PREMISE under the lock, not just the order's own state. Batch
    // callers select candidates by status outside the lock; by the time the lock is granted the order
    // may have moved to a status that no longer wants (re)allocation — ON_HOLD, or already advanced past
    // PROCESSING into PICKING/PACKED/SHIPPED. Without this the release/delete/recreate + re-reserve below
    // still runs, silently re-reserving stock for a held order and churning an order someone else now
    // owns. Skipped BEFORE the first write (resetAllocationAccountingIfStaged) so the no-op is total.
    // zeroDemand is exempt on purpose — see requireStatusUnderLock's doc comment: releasing a
    // cancelled/fully-refunded order's reservations is always correct, so it must not be short-circuited.
    if (
      !zeroDemand &&
      input.requireStatusUnderLock &&
      !input.requireStatusUnderLock.includes(lockedStatus)
    ) {
      return {
        nextAllocations: [],
        syncProductIds: [],
        refused: false as const,
        skippedStatus: lockedStatus,
      }
    }

    // NOTE: resetAllocationAccountingIfStaged is deliberately NOT called here (o3d-i5it). It used
    // to run before the allocation was even computed, so a re-run that changed nothing still
    // cleared inventoryAllocatedDate and the cost snapshots. It now runs only once the computed
    // set is known to DIFFER from the persisted one — see the unchanged-set check below.
    const graph = await loadFulfillmentProductGraph(tx, productIds)

    // ---------------------------------------------------------------------------------------
    // o3d-kouj: WHICH LINES MAY (RE)PIN THEIR RECIPE, decided BEFORE anything is expanded.
    //
    // The order matters and is the whole subtlety. If the capture ran after the expansion, a line
    // that still carried a snapshot from a PREVIOUS in-flight life (allocated, then deallocated)
    // would have its rows expanded from the OLD recipe and then be re-pinned to the NEW one — rows
    // and snapshot describing different kits, on the row set this very run just wrote. So the
    // capturable set is computed first, and a capturable line is expanded from the CURRENT GRAPH,
    // which is by construction the same thing the capture below records.
    //
    // Both reads are under the order row lock and every writer of this order's allocations and
    // shipments takes that lock first, so the in-flight set cannot move between here and the
    // reads further down that use it for the reservation arithmetic. The committed-shipment read
    // is not folded into the allocation-row read even though a committed shipment line is always
    // backed by an allocation row (validateCommittedShipmentCoverage enforces exactly that): an
    // invariant is a reason a check passes, not a reason to delete it.
    // ---------------------------------------------------------------------------------------
    const snapshotLines = await tx.salesOrderLine.findMany({
      where: { orderId },
      select: { id: true, productId: true, fulfillmentRequirements: true },
    })
    const [linesHoldingAllocations, linesHoldingCommittedShipments] = await Promise.all([
      tx.orderAllocation.findMany({ where: { orderId }, select: { lineId: true } }),
      tx.shipmentLine.findMany({
        where: { shipment: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } } },
        select: { lineId: true },
      }),
    ])
    const capturableLineIds = new Set(selectCapturableLineIds({
      lineIds: snapshotLines.map((line) => line.id),
      lineIdsHoldingAllocations: linesHoldingAllocations.map((row) => row.lineId),
      lineIdsHoldingCommittedShipments: linesHoldingCommittedShipments.map((row) => row.lineId),
    }))
    // A capturable line's stored snapshot is deliberately discarded here: it describes an in-flight
    // life this line no longer has, and this run is about to replace it.
    const resolvableLineById = new Map(snapshotLines.map((line) => [line.id, {
      id: line.id,
      productId: line.productId,
      fulfillmentRequirements: capturableLineIds.has(line.id) ? null : line.fulfillmentRequirements,
    }]))

    const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
    // o3d-4kfh r6: THE VERSION OF THE GRAPH THIS RUN IS ABOUT TO EXPAND, per sales line.
    //
    // Taken from the graph node, which means it came out of the SAME statement as that product's
    // component list — under READ COMMITTED a second query could see a version the components do
    // not belong to, and the stamp would then certify a recipe that was never read. A line whose
    // product is missing from the graph (a deleted product) stamps 0 and is left to the existing
    // checks; there is no recipe to be stale about.
    //
    // o3d-kouj: the column keeps its meaning — THE GRAPH VERSION THESE ROWS WERE EXPANDED FROM — for
    // both kinds of line. For an unpinned line that is the current graph's version, and the CAS
    // still reads it. For a PINNED line the rows are expanded from the pin, so the honest value is
    // the version the pin recorded; writing the current version instead would leave the row claiming
    // a provenance it does not have, and would silently certify it as current if the pin were ever
    // lost. The CAS is skipped per line, not switched off — see findStaleFulfillmentGraphAllocation.
    const graphVersionByLine = new Map<string, number>()
    for (const line of so.lines) {
      if (!line.productId) continue
      const resolvable: SnapshotResolvableLine = resolvableLineById.get(line.id)
        ?? { id: line.id, productId: line.productId, fulfillmentRequirements: null }
      requirementsByLine.set(line.id, lineFulfillmentRequirements(resolvable, graph))
      const pin = parseFulfillmentRequirementSnapshot(resolvable.fulfillmentRequirements, line.id)
      graphVersionByLine.set(
        line.id,
        pin && pin.productId === line.productId
          ? pin.graphVersion
          : graph.get(line.productId)?.fulfillmentGraphVersion ?? 0,
      )
    }

    // o3d-kouj: the leaves to lock come from the RESOLVED requirements, not from a fresh walk of the
    // current graph. A line pinned to an older recipe can require a component the current recipe no
    // longer mentions, and that component's stock row is the one this transaction is about to
    // reserve — locking the current graph's leaves instead would leave it unlocked.
    const leafProductIds = lineFulfillmentLeafProductIds(
      so.lines
        .filter((line) => line.productId)
        .map((line) => resolvableLineById.get(line.id) ?? { id: line.id, productId: line.productId }),
      graph,
    )
    await lockStockLevels(tx, leafProductIds, sorted.map((warehouse) => warehouse.id))

    const stockLevels = await tx.stockLevel.findMany({
      where: { productId: { in: leafProductIds }, warehouseId: { in: sorted.map((warehouse) => warehouse.id) } },
      select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    })
    // Loaded BEFORE the own-allocation read because the reservation view of those rows depends on
    // it: warehouseId is selected so a shipment line can be attributed to the allocation row it
    // dispatched, which is the (lineId, warehouseId, productId) grain.
    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: {
        lineId: true,
        productId: true,
        qty: true,
        shipment: { select: { status: true, warehouseId: true } },
      },
    })
    // Every COMMITTED shipment line at allocation-row grain. "Committed" is the demand view: any
    // non-PENDING shipment is a promise this order has already made, which is why the demand
    // netting below subtracts it and why the rows must keep covering it (see persistedAllocations).
    const committedAllocationLines = activeShipmentLines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      warehouseId: line.shipment.warehouseId,
      status: line.shipment.status,
      qty: toDecimal(line.qty),
    }))
    // o3d-4kfh: only DISPATCHED lines have given reservation back. The reservation view is
    // therefore a STRICT SUBSET of the committed set above: reservedQty is decremented solely on
    // the transition to SHIPPED, so a PICKING/PACKED line is committed demand AND live reservation
    // at the same time. Conflating the two under-releases (netting a picked line out of a residual
    // strands its reservation forever).
    const dispatchedAllocationLines = committedAllocationLines.filter(
      (line) => line.status === RESERVATION_RELEASING_SHIPMENT_STATUS,
    )

    const ownAllocations = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    // o3d-4kfh: this order's LIVE reservation, not its retained allocation rows. Feeding the raw
    // rows here did two separate kinds of damage on any partially/fully dispatched order:
    // otherReservedQty came out too low, over-stating availability and letting this order allocate
    // into another order's live reservation; and findUnderReservedScopes reported the perfectly
    // healthy steady state (ownQty > reservedQty by exactly the shipped amount) as an integrity
    // ERROR. Both are the same arithmetic mistake as the release paths.
    const ownReservationRows = residualAllocationRows(ownAllocations, dispatchedAllocationLines)
    const stockMap = buildAvailableStockMapIncludingOwnReservations(stockLevels, ownReservationRows)

    const committedByLine = calculateDecimalCoverageByLine(
      requirementsByLine,
      activeShipmentLines,
    )

    // Refunded quantities are no longer outstanding demand — a refund on a not-yet-
    // shipped order removes those units from what needs allocating. Only ever reduces
    // demand, so it is safe for every status (already-shipped lines clamp to 0).
    const refundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, qty: true },
    })
    const refundedByLine = new Map<string, Prisma.Decimal>()
    for (const refundLine of refundLines) {
      if (!refundLine.salesOrderLineId) continue
      refundedByLine.set(
        refundLine.salesOrderLineId,
        (refundedByLine.get(refundLine.salesOrderLineId) ?? new Prisma.Decimal(0)).add(toDecimal(refundLine.qty)),
      )
    }

    const lines = zeroDemand ? [] : so.lines.filter((line) => line.productId).map((line) => {
      const committed = committedByLine.get(line.id) ?? new Prisma.Decimal(0)
      const refunded = refundedByLine.get(line.id) ?? new Prisma.Decimal(0)
      return {
        id: line.id,
        productId: line.productId!,
        sku: line.sku ?? line.productId!,
        qty: Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committed).sub(refunded)),
      }
    }).filter((line) => line.qty.gt(0))

    // o3d-kouj: FEASIBILITY AND EXPANSION NOW COME FROM ONE SOURCE — the line's RESOLVED requirement
    // set, which is its pinned snapshot when it has one and the current graph when it does not.
    // Asking `getFulfillmentAvailableQtyDecimal` here would re-walk the CURRENT graph, so a line
    // pinned to an older recipe would have its feasibility decided by one kit and its rows written
    // from another: the allocator would authorise three kits' worth of a recipe it is not about to
    // write. See `availableQtyFromRequirements` for the one place the two forms also differ on a
    // diamond graph, and why the requirement set is the correct side of that difference.
    const lineRequirements = (lineId: string) => requirementsByLine.get(lineId) ?? []

    const lineOptions = new Map<string, string[]>()
    for (const line of lines) {
      const options: string[] = []
      for (const warehouse of sorted) {
        const avail = availableQtyFromRequirements(lineRequirements(line.id), warehouse.id, stockMap)
        if (avail.gte(line.qty)) options.push(warehouse.id)
      }
      lineOptions.set(line.id, options)
    }

    const forcedWarehouses = new Set<string>()
    for (const [, options] of lineOptions) {
      if (options.length === 1) forcedWarehouses.add(options[0])
    }

    const nextAllocationRows: AllocationRowInput[] = []
    const tempStock = cloneAvailableStockMap(stockMap)

    for (const line of lines) {
      const options = lineOptions.get(line.id) ?? []
      let bestWh: string | null = null
      let remaining = line.qty

      if (options.length > 0) {
        const forcedOption = options.find((warehouseId) => forcedWarehouses.has(warehouseId))
        bestWh = forcedOption ?? options[0]
      }

      if (bestWh) {
        const avail = availableQtyFromRequirements(lineRequirements(line.id), bestWh, tempStock)
        const allocQty = Prisma.Decimal.min(remaining, avail)
        if (allocQty.gt(ALLOCATION_EPSILON_DECIMAL)) {
          const requirements = scaleFulfillmentRequirements(lineRequirements(line.id), allocQty)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: bestWh, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, bestWh, 'reserve')
          remaining = remaining.sub(allocQty)
        }
      }

      if (remaining.gt(ALLOCATION_EPSILON_DECIMAL)) {
        for (const warehouse of sorted) {
          if (remaining.lte(ALLOCATION_EPSILON_DECIMAL)) break
          if (bestWh && warehouse.id === bestWh) continue
          const avail = availableQtyFromRequirements(lineRequirements(line.id), warehouse.id, tempStock)
          if (avail.lte(ALLOCATION_EPSILON_DECIMAL)) continue
          const allocQty = Prisma.Decimal.min(remaining, avail)
          const requirements = scaleFulfillmentRequirements(lineRequirements(line.id), allocQty)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: warehouse.id, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, warehouse.id, 'reserve')
          remaining = remaining.sub(allocQty)
        }
      }
    }

    // NOT canonicalised to the persisted scale here — three attempts at that failed, and the
    // reasons are worth keeping (o3d-i4qd):
    //
    //   - ROUND_HALF_UP rounds UP, but feasibility was decided against the UNROUNDED value, so
    //     the row can claim more than was proven available: a 0.999960 residual becomes 1.0000
    //     and violates the reservedQty <= quantity constraint.
    //   - flooring each row INDEPENDENTLY breaks the KIT invariant. Components of one kit are a
    //     COUPLED, proportional set, and validateAllocationIntegrity enforces that to 1e-6.
    //     Flooring 0.11108889 -> 0.1110 while 0.3333 stays exact makes the two disagree about
    //     how many kits they represent, and shipment confirmation then refuses the order with
    //     "must keep bundle components in matching quantities". Excluding a sub-scale component
    //     while keeping its siblings is the same corruption by another route.
    //
    // Doing it correctly means canonicalising each (line, warehouse) fulfilment set ATOMICALLY:
    // derive one representable coverage, regenerate every component from it, verify integrity
    // BEFORE persisting, and drop the whole set — reserving none of it — if no proportional
    // representation exists. That is o3d-i4qd, and it is a redesign rather than a rounding call.
    //
    // Leaving it unrounded is the PRE-EXISTING behaviour: the column rounds on write, so the
    // reservation drift o3d-i4qd describes remains, and the unchanged-set check below simply does
    // not fire for a nested KIT whose expanded factor is unrepresentable. Both are unchanged from
    // before this branch — no new breakage, and the short-circuit still fires for every ordinary
    // line, which is the overwhelming majority.

    // The OUTSTANDING allocation: demand this run still had to place, and therefore the only part
    // of the persisted set the allocator was free to choose. The backorder report and the status
    // promotion read it, because both are about work still to do.
    const nextAllocations = mergeAllocationRows(nextAllocationRows)

    // o3d-4kfh — THE CONTRACT. `OrderAllocation.qty` is the order's WHOLE claim on that
    // (line, warehouse, product): outstanding demand PLUS every committed shipment line, retained
    // through pick, pack and dispatch. Two readings are derived from it, and both are subtractions
    // of a shipment set the row is guaranteed to cover:
    //
    //   live reservation   = qty − SHIPPED          (reservedQty is decremented only there)
    //   open (unshipped)   = qty − non-PENDING      (what still has to be picked and shipped)
    //
    // Dispatch decrements reservedQty and deliberately keeps the row (shipment-service, and the
    // contract note in refund-service). Every other consumer already reads it that way:
    // confirmSalesOrderShipments derives its remaining quantity as `alloc.qty − committed`, the
    // backorder-demand report as `alloc.qty − committed`, and the reservation breakdown plus the
    // `stock_reserved_source_mismatch` invariant as `GREATEST(oa.qty − shipped, 0)`.
    //
    // The one place that broke the contract was HERE: demand is netted by committed shipments, so
    // a rewrite shrank the rows to the undispatched remainder. From that moment neither reading is
    // recoverable from the row, and nothing in it says which one applies. That is not a formula
    // you can fix — it is an ambiguity you have to remove, by writing rows that cover the
    // commitments again.
    //
    // Retention is over the COMMITTED set, not the dispatched one. Retaining only dispatch would
    // rebuild the same bug one status earlier: a PICKING shipment is netted out of demand but has
    // released NO reservation, so a row shrunk to the outstanding remainder would under-state this
    // order's live reservation by the picked quantity — released short here, and released again by
    // the dispatch that follows.
    //
    // o3d-4kfh r6 (Codex finding 2): CANONICALISED TO THE PERSISTED SCALE, once, here.
    //
    // `OrderAllocation.qty` is `Decimal(12,4)`. Everything downstream reads the STORED row, so a
    // computed 0.33338 is not a quantity IMS has — it is a quantity IMS is about to round to
    // 0.3334. Carrying the unrounded value past this point is what let the equality test, the
    // reservation delta and the persisted row be three different numbers: reservedQty received
    // 0.333380 while the row held 0.3334, the exact comparison then reported a change on every
    // subsequent run, and that rewrite's release of the persisted 0.3334 either failed closed (this
    // order only held 0.33338) or took 0.00002 out of another order sharing the scope — the exact
    // theft this branch exists to stop.
    //
    // Rounded AFTER the merge, so a scope receiving several contributions rounds its TOTAL once
    // rather than accumulating a rounding error per contribution.
    const persistedAllocations = mergeAllocationRows([
      ...nextAllocationRows,
      ...committedAllocationLines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        warehouseId: line.warehouseId,
        qty: line.qty,
      })),
    ]).map((row) => ({ ...row, qty: canonicalAllocationQty(row.qty) }))

    const existingAllocs = await tx.orderAllocation.findMany({
      where: { orderId },
      // o3d-4kfh r7 (Codex finding 3): the STAMP is selected too, so the unchanged branch below can
      // tell "identical rows, current recipe" from "identical rows, stale recipe" — which are the
      // same set of numbers and completely different states of the order.
      // o3d-0i5y r8: and the RECORD, because a rewrite that moves a scope has to carry it. Selecting
      // the quantities without it is what let the allocator delete Group A2's posted evidence and
      // hand the same units back to be posted again — see `planAccountedRecordCarryOver`.
      select: {
        lineId: true,
        productId: true,
        warehouseId: true,
        qty: true,
        fulfillmentGraphVersion: true,
        costLayerSnapshot: true,
      },
    })

    // o3d-i5it: when the computed set is identical to the persisted one, write NOTHING.
    //
    // The reset + release/delete/recreate/reserve cycle used to run unconditionally. That was
    // tolerable while a stock event was the only driver. The o3d-9lx sweep rotates every 15
    // minutes and selects every order with outstanding demand — including permanent partial
    // backorders that cannot improve because no more stock exists — so each rotation destructively
    // rewrote them.
    //
    // The damaging part is the accounting reset: for an ALLOCATED partial backorder already
    // processed by Group A2, clearing inventoryAllocatedDate and the cost snapshots lets the next
    // daily batch stage and post the SAME inventory reclassification again, and AccountingSyncLog
    // has no uniqueness constraint that would stop the later-dated journal. Duplicate journals, not
    // merely churn. Redundant storefront syncs and allocation activity came with it.
    //
    // Only the WRITES are skipped. The backorder report, the status promotion and the return value
    // are all still computed from in-memory state, so an unchanged run reports exactly what a
    // changed one would — callers cannot tell the difference except that nothing moved.
    // o3d-4kfh: surface an existing reservedQty shortfall, but do NOT force a rewrite for it.
    //
    // I first assumed the unconditional cycle repaired such a row as a side effect, and that
    // skipping it was therefore a regression. It does not: the cycle RELEASES this order's own
    // quantity and then RESERVES the same quantity back, which is a no-op on the discrepancy —
    // release 2 from a reservedQty of 0 and re-reserve 2 ends exactly where it started. Forcing
    // the rewrite would reintroduce the perpetual churn o3d-i5it removed and fix nothing.
    //
    // Compared against the order's LIVE reservation (residuals), so a dispatched order — where
    // retained rows legitimately exceed reservedQty — no longer reports a phantom shortfall.
    const underReserved = findUnderReservedScopes(stockLevels, ownReservationRows)
    if (underReserved.length > 0) {
      console.error(
        `[allocation-service] order ${orderId}: reservedQty is BELOW this order's own allocations for `
        + `${underReserved.map((scope) => `${scope.productId}@${scope.warehouseId}`).join(', ')} — `
        + 'stock this order believes it holds is available to another. Neither allocating nor '
        + 'short-circuiting repairs this; it needs reservation reconciliation (o3d-4kfh).',
      )
    }

    // Compared in PERSISTED space (retained commitments included), because that is what the rows
    // hold.
    //
    // o3d-4kfh — what this does NOT do: repair a row written under the pre-contract shape (shrunk
    // to the undispatched remainder after a dispatch). Such a row reads as residual 0 while the
    // order still holds a live reservation for it, and nothing here can tell that apart from
    // another order holding the same units — reservedQty is an aggregate with no per-holder
    // ledger. Either outcome is wrong: if the recomputed set matches, the short-circuit fires and
    // the row is left as it is; if it differs, the rewrite releases the under-stated residual and
    // reserves the full one, adding reservation rather than moving it. Neither is repaired here,
    // and no cheap guard can be: the repair is a recompute of reservedQty from every live
    // reservation source for the scope, which `invariants.ts`
    // (`stock_reserved_source_mismatch`) is the census for. IMS has no production data, and the
    // service is a single systemd unit restarted in place (deploy/systemd/ims-stage.service —
    // Type=simple, one instance), so no rolling deployment can run the two shapes against one
    // database and produce such a row after this ships.
    const unchanged = allocationSetsMatch(existingAllocs, persistedAllocations)

    let pendingShipmentReconciliation = EMPTY_PENDING_SHIPMENT_RECONCILIATION

    if (!unchanged) {
      // Reached only for a real modification, so the accounting reset — and its posted-shipment
      // guard — applies to an actual allocation change rather than to a no-op re-run.
      //
      // o3d-0i5y r4: THE SET IS DECLARED, so a journaled order can be re-allocated. The guard no
      // longer refuses every change on an order Group B has posted; it checks that this exact set
      // still covers what was posted. `persistedAllocations` re-adds every committed shipment line
      // — journaled ones included — so the residual rebuild satisfies it by construction, which is
      // what makes the r1–r3 remedy reachable from a part-despatched, part-posted order.
      // o3d-0i5y r8: computed BEFORE the first write, from the rows as they still stand, and used
      // twice — by the reset to decide whether anything is genuinely unaccounted, and by the
      // rewrite below to put each record on the row that inherits its units.
      // o3d-0i5y r9: and it says what the new set CANNOT hold, which is a debit to reverse rather
      // than a record to file — see `reverseOrphanedAllocationPosting`.
      // o3d-0i5y r11 (Codex round 11, finding 1, applied to the fourth caller of this rule): THE
      // PLAN IS DRAWN FROM THE ROWS AS LOCKED, not from `existingAllocs`.
      //
      // Everything the write does with a record — trimming a kept-but-shrunk scope, moving a dropped
      // scope's record onto the scopes that inherit its units — REWRITES the entries it read. The
      // sales-order lock this pass holds does not cover `order_allocations`, and
      // `updateSnapshotsForCostLayerChange` writes them without it (it selects by cost layer, across
      // every table carrying a snapshot, because it does not know which orders it will touch). So a
      // landed cost landing between `existingAllocs` and the rewrite below was written straight back
      // out at its old `unitCostBase`, and Group B then relieved those units at a cost the ledger had
      // already corrected — the same shape r10 fixed in Group A2 and r11 fixed in the manual editor.
      //
      // ONE plan, from the locked base, feeding both the un-stage decision and the write: the reset
      // asks a QUANTITY question, which a revaluation cannot move, so drawing it from the same plan
      // keeps a single notion of where each record lives rather than two that can drift.
      const lockedRecordBase = await lockAccountedRecordsForOrder(tx, orderId)
      assertAccountedRecordBaseUnmoved(existingAllocs, lockedRecordBase)
      const { records: accountedRecords, orphaned: orphanedRecord } = planAccountedRecordCarryOver(
        lockedRecordBase,
        persistedAllocations,
      )

      await resetAllocationAccountingIfStaged(tx, orderId, {
        nextAllocations: persistedAllocations,
        accountedRecords,
      })

      // o3d-4kfh: release the RESIDUAL of the persisted rows, not their retained quantity.
      //
      // Worked example (the bug this replaces). Product P @ W holds 13 units, reservedQty 13:
      // order A allocated 10, order B allocated 3. Dispatch 5 of A -> reservedQty 8, and A's row
      // still says 10 because dispatch retains it. Re-allocating A recomputes demand net of the
      // dispatch, so the set changes and this branch runs. Releasing the raw 10 against a
      // reservedQty of 8 matched nothing, the old floor branch zeroed the WHOLE scope, and B's 3
      // reserved units vanished without B ever being touched. Releasing the residual (10 - 5 = 5)
      // takes reservedQty 8 -> 3, the re-reserve below puts A's 5 back, and B keeps its 3.
      await applyAllocationReservationDelta(
        tx,
        residualAllocationRows(existingAllocs, dispatchedAllocationLines),
        'release',
      )
      // o3d-0i5y r4 — THE REWRITE KEEPS THE ROWS IT IS KEEPING.
      //
      // This was `deleteMany({ orderId })` followed by a `create` per row. Every row therefore got
      // a NEW `id` even when its (line, warehouse, product) and quantity were untouched, and that
      // id is not decoration: a dispatched shipment line's `costLayerSnapshot` carries it as
      // `orderAllocationId`, and `refund-service` uses that reference to relieve the allocation
      // cost basis by the quantity that already shipped. A dangling reference relieves nothing, so
      // the next refund reverses allocation cost for units it had already reversed through the
      // shipment — over-reversal, silently, on any partly-dispatched order that gets re-allocated.
      // The blanket journaled refusal hid half of this and never covered the SHIPPED-but-unjournaled
      // half at all.
      //
      // So the rewrite is reconciled by key instead: rows the new set no longer contains are
      // deleted, rows it still contains are UPDATED in place (id and `costLayerSnapshot` intact),
      // and only genuinely new scopes are created. The old behaviour is the limiting case of this
      // one — when every key changes, every row is deleted and every row created — so there is
      // still ONE rule, not a journaled path and an ordinary path that can drift apart.
      const existingByScopeKey = new Map(existingAllocs.map((row) => [allocationScopeKey(row), row]))
      const nextByScopeKey = new Map(persistedAllocations.map((row) => [allocationScopeKey(row), row]))

      for (const existing of existingAllocs) {
        if (nextByScopeKey.has(allocationScopeKey(existing))) continue
        await tx.orderAllocation.deleteMany({
          where: {
            orderId,
            lineId: existing.lineId,
            productId: existing.productId,
            warehouseId: existing.warehouseId,
          },
        })
      }

      for (const alloc of persistedAllocations) {
        // o3d-4kfh r6: the graph version THIS run expanded, from the same statement as the
        // components. Commitment and dispatch refuse when the product has moved past it.
        const fulfillmentGraphVersion = graphVersionByLine.get(alloc.lineId) ?? 0
        // o3d-0i5y r8: a record that arrived here from a scope this rewrite is dropping — a
        // warehouse move — is WRITTEN onto the row that now holds those units. `write` is null for a
        // row that already carries its own record, which is then left exactly as it is: re-writing
        // it would serialize a value nothing asked to change.
        const carriedRecord = accountedRecords.get(allocationScopeKey(alloc))?.write
        if (existingByScopeKey.has(allocationScopeKey(alloc))) {
          await tx.orderAllocation.updateMany({
            where: {
              orderId,
              lineId: alloc.lineId,
              productId: alloc.productId,
              warehouseId: alloc.warehouseId,
            },
            data: {
              qty: alloc.qty,
              fulfillmentGraphVersion,
              ...(carriedRecord ? { costLayerSnapshot: carriedRecord as Prisma.InputJsonValue } : {}),
            },
          })
          continue
        }
        await tx.orderAllocation.create({
          data: {
            orderId,
            lineId: alloc.lineId,
            productId: alloc.productId,
            warehouseId: alloc.warehouseId,
            qty: alloc.qty,
            fulfillmentGraphVersion,
            ...(carriedRecord ? { costLayerSnapshot: carriedRecord as Prisma.InputJsonValue } : {}),
          },
        })
      }

      // -------------------------------------------------------------------------------------
      // o3d-kouj: PIN THE RECIPE ONTO EVERY LINE THIS RUN JUST PUT IN FLIGHT.
      //
      // Written from the SAME graph map the rows above were expanded from, in the SAME transaction,
      // under the SAME order lock — so the snapshot and the rows cannot describe different kits.
      //
      // Only lines that ACTUALLY RECEIVED A ROW are pinned, and only inside this `!unchanged`
      // branch. Both restrictions exist for the same reason the branch itself does (o3d-i5it): the
      // reallocation sweep rotates every fifteen minutes over every order with outstanding demand,
      // including permanent backorders that can never improve. Pinning a line that got no rows
      // would be a write on every rotation, forever, for a line holding nothing — and it would
      // freeze a recipe for an order that has committed to nothing, which is the opposite of what
      // the capturable rule is for.
      //
      // A capturable line that receives a row necessarily CHANGES the set (it held no allocation
      // row before — that is what made it capturable), so there is no reachable case where a line
      // acquires its first row and the short-circuit skips the pin.
      // -------------------------------------------------------------------------------------
      const pinnedLineIds = new Set(
        persistedAllocations
          .map((alloc) => alloc.lineId)
          .filter((lineId) => capturableLineIds.has(lineId)),
      )
      for (const lineId of pinnedLineIds) {
        const productId = resolvableLineById.get(lineId)?.productId
        if (!productId) continue
        await tx.salesOrderLine.update({
          where: { id: lineId },
          data: {
            fulfillmentRequirements: captureFulfillmentRequirementSnapshot(productId, graph) as never,
          },
        })
      }

      // ...and drop the pin from any line this run left holding NOTHING. The delete/recreate above
      // can legitimately end with a line that had rows before and has none now (its stock went to a
      // line with older demand, or the availability vanished). That line is capturable again, so the
      // next run will expand the current graph for it — and until then every reader would be
      // answering from the pin it no longer has any commitment behind (o3d-kouj).
      await clearDormantFulfillmentPinsInTx(tx, orderId)

      // o3d-0i5y r9: raised AFTER the rows are written, so the journal and the state it describes
      // commit together — and inside this transaction, under the order row lock this path already
      // holds, which is what `queueAccountingSyncTx` requires of an order-scoped enqueue.
      await reverseOrphanedAllocationPosting(tx, orderId, orphanedRecord)

      // o3d-4kfh r6 (Codex finding 2): THE RESERVE DELTA COMES FROM THE ROWS AS PERSISTED.
      //
      // Not from the in-memory set, even though it was canonicalised above — the database is the
      // authority on what its own column stored, and the row is what every later release will read.
      // Deriving the reserve from anything else is the same class of mistake r5 fixed in the draft
      // reconciler and left in place here: it makes `reservedQty` and `OrderAllocation` two
      // different books that have to be reconciled by hand afterwards, and the reconciliation is
      // what steals from other orders in the shared (product, warehouse) aggregate.
      //
      // Still the RESIDUAL of those rows: the retained dispatch in them was already given back by
      // the dispatch itself and must not be reserved a second time, while the retained PICK/PACK
      // was never given back and must not be dropped.
      const writtenAllocations = await tx.orderAllocation.findMany({
        where: { orderId },
        select: { lineId: true, productId: true, warehouseId: true, qty: true },
      })
      const reservationRows = residualAllocationRows(writtenAllocations, dispatchedAllocationLines)
      await applyAllocationReservationDelta(
        tx,
        reservationRows.map((alloc) => ({
          productId: alloc.productId,
          warehouseId: alloc.warehouseId,
          qty: alloc.qty,
        })),
        'reserve',
      )

      // o3d-4kfh r3: DROP THE PENDING DRAFTS THIS REWRITE JUST INVALIDATED.
      //
      // The rows a PENDING shipment was generated from have just been deleted and rewritten,
      // possibly in a different warehouse or at a different quantity. A draft the new set no longer
      // covers is the same latent defect the deallocation path had: nothing refuses it while it is
      // PENDING, and `PENDING -> PICKING` would then turn it into a commitment with no allocation
      // behind it.
      //
      // Only the INVALIDATED ones. A draft the new set still covers is untouched — deleting every
      // PENDING shipment on any re-allocation would throw away the tracking number and shipping
      // service an operator had already typed onto it, on runs (the 15-minute reallocation sweep,
      // a stock-event re-run) that changed nothing about that warehouse.
      //
      // o3d-4kfh r4: the rule now lives in ONE place (`reconcilePendingShipments`) and all four
      // mutation paths call it.
      //
      // o3d-4kfh r5 (Codex finding 3): AND IT RE-READS. This call used to hand over the in-memory
      // `persistedAllocations` on the grounds that the rows had just been written from them. They
      // had not been written FAITHFULLY: `OrderAllocation.qty` is Decimal(12,4), so a fractional
      // KIT quantity of 0.33335 lands as 0.3334. Reconciling the stored 0.3334 draft against the
      // in-memory 0.33335 showed a 0.00005 shortage — fifty times the 0.000001 epsilon — and
      // deleted a draft the persisted row backed exactly, along with any label on it. The rounded
      // rows are the only ones Start Picking and dispatch will ever see, so they are the only ones
      // worth judging against.
      pendingShipmentReconciliation = await reconcilePendingShipments(tx, orderId, {
        cause: 'a re-allocation of the order',
        userId: input.userId ?? null,
      })
    } else {
      // o3d-4kfh r6 (Codex finding 3): THE UNCHANGED PATH RECONCILES TOO.
      //
      // r5 skipped it here, on the reasoning that "a run that rewrote nothing cannot have
      // invalidated a draft". True and irrelevant: the draft may have been invalidated EARLIER, by
      // a mutation whose own reconciliation was not reached, by a row an operator edited through a
      // path that predates the shared rule, or by a shipment that committed after the draft was
      // raised. The widened backorder allocator selects draft-bearing orders, computes an identical
      // set, and — under r5 — left that invalid draft in place for Start Picking or a WMS
      // transition to fail on, instead of the allocator repairing it. The claim that "no invalid
      // draft survives a mutation that invalidated it" was true; the claim it was standing in for,
      // that no invalid draft survives an allocation run, was false.
      //
      // The o3d-i5it churn property is preserved exactly, because `reconcilePendingShipments` is
      // read-only when nothing is unbacked: it returns immediately when the order has no drafts,
      // and writes neither the audit row nor the delete when every draft is fully backed. An
      // unchanged, fully-backed order therefore still writes NOTHING — no accounting reset, no
      // allocation churn, no reservation movement, no audit noise — which is what the 15-minute
      // sweep needed. The cost is at most two extra indexed reads on an order that has drafts.
      //
      // The cause is worded for what actually happened: this run changed nothing, so whatever
      // unbacked the draft came before it.
      pendingShipmentReconciliation = await reconcilePendingShipments(tx, orderId, {
        cause: 'an earlier allocation change (this re-allocation computed the same set)',
        userId: input.userId ?? null,
      })

      // o3d-4kfh r7 (Codex finding 3): AND IT RE-STAMPS.
      //
      // `allocationSetsMatch` compares scope and quantity, nothing else — deliberately, because
      // that is the question o3d-i5it asks ("would a rewrite move anything?"). But a recipe change
      // can leave the expanded set NUMERICALLY IDENTICAL: components reordered, an equivalent
      // rewrite, a sub-kit inlined at the same factors, or simply a rescale the order has no stock
      // to follow. The stamp still moved, so every later confirmation and shipment transition
      // refused the order — and the refusal's advice is "re-allocate this order", which took this
      // branch and wrote nothing. An advertised exit that silently no-ops is the same defect class
      // as telling an operator to dispatch a cancelled order's shipment: the message names an
      // action that cannot clear what it is offered for.
      //
      // WHY RE-STAMPING IS SOUND HERE, and is not "blessing rows nobody checked". This branch is
      // reached only because the allocator has just recomputed the whole set FROM THE CURRENT
      // GRAPH (`graph`, expanded into `nextAllocationRows` a few dozen lines above) and the result
      // equals what is persisted. The rows therefore ARE the current graph's expansion of current
      // demand; the stamp was simply the only part of them still describing the old one. A set the
      // current recipe does NOT reproduce cannot get here — it takes the rewrite branch, which
      // stamps at creation.
      //
      // NOT CHURN, and this is load-bearing for o3d-i5it. The update is issued only for lines whose
      // stamp actually differs, so the ordinary unchanged run — the 15-minute sweep over permanent
      // partial backorders — still performs no write at all: no accounting reset, no delete /
      // recreate, no reservation movement, no storefront sync, no audit row. `syncProductIds` stays
      // empty because nothing about the stock position moved; only the row's account of which
      // recipe it came from did.
      const restampByLine = new Map<string, number>()
      for (const row of existingAllocs) {
        const expected = graphVersionByLine.get(row.lineId) ?? 0
        if ((row.fulfillmentGraphVersion ?? 0) === expected) continue
        restampByLine.set(row.lineId, expected)
      }
      for (const [lineId, graphVersion] of restampByLine) {
        await tx.orderAllocation.updateMany({
          // Scoped to the line, and to the rows that are actually behind — an updateMany that
          // rewrote already-current rows would be a write on an unchanged order.
          where: { orderId, lineId, fulfillmentGraphVersion: { not: graphVersion } },
          data: { fulfillmentGraphVersion: graphVersion },
        })
      }
    }

    // Promote to ALLOCATED only off the UNDER-LOCK status. Deciding on the stale pre-lock so.status
    // is how a concurrent PROCESSING→ON_HOLD (or →CANCELLED) got resumed to ALLOCATED off a value
    // that was no longer true (o3d-2s8, Codex review of #496). ON_HOLD/CANCELLED are not in the set,
    // so a held or cancelled order keeps its status; it is simply not un-paused by allocation.
    if (nextAllocations.length > 0 && ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING'].includes(lockedStatus)) {
      const transition = validateSalesOrderStatusTransition(lockedStatus, 'ALLOCATED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: 'ALLOCATED' } })
    }

    const report = buildBackorderReport({
      // Demand is net of refunds here too, so refunded units aren't reported as
      // unallocated/backordered (which would otherwise mark the result unsuccessful).
      //
      // zeroDemand short-circuits to 0 (o3d-754w). CANCELLED and refundStatus=FULL are
      // UNCONDITIONALLY zero demand — that is why `lines` above is emptied for them — but the
      // per-line netting here only subtracts QUANTITY-linked refund lines. A cancelled order, or
      // a FULL refund that is monetary-only, therefore kept its original demand in the report
      // after a perfectly successful DEALLOCATION: every line read as unallocated, and for
      // non-oversell products canLeaveUnallocated then made the whole call return
      // success:false / 'No stock available for allocation'. Misleading failure activity on a
      // correct deallocation, and callers branching on success took the wrong path.
      lines: so.lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        qty: zeroDemand
          ? 0
          : Prisma.Decimal.max(
            new Prisma.Decimal(0),
            toDecimal(line.qty).sub(refundedByLine.get(line.id) ?? new Prisma.Decimal(0)),
          ).toNumber(),
        product: line.product,
      })),
      allocations: nextAllocations.map((allocation) => ({
        lineId: allocation.lineId,
        productId: allocation.productId,
        qty: allocation.qty.toNumber(),
      })),
      shipmentLines: activeShipmentLines,
      requirementsByLine: new Map([...requirementsByLine].map(([lineId, requirements]) => [
        lineId,
        requirements.map((requirement) => ({
          productId: requirement.productId,
          factor: requirement.factor.toNumber(),
        })),
      ])),
    })

    // o3d-67y (Codex r11): resolve the durable release backstop atomically with the reservation mutations, so a
    // crash between this commit and a separate resolve cannot leave the row pending for a redundant re-allocation.
    // NOTE: the storefront stock-sync (enqueueStockSync in autoAllocateOrder) still runs POST-commit and remains
    // best-effort — a crash after commit can lose it. That is a pre-existing, cross-cutting stock-sync durability
    // gap (all allocation flows, non-Woo connectors), tracked separately in o3d-jhq, not resolved here.
    await input.onReconciledInTx?.(tx)

    return {
      nextAllocations,
      // Nothing moved on an unchanged run, so nothing to push to the storefront. Emitting these
      // unconditionally is what produced the endless redundant syncs (o3d-i5it).
      syncProductIds: unchanged ? [] : [...new Set([
        ...existingAllocs.map((alloc) => alloc.productId),
        ...persistedAllocations.map((alloc) => alloc.productId),
      ])],
      unallocatedLines: report.lines
        .filter((line) => line.unallocatedQty > ALLOCATION_EPSILON)
        .map((line) => {
          const sourceLine = so.lines.find((candidate) => candidate.id === line.lineId)
          return {
            lineId: line.lineId,
            productId: line.productId,
            sku: line.sku,
            description: line.description,
            orderedQty: line.orderedQty,
            committedShipmentQty: line.committedShipmentQty,
            allocatedQty: line.allocatedQty,
            unallocatedQty: line.unallocatedQty,
            backorderEligible: line.backorderEligible,
            reason: line.reason,
            componentBlockers: sourceLine?.product?.type === 'KIT' && sourceLine.productId
              ? collectNonOversellLeafComponents(sourceLine.productId, graph)
              : [],
          }
        }),
      unallocatedQty: report.summary.unallocatedQty,
      backorderLineCount: report.lines.filter((line) => line.unallocatedQty > ALLOCATION_EPSILON && line.backorderEligible).length,
      retiredPendingShipments: pendingShipmentReconciliation.retired,
      refused: false as const,
      skippedStatus: null,
    }
  }

  const allocationResult = canRunTransaction(client)
    ? await client.$transaction(runAllocation, ALLOCATION_TX_OPTIONS)
    : await runAllocation(client)

  // o3d-6ab: the under-lock status no longer satisfied requireStatusUnderLock. Nothing was written and
  // the transaction is a no-op, so this is neither a success nor a failure — `error` stays undefined so
  // batch callers don't record it as an allocation failure, and logAttempt stays false so it isn't
  // written to the activity log as an attempt that never happened.
  if (allocationResult.skippedStatus) {
    return {
      success: false,
      syncProductIds: [],
      allocationCount: 0,
      unallocatedLines: [],
      unallocatedQty: 0,
      backorderLineCount: 0,
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
      skipped: true,
      skippedStatus: allocationResult.skippedStatus,
    }
  }

  if (allocationResult.refused) {
    return {
      success: false,
      error: 'Order has existing shipments; reallocation refused',
      syncProductIds: [],
      allocationCount: 0,
      unallocatedLines: [],
      unallocatedQty: 0,
      backorderLineCount: 0,
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
      refused: true,
    }
  }

  const allocationCount = allocationResult.nextAllocations.length
  const canLeaveUnallocated = allocationResult.unallocatedLines.every((line) => line.backorderEligible)
  const success = canLeaveUnallocated
  return {
    success,
    error: success
      ? undefined
      : allocationCount > 0
        ? 'Some lines could not be fully allocated and are not oversell-eligible'
        : 'No stock available for allocation',
    syncProductIds: allocationResult.syncProductIds,
    allocationCount,
    unallocatedLines: allocationResult.unallocatedLines,
    unallocatedQty: allocationResult.unallocatedQty,
    backorderLineCount: allocationResult.backorderLineCount,
    retiredPendingShipments: allocationResult.retiredPendingShipments,
    orderRef,
    isShoppingOrder,
    shipFromWarehouseId: so.shipFromWarehouseId,
    logAttempt: true,
  }
}
