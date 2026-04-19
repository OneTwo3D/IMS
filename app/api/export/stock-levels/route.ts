import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const HEADERS = ['sku', 'warehouseCode', 'qty', 'unitCostBase', 'productName', 'type', 'stockUnit', 'warehouseName', 'reserved', 'available', 'inventoryValueBase']
const TEMPLATE_HEADERS = HEADERS
const REQUIRED_HEADERS = ['sku', 'warehouseCode', 'qty', 'unitCostBase']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role, 'inventory')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (req.nextUrl.searchParams.get('template') === '1') {
    return csvResponse(
      buildTemplateCsv(TEMPLATE_HEADERS, REQUIRED_HEADERS, [{
        sku: 'WIDGET-001',
        warehouseCode: 'DEFAULT',
        qty: '25',
        unitCostBase: '4.50',
        productName: 'Widget',
        type: 'SIMPLE',
        stockUnit: 'pcs',
        warehouseName: 'Default',
        reserved: '0',
        available: '25',
        inventoryValueBase: '112.50',
      }]),
      'stock-levels-opening-stock-template.csv',
    )
  }

  const warehouseIds = req.nextUrl.searchParams.get('warehouses')?.split(',').filter(Boolean)
  const includeBundlesParam = req.nextUrl.searchParams.get('includeBundles')
  const excludeBundles = includeBundlesParam === '0' || req.nextUrl.searchParams.get('excludeBundles') === '1'

  const where: Record<string, unknown> = {}
  if (warehouseIds?.length) where.warehouseId = { in: warehouseIds }

  const levels = await db.stockLevel.findMany({
    where,
    include: {
      product: { select: { sku: true, name: true, type: true, stockUnit: true } },
      warehouse: { select: { code: true, name: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
  })

  const filtered = excludeBundles
    ? levels.filter((l) => l.product.type !== 'KIT' && l.product.type !== 'BOM')
    : levels

  const productIds = Array.from(new Set(filtered.map((level) => level.productId)))
  const exportWarehouseIds = Array.from(new Set(filtered.map((level) => level.warehouseId)))
  const costLayers = productIds.length > 0 && exportWarehouseIds.length > 0
    ? await db.costLayer.findMany({
        where: {
          productId: { in: productIds },
          warehouseId: { in: exportWarehouseIds },
          remainingQty: { gt: 0 },
        },
        select: {
          productId: true,
          warehouseId: true,
          remainingQty: true,
          unitCostBase: true,
        },
      })
    : []

  const costSummaryByPair = new Map<string, { totalQty: number; totalValue: number }>()
  for (const layer of costLayers) {
    const key = `${layer.productId}:${layer.warehouseId}`
    const current = costSummaryByPair.get(key) ?? { totalQty: 0, totalValue: 0 }
    const qty = Number(layer.remainingQty)
    const unitCostBase = Number(layer.unitCostBase)
    current.totalQty += qty
    current.totalValue += qty * unitCostBase
    costSummaryByPair.set(key, current)
  }

  const data = filtered.map((l) => {
    const key = `${l.productId}:${l.warehouseId}`
    const costSummary = costSummaryByPair.get(key)
    const qty = Number(l.quantity)
    const unitCostBase = costSummary && costSummary.totalQty > 0
      ? costSummary.totalValue / costSummary.totalQty
      : 0

    return {
      sku: l.product.sku,
      warehouseCode: l.warehouse.code,
      qty,
      unitCostBase: unitCostBase.toFixed(6),
      productName: l.product.name,
      type: l.product.type,
      stockUnit: l.product.stockUnit,
      warehouseName: l.warehouse.name,
      reserved: Number(l.reservedQty),
      available: qty - Number(l.reservedQty),
      inventoryValueBase: (qty * unitCostBase).toFixed(2),
    }
  })

  return csvResponse(toCsv(data, HEADERS), `stock-levels-${new Date().toISOString().slice(0, 10)}.csv`)
}
