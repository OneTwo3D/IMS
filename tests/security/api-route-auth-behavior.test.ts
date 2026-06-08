import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

// This file runs under `tsx --test`; keep explicit `.ts` import extensions unless the runner changes.
import { NextResponse } from 'next/server'
import { GET as publicHealthGet } from '../../app/api/health/route.ts'
import { handleInvoicePdfRoute } from '../../app/api/invoices/[id]/route.ts'
import { handleRfqGet, handleRfqGetRequest } from '../../app/api/rfq/[id]/route.ts'
import { POST as e2eNotificationsPost } from '../../app/api/e2e/notifications/route.ts'
import {
  handleMintsoftBookedInWebhook,
  type MintsoftBookedInWebhookRouteDependencies,
} from '../../app/api/webhooks/mintsoft/asn-booked-in/route.ts'
import { verifyCron } from '../../lib/cron-auth.ts'
import { handleWcWebhook, type WcWebhookDependencies } from '../../lib/connectors/woocommerce/webhooks.ts'
import { WC_WEBHOOK_EVENT_STATUS } from '../../lib/connectors/woocommerce/webhook-inbox.ts'
import type { MintsoftWebhookEventRepository } from '../../lib/connectors/mintsoft/webhook-events.ts'
import type { ShoppingWebhookResource } from '../../lib/shopping.ts'
import {
  requireApiAdminSession,
  requireApiAuthSession,
  requireApiFreshAdminSession,
  requireRoleSession,
  type AuthSession,
} from '../../lib/auth/session-gates.ts'
import {
  apiRouteRequest,
  assertRouteAccess,
  expectStatus,
  nextApiRouteRequest,
  withRouteEnv,
} from '../../lib/testing/api-route-test-harness.ts'
import type { SessionInvalidReason } from '../../lib/auth/session-state.ts'

function session(role: string, overrides: Partial<AuthSession['user']> = {}): AuthSession {
  return {
    user: {
      id: `${role.toLowerCase()}-user`,
      email: `${role.toLowerCase()}@example.com`,
      name: role,
      role,
      supplierId: null,
      totpEnabled: false,
      totpVerified: true,
      ...overrides,
    },
  }
}

function unreachable(name: string): never {
  throw new Error(`${name} should not be reached`)
}

function unreachableAsync<TArgs extends unknown[] = unknown[]>(name: string): (..._args: TArgs) => Promise<never> {
  return async () => unreachable(name)
}

function unreachableRepository<T extends object>(name: string): T {
  return new Proxy({}, {
    get(_target, prop) {
      unreachable(`${name}.${String(prop)}`)
    },
  }) as T
}

// Duplicated test-only signers; keep in sync with verifyWcWebhook / verifyMintsoftWebhookSignature.
function hmacBase64(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

function mintsoftSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')
}

function wcWebhookEvent(overrides: Partial<{
  id: string
  resource: ShoppingWebhookResource
  externalEventId: string | null
  topic: string | null
  payloadJson: unknown
}> = {}) {
  return {
    id: overrides.id ?? 'wc-event-1',
    connector: 'woocommerce',
    resource: overrides.resource ?? 'orders',
    externalEventId: overrides.externalEventId ?? null,
    topic: overrides.topic ?? 'order.created',
    payloadHash: 'hash',
    payloadJson: overrides.payloadJson ?? { id: 123 },
    status: WC_WEBHOOK_EVENT_STATUS.pending,
    attempts: 0,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
  }
}

function makeWcWebhookDependencies(overrides: Partial<WcWebhookDependencies> = {}): WcWebhookDependencies {
  return {
    async getMaintenanceModeResponse() {
      return null
    },
    async verifyWebhook() {
      return true
    },
    async recordWebhookReceipt() {},
    async getWebhookProcessingGate() {
      return { enabled: true }
    },
    async persistWebhookEvent() {
      unreachable('persistWebhookEvent')
    },
    webhookEventRepository: unreachableRepository('webhookEventRepository'),
    handleOrderWebhook: unreachableAsync('handleOrderWebhook'),
    handleProductWebhook: unreachableAsync('handleProductWebhook'),
    handleRefundWebhook: unreachableAsync('handleRefundWebhook'),
    ...overrides,
  }
}

const MINTSOFT_NOW = new Date('2026-05-28T12:00:00.000Z')
const MINTSOFT_SECRET = 'mintsoft-secret'

function mintsoftConfig(secret: string = MINTSOFT_SECRET) {
  return {
    baseUrl: '',
    username: '',
    password: '',
    webhookSecret: secret,
    orderLookupConnector: null,
  }
}

function makeMintsoftRepository(created: unknown[] = []): MintsoftWebhookEventRepository {
  return {
    async createEvent(input) {
      created.push(input)
      return { id: `mintsoft-event-${created.length}` }
    },
    async findEvent() {
      return null
    },
    async updatePendingEvent() {
      unreachable('updatePendingEvent')
    },
  }
}

function makeMintsoftDependencies(
  overrides: Partial<MintsoftBookedInWebhookRouteDependencies> = {},
): MintsoftBookedInWebhookRouteDependencies {
  return {
    async getMintsoftApiConfiguration() {
      return mintsoftConfig()
    },
    async isIntegrationPluginEnabled(plugin: 'mintsoft') {
      return plugin === 'mintsoft'
    },
    isUniqueConstraintError() {
      return false
    },
    async logActivity() {},
    repository: makeMintsoftRepository(),
    now: () => MINTSOFT_NOW,
    ...overrides,
  }
}

test('cron-secret policy route rejects missing and invalid bearer tokens', async () => {
  assertRouteAccess('/api/cron/invariant-check', 'cron-secret')

  await withRouteEnv({ CRON_SECRET: 'cron-secret', NODE_ENV: 'production' }, async () => {
    const missing = await verifyCron(apiRouteRequest('/api/cron/invariant-check'))
    assert.equal(missing?.status, 401)

    const invalid = await verifyCron(apiRouteRequest('/api/cron/invariant-check', {
      headers: { authorization: 'Bearer wrong-secret' },
    }))
    assert.equal(invalid?.status, 401)
  })
})

test('cron-secret policy route accepts the configured bearer token before cron work runs', async () => {
  assertRouteAccess('/api/cron/invariant-check', 'cron-secret')

  await withRouteEnv({ CRON_SECRET: 'cron-secret', NODE_ENV: 'production' }, async () => {
    const accepted = await verifyCron(apiRouteRequest('/api/cron/invariant-check', {
      headers: { authorization: 'Bearer cron-secret' },
    }))
    assert.equal(accepted, null)
  })
})

test('admin policy route rejects unauthenticated and non-admin sessions', async () => {
  assertRouteAccess('/api/admin/health', 'admin')

  await expectStatus('anonymous admin route', requireApiAdminSession(null) as Response, 401)

  for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    await expectStatus(`non-admin ${role} admin route`, requireApiAdminSession(session(role)) as Response, 403)
  }
})

test('admin policy route accepts admin sessions', async () => {
  assertRouteAccess('/api/admin/health', 'admin')

  const result = requireApiAdminSession(session('ADMIN'))
  assert.equal(result instanceof Response, false)
  assert.equal((result as AuthSession).user.role, 'ADMIN')
})

test('fresh admin policy rejects stale admin sessions before high-risk mutations', async () => {
  const stale = requireApiFreshAdminSession(
    session('ADMIN', { sessionAuthTime: 1_700_000_000 }),
    { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
  )
  const response = await expectStatus('stale fresh-admin session', stale as Response, 403)
  const body = await response.json() as { code?: unknown; reason?: unknown }
  assert.equal(body.code, 'fresh_auth_required')
  assert.equal(body.reason, 'stale-auth')

  const missingAuthTime = requireApiFreshAdminSession(
    session('ADMIN'),
    { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
  )
  const missingResponse = await expectStatus('missing auth-time fresh-admin session', missingAuthTime as Response, 403)
  const missingBody = await missingResponse.json() as { code?: unknown; reason?: unknown }
  assert.equal(missingBody.code, 'fresh_auth_required')
  assert.equal(missingBody.reason, 'missing-auth-time')

  const accepted = requireApiFreshAdminSession(
    session('ADMIN', { sessionAuthTime: 1_700_000_100 }),
    { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
  )
  assert.equal(accepted instanceof Response, false)
  assert.equal((accepted as AuthSession).user.role, 'ADMIN')

  await expectStatus(
    'fresh non-admin fresh-admin session',
    requireApiFreshAdminSession(
      session('MANAGER', { sessionAuthTime: 1_700_001_000 }),
      { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
    ) as Response,
    403,
  )
  await expectStatus(
    'stale non-admin fresh-admin session checks role before freshness',
    requireApiFreshAdminSession(
      session('MANAGER', { sessionAuthTime: 1_700_000_000 }),
      { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
    ) as Response,
    403,
  )
  const invalidSession = await expectStatus(
    'invalidated fresh-admin session rejects before fresh auth',
    requireApiFreshAdminSession(
      session('ADMIN', {
        sessionAuthTime: 1_700_000_000,
        sessionInvalidReason: 'session-version-mismatch',
      }),
      { nowSeconds: 1_700_001_000, maxAgeSeconds: 900 },
    ) as Response,
    401,
  )
  assert.deepEqual(await invalidSession.json(), { error: 'Session expired' })
})

test('authenticated policy route rejects anonymous sessions and accepts verified users', async () => {
  assertRouteAccess('/api/export/products', 'authenticated')

  await expectStatus('anonymous authenticated route', requireApiAuthSession(null) as Response, 401)

  const result = requireApiAuthSession(session('USER'))
  assert.equal(result instanceof Response, false)
  assert.equal((result as AuthSession).user.email, 'user@example.com')
})

test('authenticated policy route rejects sessions still pending TOTP verification', async () => {
  assertRouteAccess('/api/export/products', 'authenticated')

  await expectStatus('totp-pending authenticated route', requireApiAuthSession(session('USER', {
    totpEnabled: true,
    totpVerified: false,
  })) as Response, 401)
})

test('authenticated policy route rejects sessions invalidated by fresh user checks', async () => {
  assertRouteAccess('/api/export/products', 'authenticated')

  for (const reason of [
    'missing-user',
    'inactive-user',
    'invalid-version',
    'session-version-mismatch',
    'force-logout',
    'missing-auth-time',
  ] satisfies SessionInvalidReason[]) {
    await expectStatus(`invalidated authenticated route ${reason}`, requireApiAuthSession(session('USER', {
      sessionInvalidReason: reason,
    })) as Response, 401)
  }
})

test('multi-role helper accepts only explicitly allowed RBAC roles', () => {
  const allowedRoles = ['ADMIN', 'FINANCE', 'MANAGER']
  for (const role of allowedRoles) {
    assert.equal(requireRoleSession(session(role), allowedRoles).user.role, role)
  }

  for (const role of ['WAREHOUSE', 'READONLY', 'SUPPLIER']) {
    assert.throws(() => requireRoleSession(session(role), allowedRoles), /Forbidden/)
  }
})

test('internal-dev-only route returns 404 outside development E2E mode', async () => {
  assertRouteAccess('/api/e2e/notifications', 'internal-dev-only')

  await withRouteEnv({
    NODE_ENV: 'production',
    E2E_TEST_MODE: undefined,
    E2E_ROUTE_SECRET: 'e2e-secret',
  }, async () => {
    await expectStatus(
      'production e2e notification route',
      e2eNotificationsPost(nextApiRouteRequest('/api/e2e/notifications', {
        method: 'POST',
        body: JSON.stringify({ notifications: [] }),
      })),
      404,
    )
  })
})

test('public health route stays reachable without authentication and exposes minimal liveness', async () => {
  assertRouteAccess('/api/health', 'public-webhook')

  const response = await expectStatus('public health route', publicHealthGet(), 200)
  const body = await response.json() as { status?: unknown; checks?: unknown; database?: unknown }

  assert.equal(body.status, 'ok')
  assert.equal('checks' in body, false)
  assert.equal('database' in body, false)
})

test('public signed invoice route rejects missing signed token before loading PDF storage', async () => {
  assertRouteAccess('/api/invoices/[id]', 'public-webhook')

  await expectStatus(
    'signed invoice without token',
    handleInvoicePdfRoute(
      nextApiRouteRequest('/api/invoices/inv_123'),
      { id: 'inv_123' },
      {
        async loadInvoicePdf() {
          throw new Error('PDF storage should not be reached without a token')
        },
        verifyPdfToken(_orderId, token) {
          assert.equal(token, null)
          return { valid: false, reason: 'missing' }
        },
        async getTokenBinding() {
          return { sessionId: 'session-1', clientIp: '203.0.113.10' }
        },
        async auditTokenAttempt() {},
      },
    ),
    403,
  )
})

test('public WooCommerce webhook rejects unsigned delivery before inbox persistence', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const persisted: unknown[] = []
  const receipts: ShoppingWebhookResource[] = []
  const rawBody = JSON.stringify({ id: 123 })
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: { 'x-wc-webhook-topic': 'order.created' },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies({
      async verifyWebhook() {
        return false
      },
      async recordWebhookReceipt(resource) {
        receipts.push(resource)
        unreachable('recordWebhookReceipt')
      },
      async persistWebhookEvent(_repository, input) {
        persisted.push(input)
        unreachable('persistWebhookEvent')
      },
    }),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Invalid signature' })
  assert.equal(persisted.length, 0)
  assert.equal(receipts.length, 0)
})

test('public WooCommerce signed webhook is accepted into the inbox without inline mutation', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const rawBody = JSON.stringify({ id: 123 })
  const secret = 'wc-secret'
  const signature = hmacBase64(secret, rawBody)
  const persisted: unknown[] = []
  const receipts: ShoppingWebhookResource[] = []
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: {
        'x-wc-webhook-signature': signature,
        'x-wc-webhook-topic': 'order.created',
        'x-wc-webhook-delivery-id': 'delivery-1',
      },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies({
      async verifyWebhook(body, providedSignature) {
        return providedSignature === hmacBase64(secret, body)
      },
      async recordWebhookReceipt(resource) {
        receipts.push(resource)
      },
      async getWebhookProcessingGate() {
        return { enabled: true }
      },
      async persistWebhookEvent(_repository, input) {
        persisted.push(input)
        return {
          status: 'created',
          event: wcWebhookEvent({
            id: 'wc-event-1',
            resource: input.resource,
            externalEventId: input.externalEventId,
            topic: input.topic,
            payloadJson: input.payload,
          }),
        }
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: true,
    duplicate: false,
    eventId: 'wc-event-1',
  })
  assert.deepEqual(receipts, ['orders'])
  assert.equal(persisted.length, 1)
  assert.equal((persisted[0] as { externalEventId?: string | null }).externalEventId, 'delivery-1')
})

test('public WooCommerce signed webhook skips persistence when processing gate is disabled', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const rawBody = JSON.stringify({ id: 123 })
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: {
        'x-wc-webhook-signature': hmacBase64('wc-secret', rawBody),
        'x-wc-webhook-topic': 'order.created',
      },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies({
      async getWebhookProcessingGate() {
        return { enabled: false, reason: 'wc_sync_disabled' }
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    skipped: true,
    reason: 'wc_sync_disabled',
  })
})

test('public WooCommerce duplicate webhook is acknowledged without queueing duplicate work', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const rawBody = JSON.stringify({ id: 123 })
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: {
        'x-wc-webhook-signature': hmacBase64('wc-secret', rawBody),
        'x-wc-webhook-topic': 'order.created',
        'x-wc-webhook-delivery-id': 'delivery-1',
      },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies({
      async persistWebhookEvent(_repository, input) {
        return {
          status: 'duplicate',
          event: wcWebhookEvent({
            id: 'wc-event-existing',
            resource: input.resource,
            externalEventId: input.externalEventId,
            topic: input.topic,
            payloadJson: input.payload,
          }),
        }
      },
    }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: false,
    duplicate: true,
    eventId: 'wc-event-existing',
  })
})

test('public WooCommerce webhook returns maintenance response before signature or persistence work', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const rawBody = JSON.stringify({ id: 123 })
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: {
        'x-wc-webhook-signature': hmacBase64('wc-secret', rawBody),
        'x-wc-webhook-topic': 'order.created',
      },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies({
      async getMaintenanceModeResponse() {
        return NextResponse.json({ error: 'Maintenance mode' }, { status: 503 })
      },
      async verifyWebhook() {
        unreachable('verifyWebhook')
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Maintenance mode' })
})

test('public WooCommerce signed webhook rejects malformed JSON before inbox persistence', async () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')

  const rawBody = '{"id":'
  const response = await handleWcWebhook(
    'orders',
    apiRouteRequest('/api/webhooks/shopping/woocommerce/orders', {
      method: 'POST',
      headers: {
        'x-wc-webhook-signature': hmacBase64('wc-secret', rawBody),
        'x-wc-webhook-topic': 'order.created',
      },
      body: rawBody,
    }),
    rawBody,
    makeWcWebhookDependencies(),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'Malformed JSON body' })
})

test('public Mintsoft webhook rejects missing signatures before inbox persistence', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const created: unknown[] = []
  const freshTimestamp = new Date(MINTSOFT_NOW.getTime() - 30_000).toISOString()
  const freshBody = JSON.stringify({ eventId: 'evt-1', externalAsnId: 'asn-1', timestamp: freshTimestamp })
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': freshTimestamp,
      },
      body: freshBody,
    }),
    makeMintsoftDependencies({ repository: makeMintsoftRepository(created) }),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
  assert.equal(created.length, 0)
})

test('public Mintsoft webhook rejects stale signatures with an injected clock', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const staleTimestamp = '2000-01-01T00:00:00.000Z'
  const staleBody = JSON.stringify({ eventId: 'evt-stale', externalAsnId: 'asn-stale', timestamp: staleTimestamp })
  const created: unknown[] = []
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': staleTimestamp,
        'x-mintsoft-signature': mintsoftSignature(MINTSOFT_SECRET, staleTimestamp, staleBody),
      },
      body: staleBody,
    }),
    makeMintsoftDependencies({ repository: makeMintsoftRepository(created) }),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Stale webhook timestamp' })
  assert.equal(created.length, 0)
})

test('public Mintsoft webhook accepts valid signed requests into the inbox', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const created: unknown[] = []
  const freshTimestamp = new Date(MINTSOFT_NOW.getTime() - 30_000).toISOString()
  const freshBody = JSON.stringify({ eventId: 'evt-1', externalAsnId: 'asn-1', timestamp: freshTimestamp })
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': freshTimestamp,
        'x-mintsoft-signature': mintsoftSignature(MINTSOFT_SECRET, freshTimestamp, freshBody),
      },
      body: freshBody,
    }),
    makeMintsoftDependencies({ repository: makeMintsoftRepository(created) }),
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), {
    accepted: true,
    externalEventId: 'evt-1',
    externalAsnId: 'asn-1',
    queued: true,
    pending: true,
  })
  assert.equal(created.length, 1)
})

test('public Mintsoft webhook rejects requests while the plugin is disabled', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const created: unknown[] = []
  const freshTimestamp = new Date(MINTSOFT_NOW.getTime() - 30_000).toISOString()
  const freshBody = JSON.stringify({ eventId: 'evt-disabled', externalAsnId: 'asn-disabled' })
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': freshTimestamp,
        'x-mintsoft-signature': mintsoftSignature(MINTSOFT_SECRET, freshTimestamp, freshBody),
      },
      body: freshBody,
    }),
    makeMintsoftDependencies({
      repository: makeMintsoftRepository(created),
      async isIntegrationPluginEnabled() {
        return false
      },
    }),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
  assert.equal(created.length, 0)
})

test('public Mintsoft webhook rejects wrong-secret signatures before inbox persistence', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const created: unknown[] = []
  const freshTimestamp = new Date(MINTSOFT_NOW.getTime() - 30_000).toISOString()
  const freshBody = JSON.stringify({ eventId: 'evt-wrong-secret', externalAsnId: 'asn-wrong-secret' })
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': freshTimestamp,
        'x-mintsoft-signature': mintsoftSignature('wrong-secret', freshTimestamp, freshBody),
      },
      body: freshBody,
    }),
    makeMintsoftDependencies({ repository: makeMintsoftRepository(created) }),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
  assert.equal(created.length, 0)
})

test('public Mintsoft duplicate webhooks are acknowledged without requeueing', async () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')

  const freshTimestamp = new Date(MINTSOFT_NOW.getTime() - 30_000).toISOString()
  const freshBody = JSON.stringify({ eventId: 'evt-duplicate', externalAsnId: 'asn-duplicate' })
  const repository: MintsoftWebhookEventRepository = {
    async createEvent() {
      unreachable('createEvent')
    },
    async findEvent() {
      return { id: 'mintsoft-existing', processedAt: new Date('2026-05-28T11:59:00.000Z') }
    },
    async updatePendingEvent() {
      unreachable('updatePendingEvent')
    },
  }
  const response = await handleMintsoftBookedInWebhook(
    apiRouteRequest('/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-timestamp': freshTimestamp,
        'x-mintsoft-signature': mintsoftSignature(MINTSOFT_SECRET, freshTimestamp, freshBody),
      },
      body: freshBody,
    }),
    makeMintsoftDependencies({ repository }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    accepted: true,
    duplicate: true,
    externalEventId: 'evt-duplicate',
    externalAsnId: 'asn-duplicate',
  })
})

test('supplier RFQ route allows own RFQ PDFs and rejects foreign RFQs', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  const findPurchaseOrderCalls: string[] = []
  let renderedPo: { reference?: string; lines?: Array<{ qty?: unknown; purchaseUnitQty?: unknown }> } | null = null
  const dependencies = {
    async authorize() {
      return session('SUPPLIER', { supplierId: 'supplier-owned' })
    },
    hasPermission() {
      return false
    },
    async findSupplierOwnedPurchaseOrder(id: string, supplierId: string) {
      return id === 'rfq-owned' && supplierId === 'supplier-owned' ? { id } : null
    },
    async findPurchaseOrder(id: string) {
      findPurchaseOrderCalls.push(id)
      return {
        reference: 'PO-001',
        currency: 'GBP',
        notes: null,
        expectedDelivery: null,
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        supplier: {
          name: 'Owned Supplier',
          contactName: null,
          email: null,
          addressLine1: null,
          addressLine2: null,
          city: null,
          postcode: null,
          country: 'GB',
        },
        lines: [{
          qty: '2.5',
          purchaseUnitQty: '1.0',
          purchaseUnit: { abbreviation: 'case', stockUnitName: 'pcs' },
          product: { sku: 'SKU-001', name: 'Fixture Product', barcode: '1234567890123', mpn: 'MPN-SKU-001' },
        }],
      }
    },
    async findDocumentTemplate() {
      return null
    },
    async renderPdf(po: { reference?: string; lines?: Array<{ qty?: unknown; purchaseUnitQty?: unknown }> }) {
      renderedPo = po
      return new Response('pdf', { status: 200, headers: { 'content-type': 'application/pdf' } })
    },
  }

  const own = await handleRfqGet({ id: 'rfq-owned' }, dependencies)
  assert.equal(own.status, 200)
  assert.equal(own.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(findPurchaseOrderCalls, ['rfq-owned'])
  assert.ok(renderedPo)
  const rendered = renderedPo as { reference: string; lines: Array<{ qty: unknown; purchaseUnitQty: unknown }> }
  assert.equal(rendered.reference, 'PO-001')
  assert.deepEqual(rendered.lines.map((line) => [line.qty, line.purchaseUnitQty]), [['2.5', '1.0']])

  const foreign = await handleRfqGet({ id: 'rfq-foreign' }, dependencies)
  assert.equal(foreign.status, 403)
  assert.deepEqual(await foreign.json(), { error: 'Forbidden' })
  assert.deepEqual(findPurchaseOrderCalls, ['rfq-owned'])
})

test('supplier RFQ route rejects supplier sessions without supplier ownership context', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  const response = await handleRfqGet(
    { id: 'rfq-owned' },
    {
      async authorize() {
        return session('SUPPLIER', { supplierId: null })
      },
      findSupplierOwnedPurchaseOrder: unreachableAsync('findSupplierOwnedPurchaseOrder'),
      findPurchaseOrder: unreachableAsync('findPurchaseOrder'),
      renderPdf: unreachableAsync('renderPdf'),
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Forbidden' })
})

test('supplier RFQ route rejects non-suppliers without purchasing permission', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  const response = await handleRfqGet(
    { id: 'rfq-owned' },
    {
      async authorize() {
        return session('WAREHOUSE')
      },
      hasPermission() {
        return false
      },
      findSupplierOwnedPurchaseOrder: unreachableAsync('findSupplierOwnedPurchaseOrder'),
      findPurchaseOrder: unreachableAsync('findPurchaseOrder'),
      renderPdf: unreachableAsync('renderPdf'),
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Forbidden' })
})

test('supplier RFQ route allows purchasing users to fetch RFQ PDFs', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  let ownershipLookupCalled = false
  const response = await handleRfqGet(
    { id: 'rfq-owned' },
    {
      async authorize() {
        return session('MANAGER')
      },
      hasPermission(role, permission) {
        return role === 'MANAGER' && permission === 'purchasing'
      },
      async findSupplierOwnedPurchaseOrder() {
        ownershipLookupCalled = true
        return null
      },
      async findPurchaseOrder() {
        return {
          reference: 'PO-002',
          currency: 'GBP',
          notes: null,
          expectedDelivery: null,
          createdAt: new Date('2026-05-28T00:00:00.000Z'),
          supplier: {
            name: 'Any Supplier',
            contactName: null,
            email: null,
            addressLine1: null,
            addressLine2: null,
            city: null,
            postcode: null,
            country: 'GB',
          },
          lines: [],
        }
      },
      async findDocumentTemplate() {
        return null
      },
      async renderPdf(po) {
        assert.equal(po.reference, 'PO-002')
        return new Response('pdf', { status: 200 })
      },
    },
  )

  assert.equal(response.status, 200)
  assert.equal(ownershipLookupCalled, false)
})

test('supplier RFQ route returns not found when an owned RFQ is deleted before data load', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  const response = await handleRfqGet(
    { id: 'rfq-owned' },
    {
      async authorize() {
        return session('SUPPLIER', { supplierId: 'supplier-owned' })
      },
      async findSupplierOwnedPurchaseOrder() {
        return { id: 'rfq-owned' }
      },
      async findPurchaseOrder() {
        return null
      },
      renderPdf: unreachableAsync('renderPdf'),
    },
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Not found' })
})

test('supplier RFQ route adapter resolves promised params before auth enforcement', async () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')

  const response = await handleRfqGetRequest(
    { params: Promise.resolve({ id: 'rfq-owned' }) },
    {
      async authorize() {
        return session('SUPPLIER', { supplierId: null })
      },
      findSupplierOwnedPurchaseOrder: unreachableAsync('findSupplierOwnedPurchaseOrder'),
      findPurchaseOrder: unreachableAsync('findPurchaseOrder'),
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Forbidden' })
})
