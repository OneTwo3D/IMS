import { Prisma } from '@/app/generated/prisma/client'
import type { WmsStockLine } from '@/lib/connectors/wms/types'

type ThresholdConfig = {
  absoluteDelta: number | null
  percentDelta: number | null
}

export type MintsoftMissingInWmsCandidate = {
  productId: string
  sku: string
  imsQty: number
  lastExternalQty: number | null
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

export function parseMintsoftThresholds(value: Prisma.JsonValue | null | undefined): ThresholdConfig {
  const record = asRecord(value)
  return {
    absoluteDelta: parseNumber(record?.absoluteDelta) ?? null,
    percentDelta: parseNumber(record?.percentDelta) ?? null,
  }
}

export function sanitizeMintsoftThresholds(input: {
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

  return {
    absoluteDelta,
    percentDelta,
  } satisfies Prisma.InputJsonObject
}

export function isMintsoftBindingDue(
  lastStockSyncAt: Date | null,
  syncFrequencyMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!lastStockSyncAt) return true
  const dueAt = lastStockSyncAt.getTime() + (Math.max(1, syncFrequencyMinutes) * 60_000)
  return now.getTime() >= dueAt
}

export function consolidateMintsoftStockLines(lines: WmsStockLine[]): WmsStockLine[] {
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

export function hasMintsoftThresholdBreach(
  imsQty: number,
  wmsQty: number,
  thresholds: ThresholdConfig,
): boolean {
  const absoluteDelta = Math.abs(wmsQty - imsQty)
  const maxQty = Math.max(Math.abs(imsQty), Math.abs(wmsQty))
  const percentDelta = maxQty > 0 ? (absoluteDelta / maxQty) * 100 : 0

  if (thresholds.absoluteDelta != null && absoluteDelta >= thresholds.absoluteDelta) return true
  if (thresholds.percentDelta != null && percentDelta >= thresholds.percentDelta) return true
  return false
}

export function collectMissingInWmsCandidates(input: {
  returnedSkus: Iterable<string>
  snapshots: Array<{
    productId: string
    sku: string
    externalQty: number
  }>
  stockLevels: Array<{
    productId: string
    sku: string
    quantity: number
  }>
}): MintsoftMissingInWmsCandidate[] {
  const returnedSkus = new Set(Array.from(input.returnedSkus))
  const byProductId = new Map<string, MintsoftMissingInWmsCandidate>()

  for (const snapshot of input.snapshots) {
    if (returnedSkus.has(snapshot.sku)) continue

    byProductId.set(snapshot.productId, {
      productId: snapshot.productId,
      sku: snapshot.sku,
      imsQty: 0,
      lastExternalQty: snapshot.externalQty,
    })
  }

  for (const stockLevel of input.stockLevels) {
    if (returnedSkus.has(stockLevel.sku)) continue

    const existing = byProductId.get(stockLevel.productId)
    if (existing) {
      existing.imsQty = stockLevel.quantity
      existing.sku = stockLevel.sku
      continue
    }

    byProductId.set(stockLevel.productId, {
      productId: stockLevel.productId,
      sku: stockLevel.sku,
      imsQty: stockLevel.quantity,
      lastExternalQty: null,
    })
  }

  return Array.from(byProductId.values())
    .filter((candidate) => (
      candidate.imsQty !== 0
      || (candidate.lastExternalQty != null && candidate.lastExternalQty !== 0)
    ))
    .sort((left, right) => left.sku.localeCompare(right.sku))
}
