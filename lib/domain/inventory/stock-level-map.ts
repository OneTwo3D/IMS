import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import { roundQuantity, subtractMoney } from '@/lib/domain/math/decimal'

export type StockLevelEntry = { total: number; available: number }
export type StockLevelMap = Record<string, Record<string, StockLevelEntry>>

export type StockLevelMapRow = {
  productId: string
  warehouseId: string
  quantity: DecimalLike
  reservedQty: DecimalLike
  updatedAt?: Date | string | null
}

export type StockLevelMapScope = {
  productIds?: readonly string[]
  warehouseIds?: readonly string[]
  updatedSince?: Date
  skip?: number
  take?: number
}

export type NormalizedStockLevelMapScope = {
  productIds?: string[]
  warehouseIds?: string[]
  updatedSince?: Date
  skip?: number
  take?: number
}

function normalizeIds(ids: readonly string[] | undefined): string[] | undefined {
  if (!ids) return undefined
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort()
}

export function normalizeStockLevelMapScope(scope: StockLevelMapScope = {}): NormalizedStockLevelMapScope {
  return {
    productIds: normalizeIds(scope.productIds),
    warehouseIds: normalizeIds(scope.warehouseIds),
    updatedSince: scope.updatedSince,
    skip: scope.skip != null && scope.skip > 0 ? Math.floor(scope.skip) : undefined,
    take: scope.take != null && scope.take > 0 ? Math.floor(scope.take) : undefined,
  }
}

export function isEmptyStockLevelMapScope(scope: StockLevelMapScope = {}): boolean {
  const normalized = normalizeStockLevelMapScope(scope)
  if (scope.productIds && !normalized.productIds?.length) return true
  if (scope.warehouseIds && !normalized.warehouseIds?.length) return true
  if (scope.take != null && scope.take <= 0) return true
  return false
}

export function buildStockLevelMap(rows: readonly StockLevelMapRow[]): StockLevelMap {
  const map: StockLevelMap = {}
  for (const row of rows) {
    if (!map[row.productId]) map[row.productId] = {}
    const total = decimalToNumber(row.quantity)
    const reserved = decimalToNumber(row.reservedQty)
    map[row.productId][row.warehouseId] = {
      total,
      available: roundQuantity(subtractMoney(total, reserved), 4).toNumber(),
    }
  }
  return map
}

export function filterStockLevelRowsForScope<T extends StockLevelMapRow>(
  rows: readonly T[],
  scope: StockLevelMapScope = {},
): T[] {
  if (isEmptyStockLevelMapScope(scope)) return []

  const normalized = normalizeStockLevelMapScope(scope)
  const productIds = normalized.productIds ? new Set(normalized.productIds) : null
  const warehouseIds = normalized.warehouseIds ? new Set(normalized.warehouseIds) : null
  const updatedSince = normalized.updatedSince?.getTime()

  const filtered = rows.filter((row) => {
    if (productIds && !productIds.has(row.productId)) return false
    if (warehouseIds && !warehouseIds.has(row.warehouseId)) return false
    if (updatedSince != null) {
      if (!row.updatedAt) return false
      if (new Date(row.updatedAt).getTime() < updatedSince) return false
    }
    return true
  })

  const start = normalized.skip ?? 0
  const end = normalized.take ? start + normalized.take : undefined
  return filtered.slice(start, end)
}
