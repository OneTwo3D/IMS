import type { DeliveryStatus } from '@/lib/connectors/types'
import { notImplementedResult } from '@/lib/connectors/not-implemented'
import { getShopifySettings } from './settings'

const CONNECTOR = 'Shopify'

export async function isConfigured() {
  const settings = await getShopifySettings()
  return Boolean(settings.shopify_store_domain && settings.shopify_admin_api_access_token)
}

export async function fetchOrders() {
  return notImplementedResult('order sync', CONNECTOR)
}

export async function fetchProducts() {
  return notImplementedResult('product sync', CONNECTOR)
}

export async function syncStock() {
  return notImplementedResult('stock sync', CONNECTOR)
}

export async function handleWebhook() {
  return Response.json(notImplementedResult('webhook handling', CONNECTOR), { status: 501 })
}

export async function getProductLink(_sku: string) {
  return { link: null, error: `${CONNECTOR} product linking is not implemented yet` }
}

export async function getOrderAdminLink(_orderId: string) {
  return null
}

export async function getDeliveryStatus(_orderId: string): Promise<DeliveryStatus | null> {
  return null
}
