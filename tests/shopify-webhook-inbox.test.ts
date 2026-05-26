import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_WEBHOOK_EVENT_STATUS,
  type ShoppingWebhookEventRepository,
  type ShoppingWebhookEventRow,
} from '../lib/connectors/woocommerce/webhook-inbox.ts'
import {
  processPendingShopifyWebhookEvents,
  processShopifyWebhookEvent,
} from '../lib/jobs/shopify/process-shopping-webhook-events.ts'
import { processShopifyWebhookPayload } from '../lib/connectors/shopify/index.ts'

function makeRow(overrides: Partial<ShoppingWebhookEventRow> = {}): ShoppingWebhookEventRow {
  return {
    id: 'shopify-event-1',
    connector: 'shopify',
    resource: 'orders',
    externalEventId: 'webhook-1',
    topic: 'orders/create',
    payloadHash: 'hash',
    payloadJson: { id: 123, secret_value: 'sentinel' },
    status: WC_WEBHOOK_EVENT_STATUS.pending,
    attempts: 0,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date('2026-05-26T09:00:00.000Z'),
    updatedAt: new Date('2026-05-26T09:00:00.000Z'),
    ...overrides,
  }
}

function makeRepository(initialRows: ShoppingWebhookEventRow[] = []): {
  repository: ShoppingWebhookEventRepository
  rows: ShoppingWebhookEventRow[]
} {
  const rows = initialRows.map((row) => ({ ...row }))
  const repository: ShoppingWebhookEventRepository = {
    async createEvent() {
      throw new Error('createEvent should not run')
    },
    async findByConnectorResourceAndPayloadHash() {
      throw new Error('findByConnectorResourceAndPayloadHash should not run')
    },
    async findDueEvents(input) {
      return rows
        .filter((row) => row.connector === 'shopify')
        .filter((row) => {
          if (row.status === WC_WEBHOOK_EVENT_STATUS.pending) return true
          if (row.status === WC_WEBHOOK_EVENT_STATUS.failed) {
            return !row.nextAttemptAt || row.nextAttemptAt <= input.now
          }
          if (row.status === WC_WEBHOOK_EVENT_STATUS.processing) {
            return row.updatedAt <= input.staleProcessingBefore
          }
          return false
        })
        .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime())
        .slice(0, input.take)
        .map((row) => ({ id: row.id }))
    },
    async claimEvent(id, now, staleProcessingBefore) {
      const row = rows.find((candidate) => candidate.id === id)
      if (!row) return null
      const claimable = row.status === WC_WEBHOOK_EVENT_STATUS.pending
        || (row.status === WC_WEBHOOK_EVENT_STATUS.failed && (!row.nextAttemptAt || row.nextAttemptAt <= now))
        || (row.status === WC_WEBHOOK_EVENT_STATUS.processing && row.updatedAt <= staleProcessingBefore)
      if (!claimable) return null

      row.status = WC_WEBHOOK_EVENT_STATUS.processing
      row.attempts += 1
      row.nextAttemptAt = null
      row.lastError = null
      row.updatedAt = now
      return { ...row }
    },
    async markProcessed(id, now) {
      const row = rows.find((candidate) => candidate.id === id)
      assert.ok(row)
      row.status = WC_WEBHOOK_EVENT_STATUS.processed
      row.processedAt = now
      row.nextAttemptAt = null
      row.lastError = null
      row.updatedAt = now
      return { ...row }
    },
    async markFailed(input) {
      const row = rows.find((candidate) => candidate.id === input.id)
      assert.ok(row)
      row.status = WC_WEBHOOK_EVENT_STATUS.failed
      row.lastError = input.error
      row.nextAttemptAt = input.nextAttemptAt
      row.updatedAt = input.now
      return { ...row }
    },
    async markDeadLetter(input) {
      const row = rows.find((candidate) => candidate.id === input.id)
      assert.ok(row)
      row.status = WC_WEBHOOK_EVENT_STATUS.deadLetter
      row.lastError = input.error
      row.nextAttemptAt = null
      row.updatedAt = input.now
      return { ...row }
    },
  }

  return { repository, rows }
}

test('processShopifyWebhookPayload records the existing Shopify webhook sync-log outcome without raw payload values', async () => {
  const logs: unknown[] = []

  const response = await processShopifyWebhookPayload(
    {
      resource: 'orders',
      topic: 'orders/create',
      externalEventId: 'webhook-1',
      payload: { id: 123, secret_value: 'sentinel' },
    },
    {
      async recordShopifySyncLog(entry) {
        logs.push(entry)
      },
    },
  )

  assert.equal(response.status, 202)
  assert.equal(logs.length, 1)
  const log = logs[0] as { externalId?: string | null; payload?: Record<string, unknown> }
  assert.equal(log.externalId, 'webhook-1')
  assert.deepEqual(log.payload?.payloadKeys, ['id', 'secret_value'])
  assert.equal(JSON.stringify(logs).includes('sentinel'), false)
})

test('processShopifyWebhookPayload rejects non-object payloads as permanent bad payloads', async () => {
  const response = await processShopifyWebhookPayload(
    {
      resource: 'orders',
      topic: 'orders/create',
      externalEventId: 'webhook-1',
      payload: [],
    },
    {
      async recordShopifySyncLog() {
        throw new Error('sync log should not run for non-object payload')
      },
    },
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'Shopify webhook body must be a JSON object' })
})

test('processShopifyWebhookEvent processes a claimed event and marks it processed', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const { repository, rows } = makeRepository([makeRow()])
  const processedPayloads: unknown[] = []

  const result = await processShopifyWebhookEvent('shopify-event-1', {
    repository,
    now,
    async processPayload(input) {
      processedPayloads.push(input.payload)
      return Response.json({ ok: true }, { status: 202 })
    },
  })

  assert.deepEqual(result, { status: 'processed', eventId: 'shopify-event-1' })
  assert.deepEqual(processedPayloads, [{ id: 123, secret_value: 'sentinel' }])
  assert.equal(rows[0]?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.equal(rows[0]?.attempts, 1)
})

test('processShopifyWebhookEvent skips rows that were already claimed', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const { repository } = makeRepository([
    makeRow({
      status: WC_WEBHOOK_EVENT_STATUS.processing,
      updatedAt: new Date('2026-05-26T09:59:00.000Z'),
    }),
  ])

  const result = await processShopifyWebhookEvent('shopify-event-1', { repository, now })

  assert.deepEqual(result, { status: 'skipped', eventId: 'shopify-event-1', reason: 'not_due_or_already_processed' })
})

test('processShopifyWebhookEvent retries transient failures and dead-letters permanent failures', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const transient = makeRow({ id: 'transient' })
  const permanent = makeRow({ id: 'permanent' })
  const { repository, rows } = makeRepository([transient, permanent])

  const transientResult = await processShopifyWebhookEvent('transient', {
    repository,
    now,
    async processPayload() {
      return Response.json({ error: 'downstream unavailable' }, { status: 503 })
    },
  })
  const permanentResult = await processShopifyWebhookEvent('permanent', {
    repository,
    now,
    async processPayload() {
      return Response.json({ error: 'bad payload' }, { status: 400 })
    },
  })

  assert.equal(transientResult.status, 'failed')
  assert.equal(rows.find((row) => row.id === 'transient')?.status, WC_WEBHOOK_EVENT_STATUS.failed)
  assert.equal(rows.find((row) => row.id === 'transient')?.nextAttemptAt instanceof Date, true)
  assert.equal(permanentResult.status, 'dead_letter')
  assert.equal(rows.find((row) => row.id === 'permanent')?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
})

test('processShopifyWebhookEvent retries 408 and 429 responses', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const timeout = makeRow({ id: 'timeout' })
  const rateLimited = makeRow({ id: 'rate-limited' })
  const { repository, rows } = makeRepository([timeout, rateLimited])

  const timeoutResult = await processShopifyWebhookEvent('timeout', {
    repository,
    now,
    async processPayload() {
      return Response.json({ error: 'timeout' }, { status: 408 })
    },
  })
  const rateLimitResult = await processShopifyWebhookEvent('rate-limited', {
    repository,
    now,
    async processPayload() {
      return Response.json({ error: 'rate limited' }, { status: 429 })
    },
  })

  assert.equal(timeoutResult.status, 'failed')
  assert.equal(rateLimitResult.status, 'failed')
  assert.equal(rows.find((row) => row.id === 'timeout')?.status, WC_WEBHOOK_EVENT_STATUS.failed)
  assert.equal(rows.find((row) => row.id === 'rate-limited')?.status, WC_WEBHOOK_EVENT_STATUS.failed)
})

test('processShopifyWebhookEvent dead-letters max attempts and unsupported resources', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const exhausted = makeRow({ id: 'exhausted', attempts: 23 })
  const unsupported = makeRow({ id: 'unsupported', resource: 'reviews' })
  const { repository, rows } = makeRepository([exhausted, unsupported])

  const exhaustedResult = await processShopifyWebhookEvent('exhausted', {
    repository,
    now,
    env: { WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '24' },
    async processPayload() {
      throw new Error('still broken')
    },
  })
  const unsupportedResult = await processShopifyWebhookEvent('unsupported', {
    repository,
    now,
    async processPayload() {
      throw new Error('processPayload should not run')
    },
  })

  assert.equal(exhaustedResult.status, 'dead_letter')
  assert.equal(unsupportedResult.status, 'dead_letter')
  assert.equal(rows.find((row) => row.id === 'exhausted')?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.equal(rows.find((row) => row.id === 'unsupported')?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
})

test('processPendingShopifyWebhookEvents drains only Shopify claimable rows', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const { repository, rows } = makeRepository([
    makeRow({ id: 'shopify-pending', receivedAt: new Date('2026-05-26T09:58:00.000Z') }),
    makeRow({
      id: 'shopify-due-failed',
      status: WC_WEBHOOK_EVENT_STATUS.failed,
      nextAttemptAt: new Date('2026-05-26T10:00:00.000Z'),
      receivedAt: new Date('2026-05-26T09:59:00.000Z'),
    }),
    makeRow({
      id: 'shopify-stale-processing',
      status: WC_WEBHOOK_EVENT_STATUS.processing,
      updatedAt: new Date('2026-05-26T09:40:00.000Z'),
      receivedAt: new Date('2026-05-26T09:59:30.000Z'),
    }),
    makeRow({ id: 'wc-pending', connector: 'woocommerce' }),
  ])

  const result = await processPendingShopifyWebhookEvents({
    repository,
    now,
    async processPayload() {
      return Response.json({ ok: true }, { status: 202 })
    },
  })

  assert.deepEqual(result, { attempted: 3, processed: 3, failed: 0, deadLettered: 0, skipped: 0 })
  assert.equal(rows.find((row) => row.id === 'shopify-pending')?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.equal(rows.find((row) => row.id === 'shopify-due-failed')?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.equal(rows.find((row) => row.id === 'shopify-stale-processing')?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.equal(rows.find((row) => row.id === 'wc-pending')?.status, WC_WEBHOOK_EVENT_STATUS.pending)
})

test('processPendingShopifyWebhookEvents handles empty queues and per-event crashes', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const empty = makeRepository()
  assert.deepEqual(
    await processPendingShopifyWebhookEvents({ repository: empty.repository, now }),
    { attempted: 0, processed: 0, failed: 0, deadLettered: 0, skipped: 0 },
  )

  const { repository } = makeRepository([makeRow({ id: 'shopify-event-1' })])
  const result = await processPendingShopifyWebhookEvents({
    repository: {
      ...repository,
      async claimEvent() {
        throw new Error('claim failed')
      },
    },
    now,
  })

  assert.deepEqual(result, { attempted: 1, processed: 0, failed: 1, deadLettered: 0, skipped: 0 })
})
