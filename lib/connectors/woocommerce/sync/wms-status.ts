/**
 * IMS → WooCommerce WMS-status writeback (G4 / vn92.3).
 *
 * Pushes the live WMS order status (whichever WMS connector is active) onto the linked WC
 * order as WMS-neutral `_oti_wms_*` meta so storefront admins can see it on the orders +
 * order screen — rendered by the onetwoInventory Helper plugin. Standard WC REST meta
 * write (like the tracking push); the companion plugin only reads the meta.
 */

import { db } from '@/lib/db'
import { wcFetch, wcPut } from '../api'
import type { WcFullOrder } from './types'

export type WmsOrderStatusMeta = {
  /** Raw WMS status, e.g. "DESPATCHED". */
  status: string
  /** Human-readable status label. */
  statusLabel: string
  /** WMS connector display label (e.g. the warehouse provider name). */
  connectorLabel: string
  /** Deep link to the order in the WMS admin, if available. */
  deepLinkUrl: string | null
}

const META_KEYS = {
  status: '_oti_wms_status',
  statusLabel: '_oti_wms_status_label',
  connector: '_oti_wms_connector',
  deeplink: '_oti_wms_deeplink',
} as const

/** Pure: the `_oti_wms_*` key/value entries the companion plugin renders. */
export function buildWmsStatusMetaValues(input: WmsOrderStatusMeta): Array<{ key: string; value: string }> {
  return [
    { key: META_KEYS.status, value: input.status },
    { key: META_KEYS.statusLabel, value: input.statusLabel },
    { key: META_KEYS.connector, value: input.connectorLabel },
    { key: META_KEYS.deeplink, value: input.deepLinkUrl ?? '' },
  ]
}

/**
 * Resolve to existing meta ids (so a re-push updates rather than appends duplicate meta
 * rows). Pure so it can be unit-tested against a WC order's meta_data.
 */
export function buildWmsStatusMetaPatch(
  input: WmsOrderStatusMeta,
  existingMeta: WcFullOrder['meta_data'] | undefined,
): Array<{ id?: number; key: string; value: string }> {
  const byKey = new Map((existingMeta ?? []).map((meta) => [meta.key, meta.id]))
  return buildWmsStatusMetaValues(input).map((entry) => {
    const id = byKey.get(entry.key)
    return id != null ? { id, key: entry.key, value: entry.value } : { key: entry.key, value: entry.value }
  })
}

export async function pushWmsOrderStatusToWc(
  orderId: string,
  input: WmsOrderStatusMeta,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { order: { id: orderId }, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link?.externalOrderId) return { success: true, skipped: true }

  const current = await wcFetch(`/orders/${link.externalOrderId}`)
  if (current.error) return { success: false, error: current.error }

  const wcOrder = current.data as WcFullOrder
  const update = await wcPut(`/orders/${link.externalOrderId}`, {
    meta_data: buildWmsStatusMetaPatch(input, wcOrder.meta_data),
  })
  if (update.error) return { success: false, error: update.error }
  return { success: true }
}
