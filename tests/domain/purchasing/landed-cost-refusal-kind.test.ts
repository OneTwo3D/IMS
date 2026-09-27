import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r7 (review LOW 3) — WHICH KIND A REFUSED LANDED-COST JOURNAL IS RECORDED UNDER, BY BEHAVIOUR.
 *
 * r6's only check on the landed-cost reporters' kinds was a count floor in the kinds census, so the reviewer's
 * X4 (the COGS reporter naming the transit kind) survived until the floor happened to move. Here the real
 * queueLandedCostAdjustmentJournals runs against a refusing enqueue and the kind each report carries is read
 * off the call — the kind decides whether the row offers "Mark as handled" and so whether hand-posting it
 * suppresses the outbox's retry of that exact posting (review H-B).
 */
const reports: Array<{ action: string; kind: string; outcome: { reason?: string } }> = []

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      connector: 'xero', inventoryAccount: 'INV', transitAccount: 'GIT', cogsAccount: 'COGS', consumedCogsOffsetAccount: 'OFF',
      cogsVarianceAccount: 'VAR', allocatedInventoryAccount: 'ALLOC',
    }),
    queueAccountingSync: async () => ({ queued: false, reason: 'refused', connector: 'xero' }),
    queueAccountingSyncTx: async (_tx: unknown, params: { reportOutcome?: (o: unknown) => void }) => {
      params.reportOutcome?.({ queued: false, reason: 'refused', connector: 'xero' })
      return false
    },
  },
})
mock.module('@/lib/domain/accounting/enqueue-outcome', {
  namedExports: {
    postingIsOwed: (outcome: { queued: boolean; reason?: string }) => !outcome.queued && outcome.reason !== 'not-configured',
    reportPostingNotQueued: async (params: { action: string; kind: string; outcome: { reason?: string } }) => { reports.push(params) },
  },
})
mock.module('@/lib/db', { namedExports: { db: { $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}) } } })
mock.module('@/lib/domain/accounting/cogs-subledger-movement', { namedExports: { recordCogsSubledgerMovement: async () => {} } })
mock.module('@/lib/domain/accounting/transit-subledger-movement', { namedExports: { recordTransitSubledgerMovement: async () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

test('[o3d-j625 r7 LOW 3] a refused transit reclass and a refused COGS journal are each recorded under their OWN retried kind', async () => {
  const { queueLandedCostAdjustmentJournals } = await import('@/lib/domain/purchasing/landed-cost-service')
  const adjustment = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: null, eventKey: 'recalc-1', totalDelta: 25 }
  const run = await queueLandedCostAdjustmentJournals({
    inventoryTransitAdjustments: [adjustment],
    cogsAdjustments: [adjustment],
  } as never)
  assert.equal(run.owed, 2, 'PRECONDITION: both refused, both owed')
  assert.deepEqual(reports.map((r) => [r.action, r.kind]), [
    ['landed_cost_reclass_not_queued', 'landed_cost_transit_journal'],
    ['landed_cost_cogs_journal_not_queued', 'landed_cost_cogs_journal'],
  ])
  const { postingRefusalMarkable } = await import('@/lib/domain/accounting/posting-refusal-kinds')
  assert.ok(reports.every((r) => postingRefusalMarkable(r.kind)), 'and both offer the button, whose mark suppresses the outbox retry')
})
