import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SHOPPING_CONNECTORS,
  getShoppingConnector,
  parseShoppingConnectorId,
  type ShoppingConnectorId,
} from '@/lib/connectors/shopping-registry'
import {
  persistShoppingWebhookEvent,
  persistShopifyWebhookEvent,
  persistWcWebhookEvent,
  WC_WEBHOOK_EVENT_STATUS,
  type ShoppingWebhookEventConnector,
  type ShoppingWebhookEventRepository,
  type ShoppingWebhookEventRow,
} from '@/lib/connectors/shopping-webhook-inbox'
import { processShoppingWebhookEvent } from '@/lib/jobs/shopping/process-shopping-webhook-events'

/**
 * fi70j: prove the shopping connector boundary is connector-AGNOSTIC — adding a new
 * shopping connector requires only connector-module changes (a SHOPPING_CONNECTORS
 * registry entry that the ingress parser keys off, plus a processPayload callback), not
 * edits to the core webhook ingress/dispatch. The core persist + process functions are
 * exercised against an in-memory fake that mirrors the REAL Prisma repository's
 * connector-scoping (createShoppingWebhookEventRepository binds one connector;
 * createEvent writes it and claimEvent filters `WHERE connector = <bound> AND <due>`),
 * so the tests fail if the core grows a connector-specific branch. No live system / DB.
 */

const NOW = new Date('2026-06-25T00:00:00.000Z')

type FakeStore = { rows: Map<string, ShoppingWebhookEventRow>; seq: { n: number } }
function makeStore(): FakeStore {
  return { rows: new Map(), seq: { n: 0 } }
}

function isDue(row: ShoppingWebhookEventRow, now: Date, staleBefore: Date): boolean {
  if (row.status === WC_WEBHOOK_EVENT_STATUS.pending) return true
  if (row.status === WC_WEBHOOK_EVENT_STATUS.failed) return row.nextAttemptAt === null || row.nextAttemptAt <= now
  if (row.status === WC_WEBHOOK_EVENT_STATUS.processing) return row.updatedAt <= staleBefore
  return false
}

// Connector-BOUND fake, faithful to the real Prisma repository: it writes/claims under a
// single bound connector, while sharing the underlying store so the (connector, resource,
// payloadHash) uniqueness spans connectors.
function makeFakeRepo(store: FakeStore, connector: ShoppingWebhookEventConnector): ShoppingWebhookEventRepository {
  return {
    async createEvent(input) {
      for (const r of store.rows.values()) {
        if (r.connector === connector && r.resource === input.resource && r.payloadHash === input.payloadHash) {
          throw Object.assign(new Error('unique constraint'), { code: 'P2002' })
        }
      }
      const id = `evt-${++store.seq.n}`
      const row: ShoppingWebhookEventRow = {
        id,
        connector, // real createEvent writes the BOUND connector, not input.connector
        resource: input.resource,
        externalEventId: input.externalEventId ?? null,
        topic: input.topic,
        payloadHash: input.payloadHash,
        payloadJson: input.payload,
        status: WC_WEBHOOK_EVENT_STATUS.pending,
        attempts: 0,
        nextAttemptAt: null,
        processedAt: null,
        lastError: null,
        receivedAt: NOW,
        updatedAt: NOW,
      }
      store.rows.set(id, row)
      return row
    },
    async findByConnectorResourceAndPayloadHash(input) {
      for (const r of store.rows.values()) {
        if (r.connector === input.connector && r.resource === input.resource && r.payloadHash === input.payloadHash) return r
      }
      return null
    },
    async findDueEvents(input) {
      return [...store.rows.values()]
        .filter((r) => r.connector === connector && isDue(r, input.now, input.staleProcessingBefore))
        .map((r) => ({ id: r.id }))
    },
    async claimEvent(id, now, staleProcessingBefore) {
      const r = store.rows.get(id)
      if (!r || r.connector !== connector || !isDue(r, now, staleProcessingBefore)) return null
      r.attempts += 1
      r.status = WC_WEBHOOK_EVENT_STATUS.processing
      r.nextAttemptAt = null
      r.updatedAt = now
      return r
    },
    async markProcessed(id, now) {
      const r = store.rows.get(id)!
      r.status = WC_WEBHOOK_EVENT_STATUS.processed
      r.processedAt = now
      return r
    },
    async markFailed({ id, error, nextAttemptAt }) {
      const r = store.rows.get(id)!
      r.status = WC_WEBHOOK_EVENT_STATUS.failed
      r.lastError = error
      r.nextAttemptAt = nextAttemptAt
      return r
    },
    async markDeadLetter({ id, error }) {
      const r = store.rows.get(id)!
      r.status = WC_WEBHOOK_EVENT_STATUS.deadLetter
      r.lastError = error
      return r
    },
  }
}

// ---- Registry is the single, data-driven INGRESS gate -----------------------------

test('every registered shopping connector resolves and has the required fields (fi70j)', () => {
  assert.ok(SHOPPING_CONNECTORS.length >= 2)
  const ids = SHOPPING_CONNECTORS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'connector ids must be unique')
  for (const def of SHOPPING_CONNECTORS) {
    assert.equal(getShoppingConnector(def.id), def)
    for (const field of ['id', 'label', 'orderKey', 'invKey'] as const) {
      assert.ok(def[field], `connector ${def.id} missing ${field}`)
    }
  }
})

test('the ingress parser is purely registry-driven — a new connector is recognised iff it is in SHOPPING_CONNECTORS (fi70j)', () => {
  for (const def of SHOPPING_CONNECTORS) {
    assert.equal(parseShoppingConnectorId(def.id), def.id)
  }
  assert.equal(parseShoppingConnectorId(''), 'woocommerce') // empty → fallback
  assert.equal(parseShoppingConnectorId('newshop'), null) // unknown rejected until registered
  assert.equal(parseShoppingConnectorId(42), null)
  assert.throws(() => getShoppingConnector('newshop' as ShoppingConnectorId), /Unknown shopping connector/)
})

// ---- Webhook INGRESS is connector-agnostic ---------------------------------------

test('the same payload is a DISTINCT event per connector — the core does not special-case any one (fi70j)', async () => {
  const store = makeStore()
  const input = { resource: 'orders' as const, topic: 'order.created', externalEventId: 'e1', rawBody: '{"id":1}', payload: { id: 1 } }
  const wc = await persistShoppingWebhookEvent(makeFakeRepo(store, 'woocommerce'), input, { connector: 'woocommerce' })
  const sh = await persistShoppingWebhookEvent(makeFakeRepo(store, 'shopify'), input, { connector: 'shopify' })
  assert.equal(wc.event.connector, 'woocommerce')
  assert.equal(sh.event.connector, 'shopify')
  assert.equal(store.rows.size, 2)
})

test('a hypothetical new connector flows through the identical persist path (fi70j)', async () => {
  const store = makeStore()
  const created = await persistShoppingWebhookEvent(
    makeFakeRepo(store, 'newshop' as ShoppingWebhookEventConnector),
    { resource: 'orders', topic: null, rawBody: '{"id":1}', payload: { id: 1 } },
    { connector: 'newshop' as ShoppingWebhookEventConnector },
  )
  assert.equal(created.status, 'created')
  assert.equal(created.event.connector, 'newshop')
})

test('persist core dedups a replayed event by (connector, resource, payloadHash) (fi70j)', async () => {
  const store = makeStore()
  const repo = makeFakeRepo(store, 'shopify')
  const input = { resource: 'orders' as const, topic: null, rawBody: '{"id":7}', payload: { id: 7 } }
  const first = await persistShoppingWebhookEvent(repo, input, { connector: 'shopify' })
  const replay = await persistShoppingWebhookEvent(repo, input, { connector: 'shopify' })
  assert.equal(first.status, 'created')
  assert.equal(replay.status, 'duplicate')
  assert.equal(replay.event.id, first.event.id)
})

test('connector-specific persist wrappers only set their connector, sharing the core (fi70j)', async () => {
  const store = makeStore()
  const input = { resource: 'orders' as const, topic: null, rawBody: '{"id":9}', payload: { id: 9 } }
  const wc = await persistWcWebhookEvent(makeFakeRepo(store, 'woocommerce'), input)
  const sh = await persistShopifyWebhookEvent(makeFakeRepo(store, 'shopify'), input)
  assert.equal(wc.event.connector, 'woocommerce')
  assert.equal(sh.event.connector, 'shopify')
})

// ---- Webhook DISPATCH/processing is connector-agnostic ---------------------------

function processorOptions(repo: ShoppingWebhookEventRepository, connector: string, processPayload: () => Promise<Response>) {
  return {
    connector: connector as ShoppingWebhookEventConnector,
    connectorLabel: connector,
    logPrefix: `[${connector}]`,
    repository: repo,
    processPayload,
    now: NOW,
  }
}

test('process core handles an arbitrary connector via the generic path (fi70j)', async () => {
  const store = makeStore()
  const repo = makeFakeRepo(store, 'newshop' as ShoppingWebhookEventConnector)
  const created = await persistShoppingWebhookEvent(
    repo,
    { resource: 'orders', topic: null, rawBody: '{"id":1}', payload: { id: 1 } },
    { connector: 'newshop' as ShoppingWebhookEventConnector },
  )
  let dispatched = false
  const result = await processShoppingWebhookEvent(
    created.event.id,
    processorOptions(repo, 'newshop', async () => {
      dispatched = true
      return new Response(null, { status: 200 })
    }),
  )
  assert.equal(result.status, 'processed')
  assert.ok(dispatched, 'the connector-supplied processPayload callback must be invoked')
})

test('process core dead-letters an unsupported resource without retry (fi70j)', async () => {
  const store = makeStore()
  const repo = makeFakeRepo(store, 'shopify')
  // A row with a resource the core does not handle (orders/products/refunds only).
  store.rows.set('evt-x', {
    id: 'evt-x', connector: 'shopify', resource: 'customers', externalEventId: null, topic: null,
    payloadHash: 'h', payloadJson: {}, status: WC_WEBHOOK_EVENT_STATUS.pending, attempts: 0,
    nextAttemptAt: null, processedAt: null, lastError: null, receivedAt: NOW, updatedAt: NOW,
  })
  let dispatched = false
  const result = await processShoppingWebhookEvent(
    'evt-x',
    processorOptions(repo, 'shopify', async () => {
      dispatched = true
      return new Response(null, { status: 200 })
    }),
  )
  assert.equal(result.status, 'dead_letter')
  assert.equal(dispatched, false, 'an unsupported resource must not reach the connector callback')
})

test('process core retries a retryable HTTP failure and dead-letters a permanent one (fi70j)', async () => {
  const store = makeStore()
  const repo = makeFakeRepo(store, 'shopify')
  const seed = async (id: number) =>
    (
      await persistShoppingWebhookEvent(
        repo,
        { resource: 'orders', topic: null, rawBody: `{"id":${id}}`, payload: { id } },
        { connector: 'shopify' },
      )
    ).event.id

  const retryable = await processShoppingWebhookEvent(
    await seed(503),
    processorOptions(repo, 'shopify', async () => new Response('busy', { status: 503 })),
  )
  assert.equal(retryable.status, 'failed') // 5xx → retry scheduled
  assert.ok(retryable.status === 'failed' && retryable.nextAttemptAt instanceof Date)

  const permanent = await processShoppingWebhookEvent(
    await seed(400),
    processorOptions(repo, 'shopify', async () => new Response('bad', { status: 400 })),
  )
  assert.equal(permanent.status, 'dead_letter') // 4xx (non-429/408) → permanent
})
