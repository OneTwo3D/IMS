import type { WmsProductRef, WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'

const ARRAY_PAYLOAD_KEYS = ['data', 'Data', 'items', 'Items', 'results', 'Results', 'warehouses', 'Warehouses', 'stockLevels', 'StockLevels'] as const
const WAREHOUSE_ID_KEYS = ['warehouseId', 'WarehouseId', 'id', 'Id', 'ID']
const WAREHOUSE_NAME_KEYS = ['name', 'Name', 'warehouseName', 'WarehouseName', 'description', 'Description', 'label', 'Label']
const STOCK_SKU_KEYS = ['sku', 'SKU', 'productSku', 'ProductSku', 'productCode', 'ProductCode', 'itemCode', 'ItemCode', 'code', 'Code']
const STOCK_QTY_KEYS = ['level', 'Level', 'quantity', 'Quantity', 'qty', 'Qty', 'stockLevel', 'StockLevel', 'stockQuantity', 'StockQuantity', 'available', 'Available', 'freeStock', 'FreeStock']
const PRODUCT_ID_KEYS = ['productId', 'ProductId', 'id', 'Id', 'ID']
const PRODUCT_NAME_KEYS = ['name', 'Name', 'productName', 'ProductName', 'description', 'Description']
const PRODUCT_BARCODE_KEYS = ['ean', 'EAN', 'barcode', 'Barcode', 'upc', 'UPC', 'eanCode', 'EANCode']

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function getFirstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

export function extractMintsoftArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (!record) return []

  for (const key of ARRAY_PAYLOAD_KEYS) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }

  return []
}

export function extractMintsoftObjectPayload(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value)
  if (!record) return null

  for (const key of ['data', 'Data', 'item', 'Item', 'result', 'Result', 'product', 'Product'] as const) {
    const nested = asRecord(record[key])
    if (nested) return nested
  }

  return record
}

export function normalizeMintsoftWarehouse(value: unknown): WmsWarehouseRef | null {
  const record = asRecord(value)
  if (!record) return null

  const externalId = getFirstString(record, WAREHOUSE_ID_KEYS)
  const name = getFirstString(record, WAREHOUSE_NAME_KEYS)
  if (!externalId || !name) return null

  return { externalId, name }
}

export function normalizeMintsoftStockLine(value: unknown): WmsStockLine | null {
  const record = asRecord(value)
  if (!record) return null

  const sku = getFirstString(record, STOCK_SKU_KEYS)
  const quantity = getFirstNumber(record, STOCK_QTY_KEYS)
  if (!sku || quantity == null) return null

  return {
    sku,
    quantity,
    raw: record,
  }
}

export function normalizeMintsoftProduct(value: unknown): WmsProductRef | null {
  const record = extractMintsoftObjectPayload(value)
  if (!record) return null

  const externalId = getFirstString(record, PRODUCT_ID_KEYS)
  const sku = getFirstString(record, STOCK_SKU_KEYS)
  if (!externalId || !sku) return null

  return {
    externalId,
    sku,
    barcode: getFirstString(record, PRODUCT_BARCODE_KEYS),
    raw: record,
  }
}

export function normalizeMintsoftProductListItem(value: unknown): WmsProductRef | null {
  const record = asRecord(value)
  if (!record) return null

  const externalId = getFirstString(record, PRODUCT_ID_KEYS)
  const sku = getFirstString(record, STOCK_SKU_KEYS)
  if (!externalId || !sku) return null

  return {
    externalId,
    sku,
    barcode: getFirstString(record, PRODUCT_BARCODE_KEYS),
    raw: record,
  }
}

export function normalizeMintsoftProductPayload(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value)
  if (!record) return null

  const payload: Record<string, unknown> = {}
  const sku = getFirstString(record, STOCK_SKU_KEYS)
  const name = getFirstString(record, PRODUCT_NAME_KEYS)
  const barcode = getFirstString(record, PRODUCT_BARCODE_KEYS)
  const customsDescription = getFirstString(record, ['customsDescription', 'CustomsDescription'])
  const commodityCode = getFirstString(record, ['commodityCode', 'CommodityCode', 'code', 'Code'])

  if (sku) payload.SKU = sku
  if (name) payload.Name = name
  if (customsDescription) payload.CustomsDescription = customsDescription
  if (barcode) payload.EAN = barcode
  if (commodityCode) payload.CommodityCode = { Code: commodityCode }

  return payload
}
