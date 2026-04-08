import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'

const HEADERS = ['reference', 'type', 'status', 'supplier', 'currency', 'fxRate', 'subtotal', 'tax', 'total', 'totalGbp', 'warehouse', 'expectedDelivery', 'supplierRef', 'sku', 'productName', 'qty', 'unitCostForeign', 'unitCostGbp', 'lineTotal', 'qtyReceived', 'qtyReturned', 'notes']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(['supplierName', 'currency', 'sku', 'qty', 'unitCostForeign', 'notes'].join(',') + '\r\n', 'purchase-orders-template.csv')
  }
  const rows = await db.purchaseOrder.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      supplier: { select: { name: true } },
      destinationWarehouse: { select: { code: true } },
      lines: { select: { qty: true, unitCostForeign: true, unitCostGbp: true, totalForeign: true, qtyReceived: true, qtyReturned: true, product: { select: { sku: true, name: true } } } },
    },
    take: 5000,
  })
  const data: Record<string, unknown>[] = []
  for (const po of rows) {
    for (const l of po.lines) {
      data.push({
        reference: po.reference, type: po.type, status: po.status, supplier: po.supplier.name,
        currency: po.currency, fxRate: Number(po.fxRateToGbp), subtotal: Number(po.subtotalForeign).toFixed(2),
        tax: Number(po.taxForeign).toFixed(2), total: Number(po.totalForeign).toFixed(2), totalGbp: Number(po.totalGbp).toFixed(2),
        warehouse: po.destinationWarehouse?.code, expectedDelivery: po.expectedDelivery?.toISOString().slice(0, 10),
        supplierRef: po.supplierRef, sku: l.product.sku, productName: l.product.name,
        qty: Number(l.qty), unitCostForeign: Number(l.unitCostForeign).toFixed(4), unitCostGbp: Number(l.unitCostGbp).toFixed(4),
        lineTotal: Number(l.totalForeign).toFixed(2), qtyReceived: Number(l.qtyReceived), qtyReturned: Number(l.qtyReturned),
        notes: po.notes,
      })
    }
  }
  return csvResponse(toCsv(data, HEADERS), `purchase-orders-${new Date().toISOString().slice(0, 10)}.csv`)
}
