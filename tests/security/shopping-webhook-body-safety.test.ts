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
  ShoppingWebhookEventRepository,
  ShoppingWebhookEventRow,
} from '../../lib/connectors/woocommerce/webhook-inbox.ts'
import type { ShoppingConnectorId } from '../../lib/connectors/shopping-registry.ts'
import type { ShoppingWebhookResource } from '../../lib/shopping.ts'
import { withRouteEnv } from '../../lib/testing/api-route-test-harness.ts'

const WC_SECRET = 'wc-webhook-secret'

function wcSignature(body: string): string {
  return createHmac('sha256', WC_SECRET).update(body).digest('base64')
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
  const event: ShoppingWebhookEventRow = {
    id: 'wc-webhook-event-1',
    connector: 'woocommerce',
    resource: 'products',
    externalEventId: null,
    topic: 'product.updated',
    payloadHash: 'hash',
    payloadJson: {},
    originAttestation: 'unproven:not-applicable',
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
    webhookEventRepository: undefined as unknown as ShoppingWebhookEventRepository,
    handleOrderWebhook: unreachable('order handler'),
    async handleProductWebhook(payload) {
      assert.equal(typeof payload, 'object')
      return Response.json({ ok: true, handled: 'products' })
    },
    handleRefundWebhook: unreachable('refund handler'),
    ...overrides,
  }
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

// DELETED (o3d-remove-parked-connectors): 'shopping webhook route rejects empty Shopify bodies'.
//
// It proved that the route's empty-body rule applies to a connector that does NOT have
// WooCommerce's ping quirk — i.e. that the rule is per-connector rather than "empty bodies are
// always fine". Shopify was the only such connector and is archived; the route resolves its
// connector through `parseShoppingConnectorId`, which now rejects every id but 'woocommerce' with
// a 404 before the body rule is reached, so there is no id left that can exercise it here.
//
// The per-connector RULE itself is still covered, one layer down, by
// tests/connectors/shopping-webhook-empty-body.test.ts, which drives
// `isEmptyShoppingWebhookBodyAllowed` directly (including with an unregistered id). What is lost is
// the proof that the ROUTE consults that rule for a connector other than WooCommerce. Recorded in
// docs/archive/shopify-connector-removal.md.

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
            originAttestation: input.originAttestation ?? 'unproven:not-applicable',
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
    deferred: false,
    eventId: 'wc-webhook-event-1',
  })
})

test('WooCommerce webhook PERSISTS (deferred) when WC sync is disabled — the event is not lost (o3d-56b)', async () => {
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
      async getWebhookProcessingGate() {
        return { enabled: false, reason: 'wc_sync_disabled' }
      },
      async persistWebhookEvent(_repository, input) {
        persistedPayload = input.payload
        return {
          status: 'created',
          event: {
            id: 'wc-webhook-event-disabled',
            connector: 'woocommerce',
            resource: input.resource,
            externalEventId: input.externalEventId ?? null,
            topic: input.topic,
            payloadHash: 'hash',
            payloadJson: input.payload,
            originAttestation: input.originAttestation ?? 'unproven:not-applicable',
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
  // The event is durably persisted (replayable once sync is re-enabled), NOT silently discarded.
  assert.deepEqual(persistedPayload, JSON.parse(rawBody))
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: true,
    duplicate: false,
    deferred: true,
    reason: 'wc_sync_disabled',
    eventId: 'wc-webhook-event-disabled',
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
            originAttestation: input.originAttestation ?? 'unproven:not-applicable',
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
    deferred: false,
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
