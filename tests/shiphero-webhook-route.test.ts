import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { handleShipheroWebhook, type ShipheroWebhookRouteDependencies } from '../app/api/webhooks/shiphero/[event]/route.ts'
import type { ShipheroWebhookEventRepository } from '../lib/connectors/shiphero/webhook-events.ts'

const SECRET = 'sh-webhook-secret'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
}

function makeRequest(event: string, body: string, signature: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature) headers['x-shiphero-hmac-sha256'] = signature
  return new Request(`https://ims.example/api/webhooks/shiphero/${event}`, { method: 'POST', headers, body })
}

function makeDeps(overrides: {
  enabled?: boolean
  webhookSecret?: string
  findResult?: { id: string; processedAt: Date | null } | null
} = {}): { deps: ShipheroWebhookRouteDependencies; created: number } {
  const state = { created: 0 }
  const repository: ShipheroWebhookEventRepository = {
    async createEvent() {
      state.created += 1
      return { id: `ev-${state.created}` }
    },
    async findEvent() {
      return overrides.findResult ?? null
    },
    async updatePendingEvent() {
      return true
    },
  }
  const deps: ShipheroWebhookRouteDependencies = {
    getShipheroApiConfiguration: async () => ({
      baseUrl: 'https://public-api.shiphero.com',
      refreshToken: 'rt',
      webhookSecret: overrides.webhookSecret ?? SECRET,
      accountId: '',
      adminOrderUrlTemplate: '',
      orderLookupConnector: null,
    }),
    isIntegrationPluginEnabled: async () => overrides.enabled ?? true,
    isUniqueConstraintError: () => false,
    repository,
  }
  return { deps, created: state.created }
}

test('rejects an unknown event type with 404', async () => {
  const body = '{}'
  const res = await handleShipheroWebhook(makeRequest('bogus', body, sign(body)), 'bogus', makeDeps().deps)
  assert.equal(res.status, 404)
})

test('rejects when the plugin is disabled', async () => {
  const body = '{"order_id":"o1"}'
  const res = await handleShipheroWebhook(makeRequest('shipment-update', body, sign(body)), 'shipment-update', makeDeps({ enabled: false }).deps)
  assert.equal(res.status, 401)
})

test('rejects a bad / missing signature', async () => {
  const body = '{"order_id":"o1"}'
  const bad = await handleShipheroWebhook(makeRequest('shipment-update', body, 'deadbeef'), 'shipment-update', makeDeps().deps)
  assert.equal(bad.status, 401)
  const missing = await handleShipheroWebhook(makeRequest('shipment-update', body, null), 'shipment-update', makeDeps().deps)
  assert.equal(missing.status, 401)
})

test('rejects an empty webhook secret (not configured)', async () => {
  const body = '{"order_id":"o1"}'
  const res = await handleShipheroWebhook(makeRequest('shipment-update', body, sign(body)), 'shipment-update', makeDeps({ webhookSecret: '' }).deps)
  assert.equal(res.status, 401)
})

test('stages a valid event and returns 202', async () => {
  const body = JSON.stringify({ order_id: 'o1', fulfillment_status: 'fulfilled', webhook_id: 'wh-1' })
  const res = await handleShipheroWebhook(makeRequest('shipment-update', body, sign(body)), 'shipment-update', makeDeps().deps)
  assert.equal(res.status, 202)
  const payload = await res.json()
  assert.equal(payload.accepted, true)
  assert.equal(payload.queued, true)
  assert.equal(payload.eventType, 'shipment_update')
  assert.equal(payload.externalOrderId, 'o1')
})

test('reports a duplicate (already processed) without re-queuing', async () => {
  const body = JSON.stringify({ order_id: 'o1', webhook_id: 'wh-1' })
  const deps = makeDeps({ findResult: { id: 'pre', processedAt: new Date() } }).deps
  const res = await handleShipheroWebhook(makeRequest('order-canceled', body, sign(body)), 'order-canceled', deps)
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.duplicate, true)
})

test('rejects invalid JSON after a valid signature', async () => {
  const body = 'not-json'
  const res = await handleShipheroWebhook(makeRequest('inventory-update', body, sign(body)), 'inventory-update', makeDeps().deps)
  assert.equal(res.status, 400)
})
