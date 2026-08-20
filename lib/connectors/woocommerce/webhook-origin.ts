import { attestWebhookOrigin } from '@/lib/connectors/webhook-origin'

/**
 * What a WooCommerce delivery says about the store that sent it (o3d-wgl6).
 *
 * Two independent statements are available, and they are read in this order:
 *
 *   1. `X-WC-Webhook-Source`. WooCommerce core has put `home_url('/')` in this header on every
 *      delivery since WC 2.2, alongside the signature and topic headers this route already
 *      requires — so a request that got as far as being persisted came from something emitting
 *      the full WC header set, and the absence of this one is an anomaly rather than a version
 *      difference. It is also the only statement present for EVERY resource, which matters
 *      because the value is stored in a column shared by every connector and has to mean the
 *      same thing in every row.
 *
 *   2. The payload's own self-referencing URL — `permalink` on a product, `_links.self[0].href`
 *      on anything the REST API serialised. These sit INSIDE the signed body, so they are the
 *      stronger evidence of the two; they are the fallback rather than the primary only because
 *      they are not present on every resource. Together the two mean a delivery with no usable
 *      origin at all is close to unreachable in practice.
 *
 * Read at RECEIPT, from the request in hand. Nothing here touches the database: the answer is
 * entirely contained in what the store sent, which is the property that makes it survive a
 * rebind that happens later.
 */
export function readWcDeliveryOrigin(request: Request, payload: unknown): string {
  const header = request.headers.get('x-wc-webhook-source')
  const fromHeader = attestWebhookOrigin(header)
  if (!fromHeader.startsWith('unproven:')) return fromHeader
  return attestWebhookOrigin(readPayloadSelfUrl(payload))
}

function readPayloadSelfUrl(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>

  const permalink = record.permalink
  if (typeof permalink === 'string' && permalink.trim() !== '') return permalink

  const links = record._links
  if (typeof links !== 'object' || links === null) return null
  const self = (links as Record<string, unknown>).self
  if (!Array.isArray(self)) return null
  for (const entry of self) {
    if (typeof entry !== 'object' || entry === null) continue
    const href = (entry as Record<string, unknown>).href
    if (typeof href === 'string' && href.trim() !== '') return href
  }
  return null
}
