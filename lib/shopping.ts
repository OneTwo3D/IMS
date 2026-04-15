/**
 * Generic shopping facade — core code imports ONLY from here, never from connector modules.
 * Currently delegates to WooCommerce. In future, this can route by a shopping_connector setting.
 */

import type { StockSyncReason } from '@/app/generated/prisma/enums'
import type { DeliveryStatus } from '@/lib/connectors/types'

type ActiveShoppingConnector = 'woocommerce'

export type PushProductMetadataResult = { success: boolean; error?: string }
export type PushOrderDeliveryMetadataResult = { success: boolean; skipped?: boolean; error?: string }
export type ShoppingConnectorInfo = { id: ActiveShoppingConnector; name: string }
export type ShoppingWebhookResource = 'orders' | 'products' | 'refunds'
export type ShoppingExternalLink = {
  connectorId: ActiveShoppingConnector
  connectorName: string
  label: string
  url: string
}
export type ShoppingProductLinkResult = { link: ShoppingExternalLink | null; error?: string }

async function getActiveShoppingConnector(): Promise<ActiveShoppingConnector | null> {
  const { db } = await import('@/lib/db')
  const [url, key, secret] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_url' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_key' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_secret' } }),
  ])
  return url?.value && key?.value && secret?.value ? 'woocommerce' : null
}

export async function getActiveShoppingConnectorInfo(): Promise<ShoppingConnectorInfo | null> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return null

  switch (connector) {
    case 'woocommerce':
      return { id: connector, name: 'WooCommerce' }
  }
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

export async function pushOrderDeliveryMetadata(orderId: string): Promise<PushOrderDeliveryMetadataResult> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return { success: false, error: 'No shopping connector configured' }

  switch (connector) {
    case 'woocommerce': {
      const { pushImsTrackingToWc } = await import('@/lib/connectors/woocommerce/sync/tracking-sync')
      return pushImsTrackingToWc(orderId)
    }
  }
}

export async function getOrderDeliveryStatus(orderId: string): Promise<DeliveryStatus | null> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return null

  switch (connector) {
    case 'woocommerce': {
      const { getWcDeliveryStatusForSalesOrder } = await import('@/lib/connectors/woocommerce/delivery')
      return getWcDeliveryStatusForSalesOrder(orderId)
    }
  }
}

export async function getExternalProductLink(sku: string): Promise<ShoppingProductLinkResult> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return { link: null, error: 'No shopping connector configured' }

  switch (connector) {
    case 'woocommerce': {
      const { getWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
      return getWcProductExternalLink(sku)
    }
  }
}

export async function hasExternalProductLink(productId: string): Promise<boolean> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return false

  switch (connector) {
    case 'woocommerce': {
      const { hasWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
      return hasWcProductExternalLink(productId)
    }
  }
}

export async function getSalesOrderAdminLink(orderId: string): Promise<ShoppingExternalLink | null> {
  const connector = await getActiveShoppingConnector()
  if (!connector) return null

  switch (connector) {
    case 'woocommerce': {
      const { getWcSalesOrderAdminLink } = await import('@/lib/connectors/woocommerce/links')
      return getWcSalesOrderAdminLink(orderId)
    }
  }
}

export async function handleShoppingWebhook(resource: ShoppingWebhookResource, request: Request) {
  const connector = await getActiveShoppingConnector()
  if (!connector) {
    return Response.json({ error: 'No shopping connector configured' }, { status: 503 })
  }

  switch (connector) {
    case 'woocommerce': {
      const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
      return handleWcWebhook(resource, request)
    }
  }
}
