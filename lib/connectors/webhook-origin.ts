/**
 * WHICH STORE DID THIS DELIVERY COME FROM? (o3d-wgl6)
 *
 * A webhook payload is frozen at receipt. If the operator rebinds the connector to a
 * different store before the inbox drains, a retry holds store-A data while every setting
 * the importer can read says a perfectly consistent store-B — so the o3d-mlc7 rebind fence,
 * which compares settings versions, has nothing to object to and the import writes store-A
 * ids under store-B credentials.
 *
 * The first attempt at this stamped each delivery with the settings VERSION current when we
 * accepted it. That does not work, and the reason is the same one that sank the receipt
 * timestamp in o3d-cvj9: a value we compute on OUR side records when we saw something, not
 * what the other side said. A delivery already in flight when the rebind commits is accepted
 * AFTER it, is stamped with the NEW version, and passes the fence carrying the OLD store's
 * body. Worse, `wc_settings_version` moves for things that are not a store change at all — a
 * same-store key rotation, an operator pressing "reset cached product IDs" — so the stamp
 * refused deliveries that were perfectly valid.
 *
 * The evidence that actually answers the question travels WITH the delivery: the store's own
 * statement of its identity. WooCommerce puts `home_url('/')` in `X-WC-Webhook-Source` on
 * every delivery, and a product body repeats it in `permalink`. Recorded at receipt, that
 * string still says "store A" no matter how long the row sits in the inbox, how many times it
 * is retried, or what the settings say by the time it is processed.
 *
 * This module owns the ENCODING and the COMPARISON. Deriving the value from a particular
 * connector's delivery is the connector's job (WooCommerce: `readWcDeliveryOrigin`).
 *
 * NOT AN AUTHENTICATION CONTROL. The header is outside the HMAC, so a caller who already
 * holds the webhook secret can put anything in it — but such a caller can equally post any
 * body it likes, so this adds no attack surface. Authenticity is the signature's job
 * (`verifyWcWebhook`); this is an integrity control against the operator's own rebind.
 */

/** Prefix for a PROVEN origin: `store:<host>`. */
const STORE_PREFIX = 'store:'

/**
 * The three ways a row can positively record that it has no proven origin.
 *
 * They are distinct values on purpose, and that is the whole of finding 2. A single NULL
 * meaning both "written before this column existed" and "written by current code, which found
 * nothing to record" is the o3d-t74p leniency: it reads as "fine" for rows that were never
 * examined at all. Every row now states which era wrote it and what that era found, so a
 * reader never has to guess — and the operator-facing log can say which of the three it was.
 */
export const WEBHOOK_ORIGIN_PRE_ATTESTATION = 'unproven:pre-attestation'
/** Current code, and the delivery made no statement about which store sent it. */
export const WEBHOOK_ORIGIN_NOT_STATED = 'unproven:not-stated'
/** Current code, and this connector's deliveries carry no store identity to record. */
export const WEBHOOK_ORIGIN_NOT_APPLICABLE = 'unproven:not-applicable'

/**
 * The comparable identity of a store URL: its hostname, lowercased, with a trailing root dot
 * and a leading `www.` removed. `null` for anything that is not an absolute http(s) URL.
 *
 * HOSTNAME, not the full URL. The two sides being compared are not written by the same hand:
 * the delivery states WordPress's `home_url()`, while the bound value is whatever the operator
 * typed into Settings. Scheme, port, trailing slash and subdirectory differ between those
 * routinely on installs that work perfectly, and every one of those differences would be a
 * false "foreign store" — which refuses real deliveries. The hostname is the part that cannot
 * differ while still being the same store.
 *
 * `www.` is stripped for the same reason: an operator who typed `https://www.example.com`
 * against a store whose `home_url()` is `https://example.com` has one store, not two, and
 * WordPress's canonical redirect means the REST calls work. Two DIFFERENT WooCommerce stores
 * distinguished only by a `www.` prefix is not a thing that exists.
 *
 * The port is deliberately dropped with the rest: a store reachable on two ports is one store,
 * and a bound URL that omits an explicit `:443` must not read as foreign.
 */
export function normaliseOriginHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * Encode what a delivery said about itself, ready to store.
 *
 * Returns `WEBHOOK_ORIGIN_NOT_STATED` — never a silent empty string — when the delivery said
 * nothing usable, so the stored value is always a positive statement.
 */
export function attestWebhookOrigin(rawUrl: string | null | undefined): string {
  const host = normaliseOriginHost(rawUrl)
  return host ? `${STORE_PREFIX}${host}` : WEBHOOK_ORIGIN_NOT_STATED
}

/** The host inside a `store:<host>` attestation, or `null` for any `unproven:*` marker. */
export function attestedOriginHost(attestation: string): string | null {
  return attestation.startsWith(STORE_PREFIX)
    ? attestation.slice(STORE_PREFIX.length) || null
    : null
}

export type WebhookOriginVerdict =
  /** The delivery names the store this installation is bound to right now. */
  | 'same-store'
  /** The delivery names a DIFFERENT store — it describes a binding we have left. */
  | 'foreign-store'
  /** The delivery named no store, so nothing about it can ever be proven. */
  | 'unproven'
  /** The delivery named a store but OUR OWN binding is unreadable, so there is nothing to compare against. */
  | 'binding-unreadable'

export type WebhookOriginJudgement = {
  verdict: WebhookOriginVerdict
  attestation: string
  deliveryHost: string | null
  boundHost: string | null
}

/**
 * Compare a stored attestation against the store this installation is bound to NOW.
 *
 * `binding-unreadable` is kept apart from `unproven` because the two have opposite remedies
 * and opposite fail-safe directions. `unproven` is a fact about the DELIVERY that no amount
 * of waiting will improve, so a caller can refuse it for good. `binding-unreadable` is a fact
 * about US — the connector is unconfigured or the stored URL is malformed — which an operator
 * fixes in minutes, and during which a caller must NOT quietly discard deliveries that would
 * be perfectly valid once the setting is repaired.
 */
export function judgeWebhookOrigin(
  attestation: string,
  boundStoreUrl: string | null | undefined,
): WebhookOriginJudgement {
  const deliveryHost = attestedOriginHost(attestation)
  const boundHost = normaliseOriginHost(boundStoreUrl)
  if (!deliveryHost) return { verdict: 'unproven', attestation, deliveryHost: null, boundHost }
  if (!boundHost) return { verdict: 'binding-unreadable', attestation, deliveryHost, boundHost: null }
  return {
    verdict: deliveryHost === boundHost ? 'same-store' : 'foreign-store',
    attestation,
    deliveryHost,
    boundHost,
  }
}
