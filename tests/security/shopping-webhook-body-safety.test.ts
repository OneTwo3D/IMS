import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { NextResponse } from 'next/server'

import {
  handleShoppingWebhookRoute,
} from '../../app/api/webhooks/shopping/[connector]/[resource]/route.ts'
import {
  handleWcWebhook,
  type WcWebhookDependencies,
} from '../../lib/connectors/woocommerce/webhooks.ts'
import type {
  WcWebhookEventRepository,
  WcWebhookEventRow,
} from '../../lib/connectors/woocommerce/webhook-inbox.ts'
import {
  handleWebhook as handleShopifyWebhook,
} from '../../lib/connectors/shopify/index.ts'
import type { ShopifyCredentials } from '../../lib/connectors/shopify/api.ts'
import type { ShoppingConnectorId } from '../../lib/connectors/shopping-registry.ts'
import type { ShoppingWebhookResource } from '../../lib/shopping.ts'
import { withRouteEnv } from '../../lib/testing/api-route-test-harness.ts'

const WC_SECRET = 'wc-webhook-secret'
const SHOPIFY_SECRET = 'shopify-webhook-secret'

function wcSignature(body: string): string {
  return createHmac('sha256', WC_SECRET).update(body).digest('base64')
}

function shopifySignature(body: string): string {
  return createHmac('sha256', SHOPIFY_SECRET).update(body, 'utf8').digest('base64')
}

function shoppingRequest(
  connector: ShoppingConnectorId,
  resource: ShoppingWebhookResource,
  body: string,
  headers: HeadersInit = {},
): Request {
  return new Request(`https://ims.example.com/api/webhooks/shopping/${connector}/${resource}`, {
    method: 'POST',
    headers,
    body,
  })
}

function wcDependencies(overrides: Partial<WcWebhookDependencies> = {}): WcWebhookDependencies {
  const unreachable = (name: string) => async () => {
    throw new Error(`${name} should not run`)
  }
  const event: WcWebhookEventRow = {
    id: 'wc-webhook-event-1',
    connector: 'woocommerce',
    resource: 'products',
    externalEventId: null,
    topic: 'product.updated',
    payloadHash: 'hash',
    payloadJson: {},
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date('2026-05-26T00:00:00.000Z'),
    updatedAt: new Date('2026-05-26T00:00:00.000Z'),
  }

  return {
    async getMaintenanceModeResponse() {
      return null
    },
    async verifyWebhook(body, signature) {
      return signature === wcSignature(body)
    },
    async recordWebhookReceipt() {},
    async getWebhookProcessingGate() {
      return { enabled: true }
    },
    async persistWebhookEvent() {
      return { status: 'created', event }
    },
    webhookEventRepository: undefined as unknown as WcWebhookEventRepository,
    handleOrderWebhook: unreachable('order handler'),
    async handleProductWebhook(payload) {
      assert.equal(typeof payload, 'object')
      return Response.json({ ok: true, handled: 'products' })
    },
    handleRefundWebhook: unreachable('refund handler'),
    ...overrides,
  }
}

const shopifyCredentials: ShopifyCredentials = {
  url: 'https://example.myshopify.com',
  key: 'admin-token',
  secret: SHOPIFY_SECRET,
  storeDomain: 'example.myshopify.com',
  adminApiAccessToken: 'admin-token',
  webhookSecret: SHOPIFY_SECRET,
}

test('shopping webhook route rejects oversized bodies before connector dispatch', async () => {
  let dispatched = false

  await withRouteEnv({ SHOPPING_WEBHOOK_MAX_BODY_BYTES: '4' }, async () => {
    const response = await handleShoppingWebhookRoute(
      shoppingRequest('woocommerce', 'products', '12345', {
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-signature': wcSignature('12345'),
      }),
      { connector: 'woocommerce', resource: 'products' },
      {
        async handleShoppingWebhook() {
          dispatched = true
          return Response.json({ ok: true })
        },
      },
    )

    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: 'Shopping webhook body is too large.' })
    assert.equal(dispatched, false)
  })
})

test('shopping webhook route rejects oversized bodies with the default cap', async () => {
  let dispatched = false

  await withRouteEnv({ SHOPPING_WEBHOOK_MAX_BODY_BYTES: undefined }, async () => {
    const rawBody = 'x'.repeat(262_145)
    const response = await handleShoppingWebhookRoute(
      shoppingRequest('woocommerce', 'products', rawBody, {
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-signature': wcSignature(rawBody),
      }),
      { connector: 'woocommerce', resource: 'products' },
      {
        async handleShoppingWebhook() {
          dispatched = true
          return Response.json({ ok: true })
        },
      },
    )

    assert.equal(response.status, 413)
    assert.equal(dispatched, false)
  })
})

test('shopping webhook route accepts bodies exactly at the configured byte cap', async () => {
  await withRouteEnv({ SHOPPING_WEBHOOK_MAX_BODY_BYTES: '4' }, async () => {
    const response = await handleShoppingWebhookRoute(
      shoppingRequest('woocommerce', 'products', '1234', {
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-signature': wcSignature('1234'),
      }),
      { connector: 'woocommerce', resource: 'products' },
      {
        async handleShoppingWebhook(_connector, _resource, _request, rawBody) {
          assert.equal(rawBody, '1234')
          return Response.json({ ok: true })
        },
      },
    )

    assert.equal(response.status, 200)
  })
})

test('shopping webhook route returns 404 for unknown connectors and resources before reading', async () => {
  const connectorResponse = await handleShoppingWebhookRoute(
    shoppingRequest('woocommerce', 'products', ''),
    { connector: 'unknown', resource: 'products' },
    {
      async handleShoppingWebhook() {
        throw new Error('dispatch should not run for unknown connector')
      },
    },
  )
  assert.equal(connectorResponse.status, 404)

  const resourceResponse = await handleShoppingWebhookRoute(
    shoppingRequest('woocommerce', 'unknown' as ShoppingWebhookResource, ''),
    { connector: 'woocommerce', resource: 'unknown' },
    {
      async handleShoppingWebhook() {
        throw new Error('dispatch should not run for unknown resource')
      },
    },
  )
  assert.equal(resourceResponse.status, 404)
})

test('shopping webhook route rejects empty non-ping bodies', async () => {
  const response = await handleShoppingWebhookRoute(
    shoppingRequest('woocommerce', 'orders', '', {
      'x-wc-webhook-topic': 'order.created',
      'x-wc-webhook-signature': wcSignature(''),
    }),
    { connector: 'woocommerce', resource: 'orders' },
    {
      async handleShoppingWebhook() {
        throw new Error('dispatch should not run for empty non-ping body')
      },
    },
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Shopping webhook body is required.' })
})

test('shopping webhook route rejects empty Shopify bodies', async () => {
  const response = await handleShoppingWebhookRoute(
    shoppingRequest('shopify', 'orders', '', {
      'x-shopify-hmac-sha256': shopifySignature(''),
    }),
    { connector: 'shopify', resource: 'orders' },
    {
      async handleShoppingWebhook() {
        throw new Error('dispatch should not run for empty Shopify body')
      },
    },
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Shopping webhook body is required.' })
})

test('shopping webhook route allows WooCommerce empty ping bodies', async () => {
  const response = await handleShoppingWebhookRoute(
    shoppingRequest('woocommerce', 'orders', ''),
    { connector: 'woocommerce', resource: 'orders' },
    {
      async handleShoppingWebhook(_connector, _resource, _request, rawBody) {
        assert.equal(rawBody, '')
        return Response.json({ ok: true, ping: true })
      },
    },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, ping: true })
})

test('WooCommerce webhook accepts signed action pings with empty bodies', async () => {
  let receiptRecorded = false
  const response = await handleWcWebhook(
    'orders',
    shoppingRequest('woocommerce', 'orders', '', {
      'x-wc-webhook-topic': 'action.woocommerce_webhook_ping',
      'x-wc-webhook-signature': wcSignature(''),
    }),
    '',
    wcDependencies({
      async recordWebhookReceipt() {
        receiptRecorded = true
      },
    }),
  )

  assert.equal(response.status, 200)
  assert.equal(receiptRecorded, true)
  assert.deepEqual(await response.json(), { ok: true, ping: true })
})

test('WooCommerce webhook maintenance mode skips body parsing and verification', async () => {
  let verified = false
  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', '{not-json}', {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': 'bad',
    }),
    '{not-json}',
    wcDependencies({
      async getMaintenanceModeResponse() {
        return NextResponse.json({ error: 'maintenance' }, { status: 503 })
      },
      async verifyWebhook() {
        verified = true
        return true
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.equal(verified, false)
})

test('WooCommerce webhook rejects unsigned requests before parsing JSON', async () => {
  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', '{not-json}', {
      'x-wc-webhook-topic': 'product.updated',
    }),
    '{not-json}',
    wcDependencies(),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Invalid signature' })
})

test('WooCommerce webhook returns 400 for malformed signed JSON instead of throwing', async () => {
  const rawBody = '{not-json}'
  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', rawBody, {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': wcSignature(rawBody),
    }),
    rawBody,
    wcDependencies({
      async handleProductWebhook() {
        return Response.json({ ok: true })
      },
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'Malformed JSON body' })
})

test('WooCommerce webhook returns 400 for malformed signed order and refund JSON', async () => {
  for (const resource of ['orders', 'refunds'] as const) {
    const rawBody = '{not-json}'
    const response = await handleWcWebhook(
      resource,
      shoppingRequest('woocommerce', resource, rawBody, {
        'x-wc-webhook-topic': resource === 'orders' ? 'order.created' : 'refund.created',
        'x-wc-webhook-signature': wcSignature(rawBody),
      }),
      rawBody,
      wcDependencies(),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { success: false, error: 'Malformed JSON body' })
  }
})

test('WooCommerce webhook persists valid signed JSON fixtures without inline processing', async () => {
  const rawBody = JSON.stringify({ id: 123, sku: 'SKU-1', type: 'simple', name: 'Product', status: 'publish' })
  let persistedPayload: unknown

  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', rawBody, {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': wcSignature(rawBody),
    }),
    rawBody,
    wcDependencies({
      async persistWebhookEvent(_repository, input) {
        persistedPayload = input.payload
        return {
          status: 'created',
          event: {
            id: 'wc-webhook-event-1',
            connector: 'woocommerce',
            resource: input.resource,
            externalEventId: input.externalEventId ?? null,
            topic: input.topic,
            payloadHash: 'hash',
            payloadJson: input.payload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: null,
            processedAt: null,
            lastError: null,
            receivedAt: new Date('2026-05-26T00:00:00.000Z'),
            updatedAt: new Date('2026-05-26T00:00:00.000Z'),
          },
        }
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(persistedPayload, JSON.parse(rawBody))
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: true,
    duplicate: false,
    eventId: 'wc-webhook-event-1',
  })
})

test('WooCommerce webhook accepts but does not queue when WC sync is disabled', async () => {
  const rawBody = JSON.stringify({ id: 123, sku: 'SKU-1', type: 'simple', name: 'Product', status: 'publish' })
  let persisted = false

  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', rawBody, {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': wcSignature(rawBody),
    }),
    rawBody,
    wcDependencies({
      async getWebhookProcessingGate() {
        return { enabled: false, reason: 'wc_sync_disabled' }
      },
      async persistWebhookEvent() {
        persisted = true
        throw new Error('persist should not run')
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.equal(persisted, false)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    skipped: true,
    reason: 'wc_sync_disabled',
  })
})

test('WooCommerce webhook returns accepted duplicate responses for repeated payloads', async () => {
  const rawBody = JSON.stringify({ id: 123, sku: 'SKU-1', type: 'simple', name: 'Product', status: 'publish' })

  const response = await handleWcWebhook(
    'products',
    shoppingRequest('woocommerce', 'products', rawBody, {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': wcSignature(rawBody),
    }),
    rawBody,
    wcDependencies({
      async persistWebhookEvent(_repository, input) {
        return {
          status: 'duplicate',
          event: {
            id: 'wc-webhook-event-1',
            connector: 'woocommerce',
            resource: input.resource,
            externalEventId: input.externalEventId ?? null,
            topic: input.topic,
            payloadHash: 'hash',
            payloadJson: input.payload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: null,
            processedAt: null,
            lastError: null,
            receivedAt: new Date('2026-05-26T00:00:00.000Z'),
            updatedAt: new Date('2026-05-26T00:00:00.000Z'),
          },
        }
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    duplicate: true,
    eventId: 'wc-webhook-event-1',
  })
})

test('WooCommerce webhook propagates unexpected persistence failures', async () => {
  const rawBody = JSON.stringify({ id: 123, sku: 'SKU-1', type: 'simple', name: 'Product', status: 'publish' })

  await assert.rejects(
    () => handleWcWebhook(
      'products',
      shoppingRequest('woocommerce', 'products', rawBody, {
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-signature': wcSignature(rawBody),
      }),
      rawBody,
      wcDependencies({
        async persistWebhookEvent() {
          throw new Error('database unavailable')
        },
      }),
    ),
    /database unavailable/,
  )
})

test('Shopify webhook rejects unsigned requests before parsing JSON', async () => {
  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', '{not-json}', {
      'x-shopify-topic': 'orders/create',
    }),
    resource: 'orders',
    rawBody: '{not-json}',
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async recordShopifySyncLog() {
        throw new Error('sync log should not be written for unsigned request')
      },
    },
  })

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'Invalid Shopify webhook signature' })
})

test('Shopify webhook returns 400 for malformed signed JSON instead of throwing', async () => {
  const rawBody = '{not-json}'
  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async recordShopifySyncLog() {
        throw new Error('sync log should not be written for malformed JSON')
      },
    },
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'Malformed JSON body' })
})

test('Shopify webhook rejects signed non-object JSON roots', async () => {
  const rawBody = '[]'
  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async recordShopifySyncLog() {
        throw new Error('sync log should not be written for non-object JSON')
      },
    },
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'Shopify webhook body must be a JSON object' })
})

test('Shopify webhook rejects mismatched shop domains', async () => {
  const rawBody = JSON.stringify({ id: 123 })
  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': 'other.myshopify.com',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async recordShopifySyncLog() {
        throw new Error('sync log should not be written for mismatched shop domain')
      },
    },
  })

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'Shopify webhook shop domain mismatch' })
})

test('Shopify webhook persists valid signed JSON without inline processing', async () => {
  const rawBody = JSON.stringify({
    id: 123,
    admin_graphql_api_id: 'gid://shopify/Order/123',
    secret_value: 'sentinel-value-xyz',
  })
  const logs: unknown[] = []
  const persisted: unknown[] = []

  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'webhook-1',
      'x-shopify-event-id': 'event-1',
      'x-shopify-shop-domain': 'example.myshopify.com',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async recordShopifySyncLog(entry) {
        logs.push(entry)
      },
      async getWebhookProcessingGate() {
        return { enabled: true }
      },
      async persistWebhookEvent(_repository, input) {
        persisted.push(input)
        return {
          status: 'created',
          event: {
            id: 'shopify-webhook-event-1',
            connector: 'shopify',
            resource: input.resource,
            externalEventId: input.externalEventId ?? null,
            topic: input.topic,
            payloadHash: 'hash',
            payloadJson: input.payload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: null,
            processedAt: null,
            lastError: null,
            receivedAt: new Date('2026-05-26T00:00:00.000Z'),
            updatedAt: new Date('2026-05-26T00:00:00.000Z'),
          },
        }
      },
      webhookEventRepository: undefined as unknown as WcWebhookEventRepository,
    },
  })

  assert.equal(response.status, 202)
  assert.equal(logs.length, 0)
  assert.equal(persisted.length, 1)
  const payload = persisted[0] as {
    externalEventId?: string | null
    topic?: string | null
    rawBody?: string
    payload?: Record<string, unknown>
  }
  assert.equal(payload.externalEventId, 'webhook-1')
  assert.equal(payload.topic, 'orders/create')
  assert.equal(payload.rawBody, rawBody)
  assert.deepEqual(payload.payload, {
    id: 123,
    admin_graphql_api_id: 'gid://shopify/Order/123',
    secret_value: 'sentinel-value-xyz',
  })
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: true,
    duplicate: false,
    eventId: 'shopify-webhook-event-1',
    connector: 'shopify',
    resource: 'orders',
    topic: 'orders/create',
    webhookId: 'webhook-1',
    shopifyEventId: 'event-1',
  })
})

test('Shopify webhook accepts but does not queue when Shopify sync is disabled', async () => {
  const rawBody = JSON.stringify({ id: 123 })
  let persisted = false

  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': 'example.myshopify.com',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async getWebhookProcessingGate() {
        return { enabled: false, reason: 'shopify_sync_disabled' }
      },
      async persistWebhookEvent() {
        persisted = true
        throw new Error('persist should not run')
      },
    },
  })

  assert.equal(response.status, 202)
  assert.equal(persisted, false)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    skipped: true,
    reason: 'shopify_sync_disabled',
  })
})

test('Shopify webhook returns accepted duplicate responses for repeated payloads', async () => {
  const rawBody = JSON.stringify({ id: 123 })

  const response = await handleShopifyWebhook({
    request: shoppingRequest('shopify', 'orders', rawBody, {
      'x-shopify-hmac-sha256': shopifySignature(rawBody),
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'webhook-1',
      'x-shopify-shop-domain': 'example.myshopify.com',
    }),
    resource: 'orders',
    rawBody,
    dependencies: {
      async getShopifyCredentials() {
        return shopifyCredentials
      },
      async getWebhookProcessingGate() {
        return { enabled: true }
      },
      async persistWebhookEvent(_repository, input) {
        return {
          status: 'duplicate',
          event: {
            id: 'shopify-webhook-event-1',
            connector: 'shopify',
            resource: input.resource,
            externalEventId: input.externalEventId ?? null,
            topic: input.topic,
            payloadHash: 'hash',
            payloadJson: input.payload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: null,
            processedAt: null,
            lastError: null,
            receivedAt: new Date('2026-05-26T00:00:00.000Z'),
            updatedAt: new Date('2026-05-26T00:00:00.000Z'),
          },
        }
      },
    },
  })

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    duplicate: true,
    eventId: 'shopify-webhook-event-1',
    connector: 'shopify',
    resource: 'orders',
    topic: 'orders/create',
    webhookId: 'webhook-1',
    shopifyEventId: null,
  })
})
