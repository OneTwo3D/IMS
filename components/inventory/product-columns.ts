export type ColKey =
  | 'sku' | 'name' | 'type' | 'parentSku' | 'barcode'
  | 'dimensions' | 'weight' | 'salesPriceGbp' | 'salePriceGbp' | 'salesPriceTaxInclusive'
  | 'totalStock' | 'allocatedStock' | 'availableStock' | 'incomingStock'
  | 'inventoryValue' | 'variantCount'
  | 'active' | 'createdAt' | 'updatedAt'

export const ALL_COLUMNS: { key: ColKey; label: string; defaultVisible: boolean }[] = [
  { key: 'sku',                  label: 'SKU',                defaultVisible: true  },
  { key: 'name',                 label: 'Name',               defaultVisible: true  },
  { key: 'type',                 label: 'Type',               defaultVisible: true  },
  { key: 'parentSku',            label: 'Parent SKU',         defaultVisible: false },
  { key: 'barcode',              label: 'Barcode',            defaultVisible: false },
  { key: 'dimensions',           label: 'Dimensions (W×H×D)', defaultVisible: false },
  { key: 'weight',               label: 'Weight',             defaultVisible: false },
  { key: 'salesPriceGbp',        label: 'Regular Price',      defaultVisible: true  },
  { key: 'salePriceGbp',         label: 'Sale Price',         defaultVisible: false },
  { key: 'salesPriceTaxInclusive', label: 'Tax Incl.',        defaultVisible: false },
  { key: 'totalStock',           label: 'Stock',              defaultVisible: true  },
  { key: 'allocatedStock',       label: 'Allocated',          defaultVisible: false },
  { key: 'availableStock',       label: 'Available',          defaultVisible: false },
  { key: 'incomingStock',        label: 'Incoming',           defaultVisible: false },
  { key: 'inventoryValue',       label: 'COGS Value',         defaultVisible: true  },
  { key: 'variantCount',         label: 'Variants',           defaultVisible: false },
  { key: 'active',               label: 'Status',             defaultVisible: true  },
  { key: 'createdAt',            label: 'Created',            defaultVisible: false },
  { key: 'updatedAt',            label: 'Updated',            defaultVisible: false },
]

export const STORAGE_KEY = 'ims-product-table-cols'
export const COLS_CHANGED_EVENT = 'ims-cols-changed'

export function defaultVisibility(): Record<ColKey, boolean> {
  return Object.fromEntries(
    ALL_COLUMNS.map((c) => [c.key, c.defaultVisible])
  ) as Record<ColKey, boolean>
}
