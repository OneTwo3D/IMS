import assert from 'node:assert/strict'
import test from 'node:test'

import {
  landedCostResultHasJournals,
  landedCostOutboxPayloadToRecalcResult,
  processLandedCostJournalOutbox,
  type LandedCostOutboxDrainDeps,
} from '@/lib/domain/purchasing/landed-cost-journal-outbox'
import { LandedCostJournalOutboxPayloadSchema } from '@/lib/domain/integrations/outbox-registry'

// audit-grob: the durable backstop for landed-cost adjustment journals.

const adj = (totalDelta: number) => ({ primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: null, eventKey: 'evt-1', totalDelta })

test('landedCostResultHasJournals: material deltas only', () => {
  assert.equal(landedCostResultHasJournals({ inventoryTransitAdjustments: [], cogsAdjustments: [] }), false)
  assert.equal(landedCostResultHasJournals({ inventoryTransitAdjustments: [adj(0.001)], cogsAdjustments: [] }), false) // sub-epsilon
  assert.equal(landedCostResultHasJournals({ inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [] }), true)
  assert.equal(landedCostResultHasJournals({ inventoryTransitAdjustments: [], cogsAdjustments: [adj(-12.5)] }), true)
})

test('payload schema parses + defaults freightPoId to null', () => {
  const parsed = LandedCostJournalOutboxPayloadSchema.parse({
    inventoryTransitAdjustments: [{ primaryPoId: 'po-1', primaryPoRef: 'PO-1', eventKey: 'e', totalDelta: 3 }],
    cogsAdjustments: [],
  })
  assert.equal(parsed.inventoryTransitAdjustments[0].freightPoId, null)
  const result = landedCostOutboxPayloadToRecalcResult(parsed)
  assert.equal(result.inventoryTransitAdjustments.length, 1)
  assert.deepEqual(result.warnings, [])
})

function makeJob(payloadJson: unknown) {
  return { id: 'job-1', connector: 'accounting', operation: 'landed-cost.adjustment-journal', idempotencyKey: 'k', payloadJson, status: 'PROCESSING', attempts: 0, nextAttemptAt: null, lastError: null, lockedAt: new Date('2026-06-13T00:00:00Z'), lockedBy: 'w', createdAt: new Date('2026-06-13T00:00:00Z'), updatedAt: new Date('2026-06-13T00:00:00Z') }
}

function makeDeps(over: Partial<LandedCostOutboxDrainDeps> & { jobs?: ReturnType<typeof makeJob>[]; throwOnQueue?: boolean }) {
  const calls = { queued: 0, success: 0, retry: 0 }
  const deps: LandedCostOutboxDrainDeps = {
    claimWork: async () => (over.jobs ?? []) as never,
    queueJournals: async () => { calls.queued++; if (over.throwOnQueue) throw new Error('queue failed') },
    markSuccess: async () => { calls.success++ },
    markRetry: async () => { calls.retry++ },
  }
  return { deps, calls }
}

test('drain success: queues journals + marks the job succeeded', async () => {
  const { deps, calls } = makeDeps({ jobs: [makeJob({ inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [] })] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.deepEqual(res, { claimed: 1, succeeded: 1, failed: 0 })
  assert.equal(calls.queued, 1)
  assert.equal(calls.success, 1)
  assert.equal(calls.retry, 0)
})

test('drain failure: a queue error marks the job retryable (not dropped)', async () => {
  const { deps, calls } = makeDeps({ jobs: [makeJob({ inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [] })], throwOnQueue: true })
  const res = await processLandedCostJournalOutbox(deps)
  assert.deepEqual(res, { claimed: 1, succeeded: 0, failed: 1 })
  assert.equal(calls.retry, 1)
  assert.equal(calls.success, 0)
})

test('drain: a malformed payload is marked retryable, not silently dropped', async () => {
  // totalDelta must be a finite number — a string fails the schema.
  const { deps, calls } = makeDeps({ jobs: [makeJob({ inventoryTransitAdjustments: [{ primaryPoId: 'p', primaryPoRef: 'P', eventKey: 'e', totalDelta: 'NaN' }], cogsAdjustments: [] })] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.equal(res.failed, 1)
  assert.equal(calls.retry, 1)
  assert.equal(calls.queued, 0) // parse threw before queueing
})

test('drain: a payload missing the arrays defaults to empty (valid no-op success)', async () => {
  const { deps, calls } = makeDeps({ jobs: [makeJob({})] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.equal(res.succeeded, 1)
  assert.equal(calls.queued, 1) // queued with empty adjustments → idempotent no-op downstream
})

test('drain: no jobs → nothing happens', async () => {
  const { deps, calls } = makeDeps({ jobs: [] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.deepEqual(res, { claimed: 0, succeeded: 0, failed: 0 })
  assert.equal(calls.queued, 0)
})
