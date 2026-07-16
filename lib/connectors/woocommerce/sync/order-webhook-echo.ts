import { db } from '@/lib/db'
import type { WcFullOrder, WcTrackingItem } from './types'
import { extractWcTracking } from './field-mapping'

const ORDER_WEBHOOK_ECHO_WINDOW_MS = 10 * 60 * 1000

export type ShoppingSyncLogPayload = {
  status?: unknown
  meta_key?: unknown
  items?: unknown
  /** WC's date_modified_gmt immediately after our push — see isOurWrite(). */
  pushedDateModifiedGmt?: unknown
}

/** WC sends GMT timestamps without a zone suffix ("2026-07-15T21:30:00"). */
function parseWcGmt(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Is this inbound webhook the echo of a write WE made, rather than a later change?
 *
 * WooCommerce stamps date_modified_gmt on every change. Our push records the value WC
 * reported straight afterwards, so:
 *   - the echo of that push carries the SAME timestamp  -> ours;
 *   - anything modified afterwards (a refund, an edit)  -> strictly greater -> theirs.
 *
 * This is the discriminator the status string could never be: a partial refund leaves
 * the status untouched, so status-matching classed it as our echo and dropped it
 * (o3d-uxv).
 *
 * Returns null when we cannot tell — an older log row written before we captured the
 * timestamp, or a push whose response carried no date. The caller then falls back to the
 * previous (status-only) behaviour rather than guessing; those rows age out of the
 * window within minutes.
 *
 * Ties count as ours: WC's timestamp has one-second resolution, so a change in the same
 * second as our push is indistinguishable. Suppressing there only skips a status sync
 * that re-syncs on the next event — the safer side of an unavoidable ambiguity.
 */
function isOurWrite(payload: ShoppingSyncLogPayload, wcOrder: WcFullOrder): boolean | null {
  const pushedAt = parseWcGmt(payload.pushedDateModifiedGmt)
  const inboundAt = parseWcGmt(wcOrder.date_modified_gmt)
  if (pushedAt === null || inboundAt === null) return null
  return inboundAt <= pushedAt
}

function normalizeTrackingCarrier(carrier: string): string {
  return carrier.trim().toLowerCase()
}

function normalizeTrackingNumber(trackingNumber: string): string {
  return trackingNumber.trim().toLowerCase()
}

function comparableInboundTracking(order: WcFullOrder): string[] {
  return extractWcTracking(order)
    .map((item) => `${normalizeTrackingCarrier(item.carrier)}|${normalizeTrackingNumber(item.trackingNumber)}`)
    .sort()
}

function comparableLoggedTracking(items: unknown): string[] {
  if (!Array.isArray(items)) return []

  return items
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Partial<WcTrackingItem>
      const trackingNumber = typeof row.tracking_number === 'string' ? row.tracking_number.trim() : ''
      if (!trackingNumber) return []
      const carrier = typeof row.custom_tracking_provider === 'string' && row.custom_tracking_provider.trim()
        ? row.custom_tracking_provider
        : typeof row.tracking_provider === 'string'
        ? row.tracking_provider
        : ''
      return [`${normalizeTrackingCarrier(carrier)}|${normalizeTrackingNumber(trackingNumber)}`]
    })
    .sort()
}

export type WcOrderEchoVerdict = { suppress: boolean; reason?: 'status_echo' | 'tracking_echo' }

/**
 * Decide whether an inbound order.updated is the echo of our own recent push.
 *
 * Pure and separately exported so the decision can be unit-tested without a database —
 * it had no test at all while it was silently discarding refunds (o3d-uxv), which is
 * precisely the kind of logic that needs one.
 *
 * `recentPayloads` are the payloads of our TO_CONNECTOR pushes for this order inside the
 * echo window, newest first.
 */
export function evaluateWcOrderWebhookEcho(
  recentPayloads: ReadonlyArray<ShoppingSyncLogPayload>,
  wcOrder: WcFullOrder,
): WcOrderEchoVerdict {
  const inboundTracking = comparableInboundTracking(wcOrder)

  for (const payload of recentPayloads) {

    if (typeof payload.status === 'string' && payload.status === wcOrder.status) {
      // Same status is necessary but NOT sufficient — a later change that leaves the
      // status alone (the classic case: a partial refund) looks identical. Ask WC's own
      // clock whether this webhook is our write or something that happened after it.
      const ours = isOurWrite(payload, wcOrder)
      if (ours === false) continue // modified after our push -> a genuine change
      return { suppress: true, reason: 'status_echo' }
    }

    if (payload.meta_key === '_wc_shipment_tracking_items') {
      const loggedTracking = comparableLoggedTracking(payload.items)
      if (loggedTracking.length > 0 && JSON.stringify(loggedTracking) === JSON.stringify(inboundTracking)) {
        // Matching tracking is necessary but NOT sufficient — same trap as the status arm
        // above. Tracking does not change when the order's status later changes, so after
        // we push tracking at ship time EVERY order.updated in the window carries
        // identical tracking, including genuine changes. Ask WC's clock which this is.
        const ours = isOurWrite(payload, wcOrder)
        if (ours === false) continue // modified after our push -> a genuine change
        return { suppress: true, reason: 'tracking_echo' }
      }
    }
  }

  return { suppress: false }
}

export async function shouldSuppressWcOrderWebhookEcho(wcOrder: WcFullOrder): Promise<WcOrderEchoVerdict> {
  const recentSince = new Date(Date.now() - ORDER_WEBHOOK_ECHO_WINDOW_MS)
  const recentLogs = await db.shoppingSyncLog.findMany({
    where: {
      connector: 'woocommerce',
      direction: 'TO_CONNECTOR',
      externalId: String(wcOrder.id),
      entityType: 'SalesOrder',
      createdAt: { gte: recentSince },
    },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
    take: 10,
  })

  return evaluateWcOrderWebhookEcho(
    recentLogs.map((entry) => (entry.payload ?? {}) as ShoppingSyncLogPayload),
    wcOrder,
  )
}
