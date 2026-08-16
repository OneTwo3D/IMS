'use server'

import { revalidatePath } from 'next/cache'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { toIsoCountryCode } from '@/lib/countries'
import { invalidateStaleHsProposal } from '@/lib/trade/hs-classification-trigger'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { scheduleWmsProductSync, isAnyWmsConnectorEnabled } from '@/lib/domain/wms/product-sync-dispatch'
import {
  COMPONENT_PRODUCT_STATUSES,
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromLegacyActive,
} from '@/lib/products/lifecycle'
import {
  validateProductStructureChange,
} from '@/lib/products/type-transforms'
import { detectComponentCycle } from '@/lib/products/component-cycle'
import { blocksClearingInvalidOrigin } from '@/lib/products/country-of-origin'
import { productSchema } from '@/lib/products/product-schema'
import { ProductSkuTakenError, ProductStructureChangedError, lockProductSkusForWrite } from '@/lib/products/sku-write-lock'
import { COMPONENT_GRAPH_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import {
  ComponentGraphInFlightSalesError,
  describeComponentGraphEditBlockers,
  findComponentGraphEditBlockers,
} from '@/lib/products/component-graph-edit-guard'
import {
  RESERVATION_RELEASING_SHIPMENT_STATUS,
  residualAllocationQty,
  sumDispatchedQtyByAllocationScope,
} from '@/lib/domain/inventory/reservation-residual'
import {
  cleanProductCategoryName,
  listProductCategoryNodes,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  resolveProductCategoryIdByName,
  type ProductCategoryNode,
} from '@/lib/products/categories'
import type { ProductLifecycleStatus, TaxCategory } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProductRow = {
  id: string
  sku: string
  name: string
  categoryId: string | null
  categoryName: string | null
  type: ProductType
  parentSku: string | null
  preferredSupplierId: string | null
  preferredSupplierName: string | null
  preferredSupplierLocked: boolean
  barcode: string | null
  mpn: string | null
  weight: string | null
  widthCm: string | null
  heightCm: string | null
  depthCm: string | null
  imageUrl: string | null
  salesPriceBase: string | null   // regular / list price
  salePriceBase: string | null    // sale / discounted price
  priceRange: { min: string; max: string } | null  // for VARIABLE: min–max of variant regular prices
  salesPriceTaxInclusive: boolean
  taxCategory: TaxCategory
  stockUnit: string
  oversellAllowed: boolean
  active: boolean
  lifecycleStatus: ProductLifecycleStatus
  variantCount: number
  totalStock: string
  allocatedStock: string    // sum of reservedQty across all warehouses
  availableStock: string    // totalStock - allocatedStock
  incomingStock: string     // in-transit transfers + open PO lines
  inventoryValue: string  // sum of remainingQty * unitCostBase
  createdAt: Date
  updatedAt: Date
}

export type ProductDetail = ProductRow & {
  parentId: string | null   // DB id of parent product (for breadcrumb linking)
  description: string | null
  leadTimeDays: number | null          // manual lead-time override
  observedLeadTimeDays: number | null  // auto P95 from PO receipts
  widthCm: string | null
  heightCm: string | null
  depthCm: string | null
  hsCode: string | null
  countryOfOrigin: string | null
  customsDescription: string | null
  variants: ProductRow[]
  stockByWarehouse: {
    warehouseId: string
    warehouseCode: string
    warehouseName: string
    quantity: string
    reservedQty: string
    allocatedQty: string    // from active sales orders
    availableQty: string    // quantity - allocatedQty
    incomingTransferQty: string  // in-transit transfers arriving at this warehouse
    incomingPoQty: string        // open PO lines destined for this warehouse
  }[]
  incomingPoQty: string    // open PO lines with no warehouse assigned yet (unassigned)
  costLayers: { id: string; receivedAt: Date; receivedQty: string; remainingQty: string; unitCostBase: string }[]
}

export type ProductListResult = {
  products: ProductRow[]
  total: number
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type SortField = 'sku' | 'name' | 'type' | 'salesPriceBase' | 'totalStock' | 'active' | 'createdAt' | 'updatedAt'
export type SortDir = 'asc' | 'desc'

// Fields that can be sorted directly in the DB query
const DB_SORT_FIELDS = new Set(['sku', 'name', 'type', 'salesPriceBase', 'active', 'createdAt', 'updatedAt'])

export async function listProducts(params: {
  search?: string
  type?: ProductType | 'ALL'
  active?: 'true' | 'false' | 'all'
  lifecycleStatus?: ProductLifecycleStatus | 'ALL'
  categoryId?: string
  supplierId?: string
  page?: number
  pageSize?: number
  sort?: SortField
  dir?: SortDir
}): Promise<ProductListResult> {
  await requireAuth()
  const page = Math.max(1, params.page ?? 1)
  const pageSize = params.pageSize ?? 50
  const sortField = params.sort ?? 'sku'
  const sortDir = params.dir ?? 'asc'
  const isComputedSort = !DB_SORT_FIELDS.has(sortField)

  const where = {
    ...(params.search
      ? {
          OR: [
            { sku: { contains: params.search, mode: 'insensitive' as const } },
            { name: { contains: params.search, mode: 'insensitive' as const } },
            { barcode: { contains: params.search, mode: 'insensitive' as const } },
            { mpn: { contains: params.search, mode: 'insensitive' as const } },
            { variants: { some: { sku: { contains: params.search, mode: 'insensitive' as const } } } },
            { variants: { some: { mpn: { contains: params.search, mode: 'insensitive' as const } } } },
          ],
        }
      : {}),
    // By default exclude VARIANT products; pass type='ALL' to include everything
    ...(params.type === 'ALL'
      ? {}
      : params.type
      ? { type: params.type as ProductType }
      : { parentId: null }),
    ...(params.lifecycleStatus && params.lifecycleStatus !== 'ALL'
      ? { lifecycleStatus: params.lifecycleStatus }
      : params.active === 'true'
      ? { lifecycleStatus: { in: COMPONENT_PRODUCT_STATUSES } }
      : params.active === 'false'
      ? { lifecycleStatus: 'ARCHIVED' as const }
      : {}),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.supplierId ? { preferredSupplierId: params.supplierId } : {}),
  }

  const categoryNodes = await listProductCategoryNodes()
  const categoryPathById = new Map(categoryNodes.map((n) => [n.id, n.path] as const))

  const [rawProducts, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        parent: { select: { sku: true, imageUrl: true } },
        preferredSupplier: { select: { id: true, name: true } },
        variants: {
          select: {
            id: true,
            imageUrl: true,
            salesPriceBase: true,
            salePriceBase: true,
            preferredSupplier: { select: { id: true, name: true } },
            preferredSupplierLocked: true,
            stockLevels: { select: { quantity: true, reservedQty: true } },
          },
        },
        stockLevels: { select: { quantity: true, reservedQty: true } },
        costLayers: {
          where: { remainingQty: { gt: 0 } },
          select: { remainingQty: true, unitCostBase: true },
        },
      },
      orderBy: isComputedSort ? { sku: 'asc' } : { [sortField]: sortDir },
      // For computed sorts, fetch all rows so we can sort in memory then paginate
      ...(isComputedSort ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
    }),
    db.product.count({ where }),
  ])

  // Collect all product IDs (including variant IDs) for batch incoming queries
  const allProductIds: string[] = []
  for (const p of rawProducts) {
    allProductIds.push(p.id)
    for (const v of p.variants) allProductIds.push(v.id)
  }

  // Batch query incoming stock (transfers + POs) grouped by product
  const [incomingTransfers, incomingPOs] = await Promise.all([
    db.stockTransferLine.groupBy({
      by: ['productId'],
      where: { productId: { in: allProductIds }, transfer: { status: 'IN_TRANSIT' } },
      _sum: { qty: true, qtyReceived: true },
    }),
    db.purchaseOrderLine.groupBy({
      by: ['productId'],
      where: {
        productId: { in: allProductIds },
        po: { status: { in: INCOMING_PO_STATUSES }, type: 'GOODS' },
      },
      _sum: { qty: true, qtyReceived: true },
    }),
  ])

  const incomingByProduct = new Map<string, number>()
  for (const t of incomingTransfers) {
    const remaining = Math.max(0, Number(t._sum.qty ?? 0) - Number(t._sum.qtyReceived ?? 0))
    if (remaining > 0) incomingByProduct.set(t.productId, (incomingByProduct.get(t.productId) ?? 0) + remaining)
  }
  for (const po of incomingPOs) {
    const remaining = Math.max(0, Number(po._sum.qty ?? 0) - Number(po._sum.qtyReceived ?? 0))
    if (remaining > 0) incomingByProduct.set(po.productId, (incomingByProduct.get(po.productId) ?? 0) + remaining)
  }

  const products: ProductRow[] = rawProducts.map((p) => {
    // Compute variant price range for VARIABLE products
    let priceRange: { min: string; max: string } | null = null
    if (p.type === 'VARIABLE' && p.variants.length > 0) {
      const prices = p.variants.map((v) => Number(v.salesPriceBase)).filter((n) => n > 0)
      if (prices.length) {
        priceRange = { min: Math.min(...prices).toFixed(2), max: Math.max(...prices).toFixed(2) }
      }
    }

    const totalStock = p.type === 'VARIABLE'
      ? p.variants.reduce((sum, v) =>
          sum + v.stockLevels.reduce((vs, s) => vs + Number(s.quantity), 0), 0)
      : p.stockLevels.reduce((sum, s) => sum + Number(s.quantity), 0)

    const allocatedStock = p.type === 'VARIABLE'
      ? p.variants.reduce((sum, v) =>
          sum + v.stockLevels.reduce((vs, s) => vs + Number(s.reservedQty), 0), 0)
      : p.stockLevels.reduce((sum, s) => sum + Number(s.reservedQty), 0)

    const incomingStock = p.type === 'VARIABLE'
      ? p.variants.reduce((sum, v) => sum + (incomingByProduct.get(v.id) ?? 0), 0)
      : (incomingByProduct.get(p.id) ?? 0)

    const availableStock = totalStock - allocatedStock

    return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    categoryId: p.category?.id ?? null,
    categoryName: p.category ? (categoryPathById.get(p.category.id) ?? p.category.name) : null,
    type: p.type,
    parentSku: p.parent?.sku ?? null,
    preferredSupplierId: p.preferredSupplier?.id ?? null,
    preferredSupplierName: p.preferredSupplier?.name ?? null,
    preferredSupplierLocked: p.preferredSupplierLocked,
    barcode: p.barcode,
    mpn: p.mpn,
    weight: p.weight?.toString() ?? null,
    widthCm: p.widthCm?.toString() ?? null,
    heightCm: p.heightCm?.toString() ?? null,
    depthCm: p.depthCm?.toString() ?? null,
    imageUrl: p.imageUrl ?? p.parent?.imageUrl ?? null,
    salesPriceBase: p.salesPriceBase?.toString() ?? null,
    salePriceBase: p.salePriceBase?.toString() ?? null,
    priceRange,
    salesPriceTaxInclusive: p.salesPriceTaxInclusive,
    taxCategory: p.taxCategory,
    stockUnit: p.stockUnit,
    oversellAllowed: p.oversellAllowed,
    active: p.active,
    lifecycleStatus: p.lifecycleStatus,
    variantCount: p.variants.length,
    totalStock: totalStock.toFixed(2),
    allocatedStock: allocatedStock.toFixed(2),
    availableStock: availableStock.toFixed(2),
    incomingStock: incomingStock.toFixed(2),
    inventoryValue: p.costLayers
      .reduce((sum, c) => sum + Number(c.remainingQty) * Number(c.unitCostBase), 0)
      .toFixed(2),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }}
  )

  // For computed sort fields, sort in memory then paginate
  if (isComputedSort) {
    const mult = sortDir === 'asc' ? 1 : -1
    products.sort((a, b) => {
      const av = Number(a[sortField as keyof ProductRow] ?? 0)
      const bv = Number(b[sortField as keyof ProductRow] ?? 0)
      return (av - bv) * mult
    })
    const sliced = products.slice((page - 1) * pageSize, page * pageSize)
    return { products: sliced, total, page, pageSize }
  }

  return { products, total, page, pageSize }
}

export async function getProduct(id: string): Promise<ProductDetail | null> {
  await requireAuth()
  const categoryNodes = await listProductCategoryNodes()
  const categoryPathById = new Map(categoryNodes.map((n) => [n.id, n.path] as const))
  const [p, activeOrderLines, inTransferLines, openPoLines] = await Promise.all([
    db.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        parent: { select: { sku: true, imageUrl: true } },
        preferredSupplier: { select: { id: true, name: true } },
        variants: {
          include: {
            category: { select: { id: true, name: true } },
            preferredSupplier: { select: { id: true, name: true } },
            stockLevels: { select: { quantity: true, reservedQty: true } },
          },
          orderBy: { sku: 'asc' },
        },
        stockLevels: {
          include: { warehouse: { select: { id: true, code: true, name: true } } },
          orderBy: { warehouse: { code: 'asc' } },
        },
        costLayers: {
          orderBy: { receivedAt: 'asc' },
          where: { remainingQty: { gt: 0 } },
        },
      },
    }),
    // Allocated: active sales order lines, grouped by shipFromWarehouseId
    db.salesOrderLine.findMany({
      where: {
        productId: id,
        order: {
          status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'ON_HOLD'] },
        },
      },
      select: { qty: true, order: { select: { shipFromWarehouseId: true } } },
    }),
    // Incoming via stock transfers (in-transit, arriving at destination warehouse)
    db.stockTransferLine.findMany({
      where: { productId: id, transfer: { status: 'IN_TRANSIT' } },
      select: { qty: true, qtyReceived: true, transfer: { select: { toWarehouseId: true, toWarehouse: { select: { id: true, code: true, name: true } } } } },
    }),
    // Incoming from open POs (grouped by destination warehouse)
    db.purchaseOrderLine.findMany({
      where: {
        productId: id,
        po: {
          status: { in: INCOMING_PO_STATUSES },
          type: 'GOODS',
        },
      },
      select: { qty: true, qtyReceived: true, po: { select: { destinationWarehouseId: true, destinationWarehouse: { select: { id: true, code: true, name: true } } } } },
    }),
  ])

  if (!p) return null

  // Build per-warehouse maps
  const allocatedByWarehouse = new Map<string, number>()
  for (const line of activeOrderLines) {
    const wid = line.order.shipFromWarehouseId ?? '__unassigned__'
    allocatedByWarehouse.set(wid, (allocatedByWarehouse.get(wid) ?? 0) + Number(line.qty))
  }

  const incomingTransferByWarehouse = new Map<string, number>()
  const warehouseInfoMap = new Map<string, { id: string; code: string; name: string }>()
  for (const line of inTransferLines) {
    const wid = line.transfer.toWarehouseId
    const remaining = Number(line.qty) - Number(line.qtyReceived)
    if (remaining > 0) {
      incomingTransferByWarehouse.set(wid, (incomingTransferByWarehouse.get(wid) ?? 0) + remaining)
      if (line.transfer.toWarehouse) warehouseInfoMap.set(wid, line.transfer.toWarehouse)
    }
  }

  // PO incoming grouped by destination warehouse (null = unassigned)
  const incomingPoByWarehouse = new Map<string, number>()
  for (const line of openPoLines) {
    const wid = line.po.destinationWarehouseId ?? '__unassigned__'
    const remaining = Math.max(0, Number(line.qty) - Number(line.qtyReceived))
    if (remaining > 0) {
      incomingPoByWarehouse.set(wid, (incomingPoByWarehouse.get(wid) ?? 0) + remaining)
      if (line.po.destinationWarehouse) warehouseInfoMap.set(wid, line.po.destinationWarehouse)
    }
  }
  // Top-level incomingPoQty = only lines with no destination warehouse assigned
  const incomingPoQty = (incomingPoByWarehouse.get('__unassigned__') ?? 0).toFixed(2)

  // Compute aggregate allocated/incoming for the product itself
  const totalAllocated = p.stockLevels.reduce((sum, s) => sum + Number(s.reservedQty), 0)
  const totalIncomingTransfer = [...incomingTransferByWarehouse.entries()]
    .filter(([k]) => k !== '__unassigned__').reduce((sum, [, v]) => sum + v, 0)
  const totalIncomingPo = [...incomingPoByWarehouse.values()].reduce((sum, v) => sum + v, 0)
  const productIncoming = totalIncomingTransfer + totalIncomingPo

  // Batch query incoming stock for variants
  const variantIds = p.variants.map((v) => v.id)
  const variantIncomingMap = new Map<string, number>()
  if (variantIds.length > 0) {
    const [vTransfers, vPOs] = await Promise.all([
      db.stockTransferLine.groupBy({
        by: ['productId'],
        where: { productId: { in: variantIds }, transfer: { status: 'IN_TRANSIT' } },
        _sum: { qty: true, qtyReceived: true },
      }),
      db.purchaseOrderLine.groupBy({
        by: ['productId'],
        where: {
          productId: { in: variantIds },
          po: { status: { in: INCOMING_PO_STATUSES }, type: 'GOODS' },
        },
        _sum: { qty: true, qtyReceived: true },
      }),
    ])
    for (const t of vTransfers) {
      const rem = Math.max(0, Number(t._sum.qty ?? 0) - Number(t._sum.qtyReceived ?? 0))
      if (rem > 0) variantIncomingMap.set(t.productId, (variantIncomingMap.get(t.productId) ?? 0) + rem)
    }
    for (const po of vPOs) {
      const rem = Math.max(0, Number(po._sum.qty ?? 0) - Number(po._sum.qtyReceived ?? 0))
      if (rem > 0) variantIncomingMap.set(po.productId, (variantIncomingMap.get(po.productId) ?? 0) + rem)
    }
  }

  // For KIT/BOM: compute unit cost from components; BOM also uses actual stock
  const isKitOrBom = p.type === 'KIT' || p.type === 'BOM'
  const kitUnitCostBase = isKitOrBom ? await computeKitUnitCostBase(p.id) : 0
  const fifoInventoryValue = p.costLayers
    .reduce((sum, c) => sum + Number(c.remainingQty) * Number(c.unitCostBase), 0)
  const totalStockQty = p.stockLevels.reduce((sum, s) => sum + Number(s.quantity), 0)
  const inventoryValue = isKitOrBom
    ? (p.type === 'BOM' ? kitUnitCostBase * totalStockQty : kitUnitCostBase).toFixed(2)
    : fifoInventoryValue.toFixed(2)

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    categoryId: p.category?.id ?? null,
    categoryName: p.category ? (categoryPathById.get(p.category.id) ?? p.category.name) : null,
    description: p.description,
    type: p.type,
    parentId: p.parentId,
    parentSku: p.parent?.sku ?? null,
    preferredSupplierId: p.preferredSupplier?.id ?? null,
    preferredSupplierName: p.preferredSupplier?.name ?? null,
    preferredSupplierLocked: p.preferredSupplierLocked,
    barcode: p.barcode,
    mpn: p.mpn,
    hsCode: p.hsCode ?? null,
    countryOfOrigin: p.countryOfOrigin ?? null,
    customsDescription: p.customsDescription ?? null,
    leadTimeDays: p.leadTimeDays ?? null,
    observedLeadTimeDays: p.observedLeadTimeDays ?? null,
    weight: p.weight?.toString() ?? null,
    widthCm: p.widthCm?.toString() ?? null,
    heightCm: p.heightCm?.toString() ?? null,
    depthCm: p.depthCm?.toString() ?? null,
    imageUrl: p.imageUrl ?? p.parent?.imageUrl ?? null,
    salesPriceBase: p.salesPriceBase?.toString() ?? null,
    salePriceBase: p.salePriceBase?.toString() ?? null,
    priceRange: p.type === 'VARIABLE' && p.variants.length > 0 ? (() => {
      const prices = p.variants.map((v) => Number(v.salesPriceBase)).filter((n) => n > 0)
      if (!prices.length) return null
      return { min: Math.min(...prices).toFixed(2), max: Math.max(...prices).toFixed(2) }
    })() : null,
    salesPriceTaxInclusive: p.salesPriceTaxInclusive,
    taxCategory: p.taxCategory,
    stockUnit: p.stockUnit,
    oversellAllowed: p.oversellAllowed,
    active: p.active,
    lifecycleStatus: p.lifecycleStatus,
    variantCount: p.variants.length,
    totalStock: totalStockQty.toFixed(2),
    allocatedStock: totalAllocated.toFixed(2),
    availableStock: (totalStockQty - totalAllocated).toFixed(2),
    incomingStock: productIncoming.toFixed(2),
    inventoryValue,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      categoryId: v.category?.id ?? null,
      categoryName: v.category ? (categoryPathById.get(v.category.id) ?? v.category.name) : null,
      type: v.type,
      parentSku: p.sku,
      preferredSupplierId: v.preferredSupplier?.id ?? null,
      preferredSupplierName: v.preferredSupplier?.name ?? null,
      preferredSupplierLocked: v.preferredSupplierLocked,
      barcode: v.barcode,
      mpn: v.mpn,
      weight: v.weight?.toString() ?? null,
      widthCm: v.widthCm?.toString() ?? null,
      heightCm: v.heightCm?.toString() ?? null,
      depthCm: v.depthCm?.toString() ?? null,
      imageUrl: v.imageUrl ?? p.imageUrl ?? null,
      salesPriceBase: v.salesPriceBase?.toString() ?? null,
      salePriceBase: v.salePriceBase?.toString() ?? null,
      priceRange: null,
      salesPriceTaxInclusive: v.salesPriceTaxInclusive,
      taxCategory: v.taxCategory,
      stockUnit: v.stockUnit,
      oversellAllowed: v.oversellAllowed,
      active: v.active,
      lifecycleStatus: v.lifecycleStatus,
      variantCount: 0,
      totalStock: v.stockLevels
        .reduce((sum, s) => sum + Number(s.quantity), 0)
        .toFixed(2),
      allocatedStock: v.stockLevels
        .reduce((sum, s) => sum + Number(s.reservedQty), 0)
        .toFixed(2),
      availableStock: (
        v.stockLevels.reduce((sum, s) => sum + Number(s.quantity), 0) -
        v.stockLevels.reduce((sum, s) => sum + Number(s.reservedQty), 0)
      ).toFixed(2),
      incomingStock: (variantIncomingMap.get(v.id) ?? 0).toFixed(2),
      inventoryValue: '0.00',
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
    incomingPoQty,
    stockByWarehouse: (() => {
      const existingIds = new Set(p.stockLevels.map((s) => s.warehouse.id))
      const rows = p.stockLevels.map((s) => {
        const wid = s.warehouse.id
        const qty = Number(s.quantity)
        const reserved = Number(s.reservedQty)
        const available = qty - reserved
        return {
          warehouseId: wid,
          warehouseCode: s.warehouse.code,
          warehouseName: s.warehouse.name,
          quantity: qty.toFixed(2),
          reservedQty: s.reservedQty.toString(),
          allocatedQty: reserved.toFixed(2),
          availableQty: available.toFixed(2),
          incomingTransferQty: (incomingTransferByWarehouse.get(wid) ?? 0).toFixed(2),
          incomingPoQty: (incomingPoByWarehouse.get(wid) ?? 0).toFixed(2),
        }
      })
      // Add rows for warehouses with incoming but no stock level yet
      const incomingWids = new Set([...incomingTransferByWarehouse.keys(), ...incomingPoByWarehouse.keys()])
      for (const wid of incomingWids) {
        if (wid === '__unassigned__' || existingIds.has(wid)) continue
        const info = warehouseInfoMap.get(wid)
        if (!info) continue
        rows.push({
          warehouseId: wid,
          warehouseCode: info.code,
          warehouseName: info.name,
          quantity: '0.00',
          reservedQty: '0',
          allocatedQty: '0.00',
          availableQty: '0.00',
          incomingTransferQty: (incomingTransferByWarehouse.get(wid) ?? 0).toFixed(2),
          incomingPoQty: (incomingPoByWarehouse.get(wid) ?? 0).toFixed(2),
        })
      }
      return rows
    })(),
    costLayers: p.costLayers.map((c) => ({
      id: c.id,
      receivedAt: c.receivedAt,
      receivedQty: c.receivedQty.toString(),
      remainingQty: c.remainingQty.toString(),
      unitCostBase: c.unitCostBase.toString(),
    })),

  }
}

export async function getVariableProducts() {
  await requireAuth()
  return db.product.findMany({
    where: { type: 'VARIABLE', lifecycleStatus: { in: COMPONENT_PRODUCT_STATUSES } },
    select: { id: true, sku: true, name: true },
    orderBy: { sku: 'asc' },
  })
}

export async function listProductCategories(): Promise<ProductCategoryNode[]> {
  // Internal inventory/admin surface only. Re-check ownership/portal semantics
  // before reusing product reporting categories in supplier- or customer-facing UI.
  await requireAuth()
  return listProductCategoryNodes()
}

export type ProductSupplierOption = { id: string; name: string }

export async function listProductSupplierOptions(): Promise<ProductSupplierOption[]> {
  await requireAuth()
  return db.supplier.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// Manual lead-time override: blank / non-numeric / <= 0 → null (use observed/default).
function parseLeadTimeOverride(value: string | null | undefined): number | null {
  if (value == null) return null
  const n = Number(value.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

export type ProductFormState = {
  errors?: Record<string, string[]>
  message?: string
}

export async function createProduct(
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const session = await requirePermission('inventory.edit')
  const raw = {
    sku: ((formData.get('sku') as string) || '').trim(),
    name: formData.get('name') as string,
    categoryName: cleanProductCategoryName(formData.get('categoryName') as string | null),
    description: formData.get('description') as string || undefined,
    type: formData.get('type') as string,
    parentId: formData.get('parentId') as string || null,
    preferredSupplierId: formData.get('preferredSupplierId') as string || null,
    preferredSupplierLocked: formData.get('preferredSupplierLocked') === 'on',
    barcode: ((formData.get('barcode') as string) || '').trim() || null,
    mpn: ((formData.get('mpn') as string) || '').trim() || null,
    hsCode: formData.get('hsCode') as string || null,
    countryOfOrigin: formData.get('countryOfOrigin') as string || null,
    customsDescription: formData.get('customsDescription') as string || null,
    weight: formData.get('weight') as string || null,
    salesPriceBase: formData.get('salesPriceBase') as string || null,
    salePriceBase: formData.get('salePriceBase') as string || null,
    salesPriceTaxInclusive: formData.get('salesPriceTaxInclusive') === 'on',
    taxCategory: (formData.get('taxCategory') as string) || 'STANDARD',
    stockUnit: (formData.get('stockUnit') as string) || 'pcs',
    oversellAllowed: formData.get('oversellAllowed') === 'true',
    imageUrl: formData.get('imageUrl') as string || null,
    widthCm: formData.get('widthCm') as string || null,
    heightCm: formData.get('heightCm') as string || null,
    depthCm: formData.get('depthCm') as string || null,
    active: formData.get('active') !== 'false',
    lifecycleStatus: (formData.get('lifecycleStatus') as string) || deriveLifecycleStatusFromLegacyActive(formData.get('active') !== 'false'),
    leadTimeDays: formData.get('leadTimeDays') as string || null,
  }

  const parsed = productSchema.safeParse(raw)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const data = parsed.data

  // Check SKU uniqueness
  const existing = await db.product.findUnique({ where: { sku: data.sku } })
  if (existing) {
    return { errors: { sku: ['SKU already exists'] } }
  }

  if (data.barcode) {
    const existingBarcode = await db.product.findFirst({ where: { barcode: data.barcode } })
    if (existingBarcode) {
      return { errors: { barcode: ['Barcode already exists'] } }
    }
  }

  const structureValidation = await validateProductStructureChange({
    type: data.type,
    parentId: data.parentId,
  })
  if (!structureValidation.ok) {
    return { errors: structureValidation.fieldErrors, message: structureValidation.message }
  }

  let created
  try {
    created = await db.$transaction(async (tx) => {
    // o3d-42hw: join the per-SKU write protocol. The uniqueness check above ran OUTSIDE any
    // transaction, so a WooCommerce import committing this SKU in between raised a P2002 on
    // Product.sku — safe today only because o3d-gtk keeps that transient, at the cost of a
    // wasted retry cycle, and the reason it cannot be classified permanent.
    await lockProductSkusForWrite(tx, [data.sku])

    // Re-checked under the lock: the check before the transaction is now only a fast path
    // for the common case, and cannot be the thing the create relies on.
    const raced = await tx.product.findUnique({ where: { sku: data.sku }, select: { id: true } })
    if (raced) throw new ProductSkuTakenError(data.sku)

    const categoryId = await resolveProductCategoryIdByName(data.categoryName, { client: tx })
    return tx.product.create({
      data: {
        sku: data.sku,
        name: data.name,
        categoryId,
        description: data.description || null,
        type: data.type,
        parentId: structureValidation.normalizedParentId,
        preferredSupplierId: data.preferredSupplierId || null,
        preferredSupplierLocked: data.preferredSupplierLocked,
        preferredSupplierUpdatedAt: data.preferredSupplierId ? new Date() : null,
        barcode: data.barcode || null,
        mpn: data.mpn || null,
        hsCode: data.hsCode || null,
        // o3d-vj5 (option a): store NULL for a blank origin — matching updateProduct — not a persisted
        // CN default. A stored default is indistinguishable from a declared origin and blocks a later
        // parent/WC correction (bhdm.7, superseding bhdm.5's create-time default). What is SENT is
        // unchanged: the WMS/customs push resolves the CN fallback at send time
        // (resolveMintsoftCountryOfManufacture), so only provenance is preserved. wms-connector-boundary-ok: o3d-vj5: prose reference to the connector-side resolver; no connector behaviour is taken here.
        countryOfOrigin: data.countryOfOrigin || null,
        customsDescription: data.customsDescription || null,
        weight: data.weight ? data.weight : null,
        salesPriceBase: data.salesPriceBase ? data.salesPriceBase : null,
        salePriceBase: data.salePriceBase ? data.salePriceBase : null,
        salesPriceTaxInclusive: data.salesPriceTaxInclusive,
        taxCategory: data.taxCategory,
        stockUnit: data.stockUnit,
        oversellAllowed: data.oversellAllowed,
        imageUrl: data.imageUrl || null,
        widthCm: data.widthCm || null,
        heightCm: data.heightCm || null,
        depthCm: data.depthCm || null,
        active: deriveLegacyActiveFromLifecycleStatus(data.lifecycleStatus),
        lifecycleStatus: data.lifecycleStatus,
        leadTimeDays: parseLeadTimeOverride(data.leadTimeDays),
      },
    })
    })
  } catch (error) {
    // The lock turned a P2002 race into a clean, reportable outcome — surface it exactly as
    // the pre-transaction check does, so the form behaves identically either way.
    if (error instanceof ProductSkuTakenError) return { errors: { sku: ['SKU already exists'] } }
    throw error
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: null,
    action: 'created',
    tag: 'inventory',
    level: 'INFO',
    description: `Created product ${data.sku} — ${data.name}`,
    metadata: {
      sku: data.sku,
      name: data.name,
      type: data.type,
      mpn: data.mpn ?? null,
      categoryName: data.categoryName ?? null,
      preferredSupplierId: data.preferredSupplierId ?? null,
      preferredSupplierLocked: data.preferredSupplierLocked,
    },
  })

  try {
    await pushProductMetadata(created.id)
  } catch (syncError) {
    console.error(syncError)
  }
  try {
    await enqueueStockSync([created.id], 'IMS_CHANGE', {
      force: data.lifecycleStatus === 'ARCHIVED',
    })
  } catch (syncError) {
    console.error(syncError)
  }
  if (hasPermission(session.user.role, 'sync') && await isAnyWmsConnectorEnabled()) {
    scheduleWmsProductSync(created.id)
  }

  revalidatePath('/inventory')
  redirect('/inventory')
}

export async function updateProduct(
  id: string,
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const session = await requirePermission('inventory.edit')
  const raw = {
    sku: ((formData.get('sku') as string) || '').trim(),
    name: formData.get('name') as string,
    categoryName: cleanProductCategoryName(formData.get('categoryName') as string | null),
    description: formData.get('description') as string || undefined,
    type: formData.get('type') as string,
    parentId: formData.get('parentId') as string || null,
    preferredSupplierId: formData.get('preferredSupplierId') as string || null,
    preferredSupplierLocked: formData.get('preferredSupplierLocked') === 'on',
    barcode: ((formData.get('barcode') as string) || '').trim() || null,
    mpn: ((formData.get('mpn') as string) || '').trim() || null,
    hsCode: formData.get('hsCode') as string || null,
    countryOfOrigin: formData.get('countryOfOrigin') as string || null,
    customsDescription: formData.get('customsDescription') as string || null,
    weight: formData.get('weight') as string || null,
    salesPriceBase: formData.get('salesPriceBase') as string || null,
    salePriceBase: formData.get('salePriceBase') as string || null,
    salesPriceTaxInclusive: formData.get('salesPriceTaxInclusive') === 'on',
    taxCategory: (formData.get('taxCategory') as string) || 'STANDARD',
    stockUnit: (formData.get('stockUnit') as string) || 'pcs',
    oversellAllowed: formData.get('oversellAllowed') === 'true',
    imageUrl: formData.get('imageUrl') as string || null,
    widthCm: formData.get('widthCm') as string || null,
    heightCm: formData.get('heightCm') as string || null,
    depthCm: formData.get('depthCm') as string || null,
    active: formData.get('active') !== 'false',
    lifecycleStatus: (formData.get('lifecycleStatus') as string) || deriveLifecycleStatusFromLegacyActive(formData.get('active') !== 'false'),
    leadTimeDays: formData.get('leadTimeDays') as string || null,
  }

  const parsed = productSchema.safeParse(raw)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const data = parsed.data

  // Check SKU uniqueness (exclude self)
  const existing = await db.product.findFirst({ where: { sku: data.sku, NOT: { id } } })
  if (existing) {
    return { errors: { sku: ['SKU already in use by another product'] } }
  }

  if (data.barcode) {
    const existingBarcode = await db.product.findFirst({ where: { barcode: data.barcode, NOT: { id } } })
    if (existingBarcode) {
      return { errors: { barcode: ['Barcode already in use by another product'] } }
    }
  }

  const structureValidation = await validateProductStructureChange({
    productId: id,
    type: data.type,
    parentId: data.parentId,
  })
  if (!structureValidation.ok) {
    return { errors: structureValidation.fieldErrors, message: structureValidation.message }
  }

  // bhdm.7: if the persisted origin is a nonblank value that is not a valid country (a legacy bad row), a blank
  // submission must NOT clear it — that would erase the evidence and let the WMS declare CN with the
  // INVALID_COUNTRY_OF_ORIGIN discrepancy resolved, without anyone choosing a real country. Require a valid
  // replacement. (A valid current origin, or a blank current origin, may still be cleared as before.)
  const current = await db.product.findUnique({ where: { id }, select: { countryOfOrigin: true } })
  if (blocksClearingInvalidOrigin(current?.countryOfOrigin, data.countryOfOrigin)) {
    return {
      errors: { countryOfOrigin: ['This product has an invalid stored country of origin — select a valid country to save.'] },
      message: 'Select a valid country of origin',
    }
  }

  let updatedCategoryChange
  try {
    updatedCategoryChange = await db.$transaction(async (tx) => {
    // o3d-42hw. BOTH skus: a rename frees the old one and claims the new one, so a writer
    // racing on either must serialize with this.
    //
    // The catch is that WHICH locks to take depends on the current sku, and reading it is
    // itself unprotected — a concurrent rename between that read and the acquisition leaves
    // us holding the lock for a sku this product no longer has. Acquiring in ascending id
    // order is what keeps the multi-lock case deadlock-free, so the read cannot simply move
    // after the first acquisition. Instead the choice is VERIFIED once the locks are held:
    // if the sku moved, the lock set is wrong and this attempt is abandoned rather than
    // proceeding on a guess.
    const skuBefore = await tx.product.findUnique({ where: { id }, select: { sku: true } })
    await lockProductSkusForWrite(tx, [data.sku, ...(skuBefore?.sku ? [skuBefore.sku] : [])])

    const skuUnderLock = await tx.product.findUnique({ where: { id }, select: { sku: true } })
    if ((skuUnderLock?.sku ?? null) !== (skuBefore?.sku ?? null)) {
      throw new ProductStructureChangedError('Another writer renamed this product while it was being saved.')
    }

    // Re-checked under the lock. The pre-transaction check is a fast path for the common
    // case; on its own it let a concurrent create take this SKU in between.
    const skuTaken = await tx.product.findFirst({
      where: { sku: data.sku, NOT: { id } },
      select: { id: true },
    })
    if (skuTaken) throw new ProductSkuTakenError(data.sku)

    // Re-validated under the lock, against `tx`. This is the worse half of the defect: the
    // validation ran before the transaction and `type` / `parentId` were then written
    // UNCONDITIONALLY, so a WooCommerce import committing in between was overwritten with
    // structure decided against a state that no longer existed.
    const revalidated = await validateProductStructureChange({
      productId: id,
      type: data.type,
      parentId: data.parentId,
      client: tx,
    })
    if (!revalidated.ok) throw new ProductStructureChangedError(revalidated.message ?? 'Product structure changed')

    const previous = await tx.product.findUnique({
      where: { id },
      select: {
        category: { select: { name: true } },
        preferredSupplierId: true,
      },
    })
    const previousCategoryName = previous?.category?.name ?? null
    const categoryId = await resolveProductCategoryIdByName(data.categoryName, { client: tx })

    await tx.product.update({
      where: { id },
      data: {
        sku: data.sku,
        name: data.name,
        categoryId,
        description: data.description || null,
        type: data.type,
        parentId: revalidated.normalizedParentId,
        preferredSupplierId: data.preferredSupplierId || null,
        preferredSupplierLocked: data.preferredSupplierLocked,
        preferredSupplierUpdatedAt:
          data.preferredSupplierId !== (previous?.preferredSupplierId ?? null)
            ? new Date()
            : undefined,
        barcode: data.barcode || null,
        mpn: data.mpn || null,
        hsCode: data.hsCode || null,
        // Do NOT default origin on update: a deliberate clear must not silently overwrite a
        // real country with CN (customs misdeclaration). New products default at create; the
        // WMS product push still declares CN for any null origin, so customs stays covered (bhdm.5).
        countryOfOrigin: data.countryOfOrigin || null,
        customsDescription: data.customsDescription || null,
        weight: data.weight ? data.weight : null,
        salesPriceBase: data.salesPriceBase ? data.salesPriceBase : null,
        salePriceBase: data.salePriceBase ? data.salePriceBase : null,
        salesPriceTaxInclusive: data.salesPriceTaxInclusive,
        taxCategory: data.taxCategory,
        stockUnit: data.stockUnit,
        oversellAllowed: data.oversellAllowed,
        imageUrl: data.imageUrl || null,
        widthCm: data.widthCm || null,
        heightCm: data.heightCm || null,
        depthCm: data.depthCm || null,
        active: deriveLegacyActiveFromLifecycleStatus(data.lifecycleStatus),
        lifecycleStatus: data.lifecycleStatus,
        // Only touch the manual lead-time override when the form actually submitted the
        // field (blank → clear → null). A caller that omits it leaves the override as-is.
        ...(formData.has('leadTimeDays') ? { leadTimeDays: parseLeadTimeOverride(data.leadTimeDays) } : {}),
        ...(revalidated.clearExternalMapping ? { externalProductId: null } : {}),
      },
    })

    if (revalidated.clearComponents) {
      // o3d-4kfh r4: converting a KIT to a non-component type deletes its components, which is the
      // SAME retroactive rewrite as re-composing it — every in-flight order for that kit stops
      // expanding into components and starts requiring the parent as a leaf. Guarded identically to
      // saveProductComponents.
      //
      // NOTE this path deliberately holds only its per-SKU lock, not the coarse component-graph
      // advisory one (taking that here would invert the lock order — see lib/db/advisory-locks.ts),
      // so the check is not atomic against an allocation committing in the same instant. The
      // graph-aware committed-coverage check that now runs at every shipment transition including
      // dispatch is the atomic backstop for that window.
      const blockers = await findComponentGraphEditBlockers(tx, id)
      if (blockers.length > 0) {
        throw new ComponentGraphInFlightSalesError(describeComponentGraphEditBlockers(blockers))
      }
      await tx.productComponent.deleteMany({ where: { productId: id } })
    }

    return {
      from: previousCategoryName,
      to: data.categoryName ?? null,
    }
    })
  } catch (error) {
    // Reported the same way the pre-transaction checks report, so the form behaves
    // identically whether the conflict is caught before the lock or under it.
    if (error instanceof ProductSkuTakenError) {
      return { errors: { sku: ['SKU already in use by another product'] } }
    }
    // Before the ProductStructureChangedError branch: this is not a stale-read conflict and
    // reloading will not help, so it must not be told to reload.
    if (error instanceof ComponentGraphInFlightSalesError) {
      return { message: error.message }
    }
    if (error instanceof ProductStructureChangedError) {
      return { message: `${error.message} Reload the product and try again.` }
    }
    throw error
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: id,
    action: 'updated',
    tag: 'inventory',
    level: 'INFO',
    description: `Updated product ${data.sku} — ${data.name}`,
    metadata: {
      sku: data.sku,
      name: data.name,
      type: data.type,
      mpn: data.mpn ?? null,
      categoryName: data.categoryName ?? null,
      categoryNameChange: updatedCategoryChange,
      preferredSupplierId: data.preferredSupplierId ?? null,
      preferredSupplierLocked: data.preferredSupplierLocked,
    },
  })

  try {
    await pushProductMetadata(id)
  } catch (syncError) {
    console.error(syncError)
  }
  try {
    await enqueueStockSync([id], 'IMS_CHANGE', {
      force: data.lifecycleStatus === 'ARCHIVED',
    })
  } catch (syncError) {
    console.error(syncError)
  }
  if (hasPermission(session.user.role, 'sync') && await isAnyWmsConnectorEnabled()) {
    scheduleWmsProductSync(id)
  }
  // If the classification-relevant fields changed, drop the stale HS-code proposal so the
  // sweep re-classifies (6igm.5/.7). Best-effort — never block the product save.
  try {
    await invalidateStaleHsProposal(id)
  } catch (hsError) {
    console.error(hsError)
  }

  revalidatePath('/inventory')
  revalidatePath(`/inventory/${id}`)
  redirect(`/inventory/${id}`)
}

// ---------------------------------------------------------------------------
// Suppliers for a product (with live FX conversion to GBP)
// ---------------------------------------------------------------------------

export type ProductSupplierRow = {
  supplierId: string
  supplierName: string
  supplierSku: string | null
  lastUnitCost: string   // in supplier currency, formatted
  currency: string
  currencySymbol: string
  baseEquivalent: string | null  // null = no FX rate stored
  fxRate: string | null         // 1 GBP = fxRate currency units
  fxFetchedAt: Date | null
  updatedAt: Date
}

export async function getProductSuppliers(productId: string): Promise<ProductSupplierRow[]> {
  await requireAuth()
  const rows = await db.supplierProduct.findMany({
    where: { productId },
    include: {
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })

  if (rows.length === 0) return []

  // Collect unique non-GBP currencies and look up latest FX rate + symbol for each
  const currencies = [...new Set(rows.map((r) => r.currency).filter((c) => c !== 'GBP'))]

  const symbolMap = new Map<string, string>([['GBP', '£']])
  const currencyRows = await db.currency.findMany({
    where: { code: { in: currencies } },
    select: { code: true, symbol: true },
  })
  for (const cr of currencyRows) symbolMap.set(cr.code, cr.symbol)

  const fxMap = new Map<string, { rate: number; fetchedAt: Date }>()
  await Promise.all(
    currencies.map(async (code) => {
      const fx = await db.fxRate.findFirst({
        where: { toCurrency: code },
        orderBy: { fetchedAt: 'desc' },
        select: { rate: true, fetchedAt: true },
      })
      if (fx) fxMap.set(code, { rate: Number(fx.rate), fetchedAt: fx.fetchedAt })
    })
  )

  return rows.map((r) => {
    const cost = Number(r.lastUnitCost)

    let baseEquivalent: string | null = null
    let fxRate: string | null = null
    let fxFetchedAt: Date | null = null

    if (r.currency === 'GBP') {
      baseEquivalent = cost.toFixed(2)
      fxRate = '1'
    } else {
      const fx = fxMap.get(r.currency)
      if (fx) {
        baseEquivalent = (cost / fx.rate).toFixed(2)
        fxRate = fx.rate.toFixed(4)
        fxFetchedAt = fx.fetchedAt
      }
    }

    return {
      supplierId: r.supplierId,
      supplierName: r.supplier.name,
      supplierSku: r.supplierSku,
      lastUnitCost: cost.toFixed(2),
      currency: r.currency,
      currencySymbol: symbolMap.get(r.currency) ?? r.currency,
      baseEquivalent,
      fxRate,
      fxFetchedAt,
      updatedAt: r.updatedAt,
    }
  })
}

// ---------------------------------------------------------------------------
// Kit/BOM COGS helper — unit cost of one assembled kit/BOM based on components
// ---------------------------------------------------------------------------

async function computeKitUnitCostBase(productId: string): Promise<number> {
  const components = await db.productComponent.findMany({
    where: { productId },
    select: {
      qty: true,
      component: {
        select: {
          costLayers: {
            where: { remainingQty: { gt: 0 } },
            select: { remainingQty: true, unitCostBase: true },
          },
        },
      },
    },
  })

  let total = 0
  for (const comp of components) {
    const layers = comp.component.costLayers
    const totalRemaining = layers.reduce((s, l) => s + Number(l.remainingQty), 0)
    const avgCost = totalRemaining > 0
      ? layers.reduce((s, l) => s + Number(l.remainingQty) * Number(l.unitCostBase), 0) / totalRemaining
      : 0
    total += Number(comp.qty) * avgCost
  }
  return total
}

// ---------------------------------------------------------------------------
// Product Components (for KIT and BOM products)
// ---------------------------------------------------------------------------

export type ProductComponentRow = {
  id: string
  componentId: string
  componentSku: string
  componentName: string
  qty: string
  sortOrder: number
}

export type ProductComponentDuplicateMatch = {
  productId: string
  sku: string
  name: string
  type: 'KIT' | 'BOM'
  parentSku: string | null
}

type ProductComponentInput = {
  componentId: string
  qty: string | number
}

function normalizeProductComponentList(components: ProductComponentInput[]): Array<{ componentId: string; qty: string }> {
  const totals = new Map<string, Prisma.Decimal>()

  for (const component of components) {
    const componentId = component.componentId.trim()
    if (!componentId) continue

    let qty: Prisma.Decimal
    try {
      qty = new Prisma.Decimal(component.qty)
    } catch {
      continue
    }

    if (qty.lte(0)) continue
    const existing = totals.get(componentId)
    totals.set(componentId, existing ? existing.plus(qty) : qty)
  }

  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([componentId, qty]) => ({
      componentId,
      qty: qty.toString(),
    }))
}

function buildProductComponentSignature(components: Array<{ componentId: string; qty: string }>): string {
  return components.map((component) => `${component.componentId}:${component.qty}`).join('|')
}

async function findMatchingProductComponentConfigurations(
  productId: string,
  components: ProductComponentInput[],
): Promise<ProductComponentDuplicateMatch[]> {
  const normalized = normalizeProductComponentList(components)
  if (normalized.length === 0) return []

  const targetSignature = buildProductComponentSignature(normalized)

  const candidates = await db.product.findMany({
    where: {
      id: { not: productId },
      type: { in: ['KIT', 'BOM'] },
      productComponents: { some: {} },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
      parent: { select: { sku: true } },
      productComponents: {
        select: { componentId: true, qty: true },
      },
    },
    orderBy: { sku: 'asc' },
  })

  return candidates
    .filter((candidate) => {
      const candidateSignature = buildProductComponentSignature(
        normalizeProductComponentList(candidate.productComponents.map((component) => ({
          componentId: component.componentId,
          qty: component.qty.toString(),
        }))),
      )
      return candidateSignature === targetSignature
    })
    .map((candidate) => ({
      productId: candidate.id,
      sku: candidate.sku,
      name: candidate.name,
      type: candidate.type as 'KIT' | 'BOM',
      parentSku: candidate.parent?.sku ?? null,
    }))
}

export async function getProductComponents(productId: string): Promise<ProductComponentRow[]> {
  await requireAuth()
  const rows = await db.productComponent.findMany({
    where: { productId },
    include: { component: { select: { id: true, sku: true, name: true } } },
    orderBy: { sortOrder: 'asc' },
  })
  return rows.map((r) => ({
    id: r.id,
    componentId: r.componentId,
    componentSku: r.component.sku,
    componentName: r.component.name,
    qty: r.qty.toString(),
    sortOrder: r.sortOrder,
  }))
}

export async function checkProductComponentDuplicates(
  productId: string,
  components: ProductComponentInput[],
): Promise<{ matches: ProductComponentDuplicateMatch[] }> {
  await requirePermission('inventory.edit')
  return {
    matches: await findMatchingProductComponentConfigurations(productId, components),
  }
}

export async function saveProductComponents(
  productId: string,
  components: { componentId: string; qty: string }[]
): Promise<{ success: boolean; error?: string; warnings?: ProductComponentDuplicateMatch[]; inProgressProductionOrders?: { id: string; reference: string }[] }> {
  try {
    await requirePermission('inventory.edit')

    // Preflight only — the authoritative check runs under the graph lock below. Kept so the
    // common rejection still returns a clean message without opening a transaction.
    const preflight = await detectComponentCycle(productId, components.map((c) => c.componentId))
    if (preflight.kind === 'self') {
      return { success: false, error: 'A product cannot be a component of itself' }
    }
    if (preflight.kind === 'cycle') {
      return { success: false, error: 'Circular reference detected — a component eventually references this product' }
    }

    const _p = await db.product.findUnique({ where: { id: productId }, select: { sku: true } })
    const _sku = _p?.sku ?? productId

    // audit-H6: in-progress production orders for this product froze their
    // component requirements at start, so this edit will NOT change what they
    // consume or release — but the operator should know the edit won't apply to
    // them. Surface them so the UI can warn.
    const inProgressProductionOrders = await db.productionOrder.findMany({
      where: { outputProductId: productId, status: 'IN_PROGRESS' },
      select: { id: true, reference: true },
    })

    // o3d-t0zq. Two defects here, both closed by the same transaction.
    //
    // ATOMICITY: the delete and the create were separate top-level statements, so a reader
    // landing between them saw a KIT with NO components — and a failure between them left it
    // that way permanently.
    //
    // SERIALIZATION: the cycle check above ran outside any transaction or lock, so two
    // concurrent saves could each validate and then both commit a cycle. The graph lock makes
    // check-and-write atomic with respect to the graph being checked; see its docstring for
    // why a per-product lock cannot do this.
    const conflict = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMPONENT_GRAPH_WRITE_LOCK_KEY})`

      // BOTH families, graph first — the same order the CSV component pass uses, which is what
      // keeps them deadlock-free. The graph lock alone is not enough: it serializes this
      // against other COMPONENT writers, but the editor and the CSV conversion paths take only
      // the PER-SKU lock, so they never contend with it. Without this, an editor could commit
      // type=SIMPLE and delete the components between the type read below and the create,
      // leaving a SIMPLE product with components (Codex review).
      await lockProductSkusForWrite(tx, [_sku])

      // Re-checked under the lock, against tx — the preflight above read a graph another
      // writer may since have changed.
      const cycle = await detectComponentCycle(productId, components.map((c) => c.componentId), tx)
      if (cycle.kind === 'self') return 'self' as const
      if (cycle.kind === 'cycle') return 'cycle' as const

      // This never checked the product's own type at all, so it would happily write components
      // onto a SIMPLE product — the state o3d-w998 stops the CSV import creating.
      const current = await tx.product.findUnique({ where: { id: productId }, select: { sku: true, type: true } })
      if (!current) return 'missing' as const
      // The lock set was chosen from `_sku`, read before this transaction. If the product has
      // been renamed since, the lock is held for a sku it no longer has — locked, but against
      // the wrong thing.
      if (current.sku !== _sku) return 'moved' as const
      if (current.type !== 'KIT' && current.type !== 'BOM') return 'not-component-bearing' as const

      // o3d-4kfh r4 (Codex finding 1): REFUSE WHILE SALES WORK IS IN FLIGHT AGAINST THIS GRAPH.
      //
      // Every fulfilment consumer expands the CURRENT component graph, so re-composing a KIT that
      // an order has already allocated or picked retroactively changes what that order requires —
      // and no downstream check could see it: the flat committed-coverage backstop compares per
      // (line, warehouse, product), the dispatch cap only rejects leaves that EXCEED demand, and
      // whole-kit coverage credits the half-kit that ships. The result was a dispatched incomplete
      // kit that the census reported as healthy.
      //
      // Inside the transaction and under the same advisory graph lock as the write, so an
      // allocation cannot commit between the check and the edit. See the guard module for why only
      // KIT-typed ancestors are affected, and why a PENDING draft alone does not block.
      const blockers = await findComponentGraphEditBlockers(tx, productId)
      if (blockers.length > 0) return { kind: 'in-flight-sales' as const, blockers }

      await tx.productComponent.deleteMany({ where: { productId } })
      if (components.length > 0) {
        await tx.productComponent.createMany({
          data: components.map((c, i) => ({
            productId,
            componentId: c.componentId,
            qty: c.qty,
            sortOrder: i,
          })),
        })
      }
      return null
    })
    if (conflict === 'self') return { success: false, error: 'A product cannot be a component of itself' }
    if (conflict === 'cycle') {
      return { success: false, error: 'Circular reference detected — a component eventually references this product' }
    }
    if (conflict === 'missing') return { success: false, error: 'Product not found' }
    if (conflict === 'moved') {
      return { success: false, error: 'This product was renamed while saving — reload and try again' }
    }
    if (conflict === 'not-component-bearing') {
      return { success: false, error: 'This product is no longer a kit or BOM, so it cannot have components' }
    }
    if (conflict && typeof conflict === 'object' && conflict.kind === 'in-flight-sales') {
      return { success: false, error: describeComponentGraphEditBlockers(conflict.blockers) }
    }
    const warnings = await findMatchingProductComponentConfigurations(productId, components)
    await logActivity({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'updated',
      tag: 'manufacturing',
      level: inProgressProductionOrders.length > 0 ? 'WARNING' : 'INFO',
      description: inProgressProductionOrders.length > 0
        ? `Updated BOM/kit components for SKU ${_sku} while ${inProgressProductionOrders.length} production order(s) are in progress (${inProgressProductionOrders.map((o) => o.reference).join(', ')}); those orders keep their frozen component snapshot and are unaffected.`
        : `Updated BOM/kit components for SKU ${_sku}`,
      metadata: { componentCount: components.length, duplicateComponentMatches: warnings.length, inProgressProductionOrders },
    })

    revalidatePath(`/inventory/${productId}`)
    return { success: true, warnings, inProgressProductionOrders }
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : 'Failed to save components'
    await logActivity({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'updated',
      tag: 'manufacturing',
      level: 'ERROR',
      description: `Failed to update BOM/kit components for SKU ${productId}`,
      metadata: { error: errorMsg },
    })
    return { success: false, error: errorMsg }
  }
}

export type KitStockRow = {
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  calculatedQty: number   // max kits that can be assembled
  limitingComponent: string | null  // SKU of the bottleneck component
}

export async function getKitStock(productId: string): Promise<KitStockRow[]> {
  await requireAuth()
  const components = await db.productComponent.findMany({
    where: { productId },
    include: { component: { select: { id: true, sku: true } } },
  })
  if (components.length === 0) return []

  const warehouses = await db.warehouse.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })

  const componentIds = components.map((c) => c.componentId)

  // All stock levels for component products
  const stockLevels = await db.stockLevel.findMany({
    where: { productId: { in: componentIds } },
    select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
  })

  // Build lookup: componentId → warehouseId → available (quantity - reservedQty)
  const stockMap = new Map<string, Map<string, number>>()
  for (const s of stockLevels) {
    if (!stockMap.has(s.productId)) stockMap.set(s.productId, new Map())
    stockMap.get(s.productId)!.set(s.warehouseId, Number(s.quantity) - Number(s.reservedQty))
  }

  return warehouses.map((w) => {
    let minQty = Infinity
    let limitingComponent: string | null = null

    for (const comp of components) {
      const required = Number(comp.qty)
      const available = Math.max(0, stockMap.get(comp.componentId)?.get(w.id) ?? 0)
      const canMake = required > 0 ? Math.floor(available / required) : 0

      if (canMake < minQty) {
        minQty = canMake
        limitingComponent = comp.component.sku
      }
    }

    return {
      warehouseId: w.id,
      warehouseCode: w.code,
      warehouseName: w.name,
      calculatedQty: minQty === Infinity ? 0 : minQty,
      limitingComponent: minQty === Infinity ? null : limitingComponent,
    }
  })
}

// ---------------------------------------------------------------------------
// Product Options (for VARIABLE products)
// ---------------------------------------------------------------------------

export type ProductOptionRow = {
  id: string
  name: string
  values: string
  sortOrder: number
}

export async function getProductOptions(productId: string): Promise<ProductOptionRow[]> {
  await requireAuth()
  return db.productOption.findMany({
    where: { productId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, values: true, sortOrder: true },
  })
}

export async function saveProductOptions(
  productId: string,
  options: { name: string; values: string }[]
): Promise<{ success: boolean }> {
  await requirePermission('inventory.edit')
  const _p = await db.product.findUnique({ where: { id: productId }, select: { sku: true } })
  const _sku = _p?.sku ?? productId
  await db.productOption.deleteMany({ where: { productId } })
  if (options.length > 0) {
    await db.productOption.createMany({
      data: options.map((o, i) => ({
        productId,
        name: o.name.trim(),
        values: o.values,
        sortOrder: i,
      })),
    })
  }
  await logActivity({
    entityType: 'PRODUCT',
    entityId: productId,
    action: 'updated',
    tag: 'inventory',
    level: 'INFO',
    description: `Updated variant options for SKU ${_sku}`,
    metadata: { optionCount: options.length },
  })

  revalidatePath(`/inventory/${productId}`)
  return { success: true }
}

export async function generateVariantsFromOptions(
  productId: string,
  variantType: 'VARIANT' | 'KIT' | 'BOM' = 'VARIANT'
): Promise<{ created: number; skipped: number; error?: string }> {
  await requirePermission('inventory.edit')
  if (variantType !== 'VARIANT' && variantType !== 'KIT' && variantType !== 'BOM') {
    return { created: 0, skipped: 0, error: 'Invalid variant type' }
  }
  const [product, options] = await Promise.all([
    db.product.findUnique({
      where: { id: productId },
      select: { sku: true, name: true, type: true, weight: true, widthCm: true, heightCm: true, depthCm: true, hsCode: true, countryOfOrigin: true, customsDescription: true },
    }),
    db.productOption.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } }),
  ])

  if (!product || product.type !== 'VARIABLE') {
    await logActivity({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'created',
      tag: 'inventory',
      level: 'ERROR',
      description: `Failed to generate variants: product not found or not VARIABLE type`,
      metadata: { productId },
    })
    return { created: 0, skipped: 0, error: 'Product not found or not VARIABLE type' }
  }
  if (options.length === 0) {
    await logActivity({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'created',
      tag: 'inventory',
      level: 'ERROR',
      description: `Failed to generate variants: no options defined for SKU ${product.sku}`,
      metadata: { productId },
    })
    return { created: 0, skipped: 0, error: 'No options defined — save options first' }
  }

  const optionValues = options.map((o) =>
    o.values.split(',').map((v) => v.trim()).filter(Boolean)
  )

  // Cartesian product of all option value arrays
  const combinations = optionValues.reduce<string[][]>(
    (acc, arr) => acc.flatMap((combo) => arr.map((v) => [...combo, v])),
    [[]]
  )

  const existingVariants = await db.product.findMany({
    where: { parentId: productId },
    select: { sku: true },
  })
  const existingSkus = new Set(existingVariants.map((v) => v.sku))

  // Determine next sequential number from highest existing -NN suffix
  const highestNum = existingVariants.reduce((max, v) => {
    const match = v.sku.match(/-(\d+)$/)
    return match ? Math.max(max, parseInt(match[1], 10)) : max
  }, 0)

  let nextNum = highestNum + 1
  let created = 0
  let skipped = 0
  const createdVariantIds: string[] = []

  for (const combo of combinations) {
    const sku = `${product.sku}-${String(nextNum).padStart(2, '0')}`
    const name = `${product.name} - ${combo.join(' ')}`
    nextNum++

    if (existingSkus.has(sku)) {
      skipped++
      continue
    }

    // o3d-42hw: each variant create takes its own SKU lock and re-checks under it. The
    // existingSkus set was built before this loop, so a WooCommerce import creating this
    // variant SKU in between raised a P2002 that aborted the whole generation run.
    const createdVariant = await db.$transaction(async (tx) => {
      await lockProductSkusForWrite(tx, [sku])
      const taken = await tx.product.findUnique({ where: { sku }, select: { id: true } })
      if (taken) return null
      return tx.product.create({
      data: {
        sku,
        name,
        type: variantType,
        parentId: productId,
        active: true,
        lifecycleStatus: 'ACTIVE',
        weight:   product.weight   ?? undefined,
        widthCm:  product.widthCm  ?? undefined,
        heightCm: product.heightCm ?? undefined,
        depthCm:  product.depthCm  ?? undefined,
        // Variants inherit the parent's customs data; can be overridden per variant afterwards.
        hsCode:             product.hsCode             ?? undefined,
        // bhdm.7: normalise the inherited origin so a legacy reserved/noncanonical parent value (EU/ZZ/'ad') is
        // never multiplied verbatim into new variant rows, bypassing productSchema.
        countryOfOrigin:    toIsoCountryCode(product.countryOfOrigin) ?? undefined,
        customsDescription: product.customsDescription ?? undefined,
      },
      })
    })
    // Another writer got there first. Counted as skipped, exactly as a SKU already present
    // in `existingSkus` is — the outcome an operator sees is the same either way.
    if (!createdVariant) {
      skipped++
      continue
    }
    createdVariantIds.push(createdVariant.id)
    created++
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: productId,
    action: 'created',
    tag: 'inventory',
    level: 'INFO',
    description: `Generated ${created} variants for SKU ${product.sku}`,
    metadata: { created, skipped },
  })

  for (const variantId of createdVariantIds) {
    try {
      await pushProductMetadata(variantId)
    } catch (syncError) {
      console.error(syncError)
    }
    try {
      await enqueueStockSync([variantId], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
  }

  revalidatePath(`/inventory/${productId}`)
  return { created, skipped }
}

export async function deleteOrDeactivateVariant(
  id: string,
  forceDeactivate = false
): Promise<{ action: 'deleted' | 'deactivated' | 'error'; error?: string }> {
  await requirePermission('inventory.edit')
  const product = await db.product.findUnique({
    where: { id },
    select: { type: true, parentId: true },
  })
  if (!product || !product.parentId) {
    await logActivity({
      entityType: 'PRODUCT',
      entityId: id,
      action: 'deleted',
      tag: 'inventory',
      level: 'ERROR',
      description: `Failed to delete/deactivate variant ${id}: not a child product`,
      metadata: null,
    })
    return { action: 'error', error: 'Not a child product' }
  }

  if (!forceDeactivate) {
    const [movements, orderLines, poLines, costLayers, returnLines] = await Promise.all([
      db.stockMovement.count({ where: { productId: id } }),
      db.salesOrderLine.count({ where: { productId: id } }),
      db.purchaseOrderLine.count({ where: { productId: id } }),
      db.costLayer.count({ where: { productId: id } }),
      db.salesOrderRefundLine.count({ where: { productId: id } }),
    ])

    if (movements > 0 || orderLines > 0 || poLines > 0 || costLayers > 0 || returnLines > 0) {
      return { action: 'error', error: 'HAS_ACTIVITY' }
    }

    // Clean up auxiliary records before deletion
    await db.stockLevel.deleteMany({ where: { productId: id } })
    await db.shoppingSyncLog.deleteMany({ where: { entityType: 'Product', entityId: id } })
    await db.supplierProduct.deleteMany({ where: { productId: id } })
    await db.product.delete({ where: { id } })

    await logActivity({
      entityType: 'PRODUCT',
      entityId: id,
      action: 'deleted',
      tag: 'inventory',
      level: 'INFO',
      description: `Deleted variant ${id}`,
      metadata: { parentId: product.parentId },
    })

    if (product.parentId) revalidatePath(`/inventory/${product.parentId}`)
    revalidatePath('/inventory')
    return { action: 'deleted' }
  } else {
    await db.product.update({
      where: { id },
      data: { active: true, lifecycleStatus: 'EOL' },
    })

    await logActivity({
      entityType: 'PRODUCT',
      entityId: id,
      action: 'deactivated',
      tag: 'inventory',
      level: 'INFO',
      description: `Deactivated variant ${id}`,
      metadata: { parentId: product.parentId },
    })

    try {
      await pushProductMetadata(id)
    } catch (syncError) {
      console.error(syncError)
    }
    try {
      await enqueueStockSync([id], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    if (product.parentId) revalidatePath(`/inventory/${product.parentId}`)
    revalidatePath(`/inventory/${id}`)
    return { action: 'deactivated' }
  }
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

export async function bulkDeleteProducts(
  ids: string[]
): Promise<{ deleted: number; skipped: { sku: string; reason: string }[] }> {
  await requirePermission('inventory.edit')
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, sku: true },
  })

  // Batch all existence checks in parallel instead of per-product N+1
  const [movementHits, orderLineHits, poLineHits, costLayerHits, returnLineHits, variantHits] = await Promise.all([
    db.stockMovement.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    db.salesOrderLine.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    db.purchaseOrderLine.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    db.costLayer.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    db.salesOrderRefundLine.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    db.product.groupBy({ by: ['parentId'], where: { parentId: { in: ids } }, _count: true }),
  ])

  const hasMovements = new Set(movementHits.map((r) => r.productId))
  const hasOrderLines = new Set(orderLineHits.map((r) => r.productId))
  const hasPoLines = new Set(poLineHits.map((r) => r.productId))
  const hasCostLayers = new Set(costLayerHits.map((r) => r.productId))
  const hasReturnLines = new Set(returnLineHits.map((r) => r.productId))
  const hasVariants = new Set(variantHits.map((r) => r.parentId).filter(Boolean))

  let deleted = 0
  const skipped: { sku: string; reason: string }[] = []

  for (const product of products) {
    if (hasVariants.has(product.id)) {
      skipped.push({ sku: product.sku, reason: 'has variants' })
      continue
    }
    if (hasMovements.has(product.id) || hasOrderLines.has(product.id) || hasPoLines.has(product.id) || hasCostLayers.has(product.id) || hasReturnLines.has(product.id)) {
      skipped.push({ sku: product.sku, reason: 'has activity' })
      continue
    }

    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.shoppingSyncLog.deleteMany({ where: { entityType: 'Product', entityId: product.id } })
    await db.supplierProduct.deleteMany({ where: { productId: product.id } })
    await db.productOption.deleteMany({ where: { productId: product.id } })
    await db.product.delete({ where: { id: product.id } })
    deleted++
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: null,
    action: 'bulk_deleted',
    tag: 'inventory',
    level: 'INFO',
    description: `Bulk deleted ${deleted} products`,
    metadata: { deleted, skippedCount: skipped.length, skipped },
  })

  revalidatePath('/inventory')
  return { deleted, skipped }
}

export async function bulkDeactivateProducts(
  ids: string[]
): Promise<{ deactivated: number }> {
  await requirePermission('inventory.edit')
  await db.product.updateMany({
    where: { id: { in: ids } },
    data: { active: true, lifecycleStatus: 'EOL' },
  })
  await logActivity({
    entityType: 'PRODUCT',
    entityId: null,
    action: 'bulk_deactivated',
    tag: 'inventory',
    level: 'INFO',
    description: `Bulk deactivated ${ids.length} products`,
    metadata: { count: ids.length },
  })

  const syncTargets = [...new Set(ids)]
  const productSyncResults = await Promise.allSettled(syncTargets.map(async (id) => pushProductMetadata(id)))
  for (const result of productSyncResults) {
    if (result.status === 'rejected') console.error(result.reason)
    else if (!result.value.success && result.value.error) console.error(result.value.error)
  }
  try {
    await enqueueStockSync(syncTargets, 'IMS_CHANGE')
  } catch (syncError) {
    console.error(syncError)
  }

  revalidatePath('/inventory')
  return { deactivated: ids.length }
}

// ---------------------------------------------------------------------------
// Stock allocation & incoming details (for popups on product page)
// ---------------------------------------------------------------------------

export type AllocationDetail = {
  type: 'sales_order' | 'manufacturing_order'
  id: string
  reference: string
  qty: number
  status: string
}

export async function getAllocationDetails(productId: string, warehouseId: string): Promise<AllocationDetail[]> {
  await requireAuth()
  const [salesAllocs, moOrders] = await Promise.all([
    // Sales order allocations for this product from this warehouse
    db.orderAllocation.findMany({
      where: {
        productId,
        warehouseId,
        order: {
          status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'ON_HOLD'] },
        },
      },
      select: {
        // o3d-4kfh: lineId is half the grain a dispatch is attributed at — a shipment line carries
        // (lineId, productId) and its shipment the warehouseId — so it is needed to net below.
        lineId: true,
        qty: true,
        order: { select: { id: true, externalOrderNumber: true, status: true } },
      },
    }),
    // Manufacturing orders reserving this product (as component for assembly, or as output for disassembly)
    db.productionOrder.findMany({
      where: {
        status: 'IN_PROGRESS',
        warehouseId,
        OR: [
          // Assembly: this product is a component
          {
            orderType: 'ASSEMBLY',
            outputProduct: { productComponents: { some: { componentId: productId } } },
          },
          // Disassembly: this product is the output being disassembled
          {
            orderType: 'DISASSEMBLY',
            outputProductId: productId,
          },
        ],
      },
      select: {
        id: true,
        reference: true,
        orderType: true,
        qtyPlanned: true,
        status: true,
        outputProduct: {
          select: {
            productComponents: {
              where: { componentId: productId },
              select: { qty: true },
            },
          },
        },
      },
    }),
  ])

  // o3d-4kfh: this popup explains a stock level's RESERVED quantity, so it must report the LIVE
  // reservation — `OrderAllocation.qty` is the order's whole claim, retained through dispatch. A
  // partially shipped order commonly stays ALLOCATED, so a row of 10 with 5 already dispatched was
  // reported as 10 reserved when only 5 of it still contributes to reservedQty.
  const dispatchedByScope = sumDispatchedQtyByAllocationScope(
    salesAllocs.length === 0
      ? []
      : (await db.shipmentLine.findMany({
        where: {
          productId,
          lineId: { in: [...new Set(salesAllocs.map((alloc) => alloc.lineId))] },
          shipment: { warehouseId, status: RESERVATION_RELEASING_SHIPMENT_STATUS },
        },
        select: {
          lineId: true,
          productId: true,
          qty: true,
          shipment: { select: { warehouseId: true } },
        },
      })).map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        warehouseId: line.shipment.warehouseId,
        qty: line.qty,
      })),
  )

  const results: AllocationDetail[] = []

  for (const alloc of salesAllocs) {
    const liveQty = residualAllocationQty(
      { lineId: alloc.lineId, productId, warehouseId, qty: alloc.qty },
      dispatchedByScope,
    ).toNumber()
    // A fully dispatched row holds no reservation at all; listing it as a 0 would imply the
    // reserved balance has a source it does not have.
    if (liveQty <= 0) continue
    results.push({
      type: 'sales_order',
      id: alloc.order.id,
      reference: alloc.order.externalOrderNumber ?? alloc.order.id.slice(0, 8),
      qty: liveQty,
      status: alloc.order.status,
    })
  }

  for (const mo of moOrders) {
    let qty: number
    if (mo.orderType === 'DISASSEMBLY') {
      qty = Number(mo.qtyPlanned)
    } else {
      // Assembly: qty = component qty per unit * planned units
      const compQty = mo.outputProduct.productComponents[0]?.qty
      qty = compQty ? Number(compQty) * Number(mo.qtyPlanned) : Number(mo.qtyPlanned)
    }
    results.push({
      type: 'manufacturing_order',
      id: mo.id,
      reference: mo.reference,
      qty,
      status: mo.status,
    })
  }

  return results
}

export type IncomingDetail = {
  type: 'purchase_order' | 'transfer'
  id: string
  reference: string
  qty: number
  status: string
  expectedDate: string | null
}

export async function getIncomingDetails(productId: string, warehouseId: string): Promise<IncomingDetail[]> {
  await requireAuth()
  const [poLines, transferLines] = await Promise.all([
    // PO lines incoming to this warehouse
    db.purchaseOrderLine.findMany({
      where: {
        productId,
        po: {
          destinationWarehouseId: warehouseId,
          status: { in: INCOMING_PO_STATUSES },
        },
      },
      select: {
        qty: true,
        qtyReceived: true,
        po: { select: { id: true, reference: true, status: true, expectedDelivery: true } },
      },
    }),
    // Transfer lines incoming to this warehouse
    db.stockTransferLine.findMany({
      where: {
        productId,
        transfer: {
          toWarehouseId: warehouseId,
          status: 'IN_TRANSIT',
        },
      },
      select: {
        qty: true,
        qtyReceived: true,
        transfer: { select: { id: true, reference: true, status: true } },
      },
    }),
  ])

  const results: IncomingDetail[] = []

  for (const line of poLines) {
    const remaining = Number(line.qty) - Number(line.qtyReceived)
    if (remaining > 0) {
      results.push({
        type: 'purchase_order',
        id: line.po.id,
        reference: line.po.reference,
        qty: remaining,
        status: line.po.status,
        expectedDate: line.po.expectedDelivery?.toISOString() ?? null,
      })
    }
  }

  for (const line of transferLines) {
    const remaining = Number(line.qty) - Number(line.qtyReceived)
    if (remaining > 0) {
      results.push({
        type: 'transfer',
        id: line.transfer.id,
        reference: line.transfer.reference,
        qty: remaining,
        status: line.transfer.status,
        expectedDate: null,
      })
    }
  }

  return results
}
