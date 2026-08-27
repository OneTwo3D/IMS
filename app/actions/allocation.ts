'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata } from '@/lib/shopping'
import { decimalToNumber } from '@/lib/decimal'
import {
  availableQtyFromRequirements,
  scaleFulfillmentRequirements,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import {
  captureFulfillmentRequirementSnapshot,
  lineFulfillmentRequirements,
  parseFulfillmentRequirementSnapshot,
  selectCapturableLineIds,
} from '@/lib/products/fulfillment-requirement-snapshot'
import { validateSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import {
  allocateSalesOrder,
  applyAllocationReservationDelta,
  buildAvailableStockMap,
  canonicalAllocationQty,
  clearDormantFulfillmentPinsInTx,
  lockAccountedRecordsForScope,

  floorAvailableStockMapToCanonicalScale,
  lockSalesOrder,
  lockStockLevels,
  refileAccountedRecordsForScope,
  releaseOrderAllocationsForDeallocationInTx,
  resetAllocationAccountingIfStaged,
  validateAllocationIntegrity,
  type AllocationUnallocatedLine,
} from '@/lib/domain/sales/allocation-service'
import {
  EMPTY_PENDING_SHIPMENT_RECONCILIATION,
  reconcilePendingShipments,
  type RetiredPendingShipment,
} from '@/lib/domain/sales/pending-shipment-reconciliation'
import {
  confirmSalesOrderShipments,
  discardCancelledOrderShipmentsInTx,
  reconcileOrderAfterShipment,
  reopenShipmentForRepack,
  transitionShipmentStatus,
  type OrderCompletionAuthority,
} from '@/lib/domain/sales/shipment-service'
import { resolveRefundReservationReleaseOutbox } from '@/lib/domain/sales/refund-reservation-release-outbox'
import {
  allocationScopeKey,
  dispatchedAllocationLines,
  loadCommittedAllocationLines,
  residualAllocationQty,
  sumDispatchedQtyByAllocationScope,
} from '@/lib/domain/inventory/reservation-residual'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

function revalidateSalesAllocationPaths(orderId: string) {
  try {
    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
  } catch (error) {
    // Internal import/cron/test callers can execute this action outside a
    // live Next request store. Allocation has already committed by here, so
    // a cache-refresh failure must not be reported as an allocation failure.
    if (String(error).includes('static generation store missing')) return
    throw error
  }
}

function shouldLogShipmentStatusFailure(error: string): boolean {
  return (
    error.startsWith('Shipment status changed') ||
    error.startsWith('Insufficient physical or reserved stock to dispatch') ||
    error.startsWith('Shipment quantity for line') ||
    // o3d-4kfh r4: the graph-aware committed-coverage refusal, which can now come back from a
    // DISPATCH as well as from Start Picking. Its two messages both begin this way. Without it a
    // dispatch refused because a live KIT edit left the committed set disproportionate would fail
    // silently as far as the activity log is concerned — which is most of what made the original
    // corruption invisible.
    error.startsWith('Shipments for sales line') ||
    error === 'Shipment lines changed. Reload and retry.' ||
    error === 'Shipment has no lines to dispatch'
  )
}

async function logShipmentStatusFailure(
  shipmentId: string,
  targetStatus: string,
  error: string,
) {
  if (!shouldLogShipmentStatusFailure(error)) return
  const shipment = await db.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      orderId: true,
      status: true,
      order: { select: { orderNumber: true, externalOrderNumber: true } },
      warehouse: { select: { code: true } },
    },
  })
  if (!shipment) return

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: shipment.orderId,
    action: 'shipment_status_change_failed',
    tag: 'sales',
    level: 'WARNING',
    description: `Shipment from ${shipment.warehouse.code} for order ${shipment.order.orderNumber ?? shipment.order.externalOrderNumber} could not transition to ${targetStatus}: ${error}`,
    metadata: {
      shipmentId,
      warehouseCode: shipment.warehouse.code,
      currentStatus: shipment.status,
      targetStatus,
      error,
    },
  })
}

// o3d-512h round 3 — a module-local `requireAuth` used to live here, shadowing the
// import of the same name. It called `auth()` and checked only that a user id
// existed: no sessionInvalidReason check (so a session revoked by a password change
// or a role change still passed), no 2FA check (so a session that had not cleared
// its TOTP challenge still passed), and of course no role check. The three exports
// below were credited as guarded by every reviewer and by the scanner, because both
// only ever saw the NAME. They now call the real gate; the shadow is deleted, and
// the scanner's guard rule resolves a callee to its declaration instead of matching
// its name (tests/security/module-graph.ts).

/**
 * o3d-4kfh r5 (Codex finding 7): THE RETIREMENT ENTRY IS NO LONGER WRITTEN HERE.
 *
 * It used to be: every caller deleted the drafts inside its transaction and then wrote the activity
 * entry after the commit, through `logActivity` — which swallows persistence failures by design. A
 * crash or a failed insert in that window permanently lost the shipment id and tracking number an
 * operator needs to cancel a purchased label, which is the exact recovery path this branch
 * advertises. `reconcilePendingShipments` now writes the record through the SAME transaction
 * client, immediately before the delete, so the evidence and the deletion commit together or not at
 * all. Callers pass the `cause` (and their session user) down instead of narrating afterwards.
 *
 * The returned `retiredPendingShipments` are still surfaced to the UI; only the logging moved.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AllocationRow = {
  id: string
  lineId: string
  productId: string
  lineSku: string | null
  lineDescription: string
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  qty: number
  productSku: string
  productName: string
  imageUrl: string | null
  lineQty: number // total qty ordered
}

export type ShipmentRow = {
  id: string
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  status: string
  trackingNumber: string | null
  shippingService: string | null
  shippedAt: string | null
  lines: {
    id: string
    lineId: string
    productId: string
    lineSku: string | null
    lineDescription: string
    qty: number
    productSku: string
    productName: string
    imageUrl: string | null
  }[]
}

export type FulfillmentRequirementRow = {
  lineId: string
  requirements: FulfillmentRequirement[]
}

// ---------------------------------------------------------------------------
// Get allocations for an order
// ---------------------------------------------------------------------------

export async function getOrderAllocations(orderId: string): Promise<AllocationRow[]> {
  await requireInternalUser()
  const rows = await db.orderAllocation.findMany({
    where: { orderId },
    include: {
      warehouse: { select: { code: true, name: true } },
      product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
      line: { select: { qty: true, sku: true, description: true } },
    },
    orderBy: [{ warehouseId: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    lineId: r.lineId,
    productId: r.productId,
    lineSku: r.line.sku,
    lineDescription: r.line.description,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouse.code,
    warehouseName: r.warehouse.name,
    qty: Number(r.qty),
    productSku: r.product.sku,
    productName: r.product.name,
    imageUrl: r.product.imageUrl ?? r.product.parent?.imageUrl ?? null,
    lineQty: Number(r.line.qty),
  }))
}

// ---------------------------------------------------------------------------
// Get shipments for an order
// ---------------------------------------------------------------------------

export async function getOrderShipments(orderId: string): Promise<ShipmentRow[]> {
  await requireInternalUser()
  const rows = await db.shipment.findMany({
    where: { orderId },
    include: {
      warehouse: { select: { code: true, name: true } },
      lines: {
        include: {
          product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
          line: { select: { sku: true, description: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((s) => ({
    id: s.id,
    warehouseId: s.warehouseId,
    warehouseCode: s.warehouse.code,
    warehouseName: s.warehouse.name,
    status: s.status,
    trackingNumber: s.trackingNumber,
    shippingService: s.shippingService,
    shippedAt: s.shippedAt?.toISOString() ?? null,
    lines: s.lines.map((l) => ({
      id: l.id,
      lineId: l.lineId,
      productId: l.productId,
      lineSku: l.line.sku,
      lineDescription: l.line.description,
      qty: Number(l.qty),
      productSku: l.product.sku,
      productName: l.product.name,
      imageUrl: l.product.imageUrl ?? l.product.parent?.imageUrl ?? null,
    })),
  }))
}

export async function getOrderFulfillmentRequirements(
  orderId: string,
): Promise<FulfillmentRequirementRow[]> {
  await requireInternalUser()

  const lines = await db.salesOrderLine.findMany({
    where: { orderId, productId: { not: null } },
    // o3d-kouj: the fulfilment panel shows what the order requires, and for an in-flight order that
    // is the PINNED recipe. Showing the current graph here while the allocator, the picker and the
    // dispatch cap all use the snapshot would make the screen disagree with the refusal messages.
    select: { id: true, productId: true, fulfillmentRequirements: true },
  })

  const graph = await loadFulfillmentProductGraph(
    db,
    lines.map((line) => line.productId!).filter(Boolean),
  )

  return lines.map((line) => ({
    lineId: line.id,
    requirements: lineFulfillmentRequirements(line, graph).map((requirement) => ({
      productId: requirement.productId,
      factor: requirement.factor.toNumber(),
    })),
  }))
}

// ---------------------------------------------------------------------------
// Smart auto-allocation algorithm
// ---------------------------------------------------------------------------

export async function autoAllocateOrder(
  orderId: string,
  options?: {
    internalBypassToken?: symbol
    deferStockSync?: boolean
    refuseIfShipmentsExist?: boolean
    // o3d-4kfh r5: the narrower refusal — decline only on a COMMITTED (non-PENDING) shipment, so an
    // order whose only shipments are PENDING drafts can still be rebuilt (the reconciler retires
    // exactly the drafts the rewrite unbacks). See AllocateSalesOrderInput.refuseIfCommittedShipmentsExist.
    refuseIfCommittedShipmentsExist?: boolean
    // o3d-67y (Codex r11): resolve a durable backstop INSIDE the allocation tx (committed path only) so a
    // redundant re-allocation can't run in the commit→resolve window. See AllocateSalesOrderInput.onReconciledInTx.
    onReconciledInTx?: (tx: Prisma.TransactionClient) => Promise<void>
    // o3d-6ab: for BATCH callers that pick candidates by status outside the order lock. Requires the
    // under-lock status to still be in this set; otherwise allocation is an explicit no-op (skipped:true,
    // committed:false, no error). See AllocateSalesOrderInput.requireStatusUnderLock.
    requireStatusUnderLock?: readonly SalesOrderStatus[]
  },
): Promise<{
  success: boolean
  error?: string
  syncProductIds?: string[]
  allocationCount?: number
  unallocatedLines?: AllocationUnallocatedLine[]
  unallocatedQty?: number
  backorderLineCount?: number
  // o3d-67y: true ONLY when the allocation TRANSACTION threw and rolled back — i.e. reservations were NOT
  // mutated. A plain success:false (a refuseIfShipmentsExist no-op, or a committed backorder/shortage) leaves
  // reservations consistent and must NOT be treated as a stranded-reservation failure by callers.
  failed?: boolean
  // o3d-67y: true when refuseIfShipmentsExist declined because a shipment exists. The reservation was left
  // untouched by design; the shipment-vs-refund reservation reconciliation is tracked separately (o3d-339).
  refused?: boolean
  // o3d-67y: true ONLY when the allocation transaction actually COMMITTED (runAllocation ran) — reservedQty is
  // now reconciled. A pre-transaction exit (no eligible warehouse, permission bail) leaves committed FALSE, so
  // a post-refund backstop must NOT treat it as a completed release (Codex review r3).
  committed?: boolean
  // o3d-6ab: true when requireStatusUnderLock was set and the under-lock status was no longer eligible
  // (e.g. the order moved PROCESSING→ON_HOLD between the caller's selection and the lock). Explicit
  // no-op: committed:false, failed:false, no error — callers must count it as neither done nor failed.
  skipped?: boolean
  skippedStatus?: SalesOrderStatus
}> {
  // o3d-67y: distinguish a rolled-back allocation transaction (reservations stale) from a POST-commit throw
  // (revalidate / stock-sync enqueue) that leaves reservations already correct. Only the former is a
  // stranded-reservation failure; a post-commit throw must NOT raise a false stale-reservation warning.
  let allocationCommitted = false
  try {
    // o3d-6zr2: the acting user for the in-transaction pending-shipment retirement record, which
    // `reconcilePendingShipments` writes through the transaction client and so cannot resolve a
    // session for itself. The internal-bypass callers (the reallocation sweep, stock-event re-runs,
    // the backorder allocator) genuinely have no user and stay null.
    let actingUserId: string | null = null
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      const session = await requirePermission('sales.process')
      actingUserId = session.user.id ?? null
    }
    const allocationResult = await allocateSalesOrder(db, {
      orderId,
      refuseIfShipmentsExist: options?.refuseIfShipmentsExist,
      refuseIfCommittedShipmentsExist: options?.refuseIfCommittedShipmentsExist,
      onReconciledInTx: options?.onReconciledInTx,
      requireStatusUnderLock: options?.requireStatusUnderLock,
      userId: actingUserId,
    })
    allocationCommitted = true

    if (!allocationResult.logAttempt && !allocationResult.success) {
      // No runAllocation commit: an accepted refusal (shipment exists), a stale-status skip (o3d-6ab), or
      // a pre-transaction bail (no eligible warehouse). committed:false so the backstop treats a bail as
      // unreconciled/retryable. A skip carries no `error`, so batch callers don't log it as a failure.
      return {
        success: false,
        error: allocationResult.error,
        syncProductIds: allocationResult.syncProductIds,
        allocationCount: allocationResult.allocationCount,
        unallocatedLines: allocationResult.unallocatedLines,
        unallocatedQty: allocationResult.unallocatedQty,
        backorderLineCount: allocationResult.backorderLineCount,
        refused: allocationResult.refused,
        skipped: allocationResult.skipped,
        skippedStatus: allocationResult.skippedStatus,
        committed: false,
      }
    }

    revalidateSalesAllocationPaths(orderId)
    if (allocationResult.logAttempt && allocationResult.orderRef) {
      const hasUnallocatedDemand = allocationResult.unallocatedQty > 0
      const action = !allocationResult.success
        ? 'allocation_failed'
        : allocationResult.allocationCount > 0
        ? 'allocated'
        : hasUnallocatedDemand
          ? 'backorder_recorded'
          : 'allocation_failed'
      const level = allocationResult.success ? 'INFO' : 'WARNING'
      const description = !allocationResult.success
        ? allocationResult.allocationCount > 0
          ? `Partially allocated stock for order ${allocationResult.orderRef} — ${allocationResult.allocationCount} allocation(s), but some lines are not oversell-eligible`
          : `No stock available to allocate for order ${allocationResult.orderRef}`
        : allocationResult.allocationCount > 0
        ? hasUnallocatedDemand
          ? `Auto-allocated stock for order ${allocationResult.orderRef} — ${allocationResult.allocationCount} allocation(s), ${allocationResult.unallocatedQty} unit(s) left unallocated`
          : `Auto-allocated stock for order ${allocationResult.orderRef} — ${allocationResult.allocationCount} allocation(s)`
        : hasUnallocatedDemand
          ? `Recorded ${allocationResult.unallocatedQty} unit(s) as backorder demand for order ${allocationResult.orderRef}`
          : `No stock available to allocate for order ${allocationResult.orderRef}`
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action,
        tag: 'sales',
        level,
        description,
        metadata: {
          orderNumber: allocationResult.orderRef,
          isShoppingOrder: allocationResult.isShoppingOrder,
          shipFromWarehouseId: allocationResult.shipFromWarehouseId,
          allocations: allocationResult.allocationCount,
          unallocatedQty: allocationResult.unallocatedQty,
          backorderLineCount: allocationResult.backorderLineCount,
          unallocatedLines: allocationResult.unallocatedLines,
        },
      })
    }
    if (!allocationResult.success) {
      if (!options?.deferStockSync && allocationResult.syncProductIds.length > 0) {
        try {
          await enqueueStockSync(
            allocationResult.syncProductIds,
            'IMS_CHANGE',
          )
        } catch (syncError) {
          console.error(syncError)
        }
      }
      return {
        success: false,
        error: allocationResult.error,
        syncProductIds: allocationResult.syncProductIds,
        allocationCount: allocationResult.allocationCount,
        unallocatedLines: allocationResult.unallocatedLines,
        unallocatedQty: allocationResult.unallocatedQty,
        backorderLineCount: allocationResult.backorderLineCount,
        // logAttempt path — runAllocation committed (released refunded units, could not re-reserve all).
        committed: true,
      }
    }
    if (!options?.deferStockSync) {
      try {
        await enqueueStockSync(
          allocationResult.syncProductIds,
          'IMS_CHANGE',
        )
      } catch (syncError) {
        console.error(syncError)
      }
    }
    return {
      success: true,
      syncProductIds: allocationResult.syncProductIds,
      allocationCount: allocationResult.allocationCount,
      unallocatedLines: allocationResult.unallocatedLines,
      unallocatedQty: allocationResult.unallocatedQty,
      backorderLineCount: allocationResult.backorderLineCount,
      committed: true,
    }
  } catch (e) {
    // Flag a genuine stranding ONLY when the allocation transaction did not commit (it threw + rolled back,
    // or permission/setup failed before it ran). A throw AFTER allocationCommitted is a post-commit
    // side-effect failure (cache revalidation, stock-sync enqueue) — reservations are already correct, so it
    // is not a stranded-reservation failure (o3d-67y). committed mirrors that: a post-commit throw is
    // reconciled, a pre-commit throw is not.
    return { success: false, error: String(e), failed: !allocationCommitted, committed: allocationCommitted }
  }
}

// ---------------------------------------------------------------------------
// Manual allocation update
// ---------------------------------------------------------------------------

export async function updateAllocation(
  allocationId: string,
  newWarehouseId: string,
  newQty: number,
): Promise<{ success: boolean; error?: string; retiredPendingShipments?: RetiredPendingShipment[] }> {
  try {
    const session = await requirePermission('sales.process')
    const alloc = await db.orderAllocation.findUnique({
      where: { id: allocationId },
      include: { line: { select: { qty: true } }, order: { select: { orderNumber: true, externalOrderNumber: true } } },
    })
    if (!alloc) return { success: false, error: 'Allocation not found' }
    if (newQty < 0) return { success: false, error: 'Quantity cannot be negative' }

    // Assigned inside the transaction; read only after it commits, so a rolled-back edit reports
    // nothing retired.
    let pendingShipmentReconciliation = EMPTY_PENDING_SHIPMENT_RECONCILIATION

    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, alloc.orderId)

      // o3d-4kfh: RE-READ THE ROW UNDER THE ORDER LOCK, and derive EVERYTHING from that read.
      //
      // The snapshot above is taken outside the transaction, so a concurrent editor of a SIBLING
      // row can commit between it and the lock. Everything below — the availability headroom, the
      // committed floor, and above all the residual this path RELEASES — is derived from the
      // allocation's own quantity, and `reservedQty` is a per-(product, warehouse) aggregate shared
      // with every other order. Releasing a stale quantity is therefore not a lost update on this
      // row, it is theft from the neighbours: rows A=10 and B=3 in one scope, two editors both
      // reading A=10, the first writing A=8 (aggregate 11) and the second releasing its stale 10 and
      // writing A=9 leaves the aggregate at 10 while the rows claim 12 — B silently short by two.
      // The guarded decrement cannot catch it (11 >= 10 succeeds) and validateAllocationIntegrity
      // never looks at stock levels, so it committed silently. Exactly the theft the residual
      // release exists to stop, arriving through a TOCTOU instead of through the floor.
      const locked = await tx.orderAllocation.findUnique({
        where: { id: allocationId },
        select: { id: true, orderId: true, lineId: true, productId: true, warehouseId: true, qty: true },
      })
      if (!locked) {
        throw new Error('This allocation no longer exists — someone else changed it while you were editing. Reload and retry.')
      }
      // Identity or quantity moving under the operator invalidates the numbers the FORM was filled
      // in against, not just the ones this function recomputes, so fail closed rather than silently
      // applying an edit to a row that is no longer the one that was shown.
      if (
        locked.orderId !== alloc.orderId
        || locked.lineId !== alloc.lineId
        || locked.productId !== alloc.productId
        || locked.warehouseId !== alloc.warehouseId
        || !toDecimal(locked.qty).eq(toDecimal(alloc.qty))
      ) {
        throw new Error('This allocation changed while you were editing it. Reload and retry.')
      }

      await resetAllocationAccountingIfStaged(tx, locked.orderId)

      await lockStockLevels(tx, [locked.productId], Array.from(new Set([locked.warehouseId, newWarehouseId])))

      const stockLevels = await tx.stockLevel.findMany({
        where: { productId: locked.productId, warehouseId: { in: Array.from(new Set([locked.warehouseId, newWarehouseId])) } },
        select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
      })
      const stockMap = buildAvailableStockMap(stockLevels).get(locked.productId) ?? new Map()
      // o3d-4kfh r7 (Codex finding 4): QUANTISED TO THE PERSISTED SCALE BEFORE ANYTHING READS IT.
      //
      // `OrderAllocation.qty` is `Decimal(12,4)`, so an operator entry of 0.33335 is not a quantity
      // IMS can hold — it is a quantity Postgres will store as 0.3334. Deciding feasibility, the
      // committed floor, the write and the reservation delta against the unrounded value made those
      // four disagree with each other and with the row: the row held 0.3334 while `reservedQty`
      // received 0.33335, and the next release of that scope either failed closed or took the
      // 0.00005 difference out of another order sharing the (product, warehouse) aggregate. That is
      // the same drift the allocator's own `canonicalAllocationQty` call removed — one definition,
      // used by every producer, or the fix only holds on one path.
      const requestedQty = canonicalAllocationQty(toDecimal(newQty))
      // Both terms are RAW quantities and the dispatched part cancels: the row gives back
      // `qty − dispatched` and takes `newQty − dispatched`, so `newQty <= available + qty` is the
      // same inequality with the dispatch subtracted from both sides. It only holds while the row
      // stays in one warehouse, which the dispatch guard below is what enforces.
      const effectiveAvailable = (stockMap.get(newWarehouseId) ?? toDecimal(0))
        .add(locked.warehouseId === newWarehouseId ? toDecimal(locked.qty) : toDecimal(0))

      if (requestedQty.gt(effectiveAvailable)) {
        throw new Error(`Only ${roundQuantity(effectiveAvailable, 4).toString()} available in this warehouse`)
      }

      // o3d-4kfh: reservations move by RESIDUAL, not by retained allocation quantity. Dispatch
      // decrements reservedQty and keeps the OrderAllocation row, so on a partially dispatched line
      // `locked.qty` is more than this order still holds — releasing it asked the shared
      // (product, warehouse) aggregate for units that belong to other orders. This path has no
      // dispatched-shipment guard at all, so it is fully exposed to that.
      // ONE snapshot, TWO readings (o3d-4kfh). The guards below are about COMMITMENT — every
      // non-PENDING shipment line — while the reservation delta is about DISPATCH, the strict
      // subset that has actually given reservation back. Deriving both from the same query is what
      // stops them disagreeing about a shipment that changes status mid-flight.
      const committedLines = await loadCommittedAllocationLines(tx, locked.orderId)
      const committedByScope = sumDispatchedQtyByAllocationScope(committedLines)
      const dispatchedByScope = sumDispatchedQtyByAllocationScope(
        dispatchedAllocationLines(committedLines),
      )
      const sourceScope = {
        lineId: locked.lineId,
        productId: locked.productId,
        warehouseId: locked.warehouseId,
      }
      const sourceKey = allocationScopeKey(sourceScope)
      const sourceCommitted = committedByScope.get(sourceKey) ?? toDecimal(0)

      // o3d-4kfh: COMMITTED HISTORY DOES NOT MOVE, and it does not shrink.
      //
      // The floor is the COMMITTED quantity, not the dispatched one. A PICKING or PACKED shipment
      // has released no reservation, but it is just as attached to the row it was picked from: a
      // shipment line carries the lineId and productId, its shipment carries the warehouseId, and
      // that (lineId, warehouseId, productId) triple is the only thing tying the two together.
      // Guarding on dispatch alone let a row covering 5 PICKING units be cut to 4 — the reservation
      // fell to 4 while a 5-unit shipment stayed dispatchable, so the dispatch then either failed
      // outright or took its missing unit out of another order's share of the shared
      // (product, warehouse) reservation. validateAllocationIntegrity does not catch it: it only
      // rejects coverage ABOVE the remaining demand, never below the commitment.
      //
      // Relocating or deleting the row strands the commitment the same way: `qty − committed` is
      // then computed at a scope with no shipment (so the destination reserves those units all over
      // again) while the source scope keeps a shipment with no row to net it out of. W1 holding 10
      // with 5 shipped, moved to a W2 row of 4 at newQty 10, released 5, wrote a W2 row of 14 and
      // reserved 10 — 14 live reserved units where 9 is correct, and the W1 history gone. Large
      // enough orders pass validateAllocationIntegrity, so it committed.
      //
      // Refusing is the whole fix. Splitting the row (leave `committed` behind at W1, move the
      // rest) would need an operator answer this action cannot supply — whether `newQty` means the
      // moved remainder or the row total — and the operator can already express either intent with
      // a commitment-sized edit here plus an addAllocation at the destination.
      if (sourceCommitted.gt(0)) {
        if (newWarehouseId !== locked.warehouseId) {
          throw new Error(
            `Cannot move this allocation to another warehouse: ${sourceCommitted.toString()} unit(s) are already `
            + 'committed to shipments picked from it. Committed quantity stays with the warehouse its shipment '
            + 'was raised against — cancel or ship those shipments first, or reduce this allocation to its '
            + 'committed quantity and add a new allocation in the other warehouse instead.',
          )
        }
        if (requestedQty.lt(sourceCommitted)) {
          throw new Error(
            `Cannot reduce this allocation below ${sourceCommitted.toString()}: that many unit(s) are already `
            + 'committed to shipments (picked, packed or shipped) from it, and the allocation row is what the '
            + 'shipment, the reservation residual and the accounting sub-ledger net against.',
          )
        }
      }

      const releaseQty = residualAllocationQty({ ...sourceScope, qty: locked.qty }, dispatchedByScope)

      await applyAllocationReservationDelta(tx, [{
        productId: locked.productId,
        warehouseId: locked.warehouseId,
        qty: releaseQty,
      }], 'release')

      // -------------------------------------------------------------------------------------
      // o3d-0i5y r11 (Codex round 11, finding 1) — WHERE GROUP A2'S POSTED RECORD STANDS, READ
      // UNDER THE LOCK THIS WRITE IS ABOUT TO TAKE ANYWAY.
      //
      // r10 read it at the top of the action and wrote the plan drawn from it at the bottom, which
      // is the same defect r10 had just fixed in Group A2 one file away: the record it plans from is
      // rewritten in place by `updateSnapshotsForCostLayerChange` when a landed cost lands late, and
      // that sweep takes NO sales-order lock (it selects by cost layer, across every table carrying
      // a snapshot). So it commits freely in that window and the plan writes it straight back out.
      //
      //   the row holds 10 units A2 pinned and posted at £4 (£40 into Allocated Inventory,
      //   `postedUnitCostBase` 4.000000). The operator reduces it to 6. Mid-edit a landed cost
      //   reprices that layer £4 -> £5: the correction rewrites `unitCostBase` to 5.000000 on this
      //   very row and posts the £10 to COGS/Inventory, never to Allocated Inventory — which is why
      //   `postedUnitCostBase` stays at £4.
      //   BEFORE r11: the trim is serialized from the £4 array read at the top, so the row is
      //     written back at £4 and the correction is gone. The row says 6 x £4 = £24 where the
      //     corrected pin says 6 x £5 = £30, Group B relieves those six at £4 when they ship, and
      //     £6 of real cost never reaches cost of sales — permanently, and a later refund reverses
      //     the same £6 short.
      //   AFTER r11: the base is re-read under the row lock and the trim lands on the CORRECTED
      //     entry, so the row keeps 6 x £5 = £30. The reversal is unchanged at £16 — 4 units at the
      //     £4 A2 recorded posting — because no revaluation touches `postedUnitCostBase`.
      //
      // TAKEN HERE, NOT AT THE TOP OF THE TRANSACTION, and deliberately: see
      // `lockAccountedRecordsForScope`. This is the statement before the first allocation-row write,
      // which is where these rows are locked in any case, so no new lock ordering is created.
      //
      // Scoped to this (line, product) because that is the grain the carry-over pools at, and the
      // only grain this action can honestly speak for: it edits ONE row, and the units it moves can
      // only ever land on a row of the same line and product. Every other row on the order is
      // untouched, so including them would be inventing a claim about a set nobody declared — the
      // exact thing `resetAllocationAccountingIfStaged`'s undeclared-caller path refuses to do.
      // -------------------------------------------------------------------------------------
      const lockedScopeRecords = await lockAccountedRecordsForScope(
        tx,
        locked.orderId,
        locked.lineId,
        locked.productId,
      )

      // o3d-4kfh r7: the DELETE test is on the quantised value, because that is the quantity the
      // row would hold. `newQty === 0` let 0.00004 through to a row Postgres stores as 0.0000 —
      // an allocation row claiming nothing, which every structural check then reads as a component
      // missing from the set — while the reservation moved by 0.00004.
      if (requestedQty.lte(0)) {
        await tx.orderAllocation.delete({ where: { id: allocationId } })
      } else {
        const mergeTarget = await tx.orderAllocation.findUnique({
          where: {
            lineId_warehouseId_productId: {
              lineId: locked.lineId,
              warehouseId: newWarehouseId,
              productId: locked.productId,
            },
          },
        })
        const isMerge = Boolean(mergeTarget && mergeTarget.id !== allocationId)
        // Quantity already sitting at the destination row, whose reservation was NOT released above.
        const retainedAtDestination = isMerge ? toDecimal(mergeTarget!.qty) : toDecimal(0)

        if (isMerge) {
          await tx.orderAllocation.update({
            where: { id: mergeTarget!.id },
            data: { qty: retainedAtDestination.add(requestedQty) },
          })
          await tx.orderAllocation.delete({ where: { id: allocationId } })
        } else {
          await tx.orderAllocation.update({
            where: { id: allocationId },
            data: { warehouseId: newWarehouseId, qty: requestedQty },
          })
        }

        // Reserve the CHANGE in the destination row's residual. On a merge the destination already
        // holds a live reservation for its own residual; re-reserving its whole residual would
        // double-count it.
        const destinationScope = {
          lineId: locked.lineId,
          productId: locked.productId,
          warehouseId: newWarehouseId,
        }
        // o3d-4kfh r7 (Codex finding 4): the AFTER side comes from the ROW AS PERSISTED, re-read
        // through this transaction — the same rule the allocator follows. `requestedQty` is already
        // quantised, so the two agree; re-reading is what keeps that a property of the database
        // rather than of our arithmetic staying in step with `numeric(12,4)` by hand. The BEFORE
        // side is `retainedAtDestination`, which was itself read from the row.
        const writtenDestination = await tx.orderAllocation.findUnique({
          where: {
            lineId_warehouseId_productId: {
              lineId: locked.lineId,
              warehouseId: newWarehouseId,
              productId: locked.productId,
            },
          },
          select: { qty: true },
        })
        const reserveQty = residualAllocationQty(
          { ...destinationScope, qty: toDecimal(writtenDestination?.qty ?? 0) },
          dispatchedByScope,
        ).sub(residualAllocationQty(
          { ...destinationScope, qty: retainedAtDestination },
          dispatchedByScope,
        ))

        await applyAllocationReservationDelta(tx, [{
          productId: locked.productId,
          warehouseId: newWarehouseId,
          qty: reserveQty,
        }], 'reserve')
      }

      // o3d-4kfh r4: RECONCILE THE DRAFTS THIS EDIT JUST INVALIDATED, in the same transaction.
      //
      // This action had no pending-draft cleanup at all. Reducing an allocation 10 -> 5 left its
      // 10-unit PENDING draft intact and perfectly valid-looking; the very next Start Picking (or a
      // WMS dispatch applied against it) then failed the commitment coverage guard added in r3 —
      // an external fulfilment dead-letter caused by an EARLIER SUCCESSFUL IMS action. Warehouse
      // moves are the same story from the other side: the draft still points at the old warehouse.
      //
      // Runs AFTER the allocation write and reads live state, so what it judges is the post-edit
      // truth. Same shared rule as the allocator, the deallocation teardown and the rebalancer —
      // a draft the edit still backs is left completely alone (including its tracking number).
      pendingShipmentReconciliation = await reconcilePendingShipments(tx, locked.orderId, {
        cause: 'a manual allocation edit',
        userId: session.user.id,
      })

      // o3d-kouj: an edit that took this line's last allocation row away (a reduction to zero, or a
      // merge that emptied the source) leaves its pin dormant — a recipe that certifies nothing, and
      // that the next allocation has already decided not to use. Retired here, so no reader is left
      // answering from it.
      await clearDormantFulfillmentPinsInTx(tx, locked.orderId)

      // -------------------------------------------------------------------------------------
      // o3d-0i5y r10 (Codex round 10, finding 1) — THE MANUAL EDITOR CARRIES AND REVERSES TOO.
      //
      // r9 gave the carry-over and the orphan reversal to `allocateSalesOrder`, the one caller that
      // DECLARES its next set, and left this path out on the reading that an undeclared caller has
      // nothing to declare. That reading was about the STAMP, and it was right about the stamp. It
      // was never right about the record, and this action is the single most direct way a recorded
      // unit leaves an order: an operator types a smaller number into the allocation editor.
      //
      // Worked example — the same shape r9 fixed for the allocator, arriving through the UI:
      //   line L holds 10 units at W1. A2 pinned them at £4 and posted DR Allocated / CR Inventory
      //   £40, stamping `postedUnitCostBase` 4.000000 on the entry.
      //   the operator edits the allocation to 6. Nothing is refused: no shipment is committed.
      //   BEFORE r10: the row keeps a record of 10 units. `unaccountedAllocationQty`'s floor stops
      //     A2 posting them again — and that is all it does. Group B will credit Allocated
      //     Inventory 6 x £4 = £24 when the six ship, no refund ever sees the other four (they were
      //     never invoiced), and £16 of a real debit sits in Allocated Inventory for ever with
      //     Inventory understated by the same £16.
      //   AFTER r10: the record is trimmed to the 6 units the row will hold (£24) and the 4 units
      //     that left the order raise CR Allocated £16.00 / DR Inventory £16.00. Allocated
      //     Inventory holds exactly the £24 Group B will relieve.
      //
      // A reduction to zero is the same thing at its limit: the row is deleted, all 10 units are
      // orphaned, and £40 is reversed. A warehouse MOVE, by contrast, keeps every unit on the
      // order — the carry-over moves the record onto the destination row and there is nothing to
      // reverse, which is exactly what the merge branch above needs, because it DELETES the source
      // row and its record with it.
      //
      // o3d-0i5y r11: the plan is drawn from `lockedScopeRecords` — the base read under the row
      // lock this action holds from before its first row write until commit — and the rows it
      // writes onto are read back AS PERSISTED. One implementation, shared with the rebalancer:
      // see `refileAccountedRecordsForScope`.
      // -------------------------------------------------------------------------------------
      await refileAccountedRecordsForScope(
        tx,
        locked.orderId,
        { lineId: locked.lineId, productId: locked.productId },
        lockedScopeRecords,
      )

      const integrityError = await validateAllocationIntegrity(tx, locked.orderId, [locked.lineId])
      if (integrityError) throw new Error(integrityError)
    }, STOCK_TX_OPTIONS)

    revalidatePath(`/sales/${alloc.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: alloc.orderId,
      action: 'allocation_updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated allocation for order ${alloc.order.orderNumber ?? alloc.order.externalOrderNumber}`,
      metadata: { allocationId, newWarehouseId, newQty },
    })
    try {
      await enqueueStockSync([alloc.productId], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
    return { success: true, retiredPendingShipments: pendingShipmentReconciliation.retired }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Add manual allocation for a line
// ---------------------------------------------------------------------------

export async function addAllocation(
  orderId: string,
  lineId: string,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    if (qty <= 0) return { success: false, error: 'Quantity must be positive' }

    // o3d-kouj: the leaves whose reservedQty this action actually moved, carried OUT of the
    // transaction for the storefront sync below. Re-deriving them from the current graph afterwards
    // would miss a component that the line's PINNED recipe requires and the current recipe no longer
    // mentions — precisely the component whose reservation just changed.
    const reservedLeafProductIds: string[] = []

    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      await resetAllocationAccountingIfStaged(tx, orderId)
      const graph = await loadFulfillmentProductGraph(tx, [productId])

      // o3d-kouj: THE LINE MUST BELONG TO THE ORDER WE LOCKED.
      //
      // `lineId` arrives from the caller and nothing above ties it to `orderId`. The lock is taken on
      // the ORDER, so a lineId belonging to a DIFFERENT order is outside it entirely — and every
      // in-flight fact this action then reads is scoped to the wrong pair: `orderAllocation` is
      // queried by `{ orderId, lineId }` and `shipmentLine` by `{ lineId, shipment: { orderId } }`,
      // so another order's fully-allocated, half-picked line reads as holding NOTHING. It is then
      // judged capturable, and the capture below OVERWRITES the pinned recipe that order was
      // allocated and picked against — while the allocation rows written above attach that foreign
      // line to this order.
      //
      // Scoped in the SELECT rather than checked afterwards, so there is no version of this where
      // the fact is read and the check is forgotten. `findFirst` with both keys: absent means either
      // no such line or not ours, and the two want the same answer — refuse.
      const linePinState = await tx.salesOrderLine.findFirst({
        where: { id: lineId, orderId },
        select: { id: true, productId: true, fulfillmentRequirements: true },
      })
      if (!linePinState) {
        throw new Error(
          `Line ${lineId} does not belong to order ${orderId} — refusing to allocate against it. `
          + 'An allocation is only ever meaningful for a line of the order it is raised on.',
        )
      }
      const [lineAllocations, lineCommittedShipments] = await Promise.all([
        tx.orderAllocation.findMany({ where: { orderId, lineId }, select: { lineId: true } }),
        tx.shipmentLine.findMany({
          where: { lineId, shipment: { orderId, status: { not: 'PENDING' } } },
          select: { lineId: true },
        }),
      ])
      const lineIsCapturable = selectCapturableLineIds({
        lineIds: [lineId],
        lineIdsHoldingAllocations: lineAllocations.map((row) => row.lineId),
        lineIdsHoldingCommittedShipments: lineCommittedShipments.map((row) => row.lineId),
      }).length === 1
      // A capturable line's stored snapshot describes an in-flight life it no longer has, so this
      // action expands the CURRENT graph for it — which is exactly what the capture below records.
      //
      // The product is the CALLER'S `productId`, not the line's, because that is the only product
      // `graph` was loaded for: resolving against a product the graph does not contain would treat
      // it as a leaf. The two disagree only if the caller named a product the line does not
      // reference, and then the pin — captured for the line's own product — simply does not match
      // and the current graph answers, which is what this action did before o3d-kouj.
      const resolvableLine = {
        id: lineId,
        productId,
        fulfillmentRequirements: lineIsCapturable ? null : linePinState.fulfillmentRequirements,
      }
      const lineRequirements = lineFulfillmentRequirements(resolvableLine, graph)

      // o3d-kouj: THE VERSION THESE ROWS WERE EXPANDED FROM — the pin's, whenever the pin is what
      // answered.
      //
      // The column's meaning is fixed and the same rule `allocateSalesOrder` follows: it records the
      // graph version the rows came from, never "the version that happens to be current". A pinned
      // line's rows are expanded from the pin, so stamping the CURRENT version leaves the row
      // claiming a provenance it does not have — and, worse, certifying itself as current: if the
      // pin were ever lost, the CAS (which is skipped per line while a pin exists) would come back
      // and find a row that agrees with a recipe it was never expanded from.
      //
      // `parseFulfillmentRequirementSnapshot` re-reads the same payload `lineFulfillmentRequirements`
      // just resolved through, and it is pure — so the two cannot disagree — and the productId test
      // is the same one the seam applies, because a pin for a different product did not answer here.
      const activePin = lineIsCapturable
        ? null
        : parseFulfillmentRequirementSnapshot(linePinState.fulfillmentRequirements, lineId)
      const expansionGraphVersion = activePin && activePin.productId === productId
        ? activePin.graphVersion
        : graph.get(productId)?.fulfillmentGraphVersion ?? 0

      const leafProductIds = lineRequirements.map((requirement) => requirement.productId)
      await lockStockLevels(tx, leafProductIds, [warehouseId])

      const stockLevels = await tx.stockLevel.findMany({
        where: { productId: { in: leafProductIds }, warehouseId: { in: [warehouseId] } },
        select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
      })
      // o3d-aqke (Codex r1 finding 2): floored to the canonical scale, for the same reason
      // `allocateSalesOrder` floors its own map. `updateAllocation` needs no such floor — the
      // quantity it checks IS the quantity it writes — but this action expands a KIT, so the
      // per-leaf `canonicalAllocationQty` below happens AFTER the feasibility test and can round a
      // leaf half an ulp above the stock the kit-unit test was measured against. The reserve then
      // breaches the VALIDATED `stock_levels_reserved_qty_lte_quantity` constraint and aborts the
      // transaction, which is a crash rather than a refusal: nothing is written, and the operator
      // gets a constraint name instead of "only N available".
      const stockMap = floorAvailableStockMapToCanonicalScale(buildAvailableStockMap(stockLevels))
      // o3d-4kfh r7 (Codex finding 4): quantised BEFORE feasibility, as in `updateAllocation`.
      const requestedQty = canonicalAllocationQty(toDecimal(qty))
      if (requestedQty.lte(0)) {
        throw new Error('Quantity must be at least 0.0001 — allocations are stored to four decimal places')
      }
      const avail = availableQtyFromRequirements(lineRequirements, warehouseId, stockMap)
      if (requestedQty.gt(avail)) throw new Error(`Only ${avail.toString()} available`)
      // o3d-4kfh r7: EVERY LEAF QUANTISED, once, here — the single point the rest of this action
      // reads. A KIT expansion multiplies by component factors, so even a whole-number kit quantity
      // produces leaves the column cannot hold (1 x 0.33335 = 0.33335 -> 0.3334). Writing the
      // unrounded value and reserving the unrounded value left the row and `reservedQty` 0.00005
      // apart on a shared aggregate, which the transaction's own integrity check cannot see because
      // it reads allocation rows and never stock.
      //
      // Rounded per leaf, matching what `allocateSalesOrder` does to its merged rows. It puts a
      // fractional-KIT set marginally out of proportion — 0.5 kits of a 0.3333 component is
      // 0.16665 and the column holds 0.1667 — and that is unavoidable, not a defect in this write:
      // no rounding policy makes an unrepresentable requirement representable. o3d-i4qd made the
      // READERS judge these rows at the scale they are stored at, so `validateAllocationIntegrity`
      // at the end of this action no longer refuses the set this action just wrote. It still fails
      // the action closed on a set that is disproportionate by more than the column's own
      // rounding.
      const requirements = new Map(
        [...scaleFulfillmentRequirements(lineRequirements, requestedQty)]
          .map(([leafProductId, requiredQty]) => [leafProductId, canonicalAllocationQty(requiredQty)] as const),
      )

      // What each scope held BEFORE this action, so the reservation delta below can be the
      // difference between two PERSISTED quantities rather than the number we hoped to add.
      const qtyBeforeByLeaf = new Map<string, Prisma.Decimal>()

      for (const [leafProductId, requiredQty] of requirements) {
        const existing = await tx.orderAllocation.findUnique({
          where: {
            lineId_warehouseId_productId: {
              lineId,
              warehouseId,
              productId: leafProductId,
            },
          },
        })
        qtyBeforeByLeaf.set(leafProductId, toDecimal(existing?.qty ?? 0))

        if (existing) {
          await tx.orderAllocation.update({
            where: { id: existing.id },
            data: { qty: toDecimal(existing.qty).add(requiredQty) },
          })
        } else {
          await tx.orderAllocation.create({
            data: {
              orderId,
              lineId,
              productId: leafProductId,
              warehouseId,
              qty: requiredQty,
              // o3d-4kfh r6: stamp the graph version this expansion came from, out of the SAME
              // statement that loaded the components (`loadFulfillmentProductGraph` above) — or,
              // for a pinned line, the version the PIN records, because the pin is what the
              // expansion came from (o3d-kouj, see `expansionGraphVersion`).
              //
              // The `update` branch above deliberately leaves an existing row's stamp alone. If
              // that stamp is stale the whole row stays stale, `validateAllocationIntegrity` below
              // refuses this action, and the operator is told to re-allocate — which is right:
              // re-stamping a row we only ADDED to would bless the part of it that was expanded
              // from a recipe that no longer exists.
              fulfillmentGraphVersion: expansionGraphVersion,
            },
          })
        }
      }

      // o3d-4kfh r7 (Codex finding 4): THE RESERVE DELTA COMES FROM THE ROWS AS PERSISTED.
      //
      // Same rule as `allocateSalesOrder`: the database is the authority on what its own
      // `numeric(12,4)` column stored, and the stored row is what every later release will read.
      // Reserving the in-memory figure instead is what leaves `reservedQty` and `OrderAllocation`
      // two books that disagree — and the reconciliation of that disagreement is what takes units
      // out of another order's share of the shared (product, warehouse) aggregate.
      // o3d-kouj: pin the recipe now that this line holds rows. Written from the SAME graph the rows
      // above were expanded from, in the same transaction and under the same order lock.
      //
      // Only when the caller's product IS the line's product. `graph` was loaded for the caller's
      // product, so that is the only thing this transaction can honestly capture — and a snapshot
      // recorded under a product the line does not reference is not a pin at all: every reader would
      // see the mismatch, warn, and fall back to the live graph, leaving the line unprotected while
      // its row claims otherwise. Better to leave it unpinned, which is exactly what it was.
      const pinnableProduct = productId === linePinState.productId
      if (lineIsCapturable && requirements.size > 0 && pinnableProduct) {
        await tx.salesOrderLine.update({
          where: { id: lineId },
          data: {
            fulfillmentRequirements: captureFulfillmentRequirementSnapshot(
              resolvableLine.productId,
              graph,
            ) as never,
          },
        })
      } else if (lineIsCapturable && requirements.size > 0) {
        console.warn(
          `[allocation] manual allocation on line ${lineId} named product ${productId} but the line `
          + `references ${linePinState.productId ?? '(none)'} — the line was left unpinned rather than `
          + 'stamped with a recipe that is not about it.',
        )
      }

      reservedLeafProductIds.push(...requirements.keys())

      const writtenRows = await tx.orderAllocation.findMany({
        where: { lineId, warehouseId, productId: { in: [...requirements.keys()] } },
        select: { productId: true, qty: true },
      })
      await applyAllocationReservationDelta(
        tx,
        writtenRows.map((row) => ({
          productId: row.productId,
          warehouseId,
          qty: toDecimal(row.qty).sub(qtyBeforeByLeaf.get(row.productId) ?? toDecimal(0)),
        })).filter((delta) => delta.qty.gt(0)),
        'reserve',
      )

      const integrityError = await validateAllocationIntegrity(tx, orderId, [lineId])
      if (integrityError) throw new Error(integrityError)
    }, STOCK_TX_OPTIONS)

    revalidatePath(`/sales/${orderId}`)
    try {
      await enqueueStockSync([...new Set(reservedLeafProductIds)], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
    return { success: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Deallocate order (release all allocations)
// ---------------------------------------------------------------------------

export async function deallocateOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await requirePermission('sales.process')
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, externalOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const deallocationResult = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      // o3d-4kfh: the DEALLOCATION variant, which refuses outright while any non-PENDING shipment
      // exists rather than releasing the reservation out from under it (and deleting the allocation
      // identity the accounting sub-ledger resolves through).
      const released = await releaseOrderAllocationsForDeallocationInTx(tx, orderId, {
        cause: 'deallocating the order',
        userId: session.user.id,
      })

      // o3d-e2mz r8: THE DEMOTION IS DECIDED ON THE STATUS READ UNDER THIS LOCK, NEVER ON `so.status`.
      //
      // `so` is read at the top of this action, OUTSIDE the transaction and before the lock. Deciding
      // on it and then writing `where: { id: orderId }` — no status predicate — is a check/use race
      // with nothing serialising the two, and CANCELLED is where it hurts: the sales-order state
      // machine has `CANCELLED: []`, no transition out at all, yet an order cancelled between that
      // read and this lock was demoted straight back to PROCESSING. `validateSalesOrderStatusTransition`
      // could not object, because it was being shown the stale ALLOCATED. The order came back to life
      // with its accounting work live again, which is exactly what the cancellation was for.
      const lockedOrder = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      if (!lockedOrder) throw new Error('Order not found')
      if (lockedOrder.status === 'ALLOCATED') {
        // Re-read rather than assume: the guard above has already established there is no
        // non-PENDING shipment under this lock, so this count is 0 by construction. Kept as a
        // belt-and-braces read so the status demotion can never outlive the guard that justifies it.
        const activeShipmentCount = await tx.shipment.count({
          where: { orderId, status: { not: 'PENDING' } },
        })
        if (activeShipmentCount === 0) {
          const transition = validateSalesOrderStatusTransition(lockedOrder.status, 'PROCESSING')
          if (!transition.success) throw new Error(transition.error)
          // Scoped to the status the decision was taken on, so the write cannot land on a row that
          // moved after the read even if the lock were ever lost or not taken.
          await tx.salesOrder.updateMany({ where: { id: orderId, status: 'ALLOCATED' }, data: { status: 'PROCESSING' } })
        }
      }

      return {
        allocs: released.allocations,
        clampedReservationCount: released.clampedReservationCount,
        // o3d-4kfh r3: surfaced because it deletes something the operator can SEE. Deallocation now
        // removes the PENDING draft shipments generated from the rows it is releasing (leaving them
        // behind is what later became a committed shipment with no allocation), and a draft
        // disappearing without a word in the activity log is indistinguishable from a bug.
        deletedPendingShipmentCount: released.deletedPendingShipmentCount,
        // o3d-4kfh r4: and the IDENTITY of each, so the entry below names the shipment and any
        // tracking number it carried rather than just how many vanished.
        retiredPendingShipments: released.retiredPendingShipments,
      }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    if (deallocationResult.clampedReservationCount > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'negative_reserved_qty_clamped',
        tag: 'inventory',
        level: 'WARNING',
        description: `Clamped ${deallocationResult.clampedReservationCount} negative reservation balance(s) while deallocating order ${so.orderNumber ?? so.externalOrderNumber}`,
        metadata: { orderNumber: so.orderNumber ?? so.externalOrderNumber, clampedReservationCount: deallocationResult.clampedReservationCount },
      })
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'deallocated',
      tag: 'sales',
      level: 'INFO',
      description: `Deallocated stock for order ${so.orderNumber ?? so.externalOrderNumber}`
        + (deallocationResult.deletedPendingShipmentCount > 0
          ? ` and deleted ${deallocationResult.deletedPendingShipmentCount} pending shipment(s) drawn from those allocations`
          : ''),
      metadata: {
        orderNumber: so.orderNumber ?? so.externalOrderNumber,
        deletedPendingShipmentCount: deallocationResult.deletedPendingShipmentCount,
      },
    })
    try {
      const syncTargets = [...new Set(deallocationResult.allocs.map((alloc) => alloc.productId))]
      await enqueueStockSync(syncTargets, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Discard the non-dispatched shipments left on a CANCELLED order (o3d-4kfh r6)
// ---------------------------------------------------------------------------

/**
 * The repair path a cancelled order needs when a shipment is still sitting on it.
 *
 * This is the exit the component-graph refusal names for that case, and the reason it can name one
 * at all: dispatching such a shipment is now refused (it would ship goods for a cancelled sale) and
 * cancelling again is not a transition CANCELLED has, so before r6 there was no way out.
 *
 * Idempotent — a cancelled order with nothing left to discard writes nothing and reports zero.
 */
export async function discardCancelledOrderShipments(
  orderId: string,
): Promise<{ success: boolean; error?: string; discardedCount?: number }> {
  try {
    const session = await requirePermission('sales.process')

    const result = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      return discardCancelledOrderShipmentsInTx(tx, orderId, { userId: session.user.id })
    }, STOCK_TX_OPTIONS)

    revalidateSalesAllocationPaths(orderId)
    return { success: true, discardedCount: result.discarded.length }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Reopen a committed (PICKING/PACKED) shipment so it can be rebuilt (o3d-2k5)
// ---------------------------------------------------------------------------

/**
 * The exit the o3d-339 dispatch refusal names, and the reason it can name one at all.
 *
 * A partial refund landing AFTER a shipment was packed leaves the shipment shipping more than
 * remains. `validateActiveShipmentTotalsWithinOrder` refuses that dispatch — correctly; it is the
 * money fix — but `confirmSalesOrderShipments` only replaces PENDING shipments, so nothing could
 * rebuild the packed one, and `releaseReservationsAfterRefund` refuses the reservation release while
 * a shipment exists, so the unrefunded remainder stayed unshippable with its backstop row deferred.
 *
 * THE THREE STEPS, in this order, because each depends on the one before:
 *
 *  1. `reopenShipmentForRepack` reverts the shipment to PENDING under the order lock. Preserves the
 *     tracking number, touches no reservation (see its doc comment for why re-reserving would
 *     double-count), and records the physical un-pack the warehouse now owes as a WARNING.
 *  2. re-allocation with `refuseIfCommittedShipmentsExist` — the NARROW refusal. It is only passable
 *     BECAUSE step 1 turned the last committed shipment into a draft; the strict
 *     `refuseIfShipmentsExist` the refund backstop uses would still decline, which is exactly why
 *     the backstop cron could never heal this on its own. The rebuild nets the refund into
 *     `OrderAllocation`, releases the refunded units' reservation, and `reconcilePendingShipments`
 *     retires the now-unbacked draft, reporting the label it carried.
 *  3. resolving the deferred refund-reservation-release backstop rows INSIDE that allocation
 *     transaction (`onReconciledInTx`, committed path only) — so a crash between commit and resolve
 *     cannot leave a redundant re-allocation queued.
 *
 * The operator then presses "Create Shipments" (the Stock Allocation panel's own button, which
 * calls `confirmAllocations` below), and it builds a fresh shipment at the reduced quantity. That step is deliberately NOT done here: rebuilding is a decision about what goes in
 * the box, and the box has to be physically unpacked first.
 *
 * PERMISSION. `sales.process` — the same permission that already moves a shipment PENDING → PICKING
 * → PACKED and dispatches it. Reopening is strictly less consequential than the dispatch that
 * permission already allows (a dispatch writes stock movements and COGS and is reversed only by a
 * refund or a return), so refusing the undo to the person trusted with the do is not a defensible
 * line. Recorded as a decision, not an inference: if this should be manager-gated instead, it is one
 * `requirePermission` call here, because the reverse edge was deliberately kept out of
 * `SHIPMENT_TRANSITIONS` and there is no other door.
 */
export async function reopenShipmentForRepackAction(
  shipmentId: string,
): Promise<{ success: boolean; error?: string; warning?: string; orderId?: string }> {
  try {
    const session = await requirePermission('sales.process')

    const reopened = await reopenShipmentForRepack(db, shipmentId, { userId: session.user.id })
    if (!reopened.success) return { success: false, error: reopened.error }

    const orderId = reopened.orderId
    // Read BEFORE the allocation call: the resolve runs inside that transaction, and taking a second
    // trip to the database from inside it would widen the window the order lock is held for.
    const refunds = await db.salesOrderRefund.findMany({ where: { orderId }, select: { id: true } })

    const realloc = await autoAllocateOrder(orderId, {
      internalBypassToken: INTERNAL_ACTION_BYPASS,
      refuseIfCommittedShipmentsExist: true,
      onReconciledInTx: async (tx) => {
        for (const refund of refunds) {
          await resolveRefundReservationReleaseOutbox(refund.id, { client: tx })
        }
      },
    })

    revalidateSalesAllocationPaths(orderId)

    // The revert COMMITTED whatever happens next — it is its own transaction — so this reports
    // honestly rather than pretending the whole recovery ran. Each of these leaves the order in a
    // state an operator can still work: the shipment is a draft, and "Create Shipments" rebuilds
    // it. What has NOT happened is the reservation netting, and saying so is the point.
    if (realloc.refused) {
      return {
        success: true,
        orderId,
        warning: `Shipment reopened, but stock could not be re-allocated because order ${reopened.orderRef} still has `
          + 'another committed (picking or packed) shipment. Reopen that one too — or dispatch it — and the '
          + 'refunded units\u2019 reservation will be released then.',
      }
    }
    if (!realloc.success) {
      return {
        success: true,
        orderId,
        warning: `Shipment reopened, but re-allocating order ${reopened.orderRef} did not complete`
          + `${realloc.error ? ` (${realloc.error})` : ''}. The refunded units may still be reserved; `
          + 'run allocation on this order again before rebuilding the shipment.',
      }
    }
    return { success: true, orderId }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Confirm allocations — generates shipments per warehouse
// ---------------------------------------------------------------------------

export async function confirmAllocations(
  orderId: string,
  options?: { internalBypassToken?: symbol },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.process')
    }
    const result = await confirmSalesOrderShipments(db, orderId)

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    if (result.deletedPendingCount > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'pending_shipments_replaced',
        tag: 'sales',
        level: 'INFO',
        description: `Replaced ${result.deletedPendingCount} pending shipment(s) while confirming allocations for order ${result.orderNumber}`,
        metadata: { orderNumber: result.orderNumber, deletedPendingCount: result.deletedPendingCount },
      })
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'allocations_confirmed',
      tag: 'sales',
      level: 'INFO',
      description: `Confirmed allocations for order ${result.orderNumber} — ${result.shipmentCount} shipment(s) created`,
      metadata: {
        orderNumber: result.orderNumber,
        shipmentCount: result.shipmentCount,
        shipments: result.createdShipments,
      },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Update shipment (tracking, status)
// ---------------------------------------------------------------------------

export async function updateShipmentStatus(
  shipmentId: string,
  targetStatus: string,
  extra?: { trackingNumber?: string; shippingService?: string },
  options?: {
    internalBypassToken?: symbol
    /**
     * o3d-0i5y r2: who owns the "is the ORDER fulfilled?" decision for this dispatch — see
     * `OrderCompletionAuthority`. Omitted (the default) means IMS is working the order and the
     * completion check below derives the answer from the shipment rows. `applyExternalFulfillmentUpdate`
     * passes `EXTERNAL`, because the storefront/WMS driving it has already made that decision.
     */
    completionAuthority?: OrderCompletionAuthority
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.process')
    }
    const result = await transitionShipmentStatus(db, {
      shipmentId,
      targetStatus,
      extra,
    })
    if (!result.success) {
      try {
        await logShipmentStatusFailure(shipmentId, targetStatus, result.error)
      } catch (logError) {
        console.warn('Failed to log shipment status transition failure', logError)
      }
      return result
    }

    if (targetStatus === 'SHIPPED') {
      const reconciliation = await reconcileOrderAfterShipment(db, result.shipment, extra, {
        completionAuthority: options?.completionAuthority ?? 'IMS',
      })
      // o3d-0i5y: every shipment raised on this order has now shipped, but the order still owes
      // quantity, so it was deliberately left in its pre-shipment status instead of being declared
      // complete. Only ever set under IMS completion authority — an externally fulfilled order is
      // completed by the storefront/WMS that shipped it, and reporting it short here would be a
      // false warning on EVERY external dispatch. Nothing re-allocates such an order automatically
      // (both allocation sweeps exclude orders holding shipments), so this WARNING is the operator
      // queue for it — same pattern as the paid_without_invoice warning. Logged on EVERY shipped
      // transition, not only the one that first exposed the shortfall, so a retry after a crashed
      // log still surfaces it.
      if (reconciliation.shortfall) {
        const orderRef = result.shipment.order.orderNumber ?? result.shipment.order.externalOrderNumber
        const outstandingSummary = reconciliation.shortfall
          .map((line) => `${line.label} (${line.outstandingQty} outstanding)`)
          .join(', ')
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: reconciliation.orderId,
          action: 'shipped_short',
          tag: 'sales',
          level: 'WARNING',
          description: `Order ${orderRef} has despatched every shipment raised against it but is still short: ${outstandingSummary}. `
            + 'It has NOT been marked SHIPPED. Allocate and ship the remainder, or set the order to SHIPPED explicitly to close it short.',
          metadata: { orderNumber: orderRef, shortfall: reconciliation.shortfall },
        })
      }
      if (reconciliation.shouldGenerateInvoice) {
        const { generateInvoiceNumber } = await import('./sales')
        await generateInvoiceNumber(reconciliation.orderId)
      }
      // Direct (non-storefront) orders: courtesy dispatch email, opt-in and
      // queued at most once per order. Called on every SHIPPED transition —
      // not just when the order flipped — so a retry after a crashed enqueue
      // still heals; the helper self-guards (order must be SHIPPED, dedup
      // under the order row lock) and never throws.
      const { queueDispatchEmailIfEligible } = await import('@/lib/dispatch-email')
      await queueDispatchEmailIfEligible(reconciliation.orderId)
    }
    if (!result.transitioned) return { success: true }

    if (result.dispatched) {
      for (const line of result.shipment.lines) {
        const qty = decimalToNumber(line.qty)
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: line.productId,
          action: 'dispatched',
          tag: 'stock',
          level: 'INFO',
          description: `Dispatched ${qty} units of SKU ${line.product.sku} from ${result.shipment.warehouse.code} for order ${result.shipment.order.orderNumber ?? result.shipment.order.externalOrderNumber}`,
          metadata: { sku: line.product.sku, productId: line.productId, qty, orderNumber: result.shipment.order.orderNumber ?? result.shipment.order.externalOrderNumber, warehouseId: result.shipment.warehouseId },
        })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${result.shipment.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: result.shipment.orderId,
      action: 'shipment_status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Shipment from ${result.shipment.warehouse.code} for order ${result.shipment.order.orderNumber ?? result.shipment.order.externalOrderNumber} → ${targetStatus}`,
      metadata: { shipmentId, warehouseCode: result.shipment.warehouse.code, previousStatus: result.previousStatus, newStatus: targetStatus },
    })
    if (targetStatus === 'SHIPPED') {
      try {
        await pushOrderDeliveryMetadata(result.shipment.orderId)
      } catch (syncError) {
        console.error(syncError)
      }
      try {
        await enqueueStockSync(
          result.stockSyncProductIds,
          'IMS_CHANGE',
        )
      } catch (syncError) {
        console.error(syncError)
      }
    }
    return { success: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    try {
      await logShipmentStatusFailure(shipmentId, targetStatus, error)
    } catch (logError) {
      console.warn('Failed to log shipment status transition failure', logError)
    }
    return { success: false, error }
  }
}

export async function updateShipmentTracking(
  shipmentId: string,
  payload: { trackingNumber?: string; shippingService?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const shipment = await db.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        order: { select: { id: true, orderNumber: true, externalOrderNumber: true } },
        warehouse: { select: { code: true } },
        lines: { select: { productId: true } },
      },
    })
    if (!shipment) return { success: false, error: 'Shipment not found' }
    if (shipment.status !== 'SHIPPED') {
      return { success: false, error: 'Only shipped shipments can have tracking edited' }
    }

    const trackingNumber = payload.trackingNumber?.trim() || null
    const shippingService = payload.shippingService?.trim() || null

    await db.shipment.update({
      where: { id: shipmentId },
      data: {
        trackingNumber,
        shippingService,
      },
    })

    const shippedShipments = await db.shipment.findMany({
      where: { orderId: shipment.orderId, status: 'SHIPPED' },
      select: { trackingNumber: true },
    })
    const trackingNumbers = shippedShipments
      .map((row) => row.trackingNumber)
      .filter(Boolean)
      .join(', ')

    await db.salesOrder.update({
      where: { id: shipment.orderId },
      data: {
        trackingNumber: trackingNumbers || null,
      },
    })

    revalidatePath('/sales')
    revalidatePath(`/sales/${shipment.orderId}`)
    for (const productId of new Set(shipment.lines.map((line) => line.productId))) {
      revalidatePath(`/inventory/${productId}`)
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: shipment.orderId,
      action: 'shipment_tracking_updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated tracking for shipment from ${shipment.warehouse.code} on order ${shipment.order.orderNumber ?? shipment.order.externalOrderNumber}`,
      metadata: {
        shipmentId,
        warehouseCode: shipment.warehouse.code,
        trackingNumber,
        shippingService,
      },
    })

    try {
      await pushOrderDeliveryMetadata(shipment.orderId)
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
