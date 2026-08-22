import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-xnwu round 2 (Codex HIGH) — A COVERAGE SHORTFALL JUDGED BEFORE THE DELIVERY'S OWN REFUNDS
 * ARE IN IS JUDGED FROM STALE STATE.
 *
 * The order webhook runs the status sync FIRST — which, on a `completed` order, runs the whole
 * external-fulfilment flow — and sweeps the order's refunds AFTERWARDS. So the exact order this
 * connector exists to handle correctly, EIGHT SHIPPED OF TEN ORDERED WITH TWO REFUNDED IN THE SAME
 * DELIVERY, was refused as a coverage shortfall against demand that still counted the two, and
 * classified PERMANENT — acknowledged, cursor advanced, buried — moments before the refund that
 * makes the dispatch complete was applied by the very same delivery.
 *
 * Round 1's argument for permanence was that the answer is "computed from committed IMS state". It
 * is; committed is not the same as SETTLED, and that is the flaw. The fix is not to demote the
 * refusal to transient — that would restore the endless retries o3d-bx9 removed — it is to HOLD
 * that one refusal until the sweep has run and let the second reading be the one classified.
 *
 * WHAT IS REAL HERE. The webhook handler is real, and so is
 * `externalFulfillmentRefusalAwaitsRefunds` — the predicate that decides WHICH refusals may be
 * held is never doubled, or these tests would only be checking themselves. The status sync is
 * doubled because it is the caller's input under test, and it answers from the refunds applied SO
 * FAR, which is the coupling the bug lives in: a double that answered from a fixed script could not
 * tell the two orderings apart.
 */

type LoggedActivity = { action?: string; level?: string; metadata?: Record<string, unknown> }

const activityLog: LoggedActivity[] = []
const settingUpserts: string[] = []
/** Every significant call, in the order it happened. The ORDERING is the subject. */
const calls: string[] = []

/** The order: ten ordered, eight of them covered by shipment lines. */
const ORDERED_QTY = 10
const SHIPPED_QTY = 8
/** Refunded units IMS holds right now. The sweep is what moves this. */
let refundedQty = 0
/** What the store holds for this order, applied by the sweep. */
let storeRefundedQty = 0
/** Whether the sweep managed to read the whole refund list. */
let sweepComplete = true
/**
 * How many of the refunds the sweep READ then failed to APPLY (o3d-xnwu r3). Zero for every case
 * round 2 could express — which is why round 2's classification could not tell a settled order from
 * one whose refunds all bounced.
 */
let sweepFailed = 0
/** Set to answer with a refusal that is NOT a coverage shortfall (the control). */
let refusalOverride: { error: string; refusal: string; permanent: boolean } | null = null

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: LoggedActivity) => { activityLog.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (
          where.key === 'wc_initial_import_completed' ? { value: 'true' } : null
        ),
        upsert: async ({ where }: { where: { key: string } }) => {
          settingUpserts.push(where.key)
          return {}
        },
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
    importWcOrderGuarded: async (
      order: { id: number },
      run: () => Promise<{ success: boolean; error?: string }>,
    ) => ({
      outcome: 'imported' as const,
      suppressionHandled: false,
      compensationFailed: false,
      result: await run(),
    }),
    recordWithdrawalSuppressionIfWithdrawn: async () => {},
    applyWithdrawalToLinkedOrder: async () => false,
  },
})

/**
 * MODELS THE REAL CONTRACT: the coverage check nets ordered demand against the refunds IMS HOLDS
 * (o3d-okbd), and returns the refusal code plus the `permanent: true` classification that
 * `applyExternalFulfillmentUpdate` attaches to a coverage shortfall — the shape pinned by
 * tests/wc-completion-refusal-visible.test.ts.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: {
    syncWcOrderStatus: async () => {
      calls.push('status')
      if (refusalOverride) return { success: false, ...refusalOverride }
      const uncovered = (ORDERED_QTY - refundedQty) - SHIPPED_QTY
      if (uncovered <= 0) return { success: true }
      return {
        success: false,
        error: 'External fulfillment would mark this order shipped without covering everything '
          + `ordered: WIDGET (${uncovered} of ${ORDERED_QTY - refundedQty} uncovered).`,
        refusal: 'coverage_shortfall',
        permanent: true,
      }
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    syncRefundsForOrder: async () => {
      calls.push('refunds')
      // The refunds this delivery is carrying land HERE, which is after the completion has already
      // been judged once. `sweepFailed` of them bounce: they were READ but not APPLIED, so the
      // units they would have taken out of demand are still counted against the dispatch.
      const fetched = storeRefundedQty > 0 ? 1 : 0
      const failed = Math.min(sweepFailed, fetched)
      refundedQty = failed > 0 ? 0 : storeRefundedQty
      return {
        synced: fetched - failed,
        fetched,
        failed,
        complete: sweepComplete,
        ...(sweepComplete ? {} : { error: 'the refund list did not end within 20 pages' }),
      }
    },
    syncWcRefund: async () => ({ success: true }),
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

async function pushCompletedOrder() {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'orders',
    topic: 'order.updated',
    payload: {
      id: 5001,
      number: '5001',
      status: 'completed',
      date_modified_gmt: '2026-08-01T10:00:00',
      line_items: [],
      meta_data: [],
    },
    originAttestation: WEBHOOK_ORIGIN_NOT_APPLICABLE,
  })
}

function reset() {
  activityLog.length = 0
  settingUpserts.length = 0
  calls.length = 0
  refundedQty = 0
  storeRefundedQty = 0
  sweepComplete = true
  sweepFailed = 0
  refusalOverride = null
}

test('o3d-xnwu r2: a refund arriving in the SAME delivery as the completion settles the shortfall', async () => {
  reset()
  // Eight shipped of ten ordered, and the two that make that a complete dispatch are refunded in
  // this delivery. Before the fix: refused, permanent, acknowledged, buried.
  storeRefundedQty = 2

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(
    body.permanentFailures,
    undefined,
    'a complete dispatch must not be recorded as a permanent business refusal',
  )
  // The shape of the fix: judged, refunds applied, judged AGAIN — and only the second reading is
  // classified.
  assert.deepEqual(calls, ['status', 'refunds', 'status'])
  assert.deepEqual(
    activityLog.filter((entry) => entry.action === 'wc_order_webhook_rejected'),
    [],
    'nothing was rejected, so nothing may be logged as rejected',
  )
  assert.ok(settingUpserts.includes('last_wc_order_sync_at'), 'the delivery is complete')
})

test('o3d-xnwu r2: with the refunds in, a shortfall that still stands is STILL permanent', async () => {
  reset()
  // One refunded of the two that were missing: the dispatch is genuinely short by one unit. The
  // re-ask is not a licence to retry for ever — that is exactly the behaviour o3d-bx9 removed.
  storeRefundedQty = 1

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(response.status, 200, 'a permanent refusal is acknowledged, never retried to a dead letter')
  assert.equal(body.permanentFailures?.length, 1)
  assert.match(body.permanentFailures?.[0] ?? '', /re-asked after refund sweep/)
  assert.match(body.permanentFailures?.[0] ?? '', /1 of 9 uncovered/)
  assert.deepEqual(calls, ['status', 'refunds', 'status'])
  assert.equal(
    activityLog.filter((entry) => entry.action === 'wc_order_webhook_rejected').length,
    1,
    'and it is still logged loudly',
  )
})

test('o3d-xnwu r2: an order the store holds NO refunds for is refused on the first reading', async () => {
  reset()
  // Nothing can change the answer, so nothing is re-asked: the held verdict is released with the
  // classification it already had.
  storeRefundedQty = 0

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(response.status, 200)
  assert.equal(body.permanentFailures?.length, 1)
  assert.match(body.permanentFailures?.[0] ?? '', /2 of 10 uncovered/)
  assert.deepEqual(calls, ['status', 'refunds'], 'a sweep that applied nothing buys no second look')
})

test('o3d-xnwu r2: an INCOMPLETE refund read may not bury the shortfall', async () => {
  reset()
  // The demand this order carries is still unknown, so the refusal is not a verdict at all. The
  // delivery fails (which is what brings the redelivery that re-decides it), and the refusal is
  // classified transient rather than recorded as permanent.
  storeRefundedQty = 2
  sweepComplete = false

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[] }

  assert.equal(response.status, 500)
  assert.ok(body.failures?.some((f) => /incomplete refund read/.test(f)))
  assert.ok(
    body.failures?.some((f) => /without covering everything ordered/.test(f)),
    'the held refusal is released as TRANSIENT, so the redelivery re-decides it',
  )
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'and the cursor does not move past an order whose refunds were not read',
  )
})

test('o3d-xnwu r2: a refusal refunds cannot answer is classified immediately, not held', async () => {
  reset()
  // The control. `insufficient_physical_stock` is a statement about IMS stock, not about demand, so
  // no refund changes it — holding it would delay a verdict for nothing and cost a second run of
  // the whole fulfilment flow. The predicate that decides this is the real one.
  refusalOverride = {
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
    refusal: 'insufficient_physical_stock',
    permanent: false,
  }

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[] }

  assert.equal(response.status, 500, 'transient: the redelivery after a receipt lands is the fix')
  assert.ok(body.failures?.some((f) => /requires physical stock/.test(f)))
  assert.deepEqual(calls, ['status', 'refunds'], 'nothing was held, so nothing was re-asked')
})

test('o3d-xnwu r3: a refund that was READ but failed to APPLY may not bury the shortfall', async () => {
  reset()
  // THE FINDING. The walk visited every page and reached the empty one that ends it, so the sweep
  // is `complete` and truthfully so — and then the two refunds that make this dispatch complete
  // failed to reach IMS. Round 2 classified from `complete` alone: `synced === 0` was read as "the
  // store holds no refunds for this order", so the shortfall was recorded PERMANENT, acknowledged,
  // and the cursor advanced over an order whose refunds were still missing. A read that succeeded
  // is not an application that succeeded.
  storeRefundedQty = 2
  sweepFailed = 1

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(response.status, 500, 'transient: the redelivery re-sweeps the refunds and re-decides')
  assert.equal(body.permanentFailures, undefined, 'nothing may be buried on an unapplied refund')
  assert.ok(
    body.failures?.some((f) => /without covering everything ordered/.test(f)),
    'the held refusal is released as TRANSIENT, exactly as it is for an incomplete READ',
  )
  assert.ok(
    body.failures?.some((f) => /could not be applied/.test(f)),
    'and the unapplied refund is named — it produced no line of its own before this',
  )
  assert.deepEqual(calls, ['status', 'refunds'], 'an unsettled order buys no second look')
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'and the cursor does not move past an order whose refunds are not in IMS',
  )
  assert.deepEqual(
    activityLog.filter((entry) => entry.action === 'wc_order_webhook_rejected'),
    [],
    'a transient failure is not a business rejection',
  )
})

test('o3d-xnwu r3: an APPLIED sweep still settles the order — the fix does not refuse everything', async () => {
  reset()
  // The control for the test above. Same order, same refunds, and this time they apply. If the
  // classification had simply become "transient whenever anything is non-zero", this would fail.
  storeRefundedQty = 2
  sweepFailed = 0

  const response = await pushCompletedOrder()
  const body = await response.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(response.status, 200)
  assert.equal(body.permanentFailures, undefined)
  assert.deepEqual(calls, ['status', 'refunds', 'status'])
})
