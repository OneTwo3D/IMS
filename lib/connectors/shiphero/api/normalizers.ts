import type { WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/**
 * Normalize ShipHero `account.data.warehouses` into the generic warehouse ref.
 * ShipHero exposes both a UUID `id` and an integer `legacy_id`; the external
 * warehouse identifier used for bindings prefers `legacy_id` (what most ShipHero
 * order/inventory payloads reference), falling back to `id`.
 */
export function normalizeShipheroWarehouse(value: unknown): WmsWarehouseRef | null {
  const record = asRecord(value)
  if (!record) return null

  const externalId = firstString(record, ['legacy_id', 'legacyId', 'id'])
  if (!externalId) return null

  const name = firstString(record, ['identifier', 'profile', 'name']) ?? externalId
  return { externalId, name }
}

export function extractShipheroWarehouses(value: unknown): WmsWarehouseRef[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeShipheroWarehouse(item))
    .filter((item): item is WmsWarehouseRef => Boolean(item))
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
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

const STOCK_SKU_KEYS = ['sku', 'SKU', 'product_sku'] as const
// `on_hand` is the physical count we reconcile against IMS on-hand. Field names
// are flagged "verify on live tenant"; accept the documented alternatives.
const STOCK_QTY_KEYS = ['on_hand', 'onHand', 'quantity_on_hand', 'quantity'] as const

/**
 * Normalize one ShipHero `warehouse_products` row → the generic WmsStockLine.
 * Mirrors normalizeMintsoftStockLine's shape; reads `on_hand` defensively.
 */
export function normalizeShipheroStockLine(value: unknown): WmsStockLine | null {
  const record = asRecord(value)
  if (!record) return null
  const sku = firstString(record, STOCK_SKU_KEYS)
  const quantity = firstNumber(record, STOCK_QTY_KEYS)
  if (!sku || quantity == null) return null
  return { sku, quantity, raw: record }
}

export function extractShipheroStockLines(value: unknown): WmsStockLine[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeShipheroStockLine(item))
    .filter((item): item is WmsStockLine => Boolean(item))
}
