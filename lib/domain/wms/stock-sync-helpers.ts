import { Prisma } from '@/app/generated/prisma/client'
import type { WmsStockLine } from '@/lib/connectors/wms/types'

/**
 * Connector-agnostic stock-sync primitives. Mirrors the (connector-named) Mintsoft
 * helpers; ShipHero uses these directly. (Follow-up onetwo3d-ims tracks migrating
 * Mintsoft's lib/connectors/mintsoft/sync/stock-sync-helpers.ts onto this shared
 * module so there is a single source of truth.)
 */

export type StockThresholdConfig = {
  absoluteDelta: number | null
  percentDelta: number | null
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function parseStockThresholds(value: Prisma.JsonValue | null | undefined): StockThresholdConfig {
  const record = asRecord(value)
  return {
    absoluteDelta: parseNumber(record?.absoluteDelta) ?? null,
    percentDelta: parseNumber(record?.percentDelta) ?? null,
  }
}

export function sanitizeStockThresholds(input: {
  absoluteDelta?: number | null
  percentDelta?: number | null
} | null | undefined): Prisma.InputJsonValue | null {
  if (!input) return null
  const absoluteDelta = input.absoluteDelta != null && Number.isFinite(input.absoluteDelta)
    ? Math.max(0, input.absoluteDelta)
    : null
  const percentDelta = input.percentDelta != null && Number.isFinite(input.percentDelta)
    ? Math.max(0, input.percentDelta)
    : null
  if (absoluteDelta == null && percentDelta == null) return null
  return { absoluteDelta, percentDelta } satisfies Prisma.InputJsonObject
}

export function isBindingDue(
  lastStockSyncAt: Date | null,
  syncFrequencyMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!lastStockSyncAt) return true
  const dueAt = lastStockSyncAt.getTime() + (Math.max(1, syncFrequencyMinutes) * 60_000)
  return now.getTime() >= dueAt
}

export function consolidateStockLines(lines: WmsStockLine[]): WmsStockLine[] {
  const bySku = new Map<string, WmsStockLine>()
  for (const line of lines) {
    const existing = bySku.get(line.sku)
    if (existing) {
      existing.quantity += line.quantity
      existing.raw = line.raw ?? existing.raw
    } else {
      bySku.set(line.sku, { ...line })
    }
  }
  return Array.from(bySku.values()).sort((left, right) => left.sku.localeCompare(right.sku))
}

export function hasStockThresholdBreach(
  imsQty: number,
  wmsQty: number,
  thresholds: StockThresholdConfig,
): boolean {
  const absoluteDelta = Math.abs(wmsQty - imsQty)
  const maxQty = Math.max(Math.abs(imsQty), Math.abs(wmsQty))
  const percentDelta = maxQty > 0 ? (absoluteDelta / maxQty) * 100 : 0
  if (thresholds.absoluteDelta != null && absoluteDelta >= thresholds.absoluteDelta) return true
  if (thresholds.percentDelta != null && percentDelta >= thresholds.percentDelta) return true
  return false
}

// --- Pure stock diff (NOTIFICATION_ONLY detection) -------------------------

export type StockDiscrepancyCategory = 'QTY_MISMATCH' | 'UNMAPPED_SKU' | 'MISSING_IN_WMS'

export type StockDiscrepancyFinding = {
  category: StockDiscrepancyCategory
  sku: string
  productId: string | null
  imsQty: number | null
  wmsQty: number | null
  delta: number | null
}

/**
 * Compare consolidated WMS stock lines against IMS products + stock for a warehouse.
 * Pure: callers supply the SKU→product map and product→IMS-qty map. Produces
 * NOTIFICATION_ONLY findings:
 *  - UNMAPPED_SKU: a WMS line whose SKU has no IMS product.
 *  - QTY_MISMATCH: a mapped SKU whose WMS qty differs from IMS qty.
 *  - MISSING_IN_WMS: an IMS product (with non-zero stock) absent from the WMS feed.
 */
export function computeStockDiscrepancies(input: {
  wmsLines: WmsStockLine[]
  productBySku: Map<string, { id: string }>
  imsQtyByProductId: Map<string, number>
  imsSkusByProductId?: Map<string, string>
}): StockDiscrepancyFinding[] {
  const findings: StockDiscrepancyFinding[] = []
  const seenProductIds = new Set<string>()

  for (const line of input.wmsLines) {
    const product = input.productBySku.get(line.sku)
    if (!product) {
      findings.push({ category: 'UNMAPPED_SKU', sku: line.sku, productId: null, imsQty: null, wmsQty: line.quantity, delta: null })
      continue
    }
    seenProductIds.add(product.id)
    const imsQty = input.imsQtyByProductId.get(product.id) ?? 0
    if (imsQty !== line.quantity) {
      findings.push({
        category: 'QTY_MISMATCH',
        sku: line.sku,
        productId: product.id,
        imsQty,
        wmsQty: line.quantity,
        delta: line.quantity - imsQty,
      })
    }
  }

  // IMS products with non-zero stock the WMS feed never mentioned.
  for (const [productId, imsQty] of input.imsQtyByProductId) {
    if (seenProductIds.has(productId) || imsQty === 0) continue
    findings.push({
      category: 'MISSING_IN_WMS',
      sku: input.imsSkusByProductId?.get(productId) ?? '',
      productId,
      imsQty,
      wmsQty: 0,
      delta: -imsQty,
    })
  }

  return findings.sort((a, b) => a.sku.localeCompare(b.sku))
}
