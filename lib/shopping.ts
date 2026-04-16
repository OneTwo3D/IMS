/**
 * Generic shopping facade — core code imports ONLY from here, never from connector modules.
 */

import type { StockSyncReason } from '@/app/generated/prisma/enums'
import type { DeliveryStatus } from '@/lib/connectors/types'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getShoppingConnector, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { getShopifySettings } from '@/lib/connectors/shopify/settings'

export type PushProductMetadataResult = { success: boolean; error?: string }
export type PushOrderDeliveryMetadataResult = { success: boolean; skipped?: boolean; error?: string }
export type ShoppingConnectorInfo = { id: ShoppingConnectorId; name: string }
export type ShoppingWebhookResource = 'orders' | 'products' | 'refunds'
export type ShoppingExternalLink = {
  connectorId: ShoppingConnectorId
  connectorName: string
  label: string
  url: string
}
export type ShoppingProductLinkResult = { link: ShoppingExternalLink | null; error?: string }

async function listConfiguredShoppingConnectorIds(): Promise<ShoppingConnectorId[]> {
  const { db } = await import('@/lib/db')
  const [pluginState, url, key, secret, shopifySettings] = await Promise.all([
    getIntegrationPluginState(),
    db.setting.findUnique({ where: { key: 'wc_url' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_key' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_secret' } }),
    getShopifySettings(),
  ])

  const connectors: ShoppingConnectorId[] = []
  if (pluginState.woocommerce && url?.value && key?.value && secret?.value) connectors.push('woocommerce')
  if (pluginState.shopify && shopifySettings.shopify_store_domain && shopifySettings.shopify_admin_api_access_token) connectors.push('shopify')
  return connectors
}

async function listRunnableShoppingConnectorIds(): Promise<ShoppingConnectorId[]> {
  const configured = await listConfiguredShoppingConnectorIds()
  return configured.filter((id) => getShoppingConnector(id).available)
}

export async function listActiveShoppingConnectorInfo(): Promise<ShoppingConnectorInfo[]> {
  const connectors = await listConfiguredShoppingConnectorIds()
  return connectors.map((connector) => ({
    id: connector,
    name: getShoppingConnector(connector).label,
  }))
}

export async function getActiveShoppingConnectorInfo(): Promise<ShoppingConnectorInfo | null> {
  const connectors = await listActiveShoppingConnectorInfo()
  return connectors[0] ?? null
}

export async function enqueueStockSync(
  productIds: string[],
  reason: Extract<StockSyncReason, 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL'>,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<void> {
  const connectors = await listRunnableShoppingConnectorIds()
  await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { enqueueAndProcessImmediateWcStockSync } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')
        await enqueueAndProcessImmediateWcStockSync(productIds, reason, options)
        return
      }
      case 'shopify':
        return
    }
  }))
}

export async function pushProductMetadata(productId: string): Promise<PushProductMetadataResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
        return { connector, result: await pushImsProductToWc(productId) }
      }
      case 'shopify':
        return { connector, result: { success: false, error: 'Shopify product sync is not implemented yet' } }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success)
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${entry.result.error ?? 'unknown error'}`).join('; '),
    }
  }

  return { success: true }
}

export async function pushOrderDeliveryMetadata(orderId: string): Promise<PushOrderDeliveryMetadataResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushImsTrackingToWc } = await import('@/lib/connectors/woocommerce/sync/tracking-sync')
        return { connector, result: await pushImsTrackingToWc(orderId) }
      }
      case 'shopify':
        return { connector, result: { success: false, error: 'Shopify delivery metadata sync is not implemented yet' } }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !('skipped' in entry.result && entry.result.skipped))
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${entry.result.error ?? 'unknown error'}`).join('; '),
    }
  }

  return { success: true, skipped: results.every((entry) => 'skipped' in entry.result && !!entry.result.skipped) }
}

export async function getOrderDeliveryStatus(orderId: string): Promise<DeliveryStatus | null> {
  const connectors = await listConfiguredShoppingConnectorIds()
  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcDeliveryStatusForSalesOrder } = await import('@/lib/connectors/woocommerce/delivery')
        const status = await getWcDeliveryStatusForSalesOrder(orderId)
        if (status) return status
        break
      }
      case 'shopify': {
        const { getDeliveryStatus } = await import('@/lib/connectors/shopify')
        const status = await getDeliveryStatus(orderId)
        if (status) return status
        break
      }
    }
  }
  return null
}

export async function getExternalProductLinks(sku: string): Promise<{ links: ShoppingExternalLink[]; errors: string[] }> {
  const connectors = await listConfiguredShoppingConnectorIds()
  const links: ShoppingExternalLink[] = []
  const errors: string[] = []

  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
        const result = await getWcProductExternalLink(sku)
        if (result.link) links.push(result.link)
        else if (result.error) errors.push(`WooCommerce: ${result.error}`)
        break
      }
      case 'shopify': {
        const { getProductLink } = await import('@/lib/connectors/shopify')
        const result = await getProductLink(sku)
        if (result.link) links.push(result.link)
        else if (result.error) errors.push(`Shopify: ${result.error}`)
        break
      }
    }
  }

  return { links, errors }
}

export async function getExternalProductLink(sku: string): Promise<ShoppingProductLinkResult> {
  const { links, errors } = await getExternalProductLinks(sku)
  if (links[0]) return { link: links[0] }
  return { link: null, error: errors[0] ?? 'No shopping connector configured' }
}

export async function hasExternalProductLink(productId: string): Promise<boolean> {
  const connectors = await listConfiguredShoppingConnectorIds()
  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { hasWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
        if (await hasWcProductExternalLink(productId)) return true
        break
      }
      case 'shopify':
        break
    }
  }
  return false
}

export async function getSalesOrderAdminLinks(orderId: string): Promise<ShoppingExternalLink[]> {
  const connectors = await listConfiguredShoppingConnectorIds()
  const links: ShoppingExternalLink[] = []

  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcSalesOrderAdminLink } = await import('@/lib/connectors/woocommerce/links')
        const link = await getWcSalesOrderAdminLink(orderId)
        if (link) links.push(link)
        break
      }
      case 'shopify': {
        const { getOrderAdminLink } = await import('@/lib/connectors/shopify')
        const link = await getOrderAdminLink(orderId)
        if (link) links.push(link)
        break
      }
    }
  }

  return links
}

export async function getSalesOrderAdminLink(orderId: string): Promise<ShoppingExternalLink | null> {
  const links = await getSalesOrderAdminLinks(orderId)
  return links[0] ?? null
}

export async function handleShoppingWebhook(connector: ShoppingConnectorId, resource: ShoppingWebhookResource, request: Request) {
  switch (connector) {
    case 'woocommerce': {
      const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
      return handleWcWebhook(resource, request)
    }
    case 'shopify': {
      const { handleWebhook } = await import('@/lib/connectors/shopify')
      return handleWebhook()
    }
  }
}
