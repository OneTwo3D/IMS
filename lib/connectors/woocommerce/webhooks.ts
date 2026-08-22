import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { scheduleInboxDrain } from '@/lib/jobs/shopping/drain-inbox'
import { importWcOrder } from '@/lib/connectors/woocommerce/sync/order-import'
import { syncWcOrderStatus } from '@/lib/connectors/woocommerce/sync/order-status'
import { externalFulfillmentRefusalAwaitsRefunds } from '@/lib/fulfillment/external-fulfillment'
import {
  syncRefundsForOrder,
  syncWcRefund,
  type RefundSweepResult,
} from '@/lib/connectors/woocommerce/sync/refund-sync'
import { shouldSuppressWcOrderWebhookEcho } from '@/lib/connectors/woocommerce/sync/order-webhook-echo'
import { syncWcProductToIms } from '@/lib/connectors/woocommerce/sync/product-sync'
import {
  enqueueAndProcessImmediateWcStockSync,
  recordIncomingWcWebhook,
  shouldSuppressWcWebhookEcho,
} from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { judgeWebhookOrigin, type WebhookOriginJudgement } from '@/lib/connectors/webhook-origin'
import { readWcDeliveryOrigin } from '@/lib/connectors/woocommerce/webhook-origin'
import {
  createShoppingWebhookEventRepository,
  persistWcWebhookEvent,
  type PersistWcWebhookEventResult,
  type ShoppingWebhookEventRepository,
} from '@/lib/connectors/woocommerce/webhook-inbox'
import type { WcFullOrder, WcFullProduct, WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import type { ShoppingWebhookResource } from '@/lib/shopping'
import { getSettingValue } from '@/lib/settings-store'

type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse }

const MAX_WEBHOOK_EXTERNAL_EVENT_ID_LENGTH = 256

/** @internal Test-only dependency injection for webhook unit tests. */
export type WcWebhookDependencies = {
  getMaintenanceModeResponse: (kind: 'cron' | 'webhook') => Promise<NextResponse | null>
  verifyWebhook: (body: string, signature: string | null) => Promise<boolean>
  recordWebhookReceipt: (resource: ShoppingWebhookResource) => Promise<void>
  getWebhookProcessingGate: () => Promise<{
    enabled: boolean
    reason?: 'woocommerce_plugin_disabled' | 'wc_sync_disabled'
  }>
  persistWebhookEvent: typeof persistWcWebhookEvent
  webhookEventRepository: ShoppingWebhookEventRepository
  handleOrderWebhook: (payload: unknown, topic: string | null) => Promise<Response>
  handleProductWebhook: (payload: unknown, originAttestation: string) => Promise<Response>
  handleRefundWebhook: (payload: unknown) => Promise<Response>
}

function parseWebhookJson<T>(body: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(body) as T }
  } catch (error) {
    console.warn('[woocommerce-webhook] JSON parse failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Malformed JSON body' }, { status: 400 }),
    }
  }
}

async function recordWebhookReceipt(resource: ShoppingWebhookResource) {
  const receivedAt = new Date().toISOString()
  const keys = ['wc_webhook_last_received_at']

  if (resource === 'orders') keys.push('wc_order_webhook_last_received_at')
  if (resource === 'products') keys.push('wc_product_webhook_last_received_at')

  await Promise.all(
    keys.map((key) =>
      db.setting.upsert({
        where: { key },
        create: { key, value: receivedAt },
        update: { value: receivedAt },
      }),
    ),
  )
}

function getWebhookHeaders(request: Request) {
  // WC versions and helper plugins have used different delivery-id headers.
  // Persist a bounded copy for operator lookup only; idempotency stays based on
  // the signed body hash because delivery ids can vary across redeliveries.
  const rawExternalEventId = request.headers.get('x-wc-webhook-delivery-id')
    ?? request.headers.get('x-wc-webhook-event-id')
    ?? request.headers.get('x-wc-webhook-id')
  return {
    signature: request.headers.get('x-wc-webhook-signature'),
    topic: request.headers.get('x-wc-webhook-topic'),
    externalEventId: rawExternalEventId
      ? rawExternalEventId.slice(0, MAX_WEBHOOK_EXTERNAL_EVENT_ID_LENGTH)
      : null,
  }
}

function isWebhookPing(signature: string | null, topic: string | null) {
  return !signature && !topic
}

function isSignedActionPing(topic: string | null) {
  return !!topic && topic.startsWith('action.')
}

/**
 * czuf4: connector-owned rule for whether an empty request body is acceptable for an
 * inbound WooCommerce webhook — used by the generic shopping webhook route so its
 * body-reader doesn't hardcode WooCommerce header/topic quirks. WooCommerce may send
 * unsigned empty-body pings and signed `action.*` hooks with no JSON payload; signed
 * real webhooks still verify downstream.
 */
export function isEmptyWcWebhookBodyAllowed(request: Request): boolean {
  const { signature, topic } = getWebhookHeaders(request)
  return isWebhookPing(signature, topic) || isSignedActionPing(topic)
}

async function advanceWcOrderSyncCursor() {
  await db.setting.upsert({
    where: { key: 'last_wc_order_sync_at' },
    create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
}

// o3d-mqz: throttle the "initial import pending" skip WARNING so a live store's order webhook volume
// can't spam the activity log — one line per hour is enough to make the gap visible.
export const INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS = 60 * 60 * 1000
const INITIAL_IMPORT_SKIP_LOG_KEY = 'wc_initial_import_pending_skip_last_logged_at'

/**
 * Whether a fresh initial-import-pending skip WARNING is due, given when one was last logged (o3d-mqz).
 * True on no prior log, an unparseable timestamp (fail toward visibility), or once the throttle window
 * has elapsed. Pure so the throttle is unit-testable without the db/clock.
 */
export function shouldLogInitialImportPendingSkip(
  lastLoggedAtIso: string | null | undefined,
  nowMs: number,
): boolean {
  return shouldLogThrottledWebhookSkip(lastLoggedAtIso, nowMs)
}

/**
 * The same throttle, for any webhook skip that ACKs 200 and drops the delivery. Shared rather than
 * copied so a second silent-drop site cannot pick a different window by accident. Fails toward
 * VISIBILITY: no prior record or an unparseable one logs.
 */
export function shouldLogThrottledWebhookSkip(
  lastLoggedAtIso: string | null | undefined,
  nowMs: number,
  throttleMs: number = INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS,
): boolean {
  const lastMs = lastLoggedAtIso ? Date.parse(lastLoggedAtIso) : NaN
  return !Number.isFinite(lastMs) || nowMs - lastMs >= throttleMs
}

/**
 * Surface the initial-import-pending order-webhook discard (o3d-mqz). The guard below ACKs 200 and drops
 * every order webhook until wc_initial_import_completed is set, while wc_order_webhook_last_received_at
 * (ticked BEFORE the guard) keeps updating — so "webhooks arriving" reads healthy while NO order imports.
 * Emit a throttled WARNING so that silent gap is visible. Never throws — telemetry must not break the ACK.
 */
async function logInitialImportPendingSkip(): Promise<void> {
  try {
    const last = await db.setting.findUnique({ where: { key: INITIAL_IMPORT_SKIP_LOG_KEY } })
    if (!shouldLogInitialImportPendingSkip(last?.value, Date.now())) return
    await db.setting.upsert({
      where: { key: INITIAL_IMPORT_SKIP_LOG_KEY },
      create: { key: INITIAL_IMPORT_SKIP_LOG_KEY, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_webhook_skipped_initial_import_pending',
      tag: 'sync',
      level: 'WARNING',
      description: 'WooCommerce order webhooks are arriving but being SKIPPED — the initial order import '
        + 'has not been run (wc_initial_import_completed is not set), so no orders are importing. Run the '
        + 'initial import from the Sync page, or ignore if this store is not meant to import Woo orders.',
      resolveUser: false,
    })
  } catch (e) {
    console.error('o3d-mqz: failed to log initial-import-pending skip', e)
  }
}

// o3d-tj6v r3: throttle key for the "status not selected" order-webhook skip. Separate from the
// initial-import key so one silent drop cannot mask the other, sharing the same window.
// r5: one key PER REASON, for the same reason the initial-import key is separate — a store with a
// permanently excluded status would otherwise hold the window open and hide the first order whose
// WooCommerce status IMS has no mapping for, which is a different problem with a different fix.
const STATUS_NOT_ADMITTED_LOG_KEY = 'wc_order_webhook_status_not_admitted_last_logged_at'
const STATUS_NOT_MAPPED_LOG_KEY = 'wc_order_webhook_status_not_mapped_last_logged_at'

/**
 * Make the admission refusal visible. The delivery is ACKed, so without this the boundary would be
 * enforced exactly as silently as it was previously ignored — and an operator who unticked a status
 * months ago has no other way to find out why a particular order is missing. Throttled like the
 * initial-import skip, because an excluded status on a busy store is a high-volume event. Never
 * throws: telemetry must not turn an acknowledged skip into a retried failure.
 */
async function logWcOrderWebhookNotAdmitted(
  wcOrder: WcFullOrder,
  topic: string | null,
  reason: 'status_not_admitted' | 'status_not_mapped',
  configured: string[],
): Promise<void> {
  const notAdmitted = reason === 'status_not_admitted'
  const key = notAdmitted ? STATUS_NOT_ADMITTED_LOG_KEY : STATUS_NOT_MAPPED_LOG_KEY
  try {
    const last = await db.setting.findUnique({ where: { key } })
    if (!shouldLogThrottledWebhookSkip(last?.value, Date.now())) return
    await db.setting.upsert({
      where: { key },
      create: { key, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({
      entityType: 'SYNC',
      action: notAdmitted ? 'wc_order_webhook_status_not_admitted' : 'wc_order_webhook_status_not_mapped',
      tag: 'sync',
      level: 'INFO',
      description: notAdmitted
        ? `WooCommerce pushed order #${wcOrder.number} with status "${wcOrder.status}", which is not `
          + 'in the "Import order statuses" selection under Sync -> WooCommerce -> Order Sync '
          + `(currently ${configured.length > 0 ? configured.join(', ') : 'none selected'}), so it was not imported. `
          + 'It is queued for retry BY ORDER ID and imported by the next sweep after you tick that status — '
          + 'it does not depend on WooCommerce sending this order again. Further skips are logged at most hourly.'
        : `WooCommerce pushed order #${wcOrder.number} with status "${wcOrder.status}", which IMS has no reading `
          + 'of: there is no status mapping row for it and it is not one of WooCommerce\'s own statuses. It was '
          + 'NOT imported, because creating it would mean inventing a lifecycle status for it — the same answer '
          + 'the status sync gives for an order IMS already holds. Add a mapping under Sync -> WooCommerce -> '
          + 'Status Mappings; the order is queued for retry by order id. Further skips are logged at most hourly.',
      metadata: { externalOrderId: wcOrder.id, topic, status: wcOrder.status, reason, configured },
      resolveUser: false,
    })
  } catch (e) {
    console.error('o3d-tj6v r3: failed to log a not-admitted order webhook', e)
  }
}

async function handleOrderWebhook(payload: unknown, topic: string | null) {
  const initialImportDone = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportDone?.value !== 'true') {
    // A WITHDRAWAL is still recorded, even though the order itself is not
    // imported yet (o3d-d82p). Initial import works from page snapshots, so an
    // order that moves to a withdrawal status after its page was fetched has
    // nothing else to catch it: dropping this event let it land as paid
    // PROCESSING with no marker, and initial-import completion then sets the
    // poll cursor past the change. The tombstone is what the initial-import
    // loop consults, so it must exist before that loop reaches the order.
    if (topic === 'order.created' || topic === 'order.updated') {
      const {
        recordWithdrawalSuppressionIfWithdrawn, applyWithdrawalToLinkedOrder,
      } = await import('./sync/withdrawal')
      try {
        // An order imported EARLIER in this same still-running job is already
        // linked, and the job never revisits it — a tombstone alone would just
        // sit there while a paid PROCESSING order stayed fulfillable. Apply the
        // withdrawal to it directly.
        const applied = await applyWithdrawalToLinkedOrder(payload as WcFullOrder)
        if (!applied) await recordWithdrawalSuppressionIfWithdrawn(payload as WcFullOrder)
      } catch (e) {
        // Do NOT swallow this. Returning 200 marks the event processed, and a
        // transient database failure here recreates the exact lost-withdrawal
        // race this guard exists to close.
        console.error('o3d-d82p: failed to record a withdrawal during initial import', e)
        return NextResponse.json(
          { ok: false, error: 'Could not record the withdrawal; redeliver' },
          { status: 503 },
        )
      }
    }
    // Behaviour unchanged (still ACK 200 — WC's finite retries must not pile up); the skip is now visible.
    await logInitialImportPendingSkip()
    return NextResponse.json({ ok: true, skipped: 'initial_import_pending' })
  }

  if (topic === 'refund.created') {
    const wcRefund = payload as WcRefund
    const failures: string[] = []
    if (typeof wcRefund.parent_id === 'number') {
      try {
        const refundResult = await syncWcRefund(wcRefund.parent_id, wcRefund)
        if (!refundResult.success) failures.push(`syncWcRefund: ${refundResult.error ?? 'unknown error'}`)
      } catch (e) {
        failures.push(`syncWcRefund: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failures.length === 0) {
      await advanceWcOrderSyncCursor()
      return NextResponse.json({ ok: true })
    }
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_webhook_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce refund webhook failed; cursor not advanced so polling can retry`,
      metadata: { externalRefundId: wcRefund.id, parentOrderId: wcRefund.parent_id, failures },
    })
    // Return HTTP 500 so WooCommerce retries delivery (it treats any 2xx as
    // delivered, regardless of body). Polling reconcile is suppressed while
    // webhooks are primary, so we rely on WC's retry to recover.
    return NextResponse.json({ ok: false, failures }, { status: 500 })
  }

  const wcOrder = payload as WcFullOrder

  // `wc_sync_order_statuses` IS consulted here (o3d-tj6v r3). Round 2 exempted the webhook and
  // stated the exemption in the UI; a control that is advertised and then not enforced is the very
  // thing this branch exists to remove, and with webhooks enabled this is how nearly every order
  // arrives — so "Import order statuses" governed almost nothing.
  //
  // It governs the webhook as an ADMISSION boundary, not as a filter on every event: an order IMS
  // ALREADY HAS is never gated (that is what stops IMS silently disagreeing with the store about an
  // order it holds), while an order IMS has never seen is created only if the status it currently
  // carries is admitted. An excluded order that later moves into an admitted status is imported by
  // THAT update, from its own full payload — it never needed an `order.created` behind it.
  //
  // NOTHING IS RESOLVED HERE AT ALL (r5). Round 3 read the order link here; round 4 replaced that
  // with a settings read here and passed the answer down. Both are the same mistake in different
  // sizes — a decision taken in this handler and acted on inside `importWcOrder`, with a withdrawal
  // fence and a live-store read in between. `importWcOrder` is gated BY DEFAULT and resolves the
  // selection itself, at the read that decides create-versus-update, so this handler carries no
  // admission answer that could be stale by the time it is used, and no ingress path can be built
  // that forgets to ask.
  //
  // Kept in step with app/(dashboard)/sync/sync-client.tsx and docs/installation.md.

  const failures: string[] = []
  // Failures a stable business rule caused. Re-delivering the identical payload re-hits the identical
  // rule, so these are acknowledged rather than retried into the dead-letter queue (o3d-bx9).
  const permanentFailures: string[] = []
  // o3d-e1yb [wdraw]: never create an order the customer has already withdrawn.
  // Checked for BOTH topics: a missed order.created means the first event IMS
  // ever sees for an order can be a withdrawal update.
  const { importWcOrderGuarded } = await import('./sync/withdrawal')
  // Every ingress path goes through the same wrapper, so no topic can omit the
  // suppression check or the post-import compensation (o3d-d82p).
  let suppressionHandled = false
  if (topic === 'order.created' || topic === 'order.updated') {
    // The withdrawal wrapper runs for an excluded order TOO, and deliberately: its tombstone is
    // the fence that stops a withdrawn order being pushed to the warehouse, and an order the
    // operator excluded from import still must not ship. Only the CREATE is withheld, and it is
    // withheld INSIDE `importWcOrder` — the check the wrapper cannot make and this handler must
    // not make early.
    const guarded = await importWcOrderGuarded(wcOrder, () => importWcOrder(wcOrder))
    if (guarded.outcome === 'skipped-withdrawal') {
      return NextResponse.json({ ok: true, skipped: 'unlinked-withdrawal' })
    }
    if (guarded.outcome === 'unresolved') {
      // 503, not 409: the shared inbox classifies only 408/429/5xx as
      // retryable, so anything else is DEAD-LETTERED on the first attempt —
      // which for an order whose only ordinary event this may be means it is
      // never imported at all.
      return NextResponse.json(
        { ok: false, error: 'Could not resolve a withdrawal suppression; redeliver' },
        { status: 503 },
      )
    }
    suppressionHandled = guarded.suppressionHandled
    if (guarded.compensationFailed) {
      // The order is imported and LIVE but its withdrawal transition did not
      // land. Acknowledging would leave the IMS lifecycle wrong until an
      // independent reconciliation, so fail the delivery and let WC redeliver.
      failures.push('withdrawal compensation failed for a raced import — the order is live and withdrawn')
    }
    if (guarded.result.skipped) {
      await logWcOrderWebhookNotAdmitted(wcOrder, topic, guarded.result.skipped, guarded.result.configured ?? [])
      // ACK 200. WooCommerce's retries are finite and a redelivery re-hits the identical rule, so a
      // non-2xx here would burn them down to a dead letter for an order the operator EXCLUDED. The
      // cursor is deliberately NOT advanced: this delivery imported nothing, so it must not stand in
      // for the poll sweep's progress.
      //
      // NOT ADVANCING THE CURSOR IS NOT THE RECOVERY, and round 4 treated it as half of one. The
      // very next ADMITTED delivery advances the cursor past this order, and acknowledging THIS
      // delivery means WooCommerce never sends it again — so the only routes left are cursor-based
      // and both can miss. `importWcOrder` has already written the durable by-id row that
      // `drainWcOrderAdmissionRefusals` re-reads on the fifteen-minute sweep, plus the watermark
      // that rewinds the cursors on a widening. The queue is the guarantee; the rewind is the
      // cheap bulk case.
      return NextResponse.json({
        ok: true,
        skipped: guarded.result.skipped === 'status_not_admitted'
          ? 'status_not_selected_for_import'
          : 'status_not_mapped',
      })
    }
    if (!guarded.result.success) {
      failures.push(`importWcOrder: ${guarded.result.error ?? 'unknown error'}`)
    }
  }

  if (topic === 'order.updated') {


    // An echo makes the STATUS untrustworthy — nothing else (o3d-uxv).
    //
    // This used to `return` here, discarding the whole webhook. That silently lost real
    // changes: a PARTIAL refund does not alter the WC order status, so the refund's
    // order.updated carries the same status the IMS itself pushed at ship time, matches
    // the echo rule (order-webhook-echo.ts:68) for a full TEN MINUTES, and was dropped —
    // no SalesOrderRefund, no credit note, no COGS reversal, and `ok: true` back to Woo
    // so it never retried. Proven end to end against a live store.
    //
    // Scope the suppression to what it actually protects. The echo hazard is that
    // syncWcOrderStatus would re-apply a status we just pushed and could drag the IMS
    // BACKWARDS (e.g. echoing 'completed' over a DELIVERED order). importWcOrder cannot:
    // for an existing order it only refreshes addresses/notes/paidAt and never touches
    // status (order-import.ts:324). syncRefundsForOrder is idempotent and keyed on the
    // WC refund id. Neither writes back to WooCommerce, so skipping the status sync
    // alone keeps the loop/clobber protection intact while letting genuine changes land.
    const suppressed = await shouldSuppressWcOrderWebhookEcho(wcOrder)
    if (suppressed.suppress) {
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_order_webhook_status_echo_skipped',
        tag: 'sync',
        level: 'INFO',
        description: `Skipped the status sync for WC order #${wcOrder.number} (own echo); import and refunds still applied`,
        metadata: {
          externalOrderId: wcOrder.id,
          reason: suppressed.reason,
          topic,
          status: wcOrder.status,
        },
      })
    }

    // The import already ran through importWcOrderGuarded above, so the
    // suppression check and the post-import compensation cannot be skipped.
    //
    // suppressionHandled means a withdrawal transition was just applied to
    // this order. Do NOT then sync the STALE ordinary status over it: that
    // classifies as rejected-held and invites an operator to release a live
    // withdrawal. Refunds still process — they are keyed on the WC refund id
    // and are unaffected by the hold.
    // o3d-xnwu round 2 (Codex HIGH): A REFUSAL THE REFUNDS BELOW WOULD HAVE ANSWERED IS NOT A
    // VERDICT YET.
    //
    // The status sync runs FIRST, and on a `completed` order it runs the whole external-fulfilment
    // flow, whose coverage check nets ordered demand against the refunds IMS HAS. The refunds this
    // very delivery is carrying are swept a few lines further down. So an order shipped 8 of 10
    // with 2 refunded — a complete dispatch — is refused as a coverage shortfall and, because that
    // refusal is (correctly) permanent, ACKNOWLEDGED and buried, seconds before the refund that
    // makes it correct is applied. The state it was answered from was committed and stale, and
    // "computed from committed IMS state" was the whole argument for calling it permanent.
    //
    // The ordering is not swapped: applying refunds before the order is dispatched would change
    // what the refunds themselves do (restock and COGS reversal both key off the shipment). What
    // changes is that a refusal of this ONE kind is HELD rather than recorded, and re-asked after
    // the sweep — the second reading is the one that gets classified. Everything else is classified
    // exactly as before, and `coverage_shortfall` stays permanent once the refunds are in: making
    // it transient would restore the endless retries o3d-bx9 removed.
    let heldForRefunds: string | null = null
    if (!suppressed.suppress && !suppressionHandled) {
      const statusResult = await syncWcOrderStatus(wcOrder)
      if (!statusResult.success) {
        const detail = `syncWcOrderStatus: ${statusResult.error ?? 'unknown error'}`
        if (externalFulfillmentRefusalAwaitsRefunds(statusResult.refusal)) heldForRefunds = detail
        else if (statusResult.permanent) permanentFailures.push(detail)
        else failures.push(detail)
      }
    }
    let refundSweep: RefundSweepResult | null = null
    try {
      // An INCOMPLETE refund read is a failure of this delivery, not a detail of it. The refunds
      // that were read are already applied, but acknowledging the delivery would retire the only
      // prompt to come back for the rest — and the missing ones are demand the external-fulfilment
      // coverage check never nets, so a complete 3PL dispatch is refused until they land. A
      // retried delivery re-reads the order from page one, so this is self-clearing (o3d-ecbj r5).
      refundSweep = await syncRefundsForOrder(wcOrder.id)
      if (!refundSweep.complete) {
        failures.push(`syncRefundsForOrder: incomplete refund read — ${refundSweep.error ?? 'unknown error'}`)
      }
    } catch (e) {
      failures.push(`syncRefundsForOrder: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (heldForRefunds) {
      // o3d-xnwu round 3 (Codex HIGH): A SWEEP THAT READ EVERYTHING IS NOT A SWEEP THAT APPLIED
      // EVERYTHING.
      //
      // Round 2 moved the classification onto the SECOND reading, which was the fix, and then
      // decided WHICH second reading to take from `complete` and `synced` alone. Both of the
      // sentences it built out of them are false of a sweep that read every page and then failed to
      // apply what it fetched: `complete && synced === 0` was read as "the store holds no refunds
      // for this order", and `complete && synced > 0` as "every refund the store holds is now in
      // IMS". `syncWcRefund` refuses an order it cannot resolve, a refund WooCommerce has already
      // attached to a different order, and anything its body throws — none of which touches the
      // read — so a settled-looking sweep could be carrying nothing but refusals.
      //
      // THE ONLY STATE THAT SETTLES THE HELD REFUSAL is a read that finished AND a fetched set that
      // applied in full. That is exactly the same defect shape this branch fixed one layer down —
      // a result that cannot express failure gets read as success — so the answer is the same one:
      // the counts travel, and the classification is made from them.
      //
      //   complete, nothing fetched      the store really does hold no refunds; nothing can change
      //                                  the first answer, so it stands with its own classification.
      //   complete, all of them applied  the demand IMS holds is now the demand the store holds; the
      //                                  re-ask is the reading that gets classified.
      //   anything else                  the demand this order carries is still unknown. TRANSIENT,
      //                                  which is the direction round 2 already chose for a read
      //                                  that did not finish — an unapplied refund leaves the same
      //                                  hole in the coverage check as an unread one.
      const settledTheOrder = refundSweep !== null && refundSweep.complete && refundSweep.failed === 0
      if (settledTheOrder && refundSweep !== null && refundSweep.fetched > 0) {
        // ASK AGAIN, now that every refund the store holds for this order is in IMS. The re-ask is
        // the same call because it is idempotent by construction: allocation and shipment creation
        // are both skipped when they have already happened (the first attempt got as far as the
        // coverage check, so they had), and a completion that succeeded leaves the order in the
        // target status, which `syncWcOrderStatus` short-circuits on.
        //
        // A completion refused twice leaves two `wc_completion_fulfillment_refused` rows on the
        // order, and both are wanted: the first is what the dispatch looked like against the demand
        // IMS held, the second is what it still looks like with every refund the store has applied.
        // Only the second is classified.
        const settled = await syncWcOrderStatus(wcOrder)
        if (!settled.success) {
          const detail = `syncWcOrderStatus (re-asked after refund sweep): ${settled.error ?? 'unknown error'}`
          if (settled.permanent) permanentFailures.push(detail)
          else failures.push(detail)
        }
      } else if (settledTheOrder) {
        // The store holds no refunds for this order — `fetched === 0` on a read that finished, which
        // is the only evidence of that there is — so the first answer was already computed from the
        // settled state. It stands, with the classification it came with.
        permanentFailures.push(heldForRefunds)
      } else {
        // Either the sweep did not finish, or refunds it DID read failed to apply. Both leave the
        // demand this order carries unknown, and neither is a verdict. Classify the held refusal as
        // transient so the redelivery re-decides it rather than burying it.
        //
        // AND THE DELIVERY MUST NOT SUCCEED ON THIS PATH. An incomplete read already put its own
        // line in `failures`; an application failure did not, and until this branch there was
        // nothing at all to stop `ok: true` and the cursor advancing over it. Pushing the held
        // refusal is what fails the delivery, so the refunds are re-swept and the shortfall
        // re-decided. It is deliberately scoped to a HELD refusal rather than to every sweep that
        // failed to apply something: a refund that can never apply (one WooCommerce has attached to
        // a different order) would otherwise retry every delivery to a dead letter, which is the
        // behaviour o3d-bx9 removed.
        if (refundSweep && refundSweep.complete && refundSweep.failed > 0) {
          failures.push(
            `syncRefundsForOrder: ${refundSweep.failed} of ${refundSweep.fetched} refunds read for this `
            + 'order could not be applied, so the demand it carries is still unknown',
          )
        }
        failures.push(heldForRefunds)
      }
    }
  }

  if (failures.length === 0) {
    // A PERMANENT rejection is a resolved outcome, not a pending one: the work will never succeed, so
    // the delivery is acknowledged and the cursor advances. It is still logged loudly for visibility —
    // retrying it 24 times to a dead letter told operators nothing they could act on (o3d-bx9).
    if (permanentFailures.length > 0) {
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_order_webhook_rejected',
        tag: 'sync',
        level: 'WARNING',
        description: `WooCommerce order webhook for #${wcOrder.number} was refused by a business rule; acknowledged rather than retried`,
        metadata: { externalOrderId: wcOrder.id, topic, status: wcOrder.status, permanentFailures },
      })
    }
    await advanceWcOrderSyncCursor()
    return NextResponse.json({ ok: true, ...(permanentFailures.length > 0 ? { permanentFailures } : {}) })
  }

  await logActivity({
    entityType: 'SYNC',
    action: 'wc_order_webhook_failed',
    tag: 'sync',
    level: 'WARNING',
    description: `WooCommerce order webhook for #${wcOrder.number} had failures; cursor not advanced so polling can retry`,
    metadata: { externalOrderId: wcOrder.id, topic, status: wcOrder.status, failures, permanentFailures },
  })
  // Return HTTP 500 so the delivery is RETRIED — the inbox treats 5xx as retryable. Only genuinely
  // transient failures reach here; permanent business rejections were acknowledged above.
  return NextResponse.json({ ok: false, failures }, { status: 500 })
}

/**
 * o3d-wgl6: is this delivery from the store we are bound to RIGHT NOW?
 *
 * Read WITHOUT the advisory lock, on purpose. A rebind committing concurrently with this read
 * either lands first — we see the new store and refuse, the fail-safe direction — or lands
 * after, in which case the import that follows takes the lock itself, re-checks
 * `wc_settings_version` inside its write transaction, and abandons everything it is holding
 * (o3d-mlc7). Both orderings are already covered, so an exclusive-lock wait here would buy
 * nothing and would serialise the inbox drain behind every settings write.
 */
async function judgeWcDeliveryOrigin(originAttestation: string): Promise<WebhookOriginJudgement> {
  return judgeWebhookOrigin(originAttestation, await getSettingValue('wc_url'))
}

async function handleProductWebhook(payload: unknown, originAttestation: string) {
  const productPayload = payload as Partial<WcFullProduct> & { stock_quantity?: number | null }

  // o3d-wgl6: settled BEFORE anything else, because a delivery that does not describe this
  // store must not reach the import, the shape warning, or the forced stock correction.
  //
  // `stock_quantity` in a foreign body is the OTHER store's figure, and the correction pushes
  // it with force:true — which bypasses the echo dedupe and reopens completed stock rows. That
  // is the same cross-store write the import fence exists to prevent, arriving by a second
  // door, so the refusal has to cover both.
  const origin = await judgeWcDeliveryOrigin(originAttestation)
  if (origin.verdict === 'foreign-store' || origin.verdict === 'unproven') {
    // ACKNOWLEDGED, not retried. The payload was captured at receipt and is frozen: no retry
    // can make a store-A body describe store B, so all ~24 attempts would reach this identical
    // refusal and dead-letter. Nothing is lost — a product that exists in the store we are
    // bound to now is re-imported by the reconcile sweep against the current credentials.
    //
    // ERROR, because this is also how a WRONG rebind announces itself: a burst that does not
    // stop means a store the operator believes they have left is still sending webhooks.
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_product_webhook_foreign_store',
      tag: 'sync',
      level: 'ERROR',
      description: origin.verdict === 'foreign-store'
        ? `WooCommerce product webhook for ${productPayload.sku} was sent by ${origin.deliveryStore}, which is not the `
          + `store this installation is bound to (${origin.boundStore}). Nothing was imported and no stock was `
          + 'corrected; the delivery is acknowledged rather than retried against a store it does not describe. '
          + 'The reconcile sync re-imports this product from the current store.'
        : `WooCommerce product webhook for ${productPayload.sku} did not say which store sent it `
          + `(${origin.attestation}), so it cannot be shown to describe the store this installation is bound to. `
          + 'Nothing was imported and no stock was corrected. The reconcile sync re-imports this product from '
          + 'the current store.',
      metadata: {
        externalId: productPayload.id,
        sku: productPayload.sku,
        verdict: origin.verdict,
        originAttestation: origin.attestation,
        deliveryStore: origin.deliveryStore,
        boundStore: origin.boundStore,
        originScope: origin.scope,
      },
    })
    return NextResponse.json({ ok: true, foreignStore: true, verdict: origin.verdict })
  }
  // 'binding-unreadable' falls through DELIBERATELY: the delivery named a store, and it is our
  // own `wc_url` that is missing or malformed. Refusing here would acknowledge — permanently
  // discard — deliveries that are perfectly valid, over a misconfiguration an operator fixes in
  // minutes. The import fails "not configured" instead, which retries and self-heals.
  const canSyncProduct =
    typeof productPayload.id === 'number'
    && typeof productPayload.sku === 'string'
    && typeof productPayload.type === 'string'
    && typeof productPayload.name === 'string'
    && typeof productPayload.status === 'string'

  // Set when the product import fails, so the delivery is RETRIED rather than acknowledged (o3d-i0y).
  // Every syncWcProductToIms failure is treated as transient/retryable: its find-then-create writes make
  // even a P2002 potentially a concurrent-create race that a retry resolves, so classifying failures as
  // permanent risks discarding a legitimate update. Genuine deterministic conflicts simply retry to the
  // inbox's dead-letter limit (visible, no data loss) — far better than the old 200-ack that stranded the
  // product forever. Proper permanent/transient classification belongs with the product-write atomicity
  // fix (o3d-uh2).
  let productSyncError: string | null = null

  if (canSyncProduct) {
    // No `observedVersion` is passed, and that is not an omission (o3d-wgl6). That argument
    // fences a payload the CALLER fetched against a rebind that landed since; the origin check
    // above already answers that question for a webhook, using the sending store's own identity
    // instead of a version number, and it answers it without the two false positives a version
    // carries — a same-store key rotation and a product-id cache reset both bump the version
    // while leaving the store exactly where it was. A rebind that lands mid-import is a
    // different question, and `syncWcProductToIms` still fences that itself, under the advisory
    // lock, from the version it snapshotted (o3d-mlc7).
    const result = await syncWcProductToIms(productPayload as WcFullProduct)
    if (result.success) {
      await db.setting.upsert({
        where: { key: 'last_wc_product_sync_at' },
        create: { key: 'last_wc_product_sync_at', value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      })
    } else if (result.permanent) {
      // A deterministic conflict, of one of two kinds:
      //   - MAPPING (o3d-gtk, o3d-fsi): the GTIN, the WC id, or the SKU itself already belongs to
      //     a different IMS product.
      //   - STRUCTURE (o3d-y89x): applying this payload would have destroyed IMS-owned structure,
      //     so WooCommerce objects went unimported. That one also leaves a row on
      //     /sync/exceptions with the specific SKUs.
      // Either way, re-delivering this payload reaches the identical conclusion, so the delivery
      // is ACKNOWLEDGED rather than retried ~24 times into the dead-letter queue — and logged at
      // ERROR, because nothing will import this product until an operator acts. The description
      // names both remedies rather than only the duplicate one, which would send an operator
      // hunting a duplicate SKU that does not exist; `error` carries the specific conflict.
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_product_webhook_rejected',
        tag: 'sync',
        level: 'ERROR',
        description: `WooCommerce product webhook for ${productPayload.sku} hit a permanent mapping or structure conflict; `
          + 'acknowledged rather than retried — resolve the duplicate SKU / barcode / WooCommerce id in IMS, '
          + 'or the product-structure conflict listed on /sync/exceptions',
        metadata: {
          externalId: productPayload.id,
          sku: productPayload.sku,
          error: result.error ?? 'Unknown product sync error',
          permanent: true,
        },
      })
    } else {
      // TRANSIENT: a retry can still succeed, so this branch — and only this branch — sets
      // productSyncError and turns the delivery into a retryable HTTP 500 (o3d-i0y). Keeping the
      // two apart here is the whole point of o3d-gtk: without it, the 500 would also retry the
      // permanent conflicts above, ~24 times, into the dead-letter queue.
      //
      // This branch originally classified P2002 as permanent, then REVERTED it because a P2002 on
      // `sku` can be a concurrent-create race that a retry resolves — acking it permanent would
      // discard a legitimate update. It deferred the split to o3d-gtk, "tied to o3d-uh2", pending
      // atomic writes. Both have since landed, and o3d-gtk's classification keeps `sku` TRANSIENT
      // for exactly that reason, marking only barcode / externalProductId permanent. So the
      // precondition this branch was waiting on is satisfied, and the two compose as designed.
      productSyncError = result.error ?? 'Unknown product sync error'
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_product_webhook',
        tag: 'sync',
        level: 'WARNING',
        description: `WooCommerce product webhook import failed for ${productPayload.sku}`,
        metadata: {
          externalId: productPayload.id,
          sku: productPayload.sku,
          error: productSyncError,
        },
      })
    }
  } else if (typeof productPayload.id === 'number') {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_product_webhook',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce product webhook payload skipped for WC product ${productPayload.id}`,
      metadata: {
        externalId: productPayload.id,
        skuType: typeof productPayload.sku,
        typeType: typeof productPayload.type,
        nameType: typeof productPayload.name,
        statusType: typeof productPayload.status,
        payloadKeys: Object.keys(productPayload).sort(),
      },
    })
  }

  // Return the retryable 500 BEFORE the best-effort stock correction, so an inbox retry of a failed
  // product import re-attempts the product WITHOUT replaying the forced stock write below (force:true
  // bypasses the stock dedupe and reopens completed/permanently-failed stock rows). The stock correction
  // runs only on a product success or a stock-only webhook. Mirrors handleOrderWebhook (o3d-i0y).
  if (productSyncError) {
    return NextResponse.json({ ok: false, error: productSyncError }, { status: 500 })
  }

  if (typeof productPayload.id === 'number' && Object.prototype.hasOwnProperty.call(productPayload, 'stock_quantity')) {
    const product = await db.product.findFirst({
      where: { externalProductId: BigInt(productPayload.id) },
      select: { id: true, sku: true },
    })
    if (product) {
      const qty = typeof productPayload.stock_quantity === 'number'
        ? Math.floor(productPayload.stock_quantity)
        : null
      await recordIncomingWcWebhook(product.id, qty)
      const suppressed = await shouldSuppressWcWebhookEcho(product.id, qty)
      if (!suppressed) {
        try {
          await enqueueAndProcessImmediateWcStockSync(
            [product.id],
            'WC_WEBHOOK',
            { force: true, webhookQty: qty },
          )
        } catch (error) {
          await logActivity({
            entityType: 'SYNC',
            action: 'wc_stock_webhook',
            tag: 'sync',
            level: 'WARNING',
            description: `WooCommerce stock webhook correction failed for ${product.sku}`,
            metadata: {
              productId: product.id,
              externalId: productPayload.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }
  }

  return NextResponse.json({ ok: true })
}

async function handleRefundWebhook(payload: unknown) {
  const refundPayload = payload as WcRefund & { order_id?: number; parent_id?: number }
  const externalOrderId = refundPayload.order_id ?? refundPayload.parent_id
  if (!externalOrderId) return NextResponse.json({ error: 'Missing order_id' }, { status: 400 })

  await syncWcRefund(externalOrderId, refundPayload)
  return NextResponse.json({ ok: true })
}

async function getWebhookProcessingGate() {
  if (!(await isIntegrationPluginEnabled('woocommerce'))) {
    return { enabled: false as const, reason: 'woocommerce_plugin_disabled' as const }
  }
  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return { enabled: false as const, reason: 'wc_sync_disabled' as const }
  }
  return { enabled: true as const }
}

export async function processWcWebhookPayload(
  input: {
    resource: ShoppingWebhookResource
    topic: string | null
    payload: unknown
    /**
     * What the delivery said about the store that sent it, recorded at RECEIPT (o3d-wgl6).
     * REQUIRED, with no default: a caller that cannot say where a delivery came from has to
     * say THAT, using one of the `unproven:*` markers, rather than leave it blank and have the
     * blank read as consent.
     */
    originAttestation: string
  },
  dependencies: Pick<WcWebhookDependencies, 'handleOrderWebhook' | 'handleProductWebhook' | 'handleRefundWebhook'> = defaultDependencies,
) {
  switch (input.resource) {
    case 'orders':
      return dependencies.handleOrderWebhook(input.payload, input.topic)
    case 'products':
      return dependencies.handleProductWebhook(input.payload, input.originAttestation)
    case 'refunds':
      return dependencies.handleRefundWebhook(input.payload)
  }
}

const defaultDependencies: WcWebhookDependencies = {
  getMaintenanceModeResponse,
  verifyWebhook: verifyWcWebhook,
  recordWebhookReceipt,
  getWebhookProcessingGate,
  persistWebhookEvent: persistWcWebhookEvent,
  webhookEventRepository: createShoppingWebhookEventRepository({ connector: 'woocommerce' }),
  handleOrderWebhook,
  handleProductWebhook,
  handleRefundWebhook,
}

export async function handleWcWebhook(
  resource: ShoppingWebhookResource,
  request: Request,
  rawBody: string,
  dependencies: WcWebhookDependencies = defaultDependencies,
) {
  const maintenance = await dependencies.getMaintenanceModeResponse('webhook')
  if (maintenance) return maintenance

  const body = rawBody
  const { signature, topic, externalEventId } = getWebhookHeaders(request)

  if (isWebhookPing(signature, topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  if (!(await dependencies.verifyWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Signed pings count toward last-received telemetry, unsigned pings do not.
  await dependencies.recordWebhookReceipt(resource)

  if (isSignedActionPing(topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  const gate = await dependencies.getWebhookProcessingGate()

  // o3d-56b: PERSIST the event even when the processing gate is disabled (plugin off / wc_sync_enabled=false).
  // Previously a disabled gate returned 202 WITHOUT persisting: WooCommerce marks the delivery complete and
  // never retries, so an order placed while sync was paused for maintenance was lost with no trace on either
  // end. The event is stored as a normal PENDING row (idempotent by payload hash), so the shopping-webhook-inbox
  // cron drains it automatically once sync is re-enabled — no orders are lost across a maintenance toggle. The
  // immediate near-realtime drain is only kicked when the gate is enabled; while disabled the row simply waits.
  const parsed = parseWebhookJson<unknown>(body)
  if (!parsed.ok) return parsed.response

  // o3d-wgl6: what the STORE said about itself, taken from the delivery in hand. Recorded at
  // receipt because the request is the only place it exists — the parsed payload alone reaches
  // the inbox, and by the time a retry runs, the headers are long gone and every setting has
  // moved on. No database read: the answer is entirely the store's own statement, which is what
  // makes it survive a rebind that happens afterwards.
  const originAttestation = readWcDeliveryOrigin(request, parsed.value)

  const result: PersistWcWebhookEventResult = await dependencies.persistWebhookEvent(
    dependencies.webhookEventRepository,
    {
      resource,
      topic,
      externalEventId,
      rawBody: body,
      payload: parsed.value,
      originAttestation,
    },
  )

  if (gate.enabled && result.status === 'created') {
    // Near-realtime: kick a debounced, single-flight inbox drain for newly-received events instead of waiting
    // for the 5-min cron. Non-blocking — the cron remains the durability backstop.
    scheduleInboxDrain('woocommerce')
  }

  return NextResponse.json({
    accepted: true,
    // Persisted and awaiting processing. When the gate is disabled it is deferred until sync is re-enabled
    // (the inbox cron picks up the PENDING backlog), rather than processed near-realtime.
    queued: result.status === 'created',
    duplicate: result.status === 'duplicate',
    deferred: !gate.enabled,
    ...(gate.enabled ? {} : { reason: gate.reason }),
    eventId: result.event.id,
  }, { status: 202 })
}
