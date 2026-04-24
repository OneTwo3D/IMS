/**
 * Generic shopping facade — core code imports ONLY from here, never from connector modules.
 */

import type { StockSyncReason } from '@/app/generated/prisma/enums'
import type { ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import type { DeliveryStatus, StockUpdate } from '@/lib/connectors/types'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getShoppingConnector, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { getShopifySettings } from '@/lib/connectors/shopify/settings'

type StockCandidateProduct = {
  id: string
  sku: string
  type: ProductType
  lifecycleStatus: ProductLifecycleStatus
  productComponents: Array<{
    componentId: string
    qty: unknown
    component: {
      type: ProductType
      lifecycleStatus: ProductLifecycleStatus
    }
  }>
}

export type PushProductMetadataResult = { success: boolean; skipped?: boolean; error?: string }
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

function computeKitAvailability(
  product: StockCandidateProduct,
  warehouseIds: string[],
  stockByProductWarehouse: Map<string, Map<string, number>>,
  productById: Map<string, StockCandidateProduct>,
  memo: Map<string, number>,
  stack: Set<string>,
): number {
  if (memo.has(product.id)) return memo.get(product.id) ?? 0
  if (product.productComponents.length === 0) {
    memo.set(product.id, 0)
    return 0
  }
  if (stack.has(product.id)) {
    memo.set(product.id, 0)
    return 0
  }

  stack.add(product.id)

  let total = 0
  for (const warehouseId of warehouseIds) {
    let kitsInWarehouse = Number.POSITIVE_INFINITY

    for (const component of product.productComponents) {
      const required = Number(component.qty)
      if (!Number.isFinite(required) || required <= 0 || component.component.lifecycleStatus === 'ARCHIVED') {
        kitsInWarehouse = 0
        break
      }

      let available = Math.max(0, stockByProductWarehouse.get(component.componentId)?.get(warehouseId) ?? 0)
      if (component.component.type === 'KIT') {
        const nested = productById.get(component.componentId)
        available = nested
          ? computeKitAvailability(nested, [warehouseId], stockByProductWarehouse, productById, memo, stack)
          : 0
      }

      kitsInWarehouse = Math.min(kitsInWarehouse, Math.floor(available / required))
    }

    total += Number.isFinite(kitsInWarehouse) ? kitsInWarehouse : 0
  }

  stack.delete(product.id)
  memo.set(product.id, total)
  return total
}

async function buildShoppingStockUpdates(
  productIds?: string[],
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<StockUpdate[]> {
  const { db } = await import('@/lib/db')

  const warehouses = await db.warehouse.findMany({
    where: { syncToStore: true, active: true },
    select: { id: true },
  })
  if (warehouses.length === 0) return []

  const warehouseIds = warehouses.map((warehouse) => warehouse.id)
  const scopedProductIds = productIds && productIds.length > 0 ? [...new Set(productIds)] : null

  const scopedComponentIds = scopedProductIds
    ? [
        ...new Set(
          (
            await db.productComponent.findMany({
              where: { productId: { in: scopedProductIds } },
              select: { componentId: true },
            })
          ).map((row) => row.componentId),
        ),
      ]
    : []
  const scopedStockProductIds = scopedProductIds
    ? [...new Set([...scopedProductIds, ...scopedComponentIds])]
    : null

  const stockLevels = await db.stockLevel.findMany({
    where: {
      warehouseId: { in: warehouseIds },
      ...(scopedStockProductIds ? { productId: { in: scopedStockProductIds } } : {}),
    },
    select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
  })

  const stockByProduct = new Map<string, number>()
  const stockByProductWarehouse = new Map<string, Map<string, number>>()
  for (const stockLevel of stockLevels) {
    const available = Math.max(0, Number(stockLevel.quantity) - Number(stockLevel.reservedQty))
    stockByProduct.set(stockLevel.productId, (stockByProduct.get(stockLevel.productId) ?? 0) + available)

    const byWarehouse = stockByProductWarehouse.get(stockLevel.productId) ?? new Map<string, number>()
    byWarehouse.set(stockLevel.warehouseId, available)
    stockByProductWarehouse.set(stockLevel.productId, byWarehouse)
  }

  const physicalProductIds = [...new Set(stockLevels.map((stockLevel) => stockLevel.productId))]
  const rawProducts = await db.product.findMany({
    where: {
      lifecycleStatus: { in: ['ACTIVE', 'NOT_FOR_SALE', 'ARCHIVED'] },
      sku: { not: '' },
      ...(scopedProductIds
        ? {
            OR: [
              { id: { in: scopedProductIds } },
              { type: 'KIT', productComponents: { some: { componentId: { in: scopedProductIds } } } },
            ],
          }
        : {
            OR: [
              { id: { in: physicalProductIds } },
              { type: 'KIT', productComponents: { some: {} } },
            ],
          }),
    },
    select: {
      id: true,
      sku: true,
      type: true,
      lifecycleStatus: true,
      productComponents: {
        select: {
          componentId: true,
          qty: true,
          component: { select: { type: true, lifecycleStatus: true } },
        },
      },
    },
  })

  const products = rawProducts
    .filter((product) => product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY') as StockCandidateProduct[]
  const productById = new Map(products.map((product) => [product.id, product]))
  const kitAvailabilityMemo = new Map<string, number>()

  return products.map((product) => {
    const computedQuantity = product.type === 'KIT'
      ? computeKitAvailability(
          product,
          warehouseIds,
          stockByProductWarehouse,
          productById,
          kitAvailabilityMemo,
          new Set<string>(),
        )
      : (stockByProduct.get(product.id) ?? 0)

    return {
      sku: product.sku,
      productId: product.id,
      quantity: options?.force && product.lifecycleStatus === 'ARCHIVED' ? 0 : computedQuantity,
    }
  })
}

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

export async function syncShoppingConnectorStock(
  connector: ShoppingConnectorId,
  productIds?: string[],
  options?: { force?: boolean; webhookQty?: number | null },
) {
  switch (connector) {
    case 'woocommerce': {
      const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
      return pushStockToWc({
        productIds: productIds && productIds.length > 0 ? [...new Set(productIds)] : undefined,
        forceAll: !productIds || productIds.length === 0,
        forceProductIds: options?.force && productIds ? [...new Set(productIds)] : [],
        source: options?.webhookQty != null ? 'WC_WEBHOOK' : 'MANUAL',
      })
    }
    case 'shopify': {
      const shopifySettings = await getShopifySettings()
      if (shopifySettings.shopify_sync_enabled !== 'true') {
        return { synced: 0, errors: ['Shopify sync is disabled in settings'] }
      }

      const updates = await buildShoppingStockUpdates(productIds, options)
      if (updates.length === 0) {
        return { synced: 0, errors: ['No stocked products with syncable SKUs were found'] }
      }

      const { syncStock } = await import('@/lib/connectors/shopify')
      return syncStock(updates)
    }
  }
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
      case 'shopify': {
        await syncShoppingConnectorStock('shopify', productIds, options)
        return
      }
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
        return { connector, result: { success: true, skipped: true } }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !('skipped' in entry.result && entry.result.skipped))
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${'error' in entry.result ? (entry.result.error ?? 'unknown error') : 'unknown error'}`).join('; '),
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
        return { connector, result: { success: true, skipped: true } }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !('skipped' in entry.result && entry.result.skipped))
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${'error' in entry.result ? (entry.result.error ?? 'unknown error') : 'unknown error'}`).join('; '),
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
      case 'shopify': {
        const { hasShopifyProductExternalLink } = await import('@/lib/connectors/shopify/links')
        if (await hasShopifyProductExternalLink(productId)) return true
        break
      }
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
  const pluginState = await getIntegrationPluginState()
  if (!pluginState[connector]) {
    return Response.json({ error: `${getShoppingConnector(connector).label} plugin is disabled` }, { status: 423 })
  }

  switch (connector) {
    case 'woocommerce': {
      const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
      return handleWcWebhook(resource, request)
    }
    case 'shopify': {
      const { handleWebhook } = await import('@/lib/connectors/shopify')
      return handleWebhook(request, resource)
    }
  }
}
