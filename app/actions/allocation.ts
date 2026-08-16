'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/server'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata } from '@/lib/shopping'
import { decimalToNumber } from '@/lib/decimal'
import { requirementsMapToRows, type FulfillmentRequirement } from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  getFulfillmentAvailableQtyDecimal,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import { validateSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import {
  allocateSalesOrder,
  applyAllocationReservationDelta,
  buildAvailableStockMap,
  lockSalesOrder,
  lockStockLevels,
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
  reconcileOrderAfterShipment,
  transitionShipmentStatus,
} from '@/lib/domain/sales/shipment-service'
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

async function requireAuth() {
  const session = await auth()
  if (!session?.user?.id) throw new Error('Unauthorized')
  return session
}

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
  await requireAuth()
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
  await requireAuth()
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
  await requireAuth()

  const lines = await db.salesOrderLine.findMany({
    where: { orderId, productId: { not: null } },
    select: { id: true, productId: true },
  })

  const graph = await loadFulfillmentProductGraph(
    db,
    lines.map((line) => line.productId!).filter(Boolean),
  )

  return lines.map((line) => ({
    lineId: line.id,
    requirements: requirementsMapToRows(
      expandFulfillmentRequirementsDecimal(line.productId!, 1, graph),
    ),
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
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.process')
    }
    const allocationResult = await allocateSalesOrder(db, {
      orderId,
      refuseIfShipmentsExist: options?.refuseIfShipmentsExist,
      refuseIfCommittedShipmentsExist: options?.refuseIfCommittedShipmentsExist,
      onReconciledInTx: options?.onReconciledInTx,
      requireStatusUnderLock: options?.requireStatusUnderLock,
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
      const requestedQty = toDecimal(newQty)
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

      if (newQty === 0) {
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
        const reserveQty = residualAllocationQty(
          { ...destinationScope, qty: retainedAtDestination.add(requestedQty) },
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

    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      await resetAllocationAccountingIfStaged(tx, orderId)
      const graph = await loadFulfillmentProductGraph(tx, [productId])
      const leafProductIds = listFulfillmentLeafProductIds([productId], graph)
      await lockStockLevels(tx, leafProductIds, [warehouseId])

      const stockLevels = await tx.stockLevel.findMany({
        where: { productId: { in: leafProductIds }, warehouseId: { in: [warehouseId] } },
        select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
      })
      const stockMap = buildAvailableStockMap(stockLevels)
      const requestedQty = toDecimal(qty)
      const avail = getFulfillmentAvailableQtyDecimal(productId, warehouseId, graph, stockMap)
      if (requestedQty.gt(avail)) throw new Error(`Only ${avail.toString()} available`)
      const requirements = expandFulfillmentRequirementsDecimal(productId, requestedQty, graph)

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

        if (existing) {
          await tx.orderAllocation.update({
            where: { id: existing.id },
            data: { qty: toDecimal(existing.qty).add(requiredQty) },
          })
        } else {
          await tx.orderAllocation.create({
            data: { orderId, lineId, productId: leafProductId, warehouseId, qty: requiredQty },
          })
        }
      }

      await applyAllocationReservationDelta(
        tx,
        [...requirements.entries()].map(([leafProductId, requiredQty]) => ({
          productId: leafProductId,
          warehouseId,
          qty: requiredQty,
        })),
        'reserve',
      )

      const integrityError = await validateAllocationIntegrity(tx, orderId, [lineId])
      if (integrityError) throw new Error(integrityError)
    }, STOCK_TX_OPTIONS)

    revalidatePath(`/sales/${orderId}`)
    try {
      const graph = await loadFulfillmentProductGraph(db, [productId])
      const syncTargets = [...new Set(listFulfillmentLeafProductIds([productId], graph))]
      await enqueueStockSync(syncTargets, 'IMS_CHANGE')
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

      if (so.status === 'ALLOCATED') {
        // Re-read rather than assume: the guard above has already established there is no
        // non-PENDING shipment under this lock, so this count is 0 by construction. Kept as a
        // belt-and-braces read so the status demotion can never outlive the guard that justifies it.
        const activeShipmentCount = await tx.shipment.count({
          where: { orderId, status: { not: 'PENDING' } },
        })
        if (activeShipmentCount === 0) {
          const transition = validateSalesOrderStatusTransition(so.status, 'PROCESSING')
          if (!transition.success) throw new Error(transition.error)
          await tx.salesOrder.update({ where: { id: orderId }, data: { status: 'PROCESSING' } })
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
  options?: { internalBypassToken?: symbol },
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
      const reconciliation = await reconcileOrderAfterShipment(db, result.shipment, extra)
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
