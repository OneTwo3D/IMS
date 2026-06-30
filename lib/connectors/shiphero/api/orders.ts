import type { WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { extractShipheroConnectionNodes, shipheroGraphql } from './client'
import { SHIPHERO_DEFAULT_ADMIN_ORDER_URL_TEMPLATE, getShipheroSettings } from '@/lib/connectors/shiphero/settings/schema'

/**
 * Read-only ShipHero order status for the sales-order WMS chip. ShipHero's split
 * model is multiple `shipments` per order (no sibling orders, unlike Mintsoft's
 * NumberOfParts), so isSplit derives from the shipment count. Order/shipment field
 * names are flagged for live-tenant verification; mapping reads them defensively.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function firstId(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = str(record[key])
    if (found) return found
  }
  return null
}

/** Title-case a snake_case fulfillment_status; normalise the cancel spelling. */
export function humanizeShipheroStatus(status: string | null | undefined): string {
  if (!status || !status.trim()) return 'Unknown'
  const normalized = status.trim().toLowerCase().replace(/-/g, '_') === 'cancelled' ? 'canceled' : status.trim()
  return normalized
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export function buildShipheroDeepLink(template: string, externalOrderId: string): string | null {
  const base = (template || SHIPHERO_DEFAULT_ADMIN_ORDER_URL_TEMPLATE).trim()
  if (!base.includes('{id}')) return null
  return base.replace('{id}', encodeURIComponent(externalOrderId))
}

/** Map ShipHero `shipments` nodes → generic tracking entries. */
export function readShipheroTracking(shipmentNodes: unknown[]): WmsOrderTracking[] {
  const tracking: WmsOrderTracking[] = []
  for (const node of shipmentNodes) {
    const record = asRecord(node)
    if (!record) continue
    const trackingNumber = str(record.tracking_number ?? record.trackingNumber)
    const carrier = str(record.shipping_carrier ?? record.carrier ?? record.shipping_name)
    const despatchedAt = str(record.created_date ?? record.shipped_at ?? record.created_at)
    if (!trackingNumber && !carrier && !despatchedAt) continue
    tracking.push({ trackingNumber, carrier, despatchedAt })
  }
  return tracking
}

/** Pure map of one ShipHero order node → WmsOrderStatus (null if it has no id). */
export function mapShipheroOrderStatus(node: unknown, adminOrderUrlTemplate: string, reference: string): WmsOrderStatus | null {
  const record = asRecord(node)
  if (!record) return null
  const externalOrderId = firstId(record, ['id', 'legacy_id'])
  if (!externalOrderId) return null

  const fulfillmentStatus = str(record.fulfillment_status) ?? ''
  const shipmentNodes = extractShipheroConnectionNodes(record.shipments)
  const tracking = readShipheroTracking(shipmentNodes)

  return {
    externalOrderId,
    externalOrderNumber: str(record.order_number) ?? reference,
    status: fulfillmentStatus,
    statusLabel: humanizeShipheroStatus(fulfillmentStatus),
    isSplit: shipmentNodes.length > 1,
    partCount: shipmentNodes.length > 0 ? shipmentNodes.length : null,
    // ShipHero merges via a child→parent order link; merged-survivor detection is
    // not surfaced in this slice (kept false rather than guessed).
    isMerged: false,
    mergedOrderNumbers: [],
    deepLinkUrl: buildShipheroDeepLink(adminOrderUrlTemplate, externalOrderId),
    tracking,
    // ShipHero's connector-specific dispatched decision: fully fulfilled, or a tracking
    // entry carrying a despatch date.
    dispatched: fulfillmentStatus.trim().toLowerCase() === 'fulfilled'
      || tracking.some((entry) => Boolean(entry.despatchedAt)),
    raw: record,
  }
}

const ORDER_STATUS_QUERY = `query ($orderNumber: String!) {
  orders(order_number: $orderNumber) {
    data {
      edges {
        node {
          id
          legacy_id
          order_number
          fulfillment_status
          shipments {
            edges {
              node { id tracking_number shipping_carrier created_date }
            }
          }
        }
      }
    }
  }
}`

type ShipheroOrdersData = {
  orders?: unknown
}

/** Pick the exact order_number match, else the first returned order. */
export function pickShipheroOrderNode(nodes: unknown[], reference: string): unknown | null {
  if (nodes.length === 0) return null
  const exact = nodes.find((node) => str(asRecord(node)?.order_number) === reference)
  return exact ?? nodes[0]
}

export async function fetchShipheroOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null> {
  const reference = orderNumber.trim()
  if (!reference) return null

  const result = await shipheroGraphql<ShipheroOrdersData>(ORDER_STATUS_QUERY, { orderNumber: reference })
  if (result.error) throw new Error(result.error)

  const nodes = extractShipheroConnectionNodes((result.data?.orders as { data?: unknown })?.data ?? result.data?.orders)
  const picked = pickShipheroOrderNode(nodes, reference)
  if (!picked) return null

  const settings = await getShipheroSettings()
  return mapShipheroOrderStatus(picked, settings.shiphero_admin_order_url_template, reference)
}
