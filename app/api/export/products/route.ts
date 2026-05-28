import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

const HEADERS = [
  'productId', 'parentProductId',
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components',
  'totalStock', 'inventoryValue', 'category',
]

const TEMPLATE_HEADERS = [
  'productId', 'parentProductId',
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components', 'category',
]
const REQUIRED_HEADERS = ['sku', 'name']

export async function GET(req: Request) {
  const session = await requireApiAuth()
  if (session instanceof Response) return session
  if (!hasPermission(session.user.role, 'inventory')) return new Response('Forbidden', { status: 403 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
    // Add example rows for each type
    return csvResponse(buildTemplateCsv(TEMPLATE_HEADERS, REQUIRED_HEADERS, [
      { sku: 'WIDGET-001', name: 'Widget', category: 'Components', description: 'A simple widget', type: 'SIMPLE', barcode: '1234567890123', weight: '0.5', widthCm: '10', heightCm: '5', depthCm: '3', salesPriceBase: '9.99', salePriceBase: '7.99', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT', name: 'T-Shirt Parent', category: 'Apparel', description: 'Variable product with sizes', type: 'VARIABLE', barcode: '', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT-S', name: 'T-Shirt Small', category: 'Apparel', description: 'Size S variant', type: 'VARIANT', parentSku: 'TSHIRT', barcode: '', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT-M', name: 'T-Shirt Medium', category: 'Apparel', description: 'Size M variant', type: 'VARIANT', parentSku: 'TSHIRT', barcode: '', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'BUNDLE-01', name: 'Starter Kit', category: 'Bundles', description: 'A kit/bundle product', type: 'KIT', parentSku: '', barcode: '', weight: '', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '29.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: 'WIDGET-001:2;TSHIRT-S:1' },
      { sku: 'BOM-01', name: 'Assembled Widget', category: 'Manufactured', description: 'A manufactured product', type: 'BOM', parentSku: '', barcode: '', weight: '', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '15.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: 'WIDGET-001:3' },
    ]), 'products-import-template.csv')
  }

  const products = await db.product.findMany({
    include: {
      category: { select: { name: true } },
      parent: { select: { sku: true } },
      stockLevels: { select: { quantity: true } },
      costLayers: {
        where: { remainingQty: { gt: 0 } },
        select: { remainingQty: true, unitCostBase: true },
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
      productId: p.id,
      parentProductId: p.parentId ?? '',
      sku: p.sku,
      name: p.name,
      category: p.category?.name ?? '',
      description: p.description ?? '',
      type: p.type,
      parentSku: p.parent?.sku ?? '',
      barcode: p.barcode ?? '',
      weight: p.weight?.toString() ?? '',
      widthCm: p.widthCm?.toString() ?? '',
      heightCm: p.heightCm?.toString() ?? '',
      depthCm: p.depthCm?.toString() ?? '',
      salesPriceBase: p.salesPriceBase?.toString() ?? '',
      salePriceBase: p.salePriceBase?.toString() ?? '',
      salesPriceTaxInclusive: p.salesPriceTaxInclusive ? 'TRUE' : 'FALSE',
      stockUnit: p.stockUnit,
      oversellAllowed: p.oversellAllowed ? 'TRUE' : 'FALSE',
      imageUrl: p.imageUrl ?? '',
      active: p.active ? 'TRUE' : 'FALSE',
      lifecycleStatus: p.lifecycleStatus,
      components: componentsStr,
      totalStock: p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0).toFixed(2),
      inventoryValue: p.costLayers
        .reduce((s, c) => s + Number(c.remainingQty) * Number(c.unitCostBase), 0)
        .toFixed(2),
    }
  })

  const filename = `products-${new Date().toISOString().slice(0, 10)}.csv`
  return csvResponse(toCsv(rows, HEADERS), filename)
}
