'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/server'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata } from '@/lib/shopping'
import {
  calculateFulfillmentCoverage,
  calculateCoverageByLine,
  requirementsMapToRows,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirements,
  getFulfillmentAvailableQty,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import { consumeFifoLayersStrict, refreshSalesOrderLineCogs } from '@/lib/cost-layers'
import {
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import { allocateSalesOrder } from '@/lib/domain/sales/allocation-service'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
const ALLOCATION_EPSILON = 0.000001

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
 * Safe to call unconditionally — no-ops when inventoryAllocatedDate is null.
 * Must run inside the same transaction as the allocation mutation.
 */
async function resetAllocationAccountingIfStaged(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const so = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { inventoryAllocatedDate: true },
  })
  if (!so?.inventoryAllocatedDate) return

  // Check if any shipments have already been journaled — if so, we
  // cannot simply reset because Group B has already consumed the
  // snapshots. Block the edit instead.
  const journaledShipment = await tx.shipment.findFirst({
    where: { orderId, shipmentJournalDate: { not: null } },
    select: { id: true },
  })
  if (journaledShipment) {
    throw new Error(
      'Cannot modify allocations after shipments have been posted to accounting. ' +
      'Process a refund instead, or contact finance to reverse the journal entries first.',
    )
  }

  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    },
  })
  // Clear cost layer snapshots on all allocations for this order so A2
  // rebuilds them from scratch.
  await tx.orderAllocation.updateMany({
    where: { orderId },
    data: { costLayerSnapshot: Prisma.DbNull },
  })
}

async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`,
  )
}

async function lockStockLevels(
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

async function requireAuth() {
  const session = await auth()
  if (!session?.user?.id) throw new Error('Unauthorized')
  return session
}

function buildAvailableStockMap(
  rows: Array<{ productId: string; warehouseId: string; quantity: unknown; reservedQty: unknown }>,
): Map<string, Map<string, number>> {
  const stockMap = new Map<string, Map<string, number>>()
  for (const row of rows) {
    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, number>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(
      row.warehouseId,
      Math.max(0, Number(row.quantity) - Number(row.reservedQty)),
    )
  }
  return stockMap
}

async function applyAllocationReservationDelta(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string; qty: number }>,
  direction: 'reserve' | 'release',
) {
  for (const row of rows) {
    const qty = Number(row.qty)
    if (qty <= 0) continue
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

    await tx.stockLevel.updateMany({
      where: { productId: row.productId, warehouseId: row.warehouseId },
      data: { reservedQty: { decrement: qty } },
    })
  }
}

async function validateAllocationIntegrity(
  client: Prisma.TransactionClient | typeof db,
  orderId: string,
  lineIds?: string[],
): Promise<string | null> {
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
    },
  })
  if (lines.length === 0) return null

  const graph = await loadFulfillmentProductGraph(
    client,
    lines.map((line) => line.productId!).filter(Boolean),
  )
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  for (const line of lines) {
    requirementsByLine.set(
      line.id,
      requirementsMapToRows(expandFulfillmentRequirements(line.productId!, 1, graph)),
    )
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
      },
    }),
  ])

  const committedByLine = calculateCoverageByLine(
    requirementsByLine,
    activeShipmentLines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      qty: Number(line.qty),
    })),
  )

  for (const line of lines) {
    const requirements = requirementsByLine.get(line.id) ?? []
    if (requirements.length === 0) continue

    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))
    const lineAllocations = allocations.filter((allocation) => allocation.lineId === line.id)
    const byWarehouse = new Map<string, Map<string, number>>()

    for (const allocation of lineAllocations) {
      const quantities = byWarehouse.get(allocation.warehouseId) ?? new Map<string, number>()
      quantities.set(allocation.productId, (quantities.get(allocation.productId) ?? 0) + Number(allocation.qty))
      byWarehouse.set(allocation.warehouseId, quantities)
    }

    let allocatedCoverage = 0
    for (const [warehouseId, quantities] of byWarehouse) {
      const coverage = calculateFulfillmentCoverage(requirements, quantities)
      if (coverage <= ALLOCATION_EPSILON) {
        return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} does not contain a complete component set`
      }

      for (const requirement of requirements) {
        const actualQty = quantities.get(requirement.productId) ?? 0
        const expectedQty = coverage * requirement.factor
        if (Math.abs(actualQty - expectedQty) > ALLOCATION_EPSILON) {
          return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} must keep bundle components in matching quantities`
        }
      }

      for (const productId of quantities.keys()) {
        if (!requiredProductIds.has(productId)) {
          return `Allocation for sales line ${line.sku ?? line.description} contains an unexpected component`
        }
      }

      allocatedCoverage += coverage
    }

    const committedCoverage = committedByLine.get(line.id) ?? 0
    const remainingQty = Math.max(0, Number(line.qty) - committedCoverage)
    if (Math.abs(allocatedCoverage - remainingQty) > ALLOCATION_EPSILON && allocatedCoverage > remainingQty) {
      return `Allocation for sales line ${line.sku ?? line.description} exceeds the remaining quantity to fulfill`
    }
  }

  return null
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
    const result = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const so = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, externalOrderNumber: true, status: true },
      })
      if (!so) throw new Error('Order not found')

      const allocs = await tx.orderAllocation.findMany({
        where: { orderId },
        select: { lineId: true, productId: true, warehouseId: true, qty: true },
      })
      if (!allocs.length) throw new Error('No allocations to confirm')

      // Fetch qty already committed in non-PENDING shipments (partial fulfillment).
      const activeShipmentLines = await tx.shipmentLine.findMany({
        where: {
          shipment: { orderId, status: { not: 'PENDING' } },
        },
        select: { lineId: true, productId: true, shipment: { select: { warehouseId: true } }, qty: true },
      })
      const committedByAllocationKey = new Map<string, number>()
      for (const shipmentLine of activeShipmentLines) {
        const key = `${shipmentLine.lineId}|${shipmentLine.shipment.warehouseId}|${shipmentLine.productId}`
        committedByAllocationKey.set(
          key,
          (committedByAllocationKey.get(key) ?? 0) + Number(shipmentLine.qty),
        )
      }

      const effectiveAllocs = allocs.map((alloc) => {
        const key = `${alloc.lineId}|${alloc.warehouseId}|${alloc.productId}`
        const committed = committedByAllocationKey.get(key) ?? 0
        const effectiveQty = Math.max(0, Number(alloc.qty) - committed)
        return { ...alloc, qty: effectiveQty }
      }).filter((alloc) => alloc.qty > 0)

      if (!effectiveAllocs.length) {
        throw new Error('All allocated lines are already covered by active shipments')
      }

      const integrityError = await validateAllocationIntegrity(tx, orderId)
      if (integrityError) throw new Error(integrityError)

      const pendingShipmentMetadata = await tx.shipment.findMany({
        where: { orderId, status: 'PENDING' },
        select: { warehouseId: true, trackingNumber: true, shippingService: true },
      })
      const pendingMetadataByWarehouse = new Map(
        pendingShipmentMetadata.map((shipment) => [shipment.warehouseId, shipment]),
      )

      // Delete existing pending shipments (re-confirm scenario) in the same
      // transaction that rebuilds them, so crashes cannot orphan shipment rows.
      // Preserve pending tracking/service metadata by warehouse; users may
      // pre-stage carrier data before reconfirming allocation quantities.
      const deletedPending = await tx.shipment.deleteMany({ where: { orderId, status: 'PENDING' } })

      const byWarehouse = new Map<string, typeof effectiveAllocs>()
      for (const a of effectiveAllocs) {
        const group = byWarehouse.get(a.warehouseId) ?? []
        group.push(a)
        byWarehouse.set(a.warehouseId, group)
      }

      const createdShipments: Array<{ id: string; warehouseId: string; lineCount: number; totalQty: number }> = []
      for (const [warehouseId, whAllocs] of byWarehouse) {
        const pendingMetadata = pendingMetadataByWarehouse.get(warehouseId)
        const created = await tx.shipment.create({
          data: {
            orderId,
            warehouseId,
            status: 'PENDING',
            trackingNumber: pendingMetadata?.trackingNumber ?? null,
            shippingService: pendingMetadata?.shippingService ?? null,
            lines: {
              create: whAllocs.map((a) => ({
                lineId: a.lineId,
                productId: a.productId,
                qty: a.qty,
              })),
            },
          },
          select: { id: true },
        })
        createdShipments.push({
          id: created.id,
          warehouseId,
          lineCount: whAllocs.length,
          totalQty: whAllocs.reduce((sum, a) => sum + Number(a.qty), 0),
        })
      }

      // Keep status as ALLOCATED — shipment-level progression handles the rest.
      if (so.status !== 'ALLOCATED') {
        const transition = validateSalesOrderStatusTransition(so.status, 'ALLOCATED')
        if (!transition.success) throw new Error(transition.error)
        await tx.salesOrder.update({
          where: { id: orderId },
          data: { status: 'ALLOCATED' },
        })
      }

      return {
        orderNumber: so.orderNumber ?? so.externalOrderNumber,
        shipmentCount: byWarehouse.size,
        deletedPendingCount: deletedPending.count,
        createdShipments,
      }
    }, STOCK_TX_OPTIONS)

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
// Post-shipment reconciliation — idempotent, safe to re-run on retries.
// Checks whether all shipments for the order are shipped, advances order
// status, aggregates tracking numbers, and triggers auto-invoicing.
// ---------------------------------------------------------------------------

type ShipmentContext = {
  orderId: string
  lines: Array<{ productId: string }>
  warehouse: { code: string }
  order: { orderNumber: string | null; externalOrderNumber: string | null }
}

async function reconcileOrderAfterShipment(
  shipment: ShipmentContext,
  extra?: { trackingNumber?: string; shippingService?: string },
): Promise<void> {
  const allShipments = await db.shipment.findMany({
    where: { orderId: shipment.orderId },
    select: { id: true, status: true },
  })
  const allShipped = allShipments.every((s) => s.status === 'SHIPPED')

  if (allShipped) {
    const shippedShipments = await db.shipment.findMany({
      where: { orderId: shipment.orderId },
      select: { trackingNumber: true },
    })
    const trackingNumbers = shippedShipments
      .map((s) => s.trackingNumber)
      .filter(Boolean)
      .join(', ')

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM sales_orders WHERE id = ${shipment.orderId} FOR UPDATE`
      const currentOrder = await tx.salesOrder.findUnique({
        where: { id: shipment.orderId },
        select: { status: true },
      })
      if (!currentOrder) return
      if (['SHIPPED', 'COMPLETED', 'DELIVERED', 'REFUNDED', 'CANCELLED'].includes(currentOrder.status)) return

      const transition = validateSalesOrderStatusTransition(currentOrder.status, 'SHIPPED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({
        where: { id: shipment.orderId },
        data: {
          status: 'SHIPPED',
          shippedAt: new Date(),
          trackingNumber: trackingNumbers || (extra?.trackingNumber ?? null),
        },
      })
    }, STOCK_TX_OPTIONS)

    // Auto-generate invoice on ship if configured (idempotent — checks
    // if invoice already exists inside generateInvoiceNumber)
    const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
    if (trigger?.value === 'on_shipped') {
      const { generateInvoiceNumber } = await import('./sales')
      await generateInvoiceNumber(shipment.orderId)
    }
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
    const shipment = await db.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        order: { select: { id: true, orderNumber: true, externalOrderNumber: true, status: true } },
        lines: { select: { id: true, lineId: true, productId: true, qty: true, product: { select: { sku: true } } } },
        warehouse: { select: { code: true } },
      },
    })
    if (!shipment) return { success: false, error: 'Shipment not found' }

    // Idempotent: if the shipment is already at the target status, re-run
    // the post-commit reconciliation (order status, tracking, invoice,
    // delivery metadata, stock sync) which may have been missed on a prior
    // attempt that committed the tx but crashed before finishing side-effects.
    if (shipment.status === targetStatus) {
      if (targetStatus === 'SHIPPED') {
        await reconcileOrderAfterShipment(shipment, extra)
      }
      return { success: true }
    }

    const transition = validateShipmentStatusTransition(shipment.status, targetStatus)
    if (!transition.success) {
      return { success: false, error: transition.error }
    }

    const data: Record<string, unknown> = { status: targetStatus }
    if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
    if (extra?.shippingService) data.shippingService = extra.shippingService

    // On SHIPPED: dispatch stock atomically with the status change.
    // The status update MUST happen inside the same transaction as the
    // stock mutation so two concurrent calls (duplicate webhook, retry,
    // double-click) cannot both observe PACKED, both pass validation,
    // and both decrement stock. The conditional update ensures already-
    // shipped shipments are treated as a no-op.
    if (targetStatus === 'SHIPPED') {
      data.shippedAt = new Date()

      const dispatched = await db.$transaction(async (tx) => {
        await lockSalesOrder(tx, shipment.orderId)
        // Re-check status under lock — another caller may have shipped it
        // between our initial read and this transaction.
        const locked = await tx.shipment.findUnique({
          where: { id: shipmentId },
          select: { status: true },
        })
        if (locked?.status !== shipment.status) {
          return false // already transitioned — no-op
        }

        // Persist shipment status change inside the tx
        await tx.shipment.update({ where: { id: shipmentId }, data })

        await lockStockLevels(
          tx,
          [...new Set(shipment.lines.map((line) => line.productId))],
          [shipment.warehouseId],
        )
        let totalShipmentCogs = 0
        for (const line of shipment.lines) {
          const qty = Number(line.qty)
          await tx.stockLevel.updateMany({
            where: { productId: line.productId, warehouseId: shipment.warehouseId },
            data: { reservedQty: { decrement: qty } },
          })
          await tx.stockLevel.updateMany({
            where: { productId: line.productId, warehouseId: shipment.warehouseId },
            data: { quantity: { decrement: qty } },
          })
          const movement = await tx.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: shipment.warehouseId,
              qty,
              note: `Dispatched for order — shipment from ${shipment.warehouse.code}`,
              referenceType: 'SalesOrder',
              referenceId: shipment.orderId,
            },
            select: { id: true },
          })

          // Consume FIFO cost layers at shipment time so inventory
          // valuation is immediately correct and the daily batch (Group B)
          // can read pre-computed snapshots instead of mutating layers.
          const { consumed, totalCost } = await consumeFifoLayersStrict(
            tx, line.productId, shipment.warehouseId, qty,
          )
          totalShipmentCogs += totalCost
          if (consumed.length > 0) {
            await tx.cogsEntry.createMany({
              data: consumed.map((entry) => ({
                costLayerId: entry.costLayerId,
                movementId: movement.id,
                qty: entry.qty,
                unitCostBase: entry.unitCostBase,
                totalCostBase: Math.round(entry.qty * entry.unitCostBase * 1000000) / 1000000,
              })),
            })
            await tx.shipmentLine.update({
              where: { id: line.id },
              data: {
                costLayerSnapshot: consumed.map((c) => ({
                  costLayerId: c.costLayerId,
                  qty: c.qty,
                  unitCostBase: c.unitCostBase,
                })),
              },
            })
          }
        }

        // Store pre-computed COGS on the shipment so Group B can read
        // it directly without re-consuming layers.
        if (totalShipmentCogs > 0) {
          await tx.shipment.update({
            where: { id: shipmentId },
            data: { cogsBatchAmount: Math.round(totalShipmentCogs * 100) / 100 },
          })
        }

        await refreshSalesOrderLineCogs(
          tx,
          shipment.lines.map((line) => line.lineId),
        )

        return true
      }, STOCK_TX_OPTIONS)

      if (!dispatched) {
        return { success: true } // idempotent — already shipped
      }

      for (const line of shipment.lines) {
        const qty = Number(line.qty)
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: line.productId,
          action: 'dispatched',
          tag: 'stock',
          level: 'INFO',
          description: `Dispatched ${qty} units of SKU ${line.product.sku} from ${shipment.warehouse.code} for order ${shipment.order.orderNumber ?? shipment.order.externalOrderNumber}`,
          metadata: { sku: line.product.sku, productId: line.productId, qty, orderNumber: shipment.order.orderNumber ?? shipment.order.externalOrderNumber, warehouseId: shipment.warehouseId },
        })
      }
    } else {
      const transitioned = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`
        const locked = await tx.shipment.findUnique({
          where: { id: shipmentId },
          select: { status: true },
        })
        if (!locked) throw new Error('Shipment not found')
        if (locked.status === targetStatus) return false
        const lockedTransition = validateShipmentStatusTransition(locked.status, targetStatus)
        if (!lockedTransition.success) throw new Error(lockedTransition.error)
        await tx.shipment.update({ where: { id: shipmentId }, data })
        return true
      }, STOCK_TX_OPTIONS)
      if (!transitioned) return { success: true }
    }

    if (targetStatus === 'SHIPPED') {
      await reconcileOrderAfterShipment(shipment, extra)
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${shipment.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: shipment.orderId,
      action: 'shipment_status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Shipment from ${shipment.warehouse.code} for order ${shipment.order.orderNumber ?? shipment.order.externalOrderNumber} → ${targetStatus}`,
      metadata: { shipmentId, warehouseCode: shipment.warehouse.code, previousStatus: shipment.status, newStatus: targetStatus },
    })
    if (targetStatus === 'SHIPPED') {
      try {
        await pushOrderDeliveryMetadata(shipment.orderId)
      } catch (syncError) {
        console.error(syncError)
      }
      try {
        await enqueueStockSync(
          [...new Set(shipment.lines.map((line) => line.productId))],
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
