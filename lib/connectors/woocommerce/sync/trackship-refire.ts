/**
 * THE TRACKSHIP RE-FIRE: ASK THE STOREFRONT TO REGISTER A SHIPPED ORDER'S TRACKING WITH TRACKSHIP AGAIN.
 *
 * Rule D10: the customer-facing tracking (the tracking page, the shipment-status e-mails) stays with WooCommerce, Advanced Shipment Tracking and
 * TrackShip. IMS stores the tracking and writes it onto the order (tracking-sync.ts); it never talks to TrackShip about it and never sends the
 * customer anything. What it does here is the one repair the retiring bridge plugin made: TrackShip registers a shipment when an order
 * completes, but that trigger has no retry of its own, so an order that completes while the storefront's cache serves a stale read of its
 * tracking is dropped for good (the 2026-07-20 burst: 7 orders with tracking and no TrackShip shipment, no shipment-status e-mail). The plugin's
 * Python sweep found those orders and fired TrackShip's own trigger again through its `/trackship/reconcile` route. This is the same repair.
 *
 * THE WOO-SIDE MECHANISM (exactly what the plugin did): `do_action('send_order_to_trackship', $order_id)`, behind TrackShip's own gate
 * `apply_filters('is_order_shipped', false, $order)`. WooCommerce's REST API cannot fire an action, so the call goes to the companion plugin
 * (lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php, 1.4.0 or later): POST /wp-json/oti/v1/order/{id}/trackship-refire, signed
 * exactly like the partial-shipment route (HMAC-SHA256 of the raw body, shared `wc_webhook_secret`, header X-OTI-Signature). The route compares
 * TrackShip's shipment rows with the order's tracking numbers and fires only for a missing one (or a pending one past an hour), so it is
 * idempotent: asking again for an order that is covered fires nothing.
 *
 * Off unless `trackship_refire_enabled` is `true`. The WRITE is an outbox job (trackship-refire-jobs.ts); this module holds the pieces that are
 * pure or do the one HTTP call.
 */
import { createHmac } from 'node:crypto'

import { getSettingValue, getSettingValues } from '@/lib/settings-store'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { isOutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import { validateWooCommerceBaseUrl } from '../url-safety'
import { currentWcAttemptSignal, assertWcAttemptMayWrite } from '../attempt-fence'
import { wooEgressHold } from '../producer-egress'

export const TRACKSHIP_REFIRE_ENABLED_SETTING = 'trackship_refire_enabled'

/** OFF BY DEFAULT: only an explicit `true` turns it on; unset, empty or anything else is off. */
export async function isTrackshipRefireEnabled(): Promise<boolean> {
  return (await getSettingValue(TRACKSHIP_REFIRE_ENABLED_SETTING)) === 'true'
}

// The plugin's numbers (the bridge plugin's TS_RECONCILE_BACKOFF_BASE, _MAX and _ALERT_ATTEMPTS, TS_PENDING_GRACE and TS_HEAL_MAX_AGE).
/** The first back-off: 5 minutes. */
export const TRACKSHIP_REFIRE_BACKOFF_BASE_MS = 5 * 60_000
/** The back-off cap: 24 hours. */
export const TRACKSHIP_REFIRE_BACKOFF_MAX_MS = 24 * 60 * 60_000
/** After a re-fire TrackShip finishes from a background job, so the next look waits at least this long. */
export const TRACKSHIP_REFIRE_PENDING_GRACE_MS = 60 * 60_000
/** An order is re-fired only while it shipped this recently: re-registering an old parcel would e-mail the customer about a delivery they already had. */
export const TRACKSHIP_REFIRE_WINDOW_MS = 7 * 24 * 60 * 60_000
/** An order still unregistered after this many looks is reported to the operator (once). */
export const TRACKSHIP_REFIRE_ALERT_ATTEMPTS = 5

/**
 * The delay after the Nth look (N >= 1): 5 min, 10, 20, 40 ... doubling, capped at 24 h. The exponent is capped too, so the shift can never overflow.
 */
export function trackshipRefireBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.trunc(attempt))
  return Math.min(TRACKSHIP_REFIRE_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20), TRACKSHIP_REFIRE_BACKOFF_MAX_MS)
}

/** What the storefront said, reduced to a fixed vocabulary. Never remote free text. */
export type TrackshipRefireOutcome =
  /** TrackShip holds a shipment for every tracking number: nothing to do, and nothing was fired. */
  | { kind: 'covered' }
  /** TrackShip's trigger was fired once for the order. Whether it took shows on the next look. */
  | { kind: 'fired'; missing: number }
  /** Something is missing but TrackShip's own gate refused the order right now (not in a trigger status, or no tracking visible). Nothing fired. */
  | { kind: 'not-eligible'; missing: number }
  /** The storefront order carries no tracking. Nothing fired. */
  | { kind: 'no-tracking' }
  /** The storefront has no such order any more. Nothing more will be asked. */
  | { kind: 'order-gone' }
  /** Nothing reached TrackShip and nothing changed: held, not configured, plugin missing or too old, TrackShip not ready, or a transport error. The caller retries. */
  | { kind: 'failed'; error: string; held: boolean }

const REFIRE_TIMEOUT_MS = 30_000

/** The pure half of the transport: the storefront's HTTP answer to an outcome. Exported for the tests. */
export function classifyTrackshipRefireResponse(status: number, body: unknown): TrackshipRefireOutcome {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const result = typeof record.result === 'string' ? record.result : null
  const missing = typeof record.missing === 'number' && Number.isFinite(record.missing) ? Math.max(0, Math.trunc(record.missing)) : 0
  if (status === 200) {
    switch (result) {
      case 'covered': return { kind: 'covered' }
      case 'fired': return { kind: 'fired', missing }
      case 'not_eligible': return { kind: 'not-eligible', missing }
      case 'no_tracking': return { kind: 'no-tracking' }
      default: return { kind: 'failed', held: false, error: 'The storefront answered the TrackShip re-fire with a result IMS does not know, so nothing is recorded as done.' }
    }
  }
  if (status === 404) {
    // The plugin's own "no such order" carries its code; anything else is the route being absent (a helper plugin older than 1.4.0).
    if (record.code === 'oti_ts_not_found') return { kind: 'order-gone' }
    return { kind: 'failed', held: false, error: 'The storefront has no TrackShip re-fire route: install the onetwoInventory Helper plugin 1.4.0 or later on the store.' }
  }
  if (status === 503 || result === 'trackship_inactive') {
    return { kind: 'failed', held: false, error: 'TrackShip is not installed or not ready on the storefront, so nothing was re-fired.' }
  }
  if (status === 401) return { kind: 'failed', held: false, error: 'The storefront refused the signature of the TrackShip re-fire: the shared webhook secret does not match the plugin.' }
  if (status === 409) return { kind: 'failed', held: false, error: 'Another re-fire for this order was already running on the storefront; it is asked again.' }
  return { kind: 'failed', held: false, error: `The storefront answered the TrackShip re-fire with HTTP ${status}.` }
}

/** The signature the helper plugin checks: HMAC-SHA256 of the raw body with the shared secret, hex. */
export function signTrackshipRefireBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Ask the storefront to re-fire TrackShip for one WooCommerce order. The only network call of the re-fire. Throws only when the attempt fence refuses the write (the runner turns that into a retry); every other failure is an
 * outcome. The caller has already passed the producer-side hold at enqueue and at claim; the barrier here is the last one, so nothing leaves
 * IMS while WooCommerce is held, whatever asked.
 */
export async function postTrackshipRefire(externalOrderId: string): Promise<TrackshipRefireOutcome> {
  const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
  const url = config.get('wc_url') ?? ''
  const secret = config.get('wc_webhook_secret') ?? ''
  if (!url || !secret) return { kind: 'failed', held: false, error: 'WooCommerce URL or webhook secret is not configured.' }
  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { kind: 'failed', held: false, error: validated.error }

  const hold = wooEgressHold()
  if (hold.held) return { kind: 'failed', held: true, error: hold.queuedNotice }

  const body = '{}'
  const endpoint = `${validated.normalizedUrl}/wp-json/oti/v1/order/${encodeURIComponent(externalOrderId)}/trackship-refire`
  // The attempt fence's last question (deadline, row ownership, cut-off, still wanted), asked immediately before the send. It THROWS when the
  // attempt may not write, and that reaches the runner (a retry carrying the fence's own message), so it sits outside the try below.
  await assertWcAttemptMayWrite()
  try {
    const attemptSignal = currentWcAttemptSignal()
    const timeout = AbortSignal.timeout(REFIRE_TIMEOUT_MS)
    const res = await connectorFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OTI-Signature': signTrackshipRefireBody(body, secret) },
      body,
      signal: attemptSignal ? AbortSignal.any([timeout, attemptSignal]) : timeout,
    }, { connectorName: 'WooCommerce' })
    const parsed: unknown = await res.json().catch(() => null)
    return classifyTrackshipRefireResponse(res.status, parsed)
  } catch (error) {
    // A hold is reported with its own text (not prefixed with the error class), and counted as held, not failed.
    if (isOutboundWriteHeldError(error)) return { kind: 'failed', held: true, error: error.message }
    return { kind: 'failed', held: false, error: `The TrackShip re-fire request did not complete: ${error instanceof Error ? error.name : 'unknown error'}.` }
  }
}
