import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateWcOrderWebhookEcho,
  type ShoppingSyncLogPayload,
} from '@/lib/connectors/woocommerce/sync/order-webhook-echo'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/**
 * Echo detection had NO test while it was silently discarding refunds (o3d-uxv): a
 * partial refund leaves the WC order status untouched, so an inbound order.updated
 * carrying a refund looked identical to the echo of the status we pushed at ship time.
 *
 * The discriminator is WooCommerce's own clock. Our push records the date_modified_gmt
 * WC reported straight afterwards; the echo of that push carries the same stamp, while
 * anything changed later carries a greater one.
 */

const PUSHED_AT = '2026-07-15T12:00:00'
const LATER = '2026-07-15T12:03:30'

function order(overrides: Partial<WcFullOrder> = {}): WcFullOrder {
  return {
    id: 1001,
    number: '1001',
    status: 'processing',
    date_modified_gmt: PUSHED_AT,
    line_items: [],
    meta_data: [],
    ...overrides,
  } as unknown as WcFullOrder
}

const statusPush = (pushedDateModifiedGmt?: string): ShoppingSyncLogPayload => ({
  status: 'processing',
  pushedDateModifiedGmt,
})

test('suppresses the echo of our own status push', async () => {
  // Same status AND unchanged since our push -> this is our own write coming back.
  const verdict = evaluateWcOrderWebhookEcho([statusPush(PUSHED_AT)], order({ date_modified_gmt: PUSHED_AT }))
  assert.deepEqual(verdict, { suppress: true, reason: 'status_echo' })
})

test('does NOT suppress a change made after our push, even when the status is unchanged', async () => {
  // THE REGRESSION (o3d-uxv). A partial refund leaves status 'processing', so the old
  // status-only rule classed it as our echo and the refund was lost: no SalesOrderRefund,
  // no credit note, no COGS reversal, and ok:true back to Woo so it never retried.
  const verdict = evaluateWcOrderWebhookEcho([statusPush(PUSHED_AT)], order({ date_modified_gmt: LATER }))
  assert.deepEqual(verdict, { suppress: false }, 'a later modification is a genuine change, not our echo')
})

test('treats a tie as our own write', async () => {
  // WC's timestamp has one-second resolution, so a change within the same second as our
  // push is genuinely indistinguishable. Suppressing there only skips one status sync
  // (which re-syncs on the next event); the alternative risks the echo dragging the IMS
  // status backwards. Safer side of an unavoidable ambiguity.
  const verdict = evaluateWcOrderWebhookEcho([statusPush(PUSHED_AT)], order({ date_modified_gmt: PUSHED_AT }))
  assert.equal(verdict.suppress, true)
})

test('falls back to status-only matching when the push recorded no timestamp', async () => {
  // Log rows written before we captured pushedDateModifiedGmt (they age out of the
  // 10-minute window). We cannot tell, so behave as before rather than guess.
  const verdict = evaluateWcOrderWebhookEcho([statusPush(undefined)], order({ date_modified_gmt: LATER }))
  assert.deepEqual(verdict, { suppress: true, reason: 'status_echo' })
})

test('keeps looking at older pushes when the newest one is ruled out', async () => {
  // A ruled-out entry must not short-circuit the scan: an older push may still be the
  // echo this webhook belongs to.
  const verdict = evaluateWcOrderWebhookEcho(
    [statusPush(PUSHED_AT), statusPush(LATER)],
    order({ date_modified_gmt: LATER }),
  )
  assert.deepEqual(verdict, { suppress: true, reason: 'status_echo' })
})

test('does not suppress when the status differs from anything we pushed', async () => {
  const verdict = evaluateWcOrderWebhookEcho([statusPush(PUSHED_AT)], order({ status: 'completed' }))
  assert.deepEqual(verdict, { suppress: false })
})

test('parses WC GMT stamps that carry no zone suffix', async () => {
  // WooCommerce sends "2026-07-15T12:00:00" with no Z. Parsed as LOCAL time this would
  // be wrong by the host's UTC offset — enough to misclassify an echo either way on a
  // non-UTC box.
  const oneSecondLater = '2026-07-15T12:00:01'
  const verdict = evaluateWcOrderWebhookEcho([statusPush(PUSHED_AT)], order({ date_modified_gmt: oneSecondLater }))
  assert.deepEqual(verdict, { suppress: false }, 'one second later must read as later, not as the same instant')
})


/**
 * The TRACKING arm had the identical flaw, found by the Codex review of PR #488: matching
 * tracking proves the TRACKING is unchanged since our push, not that nothing else changed.
 * Tracking stays identical across a later genuine status change, so after a ship-time
 * tracking push EVERY order.updated in the 10-minute window looked like our echo and had
 * its status sync skipped.
 */
const TRACKING = [{ tracking_number: 'TRK1', tracking_provider: 'Custom', date_shipped: '1784154150' }]

const trackingPush = (pushedDateModifiedGmt?: string): ShoppingSyncLogPayload => ({
  meta_key: '_wc_shipment_tracking_items',
  items: TRACKING,
  pushedDateModifiedGmt,
})

function orderWithTracking(dateModifiedGmt: string): WcFullOrder {
  return {
    id: 1001,
    number: '1001',
    status: 'processing',
    date_modified_gmt: dateModifiedGmt,
    line_items: [],
    meta_data: [{ id: 1, key: '_wc_shipment_tracking_items', value: TRACKING }],
  } as unknown as WcFullOrder
}

test('suppresses the echo of our own tracking push', async () => {
  const verdict = evaluateWcOrderWebhookEcho([trackingPush(PUSHED_AT)], orderWithTracking(PUSHED_AT))
  assert.deepEqual(verdict, { suppress: true, reason: 'tracking_echo' })
})

test('does NOT suppress a change made after our tracking push, even though tracking is unchanged', async () => {
  // The regression: an admin completes the order (or a refund lands) minutes after we
  // pushed tracking. Tracking is byte-identical, so the old rule called it our echo and
  // skipped the status sync.
  const verdict = evaluateWcOrderWebhookEcho([trackingPush(PUSHED_AT)], orderWithTracking(LATER))
  assert.deepEqual(verdict, { suppress: false }, 'unchanged tracking does not mean unchanged order')
})

test('tracking echo falls back to payload matching when the push recorded no timestamp', async () => {
  // Rows written before pushedDateModifiedGmt existed; they age out of the window.
  const verdict = evaluateWcOrderWebhookEcho([trackingPush(undefined)], orderWithTracking(LATER))
  assert.deepEqual(verdict, { suppress: true, reason: 'tracking_echo' })
})
