import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'

const HEADERS = ['reference', 'status', 'fromWarehouse', 'toWarehouse', 'createdAt', 'dispatchedAt', 'completedAt', 'sku', 'productName', 'qty', 'qtyReceived', 'notes']

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(['fromWarehouseCode', 'toWarehouseCode', 'sku', 'qty', 'notes'].join(',') + '\r\n', 'transfers-template.csv')
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
        reference: t.reference, status: t.status, fromWarehouse: t.fromWarehouse.code, toWarehouse: t.toWarehouse.code,
        createdAt: t.createdAt.toISOString().slice(0, 10), dispatchedAt: t.dispatchedAt?.toISOString().slice(0, 10),
        completedAt: t.completedAt?.toISOString().slice(0, 10), sku: l.sku, productName: l.productName,
        qty: Number(l.qty), qtyReceived: Number(l.qtyReceived), notes: t.notes,
      })
    }
  }
  return csvResponse(toCsv(data, HEADERS), `transfers-${new Date().toISOString().slice(0, 10)}.csv`)
}
