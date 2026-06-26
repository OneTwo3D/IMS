import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  deriveShipheroStatusRank,
  extractShipheroEventId,
  extractShipheroFulfillmentStatus,
  extractShipheroOrderRef,
  isShipheroWebhookEventType,
  normalizeShipheroEventType,
  rankShipheroFulfillmentStatus,
} from '../lib/connectors/shiphero/webhook-validation.ts'
import {
  buildShipheroWebhookRetryUpdate,
  buildShipheroWebhookSweepWhere,
  decideShipheroWebhookApplication,
  getShipheroWebhookSweeperPageSize,
} from '../lib/jobs/wms/process-shiphero-webhook-event.ts'
import {
  persistShipheroWebhookEvent,
  type ShipheroWebhookEventRepository,
} from '../lib/connectors/shiphero/webhook-events.ts'

test('normalizeShipheroEventType canonicalises hyphens and the cancelled spelling', () => {
  assert.equal(normalizeShipheroEventType('shipment-update'), 'shipment_update')
  assert.equal(normalizeShipheroEventType('Order-Allocated'), 'order_allocated')
  assert.equal(normalizeShipheroEventType('order-cancelled'), 'order_canceled') // British → US
  assert.equal(normalizeShipheroEventType('inventory_update'), 'inventory_update')
  assert.equal(normalizeShipheroEventType('bogus'), null)
  assert.equal(isShipheroWebhookEventType('shipment-update'), true)
  assert.equal(isShipheroWebhookEventType('nope'), false)
})

test('rankShipheroFulfillmentStatus orders the lifecycle and treats cancel as terminal', () => {
  assert.equal(rankShipheroFulfillmentStatus('pending'), 0)
  assert.equal(rankShipheroFulfillmentStatus('allocated'), 2)
  assert.equal(rankShipheroFulfillmentStatus('partially_fulfilled'), 3)
  assert.equal(rankShipheroFulfillmentStatus('fulfilled'), 4)
  assert.equal(rankShipheroFulfillmentStatus('CANCELED'), 5)
  assert.equal(rankShipheroFulfillmentStatus('cancelled'), 5) // spelling normalised
  assert.equal(rankShipheroFulfillmentStatus('unknown'), null)
  assert.equal(rankShipheroFulfillmentStatus(null), null)
})

test('extractShipheroEventId prefers a remote id and falls back to a body hash', () => {
  assert.equal(extractShipheroEventId({ webhook_id: 'w1' }, 'b'), 'w1')
  assert.equal(extractShipheroEventId({ event_id: 'e1' }, 'b'), 'e1')
  assert.equal(extractShipheroEventId({ id: 123 }, 'b'), '123')
  assert.equal(extractShipheroEventId({}, 'body'), createHash('sha256').update('body').digest('hex'))
})

test('extractShipheroOrderRef + fulfillment status read top-level and nested order', () => {
  assert.equal(extractShipheroOrderRef({ order_id: 'o1' }), 'o1')
  assert.equal(extractShipheroOrderRef({ legacy_id: 555 }), '555')
  assert.equal(extractShipheroOrderRef({ order: { id: 'oi' } }), 'oi')
  assert.equal(extractShipheroOrderRef({}), null)
  assert.equal(extractShipheroFulfillmentStatus({ fulfillment_status: 'fulfilled' }), 'fulfilled')
  assert.equal(extractShipheroFulfillmentStatus({ order: { fulfillment_status: 'allocated' } }), 'allocated')
})

test('deriveShipheroStatusRank uses payload status, with event-type fallback', () => {
  assert.equal(deriveShipheroStatusRank('shipment_update', { fulfillment_status: 'fulfilled' }), 4)
  assert.equal(deriveShipheroStatusRank('shipment_update', { fulfillment_status: 'partially_fulfilled' }), 3)
  assert.equal(deriveShipheroStatusRank('order_canceled', {}), 5) // fallback to canceled
  assert.equal(deriveShipheroStatusRank('order_allocated', {}), 2) // fallback to allocated
  assert.equal(deriveShipheroStatusRank('inventory_update', { quantity_on_hand: 5 }), null) // no order status
})

test('decideShipheroWebhookApplication refuses strictly-lower ranks (monotonic guard)', () => {
  assert.equal(decideShipheroWebhookApplication({ statusRank: 2, appliedRank: 4 }), 'superseded') // stale
  assert.equal(decideShipheroWebhookApplication({ statusRank: 4, appliedRank: 2 }), 'apply') // advances
  assert.equal(decideShipheroWebhookApplication({ statusRank: 4, appliedRank: 4 }), 'apply') // equal still applies
  assert.equal(decideShipheroWebhookApplication({ statusRank: null, appliedRank: 4 }), 'apply') // inventory always applies
  assert.equal(decideShipheroWebhookApplication({ statusRank: 3, appliedRank: null }), 'apply') // first status
})

test('buildShipheroWebhookRetryUpdate backs off, caps, and dead-letters at the max', () => {
  const now = new Date('2026-06-26T00:00:00.000Z')
  const r0 = buildShipheroWebhookRetryUpdate({ attempts: 0, lastError: 'x', now, random: () => 0.5 })
  assert.equal(r0.processingStatus, 'PENDING_RETRY')
  assert.equal(r0.processingAttempts, 1)
  assert.equal(r0.nextRetryAt?.getTime(), now.getTime() + 60_000) // base, jitter ×1.0 at random 0.5
  assert.equal(r0.deadLetteredAt, null)

  const r2 = buildShipheroWebhookRetryUpdate({ attempts: 2, lastError: 'x', now, random: () => 0.5 })
  assert.equal(r2.nextRetryAt?.getTime(), now.getTime() + 240_000) // base × 2^2

  const capped = buildShipheroWebhookRetryUpdate({ attempts: 8, lastError: 'x', now, random: () => 0.5 })
  assert.equal(capped.nextRetryAt?.getTime(), now.getTime() + 30 * 60_000) // capped at 30m

  const dead = buildShipheroWebhookRetryUpdate({ attempts: 9, lastError: 'boom', now })
  assert.equal(dead.processingStatus, 'DEAD')
  assert.equal(dead.processingAttempts, 10)
  assert.equal(dead.deadLetteredAt?.getTime(), now.getTime())
  assert.equal(dead.nextRetryAt, null)
})

test('buildShipheroWebhookSweepWhere selects PENDING + due PENDING_RETRY', () => {
  const now = new Date('2026-06-26T00:00:00.000Z')
  const where = buildShipheroWebhookSweepWhere(now)
  assert.equal(where.connector, 'shiphero')
  assert.equal(where.processedAt, null)
  assert.deepEqual(where.OR, [
    { processingStatus: 'PENDING' },
    { processingStatus: 'PENDING_RETRY', nextRetryAt: { lte: now } },
  ])
})

test('getShipheroWebhookSweeperPageSize honours a valid env override', () => {
  assert.equal(getShipheroWebhookSweeperPageSize({}), 250)
  assert.equal(getShipheroWebhookSweeperPageSize({ SHIPHERO_WEBHOOK_SWEEPER_PAGE_SIZE: '50' }), 50)
  assert.equal(getShipheroWebhookSweeperPageSize({ SHIPHERO_WEBHOOK_SWEEPER_PAGE_SIZE: 'oops' }), 250)
  assert.equal(getShipheroWebhookSweeperPageSize({ SHIPHERO_WEBHOOK_SWEEPER_PAGE_SIZE: '-5' }), 250)
})

// In-memory staging repository for the idempotency test.
function makeRepo(seed: { processedExternalId?: string } = {}) {
  const byExternal = new Map<string, { id: string; processedAt: Date | null }>()
  let seq = 0
  if (seed.processedExternalId) byExternal.set(seed.processedExternalId, { id: 'pre', processedAt: new Date() })
  const repo: ShipheroWebhookEventRepository = {
    async createEvent(input) {
      if (byExternal.has(input.externalEventId)) {
        const err = new Error('unique') as Error & { code?: string }
        err.code = 'P2002'
        throw err
      }
      const id = `ev-${(seq += 1)}`
      byExternal.set(input.externalEventId, { id, processedAt: null })
      return { id }
    },
    async findEvent(externalEventId) {
      const found = byExternal.get(externalEventId)
      return found ? { id: found.id, processedAt: found.processedAt } : null
    },
    async updatePendingEvent(id) {
      for (const entry of byExternal.values()) {
        if (entry.id === id) return entry.processedAt == null
      }
      return false
    },
  }
  return { repo }
}

const isP2002 = (error: unknown) => (error as { code?: string })?.code === 'P2002'
const baseInput = { eventType: 'shipment_update' as const, externalOrderId: 'o1', statusRank: 4, payload: {} }

test('persistShipheroWebhookEvent: create, then update-while-pending, then duplicate', async () => {
  const { repo } = makeRepo()
  const created = await persistShipheroWebhookEvent(repo, { ...baseInput, externalEventId: 'e1' }, { isUniqueConstraintError: isP2002 })
  assert.equal(created.status, 'created')

  const updated = await persistShipheroWebhookEvent(repo, { ...baseInput, externalEventId: 'e1' }, { isUniqueConstraintError: isP2002 })
  assert.equal(updated.status, 'updated') // same event, still pending → refreshed

  const dup = makeRepo({ processedExternalId: 'e2' })
  const duplicate = await persistShipheroWebhookEvent(dup.repo, { ...baseInput, externalEventId: 'e2' }, { isUniqueConstraintError: isP2002 })
  assert.equal(duplicate.status, 'duplicate') // already processed
})
