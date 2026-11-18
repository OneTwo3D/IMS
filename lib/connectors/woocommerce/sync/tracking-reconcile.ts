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
 * window, and the LATEST SYNCED TO_CONNECTOR tracking `shoppingSyncLog` row does not carry exactly the tracking numbers the
 * order's shipments have now (compared by content, never by timestamp: a slow older push that logs after a newer edit
 * committed would otherwise look like proof the newer tracking was delivered). Orders are paged by id with a keyset cursor,
 * so every eligible order in the window is examined and a large covered backlog cannot starve later orders. Each candidate goes
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
const PAGE_SIZE = 200
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

type TrackingShipment = { trackingNumber: string | null; shippingService?: string | null; shippedAt?: Date | null; createdAt?: Date | null }
type CoverageItem = { number: string; provider: string; dateShipped: string }

function sortedItems(items: CoverageItem[]): CoverageItem[] {
  const seen = new Set<string>()
  return items
    .filter((i) => {
      const key = `${i.number}|${i.provider}`
      if (!i.number || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => `${a.number}|${a.provider}`.localeCompare(`${b.number}|${b.provider}`))
}

/**
 * The outbound tracking items the order's shipments produce now, normalised the way the outbound push builds and dedupes
 * them (toWcTrackingItem): number, provider (carrier, else 'Custom') and date_shipped (epoch seconds). Coverage compares the
 * whole item, so a carrier or date edit whose push was lost is retried, not only a changed number.
 */
export function currentTrackingItems(shipments: TrackingShipment[]): CoverageItem[] {
  return sortedItems(shipments.map((s) => ({
    number: (s.trackingNumber ?? '').trim().toLowerCase(),
    provider: (s.shippingService ?? '').trim().toLowerCase() || 'custom',
    // The outbound push uses shippedAt, falling back to createdAt.
    dateShipped: (s.shippedAt ?? s.createdAt) ? String(Math.floor((s.shippedAt ?? s.createdAt)!.getTime() / 1000)) : '',
  })))
}

/** Back-compat view: just the numbers. */
export function currentTrackingNumbers(shipments: TrackingShipment[]): string[] {
  return [...new Set(currentTrackingItems(shipments).map((i) => i.number))].sort()
}

/** The tracking items a logged push (or a reconcile verification mark) says it delivered. */
export function loggedTrackingItems(payload: unknown): CoverageItem[] {
  if (typeof payload !== 'object' || payload === null) return []
  const p = payload as { reconcileTrackingItems?: unknown; items?: unknown }
  if (Array.isArray(p.reconcileTrackingItems)) {
    return sortedItems((p.reconcileTrackingItems as Array<Partial<CoverageItem> | null>).map((i) => ({
      number: typeof i?.number === 'string' ? i.number.trim().toLowerCase() : '',
      provider: typeof i?.provider === 'string' ? i.provider.trim().toLowerCase() : '',
      dateShipped: typeof i?.dateShipped === 'string' ? i.dateShipped : '',
    })))
  }
  if (!Array.isArray(p.items)) return []
  return sortedItems(p.items.map((raw) => {
    const i = (raw ?? {}) as { tracking_number?: unknown; tracking_provider?: unknown; custom_tracking_provider?: unknown; date_shipped?: unknown }
    const custom = typeof i.custom_tracking_provider === 'string' ? i.custom_tracking_provider.trim() : ''
    const provider = typeof i.tracking_provider === 'string' ? i.tracking_provider.trim() : ''
    return {
      number: typeof i.tracking_number === 'string' ? i.tracking_number.trim().toLowerCase() : '',
      provider: (custom || provider || 'custom').toLowerCase(),
      dateShipped: typeof i.date_shipped === 'string' ? i.date_shipped : String(i.date_shipped ?? ''),
    }
  }))
}

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
  const result = { scanned: 0, pushed: 0, unchanged: 0, held: 0, failed: 0 }
  let cursor: string | null = null
  while (result.scanned < WC_TRACKING_RECONCILE_BATCH) {
    const orders: Array<{ id: string; shipments: TrackingShipment[] }> = await deps.db.salesOrder.findMany({
      where: {
        shoppingLinks: { some: { connector: 'woocommerce' } },
        shipments: { some: shipmentFilter },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      // ALL of the order's SHIPPED tracking, not only the recently changed rows: coverage is judged on the whole set.
      select: { id: true, shipments: { where: { status: 'SHIPPED', trackingNumber: { not: null } }, select: { trackingNumber: true, shippingService: true, shippedAt: true, createdAt: true } } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    })
    if (orders.length === 0) break
    cursor = orders[orders.length - 1].id
    const ids = orders.map((o) => o.id)

    const base = { connector: 'woocommerce', direction: 'TO_CONNECTOR' as const, entityType: 'SalesOrder', entityId: { in: ids }, payload: trackingRowWhere }
    const synced = await deps.db.shoppingSyncLog.findMany({
      where: { ...base, status: 'SYNCED', createdAt: { gte: windowStart } },
      select: { entityId: true, payload: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    const latestSynced = new Map<string, unknown>()
    for (const row of synced) if (row.entityId) latestSynced.set(row.entityId, row.payload) // ascending: the last write wins
    const failed = await deps.db.shoppingSyncLog.findMany({
      where: { ...base, status: 'FAILED', createdAt: { gte: backoffStart } },
      select: { entityId: true },
    })
    const backedOff = new Set(failed.map((row) => row.entityId))

    for (const order of orders) {
      if (result.scanned >= WC_TRACKING_RECONCILE_BATCH) break
      const current = currentTrackingItems(order.shipments)
      if (current.length === 0) continue
      const logged = latestSynced.has(order.id) ? loggedTrackingItems(latestSynced.get(order.id)) : null
      if (logged !== null && JSON.stringify(logged) === JSON.stringify(current)) continue
      if (backedOff.has(order.id)) continue

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
              // `items` stays empty on purpose: the webhook echo check reads `items`, and a mark must never suppress a real webhook.
              payload: { meta_key: TRACKING_META_KEY, items: [], reconcileVerified: true, reconcileTrackingItems: current },
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
    if (orders.length < PAGE_SIZE) break
  }
  return result
}
