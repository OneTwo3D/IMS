/**
 * IMS → WooCommerce tracking sync.
 *
 * Keeps all WooCommerce-specific tracking payload details inside the connector.
 * The current target is the AST-style `_wc_shipment_tracking_items` order meta.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, wcPut } from '../api'
import { assertWcAttemptMayStillSend } from '../attempt-fence'
import type { WcFullOrder, WcMeta, WcTrackingItem } from './types'
import { applyAstProvider, readAstProviderMappingEnabled, resolveAstProvider } from './ast-provider-mapping'

type TrackingSourceRow = {
  trackingNumber: string
  carrier: string
  shippedAt: Date
}

function normalizeTrackingRow(row: TrackingSourceRow): TrackingSourceRow {
  return {
    trackingNumber: row.trackingNumber.trim(),
    carrier: row.carrier.trim(),
    shippedAt: row.shippedAt,
  }
}

export function dedupeTrackingRows(rows: TrackingSourceRow[]): TrackingSourceRow[] {
  const seen = new Set<string>()
  const out: TrackingSourceRow[] = []

  for (const row of rows) {
    const normalized = normalizeTrackingRow(row)
    if (!normalized.trackingNumber) continue
    const key = `${normalized.trackingNumber.toLowerCase()}|${normalized.carrier.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }

  return out
}

export function toWcTrackingItem(row: TrackingSourceRow): WcTrackingItem {
  const provider = row.carrier || 'Custom'
  return {
    tracking_provider: provider,
    custom_tracking_provider: row.carrier || undefined,
    tracking_number: row.trackingNumber,
    date_shipped: String(Math.floor(row.shippedAt.getTime() / 1000)),
  }
}

type ComparableTrackingItem = {
  provider: string
  trackingNumber: string
  dateShipped: string
}

function toComparableTrackingItem(item: Partial<WcTrackingItem>): ComparableTrackingItem | null {
  const trackingNumber = typeof item.tracking_number === 'string' ? item.tracking_number.trim() : ''
  if (!trackingNumber) return null

  const customProvider = typeof item.custom_tracking_provider === 'string' ? item.custom_tracking_provider.trim() : ''
  const trackingProvider = typeof item.tracking_provider === 'string' ? item.tracking_provider.trim() : ''
  const provider = customProvider || trackingProvider || 'Custom'

  return {
    provider,
    trackingNumber,
    dateShipped: typeof item.date_shipped === 'string' ? item.date_shipped : String(item.date_shipped ?? ''),
  }
}

function readExistingTrackingItems(metaData: WcMeta[]): WcTrackingItem[] {
  const meta = metaData.find((item) => item.key === '_wc_shipment_tracking_items')
  if (!meta?.value || !Array.isArray(meta.value)) return []

  return (meta.value as Array<Partial<WcTrackingItem>>)
    .filter((item) => typeof item.tracking_number === 'string' && item.tracking_number.trim())
    .map((item) => ({
      tracking_provider: String(item.tracking_provider ?? item.custom_tracking_provider ?? 'Custom'),
      custom_tracking_provider: typeof item.custom_tracking_provider === 'string' ? item.custom_tracking_provider : undefined,
      custom_tracking_link: typeof item.custom_tracking_link === 'string' ? item.custom_tracking_link : undefined,
      tracking_number: item.tracking_number!.trim(),
      date_shipped: typeof item.date_shipped === 'string'
        ? item.date_shipped
        : String(item.date_shipped ?? ''),
    }))
}

function trackingItemsEqual(left: WcTrackingItem[], right: WcTrackingItem[]): boolean {
  const normalize = (items: WcTrackingItem[]) => items
    .map((item) => toComparableTrackingItem(item))
    .filter((item): item is ComparableTrackingItem => !!item)

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

async function buildOutboundTracking(orderId: string): Promise<{
  externalOrderId: number | null
  orderNumber: string | null
  externalOrderNumber: string | null
  /** The deduped source rows `items` were built from; the AST provider mapping (ast-provider-mapping.ts) needs the courier of each. */
  rows: TrackingSourceRow[]
  items: WcTrackingItem[]
}> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      orderNumber: true,
      trackingNumber: true,
      shippingService: true,
      shippedAt: true,
      shoppingLinks: {
        where: { connector: 'woocommerce' },
        select: { externalOrderId: true, externalOrderNumber: true },
        take: 1,
      },
      shipments: {
        where: { status: 'SHIPPED' },
        select: {
          trackingNumber: true,
          shippingService: true,
          shippedAt: true,
          createdAt: true,
        },
        orderBy: [{ shippedAt: 'asc' }, { createdAt: 'asc' }],
      },
    },
  })

  if (!order) {
    return { externalOrderId: null, orderNumber: null, externalOrderNumber: null, rows: [], items: [] }
  }

  const shipmentRows: TrackingSourceRow[] = order.shipments
    .filter((shipment) => !!shipment.trackingNumber)
    .map((shipment) => ({
      trackingNumber: shipment.trackingNumber!,
      carrier: shipment.shippingService ?? '',
      shippedAt: shipment.shippedAt ?? shipment.createdAt,
    }))

  const fallbackRows: TrackingSourceRow[] = shipmentRows.length === 0 && order.trackingNumber
    ? [{
        trackingNumber: order.trackingNumber,
        carrier: order.shippingService ?? '',
        shippedAt: order.shippedAt ?? new Date(),
      }]
    : []

  const rows = dedupeTrackingRows([...shipmentRows, ...fallbackRows])
  const items = rows.map(toWcTrackingItem)
  const wcLink = order.shoppingLinks[0]
  return {
    externalOrderId: wcLink?.externalOrderId ? Number(wcLink.externalOrderId) : null,
    orderNumber: order.orderNumber ?? null,
    externalOrderNumber: wcLink?.externalOrderNumber ?? null,
    rows,
    items,
  }
}

/**
 * Apply the AST provider mapping to the outbound items, when `wc_ast_provider_mapping_enabled` is 'true'.
 *
 * OFF (the default): returns `items` itself, so the payload is byte-identical to what IMS wrote before the mapping existed
 * and nothing else is read. ON: each row's courier (and the order's FedEx / Click & Drop meta) is resolved to an AST provider
 * slug; a courier the table does not know keeps today's item and is counted in the activity log, never guessed.
 */
async function applyProviderMappingIfEnabled(
  orderId: string,
  outbound: { rows: TrackingSourceRow[]; items: WcTrackingItem[]; externalOrderId: number | null },
  orderMeta: WcMeta[],
): Promise<WcTrackingItem[]> {
  let enabled: boolean
  try {
    enabled = await readAstProviderMappingEnabled()
  } catch (error) {
    // An optional, default-off setting must never fail a tracking push (a failed push withholds the order's completion): an
    // unreadable setting is OFF, which sends today's item. Recorded so the read failure is not silent.
    try {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'wc_tracking_provider_setting_unreadable',
        tag: 'sync',
        level: 'WARNING',
        description: 'The AST provider mapping setting could not be read; tracking was written without the mapping',
        metadata: { externalOrderId: outbound.externalOrderId, error: error instanceof Error ? error.message : 'unknown error' },
      })
    } catch { /* the log write is best-effort too */ }
    return outbound.items
  }
  if (!enabled) return outbound.items
  const unmapped: string[] = []
  const items = outbound.rows.map((row) => {
    const resolution = resolveAstProvider({ courier: row.carrier, orderMeta, orderRowCount: outbound.rows.length, trackingNumber: row.trackingNumber })
    if (resolution.kind === 'unmapped' && resolution.courier) unmapped.push(resolution.courier)
    return applyAstProvider(toWcTrackingItem(row), resolution)
  })
  if (unmapped.length > 0) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_tracking_provider_unmapped',
      tag: 'sync',
      level: 'WARNING',
      description: `${unmapped.length} tracking entr${unmapped.length === 1 ? 'y has' : 'ies have'} a courier with no AST provider mapping; written unchanged`,
      metadata: { externalOrderId: outbound.externalOrderId, unmappedCount: unmapped.length, couriers: [...new Set(unmapped)] },
    })
  }
  return items
}

export async function pushImsTrackingToWc(
  orderId: string,
  options: { skipWcStatuses?: readonly string[] } = {},
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const outbound = await buildOutboundTracking(orderId)
  if (!outbound.externalOrderId) return { success: true, skipped: true }
  if (outbound.items.length === 0) return { success: true, skipped: true }

  try {
    const currentOrder = await wcFetch(`/orders/${outbound.externalOrderId}`)
    if (currentOrder.error) {
      await db.shoppingSyncLog.create({
        data: {
          direction: 'TO_CONNECTOR',
          status: 'FAILED',
          entityType: 'SalesOrder',
          entityId: orderId,
          externalId: String(outbound.externalOrderId),
          payload: JSON.parse(JSON.stringify({ meta_key: '_wc_shipment_tracking_items', items: outbound.items })),
          errorMessage: currentOrder.error,
        },
      })
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'wc_tracking_push_failed',
        tag: 'sync',
        level: 'WARNING',
        description: `Failed to load WooCommerce order #${outbound.externalOrderNumber ?? outbound.externalOrderId} before tracking sync`,
        metadata: { externalOrderId: outbound.externalOrderId, error: currentOrder.error },
      })
      return { success: false, error: currentOrder.error }
    }

    const wcOrder = currentOrder.data as WcFullOrder
    // The reconcile sweep (tracking-reconcile.ts) leaves an order WooCommerce has already closed alone.
    if (options.skipWcStatuses?.includes(wcOrder.status)) return { success: true, skipped: true }
    // Reassigned from `outbound.items` only when the AST provider mapping is on; every payload and log below uses `items`.
    const items = await applyProviderMappingIfEnabled(orderId, outbound, wcOrder.meta_data ?? [])
    const existingItems = readExistingTrackingItems(wcOrder.meta_data ?? [])
    if (trackingItemsEqual(existingItems, items)) {
      return { success: true, skipped: true }
    }

    const existingMeta = (wcOrder.meta_data ?? []).find((item) => item.key === '_wc_shipment_tracking_items')
    const metaPatch = existingMeta
      ? { id: existingMeta.id, key: existingMeta.key, value: items }
      : { key: '_wc_shipment_tracking_items', value: items }

    // The writer-side cut-off, re-derived immediately before the write (a no-op outside a queued job's attempt).
    await assertWcAttemptMayStillSend()
    const update = await wcPut(`/orders/${outbound.externalOrderId}`, {
      meta_data: [metaPatch],
    })

    if (update.error) {
      await db.shoppingSyncLog.create({
        data: {
          direction: 'TO_CONNECTOR',
          status: 'FAILED',
          entityType: 'SalesOrder',
          entityId: orderId,
          externalId: String(outbound.externalOrderId),
          payload: JSON.parse(JSON.stringify({ meta_key: '_wc_shipment_tracking_items', items })),
          errorMessage: update.error,
        },
      })
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'wc_tracking_push_failed',
        tag: 'sync',
        level: 'WARNING',
        description: `Failed to push tracking to WooCommerce order #${outbound.externalOrderNumber ?? outbound.externalOrderId}`,
        metadata: { externalOrderId: outbound.externalOrderId, error: update.error, trackingCount: items.length },
      })
      return { success: false, error: update.error }
    }

    // Record WHEN our write landed, from WooCommerce's own clock — same rationale as the
    // status push (order-status.ts). Matching tracking proves the TRACKING is unchanged
    // since our push; it does NOT prove nothing else changed. Tracking stays identical
    // across a later genuine status change, so without this timestamp the echo rule
    // suppresses that change's status sync for the whole window (o3d-uxv, tracking arm).
    const pushedDateModifiedGmt = (update.data as { date_modified_gmt?: string } | null)?.date_modified_gmt

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: orderId,
        externalId: String(outbound.externalOrderId),
        payload: JSON.parse(JSON.stringify({
          meta_key: '_wc_shipment_tracking_items',
          items,
          pushedDateModifiedGmt,
        })),
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_tracking_pushed',
      tag: 'sync',
      level: 'INFO',
      description: `Pushed ${items.length} tracking entr${items.length === 1 ? 'y' : 'ies'} to WooCommerce order #${outbound.externalOrderNumber ?? outbound.externalOrderId}`,
      metadata: {
        externalOrderId: outbound.externalOrderId,
        trackingCount: items.length,
        trackingNumbers: items.map((item) => item.tracking_number),
      },
    })

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'FAILED',
        entityType: 'SalesOrder',
        entityId: orderId,
        externalId: String(outbound.externalOrderId),
        payload: JSON.parse(JSON.stringify({ meta_key: '_wc_shipment_tracking_items', items: outbound.items })),
        errorMessage: message,
      },
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_tracking_push_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce tracking sync failed for order #${outbound.externalOrderNumber ?? outbound.externalOrderId}`,
      metadata: { externalOrderId: outbound.externalOrderId, error: message },
    })
    return { success: false, error: message }
  }
}
