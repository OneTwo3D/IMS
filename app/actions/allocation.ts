'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/server'

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
    qty: number
    productSku: string
    productName: string
    imageUrl: string | null
  }[]
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
      line: { select: { qty: true } },
    },
    orderBy: [{ warehouseId: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    lineId: r.lineId,
    productId: r.productId,
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
      qty: Number(l.qty),
      productSku: l.product.sku,
      productName: l.product.name,
      imageUrl: l.product.imageUrl ?? l.product.parent?.imageUrl ?? null,
    })),
  }))
}

// ---------------------------------------------------------------------------
// Smart auto-allocation algorithm
// ---------------------------------------------------------------------------

export async function autoAllocateOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        wcOrderNumber: true,
        status: true,
        shipFromWarehouseId: true,
        lines: { select: { id: true, productId: true, qty: true, sku: true } },
      },
    })
    if (!so) return { success: false, error: 'Order not found' }

    // Get eligible warehouses: the selected warehouse first, then others available for sale.
    // For WC orders, restrict to WC-synced warehouses to ship from the right locations.
    const isWcOrder = !!so.wcOrderNumber
    const allWarehouses = await db.warehouse.findMany({
      where: {
        active: true,
        availableForSale: true,
        ...(isWcOrder ? { syncToWoocommerce: true } : {}),
      },
      select: { id: true, code: true, name: true, isDefault: true, syncToWoocommerce: true },
      orderBy: { isDefault: 'desc' },
    })
    if (!allWarehouses.length) return { success: false, error: isWcOrder ? 'No WooCommerce-synced warehouses available for sale' : 'No warehouses available for sale' }

    // Order warehouses: selected first, then default, then WC-synced, then rest
    const primaryId = so.shipFromWarehouseId
    const sorted = [...allWarehouses].sort((a, b) => {
      if (a.id === primaryId) return -1
      if (b.id === primaryId) return 1
      if (a.isDefault && !b.isDefault) return -1
      if (!a.isDefault && b.isDefault) return 1
      if (a.syncToWoocommerce && !b.syncToWoocommerce) return -1
      if (!a.syncToWoocommerce && b.syncToWoocommerce) return 1
      return 0
    })

    // Get stock levels for all products across all warehouses
    const productIds = so.lines.filter((l) => l.productId).map((l) => l.productId!)
    const stockLevels = await db.stockLevel.findMany({
      where: { productId: { in: productIds }, warehouseId: { in: sorted.map((w) => w.id) } },
      select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    })

    // Build available stock map: productId -> warehouseId -> available
    const stockMap = new Map<string, Map<string, number>>()
    for (const sl of stockLevels) {
      let prodMap = stockMap.get(sl.productId)
      if (!prodMap) { prodMap = new Map(); stockMap.set(sl.productId, prodMap) }
      prodMap.set(sl.warehouseId, Math.max(0, Number(sl.quantity) - Number(sl.reservedQty)))
    }

    // Fetch qty already committed in non-PENDING shipments (partial fulfillment)
    const activeShipmentLines = await db.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, qty: true },
    })
    const committedByLine = new Map<string, number>()
    for (const sl of activeShipmentLines) {
      committedByLine.set(sl.lineId, (committedByLine.get(sl.lineId) ?? 0) + Number(sl.qty))
    }

    // Smart allocation: minimize number of shipments
    // Subtract already-committed qty so we only allocate what's still needed
    const lines = so.lines.filter((l) => l.productId).map((l) => {
      const committed = committedByLine.get(l.id) ?? 0
      return {
        id: l.id,
        productId: l.productId!,
        sku: l.sku ?? l.productId!,
        qty: Math.max(0, Number(l.qty) - committed),
      }
    }).filter((l) => l.qty > 0)

    // Step 1: Find which warehouses can fully fulfill each line
    const lineOptions = new Map<string, string[]>() // lineId -> warehouseIds that can fully fulfill
    for (const line of lines) {
      const options: string[] = []
      for (const wh of sorted) {
        const avail = stockMap.get(line.productId)?.get(wh.id) ?? 0
        if (avail >= line.qty) options.push(wh.id)
      }
      lineOptions.set(line.id, options)
    }

    // Step 2: Find forced warehouses (lines with only one option)
    const forcedWarehouses = new Set<string>()
    for (const [, options] of lineOptions) {
      if (options.length === 1) forcedWarehouses.add(options[0])
    }

    // Step 3: Allocate using intelligent grouping
    const allocations: { lineId: string; productId: string; warehouseId: string; qty: number }[] = []
    const tempStock = new Map<string, Map<string, number>>()
    // Deep copy stock map for tracking during allocation
    for (const [pid, whMap] of stockMap) {
      const copy = new Map<string, number>()
      for (const [wid, q] of whMap) copy.set(wid, q)
      tempStock.set(pid, copy)
    }

    for (const line of lines) {
      const options = lineOptions.get(line.id) ?? []
      let bestWh: string | null = null
      let remaining = line.qty

      if (options.length > 0) {
        // Prefer a warehouse that's already forced (to minimize shipment count)
        const forcedOption = options.find((w) => forcedWarehouses.has(w))
        if (forcedOption) {
          bestWh = forcedOption
        } else {
          // Prefer primary/default warehouse
          bestWh = options[0]
        }
      }

      if (bestWh) {
        const avail = tempStock.get(line.productId)?.get(bestWh) ?? 0
        const allocQty = Math.min(remaining, avail)
        if (allocQty > 0) {
          allocations.push({ lineId: line.id, productId: line.productId, warehouseId: bestWh, qty: allocQty })
          const prodMap = tempStock.get(line.productId)!
          prodMap.set(bestWh, avail - allocQty)
          remaining -= allocQty
        }
      }

      // If not fully allocated, try other warehouses
      if (remaining > 0) {
        for (const wh of sorted) {
          if (remaining <= 0) break
          if (bestWh && wh.id === bestWh) continue // already tried
          const avail = tempStock.get(line.productId)?.get(wh.id) ?? 0
          if (avail <= 0) continue
          const allocQty = Math.min(remaining, avail)
          allocations.push({ lineId: line.id, productId: line.productId, warehouseId: wh.id, qty: allocQty })
          const prodMap = tempStock.get(line.productId)!
          prodMap.set(wh.id, avail - allocQty)
          remaining -= allocQty
        }
      }
      // If still remaining > 0, it's backordered (no allocation record for that qty)
    }

    // Clear existing allocations and reservations
    const existingAllocs = await db.orderAllocation.findMany({
      where: { orderId },
      select: { productId: true, warehouseId: true, qty: true },
    })
    for (const alloc of existingAllocs) {
      await db.stockLevel.updateMany({
        where: { productId: alloc.productId, warehouseId: alloc.warehouseId },
        data: { reservedQty: { decrement: Number(alloc.qty) } },
      })
    }
    await db.orderAllocation.deleteMany({ where: { orderId } })

    // Also release old-style shipFromWarehouse reservation
    if (so.shipFromWarehouseId) {
      // Already handled above via existing allocations, but for legacy orders:
      // We don't double-decrement since old orders might not have allocations
    }

    // Create new allocations and reserve stock
    for (const alloc of allocations) {
      await db.orderAllocation.create({
        data: {
          orderId,
          lineId: alloc.lineId,
          productId: alloc.productId,
          warehouseId: alloc.warehouseId,
          qty: alloc.qty,
        },
      })
      await db.stockLevel.upsert({
        where: { productId_warehouseId: { productId: alloc.productId, warehouseId: alloc.warehouseId } },
        create: { productId: alloc.productId, warehouseId: alloc.warehouseId, quantity: 0, reservedQty: alloc.qty },
        update: { reservedQty: { increment: alloc.qty } },
      })
    }

    // Only promote to ALLOCATED when at least one allocation was created.
    // Without this guard, orders with no available stock (e.g. warehouse
    // filtered out by syncToWoocommerce flag) would be marked ALLOCATED
    // with zero allocation rows.
    if (allocations.length > 0) {
      if (['DRAFT', 'PENDING_PAYMENT'].includes(so.status)) {
        await db.salesOrder.update({ where: { id: orderId }, data: { status: 'ALLOCATED' } })
      } else if (so.status === 'PROCESSING') {
        await db.salesOrder.update({ where: { id: orderId }, data: { status: 'ALLOCATED' } })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: allocations.length > 0 ? 'allocated' : 'allocation_failed',
      tag: 'sales',
      level: allocations.length > 0 ? 'INFO' : 'WARNING',
      description: allocations.length > 0
        ? `Auto-allocated stock for order ${so.wcOrderNumber} — ${allocations.length} allocation(s)`
        : `No stock available to allocate for order ${so.wcOrderNumber}`,
      metadata: { orderNumber: so.wcOrderNumber, allocations: allocations.length },
    })
    if (allocations.length === 0) {
      return { success: false, error: 'No stock available for allocation' }
    }
    return { success: true }
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
      include: { line: { select: { qty: true } }, order: { select: { wcOrderNumber: true } } },
    })
    if (!alloc) return { success: false, error: 'Allocation not found' }
    if (newQty < 0) return { success: false, error: 'Quantity cannot be negative' }

    // Check available stock in new warehouse
    if (newQty > 0) {
      const sl = await db.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: alloc.productId, warehouseId: newWarehouseId } },
        select: { quantity: true, reservedQty: true },
      })
      const currentAvail = Math.max(0, Number(sl?.quantity ?? 0) - Number(sl?.reservedQty ?? 0))
      // If same warehouse, add back current allocation
      const adjustment = (newWarehouseId === alloc.warehouseId) ? Number(alloc.qty) : 0
      if (newQty > currentAvail + adjustment) {
        return { success: false, error: `Only ${currentAvail + adjustment} available in this warehouse` }
      }
    }

    // Release old reservation
    await db.stockLevel.updateMany({
      where: { productId: alloc.productId, warehouseId: alloc.warehouseId },
      data: { reservedQty: { decrement: Number(alloc.qty) } },
    })

    if (newQty === 0) {
      // Remove the allocation
      await db.orderAllocation.delete({ where: { id: allocationId } })
    } else {
      // Update allocation
      await db.orderAllocation.update({
        where: { id: allocationId },
        data: { warehouseId: newWarehouseId, qty: newQty },
      })
      // Reserve new stock
      await db.stockLevel.upsert({
        where: { productId_warehouseId: { productId: alloc.productId, warehouseId: newWarehouseId } },
        create: { productId: alloc.productId, warehouseId: newWarehouseId, quantity: 0, reservedQty: newQty },
        update: { reservedQty: { increment: newQty } },
      })
    }

    revalidatePath(`/sales/${alloc.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: alloc.orderId,
      action: 'allocation_updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated allocation for order ${alloc.order.wcOrderNumber}`,
      metadata: { allocationId, newWarehouseId, newQty },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
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

    // Check stock availability
    const sl = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
      select: { quantity: true, reservedQty: true },
    })
    const avail = Math.max(0, Number(sl?.quantity ?? 0) - Number(sl?.reservedQty ?? 0))
    if (qty > avail) return { success: false, error: `Only ${avail} available` }

    // Check if allocation already exists for this line+warehouse
    const existing = await db.orderAllocation.findUnique({
      where: { lineId_warehouseId: { lineId, warehouseId } },
    })
    if (existing) {
      return updateAllocation(existing.id, warehouseId, Number(existing.qty) + qty)
    }

    await db.orderAllocation.create({
      data: { orderId, lineId, productId, warehouseId, qty },
    })
    await db.stockLevel.upsert({
      where: { productId_warehouseId: { productId, warehouseId } },
      create: { productId, warehouseId, quantity: 0, reservedQty: qty },
      update: { reservedQty: { increment: qty } },
    })

    revalidatePath(`/sales/${orderId}`)
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
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
      select: { wcOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const allocs = await db.orderAllocation.findMany({
      where: { orderId },
      select: { productId: true, warehouseId: true, qty: true },
    })

    for (const alloc of allocs) {
      await db.stockLevel.updateMany({
        where: { productId: alloc.productId, warehouseId: alloc.warehouseId },
        data: { reservedQty: { decrement: Number(alloc.qty) } },
      })
    }
    // Clamp reservedQty to zero to prevent negative values from stale data
    await db.stockLevel.updateMany({
      where: { reservedQty: { lt: 0 } },
      data: { reservedQty: 0 },
    })
    await db.orderAllocation.deleteMany({ where: { orderId } })

    // Revert to PROCESSING — but keep ALLOCATED if active (non-PENDING) shipments exist
    if (so.status === 'ALLOCATED') {
      const activeShipmentCount = await db.shipment.count({
        where: { orderId, status: { not: 'PENDING' } },
      })
      if (activeShipmentCount === 0) {
        await db.salesOrder.update({ where: { id: orderId }, data: { status: 'PROCESSING' } })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'deallocated',
      tag: 'sales',
      level: 'INFO',
      description: `Deallocated stock for order ${so.wcOrderNumber}`,
      metadata: { orderNumber: so.wcOrderNumber },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Confirm allocations — generates shipments per warehouse
// ---------------------------------------------------------------------------

export async function confirmAllocations(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { wcOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const allocs = await db.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })

    if (!allocs.length) return { success: false, error: 'No allocations to confirm' }

    // Fetch qty already committed in non-PENDING shipments (partial fulfillment)
    const activeShipmentLines = await db.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, qty: true },
    })
    const committedByLine = new Map<string, number>()
    for (const sl of activeShipmentLines) {
      committedByLine.set(sl.lineId, (committedByLine.get(sl.lineId) ?? 0) + Number(sl.qty))
    }

    // Subtract already-committed qty per line, draining across allocation rows
    // in order so that split allocations (e.g. [6,4] with 3 committed) become
    // [3,4] rather than the incorrect [3,1] that per-row subtraction produces.
    const remainingByLine = new Map<string, number>()
    for (const [lineId, committed] of committedByLine) {
      remainingByLine.set(lineId, committed)
    }
    const effectiveAllocs = allocs.map((a) => {
      const remaining = remainingByLine.get(a.lineId) ?? 0
      const allocQty = Number(a.qty)
      const drain = Math.min(remaining, allocQty)
      remainingByLine.set(a.lineId, remaining - drain)
      return { ...a, qty: allocQty - drain }
    }).filter((a) => a.qty > 0)

    if (!effectiveAllocs.length) {
      return { success: false, error: 'All allocated lines are already covered by active shipments' }
    }

    // Delete existing pending shipments (re-confirm scenario)
    await db.shipment.deleteMany({ where: { orderId, status: 'PENDING' } })

    // Group effective allocations by warehouse
    const byWarehouse = new Map<string, typeof effectiveAllocs>()
    for (const a of effectiveAllocs) {
      const group = byWarehouse.get(a.warehouseId) ?? []
      group.push(a)
      byWarehouse.set(a.warehouseId, group)
    }

    // Create a shipment per warehouse
    for (const [warehouseId, whAllocs] of byWarehouse) {
      await db.shipment.create({
        data: {
          orderId,
          warehouseId,
          status: 'PENDING',
          lines: {
            create: whAllocs.map((a) => ({
              lineId: a.lineId,
              productId: a.productId,
              qty: a.qty,
            })),
          },
        },
      })
    }

    // Keep status as ALLOCATED — shipment-level progression handles the rest
    if (so.status !== 'ALLOCATED') {
      await db.salesOrder.update({
        where: { id: orderId },
        data: { status: 'ALLOCATED' },
      })
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'allocations_confirmed',
      tag: 'sales',
      level: 'INFO',
      description: `Confirmed allocations for order ${so.wcOrderNumber} — ${byWarehouse.size} shipment(s) created`,
      metadata: { orderNumber: so.wcOrderNumber, shipmentCount: byWarehouse.size },
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
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const shipment = await db.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        order: { select: { id: true, wcOrderNumber: true, status: true } },
        lines: { select: { lineId: true, productId: true, qty: true, product: { select: { sku: true } } } },
        warehouse: { select: { code: true } },
      },
    })
    if (!shipment) return { success: false, error: 'Shipment not found' }

    const VALID: Record<string, string[]> = {
      PENDING: ['PICKING'],
      PICKING: ['PACKED'],
      PACKED: ['SHIPPED'],
    }
    const allowed = VALID[shipment.status] ?? []
    if (!allowed.includes(targetStatus)) {
      return { success: false, error: `Cannot transition shipment from ${shipment.status} to ${targetStatus}` }
    }

    const data: Record<string, unknown> = { status: targetStatus }
    if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
    if (extra?.shippingService) data.shippingService = extra.shippingService

    // On SHIPPED: dispatch stock
    if (targetStatus === 'SHIPPED') {
      data.shippedAt = new Date()

      for (const line of shipment.lines) {
        const qty = Number(line.qty)
        // Release reservation
        await db.stockLevel.updateMany({
          where: { productId: line.productId, warehouseId: shipment.warehouseId },
          data: { reservedQty: { decrement: qty } },
        })
        // Decrement actual stock
        await db.stockLevel.updateMany({
          where: { productId: line.productId, warehouseId: shipment.warehouseId },
          data: { quantity: { decrement: qty } },
        })
        // Create stock movement
        await db.stockMovement.create({
          data: {
            type: 'SALE_DISPATCH',
            productId: line.productId,
            fromWarehouseId: shipment.warehouseId,
            qty,
            note: `Dispatched for order — shipment from ${shipment.warehouse.code}`,
            referenceType: 'SalesOrder',
            referenceId: shipment.orderId,
          },
        })
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: line.productId,
          action: 'dispatched',
          tag: 'stock',
          level: 'INFO',
          description: `Dispatched ${qty} units of SKU ${line.product.sku} from ${shipment.warehouse.code} for order ${shipment.order.wcOrderNumber}`,
          metadata: { sku: line.product.sku, productId: line.productId, qty, orderNumber: shipment.order.wcOrderNumber, warehouseId: shipment.warehouseId },
        })
      }

    }

    // Persist the shipment status change FIRST, before checking order-level status
    await db.shipment.update({ where: { id: shipmentId }, data })

    // After persisting, check if ALL shipments for this order are now shipped
    if (targetStatus === 'SHIPPED') {
      const allShipments = await db.shipment.findMany({
        where: { orderId: shipment.orderId },
        select: { id: true, status: true },
      })
      const allShipped = allShipments.every((s) => s.status === 'SHIPPED')

      if (allShipped) {
        // Collect all tracking numbers
        const shippedShipments = await db.shipment.findMany({
          where: { orderId: shipment.orderId },
          select: { trackingNumber: true },
        })
        const trackingNumbers = shippedShipments
          .map((s) => s.trackingNumber)
          .filter(Boolean)
          .join(', ')

        await db.salesOrder.update({
          where: { id: shipment.orderId },
          data: {
            status: 'SHIPPED',
            shippedAt: new Date(),
            trackingNumber: trackingNumbers || (extra?.trackingNumber ?? null),
          },
        })

        // Auto-generate invoice on ship if configured
        const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
        if (trigger?.value === 'on_shipped') {
          const { generateInvoiceNumber } = await import('./sales')
          await generateInvoiceNumber(shipment.orderId)
        }
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${shipment.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: shipment.orderId,
      action: 'shipment_status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Shipment from ${shipment.warehouse.code} for order ${shipment.order.wcOrderNumber} → ${targetStatus}`,
      metadata: { shipmentId, warehouseCode: shipment.warehouse.code, previousStatus: shipment.status, newStatus: targetStatus },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
