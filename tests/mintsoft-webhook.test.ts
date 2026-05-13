import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import * as authModuleNs from '../lib/connectors/mintsoft/api/auth.ts'
import * as webhookValidationModuleNs from '../lib/connectors/mintsoft/webhook-validation.ts'
import * as webhookEventsModuleNs from '../lib/connectors/mintsoft/webhook-events.ts'
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

const { isLegacyMintsoftBodyOnlySignatureAllowed, verifyMintsoftWebhookSignature } = authModule
const {
  extractMintsoftWebhookTimestamp,
  extractMintsoftWebhookTimestampCandidate,
  isMintsoftWebhookTimestampFresh,
} = webhookValidationModule
const { persistMintsoftWebhookEvent } = webhookEventsModule

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

test('verifyMintsoftWebhookSignature only accepts legacy body-only signatures behind the flag', () => {
  const secret = 'top-secret'
  const rawBody = JSON.stringify({ eventId: 'evt-1' })
  const signature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret, {
    timestamp: '2026-04-22T10:00:00.000Z',
  }), false)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, signature, secret, {
    timestamp: '2026-04-22T10:00:00.000Z',
    allowLegacyBodyOnly: true,
  }), true)
})

test('isLegacyMintsoftBodyOnlySignatureAllowed defaults off and accepts explicit true only', () => {
  assert.equal(isLegacyMintsoftBodyOnlySignatureAllowed({}), false)
  assert.equal(isLegacyMintsoftBodyOnlySignatureAllowed({ MINTSOFT_ALLOW_LEGACY_BODY_ONLY_SIGNATURE: 'false' }), false)
  assert.equal(isLegacyMintsoftBodyOnlySignatureAllowed({ MINTSOFT_ALLOW_LEGACY_BODY_ONLY_SIGNATURE: 'true' }), true)
  assert.equal(isLegacyMintsoftBodyOnlySignatureAllowed({ MINTSOFT_ALLOW_LEGACY_BODY_ONLY_SIGNATURE: 'TRUE' }), true)
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
