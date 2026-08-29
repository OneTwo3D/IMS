import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-xnwu round 5 (Codex HIGH) — A TERMINALLY UNAPPLIABLE REFUND MUST NOT HOLD THE DELIVERY.
 *
 * Round 4 stopped a HANDLED-BUT-UNAPPLIED refund settling a held completion refusal, and it was
 * right to: a quarantined park is a refund an operator can still record, and burying the shortfall
 * behind it acknowledges a dispatch IMS genuinely cannot cover. But `handled-unapplied` covered TWO
 * endings, and the other one needs the opposite treatment:
 *
 *   OPERATOR-RESOLVABLE — a QUARANTINED park. It may yet be applied, so holding is waiting for
 *   something that can actually arrive. That case is tests/wc-refund-quarantine-holds-completion.ts
 *   and it must keep behaving exactly as it did.
 *
 *   TERMINALLY SUPPRESSED — a refund the payment poller's CHARGEBACK already reversed. No credit
 *   note is raised and none ever will be; nothing an operator does in IMS changes it. Held on that,
 *   the delivery returns HTTP 500 for ever and the cursor never advances — the endless retry
 *   o3d-bx9 removed, reintroduced by the fix for the opposite hole.
 *
 * The same cut runs through the FAILURES, which is why the second test here is a CROSS-ORDER refund:
 * WooCommerce has it attached to a different IMS order, so it can never become demand this order
 * carries, and holding for it dead-letters every delivery just the same.
 *
 * WHAT IS REAL HERE. `syncWcRefund` is the real function, reaching its real prior-chargeback branch
 * and its real cross-order ownership refusal through a database double. `syncRefundsForOrder` is the
 * real sweep, so the real aggregation decides `unapplied` and `outstanding`. The webhook handler is
 * real, so the real classification decides whether the cursor moves. Only the order-status sync is
 * doubled, because it is this file's INPUT: it answers from the refunds IMS holds, which is the
 * coupling the whole defect lives in.
 */

type LoggedActivity = { action?: string; level?: string; description?: string; metadata?: Record<string, unknown> }

const activityLog: LoggedActivity[] = []
const settingUpserts: string[] = []
const calls: string[] = []
const shoppingSyncLogWrites: Array<Record<string, unknown>> = []

const WC_ORDER_ID = 6201
const WC_REFUND_ID = 9901
const IMS_ORDER_ID = 'so-1'

/** Ten ordered, eight covered by shipment lines: the dispatch is short by the two refunded units. */
const ORDERED_QTY = 10
const SHIPPED_QTY = 8

/** How `createRefund` answers — the switch between the two terminal shapes and the resolvable one. */
let refundVerdict: 'chargeback' | 'applies' = 'chargeback'
/** Whether WooCommerce has this refund attached to a DIFFERENT IMS order. */
let ownedByAnotherOrder = false
/** A QUARANTINED park on THIS order for THIS refund — the operator-resolvable control. */
let parkIsQuarantined = false
/**
 * o3d-xnwu r6: a park for THIS refund sitting on ANOTHER order, or null.
 *
 * This is the state o3d-54p's "Wrong order" recovery exists to clear, and reassigning it is modelled
 * exactly as that action leaves it: the park moves onto this order as PENDING
 * (REASSIGNED_REFUND_PARK_STATUS), which is the one actionable status `syncWcRefund` does not treat
 * as handled. Setting it to null instead would model a DELETION, which the recovery never performs
 * and which would make the test pass for the wrong reason.
 */
let foreignPark: { entityId: string; status: string } | null = null
/** Set by the real path when a SalesOrderRefund is actually created. */
let refundLandedInIms = false
let createRefundCalls = 0

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

mock.module('@/app/actions/sales', {
  namedExports: {
    createRefund: async () => {
      createRefundCalls += 1
      if (refundVerdict === 'chargeback') {
        // THE REAL REFUSAL SHAPE. The refund transaction declines because a payment-poller chargeback
        // for the same order committed first; a second credit note would double-reverse it.
        return { success: false, conflict: 'prior-chargeback', error: 'the order was already charged back' }
      }
      refundLandedInIms = true
      return { success: true }
    },
  },
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
      salesOrder: {
        findFirst: async () => ({
          id: IMS_ORDER_ID,
          externalOrderNumber: String(WC_ORDER_ID),
          fxRateToBase: 1,
          // Untaxed, so the monetary-only basis resolves to a zero rate rather than refusing: this
          // file must exercise the CHARGEBACK and CROSS-ORDER endings, not the basis quarantine.
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
        findFirst: async () => {
          if (ownedByAnotherOrder) return { id: 'r-other', orderId: 'so-somebody-else' }
          return refundLandedInIms ? { id: 'r-1', orderId: IMS_ORDER_ID } : null
        },
      },
      shoppingSyncLog: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          // Two different reads reach this double and they must not be confused: the PARK lookup
          // (status in PENDING/FAILED/QUARANTINED) and the "have we already recorded this
          // suppression?" lookup, which is keyed on the errorMessage.
          if ('errorMessage' in where) return null
          if (foreignPark) return foreignPark
          return parkIsQuarantined ? { entityId: IMS_ORDER_ID, status: 'QUARANTINED' } : null
        },
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
 * shortfall is `permanent`. A suppressed refund is NOT in IMS, so this keeps refusing — which is the
 * point. Settling the delivery must not require pretending the demand was covered.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: {
    syncWcOrderStatus: async () => {
      calls.push('status')
      const demand = ORDERED_QTY - (refundLandedInIms ? 2 : 0)
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

function reset() {
  activityLog.length = 0
  settingUpserts.length = 0
  calls.length = 0
  shoppingSyncLogWrites.length = 0
  createRefundCalls = 0
  refundVerdict = 'chargeback'
  ownedByAnotherOrder = false
  parkIsQuarantined = false
  foreignPark = null
  refundLandedInIms = false
}

test('o3d-xnwu r5: a coverage shortfall over a CHARGEBACK-SUPPRESSED refund settles instead of retrying for ever', async () => {
  reset()

  const response = await deliverCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  // The refund really did reach the suppression branch — this is the real code path, not a stub.
  assert.equal(createRefundCalls, 1, 'the sweep attempted the refund and the refund transaction refused it')
  assert.ok(
    activityLog.some((entry) => entry.action === 'refund_sync_suppressed_by_chargeback'),
    'and the per-refund record of the suppression is written where it always was',
  )

  // THE FINDING. Held on this refund, the delivery is 500 on every redelivery and the cursor never
  // moves, because nothing will ever apply it.
  assert.equal(response.status, 200, 'the delivery is ACKNOWLEDGED — waiting for this refund is waiting for nothing')
  assert.equal(body.ok, true)
  assert.equal(body.failures, undefined, 'nothing here is transient')
  assert.ok(
    settingUpserts.includes('last_wc_order_sync_at'),
    'THE CURSOR ADVANCES: an endless hold on an unappliable refund is the behaviour o3d-bx9 removed',
  )

  // AND IT IS NOT SILENTLY COUNTED AS APPLIED. The suppressed refund is still `unapplied`, so the
  // coverage check still sees the dispatch as short — and says so, permanently, on the RE-ASK.
  assert.deepEqual(calls, ['deliver', 'status', 'status'],
    'judged, refunds swept, judged AGAIN — only the second reading is classified')
  assert.ok(
    body.permanentFailures?.some((f) => /can NEVER be applied in IMS/.test(f)),
    'the terminally unappliable refund leaves a record of its own on the delivery',
  )
  assert.ok(
    body.permanentFailures?.some((f) => /1 of 1 refunds read for this order can NEVER be applied/.test(f)),
    'naming how many of how many, so an operator can reconcile exactly those',
  )
  assert.ok(
    body.permanentFailures?.some((f) => /re-asked after refund sweep/.test(f) && /without covering everything ordered/.test(f)),
    'and the shortfall itself is still refused — settling the delivery did not pretend the demand was covered',
  )
  const loud = activityLog.filter((entry) => entry.action === 'wc_order_webhook_rejected')
  assert.equal(loud.length, 1, 'the acknowledgement is logged loudly rather than passing in silence')
  assert.ok(
    JSON.stringify(loud[0].metadata).includes('can NEVER be applied in IMS'),
    'and the loud line carries the unappliable-refund record, not just the shortfall',
  )
})

test('o3d-xnwu r5: a CROSS-ORDER refund settles too — it can never become demand this order carries', async () => {
  reset()
  // WooCommerce has this refund id attached to a different IMS order. `syncWcRefund` refuses it
  // (`permanent-failure`) rather than mis-applying it, and no redelivery or operator action inside
  // IMS makes it this order's.
  ownedByAnotherOrder = true

  const response = await deliverCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 0, 'the ownership guard refuses before anything is created')
  assert.equal(response.status, 200, 'the delivery is acknowledged rather than dead-lettered')
  assert.equal(body.failures, undefined)
  assert.ok(
    settingUpserts.includes('last_wc_order_sync_at'),
    'THE CURSOR ADVANCES: round 4 held here too, and a cross-order refund never clears',
  )
  assert.ok(
    body.permanentFailures?.some((f) => /can NEVER be applied in IMS/.test(f)),
    'and it is recorded, not swallowed',
  )
  assert.deepEqual(calls, ['deliver', 'status', 'status'], 'the completion is re-asked and the second reading classified')
})

test('o3d-xnwu r5: the control — a QUARANTINED park on the same order still HOLDS the delivery', async () => {
  reset()
  // THE FENCE, NOT A BLANKET. Without this the fix is indistinguishable from "never hold for an
  // unapplied refund", which is the hole round 4 closed. Same doubles, same shortfall; the only
  // difference is that this refund is one an operator can still record.
  parkIsQuarantined = true

  const response = await deliverCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 0, 'a quarantined refund is not re-attempted — that is what handled means')
  assert.equal(response.status, 500, 'the delivery FAILS, so a redelivery re-decides it')
  assert.equal(body.permanentFailures, undefined, 'nothing is buried on the strength of a park')
  assert.ok(
    body.failures?.some((f) => /1 of 1 refunds read for this order are not in IMS/.test(f)),
    'the outstanding refund is named',
  )
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'and the cursor stays held until an operator resolves it',
  )
  assert.deepEqual(calls, ['deliver', 'status'], 'an unsettled order buys no second look')
})

// ---------------------------------------------------------------------------
// o3d-xnwu ROUND 6 (Codex HIGH) — A RECOVERABLE CROSS-ORDER PARK WAS STILL CLASSIFIED TERMINAL.
//
// Round 5 split `handled-unapplied` into resolvable and terminal, and was right to. But
// `permanent-failure` carried the same conflation one step along: it was produced by TWO refusals,
//
//   • a SalesOrderRefund that ALREADY EXISTS on another order — a created record, unrecoverable,
//     and the case the test above this one covers; and
//   • an actionable PARK sitting on another order — which o3d-54p (merged, PR #640) built a
//     recovery for. The exception inbox's "Wrong order" action asks WooCommerce whether the refund
//     is on the named order right now and, if it is, MOVES the park there as PENDING, the one
//     actionable status this sync does not treat as handled. The refund is then retryable.
//
// Classifying the second terminal settles the delivery and advances the cursor over a refund the
// product has a documented operator path for — the same burial round 5 removed for a quarantined
// park, arriving by the failure route instead of the handled one.
//
// THIS TEST IS THE ONE CODEX ASKED FOR: reassignment recovery works, AND neither the cursor nor the
// acknowledgement moves before the refund lands.
// ---------------------------------------------------------------------------

test('o3d-xnwu r6: a refund parked on ANOTHER order HOLDS the delivery — an operator can still move it', async () => {
  reset()
  // The park is on some other IMS order. Failing closed is unchanged and correct; what is under test
  // is whether the caller concludes nothing can ever change it.
  foreignPark = { entityId: 'so-somebody-else', status: 'FAILED' }
  refundVerdict = 'applies'

  const response = await deliverCompletedOrder()
  const body = await response.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 0, 'the cross-order park guard still refuses before anything is created')
  assert.equal(response.status, 500, 'THE DELIVERY IS NOT ACKNOWLEDGED: this refund can still land here')
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'AND THE CURSOR DOES NOT ADVANCE — settling over it buries a shortfall an operator can clear',
  )
  assert.equal(body.permanentFailures, undefined, 'nothing is written off on the strength of a movable park')
  assert.ok(
    body.failures?.some((f) => /1 of 1 refunds read for this order are not in IMS/.test(f)),
    'it is counted OUTSTANDING, not terminally unappliable',
  )
  assert.deepEqual(calls, ['deliver', 'status'], 'an unsettled order buys no second look, exactly as a quarantine does not')
})

test('o3d-xnwu r6: after the "Wrong order" reassignment the very next delivery lands the refund', async () => {
  // THE RECOVERY ITSELF, end to end. The park moves onto this order as PENDING — which is precisely
  // what `REASSIGNED_REFUND_PARK_STATUS` is and precisely why it is PENDING rather than the status it
  // had — and the next sweep falls straight through the guard to the refund. Nothing else changes.
  reset()
  foreignPark = { entityId: 'so-somebody-else', status: 'FAILED' }
  refundVerdict = 'applies'

  const held = await deliverCompletedOrder()
  assert.equal(held.status, 500, 'blocked first, so the recovery below is what changes the answer')
  assert.equal(settingUpserts.includes('last_wc_order_sync_at'), false)

  // The operator asserts "this refund belongs to WooCommerce order 6201, not there". o3d-54p verifies
  // that against a fresh WooCommerce read and moves the park.
  foreignPark = { entityId: IMS_ORDER_ID, status: 'PENDING' }

  const settled = await deliverCompletedOrder()
  const body = await settled.json() as { ok: boolean; failures?: string[]; permanentFailures?: string[] }

  assert.equal(createRefundCalls, 1, 'THE REFUND IS ATTEMPTED once the park is its own order\'s')
  assert.equal(refundLandedInIms, true, 'and it LANDS — a reassigned park is retryable, not resolved-away')
  assert.equal(settled.status, 200, 'only now is the delivery acknowledged')
  assert.equal(body.failures, undefined)
  assert.equal(body.permanentFailures, undefined, 'the shortfall is covered by the refund, so nothing is refused')
  assert.ok(
    settingUpserts.includes('last_wc_order_sync_at'),
    'AND ONLY NOW DOES THE CURSOR ADVANCE — after the refund is in IMS, never before it',
  )
})

test('o3d-xnwu r6: an ALREADY-CREATED refund on another order is still terminal', async () => {
  // THE FENCE. Reserving terminal for the unrecoverable case is half the finding; without this the
  // change is indistinguishable from "nothing is ever terminal", which reinstates the endless retry
  // o3d-bx9 removed. A created SalesOrderRefund is not a park: there is nothing for the "Wrong order"
  // recovery to move, and a WC refund id maps to one order.
  //
  // (Targeted mutation that fails this: make the `existing.orderId !== so.id` branch return
  // 'cross-order-park-resolvable'.)
  reset()
  ownedByAnotherOrder = true

  const response = await deliverCompletedOrder()
  const body = await response.json() as { ok: boolean; permanentFailures?: string[] }

  assert.equal(response.status, 200, 'acknowledged rather than dead-lettered')
  assert.ok(settingUpserts.includes('last_wc_order_sync_at'), 'and the cursor advances')
  assert.ok(
    body.permanentFailures?.some((f) => /can NEVER be applied in IMS/.test(f)),
    'recorded, not swallowed',
  )
})
