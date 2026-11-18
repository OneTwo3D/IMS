/**
 * THE TRACKING RECONCILE SWEEP (o3d-ekujm).
 *
 * A tracking push for a shipment that did NOT reach SHIPPED on the order (a partial shipment, a tracking edit, an
 * EXTERNAL-authority dispatch) runs post-commit and best-effort (`pushShipmentCompletionToShopping` with no completion
 * key). A crash between the commit and the push loses it, and nothing ever looked for it: the order completion has been
 * a durable outbox job since o3d-zvec.15, the tracking has not.
 *
 * This sweep re-derives the obligation from durable state instead of adding a mark at every shipping call site. An order
 * is a candidate when it has a WooCommerce link and a SHIPPED shipment with a tracking number that changed inside the
 * window, and no TO_CONNECTOR tracking `shoppingSyncLog` row (SYNCED) is newer than that change. Each candidate goes
 * through `pushOrderDeliveryMetadata` unchanged, so it passes the producer seam (the outbound hold) and `wcPut`'s egress
 * barrier like every other tracking write, and `pushImsTrackingToWc` is idempotent (it reads WooCommerce first and writes
 * nothing when the tracking already matches).
 *
 * Safeguards, because WooCommerce is live:
 *   - OFF BY DEFAULT: `wc_tracking_reconcile_enabled` must be `true`; otherwise nothing is scanned or sent;
 *   - a WooCommerce order that is already completed / cancelled / refunded / failed / trashed is left alone, so the
 *     paths that deliberately write nothing to a completed order (external-fulfillment.ts) are not undone by the sweep;
 *   - a candidate that failed in the last 15 minutes is not retried yet, and at most 25 orders are pushed per run;
 *   - when the push succeeds but wrote no row (tracking already matched, or the order was left alone), a verification
 *     row is written so the order stops being a candidate until its shipments change again.
 */
import { db as appDb } from '@/lib/db'
import { getSettingValue } from '@/lib/settings-store'

export const WC_TRACKING_RECONCILE_ENABLED_SETTING = 'wc_tracking_reconcile_enabled'
export const WC_TRACKING_RECONCILE_WINDOW_MS = 72 * 60 * 60 * 1000
export const WC_TRACKING_RECONCILE_GRACE_MS = 5 * 60 * 1000
export const WC_TRACKING_RECONCILE_RETRY_BACKOFF_MS = 15 * 60 * 1000
export const WC_TRACKING_RECONCILE_BATCH = 25
const CANDIDATE_SCAN_LIMIT = 1000
const TRACKING_META_KEY = '_wc_shipment_tracking_items'
/** WooCommerce statuses where the sweep writes nothing (see the header). */
export const WC_TRACKING_RECONCILE_SKIP_WC_STATUSES = ['completed', 'cancelled', 'refunded', 'failed', 'trash'] as const

type PushResult = { success: boolean; skipped?: boolean; shadowed?: boolean; error?: string }

export type WcTrackingReconcileDeps = {
  db: Pick<typeof appDb, 'salesOrder' | 'shoppingSyncLog'>
  isEnabled: () => Promise<boolean>
  pushTracking: (orderId: string, options: { skipWcStatuses: readonly string[] }) => Promise<PushResult>
  now: () => Date
}

export type WcTrackingReconcileResult =
  | { skipped: true; reason: string }
  | { scanned: number; pushed: number; unchanged: number; held: number; failed: number }

async function defaultPushTracking(orderId: string, options: { skipWcStatuses: readonly string[] }): Promise<PushResult> {
  const { pushOrderDeliveryMetadata } = await import('@/lib/shopping')
  return pushOrderDeliveryMetadata(orderId, options)
}

const defaultDeps: WcTrackingReconcileDeps = {
  db: appDb,
  isEnabled: async () => (await getSettingValue(WC_TRACKING_RECONCILE_ENABLED_SETTING)) === 'true',
  pushTracking: defaultPushTracking,
  now: () => new Date(),
}

const trackingRowWhere = { path: ['meta_key'], equals: TRACKING_META_KEY } as const

export async function reconcileWcTrackingPushes(overrides: Partial<WcTrackingReconcileDeps> = {}): Promise<WcTrackingReconcileResult> {
  const deps = { ...defaultDeps, ...overrides }
  if (!(await deps.isEnabled())) return { skipped: true, reason: 'wc_tracking_reconcile_disabled' }

  const now = deps.now()
  const windowStart = new Date(now.getTime() - WC_TRACKING_RECONCILE_WINDOW_MS)
  const graceCutoff = new Date(now.getTime() - WC_TRACKING_RECONCILE_GRACE_MS)
  const backoffStart = new Date(now.getTime() - WC_TRACKING_RECONCILE_RETRY_BACKOFF_MS)

  const shipmentFilter = {
    status: 'SHIPPED' as const,
    trackingNumber: { not: null },
    updatedAt: { gte: windowStart, lte: graceCutoff },
  }
  const orders = await deps.db.salesOrder.findMany({
    where: {
      shoppingLinks: { some: { connector: 'woocommerce' } },
      shipments: { some: shipmentFilter },
    },
    select: { id: true, shipments: { where: shipmentFilter, select: { updatedAt: true, trackingNumber: true } } },
    take: CANDIDATE_SCAN_LIMIT,
  })

  const result = { scanned: 0, pushed: 0, unchanged: 0, held: 0, failed: 0 }
  for (const order of orders) {
    if (result.scanned >= WC_TRACKING_RECONCILE_BATCH) break
    const changedAt = order.shipments
      .filter((shipment) => (shipment.trackingNumber ?? '').trim() !== '')
      .reduce<Date | null>((latest, shipment) => (latest === null || shipment.updatedAt > latest ? shipment.updatedAt : latest), null)
    if (!changedAt) continue

    const covered = await deps.db.shoppingSyncLog.findFirst({
      where: {
        connector: 'woocommerce', direction: 'TO_CONNECTOR', status: 'SYNCED', entityType: 'SalesOrder',
        entityId: order.id, createdAt: { gte: changedAt }, payload: trackingRowWhere,
      },
      select: { id: true },
    })
    if (covered) continue
    const recentlyFailed = await deps.db.shoppingSyncLog.findFirst({
      where: {
        connector: 'woocommerce', direction: 'TO_CONNECTOR', status: 'FAILED', entityType: 'SalesOrder',
        entityId: order.id, createdAt: { gte: backoffStart }, payload: trackingRowWhere,
      },
      select: { id: true },
    })
    if (recentlyFailed) continue

    result.scanned += 1
    try {
      const push = await deps.pushTracking(order.id, { skipWcStatuses: WC_TRACKING_RECONCILE_SKIP_WC_STATUSES })
      if (push.shadowed) {
        result.held += 1
      } else if (!push.success) {
        result.failed += 1
      } else if (push.skipped) {
        result.unchanged += 1
        await deps.db.shoppingSyncLog.create({
          data: {
            direction: 'TO_CONNECTOR', status: 'SYNCED', entityType: 'SalesOrder', entityId: order.id,
            payload: { meta_key: TRACKING_META_KEY, items: [], reconcileVerified: true },
            syncedAt: now,
          },
        })
      } else {
        result.pushed += 1
      }
    } catch (error) {
      result.failed += 1
      console.error('[tracking-reconcile] push threw', { orderId: order.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
