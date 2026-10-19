/**
 * ATTRIBUTION: for every table the runner writes, how many of its rows can NOT be traced to the prepared file.
 *
 * The step observation reads only what the file names (a category attached to a file product, a price-cache pair used by a stored line). A row the observation never reads is invisible to it,
 * so a foreign category or price-cache row added between two attempts would pass. This module closes that class for the registry: there is exactly one rule per RUNNER_WRITES table
 * (`ATTRIBUTION_RULES`; a test fails if a table is added to that class without one), and each rule counts the table's rows that the file does not account for. A resume is refused on any.
 *
 * Attribution is derived from the selected steps' files only. A step that is not selected contributes nothing, so its tables must hold nothing unattributed. Counts only, never keys.
 * The audit trail and the run record are the runner's own by definition: every row of them is attributed.
 */
import { db } from '@/lib/db'
import { normalizeProductCategoryName } from '@/lib/products/category-name'
import { normaliseCategory } from '../normal-form'
import type { PreparedRun } from '../prepared'
import type { ApplyStepId } from '../constants'

type Rule = (prepared: PreparedRun) => Promise<number>

function fileRows(prepared: PreparedRun, step: ApplyStepId): Array<(name: string) => string> {
  const data = prepared.steps.find((s) => s.step === step)?.data
  if (!data) return []
  const col = new Map(data.header.map((name, i) => [name, i]))
  return data.rows.map((row) => (name: string) => (col.has(name) ? row.cells[col.get(name)!] ?? '' : ''))
}

interface FileFacts {
  suppliers: Set<string>
  products: Set<string>
  categories: Set<string>
  recipes: Set<string>
  bomProducts: Set<string>
  stockPairs: Set<string>
  orders: Set<string>
  orderLines: Set<string>
  priceCache: Set<string>
}

function factsOf(prepared: PreparedRun): FileFacts {
  const f: FileFacts = { suppliers: new Set(), products: new Set(), categories: new Set(), recipes: new Set(), bomProducts: new Set(), stockPairs: new Set(), orders: new Set(), orderLines: new Set(), priceCache: new Set() }
  for (const get of fileRows(prepared, 'suppliers')) f.suppliers.add(get('name').trim().toLowerCase())
  for (const get of fileRows(prepared, 'products')) {
    const sku = get('sku')
    f.products.add(sku)
    const path = normaliseCategory(get('category'))
    if (path !== '') {
      const parts = path.split('>')
      for (let i = 1; i <= parts.length; i++) f.categories.add(parts.slice(0, i).join('>'))
    }
    const type = get('type')
    for (const piece of get('components').trim() === '' ? [] : get('components').split(';')) {
      const colon = piece.lastIndexOf(':')
      f.recipes.add(`${sku}|${piece.slice(0, colon).trim()}`)
    }
    if (type === 'BOM') f.bomProducts.add(sku)
  }
  for (const get of fileRows(prepared, 'opening-stock')) f.stockPairs.add(`${get('sku').trim().toUpperCase()}|${get('warehouseCode').trim().toUpperCase()}`)
  for (const get of fileRows(prepared, 'purchase-orders')) {
    const key = get('orderKey')
    const sku = get('sku').trim().toUpperCase()
    f.orders.add(key)
    f.orderLines.add(`${key}|${sku}`)
    f.priceCache.add(`${get('supplierName').trim().toUpperCase()}|${sku}`)
  }
  return f
}

const unattributed = <T>(rows: T[], attributed: (row: T) => boolean): number => rows.filter((row) => !attributed(row)).length

export const ATTRIBUTION_RULES: Readonly<Record<string, Rule>> = {
  activity_logs: async () => 0,
  first_load_apply_runs: async () => 0,
  suppliers: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.supplier.findMany({ select: { name: true } }), (r) => f.suppliers.has(r.name.trim().toLowerCase()))
  },
  products: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.product.findMany({ select: { sku: true } }), (r) => f.products.has(r.sku))
  },
  product_categories: async (p) => {
    // The importer's upsert keeps a category that already exists under the normalised path (update: {}), whatever its display name and parent, so a row is the run's only if its
    // path is one the file names AND it hangs under the parent that path implies AND its display name is the path's last segment.
    const f = factsOf(p)
    const rows = await db.productCategory.findMany({ select: { id: true, name: true, nameNormalized: true, parentId: true } })
    const pathOf = new Map(rows.map((r) => [r.id, r.nameNormalized]))
    return unattributed(rows, (r) => {
      if (!f.categories.has(r.nameNormalized)) return false
      const parts = r.nameNormalized.split('>')
      const parent = parts.length > 1 ? parts.slice(0, -1).join('>') : null
      const hangsUnder = r.parentId === null ? parent === null : pathOf.get(r.parentId) === parent
      return hangsUnder && normalizeProductCategoryName(r.name) === parts[parts.length - 1]
    })
  },
  product_components: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.productComponent.findMany({ select: { product: { select: { sku: true } }, component: { select: { sku: true } } } }), (r) => f.recipes.has(`${r.product.sku}|${r.component.sku}`))
  },
  boms: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.bom.findMany({ select: { product: { select: { sku: true } } } }), (r) => r.product !== null && f.bomProducts.has(r.product.sku))
  },
  bom_items: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.bomItem.findMany({ select: { parentProduct: { select: { sku: true } }, component: { select: { sku: true } } } }), (r) => f.recipes.has(`${r.parentProduct.sku}|${r.component.sku}`))
  },
  stock_levels: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.stockLevel.findMany({ select: { product: { select: { sku: true } }, warehouse: { select: { code: true } } } }), (r) => f.stockPairs.has(`${r.product.sku.toUpperCase()}|${r.warehouse.code.toUpperCase()}`))
  },
  stock_movements: async (p) => {
    const f = factsOf(p)
    const [rows, products, warehouses] = await Promise.all([
      db.stockMovement.findMany({ select: { productId: true, fromWarehouseId: true, toWarehouseId: true } }),
      db.product.findMany({ select: { id: true, sku: true } }), db.warehouse.findMany({ select: { id: true, code: true } }),
    ])
    const sku = new Map(products.map((x) => [x.id, x.sku.toUpperCase()])), code = new Map(warehouses.map((x) => [x.id, x.code.toUpperCase()]))
    // An opening movement has a destination and no source; anything else (a transfer, an issue, a movement that names no warehouse) is not the runner's.
    return unattributed(rows, (r) => r.fromWarehouseId === null && r.toWarehouseId !== null && f.stockPairs.has(`${sku.get(r.productId)}|${code.get(r.toWarehouseId)}`))
  },
  cost_layers: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.costLayer.findMany({ select: { product: { select: { sku: true } }, warehouse: { select: { code: true } } } }), (r) => f.stockPairs.has(`${r.product.sku.toUpperCase()}|${r.warehouse.code.toUpperCase()}`))
  },
  purchase_orders: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.purchaseOrder.findMany({ select: { reference: true } }), (r) => f.orders.has(r.reference))
  },
  purchase_order_lines: async (p) => {
    const f = factsOf(p)
    return unattributed(await db.purchaseOrderLine.findMany({ select: { po: { select: { reference: true } }, product: { select: { sku: true } } } }), (r) => f.orderLines.has(`${r.po.reference}|${r.product.sku.toUpperCase()}`))
  },
  supplier_products: async (p) => {
    // A cache row belongs to the run only if a stored order of the file used the pair: the importer's upsert MERGES into a row that already exists (keeping its supplier SKU and lead time),
    // so a pair present before the purchase-order step wrote its line is somebody else's.
    const f = factsOf(p)
    const [rows, lines] = await Promise.all([
      db.supplierProduct.findMany({ select: { supplierId: true, productId: true, supplier: { select: { name: true } }, product: { select: { sku: true } } } }),
      db.purchaseOrderLine.findMany({ select: { productId: true, po: { select: { supplierId: true, reference: true } } } }),
    ])
    const used = new Set(lines.filter((l) => f.orders.has(l.po.reference)).map((l) => `${l.po.supplierId}:${l.productId}`))
    return unattributed(rows, (r) => used.has(`${r.supplierId}:${r.productId}`) && f.priceCache.has(`${r.supplier.name.trim().toUpperCase()}|${r.product.sku.toUpperCase()}`))
  },
}
