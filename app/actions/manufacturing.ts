'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'
import type { ProductionOrderStatus, ProductionOrderType } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ManufacturingOrderRow = {
  id: string
  reference: string
  orderType: string
  productId: string
  productSku: string
  productName: string
  productImageUrl: string | null
  warehouseName: string
  manufacturerName: string | null
  qtyPlanned: number
  qtyProduced: number
  status: string
  createdAt: string
  scheduledAt: string | null
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}

export type BomProduct = {
  id: string
  sku: string
  name: string
  type: string
  components: { componentId: string; componentSku: string; componentName: string; qty: number }[]
}

export type WarehouseOption = {
  id: string
  code: string
  name: string
}

export type SupplierOption = {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// List / Filter
// ---------------------------------------------------------------------------

type ListFilters = {
  search?: string
  status?: ProductionOrderStatus
  orderType?: ProductionOrderType
  page?: number
  pageSize?: number
}

export async function getManufacturingOrders(filters: ListFilters = {}) {
  await requireAuth()
  const { search, status, orderType, page = 1, pageSize = 50 } = filters

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (orderType) where.orderType = orderType
  if (search) {
    where.OR = [
      { reference: { contains: search, mode: 'insensitive' } },
      { outputProduct: { sku: { contains: search, mode: 'insensitive' } } },
      { outputProduct: { name: { contains: search, mode: 'insensitive' } } },
      { manufacturer: { name: { contains: search, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    db.productionOrder.findMany({
      where,
      select: {
        id: true,
        reference: true,
        orderType: true,
        qtyPlanned: true,
        qtyProduced: true,
        status: true,
        createdAt: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        notes: true,
        outputProduct: { select: { id: true, sku: true, name: true, imageUrl: true } },
        warehouse: { select: { name: true } },
        manufacturer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.productionOrder.count({ where }),
  ])

  return {
    rows: rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      orderType: r.orderType,
      productId: r.outputProduct.id,
      productSku: r.outputProduct.sku,
      productName: r.outputProduct.name,
      productImageUrl: r.outputProduct.imageUrl,
      warehouseName: r.warehouse.name,
      manufacturerName: r.manufacturer?.name ?? null,
      qtyPlanned: Number(r.qtyPlanned),
      qtyProduced: Number(r.qtyProduced),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      notes: r.notes,
    })),
    total,
  }
}

// ---------------------------------------------------------------------------
// Reference data for creating orders
// ---------------------------------------------------------------------------

export async function getBomProducts(): Promise<BomProduct[]> {
  await requireAuth()
  const products = await db.product.findMany({
    where: { type: 'BOM', active: true },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
      productComponents: {
        select: {
          componentId: true,
          qty: true,
          component: { select: { sku: true, name: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { sku: 'asc' },
  })

  return products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    type: p.type,
    components: p.productComponents.map((c) => ({
      componentId: c.componentId,
      componentSku: c.component.sku,
      componentName: c.component.name,
      qty: Number(c.qty),
    })),
  }))
}

export async function getWarehouses(): Promise<WarehouseOption[]> {
  await requireAuth()
  return db.warehouse.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  })
}

export async function getSuppliers(): Promise<SupplierOption[]> {
  await requireAuth()
  return db.supplier.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

/** Get available stock for components in a specific warehouse */
export async function getComponentStock(
  productId: string,
  warehouseId: string,
): Promise<{ componentId: string; available: number; needed: number }[]> {
  await requireAuth()
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      productComponents: {
        select: {
          componentId: true,
          qty: true,
        },
      },
    },
  })
  if (!product) return []

  const componentIds = product.productComponents.map((c) => c.componentId)
  const stockLevels = await db.stockLevel.findMany({
    where: { productId: { in: componentIds }, warehouseId },
    select: { productId: true, quantity: true, reservedQty: true },
  })

  const stockMap = new Map(stockLevels.map((s) => [s.productId, Number(s.quantity) - Number(s.reservedQty)]))

  return product.productComponents.map((c) => ({
    componentId: c.componentId,
    available: stockMap.get(c.componentId) ?? 0,
    needed: Number(c.qty),
  }))
}

/** Max units that can be assembled from available stock */
export async function getMaxAssembly(productId: string, warehouseId: string): Promise<number> {
  await requireAuth()
  const stock = await getComponentStock(productId, warehouseId)
  if (stock.length === 0) return 0
  return Math.max(0, Math.floor(Math.min(...stock.map((s) => s.needed > 0 ? s.available / s.needed : Infinity))))
}

/** For disassembly: how many of the assembled product are available */
export async function getDisassemblyStock(productId: string, warehouseId: string): Promise<number> {
  await requireAuth()
  const level = await db.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
    select: { quantity: true, reservedQty: true },
  })
  if (!level) return 0
  return Math.max(0, Math.floor(Number(level.quantity) - Number(level.reservedQty)))
}

/** Get the last manufacturer used for a product's production order */
export async function getLastManufacturer(productId: string): Promise<string | null> {
  await requireAuth()
  const last = await db.productionOrder.findFirst({
    where: { outputProductId: productId, manufacturerId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { manufacturerId: true },
  })
  return last?.manufacturerId ?? null
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function makeReference(): string {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `MO-${ymd}-${rand}`
}

type CreateInput = {
  productId: string
  warehouseId: string
  manufacturerId?: string | null
  orderType: 'ASSEMBLY' | 'DISASSEMBLY'
  qtyPlanned: number
  scheduledAt?: string | null
  notes?: string | null
}

export async function createManufacturingOrder(input: CreateInput): Promise<{ success: boolean; error?: string; id?: string }> {
  try {
    await requireAuth()
    // Validate product has BOM components
    const product = await db.product.findUnique({
      where: { id: input.productId },
      select: {
        sku: true,
        name: true,
        type: true,
        productComponents: { select: { componentId: true, qty: true } },
      },
    })
    if (!product) return { success: false, error: 'Product not found.' }
    if (product.type !== 'BOM') return { success: false, error: 'Product is not a BOM type.' }
    if (product.productComponents.length === 0) return { success: false, error: 'Product has no components defined.' }

    if (input.qtyPlanned <= 0) return { success: false, error: 'Quantity must be greater than 0.' }

    // Find or create a BOM record for this product
    let bom = await db.bom.findFirst({
      where: { items: { some: { parentProductId: input.productId } } },
      select: { id: true },
    })
    if (!bom) {
      bom = await db.bom.create({
        data: {
          name: `${product.sku} BOM`,
          items: {
            create: product.productComponents.map((c, i) => ({
              parentProductId: input.productId,
              componentProductId: c.componentId,
              qty: c.qty,
              sortOrder: i,
            })),
          },
        },
      })
    }

    const reference = makeReference()
    const order = await db.productionOrder.create({
      data: {
        reference,
        orderType: input.orderType,
        bomId: bom.id,
        outputProductId: input.productId,
        warehouseId: input.warehouseId,
        manufacturerId: input.manufacturerId || null,
        qtyPlanned: input.qtyPlanned,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        notes: input.notes || null,
      },
    })

    logActivity({
      entityType: 'PRODUCTION_ORDER',
      entityId: order.id,
      tag: 'manufacturing',
      action: 'created',
      description: `Created ${input.orderType.toLowerCase()} order ${reference} for ${product.sku} — ${product.name} (${input.qtyPlanned} units)`,
      metadata: { reference, sku: product.sku, orderType: input.orderType, qty: input.qtyPlanned },
    })

    revalidatePath('/manufacturing')
    return { success: true, id: order.id }
  } catch (e) {
    logActivity({
      entityType: 'PRODUCTION_ORDER',
      tag: 'manufacturing',
      action: 'created',
      level: 'ERROR',
      description: `Failed to create manufacturing order: ${e instanceof Error ? e.message : e}`,
    })
    return { success: false, error: 'Failed to create manufacturing order.' }
  }
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

export async function updateManufacturingOrderStatus(
  id: string,
  status: ProductionOrderStatus,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const order = await db.productionOrder.findUnique({
      where: { id },
      select: {
        reference: true,
        status: true,
        orderType: true,
        outputProductId: true,
        warehouseId: true,
        qtyPlanned: true,
        outputProduct: {
          select: {
            sku: true,
            productComponents: {
              select: { componentId: true, qty: true },
            },
          },
        },
      },
    })
    if (!order) return { success: false, error: 'Order not found.' }

    const now = new Date()
    const qtyPlanned = Number(order.qtyPlanned)
    const isAssembly = order.orderType === 'ASSEMBLY'

    // When completing: execute stock movements in a transaction
    if (status === 'COMPLETED') {
      await db.$transaction(async (tx) => {
        const components = order.outputProduct.productComponents

        const wasInProgress = order.status === 'IN_PROGRESS'

        if (isAssembly) {
          // ASSEMBLY: deduct components (and release reservation), add output product
          for (const comp of components) {
            const totalQty = Number(comp.qty) * qtyPlanned

            // Deduct component stock + release reservation if was in progress
            await tx.stockLevel.upsert({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              create: { productId: comp.componentId, warehouseId: order.warehouseId, quantity: -totalQty },
              update: {
                quantity: { decrement: totalQty },
                ...(wasInProgress ? { reservedQty: { decrement: totalQty } } : {}),
              },
            })

            // Record PRODUCTION_OUT movement
            await tx.stockMovement.create({
              data: {
                type: 'PRODUCTION_OUT',
                productId: comp.componentId,
                fromWarehouseId: order.warehouseId,
                qty: totalQty,
                note: `${order.reference}: consumed for ${order.outputProduct.sku}`,
                referenceType: 'ProductionOrder',
                referenceId: id,
              },
            })
          }

          // Add output product stock
          await tx.stockLevel.upsert({
            where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
            create: { productId: order.outputProductId, warehouseId: order.warehouseId, quantity: qtyPlanned },
            update: { quantity: { increment: qtyPlanned } },
          })

          // Record PRODUCTION_IN movement
          await tx.stockMovement.create({
            data: {
              type: 'PRODUCTION_IN',
              productId: order.outputProductId,
              toWarehouseId: order.warehouseId,
              qty: qtyPlanned,
              note: `${order.reference}: assembled ${qtyPlanned} units`,
              referenceType: 'ProductionOrder',
              referenceId: id,
            },
          })
        } else {
          // DISASSEMBLY: deduct output product (and release reservation), add components
          await tx.stockLevel.upsert({
            where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
            create: { productId: order.outputProductId, warehouseId: order.warehouseId, quantity: -qtyPlanned },
            update: {
              quantity: { decrement: qtyPlanned },
              ...(wasInProgress ? { reservedQty: { decrement: qtyPlanned } } : {}),
            },
          })

          await tx.stockMovement.create({
            data: {
              type: 'PRODUCTION_OUT',
              productId: order.outputProductId,
              fromWarehouseId: order.warehouseId,
              qty: qtyPlanned,
              note: `${order.reference}: disassembled ${qtyPlanned} units`,
              referenceType: 'ProductionOrder',
              referenceId: id,
            },
          })

          for (const comp of components) {
            const totalQty = Number(comp.qty) * qtyPlanned

            await tx.stockLevel.upsert({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              create: { productId: comp.componentId, warehouseId: order.warehouseId, quantity: totalQty },
              update: { quantity: { increment: totalQty } },
            })

            await tx.stockMovement.create({
              data: {
                type: 'PRODUCTION_IN',
                productId: comp.componentId,
                toWarehouseId: order.warehouseId,
                qty: totalQty,
                note: `${order.reference}: recovered from disassembly of ${order.outputProduct.sku}`,
                referenceType: 'ProductionOrder',
                referenceId: id,
              },
            })
          }
        }

        // Update order status and qtyProduced
        await tx.productionOrder.update({
          where: { id },
          data: { status, completedAt: now, qtyProduced: qtyPlanned },
        })
      })

      // Log individual stock movements (fire-and-forget, after transaction)
      if (isAssembly) {
        for (const comp of order.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'production_out',
            description: `${order.reference}: consumed ${totalQty} units of component for ${order.outputProduct.sku} assembly`,
            metadata: { movementType: 'PRODUCTION_OUT', qty: totalQty, warehouseId: order.warehouseId, moReference: order.reference },
          })
        }
        logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: order.outputProductId,
          tag: 'stock',
          action: 'production_in',
          description: `${order.reference}: produced ${qtyPlanned} units of ${order.outputProduct.sku}`,
          metadata: { movementType: 'PRODUCTION_IN', qty: qtyPlanned, warehouseId: order.warehouseId, moReference: order.reference },
        })
      } else {
        logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: order.outputProductId,
          tag: 'stock',
          action: 'production_out',
          description: `${order.reference}: disassembled ${qtyPlanned} units of ${order.outputProduct.sku}`,
          metadata: { movementType: 'PRODUCTION_OUT', qty: qtyPlanned, warehouseId: order.warehouseId, moReference: order.reference },
        })
        for (const comp of order.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'production_in',
            description: `${order.reference}: recovered ${totalQty} units from disassembly of ${order.outputProduct.sku}`,
            metadata: { movementType: 'PRODUCTION_IN', qty: totalQty, warehouseId: order.warehouseId, moReference: order.reference },
          })
        }
      }
    } else if (status === 'IN_PROGRESS') {
      // Check stock sufficiency before starting
      if (isAssembly) {
        const componentIds = order.outputProduct.productComponents.map((c) => c.componentId)
        const levels = await db.stockLevel.findMany({
          where: { productId: { in: componentIds }, warehouseId: order.warehouseId },
          select: { productId: true, quantity: true, reservedQty: true },
        })
        const stockMap = new Map(levels.map((l) => [l.productId, Number(l.quantity) - Number(l.reservedQty)]))
        const insufficient: string[] = []
        for (const comp of order.outputProduct.productComponents) {
          const needed = Number(comp.qty) * qtyPlanned
          const available = stockMap.get(comp.componentId) ?? 0
          if (available < needed) {
            insufficient.push(`${comp.componentId} needs ${needed} but only ${Math.floor(available)} available`)
          }
        }
        if (insufficient.length > 0) {
          return { success: false, error: `Insufficient stock for ${insufficient.length} component(s). Cannot start production.` }
        }
      } else {
        // Disassembly: check output product stock
        const level = await db.stockLevel.findUnique({
          where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
          select: { quantity: true, reservedQty: true },
        })
        const available = level ? Number(level.quantity) - Number(level.reservedQty) : 0
        if (available < qtyPlanned) {
          return { success: false, error: `Insufficient stock: need ${qtyPlanned} units but only ${Math.floor(available)} available for disassembly.` }
        }
      }

      // Stock OK — reserve components and start
      await db.$transaction(async (tx) => {
        if (isAssembly) {
          for (const comp of order.outputProduct.productComponents) {
            const totalQty = Number(comp.qty) * qtyPlanned
            await tx.stockLevel.upsert({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              create: { productId: comp.componentId, warehouseId: order.warehouseId, quantity: 0, reservedQty: totalQty },
              update: { reservedQty: { increment: totalQty } },
            })
          }
        } else {
          await tx.stockLevel.upsert({
            where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
            create: { productId: order.outputProductId, warehouseId: order.warehouseId, quantity: 0, reservedQty: qtyPlanned },
            update: { reservedQty: { increment: qtyPlanned } },
          })
        }
        await tx.productionOrder.update({ where: { id }, data: { status, startedAt: now } })
      })

      // Log stock reservations
      if (isAssembly) {
        for (const comp of order.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'reserved',
            description: `${order.reference}: reserved ${totalQty} units of component for ${order.outputProduct.sku} assembly`,
            metadata: { qty: totalQty, warehouseId: order.warehouseId, moReference: order.reference },
          })
        }
      } else {
        logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: order.outputProductId,
          tag: 'stock',
          action: 'reserved',
          description: `${order.reference}: reserved ${qtyPlanned} units of ${order.outputProduct.sku} for disassembly`,
          metadata: { qty: qtyPlanned, warehouseId: order.warehouseId, moReference: order.reference },
        })
      }
    } else if (status === 'CANCELLED' && order.status === 'IN_PROGRESS') {
      // Release reservations when cancelling an in-progress order
      await db.$transaction(async (tx) => {
        if (isAssembly) {
          for (const comp of order.outputProduct.productComponents) {
            const totalQty = Number(comp.qty) * qtyPlanned
            await tx.stockLevel.update({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              data: { reservedQty: { decrement: totalQty } },
            })
          }
        } else {
          await tx.stockLevel.update({
            where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
            data: { reservedQty: { decrement: qtyPlanned } },
          })
        }
        await tx.productionOrder.update({ where: { id }, data: { status } })
      })

      // Log reservation release
      logActivity({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: id,
        tag: 'stock',
        action: 'reservation_released',
        description: `${order.reference}: released stock reservations due to cancellation`,
        metadata: { moReference: order.reference, warehouseId: order.warehouseId },
      })
    } else {
      // CANCELLED from DRAFT — no reservations to release
      await db.productionOrder.update({ where: { id }, data: { status } })
    }

    const actionDesc = status === 'COMPLETED'
      ? `Completed ${order.reference} — ${isAssembly ? 'assembled' : 'disassembled'} ${qtyPlanned} units of ${order.outputProduct.sku}, stock updated`
      : `Updated ${order.reference} status to ${status}`

    logActivity({
      entityType: 'PRODUCTION_ORDER',
      entityId: id,
      tag: 'manufacturing',
      action: 'status_changed',
      description: actionDesc,
      metadata: status === 'COMPLETED' ? { orderType: order.orderType, qty: qtyPlanned, sku: order.outputProduct.sku } : undefined,
    })

    revalidatePath('/manufacturing')
    revalidatePath(`/manufacturing/${id}`)
    revalidatePath('/inventory')
    revalidatePath('/stock-control')
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PRODUCTION_ORDER',
      entityId: id,
      tag: 'manufacturing',
      action: 'status_changed',
      level: 'ERROR',
      description: `Failed to update manufacturing order status: ${e instanceof Error ? e.message : e}`,
    })
    return { success: false, error: 'Failed to update status.' }
  }
}

// ---------------------------------------------------------------------------
// Get single order detail
// ---------------------------------------------------------------------------

export type ManufacturingOrderDetail = {
  id: string
  reference: string
  orderType: string
  status: string
  productId: string
  productSku: string
  productName: string
  productBarcode: string | null
  productImageUrl: string | null
  warehouseId: string
  warehouseName: string
  warehouseCode: string
  manufacturerId: string | null
  manufacturerName: string | null
  manufacturerEmail: string | null
  qtyPlanned: number
  qtyProduced: number
  scheduledAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  notes: string | null
  components: {
    componentId: string
    componentSku: string
    componentName: string
    componentBarcode: string | null
    componentImageUrl: string | null
    qtyPerUnit: number
  }[]
}

export async function getManufacturingOrder(id: string): Promise<ManufacturingOrderDetail | null> {
  await requireAuth()
  const o = await db.productionOrder.findUnique({
    where: { id },
    select: {
      id: true,
      reference: true,
      orderType: true,
      status: true,
      qtyPlanned: true,
      qtyProduced: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      notes: true,
      outputProduct: {
        select: {
          id: true,
          sku: true,
          name: true,
          barcode: true,
          imageUrl: true,
          productComponents: {
            select: {
              componentId: true,
              qty: true,
              component: { select: { sku: true, name: true, barcode: true, imageUrl: true } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      warehouse: { select: { id: true, name: true, code: true } },
      manufacturer: { select: { id: true, name: true, email: true } },
    },
  })
  if (!o) return null

  return {
    id: o.id,
    reference: o.reference,
    orderType: o.orderType,
    status: o.status,
    productId: o.outputProduct.id,
    productSku: o.outputProduct.sku,
    productName: o.outputProduct.name,
    productBarcode: o.outputProduct.barcode,
    productImageUrl: o.outputProduct.imageUrl,
    warehouseId: o.warehouse.id,
    warehouseName: o.warehouse.name,
    warehouseCode: o.warehouse.code,
    manufacturerId: o.manufacturer?.id ?? null,
    manufacturerName: o.manufacturer?.name ?? null,
    manufacturerEmail: o.manufacturer?.email ?? null,
    qtyPlanned: Number(o.qtyPlanned),
    qtyProduced: Number(o.qtyProduced),
    scheduledAt: o.scheduledAt?.toISOString() ?? null,
    startedAt: o.startedAt?.toISOString() ?? null,
    completedAt: o.completedAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    notes: o.notes,
    components: o.outputProduct.productComponents.map((c) => ({
      componentId: c.componentId,
      componentSku: c.component.sku,
      componentName: c.component.name,
      componentBarcode: c.component.barcode,
      componentImageUrl: c.component.imageUrl,
      qtyPerUnit: Number(c.qty),
    })),
  }
}
