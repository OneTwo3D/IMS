import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

const HEADERS = [
  'orderKey',
  'supplierName',
  'currency',
  'fxRateToBase',
  'destinationWarehouseCode',
  'sku',
  'qty',
  'unitCostForeign',
  'lineDiscountForeign',
  'lineDiscountStr',
  'taxRateName',
  'taxRateValue',
  'orderTaxRateName',
  'orderTaxRateValue',
  'pricesIncludeVat',
  'supplierRef',
  'expectedDelivery',
  'orderDiscountForeign',
  'notes',
]
const REQUIRED_HEADERS = ['supplierName', 'sku', 'qty', 'unitCostForeign']

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'purchasing')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(buildTemplateCsv(HEADERS, REQUIRED_HEADERS), 'purchase-orders-template.csv')
  }
  const rows = await db.purchaseOrder.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      supplier: { select: { name: true } },
      destinationWarehouse: { select: { code: true } },
      lines: {
        select: {
          qty: true,
          unitCostForeign: true,
          discountAmount: true,
          discountStr: true,
          taxRate: { select: { name: true, rate: true } },
          product: { select: { sku: true } },
        },
      },
    },
    take: 5000,
  })
  const data: Record<string, unknown>[] = []
  for (const po of rows) {
    for (const l of po.lines) {
      data.push({
        orderKey: po.reference,
        supplierName: po.supplier.name,
        currency: po.currency,
        fxRateToBase: Number(po.fxRateToBase).toFixed(8),
        destinationWarehouseCode: po.destinationWarehouse?.code ?? '',
        sku: l.product.sku,
        qty: Number(l.qty),
        unitCostForeign: Number(l.unitCostForeign).toFixed(6),
        lineDiscountForeign: Number(l.discountAmount ?? 0).toFixed(4),
        lineDiscountStr: l.discountStr ?? '',
        taxRateName: l.taxRate?.name ?? '',
        taxRateValue: l.taxRate ? Number(l.taxRate.rate).toFixed(4) : '',
        orderTaxRateName: po.taxRateName ?? '',
        orderTaxRateValue: po.taxRatePercent != null ? Number(po.taxRatePercent).toFixed(4) : '',
        // Purchase orders do not persist the original entry convention, only
        // the effective net unit cost. Export the round-trip value in net form.
        pricesIncludeVat: 'FALSE',
        supplierRef: po.supplierRef ?? '',
        expectedDelivery: po.expectedDelivery?.toISOString().slice(0, 10),
        orderDiscountForeign: Number(po.discountAmount ?? 0).toFixed(4),
        notes: po.notes ?? '',
      })
    }
  }
  return csvResponse(toCsv(data, HEADERS), `purchase-orders-${new Date().toISOString().slice(0, 10)}.csv`)
}
