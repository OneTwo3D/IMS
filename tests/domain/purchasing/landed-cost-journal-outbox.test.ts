import assert from 'node:assert/strict'
import test from 'node:test'

import {
  landedCostResultHasJournals,
  landedCostOutboxPayloadToRecalcResult,
  processLandedCostJournalOutbox,
  scheduleLandedCostJournalOutbox,
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

test('drain: a payload missing the adjustment arrays is malformed → retry, not silent success', async () => {
  // The scheduler only enqueues fully-formed results, so {} is malformed (Codex review).
  const { deps, calls } = makeDeps({ jobs: [makeJob({})] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.equal(res.failed, 1)
  assert.equal(calls.retry, 1)
  assert.equal(calls.queued, 0)
})

test('drain: no jobs → nothing happens', async () => {
  const { deps, calls } = makeDeps({ jobs: [] })
  const res = await processLandedCostJournalOutbox(deps)
  assert.deepEqual(res, { claimed: 0, succeeded: 0, failed: 0 })
  assert.equal(calls.queued, 0)
})

test('scheduleLandedCostJournalOutbox enqueues ON THE PASSED tx client (atomicity) with a delayed drain + per-recalc key', async () => {
  // Prove the enqueue uses the transaction client (not the global db), so the
  // outbox row commits/rolls back atomically with the recalc (Codex review).
  const created: Array<{ data: Record<string, unknown> }> = []
  const tx = {
    integrationOutbox: {
      create: async (args: { data: Record<string, unknown> }) => { created.push(args); return { id: 'o1', ...args.data } },
      findUnique: async () => null,
    },
  } as never

  const now = new Date('2026-06-13T00:00:00.000Z')
  await scheduleLandedCostJournalOutbox(
    tx,
    { inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [], auditRunIds: ['run-1'] },
    { now, graceMs: 90_000 },
  )
  assert.equal(created.length, 1) // create invoked on the tx client, not db
  assert.equal(created[0].data.connector, 'accounting')
  assert.equal(created[0].data.operation, 'landed-cost.adjustment-journal')
  // Drain is delayed past the immediate direct call (no race).
  assert.equal((created[0].data.nextAttemptAt as Date).getTime(), now.getTime() + 90_000)
  // Per-recalc identity in the key so a later identical recalc still gets its own row.
  const key1 = created[0].data.idempotencyKey as string
  created.length = 0
  await scheduleLandedCostJournalOutbox(tx, { inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [], auditRunIds: ['run-2'] }, { now })
  assert.notEqual(created[0].data.idempotencyKey, key1)
})

test('scheduleLandedCostJournalOutbox is a no-op for a zero-delta recalc', async () => {
  let createCalls = 0
  const tx = { integrationOutbox: { create: async () => { createCalls++; return {} }, findUnique: async () => null } } as never
  await scheduleLandedCostJournalOutbox(tx, { inventoryTransitAdjustments: [adj(0)], cogsAdjustments: [], auditRunIds: ['r'] })
  assert.equal(createCalls, 0)
})
