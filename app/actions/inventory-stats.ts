'use server'

import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Stock on Hand
// ---------------------------------------------------------------------------

export type StockOnHandRow = {
  productId: string
  sku: string
  name: string
  type: string
  stockUnit: string
  barcode: string | null
  lifecycleStatus: ProductLifecycleStatus
  warehouseCode: string
  warehouseName: string
  quantity: number
  reservedQty: number
  available: number
  inventoryValue: number  // FIFO cost
}

export async function getStockOnHand(): Promise<StockOnHandRow[]> {
  await requireAuth()
  const levels = await db.stockLevel.findMany({
    include: {
      product: { select: { id: true, sku: true, name: true, type: true, stockUnit: true, barcode: true, lifecycleStatus: true } },
      warehouse: { select: { code: true, name: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
  })

  // Get FIFO cost layers for valuation
  const costLayers = await db.costLayer.findMany({
    where: { remainingQty: { gt: 0 } },
    select: { productId: true, warehouseId: true, remainingQty: true, unitCostBase: true },
  })
  const valueMap = new Map<string, number>()
  for (const cl of costLayers) {
    const key = `${cl.productId}:${cl.warehouseId}`
    valueMap.set(key, (valueMap.get(key) ?? 0) + Number(cl.remainingQty) * Number(cl.unitCostBase))
  }

  return levels.map((l) => ({
    productId: l.product.id,
    sku: l.product.sku,
    name: l.product.name,
    type: l.product.type,
    stockUnit: l.product.stockUnit,
    barcode: l.product.barcode,
    lifecycleStatus: l.product.lifecycleStatus,
    warehouseCode: l.warehouse.code,
    warehouseName: l.warehouse.name,
    quantity: Number(l.quantity),
    reservedQty: Number(l.reservedQty),
    available: Number(l.quantity) - Number(l.reservedQty),
    inventoryValue: Math.round((valueMap.get(`${l.productId}:${l.warehouseId}`) ?? 0) * 100) / 100,
  }))
}

// ---------------------------------------------------------------------------
// Stock Movement History
// ---------------------------------------------------------------------------

export type StockMovementRow = {
  id: string
  type: string
  productId: string
  sku: string
  productName: string
  fromWarehouse: string | null
  toWarehouse: string | null
  qty: number
  note: string | null
  referenceType: string | null
  createdAt: string
}

export async function getStockMovements(dateFrom?: string, dateTo?: string, limit = 500): Promise<StockMovementRow[]> {
  await requireAuth()
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const HISTORICAL_REF_TYPES = ['WcHistorical', 'WcInitialImport', 'CsvHistorical']
  const baseWhere: Record<string, unknown> = {
    NOT: { referenceType: { in: HISTORICAL_REF_TYPES } },
  }
  if (Object.keys(dateFilter).length) baseWhere.createdAt = dateFilter

  const movements = await db.stockMovement.findMany({
    where: baseWhere,
    select: {
      id: true, type: true, productId: true, qty: true, note: true, referenceType: true, createdAt: true,
      product: { select: { sku: true, name: true } },
      fromWarehouse: { select: { code: true } },
      toWarehouse: { select: { code: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return movements.map((m) => ({
    id: m.id,
    type: m.type,
    productId: m.productId,
    sku: m.product.sku,
    productName: m.product.name,
    fromWarehouse: m.fromWarehouse?.code ?? null,
    toWarehouse: m.toWarehouse?.code ?? null,
    qty: Number(m.qty),
    note: m.note,
    referenceType: m.referenceType,
    createdAt: m.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Stock Allocations (reserved stock breakdown)
// ---------------------------------------------------------------------------

export type StockAllocationRow = {
  productId: string
  sku: string
  productName: string
  warehouseCode: string
  totalStock: number
  reservedQty: number
  available: number
  pendingOrders: number  // count of pending/processing orders with this product
}

export async function getStockAllocations(): Promise<StockAllocationRow[]> {
  await requireAuth()
  const levels = await db.stockLevel.findMany({
    where: { reservedQty: { gt: 0 } },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      warehouse: { select: { code: true } },
    },
  })

  // Count pending orders per product
  const pendingLines = await db.salesOrderLine.findMany({
    where: { order: { status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] } } },
    select: { productId: true, orderId: true },
  })
  const pendingByProduct = new Map<string, Set<string>>()
  for (const l of pendingLines) {
    if (!l.productId) continue
    if (!pendingByProduct.has(l.productId)) pendingByProduct.set(l.productId, new Set())
    pendingByProduct.get(l.productId)!.add(l.orderId)
  }

  return levels.map((l) => ({
    productId: l.product.id,
    sku: l.product.sku,
    productName: l.product.name,
    warehouseCode: l.warehouse.code,
    totalStock: Number(l.quantity),
    reservedQty: Number(l.reservedQty),
    available: Number(l.quantity) - Number(l.reservedQty),
    pendingOrders: pendingByProduct.get(l.productId)?.size ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// Reorder Inventory (products below reorder point — uses forecast data)
// ---------------------------------------------------------------------------

export type ReorderRow = {
  productId: string
  sku: string
  name: string
  stockUnit: string
  currentStock: number
  availableStock: number
  reorderPoint: number
  shortfall: number
  supplierName: string | null
  avgDailyDemand: number
  daysUntilStockout: number
}

export async function getReorderInventory(): Promise<ReorderRow[]> {
  await requireAuth()
  // Use the forecast engine
  const { generateForecasts } = await import('./forecasting')
  const forecasts = await generateForecasts()

  return forecasts
    .filter((f) => f.urgency === 'critical' || f.urgency === 'low')
    .map((f) => ({
      productId: f.productId,
      sku: f.sku,
      name: f.name,
      stockUnit: f.stockUnit,
      currentStock: f.currentStock,
      availableStock: f.availableStock,
      reorderPoint: f.reorderPoint,
      shortfall: Math.max(0, f.reorderPoint - f.availableStock),
      supplierName: f.supplierName,
      avgDailyDemand: f.avgDailyDemand,
      daysUntilStockout: f.daysUntilStockout,
    }))
}
