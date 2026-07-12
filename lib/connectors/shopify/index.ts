import type { DeliveryStatus, ExternalOrder, ExternalProduct, StockUpdate } from '@/lib/connectors/types'
import type { ShoppingProductLinkResult, ShoppingWebhookResource } from '@/lib/shopping'
import { notImplementedResult } from '@/lib/connectors/not-implemented'
import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import {
  createShoppingWebhookEventRepository,
  persistShopifyWebhookEvent,
  type PersistShoppingWebhookEventResult,
  type ShoppingWebhookEventRepository,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import { getShopifyDeliveryStatusForSalesOrder } from './delivery'
import { extractShopifyLegacyResourceId, getShopifyCredentials, shopifyGraphql, verifyShopifyWebhookSignature } from './api'
import { getShopifyProductExternalLink, getShopifySalesOrderAdminLink } from './links'
import { getShopifySettings } from './settings'

const CONNECTOR = 'Shopify'
const MAX_SHOPIFY_WEBHOOK_EXTERNAL_EVENT_ID_LENGTH = 256
const SHOPIFY_WEBHOOK_NOT_IMPLEMENTED_MESSAGE =
  'Shopify webhook processing is not implemented yet; delivery was acknowledged without mutating IMS data'

type ShopifyOrdersResponse = {
  orders: {
    pageInfo: {
      hasNextPage: boolean
      endCursor: string | null
    }
    nodes: Array<{
      id: string
      legacyResourceId: string | number | null
      name: string
      displayFinancialStatus: string | null
      displayFulfillmentStatus: string | null
      createdAt: string
      currentTotalPriceSet: {
        shopMoney: {
          amount: string
          currencyCode: string
        }
      } | null
      customer: {
        displayName: string | null
        email: string | null
      } | null
      shippingLine: {
        title: string | null
      } | null
      note: string | null
      shippingAddress: ShopifyMailingAddress | null
      billingAddress: ShopifyMailingAddress | null
      shippingLines: {
        nodes: Array<{
          priceSet: {
            shopMoney: {
              amount: string
            }
          } | null
        }>
      }
      lineItems: {
        nodes: Array<{
          id: string
          sku: string | null
          name: string
          quantity: number
          discountedTotalSet: {
            shopMoney: {
              amount: string
            }
          } | null
          originalUnitPriceSet: {
            shopMoney: {
              amount: string
            }
          } | null
        }>
      }
    }>
  }
}

type ShopifyOrdersPageResult = {
  nodes: ShopifyOrdersResponse['orders']['nodes']
  endCursor: string | null
  hasNextPage: boolean
}

type ShopifyMailingAddress = {
  address1?: string | null
  address2?: string | null
  city?: string | null
  company?: string | null
  country?: string | null
  countryCodeV2?: string | null
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  phone?: string | null
  province?: string | null
  zip?: string | null
}

type ShopifyProductsResponse = {
  productVariants: {
    nodes: Array<{
      id: string
      legacyResourceId: string | number | null
      sku: string | null
      title: string
      price: string | null
      compareAtPrice: string | null
      product: {
        title: string
        status: string
        onlineStoreUrl?: string | null
      } | null
    }>
  }
}

type ShopifyInventoryVariantLookupResponse = {
  productVariants: {
    nodes: Array<{
      sku: string | null
      inventoryQuantity: number | null
      inventoryItem: {
        id: string
      } | null
    }>
  }
}

type ShopifyLocationsResponse = {
  locations: {
    nodes: Array<{
      id: string
      isActive: boolean
    }>
  }
}

type ShopifyInventoryAdjustResponse = {
  inventoryAdjustQuantities: {
    userErrors: Array<{
      message: string
    }>
  }
}

function mapShopifyOrderStatus(order: ShopifyOrdersResponse['orders']['nodes'][number]): string {
  return order.displayFulfillmentStatus ?? order.displayFinancialStatus ?? 'unknown'
}

function parseAmount(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function recordShopifySyncLog(data: {
  direction: 'TO_CONNECTOR' | 'FROM_CONNECTOR'
  status: 'SYNCED' | 'FAILED'
  entityType: string
  entityId?: string | null
  externalId?: string | null
  payload?: unknown
  errorMessage?: string | null
  syncedAt?: Date | null
}) {
  await db.shoppingSyncLog.create({
    data: {
      connector: 'shopify',
      direction: data.direction,
      status: data.status,
      entityType: data.entityType,
      entityId: data.entityId ?? null,
      externalId: data.externalId ?? null,
      payload: data.payload ? JSON.parse(JSON.stringify(data.payload)) : undefined,
      errorMessage: data.errorMessage ?? null,
      syncedAt: data.syncedAt ?? (data.status === 'SYNCED' ? new Date() : null),
    },
  })
}

async function getSingleActiveLocationId() {
  const { data, error } = await shopifyGraphql<ShopifyLocationsResponse>(
    `
      query ShopifyActiveLocations {
        locations(first: 10) {
          nodes {
            id
            isActive
          }
        }
      }
    `,
  )

  if (error) return { locationId: null, error }

  const activeLocations = data?.locations.nodes.filter((location) => location.isActive) ?? []
  if (activeLocations.length === 0) {
    return { locationId: null, error: 'Shopify has no active inventory location available for stock sync' }
  }

  if (activeLocations.length > 1) {
    return {
      locationId: null,
      error: 'Shopify stock sync needs a connector-specific location mapping before multi-location stores can be synced safely',
    }
  }

  return { locationId: activeLocations[0]?.id ?? null }
}

async function fetchShopifyOrdersPage(params: {
  perPage: number
  after?: string | null
  query?: string | null
}): Promise<{ page: ShopifyOrdersPageResult | null; error?: string }> {
  const { data, error } = await shopifyGraphql<ShopifyOrdersResponse>(
    `
      query ShopifyOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, reverse: true) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            legacyResourceId
            name
            displayFinancialStatus
            displayFulfillmentStatus
            createdAt
            note
            shippingAddress {
              address1
              address2
              city
              company
              country
              countryCodeV2
              firstName
              lastName
              name
              phone
              province
              zip
            }
            billingAddress {
              address1
              address2
              city
              company
              country
              countryCodeV2
              firstName
              lastName
              name
              phone
              province
              zip
            }
            customer {
              displayName
              email
            }
            shippingLine {
              title
            }
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            shippingLines(first: 10) {
              nodes {
                priceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
            lineItems(first: 100) {
              nodes {
                id
                sku
                name
                quantity
                discountedTotalSet {
                  shopMoney {
                    amount
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
        }
      }
    `,
    { first: params.perPage, after: params.after ?? null, query: params.query ?? null },
  )

  if (error) return { page: null, error }

  return {
    page: {
      nodes: data?.orders.nodes ?? [],
      endCursor: data?.orders.pageInfo.endCursor ?? null,
      hasNextPage: data?.orders.pageInfo.hasNextPage ?? false,
    },
  }
}

export async function isConfigured() {
  const settings = await getShopifySettings()
  return Boolean(settings.shopify_store_domain && settings.shopify_admin_api_access_token)
}

export async function fetchOrders(params: { status?: string; after?: string; page?: number; perPage?: number } = {}) {
  const requestedPage = Math.max(params.page ?? 1, 1)
  const first = Math.min(Math.max(params.perPage ?? 25, 1), 100)
  const filters = [
    params.status ? `status:${params.status}` : null,
  ].filter(Boolean).join(' ')

  let cursor: string | null | undefined = requestedPage === 1 ? params.after : null
  let currentPage = 1
  let totalPages = 0
  let currentNodes: ShopifyOrdersResponse['orders']['nodes'] = []

  while (true) {
    const { page, error } = await fetchShopifyOrdersPage({
      perPage: first,
      after: cursor,
      query: filters || null,
    })

    if (error) return { orders: [] as ExternalOrder[], totalPages: 0, error }
    if (!page) return { orders: [] as ExternalOrder[], totalPages: 0, error: 'Shopify orders page could not be read' }

    totalPages = currentPage
    if (currentPage === requestedPage) {
      currentNodes = page.nodes
    }

    if (!page.hasNextPage) break

    cursor = page.endCursor
    currentPage += 1
  }

  if (requestedPage > totalPages) {
    return { orders: [], totalPages }
  }

  const orders = currentNodes.map<ExternalOrder>((order) => ({
    externalId: extractShopifyLegacyResourceId(order.legacyResourceId) ?? order.id,
    orderNumber: order.name,
    status: mapShopifyOrderStatus(order),
    currency: order.currentTotalPriceSet?.shopMoney.currencyCode ?? 'GBP',
    total: parseAmount(order.currentTotalPriceSet?.shopMoney.amount),
    dateCreated: order.createdAt,
    customerName: order.customer?.displayName ?? 'Unknown customer',
    customerEmail: order.customer?.email ?? undefined,
    billingAddress: order.billingAddress ?? undefined,
    shippingAddress: order.shippingAddress ?? undefined,
    shippingTotal: order.shippingLines.nodes.reduce((sum, line) => sum + parseAmount(line.priceSet?.shopMoney.amount), 0),
    shippingService: order.shippingLine?.title ?? undefined,
    notes: order.note ?? undefined,
    lineItems: order.lineItems.nodes.map((line) => ({
      externalLineId: extractShopifyLegacyResourceId(line.id) ?? line.id,
      sku: line.sku ?? '',
      name: line.name,
      quantity: line.quantity,
      unitPrice: parseAmount(line.originalUnitPriceSet?.shopMoney.amount),
      total: parseAmount(line.discountedTotalSet?.shopMoney.amount),
    })),
  }))

  return {
    orders,
    totalPages,
  }
}

export async function fetchProducts(params: { query?: string; after?: string; perPage?: number } = {}) {
  const first = Math.min(Math.max(params.perPage ?? 25, 1), 100)
  const query = params.query?.trim() || null

  const { data, error } = await shopifyGraphql<ShopifyProductsResponse>(
    `
      query ShopifyProductVariants($first: Int!, $query: String) {
        productVariants(first: $first, query: $query) {
          nodes {
            id
            legacyResourceId
            sku
            title
            price
            compareAtPrice
            product {
              title
              status
              onlineStoreUrl
            }
          }
        }
      }
    `,
    { first, query },
  )

  if (error) return { products: [] as ExternalProduct[], error }

  const products = (data?.productVariants.nodes ?? []).map<ExternalProduct>((variant) => {
    const currentPrice = parseAmount(variant.price)
    const compareAtPrice = parseAmount(variant.compareAtPrice)

    return {
      externalId: extractShopifyLegacyResourceId(variant.legacyResourceId) ?? variant.id,
      sku: variant.sku ?? '',
      name: variant.product ? `${variant.product.title}${variant.title === 'Default Title' ? '' : ` - ${variant.title}`}` : variant.title,
      price: compareAtPrice || currentPrice,
      salePrice: compareAtPrice > currentPrice ? currentPrice : undefined,
      permalink: variant.product?.onlineStoreUrl ?? undefined,
      status: variant.product?.status ?? 'UNKNOWN',
    }
  })

  return { products }
}

export async function syncStock(updates: StockUpdate[] = []) {
  if (updates.length === 0) return { synced: 0, errors: [] as string[] }

  const { locationId, error: locationError } = await getSingleActiveLocationId()
  if (!locationId) {
    const message = locationError ?? 'Shopify stock sync location could not be resolved'
    await recordShopifySyncLog({
      direction: 'TO_CONNECTOR',
      status: 'FAILED',
      entityType: 'StockLevel',
      payload: {
        updates,
        error: message,
      },
      errorMessage: message,
    })
    return { synced: 0, errors: [message] }
  }

  const errors: string[] = []
  let synced = 0

  for (const update of updates) {
    const sku = update.sku.trim()
    if (!sku) {
      const message = `Product ${update.productId}: missing SKU`
      errors.push(message)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        payload: { sku: update.sku, quantity: update.quantity },
        errorMessage: message,
      })
      continue
    }

    const { data, error } = await shopifyGraphql<ShopifyInventoryVariantLookupResponse>(
      `
        query ShopifyVariantInventoryBySku($query: String!) {
          productVariants(first: 2, query: $query) {
            nodes {
              sku
              inventoryQuantity
              inventoryItem {
                id
              }
            }
          }
        }
      `,
      { query: `sku:${JSON.stringify(sku)}` },
    )

    if (error) {
      errors.push(`${sku}: ${error}`)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        payload: { sku, quantity: update.quantity, stage: 'lookup' },
        errorMessage: error,
      })
      continue
    }

    if ((data?.productVariants.nodes.length ?? 0) > 1) {
      const message = `${sku}: multiple Shopify variants share this SKU, so stock sync is ambiguous`
      errors.push(message)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        payload: { sku, quantity: update.quantity, stage: 'lookup', ambiguousSku: true },
        errorMessage: message,
      })
      continue
    }

    const variant = data?.productVariants.nodes[0]
    const inventoryItemId = variant?.inventoryItem?.id
    const currentQuantity = variant?.inventoryQuantity

    if (!inventoryItemId || typeof currentQuantity !== 'number') {
      const message = `${sku}: Shopify variant inventory item not found`
      errors.push(message)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        payload: { sku, quantity: update.quantity, stage: 'lookup' },
        errorMessage: message,
      })
      continue
    }

    const delta = update.quantity - currentQuantity
    if (delta === 0) {
      synced += 1
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'StockLevel',
        entityId: update.productId,
        externalId: inventoryItemId,
        payload: { sku, quantity: update.quantity, delta: 0, skippedNoChange: true },
      })
      continue
    }

    const result = await shopifyGraphql<ShopifyInventoryAdjustResponse>(
      `
        mutation ShopifyAdjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors {
              message
            }
          }
        }
      `,
      {
        input: {
          reason: 'correction',
          name: 'available',
          referenceDocumentUri: `gid://one-two-inventory/Product/${update.productId}`,
          changes: [
            {
              delta,
              inventoryItemId,
              locationId,
            },
          ],
        },
      },
    )

    if (result.error) {
      errors.push(`${sku}: ${result.error}`)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        externalId: inventoryItemId,
        payload: { sku, quantity: update.quantity, delta },
        errorMessage: result.error,
      })
      continue
    }

    const userErrors = result.data?.inventoryAdjustQuantities.userErrors ?? []
    if (userErrors.length > 0) {
      const message = userErrors.map((entry) => entry.message).join('; ')
      errors.push(`${sku}: ${message}`)
      await recordShopifySyncLog({
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'StockLevel',
        entityId: update.productId,
        externalId: inventoryItemId,
        payload: { sku, quantity: update.quantity, delta },
        errorMessage: message,
      })
      continue
    }

    synced += 1
    await recordShopifySyncLog({
      direction: 'TO_CONNECTOR',
      status: 'SYNCED',
      entityType: 'StockLevel',
      entityId: update.productId,
      externalId: inventoryItemId,
      payload: { sku, quantity: update.quantity, delta },
    })
  }

  return { synced, errors }
}

type ShopifyWebhookDependencies = {
  getShopifyCredentials: typeof getShopifyCredentials
  getWebhookProcessingGate: () => Promise<{
    enabled: boolean
    reason?: 'shopify_plugin_disabled' | 'shopify_sync_disabled'
  }>
  persistWebhookEvent: typeof persistShopifyWebhookEvent
  webhookEventRepository: ShoppingWebhookEventRepository
  recordShopifySyncLog: typeof recordShopifySyncLog
}

type ShopifyWebhookOptions =
  | {
      request?: undefined
      resource?: ShoppingWebhookResource
      rawBody?: undefined
      dependencies?: Partial<ShopifyWebhookDependencies>
    }
  | {
      request: Request
      resource?: ShoppingWebhookResource
      rawBody: string
      dependencies?: Partial<ShopifyWebhookDependencies>
    }

function getShopifyWebhookHeaders(request: Request) {
  const rawExternalEventId = request.headers.get('x-shopify-webhook-id')
    ?? request.headers.get('x-shopify-event-id')
  return {
    topic: request.headers.get('x-shopify-topic'),
    externalEventId: rawExternalEventId
      ? rawExternalEventId.slice(0, MAX_SHOPIFY_WEBHOOK_EXTERNAL_EVENT_ID_LENGTH)
      : null,
    webhookId: request.headers.get('x-shopify-webhook-id'),
    eventId: request.headers.get('x-shopify-event-id'),
    shopDomain: request.headers.get('x-shopify-shop-domain'),
  }
}

async function getWebhookProcessingGate() {
  if (!(await isIntegrationPluginEnabled('shopify'))) {
    return { enabled: false as const, reason: 'shopify_plugin_disabled' as const }
  }
  const settings = await getShopifySettings()
  if (settings.shopify_sync_enabled !== 'true') {
    return { enabled: false as const, reason: 'shopify_sync_disabled' as const }
  }
  return { enabled: true as const }
}

function defaultShopifyWebhookDependencies(): ShopifyWebhookDependencies {
  return {
    getShopifyCredentials,
    getWebhookProcessingGate,
    persistWebhookEvent: persistShopifyWebhookEvent,
    webhookEventRepository: createShoppingWebhookEventRepository({ connector: 'shopify' }),
    recordShopifySyncLog,
  }
}

function normalizeShopifyDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  if (!trimmed.includes('://')) return trimmed
  try {
    return new URL(trimmed).hostname.toLowerCase()
  } catch {
    return null
  }
}

export async function processShopifyWebhookPayload(
  input: {
    resource: ShoppingWebhookResource
    topic: string | null
    externalEventId: string | null
    payload: unknown
  },
  dependencies: Pick<ShopifyWebhookDependencies, 'recordShopifySyncLog'> = defaultShopifyWebhookDependencies(),
) {
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return Response.json({ success: false, error: 'Shopify webhook body must be a JSON object' }, { status: 400 })
  }

  const payload = input.payload as Record<string, unknown>
  await dependencies.recordShopifySyncLog({
    direction: 'FROM_CONNECTOR',
    status: 'FAILED',
    entityType: 'Webhook',
    externalId: input.externalEventId,
    payload: {
      resource: input.resource,
      topic: input.topic,
      externalEventId: input.externalEventId,
      // Store key names for triage, never values or raw payload content.
      payloadKeys: Object.keys(payload).sort(),
    },
    errorMessage: SHOPIFY_WEBHOOK_NOT_IMPLEMENTED_MESSAGE,
  })

  return Response.json({
    success: false,
    connector: 'shopify',
    resource: input.resource,
    topic: input.topic,
    externalEventId: input.externalEventId,
    skipped: true,
    error: SHOPIFY_WEBHOOK_NOT_IMPLEMENTED_MESSAGE,
  }, { status: 202 })
}

export async function handleWebhook(options: ShopifyWebhookOptions = {}) {
  const {
    request,
    resource,
    rawBody,
    dependencies: dependencyOverrides,
  } = options
  const dependencies = {
    ...defaultShopifyWebhookDependencies(),
    ...dependencyOverrides,
  }

  if (!request) {
    return Response.json(
      {
        ...notImplementedResult('webhook dispatch', CONNECTOR),
        error: 'Shopify webhook dispatch is not wired yet: the shared shopping facade still needs to pass the incoming request through to the connector',
      },
      { status: 501 },
    )
  }

  const creds = await dependencies.getShopifyCredentials()
  if (!creds) {
    return Response.json({ success: false, error: 'Shopify not configured' }, { status: 503 })
  }

  if (!creds.webhookSecret) {
    return Response.json({ success: false, error: 'Shopify webhook secret is not configured' }, { status: 503 })
  }

  const body = rawBody
  const providedSignature = request.headers.get('x-shopify-hmac-sha256') ?? ''
  if (!verifyShopifyWebhookSignature(body, providedSignature, creds.webhookSecret)) {
    return Response.json({ success: false, error: 'Invalid Shopify webhook signature' }, { status: 401 })
  }

  const { topic, externalEventId, webhookId, eventId, shopDomain } = getShopifyWebhookHeaders(request)

  const configuredShopDomain = normalizeShopifyDomain(creds.storeDomain)
  const receivedShopDomain = shopDomain ? normalizeShopifyDomain(shopDomain) : null
  if (!configuredShopDomain) {
    return Response.json({ success: false, error: 'Shopify store domain is not configured correctly' }, { status: 503 })
  }
  if (!receivedShopDomain) {
    return Response.json({ success: false, error: 'Shopify webhook shop domain is required' }, { status: 401 })
  }
  if (receivedShopDomain !== configuredShopDomain) {
    return Response.json({ success: false, error: 'Shopify webhook shop domain mismatch' }, { status: 401 })
  }

  let parsedPayload: unknown
  try {
    parsedPayload = JSON.parse(body) as unknown
  } catch {
    return Response.json({ success: false, error: 'Malformed JSON body' }, { status: 400 })
  }
  if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    return Response.json({ success: false, error: 'Shopify webhook body must be a JSON object' }, { status: 400 })
  }
  const payload = parsedPayload as Record<string, unknown>

  const gate = await dependencies.getWebhookProcessingGate()
  if (!gate.enabled) {
    return Response.json({
      accepted: true,
      queued: false,
      skipped: true,
      reason: gate.reason,
    }, { status: 202 })
  }

  const result: PersistShoppingWebhookEventResult = await dependencies.persistWebhookEvent(
    dependencies.webhookEventRepository,
    {
      resource: resource ?? 'orders',
      topic,
      externalEventId,
      rawBody: body,
      payload,
    },
  )

  return Response.json({
    accepted: true,
    queued: result.status === 'created',
    duplicate: result.status === 'duplicate',
    eventId: result.event.id,
    connector: 'shopify',
    resource: resource ?? 'orders',
    topic,
    webhookId,
    shopifyEventId: eventId,
  }, { status: 202 })
}

export async function getProductLink(sku: string): Promise<ShoppingProductLinkResult> {
  return getShopifyProductExternalLink(sku)
}

export async function getOrderAdminLink(orderId: string) {
  return getShopifySalesOrderAdminLink(orderId)
}

export async function getDeliveryStatus(orderId: string): Promise<DeliveryStatus | null> {
  return getShopifyDeliveryStatusForSalesOrder(orderId)
}
