import type { StockSyncReason } from '@/app/generated/prisma/enums'

export type WcStockSyncOutboxPayload = {
  productId: string
  reason: StockSyncReason
  force: boolean
  webhookQty: number | null
}

const WC_STOCK_SYNC_REASONS: StockSyncReason[] = [
  'IMS_CHANGE',
  'WC_WEBHOOK',
  'DAILY_RECONCILIATION',
  'MANUAL',
]

function hasForcedWcStockSyncPayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { force?: unknown }).force === true
}

export function buildWcStockSyncOutboxPayload(
  productId: string,
  reason: StockSyncReason,
  options?: { force?: boolean; webhookQty?: number | null },
  existingPayload?: unknown,
): WcStockSyncOutboxPayload {
  return {
    productId,
    reason,
    force: options?.force === true || hasForcedWcStockSyncPayload(existingPayload),
    webhookQty: options?.webhookQty ?? null,
  }
}

function isStockSyncReason(value: unknown): value is StockSyncReason {
  return typeof value === 'string' && WC_STOCK_SYNC_REASONS.includes(value as StockSyncReason)
}

export function parseWcStockSyncPayload(row: { id: string; payloadJson: unknown }): WcStockSyncOutboxPayload {
  const payload = row.payloadJson
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} must be an object`)
  }
  const data = payload as Record<string, unknown>
  if (typeof data.productId !== 'string' || !data.productId.trim()) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} is missing productId`)
  }
  if (!isStockSyncReason(data.reason)) {
    throw new Error(`WooCommerce stock outbox payload for ${row.id} has invalid reason`)
  }
  return {
    productId: data.productId,
    reason: data.reason,
    force: data.force === true,
    webhookQty: typeof data.webhookQty === 'number' ? data.webhookQty : null,
  }
}
