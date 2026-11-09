import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * WooCommerce raises its own stock for a refunded line inside the refund request, before IMS hears of
 * it. IMS is the stock master, so once a refund is APPLIED in IMS the order webhook force-pushes IMS's
 * absolute level for the refunded products. The subject here is WHEN and FOR WHAT it does that:
 *   - after the refund sweep, never before it;
 *   - only for refunds this delivery created (a redelivery that finds them already applied pushes nothing);
 *   - forced, so the lastPushedQty dedupe cannot swallow it;
 *   - never a reason to fail the delivery.
 * The webhook handler is real; the sweep, the product lookup and the stock queue are doubled because they
 * are its inputs and its effect.
 */

const calls: string[] = []
const pushes: Array<{ productIds: string[]; reason: string; options: unknown }> = []
const activityLog: Array<{ action?: string; level?: string }> = []
let appliedRefundIds: number[] = []
let lookedUp: Array<{ externalOrderId: number; ids: readonly number[] }> = []
let productIdsForRefunds: string[] = []
let pushThrows = false

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
      return {
        synced: appliedRefundIds.length,
        fetched: appliedRefundIds.length,
        unapplied: 0,
        outstanding: 0,
        complete: true,
        appliedExternalRefundIds: appliedRefundIds,
      }
    },
    syncWcRefund: async () => ({ outcome: 'applied' }),
    refundIsInIms: (outcome: string) => outcome === 'applied' || outcome === 'already-applied',
    refundOutcomeFailed: () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/refund-stock-push', {
  namedExports: {
    productIdsForAppliedWcRefunds: async (externalOrderId: number, ids: readonly number[]) => {
      calls.push('lookup')
      lookedUp.push({ externalOrderId, ids })
      return productIdsForRefunds
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async (productIds: string[], reason: string, options: unknown) => {
      calls.push('push')
      if (pushThrows) throw new Error('queue unavailable')
      pushes.push({ productIds, reason, options })
    },
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

function reset() {
  calls.length = 0
  pushes.length = 0
  activityLog.length = 0
  lookedUp = []
  appliedRefundIds = []
  productIdsForRefunds = []
  pushThrows = false
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

test('a refund applied by this delivery force-pushes IMS stock for its products, after the sweep', async () => {
  reset()
  appliedRefundIds = [901]
  productIdsForRefunds = ['p-1', 'p-2']

  const response = await deliver()

  assert.equal(response.status, 200)
  assert.deepEqual(lookedUp, [{ externalOrderId: 5001, ids: [901] }])
  assert.deepEqual(pushes, [{ productIds: ['p-1', 'p-2'], reason: 'IMS_CHANGE', options: { force: true } }])
  assert.ok(calls.indexOf('push') > calls.indexOf('refunds'), 'the push follows the sweep: the level must already reflect the refund')
})

test('a delivery that applied no refund (money-only, or all already applied) pushes nothing', async () => {
  reset()
  const response = await deliver()
  assert.equal(response.status, 200)
  assert.deepEqual(pushes, [])
  assert.ok(!calls.includes('lookup'), 'no refund applied, no lookup')
})

test('refunds applied but with no quantity lines push nothing', async () => {
  reset()
  appliedRefundIds = [902]
  productIdsForRefunds = []
  const response = await deliver()
  assert.equal(response.status, 200)
  assert.deepEqual(pushes, [])
})

test('a failed stock queue is logged and never fails the delivery', async () => {
  reset()
  appliedRefundIds = [903]
  productIdsForRefunds = ['p-3']
  pushThrows = true

  const response = await deliver()

  assert.equal(response.status, 200, 'the refund is in IMS; a 500 would only redeliver it as already-applied')
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
