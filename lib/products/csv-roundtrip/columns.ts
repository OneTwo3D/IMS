import type { Permission } from '@/lib/permissions'

/**
 * THE COLUMN REGISTRY of the "Edit by CSV" round trip (select products, download a pre-filled CSV, edit it, upload it).
 *
 * Every column here is one the existing product CSV import already knows how to UPDATE (app/actions/import.ts,
 * importProductsCsv), under the same header name, so a file edited here is still a valid file for the ordinary importer.
 * Columns the importer can only CREATE with (type, parentSku, components, ...) and the ones it does not read at all
 * (hsCode, customsDescription) are deliberately not offered. SKU is the key: always present, never edited here.
 */

/** The token that clears a field. A blank cell never does: blank means "leave unchanged". */
export const CSV_CLEAR_TOKEN = '__CLEAR__'

export const PRODUCT_CSV_KEY_COLUMN = 'sku'

/** The download's version column: what each exported value was, as short hashes. Not an editable column. */
export const PRODUCT_CSV_REV_COLUMN = 'rev'

export type ProductCsvColumnKind = 'text' | 'decimal' | 'boolean' | 'country' | 'lifecycle' | 'supplier' | 'category'

export type ProductCsvColumnGroup = 'Basics' | 'Identifiers' | 'Logistics' | 'Prices' | 'Supplier' | 'Status'

export type ProductCsvColumn = {
  /** The CSV header, identical to the existing import's header for the same field. */
  key: string
  label: string
  group: ProductCsvColumnGroup
  kind: ProductCsvColumnKind
  /** True when the product field is nullable, which is the only case the clear token is accepted for. */
  nullable: boolean
  /** The permission needed to download or change the column, on top of inventory.edit. */
  requires: Permission | null
  /** The database column this writes. */
  field: string
  maxLength?: number
  /** Decimal columns: total digits and digits after the point, as the database holds them. */
  decimal?: { precision: number; scale: number }
}

export const PRODUCT_CSV_COLUMNS: readonly ProductCsvColumn[] = [
  { key: 'name', label: 'Name', group: 'Basics', kind: 'text', nullable: false, requires: null, field: 'name', maxLength: 255 },
  { key: 'description', label: 'Description', group: 'Basics', kind: 'text', nullable: true, requires: null, field: 'description' },
  { key: 'category', label: 'Category (path, e.g. Apparel > T-Shirts)', group: 'Basics', kind: 'category', nullable: true, requires: null, field: 'categoryId' },
  { key: 'imageUrl', label: 'Image URL', group: 'Basics', kind: 'text', nullable: true, requires: null, field: 'imageUrl' },
  { key: 'barcode', label: 'Barcode', group: 'Identifiers', kind: 'text', nullable: true, requires: null, field: 'barcode', maxLength: 100 },
  { key: 'mpn', label: 'MPN', group: 'Identifiers', kind: 'text', nullable: true, requires: null, field: 'mpn', maxLength: 100 },
  { key: 'countryOfOrigin', label: 'Country of origin', group: 'Identifiers', kind: 'country', nullable: true, requires: null, field: 'countryOfOrigin' },
  { key: 'weight', label: 'Weight (kg)', group: 'Logistics', kind: 'decimal', nullable: true, requires: null, field: 'weight', decimal: { precision: 10, scale: 4 } },
  { key: 'widthCm', label: 'Width (cm)', group: 'Logistics', kind: 'decimal', nullable: true, requires: null, field: 'widthCm', decimal: { precision: 10, scale: 2 } },
  { key: 'heightCm', label: 'Height (cm)', group: 'Logistics', kind: 'decimal', nullable: true, requires: null, field: 'heightCm', decimal: { precision: 10, scale: 2 } },
  { key: 'depthCm', label: 'Depth (cm)', group: 'Logistics', kind: 'decimal', nullable: true, requires: null, field: 'depthCm', decimal: { precision: 10, scale: 2 } },
  { key: 'stockUnit', label: 'Stock unit', group: 'Logistics', kind: 'text', nullable: false, requires: null, field: 'stockUnit', maxLength: 32 },
  { key: 'oversellAllowed', label: 'Oversell allowed', group: 'Logistics', kind: 'boolean', nullable: false, requires: null, field: 'oversellAllowed' },
  { key: 'salesPriceBase', label: 'Regular price', group: 'Prices', kind: 'decimal', nullable: true, requires: 'inventory.prices', field: 'salesPriceBase', decimal: { precision: 12, scale: 4 } },
  { key: 'salePriceBase', label: 'Sale price', group: 'Prices', kind: 'decimal', nullable: true, requires: 'inventory.prices', field: 'salePriceBase', decimal: { precision: 12, scale: 4 } },
  { key: 'salesPriceTaxInclusive', label: 'Prices include tax', group: 'Prices', kind: 'boolean', nullable: false, requires: 'inventory.prices', field: 'salesPriceTaxInclusive' },
  { key: 'preferredSupplierName', label: 'Preferred supplier (name)', group: 'Supplier', kind: 'supplier', nullable: true, requires: null, field: 'preferredSupplierId' },
  { key: 'preferredSupplierLocked', label: 'Preferred supplier locked', group: 'Supplier', kind: 'boolean', nullable: false, requires: null, field: 'preferredSupplierLocked' },
  { key: 'lifecycleStatus', label: 'Lifecycle status', group: 'Status', kind: 'lifecycle', nullable: false, requires: null, field: 'lifecycleStatus' },
]

const COLUMN_BY_KEY = new Map(PRODUCT_CSV_COLUMNS.map((column) => [column.key.toLowerCase(), column]))

export function findProductCsvColumn(header: string): ProductCsvColumn | null {
  return COLUMN_BY_KEY.get(header.trim().toLowerCase()) ?? null
}

/** The columns a role may use: the ones with no permission requirement plus those whose requirement it holds. */
export function allowedProductCsvColumns(canUse: (permission: Permission) => boolean): ProductCsvColumn[] {
  return PRODUCT_CSV_COLUMNS.filter((column) => column.requires === null || canUse(column.requires))
}

export type ProductCsvColumnChoice = { ok: true; columns: ProductCsvColumn[] } | { ok: false; error: string }

/**
 * Resolve the picker's chosen keys into registry columns, in registry order, de-duplicated. An unknown key, or a column
 * the caller may not use, is refused as a whole rather than dropped: a download that quietly omits the column the
 * operator ticked would be edited as if it were complete.
 */
export function chooseProductCsvColumns(keys: readonly string[], canUse: (permission: Permission) => boolean): ProductCsvColumnChoice {
  const wanted = new Set<string>()
  for (const raw of keys) {
    const column = findProductCsvColumn(String(raw))
    if (!column) return { ok: false, error: `"${String(raw)}" is not a column that can be edited by CSV.` }
    if (column.requires && !canUse(column.requires)) {
      return { ok: false, error: `The ${column.label} column needs the ${column.requires} permission, which you do not have.` }
    }
    wanted.add(column.key)
  }
  if (wanted.size === 0) return { ok: false, error: 'Choose at least one column to edit.' }
  return { ok: true, columns: PRODUCT_CSV_COLUMNS.filter((column) => wanted.has(column.key)) }
}
