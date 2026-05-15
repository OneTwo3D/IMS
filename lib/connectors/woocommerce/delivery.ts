/**
 * WooCommerce delivery status — reads from WC order meta (AST + TrackShip plugin).
 */

import { db } from '@/lib/db'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { getWcCredentials } from './api'
import type { DeliveryStatus } from '../types'

export async function getWcDeliveryStatus(externalOrderId: number): Promise<DeliveryStatus | null> {
  try {
    const creds = await getWcCredentials()
    if (!creds) return null

    const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
    const res = await connectorFetch(`${creds.url}/wp-json/wc/v3/orders/${externalOrderId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    }, {
      connectorName: 'WooCommerce',
    })
    if (!res.ok) return null
    const order = await res.json()

    // AST plugin stores tracking info in order meta
    const meta = order.meta_data ?? []
    const trackshipStatus = meta.find((m: { key: string }) => m.key === '_trackship_status')
    const trackingData = meta.find((m: { key: string }) => m.key === '_wc_shipment_tracking_items')

    let trackingNumber: string | undefined
    let carrier: string | undefined

    if (trackingData?.value && Array.isArray(trackingData.value) && trackingData.value.length > 0) {
      const first = trackingData.value[0]
      trackingNumber = first.tracking_number
      carrier = first.tracking_provider
    }

    const status = trackshipStatus?.value ?? (order.status === 'completed' ? 'delivered' : null)
    if (!status) return null

    return {
      externalOrderId: externalOrderId,
      status,
      trackingNumber,
      carrier,
    }
  } catch {
    return null
  }
}

export async function getWcDeliveryStatusForSalesOrder(orderId: string): Promise<DeliveryStatus | null> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { connector: 'woocommerce', orderId },
    select: { externalOrderId: true },
  })

  if (!link?.externalOrderId) return null
  return getWcDeliveryStatus(Number(link.externalOrderId))
}
