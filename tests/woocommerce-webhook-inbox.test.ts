import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateWcWebhookRetryDelayMs,
  hashWcWebhookPayload,
  persistWcWebhookEvent,
  WC_WEBHOOK_EVENT_STATUS,
  type WcWebhookEventRepository,
  type WcWebhookEventRow,
} from '../lib/connectors/woocommerce/webhook-inbox.ts'
import {
  processPendingWcWebhookEvents,
  processWcWebhookEvent,
} from '../lib/jobs/woocommerce/process-shopping-webhook-events.ts'

function makeRow(overrides: Partial<WcWebhookEventRow> = {}): WcWebhookEventRow {
  return {
    id: 'event-1',
    connector: 'woocommerce',
    resource: 'products',
    externalEventId: null,
    topic: 'product.updated',
    payloadHash: hashWcWebhookPayload('{"id":1}'),
    payloadJson: { id: 1 },
    status: WC_WEBHOOK_EVENT_STATUS.pending,
    attempts: 0,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date('2026-05-26T10:00:00.000Z'),
    updatedAt: new Date('2026-05-26T10:00:00.000Z'),
    ...overrides,
  }
}

function uniqueError(): Error & { code?: string } {
  const error = new Error('Unique constraint failed') as Error & { code?: string }
  error.code = 'P2002'
  return error
}

function makeRepository(initialRows: WcWebhookEventRow[] = []): {
  repository: WcWebhookEventRepository
  rows: WcWebhookEventRow[]
} {
  const rows = [...initialRows]

  const repository: WcWebhookEventRepository = {
    async createEvent(input) {
      if (rows.some((row) =>
        row.connector === input.connector
        && row.resource === input.resource
        && row.payloadHash === input.payloadHash)) {
        throw uniqueError()
      }
      const row = makeRow({
        id: `event-${rows.length + 1}`,
        connector: input.connector,
        resource: input.resource,
        externalEventId: input.externalEventId ?? null,
        topic: input.topic,
        payloadHash: input.payloadHash,
        payloadJson: input.payload,
      })
      rows.push(row)
      return row
    },
    async findByConnectorResourceAndPayloadHash(input) {
      return rows.find((row) =>
        row.connector === input.connector
        && row.resource === input.resource
        && row.payloadHash === input.payloadHash) ?? null
    },
    async findDueEvents(input) {
      return rows
        .filter((row) =>
          row.connector === 'woocommerce'
          && (
            row.status === WC_WEBHOOK_EVENT_STATUS.pending
            || (
              row.status === WC_WEBHOOK_EVENT_STATUS.failed
              && (row.nextAttemptAt == null || row.nextAttemptAt <= input.now)
            )
            || (
              row.status === WC_WEBHOOK_EVENT_STATUS.processing
              && row.updatedAt <= input.staleProcessingBefore
            )
          ))
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
        .slice(0, input.take)
        .map((row) => ({ id: row.id }))
    },
    async claimEvent(id, now, staleProcessingBefore) {
      const row = rows.find((candidate) =>
        candidate.id === id
        && candidate.connector === 'woocommerce'
        && (
          candidate.status === WC_WEBHOOK_EVENT_STATUS.pending
          || (
            candidate.status === WC_WEBHOOK_EVENT_STATUS.failed
            && (candidate.nextAttemptAt == null || candidate.nextAttemptAt <= now)
          )
          || (
            candidate.status === WC_WEBHOOK_EVENT_STATUS.processing
            && candidate.updatedAt <= staleProcessingBefore
          )
        ))
      if (!row) return null
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
  }

  return { repository, rows }
}

test('persistWcWebhookEvent creates an inbox row and returns duplicates idempotently', async () => {
  const { repository, rows } = makeRepository()
  const input = {
    resource: 'products' as const,
    topic: 'product.updated',
    rawBody: '{"id":1}',
    payload: { id: 1 },
    externalEventId: 'delivery-1',
  }

  const created = await persistWcWebhookEvent(repository, input)
  const duplicate = await persistWcWebhookEvent(repository, input)
  const samePayloadDifferentResource = await persistWcWebhookEvent(repository, {
    ...input,
    resource: 'orders',
    topic: 'order.updated',
  })

  assert.equal(created.status, 'created')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(samePayloadDifferentResource.status, 'created')
  assert.equal(created.event.id, duplicate.event.id)
  assert.notEqual(created.event.id, samePayloadDifferentResource.event.id)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.payloadHash, hashWcWebhookPayload(input.rawBody))
})

test('processWcWebhookEvent processes a claimed event and marks it processed', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const row = makeRow({ id: 'event-1', payloadJson: { id: 123 } })
  const { repository, rows } = makeRepository([row])
  let processedPayload: unknown

  const result = await processWcWebhookEvent('event-1', {
    repository,
    now,
    async processPayload(input) {
      processedPayload = input.payload
      return Response.json({ ok: true })
    },
  })

  assert.deepEqual(result, { status: 'processed', eventId: 'event-1' })
  assert.deepEqual(processedPayload, { id: 123 })
  assert.equal(rows[0]?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.deepEqual(rows[0]?.processedAt, now)
})

test('processWcWebhookEvent retries failed processing without losing payload', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const row = makeRow({ id: 'event-1', payloadJson: { id: 123 } })
  const { repository, rows } = makeRepository([row])

  const result = await processWcWebhookEvent('event-1', {
    repository,
    now,
    async processPayload() {
      throw new Error('downstream unavailable')
    },
  })

  assert.equal(result.status, 'failed')
  assert.equal(rows[0]?.status, WC_WEBHOOK_EVENT_STATUS.failed)
  assert.equal(rows[0]?.attempts, 1)
  assert.equal(rows[0]?.lastError, 'downstream unavailable')
  assert.deepEqual(rows[0]?.payloadJson, { id: 123 })
  assert.deepEqual(rows[0]?.nextAttemptAt, new Date(now.getTime() + calculateWcWebhookRetryDelayMs(1)))
})

test('processPendingWcWebhookEvents drains pending and due failed events in received order', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const { repository } = makeRepository([
    makeRow({ id: 'not-due', status: WC_WEBHOOK_EVENT_STATUS.failed, nextAttemptAt: new Date('2026-05-26T10:05:00.000Z') }),
    makeRow({
      id: 'pending',
      payloadJson: { id: 'pending' },
      receivedAt: new Date('2026-05-26T09:58:00.000Z'),
    }),
    makeRow({
      id: 'due-failed',
      payloadJson: { id: 'due-failed' },
      status: WC_WEBHOOK_EVENT_STATUS.failed,
      nextAttemptAt: now,
    }),
    makeRow({
      id: 'fresh-processing',
      payloadJson: { id: 'fresh-processing' },
      status: WC_WEBHOOK_EVENT_STATUS.processing,
      updatedAt: new Date('2026-05-26T09:50:00.000Z'),
    }),
    makeRow({
      id: 'stale-processing',
      payloadJson: { id: 'stale-processing' },
      status: WC_WEBHOOK_EVENT_STATUS.processing,
      receivedAt: new Date('2026-05-26T09:59:00.000Z'),
      updatedAt: new Date('2026-05-26T09:40:00.000Z'),
    }),
  ])
  const processedIds: string[] = []

  const result = await processPendingWcWebhookEvents({
    repository,
    now,
    async processPayload(input) {
      processedIds.push(String((input.payload as { id?: unknown }).id ?? input.resource))
      return Response.json({ ok: true })
    },
  })

  assert.deepEqual(result, { attempted: 3, processed: 3, failed: 0, skipped: 0 })
  assert.deepEqual(processedIds, ['pending', 'stale-processing', 'due-failed'])
})
