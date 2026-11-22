import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { readStockAdjustmentReasonCostRequired } from '@/lib/domain/inventory/stock-adjustment-policy'

// unitCost (base currency) is optional but REQUIRED for a positive adjustment of a
// product with no existing cost basis (cogs-audit scjz.2); blank uses the derived
// average. Kept after qty so existing 4-column files still import.
const HEADERS = ['sku', 'warehouseCode', 'qty', 'unitCost', 'note']
const TEMPLATE_HEADERS = ['sku', 'warehouseCode', 'qty', 'unitCost', 'note']
const REQUIRED_HEADERS = ['sku', 'warehouseCode', 'qty']

export async function GET(req: Request) {
  const session = await requireApiAuth()
  if (session instanceof Response) return session
  if (!hasPermission(session.user.role, 'stock_control')) return new Response('Forbidden', { status: 403 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
    // o3d-0ypv9: with `stock_adjustment_reason_cost_required` on, the import needs a reason on every row, so the template
    // carries a required `reason` column (an adjustment reason's name). Off: the template is unchanged.
    if (await readStockAdjustmentReasonCostRequired(db)) {
      return csvResponse(
        buildTemplateCsv([...TEMPLATE_HEADERS, 'reason'], [...REQUIRED_HEADERS, 'reason']),
        'adjustments-import-template.csv',
      )
    }
    return csvResponse(buildTemplateCsv(TEMPLATE_HEADERS, REQUIRED_HEADERS), 'adjustments-import-template.csv')
  }

  const movements = await db.stockMovement.findMany({
    where: { type: 'ADJUSTMENT' },
    include: {
      product: { select: { sku: true, name: true } },
      toWarehouse: { select: { code: true, name: true } },
      fromWarehouse: { select: { code: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10000,
  })

  const rows = movements.map((m) => {
    const isAddition = !!m.toWarehouseId
    const warehouse = isAddition
      ? m.toWarehouse
      : m.fromWarehouse
    return {
      sku: m.product.sku,
      warehouseCode: warehouse?.code ?? '',
      qty: String(isAddition ? Number(m.qty) : -Number(m.qty)),
      unitCost: isAddition && m.unitCostBase != null ? String(Number(m.unitCostBase)) : '',
      note: m.note ?? '',
    }
  })

  const filename = `adjustments-${new Date().toISOString().slice(0, 10)}.csv`
  return csvResponse(toCsv(rows, HEADERS), filename)
}
