/**
 * IMS → WooCommerce partial-shipment writeback (G1 / onetwo3d-ims-vn92.1).
 *
 * WMS-neutral: any WMS connector that detects a split fulfilment despatching one
 * part at a time calls this — via the shopping facade (lib/shopping.ts) so a
 * different storefront can implement its own representation. It posts the
 * despatched part to the onetwoInventory Helper
 * plugin's signed `oti/v1/order/{id}/partial-shipment` route, which mirrors it
 * into the storefront's partial-shipment UI + customer emails.
 *
 * Signed exactly like the FX push: HMAC-SHA256 of the raw body with the shared
 * `wc_webhook_secret`, sent as `X-OTI-Signature`.
 */

import { createHmac } from 'node:crypto'

import { db } from '@/lib/db'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from '../url-safety'

const PUSH_TIMEOUT_MS = 15_000

export type WcPartialShipmentLine = { sku: string; qty: number }

export type WcPartialShipmentPush = {
  /** 1-based part number of this despatch. */
  part: number
  /** Total parts the order was split into. */
  totalParts: number
  trackingNumber?: string | null
  /** WMS shipment/despatch reference, if distinct from the tracking number. */
  shipmentNum?: string | null
  /** Lines despatched in this part (SKU + integer qty). */
  items: WcPartialShipmentLine[]
}

export type PartialShipmentPushResult = {
  supported: boolean
  ok: boolean
  allDone?: boolean
  duplicate?: boolean
  skipped?: boolean
  error?: string
}

/**
 * Pure builder for the plugin request body — kept separate so the SKU/qty
 * normalisation and the wire shape can be unit-tested without HTTP. The wire
 * field names are snake_case to match the PHP handler.
 */
export function buildPartialShipmentBody(input: WcPartialShipmentPush): string {
  return JSON.stringify({
    part: Math.trunc(input.part),
    total_parts: Math.trunc(input.totalParts),
    tracking_number: input.trackingNumber ?? '',
    shipment_num: input.shipmentNum ?? '',
    items: input.items
      .filter((line) => line.sku.trim() !== '' && line.qty > 0)
      .map((line) => ({ sku: line.sku.trim(), qty: Math.trunc(line.qty) })),
  })
}

/**
 * Post one despatched part of a WC order to the helper plugin. Resolves the WC
 * external order id from the order's shopping link, mirroring pushImsTrackingToWc.
 * Returns `supported: false` when WC isn't configured so the facade can fan out
 * without special-casing; never throws.
 */
export async function pushPartialShipmentToWc(
  orderId: string,
  input: WcPartialShipmentPush,
): Promise<PartialShipmentPushResult> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { order: { id: orderId }, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link?.externalOrderId) return { supported: true, ok: true, skipped: true }

  const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
  const url = config.get('wc_url') ?? ''
  const secret = config.get('wc_webhook_secret') ?? ''
  if (!url || !secret) {
    return { supported: false, ok: false, error: 'WooCommerce URL or webhook secret not configured' }
  }
  const validatedUrl = validateWooCommerceBaseUrl(url)
  if (!validatedUrl.ok) return { supported: true, ok: false, error: validatedUrl.error }

  const body = buildPartialShipmentBody(input)
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const endpoint = `${validatedUrl.normalizedUrl}/wp-json/oti/v1/order/${encodeURIComponent(link.externalOrderId)}/partial-shipment`

  try {
    const res = await connectorFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OTI-Signature': signature },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    }, { connectorName: 'WooCommerce' })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { supported: true, ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}` }
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; all_done?: boolean; duplicate?: boolean }
    return { supported: true, ok: json.ok !== false, allDone: json.all_done, duplicate: json.duplicate }
  } catch (e) {
    return { supported: true, ok: false, error: String(e) }
  }
}
