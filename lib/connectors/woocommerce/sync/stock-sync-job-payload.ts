import type { StockSyncReason } from '@/app/generated/prisma/enums'
import {
  INTEGRATION_OUTBOX_OPERATIONS,
  parseIntegrationOutboxPayload,
  type WcStockSyncOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'

export type { WcStockSyncOutboxPayload }

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

export function parseWcStockSyncPayload(row: { id: string; payloadJson: unknown }): WcStockSyncOutboxPayload {
  return parseIntegrationOutboxPayload<WcStockSyncOutboxPayload>({
    connector: 'woocommerce',
    operation: INTEGRATION_OUTBOX_OPERATIONS.woocommerce.stockSync,
    payloadJson: row.payloadJson,
    rowId: row.id,
  })
}
