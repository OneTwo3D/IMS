import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'

const HEADERS = ['sku', 'productName', 'type', 'stockUnit', 'warehouse', 'quantity', 'reserved', 'available']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const warehouseIds = req.nextUrl.searchParams.get('warehouses')?.split(',').filter(Boolean)
  const excludeBundles = req.nextUrl.searchParams.get('excludeBundles') === '1'

  const where: Record<string, unknown> = {}
  if (warehouseIds?.length) where.warehouseId = { in: warehouseIds }

  const levels = await db.stockLevel.findMany({
    where,
    include: {
      product: { select: { sku: true, name: true, type: true, stockUnit: true } },
      warehouse: { select: { code: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
  })

  const filtered = excludeBundles
    ? levels.filter((l) => l.product.type !== 'KIT' && l.product.type !== 'BOM')
    : levels

  const data = filtered.map((l) => ({
    sku: l.product.sku,
    productName: l.product.name,
    type: l.product.type,
    stockUnit: l.product.stockUnit,
    warehouse: l.warehouse.code,
    quantity: Number(l.quantity),
    reserved: Number(l.reservedQty),
    available: Number(l.quantity) - Number(l.reservedQty),
  }))

  return csvResponse(toCsv(data, HEADERS), `stock-levels-${new Date().toISOString().slice(0, 10)}.csv`)
}
