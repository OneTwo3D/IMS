import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xnwu: a WooCommerce completion that DID NOT become an IMS shipment must change what the
 * caller does.
 *
 * `processWcCompletion` ended with a bare `await applyExternalFulfillmentUpdate({ ... })` and threw
 * the result away. A call whose return value is discarded cannot fail: `syncWcOrderStatus` returned
 * `{ success: true }` on the next line, the webhook was acknowledged (`ok: true`), the order-sync
 * cursor advanced, and nothing retried or dead-lettered. Every refusal reason took that route — the
 * coverage shortfall added by o3d-okbd, and the older "requires physical stock" one, which produced
 * no record at all.
 *
 * These drive the REAL `syncWcOrderStatus` and the REAL `processWcCompletion`. Only the fulfilment
 * boundary is doubled, because it is the return value under test.
 *
 * NOTE ON WHAT IS ASSERTED. The primary assertion in each case is the OUTCOME `syncWcOrderStatus`
 * hands back, because that is what the webhook (`lib/connectors/woocommerce/webhooks.ts`) branches
 * on: `permanent` goes to `permanentFailures` → acknowledged + logged at WARNING (o3d-bx9), and a
 * transient failure goes to `failures` → HTTP 500 → redelivered (o3d-i0y). Asserting only that a
 * log line appeared would reproduce the defect exactly — the activity log was already the ONE thing
 * that worked, and it changed nobody's behaviour.
 */

type Row = Record<string, unknown>

const state = {
  imsStatus: 'PROCESSING',
  withdrawalApprovedAt: null as Date | null,
  /** What the fulfilment boundary answers. Rewritten per test. */
  fulfilment: { success: true } as Row,
  fulfilmentCalls: [] as Row[],
  activity: [] as Row[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: {
        findUnique: async () => ({
          order: {
            id: 'so-1', externalOrderNumber: '5001', status: state.imsStatus,
            withdrawalHoldAt: null, withdrawalApprovedAt: state.withdrawalApprovedAt,
          },
        }),
      },
      shoppingStatusMapping: { findMany: async () => [] },
      salesOrder: {
        findUnique: async () => ({
          withdrawalApprovedAt: state.withdrawalApprovedAt,
          status: state.imsStatus,
        }),
      },
      $queryRaw: async () => [{ id: 'so-1' }],
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        $queryRaw: async () => [{ id: 'so-1' }],
        salesOrder: {
          findUnique: async () => ({
            withdrawalApprovedAt: state.withdrawalApprovedAt,
            status: state.imsStatus,
          }),
        },
      }),
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: { handleWcWithdrawalStatus: async () => ({ kind: 'not-a-withdrawal' as const }) },
})

mock.module('@/lib/fulfillment/external-fulfillment', {
  namedExports: {
    applyExternalFulfillmentUpdate: async (update: Row) => {
      state.fulfilmentCalls.push(update)
      return state.fulfilment
    },
  },
})

function reset() {
  state.imsStatus = 'PROCESSING'
  state.withdrawalApprovedAt = null
  state.fulfilment = { success: true }
  state.fulfilmentCalls = []
  state.activity = []
}

const wcOrder = { id: 5001, number: '5001', status: 'completed', line_items: [], meta_data: [] }

async function syncCompleted() {
  const { syncWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return syncWcOrderStatus(wcOrder as never)
}

test('o3d-xnwu: a COVERAGE-SHORTFALL refusal makes the caller report failure, and PERMANENTLY', async () => {
  reset()
  state.fulfilment = {
    success: false,
    error: 'External fulfillment would mark this order shipped without covering everything ordered: WIDGET (4 of 10 uncovered).',
    refusal: 'coverage_shortfall',
    permanent: true,
  }

  const result = await syncCompleted()

  // THE POINT. This used to be `{ success: true }` — the webhook answered ok, the cursor advanced,
  // and an order the store had marked completed silently never became an IMS shipment.
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /without covering everything ordered/)
  // PERMANENT routes it to the webhook's `permanentFailures`: acknowledged and logged loudly rather
  // than retried ~24 times to a dead letter, because the same payload reaches the same conclusion.
  assert.equal(result.permanent, true)
  // Secondary: the order carries a record an operator can find. Secondary on purpose — a log line
  // is what the broken version already had.
  const refused = state.activity.filter((entry) => entry.action === 'wc_completion_fulfillment_refused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].entityId, 'so-1')
})

test('o3d-xnwu: a PHYSICAL-STOCK refusal makes the caller report a RETRYABLE failure', async () => {
  reset()
  // The pre-existing refusal, which was dropped here long before o3d-okbd existed. It is a
  // statement about IMS stock at this instant, not about the request, so it clears the moment a
  // receipt lands: transient, and the webhook's 500 is what brings it back.
  state.fulfilment = {
    success: false,
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
    refusal: 'insufficient_physical_stock',
    permanent: false,
  }

  const result = await syncCompleted()

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /requires physical stock/)
  assert.notEqual(result.permanent, true, 'a redelivery after the stock arrives is the fix, not a waste')
  assert.equal(
    state.activity.filter((entry) => entry.action === 'wc_completion_fulfillment_refused').length,
    1,
    'and it is no longer the case that this refusal produces literally no record',
  )
})

test('o3d-xnwu: a fulfilment that SUCCEEDS still reports success (the control)', async () => {
  reset()
  state.fulfilment = { success: true }

  const result = await syncCompleted()

  assert.equal(result.success, true)
  assert.equal(state.fulfilmentCalls.length, 1, 'the completion really did run')
  assert.equal(state.fulfilmentCalls[0].targetShipmentStatus, 'SHIPPED')
  assert.deepEqual(
    state.activity.filter((entry) => entry.action === 'wc_completion_fulfillment_refused'),
    [],
    'nothing was refused, so nothing may be reported as refused',
  )
})

test('o3d-xnwu: a completion refused because the customer WITHDREW is still acknowledged, not failed', async () => {
  reset()
  // The deliberate skip (o3d-e1yb). It is not a fulfilment failure: the order is exactly where it
  // should be and the refusal is already logged. Turning it into `success: false` would make the
  // webhook retry — or acknowledge as "rejected" — something that was correctly handled. This is
  // the case a bare `success: !refused` would get wrong, which is why the outcome is discriminated.
  state.withdrawalApprovedAt = new Date('2026-08-01T00:00:00Z')

  const result = await syncCompleted()

  assert.equal(result.success, true)
  assert.deepEqual(state.fulfilmentCalls, [], 'and no stock was allocated for withdrawn goods')
  assert.equal(
    state.activity.filter((entry) => entry.action === 'wc_completion_refused_withdrawn').length,
    1,
  )
})
