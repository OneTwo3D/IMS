import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-hqvrp.103: the completion job re-reads IMS on every attempt. An order IMS reopened or un-shipped while the job waited out a
 * WooCommerce outage is SUPERSEDED: the job succeeds and sends NOTHING to WooCommerce (no tracking, no status). No network.
 */
const state = { imsStatus: 'SHIPPED' as string | null, events: [] as string[], marked: [] as string[], served: false, activity: [] as Array<Record<string, unknown>> }

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findUnique: async () => (state.imsStatus === null ? null : { status: state.imsStatus }) },
      integrationOutbox: { count: async () => 1, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    },
  },
})
mock.module('@/lib/domain/integrations/outbox', {
  namedExports: {
    buildOutboxIdempotencyKey: (...parts: string[]) => parts.join(':'),
    enqueueIntegrationOutbox: async () => ({}),
    isOutboxEnqueueShadowed: () => false,
    claimIntegrationOutboxWork: async () => {
      if (state.served) return []
      state.served = true
      return [{ id: 'job-1', attempts: 0, lockedAt: new Date(), payloadJson: { orderId: 'o-1' } }]
    },
    markIntegrationOutboxPermanentFailure: async () => ({}),
    markIntegrationOutboxRetryableFailure: async () => { state.marked.push('retry'); return { status: 'RETRYABLE_FAILED' } },
    markIntegrationOutboxSuccess: async () => { state.marked.push('success') },
    currentOutboxRowBeforeCutoff: async () => null,
    refuseClaimedJobBeforeCutoff: async () => null,
  },
})
mock.module('@/lib/connectors/woocommerce/producer-egress', { namedExports: { wooDrainHold: () => ({ held: false }) } })
mock.module('@/lib/connectors/woocommerce/sync/order-status-claim-gate', {
  namedExports: { WC_DRAIN_CLAIM_BUDGET_MS: 60_000, WC_DRAIN_SCAN_WINDOW: 10, wcOrderStatusClaimGate: async () => true },
})
mock.module('@/lib/shopping', {
  namedExports: {
    pushOrderDeliveryMetadata: async () => { state.events.push('tracking'); return { success: true } },
    pushSalesOrderStatus: async () => { state.events.push('status'); return { success: true, outcome: { kind: 'pushed' } } },
  },
})

beforeEach(() => { state.imsStatus = 'SHIPPED'; state.events = []; state.marked = []; state.served = false; state.activity = [] })

async function runJob() {
  const { processWcOrderCompletionJobs } = await import('@/lib/connectors/woocommerce/sync/order-completion-jobs')
  return processWcOrderCompletionJobs({ idempotencyKeys: ['k'], now: new Date() })
}

test('control: an order still SHIPPED is completed (tracking first, then status)', async () => {
  const summary = await runJob()
  assert.equal(summary.succeeded, 1)
  assert.deepEqual(state.events, ['tracking', 'status'])
})

for (const status of ['PROCESSING', 'ALLOCATED', 'CANCELLED', 'ON_HOLD', null]) {
  test(`an order IMS moved to ${status ?? 'nothing (deleted)'} is superseded: success, no WooCommerce request`, async () => {
    state.imsStatus = status
    const summary = await runJob()
    assert.equal(summary.claimed, 1, 'precondition: the job was claimed')
    assert.equal(summary.succeeded, 1)
    assert.deepEqual(state.events, [], 'nothing was pushed to WooCommerce')
    assert.deepEqual(state.marked, ['success'])
    assert.ok(state.activity.some((entry) => entry.action === 'wc_completion_superseded'))
  })
}
