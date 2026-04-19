import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const HEADERS = ['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty', 'notes']
const REQUIRED_HEADERS = ['fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role, 'stock_control')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(buildTemplateCsv(HEADERS, REQUIRED_HEADERS), 'transfers-template.csv')
  }
  const rows = await db.stockTransfer.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      fromWarehouse: { select: { code: true } },
      toWarehouse: { select: { code: true } },
      lines: { select: { sku: true, productName: true, qty: true, qtyReceived: true } },
    },
    take: 5000,
  })
  const data: Record<string, unknown>[] = []
  for (const t of rows) {
    for (const l of t.lines) {
      data.push({
        transferKey: t.reference,
        fromWarehouseCode: t.fromWarehouse.code,
        toWarehouseCode: t.toWarehouse.code,
        status: t.status,
        sku: l.sku,
        qty: Number(l.qty),
        notes: t.notes ?? '',
      })
    }
  }
  return csvResponse(toCsv(data, HEADERS), `transfers-${new Date().toISOString().slice(0, 10)}.csv`)
}
