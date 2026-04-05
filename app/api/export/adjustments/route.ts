import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'

const HEADERS = ['date', 'sku', 'productName', 'warehouse', 'qty', 'direction', 'note']
const TEMPLATE_HEADERS = ['sku', 'warehouseCode', 'qty', 'note']

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
    return csvResponse(TEMPLATE_HEADERS.join(',') + '\r\n', 'adjustments-import-template.csv')
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
      date: m.createdAt.toISOString(),
      sku: m.product.sku,
      productName: m.product.name,
      warehouse: warehouse ? `${warehouse.code} — ${warehouse.name}` : '',
      qty: m.qty.toString(),
      direction: isAddition ? 'ADD' : 'REMOVE',
      note: m.note ?? '',
    }
  })

  const filename = `adjustments-${new Date().toISOString().slice(0, 10)}.csv`
  return csvResponse(toCsv(rows, HEADERS), filename)
}
