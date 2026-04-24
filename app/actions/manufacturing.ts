'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import {
  addCostLayerSourceLines,
  consumeFifoLayersStrict,
  createCostLayer,
  getAverageUnitCost,
  getReturnedQtyForCostLayer,
  refreshShipmentCogsForCostLayerChange,
  refreshSalesOrderLineCogsForCostLayerChange,
  updateSnapshotsForCostLayerChange,
} from '@/lib/cost-layers'
import { recomputeManufacturingUnitCosts } from '@/lib/manufacturing-cost'
import { COMPONENT_PRODUCT_STATUSES, OPERATIONAL_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { Prisma, type ProductionOrderStatus, type ProductionOrderType } from '@/app/generated/prisma/client'

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

type ComponentStockRow = {
  componentId: string
  available: number
  needed: number
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
        outputProduct: { select: { id: true, sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
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
      productImageUrl: r.outputProduct.imageUrl ?? r.outputProduct.parent?.imageUrl ?? null,
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
    where: { type: 'BOM', lifecycleStatus: { in: OPERATIONAL_PRODUCT_STATUSES } },
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
async function loadComponentStock(
  productId: string,
  warehouseId: string,
): Promise<ComponentStockRow[]> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      lifecycleStatus: true,
      productComponents: {
        select: {
          componentId: true,
          qty: true,
          component: { select: { lifecycleStatus: true } },
        },
      },
    },
  })
  if (!product) return []
  if (!OPERATIONAL_PRODUCT_STATUSES.includes(product.lifecycleStatus)) return []

  const componentIds = product.productComponents
    .filter((c) => COMPONENT_PRODUCT_STATUSES.includes(c.component.lifecycleStatus))
    .map((c) => c.componentId)
  const stockLevels = await db.stockLevel.findMany({
    where: { productId: { in: componentIds }, warehouseId },
    select: { productId: true, quantity: true, reservedQty: true },
  })

  const stockMap = new Map(stockLevels.map((s) => [s.productId, Number(s.quantity) - Number(s.reservedQty)]))

  return product.productComponents
    .filter((c) => COMPONENT_PRODUCT_STATUSES.includes(c.component.lifecycleStatus))
    .map((c) => ({
      componentId: c.componentId,
      available: stockMap.get(c.componentId) ?? 0,
      needed: Number(c.qty),
    }))
}

export async function getComponentStock(
  productId: string,
  warehouseId: string,
): Promise<ComponentStockRow[]> {
  await requireAuth()
  return loadComponentStock(productId, warehouseId)
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
    await requirePermission('manufacturing')
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

    await logActivity({
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
    await logActivity({
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

async function assertStockAvailable(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
  qty: number,
  options: { includeReserved?: boolean; requireReserved?: boolean } = {},
) {
  await tx.$executeRaw`
    SELECT "productId", "warehouseId"
    FROM stock_levels
    WHERE "productId" = ${productId}
      AND "warehouseId" = ${warehouseId}
    FOR UPDATE
  `
  const stock = await tx.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
    select: { quantity: true, reservedQty: true },
  })
  const quantity = Number(stock?.quantity ?? 0)
  const reservedQty = Number(stock?.reservedQty ?? 0)
  const available = options.includeReserved ? quantity : quantity - reservedQty
  if (!stock || available < qty || (options.requireReserved && reservedQty < qty)) {
    throw new Error(`Insufficient stock for product ${productId} in warehouse ${warehouseId}`)
  }
}

async function reserveAvailableStock(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
  qty: number,
) {
  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: { productId, warehouseId, quantity: 0, reservedQty: 0 },
    update: {},
  })
  await tx.$executeRaw`
    SELECT "productId", "warehouseId"
    FROM stock_levels
    WHERE "productId" = ${productId}
      AND "warehouseId" = ${warehouseId}
    FOR UPDATE
  `
  const stock = await tx.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
    select: { quantity: true, reservedQty: true },
  })
  const available = Number(stock?.quantity ?? 0) - Number(stock?.reservedQty ?? 0)
  if (available < qty) {
    throw new Error(`Insufficient stock for product ${productId} in warehouse ${warehouseId}`)
  }
  await tx.stockLevel.update({
    where: { productId_warehouseId: { productId, warehouseId } },
    data: { reservedQty: { increment: qty } },
  })
}

async function buildDisassemblyRecoveryPlan(
  tx: Prisma.TransactionClient,
  recoveredLayers: Array<{ costLayerId: string; qty: number; unitCostBase: number }>,
  components: Array<{ componentId: string; qty: Prisma.Decimal | number }>,
  warehouseId: string,
  qtyPlanned: number,
): Promise<Array<{ componentId: string; totalQty: number; totalCostBase: Prisma.Decimal }>> {
  const componentById = new Map(components.map((component) => [component.componentId, component]))
  const layerIds = recoveredLayers.map((layer) => layer.costLayerId)

  const layerDetails = layerIds.length === 0
    ? []
    : await tx.costLayer.findMany({
        where: { id: { in: layerIds } },
        select: {
          id: true,
          receivedQty: true,
          sourceLines: {
            select: {
              sourceProductId: true,
              qty: true,
              totalCostBase: true,
            },
          },
        },
      })
  const layerDetailById = new Map(layerDetails.map((layer) => [layer.id, layer]))

  const historicalQtyByComponent = new Map<string, number>()
  const historicalCostByComponent = new Map<string, Prisma.Decimal>()
  let residualCostBase = new Prisma.Decimal(0)
  let usedLegacyFallback = false

  for (const recoveredLayer of recoveredLayers) {
    const layerDetail = layerDetailById.get(recoveredLayer.costLayerId)
    const entryCostBase = new Prisma.Decimal(recoveredLayer.qty * recoveredLayer.unitCostBase)

    if (!layerDetail || layerDetail.sourceLines.length === 0) {
      usedLegacyFallback = true
      residualCostBase = residualCostBase.add(entryCostBase)
      continue
    }

    const receivedQty = Number(layerDetail.receivedQty)
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      usedLegacyFallback = true
      residualCostBase = residualCostBase.add(entryCostBase)
      continue
    }

    const ratio = recoveredLayer.qty / receivedQty
    let allocatedEntryCostBase = new Prisma.Decimal(0)

    for (const sourceLine of layerDetail.sourceLines) {
      const allocatedQty = Number(sourceLine.qty) * ratio
      const allocatedCostBase = new Prisma.Decimal(sourceLine.totalCostBase).mul(ratio)
      allocatedEntryCostBase = allocatedEntryCostBase.add(allocatedCostBase)

      if (!componentById.has(sourceLine.sourceProductId)) {
        residualCostBase = residualCostBase.add(allocatedCostBase)
        continue
      }

      historicalQtyByComponent.set(
        sourceLine.sourceProductId,
        (historicalQtyByComponent.get(sourceLine.sourceProductId) ?? 0) + allocatedQty,
      )
      historicalCostByComponent.set(
        sourceLine.sourceProductId,
        (historicalCostByComponent.get(sourceLine.sourceProductId) ?? new Prisma.Decimal(0)).add(allocatedCostBase),
      )
    }

    const roundingResidual = entryCostBase.sub(allocatedEntryCostBase)
    if (roundingResidual.abs().gt(0.000001)) {
      residualCostBase = residualCostBase.add(roundingResidual)
    }
  }

  const currentComponentQtyById = new Map(
    components.map((component) => [component.componentId, Number(component.qty) * qtyPlanned]),
  )
  const residualBasis = await Promise.all(components.map(async (component) => {
    const totalQty = currentComponentQtyById.get(component.componentId) ?? 0
    const historicalQty = historicalQtyByComponent.get(component.componentId) ?? 0
    const uncoveredQty = Math.max(0, totalQty - historicalQty)
    const avgUnitCost = uncoveredQty > 0
      ? await getAverageUnitCost(tx, component.componentId, warehouseId)
      : 0
    return {
      componentId: component.componentId,
      totalQty,
      uncoveredQty,
      basis: avgUnitCost > 0 ? avgUnitCost * uncoveredQty : uncoveredQty,
    }
  }))

  const totalResidualBasis = residualBasis.reduce((sum, component) => sum + component.basis, 0)
  const fallbackResidualBasis = residualBasis.reduce((sum, component) => sum + component.totalQty, 0)
  if (usedLegacyFallback && residualCostBase.abs().gt(0.000001)) {
    console.warn(
      `Disassembly recovery used average-cost fallback for ${recoveredLayers.length} recovered layer(s) ` +
      `because historical source-line provenance was incomplete.`,
    )
  }

  return residualBasis
    .filter((component) => component.totalQty > 0)
    .map((component) => {
      const historicalCost = historicalCostByComponent.get(component.componentId) ?? new Prisma.Decimal(0)
      const allocationBasis = totalResidualBasis > 0 ? component.basis : component.totalQty
      const residualAllocatedCost = residualCostBase.gt(0) && allocationBasis > 0
        ? residualCostBase.mul(allocationBasis).div(totalResidualBasis > 0 ? totalResidualBasis : fallbackResidualBasis || 1)
        : new Prisma.Decimal(0)
      return {
        componentId: component.componentId,
        totalQty: component.totalQty,
        totalCostBase: historicalCost.add(residualAllocatedCost),
      }
    })
}

export async function updateManufacturingOrderStatus(
  id: string,
  status: ProductionOrderStatus,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('manufacturing')
    // Initial read for post-tx logging (non-authoritative — the tx re-reads under lock)
    const orderPreview = await db.productionOrder.findUnique({
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
        manufacturingCostLines: {
          select: { description: true, amountBase: true, accountCode: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })
    if (!orderPreview) return { success: false, error: 'Order not found.' }

    const now = new Date()
    const isAssembly = orderPreview.orderType === 'ASSEMBLY'

    // When completing: execute stock movements in a transaction
    if (status === 'COMPLETED') {
      await db.$transaction(async (tx) => {
        // Lock the production order row and re-read inside the tx to
        // prevent concurrent completion from duplicating stock mutations.
        await tx.$executeRaw`SELECT id FROM production_orders WHERE id = ${id} FOR UPDATE`
        const order = await tx.productionOrder.findUnique({
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
            manufacturingCostLines: {
              select: { id: true, description: true, amountBase: true, accountCode: true },
              orderBy: { sortOrder: 'asc' },
            },
          },
        })
        if (!order) throw new Error('Order not found')
        if (order.status === 'COMPLETED') return // idempotent — already completed
        if (order.status !== 'IN_PROGRESS' && order.status !== 'DRAFT') {
          throw new Error(`Cannot complete a production order in ${order.status} status`)
        }

        const qtyPlanned = Number(order.qtyPlanned)
        const components = order.outputProduct.productComponents
        const wasInProgress = order.status === 'IN_PROGRESS'
        const totalManufacturingCostBase = order.manufacturingCostLines.reduce(
          (sum, line) => sum.add(new Prisma.Decimal(line.amountBase)),
          new Prisma.Decimal(0),
        )

        if (isAssembly) {
          // ASSEMBLY: deduct components (and release reservation), add output product
          let totalAssemblyCostBase = new Prisma.Decimal(0)
          const assemblySourceLines: Array<{
            sourceProductId: string
            sourceCostLayerId: string
            qty: number
            unitCostBase: number
            totalCostBase: number
          }> = []
          for (const comp of components) {
            const totalQty = Number(comp.qty) * qtyPlanned
            await assertStockAvailable(tx, comp.componentId, order.warehouseId, totalQty, {
              includeReserved: wasInProgress,
              requireReserved: wasInProgress,
            })
            const consumed = await consumeFifoLayersStrict(tx, comp.componentId, order.warehouseId, totalQty)
            totalAssemblyCostBase = totalAssemblyCostBase.add(new Prisma.Decimal(consumed.totalCost))
            assemblySourceLines.push(...consumed.consumed.map((entry) => ({
              sourceProductId: comp.componentId,
              sourceCostLayerId: entry.costLayerId,
              qty: entry.qty,
              unitCostBase: entry.unitCostBase,
              totalCostBase: Math.round(entry.qty * entry.unitCostBase * 1000000) / 1000000,
            })))

            // Deduct component stock + release reservation if was in progress
            await tx.stockLevel.update({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              data: {
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
          // Fold per-run manufacturing overhead (labour, machine, utilities,
          // etc.) into the output cost layer alongside the consumed component
          // costs. Spread equally across qtyPlanned.
          const outputTotalCostBase = totalAssemblyCostBase.add(totalManufacturingCostBase)
          const outputLayerId = await createCostLayer(tx, {
            productId: order.outputProductId,
            warehouseId: order.warehouseId,
            qty: qtyPlanned,
            unitCostBase: outputTotalCostBase.div(new Prisma.Decimal(qtyPlanned)).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
            productionOrderId: id,
            isOpeningStock: false,
          })
          await addCostLayerSourceLines(tx, outputLayerId, assemblySourceLines)

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
          await assertStockAvailable(tx, order.outputProductId, order.warehouseId, qtyPlanned, {
            includeReserved: wasInProgress,
            requireReserved: wasInProgress,
          })
          const recoveredCost = await consumeFifoLayersStrict(tx, order.outputProductId, order.warehouseId, qtyPlanned)
          const totalRecoveredCostBase = recoveredCost.consumed.reduce(
            (sum, entry) => sum.add(new Prisma.Decimal(entry.qty * entry.unitCostBase)),
            new Prisma.Decimal(0),
          )
          // Manufacturing overhead capitalises proportionally onto the
          // recovered components by scaling each plan entry's allocated
          // cost by (recovered + overhead) / recovered. When recovered
          // cost is zero (assembled stock had zero cost layers) the
          // overhead can't be capitalised this way — it's still booked as
          // expense via the journal below.
          const recoveryScaleFactor = totalRecoveredCostBase.gt(0)
            ? totalRecoveredCostBase.add(totalManufacturingCostBase).div(totalRecoveredCostBase)
            : new Prisma.Decimal(1)
          const recoveryPlan = await buildDisassemblyRecoveryPlan(
            tx,
            recoveredCost.consumed,
            components,
            order.warehouseId,
            qtyPlanned,
          )
          await tx.stockLevel.update({
            where: { productId_warehouseId: { productId: order.outputProductId, warehouseId: order.warehouseId } },
            data: {
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
            const plannedRecovery = recoveryPlan.find((entry) => entry.componentId === comp.componentId)
            const totalQty = plannedRecovery?.totalQty ?? (Number(comp.qty) * qtyPlanned)
            const allocatedCost = (plannedRecovery?.totalCostBase ?? new Prisma.Decimal(0)).mul(recoveryScaleFactor)
            const recoveredUnitCost = totalQty > 0
              ? allocatedCost.div(new Prisma.Decimal(totalQty)).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
              : new Prisma.Decimal(0)

            await tx.stockLevel.upsert({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              create: { productId: comp.componentId, warehouseId: order.warehouseId, quantity: totalQty },
              update: { quantity: { increment: totalQty } },
            })
            const componentLayerId = await createCostLayer(tx, {
              productId: comp.componentId,
              warehouseId: order.warehouseId,
              qty: totalQty,
              unitCostBase: recoveredUnitCost.toNumber(),
              productionOrderId: id,
            })
            if (allocatedCost.gt(0) && totalRecoveredCostBase.gt(0)) {
              const componentShare = allocatedCost.div(totalRecoveredCostBase)
              await addCostLayerSourceLines(tx, componentLayerId, recoveredCost.consumed.map((entry) => ({
                sourceProductId: order.outputProductId,
                sourceCostLayerId: entry.costLayerId,
                qty: entry.qty * componentShare.toNumber(),
                unitCostBase: entry.unitCostBase,
                totalCostBase: entry.qty * entry.unitCostBase * componentShare.toNumber(),
              })))
            }

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

      // Queue accounting journal for the per-run manufacturing overhead.
      // Components moving from one inventory SKU to another (assembly) or
      // the reverse (disassembly) net to zero on the Inventory account, so
      // the journal only needs to capture the overhead leg:
      //   DR Inventory (assembled output / recovered components)
      //   CR Manufacturing Overhead (per-line account, default from settings)
      // Each cost line lands on its own credit row so labour, machine, etc.
      // can post to distinct accounts.
      const totalManufacturingCostBaseForJournal = orderPreview.manufacturingCostLines.reduce(
        (sum, line) => sum + Number(line.amountBase),
        0,
      )
      if (totalManufacturingCostBaseForJournal > 0) {
        try {
          const settings = await getAccountingSettings()
          const defaultOverheadAccount = settings.manufacturingOverheadAccount
          const inventoryAccount = settings.inventoryAccount
          if (inventoryAccount) {
            const directionLabel = isAssembly ? 'assembly' : 'disassembly'
            const reference = `MFG: ${orderPreview.reference}`
            const narration = `Manufacturing overhead — ${directionLabel} of ${orderPreview.outputProduct.sku} (${Number(orderPreview.qtyPlanned)} units)`
            const totalRounded = Math.round(totalManufacturingCostBaseForJournal * 100) / 100
            const lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = [
              { accountCode: inventoryAccount, description: `Manufacturing overhead capitalised (${orderPreview.outputProduct.sku})`, debit: totalRounded },
            ]
            for (const costLine of orderPreview.manufacturingCostLines) {
              const account = costLine.accountCode || defaultOverheadAccount
              const amount = Math.round(Number(costLine.amountBase) * 100) / 100
              if (!account || amount <= 0) continue
              lines.push({ accountCode: account, description: costLine.description, credit: amount })
            }
            // Only post if every credit line has an account; otherwise the
            // user hasn't configured a default overhead account yet — skip
            // and log so the issue is visible.
            const allLinesHaveAccount = lines.every((l) => l.accountCode)
            if (allLinesHaveAccount && lines.length > 1) {
              await queueAccountingSync({
                type: 'MANUFACTURING_JOURNAL',
                referenceType: 'ProductionOrder',
                referenceId: id,
                payload: {
                  date: now.toISOString().slice(0, 10),
                  reference,
                  narration,
                  lines,
                },
              })
            } else if (!allLinesHaveAccount) {
              await logActivity({
                entityType: 'STOCK_ADJUSTMENT',
                entityId: id,
                tag: 'manufacturing',
                level: 'WARNING',
                action: 'manufacturing_journal_skipped',
                description: `Skipped manufacturing-overhead journal for ${orderPreview.reference}: configure a default Manufacturing Overhead account in Settings.`,
              })
            }
          }
        } catch (e) {
          // Accounting queue errors must never block the main flow.
          await logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: id,
            tag: 'manufacturing',
            level: 'ERROR',
            action: 'manufacturing_journal_failed',
            description: `Failed to queue manufacturing-overhead journal for ${orderPreview.reference}: ${e instanceof Error ? e.message : String(e)}`,
          })
        }
      }

      // Log individual stock movements (fire-and-forget, after transaction)
      // Use orderPreview for logging — the inner `order` is scoped to the tx
      const qtyPlanned = Number(orderPreview.qtyPlanned)
      if (isAssembly) {
        for (const comp of orderPreview.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          await logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'production_out',
            description: `${orderPreview.reference}: consumed ${totalQty} units of component for ${orderPreview.outputProduct.sku} assembly`,
            metadata: { movementType: 'PRODUCTION_OUT', qty: totalQty, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
          })
        }
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: orderPreview.outputProductId,
          tag: 'stock',
          action: 'production_in',
          description: `${orderPreview.reference}: produced ${qtyPlanned} units of ${orderPreview.outputProduct.sku}`,
          metadata: { movementType: 'PRODUCTION_IN', qty: qtyPlanned, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
        })
      } else {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: orderPreview.outputProductId,
          tag: 'stock',
          action: 'production_out',
          description: `${orderPreview.reference}: disassembled ${qtyPlanned} units of ${orderPreview.outputProduct.sku}`,
          metadata: { movementType: 'PRODUCTION_OUT', qty: qtyPlanned, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
        })
        for (const comp of orderPreview.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          await logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'production_in',
            description: `${orderPreview.reference}: recovered ${totalQty} units from disassembly of ${orderPreview.outputProduct.sku}`,
            metadata: { movementType: 'PRODUCTION_IN', qty: totalQty, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
          })
        }
      }
    } else if (status === 'IN_PROGRESS') {
      const qtyPlanned = Number(orderPreview.qtyPlanned)
      // Reserve inside the same locked transaction as the status transition.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM production_orders WHERE id = ${id} FOR UPDATE`
        const lockedOrder = await tx.productionOrder.findUnique({
          where: { id },
          select: { status: true },
        })
        if (!lockedOrder) throw new Error('Order not found')
        if (lockedOrder.status !== 'DRAFT') {
          throw new Error(`Cannot start a production order in ${lockedOrder.status} status`)
        }

        if (isAssembly) {
          for (const comp of orderPreview.outputProduct.productComponents) {
            const totalQty = Number(comp.qty) * qtyPlanned
            await reserveAvailableStock(tx, comp.componentId, orderPreview.warehouseId, totalQty)
          }
        } else {
          await reserveAvailableStock(tx, orderPreview.outputProductId, orderPreview.warehouseId, qtyPlanned)
        }
        await tx.productionOrder.update({ where: { id }, data: { status, startedAt: now } })
      })

      // Log stock reservations
      if (isAssembly) {
        for (const comp of orderPreview.outputProduct.productComponents) {
          const totalQty = Number(comp.qty) * qtyPlanned
          await logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: comp.componentId,
            tag: 'stock',
            action: 'reserved',
            description: `${orderPreview.reference}: reserved ${totalQty} units of component for ${orderPreview.outputProduct.sku} assembly`,
            metadata: { qty: totalQty, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
          })
        }
      } else {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: orderPreview.outputProductId,
          tag: 'stock',
          action: 'reserved',
          description: `${orderPreview.reference}: reserved ${qtyPlanned} units of ${orderPreview.outputProduct.sku} for disassembly`,
          metadata: { qty: qtyPlanned, warehouseId: orderPreview.warehouseId, moReference: orderPreview.reference },
        })
      }
    } else if (status === 'CANCELLED' && orderPreview.status === 'IN_PROGRESS') {
      const qtyPlanned = Number(orderPreview.qtyPlanned)
      // Release reservations when cancelling an in-progress order
      await db.$transaction(async (tx) => {
        if (isAssembly) {
          for (const comp of orderPreview.outputProduct.productComponents) {
            const totalQty = Number(comp.qty) * qtyPlanned
            await tx.stockLevel.update({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: orderPreview.warehouseId } },
              data: { reservedQty: { decrement: totalQty } },
            })
          }
        } else {
          await tx.stockLevel.update({
            where: { productId_warehouseId: { productId: orderPreview.outputProductId, warehouseId: orderPreview.warehouseId } },
            data: { reservedQty: { decrement: qtyPlanned } },
          })
        }
        await tx.productionOrder.update({ where: { id }, data: { status } })
      })

      // Log reservation release
      await logActivity({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: id,
        tag: 'stock',
        action: 'reservation_released',
        description: `${orderPreview.reference}: released stock reservations due to cancellation`,
        metadata: { moReference: orderPreview.reference, warehouseId: orderPreview.warehouseId },
      })
    } else {
      // CANCELLED from DRAFT — no reservations to release
      await db.productionOrder.update({ where: { id }, data: { status } })
    }

    const qtyPlannedLog = Number(orderPreview.qtyPlanned)
    const actionDesc = status === 'COMPLETED'
      ? `Completed ${orderPreview.reference} — ${isAssembly ? 'assembled' : 'disassembled'} ${qtyPlannedLog} units of ${orderPreview.outputProduct.sku}, stock updated`
      : `Updated ${orderPreview.reference} status to ${status}`

    await logActivity({
      entityType: 'PRODUCTION_ORDER',
      entityId: id,
      tag: 'manufacturing',
      action: 'status_changed',
      description: actionDesc,
      metadata: status === 'COMPLETED' ? { orderType: orderPreview.orderType, qty: qtyPlannedLog, sku: orderPreview.outputProduct.sku } : undefined,
    })

    revalidatePath('/manufacturing')
    revalidatePath(`/manufacturing/${id}`)
    revalidatePath('/inventory')
    revalidatePath('/stock-control')
    try {
      await enqueueStockSync(
        [
          orderPreview.outputProductId,
          ...orderPreview.outputProduct.productComponents.map((comp) => comp.componentId),
        ],
        'IMS_CHANGE',
      )
    } catch (syncError) {
      console.error(syncError)
    }
    return { success: true }
  } catch (e) {
    await logActivity({
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
  currency: string
  fxRateToBase: number
  components: {
    componentId: string
    componentSku: string
    componentName: string
    componentBarcode: string | null
    componentImageUrl: string | null
    qtyPerUnit: number
  }[]
  manufacturingCostLines: ManufacturingCostLineRow[]
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
      currency: true,
      fxRateToBase: true,
      outputProduct: {
        select: {
          id: true,
          sku: true,
          name: true,
          barcode: true,
          imageUrl: true,
          parent: { select: { imageUrl: true } },
          productComponents: {
            select: {
              componentId: true,
              qty: true,
              component: { select: { sku: true, name: true, barcode: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      warehouse: { select: { id: true, name: true, code: true } },
      manufacturer: { select: { id: true, name: true, email: true } },
      manufacturingCostLines: {
        select: { id: true, description: true, amountForeign: true, amountBase: true, accountCode: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
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
    productImageUrl: o.outputProduct.imageUrl ?? o.outputProduct.parent?.imageUrl ?? null,
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
    currency: o.currency,
    fxRateToBase: Number(o.fxRateToBase),
    components: o.outputProduct.productComponents.map((c) => ({
      componentId: c.componentId,
      componentSku: c.component.sku,
      componentName: c.component.name,
      componentBarcode: c.component.barcode,
      componentImageUrl: c.component.imageUrl ?? c.component.parent?.imageUrl ?? null,
      qtyPerUnit: Number(c.qty),
    })),
    manufacturingCostLines: o.manufacturingCostLines.map((l) => ({
      id: l.id,
      description: l.description,
      amountForeign: Number(l.amountForeign),
      amountBase: Number(l.amountBase),
      accountCode: l.accountCode,
      sortOrder: l.sortOrder,
    })),
  }
}

// ---------------------------------------------------------------------------
// Manufacturing cost lines (per-run overhead: labour, machine, etc.)
// ---------------------------------------------------------------------------

export type ManufacturingCostLineRow = {
  id: string
  description: string
  amountForeign: number
  amountBase: number
  accountCode: string | null
  sortOrder: number
}

export type ManufacturingCostLineInput = {
  description: string
  amountForeign: number
  accountCode?: string | null
}

export async function getManufacturingCostLines(productionOrderId: string): Promise<ManufacturingCostLineRow[]> {
  await requireAuth()
  const rows = await db.manufacturingCostLine.findMany({
    where: { productionOrderId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, description: true, amountForeign: true, amountBase: true, accountCode: true, sortOrder: true },
  })
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    amountForeign: Number(r.amountForeign),
    amountBase: Number(r.amountBase),
    accountCode: r.accountCode,
    sortOrder: r.sortOrder,
  }))
}

/**
 * Recalculates the unit cost on cost layers produced by this production
 * order to reflect the current sum of manufacturingCostLines, and posts
 * COGS reclass entries on layers that have been (partially) consumed.
 *
 * Mirror of recalculateDirectLandedCosts but simpler: there's at most one
 * output cost layer for assembly; for disassembly the overhead is split
 * across recovered-component layers proportionally to their original
 * (component-only) base cost from CostLayerSourceLine.
 *
 * Must be called inside a transaction. Returns the net COGS delta in
 * base currency so the caller can queue a reclass journal post-tx.
 */
async function recalculateManufacturingCostLayers(
  tx: Prisma.TransactionClient,
  productionOrderId: string,
): Promise<number> {
  const po = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: {
      status: true,
      qtyProduced: true,
      manufacturingCostLines: { select: { amountBase: true } },
    },
  })
  if (!po || po.status !== 'COMPLETED') return 0

  const currentMfgCost = po.manufacturingCostLines.reduce(
    (sum, line) => sum + Number(line.amountBase),
    0,
  )

  const layers = await tx.costLayer.findMany({
    where: { productionOrderId },
    select: {
      id: true,
      receivedQty: true,
      remainingQty: true,
      unitCostBase: true,
      sourceLines: { select: { totalCostBase: true } },
    },
  })
  if (layers.length === 0) return 0

  const layerInfos = layers.map((l) => ({
    id: l.id,
    receivedQty: Number(l.receivedQty),
    remainingQty: Number(l.remainingQty),
    oldUnitCostBase: Number(l.unitCostBase),
    base: l.sourceLines.reduce((s, sl) => s + Number(sl.totalCostBase), 0),
  }))
  const recomputed = recomputeManufacturingUnitCosts(
    layerInfos.map(({ id, receivedQty, base }) => ({ id, receivedQty, base })),
    currentMfgCost,
  )
  const oldByLayer = new Map(layerInfos.map((l) => [l.id, l]))

  let netCogsDeltaBase = 0
  for (const r of recomputed) {
    const li = oldByLayer.get(r.layerId)
    if (!li) continue
    if (Math.abs(r.newUnitCostBase - li.oldUnitCostBase) < 1e-6) continue

    await tx.costLayer.update({
      where: { id: li.id },
      data: { unitCostBase: r.newUnitCostBase },
    })

    const returnedQty = await getReturnedQtyForCostLayer(tx, li.id)
    const consumedQty = li.receivedQty - li.remainingQty - returnedQty
    if (consumedQty > 0) {
      netCogsDeltaBase += consumedQty * (r.newUnitCostBase - li.oldUnitCostBase)
    }

    await updateSnapshotsForCostLayerChange(tx, li.id, r.newUnitCostBase)
    await refreshShipmentCogsForCostLayerChange(tx, li.id)
    await refreshSalesOrderLineCogsForCostLayerChange(tx, li.id)
  }

  return Math.round(netCogsDeltaBase * 1_000_000) / 1_000_000
}

/**
 * Replace the manufacturing cost lines on a production order. If the
 * order is COMPLETED, this also recalculates the produced cost layers
 * and queues a reclass journal for the COGS delta on already-consumed
 * (shipped/sold) units.
 */
export async function updateManufacturingCostLines(
  productionOrderId: string,
  lines: ManufacturingCostLineInput[],
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('manufacturing')

    const po = await db.productionOrder.findUnique({
      where: { id: productionOrderId },
      select: { id: true, reference: true, status: true, fxRateToBase: true, outputProductId: true },
    })
    if (!po) return { success: false, error: 'Production order not found.' }

    const fxRate = Number(po.fxRateToBase) || 1
    const cleaned = lines
      .filter((l) => l.description.trim().length > 0 && Number.isFinite(l.amountForeign))
      .map((l, idx) => ({
        description: l.description.trim(),
        amountForeign: Math.round(Number(l.amountForeign) * 10000) / 10000,
        amountBase: Math.round(Number(l.amountForeign) * fxRate * 10000) / 10000,
        accountCode: l.accountCode?.trim() || null,
        sortOrder: idx,
      }))

    let cogsDeltaBase = 0
    let oldTotal = 0
    let newTotal = 0

    await db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM production_orders WHERE id = ${productionOrderId} FOR UPDATE`,
      )
      const existing = await tx.manufacturingCostLine.findMany({
        where: { productionOrderId },
        select: { amountBase: true },
      })
      oldTotal = existing.reduce((s, l) => s + Number(l.amountBase), 0)
      newTotal = cleaned.reduce((s, l) => s + l.amountBase, 0)

      await tx.manufacturingCostLine.deleteMany({ where: { productionOrderId } })
      if (cleaned.length > 0) {
        await tx.manufacturingCostLine.createMany({
          data: cleaned.map((l) => ({
            productionOrderId,
            description: l.description,
            amountForeign: l.amountForeign,
            amountBase: l.amountBase,
            accountCode: l.accountCode,
            sortOrder: l.sortOrder,
          })),
        })
      }

      // If completed, recalc produced cost layers + downstream snapshots.
      if (po.status === 'COMPLETED') {
        cogsDeltaBase = await recalculateManufacturingCostLayers(tx, productionOrderId)
      }
    }, { maxWait: 5000, timeout: 20000 })

    revalidatePath('/manufacturing')
    revalidatePath(`/manufacturing/${productionOrderId}`)

    if (po.status === 'COMPLETED' && Math.abs(cogsDeltaBase) > 0.005) {
      // Post a reclass journal: if newCost > oldCost (delta > 0), shipped
      // units were under-costed; we need to increase COGS and decrease
      // Inventory by the same amount. Reverse for a decrease.
      try {
        const settings = await getAccountingSettings()
        if (settings.cogsAccount && settings.inventoryAccount) {
          const absDelta = Math.round(Math.abs(cogsDeltaBase) * 100) / 100
          const lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> =
            cogsDeltaBase > 0
              ? [
                  { accountCode: settings.cogsAccount, description: `Manufacturing-cost reclass (${po.reference})`, debit: absDelta },
                  { accountCode: settings.inventoryAccount, description: `Manufacturing-cost reclass (${po.reference})`, credit: absDelta },
                ]
              : [
                  { accountCode: settings.inventoryAccount, description: `Manufacturing-cost reclass (${po.reference})`, debit: absDelta },
                  { accountCode: settings.cogsAccount, description: `Manufacturing-cost reclass (${po.reference})`, credit: absDelta },
                ]
          await queueAccountingSync({
            type: 'MANUFACTURING_RECLASS',
            referenceType: 'ProductionOrder',
            referenceId: productionOrderId,
            payload: {
              date: new Date().toISOString().slice(0, 10),
              reference: `MFG-RECLASS: ${po.reference}`,
              narration: `COGS reclass for retro manufacturing-cost change on ${po.reference} (delta ${cogsDeltaBase >= 0 ? '+' : ''}${cogsDeltaBase.toFixed(4)})`,
              lines,
            },
          })
        }
      } catch (e) {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: productionOrderId,
          tag: 'manufacturing',
          level: 'ERROR',
          action: 'manufacturing_reclass_failed',
          description: `Failed to queue reclass journal for ${po.reference}: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: productionOrderId,
      tag: 'manufacturing',
      level: 'INFO',
      action: 'manufacturing_cost_lines_updated',
      description: `Updated manufacturing cost lines for ${po.reference}: ${cleaned.length} line(s), total ${newTotal.toFixed(2)} (was ${oldTotal.toFixed(2)})`,
      metadata: { productionOrderId, lineCount: cleaned.length, oldTotalBase: oldTotal, newTotalBase: newTotal, cogsDeltaBase },
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

