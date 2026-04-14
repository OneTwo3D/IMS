'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { ProductType } from '@/app/generated/prisma/client'
import {
  COMPONENT_PRODUCT_STATUSES,
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromLegacyActive,
} from '@/lib/products/lifecycle'
import type { ProductLifecycleStatus, TaxCategory } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProductRow = {
  id: string
  sku: string
  name: string
  type: ProductType
  parentSku: string | null
  barcode: string | null
  weight: string | null
  widthCm: string | null
  heightCm: string | null
  depthCm: string | null
  imageUrl: string | null
  salesPriceGbp: string | null   // regular / list price
  salePriceGbp: string | null    // sale / discounted price
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
  inventoryValue: string  // sum of remainingQty * unitCostGbp
  createdAt: Date
  updatedAt: Date
}

export type ProductDetail = ProductRow & {
  parentId: string | null   // DB id of parent product (for breadcrumb linking)
  description: string | null
  widthCm: string | null
  heightCm: string | null
  depthCm: string | null
  hsCode: string | null
  countryOfOrigin: string | null
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
  costLayers: { id: string; receivedAt: Date; receivedQty: string; remainingQty: string; unitCostGbp: string }[]
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

export type SortField = 'sku' | 'name' | 'type' | 'salesPriceGbp' | 'totalStock' | 'active' | 'createdAt' | 'updatedAt'
export type SortDir = 'asc' | 'desc'

// Fields that can be sorted directly in the DB query
const DB_SORT_FIELDS = new Set(['sku', 'name', 'type', 'salesPriceGbp', 'active', 'createdAt', 'updatedAt'])

export async function listProducts(params: {
  search?: string
  type?: ProductType | 'ALL'
  active?: 'true' | 'false' | 'all'
  lifecycleStatus?: ProductLifecycleStatus | 'ALL'
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
            { variants: { some: { sku: { contains: params.search, mode: 'insensitive' as const } } } },
          ],
        }
      : {}),
    // By default exclude VARIANT products; pass type='ALL' to include everything
    ...(params.type === 'ALL'
      ? {}
      : params.type
      ? { type: params.type as ProductType }
      : { type: { not: 'VARIANT' as const } }),
    ...(params.lifecycleStatus && params.lifecycleStatus !== 'ALL'
      ? { lifecycleStatus: params.lifecycleStatus }
      : params.active === 'true'
      ? { lifecycleStatus: { in: COMPONENT_PRODUCT_STATUSES } }
      : params.active === 'false'
      ? { lifecycleStatus: 'ARCHIVED' as const }
      : {}),
  }

  const [rawProducts, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        parent: { select: { sku: true, imageUrl: true } },
        variants: {
          select: {
            id: true,
            imageUrl: true,
            salesPriceGbp: true,
            salePriceGbp: true,
            stockLevels: { select: { quantity: true, reservedQty: true } },
          },
        },
        stockLevels: { select: { quantity: true, reservedQty: true } },
        costLayers: {
          where: { remainingQty: { gt: 0 } },
          select: { remainingQty: true, unitCostGbp: true },
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
        po: { status: { in: ['DRAFT', 'RFQ_SENT', 'PO_SENT', 'PARTIALLY_RECEIVED'] }, type: 'GOODS' },
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
      const prices = p.variants.map((v) => Number(v.salesPriceGbp)).filter((n) => n > 0)
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
    type: p.type,
    parentSku: p.parent?.sku ?? null,
    barcode: p.barcode,
    weight: p.weight?.toString() ?? null,
    widthCm: p.widthCm?.toString() ?? null,
    heightCm: p.heightCm?.toString() ?? null,
    depthCm: p.depthCm?.toString() ?? null,
    imageUrl: p.imageUrl ?? p.parent?.imageUrl ?? null,
    salesPriceGbp: p.salesPriceGbp?.toString() ?? null,
    salePriceGbp: p.salePriceGbp?.toString() ?? null,
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
      .reduce((sum, c) => sum + Number(c.remainingQty) * Number(c.unitCostGbp), 0)
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
  const [p, activeOrderLines, inTransferLines, openPoLines] = await Promise.all([
    db.product.findUnique({
      where: { id },
      include: {
        parent: { select: { sku: true, imageUrl: true } },
        variants: {
          include: { stockLevels: { select: { quantity: true, reservedQty: true } } },
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
          status: { in: ['DRAFT', 'RFQ_SENT', 'PO_SENT', 'PARTIALLY_RECEIVED'] },
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
          po: { status: { in: ['DRAFT', 'RFQ_SENT', 'PO_SENT', 'PARTIALLY_RECEIVED'] }, type: 'GOODS' },
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
  const kitUnitCost = isKitOrBom ? await computeKitUnitCostGbp(p.id) : 0
  const fifoInventoryValue = p.costLayers
    .reduce((sum, c) => sum + Number(c.remainingQty) * Number(c.unitCostGbp), 0)
  const totalStockQty = p.stockLevels.reduce((sum, s) => sum + Number(s.quantity), 0)
  const inventoryValue = isKitOrBom
    ? (p.type === 'BOM' ? kitUnitCost * totalStockQty : kitUnitCost).toFixed(2)
    : fifoInventoryValue.toFixed(2)

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    type: p.type,
    parentId: p.parentId,
    parentSku: p.parent?.sku ?? null,
    barcode: p.barcode,
    hsCode: p.hsCode ?? null,
    countryOfOrigin: p.countryOfOrigin ?? null,
    weight: p.weight?.toString() ?? null,
    widthCm: p.widthCm?.toString() ?? null,
    heightCm: p.heightCm?.toString() ?? null,
    depthCm: p.depthCm?.toString() ?? null,
    imageUrl: p.imageUrl ?? p.parent?.imageUrl ?? null,
    salesPriceGbp: p.salesPriceGbp?.toString() ?? null,
    salePriceGbp: p.salePriceGbp?.toString() ?? null,
    priceRange: p.type === 'VARIABLE' && p.variants.length > 0 ? (() => {
      const prices = p.variants.map((v) => Number(v.salesPriceGbp)).filter((n) => n > 0)
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
      type: v.type,
      parentSku: p.sku,
      barcode: v.barcode,
      weight: v.weight?.toString() ?? null,
      widthCm: v.widthCm?.toString() ?? null,
      heightCm: v.heightCm?.toString() ?? null,
      depthCm: v.depthCm?.toString() ?? null,
      imageUrl: v.imageUrl ?? p.imageUrl ?? null,
      salesPriceGbp: v.salesPriceGbp?.toString() ?? null,
      salePriceGbp: v.salePriceGbp?.toString() ?? null,
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
      unitCostGbp: c.unitCostGbp.toString(),
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

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const productSchema = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.nativeEnum(ProductType),
  parentId: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  hsCode: z.string().optional().nullable(),
  countryOfOrigin: z.string().max(2).optional().nullable(),
  weight: z.string().optional().nullable(),
  salesPriceGbp: z.string().optional().nullable(),
  salePriceGbp: z.string().optional().nullable(),
  salesPriceTaxInclusive: z.boolean().default(false),
  taxCategory: z.enum(['STANDARD', 'REDUCED', 'SECOND_REDUCED', 'ZERO', 'EXEMPT']).default('STANDARD'),
  stockUnit: z.string().default('pcs'),
  oversellAllowed: z.boolean().default(true),
  imageUrl: z.string().optional().nullable(),
  widthCm: z.string().optional().nullable(),
  heightCm: z.string().optional().nullable(),
  depthCm: z.string().optional().nullable(),
  active: z.boolean().default(true),
  lifecycleStatus: z.enum(['ACTIVE', 'NOT_FOR_SALE', 'ARCHIVED']).default('ACTIVE'),
})

export type ProductFormState = {
  errors?: Record<string, string[]>
  message?: string
}

export async function createProduct(
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  await requirePermission('inventory.edit')
  const raw = {
    sku: formData.get('sku') as string,
    name: formData.get('name') as string,
    description: formData.get('description') as string || undefined,
    type: formData.get('type') as string,
    parentId: formData.get('parentId') as string || null,
    barcode: formData.get('barcode') as string || null,
    hsCode: formData.get('hsCode') as string || null,
    countryOfOrigin: formData.get('countryOfOrigin') as string || null,
    weight: formData.get('weight') as string || null,
    salesPriceGbp: formData.get('salesPriceGbp') as string || null,
    salePriceGbp: formData.get('salePriceGbp') as string || null,
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

  const created = await db.product.create({
    data: {
      sku: data.sku,
      name: data.name,
      description: data.description || null,
      type: data.type,
      parentId: data.parentId || null,
      barcode: data.barcode || null,
      hsCode: data.hsCode || null,
      countryOfOrigin: data.countryOfOrigin || null,
      weight: data.weight ? data.weight : null,
      salesPriceGbp: data.salesPriceGbp ? data.salesPriceGbp : null,
      salePriceGbp: data.salePriceGbp ? data.salePriceGbp : null,
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
    },
  })

  await logActivity({
    entityType: 'PRODUCT',
    entityId: null,
    action: 'created',
    tag: 'inventory',
    level: 'INFO',
    description: `Created product ${data.sku} — ${data.name}`,
    metadata: { sku: data.sku, name: data.name, type: data.type },
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

  revalidatePath('/inventory')
  redirect('/inventory')
}

export async function updateProduct(
  id: string,
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  await requirePermission('inventory.edit')
  const raw = {
    sku: formData.get('sku') as string,
    name: formData.get('name') as string,
    description: formData.get('description') as string || undefined,
    type: formData.get('type') as string,
    parentId: formData.get('parentId') as string || null,
    barcode: formData.get('barcode') as string || null,
    hsCode: formData.get('hsCode') as string || null,
    countryOfOrigin: formData.get('countryOfOrigin') as string || null,
    weight: formData.get('weight') as string || null,
    salesPriceGbp: formData.get('salesPriceGbp') as string || null,
    salePriceGbp: formData.get('salePriceGbp') as string || null,
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

  await db.product.update({
    where: { id },
    data: {
      sku: data.sku,
      name: data.name,
      description: data.description || null,
      type: data.type,
      parentId: data.parentId || null,
      barcode: data.barcode || null,
      hsCode: data.hsCode || null,
      countryOfOrigin: data.countryOfOrigin || null,
      weight: data.weight ? data.weight : null,
      salesPriceGbp: data.salesPriceGbp ? data.salesPriceGbp : null,
      salePriceGbp: data.salePriceGbp ? data.salePriceGbp : null,
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
    },
  })

  await logActivity({
    entityType: 'PRODUCT',
    entityId: id,
    action: 'updated',
    tag: 'inventory',
    level: 'INFO',
    description: `Updated product ${data.sku} — ${data.name}`,
    metadata: { sku: data.sku, name: data.name, type: data.type },
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
  gbpEquivalent: string | null  // null = no FX rate stored
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

    let gbpEquivalent: string | null = null
    let fxRate: string | null = null
    let fxFetchedAt: Date | null = null

    if (r.currency === 'GBP') {
      gbpEquivalent = cost.toFixed(2)
      fxRate = '1'
    } else {
      const fx = fxMap.get(r.currency)
      if (fx) {
        gbpEquivalent = (cost / fx.rate).toFixed(2)
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
      gbpEquivalent,
      fxRate,
      fxFetchedAt,
      updatedAt: r.updatedAt,
    }
  })
}

// ---------------------------------------------------------------------------
// Kit/BOM COGS helper — unit cost of one assembled kit/BOM based on components
// ---------------------------------------------------------------------------

async function computeKitUnitCostGbp(productId: string): Promise<number> {
  const components = await db.productComponent.findMany({
    where: { productId },
    select: {
      qty: true,
      component: {
        select: {
          costLayers: {
            where: { remainingQty: { gt: 0 } },
            select: { remainingQty: true, unitCostGbp: true },
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
      ? layers.reduce((s, l) => s + Number(l.remainingQty) * Number(l.unitCostGbp), 0) / totalRemaining
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

/**
 * Detect circular references in the component graph.
 * Returns the cycle path if found, or null if safe.
 */
async function detectComponentCycle(
  productId: string,
  newComponentIds: string[],
): Promise<string | null> {
  // BFS: starting from each new component, walk its existing components to see if we reach productId
  const visited = new Set<string>()
  const queue = [...newComponentIds]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === productId) return productId // cycle detected
    if (visited.has(current)) continue
    visited.add(current)

    // Fetch this product's existing components
    const children = await db.productComponent.findMany({
      where: { productId: current },
      select: { componentId: true },
    })
    for (const child of children) {
      if (child.componentId === productId) return current // cycle: child points back to original
      queue.push(child.componentId)
    }
  }
  return null
}

export async function saveProductComponents(
  productId: string,
  components: { componentId: string; qty: string }[]
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('inventory.edit')
    // Check for self-reference
    if (components.some((c) => c.componentId === productId)) {
      return { success: false, error: 'A product cannot be a component of itself' }
    }

    // Check for circular references
    const cycle = await detectComponentCycle(productId, components.map((c) => c.componentId))
    if (cycle) {
      return { success: false, error: 'Circular reference detected — a component eventually references this product' }
    }

    const _p = await db.product.findUnique({ where: { id: productId }, select: { sku: true } })
    const _sku = _p?.sku ?? productId

    await db.productComponent.deleteMany({ where: { productId } })
    if (components.length > 0) {
      await db.productComponent.createMany({
        data: components.map((c, i) => ({
          productId,
          componentId: c.componentId,
          qty: c.qty,
          sortOrder: i,
        })),
      })
    }
    await logActivity({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'updated',
      tag: 'manufacturing',
      level: 'INFO',
      description: `Updated BOM/kit components for SKU ${_sku}`,
      metadata: { componentCount: components.length },
    })

    revalidatePath(`/inventory/${productId}`)
    return { success: true }
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
  productId: string
): Promise<{ created: number; skipped: number; error?: string }> {
  await requirePermission('inventory.edit')
  const [product, options] = await Promise.all([
    db.product.findUnique({
      where: { id: productId },
      select: { sku: true, name: true, type: true, weight: true, widthCm: true, heightCm: true, depthCm: true },
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

  for (const combo of combinations) {
    const sku = `${product.sku}-${String(nextNum).padStart(2, '0')}`
    const name = `${product.name} - ${combo.join(' ')}`
    nextNum++

    if (existingSkus.has(sku)) {
      skipped++
      continue
    }

    await db.product.create({
      data: {
        sku,
        name,
        type: 'VARIANT',
        parentId: productId,
        active: true,
        lifecycleStatus: 'ACTIVE',
        weight:   product.weight   ?? undefined,
        widthCm:  product.widthCm  ?? undefined,
        heightCm: product.heightCm ?? undefined,
        depthCm:  product.depthCm  ?? undefined,
      },
    })
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
  if (!product || product.type !== 'VARIANT') {
    await logActivity({
      entityType: 'PRODUCT',
      entityId: id,
      action: 'deleted',
      tag: 'inventory',
      level: 'ERROR',
      description: `Failed to delete/deactivate variant ${id}: not a variant product`,
      metadata: null,
    })
    return { action: 'error', error: 'Not a variant product' }
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
    await db.wcSyncLog.deleteMany({ where: { entityType: 'Product', entityId: id } })
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
      data: { active: true, lifecycleStatus: 'NOT_FOR_SALE' },
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

  let deleted = 0
  const skipped: { sku: string; reason: string }[] = []

  for (const product of products) {
    const [movements, orderLines, poLines, costLayers, returnLines, variantCount] = await Promise.all([
      db.stockMovement.count({ where: { productId: product.id } }),
      db.salesOrderLine.count({ where: { productId: product.id } }),
      db.purchaseOrderLine.count({ where: { productId: product.id } }),
      db.costLayer.count({ where: { productId: product.id } }),
      db.salesOrderRefundLine.count({ where: { productId: product.id } }),
      db.product.count({ where: { parentId: product.id } }),
    ])

    if (variantCount > 0) {
      skipped.push({ sku: product.sku, reason: 'has variants' })
      continue
    }
    if (movements > 0 || orderLines > 0 || poLines > 0 || costLayers > 0 || returnLines > 0) {
      skipped.push({ sku: product.sku, reason: 'has activity' })
      continue
    }

    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.wcSyncLog.deleteMany({ where: { entityType: 'Product', entityId: product.id } })
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
    data: { active: true, lifecycleStatus: 'NOT_FOR_SALE' },
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
        qty: true,
        order: { select: { id: true, wcOrderNumber: true, status: true } },
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

  const results: AllocationDetail[] = []

  for (const alloc of salesAllocs) {
    results.push({
      type: 'sales_order',
      id: alloc.order.id,
      reference: alloc.order.wcOrderNumber ?? alloc.order.id.slice(0, 8),
      qty: Number(alloc.qty),
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
          status: { in: ['PO_SENT', 'PARTIALLY_RECEIVED'] },
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
