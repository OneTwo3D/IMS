import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * WooCommerce raises its own stock for a refunded line inside the refund request, before IMS hears of it, so IMS owes the
 * store a stock correction. The obligation is on the refund row (tests/db/refund-stock-correction.test.ts covers it against a
 * real database); THIS file pins how the order webhook uses it:
 *   - it asks for the corrections of the delivery's order AFTER the refund sweep, never before;
 *   - it asks on EVERY delivery that carries the order, not only when this delivery applied a refund (a refund an earlier delivery
 *     committed but whose later steps failed is `already-applied` here and still owes its correction);
 *   - a failure to ask is logged and never fails the delivery (the obligation stays open and the stock reconcile retries it).
 * The webhook handler is real; the sweep and the correction queue are doubled because they are its input and its effect.
 */

const calls: string[] = []
const asked: Array<{ externalOrderId?: number }> = []
const activityLog: Array<{ action?: string; level?: string }> = []
let sweepOutcome: 'applied' | 'already-applied' | 'none' = 'none'
let askThrows = false

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: { action?: string; level?: string }) => { activityLog.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (
          where.key === 'wc_initial_import_completed' ? { value: 'true' } : null
        ),
        upsert: async () => ({}),
      },
      salesOrder: { findFirst: async () => ({ id: 'so-1' }) },
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: { importWcOrder: async () => ({ success: true, orderId: 'so-1' }) },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (_order: { id: number }, run: () => Promise<{ success: boolean; error?: string }>) => ({
      outcome: 'imported' as const,
      suppressionHandled: false,
      compensationFailed: false,
      result: await run(),
    }),
    recordWithdrawalSuppressionIfWithdrawn: async () => {},
    applyWithdrawalToLinkedOrder: async () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { syncWcOrderStatus: async () => { calls.push('status'); return { success: true } } },
})

mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    syncRefundsForOrder: async () => {
      calls.push('refunds')
      const n = sweepOutcome === 'none' ? 0 : 1
      return { synced: n, fetched: n, unapplied: 0, outstanding: 0, complete: true }
    },
    syncWcRefund: async () => ({ outcome: 'applied' }),
    refundIsInIms: (outcome: string) => outcome === 'applied' || outcome === 'already-applied',
    refundOutcomeFailed: () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/refund-stock-correction', {
  namedExports: {
    queueRefundStockCorrections: async (scope: { externalOrderId?: number }) => {
      calls.push('queue')
      asked.push(scope)
      if (askThrows) throw new Error('database unavailable')
      return { open: 0, queued: 0, failed: 0 }
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async () => {},
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

function reset() {
  calls.length = 0
  asked.length = 0
  activityLog.length = 0
  sweepOutcome = 'none'
  askThrows = false
}

async function deliver() {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'orders',
    topic: 'order.updated',
    payload: {
      id: 5001,
      number: '5001',
      status: 'processing',
      date_modified_gmt: '2026-08-01T10:00:00',
      line_items: [],
      meta_data: [],
    },
    originAttestation: WEBHOOK_ORIGIN_NOT_APPLICABLE,
  })
}

test('the corrections of the delivery order are asked for AFTER the refund sweep', async () => {
  reset()
  sweepOutcome = 'applied'
  const response = await deliver()
  assert.equal(response.status, 200)
  assert.deepEqual(asked, [{ externalOrderId: 5001 }])
  assert.ok(calls.indexOf('queue') > calls.indexOf('refunds'), 'the level must already reflect the refund')
})

test('a delivery whose sweep found its refund already applied still asks (an earlier delivery may have failed after the commit)', async () => {
  reset()
  sweepOutcome = 'already-applied'
  await deliver()
  assert.deepEqual(asked, [{ externalOrderId: 5001 }])
})

test('a delivery with no refund asks too: the obligation is read from the refund rows, not from this delivery', async () => {
  reset()
  const response = await deliver()
  assert.equal(response.status, 200)
  assert.deepEqual(asked, [{ externalOrderId: 5001 }])
})

test('a failure to look up the open corrections is logged and never fails the delivery', async () => {
  reset()
  askThrows = true
  const response = await deliver()
  assert.equal(response.status, 200, 'the refund is in IMS; the obligation stays open and the reconcile retries it')
  assert.equal(activityLog.filter((entry) => entry.action === 'wc_refund_stock_correction' && entry.level === 'WARNING').length, 1)
})

test('the reservation-release backstop pushes the released stock to the storefront (it does not defer the sync)', async () => {
  const { readFileSync } = await import('node:fs')
  const outbox = readFileSync('lib/domain/sales/refund-reservation-release-outbox.ts', 'utf8')
  const allocation = readFileSync('app/actions/allocation.ts', 'utf8')
  // The release runs autoAllocateOrder; its post-commit storefront push is skipped only by deferStockSync.
  assert.ok(!/deferStockSync/.test(outbox), 'the release drain must not defer the storefront stock sync')
  assert.match(allocation, /if \(!options\?\.deferStockSync\) \{\s*try \{\s*await enqueueStockSync\(\s*allocationResult\.syncProductIds,\s*'IMS_CHANGE'/)
})

test('the refund row is born owing its correction, in the refund transaction, for a storefront refund that returns quantity', async () => {
  const { readFileSync } = await import('node:fs')
  const service = readFileSync('lib/domain/sales/refund-service.ts', 'utf8')
  assert.match(service, /stockCorrectionRequired: storefrontRefund && refundLines\.some\(\(line\) => line\.qty > 0 && Boolean\(line\.productId\)\)/)
  // and it is inside the salesOrderRefund.create data, not a later update
  const createAt = service.indexOf('const createdRefund = await tx.salesOrderRefund.create({')
  assert.ok(createAt > 0 && service.indexOf('stockCorrectionRequired:', createAt) - createAt < 1500)
})

test('the stock reconcile drains open corrections (capped) before it processes the stock jobs', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/connectors/woocommerce/sync/reconcile.ts', 'utf8')
  const drain = source.indexOf('await queueRefundStockCorrections({ limit: 50 })')
  const process = source.indexOf('await processQueuedWcStockSyncJobs({ limit: 100 })')
  assert.ok(drain > 0, 'the reconcile drains open obligations, 50 at a time')
  assert.ok(drain < process, 'and records their jobs first so the same run processes them')
})
