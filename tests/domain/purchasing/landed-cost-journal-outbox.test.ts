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

function makeDeps(over: Partial<LandedCostOutboxDrainDeps> & { jobs?: ReturnType<typeof makeJob>[]; throwOnQueue?: boolean; owed?: number }) {
  const calls = { queued: 0, success: 0, retry: 0 }
  const deps: LandedCostOutboxDrainDeps = {
    claimWork: async () => (over.jobs ?? []) as never,
    queueJournals: async () => {
      calls.queued++
      if (over.throwOnQueue) throw new Error('queue failed')
      return { owed: over.owed ?? 0 }
    },
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

// o3d-j625 r4 (SWEEP 1): a run whose journals were REFUSED is not a succeeded job.
test('[o3d-j625 r4] drain: a run that leaves journals OWED marks the job retryable, not succeeded', async () => {
  const { deps, calls } = makeDeps({ jobs: [makeJob({ inventoryTransitAdjustments: [adj(5)], cogsAdjustments: [] })], owed: 2 })
  const res = await processLandedCostJournalOutbox(deps)
  assert.equal(calls.queued, 1, 'PRECONDITION: the journals were attempted')
  assert.equal(calls.success, 0, 'the backstop must not stop caring about journals it could not queue')
  assert.equal(calls.retry, 1)
  assert.deepEqual(res, { claimed: 1, succeeded: 0, failed: 1 })
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

// o3d-j625 r6/r7 — the outbox retry re-runs the SAME recalculation result, and each journal's key is a
// function of the adjustment alone: so a journal refused by ANY caller (the direct ones schedule the outbox
// too) is raised again by the outbox under the same key — which is why r7 made these `retried` kinds whose
// mark-handled suppresses exactly that key (review H-B).
test('[o3d-j625 r6 H4] the outbox retry raises the SAME landed-cost postings', async () => {
  const { landedCostAdjustmentIdempotencyKey } = await import('@/lib/domain/purchasing/landed-cost-service')
  const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
  const adj = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: null, eventKey: 'recalc-1', totalDelta: 12.5 } as never
  for (const [kind, type] of [['cogs', 'COGS_JOURNAL'], ['inventory', 'STOCK_IN_TRANSIT']] as const) {
    const first = accountingPostingKey({ type, referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: landedCostAdjustmentIdempotencyKey(kind, adj) })
    const retry = accountingPostingKey({ type, referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: landedCostAdjustmentIdempotencyKey(kind, adj) })
    assert.deepEqual(retry, first, `${type}: a retry of the same adjustment is the same posting`)
  }
})
