import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'

const HEADERS = ['orderNumber', 'status', 'customerName', 'customerEmail', 'currency', 'subtotal', 'shipping', 'tax', 'total', 'totalGbp', 'warehouse', 'salesRep', 'expectedDelivery', 'trackingNumber', 'shippedAt', 'createdAt', 'notes']

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(['customerName', 'currency', 'notes'].join(',') + '\r\n', 'sales-orders-template.csv')
  }
  const rows = await db.salesOrder.findMany({
    orderBy: { createdAt: 'desc' },
    include: { shipFromWarehouse: { select: { code: true } } },
    take: 5000,
  })
  const data = rows.map((r) => ({
    orderNumber: r.wcOrderNumber, status: r.status, customerName: r.customerName, customerEmail: r.customerEmail,
    currency: r.currency, subtotal: Number(r.subtotalForeign).toFixed(2), shipping: Number(r.shippingForeign).toFixed(2),
    tax: Number(r.taxForeign).toFixed(2), total: Number(r.totalForeign).toFixed(2), totalGbp: Number(r.totalGbp).toFixed(2),
    warehouse: r.shipFromWarehouse?.code, salesRep: r.salesRep,
    expectedDelivery: r.expectedDelivery?.toISOString().slice(0, 10),
    trackingNumber: r.trackingNumber, shippedAt: r.shippedAt?.toISOString().slice(0, 10),
    createdAt: r.createdAt.toISOString().slice(0, 10), notes: r.notes,
  }))
  return csvResponse(toCsv(data, HEADERS), `sales-orders-${new Date().toISOString().slice(0, 10)}.csv`)
}
