import { attestWebhookOrigin, attestWebhookOriginUnder } from '@/lib/connectors/webhook-origin'

/** WooCommerce builds every REST link as `<site root>/wp-json/<namespace>/...`. */
const REST_ROOT_MARKER = '/wp-json/'

/**
 * What a WooCommerce delivery says about the store that sent it (o3d-wgl6).
 *
 * Three independent statements are available, and they are read in this order:
 *
 *   1. `_links.self[0].href` — the REST link WordPress serialised into the body. Truncated at
 *      its `/wp-json/` boundary it is the site root exactly, which is the strongest form of
 *      statement (`exact`), and it is INSIDE the signed body.
 *
 *   2. The payload's `permalink`. Also inside the signed body, but a resource URL: it is known
 *      to sit at or under the site root and cannot be reduced to the root itself, so it is
 *      recorded as an `under` statement and compared by containment.
 *
 *   3. `X-WC-Webhook-Source`. WooCommerce core has put `home_url('/')` in this header on every
 *      delivery since WC 2.2, so it is present on every resource, including ones that serialise
 *      no links at all — which matters because the column is shared by every connector and has
 *      to mean the same thing in every row.
 *
 * WHY THE HEADER IS LAST, and this is finding 3. The header sits OUTSIDE the HMAC; the body's
 * self-link and permalink sit INSIDE it. Round 2 read the header first, so when the two
 * disagreed the unsigned statement overrode the signed one — a header rewritten in transit (a
 * reverse proxy normalising `Host`, a relay replaying store A's body with store B's header)
 * silently redirected the whole attestation. Consulting the header only when the signed body
 * has said nothing means signed evidence always wins a disagreement, because an unsigned
 * statement is never read while a signed one exists.
 *
 * Read at RECEIPT, from the request in hand. Nothing here touches the database: the answer is
 * entirely contained in what the store sent, which is the property that makes it survive a
 * rebind that happens later.
 */
export function readWcDeliveryOrigin(request: Request, payload: unknown): string {
  const restRoot = readPayloadRestRoot(payload)
  if (restRoot) {
    const fromRestRoot = attestWebhookOrigin(restRoot)
    if (!fromRestRoot.startsWith('unproven:')) return fromRestRoot
  }

  const permalink = readPayloadPermalink(payload)
  if (permalink) {
    const fromPermalink = attestWebhookOriginUnder(permalink)
    if (!fromPermalink.startsWith('unproven:')) return fromPermalink
  }

  return attestWebhookOrigin(request.headers.get('x-wc-webhook-source'))
}

/**
 * The site root a REST self-link implies.
 *
 * With pretty permalinks the link is `<root>/wp-json/wc/v3/...`, so everything before the
 * marker is the root exactly. Without them WordPress emits `<root>/?rest_route=/wc/v3/...`,
 * which has no marker to cut at — that form is left to the permalink/containment path rather
 * than guessed at, since a link whose shape is unrecognised proves nothing exactly.
 */
function readPayloadRestRoot(payload: unknown): string | null {
  const href = readPayloadSelfHref(payload)
  if (!href) return null
  const markerAt = href.indexOf(REST_ROOT_MARKER)
  if (markerAt <= 0) return null
  return href.slice(0, markerAt)
}

function readPayloadSelfHref(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const links = (payload as Record<string, unknown>)._links
  if (typeof links !== 'object' || links === null) return null
  const self = (links as Record<string, unknown>).self
  if (!Array.isArray(self)) return null
  for (const entry of self) {
    if (typeof entry !== 'object' || entry === null) continue
    const href = (entry as Record<string, unknown>).href
    if (typeof href === 'string' && href.trim() !== '') return href.trim()
  }
  return null
}

function readPayloadPermalink(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const permalink = (payload as Record<string, unknown>).permalink
  if (typeof permalink === 'string' && permalink.trim() !== '') return permalink.trim()
  const href = readPayloadSelfHref(payload)
  // A self-link whose shape has no `/wp-json/` boundary still proves containment.
  return href
}
