'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/server'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata } from '@/lib/shopping'
import { decimalToNumber } from '@/lib/decimal'
import { requirementsMapToRows, type FulfillmentRequirement } from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirements,
  getFulfillmentAvailableQty,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import { validateSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import {
  allocateSalesOrder,
  applyAllocationReservationDelta,
  buildAvailableStockMap,
  lockSalesOrder,
  lockStockLevels,
  resetAllocationAccountingIfStaged,
  validateAllocationIntegrity,
} from '@/lib/domain/sales/allocation-service'
import {
  confirmSalesOrderShipments,
  reconcileOrderAfterShipment,
  transitionShipmentStatus,
} from '@/lib/domain/sales/shipment-service'

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
      expandFulfillmentRequirements(line.productId!, 1, graph),
    ),
  }))
}

// ---------------------------------------------------------------------------
// Smart auto-allocation algorithm
// ---------------------------------------------------------------------------

export async function autoAllocateOrder(
  orderId: string,
  options?: { internalBypassToken?: symbol; deferStockSync?: boolean; refuseIfShipmentsExist?: boolean },
): Promise<{ success: boolean; error?: string; syncProductIds?: string[] }> {
  try {
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.process')
    }
    const allocationResult = await allocateSalesOrder(db, {
      orderId,
      refuseIfShipmentsExist: options?.refuseIfShipmentsExist,
    })

    if (!allocationResult.logAttempt && !allocationResult.success) {
      return {
        success: false,
        error: allocationResult.error,
        syncProductIds: allocationResult.syncProductIds,
      }
    }

    revalidateSalesAllocationPaths(orderId)
    if (allocationResult.logAttempt && allocationResult.orderRef) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: allocationResult.allocationCount > 0 ? 'allocated' : 'allocation_failed',
        tag: 'sales',
        level: allocationResult.allocationCount > 0 ? 'INFO' : 'WARNING',
        description: allocationResult.allocationCount > 0
          ? `Auto-allocated stock for order ${allocationResult.orderRef} — ${allocationResult.allocationCount} allocation(s)`
          : `No stock available to allocate for order ${allocationResult.orderRef}`,
        metadata: {
          orderNumber: allocationResult.orderRef,
          isWcOrder: allocationResult.isWcOrder,
          shipFromWarehouseId: allocationResult.shipFromWarehouseId,
          allocations: allocationResult.allocationCount,
        },
      })
    }
    if (!allocationResult.success) {
      return {
        success: false,
        error: allocationResult.error,
        syncProductIds: allocationResult.syncProductIds,
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
    return { success: true, syncProductIds: allocationResult.syncProductIds }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Manual allocation update
// ---------------------------------------------------------------------------

export async function updateAllocation(
  allocationId: string,
  newWarehouseId: string,
  newQty: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const alloc = await db.orderAllocation.findUnique({
      where: { id: allocationId },
      include: { line: { select: { qty: true } }, order: { select: { orderNumber: true, externalOrderNumber: true } } },
    })
    if (!alloc) return { success: false, error: 'Allocation not found' }
    if (newQty < 0) return { success: false, error: 'Quantity cannot be negative' }

    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, alloc.orderId)
      await resetAllocationAccountingIfStaged(tx, alloc.orderId)
      await lockStockLevels(tx, [alloc.productId], Array.from(new Set([alloc.warehouseId, newWarehouseId])))

      const stockLevels = await tx.stockLevel.findMany({
        where: { productId: alloc.productId, warehouseId: { in: Array.from(new Set([alloc.warehouseId, newWarehouseId])) } },
        select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
      })
      const stockMap = buildAvailableStockMap(stockLevels).get(alloc.productId) ?? new Map<string, number>()
      const effectiveAvailable = (stockMap.get(newWarehouseId) ?? 0)
        + (alloc.warehouseId === newWarehouseId ? Number(alloc.qty) : 0)

      if (newQty > effectiveAvailable) {
        throw new Error(`Only ${effectiveAvailable} available in this warehouse`)
      }

      await applyAllocationReservationDelta(tx, [{
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
        qty: Number(alloc.qty),
      }], 'release')

      if (newQty === 0) {
        await tx.orderAllocation.delete({ where: { id: allocationId } })
      } else {
        const mergeTarget = await tx.orderAllocation.findUnique({
          where: {
            lineId_warehouseId_productId: {
              lineId: alloc.lineId,
              warehouseId: newWarehouseId,
              productId: alloc.productId,
            },
          },
        })

        if (mergeTarget && mergeTarget.id !== allocationId) {
          await tx.orderAllocation.update({
            where: { id: mergeTarget.id },
            data: { qty: Number(mergeTarget.qty) + newQty },
          })
          await tx.orderAllocation.delete({ where: { id: allocationId } })
        } else {
          await tx.orderAllocation.update({
            where: { id: allocationId },
            data: { warehouseId: newWarehouseId, qty: newQty },
          })
        }

        await applyAllocationReservationDelta(tx, [{
          productId: alloc.productId,
          warehouseId: newWarehouseId,
          qty: newQty,
        }], 'reserve')
      }

      const integrityError = await validateAllocationIntegrity(tx, alloc.orderId, [alloc.lineId])
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
    return { success: true }
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
      const avail = getFulfillmentAvailableQty(productId, warehouseId, graph, stockMap)
      if (qty > avail) throw new Error(`Only ${avail} available`)

      for (const [leafProductId, requiredQty] of expandFulfillmentRequirements(productId, qty, graph)) {
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
            data: { qty: Number(existing.qty) + requiredQty },
          })
        } else {
          await tx.orderAllocation.create({
            data: { orderId, lineId, productId: leafProductId, warehouseId, qty: requiredQty },
          })
        }
      }

      await applyAllocationReservationDelta(
        tx,
        [...expandFulfillmentRequirements(productId, qty, graph).entries()].map(([leafProductId, requiredQty]) => ({
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
    await requirePermission('sales.process')
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, externalOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const deallocationResult = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      await resetAllocationAccountingIfStaged(tx, orderId)
      const currentAllocs = await tx.orderAllocation.findMany({
        where: { orderId },
        select: { lineId: true, productId: true, warehouseId: true, qty: true },
      })
      const leafProductIds = [...new Set(currentAllocs.map((alloc) => alloc.productId))]
      await lockStockLevels(
        tx,
        leafProductIds,
        [...new Set(currentAllocs.map((alloc) => alloc.warehouseId))],
      )

      await applyAllocationReservationDelta(
        tx,
        currentAllocs.map((alloc) => ({
          productId: alloc.productId,
          warehouseId: alloc.warehouseId,
          qty: Number(alloc.qty),
        })),
        'release',
      )
      const clampedReservations = await tx.stockLevel.updateMany({
        where: { reservedQty: { lt: 0 } },
        data: { reservedQty: 0 },
      })
      await tx.orderAllocation.deleteMany({ where: { orderId } })

      if (so.status === 'ALLOCATED') {
        const activeShipmentCount = await tx.shipment.count({
          where: { orderId, status: { not: 'PENDING' } },
        })
        if (activeShipmentCount === 0) {
          const transition = validateSalesOrderStatusTransition(so.status, 'PROCESSING')
          if (!transition.success) throw new Error(transition.error)
          await tx.salesOrder.update({ where: { id: orderId }, data: { status: 'PROCESSING' } })
        }
      }

      return { allocs: currentAllocs, clampedReservationCount: clampedReservations.count }
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
      description: `Deallocated stock for order ${so.orderNumber ?? so.externalOrderNumber}`,
      metadata: { orderNumber: so.orderNumber ?? so.externalOrderNumber },
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
      await logShipmentStatusFailure(shipmentId, targetStatus, result.error)
      return result
    }

    if (targetStatus === 'SHIPPED') {
      const reconciliation = await reconcileOrderAfterShipment(db, result.shipment, extra)
      if (reconciliation.shouldGenerateInvoice) {
        const { generateInvoiceNumber } = await import('./sales')
        await generateInvoiceNumber(reconciliation.orderId)
      }
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
    return { success: false, error: String(e) }
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
