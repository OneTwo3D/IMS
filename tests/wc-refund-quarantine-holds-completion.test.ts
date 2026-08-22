import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-xnwu round 4 (Codex HIGH) — COVERAGE SHORTFALL -> QUARANTINE -> REDELIVERY, END TO END.
 *
 * Each round before this one fixed a result that could not say what had happened, and each time the
 * next layer up read the silence as success. This is the third time in the same shape: a per-refund
 * `success` BOOLEAN THAT ALSO MEANT "handled without applying". A same-order QUARANTINED
 * park returns it, applies nothing, and waits for an operator — and the sweep counted it as applied.
 * The counts then reconciled arithmetically (`synced + failed === fetched`) while the webhook's
 * held-refusal branch concluded EVERY FETCHED REFUND IS IN IMS, re-asked the coverage shortfall
 * against demand IMS does not hold, and recorded the answer PERMANENTLY — acknowledging the delivery
 * and advancing the cursor over a dispatch that is genuinely short.
 *
 * WHAT IS REAL HERE, AND IT IS THE POINT OF THE FILE. `syncWcRefund` is the real function, reaching
 * its real quarantined-park early return through a database double. `syncRefundsForOrder` is the real
 * sweep, so the real aggregation decides `unapplied`. The webhook handler is real, so the real
 * classification decides whether the cursor moves. A double that simply reported an unapplied count
 * would prove only that the arithmetic works; what is under test is that a QUARANTINE reaches it at
 * all — which is exactly the step the boolean erased.
 *
 * The order status sync is doubled, because it is this test's INPUT: it answers from the refunds IMS
 * holds, which is the coupling the whole defect lives in.
 */

type LoggedActivity = { action?: string; level?: string; metadata?: Record<string, unknown> }

const activityLog: LoggedActivity[] = []
const settingUpserts: string[] = []
const calls: string[] = []

const WC_ORDER_ID = 5101
const WC_REFUND_ID = 8801
const IMS_ORDER_ID = 'so-1'

/** Ten ordered, eight covered by shipment lines: the dispatch is short by the two refunded units. */
const ORDERED_QTY = 10
const SHIPPED_QTY = 8
const REFUNDED_QTY = 2

/** The operator-resolvable state: a QUARANTINED park on THIS order for THIS refund. */
let parkIsQuarantined = true
/** Whether a SalesOrderRefund now exists for the refund — set by the real path when it applies. */
let refundLandedInIms = false

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: LoggedActivity) => { activityLog.push(entry) } },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (!path.includes('/refunds')) return { data: [], totalPages: 1, totalItems: 0 }
      const page = Number(params.page ?? '1')
      // One refund, then the empty page that is the only proof of an ending.
      const data = page === 1
        ? [{
          id: WC_REFUND_ID,
          parent_id: WC_ORDER_ID,
          date_created: '2026-08-01T00:00:00',
          date_created_gmt: '2026-08-01T00:00:00',
          amount: '20.00',
          reason: '',
          refunded_by: 1,
          refunded_payment: true,
          meta_data: [],
          line_items: [],
        }]
        : []
      return { data, totalPages: 1, totalItems: 1 }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

/** The refund the sweep applies once the park is gone. Never called while the park stands. */
let createRefundCalls = 0
mock.module('@/app/actions/sales', {
  namedExports: {
    createRefund: async () => {
      createRefundCalls += 1
      refundLandedInIms = true
      return { success: true }
    },
  },
})

const shoppingSyncLogWrites: Array<Record<string, unknown>> = []

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
      salesOrder: {
        findFirst: async () => ({
          id: IMS_ORDER_ID,
          externalOrderNumber: String(WC_ORDER_ID),
          fxRateToBase: 1,
          // Untaxed: the monetary-only basis resolves to a zero rate rather than refusing, so this
          // test exercises the QUARANTINE branch and not the basis refusal.
          totalBase: 100,
          taxBase: 0,
          taxRatePercent: 0,
          shippingBase: 0,
          taxForeign: 0,
          shippingForeign: 0,
          lines: [],
        }),
      },
      salesOrderRefund: {
        findFirst: async () => (refundLandedInIms ? { id: 'r-1', orderId: IMS_ORDER_ID } : null),
      },
      shoppingSyncLog: {
        findFirst: async () => (parkIsQuarantined
          ? { entityId: IMS_ORDER_ID, status: 'QUARANTINED' }
          : null),
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          shoppingSyncLogWrites.push(data)
          return data
        },
      },
      warehouse: { findFirst: async () => ({ id: 'wh-1' }) },
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: { importWcOrder: async () => ({ success: true, orderId: IMS_ORDER_ID }) },
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
 * The real contract: the coverage check nets ordered demand against the refunds IMS HOLDS, and a
 * shortfall is classified `permanent` — which is what makes burying it unrecoverable.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: {
    syncWcOrderStatus: async () => {
      calls.push('status')
      const demand = ORDERED_QTY - (refundLandedInIms ? REFUNDED_QTY : 0)
      const uncovered = demand - SHIPPED_QTY
      if (uncovered <= 0) return { success: true }
      return {
        success: false,
        error: 'External fulfillment would mark this order shipped without covering everything '
          + `ordered: WIDGET (${uncovered} of ${demand} uncovered).`,
        refusal: 'coverage_shortfall',
        permanent: true,
      }
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

async function deliverCompletedOrder() {
  calls.push('deliver')
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'orders',
    topic: 'order.updated',
    payload: {
      id: WC_ORDER_ID,
      number: String(WC_ORDER_ID),
      status: 'completed',
      date_modified_gmt: '2026-08-01T10:00:00',
      line_items: [],
      meta_data: [],
    },
    originAttestation: WEBHOOK_ORIGIN_NOT_APPLICABLE,
  })
}

test('o3d-xnwu r4: a QUARANTINED refund holds the cursor until manual resolution reapplies the completion', async () => {
  activityLog.length = 0
  settingUpserts.length = 0
  calls.length = 0
  shoppingSyncLogWrites.length = 0
  createRefundCalls = 0
  parkIsQuarantined = true
  refundLandedInIms = false

  // ---------------------------------------------------------------------------------------------
  // DELIVERY 1 — the refund that would make this dispatch complete is quarantined, awaiting an
  // operator. The sweep READS it and HANDLES it, and applies nothing.
  // ---------------------------------------------------------------------------------------------
  const first = await deliverCompletedOrder()
  const firstBody = await first.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 0, 'a quarantined refund is not re-attempted — that is what handled means')
  assert.equal(first.status, 500, 'the delivery FAILS, so a redelivery will re-decide it')
  assert.equal(
    firstBody.permanentFailures,
    undefined,
    'THE DEFECT: the shortfall must not be recorded as a permanent business refusal on the strength '
    + 'of a refund that was handled rather than applied',
  )
  assert.ok(
    firstBody.failures?.some((f) => /1 of 1 refunds read for this order are not in IMS/.test(f)),
    'the unapplied refund is named — a handled-but-unapplied refund produced no line at all before this',
  )
  assert.ok(
    firstBody.failures?.some((f) => /without covering everything ordered/.test(f)),
    'and the held refusal is released as TRANSIENT rather than buried',
  )
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'THE CURSOR STAYS HELD: nothing may advance past an order whose refunds are in an operator inbox',
  )
  assert.deepEqual(
    activityLog.filter((entry) => entry.action === 'wc_order_webhook_rejected'),
    [],
    'a transient failure is not a business rejection',
  )
  // The sweep is the REAL one, so it pushes nothing here: what this records is that the completion
  // was judged ONCE and, the order being unsettled, never re-asked.
  assert.deepEqual(calls, ['deliver', 'status'], 'an unsettled order buys no second look')

  // ---------------------------------------------------------------------------------------------
  // A REDELIVERY WHILE THE PARK STANDS CHANGES NOTHING. The condition is one only a human can
  // clear, so the delivery keeps failing and the cursor keeps its place.
  // ---------------------------------------------------------------------------------------------
  const second = await deliverCompletedOrder()
  assert.equal(second.status, 500, 'still held')
  assert.equal(createRefundCalls, 0)
  assert.equal(settingUpserts.includes('last_wc_order_sync_at'), false, 'still held')

  // ---------------------------------------------------------------------------------------------
  // MANUAL RESOLUTION — the operator resolves the park. The next redelivery applies the refund and
  // the completion, re-asked against demand IMS now really holds, succeeds.
  // ---------------------------------------------------------------------------------------------
  parkIsQuarantined = false
  calls.length = 0

  const third = await deliverCompletedOrder()
  const thirdBody = await third.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 1, 'with the park resolved the refund is applied for real')
  assert.equal(third.status, 200)
  assert.equal(thirdBody.ok, true)
  assert.equal(thirdBody.permanentFailures, undefined, 'the dispatch is complete, so nothing is refused')
  assert.deepEqual(calls, ['deliver', 'status', 'status'],
    'judged, refunds applied, judged AGAIN — and only the second reading is classified')
  assert.ok(
    settingUpserts.includes('last_wc_order_sync_at'),
    'and only NOW does the cursor advance',
  )
})
