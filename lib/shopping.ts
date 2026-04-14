/**
 * Generic shopping facade — core code imports ONLY from here, never from connector modules.
 * Currently delegates to WooCommerce. In future, this can route by a shopping_connector setting.
 */

import type { StockSyncReason } from '@/app/generated/prisma/enums'

type ActiveShoppingConnector = 'woocommerce'

export type PushProductMetadataResult = { success: boolean; error?: string }

async function getActiveShoppingConnector(): Promise<ActiveShoppingConnector | null> {
  const { db } = await import('@/lib/db')
  const [url, key, secret] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_url' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_key' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_secret' } }),
  ])
  return url?.value && key?.value && secret?.value ? 'woocommerce' : null
}

export async function enqueueStockSync(
  productIds: string[],
  reason: Extract<StockSyncReason, 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL'>,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<void> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return

  switch (connector) {
    case 'woocommerce': {
      const { enqueueAndProcessImmediateWcStockSync } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')
      return enqueueAndProcessImmediateWcStockSync(productIds, reason, options)
    }
  }
}

export async function pushProductMetadata(productId: string): Promise<PushProductMetadataResult> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return { success: false, error: 'No shopping connector configured' }

  switch (connector) {
    case 'woocommerce': {
      const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
      return pushImsProductToWc(productId)
    }
  }
}
