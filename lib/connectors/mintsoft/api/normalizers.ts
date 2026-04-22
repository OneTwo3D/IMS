import type { WmsAsnLineRef, WmsAsnRef, WmsBundleComponent, WmsBundleRef, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'

const ARRAY_PAYLOAD_KEYS = ['data', 'Data', 'items', 'Items', 'results', 'Results', 'warehouses', 'Warehouses', 'stockLevels', 'StockLevels', 'returns', 'Returns'] as const
const ASN_ARRAY_PAYLOAD_KEYS = [...ARRAY_PAYLOAD_KEYS, 'lines', 'Lines', 'asnLines', 'AsnLines', 'orderItems', 'OrderItems'] as const
const WAREHOUSE_ID_KEYS = ['warehouseId', 'WarehouseId', 'id', 'Id', 'ID']
const WAREHOUSE_NAME_KEYS = ['name', 'Name', 'warehouseName', 'WarehouseName', 'description', 'Description', 'label', 'Label']
const STOCK_SKU_KEYS = ['sku', 'SKU', 'productSku', 'ProductSku', 'productCode', 'ProductCode', 'itemCode', 'ItemCode', 'code', 'Code']
const STOCK_QTY_KEYS = ['level', 'Level', 'quantity', 'Quantity', 'qty', 'Qty', 'stockLevel', 'StockLevel', 'stockQuantity', 'StockQuantity', 'available', 'Available', 'freeStock', 'FreeStock']
const PRODUCT_ID_KEYS = ['productId', 'ProductId', 'id', 'Id', 'ID']
const PRODUCT_NAME_KEYS = ['name', 'Name', 'productName', 'ProductName', 'description', 'Description']
const PRODUCT_BARCODE_KEYS = ['ean', 'EAN', 'barcode', 'Barcode', 'upc', 'UPC', 'eanCode', 'EANCode']
const RETURN_ID_KEYS = ['returnId', 'ReturnId', 'externalReturnId', 'ExternalReturnId', 'id', 'Id', 'ID']
const RETURN_ORDER_REFERENCE_KEYS = ['orderReference', 'OrderReference', 'orderNumber', 'OrderNumber', 'externalOrderNumber', 'ExternalOrderNumber', 'reference', 'Reference']
const RETURN_REASON_KEYS = ['reason', 'Reason', 'returnReason', 'ReturnReason']
const RETURN_QTY_KEYS = ['qty', 'Qty', 'quantity', 'Quantity', 'returnedQty', 'ReturnedQty', 'returnQty', 'ReturnQty', 'receivedQty', 'ReceivedQty']
const RETURN_RECEIVED_AT_KEYS = ['receivedAt', 'ReceivedAt', 'createdAt', 'CreatedAt', 'updatedAt', 'UpdatedAt', 'returnDate', 'ReturnDate', 'date', 'Date']
const ASN_ID_KEYS = ['asnId', 'AsnId', 'ASNId', 'externalAsnId', 'ExternalAsnId', 'id', 'Id', 'ID']
const ASN_STATUS_KEYS = ['status', 'Status', 'asnStatus', 'AsnStatus']
const ASN_LINE_ID_KEYS = ['externalAsnLineId', 'ExternalAsnLineId', 'asnLineId', 'AsnLineId', 'lineId', 'LineId', 'lineID', 'LineID', 'id', 'Id', 'ID']
const ASN_SOURCE_LINE_ID_KEYS = ['sourceLineId', 'SourceLineId', 'referenceLineId', 'ReferenceLineId', 'imsLineId', 'ImsLineId', 'externalReference', 'ExternalReference']

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

function getFirstDate(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value)
      if (Number.isFinite(date.getTime())) return date.toISOString()
    }
    if (typeof value === 'string' && value.trim()) {
      const date = new Date(value)
      if (Number.isFinite(date.getTime())) return date.toISOString()
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

function extractMintsoftArrayPayloadWithKeys(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (!record) return []

  for (const key of keys) {
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

export function normalizeMintsoftReturn(value: unknown): WmsReturnRecord | null {
  const record = asRecord(value)
  if (!record) return null

  const externalReturnId = getFirstString(record, RETURN_ID_KEYS)
  if (!externalReturnId) return null

  return {
    externalReturnId,
    externalWarehouseId: getFirstString(record, ['warehouseId', 'WarehouseId', 'externalWarehouseId', 'ExternalWarehouseId']),
    sku: getFirstString(record, STOCK_SKU_KEYS),
    qty: getFirstNumber(record, RETURN_QTY_KEYS),
    orderReference: getFirstString(record, RETURN_ORDER_REFERENCE_KEYS),
    reason: getFirstString(record, RETURN_REASON_KEYS),
    receivedAt: getFirstDate(record, RETURN_RECEIVED_AT_KEYS),
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

export function normalizeMintsoftAsnLine(value: unknown): WmsAsnLineRef | null {
  const record = asRecord(value)
  if (!record) return null

  const externalLineId = getFirstString(record, ASN_LINE_ID_KEYS)
  const sourceLineId = getFirstString(record, ASN_SOURCE_LINE_ID_KEYS)
  if (!externalLineId || !sourceLineId) return null

  return {
    externalLineId,
    sourceLineId,
    externalProductId: getFirstString(record, PRODUCT_ID_KEYS),
    sku: getFirstString(record, STOCK_SKU_KEYS),
    quantity: getFirstNumber(record, RETURN_QTY_KEYS),
    raw: record,
  }
}

const BUNDLE_ID_KEYS = ['ID', 'Id', 'id', 'externalBundleId', 'ExternalBundleId', 'bundleId', 'BundleId']
const BUNDLE_NAME_KEYS = ['name', 'Name', 'bundleName', 'BundleName', 'description', 'Description']
const BUNDLE_COMPONENT_KEYS = ['components', 'Components', 'items', 'Items', 'bundleItems', 'BundleItems'] as const
const BUNDLE_COMPONENT_PRODUCT_ID_KEYS = ['productId', 'ProductId', 'componentProductId', 'ComponentProductId', 'id', 'Id', 'ID']
const BUNDLE_COMPONENT_QTY_KEYS = ['quantity', 'Quantity', 'qty', 'Qty', 'componentQty', 'ComponentQty']

export function normalizeMintsoftBundleItem(value: unknown): WmsBundleComponent | null {
  const record = asRecord(value)
  if (!record) return null

  const sku = getFirstString(record, STOCK_SKU_KEYS)
  const quantity = getFirstNumber(record, BUNDLE_COMPONENT_QTY_KEYS)
  if (!sku || quantity == null || quantity <= 0) return null

  return {
    externalProductId: getFirstString(record, BUNDLE_COMPONENT_PRODUCT_ID_KEYS),
    sku,
    quantity,
  }
}

export function normalizeMintsoftBundle(value: unknown): WmsBundleRef | null {
  const record = extractMintsoftObjectPayload(value)
  if (!record) return null

  const sku = getFirstString(record, STOCK_SKU_KEYS)
  const externalBundleId = getFirstString(record, BUNDLE_ID_KEYS)
  if (!sku || !externalBundleId) return null

  const components = extractMintsoftArrayPayloadWithKeys(record, BUNDLE_COMPONENT_KEYS)
    .map((item) => normalizeMintsoftBundleItem(item))
    .filter((item): item is WmsBundleComponent => Boolean(item))

  return {
    externalBundleId,
    sku,
    name: getFirstString(record, BUNDLE_NAME_KEYS),
    components,
    raw: record,
  }
}

export function normalizeMintsoftAsn(value: unknown): WmsAsnRef | null {
  const record = extractMintsoftObjectPayload(value)
  if (!record) return null

  const externalAsnId = getFirstString(record, ASN_ID_KEYS)
  if (!externalAsnId) return null

  const lines = extractMintsoftArrayPayloadWithKeys(record, ASN_ARRAY_PAYLOAD_KEYS)
    .map((entry) => normalizeMintsoftAsnLine(entry))
    .filter((entry): entry is WmsAsnLineRef => Boolean(entry))

  if (lines.length === 0) return null

  return {
    externalAsnId,
    status: getFirstString(record, ASN_STATUS_KEYS),
    lines,
    raw: record,
  }
}
