import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  handleMintsoftBookedInWebhook,
  type MintsoftBookedInWebhookRouteDependencies,
} from '../app/api/webhooks/mintsoft/asn-booked-in/route.ts'
import * as authModuleNs from '../lib/connectors/mintsoft/api/auth.ts'
import * as webhookValidationModuleNs from '../lib/connectors/mintsoft/webhook-validation.ts'
import * as webhookEventsModuleNs from '../lib/connectors/mintsoft/webhook-events.ts'
import type { MintsoftWebhookEventRepository } from '../lib/connectors/mintsoft/webhook-events.ts'
import type { PersistMintsoftWebhookEventInput } from '../lib/connectors/mintsoft/webhook-events.ts'

const authModule = 'default' in authModuleNs
  ? authModuleNs.default as typeof import('../lib/connectors/mintsoft/api/auth.ts')
  : authModuleNs
const webhookValidationModule = 'default' in webhookValidationModuleNs
  ? webhookValidationModuleNs.default as typeof import('../lib/connectors/mintsoft/webhook-validation.ts')
  : webhookValidationModuleNs
const webhookEventsModule = 'default' in webhookEventsModuleNs
  ? webhookEventsModuleNs.default as typeof import('../lib/connectors/mintsoft/webhook-events.ts')
  : webhookEventsModuleNs

const {
  verifyMintsoftWebhookSignature,
} = authModule
const {
  extractMintsoftWebhookTimestamp,
  extractMintsoftWebhookTimestampCandidate,
  extractMintsoftWebhookTimestampCandidateFromRequest,
  isMintsoftWebhookTimestampFresh,
} = webhookValidationModule
const { persistMintsoftWebhookEvent } = webhookEventsModule

const WEBHOOK_SECRET = 'top-secret'

function buildInput(): PersistMintsoftWebhookEventInput {
  return {
    externalEventId: 'evt-123',
    externalAsnId: 'asn-123',
    payload: {
      id: 'evt-123',
      asnId: 'asn-123',
      bookedInQty: 5,
    },
  }
}

function buildSignedWebhookRequest(payload: Record<string, unknown>, timestamp = new Date().toISOString()): Request {
  const rawBody = JSON.stringify({ timestamp, ...payload })
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  return new Request('https://ims.example.com/api/webhooks/mintsoft/asn-booked-in', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mintsoft-signature': signature,
      'x-mintsoft-timestamp': timestamp,
    },
    body: rawBody,
  })
}

function buildWebhookRouteDependencies(
  repository: MintsoftWebhookEventRepository,
  logs: unknown[] = [],
): MintsoftBookedInWebhookRouteDependencies {
  return {
    async getMintsoftApiConfiguration() {
      return {
        baseUrl: '',
        username: '',
        password: '',
        webhookSecret: WEBHOOK_SECRET,
        orderLookupConnector: null,
      }
    },
    async isIntegrationPluginEnabled(plugin) {
      return plugin === 'mintsoft'
    },
    isUniqueConstraintError() {
      return false
    },
    async logActivity(entry) {
      logs.push(entry)
    },
    repository,
  }
}

test('verifyMintsoftWebhookSignature accepts signed timestamp and body digests', () => {
  const secret = 'top-secret'
  const rawBody = JSON.stringify({ eventId: 'evt-1' })
  const timestamp = '2026-04-22T10:00:00.000Z'
  const signedPayload = `${timestamp}.${rawBody}`
  const hex = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex')
  const base64 = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('base64')

  assert.equal(verifyMintsoftWebhookSignature(rawBody, hex, secret, { timestamp }), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, `sha256=${hex}`, secret, { timestamp }), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, base64, secret, { timestamp }), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, `${base64} `, secret, { timestamp }), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, 'wrong', secret, { timestamp }), false)
})

test('verifyMintsoftWebhookSignature binds the timestamp into the signature', () => {
  const secret = 'top-secret'
  const rawBody = JSON.stringify({ eventId: 'evt-1' })
  const timestamp = '2026-04-22T10:00:00.000Z'
  const tamperedTimestamp = '2026-04-22T10:05:00.000Z'
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')

  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret, { timestamp }), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret, { timestamp: tamperedTimestamp }), false)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret), false)
})

test('verifyMintsoftWebhookSignature rejects body-only signatures', () => {
  const secret = 'top-secret'
  const rawBody = JSON.stringify({ eventId: 'evt-1' })
  const signature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret, {
    timestamp: '2026-04-22T10:00:00.000Z',
  }), false)
})

test('persistMintsoftWebhookEvent creates a new event when none exists', async () => {
  const created: Array<{ id: string; externalEventId: string }> = []
  const input = buildInput()

  const result = await persistMintsoftWebhookEvent(
    {
      async createEvent(eventInput: PersistMintsoftWebhookEventInput) {
        created.push({ id: 'created-1', externalEventId: eventInput.externalEventId })
        return { id: 'created-1' }
      },
      async findEvent() {
        return null
      },
      async updatePendingEvent() {
        return false
      },
    },
    input,
    {
      isUniqueConstraintError() {
        return false
      },
    },
  )

  assert.deepEqual(result, {
    status: 'created',
    eventId: 'created-1',
  })
  assert.equal(created.length, 1)
  assert.equal(created[0]?.externalEventId, input.externalEventId)
})

test('persistMintsoftWebhookEvent reports duplicates for already processed events', async () => {
  const input = buildInput()

  const result = await persistMintsoftWebhookEvent(
    {
      async createEvent() {
        throw new Error('should not create')
      },
      async findEvent() {
        return {
          id: 'existing-1',
          processedAt: new Date('2026-04-21T00:00:00.000Z'),
        }
      },
      async updatePendingEvent() {
        throw new Error('should not update')
      },
    },
    input,
    {
      isUniqueConstraintError() {
        return false
      },
    },
  )

  assert.deepEqual(result, {
    status: 'duplicate',
    eventId: 'existing-1',
  })
})

test('persistMintsoftWebhookEvent updates the pending row after a concurrent unique-key race', async () => {
  const input = buildInput()
  const updates: string[] = []
  let findCalls = 0

  const result = await persistMintsoftWebhookEvent(
    {
      async createEvent() {
        const error = new Error('duplicate')
        ;(error as Error & { code?: string }).code = 'P2002'
        throw error
      },
      async findEvent() {
        findCalls += 1
        if (findCalls === 1) return null
        return {
          id: 'concurrent-1',
          processedAt: null,
        }
      },
      async updatePendingEvent(id: string) {
        updates.push(id)
        return true
      },
    },
    input,
    {
      isUniqueConstraintError(error: unknown) {
        return (error as { code?: string } | null)?.code === 'P2002'
      },
    },
  )

  assert.deepEqual(result, {
    status: 'updated',
    eventId: 'concurrent-1',
  })
  assert.deepEqual(updates, ['concurrent-1'])
})

test('Mintsoft booked-in webhook route persists and returns 202 without processing inline', async () => {
  const logs: unknown[] = []
  const createdInputs: PersistMintsoftWebhookEventInput[] = []
  const repository: MintsoftWebhookEventRepository = {
    async createEvent(input) {
      createdInputs.push(input)
      return { id: 'event-1' }
    },
    async findEvent() {
      return null
    },
    async updatePendingEvent() {
      throw new Error('updatePendingEvent should not run for a new event')
    },
  }

  const response = await handleMintsoftBookedInWebhook(
    buildSignedWebhookRequest({ eventId: 'evt-route-1', externalAsnId: 'asn-route-1' }),
    buildWebhookRouteDependencies(repository, logs),
  )
  const body = await response.json() as {
    accepted?: boolean
    externalEventId?: string
    externalAsnId?: string | null
    queued?: boolean
    pending?: boolean
  }

  assert.equal(response.status, 202)
  assert.deepEqual(body, {
    accepted: true,
    externalEventId: 'evt-route-1',
    externalAsnId: 'asn-route-1',
    queued: true,
    pending: true,
  })
  assert.equal(createdInputs.length, 1)
  assert.equal(createdInputs[0]?.externalEventId, 'evt-route-1')
  assert.equal((logs[0] as { action?: string } | undefined)?.action, 'mintsoft_webhook_event_created')
})

test('Mintsoft booked-in webhook route returns duplicate marker for processed events', async () => {
  const logs: unknown[] = []
  const repository: MintsoftWebhookEventRepository = {
    async createEvent() {
      throw new Error('createEvent should not run for a duplicate event')
    },
    async findEvent() {
      return { id: 'event-processed', processedAt: new Date('2026-04-22T10:05:00.000Z') }
    },
    async updatePendingEvent() {
      throw new Error('updatePendingEvent should not run for a processed duplicate')
    },
  }

  const response = await handleMintsoftBookedInWebhook(
    buildSignedWebhookRequest({ eventId: 'evt-route-processed', externalAsnId: 'asn-route-processed' }),
    buildWebhookRouteDependencies(repository, logs),
  )
  const body = await response.json() as {
    accepted?: boolean
    duplicate?: boolean
    externalEventId?: string
    externalAsnId?: string | null
  }

  assert.equal(response.status, 200)
  assert.deepEqual(body, {
    accepted: true,
    duplicate: true,
    externalEventId: 'evt-route-processed',
    externalAsnId: 'asn-route-processed',
  })
  assert.equal((logs[0] as { action?: string } | undefined)?.action, 'mintsoft_webhook_duplicate_ignored')
})

test('Mintsoft booked-in webhook route updates pending events and still returns 202', async () => {
  const logs: unknown[] = []
  const updatedInputs: PersistMintsoftWebhookEventInput[] = []
  const repository: MintsoftWebhookEventRepository = {
    async createEvent() {
      throw new Error('createEvent should not run for an existing pending event')
    },
    async findEvent() {
      return { id: 'event-pending', processedAt: null }
    },
    async updatePendingEvent(_id, input) {
      updatedInputs.push(input)
      return true
    },
  }

  const response = await handleMintsoftBookedInWebhook(
    buildSignedWebhookRequest({ eventId: 'evt-route-pending', externalAsnId: 'asn-route-pending' }),
    buildWebhookRouteDependencies(repository, logs),
  )
  const body = await response.json() as {
    accepted?: boolean
    externalEventId?: string
    externalAsnId?: string | null
    queued?: boolean
    pending?: boolean
  }

  assert.equal(response.status, 202)
  assert.equal(body.accepted, true)
  assert.equal(body.queued, true)
  assert.equal(body.pending, true)
  assert.equal(updatedInputs.length, 1)
  assert.equal(updatedInputs[0]?.externalEventId, 'evt-route-pending')
  assert.equal((logs[0] as { action?: string } | undefined)?.action, 'mintsoft_webhook_event_updated')
})

test('Mintsoft booked-in webhook route requires a signed timestamp header', async () => {
  const timestamp = new Date().toISOString()
  const rawBody = JSON.stringify({ timestamp, eventId: 'evt-body-timestamp', externalAsnId: 'asn-body-timestamp' })
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  const repository: MintsoftWebhookEventRepository = {
    async createEvent() {
      throw new Error('createEvent should not run without a timestamp header')
    },
    async findEvent() {
      throw new Error('findEvent should not run without a timestamp header')
    },
    async updatePendingEvent() {
      throw new Error('updatePendingEvent should not run without a timestamp header')
    },
  }

  const response = await handleMintsoftBookedInWebhook(
    new Request('https://ims.example.com/api/webhooks/mintsoft/asn-booked-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-signature': signature,
      },
      body: rawBody,
    }),
    buildWebhookRouteDependencies(repository),
  )
  const body = await response.json() as { error?: string }

  assert.equal(response.status, 401)
  assert.equal(body.error, 'Missing webhook timestamp')
})

test('extractMintsoftWebhookTimestamp prefers signed body timestamps when present', () => {
  assert.deepEqual(
    extractMintsoftWebhookTimestamp({
      id: 'evt-1',
      createdAt: '2026-04-22T10:00:00.000Z',
    })?.toISOString(),
    '2026-04-22T10:00:00.000Z',
  )

  assert.equal(
    extractMintsoftWebhookTimestamp({
      id: 'evt-1',
    }),
    null,
  )
})

test('extractMintsoftWebhookTimestampCandidate returns the exact timestamp value to sign', () => {
  assert.deepEqual(
    extractMintsoftWebhookTimestampCandidate({
      id: 'evt-1',
      timestamp: 1776852000,
    }),
    {
      date: new Date('2026-04-22T10:00:00.000Z'),
      value: '1776852000',
      source: 'payload',
      key: 'timestamp',
    },
  )

  assert.deepEqual(
    extractMintsoftWebhookTimestampCandidate(
      { id: 'evt-1' },
      { 'x-mintsoft-timestamp': '2026-04-22T10:00:00.000Z' },
    ),
    {
      date: new Date('2026-04-22T10:00:00.000Z'),
      value: '2026-04-22T10:00:00.000Z',
      source: 'header',
      key: 'x-mintsoft-timestamp',
    },
  )
})

test('extractMintsoftWebhookTimestampCandidateFromRequest requires timestamp headers', () => {
  assert.equal(
    extractMintsoftWebhookTimestampCandidateFromRequest(
      '{"eventId":"evt-1","timestamp":1776852000.0}',
    ),
    null,
  )
})

test('extractMintsoftWebhookTimestampCandidateFromRequest ignores payload timestamp collisions', () => {
  assert.deepEqual(
    extractMintsoftWebhookTimestampCandidateFromRequest(
      '{"note":"got it at \\"timestamp\\":\\"2026-01-01T00:00:00.000Z\\"","timestamp":"2026-04-22T09:00:00.000Z"}',
      { 'x-mintsoft-timestamp': '2026-04-22T10:00:00.000Z' },
    ),
    {
      date: new Date('2026-04-22T10:00:00.000Z'),
      value: '2026-04-22T10:00:00.000Z',
      source: 'header',
      key: 'x-mintsoft-timestamp',
    },
  )
})

test('numeric timestamp header signatures use the exact header value', () => {
  const secret = 'top-secret'
  const rawBody = '{"eventId":"evt-1","timestamp":1776852000.0}'
  const timestamp = extractMintsoftWebhookTimestampCandidateFromRequest(
    rawBody,
    { 'x-mintsoft-timestamp': '1776852000.0' },
  )?.value
  const canonicalSignature = createHmac('sha256', secret)
    .update(`1776852000.${rawBody}`, 'utf8')
    .digest('hex')
  const exactTokenSignature = createHmac('sha256', secret)
    .update(`1776852000.0.${rawBody}`, 'utf8')
    .digest('hex')

  assert.equal(timestamp, '1776852000.0')
  assert.equal(verifyMintsoftWebhookSignature(rawBody, canonicalSignature, secret, { timestamp }), false)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, exactTokenSignature, secret, { timestamp }), true)
})

test('extractMintsoftWebhookTimestamp falls back to common signed timestamp headers', () => {
  assert.deepEqual(
    extractMintsoftWebhookTimestamp(
      { id: 'evt-1' },
      { 'x-mintsoft-timestamp': '2026-04-22T10:00:00.000Z' },
    )?.toISOString(),
    '2026-04-22T10:00:00.000Z',
  )
})

test('isMintsoftWebhookTimestampFresh rejects stale signed timestamps', () => {
  const now = new Date('2026-04-22T10:10:00.000Z')

  assert.equal(
    isMintsoftWebhookTimestampFresh(new Date('2026-04-22T10:05:00.000Z'), now),
    true,
  )

  assert.equal(
    isMintsoftWebhookTimestampFresh(new Date('2026-04-22T09:30:00.000Z'), now),
    false,
  )
})
