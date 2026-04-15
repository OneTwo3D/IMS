import { db } from '@/lib/db'
import type { WcFullOrder, WcTrackingItem } from './types'
import { extractWcTracking } from './field-mapping'

const ORDER_WEBHOOK_ECHO_WINDOW_MS = 10 * 60 * 1000

type ShoppingSyncLogPayload = {
  status?: unknown
  meta_key?: unknown
  items?: unknown
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

export async function shouldSuppressWcOrderWebhookEcho(wcOrder: WcFullOrder): Promise<{
  suppress: boolean
  reason?: 'status_echo' | 'tracking_echo'
}> {
  const recentSince = new Date(Date.now() - ORDER_WEBHOOK_ECHO_WINDOW_MS)
  const recentLogs = await db.shoppingSyncLog.findMany({
    where: {
      direction: 'TO_CONNECTOR',
      externalId: wcOrder.id,
      entityType: 'SalesOrder',
      createdAt: { gte: recentSince },
    },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
    take: 10,
  })

  const inboundTracking = comparableInboundTracking(wcOrder)

  for (const entry of recentLogs) {
    const payload = (entry.payload ?? {}) as ShoppingSyncLogPayload

    if (typeof payload.status === 'string' && payload.status === wcOrder.status) {
      return { suppress: true, reason: 'status_echo' }
    }

    if (payload.meta_key === '_wc_shipment_tracking_items') {
      const loggedTracking = comparableLoggedTracking(payload.items)
      if (loggedTracking.length > 0 && JSON.stringify(loggedTracking) === JSON.stringify(inboundTracking)) {
        return { suppress: true, reason: 'tracking_echo' }
      }
    }
  }

  return { suppress: false }
}
