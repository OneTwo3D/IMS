import { db } from '@/lib/db'

import type { DeliveryStatus } from '../types'
import { extractShopifyLegacyResourceId, shopifyGraphql } from './api'

type ShopifyOrderDeliveryResponse = {
  order: {
    legacyResourceId: string | number | null
    displayFulfillmentStatus: string | null
    fulfillments: {
      nodes: Array<{
        updatedAt: string | null
        status: string | null
        trackingInfo: Array<{
          company?: string | null
          number?: string | null
        }>
        events: {
          nodes: Array<{
            status: string | null
            happenedAt: string | null
          }>
        }
      }>
    }
  } | null
}

function normalizeDeliveryStatus(value: string | null | undefined): string | null {
  if (!value) return null

  const normalized = value.toLowerCase()
  switch (normalized) {
    case 'fulfilled':
    case 'success':
    case 'delivered':
      return 'delivered'
    case 'partial':
    case 'partially_fulfilled':
    case 'in_progress':
      return 'in_transit'
    case 'out_for_delivery':
      return 'out_for_delivery'
    case 'on_hold':
      return 'on_hold'
    case 'pending_fulfillment':
    case 'unfulfilled':
    case 'open':
      return 'pending'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'failure':
    case 'error':
      return 'failed'
    case 'attempted_delivery':
      return 'attempted_delivery'
    case 'confirmed':
    case 'carrier_picked_up':
    case 'label_printed':
    case 'label_purchased':
    case 'ready_for_pickup':
      return normalized
    default:
      return normalized
  }
}

function getLatestFulfillment(
  fulfillments: NonNullable<ShopifyOrderDeliveryResponse['order']>['fulfillments']['nodes'],
) {
  if (fulfillments.length === 0) return null

  return [...fulfillments].sort((left, right) => {
    const leftEventTime = left.events.nodes[0]?.happenedAt
    const rightEventTime = right.events.nodes[0]?.happenedAt
    const leftTimestamp = Date.parse(leftEventTime ?? left.updatedAt ?? '')
    const rightTimestamp = Date.parse(rightEventTime ?? right.updatedAt ?? '')

    const safeLeft = Number.isFinite(leftTimestamp) ? leftTimestamp : 0
    const safeRight = Number.isFinite(rightTimestamp) ? rightTimestamp : 0
    return safeRight - safeLeft
  })[0] ?? null
}

export async function getShopifyDeliveryStatus(externalOrderId: string): Promise<DeliveryStatus | null> {
  const { data, error } = await shopifyGraphql<ShopifyOrderDeliveryResponse>(
    `
      query ShopifyOrderDeliveryStatus($id: ID!) {
        order(id: $id) {
          legacyResourceId
          displayFulfillmentStatus
          fulfillments(first: 10) {
            nodes {
              updatedAt
              status
              trackingInfo(first: 10) {
                company
                number
              }
              events(first: 1, sortKey: HAPPENED_AT, reverse: true) {
                nodes {
                  status
                  happenedAt
                }
              }
            }
          }
        }
      }
    `,
    { id: externalOrderId },
  )

  if (error) return null

  const order = data?.order
  if (!order) return null

  const latestFulfillment = getLatestFulfillment(order.fulfillments.nodes)
  const latestEvent = latestFulfillment?.events.nodes[0]
  const tracking = latestFulfillment?.trackingInfo[0]
  const status = normalizeDeliveryStatus(latestEvent?.status ?? latestFulfillment?.status ?? order.displayFulfillmentStatus)
  const normalizedExternalId = extractShopifyLegacyResourceId(order.legacyResourceId) ?? externalOrderId

  if (!status) return null

  return {
    externalOrderId: normalizedExternalId,
    status,
    trackingNumber: tracking?.number ?? undefined,
    carrier: tracking?.company ?? undefined,
    lastEvent: latestEvent?.status ?? undefined,
    lastEventTime: latestEvent?.happenedAt ?? undefined,
  }
}

export async function getShopifyDeliveryStatusForSalesOrder(orderId: string): Promise<DeliveryStatus | null> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { connector: 'shopify', orderId },
    select: { externalOrderId: true },
  })

  if (!link?.externalOrderId) return null

  const externalOrderId = extractShopifyLegacyResourceId(link.externalOrderId)
  if (externalOrderId) {
    return getShopifyDeliveryStatus(`gid://shopify/Order/${externalOrderId}`)
  }

  return getShopifyDeliveryStatus(link.externalOrderId)
}
