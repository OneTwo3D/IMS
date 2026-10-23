import type { WmsAsnLineRef, WmsAsnRef, WmsBundleComponent, WmsBundleRef, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import { readMintsoftAsnItemExpectedQty, readMintsoftAsnItemReceipt } from './asn-quantities'
import { readMintsoftAsnWireStatusField } from './asn-status'
import { clampCustomsDescription } from '@/lib/trade/customs-description'

const ARRAY_PAYLOAD_KEYS = ['data', 'Data', 'items', 'Items', 'results', 'Results', 'warehouses', 'Warehouses', 'stockLevels', 'StockLevels', 'returns', 'Returns'] as const
const ASN_ARRAY_PAYLOAD_KEYS = [...ARRAY_PAYLOAD_KEYS, 'lines', 'Lines', 'asnLines', 'AsnLines', 'orderItems', 'OrderItems'] as const
const WAREHOUSE_ID_KEYS = ['warehouseId', 'WarehouseId', 'id', 'Id', 'ID']
const WAREHOUSE_NAME_KEYS = ['name', 'Name', 'warehouseName', 'WarehouseName', 'description', 'Description', 'label', 'Label']
const STOCK_SKU_KEYS = ['sku', 'SKU', 'productSku', 'ProductSku', 'productCode', 'ProductCode', 'itemCode', 'ItemCode', 'code', 'Code']
const PRODUCT_ID_KEYS = ['productId', 'ProductId', 'id', 'Id', 'ID']
const PRODUCT_NAME_KEYS = ['name', 'Name', 'productName', 'ProductName', 'description', 'Description']
const PRODUCT_BARCODE_KEYS = ['ean', 'EAN', 'barcode', 'Barcode', 'upc', 'UPC', 'eanCode', 'EANCode']
const RETURN_ID_KEYS = ['returnId', 'ReturnId', 'externalReturnId', 'ExternalReturnId', 'id', 'Id', 'ID']
const RETURN_ORDER_REFERENCE_KEYS = ['orderReference', 'OrderReference', 'orderNumber', 'OrderNumber', 'externalOrderNumber', 'ExternalOrderNumber', 'reference', 'Reference']
const RETURN_REASON_KEYS = ['reason', 'Reason', 'returnReason', 'ReturnReason']
const RETURN_QTY_KEYS = ['qty', 'Qty', 'quantity', 'Quantity', 'returnedQty', 'ReturnedQty', 'returnQty', 'ReturnQty', 'receivedQty', 'ReceivedQty']
const RETURN_RECEIVED_AT_KEYS = ['receivedAt', 'ReceivedAt', 'createdAt', 'CreatedAt', 'updatedAt', 'UpdatedAt', 'returnDate', 'ReturnDate', 'date', 'Date']
const ASN_ID_KEYS = ['asnId', 'AsnId', 'ASNId', 'externalAsnId', 'ExternalAsnId', 'id', 'Id', 'ID']
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

/**
 * Like extractMintsoftArrayPayload, but THROWS when the payload is neither a bare
 * array nor a recognised `{Data|Items|…}` wrapper of one. Used by paginated
 * fetches (Order/List delta) where a malformed 2xx body — a proxy error object,
 * schema drift, or null — must fail closed rather than masquerade as a complete
 * empty page and let the caller advance its watermark past rows it never saw. A
 * genuine empty array (or empty recognised wrapper) still returns [] without
 * throwing.
 */
export function extractMintsoftArrayPayloadStrict(value: unknown, context: string): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (record) {
    for (const key of ARRAY_PAYLOAD_KEYS) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
  }
  const shape = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  throw new Error(
    `Mintsoft ${context}: expected an array (or a recognised {${ARRAY_PAYLOAD_KEYS.join('|')}} wrapper of one) ` +
      `but got ${shape} — refusing to treat a malformed response as a complete empty page`,
  )
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

/**
 * MINTSOFT `GET /api/Product/StockLevels?WarehouseId=` — ON HAND vs AVAILABLE (o3d-4pzls).
 *
 * Each row is `{ SKU, ProductId, WarehouseId, ClientId, Level, TotalStockLevel, LowStockLevel,
 * PreOrderable, Bundle, Breakdown, LastUpdated }`. Owner-confirmed in the Mintsoft UI
 * (2026-10-23) and seen in a live read-only probe of two warehouses (2 x 2386 rows, `Level <=
 * TotalStockLevel` on every row, differing on 13 SKUs, e.g. SKU 129552751 Level 28 / Total 36):
 *   - `TotalStockLevel` = physical ON HAND (includes units allocated to open orders)
 *   - `Level`           = AVAILABLE (on hand minus allocated to open orders)
 * The first version picked `Level` first from a fallback list, so IMS (whose
 * `StockLevel.quantity` is on hand, reservations separate) was compared with AVAILABLE and
 * every allocated unit read as a shortfall. Both fields are now read by EXACT name, with no
 * fallback list, and a row that cannot supply a trustworthy `TotalStockLevel` throws.
 *
 * CONSUMER AUDIT (what each reader of the stock line means, and what changed):
 *   lib/connectors/mintsoft/sync/stock-sync.ts  wmsQty = line.onHand (compared with IMS
 *     stock_levels.quantity -> ON HAND; align-up/down, thresholds, discrepancy rows, activity
 *     log, UNMAPPED/MISSING_IN_IMS wmsValue)                       CHANGED: Level -> TotalStockLevel
 *   same file, wms_stock_snapshots.externalQty (read back by collectMissingInWmsCandidates and
 *     compared with IMS quantity for "missing in WMS") -> ON HAND  CHANGED: follows wmsQty
 *   lib/connectors/mintsoft/sync/stock-sync-helpers.ts consolidateMintsoftStockLines /
 *     collectMissingInWmsCandidates / hasMintsoftThresholdBreach: pure on-hand arithmetic
 *                                                                  CHANGED: duplicates throw, field rename
 *   lib/connectors/wms/types.ts WmsStockLine / WmsConnector.fetchStockLevels: generic contract,
 *     connector-agnostic; `onHand` + nullable `available`          CHANGED: `quantity` removed
 *   tests/helpers/fictitious-wms-connector.ts (second-connector seam double)  CHANGED: new shape
 *   app/api/e2e/mintsoft/[...slug]/route.ts (fake Mintsoft for e2e)  CHANGED: also emits TotalStockLevel
 *   wms-watchdog cron: freshness of the last successful sync only, reads no quantity   NO CHANGE
 *   reconciliation pack R1 ("IMS stock_levels equal Mintsoft on-hand"): declarative; its claim
 *     was already on-hand and is now true of the sync's figure    NO CHANGE
 *   first-load: operator-supplied 3PL export file, never this API  NO CHANGE
 *   ShipHero: removed from the repo (docs/archive/shiphero-connector-removal.md)  N/A
 * `available` is carried for diagnostics only; nothing may compare it with IMS on hand.
 */
function readStockInteger(record: Record<string, unknown>, field: string, where: string): number | undefined {
  if (!(field in record) || record[field] === undefined) return undefined
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Mintsoft StockLevels ${where}: ${field} must be a non-negative integer number, got ${JSON.stringify(value)}`)
  }
  return value
}

export function normalizeMintsoftStockLine(value: unknown, index = 0): WmsStockLine {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`Mintsoft StockLevels row ${index}: expected an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
  }
  const rawSku = record.SKU
  const sku = typeof rawSku === 'string' ? rawSku.trim() : ''
  if (!sku) {
    throw new Error(`Mintsoft StockLevels row ${index}: SKU must be a non-empty string, got ${JSON.stringify(rawSku)}`)
  }
  const where = `row ${index} (SKU ${sku})`

  const onHand = readStockInteger(record, 'TotalStockLevel', where)
  if (onHand === undefined) {
    throw new Error(`Mintsoft StockLevels ${where}: TotalStockLevel (on hand) is missing; refusing to fall back to Level (available) or 0`)
  }
  const availableRead = readStockInteger(record, 'Level', where)
  const available = availableRead === undefined ? null : availableRead
  if (available !== null && available > onHand) {
    throw new Error(`Mintsoft StockLevels ${where}: Level (available ${available}) exceeds TotalStockLevel (on hand ${onHand}); the two fields no longer mean what the connector assumes`)
  }

  return { sku, onHand, available, raw: record }
}

/** Normalise a whole StockLevels response, failing closed on any unreadable row or duplicate SKU. */
export function normalizeMintsoftStockLevels(data: unknown): WmsStockLine[] {
  const rows = extractMintsoftArrayPayloadStrict(data, 'StockLevels')
  const seen = new Set<string>()
  return rows.map((row, index) => {
    const line = normalizeMintsoftStockLine(row, index)
    if (seen.has(line.sku)) {
      throw new Error(`Mintsoft StockLevels row ${index}: duplicate SKU "${line.sku}" in one response; refusing to merge or pick one`)
    }
    seen.add(line.sku)
    return line
  })
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
  const customsDescription = clampCustomsDescription(getFirstString(record, ['customsDescription', 'CustomsDescription']))
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
    // o3d-btiw. These two reads used to be ONE — `quantity: getFirstNumber(record, RETURN_QTY_KEYS)`
    // — over `qty`/`Qty`/`quantity`/`Quantity`/`returnedQty`/`receivedQty`, and a live Mintsoft
    // `ASNItem` carries NONE of those keys (3098 of 3098 items, both ASN routes; bd o3d-vcw8,
    // o3d-btiw). So every live line arrived with `quantity: null`, the booked-in processor read that
    // as 0 received and applied nothing while calling itself processed. The item's real quantities
    // are `QuantityExpected`, `QuantityReceieved` (sic) and `QuantityBooked`, they answer DIFFERENT
    // questions, and asn-quantities.ts is the one place that says which is which and what an
    // unreadable one means.
    expectedQty: readMintsoftAsnItemExpectedQty(record),
    receipt: readMintsoftAsnItemReceipt(record),
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

  const rawComponents = extractMintsoftArrayPayloadWithKeys(record, BUNDLE_COMPONENT_KEYS)
  const components = rawComponents
    .map((item) => normalizeMintsoftBundleItem(item))
    .filter((item): item is WmsBundleComponent => Boolean(item))

  return {
    externalBundleId,
    sku,
    name: getFirstString(record, BUNDLE_NAME_KEYS),
    components,
    unreadableComponentCount: rawComponents.length - components.length,
    raw: record,
  }
}

export type MintsoftAsnNormalizationOptions = {
  externalAsnIdFallback?: string | null
}

export function normalizeMintsoftAsn(
  value: unknown,
  options?: MintsoftAsnNormalizationOptions,
): WmsAsnRef | null {
  const record = extractMintsoftObjectPayload(value)
  if (!record) return null

  const externalAsnId = getFirstString(record, ASN_ID_KEYS) ?? options?.externalAsnIdFallback?.trim() ?? null
  if (!externalAsnId) return null

  const lines = extractMintsoftArrayPayloadWithKeys(record, ASN_ARRAY_PAYLOAD_KEYS)
    .map((entry) => normalizeMintsoftAsnLine(entry))
    .filter((entry): entry is WmsAsnLineRef => Boolean(entry))

  if (lines.length === 0) return null

  return {
    externalAsnId,
    // ROUND 8, CODEX HIGH — THE SAME COLLAPSE ON THE CREATE PATH. This read used to be
    // `getFirstString(record, ['status', 'Status', 'asnStatus', 'AsnStatus'])`, and live Mintsoft serves
    // neither: the field is `ASNStatus`, an OBJECT carrying `Name`, alongside a numeric `ASNStatusId`.
    // So every ASN read back by id arrived with `status: null` too, and the creators' normalizer turned
    // that into OPEN. It happened to be harmless for a create (a just-created ASN really is NEW) but it
    // was the same unread remote field spent as a benign default, and it is the same one reader now —
    // which, since round 9, resolves MINTSOFT'S 13 published statuses and no IMS name at all.
    status: readMintsoftAsnWireStatusField(record),
    lines,
    raw: record,
  }
}
