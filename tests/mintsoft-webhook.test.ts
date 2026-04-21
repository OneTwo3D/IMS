import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import * as authModuleNs from '../lib/connectors/mintsoft/api/auth.ts'
import * as webhookEventsModuleNs from '../lib/connectors/mintsoft/webhook-events.ts'
import type { PersistMintsoftWebhookEventInput } from '../lib/connectors/mintsoft/webhook-events.ts'

const authModule = 'default' in authModuleNs
  ? authModuleNs.default as typeof import('../lib/connectors/mintsoft/api/auth.ts')
  : authModuleNs
const webhookEventsModule = 'default' in webhookEventsModuleNs
  ? webhookEventsModuleNs.default as typeof import('../lib/connectors/mintsoft/webhook-events.ts')
  : webhookEventsModuleNs

const { verifyMintsoftWebhookSignature } = authModule
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

test('verifyMintsoftWebhookSignature accepts both hex and base64 HMAC digests', () => {
  const secret = 'top-secret'
  const rawBody = JSON.stringify({ eventId: 'evt-1' })
  const hex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const base64 = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')

  assert.equal(verifyMintsoftWebhookSignature(rawBody, hex, secret), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, `sha256=${hex}`, secret), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, base64, secret), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, `${base64} `, secret), true)
  assert.equal(verifyMintsoftWebhookSignature(rawBody, 'wrong', secret), false)
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
