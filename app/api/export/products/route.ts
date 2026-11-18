import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission, type Permission } from '@/lib/permissions'
import { toIsoCountryCode } from '@/lib/countries'
import { gateLegacyExportPrices } from '@/lib/products/legacy-export-price-gate'
import { loadActiveDefinitions } from '@/lib/custom-fields/values-service'
import { customFieldCsvHeader, formatCustomFieldValue } from '@/lib/custom-fields/values'

const HEADERS = [
  'productId', 'parentProductId',
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode', 'mpn', 'countryOfOrigin',
  'preferredSupplierId', 'preferredSupplierName', 'preferredSupplierLocked',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components',
  'totalStock', 'inventoryValue', 'category',
]

const TEMPLATE_HEADERS = [
  'productId', 'parentProductId',
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode', 'mpn', 'countryOfOrigin',
  'preferredSupplierId', 'preferredSupplierName', 'preferredSupplierLocked',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components', 'category',
]
const REQUIRED_HEADERS = ['sku', 'name']

const EXPORT_BATCH_SIZE = 500

const PRODUCT_INCLUDE = {
  category: { select: { name: true } },
  parent: { select: { sku: true } },
  preferredSupplier: { select: { id: true, name: true } },
  stockLevels: { select: { quantity: true } },
  costLayers: {
    where: { remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCostBase: true },
  },
  productComponents: {
    select: { qty: true, component: { select: { sku: true } } },
    orderBy: { sortOrder: 'asc' },
  },
} as const

type ProductBatch = Array<Awaited<ReturnType<typeof db.product.findMany<{ include: typeof PRODUCT_INCLUDE }>>>[number]>

export async function GET(req: Request) {
  const session = await requireApiAuth()
  if (session instanceof Response) return session
  if (!hasPermission(session.user.role, 'inventory')) return new Response('Forbidden', { status: 403 })

  const url = new URL(req.url)
  const templateOnly = url.searchParams.get('template') === '1'

  if (templateOnly) {
    // Add example rows for each type
    return csvResponse(buildTemplateCsv(TEMPLATE_HEADERS, REQUIRED_HEADERS, [
      { sku: 'WIDGET-001', name: 'Widget', category: 'Components', description: 'A simple widget', type: 'SIMPLE', barcode: '1234567890123', mpn: 'MPN-WIDGET-001', countryOfOrigin: 'CN', preferredSupplierId: '', preferredSupplierName: '', preferredSupplierLocked: 'FALSE', weight: '0.5', widthCm: '10', heightCm: '5', depthCm: '3', salesPriceBase: '9.99', salePriceBase: '7.99', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT', name: 'T-Shirt Parent', category: 'Apparel', description: 'Variable product with sizes', type: 'VARIABLE', barcode: '', mpn: '', countryOfOrigin: 'GB', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT-S', name: 'T-Shirt Small', category: 'Apparel', description: 'Size S variant', type: 'VARIANT', parentSku: 'TSHIRT', barcode: '', mpn: 'MPN-TSHIRT-S', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'TSHIRT-M', name: 'T-Shirt Medium', category: 'Apparel', description: 'Size M variant', type: 'VARIANT', parentSku: 'TSHIRT', barcode: '', mpn: 'MPN-TSHIRT-M', weight: '0.2', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '19.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: '' },
      { sku: 'BUNDLE-01', name: 'Starter Kit', category: 'Bundles', description: 'A kit/bundle product', type: 'KIT', parentSku: '', barcode: '', mpn: '', weight: '', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '29.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: 'WIDGET-001:2;TSHIRT-S:1' },
      { sku: 'BOM-01', name: 'Assembled Widget', category: 'Manufactured', description: 'A manufactured product', type: 'BOM', parentSku: '', barcode: '', mpn: 'MPN-BOM-01', weight: '', widthCm: '', heightCm: '', depthCm: '', salesPriceBase: '15.99', salePriceBase: '', salesPriceTaxInclusive: 'TRUE', stockUnit: 'pcs', oversellAllowed: 'TRUE', imageUrl: '', active: 'TRUE', lifecycleStatus: 'ACTIVE', components: 'WIDGET-001:3' },
    ]), 'products-import-template.csv')
  }

  // Active product custom fields, one `cf:<key>` column each, APPENDED LAST so every existing column keeps its place. Hidden fields are not exported.
  const customFields = await loadActiveDefinitions(db, 'PRODUCT')
  const typeById = new Map(customFields.map((f) => [f.id, f.type]))
  const headers = [...HEADERS, ...customFields.map((f) => customFieldCsvHeader(f.key))]

  /**
   * ONE BATCH of products plus the custom values of THOSE products only, so memory is bounded by the batch (not the catalogue) and the
   * query count is two per batch (products, values) however many fields exist.
   *
   * PAGED ON THE IMMUTABLE ID, never on the sku: a sku can be renamed between batches, which would make a sku cursor skip or repeat a
   * product. A product that exists for the whole export is therefore sent exactly once. This is a MOVING READ, not a snapshot: a product
   * created or deleted while the export runs may or may not appear, and a row shows the values as of its own batch. Within a batch the rows
   * are sorted by sku, so the file is sku-ordered inside each batch of 500 (not across batches).
   */
  const loadBatch = async (afterId: string | null) => {
    const batch = (await db.product.findMany({
      where: afterId === null ? {} : { id: { gt: afterId } },
      include: PRODUCT_INCLUDE,
      orderBy: { id: 'asc' },
      take: EXPORT_BATCH_SIZE,
    }))
    const lastId = batch.length > 0 ? batch[batch.length - 1]!.id : null
    batch.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
    const values = new Map<string, Map<string, string>>()
    if (customFields.length > 0 && batch.length > 0) {
      const stored = await db.customFieldValue.findMany({
        where: { definitionId: { in: customFields.map((f) => f.id) }, productId: { in: batch.map((p) => p.id) } },
        select: { definitionId: true, productId: true, valueText: true, valueDecimal: true, valueBoolean: true, valueDate: true, valueDateTime: true, valueJson: true },
      })
      for (const row of stored) {
        const text = formatCustomFieldValue(typeById.get(row.definitionId)!, row)
        if (text == null || !row.productId) continue
        const forProduct = values.get(row.productId) ?? new Map<string, string>()
        forProduct.set(row.definitionId, text)
        values.set(row.productId, forProduct)
      }
    }
    return { batch, values, lastId }
  }

  const buildRows = (products: ProductBatch, customValues: Map<string, Map<string, string>>) => products.map((p) => {
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
      mpn: p.mpn ?? '',
      // bhdm.7: normalise on export so a legacy reserved/noncanonical stored value (EU/ZZ/'ad') never leaves as
      // an unrecognised code — export→import stays lossless (only re-importable values are emitted).
      countryOfOrigin: toIsoCountryCode(p.countryOfOrigin) ?? '',
      preferredSupplierId: p.preferredSupplier?.id ?? '',
      preferredSupplierName: p.preferredSupplier?.name ?? '',
      preferredSupplierLocked: p.preferredSupplierLocked ? 'TRUE' : 'FALSE',
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
      ...Object.fromEntries(customFields.map((f) => [customFieldCsvHeader(f.key), customValues.get(p.id)?.get(f.id) ?? ''])),
    }
  })

  // Price columns stay in the header but are blank in every batch without inventory.prices (same gate as Edit-by-CSV).
  const canSeePrices = (permission: Permission) => hasPermission(session.user.role, permission)
  const filename = `products-${new Date().toISOString().slice(0, 10)}.csv`
  const headerLine = toCsv([], headers)
  const encoder = new TextEncoder()
  let cursor: string | null = null
  let started = false
  let done = false
  // Streamed: each pull reads one batch and emits its rows, so nothing holds the whole catalogue or every custom value at once.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true
        controller.enqueue(encoder.encode(headerLine))
        return
      }
      if (done) { controller.close(); return }
      const { batch, values, lastId } = await loadBatch(cursor)
      if (batch.length === 0) { done = true; controller.close(); return }
      cursor = lastId
      if (batch.length < EXPORT_BATCH_SIZE) done = true
      const body = toCsv(gateLegacyExportPrices(buildRows(batch, values), canSeePrices), headers).slice(headerLine.length)
      controller.enqueue(encoder.encode(body))
    },
  })
  return new Response(stream, { headers: csvResponse('', filename).headers })
}
