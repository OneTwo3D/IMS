import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const HEADERS = [
  'orderKey',
  'customerName',
  'customerEmail',
  'currency',
  'fxRateToBase',
  'shipFromWarehouseCode',
  'sku',
  'qty',
  'unitPriceForeign',
  'lineDiscountForeign',
  'lineDiscountStr',
  'taxRateName',
  'taxRateValue',
  'orderTaxRateName',
  'orderTaxRateValue',
  'pricesIncludeVat',
  'shippingService',
  'shippingForeign',
  'orderDiscountForeign',
  'expectedDelivery',
  'salesRep',
  'notes',
]
const REQUIRED_HEADERS = ['customerName', 'sku', 'qty', 'unitPriceForeign']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(buildTemplateCsv(HEADERS, REQUIRED_HEADERS), 'sales-orders-template.csv')
  }
  const rows = await db.salesOrder.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      shipFromWarehouse: { select: { code: true } },
      lines: {
        select: {
          sku: true,
          qty: true,
          unitPriceForeign: true,
          discountAmount: true,
          discountStr: true,
          taxRate: { select: { name: true, rate: true } },
        },
      },
    },
    take: 5000,
  })
  const data: Record<string, unknown>[] = []
  for (const order of rows) {
    const orderKey = order.orderNumber ?? order.externalOrderNumber ?? order.id
    for (const line of order.lines) {
      data.push({
        orderKey,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        currency: order.currency,
        fxRateToBase: Number(order.fxRateToBase).toFixed(8),
        shipFromWarehouseCode: order.shipFromWarehouse?.code ?? '',
        sku: line.sku,
        qty: Number(line.qty),
        unitPriceForeign: Number(line.unitPriceForeign).toFixed(6),
        lineDiscountForeign: Number(line.discountAmount ?? 0).toFixed(4),
        lineDiscountStr: line.discountStr ?? '',
        taxRateName: line.taxRate?.name ?? '',
        taxRateValue: line.taxRate ? Number(line.taxRate.rate).toFixed(4) : '',
        orderTaxRateName: order.taxRateName ?? '',
        orderTaxRateValue: order.taxRatePercent != null ? Number(order.taxRatePercent).toFixed(4) : '',
        pricesIncludeVat: order.pricesIncludeVat ? 'TRUE' : 'FALSE',
        shippingService: order.shippingService ?? '',
        shippingForeign: Number(order.shippingForeign).toFixed(4),
        orderDiscountForeign: Number(order.discountAmount ?? 0).toFixed(4),
        expectedDelivery: order.expectedDelivery?.toISOString().slice(0, 10),
        salesRep: order.salesRep ?? '',
        notes: order.notes ?? '',
      })
    }
  }
  return csvResponse(toCsv(data, HEADERS), `sales-orders-${new Date().toISOString().slice(0, 10)}.csv`)
}
