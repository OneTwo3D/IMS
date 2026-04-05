import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'

const HEADERS = [
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceGbp', 'salePriceGbp', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active',
  'components',
  'totalStock', 'inventoryValue',
]

const TEMPLATE_HEADERS = [
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceGbp', 'salePriceGbp', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active',
  'components',
]

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
    // Add example rows for each type
    const lines = [
      TEMPLATE_HEADERS.join(','),
      '"WIDGET-001","Widget","A simple widget","SIMPLE","","1234567890123","0.5","10","5","3","9.99","7.99","TRUE","pcs","TRUE","",""',
      '"TSHIRT","T-Shirt Parent","Variable product with sizes","VARIABLE","","","0.2","","","","19.99","","TRUE","pcs","TRUE","",""',
      '"TSHIRT-S","T-Shirt Small","Size S variant","VARIANT","TSHIRT","","0.2","","","","19.99","","TRUE","pcs","TRUE","",""',
      '"TSHIRT-M","T-Shirt Medium","Size M variant","VARIANT","TSHIRT","","0.2","","","","19.99","","TRUE","pcs","TRUE","",""',
      '"BUNDLE-01","Starter Kit","A kit/bundle product","KIT","","","","","","","29.99","","TRUE","pcs","TRUE","","WIDGET-001:2;TSHIRT-S:1"',
      '"BOM-01","Assembled Widget","A manufactured product","BOM","","","","","","","15.99","","TRUE","pcs","TRUE","","WIDGET-001:3"',
    ]
    return csvResponse(lines.join('\r\n'), 'products-import-template.csv')
  }

  const products = await db.product.findMany({
    include: {
      parent: { select: { sku: true } },
      stockLevels: { select: { quantity: true } },
      costLayers: {
        where: { remainingQty: { gt: 0 } },
        select: { remainingQty: true, unitCostGbp: true },
      },
      productComponents: {
        select: { qty: true, component: { select: { sku: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { sku: 'asc' },
  })

  const rows = products.map((p) => {
    // Format components as "SKU1:qty;SKU2:qty"
    const componentsStr = p.productComponents
      .map((c) => `${c.component.sku}:${Number(c.qty)}`)
      .join(';')

    return {
      sku: p.sku,
      name: p.name,
      description: p.description ?? '',
      type: p.type,
      parentSku: p.parent?.sku ?? '',
      barcode: p.barcode ?? '',
      weight: p.weight?.toString() ?? '',
      widthCm: p.widthCm?.toString() ?? '',
      heightCm: p.heightCm?.toString() ?? '',
      depthCm: p.depthCm?.toString() ?? '',
      salesPriceGbp: p.salesPriceGbp?.toString() ?? '',
      salePriceGbp: p.salePriceGbp?.toString() ?? '',
      salesPriceTaxInclusive: p.salesPriceTaxInclusive ? 'TRUE' : 'FALSE',
      stockUnit: p.stockUnit,
      oversellAllowed: p.oversellAllowed ? 'TRUE' : 'FALSE',
      imageUrl: p.imageUrl ?? '',
      active: p.active ? 'TRUE' : 'FALSE',
      components: componentsStr,
      totalStock: p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0).toFixed(2),
      inventoryValue: p.costLayers
        .reduce((s, c) => s + Number(c.remainingQty) * Number(c.unitCostGbp), 0)
        .toFixed(2),
    }
  })

  const filename = `products-${new Date().toISOString().slice(0, 10)}.csv`
  return csvResponse(toCsv(rows, HEADERS), filename)
}
