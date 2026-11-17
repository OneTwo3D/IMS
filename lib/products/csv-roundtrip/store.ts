import { Prisma } from '@/app/generated/prisma/client'
import type { db as appDb } from '@/lib/db'
import { buildProductCategoryPathMap } from '@/lib/products/categories'
import { deriveLegacyActiveFromLifecycleStatus } from '@/lib/products/lifecycle'
import type { ProductCsvColumn } from '@/lib/products/csv-roundtrip/columns'
import type { FieldChange, PlanLookups, RoundTripProduct } from '@/lib/products/csv-roundtrip/plan'

/**
 * Everything the round trip reads from or writes to the database, behind one seam, so the orchestrator is testable
 * against a counting fake and the real implementation is the only place SQL is written.
 *
 * READS ARE BULK. A chunk of rows costs one product query by SKU (and one barcode query when a barcode column is in
 * play), never one per row. The supplier and category tables are read once per file.
 *
 * WRITES ARE BATCHED AND VERSIONED. {@link ProductCsvStore.writeBatch} applies a whole batch of products in ONE transaction and ONE
 * UPDATE ... FROM (VALUES ...) statement, so 20,000 edited variants are about eighty statements, not twenty thousand.
 * Only the columns the file carries are named in the statement, and each product only changes the fields its own row
 * changed (a per-field flag decides between the new value and the stored one), so a field the row did not change and a
 * column the file did not carry are never written. `updatedAt` moves, as it does for the editor.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: sku, type, parent, components, the BOM recipe, stock and cost layers. Those
 * are the fields the editor's per-SKU and component-graph locks protect, and none of them is an editable column here.
 */

export type PlannedUpdate = {
  id: string
  sku: string
  /** The product's `updatedAt` as the plan read it. The statement only writes a row still carrying it. */
  expectedUpdatedAt: Date
  changes: FieldChange[]
}

export type ProductCsvLookupTables = Pick<PlanLookups, 'supplierIdByName' | 'supplierNameById' | 'categoryIdByPath' | 'categoryPathById'>

export interface ProductCsvStore {
  loadLookupTables(): Promise<ProductCsvLookupTables>
  findProductsBySku(skus: readonly string[]): Promise<RoundTripProduct[]>
  /** barcode -> id of the product that holds it. */
  findBarcodeOwners(barcodes: readonly string[]): Promise<Map<string, string>>
  /** One transaction. Throws if the batch could not be written, in which case none of it was. */
  writeBatch(updates: readonly PlannedUpdate[], columns: readonly ProductCsvColumn[]): Promise<{ written: number; staleIds: string[] }>
}

export type ProductCsvDb = Pick<typeof appDb, 'product' | 'supplier' | 'productCategory' | '$transaction'>

const PRODUCT_SELECT = {
  id: true, sku: true, name: true, description: true, barcode: true, mpn: true, countryOfOrigin: true,
  weight: true, widthCm: true, heightCm: true, depthCm: true, imageUrl: true,
  salesPriceBase: true, salePriceBase: true, salesPriceTaxInclusive: true, stockUnit: true, oversellAllowed: true,
  preferredSupplierId: true, preferredSupplierLocked: true, categoryId: true, lifecycleStatus: true, updatedAt: true,
} as const

export function toRoundTripProduct(row: Record<string, unknown>): RoundTripProduct {
  const dec = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
  return {
    id: row.id as string,
    sku: row.sku as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    barcode: (row.barcode as string | null) ?? null,
    mpn: (row.mpn as string | null) ?? null,
    countryOfOrigin: (row.countryOfOrigin as string | null) ?? null,
    weight: dec(row.weight),
    widthCm: dec(row.widthCm),
    heightCm: dec(row.heightCm),
    depthCm: dec(row.depthCm),
    imageUrl: (row.imageUrl as string | null) ?? null,
    salesPriceBase: dec(row.salesPriceBase),
    salePriceBase: dec(row.salePriceBase),
    salesPriceTaxInclusive: row.salesPriceTaxInclusive as boolean,
    stockUnit: row.stockUnit as string,
    oversellAllowed: row.oversellAllowed as boolean,
    preferredSupplierId: (row.preferredSupplierId as string | null) ?? null,
    preferredSupplierLocked: row.preferredSupplierLocked as boolean,
    categoryId: (row.categoryId as string | null) ?? null,
    lifecycleStatus: row.lifecycleStatus as RoundTripProduct['lifecycleStatus'],
    updatedAt: row.updatedAt as Date,
  }
}

const SQL_CAST: Record<string, string> = {
  text: 'text',
  decimal: 'numeric',
  boolean: 'boolean',
  country: 'text',
  supplier: 'text',
  category: 'text',
  lifecycle: '"ProductLifecycleStatus"',
}

/** Postgres allows 32,767 bind parameters per statement (the engine's limit); stay well inside it. */
const MAX_BIND_PARAMETERS = 24_000

/** How many products fit in one statement for this column set. */
export function writeBatchSizeFor(columns: readonly ProductCsvColumn[], ceiling: number): number {
  const perRow = 2 + columns.length * 2 + 1
  return Math.max(1, Math.min(ceiling, Math.floor(MAX_BIND_PARAMETERS / perRow)))
}

/** The statement for one batch. Exported so a test can read the SQL it produces. */
export function buildBatchUpdateSql(updates: readonly PlannedUpdate[], columns: readonly ProductCsvColumn[]): Prisma.Sql {
  const hasLifecycle = columns.some((column) => column.kind === 'lifecycle')
  const hasSupplier = columns.some((column) => column.kind === 'supplier')
  // Column and alias names come from the registry (constants), never from the file.
  const ident = (name: string) => Prisma.raw(`"${name.replace(/"/g, '""')}"`)

  const assignments: Prisma.Sql[] = columns.map((column, index) =>
    Prisma.sql`${ident(column.field)} = CASE WHEN v.${ident(`f${index}`)} THEN v.${ident(`v${index}`)} ELSE p.${ident(column.field)} END`,
  )
  if (hasLifecycle) {
    const index = columns.findIndex((column) => column.kind === 'lifecycle')
    assignments.push(Prisma.sql`"active" = CASE WHEN v.${ident(`f${index}`)} THEN v."active_next" ELSE p."active" END`)
  }
  if (hasSupplier) {
    const index = columns.findIndex((column) => column.kind === 'supplier')
    assignments.push(Prisma.sql`"preferredSupplierUpdatedAt" = CASE WHEN v.${ident(`f${index}`)} THEN now() ELSE p."preferredSupplierUpdatedAt" END`)
  }
  assignments.push(Prisma.sql`"updatedAt" = now()`)

  const tuples = updates.map((update) => {
    const byColumn = new Map(update.changes.map((change) => [change.column, change]))
    const cells: Prisma.Sql[] = [Prisma.sql`${update.id}::text`, Prisma.sql`${update.expectedUpdatedAt}::timestamp`]
    for (const column of columns) {
      const change = byColumn.get(column.key)
      const cast = Prisma.raw(SQL_CAST[column.kind])
      cells.push(Prisma.sql`${change !== undefined}::boolean`)
      cells.push(Prisma.sql`${change === undefined ? null : change.value}::${cast}`)
    }
    if (hasLifecycle) {
      const change = byColumn.get('lifecycleStatus')
      const next = change && typeof change.value === 'string'
        ? deriveLegacyActiveFromLifecycleStatus(change.value as RoundTripProduct['lifecycleStatus'])
        : null
      cells.push(Prisma.sql`${next}::boolean`)
    }
    return Prisma.sql`(${Prisma.join(cells)})`
  })

  const aliases = ['id', 'expected_updated_at', ...columns.flatMap((_, index) => [`f${index}`, `v${index}`]), ...(hasLifecycle ? ['active_next'] : [])]
  return Prisma.sql`
    UPDATE "products" AS p
    SET ${Prisma.join(assignments)}
    FROM (VALUES ${Prisma.join(tuples)}) AS v(${Prisma.join(aliases.map((alias) => ident(alias)))})
    WHERE p."id" = v."id" AND p."updatedAt" = v."expected_updated_at"
    RETURNING p."id" AS "id"
  `
}

export function createProductCsvStore(client: ProductCsvDb): ProductCsvStore {
  return {
    async loadLookupTables() {
      const [suppliers, categories] = await Promise.all([
        client.supplier.findMany({ select: { id: true, name: true } }),
        client.productCategory.findMany({ select: { id: true, name: true, nameNormalized: true, parentId: true } }),
      ])
      const pathById = buildProductCategoryPathMap(categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })))
      return {
        supplierIdByName: new Map(suppliers.map((s) => [s.name.trim().toLocaleLowerCase('en-US'), s.id])),
        supplierNameById: new Map(suppliers.map((s) => [s.id, s.name])),
        categoryIdByPath: new Map(categories.map((c) => [c.nameNormalized, c.id])),
        categoryPathById: new Map(categories.map((c) => [c.id, pathById.get(c.id) ?? c.name])),
      }
    },

    async findProductsBySku(skus) {
      if (skus.length === 0) return []
      const rows = await client.product.findMany({ where: { sku: { in: [...skus] } }, select: PRODUCT_SELECT })
      return rows.map((row) => toRoundTripProduct(row))
    },

    async findBarcodeOwners(barcodes) {
      if (barcodes.length === 0) return new Map()
      const rows = await client.product.findMany({ where: { barcode: { in: [...barcodes] } }, select: { id: true, barcode: true } })
      return new Map(rows.map((row) => [row.barcode as string, row.id]))
    },

    async writeBatch(updates, columns) {
      if (updates.length === 0) return { written: 0, staleIds: [] }
      const sql = buildBatchUpdateSql(updates, columns)
      const returned = await client.$transaction(async (tx) => tx.$queryRaw<Array<{ id: string }>>(sql), { timeout: 60_000, maxWait: 10_000 })
      const written = new Set(returned.map((row) => row.id))
      // A row the statement did not return was edited by someone else since the plan read it (or deleted): not written.
      return { written: written.size, staleIds: updates.filter((update) => !written.has(update.id)).map((update) => update.id) }
    },
  }
}
