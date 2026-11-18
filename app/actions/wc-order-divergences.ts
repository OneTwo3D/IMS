'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { describeDivergence, type DivergenceDifference } from '@/lib/connectors/woocommerce/sync/order-divergence'

/**
 * SYNC > EXCEPTIONS: WOOCOMMERCE ORDERS THAT NO LONGER MATCH THE IMS ORDER.
 *
 * Read-only. Each row is one order whose lines, prices, shipping, discount, tax or total in WooCommerce differ from what IMS holds (refunds are not
 * counted as a difference). IMS has changed nothing. The row closes itself when a later WooCommerce update matches the IMS order again.
 */

const PAGE_SIZE = 100

export type WcOrderDivergenceRow = {
  id: string
  orderId: string
  orderNumber: string
  currency: string
  /** One readable line per difference, naming the field. */
  differences: string[]
  seenCount: number
  firstSeenAt: string
  lastSeenAt: string
}
export type WcOrderDivergencePage = { rows: WcOrderDivergenceRow[]; total: number; shown: number }

function differencesOf(value: unknown): DivergenceDifference[] {
  return Array.isArray(value) ? value.filter((d): d is DivergenceDifference => !!d && typeof d === 'object' && typeof (d as DivergenceDifference).label === 'string') : []
}

/** Open divergences, oldest first. */
export async function listWcOrderDivergences(): Promise<WcOrderDivergencePage> {
  await requirePermission('sync')
  const where = { resolvedAt: null }
  const [total, found] = await Promise.all([
    db.wcOrderDivergence.count({ where }),
    db.wcOrderDivergence.findMany({ where, orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }], take: PAGE_SIZE }),
  ])
  const orders = await db.salesOrder.findMany({ where: { id: { in: found.map((r) => r.orderId) } }, select: { id: true, orderNumber: true, currency: true } })
  const byId = new Map(orders.map((o) => [o.id, o]))
  const rows = found.map((row): WcOrderDivergenceRow => {
    const order = byId.get(row.orderId)
    const currency = order?.currency ?? ''
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: order?.orderNumber ?? row.externalOrderNumber ?? row.externalOrderId,
      currency,
      differences: differencesOf(row.differences).map((d) => describeDivergence([d], currency)),
      seenCount: row.seenCount,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }
  })
  return { rows, total, shown: rows.length }
}
