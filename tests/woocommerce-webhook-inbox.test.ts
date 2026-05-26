import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateWcWebhookRetryDelayMs,
  getWcWebhookMaxAttempts,
  getWcWebhookProcessPageSize,
  getWcWebhookStaleProcessingMs,
  hashWcWebhookPayload,
  nextWcWebhookRetryAt,
  normalizeWcWebhookError,
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

test('persistWcWebhookEvent rethrows non-unique and missing-duplicate errors', async () => {
  const input = {
    resource: 'products' as const,
    topic: 'product.updated',
    rawBody: '{"id":1}',
    payload: { id: 1 },
  }
  const nonUniqueError = new Error('database unavailable')
  const missingDuplicateError = uniqueError()

  await assert.rejects(
    () => persistWcWebhookEvent({
      ...makeRepository().repository,
      async createEvent() {
        throw nonUniqueError
      },
    }, input),
    /database unavailable/,
  )
  await assert.rejects(
    () => persistWcWebhookEvent({
      ...makeRepository().repository,
      async createEvent() {
        throw missingDuplicateError
      },
      async findByConnectorResourceAndPayloadHash() {
        return null
      },
    }, input),
    /Unique constraint failed/,
  )
})

test('hashWcWebhookPayload is deterministic and whitespace-sensitive', () => {
  assert.equal(hashWcWebhookPayload('{"id":1}'), hashWcWebhookPayload('{"id":1}'))
  assert.notEqual(hashWcWebhookPayload('{"id":1}'), hashWcWebhookPayload('{ "id": 1 }'))
})

test('retry delay uses exponential backoff, cap, and bounded jitter', () => {
  assert.equal(calculateWcWebhookRetryDelayMs(1, { jitterRatio: 0 }), 60_000)
  assert.equal(calculateWcWebhookRetryDelayMs(2, { jitterRatio: 0 }), 120_000)
  assert.equal(calculateWcWebhookRetryDelayMs(3, { jitterRatio: 0 }), 240_000)
  assert.equal(calculateWcWebhookRetryDelayMs(99, { jitterRatio: 0 }), 60 * 60 * 1000)

  const jittered = calculateWcWebhookRetryDelayMs(2, { jitterSeed: 'event-1:2' })
  assert.ok(jittered >= 90_000)
  assert.ok(jittered <= 150_000)
})

test('webhook inbox env parsing falls back for invalid values', () => {
  assert.equal(getWcWebhookProcessPageSize({ WC_WEBHOOK_INBOX_PROCESS_PAGE_SIZE: '12' }), 12)
  assert.equal(getWcWebhookProcessPageSize({ WC_WEBHOOK_INBOX_PROCESS_PAGE_SIZE: '0' }), 100)
  assert.equal(getWcWebhookStaleProcessingMs({ WC_WEBHOOK_INBOX_STALE_PROCESSING_MS: '9000' }), 9000)
  assert.equal(getWcWebhookStaleProcessingMs({ WC_WEBHOOK_INBOX_STALE_PROCESSING_MS: 'abc' }), 15 * 60 * 1000)
  assert.equal(getWcWebhookMaxAttempts({ WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '3' }), 3)
  assert.equal(getWcWebhookMaxAttempts({ WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '-1' }), 24)
})

test('normalizeWcWebhookError truncates oversized messages', () => {
  const message = normalizeWcWebhookError(new Error('x'.repeat(9 * 1024)))
  assert.ok(message.length < 9 * 1024)
  assert.match(message, /truncated/)
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
  assert.deepEqual(rows[0]?.nextAttemptAt, nextWcWebhookRetryAt({ attempts: 1, now, eventId: 'event-1' }))
})

test('processWcWebhookEvent skips already-claimed rows', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const row = makeRow({
    id: 'event-1',
    status: WC_WEBHOOK_EVENT_STATUS.processing,
    updatedAt: new Date('2026-05-26T09:59:00.000Z'),
  })
  const { repository } = makeRepository([row])

  const result = await processWcWebhookEvent('event-1', { repository, now })

  assert.deepEqual(result, { status: 'skipped', eventId: 'event-1', reason: 'not_due_or_already_processed' })
})

test('processWcWebhookEvent dead-letters permanent handler responses and max attempts', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const permanent = makeRow({ id: 'permanent', payloadJson: { id: 1 } })
  const exhausted = makeRow({ id: 'exhausted', attempts: 23, payloadJson: { id: 2 } })
  const { repository, rows } = makeRepository([permanent, exhausted])

  const permanentResult = await processWcWebhookEvent('permanent', {
    repository,
    now,
    async processPayload() {
      return Response.json({ error: 'bad payload' }, { status: 400 })
    },
  })
  const exhaustedResult = await processWcWebhookEvent('exhausted', {
    repository,
    now,
    env: { WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '24' },
    async processPayload() {
      throw new Error('still broken')
    },
  })

  assert.equal(permanentResult.status, 'dead_letter')
  assert.equal(exhaustedResult.status, 'dead_letter')
  assert.equal(rows.find((row) => row.id === 'permanent')?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.equal(rows.find((row) => row.id === 'exhausted')?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
})

test('processWcWebhookEvent dead-letters unsupported claimed resources', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const row = makeRow({ id: 'event-1', resource: 'unknown' })
  const { repository, rows } = makeRepository([row])

  const result = await processWcWebhookEvent('event-1', {
    repository,
    now,
    async processPayload() {
      throw new Error('processPayload should not run')
    },
  })

  assert.equal(result.status, 'dead_letter')
  assert.equal(rows[0]?.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.match(rows[0]?.lastError ?? '', /Unsupported WooCommerce webhook resource/)
})

test('processPendingWcWebhookEvents drains pending and due failed events in received order', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const { repository, rows } = makeRepository([
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

  // Expected order follows receivedAt among claimable rows: pending at 09:58,
  // stale-processing at 09:59, then due-failed at 10:00.
  assert.deepEqual(result, { attempted: 3, processed: 3, failed: 0, deadLettered: 0, skipped: 0 })
  assert.deepEqual(processedIds, ['pending', 'stale-processing', 'due-failed'])
  assert.equal(rows.find((row) => row.id === 'stale-processing')?.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.equal(rows.find((row) => row.id === 'stale-processing')?.attempts, 1)
})

test('processPendingWcWebhookEvents handles empty queues and per-event crashes', async () => {
  const now = new Date('2026-05-26T10:00:00.000Z')
  const empty = makeRepository()
  assert.deepEqual(
    await processPendingWcWebhookEvents({ repository: empty.repository, now }),
    { attempted: 0, processed: 0, failed: 0, deadLettered: 0, skipped: 0 },
  )

  const { repository } = makeRepository([makeRow({ id: 'event-1', payloadJson: { id: 1 } })])
  const result = await processPendingWcWebhookEvents({
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
