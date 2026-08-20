import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xnwu, third half: the refusal has to survive the trip back to the webhook.
 *
 * `syncWcOrderStatus` special-cased `completed` with
 *
 *     await processWcCompletion(so.id, wcOrder)
 *     return { success: true }
 *
 * so even once the completion flow reported a refusal, the caller was still told
 * everything was fine. The webhook then acknowledged the delivery and advanced
 * its cursor, and no later delivery retried it — the same failure the withdrawal
 * branch immediately above it had already been fixed for.
 */

type CompletionResult = { success: boolean; error?: string; permanent?: boolean }

let completionResult: CompletionResult = { success: true }
const completionCalls: Array<{ orderId: string; externalOrderId: number }> = []

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

mock.module('@/lib/connectors/woocommerce/sync/completion-flow', {
  namedExports: {
    processWcCompletion: async (orderId: string, wcOrder: { id: number }) => {
      completionCalls.push({ orderId, externalOrderId: wcOrder.id })
      return completionResult
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    handleWcWithdrawalStatus: async () => ({ kind: 'not-a-withdrawal' as const }),
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: {
        findUnique: async () => ({
          order: {
            id: 'so-1',
            externalOrderNumber: '4242',
            status: 'PROCESSING',
            withdrawalHoldAt: null,
            withdrawalApprovedAt: null,
          },
        }),
      },
      shoppingStatusMapping: {
        findUnique: async () => ({ imsStatus: 'SHIPPED' }),
      },
    },
  },
})

const WC_ORDER = { id: 4242, number: '4242', status: 'completed' } as never

async function syncStatus() {
  const { syncWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return syncWcOrderStatus(WC_ORDER)
}

test('a refused completion is reported as a PERMANENT failure, not a blanket success (o3d-xnwu)', async () => {
  completionCalls.length = 0
  completionResult = {
    success: false,
    permanent: true,
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
  }

  const result = await syncStatus()

  assert.equal(completionCalls.length, 1)
  assert.deepEqual(result, {
    success: false,
    permanent: true,
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
  })
  // The webhook reads exactly this shape: `permanent` sends it to
  // `wc_order_webhook_rejected` (acknowledged, logged loudly) instead of a 500
  // retry ladder that ends in a dead letter nobody connects to this order.
})

test('a transient completion failure is reported as retryable, so the delivery is redelivered', async () => {
  completionCalls.length = 0
  completionResult = { success: false, permanent: false, error: 'Failed to update shipment to SHIPPED' }

  const result = await syncStatus()

  assert.equal(result.success, false)
  assert.notEqual(result.permanent, true, 'a 5xx is reserved for failures a redelivery can actually clear (o3d-i0y)')
  assert.equal(result.error, 'Failed to update shipment to SHIPPED')
})

test('a completion that lands still reports success', async () => {
  completionCalls.length = 0
  completionResult = { success: true }

  assert.deepEqual(await syncStatus(), { success: true })
  assert.equal(completionCalls.length, 1)
})
