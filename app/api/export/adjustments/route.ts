import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const HEADERS = ['sku', 'warehouseCode', 'qty', 'note']
const TEMPLATE_HEADERS = ['sku', 'warehouseCode', 'qty', 'note']
const REQUIRED_HEADERS = ['sku', 'warehouseCode', 'qty']

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })
  if (!hasPermission(session.user.role, 'stock_control')) return new Response('Forbidden', { status: 403 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
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
      note: m.note ?? '',
    }
  })

  const filename = `adjustments-${new Date().toISOString().slice(0, 10)}.csv`
  return csvResponse(toCsv(rows, HEADERS), filename)
}
