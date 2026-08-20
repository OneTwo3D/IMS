import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { scheduleInboxDrain } from '@/lib/jobs/shopping/drain-inbox'
import { importWcOrder } from '@/lib/connectors/woocommerce/sync/order-import'
import { syncWcOrderStatus } from '@/lib/connectors/woocommerce/sync/order-status'
import { syncRefundsForOrder, syncWcRefund } from '@/lib/connectors/woocommerce/sync/refund-sync'
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
  const lastMs = lastLoggedAtIso ? Date.parse(lastLoggedAtIso) : NaN
  return !Number.isFinite(lastMs) || nowMs - lastMs >= INITIAL_IMPORT_SKIP_LOG_THROTTLE_MS
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
    const guarded = await importWcOrderGuarded(
      wcOrder,
      () => importWcOrder(wcOrder),
    )
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
    if (!suppressed.suppress && !suppressionHandled) {
      const statusResult = await syncWcOrderStatus(wcOrder)
      if (!statusResult.success) {
        const detail = `syncWcOrderStatus: ${statusResult.error ?? 'unknown error'}`
        if (statusResult.permanent) permanentFailures.push(detail)
        else failures.push(detail)
      }
    }
    try {
      await syncRefundsForOrder(wcOrder.id)
    } catch (e) {
      failures.push(`syncRefundsForOrder: ${e instanceof Error ? e.message : String(e)}`)
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
        ? `WooCommerce product webhook for ${productPayload.sku} was sent by ${origin.deliveryHost}, which is not the `
          + `store this installation is bound to (${origin.boundHost}). Nothing was imported and no stock was `
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
        deliveryHost: origin.deliveryHost,
        boundHost: origin.boundHost,
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
