/**
 * IMS → WooCommerce tracking sync.
 *
 * Keeps all WooCommerce-specific tracking payload details inside the connector.
 * The current target is the AST-style `_wc_shipment_tracking_items` order meta.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, wcPut } from '../api'
import type { WcFullOrder, WcMeta, WcTrackingItem } from './types'

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

function dedupeTrackingRows(rows: TrackingSourceRow[]): TrackingSourceRow[] {
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

function toWcTrackingItem(row: TrackingSourceRow): WcTrackingItem {
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
    return { externalOrderId: null, orderNumber: null, externalOrderNumber: null, items: [] }
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

  const items = dedupeTrackingRows([...shipmentRows, ...fallbackRows]).map(toWcTrackingItem)
  const wcLink = order.shoppingLinks[0]
  return {
    externalOrderId: wcLink?.externalOrderId ? Number(wcLink.externalOrderId) : null,
    orderNumber: order.orderNumber ?? null,
    externalOrderNumber: wcLink?.externalOrderNumber ?? null,
    items,
  }
}

export async function pushImsTrackingToWc(orderId: string): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
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
    const existingItems = readExistingTrackingItems(wcOrder.meta_data ?? [])
    if (trackingItemsEqual(existingItems, outbound.items)) {
      return { success: true, skipped: true }
    }

    const existingMeta = (wcOrder.meta_data ?? []).find((item) => item.key === '_wc_shipment_tracking_items')
    const metaPatch = existingMeta
      ? { id: existingMeta.id, key: existingMeta.key, value: outbound.items }
      : { key: '_wc_shipment_tracking_items', value: outbound.items }

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
          payload: JSON.parse(JSON.stringify({ meta_key: '_wc_shipment_tracking_items', items: outbound.items })),
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
        metadata: { externalOrderId: outbound.externalOrderId, error: update.error, trackingCount: outbound.items.length },
      })
      return { success: false, error: update.error }
    }

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: orderId,
        externalId: String(outbound.externalOrderId),
        payload: JSON.parse(JSON.stringify({ meta_key: '_wc_shipment_tracking_items', items: outbound.items })),
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_tracking_pushed',
      tag: 'sync',
      level: 'INFO',
      description: `Pushed ${outbound.items.length} tracking entr${outbound.items.length === 1 ? 'y' : 'ies'} to WooCommerce order #${outbound.externalOrderNumber ?? outbound.externalOrderId}`,
      metadata: {
        externalOrderId: outbound.externalOrderId,
        trackingCount: outbound.items.length,
        trackingNumbers: outbound.items.map((item) => item.tracking_number),
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
