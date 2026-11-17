import type { Prisma } from '@/app/generated/prisma/client'
import { buildProductListWhere, type ProductListFilter } from '@/lib/products/list-filter'
import { toRoundTripProduct, type ProductCsvDb } from '@/lib/products/csv-roundtrip/store'
import type { RoundTripProduct } from '@/lib/products/csv-roundtrip/plan'

/**
 * Which products a download covers: the rows the operator ticked, or every row matching the list's current filter. In
 * both cases a variable product brings its variants with it, because a variant is where most of the prices and
 * dimensions live and the list itself hides them behind their parent.
 */
export type ProductCsvSelection =
  | { mode: 'ids'; ids: readonly string[] }
  | { mode: 'filter'; filter: ProductListFilter }

/** The most products one file may carry. The importer's cap is the same number, so a download is always re-uploadable. */
export const PRODUCT_CSV_MAX_ROWS = 50_000

const ID_CHUNK = 1_000
const PAGE = 2_000

const SELECT = {
  id: true, sku: true, name: true, description: true, barcode: true, mpn: true, countryOfOrigin: true,
  weight: true, widthCm: true, heightCm: true, depthCm: true, imageUrl: true,
  salesPriceBase: true, salePriceBase: true, salesPriceTaxInclusive: true, stockUnit: true, oversellAllowed: true,
  preferredSupplierId: true, preferredSupplierLocked: true, categoryId: true, lifecycleStatus: true,
} as const

export class ProductCsvSelectionTooLargeError extends Error {
  constructor() {
    super(`The selection is larger than ${PRODUCT_CSV_MAX_ROWS.toLocaleString('en-GB')} products. Narrow the filter and download it in parts.`)
    this.name = 'ProductCsvSelectionTooLargeError'
  }
}

export async function loadSelectedProducts(
  client: Pick<ProductCsvDb, 'product'>,
  selection: ProductCsvSelection,
): Promise<RoundTripProduct[]> {
  const found = new Map<string, RoundTripProduct>()
  const add = (rows: Array<Record<string, unknown>>) => {
    for (const row of rows) found.set(row.id as string, toRoundTripProduct(row))
    if (found.size > PRODUCT_CSV_MAX_ROWS) throw new ProductCsvSelectionTooLargeError()
  }

  if (selection.mode === 'ids') {
    const ids = [...new Set(selection.ids)]
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      const chunk = ids.slice(start, start + ID_CHUNK)
      add(await client.product.findMany({ where: { OR: [{ id: { in: chunk } }, { parentId: { in: chunk } }] }, select: SELECT }))
    }
  } else {
    const matching: Prisma.ProductWhereInput = buildProductListWhere(selection.filter)
    const where: Prisma.ProductWhereInput = { OR: [matching, { parent: { is: matching } }] }
    let after: string | null = null
    for (;;) {
      const page: Array<Record<string, unknown>> = await client.product.findMany({
        where: after === null ? where : { AND: [where, { sku: { gt: after } }] },
        orderBy: { sku: 'asc' },
        take: PAGE,
        select: SELECT,
      })
      add(page)
      if (page.length < PAGE) break
      after = page[page.length - 1].sku as string
    }
  }
  return [...found.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
}
