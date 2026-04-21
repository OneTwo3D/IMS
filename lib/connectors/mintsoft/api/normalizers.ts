import type { WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'

const ARRAY_PAYLOAD_KEYS = ['data', 'Data', 'items', 'Items', 'results', 'Results', 'warehouses', 'Warehouses', 'stockLevels', 'StockLevels'] as const
const WAREHOUSE_ID_KEYS = ['warehouseId', 'WarehouseId', 'id', 'Id', 'ID']
const WAREHOUSE_NAME_KEYS = ['name', 'Name', 'warehouseName', 'WarehouseName', 'description', 'Description', 'label', 'Label']
const STOCK_SKU_KEYS = ['sku', 'SKU', 'productSku', 'ProductSku', 'productCode', 'ProductCode', 'itemCode', 'ItemCode', 'code', 'Code']
const STOCK_QTY_KEYS = ['level', 'Level', 'quantity', 'Quantity', 'qty', 'Qty', 'stockLevel', 'StockLevel', 'stockQuantity', 'StockQuantity', 'available', 'Available', 'freeStock', 'FreeStock']

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
