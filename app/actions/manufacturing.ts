'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { queueAccountingSyncTx, getAccountingSettings, isAccountingSyncTypeEnabled } from '@/lib/accounting'
import {
  addCostLayerSourceLines,
  consumeFifoLayersStrict,
  createCostLayer,
  getReturnedQtyForCostLayer,
  refreshShipmentCogsForCostLayerChange,
  refreshSalesOrderLineCogsForCostLayerChange,
  updateSnapshotsForCostLayerChange,
} from '@/lib/cost-layers'
import {
  buildOverheadAccountDeltas,
  compareAccountCodes,
  recomputeManufacturingUnitCosts,
  stableHash,
} from '@/lib/domain/manufacturing/production-costing'
import {
  buildDisassemblyRecoveryPlan,
  calculateRequiredComponentQty,
} from '@/lib/domain/manufacturing/component-consumption'
import {
  evaluateProductionOrderCompletion,
  evaluateProductionOrderCancellation,
  evaluateProductionOrderStart,
} from '@/lib/domain/manufacturing/manufacturing-state'
import { toInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
} from '@/lib/domain/math/decimal'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'
import { COMPONENT_PRODUCT_STATUSES, OPERATIONAL_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { Prisma, type ProductionOrderStatus, type ProductionOrderType } from '@/app/generated/prisma/client'

type JournalLine = { accountCode: string; description: string; debit?: number; credit?: number }

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function manufacturingQtyBoundaryNumber(value: Prisma.Decimal): number {
  // decimal-boundary-ok: server-action-boundary (Prisma stock/cost-layer APIs currently accept number quantities)
  return value.toNumber()
}

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
    // Surface skip reason post-tx (set inside the tx). Lets us log a
    // readable warning without holding the tx open.
    let manufacturingJournalSkipReason: string | null = null
    let disassemblyFallback = null as { recoveredLayerCount: number } | null

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
        const completionDecision = evaluateProductionOrderCompletion(order.status)
        if (!completionDecision.allowed) throw new Error(completionDecision.error)
        if (completionDecision.action === 'already-completed') return

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
            qty: Prisma.Decimal
            unitCostBase: Prisma.Decimal
            totalCostBase: number
          }> = []
          for (const comp of components) {
            const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
            await assertStockAvailable(tx, comp.componentId, order.warehouseId, totalQty, {
              includeReserved: wasInProgress,
              requireReserved: wasInProgress,
            })
            const consumed = await consumeFifoLayersStrict(tx, comp.componentId, order.warehouseId, totalQty)
            totalAssemblyCostBase = totalAssemblyCostBase.add(consumed.totalCost)
            assemblySourceLines.push(...consumed.consumed.map((entry) => ({
              sourceProductId: comp.componentId,
              sourceCostLayerId: entry.costLayerId,
              qty: entry.qty,
              unitCostBase: entry.unitCostBase,
              totalCostBase: entry.qty.mul(entry.unitCostBase).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
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
                ...buildStockMovementValueFieldsFromConsumed(consumed.consumed),
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
              ...buildStockMovementValueFieldsFromTotal({
                qty: qtyPlanned,
                totalValueBase: outputTotalCostBase,
              }),
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
            (sum, entry) => sum.add(entry.qty.mul(entry.unitCostBase)),
            new Prisma.Decimal(0),
          )
          // Manufacturing overhead capitalises onto the recovered
          // component cost layers. Two strategies:
          //   - Proportional (totalRecoveredCostBase > 0): each component
          //     gets a share = its allocatedCost / totalRecoveredCostBase.
          //   - Equal-split fallback (totalRecoveredCostBase === 0, i.e.
          //     the assembled stock had zero-cost layers): distribute the
          //     overhead equally across components so the layers carry the
          //     debit that the journal posts to Inventory. Without this
          //     fallback the journal would over-state Inventory relative
          //     to the layer-derived stock value.
          const useEqualSplitOverhead = totalRecoveredCostBase.eq(0) && components.length > 0
          const equalSplitOverheadPerComponent = useEqualSplitOverhead
            ? totalManufacturingCostBase.div(new Prisma.Decimal(components.length))
            : new Prisma.Decimal(0)
          const proportionalScaleFactor = totalRecoveredCostBase.gt(0)
            ? totalRecoveredCostBase.add(totalManufacturingCostBase).div(totalRecoveredCostBase)
            : new Prisma.Decimal(1)
          const recoveryPlan = await buildDisassemblyRecoveryPlan(
            tx,
            recoveredCost.consumed,
            components,
            order.warehouseId,
            qtyPlanned,
          )
          if (recoveryPlan.usedLegacyFallback) {
            disassemblyFallback = { recoveredLayerCount: recoveryPlan.recoveredLayerCount }
          }
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
              ...buildStockMovementValueFieldsFromConsumed(recoveredCost.consumed),
              note: `${order.reference}: disassembled ${qtyPlanned} units`,
              referenceType: 'ProductionOrder',
              referenceId: id,
            },
          })

          for (const comp of components) {
            const plannedRecovery = recoveryPlan.entries.find((entry) => entry.componentId === comp.componentId)
            const totalQty = plannedRecovery?.totalQty ?? calculateRequiredComponentQty(comp, qtyPlanned)
            const baseAllocatedCost = plannedRecovery?.totalCostBase ?? new Prisma.Decimal(0)
            const allocatedCost = useEqualSplitOverhead
              ? baseAllocatedCost.add(equalSplitOverheadPerComponent)
              : baseAllocatedCost.mul(proportionalScaleFactor)
            const recoveredUnitCost = totalQty.gt(0)
              ? allocatedCost.div(totalQty).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
              : new Prisma.Decimal(0)
            // Recovery cost is a hard inventory valuation input; fail loudly
            // rather than writing a non-finite cost marker into cost layers.
            if (!recoveredUnitCost.isFinite()) {
              throw new Error(`Recovered unit cost is not finite for component ${comp.componentId}`)
            }
            const totalQtyNumber = manufacturingQtyBoundaryNumber(totalQty)

            await tx.stockLevel.upsert({
              where: { productId_warehouseId: { productId: comp.componentId, warehouseId: order.warehouseId } },
              create: { productId: comp.componentId, warehouseId: order.warehouseId, quantity: totalQtyNumber },
              update: { quantity: { increment: totalQtyNumber } },
            })
            const componentLayerId = await createCostLayer(tx, {
              productId: comp.componentId,
              warehouseId: order.warehouseId,
              qty: totalQtyNumber,
              unitCostBase: recoveredUnitCost.toNumber(),
              productionOrderId: id,
            })
            if (baseAllocatedCost.gt(0) && totalRecoveredCostBase.gt(0)) {
              const componentShare = baseAllocatedCost.div(totalRecoveredCostBase)
              await addCostLayerSourceLines(tx, componentLayerId, recoveredCost.consumed.map((entry) => ({
                sourceProductId: order.outputProductId,
                sourceCostLayerId: entry.costLayerId,
                qty: entry.qty.mul(componentShare),
                unitCostBase: entry.unitCostBase,
                totalCostBase: entry.qty.mul(entry.unitCostBase).mul(componentShare),
              })))
            }

            await tx.stockMovement.create({
              data: {
                type: 'PRODUCTION_IN',
                productId: comp.componentId,
                toWarehouseId: order.warehouseId,
                qty: totalQtyNumber,
                ...buildStockMovementValueFields({ qty: totalQtyNumber, unitCostBase: recoveredUnitCost }),
                note: `${order.reference}: recovered from disassembly of ${order.outputProduct.sku}`,
                referenceType: 'ProductionOrder',
                referenceId: id,
              },
            })
          }
        }

        // Queue manufacturing-overhead accounting journal IN-TX so the
        // journal is durable atomically with the cost layers + status flip.
        // Components moving from one inventory SKU to another (assembly) or
        // the reverse (disassembly) net to zero on the Inventory account, so
        // the journal only needs to capture the overhead leg:
        //   DR Inventory       (assembled output / recovered components)
        //   CR Manufacturing Overhead (per-line account, default from settings)
        // Each cost line lands on its own credit row so labour/machine/etc.
        // can post to distinct accounts. Idempotency key prevents double-
        // posting if completion is retried.
        const journalTotalBase = order.manufacturingCostLines.reduce(
          (sum, line) => sum + Number(line.amountBase),
          0,
        )
        if (journalTotalBase > 0) {
          const shouldPostJournal = await isAccountingSyncTypeEnabled('MANUFACTURING_JOURNAL')
          if (shouldPostJournal) {
            const settings = await getAccountingSettings()
            const defaultOverheadAccount = settings.manufacturingOverheadAccount
            const inventoryAccount = settings.inventoryAccount
            if (!inventoryAccount) {
              throw new Error('Cannot complete production order with manufacturing costs: configure Inventory account in Settings.')
            }
            const directionLabel = isAssembly ? 'assembly' : 'disassembly'
            const reference = `MFG: ${order.reference}`
            const narration = `Manufacturing overhead — ${directionLabel} of ${order.outputProduct.sku} (${Number(order.qtyPlanned)} units)`
            // Build credit rows. Track separately whether any line was
            // dropped due to a missing account so the DR can be balanced
            // — never let an unbalanced journal through.
            let creditTotalRounded = 0
            let missingAccount = false
            const defaultedCostLineIds: string[] = []
            const creditLines: Array<{ accountCode: string; description: string; credit: number }> = []
            for (const costLine of order.manufacturingCostLines) {
              const account = costLine.accountCode || defaultOverheadAccount
              const amount = roundCurrency(Number(costLine.amountBase))
              if (amount <= 0) continue
              if (!account) { missingAccount = true; break }
              if (!costLine.accountCode) defaultedCostLineIds.push(costLine.id)
              creditLines.push({ accountCode: account, description: costLine.description, credit: amount })
              creditTotalRounded += amount
            }
            if (missingAccount) {
              throw new Error('Cannot complete production order with manufacturing costs: configure default Manufacturing Overhead account in Settings or set an account override on each cost line.')
            } else if (creditLines.length === 0) {
              manufacturingJournalSkipReason = 'no positive-amount cost lines.'
            } else {
              const debitTotal = roundCurrency(creditTotalRounded)
              const lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = [
                { accountCode: inventoryAccount, description: `Manufacturing overhead capitalised (${order.outputProduct.sku})`, debit: debitTotal },
                ...creditLines,
              ]
              if (defaultedCostLineIds.length > 0) {
                await tx.manufacturingCostLine.updateMany({
                  where: { id: { in: defaultedCostLineIds } },
                  data: { accountCode: defaultOverheadAccount },
                })
              }
              await queueAccountingSyncTx(tx, {
                type: 'MANUFACTURING_JOURNAL',
                referenceType: 'ProductionOrder',
                referenceId: id,
                idempotencyKey: `MFG_JOURNAL:${id}:${stableHash({
                  completedAt: now.toISOString(),
                  lines,
                })}`,
                payload: {
                  date: now.toISOString().slice(0, 10),
                  reference,
                  narration,
                  lines,
                },
              })
            }
          }
        }

        // Update order status and qtyProduced
        await tx.productionOrder.update({
          where: { id },
          data: { status, completedAt: now, qtyProduced: qtyPlanned },
        })
      })

      // Surface the journal-skipped warning post-tx if needed (set inside tx)
      if (manufacturingJournalSkipReason) {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: id,
          tag: 'manufacturing',
          level: 'WARNING',
          action: 'manufacturing_journal_skipped',
          description: `Skipped manufacturing-overhead journal for ${orderPreview.reference}: ${manufacturingJournalSkipReason}`,
        })
      }

      if (disassemblyFallback) {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: id,
          tag: 'manufacturing',
          level: 'WARNING',
          action: 'disassembly_recovery_fallback',
          description: `${orderPreview.reference}: disassembly used average-cost fallback for ${disassemblyFallback.recoveredLayerCount} recovered layer(s) due to incomplete source-line provenance`,
          metadata: { recoveredLayerCount: disassemblyFallback.recoveredLayerCount, moReference: orderPreview.reference },
        })
      }

      // Log individual stock movements (fire-and-forget, after transaction)
      // Use orderPreview for logging — the inner `order` is scoped to the tx
      const qtyPlanned = Number(orderPreview.qtyPlanned)
      if (isAssembly) {
        for (const comp of orderPreview.outputProduct.productComponents) {
          const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
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
          const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
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
        const startDecision = evaluateProductionOrderStart(lockedOrder.status)
        if (!startDecision.allowed) throw new Error(startDecision.error)

        if (isAssembly) {
          for (const comp of orderPreview.outputProduct.productComponents) {
            const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
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
          const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
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
    } else if (status === 'CANCELLED') {
      const cancellationDecision = evaluateProductionOrderCancellation(orderPreview.status)
      if (!cancellationDecision.allowed) throw new Error(cancellationDecision.error)
      if (cancellationDecision.action !== 'release-reservations') {
        await db.$transaction(async (tx) => {
          await tx.manufacturingCostLine.deleteMany({ where: { productionOrderId: id } })
          await tx.productionOrder.update({ where: { id }, data: { status } })
        })
      } else {
        const qtyPlanned = Number(orderPreview.qtyPlanned)
        // Release reservations when cancelling an in-progress order
        await db.$transaction(async (tx) => {
          if (isAssembly) {
            for (const comp of orderPreview.outputProduct.productComponents) {
              const totalQty = manufacturingQtyBoundaryNumber(calculateRequiredComponentQty(comp, qtyPlanned))
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
          await tx.manufacturingCostLine.deleteMany({ where: { productionOrderId: id } })
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
      }
    } else {
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
    const message = toInventoryConstraintMessage(e, 'Failed to update status.')
    await logActivity({
      entityType: 'PRODUCTION_ORDER',
      entityId: id,
      tag: 'manufacturing',
      action: 'status_changed',
      level: 'ERROR',
      description: `Failed to update manufacturing order status: ${message}`,
    })
    return { success: false, error: message }
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
  productMpn: string | null
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
    componentMpn: string | null
    componentImageUrl: string | null
    qtyPerUnit: number
    requiredQty: number
    stockOnHand: number | null
    reservedQty: number | null
    availableForOrder: number | null
    shortageQty: number | null
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
          mpn: true,
          imageUrl: true,
          parent: { select: { imageUrl: true } },
          productComponents: {
            select: {
              componentId: true,
              qty: true,
              component: { select: { sku: true, name: true, barcode: true, mpn: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
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

  const componentIds = o.outputProduct.productComponents.map((c) => c.componentId)
  const componentStock = componentIds.length > 0
    ? await db.stockLevel.findMany({
        where: {
          warehouseId: o.warehouse.id,
          productId: { in: componentIds },
        },
        select: { productId: true, quantity: true, reservedQty: true },
      })
    : []
  const stockByProductId = new Map(componentStock.map((s) => [s.productId, s]))
  const includeReservedForThisOrder = o.orderType === 'ASSEMBLY' && o.status === 'IN_PROGRESS'
  const plannedQty = Number(o.qtyPlanned)

  return {
    id: o.id,
    reference: o.reference,
    orderType: o.orderType,
    status: o.status,
    productId: o.outputProduct.id,
    productSku: o.outputProduct.sku,
    productName: o.outputProduct.name,
    productBarcode: o.outputProduct.barcode,
    productMpn: o.outputProduct.mpn,
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
    components: o.outputProduct.productComponents.map((c) => {
      const qtyPerUnit = Number(c.qty)
      const requiredQty = qtyPerUnit * plannedQty
      const stock = stockByProductId.get(c.componentId)
      const stockOnHand = Number(stock?.quantity ?? 0)
      const reservedQty = Number(stock?.reservedQty ?? 0)
      const availableForOrder = includeReservedForThisOrder ? stockOnHand : stockOnHand - reservedQty
      return {
        componentId: c.componentId,
        componentSku: c.component.sku,
        componentName: c.component.name,
        componentBarcode: c.component.barcode,
        componentMpn: c.component.mpn,
        componentImageUrl: c.component.imageUrl ?? c.component.parent?.imageUrl ?? null,
        qtyPerUnit,
        requiredQty,
        stockOnHand,
        reservedQty,
        availableForOrder,
        shortageQty: Math.max(0, requiredQty - availableForOrder),
      }
    }),
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
  await requirePermission('manufacturing')
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
): Promise<{ cogsDeltaBase: number; inventoryDeltaBase: number }> {
  const po = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: {
      status: true,
      qtyProduced: true,
      manufacturingCostLines: { select: { amountBase: true } },
    },
  })
  if (!po || po.status !== 'COMPLETED') return { cogsDeltaBase: 0, inventoryDeltaBase: 0 }

  const currentMfgCost = po.manufacturingCostLines.reduce(
    (sum, line) => addMoney(sum, line.amountBase),
    toDecimal(0),
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
  if (layers.length === 0) return { cogsDeltaBase: 0, inventoryDeltaBase: 0 }

  const layerInfos = layers.map((l) => ({
    id: l.id,
    receivedQty: toDecimal(l.receivedQty),
    remainingQty: toDecimal(l.remainingQty),
    oldUnitCostBase: toDecimal(l.unitCostBase),
    base: l.sourceLines.reduce((sum, sl) => addMoney(sum, sl.totalCostBase), toDecimal(0)),
  }))
  const recomputed = recomputeManufacturingUnitCosts(
    layerInfos.map(({ id, receivedQty, base }) => ({ id, receivedQty, base })),
    currentMfgCost,
  )
  const oldByLayer = new Map(layerInfos.map((l) => [l.id, l]))

  let netCogsDeltaBase = toDecimal(0)
  let netInventoryDeltaBase = toDecimal(0)
  for (const r of recomputed) {
    const li = oldByLayer.get(r.layerId)
    if (!li) continue
    const unitDelta = subtractMoney(r.newUnitCostBase, li.oldUnitCostBase)
    if (unitDelta.abs().lt('0.000001')) continue

    await tx.costLayer.update({
      where: { id: li.id },
      data: { unitCostBase: r.newUnitCostBase },
    })

    const returnedQty = await getReturnedQtyForCostLayer(tx, li.id)
    const consumedQty = li.receivedQty.sub(li.remainingQty).sub(returnedQty)
    if (consumedQty.gt(0)) {
      netCogsDeltaBase = addMoney(netCogsDeltaBase, multiplyMoney(consumedQty, unitDelta))
    }
    // The remainingQty units stayed in inventory; their value just shifted
    // by unitDelta. Capture so the caller can post the inventory leg of
    // the reclass journal.
    if (li.remainingQty.gt(0)) {
      netInventoryDeltaBase = addMoney(netInventoryDeltaBase, multiplyMoney(li.remainingQty, unitDelta))
    }

    await updateSnapshotsForCostLayerChange(tx, li.id, r.newUnitCostBase)
    await refreshShipmentCogsForCostLayerChange(tx, li.id)
    await refreshSalesOrderLineCogsForCostLayerChange(tx, li.id)
  }

  return {
    cogsDeltaBase: roundQuantity(netCogsDeltaBase, 6).toNumber(),
    inventoryDeltaBase: roundQuantity(netInventoryDeltaBase, 6).toNumber(),
  }
}

/**
 * Replace the manufacturing cost lines on a production order. If the
 * order is COMPLETED, this also recalculates the produced cost layers
 * and queues a reclass journal that captures both the consumed-units
 * COGS delta and the remaining-inventory delta.
 *
 * Negative amounts are rejected — the journal model assumes overhead
 * lines are non-negative debits to inventory; a credit-style adjustment
 * should be modelled as a separate journal.
 */
export async function updateManufacturingCostLines(
  productionOrderId: string,
  lines: ManufacturingCostLineInput[],
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    await requirePermission('manufacturing')

    const po = await db.productionOrder.findUnique({
      where: { id: productionOrderId },
      select: { id: true, reference: true, status: true, fxRateToBase: true, outputProductId: true },
    })
    if (!po) return { success: false, error: 'Production order not found.' }
    if (po.status === 'CANCELLED') return { success: false, error: 'Cannot edit manufacturing cost lines on a cancelled production order.' }

    const fxRate = Number(po.fxRateToBase) || 1
    const parsed = lines
      .filter((l) => l.description.trim().length > 0 && Number.isFinite(l.amountForeign))
      .map((l, idx) => ({
        description: l.description.trim(),
        amountForeign: Math.round(Number(l.amountForeign) * 10000) / 10000,
        amountBase: Math.round(Number(l.amountForeign) * fxRate * 10000) / 10000,
        accountCode: l.accountCode?.trim() || null,
        sortOrder: idx,
      }))
    if (parsed.some((l) => l.amountForeign < 0 || l.amountBase < 0)) {
      return { success: false, error: 'Manufacturing cost amounts must be non-negative. Use a separate adjustment to credit inventory.' }
    }
    const cleaned = parsed.filter((l) => l.amountForeign > 0 && l.amountBase > 0)

    let cogsDeltaBase = 0
    let inventoryDeltaBase = 0
    let oldTotal = 0
    let newTotal = 0
    let cleanedForWrite = cleaned

    await db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM production_orders WHERE id = ${productionOrderId} FOR UPDATE`,
      )
      const existing = await tx.manufacturingCostLine.findMany({
        where: { productionOrderId },
        select: { amountBase: true, accountCode: true },
        orderBy: { sortOrder: 'asc' },
      })
      oldTotal = existing.reduce((s, l) => s + Number(l.amountBase), 0)
      newTotal = cleaned.reduce((s, l) => s + l.amountBase, 0)

      const shouldPostReclass = po.status === 'COMPLETED'
        ? await isAccountingSyncTypeEnabled('MANUFACTURING_RECLASS')
        : false
      const settings = shouldPostReclass ? await getAccountingSettings() : null
      if (shouldPostReclass && settings?.manufacturingOverheadAccount) {
        cleanedForWrite = cleaned.map((line) => (
          line.amountBase > 0 && !line.accountCode
            ? { ...line, accountCode: settings.manufacturingOverheadAccount }
            : line
        ))
      }
      const overheadAccountDeltas = settings
        ? buildOverheadAccountDeltas(existing, cleanedForWrite, settings.manufacturingOverheadAccount)
        : { deltas: new Map<string, number>(), missingAccount: false }
      if (shouldPostReclass && overheadAccountDeltas.missingAccount) {
        throw new Error('Cannot update completed manufacturing costs: configure default Manufacturing Overhead account in Settings or set an account override on each cost line.')
      }

      await tx.manufacturingCostLine.deleteMany({ where: { productionOrderId } })
      if (cleanedForWrite.length > 0) {
        await tx.manufacturingCostLine.createMany({
          data: cleanedForWrite.map((l) => ({
            productionOrderId,
            description: l.description,
            amountForeign: l.amountForeign,
            amountBase: l.amountBase,
            accountCode: l.accountCode,
            sortOrder: l.sortOrder,
          })),
        })
      }

      // If completed, recalc produced cost layers + downstream snapshots,
      // then queue the reclass journal IN-TX so the cost-layer change and
      // the GL post are durable atomically.
      if (po.status === 'COMPLETED') {
        const deltas = await recalculateManufacturingCostLayers(tx, productionOrderId)
        cogsDeltaBase = deltas.cogsDeltaBase
        inventoryDeltaBase = deltas.inventoryDeltaBase

        const totalDeltaBase = roundSix(cogsDeltaBase + inventoryDeltaBase)
        if (shouldPostReclass) {
          const journalLines: JournalLine[] = []

          const pushLine = (account: string, deltaSigned: number, role: 'capitalisation' | 'overhead-credit') => {
            const abs = roundCurrency(Math.abs(deltaSigned))
            if (abs < 0.005) return
            // Capitalisation accounts (Inventory, COGS) take a DR on a
            // positive delta. Overhead accounts take a CR on a positive
            // delta (mirroring the original completion journal).
            const isDebit = role === 'capitalisation' ? deltaSigned > 0 : deltaSigned < 0
            journalLines.push({
              accountCode: account,
              description: `Manufacturing-cost reclass (${po.reference})`,
              ...(isDebit ? { debit: abs } : { credit: abs }),
            })
          }

          const hasCapitalDelta = Math.abs(inventoryDeltaBase) >= 0.005 || Math.abs(cogsDeltaBase) >= 0.005
          if (hasCapitalDelta) {
            if (!settings || !settings.inventoryAccount || !settings.cogsAccount) {
              throw new Error('Cannot update completed manufacturing costs: configure Inventory and COGS accounts in Settings.')
            }
            pushLine(settings.inventoryAccount, inventoryDeltaBase, 'capitalisation')
            pushLine(settings.cogsAccount, cogsDeltaBase, 'capitalisation')
          }

          for (const [account, delta] of [...overheadAccountDeltas.deltas.entries()].sort(([a], [b]) => compareAccountCodes(a, b))) {
            pushLine(account, delta, 'overhead-credit')
          }

          // Sanity-check the balance — guard against rounding drift
          // producing an unbalanced journal that Xero/QB will reject.
          const debitSum = journalLines.reduce((s, l) => s + (l.debit ?? 0), 0)
          const creditSum = journalLines.reduce((s, l) => s + (l.credit ?? 0), 0)
          if (Math.abs(debitSum - creditSum) >= 0.01) {
            throw new Error(`Cannot update completed manufacturing costs: rounding produced an unbalanced reclass journal (DR ${debitSum.toFixed(2)} vs CR ${creditSum.toFixed(2)}).`)
          } else if (journalLines.length > 0) {
            const reclassIdempotencyKey = `MFG_RECLASS:${productionOrderId}:${stableHash({
              old: existing.map((line) => ({
                amountBase: Number(line.amountBase).toFixed(4),
                accountCode: line.accountCode ?? '',
              })),
              next: cleanedForWrite.map((line) => ({
                amountBase: line.amountBase.toFixed(4),
                accountCode: line.accountCode ?? '',
              })),
              cogsDeltaBase,
              inventoryDeltaBase,
            })}`
            await queueAccountingSyncTx(tx, {
              type: 'MANUFACTURING_RECLASS',
              referenceType: 'ProductionOrder',
              referenceId: productionOrderId,
              idempotencyKey: reclassIdempotencyKey,
              payload: {
                date: new Date().toISOString().slice(0, 10),
                reference: `MFG-RECLASS: ${po.reference}`,
                narration: `Reclass for retro manufacturing-cost change on ${po.reference} — overhead ${oldTotal.toFixed(2)} → ${newTotal.toFixed(2)}, total delta ${totalDeltaBase >= 0 ? '+' : ''}${totalDeltaBase.toFixed(4)} (COGS ${cogsDeltaBase.toFixed(4)} / Inventory ${inventoryDeltaBase.toFixed(4)})`,
                lines: journalLines,
              },
            })
          }
        }
      }

      await tx.activityLog.create({
        data: {
          entityType: 'STOCK_ADJUSTMENT',
          entityId: productionOrderId,
          tag: 'manufacturing',
          level: 'INFO',
          action: 'manufacturing_cost_lines_updated',
          description: `Updated manufacturing cost lines for ${po.reference}: ${cleaned.length} line(s), total ${newTotal.toFixed(2)} (was ${oldTotal.toFixed(2)})`,
          metadata: { productionOrderId, lineCount: cleaned.length, oldTotalBase: oldTotal, newTotalBase: newTotal, cogsDeltaBase, inventoryDeltaBase },
        },
      })
    }, { maxWait: 5000, timeout: 20000 })

    revalidatePath('/manufacturing')
    revalidatePath(`/manufacturing/${productionOrderId}`)

    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
